// Transporte web directo: JSON en un origen opaco, sin proxy, cookies ni código de YouTube.
export interface Candidate {
  videoId: string
  title: string
  artists: string[]
  album: string | null
  duration: number | null
}

export interface StreamInfo {
  videoId: string
  url: string
  title: string
  channel: string
  duration: number | null
  expiresAt: number
  /** P1 URLs have passed a silent metadata probe before reaching the player. */
  transport?: 'p1'
  /** Tamaño declarado del mismo formato MP4 seleccionado; no se guardan sus URLs. */
  contentLength?: number
}

type ErrorCode = 'network' | 'timeout' | 'response' | 'unavailable' | 'restricted' | 'format'
export class YouTubeError extends Error {
  constructor(message: string, readonly code: ErrorCode) {
    super(message)
    this.name = 'YouTubeError'
  }
  override toString(): string { return this.message }
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/
const WEB_VERSION = '2.20261007.00.00'
const MUSIC_VERSION = '1.20260901.01.00'
const MESSAGE = 'pletina-web-youtube-json'
let sequence = 0
let visitor: { value: string; expiresAt: number } | null = null
const streams = new Map<string, StreamInfo>()
type Row = Record<string, unknown>
const object = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const at = (value: unknown, ...keys: string[]): unknown => keys.reduce((row, key) => object(row)[key], value)
const string = (value: unknown, length = 500): string => typeof value === 'string' ? value.trim().slice(0, length) : ''
const text = (value: unknown): string => string(object(value).simpleText) || list(object(value).runs).slice(0, 100)
  .map((run) => typeof object(run).text === 'string' ? String(object(run).text).slice(0, 500) : '').join('').trim().slice(0, 500)

export function abortReason(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new DOMException('Operación cancelada.', 'AbortError')
}
export function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw abortReason(signal) }
export function validVideoId(value: unknown): value is string { return typeof value === 'string' && VIDEO_ID.test(value) }

export function parseVideoId(value: string): string {
  const input = String(value).trim()
  if (input.length > 2048) throw new Error('El enlace de YouTube es demasiado largo.')
  if (VIDEO_ID.test(input)) return input
  let url: URL
  try { url = new URL(input.includes('://') ? input : `https://${input}`) }
  catch { throw new Error('Pega el enlace de un vídeo de YouTube.') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new Error('El enlace de YouTube no es válido.')
  }
  const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean)
  let id: string | undefined
  if (['youtu.be', 'www.youtu.be'].includes(url.hostname) && parts.length === 1) id = parts[0]
  else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(url.hostname)) {
    if (parts.length === 1 && parts[0] === 'watch') {
      const ids = url.searchParams.getAll('v')
      if (ids.length !== 1) throw new Error('El enlace debe señalar un único vídeo de YouTube.')
      id = ids[0]
    } else if (parts.length === 2 && ['shorts', 'live', 'embed'].includes(parts[0])) id = parts[1]
  }
  if (!validVideoId(id)) throw new Error('Pega un enlace a un vídeo de YouTube, no a un canal o una playlist.')
  return id
}

export function audioUrl(value: unknown): string {
  try {
    const url = new URL(String(value))
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      (url.hostname === 'googlevideo.com' || url.hostname.endsWith('.googlevideo.com'))) return url.href
  } catch {}
  throw new YouTubeError('YouTube no devolvió una dirección de audio válida.', 'response')
}

