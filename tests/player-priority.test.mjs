import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/lib/player.svelte.ts', import.meta.url), 'utf8')
const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText.replace(/^import[^\n]+\n/gm, '')
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
async function settle(predicate) { for (let i = 0; i < 50; i++) { if (predicate()) return; await tick() } assert.fail('La operación no terminó') }
const item = id => ({ track: { id, title: `Track ${id}`, duration: 100, artist: { id: 1, name: 'Artist' } }, albumId: 10, albumTitle: 'Album', artistId: 1, cover: null })
const playable = url => ({ videoId: url.startsWith('musify-capture:') ? url.slice('musify-capture:'.length) : 'aaaaaaaaaaa', url, title: 'Title', channel: 'Artist', local: false })
const captured = id => playable(`musify-capture:${String(id).padStart(11, 'a')}`)
let count = 0
async function setup(t, methods) {
  let audio
  const audios = []
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem() {} } })
  t.after(() => {
    if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor)
    else delete globalThis.localStorage
  })
  const previousAudio = globalThis.Audio
  globalThis.Audio = class extends EventTarget {
    src = ''; currentTime = 0; duration = 100; paused = true; readyState = 4; error = null
    ranges = [{ start: 0, end: 40 }]
    constructor() { super(); audio = this; audios.push(this) }
    get buffered() { return { length: this.ranges.length, start: i => this.ranges[i].start, end: i => this.ranges[i].end } }
    pause() { this.paused = true; this.dispatchEvent(new Event('pause')) }
    play() { this.paused = false; this.dispatchEvent(new Event('playing')); return Promise.resolve() }
    removeAttribute() { this.src = '' }
    load() {}
  }
  t.after(() => { globalThis.Audio = previousAudio })
  const stopped = []
  const progress = new Map()
  const toasts = []
  const key = `__playerTest${++count}`
  globalThis[key] = {
    api: { recordPlay: async () => {}, cancelPrefetch: async () => {}, ...methods },
    convertFileSrc: value => value,
    downloads: { done: new Set(), start() {} },
    setAudioSource: (a, url) => { a.src = url }, stopCapture: (...args) => stopped.push(args),
    CAPTURE: 'musify-capture:', captureProgress: a => progress.get(a) ?? null,
    prepareAudioSource: (a, url) => {
      a.src = url
      if (url.startsWith('musify-capture:')) progress.set(a, { units: 3, generation: 1, revision: 1 })
      return (...args) => { progress.delete(a); stopped.push(['prepared', a, ...args]) }
    },
    adoptAudioSource: () => {}, seekCapture: async (a, at) => { a.currentTime = at; return true },
    library: {}, toLib: value => value, toast: { show: message => toasts.push(message) },
  }
  t.after(() => delete globalThis[key])
  // La reactividad no interviene en estas carreras; sí ejecutamos los métodos privados reales.
  const prelude = `const $state = value => value; const { api, convertFileSrc, downloads, CAPTURE, captureProgress, setAudioSource, stopCapture, prepareAudioSource, adoptAudioSource, seekCapture, library, toLib, toast } = globalThis.${key};\n`
  const { player } = await import(`data:text/javascript;base64,${Buffer.from(prelude + javascript).toString('base64')}`)
  return { player, audio, audios, stopped, toasts, progress, downloads: globalThis[key].downloads }
}

test('el clic promociona la precarga pendiente y su resultado tardío no sustituye la canción', async t => {
  const calls = []
  const background = deferred()
  const foreground = deferred()
  const env = await setup(t, { resolve: (track, refresh, isForeground) => {
    calls.push({ id: track.id, refresh, foreground: isForeground })
    return track.id === 1 ? Promise.resolve(playable('first')) : isForeground ? foreground.promise : background.promise
  } })
  env.player.playQueue([item(1), item(2)], 0)
  await settle(() => calls.length === 2)
  assert.deepEqual(calls[1], { id: 2, refresh: false, foreground: false })
  env.player.next()
  await settle(() => calls.length === 3)
  assert.deepEqual(calls[2], { id: 2, refresh: false, foreground: true })
  foreground.resolve(playable('foreground-second'))
  await settle(() => env.player.status === 'playing')
  background.resolve(playable('obsolete-background-second'))
  await tick()
  assert.equal(env.audio.src, 'foreground-second')
  assert.equal(env.player.current.track.id, 2)
})

