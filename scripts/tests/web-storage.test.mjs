import assert from 'node:assert/strict'
import test from 'node:test'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { createWebStorage, handlesStorage } from '../../web-port/storage.ts'

const YOUTUBE = 250_000_000_000_000
const PODCAST = 500_000_000_000_000
const EPISODE = 750_000_000_000_000
const song = (id, extra = {}) => ({ id, title: `Canción ${id}`, duration: 120, explicit: false,
  artistId: 10, artistName: 'Artista', albumId: 20, albumTitle: 'Álbum', albumArtistId: 10,
  cover: `https://images.example/${id}.jpg`, ...extra })
const show = (id = PODCAST + 1, extra = {}) => ({ id, title: 'Programa', author: 'Autor',
  description: 'Descripción', image: 'https://images.example/podcast.jpg',
  feedUrl: 'https://podcasts.example/feed.xml', language: 'es', episodeCount: 20, ...extra })
const choice = (extra = {}) => ({ videoId: 'abcdefghijk', title: 'Vídeo', channel: 'Canal',
  duration: 123, score: 100, verified: true, ...extra })

function setup(t) {
  const factory = new IDBFactory()
  const name = 'pletina-storage-test'
  const store = createWebStorage({ indexedDB: factory, name })
  t.after(() => store.close())
  return { store, factory, name, invoke: store.storageInvoke }
}

const result = (operation) => new Promise((resolve, reject) => {
  operation.onsuccess = () => resolve(operation.result)
  operation.onerror = () => reject(operation.error)
})

async function rawGet(factory, name, store, key) {
  const db = await result(factory.open(name))
  try { return await result(db.transaction(store).objectStore(store).get(key)) }
  finally { db.close() }
}

async function dump(factory, name) {
  const db = await result(factory.open(name))
  try {
    const stores = [...db.objectStoreNames]
    const tx = db.transaction(stores)
    return Object.fromEntries(await Promise.all(stores.map(async (store) => [store, await result(tx.objectStore(store).getAll())])))
  } finally { db.close() }
}

test('favoritos, álbumes, artistas y programas se conservan al cerrar y reabrir la base', async (t) => {
  const { store, factory, name, invoke } = setup(t)
  await invoke('set_liked', { track: song(1), liked: true })
  await invoke('set_liked', { track: song(1, { title: 'Título actualizado' }), liked: true })
  const album = { id: 20, title: 'Álbum', artistId: 10, artistName: 'Artista', cover: null, releaseDate: '2026-01-01', recordType: 'album' }
  await invoke('set_album_saved', { album, saved: true })
  await invoke('set_artist_saved', { artist: { id: 10, name: 'Artista', picture: null }, saved: true })
  await store.rememberPodcasts([show()])
  await invoke('set_podcast_saved', { id: PODCAST + 1, saved: true })
  const before = await invoke('library')
  assert.deepEqual(before.likedIds, [1])
  assert.deepEqual(before.downloadedIds, [])
  assert.deepEqual(before.albums, [album])
  assert.deepEqual(before.artists, [{ id: 10, name: 'Artista', picture: null }])
  assert.deepEqual(before.podcasts, [show()])
  assert.equal((await invoke('liked_tracks')).length, 1)
  assert.equal((await invoke('liked_tracks'))[0].track.title, 'Título actualizado')
  await store.close()
  const reopened = createWebStorage({ indexedDB: factory, name })
  t.after(() => reopened.close())
  assert.deepEqual(await reopened.storageInvoke('library'), before)
  const returned = await reopened.storageInvoke('liked_tracks')
  returned[0].track.title = 'Mutación de la respuesta'
  assert.equal((await reopened.storageInvoke('liked_tracks'))[0].track.title, 'Título actualizado')
})

test('quitar favoritos conserva las canciones de playlists e historial y los metadatos del programa', async (t) => {
  const { store, invoke } = setup(t)
  const track = song(1)
  await invoke('set_liked', { track, liked: true })
  const playlist = await invoke('create_playlist', { name: 'Lista', tracks: [track] })
  await invoke('record_play', { track })
  await store.rememberPodcasts([show()])
  await invoke('set_podcast_saved', { id: PODCAST + 1, saved: true })
  await store.rememberPodcasts([show(PODCAST + 1, { title: 'Programa renovado' })])
  assert.equal((await invoke('library')).podcasts[0].title, 'Programa renovado')
  await invoke('set_podcast_saved', { id: PODCAST + 1, saved: false })
  await invoke('set_liked', { track: { id: 1 }, liked: false })
  assert.deepEqual((await invoke('library')).likedIds, [])
  assert.deepEqual((await invoke('library')).podcasts, [])
  assert.equal((await invoke('playlist', { id: playlist.id })).entries[0].track.id, 1)
  assert.equal((await invoke('history', { limit: 10 }))[0].track.id, 1)
  await invoke('set_podcast_saved', { id: PODCAST + 1, saved: true })
  assert.equal((await invoke('library')).podcasts[0].title, 'Programa renovado')
  await assert.rejects(invoke('set_podcast_saved', { id: PODCAST + 999, saved: true }), /metadatos/)
})