// Debe ser autocontenida: se serializa en srcdoc. Los datos recibidos nunca se ejecutan.
async function jsonBridge(config: { requestId: number; url: string; body: unknown; message: string }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12000)
  const send = (value: object) => parent.postMessage({ type: config.message, requestId: config.requestId, ...value }, '*')
  try {
    const response = await fetch(config.url, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, credentials: 'omit',
      body: JSON.stringify(config.body), signal: controller.signal,
    })
    if (!response.ok) { send({ error: 'http' }); return }
    send({ result: await response.json() })
  } catch (error) {
    send({ error: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network' })
  } finally { clearTimeout(timer) }
}

/** Únicamente estos endpoints, enviados por código de la aplicación. */
export async function requestJson(provider: 'music' | 'youtube', endpoint: 'search' | 'player' | 'browse', body: unknown, signal?: AbortSignal): Promise<unknown> {
  checkAbort(signal)
  if (!['music', 'youtube'].includes(provider) || !['search', 'player', 'browse'].includes(endpoint)) throw new Error('Petición de audio no válida.')
  const url = `https://${provider === 'music' ? 'music' : 'www'}.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false`
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe')
    frame.hidden = true
    frame.setAttribute('aria-hidden', 'true')
    frame.sandbox = 'allow-scripts'
    const requestId = ++sequence
    let finished = false
    const finish = (error: Error | null, result?: unknown) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      window.removeEventListener('message', receive)
      signal?.removeEventListener('abort', abort)
      frame.remove()
      error ? reject(error) : resolve(result)
    }
    const abort = () => finish(abortReason(signal))
    const receive = (event: MessageEvent) => {
      const data = object(event.data)
      if (event.source !== frame.contentWindow || data.type !== MESSAGE || data.requestId !== requestId) return
      if (data.error) {
        finish(data.error === 'timeout'
          ? new YouTubeError('YouTube tardó demasiado en responder. Vuelve a intentarlo.', 'timeout')
          : new YouTubeError('No se pudo conectar con YouTube. Vuelve a intentarlo.', 'network'))
      } else if (Object.hasOwn(data, 'result')) finish(null, data.result)
      else finish(new YouTubeError('YouTube devolvió una respuesta que no se reconoce.', 'response'))
    }
    const timer = setTimeout(() => finish(new YouTubeError('YouTube tardó demasiado en responder. Vuelve a intentarlo.', 'timeout')), 16000)
    window.addEventListener('message', receive)
    signal?.addEventListener('abort', abort, { once: true })
    const args = JSON.stringify({ requestId, url, body, message: MESSAGE }).replaceAll('<', '\\u003c')
    frame.srcdoc = '<script>(' + jsonBridge.toString() + ')(' + args + ')<' + '/script>'
    ;(document.body || document.documentElement).append(frame)
  })
}

export function parseDuration(value: unknown): number | null {
  const parts = string(value).split(':')
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part)) || parts.slice(1).some((part) => Number(part) > 59)) return null
  const seconds = parts.reduce((total, part) => total * 60 + Number(part), 0)
  return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 604800 ? seconds : null
}

export function parseMusicResults(response: unknown): Candidate[] {
  const root = object(response)
  if (root.error != null || list(root.alerts).some(alert => at(alert, 'alertRenderer', 'type') === 'ERROR')) {
    throw new YouTubeError('YouTube Music devolvió un error al buscar canciones.', 'response')
  }
  const tabs = at(response, 'contents', 'tabbedSearchResultsRenderer', 'tabs')
  const tabbed = at(list(tabs)[0], 'tabRenderer', 'content', 'sectionListRenderer', 'contents')
  const flat = at(response, 'contents', 'sectionListRenderer', 'contents')
  const sections = Array.isArray(tabbed) ? tabbed : Array.isArray(flat) ? flat : Array.isArray(tabs) && tabs.length === 0 ? [] : null
  if (!Array.isArray(sections)) throw new YouTubeError('No se reconoce la lista de canciones de YouTube Music.', 'response')
  const found: Candidate[] = []
  for (const item of sections.flatMap((section) => list(at(section, 'musicShelfRenderer', 'contents')))) {
    const row = object(object(item).musicResponsiveListItemRenderer)
    const videoId = at(row, 'playlistItemData', 'videoId') ?? at(row, 'overlay', 'musicItemThumbnailOverlayRenderer', 'content', 'musicPlayButtonRenderer', 'playNavigationEndpoint', 'watchEndpoint', 'videoId')
    if (!validVideoId(videoId)) continue
    const columns = list(row.flexColumns)
    const title = text(at(columns[0], 'musicResponsiveListItemFlexColumnRenderer', 'text'))
    if (!title) continue
    const artists: string[] = []
    const plain: string[] = []
    let album: string | null = null, duration: number | null = null
    for (const run of columns.slice(1).flatMap((column) => list(at(column, 'musicResponsiveListItemFlexColumnRenderer', 'text', 'runs')))) {
      const label = string(object(run).text, 300)
      const page = at(run, 'navigationEndpoint', 'browseEndpoint', 'browseEndpointContextSupportedConfigs', 'browseEndpointContextMusicConfig', 'pageType')
      if (page === 'MUSIC_PAGE_TYPE_ARTIST' && label) artists.push(label)
      else if (page === 'MUSIC_PAGE_TYPE_ALBUM' && label) album = label
      else if (parseDuration(label) !== null) duration = parseDuration(label)
      else if (label && label !== '•') plain.push(label)
    }
    if (!artists.length && plain.length) artists.push(plain[0])
    found.push({ videoId, title, artists: [...new Set(artists)], album, duration })
  }
  return unique(found)
}

