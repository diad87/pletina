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
}

type ErrorCode = 'network' | 'timeout' | 'response' | 'unavailable' | 'restricted' | 'format'
export class YouTubeError extends Error {
  constructor(message: string, readonly code: ErrorCode) {
    super(message)
    this.name = 'YouTubeError'
  }
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
export async function requestJson(provider: 'music' | 'youtube', endpoint: 'search' | 'player', body: unknown, signal?: AbortSignal): Promise<unknown> {
  checkAbort(signal)
  if (!['music', 'youtube'].includes(provider) || !['search', 'player'].includes(endpoint)) throw new Error('Petición de audio no válida.')
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
  const tabs = list(at(response, 'contents', 'tabbedSearchResultsRenderer', 'tabs'))
  const sections = at(tabs[0], 'tabRenderer', 'content', 'sectionListRenderer', 'contents')
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

export async function searchMusic(query: string, signal?: AbortSignal): Promise<Candidate[]> {
  checkAbort(signal)
  const response = await requestJson('music', 'search', {
    context: { client: { clientName: 'WEB_REMIX', clientVersion: MUSIC_VERSION, hl: 'es', gl: 'ES' } },
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

export function parsePlayer(response: unknown, videoId: string, now = Date.now()): StreamInfo {
  const status = string(at(response, 'playabilityStatus', 'status'))
  if (status !== 'OK') {
    throw status === 'ERROR' || status === 'UNPLAYABLE'
      ? new YouTubeError('Este vídeo ya no está disponible para reproducirlo aquí.', 'unavailable')
      : new YouTubeError('YouTube no permite reproducir este vídeo ahora.', 'restricted')
  }
  const details = object(object(response).videoDetails)
  if (validVideoId(details.videoId) && details.videoId !== videoId) throw new YouTubeError('YouTube devolvió otro vídeo distinto.', 'response')
  const formats = list(at(response, 'streamingData', 'adaptiveFormats')).map(object)
    .filter((format) => string(format.mimeType).startsWith('audio/mp4') && typeof format.url === 'string' && !format.isDrc &&
      at(format, 'audioTrack', 'audioIsDefault') !== false)
    .sort((a, b) => (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0))
  let url: string | undefined
  for (const format of formats) {
    try { url = audioUrl(format.url); break } catch { /* No aceptar otro origen como alternativa. */ }
  }
  if (!url) throw new YouTubeError('Este vídeo no ofrece audio MP4 compatible.', 'format')
  const expiration = Number(new URL(url).searchParams.get('expire')) * 1000
  if (expiration > 0 && expiration <= now + 60_000) throw new YouTubeError('La dirección de audio ha caducado. Vuelve a intentarlo.', 'response')
  const expiresAt = Math.min(now + 20 * 60_000, Number.isFinite(expiration) && expiration > 0 ? expiration - 60_000 : now + 5 * 60_000)
  const seconds = Number(details.lengthSeconds)
  return { videoId, url, title: string(details.title, 300) || videoId,
    channel: string(details.author, 200) || 'YouTube', duration: Number.isFinite(seconds) && seconds > 0 && seconds <= 604800 ? Math.round(seconds) : null, expiresAt }
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
  catch (error) { if (error instanceof YouTubeError && error.code === 'restricted') visitor = null; throw error }
  // Límite de memoria: las direcciones nunca se guardan en el almacenamiento de biblioteca.
  for (const [id, value] of streams) if (value.expiresAt <= Date.now()) streams.delete(id)
  if (streams.size >= 100) streams.delete(streams.keys().next().value!)
  streams.set(videoId, result)
  return result
}
