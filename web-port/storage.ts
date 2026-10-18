import type {
  Entry, LibTrack, LibraryData, PlaylistDetail, PlaylistSummary, Podcast,
  PodcastProgress, SavedAlbum, SavedArtist,
} from '../src/lib/types'

const DATABASE_VERSION = 1
const DEFAULT_DATABASE = 'pletina-web-library'
const YOUTUBE_BASE = 250_000_000_000_000
const PODCAST_BASE = 500_000_000_000_000
const EPISODE_BASE = 750_000_000_000_000
const LOCAL_BASE = 1_000_000_000_000_000
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/
const STORES = ['tracks', 'likes', 'albums', 'artists', 'podcasts', 'playlists',
  'entries', 'history', 'progress', 'youtube', 'sources', 'meta'] as const
type Store = typeof STORES[number]

const COMMANDS = new Set([
  'library', 'set_liked', 'liked_tracks', 'set_album_saved', 'set_artist_saved',
  'set_podcast_saved', 'create_playlist', 'rename_playlist', 'delete_playlist',
  'playlist', 'add_to_playlist', 'remove_from_playlist', 'move_in_playlist',
  'record_play', 'history', 'clear_history', 'podcast_progress',
  'save_podcast_progress', 'save_youtube_track', 'youtube_tracks', 'remove_youtube_track',
])

export interface SourceChoice {
  videoId: string
  title: string
  channel: string
  duration: number | null
  score: number
  verified: boolean
}

interface Timed<T> { id: number; value: T; at: number; order: number }
interface LikeRow { trackId: number; at: number; order: number }
interface PlaylistRow { id: number; name: string; order: number }
interface EntryRow { entryId: number; playlistId: number; trackId: number; position: number; at: number }
interface HistoryRow { entryId: number; trackId: number; at: number }
interface PodcastRow extends Timed<Podcast> { saved: boolean }
interface YouTubeRow { trackId: number; videoId: string; saved: boolean; at: number; order: number }
interface SourceRow { trackId: number; choice: SourceChoice }
interface MetaRow { key: string; value: number }