export function parseVideoResults(response: unknown): Candidate[] {
  const contents = object(object(response).contents)
  const root = at(contents, 'twoColumnSearchResultsRenderer', 'primaryContents') ?? contents.singleColumnSearchResultsRenderer
  const sections = at(root, 'sectionListRenderer', 'contents')
  if (!Array.isArray(sections)) throw new YouTubeError('No se reconoce la lista de vídeos de YouTube.', 'response')
  const found: Candidate[] = []
  for (const item of sections.flatMap((section) => list(at(section, 'itemSectionRenderer', 'contents')))) {
    const row = object(object(item).videoRenderer)
    if (!validVideoId(row.videoId) || row.upcomingEventData || row.isLive || row.isLiveNow) continue
    const endpoint = object(row.navigationEndpoint)
    const overlays = list(row.thumbnailOverlays)
    if (endpoint.reelWatchEndpoint || at(endpoint, 'commandMetadata', 'webCommandMetadata', 'webPageType') === 'WEB_PAGE_TYPE_SHORTS' ||
      string(at(endpoint, 'commandMetadata', 'webCommandMetadata', 'url')).includes('/shorts/') ||
      overlays.some((overlay) => ['LIVE', 'UPCOMING', 'SHORTS'].includes(string(at(overlay, 'thumbnailOverlayTimeStatusRenderer', 'style')))) ||
      list(row.badges).some((badge) => at(badge, 'metadataBadgeRenderer', 'style') === 'BADGE_STYLE_TYPE_LIVE_NOW')) continue
    const title = text(row.title)
    const channel = text(row.ownerText ?? row.longBylineText ?? row.shortBylineText)
    const duration = parseDuration(text(row.lengthText)) ?? overlays.map((overlay) => parseDuration(text(at(overlay, 'thumbnailOverlayTimeStatusRenderer', 'text')))).find((value) => value !== null) ?? null
    if (!title || !channel || duration === null) continue
    found.push({ videoId: row.videoId, title, artists: [channel], album: null, duration })
  }
  return unique(found)
}

function unique(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>()
  return candidates.filter((row) => !seen.has(row.videoId) && !!seen.add(row.videoId)).slice(0, 30)
}

function rememberVisitor(response: unknown): void {
  const value = string(at(response, 'responseContext', 'visitorData'), 4096)
  if (value) visitor = { value, expiresAt: Date.now() + 15 * 60_000 }
}

export function musicContext() {
  return { client: { clientName: 'WEB_REMIX', clientVersion: MUSIC_VERSION, hl: 'es', gl: 'ES' } }
}

export async function searchMusic(query: string, signal?: AbortSignal): Promise<Candidate[]> {
  checkAbort(signal)
  const response = await requestJson('music', 'search', {
    context: musicContext(),
    query: query.trim().slice(0, 500), params: 'EgWKAQIIAWoKEAkQBRAKEAMQBA==',
  }, signal)
  return parseMusicResults(response)
}

export async function searchVideos(query: string, signal?: AbortSignal): Promise<Candidate[]> {
  checkAbort(signal)
  const response = await requestJson('youtube', 'search', {
    context: { client: { clientName: 'WEB', clientVersion: WEB_VERSION, hl: 'es', gl: 'ES' } },
    query: query.trim().slice(0, 500), params: 'EgIQAQ%3D%3D',
  }, signal)
  rememberVisitor(response)
  return parseVideoResults(response)
}

async function session(videoId: string, signal?: AbortSignal): Promise<string> {
  if (visitor && visitor.expiresAt > Date.now()) return visitor.value
  const response = await requestJson('youtube', 'search', {
    context: { client: { clientName: 'WEB', clientVersion: WEB_VERSION } }, query: videoId,
  }, signal)
  rememberVisitor(response)
  if (!visitor) throw new YouTubeError('No se pudo preparar la conexión con YouTube.', 'response')
  return visitor.value
}

