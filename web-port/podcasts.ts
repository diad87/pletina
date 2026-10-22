import type { Podcast, PodcastDetail, PodcastSearchResults } from '../src/lib/types'
import { savePodcastShows, savePodcastDetail, readPodcastFeedUrl, readPodcastDetail,
  type PodcastShowInput, type PodcastEpisodeInput } from './storage'
import * as youtube from './youtube-podcasts'

type Row = Record<string, unknown>
export interface PodcastOptions { signal?: AbortSignal }
export interface PodcastDetailInput { podcast: PodcastShowInput; episodes: PodcastEpisodeInput[] }
interface DirectoryEntry { appleId: number; feedUrl: string; title: string; author: string; image: string | null }
const TTL = 10 * 60_000, MAX_BYTES = 20 * 1024 * 1024, MAX_EPISODES = 300
const ITUNES = 'http://www.itunes.com/dtds/podcast-1.0.dtd'
const CONTENT = 'http://purl.org/rss/1.0/modules/content/'
const feeds = new Map<string, { at: number; value: PodcastDetailInput }>()
const appleDetails = new Map<string, { at: number; value: PodcastDetailInput }>()
const directories = new Map<string, { at: number; value: DirectoryEntry[] }>()
const references = new Map<string, DirectoryEntry>()
let requestSequence = 0, activeSearch: AbortController | undefined

const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
const string = (value: unknown, maximum = 4000): string => typeof value === 'string' ? value.trim().slice(0, maximum) : ''
const count = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []
function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Cancelado.', 'AbortError')
}
function cached<T>(cache: Map<string, { at: number; value: T }>, key: string): T | undefined {
  const entry = cache.get(key)
  if (entry && Date.now() - entry.at < TTL) return entry.value
  cache.delete(key)
}
function cache<T>(target: Map<string, { at: number; value: T }>, key: string, value: T, maximum: number): void {
  target.delete(key); target.set(key, { at: Date.now(), value })
  while (target.size > maximum) target.delete(target.keys().next().value!)
}
export function webURL(value: unknown, base?: string, secure = false): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 16_384) return null
  try {
    const url = base ? new URL(value.trim(), base) : new URL(value.trim())
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null
    if (secure && url.protocol === 'http:') url.protocol = 'https:'
    return url.href
  } catch { return null }
}
function feedURL(value: string): string {
  const url = webURL(value)
  if (!url) throw new Error('La dirección del pódcast debe usar HTTP o HTTPS, sin credenciales.')
  const normalized = new URL(url); normalized.hash = ''
  return normalized.href
}
function audioURL(value: unknown, base?: string): string | null {
  const result = webURL(value, base, true)
  if (!result) return null
  const host = new URL(result).hostname
  return host === 'googlevideo.com' || host.endsWith('.googlevideo.com') ? null : result
}
export function normalizeLanguage(value: unknown): string | null {
  const language = string(value, 40).split(/[-_]/)[0].toLowerCase()
  if (!/^[a-z]{2,3}$/.test(language) || ['und', 'mul', 'zxx'].includes(language)) return null
  return ({ spa: 'es', eng: 'en', cat: 'ca', eus: 'eu', baq: 'eu', glg: 'gl', fra: 'fr', fre: 'fr',
    por: 'pt', deu: 'de', ger: 'de', ita: 'it' } as Record<string, string>)[language] ?? language
}
export function filterLanguage(value: string): string | null {
  if (!value.trim() || value.trim().toLowerCase() === 'all') return null
  const result = normalizeLanguage(value)
  if (!result) throw new Error('El filtro de idioma no es válido.')
  return result
}
export function durationSeconds(value: unknown): number {
  const parts = string(value, 40).split(':')
  if (!parts.length || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part)) ||
    parts.slice(1).some((part) => Number(part) >= 60)) return 0
  const seconds = parts.reduce((sum, part) => sum * 60 + Number(part), 0)
  return Number.isSafeInteger(seconds) && seconds <= 4_294_967_295 ? seconds : 0
}
export function plainText(value: unknown): string {
  return string(value, 32_000).replace(/<[^>]*>/g, ' ').replaceAll('&nbsp;', ' ').replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>').replaceAll('&quot;', '"').replace(/&#(?:0*39|x0*27);/gi, "'")
    .replaceAll('&apos;', "'").replaceAll('&amp;', '&').replace(/\s+/g, ' ').trim().slice(0, 4000)
}
export function decodeXML(bytes: Uint8Array): string {
  let encoding = 'utf-8'
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le'
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be'
  else {
    const prefix = new TextDecoder('latin1').decode(bytes.slice(0, 256))
    encoding = /^\s*(?:\uFEFF)?<\?xml\s[^?]*encoding\s*=\s*["']([^"']+)["']/i.exec(prefix)?.[1] ?? encoding
  }
  try { return new TextDecoder(encoding, { fatal: true }).decode(bytes) }
  catch { throw new Error('La codificación del RSS del pódcast no es válida.') }
}

