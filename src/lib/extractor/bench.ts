// P1: compara los motores dentro de la app (tiempos, si suena en <audio> y si YouTube corta el
// audio a mitad). Se lanza con MUSIFY_BENCH=plan.json.
import { invoke } from '@tauri-apps/api/core'
import * as api from '../api'
import { player, type QueueItem } from '../player.svelte'
import { playCapture } from './capture'
import { extractor, type Engine } from './engine.svelte'
import { host } from './host'
import { CLIENTS, innertube, setup, stats, stream } from './youtubei'
import { runCaptureSuite, type CaptureSuitePlan } from './capture-suite'
import rateFixture from '../../../tests/fixtures/mse-rates.json'

interface Plan {
  videos: { id: string; label: string; duration: number }[]
  captureSuite?: CaptureSuitePlan
  /** Probar cada cliente de YouTube con los primeros `count` vídeos. */
  survey?: { clients: string[]; count: number }
  /** youtubei.js (con su orden de clientes) con todos los vídeos. */
  full?: boolean
  /** yt-dlp con todos los vídeos. */
  ytdlp?: boolean
  /** Medir yt-dlp antes que youtubei.js (para ver si el orden influye). */
  ytdlpFirst?: boolean
  /** Comprobar que cada URL suena en un <audio> (y que se puede saltar al 80 %). */
  audio?: boolean
  /** Motor propio, nivel rápido (Rust), con todos los vídeos. */
  tier1?: boolean
  /** Captura oficial experimental en la ventana oculta, con los primeros `count`. */
  tier2?: { count: number }
  /** Audio sintético local: comprueba ajustes MSE y su reproducción idéntica en WebView2. */
  mse?: MseProbe[]
  /** Ensayos de reloj/decodificación y marcador tardío con audio sintético local. */
  rates?: boolean
  /** Reproducir canciones de verdad con el reproductor de la app y el motor indicado. */
  e2e?: E2E | E2E[]
}

type E2E = { query?: string; albumId?: number; tracks: number; engine?: Engine }

type Probe = { length: number; start: number; deep: number }
type MseProbe = {
  label: string; mime: string; base64: string; quantum: number
  expected: { start: number; end: number }
  settings: { timestampOffset: number; appendWindowStart: number; appendWindowEnd: number | null; mode: 'segments' }
}
type AudioCheck = {
  ok: boolean; startMs?: number; playMs?: number; seekMs?: number; duration?: number
  coverageEnd?: number; tailMs?: number; error?: string
}

// Sólo margen en los extremos por padding del códec; no permite huecos interiores.
const CAPTURE_EDGE_TOLERANCE = 0.1
// capture.rs MAX_WAIT (20 min) más el plazo de arranque MSE del consumidor.
const CAPTURE_E2E_TIMEOUT_MS = 20 * 60 * 1000 + 15000

const logs: string[] = []

