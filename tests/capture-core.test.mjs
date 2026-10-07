import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

const coreCode = readFileSync(new URL('../src-tauri/src/capture-core.js', import.meta.url), 'utf8')
const mp4Code = readFileSync(new URL('../src-tauri/src/capture-mp4.js', import.meta.url), 'utf8')
const adapterCode = readFileSync(new URL('../src-tauri/src/capture-youtube.js', import.meta.url), 'utf8')
const orchestratorCode = readFileSync(new URL('../src-tauri/src/capture.js', import.meta.url), 'utf8')
function load(extra = {}) {
  const context = vm.createContext({ Uint8Array, ArrayBuffer, URLSearchParams, ...extra })
  vm.runInContext(mp4Code, context)
  vm.runInContext(coreCode, context)
  vm.runInContext(adapterCode, context)
  return { context, ...context.__musifyCaptureCore }
}
const concat = (...arrays) => Uint8Array.from(arrays.flatMap((a) => [...a]))
const id = (number) => Uint8Array.from(Buffer.from(number.toString(16).padStart(number.toString(16).length + number.toString(16).length % 2, '0'), 'hex'))
function size(number) {
  for (let width = 1; width <= 4; width++) {
    if (number < 2 ** (7 * width) - 1) {
      const out = new Uint8Array(width)
      let value = number
      for (let i = width - 1; i >= 0; i--) { out[i] = value & 255; value = Math.floor(value / 256) }
      out[0] |= 1 << (8 - width)
      return out
    }
  }
  throw new Error('fixture too large')
}
const element = (number, bytes) => concat(id(number), size(bytes.length), bytes)
const integer = (value) => value <= 255 ? [value] : [value >> 8, value & 255]
function fixture({ times = [0, 20, 40], type = 2, codec = 'A_OPUS', lacing = 0, unknownCluster = false } = {}) {
  // Every packet is one 20 ms Opus frame. Packet payload values distinguish our synthetic
  // sources; timeline tests do not claim to replace an audio decoder or a real YouTube trial.
  const entry = element(0xae, concat(element(0xd7, [1]), element(0x83, [type]), element(0x86, Buffer.from(codec))))
  const tracks = element(0x1654ae6b, entry)
  const blocks = times.map((time, i) => element(0xa3, [0x81, time >> 8, time & 255, 0x80 | lacing, 0x98, i + 1]))
  const body = concat(element(0xe7, [0]), ...blocks)
  const cluster = unknownCluster ? concat(id(0x1f43b675), [0xff], body) : element(0x1f43b675, body)
  const init = concat(element(0x1a45dfa3, []), id(0x18538067), [0xff], element(0x1549a966, []), tracks)
  return { init, cluster, bytes: concat(init, cluster), duration: (times.at(-1) + 20) / 1000 }
}
const content = { state: 'content', sourceBound: true, signals: ['presented-video-id', 'matching-visible-title'] }
const ad = { state: 'ad', sourceBound: true, signals: ['ad-marker'] }
function present(tracker, source, duration = 0.06) {
  tracker.observe(source, content, { position: 0, now: 0, duration })
  tracker.observe(source, content, { position: duration, now: duration * 1000, duration, ended: true })
}
function setup() {
  const { SessionTracker } = load()
  const tracker = new SessionTracker()
  const source = tracker.createSource()
  const buffer = tracker.createBuffer(source, 'audio/webm; codecs="opus"')
  return { tracker, source, buffer }
}
const codeIs = (expected) => (error) => error.code === expected

test('complete consistently presented content preserves its original initialization and media appends', () => {
  const { tracker, source, buffer } = setup()
  const f = fixture()
  tracker.append(buffer, f.init)
  tracker.append(buffer, f.cluster)
  assert.equal(source.state, 'unknown')
  present(tracker, source)
  const confirmed = tracker.seal(source)
  assert.deepEqual(confirmed.chunks[0], f.init)
  assert.deepEqual(confirmed.chunks[1], f.cluster)
  assert.equal(confirmed.timeline.frames.length, 3)
  assert.equal(confirmed.timeline.end, 0.06)
})

test('song prefetched during an ad belongs to its own source, not the currently playing identity', () => {
  const { tracker, source: advert, buffer: advertBuffer } = setup()
  const song = tracker.createSource(), songBuffer = tracker.createBuffer(song, 'audio/webm; codecs="opus"')
  const f = fixture()
  tracker.append(advertBuffer, f.bytes)
  tracker.observe(advert, ad, { position: 0, now: 0, duration: 0.06 })
  tracker.append(songBuffer, f.init)
  tracker.append(songBuffer, f.cluster)
  assert.equal(song.state, 'unknown')
  assert.equal(songBuffer.chunks.length, 2)
  assert.equal(advertBuffer.chunks.length, 0)
  present(tracker, song)
  assert.deepEqual(tracker.seal(song).chunks[0], f.init)
  assert.throws(() => tracker.seal(advert), codeIs('CAPTURE_IDENTITY_UNCERTAIN'))
})

test('unknown source never becomes content merely because bytes were appended', () => {
  const { tracker, source, buffer } = setup()
  tracker.append(buffer, fixture().bytes)
  assert.equal(source.state, 'unknown')
  assert.throws(() => tracker.seal(source), codeIs('CAPTURE_IDENTITY_UNCERTAIN'))
})

test('observed unknown identity cannot later be relabeled by a known title', () => {
  const { tracker, source, buffer } = setup()
  tracker.append(buffer, fixture().bytes)
  tracker.observe(source, { state: 'unknown', sourceBound: true }, { position: 0, now: 0, duration: 0.06 })
  present(tracker, source)
  assert.throws(() => tracker.seal(source), codeIs('CAPTURE_IDENTITY_UNCERTAIN'))
})

test('one ID signal is insufficient evidence even when supplied as content', () => {
  const { tracker, source } = setup()
  tracker.observe(source, { state: 'content', sourceBound: true, signals: ['video-id'] }, { position: 0, now: 0, duration: 1 })
  assert.equal(source.state, 'ambiguous')
})

test('ad and song reuse of one source is rejected in either order before any release', () => {
  for (const identities of [[ad, content], [content, ad]]) {
    const { tracker, source, buffer } = setup()
    tracker.append(buffer, fixture().bytes)
    identities.forEach((identity, index) => tracker.observe(source, identity, { position: index * 0.02, now: index * 20, duration: 0.06 }))
    assert.throws(() => tracker.seal(source), codeIs('CAPTURE_IDENTITY_UNCERTAIN'))
  }
})

test('timestamps reveal overwritten frames hidden by a single buffered range', () => {
  const { parseWebMOpus } = load()
  for (const times of [[0, 0, 20], [0, 10, 30], [0, 40]]) {
    assert.throws(() => parseWebMOpus(fixture({ times }).bytes), codeIs('CAPTURE_AMBIGUOUS_TIMELINE'))
  }
})

test('unpresented prefetched tail is rejected, even with content identity throughout playback', () => {
  for (const times of [[0, 20, 40, 60], [0, 20, 40, 60, 80]]) {
    const { tracker, source, buffer } = setup()
    tracker.append(buffer, fixture({ times }).bytes)
    present(tracker, source, 0.06)
    assert.throws(() => tracker.seal(source), codeIs('CAPTURE_UNPRESENTED_BYTES'))
  }
})

test('repeated initialization, muxed tracks, lacing and truncated data fail explicitly', () => {
  const { parseWebMOpus } = load()
  const f = fixture()
  for (const bytes of [concat(f.bytes, f.bytes), fixture({ type: 1 }).bytes, fixture({ lacing: 2 }).bytes, f.bytes.subarray(0, f.bytes.length - 1)]) {
    assert.throws(() => parseWebMOpus(bytes), codeIs('CAPTURE_UNSUPPORTED_WEBM'))
  }
})

