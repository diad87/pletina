import type { PlayerApi, QueueItem } from './queue'
import type { Artist, ArtistPage, TopTrack } from './types'

// Los identificadores de YouTube, pódcasts y música local están fuera del catálogo.
// Mismo límite que YOUTUBE_BASE en media.ts, sin importar su dependencia de la interfaz.
const CATALOG_END = 250_000_000_000_000
const MAX_RELATED = 6
export const RADIO_LIMIT = 45

export const isRadioArtist = (id: number) => Number.isSafeInteger(id) && id > 0 && id < CATALOG_END

export interface RadioSources {
  relatedArtists(id: number): Promise<Pick<Artist, 'id'>[]>
  artist(id: number): Promise<Pick<ArtistPage, 'top'>>
}

export interface ArtistRadio {
  items: QueueItem[]
  artistCount: number
  failedSources: number
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

/** Una selección finita: la semilla primero, después artistas alternos, sin repetir grabaciones. */
export async function createArtistRadio(
  seed: Pick<ArtistPage, 'artist' | 'top'>,
  source: RadioSources,
  random: () => number = Math.random,
): Promise<ArtistRadio> {
  const empty = { items: [], artistCount: 0, failedSources: 0 }
  if (!isRadioArtist(seed.artist.id)) return empty

  let failedSources = 0
  let related: Pick<Artist, 'id'>[] = []
  try {
    related = await source.relatedArtists(seed.artist.id)
  } catch {
    failedSources++
  }
  const relatedIds = [...new Set(related.map((artist) => artist.id))]
    .filter((id) => isRadioArtist(id) && id !== seed.artist.id)
  const selected = shuffled(relatedIds, random).slice(0, MAX_RELATED)
  const pages = await Promise.allSettled(selected.map(async (id) => source.artist(id)))
  const tracks: TopTrack[] = [...seed.top]
  for (const page of pages) {
    if (page.status === 'fulfilled') tracks.push(...page.value.top)
    else failedSources++
  }

  const seenIds = new Set<number>()
  const seenRecordings = new Set<string>()
  const byArtist = new Map<number, QueueItem[]>()
  for (const track of tracks) {
    if (!isRadioArtist(track.id) || !isRadioArtist(track.artist.id)) continue
    const recording = track.isrc?.trim().toUpperCase()
    if (seenIds.has(track.id) || (recording && seenRecordings.has(recording))) continue
    seenIds.add(track.id)
    if (recording) seenRecordings.add(recording)
    const bucket = byArtist.get(track.artist.id) ?? []
    bucket.push({
      track,
      albumId: track.album.id,
      albumTitle: track.album.title,
      artistId: track.artist.id,
      cover: track.album.coverBig ?? track.album.coverMedium,
    })
    byArtist.set(track.artist.id, bucket)
  }

  const artists = [...byArtist.keys()]
  const order = [
    ...artists.filter((id) => id === seed.artist.id),
    ...shuffled(artists.filter((id) => id !== seed.artist.id), random),
  ]
  const buckets = order.map((id) => shuffled(byArtist.get(id)!, random))
  const items: QueueItem[] = []
  // Cada vuelta aporta una canción de cada artista mientras queden canciones disponibles.
  while (items.length < RADIO_LIMIT && buckets.some((bucket) => bucket.length)) {
    for (const bucket of buckets) {
      if (items.length === RADIO_LIMIT) break
      const item = bucket.shift()
      if (item) items.push(item)
    }
  }
  return { items, artistCount: new Set(items.map((item) => item.track.artist.id)).size, failedSources }
}

type PlaybackSnapshot = Pick<PlayerApi, 'queue' | 'current' | 'context' | 'status'>

/** Android devuelve otro array de cola en cada lectura; comparamos sus entradas, no el array. */
export function sameRadioPlayback(before: PlaybackSnapshot, now: PlaybackSnapshot): boolean {
  const queue = now.queue
  return before.context === now.context && before.current === now.current && before.status === now.status &&
    before.queue.length === queue.length && before.queue.every((item, i) => item === queue[i])
}