export interface WebStorageOptions {
  /** Optional factory for a separate database or tests; production uses the browser's IndexedDB. */
  indexedDB?: IDBFactory
  name?: string
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} no es válido.`)
  return value as Record<string, unknown>
}
function integer(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} no es válido.`)
  return value
}
const id = (value: unknown) => integer(value, 'El identificador', 1)
function number(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${label} no es válido.`)
  return value
}
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} no es válido.`)
  return value
}
function text(value: unknown, label: string, allowEmpty = false, max = 4000): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) throw new Error(`${label} no es válido.`)
  return value.trim()
}
const nullableText = (value: unknown, label: string) => value == null ? null : text(value, label, true)
function metadataURL(raw: string, label: string): string {
  let url: URL
  try { url = new URL(raw) } catch { throw new Error(`${label} no es una dirección HTTP válida.`) }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
    || url.hostname === 'googlevideo.com' || url.hostname.endsWith('.googlevideo.com')
    || [...url.searchParams.keys()].some((key) => /^(?:sig|lsig|signature|token|access_token|authorization|expires?|policy|key-pair-id|x-amz-(?:signature|credential)|x-goog-(?:signature|credential))$/i.test(key))) {
    throw new Error(`${label} no es una dirección de metadatos permanente y sin credenciales.`)
  }
  return url.href
}
function image(value: unknown): string | null {
  if (value == null || value === '') return null
  return metadataURL(text(value, 'La imagen', false, 8192), 'La imagen')
}
function videoId(value: unknown): string {
  if (typeof value !== 'string' || !VIDEO_ID.test(value)) throw new Error('El identificador del vídeo no es válido.')
  return value
}
function track(value: unknown): LibTrack {
  const row = object(value, 'La canción')
  // Explicit fields only: stream URLs, paths, tokens and binary payloads never enter the database.
  return {
    id: id(row.id), title: text(row.title, 'El título'), duration: number(row.duration, 'La duración'),
    explicit: boolean(row.explicit, 'El indicador de contenido explícito'),
    artistId: integer(row.artistId, 'El artista'), artistName: text(row.artistName, 'El artista', true),
    albumId: integer(row.albumId, 'El álbum'), albumTitle: text(row.albumTitle, 'El álbum', true),
    albumArtistId: integer(row.albumArtistId, 'El artista del álbum'), cover: image(row.cover),
  }
}
function tracks(value: unknown): LibTrack[] {
  if (!Array.isArray(value)) throw new Error('La lista de canciones no es válida.')
  return value.map(track)
}
function album(value: unknown): SavedAlbum {
  const row = object(value, 'El álbum')
  return { id: id(row.id), title: text(row.title, 'El título'), artistId: integer(row.artistId, 'El artista'),
    artistName: text(row.artistName, 'El artista', true), cover: image(row.cover),
    releaseDate: nullableText(row.releaseDate, 'La fecha'), recordType: nullableText(row.recordType, 'El tipo de álbum') }
}
function artist(value: unknown): SavedArtist {
  const row = object(value, 'El artista')
  return { id: id(row.id), name: text(row.name, 'El nombre del artista'), picture: image(row.picture) }
}
function podcast(value: unknown): Podcast {
  const row = object(value, 'El pódcast')
  const feedUrl = text(row.feedUrl, 'La fuente del pódcast', false, 8192)
  if (!/^youtube:[A-Za-z0-9_-]+$/.test(feedUrl)) {
    metadataURL(feedUrl, 'La fuente del pódcast')
  }
  return { id: integer(row.id, 'El identificador del pódcast', PODCAST_BASE, EPISODE_BASE - 1),
    title: text(row.title, 'El título'), author: text(row.author, 'El autor', true),
    description: text(row.description, 'La descripción', true, 200_000), image: image(row.image), feedUrl,
    language: nullableText(row.language, 'El idioma'), episodeCount: integer(row.episodeCount, 'El número de episodios') }
}
function progress(value: unknown): PodcastProgress {
  const row = object(value, 'La posición del episodio')
  const duration = number(row.duration, 'La duración')
  const position = number(row.position, 'La posición')
  return { id: integer(row.id, 'El episodio', EPISODE_BASE, LOCAL_BASE - 1),
    position: duration > 0 ? Math.min(position, duration) : position, duration,
    completed: boolean(row.completed, 'El estado del episodio') }
}
function sourceChoice(value: unknown): SourceChoice {
  const row = object(value, 'La elección de audio')
  if (typeof row.score !== 'number' || !Number.isFinite(row.score)) throw new Error('La puntuación no es válida.')
  return { videoId: videoId(row.videoId), title: text(row.title, 'El título', true),
    channel: text(row.channel, 'El canal', true), duration: row.duration == null ? null : number(row.duration, 'La duración'),
    score: row.score, verified: boolean(row.verified, 'El estado de verificación') }
}
const timestamp = () => Math.floor(Date.now() / 1000)
const newest = <T extends { order: number }>(rows: T[]) => rows.sort((a, b) => b.order - a.order)
const playlistName = (value: unknown) => [...text(value, 'El nombre de la lista', true)].slice(0, 100).join('') || 'Playlist sin nombre'

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result)
    operation.onerror = () => reject(operation.error || new Error('IndexedDB rechazó la operación.'))
  })
}
const get = <T>(tx: IDBTransaction, store: Store, key: IDBValidKey) => request(tx.objectStore(store).get(key)) as Promise<T | undefined>
const all = <T>(tx: IDBTransaction, store: Store) => request(tx.objectStore(store).getAll()) as Promise<T[]>
const put = (tx: IDBTransaction, store: Store, value: unknown) => request(tx.objectStore(store).put(value))
const remove = (tx: IDBTransaction, store: Store, key: IDBValidKey) => request(tx.objectStore(store).delete(key))

