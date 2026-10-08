// Backend falso para ver la interfaz en un navegador normal (`npm run dev`), sin Tauri.
// Solo se carga en desarrollo y fuera de la app; usa respuestas reales guardadas en ./fixtures
// (se regeneran con `cargo test write_fixtures -- --ignored` en src-tauri).

import type { Album, AlbumDetail, ArtistPage, Entry, LibTrack, PlaylistSummary, SavedAlbum, SavedArtist, SearchResults } from '../lib/types'
import { YOUTUBE_BASE } from '../lib/media'
import album1 from './fixtures/album-1.json'
import album2 from './fixtures/album-2.json'
import album3 from './fixtures/album-3.json'
import album4 from './fixtures/album-4.json'
import artistPage from './fixtures/artist.json'
import searchResults from './fixtures/search.json'
import { podcastFixture, podcastFixtures } from './podcasts'

const albums = [album1, album2, album3, album4] as unknown as AlbumDetail[]

/** Música local de ejemplo: los mismos discos, con ids locales. */
const LOCAL_BASE = 1_000_000_000_000_000
const localAlbums: Album[] = albums.map((a, i) => ({
  id: LOCAL_BASE + i + 1,
  title: a.title,
  coverMedium: a.coverBig,
  coverXl: a.coverXl,
  releaseDate: a.releaseDate,
  recordType: 'album',
  nbTracks: a.tracks.length,
  explicitLyrics: false,
  fans: 0,
  artist: { id: LOCAL_BASE + 100 + i, name: a.artist.name, pictureMedium: a.artist.pictureMedium ?? null },
}))
const now = Math.floor(Date.now() / 1000)

function lib(album: AlbumDetail, i: number): LibTrack {
  const t = album.tracks[i % album.tracks.length]
  return {
    id: t.id,
    title: t.title,
    duration: t.duration,
    explicit: t.explicitLyrics,
    artistId: t.artist.id,
    artistName: t.artist.name,
    albumId: album.id,
    albumTitle: album.title,
    albumArtistId: album.artist.id,
    cover: album.coverBig,
  }
}

const entries = (tracks: LibTrack[], step = 3600): Entry[] =>
  tracks.map((track, i) => ({ entryId: i + 1, track, at: now - i * step }))

const liked = new Map<number, LibTrack>([0, 2, 4, 6].map((i) => [lib(albums[0], i).id, lib(albums[0], i)]))
const savedArtists = new Map<number, SavedArtist>()
const youtubeTracks = new Map<string, { track: LibTrack; saved: boolean }>()
const savedPodcastsKey = 'pletina:preview:saved-podcasts'
function readSavedPodcasts(): number[] {
  try {
    const ids: unknown = JSON.parse(localStorage.getItem(savedPodcastsKey) ?? '[]')
    return Array.isArray(ids) ? ids.filter((id) => podcastFixtures.some((podcast) => podcast.id === id)) : []
  } catch { return [] }
}
let savedPodcasts = new Set(readSavedPodcasts())
const podcastPreviewError = (name: string) =>
  typeof location !== 'undefined' && new URLSearchParams(location.search).get(name) === '1'

function youtubeId(input: string): string {
  const text = input.trim()
  let id = /^[\w-]{11}$/.test(text) ? text : ''
  if (!id) {
    try {
      const url = new URL(text)
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error()
      if (url.hostname === 'youtu.be') id = url.pathname.slice(1)
      else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(url.hostname)) {
        id = url.pathname === '/watch' ? url.searchParams.get('v') ?? '' : url.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})\/?$/)?.[1] ?? ''
      }
    } catch { /* El mismo mensaje de validación que en la app. */ }
  }
  if (!/^[\w-]{11}$/.test(id)) throw new Error('Pega un enlace de un vídeo de YouTube o YouTube Music.')
  return id
}
const saved: SavedAlbum[] = albums.slice(1, 3).map((a) => ({
  id: a.id,
  title: a.title,
  artistId: a.artist.id,
  artistName: a.artist.name,
  cover: a.coverBig,
  releaseDate: a.releaseDate,
  recordType: a.recordType,
}))
const playlists = new Map<number, { name: string; tracks: LibTrack[] }>([
  [1, { name: 'Para conducir', tracks: albums.flatMap((a) => [0, 1, 2].map((i) => lib(a, i))) }],
  [2, { name: 'Rock en euskera', tracks: [0, 1, 2, 3, 4].map((i) => lib(albums[1], i)) }],
])
const history = entries([...[0, 1, 2].map((i) => lib(albums[2], i)), ...[3, 4].map((i) => lib(albums[3], i)), lib(albums[1], 0)], 1500)

