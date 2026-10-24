import type { DownloadEntry, LibTrack, Playable, PlayableSource } from '../src/lib/types'

export const DOWNLOAD_DATABASE = 'pletina-web-downloads'
export const DOWNLOAD_CACHE = 'pletina-audio-downloads:v1'
export const MAX_DOWNLOAD_BYTES = 256 * 1024 ** 2
export interface DownloadRecord { id: number; track: LibTrack; size: number; at: number; cacheKey: string; source?: PlayableSource }
export type DownloadMetadataReader = (trackId: number) => Promise<LibTrack | null>
interface Options { indexedDB?: IDBFactory; name?: string; scope?: string | URL; caches?: CacheStorage; readTrack?: DownloadMetadataReader }
let metadataReader: DownloadMetadataReader | undefined
/** The web adapter supplies the library reader; this module stays independent of storage/audio imports. */
export function configureDownloadMetadata(readTrack: DownloadMetadataReader | undefined): void { metadataReader = readTrack }
const revisions = new Map<number, number>()
export const downloadRevision = (id: number) => revisions.get(id) ?? 0
export const invalidateDownload = (id: number) => revisions.set(id, downloadRevision(id) + 1)

export function downloadId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value >= 1_000_000_000_000_000) throw new Error('El identificador de la descarga no es válido.')
  return value
}
const integer = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Los metadatos de la descarga no son válidos.')
  return value
}
const text = (value: unknown, empty = true) => {
  if (typeof value !== 'string' || value.length > 4000 || !empty && !value.trim()) throw new Error('Los metadatos de la descarga no son válidos.')
  return value.trim()
}
// SQLite NOCASE only folds ASCII A–Z; localeCompare would also reorder accents.
// Encoding once per entry preserves native UTF-8 order beyond the BMP as well.
function downloadTextKey(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value)
  for (let i = 0; i < bytes.length; i++) if (bytes[i] >= 65 && bytes[i] <= 90) bytes[i] += 32
  return bytes
}
function compareDownloadText(left: Uint8Array, right: Uint8Array): number {
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i] - right[i]
    if (left[i] === 0) break // NOCASE treats NUL as the end of the compared text.
  }
  return left.length - right.length
}
export function downloadTrack(value: LibTrack): LibTrack {
  if (!value || typeof value !== 'object' || typeof value.explicit !== 'boolean' || typeof value.duration !== 'number' || !Number.isFinite(value.duration) || value.duration < 0) throw new Error('La canción de la descarga no es válida.')
  let cover: string | null = null
  if (value.cover) {
    const url = new URL(value.cover)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || /(?:^|\.)googlevideo\.com$/i.test(url.hostname) ||
      [...url.searchParams.keys()].some((key) => /^(?:sig|lsig|signature|token|access_token|authorization|expires?|policy|key-pair-id|x-amz-(?:signature|credential)|x-goog-(?:signature|credential))$/i.test(key))) throw new Error('La carátula no es una dirección de metadatos permanente.')
    cover = url.href
  }
  return { id: downloadId(value.id), title: text(value.title, false), duration: value.duration, explicit: value.explicit,
    artistId: integer(value.artistId), artistName: text(value.artistName), albumId: integer(value.albumId), albumTitle: text(value.albumTitle), albumArtistId: integer(value.albumArtistId), cover,
    ...(value.isrc !== undefined ? { isrc: value.isrc === null ? null : text(value.isrc) } : {}),
    ...(value.titleVersion !== undefined ? { titleVersion: value.titleVersion === null ? null : text(value.titleVersion) } : {}),
  }
}
export function downloadScope(): URL { return new URL('../', window.location.href) }
export function audioCacheUrl(id: number, scope: URL = downloadScope()): string { return new URL('__audio__/' + downloadId(id), scope).href }

