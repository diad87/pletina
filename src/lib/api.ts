import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import type {
  AlbumDetail,
  Alternative,
  ArtistPage,
  DownloadEntry,
  Entry,
  LibraryData,
  LibTrack,
  Playable,
  PlaylistDetail,
  PlaylistSummary,
  SavedAlbum,
  SearchResults,
  TrackQuery,
} from './types'

/** Dentro de la app de escritorio, o en un navegador normal con `npm run dev`. */
export const inTauri = '__TAURI_INTERNALS__' in window

// En un navegador normal (solo desarrollo) se usa un backend falso con datos guardados,
// para poder ver y ajustar la interfaz. En la app compilada siempre es Tauri.
const invoke: typeof tauriInvoke =
  inTauri || !import.meta.env.DEV
    ? tauriInvoke
    : async (cmd, args) => (await import('../dev/mock')).mockInvoke(cmd, args)

// Caché en memoria: volver atrás o reabrir un disco es instantáneo y no gasta cuota de Deezer.
const cache = new Map<string, Promise<unknown>>()

function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  let hit = cache.get(key) as Promise<T> | undefined
  if (!hit) {
    hit = load()
    cache.set(key, hit)
    // Si falla, que el siguiente intento vuelva a preguntar.
    hit.catch(() => cache.delete(key))
  }
  return hit
}

export const search = (query: string) =>
  cached(`search:${query.trim().toLowerCase()}`, () => invoke<SearchResults>('search', { query }))

export const artist = (id: number) => cached(`artist:${id}`, () => invoke<ArtistPage>('artist', { id }))

export const album = (id: number) => cached(`album:${id}`, () => invoke<AlbumDetail>('album', { id }))

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
export const createPlaylist = (name: string, tracks: LibTrack[] = []) =>
  invoke<PlaylistSummary>('create_playlist', { name, tracks })
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