function summary(id: number): PlaylistSummary {
  const p = playlists.get(id)!
  return {
    id,
    name: p.name,
    count: p.tracks.length,
    duration: p.tracks.reduce((s, t) => s + t.duration, 0),
    covers: [...new Set(p.tracks.map((t) => t.cover).filter((c): c is string => !!c))].slice(0, 4),
  }
}

/** 30 s de silencio en WAV, para que el reproductor "suene" en la vista previa. */
let silence: string | null = null
function silentAudio(): string {
  if (silence) return silence
  const rate = 8000
  const samples = rate * 30
  const buf = new ArrayBuffer(44 + samples)
  const v = new DataView(buf)
  const text = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
  text(0, 'RIFF')
  v.setUint32(4, 36 + samples, true)
  text(8, 'WAVEfmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate, true)
  v.setUint16(32, 1, true)
  v.setUint16(34, 8, true)
  text(36, 'data')
  v.setUint32(40, samples, true)
  new Uint8Array(buf, 44).fill(128)
  silence = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }))
  return silence
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function importExample(name: string) {
  const tracks = [lib(albums[0], 0), lib(albums[0], 1), lib(albums[0], 0)]
  return {
    name,
    tracks: [
      ...tracks.map((t) => ({ title: t.title, artists: [t.artistName], durationMs: t.duration * 1000, isrc: null })),
      { title: 'Sin coincidencia (ejemplo)', artists: ['Artista de ejemplo'], durationMs: 180000, isrc: null },
    ],
    skipped: 1,
    warnings: ['Spotify puede mostrar solo parte de una lista pública, hasta 100 canciones. Usa un CSV para importar una lista completa.'],
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function mockInvoke<T>(cmd: string, args: any = {}): Promise<T> {
  // Tauri cruza una frontera JSON. Evita guardar proxies de $state en el backend de prueba.
  args = JSON.parse(JSON.stringify(args))
  await wait(cmd === 'resolve' ? 600 : 120)
  const out = ((): unknown => {
    switch (cmd) {
      case 'preview_youtube_track': {
        const videoId = youtubeId(String(args.url ?? ''))
        return { videoId, title: 'Canción de YouTube · ejemplo', artist: 'Canal de ejemplo', duration: 214, cover: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` }
      }
      case 'save_youtube_track': {
        const videoId = youtubeId(String(args.videoId ?? ''))
        const id = youtubeTracks.get(videoId)?.track.id ?? YOUTUBE_BASE + youtubeTracks.size + 1
        const track: LibTrack = { id, title: args.title, artistName: args.artist, duration: args.duration,
          explicit: false, artistId: 0, albumId: id, albumTitle: 'YouTube', albumArtistId: 0,
          cover: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` }
        youtubeTracks.set(videoId, { track, saved: true })
        return track
      }
      case 'youtube_tracks':
        return entries([...youtubeTracks.values()].filter((row) => row.saved).map((row) => row.track).reverse())
      case 'remove_youtube_track':
        for (const row of youtubeTracks.values()) if (row.track.id === args.id) row.saved = false
        return null
      case 'read_spotify_playlist': {
        const input = String(args.url ?? '').trim()
        if (!/^spotify:playlist:[A-Za-z0-9]{22}$/.test(input) &&
            !/^https:\/\/open\.spotify\.com\/(?:intl-[a-zA-Z-]+\/)?(?:embed\/)?playlist\/[A-Za-z0-9]{22}\/?(?:[?#].*)?$/.test(input)) {
          throw new Error('Pega el enlace de una playlist de Spotify (https://open.spotify.com/playlist/…).')
        }
        return importExample('Desde Spotify · ejemplo')
      }
      case 'read_playlist_csv':
        if (!String(args.content ?? '').trim()) throw new Error('El CSV está vacío.')
        return importExample(String(args.name ?? 'Importada').replace(/\.csv$/i, ''))
      case 'match_import_track': {
        for (const album of albums) {
          const index = album.tracks.findIndex((t) => t.title === args.track.title && args.track.artists.includes(t.artist.name))
          if (index >= 0) return lib(album, index)
        }
        return null
      }
      case 'podcast_search': {
        if (podcastPreviewError('podcastSearchError')) throw new Error('No se pudo conectar con el buscador de pódcasts (vista previa).')
        const query = String(args.query ?? '').trim().toLocaleLowerCase('es')
        const matches = (podcast: typeof podcastFixtures[number]) =>
          !query || `${podcast.title} ${podcast.author}`.toLocaleLowerCase('es').includes(query)
        return {
          podcasts: podcastFixtures.filter((p) =>
            !p.feedUrl.startsWith('youtube:') && matches(p) &&
            (args.language === 'all' || p.language?.split(/[-_]/)[0] === args.language)),
          youtube: podcastFixtures.filter((p) => p.feedUrl.startsWith('youtube:') && matches(p)),
          failedFeeds: 0,
        }
      }
      case 'podcast_detail':
        if (podcastPreviewError('podcastDetailError')) throw new Error('No se pudo conectar con este pódcast (vista previa).')
        return podcastFixture(args.feedUrl)
      case 'podcast_feed_url': {
        const podcast = podcastFixtures.find((p) => p.id === args.id)
        if (!podcast) throw new Error('No se encuentra este podcast de ejemplo')
        return podcast.feedUrl
      }
      case 'search':
        return { ...(searchResults as unknown as SearchResults), localArtists: [], localAlbums: localAlbums.slice(0, 2) }
      case 'local_library':
        return {
          folders: [String.raw`C:\Users\usuario\Music`, String.raw`D:\Música\Vinilos digitalizados`],
          albums: localAlbums,
          artists: [...new Map(localAlbums.map((a) => [a.artist!.id, a.artist!])).values()].map((ar) => ({
            id: ar.id,
            name: ar.name,
            pictureMedium: ar.pictureMedium ?? null,
            pictureXl: ar.pictureMedium ?? null,
            nbAlbum: localAlbums.filter((a) => a.artist?.id === ar.id).length,
            nbFan: 0,
          })),
          tracks: albums.reduce((s, a) => s + a.tracks.length, 0),
          scanning: false,
        }
      case 'artist':
        return artistPage as unknown as ArtistPage
      case 'album':
        return albums.find((a) => a.id === args.id) ?? albums[0]
      case 'resolve':
      case 'choose_source':
        return { videoId: 'preview', url: silentAudio(), title: '', channel: '', local: false }
      case 'alternatives':
        return []
      case 'library':
        return {
          likedIds: [...liked.keys()],
          downloadedIds: [],
          albums: saved,
          artists: [...savedArtists.values()],
          podcasts: [...savedPodcasts].reverse().map((id) => podcastFixtures.find((podcast) => podcast.id === id)!),
          playlists: [...playlists.keys()].map(summary),
        }
      case 'set_liked':
        if (args.liked) liked.set(args.track.id, args.track)
        else liked.delete(args.track.id)
        return null
      case 'liked_tracks':
        return entries([...liked.values()], 86400)
      case 'set_album_saved':
        return null
      case 'set_artist_saved':
        if (args.saved) savedArtists.set(args.artist.id, args.artist)
        else savedArtists.delete(args.artist.id)
        return null
      case 'set_podcast_saved': {
        if (podcastPreviewError('podcastSaveError')) throw new Error('No se pudo guardar el pódcast (vista previa).')
        if (!podcastFixtures.some((podcast) => podcast.id === args.id)) throw new Error('No se encuentra este podcast de ejemplo')
        const next = new Set(savedPodcasts)
        if (args.saved) next.add(args.id)
        else next.delete(args.id)
        localStorage.setItem(savedPodcastsKey, JSON.stringify([...next]))
        savedPodcasts = next
        return null
      }
      case 'create_playlist': {
        const id = Math.max(0, ...playlists.keys()) + 1
        playlists.set(id, { name: args.name, tracks: args.tracks ?? [] })
        return summary(id)
      }
      case 'playlist':
        return { ...summary(args.id), entries: entries(playlists.get(args.id)?.tracks ?? [], 86400) }
      case 'add_to_playlist': {
        const list = playlists.get(args.id)
        if (list) list.tracks.push(...args.tracks)
        return null
      }
      case 'history':
        return history
      case 'downloads_list':
        return []
      case 'download_dir_path':
        return 'C:\\Users\\usuario\\Music\\Pletina'
      default:
        return null
    }
  })()
  return structuredClone(out) as T
}