export async function runBench(plan: Plan) {
  // Se mide el youtubei.js que trae la app.
  setup(host)
  const restore = captureLogs()
  logs.length = 0
  const report: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    clients: CLIENTS,
  }
  try {
    if (plan.captureSuite) {
      report.captureSuite = await runCaptureSuite(plan.captureSuite, partial =>
        invoke('capture_bench_checkpoint', { report: { ...report, captureSuite: partial } }))
    }
    if (plan.mse) {
      const rows = []
      for (const probe of plan.mse) rows.push(await mseProbe(probe))
      report.mse = rows
    }
    if (plan.rates) report.rates = await rateTrials()
    if (plan.full || plan.survey) {
      const t = performance.now()
      await innertube()
      report.session = { ms: Math.round(performance.now() - t), innerMs: Math.round(stats.sessionMs) }
    }

    if (plan.survey) {
      const rows = []
      for (const client of plan.survey.clients)
        for (const v of plan.videos.slice(0, plan.survey.count)) rows.push({ client, ...(await viaYoutubei(v.id, plan, [client])) })
      report.survey = rows
    }
    const steps = [
      async () => {
        if (!plan.full) return
        const rows = []
        for (const v of plan.videos) rows.push({ label: v.label, ...(await viaYoutubei(v.id, plan)) })
        report.youtubei = rows
      },
      async () => {
        if (!plan.ytdlp) return
        const rows = []
        for (const v of plan.videos) rows.push({ label: v.label, ...(await viaYtdlp(v.id, plan)) })
        report.ytdlp = rows
      },
    ]
    if (plan.ytdlpFirst) steps.reverse()
    for (const step of steps) await step()
    if (plan.tier1) {
      const rows = []
      for (const v of plan.videos) rows.push({ label: v.label, ...(await viaNative(v.id, plan)) })
      report.tier1 = rows
    }
    if (plan.tier2) {
      const rows = []
      for (const v of plan.videos.slice(0, plan.tier2.count)) rows.push({ label: v.label, ...(await viaCapture(v.id)) })
      report.tier2 = rows
    }
    if (plan.e2e) {
      const runs = []
      for (const e of [plan.e2e].flat()) runs.push(await endToEnd(e))
      report.e2e = runs
    }
    report.engineStats = await extractor.stats().catch(() => null)
  } catch (e) {
    report.fatal = String(e)
  } finally {
    restore()
  }
  report.stats = { ...stats, evalAvgMs: stats.evals ? Math.round(stats.evalMs / stats.evals) : 0 }
  report.logs = logs
  // Los informes antiguos conservan sus datos; ok ahora exige todos los controles solicitados.
  const results = ['survey', 'youtubei', 'ytdlp', 'tier1', 'tier2', 'e2e', 'mse']
    .flatMap((key) => (report[key] as { ok: boolean }[] | undefined) ?? [])
  if (report.captureSuite) results.push(report.captureSuite as { ok: boolean })
  if (report.rates) results.push(report.rates as { ok: boolean })
  report.ok = !report.fatal && results.length > 0 && results.every((row) => row.ok)
  await invoke('bench_report', { report })
}

async function mseProbe(probe: MseProbe) {
  const runs: { start: number; end: number; duration: number; ended: boolean }[] = []
  const wait = (target: EventTarget, name: string, action: () => void) => new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); target.removeEventListener(name, done); target.removeEventListener('error', failed) }
    const done = () => { cleanup(); resolve() }
    const failed = () => { cleanup(); reject(new Error(`MSE ${probe.label}: error esperando ${name}`)) }
    const timer = setTimeout(failed, 10000)
    target.addEventListener(name, done, { once: true })
    target.addEventListener('error', failed, { once: true })
    try { action() } catch (e) { cleanup(); reject(e) }
  })
  try {
    const bytes = Uint8Array.from(atob(probe.base64), ch => ch.charCodeAt(0))
    // Dos MediaSource independientes: presentación original y repetición con mismos bytes/ajustes.
    for (let i = 0; i < 2; i++) {
      const audio = new Audio(), source = new MediaSource(), url = URL.createObjectURL(source)
      audio.muted = true
      try {
        await wait(source, 'sourceopen', () => { audio.src = url })
        const sb = source.addSourceBuffer(probe.mime)
        sb.mode = probe.settings.mode
        sb.timestampOffset = probe.settings.timestampOffset
        sb.appendWindowEnd = probe.settings.appendWindowEnd ?? Infinity
        sb.appendWindowStart = probe.settings.appendWindowStart
        await wait(sb, 'updateend', () => sb.appendBuffer(bytes))
        if (sb.buffered.length !== 1) throw new Error('MSE no produjo un único rango continuo')
        const start = sb.buffered.start(0), end = sb.buffered.end(0)
        source.endOfStream()
        await wait(audio, 'ended', () => { void audio.play().catch(() => audio.dispatchEvent(new Event('error'))) })
        if (audio.error || !audio.ended) throw new Error('MSE no reprodujo el final')
        runs.push({ start, end, duration: audio.duration, ended: audio.ended })
      } finally { audio.pause(); audio.removeAttribute('src'); audio.load(); URL.revokeObjectURL(url) }
    }
    const [first, replay] = runs
    const epsilon = probe.quantum + 0.000001
    const ok = Math.abs(first.start - probe.expected.start) <= epsilon &&
      Math.abs(first.end - probe.expected.end) <= epsilon && first.end > first.start &&
      Math.abs(first.start - replay.start) <= epsilon && Math.abs(first.end - replay.end) <= epsilon &&
      (probe.settings.appendWindowEnd === null || first.end <= probe.settings.appendWindowEnd + epsilon)
    return { label: probe.label, ok, settings: probe.settings, expected: probe.expected, runs }
  } catch (e) { return { label: probe.label, ok: false, settings: probe.settings, runs, error: String(e) } }
}

