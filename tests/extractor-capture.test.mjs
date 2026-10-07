import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerHooks } from 'node:module'
registerHooks({ resolve(specifier, context, next) { return next(specifier === './capture-legacy' ? './capture-legacy.ts' : specifier, context) } })
const { playCapture, seekCapture, captureProgress, prepareAudioSource } = await import('../src/lib/extractor/capture.ts')

const tick = () => new Promise(resolve => setTimeout(resolve, 2))
async function settle(predicate) {
  for (let i = 0; i < 150; i++) {
    if (predicate()) return
    await tick()
  }
  assert.fail('La operación no terminó')
}
const timeline = { timestampOffset: 0, appendWindowStart: 0, appendWindowEnd: null, mode: 'segments' }
const unit = (start, end, changes = {}) => ({ epoch: 1, source: 7, s: 2, unit: start, initKey: 'opus-one', initBytes: 1,
  mime: 'audio/webm; codecs="opus"', rangeStart: start, rangeEnd: end, decodeStart: start, decodeEnd: end,
  frames: 1, verified: true, timelineSettings: timeline, ...changes })
function packet({ chunks = [], units = chunks.map(c => unit(c.at(-2), c.at(-1))), from = 0, ranges = [], ...changes } = {}) {
  const head = new TextEncoder().encode(JSON.stringify({
    api: 3, duration: 100, complete: false, error: null, softError: null, recovering: false, revision: 9, generation: 3,
    units: units.map((u, i) => ({ generation: changes.generation ?? 3, index: from + i, ...u })), ranges, from, next: from + chunks.length, ...changes,
  }))
  const buffer = new ArrayBuffer(4 + head.length + chunks.reduce((n, c) => n + c.length + 4, 0))
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  view.setUint32(0, head.length, true)
  bytes.set(head, 4)
  let at = head.length + 4
  for (const chunk of chunks) {
    view.setUint32(at, chunk.length, true)
    bytes.set(chunk, at + 4)
    at += chunk.length + 4
  }
  return buffer
}
function environment(t, invoke) {
  const urls = new Map()
  const revoked = []
  const instances = []
  class Buffer extends EventTarget {
    constructor(owner) { super(); this.owner = owner; this.updating = false; this.ranges = []; this.chunks = []; this.hold = false; this.timelineAtAppend = [] }
    get buffered() { const ranges = this.ranges; return { length: ranges.length, start: i => ranges[i][0], end: i => ranges[i][1] } }
    appendBuffer(chunk) {
      this.timelineAtAppend.push({ timestampOffset: this.timestampOffset, appendWindowStart: this.appendWindowStart, appendWindowEnd: this.appendWindowEnd, mode: this.mode })
      this.owner.readyState = 'open'
      this.chunks.push([...chunk])
      this.ranges.push([...chunk].slice(-2))
      this.ranges.sort((a,b) => a[0]-b[0])
      this.ranges = this.ranges.reduce((result, range) => {
        if (result.length && result.at(-1)[1] >= range[0]) result.at(-1)[1] = Math.max(result.at(-1)[1], range[1])
        else result.push(range)
        return result
      }, [])
      this.updating = true
      if (!this.hold) queueMicrotask(() => this.complete())
    }
    complete() { this.updating = false; this.dispatchEvent(new Event('updateend')) }
    remove() { this.ranges = []; this.complete() }
    changeType() {}
    abort() { this.aborts = (this.aborts ?? 0) + 1; this.appendWindowStart = 0; this.appendWindowEnd = Infinity }
  }
  class Source extends EventTarget {
    static isTypeSupported() { return true }
    constructor() { super(); this.readyState = 'closed'; this.buffers = []; this.ends = []; instances.push(this) }
    addSourceBuffer() { const sb = new Buffer(this); this.buffers.push(sb); return sb }
    endOfStream(error) { this.ends.push(error); this.readyState = 'ended' }
  }
  class Audio extends EventTarget {
    constructor() { super(); this.currentTime = 0; this.paused = false; this.source = ''; this.errors = []; this.warnings = []; this.addEventListener('captureerror', e => this.errors.push(e.detail)); this.addEventListener('capturewarning', e => this.warnings.push(e.detail)) }
    get src() { return this.source }
    set src(value) {
      const previous = urls.get(this.source)
      this.source = value
      this.currentTime = 0
      if (previous) { previous.readyState = 'closed'; previous.dispatchEvent(new Event('sourceclose')) }
      const source = urls.get(value)
      if (source) queueMicrotask(() => { source.readyState = 'open'; source.dispatchEvent(new Event('sourceopen')) })
    }
    play() { this.paused = false; return Promise.resolve() }
    seek(at) { this.currentTime = at; this.dispatchEvent(new Event('seeking')) }
  }
  t.mock.method(URL, 'createObjectURL', source => { const url = `blob:capture-${urls.size}`; urls.set(url, source); return url })
  t.mock.method(URL, 'revokeObjectURL', url => { revoked.push(url) })
  const oldWindow = globalThis.window
  const oldSource = globalThis.MediaSource
  globalThis.window = { __TAURI_INTERNALS__: { invoke } }
  globalThis.MediaSource = Source
  t.after(() => { globalThis.window = oldWindow; globalThis.MediaSource = oldSource })
  return { audio: new Audio(), instances, revoked }
}

