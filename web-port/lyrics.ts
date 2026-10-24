import type { TextCue, TextDocument, TrackQuery } from '../src/lib/types'

// LRCLIB explicitly supports direct browser requests and Lrclib-Client identification:
// https://lrclib.net/docs. User-Agent cannot be set reliably by browser JavaScript.
const API = 'https://lrclib.net/api/get'
const CLIENT = 'Pletina/0.11.2 (https://github.com/diad87/pletina)'
const MAX_RESPONSE_BYTES = 512 * 1024, MAX_LYRICS_BYTES = 128 * 1024, MAX_CUES = 5000
const CACHE_LIMIT = 64, FOUND_TTL = 6 * 60 * 60_000, MISSING_TTL = 10 * 60_000
const REQUEST_SPACING = 250, REQUEST_TIMEOUT = 12_000
interface Signature { title: string; artist: string; album: string; duration: number }
interface LyricsRecord {
  id: number; trackName: string; artistName: string; albumName: string; duration: number
  instrumental: boolean; plainLyrics: string | null; syncedLyrics: string | null
}
interface CacheEntry { at: number; value: TextDocument | null }
const cache = new Map<string, CacheEntry>()
let active: AbortController | undefined, queue: Promise<void> = Promise.resolve()
let nextRequest = 0, retryAfter = 0