type RateSample = { wallMs: number; mediaTime: number; rate: number }
type Marker = { at: number; observedAt: number; wallMs: number; previousRate: number }

/** Deriva evidencia del reloj observado; nunca usa duration / playbackRate como medida. */
export function rateEvidence(samples: RateSample[], adStart: number, adEnd: number) {
  const first = samples[0], last = samples.at(-1)
  let adMediaMs = 0, unsafeAdMediaMs = 0, unsafeAdWallMs = 0, maxSampleGapMs = 0
  let acceleratedAdMediaMs = 0, adClockJumpIntervals = 0
  const clockJitterMs = 25
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i], advance = b.mediaTime - a.mediaTime, elapsed = b.wallMs - a.wallMs
    if (advance < 0 || elapsed < 0) throw new Error('El reloj de la sonda retrocedió')
    maxSampleGapMs = Math.max(maxSampleGapMs, elapsed)
    if (!advance) continue
    const overlap = Math.max(0, Math.min(b.mediaTime, adEnd) - Math.max(a.mediaTime, adStart))
    adMediaMs += overlap * 1000
    // playbackRate is a request, not proof that the decoder clock already adopted it.
    // Allow one AAC frame of clock quantization plus timer jitter, then retain every
    // reference-ad interval whose observed pace is still incompatible with real time.
    if (overlap > 0 && advance * 1000 > elapsed + clockJitterMs) {
      acceleratedAdMediaMs += overlap * 1000
      adClockJumpIntervals++
    }
    if (a.rate !== 1 && overlap > 0) {
      unsafeAdMediaMs += overlap * 1000
      // Estimación entre observaciones nativas; se conserva el intervalo máximo para auditar precisión.
      unsafeAdWallMs += elapsed * overlap / advance
    }
  }
  const wallMs = first && last ? last.wallMs - first.wallMs : 0
  const mediaSeconds = first && last ? last.mediaTime - first.mediaTime : 0
  const meanWall = samples.reduce((n, p) => n + p.wallMs, 0) / Math.max(1, samples.length)
  const meanMedia = samples.reduce((n, p) => n + p.mediaTime, 0) / Math.max(1, samples.length)
  const variance = samples.reduce((n, p) => n + (p.wallMs - meanWall) ** 2, 0)
  const slope = variance ? samples.reduce((n, p) => n + (p.wallMs - meanWall) * (p.mediaTime - meanMedia), 0) / variance * 1000 : null
  // The outside brackets deliberately OVERestimate how much wall time the ad could
  // have occupied. Even this conservative lower bound can disprove 1x presentation.
  const adBefore = samples.findLast(p => p.mediaTime <= adStart)
  const adAfter = samples.find(p => p.mediaTime >= adEnd)
  const adWallUpperBoundMs = adBefore && adAfter ? adAfter.wallMs - adBefore.wallMs : null
  const referenceAdMs = (adEnd - adStart) * 1000
  const adPaceLowerBound = adWallUpperBoundMs !== null && adWallUpperBoundMs > 0 ? referenceAdMs / adWallUpperBoundMs : null
  const adClockTooFast = adWallUpperBoundMs !== null && referenceAdMs > adWallUpperBoundMs + clockJitterMs || adClockJumpIntervals > 0
  const adClockStatus = adClockTooFast ? 'incompatible-with-1x' : adPaceLowerBound === null ? 'unobserved' : 'consistent-with-1x-not-proof'
  return { wallMs, mediaSeconds, measuredRate: wallMs > 0 ? mediaSeconds / (wallMs / 1000) : null,
    clockSlope: slope, adMediaMs, unsafeAdMediaMs, unsafeAdWallMs, maxSampleGapMs, samples: samples.length,
    clockJitterMs, adWallUpperBoundMs, adPaceLowerBound, adClockJumpIntervals, acceleratedAdMediaMs, adClockTooFast, adClockStatus }
}

