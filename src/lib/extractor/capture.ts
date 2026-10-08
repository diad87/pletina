// API 4: unidades confirmadas e inventario de muestras; los saltos conservan los buffers.
import { invoke } from '@tauri-apps/api/core'
import { playLegacyCapture, CAPTURE as LEGACY_CAPTURE } from './capture-legacy'

export const CAPTURE = 'musify-capture:'
export { LEGACY_CAPTURE }
interface TimelineSettings {
  timestampOffset: number
  appendWindowStart: number
  appendWindowEnd: number | null
  mode: 'segments'
}
interface Range { start: number; end: number }
interface Unit {
  index: number; generation: number
  epoch: number; source: number; s: number; unit: number
  initKey: string; initBytes: number; mime: string
  rangeStart: number; rangeEnd: number; decodeStart: number; decodeEnd: number
  frames: number; firstFrame: number; endFrame: number; verified: boolean; timelineSettings: TimelineSettings
}
interface Frame {
  api: number; duration: number | null; audioDuration?: number | null; complete: boolean; recovering: boolean
  error: string | null; softError: string | null
  revision: number; generation: number; from: number; next: number
  ranges: Range[]; units: Unit[]; chunks: Uint8Array[]
}
interface ReaderDiagnostics {
  /** All timestamps use this WebView's performance clock, never the producer clock. */
  startedAtMs: number; elapsedMs: number; phaseSinceMs: number
  phase: 'opening' | 'read' | 'append' | 'empty-poll' | 'eof' | 'failed' | 'stopped'
  reads: number; emptyReads: number; appends: number
  /** Includes the native long-poll wait; this is not IPC overhead alone. */
  lastReadMs: number | null; maxReadMs: number
  lastAppendMs: number | null; maxAppendMs: number; lastAppendAtMs: number | null
  emptyPolls: number; emptyPollDelayMs: number; maxEmptyPollElapsedMs: number
}
/** Publicado después de updateend: recibir bytes todavía no prueba que MSE los acepte. */
export interface CaptureProgress {
  api: number
  generation: number; revision: number; ranges: Range[]; buffered: Range[]
  duration: number | null; audioDuration: number | null
  complete: boolean; recovering: boolean; softError: string | null
  units: number; firstAppendMs: number | null
  startupReserveSeconds: number; readyMs: number | null
  reader: ReaderDiagnostics
}
type Stop = (cancelBackend?: boolean) => void
const readers = new WeakMap<HTMLAudioElement, { stop: Stop; seek: (at: number) => Promise<boolean>; ready: () => boolean; waitReady: () => Promise<void>; progress: () => CaptureProgress | null }>()
// Native ordering survives replacement of one reader by another for the same ledger.
let lastSeekRequestId = 0
const nextSeekRequestId = () => (lastSeekRequestId = Math.max(lastSeekRequestId + 1, Date.now() * 1000))
const cancelled = () => new DOMException('Captura cancelada', 'AbortError')
const check = (signal: AbortSignal) => { if (signal.aborted) throw cancelled() }
const integer = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
// Sólo error de coma flotante; no se cubre un frame ausente con tolerancia de reproducción.
const EPSILON = 0.000001
// A half-second of accepted audio leaves room for delivery jitter and the final
// held-back batch at native EOF. Empty native reads use a fixed 40 ms retry delay.
const STARTUP_RESERVE_SECONDS = 0.5
const EMPTY_POLL_MS = 40

