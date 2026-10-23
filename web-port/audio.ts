import type { Alternative, Playable, TrackQuery, YouTubeTrackPreview } from '../src/lib/types'
import { readSourceChoice, saveSourceChoice, readYouTubeVideo } from './storage'
import { resolvePodcastTrack } from './podcast-audio'
import { readDownloadedPlayable, removeDownloadedTrack } from './download-store'
import { resolveCatalogSource } from './catalog-sources'
import { disposeVerifiedAudio, resolveVerifiedAudio } from './verified-audio'
import { disposeFunkwhaleAudio, resolveFunkwhaleAudio } from './funkwhale-audio'
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
interface Operation { controller: AbortController; promise: Promise<Playable>; kind: 'resolve' | 'choose' | 'download'; trackId: number }
const operations = new Map<string, Operation>()

function validTrack(track: TrackQuery): void {
  if (!Number.isSafeInteger(track.id) || track.id <= 0 || !track.title?.trim() || !track.artist?.trim()) throw new Error('La canción no tiene metadatos válidos.')
  if (track.id >= LOCAL_BASE) throw new Error('Este archivo local no está disponible en la biblioteca web.')
}
const isDirect = (track: TrackQuery) => track.id >= YOUTUBE_BASE && track.id < PODCAST_BASE
const isPodcast = (track: TrackQuery) => track.id >= PODCAST_BASE && track.id < LOCAL_BASE
const playable = (info: StreamInfo, title = info.title, channel = info.channel): Playable => ({ videoId: info.videoId, url: info.url, title, channel, local: false,
  ...(info.transport === 'p1' ? { source: { provider: 'youtube-p1' as const, id: info.videoId, expiresAt: info.expiresAt,
    download: { allowed: false } } } : {}),
})
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
const transientAudio = (error: unknown): error is YouTubeError =>
  error instanceof YouTubeError && (error.code === 'network' || error.code === 'timeout')
const retryableAudio = (error: unknown): error is YouTubeError => error instanceof YouTubeError &&
  ['unavailable', 'format', 'network', 'timeout'].includes(error.code)
const karaoke = (title: string) => /(?:^|[^\p{L}\p{N}])karaoke(?:a)?(?:$|[^\p{L}\p{N}])/iu.test(title)

