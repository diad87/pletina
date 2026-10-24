import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

// The real orchestration, P1 response validator and metadata validator run here.
// Only dynamic loading and opaque-frame transport are supplied by this harness;
// no provider JavaScript, network, audio, account or persistent storage is used.
const compile = async name => ts.transpileModule(await readFile(new URL(`../../web-port/${name}.ts`, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText
const [youtubeCode, p1Code, probeCode] = await Promise.all(['youtube', 'youtube-p1', 'youtube-p1-probe'].map(compile))
const id = 'DJzjkMBMook', other = 'aqz-KE-bpKQ'
const flush = async () => { for (let i = 0; i < 45; i++) await Promise.resolve() }
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const recipe = () => ({
  context: { client: { clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: '2.20261022.01.00', visitorData: 'anonymous-synthetic-fixture' },
    thirdParty: { embedUrl: 'https://www.reddit.com/' } },
  playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' } },
  signatureTimestamp: 20746, script: 'var exportedVars = {};', playerSHA: 'a'.repeat(64), createdAt: '2026-01-01T00:00:00Z',
})
const audioUrl = label => `https://r1.googlevideo.com/videoplayback?expire=9999999999&itag=140&clen=123456&fixture=${label}`
const player = (label = 'visionos', videoId = id) => ({ playabilityStatus: { status: 'OK', playableInEmbed: true },
  videoDetails: { videoId, title: 'Synthetic exact recording', author: 'Synthetic artist', lengthSeconds: '209' },
  streamingData: { adaptiveFormats: [{ itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128000,
    contentLength: '123456', url: audioUrl(label) }] } })
const unavailable = () => ({ playabilityStatus: { status: 'UNPLAYABLE' } })
const noFormat = () => ({ ...player(), streamingData: { adaptiveFormats: [] } })

function engine(t, options = {}) {
  const listeners = new Set(), frames = [], history = [], imports = [], controllers = [], storageAccess = []
  const window = new EventTarget()
  const add = window.addEventListener.bind(window), remove = window.removeEventListener.bind(window)
  window.addEventListener = (name, listener, ...rest) => { if (name === 'message') listeners.add(listener); add(name, listener, ...rest) }
  window.removeEventListener = (name, listener, ...rest) => { if (name === 'message') listeners.delete(listener); remove(name, listener, ...rest) }
  const forbidden = name => { storageAccess.push(name); throw new Error(`Unexpected persistence/network access: ${name}`) }
  const storage = new Proxy({}, { get: (_, name) => forbidden(String(name)) })
  for (const name of ['localStorage', 'sessionStorage', 'indexedDB', 'caches']) Object.defineProperty(window, name, { get: () => forbidden(name) })
  const args = (frame = frames[0]) => {
    assert.ok(frame, 'expected an active opaque transport frame')
    return JSON.parse(frame.srcdoc.slice(frame.srcdoc.lastIndexOf(')(') + 2, -')</script>'.length))
  }
  const send = (data, frame = frames[0], overrides = {}) => {
    const config = args(frame), event = new Event('message')
    Object.defineProperties(event, { source: { value: frame.contentWindow }, origin: { value: 'null' },
      data: { value: { type: config.message, requestId: config.requestId, ...data, ...overrides } } })
    window.dispatchEvent(event)
  }
  const append = frame => {
    frames.push(frame)
    const config = args(frame)
    history.push({ frame, config })
    assert.equal(frame.sandbox, 'allow-scripts')
    assert.equal(frame.hidden, true)
  }
  const document = { body: { append }, documentElement: { append }, createElement(name) {
    if (name === 'audio') return { canPlayType(mime) {
      assert.equal(mime, 'audio/webm; codecs="opus"')
      if (options.opusSupport instanceof Error) throw options.opusSupport
      return options.opusSupport ?? ''
    } }
    assert.equal(name, 'iframe')
    const frame = { attributes: {}, setAttribute(key, value) { this.attributes[key] = value },
      remove() { const index = frames.indexOf(frame); if (index >= 0) frames.splice(index, 1) } }
    frame.contentWindow = { postMessage(data) {
      if (data.cancel === true) queueMicrotask(() => send({ error: 'cancelled' }, frame))
    } }
    return frame
  } }
  const instantiate = (code, dependency = () => assert.fail('Unexpected static import')) => {
    const exports = {}
    new Function('exports', 'require', 'window', 'document', 'fetch', 'localStorage', 'sessionStorage', 'indexedDB', 'caches', code)(
      exports, dependency, window, document, () => forbidden('fetch'), storage, storage, storage, storage)
    return exports
  }
  const realP1 = instantiate(p1Code), realProbe = instantiate(probeCode), p1Recipe = options.recipe ?? recipe()
  const dependencies = { './youtube-p1': realP1, './youtube-p1-probe': realProbe, './p1-recipe.generated': { p1Recipe, p1FallbackRecipe: options.fallbackRecipe }, ...options.modules }
  const api = instantiate(youtubeCode, path => {
    imports.push(path)
    assert.ok(Object.hasOwn(dependencies, path), `unexpected module ${path}`)
    const value = dependencies[path]
    if (value instanceof Error) throw value
    return value
  })
  const stream = (videoId = id, refresh = false, signal, recoverPrimary = false) => {
    const controller = new AbortController(); controllers.push(controller)
    const operation = api.stream(videoId, refresh, signal ? AbortSignal.any([controller.signal, signal]) : controller.signal, recoverPrimary)
    operation.catch(() => {}) // Assertions attach after the manually driven transport.
    return operation
  }
  t.after(async () => { for (const controller of controllers) controller.abort(); await flush(); assert.equal(frames.length, 0); assert.equal(listeners.size, 0) })
  return { ...api, stream, frames, history, imports, args, send, realP1, realProbe, p1Recipe, storageAccess,
    result: (result, frame) => send({ result }, frame), error: (error, frame) => send({ error }, frame) }
}

async function visionos(yt, refresh = false, signal) {
  const pending = yt.stream(id, refresh, signal)
  await flush()
  if (yt.args().url.includes('/search?')) {
    yt.result({ responseContext: { visitorData: 'anonymous-browser-fixture' } })
    await flush()
  }
  assert.equal(yt.args().body.context.client.clientName, 'VISIONOS')
  assert.equal(yt.args().body.videoId, id)
  return { pending }
}

async function p1Request(yt, rejected = unavailable()) {
  yt.result(rejected)
  await flush()
  assert.equal(yt.args().body.context.client.clientName, 'WEB_EMBEDDED_PLAYER')
  assert.equal(yt.args().body.videoId, id)
}

async function completeP1(yt, label = 'p1') {
  yt.result(player(label))
  await flush()
  assert.equal(yt.args().message, 'pletina-youtube-p1-metadata')
  assert.equal(yt.args().candidates[0].expectedDuration, 209)
  assert.equal(yt.args().candidates[0].url, audioUrl(label))
  yt.send({ index: 0, duration: 209.16 })
  await flush()
}

function multipleAac() {
  const response = player('best'), best = response.streamingData.adaptiveFormats[0]
  response.streamingData.adaptiveFormats.push({ ...best, itag: 139, bitrate: 48000,
    url: audioUrl('lower').replace('itag=140', 'itag=139') })
  return response
}

function aacAndOpus() {
  const response = player('aac'), aac = response.streamingData.adaptiveFormats[0]
  response.streamingData.adaptiveFormats.push({ ...aac, itag: 251, mimeType: 'audio/webm; codecs="opus"', bitrate: 256000,
    url: audioUrl('opus').replace('itag=140', 'itag=251') + '&mime=audio%2Fwebm' })
  return response
}

for (const support of ['maybe', 'probably']) test(`native ${support} Opus support sends one original quality-ordered metadata batch`, async t => {
  const yt = engine(t, { opusSupport: support }), { pending } = await visionos(yt)
  await p1Request(yt); const response = aacAndOpus(); yt.result(response); await flush()
  assert.equal(yt.frames.length, 1)
  assert.deepEqual(yt.args().candidates, [response.streamingData.adaptiveFormats[1], response.streamingData.adaptiveFormats[0]]
    .map(format => ({ url: format.url, expectedDuration: 209 })))
  yt.send({ index: 0, duration: 209.16 })
  const value = await pending
  assert.equal(value.videoId, id); assert.equal(value.transport, 'p1')
  assert.equal(value.url, response.streamingData.adaptiveFormats[1].url)
  assert.equal(yt.frames.length, 0)
  const requests = yt.history.length
  assert.equal(await yt.stream(), value); assert.equal(yt.history.length, requests)
  assert.deepEqual(yt.storageAccess, [])
})

test('one supported-native batch can hand off AAC as the selected original fallback', async t => {
  const yt = engine(t, { opusSupport: 'probably' }), { pending } = await visionos(yt)
  await p1Request(yt); yt.result(aacAndOpus()); await flush()
  assert.equal(yt.frames.length, 1)
  assert.equal(yt.args().candidates[0].url, audioUrl('opus').replace('itag=140', 'itag=251') + '&mime=audio%2Fwebm')
  yt.send({ index: 1, duration: 209.16 })
  assert.equal((await pending).url, audioUrl('aac'))
  assert.equal(yt.frames.length, 0)
})

for (const support of ['', 'no', true, new Error('Capability unavailable')]) test(`unsupported Opus capability ${String(support)} never enters the shared batch`, async t => {
  const yt = engine(t, { opusSupport: support }), { pending } = await visionos(yt)
  await p1Request(yt); yt.result(aacAndOpus()); await flush()
  assert.equal(yt.frames.length, 1)
  assert.deepEqual(yt.args().candidates, [{ url: audioUrl('aac'), expectedDuration: 209 }])
  yt.send({ index: 0, duration: 209.16 })
  assert.equal((await pending).url, audioUrl('aac'))
})

test('Opus cannot borrow originality from a rejected or dubbed AAC encoding', async t => {
  const yt = engine(t, { opusSupport: 'probably' }), { pending } = await visionos(yt)
  await p1Request(yt); const response = aacAndOpus()
  response.streamingData.adaptiveFormats[0].audioTrack = { displayName: 'Dubbed', audioIsDefault: true }
  yt.result(response); await flush()
  await assert.rejects(pending, error => error.code === 'unavailable')
  assert.equal(yt.history.filter(entry => entry.config.message === 'pletina-youtube-p1-metadata').length, 0)
})

test('a rejected AAC does not hide an explicitly original Opus of the same video', async t => {
  const yt = engine(t, { opusSupport: 'probably' }), { pending } = await visionos(yt)
  await p1Request(yt); const response = aacAndOpus()
  response.streamingData.adaptiveFormats[0].audioTrack = { displayName: 'Dubbed', audioIsDefault: true }
  response.streamingData.adaptiveFormats[1].audioTrack = { displayName: 'Basque (Original)', audioIsDefault: false }
  yt.result(response); await flush()
  assert.equal(yt.frames.length, 1)
  assert.deepEqual(yt.args().candidates, [{ url: response.streamingData.adaptiveFormats[1].url, expectedDuration: 209 }])
  yt.send({ index: 0, duration: 209.16 })
  assert.equal((await pending).url, response.streamingData.adaptiveFormats[1].url)
})

test('mixed codecs retain the four-format bound and use Native Opus order only when supported', async t => {
  const yt = engine(t, { opusSupport: 'probably' }), { pending } = await visionos(yt)
  await p1Request(yt); const response = aacAndOpus(), [aac, opus] = response.streamingData.adaptiveFormats
  response.streamingData.adaptiveFormats = [...Array.from({ length: 9 }, (_, n) => ({ ...opus, bitrate: 500000 + n, url: opus.url + '&extra=' + n })),
    ...Array.from({ length: 4 }, (_, n) => ({ ...aac, bitrate: 64000 + n, url: audioUrl('aac-' + n) }))]
  yt.result(response); await flush()
  assert.equal(yt.frames.length, 1)
  assert.equal(yt.args().candidates.length, 4)
  assert.ok(yt.args().candidates.every(candidate => candidate.url.includes('fixture=opus')))
  assert.ok(yt.args().candidates[0].url.endsWith('&extra=8'))
  yt.send({ index: 0, duration: 209.16 })
  assert.ok((await pending).url.endsWith('&extra=8'))
  assert.equal(yt.frames.length, 0)
})

test('abort unloads the shared Opus/AAC batch and caches no late selected format', async t => {
  const yt = engine(t, { opusSupport: 'probably' }), controller = new AbortController()
  const { pending } = await visionos(yt, false, controller.signal)
  await p1Request(yt); yt.result(aacAndOpus()); await flush()
  const batch = yt.frames[0]
  assert.equal(yt.args().candidates.length, 2)
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(yt.frames.length, 0)
  yt.send({ index: 0, duration: 209.16 }, batch)
  const retry = await visionos(yt)
  yt.result(player('new-after-opus-cancel'))
  assert.equal((await retry.pending).url, audioUrl('new-after-opus-cancel'))
})

test('an incorrect selected Opus duration cannot enter the stream cache', async t => {
  const yt = engine(t, { opusSupport: 'probably' }), { pending } = await visionos(yt)
  await p1Request(yt); yt.result(aacAndOpus()); await flush()
  yt.send({ index: 0, duration: 120 })
  await assert.rejects(pending, error => error.code === 'unavailable')
  const retry = await visionos(yt)
  yt.result(player('no-invalid-opus-cache'))
  assert.equal((await retry.pending).url, audioUrl('no-invalid-opus-cache'))
})

for (const index of [0, 1]) test(`one shared AAC batch maps selected index ${index} to its exact format`, async t => {
  const yt = engine(t), { pending } = await visionos(yt)
  await p1Request(yt); const response = multipleAac(); yt.result(response); await flush()
  assert.equal(yt.frames.length, 1, 'All encodings must share the single bridge budget')
  assert.deepEqual(yt.args().candidates.map(candidate => candidate.url), response.streamingData.adaptiveFormats.map(format => format.url))
  yt.send({ index, duration: 209.16 })
  const value = await pending
  assert.equal(value.url, response.streamingData.adaptiveFormats[index].url)
  assert.equal(value.videoId, id); assert.equal(value.transport, 'p1')
  assert.equal(yt.frames.length, 0)
  const requests = yt.history.length
  assert.equal(await yt.stream(), value); assert.equal(yt.history.length, requests)
})

test('an out-of-range batch selection cannot select another recording or cache a locator', async t => {
  const yt = engine(t), { pending } = await visionos(yt)
  await p1Request(yt); yt.result(multipleAac()); await flush()
  yt.send({ index: 2, duration: 209.16 })
  await assert.rejects(pending, error => error.code === 'unavailable')
  const retry = await visionos(yt)
  yt.result(player('no-invalid-selection-cache'))
  assert.equal((await retry.pending).url, audioUrl('no-invalid-selection-cache'))
})

test('an invalid AAC locator does not hide a healthy original AAC', async t => {
  const yt = engine(t), { pending } = await visionos(yt)
  await p1Request(yt); const response = multipleAac()
  response.streamingData.adaptiveFormats[0].url = 'https://invalid.example/videoplayback'
  yt.result(response); await flush()
  assert.deepEqual(yt.args().candidates, [{ url: response.streamingData.adaptiveFormats[1].url, expectedDuration: 209 }])
  yt.send({ index: 0, duration: 209.16 })
  assert.equal((await pending).url, response.streamingData.adaptiveFormats[1].url)
})

test('many dubbed AAC encodings cannot consume the four-candidate budget before the original', async t => {
  const yt = engine(t), { pending } = await visionos(yt)
  await p1Request(yt); const response = player('original'), original = response.streamingData.adaptiveFormats[0]
  original.audioTrack = { displayName: 'Original', audioIsDefault: true }
  response.streamingData.adaptiveFormats = [...Array.from({ length: 6 }, (_, index) => ({ ...original,
    url: audioUrl('dub' + index), bitrate: 200000 + index, audioTrack: { displayName: 'English dubbed', audioIsDefault: true } })), original]
  yt.result(response); await flush()
  assert.deepEqual(yt.args().candidates, [{ url: audioUrl('original'), expectedDuration: 209 }])
  yt.send({ index: 0, duration: 209.16 })
  assert.equal((await pending).url, audioUrl('original'))
})

for (const code of ['network', 'timeout']) test(`shared AAC batch transient ${code} stays transient and caches none`, async t => {
  const yt = engine(t), { pending } = await visionos(yt)
  await p1Request(yt); yt.result(multipleAac()); await flush()
  assert.equal(yt.frames.length, 1); assert.equal(yt.args().candidates.length, 2)
  yt.send({ error: code })
  await assert.rejects(pending, error => error instanceof yt.YouTubeError && error.code === code)
  assert.equal(yt.frames.length, 0)
  const retry = await visionos(yt)
  yt.result(player('retry-all-failed'))
  assert.equal((await retry.pending).url, audioUrl('retry-all-failed'))
})

test('only a typed P1 batch failure can replace the original error category', async t => {
  const module = {}, yt = engine(t, { modules: { './youtube-p1-probe': module } })
  Object.assign(module, yt.realProbe, { async probeP1AudioCandidates() {
    throw Object.assign(new Error('Synthetic lookalike'), { name: 'P1ProbeError', code: 'network' })
  } })
  const { pending } = await visionos(yt)
  await p1Request(yt); yt.result(player('untrusted-error-shape'))
  await assert.rejects(pending, error => error instanceof yt.YouTubeError && error.code === 'unavailable')
  assert.equal(yt.frames.length, 0)
})

test('a typed P1 engine timeout remains transient instead of authorizing a visible fallback', async t => {
  const module = {}, yt = engine(t, { modules: { './youtube-p1': module } })
  Object.assign(module, yt.realP1, { async requestP1Player() { throw new yt.realP1.P1EngineError('Synthetic bounded timeout', 'timeout') } })
  const { pending } = await visionos(yt)
  yt.result(unavailable())
  await assert.rejects(pending, error => error instanceof yt.YouTubeError && error.code === 'timeout')
  assert.equal(yt.frames.length, 0)
})

test('abort while removing the completed batch bridge prevents caching its chosen locator', async t => {
  const yt = engine(t), controller = new AbortController(), { pending } = await visionos(yt, false, controller.signal)
  await p1Request(yt); yt.result(multipleAac()); await flush()
  const batch = yt.frames[0], remove = batch.remove
  batch.remove = () => { controller.abort(); remove() }
  yt.send({ index: 0, duration: 209.16 }, batch)
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(yt.frames.length, 0)
  const retry = await visionos(yt)
  yt.result(player('after-cleanup-abort'))
  assert.equal((await retry.pending).url, audioUrl('after-cleanup-abort'))
})

test('duplicate AAC URLs enter the shared batch only once', async t => {
  const yt = engine(t), { pending } = await visionos(yt)
  await p1Request(yt); const response = multipleAac()
  response.streamingData.adaptiveFormats[1].url = response.streamingData.adaptiveFormats[0].url
  yt.result(response); await flush()
  assert.equal(yt.args().candidates.length, 1)
  yt.send({ index: 0, duration: 209.16 })
  assert.equal((await pending).url, audioUrl('best'))
})

test('an expired highest-quality locator does not hide a fresh original AAC', async t => {
  const yt = engine(t), { pending } = await visionos(yt)
  await p1Request(yt); const response = multipleAac()
  response.streamingData.adaptiveFormats[0].url = audioUrl('expired').replace('expire=9999999999', 'expire=1')
  yt.result(response); await flush()
  assert.deepEqual(yt.args().candidates, [{ url: response.streamingData.adaptiveFormats[1].url, expectedDuration: 209 }])
  yt.send({ index: 0, duration: 209.16 })
  assert.equal((await pending).url, response.streamingData.adaptiveFormats[1].url)
})

for (const support of ['', 'probably']) test(`orchestration forwards Native context fallback and its codec gate ${support || 'AAC-only'}`, async t => {
  const fallback = recipe(), module = {}, calls = []
  fallback.context.thirdParty.embedUrl = 'https://www.example.com/'
  const yt = engine(t, { opusSupport: support, fallbackRecipe: fallback, modules: { './youtube-p1': module } })
  Object.assign(module, yt.realP1, { async requestP1Player(...args) { calls.push(args); return player('context-forwarded') } })
  const { pending } = await visionos(yt)
  yt.result(unavailable()); await flush()
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], id); assert.equal(typeof calls[0][1], 'function')
  assert.equal(calls[0][2], yt.p1Recipe); assert.equal(calls[0][5], support === 'probably')
  assert.equal(calls[0][6], fallback); assert.equal(typeof calls[0][4], 'function')
  yt.send({ index: 0, duration: 209.16 })
  assert.equal((await pending).url, audioUrl('context-forwarded'))
})


test('VISIONOS success avoids all P1 imports and reuses only the in-memory stream', async t => {
  const yt = engine(t), { pending } = await visionos(yt)
  yt.result(player())
  const value = await pending, requests = yt.history.length
  assert.equal(value.url, audioUrl('visionos'))
  assert.equal(value.transport, undefined)
  assert.equal(await yt.stream(), value)
  assert.equal(yt.history.length, requests)
  assert.deepEqual(yt.imports, [])
  assert.deepEqual(yt.storageAccess, [])
})

async function primaryStream(yt, label = 'primary-before-repair') {
  const initial = await visionos(yt)
  yt.result(player(label))
  return initial.pending
}

test('refresh of a still-valid primary locator tries probed P1 for the same video before repeating the failed client', async t => {
  const yt = engine(t), before = await primaryStream(yt)
  const pending = yt.stream(id, true, undefined, true)
  await flush()
  assert.equal(yt.args().body.context.client.clientName, 'WEB_EMBEDDED_PLAYER')
  await completeP1(yt, 'repair-same-video')
  const after = await pending
  assert.equal(after.videoId, before.videoId)
  assert.equal(after.transport, 'p1')
  assert.notEqual(after.url, before.url)
  assert.equal(await yt.stream(), after)
  assert.deepEqual(yt.history.filter(row => row.config.body?.videoId).map(row => row.config.body.context.client.clientName), ['VISIONOS', 'WEB_EMBEDDED_PLAYER'])
  assert.deepEqual(yt.storageAccess, [])
})

test('a failed P1 repair still allows one freshly resolved primary locator', async t => {
  const yt = engine(t), before = await primaryStream(yt)
  const pending = yt.stream(id, true, undefined, true)
  await flush()
  assert.equal(yt.args().body.context.client.clientName, 'WEB_EMBEDDED_PLAYER')
  yt.error('network'); await flush()
  assert.equal(yt.args().body.context.client.clientName, 'VISIONOS')
  yt.result(player('fresh-primary-after-p1-failure'))
  const after = await pending
  assert.notEqual(after.url, before.url)
  assert.equal(after.transport, undefined)
  assert.equal(after.videoId, id)
  assert.equal(await yt.stream(), after)
})

test('a failed P1 repair is not repeated after the fresh primary also fails and its transport category survives', async t => {
  const yt = engine(t); await primaryStream(yt)
  const pending = yt.stream(id, true, undefined, true)
  await flush()
  assert.equal(yt.args().body.context.client.clientName, 'WEB_EMBEDDED_PLAYER')
  yt.error('network'); await flush()
  assert.equal(yt.args().body.context.client.clientName, 'VISIONOS')
  yt.result(unavailable())
  await assert.rejects(pending, error => error instanceof yt.YouTubeError && error.code === 'network')
  assert.equal(yt.history.filter(row => row.config.body?.context?.client?.clientName === 'WEB_EMBEDDED_PLAYER').length, 1)
  const retry = await visionos(yt)
  yt.result(player('after-failed-repair'))
  assert.equal((await retry.pending).url, audioUrl('after-failed-repair'))
})

test('cancelling primary repair cannot start a fresh primary request or cache late P1 audio', async t => {
  const yt = engine(t); await primaryStream(yt)
  const controller = new AbortController(), pending = yt.stream(id, true, controller.signal, true)
  await flush()
  assert.equal(yt.args().body.context.client.clientName, 'WEB_EMBEDDED_PLAYER')
  const stale = yt.frames[0], requests = yt.history.length
  controller.abort()
  yt.result(player('cancelled-repair'), stale)
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(yt.history.length, requests)
  const retry = await visionos(yt)
  yt.result(player('after-cancelled-repair'))
  assert.equal((await retry.pending).url, audioUrl('after-cancelled-repair'))
})

test('a P1 repair with another video ID is rejected before fresh primary recovery', async t => {
  const yt = engine(t); await primaryStream(yt)
  const pending = yt.stream(id, true, undefined, true)
  await flush()
  assert.equal(yt.args().body.context.client.clientName, 'WEB_EMBEDDED_PLAYER')
  yt.result(player('wrong-repair-recording', other)); await flush()
  assert.equal(yt.args().body.context.client.clientName, 'VISIONOS')
  yt.result(player('same-recording-after-mismatch'))
  const after = await pending
  assert.equal(after.videoId, id)
  assert.equal(after.url, audioUrl('same-recording-after-mismatch'))
  assert.equal(yt.history.some(row => row.config.message === 'pletina-youtube-p1-metadata'), false)
})

test('an expired primary locator renews through the normal client order', async t => {
  const yt = engine(t), before = await primaryStream(yt)
  t.mock.timers.enable({ apis: ['Date'], now: before.expiresAt + 1 })
  const renewal = await visionos(yt, true)
  yt.result(player('expired-primary-renewed'))
  assert.equal((await renewal.pending).url, audioUrl('expired-primary-renewed'))
  assert.deepEqual(yt.imports, [])
})

test('refresh without an earlier primary locator keeps the initial fast path', async t => {
  const yt = engine(t), renewal = await visionos(yt, true)
  yt.result(player('no-prior-locator'))
  assert.equal((await renewal.pending).url, audioUrl('no-prior-locator'))
  assert.deepEqual(yt.imports, [])
})

test('a refresh without playback repair permission preserves the primary download path', async t => {
  const yt = engine(t); await primaryStream(yt)
  const renewal = await visionos(yt, true)
  yt.result(player('download-renewed-primary'))
  assert.equal((await renewal.pending).url, audioUrl('download-renewed-primary'))
  assert.deepEqual(yt.imports, [])
})

for (const category of ['unavailable', 'format']) test(`${category} invokes P1 and validates metadata before caching`, async t => {
  const yt = engine(t), { pending } = await visionos(yt)
  let settled = false; pending.finally(() => { settled = true }).catch(() => {})
  await p1Request(yt, category === 'format' ? noFormat() : unavailable())
  assert.deepEqual(yt.imports.toSorted(), ['./p1-recipe.generated', './youtube-p1', './youtube-p1-probe'].toSorted())
  yt.result(player('p1'))
  await flush()
  assert.equal(settled, false, 'a locator alone must not be returned as a playable stream')
  assert.equal(yt.args().message, 'pletina-youtube-p1-metadata')
  yt.send({ index: 0, duration: 209.16 })
  const value = await pending, requests = yt.history.length
  assert.equal(value.transport, 'p1')
  assert.equal(value.videoId, id)
  assert.equal(value.contentLength, 123456)
  assert.equal(await yt.stream(), value)
  assert.equal(yt.history.length, requests)
  assert.deepEqual(yt.storageAccess, [])
})

test('successful P1 refresh replaces the old locator instead of returning it', async t => {
  const yt = engine(t), first = await visionos(yt)
  await p1Request(yt); await completeP1(yt, 'first')
  const before = await first.pending, renewal = await visionos(yt, true)
  await p1Request(yt); await completeP1(yt, 'renewed')
  const after = await renewal.pending
  assert.notEqual(after.url, before.url)
  assert.equal(after.url, audioUrl('renewed'))
  assert.equal(await yt.stream(), after)
  assert.equal(yt.history.filter(entry => entry.config.url?.includes('/search?')).length, 1, 'refresh may reuse the anonymous session, never the old media URL')
})

test('failed refresh evicts the previously usable P1 URL and a retry resolves anew', async t => {
  const yt = engine(t), first = await visionos(yt)
  await p1Request(yt); await completeP1(yt, 'old')
  const before = await first.pending, renewal = await visionos(yt, true)
  await p1Request(yt)
  yt.error('network')
  await assert.rejects(renewal.pending, error => error instanceof yt.YouTubeError && error.code === 'network')
  const retry = await visionos(yt)
  yt.result(player('new-normal'))
  assert.notEqual((await retry.pending).url, before.url)
})

for (const [name, reply, code] of [
  ['login restriction', { result: { playabilityStatus: { status: 'LOGIN_REQUIRED' } } }, 'restricted'],
  ['identity mismatch', { result: player('wrong', other) }, 'response'],
]) test(`${name} never activates the format/unavailable rescue`, async t => {
  const yt = engine(t), { pending } = await visionos(yt)
  yt.send(reply)
  await assert.rejects(pending, error => error instanceof yt.YouTubeError && error.code === code)
  assert.deepEqual(yt.imports, [])
  assert.equal(yt.frames.length, 0)
})

for (const code of ['network', 'timeout']) test(`anonymous session ${code} transport failure can use the same-ID P1 recipe without a VISIONOS request`, async t => {
  const yt = engine(t), pending = yt.stream()
  yt.error(code)
  await flush()
  assert.equal(yt.args().body.context.client.clientName, 'WEB_EMBEDDED_PLAYER')
  assert.equal(yt.args().body.videoId, id)
  await completeP1(yt, 'session-recovery')
  const value = await pending
  assert.equal(value.videoId, id)
  assert.equal(value.transport, 'p1')
  assert.equal(yt.history.filter(row => row.config.body?.context?.client?.clientName === 'VISIONOS').length, 0)
  const before = yt.history.length
  assert.equal(await yt.stream(), value)
  assert.equal(yt.history.length, before)
})

for (const code of ['network', 'timeout']) test(`VISIONOS ${code} transport failure can recover the same ID with probed P1 audio`, async t => {
  const yt = engine(t), { pending } = await visionos(yt)
  yt.error(code)
  await flush()
  assert.equal(yt.args().body.context.client.clientName, 'WEB_EMBEDDED_PLAYER')
  assert.equal(yt.args().body.videoId, id)
  await completeP1(yt, 'transport-recovery')
  const value = await pending
  assert.equal(value.videoId, id)
  assert.equal(value.transport, 'p1')
})

test('an anonymous session malformed response does not activate P1', async t => {
  const yt = engine(t), pending = yt.stream()
  yt.result({ responseContext: {} })
  await assert.rejects(pending, error => error.code === 'response')
  assert.deepEqual(yt.imports, [])
})

for (const code of ['network', 'timeout']) test(`P1 request ${code} remains transient after a primary format rejection`, async t => {
  const yt = engine(t), { pending } = await visionos(yt)
  await p1Request(yt, noFormat())
  yt.error(code)
  await assert.rejects(pending, error => error instanceof yt.YouTubeError && error.code === code)
  assert.equal(yt.frames.length, 0)
})

test('transport recovery still rejects a P1 identity mismatch without caching it', async t => {
  const yt = engine(t), { pending } = await visionos(yt)
  yt.error('network'); await flush()
  yt.result(player('wrong-transport-recovery', other))
  await assert.rejects(pending, error => error instanceof yt.YouTubeError && error.code === 'network')
  assert.equal(yt.frames.length, 0)
  const retry = await visionos(yt)
  yt.result(player('fresh-after-wrong-id'))
  assert.equal((await retry.pending).url, audioUrl('fresh-after-wrong-id'))
})

test('invalid anonymous recipe does not replace a primary transport category or reach a P1 request', async t => {
  const invalid = recipe(); invalid.playerSHA = 'not-a-player-hash'
  const yt = engine(t, { recipe: invalid }), { pending } = await visionos(yt)
  yt.error('network')
  await assert.rejects(pending, error => error instanceof yt.YouTubeError && error.code === 'network')
  assert.equal(yt.history.length, 2, 'only anonymous session and VISIONOS transports were used')
  assert.equal(yt.frames.length, 0)
})

for (const category of ['format', 'unavailable']) test(`P1 invalid format preserves original ${category} for later providers`, async t => {
  const yt = engine(t), { pending } = await visionos(yt)
  const originalReply = category === 'format' ? noFormat() : unavailable()
  let original
  try { yt.parsePlayer(originalReply, id) } catch (error) { original = error }
  await p1Request(yt, originalReply)
  yt.result(noFormat())
  await assert.rejects(pending, error => error instanceof yt.YouTubeError && error.code === category && error.message === original.message)
  assert.equal(yt.frames.length, 0)
  const retry = await visionos(yt)
  yt.result(player('retry'))
  assert.equal((await retry.pending).url, audioUrl('retry'))
})

test('rejected lazy import leaves the original source error and no cached locator', async t => {
  const yt = engine(t, { modules: { './youtube-p1': new Error('Synthetic chunk unavailable') } }), { pending } = await visionos(yt)
  yt.result(unavailable())
  await assert.rejects(pending, error => error.code === 'unavailable')
  const retry = await visionos(yt)
  yt.result(player('no-stale-cache'))
  assert.equal((await retry.pending).url, audioUrl('no-stale-cache'))
})

for (const mismatch of ['identity', 'duration', 'secondary-audio']) test(`P1 ${mismatch} mismatch cannot enter the stream cache`, async t => {
  const yt = engine(t), { pending } = await visionos(yt)
  await p1Request(yt)
  const response = player('invalid', mismatch === 'identity' ? other : id)
  if (mismatch === 'secondary-audio') response.streamingData.adaptiveFormats[0].audioTrack = { displayName: 'Descriptive audio', audioIsDefault: true }
  yt.result(response)
  await flush()
  if (mismatch === 'duration') yt.send({ index: 0, duration: 120 })
  else assert.equal(yt.frames.length, 0, 'an invalid response must be rejected before metadata probing')
  await assert.rejects(pending, error => error.code === 'unavailable')
  const retry = await visionos(yt)
  yt.result(player('valid-after-rejection'))
  assert.equal((await retry.pending).url, audioUrl('valid-after-rejection'))
})

test('abort before starting creates no frames, imports or cached stream', async t => {
  const yt = engine(t), controller = new AbortController(); controller.abort()
  await assert.rejects(yt.stream(id, false, controller.signal), { name: 'AbortError' })
  assert.equal(yt.history.length, 0)
  assert.deepEqual(yt.imports, [])
})

for (const phase of ['session', 'VISIONOS']) test(`abort during primary ${phase} transport never activates P1 recovery`, async t => {
  const yt = engine(t), controller = new AbortController()
  const pending = phase === 'session' ? yt.stream(id, false, controller.signal) : (await visionos(yt, false, controller.signal)).pending
  const obsolete = yt.frames[0]
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  yt.error('network', obsolete)
  await flush()
  assert.deepEqual(yt.imports, [])
  assert.equal(yt.frames.length, 0)
})

test('abort during lazy loading does not invoke the loaded P1 engine', async t => {
  const gate = deferred(), calls = []
  // TypeScript's CJS import interop must pass this deferred module through;
  // otherwise it wraps the Promise itself as a completed namespace object.
  Object.defineProperty(gate.promise, '__esModule', { value: true })
  const yt = engine(t, { modules: { './youtube-p1': gate.promise } }), controller = new AbortController()
  const { pending } = await visionos(yt, false, controller.signal)
  yt.result(unavailable()); await flush()
  assert.ok(yt.imports.includes('./youtube-p1'))
  controller.abort()
  gate.resolve({ requestP1Player() { calls.push('p1'); throw new Error('must not run') } })
  await assert.rejects(pending, { name: 'AbortError' })
  assert.deepEqual(calls, [])
  assert.equal(yt.frames.length, 0)
})

test('abort during P1 request removes transport and ignores its late successful response', async t => {
  const yt = engine(t), controller = new AbortController(), { pending } = await visionos(yt, false, controller.signal)
  await p1Request(yt)
  const obsolete = yt.frames[0]
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(yt.frames.length, 0)
  yt.result(player('late'), obsolete)
  const retry = await visionos(yt)
  yt.result(player('fresh'))
  assert.equal((await retry.pending).url, audioUrl('fresh'))
})

test('abort during metadata probing unloads its frame and never caches a late result', async t => {
  const yt = engine(t), controller = new AbortController(), { pending } = await visionos(yt, false, controller.signal)
  await p1Request(yt)
  yt.result(player('awaiting-metadata')); await flush()
  assert.equal(yt.args().message, 'pletina-youtube-p1-metadata')
  const obsolete = yt.frames[0]
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(yt.frames.length, 0)
  yt.send({ index: 0, duration: 209 }, obsolete)
  const retry = await visionos(yt)
  yt.result(player('after-probe-abort'))
  assert.equal((await retry.pending).url, audioUrl('after-probe-abort'))
})

test('account-bearing recipes are rejected before the P1 transport; anonymous IDs remain RAM only', async t => {
  const badRecipe = recipe(); badRecipe.context.client.authorization = 'synthetic-forbidden-value'
  const yt = engine(t, { recipe: badRecipe }), { pending } = await visionos(yt)
  yt.result(unavailable())
  await assert.rejects(pending, error => error.code === 'unavailable')
  assert.equal(yt.history.length, 2, 'a credential-bearing recipe must not reach a player POST')
  assert.deepEqual(yt.storageAccess, [])
  for (const { config, frame } of yt.history) {
    assert.match(config.url, /^https:\/\/www\.youtube\.com\/youtubei\/v1\/(?:search|player)\?prettyPrint=false$/)
    assert.equal(new URL(config.url).searchParams.has('key'), false)
    assert.match(frame.srcdoc, /credentials: 'omit'/)
    assert.doesNotMatch(JSON.stringify(config.body), /authorization|synthetic-forbidden-value/)
  }
})

test('a fresh module instance cannot retrieve another instance\'s signed locator', async t => {
  const first = engine(t), initial = await visionos(first)
  await p1Request(first); await completeP1(first, 'ram-only')
  await initial.pending
  const second = engine(t), pending = second.stream()
  assert.ok(second.args().url.includes('/search?'), 'the media URL and visitor must not survive a module reload')
  second.result({ responseContext: { visitorData: 'another-anonymous-fixture' } }); await flush()
  second.result(player('new-instance'))
  assert.equal((await pending).url, audioUrl('new-instance'))
  assert.deepEqual([...first.storageAccess, ...second.storageAccess], [])
})

test('abort between completed P1 cleanup and the public stream continuation cannot cache the locator', async t => {
  const controller = new AbortController()
  const yt = engine(t, { modules: { './youtube-p1-probe': { async probeP1AudioCandidates() {
    // The controlled result schedules cancellation when orchestration reads
    // its selected index. It lands after p1Stream's synchronous check and before
    // stream() resumes, independently of the old parallel cleanup microtasks.
    // The public operation must check again before committing the locator.
    return { get index() { queueMicrotask(() => controller.abort()); return 0 }, duration: 209.16 }
  } } } })
  const { pending } = await visionos(yt, false, controller.signal)
  await p1Request(yt)
  yt.result(player('aborted-at-public-handoff'))
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(yt.frames.length, 0)
  const retry = await visionos(yt)
  yt.result(player('after-public-handoff-abort'))
  assert.equal((await retry.pending).url, audioUrl('after-public-handoff-abort'))
})