async function rateTrials() {
  const probe = rateFixture.probe as MseProbe
  const rows = []
  for (const rate of [1, 2, 4, 16]) {
    rows.push(await rateProbe(probe, rate))
    rows.push(await rateProbe(probe, rate, 0.9))
    rows.push(await rateProbe(probe, rate, 1.1))
  }
  return { ok: rows.every(row => row.ok), syntheticOnly: true, liveAccelerationEnabled: false,
    provenance: rateFixture.provenance, referenceAdStart: 1, referenceAdEnd: 1.5,
    markerModel: 'A reference tone changes at 1.0 s; visible marker arrives at 0.9 or 1.1 media seconds. The native player changes to 1x only when that marker is observed.',
    interpretation: 'Decode/rate success is not identity safety. unsafeAdMediaMs records reference ad media advanced above 1x. potentialMisclassifiedAdMs also exposes late-label contamination at 1x. No remote audio or real advertisements are accelerated.',
    rows }
}

async function rateProbe(probe: MseProbe, rate: number, markerAt?: number) {
  const audio = new Audio(), source = new MediaSource(), url = URL.createObjectURL(source)
  const samples: RateSample[] = [], controller = new AbortController()
  let timer: ReturnType<typeof setInterval> | undefined, marker: Marker | null = null
  let begin = 0, start = 0, end = 0, audioDuration = 0
  const waitEvent = (target: EventTarget, name: string, action: () => void, timeout = 10000) => new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(limit); target.removeEventListener(name, done); target.removeEventListener('error', failed); controller.signal.removeEventListener('abort', failed) }
    const done = () => { cleanup(); resolve() }
    const failed = () => { cleanup(); reject(new Error(`Rate ${rate}x: error esperando ${name}`)) }
    const limit = setTimeout(failed, timeout)
    target.addEventListener(name, done, { once: true }); target.addEventListener('error', failed, { once: true }); controller.signal.addEventListener('abort', failed, { once: true })
    try { action() } catch (e) { cleanup(); reject(e) }
  })
  const observe = () => {
    if (!begin) return
    const sample = { wallMs: performance.now() - begin, mediaTime: audio.currentTime, rate: audio.playbackRate }
    samples.push(sample)
    if (markerAt !== undefined && !marker && sample.mediaTime >= markerAt) {
      marker = { at: markerAt, observedAt: sample.mediaTime, wallMs: sample.wallMs, previousRate: sample.rate }
      audio.playbackRate = 1
      // Duplicate time/position explicitly separates the two rate intervals.
      samples.push({ ...sample, rate: audio.playbackRate })
    }
  }
  try {
    audio.muted = true
    await waitEvent(source, 'sourceopen', () => { audio.src = url })
    const sb = source.addSourceBuffer(probe.mime)
    sb.mode = probe.settings.mode; sb.timestampOffset = probe.settings.timestampOffset
    sb.appendWindowEnd = probe.settings.appendWindowEnd ?? Infinity; sb.appendWindowStart = probe.settings.appendWindowStart
    const bytes = Uint8Array.from(atob(probe.base64), c => c.charCodeAt(0))
    await waitEvent(sb, 'updateend', () => sb.appendBuffer(bytes))
    if (sb.buffered.length !== 1) throw new Error('La sonda local no tiene cobertura continua')
    start = sb.buffered.start(0); end = sb.buffered.end(0)
    source.endOfStream(); audioDuration = audio.duration
    audio.playbackRate = rate
    audio.addEventListener('playing', () => { if (!begin) { begin = performance.now(); observe() } }, { once: true, signal: controller.signal })
    timer = setInterval(observe, 5)
    await waitEvent(audio, 'ended', () => { void audio.play().catch(() => audio.dispatchEvent(new Event('error'))) }, 10000)
    observe()
    const evidence = rateEvidence(samples, 1, 1.5)
    const epsilon = probe.quantum + 0.000001
    const coverageOk = Math.abs(start - probe.expected.start) <= epsilon && Math.abs(end - probe.expected.end) <= epsilon
    const decodedToEnd = !audio.error && audio.ended && audio.currentTime >= end - epsilon
    const constant = markerAt === undefined
    const observedRate = evidence.clockSlope
    const rateHonored = !constant || (observedRate !== null && Math.abs(observedRate - rate) <= rate * 0.25)
    const markerObserved = constant || marker !== null
    return { label: probe.label, requestedRate: rate, scenario: constant ? 'constant-clock' : markerAt! < 1 ? 'early-ad-marker' : 'late-ad-marker',
      markerAt, marker, ok: coverageOk && decodedToEnd && rateHonored && markerObserved && samples.length > 2,
      coverageOk, decodedToEnd, rateHonored, buffered: { start, end }, duration: audioDuration, finalTime: audio.currentTime,
      evidence, adRatePreserved: constant ? null : evidence.unsafeAdMediaMs > 0 || evidence.adClockTooFast ? false : null,
      potentialMisclassifiedAdMs: constant ? null : Math.max(0, Math.min((marker as Marker | null)?.observedAt ?? 1.5, 1.5) - 1) * 1000,
      identitySafetyVerified: false,
      liveEligible: false, samples }
  } catch (e) {
    return { label: probe.label, requestedRate: rate, markerAt, marker, ok: false, error: String(e),
      buffered: { start, end }, duration: audioDuration, evidence: rateEvidence(samples, 1, 1.5), liveEligible: false, samples }
  } finally {
    if (timer !== undefined) clearInterval(timer)
    controller.abort(); audio.pause(); audio.removeAttribute('src'); audio.load(); URL.revokeObjectURL(url)
  }
}

