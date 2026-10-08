import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const original = await readFile(new URL('../src/lib/extractor/capture-suite.ts', import.meta.url), 'utf8')
const javascript = ts.transpileModule(original, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText.replace(/^import[^\n]+\n/gm, '')
let run = 0
const video = (index, overrides = {}) => ({ id: `${index}`.padStart(11, 'a'), label: `Track ${index}`, duration: 1,
  track: { id: index, title: `Track ${index}`, duration: 1, artist: { id: 10, name: 'Artist' } },
  albumId: 10, albumTitle: 'Album', artistId: 10, cover: null, ...overrides })
const native = overrides => ({ generation: 3, epoch: 1, revision: 1, duration: 1, audioDuration: 0.95,
  progressiveExperiment: true,
  complete: true, ranges: [{ start: 0, end: 0.95 }], adsSeen: 0, adsDelivered: 0, adMs: 0,
  adRateViolations: 0, adRateObservations: 0, ...overrides })
const proof = overrides => ({ generation: 3, revision: 1, duration: 1, audioDuration: 0.95, complete: true,
  ranges: [{ start: 0, end: 0.95 }], buffered: [{ start: 0, end: 0.95 }], units: 4, firstAppendMs: 1,
  recovering: false, softError: null, ...overrides })
const adTransition = (index, overrides = {}) => ({ from: 'ad', to: 'content', observed: true,
  generation: 1, epoch: 1, source: index + 1, contentSource: index + 101, sequence: index * 3 + 2,
  markerObserved: true, markerSequence: index * 3 + 1, markerPlaybackRate: 1, ...overrides })

async function setup(t, options = {}) {
  let clock = 0
  if (options.firstSoundDelay || options.verificationDelay || options.reserveDelay) t.mock.method(performance, 'now', () => clock)
  const snapshots = [], progress = new Map(), timers = [], allAudio = [], calls = [], queueCalls = [], forgetEvidence = []
  const lifecycle = { toggles: 0, stops: 0 }
  let statusReads = 0, seeks = 0, forgotten = new Set()
  const oldAudio = globalThis.Audio, oldMedia = globalThis.HTMLMediaElement
  class Audio extends EventTarget {
    currentTime = 0; duration = 0.95; paused = true; ended = false; seeking = false; error = null; src = ''; playbackRate = 1
    ranges = [{ start: 0, end: 0.95 }]
    listeners = []
    constructor() {
      super(); allAudio.push(this)
      // Player binds its ordinary ended handler before the benchmark observes the Audio.
      if (options.rewindOnEnded) this.addEventListener('ended', () => { this.currentTime = 0 })
      if (options.advance) {
        let at = 0
        Object.defineProperty(this, 'currentTime', { get: () => at += options.advance, set: value => { at = value } })
      }
    }
    addEventListener(name, listener, options = false) {
      const capture = typeof options === 'boolean' ? options : !!options.capture
      if (!this.listeners.some(entry => entry.name === name && entry.listener === listener && entry.capture === capture))
        this.listeners.push({ name, listener, capture, once: !!options?.once })
    }
    removeEventListener(name, listener, options = false) {
      const capture = typeof options === 'boolean' ? options : !!options.capture
      this.listeners = this.listeners.filter(entry => entry.name !== name || entry.listener !== listener || entry.capture !== capture)
    }
    dispatchEvent(event) {
      // Node EventTarget does not model DOM's at-target capture phase ordering.
      // https://dom.spec.whatwg.org/#concept-event-dispatch (steps 13–14).
      const snapshot = this.listeners.filter(entry => entry.name === event.type)
      for (const capture of [true, false]) for (const entry of snapshot) {
        if (entry.capture !== capture || !this.listeners.includes(entry)) continue
        if (entry.once) this.removeEventListener(entry.name, entry.listener, entry.capture)
        if (typeof entry.listener === 'function') entry.listener.call(this, event)
        else entry.listener.handleEvent(event)
      }
      return !event.defaultPrevented
    }
    get buffered() { return { length: this.ranges.length, start: i => this.ranges[i].start, end: i => this.ranges[i].end } }
    play() {
      if (this.failPlayback) {
        this.paused = true; this.error = { code: 4, message: 'fixture playback failed' }
        this.dispatchEvent(new CustomEvent('captureerror', { detail: 'fixture playback failed' }))
        return Promise.resolve()
      }
      this.paused = false; this.ended = false
      if (this.currentTime === 0) this.currentTime = options.contextTime ?? 0.01
      this.dispatchEvent(new Event('playing'))
      this.onPlay?.()
      if (options.advanceContextAfterPlay) timers.push(setTimeout(() => { if (!this.paused) this.currentTime = 0.25 }, 1))
      return Promise.resolve()
    }
    pause() { this.paused = true }
    removeAttribute() { this.src = '' }
    load() {}
  }
  globalThis.Audio = globalThis.HTMLMediaElement = Audio
  t.after(() => { globalThis.Audio = oldAudio; globalThis.HTMLMediaElement = oldMedia; timers.forEach(clearTimeout) })
  const emitProgress = (audio, value = proof()) => {
    progress.set(audio, value)
    audio.dispatchEvent(new CustomEvent('captureprogress', { detail: value }))
  }
  const current = new Audio()
  const player = {
    playbackAudio: current, preparedAudio: null, current: null, pos: -1, volume: 0.8, shuffle: false, repeat: 'off', status: 'idle', upcoming: [],
    setVolume(value) { this.volume = value }, clearQueue() {}, toggle() { lifecycle.toggles++; this.status = this.status === 'loading' ? 'idle' : 'paused'; this.playbackAudio.pause() },
    playQueue(items) {
      queueCalls.push(items.map(item => item.track.id))
      this.items = items; this.pos = 0
      this.begin()
    },
    begin() {
      this.current = this.items[this.pos]; this.status = 'loading'
      if (options.sourceKind) this.playbackSource = { kind: options.sourceKind, trackId: this.current.track.id, videoId: video(this.current.track.id).id }
      forgotten.delete(video(this.current.track.id).id)
      if (options.promote && this.pos > 0) this.playbackAudio = this.preparedAudio
      const audio = this.playbackAudio
      audio.currentTime = 0; audio.ended = false; audio.error = null
      audio.failPlayback = options.failPlayerTrack === this.current.track.id
      this.upcoming = this.items.slice(this.pos + 1).map(item => ({ item }))
      this.preparedAudio = options.promote && this.upcoming.length ? new Audio() : null
      audio.onPlay = () => {
        this.status = 'playing'
        if (!options.noCaptureProgress) emitProgress(audio, options.progress ?? proof())
        if (options.errorAfterPlayingTrack === this.current.track.id)
          audio.dispatchEvent(new CustomEvent('captureerror', { detail: 'fixture failure after playing' }))
        if (options.holdPlayback || options.holdPlayerTrack === this.current.track.id) return
        const position = this.pos
        timers.push(setTimeout(() => {
          audio.currentTime = options.endedAt ?? 0.95; audio.ended = true
          audio.dispatchEvent(new Event('ended'))
          if (position === this.pos && position + 1 < this.items.length) {
            // El lector se elimina al cambiar de pista, antes de que el banco consulte el getter.
            progress.delete(audio)
            this.pos++
            queueMicrotask(() => this.begin())
          } else this.status = 'paused'
        }, 45))
      }
      // playing síncrono: se pierde con un observador que sólo haga polling después de playQueue.
      if (options.loadingPlayerTrack !== this.current.track.id) void audio.play()
    },
    next() { if (this.pos + 1 < this.items.length) { this.pos++; this.begin() } },
  }
  const runtime = {
    invoke: async (command, args) => {
      calls.push([command, args])
      if (command === 'capture_status') {
        statusReads++
        if (options.backfillWaiting && seeks) {
          allAudio.at(-1).dispatchEvent(new Event('waiting'))
          allAudio.at(-1).dispatchEvent(new Event('playing'))
        }
        if (forgotten.has(args.videoId)) return null
        return native(typeof options.native === 'function' ? options.native(statusReads, args.videoId) : options.native)
      }
      if (command === 'capture_verify_prepare') {
        if (options.referenceFails) throw new Error('reference unavailable')
        return { ok: true, anonymousTransport: true, videoId: args.videoId, ...options.reference }
      }
      if (command === 'capture_profile_open') return { profileId: 'reference-premium', private: 'must not leak' }
      if (command === 'capture_profile_status') return { sessionState: { profileId: 'reference-premium', state: 'signed-in' }, loggedIn: true,
        email: 'must-not-be-recorded@example.test', cookies: ['private'], dataDir: 'private-path' }
      if (command === 'capture_verify_check') {
        const result = await options.verificationHook?.(args)
        if (options.verificationRealDelay) await new Promise(resolve => setTimeout(resolve, options.verificationRealDelay))
        clock += options.verificationDelay ?? 0
        return { ok: true, anonymous: true, captureAnonymous: true, complete: true, allPublishedUnits: true, mismatchCount: 0, unitsChecked: 4, unitsCheckedSnapshot: 4,
          comparedPackets: 50, mismatches: [], ...options.verification, ...result }
      }
      if (command === 'capture_bench_native_search') return { sourceCleared: true, cacheCleared: true, searchIncluded: true }
      if (command === 'capture_bench_forget') {
        forgetEvidence.push({ target: args.videoId, context: video(player.current.track.id).id,
          playing: player.status === 'playing' && !player.playbackAudio.paused, queue: player.items.map(item => item.track.id) })
        if (options.keepCacheId !== args.videoId) forgotten.add(args.videoId)
        if (options.pauseOnForgetId === args.videoId) { player.status = 'paused'; player.playbackAudio.pause() }
        return
      }
      if (command === 'capture_begin' && options.beginHangs) return new Promise(() => {})
      if (command === 'capture_begin' && options.firstSoundDelay) clock += options.firstSoundDelay
      if (command === 'capture_begin' || command === 'capture_cancel') return undefined
      throw new Error(`Comando inesperado: ${command}`)
    },
    api: { rememberSource: async (_item, id) => {
      calls.push(['rememberSource', { videoId: id }])
      if (options.failRemember === id) throw new Error('No se pudo guardar asociación')
    } },
    player, toQuery: item => item.track, extractor: { engine: 'propio', async set(value) { this.engine = value } },
    captureProgress: audio => progress.get(audio) ?? null,
    waitForCaptureReady: async audio => { await options.waitForCaptureReady?.(audio); clock += options.reserveDelay ?? 0 },
    playCapture: audio => {
      emitProgress(audio, options.initialProgress ?? proof())
      audio.onPlay = () => {
        if (audio.currentTime > 0.4) {
          audio.currentTime = options.endedAt ?? 0.95; audio.ended = true; audio.dispatchEvent(new Event('ended'))
        }
      }
      options.captureAudio?.(audio, emitProgress)
      return () => progress.delete(audio)
    },
    seekCapture: async (audio, at) => {
      seeks++
      if (options.seekHook) return options.seekHook(audio, at, seeks, emitProgress)
      emitProgress(audio)
      if (options.seekFailsOnce && seeks === 1) return false
      audio.currentTime = at; return options.seekFails !== true
    }, stopCapture() { lifecycle.stops++ },
  }
  const key = `__captureSuite${++run}`
  globalThis[key] = runtime
  t.after(() => delete globalThis[key])
  const prelude = `const { invoke, api, player, toQuery, extractor, captureProgress, playCapture, waitForCaptureReady, seekCapture, stopCapture } = globalThis.${key};\n`
  const module = await import(`data:text/javascript;base64,${Buffer.from(prelude + javascript + '\nexport { evidenceAudit };').toString('base64')}`)
  return { ...module, player, progress, emitProgress, calls, snapshots, allAudio, queueCalls, forgetEvidence, lifecycle,
    extractor: runtime.extractor, originalPlay: Audio.prototype.play,
    execute: (plan, checkpoint) => module.runCaptureSuite(plan, async report => { snapshots.push(structuredClone(report)); await checkpoint?.(report) }) }
}

test('álbum conserva progreso y cobertura tras cleanup y captura playing antes del primer poll', async t => {
  const env = await setup(t)
  const report = await env.execute({ mode: 'album', videos: [video(1), video(2)], timeoutSeconds: 1 })
  assert.equal(report.measurementsOk, true)
  assert.equal(report.rows.length, 2)
  assert.equal(report.rows[0].coverage.complete, true)
  assert.equal(report.rows[0].duration, 1)
  assert.equal(report.rows[0].audioDuration, 0.95)
  assert.equal(report.rows[0].events.filter(event => event.type === 'playing').length, 1)
  assert.equal(report.rows[0].events.filter(event => event.type === 'ended').length, 1)
  assert(report.rows[1].nextTrackMs >= 0 && report.rows[1].nextTrackMs < 500)
  assert.equal(env.snapshots.at(-1).running, false)
  assert(env.snapshots.some(snapshot => snapshot.rows[0]?.phase === 'listening'))
})

test('la promoción de otro Audio entre polls conserva la transición natural', async t => {
  const env = await setup(t, { promote: true })
  const report = await env.execute({ mode: 'album', videos: [video(1), video(2)], timeoutSeconds: 1 })
  assert.equal(report.measurementsOk, true)
  assert.equal(report.rows[1].events.filter(event => event.type === 'playing').length, 1)
  assert(report.rows[1].nextTrackMs < 500)
})

test('ended conserva la posición final antes de que el handler del reproductor rebobine a cero', async t => {
  const env = await setup(t, { rewindOnEnded: true })
  const report = await env.execute({ mode: 'album', videos: [video(1)], timeoutSeconds: 1 })
  assert.equal(env.player.playbackAudio.currentTime, 0)
  assert.equal(report.measurementsOk, true)
  assert.equal(report.rows[0].endedPosition, 0.95)
  assert.equal(report.rows[0].events.find(event => event.type === 'ended').position, 0.95)
  assert.equal(env.player.playbackAudio.listeners.filter(entry => entry.name === 'ended').length, 1,
    'el observador se retira con el mismo capture; sólo permanece el handler del reproductor')
})

test('complete nativo no vuelve correcto un ended anterior al último frame', async t => {
  const env = await setup(t, { endedAt: 0.8 })
  const report = await env.execute({ mode: 'album', videos: [video(1)], timeoutSeconds: 1 })
  assert.equal(report.ok, false)
  assert.equal(report.rows[0].complete, true)
  assert(report.rows[0].failures.some(reason => /Ended anterior/.test(reason)))
})

test('un error guardando una asociación mantiene su fila y deja medir las otras', async t => {
  const env = await setup(t, { failRemember: video(1).id })
  const report = await env.execute({ mode: 'album', videos: [video(1), video(2)], timeoutSeconds: 1 })
  assert.equal(report.ok, false)
  assert.equal(report.rows.length, 2)
  assert.match(report.rows[0].failures[0], /guardar asociación/)
  assert.equal(report.rows[1].ok, true)
})

test('el circuito terminal cierra pronto una fila incompleta y conserva la siguiente sin inventar ended', { timeout: 5000 }, async t => {
  let firstReads = 0
  const softError = 'CAPTURE_UNSUPPORTED_TIMELINE: repeated tuple; automatic recovery stopped'
  const env = await setup(t, { holdPlayerTrack: 1,
    progress: proof({ complete: false, audioDuration: null, buffered: [{ start: 0, end: 0.4 }] }),
    native: (_read, id) => id === video(1).id ? {
      duration: 600, audioDuration: null, complete: false, ranges: [{ start: 0, end: 0.4 }],
      active: ++firstReads === 1, recovering: false, recoveryBlocked: firstReads > 1, softError,
    } : {},
  })
  const started = performance.now()
  const report = await env.execute({ mode: 'album', videos: [video(1), video(2)], timeoutSeconds: 600 })
  assert(performance.now() - started < 4000, 'no debe esperar duración+180s ni el timeout de 600s')
  const [failed, next] = report.rows
  assert.equal(failed.phase, 'finished')
  assert.equal(failed.ok, false)
  assert.equal(failed.complete, false)
  assert.equal(failed.endedObserved, false)
  assert.equal(failed.endedPosition, null)
  assert.equal(failed.events.some(event => event.type === 'ended'), false)
  assert.equal(failed.terminalCapture.reason, softError)
  assert.equal(failed.terminalCapture.status.active, false)
  assert.deepEqual(failed.terminalCapture.progress.buffered, [{ start: 0, end: 0.4 }])
  assert(failed.failures.some(reason => /recuperación automática detenida/.test(reason)))
  assert.equal(next.phase, 'finished')
  assert.equal(next.endedObserved, true)
  assert.equal(next.complete, true)
  assert.equal(next.nextTrackMs, null, 'continuar tras el fallo no acredita una transición natural')
  assert(next.failures.some(reason => /Transición natural ausente/.test(reason)))
  assert.equal(env.player.volume, 0.8)
})

test('softError no detiene la escucha mientras haya recuperación o una sesión activa', async t => {
  for (const state of [
    { active: true, recovering: false, recoveryBlocked: true },
    { active: false, recovering: true, recoveryBlocked: true },
    { active: false, recovering: false, recoveryBlocked: false },
    { recovering: false, recoveryBlocked: true },
  ]) {
    const env = await setup(t, { native: read => read === 1 ? {
      complete: false, audioDuration: null, softError: 'CAPTURE_UNSUPPORTED_TIMELINE: retry pending', ...state,
    } : {} })
    const report = await env.execute({ mode: 'album', videos: [video(1)], timeoutSeconds: 1 })
    assert.equal(report.rows[0].ok, true)
    assert.equal(report.rows[0].endedObserved, true)
    assert.equal(report.rows[0].terminalCapture, undefined)
  }
})

test('un prefijo menor que la reserva no obliga a esperar el timeout tras un fallo terminal', { timeout: 4000 }, async t => {
  const env = await setup(t, { loadingPlayerTrack: 1, native: {
    complete: false, audioDuration: null, ranges: [{ start: 0, end: 0.2 }],
    active: false, recovering: false, recoveryBlocked: true,
    softError: 'CAPTURE_UNSUPPORTED_TIMELINE: automatic recovery stopped',
  } })
  const report = await env.execute({ mode: 'album', videos: [video(1)], timeoutSeconds: 600 })
  const row = report.rows[0]
  assert.equal(row.ok, false)
  assert.equal(row.endedObserved, false)
  assert.equal(row.firstSoundMs, undefined)
  assert.equal(row.complete, false)
  assert.equal(row.terminalCapture.live.paused, true)
  assert.deepEqual(row.terminalCapture.status.ranges, [{ start: 0, end: 0.2 }])
  assert.equal(env.lifecycle.toggles, 1, 'el cierre del banco cancela loading sin iniciar reproducción')
})

test('catálogo conserva las treinta filas aunque falten resultados', async t => {
  const env = await setup(t)
  const report = await env.execute({ mode: 'catalog', corpus: { source: 'fixture', expectedTracks: 30,
    albums: [{ query: 'Known album', expectedTracks: 30, rows: [video(1), video(2)] }] } })
  assert.equal(report.rows.length, 30)
  assert.equal(report.ok, false)
  assert.equal(report.rows[29].ok, false)
  assert.match(report.rows[29].failures[0], /ausente/)
})

test('smoke informa duración nominal y audioDuration, con checkpoints por fase', async t => {
  const env = await setup(t)
  const report = await env.execute({ mode: 'smoke', videos: [video(1)], seek: false, timeoutSeconds: 1 })
  assert.equal(report.measurementsOk, true)
  assert.equal(report.rows[0].duration, 1)
  assert.equal(report.rows[0].audioDuration, 0.95)
  for (const phase of ['starting', 'first-sound', 'coverage', 'tail', 'finished'])
    assert(env.snapshots.some(snapshot => snapshot.rows[0]?.phase === phase), phase)
})

test('no se acepta el final si seekCapture no preparó el último tramo', async t => {
  const env = await setup(t, { seekFails: true })
  const report = await env.execute({ mode: 'smoke', videos: [video(1)], seek: false, timeoutSeconds: 1 })
  assert.equal(report.ok, false)
  assert(report.rows[0].failures.some(reason => /último intervalo/.test(reason)))
})

test('cero violaciones sin observaciones de velocidad durante un anuncio no basta', async t => {
  const env = await setup(t, { native: { adsSeen: 1, adRateViolations: 0, adRateObservations: 0 } })
  const report = await env.execute({ mode: 'smoke', videos: [video(1)], seek: false, timeoutSeconds: 1 })
  assert.equal(report.ok, false)
  assert(report.rows[0].failures.some(reason => /sin mediciones de velocidad/.test(reason)))
})

test('los tiempos correctos no dan aceptación global ni prometen ausencia de anuncios', async t => {
  const env = await setup(t)
  const report = await env.execute({ mode: 'smoke', videos: [video(1)], seek: false, timeoutSeconds: 1 })
  assert.equal(report.measurementsOk, true)
  assert.equal(report.ok, true, 'ok sólo indica éxito de las medidas de este modo')
  assert.equal(report.acceptanceOk, false)
  assert.equal(report.guaranteeAds, false)
  assert.equal(report.experimental, true)
  assert(report.blocking.length > 0)
})

test('un seek fallido conserva su fallo pero permite verificar después el EOF y la cobertura', async t => {
  const env = await setup(t, { seekFailsOnce: true, initialProgress: proof({ ranges: [{ start: 0, end: 0.1 }], complete: false }) })
  const report = await env.execute({ mode: 'smoke', videos: [video(1)], timeoutSeconds: 1 })
  const row = report.rows[0]
  assert.equal(row.ok, false)
  assert.equal(row.seekOk, false)
  assert.equal(row.seekWasCaptured, false)
  assert.equal(row.complete, true)
  assert.equal(row.coverageOk, true)
  assert(Number.isFinite(row.tailMs))
  assert(row.failures.some(reason => /Salto no completado/.test(reason)))
})

test('las esperas durante backfill quedan registradas separadamente de los cortes normales', async t => {
  const env = await setup(t, { seekFailsOnce: true, backfillWaiting: true, initialProgress: proof({ ranges: [{ start: 0, end: 0.1 }], complete: false }) })
  const report = await env.execute({ mode: 'smoke', videos: [video(1)], timeoutSeconds: 1 })
  assert(report.rows[0].backfillWaiting.length > 0)
  assert.equal(report.rows[0].gaps.length, 0)
  assert(report.rows[0].allPlaybackStalls.length > 0)
  assert(report.rows[0].allPlaybackStalls.some(stall => stall.phase === 'backfill' && stall.label === 'backfill-playback-wait'))
  assert.match(report.continuityMethod, /no demuestra escucha continua/)
})

test('el anuncio descontado del primer sonido usa su snapshot inicial, no el contador final', async t => {
  const env = await setup(t, { native: read => ({ adMs: read === 1 ? 0 : 30000 }) })
  const report = await env.execute({ mode: 'smoke', videos: [video(1)], seek: false, timeoutSeconds: 1 })
  const row = report.rows[0]
  assert.equal(row.startAdMs, 0)
  assert.equal(row.startStatus.adMs, 0)
  assert.equal(row.finalStatus.adMs, 30000)
  assert.equal(row.firstSoundWithoutAdMs, row.firstSoundMs)
})

test('la espera operativa también limita capture_begin y cancela su captura pendiente', async t => {
  const env = await setup(t, { beginHangs: true })
  const report = await env.execute({ mode: 'smoke', videos: [video(1)], timeoutSeconds: 0.01 })
  assert.equal(report.rows[0].ok, false)
  assert(report.rows[0].failures.some(reason => /espera operativa/.test(reason)))
  assert(env.calls.some(([command]) => command === 'capture_cancel'))
})

test('latency declara explícitamente que no ejercitó completitud ni cobertura', async t => {
  const env = await setup(t, { advance: 0.6 })
  const report = await env.execute({ mode: 'latency', videos: [video(1)], seek: false, timeoutSeconds: 1 })
  assert.equal(report.scope, 'timingOnly')
  assert.equal(report.rows[0].completeNotExercised, true)
  assert.equal(report.rows[0].coverageNotExercised, true)
  assert.equal(report.rows[0].tailMs, undefined)
  assert.equal(report.ok, true)
  assert.equal(report.acceptanceOk, false)
})

for (const outcome of ['replanned', 'stuck', 'adopted', 'return-wait']) test(`cachedSeekReturn conserva evidencia y distingue productor ${outcome}`, async t => {
  let phase = 'initial', finishAway
  const range = end => [{ start: 0, end }]
  const partial = end => proof({ duration: 40, audioDuration: null, complete: false, ranges: range(end), buffered: range(end) })
  const env = await setup(t, {
    advance: 0.2, initialProgress: partial(5),
    captureAudio: audio => { audio.ranges = range(5); audio.onPlay = () => {} },
    native: () => ({ duration: 40, audioDuration: null, complete: false,
      epoch: phase === 'initial' ? 1 : phase === 'away' || outcome === 'stuck' ? 2 : 3,
      lastPosition: phase === 'initial' ? 5 : phase === 'away' || outcome === 'stuck' ? 32 : 12,
      ranges: range(phase === 'returned' ? 12 : 5) }),
    seekHook: (audio, at, call, emit) => {
      if (call === 1) {
        phase = 'away'; audio.dispatchEvent(new Event('waiting'))
        if (outcome === 'adopted') { audio.currentTime = at; return true }
        return new Promise(resolve => { finishAway = resolve })
      }
      assert.equal(at, 0.1)
      phase = 'returned'; audio.currentTime = at; audio.ranges = range(12); emit(audio, partial(12))
      audio.seeking = true; audio.dispatchEvent(new Event('seeking')); audio.dispatchEvent(new Event('waiting'))
      audio.seeking = false; audio.dispatchEvent(new Event('seeked'))
      if (outcome === 'return-wait') audio.dispatchEvent(new Event('waiting'))
      audio.dispatchEvent(new Event('playing'))
      finishAway(false)
      return true
    },
  })
  const report = await env.execute({ mode: 'latency', videos: [video(1, { duration: 40 })], cachedSeekReturn: true,
    timeoutSeconds: outcome === 'stuck' ? 0.2 : 2 })
  const row = report.rows[0]
  assert.equal(report.scope, 'timingOnly'); assert.equal(report.cachedSeekReturn, true)
  assert.equal(row.completeNotExercised, true); assert.equal(row.coverageNotExercised, true)
  assert.equal(row.seekMs, undefined); assert.equal(row.seekOk, undefined)
  assert.equal(row.tailMs, undefined); assert.equal(report.acceptanceOk, false)
  assert(row.allPlaybackStalls.some(stall => stall.phase === 'seek'), 'no se borra la espera del origen ni la preparación del regreso')
  assert(env.calls.some(([command, args]) => command === 'capture_verify_check' && args.final === true))
  if (outcome === 'replanned') {
    assert.equal(row.ok, true); assert.equal(row.cachedSeekReturn.ok, true)
    assert.equal(row.oldSeekAdopted, false); assert.equal(row.producerReplanned, true)
    assert(Number.isFinite(row.cachedReturnMs)); assert(row.cachedReturnPlayingMs >= row.cachedReturnMs)
    assert(row.cachedReturnProgressSeconds >= 8)
    assert.deepEqual(row.cachedSeekReturn.playbackWaiting, [])
    assert.equal(row.cachedSeekReturn.returnWaiting[0].classification, 'waiting-during-seek')
    assert(Number.isFinite(row.cachedSeekReturn.returnWaiting[0].sinceReturnMs))
    assert(env.snapshots.some(s => s.rows[0]?.phase === 'cached-return-listening'))
  } else {
    assert.equal(row.ok, false); assert.equal(row.cachedSeekReturn.ok, false)
    assert.equal(row.oldSeekAdopted, outcome === 'adopted')
    assert.equal(row.producerReplanned, outcome === 'return-wait')
    assert(row.failures.some(reason => /regres|seek de ida/.test(reason)))
    if (outcome === 'return-wait') {
      assert.equal(row.cachedSeekReturn.playbackWaiting.length, 1)
      assert.equal(row.cachedSeekReturn.playbackWaiting[0].phase, 'seek', 'el waiting previo a listening también hace fallar el ensayo')
      assert.equal(row.cachedSeekReturn.returnWaiting.length, 2)
    }
  }
})

test('switch usa expulsión explícita del destino y conserva evidencia de ambas cachés', async t => {
  const env = await setup(t, { contextTime: 0.25 })
  const report = await env.execute({ mode: 'switch', videos: [video(1), video(2)], timeoutSeconds: 1 })
  assert.equal(report.rows.length, 2)
  assert(report.rows.every(row => row.destinationBeforeForget.complete))
  assert(report.rows.every(row => row.destinationBeforeClick === null))
  assert(report.rows.every(row => row.destinationWasCached === false))
  assert.equal(env.calls.filter(([command]) => command === 'capture_bench_forget').length, 2)
  assert(report.rows.every(row => row.events.some(event => event.type === 'playing')))
})

test('treinta cambios fríos reutilizan el destino anterior con sólo un contexto inicial y una cola de un tema', async t => {
  const env = await setup(t, { contextTime: 0.25, holdPlayback: true })
  const videos = Array.from({ length: 30 }, (_, i) => video(i + 1))
  const report = await env.execute({ mode: 'switch', videos, timeoutSeconds: 1 })
  assert.equal(report.rows.length, 30)
  assert.equal(report.measurementsOk, true)
  assert.equal(report.acceptanceOk, false)
  assert.deepEqual(env.queueCalls, [[30], ...videos.map(row => [row.track.id])])
  assert.deepEqual(env.forgetEvidence.map(entry => entry.target), videos.map(row => row.id))
  assert.equal(new Set(env.forgetEvidence.map(entry => entry.target)).size, 30)
  for (const [index, row] of report.rows.entries()) {
    assert.equal(row.contextVideoId, videos[index === 0 ? 29 : index - 1].id)
    assert.equal(row.contextReused, index > 0)
    assert(row.contextPosition > 0.2)
    assert.equal(row.contextBeforeClick.paused, false)
    assert.equal(row.contextBeforeClick.ended, false)
    assert.equal(row.destinationBeforeClick, null)
    assert.equal(row.destinationWasCached, false)
  }
  assert(env.forgetEvidence.every(entry => entry.context !== entry.target && entry.playing && entry.queue.length === 1))
  assert.deepEqual(env.lifecycle, { toggles: 1, stops: 1 })
})

test('la espera hasta 0,2s del destino recién iniciado conserva el contexto sin resolverlo de nuevo', async t => {
  const env = await setup(t, { contextTime: 0.01, advanceContextAfterPlay: true, holdPlayback: true })
  const report = await env.execute({ mode: 'switch', videos: [video(1), video(2)], timeoutSeconds: 1 })
  assert.equal(report.measurementsOk, true)
  assert.equal(report.rows[1].contextReused, true)
  assert.deepEqual(env.queueCalls, [[2], [1], [2]])
})

test('un destino idéntico al único contexto disponible no se expulsa ni se mide como cambio frío', async t => {
  const env = await setup(t, { contextTime: 0.25, holdPlayback: true })
  const report = await env.execute({ mode: 'switch', videos: [video(1), video(1)], timeoutSeconds: 1 })
  assert.equal(report.rows.length, 2)
  assert(report.rows.every(row => row.ok === false && row.failures.some(reason => /distintas/.test(reason))))
  assert.equal(env.forgetEvidence.length, 0)
  assert.equal(env.queueCalls.length, 0)
})

test('caché retenida o contexto pausado tras forget impiden dar por medido un cambio', async t => {
  for (const failure of [{ keepCacheId: video(1).id }, { pauseOnForgetId: video(1).id }]) {
    const env = await setup(t, { contextTime: 0.25, holdPlayback: true, ...failure })
    const report = await env.execute({ mode: 'switch', videos: [video(1), video(2)], timeoutSeconds: 1 })
    const row = report.rows[0]
    assert.equal(row.ok, false)
    assert.equal(row.unpreparedSwitchMs, undefined)
    assert(row.failures.some(reason => /caché|dejó de sonar/.test(reason)))
    assert.equal(row.events.some(event => event.type === 'playing'), false)
  }
})

test('un cambio fallido conserva su fila y reconstruye contexto antes del siguiente destino', async t => {
  const env = await setup(t, { contextTime: 0.25, holdPlayback: true, failPlayerTrack: 1 })
  const report = await env.execute({ mode: 'switch', videos: [video(1), video(2), video(3)], timeoutSeconds: 1 })
  assert.equal(report.rows.length, 3)
  assert.equal(report.measurementsOk, false)
  assert.equal(report.rows[0].ok, false)
  assert(report.rows[0].failures.some(reason => /captura falló/.test(reason)))
  assert.equal(report.rows[0].unpreparedSwitchMs, undefined)
  assert.equal(report.rows[1].ok, true)
  assert.equal(report.rows[1].contextReused, false)
  assert.equal(report.rows[2].contextReused, true)
  assert.deepEqual(env.queueCalls, [[3], [1], [3], [2], [3]])
  assert.deepEqual(env.lifecycle, { toggles: 1, stops: 1 })
})

test('playing seguido de captureerror en el mismo turno no vuelve correcto el cambio', async t => {
  const env = await setup(t, { contextTime: 0.25, holdPlayback: true, errorAfterPlayingTrack: 1 })
  const report = await env.execute({ mode: 'switch', videos: [video(1), video(2)], timeoutSeconds: 1 })
  assert.equal(report.rows[0].ok, false)
  assert(report.rows[0].events.some(event => event.type === 'playing'))
  assert(report.rows[0].events.some(event => event.type === 'captureerror'))
  assert(report.rows[0].failures.some(reason => /captura falló/.test(reason)))
  assert.equal(report.rows[1].ok, true)
})

test('cancelar checkpoints de switch limpia una sola vez y restaura ajustes y wrapper global', async t => {
  const env = await setup(t, { contextTime: 0.25, holdPlayback: true })
  env.player.volume = 0.35; env.player.shuffle = true; env.player.repeat = 'all'; env.extractor.engine = 'youtubei'
  let cancelled = false
  await assert.rejects(env.execute({ mode: 'switch', videos: [video(1), video(2)], timeoutSeconds: 1 }, report => {
    cancelled ||= report.rows.some(row => row.phase === 'switching')
    if (cancelled) throw new Error('checkpoint cancelled')
  }), /checkpoint cancelled/)
  assert.deepEqual(env.lifecycle, { toggles: 1, stops: 1 })
  assert.equal(env.player.playbackAudio.paused, true)
  assert.equal(env.player.volume, 0.35)
  assert.equal(env.player.shuffle, true)
  assert.equal(env.player.repeat, 'all')
  assert.equal(env.extractor.engine, 'youtubei')
  assert.equal(HTMLMediaElement.prototype.play, env.originalPlay)
  assert(env.allAudio.every(audio => audio.listeners.length === 0))
})

test('un contador publicitario anterior no convierte un arranque en tiempo cero', async t => {
  const env = await setup(t, { native: { adMs: 30000 } })
  const report = await env.execute({ mode: 'smoke', videos: [video(1)], seek: false, timeoutSeconds: 1 })
  assert.equal(report.measurementsOk, false)
  assert(report.rows[0].firstSoundWithoutAdMs < 0)
  assert(report.rows[0].failures.some(reason => /excede la ventana/.test(reason)))
})

test('cobertura exige ambos extremos exactos, no acepta una cola extra ni inicio negativo', async t => {
  const env = await setup(t)
  assert.equal(env.continuous([{ start: 0, end: 1 }], 1), true)
  assert.equal(env.continuous([{ start: 0, end: 1.02 }], 1), false)
  assert.equal(env.continuous([{ start: -0.02, end: 1 }], 1), false)
  assert.equal(env.continuous([{ start: 0, end: 0.9 }], 1), false)
})

test('la cobertura de URL directa contiene el intervalo reproducible sin exigir eliminar priming AAC', async t => {
  const env = await setup(t)
  for (const duration of [251.733333, 187.333333])
    assert.equal(env.directPlaybackCoverage([{ start: -0.013061, end: duration }], duration), true)
  for (const ranges of [[{ start: 0.02, end: 1 }], [{ start: -0.013061, end: 0.99 }],
    [{ start: 0, end: 0.5 }, { start: 0.6, end: 1 }], [{ start: 1, end: 0 }], [{ start: -Infinity, end: 1 }]])
    assert.equal(env.directPlaybackCoverage(ranges, 1), false)
})

test('álbum directo reconoce cobertura AAC con priming negativo y ended exacto', async t => {
  const env = await setup(t, { sourceKind: 'network', noCaptureProgress: true, endedAt: 251.733333 })
  env.player.playbackAudio.duration = 251.733333
  env.player.playbackAudio.ranges = [{ start: -0.013061, end: 251.733333 }]
  const report = await env.execute({ mode: 'album', engine: 'propio', videos: [video(1)], timeoutSeconds: 1 })
  assert.equal(report.rows[0].nativeDirect, true)
  assert.equal(report.rows[0].endedObserved, true)
  assert.equal(report.rows[0].coverageOk, true)
  assert(!report.rows[0].failures.some(reason => /Cobertura/.test(reason)))
})

test('el respaldo legacy conserva ended del consumidor sin acreditarse como nativo ni como EOF API4 auditado', async t => {
  const env = await setup(t, { sourceKind: 'capture-legacy', noCaptureProgress: true })
  const report = await env.execute({ mode: 'album', engine: 'propio', videos: [video(1)], timeoutSeconds: 1 })
  const row = report.rows[0]
  assert.equal(row.nativeDirect, false)
  assert.equal(row.legacyCapture, true)
  assert.equal(row.endedObserved, true)
  assert.equal(row.audioDuration, 0.95)
  assert.equal(row.coverageOk, true)
  assert.equal(row.complete, false)
  assert.equal(row.completeNotExercised, true)
  assert.equal(row.startAdMs, null)
  assert.equal(row.status, null)
  assert.equal(row.adsDelivered, undefined)
  assert.equal(row.adRateViolations, undefined)
  assert(row.failures.some(reason => /Respaldo legacy/.test(reason)))
  assert(!env.calls.some(([name]) => /^capture_(?:status|verify_)/.test(name)))
})

test('el control de cuarentena verifica EOF sin aplicar el requisito progresivo de 3 segundos', async t => {
  const env = await setup(t, { firstSoundDelay: 40000, native: { progressiveExperiment: false } })
  const report = await env.execute({ mode: 'smoke', videos: [video(1)], experimental: false, seek: false })
  assert.equal(report.experimental, false)
  assert.equal(report.scope, 'full-quarantine')
  assert.equal(report.timingRequirementsApplied, false)
  assert.equal(report.limits, null)
  assert.equal(report.rows[0].firstSoundMs, 40000)
  assert.equal(report.rows[0].complete, true)
  assert.equal(report.rows[0].coverageOk, true)
  assert.equal(report.rows[0].scope, 'full-quarantine')
  assert.equal(report.measurementsOk, true)
  assert.equal(report.ok, true)
  assert.equal(report.acceptanceOk, false)
  assert.equal(report.guaranteeAds, false)
})

test('un proceso progresivo no puede etiquetarse como control de cuarentena por el plan', async t => {
  const env = await setup(t, { native: { progressiveExperiment: true } })
  const report = await env.execute({ mode: 'smoke', videos: [video(1)], experimental: false, seek: false })
  assert.equal(report.measurementsOk, false)
  assert.equal(report.rows[0].progressiveExperiment, true)
  assert(report.rows[0].failures.some(reason => /modo experimental efectivo/.test(reason)))
})

const session = (state = 'signed-out') => ({ state, profileId: 'isolated-capture', observedAt: 1, evidenceVersion: 1 })
const evidenceRow = () => ({ label: 'verified', videoId: video(1).id, ok: true, failures: [], complete: true, coverageOk: true,
  status: { units: 4, unknownAuthUnits: 0, signedInUnits: 0 }, reference: { ok: true, anonymousTransport: true },
  verification: [{ final: true, result: { ok: true, anonymous: true, captureAnonymous: true, mismatchCount: 0, complete: true, allPublishedUnits: true, unitsChecked: 4, unitsCheckedSnapshot: 4, comparedPackets: 50, mismatches: [] } }],
  sessionObservations: [{ sessionState: session(), sessionStates: [session()] }] })
const recoveredReferenceCheck = (id = video(1).id) => ({ videoId: id, pending: false, referenceComplete: true,
  referenceHash: 'a'.repeat(64), referenceHashes: ['a'.repeat(64)], matchedPackets: 50 })

test('referencia recuperada al verificar conserva el intento inicial y el fallo de primer sonido', async t => {
  const env = await setup(t, { referenceFails: true, firstSoundDelay: 5575,
    native: { units: 4, unknownAuthUnits: 0, signedInUnits: 0, sessionState: session(), sessionStates: [session()] },
    verification: recoveredReferenceCheck() })
  const report = await env.execute({ mode: 'smoke', videos: [video(1)], seek: false })
  const row = report.rows[0]
  assert.equal(row.reference.ok, false)
  assert.match(row.reference.error, /reference unavailable/)
  assert.deepEqual(row.reference, report.references[video(1).id], 'no se reescribe el resultado de preparación')
  assert.equal(row.referenceEvidence.source, 'final-verification')
  assert.equal(row.referenceEvidence.videoId, video(1).id)
  assert.equal(row.referenceEvidence.referenceHash, 'a'.repeat(64))
  assert.equal(row.referenceEvidence.anonymousTransport, true)
  assert.equal(row.verification.at(-1).final, true)
  assert.deepEqual(row.evidenceBlockers, [])
  assert.equal(row.evidenceEligible, true)
  assert.equal(row.firstSoundMs, 5575)
  assert(row.failures.some(reason => /Primer sonido supera 3000/.test(reason)))
  assert.equal(row.ok, false); assert.equal(report.measurementsOk, false); assert.equal(report.acceptanceOk, false)
})

test('recuperar referencia exige el último check completo del mismo vídeo sin ocultar discrepancias ni autenticación', async t => {
  const env = await setup(t)
  const recovered = () => {
    const row = evidenceRow()
    row.reference = { ok: false, error: 'initial prepare failed' }
    Object.assign(row.verification[0].result, recoveredReferenceCheck())
    return row
  }
  assert.deepEqual(env.evidenceBlockers(recovered()), [])
  for (const broken of [
    { ok: false }, { pending: true }, { complete: false }, { referenceComplete: false },
    { videoId: video(2).id }, { videoId: undefined }, { anonymous: false }, { captureAnonymous: false },
    { allPublishedUnits: false }, { unitsCheckedSnapshot: 3 }, { matchedPackets: 49 },
    { mismatchCount: 1 }, { mismatches: ['different audio'] }, { referenceHash: '' },
    { referenceHashes: ['b'.repeat(64)] },
  ]) {
    const row = recovered()
    row.referenceEvidence = { source: 'final-verification', anonymousTransport: true, complete: true }
    Object.assign(row.verification[0].result, broken)
    assert(env.evidenceBlockers(row).some(reason => /Referencia independiente/.test(reason)), JSON.stringify(broken))
  }
  const periodic = recovered(); periodic.verification[0].final = false
  assert(env.evidenceBlockers(periodic).some(reason => /Referencia independiente/.test(reason)))
  const failedAfterSuccess = recovered()
  failedAfterSuccess.verification.push({ final: true, result: { ok: false, error: 'final snapshot unavailable' } })
  assert(env.evidenceBlockers(failedAfterSuccess).some(reason => /Referencia independiente/.test(reason)))
  for (const previous of [{ mismatchCount: 1, mismatches: [] }, { mismatches: ['old packet mismatch'] }]) {
    const row = recovered(); row.verification.unshift({ final: false, result: previous })
    assert(env.evidenceBlockers(row).some(reason => /todas las unidades/.test(reason)), 'un check posterior no borra discrepancias')
  }
  const signedIn = recovered(); signedIn.sessionObservations[0].sessionStates.unshift(session('signed-in'))
  assert(env.evidenceBlockers(signedIn).some(reason => /Historial anónimo/.test(reason)))
  const unknownUnits = recovered(); unknownUnits.status.unknownAuthUnits = 1
  assert(env.evidenceBlockers(unknownUnits).some(reason => /Unidades entregadas/.test(reason)))
})

test('referencia o sesión desconocida conserva tiempos pero bloquea evidencia; login anterior también', async t => {
  const env = await setup(t)
  assert.deepEqual(env.evidenceBlockers(evidenceRow()), [])
  for (const broken of [
    { reference: { ok: true, anonymousTransport: false } },
    { sessionObservations: [{ sessionState: session('unknown'), sessionStates: [session()] }] },
    { sessionObservations: [{ sessionState: session(), sessionStates: [session('signed-in'), session()] }] },
    { sessionObservations: [{ sessionState: session(), sessionStates: null }] },
    { status: { units: 5 } },
    { verification: [{ final: true, result: { ok: true, complete: true, anonymous: true, unitsChecked: 4, comparedPackets: 50, mismatches: ['ad packet'] } }] },
  ]) assert(env.evidenceBlockers({ ...evidenceRow(), ...broken }).length > 0)
  for (const override of [{ captureAnonymous: false }, { captureAnonymous: undefined }, { mismatchCount: undefined }, { mismatchCount: 1 }]) {
    const row = evidenceRow()
    Object.assign(row.verification[0].result, override)
    assert(env.evidenceBlockers(row).length > 0, JSON.stringify(override))
  }
  const report = await env.execute({ mode: 'smoke', videos: [video(1)], seek: false })
  assert.equal(report.measurementsOk, true)
  assert.equal(report.rows[0].evidenceEligible, false)
  assert.equal(report.acceptanceOk, false)
})

test('unknown antes de entregar audio no invalida unidades anónimas, pero login o unidades desconocidas sí', async t => {
  const env = await setup(t)
  const row = evidenceRow()
  const initial = session('unknown'), signedOut = { ...session(), observedAt: 2 }
  row.sessionObservations = [
    { sessionState: initial, sessionStates: [initial] },
    { sessionState: signedOut, sessionStates: [initial, signedOut] },
  ]
  assert.deepEqual(env.evidenceBlockers(row), [], 'unknown inicial no entregó ninguna unidad; todas las unidades están acreditadas')
  for (const counters of [{ unknownAuthUnits: 1 }, { signedInUnits: 1 }]) {
    const broken = structuredClone(row)
    Object.assign(broken.status, counters)
    assert(env.evidenceBlockers(broken).some(reason => /Unidades entregadas/.test(reason)))
  }
  const signedIn = structuredClone(row)
  signedIn.sessionObservations[1].sessionStates.splice(1, 0, session('signed-in'))
  assert(env.evidenceBlockers(signedIn).some(reason => /Historial anónimo/.test(reason)), 'un período autenticado bloquea aunque los contadores estén a cero')
  const unaudited = structuredClone(row)
  unaudited.verification[0].result.captureAnonymous = false
  assert(env.evidenceBlockers(unaudited).some(reason => /todas las unidades/.test(reason)), 'el estado final no sustituye la auditoría de unidades anteriores')
  const malformed = structuredClone(row)
  malformed.sessionObservations[0].sessionStates[0].observedAt = null
  assert(env.evidenceBlockers(malformed).length > 0, 'unknown tampoco permite metadatos de autenticación inválidos')
})

test('prepare termina antes de capture_begin y la comparación final precede a la siguiente expulsión', async t => {
  const env = await setup(t, { contextTime: 0.25, holdPlayback: true })
  await env.execute({ mode: 'switch', videos: [video(1), video(2)] })
  const firstPrepare = env.calls.findIndex(([name]) => name === 'capture_verify_prepare')
  const firstForget = env.calls.findIndex(([name]) => name === 'capture_bench_forget')
  assert(firstPrepare >= 0 && firstPrepare < firstForget)
  const forget2 = env.calls.findIndex(([name, args]) => name === 'capture_bench_forget' && args.videoId === video(2).id)
  assert(env.calls.slice(0, forget2).some(([name, args]) => name === 'capture_verify_check' && args.videoId === video(2).id && args.final))
})

test('Propio busca dentro del flujo normal sin precalentar referencia ni asociar manualmente el ID', async t => {
  const env = await setup(t)
  const report = await env.execute({ mode: 'native-search', videos: [video(1), video(2)], timeoutSeconds: 1 })
  assert.equal(report.rows.length, 2)
  assert.equal(report.limits.firstSoundMs, 300)
  assert(report.rows.every(row => row.searchIncluded && Number.isFinite(row.firstSoundMs)))
  assert.equal(env.calls.filter(([name]) => name === 'capture_bench_native_search').length, 2)
  assert.equal(env.calls.some(([name]) => name === 'capture_verify_prepare' || name === 'rememberSource'), false)
  assert.deepEqual(env.queueCalls, [[1], [2]])
  assert.equal(report.acceptanceOk, false)
  assert.equal(env.extractor.engine, 'propio')
})

test('la reserva inicial cuenta dentro del arranque y un waiting posterior conserva su foto de MSE', async t => {
  const env = await setup(t, { firstSoundDelay: 100, reserveDelay: 500, waitForCaptureReady: async audio => {
    audio.addEventListener('playing', () => {
      audio.dispatchEvent(new Event('waiting')); audio.dispatchEvent(new Event('playing'))
    }, { once: true })
  } })
  const report = await env.execute({ mode: 'smoke', videos: [video(1)], seek: false })
  const row = report.rows[0], waiting = row.events.find(event => event.type === 'waiting')
  assert.equal(row.firstSoundMs, 600, 'no se reinicia el cronómetro después de acumular reserva')
  assert.deepEqual(waiting.detail.buffered, [{ start: 0, end: 0.95 }])
  assert.equal(waiting.detail.progress.units, 4)
  assert.equal(row.gaps.length, 1, 'el gate no filtra ni reclasifica un corte real posterior')
  assert(row.failures.some(reason => /episodios de espera/.test(reason)))
})

test('cincuenta observaciones duplicadas no son cincuenta transiciones y una cohorte incompleta no aprueba', async t => {
  const env = await setup(t)
  const duplicate = { ...evidenceRow(), status: { adTransitions: Array(50).fill(adTransition(0)) } }
  assert.equal(env.distinctAdTransitions([duplicate, duplicate]), 1)
  const rows = Array.from({ length: 30 }, (_, index) => ({ ...evidenceRow(), videoId: video(index).id, evidenceEligible: true,
    firstSoundMs: 1500, seekOk: true, seekWasCaptured: false, seekMs: 700, ...(index < 25 ? { nextTrackMs: 30 } : {}),
    status: { adTransitions: index < 25 ? [adTransition(index * 2), adTransition(index * 2 + 1)] : [] } }))
  assert.equal(env.distinctAdTransitions(rows), 50)
  assert.deepEqual(env.acceptanceCriteria(rows, 30), [])
  assert(env.acceptanceCriteria(rows.slice(0, 29), 30).length > 0)
  assert(env.acceptanceCriteria([...rows, { ...rows[0], ok: false }], 30).some(reason => /fallidos/.test(reason)))
  rows[0].firstSoundMs = 15000; rows[0].startAdMs = 14000
  assert(env.acceptanceCriteria(rows, 30).some(reason => /no omitible/.test(reason)), 'restar adMs observado no demuestra inevitabilidad')
})

test('cincuenta cambios clasificados sin marcador no cortan la campaña ni satisfacen el criterio publicitario', async t => {
  const unmarked = Array.from({ length: 50 }, (_, index) => {
    const { markerObserved, markerSequence, markerPlaybackRate, ...transition } = adTransition(index)
    return transition
  })
  const env = await setup(t, { native: { adTransitions: unmarked } })
  const report = await env.execute({ mode: 'ad-transitions', videos: [video(1)], maxAdAttempts: 2, seek: false })
  assert.equal(report.rows.length, 2, 'ni un vídeo automático ni un informe histórico sin marcador cumplen el cutoff')
  assert.equal(report.adTransitions, 0)
  assert.equal(report.adTransitionsObserved, 50)
  assert.equal(report.adTransitionsUnqualified, 50)
  assert.equal(report.acceptanceOk, false)
  assert(report.blocking.some(reason => /marcador publicitario.*0\/50/.test(reason)))
  assert.equal(report.rows[0].status.adTransitions.length, 50, 'el inventario original sigue visible')
})

test('cincuenta marcadores propios a 1× cumplen sólo ese criterio y permiten cerrar la campaña acotada', async t => {
  const env = await setup(t, { native: { adTransitions: Array.from({ length: 50 }, (_, index) => adTransition(index)) } })
  const report = await env.execute({ mode: 'ad-transitions', videos: [video(1)], maxAdAttempts: 2, seek: false })
  assert.equal(report.rows.length, 1)
  assert.equal(report.adTransitions, 50)
  assert.equal(report.adTransitionsObserved, 50)
  assert.equal(report.adTransitionsUnqualified, 0)
  assert.equal(report.blocking.some(reason => /marcador publicitario/.test(reason)), false)
  assert.equal(report.acceptanceOk, false, 'siguen pendientes 30 canciones, seeks, transiciones naturales y evidencia completa')
  assert.equal(report.guaranteeAds, false)
})

test('un marcador prestado, reutilizado, posterior o de otra velocidad nunca cuenta', async t => {
  const env = await setup(t)
  const row = transitions => ({ ...evidenceRow(), status: { adTransitions: transitions } })
  for (const invalid of [
    { markerObserved: false }, { markerPlaybackRate: 2 }, { markerPlaybackRate: null },
    { markerSequence: -1 }, { markerSequence: 1.5 }, { markerSequence: Number.MAX_SAFE_INTEGER + 1 },
    { markerSequence: 2 }, { markerSequence: 3 }, { contentSource: null },
  ]) assert.equal(env.distinctAdTransitions([row([adTransition(0, invalid)])]), 0)

  const original = adTransition(0)
  const borrowed = adTransition(1, { markerSequence: original.markerSequence })
  assert.deepEqual(env.adTransitionCounts([row([original]), row([borrowed])]),
    { observed: 2, qualified: 0, unqualified: 2 }, 'una secuencia no puede acreditar dos fuentes')
  const reused = { ...original, sequence: 4 }
  assert.equal(env.distinctAdTransitions([row([original, reused])]), 0, 'tampoco otra transición posterior de la misma fuente')
  assert.equal(env.distinctAdTransitions([row([original]), row([{ ...original, markerObserved: false }])]), 0,
    'copias contradictorias no permiten escoger sólo la favorable')
  assert.equal(env.distinctAdTransitions([row([original, original])]), 1, 'repetir el mismo snapshot sólo cuenta una vez')
  assert.equal(env.distinctAdTransitions([row([original, { ...original, epoch: 2 }])]), 2,
    'el contador de secuencia sí puede reiniciarse en otra época nativa')
})

test('el setup manual espera login y sólo guarda los campos públicos del perfil', async t => {
  const env = await setup(t)
  const report = await env.execute({ mode: 'profile-login' })
  assert.equal(report.ok, true)
  assert.equal(report.loggedIn, true)
  assert.equal(report.acceptanceOk, false)
  assert.deepEqual(env.calls.map(([name]) => name), ['capture_profile_open', 'capture_profile_status'])
  assert.deepEqual(env.calls[0][1], { mode: 'premium-manual' })
  const serialized = JSON.stringify(env.snapshots)
  assert.equal(/must-not|private-path|cookies|email/.test(serialized), false)
  assert.equal(env.queueCalls.length, 0)
})

test('el comparador acumulativo no infla el siguiente arranque ni confunde unidades de otras revisiones', async t => {
  const env = await setup(t, { firstSoundDelay: 100, verificationDelay: 5000 })
  const report = await env.execute({ mode: 'ad-transitions', videos: [video(1)], maxAdAttempts: 2, seek: false })
  assert.deepEqual(report.rows.map(row => row.firstSoundMs), [100, 100])
  const valid = evidenceRow()
  valid.verification[0].result.unitsChecked = 8
  assert.deepEqual(env.evidenceBlockers(valid), [], 'el total acumulado puede superar el inventario vigente')
  valid.verification[0].result.unitsCheckedSnapshot = 3
  assert(env.evidenceBlockers(valid).some(reason => /ledger final/.test(reason)))
})

test('una comparación lenta se coalesce por vídeo y final vuelve a consultar después sin ocultar discrepancias', async t => {
  let tick, release, units = 1
  t.mock.method(globalThis, 'setInterval', callback => { tick = callback; return 0 })
  const gate = new Promise(resolve => { release = resolve })
  const env = await setup(t, { native: { units: 4 }, verificationHook: async args => {
    const snapshot = units
    if (!args.final) await gate
    return { unitsChecked: snapshot, unitsCheckedSnapshot: snapshot, mismatches: args.final ? [] : ['previous packet mismatch'] }
  } })
  const audit = env.evidenceAudit(), id = video(1).id
  await audit.prepare([video(1)]); audit.start(id); tick()
  await new Promise(setImmediate)
  assert.equal(env.calls.filter(([command]) => command === 'capture_verify_check').length, 1)
  for (let i = 0; i < 50; i++) tick()
  units = 4
  const row = evidenceRow(), done = audit.finish(id, row)
  for (let i = 0; i < 50; i++) tick()
  release(); await done
  assert.deepEqual(env.calls.filter(([command]) => command === 'capture_verify_check').map(([, args]) => args.final), [false, true])
  assert.deepEqual(row.verification.map(check => check.result.unitsCheckedSnapshot), [1, 4], 'final obtiene otro snapshot después de la comparación pendiente')
  assert(row.evidenceBlockers.some(reason => /todas las unidades/.test(reason)), 'un resultado final limpio no borra el fallo anterior')
  tick(); await audit.close()
  assert.equal(env.calls.filter(([command]) => command === 'capture_verify_check').length, 2)
})

test('final cancela el trabajo periódico de otro vídeo aún en cola y conserva sólo su snapshot final fresco', async t => {
  let tick, release
  t.mock.method(globalThis, 'setInterval', callback => { tick = callback; return 0 })
  const gate = new Promise(resolve => { release = resolve })
  const a = video(1), b = video(2)
  const env = await setup(t, { native: { units: 4 }, verificationHook: async args => {
    if (args.videoId === a.id && !args.final) await gate
  } })
  const audit = env.evidenceAudit()
  await audit.prepare([a, b]); audit.start(a.id); audit.start(b.id); tick()
  await new Promise(setImmediate)
  const done = audit.finish(b.id)
  for (let i = 0; i < 50; i++) tick()
  release(); await done; await audit.close()
  assert.deepEqual(env.calls.filter(([command, args]) => command === 'capture_verify_check' && args.videoId === b.id).map(([, args]) => args.final), [true])
  assert.deepEqual(env.calls.filter(([command, args]) => command === 'capture_verify_check' && args.videoId === a.id).map(([, args]) => args.final), [false, true])
})

test('una comparación lenta de A no confunde la reproducción ya observada de B y C con pistas saltadas', async t => {
  const env = await setup(t, { promote: true, verificationRealDelay: 120 })
  const report = await env.execute({ mode: 'album', videos: [video(1), video(2), video(3)], timeoutSeconds: 1 })
  assert.equal(report.measurementsOk, true)
  assert(report.rows.every(row => row.events.some(event => event.type === 'playing') && row.events.some(event => event.type === 'ended')))
  assert.equal(report.rows.some(row => row.failures.some(reason => /saltó/.test(reason))), false)
})
