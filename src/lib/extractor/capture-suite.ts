/** Medidas reales en WebView2. Los umbrales no se usan como timeout ni ocultan fallos. */
import { invoke } from '@tauri-apps/api/core'
import * as api from '../api'
import { player, toQuery, type QueueItem } from '../player.svelte'
import { extractor } from './engine.svelte'
import { captureProgress, playCapture, waitForCaptureReady, seekCapture, stopCapture } from './capture'

export interface CaptureCase extends Partial<QueueItem> {
  id?: string; label: string; duration: number; error?: string
}
interface Corpus {
  source: string; expectedTracks: number
  albums: { query: string; albumId?: number; error?: string; expectedTracks: number; rows?: CaptureCase[] }[]
}
export interface CaptureSuitePlan {
  mode: 'catalog' | 'smoke' | 'latency' | 'album' | 'switch' | 'native-search' | 'ad-transitions' | 'profile-login'
  engine?: 'oficial' | 'propio'
  /** Cohorte publicitaria acotada; no repetir hasta obtener sólo éxitos. */
  minimumAdTransitions?: number
  maxAdAttempts?: number
  corpus?: Corpus
  videos?: CaptureCase[]
  /** Espera operativa, distinta del umbral de éxito de3s. */
  timeoutSeconds?: number
  /** Smoke observa reproducción desde cero y después salta a una zona no capturada. */
  seek?: boolean
  /** false mide tiempos; declara explícitamente que no ejercitó EOF/cobertura completa. */
  verifyComplete?: boolean
  /** false controla la cuarentena completa: mide su tiempo sin exigir latencia progresiva. */
  experimental?: boolean
}
type Range = { start: number; end: number }
type Status = {
  generation: number; epoch: number; revision: number; duration?: number; audioDuration?: number; eofEnd?: number
  complete?: boolean; doneMs?: number; ranges?: Range[]; error?: string; softError?: string
  active?: boolean; recovering?: boolean; recoveryBlocked?: boolean
  adsSeen?: number; adsDelivered?: number; adMs?: number; adRateViolations?: number; adRateObservations?: number
  [key: string]: unknown
}
type Row = Record<string, unknown> & { label: string; ok: boolean; failures: string[] }
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const status = (id: string) => invoke<Status | null>('capture_status', { videoId: id })
const covers = (ranges: Range[], at: number, after = 0) => ranges.some(r => r.start <= at + 0.000001 && r.end >= at + after)
export const LIMITS = { firstSoundMs: 3000, nextTrackMs: 500, unpreparedMs: 3000, seekMs: 1000 }
export const NATIVE_LIMITS = { firstSoundMs: 300, nextTrackMs: 100 }
const timingOnly = (plan: CaptureSuitePlan) => plan.experimental !== false && (plan.verifyComplete === false || plan.mode === 'latency')

/** Cero sólo significa cero gaps en el inventario y cero eventos de espera durante escucha. */
export function continuous(ranges: Range[], duration: number, epsilon = 0.000001): boolean {
  return Number.isFinite(duration) && duration > 0 && ranges.length === 1 &&
    Number.isFinite(ranges[0].start) && Number.isFinite(ranges[0].end) &&
    Math.abs(ranges[0].start) <= epsilon && Math.abs(ranges[0].end - duration) <= epsilon
}

/** Una URL nativa puede conservar priming AAC antes de cero; debe cubrir todo lo reproducible. */
export function directPlaybackCoverage(ranges: Range[], duration: number, epsilon = 0.000001): boolean {
  return Number.isFinite(duration) && duration > 0 && ranges.length === 1 &&
    Number.isFinite(ranges[0].start) && Number.isFinite(ranges[0].end) && ranges[0].start < ranges[0].end &&
    ranges[0].start <= epsilon && ranges[0].end >= duration - epsilon
}

async function until(predicate: () => boolean, deadline: number, check: () => void = () => {}, pulse?: () => Promise<void>, pulseMs = 15000) {
  let lastPulse = performance.now()
  while (!predicate()) {
    check()
    if (performance.now() >= deadline) throw new Error('Se agotó la espera operativa; el criterio temporal no se ha superado')
    if (pulse && performance.now() - lastPulse >= pulseMs) { await pulse(); lastPulse = performance.now() }
    await sleep(20)
  }
}

function terminalCaptureFailure(s: Status | null): string | null {
  // A retained prefix and a soft error are normal during recovery. Only the
  // native circuit breaker plus an inactive lease declare automatic recovery over.
  return s?.complete !== true && s?.recoveryBlocked === true && s.active === false && s.recovering === false &&
    typeof s.softError === 'string' && s.softError.length > 0 ? s.softError : null
}

function liveAudio(audio: HTMLAudioElement, started: number) {
  return { elapsedMs: performance.now() - started, position: audio.currentTime, paused: audio.paused,
    seeking: audio.seeking, ended: audio.ended, readyState: audio.readyState,
    buffered: Array.from({ length: audio.buffered.length }, (_, i) => ({ start: audio.buffered.start(i), end: audio.buffered.end(i) })) }
}

