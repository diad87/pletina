import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

const auditCode = readFileSync(new URL('../src-tauri/src/capture-audit.js', import.meta.url), 'utf8')
const coreCode = readFileSync(new URL('../src-tauri/src/capture-core.js', import.meta.url), 'utf8')
function setup(enabled = true) {
  const messages = [], intervals = [], elements = [], listeners = new Map(), clearedIntervals = []
  let clock = 0
  class SB extends EventTarget {
    constructor() { super(); this.timestampOffset = 0; this.appendWindowStart = 0; this.appendWindowEnd = Infinity; this.mode = 'segments'; this.updating = false; this.buffered = { length: 0 } }
    appendBuffer() { if (this.throwAppend) throw new Error('native-append-failed') }
    abort() { if (this.throwAbort) throw new Error('native-abort-failed') }
    remove() {}
    changeType() {}
  }
  class MS { constructor() { this.readyState = 'open' }; addSourceBuffer() { return new SB() }; endOfStream() { this.readyState = 'ended' } }
  class Media {
    constructor() {
      this.currentTime = 0; this.duration = 3; this.paused = false; this.ended = false; this.seeking = false
      this._rate = 1; this._defaultRate = 1; this._muted = false; this.readyState = 4; this.src = ''; this.srcObject = null
      this.nativeCalls = []; this.playResult = Promise.resolve(); this.pauseResult = undefined
    }
    get playbackRate() { if (!(this instanceof Media)) throw new TypeError('Illegal native receiver'); return this._rate }
    set playbackRate(value) { if (!(this instanceof Media)) throw new TypeError('Illegal native receiver'); this.nativeCalls.push(['playbackRate', value]); this._rate = +value }
    get defaultPlaybackRate() { if (!(this instanceof Media)) throw new TypeError('Illegal native receiver'); return this._defaultRate }
    set defaultPlaybackRate(value) { if (!(this instanceof Media)) throw new TypeError('Illegal native receiver'); this.nativeCalls.push(['defaultPlaybackRate', value]); this._defaultRate = +value }
    get muted() { if (!(this instanceof Media)) throw new TypeError('Illegal native receiver'); return this._muted }
    set muted(value) { if (!(this instanceof Media)) throw new TypeError('Illegal native receiver'); this.nativeCalls.push(['muted', value]); this._muted = !!value }
    pause(...args) { if (!(this instanceof Media)) throw new TypeError('Illegal native receiver'); this.nativeCalls.push(['pause', ...args]); if (this.pauseError) throw this.pauseError; this.paused = true; return this.pauseResult }
    play(...args) { if (!(this instanceof Media)) throw new TypeError('Illegal native receiver'); this.nativeCalls.push(['play', ...args]); if (this.playError) throw this.playError; this.paused = false; return this.playResult }
  }
  const originals = Object.fromEntries(['pause', 'play', 'playbackRate', 'defaultPlaybackRate', 'muted'].map(name => [name, Object.getOwnPropertyDescriptor(Media.prototype, name)]))
  let urls = 0
  const context = vm.createContext({ Uint8Array, ArrayBuffer, __musifyBenchmarkAudit: enabled, __musifyTarget: 'jNY_wLukVW0', __musifyGeneration: 12, __musifyEpoch: 1,
    SourceBuffer: SB, MediaSource: MS, HTMLMediaElement: Media, URL: { createObjectURL: () => `blob:private-${++urls}` },
    chrome: { webview: { postMessage: value => messages.push(JSON.parse(value.slice('musify-audit:'.length))) } },
    document: { querySelectorAll: () => elements, visibilityState: 'hidden', hasFocus: () => false }, performance: { now: () => clock }, crypto: { randomUUID: () => 'fixture-document' },
    setInterval: fn => { intervals.push(fn); return intervals.length }, clearInterval(id) { clearedIntervals.push(id) },
    addEventListener(type, fn) { const list = listeners.get(type) ?? []; list.push(fn); listeners.set(type, list) },
    removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) ?? []).filter(value => value !== fn)) },
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    __musifyCaptureYouTube: { create: () => ({ classify: () => ({ state: 'ad', evidence: { adMarker: true }, reason: 'https://private.invalid/never-store', title: 'Never store' }) }) },
  })
  vm.runInContext(auditCode, context); vm.runInContext(coreCode, context)
  const tracker = new context.__musifyCaptureCore.SessionTracker(); tracker.epoch = 1
  const capture = context.__musifyCaptureCore.install({ scope: context, tracker })
  const native = new MS(), sb = native.addSourceBuffer('audio/webm; codecs="opus"'), media = new Media()
  media.src = context.URL.createObjectURL(native); elements.push(media)
  return { context, tracker, capture, native, sb, media, messages, intervals, clearedIntervals, listeners, originals, time(value) { clock = value }, event(type) { for (const listener of listeners.get(type) ?? []) listener({ target: media }) } }
}

