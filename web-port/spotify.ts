import type { ImportSource, ImportTrack } from '../src/lib/types'

const TOKEN_URL = 'https://open.spotify.com/embed/api/token'
const QUERY_URL = 'https://api-partner.spotify.com/pathfinder/v1/query'
// Spotify's own public mobile-web-player.cac367b7.js, reviewed 2026-10-23:
// https://open.spotifycdn.com/cdn/build/mobile-web-player/mobile-web-player.cac367b7.js
// Only its persisted query identifier is used; provider JavaScript is never run.
const QUERY_HASH = 'c685ca91fb0019c87ff1225f84e1d85b26cd631fa6187f3f0900da182cb0953d'
const PAGE_SIZE = 100
const MAX_TRACKS = 10_000
const MAX_BYTES = 4 * 1024 * 1024
const REQUEST_TIMEOUT = 12_000
const IMPORT_TIMEOUT = 60_000
const invalid = 'Spotify devolvió una lista que no se pudo leer. Vuelve a intentarlo o importa un archivo CSV.'
const timeout = 'Spotify tardó demasiado en responder. Vuelve a intentarlo.'
const encoder = new TextEncoder()
type Row = Record<string, unknown>
type GuestToken = { value: string; expiresAt: number }
// Resolved values only: cancelling one import cannot poison a later request.
// Tokens never enter storage, diagnostics, playlist data or provider URLs.
const tokens = new WeakMap<typeof fetch, GuestToken>()
const object = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
const text = (value: unknown, maxBytes: number): string => typeof value === 'string' && encoder.encode(value).length <= maxBytes ? value.trim() : ''
const abortReason = (signal: AbortSignal): Error => signal.reason instanceof Error ? signal.reason : new DOMException('Importación cancelada.', 'AbortError')
const checkAbort = (signal: AbortSignal) => { if (signal.aborted) throw abortReason(signal) }

class HttpError extends Error {
  readonly status: number
  constructor(status: number) {
    super(status === 404 ? 'No se encontró la playlist. Comprueba el enlace y que sea pública.'
      : status === 403 ? 'Spotify no permite leer esta playlist. Comprueba que sea pública.'
        : status === 429 ? 'Spotify ha limitado las consultas. Espera un momento y vuelve a intentarlo.'
          : status === 401 ? 'La sesión pública de Spotify ha caducado. Vuelve a intentarlo.'
            : 'No se pudo conectar con Spotify. Vuelve a intentarlo o importa un archivo CSV.')
    this.status = status
  }
}

async function requestJson(url: string, fetcher: typeof fetch, parent: AbortSignal, token?: string): Promise<unknown> {
  checkAbort(parent)
  const controller = new AbortController()
  const abort = () => controller.abort(abortReason(parent))
  parent.addEventListener('abort', abort, { once: true })
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let rejectAbort: (reason: unknown) => void = () => {}
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject })
  const stop = () => {
    rejectAbort(abortReason(controller.signal))
    void reader?.cancel().catch(() => {})
  }
  controller.signal.addEventListener('abort', stop, { once: true })
  const timer = setTimeout(() => controller.abort(new Error(timeout)), REQUEST_TIMEOUT)
  try {
    const work = async () => {
      let response: Response
      try {
        response = await fetcher(url, { credentials: 'omit', redirect: 'error', cache: 'no-store',
          headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: controller.signal })
      } catch {
        if (controller.signal.aborted) throw abortReason(controller.signal)
        throw new Error('No se pudo conectar con Spotify desde el navegador. Vuelve a intentarlo o importa un archivo CSV.')
      }
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {})
        throw abortReason(controller.signal)
      }
      if (response.status !== 200 || response.redirected) {
        void response.body?.cancel().catch(() => {})
        throw new HttpError(response.status)
      }
      if (Number(response.headers.get('content-length')) > MAX_BYTES) {
        void response.body?.cancel().catch(() => {})
        throw new Error('La respuesta de Spotify es demasiado grande.')
      }
      reader = response.body?.getReader()
      if (!reader) throw new Error(invalid)
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          checkAbort(controller.signal)
          const { done, value } = await reader.read()
          checkAbort(controller.signal)
          if (done) break
          size += value.byteLength
          if (size > MAX_BYTES) { await reader.cancel(); throw new Error('La respuesta de Spotify es demasiado grande.') }
          chunks.push(value)
        }
      } finally { reader.releaseLock(); reader = undefined }
      const content = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { content.set(chunk, offset); offset += chunk.length }
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content)) as unknown }
      catch { throw new Error(invalid) }
    }
    return await Promise.race([work(), aborted])
  } finally {
    clearTimeout(timer)
    controller.signal.removeEventListener('abort', stop)
    parent.removeEventListener('abort', abort)
  }
}

async function guestToken(fetcher: typeof fetch, signal: AbortSignal): Promise<GuestToken> {
  checkAbort(signal)
  const previous = tokens.get(fetcher)
  if (previous && previous.expiresAt > Date.now() + 30_000) return previous
  const data = object(await requestJson(TOKEN_URL, fetcher, signal))
  const value = data.accessToken, expiresAt = data.accessTokenExpirationTimestampMs, now = Date.now()
  if (data.isAnonymous !== true || typeof value !== 'string' || !/^[A-Za-z0-9._~-]{1,8192}$/.test(value)
    || typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= now + 5000 || expiresAt > now + 86_400_000) {
    throw new Error('Spotify no devolvió una sesión pública válida. Vuelve a intentarlo.')
  }
  checkAbort(signal)
  const result = { value, expiresAt }
  tokens.set(fetcher, result)
  return result
}