function within<T>(promise: Promise<T>, deadline: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Se agotó la espera operativa')), Math.max(0, deadline - performance.now()))
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

/** Conserva cada fase y el último snapshot incluso si ended destruye el lector. */
function observeAudio(audio: HTMLAudioElement, closeOnEnd = false) {
  const started = performance.now()
  type Phase = 'startup' | 'listening' | 'seek' | 'backfill' | 'tail'
  let phase: Phase = 'startup'
  const events: { type: string; ms: number; position: number; phase: Phase; detail?: unknown }[] = []
  const gaps: { startMs: number; endMs?: number; position: number; phase: Phase }[] = []
  const allPlaybackStalls: { ms: number; position: number; phase: Phase; label: string; paused: boolean; seeking: boolean; ended: boolean }[] = []
  let firstPlaying: number | null = null, ended: number | null = null
  let lastProgress = captureProgress(audio), endedPosition: number | null = null
  let endedBuffered: Range[] | null = null
  let waiting: (typeof gaps)[number] | null = null
  const listeners: [string, EventListener, boolean][] = []
  const close = () => { for (const [name, listener, capture] of listeners) audio.removeEventListener(name, listener, capture) }
  for (const name of ['playing', 'ended', 'waiting', 'stalled', 'seeking', 'seeked', 'error', 'capturewarning', 'captureerror', 'captureprogress', 'capturehandoff']) {
    const listener: EventListener = e => {
      const now = performance.now()
      if (name === 'captureprogress') {
        lastProgress = structuredClone((e as CustomEvent).detail)
        return
      }
      events.push({ type: name, ms: now - started, position: audio.currentTime, phase,
        ...(name === 'waiting' ? { detail: {
          readyState: audio.readyState, buffered: Array.from({ length: audio.buffered.length }, (_, i) => ({ start: audio.buffered.start(i), end: audio.buffered.end(i) })),
          progress: captureProgress(audio),
        } } : ('detail' in e) ? { detail: (e as CustomEvent).detail } : {}) })
      if (name === 'playing') {
        firstPlaying ??= now
        if (phase === 'startup') phase = 'listening'
        if (waiting) { waiting.endMs = now - started; waiting = null }
      }
      if (name === 'ended') {
        ended ??= now
        endedPosition = audio.currentTime
        endedBuffered = Array.from({ length: audio.buffered.length }, (_, i) => ({ start: audio.buffered.start(i), end: audio.buffered.end(i) }))
        if (closeOnEnd) close()
      }
      if (name === 'waiting' && firstPlaying !== null) {
        allPlaybackStalls.push({ ms: now - started, position: audio.currentTime, phase, paused: audio.paused,
          seeking: audio.seeking, ended: audio.ended,
          label: phase === 'seek' ? 'seek-preparation' : phase === 'backfill' ? 'backfill-playback-wait' : 'playback-wait' })
      }
      // stalled alone reports a network condition; waiting is the audible underrun event.
      if (name === 'waiting' && firstPlaying !== null && (phase === 'listening' || phase === 'tail') &&
          !audio.seeking && !audio.paused && !audio.ended && !waiting) {
        waiting = { startMs: now - started, position: audio.currentTime, phase }; gaps.push(waiting)
      }
    }
    // DOM dispatch invokes target capture listeners before onended can advance or rewind the player.
    const capture = name === 'ended'
    listeners.push([name, listener, capture]); audio.addEventListener(name, listener, capture)
  }
  return {
    events, gaps, allPlaybackStalls, close,
    get firstPlaying() { return firstPlaying }, get ended() { return ended },
    get progress() { return lastProgress }, get endedBuffered() { return endedBuffered }, get endedPosition() { return endedPosition },
    phase(value: Phase) { phase = value; waiting = null },
  }
}

const adTime = (s: Status | null) => typeof s?.adMs === 'number' && s.adMs >= 0 ? s.adMs : null
function checkAds(row: Row, s: Status | null) {
  row.adsSeen = s?.adsSeen ?? null
  row.adsDelivered = s?.adsDelivered ?? null
  row.adMs = adTime(s)
  row.adRateViolations = s?.adRateViolations ?? null
  row.adRateObservations = s?.adRateObservations ?? null
  if ((s?.adsSeen ?? 0) > 0 && !(typeof s?.adRateObservations === 'number' && s.adRateObservations > 0))
    row.failures.push('Publicidad observada sin mediciones de velocidad')
  if (s?.adsDelivered !== 0) row.failures.push('Anuncios entregados: valor distinto de cero o medición no disponible')
  if (s?.adRateViolations !== 0) row.failures.push('Velocidad durante anuncios: violación o medición no disponible')
}

function checkExperiment(row: Row, s: Status | null, plan: CaptureSuitePlan) {
  row.progressiveExperiment = s?.progressiveExperiment ?? null
  if (typeof s?.progressiveExperiment !== 'boolean' || s.progressiveExperiment !== (plan.experimental !== false))
    row.failures.push('El modo experimental efectivo del proceso falta o no coincide con el plan')
}

type Verification = { ok?: boolean; complete?: boolean; anonymous?: boolean; unitsChecked?: number; comparedPackets?: number; mismatches?: unknown[]; [key: string]: unknown }
type Audit = ReturnType<typeof evidenceAudit>
/** El comparador lee TODO el ledger nativo. Ningún byte se copia a través del frontend. */
function evidenceAudit() {
  const references = new Map<string, unknown>(), checks = new Map<string, { at: number; final: boolean; result: Verification }[]>()
  const active = new Set<string>(), sessions = new Map<string, unknown[]>()
  const inFlight = new Map<string, Promise<void>>(), finalChecks = new Map<string, Promise<void>>()
  const finishing = new Set<string>(), cycles = new Map<string, number>()
  let pending: Promise<void> = Promise.resolve(), timer: ReturnType<typeof setInterval> | undefined
  const check = (id: string, final: boolean): Promise<void> => {
    if (!final && (!active.has(id) || finishing.has(id))) return Promise.resolve()
    const tasks = final ? finalChecks : inFlight, existing = tasks.get(id)
    if (existing) return existing
    if (final) { finishing.add(id); active.delete(id) }
    const cycle = cycles.get(id)
    const work = pending.then(async () => {
      if (!final) {
        // A queued periodic job may outlive its capture or be superseded by the
        // final barrier. A running job finishes; final always takes a fresh snapshot.
        if (!active.has(id) || finishing.has(id) || cycles.get(id) !== cycle) return
        const current = await status(id).catch(() => null)
        if (!current || !(Number(current.units) > 0 || Number(current.chunks) > 0)) return
        if (!active.has(id) || finishing.has(id) || cycles.get(id) !== cycle) return
      }
      let result: Verification
      try { result = await invoke<Verification>('capture_verify_check', { videoId: id, final }) }
      catch (error) { result = { ok: false, error: String(error) } }
      const history = checks.get(id) ?? []
      history.push({ at: performance.now(), final, result }); checks.set(id, history)
    })
    pending = work
    const task = work.finally(() => { if (tasks.get(id) === task) tasks.delete(id) })
    tasks.set(id, task)
    return task
  }
  return {
    async prepare(videos: CaptureCase[]) {
      for (const video of videos) if (video.id && !references.has(video.id)) {
        try { references.set(video.id, await invoke('capture_verify_prepare', { videoId: video.id, mime: null, itag: null })) }
        catch (error) { references.set(video.id, { ok: false, error: String(error) }) }
      }
      timer = setInterval(() => { for (const id of active) void check(id, false) }, 10000)
    },
    start(id: string) { cycles.set(id, (cycles.get(id) ?? 0) + 1); finishing.delete(id); active.add(id) },
    async finish(id: string, row?: Row) {
      if (active.has(id) || checks.has(id)) { await check(id, true); active.delete(id) }
      if (row) {
        row.reference = references.get(id) ?? null
        row.verification = structuredClone(checks.get(id) ?? [])
        row.sessionObservations = structuredClone(sessions.get(id) ?? [])
        row.referenceEvidence = finalReferenceEvidence(row)
        row.evidenceBlockers = evidenceBlockers(row)
        row.evidenceEligible = (row.evidenceBlockers as string[]).length === 0
      }
    },
    observe(id: string, s: Status | null) {
      if (!s) return
      const history = sessions.get(id) ?? []
      const value = { generation: s.generation, revision: s.revision, epoch: s.epoch,
        sessionState: s.sessionState ?? null, sessionStates: s.sessionStates ?? null }
      if (JSON.stringify(history.at(-1)) !== JSON.stringify(value)) history.push(value)
      sessions.set(id, history)
    },
    async close() {
      clearInterval(timer)
      const remaining = [...active]
      for (const id of remaining) finishing.add(id)
      for (const id of remaining) await check(id, true)
      active.clear(); await pending
    },
    get references() { return Object.fromEntries(references) },
  }
}

/** La preparación puede fallar y recuperarse al conocer el MIME. Conservamos ambos resultados. */
function finalReferenceEvidence(row: Row) {
  const checks = row.verification as { at?: number; final: boolean; result: Verification }[] | undefined
  const last = checks?.at(-1), result = last?.result
  const hashes = result?.referenceHashes, nativeUnits = Number((row.status as Status | undefined)?.units)
  const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
  if (!last?.final || !result || typeof row.videoId !== 'string' || result.videoId !== row.videoId ||
      result.ok !== true || result.pending !== false || result.complete !== true || result.referenceComplete !== true ||
      result.anonymous !== true || result.captureAnonymous !== true || result.allPublishedUnits !== true || result.mismatchCount !== 0 ||
      !Array.isArray(result.mismatches) || result.mismatches.length ||
      checks?.some(check => (check.result.mismatches?.length ?? 0) > 0 || Number(check.result.mismatchCount) > 0) ||
      !hash(result.referenceHash) || !Array.isArray(hashes) || !hashes.length || !hashes.every(hash) || !hashes.includes(result.referenceHash) ||
      !Number.isSafeInteger(result.comparedPackets) || !(Number(result.comparedPackets) > 0) || result.matchedPackets !== result.comparedPackets ||
      !Number.isSafeInteger(nativeUnits) || nativeUnits <= 0 || result.unitsCheckedSnapshot !== nativeUnits ||
      !Number.isSafeInteger(result.unitsChecked) || Number(result.unitsChecked) < nativeUnits) return null
  return { source: 'final-verification', checkedAt: last.at ?? null, videoId: row.videoId,
    referenceHash: result.referenceHash, referenceHashes: [...hashes], anonymousTransport: true, complete: true }
}

/** Estos requisitos pertenecen a esta ejecución; no constituyen garantía universal. */
export function evidenceBlockers(row: Row): string[] {
  const reasons: string[] = [], reference = row.reference as Record<string, unknown> | null
  // Recalcular desde el último check evita aceptar un referenceEvidence obsoleto o de otra fila.
  if ((reference?.ok !== true || reference.anonymousTransport !== true) && !finalReferenceEvidence(row))
    reasons.push('Referencia independiente anónima no verificada')
  const checks = row.verification as { final: boolean; result: Verification }[] | undefined
  const last = checks?.at(-1)
  const nativeUnits = Number((row.status as Status | undefined)?.units)
  if (!last?.final || last.result.ok !== true || last.result.complete !== true || last.result.anonymous !== true ||
      last.result.captureAnonymous !== true || last.result.mismatchCount !== 0 ||
      last.result.allPublishedUnits !== true || !(Number(last.result.unitsChecked) > 0) || !(Number(last.result.comparedPackets) > 0) ||
      !Array.isArray(last.result.mismatches) || last.result.mismatches.length ||
      checks?.some(check => (check.result.mismatches?.length ?? 0) > 0 || Number(check.result.mismatchCount) > 0))
    reasons.push('No están comparadas todas las unidades entregadas')
  if (!Number.isSafeInteger(nativeUnits) || nativeUnits <= 0 || last?.result.unitsCheckedSnapshot !== nativeUnits ||
      Number(last?.result.unitsChecked) < nativeUnits)
    reasons.push('El total de unidades comparadas no coincide con el ledger final')
  const observations = row.sessionObservations as { sessionState?: Record<string, unknown> | null; sessionStates?: unknown }[] | undefined
  const validSession = (s: Record<string, unknown> | null | undefined) => !!s &&
    ['unknown', 'signed-out', 'signed-in'].includes(String(s.state)) && typeof s.profileId === 'string' && !!s.profileId &&
    typeof s.observedAt === 'number' && Number.isFinite(s.observedAt) && s.observedAt >= 0 && s.evidenceVersion === 1
  if (!observations?.length || observations.at(-1)?.sessionState?.state !== 'signed-out' ||
      observations.some(value => !validSession(value.sessionState) || value.sessionState?.state === 'signed-in'))
    reasons.push('Sesión de captura sin prueba de usuario desconectado')
  // El arranque registra unknown antes de observar la página. Lo entregado se acredita
  // por cada unidad del comparador y los contadores persistentes, no por ese estado inicial.
  // Un período autenticado, incluso sin entrega, sí invalida este ensayo anónimo.
  if (!observations?.length || observations.some(value => !Array.isArray(value.sessionStates) || !value.sessionStates.length ||
      value.sessionStates.some((s: Record<string, unknown>) => !validSession(s) || s.state === 'signed-in') ||
      value.sessionStates.at(-1)?.state !== value.sessionState?.state))
    reasons.push('Historial anónimo de todas las sesiones ausente o inconcluso')
  const finalStatus = row.status as Status | undefined
  if (finalStatus?.unknownAuthUnits !== 0 || finalStatus?.signedInUnits !== 0)
    reasons.push('Unidades entregadas con sesión desconocida o autenticada, o contadores ausentes')
  if (row.complete !== true || row.coverageOk !== true || row.completeNotExercised === true)
    reasons.push('EOF y cobertura completa no demostrados')
  return reasons
}

function adTelemetry(row: Row, s: Status | null) {
  let diagnostic: Record<string, unknown> | null = null
  try { diagnostic = typeof s?.lastDiagnostic === 'string' ? JSON.parse(s.lastDiagnostic) : null } catch { /* Datos opacos preservados en status. */ }
  row.adTelemetry = {
    skip: diagnostic?.skip ?? null, holdbackSeconds: s?.holdbackSeconds ?? diagnostic?.holdbackSeconds ?? null,
    unskippableAdMs: s?.unskippableAdMs ?? null, skippedAds: s?.skippedAds ?? null,
    adTransitions: s?.adTransitions ?? null, independentSignalDelayMs: null,
    interpretation: 'Un click confiable confirma entrada nativa; sólo una transición observada confirma el efecto. No-match no demuestra anuncio no omitible.',
  }
}

async function smoke(video: CaptureCase, plan: CaptureSuitePlan, checkpoint: (row: Row) => Promise<unknown>, audit: Audit): Promise<Row> {
  const row: Row = { label: video.label, videoId: video.id, ok: false, failures: [], phase: 'starting' }
  await checkpoint(row)
  if (timingOnly(plan)) {
    row.scope = 'timingOnly'; row.completeNotExercised = true; row.coverageNotExercised = true
  }
  if (!video.id || video.error) { row.failures.push(video.error ?? 'No hay ID elegido'); row.phase = 'finished'; return row }
  const audio = new Audio(), observed = observeAudio(audio)
  audio.muted = true; audio.preload = 'auto'
  let t = performance.now()
  const timeout = (plan.timeoutSeconds ?? 360) * 1000
  let stop = () => {}, latest: Status | null = null, readerStarted = false
  const check = () => {
    if (audio.error) throw new Error(`Audio ${audio.error.code}: ${audio.error.message}`)
    const fatal = observed.events.find(event => event.type === 'captureerror')
    if (fatal) throw new Error(String(fatal.detail ?? 'La captura falló'))
  }
  try {
    await audit.finish(video.id)
    audit.start(video.id)
    t = performance.now()
    await within(invoke('capture_begin', { videoId: video.id, refresh: true, foreground: true }), t + timeout)
    stop = playCapture(audio, video.id); readerStarted = true
    await within(waitForCaptureReady(audio), t + timeout)
    const play = audio.play(); play.catch(() => {})
    await until(() => observed.firstPlaying !== null && audio.currentTime > 0, t + timeout, check)
    await play
    latest = await status(video.id)
    audit.observe(video.id, latest)
    checkExperiment(row, latest, plan)
    const firstSoundMs = observed.firstPlaying! - t, advertisementMs = adTime(latest)
    row.startStatus = structuredClone(latest); row.startAdMs = advertisementMs
    row.firstSoundMs = firstSoundMs
    row.firstSoundWithoutAdMs = advertisementMs === null ? null : firstSoundMs - advertisementMs
    if (advertisementMs !== null && advertisementMs > firstSoundMs + 1)
      row.failures.push('El tiempo publicitario excede la ventana medida de primer sonido')
    row.initialProgress = captureProgress(audio)
    row.phase = 'first-sound'; await checkpoint(row)
    if (plan.experimental !== false && (advertisementMs === null || firstSoundMs - advertisementMs > LIMITS.firstSoundMs))
      row.failures.push(`Primer sonido supera ${LIMITS.firstSoundMs} ms tras descontar publicidad medida`)
    const duration = latest?.duration ?? audio.duration
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Duración nativa no disponible')
    row.duration = duration
    if (plan.seek !== false) {
      const target = duration * 0.8
      const before = captureProgress(audio)
      const wasCaptured = covers(before?.ranges ?? [], target, 0.1)
      row.seekTarget = target; row.seekWasCaptured = wasCaptured; row.seekBefore = before
      observed.phase('seek')
      row.phase = 'seeking'; await checkpoint(row)
      const seekStarted = performance.now()
      try {
        const seeked = await within(seekCapture(audio, target), seekStarted + timeout)
        if (!seeked) throw new Error('El salto no pudo preparar el destino')
        await until(() => audio.currentTime > target + 0.04 && !audio.seeking, seekStarted + timeout, check)
        row.seekOk = true
      } catch (error) {
        row.seekOk = false; row.seekError = String(error)
        row.failures.push(`Salto no completado: ${error}`)
      }
      row.seekMs = performance.now() - seekStarted
      row.seekStatus = await status(video.id).catch(() => latest)
      row.seekAfter = captureProgress(audio)
      observed.phase('backfill')
      row.phase = 'backfill'; await checkpoint(row)
      if (plan.experimental !== false && wasCaptured) row.failures.push('El caso no ejerció un salto a zona aún no capturada')
      if (plan.experimental !== false && (row.seekMs as number) > LIMITS.seekMs) row.failures.push('Salto al 80% supera 1 s')
    }
    if (timingOnly(plan)) {
      row.scope = 'timingOnly'; row.completeNotExercised = true; row.coverageNotExercised = true
      row.phase = 'latency-sample'; await checkpoint(row)
      const from = audio.currentTime
      await until(() => audio.currentTime >= from + 1, performance.now() + 10000, check)
      row.sampleProgressSeconds = audio.currentTime - from
      latest = await status(video.id)
      row.status = latest; row.finalStatus = structuredClone(latest)
      checkAds(row, latest)
    } else {
    row.scope = plan.experimental === false ? 'full-quarantine' : 'complete'; row.completeNotExercised = false
    const deadline = performance.now() + Math.max(timeout, duration * 1000 + 180000)
    let lastCheckpoint = performance.now()
    while (performance.now() < deadline) {
      check(); latest = await status(video.id)
      audit.observe(video.id, latest)
      if (!latest) throw new Error('La captura desapareció antes de verificarse')
      if (latest.complete) break
      if (latest.error && !latest.softError) throw new Error(String(latest.error))
      if (performance.now() - lastCheckpoint >= 15000) {
        row.latestStatus = structuredClone(latest); row.progress = captureProgress(audio) ?? observed.progress
        row.live = liveAudio(audio, t); row.elapsedMs = performance.now() - t
        await checkpoint(row); lastCheckpoint = performance.now()
      }
      await sleep(250)
    }
    row.status = latest; row.finalStatus = structuredClone(latest)
    const finalDuration = latest?.audioDuration ?? latest?.eofEnd ?? observed.progress?.audioDuration
    row.audioDuration = finalDuration ?? null
    if (!Number.isFinite(finalDuration) || !finalDuration || finalDuration <= 0) throw new Error('No hay extremo de audio verificado por EOF')
    row.complete = latest?.complete === true
    if (!latest?.complete) row.failures.push('No terminó la verificación completa de la canción')
    await until(() => continuous(captureProgress(audio)?.buffered ?? [], finalDuration), performance.now() + 15000, check)
    row.coverage = captureProgress(audio)
    row.coverageOk = continuous(captureProgress(audio)?.buffered ?? [], finalDuration)
    if (!row.coverageOk) row.failures.push('Cobertura final con huecos o extremos ausentes')
    row.phase = 'coverage'; await checkpoint(row)
    // Repetir el final verifica la decodificación aunque el primer ended precediese al backfill.
    observed.phase('seek')
    audio.pause()
    if (!await seekCapture(audio, Math.max(0, finalDuration - 0.5))) throw new Error('No se pudo preparar el último intervalo')
    await audio.play()
    observed.phase('tail')
    row.phase = 'tail'; await checkpoint(row)
    const tailStart = performance.now()
    await until(() => audio.ended, tailStart + 10000, check)
    row.tailMs = performance.now() - tailStart
    if (audio.currentTime < finalDuration - 0.000001) row.failures.push('El audio terminó antes del último intervalo')
    checkAds(row, latest)
    }
  } catch (error) {
    row.failures.push(String(error))
    latest = await status(video.id).catch(() => latest)
    row.status = latest; checkAds(row, latest)
  } finally {
    audit.observe(video.id, latest); adTelemetry(row, latest)
    await audit.finish(video.id, row)
    row.phase = 'finished'; row.elapsedMs = performance.now() - t; row.events = observed.events; row.gaps = observed.gaps
    row.allPlaybackStalls = observed.allPlaybackStalls
    row.backfillWaiting = observed.events.filter(event => event.type === 'waiting' && (event.phase === 'seek' || event.phase === 'backfill'))
    if (observed.gaps.length) row.failures.push(`${observed.gaps.length} episodios de espera durante reproducción`)
    observed.close(); stop(); audio.pause(); audio.removeAttribute('src'); audio.load()
    if (!readerStarted) await invoke('capture_cancel', { videoId: video.id }).catch(() => {})
  }
  row.ok = row.failures.length === 0
  return row
}

function cases(corpus: Corpus): CaptureCase[] {
  return corpus.albums.flatMap(album => Array.from({ length: album.expectedTracks }, (_, i) => album.rows?.[i] ??
    { label: `${album.query} / pista ${i + 1}`, duration: 0, error: album.error ?? 'Pista ausente de la muestra' }))
}

function queueItem(video: CaptureCase): QueueItem | null {
  return video.track && video.albumId !== undefined && video.albumTitle !== undefined && video.artistId !== undefined
    ? { track: video.track, albumId: video.albumId, albumTitle: video.albumTitle, artistId: video.artistId, cover: video.cover ?? null }
    : null
}

/** Escuchar play antes de invocar el método nativo evita perder una promoción entre dos polls. */
function watchPlayerPlay(beforePlay: (audio: HTMLAudioElement) => void) {
  const prototype = HTMLMediaElement.prototype, original = prototype.play
  const wrapped = function (this: HTMLMediaElement) {
    if (this === player.playbackAudio || player.preparedAudios?.some(entry => entry.audio === this) || this === player.preparedAudio)
      beforePlay(this as HTMLAudioElement)
    return original.call(this)
  }
  prototype.play = wrapped
  return () => { if (prototype.play === wrapped) prototype.play = original }
}

/** Usa el reproductor real, su precarga y ended natural; nunca adelanta una pista correcta. */
async function album(videos: CaptureCase[], plan: CaptureSuitePlan, checkpoint: (rows: Row[]) => Promise<unknown>, audit: Audit): Promise<Row[]> {
  const rows: Row[] = videos.map(v => ({ label: v.label, videoId: v.id, ok: false, failures: [], phase: 'pending' }))
  const playable: { video: CaptureCase & { id: string }; item: QueueItem; index: number }[] = []
  for (const [index, video] of videos.entries()) {
    const item = queueItem(video)
    try {
      if (video.error || !video.id || !item) throw new Error(video.error ?? 'La muestra no contiene una canción reproducible')
      if (plan.engine === 'propio') {
        rows[index].coldSearchReset = await invoke('capture_bench_native_search', { track: toQuery(item), videoId: video.id })
        rows[index].searchIncluded = true
      } else await api.rememberSource(toQuery(item), video.id)
      playable.push({ video: video as CaptureCase & { id: string }, item, index })
    } catch (error) { rows[index].failures.push(String(error)); rows[index].phase = 'finished' }
  }
  await checkpoint(rows)
  if (!playable.length) return rows
  const observers = new Map<number, { audio: HTMLAudioElement; observed: ReturnType<typeof observeAudio> }>()
  const byAudio = new Map<HTMLAudioElement, number>()
  const install = (audio: HTMLAudioElement | null, position: number) => {
    if (!audio || !playable[position]) return
    if (observers.get(position)?.audio === audio) return
    const oldPosition = byAudio.get(audio)
    if (oldPosition !== undefined && oldPosition !== position) observers.get(oldPosition)?.observed.close()
    const previous = observers.get(position)
    if (previous) {
      previous.observed.close()
      rows[playable[position].index].preparationEvents = previous.observed.events
    }
    observers.set(position, { audio, observed: observeAudio(audio, true) })
    byAudio.set(audio, position)
  }
  const watch = () => {
    if (player.current?.track.id === playable[player.pos]?.item.track.id) install(player.playbackAudio, player.pos)
    if (player.preparedAudios) for (const entry of player.preparedAudios) {
      const position = playable.findIndex((value, index) => index > player.pos && value.item.track.id === entry.trackId)
      if (position >= 0) install(entry.audio, position)
    }
    else install(player.preparedAudio, player.pos + 1)
  }
  const unhook = watchPlayerPlay(audio => install(audio, player.pos))
  const timer = setInterval(watch, 10)
  let previousEnded: number | null = null
  try {
    const albumStart = performance.now()
    if (plan.engine !== 'propio') for (const entry of playable) audit.start(entry.video.id)
    player.playQueue(playable.map(e => e.item), 0)
    watch()
    for (const [position, entry] of playable.entries()) {
      const row = rows[entry.index], began = performance.now()
      let latest: Status | null = null
      const checkTerminal = (audio?: HTMLAudioElement, observed?: ReturnType<typeof observeAudio>) => {
        const reason = terminalCaptureFailure(latest)
        if (!reason) return
        row.terminalCapture = { reason, elapsedMs: performance.now() - began, status: structuredClone(latest),
          live: audio ? liveAudio(audio, began) : null, progress: (audio ? captureProgress(audio) : null) ?? observed?.progress ?? null }
        row.complete = false
        throw new Error(`Captura incompleta: recuperación automática detenida (${reason})`)
      }
      row.phase = 'starting'; await checkpoint(rows)
      try {
        await until(() => {
          watch()
          // Una comparación de la pista anterior puede terminar después de que ésta
          // ya haya sonado; el observador enlazado antes de play conserva la prueba.
          return observers.get(position)?.observed.firstPlaying != null
        }, began + (plan.timeoutSeconds ?? 360) * 1000, () => {
          if (player.pos > position) throw new Error('Musify saltó la pista tras un fallo')
          if (observers.get(position)?.observed.events.some(e => e.type === 'captureerror')) throw new Error('La captura falló antes del primer sonido')
        }, async () => {
          const watched = observers.get(position)
          latest = plan.engine === 'propio' && (!watched || !captureProgress(watched.audio)) ? null :
            await status(entry.video.id).catch(() => latest)
          audit.observe(entry.video.id, latest)
          checkTerminal(watched?.audio, watched?.observed)
        }, 1000)
        const { audio, observed } = observers.get(position)!
        latest = plan.engine === 'propio' && !captureProgress(audio) ? null : await status(entry.video.id)
        audit.observe(entry.video.id, latest)
        if (plan.engine !== 'propio') checkExperiment(row, latest, plan)
        row.startStatus = latest
        row.selectedSource = player.playbackSource
        row.legacyCapture = player.playbackSource?.kind === 'capture-legacy'
        if (plan.engine === 'propio' && player.playbackSource?.trackId === entry.item.track.id &&
            player.playbackSource.videoId !== entry.video.id)
          row.failures.push('La búsqueda eligió un vídeo distinto del esperado por el corpus')
        row.firstSoundMs = observed.firstPlaying! - (position === 0 ? albumStart : previousEnded ?? began)
        if (position === 0) {
          const adMs = row.legacyCapture ? null : plan.engine === 'propio' ? 0 : adTime(latest)
          row.firstSoundWithoutAdMs = adMs === null ? null : (row.firstSoundMs as number) - adMs
          row.startAdMs = adMs
          if (adMs !== null && adMs > (row.firstSoundMs as number) + 1) row.failures.push('El tiempo publicitario excede la ventana medida de primer sonido')
          const firstLimit = plan.engine === 'propio' ? NATIVE_LIMITS.firstSoundMs : LIMITS.firstSoundMs
          if (plan.experimental !== false && (adMs === null || (row.firstSoundWithoutAdMs as number) > firstLimit)) row.failures.push(`Primer sonido supera ${firstLimit} ms más anuncio medido`)
        } else {
          row.nextTrackMs = previousEnded === null ? null : observed.firstPlaying! - previousEnded
          const nextLimit = plan.engine === 'propio' ? NATIVE_LIMITS.nextTrackMs : LIMITS.nextTrackMs
          if (previousEnded === null || (row.nextTrackMs as number) < 0 || (plan.experimental !== false && (row.nextTrackMs as number) > nextLimit))
            row.failures.push(`Transición natural ausente, solapada o superior a ${nextLimit} ms`)
        }
        row.initialProgress = captureProgress(audio) ?? observed.progress
        row.phase = 'listening'; await checkpoint(rows)
        const duration = latest?.duration ?? audio.duration
        row.duration = duration
        let lastCheckpoint = performance.now()
        await until(() => observed.ended !== null, performance.now() + Math.max((plan.timeoutSeconds ?? 360) * 1000,
          (Number.isFinite(duration) ? duration : entry.video.duration) * 1000 + 180000), () => {
          if (audio.error) throw new Error(`Audio ${audio.error.code}: ${audio.error.message}`)
          if (observed.events.some(e => e.type === 'captureerror')) throw new Error('Captura detenida antes del final')
          if (player.pos > position && observed.ended === null) throw new Error('Cambio de pista sin ended natural')
          checkTerminal(audio, observed)
        }, async () => {
          latest = plan.engine === 'propio' && !captureProgress(audio) ? null : await status(entry.video.id).catch(() => latest)
          audit.observe(entry.video.id, latest)
          checkTerminal(audio, observed)
          if (performance.now() - lastCheckpoint >= 15000) {
            row.latestStatus = structuredClone(latest); row.progress = captureProgress(audio) ?? observed.progress
            row.live = liveAudio(audio, began); row.elapsedMs = performance.now() - began
            await checkpoint(rows); lastCheckpoint = performance.now()
          }
        }, 1000)
        previousEnded = observed.ended
        const progress = observed.progress ?? captureProgress(audio)
        const nativeDirect = plan.engine === 'propio' && (row.selectedSource as { kind?: string } | null)?.kind === 'network'
        const legacyCapture = row.legacyCapture === true
        latest = nativeDirect || legacyCapture ? null : await status(entry.video.id).catch(() => latest)
        row.nativeDirect = nativeDirect
        const audioDuration = nativeDirect || legacyCapture ? audio.duration : latest?.audioDuration ?? latest?.eofEnd ?? progress?.audioDuration
        row.status = latest; row.coverage = progress; row.audioDuration = audioDuration ?? null
        row.endedObserved = observed.ended !== null
        row.endedPosition = observed.endedPosition; row.endedBuffered = observed.endedBuffered
        row.complete = legacyCapture ? false : nativeDirect ? observed.ended !== null : latest?.complete === true || progress?.complete === true
        const finalBuffered = observed.endedBuffered ?? progress?.buffered ?? []
        row.coverageOk = nativeDirect ? directPlaybackCoverage(finalBuffered, audioDuration ?? NaN) : continuous(finalBuffered, audioDuration ?? NaN)
        if (legacyCapture) {
          row.completeNotExercised = true
          row.failures.push('Respaldo legacy: ended y cobertura del consumidor observados; EOF, anuncios y velocidad de la captura sin auditoría API4')
        }
        if (!row.complete) row.failures.push('EOF sin verificación completa')
        if (!row.coverageOk) row.failures.push('Cobertura final ausente o con huecos')
        if (!Number.isFinite(audioDuration) || observed.endedPosition === null || observed.endedPosition < (audioDuration ?? Infinity) - 0.000001)
          row.failures.push('Ended anterior al extremo de audio verificado')
        row.events = observed.events; row.gaps = observed.gaps
        row.allPlaybackStalls = observed.allPlaybackStalls
        if (observed.gaps.length) row.failures.push(`${observed.gaps.length} cortes durante escucha normal`)
        if (!nativeDirect && !legacyCapture) checkAds(row, latest)
      } catch (error) {
        row.failures.push(String(error)); row.status = latest ?? await status(entry.video.id).catch(() => null)
        const watched = observers.get(position)
        row.events = watched?.observed.events ?? []; row.gaps = watched?.observed.gaps ?? []
        row.allPlaybackStalls = watched?.observed.allPlaybackStalls ?? []
        row.coverage = watched?.observed.progress ?? null
        row.endedObserved = watched?.observed.ended != null
        row.endedPosition = watched?.observed.endedPosition ?? null
        row.endedBuffered = watched?.observed.endedBuffered ?? null
        previousEnded = null
        if (plan.engine !== 'propio') checkAds(row, row.status as Status | null)
        // Continuar una fila fallida no permite dar por buena la transición siguiente.
        if (position + 1 < playable.length && player.pos === position) player.next()
      }
      audit.observe(entry.video.id, row.status as Status | null); adTelemetry(row, row.status as Status | null)
      await audit.finish(entry.video.id, row)
      row.elapsedMs = performance.now() - began; row.phase = 'finished'; row.ok = row.failures.length === 0
      await checkpoint(rows)
    }
  } finally {
    clearInterval(timer); unhook()
    for (const value of observers.values()) value.observed.close()
    if (player.status === 'playing' || player.status === 'loading') player.toggle()
    stopCapture()
  }
  return rows
}

/** El destino se expulsa explícitamente de la caché de banco, conservando la canción de contexto. */
async function unprepared(videos: CaptureCase[], plan: CaptureSuitePlan, checkpoint: (rows: Row[]) => Promise<unknown>, audit: Audit): Promise<Row[]> {
  const rows: Row[] = []
  type Context = { video: CaptureCase; item: QueueItem; audio: HTMLAudioElement }
  let context: Context | null = null
  const contextPlaying = (value: Context, minimumPosition = 0.2) => player.current?.track.id === value.item.track.id && player.playbackAudio === value.audio &&
    player.status === 'playing' && !value.audio.paused && !value.audio.ended && !value.audio.seeking && !value.audio.error &&
    value.audio.currentTime > minimumPosition && (captureProgress(value.audio)?.units ?? 0) > 0 && player.upcoming.length === 0 && !player.preparedAudio
  try {
    for (const video of videos) {
      const row: Row = { label: video.label, videoId: video.id, ok: false, failures: [], phase: 'context' }
      rows.push(row); await checkpoint(rows)
      const item = queueItem(video)
      if (video.error || !video.id || !item) {
        row.failures.push(video.error ?? 'El destino no tiene ID o metadatos reproducibles')
        row.phase = 'finished'; context = null; await checkpoint(rows); continue
      }
      let observed: ReturnType<typeof observeAudio> | undefined, audio: HTMLAudioElement | null = null
      let latest: Status | null = null, measuring = false
      const began = performance.now(), timeout = (plan.timeoutSeconds ?? 360) * 1000
      const unhook = watchPlayerPlay(next => {
        if (!measuring || player.current?.track.id !== item.track.id || audio === next) return
        observed?.close(); audio = next; observed = observeAudio(next)
      })
      try {
        // Sólo la primera fila (o un fallo anterior) necesita preparar un contexto.
        // Una cola de un tema impide que el reproductor precargue el siguiente destino.
        const reuse = context !== null && context.video.id !== video.id && contextPlaying(context, 0)
        row.contextReused = reuse
        if (!reuse) {
          const source = [...videos].reverse().find(candidate => candidate.id && candidate.id !== video.id && !candidate.error && queueItem(candidate))
          const sourceItem = source && queueItem(source)
          if (!source?.id || !sourceItem) throw new Error('Se necesitan dos canciones distintas con metadatos')
          row.contextVideoId = source.id; row.contextTrackId = sourceItem.track.id
          await api.rememberSource(toQuery(sourceItem), source.id)
          audit.start(source.id)
          player.playQueue([sourceItem], 0)
          await until(() => player.current?.track.id === sourceItem.track.id && contextPlaying({ video: source, item: sourceItem, audio: player.playbackAudio }),
            performance.now() + timeout, () => { if (player.playbackAudio.error) throw new Error('El audio de contexto falló') })
          context = { video: source, item: sourceItem, audio: player.playbackAudio }
        }
        const currentContext = context!
        if (reuse) await until(() => contextPlaying(currentContext), performance.now() + timeout,
          () => { if (!contextPlaying(currentContext, 0)) throw new Error('El contexto dejó de sonar antes de preparar el cambio') })
        row.contextVideoId = currentContext.video.id; row.contextTrackId = currentContext.item.track.id
        await api.rememberSource(toQuery(item), video.id)
        if (currentContext.video.id === video.id || !contextPlaying(currentContext)) throw new Error('El contexto debe seguir sonando y ser distinto del destino')
        row.destinationBeforeForget = await status(video.id)
        await audit.finish(video.id)
        await invoke('capture_bench_forget', { videoId: video.id })
        const before = await status(video.id)
        row.destinationBeforeClick = before
        row.destinationWasCached = (before?.ranges?.length ?? 0) > 0 || ['bytes', 'chunks', 'units'].some(key => typeof before?.[key] === 'number' && (before[key] as number) > 0)
        if (row.destinationWasCached) throw new Error('El destino conserva audio en caché: no es una medición en frío')
        row.phase = 'switching'; await checkpoint(rows)
        if (!contextPlaying(currentContext)) throw new Error('El contexto dejó de sonar antes del clic')
        row.contextPosition = currentContext.audio.currentTime
        row.contextBeforeClick = liveAudio(currentContext.audio, began)
        row.contextProgress = captureProgress(currentContext.audio)
        measuring = true
        const started = performance.now()
        audit.start(video.id)
        player.playQueue([item], 0)
        const checkDestination = () => {
          if (observed?.events.some(event => event.type === 'captureerror')) throw new Error('La captura falló durante el cambio')
          if (audio?.error) throw new Error(`Audio ${audio.error.code}: ${audio.error.message}`)
        }
        await until(() => observed?.firstPlaying != null && player.current?.track.id === item.track.id && player.status === 'playing' &&
          audio === player.playbackAudio && !audio.paused && !audio.ended && (audio.currentTime ?? 0) > 0, started + timeout, checkDestination)
        checkDestination()
        latest = await status(video.id)
        checkDestination()
        checkExperiment(row, latest, plan)
        const adMs = adTime(latest)
        row.startStatus = structuredClone(latest); row.startAdMs = adMs
        row.unpreparedSwitchMs = observed!.firstPlaying! - started
        row.unpreparedSwitchWithoutAdMs = adMs === null ? null : (row.unpreparedSwitchMs as number) - adMs
        if (adMs !== null && adMs > (row.unpreparedSwitchMs as number) + 1) row.failures.push('El tiempo publicitario excede la ventana medida del cambio')
        if (plan.experimental !== false && (adMs === null || (row.unpreparedSwitchWithoutAdMs as number) > LIMITS.unpreparedMs)) row.failures.push('Salto a canción no preparada supera 3 s más anuncio')
        row.status = latest; checkAds(row, latest)
        context = { video, item, audio: audio! }
      } catch (error) {
        row.failedPhase = row.phase
        row.failures.push(String(error)); latest = await status(video.id).catch(() => latest)
        row.status = latest; checkAds(row, latest)
      } finally {
        audit.observe(video.id, latest); adTelemetry(row, latest)
        await audit.finish(video.id, row)
        row.phase = 'finished'; row.elapsedMs = performance.now() - began
        row.events = observed?.events ?? []; row.gaps = observed?.gaps ?? []
        row.allPlaybackStalls = observed?.allPlaybackStalls ?? []
        observed?.close(); unhook()
      }
      row.ok = row.failures.length === 0
      if (!row.ok) context = null
      await checkpoint(rows)
    }
  } finally {
    if (player.status === 'playing' || player.status === 'loading') player.toggle()
    stopCapture()
  }
  return rows
}

/** Cada intento usa el player normal y una búsqueda sin asociación ni caché antes del reloj. */
async function nativeSearch(videos: CaptureCase[], plan: CaptureSuitePlan, checkpoint: (rows: Row[]) => Promise<unknown>): Promise<Row[]> {
  const rows: Row[] = []
  try {
    for (const video of videos) {
      const row: Row = { label: video.label, videoId: video.id, ok: false, failures: [], phase: 'resetting-search',
        searchIncluded: true, completeNotExercised: true, coverageNotExercised: true }
      rows.push(row); await checkpoint(rows)
      let observed: ReturnType<typeof observeAudio> | undefined, audio: HTMLAudioElement | null = null
      let started: number | null = null
      const unhook = watchPlayerPlay(value => {
        if (started === null || audio === value) return
        observed?.close(); audio = value; observed = observeAudio(value)
      })
      try {
        const item = queueItem(video)
        if (!item || !video.id || video.error) throw new Error(video.error ?? 'Faltan metadatos para la búsqueda')
        row.coldSearchReset = await invoke('capture_bench_native_search', { track: toQuery(item), videoId: video.id })
        row.phase = 'searching'; await checkpoint(rows)
        started = performance.now()
        player.playQueue([item], 0)
        await until(() => observed?.firstPlaying != null && audio === player.playbackAudio && !audio.paused && audio.currentTime > 0,
          started + (plan.timeoutSeconds ?? 120) * 1000, () => {
            if (audio?.error || observed?.events.some(event => event.type === 'captureerror')) throw new Error('Falló la reproducción tras la búsqueda')
          })
        row.firstSoundMs = observed!.firstPlaying! - started
        row.selectedSource = player.playbackSource
        if (player.playbackSource?.videoId && player.playbackSource.videoId !== video.id)
          row.failures.push('La búsqueda eligió un vídeo distinto del esperado por el corpus')
        row.initialProgress = captureProgress(audio!)
        row.nativeDirect = player.playbackSource?.kind === 'network'
        row.legacyCapture = player.playbackSource?.kind === 'capture-legacy'
        row.fallbackCapture = player.playbackSource?.kind === 'capture' || row.legacyCapture === true
        if ((row.firstSoundMs as number) > NATIVE_LIMITS.firstSoundMs) row.failures.push('Búsqueda e inicio de audio superan 300 ms')
        row.status = row.nativeDirect || row.legacyCapture ? null : await status(video.id).catch(() => null)
        row.phase = 'first-sound'; await checkpoint(rows)
      } catch (error) { row.failures.push(String(error)) }
      finally {
        row.events = observed?.events ?? []; row.gaps = observed?.gaps ?? []; row.allPlaybackStalls = observed?.allPlaybackStalls ?? []
        row.elapsedMs = started === null ? null : performance.now() - started
        observed?.close(); unhook()
        if (player.status === 'playing' || player.status === 'loading') player.toggle()
        stopCapture()
      }
      row.phase = 'finished'; row.ok = row.failures.length === 0
      row.evidenceEligible = false; row.evidenceBlockers = ['Esta fase sólo mide búsqueda e inicio; no verifica escucha completa ni todos los paquetes']
      await checkpoint(rows)
    }
  } finally {
    if (player.status === 'playing' || player.status === 'loading') player.toggle()
    stopCapture()
  }
  return rows
}

/** El marcador nativo queda ligado a la generación/época/fuente que originó cada transición. */
export function adTransitionCounts(rows: Row[]): { observed: number; qualified: number; unqualified: number } {
  const observations = new Map<string, { transition: Record<string, unknown>; marker: string | null }[]>()
  for (const row of rows) {
    const s = row.status as Status | undefined
    if (!Array.isArray(s?.adTransitions)) continue
    for (const transition of s.adTransitions as Record<string, unknown>[]) {
      if (!transition || typeof row.videoId !== 'string' || !row.videoId ||
          transition.from !== 'ad' || transition.to !== 'content' || transition.observed !== true ||
          ![transition.generation, transition.epoch, transition.source].every(value => Number.isSafeInteger(value) && Number(value) > 0) ||
          !Number.isSafeInteger(transition.sequence) || Number(transition.sequence) < 0) continue
      const identity = JSON.stringify([row.videoId, transition.generation, transition.epoch, transition.source, transition.sequence])
      const marker = transition.markerObserved === true && transition.markerPlaybackRate === 1 &&
        Number.isSafeInteger(transition.markerSequence) && Number(transition.markerSequence) >= 0 &&
        Number(transition.markerSequence) < Number(transition.sequence) &&
        Number.isSafeInteger(transition.contentSource) && Number(transition.contentSource) > 0 ?
        JSON.stringify([row.videoId, transition.generation, transition.epoch, transition.markerSequence]) : null
      const copies = observations.get(identity) ?? []
      copies.push({ transition, marker }); observations.set(identity, copies)
    }
  }
  // Snapshots can repeat the same transition. One diagnostic sequence, however,
  // cannot certify two transitions or sources in its native document/epoch.
  const markerClaims = new Map<string, Set<string>>()
  for (const [identity, copies] of observations) for (const { marker } of copies) {
    if (!marker) continue
    const claims = markerClaims.get(marker) ?? new Set<string>()
    claims.add(identity); markerClaims.set(marker, claims)
  }
  let qualified = 0
  for (const copies of observations.values()) {
    const first = copies[0]
    if (first.marker && markerClaims.get(first.marker)?.size === 1 && copies.every(copy =>
      copy.marker === first.marker && copy.transition.contentSource === first.transition.contentSource)) qualified++
  }
  return { observed: observations.size, qualified, unqualified: observations.size - qualified }
}

/** Sólo las transiciones con marcador propio observado a 1× cuentan para la cohorte. */
export const distinctAdTransitions = (rows: Row[]): number => adTransitionCounts(rows).qualified

function reportAdTransitions(report: Record<string, unknown>, rows: Row[]) {
  const counts = adTransitionCounts(rows)
  report.adTransitions = counts.qualified
  report.adTransitionsObserved = counts.observed
  report.adTransitionsUnqualified = counts.unqualified
}

export function acceptanceCriteria(rows: Row[], expectedTracks: number, requiredAds = 50, engine: 'oficial' | 'propio' = 'oficial'): string[] {
  const missing: string[] = []
  const completeIds = new Set(rows.filter(row => row.ok && row.evidenceEligible === true).map(row => row.videoId))
  if (completeIds.size < Math.max(30, expectedTracks)) missing.push(`Canciones distintas completas y verificadas: ${completeIds.size}/${Math.max(30, expectedTracks)}`)
  const transitions = distinctAdTransitions(rows)
  if (transitions < requiredAds) missing.push(`Transiciones con marcador publicitario propio observado a 1×: ${transitions}/${requiredAds}`)
  if (!rows.length || rows.some(row => !row.ok)) missing.push('Hay intentos fallidos o no medidos en esta cohorte')
  if (rows.some(row => row.evidenceEligible !== true)) missing.push('Falta comparación independiente, sesión anónima o cobertura en algún intento')
  const seekIds = new Set(rows.filter(row => row.seekOk === true && row.seekWasCaptured === false &&
    typeof row.seekMs === 'number' && row.seekMs <= LIMITS.seekMs).map(row => row.videoId))
  if (seekIds.size < 30) missing.push(`Saltos a zona no capturada en menos de 1 s: ${seekIds.size}/30 canciones distintas`)
  const natural = rows.filter(row => typeof row.nextTrackMs === 'number')
  const nextLimit = engine === 'propio' ? NATIVE_LIMITS.nextTrackMs : LIMITS.nextTrackMs
  if (natural.length < 25 || natural.some(row => (row.nextTrackMs as number) < 0 || (row.nextTrackMs as number) > nextLimit))
    missing.push(`Faltan al menos 25 transiciones naturales de ${nextLimit} ms o menos sin solapamiento`)
  // adMs sólo acredita observación, no que esa espera fuese inevitable.
  if (rows.some(row => {
    const elapsed = row.firstSoundMs ?? row.unpreparedSwitchMs
    if (typeof elapsed !== 'number' || elapsed <= LIMITS.firstSoundMs) return false
    const credit = (row.adTelemetry as Record<string, unknown> | undefined)?.unskippableAdMs
    return typeof credit !== 'number' || credit < 0 || credit > elapsed || elapsed - credit > LIMITS.firstSoundMs
  })) missing.push('Inicio de 3 s más espera publicitaria no omitible no demostrado')
  return missing
}

export async function runCaptureSuite(plan: CaptureSuitePlan, checkpoint: (report: Record<string, unknown>) => Promise<unknown>) {
  if (plan.mode === 'profile-login') {
    const report: Record<string, unknown> = { mode: plan.mode, scope: 'manual-reference-profile-setup', running: true,
      ok: false, acceptanceOk: false, profileId: null, state: 'waiting', loggedIn: false }
    await checkpoint(report)
    try {
      await invoke('capture_profile_open', { mode: 'premium-manual' })
      const deadline = performance.now() + (plan.timeoutSeconds ?? 1200) * 1000
      let lastCheckpoint = -Infinity
      while (performance.now() < deadline) {
        const s = await invoke<{ profileId?: string; state?: string; loggedIn?: boolean; sessionState?: { profileId?: string; state?: string } }>('capture_profile_status')
        const auth = s.sessionState ?? s
        report.profileId = typeof auth.profileId === 'string' ? auth.profileId : null
        report.state = auth.state === 'signed-in' || auth.state === 'signed-out' ? auth.state : 'unknown'
        report.loggedIn = s.loggedIn === true
        if (s.loggedIn === true) { report.ok = true; break }
        if (performance.now() - lastCheckpoint >= 15000) { await checkpoint(report); lastCheckpoint = performance.now() }
        await sleep(2000)
      }
      if (!report.ok) report.state = 'timeout'
    } catch { report.state = 'unavailable' }
    report.running = false; await checkpoint(report); return report
  }
  if (plan.mode === 'native-search') plan = { ...plan, engine: 'propio' }
  const corpus = plan.corpus ?? (!plan.videos ? await invoke<Corpus>('capture_bench_catalog') : undefined)
  const videos = plan.videos ?? (corpus ? cases(corpus) : [])
  const report: Record<string, unknown> = {
    schema: 2, mode: plan.mode, engine: plan.engine ?? 'oficial', corpus, expectedTracks: corpus?.expectedTracks ?? videos.length,
    limits: plan.experimental === false ? null : plan.engine === 'propio' ? NATIVE_LIMITS : LIMITS, timingRequirementsApplied: plan.experimental !== false,
    continuityMethod: 'waiting durante escucha normal y final; seek/backfill queda registrado por separado y no demuestra escucha continua de toda la canción',
    timingMethod: 'Reloj monotónico de eventos HTMLAudioElement en WebView2; audio silenciado durante medición',
    adMethod: 'Estados oficiales observados; comparación independiente de todas las unidades publicadas. La demora entre sonido y marcador no se deduce del mismo marcador.',
    adTransitionMethod: 'adTransitions cuenta sólo transiciones únicas con marcador publicitario nativo ligado a su fuente, secuencia anterior válida y velocidad 1×. adTransitionsObserved incluye también estados sin ese marcador; no demuestra semántica del audio.',
    rate: 1, rows: [] as Row[], running: true, ok: false,
    experimental: plan.mode !== 'catalog' && plan.experimental !== false, guaranteeAds: false, acceptanceOk: false,
    scope: plan.mode === 'catalog' ? 'catalog' : plan.mode === 'native-search' ? 'cold-search-and-start' : plan.experimental === false ? 'full-quarantine' : timingOnly(plan) ? 'timingOnly' : plan.mode === 'switch' ? 'cold-switch' : 'complete',
    blocking: [], referencePreparationOutsidePlaybackTimer: plan.engine !== 'propio',
  }
  await checkpoint(report)
  if (plan.mode === 'catalog') {
    report.rows = videos.map(video => ({ label: video.label, videoId: video.id, ok: !!video.id && !video.error,
      failures: video.error ? [video.error] : video.id ? [] : ['No hay ID elegido'], phase: 'finished' }))
    report.ok = videos.length === report.expectedTracks && videos.every(v => v.id && !v.error)
    report.running = false; await checkpoint(report); return report
  }
  const rows = report.rows as Row[]
  const audit = evidenceAudit()
  try {
  if (plan.engine !== 'propio') {
    report.phase = 'preparing-independent-references'; await checkpoint(report)
    await audit.prepare(videos); report.references = audit.references
    report.phase = 'measuring'; await checkpoint(report)
  }
  if (plan.mode === 'album' || plan.mode === 'switch' || plan.mode === 'native-search') {
    const volume = player.volume, engine = extractor.engine, shuffle = player.shuffle, repeat = player.repeat
    try {
      player.setVolume(0); player.shuffle = false; player.repeat = 'off'; player.clearQueue()
      await extractor.set(plan.engine ?? 'oficial')
      if (plan.mode === 'album') {
        const groups = corpus?.albums.map(a => cases({ source: corpus.source, expectedTracks: a.expectedTracks, albums: [a] })) ?? [videos]
        for (const group of groups) {
          const previous = rows.slice()
          const finished = await album(group, plan, partial => { report.rows = [...previous, ...partial]; return checkpoint(report) }, audit)
          rows.push(...finished); report.rows = rows; await checkpoint(report)
        }
      } else if (plan.mode === 'native-search') {
        rows.push(...await nativeSearch(videos, plan, partial => { report.rows = partial; return checkpoint(report) }))
        report.rows = rows
      } else {
        rows.push(...await unprepared(videos, plan, partial => { report.rows = partial; return checkpoint(report) }, audit))
        report.rows = rows
      }
    } finally {
      player.setVolume(volume); player.shuffle = shuffle; player.repeat = repeat; await extractor.set(engine)
    }
  } else if (plan.mode === 'ad-transitions') {
    const attempts = Math.min(200, Math.max(videos.length, Math.floor(plan.maxAdAttempts ?? 60)))
    report.maximumAttempts = attempts
    report.requiredAdTransitions = Math.max(50, Math.floor(plan.minimumAdTransitions ?? 50))
    for (let attempt = 0; videos.length && attempt < attempts; attempt++) {
      const video = videos[attempt % videos.length], index = rows.length
      rows[index] = await smoke(video, plan, partial => { rows[index] = partial; return checkpoint(report) }, audit)
      rows[index].attempt = attempt + 1
      reportAdTransitions(report, rows); await checkpoint(report)
      if (attempt + 1 >= videos.length && (report.adTransitions as number) >= (report.requiredAdTransitions as number)) break
    }
  } else for (const video of videos) {
    const index = rows.length
    rows[index] = await smoke(video, plan, partial => { rows[index] = partial; return checkpoint(report) }, audit)
    await checkpoint(report)
  }
  } finally { await audit.close() }
  report.running = false
  report.measurementsOk = rows.length >= (report.expectedTracks as number) && rows.length > 0 && rows.every(row => row.ok)
  reportAdTransitions(report, rows)
  report.blocking = acceptanceCriteria(rows, report.expectedTracks as number, Math.max(50, plan.minimumAdTransitions ?? 50), plan.engine)
  report.missingCriteria = report.blocking
  report.acceptanceOk = (report.blocking as string[]).length === 0
  report.ok = report.measurementsOk
  report.acceptanceScope = 'Sólo esta cohorte observada; no es una garantía universal ni cambia el motor de producción'
  for (const row of rows) { row.measurementOk = row.ok; row.acceptanceOk = report.acceptanceOk === true && row.evidenceEligible === true; row.guaranteeAds = false }
  await checkpoint(report)
  return report
}
