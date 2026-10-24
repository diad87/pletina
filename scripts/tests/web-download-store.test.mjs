import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { IDBFactory } from 'fake-indexeddb'
import { createWebStorage } from '../../web-port/storage.ts'
import { configureDownloadMetadata, createDownloadStore, DOWNLOAD_CACHE } from '../../web-port/download-store.ts'

const YOUTUBE = 250_000_000_000_000
const EPISODE = 750_000_000_000_000
const scope = 'https://app.example/pletina/'
const input = { videoId: 'abcdefghijk', title: 'Título original', artist: 'Autor original', duration: 90 }
const fixture = Buffer.from('Known local cache bytes; metadata reads must preserve this response.')
const ordinary = id => ({ id, title: 'Catálogo original', duration: 120, explicit: false,
  artistId: 7, artistName: 'Artista', albumId: 8, albumTitle: 'Álbum', albumArtistId: 7, cover: null })

function setup(t) {
  const factory = new IDBFactory(), rows = new Map(), cacheWrites = [], requests = []
  const caches = { async open(name) {
    assert.equal(name, DOWNLOAD_CACHE)
    return {
      async match(key) { return rows.get(String(key))?.clone() },
      async put(key, response) { cacheWrites.push(['put', String(key)]); rows.set(String(key), response.clone()) },
      async delete(key) { cacheWrites.push(['delete', String(key)]); return rows.delete(String(key)) },
    }
  } }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (...args) => { requests.push(args); assert.fail('A local metadata lookup must never contact a provider') }
  t.after(() => { globalThis.fetch = originalFetch })
  let library = createWebStorage({ indexedDB: factory, name: 'canonical-library' })
  const stores = []
  const download = (readTrack = id => library.readStoredTrack(id)) => {
    const store = createDownloadStore({ indexedDB: factory, name: 'local-downloads', scope, caches, readTrack })
    stores.push(store)
    return store
  }
  const cacheSnapshot = async () => Promise.all([...rows].map(async ([key, response]) => ({ key,
    bytes: (await response.clone().arrayBuffer()).byteLength,
    sha256: createHash('sha256').update(Buffer.from(await response.clone().arrayBuffer())).digest('hex') })))
  t.after(async () => { await library.close(); for (const store of stores) await store.close() })
  return { factory, rows, caches, cacheWrites, requests, download, cacheSnapshot,
    get library() { return library },
    async reopenLibrary() { await library.close(); library = createWebStorage({ indexedDB: factory, name: 'canonical-library' }) },
    async seed(store, track) {
      const cacheKey = scope + '__audio__/' + track.id + '?stage=1700000000000-00000000-0000-4000-8000-000000000000'
      rows.set(cacheKey, new Response(fixture, { headers: { 'content-type': 'audio/wav' } }))
      const record = { id: track.id, track, size: fixture.length, at: 1700000000, cacheKey }
      await store.put(record)
      return record
    } }
}

test('una ficha YouTube editada actualiza lista y resolución local tras reabrir sin alterar bytes ni staging', async t => {
  const h = setup(t), store = h.download()
  const old = await h.library.storageInvoke('save_youtube_track', input)
  const record = await h.seed(store, old), beforeCache = await h.cacheSnapshot()
  const edited = await h.library.storageInvoke('save_youtube_track', { ...input, title: 'Título corregido', artist: 'Autor corregido', duration: 321 })
  assert.deepEqual(await store.listDownloads(), [{ track: edited, path: scope + '__audio__/' + old.id, size: record.size, at: record.at }])
  assert.deepEqual(await store.readDownloadedPlayable(old.id), { videoId: '', url: scope + '__audio__/' + old.id,
    title: edited.title, channel: edited.artistName, local: true })
  assert.deepEqual(await store.get(old.id), record, 'The download record remains a byte/cache pointer snapshot')
  await h.library.storageInvoke('remove_youtube_track', { id: old.id })
  assert.deepEqual(await h.library.storageInvoke('youtube_tracks'), [])
  assert.deepEqual((await store.listDownloads())[0].track, edited, 'Hidden YouTube metadata remains authoritative')
  assert.equal(await h.library.readYouTubeVideo(old.id), input.videoId)
  await store.close(); await h.reopenLibrary()
  const reopened = h.download()
  assert.deepEqual((await reopened.listDownloads())[0].track, edited)
  assert.equal((await reopened.readDownloadedPlayable(old.id)).channel, edited.artistName)
  assert.deepEqual(await reopened.get(old.id), record)
  assert.deepEqual(await h.cacheSnapshot(), beforeCache)
  assert.deepEqual(h.cacheWrites, [])
  assert.deepEqual(h.requests, [])
})

