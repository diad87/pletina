// El backend entrega lotes limitados de audio verificado al MediaSource de la app.
import { invoke } from '@tauri-apps/api/core'

export const CAPTURE = 'musify-capture:'

interface TimelineSettings {
  timestampOffset: number
  appendWindowStart: number
  appendWindowEnd: number | null
  mode: 'segments'
}

interface Frame {
  mime: string
  mimes: string[]
  duration: number | null
  done: boolean
  error: string | null
  revision: number
  generation: number
  reset: boolean
  from: number
  next: number
  timelineSettings: TimelineSettings | null
  chunks: Uint8Array[]
}

const cancelled = () => new DOMException('Captura cancelada', 'AbortError')
const check = (signal: AbortSignal) => {
  if (signal.aborted) throw cancelled()
}

function timelineSettings(value: unknown): TimelineSettings {
  // Compatibilidad con las primeras capturas del protocolo 2, que usaban estos valores.
  if (value === undefined) return { timestampOffset: 0, appendWindowStart: 0, appendWindowEnd: null, mode: 'segments' }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Ajustes temporales de captura inválidos')
  const t = value as TimelineSettings
  if (!Number.isFinite(t.timestampOffset) || !Number.isFinite(t.appendWindowStart) || t.appendWindowStart < 0 ||
      (t.appendWindowEnd !== null && (!Number.isFinite(t.appendWindowEnd) || t.appendWindowEnd <= t.appendWindowStart)) ||
      t.mode !== 'segments') throw new Error('Ajustes temporales de captura inválidos')
  return { timestampOffset: t.timestampOffset, appendWindowStart: t.appendWindowStart, appendWindowEnd: t.appendWindowEnd, mode: t.mode }
}

function sameTimeline(a: TimelineSettings, b: TimelineSettings) {
  return a.timestampOffset === b.timestampOffset && a.appendWindowStart === b.appendWindowStart &&
    a.appendWindowEnd === b.appendWindowEnd && a.mode === b.mode
}

function applyTimeline(sb: SourceBuffer, t: TimelineSettings) {
  sb.mode = t.mode
  sb.timestampOffset = t.timestampOffset
  sb.appendWindowStart = t.appendWindowStart
  sb.appendWindowEnd = t.appendWindowEnd ?? Infinity
}

/** Dejar de esperar también suelta los listeners, aunque el IPC termine más tarde. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(cancelled())
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(cancelled()) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

async function read(videoId: string, from: number, revision: number | undefined, signal: AbortSignal): Promise<Frame> {
  const buf = await abortable(invoke<ArrayBuffer>('capture_read', { videoId, from, revision }), signal)
  if (buf.byteLength < 4) throw new Error('Cabecera de captura incompleta')
  const view = new DataView(buf)
  const size = view.getUint32(0, true)
  if (size > buf.byteLength - 4) throw new Error('Cabecera de captura inválida')
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, size)))
  const chunks: Uint8Array[] = []
  for (let at = 4 + size; at < buf.byteLength; ) {
    if (at + 4 > buf.byteLength) throw new Error('Tamaño de audio incompleto')
    const n = view.getUint32(at, true)
    if (n > buf.byteLength - at - 4) throw new Error('Trozo de audio incompleto')
    chunks.push(new Uint8Array(buf, at + 4, n))
    at += 4 + n
  }
  if (!Number.isSafeInteger(head.next) || head.next < 0 || !Array.isArray(head.mimes))
    throw new Error('Cursor de captura inválido')
  const settings = head.timelineSettings === null && !head.mime && !chunks.length
    ? null : timelineSettings(head.timelineSettings)
  return { ...head, timelineSettings: settings, chunks }
}

/** updateend llega también después de error: se escucha el error por separado. */
function idle(sb: SourceBuffer, signal: AbortSignal): Promise<void> {
  check(signal)
  if (!sb.updating) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      sb.removeEventListener('updateend', done)
      sb.removeEventListener('error', error)
      sb.removeEventListener('abort', abort)
      signal.removeEventListener('abort', abort)
    }
    const done = () => { cleanup(); resolve() }
    const error = () => { cleanup(); reject(new Error('El navegador rechazó el audio capturado')) }
    const abort = () => { cleanup(); reject(cancelled()) }
    sb.addEventListener('updateend', done, { once: true })
    sb.addEventListener('error', error, { once: true })
    sb.addEventListener('abort', abort, { once: true })
    signal.addEventListener('abort', abort, { once: true })
  })
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    check(signal)
    const abort = () => { clearTimeout(timer); reject(cancelled()) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}