async function viaYoutubei(videoId: string, plan: Plan, clients?: string[]) {
  const t = performance.now()
  try {
    const s = await stream(videoId, clients as never)
    const ms = Math.round(performance.now() - t)
    return { videoId, extractionOk: true, ms, client: s.client, itag: s.itag, mime: s.mime, ...(await check(s.url, plan)) }
  } catch (e) {
    return { videoId, extractionOk: false, ok: false, ms: Math.round(performance.now() - t), error: String(e) }
  }
}

async function viaYtdlp(videoId: string, plan: Plan) {
  try {
    const r = await invoke<{ ms: number; url: string }>('bench_ytdlp', { videoId })
    const q = new URL(r.url).searchParams
    return { videoId, extractionOk: true, ms: r.ms, client: q.get('c'), itag: Number(q.get('itag')), mime: q.get('mime'), ...(await check(r.url, plan)) }
  } catch (e) {
    return { videoId, extractionOk: false, ok: false, error: String(e) }
  }
}

async function viaNative(videoId: string, plan: Plan) {
  try {
    const r = await invoke<{ ms: number; url: string; client: string; itag: number; mime: string }>('bench_native', { videoId })
    return { videoId, extractionOk: true, ms: r.ms, client: r.client, itag: r.itag, mime: r.mime, ...(await check(r.url, plan)) }
  } catch (e) {
    return { videoId, extractionOk: false, ok: false, error: String(e) }
  }
}

/** Captura oficial: hasta que llega audio, que suene, se pueda saltar al 80 % y esté entera. */
async function viaCapture(videoId: string) {
  const started = performance.now()
  let extractionMs: number | undefined
  try {
    const r = await invoke<{ ms: number; title: string }>('bench_capture', { videoId })
    extractionMs = r.ms
    let status: Record<string, unknown> | null = null
    // Mantener vivo el lector hasta comprobar el final: su cleanup cancela la captura.
    const audio = await playCheck(videoId, true, async () => {
      const t = performance.now()
      while (performance.now() - t < 90000) {
        status = await invoke<Record<string, unknown> | null>('capture_status', { videoId })
        if (typeof status?.doneMs === 'number' || status?.error || !status) break
        await new Promise((res) => setTimeout(res, 500))
      }
    })
    if (!status) status = await invoke<Record<string, unknown> | null>('capture_status', { videoId })
    const complete = typeof status?.doneMs === 'number' && !status.error
    return {
      videoId, extractionOk: true, ok: audio.ok && complete, complete, ms: r.ms, title: r.title, audio, status,
      error: complete ? undefined : String(status?.error ?? (status ? 'La captura no terminó en 90 s' : 'La captura ya no existe')),
    }
  } catch (e) {
    const elapsedMs = Math.round(performance.now() - started)
    let statusError: string | undefined
    const status = await invoke<Record<string, unknown> | null>('capture_status', { videoId }).catch((diagnosticError) => {
      statusError = String(diagnosticError)
      return null
    })
    return {
      videoId, extractionOk: extractionMs !== undefined, ok: false, ms: extractionMs ?? elapsedMs,
      error: String(e), status, statusError,
    }
  }
}

