import type { DownloadEntry, LibTrack, Playable } from '../src/lib/types'

export const DOWNLOAD_DATABASE = 'pletina-web-downloads'
export const DOWNLOAD_CACHE = 'pletina-audio-downloads:v1'
export const MAX_DOWNLOAD_BYTES = 256 * 1024 ** 2
export interface DownloadRecord { id: number; track: LibTrack; size: number; at: number; cacheKey: string }
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
    artistId: integer(value.artistId), artistName: text(value.artistName), albumId: integer(value.albumId), albumTitle: text(value.albumTitle), albumArtistId: integer(value.albumArtistId), cover }
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
  function row(value: DownloadRecord): DownloadRecord {
    const id = downloadId(value.id), track = downloadTrack(value.track), size = integer(value.size), at = integer(value.at)
    if (id !== track.id || size > MAX_DOWNLOAD_BYTES || typeof value.cacheKey !== 'string') throw new Error('La descarga guardada no es válida.')
    const url = new URL(value.cacheKey), stable = new URL(audioCacheUrl(id, scope))
    if (url.origin !== stable.origin || url.pathname !== stable.pathname || url.username || url.password || url.hash ||
      [...url.searchParams.keys()].some((key) => key !== 'stage') || url.searchParams.getAll('stage').length !== 1 ||
      !/^\d{1,16}-[a-f0-9-]{36}$/i.test(url.searchParams.get('stage') ?? '')) throw new Error('La dirección de la copia guardada no es válida.')
    return { id, track, size, at, cacheKey: url.href }
  }
  async function request<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await open()
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
    const response = await (await cacheStorage.open(DOWNLOAD_CACHE)).match(saved.cacheKey)
    if (!response) { await remove(id); return null }
    const track = await trackMetadata(saved)
    return { videoId: '', url: audioCacheUrl(id, scope), title: track.title, channel: track.artistName, local: true }
  }
  async function listDownloads(): Promise<DownloadEntry[]> {
    const cache = await cacheStorage.open(DOWNLOAD_CACHE), values: DownloadEntry[] = []
    for (const saved of await list()) {
      if (!await cache.match(saved.cacheKey)) { await remove(saved.id); continue }
      values.push({ track: await trackMetadata(saved), path: audioCacheUrl(saved.id, scope), size: saved.size, at: saved.at })
    }
    return values
  }
  async function close() { await opening?.catch(() => {}); connection?.close(); connection = undefined; opening = undefined }
  return { scope, get, list, put, remove, close, listDownloads, readDownloadedPlayable, removeDownloadedTrack }
}
export type DownloadStore = ReturnType<typeof createDownloadStore>
let instance: DownloadStore | undefined
export const defaultDownloadStore = () => instance ??= createDownloadStore()
export const readDownloadedPlayable = (id: number) => defaultDownloadStore().readDownloadedPlayable(id)
export const removeDownloadedTrack = (id: number) => defaultDownloadStore().removeDownloadedTrack(id)
