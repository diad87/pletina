import type { LibTrack } from '../src/lib/types'
import { downloadTrack } from './download-store'

export const DOWNLOAD_QUEUE_DATABASE = 'pletina-web-download-queue'
const MAX_ITEMS = 10000
const MAX_BYTES = 2 * 1024 * 1024
export interface DownloadQueueJournal {
  read(): Promise<LibTrack[]>
  write(tracks: readonly LibTrack[]): Promise<void>
}

/** Only stable catalog metadata is durable. Resolved URLs, tokens and audio
 * bodies never belong to a pending-job checkpoint. The complete active job is
 * kept until its verified local file commits, so a killed page can restart it. */
export function createDownloadQueueJournal(options: { indexedDB?: IDBFactory; name?: string } = {}): DownloadQueueJournal {
  const factory = options.indexedDB ?? globalThis.indexedDB
  let opening: Promise<IDBDatabase> | undefined
  let connection: IDBDatabase | undefined
  let writes: Promise<void> = Promise.resolve()
  const normalize = (tracks: readonly LibTrack[]): LibTrack[] => {
    if (!Array.isArray(tracks) || tracks.length > MAX_ITEMS) throw new Error('La cola de descargas es demasiado grande.')
    const seen = new Set<number>()
    const result = tracks.map(downloadTrack).filter(track => !seen.has(track.id) && Boolean(seen.add(track.id)))
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_BYTES) throw new Error('La cola de descargas es demasiado grande.')
    return result
  }
  const open = () => opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (!factory) { reject(new Error('El navegador no permite conservar la cola de descargas.')); return }
    const request = factory.open(options.name ?? DOWNLOAD_QUEUE_DATABASE, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('state')
    request.onerror = () => { opening = undefined; reject(new Error('No se pudo abrir la cola de descargas.')) }
    request.onblocked = () => { opening = undefined; reject(new Error('Cierra las otras ventanas de Pletina para recuperar las descargas.')) }
    request.onsuccess = () => {
      connection = request.result
      connection.onversionchange = () => { connection?.close(); connection = undefined; opening = undefined }
      resolve(connection)
    }
  })
  async function read(): Promise<LibTrack[]> {
    await writes
    const db = await open()
    const value = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction('state', 'readonly'), request = tx.objectStore('state').get('pending')
      let result: unknown
      request.onsuccess = () => { result = request.result }
      tx.oncomplete = () => resolve(result)
      tx.onerror = tx.onabort = () => reject(new Error('No se pudo recuperar la cola de descargas.'))
    })
    if (value === undefined) return []
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('tracks' in value)) {
      throw new Error('La cola de descargas guardada no es válida.')
    }
    return normalize(value.tracks as LibTrack[])
  }
  function write(tracks: readonly LibTrack[]): Promise<void> {
    // Snapshot before awaiting IDB: a later mutation of the caller's array must
    // not change an already scheduled checkpoint. Serial writes cannot land out
    // of order; a failed transaction does not poison future explicit retries.
    let snapshot: LibTrack[]
    try { snapshot = normalize(tracks) } catch (error) { return Promise.reject(error) }
    const pending = writes.then(async () => {
      const db = await open()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('state', 'readwrite')
        tx.oncomplete = () => resolve()
        tx.onerror = tx.onabort = () => reject(new Error('No se pudo conservar la cola de descargas.'))
        try { tx.objectStore('state').put({ version: 1, tracks: snapshot }, 'pending') }
        catch { tx.abort() }
      })
    })
    writes = pending.catch(() => {})
    return pending
  }
  return { read, write }
}

let journal: DownloadQueueJournal | undefined
export const defaultDownloadQueueJournal = (): DownloadQueueJournal => journal ??= createDownloadQueueJournal()