test('private audit is absent unless explicitly enabled and never changes native append semantics', () => {
  const f = setup(false)
  f.sb.appendBuffer(Uint8Array.of(1, 2, 3))
  assert.equal(f.messages.length, 0); assert.equal(f.intervals.length, 0)
  assert.equal(f.tracker.bytes, 3)
  f.sb.throwAppend = true
  assert.throws(() => f.sb.appendBuffer(Uint8Array.of(4)), /native-append-failed/)
  assert.equal(f.tracker.bytes, 3)
})

test('audit independently copies ad and unknown audio before the gate discards it', () => {
  for (const state of ['ad', 'unknown']) {
    const f = setup(), source = f.capture.sourceOf(f.media), input = Uint8Array.of(7, 8, 9)
    if (state === 'ad') f.tracker.observe(source, { state: 'ad', sourceBound: true }, { position: 0, now: 0, duration: 3 })
    f.sb.appendBuffer(input); input.fill(0)
    const record = f.messages.find(m => m.kind === 'append')
    assert.ok(record); assert.deepEqual([...Buffer.from(record.data, 'base64')], [7, 8, 9])
    assert.equal(record.source, source.id); assert.equal(record.s, source.buffers[0].id)
    assert.equal(record.timelineSettings.appendWindowEnd, null)
    if (state === 'ad') assert.equal(f.tracker.bytes, 0, 'independent recording must not put ad bytes in the gate')
    else assert.equal(f.tracker.bytes, 3)
  }
})

test('audit partitions whole native appends into ordered bounded parts without losing DataView offsets', () => {
  const f = setup(), bytes = Uint8Array.from({ length: 300000 }, (_, i) => i % 251)
  const view = new DataView(bytes.buffer, 11, 299000)
  f.sb.appendBuffer(view)
  const parts = f.messages.filter(m => m.kind === 'append')
  assert.equal(parts.length, 3)
  assert.deepEqual(parts.map(m => m.part), [0, 1, 2])
  assert.ok(parts.every(m => m.parts === 3 && m.totalBytes === view.byteLength && m.appendId === parts[0].appendId))
  const restored = Buffer.concat(parts.map(m => Buffer.from(m.data, 'base64')))
  assert.deepEqual(restored, Buffer.from(bytes.subarray(11, 299011)))
  assert.ok(parts.every(m => Buffer.from(m.data, 'base64').length <= 128 * 1024))
  assert.deepEqual(f.messages.map(m => m.sequence), f.messages.map((_, i) => i + 1))
  f.tracker.epoch = 2; f.sb.appendBuffer(Uint8Array.of(5)); assert.equal(f.messages.at(-1).epoch, 2)
})