test('unknown-size clusters are bounded by EBML level-one elements', () => {
  const { parseWebMOpus } = load()
  assert.equal(parseWebMOpus(fixture({ unknownCluster: true }).bytes).end, 0.06)
})

test('MSE Segment size is an initialization header; absent file tail is allowed but truncated children are not', () => {
  const { parseWebMOpus } = load(), f = fixture()
  const header = element(0x1a45dfa3, [])
  const contents = f.bytes.subarray(header.length + id(0x18538067).length + 1)
  for (const declared of [contents.length + 4096, f.init.length - header.length - id(0x18538067).length - 1]) {
    const mse = concat(header, id(0x18538067), size(declared), contents)
    assert.equal(parseWebMOpus(mse).end, 0.06)
    assert.throws(() => parseWebMOpus(mse.subarray(0, mse.length - 1)), (e) => e.code === 'CAPTURE_UNSUPPORTED_WEBM' && /id=0x1f43b675 offset=\d+ expectedEnd=\d+ parentEnd=\d+ actualLength=\d+/.test(e.message))
  }
  assert.throws(() => parseWebMOpus(concat(header, id(0x18538067), size(1), contents)), codeIs('CAPTURE_UNSUPPORTED_WEBM'))
})

test('the complete-source gate routes AAC-LC to the verified MP4 parser without changing bytes', () => {
  // Same FFmpeg-generated silence fixture as the independent MP4 parser suite.
  const bytes = Uint8Array.from(Buffer.from('AAAAHGZ0eXBpc281AAACAGlzbzVpc282bXA0MQAAAphtb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAAAAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAABv3RyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAVttZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAALuAAAAAAFXEAAAAAAAtaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAFNvdW5kSGFuZGxlcgAAAAEGbWluZgAAABBzbWhkAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAADKc3RibAAAAH5zdHNkAAAAAAAAAAEAAABubXA0YQAAAAAAAAABAAAAAAAAAAAAAgAQAAAAALuAAAAAAAA2ZXNkcwAAAAADgICAJQABAASAgIAXQBUAAAAAAPoAAAD6AAWAgIAFEZBW5QAGgICAAQIAAAAUYnRydAAAAAAAAPoAAAD6AAAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAAAAAAKG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAAAAAD11ZHRhAAAANW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAACGlsc3QAAABkbW9vZgAAABBtZmhkAAAAAAAAAAEAAABMdHJhZgAAABx0ZmhkAAIAOAAAAAEAAAQAAAAABgIAAAAAAAAUdGZkdAEAAAAAAAAAAAAAAAAAABR0cnVuAAAAAQAAAAMAAABsAAAAGm1kYXQhEARgjBwhEARgjBwhEARgjBwAAABkbW9vZgAAABBtZmhkAAAAAAAAAAIAAABMdHJhZgAAABx0ZmhkAAIAOAAAAAEAAAQAAAAABgIAAAAAAAAUdGZkdAEAAAAAAAAAAAAMAAAAABR0cnVuAAAAAQAAAAEAAABsAAAADm1kYXQhEARgjBwAAABWbWZyYQAAAD50ZnJhAQAAAAAAAAEAAAAAAAAAAgAAAAAAAAAAAAAAAAAAArQBAQEAAAAAAAAMAAAAAAAAAAMyAQEBAAAAEG1mcm8AAAAAAAAAVg==', 'base64'))
  for (const tuple of [{ timestampOffset: 0, appendWindowEnd: Infinity }, { timestampOffset: -1024 / 48000, appendWindowEnd: 3072 / 48000 }]) {
    const { SessionTracker } = load(), tracker = new SessionTracker(), source = tracker.createSource()
    const buffer = tracker.createBuffer(source, 'audio/mp4; codecs="mp4a.40.2"')
    tracker.append(buffer, bytes.subarray(0, 128), tuple)
    tracker.append(buffer, bytes.subarray(128), tuple)
    const duration = tuple.timestampOffset ? 3072 / 48000 : 4096 / 48000
    present(tracker, source, duration)
    const confirmed = tracker.seal(source, { source, ended: true, position: duration, seeking: false, playbackRate: 1, readyState: 4, updating: false, audioRanges: [{ start: 0, end: duration }] })
    assert.equal(confirmed.timeline.codec, 'mp4a.40.2')
    assert.equal(confirmed.timeline.frames.length, tuple.timestampOffset ? 3 : 4)
    assert.deepEqual(concat(...confirmed.chunks), bytes)
    assert.equal(confirmed.timelineSettings.timestampOffset, tuple.timestampOffset)
  }
})

test('actual FFmpeg WebM/Opus headers, codec delay and discard padding agree with its 200ms signal', () => {
  // Generated locally from silence with FFmpeg 8.1/libopus. Kept inline so the test does not
  // require FFmpeg, network access or a user's media library. Includes real initialization.
  const bytes = Uint8Array.from(Buffer.from('GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZwH/////////EU2bdKtNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggFC7AEAAAAAAABoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjIuMTIuMTAwV0GNTGF2ZjYyLjEyLjEwMESJiEBpAAAAAAAAFlSua+WuAQAAAAAAAFzXgQFzxYgeB9V1Yr4s+JyBACK1nIN1bmSIgQCGhkFfT1BVU1aqg2MuoFa7hATEtACDgQLhkZ+BAbWIQOdwAAAAAABiZIEQY6KTT3B1c0hlYWQBATgBgLsAAAAAABJUw2fZc3OgY8CAZ8iaRaOHRU5DT0RFUkSHjUxhdmY2Mi4xMi4xMDBzc7NjwItjxYgeB9V1Yr4s+GfIokWjh0VOQ09ERVJEh5VMYXZjNjIuMjguMTAwIGxpYm9wdXMfQ7Z18ueBAKOHgQAAgPj//qOHgQAVgPj//qOHgQApgPj//qOHgQA9gPj//qOHgQBRgPj//qOHgQBlgPj//qOHgQB5gPj//qOHgQCNgPj//qOHgQChgPj//qOHgQC1gPj//qCToYeBAMkA+P/+m4EHdaKEAM3+YA==', 'base64'))
  const { parseWebMOpus } = load()
  const parsed = parseWebMOpus(bytes)
  assert.equal(parsed.frames.length, 11)
  assert.equal(parsed.start, 0)
  assert.ok(Math.abs(parsed.end - 0.2) <= parsed.quantum + 1e-9)
  assert.equal(parsed.codec, 'A_OPUS')
  assert.ok(Math.abs(parsed.codedEnd - 0.221) < 1e-12)
  assert.equal(parsed.lastBlock.codecDelay, 0.0065)
  assert.equal(parsed.lastBlock.discardPadding, 0.0135)
  for (const clock of [0.201, 0.221]) {
    const { tracker, source, buffer } = setup()
    tracker.append(buffer, bytes)
    tracker.observe(source, content, { position: 0, now: 0, duration: 0.221 })
    tracker.observe(source, content, { position: clock, now: clock * 1000, duration: 0.221 })
    const terminal = { source, sourceEnded: true, position: clock, seeking: false, playbackRate: 1, readyState: 4, updating: false, audioRanges: [{ start: 0, end: 0.221 }] }
    if (clock < 0.221) assert.throws(() => tracker.seal(source, terminal), codeIs('CAPTURE_PARTIAL_PRESENTATION'))
    else { const confirmed = tracker.seal(source, terminal); assert.ok(Math.abs(confirmed.timeline.end - 0.221) < 1e-12); assert.deepEqual(concat(...confirmed.chunks), bytes) }
  }
})

