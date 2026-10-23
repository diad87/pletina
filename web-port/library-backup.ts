import type { LibTrack, Podcast, PodcastEpisode, PodcastProgress, SavedAlbum, SavedArtist } from '../src/lib/types'

// Metadata only. No media/cache, playback queue, preferences or origin-specific paths.
export const BACKUP_MAX_BYTES = 10 * 1024 * 1024
export const BACKUP_MAX_ROWS = 100_000
const YOUTUBE = 250_000_000_000_000, SHOW = 500_000_000_000_000, EPISODE = 750_000_000_000_000, LOCAL = 1_000_000_000_000_000
const MAX_SECONDS = 31 * 24 * 60 * 60
const MAX_DATE = 32_503_680_000
export interface BackupTimed<T> { id: number; value: T; at: number; order: number }
export interface BackupLike { trackId: number; at: number; order: number }
export interface BackupPlaylist { id: number; name: string; order: number }
export interface BackupEntry { entryId: number; playlistId: number; trackId: number; position: number; at: number }
export interface BackupHistory { entryId: number; trackId: number; at: number }
export interface BackupPodcast extends BackupTimed<Podcast> { saved: boolean; episodeIds?: number[] }
export interface BackupEpisode { id: number; podcastId: number; guid: string; value: PodcastEpisode }
export interface BackupProgress extends PodcastProgress { updatedAt?: number }
export interface BackupYouTube { trackId: number; videoId: string; saved: boolean; at: number; order: number }
export interface BackupSource { trackId: number; choice: { videoId: string; title: string; channel: string; duration: number | null; score: number; verified: boolean } }
export interface BackupData {
  tracks: LibTrack[]; likes: BackupLike[]; albums: BackupTimed<SavedAlbum>[]; artists: BackupTimed<SavedArtist>[]
  podcasts: BackupPodcast[]; playlists: BackupPlaylist[]; entries: BackupEntry[]; history: BackupHistory[]
  progress: BackupProgress[]; youtube: BackupYouTube[]; sources: BackupSource[]; episodes: BackupEpisode[]
}
export interface BackupEnvelope { format: 'pletina-library'; version: 1; createdAt: string; library: BackupData }
export type BackupSummary = { [K in keyof BackupData]: number }
export type BackupImportSummary = BackupSummary
export const BACKUP_STORES = ['tracks', 'likes', 'albums', 'artists', 'podcasts', 'playlists', 'entries', 'history', 'progress', 'youtube', 'sources', 'episodes'] as const
export const BACKUP_LIMITS: Readonly<BackupSummary> = { tracks: 20_000, likes: 20_000, albums: 10_000, artists: 10_000,
  podcasts: 5_000, playlists: 1_000, entries: 20_000, history: 50_000, progress: 20_000, youtube: 20_000, sources: 20_000, episodes: 20_000 }
