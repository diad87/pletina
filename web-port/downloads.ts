import type { DownloadEntry, DownloadProgress, LibTrack, Playable, TrackQuery } from '../src/lib/types'
import { resolveRemoteTrack } from './audio'
import { stream, type StreamInfo } from './youtube'
import { audioCacheUrl, defaultDownloadStore, DOWNLOAD_CACHE, downloadId, downloadRevision, downloadTrack, MAX_DOWNLOAD_BYTES, type DownloadStore } from './download-store'

interface Options {
  store?: DownloadStore
  caches?: CacheStorage
  fetch?: typeof fetch
  resolve?: (track: TrackQuery, refresh?: boolean) => Promise<Playable>
  stream?: (videoId: string) => Promise<StreamInfo>
  validate?: (url: string, signal: AbortSignal) => Promise<void>
  emit?: (value: DownloadProgress) => void
  storage?: Pick<StorageManager, 'estimate' | 'persist'>
  timeout?: number
}
const cancelled = () => new DOMException('Descarga descartada.', 'AbortError')
export function validateDownloadedAudio(url: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const audio = new Audio()
    let finished = false
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); audio.removeEventListener('loadedmetadata', loaded); audio.removeEventListener('error', failed); audio.pause(); audio.removeAttribute('src'); audio.load() }
    const finish = (error?: Error) => { if (finished) return; finished = true; cleanup(); error ? reject(error) : resolve() }
    const loaded = () => Number.isFinite(audio.duration) && audio.duration > 0 ? finish() : failed()
    const failed = () => finish(new Error('La copia descargada no contiene audio reproducible. Vuelve a intentarlo.'))
    const abort = () => finish(signal.reason instanceof Error ? signal.reason : cancelled())
    const timer = setTimeout(() => finish(new Error('No se pudo comprobar el audio descargado a tiempo.')), 20000)
    audio.addEventListener('loadedmetadata', loaded)
    audio.addEventListener('error', failed)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); return }
    audio.preload = 'metadata'
    audio.src = url
    audio.load()
  })
}

