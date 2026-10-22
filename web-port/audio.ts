import type { Alternative, Playable, TrackQuery, YouTubeTrackPreview } from '../src/lib/types'
import { readSourceChoice, saveSourceChoice, readYouTubeVideo } from './storage'
import { resolvePodcastTrack } from './podcast-audio'
import { readDownloadedPlayable, removeDownloadedTrack } from './download-store'
import { abortReason, checkAbort, parseVideoId, searchMusic, searchVideos, stream, validVideoId, YouTubeError, type Candidate, type StreamInfo } from './youtube'

// Mismos umbrales y comparación que src-tauri/src/youtube.rs y player.rs.
export const MIN_SCORE = 45
export const CONFIDENT_SCORE = 70
const YOUTUBE_BASE = 250_000_000_000_000
const PODCAST_BASE = 500_000_000_000_000
const LOCAL_BASE = 1_000_000_000_000_000
const OTHER_VERSIONS = ['live', 'en vivo', 'en directo', 'directo', 'concierto', 'concert', 'cover', 'karaoke', 'instrumental',
  'remix', 'acoustic', 'acustico', 'sped up', 'slowed', 'nightcore', '8d', 'reverb', 'tribute', 'tributo']
const ACCENTS: Record<string, string> = {}
for (const [letters, replacement] of [['áàäâãå', 'a'], ['éèëê', 'e'], ['íìïî', 'i'], ['óòöôõø', 'o'], ['úùüû', 'u'], ['ñ', 'n'], ['ç', 'c']]) {
  for (const letter of letters) ACCENTS[letter] = replacement
}

export function normalize(value: string): string {
  return [...value.toLowerCase()].map((character) => ACCENTS[character] ?? (/^[\p{L}\p{N}]$/u.test(character) ? character : ' ')).join('').trim().replace(/\s+/g, ' ')
}
export function stripBrackets(value: string): string {
  let result = '', depth = 0
  for (const character of value) {
    if (character === '(' || character === '[') depth++
    else if (character === ')' || character === ']') depth = Math.max(0, depth - 1)
    else if (depth === 0) result += character
  }
  return result.trim()
}
const baseTitle = (value: string) => normalize(stripBrackets(value).split(' - ')[0])
const jaccard = (left: string, right: string) => {
  const a = new Set(left.split(' ')), b = new Set(right.split(' '))
  return [...a].filter((word) => b.has(word)).length / new Set([...a, ...b]).size
}

export function scoreCandidate(track: TrackQuery, candidate: Candidate, rank: number): number {
  const distance = candidate.duration === null ? null : Math.abs(candidate.duration - track.duration)
  let score = distance === null ? 0 : distance <= 3 ? 40 : distance <= 7 ? 30 : distance <= 15 ? 10 : distance <= 60 ? -30 : -60
  const want = baseTitle(track.title), got = baseTitle(candidate.title)
  score += want === got ? normalize(track.title) === normalize(candidate.title) ? 34 : 30
    : want && got && (got.includes(want) || want.includes(got)) ? 18 : jaccard(want, got) >= 0.5 ? 10 : -40
  const artist = normalize(track.artist), artists = candidate.artists.map(normalize)
  score += artists.some((value) => value === artist) ? 25
    : artists.some((value) => value && (value.includes(artist) || artist.includes(value))) ? 18 : -15
  if (candidate.album !== null && baseTitle(candidate.album) === baseTitle(track.album)) score += 8
  const original = ` ${normalize(track.title)} `, title = ` ${normalize(candidate.title)} `
  for (const version of OTHER_VERSIONS) if (title.includes(` ${version} `) && !original.includes(` ${version} `)) score -= 35
  return score + 5 - Math.min(rank, 5)
}

interface Scored extends Candidate { score: number; origin: 'music' | 'youtube' }
interface Operation { controller: AbortController; promise: Promise<Playable>; kind: 'resolve' | 'choose' }
const operations = new Map<number, Operation>()

