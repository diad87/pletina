import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { webInvoke } from '../../web-port/invoke'
import type {
  AlbumDetail,
  Album,
  Alternative,
  Artist,
  ArtistPage,
  Discovery,
  DownloadEntry,
  Entry,
  ImportSource,
  ImportTrack,
  LibraryData,
  LocalLibrary,
  LibTrack,
  Playable,
  PodcastDetail,
  PodcastProgress,
  PodcastSearchResults,
  PlaylistDetail,
  PlaylistSummary,
  SavedAlbum,
  SavedArtist,
  YouTubeTrackPreview,
  SearchResults,
  TrackQuery,
} from './types'

/** Dentro de la app de escritorio, o en un navegador normal con `npm run dev`. */
export const inPwa = import.meta.env.MODE === 'pwa'
export const inTauri = !inPwa && '__TAURI_INTERNALS__' in window

/**
 * La comunicación con Rust, lista. En Android, lo que se pide en los primeros instantes de arrancar
 * la app se rechaza (Tauri aún está preparando los permisos de la ventana): main.ts espera a esto.
 */
export const ipcReady: Promise<void> = inTauri
  ? (async () => {
      for (let i = 0; i < 50; i++) {
        try {
          await tauriInvoke('plugin:app|version')
          return
        } catch {
          await new Promise((r) => setTimeout(r, 100))
        }
      }
    })()
  : Promise.resolve()

// En un navegador normal (solo desarrollo) se usa un backend falso con datos guardados,
// para poder ver y ajustar la interfaz. En la app compilada siempre es Tauri.
const invoke: typeof tauriInvoke =
  inPwa ? webInvoke : inTauri || !import.meta.env.DEV
    ? tauriInvoke
    : async (cmd, args) => (await import('../dev/mock')).mockInvoke(cmd, args)

// Caché en memoria: volver atrás o reabrir un disco es instantáneo y no gasta cuota de Deezer.
const cache = new Map<string, { value: Promise<unknown>; expiresAt: number }>()

function cached<T>(key: string, load: () => Promise<T>, ttl = Infinity): Promise<T> {
  let hit = cache.get(key)
  if (!hit || hit.expiresAt <= Date.now()) {
    const value = load()
    hit = { value, expiresAt: Date.now() + ttl }
    cache.set(key, hit)
    // Si falla, que el siguiente intento vuelva a preguntar.
    value.catch(() => {
      if (cache.get(key)?.value === value) cache.delete(key)
    })
  }
  return hit.value as Promise<T>
}

export const search = (query: string) => invoke<SearchResults>('search', { query })

// Listados ligeros para Inicio. Se renuevan cada hora sin repetir peticiones al volver atrás.
const DISCOVERY_TTL = 60 * 60 * 1000
export const discovery = () => cached('discovery', () => invoke<Discovery>('discovery'), DISCOVERY_TTL)
// Al recuperar conexión, también se reintentan las secciones de un resultado parcial.
export const invalidateDiscovery = () => cache.delete('discovery')
export const relatedArtists = (id: number) =>
  cached(`related:${id}`, () => invoke<Artist[]>('related_artists', { id }), DISCOVERY_TTL)
export const artistAlbums = (id: number) =>
  cached(`artist-albums:${id}`, () => invoke<Album[]>('artist_albums', { id }), DISCOVERY_TTL)

// Los episodios cambian con cada publicación: el backend limita la caché de las fuentes.
export const podcastSearch = (query: string, language: string) =>
  invoke<PodcastSearchResults>('podcast_search', { query, language })
export const podcastDetail = (feedUrl: string) => invoke<PodcastDetail>('podcast_detail', { feedUrl })
export const podcastFeedUrl = (id: number) => invoke<string>('podcast_feed_url', { id })

export const podcastProgress = (ids: number[]) => invoke<PodcastProgress[]>('podcast_progress', { ids })
export const savePodcastProgress = (progress: PodcastProgress) => {
  if (!inTauri && import.meta.env.DEV) {
    // La vista previa también conserva el último segundo si se cierra/recarga la pestaña.
    let rows: Record<number, PodcastProgress> = {}
    try { rows = JSON.parse(localStorage.getItem('pletina:dev:podcast-progress') ?? '{}') } catch { /* Sin progreso previo válido. */ }
    rows[progress.id] = progress
    localStorage.setItem('pletina:dev:podcast-progress', JSON.stringify(rows))
    return Promise.resolve()
  }
  return invoke<void>('save_podcast_progress', { progress })
}

// La música local cambia al reescanear: sin caché (además es instantánea).
const LOCAL_BASE = 1_000_000_000_000_000

export const artist = (id: number) =>
  id >= LOCAL_BASE ? invoke<ArtistPage>('artist', { id }) : cached(`artist:${id}`, () => invoke<ArtistPage>('artist', { id }))