/** A factory keeps test databases separate without substituting the production persistence logic. */
export function createWebStorage(options: WebStorageOptions = {}) {
  let connection: IDBDatabase | undefined
  let opening: Promise<IDBDatabase> | undefined
  const name = options.name || DEFAULT_DATABASE

  async function open(): Promise<IDBDatabase> {
    if (connection) return connection
    if (opening) return opening
    const factory = options.indexedDB || globalThis.indexedDB
    if (!factory) throw new Error('IndexedDB no está disponible. No se ha guardado ningún cambio.')
    const pending = new Promise<IDBDatabase>((resolve, reject) => {
      const operation = factory.open(name, DATABASE_VERSION)
      let settled = false
      operation.onupgradeneeded = () => {
        const db = operation.result
        for (const store of STORES) {
          const keyPath = store === 'likes' ? 'trackId' : store === 'entries' || store === 'history' ? 'entryId'
            : store === 'youtube' || store === 'sources' ? 'trackId' : store === 'meta' ? 'key' : 'id'
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, {
            keyPath, autoIncrement: store === 'playlists' || store === 'entries' || store === 'history',
          })
        }
        const entries = operation.transaction!.objectStore('entries')
        if (!entries.indexNames.contains('playlistId')) entries.createIndex('playlistId', 'playlistId')
        const youtube = operation.transaction!.objectStore('youtube')
        if (!youtube.indexNames.contains('videoId')) youtube.createIndex('videoId', 'videoId', { unique: true })
      }
      operation.onerror = () => { settled = true; reject(operation.error || new Error('No se pudo abrir la biblioteca web.')) }
      operation.onblocked = () => { settled = true; reject(new Error('Otra pestaña bloquea la actualización de la biblioteca. Ciérrala y vuelve a intentarlo.')) }
      operation.onsuccess = () => {
        if (settled) { operation.result.close(); return }
        settled = true
        const db = operation.result
        connection = db
        db.onversionchange = () => { db.close(); if (connection === db) connection = undefined }
        resolve(db)
      }
    })
    opening = pending
    try { return await pending } finally { if (opening === pending) opening = undefined }
  }

  async function transaction<T>(mode: IDBTransactionMode, execute: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    const db = await open()
    // A write locks the related stores together: entries, track metadata and ID allocation commit atomically.
    const tx = db.transaction([...STORES], mode)
    const completed = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error || new Error('La transacción de la biblioteca se canceló. No se han guardado cambios.'))
      tx.onerror = () => { /* onabort reports the final transaction outcome. */ }
    })
    void completed.catch(() => {})
    try {
      const result = await execute(tx)
      await completed
      return result
    } catch (error) {
      try { tx.abort() } catch { /* Already committed or aborted. */ }
      await completed.catch(() => {})
      throw error
    }
  }

  async function sequence(tx: IDBTransaction, key = 'order', base = 0): Promise<number> {
    const next = ((await get<MetaRow>(tx, 'meta', key))?.value ?? base) + 1
    if (!Number.isSafeInteger(next)) throw new Error('No se pueden guardar más entradas.')
    await put(tx, 'meta', { key, value: next })
    return next
  }
  async function entries(tx: IDBTransaction, playlistId: number): Promise<Entry[]> {
    const rows = await request(tx.objectStore('entries').index('playlistId').getAll(playlistId)) as EntryRow[]
    rows.sort((a, b) => a.position - b.position || a.entryId - b.entryId)
    return Promise.all(rows.map(async (row) => {
      const value = await get<LibTrack>(tx, 'tracks', row.trackId)
      if (!value) throw new Error('Faltan los metadatos de una canción de la lista.')
      return { entryId: row.entryId, track: value, at: row.at }
    }))
  }
  function summary(row: PlaylistRow, values: Entry[]): PlaylistSummary {
    return { id: row.id, name: row.name, count: values.length,
      duration: values.reduce((sum, entry) => sum + entry.track.duration, 0),
      covers: [...new Set(values.map((entry) => entry.track.cover).filter((cover): cover is string => Boolean(cover)))].slice(0, 4) }
  }
  async function requirePlaylist(tx: IDBTransaction, playlistId: number): Promise<PlaylistRow> {
    const row = await get<PlaylistRow>(tx, 'playlists', playlistId)
    if (!row) throw new Error('Esta playlist ya no existe.')
    return row
  }
  async function append(tx: IDBTransaction, playlistId: number, values: LibTrack[]) {
    const row = await requirePlaylist(tx, playlistId)
    const existing = await request(tx.objectStore('entries').index('playlistId').getAll(playlistId)) as EntryRow[]
    let position = existing.reduce((max, entry) => Math.max(max, entry.position), -1) + 1
    for (const value of values) {
      await put(tx, 'tracks', value)
      await request(tx.objectStore('entries').add({ playlistId, trackId: value.id, position: position++, at: timestamp() }))
    }
    await put(tx, 'playlists', { ...row, order: await sequence(tx) })
  }
  async function saveTimed<T extends { id: number }>(tx: IDBTransaction, store: 'albums' | 'artists', value: T) {
    const old = await get<Timed<T>>(tx, store, value.id)
    await put(tx, store, { id: value.id, value, at: old?.at ?? timestamp(), order: old?.order ?? await sequence(tx) })
  }

  async function storageInvoke(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!handlesStorage(command)) throw new Error(`El comando «${command}» no está disponible en el almacenamiento web.`)
    object(args, 'Los argumentos')
    const readonly = ['library', 'liked_tracks', 'playlist', 'history', 'podcast_progress', 'youtube_tracks'].includes(command)
    return transaction(readonly ? 'readonly' : 'readwrite', async (tx) => {
      switch (command) {
        case 'library': {
          const [liked, albums, artists, podcasts, lists] = await Promise.all([
            all<LikeRow>(tx, 'likes'), all<Timed<SavedAlbum>>(tx, 'albums'), all<Timed<SavedArtist>>(tx, 'artists'),
            all<PodcastRow>(tx, 'podcasts'), all<PlaylistRow>(tx, 'playlists'),
          ])
          const data: LibraryData = { likedIds: newest(liked).map((row) => row.trackId), downloadedIds: [],
            albums: newest(albums).map((row) => row.value), artists: newest(artists).map((row) => row.value),
            podcasts: newest(podcasts.filter((row) => row.saved)).map((row) => row.value),
            playlists: await Promise.all(newest(lists).map(async (row) => summary(row, await entries(tx, row.id)))) }
          return data
        }
        case 'set_liked': {
          const liked = boolean(args.liked, 'El estado de favorito')
          const trackId = id(object(args.track, 'La canción').id)
          if (!liked) { await remove(tx, 'likes', trackId); return }
          const value = track(args.track)
          await put(tx, 'tracks', value)
          if (!await get<LikeRow>(tx, 'likes', trackId)) await put(tx, 'likes', { trackId, at: timestamp(), order: await sequence(tx) })
          return
        }
        case 'liked_tracks': {
          const rows = newest(await all<LikeRow>(tx, 'likes'))
          return Promise.all(rows.map(async (row) => {
            const value = await get<LibTrack>(tx, 'tracks', row.trackId)
            if (!value) throw new Error('Faltan los metadatos de una canción favorita.')
            return { entryId: row.trackId, track: value, at: row.at }
          }))
        }
        case 'set_album_saved':
        case 'set_artist_saved': {
          const isAlbum = command === 'set_album_saved'
          const store = isAlbum ? 'albums' : 'artists'
          const input = isAlbum ? args.album : args.artist
          if (!boolean(args.saved, 'El estado de guardado')) { await remove(tx, store, id(object(input, 'Los metadatos').id)); return }
          if (isAlbum) await saveTimed(tx, 'albums', album(input))
          else await saveTimed(tx, 'artists', artist(input))
          return
        }
        case 'set_podcast_saved': {
          const podcastId = integer(args.id, 'El pódcast', PODCAST_BASE, EPISODE_BASE - 1)
          const saved = boolean(args.saved, 'El estado de guardado')
          const row = await get<PodcastRow>(tx, 'podcasts', podcastId)
          if (!row) throw new Error('No se han cargado los metadatos de este pódcast. Ábrelo y vuelve a intentarlo.')
          await put(tx, 'podcasts', { ...row, saved, order: saved && !row.saved ? await sequence(tx) : row.order })
          return
        }
        case 'create_playlist': {
          const values = tracks(args.tracks ?? [])
          const playlistId = await request(tx.objectStore('playlists').add({ name: playlistName(args.name), order: await sequence(tx) })) as number
          await append(tx, playlistId, values)
          return summary(await requirePlaylist(tx, playlistId), await entries(tx, playlistId))
        }
        case 'rename_playlist': {
          const row = await requirePlaylist(tx, id(args.id))
          await put(tx, 'playlists', { ...row, name: playlistName(args.name), order: await sequence(tx) })
          return
        }
        case 'delete_playlist': {
          const playlistId = id(args.id)
          await requirePlaylist(tx, playlistId)
          const rows = await request(tx.objectStore('entries').index('playlistId').getAll(playlistId)) as EntryRow[]
          for (const row of rows) await remove(tx, 'entries', row.entryId)
          await remove(tx, 'playlists', playlistId)
          return
        }
        case 'playlist': {
          const row = await requirePlaylist(tx, id(args.id))
          const values = await entries(tx, row.id)
          return { ...summary(row, values), entries: values } satisfies PlaylistDetail
        }
        case 'add_to_playlist': await append(tx, id(args.id), tracks(args.tracks)); return
        case 'remove_from_playlist':
        case 'move_in_playlist': {
          const row = await requirePlaylist(tx, id(args.id))
          const entryId = id(args.entryId)
          const values = await request(tx.objectStore('entries').index('playlistId').getAll(row.id)) as EntryRow[]
          values.sort((a, b) => a.position - b.position || a.entryId - b.entryId)
          const from = values.findIndex((entry) => entry.entryId === entryId)
          if (from < 0) throw new Error('La entrada ya no está en esta playlist.')
          const [selected] = values.splice(from, 1)
          if (command === 'remove_from_playlist') await remove(tx, 'entries', entryId)
          else values.splice(Math.min(integer(args.to, 'La posición'), values.length), 0, selected)
          for (const [position, entry] of values.entries()) await put(tx, 'entries', { ...entry, position })
          await put(tx, 'playlists', { ...row, order: await sequence(tx) })
          return
        }
        case 'record_play': {
          const value = track(args.track)
          await put(tx, 'tracks', value)
          await request(tx.objectStore('history').add({ trackId: value.id, at: timestamp() }))
          return
        }
        case 'history': {
          const limit = integer(args.limit ?? 100, 'El límite del historial')
          const rows = (await all<HistoryRow>(tx, 'history')).sort((a, b) => b.at - a.at || b.entryId - a.entryId).slice(0, limit)
          return Promise.all(rows.map(async (row) => {
            const value = await get<LibTrack>(tx, 'tracks', row.trackId)
            if (!value) throw new Error('Faltan los metadatos de una escucha.')
            return { entryId: row.entryId, track: value, at: row.at }
          }))
        }
        case 'clear_history': await request(tx.objectStore('history').clear()); return
        case 'save_podcast_progress': await put(tx, 'progress', progress(args.progress)); return
        case 'podcast_progress': {
          if (!Array.isArray(args.ids)) throw new Error('La lista de episodios no es válida.')
          const ids = args.ids.map((value) => integer(value, 'El episodio', EPISODE_BASE, LOCAL_BASE - 1))
          const rows = await Promise.all(ids.map((episode) => get<PodcastProgress>(tx, 'progress', episode)))
          return rows.filter((row): row is PodcastProgress => Boolean(row))
        }
        case 'save_youtube_track': {
          const video = videoId(args.videoId)
          const title = text(args.title, 'El título', false, 300)
          const author = text(args.artist, 'El artista o canal', false, 200)
          const duration = integer(args.duration, 'La duración', 0, 7 * 24 * 60 * 60)
          const old = await request(tx.objectStore('youtube').index('videoId').get(video)) as YouTubeRow | undefined
          const trackId = old?.trackId ?? await sequence(tx, 'youtubeId', YOUTUBE_BASE)
          if (trackId >= PODCAST_BASE) throw new Error('No se pueden guardar más canciones de YouTube.')
          const value: LibTrack = { id: trackId, title, duration, explicit: false, artistId: 0, artistName: author,
            albumId: trackId, albumTitle: 'YouTube', albumArtistId: 0, cover: `https://i.ytimg.com/vi/${video}/hqdefault.jpg` }
          await put(tx, 'tracks', value)
          await put(tx, 'youtube', { trackId, videoId: video, saved: true, at: old?.at ?? timestamp(), order: old?.order ?? await sequence(tx) })
          return value
        }
        case 'youtube_tracks': {
          const rows = newest((await all<YouTubeRow>(tx, 'youtube')).filter((row) => row.saved))
          return Promise.all(rows.map(async (row) => {
            const value = await get<LibTrack>(tx, 'tracks', row.trackId)
            if (!value) throw new Error('Faltan los metadatos del vídeo guardado.')
            return { entryId: row.trackId, at: row.at, track: value }
          }))
        }
        case 'remove_youtube_track': {
          const trackId = integer(args.id, 'La canción de YouTube', YOUTUBE_BASE, PODCAST_BASE - 1)
          const row = await get<YouTubeRow>(tx, 'youtube', trackId)
          if (!row) throw new Error('No se encuentra esa canción de YouTube.')
          await put(tx, 'youtube', { ...row, saved: false })
          return
        }
      }
      throw new Error(`No se ha implementado el comando «${command}».`)
    })
  }

  async function rememberPodcasts(values: Podcast[]): Promise<void> {
    if (!Array.isArray(values)) throw new Error('La lista de pódcasts no es válida.')
    const normalized = values.map(podcast)
    await transaction('readwrite', async (tx) => {
      for (const value of normalized) {
        const old = await get<PodcastRow>(tx, 'podcasts', value.id)
        await put(tx, 'podcasts', { id: value.id, value, saved: old?.saved ?? false,
          at: old?.at ?? timestamp(), order: old?.order ?? await sequence(tx) })
      }
    })
  }
  async function readSourceChoice(trackId: number): Promise<SourceChoice | null> {
    const key = id(trackId)
    return transaction('readonly', async (tx) => (await get<SourceRow>(tx, 'sources', key))?.choice ?? null)
  }
  async function saveSourceChoice(trackId: number, choice: SourceChoice): Promise<void> {
    const key = id(trackId)
    const normalized = sourceChoice(choice)
    await transaction('readwrite', async (tx) => {
      const youtube = await get<YouTubeRow>(tx, 'youtube', key)
      if (youtube && youtube.videoId !== normalized.videoId) throw new Error('El vídeo de una canción de YouTube guardada no se puede sustituir.')
      await put(tx, 'sources', { trackId: key, choice: normalized })
    })
  }
  async function readYouTubeVideo(trackId: number): Promise<string | null> {
    const key = id(trackId)
    return transaction('readonly', async (tx) => (await get<YouTubeRow>(tx, 'youtube', key))?.videoId ?? null)
  }
  async function close(): Promise<void> {
    const pending = opening
    if (pending) await pending.catch(() => {})
    connection?.close()
    connection = undefined
  }
  return { storageInvoke, handlesStorage, rememberPodcasts, readSourceChoice, saveSourceChoice, readYouTubeVideo, close }
}

export const handlesStorage = (command: string): boolean => COMMANDS.has(command)
let defaultStorage: ReturnType<typeof createWebStorage> | undefined
const storage = () => defaultStorage ??= createWebStorage()
export async function storageInvoke(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return storage().storageInvoke(command, args)
}
export const rememberPodcasts = (values: Podcast[]): Promise<void> => storage().rememberPodcasts(values)
export const readSourceChoice = (trackId: number): Promise<SourceChoice | null> => storage().readSourceChoice(trackId)
export const saveSourceChoice = (trackId: number, choice: SourceChoice): Promise<void> => storage().saveSourceChoice(trackId, choice)
export const readYouTubeVideo = (trackId: number): Promise<string | null> => storage().readYouTubeVideo(trackId)
