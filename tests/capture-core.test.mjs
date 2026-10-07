import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

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
const integer = value => {
  const bytes = []
  do { bytes.unshift(value % 256); value = Math.floor(value / 256) } while (value)
  return bytes
}
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
function roundedEndFixture(duration) {
  // Preserve the real failing arithmetic: codedStart 212.961 (or 223.461)
  // plus an Opus20ms packet differs from the native decimal duration by one ULP.
  const times = [0]
  for (let at = 21; at <= Math.round(duration * 1000) - 20; at += 20) times.push(at)
  const clusters = []
  let clock = -1, blocks = []
  const flush = () => { if (blocks.length) clusters.push(element(0x1f43b675, concat(element(0xe7, integer(clock)), ...blocks))) }
  for (const [i, time] of times.entries()) {
    const nextClock = Math.floor(time / 30000) * 30000
    if (nextClock !== clock) { flush(); clock = nextClock; blocks = [] }
    const relative = time - clock
    blocks.push(element(0xa3, [0x81, relative >> 8, relative & 255, 0x80, 0x98, i & 255]))
  }
  flush()
  return { bytes: concat(fixture().init, ...clusters), frames: times.length, duration }
}
function nativeFinalAacFixture() {
  // Repeat the local FFmpeg AAC silence packet with its unchanged48kHz config.
  // 11800 complete1024-sample frames have the exact rational endpoint from q9's
  // regression:251.73333333333332. No fixture timestamp is rounded to the UI clock.
  const encoded = JSON.parse(readFileSync(new URL('fixtures/mse-audio.json', import.meta.url), 'utf8')).mse[0]
  const original = Buffer.from(encoded.base64, 'base64'), frames = 11800
  const moofAt = original.indexOf(Buffer.from('moof')) - 4, moofSize = original.readUInt32BE(moofAt)
  const init = original.subarray(0, moofAt), moof = Buffer.from(original.subarray(moofAt, moofAt + moofSize))
  moof.writeUInt32BE(frames, moof.indexOf(Buffer.from('trun')) + 8)
  const mdat = Buffer.alloc(8 + frames * 6)
  mdat.writeUInt32BE(mdat.length); mdat.write('mdat', 4)
  mdat.fill(Buffer.from('211004608c1c', 'hex'), 8)
  return { bytes: new Uint8Array(Buffer.concat([init, moof, mdat])), frames, end: frames * 1024 / 48000, clock: 251.733333, mime: encoded.mime }
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

test('WebM progressive inventory waits for complete blocks at every append byte boundary', () => {
  const { inspectWebMPrefix } = load()
  for (const unknownCluster of [false, true]) {
    const f = fixture({ unknownCluster }), complete = inspectWebMPrefix(f.bytes, { final: true })
    for (let length = 0; length <= f.bytes.length; length++) {
      const current = inspectWebMPrefix(f.bytes.subarray(0, length))
      assert.equal(current.samples.length, complete.samples.filter(s => s.offset + s.size <= length).length, `prefix ${length}, unknown=${unknownCluster}`)
      assert(current.samples.every(s => s.offset + s.size <= length))
    }
    assert.throws(() => inspectWebMPrefix(f.bytes.subarray(0, f.bytes.length - 1), { final: true }), codeIs('CAPTURE_UNSUPPORTED_WEBM'))
  }
})

test('WebM remux preserves initialization, exact coded payload and time without including future frames', () => {
  const { inspectWebMPrefix, remuxWebM, parseWebMOpus } = load(), f = fixture()
  const inventory = inspectWebMPrefix(f.bytes, { final: true })
  const first = remuxWebM(inventory, 0, 1), tail = remuxWebM(inventory, 1, 2)
  assert.equal(parseWebMOpus(concat(first.init, first.media)).codedEnd, 0.02)
  const result = parseWebMOpus(concat(first.init, first.media, tail.media))
  assert.deepEqual(result.frames, parseWebMOpus(f.bytes).frames)
  assert.deepEqual(result.codedFrames, parseWebMOpus(f.bytes).codedFrames)
  assert.deepEqual(first.init, inventory.init)
  assert.throws(() => remuxWebM(inventory, 0, 4), codeIs('CAPTURE_UNSUPPORTED_WEBM'))
})

function progressiveSetup() {
  const { ProgressiveTracker } = load(), tracker = new ProgressiveTracker({ epoch: 1, experimental: true })
  const source = tracker.createSource(), buffer = tracker.createBuffer(source, 'audio/webm; codecs="opus"')
  tracker.append(buffer, fixture().bytes)
  const snapshot = position => ({ source, position, duration: 0.06, seeking: false, paused: false, ended: false, playbackRate: 1, readyState: 4, updating: false, audioRanges: [{ start: 0, end: 0.06 }], sourceEnded: false })
  const observe = (position, now = position * 1000, identity = content) => tracker.observe(source, identity, { position, now, duration: 0.06 })
  return { tracker, source, buffer, snapshot, observe }
}

test('progressive units contain only complete samples inside confirmed presentation intervals', () => {
  const { tracker, source, snapshot, observe } = progressiveSetup(), { parseWebMOpus } = load()
  assert.equal(tracker.pull(source, snapshot(0.06)).length, 0)
  observe(0)
  observe(0.0199)
  assert.equal(tracker.pull(source, snapshot(0.0199)).length, 0, 'even a sub-quantum future sample stays quarantined')
  observe(0.02)
  const [first] = tracker.pull(source, snapshot(0.02))
  assert(first)
  assert.equal(first.rangeStart, 0)
  assert.equal(first.rangeEnd, 0.02)
  assert.equal(first.frames, 1)
  assert.equal(parseWebMOpus(first.data).codedEnd, 0.02)
  assert.equal(tracker.pull(source, snapshot(0.02)).length, 0, 'each unit is emitted once')
  observe(0.06)
  const [tail] = tracker.pull(source, snapshot(0.06))
  assert.equal(tail.frames, 2)
  assert.equal(tail.initKey, first.initKey)
  assert.equal(tail.rangeStart, first.rangeEnd)
  assert.throws(() => tracker.finish(source, snapshot(0.06)), codeIs('CAPTURE_PARTIAL_PRESENTATION'))
  assert.equal(tracker.finish(source, { ...snapshot(0.06), sourceEnded: true }).complete, true)
})

test('seek epochs retain separate coverage islands and EOF never labels a hole complete', () => {
  const { tracker, source, snapshot, observe } = progressiveSetup()
  observe(0); observe(0.02); tracker.pull(source, snapshot(0.02))
  tracker.beginEpoch(2, 0.04)
  assert.equal(tracker.onTimeAssignment(source, null, 0.04), true)
  observe(0.04, 100); observe(0.06, 120)
  const [tail] = tracker.pull(source, snapshot(0.06))
  assert.equal(tail.epoch, 2)
  assert.equal(tail.rangeStart, 0.04)
  const ended = tracker.finish(source, { ...snapshot(0.06), sourceEnded: true })
  assert.equal(ended.eof, true)
  assert.equal(ended.complete, false)
  assert.equal(ended.ranges.length, 2)
  assert.equal(ended.ranges[0].end, 0.02)
  assert.equal(ended.ranges[1].start, 0.04)
  assert.equal(tracker.onTimeAssignment(source, null, 0.04), false, 'seek authorization is not reusable')
  assert.equal(tracker.onSeekMutation(source.buffers[0], 'abort'), false)
})

test('coverage never stretches a partially observed packet across a 0.5ms epoch gap', () => {
  const { tracker, source, snapshot, observe } = progressiveSetup()
  observe(0); observe(0.02); tracker.pull(source, snapshot(0.02))
  tracker.beginEpoch(2, 0.0205)
  observe(0.0205, 100); observe(0.06, 140)
  const [tail] = tracker.pull(source, snapshot(0.06))
  assert.equal(tail.rangeStart, 0.04, 'the packet beginning at0.02 was not fully observed in either epoch')
  assert.equal(tail.frames, 1)
  assert.equal(tracker.coverage.length, 2)
  assert.equal(tracker.finish(source, { ...snapshot(0.06), sourceEnded: true }).complete, false)
})

test('a missing 20ms packet and a quantized 1ms coded gap remain distinct coverage islands', () => {
  for (const times of [[0, 40], [0, 21, 41]]) {
    const { ProgressiveTracker } = load(), tracker = new ProgressiveTracker({ epoch: 1, experimental: true }), source = tracker.createSource()
    const f = fixture({ times }), end = f.duration
    tracker.append(tracker.createBuffer(source, 'audio/webm; codecs="opus"'), f.bytes)
    tracker.beginEpoch(2, 0) // Byte inventory may contain islands; coverage may not hide them.
    tracker.observe(source, content, { position: 0, now: 0, duration: end })
    tracker.observe(source, content, { position: end, now: end * 1000, duration: end })
    const audioRanges = times[1] === 40 ? [{ start: 0, end: 0.02 }, { start: 0.04, end }] : [{ start: 0, end }]
    const snapshot = { source, position: end, duration: end, seeking: false, playbackRate: 1, readyState: 4, updating: false, audioRanges, sourceEnded: true }
    const units = tracker.pull(source, snapshot)
    assert.equal(units.length, 2)
    assert.equal(tracker.coverage.length, 2)
    assert.equal(tracker.finish(source, snapshot).complete, false)
  }
})

test('even a tiny explicitly unknown interval remains sticky after content returns', () => {
  const { tracker, source, snapshot, observe } = progressiveSetup()
  observe(0); observe(0.02); tracker.pull(source, snapshot(0.02))
  observe(0.0205, 21, { state: 'unknown', sourceBound: true, signals: [] })
  observe(0.021, 22); observe(0.06, 61)
  assert.throws(() => tracker.pull(source, snapshot(0.06)), codeIs('CAPTURE_IDENTITY_UNCERTAIN'))
  assert.equal(tracker.coverage.length, 1)
  assert.equal(tracker.coverage[0].end, 0.02)
})

test('post-seek EOF may retain only unchanged old native ranges and never credits them as presented', () => {
  for (const scenario of ['unchanged', 'expanded', 'new-range', 'different-buffer', 'different-settings']) {
    const { tracker, source, buffer, snapshot, observe } = progressiveSetup()
    const native = { buffered: { length: 1, start: () => 0, end: () => 0.06 } }
    buffer.native = native
    observe(0); observe(0.02); tracker.pull(source, snapshot(0.02))
    tracker.beginEpoch(2, 0.08)
    assert.equal(tracker.onTimeAssignment(source, null, 0.08), true)
    tracker.append(buffer, fixture({ times: [80, 100, 120] }).bytes)
    const ranges = [{ start: 0, end: scenario === 'expanded' ? 0.0605 : 0.06 }, ...(scenario === 'new-range' ? [{ start: 0.07, end: 0.075 }] : []), { start: 0.08, end: 0.14 }]
    if (scenario === 'different-buffer') buffer.native = { ...native }
    if (scenario === 'different-settings') buffer.timelineSettings = { ...buffer.timelineSettings, appendWindowEnd: 1 }
    tracker.observe(source, content, { position: 0.08, now: 100, duration: 0.14 })
    tracker.observe(source, content, { position: 0.14, now: 160, duration: 0.14 })
    const terminal = { ...snapshot(0.14), duration: 0.14, audioRanges: ranges, sourceEnded: true }
    tracker.pull(source, terminal)
    if (scenario === 'unchanged') {
      const proof = tracker.finish(source, terminal)
      assert.equal(proof.eof, true)
      assert.equal(proof.complete, false)
      assert.equal(proof.ranges[0].end, 0.02, 'prefetched0.02..0.06 stays uncredited')
      assert.equal(proof.ranges[1].start, 0.08)
    } else assert.throws(() => tracker.finish(source, terminal), codeIs('CAPTURE_PARTIAL_PRESENTATION'), scenario)
  }
})

test('EOF waits for the final sample even when only0.8ms of coded time remains', () => {
  const { tracker, source, snapshot, observe } = progressiveSetup()
  observe(0); observe(0.0592)
  const before = tracker.pull(source, snapshot(0.0592))
  assert.equal(before.at(-1).rangeEnd, 0.04)
  assert.throws(() => tracker.finish(source, { ...snapshot(0.0592), sourceEnded: true }), codeIs('CAPTURE_PARTIAL_PRESENTATION'))
  assert.throws(() => tracker.finish(source, { ...snapshot(0.0592), duration: 0.0592, ended: true, sourceEnded: true }), codeIs('CAPTURE_PARTIAL_PRESENTATION'))
  observe(0.06)
  assert.equal(tracker.pull(source, snapshot(0.06)).at(-1).rangeEnd, 0.06)
  assert.equal(tracker.finish(source, { ...snapshot(0.06), sourceEnded: true }).complete, true)
})

test('timestamp comparison accepts roundoff at the real failing durations but rejects a one-picosecond missing tail', () => {
  const { timeAtOrAfter } = load()
  for (const [clock, end] of [[212.981, 212.98100000000002], [223.481, 223.48100000000002]]) {
    assert.equal(timeAtOrAfter(clock, end), true)
    assert.equal(timeAtOrAfter(clock - 1e-12, end), false)
    for (const missing of [0.000000001, 0.000001, 0.0005, 0.0008, 0.001]) assert.equal(timeAtOrAfter(clock - missing, end), false)
  }
  for (const [clock, end] of [[NaN, 0], [Infinity, 1], [1, Infinity], [1, NaN]]) assert.equal(timeAtOrAfter(clock, end), false)
})

test('real decimal EOF regressions publish the final Opus packet in both modes without normalizing its timestamp', () => {
  for (const duration of [212.981, 223.481]) for (const experimental of [false, true]) for (const short of [false, true]) {
    const core = load(), tracker = new core.ProgressiveTracker({ epoch: 1, experimental }), source = tracker.createSource()
    const f = roundedEndFixture(duration), clock = duration - (short ? 1e-12 : 0)
    tracker.append(tracker.createBuffer(source, 'audio/webm; codecs="opus"'), f.bytes)
    const parsed = tracker.inventory(source, true)
    assert.equal(parsed.codedEnd, duration === 212.981 ? 212.98100000000002 : 223.48100000000002)
    for (let position = 0; position < clock; position += 0.25) tracker.observe(source, content, { position, now: position * 1000, duration })
    tracker.observe(source, content, { position: clock, now: clock * 1000, duration })
    const terminal = { source, position: clock, duration, playbackRate: 1, seeking: false, readyState: 4, updating: false, sourceEnded: true, audioRanges: [{ start: 0, end: duration }] }
    if (short) {
      const units = tracker.pull(source, terminal)
      assert.equal(source.progress.emitted.has(f.frames - 1), false, 'a1ps short clock cannot release the final packet')
      assert.ok(units.reduce((count, unit) => count + unit.frames, 0) < f.frames)
      assert.throws(() => tracker.finish(source, terminal), codeIs('CAPTURE_PARTIAL_PRESENTATION'))
    } else {
      assert.equal(tracker.finish(source, terminal).eof, true)
      const units = tracker.pull(source, terminal)
      assert.equal(units.reduce((count, unit) => count + unit.frames, 0), f.frames)
      assert.equal(units.at(-1).rangeEnd, parsed.codedEnd, 'only comparison changes; stored PTS and byte payload stay intact')
      assert.equal(tracker.finish(source, terminal).complete, !experimental, 'experimental1ms initial coded gap is intentionally still incomplete')
      if (!experimental) assert.throws(() => tracker.pull(source, { ...terminal, position: duration - 1e-12 }), codeIs('CAPTURE_PARTIAL_PRESENTATION'))
    }
  }
})

test('AAC native microsecond terminal clock releases its exact last packet only after complete final certification', () => {
  for (const experimental of [false, true]) {
    const { ProgressiveTracker, timeAtOrAfter } = load(), tracker = new ProgressiveTracker({ epoch: 1, experimental }), source = tracker.createSource(), f = nativeFinalAacFixture()
    const buffer = tracker.createBuffer(source, f.mime)
    buffer.native = {}; source.native = { readyState: 'ended' }
    tracker.append(buffer, f.bytes); source.successfulEndOfStream = true
    assert.equal(tracker.inventory(source, true).samples.at(-1).end, 251.73333333333332)
    assert.equal(timeAtOrAfter(f.clock, f.end), false, 'the general comparison must remain strict')
    for (let position = 0; position < f.clock; position += 0.25) tracker.observe(source, content, { position, now: position * 1000, duration: f.clock })
    tracker.observe(source, content, { position: f.clock, now: f.clock * 1000, duration: f.clock })
    const terminal = { source, position: f.clock, duration: f.clock, ended: true, paused: true, seeking: false, playbackRate: 1, readyState: 4, updating: false, sourceEnded: true, successfulEndOfStream: true, sourceReadyState: 'ended', audioRanges: [{ start: 0, end: f.clock }] }
    const before = tracker.pull(source, terminal)
    assert.equal(source.progress.emitted.has(f.frames - 1), false, 'terminal flags alone must never authorize publication')
    assert.equal(source.nativeFinalClock, undefined)
    tracker.finish(source, terminal)
    const after = tracker.pull(source, terminal)
    assert.equal(source.progress.emitted.has(f.frames - 1), true)
    assert.equal([...before, ...after].reduce((sum, unit) => sum + unit.frames, 0), f.frames)
    assert.equal(after.at(-1).rangeEnd, f.end, 'retain rational timestamps and original sample payloads')
    assert.equal(tracker.finish(source, terminal).complete, true)
    const repeated = tracker.pull(source, terminal)
    assert.equal(repeated.length, 0, 'second finish and publication cannot repeat a sample')
    for (const change of [{ ended: false }, { paused: false }, { position: f.clock - 1e-12 }, { duration: f.end }, { audioRanges: [{ start: 0, end: f.end }] }])
      assert.equal(tracker.clockCovers(source, { ...terminal, ...change }, f.end), false, 'proof is tied to the original native terminal snapshot')
    for (const [object, key, value] of [[tracker, 'epoch', 2], [source.progress, 'epoch', 2], [source, 'native', { readyState: 'ended' }], [buffer, 'native', {}], [buffer, 'timelineSettings', { ...buffer.timelineSettings, timestampOffset: 0.000001 }], [source, 'successfulEndOfStream', false]]) {
      const saved = object[key]
      object[key] = value
      assert.equal(tracker.clockCovers(source, terminal, f.end), false, `a changed ${key} cannot reuse terminal permission`)
      object[key] = saved
    }
    source.buffers[0] = { ...buffer }
    assert.equal(tracker.clockCovers(source, terminal, f.end), false, 'a copied buffer is a different captured session')
    source.buffers[0] = buffer
    buffer.version++
    assert.equal(tracker.clockCovers(source, terminal, f.end), false, 'a changed byte inventory revokes the final clock permission')
  }
})

test('native microsecond permission fails closed without every final flag, exact range, clean history and full observations', () => {
  for (const scenario of ['running', 'not-paused', 'no-eof', 'failed-eof', 'source-open', 'duration-different', 'off-grid', 'tail0.8ms', 'tail0.5ms', 'native-range-short', 'late-ad', 'unobserved-tail']) {
    const { ProgressiveTracker } = load(), tracker = new ProgressiveTracker({ epoch: 1 }), source = tracker.createSource(), f = nativeFinalAacFixture()
    const buffer = tracker.createBuffer(source, f.mime)
    buffer.native = {}; source.native = { readyState: 'ended' }
    tracker.append(buffer, f.bytes); source.successfulEndOfStream = true
    const clock = scenario === 'off-grid' ? f.clock - 1e-12 : scenario === 'tail0.8ms' ? f.clock - 0.0008 : scenario === 'tail0.5ms' ? f.clock - 0.0005 : f.clock
    for (let position = 0; position < clock; position += 0.25) tracker.observe(source, content, { position, now: position * 1000, duration: clock })
    tracker.observe(source, scenario === 'late-ad' ? ad : content, { position: clock, now: clock * 1000, duration: clock })
    const terminal = { source, position: clock, duration: clock, ended: scenario !== 'running', paused: scenario !== 'not-paused', seeking: false, playbackRate: 1, readyState: 4, updating: false, sourceEnded: scenario !== 'no-eof', successfulEndOfStream: scenario !== 'failed-eof', sourceReadyState: scenario === 'source-open' ? 'open' : 'ended', audioRanges: [{ start: 0, end: scenario === 'native-range-short' ? f.clock - 0.000002 : f.clock }] }
    if (scenario === 'duration-different') terminal.duration = f.end
    if (scenario === 'unobserved-tail') source.progress.ranges.at(-1).end -= 0.0005
    assert.throws(() => tracker.finish(source, terminal), codeIs(scenario === 'late-ad' ? 'CAPTURE_IDENTITY_UNCERTAIN' : 'CAPTURE_PARTIAL_PRESENTATION'), scenario)
    assert.equal(source.nativeFinalClock, undefined, scenario)
    assert.equal(source.progress.emitted.size, 0, scenario)
  }
})

test('progressive identity ambiguity, buffer mismatch and accelerated presentation cannot release audio', () => {
  for (const identity of [ad, { state: 'unknown', sourceBound: true, signals: [] }]) {
    const { tracker, source, snapshot, observe } = progressiveSetup()
    observe(0); observe(0.02, 20, identity)
    assert.throws(() => tracker.pull(source, snapshot(0.02)), codeIs('CAPTURE_IDENTITY_UNCERTAIN'))
    assert.equal(tracker.coverage.length, 0)
  }
  const { tracker, source, snapshot, observe } = progressiveSetup()
  observe(0); observe(0.02)
  assert.equal(tracker.pull(source, { ...snapshot(0.02), audioRanges: [{ start: 0.03, end: 0.06 }] }).length, 0)
  tracker.observe(source, content, { position: 0.04, now: 30, duration: 0.06, playbackRate: 2 })
  assert.throws(() => tracker.pull(source, snapshot(0.04)), codeIs('CAPTURE_PARTIAL_PRESENTATION'))
})

test('a late site ad marker is a measured counterexample to unconditional progressive zero-ad attribution', t => {
  const { ProgressiveTracker, SessionTracker } = load()
  const delayedMarker = 1.12, trueAdStart = 1, duration = 1.3
  const bytes = fixture({ times: Array.from({ length: 65 }, (_, i) => i * 20) }).bytes
  const tracker = new ProgressiveTracker({ epoch: 1, experimental: true }), source = tracker.createSource(), buffer = tracker.createBuffer(source, 'audio/webm; codecs="opus"')
  tracker.append(buffer, bytes)
  const safe = new ProgressiveTracker({ epoch: 1 }), safeSource = safe.createSource(), safeBuffer = safe.createBuffer(safeSource, 'audio/webm; codecs="opus"')
  safe.append(safeBuffer, bytes)
  const whole = new SessionTracker(), wholeSource = whole.createSource(), wholeBuffer = whole.createBuffer(wholeSource, 'audio/webm; codecs="opus"')
  whole.append(wholeBuffer, bytes)
  const published = [], safePublished = []
  for (let ms = 0; ms <= duration * 1000; ms += 20) {
    const position = ms / 1000, identity = position < delayedMarker ? content : ad
    const observation = { position, now: ms, duration }
    tracker.observe(source, identity, observation)
    safe.observe(safeSource, identity, observation)
    whole.observe(wholeSource, identity, observation)
    if (!source.error) published.push(...tracker.pull(source, { source, ...observation, seeking: false, playbackRate: 1, readyState: 4, updating: false, audioRanges: [{ start: 0, end: duration }] }))
    if (!safeSource.error) safePublished.push(...safe.pull(safeSource, { source: safeSource, ...observation, seeking: false, playbackRate: 1, readyState: 4, updating: false, audioRanges: [{ start: 0, end: duration }] }))
  }
  const contaminated = published.reduce((seconds, unit) => seconds + Math.max(0, unit.rangeEnd - Math.max(unit.rangeStart, trueAdStart)), 0)
  assert(contaminated > 0, 'the fixture must expose the missing semantic bound, not hide it')
  assert.equal(safePublished.length, 0, 'normal mode must not contaminate the native ledger before its complete-source verdict')
  assert.throws(() => whole.seal(wholeSource), codeIs('CAPTURE_IDENTITY_UNCERTAIN'))
  t.diagnostic(`UNSAFE experimental progressive attribution: actual ad starts ${trueAdStart}s, site marker arrives ${delayedMarker}s, ${Math.round(contaminated * 1000)}ms of referenced advertisement already published at 1x. Complete-source gate publishes zero.`)
})

test('normal API3 quarantines until full clean history and native EOF pass before publication', () => {
  const { ProgressiveTracker } = load(), tracker = new ProgressiveTracker({ epoch: 1 }), source = tracker.createSource()
  tracker.append(tracker.createBuffer(source, 'audio/webm; codecs="opus"'), fixture().bytes)
  const snapshot = { source, position: 0.06, duration: 0.06, playbackRate: 1, seeking: false, readyState: 4, updating: false, sourceEnded: true, audioRanges: [{ start: 0, end: 0.06 }] }
  for (const position of [0, 0.02, 0.04, 0.06]) {
    tracker.observe(source, content, { position, duration: 0.06, now: position * 1000 })
    assert.equal(tracker.pull(source, { ...snapshot, position }).length, 0)
  }
  assert.throws(() => tracker.finish(source, { ...snapshot, sourceEnded: false }), codeIs('CAPTURE_PARTIAL_PRESENTATION'))
  assert.equal(tracker.pull(source, snapshot).length, 0)
  tracker.finish(source, snapshot)
  const units = tracker.pull(source, snapshot)
  assert.equal(units.length, 1)
  assert.equal(units[0].rangeStart, 0)
  assert.equal(units[0].rangeEnd, 0.06)
  assert.equal(tracker.finish(source, snapshot).complete, true)
})

function normalQuantizedSetup(times = [0, 21, 41]) {
  const core = load(), tracker = new core.ProgressiveTracker({ epoch: 1 }), source = tracker.createSource()
  const buffer = tracker.createBuffer(source, 'audio/webm; codecs="opus"'), f = fixture({ times })
  tracker.append(buffer, f.bytes)
  const snapshot = { source, position: f.duration, duration: f.duration, playbackRate: 1, seeking: false, readyState: 4, updating: false, sourceEnded: true, audioRanges: [{ start: 0, end: f.duration }] }
  const observe = (position, now = position * 1000, identity = content) => tracker.observe(source, identity, { position, now, duration: f.duration })
  return { ...core, tracker, source, buffer, f, snapshot, observe }
}

test('normal EOF certificate groups codec quantization inside units while every unit boundary stays exact', () => {
  const { tracker, source, buffer, f, snapshot, observe, inspectWebMPrefix } = normalQuantizedSetup([0, 21, 41, 61, 82, 102])
  let strictParses = 0
  const originalParser = buffer.parser
  buffer.parser = bytes => { strictParses++; return originalParser(bytes) }
  observe(0); observe(f.duration)
  assert.equal(tracker.pull(source, snapshot).length, 0, 'complete data and observation alone cannot bypass EOF certification')
  assert.equal(tracker.finish(source, snapshot).complete, false, 'certification does not credit units before publication')
  const certificate = source.completeCertificate
  assert.equal(source.sealed, true)
  const units = tracker.pull(source, snapshot, { maxSeconds: 0.019 })
  assert.deepEqual(Array.from(units, u => u.frames), [2, 1, 2, 1], 'a soft duration limit never splits a quantized boundary')
  for (let i = 1; i < units.length; i++) assert.ok(Math.abs(units[i].rangeStart - units[i - 1].rangeEnd) <= 0.000001)
  assert.deepEqual(Array.from(tracker.coverage, r => ({ ...r })), [{ start: 0, end: f.duration }])
  assert.equal(tracker.finish(source, snapshot).complete, true)
  assert.equal(source.completeCertificate, certificate, 'second finish reuses the immutable certificate instead of sealing twice')
  assert.equal(strictParses, 1)
  assert.equal(tracker.pull(source, snapshot).length, 0, 'each sample remains published once')
  const restored = concat(units[0].data, ...units.slice(1).map(u => u.data.subarray(u.initBytes)))
  const original = inspectWebMPrefix(f.bytes, { final: true }), remuxed = inspectWebMPrefix(restored, { final: true })
  assert.deepEqual(remuxed.codedFrames, original.codedFrames)
  assert.deepEqual(remuxed.samples.map(s => Buffer.from(restored.subarray(s.offset, s.offset + s.size))), original.samples.map(s => Buffer.from(f.bytes.subarray(s.offset, s.offset + s.size))), 'all complete Block payloads remain exact and in order')
  assert.throws(() => tracker.finish(source, { ...snapshot, audioRanges: [{ start: 0.01, end: f.duration }] }), codeIs('CAPTURE_PARTIAL_PRESENTATION'))
  assert.throws(() => tracker.pull(source, { ...snapshot, position: f.duration - 0.0008 }), codeIs('CAPTURE_PARTIAL_PRESENTATION'))
})

test('the same quantized source remains incomplete in experimental progressive mode', () => {
  const { tracker, source, f, snapshot, observe } = normalQuantizedSetup()
  tracker.experimental = true
  observe(0); observe(f.duration)
  const units = tracker.pull(source, snapshot)
  assert.equal(units.length, 2)
  assert.equal(units[0].rangeEnd, 0.02)
  assert.equal(units[1].rangeStart, 0.021)
  assert.equal(tracker.finish(source, snapshot).complete, false)
  assert.equal(source.completeCertificate, undefined)
  assert.equal(source.sealed, false)
})

test('normal codec certification never repairs missing packets, partial observation, identity mixing or epoch holes', () => {
  for (const scenario of ['missing-packet', 'partial', 'ad', 'unknown', 'epoch-gap', 'native-gap']) {
    const { tracker, source, f, snapshot, observe } = normalQuantizedSetup(scenario === 'missing-packet' ? [0, 40] : undefined)
    if (scenario === 'missing-packet') tracker.beginEpoch(2, 0) // Prefix inventory may allow gaps; API2 complete-source parser must still reject them.
    observe(scenario === 'partial' ? 0.0005 : 0)
    if (scenario === 'ad' || scenario === 'unknown') observe(0.02, 20, scenario === 'ad' ? ad : { state: 'unknown', sourceBound: true, signals: [] })
    if (scenario === 'epoch-gap') { observe(0.02); tracker.beginEpoch(2, 0.0205); observe(0.0205, 100) }
    observe(f.duration, scenario === 'epoch-gap' ? 141 : f.duration * 1000)
    const terminal = ['missing-packet', 'native-gap'].includes(scenario) ? { ...snapshot, audioRanges: [{ start: 0, end: 0.02 }, { start: scenario === 'missing-packet' ? 0.04 : 0.021, end: f.duration }] } : snapshot
    const expected = scenario === 'missing-packet' ? 'CAPTURE_AMBIGUOUS_TIMELINE' : ['ad', 'unknown'].includes(scenario) ? 'CAPTURE_IDENTITY_UNCERTAIN' : 'CAPTURE_PARTIAL_PRESENTATION'
    assert.throws(() => tracker.finish(source, terminal), codeIs(expected), scenario)
    assert.equal(source.completeCertificate, undefined, scenario)
    assert.equal(source.progress.emitted.size, 0, scenario)
    assert.equal(tracker.coverage.length, 0, scenario)
  }
})

test('normal publication refuses indivisible oversized chains without crediting earlier prepared units', () => {
  const times = [0, ...Array.from({ length: 20 }, (_, i) => 20 + i * 21)]
  const { tracker, source, f, snapshot, observe, remuxWebM } = normalQuantizedSetup(times)
  observe(0); observe(f.duration)
  tracker.finish(source, snapshot)
  const inventory = tracker.inventory(source), one = remuxWebM(inventory, 0, 1), chain = remuxWebM(inventory, 1, times.length - 1)
  const maxBytes = one.init.length + one.media.length + 10
  assert.ok(chain.init.length + chain.media.length > maxBytes)
  assert.throws(() => tracker.pull(source, snapshot, { maxSeconds: 0.02, maxBytes }), e => e.code === 'CAPTURE_UNIT_LIMIT' && /indivisible/.test(e.message))
  assert.equal(source.progress.emitted.size, 0)
  assert.equal(tracker.coverage.length, 0, 'no range is credited when none of the prepared units was returned')
  assert.equal(tracker.finish(source, snapshot).complete, false)
  const units = tracker.pull(source, snapshot, { maxSeconds: 0.02, maxBytes: 4096 })
  assert.equal(units.length, 2)
  assert.equal(units[0].rangeEnd, units[1].rangeStart)
  assert.equal(units[1].frames, 20)
  assert.equal(tracker.finish(source, snapshot).complete, true)
})

test('a normal complete-source certificate cannot be reused after inventory, source-buffer, settings or epoch changes', () => {
  for (const change of ['version', 'native', 'settings', 'epoch', 'append']) {
    const { tracker, source, buffer, f, snapshot, observe } = normalQuantizedSetup()
    observe(0); observe(f.duration); tracker.finish(source, snapshot)
    if (change === 'version') buffer.version++
    else if (change === 'native') buffer.native = {}
    else if (change === 'settings') buffer.timelineSettings = { ...buffer.timelineSettings, timestampOffset: 1 }
    else if (change === 'epoch') tracker.beginEpoch(2, 0)
    else tracker.append(buffer, Uint8Array.of(0))
    if (change === 'epoch') assert.equal(tracker.pull(source, snapshot).length, 0)
    else assert.throws(() => tracker.pull(source, snapshot), codeIs(change === 'append' ? 'CAPTURE_AMBIGUOUS_SOURCE' : 'CAPTURE_PARTIAL_PRESENTATION'), change)
    assert.equal(source.progress.emitted.size, 0, change)
    assert.equal(tracker.coverage.length, 0, change)
  }
})

test('seek parser reset accepts either fresh split initialization or media with the preserved initialization', () => {
  for (const freshInit of [true, false]) {
    const { tracker, source, buffer } = progressiveSetup()
    tracker.inventory(source)
    tracker.beginEpoch(2, 0.04)
    assert.equal(tracker.onTimeAssignment(source, null, 0.04), true)
    assert.equal(tracker.onSeekMutation(buffer, 'abort'), true)
    const f = fixture({ times: [40, 60, 80] }), bytes = freshInit ? f.bytes : f.cluster
    for (const byte of bytes) tracker.append(buffer, Uint8Array.of(byte))
    const parsed = tracker.inventory(source, true)
    assert.equal(parsed.samples.length, 3)
    assert.equal(parsed.codedStart, 0.04)
    assert.equal(parsed.codedEnd, 0.1)
    assert.equal(source.error, null)
  }
})

test('real AAC/Opus remux retains the identical decoded PCM across many sample boundaries', t => {
  const available = spawnSync('ffmpeg', ['-version'], { windowsHide: true, encoding: 'utf8' })
  if (available.error?.code === 'ENOENT') return t.skip('FFmpeg is not installed; native MSE probes remain a separate required check')
  const ffmpeg = args => {
    const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
    assert.equal(result.status, 0, result.stderr?.toString())
    return new Uint8Array(result.stdout)
  }
  const decode = bytes => {
    const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-map', '0:a', '-f', 'f32le', 'pipe:1'], { input: bytes, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
    assert.equal(result.status, 0, result.stderr?.toString())
    return result.stdout
  }
  for (const format of ['webm', 'mp4']) {
    // AAC duration is an exact multiple of 1024 samples. A fractional final sample
    // table duration is outside the deliberately restricted AAC parser, not a remux fix.
    const source = ffmpeg(['-f', 'lavfi', '-i', `sine=frequency=997:sample_rate=48000:duration=${format === 'mp4' ? 2.048 : 2}`, '-ac', '2', '-c:a', format === 'webm' ? 'libopus' : 'aac', '-b:a', '96k', ...(format === 'mp4' ? ['-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '500000'] : []), '-f', format, 'pipe:1'])
    const core = load(), parser = format === 'webm' ? { inspectPrefix: core.inspectWebMPrefix, remux: core.remuxWebM } : core.context.__musifyCaptureMp4
    const inventory = parser.inspectPrefix(source, { final: true }), media = []
    for (let first = 0, unit = 1; first < inventory.samples.length; first += 5, unit++) media.push(parser.remux(inventory, first, Math.min(5, inventory.samples.length - first), unit).media)
    const actual = decode(concat(inventory.init, ...media)), expected = decode(source)
    assert(expected.length > 48000 * 2 * 4)
    assert.deepEqual(actual, expected, `${format}: decoded samples must be bit-for-bit identical, including beginning and tail`)
    t.diagnostic(`${format}: ${inventory.samples.length} coded samples, ${media.length} progressive units, ${actual.length / (2 * 4)} decoded stereo frames identical`)
    const tracker = new core.ProgressiveTracker({ epoch: 1 }), captured = tracker.createSource()
    tracker.append(tracker.createBuffer(captured, format === 'webm' ? 'audio/webm; codecs="opus"' : 'audio/mp4; codecs="mp4a.40.2"'), source)
    const end = inventory.codedEnd ?? inventory.end
    for (let position = 0; position < end; position += 0.1) tracker.observe(captured, content, { position, now: position * 1000, duration: end })
    tracker.observe(captured, content, { position: end, now: end * 1000, duration: end })
    const terminal = { source: captured, position: end, duration: end, sourceEnded: true, playbackRate: 1, seeking: false, readyState: 4, updating: false, audioRanges: [{ start: 0, end }] }
    tracker.finish(captured, terminal)
    const normalUnits = tracker.pull(captured, terminal, { maxSeconds: 0.09 })
    assert.ok(normalUnits.length > 10)
    assert.equal(tracker.finish(captured, terminal).complete, true)
    const normalDecoded = decode(concat(normalUnits[0].data, ...normalUnits.slice(1).map(unit => unit.data.subarray(unit.initBytes))))
    assert.deepEqual(normalDecoded, expected, `${format}: normal certified grouping must retain exact PCM without duplicating preroll packets`)
    t.diagnostic(`${format}: ${normalUnits.length} normal EOF-certified units, full continuous coverage, identical decoded PCM`)
  }
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
    constructor() { super(); Object.assign(this, { tagName: 'VIDEO', _currentTime: 0, duration: 0.06, readyState: 4, paused: false, seeking: false, ended: false, _playbackRate: 1, _defaultPlaybackRate: 1, nativeRateWrites: [], currentSrc: '', _src: '', _srcObject: null }) }
    get playbackRate() { if (!(this instanceof HTMLMediaElement)) throw new TypeError('Illegal invocation'); return this._playbackRate }
    set playbackRate(value) { if (this.rateThrows) throw new Error('NotSupportedError'); this.nativeRateWrites.push(['playbackRate', value]); this._playbackRate = value }
    get defaultPlaybackRate() { if (!(this instanceof HTMLMediaElement)) throw new TypeError('Illegal invocation'); return this._defaultPlaybackRate }
    set defaultPlaybackRate(value) { if (this.rateThrows) throw new Error('NotSupportedError'); this.nativeRateWrites.push(['defaultPlaybackRate', value]); this._defaultPlaybackRate = value }
    get src() { return this._src }
    set src(value) { this._src = this.currentSrc = value; this._currentTime = 0 }
    get srcObject() { return this._srcObject }
    set srcObject(value) { this._srcObject = value; this._currentTime = 0 }
    get currentTime() { return this._currentTime }
    set currentTime(value) { this._currentTime = value }
    load() { this._currentTime = 0; this._playbackRate = this._defaultPlaybackRate }
    pause() { this.paused = true }
    play() { this.paused = false; return Promise.resolve() }
  }
  let next = 0
  return { MediaSource, SourceBuffer, Element, HTMLMediaElement, URL: { createObjectURL: () => `blob:test-${++next}`, revokeObjectURL() {} } }
}

test('dedicated rate guard clamps both setters before native writes and leaves native getters intact', () => {
  const scope = browserMocks(), { install } = load(), attempts = []
  const original = Object.getOwnPropertyDescriptor(scope.HTMLMediaElement.prototype, 'playbackRate')
  const capture = install({ scope, forcePlaybackRateOne: true, onRateAttempt: (element, attempt) => attempts.push({ element, ...attempt }) })
  const media = new scope.HTMLMediaElement()
  for (const rate of [2, 4, 16, '2']) {
    media.playbackRate = rate; media.defaultPlaybackRate = rate
    assert.equal(media.playbackRate, 1)
    assert.equal(media.defaultPlaybackRate, 1)
  }
  media.load()
  assert.equal(media.playbackRate, 1, 'load must not restore a stored accelerated default')
  assert.ok(media.nativeRateWrites.every(([, value]) => value === 1), 'no interval, however short, applies the requested accelerated rate')
  const guarded = Object.getOwnPropertyDescriptor(scope.HTMLMediaElement.prototype, 'playbackRate')
  assert.equal(guarded.get, original.get)
  assert.equal(guarded.enumerable, original.enumerable)
  assert.equal(guarded.configurable, original.configurable)
  assert.equal(capture.rateStatistics.attempts, 8)
  assert.equal(capture.rateStatistics.corrections, 0)
  assert.ok(attempts.every(a => a.element === media && a.previous === 1 && a.effective === 1 && a.phase === 'setter'))
  assert.throws(() => guarded.set.call({}, 2), /Illegal invocation/)
  for (const invalid of [NaN, Infinity, Symbol('rate'), 2n]) assert.throws(() => { media.playbackRate = invalid }, { name: 'TypeError' })
  media.rateThrows = true
  assert.throws(() => { media.playbackRate = 2 }, /NotSupportedError/)
  assert.equal(attempts.length, 8, 'a failed native write never reports a successful clamp')
})

test('rate guard discloses and synchronously corrects a rate present before installation', () => {
  const scope = browserMocks(), { install } = load(), media = new scope.HTMLMediaElement(), attempts = []
  media.playbackRate = 2; media.defaultPlaybackRate = 4
  scope.document = { querySelectorAll: () => [media] }
  install({ scope, forcePlaybackRateOne: true, onRateAttempt: (_, attempt) => attempts.push(attempt) })
  assert.equal(media.playbackRate, 1)
  assert.equal(media.defaultPlaybackRate, 1)
  assert.deepEqual(attempts.map(a => [a.property, a.previous, a.effective, a.phase]), [['playbackRate', 2, 1, 'installation'], ['defaultPlaybackRate', 4, 1, 'installation']])
  assert.equal(attempts.at(-1).corrections, 2)
  assert.equal(attempts.at(-1).attempts, 0)
})

test('rate guard is opt-in and refuses a runtime that cannot enforce both native setters', () => {
  const scope = browserMocks(), { install } = load()
  install({ scope })
  const media = new scope.HTMLMediaElement()
  media.playbackRate = 2; media.defaultPlaybackRate = 4
  assert.equal(media.playbackRate, 2)
  media.load(); assert.equal(media.playbackRate, 4)
  const unsupported = browserMocks()
  Object.defineProperty(unsupported.HTMLMediaElement.prototype, 'defaultPlaybackRate', { configurable: false })
  assert.throws(() => install({ scope: unsupported, forcePlaybackRateOne: true }), codeIs('CAPTURE_UNSUPPORTED_RATE_CONTROL'))
})

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
  context.window = { __musifyTarget: 'target', __musifyEpoch: 1, __musifyProgressiveExperiment: true, __musifyGeneration: 7, chrome: { webview: { postMessage: (message) => messages.push(JSON.parse(message.slice('musify:'.length))) } } }
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
  context.window = { __musifyTarget: 'target', __musifyEpoch: 1, __musifyProgressiveExperiment: true, __musifyGeneration: 7, chrome: { webview: { postMessage: (m) => messages.push(JSON.parse(m.slice(7))) } } }
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

test('capture clamps stored ad rates and reports identity/source transitions immediately before a heartbeat', async () => {
  const scope = browserMocks(), media = new scope.HTMLMediaElement(), messages = []
  let clock = 0, adShowing = true
  media.playbackRate = 2; media.defaultPlaybackRate = 2
  const player = { contains: e => e === media, getVideoData: () => ({ video_id: 'target', title: 'Song' }), classList: { contains: () => adShowing }, querySelector: () => null, querySelectorAll: s => s === 'audio,video' ? [media] : [] }
  const document = { querySelectorAll: () => [media], querySelector: s => s === '#movie_player' ? player : s === 'ytmusic-player-bar .title' ? { textContent: 'Song' } : null }
  const location = { search: '?v=target', hash: '', hostname: 'music.youtube.com' }
  const { context } = load({ ...scope, document, location, performance: { now: () => clock }, setInterval: () => 1, clearInterval() {}, MutationObserver: class { observe() {} } })
  context.window = { __musifyTarget: 'target', __musifyEpoch: 1, __musifyGeneration: 31, chrome: { webview: { postMessage: m => messages.push(JSON.parse(m.slice(7))) } } }
  vm.runInContext(orchestratorCode, context)
  assert.equal(media.playbackRate, 1)
  assert.equal(media.defaultPlaybackRate, 1)
  media.nativeRateWrites = []
  const ad = new scope.MediaSource(); ad.addSourceBuffer('audio/webm; codecs="opus"')
  media.src = scope.URL.createObjectURL(ad)
  media.dispatchEvent(new Event('playing'))
  for (const rate of [2, 4, 16]) { media.playbackRate = rate; media.defaultPlaybackRate = rate }
  clock = 50; media._currentTime = 0.05; media.dispatchEvent(new Event('timeupdate'))
  clock = 60; media._currentTime = 0.06; media.ended = true; media.paused = true
  media.dispatchEvent(new Event('ended'))
  const song = new scope.MediaSource(); song.addSourceBuffer('audio/webm; codecs="opus"')
  media.src = scope.URL.createObjectURL(song); adShowing = false; clock = 75; media.ended = false; media.paused = false
  media.dispatchEvent(new Event('playing'))
  media.dispatchEvent(new Event('timeupdate'))
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(media.nativeRateWrites.every(([, value]) => value === 1))
  const diagnostics = messages.filter(m => m.type === 'diagnostic')
  const guards = diagnostics.filter(m => m.reason?.includes('rate-guard'))
  assert.equal(guards.length, 8)
  assert.ok(guards.every(m => m.playbackRate === 1))
  assert.equal(guards.filter(m => JSON.parse(m.reason).operation === 'installation').length, 2)
  assert.equal(guards.filter(m => JSON.parse(m.reason).previous === 2).length, 2, 'pre-installation acceleration is disclosed, never erased retrospectively')
  const transitions = diagnostics.filter(m => m.reason?.includes('identity-transition'))
  assert.equal(transitions.length, 2)
  assert.deepEqual(transitions.map(m => [m.state, m.position, m.browserNow]), [['ad', 0, 0], ['content', 0, 75]])
  const prior = JSON.parse(transitions[1].reason).previous
  assert.equal(prior.state, 'ad'); assert.equal(prior.position, 0.06); assert.equal(prior.browserNow, 60)
  assert.notEqual(transitions[0].source, transitions[1].source)
  const tail = diagnostics.filter(m => /ad-before-detach|ad-native-ended/.test(m.reason ?? ''))
  assert.equal(tail.length, 2)
  assert.ok(tail.every(m => m.state === 'ad' && m.source === transitions[0].source && m.position === 0.06 && m.browserNow === 60))
  assert.ok(diagnostics.filter(m => m.state === 'ad').every(m => m.playbackRate === 1))
  assert.equal(messages.some(m => m.kind === 'seg'), false)
  assert.equal(messages.some(m => m.type === 'error'), false)
})

test('an initially missed two milliseconds are re-presented from zero before any publication', async () => {
  const scope = browserMocks(), media = new scope.HTMLMediaElement(), messages = []
  let clock = 0
  const player = { contains: e => e === media, getVideoData: () => ({ video_id: 'target', title: 'Song' }), classList: { contains: () => false }, querySelector: () => null, querySelectorAll: s => s === 'audio,video' ? [media] : [] }
  const document = { querySelectorAll: () => [media], querySelector: s => s === '#movie_player' ? player : s === 'ytmusic-player-bar .title' ? { textContent: 'Song' } : null }
  const location = { search: '?v=target', hash: '', hostname: 'music.youtube.com', replace() {} }
  class FileReader { async readAsDataURL(blob) { this.result = 'data:audio/webm;base64,' + Buffer.from(await blob.arrayBuffer()).toString('base64'); this.onload() } }
  const { context } = load({ ...scope, document, location, Blob, FileReader, performance: { now: () => clock }, setInterval: () => 1, clearInterval() {}, MutationObserver: class { observe() {} } })
  context.window = { __musifyTarget: 'target', __musifyEpoch: 1, __musifyGeneration: 30, __musifyProgressiveExperiment: true, chrome: { webview: { postMessage: m => messages.push(JSON.parse(m.slice(7))) } } }
  vm.runInContext(orchestratorCode, context)
  const source = new scope.MediaSource(), buffer = source.addSourceBuffer('audio/webm; codecs="opus"')
  media.src = scope.URL.createObjectURL(source)
  buffer.buffered = { length: 1, start: () => 0, end: () => 0.06 }
  buffer.appendBuffer(fixture().bytes)
  clock = 2; media._currentTime = 0.002
  media.dispatchEvent(new Event('playing'))
  assert.equal(media.currentTime, 0)
  assert.equal(media.paused, true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(messages.some(m => m.kind === 'seg'), false)
  media.dispatchEvent(new Event('seeked'))
  clock = 24; media._currentTime = 0.02
  media.dispatchEvent(new Event('timeupdate'))
  await new Promise(resolve => setImmediate(resolve))
  const units = messages.filter(m => m.kind === 'seg')
  assert.equal(units.length, 1)
  assert.equal(units[0].rangeStart, 0)
  assert.equal(units[0].rangeEnd, 0.02)
  assert.equal(units[0].verified, true)
  assert.equal(messages.some(m => m.type === 'error'), false)
})

test('orchestrator EOF and normal certificate share the roundoff-only comparison for the two real failing durations', async () => {
  for (const duration of [212.981, 223.481]) for (const short of [false, true]) {
    const scope = browserMocks(), media = new scope.HTMLMediaElement(), messages = [], f = roundedEndFixture(duration)
    let clock = 0
    media.duration = duration
    const player = { contains: e => e === media, getVideoData: () => ({ video_id: 'target', title: 'Song' }), classList: { contains: () => false }, querySelector: () => null, querySelectorAll: s => s === 'audio,video' ? [media] : [] }
    const document = { querySelectorAll: () => [media], querySelector: s => s === '#movie_player' ? player : s === 'ytmusic-player-bar .title' ? { textContent: 'Song' } : null }
    const location = { search: '?v=target', hash: '', hostname: 'music.youtube.com' }
    class FileReader { async readAsDataURL(blob) { this.result = 'data:audio/webm;base64,' + Buffer.from(await blob.arrayBuffer()).toString('base64'); this.onload() } }
    const { context } = load({ ...scope, document, location, Blob, FileReader, performance: { now: () => clock }, setInterval: () => 1, clearInterval() {}, MutationObserver: class { observe() {} } })
    context.window = { __musifyTarget: 'target', __musifyEpoch: 1, __musifyGeneration: 32, chrome: { webview: { postMessage: m => messages.push(JSON.parse(m.slice(7))) } } }
    vm.runInContext(orchestratorCode, context)
    const source = new scope.MediaSource(), buffer = source.addSourceBuffer('audio/webm; codecs="opus"')
    media.src = scope.URL.createObjectURL(source)
    buffer.buffered = { length: 1, start: () => 0, end: () => duration }
    buffer.appendBuffer(f.bytes)
    media.dispatchEvent(new Event('playing'))
    const position = duration - (short ? 1e-12 : 0)
    for (let at = 0.25; at < position; at += 0.25) { clock = at * 1000; media._currentTime = at; media.dispatchEvent(new Event('timeupdate')) }
    source.endOfStream()
    clock = position * 1000; media._currentTime = position; media.ended = true; media.paused = true
    media.dispatchEvent(new Event('ended'))
    for (let attempts = 0; attempts < 10 && !messages.some(m => m.type === 'ended' || m.type === 'error'); attempts++) await new Promise(resolve => setImmediate(resolve))
    const error = messages.find(m => m.type === 'error'), ended = messages.find(m => m.type === 'ended'), units = messages.filter(m => m.kind === 'seg')
    if (short) {
      assert.equal(error?.code, 'CAPTURE_UNPRESENTED_BYTES')
      assert.equal(ended, undefined)
      assert.equal(units.length, 0)
    } else {
      assert.equal(error, undefined)
      assert.equal(ended?.eof, true)
      assert.equal(ended?.complete, true)
      assert.equal(units.reduce((count, unit) => count + unit.frames, 0), f.frames)
      assert.equal(units.at(-1).rangeEnd, duration === 212.981 ? 212.98100000000002 : 223.48100000000002)
    }
  }
})

test('orchestrator publishes the final AAC packet at a certified native microsecond endpoint in both modes', async () => {
  for (const experimental of [false, true]) {
    const scope = browserMocks(), media = new scope.HTMLMediaElement(), messages = [], f = nativeFinalAacFixture()
    let now = 0
    media.duration = f.clock
    const player = { contains: e => e === media, getVideoData: () => ({ video_id: 'target', title: 'Song' }), classList: { contains: () => false }, querySelector: () => null, querySelectorAll: s => s === 'audio,video' ? [media] : [] }
    const document = { querySelectorAll: () => [media], querySelector: s => s === '#movie_player' ? player : s === 'ytmusic-player-bar .title' ? { textContent: 'Song' } : null }
    const location = { search: '?v=target', hash: '', hostname: 'music.youtube.com' }
    class FileReader { async readAsDataURL(blob) { this.result = 'data:audio/mp4;base64,' + Buffer.from(await blob.arrayBuffer()).toString('base64'); this.onload() } }
    const { context } = load({ ...scope, document, location, Blob, FileReader, performance: { now: () => now }, setInterval: () => 1, clearInterval() {}, MutationObserver: class { observe() {} } })
    context.window = { __musifyTarget: 'target', __musifyEpoch: 1, __musifyGeneration: 33, __musifyProgressiveExperiment: experimental, chrome: { webview: { postMessage: m => messages.push(JSON.parse(m.slice(7))) } } }
    vm.runInContext(orchestratorCode, context)
    const source = new scope.MediaSource(), buffer = source.addSourceBuffer(f.mime)
    media.src = scope.URL.createObjectURL(source)
    buffer.buffered = { length: 1, start: () => 0, end: () => f.clock }
    buffer.appendBuffer(f.bytes)
    media.dispatchEvent(new Event('playing'))
    for (let at = 0.25; at < f.clock; at += 0.25) { now = at * 1000; media._currentTime = at; media.dispatchEvent(new Event('timeupdate')) }
    source.endOfStream()
    now = f.clock * 1000; media._currentTime = f.clock
    media.dispatchEvent(new Event('timeupdate')) // Still playing: no microsecond permission.
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(messages.some(m => m.type === 'ended' || m.type === 'error'), false)
    assert.equal(messages.some(m => m.kind === 'seg' && m.rangeEnd === f.end), false)
    media.ended = true; media.paused = true; media.dispatchEvent(new Event('ended'))
    for (let attempts = 0; attempts < 10 && !messages.some(m => m.type === 'ended' || m.type === 'error'); attempts++) await new Promise(resolve => setImmediate(resolve))
    const error = messages.find(m => m.type === 'error'), ended = messages.find(m => m.type === 'ended'), units = messages.filter(m => m.kind === 'seg')
    assert.equal(error, undefined)
    assert.equal(ended?.eof, true)
    assert.equal(ended?.complete, true)
    assert.equal(ended?.end, f.end)
    assert.equal(ended?.duration, f.clock)
    assert.equal(units.reduce((sum, unit) => sum + unit.frames, 0), f.frames)
    assert.equal(units.at(-1).rangeEnd, f.end)
    assert.equal(units.at(-1).verified, true)
  }
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
  context.window = { __musifyTarget: 'target', __musifyEpoch: 1, __musifyProgressiveExperiment: true, __musifyGeneration: 8, chrome: { webview: { postMessage: (m) => messages.push(JSON.parse(m.slice(7))) } }, addEventListener(type, fn, capture) { if (type === 'ended') { assert.equal(capture, true); capturedEnded = fn } } }
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
  media.playbackRate = 2; media.defaultPlaybackRate = 2
  await new Promise((resolve) => setImmediate(resolve))
  const proofIndex = messages.findIndex((m) => m.type === 'diagnostic' && m.verified)
  const segments = messages.filter((m) => m.kind === 'seg')
  assert.ok(proofIndex >= 0 && proofIndex < messages.findIndex((m) => m.kind === 'seg'))
  assert.deepEqual(messages[proofIndex].timelineSettings, { timestampOffset: 0, appendWindowStart: 0, appendWindowEnd: null, mode: 'segments' })
  assert.equal(segments.length, 1, 'a remuxed unit includes init plus only its selected samples')
  for (const segment of segments) {
    assert.equal(segment.source, messages[proofIndex].source)
    assert.equal(segment.s, messages[proofIndex].s)
    assert.equal(segment.classification, 'content')
    assert.equal(segment.generation, 8)
    assert.equal(segment.api, 3)
    assert.equal(segment.epoch, 1)
  }
  assert.deepEqual(Buffer.concat(segments.map((m) => Buffer.from(m.data, 'base64'))), Buffer.from(f.bytes))
  assert.equal(messages.at(-1).type, 'ended')
  assert.equal(messages.at(-1).duration, 0.06)
  assert.equal(messages.at(-1).source, segments[0].source)
  assert.equal(messages.at(-1).s, segments[0].s)
  assert.ok(messages.every((m, i) => i === 0 || m.sequence > messages[i - 1].sequence))
  assert.deepEqual(navigations, [], 'native ownership retains the window for later seeks')
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
    context.window = { __musifyTarget: 'target', __musifyEpoch: 1, __musifyProgressiveExperiment: true, __musifyGeneration: 12, chrome: { webview: { postMessage: (m) => messages.push(JSON.parse(m.slice(7))) } } }
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
    context.window = { __musifyTarget: 'target', __musifyEpoch: 1, __musifyProgressiveExperiment: true, __musifyGeneration: 13, chrome: { webview: { postMessage: m => messages.push(JSON.parse(m.slice(7))) } } }
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
      assert.equal(messages.some(m => m.type === 'ended'), false, scenario)
      const units = messages.filter(m => m.kind === 'seg')
      if (['short', 'synthetic-ended', 'range-mismatch'].includes(scenario)) {
        assert.ok(units.length, 'a verified prefix is useful before completion')
        assert.ok(units.every(m => m.rangeEnd <= (scenario === 'synthetic-ended' ? 0.06 : 0.04)))
      } else assert.equal(units.length, 0)
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
    context.window = { __musifyTarget: 'target', __musifyEpoch: 1, __musifyProgressiveExperiment: true, __musifyGeneration: 14, chrome: { webview: { postMessage: m => messages.push(JSON.parse(m.slice(7))) } } }
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
      assert.equal(messages.at(-1).eof, true)
      assert.equal(messages.at(-1).complete, true)
      assert.ok(messages.some(m => m.type === 'diagnostic' && m.reason?.includes('terminal identity=ad')))
    } else {
      assert.equal(messages.some(m => m.type === 'ended'), false, scenario)
      assert.ok(messages.filter(m => m.kind === 'seg').every(m => m.rangeEnd <= 0.04), 'later ambiguity cannot release a new unconfirmed tail')
      assert.ok(messages.some(m => m.type === 'error'), scenario)
    }
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
  context.window = { __musifyTarget: 'target', __musifyEpoch: 1, __musifyProgressiveExperiment: true, __musifyGeneration: 11, chrome: { webview: { postMessage: (m) => messages.push(JSON.parse(m.slice(7))) } } }
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
  context.window = { __musifyTarget: 'target', __musifyEpoch: 1, __musifyProgressiveExperiment: true, __musifyGeneration: 9, chrome: { webview: { postMessage: (m) => messages.push(JSON.parse(m.slice(7))) } } }
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
  context.window = { __musifyTarget: 'target', __musifyEpoch: 1, __musifyProgressiveExperiment: true, __musifyGeneration: 10, chrome: { webview: { postMessage: (m) => messages.push(JSON.parse(m.slice(7))) } } }
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