export function createDownloadStore(options: Options = {}) {
  const factory = options.indexedDB ?? globalThis.indexedDB
  const scope = options.scope ? new URL(options.scope) : downloadScope()
  const cacheStorage = options.caches ?? globalThis.caches
  const name = options.name ?? DOWNLOAD_DATABASE
  let opening: Promise<IDBDatabase> | undefined, connection: IDBDatabase | undefined
  const open = () => opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (!factory) { reject(new Error('El navegador no permite guardar descargas.')); return }
    const request = factory.open(name, 1)
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('files')) request.result.createObjectStore('files', { keyPath: 'id' }) }
    request.onerror = () => { opening = undefined; reject(new Error('No se pudo abrir la biblioteca de descargas.')) }
    request.onblocked = () => { opening = undefined; reject(new Error('Cierra las otras ventanas de Pletina y vuelve a intentar la descarga.')) }
    request.onsuccess = () => {
      connection = request.result
      connection.onversionchange = () => { connection?.close(); connection = undefined; opening = undefined }
      resolve(connection)
    }
  })
  function stageUrl(value: unknown, expectedId?: number): URL | null {
    if (typeof value !== 'string') return null
    try {
      const url = new URL(value), prefix = new URL('__audio__/', scope), raw = url.pathname.slice(prefix.pathname.length)
      if (url.origin !== prefix.origin || !url.pathname.startsWith(prefix.pathname) || !/^[1-9]\d{0,14}$/.test(raw)) return null
      const id = downloadId(Number(raw))
      if (expectedId !== undefined && id !== expectedId || url.pathname !== new URL(audioCacheUrl(id, scope)).pathname ||
        url.username || url.password || url.hash || [...url.searchParams.keys()].some(key => key !== 'stage') ||
        url.searchParams.getAll('stage').length !== 1 || !/^\d{1,16}-[a-f0-9-]{36}$/i.test(url.searchParams.get('stage') ?? '')) return null
      return url
    } catch { return null }
  }
  function row(value: DownloadRecord): DownloadRecord {
    const id = downloadId(value.id), track = downloadTrack(value.track), size = integer(value.size), at = integer(value.at)
    if (id !== track.id || size > MAX_DOWNLOAD_BYTES || typeof value.cacheKey !== 'string') throw new Error('La descarga guardada no es válida.')
    const url = stageUrl(value.cacheKey, id)
    if (!url) throw new Error('La dirección de la copia guardada no es válida.')
    let source: PlayableSource | undefined
    if (value.source !== undefined) {
      const original = value.source, file = original.download
      if (!['verified', 'archive', 'funkwhale'].includes(original.provider) || !/^[A-Za-z0-9_-]{1,200}$/.test(original.id) ||
        !file || file.allowed !== true || file.contentLength !== size || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '') ||
        !/^audio\/[a-z0-9.+-]+$/.test(file.mime ?? '') || !Number.isFinite(file.duration) || file.duration! <= 0 || file.duration! > 86400 ||
        !Number.isFinite(original.startAt ?? 0) || (original.startAt ?? 0) < 0 || (original.startAt ?? 0) >= file.duration!) {
        throw new Error('La identidad del archivo descargado no es válida.')
      }
      source = { provider: original.provider, id: original.id, startAt: original.startAt ?? 0,
        download: { allowed: true, contentLength: size, sha256: file.sha256, mime: file.mime, duration: file.duration } }
    }
    return { id, track, size, at, cacheKey: url.href, ...(source ? { source } : {}) }
  }
  async function request<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>, guard?: () => void): Promise<T> {
    guard?.()
    const db = await open()
    guard?.()
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction('files', mode)
      let result: T
      tx.oncomplete = () => resolve(result)
      tx.onabort = tx.onerror = () => reject(new Error('No se pudo guardar la biblioteca de descargas.'))
      try { const pending = work(tx.objectStore('files')); pending.onsuccess = () => { result = pending.result } }
      catch (error) { tx.abort(); reject(error) }
    })
  }
  const get = async (id: number): Promise<DownloadRecord | null> => {
    const value = await request<DownloadRecord | undefined>('readonly', (store) => store.get(downloadId(id)))
    if (!value) return null
    try { return row(value) } catch { return null }
  }
  const list = async (): Promise<DownloadRecord[]> => {
    const values = await request<DownloadRecord[]>('readonly', (store) => store.getAll())
    return values.flatMap((value) => { try { return [row(value)] } catch { return [] } }).sort((a, b) => b.at - a.at || b.id - a.id)
  }
  const put = async (value: DownloadRecord): Promise<void> => { const normalized = row(value); await request('readwrite', (store) => store.put(normalized)) }
  const remove = async (id: number): Promise<void> => { await request('readwrite', (store) => store.delete(downloadId(id))) }
  /** A cache probe can finish after a newer download commits. Retire only the
   * pointer actually observed missing, atomically with rereading the current row. */
  async function retireMissing(observed: DownloadRecord): Promise<DownloadRecord | null> {
    const db = await open()
    const replacement = await new Promise<DownloadRecord | undefined>((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite'), store = tx.objectStore('files')
      let current: DownloadRecord | undefined
      tx.oncomplete = () => resolve(current)
      tx.onabort = tx.onerror = () => reject(new Error('No se pudo comprobar la biblioteca de descargas.'))
      const pending = store.get(observed.id)
      pending.onsuccess = () => {
        try {
          if (pending.result?.cacheKey === observed.cacheKey) store.delete(observed.id)
          else current = pending.result
        } catch { tx.abort() }
      }
    })
    if (!replacement) return null
    try { return row(replacement) } catch { return null }
  }
  async function presentCopy(saved: DownloadRecord, cache: Cache): Promise<DownloadRecord | null> {
    let current: DownloadRecord | null = saved
    // One replacement probe avoids returning an obsolete miss after redownload,
    // while concurrent changes cannot create an unbounded reconciliation loop.
    for (let attempt = 0; attempt < 2 && current; attempt++) {
      if (await cache.match(current.cacheKey)) return current
      current = await retireMissing(current)
    }
    return null
  }
  /** Run only once, before the exclusive download owner starts its worker.
   * Staging bodies from a dead context have no IDB pointer. A current context's
   * in-flight stage must never be swept: subsequent resume calls skip this load.
   */
  async function reconcileStages(assertOwned: () => void): Promise<number> {
    assertOwned()
    const values = await request<unknown[]>('readonly', store => store.getAll(), assertOwned)
    assertOwned()
    // Preserve a valid pointer even if its other metadata is corrupt. Collection
    // is not a repair/migration and must not discard a possibly complete file.
    const references = new Set(values.flatMap(value => {
      const url = value && typeof value === 'object' && 'cacheKey' in value ? stageUrl(value.cacheKey) : null
      return url ? [url.href] : []
    }))
    assertOwned()
    const cache = await cacheStorage.open(DOWNLOAD_CACHE)
    assertOwned()
    const keys = await cache.keys()
    assertOwned()
    let deleted = 0
    for (const key of keys) {
      const url = key.method === 'GET' ? stageUrl(key.url) : null
      if (!url || references.has(url.href)) continue
      assertOwned()
      const removed = await cache.delete(key)
      assertOwned()
      if (removed) deleted++
    }
    return deleted
  }
  async function trackMetadata(saved: DownloadRecord): Promise<LibTrack> {
    if (saved.id < 250_000_000_000_000 || saved.id >= 500_000_000_000_000) return saved.track
    const readTrack = options.readTrack ?? metadataReader
    if (readTrack) {
      try {
        const current = await readTrack(saved.id)
        if (current?.id === saved.id) return downloadTrack(current)
      } catch { /* A missing/unavailable library must not discard a playable local download. */ }
    }
    return saved.track
  }
  async function removeDownloadedTrack(id: number): Promise<void> {
    invalidateDownload(downloadId(id))
    const saved = await get(id)
    await remove(id)
    if (saved) await (await cacheStorage.open(DOWNLOAD_CACHE)).delete(saved.cacheKey)
  }
  async function readDownloadedPlayable(id: number): Promise<Playable | null> {
    const saved = await get(id)
    if (!saved) return null
    const current = await presentCopy(saved, await cacheStorage.open(DOWNLOAD_CACHE))
    if (!current) return null
    const track = await trackMetadata(current)
    return { videoId: '', url: audioCacheUrl(id, scope), title: track.title, channel: track.artistName, local: true,
      ...(current.source ? { source: current.source } : {}) }
  }
  async function listDownloads(): Promise<DownloadEntry[]> {
    const cache = await cacheStorage.open(DOWNLOAD_CACHE), values: DownloadEntry[] = []
    for (const saved of await list()) {
      const current = await presentCopy(saved, cache)
      if (!current) continue
      values.push({ track: await trackMetadata(current), path: audioCacheUrl(current.id, scope), size: current.size, at: current.at })
    }
    // Sort the display/play queue after canonical YouTube metadata is read.
    // The APK groups artist/album, then oldest download first. Its SQL leaves
    // exact ties unspecified; ID ascending makes those ties stable on reopen.
    return values.map(entry => ({ entry, artist: downloadTextKey(entry.track.artistName), album: downloadTextKey(entry.track.albumTitle) }))
      .sort((a, b) => compareDownloadText(a.artist, b.artist) || compareDownloadText(a.album, b.album) ||
        a.entry.at - b.entry.at || a.entry.track.id - b.entry.track.id)
      .map(value => value.entry)
  }
  async function close() { await opening?.catch(() => {}); connection?.close(); connection = undefined; opening = undefined }
  return { scope, get, list, put, remove, close, reconcileStages, listDownloads, readDownloadedPlayable, removeDownloadedTrack }
}
export type DownloadStore = ReturnType<typeof createDownloadStore>
let instance: DownloadStore | undefined
export const defaultDownloadStore = () => instance ??= createDownloadStore()
export const readDownloadedPlayable = (id: number) => defaultDownloadStore().readDownloadedPlayable(id)
export const removeDownloadedTrack = (id: number) => defaultDownloadStore().removeDownloadedTrack(id)
