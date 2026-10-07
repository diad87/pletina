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
const playable = url => ({ videoId: 'aaaaaaaaaaa', url, title: 'Title', channel: 'Artist', local: false })
let count = 0
async function setup(t, methods) {
  let audio
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem() {} } })
  t.after(() => {
    if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor)
    else delete globalThis.localStorage
  })
  const previousAudio = globalThis.Audio
  globalThis.Audio = class extends EventTarget {
    src = ''; currentTime = 0; duration = 100; paused = true
    constructor() { super(); audio = this }
    pause() { this.paused = true; this.dispatchEvent(new Event('pause')) }
    play() { this.paused = false; this.dispatchEvent(new Event('playing')); return Promise.resolve() }
    removeAttribute() { this.src = '' }
    load() {}
  }
  t.after(() => { globalThis.Audio = previousAudio })
  const stopped = []
  const toasts = []
  const key = `__playerTest${++count}`
  globalThis[key] = {
    api: { recordPlay: async () => {}, ...methods },
    convertFileSrc: value => value,
    downloads: { done: new Set(), start() {} },
    setAudioSource: (a, url) => { a.src = url }, stopCapture: (...args) => stopped.push(args),
    library: {}, toLib: value => value, toast: { show: message => toasts.push(message) },
  }
  t.after(() => delete globalThis[key])
  // La reactividad no interviene en estas carreras; sí ejecutamos los métodos privados reales.
  const prelude = `const $state = value => value; const { api, convertFileSrc, downloads, setAudioSource, stopCapture, library, toLib, toast } = globalThis.${key};\n`
  const { player } = await import(`data:text/javascript;base64,${Buffer.from(prelude + javascript).toString('base64')}`)
  return { player, audio, stopped, toasts, downloads: globalThis[key].downloads }
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