function settings(value: unknown): TimelineSettings {
  if (!value || typeof value !== 'object') throw new Error('Ajustes temporales de captura inválidos')
  const t = value as TimelineSettings
  if (!finite(t.timestampOffset) || !finite(t.appendWindowStart) || t.appendWindowStart < 0 ||
      (t.appendWindowEnd !== null && (!finite(t.appendWindowEnd) || t.appendWindowEnd <= t.appendWindowStart)) ||
      t.mode !== 'segments') throw new Error('Ajustes temporales de captura inválidos')
  return { timestampOffset: t.timestampOffset, appendWindowStart: t.appendWindowStart, appendWindowEnd: t.appendWindowEnd, mode: t.mode }
}
const sameSettings = (a: TimelineSettings, b: TimelineSettings) => JSON.stringify(a) === JSON.stringify(b)
function applySettings(sb: SourceBuffer, t: TimelineSettings) {
  sb.mode = t.mode
  sb.timestampOffset = t.timestampOffset
  sb.appendWindowEnd = Infinity
  sb.appendWindowStart = t.appendWindowStart
  sb.appendWindowEnd = t.appendWindowEnd ?? Infinity
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(cancelled())
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(cancelled()) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
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
async function read(videoId: string, from: number, revision: number | undefined, signal: AbortSignal): Promise<Frame> {
  const buf = await abortable(invoke<ArrayBuffer>('capture_read', { videoId, from, revision }), signal)
  if (buf.byteLength < 4) throw new Error('Cabecera de captura incompleta')
  const view = new DataView(buf), size = view.getUint32(0, true)
  if (size > buf.byteLength - 4) throw new Error('Cabecera de captura inválida')
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, size)))
  const chunks: Uint8Array[] = []
  for (let at = 4 + size; at < buf.byteLength;) {
    if (at + 4 > buf.byteLength) throw new Error('Tamaño de audio incompleto')
    const n = view.getUint32(at, true)
    if (!n || n > buf.byteLength - at - 4) throw new Error('Unidad de audio incompleta')
    chunks.push(new Uint8Array(buf, at + 4, n)); at += 4 + n
  }
  if (head.api !== 4 || !integer(head.from) || !integer(head.next) || !integer(head.revision) || !integer(head.generation) ||
      !Array.isArray(head.units) || head.units.length !== chunks.length || head.next !== head.from + chunks.length ||
      typeof head.complete !== 'boolean' || !Array.isArray(head.ranges) ||
      (head.duration !== null && (!finite(head.duration) || head.duration <= 0)) ||
      (head.audioDuration != null && (!finite(head.audioDuration) || head.audioDuration <= 0))) throw new Error('Ledger de captura inválido')
  let end = -Infinity
  for (const r of head.ranges) {
    if (!finite(r.start) || !finite(r.end) || r.start < 0 || r.end <= r.start || r.start < end)
      throw new Error('Rangos de captura inválidos')
    end = r.end
  }
  for (const [i, u] of (head.units as Unit[]).entries()) {
    if (u.index !== head.from + i || !integer(u.generation) || !integer(u.epoch) || !integer(u.source) || !integer(u.s) || !integer(u.unit) ||
        typeof u.initKey !== 'string' || !u.initKey || !integer(u.initBytes) || !u.initBytes || u.initBytes >= chunks[i].length ||
        typeof u.mime !== 'string' || !u.mime || u.verified !== true || !integer(u.frames) || !u.frames ||
        !integer(u.firstFrame) || !integer(u.endFrame) || u.endFrame - u.firstFrame !== u.frames ||
        !finite(u.rangeStart) || !finite(u.rangeEnd) || u.rangeStart < 0 || u.rangeEnd <= u.rangeStart ||
        !finite(u.decodeStart) || !finite(u.decodeEnd) || u.decodeEnd <= u.decodeStart ||
        u.decodeStart > u.rangeStart + EPSILON || u.decodeEnd < u.rangeEnd - EPSILON)
      throw new Error('Metadatos de unidad de captura inválidos')
    u.timelineSettings = settings(u.timelineSettings)
  }
  return { ...head, chunks }
}
function idle(sb: SourceBuffer, signal: AbortSignal): Promise<void> {
  check(signal)
  if (!sb.updating) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      sb.removeEventListener('updateend', done); sb.removeEventListener('error', error)
      sb.removeEventListener('abort', abort); signal.removeEventListener('abort', abort)
    }
    const done = () => { cleanup(); resolve() }
    const error = () => { cleanup(); reject(new Error('El navegador rechazó el audio capturado')) }
    const abort = () => { cleanup(); reject(cancelled()) }
    sb.addEventListener('updateend', done, { once: true }); sb.addEventListener('error', error, { once: true })
    sb.addEventListener('abort', abort, { once: true }); signal.addEventListener('abort', abort, { once: true })
  })
}
const rangesOf = (ranges: TimeRanges): Range[] => Array.from({ length: ranges.length }, (_, i) => ({ start: ranges.start(i), end: ranges.end(i) }))
const covers = (ranges: Range[], start: number, end = start + EPSILON) => ranges.some(r => r.start <= start + EPSILON && r.end >= end - EPSILON && r.end > start)
const firstGap = (ranges: Range[], duration: number, start = 0) => {
  let end = start
  for (const r of ranges) { if (r.start > end + EPSILON) return end; end = Math.max(end, r.end) }
  return end < duration - EPSILON ? end : null
}
async function append(sb: SourceBuffer, audio: HTMLAudioElement, chunk: Uint8Array, signal: AbortSignal) {
  for (let attempts = 0; ; attempts++) {
    await idle(sb, signal); check(signal)
    try { sb.appendBuffer(chunk as Uint8Array<ArrayBuffer>); await idle(sb, signal); return }
    catch (e) {
      if (!(e instanceof DOMException && e.name === 'QuotaExceededError') || attempts >= 2) throw e
      const keep = audio.currentTime - 20
      if (keep <= 0) throw e
      sb.remove(0, keep); await idle(sb, signal)
    }
  }
}

