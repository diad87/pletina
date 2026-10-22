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
const episode = (guid = 'episodio-1', extra = {}) => ({ id: 0, guid, title: `Episodio ${guid}`,
  description: 'Descripción del episodio', publishedAt: '2026-10-19T08:00:00Z', duration: 3600,
  audioUrl: `https://audio.example/${guid}.mp3`, image: null, explicit: false, ...extra })

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

test('ISRC y versión sobreviven a playlists, historial y favoritos; una copia antigua no borra la identidad', async t => {
  const { store, factory, name, invoke } = setup(t)
  const identity = { isrc: 'QM6N21424821', titleVersion: 'Original' }
  const signed = 'https://audio.example/stream?token=DO_NOT_PERSIST'
  const track = song(1, { ...identity, playable: { url: signed, source: { provider: 'audius', id: 'private-source' } }, url: signed })
  const list = await invoke('create_playlist', { name: 'Grabación correcta', tracks: [track, song(2, { isrc: null, titleVersion: null })] })
  await invoke('set_liked', { track, liked: true })
  await invoke('record_play', { track: song(1) })
  await store.close()
  const reopened = createWebStorage({ indexedDB: factory, name })
  t.after(() => reopened.close())
  const playlist = await reopened.storageInvoke('playlist', { id: list.id })
  const liked = await reopened.storageInvoke('liked_tracks')
  const history = await reopened.storageInvoke('history', { limit: 10 })
  for (const entry of [playlist.entries[0], liked[0], history[0]]) {
    assert.equal(entry.track.isrc, identity.isrc)
    assert.equal(entry.track.titleVersion, identity.titleVersion)
  }
  assert.equal(playlist.entries[1].track.isrc, null)
  assert.equal(playlist.entries[1].track.titleVersion, null)
  assert.doesNotMatch(JSON.stringify(await dump(factory, name)), /DO_NOT_PERSIST|private-source|playable/)
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

for (const action of ['record_play', 'set_liked', 'create_playlist', 'add_to_playlist']) {
  test(`copias antiguas de YouTube no revierten la edición con ${action}`, async (t) => {
    const { store, factory, name, invoke } = setup(t)
    const input = { videoId: 'abcdefghijk', title: 'Título original', artist: 'Canal original', duration: 90 }
    const old = await invoke('save_youtube_track', input)
    const list = await invoke('create_playlist', { name: 'Referencias', tracks: [old, old] })
    const entryIds = (await invoke('playlist', { id: list.id })).entries.map(entry => entry.entryId)
    await invoke('set_liked', { track: old, liked: true })
    await invoke('record_play', { track: old })
    const edited = await invoke('save_youtube_track', { ...input, title: 'Título corregido', artist: 'Canal corregido', duration: 321 })
    assert.equal(edited.id, old.id)
    if (action === 'add_to_playlist') await invoke('remove_youtube_track', { id: old.id })
    let additional
    if (action === 'record_play') await invoke(action, { track: old })
    if (action === 'set_liked') await invoke(action, { track: old, liked: true })
    if (action === 'create_playlist') additional = await invoke(action, { name: 'Copia de cola', tracks: [old, old] })
    if (action === 'add_to_playlist') await invoke(action, { id: list.id, tracks: [old] })
    assert.deepEqual(await rawGet(factory, name, 'tracks', old.id), edited)
    assert.deepEqual((await invoke('liked_tracks'))[0].track, edited)
    for (const entry of await invoke('history', { limit: 10 })) assert.deepEqual(entry.track, edited)
    const current = await invoke('playlist', { id: list.id })
    assert.deepEqual(current.entries.slice(0, 2).map(entry => entry.entryId), entryIds)
    for (const entry of current.entries) assert.deepEqual(entry.track, edited)
    if (additional) {
      assert.equal(additional.duration, edited.duration * 2)
      for (const entry of (await invoke('playlist', { id: additional.id })).entries) assert.deepEqual(entry.track, edited)
    }
    assert.equal(await store.readYouTubeVideo(old.id), input.videoId)
    if (action === 'add_to_playlist') assert.deepEqual(await invoke('youtube_tracks'), [], 'Quitar del listado conserva la ficha usada por otras referencias')
    const latest = await invoke('save_youtube_track', { ...input, title: 'Edición posterior', artist: 'Autor definitivo', duration: 444 })
    assert.equal(latest.id, old.id)
    await store.close()
    const reopened = createWebStorage({ indexedDB: factory, name })
    t.after(() => reopened.close())
    assert.deepEqual((await reopened.storageInvoke('youtube_tracks'))[0].track, latest)
    assert.deepEqual((await reopened.storageInvoke('liked_tracks'))[0].track, latest)
    for (const entry of (await reopened.storageInvoke('history', { limit: 10 }))) assert.deepEqual(entry.track, latest)
    const restored = await reopened.storageInvoke('playlist', { id: list.id })
    assert.deepEqual(restored.entries.slice(0, 2).map(entry => entry.entryId), entryIds)
    for (const entry of restored.entries) assert.deepEqual(entry.track, latest)
    assert.equal(await reopened.readYouTubeVideo(old.id), input.videoId)
  })
}

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

test('los programas y episodios tienen identidad estable por feed y GUID aunque cambie la dirección del audio', async (t) => {
  const { store, factory, name, invoke } = setup(t)
  const [program] = await store.savePodcastShows([show(0)])
  assert.equal(program.id, PODCAST + 1)
  const first = await store.savePodcastDetail({ podcast: show(0), episodes: [episode('guid-estable'), episode('segundo')] })
  assert.equal(first.podcast.id, program.id)
  assert.deepEqual(first.episodes.map((value) => value.id), [EPISODE + 1, EPISODE + 2])
  const id = first.episodes[0].id
  await invoke('save_podcast_progress', { progress: { id, position: 123.5, duration: 3600, completed: false } })
  await invoke('set_podcast_saved', { id: program.id, saved: true })
  const track = song(id, { title: first.episodes[0].title, albumId: program.id })
  const list = await invoke('create_playlist', { name: 'Episodios', tracks: [track, track] })
  await invoke('record_play', { track })
  const updated = await store.savePodcastDetail({ podcast: show(0, { title: 'Programa actualizado' }), episodes: [
    episode('segundo'), episode('guid-estable', { title: 'Título actualizado', audioUrl: 'https://audio.example/new.mp3?token=published-rss-token' }),
  ] })
  assert.deepEqual(updated.episodes.map((value) => value.id), [EPISODE + 2, id])
  assert.equal(await store.readPodcastFeedUrl(program.id), show().feedUrl)
  assert.equal(await invoke('podcast_feed_url', { id: program.id }), show().feedUrl)
  const source = await store.readPodcastEpisode(id)
  assert.equal(source.guid, 'guid-estable')
  assert.equal(source.podcastId, program.id)
  assert.equal(source.audioUrl, 'https://audio.example/new.mp3?token=published-rss-token')
  assert.equal(source.feedUrl, show().feedUrl)
  assert.equal((await invoke('library')).podcasts[0].title, 'Programa actualizado')
  assert.equal((await invoke('playlist', { id: list.id })).entries[0].track.title, 'Título actualizado')
  assert.equal((await invoke('history', { limit: 1 }))[0].track.albumTitle, 'Programa actualizado')
  assert.deepEqual(await invoke('podcast_progress', { ids: [id] }), [{ id, position: 123.5, duration: 3600, completed: false }])
  await store.close()
  const reopened = createWebStorage({ indexedDB: factory, name })
  t.after(() => reopened.close())
  assert.deepEqual(await reopened.readPodcastDetail(show().feedUrl + '#fragment-not-sent-to-server'), updated)
  assert.deepEqual(await reopened.readPodcastEpisode(id), source)
  const copy = await reopened.readPodcastDetail(show().feedUrl)
  copy.episodes[0].title = 'Mutación local'
  assert.equal((await reopened.readPodcastDetail(show().feedUrl)).episodes[0].title, updated.episodes[0].title)
})

test('los episodios fuera del RSS actual conservan fuente, progreso y referencias al quitar un programa guardado', async (t) => {
  const { store, invoke } = setup(t)
  const first = await store.savePodcastDetail({ podcast: show(0), episodes: [episode('viejo'), episode('actual'), episode('actual')] })
  assert.equal(first.episodes.length, 2, 'duplicate GUID in one feed is a single episode')
  const old = first.episodes[0]
  await invoke('set_podcast_saved', { id: first.podcast.id, saved: true })
  await invoke('save_podcast_progress', { progress: { id: old.id, position: 3600, duration: 3600, completed: true } })
  await invoke('set_liked', { track: song(old.id), liked: true })
  const second = await store.savePodcastDetail({ podcast: show(0), episodes: [episode('actual')] })
  assert.equal(second.episodes[0].id, first.episodes[1].id)
  assert.equal((await invoke('library')).podcasts[0].episodeCount, 2, 'saved library counts all known episodes as the native store does')
  await invoke('set_podcast_saved', { id: first.podcast.id, saved: false })
  assert.deepEqual((await invoke('library')).podcasts, [])
  assert.equal((await store.readPodcastEpisode(old.id)).audioUrl, old.audioUrl)
  assert.equal((await store.readPodcastDetail(show().feedUrl)).episodes.length, 1)
  assert.deepEqual((await invoke('library')).likedIds, [old.id])
  assert.equal((await invoke('podcast_progress', { ids: [old.id] }))[0].completed, true)
  const youtube = await store.savePodcastDetail({ podcast: show(0, { feedUrl: 'youtube:PLpodcast', title: 'YouTube' }),
    episodes: [episode('viejo', { audioUrl: 'youtube:abcdefghijk' })] })
  assert.notEqual(youtube.podcast.id, first.podcast.id)
  assert.notEqual(youtube.episodes[0].id, old.id, 'same GUID in another feed has a separate identity')
  assert.equal((await store.readPodcastEpisode(youtube.episodes[0].id)).audioUrl, 'youtube:abcdefghijk')
})

test('dos conexiones importan el mismo feed y GUID sin IDs duplicados ni progreso perdido', async (t) => {
  const { store, factory, name, invoke } = setup(t)
  const other = createWebStorage({ indexedDB: factory, name })
  t.after(() => other.close())
  const details = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? store : other).savePodcastDetail({
    podcast: show(0), episodes: [episode('compartido')],
  })))
  assert.equal(new Set(details.map((value) => value.podcast.id)).size, 1)
  assert.equal(new Set(details.map((value) => value.episodes[0].id)).size, 1)
  const id = details[0].episodes[0].id
  await invoke('save_podcast_progress', { progress: { id, position: 92, duration: 3600, completed: false } })
  const refreshed = await other.savePodcastShows([show(0, { title: 'Ficha nueva', episodeCount: 0 })])
  assert.equal(refreshed[0].id, details[0].podcast.id)
  assert.equal(refreshed[0].episodeCount, 1, 'a search result cannot erase the known detail count')
  assert.equal((await store.readPodcastDetail(show().feedUrl)).episodes[0].id, id)
  assert.equal((await invoke('podcast_progress', { ids: [id] }))[0].position, 92)
  const database = await dump(factory, name)
  assert.equal(database.podcasts.length, 1)
  assert.equal(database.episodes.length, 1)
})