test('el motor oficial permite elegir el vídeo sin saltar a la siguiente canción si falta asociación', async t => {
  const calls = []
  const env = await setup(t, { resolve: async track => {
    calls.push(track.id)
    throw new Error('SOURCE_SELECTION_REQUIRED: elige un vídeo en YouTube')
  } })
  env.player.playQueue([item(1), item(2)], 0)
  await settle(() => env.player.picking !== null)
  assert.equal(env.player.picking.track.id, 1)
  assert.equal(env.player.current.track.id, 1)
  assert.equal(env.player.status, 'idle')
  assert.deepEqual(calls, [1])
})

test('cancelar antes de conocer el vídeo termina antes del siguiente resolve y descarta la respuesta vieja', async t => {
  const first = deferred()
  const cancellation = deferred()
  const calls = []
  let cancels = 0
  const env = await setup(t, {
    resolve: (track) => { calls.push(track.id); return track.id === 1 ? first.promise : Promise.resolve(playable('second')) },
    cancelResolve: () => { cancels++; return cancellation.promise },
  })
  env.player.playQueue([item(1)], 0)
  await settle(() => calls.length === 1)
  env.player.toggle()
  assert.equal(env.player.status, 'idle')
  env.player.playQueue([item(2)], 0)
  await settle(() => cancels === 1)
  assert.deepEqual(calls, [1])
  cancellation.resolve()
  await settle(() => env.audio.src === 'second')
  first.resolve(playable('obsolete-first'))
  await tick()
  assert.equal(env.audio.src, 'second')
  assert.equal(env.player.current.track.id, 2)
})

test('A → B → A no reutiliza el primer ticket de A que B ya ha invalidado', async t => {
  const obsoleteA = deferred()
  const obsoleteB = deferred()
  const calls = []
  const env = await setup(t, { resolve: track => {
    calls.push(track.id)
    if (calls.length === 1) return obsoleteA.promise
    if (calls.length === 2) return obsoleteB.promise
    return Promise.resolve(playable('new-A'))
  } })
  env.player.playQueue([item(1), item(2)], 0)
  await settle(() => calls.length === 1)
  env.player.playAt(1)
  await settle(() => calls.length === 2)
  env.player.playAt(0)
  await settle(() => env.audio.src === 'new-A')
  assert.deepEqual(calls.slice(0, 3), [1, 2, 1])
  obsoleteA.reject('CAPTURE_CANCELLED')
  obsoleteB.reject('CAPTURE_CANCELLED')
  await tick()
  assert.equal(env.audio.src, 'new-A')
  assert.equal(env.player.current.track.id, 1)
})

test('la interacción requerida conserva la canción y permite abrir YouTube antes de reintentar', async t => {
  let opened = 0
  const calls = []
  const env = await setup(t, {
    resolve: (track, refresh, foreground) => {
      calls.push({ id: track.id, refresh, foreground })
      return refresh ? Promise.resolve(playable('retry')) : Promise.reject('CAPTURE_REQUIRES_INTERACTION: Inicia sesión')
    },
    showCapture: async () => { opened++ },
  })
  env.player.playQueue([item(1), item(2)], 0)
  await settle(() => env.player.captureInteraction !== null)
  assert.equal(env.player.current.track.id, 1)
  assert.equal(env.player.status, 'idle')
  assert.equal(env.player.captureInteraction, 'Inicia sesión')
  await env.player.openCapture()
  assert.equal(opened, 1)
  env.player.retryCapture()
  await settle(() => env.audio.src === 'retry')
  assert.equal(env.player.captureInteraction, null)
  assert.deepEqual(calls[1], { id: 1, refresh: true, foreground: true })
})

