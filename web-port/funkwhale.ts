import type { TrackQuery } from '../src/lib/types'

const POD = 'https://open.audio'
const MAX_JSON = 1024 * 1024
export const FUNKWHALE_MAX_AUDIO_BYTES = 32 * 1024 * 1024
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
type Raw = Record<string, unknown>
export type FunkwhaleCodec = 'mp3' | 'aac' | 'vorbis' | 'opus' | 'flac' | 'pcm'
export interface FunkwhaleSourceLocator {
  pod: string
  trackId: number
  trackUuid: string
  uploadUuid: string
}
export interface FunkwhaleCandidate extends FunkwhaleSourceLocator {
  provider: 'funkwhale'
  apiVersion: 'v2'
  title: string
  titleVersion: string | null
  artist: string
  album: string
  duration: number
  contentLength: number
  mime: string
  extension: string
  codec: FunkwhaleCodec
  bitrate: number | null
  lossless: boolean
  isrc: string | null
  recordingMbid: string | null
  declaredLicense: string | null
}
export interface FunkwhaleAudioFile { bytes: Uint8Array; sha256: string; mime: string }
interface TransportOptions { fetch?: typeof fetch; timeout?: number }
export interface FunkwhaleDiscoveryOptions extends TransportOptions {
  verifiedSources?: readonly FunkwhaleSourceLocator[]
  canPlayType?: (mime: string) => CanPlayTypeResult
}
export class FunkwhaleError extends Error {
  constructor(message: string, readonly code: 'network' | 'timeout' | 'protocol' | 'permission') {
    super(message)
    this.name = 'FunkwhaleError'
  }
}
const raw = (value: unknown): Raw | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Raw : null
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() && value.length <= 1000 ? value.trim() : null
const normalize = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ')
const isrc = (value: unknown): string | null => {
  const normalized = typeof value === 'string' ? value.trim().replaceAll('-', '').toUpperCase() : ''
  return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(normalized) ? normalized : null
}
const validLocator = (value: FunkwhaleSourceLocator) => value && value.pod === POD && Number.isSafeInteger(value.trackId) && value.trackId > 0 &&
  typeof value.trackUuid === 'string' && UUID.test(value.trackUuid) && typeof value.uploadUuid === 'string' && UUID.test(value.uploadUuid)
const validTrack = (track: TrackQuery) => track && Number.isSafeInteger(track.id) && track.id > 0 && track.id < 250_000_000_000_000 &&
  text(track.title) && normalize(track.title) && text(track.artist) && normalize(track.artist) && typeof track.album === 'string' && track.album.length <= 1000 &&
  (track.titleVersion == null || typeof track.titleVersion === 'string' && track.titleVersion.length <= 1000) &&
  Number.isFinite(track.duration) && track.duration > 0 && track.duration <= 604800 && isrc(track.isrc)
const fullTitle = (title: string, version: string | null) => {
  const normalized = normalize(title), suffix = version ? normalize(version) : ''
  return suffix && !` ${normalized} `.includes(` ${suffix} `) ? normalize(`${title} ${version}`) : normalized
}
const checkAbort = (signal: AbortSignal) => { if (signal.aborted) throw signal.reason ?? new DOMException('Cancelado.', 'AbortError') }