test('cancelar un IPC pendiente descarta bytes tardíos y sólo revoca la URL propia', async t => {
  let deliver, reads = 0
  const env = environment(t, command => command === 'capture_read' ? (++reads, new Promise(r => { deliver = r })) : Promise.resolve())
  const stop = playCapture(env.audio, 'aaaaaaaaaaa')
  await settle(() => reads === 1)
  stop(); env.audio.src = 'blob:otra-cancion'
  deliver(packet({ chunks: [[255, 0, 2]] }))
  await tick()
  assert.equal(env.instances[0].buffers.length, 0)
  assert(!env.revoked.includes('blob:otra-cancion'))
  assert.deepEqual(env.audio.errors, [])
})

test('cancelar antes de sourceopen no inicia IPC', async t => {
  let calls = 0
  const env = environment(t, () => { calls++; return Promise.resolve(packet()) })
  playCapture(env.audio, 'aaaaaaaaaaa')()
  await tick()
  assert.equal(calls, 0)
})

test('los primeros tramos se añaden antes de complete y el init compatible se omite', async t => {
  const requests = []
  const env = environment(t, (command, args) => {
    if (command !== 'capture_read') return Promise.resolve()
    requests.push(args)
    if (args.from < 2) return Promise.resolve(packet({ from: args.from, chunks: [[255, args.from * 2, args.from * 2 + 2]] }))
    return new Promise(() => {})
  })
  const stop = playCapture(env.audio, 'aaaaaaaaaaa'); t.after(stop)
  await settle(() => captureProgress(env.audio)?.units === 2)
  assert.deepEqual(env.instances[0].buffers[0].chunks, [[255, 0, 2], [2, 4]])
  assert.deepEqual(env.instances[0].ends, [])
  assert.equal(captureProgress(env.audio).complete, false)
  assert.equal(requests[2].from, 2)
})

test('complete nativo no cierra MSE hasta consumir todos los lotes y updateend', async t => {
  const env = environment(t, (command, args) => {
    if (command !== 'capture_read') return Promise.resolve()
    return Promise.resolve(packet({ from: args.from, complete: true, ranges: [{ start: 0, end: 100 }],
      chunks: args.from < 2 ? [[255, args.from * 50, args.from * 50 + 50]] : [] }))
  })
  const Source = globalThis.MediaSource, add = Source.prototype.addSourceBuffer
  t.mock.method(Source.prototype, 'addSourceBuffer', function (...args) { const sb = add.apply(this, args); sb.hold = true; return sb })
  const stop = playCapture(env.audio, 'aaaaaaaaaaa'); t.after(stop)
  await settle(() => env.instances[0].buffers[0]?.chunks.length === 1)
  const sb = env.instances[0].buffers[0]
  assert.deepEqual(env.instances[0].ends, [])
  sb.complete()
  await settle(() => sb.chunks.length === 2)
  assert.deepEqual(env.instances[0].ends, [])
  sb.complete()
  await settle(() => env.instances[0].ends.length === 1)
  assert.deepEqual(env.instances[0].ends, [undefined])
})