test('captureerror que necesita interacción detiene el lector sin cerrar la ventana oficial', async t => {
  const env = await setup(t, { resolve: async () => playable('musify-capture:aaaaaaaaaaa') })
  env.player.playQueue([item(1)], 0)
  await settle(() => env.player.status === 'playing')
  env.audio.dispatchEvent(new CustomEvent('captureerror', { detail: 'CAPTURE_REQUIRES_INTERACTION: Resuelve el captcha' }))
  assert.deepEqual(env.stopped.at(-1), [false])
  assert.equal(env.player.captureInteraction, 'Resuelve el captcha')
  assert.equal(env.player.status, 'idle')
})

test('elegir el vídeo de otra canción sólo guarda la asociación y conserva el audio actual', async t => {
  const choices = []
  const captures = t.mock.fn(() => { throw new Error('No debe preparar una captura') })
  const env = await setup(t, {
    resolve: async () => playable('currently-playing'),
    chooseSource: captures,
    rememberSource: async (track, videoId) => {
      choices.push({ id: track.id, videoId })
    },
  })
  env.player.playQueue([item(1)], 0)
  await settle(() => env.player.status === 'playing')
  assert.equal(await env.player.useSource('bbbbbbbbbbb', item(2)), true)
  assert.deepEqual(choices, [{ id: 2, videoId: 'bbbbbbbbbbb' }])
  assert.equal(captures.mock.callCount(), 0)
  assert.equal(env.player.current.track.id, 1)
  assert.equal(env.player.status, 'playing')
  assert.equal(env.audio.src, 'currently-playing')
})

test('reintentar tras iniciar sesión conserva el ID manual y sólo invalida la descarga al tener éxito', async t => {
  const choices = []
  let resolutions = 0
  const env = await setup(t, {
    resolve: async () => { resolutions++; throw new Error('SOURCE_SELECTION_REQUIRED') },
    chooseSource: async (track, videoId) => {
      choices.push({ id: track.id, videoId })
      if (choices.length === 1) throw new Error('CAPTURE_REQUIRES_INTERACTION: Inicia sesión')
      return playable('manual-choice-after-login')
    },
  })
  const redownload = t.mock.method(env.downloads, 'start')
  env.downloads.done.add(1)
  env.player.playQueue([item(1)], 0)
  await settle(() => env.player.picking !== null)
  assert.equal(await env.player.useSource('bbbbbbbbbbb'), false)
  assert.equal(env.player.captureInteraction, 'Inicia sesión')
  assert.equal(env.downloads.done.has(1), true)
  assert.equal(redownload.mock.callCount(), 0)
  env.player.retryCapture()
  await settle(() => env.audio.src === 'manual-choice-after-login')
  assert.equal(resolutions, 1)
  assert.deepEqual(choices, [
    { id: 1, videoId: 'bbbbbbbbbbb' }, { id: 1, videoId: 'bbbbbbbbbbb' },
  ])
  assert.equal(env.player.captureInteraction, null)
  assert.equal(env.downloads.done.has(1), false)
  assert.equal(redownload.mock.callCount(), 1)
  // Ya guardado: posteriores reintentos vuelven al flujo normal, sin repetir la elección.
  env.player.retryCapture()
  await settle(() => resolutions === 2)
  assert.equal(choices.length, 2)
})

test('cambiar de canción descarta el ID manual que esperaba interacción', async t => {
  const choices = []
  const resolutions = []
  const env = await setup(t, {
    resolve: async track => { resolutions.push(track.id); throw new Error('CAPTURE_REQUIRES_INTERACTION: Inicia sesión') },
    chooseSource: async (track, videoId) => {
      choices.push({ id: track.id, videoId })
      throw new Error('CAPTURE_REQUIRES_INTERACTION: Inicia sesión')
    },
  })
  env.player.playQueue([item(1)], 0)
  await settle(() => env.player.captureInteraction !== null)
  await env.player.useSource('bbbbbbbbbbb')
  env.player.playQueue([item(2)], 0)
  await settle(() => resolutions.length === 2)
  env.player.retryCapture()
  await settle(() => resolutions.length === 3)
  assert.deepEqual(resolutions, [1, 2, 2])
  assert.deepEqual(choices, [{ id: 1, videoId: 'bbbbbbbbbbb' }])
})