export function playCapture(audio: HTMLAudioElement, videoId: string): Stop {
  readers.get(audio)?.stop(false)
  const lifetime = new AbortController(), signal = lifetime.signal, started = performance.now()
  const ms = new MediaSource(), url = URL.createObjectURL(ms)
  let sb: SourceBuffer | null = null, generation: number | undefined, revision: number | undefined, from = 0
  let installed: { initKey: string; mime: string; context: string } | null = null
  let progress: CaptureProgress | null = null, totalUnits = 0, firstAppendMs: number | null = null, readyMs: number | null = null
  let failure: unknown = null
  let requestId = 0, cursorVersion = 0, failed = false, stopped = false, notice = '', eof = false
  let cachedIntent: { at: number; revision: number; generation: number; requestId: number; stale: boolean; retries: number } | null = null
  const metadata = new Map<string, string>(), contexts = new Map<string, TimelineSettings>()
  const frameEnds = new Map<string, number>()
  const initializations = new Map<string, Uint8Array>()
  let recoveryKey = '', recoveryCount = 0
  const diagnostics: ReaderDiagnostics = { startedAtMs: started, elapsedMs: 0, phaseSinceMs: 0, phase: 'opening',
    reads: 0, emptyReads: 0, appends: 0, lastReadMs: null, maxReadMs: 0,
    lastAppendMs: null, maxAppendMs: 0, lastAppendAtMs: null,
    emptyPolls: 0, emptyPollDelayMs: EMPTY_POLL_MS, maxEmptyPollElapsedMs: 0 }
  const phase = (value: ReaderDiagnostics['phase']) => { diagnostics.phase = value; diagnostics.phaseSinceMs = performance.now() - started }
  const readerSnapshot = (): ReaderDiagnostics => ({ ...diagnostics, elapsedMs: performance.now() - started })
  // A waiting event can sample an IPC or append still pending, without inventing new accepted ranges.
  const progressSnapshot = () => progress ? { ...progress, reader: readerSnapshot() } : null
  const buffered = () => sb ? rangesOf(sb.buffered) : []
  const ready = () => {
    if (signal.aborted || !progress) return false
    const at = audio.currentTime, end = Math.min(at + STARTUP_RESERVE_SECONDS, progress.audioDuration ?? Infinity)
    // progress is published only after the entire read batch reaches updateend.
    return end > at && covers(progress.buffered, at, end) && covers(buffered(), at, end)
  }
  const seekReady = (at: number) => {
    if (signal.aborted || !progress) return false
    // Only a validated audio EOF can shorten the reserve; nominal duration cannot.
    const end = Math.min(at + STARTUP_RESERVE_SECONDS, progress.audioDuration ?? Infinity)
    return end > at && covers(progress.ranges, at, end) &&
      covers(progress.buffered, at, end) && covers(buffered(), at, end)
  }
  const waitReady = async () => {
    while (!ready()) {
      check(signal)
      if (failed) throw failure
      // Ads may precede the first accepted sample. Native leases/watchdogs and
      // the caller's operation deadline supervise that wait; reserve adds none.
      await delay(20, signal)
    }
  }
  const warning = (error: unknown) => {
    const message = String(error)
    if (message === notice || signal.aborted) return
    notice = message; audio.dispatchEvent(new CustomEvent('capturewarning', { detail: message }))
  }
  const fail = (error: unknown) => {
    if (signal.aborted || failed) return
    failed = true; failure = error; phase('failed')
    if (totalUnits) warning(error)
    else audio.dispatchEvent(new CustomEvent('captureerror', { detail: String(error) }))
  }
  const requestSeek = async (at: number, replayCached = true, onStale?: () => void) => {
    if (replayCached) cachedIntent = null
    const current = requestId = nextSeekRequestId()
    const reply = await abortable(invoke<{ requestId: number; generation: number; cached: boolean; stale?: boolean; from?: number }>('capture_seek', {
      videoId, at, generation, requestId: current,
    }), signal).catch(error => {
      if (signal.aborted || current !== requestId) return null
      throw error
    })
    if (signal.aborted || current !== requestId) return false
    if (!reply || reply.requestId !== current) return false
    if (reply.stale) { onStale?.(); return false }
    if (!integer(reply.generation)) return false
    // Un seek vigente puede reabrir una ventana cerrada conservando el mismo ledger.
    if (reply.generation !== generation) { generation = reply.generation; cursorVersion++ }
    if (reply.cached && replayCached) { from = reply.from ?? 0; cursorVersion++ }
    eof = false
    return true
  }
  const retryCachedIntent = () => {
    const intent = cachedIntent
    if (!intent || !intent.stale || intent.requestId !== requestId || intent.revision !== revision ||
        generation === intent.generation || progress?.generation !== generation || !seekReady(intent.at)) return
    intent.retries++
    notifyCachedIntent(intent)
  }
  const notifyCachedIntent = (intent: NonNullable<typeof cachedIntent>) => {
    intent.generation = generation!; intent.stale = false
    const pending = requestSeek(intent.at, false, () => {
      if (cachedIntent !== intent || intent.requestId !== requestId) return
      intent.stale = true
      if (intent.retries >= 1) {
        cachedIntent = null
        warning('No se pudo reorientar el productor tras el salto; se conserva el audio verificado')
      } else retryCachedIntent()
    })
    intent.requestId = requestId
    void pending.then(accepted => {
      if (accepted && cachedIntent === intent && intent.requestId === requestId) cachedIntent = null
    }).catch(error => {
      if (cachedIntent === intent && intent.requestId === requestId) { cachedIntent = null; warning(error) }
    })
  }
  const seek = async (at: number) => {
    if (!finite(at) || at < 0 || signal.aborted) return false
    cachedIntent = null
    if (seekReady(at) && progress) {
      // Play accepted bytes immediately, but also fence/replan a producer sent to an
      // older destination. No cursor replay is needed for this already buffered reserve.
      cachedIntent = { at, revision: progress.revision, generation: generation!, requestId: 0, stale: false, retries: 0 }
      notifyCachedIntent(cachedIntent)
      audio.currentTime = at
      return true
    }
    try {
      const request = requestSeek(at), pending = requestId
      if (!await request) return false
      const deadline = performance.now() + 10_000
      while (!signal.aborted && pending === requestId && performance.now() < deadline) {
        // Keep the old clock until the destination has a reserve. The old range can
        // still run out while its native producer seeks; that waiting remains observable.
        if (seekReady(at)) { audio.currentTime = at; return true }
        await delay(20, signal)
      }
      if (pending === requestId) warning(`No se pudo preparar el salto a ${at.toFixed(1)} s; se conserva el audio actual`)
    } catch (e) { if (!signal.aborted) warning(e) }
    return false
  }
  const onSeeking = () => {
    if (!covers(buffered(), audio.currentTime)) void requestSeek(audio.currentTime).catch(warning)
  }
  audio.addEventListener('seeking', onSeeking)
  ms.addEventListener('sourceclose', () => lifetime.abort(), { once: true })
  ms.addEventListener('sourceopen', async () => {
    URL.revokeObjectURL(url)
    try {
      while (!signal.aborted && !failed) {
        if (eof) { phase('eof'); await delay(EMPTY_POLL_MS, signal); continue }
        phase('read'); diagnostics.reads++
        const version = cursorVersion, readStarted = performance.now(), f = await read(videoId, from, revision, signal)
        diagnostics.lastReadMs = performance.now() - readStarted
        diagnostics.maxReadMs = Math.max(diagnostics.maxReadMs, diagnostics.lastReadMs)
        if (!f.chunks.length) diagnostics.emptyReads++
        check(signal)
        if (version !== cursorVersion) continue
        if (f.error) throw new Error(f.error)
        if (revision !== f.revision) {
          revision = f.revision; from = f.from
          cachedIntent = null
          if (installed) installed.context = ''
          metadata.clear(); contexts.clear(); initializations.clear(); frameEnds.clear()
        }
        generation = f.generation
        if (f.from !== from) throw new Error('El cursor de captura perdió unidades')
        for (const [i, u] of f.units.entries()) {
          check(signal)
          const context = `${revision}/${u.generation}/${u.epoch}/${u.source}/${u.s}`
          const initKey = `${revision}/${u.generation}/${u.initKey}`
          const key = `${context}/${u.unit}`, value = JSON.stringify(u), previous = metadata.get(key)
          if (previous && previous !== value) throw new Error('Cambió una unidad ya confirmada')
          if (!previous && u.firstFrame < (frameEnds.get(context) ?? 0)) throw new Error('Muestras repetidas en otra unidad de la misma fuente')
          const timeline = contexts.get(context)
          if (timeline && !sameSettings(timeline, u.timelineSettings)) throw new Error('Los ajustes temporales cambiaron dentro de una época')
          contexts.set(context, u.timelineSettings)
          const init = f.chunks[i].subarray(0, u.initBytes), knownInit = initializations.get(initKey)
          if (knownInit && (knownInit.length !== init.length || knownInit.some((byte, index) => byte !== init[index])))
            throw new Error('Cambió la inicialización de una configuración ya confirmada')
          if (!knownInit) initializations.set(initKey, init.slice())
          if (previous && covers(buffered(), u.rangeStart, u.rangeEnd)) continue
          if (!sb) {
            if (!MediaSource.isTypeSupported(u.mime)) throw new Error(`Formato de captura no compatible: ${u.mime}`)
            sb = ms.addSourceBuffer(u.mime)
          }
          phase('append')
          const appendStarted = performance.now()
          await idle(sb, signal)
          const sameInit = installed?.initKey === initKey && installed?.mime === u.mime
          if (!installed || installed.context !== context || !sameInit) {
            // MSE abort conserva frames y decoder config, pero restablece la ventana de append.
            // El setter mode reabre una MediaSource en ended antes de llamar a abort().
            if (ms.readyState === 'ended') sb.mode = 'segments'
            if (installed) sb.abort()
            if (installed && installed.mime !== u.mime) sb.changeType(u.mime)
            applySettings(sb, u.timelineSettings)
          }
          if (f.duration && ms.readyState === 'open') ms.duration = Math.max(f.duration, ...buffered().map(r => r.end))
          await append(sb, audio, sameInit ? f.chunks[i].subarray(u.initBytes) : f.chunks[i], signal)
          diagnostics.lastAppendMs = performance.now() - appendStarted
          diagnostics.maxAppendMs = Math.max(diagnostics.maxAppendMs, diagnostics.lastAppendMs)
          diagnostics.lastAppendAtMs = performance.now() - started; diagnostics.appends++
          installed = { initKey, mime: u.mime, context }
          metadata.set(key, value); totalUnits++
          frameEnds.set(context, Math.max(frameEnds.get(context) ?? 0, u.endFrame))
          firstAppendMs ??= performance.now() - started
        }
        if (version !== cursorVersion) continue
        from = f.next
        progress = { api: f.api, generation: f.generation, revision: f.revision, ranges: f.ranges, buffered: buffered(),
          duration: f.duration, audioDuration: f.audioDuration ?? null,
          complete: f.complete, recovering: f.recovering, softError: f.softError, units: totalUnits, firstAppendMs,
          startupReserveSeconds: STARTUP_RESERVE_SECONDS, readyMs, reader: readerSnapshot() }
        if (ready()) { readyMs ??= performance.now() - started; progress.readyMs = readyMs }
        audio.dispatchEvent(new CustomEvent('captureprogress', { detail: progressSnapshot() }))
        retryCachedIntent()
        if (f.softError) warning(f.softError)
        const verifiedDuration = f.audioDuration ?? f.duration
        const gap = verifiedDuration ? firstGap(f.ranges, verifiedDuration) : null
        const localGap = verifiedDuration ? firstGap(buffered(), verifiedDuration, audio.currentTime) : null
        // El extremo proviene de EOF nativo validado, incluso durante un backfill posterior.
        // Un hueco anterior al reloj no impide terminar el tramo que la persona eligió oír.
        // complete sigue siendo global y el lector continúa recuperando el resto del ledger.
        if (f.audioDuration && localGap === null && !f.chunks.length && sb && ms.readyState === 'open') {
          await idle(sb, signal)
          ms.endOfStream()
        }
        // La prueba nativa completa no demuestra que este MSE haya aceptado todos sus tramos.
        // Los rangos anteriores al reloj pueden haberse expulsado legítimamente por cuota.
        if (f.complete && verifiedDuration && gap === null && localGap === null && !f.chunks.length) {
          if (!sb) throw new Error('La captura terminó sin audio')
          await idle(sb, signal)
          if (ms.readyState === 'open') ms.endOfStream()
          eof = true
        } else if ((f.softError || f.complete) && !f.recovering && !f.chunks.length) {
          const at = gap ?? localGap ?? audio.currentTime
          // Reabrir la ventana cambia generation, pero no cuenta como progreso del hueco.
          const key = `${revision}/${at.toFixed(3)}`
          if (key !== recoveryKey) { recoveryKey = key; recoveryCount = 0 }
          if (recoveryCount++ < 2) await requestSeek(at)
          else { warning(`Captura incompleta desde ${at.toFixed(1)} s; se conserva el audio verificado`); eof = true }
        }
        if (!f.chunks.length) {
          phase('empty-poll'); diagnostics.emptyPolls++
          const pollStarted = performance.now()
          await delay(EMPTY_POLL_MS, signal)
          diagnostics.maxEmptyPollElapsedMs = Math.max(diagnostics.maxEmptyPollElapsedMs, performance.now() - pollStarted)
        }
      }
    } catch (e) { if (!signal.aborted) fail(e) }
  }, { once: true })
  const stop: Stop = (cancelBackend = true) => {
    if (stopped) return
    stopped = true; cachedIntent = null; phase('stopped')
    lifetime.abort(); audio.removeEventListener('seeking', onSeeking); URL.revokeObjectURL(url)
    if (readers.get(audio)?.stop === stop) readers.delete(audio)
    if (cancelBackend && generation !== undefined) void invoke('capture_cancel', { videoId, generation }).catch(() => {})
  }
  readers.set(audio, { stop, seek, ready, waitReady, progress: progressSnapshot })
  audio.src = url
  return stop
}

