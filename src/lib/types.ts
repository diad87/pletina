// Espejo de los structs de src-tauri/src/deezer.rs (serializados en camelCase).

export interface ArtistRef {
  id: number
  name: string
  /** Solo en algunos sitios (p. ej. la cabecera de un disco). */
  pictureMedium?: string | null
}

export interface AlbumRef {
  id: number
  title: string
  coverMedium: string | null
  coverBig: string | null
}

/** Canción entre las más escuchadas de un artista, con su disco. */
export interface TopTrack extends Track {
  album: AlbumRef
}

export interface Artist {
  id: number
  name: string
  pictureMedium: string | null
  pictureXl: string | null
  nbAlbum: number
  nbFan: number
}

export interface Album {
  id: number
  title: string
  coverMedium: string | null
  coverXl: string | null
  releaseDate: string | null
  recordType: string | null
  nbTracks: number
  explicitLyrics: boolean
  fans: number
  artist: ArtistRef | null
}

export interface Track {
  id: number
  title: string
  titleVersion: string | null
  duration: number
  trackPosition: number
  diskNumber: number
  explicitLyrics: boolean
  isrc: string | null
  artist: ArtistRef
}

export interface AlbumDetail {
  id: number
  title: string
  coverBig: string | null
  coverXl: string | null
  releaseDate: string | null
  recordType: string | null
  label: string | null
  duration: number
  nbTracks: number
  explicitLyrics: boolean
  genres: string[]
  artist: ArtistRef
  tracks: Track[]
}

export interface SearchResults {
  artists: Artist[]
  albums: Album[]
}

export interface ArtistPage {
  artist: Artist
  albums: Album[]
  top: TopTrack[]
}

/** Lo que el backend necesita para buscar una canción en YouTube. */
export interface TrackQuery {
  id: number
  title: string
  artist: string
  album: string
  duration: number
}

/** Audio listo para reproducir. */
export interface Playable {
  videoId: string
  /** URL del stream, o ruta del archivo si `local`. */
  url: string
  title: string
  channel: string
  /** Canción descargada: se reproduce el archivo. */
  local: boolean
}

/** Un vídeo que podría ser la canción ("esta no es"). */
export interface Alternative {
  videoId: string
  title: string
  artists: string
  album: string | null
  duration: number | null
  score: number
  origin: 'music' | 'youtube'
  current: boolean
}

// Biblioteca (espejo de src-tauri/src/library.rs).

export interface LibTrack {
  id: number
  title: string
  duration: number
  explicit: boolean
  artistId: number
  artistName: string
  albumId: number
  albumTitle: string
  albumArtistId: number
  cover: string | null
}

export interface SavedAlbum {
  id: number
  title: string
  artistId: number
  artistName: string
  cover: string | null
  releaseDate: string | null
  recordType: string | null
}

export interface PlaylistSummary {
  id: number
  name: string
  count: number
  duration: number
  covers: string[]
}

export interface Entry {
  entryId: number
  track: LibTrack
  /** Cuándo se añadió o se escuchó (segundos unix). */
  at: number
}

export interface PlaylistDetail extends PlaylistSummary {
  entries: Entry[]
}

export interface LibraryData {
  likedIds: number[]
  downloadedIds: number[]
  albums: SavedAlbum[]
  playlists: PlaylistSummary[]
}

export interface DownloadEntry {
  track: LibTrack
  path: string
  size: number
  at: number
}

/** Evento "download" del backend. */
export interface DownloadProgress {
  trackId: number
  state: 'queued' | 'downloading' | 'done' | 'error' | 'cancelled'
  progress: number
  error: string | null
}