test('el fallo de selección se entrega al diálogo sin duplicarlo en el toast exterior', async t => {
  const errors = []
  const env = await setup(t, {
    resolve: async () => playable('current'),
    chooseSource: async () => { throw new Error('CAPTURE_UNSUPPORTED_WEBM: formato no verificado') },
  })
  env.player.playQueue([item(1)], 0)
  await settle(() => env.player.status === 'playing')
  assert.equal(await env.player.useSource('bbbbbbbbbbb', env.player.current, message => errors.push(message)), false)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /CAPTURE_UNSUPPORTED_WEBM/)
  assert.deepEqual(env.toasts, [])
  assert.equal(env.player.captureInteraction, null)
})

test('un fallo de selección obsoleto no sustituye el resultado ni el error del diálogo actual', async t => {
  const oldChoice = deferred(), errors = []
  let calls = 0
  const env = await setup(t, {
    resolve: async () => playable('current'),
    chooseSource: async (_track, videoId) => {
      calls++
      return videoId === 'bbbbbbbbbbb' ? oldChoice.promise : playable('new-choice')
    },
  })
  env.player.playQueue([item(1)], 0)
  await settle(() => env.player.status === 'playing')
  const old = env.player.useSource('bbbbbbbbbbb', env.player.current, message => errors.push(message))
  await settle(() => calls === 1)
  assert.equal(await env.player.useSource('ccccccccccc', env.player.current, message => errors.push(message)), true)
  oldChoice.reject(new Error('error de la elección anterior'))
  assert.equal(await old, false)
  assert.deepEqual(errors, [])
  assert.equal(env.audio.src, 'new-choice')
})

test('la precarga prepara un segundo Audio y el fin de canción lo promociona sin reasignar su fuente', async t => {
  const calls = []
  const env = await setup(t, { resolve: async (track, refresh, foreground) => {
    calls.push({ id: track.id, foreground })
    return playable(`musify-capture:${track.id === 1 ? 'aaaaaaaaaaa' : 'bbbbbbbbbbb'}`)
  } })
  env.player.playQueue([item(1), item(2)], 0)
  await settle(() => env.audios.length === 2)
  const first = env.player.playbackAudio, prepared = env.audios[1]
  assert.equal(first, env.audio)
  assert.equal(prepared.muted, true)
  assert.equal(prepared.paused, true)
  assert.equal(prepared.src, 'musify-capture:bbbbbbbbbbb')
  first.dispatchEvent(new Event('ended'))
  await settle(() => env.player.current.track.id === 2 && env.player.status === 'playing')
  assert.equal(env.player.playbackAudio, prepared)
  assert.equal(prepared.muted, false)
  assert.equal(env.audios.length, 2)
  assert.deepEqual(calls, [{ id: 1, foreground: true }, { id: 2, foreground: false }, { id: 2, foreground: true }])
  // Un evento atrasado del objeto anterior no avanza otra vez ni pausa la canción promovida.
  first.dispatchEvent(new Event('pause')); first.dispatchEvent(new Event('ended'))
  first.currentTime = 99; first.dispatchEvent(new Event('timeupdate'))
  assert.equal(env.player.status, 'playing')
  assert.equal(env.player.current.track.id, 2)
  assert.notEqual(env.player.time, 99)
})

test('cambiar la cola DJ sustituye la precarga sin parar la canción actual', async t => {
  const calls = []
  const env = await setup(t, { resolve: async (track, refresh, foreground) => {
    calls.push({ id: track.id, foreground }); return playable(`track-${track.id}`)
  } })
  env.player.playQueue([item(1), item(2)], 0)
  await settle(() => env.audios.length === 2)
  const obsolete = env.audios[1]
  env.player.playNext([item(3)])
  await settle(() => env.audios.length === 3)
  assert.equal(env.player.playbackAudio, env.audio)
  assert.equal(env.player.status, 'playing')
  assert.equal(obsolete.src, '')
  assert.equal(env.audios[2].src, 'track-3')
  env.audio.dispatchEvent(new Event('ended'))
  await settle(() => env.player.current.track.id === 3 && env.player.status === 'playing')
  assert.equal(env.player.playbackAudio, env.audios[2])
  assert(calls.some(call => call.id === 3 && call.foreground))
})