test('seek a 80% conserva buffer y reloj actuales hasta que el destino se puede reproducir', async t => {
  let sought = false
  const calls = []
  const env = environment(t, (command, args) => {
    calls.push([command, args])
    if (command === 'capture_seek') { sought = true; return Promise.resolve({ requestId: args.requestId, generation: 3, epoch: 2, cached: false }) }
    if (command !== 'capture_read') return Promise.resolve()
    if (!args.from) return Promise.resolve(packet({ chunks: [[255, 0, 10]], ranges: [{ start: 0, end: 10 }] }))
    if (sought && args.from === 1) return Promise.resolve(packet({ from: 1, chunks: [[255, 79, 85]], units: [unit(79, 85, { epoch: 2 })] }))
    return Promise.resolve(packet({ from: args.from }))
  })
  const stop = playCapture(env.audio, 'aaaaaaaaaaa'); t.after(stop)
  await settle(() => captureProgress(env.audio)?.units === 1)
  env.audio.currentTime = 4
  const pending = seekCapture(env.audio, 80)
  assert.equal(env.audio.currentTime, 4)
  assert.equal(await pending, true)
  assert.equal(env.audio.currentTime, 80)
  assert.equal(env.instances.length, 1)
  assert.deepEqual(env.instances[0].buffers[0].ranges, [[0, 10], [79, 85]])
  assert.equal(env.instances[0].buffers[0].aborts, 1)
  assert.deepEqual(calls.find(([c]) => c === 'capture_seek')[1], { videoId: 'aaaaaaaaaaa', at: 80, generation: 3, requestId: 1 })
})

test('un reply antiguo de seek no pisa el destino más reciente', async t => {
  const pending = []
  let emitted = false
  const env = environment(t, (command, args) => {
    if (command === 'capture_seek') return new Promise(resolve => pending.push({ args, resolve }))
    if (command !== 'capture_read') return Promise.resolve()
    if (!emitted) { emitted = true; return Promise.resolve(packet({ chunks: [[255, 0, 100]], complete: true, ranges: [{ start: 0, end: 100 }] })) }
    return Promise.resolve(packet({ from: args.from, complete: true, ranges: [{ start: 0, end: 100 }] }))
  })
  const stop = playCapture(env.audio, 'aaaaaaaaaaa'); t.after(stop)
  await settle(() => env.instances[0].ends.length === 1)
  env.instances[0].buffers[0].ranges = [[0, 10]]
  const first = seekCapture(env.audio, 40), second = seekCapture(env.audio, 80)
  await settle(() => pending.length === 2)
  env.instances[0].buffers[0].ranges = [[0, 100]]
  pending[1].resolve({ requestId: 2, generation: 3, cached: false })
  assert.equal(await second, true)
  pending[0].resolve({ requestId: 1, generation: 3, cached: false })
  assert.equal(await first, false)
  assert.equal(env.audio.currentTime, 80)
})

test('replay de caché tras evicción repone sólo unidades ausentes sin crear otro MediaSource', async t => {
  const env = environment(t, (command, args) => {
    if (command === 'capture_seek') return Promise.resolve({ requestId: args.requestId, generation: 3, cached: true, from: 0 })
    if (command !== 'capture_read') return Promise.resolve()
    return Promise.resolve(packet({ from: args.from, chunks: args.from === 0 ? [[255, 0, 50], [255, 50, 100]] : [],
      complete: true, ranges: [{ start: 0, end: 100 }] }))
  })
  const stop = playCapture(env.audio, 'aaaaaaaaaaa'); t.after(stop)
  await settle(() => env.instances[0].ends.length === 1)
  const sb = env.instances[0].buffers[0]; sb.ranges = [[50, 100]]
  assert.equal(await seekCapture(env.audio, 20), true)
  assert.equal(env.instances.length, 1)
  assert.equal(sb.chunks.length, 3)
  assert.deepEqual(sb.ranges, [[0, 100]])
})

test('fallo parcial conserva el audio verificado, pide recuperación y no declara EOF', async t => {
  let seeks = 0
  const env = environment(t, (command, args) => {
    if (command === 'capture_seek') { seeks++; return Promise.resolve({ requestId: args.requestId, generation: 3, cached: false }) }
    if (command !== 'capture_read') return Promise.resolve()
    return Promise.resolve(packet({ from: args.from, chunks: args.from === 0 ? [[255, 0, 90]] : [], ranges: [{ start: 0, end: 90 }], softError: 'CAPTURE_GAP: falta el final' }))
  })
  const stop = playCapture(env.audio, 'aaaaaaaaaaa'); t.after(stop)
  await settle(() => env.audio.warnings.some(message => /Captura incompleta/.test(message)))
  assert.equal(seeks, 2)
  assert.deepEqual(env.audio.errors, [])
  assert.deepEqual(env.instances[0].ends, [])
  assert.deepEqual(env.instances[0].buffers[0].ranges, [[0, 90]])
  assert.equal(env.audio.paused, false)
})

