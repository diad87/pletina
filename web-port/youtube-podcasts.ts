// YouTube Music podcasts, fetched directly by an opaque sandbox without cookies.
// Stable numeric library IDs belong to the storage layer, not this transport.
import { checkAbort, musicContext, requestJson, validVideoId, YouTubeError } from './youtube'

export interface RawShow {
  browseId: string
  title: string
  author: string
  image: string | null
}

export interface RawEpisode {
  guid: string
  title: string
  description: string
  publishedAt: string | null
  duration: number
  audioUrl: string
  image: string | null
  explicit: false
}

export interface RawDetail {
  show: RawShow
  description: string
  episodes: RawEpisode[]
}

const PREFIX = 'youtube:'
const PODCASTS_PARAMS = 'EgWKAQJQAWoMEA4QChADEAQQCRAF'
const MAX_SHOWS = 20
const MAX_EPISODES = 300

type Row = Record<string, unknown>
const object = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const at = (value: unknown, ...keys: string[]): unknown => keys.reduce((row, key) => object(row)[key], value)
const string = (value: unknown, max = 4000): string => typeof value === 'string' ? value.trim().slice(0, max) : ''
const text = (value: unknown, max = 4000): string => string(object(value).simpleText, max) || list(object(value).runs).slice(0, 500)
  .map((run) => typeof object(run).text === 'string' ? String(object(run).text).slice(0, max) : '').join('').trim().slice(0, max)

export function validBrowseId(value: unknown): value is string {
  return typeof value === 'string' && /^MPSP[A-Za-z0-9_-]{0,95}$/.test(value)
}

// Bound traversal of untrusted JSON and retain the order of arrays/renderers.
function collect(value: unknown, key: string): unknown[] {
  const found: unknown[] = [], pending = [value]
  let visited = 0
  while (pending.length) {
    if (++visited > 150_000) throw new YouTubeError('La respuesta del podcast es demasiado grande.', 'response')
    const row = pending.pop()
    if (Array.isArray(row)) { for (let i = row.length - 1; i >= 0; i--) pending.push(row[i]) }
    else if (row && typeof row === 'object') {
      const entries = Object.entries(row)
      for (let i = entries.length - 1; i >= 0; i--) {
        const [name, child] = entries[i]
        if (name === key) found.push(child)
        pending.push(child)
      }
    }
  }
  return found
}

function thumbnail(value: unknown): string | null {
  const values = list(value).map((row) => string(object(row).url, 4000)).filter(Boolean)
  const valueUrl = values.at(-1)
  if (!valueUrl) return null
  try {
    const url = new URL(valueUrl)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null
  } catch { return null }
}

export function parseSearch(response: unknown): RawShow[] {
  const shows: RawShow[] = [], seen = new Set<string>()
  for (const item of collect(response, 'musicResponsiveListItemRenderer')) {
    const browseId = at(item, 'navigationEndpoint', 'browseEndpoint', 'browseId')
    if (!validBrowseId(browseId) || seen.has(browseId)) continue
    const columns = list(object(item).flexColumns)
    const title = text(at(columns[0], 'musicResponsiveListItemFlexColumnRenderer', 'text'))
    if (!title) continue
    const author = text(at(columns[1], 'musicResponsiveListItemFlexColumnRenderer', 'text')).replace(/^Podcast • /, '')
    shows.push({ browseId, title, author,
      image: thumbnail(at(item, 'thumbnail', 'musicThumbnailRenderer', 'thumbnail', 'thumbnails')) })
    seen.add(browseId)
    if (shows.length >= MAX_SHOWS) break
  }
  return shows
}

function lastRun(value: unknown): string {
  return list(value).map((run) => string(object(run).text)).filter((label) => label && label !== '•').at(-1) || ''
}

export function parsePodcastDuration(value: string): number {
  const input = value.trim()
  let total = 0
  if (input.includes(':')) {
    const parts = input.split(':').map((part) => part.trim())
    if (parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) return 0
    total = parts.reduce((seconds, part) => seconds * 60 + Number(part), 0)
  } else {
    let number: number | null = null
    for (const token of input.split(/\s+/)) {
      if (/^\d+$/.test(token)) number = Number(token)
      else if (number !== null) {
        total += number * (token.startsWith('h') ? 3600 : token.startsWith('min') ? 60 : token.startsWith('s') ? 1 : 0)
        number = null
      }
    }
  }
  return Number.isSafeInteger(total) && total >= 0 && total <= 0xffff_ffff ? total : 0
}

