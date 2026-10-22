import type { Playable, TrackQuery } from '../src/lib/types'
import { IRITSI_ALEA_CANDIDATE } from './verified-sources'
import { EGIOZU_ARCHIVE_CANDIDATE } from './verified-archive-source'

interface Registration {
  readonly enabled: boolean
  readonly provider?: 'alea' | 'archive'
  readonly id: string
  readonly url: string
  readonly identity: { readonly catalogId: number; readonly isrc: string; readonly title: string; readonly artist: string;
    readonly album: string; readonly catalogDurationSeconds: number }
  readonly file: { readonly bytes: number; readonly sha256: string; readonly mime: string; readonly durationSeconds: number;
    readonly proposedStartOffsetSeconds: number }
}
const normalize = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const isrc = (value: string) => value.replace(/[-\s]/g, '').toUpperCase()
const MAX_BYTES = 8 * 1024 * 1024

const archiveResponseUrl = (value: string) => {
  try {
    const url = new URL(value), wanted = new URL(EGIOZU_ARCHIVE_CANDIDATE.url)
    return url.protocol === 'https:' && (url.hostname === 'archive.org' || url.hostname.endsWith('.archive.org')) &&
      !url.port && !url.username && !url.password && !url.search && !url.hash &&
      (url.pathname === wanted.pathname || /^\/\d+\/items\//.test(url.pathname) &&
        url.pathname.replace(/^\/\d+\/items\//, '/download/') === wanted.pathname)
  } catch { return false }
}

/** A curated association is bound to a catalog identity and a complete immutable file. */
export function matchesVerifiedRecording(track: TrackQuery, source: Registration): boolean {
  const wanted = source.identity
  return source.enabled && track.id === wanted.catalogId &&
    (!track.isrc || isrc(track.isrc) === wanted.isrc) &&
    !track.titleVersion?.trim() && normalize(track.title) === normalize(wanted.title) &&
    normalize(track.artist) === normalize(wanted.artist) && normalize(track.album) === normalize(wanted.album) &&
    Number.isFinite(track.duration) && Math.abs(track.duration - wanted.catalogDurationSeconds) <= 3
}

/** The factory keeps synthetic-file tests independent from the registered recording. */
export function createVerifiedAudioResolver(registrations: readonly Registration[], options: {
  fetch?: typeof fetch; createObjectURL?: typeof URL.createObjectURL; revokeObjectURL?: typeof URL.revokeObjectURL; timeout?: number
} = {}) {
  const blobs = new Map<string, string>()
  const active = new Set<AbortController>()
  const request = options.fetch ?? globalThis.fetch
  const create = options.createObjectURL ?? ((blob: Blob) => URL.createObjectURL(blob))
  const revoke = options.revokeObjectURL ?? ((url: string) => URL.revokeObjectURL(url))
  let generation = 0
  const check = (signal?: AbortSignal) => { if (signal?.aborted) throw signal.reason ?? new DOMException('Cancelado.', 'AbortError') }
  const playable = (track: TrackQuery, source: Registration, url: string): Playable => ({ videoId: '', url,
    title: track.title, channel: track.artist, local: false,
    source: { provider: source.provider === 'archive' ? 'archive' : 'verified', id: source.id, startAt: source.file.proposedStartOffsetSeconds,
      download: { allowed: false, contentLength: source.file.bytes, sha256: source.file.sha256, duration: source.file.durationSeconds } } })

  async function resolve(track: TrackQuery, signal?: AbortSignal): Promise<Playable | null> {
    check(signal)
    const source = registrations.find((entry) => matchesVerifiedRecording(track, entry))
    if (!source) return null
    const cached = blobs.get(source.id)
    if (cached) return playable(track, source, cached)
    const archive = source.provider === 'archive'
    const pinned = archive ? EGIOZU_ARCHIVE_CANDIDATE : IRITSI_ALEA_CANDIDATE
    if (source.url !== pinned.url || source.id !== pinned.id || !Number.isSafeInteger(source.file.bytes) || source.file.bytes < 1 || source.file.bytes > MAX_BYTES ||
      !/^[a-f0-9]{64}$/.test(source.file.sha256)) throw new Error('La fuente verificada no es válida.')
    const controller = new AbortController(), revision = generation
    active.add(controller)
    const abort = () => controller.abort(signal?.reason ?? new DOMException('Cancelado.', 'AbortError'))
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(new DOMException('La fuente verificada tardó demasiado.', 'TimeoutError')), options.timeout ?? 15000)
    try {
      const response = await request(source.url, { signal: controller.signal, credentials: 'omit', mode: 'cors', redirect: archive ? 'follow' : 'error', referrerPolicy: 'no-referrer' })
      check(controller.signal)
      if (!response.ok || response.type === 'opaque' || !response.body) throw new Error('No se pudo leer la grabación verificada.')
      if (archive && response.url && !archiveResponseUrl(response.url)) {
        await response.body.cancel().catch(() => {})
        throw new Error('Archive devolvió una dirección ajena a la grabación verificada.')
      }
      const declared = response.headers.get('content-length')
      if (declared !== null && Number(declared) !== source.file.bytes) throw new Error('La grabación verificada ha cambiado de tamaño.')
      const reader = response.body.getReader(), chunks: Uint8Array[] = []
      let length = 0
      try {
        while (true) {
          const part = await reader.read()
          check(controller.signal)
          if (part.done) break
          length += part.value.byteLength
          if (length > source.file.bytes) throw new Error('La grabación verificada ha cambiado de tamaño.')
          chunks.push(part.value)
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error }
      if (length !== source.file.bytes) throw new Error('La grabación verificada está incompleta.')
      const bytes = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((n) => n.toString(16).padStart(2, '0')).join('')
      check(controller.signal)
      if (revision !== generation) throw new DOMException('La aplicación se ha cerrado.', 'AbortError')
      if (digest !== source.file.sha256) throw new Error('La grabación ya no coincide con el archivo comprobado.')
      const concurrent = blobs.get(source.id)
      if (concurrent) return playable(track, source, concurrent)
      // Play these exact checked bytes, avoiding a second unchecked network request.
      const blob = create(new Blob([bytes], { type: source.file.mime }))
      blobs.set(source.id, blob)
      return playable(track, source, blob)
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); active.delete(controller) }
  }
  function dispose() {
    generation++
    for (const controller of active) controller.abort(new DOMException('La aplicación se ha cerrado.', 'AbortError'))
    for (const blob of blobs.values()) revoke(blob)
    blobs.clear()
  }
  return { resolve, dispose }
}

const verified = createVerifiedAudioResolver([IRITSI_ALEA_CANDIDATE, EGIOZU_ARCHIVE_CANDIDATE])
export const resolveVerifiedAudio = verified.resolve
export const disposeVerifiedAudio = verified.dispose