function normalize(value: string): string {
  // Preserve version words such as Live, Remix and Acoustic.
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}
function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Cancelado.', 'AbortError')
}
function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  aborted(signal)
  return new Promise((resolve, reject) => {
    const finish = () => { signal.removeEventListener('abort', cancel); resolve() }
    const timer = setTimeout(finish, milliseconds)
    const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(signal.reason) }
    signal.addEventListener('abort', cancel, { once: true })
  })
}
function copy(value: TextDocument | null): TextDocument | null {
  return value && { ...value, cues: value.cues.map(cue => ({ ...cue })) }
}
function freshCache(key: string): CacheEntry | undefined {
  for (const [name, entry] of cache) {
    if (Date.now() - entry.at >= (entry.value ? FOUND_TTL : MISSING_TTL)) cache.delete(name)
  }
  return cache.get(key)
}
function remember(key: string, value: TextDocument | null): void {
  freshCache(key)
  cache.delete(key)
  cache.set(key, { at: Date.now(), value: copy(value) })
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
}
function matches(signature: Signature, record: LyricsRecord): boolean {
  return normalize(record.trackName) === signature.title && normalize(record.artistName) === signature.artist &&
    (!signature.album || normalize(record.albumName) === signature.album) && record.duration > 0 &&
    (!signature.duration || Math.abs(record.duration - signature.duration) <= 2)
}
function recordFrom(value: unknown): LyricsRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('LRCLIB devolvió una letra no válida. Vuelve a intentarlo.')
  const record = value as Partial<LyricsRecord>
  if (!Number.isSafeInteger(record.id) || record.id! < 0 || typeof record.trackName !== 'string' ||
    typeof record.artistName !== 'string' || typeof record.albumName !== 'string' ||
    typeof record.duration !== 'number' || !Number.isFinite(record.duration) ||
    typeof record.instrumental !== 'boolean' ||
    ![record.plainLyrics, record.syncedLyrics].every(text => text == null || typeof text === 'string')) {
    throw new Error('LRCLIB devolvió una letra no válida. Vuelve a intentarlo.')
  }
  const encoder = new TextEncoder()
  if ([record.plainLyrics, record.syncedLyrics].some(text => typeof text === 'string' && encoder.encode(text).byteLength > MAX_LYRICS_BYTES)) {
    throw new Error('La letra de LRCLIB supera el tamaño permitido.')
  }
  return { ...record, plainLyrics: record.plainLyrics ?? null, syncedLyrics: record.syncedLyrics ?? null } as LyricsRecord
}
function timestamp(value: string): number | null {
  const parts = value.split(':')
  if (parts.length < 2 || parts.length > 3 || !/^\d+(?:\.\d{1,3})?$/.test(parts.at(-1)!) ||
    parts.slice(0, -1).some(part => !/^\d+$/.test(part))) return null
  const seconds = Number(parts.at(-1)), minutes = Number(parts.at(-2)), hours = parts.length === 3 ? Number(parts[0]) : 0
  const time = hours * 3600 + minutes * 60 + seconds
  return seconds < 60 && (parts.length !== 3 || minutes < 60) && Number.isFinite(time) && time <= 86_400 ? time : null
}
function parseLrc(input: string): TextCue[] {
  const inputLines = input.split(/\r\n?|\n/)
  let offset = 0
  for (const line of inputLines) {
    const match = /^\[offset:\s*([+-]?\d+)\s*\]$/.exec(line.trim())
    if (match && Math.abs(Number(match[1])) <= 86_400_000) offset = Number(match[1]) / 1000
  }
  const lines: { start: number; text: string }[] = []
  for (const line of inputLines) {
    let remaining = line.trim()
    const times: number[] = []
    while (remaining.startsWith('[')) {
      const close = remaining.indexOf(']')
      if (close < 0) break
      const time = timestamp(remaining.slice(1, close))
      if (time === null) break
      times.push(Math.max(0, time - offset))
      if (times.length + lines.length > MAX_CUES) return []
      remaining = remaining.slice(close + 1).trimStart()
    }
    for (const start of times) lines.push({ start, text: remaining.trim() })
  }
  lines.sort((a, b) => a.start - b.start)
  const seen = new Set<string>(), cues: TextCue[] = []
  const unique = lines.filter(line => {
    const key = JSON.stringify([line.start, line.text])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  let end: number | null = null, previous: number | null = null
  // Empty marks still delimit silence; simultaneous voices share the next distinct time.
  for (let index = unique.length - 1; index >= 0; index--) {
    const line = unique[index]
    if (previous !== null && line.start < previous) end = previous
    previous = line.start
    if (line.text) cues.push({ ...line, end })
  }
  return cues.reverse()
}
function documentFrom(record: LyricsRecord): TextDocument | null {
  const base = { source: 'LRCLIB', sourceUrl: `https://lrclib.net/tracks/${record.id}`, instrumental: record.instrumental }
  if (record.instrumental) return { ...base, text: '', cues: [] }
  const cues = parseLrc(record.syncedLyrics ?? '')
  const text = (record.plainLyrics ?? '').replace(/\r\n?/g, '\n').trim() || cues.map(cue => cue.text).join('\n')
  return text ? { ...base, text, cues } : null
}
async function body(response: Response, signal: AbortSignal): Promise<unknown> {
  const size = Number(response.headers.get('content-length'))
  const tooLarge = () => new Error('La respuesta de LRCLIB supera el tamaño permitido.')
  if (size > MAX_RESPONSE_BYTES) { await response.body?.cancel(); throw tooLarge() }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('LRCLIB devolvió una letra no válida. Vuelve a intentarlo.')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      aborted(signal)
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_RESPONSE_BYTES) { await reader.cancel(); throw tooLarge() }
      chunks.push(value)
    }
  } catch (error) {
    aborted(signal)
    if (error instanceof Error && error.message === tooLarge().message) throw error
    throw new Error('No se pudo terminar de cargar la letra. Vuelve a intentarlo.')
  } finally { reader.releaseLock() }
  aborted(signal)
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { throw new Error('LRCLIB devolvió una letra no válida. Vuelve a intentarlo.') }
}
function retrySeconds(response: Response): number {
  const value = response.headers.get('retry-after')?.trim() ?? ''
  const seconds = /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - Date.now()) / 1000)
  return Number.isSafeInteger(seconds) && seconds >= 0 ? Math.max(1, seconds) : response.status === 429 ? 60 : 2
}
async function request(track: Signature, signature: Signature, key: string, controller: AbortController): Promise<TextDocument | null> {
  const signal = controller.signal
  aborted(signal)
  const saved = freshCache(key)
  if (saved) return copy(saved.value)
  if (retryAfter > Date.now()) throw new Error(`LRCLIB está ocupado. Vuelve a intentarlo en ${Math.ceil((retryAfter - Date.now()) / 1000)} segundos.`)
  if (nextRequest > Date.now()) await pause(nextRequest - Date.now(), signal)
  aborted(signal)
  const url = new URL(API)
  url.searchParams.set('track_name', track.title)
  url.searchParams.set('artist_name', track.artist)
  if (track.album) url.searchParams.set('album_name', track.album)
  if (track.duration >= 1 && track.duration <= 3600) url.searchParams.set('duration', String(track.duration))
  const timer = setTimeout(() => controller.abort(new DOMException('Se agotó el tiempo de conexión con LRCLIB. Vuelve a intentarlo.', 'TimeoutError')), REQUEST_TIMEOUT)
  try {
    let response: Response
    try {
      response = await fetch(url.href, { signal, mode: 'cors', credentials: 'omit', redirect: 'error', cache: 'no-store',
        headers: { Accept: 'application/json', 'Lrclib-Client': CLIENT } })
    } catch {
      aborted(signal)
      throw new Error('No se pudo conectar con LRCLIB. Vuelve a intentarlo.')
    }
    aborted(signal)
    if (response.status === 429 || response.status === 503) {
      const seconds = retrySeconds(response)
      retryAfter = Date.now() + seconds * 1000
      await response.body?.cancel()
      throw new Error(`LRCLIB está ocupado. Vuelve a intentarlo en ${seconds} segundos.`)
    }
    if (response.status === 404) { await response.body?.cancel(); aborted(signal); remember(key, null); return null }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`LRCLIB no pudo cargar la letra (HTTP ${response.status}). Vuelve a intentarlo.`) }
    if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      await response.body?.cancel()
      throw new Error('LRCLIB devolvió una respuesta no válida. Vuelve a intentarlo.')
    }
    const record = recordFrom(await body(response, signal))
    aborted(signal)
    const result = matches(signature, record) ? documentFrom(record) : null
    remember(key, result)
    return result
  } finally { clearTimeout(timer); nextRequest = Date.now() + REQUEST_SPACING }
}

