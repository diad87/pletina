// Backend falso para ver la interfaz en un navegador normal (`npm run dev`), sin Tauri.
// Solo se carga en desarrollo y fuera de la app; usa respuestas reales guardadas en ./fixtures
// (se regeneran con `cargo test write_fixtures -- --ignored` en src-tauri).

import type { AlbumDetail, ArtistPage, Entry, LibTrack, PlaylistSummary, SavedAlbum, SearchResults } from '../lib/types'
import album1 from './fixtures/album-1.json'
import album2 from './fixtures/album-2.json'
import album3 from './fixtures/album-3.json'
import album4 from './fixtures/album-4.json'
import artistPage from './fixtures/artist.json'
import searchResults from './fixtures/search.json'

const albums = [album1, album2, album3, album4] as unknown as AlbumDetail[]
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function mockInvoke<T>(cmd: string, args: any = {}): Promise<T> {
  await wait(cmd === 'resolve' ? 600 : 120)
  const out = ((): unknown => {
    switch (cmd) {
      case 'search':
        return searchResults as unknown as SearchResults
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
      case 'create_playlist': {
        const id = Math.max(0, ...playlists.keys()) + 1
        playlists.set(id, { name: args.name, tracks: args.tracks ?? [] })
        return summary(id)
      }
      case 'playlist':
        return { ...summary(args.id), entries: entries(playlists.get(args.id)?.tracks ?? [], 86400) }
      case 'history':
        return history
      case 'downloads_list':
        return []
      case 'download_dir_path':
        return 'C:\\Users\\iunan\\Music\\Musify'
      default:
        return null
    }
  })()
  return structuredClone(out) as T
}