test('unknown sin audio es un error explícito y nunca EOS correcto', async t => {
  const env = environment(t, () => Promise.resolve(packet({ error: 'unknown: identidad sin confirmar' })))
  const stop = playCapture(env.audio, 'aaaaaaaaaaa'); t.after(stop)
  await settle(() => env.audio.errors.length === 1)
  assert.match(env.audio.errors[0], /unknown/)
  assert.deepEqual(env.instances[0].ends, [])
})

test('cancelar durante append no entrega la siguiente unidad ni publica progreso', async t => {
  const env = environment(t, () => Promise.resolve(packet({ chunks: [[255, 0, 50], [255, 50, 100]] })))
  const Source = globalThis.MediaSource, add = Source.prototype.addSourceBuffer
  t.mock.method(Source.prototype, 'addSourceBuffer', function (...args) { const sb = add.apply(this, args); sb.hold = true; return sb })
  const stop = playCapture(env.audio, 'aaaaaaaaaaa')
  await settle(() => env.instances[0].buffers[0]?.chunks.length === 1)
  stop(); env.instances[0].buffers[0].complete(); await tick()
  assert.equal(env.instances[0].buffers[0].chunks.length, 1)
  assert.equal(captureProgress(env.audio), null)
  assert.deepEqual(env.audio.errors, [])
})

test('AAC restaura offsets y ventanas al pasar de época sin retirar los rangos anteriores', async t => {
  const aac = { timestampOffset: -0.036281179138321996, appendWindowStart: 0, appendWindowEnd: 187.33333333333334, mode: 'segments' }
  const env = environment(t, (command, args) => command !== 'capture_read' ? Promise.resolve() : args.from === 0
    ? Promise.resolve(packet({ chunks: [[255, 0, 5], [255, 80, 85]], units: [unit(0, 5, { timelineSettings: aac }), unit(80, 85, { epoch: 2, timelineSettings: aac })] }))
    : new Promise(() => {}))
  const stop = playCapture(env.audio, 'aaaaaaaaaaa'); t.after(stop)
  await settle(() => captureProgress(env.audio)?.units === 2)
  assert.deepEqual(env.instances[0].buffers[0].timelineAtAppend, [aac, aac])
  assert.deepEqual(env.instances[0].buffers[0].ranges, [[0, 5], [80, 85]])
})

for (const [name, change] of [
  ['unidad no verificada', { verified: false }], ['frames vacío', { frames: 0 }], ['inicio invertido', { rangeStart: 10 }],
  ['init fuera de bytes', { initBytes: 3 }], ['ventana inválida', { timelineSettings: { ...timeline, appendWindowEnd: 0 } }],
  ['timeline ausente', { timelineSettings: undefined }],
]) test(`rechaza ${name} antes de append`, async t => {
  const env = environment(t, () => Promise.resolve(packet({ chunks: [[255, 0, 5]], units: [unit(0, 5, change)] })))
  const stop = playCapture(env.audio, 'aaaaaaaaaaa'); t.after(stop)
  await settle(() => env.audio.errors.length === 1)
  assert.equal(env.instances[0].buffers.length, 0)
})

test('la ruta legacy conserva su protocolo e IPC separado', async t => {
  const calls = []
  const env = environment(t, (command, args) => { calls.push([command, args]); return new Promise(() => {}) })
  const stop = prepareAudioSource(env.audio, 'musify-capture-legacy:aaaaaaaaaaa'); t.after(stop)
  await settle(() => calls.length === 1)
  assert.deepEqual(calls[0], ['capture_legacy_read', { videoId: 'aaaaaaaaaaa', from: 0 }])
})

test('una ventana nueva puede reutilizar el nombre initKey pero recibe su init real', async t => {
  const env = environment(t, (command, args) => {
    if (command !== 'capture_read') return Promise.resolve()
    if (!args.from) return Promise.resolve(packet({ chunks: [[255, 0, 5]] }))
    if (args.from === 1) return Promise.resolve(packet({ from: 1, generation: 4, chunks: [[254, 5, 10]], units: [unit(5, 10)] }))
    return new Promise(() => {})
  })
  const stop = playCapture(env.audio, 'aaaaaaaaaaa'); t.after(stop)
  await settle(() => captureProgress(env.audio)?.units === 2)
  assert.equal(env.instances.length, 1)
  assert.deepEqual(env.instances[0].buffers[0].chunks, [[255, 0, 5], [254, 5, 10]])
  assert.deepEqual(env.audio.warnings, [])
})