function validTrack(track: TrackQuery): void {
  if (!Number.isSafeInteger(track.id) || track.id <= 0 || !track.title?.trim() || !track.artist?.trim()) throw new Error('La canción no tiene metadatos válidos.')
  if (track.id >= LOCAL_BASE) throw new Error('Este archivo local no está disponible en la biblioteca web.')
}
const isDirect = (track: TrackQuery) => track.id >= YOUTUBE_BASE && track.id < PODCAST_BASE
const isPodcast = (track: TrackQuery) => track.id >= PODCAST_BASE && track.id < LOCAL_BASE
const playable = (info: StreamInfo, title = info.title, channel = info.channel): Playable => ({ videoId: info.videoId, url: info.url, title, channel, local: false })
const choice = (candidate: Candidate, score: number, verified: boolean) => ({ videoId: candidate.videoId, title: candidate.title,
  channel: candidate.artists.join(', '), duration: candidate.duration, score, verified })

type OfficialFallbackReason = 'unavailable' | 'format'
export interface OfficialFallback {
  readonly trackId: number
  readonly source: Alternative
  readonly reason: OfficialFallbackReason
}

const unavailableAudio = (error: unknown): error is YouTubeError & { code: OfficialFallbackReason } =>
  error instanceof YouTubeError && (error.code === 'unavailable' || error.code === 'format')
const karaoke = (title: string) => /(?:^|[^\p{L}\p{N}])karaoke(?:a)?(?:$|[^\p{L}\p{N}])/iu.test(title)

/** Only metadata can cross into the visible player; signed audio URLs stay in the resolver. */
function officialSource(track: TrackQuery, source: Alternative): Alternative | null {
  if (!source || !validVideoId(source.videoId) || !Number.isFinite(source.score) || source.score < MIN_SCORE ||
    typeof source.title !== 'string' || !source.title.trim() || typeof source.artists !== 'string' || !source.artists.trim() ||
    (source.album !== null && typeof source.album !== 'string') ||
    (source.duration !== null && (!Number.isFinite(source.duration) || source.duration <= 0 || source.duration > 604800)) ||
    !['music', 'youtube'].includes(source.origin) ||
    (karaoke(source.title) && !karaoke(track.title) && !source.current)) return null
  return { videoId: source.videoId, title: source.title.trim().slice(0, 500), artists: source.artists.trim().slice(0, 500),
    album: source.album?.slice(0, 500) ?? null, duration: source.duration, score: source.score, origin: source.origin, current: Boolean(source.current) }
}

/** A direct-audio failure may offer a matched visible video, never open or start it itself. */
export class OfficialFallbackError extends YouTubeError {
  readonly fallback: OfficialFallback
  constructor(readonly originalError: YouTubeError & { code: OfficialFallbackReason }, track: TrackQuery, source: Alternative) {
    super(originalError.message, originalError.code)
    const valid = officialSource(track, source)
    if (!valid) throw new Error('La fuente alternativa de YouTube no es válida.')
    this.cause = originalError
    this.fallback = Object.freeze({ trackId: track.id, source: Object.freeze(valid), reason: originalError.code })
  }
}

/** The active player must still check its own cancellation token before opening the video. */
export function getOfficialFallback(track: TrackQuery, error: unknown): Alternative | null {
  try { validTrack(track) } catch { return null }
  if (isPodcast(track) || !(error instanceof OfficialFallbackError) || error.fallback.trackId !== track.id ||
    !unavailableAudio(error) || error.fallback.reason !== error.code) return null
  return officialSource(track, error.fallback.source)
}

function operation(track: TrackQuery, kind: Operation['kind'], refresh: boolean, work: (signal: AbortSignal) => Promise<Playable>): Promise<Playable> {
  const previous = operations.get(track.id)
  if (kind === 'resolve' && previous && (!refresh || previous.kind === 'choose')) return previous.promise
  previous?.controller.abort(new DOMException('Operación sustituida.', 'AbortError'))
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new YouTubeError('La búsqueda de audio tardó demasiado. Vuelve a intentarlo.', 'timeout')), 45000)
  const job: Operation = { controller, kind, promise: Promise.resolve(null as unknown as Playable) }
  job.promise = Promise.resolve().then(() => work(controller.signal)).finally(() => {
    clearTimeout(timeout)
    if (operations.get(track.id) === job) operations.delete(track.id)
  })
  operations.set(track.id, job)
  return job.promise
}

// Sustituye al fallback yt-dlp por la búsqueda HTTP WEB ya probada en el navegador.
function splitArtist(candidate: Candidate, artist: string): Candidate {
  const parts = candidate.title.split(' - ')
  if (parts.length < 2) return candidate
  const first = parts.shift()!, last = parts.join(' - '), wanted = normalize(artist)
  if (normalize(first).includes(wanted)) return { ...candidate, title: last.trim(), artists: [artist] }
  if (normalize(last).includes(wanted)) return { ...candidate, title: first.trim(), artists: [artist] }
  return candidate
}