test('el esquema v2 conserva la biblioteca v1 y no adjudica progreso o canciones antiguos a episodios nuevos', async (t) => {
  const factory = new IDBFactory(), name = 'upgrade-from-v1'
  const opening = factory.open(name, 1)
  const oldStores = ['tracks', 'likes', 'albums', 'artists', 'podcasts', 'playlists', 'entries', 'history', 'progress', 'youtube', 'sources', 'meta']
  opening.onupgradeneeded = () => {
    const db = opening.result
    for (const store of oldStores) db.createObjectStore(store, {
      keyPath: store === 'likes' ? 'trackId' : ['entries', 'history'].includes(store) ? 'entryId'
        : ['youtube', 'sources'].includes(store) ? 'trackId' : store === 'meta' ? 'key' : 'id',
      autoIncrement: ['entries', 'history', 'playlists'].includes(store),
    })
    opening.transaction.objectStore('entries').createIndex('playlistId', 'playlistId')
    opening.transaction.objectStore('youtube').createIndex('videoId', 'videoId', { unique: true })
  }
  const db = await result(opening)
  const transaction = db.transaction(oldStores, 'readwrite')
  const oldProgram = show(PODCAST + 25)
  transaction.objectStore('podcasts').put({ id: oldProgram.id, value: oldProgram, saved: true, at: 1, order: 1 })
  // This was legal in v1. The new non-unique feed index must not make upgrade fail.
  transaction.objectStore('podcasts').put({ id: PODCAST + 26, value: show(PODCAST + 26), saved: false, at: 1, order: 2 })
  transaction.objectStore('tracks').put(song(1))
  transaction.objectStore('tracks').put(song(EPISODE + 2))
  transaction.objectStore('likes').put({ trackId: 1, at: 1, order: 2 })
  transaction.objectStore('playlists').put({ id: 1, name: 'Lista antigua', order: 3 })
  transaction.objectStore('entries').put({ entryId: 1, playlistId: 1, trackId: 1, position: 0, at: 1 })
  transaction.objectStore('progress').put({ id: EPISODE + 1, position: 57, duration: 600, completed: false })
  transaction.objectStore('sources').put({ trackId: 1, choice: choice() })
  transaction.objectStore('meta').put({ key: 'order', value: 3 })
  await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error) })
  db.close()
  const store = createWebStorage({ indexedDB: factory, name })
  t.after(() => store.close())
  assert.deepEqual((await store.storageInvoke('library')).likedIds, [1])
  assert.equal((await store.storageInvoke('playlist', { id: 1 })).entries[0].track.id, 1)
  assert.equal((await store.storageInvoke('library')).podcasts[0].id, oldProgram.id)
  assert.deepEqual(await store.readSourceChoice(1), choice())
  const detail = await store.savePodcastDetail({ podcast: show(0), episodes: [episode('nuevo')] })
  assert.equal(detail.podcast.id, oldProgram.id)
  assert.equal(detail.episodes[0].id, EPISODE + 3)
  assert.equal((await store.storageInvoke('podcast_progress', { ids: [EPISODE + 1] }))[0].position, 57)
  const [newProgram] = await store.savePodcastShows([show(0, { feedUrl: 'https://other.example/feed.xml' })])
  assert.equal(newProgram.id, PODCAST + 27)
  const upgraded = await result(factory.open(name))
  assert.equal(upgraded.version, 2)
  assert.equal(upgraded.transaction('episodes').objectStore('episodes').index('identity').unique, true)
  upgraded.close()
})