test('una biblioteca sin ficha YouTube mantiene la copia descargada y su resolución sin red', async t => {
  const h = setup(t), store = h.download(), track = ordinary(YOUTUBE + 40)
  const record = await h.seed(store, track), bytes = await h.cacheSnapshot()
  assert.equal(await h.library.readStoredTrack(track.id), null)
  assert.deepEqual((await store.listDownloads())[0].track, track)
  assert.equal((await store.readDownloadedPlayable(track.id)).title, track.title)
  assert.deepEqual(await store.get(track.id), record)
  assert.deepEqual(await h.cacheSnapshot(), bytes)
  assert.deepEqual(h.cacheWrites, [])
  assert.deepEqual(h.requests, [])
})

test('un fallo al leer la biblioteca canónica conserva la descarga utilizable sin escrituras cruzadas', async t => {
  const h = setup(t)
  const unavailable = createWebStorage({ indexedDB: { open() { throw new DOMException('IndexedDB denied', 'SecurityError') } } })
  t.after(() => unavailable.close())
  const store = h.download(id => unavailable.readStoredTrack(id)), track = ordinary(YOUTUBE + 50)
  const record = await h.seed(store, track), bytes = await h.cacheSnapshot()
  assert.deepEqual((await store.listDownloads())[0].track, track)
  assert.deepEqual(await store.readDownloadedPlayable(track.id), { videoId: '', url: scope + '__audio__/' + track.id,
    title: track.title, channel: track.artistName, local: true })
  assert.deepEqual(await store.get(track.id), record)
  assert.deepEqual(await h.cacheSnapshot(), bytes)
  assert.deepEqual(h.cacheWrites, [])
  assert.deepEqual(h.requests, [])
})

test('catálogo y episodios conservan su snapshot sin consultar el lector canónico de YouTube', async t => {
  const h = setup(t), store = h.download(async () => assert.fail('Only YouTube track IDs need canonical metadata'))
  const records = []
  for (const id of [1, EPISODE + 1]) records.push(await h.seed(store, ordinary(id)))
  const bytes = await h.cacheSnapshot()
  const listed = await store.listDownloads()
  assert.deepEqual(listed.map(entry => entry.track.id).sort((a, b) => a - b), [1, EPISODE + 1])
  for (const record of records) {
    assert.equal(await h.library.readStoredTrack(record.id), null)
    assert.equal((await store.readDownloadedPlayable(record.id)).title, record.track.title)
    assert.deepEqual(await store.get(record.id), record)
  }
  assert.deepEqual(await h.cacheSnapshot(), bytes)
  assert.deepEqual(h.cacheWrites, [])
  assert.deepEqual(h.requests, [])
  assert.ok(!(await h.factory.databases()).some(database => database.name === 'canonical-library'))
})

test('descargas conservan ISRC y versión tras reabrir con sólo bytes locales y metadatos permitidos', async t => {
  const h = setup(t), store = h.download(), track = { ...ordinary(1), isrc: 'QM6N21424821', titleVersion: 'Original' }
  const record = await h.seed(store, { ...track, source: { provider: 'audius', id: 'DO_NOT_PERSIST' },
    url: 'https://audio.example/?signature=DO_NOT_PERSIST' })
  const before = await h.cacheSnapshot()
  await store.close()
  const reopened = h.download()
  const saved = await reopened.get(track.id)
  assert.deepEqual(saved.track, track)
  assert.doesNotMatch(JSON.stringify(saved), /DO_NOT_PERSIST|signature/)
  assert.deepEqual((await reopened.listDownloads())[0].track, track)
  assert.equal((await reopened.readDownloadedPlayable(track.id)).local, true)
  assert.deepEqual(await h.cacheSnapshot(), before)
  assert.deepEqual(h.requests, [])
  assert.equal(saved.size, record.size)
})