test('failed native operations are absent while successful parser mutations and all native clocks are recorded', () => {
  const f = setup(); f.sb.throwAppend = true
  assert.throws(() => f.sb.appendBuffer(Uint8Array.of(1)), /native-append-failed/)
  assert.equal(f.messages.some(m => m.kind === 'append'), false)
  f.sb.throwAbort = true; assert.throws(() => f.sb.abort(), /native-abort-failed/)
  assert.equal(f.messages.some(m => m.kind === 'mutation'), false)
  f.sb.throwAbort = false; f.sb.abort(); f.sb.remove(0, 1); f.native.endOfStream()
  assert.deepEqual(f.messages.filter(m => m.kind === 'mutation').map(m => m.operation), ['abort', 'remove', 'endOfStream'])
  f.time(100); f.media.currentTime = 0.1; f.intervals[0]()
  f.time(120); f.event('ended'); f.event('pagehide')
  const clocks = f.messages.filter(m => m.kind === 'clock')
  assert.equal(clocks.length, 3); assert.equal(clocks[0].siteState, 'ad'); assert.equal(clocks[0].adMarker, true)
  assert.equal(clocks[0].position, 0.1); assert.equal(clocks[0].playbackRate, 1)
  assert.equal(JSON.stringify(f.messages).includes('https://'), false); assert.equal(JSON.stringify(f.messages).includes('blob:'), false)
  assert.equal(JSON.stringify(f.messages).includes('Never store'), false)
  assert.equal(f.messages.at(-1).reason, 'audit-pagehide')
  assert.equal(f.messages.at(-1).statistics.parts, 0); assert.equal(f.messages.at(-1).statistics.clocks, 3)
})

test('a transport or copy failure is diagnostic and cannot make official playback throw', () => {
  const f = setup(); f.context.chrome.webview.postMessage = () => { throw new Error('transport unavailable') }
  assert.doesNotThrow(() => f.sb.appendBuffer(Uint8Array.of(1, 2)))
  assert.equal(f.tracker.bytes, 2)
  assert.doesNotThrow(() => f.intervals[0]())
})

test('explicit native finalization freezes all producers and accounts for the final clock without pagehide', () => {
  const f = setup(); f.sb.appendBuffer(Uint8Array.of(1, 2, 3)); f.time(50); f.media.currentTime = 0.05
  const finalize = f.context.__musifyCaptureAudit.finalize
  assert.equal(finalize({ generation: 11, requestId: 'close-12-1' }), false, 'another generation cannot freeze this recorder')
  assert.equal(finalize({ generation: 12, requestId: 'close-12-1' }), true)
  const marker = f.messages.at(-1), count = f.messages.length
  assert.equal(marker.reason, 'audit-finalized'); assert.equal(marker.requestId, 'close-12-1')
  assert.deepEqual({ ...marker.statistics }, { appends: 1, parts: 1, bytes: 3, clocks: 1, dropped: 0, errors: 0 })
  assert.equal(f.messages.at(-2).phase, 'finalize'); assert.equal(f.messages.at(-2).position, 0.05)
  assert.deepEqual(f.clearedIntervals, [1]); assert([...f.listeners.values()].every(values => values.length === 0))
  f.sb.appendBuffer(Uint8Array.of(4)); f.sb.abort(); f.intervals[0](); f.event('ended'); f.event('pagehide')
  assert.equal(finalize({ generation: 12, requestId: 'close-12-1' }), false)
  assert.equal(f.messages.length, count, 'no late producer can appear after the final counters')
  assert.equal(f.tracker.bytes, 4, 'freezing the independent recorder does not mutate the capture parser')
})

test('losing the explicit final marker cannot produce a substitute final heartbeat or pagehide', () => {
  const f = setup(); f.sb.appendBuffer(Uint8Array.of(1))
  const post = f.context.chrome.webview.postMessage
  f.context.chrome.webview.postMessage = text => {
    if (JSON.parse(text.slice('musify-audit:'.length)).reason === 'audit-finalized') throw new Error('lost final')
    post(text)
  }
  assert.equal(f.context.__musifyCaptureAudit.finalize({ generation: 12, requestId: 'close-12-2' }), false)
  f.intervals[0](); f.event('pagehide')
  assert.equal(f.messages.some(message => ['audit-finalized', 'audit-pagehide'].includes(message.reason)), false)
})

const playback = f => f.messages.filter(message => message.reason === 'audit-playback-control')