export function parsePodcastDate(value: string, now = new Date()): string | null {
  const input = value.trim().toLowerCase()
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  let timestamp: number
  const ago = /^hace (\d+) (\S+)/.exec(input)
  if (ago) {
    const unit = ago[2]
    const days = /^(seg|s$|min|h$|hora)/.test(unit) ? 0 : /^(d$|día|dia)/.test(unit) ? 1
      : unit.startsWith('sem') ? 7 : unit.startsWith('mes') ? 30 : /^(año|a)/.test(unit) ? 365 : null
    if (days === null) return null
    timestamp = today - Number(ago[1]) * days * 86_400_000
  } else {
    const date = /^(\d{1,2}) (\S+)(?: (\d{4}))?$/.exec(input)
    if (!date) return null
    const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
    const month = months.findIndex((name) => date[2].replace(/\.$/, '').startsWith(name))
    const day = Number(date[1])
    if (month < 0 || day < 1 || day > 31) return null
    let year = date[3] ? Number(date[3]) : now.getUTCFullYear()
    timestamp = Date.UTC(year, month, day)
    if (!date[3] && timestamp > today) timestamp = Date.UTC(--year, month, day)
  }
  if (!Number.isFinite(timestamp) || Math.abs(timestamp) > 8.64e15) return null
  return new Date(timestamp + 12 * 3_600_000).toISOString().replace('.000Z', 'Z')
}

function addEpisodes(episodes: RawEpisode[], response: unknown, now: Date): void {
  const seen = new Set(episodes.map((episode) => episode.guid))
  for (const item of collect(response, 'musicMultiRowListItemRenderer')) {
    const videoId = at(item, 'onTap', 'watchEndpoint', 'videoId') ?? at(item, 'overlay', 'musicItemThumbnailOverlayRenderer', 'content', 'musicPlayButtonRenderer', 'playNavigationEndpoint', 'watchEndpoint', 'videoId')
    if (!validVideoId(videoId) || seen.has(videoId)) continue
    episodes.push({ guid: videoId, title: text(object(item).title), description: text(object(item).description),
      publishedAt: parsePodcastDate(lastRun(at(item, 'subtitle', 'runs')), now),
      duration: parsePodcastDuration(lastRun(at(item, 'playbackProgress', 'musicPlaybackProgressRenderer', 'durationText', 'runs'))),
      audioUrl: PREFIX + videoId,
      image: thumbnail(at(item, 'thumbnail', 'musicThumbnailRenderer', 'thumbnail', 'thumbnails')),
      explicit: false })
    seen.add(videoId)
    if (episodes.length >= MAX_EPISODES) break
  }
}

export function parseDetail(browseId: string, response: unknown, now = new Date()): RawDetail {
  if (!validBrowseId(browseId)) throw new Error('Este podcast de YouTube no es válido.')
  const header = collect(response, 'musicResponsiveHeaderRenderer')[0]
  if (!header) throw new YouTubeError('YouTube Music no ha devuelto este podcast.', 'response')
  const show: RawShow = { browseId, title: text(object(header).title), author: text(object(header).straplineTextOne),
    image: thumbnail(at(header, 'thumbnail', 'musicThumbnailRenderer', 'thumbnail', 'thumbnails')) }
  if (!show.title) throw new YouTubeError('YouTube Music devolvió un podcast sin título.', 'response')
  const episodes: RawEpisode[] = []
  addEpisodes(episodes, response, now)
  return { show, description: text(at(header, 'description', 'musicDescriptionShelfRenderer', 'description')), episodes }
}

function continuation(response: unknown): string {
  return string(object(collect(response, 'continuationCommand')[0]).token, 16000)
    || string(object(collect(response, 'nextContinuationData')[0]).continuation, 16000)
}

export async function search(query: string, signal?: AbortSignal): Promise<RawShow[]> {
  checkAbort(signal)
  const input = query.trim()
  if ([...input].length > 250) throw new Error('La búsqueda de podcasts es demasiado larga.')
  const response = await requestJson('music', 'search', { context: musicContext(), query: input || 'podcast', params: PODCASTS_PARAMS }, signal)
  checkAbort(signal)
  return parseSearch(response)
}

export async function detail(feedUrl: string, signal?: AbortSignal): Promise<RawDetail> {
  checkAbort(signal)
  const browseId = feedUrl.startsWith(PREFIX) ? feedUrl.slice(PREFIX.length) : ''
  if (!validBrowseId(browseId)) throw new Error('Este podcast de YouTube no es válido.')
  const response = await requestJson('music', 'browse', { context: musicContext(), browseId }, signal)
  checkAbort(signal)
  const now = new Date(), page = parseDetail(browseId, response, now), seen = new Set<string>()
  let token = continuation(response)
  while (token && page.episodes.length < MAX_EPISODES && !seen.has(token)) {
    seen.add(token)
    const more = await requestJson('music', 'browse', { context: musicContext(), continuation: token }, signal)
    checkAbort(signal)
    const before = page.episodes.length
    addEpisodes(page.episodes, more, now)
    token = page.episodes.length > before ? continuation(more) : ''
  }
  return page
}