async function append(sb: SourceBuffer, audio: HTMLAudioElement, chunk: Uint8Array, signal: AbortSignal) {
  for (;;) {
    await idle(sb, signal)
    check(signal)
    try {
      sb.appendBuffer(chunk as Uint8Array<ArrayBuffer>)
      // No pedir el siguiente lote hasta que el navegador haya consumido éste.
      await idle(sb, signal)
      return
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'QuotaExceededError')) throw e
      const keep = audio.currentTime - 20
      if (keep > 0) {
        sb.remove(0, keep)
        await idle(sb, signal)
      }
      await delay(1000, signal)
    }
  }
}

const coveredUntil = (sb: SourceBuffer, at: number) => {
  for (let i = 0; i < sb.buffered.length; i++)
    if (sb.buffered.start(i) <= at + 0.5 && at < sb.buffered.end(i)) return sb.buffered.end(i)
  return at
}

/** Mantiene el lector disponible después de EOS para volver a cargar un hueco al saltar. */
export function playCapture(audio: HTMLAudioElement, videoId: string): (cancelBackend?: boolean) => void {
  const lifetime = new AbortController()
  let source: AbortController | null = null
  let ms: MediaSource
  let objectUrl = ''
  let sb: SourceBuffer | null = null
  let generation: number | undefined
  let revision: number | undefined
  let timeline: TimelineSettings | null = null
  let from = 0
  let mime = ''
  let duration = 0
  // Una revisión nueva puede ser sólo el replay de la misma caché incompleta.
  let resumedAt = -1
  let failed = false
  let wakeVersion = 0
  let wakeReader: (() => void) | null = null
  let seekRequest = 0
  let seeking = Promise.resolve()

  const wake = () => { wakeVersion++; wakeReader?.(); wakeReader = null }
  const waitForSeek = (version: number, signal: AbortSignal) => {
    if (wakeVersion !== version) return Promise.resolve()
    return abortable(new Promise<void>((resolve) => { wakeReader = resolve }), signal)
  }
  const fail = (error: unknown) => {
    if (lifetime.signal.aborted || failed) return
    failed = true
    console.warn('[captura]', videoId, String(error))
    audio.dispatchEvent(new CustomEvent('captureerror', { detail: String(error) }))
    const signal = source?.signal
    if (signal && !signal.aborted) {
      void (async () => {
        try {
          if (sb) await idle(sb, signal)
          if (!signal.aborted && ms.readyState === 'open') ms.endOfStream('network')
        } catch { /* La fuente ya fue retirada al cambiar de canción. */ }
      })()
    }
  }
  const requestSeek = (at: number) => {
    const request = ++seekRequest
    seeking = seeking.then(async () => {
      if (request !== seekRequest || lifetime.signal.aborted) return
      await abortable(invoke('capture_seek', { videoId, at: Math.max(0, at - 1) }), lifetime.signal)
      check(lifetime.signal)
      wake()
    }).catch((e) => { if (!lifetime.signal.aborted) fail(e) })
    return seeking
  }
  const onSeeking = () => {
    if (sb && coveredUntil(sb, audio.currentTime) <= audio.currentTime) void requestSeek(audio.currentTime)
  }
  audio.addEventListener('seeking', onSeeking)

  const attach = (resume?: { at: number; playing: boolean }) => {
    source?.abort()
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    source = new AbortController()
    const signal = source.signal
    ms = new MediaSource()
    const current = ms
    const url = URL.createObjectURL(current)
    objectUrl = url
    sb = null
    mime = ''
    duration = 0
    current.addEventListener('sourceclose', () => source?.signal === signal && source.abort(), { once: true })
    current.addEventListener('sourceopen', async () => {
      URL.revokeObjectURL(url)
      if (signal.aborted || lifetime.signal.aborted) return
      try {
        while (!failed) {
          check(signal)
          const f = await read(videoId, from, revision, signal)
          check(signal)
          if (f.error) throw new Error(f.error)
          if (generation !== f.generation) resumedAt = -1
          generation = f.generation
          const hasAudio = !!f.mime || f.chunks.length > 0
          if (revision !== undefined && f.revision !== revision) {
            // No mezclar segmentos de dos capturas cuando se reemplaza la caché.
            revision = f.revision
            timeline = hasAudio ? f.timelineSettings : null
            from = f.from ?? 0
            attach({ at: audio.currentTime, playing: !audio.paused })
            return
          }
          revision = f.revision
          // Antes de la prueba de fuente puede haber cabeceras de espera sin formato ni audio.
          if (timeline && !f.timelineSettings)
            throw new Error('Desaparecieron los ajustes temporales dentro de la misma revisión de captura')
          if (hasAudio) {
            if (!f.timelineSettings) throw new Error('Captura con audio pero sin ajustes temporales')
            if (timeline && !sameTimeline(timeline, f.timelineSettings))
              throw new Error('Los ajustes temporales cambiaron dentro de la misma revisión de captura')
            timeline = f.timelineSettings
          }
          if (!sb && f.mime) {
            if (!timeline) throw new Error('Captura con formato pero sin ajustes temporales')
            mime = f.mimes[0] || f.mime
            if (!MediaSource.isTypeSupported(mime)) throw new Error(`Formato de captura no compatible: ${mime}`)
            sb = current.addSourceBuffer(mime)
            applyTimeline(sb, timeline)
          }
          if (sb && f.duration && f.duration > duration) {
            await idle(sb, signal)
            duration = f.duration
            if (current.readyState === 'open') {
              const bufferedEnd = sb.buffered.length ? sb.buffered.end(sb.buffered.length - 1) : 0
              current.duration = Math.max(duration, bufferedEnd)
            }
          }
          for (const [i, chunk] of f.chunks.entries()) {
            check(signal)
            if (!sb || !timeline) throw new Error('Captura con audio pero sin formato o ajustes temporales')
            const nextMime = f.mimes[i]
            if (nextMime && nextMime !== mime) {
              await idle(sb, signal)
              sb.changeType(nextMime)
              applyTimeline(sb, timeline)
              mime = nextMime
            }
            await append(sb, audio, chunk, signal)
          }
          from = f.next
          if (resume && sb && f.chunks.length) {
            audio.currentTime = resume.at
            if (resume.playing) void audio.play().catch(fail)
            resume = undefined
          }
          if (f.done && !f.chunks.length) {
            if (!sb) throw new Error('La captura terminó sin audio')
            await idle(sb, signal)
            const until = coveredUntil(sb, audio.currentTime)
            if (duration && until < duration - 1.5) {
              if (until <= resumedAt + 1e-6) throw new Error(`Captura incompleta desde ${until.toFixed(1)} s`)
              resumedAt = until
              await requestSeek(until)
              continue
            }
            const version = wakeVersion
            if (current.readyState === 'open') current.endOfStream()
            await waitForSeek(version, signal)
          } else if (!f.chunks.length) {
            await delay(40, signal)
          }
        }
      } catch (e) {
        if (!signal.aborted && !lifetime.signal.aborted) fail(e)
      }
    }, { once: true })
    audio.src = url
  }

  attach()
  return (cancelBackend = true) => {
    if (lifetime.signal.aborted) return
    lifetime.abort()
    source?.abort()
    wake()
    audio.removeEventListener('seeking', onSeeking)
    URL.revokeObjectURL(objectUrl)
    if (cancelBackend && generation !== undefined) void invoke('capture_cancel', { videoId, generation }).catch(() => {})
  }
}

let stopCurrent: ((cancelBackend?: boolean) => void) | null = null

export function stopCapture(cancelBackend = true) {
  stopCurrent?.(cancelBackend)
  stopCurrent = null
}

export function setAudioSource(audio: HTMLAudioElement, src: string) {
  stopCapture()
  if (src.startsWith(CAPTURE)) stopCurrent = playCapture(audio, src.slice(CAPTURE.length))
  else audio.src = src
}