export const captureProgress = (audio: HTMLAudioElement) => readers.get(audio)?.progress() ?? null
export const captureReady = (audio: HTMLAudioElement) => readers.get(audio)?.ready() ?? false
/** Sólo API4 necesita reserva: las URL directas y legacy conservan su arranque. */
export const waitForCaptureReady = (audio: HTMLAudioElement): Promise<void> => readers.get(audio)?.waitReady() ?? Promise.resolve()
/** Espera el nuevo rango sin mover el reloj del audio que todavía está sonando. */
export function seekCapture(audio: HTMLAudioElement, at: number): Promise<boolean> {
  const reader = readers.get(audio)
  if (reader) return reader.seek(at)
  audio.currentTime = at
  return Promise.resolve(true)
}
let stopCurrent: Stop | null = null
export function stopCapture(cancelBackend = true) { stopCurrent?.(cancelBackend); stopCurrent = null }
/** Preparar un segundo audio no cambia el lector del audio actual. */
export function prepareAudioSource(audio: HTMLAudioElement, src: string): Stop {
  if (src.startsWith(CAPTURE)) return playCapture(audio, src.slice(CAPTURE.length))
  if (src.startsWith(LEGACY_CAPTURE)) return playLegacyCapture(audio, src.slice(LEGACY_CAPTURE.length))
  audio.src = src
  return () => {}
}
export function adoptAudioSource(stop: Stop) { stopCurrent = stop }
export function setAudioSource(audio: HTMLAudioElement, src: string) {
  stopCapture(); stopCurrent = prepareAudioSource(audio, src)
}