// One deadline covers every request and body read, including fetch implementations
// which fail to reject when their signal is aborted.
async function deadline<T>(signal: AbortSignal | undefined, timeout: number, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason ?? new DOMException('Cancelado.', 'AbortError'))
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  const timer = setTimeout(() => controller.abort(new FunkwhaleError('La fuente de audio tardó demasiado en responder.', 'timeout')), timeout)
  let rejectAbort: (() => void) | undefined
  const stopped = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(controller.signal.reason ?? new DOMException('Cancelado.', 'AbortError'))
    controller.signal.addEventListener('abort', rejectAbort, { once: true })
    if (controller.signal.aborted) rejectAbort()
  })
  try { checkAbort(controller.signal); return await Promise.race([action(controller.signal), stopped]) }
  catch (error) {
    checkAbort(controller.signal)
    if (error instanceof FunkwhaleError) throw error
    throw new FunkwhaleError('No se pudo consultar la fuente de audio.', 'network')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort)
  }
}
const timeoutFor = (requested: number | undefined, maximum: number) => typeof requested === 'number' && Number.isFinite(requested) && requested > 0 ? Math.min(requested, maximum) : maximum
async function bodyBytes(response: Response, signal: AbortSignal, maximum: number, expected?: number): Promise<Uint8Array> {
  const fail = (message: string): never => { void response.body?.cancel().catch(() => {}); throw new FunkwhaleError(message, 'protocol') }
  if (!response.ok || response.status !== 200 || response.type === 'opaque' || response.type === 'opaqueredirect') fail('La fuente no devolvió un archivo completo legible.')
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maximum || expected !== undefined && Number(declared) !== expected)) fail('El tamaño del archivo no coincide con los metadatos.')
  if (response.headers.has('content-range')) fail('La fuente devolvió sólo una parte del archivo.')
  const body = response.body
  if (!body) fail('La fuente no devolvió audio legible.')
  const reader = body!.getReader(), chunks: Uint8Array[] = []
  let count = 0
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    checkAbort(signal)
    while (true) {
      const part = await reader.read()
      checkAbort(signal)
      if (part.done) break
      count += part.value.byteLength
      if (count > maximum || expected !== undefined && count > expected) throw new FunkwhaleError('El archivo supera el tamaño permitido.', 'protocol')
      chunks.push(part.value)
    }
    if (!count || expected !== undefined && count !== expected) throw new FunkwhaleError('El archivo de audio está incompleto.', 'protocol')
    const bytes = new Uint8Array(count)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return bytes
  } catch (error) { void reader.cancel().catch(() => {}); throw error }
  finally { signal.removeEventListener('abort', abort); reader.releaseLock() }
}
async function json(url: string, signal: AbortSignal, transport: typeof fetch): Promise<Raw> {
  const response = await transport(url, { signal, credentials: 'omit', mode: 'cors', referrerPolicy: 'no-referrer', redirect: 'error' })
  if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new FunkwhaleError(`La fuente no respondió correctamente (${response.status}).`, 'network') }
  const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
  if (mime !== 'application/json') { void response.body?.cancel().catch(() => {}); throw new FunkwhaleError('La fuente devolvió metadatos no válidos.', 'protocol') }
  const bytes = await bodyBytes(response, signal, MAX_JSON)
  try { const result = raw(JSON.parse(new TextDecoder().decode(bytes))); if (result) return result } catch { /* protocol below */ }
  throw new FunkwhaleError('La fuente devolvió metadatos no válidos.', 'protocol')
}
function format(mimeValue: unknown, extensionValue: unknown, codecValue?: unknown): { mime: string; extension: string; codec: FunkwhaleCodec; lossless: boolean; probe: string } | null {
  const mime = typeof mimeValue === 'string' ? mimeValue.toLowerCase().split(';')[0].trim() : ''
  const extension = typeof extensionValue === 'string' ? extensionValue.toLowerCase().replace(/^\./, '') : ''
  const codec = typeof codecValue === 'string' ? codecValue.toLowerCase() : ''
  if (mime === 'audio/mpeg' && extension === 'mp3' && (!codec || codec === 'mp3')) return { mime, extension, codec: 'mp3', lossless: false, probe: 'audio/mpeg' }
  if ((mime === 'audio/ogg' || mime === 'application/ogg') && ['ogg', 'oga', 'opus'].includes(extension) && (!codec || ['vorbis', 'opus'].includes(codec))) {
    const encoding = codec === 'opus' || extension === 'opus' ? 'opus' : 'vorbis'
    return { mime: 'audio/ogg', extension, codec: encoding, lossless: false, probe: `audio/ogg; codecs="${encoding}"` }
  }
  if (['audio/flac', 'audio/x-flac'].includes(mime) && extension === 'flac' && (!codec || codec === 'flac')) return { mime: 'audio/flac', extension, codec: 'flac', lossless: true, probe: 'audio/flac' }
  if (['audio/wav', 'audio/x-wav', 'audio/wave'].includes(mime) && extension === 'wav' && (!codec || codec === 'pcm')) return { mime: 'audio/wav', extension, codec: 'pcm', lossless: true, probe: 'audio/wav' }
  if (mime === 'audio/mp4' && ['m4a', 'mp4'].includes(extension) && (!codec || ['aac', 'mp4a.40.2'].includes(codec))) return { mime, extension, codec: 'aac', lossless: false, probe: 'audio/mp4; codecs="mp4a.40.2"' }
  if (mime === 'audio/aac' && extension === 'aac' && (!codec || codec === 'aac')) return { mime, extension, codec: 'aac', lossless: false, probe: 'audio/aac' }
  return null
}
function listenLocator(value: unknown): { trackUuid: string; uploadUuid: string } | null {
  if (typeof value !== 'string' || value.length > 500) return null
  try {
    const url = new URL(value, POD), trackUuid = url.pathname.match(/^\/api\/v2\/listen\/([a-f0-9-]+)\/$/)?.[1]
    const uploadUuid = url.searchParams.get('upload')
    return url.origin === POD && !url.username && !url.password && !url.hash && trackUuid && UUID.test(trackUuid) && uploadUuid && UUID.test(uploadUuid) &&
      [...url.searchParams].length === 1 && url.searchParams.has('upload') ? { trackUuid, uploadUuid } : null
  } catch { return null }
}
function claims(track: TrackQuery, item: Raw, upload: Raw): { isrc: string | null; recordingMbid: string | null } | null {
  const codes = [item.isrc, upload.isrc].filter(value => value != null && value !== '')
  if (codes.some(value => !isrc(value) || isrc(value) !== isrc(track.isrc))) return null
  const mbids = [item.mbid, item.recording_mbid, upload.mbid, upload.recording_mbid].filter(value => value != null && value !== '')
  if (mbids.some(value => typeof value !== 'string' || !UUID.test(value)) || new Set(mbids).size > 1) return null
  return { isrc: codes.length ? isrc(codes[0]) : null, recordingMbid: mbids.length ? mbids[0] as string : null }
}
function candidates(track: TrackQuery, item: Raw, locators: readonly FunkwhaleSourceLocator[], canPlay: (mime: string) => CanPlayTypeResult): FunkwhaleCandidate[] {
  const title = text(item.title), album = text(raw(item.album)?.title), version = text(item.title_version ?? item.titleVersion)
  if (!title || !album || item.is_local !== true || item.is_playable !== true || item.content_category !== 'music' || item.is_private === true || item.is_public === false ||
    !Number.isSafeInteger(item.id) || fullTitle(title, version) !== fullTitle(track.title, text(track.titleVersion)) ||
    version && normalize(version) !== normalize(track.titleVersion ?? '') || normalize(album) !== normalize(track.album) || !Array.isArray(item.artist_credit) ||
    item.artist_credit.length < 1 || item.artist_credit.length > 10 || !Array.isArray(item.uploads) || item.uploads.length > 30) return []
  const credits = item.artist_credit.map(value => raw(value))
  if (credits.some(value => !value || !text(value.credit) || value.joinphrase != null && typeof value.joinphrase !== 'string')) return []
  const artist = credits.map(value => `${value!.credit}${value!.joinphrase ?? ''}`).join('').trim()
  if (normalize(artist) !== normalize(track.artist)) return []
  const result: FunkwhaleCandidate[] = []
  for (const value of item.uploads) {
    const upload = raw(value), route = listenLocator(upload?.listen_url)
    if (!upload || !route || route.uploadUuid !== upload.uuid || upload.is_local !== true || upload.is_private === true || upload.is_public === false || typeof upload.duration !== 'number' || !Number.isFinite(upload.duration) ||
      Math.abs(upload.duration - track.duration) > 3 || !Number.isSafeInteger(upload.size) || (upload.size as number) <= 0 || (upload.size as number) > FUNKWHALE_MAX_AUDIO_BYTES ||
      !locators.some(value => value.trackId === item.id && value.trackUuid === route.trackUuid && value.uploadUuid === route.uploadUuid)) continue
    const fid = typeof item.fid === 'string' ? item.fid : ''
    if (fid !== `${POD}/federation/music/tracks/${route.trackUuid}`) continue
    const identity = claims(track, item, upload), encoding = format(upload.mimetype, upload.extension, upload.codec)
    if (!identity || !encoding) continue
    let support: CanPlayTypeResult
    try { support = canPlay(encoding.probe) } catch { continue }
    if (support !== 'probably' && support !== 'maybe') continue
    const bitrate = typeof upload.bitrate === 'number' && Number.isFinite(upload.bitrate) && upload.bitrate > 0 && upload.bitrate <= 20_000_000 ? upload.bitrate : null
    result.push({ provider: 'funkwhale', pod: POD, apiVersion: 'v2', trackId: item.id as number, ...route, title, titleVersion: version, artist, album,
      duration: upload.duration, contentLength: upload.size as number, ...identity, mime: encoding.mime, extension: encoding.extension,
      codec: encoding.codec, bitrate, lossless: encoding.lossless, declaredLicense: text(item.license) })
  }
  return result
}
// Bitrates are comparable within a codec. Across codecs these broad quality
// tiers are a selection heuristic, not a claim about audible transparency.
const qualityTier = (candidate: FunkwhaleCandidate) => {
  if (candidate.lossless) return 3
  const rate = candidate.bitrate ?? candidate.contentLength * 8 / candidate.duration
  const highTierThreshold = candidate.codec === 'opus' ? 128000 : candidate.codec === 'aac' || candidate.codec === 'vorbis' ? 160000 : 192000
  return rate >= highTierThreshold ? 2 : rate >= highTierThreshold * 0.65 ? 1 : 0
}
export function rankFunkwhaleCandidates(values: readonly FunkwhaleCandidate[]): FunkwhaleCandidate[] {
  return [...values].sort((a, b) => qualityTier(b) - qualityTier(a) ||
    (a.codec === b.codec ? (b.bitrate ?? b.contentLength * 8 / b.duration) - (a.bitrate ?? a.contentLength * 8 / a.duration) : 0) ||
    a.contentLength - b.contentLength || a.trackId - b.trackId || a.uploadUuid.localeCompare(b.uploadUuid))
}