function child(parent: Element, name: string, namespace = ''): Element | undefined {
  return [...parent.children].find((node) => node.localName === name && (node.namespaceURI || '') === namespace)
}
const text = (node?: Element) => node?.textContent?.trim() ?? ''
const value = (node: Element, name: string, namespace = '') => text(child(node, name, namespace))
const explicit = (raw: string) => ['yes', 'true', '1'].includes(raw.toLowerCase())
function description(node: Element): string {
  return plainText(text(child(node, 'description') ?? child(node, 'summary', ITUNES) ?? child(node, 'encoded', CONTENT)))
}
function artwork(node: Element, base: string): string | null {
  return webURL(child(node, 'image', ITUNES)?.getAttribute('href'), base, true) ??
    webURL(text(child(node, 'image') ? child(child(node, 'image')!, 'url') : undefined), base, true)
}
export function parseRSS(xml: string, contentBase: string, originalFeed = contentBase): PodcastDetailInput {
  if (xml.length > MAX_BYTES || /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error('El RSS del pódcast no es válido.')
  let markers = 0, offset = -1
  while ((offset = xml.indexOf('<', offset + 1)) !== -1) {
    if (++markers > 150_000) throw new Error('El RSS del pódcast contiene demasiados elementos.')
  }
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length || doc.documentElement.localName !== 'rss' || doc.documentElement.namespaceURI) {
    throw new Error('El pódcast no contiene un feed RSS compatible.')
  }
  const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_ALL)
  let nodes = 0
  while (walker.nextNode()) if (++nodes > 150_000) throw new Error('El RSS del pódcast contiene demasiados elementos.')
  const channel = child(doc.documentElement, 'channel')
  if (!channel) throw new Error('El RSS del pódcast no contiene un canal.')
  const title = value(channel, 'title')
  if (!title) throw new Error('El RSS del pódcast no tiene título.')
  const image = artwork(channel, contentBase), showExplicit = explicit(value(channel, 'explicit', ITUNES))
  const episodes: PodcastEpisodeInput[] = [], seen = new Set<string>()
  for (const item of [...channel.children].filter((node) => node.localName === 'item' && !node.namespaceURI)) {
    const title = value(item, 'title')
    if (!title) continue
    let audioUrl: string | null = null
    for (const enclosure of [...item.children].filter((node) => node.localName === 'enclosure' && !node.namespaceURI)) {
      const candidate = audioURL(enclosure.getAttribute('url'), contentBase)
      if (!candidate) continue
      const mime = (enclosure.getAttribute('type') || '').split(';')[0].trim().toLowerCase()
      if (mime.startsWith('audio/') || mime === 'application/ogg' || ((!mime || mime === 'application/octet-stream') &&
        /\.(?:mp3|m4a|aac|ogg|oga|opus|wav|flac)$/i.test(new URL(candidate).pathname))) { audioUrl = candidate; break }
    }
    if (!audioUrl) continue
    const guid = value(item, 'guid') || audioUrl
    if (seen.has(guid)) continue
    seen.add(guid)
    const itemExplicit = child(item, 'explicit', ITUNES)
    episodes.push({ guid, title: title.slice(0, 4000), description: description(item), audioUrl,
      publishedAt: value(item, 'pubDate') || null, duration: durationSeconds(value(item, 'duration', ITUNES)),
      image: artwork(item, contentBase) ?? image, explicit: itemExplicit ? explicit(text(itemExplicit)) : showExplicit })
    if (episodes.length >= MAX_EPISODES) break
  }
  return { podcast: { title: title.slice(0, 4000), author: value(channel, 'author', ITUNES) || value(channel, 'managingEditor') || title,
    description: description(channel), image, feedUrl: feedURL(originalFeed),
    language: normalizeLanguage(value(channel, 'language')), episodeCount: episodes.length }, episodes }
}

