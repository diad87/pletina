import type {
  Entry, LibTrack, LibraryData, PlaylistDetail, PlaylistSummary, Podcast,
  PodcastDetail, PodcastEpisode, PodcastProgress, SavedAlbum, SavedArtist,
} from '../src/lib/types'
import { BACKUP_LIMITS, BACKUP_MAX_ROWS, BACKUP_STORES, emptyBackupSummary, makeWebLibraryBackup, parseWebLibraryBackup,
  type BackupData, type BackupEnvelope, type BackupImportSummary, type BackupProgress } from './library-backup.ts'
import { normalizeTranscriptReferences, type TranscriptReference } from './podcast-transcripts.ts'
export { previewWebLibraryBackup } from './library-backup.ts'
export type { BackupEnvelope, BackupSummary, BackupImportSummary } from './library-backup.ts'

const DATABASE_VERSION = 2
const DEFAULT_DATABASE = 'pletina-web-library'
const YOUTUBE_BASE = 250_000_000_000_000
const PODCAST_BASE = 500_000_000_000_000
const EPISODE_BASE = 750_000_000_000_000
const LOCAL_BASE = 1_000_000_000_000_000
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/
const STORES = ['tracks', 'likes', 'albums', 'artists', 'podcasts', 'playlists',
  'entries', 'history', 'progress', 'youtube', 'sources', 'meta', 'episodes'] as const
type Store = typeof STORES[number]