export interface SpotifyPlaylistPage {
  name: string
  tracks: ImportTrack[]
  skipped: number
  count: number
  total: number
  nextOffset: number | null
}

export function parsePublicSpotifyPlaylistPage(value: unknown, expectedId: string): SpotifyPlaylistPage {
  const root = object(value)
  if (Array.isArray(root.errors) && root.errors.length) throw new Error(invalid)
  const playlist = object(object(root.data).playlistV2)
  if (playlist.__typename === 'NotFound') throw new HttpError(404)
  if (playlist.__typename === 'GenericError') throw new Error('Spotify no permite leer esta playlist. Comprueba que sea pública.')
  const content = object(playlist.content)
  const nextOffset = object(content.pagingInfo).nextOffset
  const name = text(playlist.name, 2000)
  if (playlist.__typename !== 'Playlist' || playlist.uri !== `spotify:playlist:${expectedId}` || (playlist.id !== undefined && playlist.id !== expectedId)
    || !name || !Array.isArray(content.items) || content.items.length > PAGE_SIZE
    || typeof content.totalCount !== 'number' || !Number.isSafeInteger(content.totalCount) || content.totalCount < 0
    || (nextOffset !== null && (typeof nextOffset !== 'number' || !Number.isSafeInteger(nextOffset) || nextOffset < 0 || nextOffset > MAX_TRACKS))) throw new Error(invalid)
  if (content.totalCount > MAX_TRACKS) throw new Error('La playlist supera las 10.000 entradas. Divide la lista o importa un archivo CSV.')
  const result: SpotifyPlaylistPage = { name, tracks: [], skipped: 0, count: content.items.length, total: content.totalCount, nextOffset }
  for (const entry of content.items) {
    const wrapper = object(object(entry).itemV2), track = object(wrapper.data)
    const title = text(track.name, 2000)
    const rawArtists = object(track.artists).items
    const artists = Array.isArray(rawArtists) && rawArtists.length <= 100
      ? rawArtists.map((artist) => text(object(object(artist).profile).name, 1000)) : []
    if (wrapper.__typename !== 'TrackResponseWrapper' || track.__typename !== 'Track' || typeof track.uri !== 'string'
      || !/^spotify:track:[A-Za-z0-9]{22}$/.test(track.uri) || !title || !artists.length || artists.some((artist) => !artist)) {
      result.skipped++; continue
    }
    const duration = object(track.duration).totalMilliseconds
    const durationMs = typeof duration === 'number' && Number.isSafeInteger(duration) && duration > 0 && duration <= 86_400_000 ? duration : null
    result.tracks.push({ title, artists, durationMs, isrc: null })
  }
  return result
}

export async function readPublicSpotifyPlaylist(id: string, options: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<ImportSource> {
  if (!/^[A-Za-z0-9]{22}$/.test(id)) throw new Error('El identificador de la playlist de Spotify no es válido.')
  const fetcher = options.fetch ?? fetch
  const controller = new AbortController()
  const abort = () => controller.abort(options.signal ? abortReason(options.signal) : undefined)
  if (options.signal?.aborted) abort()
  else options.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error(timeout)), IMPORT_TIMEOUT)
  try {
    let session = await guestToken(fetcher, controller.signal), refreshed = false
    let offset = 0, total: number | undefined
    const source: ImportSource = { name: '', tracks: [], skipped: 0, warnings: [] }
    do {
      checkAbort(controller.signal)
      const query = new URLSearchParams({ operationName: 'queryPlaylist',
        variables: JSON.stringify({ uri: `spotify:playlist:${id}`, limit: PAGE_SIZE, offset, includeItemV3: false }),
        extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash: QUERY_HASH } }) })
      let raw: unknown
      for (;;) {
        try { raw = await requestJson(`${QUERY_URL}?${query}`, fetcher, controller.signal, session.value); break }
        catch (error) {
          if (!(error instanceof HttpError) || error.status !== 401 || refreshed) throw error
          refreshed = true
          if (tokens.get(fetcher) === session) tokens.delete(fetcher)
          session = await guestToken(fetcher, controller.signal)
        }
      }
      checkAbort(controller.signal)
      const page = parsePublicSpotifyPlaylistPage(raw, id)
      if ((total !== undefined && (total !== page.total || source.name !== page.name)) || offset + page.count > page.total
        || (page.count === 0 && offset < page.total)
        || page.nextOffset !== (offset + page.count < page.total ? offset + page.count : null)) {
        throw new Error('La playlist cambió o Spotify no devolvió todas sus canciones. Vuelve a intentarlo.')
      }
      total = page.total
      source.name = page.name
      source.tracks.push(...page.tracks)
      source.skipped += page.skipped
      offset += page.count
    } while (offset < total)
    if (source.skipped) source.warnings.push(`Se han omitido ${source.skipped} entradas sin datos suficientes, archivos locales o episodios de podcast.`)
    return source
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}
