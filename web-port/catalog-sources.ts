import type { Playable, TrackQuery } from '../src/lib/types'
import { mapTopTrack, requestCatalog } from './catalog'

const AUDIUS_API = 'https://api.audius.co/v1'
const CATALOG_LIMIT = 250_000_000_000_000
const MAX_JSON = 1024 * 1024
const REQUEST_TIMEOUT = 6500
type Raw = Record<string, unknown>

/** These failures are not evidence that a recording is absent from a catalog. */
export class CatalogSourceError extends Error {
  constructor(message: string, readonly code: 'network' | 'timeout' | 'protocol') {
    super(message)
    this.name = 'CatalogSourceError'
  }
}

export function normalizeIsrc(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const result = value.trim().replaceAll('-', '').toUpperCase()
  return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(result) ? result : null
}

const record = (value: unknown): Raw | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Raw : null
const normalize = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ')
const label = (value: unknown): string | null => typeof value === 'string' && value.trim() && value.length <= 500 ? value.trim() : null
const validTrack = (track: TrackQuery) => Number.isSafeInteger(track.id) && track.id > 0 && track.id < CATALOG_LIMIT &&
  label(track.title) && label(track.artist) && normalize(track.title) && normalize(track.artist) && typeof track.album === 'string' && track.album.length <= 1000 &&
  (track.titleVersion == null || typeof track.titleVersion === 'string') && Number.isFinite(track.duration) && track.duration > 0 && track.duration <= 604800
const fullTitle = (track: Pick<TrackQuery, 'title' | 'titleVersion'>): string => {
  const title = normalize(track.title), version = label(track.titleVersion)
  return version && !` ${title} `.includes(` ${normalize(version)} `) ? normalize(`${track.title} ${version}`) : title
}

export async function recordingQuery(track: TrackQuery, signal?: AbortSignal): Promise<TrackQuery | null> {
  if (normalizeIsrc(track.isrc)) return track
  // Search and album rows can lack ISRC. Obtain it from this numeric catalog ID,
  // then cross-check identity rather than replacing the requested recording.
  let value: unknown
  try { value = await requestCatalog(`/track/${track.id}`, { signal }, true) }
  catch (error) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Cancelado.', 'AbortError')
    throw new CatalogSourceError('No se pudo comprobar la grabación en el catálogo.', 'network')
  }
  if (signal?.aborted) throw signal.reason ?? new DOMException('Cancelado.', 'AbortError')
  if (value === null) return null
  let detail
  try { detail = mapTopTrack(value) }
  catch { throw new CatalogSourceError('El catálogo devolvió metadatos no válidos.', 'protocol') }
  if (detail.id !== track.id || fullTitle(detail) !== fullTitle(track) || normalize(detail.artist.name) !== normalize(track.artist) ||
    Math.abs(detail.duration - track.duration) > 3 || (track.album.trim() && normalize(detail.album.title) !== normalize(track.album))) return null
  const isrc = normalizeIsrc(detail.isrc)
  return isrc ? { ...track, isrc, titleVersion: detail.titleVersion } : null
}

