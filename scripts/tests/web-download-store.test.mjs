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
