import type { DownloadEntry, DownloadProgress, LibTrack, Playable, PlayableSource, TrackQuery } from '../src/lib/types'
import { resolveRemoteTrack } from './audio'
import { stream, type StreamInfo } from './youtube'
import { audioCacheUrl, defaultDownloadStore, DOWNLOAD_CACHE, downloadId, downloadRevision, downloadTrack, MAX_DOWNLOAD_BYTES, type DownloadStore } from './download-store'
import { defaultDownloadQueueJournal, type DownloadQueueJournal } from './download-queue'
import { defaultDownloadOwnership, type DownloadOwnership } from './download-ownership'

interface Options {
  store?: DownloadStore
  caches?: CacheStorage
  fetch?: typeof fetch
  resolve?: (track: TrackQuery, refresh?: boolean) => Promise<Playable>
  stream?: (videoId: string) => Promise<StreamInfo>
  validate?: (url: string, signal: AbortSignal, expectedDuration?: number) => Promise<void>
  emit?: (value: DownloadProgress) => void
  storage?: Pick<StorageManager, 'estimate' | 'persist'>
  timeout?: number
  retryDelay?: number
  journal?: DownloadQueueJournal
  online?: () => boolean
  ownership?: DownloadOwnership
}
const cancelled = () => new DOMException('Descarga descartada.', 'AbortError')
export function validateDownloadedAudio(url: string, signal: AbortSignal, expectedDuration?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const audio = new Audio()
    let finished = false
    let tail = -1
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); audio.removeEventListener('loadedmetadata', loaded); audio.removeEventListener('error', failed); for (const type of ['seeked', 'loadeddata', 'canplay']) audio.removeEventListener(type, tailReady); audio.pause(); audio.removeAttribute('src'); audio.load() }
    const finish = (error?: Error) => { if (finished) return; finished = true; cleanup(); error ? reject(error) : resolve() }
    const tailReady = () => { if (tail >= 0 && !audio.seeking && audio.readyState >= 2 && audio.currentTime >= tail - 0.1) finish() }
    const loaded = () => {
      if (!Number.isFinite(audio.duration) || audio.duration <= 0) { failed(); return }
      if (expectedDuration === undefined) { finish(); return }
      if (!Number.isFinite(expectedDuration) || expectedDuration <= 0 || Math.abs(audio.duration - expectedDuration) > 3) {
        finish(new Error('La copia descargada no tiene la duración de la canción completa. Vuelve a intentarlo.')); return
      }
      // A duration tag alone can describe a longer/truncated file. Require decodable
      // media at its tail as well; this never plays or changes the active player.
      tail = Math.max(0, audio.duration - 0.25)
      try { audio.currentTime = tail; tailReady() } catch { failed() }
    }
    const failed = () => finish(new Error('La copia descargada no contiene audio reproducible. Vuelve a intentarlo.'))
    const abort = () => finish(signal.reason instanceof Error ? signal.reason : cancelled())
    const timer = setTimeout(() => finish(new Error('No se pudo comprobar el audio descargado a tiempo.')), 20000)
    audio.addEventListener('loadedmetadata', loaded)
    audio.addEventListener('error', failed)
    for (const type of ['seeked', 'loadeddata', 'canplay']) audio.addEventListener(type, tailReady)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); return }
    audio.preload = expectedDuration === undefined ? 'metadata' : 'auto'
    audio.src = url
    audio.load()
  })
}