test('timeline modifications, incomplete seeks and memory overflow never release segments', () => {
  {
    const { SessionTracker } = load(), tracker = new SessionTracker(), source = tracker.createSource(), buffer = tracker.createBuffer(source, 'audio/mp4; codecs="mp4a.40.2"')
    tracker.append(buffer, fixture().init, { timestampOffset: 10 })
    tracker.append(buffer, fixture().cluster, { timestampOffset: 0 })
    assert.match(source.error.message, /settings changed: previous=.*timestampOffset.*10.*current=.*timestampOffset.*0/)
    present(tracker, source)
    assert.throws(() => tracker.seal(source), codeIs('CAPTURE_UNSUPPORTED_TIMELINE'))
  }
  {
    const { tracker, source, buffer } = setup()
    tracker.append(buffer, fixture().bytes)
    tracker.observe(source, content, { position: 0, now: 0, duration: 50 })
    tracker.observe(source, content, { position: 50, now: 100, duration: 50, ended: true })
    assert.throws(() => tracker.seal(source), codeIs('CAPTURE_PARTIAL_PRESENTATION'))
  }
  {
    const { tracker, source, buffer } = setup()
    tracker.maxBytes = 10
    tracker.append(buffer, fixture().bytes)
    present(tracker, source)
    assert.throws(() => tracker.seal(source), codeIs('CAPTURE_QUARANTINE_LIMIT'))
  }
})

test('stable offset/window retains all bytes and validates the actual native discard or splice range', () => {
  const { projectTimeline } = load(), rate = 44100, frames = Array.from({ length: 8 }, (_, i) => ({ start: i * 1024 / rate, end: (i + 1) * 1024 / rate }))
  const parsed = { frames, start: 0, end: frames.at(-1).end, quantum: 1 / rate, codec: 'mp4a.40.2' }
  const settings = { timestampOffset: -1600 / rate, appendWindowStart: 0, appendWindowEnd: (8192 - 1600 - 400) / rate, mode: 'segments' }
  const native = [{ start: 0, end: settings.appendWindowEnd }]
  const projected = projectTimeline(parsed, settings, native)
  assert.equal(projected.start, 0)
  assert.equal(projected.end, native[0].end)
  assert.equal(projected.frames.length, 7)
  assert.equal(projected.timelineSettings, settings)
  // Native range, not a guessed priming duration, selects the optional boundary splice.
  for (const ranges of [[], [{ start: 0, end: native[0].end - 0.005 }], [{ start: 0, end: 0.02 }, { start: 0.03, end: native[0].end }]]) assert.throws(() => projectTimeline(parsed, settings, ranges), codeIs('CAPTURE_UNSUPPORTED_APPEND_WINDOW'))
  const exact = { ...settings, timestampOffset: -2048 / rate, appendWindowEnd: 6144 / rate }
  assert.equal(projectTimeline(parsed, exact, [{ start: 0, end: 6144 / rate }]).frames.length, 6)
  const { tracker, source, buffer } = setup(), f = fixture()
  const webmSettings = { timestampOffset: -0.02, appendWindowStart: 0, appendWindowEnd: 0.04, mode: 'segments' }
  tracker.append(buffer, f.init, webmSettings); tracker.append(buffer, f.cluster, webmSettings)
  assert.equal(source.error.code, 'CAPTURE_UNSUPPORTED_TIMELINE')
  assert.ok(source.error.message.includes('WebM/Opus'))
  assert.equal(buffer.chunks.length, 0)
})

test('pre-detach terminal clock must cover complete parsed audio and exact audio-buffer ranges', () => {
  for (const change of [null, { position: 0.05 }, { audioRanges: [{ start: 0, end: 0.04 }] }, { audioRanges: [{ start: 0.02, end: 0.06 }] }, { audioRanges: [{ start: 0, end: 0.08 }] }, { audioRanges: [{ start: 0, end: 0.02 }, { start: 0.04, end: 0.06 }] }, { seeking: true }, { updating: true }, { playbackRate: 2 }, { readyState: 0 }]) {
    const { tracker, source, buffer } = setup()
    tracker.append(buffer, fixture().bytes)
    const terminal = { source, sourceEnded: true, position: 0.06, duration: 0.1, audioRanges: [{ start: 0, end: 0.06 }], seeking: false, updating: false, playbackRate: 1, readyState: 4, ...change }
    tracker.observe(source, content, { position: 0, now: 0, duration: 0.1 })
    tracker.observe(source, content, { position: terminal.position, now: 60, duration: 0.1 })
    if (change) assert.throws(() => tracker.seal(source, terminal), codeIs('CAPTURE_PARTIAL_PRESENTATION'))
    else assert.equal(tracker.seal(source, terminal).timeline.end, 0.06)
  }
})

test('playing the entire downloaded prefix does not prove the complete song without official EOF', () => {
  const { tracker, source, buffer } = setup()
  // A decoder may play all 90 buffered seconds before the remaining 288-second song arrives.
  buffer.parser = () => ({ frames: [{ start: 0, end: 90 }], start: 0, end: 90, quantum: 0.001 })
  tracker.append(buffer, fixture().bytes)
  tracker.observe(source, content, { position: 0, duration: 288, now: 0 })
  for (let now = 100; now <= 90100; now += 100) tracker.observe(source, content, { position: now / 1000, duration: 288, now })
  const terminal = { source, sourceEnded: false, sourceReadyState: 'open', successfulEndOfStream: false, position: 90.1, seeking: false, playbackRate: 1, readyState: 4, updating: false, audioRanges: [{ start: 0, end: 90 }] }
  assert.throws(() => tracker.seal(source, terminal), e => e.code === 'CAPTURE_PARTIAL_PRESENTATION' && e.message.includes('Official source completion was not observed'))
})

test('an ended observation flag cannot override a native open source and media that has not ended', () => {
  const { tracker, source, buffer } = setup()
  tracker.append(buffer, fixture().bytes)
  tracker.observe(source, content, { position: 0, duration: 0.1, now: 0 })
  tracker.observe(source, content, { position: 0.06, duration: 0.1, now: 60, ended: true })
  assert.throws(() => tracker.seal(source, { source, ended: false, sourceEnded: false, sourceReadyState: 'open', position: 0.06, seeking: false, playbackRate: 1, readyState: 4, updating: false, audioRanges: [{ start: 0, end: 0.06 }] }), codeIs('CAPTURE_PARTIAL_PRESENTATION'))
})

function browserMocks() {
  class SourceBuffer extends EventTarget {
    constructor() { super(); this.timestampOffset = 0; this.appendWindowStart = 0; this.appendWindowEnd = Infinity; this.mode = 'segments'; this.updating = false; this.buffered = { length: 0 } }
    appendBuffer() {}
    abort() { if (this.abortThrows) throw new Error('InvalidStateError'); this.updating = false; queueMicrotask(() => this.dispatchEvent(new Event('abort'))) }
    remove() { if (this.removeThrows) throw new Error('InvalidStateError') }
    changeType() { if (this.changeTypeThrows) throw new Error('NotSupportedError') }
  }
  class MediaSource {
    static canConstructInDedicatedWorker = true
    constructor() { this.readyState = 'open' }
    addSourceBuffer() { return new SourceBuffer() }
    endOfStream(error) { if (this.readyState !== 'open') throw new Error('InvalidStateError'); this.readyState = 'ended'; this.endError = error }
  }
  class Element extends EventTarget {
    setAttribute(name, value) { if (name === 'src') this._src = this.currentSrc = value }
    removeAttribute(name) { if (name === 'src') { this._src = this.currentSrc = ''; this._currentTime = 0 } }
  }
  class HTMLMediaElement extends Element {
    constructor() { super(); Object.assign(this, { tagName: 'VIDEO', _currentTime: 0, duration: 0.06, readyState: 4, paused: false, seeking: false, ended: false, playbackRate: 1, currentSrc: '', _src: '', _srcObject: null }) }
    get src() { return this._src }
    set src(value) { this._src = this.currentSrc = value; this._currentTime = 0 }
    get srcObject() { return this._srcObject }
    set srcObject(value) { this._srcObject = value; this._currentTime = 0 }
    get currentTime() { return this._currentTime }
    set currentTime(value) { this._currentTime = value }
    load() { this._currentTime = 0 }
    pause() { this.paused = true }
    play() { this.paused = false; return Promise.resolve() }
  }
  let next = 0
  return { MediaSource, SourceBuffer, Element, HTMLMediaElement, URL: { createObjectURL: () => `blob:test-${++next}`, revokeObjectURL() {} } }
}