test('un fallo parcial informa y conserva el audio en reproducción', async t => {
  const env = await setup(t, { resolve: async () => playable('musify-capture:aaaaaaaaaaa') })
  env.player.playQueue([item(1)], 0)
  await settle(() => env.player.status === 'playing')
  const stops = env.stopped.length
  env.audio.dispatchEvent(new CustomEvent('capturewarning', { detail: 'CAPTURE_GAP: recuperando un tramo' }))
  assert.equal(env.player.status, 'playing')
  assert.equal(env.audio.paused, false)
  assert.equal(env.stopped.length, stops)
  assert.equal(env.toasts.length, 1)
})

test('B → C → B en la cola genera otra petición de precarga B y descarta sus tickets anteriores', async t => {
  const calls = [], pendingB = deferred(), pendingC = deferred()
  const env = await setup(t, { resolve: (track, _refresh, foreground) => {
    calls.push({ id: track.id, foreground })
    if (foreground) return Promise.resolve(playable(`foreground-${track.id}`))
    if (track.id === 3) return pendingC.promise
    return calls.filter(call => call.id === 2).length === 1 ? pendingB.promise : Promise.resolve(playable('latest-B'))
  } })
  env.player.playQueue([item(1), item(2)], 0)
  await settle(() => calls.length === 2)
  env.player.playNext([item(3)])
  await settle(() => calls.length === 3)
  env.player.clearQueue()
  await settle(() => calls.length === 4 && env.player.preparedAudio !== null)
  assert.deepEqual(calls.slice(1), [{ id: 2, foreground: false }, { id: 3, foreground: false }, { id: 2, foreground: false }])
  assert.equal(env.player.preparedAudio.src, 'latest-B')
  pendingB.resolve(playable('obsolete-B')); pendingC.resolve(playable('obsolete-C'))
  await tick()
  assert.equal(env.player.preparedAudio.src, 'latest-B')
  assert.equal(env.player.playbackAudio.src, 'foreground-1')
})

test('quitar la siguiente espera a cancelar next antes de crear una nueva precarga', async t => {
  const cancellation = deferred(), calls = []
  let cancellations = 0
  const env = await setup(t, {
    resolve: async (track, _refresh, foreground) => { calls.push({ id: track.id, foreground }); return playable(`track-${track.id}`) },
    cancelPrefetch: () => { cancellations++; return cancellation.promise },
  })
  env.player.playQueue([item(1)], 0)
  await settle(() => env.player.status === 'playing')
  env.player.playNext([item(2)])
  await settle(() => env.player.preparedAudio !== null)
  env.player.clearQueue()
  env.player.playNext([item(3)])
  await settle(() => cancellations === 1)
  assert.deepEqual(calls, [{ id: 1, foreground: true }, { id: 2, foreground: false }])
  assert.equal(env.player.playbackAudio.src, 'track-1')
  assert.equal(env.player.status, 'playing')
  cancellation.resolve()
  await settle(() => env.player.preparedAudio?.src === 'track-3')
  assert.deepEqual(calls.at(-1), { id: 3, foreground: false })
})

test('promocionar la siguiente preparada no envía cancel_prefetch que pudiera cerrarla', async t => {
  let cancellations = 0
  const env = await setup(t, {
    resolve: async track => playable(`track-${track.id}`), cancelPrefetch: async () => { cancellations++ },
  })
  env.player.playQueue([item(1), item(2)], 0)
  await settle(() => env.player.preparedAudio !== null)
  const prepared = env.player.preparedAudio
  env.player.next()
  await settle(() => env.player.playbackAudio === prepared && env.player.status === 'playing')
  assert.equal(cancellations, 0)
})