const AUDIO_MIME = /^audio\/(?:mpeg|mp3|mp4|aac|ogg|flac|wav|wave|webm|x-(?:mpeg|m4a|flac|wav))$/
interface DownloadFile { url: string; size: number; duration: number; sha256?: string; mime?: string; identity?: PlayableSource }
function p1Download(source: Playable): DownloadFile {
  const identity = source.source, permission = identity?.download
  if (permission?.allowed !== true) throw new Error('Esta fuente permite escuchar la canción, pero no descargarla para usarla sin conexión.')
  const size = permission.contentLength, duration = permission.duration
  let url: URL
  try { url = new URL(source.url) } catch { throw new Error('La dirección del audio de YouTube no es válida.') }
  const declared = url.searchParams.getAll('clen')
  if (identity?.provider !== 'youtube-p1' || !/^[A-Za-z0-9_-]{11}$/.test(source.videoId) || identity.id !== source.videoId ||
    url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
    !(url.hostname === 'googlevideo.com' || url.hostname.endsWith('.googlevideo.com')) ||
    !Number.isSafeInteger(size) || size! <= 0 || size! > MAX_DOWNLOAD_BYTES ||
    typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || duration > 86400 ||
    declared.length > 1 || declared.length === 1 && (!/^\d{1,10}$/.test(declared[0]) || Number(declared[0]) !== size)) {
    throw new Error('Esta fuente no aporta un tamaño y una duración válidos para comprobar la descarga completa.')
  }
  // An opaque Googlevideo response cannot expose its size or hash. Its declared
  // size is a quota estimate; only completed caching and local media validation
  // authorize commit. No P1 locator or verified-source identity is persisted.
  return { url: source.url, size: size!, duration }
}
function externalDownload(source: Playable, track: LibTrack, scope: URL): DownloadFile {
  const identity = source.source, permission = identity?.download
  if (permission?.allowed !== true) throw new Error('Esta fuente permite escuchar la canción, pero no descargarla para usarla sin conexión.')
  if (identity && ['verified', 'archive', 'funkwhale'].includes(identity.provider)) {
    let url: URL
    try { url = new URL(source.url) } catch { throw new Error('La dirección del archivo verificado no es válida.') }
    const size = permission.contentLength, duration = permission.duration, startAt = identity.startAt ?? 0
    if (url.protocol !== 'blob:' || url.origin !== scope.origin || !/^[A-Za-z0-9_-]{1,200}$/.test(identity.id) ||
      !Number.isSafeInteger(size) || size! <= 0 || size! > MAX_DOWNLOAD_BYTES || !/^[a-f0-9]{64}$/.test(permission.sha256 ?? '') ||
      !AUDIO_MIME.test(permission.mime ?? '') || !Number.isFinite(duration) || duration! <= 0 || duration! > 86400 ||
      !Number.isFinite(startAt) || startAt < 0 || startAt >= duration!) throw new Error('No se puede comprobar el archivo completo de esta fuente.')
    // This URL already names the exact full bytes verified by the resolver. The
    // copy is hashed again before commit; no provider URL or Blob URL persists.
    return { url: url.href, size: size!, duration: duration!, sha256: permission.sha256, mime: permission.mime,
      identity: { provider: identity.provider, id: identity.id, startAt,
        download: { allowed: true, contentLength: size!, sha256: permission.sha256, duration: duration!, mime: permission.mime } } }
  }
  if (identity?.provider !== 'audius' || !/^[A-Za-z0-9]{1,30}$/.test(identity.id) ||
    source.url !== `https://api.audius.co/v1/tracks/${identity.id}/stream`) throw new Error('Esta fuente todavía no permite descargas verificadas en Pletina.')
  const size = permission.contentLength ?? 0, duration = permission.duration ?? track.duration
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_DOWNLOAD_BYTES) throw new Error('Este audio supera el límite de 256 MiB por descarga.')
  if (!Number.isFinite(duration) || duration <= 0 || Math.abs(duration - track.duration) > 3) throw new Error('La fuente no corresponde a la duración de esta canción.')
  if (permission.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(permission.sha256)) throw new Error('La comprobación de esta descarga no es válida.')
  return { url: source.url, size, duration, ...(permission.sha256 ? { sha256: permission.sha256.toLowerCase() } : {}) }
}