test('un initKey no puede esconder bytes de inicialización diferentes en la misma generación', async t => {
  const env = environment(t, (command, args) => command !== 'capture_read' ? Promise.resolve() : Promise.resolve(packet({ from: args.from,
    chunks: [[args.from ? 254 : 255, args.from * 5, args.from * 5 + 5]] })))
  const stop = playCapture(env.audio, 'aaaaaaaaaaa'); t.after(stop)
  await settle(() => env.audio.warnings.length === 1)
  assert.match(env.audio.warnings[0], /inicialización/)
  assert.deepEqual(env.instances[0].buffers[0].chunks, [[255, 0, 5]])
  assert.deepEqual(env.instances[0].ends, [])
})

test('no se mezclan ventanas de append distintas dentro de una época', async t => {
  const env = environment(t, (command, args) => command !== 'capture_read' ? Promise.resolve() : Promise.resolve(packet({ from: args.from,
    chunks: [[255, args.from * 5, args.from * 5 + 5]], units: [unit(args.from * 5, args.from * 5 + 5,
      { timelineSettings: { ...timeline, timestampOffset: args.from ? -0.03 : 0 } })] })))
  const stop = playCapture(env.audio, 'aaaaaaaaaaa'); t.after(stop)
  await settle(() => env.audio.warnings.length === 1)
  assert.match(env.audio.warnings[0], /dentro de una época/)
  assert.equal(env.instances[0].buffers[0].chunks.length, 1)
})

test('complete nativo con un hueco real en MSE reintenta de forma acotada y no corta lo que suena', async t => {
  let seeks = 0
  const env = environment(t, (command, args) => {
    if (command === 'capture_seek') { seeks++; return Promise.resolve({ requestId: args.requestId, generation: 3, cached: true, from: 0 }) }
    if (command !== 'capture_read') return Promise.resolve()
    return Promise.resolve(packet({ from: args.from, chunks: args.from === 0 ? [[255, 0, 100]] : [],
      complete: true, ranges: [{ start: 0, end: 100 }] }))
  })
  const Source = globalThis.MediaSource, add = Source.prototype.addSourceBuffer
  t.mock.method(Source.prototype, 'addSourceBuffer', function (...args) {
    const sb = add.apply(this, args), append = sb.appendBuffer
    sb.appendBuffer = function (chunk) { append.call(this, chunk); this.ranges = [[0, 90]] }
    return sb
  })
  const stop = playCapture(env.audio, 'aaaaaaaaaaa'); t.after(stop)
  await settle(() => env.audio.warnings.some(message => /Captura incompleta/.test(message)))
  assert.equal(seeks, 2)
  assert.equal(env.instances.length, 1)
  assert.deepEqual(env.instances[0].ends, [])
  assert.deepEqual(env.audio.errors, [])
  assert.equal(env.audio.paused, false)
  assert.equal(env.instances[0].duration, 100)
})

test('EOF usa el extremo de audio verificado y no inventa un hueco hasta la duración del vídeo', async t => {
  const env = environment(t, (command, args) => command !== 'capture_read' ? Promise.resolve() :
    Promise.resolve(packet({ from: args.from, chunks: args.from === 0 ? [[255, 0, 99]] : [],
      complete: true, audioDuration: 99, duration: 100, ranges: [{ start: 0, end: 99 }] })))
  const stop = playCapture(env.audio, 'aaaaaaaaaaa'); t.after(stop)
  await settle(() => env.instances[0].ends.length === 1)
  assert.equal(captureProgress(env.audio).duration, 100)
  assert.equal(captureProgress(env.audio).audioDuration, 99)
  assert.deepEqual(env.audio.warnings, [])
})

test('un seek vigente puede reabrir otra generación y conserva el ledger', async t => {
  let generation = 3, sought = false
  const env = environment(t, (command, args) => {
    if (command === 'capture_seek') { generation = 4; sought = true; return Promise.resolve({ requestId: args.requestId, generation, cached: false }) }
    if (command !== 'capture_read') return Promise.resolve()
    if (!args.from) return Promise.resolve(packet({ generation, chunks: [[255, 0, 10]] }))
    if (sought && args.from === 1) return Promise.resolve(packet({ generation, from: 1, chunks: [[254, 79, 85]] }))
    return Promise.resolve(packet({ generation, from: args.from }))
  })
  const stop = playCapture(env.audio, 'aaaaaaaaaaa'); t.after(stop)
  await settle(() => captureProgress(env.audio)?.units === 1)
  assert.equal(await seekCapture(env.audio, 80), true)
  assert.equal(env.audio.currentTime, 80)
  assert.equal(env.instances.length, 1)
  assert.deepEqual(env.instances[0].buffers[0].ranges, [[0, 10], [79, 85]])
})