test('standard detach hooks snapshot the old source and audio clock before reflected mutation or load', () => {
  for (const operation of ['src', 'srcObject', 'setAttribute', 'removeAttribute', 'load']) {
    const scope = browserMocks(), { install, SessionTracker } = load(), tracker = new SessionTracker(), snapshots = []
    const capture = install({ scope, tracker, onBeforeDetach: (element, snapshot) => snapshots.push({ element, snapshot }) })
    const media = new scope.HTMLMediaElement(), mse = new scope.MediaSource(), sb = mse.addSourceBuffer('audio/webm; codecs="opus"')
    media.src = scope.URL.createObjectURL(mse)
    const source = capture.sourceOf(media)
    sb.buffered = { length: 1, start: () => 0, end: () => 0.06 }
    tracker.observe(source, content, { position: 0, now: 0, duration: 0.1, element: media })
    media._currentTime = 0.06 // Native decoder advancement; not the script-facing seek setter.
    if (operation === 'src') media.src = 'blob:postroll'
    else if (operation === 'srcObject') media.srcObject = new scope.MediaSource()
    else if (operation === 'setAttribute') media.setAttribute('src', 'blob:postroll')
    else if (operation === 'removeAttribute') media.removeAttribute('src')
    else media.load()
    assert.equal(snapshots.length, 1, operation)
    assert.equal(snapshots[0].snapshot.source, source)
    assert.equal(snapshots[0].snapshot.position, 0.06)
    assert.deepEqual(Array.from(snapshots[0].snapshot.audioRanges, (r) => ({ ...r })), [{ start: 0, end: 0.06 }])
  }
})

test('synchronous currentTime assignment invalidates content even before a seeking event is delivered', () => {
  const scope = browserMocks(), { install, SessionTracker } = load(), tracker = new SessionTracker(), snapshots = []
  const capture = install({ scope, tracker, onBeforeDetach: (_, snapshot) => snapshots.push(snapshot) })
  const media = new scope.HTMLMediaElement(), mse = new scope.MediaSource()
  mse.addSourceBuffer('audio/webm; codecs="opus"')
  media.src = scope.URL.createObjectURL(mse)
  const source = capture.sourceOf(media)
  tracker.observe(source, content, { position: 0, now: 0, duration: 0.1, element: media })
  media.currentTime = 0.06
  media.src = 'blob:postroll'
  assert.equal(source.error.code, 'CAPTURE_PARTIAL_PRESENTATION')
  assert.equal(snapshots.length, 1)
  assert.equal(snapshots[0].source.error.code, 'CAPTURE_PARTIAL_PRESENTATION')
})

test('source completion requires successful native EOF without error and is invalidated by later appends', () => {
  const scope = browserMocks(), { install, SessionTracker } = load(), tracker = new SessionTracker()
  const capture = install({ scope, tracker }), media = new scope.HTMLMediaElement(), mse = new scope.MediaSource(), sb = mse.addSourceBuffer('audio/webm; codecs="opus"')
  media.src = scope.URL.createObjectURL(mse)
  assert.equal(capture.snapshotOf(media).sourceEnded, false)
  mse.readyState = 'closed'
  assert.throws(() => mse.endOfStream(), /InvalidStateError/)
  assert.equal(capture.snapshotOf(media).sourceEnded, false)
  mse.readyState = 'open'; mse.endOfStream()
  assert.equal(capture.snapshotOf(media).sourceEnded, true)
  sb.appendBuffer(fixture().bytes)
  assert.equal(capture.snapshotOf(media).sourceEnded, false)
  mse.readyState = 'open'; mse.endOfStream('network')
  assert.equal(capture.snapshotOf(media).sourceEnded, false)
  assert.equal(capture.sourceOf(media).error.code, 'CAPTURE_PARTIAL_PRESENTATION')
})

test('EOF caches the parsed inventory until another append and still checks changed native ranges', () => {
  const { SessionTracker } = load(), tracker = new SessionTracker(), source = tracker.createSource(), buffer = tracker.createBuffer(source, 'audio/mp4; codecs="mp4a.40.2"')
  let calls = 0
  buffer.parser = () => { calls++; return { frames: [{ start: 0, end: 0.06 }], start: 0, end: 0.06, quantum: 0.001 } }
  tracker.append(buffer, fixture().bytes, { timestampOffset: -0.02, appendWindowEnd: 0.04 })
  source.successfulEndOfStream = true
  tracker.inspect(source, [{ start: 0, end: 0.04 }]); tracker.inspect(source, [{ start: 0, end: 0.04 }])
  assert.equal(calls, 1)
  assert.throws(() => tracker.inspect(source, [{ start: 0, end: 0.02 }]), codeIs('CAPTURE_UNSUPPORTED_APPEND_WINDOW'))
  assert.equal(calls, 1)
  tracker.append(buffer, new Uint8Array([0]), { timestampOffset: -0.02, appendWindowEnd: 0.04 })
  source.successfulEndOfStream = true
  tracker.inspect(source, [{ start: 0, end: 0.04 }])
  assert.equal(calls, 2)
})

test('browser hooks map sources to elements and retain a copied DataView independently', () => {
  const scope = browserMocks()
  const { install } = load()
  const capture = install({ scope })
  const media = new scope.MediaSource(), other = new scope.MediaSource()
  const sb = media.addSourceBuffer('audio/webm; codecs="opus"')
  const url = scope.URL.createObjectURL(media), otherUrl = scope.URL.createObjectURL(other)
  const original = fixture().bytes
  const expected = original.slice()
  sb.appendBuffer(new DataView(original.buffer))
  original.fill(0)
  const source = capture.sourceOf({ currentSrc: url })
  assert.notEqual(source, capture.sourceOf({ currentSrc: otherUrl }))
  assert.equal(source, capture.sourceOf({ srcObject: media }))
  assert.deepEqual(source.buffers[0].chunks[0], expected)
  assert.equal(source.state, 'unknown')
  assert.equal(scope.MediaSource.canConstructInDedicatedWorker, true)
})