async function searchWeb(track: TrackQuery, signal?: AbortSignal): Promise<Scored[]> {
  const videos = await searchVideos(`${track.artist} ${stripBrackets(track.title)}`, signal)
  checkAbort(signal)
  return videos.slice(0, 8).map((original, rank) => {
    const candidate = splitArtist(original, track.artist)
    return { ...candidate, score: scoreCandidate(track, candidate, rank + 3), origin: 'youtube' as const }
  })
}

async function search(track: TrackQuery, everywhere: boolean, signal?: AbortSignal): Promise<{ candidates: Scored[]; webSearched: boolean }> {
  const query = `${track.artist} ${stripBrackets(track.title)}`
  const found: Scored[] = []
  const failures: Error[] = []
  try {
    const music = await searchMusic(query, signal)
    checkAbort(signal)
    found.push(...music.slice(0, 10).map((candidate, rank) => ({ ...candidate, score: scoreCandidate(track, candidate, rank), origin: 'music' as const })))
  } catch (error) { checkAbort(signal); failures.push(error instanceof Error ? error : new Error('No se pudo buscar en YouTube Music.')) }
  const webSearched = everywhere || Math.max(-Infinity, ...found.map((candidate) => candidate.score)) < CONFIDENT_SCORE
  if (webSearched) {
    try {
      found.push(...await searchWeb(track, signal))
    } catch (error) { checkAbort(signal); failures.push(error instanceof Error ? error : new Error('No se pudo buscar en YouTube.')) }
  }
  if (!found.length && failures.length) throw failures[0]
  found.sort((a, b) => b.score - a.score)
  const seen = new Set<string>()
  return { candidates: found.filter((candidate) => !seen.has(candidate.videoId) && !!seen.add(candidate.videoId)), webSearched }
}

export async function resolveTrack(track: TrackQuery, refresh = false): Promise<Playable> {
  return resolve(track, refresh, true)
}

/** La descarga resuelve la fuente remota sin volver a seleccionar su propia copia local. */
export async function resolveRemoteTrack(track: TrackQuery, refresh = false): Promise<Playable> {
  return resolve(track, refresh, false)
}

async function resolve(track: TrackQuery, refresh: boolean, includeDownloaded: boolean): Promise<Playable> {
  validTrack(track)
  return operation(track, 'resolve', refresh, async (signal) => {
    if (includeDownloaded) {
      const downloaded = await readDownloadedPlayable(track.id)
      checkAbort(signal)
      if (downloaded) return downloaded
    }
    if (isPodcast(track)) return resolvePodcastTrack(track, refresh, signal)
    if (isDirect(track)) {
      const videoId = await readYouTubeVideo(track.id)
      checkAbort(signal)
      if (!validVideoId(videoId)) throw new Error('No se encuentra el vídeo de esta canción de YouTube.')
      try { return playable(await stream(videoId, refresh, signal), track.title, track.artist) }
      catch (error) {
        checkAbort(signal)
        if (unavailableAudio(error)) throw new OfficialFallbackError(error, track, { videoId, title: track.title,
          artists: track.artist, album: track.album || null, duration: track.duration || null, score: 100, origin: 'youtube', current: true })
        throw error
      }
    }
    const saved = await readSourceChoice(track.id)
    checkAbort(signal)
    let missing: string | null = null
    const rejected: { source: Alternative; error: YouTubeError & { code: OfficialFallbackReason }; manual: boolean }[] = []
    if (saved && validVideoId(saved.videoId)) {
      try { return playable(await stream(saved.videoId, refresh, signal), saved.title, saved.channel) }
      catch (error) {
        checkAbort(signal)
        if (unavailableAudio(error)) {
          missing = saved.videoId
          const source = officialSource(track, { videoId: saved.videoId, title: saved.title, artists: saved.channel,
            album: null, duration: saved.duration, score: saved.score, origin: 'youtube', current: saved.verified })
          if (source) rejected.push({ source, error, manual: saved.verified })
        }
        else throw error
      }
    }
    const result = await search(track, false, signal)
    const attempted = new Set<string>(missing ? [missing] : [])
    let sourceRejected = missing !== null
    let transientFailure = false
    let lastError: Error = new Error('No se ha encontrado una grabación compatible en YouTube. Prueba «¿No es esta canción?».')
    const attempt = async (candidates: Scored[]): Promise<Playable | null> => {
      let count = 0
      for (const candidate of candidates) {
        if (candidate.score < MIN_SCORE || attempted.has(candidate.videoId)) continue
        if (count++ >= 3) break
        attempted.add(candidate.videoId)
        checkAbort(signal)
        let info: StreamInfo
        try {
          info = await stream(candidate.videoId, refresh, signal)
        } catch (error) {
          checkAbort(signal)
          lastError = error instanceof Error ? error : new Error('No se pudo cargar el audio.')
          if (unavailableAudio(error)) {
            sourceRejected = true
            const source = officialSource(track, { videoId: candidate.videoId, title: candidate.title,
              artists: candidate.artists.join(', '), album: candidate.album, duration: candidate.duration,
              score: candidate.score, origin: candidate.origin, current: false })
            if (source) rejected.push({ source, error, manual: false })
          }
          else transientFailure = true
          continue
        }
        checkAbort(signal)
        await saveSourceChoice(track.id, choice(candidate, candidate.score, false))
        checkAbort(signal)
        return playable(info, candidate.title, candidate.artists.join(', '))
      }
      return null
    }
    const initial = await attempt(result.candidates)
    if (initial) return initial
    // Una buena coincidencia de Music puede estar retirada o no ofrecer MP4.
    // Ampliar una sola vez, sin repetir vídeos ni sustituir por fallos de red.
    if (!result.webSearched && sourceRejected && !transientFailure) {
      const fallback = await searchWeb(track, signal)
      fallback.sort((a, b) => b.score - a.score)
      const recovered = await attempt(fallback)
      if (recovered) return recovered
    }
    if (sourceRejected && !transientFailure) {
      rejected.sort((a, b) => Number(b.manual) - Number(a.manual) || b.source.score - a.source.score)
      const fallback = rejected[0]
      if (fallback) throw new OfficialFallbackError(unavailableAudio(lastError) ? lastError : fallback.error, track, fallback.source)
    }
    throw lastError
  })
}