test('reabrir generaciones sin ampliar el rango no reinicia la recuperación automática', async t => {
  let generation = 3, seeks = 0
  const env = environment(t, (command, args) => {
    if (command === 'capture_seek') { seeks++; generation++; return Promise.resolve({ requestId: args.requestId, generation, cached: false }) }
    if (command !== 'capture_read') return Promise.resolve()
    return Promise.resolve(packet({ generation, from: args.from, chunks: args.from === 0 ? [[255, 0, 90]] : [],
      ranges: [{ start: 0, end: 90 }], softError: 'CAPTURE_FAILED: sin avance' }))
  })
  const stop = playCapture(env.audio, 'aaaaaaaaaaa'); t.after(stop)
  await settle(() => env.audio.warnings.some(message => /Captura incompleta/.test(message)))
  assert.equal(seeks, 2)
  assert.equal(env.instances.length, 1)
  assert.deepEqual(env.instances[0].ends, [])
})

test('EOF local permite terminar el tramo elegido mientras continúa backfill sin fingir complete global', async t => {
  let backfilled = false
  const env = environment(t, (command, args) => {
    if (command !== 'capture_read') return Promise.resolve()
    if (!args.from) return Promise.resolve(packet({ chunks: [[255, 80, 100]], audioDuration: 100,
      ranges: [{ start: 80, end: 100 }], recovering: true }))
    if (backfilled && args.from === 1) return Promise.resolve(packet({ from: 1, chunks: [[255, 0, 80]],
      units: [unit(0, 80, { epoch: 2 })], audioDuration: 100, complete: true, ranges: [{ start: 0, end: 100 }] }))
    return Promise.resolve(packet({ from: args.from, audioDuration: 100, complete: backfilled,
      ranges: [{ start: backfilled ? 0 : 80, end: 100 }], recovering: !backfilled }))
  })
  const stop = playCapture(env.audio, 'aaaaaaaaaaa'); t.after(stop)
  await settle(() => captureProgress(env.audio)?.units === 1)
  env.audio.currentTime = 85
  await settle(() => env.instances[0].ends.length === 1)
  assert.equal(captureProgress(env.audio).complete, false)
  assert.deepEqual(captureProgress(env.audio).ranges, [{ start: 80, end: 100 }])
  backfilled = true
  await settle(() => captureProgress(env.audio)?.complete === true && env.instances[0].ends.length === 2)
  assert.equal(env.instances.length, 1)
  assert.deepEqual(env.instances[0].buffers[0].ranges, [[0, 100]])
})

for (const [name, end, audioDuration] of [['falta EOF probado', 100, null], ['queda un hueco después del reloj', 90, 100]]) {
  test(`EOF parcial no se permite si ${name}`, async t => {
    const env = environment(t, (command, args) => command !== 'capture_read' ? Promise.resolve() :
      Promise.resolve(packet({ from: args.from, chunks: args.from === 0 ? [[255, 80, end]] : [],
        audioDuration, ranges: [{ start: 80, end }], recovering: true })))
    const stop = playCapture(env.audio, 'aaaaaaaaaaa'); t.after(stop)
    await settle(() => captureProgress(env.audio)?.units === 1)
    env.audio.currentTime = 85
    await new Promise(resolve => setTimeout(resolve, 70))
    assert.deepEqual(env.instances[0].ends, [])
    assert.equal(captureProgress(env.audio).complete, false)
  })
}

test('el lector legacy cancela sólo la generación que llegó a leer', async t => {
  const calls = []
  const env = environment(t, (command, args) => {
    calls.push([command, args])
    if (command !== 'capture_legacy_read') return Promise.resolve()
    return Promise.resolve(packet({ from: args.from, chunks: args.from === 0 ? [[0, 100]] : [],
      mime: 'audio/webm; codecs="opus"', mimes: ['audio/webm; codecs="opus"'], done: true, generation: 7 }))
  })
  const stop = prepareAudioSource(env.audio, 'musify-capture-legacy:aaaaaaaaaaa'); t.after(stop)
  await settle(() => env.instances[0].ends.length === 1)
  stop()
  assert.deepEqual(calls.find(([command]) => command === 'capture_legacy_cancel'),
    ['capture_legacy_cancel', { videoId: 'aaaaaaaaaaa', generation: 7 }])
})