test('una importación de episodios fallida revierte ficha, fuentes, metadatos y contadores en la misma transacción', async (t) => {
  const { store, factory, name } = setup(t)
  await store.savePodcastDetail({ podcast: show(0), episodes: [episode('conservado')] })
  const before = await dump(factory, name)
  const original = IDBObjectStore.prototype.put
  let writes = 0
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name === 'episodes' && ++writes === 2) throw new DOMException('Cuota simulada', 'QuotaExceededError')
    return original.apply(this, args)
  }
  try {
    await assert.rejects(store.savePodcastDetail({ podcast: show(0, { title: 'No guardar' }), episodes: [episode('a'), episode('b')] }), { name: 'QuotaExceededError' })
  } finally { IDBObjectStore.prototype.put = original }
  assert.deepEqual(await dump(factory, name), before)
  const after = await store.savePodcastDetail({ podcast: show(0), episodes: [episode('a')] })
  assert.equal(after.episodes[0].id, EPISODE + 2, 'failed allocation did not consume an ID')
})

test('los episodios conservan solo fuentes publicadas y metadatos validados, nunca URLs resueltas de YouTube ni extras', async (t) => {
  const { store, factory, name, invoke } = setup(t)
  const detail = await store.savePodcastDetail({ podcast: show(0), episodes: [episode('limpio', {
    streamUrl: 'DO_NOT_PERSIST', bytes: new Uint8Array([1, 2]), path: 'secret-audio.mp3',
  })] })
  assert.equal(JSON.stringify(await dump(factory, name)).includes('DO_NOT_PERSIST'), false)
  assert.equal(JSON.stringify(await dump(factory, name)).includes('secret-audio.mp3'), false)
  for (const audioUrl of ['https://rr1.googlevideo.com/videoplayback?sig=DO_NOT_PERSIST', 'youtube:bad', 'file:///private.mp3', 'data:audio/mp3;base64,AAA', 'https://user:pass@example.com/audio.mp3']) {
    await assert.rejects(store.savePodcastDetail({ podcast: show(0), episodes: [episode('bad', { audioUrl })] }), /audio|vídeo/)
  }
  await assert.rejects(store.savePodcastDetail({ podcast: show(0), episodes: [episode('')] }), /identidad/)
  assert.equal(await store.readPodcastEpisode(EPISODE + 999), null)
  assert.equal(await store.readPodcastFeedUrl(PODCAST + 999), null)
  assert.equal(await store.readPodcastDetail('https://missing.example/rss.xml'), null)
  await assert.rejects(invoke('podcast_feed_url', { id: PODCAST + 999 }), /No se encuentra/)
  await assert.rejects(store.readPodcastEpisode(PODCAST + 1), /episodio/)
  await assert.rejects(store.readPodcastFeedUrl(EPISODE + 1), /pódcast/)
  assert.equal((await store.readPodcastDetail(show().feedUrl)).episodes[0].id, detail.episodes[0].id)
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
