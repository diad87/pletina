/** Medidas reales en WebView2. Los umbrales no se usan como timeout ni ocultan fallos. */
import { invoke } from '@tauri-apps/api/core'
import * as api from '../api'
import { player, toQuery, type QueueItem } from '../player.svelte'
import { extractor } from './engine.svelte'
import { captureProgress, playCapture, seekCapture, stopCapture } from './capture'

export interface CaptureCase extends Partial<QueueItem> {
  id?: string; label: string; duration: number; error?: string
}
interface Corpus {
  source: string; expectedTracks: number
  albums: { query: string; albumId?: number; error?: string; expectedTracks: number; rows?: CaptureCase[] }[]
}
export interface CaptureSuitePlan {
  mode: 'catalog' | 'smoke' | 'latency' | 'album' | 'switch'
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
  adsSeen?: number; adsDelivered?: number; adMs?: number; adRateViolations?: number; adRateObservations?: number
  [key: string]: unknown
}
type Row = Record<string, unknown> & { label: string; ok: boolean; failures: string[] }
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const status = (id: string) => invoke<Status | null>('capture_status', { videoId: id })
const covers = (ranges: Range[], at: number, after = 0) => ranges.some(r => r.start <= at + 0.000001 && r.end >= at + after)
export const LIMITS = { firstSoundMs: 3000, nextTrackMs: 500, unpreparedMs: 5000, seekMs: 3000 }
const timingOnly = (plan: CaptureSuitePlan) => plan.experimental !== false && (plan.verifyComplete === false || plan.mode === 'latency')

/** Cero sólo significa cero gaps en el inventario y cero eventos de espera durante escucha. */
export function continuous(ranges: Range[], duration: number, epsilon = 0.000001): boolean {
  return Number.isFinite(duration) && duration > 0 && ranges.length === 1 &&
    Number.isFinite(ranges[0].start) && Number.isFinite(ranges[0].end) &&
    Math.abs(ranges[0].start) <= epsilon && Math.abs(ranges[0].end - duration) <= epsilon
}

async function until(predicate: () => boolean, deadline: number, check: () => void = () => {}, pulse?: () => Promise<void>) {
  let lastPulse = performance.now()
  while (!predicate()) {
    check()
    if (performance.now() >= deadline) throw new Error('Se agotó la espera operativa; el criterio temporal no se ha superado')
    if (pulse && performance.now() - lastPulse >= 15000) { await pulse(); lastPulse = performance.now() }
    await sleep(20)
  }
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
        ...(('detail' in e) ? { detail: (e as CustomEvent).detail } : {}) })
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

async function smoke(video: CaptureCase, plan: CaptureSuitePlan, checkpoint: (row: Row) => Promise<unknown>): Promise<Row> {
  const row: Row = { label: video.label, videoId: video.id, ok: false, failures: [], phase: 'starting' }
  await checkpoint(row)
  if (timingOnly(plan)) {
    row.scope = 'timingOnly'; row.completeNotExercised = true; row.coverageNotExercised = true
  }
  if (!video.id || video.error) { row.failures.push(video.error ?? 'No hay ID elegido'); row.phase = 'finished'; return row }
  const audio = new Audio(), observed = observeAudio(audio)
  audio.muted = true; audio.preload = 'auto'
  const t = performance.now(), timeout = (plan.timeoutSeconds ?? 360) * 1000
  let stop = () => {}, latest: Status | null = null, readerStarted = false
  const check = () => {
    if (audio.error) throw new Error(`Audio ${audio.error.code}: ${audio.error.message}`)
    const fatal = observed.events.find(event => event.type === 'captureerror')
    if (fatal) throw new Error(String(fatal.detail ?? 'La captura falló'))
  }
  try {
    await within(invoke('capture_begin', { videoId: video.id, refresh: true, foreground: true }), t + timeout)
    stop = playCapture(audio, video.id); readerStarted = true
    const play = audio.play(); play.catch(() => {})
    await until(() => observed.firstPlaying !== null && audio.currentTime > 0, t + timeout, check)
    await play
    latest = await status(video.id)
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
      if (plan.experimental !== false && (row.seekMs as number) > LIMITS.seekMs) row.failures.push('Salto al 80% supera 3 s')
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
    if (this === player.playbackAudio || this === player.preparedAudio) beforePlay(this as HTMLAudioElement)
    return original.call(this)
  }
  prototype.play = wrapped
  return () => { if (prototype.play === wrapped) prototype.play = original }
}