test('las playlists conservan apariciones duplicadas con entryId únicos y permiten mover y quitar una sola', async (t) => {
  const { invoke, factory, name } = setup(t)
  const created = await invoke('create_playlist', { name: '  Mi lista  ', tracks: [song(1), song(2, { duration: 180 }), song(1)] })
  assert.equal(created.name, 'Mi lista')
  assert.equal(created.count, 3)
  assert.equal(created.duration, 420)
  assert.deepEqual(created.covers, ['https://images.example/1.jpg', 'https://images.example/2.jpg'])
  const initial = await invoke('playlist', { id: created.id })
  assert.deepEqual(initial.entries.map((entry) => entry.track.id), [1, 2, 1])
  const [first, second, duplicate] = initial.entries.map((entry) => entry.entryId)
  assert.equal(new Set([first, second, duplicate]).size, 3)
  await invoke('move_in_playlist', { id: created.id, entryId: duplicate, to: 0 })
  assert.deepEqual((await invoke('playlist', { id: created.id })).entries.map((entry) => entry.entryId), [duplicate, first, second])
  await invoke('remove_from_playlist', { id: created.id, entryId: first })
  const after = await invoke('playlist', { id: created.id })
  assert.deepEqual(after.entries.map((entry) => entry.entryId), [duplicate, second])
  assert.deepEqual(after.entries.map((entry) => entry.track.id), [1, 2])
  await invoke('rename_playlist', { id: created.id, name: 'Nuevo nombre' })
  assert.equal((await invoke('library')).playlists[0].name, 'Nuevo nombre')
  const other = await invoke('create_playlist', { name: 'Otra', tracks: [song(3)] })
  await assert.rejects(invoke('remove_from_playlist', { id: other.id, entryId: duplicate }), /entrada/)
  await invoke('delete_playlist', { id: created.id })
  await assert.rejects(invoke('playlist', { id: created.id }), /ya no existe/)
  assert.equal((await invoke('playlist', { id: other.id })).count, 1)
  const database = await dump(factory, name)
  assert.ok(database.entries.every((entry) => entry.playlistId === other.id))
})

test('dos conexiones que añaden a la vez no pierden entradas ni repiten identificadores', async (t) => {
  const { store, factory, name, invoke } = setup(t)
  const other = createWebStorage({ indexedDB: factory, name })
  t.after(() => other.close())
  const playlist = await invoke('create_playlist', { name: 'Concurrente', tracks: [] })
  await Promise.all(Array.from({ length: 24 }, (_, index) => (index % 2 ? store : other).storageInvoke('add_to_playlist', { id: playlist.id, tracks: [song(1)] })))
  const detail = await invoke('playlist', { id: playlist.id })
  assert.equal(detail.count, 24)
  assert.equal(new Set(detail.entries.map((entry) => entry.entryId)).size, 24)
  await Promise.all(Array.from({ length: 16 }, (_, index) => (index % 2 ? store : other).storageInvoke('set_liked', { track: song(index + 10), liked: true })))
  assert.equal((await invoke('library')).likedIds.length, 16)
})

test('una cuota agotada después de escribir parte de una operación revierte canciones y entradas', async (t) => {
  const { invoke, factory, name } = setup(t)
  const playlist = await invoke('create_playlist', { name: 'Atómica', tracks: [song(1)] })
  const before = await invoke('playlist', { id: playlist.id })
  const original = IDBObjectStore.prototype.add
  let additions = 0
  IDBObjectStore.prototype.add = function (...args) {
    if (this.name === 'entries' && ++additions === 2) throw new DOMException('Cuota agotada durante la prueba', 'QuotaExceededError')
    return original.apply(this, args)
  }
  try {
    await assert.rejects(invoke('add_to_playlist', { id: playlist.id, tracks: [song(2), song(3)] }), { name: 'QuotaExceededError' })
  } finally { IDBObjectStore.prototype.add = original }
  assert.deepEqual(await invoke('playlist', { id: playlist.id }), before)
  assert.equal(await rawGet(factory, name, 'tracks', 2), undefined)
  assert.equal(await rawGet(factory, name, 'tracks', 3), undefined)
  await invoke('add_to_playlist', { id: playlist.id, tracks: [song(2)] })
  assert.equal((await invoke('playlist', { id: playlist.id })).count, 2)
})