function retryBackoff(ms: number, signal: AbortSignal): Promise<void> {
  checkAbort(signal)
  return new Promise((resolve, reject) => {
    let finished = false, timer: ReturnType<typeof setTimeout>
    const finish = (error?: Error) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      error ? reject(error) : resolve()
    }
    const cancel = () => finish(abortReason(signal))
    signal.addEventListener('abort', cancel, { once: true })
    timer = setTimeout(() => finish(signal.aborted ? abortReason(signal) : undefined), ms)
    if (signal.aborted) cancel()
  })
}

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
  // Selecting a source is an explicit change of recording for this ID. A
  // download must wait for that choice, and an older download cannot later
  // overwrite it with an automatically found YouTube association.
  if (kind === 'download') {
    const selection = operations.get(`play:${track.id}`)
    if (selection?.kind === 'choose') return selection.promise
  } else if (kind === 'choose') {
    const downloadKey = `download:${track.id}`
    operations.get(downloadKey)?.controller.abort(new DOMException('La fuente ha cambiado.', 'AbortError'))
    operations.delete(downloadKey)
  }
  const key = `${kind === 'download' ? 'download' : 'play'}:${track.id}`
  const previous = operations.get(key)
  if (kind !== 'choose' && previous && (!refresh || previous.kind === 'choose')) return previous.promise
  previous?.controller.abort(new DOMException('Operación sustituida.', 'AbortError'))
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new YouTubeError('La búsqueda de audio tardó demasiado. Vuelve a intentarlo.', 'timeout')), 45000)
  const job: Operation = { controller, kind, trackId: track.id, promise: Promise.resolve(null as unknown as Playable) }
  job.promise = Promise.resolve().then(() => work(controller.signal)).finally(() => {
    clearTimeout(timeout)
    if (operations.get(key) === job) operations.delete(key)
  })
  operations.set(key, job)
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
  return operation(track, includeDownloaded ? 'resolve' : 'download', refresh, async (signal) => {
    if (includeDownloaded) {
      const downloaded = await readDownloadedPlayable(track.id)
      checkAbort(signal)
      if (downloaded) return downloaded
    }
    if (isPodcast(track)) return resolvePodcastTrack(track, refresh, signal)
    let manualSource = false
    const exactLoaders = { verified: resolveVerifiedAudio, funkwhale: resolveFunkwhaleAudio, catalog: resolveCatalogSource }
    const exactAttempts = new Map<keyof typeof exactLoaders, Promise<Playable | null>>()
    const exactSource = (provider: keyof typeof exactLoaders): Promise<Playable | null> => {
      checkAbort(signal)
      let pending = exactAttempts.get(provider)
      if (!pending) {
        pending = (async () => {
          try { const value = await exactLoaders[provider](track, signal); checkAbort(signal); return value }
          catch { checkAbort(signal); return null }
        })()
        exactAttempts.set(provider, pending)
      }
      return pending
    }
    const finishSource = async (original: Playable): Promise<Playable> => {
      checkAbort(signal)
      if (includeDownloaded || manualSource || isDirect(track) || original.source?.download?.allowed !== false) return original
      // These providers already verify exact catalog identity. Download rescue
      // never performs another YouTube search or rewrites its source choice.
      for (const provider of ['verified', 'funkwhale', 'catalog'] as const) {
        const source = await exactSource(provider)
        checkAbort(signal)
        if (source?.source?.download?.allowed === true) return source
      }
      return original
    }
    const finalAudio = async (error: YouTubeError, source: Alternative, persist = false): Promise<Playable> => {
      const selected = officialSource(track, source)
      if (!selected || !retryableAudio(error)) throw error
      // Downloads retain their own transfer/retry policy. Only the already
      // selected final recording gets two fresh playback attempts: no new
      // searches, no per-candidate multiplication, and no new 45-second budget.
      if (!includeDownloaded) {
        if (unavailableAudio(error)) throw new OfficialFallbackError(error, track, selected)
        throw error
      }
      let lastError: YouTubeError = error
      for (const [index, delay] of [250, 750].entries()) {
        checkAbort(signal)
        await retryBackoff(delay, signal)
        checkAbort(signal)
        if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('pletina:audio-retry', {
          detail: { trackId: track.id, attempt: index + 1, total: 2 },
        }))
        // A UI event listener may itself cancel or replace this operation.
        checkAbort(signal)
        let info: StreamInfo
        try { info = await stream(selected.videoId, true, signal, includeDownloaded) }
        catch (next) {
          checkAbort(signal)
          if (!retryableAudio(next)) throw next
          lastError = next
          continue
        }
        checkAbort(signal)
        if (persist) {
          await saveSourceChoice(track.id, { videoId: selected.videoId, title: selected.title, channel: selected.artists,
            duration: selected.duration, score: selected.score, verified: false })
          checkAbort(signal)
        }
        return playable(info, selected.title, selected.artists)
      }
      // A new network failure is not evidence that the source needs a visible
      // video. Keep that category instead of presenting it as unavailable audio.
      if (!unavailableAudio(lastError)) throw lastError
      throw new OfficialFallbackError(lastError, track, selected)
    }
    if (isDirect(track)) {
      const videoId = await readYouTubeVideo(track.id)
      checkAbort(signal)
      if (!validVideoId(videoId)) throw new Error('No se encuentra el vídeo de esta canción de YouTube.')
      try { return playable(await stream(videoId, refresh, signal, includeDownloaded), track.title, track.artist) }
      catch (error) {
        checkAbort(signal)
        if (retryableAudio(error)) return finalAudio(error, { videoId, title: track.title,
          artists: track.artist, album: track.album || null, duration: track.duration || null, score: 100, origin: 'youtube', current: true })
        throw error
      }
    }
    const recoverFunkwhale = () => exactSource('funkwhale')
    // A transport failure does not establish absence. Playback may nevertheless
    // try an independent, exact-identity provider, without rewriting its source
    // choice or changing the original failure if that provider cannot recover.
    // Downloads retain their interruption/retry policy and explicit sources.
    const recoverTransientCatalog = (error: unknown): Promise<Playable | null> =>
      includeDownloaded && !manualSource && transientAudio(error) ? exactSource('catalog') : Promise.resolve(null)
    const saved = await readSourceChoice(track.id)
    checkAbort(signal)
    manualSource = saved?.verified === true
    let missing: string | null = null
    const rejected: { source: Alternative; error: YouTubeError; manual: boolean }[] = []
    if (saved && validVideoId(saved.videoId)) {
      try { return await finishSource(playable(await stream(saved.videoId, refresh, signal, includeDownloaded), saved.title, saved.channel)) }
      catch (error) {
        checkAbort(signal)
        if (retryableAudio(error)) {
          const source = officialSource(track, { videoId: saved.videoId, title: saved.title, artists: saved.channel,
            album: null, duration: saved.duration, score: saved.score, origin: 'youtube', current: saved.verified })
          if (saved.verified) {
            if (source) return finalAudio(error, source)
            throw error
          }
          if (!unavailableAudio(error)) {
            const verified = await exactSource('verified')
            if (verified) return finishSource(verified)
            const recovered = await recoverFunkwhale()
            if (recovered) return finishSource(recovered)
            const external = await recoverTransientCatalog(error)
            if (external) return finishSource(external)
            if (source) return finalAudio(error, source)
            throw error
          }
          missing = saved.videoId
          if (source) rejected.push({ source, error, manual: false })
        }
        else {
          if (!saved.verified) {
            const recovered = await recoverFunkwhale()
            if (recovered) return finishSource(recovered)
          }
          throw error
        }
      }
    }
    // Una asociación revisada no busca por texto: comprueba identidad y los bytes
    // completos antes de entregar un Blob local al mismo reproductor de audio.
    try {
      const verified = await exactSource('verified')
      checkAbort(signal)
      if (verified) return finishSource(verified)
    } catch { checkAbort(signal) }
    // Un fallo temporal de YouTube tampoco impide probar bytes de otra fuente
    // ya identificada. No se guarda ese fallo como ausencia ni se cambia la
    // elección explícita del usuario.
    let result: Awaited<ReturnType<typeof search>>
    try { result = await search(track, false, signal) }
    catch (error) {
      checkAbort(signal)
      const recovered = await recoverFunkwhale()
      if (recovered) return finishSource(recovered)
      const external = await recoverTransientCatalog(error)
      if (external) return finishSource(external)
      throw error
    }
    const attempted = new Set<string>(missing ? [missing] : [])
    let sourceRejected = missing !== null
    let transientFailure = false
    let terminalFailure: Error | undefined
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
          info = await stream(candidate.videoId, refresh, signal, includeDownloaded)
        } catch (error) {
          checkAbort(signal)
          lastError = error instanceof Error ? error : new Error('No se pudo cargar el audio.')
          if (unavailableAudio(error)) sourceRejected = true
          else transientFailure = true
          if (!retryableAudio(error)) terminalFailure = lastError
          if (retryableAudio(error)) {
            const source = officialSource(track, { videoId: candidate.videoId, title: candidate.title,
              artists: candidate.artists.join(', '), album: candidate.album, duration: candidate.duration,
              score: candidate.score, origin: candidate.origin, current: false })
            if (source) rejected.push({ source, error, manual: false })
          }
          continue
        }
        checkAbort(signal)
        const original = playable(info, candidate.title, candidate.artists.join(', '))
        const selected = await finishSource(original)
        checkAbort(signal)
        if (selected !== original) return selected
        await saveSourceChoice(track.id, choice(candidate, candidate.score, false))
        checkAbort(signal)
        return original
      }
      return null
    }
    const initial = await attempt(result.candidates)
    if (initial) return initial
    // Una buena coincidencia de Music puede estar retirada o no ofrecer MP4.
    // Ampliar una sola vez, sin repetir vídeos ni sustituir por fallos de red.
    if (!result.webSearched && sourceRejected && !transientFailure) {
      try {
        const fallback = await searchWeb(track, signal)
        fallback.sort((a, b) => b.score - a.score)
        const recovered = await attempt(fallback)
        if (recovered) return recovered
      } catch (error) {
        checkAbort(signal)
        transientFailure = true
        lastError = error instanceof Error ? error : lastError
        if (!retryableAudio(lastError)) terminalFailure = lastError
      }
    }
    const funkwhale = await recoverFunkwhale()
    if (funkwhale) return finishSource(funkwhale)
    // Un catálogo alternativo sólo puede rescatar una identidad verificada. No cambia
    // la fuente escogida explícitamente por el usuario ni interpreta mala red como ausencia.
    const transientCatalogPlayback = includeDownloaded && !manualSource && !terminalFailure &&
      (transientAudio(lastError) || rejected.some((entry) => transientAudio(entry.error)))
    if ((!transientFailure || transientCatalogPlayback) && !rejected.some((entry) => entry.manual)) {
      try {
        const external = await exactSource('catalog')
        checkAbort(signal)
        if (external) return finishSource(external)
      } catch {
        // Un proveedor adicional caído no elimina el recurso que ya ofrecía YouTube.
        // La cancelación y el plazo global siguen siendo vinculantes.
        checkAbort(signal)
      }
    }
    if (terminalFailure) throw terminalFailure
    if (rejected.length) {
      rejected.sort((a, b) => Number(b.manual) - Number(a.manual) || b.source.score - a.source.score)
      const fallback = rejected[0]
      if (fallback) return finalAudio(fallback.error, fallback.source, !fallback.manual)
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

/** Keep only the current/next resolutions when the user changes the queue. */
export function retainAudioRequests(trackIds: readonly number[]): void {
  const retained = new Set(trackIds)
  for (const [key, value] of operations) {
    if (value.kind === 'download' || retained.has(value.trackId)) continue
    value.controller.abort(new DOMException('La canción ha cambiado.', 'AbortError'))
    operations.delete(key)
  }
}

/** Para el desmontaje del port: la navegación entre pantallas no lo llama. */
export function cancelAudioRequests(): void {
  for (const value of operations.values()) value.controller.abort(abortReason())
  operations.clear()
  disposeVerifiedAudio()
  disposeFunkwhaleAudio()
}