function appleBridge(config: { requestId: number; url: string }) {
  let sent = false
  const send = (value: object) => { if (!sent) { sent = true; parent.postMessage({ type: 'pletina-podcast-directory', requestId: config.requestId, ...value }, '*') } }
  ;(window as unknown as Record<string, unknown>).__pletinaPodcasts = (value: unknown) => {
    try { const json = JSON.stringify(value); if (json.length > 4 * 1024 * 1024) throw new Error(); send({ json }) }
    catch { send({ error: true }) }
  }
  const script = document.createElement('script')
  script.src = config.url
  script.onerror = () => send({ error: true })
  document.head.append(script)
}
export function appleURL(path: 'search' | 'lookup', parameters: Record<string, string>): string {
  if (!['search', 'lookup'].includes(path)) throw new Error('Ruta de pódcasts no válida.')
  const url = new URL(path, 'https://itunes.apple.com/')
  for (const [key, entry] of Object.entries(parameters)) {
    if (!['term', 'media', 'entity', 'country', 'limit', 'id'].includes(key)) throw new Error('Parámetro de pódcasts no válido.')
    url.searchParams.set(key, entry)
  }
  if (parameters.term && [...parameters.term].length > 250) throw new Error('La búsqueda de pódcasts es demasiado larga.')
  if (parameters.id && !/^\d{1,15}$/.test(parameters.id)) throw new Error('El identificador del directorio no es válido.')
  url.searchParams.set('callback', '__pletinaPodcasts')
  return url.href
}
export function requestApple(path: 'search' | 'lookup', parameters: Record<string, string>, { signal }: PodcastOptions = {}): Promise<Row> {
  aborted(signal)
  const url = appleURL(path, parameters)
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe'), requestId = ++requestSequence
    frame.hidden = true; frame.sandbox = 'allow-scripts'; frame.setAttribute('aria-hidden', 'true')
    let finished = false
    const finish = (error?: unknown, result?: Row) => {
      if (finished) return
      finished = true; clearTimeout(timer); frame.remove()
      window.removeEventListener('message', receive); signal?.removeEventListener('abort', abort)
      error ? reject(error) : resolve(result!)
    }
    const abort = () => finish(new DOMException('Cancelado.', 'AbortError'))
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.origin !== 'null' || event.data?.type !== 'pletina-podcast-directory' || event.data.requestId !== requestId) return
      try {
        if (event.data.error || typeof event.data.json !== 'string' || event.data.json.length > 4 * 1024 * 1024) throw new Error()
        const result = object(JSON.parse(event.data.json))
        if (!Array.isArray(result.results)) throw new Error()
        finish(undefined, result)
      } catch { finish(new Error('El catálogo de pódcasts devolvió una respuesta no válida.')) }
    }
    const timer = setTimeout(() => finish(new Error('La búsqueda de pódcasts tardó demasiado.')), 15000)
    window.addEventListener('message', receive); signal?.addEventListener('abort', abort, { once: true })
    const args = JSON.stringify({ requestId, url }).replaceAll('<', '\\u003c')
    frame.srcdoc = '<script>(' + appleBridge.toString() + ')(' + args + ')<' + '/script>'
    document.body.append(frame)
  })
}