test('validar un lote impide guardar parcialmente canciones inválidas o metadatos de otro formato', async (t) => {
  const { invoke, factory, name } = setup(t)
  const playlist = await invoke('create_playlist', { name: '', tracks: [song(1)] })
  assert.equal(playlist.name, 'Playlist sin nombre')
  await assert.rejects(invoke('add_to_playlist', { id: playlist.id, tracks: [song(2), song(3, { duration: NaN })] }), /duración/)
  assert.equal((await invoke('playlist', { id: playlist.id })).count, 1)
  assert.equal(await rawGet(factory, name, 'tracks', 2), undefined)
  await assert.rejects(invoke('set_liked', { track: song(Number.MAX_SAFE_INTEGER + 1), liked: true }), /identificador/)
  await assert.rejects(invoke('move_in_playlist', { id: playlist.id, entryId: 1, to: -1 }), /posición/)
  await assert.rejects(invoke('rename_playlist', { id: 999, name: 'Ausente' }), /ya no existe/)
  await assert.rejects(invoke('set_artist_saved', { artist: { id: 10, name: '', picture: null }, saved: true }), /nombre/)
})

test('el historial conserva escuchas repetidas en orden y al limpiarlo mantiene la biblioteca', async (t) => {
  const { invoke } = setup(t)
  await invoke('set_liked', { track: song(1), liked: true })
  await invoke('record_play', { track: song(1) })
  await invoke('record_play', { track: song(2) })
  await invoke('record_play', { track: song(1) })
  const history = await invoke('history', { limit: 10 })
  assert.deepEqual(history.map((entry) => entry.track.id), [1, 2, 1])
  assert.equal(new Set(history.map((entry) => entry.entryId)).size, 3)
  assert.deepEqual((await invoke('history', { limit: 2 })).map((entry) => entry.track.id), [1, 2])
  assert.deepEqual(await invoke('history', { limit: 0 }), [])
  await invoke('clear_history')
  assert.deepEqual(await invoke('history', { limit: 10 }), [])
  assert.deepEqual((await invoke('library')).likedIds, [1])
})

