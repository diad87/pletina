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
const opus = extra => ({ itag: 251, mimeType: 'audio/webm; codecs="opus"', bitrate: 160000, ...extra })
const cipherFormat = (signature = 'input_signature', n = 'input_n') => mp4({ signatureCipher: new URLSearchParams({
  url: baseUrl + (n === null ? '' : '&n=' + encodeURIComponent(n)), s: signature, sp: 'sig',
}).toString() })
const player = (formats = [mp4({ url: baseUrl })]) => ({ playabilityStatus: { status: 'OK', playableInEmbed: true },
  videoDetails: { videoId, title: 'Synthetic test', lengthSeconds: '210' }, streamingData: { adaptiveFormats: formats } })
const sabrPlayer = (formats = [mp4({})]) => ({ ...player(formats), streamingData: {
  adaptiveFormats: formats, serverAbrStreamingUrl: baseUrl + '&sabr=1',
} })
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
const renewedRecipe = extra => recipe({ context: { ...recipe().context,
  client: { ...recipe().context.client, visitorData: 'second-independent-public-visitor' } }, ...extra })
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }

function harness(options = {}) {
  const api = {}, listeners = new Set(), frames = new Set(), blobs = new Map(), timers = new Set(), workers = new Set()
  const metrics = { requests: 0, workerStarts: 0, revoked: 0, stops: 0, emitted: 0, batchSizes: [], scheduledMs: [] }
  const schedule = (fn, ms) => {
    metrics.scheduledMs.push(ms)
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
        this.context = vm.createContext({ postMessage: data => queueMicrotask(() => {
          if (!this.terminated) this.onmessage?.({ data: options.workerResult ? options.workerResult(data) : data })
        }) })
        vm.runInContext(blobs.get(url).parts.join(''), this.context)
      }
      postMessage(data) {
        metrics.batchSizes.push(data.values.length)
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

test('Opus is explicit opt-in and never admits other containers, codecs, video or DRM', async () => {
  const h = harness(), format = opus({ url: baseUrl + '&mime=audio%2Fwebm' })
  assert.throws(() => h.inspectP1Format(format), { code: 'format' })
  assert.equal(h.inspectP1Format(format, true).url, format.url)
  await rejects(h, () => h.requestP1Player(videoId, h.request(player([format])), recipe()), 'format')
  const result = await h.requestP1Player(videoId, h.request(player([format])), recipe(), undefined, undefined, true)
  assert.equal(result.streamingData.adaptiveFormats[0].url, format.url)
  for (const extra of [{ mimeType: 'audio/webm' }, { mimeType: 'audio/webm; codecs="vorbis"' },
    { mimeType: 'audio/webm; codecs="opus, vorbis"' }, { mimeType: 'audio/ogg; codecs="opus"' },
    { mimeType: 'video/webm; codecs="opus"' }, { mimeType: 'audio/mp4; codecs="opus"' },
    { drmFamilies: ['WIDEVINE'] }, { drmFamilies: {} }, { licenseInfos: [] }, { drmTrackType: 'AUDIO' }, { keySystems: {} }])
    assert.throws(() => h.inspectP1Format({ ...format, ...extra }, true), { code: 'format' })
  assert.equal(h.metrics.workerStarts, 0); h.clean()
})

test('mixed encodings preserve all metadata, prefer supported Opus, and share one four-cipher budget', async () => {
  const h = harness(), encrypted = (format, value) => ({ ...format, signatureCipher: cipherFormat(value).signatureCipher })
  const formats = [encrypted(opus({ bitrate: 900000 }), 'opus-low'), encrypted(mp4({ bitrate: 96000 }), 'aac-low'),
    encrypted(opus({ bitrate: 1000000 }), 'opus-mid'), encrypted(opus({ bitrate: 1100000 }), 'opus-high'),
    encrypted(mp4({ bitrate: 128000 }), 'aac-high'), encrypted(opus({ bitrate: 1200000 }), 'opus-best')]
  let inspected = 0
  const result = await h.requestP1Player(videoId, h.request(player(formats)), recipe(), undefined, (_format, all) => {
    inspected++; assert.equal(all.length, 6); return true
  }, true)
  assert.equal(inspected, 6)
  assert.deepEqual(result.streamingData.adaptiveFormats.map(format => Boolean(format.url)), [true, false, true, true, false, true],
    'An explicitly Opus-capable browser follows Native codec order, then bitrate')
  assert.deepEqual(result.streamingData.adaptiveFormats.map(format => format.mimeType), formats.map(format => format.mimeType))
  assert.ok(result.streamingData.adaptiveFormats.every(format => !Object.hasOwn(format, 'signatureCipher')))
  assert.deepEqual(h.metrics.batchSizes, [4]); h.clean()
})

test('Opus uses the same isolated decipher and cannot bypass caller originality or cancellation', async () => {
  const h = harness(), formats = [opus({ signatureCipher: cipherFormat('dub').signatureCipher, audioTrack: { displayName: 'Dubbed' } }),
    opus({ signatureCipher: cipherFormat('original').signatureCipher, audioTrack: { displayName: 'Original' } })]
  const result = await h.requestP1Player(videoId, h.request(player(formats)), recipe(), undefined, (format, all) => {
    assert.equal(all[0].audioTrack.displayName, 'Dubbed'); return format.audioTrack?.displayName === 'Original'
  }, true)
  assert.equal(result.streamingData.adaptiveFormats[0].url, undefined)
  assert.equal(new URL(result.streamingData.adaptiveFormats[1].url).searchParams.get('n'), 'decoded_n')
  assert.equal(result.streamingData.adaptiveFormats[0].audioTrack.displayName, 'Dubbed'); h.clean()
  const held = harness({ holdWorker: true }), controller = new AbortController()
  const pending = held.requestP1Player(videoId, held.request(player([cipherFormat(), formats[1]])), recipe(), controller.signal, undefined, true)
  await flush(); assert.deepEqual(held.metrics.batchSizes, [2]); controller.abort()
  await assert.rejects(pending, { name: 'AbortError' }); held.clean()
})

test('public rollout version tokens pass through exactly while malformed tokens never call transport', async () => {
  const h = harness()
  for (const version of ['2.20261022.01.00-canary_control_2.20261023.01.00', 'release_1+fix-2.3', 'canary', 'v'.repeat(64)]) {
    let requested
    await h.requestP1Player(videoId, async body => { requested = body.context.client.clientVersion; return player() },
      recipe({ context: { client: { clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: version } } }))
    assert.equal(requested, version)
  }
  for (const version of ['', 'v'.repeat(65), '2.1 bad', '2.1\tbad', '2.1\r\nCookie:bad', '2.1é', '2.1/next', '2.1?key', '2.1"', '2.1%2B'])
    await rejects(h, () => h.requestP1Player(videoId, () => { throw Error('Invalid recipe reached HTTP') },
      recipe({ context: { client: { clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: version } } })), 'recipe')
  h.clean()
})

test('proved SABR-only audio renews one changed public context and uses its matching decoder', async () => {
  const h = harness(), bodies = [], signals = []
  const first = sabrPlayer([mp4({ url: null, signatureCipher: null }), opus({ audioTrack: { displayName: 'Original' } })])
  const second = sabrPlayer([cipherFormat()])
  const fallback = renewedRecipe({ script: script.replace('decoded_signature==', 'renewed_signature==').replace("'decoded_n'", "'renewed_n'") })
  const result = await h.requestP1Player(videoId, async (body, signal) => {
    bodies.push(body); signals.push(signal); return bodies.length === 1 ? first : second
  }, recipe(), undefined, () => true, true, fallback)
  assert.equal(bodies.length, 2); assert.equal(signals[0], signals[1])
  assert.ok(bodies.every(body => body.videoId === videoId && body.contentCheckOk === true && body.racyCheckOk === true))
  assert.equal(bodies[0].context.client.visitorData, 'synthetic-public-visitor')
  assert.equal(bodies[1].context.client.visitorData, 'second-independent-public-visitor')
  assert.deepEqual(bodies[0].playbackContext, bodies[1].playbackContext)
  assert.equal(h.metrics.scheduledMs.filter(ms => ms === 15000).length, 1, 'renewal cannot reset the original deadline')
  const url = new URL(result.streamingData.adaptiveFormats[0].url)
  assert.equal(url.searchParams.get('sig'), 'renewed_signature=='); assert.equal(url.searchParams.get('n'), 'renewed_n')
  assert.equal(first.streamingData.adaptiveFormats[0].url, null, 'wire responses remain untouched')
  assert.equal(h.metrics.workerStarts, 1); h.clean()
})

test('recipe metadata and object key order cannot disguise an unchanged effective POST', async () => {
  const original = recipe()
  const reordered = recipe({ context: { thirdParty: original.context.thirdParty, client: {
    visitorData: original.context.client.visitorData, clientVersion: original.context.client.clientVersion,
    clientName: original.context.client.clientName,
  } }, playbackContext: { contentPlaybackContext: { encryptedHostFlags: 'synthetic-public-flags',
    signatureTimestamp: 20746, html5Preference: 'HTML5_PREF_WANTS' } } })
  for (const fallback of [recipe({ createdAt: '2026-10-24T00:00:00Z', playerSHA: 'b'.repeat(64), script: 'throw Error("unused")' }), reordered]) {
    const h = harness()
    await rejects(h, () => h.requestP1Player(videoId, h.request(sabrPlayer()), original, undefined, undefined, false, fallback), 'format')
    assert.equal(h.metrics.requests, 1); assert.equal(h.metrics.workerStarts, 0); h.clean()
  }
})

test('SABR beside a usable locator is a normal one-POST response, even with an invalid unused fallback', async () => {
  const h = harness()
  const result = await h.requestP1Player(videoId, h.request(sabrPlayer([cipherFormat()])), recipe(), undefined, undefined, false,
    renewedRecipe({ script: '' }))
  assert.equal(new URL(result.streamingData.adaptiveFormats[0].url).searchParams.get('n'), 'decoded_n')
  assert.equal(h.metrics.requests, 1); assert.equal(h.metrics.workerStarts, 1); h.clean()
})

test('renewal requires trusted SABR, supported unencrypted audio and no malformed existing locators', async () => {
  const missingSabr = sabrPlayer(); delete missingSabr.streamingData.serverAbrStreamingUrl
  const cases = [missingSabr, sabrPlayer([]), sabrPlayer([{ mimeType: 'video/mp4; codecs="avc1.640028"' }]),
    sabrPlayer([mp4({ drmFamilies: ['WIDEVINE'] })]), sabrPlayer([mp4({ signatureCipher: '' })]),
    sabrPlayer([mp4({ signatureCipher: 'malformed-cipher' })]), sabrPlayer([mp4({ url: 'https://outside.invalid/' })]),
    sabrPlayer([mp4({}), mp4({ cipher: 'malformed-cipher' })])]
  for (const url of ['http://rr.googlevideo.com/videoplayback', 'https://googlevideo.com.evil.invalid/videoplayback',
    'https://user:pass@rr.googlevideo.com/videoplayback', 'https://rr.googlevideo.com:444/videoplayback',
    'https://rr.googlevideo.com/other', baseUrl + '#fragment', baseUrl + '&expire=1', baseUrl + '&n=%ZZ']) {
    const input = sabrPlayer(); input.streamingData.serverAbrStreamingUrl = url; cases.push(input)
  }
  for (const input of cases) {
    const h = harness()
    await rejects(h, () => h.requestP1Player(videoId, h.request(input), recipe(), undefined, undefined, false, renewedRecipe()), 'format')
    assert.equal(h.metrics.requests, 1); assert.equal(h.metrics.workerStarts, 0); h.clean()
  }
})

test('missing locators cannot renew rejected language metadata or unsupported Opus', async () => {
  const input = sabrPlayer([mp4({ audioTrack: { displayName: 'Dubbed' } }), opus({ audioTrack: { displayName: 'Original' } })])
  const accept = (format, all) => { assert.equal(all.length, 2); return format.audioTrack?.displayName === 'Original' }
  const aacOnly = harness()
  await rejects(aacOnly, () => aacOnly.requestP1Player(videoId, aacOnly.request(input), recipe(), undefined, accept, false, renewedRecipe()), 'format')
  assert.equal(aacOnly.metrics.requests, 1); aacOnly.clean()
  const supported = harness(); let calls = 0
  const result = await supported.requestP1Player(videoId, async () => ++calls === 1 ? input : player([
    mp4({ audioTrack: { displayName: 'Dubbed' }, url: baseUrl }), opus({ audioTrack: { displayName: 'Original' }, url: baseUrl + '&opus=1' }),
  ]), recipe(), undefined, accept, true, renewedRecipe())
  assert.equal(calls, 2); assert.equal(result.streamingData.adaptiveFormats[0].url, undefined)
  assert.equal(result.streamingData.adaptiveFormats[1].url, baseUrl + '&opus=1'); supported.clean()
})

test('identity, restrictions and global DRM are checked before any context renewal', async () => {
  const cases = [[{ ...sabrPlayer(), videoDetails: { videoId: 'bbbbbbbbbbb' } }, 'response'],
    [{ ...sabrPlayer(), playabilityStatus: { status: 'LOGIN_REQUIRED' } }, 'restricted'],
    [{ ...sabrPlayer(), playabilityStatus: { status: 'OK', playableInEmbed: false } }, 'restricted'],
    [{ ...sabrPlayer(), videoDetails: { videoId, isPrivate: true } }, 'restricted'],
    [{ ...sabrPlayer(), streamingData: { ...sabrPlayer().streamingData, licenseInfos: [] } }, 'format']]
  for (const [input, code] of cases) {
    const h = harness()
    await rejects(h, () => h.requestP1Player(videoId, h.request(input), recipe(), undefined, undefined, false, renewedRecipe()), code)
    assert.equal(h.metrics.requests, 1); assert.equal(h.metrics.workerStarts, 0); h.clean()
  }
})

test('an invalid renewed recipe never reaches the transport and a second SABR response never renews again', async () => {
  const invalid = harness()
  await rejects(invalid, () => invalid.requestP1Player(videoId, invalid.request(sabrPlayer()), recipe(), undefined, undefined, false,
    renewedRecipe({ context: { client: { clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: '2.0', accessToken: 'forbidden' } } })), 'recipe')
  assert.equal(invalid.metrics.requests, 1); invalid.clean()
  const twice = harness()
  await rejects(twice, () => twice.requestP1Player(videoId, twice.request(sabrPlayer()), recipe(), undefined, undefined, false, renewedRecipe()), 'format')
  assert.equal(twice.metrics.requests, 2); assert.equal(twice.metrics.workerStarts, 0); twice.clean()
})

test('the renewed response must independently satisfy exact identity, public status, DRM and locator bounds', async () => {
  for (const [input, code] of [[{ ...player(), videoDetails: { videoId: 'bbbbbbbbbbb' } }, 'response'],
    [{ ...player(), playabilityStatus: { status: 'UNPLAYABLE' } }, 'restricted'],
    [{ ...player(), streamingData: { ...player().streamingData, drmFamilies: ['WIDEVINE'] } }, 'format'],
    [player([mp4({ signatureCipher: 'bad' })]), 'format']]) {
    const h = harness(); let calls = 0
    await rejects(h, () => h.requestP1Player(videoId, async () => ++calls === 1 ? sabrPlayer() : input,
      recipe(), undefined, undefined, false, renewedRecipe()), code)
    assert.equal(calls, 2); assert.equal(h.metrics.workerStarts, 0); h.clean()
  }
})

test('decoder failures and transport failures never cause context renewal', async () => {
  const decoder = harness()
  await rejects(decoder, () => decoder.requestP1Player(videoId, decoder.request(sabrPlayer([cipherFormat()])),
    recipe({ script: 'throw Error("unusable cipher")' }), undefined, undefined, false, renewedRecipe()), 'decoder')
  assert.equal(decoder.metrics.requests, 1); decoder.clean()
  const transport = harness(), error = Error('offline'); let calls = 0
  await assert.rejects(() => transport.requestP1Player(videoId, async () => { calls++; throw error }, recipe(), undefined, undefined, false, renewedRecipe()), value => value === error)
  assert.equal(calls, 1); transport.clean()
})

test('context renewal shares the first deadline and interrupts a renewed transport that ignores abort', async () => {
  const h = harness({ fastTimeout: true }), signals = []; let calls = 0
  await rejects(h, () => h.requestP1Player(videoId, (_body, signal) => {
    calls++; signals.push(signal); return calls === 1 ? Promise.resolve(sabrPlayer()) : new Promise(() => {})
  }, recipe(), undefined, undefined, false, renewedRecipe()), 'timeout')
  assert.equal(calls, 2); assert.equal(signals[0], signals[1]); assert.equal(signals[1].aborted, true)
  assert.equal(h.metrics.scheduledMs.filter(ms => ms === 15000).length, 1); assert.equal(h.metrics.workerStarts, 0); h.clean()
})

test('caller cancellation before or during renewal cannot return late media or leave resources', async () => {
  for (const abortAt of [1, 2]) {
    const h = harness(), controller = new AbortController(); let calls = 0, lateResolve
    const pending = h.requestP1Player(videoId, (_body, signal) => {
      calls++; if (calls === abortAt) { controller.abort(); return new Promise(resolve => { lateResolve = resolve }) }
      assert.equal(signal.aborted, false); return Promise.resolve(sabrPlayer())
    }, recipe(), controller.signal, undefined, false, renewedRecipe())
    await assert.rejects(pending, { name: 'AbortError' }); assert.equal(calls, abortAt)
    lateResolve(player([cipherFormat()])); await flush()
    assert.equal(h.metrics.workerStarts, 0); h.clean()
  }
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
  for (const input of [player([]), player(Array.from({ length: 129 }, () => ({ mimeType: 'video/webm' }))),
    { ...player(), streamingData: { ...player().streamingData, licenseInfos: [] } }])
    await rejects(h, () => h.requestP1Player(videoId, h.request(input), recipe()), 'format')
  const cyclic = player(); cyclic.self = cyclic
  for (const input of [cyclic, { ...player(), padding: 'a'.repeat(4 * 1024 * 1024) }])
    await rejects(h, () => h.requestP1Player(videoId, h.request(input), recipe()), 'response')
  h.clean()
})

test('invalid locator, local DRM and incompatible AAC siblings cannot invalidate an allowed original', async () => {
  const h = harness(), original = mp4({ url: baseUrl, audioTrack: { displayName: 'Original' } })
  const rejected = [
    mp4({ url: baseUrl + '&bad=drm', drmFamilies: ['WIDEVINE'], audioTrack: { displayName: 'English dubbed' } }),
    mp4({ signatureCipher: 'not-a-cipher', isDrc: true }),
    mp4({ url: baseUrl + '&bad=codec', mimeType: 'audio/mp4; codecs="alac"' }),
    mp4({ url: 'https://outside.invalid/videoplayback', languageCode: 'es' }),
  ]
  const result = await h.requestP1Player(videoId, h.request(player([...rejected, original])), recipe())
  const values = result.streamingData.adaptiveFormats
  assert.equal(values.length, 5)
  for (let i = 0; i < rejected.length; i++) {
    const expected = { ...rejected[i] }; delete expected.url; delete expected.signatureCipher; delete expected.cipher
    assert.deepEqual(values[i], expected, 'metadata survives while every rejected locator is removed')
  }
  assert.equal(youtube.parsePlayer(result, videoId).url, baseUrl)
  assert.equal(h.metrics.workerStarts, 0); h.clean()
})

test('a transformation exception rejects one encrypted candidate without rejecting its sibling', async () => {
  const h = harness(), partial = script.replace('return new Locator(url.split', 'if (sig === "reject_this_cipher") throw Error("private provider detail"); return new Locator(url.split')
  const result = await h.requestP1Player(videoId, h.request(player([cipherFormat('reject_this_cipher'), cipherFormat('valid_cipher')])), recipe({ script: partial }))
  assert.equal(result.streamingData.adaptiveFormats[0].url, undefined)
  assert.equal(result.streamingData.adaptiveFormats[0].signatureCipher, undefined)
  assert.equal(new URL(result.streamingData.adaptiveFormats[1].url).searchParams.get('sig'), 'decoded_signature==')
  assert.equal(JSON.stringify(result).includes('private provider detail'), false)
  assert.deepEqual(h.metrics.batchSizes, [2]); h.clean()
})

test('invalid decoded output affects only its own AAC candidate', async () => {
  const h = harness(), partial = script.replace("this.values.n = 'decoded_n'", "this.values.n = this.values.n === 'reject_output' ? 'enhanced_except_bad' : 'decoded_n'")
  const result = await h.requestP1Player(videoId, h.request(player([cipherFormat('first', 'reject_output'), cipherFormat('second', 'good_output')])), recipe({ script: partial }))
  assert.equal(result.streamingData.adaptiveFormats[0].url, undefined)
  assert.equal(new URL(result.streamingData.adaptiveFormats[1].url).searchParams.get('n'), 'decoded_n')
  assert.equal(JSON.stringify(result).includes('enhanced_except_bad'), false)
  assert.equal(h.metrics.workerStarts, 1); h.clean()
})

for (const invalid of [null, { ok: false }, { ok: true }, { ok: 'true', value: {} },
  { ok: true, value: { sig: 'decoded_signature==', n: 'decoded_n' }, extra: 'untrusted' },
  { ok: true, value: { sig: 'decoded_signature==', n: 'decoded_n', url: 'https://outside.invalid/' } }]) {
  test(`malformed per-candidate worker envelope is isolated: ${JSON.stringify(invalid)}`, async () => {
    const h = harness({ workerResult: data => ({ ...data, result: [invalid, data.result[1]] }) })
    const result = await h.requestP1Player(videoId, h.request(player([cipherFormat('first'), cipherFormat('second')])), recipe())
    assert.equal(result.streamingData.adaptiveFormats[0].url, undefined)
    assert.equal(new URL(result.streamingData.adaptiveFormats[1].url).searchParams.get('n'), 'decoded_n')
    h.clean()
  })
}

test('more than four AAC rows keep metadata but only the four highest-quality allowed ciphers run', async () => {
  const h = harness(), formats = Array.from({ length: 7 }, (_, index) => ({ ...cipherFormat('cipher_' + index), bitrate: 1000 * (index + 1) }))
  const result = await h.requestP1Player(videoId, h.request(player(formats)), recipe())
  assert.equal(result.streamingData.adaptiveFormats.length, 7)
  assert.deepEqual(result.streamingData.adaptiveFormats.map(format => Boolean(format.url)), [false, false, false, true, true, true, true])
  assert.ok(result.streamingData.adaptiveFormats.every(format => !Object.hasOwn(format, 'cipher') && !Object.hasOwn(format, 'signatureCipher')))
  assert.deepEqual(h.metrics.batchSizes, [4]); h.clean()
})

test('the accept callback sees all language metadata before the four-candidate cap', async () => {
  const h = harness(), dubs = Array.from({ length: 6 }, (_, index) => mp4({ bitrate: 900000 + index,
    audioTrack: { displayName: 'Dubbed ' + index }, signatureCipher: cipherFormat('dub_' + index).signatureCipher }))
  const original = mp4({ bitrate: 128000, audioTrack: { displayName: 'Original' }, url: baseUrl })
  const opus = { mimeType: 'audio/webm', audioTrack: { displayName: 'English dubbed' }, url: 'https://outside.invalid/opus' }
  let calls = 0
  const result = await h.requestP1Player(videoId, h.request(player([...dubs, original, opus])), recipe(), undefined, (format, all) => {
    calls++; assert.equal(all.length, 8); assert.equal(all.at(-1).mimeType, 'audio/webm')
    return format.audioTrack?.displayName === 'Original'
  })
  assert.equal(calls, 7)
  assert.equal(result.streamingData.adaptiveFormats.length, 8)
  assert.deepEqual(result.streamingData.adaptiveFormats.map(format => Boolean(format.url)), [false, false, false, false, false, false, true, false])
  assert.equal(youtube.parsePlayer(result, videoId).url, baseUrl)
  assert.equal(h.metrics.workerStarts, 0); h.clean()
})

test('discarded AAC language metadata cannot promote an untagged sibling to original', async () => {
  const h = harness(), input = player([mp4({ url: baseUrl }), mp4({ signatureCipher: 'invalid', audioTrack: { displayName: 'English dubbed', audioIsDefault: true } })])
  const result = await h.requestP1Player(videoId, h.request(input), recipe())
  assert.equal(result.streamingData.adaptiveFormats[1].audioTrack.displayName, 'English dubbed')
  assert.equal(result.streamingData.adaptiveFormats[1].signatureCipher, undefined)
  assert.throws(() => youtube.parsePlayer(result, videoId), { code: 'format' }); h.clean()
})

test('all malformed locators or all failed outputs reject without leaking rejected URLs', async () => {
  const invalid = harness()
  await rejects(invalid, () => invalid.requestP1Player(videoId, invalid.request(player([mp4({ signatureCipher: 'bad' }), mp4({ url: 'https://outside.invalid/' })])), recipe()), 'format')
  assert.equal(invalid.metrics.workerStarts, 0); invalid.clean()
  const failed = harness()
  await rejects(failed, () => failed.requestP1Player(videoId, failed.request(player([cipherFormat('first'), cipherFormat('second')])), recipe({ script: 'throw Error("private cipher details")' })), 'decoder')
  assert.deepEqual(failed.metrics.batchSizes, [2]); failed.clean()
})

test('a malformed batch envelope stays a global decoder failure', async () => {
  const h = harness({ workerResult: () => ({ result: [] }) })
  await rejects(h, () => h.requestP1Player(videoId, h.request(player([cipherFormat(), cipherFormat()])), recipe()), 'decoder'); h.clean()
})

test('the caller can reject every AAC without starting a decoder', async () => {
  const h = harness()
  await rejects(h, () => h.requestP1Player(videoId, h.request(player([cipherFormat(), mp4({ url: baseUrl })])), recipe(), undefined, () => false), 'format')
  assert.equal(h.metrics.workerStarts, 0); h.clean()
})

test('aborting a mixed direct/encrypted batch never returns the direct sibling after cancellation', async () => {
  const h = harness({ holdWorker: true }), controller = new AbortController()
  const pending = h.requestP1Player(videoId, h.request(player([mp4({ url: baseUrl }), cipherFormat('pending')])), recipe(), controller.signal)
  await flush(); assert.deepEqual(h.metrics.batchSizes, [1])
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(h.metrics.revoked, 1); h.clean()
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