test('el audio API3 preparado suena sin esperar la promoción y sólo después de pausar el anterior', async t => {
  const promotion = deferred(), calls = []
  const env = await setup(t, { resolve: (track, _refresh, foreground) => {
    calls.push({ id: track.id, foreground })
    return track.id === 2 && foreground ? promotion.promise : Promise.resolve(captured(track.id))
  } })
  env.player.playQueue([item(1), item(2), item(3)], 0)
  await settle(() => env.player.preparedAudio !== null)
  const previous = env.player.playbackAudio, prepared = env.player.preparedAudio
  let overlap = false
  prepared.addEventListener('playing', () => { overlap ||= !previous.paused })
  previous.dispatchEvent(new Event('ended'))
  assert.equal(env.player.playbackAudio, prepared)
  assert.equal(prepared.paused, false)
  assert.equal(prepared.currentTime, 0)
  assert.equal(overlap, false)
  await settle(() => calls.some(call => call.id === 2 && call.foreground))
  env.player.addToQueue([item(4)])
  await tick()
  assert.equal(calls.some(call => call.id === 3 || call.id === 4), false, 'la cola tampoco invalida el lease next durante la promoción')
  promotion.resolve(captured(2))
  await settle(() => calls.some(call => call.id === 4 && !call.foreground))
  assert.equal(env.player.playbackAudio, prepared)
})

test('la precarga posterior espera también la promesa play del audio promovido', async t => {
  const playing = deferred(), calls = []
  const env = await setup(t, { resolve: async (track, _refresh, foreground) => {
    calls.push({ id: track.id, foreground }); return captured(track.id)
  } })
  env.player.playQueue([item(1), item(2), item(3)], 0)
  await settle(() => env.player.preparedAudio !== null)
  const prepared = env.player.preparedAudio
  t.mock.method(prepared, 'play', () => { prepared.paused = false; return playing.promise })
  env.player.next()
  await settle(() => calls.some(call => call.id === 2 && call.foreground))
  await tick()
  assert.equal(calls.some(call => call.id === 3), false)
  prepared.dispatchEvent(new Event('playing')); playing.resolve()
  await settle(() => calls.some(call => call.id === 3 && !call.foreground))
})

test('pausa y AbortError durante promoción permiten precargar tras reanudar, cualquiera que sea el orden del ack', async t => {
  for (const ackBeforeResume of [true, false]) {
    const playing = deferred(), promotion = deferred(), calls = []
    const env = await setup(t, { resolve: (track, _refresh, foreground) => {
      calls.push({ id: track.id, foreground })
      return track.id === 2 && foreground ? promotion.promise : Promise.resolve(captured(track.id))
    } })
    env.player.playQueue([item(1), item(2), item(3)], 0)
    await settle(() => env.player.preparedAudio !== null)
    const prepared = env.player.preparedAudio
    let starts = 0
    t.mock.method(prepared, 'play', () => {
      prepared.paused = false
      prepared.dispatchEvent(new Event('playing'))
      return ++starts === 1 ? playing.promise : Promise.resolve()
    })
    env.player.next()
    await settle(() => calls.some(call => call.id === 2 && call.foreground))
    if (ackBeforeResume) { promotion.resolve(captured(2)); await tick() }
    env.player.toggle()
    assert.equal(env.player.status, 'paused')
    playing.reject(new DOMException('The play request was interrupted by pause()', 'AbortError'))
    await tick()
    env.player.addToQueue([item(4)])
    assert.equal(calls.some(call => call.id === 3 || call.id === 4), false)
    env.player.toggle()
    assert.equal(env.player.playbackAudio, prepared)
    assert.equal(env.player.status, 'playing')
    if (!ackBeforeResume) { await tick(); assert.equal(calls.some(call => call.id === 4), false); promotion.resolve(captured(2)) }
    await settle(() => calls.some(call => call.id === 4 && !call.foreground))
    assert.equal(env.toasts.some(message => /No se pudo|AbortError/.test(message)), false)
  }
})