export function createDownloadManager(options: Options = {}) {
  const store = options.store ?? defaultDownloadStore(), cacheStorage = options.caches ?? globalThis.caches
  const request = options.fetch ?? globalThis.fetch, resolve = options.resolve ?? resolveRemoteTrack, info = options.stream ?? stream
  const validate = options.validate ?? validateDownloadedAudio
  const storage = options.storage ?? globalThis.navigator?.storage
  const emit = options.emit ?? ((detail: DownloadProgress) => window.dispatchEvent(new CustomEvent('pletina:download', { detail })))
  const pending = new Set<number>(), queue: LibTrack[] = [], failed = new Set<number>()
  let running: Promise<void> | null = null
  const send = (trackId: number, state: DownloadProgress['state'], progress = 0, error: string | null = null) => emit({ trackId, state, progress, error })
  async function download(track: LibTrack) {
    const id = track.id, revision = downloadRevision(id), controller = new AbortController()
    const check = () => {
      if (controller.signal.aborted) throw controller.signal.reason instanceof Error ? controller.signal.reason : cancelled()
      if (revision !== downloadRevision(id)) throw cancelled()
    }
    const wait = <T>(pending: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
      const abort = () => reject(controller.signal.reason)
      if (controller.signal.aborted) { abort(); return }
      controller.signal.addEventListener('abort', abort, { once: true })
      pending.then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', abort))
    })
    const timer = setTimeout(() => controller.abort(new DOMException('La descarga tardó demasiado. Vuelve a intentarlo.', 'TimeoutError')), options.timeout ?? 90000)
    let stage: string | undefined, committed = false
    let cache: Cache | undefined
    try {
      cache = await wait(cacheStorage.open(DOWNLOAD_CACHE))
      const existing = await wait(store.readDownloadedPlayable(id))
      check()
      if (existing) { send(id, 'done', 1); return }
      const source = await wait(resolve({ id, title: track.title, artist: track.artistName, album: track.albumTitle, duration: track.duration }, failed.has(id)))
      check()
      if (!source.videoId || source.local) throw new Error('Los episodios RSS usan su audio original y todavía no se descargan como vídeos.')
      const details = await wait(info(source.videoId))
      check()
      const size = details.contentLength ?? 0
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_DOWNLOAD_BYTES) throw new Error('Este audio supera el límite de 256 MiB por descarga.')
      const estimate = typeof storage?.estimate === 'function' ? await wait(storage.estimate().catch(() => null)) : null
      if (estimate?.quota !== undefined && estimate.usage !== undefined && size > estimate.quota - estimate.usage) throw new Error('No hay espacio suficiente para esta descarga. Quita otras descargas y reintenta.')
      check()
      // El navegador decide si concede almacenamiento persistente; no bloquea la transferencia.
      if (typeof storage?.persist === 'function') void storage.persist().catch(() => false)
      stage = audioCacheUrl(id, store.scope) + '?stage=' + Date.now() + '-' + crypto.randomUUID()
      const response = await wait(request(details.url, { mode: 'no-cors', credentials: 'omit', signal: controller.signal }))
      check()
      if (response.type !== 'opaque' && !response.ok) throw new Error('No se pudo descargar el audio. Vuelve a intentarlo.')
      const cachePut = cache.put(stage, response)
      // Si un proveedor tarda en cerrar el cuerpo, una finalización posterior al timeout
      // tampoco puede dejar un fichero parcial huérfano.
      void cachePut.then(() => { if (controller.signal.aborted && stage && !committed) return cache!.delete(stage) }).catch(() => {})
      await wait(cachePut)
      check()
      await wait(validate(stage, controller.signal))
      check()
      const old = await wait(store.get(id))
      check()
      await wait(store.put({ id, track, size, at: Math.floor(Date.now() / 1000), cacheKey: stage }))
      check()
      committed = true
      if (old && old.cacheKey !== stage) await cache.delete(old.cacheKey).catch(() => false)
      failed.delete(id)
      send(id, 'done', 1)
    } finally {
      clearTimeout(timer)
      if (stage && !committed && cache) {
        const row = await store.get(id).catch(() => null)
        if (row?.cacheKey === stage) await store.remove(id).catch(() => {})
        await cache.delete(stage).catch(() => false)
      }
    }
  }
  async function drain() {
    while (queue.length) {
      const track = queue.shift()!
      send(track.id, 'downloading')
      try { await download(track) }
      catch (error) {
        failed.add(track.id)
        const abort = error instanceof DOMException && error.name === 'AbortError'
        const message = error instanceof DOMException && error.name === 'QuotaExceededError'
          ? 'El navegador no tiene espacio suficiente. Quita otras descargas y reintenta.'
          : error instanceof Error && !(error instanceof TypeError) && !/https?:\/\//i.test(error.message)
            ? error.message : 'No se pudo guardar el audio para escuchar sin conexión. Vuelve a intentarlo.'
        send(track.id, abort ? 'cancelled' : 'error', 0, abort ? null : message)
      } finally { pending.delete(track.id) }
    }
  }
  async function enqueueDownloads(values: LibTrack[]): Promise<void> {
    if (!Array.isArray(values) || values.length > 10000) throw new Error('La lista de descargas no es válida.')
    const normalized = values.map(downloadTrack)
    for (const track of normalized) {
      if (pending.has(track.id)) continue
      pending.add(track.id); queue.push(track); send(track.id, 'queued')
    }
    if (!running) running = drain().finally(() => { running = null; if (queue.length) void enqueueDownloads([]) })
  }
  function cancelDownloads(): void {
    for (const track of queue.splice(0)) { pending.delete(track.id); send(track.id, 'cancelled') }
  }
  async function removeDownloads(ids: number[]): Promise<void> {
    if (!Array.isArray(ids)) throw new Error('La lista de descargas no es válida.')
    const unique = new Set(ids.map(downloadId))
    for (const id of unique) {
      const queued = queue.findIndex((track) => track.id === id)
      if (queued >= 0) { queue.splice(queued, 1); pending.delete(id); send(id, 'cancelled') }
      await store.removeDownloadedTrack(id)
    }
  }
  return { enqueueDownloads, cancelDownloads, removeDownloads, listDownloads: store.listDownloads,
    async idle() { while (running) await running } }
}
let manager: ReturnType<typeof createDownloadManager> | undefined
const downloads = () => manager ??= createDownloadManager()
export const listDownloads = (): Promise<DownloadEntry[]> => downloads().listDownloads()
export const enqueueDownloads = (tracks: LibTrack[]): Promise<void> => downloads().enqueueDownloads(tracks)
export const cancelDownloads = (): void => downloads().cancelDownloads()
export const removeDownloads = (ids: number[]): Promise<void> => downloads().removeDownloads(ids)