const COMMANDS = new Set([
  'library', 'set_liked', 'liked_tracks', 'set_album_saved', 'set_artist_saved',
  'set_podcast_saved', 'create_playlist', 'rename_playlist', 'delete_playlist',
  'playlist', 'add_to_playlist', 'remove_from_playlist', 'move_in_playlist',
  'record_play', 'history', 'clear_history', 'podcast_progress',
  'save_podcast_progress', 'save_youtube_track', 'youtube_tracks', 'remove_youtube_track',
  'podcast_feed_url',
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
interface PodcastRow extends Timed<Podcast> { saved: boolean; episodeIds?: number[] }
interface EpisodeRow { id: number; podcastId: number; guid: string; value: PodcastEpisode; transcripts?: TranscriptReference[]; transcriptsChecked?: number }
interface YouTubeRow { trackId: number; videoId: string; saved: boolean; at: number; order: number }
interface SourceRow { trackId: number; choice: SourceChoice }
interface MetaRow { key: string; value: number }

export interface WebStorageOptions {
  /** Optional factory for a separate database or tests; production uses the browser's IndexedDB. */
  indexedDB?: IDBFactory
  name?: string
}

export type PodcastShowInput = Omit<Podcast, 'id'> & { id?: number }
export type PodcastEpisodeInput = Omit<PodcastEpisode, 'id'> & { id?: number; guid: string; transcripts?: TranscriptReference[]; transcriptsChecked?: number }
export interface PodcastDetailInput { podcast: PodcastShowInput; episodes: PodcastEpisodeInput[] }
export interface StoredPodcastEpisode extends PodcastEpisode { podcastId: number; feedUrl: string; guid: string }
export interface StoredPodcastTranscripts { feedUrl: string; guid: string; language: string | null; references: TranscriptReference[]; checked: boolean }

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
    ...(row.isrc !== undefined ? { isrc: nullableText(row.isrc, 'El ISRC') } : {}),
    ...(row.titleVersion !== undefined ? { titleVersion: nullableText(row.titleVersion, 'La versión') } : {}),
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
  const feedUrl = podcastFeed(row.feedUrl)
  return { id: integer(row.id, 'El identificador del pódcast', PODCAST_BASE + 1, EPISODE_BASE - 1),
    title: text(row.title, 'El título'), author: text(row.author, 'El autor', true),
    description: text(row.description, 'La descripción', true, 200_000), image: image(row.image), feedUrl,
    language: nullableText(row.language, 'El idioma'), episodeCount: integer(row.episodeCount, 'El número de episodios') }
}
function podcastFeed(value: unknown): string {
  const raw = text(value, 'La fuente del pódcast', false, 8192)
  if (/^youtube:[A-Za-z0-9_-]+$/.test(raw)) return raw
  const url = new URL(metadataURL(raw, 'La fuente del pódcast'))
  url.hash = ''
  return url.href
}
function podcastAudio(value: unknown): string {
  const raw = text(value, 'El audio del episodio', false, 16384)
  if (raw.startsWith('youtube:')) return 'youtube:' + videoId(raw.slice('youtube:'.length))
  let url: URL
  try { url = new URL(raw) } catch { throw new Error('El audio del episodio no es una dirección HTTP válida.') }
  // RSS enclosures are published source metadata (including provider query parameters).
  // Resolved YouTube stream addresses must remain in RAM; only youtube:<videoId> persists.
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
    || url.hostname === 'googlevideo.com' || url.hostname.endsWith('.googlevideo.com')) {
    throw new Error('El audio del episodio no es una fuente RSS o un identificador de YouTube válido.')
  }
  url.hash = ''
  return url.href
}
function podcastEpisode(value: unknown): { guid: string; value: PodcastEpisode; transcripts?: TranscriptReference[]; transcriptsChecked?: number } {
  const row = object(value, 'El episodio')
  return { guid: text(row.guid, 'La identidad del episodio', false, 16384),
    ...(row.transcripts !== undefined ? { transcripts: normalizeTranscriptReferences(row.transcripts),
      transcriptsChecked: integer(row.transcriptsChecked, 'La fecha de las transcripciones') } : {}), value: {
    id: 0, title: text(row.title, 'El título'), description: text(row.description, 'La descripción', true, 200_000),
    publishedAt: nullableText(row.publishedAt, 'La fecha'), duration: number(row.duration, 'La duración'),
    audioUrl: podcastAudio(row.audioUrl), image: image(row.image), explicit: boolean(row.explicit, 'El indicador de contenido explícito'),
  } }
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
        const podcasts = operation.transaction!.objectStore('podcasts')
        // Non-unique permits opening v1 databases that already contain duplicate feed metadata.
        // New writes are serialized and always reuse the first existing feed identity.
        if (!podcasts.indexNames.contains('feedUrl')) podcasts.createIndex('feedUrl', 'value.feedUrl')
        const episodes = operation.transaction!.objectStore('episodes')
        if (!episodes.indexNames.contains('identity')) episodes.createIndex('identity', ['podcastId', 'guid'], { unique: true })
        if (!episodes.indexNames.contains('podcastId')) episodes.createIndex('podcastId', 'podcastId')
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
  async function podcastId(tx: IDBTransaction, episode: boolean): Promise<number> {
    const base = episode ? EPISODE_BASE : PODCAST_BASE
    const end = episode ? LOCAL_BASE : EPISODE_BASE
    const counter = episode ? 'podcastEpisodeId' : 'podcastShowId'
    const previous = await get<MetaRow>(tx, 'meta', counter)
    const last = await request(tx.objectStore(episode ? 'episodes' : 'podcasts').openKeyCursor(undefined, 'prev'))
    let next = Math.max(base, previous?.value ?? base, typeof last?.key === 'number' ? last.key : base)
    for (;;) {
      ++next
      if (next >= end) throw new Error('No se pueden guardar más pódcasts o episodios.')
      // Old v1 progress/library rows have no episode identity table. Never assign one
      // of those occupied IDs to an unrelated new episode during the upgrade.
      if (episode && (await get(tx, 'progress', next) || await get(tx, 'tracks', next))) continue
      await put(tx, 'meta', { key: counter, value: next })
      return next
    }
  }
  async function showByFeed(tx: IDBTransaction, feedUrl: string): Promise<PodcastRow | undefined> {
    return request(tx.objectStore('podcasts').index('feedUrl').get(feedUrl)) as Promise<PodcastRow | undefined>
  }
  async function saveShow(tx: IDBTransaction, value: Podcast): Promise<PodcastRow> {
    const old = await showByFeed(tx, value.feedUrl)
    const row: PodcastRow = { ...old, id: old?.id ?? await podcastId(tx, false),
      value: { ...value, id: old?.id ?? 0, episodeCount: Math.max(value.episodeCount, old?.value.episodeCount ?? 0) },
      saved: old?.saved ?? false, at: old?.at ?? timestamp(), order: old?.order ?? await sequence(tx) }
    row.value.id = row.id
    await put(tx, 'podcasts', row)
    return row
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
  async function upsertTrack(tx: IDBTransaction, value: LibTrack): Promise<void> {
    // Like the APK's upsert_track: queue/library copies cannot undo a saved
    // YouTube edit. Only save_youtube_track explicitly replaces that metadata.
    const previous = await get<LibTrack>(tx, 'tracks', value.id)
    if (value.id >= YOUTUBE_BASE && value.id < PODCAST_BASE && previous) return
    // A queue saved before these optional fields existed must not erase a
    // recording identifier learned later from the catalog.
    await put(tx, 'tracks', { ...value,
      ...(value.isrc === undefined && previous?.isrc !== undefined ? { isrc: previous.isrc } : {}),
      ...(value.titleVersion === undefined && previous?.titleVersion !== undefined ? { titleVersion: previous.titleVersion } : {}),
    })
  }
  async function append(tx: IDBTransaction, playlistId: number, values: LibTrack[]) {
    const row = await requirePlaylist(tx, playlistId)
    const existing = await request(tx.objectStore('entries').index('playlistId').getAll(playlistId)) as EntryRow[]
    let position = existing.reduce((max, entry) => Math.max(max, entry.position), -1) + 1
    for (const value of values) {
      await upsertTrack(tx, value)
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
    const readonly = ['library', 'liked_tracks', 'playlist', 'history', 'podcast_progress', 'podcast_feed_url', 'youtube_tracks'].includes(command)
    return transaction(readonly ? 'readonly' : 'readwrite', async (tx) => {
      switch (command) {
        case 'library': {
          const [liked, albums, artists, podcasts, lists] = await Promise.all([
            all<LikeRow>(tx, 'likes'), all<Timed<SavedAlbum>>(tx, 'albums'), all<Timed<SavedArtist>>(tx, 'artists'),
            all<PodcastRow>(tx, 'podcasts'), all<PlaylistRow>(tx, 'playlists'),
          ])
          const data: LibraryData = { likedIds: newest(liked).map((row) => row.trackId), downloadedIds: [],
            albums: newest(albums).map((row) => row.value), artists: newest(artists).map((row) => row.value),
            podcasts: await Promise.all(newest(podcasts.filter((row) => row.saved)).map(async (row) => {
              const known = await request(tx.objectStore('episodes').index('podcastId').count(row.id))
              return { ...row.value, episodeCount: known || row.value.episodeCount }
            })),
            playlists: await Promise.all(newest(lists).map(async (row) => summary(row, await entries(tx, row.id)))) }
          return data
        }
        case 'set_liked': {
          const liked = boolean(args.liked, 'El estado de favorito')
          const trackId = id(object(args.track, 'La canción').id)
          if (!liked) { await remove(tx, 'likes', trackId); return }
          const value = track(args.track)
          await upsertTrack(tx, value)
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
          const podcastId = integer(args.id, 'El pódcast', PODCAST_BASE + 1, EPISODE_BASE - 1)
          const saved = boolean(args.saved, 'El estado de guardado')
          const row = await get<PodcastRow>(tx, 'podcasts', podcastId)
          if (!row) throw new Error('No se han cargado los metadatos de este pódcast. Ábrelo y vuelve a intentarlo.')
          await put(tx, 'podcasts', { ...row, saved, order: saved && !row.saved ? await sequence(tx) : row.order })
          return
        }
        case 'podcast_feed_url': {
          const row = await get<PodcastRow>(tx, 'podcasts', integer(args.id, 'El pódcast', PODCAST_BASE + 1, EPISODE_BASE - 1))
          if (!row) throw new Error('No se encuentra este pódcast en la biblioteca.')
          return row.value.feedUrl
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
          await upsertTrack(tx, value)
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
        case 'save_podcast_progress': await put(tx, 'progress', { ...progress(args.progress), updatedAt: timestamp() }); return
        case 'podcast_progress': {
          if (!Array.isArray(args.ids)) throw new Error('La lista de episodios no es válida.')
          const ids = args.ids.map((value) => integer(value, 'El episodio', EPISODE_BASE, LOCAL_BASE - 1))
          const rows = await Promise.all(ids.map((episode) => get<PodcastProgress>(tx, 'progress', episode)))
          return rows.filter((row): row is PodcastProgress => Boolean(row)).map(progress)
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
        await put(tx, 'podcasts', { ...old, id: value.id, value, saved: old?.saved ?? false,
          at: old?.at ?? timestamp(), order: old?.order ?? await sequence(tx) })
      }
    })
  }
  async function savePodcastShows(values: PodcastShowInput[]): Promise<Podcast[]> {
    if (!Array.isArray(values)) throw new Error('La lista de pódcasts no es válida.')
    const normalized = values.map((value) => podcast({ ...object(value, 'El pódcast'), id: PODCAST_BASE + 1 }))
    return transaction('readwrite', async (tx) => {
      const result: Podcast[] = []
      for (const value of normalized) result.push((await saveShow(tx, value)).value)
      return result
    })
  }
  async function savePodcastDetail(detail: PodcastDetailInput): Promise<PodcastDetail> {
    const input = object(detail, 'La ficha del pódcast')
    const normalized = podcast({ ...object(input.podcast, 'El pódcast'), id: PODCAST_BASE + 1 })
    if (!Array.isArray(input.episodes)) throw new Error('La lista de episodios no es válida.')
    const candidates = input.episodes.map(podcastEpisode)
    return transaction('readwrite', async (tx) => {
      const row = await saveShow(tx, normalized)
      const episodes: PodcastEpisode[] = [], seen = new Set<string>()
      for (const candidate of candidates) {
        if (seen.has(candidate.guid)) continue
        seen.add(candidate.guid)
        const previous = await request(tx.objectStore('episodes').index('identity').get([row.id, candidate.guid])) as EpisodeRow | undefined
        const value = { ...candidate.value, id: previous?.id ?? await podcastId(tx, true) }
        await put(tx, 'episodes', { ...previous, id: value.id, podcastId: row.id, guid: candidate.guid, value,
          ...(candidate.transcripts !== undefined ? { transcripts: candidate.transcripts, transcriptsChecked: candidate.transcriptsChecked } : {}) } satisfies EpisodeRow)
        await put(tx, 'tracks', { id: value.id, title: value.title, duration: value.duration, explicit: value.explicit,
          artistId: row.id, artistName: row.value.author || row.value.title, albumId: row.id,
          albumTitle: row.value.title, albumArtistId: row.id, cover: value.image ?? row.value.image } satisfies LibTrack)
        episodes.push(value)
      }
      row.episodeIds = episodes.map((value) => value.id)
      row.value.episodeCount = episodes.length
      await put(tx, 'podcasts', row)
      return { podcast: row.value, episodes }
    })
  }
  async function readPodcastFeedUrl(showId: number): Promise<string | null> {
    const key = integer(showId, 'El pódcast', PODCAST_BASE + 1, EPISODE_BASE - 1)
    return transaction('readonly', async (tx) => (await get<PodcastRow>(tx, 'podcasts', key))?.value.feedUrl ?? null)
  }
  async function readPodcastEpisode(episodeId: number): Promise<StoredPodcastEpisode | null> {
    const key = integer(episodeId, 'El episodio', EPISODE_BASE + 1, LOCAL_BASE - 1)
    return transaction('readonly', async (tx) => {
      const row = await get<EpisodeRow>(tx, 'episodes', key)
      if (!row) return null
      const show = await get<PodcastRow>(tx, 'podcasts', row.podcastId)
      if (!show) throw new Error('No se encuentran los metadatos del programa de este episodio.')
      return { ...row.value, podcastId: row.podcastId, feedUrl: show.value.feedUrl, guid: row.guid }
    })
  }
  async function readPodcastDetail(feedUrl: string): Promise<PodcastDetail | null> {
    const feed = podcastFeed(feedUrl)
    return transaction('readonly', async (tx) => {
      const row = await showByFeed(tx, feed)
      if (!row) return null
      const episodes = await Promise.all((row.episodeIds ?? []).map(async (key) => {
        const episode = await get<EpisodeRow>(tx, 'episodes', key)
        if (!episode) throw new Error('Faltan los metadatos de un episodio del programa.')
        return episode.value
      }))
      return { podcast: row.value, episodes }
    })
  }
  async function readPodcastTranscripts(episodeId: number): Promise<StoredPodcastTranscripts | null> {
    if (!Number.isSafeInteger(episodeId) || episodeId <= EPISODE_BASE || episodeId >= LOCAL_BASE) return null
    return transaction('readonly', async tx => {
      const row = await get<EpisodeRow>(tx, 'episodes', episodeId)
      if (!row) return null
      const show = await get<PodcastRow>(tx, 'podcasts', row.podcastId)
      if (!show) throw new Error('No se encuentran los metadatos del programa de este episodio.')
      const checked = row.transcriptsChecked ?? 0, now = Date.now()
      return { feedUrl: show.value.feedUrl, guid: row.guid, language: show.value.language,
        references: normalizeTranscriptReferences(row.transcripts), checked: checked > now - 600_000 && checked <= now + 60_000 }
    })
  }
  async function savePodcastTranscripts(episodeId: number, references: TranscriptReference[], checked = Date.now()): Promise<void> {
    const key = integer(episodeId, 'El episodio', EPISODE_BASE + 1, LOCAL_BASE - 1)
    const normalized = normalizeTranscriptReferences(references)
    integer(checked, 'La fecha de las transcripciones')
    // A targeted RSS refresh must never replace the visible episode list or IDs.
    await transaction('readwrite', async tx => {
      const row = await get<EpisodeRow>(tx, 'episodes', key)
      if (!row) return
      await put(tx, 'episodes', { ...row, transcripts: normalized, transcriptsChecked: checked } satisfies EpisodeRow)
    })
  }
  async function readSourceChoice(trackId: number): Promise<SourceChoice | null> {
    const key = id(trackId)
    return transaction('readonly', async (tx) => (await get<SourceRow>(tx, 'sources', key))?.choice ?? null)
  }
  async function readStoredTrack(trackId: number): Promise<LibTrack | null> {
    // Downloads need the editor's current YouTube metadata, including hidden
    // entries. Other namespaces keep their own snapshot without opening this DB.
    if (!Number.isSafeInteger(trackId) || trackId < YOUTUBE_BASE || trackId >= PODCAST_BASE) return null
    return transaction('readonly', async (tx) => {
      const value = await get<LibTrack>(tx, 'tracks', trackId)
      return value ? track(value) : null
    })
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
  async function readBackupRows(tx: IDBTransaction): Promise<BackupData> {
    const values = await Promise.all(BACKUP_STORES.map(async store => [store, await all(tx, store)] as const))
    return Object.fromEntries(values) as unknown as BackupData
  }
  async function exportBackup(): Promise<BackupEnvelope> {
    // The same read-only transaction snapshots every related store. Validation
    // happens before returning a file, including legacy metadata and RSS URLs.
    return transaction('readonly', async tx => makeWebLibraryBackup(await readBackupRows(tx)))
  }
  async function importBackup(input: unknown): Promise<BackupImportSummary> {
    // Parse, bound and validate every reference before opening a write transaction.
    const incoming = parseWebLibraryBackup(input).library
    return transaction('readwrite', async tx => {
      const current = await readBackupRows(tx)
      const changed = emptyBackupSummary()
      const sizes = Object.fromEntries(BACKUP_STORES.map(key => [key, current[key].length])) as BackupImportSummary
      let total = Object.values(sizes).reduce((sum, size) => sum + size, 0)
      const adding = (store: keyof BackupData) => {
        if (++sizes[store] > BACKUP_LIMITS[store] || ++total > BACKUP_MAX_ROWS) throw new Error('La biblioteca combinada supera el límite de la copia de seguridad. No se ha cambiado la biblioteca.')
        changed[store]++
      }
      const ascending = <T extends { order: number }>(values: T[]) => [...values].sort((a, b) => a.order - b.order)
      // Destination counters are authoritative. Repair a stale lower counter
      // from destination rows; no imported counter can choose an allocation.
      const ordered = [...current.likes, ...current.albums, ...current.artists, ...current.podcasts, ...current.playlists, ...current.youtube]
      const metaOrder = (await get<MetaRow>(tx, 'meta', 'order'))?.value ?? 0
      const order = ordered.reduce((maximum, value) => Math.max(maximum, value.order), Math.max(metaOrder, 0))
      integer(order, 'El contador local')
      await put(tx, 'meta', { key: 'order', value: order })
      const metaYouTube = (await get<MetaRow>(tx, 'meta', 'youtubeId'))?.value ?? YOUTUBE_BASE
      const lastYouTube = current.tracks.filter(value => value.id >= YOUTUBE_BASE && value.id < PODCAST_BASE)
        .reduce((maximum, value) => Math.max(maximum, value.id), current.youtube.reduce((maximum, value) => Math.max(maximum, value.trackId), Math.max(metaYouTube, YOUTUBE_BASE)))
      integer(lastYouTube, 'El contador local de YouTube', YOUTUBE_BASE, PODCAST_BASE - 1)
      await put(tx, 'meta', { key: 'youtubeId', value: lastYouTube })

      const trackIds = new Map<number, number>(), showIds = new Map<number, number>()
      const localTracks = new Map(current.tracks.map(value => [value.id, value]))
      const videos = new Map(current.youtube.map(value => [value.videoId, value]))
      const localShows = new Map(current.podcasts.map(value => [value.value.feedUrl, value]))
      const episodes = new Map(current.episodes.map(value => [JSON.stringify([value.podcastId, value.guid]), value]))
      for (const value of ascending(incoming.youtube)) {
        const local = videos.get(value.videoId)
        if (local) {
          trackIds.set(value.trackId, local.trackId)
          if (value.saved && !local.saved) { local.saved = true; await put(tx, 'youtube', local); changed.youtube++ }
        } else {
          const trackId = await sequence(tx, 'youtubeId', YOUTUBE_BASE)
          if (trackId >= PODCAST_BASE) throw new Error('No se pueden guardar más vídeos de YouTube.')
          const saved = { ...value, trackId, order: await sequence(tx) }
          adding('youtube'); await put(tx, 'youtube', saved); videos.set(value.videoId, saved); trackIds.set(value.trackId, trackId)
        }
      }
      for (const value of ascending(incoming.podcasts)) {
        const local = localShows.get(value.value.feedUrl)
        if (local) {
          showIds.set(value.id, local.id)
          if (value.saved && !local.saved) { local.saved = true; await put(tx, 'podcasts', local); changed.podcasts++ }
        } else {
          const showId = await podcastId(tx, false)
          const saved: PodcastRow = { ...value, id: showId, value: { ...value.value, id: showId }, episodeIds: [], order: await sequence(tx) }
          adding('podcasts'); await put(tx, 'podcasts', saved); localShows.set(value.value.feedUrl, saved); showIds.set(value.id, showId)
        }
      }
      for (const value of incoming.episodes) {
        const showId = showIds.get(value.podcastId)!, key = JSON.stringify([showId, value.guid]), local = episodes.get(key)
        if (local) trackIds.set(value.id, local.id)
        else {
          const episodeId = await podcastId(tx, true)
          const saved: EpisodeRow = { ...value, id: episodeId, podcastId: showId, value: { ...value.value, id: episodeId } }
          adding('episodes'); await put(tx, 'episodes', saved); episodes.set(key, saved); trackIds.set(value.id, episodeId)
        }
      }
      const remap = (value: number) => trackIds.get(value) ?? showIds.get(value) ?? value
      for (const value of incoming.tracks) {
        const trackId = remap(value.id)
        trackIds.set(value.id, trackId)
        if (localTracks.has(trackId)) continue
        const saved: LibTrack = { ...value, id: trackId, artistId: remap(value.artistId), albumId: remap(value.albumId), albumArtistId: remap(value.albumArtistId) }
        adding('tracks'); await put(tx, 'tracks', saved); localTracks.set(trackId, saved)
      }
      // Keep existing feed order and metadata, appending only previously unknown
      // episode identities. Old episodes outside the current RSS remain durable.
      for (const value of incoming.podcasts) {
        const saved = localShows.get(value.value.feedUrl)!
        const ids = [...new Set([...(saved.episodeIds ?? []), ...(value.episodeIds ?? []).map(id => trackIds.get(id)!)])]
        if (value.episodeIds !== undefined && ids.length !== (saved.episodeIds?.length ?? 0)) {
          saved.episodeIds = ids
          saved.value = { ...saved.value, episodeCount: Math.max(saved.value.episodeCount, ids.length) }
          await put(tx, 'podcasts', saved)
        }
      }
      const likes = new Set(current.likes.map(value => value.trackId))
      for (const value of ascending(incoming.likes)) {
        const trackId = trackIds.get(value.trackId)!
        if (likes.has(trackId)) continue
        adding('likes'); await put(tx, 'likes', { ...value, trackId, order: await sequence(tx) }); likes.add(trackId)
      }
      const mergeTimed = async (store: 'albums' | 'artists') => {
        const ids = new Set(current[store].map(value => value.id))
        for (const value of ascending(incoming[store] as { id: number; order: number }[])) {
          if (ids.has(value.id)) continue
          adding(store); await put(tx, store, { ...value, order: await sequence(tx) }); ids.add(value.id)
        }
      }
      await mergeTimed('albums'); await mergeTimed('artists')
      const sources = new Map(current.sources.map(value => [value.trackId, value]))
      for (const value of incoming.sources) {
        const trackId = trackIds.get(value.trackId)!
        if (sources.has(trackId)) continue
        const saved = { ...value, trackId }
        adding('sources'); await put(tx, 'sources', saved); sources.set(trackId, saved)
      }
      const positions = new Map(current.progress.map(value => [value.id, value]))
      for (const value of incoming.progress) {
        const episodeId = trackIds.get(value.id)!, local = positions.get(episodeId)
        // Old rows have no modification timestamp: a larger playback position
        // does not establish recency. An unknown local timestamp always wins.
        if (local && (local.updatedAt === undefined || value.updatedAt === undefined || value.updatedAt <= local.updatedAt)) continue
        if (local) changed.progress++; else adding('progress')
        const saved: BackupProgress = { ...value, id: episodeId }
        await put(tx, 'progress', saved); positions.set(episodeId, saved)
      }
      const histories = new Map<string, number>(), incomingHistories = new Map<string, number>()
      for (const value of current.history) {
        const key = JSON.stringify([value.trackId, value.at])
        histories.set(key, (histories.get(key) ?? 0) + 1)
      }
      for (const value of incoming.history) {
        const trackId = trackIds.get(value.trackId)!, key = JSON.stringify([trackId, value.at])
        const seen = (incomingHistories.get(key) ?? 0) + 1
        incomingHistories.set(key, seen)
        if (seen <= (histories.get(key) ?? 0)) continue
        adding('history'); await request(tx.objectStore('history').add({ trackId, at: value.at }))
      }
      const names = new Set(current.playlists.map(value => value.name))
      for (const value of ascending(incoming.playlists)) {
        let name = value.name
        if (names.has(name)) {
          const base = [...name].slice(0, 88).join('')
          name = base + ' (importada)'
          let suffix = 2
          while (names.has(name)) name = [...base].slice(0, 80).join('') + ` (importada ${suffix++})`
        }
        adding('playlists')
        const playlistId = await request(tx.objectStore('playlists').add({ name, order: await sequence(tx) })) as number
        names.add(name)
        const entries = incoming.entries.filter(entry => entry.playlistId === value.id).sort((a, b) => a.position - b.position)
        for (const entry of entries) {
          adding('entries')
          await request(tx.objectStore('entries').add({ playlistId, trackId: trackIds.get(entry.trackId)!, position: entry.position, at: entry.at }))
        }
      }
      return changed
    })
  }
  async function close(): Promise<void> {
    const pending = opening
    if (pending) await pending.catch(() => {})
    connection?.close()
    connection = undefined
  }
  return { storageInvoke, handlesStorage, rememberPodcasts, savePodcastShows, savePodcastDetail,
    readPodcastFeedUrl, readPodcastEpisode, readPodcastDetail, readPodcastTranscripts, savePodcastTranscripts, readStoredTrack, readSourceChoice, saveSourceChoice, readYouTubeVideo, exportBackup, importBackup, close }
}

export const handlesStorage = (command: string): boolean => COMMANDS.has(command)
let defaultStorage: ReturnType<typeof createWebStorage> | undefined
const storage = () => defaultStorage ??= createWebStorage()
export async function storageInvoke(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return storage().storageInvoke(command, args)
}
export const rememberPodcasts = (values: Podcast[]): Promise<void> => storage().rememberPodcasts(values)
export const savePodcastShows = (values: PodcastShowInput[]): Promise<Podcast[]> => storage().savePodcastShows(values)
export const savePodcastDetail = (detail: PodcastDetailInput): Promise<PodcastDetail> => storage().savePodcastDetail(detail)
export const readPodcastFeedUrl = (showId: number): Promise<string | null> => storage().readPodcastFeedUrl(showId)
export const readPodcastEpisode = (episodeId: number): Promise<StoredPodcastEpisode | null> => storage().readPodcastEpisode(episodeId)
export const readPodcastDetail = (feedUrl: string): Promise<PodcastDetail | null> => storage().readPodcastDetail(feedUrl)
export const readPodcastTranscripts = (episodeId: number): Promise<StoredPodcastTranscripts | null> => storage().readPodcastTranscripts(episodeId)
export const savePodcastTranscripts = (episodeId: number, references: TranscriptReference[], checked?: number): Promise<void> => storage().savePodcastTranscripts(episodeId, references, checked)
export const readStoredTrack = (trackId: number): Promise<LibTrack | null> => storage().readStoredTrack(trackId)
export const readSourceChoice = (trackId: number): Promise<SourceChoice | null> => storage().readSourceChoice(trackId)
export const saveSourceChoice = (trackId: number, choice: SourceChoice): Promise<void> => storage().saveSourceChoice(trackId, choice)
export const readYouTubeVideo = (trackId: number): Promise<string | null> => storage().readYouTubeVideo(trackId)
export const exportWebLibrary = (): Promise<BackupEnvelope> => storage().exportBackup()
export const importWebLibraryBackup = (input: unknown): Promise<BackupImportSummary> => storage().importBackup(input)