test('reanudar tras AbortError no elimina la barrera si la promoción fue rechazada', async t => {
  const playing = deferred(), promotion = deferred(), calls = []
  const env = await setup(t, { resolve: (track, _refresh, foreground) => {
    calls.push({ id: track.id, foreground })
    return track.id === 2 && foreground ? promotion.promise : Promise.resolve(captured(track.id))
  } })
  env.player.playQueue([item(1), item(2), item(3)], 0)
  await settle(() => env.player.preparedAudio !== null)
  const prepared = env.player.preparedAudio
  let starts = 0
  t.mock.method(prepared, 'play', () => {
    prepared.paused = false; prepared.dispatchEvent(new Event('playing'))
    return ++starts === 1 ? playing.promise : Promise.resolve()
  })
  env.player.next()
  await settle(() => calls.some(call => call.id === 2 && call.foreground))
  promotion.reject(new Error('promotion rejected'))
  await settle(() => env.toasts.length === 1)
  env.player.toggle()
  playing.reject(new DOMException('pause', 'AbortError'))
  await tick()
  env.player.toggle()
  env.player.addToQueue([item(4)])
  await tick()
  assert.equal(env.player.status, 'playing')
  assert.equal(env.player.playbackAudio, prepared)
  assert.equal(calls.some(call => call.id === 3 || call.id === 4), false)
})

test('cancelar la carga promovida invalida su éxito de promoción aunque play se resuelva tarde', async t => {
  const playing = deferred(), calls = []
  let cancellations = 0
  const env = await setup(t, {
    resolve: async (track, _refresh, foreground) => { calls.push({ id: track.id, foreground }); return captured(track.id) },
    cancelResolve: async () => { cancellations++ },
  })
  env.player.playQueue([item(1), item(2), item(3)], 0)
  await settle(() => env.player.preparedAudio !== null)
  const prepared = env.player.preparedAudio
  t.mock.method(prepared, 'play', () => { prepared.paused = false; return playing.promise })
  env.player.next()
  await settle(() => calls.some(call => call.id === 2 && call.foreground))
  await tick()
  env.player.toggle()
  await settle(() => cancellations === 1)
  assert.equal(env.player.status, 'idle')
  playing.resolve()
  await tick(); await tick()
  assert.equal(env.player.status, 'idle')
  assert.equal(prepared.paused, true)
  assert.equal(prepared.src, '')
  assert.equal(calls.some(call => call.id === 3), false)
})

test('promoción rechazada o con otro vídeo conserva el audio confirmado y avisa sin saltar', async t => {
  for (const mismatch of [false, true]) {
    const promotion = deferred(), calls = []
    const env = await setup(t, { resolve: (track, _refresh, foreground) => {
      calls.push({ id: track.id, foreground })
      return track.id === 2 && foreground ? promotion.promise : Promise.resolve(captured(track.id))
    } })
    env.player.playQueue([item(1), item(2), item(3)], 0)
    await settle(() => env.player.preparedAudio !== null)
    const prepared = env.player.preparedAudio, src = prepared.src
    env.player.next()
    await settle(() => calls.some(call => call.id === 2 && call.foreground))
    const stops = env.stopped.length
    if (mismatch) promotion.resolve(captured(99))
    else promotion.reject(new Error('CAPTURE_REQUIRES_INTERACTION: Confirma tu cuenta'))
    await settle(() => env.toasts.length === 1)
    assert.equal(env.player.playbackAudio, prepared)
    assert.equal(env.player.status, 'playing')
    assert.equal(prepared.paused, false)
    assert.equal(prepared.src, src)
    assert.equal(env.stopped.length, stops)
    assert.equal(env.player.current.track.id, 2)
    assert.equal(calls.some(call => call.id === 3), false)
    assert.match(env.toasts[0], /se conserva el audio confirmado/)
    if (!mismatch) assert.equal(env.player.captureInteraction, 'Confirma tu cuenta')
    env.player.addToQueue([item(4)])
    await tick()
    assert.equal(calls.some(call => call.id === 4), false, 'el fallo mantiene la barrera frente a nuevas precargas')
    env.player.next()
    await settle(() => env.player.current.track.id === 4 && env.player.status === 'playing' && env.player.playbackAudio.src === captured(4).url)
  }
})

