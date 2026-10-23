import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const code = ts.transpileModule(await readFile(new URL('../../web-port/youtube-p1.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText
const youtubeCode = ts.transpileModule(await readFile(new URL('../../web-port/youtube.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText
const youtube = {}; new Function('exports', youtubeCode)(youtube)
const videoId = 'aaaaaaaaaaa'
const baseUrl = 'https://rr1---sn-synthetic.googlevideo.com/videoplayback?expire=9999999999&itag=140'
const mp4 = extra => ({ itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128000, ...extra })
const cipherFormat = (signature = 'input_signature', n = 'input_n') => mp4({ signatureCipher: new URLSearchParams({
  url: baseUrl + (n === null ? '' : '&n=' + encodeURIComponent(n)), s: signature, sp: 'sig',
}).toString() })
const player = (formats = [mp4({ url: baseUrl })]) => ({ playabilityStatus: { status: 'OK', playableInEmbed: true },
  videoDetails: { videoId, title: 'Synthetic test', lengthSeconds: '210' }, streamingData: { adaptiveFormats: formats } })
// A deliberately tiny extracted-fragment fixture, with the same public export
// and URL-like prototype contract as P1. No provider data or media is persisted.
const script = `
class Locator {
  constructor(n, sig) { this.values = { n, sig } }
  get(key) { return this.values[key] }
  set(key, value) { this.values[key] = value }
  clone() { return this }
  transform() { this.values.sig = encodeURIComponent('decoded_signature=='); this.values.n = 'decoded_n' }
}
var exportedVars = { nsigFunction(url, key, sig) {
  if (['fetch','Worker','SharedWorker','importScripts','indexedDB','caches','navigator','postMessage','Function','eval','WebSocket','BroadcastChannel','SharedArrayBuffer','WebAssembly'].some(key => globalThis[key] !== undefined)) throw Error('HOST_API');
  return new Locator(url.split('&n=')[1], sig)
} };`
const recipe = extra => ({ context: { client: { clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: '2.20261022.01.00', visitorData: 'synthetic-public-visitor' },
  thirdParty: { embedUrl: 'https://www.reddit.com/' } }, playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS', encryptedHostFlags: 'synthetic-public-flags' } },
  signatureTimestamp: 20746, script, createdAt: '2026-01-01T00:00:00Z', playerSHA: 'a'.repeat(64), ...extra })
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }

function harness(options = {}) {
  const api = {}, listeners = new Set(), frames = new Set(), blobs = new Map(), timers = new Set(), workers = new Set()
  const metrics = { requests: 0, workerStarts: 0, revoked: 0, stops: 0, emitted: 0 }
  const schedule = (fn, ms) => {
    const handle = setTimeout(() => { timers.delete(handle); fn() }, options.fastTimeout && ms >= 1500 ? 10 : ms)
    timers.add(handle); return handle
  }
  const unschedule = handle => { timers.delete(handle); clearTimeout(handle) }
  const mainWindow = { addEventListener(_type, fn) { listeners.add(fn) }, removeEventListener(_type, fn) { listeners.delete(fn) } }
  const emit = event => { metrics.emitted++; for (const fn of [...listeners]) fn(event) }
  const document = { createElement(tag) {
    assert.equal(tag, 'iframe')
    const frameListeners = new Set()
    const frame = { srcdoc: '', hidden: false, attributes: {},
      setAttribute(name, value) { this.attributes[name] = value },
      remove() { frames.delete(frame) },
      contentWindow: { postMessage(data) { metrics.stops++; for (const fn of [...frameListeners]) fn({ source: parent, data }) } },
    }
    const parent = { postMessage(data) { queueMicrotask(() => emit({ source: frame.contentWindow, origin: 'null', data })) } }
    const sandboxWindow = { addEventListener(_type, fn) { frameListeners.add(fn) }, removeEventListener(_type, fn) { frameListeners.delete(fn) } }
    class Worker {
      constructor(url) {
        metrics.workerStarts++; this.terminated = false; workers.add(this)
        this.context = vm.createContext({ postMessage: data => queueMicrotask(() => { if (!this.terminated) this.onmessage?.({ data }) }) })
        vm.runInContext(blobs.get(url).parts.join(''), this.context)
      }
      postMessage(data) {
        if (options.holdWorker) return
        queueMicrotask(() => {
          if (this.terminated) return
          try { this.context.input = data; vm.runInContext('onmessage({data: input})', this.context, { timeout: 100 }) }
          catch { this.onerror?.({ preventDefault() {} }) }
        })
      }
      terminate() { this.terminated = true; workers.delete(this) }
    }
    const sandbox = vm.createContext({ window: sandboxWindow, parent, Worker, Blob: class { constructor(parts) { this.parts = parts } },
      URL: { createObjectURL(blob) { const key = 'blob:synthetic-' + blobs.size; blobs.set(key, blob); return key }, revokeObjectURL(url) { blobs.delete(url); metrics.revoked++ } },
      setTimeout: schedule, clearTimeout: unschedule })
    frame.start = () => {
      assert.equal(frame.attributes.sandbox, 'allow-scripts')
      assert.match(frame.srcdoc, /connect-src 'none'/)
      assert.match(frame.srcdoc, /worker-src blob:/)
      assert.doesNotMatch(frame.attributes.sandbox, /allow-same-origin/)
      const start = frame.srcdoc.indexOf('<script>') + 8, end = frame.srcdoc.lastIndexOf('</script>')
      vm.runInContext(frame.srcdoc.slice(start, end), sandbox)
    }
    return frame
  }, body: { append(frame) { if (options.appendError) throw Error('append failed'); frames.add(frame); frame.start() } } }
  new Function('exports', 'window', 'document', 'crypto', 'setTimeout', 'clearTimeout', code)(api, mainWindow, document, globalThis.crypto, schedule, unschedule)
  return { ...api, metrics, frames, workers, blobs, listeners, timers, emit,
    request: response => async () => { metrics.requests++; return response },
    clean() { assert.equal(frames.size, 0, 'frames'); assert.equal(workers.size, 0, 'workers'); assert.equal(blobs.size, 0, 'blob URLs'); assert.equal(listeners.size, 0, 'message listeners'); assert.equal(timers.size, 0, 'timers') } }
}

const rejects = (h, fn, code) => assert.rejects(fn, error => error instanceof h.P1EngineError && error.code === code)

test('direct AAC response uses only the public body and preserves non-AAC metadata without its locators', async () => {
  const h = harness(), input = player([mp4({ url: baseUrl }), { itag: 251, mimeType: 'audio/webm; codecs="opus"', signatureCipher: 'ignored' }])
  input.streamingData.formats = [{ url: 'https://example.invalid/not-audio' }]
  let body
  const result = await h.requestP1Player(videoId, async (value, signal) => { body = value; assert.equal(signal.aborted, false); return input }, recipe())
  assert.deepEqual(body.playbackContext.contentPlaybackContext, { html5Preference: 'HTML5_PREF_WANTS', encryptedHostFlags: 'synthetic-public-flags', signatureTimestamp: 20746 })
  assert.equal(body.videoId, videoId); assert.equal(body.contentCheckOk, true); assert.equal(body.racyCheckOk, true)
  assert.equal(body.context.client.clientName, 'WEB_EMBEDDED_PLAYER')
  assert.equal(result.videoDetails.title, 'Synthetic test'); assert.equal(result.streamingData.adaptiveFormats.length, 2)
  assert.equal(result.streamingData.adaptiveFormats[1].mimeType, 'audio/webm; codecs="opus"')
  assert.equal(result.streamingData.adaptiveFormats[1].signatureCipher, undefined)
  assert.equal(result.streamingData.formats, undefined); assert.notEqual(result, input); assert.equal(h.metrics.workerStarts, 0); h.clean()
})

test('non-AAC language metadata still forces explicit originality in the real parsePlayer', async () => {
  const h = harness(), opus = { itag: 251, mimeType: 'audio/webm; codecs="opus"', audioTrack: { audioIsDefault: true, displayName: 'English dubbed' }, signatureCipher: 'not transformed' }
  const implicit = await h.requestP1Player(videoId, h.request(player([mp4({ url: baseUrl }), opus])), recipe())
  assert.throws(() => youtube.parsePlayer(implicit, videoId), { code: 'format' })
  const original = await h.requestP1Player(videoId, h.request(player([mp4({ url: baseUrl, audioTrack: { audioIsDefault: true, displayName: 'Original' } }), opus])), recipe())
  assert.equal(youtube.parsePlayer(original, videoId).url, baseUrl); h.clean()
})

test('real argument-only processor transforms signature and n in an isolated worker and cleans up', async () => {
  const h = harness(), result = await h.requestP1Player(videoId, h.request(player([cipherFormat()])), recipe())
  const format = result.streamingData.adaptiveFormats[0], url = new URL(format.url)
  assert.equal(url.searchParams.get('sig'), 'decoded_signature=='); assert.equal(url.searchParams.get('n'), 'decoded_n')
  assert.equal(format.signatureCipher, undefined); assert.equal(format.cipher, undefined)
  assert.equal(h.metrics.workerStarts, 1); assert.equal(h.metrics.revoked, 1); h.clean()
})

test('signature-only, n-only and four candidates use one bounded worker', async () => {
  const h = harness(), formats = [cipherFormat('first', null), mp4({ url: baseUrl + '&n=input_n' }), cipherFormat(), cipherFormat('fourth')]
  const result = await h.requestP1Player(videoId, h.request(player(formats)), recipe())
  assert.equal(result.streamingData.adaptiveFormats.length, 4)
  assert.equal(new URL(result.streamingData.adaptiveFormats[0].url).searchParams.get('n'), null)
  assert.equal(new URL(result.streamingData.adaptiveFormats[1].url).searchParams.get('sig'), null)
  assert.equal(h.metrics.workerStarts, 1); h.clean()
})

test('encrypted padding, quotes, spaces and punctuation enter the worker only as data', async () => {
  const h = harness()
  for (const [signature, n] of [['==prefix=padding', '=opaque=n='], ['quote\"\';throw Error(\"injected\");//', 'punctuation+/%=?&'],
    ['opaque signature with spaces', 'opaque n with spaces'], ['</script><script>throw Error(1)</script>', '==arbitrary.padding']]) {
    const input = cipherFormat(signature, n), parsed = h.inspectP1Format(input)
    assert.equal(parsed.signature, signature); assert.equal(parsed.n, n)
    const result = await h.requestP1Player(videoId, h.request(player([input])), recipe())
    const output = new URL(result.streamingData.adaptiveFormats[0].url)
    assert.equal(output.searchParams.get('sig'), 'decoded_signature=='); assert.equal(output.searchParams.get('n'), 'decoded_n')
    h.clean()
  }
})

test('opaque inputs still reject empty values, ASCII controls and excessive length', () => {
  const h = harness()
  for (const value of ['', 'line\nfeed', 'carriage\rreturn', 'nul\0byte', 'tab\tbyte', 'delete\u007fbyte', 'a'.repeat(4097)]) {
    assert.throws(() => h.inspectP1Format(cipherFormat(value, null)), { code: 'format' })
    assert.throws(() => h.inspectP1Format(mp4({ url: baseUrl + '&n=' + encodeURIComponent(value) })), { code: 'format' })
  }
  h.clean()
})

test('unknown origins, URL credentials, ports, paths, fragments, malformed escapes and duplicate parameters are rejected', () => {
  const h = harness()
  for (const url of ['http://rr.googlevideo.com/videoplayback', 'https://googlevideo.com.evil.invalid/videoplayback',
    'https://user:pass@rr.googlevideo.com/videoplayback', 'https://rr.googlevideo.com:444/videoplayback',
    'https://rr.googlevideo.com/other', baseUrl + '#fragment', baseUrl + '&n=a&n=b', baseUrl + '&expire=1', baseUrl + '&n=%ZZ',
    baseUrl + '&x=' + 'a'.repeat(4096), baseUrl + ' ']) assert.throws(() => h.inspectP1Format(mp4({ url })), { code: 'format' }, url.slice(0, 100))
  h.clean()
})

test('signature ciphers must have one URL and signature, known fields and a permitted signature parameter', () => {
  const h = harness(), valid = cipherFormat().signatureCipher
  for (const signatureCipher of ['', valid + '&s=other', valid + '&url=x', valid + '&unknown=1', valid + '&sp=sig',
    new URLSearchParams({ url: baseUrl, s: 'abc', sp: 'n' }).toString(), new URLSearchParams({ url: baseUrl, s: '' }).toString(),
    new URLSearchParams({ url: baseUrl, s: 'bad\nsignature' }).toString(), valid + '%zz', 'x'.repeat(4097)])
    assert.throws(() => h.inspectP1Format(mp4({ signatureCipher })), { code: 'format' })
  assert.throws(() => h.inspectP1Format({ ...cipherFormat(), cipher: valid }), { code: 'format' })
  assert.throws(() => h.inspectP1Format(mp4({ signatureCipher: null })), { code: 'format' })
  assert.throws(() => h.inspectP1Format(mp4({ url: baseUrl, signatureCipher: null })), { code: 'format' })
  assert.throws(() => h.inspectP1Format({ ...cipherFormat(), url: baseUrl }), { code: 'format' })
  assert.throws(() => h.inspectP1Format(cipherFormat('abc', 'bad\nn')), { code: 'format' })
  assert.throws(() => h.inspectP1Format(mp4({ signatureCipher: new URLSearchParams({ url: baseUrl + '&sig=old', s: 'abc', sp: 'sig' }).toString() })), { code: 'format' })
  h.clean()
})

test('decoder output rejects unchanged n, exception markers, wrong alphabets, padding and unexpected fields', () => {
  const h = harness(), parsed = h.inspectP1Format(cipherFormat())
  for (const result of [null, {}, { sig: 'ok', n: 'input_n' }, { sig: 'enhanced_except_foo', n: 'new' },
    { sig: 'ok', n: 'enhanced_except_foo' }, { sig: 'ok===', n: 'new' }, { sig: '=ok', n: 'new' },
    { sig: 'ok', n: 'new=' }, { sig: 'has space', n: 'new' }, { sig: 'ok', n: 'new', url: baseUrl },
    { sig: 'a'.repeat(4097), n: 'new' }, { sig: 'ok', n: 12 }, { sig: 'ok', n: 'new\n' }])
    assert.throws(() => h.applyP1Decoded(parsed, result), { code: 'decoder' })
  const url = new URL(h.applyP1Decoded(parsed, { sig: 'valid_.-==', n: 'valid_.-' }))
  assert.equal(url.searchParams.get('sig'), 'valid_.-==')
  assert.throws(() => h.applyP1Decoded(h.inspectP1Format(mp4({ url: baseUrl })), { n: 'unexpected' }), { code: 'decoder' }); h.clean()
})

test('only AAC/MP4 without DRM is accepted', () => {
  const h = harness()
  for (const extra of [{ mimeType: 'audio/webm; codecs="opus"' }, { mimeType: 'video/mp4; codecs="mp4a.40.2"' },
    { mimeType: 'audio/mp4; codecs="alac"' }, { mimeType: 'audio/mp4' }, { drmFamilies: ['WIDEVINE'] }, { drmFamilies: true },
    { licenseInfos: [] }, { drmTrackType: 'AUDIO' }, { keySystems: {} }])
    assert.throws(() => h.inspectP1Format(mp4({ url: baseUrl, ...extra })), { code: 'format' })
  assert.equal(h.inspectP1Format(mp4({ url: baseUrl, drmFamilies: [] })).url, baseUrl); h.clean()
})

test('exact ID, OK status, public visibility and embed availability are mandatory', async () => {
  const h = harness()
  for (const input of [{}, { ...player(), videoDetails: { videoId: 'bbbbbbbbbbb' } }, { ...player(), videoDetails: null }])
    await rejects(h, () => h.requestP1Player(videoId, h.request(input), recipe()), 'response')
  for (const input of [{ ...player(), playabilityStatus: { status: 'LOGIN_REQUIRED' } },
    { ...player(), playabilityStatus: { status: 'OK', playableInEmbed: false } },
    { ...player(), videoDetails: { videoId, isPrivate: true } }, { ...player(), videoDetails: { videoId, playableInEmbed: false } }])
    await rejects(h, () => h.requestP1Player(videoId, h.request(input), recipe()), 'restricted')
  assert.equal(h.metrics.workerStarts, 0); h.clean()
})

test('stream candidates, response JSON size and streaming DRM claims are bounded', async () => {
  const h = harness()
  for (const input of [player([]), player(Array.from({ length: 5 }, () => mp4({ url: baseUrl }))),
    player(Array.from({ length: 129 }, () => ({ mimeType: 'video/webm' }))),
    { ...player(), streamingData: { ...player().streamingData, licenseInfos: [] } }])
    await rejects(h, () => h.requestP1Player(videoId, h.request(input), recipe()), 'format')
  const cyclic = player(); cyclic.self = cyclic
  for (const input of [cyclic, { ...player(), padding: 'a'.repeat(4 * 1024 * 1024) }])
    await rejects(h, () => h.requestP1Player(videoId, h.request(input), recipe()), 'response')
  h.clean()
})

test('invalid, expired, credentialed or mismatched recipes do not issue a request', async () => {
  const h = harness(), request = h.request(player())
  for (const value of [recipe({ script: '' }), recipe({ script: 'a'.repeat(2 * 1024 * 1024 + 1) }), recipe({ playerSHA: 'no' }),
    recipe({ signatureTimestamp: 0 }), recipe({ signatureTimestamp: 1.2 }), recipe({ createdAt: 'invalid' }), recipe({ expiresAt: 'invalid' }),
    recipe({ expiresAt: '2000-01-01T00:00:00Z' }), recipe({ context: { client: { clientName: 'WEB', clientVersion: '2.0' } } }),
    recipe({ context: { client: { clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: '2.0', accessToken: 'not-allowed' } } }),
    recipe({ context: { client: { clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: '2.0' }, thirdParty: { embedUrl: 'https://user:pass@example.invalid/' } } }),
    recipe({ playbackContext: { contentPlaybackContext: { signatureTimestamp: 123 } } })])
    await rejects(h, () => h.requestP1Player(videoId, request, value), 'recipe')
  assert.equal(h.metrics.requests, 0); h.clean()
})

test('old creation dates have no invented TTL; an explicit future expiry is respected', async () => {
  const h = harness()
  await h.requestP1Player(videoId, h.request(player()), recipe({ createdAt: '2000-01-01T00:00:00Z', expiresAt: '2999-01-01T00:00:00Z' }))
  await h.requestP1Player(videoId, h.request(player()), recipe({ createdAt: '2000-01-01T00:00:00Z' })); h.clean()
})

test('invalid video IDs and an already aborted signal never call the transport', async () => {
  const h = harness(), request = h.request(player())
  for (const id of ['', 'short', 'aaaaaaaaaa!', 'a'.repeat(12)]) await rejects(h, () => h.requestP1Player(id, request, recipe()), 'response')
  const controller = new AbortController(); controller.abort()
  await assert.rejects(() => h.requestP1Player(videoId, request, recipe(), controller.signal), { name: 'AbortError' })
  assert.equal(h.metrics.requests, 0); h.clean()
})

test('cancellation interrupts a transport which ignores abort, and forwards signal cancellation', async () => {
  const h = harness(), controller = new AbortController(); let transportSignal
  const pending = h.requestP1Player(videoId, (_body, signal) => { transportSignal = signal; return new Promise(() => {}) }, recipe(), controller.signal)
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(transportSignal.aborted, true); h.clean()
})

test('global deadline interrupts a transport which never settles', async () => {
  const h = harness({ fastTimeout: true })
  await rejects(h, () => h.requestP1Player(videoId, () => new Promise(() => {}), recipe()), 'timeout'); h.clean()
})

test('cancellation terminates a pending decoder and removes frame, blob, timers and listeners', async () => {
  const h = harness({ holdWorker: true }), controller = new AbortController()
  const pending = h.requestP1Player(videoId, h.request(player([cipherFormat()])), recipe(), controller.signal)
  await flush(); assert.equal(h.metrics.workerStarts, 1); controller.abort()
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(h.metrics.revoked, 1); h.clean()
})

test('messages from another origin, window or request cannot complete the decoder', async () => {
  const h = harness({ holdWorker: true }), controller = new AbortController()
  let completed = false
  const pending = h.requestP1Player(videoId, h.request(player([cipherFormat()])), recipe(), controller.signal).finally(() => { completed = true })
  await flush(); const frame = [...h.frames][0]
  for (const event of [{ source: {}, origin: 'null', data: { id: 'unknown', result: { result: [{ sig: 'fake', n: 'fake' }] } } },
    { source: frame.contentWindow, origin: 'https://example.invalid', data: { id: 'unknown' } },
    { source: frame.contentWindow, origin: 'null', data: { id: 'unknown', result: { result: [] } } }]) h.emit(event)
  await flush(); assert.equal(completed, false); controller.abort()
  await assert.rejects(pending, { name: 'AbortError' }); h.clean()
})

test('worker deadline terminates the decoder without leaving resources', async () => {
  const h = harness({ holdWorker: true, fastTimeout: true })
  await rejects(h, () => h.requestP1Player(videoId, h.request(player([cipherFormat()])), recipe()), 'timeout'); h.clean()
})

test('provider fragment failure and iframe creation failure clean up', async () => {
  for (const [options, decoder] of [[{}, 'throw Error("provider failed")'], [{ appendError: true }, script]]) {
    const h = harness(options)
    await rejects(h, () => h.requestP1Player(videoId, h.request(player([cipherFormat()])), recipe({ script: decoder })), 'decoder'); h.clean()
  }
})

test('transport errors are preserved without starting a decoder', async () => {
  const h = harness(), error = Error('offline')
  await assert.rejects(() => h.requestP1Player(videoId, async () => { throw error }, recipe()), value => value === error)
  assert.equal(h.metrics.workerStarts, 0); h.clean()
})
