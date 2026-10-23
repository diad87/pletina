// Checks CDN metadata availability only. This never calls play(), mints a token,
// fetches media through a proxy, or claims that the complete audio was decoded.
export type P1ProbeErrorCode = 'network' | 'timeout' | 'response'
export class P1ProbeError extends Error {
  constructor(readonly code: P1ProbeErrorCode) {
    super(code === 'timeout' ? 'La dirección de audio no estuvo disponible a tiempo.'
      : code === 'response' ? 'La dirección de audio no confirmó los metadatos esperados.'
      : 'No se pudo comprobar la dirección de audio de YouTube.')
    this.name = 'P1ProbeError'
  }
}

const MESSAGE = 'pletina-youtube-p1-metadata'
const DEADLINE = 8000
let sequence = 0
const cancelled = (signal?: AbortSignal): Error => signal?.reason instanceof Error
  ? signal.reason : new DOMException('Operación cancelada.', 'AbortError')
const validDuration = (duration: unknown): duration is number => typeof duration === 'number' && Number.isFinite(duration) && duration > 0 && duration <= 604800

function validatedUrl(value: string): URL {
  try {
    if (typeof value !== 'string' || value.length > 16384 || value !== value.trim() || /[\u0000-\u0020\u007f]/.test(value)) throw 0
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.port || value.includes('#') ||
      !(url.hostname === 'googlevideo.com' || url.hostname.endsWith('.googlevideo.com')) || url.pathname !== '/videoplayback') throw 0
    const critical = new Set(['expire', 'itag', 'clen', 'mime', 'dur', 'n', 'sig', 'signature', 'lsig'])
    for (const [key, part] of url.searchParams) {
      if (key.length > 128 || part.length > 8192 || /[\u0000-\u001f\u007f]/.test(key + part) ||
        critical.has(key) && (url.searchParams.getAll(key).length !== 1 || !part)) throw 0
    }
    const expire = url.searchParams.get('expire')
    if (!expire || !/^\d{1,12}$/.test(expire) || Number(expire) * 1000 <= Date.now() + DEADLINE) throw 0
    if (url.searchParams.has('sig') && url.searchParams.has('signature')) throw 0
    for (const name of ['itag', 'clen']) {
      const part = url.searchParams.get(name)
      if (part !== null && (!/^\d{1,10}$/.test(part) || Number(part) <= 0 || Number(part) > 2 * 1024 ** 3)) throw 0
    }
    const mime = url.searchParams.get('mime')
    if (mime !== null && mime !== 'audio/mp4') throw 0
    const duration = url.searchParams.get('dur')
    if (duration !== null && (!/^\d{1,6}(?:\.\d{1,6})?$/.test(duration) || Number(duration) <= 0 || Number(duration) > 604800)) throw 0
    for (const name of ['n', 'sig', 'signature', 'lsig']) {
      const part = url.searchParams.get(name)
      if (part !== null && (part.length > 4096 || !/^[A-Za-z0-9_.~-]+={0,2}$/.test(part))) throw 0
    }
    return url
  } catch { throw new P1ProbeError('response') }
}

// Self-contained because this application-owned code runs in srcdoc, with no
// provider script, application origin, storage or MediaSession access.
async function metadataBridge(config: { requestId: number; message: string; url: string; expectedDuration: number | null }) {
  const offsets = [0, 500, 1500, 3500, 6000]
  const began = performance.now()
  let finished = false
  let active: HTMLAudioElement | null = null
  let cancelAttempt = () => {}
  let cancelWait = () => {}
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const timer = (fn: () => void, ms: number) => {
    const id = setTimeout(() => { timers.delete(id); fn() }, ms)
    timers.add(id)
    return id
  }
  const clear = (id: ReturnType<typeof setTimeout>) => { clearTimeout(id); timers.delete(id) }
  const finish = (result: { duration: number } | { error: 'network' | 'timeout' | 'response' | 'cancelled' }) => {
    if (finished) return
    finished = true
    cancelAttempt()
    cancelWait()
    for (const id of timers) clearTimeout(id)
    timers.clear()
    window.removeEventListener('message', receive)
    parent.postMessage({ type: config.message, requestId: config.requestId, ...result }, '*')
  }
  const receive = (event: MessageEvent) => {
    if (event.source === parent && event.data?.type === config.message && event.data?.requestId === config.requestId && event.data?.cancel === true) {
      finish({ error: 'cancelled' })
    }
  }
  window.addEventListener('message', receive)
  timer(() => finish({ error: 'timeout' }), 8000)
  const wait = (ms: number) => new Promise<void>(resolve => {
    const id = timer(() => { cancelWait = () => {}; resolve() }, ms)
    cancelWait = () => { clear(id); cancelWait = () => {}; resolve() }
  })
  const attempt = () => new Promise<{ duration: number } | { error: 'network' | 'timeout' | 'response' | 'cancelled' }>(resolve => {
    const audio = new Audio()
    active = audio
    let settled = false
    const cleanup = () => {
      audio.removeEventListener('loadedmetadata', loaded)
      audio.removeEventListener('error', failed)
      clear(timeout)
      // Unload before reporting the result: the actual player starts afterwards.
      try { audio.pause() } catch { /* Best effort during a detached document. */ }
      try { audio.removeAttribute('src'); audio.load() } catch { /* Frame removal is the final teardown. */ }
      if (active === audio) active = null
      cancelAttempt = () => {}
    }
    const settle = (result: { duration: number } | { error: 'network' | 'timeout' | 'response' | 'cancelled' }) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }
    const loaded = () => {
      const duration = audio.duration, expected = config.expectedDuration
      const tolerance = expected === null ? 0 : Math.min(3, Math.max(1, expected * 0.015))
      settle(Number.isFinite(duration) && duration > 0 && duration <= 604800 &&
        (expected === null || Math.abs(duration - expected) <= tolerance) ? { duration } : { error: 'response' })
    }
    const failed = () => settle({ error: 'network' })
    const timeout = timer(() => settle({ error: 'timeout' }), 1500)
    cancelAttempt = () => settle({ error: 'cancelled' })
    audio.autoplay = false
    audio.defaultMuted = true
    audio.muted = true
    audio.volume = 0
    audio.preload = 'metadata'
    audio.addEventListener('loadedmetadata', loaded)
    audio.addEventListener('error', failed)
    // Deliberately no crossOrigin attribute: CORS-unreadable CDN metadata can
    // still be checked by HTMLMediaElement. Browser-managed CDN requests remain
    // subject to the browser's normal policy; no cookies/headers are supplied.
    try { audio.src = config.url; audio.load() }
    catch { settle({ error: 'network' }) }
  })
  let last: 'network' | 'timeout' = 'network'
  try {
    for (const offset of offsets) {
      if (finished) return
      const elapsed = performance.now() - began
      if (elapsed >= 8000) { finish({ error: 'timeout' }); return }
      if (offset > 0 && elapsed > offset + 50) continue
      if (offset > elapsed) await wait(offset - elapsed)
      if (finished) return
      // A suspended renderer must not replay expired slots as a burst.
      if (offset > 0 && performance.now() - began > offset + 50) continue
      if (performance.now() - began >= 8000) { finish({ error: 'timeout' }); return }
      const result = await attempt()
      if (finished) return
      if ('duration' in result) { finish(result); return }
      if (result.error === 'response') { finish(result); return }
      if (result.error === 'cancelled') return
      last = result.error
    }
    finish({ error: last })
  } catch { finish({ error: 'network' }) }
}

