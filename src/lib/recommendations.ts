import type { Album, Artist, Entry, SavedAlbum } from './types'

export interface RecommendationInput {
  history: Entry[]
  liked: Entry[]
  saved: SavedAlbum[]
}

export interface RecommendationSource {
  discovery(): Promise<{ albums: Album[]; artists: Artist[] }>
  artistAlbums(id: number): Promise<Album[]>
  relatedArtists(id: number): Promise<Artist[]>
}

export interface RecommendationResult {
  albums: { album: Album; reason: string }[]
  artists: { artist: Artist; reason: string }[]
  personalized: boolean
  failed: boolean
}

interface Seed {
  id: number
  name: string
  historyScore: number
  likedScore: number
  savedScore: number
  recent: number
}

// YouTube, podcasts y la biblioteca local reservan los rangos superiores a este límite.
const CATALOG_LIMIT = 250_000_000_000_000
const RESULT_LIMIT = 12
const isCatalogId = (id: number) => Number.isSafeInteger(id) && id > 0 && id < CATALOG_LIMIT
const catalogEntry = ({ track }: Entry) =>
  isCatalogId(track.id) && isCatalogId(track.albumId) && isCatalogId(track.artistId)

/** Conserva el orden de cada fuente, alternándolas y omitiendo duplicados. */
function interleave<T>(groups: T[][], id: (value: T) => number, limit: number): T[] {
  const found = new Set<number>()
  const result: T[] = []
  const positions = groups.map(() => 0)
  while (result.length < limit) {
    let added = false
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index]
      while (positions[index] < group.length && found.has(id(group[positions[index]]))) positions[index]++
      const item = group[positions[index]++]
      if (!item) continue
      found.add(id(item))
      result.push(item)
      added = true
      if (result.length === limit) break
    }
    if (!added) break
  }
  return result
}

/** Recomendaciones deterministas: solo se consultan artistas del catálogo musical. */
export async function recommend(input: RecommendationInput, source: RecommendationSource): Promise<RecommendationResult> {
  const knownAlbums = new Set<number>()
  const knownArtists = new Set<number>()
  const candidates = new Map<number, Seed>()

  function seed(id: number, name: string): Seed {
    let value = candidates.get(id)
    if (!value) {
      value = { id, name, historyScore: 0, likedScore: 0, savedScore: 0, recent: 0 }
      candidates.set(id, value)
    }
    return value
  }

  for (const [entries, kind] of [[input.history, 'history'], [input.liked, 'liked']] as const) {
    const ordered = entries.filter(catalogEntry).sort((a, b) => b.at - a.at)
    ordered.forEach(({ track, at }, index) => {
      knownAlbums.add(track.albumId)
      knownArtists.add(track.artistId)
      if (isCatalogId(track.albumArtistId)) knownArtists.add(track.albumArtistId)
      const value = seed(track.artistId, track.artistName)
      // La frecuencia suma, pero se limita su peso para dar cabida a otros gustos.
      if (kind === 'history') value.historyScore = Math.min(12, value.historyScore + 2 / (1 + index / 12))
      else value.likedScore = Math.min(10, value.likedScore + 3 / (1 + index / 20))
      value.recent = Math.max(value.recent, at)
    })
  }
  for (const album of input.saved) {
    if (!isCatalogId(album.id) || !isCatalogId(album.artistId)) continue
    knownAlbums.add(album.id)
    knownArtists.add(album.artistId)
    const value = seed(album.artistId, album.artistName)
    value.savedScore = Math.min(8, value.savedScore + 4)
  }

  const score = (value: Seed) => value.historyScore + value.likedScore + value.savedScore
  const seeds = [...candidates.values()]
    .sort((a, b) => score(b) - score(a) || b.recent - a.recent || a.id - b.id)
    .slice(0, 3)

  const unseenAlbum = (album: Album) =>
    isCatalogId(album.id) && !knownAlbums.has(album.id) && (!album.artist || isCatalogId(album.artist.id))
  const unseenArtist = (artist: Artist) => isCatalogId(artist.id) && !knownArtists.has(artist.id)

  async function popular(): Promise<RecommendationResult> {
    try {
      const discovery = await source.discovery()
      return {
        albums: interleave([discovery.albums.filter(unseenAlbum)], (album) => album.id, RESULT_LIMIT)
          .map((album) => ({ album, reason: 'Popular en Deezer' })),
        artists: interleave([discovery.artists.filter(unseenArtist)], (artist) => artist.id, RESULT_LIMIT)
          .map((artist) => ({ artist, reason: 'Popular en Deezer' })),
        personalized: false,
        failed: false,
      }
    } catch {
      return { albums: [], artists: [], personalized: false, failed: true }
    }
  }

  if (!seeds.length) return popular()

  // Las seis peticiones son independientes: el fallo de una no descarta las demás.
  const initial = await Promise.allSettled(seeds.map(async (value) => {
    const [albums, artists] = await Promise.allSettled([
      Promise.resolve().then(() => source.artistAlbums(value.id)),
      Promise.resolve().then(() => source.relatedArtists(value.id)),
    ])
    return {
      seed: value,
      albums: albums.status === 'fulfilled' ? albums.value : [],
      artists: artists.status === 'fulfilled' ? artists.value : [],
    }
  }))

  const albumGroups: RecommendationResult['albums'][] = []
  const artistGroups: RecommendationResult['artists'][] = []
  for (const result of initial) {
    if (result.status !== 'fulfilled') continue
    const { seed: value, albums, artists } = result.value
    albumGroups.push(albums.filter(unseenAlbum).map((album) => ({
      album: { ...album, artist: album.artist ?? { id: value.id, name: value.name } },
      reason: `Más de ${value.name}`,
    })))
    artistGroups.push(artists.filter(unseenArtist).map((artist) => ({
      artist,
      reason: `Similar a ${value.name}`,
    })))
  }

  const artists = interleave(artistGroups, (item) => item.artist.id, RESULT_LIMIT)
  // Dos artistas nuevos bastan para añadir descubrimiento sin multiplicar peticiones.
  const relatedAlbums = await Promise.allSettled(artists.slice(0, 2).map(async ({ artist, reason }) => {
    const albums = await source.artistAlbums(artist.id)
    return albums.filter(unseenAlbum).map((album) => ({
      album: { ...album, artist: album.artist ?? { id: artist.id, name: artist.name } },
      reason,
    }))
  }))
  for (const result of relatedAlbums) {
    if (result.status === 'fulfilled') albumGroups.push(result.value)
  }

  const albums = interleave(albumGroups, (item) => item.album.id, RESULT_LIMIT)
  if (!albums.length && !artists.length) return popular()
  return { albums, artists, personalized: true, failed: false }
}