/** Each selection supersedes pending lyrics, including when the selected track is cached. */
export async function lyricsGet(track: Omit<TrackQuery, 'id'>, signal?: AbortSignal): Promise<TextDocument | null> {
  active?.abort(new DOMException('La consulta de letras se sustituyó por otra canción.', 'AbortError'))
  const controller = new AbortController()
  active = controller
  const cancel = () => controller.abort(signal?.reason ?? new DOMException('Cancelado.', 'AbortError'))
  if (signal?.aborted) cancel()
  else signal?.addEventListener('abort', cancel, { once: true })
  try {
    aborted(controller.signal)
    if (![track.title, track.artist, track.album].every(value => typeof value === 'string' && [...value].length <= 512) ||
      (track.titleVersion != null && (typeof track.titleVersion !== 'string' || [...track.titleVersion].length > 512)) ||
      !Number.isSafeInteger(track.duration) || track.duration < 0 || track.duration > 4_294_967_295) {
      throw new Error('Los datos de la canción no son válidos para buscar su letra.')
    }
    const version = track.titleVersion?.trim() ?? '', suffix = normalize(version), normalizedTitle = normalize(track.title)
    const hasSuffix = normalizedTitle === suffix || normalizedTitle.endsWith(` ${suffix}`)
    const title = suffix && !hasSuffix ? `${track.title.trim()} (${version})` : track.title.trim()
    if ([...title].length > 512) throw new Error('Los datos de la canción no son válidos para buscar su letra.')
    const trimmed = { title, artist: track.artist.trim(), album: track.album.trim(), duration: track.duration }
    const signature = { ...trimmed, title: normalize(trimmed.title), artist: normalize(trimmed.artist), album: normalize(trimmed.album) }
    if (!signature.title || !signature.artist) return null
    const key = JSON.stringify(signature), saved = freshCache(key)
    if (saved) return copy(saved.value)
    const pending = queue.then(() => request(trimmed, signature, key, controller))
    queue = pending.then(() => undefined, () => undefined)
    return await pending
  } finally {
    signal?.removeEventListener('abort', cancel)
    if (active === controller) active = undefined
  }
}