export async function alternatives(track: TrackQuery, signal?: AbortSignal): Promise<Alternative[]> {
  checkAbort(signal)
  validTrack(track)
  if (isPodcast(track)) throw new Error('Los episodios usan el audio original del pódcast.')
  if (isDirect(track)) throw new Error('Esta canción usa el enlace de YouTube que añadiste.')
  const saved = await readSourceChoice(track.id)
  checkAbort(signal)
  const rows: Alternative[] = (await search(track, true, signal)).candidates.slice(0, 16).map((candidate) => ({ videoId: candidate.videoId,
    title: candidate.title, artists: candidate.artists.join(', '), album: candidate.album, duration: candidate.duration,
    score: candidate.score, origin: candidate.origin, current: candidate.videoId === saved?.videoId }))
  if (saved && !rows.some((row) => row.current)) rows.unshift({ videoId: saved.videoId, title: saved.title,
    artists: saved.channel, album: null, duration: saved.duration, score: saved.score, origin: 'youtube', current: true })
  checkAbort(signal)
  return rows
}

export async function chooseSource(track: TrackQuery, videoId: string): Promise<Playable> {
  validTrack(track)
  if (isPodcast(track)) throw new Error('Los episodios usan el audio original del pódcast.')
  if (isDirect(track)) throw new Error('Esta canción usa el enlace de YouTube que añadiste.')
  if (!validVideoId(videoId)) throw new Error('El vídeo de YouTube no es válido.')
  return operation(track, 'choose', true, async (signal) => {
    const info = await stream(videoId, false, signal)
    checkAbort(signal)
    await removeDownloadedTrack(track.id)
    checkAbort(signal)
    await saveSourceChoice(track.id, { videoId, title: info.title, channel: info.channel, duration: info.duration, score: 100, verified: true })
    checkAbort(signal)
    return playable(info)
  })
}

export async function previewYouTube(url: string): Promise<YouTubeTrackPreview> {
  const videoId = parseVideoId(url)
  const info = await stream(videoId)
  return { videoId, title: info.title, artist: info.channel, duration: info.duration ?? 0,
    cover: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` }
}

/** Para el desmontaje del port: la navegación entre pantallas no lo llama. */
export function cancelAudioRequests(): void {
  for (const value of operations.values()) value.controller.abort(abortReason())
  operations.clear()
}