const fail = (detail: string): never => { throw new Error(`La copia de seguridad no es válida: ${detail}. No se ha cambiado la biblioteca.`) }
const row = (value: unknown, keys: readonly string[], strict: boolean): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail('se esperaba un objeto JSON')
  const result = value as Record<string, unknown>
  if (strict && Object.keys(result).some(key => !keys.includes(key))) return fail('contiene campos no admitidos')
  return result
}
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : fail('identificador o contador fuera de rango')
const id = (value: unknown) => integer(value, 1, LOCAL - 1)
const seconds = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_SECONDS ? value : fail('duración o posición fuera de rango')
const flag = (value: unknown): boolean => typeof value === 'boolean' ? value : fail('indicador no válido')
const text = (value: unknown, max = 4000, empty = false): string => typeof value === 'string' && value.length <= max && (empty || value.trim()) ? value.trim() : fail('texto no válido o demasiado largo')
const nullable = (value: unknown, max = 4000) => value === null ? null : text(value, max, true)
const video = (value: unknown): string => typeof value === 'string' && /^[A-Za-z0-9_-]{11}$/.test(value) ? value : fail('vídeo no válido')
function stableURL(value: unknown): string {
  const raw = text(value, 16384)
  let url: URL
  try { url = new URL(raw) } catch { return fail('dirección de metadatos no válida') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hostname === 'googlevideo.com' || url.hostname.endsWith('.googlevideo.com') ||
    [...url.searchParams.keys()].some(key => /^(?:sig|lsig|signature|token|access_token|authorization|expires?|policy|key-pair-id|x-amz-(?:signature|credential)|x-goog-(?:signature|credential))$/i.test(key))) {
    return fail('incluye una dirección temporal o con credenciales; actualiza sus metadatos antes de exportarla')
  }
  return url.href
}
const image = (value: unknown) => value === null || value === '' ? null : stableURL(value)
const feed = (value: unknown) => {
  if (typeof value === 'string' && /^youtube:[A-Za-z0-9_-]+$/.test(value)) return text(value, 8192)
  const url = new URL(stableURL(value)); url.hash = ''; return url.href
}
const audio = (value: unknown) => typeof value === 'string' && value.startsWith('youtube:') ? 'youtube:' + video(value.slice(8)) : stableURL(value)
function normalizeData(input: unknown, strict: boolean): BackupData {
  const library = row(input, BACKUP_STORES, strict)
  let total = 0
  for (const key of BACKUP_STORES) {
    const values = library[key]
    if (!Array.isArray(values) || values.length > BACKUP_LIMITS[key]) return fail(`el apartado ${key} supera su límite o no es una lista`)
    total += values.length
  }
  if (total > BACKUP_MAX_ROWS) return fail('supera las 100.000 filas de metadatos')
  const list = <T>(key: keyof BackupData, normalize: (value: unknown) => T) => (library[key] as unknown[]).map(normalize)
  const timed = <T>(value: unknown, normalize: (value: unknown) => T): BackupTimed<T> => {
    const r = row(value, ['id', 'value', 'at', 'order'], strict)
    return { id: id(r.id), value: normalize(r.value), at: integer(r.at, 0, MAX_DATE), order: integer(r.order, 1) }
  }
  const data: BackupData = {
    tracks: list('tracks', value => {
      const r = row(value, ['id', 'title', 'duration', 'explicit', 'artistId', 'artistName', 'albumId', 'albumTitle', 'albumArtistId', 'cover', 'isrc', 'titleVersion'], strict)
      return { id: id(r.id), title: text(r.title), duration: seconds(r.duration), explicit: flag(r.explicit), artistId: integer(r.artistId, 0, LOCAL - 1),
        artistName: text(r.artistName, 4000, true), albumId: integer(r.albumId, 0, LOCAL - 1), albumTitle: text(r.albumTitle, 4000, true),
        albumArtistId: integer(r.albumArtistId, 0, LOCAL - 1), cover: image(r.cover),
        ...(r.isrc === undefined ? {} : { isrc: nullable(r.isrc, 100) }), ...(r.titleVersion === undefined ? {} : { titleVersion: nullable(r.titleVersion) }) }
    }),
    likes: list('likes', value => { const r = row(value, ['trackId', 'at', 'order'], strict); return { trackId: id(r.trackId), at: integer(r.at, 0, MAX_DATE), order: integer(r.order, 1) } }),
    albums: list('albums', value => timed(value, value => {
      const r = row(value, ['id', 'title', 'artistId', 'artistName', 'cover', 'releaseDate', 'recordType'], strict)
      return { id: integer(r.id, 1, YOUTUBE - 1), title: text(r.title), artistId: integer(r.artistId), artistName: text(r.artistName, 4000, true),
        cover: image(r.cover), releaseDate: nullable(r.releaseDate), recordType: nullable(r.recordType) }
    })),
    artists: list('artists', value => timed(value, value => { const r = row(value, ['id', 'name', 'picture'], strict); return { id: integer(r.id, 1, YOUTUBE - 1), name: text(r.name), picture: image(r.picture) } })),
    podcasts: list('podcasts', value => {
      const r = row(value, ['id', 'value', 'at', 'order', 'saved', 'episodeIds'], strict), v = row(r.value, ['id', 'title', 'author', 'description', 'image', 'feedUrl', 'language', 'episodeCount'], strict)
      const podcast: BackupPodcast = { id: integer(r.id, SHOW + 1, EPISODE - 1), at: integer(r.at, 0, MAX_DATE), order: integer(r.order, 1), saved: flag(r.saved),
        value: { id: integer(v.id, SHOW + 1, EPISODE - 1), title: text(v.title), author: text(v.author, 4000, true), description: text(v.description, 200_000, true),
          image: image(v.image), feedUrl: feed(v.feedUrl), language: nullable(v.language), episodeCount: integer(v.episodeCount, 0, 1_000_000) } }
      if (r.episodeIds !== undefined) {
        if (!Array.isArray(r.episodeIds) || r.episodeIds.length > 20_000) return fail('episodios del programa no válidos')
        podcast.episodeIds = r.episodeIds.map(value => integer(value, EPISODE + 1, LOCAL - 1))
      }
      return podcast
    }),
    playlists: list('playlists', value => {
      const r = row(value, ['id', 'name', 'order'], strict), name = text(r.name, 400)
      if ([...name].length > 100) return fail('nombre de playlist demasiado largo')
      return { id: id(r.id), name, order: integer(r.order, 1) }
    }),
    entries: list('entries', value => { const r = row(value, ['entryId', 'playlistId', 'trackId', 'position', 'at'], strict); return { entryId: id(r.entryId), playlistId: id(r.playlistId), trackId: id(r.trackId), position: integer(r.position, 0, 20_000), at: integer(r.at, 0, MAX_DATE) } }),
    history: list('history', value => { const r = row(value, ['entryId', 'trackId', 'at'], strict); return { entryId: id(r.entryId), trackId: id(r.trackId), at: integer(r.at, 0, MAX_DATE) } }),
    progress: list('progress', value => {
      const r = row(value, ['id', 'position', 'duration', 'completed', 'updatedAt'], strict), duration = seconds(r.duration), position = seconds(r.position)
      if (duration > 0 && position > duration) return fail('posición de episodio mayor que su duración')
      return { id: integer(r.id, EPISODE + 1, LOCAL - 1), position, duration, completed: flag(r.completed),
        ...(r.updatedAt === undefined ? {} : { updatedAt: integer(r.updatedAt, 0, MAX_DATE) }) }
    }),
    youtube: list('youtube', value => { const r = row(value, ['trackId', 'videoId', 'saved', 'at', 'order'], strict); return { trackId: integer(r.trackId, YOUTUBE + 1, SHOW - 1), videoId: video(r.videoId), saved: flag(r.saved), at: integer(r.at, 0, MAX_DATE), order: integer(r.order, 1) } }),
    sources: list('sources', value => {
      const r = row(value, ['trackId', 'choice'], strict), c = row(r.choice, ['videoId', 'title', 'channel', 'duration', 'score', 'verified'], strict)
      if (typeof c.score !== 'number' || !Number.isFinite(c.score) || Math.abs(c.score) > 1_000_000) return fail('puntuación de fuente no válida')
      return { trackId: id(r.trackId), choice: { videoId: video(c.videoId), title: text(c.title, 4000, true), channel: text(c.channel, 4000, true),
        duration: c.duration === null ? null : seconds(c.duration), score: c.score, verified: flag(c.verified) } }
    }),
    episodes: list('episodes', value => {
      const r = row(value, ['id', 'podcastId', 'guid', 'value'], strict), v = row(r.value, ['id', 'title', 'description', 'publishedAt', 'duration', 'audioUrl', 'image', 'explicit'], strict)
      return { id: integer(r.id, EPISODE + 1, LOCAL - 1), podcastId: integer(r.podcastId, SHOW + 1, EPISODE - 1), guid: text(r.guid, 16384),
        value: { id: integer(v.id, EPISODE + 1, LOCAL - 1), title: text(v.title), description: text(v.description, 200_000, true), publishedAt: nullable(v.publishedAt),
          duration: seconds(v.duration), audioUrl: audio(v.audioUrl), image: image(v.image), explicit: flag(v.explicit) } }
    }),
  }
  const unique = <T>(values: T[], key: (value: T) => string | number) => {
    const result = new Set<string | number>()
    for (const value of values) { const k = key(value); if (result.has(k)) return fail('identidades duplicadas'); result.add(k) }
    return result
  }
  const tracks = unique(data.tracks, value => value.id), lists = unique(data.playlists, value => value.id), shows = unique(data.podcasts, value => value.id)
  const youtube = new Map(data.youtube.map(value => [value.trackId, value])), episodes = new Map(data.episodes.map(value => [value.id, value]))
  unique(data.likes, value => value.trackId); unique(data.albums, value => value.id); unique(data.artists, value => value.id)
  unique(data.entries, value => value.entryId); unique(data.history, value => value.entryId); unique(data.progress, value => value.id)
  unique(data.youtube, value => value.trackId); unique(data.youtube, value => value.videoId); unique(data.sources, value => value.trackId)
  unique(data.podcasts, value => value.value.feedUrl); unique(data.episodes, value => value.id)
  unique(data.episodes, value => JSON.stringify([value.podcastId, value.guid]))
  const reference = (exists: boolean) => { if (!exists) return fail('faltan metadatos referenciados o hay identidades incompatibles') }
  for (const value of data.tracks) {
    if (value.id >= YOUTUBE && value.id < SHOW) reference(youtube.has(value.id))
    else if (value.id >= SHOW) {
      if (!episodes.has(value.id)) return fail('falta la identidad de un episodio; abre y actualiza el pódcast antes de volver a exportar')
    } else reference(value.id < YOUTUBE)
  }
  for (const value of data.likes) reference(tracks.has(value.trackId))
  for (const value of data.albums) reference(value.id === value.value.id)
  for (const value of data.artists) reference(value.id === value.value.id)
  for (const value of data.youtube) reference(tracks.has(value.trackId))
  for (const value of data.sources) reference(tracks.has(value.trackId) && (!youtube.has(value.trackId) || youtube.get(value.trackId)!.videoId === value.choice.videoId))
  for (const value of data.history) reference(tracks.has(value.trackId))
  for (const value of data.entries) reference(tracks.has(value.trackId) && lists.has(value.playlistId))
  for (const value of data.episodes) reference(value.id === value.value.id && shows.has(value.podcastId) && tracks.has(value.id))
  for (const value of data.progress) if (!episodes.has(value.id)) return fail('falta la identidad de un episodio; abre y actualiza el pódcast antes de volver a exportar')
  for (const value of data.podcasts) {
    reference(value.id === value.value.id)
    unique(value.episodeIds ?? [], id => id)
    for (const episodeId of value.episodeIds ?? []) reference(episodes.get(episodeId)?.podcastId === value.id)
  }
  for (const value of data.playlists) {
    const positions = data.entries.filter(entry => entry.playlistId === value.id).map(entry => entry.position).sort((a, b) => a - b)
    reference(positions.every((position, i) => position === i))
  }
  return data
}
function size(value: unknown): void {
  let serialized: string | undefined
  try { serialized = JSON.stringify(value) } catch { return fail('no es un documento JSON') }
  if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > BACKUP_MAX_BYTES) return fail('supera los 10 MiB')
}
export function parseWebLibraryBackup(input: unknown): BackupEnvelope {
  if (typeof input === 'string') {
    if (new TextEncoder().encode(input).byteLength > BACKUP_MAX_BYTES) return fail('supera los 10 MiB')
    try { input = JSON.parse(input) } catch { return fail('JSON ilegible') }
  }
  size(input)
  const r = row(input, ['format', 'version', 'createdAt', 'library'], true)
  if (r.format !== 'pletina-library' || r.version !== 1) return fail('formato o versión no admitidos')
  const createdAt = text(r.createdAt, 40)
  if (!Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) return fail('fecha no válida')
  return { format: 'pletina-library', version: 1, createdAt, library: normalizeData(r.library, true) }
}
export function makeWebLibraryBackup(raw: unknown): BackupEnvelope {
  const value: BackupEnvelope = { format: 'pletina-library', version: 1, createdAt: new Date().toISOString(), library: normalizeData(raw, false) }
  size(value)
  return value
}
export const emptyBackupSummary = (): BackupSummary => Object.fromEntries(BACKUP_STORES.map(key => [key, 0])) as BackupSummary
export function previewWebLibraryBackup(input: unknown): BackupSummary {
  const value = parseWebLibraryBackup(input)
  return Object.fromEntries(BACKUP_STORES.map(key => [key, value.library[key].length])) as BackupSummary
}