test('successful native abort invalidates copied partial input synchronously before its queued event', async () => {
  const scope = browserMocks(), { install, SessionTracker } = load(), tracker = new SessionTracker(), capture = install({ scope, tracker })
  const source = new scope.MediaSource(), sb = source.addSourceBuffer('audio/webm; codecs="opus"'), media = { currentSrc: scope.URL.createObjectURL(source) }
  const record = capture.sourceOf(media), f = fixture()
  let delivered = false
  sb.addEventListener('abort', () => { delivered = true; assert.equal(record.error.code, 'CAPTURE_AMBIGUOUS_TIMELINE') })
  sb.appendBuffer(f.bytes.subarray(0, f.bytes.length - 2))
  sb.updating = true
  sb.abort()
  assert.equal(record.error.code, 'CAPTURE_AMBIGUOUS_TIMELINE')
  assert.equal(delivered, false)
  sb.appendBuffer(f.bytes.subarray(f.bytes.length - 2))
  present(tracker, record)
  assert.throws(() => tracker.seal(record), codeIs('CAPTURE_AMBIGUOUS_TIMELINE'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(delivered, true)
})

test('an abort that throws natively does not invalidate the captured source', () => {
  const scope = browserMocks(), { install, SessionTracker } = load(), tracker = new SessionTracker(), capture = install({ scope, tracker })
  const source = new scope.MediaSource(), sb = source.addSourceBuffer('audio/webm; codecs="opus"'), media = { currentSrc: scope.URL.createObjectURL(source) }
  const record = capture.sourceOf(media)
  sb.appendBuffer(fixture().bytes)
  sb.abortThrows = true
  assert.throws(() => sb.abort(), /InvalidStateError/)
  assert.equal(record.error, null)
  present(tracker, record)
  assert.equal(tracker.seal(record).timeline.end, 0.06)
})

test('failed native remove and changeType preserve the source; only successful mutations invalidate it', () => {
  for (const method of ['remove', 'changeType']) {
    const scope = browserMocks(), { install, SessionTracker } = load(), tracker = new SessionTracker(), capture = install({ scope, tracker })
    const source = new scope.MediaSource(), sb = source.addSourceBuffer('audio/webm; codecs="opus"'), media = { currentSrc: scope.URL.createObjectURL(source) }
    const record = capture.sourceOf(media)
    sb.appendBuffer(fixture().bytes)
    sb[`${method}Throws`] = true
    assert.throws(() => method === 'remove' ? sb.remove(0, 0.01) : sb.changeType('not/a-supported-mime'), /InvalidStateError|NotSupportedError/)
    assert.equal(record.error, null)
    present(tracker, record)
    assert.equal(tracker.seal(record).timeline.end, 0.06)
  }
})

test('format changes, removal and multiplexed audio are capability failures', () => {
  for (const action of ['changeType', 'remove', 'multiplexed']) {
    const scope = browserMocks(), { install } = load(), capture = install({ scope })
    const media = new scope.MediaSource(), url = scope.URL.createObjectURL(media)
    if (action === 'multiplexed') media.addSourceBuffer('video/mp4; codecs="avc1,mp4a.40.2"')
    else {
      const sb = media.addSourceBuffer('audio/webm; codecs="opus"')
      if (action === 'remove') sb.remove(0, 2)
      else sb.changeType('audio/mp4; codecs="mp4a.40.2"')
    }
    assert.match(capture.sourceOf({ src: url }).error.code, /^CAPTURE_/)
  }
})

test('adapter requires the right element, destination, matching visible title and no ad marker', () => {
  const { context } = load()
  const element = {}, otherElement = {}
  let videoId = 'target', title = 'Song', marker = false
  const player = { contains: (e) => e === element, getVideoData: () => ({ video_id: videoId, title: 'Song' }), classList: { contains: () => marker }, querySelector: () => null, querySelectorAll: (selector) => selector === 'audio,video' ? [element] : [] }
  const document = { querySelector: (selector) => selector === '#movie_player' ? player : selector === 'ytmusic-player-bar .title' ? { textContent: title } : null }
  const adapter = context.__musifyCaptureYouTube.create({ document, location: { search: '?v=target' }, target: 'target' })
  assert.equal(adapter.classify(element).state, 'content')
  assert.equal(adapter.classify(otherElement).state, 'unknown')
  title = ''
  assert.equal(adapter.classify(element).state, 'unknown')
  title = 'Song'; marker = true
  assert.equal(adapter.classify(element).state, 'ad')
  marker = false; videoId = 'advert'
  assert.equal(adapter.classify(element).state, 'ad')
  player.getVideoData = () => { throw new Error('detached player') }
  assert.equal(adapter.classify(element).state, 'unknown')
  player.getVideoData = () => ({ video_id: 'target', title: 'Song' })
  Object.assign(element, { paused: false, ended: false, readyState: 4 })
  Object.assign(otherElement, { paused: false, ended: false, readyState: 4 })
  player.querySelectorAll = () => [element, otherElement]
  const multiple = adapter.classify(element)
  assert.equal(multiple.state, 'unknown')
  assert.equal(multiple.ambiguous, true)
  assert.equal(JSON.parse(multiple.reason).activeMediaCount, 2)
})

test('ad diagnostics distinguish hidden persistent nodes from active classes without weakening classification', () => {
  const media = { currentTime: 12, duration: 30, paused: false, ended: false, readyState: 4 }
  const overlay = { hidden: false, getClientRects: () => [] }
  let showing = false
  const player = { contains: e => e === media, getVideoData: () => ({ video_id: 'target', title: 'Song' }), classList: { contains: name => name === 'ad-showing' && showing }, querySelector: selector => selector.includes('.ytp-ad-player-overlay') ? overlay : null, querySelectorAll: selector => selector === 'audio,video' ? [media] : [] }
  const document = { querySelector: selector => selector === '#movie_player' ? player : selector === 'ytmusic-player-bar .title' ? { textContent: 'Song' } : null, defaultView: { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) } }
  const { context } = load({ document, location: { search: '?v=target' } })
  const adapter = context.__musifyCaptureYouTube.create({ document, location: { search: '?v=target' }, target: 'target' })
  const hidden = adapter.classify(media)
  assert.equal(hidden.state, 'ad')
  assert.equal(hidden.evidence.adOverlayPresent, true)
  assert.equal(hidden.evidence.adOverlayVisible, false)
  assert.equal(hidden.evidence.adClassShowing, false)
  showing = true; overlay.getClientRects = () => [{}]
  const visible = adapter.classify(media)
  assert.equal(visible.evidence.adOverlayVisible, true)
  assert.equal(visible.evidence.adClassShowing, true)
})

test('only a visible enabled official skip button is clicked during a confirmed ad', () => {
  const { context } = load()
  const media = { paused: false, ended: false, readyState: 4 }
  let marker = true, clicks = 0, visible = true
  const button = { disabled: false, getClientRects: () => visible ? [{}] : [], getAttribute: () => null, click() { clicks++ } }
  const p = {
    contains: (element) => element === media,
    getVideoData: () => ({ video_id: 'target', title: 'Song' }),
    classList: { contains: () => marker }, querySelector: () => null,
    querySelectorAll: (selector) => selector === 'audio,video' ? [media] : [button],
  }
  const document = { querySelector: (selector) => selector === '#movie_player' ? p : { textContent: 'Song' } }
  const adapter = context.__musifyCaptureYouTube.create({ document, location: { search: '?v=target' }, target: 'target' })
  visible = false
  assert.equal(adapter.skipAd(media), false)
  visible = true; button.disabled = true
  assert.equal(adapter.skipAd(media), false)
  button.disabled = false; marker = false
  assert.equal(adapter.skipAd(media), false)
  marker = true
  assert.equal(adapter.skipAd(media), true)
  assert.equal(clicks, 1)
  assert.equal(adapter.skipAd(media), false, 'do not repeatedly click a skip action still processing')
})

test('observed no-bar layout requires both exact player-link and Media Session titles, without bypassing conflicts', () => {
  const metadata = { title: 'Song' }
  const { context } = load({ navigator: { mediaSession: { metadata } } })
  const media = { paused: true, ended: false, readyState: 4, currentTime: 0 }
  let linkTitle = 'Song', barTitle = ''
  const p = {
    contains: (element) => element === media,
    getVideoData: () => ({ video_id: 'target', title: 'Song' }),
    classList: { contains: () => false }, querySelector: () => null,
    querySelectorAll: (selector) => selector === 'audio,video' ? [media] : selector === '.ytp-title-link' ? [{ textContent: linkTitle }] : [],
  }
  const document = { querySelector: (selector) => selector === '#movie_player' ? p : selector === 'ytmusic-player-bar .title' && barTitle ? { textContent: barTitle } : null }
  const location = { search: '?v=target' }
  const adapter = context.__musifyCaptureYouTube.create({ document, location, target: 'target' })
  assert.equal(adapter.classify(media).state, 'content')
  assert.ok(adapter.classify(media).signals.includes('media-session-title'))
  metadata.title = ''
  assert.equal(adapter.classify(media).state, 'unknown')
  metadata.title = 'Song'; linkTitle = ''
  assert.equal(adapter.classify(media).state, 'unknown')
  linkTitle = 'Song (advertisement)'
  assert.equal(adapter.classify(media).state, 'unknown')
  linkTitle = 'Song'; barTitle = 'Different song'
  assert.equal(adapter.classify(media).state, 'unknown')
  barTitle = ''; location.search = '?v=another'
  assert.equal(adapter.classify(media).state, 'unknown')
})

test('orchestrator emits versioned generation/sequence and explicit unsupported pipeline error', async () => {
  const messages = []
  const location = { search: '?v=target', hash: '', hostname: 'music.youtube.com', replace() {} }
  const document = { querySelectorAll: () => [] }
  const { context } = load({ location, document, performance: { now: () => 0 }, clearInterval() {} })
  context.window = { __musifyTarget: 'target', __musifyGeneration: 7, chrome: { webview: { postMessage: (message) => messages.push(JSON.parse(message.slice('musify:'.length))) } } }
  vm.runInContext(orchestratorCode, context)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(messages.length, 1)
  assert.equal(messages[0].generation, 7)
  assert.ok(Number.isSafeInteger(messages[0].sequence) && messages[0].sequence > 0)
  assert.equal(messages[0].type, 'error')
  assert.equal(messages[0].code, 'CAPTURE_UNSUPPORTED_PIPELINE')
  assert.equal(messages[0].v, 'target')
})

test('authentication requests interaction while preserving the official page and heartbeats', async () => {
  const messages = [], navigations = []
  let callback = null
  const scope = browserMocks()
  const location = { search: '?v=target', hash: '', hostname: 'music.youtube.com', replace: (url) => navigations.push(url) }
  const document = { querySelectorAll: () => [], querySelector: () => ({ textContent: 'Sign in to confirm you are not a bot' }) }
  const { context } = load({
    ...scope, location, document, performance: { now: () => 10000 },
    setInterval(fn) { callback = fn; return 1 }, clearInterval() {},
    MutationObserver: class { observe() {} },
  })
  context.window = { __musifyTarget: 'target', __musifyGeneration: 7, chrome: { webview: { postMessage: (m) => messages.push(JSON.parse(m.slice(7))) } } }
  vm.runInContext(orchestratorCode, context)
  callback()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(messages.filter((m) => m.type === 'interaction').length, 1)
  assert.equal(messages.filter((m) => m.type === 'progress').length, 1)
  assert.equal(messages.filter((m) => m.type === 'error').length, 0)
  assert.equal(messages.filter((m) => m.kind === 'seg').length, 0)
  assert.deepEqual(navigations, [])
  assert.ok(messages[1].sequence > messages[0].sequence)
})

test('window capture sees ended before YouTube document and target handlers change identity and source', async () => {
  const messages = [], navigations = []
  let clock = 0, capturedEnded = null, adShowing = false
  class Media extends EventTarget {
    constructor() { super(); this.tagName = 'VIDEO'; this.currentTime = 0; this.duration = 0.06; this.readyState = 4; this.paused = false; this.seeking = false; this.ended = false; this.currentSrc = '' }
    play() { this.paused = false; return Promise.resolve() }
    pause() { this.paused = true }
  }
  const media = new Media(), scope = browserMocks()
  // The page installs this target listener before the MutationObserver attaches ours.
  media.addEventListener('ended', () => { media.currentSrc = 'blob:postroll'; media.currentTime = 0; media.duration = 11 })
  const player = { contains: (e) => e === media, getVideoData: () => ({ video_id: 'target', title: 'Song', author: 'Artist' }), classList: { contains: () => adShowing }, querySelector: () => null, querySelectorAll: (selector) => selector === 'audio,video' ? [media] : [] }
  const document = { querySelectorAll: () => [media], querySelector: (selector) => selector === '#movie_player' ? player : selector === 'ytmusic-player-bar .title' ? { textContent: 'Song' } : null, addEventListener() { assert.fail('Production capture must register on Window before Document') } }
  const location = { search: '?v=target', hash: '', hostname: 'music.youtube.com', replace: (url) => navigations.push({ url, messages: messages.length }) }
  class FileReader {
    async readAsDataURL(blob) { this.result = 'data:application/octet-stream;base64,' + Buffer.from(await blob.arrayBuffer()).toString('base64'); this.onload() }
  }
  const { context } = load({ ...scope, document, location, FileReader, Blob, performance: { now: () => clock }, setInterval: () => 1, clearInterval() {}, MutationObserver: class { observe() {} } })
  context.window = { __musifyTarget: 'target', __musifyGeneration: 8, chrome: { webview: { postMessage: (m) => messages.push(JSON.parse(m.slice(7))) } }, addEventListener(type, fn, capture) { if (type === 'ended') { assert.equal(capture, true); capturedEnded = fn } } }
  vm.runInContext(orchestratorCode, context)
  const source = new scope.MediaSource(), buffer = source.addSourceBuffer('audio/webm; codecs="opus"')
  buffer.buffered = { length: 1, start: () => 0, end: () => 0.06 }
  media.currentSrc = scope.URL.createObjectURL(source)
  const f = fixture()
  buffer.appendBuffer(f.init)
  buffer.appendBuffer(f.cluster)
  media.dispatchEvent(new Event('playing'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(messages.filter((m) => m.kind === 'seg').length, 0)
  clock = 60; media.currentTime = 0.06; media.ended = true; media.paused = true
  // Native DOM dispatch visits Window, then Document, then target, even without bubbling.
  capturedEnded({ target: media })
  adShowing = true // YouTube's Document capture listener runs after ours on Window.
  media.dispatchEvent(new Event('ended'))
  await new Promise((resolve) => setImmediate(resolve))
  const proofIndex = messages.findIndex((m) => m.type === 'diagnostic' && m.verified)
  const segments = messages.filter((m) => m.kind === 'seg')
  assert.ok(proofIndex >= 0 && proofIndex < messages.findIndex((m) => m.kind === 'seg'))
  assert.deepEqual(messages[proofIndex].timelineSettings, { timestampOffset: 0, appendWindowStart: 0, appendWindowEnd: null, mode: 'segments' })
  assert.equal(segments.length, 2)
  for (const segment of segments) {
    assert.equal(segment.source, messages[proofIndex].source)
    assert.equal(segment.s, messages[proofIndex].s)
    assert.equal(segment.classification, 'content')
    assert.equal(segment.generation, 8)
  }
  assert.deepEqual(Buffer.concat(segments.map((m) => Buffer.from(m.data, 'base64'))), Buffer.from(f.bytes))
  assert.equal(messages.at(-1).type, 'ended')
  assert.equal(messages.at(-1).duration, 0.06)
  assert.equal(messages.at(-1).source, segments[0].source)
  assert.equal(messages.at(-1).s, segments[0].s)
  assert.ok(messages.every((m, i) => i === 0 || m.sequence > messages[i - 1].sequence))
  assert.deepEqual(navigations, [{ url: 'about:blank', messages: messages.length }])
})

test('orchestrator releases before native source reset only when the old audio is completely presented', async () => {
  for (const scenario of ['complete', 'early', 'seek']) {
    const scope = browserMocks(), media = new scope.HTMLMediaElement(), messages = []
    let clock = 0
    media.duration = 0.1 // Video can extend past the final audio packet.
    const player = { contains: (e) => e === media, getVideoData: () => ({ video_id: 'target', title: 'Song' }), classList: { contains: () => false }, querySelector: () => null, querySelectorAll: (selector) => selector === 'audio,video' ? [media] : [] }
    const document = { querySelectorAll: () => [media], querySelector: (selector) => selector === '#movie_player' ? player : selector === 'ytmusic-player-bar .title' ? { textContent: 'Song' } : null }
    const location = { search: '?v=target', hash: '', hostname: 'music.youtube.com', replace() {} }
    class FileReader { async readAsDataURL(blob) { this.result = 'data:application/octet-stream;base64,' + Buffer.from(await blob.arrayBuffer()).toString('base64'); this.onload() } }
    const { context } = load({ ...scope, document, location, FileReader, Blob, performance: { now: () => clock }, setInterval: () => 1, clearInterval() {}, MutationObserver: class { observe() {} } })
    context.window = { __musifyTarget: 'target', __musifyGeneration: 12, chrome: { webview: { postMessage: (m) => messages.push(JSON.parse(m.slice(7))) } } }
    vm.runInContext(orchestratorCode, context)
    const source = new scope.MediaSource(), buffer = source.addSourceBuffer('audio/webm; codecs="opus"')
    media.src = scope.URL.createObjectURL(source)
    buffer.buffered = { length: 1, start: () => 0, end: () => 0.06 }
    buffer.appendBuffer(fixture().bytes)
    media.dispatchEvent(new Event('playing'))
    clock = scenario === 'early' ? 50 : 60
    if (scenario === 'seek') media.currentTime = 0.06
    else media._currentTime = clock / 1000 // Native advancement, not a seek.
    source.endOfStream()
    media.src = 'blob:postroll'
    assert.equal(media.currentTime, 0)
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(messages.some((m) => m.type === 'diagnostic' && m.reason?.includes('Before source detach')))
    if (scenario === 'complete') {
      assert.deepEqual(Buffer.concat(messages.filter((m) => m.kind === 'seg').map((m) => Buffer.from(m.data, 'base64'))), Buffer.from(fixture().bytes))
      assert.equal(messages.at(-1).type, 'ended')
      assert.equal(messages.at(-1).duration, 0.1)
      assert.equal(messages.some((m) => m.type === 'error'), false)
    } else {
      assert.equal(messages.some((m) => m.kind === 'seg'), false)
      assert.equal(messages.find((m) => m.type === 'error').code, 'CAPTURE_PARTIAL_PRESENTATION')
    }
  }
})

test('capture-phase timeupdate seals full audio after official EOF before postroll metadata changes', async () => {
  for (const scenario of ['short', 'full', 'ad-before-full', 'range-mismatch', 'eof-error', 'synthetic-ended']) {
    const scope = browserMocks(), media = new scope.HTMLMediaElement(), messages = []
    let clock = 0, adShowing = false, capturedTimeupdate = null
    media.duration = 0.1
    const player = { contains: e => e === media, getVideoData: () => ({ video_id: 'target', title: 'Song' }), classList: { contains: () => adShowing }, querySelector: () => null, querySelectorAll: selector => selector === 'audio,video' ? [media] : [] }
    const document = { querySelectorAll: () => [media], querySelector: selector => selector === '#movie_player' ? player : selector === 'ytmusic-player-bar .title' ? { textContent: 'Song' } : null, addEventListener(type, fn, capture) { if (type === 'timeupdate') { assert.equal(capture, true); capturedTimeupdate = fn } } }
    const location = { search: '?v=target', hash: '', hostname: 'music.youtube.com', replace() {} }
    class FileReader { async readAsDataURL(blob) { this.result = 'data:application/octet-stream;base64,' + Buffer.from(await blob.arrayBuffer()).toString('base64'); this.onload() } }
    const { context } = load({ ...scope, document, location, FileReader, Blob, performance: { now: () => clock }, setInterval: () => 1, clearInterval() {}, MutationObserver: class { observe() {} } })
    context.window = { __musifyTarget: 'target', __musifyGeneration: 13, chrome: { webview: { postMessage: m => messages.push(JSON.parse(m.slice(7))) } } }
    vm.runInContext(orchestratorCode, context)
    const source = new scope.MediaSource(), buffer = source.addSourceBuffer('audio/webm; codecs="opus"')
    media.src = scope.URL.createObjectURL(source)
    buffer.buffered = { length: 1, start: () => 0, end: () => scenario === 'range-mismatch' ? 0.04 : 0.06 }
    buffer.appendBuffer(fixture().bytes)
    media.dispatchEvent(new Event('playing'))
    if (scenario !== 'synthetic-ended') source.endOfStream(scenario === 'eof-error' ? 'network' : undefined)
    clock = scenario === 'short' || scenario === 'ad-before-full' ? 40 : 60
    media._currentTime = clock / 1000
    if (scenario === 'ad-before-full') adShowing = true
    if (scenario === 'synthetic-ended') media.dispatchEvent(new Event('ended'))
    else capturedTimeupdate({ target: media })
    // The target handler runs after document capture and mutates the player metadata.
    if (scenario === 'full') adShowing = true
    media.dispatchEvent(new Event('timeupdate'))
    if (scenario === 'full') buffer.changeType('audio/mp4; codecs="mp4a.40.2"') // Late postroll diagnostic while FileReader is draining.
    await new Promise(resolve => setImmediate(resolve))
    if (scenario === 'full') {
      assert.ok(messages.some(m => m.kind === 'seg'))
      assert.equal(messages.at(-1).type, 'ended')
      assert.equal(messages.some(m => m.type === 'error'), false)
      const verifiedAt = messages.findIndex(m => m.type === 'diagnostic' && m.verified)
      assert.equal(messages.slice(verifiedAt + 1).some(m => m.type === 'diagnostic'), false)
    } else {
      assert.equal(messages.some(m => m.kind === 'seg'), false)
      if (!['short', 'synthetic-ended'].includes(scenario)) assert.ok(messages.some(m => m.type === 'error'), scenario)
      else assert.equal(messages.some(m => m.type === 'error'), false)
    }
  }
})

test('native ended may retain the source-bound playing identity but never repairs earlier ambiguity or incomplete audio', async () => {
  for (const scenario of ['ended-postroll', 'ad-before-ended', 'unknown-before-ended', 'only-ad', 'append-after-eof', 'seeking', 'short-tail', 'stale', 'paused-not-ended', 'range-mismatch']) {
    const scope = browserMocks(), media = new scope.HTMLMediaElement(), messages = []
    let clock = 0, adShowing = scenario === 'only-ad', barTitle = 'Song'
    const player = { contains: e => e === media, getVideoData: () => ({ video_id: 'target', title: 'Song' }), classList: { contains: () => adShowing }, querySelector: () => null, querySelectorAll: selector => selector === 'audio,video' ? [media] : [] }
    const document = { querySelectorAll: () => [media], querySelector: selector => selector === '#movie_player' ? player : selector === 'ytmusic-player-bar .title' ? { textContent: barTitle } : null }
    const location = { search: '?v=target', hash: '', hostname: 'music.youtube.com', replace() {} }
    class FileReader { async readAsDataURL(blob) { this.result = 'data:application/octet-stream;base64,' + Buffer.from(await blob.arrayBuffer()).toString('base64'); this.onload() } }
    const { context } = load({ ...scope, document, location, FileReader, Blob, performance: { now: () => clock }, setInterval: () => 1, clearInterval() {}, MutationObserver: class { observe() {} } })
    context.window = { __musifyTarget: 'target', __musifyGeneration: 14, chrome: { webview: { postMessage: m => messages.push(JSON.parse(m.slice(7))) } } }
    vm.runInContext(orchestratorCode, context)
    const source = new scope.MediaSource(), buffer = source.addSourceBuffer('audio/webm; codecs="opus"')
    media.src = scope.URL.createObjectURL(source)
    buffer.buffered = { length: 1, start: () => 0, end: () => scenario === 'range-mismatch' ? 0.04 : 0.06 }
    buffer.appendBuffer(fixture().bytes)
    media.dispatchEvent(new Event('playing'))
    clock = 40; media._currentTime = 0.04
    if (scenario === 'ad-before-ended') adShowing = true
    if (scenario === 'unknown-before-ended') barTitle = ''
    media.dispatchEvent(new Event('timeupdate'))
    source.endOfStream()
    if (scenario === 'append-after-eof') buffer.appendBuffer(fixture().cluster)
    clock = scenario === 'stale' ? 600 : 60
    media._currentTime = scenario === 'short-tail' ? 0.05 : 0.06
    media.duration = media._currentTime
    media.paused = true; media.ended = scenario !== 'paused-not-ended'; media.seeking = scenario === 'seeking'
    adShowing = scenario !== 'only-ad' // A prior ad cannot become content at its terminal event.
    if (scenario === 'only-ad') media.dispatchEvent(new Event('ended'))
    else media.removeAttribute('src')
    await new Promise(resolve => setImmediate(resolve))
    if (scenario === 'ended-postroll') {
      assert.ok(messages.some(m => m.kind === 'seg'), scenario)
      assert.equal(messages.at(-1).type, 'ended')
      assert.ok(messages.at(-1).why.includes('source confirmed before presentation ended'))
      assert.ok(messages.some(m => m.type === 'diagnostic' && m.reason?.includes('"terminalIdentity":"ad"')))
    } else { assert.equal(messages.some(m => m.kind === 'seg'), false, scenario); assert.ok(messages.some(m => m.type === 'error'), scenario) }
  }
})

test('source replacement without ended reports prior timing and parsed ranges without releasing bytes', async () => {
  const messages = []
  const scope = browserMocks()
  const media = Object.assign(new EventTarget(), { tagName: 'VIDEO', currentTime: 0, duration: 0.06, readyState: 4, paused: false, ended: false, currentSrc: '', pause() { this.paused = true }, play() { this.paused = false; return Promise.resolve() } })
  const player = { contains: (e) => e === media, getVideoData: () => ({ video_id: 'target', title: 'Song' }), classList: { contains: () => false }, querySelector: () => null, querySelectorAll: (selector) => selector === 'audio,video' ? [media] : [] }
  const document = { querySelectorAll: () => [media], querySelector: (selector) => selector === '#movie_player' ? player : selector === 'ytmusic-player-bar .title' ? { textContent: 'Song' } : null }
  const location = { search: '?v=target', hash: '', hostname: 'music.youtube.com', replace() {} }
  const { context } = load({ ...scope, document, location, performance: { now: () => 0 }, setInterval: () => 1, clearInterval() {}, MutationObserver: class { observe() {} } })
  context.window = { __musifyTarget: 'target', __musifyGeneration: 11, chrome: { webview: { postMessage: (m) => messages.push(JSON.parse(m.slice(7))) } } }
  vm.runInContext(orchestratorCode, context)
  const source = new scope.MediaSource(), buffer = source.addSourceBuffer('audio/webm; codecs="opus"')
  media.currentSrc = scope.URL.createObjectURL(source)
  buffer.appendBuffer(fixture().bytes)
  media.dispatchEvent(new Event('playing'))
  media.currentSrc = 'blob:postroll'; media.duration = 11
  media.dispatchEvent(new Event('emptied'))
  await new Promise((resolve) => setImmediate(resolve))
  const failure = messages.find((m) => m.type === 'error')
  assert.equal(failure.code, 'CAPTURE_PARTIAL_PRESENTATION')
  assert.ok(failure.reason.includes('"duration":0.06'))
  assert.ok(failure.reason.includes('"lastPosition":0'))
  assert.ok(failure.reason.includes('"rangeEnd":0.06'))
  assert.equal(messages.some((m) => m.kind === 'seg'), false)
})

test('unrecognized consent keeps the page open and reports the injected target without a v query', async () => {
  const messages = [], navigations = []
  const location = { search: '', hostname: 'consent.youtube.com', replace: (url) => navigations.push(url) }
  const document = { readyState: 'complete', forms: [], querySelectorAll: () => [] }
  const { context } = load({ location, document })
  context.window = { __musifyTarget: 'target', __musifyGeneration: 9, chrome: { webview: { postMessage: (m) => messages.push(JSON.parse(m.slice(7))) } } }
  vm.runInContext(orchestratorCode, context)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(messages[0].type, 'interaction')
  assert.equal(messages[0].v, 'target')
  assert.equal(messages[0].generation, 9)
  assert.deepEqual(navigations, [])
})

test('missing initial title pauses at exactly zero and resumes only after evidence arrives; later unknown stays terminal', async () => {
  const messages = []
  let callback = null, clock = 0, title = ''
  const scope = browserMocks()
  const media = Object.assign(new EventTarget(), {
    currentTime: 0, duration: 0.06, readyState: 4, paused: false, ended: false, currentSrc: '',
    pause() { this.paused = true }, play() { this.paused = false; return Promise.resolve() },
  })
  const player = { contains: (e) => e === media, getVideoData: () => ({ video_id: 'target', title: 'Song' }), classList: { contains: () => false }, querySelector: () => null, querySelectorAll: (selector) => selector === 'audio,video' ? [media] : [] }
  const document = { querySelectorAll: () => [media], querySelector: (selector) => selector === '#movie_player' ? player : selector === 'ytmusic-player-bar .title' ? { textContent: title } : null }
  const location = { search: '?v=target', hash: '', hostname: 'music.youtube.com', replace() {} }
  const { context } = load({ ...scope, document, location, performance: { now: () => clock }, setInterval(fn) { callback = fn; return 1 }, clearInterval() {}, MutationObserver: class { observe() {} } })
  context.window = { __musifyTarget: 'target', __musifyGeneration: 10, chrome: { webview: { postMessage: (m) => messages.push(JSON.parse(m.slice(7))) } } }
  vm.runInContext(orchestratorCode, context)
  const source = new scope.MediaSource(), buffer = source.addSourceBuffer('audio/webm; codecs="opus"')
  media.currentSrc = scope.URL.createObjectURL(source)
  buffer.appendBuffer(fixture().bytes)
  media.dispatchEvent(new Event('loadedmetadata'))
  assert.equal(media.paused, true)
  clock = 2000; callback()
  assert.equal(media.paused, true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(messages.some((m) => m.type === 'error' || m.kind === 'seg'), false)
  assert.ok(messages.some((m) => m.type === 'diagnostic' && m.state === 'unknown'))
  title = 'Song'; callback()
  assert.equal(media.paused, false)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(messages.some((m) => m.type === 'playing'), true)
  title = ''; clock = 2010; media.currentTime = 0.01
  media.dispatchEvent(new Event('timeupdate'))
  await new Promise((resolve) => setImmediate(resolve))
  const failure = messages.find((m) => m.type === 'error')
  assert.equal(failure.code, 'CAPTURE_IDENTITY_UNCERTAIN')
  assert.equal((failure.reason.match(/CAPTURE_IDENTITY_UNCERTAIN:/g) || []).length, 1)
  assert.ok(failure.reason.includes('barTitle'))
  assert.equal(messages.some((m) => m.kind === 'seg'), false)
})
