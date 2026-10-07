import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

// El benchmark usa módulos Svelte/Tauri: reemplazamos sólo sus imports al cargar su código real.
const original = await readFile(new URL('../src/lib/extractor/bench.ts', import.meta.url), 'utf8')
const javascript = ts.transpileModule(original, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText
const isolated = javascript.replace(/^import[^\n]+\n/gm, '')
let run = 0
async function bench(t, handlers, overrides = {}) {
  let report
  const runtime = {
    invoke: async (command, args) => {
      if (command === 'bench_report') { report = args.report; return }
      if (!(command in handlers)) throw new Error(`Comando inesperado: ${command}`)
      const result = handlers[command]
      return typeof result === 'function' ? result(args) : result
    },
    extractor: { stats: async () => ({}) },
    setup() {}, host: {}, CLIENTS: ['VISIONOS'], stats: { evals: 0, evalMs: 0 },
    playCapture: () => () => {},
    waitForCaptureReady: async () => {},
    ...overrides,
  }
  const key = `__benchTest${++run}`
  globalThis[key] = runtime
  t.after(() => delete globalThis[key])
  const prelude = `const { invoke, extractor, setup, host, CLIENTS, stats, playCapture, waitForCaptureReady, api, player } = globalThis.${key};\n`
  const module = await import(`data:text/javascript;base64,${Buffer.from(prelude + isolated).toString('base64')}`)
  return { run: module.runBench, result: () => report }
}
const videos = [{ id: 'aaaaaaaaaaa', label: 'known-id', duration: 100 }]
const native = { ms: 2, url: 'https://example.test/audio', client: 'VISIONOS', itag: 251, mime: 'audio/webm' }

for (const [label, probe, expected] of [
  ['deep 403', { length: 10000, start: 206, deep: 403 }, false],
  ['longitud desconocida', { length: 0, start: 206, deep: 206 }, false],
  ['ambos rangos verificados', { length: 10000, start: 206, deep: 206 }, true],
]) {
  test(`el resultado global refleja ${label}`, async t => {
    const b = await bench(t, { bench_native: native, bench_probe: probe })
    await b.run({ videos, tier1: true })
    const report = b.result()
    assert.equal(report.ok, expected)
    assert.equal(report.tier1[0].ok, expected)
    assert.equal(report.tier1[0].extractionOk, true)
    assert.deepEqual(report.tier1[0].probe, probe)
  })
}

test('un error de la sonda conserva diagnóstico y falla el resultado global', async t => {
  const b = await bench(t, { bench_native: native, bench_probe: () => { throw new Error('offline') } })
  await b.run({ videos, tier1: true })
  assert.equal(b.result().ok, false)
  assert.match(b.result().tier1[0].probe, /offline/)
})

test('una extracción fallida conserva estado de cero bytes y tiempo transcurrido', async t => {
  const status = { bytes: 0, chunks: 0, unknown: 3, bytesQuarantined: 1024, state: 'unknown', generation: 7,
    error: 'CAPTURE_IDENTITY_UNCERTAIN: fuente sin identidad', doneMs: null }
  const b = await bench(t, {
    bench_capture: () => { throw new Error(status.error) },
    capture_status: status,
  })
  await b.run({ videos, tier2: { count: 1 } })
  const row = b.result().tier2[0]
  assert.equal(row.extractionOk, false)
  assert.equal(row.ok, false)
  assert.equal(b.result().ok, false)
  assert.deepEqual(row.status, status)
  assert(Number.isFinite(row.ms) && row.ms >= 0)
  assert.match(row.error, /CAPTURE_IDENTITY_UNCERTAIN/)
})

test('fallar también el diagnóstico no oculta el error original de extracción', async t => {
  const b = await bench(t, {
    bench_capture: () => { throw new Error('CAPTURE_TIMEOUT') },
    capture_status: () => { throw new Error('IPC no disponible') },
  })
  await b.run({ videos, tier2: { count: 1 } })
  const row = b.result().tier2[0]
  assert.equal(row.status, null)
  assert.match(row.error, /CAPTURE_TIMEOUT/)
  assert.match(row.statusError, /IPC no disponible/)
  assert(Number.isFinite(row.ms))
})

function fakeAudio(t, { error = false, ranges = [[0, 100]], tail = 'ended', duration = 100 } = {}) {
  const previous = globalThis.Audio
  globalThis.Audio = class extends EventTarget {
    duration = duration
    position = 0
    finished = false
    get buffered() {
      const current = typeof ranges === 'function' ? ranges() : ranges
      return { length: current.length, start: i => current[i][0], end: i => current[i][1] }
    }
    get currentTime() { return this.finished ? this.position : this.position += 0.6 }
    set currentTime(value) { this.position = value; queueMicrotask(() => this.dispatchEvent(new Event('seeked'))) }
    play() {
      queueMicrotask(() => {
        this.dispatchEvent(new Event(error ? 'error' : 'playing'))
        if (this.position >= 99) {
          this.finished = true
          if (tail === 'error') {
            this.error = { code: 3, message: 'último buffer corrupto' }
            this.dispatchEvent(new Event('error'))
          } else {
            this.position = tail === 'early' ? 99.7 : 100
            this.dispatchEvent(new Event('ended'))
          }
        }
      })
      return Promise.resolve()
    }
    pause() {}
    removeAttribute() {}
    load() {}
  }
  t.after(() => { globalThis.Audio = previous })
}

test('audio fallido impide éxito aunque la extracción y los rangos sean correctos', async t => {
  fakeAudio(t, { error: true })
  const b = await bench(t, { bench_native: native, bench_probe: { length: 100, start: 206, deep: 206 } })
  await b.run({ videos, tier1: true, audio: true })
  assert.equal(b.result().ok, false)
  assert.equal(b.result().tier1[0].probeOk, true)
  assert.equal(b.result().tier1[0].audio.ok, false)
})

test('sólo captura espera reserva antes de play y esa espera cuenta en el cronómetro', async t => {
  fakeAudio(t)
  let clock = 0, waits = 0, starts = []
  t.mock.method(performance, 'now', () => clock)
  const originalPlay = globalThis.Audio.prototype.play
  t.mock.method(globalThis.Audio.prototype, 'play', function () { starts.push(clock); return originalPlay.call(this) })
  const b = await bench(t, {
    bench_native: native, bench_probe: { length: 100, start: 206, deep: 206 },
    bench_capture: { ms: 2 }, capture_status: { doneMs: 0 },
  }, { waitForCaptureReady: async () => { waits++; clock += 500 } })
  await b.run({ videos, tier1: true, audio: true })
  assert.equal(waits, 0); assert.equal(starts[0], 0)
  starts = []
  await b.run({ videos, tier2: { count: 1 }, audio: true })
  assert.equal(waits, 1); assert.equal(starts[0], 500)
  assert.equal(b.result().tier2[0].audio.startMs, 500)
})

for (const [label, status, expected] of [
  ['captura con error', { doneMs: null, error: 'unknown: fuente sin identidad' }, false],
  ['captura desaparecida', null, false],
  ['captura terminada incluso en 0 ms', { doneMs: 0, error: null }, true],
]) {
  test(`la completitud es obligatoria: ${label}`, async t => {
    fakeAudio(t)
    const b = await bench(t, { bench_capture: { ms: 1, title: 'known-id' }, capture_status: status })
    await b.run({ videos, tier2: { count: 1 } })
    assert.equal(b.result().tier2[0].audio.ok, true)
    assert.equal(b.result().tier2[0].complete, expected)
    assert.equal(b.result().ok, expected)
    assert.deepEqual(b.result().tier2[0].status, status)
  })
}

for (const [label, ranges] of [
  ['el último chunk no llegó al consumidor', [[0, 90]]],
  ['hay un hueco interior aunque el último rango alcance el final', [[0, 40], [40.05, 100]]],
  ['el buffer inicial fue expulsado', [[20, 100]]],
]) {
  test(`done nativo no basta si ${label}`, async t => {
    fakeAudio(t, { ranges })
    // Avanzar el reloj evita esperar el timeout real; el audio y sus rangos no cambian.
    let now = 0
    t.mock.method(performance, 'now', () => now += 16000)
    const b = await bench(t, { bench_capture: { ms: 1, title: 'known-id' }, capture_status: { doneMs: 1 } })
    await b.run({ videos, tier2: { count: 1 } })
    const row = b.result().tier2[0]
    assert.equal(row.complete, true)
    assert.equal(row.audio.ok, false)
    assert.equal(b.result().ok, false)
    assert.match(row.audio.error, /sin cobertura continua/)
    assert(row.audio.error.includes(JSON.stringify(ranges)))
  })
}

for (const [tail, message] of [['error', /último buffer corrupto/], ['early', /antes del final/]]) {
  test(`la captura con cobertura completa falla si el final de audio es ${tail}`, async t => {
    fakeAudio(t, { tail })
    const b = await bench(t, { bench_capture: { ms: 1, title: 'known-id' }, capture_status: { doneMs: 1 } })
    await b.run({ videos, tier2: { count: 1 } })
    const row = b.result().tier2[0]
    assert.equal(row.audio.coverageEnd, 100)
    assert.equal(row.audio.ok, false)
    assert.equal(b.result().ok, false)
    assert.match(row.audio.error, message)
  })
}

test('espera que el último append termine después de done y reproduce hasta el final', async t => {
  let reads = 0
  fakeAudio(t, { ranges: () => [[0, ++reads < 2 ? 95 : 100]] })
  const b = await bench(t, { bench_capture: { ms: 1, title: 'known-id' }, capture_status: { doneMs: 1 } })
  await b.run({ videos, tier2: { count: 1 } })
  const row = b.result().tier2[0]
  assert.equal(b.result().ok, true)
  assert.equal(row.audio.coverageEnd, 100)
  assert(Number.isFinite(row.audio.tailMs) && row.audio.tailMs >= 0)
  assert(reads >= 2)
})

test('los motores con URL de red no exigen buffer completo ni reproducción final', async t => {
  fakeAudio(t, { ranges: [[75, 90]], tail: 'error' })
  const b = await bench(t, { bench_native: native, bench_probe: { length: 100, start: 206, deep: 206 } })
  await b.run({ videos, tier1: true, audio: true })
  assert.equal(b.result().ok, true)
  assert.equal(b.result().tier1[0].audio.coverageEnd, undefined)
  assert.equal(b.result().tier1[0].audio.tailMs, undefined)
})

test('el informe conserva la duración exacta usada al comprobar el audio', async t => {
  fakeAudio(t, { duration: 287.901 })
  const b = await bench(t, { bench_native: native, bench_probe: { length: 100, start: 206, deep: 206 } })
  await b.run({ videos, tier1: true, audio: true })
  assert.equal(b.result().tier1[0].audio.duration, 287.901)
})

function e2eRuntime(t, readyAt = Infinity) {
  let now = 0
  const events = []
  const player = {
    status: 'idle', time: 0, volume: 0.8, current: null,
    setVolume(value) { this.volume = value; events.push(['volume', value]) },
    playQueue(items) { this.current = items[0]; this.status = 'loading' },
    toggle() { events.push(['toggle', this.status]); this.status = this.status === 'loading' ? 'idle' : 'paused' },
  }
  const extractor = {
    engine: 'ytdlp', served: 0, failed: 0, stats: async () => ({}),
    async set(value) { this.engine = value; events.push(['engine', value]) },
  }
  t.mock.method(performance, 'now', () => now)
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    now += delay === 25 ? 30000 : delay
    if (now >= readyAt && player.status === 'loading') { player.status = 'playing'; player.time = 2 }
    queueMicrotask(callback)
    return 0
  })
  const api = { album: async () => ({ id: 10, title: 'Album', artist: { id: 1 }, coverBig: null,
    tracks: [{ id: 1, title: 'Airbag', duration: 288, artist: { id: 1, name: 'Radiohead' } }] }) }
  return { api, player, extractor, events }
}