/** Discovery never authorizes identity: the caller must match an acoustic index
 * entry and then compare the complete-file hash before exposing these bytes. */
export async function discoverFunkwhaleCandidates(track: TrackQuery, signal?: AbortSignal, options: FunkwhaleDiscoveryOptions = {}): Promise<FunkwhaleCandidate[]> {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Cancelado.', 'AbortError')
  if (!validTrack(track) || !options.verifiedSources?.length) return []
  const locators = options.verifiedSources.filter(validLocator).slice(0, 20)
  if (!locators.length) return []
  const probe = options.canPlayType || typeof document === 'undefined' ? null : document.createElement('audio')
  const canPlay = options.canPlayType ?? ((mime: string) => probe?.canPlayType(mime) ?? '')
  return deadline(signal, timeoutFor(options.timeout, 12000), async localSignal => {
    const transport = options.fetch ?? fetch
    const node = await json(`${POD}/api/v1/instance/nodeinfo/2.0/`, localSignal, transport)
    if (raw(raw(node.metadata)?.library)?.anonymousCanListen !== true) throw new FunkwhaleError('Esta biblioteca no permite escuchar sin cuenta.', 'permission')
    const software = raw(node.software)
    if (software?.name !== 'funkwhale' || typeof software.version !== 'string' || !/^2\./.test(software.version)) throw new FunkwhaleError('La versión de la biblioteca todavía no es compatible.', 'protocol')
    const response = await json(`${POD}/api/v2/tracks/?q=${encodeURIComponent(track.title)}&page_size=20`, localSignal, transport)
    if (!Array.isArray(response.results) || response.results.length > 20) throw new FunkwhaleError('La biblioteca devolvió una lista no válida.', 'protocol')
    const found = response.results.flatMap(value => { const item = raw(value); return item ? candidates(track, item, locators, canPlay) : [] })
    return rankFunkwhaleCandidates(found.filter((value, index) => found.findIndex(other => other.trackUuid === value.trackUuid && other.uploadUuid === value.uploadUuid) === index))
  })
}