// Controlled code only. The RSS remains inert bytes inside this opaque frame.
async function feedBridge(config: { requestId: number; url: string; maximum: number }) {
  const send = (value: object, transfer: Transferable[] = []) => parent.postMessage({ type: 'pletina-podcast-rss', requestId: config.requestId, ...value }, '*', transfer)
  try {
    const response = await fetch(config.url, { credentials: 'omit', signal: AbortSignal.timeout(9000) })
    if (!response.ok || Number(response.headers.get('content-length')) > config.maximum) throw new Error('response')
    const reader = response.body?.getReader()
    if (!reader) throw new Error('response')
    const chunks: Uint8Array[] = []; let length = 0
    for (;;) {
      const item = await reader.read()
      if (item.done) break
      length += item.value.length
      if (length > config.maximum) { await reader.cancel(); throw new Error('size') }
      chunks.push(item.value)
    }
    const bytes = new Uint8Array(length); let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    send({ bytes: bytes.buffer, finalURL: response.url }, [bytes.buffer])
  } catch { send({ error: true }) }
}
async function opaqueFeed(url: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; finalURL: string }> {
  aborted(signal)
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe'), requestId = ++requestSequence
    frame.hidden = true; frame.sandbox = 'allow-scripts'; frame.setAttribute('aria-hidden', 'true')
    let finished = false
    const finish = (error?: unknown, result?: { bytes: Uint8Array; finalURL: string }) => {
      if (finished) return
      finished = true; clearTimeout(timer); frame.remove()
      window.removeEventListener('message', receive); signal?.removeEventListener('abort', abort)
      error ? reject(error) : resolve(result!)
    }
    const abort = () => finish(new DOMException('Cancelado.', 'AbortError'))
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.origin !== 'null' || event.data?.type !== 'pletina-podcast-rss' || event.data.requestId !== requestId) return
      if (event.data.error || !(event.data.bytes instanceof ArrayBuffer) || event.data.bytes.byteLength > MAX_BYTES || !webURL(event.data.finalURL)) {
        finish(new Error('No se pudo leer el RSS de este pódcast directamente en el navegador.')); return
      }
      finish(undefined, { bytes: new Uint8Array(event.data.bytes), finalURL: event.data.finalURL })
    }
    const timer = setTimeout(() => finish(new Error('El RSS del pódcast tardó demasiado.')), 10000)
    window.addEventListener('message', receive); signal?.addEventListener('abort', abort, { once: true })
    const args = JSON.stringify({ requestId, url, maximum: MAX_BYTES }).replaceAll('<', '\\u003c')
    frame.srcdoc = '<script>(' + feedBridge.toString() + ')(' + args + ')<' + '/script>'
    document.body.append(frame)
  })
}
export async function requestFeed(original: string, { signal }: PodcastOptions = {}): Promise<PodcastDetailInput> {
  aborted(signal)
  const identity = feedURL(original), previous = cached(feeds, identity)
  if (previous) return previous
  const url = webURL(identity, undefined, true)!
  let result: { bytes: Uint8Array; finalURL: string }
  try {
    const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(9000)]) })
    if (!response.ok) throw new Error(`El servicio de pódcasts respondió con HTTP ${response.status}.`)
    if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('El RSS del pódcast supera el tamaño admitido.')
    const reader = response.body?.getReader()
    if (!reader) throw new Error('No se pudo leer el RSS del pódcast.')
    const chunks: Uint8Array[] = []; let length = 0
    for (;;) {
      const item = await reader.read()
      if (item.done) break
      length += item.value.length
      if (length > MAX_BYTES) { await reader.cancel(); throw new Error('El RSS del pódcast supera el tamaño admitido.') }
      chunks.push(item.value)
    }
    const bytes = new Uint8Array(length); let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    if (!webURL(response.url)) throw new Error('El RSS redirigió a una dirección no válida.')
    result = { bytes, finalURL: response.url }
  } catch (error) {
    aborted(signal)
    if (!(error instanceof TypeError)) throw error
    result = await opaqueFeed(url, signal)
  }
  aborted(signal)
  const parsed = parseRSS(decodeXML(result.bytes), result.finalURL, identity)
  cache(feeds, identity, parsed, 32)
  return parsed
}

