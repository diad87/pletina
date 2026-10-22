import type { Alternative, TrackQuery } from '../src/lib/types'
import { alternatives as audioAlternatives, MIN_SCORE } from './audio'
import { readYouTubeVideo as storedYouTubeVideo } from './storage'
import { abortReason, checkAbort, validVideoId } from './youtube'

const DIRECT_BASE = 250_000_000_000_000
const PODCAST_BASE = 500_000_000_000_000
export const OFFICIAL_SEARCH_TIMEOUT = 45_000

export interface OfficialSourceOptions {
  signal?: AbortSignal
  alternatives?: (track: TrackQuery, signal?: AbortSignal) => Promise<Alternative[]>
  readYouTubeVideo?: (id: number) => Promise<string | null>
  online?: () => boolean
  timeout?: number
}

export function validateOfficialTrack(value: TrackQuery): TrackQuery {
  if (!value || !Number.isSafeInteger(value.id) || value.id <= 0 || value.id >= PODCAST_BASE ||
    typeof value.title !== 'string' || !value.title.trim() || value.title.length > 500 ||
    typeof value.artist !== 'string' || !value.artist.trim() || value.artist.length > 500 ||
    typeof value.album !== 'string' || value.album.length > 500 ||
    !Number.isFinite(value.duration) || value.duration < 0 || value.duration > 604_800) {
    throw new Error('Esta canción no se puede abrir en el reproductor de YouTube.')
  }
  return { id: value.id, title: value.title.trim(), artist: value.artist.trim(), album: value.album.trim(), duration: value.duration }
}

const karaoke = (title: string) => /(?:^|[^\p{L}\p{N}])karaoke(?:a)?(?:$|[^\p{L}\p{N}])/iu.test(title)

/** Scores are produced by the existing audio matcher; this view never raises them. */
export function filterOfficialSources(input: TrackQuery, values: Alternative[]): Alternative[] {
  return filteredSources(input, values, false)
}

function filteredSources(input: TrackQuery, values: Alternative[], preserveSelectedKaraoke: boolean): Alternative[] {
  const track = validateOfficialTrack(input)
  if (!Array.isArray(values)) throw new Error('YouTube no devolvió una lista de vídeos válida.')
  const seen = new Set<string>()
  return values.slice(0, 32).filter((row) => {
    if (!row || !validVideoId(row.videoId) || !Number.isFinite(row.score) || row.score < MIN_SCORE ||
      typeof row.title !== 'string' || !row.title.trim() || typeof row.artists !== 'string' || !row.artists.trim() ||
      (row.album !== null && typeof row.album !== 'string') ||
      (row.duration !== null && (!Number.isFinite(row.duration) || row.duration <= 0 || row.duration > 604_800)) ||
      !['music', 'youtube'].includes(row.origin) ||
      (karaoke(row.title) && !karaoke(track.title) && !(preserveSelectedKaraoke && row.current === true))) return false
    return true
  }).sort((a, b) => b.score - a.score).filter((row) => !seen.has(row.videoId) && !!seen.add(row.videoId)).slice(0, 3)
    .map((row) => ({ videoId: row.videoId, title: row.title.trim().slice(0, 500), artists: row.artists.trim().slice(0, 500),
      album: row.album?.slice(0, 500) ?? null, duration: row.duration, score: row.score, origin: row.origin, current: Boolean(row.current) }))
}

/** Accept only an already matched source; never carry a caller-supplied URL into the iframe. */
export function validateAutomaticOfficialSource(input: TrackQuery, source: Alternative): Alternative {
  const selected = filteredSources(input, [source], true)[0]
  if (!selected) throw new Error('No se ha encontrado una coincidencia válida para esta canción.')
  return selected
}

export async function searchOfficialSources(input: TrackQuery, options: OfficialSourceOptions = {}): Promise<Alternative[]> {
  const track = validateOfficialTrack(input)
  checkAbort(options.signal)
  const online = options.online ?? (() => globalThis.navigator?.onLine !== false)
  if (!online()) throw new Error('Sin conexión. Conéctate a Internet y vuelve a intentarlo.')
  const controller = new AbortController()
  const relay = () => controller.abort(abortReason(options.signal))
  options.signal?.addEventListener('abort', relay, { once: true })
  const timeout = Number.isFinite(options.timeout) ? Math.max(1, Math.min(OFFICIAL_SEARCH_TIMEOUT, options.timeout!)) : OFFICIAL_SEARCH_TIMEOUT
  const timer = setTimeout(() => controller.abort(new DOMException('La búsqueda de vídeos tardó demasiado. Vuelve a intentarlo.', 'TimeoutError')), timeout)
  let abort: (() => void) | undefined
  try {
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(abortReason(controller.signal))
      controller.signal.addEventListener('abort', abort, { once: true })
      if (controller.signal.aborted) abort()
    })
    const work = async () => {
      checkAbort(controller.signal)
      if (track.id >= DIRECT_BASE) {
        const videoId = await (options.readYouTubeVideo ?? storedYouTubeVideo)(track.id)
        checkAbort(controller.signal)
        if (!validVideoId(videoId)) throw new Error('No se encuentra el vídeo de esta canción de YouTube.')
        return [{ videoId, title: track.title, artists: track.artist, album: track.album || null,
          duration: track.duration || null, score: 100, origin: 'youtube' as const, current: true }]
      }
      const values = await (options.alternatives ?? audioAlternatives)(track, controller.signal)
      checkAbort(controller.signal)
      return filterOfficialSources(track, values)
    }
    return await Promise.race([work(), cancelled])
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', relay)
    if (abort) controller.signal.removeEventListener('abort', abort)
  }
}

export function validateOfficialStartAt(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 604_800) throw new Error('La posición de reproducción no es válida.')
  return Math.floor(value)
}

export function officialEmbedUrl(videoId: string, origin: string, autoplay = false, startAt = 0): string {
  if (!validVideoId(videoId)) throw new Error('El vídeo de YouTube no es válido.')
  const start = validateOfficialStartAt(startAt)
  const parent = new URL(origin)
  if (parent.origin !== origin || !['https:', 'http:'].includes(parent.protocol)) throw new Error('El origen de la página no es válido.')
  const url = new URL(`https://www.youtube.com/embed/${videoId}`)
  url.searchParams.set('playsinline', '1')
  url.searchParams.set('autoplay', autoplay ? '1' : '0')
  url.searchParams.set('controls', '1')
  url.searchParams.set('enablejsapi', '1')
  url.searchParams.set('origin', parent.origin)
  if (start > 0) url.searchParams.set('start', String(start))
  return url.href
}