async function check(url: string, plan: Plan) {
  const probe = await invoke<Probe>('bench_probe', { url }).catch((e) => String(e))
  const probeOk = typeof probe !== 'string' && probe.length > 0 && probe.start === 206 && probe.deep === 206
  const audio = plan.audio ? await playCheck(url) : undefined
  return { ok: probeOk && (!plan.audio || audio?.ok === true), probeOk, probe, audio }
}

/** Que suene en un <audio> (en silencio) y que se pueda saltar al 80 % y siga sonando. */
async function playCheck(url: string, capture = false, beforeStop?: () => Promise<void>): Promise<AudioCheck> {
  const a = new Audio()
  const controller = new AbortController()
  a.muted = true
  a.preload = 'auto'
  const t0 = performance.now()
  let stop = () => {}
  let result: AudioCheck = { ok: false }
  try {
    if (capture) stop = playCapture(a, url)
    else a.src = url
    await Promise.all([until(a, 'playing', 15000, controller.signal), a.play()])
    const startMs = Math.round(performance.now() - t0)
    await progress(a, 0.5)
    const playMs = Math.round(performance.now() - t0)
    const t1 = performance.now()
    if (!Number.isFinite(a.duration) || a.duration <= 0) throw new Error('Duración de audio inválida')
    // EOS puede ajustar duration al último buffer: conservar la duración esperada de la fuente.
    const duration = a.duration
    const seeked = until(a, 'seeked', capture ? 60000 : 15000, controller.signal)
    a.currentTime = duration * 0.8
    await seeked
    await progress(a, 0.5)
    result = { ok: false, startMs, playMs, seekMs: Math.round(performance.now() - t1), duration }
    await beforeStop?.()
    if (capture) {
      // done nativo sólo sella el productor; el lector aún puede estar haciendo appendBuffer.
      result.coverageEnd = await captureCoverage(a, duration)
      const tailStarted = performance.now()
      a.pause()
      const tailSeeked = until(a, 'seeked', 15000, controller.signal)
      a.currentTime = Math.max(0, Math.min(duration, result.coverageEnd) - 0.5)
      await tailSeeked
      await Promise.all([until(a, 'ended', 10000, controller.signal), a.play()])
      if (a.currentTime < duration - CAPTURE_EDGE_TOLERANCE)
        throw new Error(`audio terminado antes del final: ${a.currentTime.toFixed(3)} / ${duration.toFixed(3)} s`)
      result.tailMs = Math.round(performance.now() - tailStarted)
    }
    return { ...result, ok: true }
  } catch (e) {
    return { ...result, ok: false, error: String(e) }
  } finally {
    controller.abort()
    stop()
    a.pause()
    a.removeAttribute('src')
    a.load()
  }
}

