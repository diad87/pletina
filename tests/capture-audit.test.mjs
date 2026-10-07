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
  class Media { constructor() { this.currentTime = 0; this.duration = 3; this.paused = false; this.ended = false; this.seeking = false; this.playbackRate = 1; this.readyState = 4; this.src = ''; this.srcObject = null } }
  let urls = 0
  const context = vm.createContext({ Uint8Array, ArrayBuffer, __musifyBenchmarkAudit: enabled, __musifyTarget: 'jNY_wLukVW0', __musifyGeneration: 12, __musifyEpoch: 1,
    SourceBuffer: SB, MediaSource: MS, HTMLMediaElement: Media, URL: { createObjectURL: () => `blob:private-${++urls}` },
    chrome: { webview: { postMessage: value => messages.push(JSON.parse(value.slice('musify-audit:'.length))) } },
    document: { querySelectorAll: () => elements }, performance: { now: () => clock }, crypto: { randomUUID: () => 'fixture-document' },
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
  return { context, tracker, capture, native, sb, media, messages, intervals, clearedIntervals, listeners, time(value) { clock = value }, event(type) { for (const listener of listeners.get(type) ?? []) listener({ target: media }) } }
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