/** A matching title is insufficient. Never strip cover/live/remix/version qualifiers. */
export function matchAudiusRecording(track: TrackQuery, value: unknown): { id: string; downloadAllowed: boolean } | null {
  const wantedIsrc = normalizeIsrc(track.isrc), raw = record(value), user = record(raw?.user), access = record(raw?.access)
  const title = label(raw?.title), artist = label(user?.name), id = raw?.id
  if (!validTrack(track) || !wantedIsrc || !raw || !title || !artist || typeof id !== 'string' || !/^[A-Za-z0-9]{1,30}$/.test(id) ||
    normalizeIsrc(raw.isrc) !== wantedIsrc || normalize(artist) !== normalize(track.artist) ||
    typeof raw.duration !== 'number' || !Number.isFinite(raw.duration) || Math.abs(raw.duration - track.duration) > 3 ||
    raw.is_available !== true || raw.is_delete !== false || raw.is_streamable !== true || raw.is_stream_gated !== false || access?.stream !== true ||
    raw.cover_original_song_title || raw.cover_original_artist || raw.stem_of ||
    (record(raw.remix_of)?.tracks && (!Array.isArray(record(raw.remix_of)?.tracks) || (record(raw.remix_of)?.tracks as unknown[]).length > 0))) return null

  // Some artists prefix their own name; labels/uploader names are not interchangeable with artists.
  const prefixed = `${artist} - `
  const sourceTitle = title.startsWith(prefixed) ? title.slice(prefixed.length) : title
  if (normalize(sourceTitle) !== fullTitle(track)) return null
  return { id, downloadAllowed: raw.is_downloadable === true && raw.is_download_gated === false && access.download === true }
}

async function audiusTracks(isrc: string, signal?: AbortSignal): Promise<unknown[]> {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Cancelado.', 'AbortError')
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason ?? new DOMException('Cancelado.', 'AbortError'))
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new CatalogSourceError('Audius tardó demasiado en responder.', 'timeout')), REQUEST_TIMEOUT)
  try {
    const response = await fetch(`${AUDIUS_API}/tracks?isrc=${isrc}&limit=25`, {
      signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
    })
    if (!response.ok) throw new CatalogSourceError(`No se pudo consultar Audius (${response.status}).`, 'network')
    const declared = response.headers.get('content-length')
    if (declared !== null && Number(declared) > MAX_JSON) throw new CatalogSourceError('La respuesta de Audius es demasiado grande.', 'protocol')
    // Stop oversized/chunked bodies while reading; Content-Length may be absent.
    const reader = response.body?.getReader()
    let text = ''
    if (reader) {
      const decoder = new TextDecoder()
      let bytes = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          bytes += value.byteLength
          if (bytes > MAX_JSON) {
            void reader.cancel().catch(() => {})
            throw new CatalogSourceError('La respuesta de Audius es demasiado grande.', 'protocol')
          }
          text += decoder.decode(value, { stream: true })
        }
        text += decoder.decode()
      } finally { reader.releaseLock() }
    } else text = await response.text()
    if (text.length > MAX_JSON) throw new CatalogSourceError('La respuesta de Audius es demasiado grande.', 'protocol')
    let json: Raw | null
    try { json = record(JSON.parse(text)) } catch { throw new CatalogSourceError('Audius devolvió una respuesta no válida.', 'protocol') }
    if (!json || !Array.isArray(json.data) || json.data.length > 25) throw new CatalogSourceError('Audius devolvió una respuesta no válida.', 'protocol')
    return json.data
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason
    if (error instanceof CatalogSourceError) throw error
    throw new CatalogSourceError('No se pudo conectar con Audius.', 'network')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

/** Public direct-audio fallback. No text search or guessed matches when the ISRC is missing. */
export async function resolveCatalogSource(track: TrackQuery, signal?: AbortSignal): Promise<Playable | null> {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Cancelado.', 'AbortError')
  if (!validTrack(track)) return null
  const recording = await recordingQuery(track, signal)
  const isrc = normalizeIsrc(recording?.isrc)
  if (!recording || !isrc) return null
  const candidates = await audiusTracks(isrc, signal)
  if (signal?.aborted) throw signal.reason ?? new DOMException('Cancelado.', 'AbortError')
  for (const candidate of candidates) {
    const match = matchAudiusRecording(recording, candidate)
    if (!match) continue
    return { videoId: '', url: `${AUDIUS_API}/tracks/${match.id}/stream`, title: track.title, channel: track.artist, local: false,
      source: { provider: 'audius', id: match.id, expiresAt: Date.now() + 5 * 60 * 1000,
        download: { allowed: match.downloadAllowed, duration: track.duration } } }
  }
  return null
}