/** Usa el reproductor real, su precarga y ended natural; nunca adelanta una pista correcta. */
async function album(videos: CaptureCase[], plan: CaptureSuitePlan, checkpoint: (rows: Row[]) => Promise<unknown>): Promise<Row[]> {
  const rows: Row[] = videos.map(v => ({ label: v.label, videoId: v.id, ok: false, failures: [], phase: 'pending' }))
  const playable: { video: CaptureCase & { id: string }; item: QueueItem; index: number }[] = []
  for (const [index, video] of videos.entries()) {
    const item = queueItem(video)
    try {
      if (video.error || !video.id || !item) throw new Error(video.error ?? 'La muestra no contiene una canción reproducible')
      await api.rememberSource(toQuery(item), video.id)
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
    install(player.preparedAudio, player.pos + 1)
  }
  const unhook = watchPlayerPlay(audio => install(audio, player.pos))
  const timer = setInterval(watch, 10)
  let previousEnded: number | null = null
  try {
    const albumStart = performance.now()
    player.playQueue(playable.map(e => e.item), 0)
    watch()
    for (const [position, entry] of playable.entries()) {
      const row = rows[entry.index], began = performance.now()
      let latest: Status | null = null
      row.phase = 'starting'; await checkpoint(rows)
      try {
        await until(() => {
          watch()
          return player.pos === position && observers.get(position)?.observed.firstPlaying != null
        }, began + (plan.timeoutSeconds ?? 360) * 1000, () => {
          if (player.pos > position) throw new Error('Musify saltó la pista tras un fallo')
          if (observers.get(position)?.observed.events.some(e => e.type === 'captureerror')) throw new Error('La captura falló antes del primer sonido')
        })
        const { audio, observed } = observers.get(position)!
        latest = await status(entry.video.id)
        checkExperiment(row, latest, plan)
        row.startStatus = latest
        row.firstSoundMs = observed.firstPlaying! - (position === 0 ? albumStart : previousEnded ?? began)
        if (position === 0) {
          const adMs = adTime(latest)
          row.firstSoundWithoutAdMs = adMs === null ? null : (row.firstSoundMs as number) - adMs
          row.startAdMs = adMs
          if (adMs !== null && adMs > (row.firstSoundMs as number) + 1) row.failures.push('El tiempo publicitario excede la ventana medida de primer sonido')
          if (plan.experimental !== false && (adMs === null || (row.firstSoundWithoutAdMs as number) > LIMITS.firstSoundMs)) row.failures.push('Primer sonido supera 3 s más anuncio medido')
        } else {
          row.nextTrackMs = previousEnded === null ? null : observed.firstPlaying! - previousEnded
          if (previousEnded === null || (row.nextTrackMs as number) < 0 || (plan.experimental !== false && (row.nextTrackMs as number) > LIMITS.nextTrackMs))
            row.failures.push('Transición natural ausente, solapada o superior a 0,5 s')
        }
        row.initialProgress = captureProgress(audio) ?? observed.progress
        row.phase = 'listening'; await checkpoint(rows)
        const duration = latest?.duration ?? audio.duration
        row.duration = duration
        await until(() => observed.ended !== null, performance.now() + Math.max((plan.timeoutSeconds ?? 360) * 1000,
          (Number.isFinite(duration) ? duration : entry.video.duration) * 1000 + 180000), () => {
          if (audio.error) throw new Error(`Audio ${audio.error.code}: ${audio.error.message}`)
          if (observed.events.some(e => e.type === 'captureerror')) throw new Error('Captura detenida antes del final')
          if (player.pos > position && observed.ended === null) throw new Error('Cambio de pista sin ended natural')
        }, async () => {
          latest = await status(entry.video.id).catch(() => latest)
          row.latestStatus = structuredClone(latest); row.progress = captureProgress(audio) ?? observed.progress
          row.live = liveAudio(audio, began); row.elapsedMs = performance.now() - began
          await checkpoint(rows)
        })
        previousEnded = observed.ended
        latest = await status(entry.video.id).catch(() => latest)
        const progress = observed.progress ?? captureProgress(audio)
        const audioDuration = latest?.audioDuration ?? latest?.eofEnd ?? progress?.audioDuration
        row.status = latest; row.coverage = progress; row.audioDuration = audioDuration ?? null
        row.endedPosition = observed.endedPosition; row.endedBuffered = observed.endedBuffered
        row.complete = latest?.complete === true || progress?.complete === true
        row.coverageOk = continuous(observed.endedBuffered ?? progress?.buffered ?? [], audioDuration ?? NaN)
        if (!row.complete) row.failures.push('EOF sin verificación completa')
        if (!row.coverageOk) row.failures.push('Cobertura final ausente o con huecos')
        if (!Number.isFinite(audioDuration) || observed.endedPosition === null || observed.endedPosition < (audioDuration ?? Infinity) - 0.000001)
          row.failures.push('Ended anterior al extremo de audio verificado')
        row.events = observed.events; row.gaps = observed.gaps
        row.allPlaybackStalls = observed.allPlaybackStalls
        if (observed.gaps.length) row.failures.push(`${observed.gaps.length} cortes durante escucha normal`)
        checkAds(row, latest)
      } catch (error) {
        row.failures.push(String(error)); row.status = latest ?? await status(entry.video.id).catch(() => null)
        const watched = observers.get(position)
        row.events = watched?.observed.events ?? []; row.gaps = watched?.observed.gaps ?? []
        row.allPlaybackStalls = watched?.observed.allPlaybackStalls ?? []
        row.coverage = watched?.observed.progress ?? null
        previousEnded = null
        checkAds(row, row.status as Status | null)
        // Continuar una fila fallida no permite dar por buena la transición siguiente.
        if (position + 1 < playable.length && player.pos === position) player.next()
      }
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
async function unprepared(videos: CaptureCase[], plan: CaptureSuitePlan, checkpoint: (rows: Row[]) => Promise<unknown>): Promise<Row[]> {
  const rows: Row[] = []
  for (const [index, video] of videos.entries()) {
    const row: Row = { label: video.label, videoId: video.id, ok: false, failures: [], phase: 'context' }
    rows.push(row); await checkpoint(rows)
    const source = videos[(index + 1) % videos.length], item = queueItem(video), sourceItem = source && queueItem(source)
    if (video.error || source?.error || !video.id || !source?.id || !item || !sourceItem || source.id === video.id) {
      row.failures.push(video.error ?? source?.error ?? 'Se necesitan dos canciones distintas con metadatos')
      row.phase = 'finished'; await checkpoint(rows); continue
    }
    let observed: ReturnType<typeof observeAudio> | undefined, audio: HTMLAudioElement | null = null
    let latest: Status | null = null, measuring = false
    const began = performance.now(), timeout = (plan.timeoutSeconds ?? 360) * 1000
    const unhook = watchPlayerPlay(next => {
      if (!measuring || player.current?.track.id !== item.track.id || audio === next) return
      observed?.close(); audio = next; observed = observeAudio(next)
    })
    try {
      await api.rememberSource(toQuery(sourceItem), source.id)
      await api.rememberSource(toQuery(item), video.id)
      player.playQueue([sourceItem], 0)
      await until(() => player.status === 'playing' && player.playbackAudio.currentTime > 0.2, performance.now() + timeout)
      row.contextPosition = player.playbackAudio.currentTime
      row.destinationBeforeForget = await status(video.id)
      await invoke('capture_bench_forget', { videoId: video.id })
      const before = await status(video.id)
      row.destinationBeforeClick = before
      row.destinationWasCached = (before?.ranges?.length ?? 0) > 0 || (typeof before?.bytes === 'number' && before.bytes > 0)
      if (row.destinationWasCached) row.failures.push('El destino conserva audio en caché: no es una medición en frío')
      row.phase = 'switching'; await checkpoint(rows)
      measuring = true
      const started = performance.now()
      player.playQueue([item], 0)
      await until(() => observed?.firstPlaying != null && player.current?.track.id === item.track.id && (audio?.currentTime ?? 0) > 0,
        started + timeout, () => {
          if (observed?.events.some(event => event.type === 'captureerror')) throw new Error('La captura falló durante el cambio')
          if (audio?.error) throw new Error(`Audio ${audio.error.code}: ${audio.error.message}`)
        })
      latest = await status(video.id)
      checkExperiment(row, latest, plan)
      const adMs = adTime(latest)
      row.startStatus = structuredClone(latest); row.startAdMs = adMs
      row.unpreparedSwitchMs = observed!.firstPlaying! - started
      row.unpreparedSwitchWithoutAdMs = adMs === null ? null : (row.unpreparedSwitchMs as number) - adMs
      if (adMs !== null && adMs > (row.unpreparedSwitchMs as number) + 1) row.failures.push('El tiempo publicitario excede la ventana medida del cambio')
      if (plan.experimental !== false && (adMs === null || (row.unpreparedSwitchWithoutAdMs as number) > LIMITS.unpreparedMs)) row.failures.push('Salto a canción no preparada supera 5 s más anuncio')
      row.status = latest; checkAds(row, latest)
    } catch (error) {
      row.failures.push(String(error)); latest = await status(video.id).catch(() => latest)
      row.status = latest; checkAds(row, latest)
    } finally {
      row.phase = 'finished'; row.elapsedMs = performance.now() - began
      row.events = observed?.events ?? []; row.gaps = observed?.gaps ?? []
      row.allPlaybackStalls = observed?.allPlaybackStalls ?? []
      observed?.close(); unhook()
      if (player.status === 'playing' || player.status === 'loading') player.toggle()
      stopCapture()
    }
    row.ok = row.failures.length === 0; await checkpoint(rows)
  }
  return rows
}

export async function runCaptureSuite(plan: CaptureSuitePlan, checkpoint: (report: Record<string, unknown>) => Promise<unknown>) {
  const corpus = plan.corpus ?? (!plan.videos ? await invoke<Corpus>('capture_bench_catalog') : undefined)
  const videos = plan.videos ?? (corpus ? cases(corpus) : [])
  const report: Record<string, unknown> = {
    mode: plan.mode, corpus, expectedTracks: corpus?.expectedTracks ?? videos.length,
    limits: plan.experimental === false ? null : LIMITS, timingRequirementsApplied: plan.experimental !== false,
    continuityMethod: 'waiting durante escucha normal y final; seek/backfill queda registrado por separado y no demuestra escucha continua de toda la canción',
    timingMethod: 'Reloj monotónico de eventos HTMLAudioElement en WebView2; audio silenciado durante medición',
    adMethod: 'Estados observados en reproductor oficial y unidades verificadas; contaminación semántica requiere referencia independiente',
    rate: 1, rows: [] as Row[], running: true, ok: false,
    experimental: plan.mode !== 'catalog' && plan.experimental !== false, guaranteeAds: false, acceptanceOk: false,
    scope: plan.mode === 'catalog' ? 'catalog' : plan.experimental === false ? 'full-quarantine' : timingOnly(plan) ? 'timingOnly' : plan.mode === 'switch' ? 'cold-switch' : 'complete',
    blocking: plan.mode === 'catalog' ? [] : plan.experimental === false
      ? ['El control de cuarentena valida esta ejecución; no demuestra latencia progresiva ni una garantía publicitaria global.']
      : ['La identidad publicitaria puede llegar tarde; los tiempos no prueban ausencia de anuncios en unidades ya entregadas.'],
  }
  await checkpoint(report)
  if (plan.mode === 'catalog') {
    report.rows = videos.map(video => ({ label: video.label, videoId: video.id, ok: !!video.id && !video.error,
      failures: video.error ? [video.error] : video.id ? [] : ['No hay ID elegido'], phase: 'finished' }))
    report.ok = videos.length === report.expectedTracks && videos.every(v => v.id && !v.error)
    report.running = false; await checkpoint(report); return report
  }
  const rows = report.rows as Row[]
  if (plan.mode === 'album' || plan.mode === 'switch') {
    const volume = player.volume, engine = extractor.engine, shuffle = player.shuffle, repeat = player.repeat
    try {
      player.setVolume(0); player.shuffle = false; player.repeat = 'off'; player.clearQueue()
      await extractor.set('oficial')
      if (plan.mode === 'album') {
        const groups = corpus?.albums.map(a => cases({ source: corpus.source, expectedTracks: a.expectedTracks, albums: [a] })) ?? [videos]
        for (const group of groups) {
          const previous = rows.slice()
          const finished = await album(group, plan, partial => { report.rows = [...previous, ...partial]; return checkpoint(report) })
          rows.push(...finished); report.rows = rows; await checkpoint(report)
        }
      } else {
        rows.push(...await unprepared(videos, plan, partial => { report.rows = partial; return checkpoint(report) }))
        report.rows = rows
      }
    } finally {
      player.setVolume(volume); player.shuffle = shuffle; player.repeat = repeat; await extractor.set(engine)
    }
  } else for (const video of videos) {
    const index = rows.length
    rows[index] = await smoke(video, plan, partial => { rows[index] = partial; return checkpoint(report) })
    await checkpoint(report)
  }
  report.running = false
  report.measurementsOk = rows.length === report.expectedTracks && rows.length > 0 && rows.every(row => row.ok)
  report.ok = false
  for (const row of rows) { row.measurementOk = row.ok; row.acceptanceOk = false; row.guaranteeAds = false }
  await checkpoint(report)
  return report
}