test('el lector registrado por el adaptador se aplica también a una descarga creada antes del wiring', async t => {
  const h = setup(t)
  const store = createDownloadStore({ indexedDB: h.factory, name: 'adapter-downloads', scope, caches: h.caches })
  t.after(async () => { configureDownloadMetadata(undefined); await store.close() })
  const old = await h.library.storageInvoke('save_youtube_track', input)
  const record = await h.seed(store, old), bytes = await h.cacheSnapshot()
  const edited = await h.library.storageInvoke('save_youtube_track', { ...input, title: 'Edición del adaptador', artist: 'Autor actual', duration: 222 })
  configureDownloadMetadata(id => h.library.readStoredTrack(id))
  assert.deepEqual((await store.listDownloads())[0].track, edited)
  assert.equal((await store.readDownloadedPlayable(old.id)).title, edited.title)
  assert.deepEqual(await store.get(old.id), record)
  assert.deepEqual(await h.cacheSnapshot(), bytes)
  assert.deepEqual(h.cacheWrites, [])
  assert.deepEqual(h.requests, [])
})

test('la lista visible de descargas agrupa artista y disco como la APK, con fecha ascendente y sin alterar el listado interno', async t => {
  const h = setup(t), store = h.download(), records = []
  for (const [id, artistName, albumTitle, at] of [
    [101, 'Zulu', 'A', 200], [102, 'alpha', 'Zulu', 100], [103, 'Alpha', 'beta', 300],
    [104, 'ALPHA', 'BETA', 100], [105, 'alpha', 'beta', 200],
  ]) {
    const record = { ...await h.seed(store, { ...ordinary(id), artistName, albumTitle }), at }
    await store.put(record); records.push(record)
  }
  const bytes = await h.cacheSnapshot()
  const rawOrder = (await store.list()).map(record => record.id)
  assert.deepEqual(rawOrder, [103, 105, 101, 104, 102], 'Internal newest-first ordering remains available to existing callers')
  const visible = await store.listDownloads()
  assert.deepEqual(visible.map(entry => entry.track.id), [104, 105, 103, 102, 101])
  assert.deepEqual((await store.list()).map(record => record.id), rawOrder)
  for (const record of records) assert.deepEqual(await store.get(record.id), record)
  assert.deepEqual(await h.cacheSnapshot(), bytes)
  assert.deepEqual(h.cacheWrites, []); assert.deepEqual(h.requests, [])
})

test('el orden de descargas usa NOCASE ASCII y bytes UTF-8, sin idioma, plegado de acentos ni orden UTF-16', async t => {
  const h = setup(t), store = h.download()
  const names = ['a', 'B', 'z', 'Á', 'á', '😀', '\uffff', 'A']
  for (const [index, name] of names.entries()) {
    await h.seed(store, { ...ordinary(index + 1), artistName: name, albumTitle: 'Igual' })
    await h.seed(store, { ...ordinary(index + 101), artistName: 'Grupo', albumTitle: name })
  }
  const values = await store.listDownloads()
  assert.deepEqual(values.filter(entry => entry.track.id < 100).map(entry => entry.track.id), [1, 8, 2, 3, 4, 5, 7, 6])
  assert.deepEqual(values.filter(entry => entry.track.id > 100).map(entry => entry.track.id), [101, 108, 102, 103, 104, 105, 107, 106])
  assert.deepEqual(h.cacheWrites, []); assert.deepEqual(h.requests, [])
})

test('el desempate visible por ID es ascendente y estable tras reabrir, aunque las inserciones se hagan al revés', async t => {
  const h = setup(t), store = h.download()
  for (const id of [30, 10, 20]) await h.seed(store, { ...ordinary(id), artistName: id === 20 ? 'ARTISTA' : 'Artista', albumTitle: id === 10 ? 'DISCO' : 'Disco' })
  assert.deepEqual((await store.listDownloads()).map(entry => entry.track.id), [10, 20, 30])
  assert.deepEqual((await store.list()).map(record => record.id), [30, 20, 10])
  await store.close()
  const reopened = h.download()
  assert.deepEqual((await reopened.listDownloads()).map(entry => entry.track.id), [10, 20, 30])
  assert.deepEqual(h.cacheWrites, []); assert.deepEqual(h.requests, [])
})