export const album = (id: number) =>
  id >= LOCAL_BASE ? invoke<AlbumDetail>('album', { id }) : cached(`album:${id}`, () => invoke<AlbumDetail>('album', { id }))

// Sin caché aquí: el backend ya guarda el vídeo elegido y la URL mientras no caduque.
export const resolve = (track: TrackQuery, refresh = false) => invoke<Playable>('resolve', { track, refresh })

export const alternatives = (track: TrackQuery) => invoke<Alternative[]>('alternatives', { track })

export const chooseSource = (track: TrackQuery, videoId: string) =>
  invoke<Playable>('choose_source', { track, videoId })

// Biblioteca: sin caché, la base de datos local es instantánea.
export const library = () => invoke<LibraryData>('library')
export const setLiked = (track: LibTrack, liked: boolean) => invoke<void>('set_liked', { track, liked })
export const likedTracks = () => invoke<Entry[]>('liked_tracks')
export const setAlbumSaved = (album: SavedAlbum, saved: boolean) => invoke<void>('set_album_saved', { album, saved })
export const setArtistSaved = (artist: SavedArtist, saved: boolean) => invoke<void>('set_artist_saved', { artist, saved })
export const setPodcastSaved = (id: number, saved: boolean) => invoke<void>('set_podcast_saved', { id, saved })
export const previewYouTubeTrack = (url: string) => invoke<YouTubeTrackPreview>('preview_youtube_track', { url })
export const saveYouTubeTrack = (track: YouTubeTrackPreview) => invoke<LibTrack>('save_youtube_track', { ...track })
export const youtubeTracks = () => invoke<Entry[]>('youtube_tracks')
export const removeYouTubeTrack = (id: number) => invoke<void>('remove_youtube_track', { id })
export const createPlaylist = (name: string, tracks: LibTrack[] = []) =>
  invoke<PlaylistSummary>('create_playlist', { name, tracks })
export const readSpotifyPlaylist = (url: string) => invoke<ImportSource>('read_spotify_playlist', { url })
export const readPlaylistCsv = (content: string, name: string) => invoke<ImportSource>('read_playlist_csv', { content, name })
export const matchImportTrack = (track: ImportTrack) => invoke<LibTrack | null>('match_import_track', { track })
export const renamePlaylist = (id: number, name: string) => invoke<void>('rename_playlist', { id, name })
export const deletePlaylist = (id: number) => invoke<void>('delete_playlist', { id })
export const playlist = (id: number) => invoke<PlaylistDetail>('playlist', { id })
export const addToPlaylist = (id: number, tracks: LibTrack[]) => invoke<void>('add_to_playlist', { id, tracks })
export const removeFromPlaylist = (id: number, entryId: number) => invoke<void>('remove_from_playlist', { id, entryId })
export const moveInPlaylist = (id: number, entryId: number, to: number) =>
  invoke<void>('move_in_playlist', { id, entryId, to })
export const recordPlay = (track: LibTrack) => invoke<void>('record_play', { track })
export const history = (limit: number) => invoke<Entry[]>('history', { limit })
export const clearHistory = () => invoke<void>('clear_history')

// Descargas.
export const download = (tracks: LibTrack[]) => invoke<void>('download', { tracks })
export const cancelDownloads = () => invoke<void>('cancel_downloads')
export const downloadsList = () => invoke<DownloadEntry[]>('downloads_list')
export const removeDownloads = (trackIds: number[]) => invoke<void>('remove_downloads', { trackIds })
export const downloadDirPath = () => invoke<string>('download_dir_path')
export const chooseDownloadDir = () => invoke<string | null>('choose_download_dir')
export const openDownloadDir = () => invoke<void>('open_download_dir')
export const revealDownload = (trackId: number) => invoke<void>('reveal_download', { trackId })

// Música local.
export const localLibrary = () => invoke<LocalLibrary>('local_library')
export const addLocalFolder = () => invoke<string[]>('add_local_folder')
export const removeLocalFolder = (path: string) => invoke<string[]>('remove_local_folder', { path })
export const scanLocal = () => invoke<void>('scan_local')
export const revealLocal = (trackId: number) => invoke<void>('reveal_local', { trackId })

// Actualizaciones.
export const installUpdate = () => invoke<void>('install_update')
/** Móvil: versión publicada más nueva que la instalada, o null. */
export const newerVersion = () => invoke<string | null>('newer_version')
export const openReleases = () => invoke<void>('open_releases')
/** Android: que el servicio de descargas mantenga viva la app hasta que acaben (ver DownloadService.kt). */
export const androidDownloadsStarted = () => invoke<void>('player_native', { cmd: 'downloadsStarted', args: {} })
/** Móvil: «Compartir» con el registro del servicio de música (ver MusifyLog.kt). */
export const shareLog = () => invoke<void>('player_native', { cmd: 'shareLog', args: {} })
