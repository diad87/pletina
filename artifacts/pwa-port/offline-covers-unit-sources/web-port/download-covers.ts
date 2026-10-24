import coverRouting from '../pwa/cover-routing.mjs'

export const MAX_COVER_CACHE_BYTES = 64 * 1024 ** 2
export const MAX_COVER_CACHE_ENTRIES = 256
const COVER_TIMEOUT = 10000
const BACKFILL_LIMIT = 32

type CoverReference = { track: { cover: string | null } }
interface Options {
  scope: URL
  list: () => Promise<readonly CoverReference[]>
  caches?: CacheStorage
  fetch?: typeof fetch
  online?: () => boolean
  validate?: (response: Response, signal: AbortSignal) => Promise<void>
  timeout?: number
}
export interface DownloadCovers {
  save(cover: string | null): Promise<void>
  prune(): Promise<void>
  backfill(): void
  idle(): Promise<void>
}
const aborted = () => new DOMException('La comprobación de la carátula terminó.', 'AbortError')
const check = (signal: AbortSignal) => { if (signal.aborted) throw signal.reason ?? aborted() }
function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? aborted())
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => {
      signal.removeEventListener('abort', abort); reject(error)
    })
  })
}

/** La cabecera acotada no basta: el navegador debe poder decodificar la imagen. */
export async function validateCoverImage(response: Response, signal: AbortSignal): Promise<void> {
  check(signal)
  const blob = await wait(response.blob(), signal)
  check(signal)
  const image = new Image(), url = URL.createObjectURL(blob)
  try {
    const loaded = typeof image.decode === 'function' ? null : new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('La carátula no se puede decodificar.'))
    })
    image.src = url
    await wait(loaded ?? image.decode(), signal)
    check(signal)
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth > 4096 || image.naturalHeight > 4096 ||
      image.naturalWidth * image.naturalHeight > 16 * 1024 ** 2) throw new Error('La carátula supera el tamaño permitido.')
  } finally {
    image.onload = image.onerror = null
    image.src = ''
    URL.revokeObjectURL(url)
  }
}

/** Sólo portadas públicas legibles; sus fallos nunca invalidan el audio guardado. */
export function createDownloadCovers(options: Options): DownloadCovers {
  const routing = coverRouting(options.scope), cacheStorage = options.caches ?? globalThis.caches
  const request = options.fetch ?? globalThis.fetch, online = options.online ?? (() => globalThis.navigator?.onLine !== false)
  const validate = options.validate ?? validateCoverImage
  type Job = { work: (signal: AbortSignal) => Promise<void>; controller: AbortController; finish: () => void; timer: ReturnType<typeof setTimeout>; background: boolean }
  const jobs: Job[] = [], saving = new Map<string, Promise<void>>()
  let running: Promise<void> | null = null, backfilling = false

  async function references(signal: AbortSignal): Promise<Map<string, string>> {
    const result = new Map<string, string>()
    for (const row of await wait(options.list(), signal)) {
      const cover = routing.normalize(row.track.cover), key = cover && routing.key(cover)
      if (cover && key && !result.has(key)) result.set(key, cover)
    }
    check(signal)
    return result
  }
  async function sweep(signal: AbortSignal): Promise<void> {
    const referenced = await references(signal), cache = await wait(cacheStorage.open(routing.cacheName), signal)
    const retained: { key: Request; bytes: number }[] = []
    let total = 0
    for (const key of await wait(cache.keys(), signal)) {
      check(signal)
      const response = await wait(cache.match(key), signal)
      // Only this writer creates entries, with measured Content-Length from
      // readRaster. Unknown/malformed entries are never retained as cover data.
      const raw = response?.headers.get('content-length') ?? '', bytes = Number(raw)
      if (key.method !== 'GET' || !referenced.has(key.url) || !/^\d+$/.test(raw) || !Number.isSafeInteger(bytes) ||
        bytes <= 0 || bytes > routing.limits.maxBytes || response?.type === 'opaque') {
        await wait(cache.delete(key), signal)
        continue
      }
      retained.push({ key, bytes }); total += bytes
    }
    // Cache.keys preserves insertion order: FIFO remains independent of visits.
    while (retained.length > MAX_COVER_CACHE_ENTRIES || total > MAX_COVER_CACHE_BYTES) {
      const oldest = retained.shift()!
      await wait(cache.delete(oldest.key), signal)
      total -= oldest.bytes
    }
  }
  function launch() {
    if (running || !jobs.length) return
    running = (async () => {
      while (jobs.length) {
        const job = jobs.shift()!
        try { check(job.controller.signal); await job.work(job.controller.signal) }
        catch { /* Una portada nunca detiene ni suspende la cola de audio. */ }
        finally { clearTimeout(job.timer); job.finish() }
      }
    })().finally(() => { running = null; if (jobs.length) launch() })
  }
  function enqueue(work: Job['work'], background = false): Promise<void> {
    const controller = new AbortController()
    let finish!: () => void
    const completed = new Promise<void>(resolve => { finish = resolve })
    const timer = setTimeout(() => controller.abort(aborted()), options.timeout ?? COVER_TIMEOUT)
    const job = { work, controller, finish, timer, background }
    const firstBackground = jobs.findIndex(value => value.background)
    if (!background && firstBackground >= 0) jobs.splice(firstBackground, 0, job)
    else jobs.push(job)
    launch()
    return wait(completed, controller.signal).catch(() => {})
  }
  function save(cover: string | null, background = false): Promise<void> {
    const normalized = routing.normalize(cover), key = normalized && routing.key(normalized)
    if (!normalized || !key || !online()) return Promise.resolve()
    const previous = saving.get(key)
    if (previous) return previous
    const pending = enqueue(async signal => {
      if (!online() || !(await references(signal)).has(key)) return
      const cache = await wait(cacheStorage.open(routing.cacheName), signal)
      if (await wait(cache.match(key), signal)) { await sweep(signal); return }
      for (const candidate of routing.candidates(normalized)) {
        check(signal)
        if (!online() || routing.key(candidate) !== key) continue
        try {
          const response = await wait(request(candidate, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', signal }), signal)
          const image = await wait(routing.readRaster(response, signal), signal)
          if (!image) continue
          await wait(validate(image.clone(), signal), signal)
          if (!(await references(signal)).has(key)) return
          check(signal)
          const writing = cache.put(key, image)
          // A slow local cache write can finish after removal or the time limit.
          // Its eventual cleanup rereads current references, preserving sharing.
          void writing.then(() => { if (signal.aborted) void prune() }).catch(() => {})
          await wait(writing, signal)
          await sweep(signal)
          return
        } catch { check(signal) }
      }
    }, background)
    saving.set(key, pending)
    void pending.finally(() => { if (saving.get(key) === pending) saving.delete(key) })
    return pending
  }
  function prune(): Promise<void> { return enqueue(sweep) }
  function backfill() {
    if (backfilling) return
    backfilling = true
    void enqueue(async signal => {
      const referenced = await references(signal), cache = await wait(cacheStorage.open(routing.cacheName), signal)
      let added = 0
      for (const [key, cover] of referenced) {
        if (added >= BACKFILL_LIMIT || !online()) break
        if (!await wait(cache.match(key), signal)) { void save(cover, true); added++ }
      }
      await sweep(signal)
    }, true).finally(() => { backfilling = false })
  }
  return { save, prune, backfill, async idle() { while (running || jobs.length) { if (running) await running; else launch() } } }
}