/** Metadata availability, not audible or complete-file validation. No URL is persisted. */
export async function probeP1Audio(value: string, expectedDuration: number | null, signal?: AbortSignal): Promise<{ duration: number }> {
  if (signal?.aborted) throw cancelled(signal)
  const url = validatedUrl(value)
  if (expectedDuration !== null && !validDuration(expectedDuration)) throw new P1ProbeError('response')
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe')
    frame.hidden = true
    frame.setAttribute('aria-hidden', 'true')
    frame.setAttribute('allow', "autoplay 'none'")
    frame.sandbox = 'allow-scripts'
    frame.referrerPolicy = 'no-referrer'
    const requestId = ++sequence
    let finished = false
    let stopping: Error | null = null
    let cancelTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (error: Error | null, result?: { duration: number }) => {
      if (finished) return
      finished = true
      clearTimeout(deadline)
      clearTimeout(cancelTimer)
      window.removeEventListener('message', receive)
      signal?.removeEventListener('abort', abort)
      // Destroying this opaque browsing context also destroys unplayed media if
      // its renderer cannot acknowledge cancellation before the parent deadline.
      frame.remove()
      error ? reject(error) : resolve(result!)
    }
    const abort = () => {
      if (finished) return
      stopping = cancelled(signal)
      // The bridge unloads its element before acknowledging. A frozen or not-yet
      // loaded bridge is destroyed after a short bounded cancellation grace.
      try { frame.contentWindow?.postMessage({ type: MESSAGE, requestId, cancel: true }, '*') } catch { /* Removed below. */ }
      if (!finished) cancelTimer = setTimeout(() => finish(stopping), 32)
    }
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.origin !== 'null' || event.data?.type !== MESSAGE || event.data?.requestId !== requestId) return
      if (stopping) { finish(stopping); return }
      const data = event.data
      if (Object.hasOwn(data, 'duration') === Object.hasOwn(data, 'error')) { finish(new P1ProbeError('response')); return }
      if (validDuration(data.duration) && !Object.hasOwn(data, 'error')) {
        const tolerance = expectedDuration === null ? 0 : Math.min(3, Math.max(1, expectedDuration * 0.015))
        if (expectedDuration !== null && Math.abs(data.duration - expectedDuration) > tolerance) finish(new P1ProbeError('response'))
        else finish(null, { duration: data.duration })
      } else finish(new P1ProbeError(data.error === 'network' || data.error === 'timeout' ? data.error : 'response'))
    }
    const deadline = setTimeout(() => finish(stopping ?? new P1ProbeError('timeout')), DEADLINE)
    window.addEventListener('message', receive)
    signal?.addEventListener('abort', abort, { once: true })
    const args = JSON.stringify({ requestId, message: MESSAGE, url: url.href, expectedDuration }).replaceAll('<', '\\u003c')
    frame.srcdoc = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; media-src ' + url.origin + '; connect-src \'none\'; base-uri \'none\'; form-action \'none\'">' +
      '<script>(' + metadataBridge.toString() + ')(' + args + ')<' + '/script>'
    try { (document.body || document.documentElement).append(frame) }
    catch { finish(stopping ?? new P1ProbeError('network')) }
    // Covers cancellation triggered synchronously by a DOM hook while mounting.
    if (signal?.aborted && !finished) abort()
  })
}
