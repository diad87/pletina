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

async function setup(t, options = {}) {
  let clock = 0
  if (options.firstSoundDelay) t.mock.method(performance, 'now', () => clock)
  const snapshots = [], progress = new Map(), timers = [], allAudio = [], calls = []
  let statusReads = 0, seeks = 0, forgotten = new Set()
  const oldAudio = globalThis.Audio, oldMedia = globalThis.HTMLMediaElement
  class Audio extends EventTarget {
    currentTime = 0; duration = 0.95; paused = true; ended = false; seeking = false; error = null; src = ''
    ranges = [{ start: 0, end: 0.95 }]
    constructor() {
      super(); allAudio.push(this)
      if (options.advance) {
        let at = 0
        Object.defineProperty(this, 'currentTime', { get: () => at += options.advance, set: value => { at = value } })
      }
    }
    get buffered() { return { length: this.ranges.length, start: i => this.ranges[i].start, end: i => this.ranges[i].end } }
    play() {
      this.paused = false; this.ended = false
      if (this.currentTime === 0) this.currentTime = options.contextTime ?? 0.01
      this.dispatchEvent(new Event('playing'))
      this.onPlay?.()
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
    setVolume(value) { this.volume = value }, clearQueue() {}, toggle() { this.status = 'paused'; this.playbackAudio.pause() },
    playQueue(items) {
      this.items = items; this.pos = 0
      this.begin()
    },
    begin() {
      this.current = this.items[this.pos]; this.status = 'loading'
      forgotten.delete(video(this.current.track.id).id)
      if (options.promote && this.pos > 0) this.playbackAudio = this.preparedAudio
      const audio = this.playbackAudio
      audio.currentTime = 0; audio.ended = false
      this.upcoming = this.items.slice(this.pos + 1).map(item => ({ item }))
      this.preparedAudio = options.promote && this.upcoming.length ? new Audio() : null
      audio.onPlay = () => {
        this.status = 'playing'
        emitProgress(audio, options.progress ?? proof())
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
      void audio.play()
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
        return native(typeof options.native === 'function' ? options.native(statusReads) : options.native)
      }
      if (command === 'capture_bench_forget') { forgotten.add(args.videoId); return }
      if (command === 'capture_begin' && options.beginHangs) return new Promise(() => {})
      if (command === 'capture_begin' && options.firstSoundDelay) clock += options.firstSoundDelay
      if (command === 'capture_begin' || command === 'capture_cancel') return undefined
      throw new Error(`Comando inesperado: ${command}`)
    },
    api: { rememberSource: async (_item, id) => { if (options.failRemember === id) throw new Error('No se pudo guardar asociación') } },
    player, toQuery: item => item.track, extractor: { engine: 'propio', async set(value) { this.engine = value } },
    captureProgress: audio => progress.get(audio) ?? null,
    playCapture: audio => {
      emitProgress(audio, options.initialProgress ?? proof())
      audio.onPlay = () => {
        if (audio.currentTime > 0.4) {
          audio.currentTime = options.endedAt ?? 0.95; audio.ended = true; audio.dispatchEvent(new Event('ended'))
        }
      }
      return () => progress.delete(audio)
    },
    seekCapture: async (audio, at) => {
      seeks++
      emitProgress(audio)
      if (options.seekFailsOnce && seeks === 1) return false
      audio.currentTime = at; return options.seekFails !== true
    }, stopCapture() {},
  }
  const key = `__captureSuite${++run}`
  globalThis[key] = runtime
  t.after(() => delete globalThis[key])
  const prelude = `const { invoke, api, player, toQuery, extractor, captureProgress, playCapture, seekCapture, stopCapture } = globalThis.${key};\n`
  const module = await import(`data:text/javascript;base64,${Buffer.from(prelude + javascript).toString('base64')}`)
  return { ...module, player, progress, emitProgress, calls, snapshots, allAudio,
    execute: plan => module.runCaptureSuite(plan, async report => { snapshots.push(structuredClone(report)) }) }
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
  assert.equal(report.ok, false)
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
  assert.equal(report.ok, false)
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
  assert.equal(report.ok, false)
  assert.equal(report.guaranteeAds, false)
})

test('un proceso progresivo no puede etiquetarse como control de cuarentena por el plan', async t => {
  const env = await setup(t, { native: { progressiveExperiment: true } })
  const report = await env.execute({ mode: 'smoke', videos: [video(1)], experimental: false, seek: false })
  assert.equal(report.measurementsOk, false)
  assert.equal(report.rows[0].progressiveExperiment, true)
  assert(report.rows[0].failures.some(reason => /modo experimental efectivo/.test(reason)))
})