test('el orden visible se calcula con los metadatos canónicos actuales de YouTube, conservando los archivos originales', async t => {
  const h = setup(t), store = h.download()
  const first = await h.library.storageInvoke('save_youtube_track', { ...input, artist: 'Zulu' })
  const secondInput = { ...input, videoId: 'lmnopqrstuv', title: 'Otra canción', artist: 'Alpha' }
  const second = await h.library.storageInvoke('save_youtube_track', secondInput)
  const firstRecord = await h.seed(store, first), secondRecord = await h.seed(store, second)
  await h.seed(store, { ...ordinary(90), artistName: 'Middle' })
  const bytes = await h.cacheSnapshot()
  await h.library.storageInvoke('save_youtube_track', { ...input, artist: 'Beta' })
  await h.library.storageInvoke('save_youtube_track', { ...secondInput, artist: 'Zulu' })
  await h.reopenLibrary()
  const values = await store.listDownloads()
  assert.deepEqual(values.map(entry => entry.track.id), [first.id, 90, second.id])
  assert.deepEqual(values.map(entry => entry.track.artistName), ['Beta', 'Middle', 'Zulu'])
  assert.deepEqual(await store.get(first.id), firstRecord); assert.deepEqual(await store.get(second.id), secondRecord)
  assert.deepEqual(await h.cacheSnapshot(), bytes)
  assert.deepEqual(h.cacheWrites, []); assert.deepEqual(h.requests, [])
})

for (const method of ['listDownloads', 'readDownloadedPlayable']) {
  test(`${method}: retira una referencia cuya copia sigue ausente sin borrar otros archivos`, async t => {
    const h = setup(t), store = h.download()
    const missing = await h.seed(store, ordinary(1)), kept = await h.seed(store, ordinary(2))
    h.rows.delete(missing.cacheKey)
    const bytes = await h.cacheSnapshot()
    const value = await store[method](1)
    if (method === 'listDownloads') assert.deepEqual(value.map(entry => entry.track.id), [2])
    else assert.equal(value, null)
    assert.equal(await store.get(1), null); assert.deepEqual(await store.get(2), kept)
    assert.deepEqual(await h.cacheSnapshot(), bytes)
    assert.deepEqual(h.cacheWrites, []); assert.deepEqual(h.requests, [])
  })

  test(`${method}: una copia nueva confirmada mientras se comprueba la antigua conserva su referencia y se devuelve`, async t => {
    const h = setup(t), store = h.download(), old = await h.seed(store, ordinary(1))
    const replacement = { ...old, at: old.at + 1, track: { ...old.track, title: 'Copia nueva' },
      cacheKey: old.cacheKey.replace(/0$/, '1') }
    const open = h.caches.open, probes = []
    h.caches.open = async name => {
      const cache = await open(name)
      return { ...cache, async match(key) {
        probes.push(String(key))
        if (String(key) === old.cacheKey) {
          h.rows.delete(old.cacheKey)
          h.rows.set(replacement.cacheKey, new Response(fixture, { headers: { 'content-type': 'audio/wav' } }))
          await store.put(replacement)
          return undefined
        }
        return cache.match(key)
      } }
    }
    const value = await store[method](1)
    if (method === 'listDownloads') assert.deepEqual(value.map(entry => entry.track.title), ['Copia nueva'])
    else assert.equal(value?.title, 'Copia nueva')
    assert.deepEqual(probes, [old.cacheKey, replacement.cacheKey], 'Only one replacement stage needs a bounded cache probe')
    assert.deepEqual(await store.get(1), replacement)
    assert.equal(h.rows.size, 1); assert.ok(h.rows.has(replacement.cacheKey))
    assert.deepEqual(h.cacheWrites, []); assert.deepEqual(h.requests, [])
  })

  test(`${method}: la referencia nueva también se retira si su propia copia falta, con una sola comprobación adicional`, async t => {
    const h = setup(t), store = h.download(), old = await h.seed(store, ordinary(1))
    const replacement = { ...old, at: old.at + 1, cacheKey: old.cacheKey.replace(/0$/, '2') }
    const open = h.caches.open, probes = []
    h.caches.open = async name => {
      const cache = await open(name)
      return { ...cache, async match(key) {
        probes.push(String(key))
        if (String(key) === old.cacheKey) { h.rows.delete(old.cacheKey); await store.put(replacement) }
        return undefined
      } }
    }
    const value = await store[method](1)
    if (method === 'listDownloads') assert.deepEqual(value, [])
    else assert.equal(value, null)
    assert.deepEqual(probes, [old.cacheKey, replacement.cacheKey])
    assert.equal(await store.get(1), null); assert.equal(h.rows.size, 0)
    assert.deepEqual(h.cacheWrites, []); assert.deepEqual(h.requests, [])
  })
}