export async function fetchFunkwhaleAudio(candidate: FunkwhaleCandidate, signal?: AbortSignal, options: TransportOptions = {}): Promise<FunkwhaleAudioFile> {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Cancelado.', 'AbortError')
  const encoding = format(candidate?.mime, candidate?.extension, candidate?.codec)
  if (!validLocator(candidate) || candidate.provider !== 'funkwhale' || candidate.apiVersion !== 'v2' || !encoding ||
    !Number.isSafeInteger(candidate.contentLength) || candidate.contentLength <= 0 || candidate.contentLength > FUNKWHALE_MAX_AUDIO_BYTES) throw new FunkwhaleError('El archivo solicitado no pertenece a la biblioteca verificada.', 'protocol')
  return deadline(signal, timeoutFor(options.timeout, 20000), async localSignal => {
    const url = `${POD}/api/v2/listen/${candidate.trackUuid}/?upload=${candidate.uploadUuid}`
    const response = await (options.fetch ?? fetch)(url, { signal: localSignal, credentials: 'omit', mode: 'cors', referrerPolicy: 'no-referrer', redirect: 'follow' })
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new FunkwhaleError(`La fuente de audio no respondió (${response.status}).`, 'network') }
    if (response.url) {
      const delivered = new URL(response.url)
      if (delivered.username || delivered.password || delivered.hash || delivered.protocol !== 'https:' ||
        !(delivered.origin === POD || delivered.origin === 'https://s3.eu-central-2.wasabisys.com' && delivered.pathname.startsWith('/open-audio/'))) {
        void response.body?.cancel().catch(() => {}); throw new FunkwhaleError('La fuente redirigió a un destino desconocido.', 'protocol')
      }
    }
    const actual = format(response.headers.get('content-type'), candidate.extension, candidate.codec)
    if (!actual || actual.mime !== encoding.mime || actual.codec !== encoding.codec) { void response.body?.cancel().catch(() => {}); throw new FunkwhaleError('El archivo no tiene el formato de audio esperado.', 'protocol') }
    const bytes = await bodyBytes(response, localSignal, FUNKWHALE_MAX_AUDIO_BYTES, candidate.contentLength)
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
    checkAbort(localSignal)
    return { bytes, sha256: [...digest].map(value => value.toString(16).padStart(2, '0')).join(''), mime: actual.mime }
  })
}