/** Bounded FormatXTags protobuf, matching P1's original-audio policy. No code is evaluated. */
function audioTags(encoded: unknown): [string, string][] | null {
  if (typeof encoded !== 'string' || !encoded || encoded.length > 4096 || !/^[A-Za-z0-9_+=/%-]+$/.test(encoded)) return null
  try {
    const value = new URLSearchParams(`tags=${encoded}`).get('tags') ?? ''
    if (!/^[A-Za-z0-9_+/-]+={0,2}$/.test(value)) return null
    const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0))
    // atob accepts nonzero trailing bits and mixed alphabets that Rust's
    // canonical URL_SAFE_NO_PAD / URL_SAFE / STANDARD decoders reject.
    const standard = btoa(String.fromCharCode(...bytes)), urlSafe = standard.replaceAll('+', '-').replaceAll('/', '_')
    if (value !== standard && value !== urlSafe && value !== urlSafe.replace(/=+$/, '')) return null
    const fields = (data: Uint8Array): { field: bigint; data: Uint8Array | null }[] => {
      let position = 0
      const varint = (): bigint => {
        let result = 0n
        for (let index = 0; index < 10; index++) {
          if (position >= data.length) throw new Error('Truncated protobuf')
          const byte = data[position++]
          if (index === 9 && byte > 1) throw new Error('Oversized protobuf integer')
          result |= BigInt(byte & 127) << BigInt(index * 7)
          if (byte < 128) return result
        }
        throw new Error('Invalid protobuf integer')
      }
      const result: { field: bigint; data: Uint8Array | null }[] = []
      while (position < data.length) {
        if (result.length >= 64) throw new Error('Too many protobuf fields')
        const tag = varint(), field = tag >> 3n, wire = Number(tag & 7n)
        if (!field) throw new Error('Invalid protobuf field')
        let chunk: Uint8Array | null = null
        if (wire === 0) varint()
        else if (wire === 1) position += 8
        else if (wire === 5) position += 4
        else if (wire === 2) {
          const length = varint()
          if (length > BigInt(data.length - position)) throw new Error('Truncated protobuf value')
          chunk = data.subarray(position, position + Number(length)); position += Number(length)
        } else throw new Error('Unsupported protobuf field')
        if (position > data.length) throw new Error('Truncated protobuf field')
        result.push({ field, data: chunk })
      }
      return result
    }
    // UTF-8 BOM is data here, as in Rust's str::from_utf8, not a marker to strip.
    const result: [string, string][] = [], decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    for (const entry of fields(bytes)) {
      if (entry.field !== 1n) continue
      if (!entry.data) return null
      const pair: [string | null, string | null] = [null, null]
      for (const item of fields(entry.data)) {
        if (item.field !== 1n && item.field !== 2n) continue
        const target = Number(item.field - 1n)
        if (pair[target] !== null || !item.data || !item.data.length || item.data.length > 128) return null
        pair[target] = decoder.decode(item.data)
      }
      if (pair[0] === null || pair[1] === null) return null
      result.push([pair[0], pair[1]])
    }
    return result
  } catch { return null }
}

function originalAudio(format: Row, allowImplicit: boolean): boolean {
  if (format.isDrc === true) return false
  let content: string | null = null
  if (format.xtags != null) {
    const tags = audioTags(format.xtags)
    if (!tags) return false
    for (const [key, value] of tags) {
      if (key === 'drc' && value === '1') return false
      if (key === 'acont') {
        if (content !== null && content !== value) return false
        content = value
      }
    }
  }
  if (content !== null && content !== 'original') return false
  const track = object(format.audioTrack), name = typeof track.displayName === 'string' ? track.displayName.toLowerCase() : ''
  if (['dubbed', 'descriptive', 'audio description', 'secondary'].some(marker => name.includes(marker))) return false
  return content === 'original' || name.includes('original') || allowImplicit && (typeof track.audioIsDefault === 'boolean' ? track.audioIsDefault : true)
}

