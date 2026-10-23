import type { Playable, TrackQuery } from '../src/lib/types'
import { recordingQuery } from './catalog-sources'
import { discoverFunkwhaleCandidates, fetchFunkwhaleAudio, rankFunkwhaleCandidates, type FunkwhaleCandidate } from './funkwhale'
import { getVerifiedFunkwhaleEntries, hasIndexedFunkwhaleCatalogId, matchVerifiedFunkwhaleCandidate, type VerifiedFunkwhaleEntry } from './funkwhale-identity'

interface CachedAudio { entry: VerifiedFunkwhaleEntry; candidate: FunkwhaleCandidate; url: string; used: number }
interface Options {
  hasCatalogId?: typeof hasIndexedFunkwhaleCatalogId
  hydrate?: typeof recordingQuery
  entries?: typeof getVerifiedFunkwhaleEntries
  match?: typeof matchVerifiedFunkwhaleCandidate
  discover?: typeof discoverFunkwhaleCandidates
  load?: typeof fetchFunkwhaleAudio
  createObjectURL?: (blob: Blob) => string
  revokeObjectURL?: (url: string) => void
  timeout?: number
  cacheBytes?: number
}
const key = (entry: VerifiedFunkwhaleEntry) => `${entry.catalog.id}:${entry.source.uploadUuid}:${entry.file.sha256}`
const check = (signal?: AbortSignal) => { if (signal?.aborted) throw signal.reason ?? new DOMException('Cancelado.', 'AbortError') }

/** All decoding stays in the existing player. The mobile path only reads and
 * hashes a bounded file; acoustic analysis runs when generating the static index. */
export function createFunkwhaleAudioResolver(options: Options = {}) {
  const hasId = options.hasCatalogId ?? hasIndexedFunkwhaleCatalogId
  const hydrate = options.hydrate ?? recordingQuery
  const entriesFor = options.entries ?? getVerifiedFunkwhaleEntries
  const match = options.match ?? matchVerifiedFunkwhaleCandidate
  const discover = options.discover ?? discoverFunkwhaleCandidates
  const load = options.load ?? fetchFunkwhaleAudio
  const create = options.createObjectURL ?? ((blob: Blob) => URL.createObjectURL(blob))
  const revoke = options.revokeObjectURL ?? ((url: string) => URL.revokeObjectURL(url))
  const maximum = Math.max(1, Math.min(options.cacheBytes ?? 64 * 1024 ** 2, 64 * 1024 ** 2))
  const timeout = Math.max(1, Math.min(options.timeout ?? 25000, 25000))
  const cache = new Map<string, CachedAudio>(), active = new Set<AbortController>()
  let pinned = new Set<string>(), generation = 0, clock = 0
  const playable = (track: TrackQuery, value: CachedAudio): Playable => ({
    videoId: '', title: track.title, channel: track.artist, url: value.url, local: false,
    source: { provider: 'funkwhale', id: value.entry.source.uploadUuid,
      download: { allowed: false, contentLength: value.entry.file.bytes, sha256: value.entry.file.sha256, duration: value.entry.file.durationSeconds } },
  })
  function reserve(bytes: number): void {
    let occupied = [...cache.values()].reduce((total, value) => total + value.entry.file.bytes, 0)
    for (const [id, value] of [...cache.entries()].sort((a, b) => a[1].used - b[1].used)) {
      if (occupied + bytes <= maximum) break
      if (pinned.has(value.url)) continue
      revoke(value.url)
      cache.delete(id)
      occupied -= value.entry.file.bytes
    }
    if (occupied + bytes > maximum) throw new Error('No hay espacio en memoria para preparar esta grabación.')
  }
  async function resolve(track: TrackQuery, signal?: AbortSignal): Promise<Playable | null> {
    check(signal)
    if (!hasId(track.id)) return null
    // A checked RAM copy can repeat without network. A missing ISRC may be
    // supplied only from that already hydrated, checked copy of this exact ID.
    const cached = [...cache.values()].filter(value => entriesFor({ ...track, isrc: track.isrc ?? value.entry.catalog.isrc }).includes(value.entry))
    const best = rankFunkwhaleCandidates(cached.map(value => value.candidate))[0]
    const hit = best && cached.find(value => value.candidate === best)
    if (hit) { hit.used = ++clock; return playable(track, hit) }
    if (active.size >= 2) throw new Error('Ya se están preparando otras grabaciones. Vuelve a intentarlo.')
    const controller = new AbortController(), revision = generation
    active.add(controller)
    const abort = () => controller.abort(signal?.reason ?? new DOMException('Cancelado.', 'AbortError'))
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(new DOMException('La fuente de audio tardó demasiado.', 'TimeoutError')), timeout)
    let stopped: (() => void) | undefined
    const aborted = new Promise<never>((_, reject) => {
      stopped = () => reject(controller.signal.reason ?? new DOMException('Cancelado.', 'AbortError'))
      controller.signal.addEventListener('abort', stopped, { once: true })
    })
    const work = async (): Promise<Playable | null> => {
      const recording = await hydrate(track, controller.signal)
      check(controller.signal)
      if (!recording) return null
      const entries = entriesFor(recording)
      if (!entries.length) return null
      const candidates = await discover(recording, controller.signal, { verifiedSources: entries.map(entry => entry.source) })
      check(controller.signal)
      let failure: unknown
      for (const candidate of candidates.slice(0, 4)) {
        const entry = entries.find(entry => match(recording, candidate, entry))
        if (!entry) continue
        try {
          const file = await load(candidate, controller.signal)
          check(controller.signal)
          if (revision !== generation) throw new DOMException('La aplicación se ha cerrado.', 'AbortError')
          if (file.bytes.byteLength !== entry.file.bytes || file.sha256 !== entry.file.sha256 || file.mime !== entry.file.mime) {
            throw new Error('La grabación de Funkwhale ya no coincide con el archivo verificado.')
          }
          const existing = cache.get(key(entry))
          if (existing) { existing.used = ++clock; return playable(track, existing) }
          reserve(file.bytes.byteLength)
          const value: CachedAudio = { entry, candidate, used: ++clock,
            url: create(new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.mime })) }
          cache.set(key(entry), value)
          return playable(track, value)
        } catch (error) { check(controller.signal); failure = error }
      }
      if (failure) throw failure
      return null
    }
    try { check(signal); return await Promise.race([work(), aborted]) }
    finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (stopped) controller.signal.removeEventListener('abort', stopped)
      active.delete(controller)
    }
  }
  // Updating pins never revokes synchronously: the player consumes its prepared
  // source between clearPrepared() and playAudio() in the same JavaScript task.
  function retain(urls: readonly string[]): void { pinned = new Set(urls.filter(url => typeof url === 'string' && url.startsWith('blob:'))) }
  function dispose(): void {
    generation++
    for (const controller of active) controller.abort(new DOMException('La aplicación se ha cerrado.', 'AbortError'))
    for (const value of cache.values()) revoke(value.url)
    cache.clear()
    pinned.clear()
  }
  return { resolve, retain, dispose }
}

const resolver = createFunkwhaleAudioResolver()
export const resolveFunkwhaleAudio = resolver.resolve
export const retainFunkwhaleAudio = resolver.retain
export const disposeFunkwhaleAudio = resolver.dispose