test('playback instrumentation is absent outside the private benchmark and capture control still calls once', () => {
  const f = setup(false), prototype = f.context.HTMLMediaElement.prototype
  for (const [name, descriptor] of Object.entries(f.originals)) assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, name), descriptor)
  const sentinel = {}
  assert.equal(f.capture.control('resume', () => sentinel), sentinel)
  f.capture.control('finished', () => f.media.pause())
  assert.deepEqual(f.media.nativeCalls, [['pause']]); assert.equal(f.messages.length, 0)
})

test('play and pause preserve receiver, arguments, returned promise and synchronous exception identities', async () => {
  const f = setup(), rejected = new Error('native rejection'), syncError = new Error('native pause error')
  f.media.playResult = Promise.reject(rejected)
  const result = f.media.play('native-argument')
  assert.equal(result, f.media.playResult)
  await assert.rejects(result, error => error === rejected)
  assert.deepEqual(f.media.nativeCalls[0], ['play', 'native-argument'])
  f.media.pauseError = syncError
  assert.throws(() => f.media.pause(), error => error === syncError)
  assert.throws(() => f.media.play.call({}), /Illegal native receiver/)
  assert.equal(playback(f).at(-1).playback.counts.throws, 2)
  assert.equal(playback(f).at(-2).playback.control.threw, true)
  let thenReads = 0
  const promiseLike = Object.defineProperty({}, 'then', { get() { thenReads++; throw new Error('must not assimilate') } })
  f.media.playResult = promiseLike
  assert.equal(f.media.play(), promiseLike); assert.equal(thenReads, 0)
})

test('capture origin is scoped synchronously and external pause remains external after a promise or throw', () => {
  const f = setup()
  assert.equal(f.capture.control('resume', () => f.media.play()), f.media.playResult)
  f.media.pause()
  const error = new Error('control failed')
  assert.throws(() => f.capture.control('startup-replay', () => { throw error }), e => e === error)
  f.media.play()
  const samples = playback(f).map(message => message.playback.control)
  assert.deepEqual(samples.map(s => [s.origin, s.reason]), [['capture', 'resume'], ['external', undefined], ['external', undefined]])
  assert.equal(samples[0].before.visibility, 'hidden'); assert.equal(samples[0].before.focused, false)
  assert.equal(samples[1].after.paused, true)
})

test('property diagnostics do not coerce input twice and count redundant writes against each native getter', () => {
  const f = setup(); let conversions = 0
  const value = { valueOf() { conversions++; return 2 } }
  f.media.playbackRate = value
  assert.equal(conversions, 1); assert.equal(f.media.playbackRate, 2)
  f.media.defaultPlaybackRate = 1
  f.media.playbackRate = 2
  f.media.muted = true; f.media.muted = true
  f.time(1000); f.intervals[0]()
  const summary = playback(f).at(-1).playback
  assert.equal(summary.phase, 'summary'); assert.equal(summary.counts.rateWrites, 3)
  assert.equal(summary.counts.rateRedundant, 2, 'default rate compares its own value, not current playback rate')
  assert.equal(summary.counts.mutedWrites, 2); assert.equal(summary.counts.mutedRedundant, 1)
  assert.equal(playback(f)[0].playback.control.requested, undefined)
  assert.equal(JSON.stringify(playback(f)).includes('valueOf'), false)
})