export function directoryEntries(response: unknown): DirectoryEntry[] {
  const seen = new Set<string>(), entries: DirectoryEntry[] = []
  for (const raw of list(object(response).results)) {
    const row = object(raw), rawURL = webURL(row.feedUrl), url = rawURL ? feedURL(rawURL) : null
    if (!url || !count(row.collectionId) || seen.has(url)) continue
    seen.add(url)
    entries.push({ appleId: count(row.collectionId), feedUrl: url,
      title: string(row.collectionName || row.trackName), author: string(row.artistName),
      image: webURL(row.artworkUrl600 || row.artworkUrl100, undefined, true) })
    if (entries.length >= 30) break
  }
  return entries
}
async function directory(query: string, signal?: AbortSignal): Promise<DirectoryEntry[]> {
  const q = query.trim() || 'podcast'
  if ([...q].length > 250) throw new Error('La búsqueda de pódcasts es demasiado larga.')
  let entries = cached(directories, q)
  if (!entries) {
    entries = directoryEntries(await requestApple('search', { term: q, media: 'podcast', entity: 'podcast', country: 'ES', limit: '30' }, { signal }))
    aborted(signal); cache(directories, q, entries, 24)
  }
  for (const entry of entries) {
    references.delete(entry.feedUrl); references.set(entry.feedUrl, entry)
    while (references.size > 256) references.delete(references.keys().next().value!)
  }
  return entries
}
export function appleDetail(response: unknown, entry: DirectoryEntry): PodcastDetailInput {
  const episodes: PodcastEpisodeInput[] = [], seen = new Set<string>()
  for (const raw of list(object(response).results)) {
    const row = object(raw), audioUrl = audioURL(row.episodeUrl)
    if (row.kind !== 'podcast-episode' || !audioUrl || !string(row.trackName)) continue
    if (row.episodeContentType && row.episodeContentType !== 'audio') continue
    const guid = string(row.episodeGuid) || `apple:${count(row.trackId)}`
    if (guid === 'apple:0' || seen.has(guid)) continue
    seen.add(guid)
    episodes.push({ guid, title: string(row.trackName), description: plainText(row.description || row.shortDescription),
      publishedAt: string(row.releaseDate) || null, duration: Math.floor(count(row.trackTimeMillis) / 1000), audioUrl,
      image: webURL(row.artworkUrl600 || row.artworkUrl160, undefined, true) ?? entry.image,
      explicit: row.contentAdvisoryRating === 'Explicit' || row.trackExplicitness === 'explicit' })
    if (episodes.length >= 200) break
  }
  if (!episodes.length) throw new Error('No se pudieron encontrar episodios públicos de este pódcast.')
  return { podcast: { title: entry.title, author: entry.author, description: '', image: entry.image,
    feedUrl: entry.feedUrl, language: null, episodeCount: episodes.length }, episodes }
}
async function rssSearch(query: string, requested: string | null, signal?: AbortSignal): Promise<{ podcasts: Podcast[]; failedFeeds: number }> {
  const entries = await directory(query, signal), found: (PodcastShowInput | undefined)[] = new Array(entries.length)
  let failedFeeds = 0, next = 0
  const worker = async () => {
    for (;;) {
      aborted(signal)
      const index = next++
      if (index >= entries.length) return
      const entry = entries[index]
      try {
        const detail = await requestFeed(entry.feedUrl, { signal })
        if (!requested || detail.podcast.language === requested) found[index] = detail.podcast
      } catch {
        aborted(signal); failedFeeds++
        // The directory does not declare a reliable language. It must never be
        // guessed from the storefront or a search term to satisfy a filter.
        if (!requested) found[index] = { title: entry.title, author: entry.author, description: '', image: entry.image,
          feedUrl: entry.feedUrl, language: null, episodeCount: 0 }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, entries.length) }, worker))
  aborted(signal)
  // Con un idioma concreto hacen falta declaraciones RSS: que todos fallen no
  // significa que el catálogo esté vacío. search conserva YouTube si sí respondió.
  // «Todos» mantiene el fallback del directorio con idioma sin confirmar.
  if (requested && entries.length > 0 && failedFeeds === entries.length) {
    throw new Error('Se encontró el catálogo, pero no se pudo leer ningún pódcast. Comprueba la conexión o vuelve a intentarlo.')
  }
  const selected = found.flatMap((show, index) => show ? [{ show, image: entries[index].image }] : [])
  const stored = await savePodcastShows(selected.map(({ show }) => show))
  return { podcasts: stored.map((show, index) => ({ ...show, image: selected[index].image ?? show.image })), failedFeeds }
}
export async function search(query: string, language = 'all', { signal }: PodcastOptions = {}): Promise<PodcastSearchResults> {
  const requested = filterLanguage(language)
  activeSearch?.abort()
  const controller = new AbortController(); activeSearch = controller
  const abort = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  try {
    const [rss, videos] = await Promise.allSettled([rssSearch(query, requested, controller.signal), youtube.search(query, controller.signal)])
    aborted(controller.signal)
    const youtubeShows = videos.status === 'fulfilled' ? await savePodcastShows(videos.value.map((show) => ({
      title: show.title, author: show.author, description: '', image: show.image, feedUrl: `youtube:${show.browseId}`,
      language: null, episodeCount: 0,
    }))) : []
    if (rss.status === 'rejected' && !youtubeShows.length) throw rss.reason
    return { podcasts: rss.status === 'fulfilled' ? rss.value.podcasts : [], youtube: youtubeShows,
      failedFeeds: rss.status === 'fulfilled' ? rss.value.failedFeeds : 0 }
  } finally {
    signal?.removeEventListener('abort', abort)
    if (activeSearch === controller) activeSearch = undefined
  }
}
export async function detail(feed: string, { signal }: PodcastOptions = {}): Promise<PodcastDetail> {
  aborted(signal)
  if (feed.startsWith('youtube:')) {
    try {
      const raw = await youtube.detail(feed, signal)
      return await savePodcastDetail({ podcast: { title: raw.show.title, author: raw.show.author,
        description: raw.description, image: raw.show.image, feedUrl: feed, language: null, episodeCount: raw.episodes.length }, episodes: raw.episodes })
    } catch (error) {
      aborted(signal)
      const previous = await readPodcastDetail(feed)
      if (previous) return previous
      throw error
    }
  }
  const url = feedURL(feed)
  try { return await savePodcastDetail(await requestFeed(url, { signal })) }
  catch (error) {
    aborted(signal)
    // Published RSS enclosures are metadata; temporary YouTube stream URLs never
    // enter this cache or the library. Apple is an optional directory fallback.
    const previous = await readPodcastDetail(url)
    if (previous && typeof navigator !== 'undefined' && !navigator.onLine) return previous
    let entry = references.get(url)
    // A saved show can be opened after a restart, when the in-memory directory
    // association is gone. Match its original feed exactly, not by title alone.
    if (!entry && previous?.podcast.title) {
      try { entry = (await directory(previous.podcast.title, signal)).find((candidate) => candidate.feedUrl === url) }
      catch { aborted(signal) }
    }
    if (entry) {
      try {
        let fallback = cached(appleDetails, url)
        if (!fallback) {
          const response = await requestApple('lookup', { id: String(entry.appleId), entity: 'podcastEpisode', country: 'ES', limit: '200' }, { signal })
          fallback = appleDetail(response, entry)
          cache(appleDetails, url, fallback, 32)
        }
        if (previous) {
          fallback.podcast.language = previous.podcast.language
          fallback.podcast.description = previous.podcast.description
        }
        return await savePodcastDetail(fallback)
      } catch { aborted(signal) }
    }
    if (previous) return previous
    throw error
  }
}
export async function feedUrl(id: number): Promise<string> {
  const url = await readPodcastFeedUrl(id)
  if (!url) throw new Error('No se encuentra este pódcast en la biblioteca.')
  return url
}