/** Cobertura completa sólo para la captura sellada, cuyo audio se conserva en memoria. */
async function captureCoverage(a: HTMLAudioElement, duration: number): Promise<number> {
  const deadline = performance.now() + 15000
  while (true) {
    if (a.error) throw new Error(`error de audio ${a.error.code}: ${a.error.message}`)
    const buffered = a.buffered
    const ranges = Array.from({ length: buffered.length }, (_, i) => [buffered.start(i), buffered.end(i)])
    const end = ranges.at(-1)?.[1] ?? 0
    const contiguous = ranges.length > 0 && ranges[0][0] <= CAPTURE_EDGE_TOLERANCE &&
      ranges.every(([start, finish], i) => Number.isFinite(start) && Number.isFinite(finish) && start < finish &&
        (i === 0 || start <= ranges[i - 1][1] + 1e-6))
    if (contiguous && end >= duration - CAPTURE_EDGE_TOLERANCE) return end
    if (performance.now() >= deadline)
      throw new Error(`captura sin cobertura continua 0..${duration.toFixed(3)} s en 15000 ms; buffered=${JSON.stringify(ranges)}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function until(a: HTMLAudioElement, event: string, ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      a.removeEventListener(event, done)
      a.removeEventListener('error', failed)
      a.removeEventListener('captureerror', captureFailed)
      signal.removeEventListener('abort', abort)
    }
    const done = () => { cleanup(); resolve() }
    const failed = () => { cleanup(); reject(new Error(`error de audio ${a.error?.code}: ${a.error?.message}`)) }
    const captureFailed = (e: Event) => { cleanup(); reject(new Error(String((e as CustomEvent).detail))) }
    const abort = () => { cleanup(); reject(new DOMException('Prueba terminada', 'AbortError')) }
    const timer = setTimeout(() => { cleanup(); reject(new Error(`sin '${event}' en ${ms} ms`)) }, ms)
    a.addEventListener(event, done, { once: true })
    a.addEventListener('error', failed, { once: true })
    a.addEventListener('captureerror', captureFailed, { once: true })
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** Espera a que el audio avance `seconds` desde donde está. */
async function progress(a: HTMLAudioElement, seconds: number) {
  const from = a.currentTime
  const deadline = performance.now() + 10000
  while (a.currentTime < from + seconds) {
    if (a.error) throw new Error(`error de audio ${a.error.code}: ${a.error.message}`)
    if (performance.now() > deadline) throw new Error(`no avanza (se quedó en ${a.currentTime.toFixed(1)} s)`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** Canciones de verdad con el reproductor de la app (volumen a 0) y el motor indicado. */
async function endToEnd({ query, albumId, tracks, engine = 'youtubei' }: E2E) {
  // albumId evita que una variación en la búsqueda cambie el conjunto medido.
  const id = albumId ?? (query ? (await api.search(query)).albums[0]?.id : undefined)
  if (id === undefined) throw new Error('E2E necesita albumId o una búsqueda con resultados')
  const album = await api.album(id)
  const items: QueueItem[] = album.tracks.slice(0, tracks).map((track) => ({
    track,
    albumId: album.id,
    albumTitle: album.title,
    artistId: album.artist.id,
    cover: album.coverBig,
  }))
  const volume = player.volume
  const previousEngine = extractor.engine
  const before = { served: extractor.served, failed: extractor.failed }
  const timeoutMs = engine === 'oficial' || engine === 'propio' ? CAPTURE_E2E_TIMEOUT_MS : 60000
  const rows = []
  try {
    player.setVolume(0)
    await extractor.set(engine)
    player.playQueue(items, 0)
    for (let i = 0; i < items.length; i++) {
      const t = performance.now()
      let startMs = -1
      let ok = true
      while (!(player.current?.track.id === items[i].track.id && player.status === 'playing' && player.time > 1)) {
        if (startMs < 0 && player.current?.track.id === items[i].track.id && player.status === 'playing')
          startMs = Math.round(performance.now() - t)
        if (player.status === 'idle' || performance.now() - t > timeoutMs) {
          ok = false
          break
        }
        await new Promise((r) => setTimeout(r, 25))
      }
      rows.push({
        title: items[i].track.title, ok, timeoutMs, msToPlaying: startMs, msToOneSecond: Math.round(performance.now() - t),
        state: { status: player.status, time: player.time, currentTrackId: player.current?.track.id },
      })
      // La siguiente se pide tras unos segundos sonando para dar tiempo a la precarga.
      if (i < items.length - 1) {
        await new Promise((r) => setTimeout(r, 4000))
        player.next()
      }
    }
  } finally {
    if (player.status === 'playing' || player.status === 'loading') player.toggle()
    player.setVolume(volume)
    await extractor.set(previousEngine)
  }
  return {
    ok: rows.length > 0 && rows.every((row) => row.ok),
    albumId: id,
    engine,
    rows,
    servedByYoutubei: extractor.served - before.served,
    fellBackToYtdlp: extractor.failed - before.failed,
    engineStats: await extractor.stats().catch(() => null),
  }
}

/** Guarda los avisos de youtubei.js (p. ej. sobre PO tokens) para el informe. */
function captureLogs() {
  const original = { warn: console.warn, error: console.error }
  for (const level of ['warn', 'error'] as const) {
    console[level] = (...args: unknown[]) => {
      const line = args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
      if (line.includes('YOUTUBEJS')) logs.push(`${level}: ${line.slice(0, 500)}`)
      original[level](...args)
    }
  }
  return () => Object.assign(console, original)
}