test('twenty bounded samples preserve pause callers after repeated muted writes; summaries are at most one per second', () => {
  const f = setup()
  f.context.Error = class {
    constructor() { this.stack = 'Error: secret-account@example.invalid\n    at safeStack (https://private.invalid/token?q=secret:1:2)\n    at auditedPlayback (https://private.invalid/token:3:4)\n    at yt.playerPause (https://signed.invalid/file?token=secret:5:6)\n    at mediaController (C:/private/profile/account.js:8:9)\n    at eval (eval at hidden (https://private.invalid/never:1:2))\n    at https://private.invalid/secret\n    at ' + 'x'.repeat(200) + ' (https://private.invalid)\n' }
  }
  for (let i = 0; i < 500; i++) { f.media.muted = true; f.media.playbackRate = 1 }
  for (let i = 0; i < 500; i++) { f.media.pause(); f.capture.control('resume', () => f.media.play()) }
  const samples = playback(f).filter(m => m.playback.phase === 'sample')
  assert.equal(samples.length, 20)
  assert.equal(samples.filter(m => m.playback.control.method === 'pause').length, 8)
  assert.equal(samples.find(m => m.playback.control.method === 'pause').playback.control.origin, 'external')
  assert.deepEqual([...samples[0].playback.control.stack], ['yt.playerPause', 'mediaController', 'eval'])
  assert.ok(samples.every(m => JSON.stringify(m).length < 1800))
  const text = JSON.stringify(playback(f))
  for (const secret of ['https:', 'C:/', 'secret', '@', 'account.js']) assert.equal(text.includes(secret), false)
  f.time(999); f.intervals[0](); assert.equal(playback(f).filter(m => m.playback.phase === 'summary').length, 0)
  f.time(1000); f.intervals[0](); f.time(1100); f.media.pause(); f.intervals[0]()
  assert.equal(playback(f).filter(m => m.playback.phase === 'summary').length, 1)
  const counts = playback(f).find(m => m.playback.phase === 'summary').playback.counts
  assert.equal(counts.pause, 500); assert.equal(counts.play, 500)
  assert.equal(counts.rateWrites, 500); assert.equal(counts.mutedWrites, 500)
  assert.equal(counts.captureCalls, 500); assert.equal(counts.externalCalls, 1500)
  f.context.__musifyCaptureAudit.finalize({ generation: 12, requestId: 'close-controls' })
  assert.equal(playback(f).at(-1).playback.counts.pause, 501, 'final flush keeps the last subsecond call')
  const length = f.messages.length
  f.media.play(); f.media.muted = false; f.intervals[0]()
  assert.equal(f.messages.length, length, 'frozen recorder remains transparent without late records')
})

test('playback metadata and transport failures never replace a native result or rejection', () => {
  const f = setup(), sentinel = {}, error = new Error('native only')
  f.media.pauseResult = sentinel
  f.context.document.hasFocus = () => { throw new Error('metadata failed') }
  f.context.chrome.webview.postMessage = () => { throw new Error('transport failed') }
  assert.equal(f.media.pause(), sentinel)
  f.media.playError = error
  assert.throws(() => f.media.play(), e => e === error)
})

test('caller evidence retains at most twelve safe names and restores the native V8 stack limit', () => {
  const f = setup()
  f.context.media = f.media
  vm.runInContext(`
    globalThis.originalLimit = Object.getOwnPropertyDescriptor(Error, 'stackTraceLimit');
    Error.stackTraceLimit = 4;
    globalThis.beforeLimit = Object.getOwnPropertyDescriptor(Error, 'stackTraceLimit');
    function actor0() { media.pause() }
    ${Array.from({ length: 15 }, (_, i) => `function actor${i + 1}() { actor${i}() }`).join('\n')}
    actor15();
    globalThis.afterLimit = Object.getOwnPropertyDescriptor(Error, 'stackTraceLimit');
  `, f.context)
  const sample = playback(f)[0].playback.control
  assert.equal(sample.stack.length, 12)
  assert.deepEqual([...sample.stack], Array.from({ length: 12 }, (_, i) => `actor${i}`))
  assert.deepEqual(f.context.afterLimit, f.context.beforeLimit)
  assert.equal(f.media.nativeCalls.filter(call => call[0] === 'pause').length, 1)
  assert.ok(JSON.stringify(playback(f)[0]).length < 2400)
})

test('failure while capturing a diagnostic stack restores its limit and still calls native pause', () => {
  const f = setup()
  f.context.Error = class { constructor() { throw new Error('diagnostic constructor failure') } }
  Object.defineProperty(f.context.Error, 'stackTraceLimit', { value: 4, writable: true, enumerable: false, configurable: true })
  const original = Object.getOwnPropertyDescriptor(f.context.Error, 'stackTraceLimit')
  f.media.pause()
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.context.Error, 'stackTraceLimit'), original)
  assert.equal(f.media.nativeCalls.filter(call => call[0] === 'pause').length, 1)
  assert.deepEqual([...playback(f)[0].playback.control.stack], [])
})