test('el resultado tardío de promoción no detiene ni modifica la canción que la sustituye', async t => {
  for (const rejection of [false, true]) {
    const promotion = deferred()
    const env = await setup(t, { resolve: (track, _refresh, foreground) =>
      track.id === 2 && foreground ? promotion.promise : Promise.resolve(captured(track.id)) })
    env.player.playQueue([item(1), item(2)], 0)
    await settle(() => env.player.preparedAudio !== null)
    env.player.next()
    await tick()
    env.player.playQueue([item(3)], 0)
    await settle(() => env.player.status === 'playing' && env.player.playbackAudio.src === captured(3).url)
    const current = env.player.playbackAudio, stops = env.stopped.length
    if (rejection) promotion.reject(new Error('obsolete promotion'))
    else promotion.resolve(captured(2))
    await tick(); await tick()
    assert.equal(env.player.playbackAudio, current)
    assert.equal(env.player.current.track.id, 3)
    assert.equal(env.player.status, 'playing')
    assert.equal(current.paused, false)
    assert.equal(env.stopped.length, stops)
    assert.deepEqual(env.toasts, [])
  }
})

test('elegir otro vídeo para la siguiente invalida su audio preparado sin tocar la actual', async t => {
  let selected = 2, cancellations = 0
  const env = await setup(t, {
    resolve: async track => captured(track.id === 2 ? selected : track.id),
    rememberSource: async () => { selected = 22 },
    cancelPrefetch: async () => { cancellations++ },
  })
  env.player.playQueue([item(1), item(2)], 0)
  await settle(() => env.player.preparedAudio !== null)
  const current = env.player.playbackAudio, obsolete = env.player.preparedAudio
  assert.equal(await env.player.useSource(captured(22).videoId, item(2)), true)
  assert.equal(env.player.playbackAudio, current)
  assert.equal(current.paused, false)
  assert.equal(env.player.preparedAudio, null)
  assert.equal(obsolete.src, '')
  env.player.next()
  await settle(() => env.player.status === 'playing' && env.player.playbackAudio.src === captured(22).url)
  assert.equal(cancellations, 1)
  assert.notEqual(env.player.playbackAudio, obsolete)
})

test('una precarga sin buffer inicial, sin lector o de URL normal conserva el camino de resolución previo', async t => {
  for (const kind of ['gap', 'reader', 'network']) {
    const promotion = deferred()
    const result = id => kind === 'network' ? playable(`https://example.test/${id}`) : captured(id)
    const env = await setup(t, { resolve: (track, _refresh, foreground) =>
      track.id === 2 && foreground ? promotion.promise : Promise.resolve(result(track.id)) })
    env.player.playQueue([item(1), item(2)], 0)
    await settle(() => env.player.preparedAudio !== null)
    const previous = env.player.playbackAudio, prepared = env.player.preparedAudio
    if (kind === 'gap') prepared.ranges = [{ start: 0.02, end: 40 }]
    if (kind === 'reader') env.progress.delete(prepared)
    env.player.next()
    await tick()
    assert.equal(env.player.playbackAudio, previous)
    assert.equal(prepared.paused, true)
    promotion.resolve(result(2))
    await settle(() => env.player.playbackAudio === prepared && env.player.status === 'playing')
  }
})

test('refresh no adopta una precarga del mismo track ni pierde la petición de renovar fuente', async t => {
  const refreshed = deferred(), calls = []
  const env = await setup(t, { resolve: (track, refresh, foreground) => {
    calls.push({ id: track.id, refresh, foreground })
    return refresh ? refreshed.promise : Promise.resolve(captured(track.id))
  } })
  env.player.playQueue([item(1), item(1)], 0)
  await settle(() => env.player.preparedAudio !== null)
  const current = env.player.playbackAudio, oldPrepared = env.player.preparedAudio
  env.player.retryCapture()
  await settle(() => calls.some(call => call.refresh))
  assert.equal(env.player.playbackAudio, current)
  assert.equal(env.player.status, 'loading')
  assert.equal(oldPrepared.paused, true)
  refreshed.resolve(captured(99))
  await settle(() => env.player.status === 'playing' && current.src === captured(99).url)
  assert.notEqual(env.player.playbackAudio, oldPrepared)
  assert.deepEqual(calls.find(call => call.refresh), { id: 1, refresh: true, foreground: true })
})