export function createDownloadManager(options: Options = {}) {
  const store = options.store ?? defaultDownloadStore(), cacheStorage = options.caches ?? globalThis.caches
  const request = options.fetch ?? globalThis.fetch, resolve = options.resolve ?? resolveRemoteTrack, info = options.stream ?? stream
  const validate = options.validate ?? validateDownloadedAudio
  const storage = options.storage ?? globalThis.navigator?.storage
  const journal = options.journal ?? defaultDownloadQueueJournal()
  const online = options.online ?? (() => globalThis.navigator?.onLine !== false)
  const ownership = options.ownership ?? defaultDownloadOwnership()
  const emit = options.emit ?? ((detail: DownloadProgress) => window.dispatchEvent(new CustomEvent('pletina:download', { detail })))
  const pending = new Set<number>(), queue: LibTrack[] = [], failed = new Set<number>()
  let running: Promise<void> | null = null, current: LibTrack | null = null, loaded = false, suspended = false
  let mutations: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = mutations.then(async () => { await ownership.acquire(); ownership.assertOwned(); return work() })
    mutations = result.catch(() => {})
    return result
  }
  const jobs = () => [...(current && pending.has(current.id) ? [current] : []), ...queue]
  const load = async () => {
    if (loaded) return
    const saved = await journal.read(), seen = new Set<number>(), restored: LibTrack[] = []
    ownership.assertOwned()
    for (const value of saved) { const track = downloadTrack(value); if (!seen.has(track.id)) { seen.add(track.id); restored.push(track) } }
    await store.reconcileStages(() => ownership.assertOwned())
    ownership.assertOwned()
    for (const track of restored) { pending.add(track.id); queue.push(track) }
    loaded = true
  }
  const send = (trackId: number, state: DownloadProgress['state'], progress = 0, error: string | null = null) => emit({ trackId, state, progress, error })
  async function download(track: LibTrack) {
    const id = track.id, revision = downloadRevision(id), controller = new AbortController()
    const check = () => {
      ownership.assertOwned()
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
      if (existing) return
      for (let attempt = 0; attempt < 2; attempt++) {
        const refresh = failed.has(id) || attempt > 0
        const source = await wait(resolve({ id, title: track.title, artist: track.artistName, album: track.albumTitle, duration: track.duration,
          isrc: track.isrc, titleVersion: track.titleVersion }, refresh))
        check()
        if (source.local || !source.videoId && !source.source) throw new Error('Los episodios RSS usan su audio original y todavía no se descargan como vídeos.')
        // P1 must retain its already-probed encoding; legacy YouTube can read
        // the selected stream's details from its existing RAM cache.
        const p1 = source.source?.provider === 'youtube-p1', external = Boolean(source.source) && !p1
        const details = p1 ? p1Download(source) : external ? externalDownload(source, track, store.scope) : await wait(info(source.videoId))
        check()
        let size = 'size' in details ? details.size : details.contentLength ?? 0
        if (!Number.isSafeInteger(size) || size < 0 || size > MAX_DOWNLOAD_BYTES) throw new Error('Este audio supera el límite de 256 MiB por descarga.')
        const estimate = typeof storage?.estimate === 'function' ? await wait(storage.estimate().catch(() => null)) : null
        if (estimate?.quota !== undefined && estimate.usage !== undefined && size > estimate.quota - estimate.usage) throw new Error('No hay espacio suficiente para esta descarga. Quita otras descargas y reintenta.')
        check()
        // El navegador decide si concede almacenamiento persistente; no bloquea la transferencia.
        if (typeof storage?.persist === 'function') void storage.persist().catch(() => false)
        stage = audioCacheUrl(id, store.scope) + '?stage=' + Date.now() + '-' + crypto.randomUUID()
        const attemptStage = stage
        try {
          const response = await wait(request(details.url, { mode: external ? 'cors' : 'no-cors', credentials: 'omit',
            ...(external ? { referrerPolicy: 'no-referrer' as const } : {}), signal: controller.signal }))
          check()
          if (response.type !== 'opaque' && !response.ok) throw new Error('No se pudo descargar el audio. Vuelve a intentarlo.')
          if (p1 && response.type !== 'opaque' && (response.status !== 200 || response.headers.has('content-range'))) {
            void response.body?.cancel().catch(() => {})
            throw new Error('La fuente no entregó un archivo de audio completo que se pueda descargar.')
          }
          let cachedResponse = response, actualBytes = 0, bodyComplete = false
          if (external) {
            const rejectBody = (message: string): never => { void response.body?.cancel().catch(() => {}); throw new Error(message) }
            const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '', body = response.body
            if (response.type === 'opaque' || response.status !== 200 || response.headers.has('content-range') ||
              !AUDIO_MIME.test(contentType) || !body) {
              rejectBody('La fuente no entregó un archivo de audio completo que se pueda descargar.')
            }
            if ('mime' in details && details.mime && contentType !== details.mime) rejectBody('El formato descargado no coincide con el archivo verificado.')
            const declared = response.headers.get('content-length')
            if (declared !== null) {
              if (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) <= 0 || Number(declared) > MAX_DOWNLOAD_BYTES) {
                rejectBody('El tamaño del audio descargado no es válido o supera 256 MiB.')
              }
              if (size && Number(declared) !== size) rejectBody('El tamaño entregado no coincide con la canción completa.')
              size = Number(declared)
            }
            const available = estimate?.quota !== undefined && estimate.usage !== undefined ? estimate.quota - estimate.usage : undefined
            if (available !== undefined && size > available) rejectBody('No hay espacio suficiente para esta descarga. Quita otras descargas y reintenta.')
            const expectedBytes = size
            const counter = new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, writer) {
                check()
                actualBytes += chunk.byteLength
                if (actualBytes > MAX_DOWNLOAD_BYTES || expectedBytes && actualBytes > expectedBytes) throw new Error('El audio supera el tamaño completo esperado o el límite de 256 MiB.')
                if (available !== undefined && actualBytes > available) throw new DOMException('No hay espacio suficiente para la descarga.', 'QuotaExceededError')
                writer.enqueue(chunk)
                if (expectedBytes) send(id, 'downloading', Math.min(0.99, actualBytes / expectedBytes))
              },
              flush() {
                check()
                if (!actualBytes || expectedBytes && actualBytes !== expectedBytes) throw new Error('La descarga quedó incompleta. Vuelve a intentarlo.')
                bodyComplete = true
              },
            })
            const headers = new Headers({ 'content-type': contentType })
            if (expectedBytes) headers.set('content-length', String(expectedBytes))
            cachedResponse = new Response(body!.pipeThrough(counter), { status: 200, headers })
          }
          const cachePut = cache.put(attemptStage, cachedResponse)
          // Si un proveedor tarda en cerrar el cuerpo, una finalización posterior al timeout
          // tampoco puede dejar un fichero parcial huérfano.
          void cachePut.then(() => { if (controller.signal.aborted && !committed) return cache!.delete(attemptStage) }).catch(() => {})
          await wait(cachePut)
          check()
          if (external) {
            if (!bodyComplete || !actualBytes) throw new Error('No se pudo comprobar la descarga completa.')
            size = actualBytes
            if ('sha256' in details && details.sha256) {
              const copy = await wait(cache.match(attemptStage))
              if (!copy) throw new Error('No se pudo comprobar el archivo descargado.')
              const bytes = await wait(copy.arrayBuffer())
              check()
              const hash = await wait(crypto.subtle.digest('SHA-256', bytes))
              const actualHash = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('')
              if (actualHash !== details.sha256) throw new Error('La copia descargada no coincide con el audio verificado.')
            }
          }
          await wait(validate(attemptStage, controller.signal, external || p1 ? details.duration ?? undefined : undefined))
          check()
        } catch (error) {
          check()
          if (attempt > 0 || error instanceof DOMException && error.name !== 'NetworkError') throw error
          // Las respuestas opacas no permiten continuar por bytes ni leer un 403. Una única
          // copia nueva con URL renovada recupera cortes o caducidad sin conservar audio parcial.
          await wait(cache.delete(attemptStage))
          stage = undefined
          let retryTimer: ReturnType<typeof setTimeout> | undefined
          try { await wait(new Promise<void>((done) => { retryTimer = setTimeout(done, options.retryDelay ?? 1000) })) }
          finally { clearTimeout(retryTimer) }
          check()
          continue
        }
        const old = await wait(store.get(id))
        check()
        await wait(store.put({ id, track, size, at: Math.floor(Date.now() / 1000), cacheKey: attemptStage,
          ...('identity' in details && details.identity ? { source: details.identity } : {}) }))
        check()
        committed = true
        if (old && old.cacheKey !== attemptStage) await cache.delete(old.cacheKey).catch(() => false)
        failed.delete(id)
        break
      }
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
    while (!suspended && online()) {
      const track = await serial(async () => { await load(); if (!queue.length || suspended || !online()) return null; current = queue.shift()!; return current })
      if (!track) return
      send(track.id, 'downloading')
      let failure: unknown
      try { await download(track) }
      catch (error) { failure = error }
      const code = failure && typeof failure === 'object' && 'code' in failure ? failure.code : null
      const interrupted = failure && (!online() || failure instanceof TypeError || ['network', 'timeout'].includes(String(code)) ||
        failure instanceof DOMException && ['NetworkError', 'TimeoutError'].includes(failure.name))
      if (interrupted) {
        failed.add(track.id)
        await serial(async () => {
          if (pending.has(track.id)) queue.unshift(track)
          current = null; suspended = true
        })
        if (pending.has(track.id)) send(track.id, 'queued', 0, 'La conexión se ha interrumpido. Reintenta para continuar.')
        return
      }
      let retired = false
      try {
        await serial(async () => {
          retired = !pending.has(track.id)
          const remaining = jobs().filter(value => value.id !== track.id)
          await journal.write(remaining)
          ownership.assertOwned()
          pending.delete(track.id); current = null
        })
      } catch (error) {
        // The verified file may already exist. Keep the journal entry so reopen
        // can reconcile it against that file; never lose the remaining FIFO.
        await serial(async () => { if (pending.has(track.id)) queue.unshift(track); current = null; suspended = true })
        send(track.id, 'error', 0, 'No se pudo guardar el estado de la cola. Vuelve a abrir Pletina o reintenta.')
        return
      }
      if (retired) continue
      if (!failure) { send(track.id, 'done', 1); continue }
      const error = failure
      {
        failed.add(track.id)
        const abort = error instanceof DOMException && error.name === 'AbortError'
        const message = error instanceof DOMException && error.name === 'QuotaExceededError'
          ? 'El navegador no tiene espacio suficiente. Quita otras descargas y reintenta.'
          : error instanceof Error && !(error instanceof TypeError) && !/https?:\/\//i.test(error.message)
            ? error.message : 'No se pudo guardar el audio para escuchar sin conexión. Vuelve a intentarlo.'
        send(track.id, abort ? 'cancelled' : 'error', 0, abort ? null : message)
      }
    }
  }
  function launch(): void {
    if (running || suspended || !online() || !queue.length) return
    running = drain().catch(error => {
      suspended = true
      if (current) send(current.id, 'error', 0, error instanceof Error && !/https?:\/\//i.test(error.message) ? error.message : 'No se pudo continuar la cola de descargas.')
    }).finally(() => { running = null; if (queue.length && !suspended && online()) launch() })
  }
  async function enqueueDownloads(values: LibTrack[]): Promise<void> {
    if (!Array.isArray(values) || values.length > 10000) throw new Error('La lista de descargas no es válida.')
    const normalized = values.map(downloadTrack)
    await serial(async () => {
      await load()
      const seen = new Set(pending), additions = normalized.filter(track => { if (seen.has(track.id)) return false; seen.add(track.id); return true })
      await journal.write([...jobs(), ...additions])
      ownership.assertOwned()
      for (const track of additions) { pending.add(track.id); queue.push(track); send(track.id, 'queued') }
      suspended = false
    })
    launch()
  }
  async function pendingDownloads(): Promise<LibTrack[]> {
    return serial(async () => { await load(); return jobs().map(downloadTrack) })
  }
  async function resumeDownloads(): Promise<void> {
    await serial(async () => { await load(); suspended = false; for (const track of queue) send(track.id, 'queued') })
    launch()
  }
  async function cancelDownloads(): Promise<void> {
    await serial(async () => {
      await load()
      await journal.write(current && pending.has(current.id) ? [current] : [])
      ownership.assertOwned()
      for (const track of queue.splice(0)) { pending.delete(track.id); send(track.id, 'cancelled') }
    })
  }
  async function removeDownloads(ids: number[]): Promise<void> {
    if (!Array.isArray(ids)) throw new Error('La lista de descargas no es válida.')
    const unique = new Set(ids.map(downloadId))
    await serial(async () => {
      await load()
      await journal.write(jobs().filter(track => !unique.has(track.id)))
      ownership.assertOwned()
      for (const id of unique) {
        const queued = queue.findIndex((track) => track.id === id)
        if (queued >= 0) queue.splice(queued, 1)
        if (pending.delete(id)) send(id, 'cancelled')
        await store.removeDownloadedTrack(id)
      }
    })
  }
  return { enqueueDownloads, cancelDownloads, removeDownloads, pendingDownloads, resumeDownloads, listDownloads: store.listDownloads,
    async idle() { while (running) await running } }
}
let manager: ReturnType<typeof createDownloadManager> | undefined
const downloads = () => manager ??= createDownloadManager()
export const listDownloads = (): Promise<DownloadEntry[]> => downloads().listDownloads()
export const enqueueDownloads = (tracks: LibTrack[]): Promise<void> => downloads().enqueueDownloads(tracks)
export const cancelDownloads = (): Promise<void> => downloads().cancelDownloads()
export const removeDownloads = (ids: number[]): Promise<void> => downloads().removeDownloads(ids)
export const pendingDownloads = (): Promise<LibTrack[]> => downloads().pendingDownloads()
export const resumeDownloads = (): Promise<void> => downloads().resumeDownloads()