test('YouTube asigna IDs seguros estables, actualiza metadatos y no rompe referencias al quitar del listado', async (t) => {
  const { store, factory, name, invoke } = setup(t)
  const input = { videoId: 'abcdefghijk', title: 'Tema', artist: 'Canal', duration: 90,
    cover: 'https://untrusted.example/ignored.jpg' }
  const saved = await Promise.all(Array.from({ length: 8 }, () => invoke('save_youtube_track', input)))
  const first = saved[0]
  assert.ok(first.id > YOUTUBE && first.id < PODCAST && Number.isSafeInteger(first.id))
  assert.equal(new Set(saved.map((track) => track.id)).size, 1)
  assert.equal(first.cover, 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg')
  const second = await invoke('save_youtube_track', { ...input, videoId: '1234567890A', title: 'Otro' })
  assert.notEqual(second.id, first.id)
  const playlist = await invoke('create_playlist', { name: 'Vídeos', tracks: [first] })
  await invoke('set_liked', { track: first, liked: true })
  await invoke('record_play', { track: first })
  await invoke('remove_youtube_track', { id: first.id })
  assert.deepEqual((await invoke('youtube_tracks')).map((entry) => entry.track.id), [second.id])
  assert.equal(await store.readYouTubeVideo(first.id), input.videoId)
  assert.equal((await invoke('playlist', { id: playlist.id })).entries[0].track.id, first.id)
  assert.deepEqual((await invoke('library')).likedIds, [first.id])
  assert.equal((await invoke('history', { limit: 1 }))[0].track.id, first.id)
  const restored = await invoke('save_youtube_track', { ...input, title: 'Título renovado' })
  assert.equal(restored.id, first.id)
  assert.equal((await invoke('playlist', { id: playlist.id })).entries[0].track.title, 'Título renovado')
  await assert.rejects(store.saveSourceChoice(first.id, choice({ videoId: '1234567890A' })), /no se puede sustituir/)
  await store.close()
  const reopened = createWebStorage({ indexedDB: factory, name })
  t.after(() => reopened.close())
  assert.equal(await reopened.readYouTubeVideo(first.id), input.videoId)
})

test('el progreso de cada episodio sobrevive al cierre, limita la posición y permite volver a cero', async (t) => {
  const { store, factory, name, invoke } = setup(t)
  await invoke('save_podcast_progress', { progress: { id: EPISODE + 1, position: 137.5, duration: 3600, completed: false } })
  await invoke('save_podcast_progress', { progress: { id: EPISODE + 2, position: 1900, duration: 1800, completed: true } })
  await store.close()
  const reopened = createWebStorage({ indexedDB: factory, name })
  t.after(() => reopened.close())
  assert.deepEqual(await reopened.storageInvoke('podcast_progress', { ids: [EPISODE + 1, EPISODE + 2, EPISODE + 3] }), [
    { id: EPISODE + 1, position: 137.5, duration: 3600, completed: false },
    { id: EPISODE + 2, position: 1800, duration: 1800, completed: true },
  ])
  await reopened.storageInvoke('save_podcast_progress', { progress: { id: EPISODE + 2, position: 0, duration: 0, completed: false } })
  assert.equal((await reopened.storageInvoke('podcast_progress', { ids: [EPISODE + 2] }))[0].position, 0)
  for (const position of [-1, NaN, Infinity]) {
    await assert.rejects(reopened.storageInvoke('save_podcast_progress', { progress: { id: EPISODE + 2, position, duration: 0, completed: false } }), /posición/)
  }
  await assert.rejects(reopened.storageInvoke('save_podcast_progress', { progress: { id: 1, position: 0, duration: 0, completed: false } }), /episodio/)
})

test('las elecciones de fuente y las entidades guardan solo metadatos permitidos, nunca streams o audio', async (t) => {
  const { store, invoke, factory, name } = setup(t)
  const secret = 'https://rr1.googlevideo.com/videoplayback?sig=DO_NOT_PERSIST'
  assert.equal(await store.readSourceChoice(1), null)
  await store.saveSourceChoice(1, choice({ url: secret, audioUrl: secret, bytes: new Uint8Array([1, 2, 3]) }))
  await invoke('set_liked', { track: song(1, { url: secret, path: 'secret-audio.mp3', audio: new Uint8Array([1, 2]) }), liked: true })
  await store.rememberPodcasts([show(PODCAST + 1, { audioUrl: secret, episodes: [{ audioUrl: secret }] })])
  assert.deepEqual(await store.readSourceChoice(1), choice())
  const database = await dump(factory, name)
  const encoded = JSON.stringify(database)
  assert.equal(encoded.includes('DO_NOT_PERSIST'), false)
  assert.equal(encoded.includes('secret-audio.mp3'), false)
  assert.deepEqual(Object.keys(database.sources[0].choice).sort(), Object.keys(choice()).sort())
  await assert.rejects(invoke('set_liked', { track: song(2, { cover: secret }), liked: true }), /imagen/)
  await assert.rejects(store.rememberPodcasts([show(PODCAST + 2, { feedUrl: secret })]), /metadatos/)
  await assert.rejects(invoke('set_artist_saved', { artist: { id: 99, name: 'Firmado', picture: 'https://images.example/a.jpg?X-Amz-Signature=DO_NOT_PERSIST' }, saved: true }), /metadatos/)
  await assert.rejects(store.saveSourceChoice(2, choice({ videoId: 'https://bad.example/' })), /vídeo/)
  assert.equal(await store.readSourceChoice(2), null)
})

test('los comandos sin soporte rechazan de forma explícita sin abrir una base ni simular éxito', async () => {
  let opened = 0
  const store = createWebStorage({ indexedDB: { open() { opened++; throw new Error('No debería abrirse') } } })
  for (const command of ['search', 'resolve', 'download', 'downloads_list', 'local_library', 'http_fetch', 'install_update', 'unknown']) {
    assert.equal(handlesStorage(command), false)
    await assert.rejects(store.storageInvoke(command, {}), /no está disponible/)
  }
  assert.equal(opened, 0)
  assert.equal(handlesStorage('library'), true)
  assert.equal(handlesStorage('move_in_playlist'), true)
})

test('un fallo de apertura se propaga y se puede reintentar sin pasar a almacenamiento ficticio', async (t) => {
  const real = new IDBFactory()
  let attempt = 0
  const store = createWebStorage({ name: 'retry', indexedDB: { open(...args) {
    if (++attempt === 1) throw new DOMException('Acceso al almacenamiento denegado', 'SecurityError')
    return real.open(...args)
  } } })
  t.after(() => store.close())
  await assert.rejects(store.storageInvoke('set_liked', { track: song(1), liked: true }), { name: 'SecurityError' })
  assert.deepEqual((await store.storageInvoke('library')).likedIds, [])
  await store.storageInvoke('set_liked', { track: song(1), liked: true })
  assert.deepEqual((await store.storageInvoke('library')).likedIds, [1])
})