test('el E2E oficial permite la captura completa de una canción de más de un minuto', async t => {
  const runtime = e2eRuntime(t, 300000)
  const b = await bench(t, {}, runtime)
  await b.run({ videos: [], e2e: { albumId: 10, tracks: 1, engine: 'oficial' } })
  const row = b.result().e2e[0].rows[0]
  assert.equal(b.result().ok, true)
  assert(row.msToOneSecond >= 288000)
  assert(row.timeoutMs > row.msToOneSecond && row.timeoutMs <= 21 * 60000)
  assert.equal(runtime.player.status, 'paused')
  assert.equal(runtime.player.volume, 0.8)
  assert.equal(runtime.extractor.engine, 'ytdlp')
})

test('el timeout E2E oficial está acotado y cancela loading antes de restaurar el volumen', async t => {
  const runtime = e2eRuntime(t)
  const b = await bench(t, {}, runtime)
  await b.run({ videos: [], e2e: { albumId: 10, tracks: 1, engine: 'oficial' } })
  const row = b.result().e2e[0].rows[0]
  assert.equal(b.result().ok, false)
  assert.equal(row.state.status, 'loading')
  assert(row.msToOneSecond > 20 * 60000 && row.msToOneSecond <= 21 * 60000)
  const cancelAt = runtime.events.findIndex(([action, status]) => action === 'toggle' && status === 'loading')
  const restoreAt = runtime.events.findIndex(([action, value]) => action === 'volume' && value === 0.8)
  assert(cancelAt >= 0 && cancelAt < restoreAt)
  assert.equal(runtime.player.status, 'idle')
  assert.equal(runtime.extractor.engine, 'ytdlp')
})
