import assert from 'node:assert/strict'
import { test } from 'node:test'
import { playCapture } from '../src/lib/extractor/capture.ts'

const tick = () => new Promise(resolve => setImmediate(resolve))
async function settle(predicate) {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return
    await tick()
  }
  assert.fail('La operación no terminó')
}
function packet({ chunks = [], ...changes } = {}) {
  const head = new TextEncoder().encode(JSON.stringify({
    mime: 'audio/webm; codecs="opus"', mimes: chunks.map(() => 'audio/webm; codecs="opus"'),
    duration: 100, done: true, error: null, revision: 9, generation: 3, reset: false,
    from: 0, next: chunks.length, ...changes,
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
      this.ranges.push([...chunk])
      this.updating = true
      if (!this.hold) queueMicrotask(() => this.complete())
    }
    complete() { this.updating = false; this.dispatchEvent(new Event('updateend')) }
    remove() { this.ranges = []; this.complete() }
    changeType() {}
  }
  class Source extends EventTarget {
    static isTypeSupported() { return true }
    constructor() { super(); this.readyState = 'closed'; this.buffers = []; this.ends = []; instances.push(this) }
    addSourceBuffer() { const sb = new Buffer(this); this.buffers.push(sb); return sb }
    endOfStream(error) { this.ends.push(error); this.readyState = 'ended' }
  }
  class Audio extends EventTarget {
    constructor() { super(); this.currentTime = 0; this.paused = false; this.source = ''; this.errors = []; this.addEventListener('captureerror', e => this.errors.push(e.detail)) }
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

test('cambiar canción durante IPC descarta la respuesta y revoca únicamente su propia URL', async t => {
  let deliver
  let reads = 0
  const env = environment(t, command => {
    if (command === 'capture_read') { reads++; return new Promise(resolve => { deliver = resolve }) }
  })
  const stop = playCapture(env.audio, 'aaaaaaaaaaa')
  await settle(() => reads === 1)
  stop()
  env.audio.src = 'blob:otra-cancion'
  deliver(packet({ chunks: [[0, 100]] }))
  await tick()
  assert.equal(env.instances[0].buffers.length, 0)
  assert(!env.revoked.includes('blob:otra-cancion'))
  assert.equal(env.audio.errors.length, 0)
})

test('cancelar antes de sourceopen no inicia IPC ni revoca la URL de la siguiente canción', async t => {
  let reads = 0
  const env = environment(t, () => { reads++; return Promise.resolve(packet()) })
  const stop = playCapture(env.audio, 'aaaaaaaaaaa')
  stop()
  env.audio.src = 'blob:otra-cancion'
  await tick()
  assert.equal(reads, 0)
  assert(!env.revoked.includes('blob:otra-cancion'))
})

test('un seek a un hueco después de EOS despierta el lector con el cursor correcto', async t => {
  const calls = []
  let reads = 0
  const env = environment(t, (command, args) => {
    calls.push([command, args])
    if (command !== 'capture_read') return Promise.resolve()
    reads++
    if (reads === 1) return Promise.resolve(packet({ chunks: [[0, 100]] }))
    if (reads === 3) return Promise.resolve(packet({ chunks: [[40, 100]], from: 1, next: 2 }))
    return Promise.resolve(packet({ from: reads > 2 ? 2 : 1, next: reads > 2 ? 2 : 1 }))
  })
  const stop = playCapture(env.audio, 'aaaaaaaaaaa')
  t.after(stop)
  await settle(() => env.instances[0].ends.length === 1)
  assert.equal(reads, 2)
  const sb = env.instances[0].buffers[0]
  sb.ranges = [[0, 20], [60, 100]]
  env.audio.seek(40)
  await settle(() => env.instances[0].ends.length === 2)
  assert.equal(reads, 4)
  assert.deepEqual(sb.chunks, [[0, 100], [40, 100]])
  assert.deepEqual(calls.filter(([c]) => c === 'capture_read')[2][1], { videoId: 'aaaaaaaaaaa', from: 1, revision: 9 })
  assert.equal(calls.find(([c]) => c === 'capture_seek')[1].at, 39)
})

test('un error desconocido del backend se muestra y no se marca EOS correcto', async t => {
  const env = environment(t, command => command === 'capture_read'
    ? Promise.resolve(packet({ error: 'unknown: no se pudo atribuir la fuente', mime: '' })) : Promise.resolve())
  const stop = playCapture(env.audio, 'aaaaaaaaaaa')
  t.after(stop)
  await settle(() => env.audio.errors.length > 0)
  await tick()
  assert.match(env.audio.errors[0], /unknown/)
  assert.deepEqual(env.instances[0].ends, ['network'])
})

test('al cancelar durante append no se añade el siguiente segmento ni se espera updateend', async t => {
  let reads = 0
  const env = environment(t, command => {
    if (command !== 'capture_read') return Promise.resolve()
    reads++
    return Promise.resolve(packet({ chunks: [[0, 50], [50, 100]] }))
  })
  const Source = globalThis.MediaSource
  const add = Source.prototype.addSourceBuffer
  t.mock.method(Source.prototype, 'addSourceBuffer', function (...args) { const sb = add.apply(this, args); sb.hold = true; return sb })
  const stop = playCapture(env.audio, 'aaaaaaaaaaa')
  await settle(() => env.instances[0].buffers[0]?.chunks.length === 1)
  stop()
  env.instances[0].buffers[0].complete()
  await tick()
  assert.equal(reads, 1)
  assert.equal(env.instances[0].buffers[0].chunks.length, 1)
  assert.equal(env.audio.errors.length, 0)
})

test('cambiar revision recrea el parser y vuelve a pedir desde cero sin mezclar capturas', async t => {
  let reads = 0
  const requests = []
  const env = environment(t, (command, args) => {
    if (command !== 'capture_read') return Promise.resolve()
    requests.push(args)
    reads++
    if (reads === 1) return Promise.resolve(packet({ chunks: [[0, 100]], done: false }))
    if (reads === 2) return Promise.resolve(packet({ chunks: [[0, 100]], revision: 10, reset: true, from: 0 }))
    if (reads === 3) return Promise.resolve(packet({ chunks: [[0, 100]], revision: 10 }))
    return Promise.resolve(packet({ next: 1, from: 1, revision: 10 }))
  })
  const stop = playCapture(env.audio, 'aaaaaaaaaaa')
  t.after(stop)
  await settle(() => env.instances[1]?.ends.length === 1)
  assert.equal(env.instances[0].buffers[0].chunks.length, 1)
  assert.equal(env.instances[1].buffers[0].chunks.length, 1)
  assert.equal(requests[2].from, 0)
  assert.equal(requests[2].revision, 10)
})

for (const [name, states, expectedSeeks, incomplete] of [
  ['falla tras un replay si la misma captura sigue truncada', [[3, 90], [3, 90]], 1, true],
  ['falla si el replay de la misma captura incluso pierde cobertura', [[3, 90], [3, 80]], 1, true],
  ['permite otro intento si el buffer recuperado avanza de verdad', [[3, 80], [3, 90], [3, 100]], 2, false],
  ['permite el primer intento de una generación nueva aunque termine en el mismo punto', [[3, 90], [4, 90], [4, 100]], 2, false],
]) {
  test(name, async t => {
    let seeks = 0
    let reads = 0
    const env = environment(t, (command, args) => {
      if (command === 'capture_seek') { seeks++; return Promise.resolve() }
      if (command !== 'capture_read') return Promise.resolve()
      // Cota del backend simulado: una regresión no puede atascar el proceso de pruebas.
      if (++reads > 12) return Promise.reject(new Error('Se excedieron las lecturas de replay permitidas'))
      const revision = 9 + seeks
      const [generation, end] = states[Math.min(seeks, states.length - 1)]
      const reset = args.revision !== undefined && args.revision !== revision
      const from = reset ? 0 : args.from
      return Promise.resolve(packet({ revision, generation, reset, from, next: 1, chunks: from === 0 ? [[0, end]] : [] }))
    })
    const stop = playCapture(env.audio, 'aaaaaaaaaaa')
    t.after(stop)
    await settle(() => incomplete ? env.audio.errors.length > 0 : env.instances.at(-1)?.ends.length > 0)
    assert.equal(seeks, expectedSeeks)
    assert.equal(env.instances.length, expectedSeeks + 1)
    assert(env.instances.every(source => source.duration === 100), 'la duración esperada no se acorta para aceptar la captura')
    if (incomplete) assert.match(env.audio.errors[0], /Captura incompleta/)
    else assert.deepEqual(env.audio.errors, [])
    const finalReads = reads
    await tick()
    assert.equal(reads, finalReads)
  })
}

test('los errores de SourceBuffer abortan el lote y no se confunden con updateend', async t => {
  const env = environment(t, command => command === 'capture_read'
    ? Promise.resolve(packet({ chunks: [[0, 50], [50, 100]] })) : Promise.resolve())
  const Source = globalThis.MediaSource
  const add = Source.prototype.addSourceBuffer
  t.mock.method(Source.prototype, 'addSourceBuffer', function (...args) {
    const sb = add.apply(this, args)
    sb.hold = true
    return sb
  })
  const stop = playCapture(env.audio, 'aaaaaaaaaaa')
  t.after(stop)
  await settle(() => env.instances[0].buffers[0]?.chunks.length === 1)
  const sb = env.instances[0].buffers[0]
  sb.updating = false
  sb.dispatchEvent(new Event('error'))
  sb.dispatchEvent(new Event('updateend'))
  await settle(() => env.audio.errors.length === 1)
  assert.equal(sb.chunks.length, 1)
  assert.match(env.audio.errors[0], /rechazó el audio/)
})

const aacTimeline = { timestampOffset: -0.036281179138321996, appendWindowStart: 0, appendWindowEnd: 187.33333333333334, mode: 'segments' }
const defaultTimeline = { timestampOffset: 0, appendWindowStart: 0, appendWindowEnd: null, mode: 'segments' }

for (const [name, settings] of [
  ['los ajustes AAC de la fuente', aacTimeline],
  ['una ventana sin fin (null se convierte en Infinity)', defaultTimeline],
  ['los valores históricos cuando falta la propiedad', undefined],
]) {
  test(`aplica ${name} antes del primer append`, async t => {
    let reads = 0
    const env = environment(t, command => command === 'capture_read'
      ? Promise.resolve(packet({ chunks: ++reads === 1 ? [[0, 100]] : [], next: 1, timelineSettings: settings })) : Promise.resolve())
    const stop = playCapture(env.audio, 'aaaaaaaaaaa')
    t.after(stop)
    await settle(() => env.instances[0].ends.length === 1)
    const expected = settings ?? defaultTimeline
    assert.deepEqual(env.instances[0].buffers[0].timelineAtAppend, [{ ...expected, appendWindowEnd: expected.appendWindowEnd ?? Infinity }])
    assert.deepEqual(env.audio.errors, [])
  })
}

test('reconstruir por una revisión nueva restaura sus ajustes antes de volver a añadir audio', async t => {
  let reads = 0
  const env = environment(t, command => {
    if (command !== 'capture_read') return Promise.resolve()
    reads++
    if (reads === 1) return Promise.resolve(packet({ chunks: [[0, 100]], done: false, timelineSettings: defaultTimeline }))
    return Promise.resolve(packet({
      chunks: reads <= 3 ? [[0, 100]] : [], next: 1, revision: 10,
      reset: reads === 2, from: reads <= 3 ? 0 : 1, timelineSettings: aacTimeline,
    }))
  })
  const stop = playCapture(env.audio, 'aaaaaaaaaaa')
  t.after(stop)
  await settle(() => env.instances[1]?.ends.length === 1)
  assert.deepEqual(env.instances[0].buffers[0].timelineAtAppend, [{ ...defaultTimeline, appendWindowEnd: Infinity }])
  assert.deepEqual(env.instances[1].buffers[0].timelineAtAppend, [aacTimeline])
  assert.deepEqual(env.audio.errors, [])
})

test('una cabecera de espera sin formato no fija los ajustes de la fuente todavía no verificada', async t => {
  let reads = 0
  const env = environment(t, command => {
    if (command !== 'capture_read') return Promise.resolve()
    reads++
    if (reads === 1) return Promise.resolve(packet({ mime: '', done: false, duration: null, timelineSettings: null }))
    return Promise.resolve(packet({ chunks: reads === 2 ? [[0, 100]] : [], next: 1, timelineSettings: aacTimeline }))
  })
  const stop = playCapture(env.audio, 'aaaaaaaaaaa')
  t.after(stop)
  await new Promise(resolve => setTimeout(resolve, 60))
  await settle(() => env.instances[0].ends.length === 1)
  assert.deepEqual(env.instances[0].buffers[0].timelineAtAppend, [aacTimeline])
  assert.deepEqual(env.audio.errors, [])
})

test('no mezcla audio cuando los ajustes cambian dentro de una misma revisión', async t => {
  let reads = 0
  const env = environment(t, command => command === 'capture_read'
    ? Promise.resolve(packet({ chunks: [[0, 100]], timelineSettings: ++reads === 1 ? defaultTimeline : aacTimeline })) : Promise.resolve())
  const stop = playCapture(env.audio, 'aaaaaaaaaaa')
  t.after(stop)
  await settle(() => env.audio.errors.length === 1)
  assert.equal(env.instances[0].buffers[0].chunks.length, 1)
  assert.match(env.audio.errors[0], /misma revisión/)
})

test('null deja de ser admisible tras recibir ajustes verificados aunque el lote esté vacío', async t => {
  let reads = 0
  const env = environment(t, command => {
    if (command !== 'capture_read') return Promise.resolve()
    return Promise.resolve(++reads === 1
      ? packet({ chunks: [[0, 100]], timelineSettings: aacTimeline })
      : packet({ mime: '', next: 1, timelineSettings: null }))
  })
  const stop = playCapture(env.audio, 'aaaaaaaaaaa')
  t.after(stop)
  await settle(() => env.audio.errors.length === 1)
  assert.equal(env.instances[0].buffers[0].chunks.length, 1)
  assert.match(env.audio.errors[0], /Desaparecieron.*misma revisión/)
})

for (const [name, settings] of [
  ['tuple nulo', null],
  ['offset no finito', { ...defaultTimeline, timestampOffset: null }],
  ['offset string', { ...defaultTimeline, timestampOffset: '0' }],
  ['inicio negativo', { ...defaultTimeline, appendWindowStart: -1 }],
  ['fin igual al inicio', { ...defaultTimeline, appendWindowStart: 1, appendWindowEnd: 1 }],
  ['fin anterior al inicio', { ...defaultTimeline, appendWindowStart: 2, appendWindowEnd: 1 }],
  ['campo faltante', { timestampOffset: 0, appendWindowStart: 0, mode: 'segments' }],
  ['modo sequence', { ...defaultTimeline, mode: 'sequence' }],
]) {
  test(`rechaza ${name} antes de entregar bytes al navegador`, async t => {
    const env = environment(t, command => command === 'capture_read'
      ? Promise.resolve(packet({ chunks: [[0, 100]], timelineSettings: settings })) : Promise.resolve())
    const stop = playCapture(env.audio, 'aaaaaaaaaaa')
    t.after(stop)
    await settle(() => env.audio.errors.length === 1)
    assert.equal(env.instances[0].buffers.length, 0)
    assert.match(env.audio.errors[0], /temporales.*inválidos/)
  })
}