export function parsePlayer(response: unknown, videoId: string, now = Date.now()): StreamInfo {
  const status = string(at(response, 'playabilityStatus', 'status'))
  if (status !== 'OK') {
    throw status === 'ERROR' || status === 'UNPLAYABLE'
      ? new YouTubeError('YouTube no permite reproducir esta fuente de audio en Pletina.', 'unavailable')
      : new YouTubeError('YouTube no permite reproducir este vídeo ahora.', 'restricted')
  }
  const details = object(object(response).videoDetails)
  if (!validVideoId(videoId) || details.videoId !== videoId) throw new YouTubeError('YouTube no confirmó el vídeo solicitado o devolvió otro vídeo distinto.', 'response')
  const available = list(at(response, 'streamingData', 'adaptiveFormats')).map(object)
  // If any audio carries language/track metadata, default alone cannot establish
  // originality for the other encodings. Wholly untagged responses stay valid.
  const requireExplicit = available.some(format => string(format.mimeType).startsWith('audio/') &&
    ['audioTrack', 'xtags', 'language', 'languageCode'].some(key => format[key] != null))
  const formats = available
    .filter(format => string(format.mimeType).startsWith('audio/mp4') && typeof format.url === 'string' && originalAudio(format, !requireExplicit) &&
      (!Object.hasOwn(format, 'drmFamilies') || Array.isArray(format.drmFamilies) && format.drmFamilies.length === 0) &&
      !Object.hasOwn(format, 'licenseInfos') && !Object.hasOwn(format, 'drmTrackType'))
    .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0))
  let url: string | undefined
  let selected: Row | undefined
  for (const format of formats) {
    try { url = audioUrl(format.url); selected = format; break } catch { /* No aceptar otro origen como alternativa. */ }
  }
  if (!url) throw new YouTubeError('Este vídeo no ofrece audio MP4 compatible.', 'format')
  const expiration = Number(new URL(url).searchParams.get('expire')) * 1000
  if (expiration > 0 && expiration <= now + 60_000) throw new YouTubeError('La dirección de audio ha caducado. Vuelve a intentarlo.', 'response')
  const expiresAt = Math.min(now + 20 * 60_000, Number.isFinite(expiration) && expiration > 0 ? expiration - 60_000 : now + 5 * 60_000)
  const seconds = Number(details.lengthSeconds)
  const size = (value: unknown): number | undefined => {
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d{1,10}$/.test(value))) return
    const number = Number(value)
    return Number.isSafeInteger(number) && number > 0 && number <= 2 * 1024 ** 3 ? number : undefined
  }
  const declared = size(selected?.contentLength), query = size(new URL(url).searchParams.get('clen'))
  const contentLength = declared && query && declared !== query ? undefined : declared ?? query
  return { videoId, url, title: string(details.title, 300) || videoId,
    channel: string(details.author, 200) || 'YouTube', duration: Number.isFinite(seconds) && seconds > 0 && seconds <= 604800 ? Math.round(seconds) : null, expiresAt,
    ...(contentLength ? { contentLength } : {}) }
}

async function p1Stream(videoId: string, signal?: AbortSignal): Promise<StreamInfo> {
  checkAbort(signal)
  const [{ requestP1Player }, { probeP1Audio }, { p1Recipe }] = await Promise.all([
    import('./youtube-p1'), import('./youtube-p1-probe'), import('./p1-recipe.generated'),
  ])
  checkAbort(signal)
  const response = await requestP1Player(videoId, (body, requestSignal) => requestJson('youtube', 'player', body, requestSignal), p1Recipe, signal)
  checkAbort(signal)
  const info = parsePlayer(response, videoId)
  await probeP1Audio(info.url, info.duration, signal)
  checkAbort(signal)
  return { ...info, transport: 'p1' }
}

export async function stream(videoId: string, refresh = false, signal?: AbortSignal): Promise<StreamInfo> {
  if (!validVideoId(videoId)) throw new Error('El vídeo de YouTube no es válido.')
  checkAbort(signal)
  const saved = streams.get(videoId)
  if (!refresh && saved && saved.expiresAt > Date.now()) return saved
  streams.delete(videoId)
  const visitorData = await session(videoId, signal)
  checkAbort(signal)
  const response = await requestJson('youtube', 'player', {
    context: { client: { clientName: 'VISIONOS', clientVersion: '1.02', visitorData,
      deviceMake: 'Apple', deviceModel: 'RealityDevice17,1', osName: 'visionOS', osVersion: '26.5.23O471', platform: 'MOBILE' } },
    videoId, contentCheckOk: true, racyCheckOk: true,
  }, signal)
  checkAbort(signal)
  let result: StreamInfo
  try { result = parsePlayer(response, videoId) }
  catch (error) {
    if (error instanceof YouTubeError && error.code === 'restricted') visitor = null
    if (!(error instanceof YouTubeError) || !['format', 'unavailable'].includes(error.code)) throw error
    try { result = await p1Stream(videoId, signal) }
    catch {
      checkAbort(signal)
      // Preserve the original category for verified providers and the existing
      // visible fallback. A stale static recipe must not replace those paths.
      throw error
    }
  }
  // Límite de memoria: las direcciones nunca se guardan en el almacenamiento de biblioteca.
  for (const [id, value] of streams) if (value.expiresAt <= Date.now()) streams.delete(id)
  if (streams.size >= 100) streams.delete(streams.keys().next().value!)
  streams.set(videoId, result)
  return result
}
