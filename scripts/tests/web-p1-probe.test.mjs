import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

// Execute both the real parent module and its real serialized srcdoc bridge.
// Timers/media/DOM are simulated: these tests do not claim browser codec, CORS,
// sound, complete-file, physical-phone or background playback validation.
const code = ts.transpileModule(await readFile(new URL('../../web-port/youtube-p1-probe.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText
const fixture = 'https://r1.googlevideo.com/videoplayback?expire=4102444800&itag=140&clen=8192&mime=audio%2Fmp4&sig=good_signature&n=good_n'
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
const message = (target, source, data, origin = 'null') => {
  const event = new Event('message')
  Object.defineProperties(event, { source: { value: source }, data: { value: data }, origin: { value: origin } })
  target.dispatchEvent(event)
}

function harness({ plan = () => ({ after: 0, duration: 209.159 }), runBridge = true, onAppend } = {}) {
  const page = new EventTarget(), frames = [], audios = [], operations = [], timers = new Map()
  let now = 0, sequence = 0
  const schedule = (owner, fn, delay) => { const id = ++sequence; timers.set(id, { at: now + delay, fn, owner }); return id }
  const cancel = id => timers.delete(id)
  class Clock extends Date { static now() { return 1_800_000_000_000 + now } }
  const document = {
    createElement(name) {
      assert.equal(name, 'iframe')
      const child = new EventTarget(), attributes = {}, frame = {
        contentWindow: child, attributes, isConnected: false,
        setAttribute(key, value) { attributes[key] = value },
        remove() {
          operations.push({ type: 'remove-frame', at: now })
          this.isConnected = false
          const index = frames.indexOf(this); if (index >= 0) frames.splice(index, 1)
          // Browser teardown destroys this browsing context, its timers and
          // unplayed media even when its script cannot acknowledge an abort.
          for (const [id, timer] of timers) if (timer.owner === this) timers.delete(id)
          for (const audio of audios.filter(audio => audio.frame === this)) audio.destroy()
        },
      }
      const parent = { postMessage(data) { if (frame.isConnected) message(page, child, data) } }
      child.postMessage = data => { if (frame.isConnected) message(child, parent, data, 'https://app.example') }
      frame.run = () => {
        class Audio extends EventTarget {
          src = ''
          duration = NaN
          paused = true
          listeners = new Map()
          plays = 0
          frame = frame
          constructor() { super(); audios.push(this); operations.push({ type: 'new-probe', at: now }) }
          addEventListener(name, listener) { super.addEventListener(name, listener); this.listeners.set(name, (this.listeners.get(name) ?? 0) + 1) }
          removeEventListener(name, listener) { super.removeEventListener(name, listener); this.listeners.set(name, Math.max(0, (this.listeners.get(name) ?? 0) - 1)) }
          play() { this.plays++; assert.fail('metadata probe must never call play') }
          pause() { this.paused = true; operations.push({ type: 'pause-probe', at: now }) }
          removeAttribute(name) { if (name === 'src') { this.src = ''; operations.push({ type: 'remove-src', at: now }) } }
          load() {
            operations.push({ type: 'load-probe', src: this.src, at: now })
            if (!this.src) return
            const action = plan(this, audios.length - 1)
            if (!action) return
            schedule(frame, () => {
              if (!frame.isConnected) return
              if (action.error) this.dispatchEvent(new Event('error'))
              else { this.duration = action.duration; this.dispatchEvent(new Event('loadedmetadata')) }
            }, action.after ?? 0)
          }
          destroy() { this.paused = true; this.src = ''; for (const key of this.listeners.keys()) this.listeners.set(key, 0) }
        }
        const js = frame.srcdoc.slice(frame.srcdoc.indexOf('<script>') + 8, frame.srcdoc.lastIndexOf('</script>'))
        new Function('Audio', 'window', 'parent', 'setTimeout', 'clearTimeout', 'performance', js)(Audio, child, parent,
          (fn, delay) => schedule(frame, fn, delay), cancel, { now: () => now })
      }
      return frame
    },
    body: { append(frame) { frame.isConnected = true; frames.push(frame); if (runBridge) frame.run(); onAppend?.(frame) } },
  }
  const api = {}
  new Function('exports', 'window', 'document', 'setTimeout', 'clearTimeout', 'Date', code)(api, page, document,
    (fn, delay) => schedule('parent', fn, delay), cancel, Clock)
  const runDue = async target => {
    await flush()
    for (;;) {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!next || next[1].at > target) break
      now = Math.max(now, next[1].at); timers.delete(next[0]); next[1].fn(); await flush()
    }
    now = Math.max(now, target); await flush()
  }
  return { ...api, page, frames, audios, operations, timers, get now() { return now },
    advance: ms => runDue(now + ms), jump: async ms => { now += ms; await runDue(now) },
    send(frame, data, source = frame.contentWindow, origin = 'null') { message(page, source, data, origin) },
    args(frame = frames[0]) { const source = frame.srcdoc; return JSON.parse(source.slice(source.lastIndexOf(')(') + 2, source.lastIndexOf(')</script>'))) },
  }
}

test('metadata success unloads the unplayed isolated probe before returning the duration', async () => {
  const h = harness(), promise = h.probeP1Audio(fixture, 209), frame = h.frames[0]
  assert.equal(frame.sandbox, 'allow-scripts')
  assert.equal(frame.referrerPolicy, 'no-referrer')
  assert.equal(frame.attributes.allow, "autoplay 'none'")
  assert.match(frame.srcdoc, /default-src 'none'/)
  assert.match(frame.srcdoc, /media-src https:\/\/r1\.googlevideo\.com;/)
  assert.doesNotMatch(frame.srcdoc, /allow-same-origin|unsafe-eval|\.play\(/)
  const audio = h.audios[0]
  assert.equal(audio.autoplay, false); assert.equal(audio.defaultMuted, true); assert.equal(audio.muted, true); assert.equal(audio.volume, 0); assert.equal(audio.preload, 'metadata')
  await h.advance(0)
  assert.deepEqual(await promise, { duration: 209.159 })
  assert.equal(audio.plays, 0); assert.equal(audio.paused, true); assert.equal(audio.src, '')
  assert.deepEqual([...audio.listeners.values()], [0, 0])
  assert.equal(h.frames.length, 0); assert.equal(h.timers.size, 0)
  const removed = h.operations.findIndex(op => op.type === 'remove-src'), destroyed = h.operations.findIndex(op => op.type === 'remove-frame')
  assert.ok(removed >= 0 && destroyed > removed)
})

test('WebM metadata uses the same muted opaque probe and tears down without playing', async () => {
  const h = harness(), value = fixture.replace('itag=140', 'itag=251').replace('mime=audio%2Fmp4', 'mime=audio%2Fwebm')
  const promise = h.probeP1Audio(value, 209)
  assert.equal(h.audios[0].src, value)
  assert.equal(h.audios[0].muted, true); assert.equal(h.audios[0].volume, 0)
  assert.doesNotMatch(h.frames[0].srcdoc, /\.play\(/)
  await h.advance(0); assert.deepEqual(await promise, { duration: 209.159 })
  assert.equal(h.audios[0].plays, 0); assert.equal(h.audios[0].src, '')
  assert.equal(h.frames.length, 0); assert.equal(h.timers.size, 0)
})

test('a CDN that becomes metadata-readable is retried at bounded absolute slots without playing', async () => {
  const h = harness({ plan: (audio, index) => {
    assert.ok(h.audios.filter(other => other !== audio).every(other => !other.src && other.paused), 'previous probe must be unloaded before creating a new one')
    return index < 4 ? { after: 0, error: true } : { after: 0, duration: 209 }
  } })
  const promise = h.probeP1Audio(fixture, 209)
  await h.advance(7000)
  assert.deepEqual(await promise, { duration: 209 })
  assert.deepEqual(h.operations.filter(op => op.type === 'new-probe').map(op => op.at), [0, 500, 1500, 3500, 6000])
  assert.equal(h.audios.reduce((sum, a) => sum + a.plays, 0), 0)
  assert.ok(h.audios.every(a => !a.src && a.paused)); assert.equal(h.frames.length, 0)
})

test('media errors do not become absence or a claimed HTTP status, and at most five attempts run', async () => {
  const h = harness({ plan: () => ({ after: 0, error: true }) })
  const failure = assert.rejects(h.probeP1Audio(fixture, 209), error => error instanceof h.P1ProbeError && error.code === 'network' && !/403|429|retirad/.test(error.message))
  await h.advance(8000); await failure
  assert.equal(h.audios.length, 5); assert.equal(h.frames.length, 0); assert.equal(h.timers.size, 0)
})

test('per-attempt timeout skips already elapsed slots and respects the overall bound', async () => {
  const h = harness({ plan: () => null })
  const failure = assert.rejects(h.probeP1Audio(fixture, null), error => error.code === 'timeout')
  await h.advance(8000); await failure
  assert.deepEqual(h.operations.filter(op => op.type === 'new-probe').map(op => op.at), [0, 1500, 3500, 6000])
  assert.equal(h.frames.length, 0); assert.equal(h.timers.size, 0)
})

test('a suspended renderer skips expired retries instead of sending a burst', async () => {
  const h = harness({ plan: (_audio, index) => index === 0 ? { after: 0, error: true } : { after: 0, duration: 209 } })
  const promise = h.probeP1Audio(fixture, 209)
  await h.jump(2000); await h.advance(2000)
  assert.deepEqual(await promise, { duration: 209 })
  assert.deepEqual(h.operations.filter(op => op.type === 'new-probe').map(op => op.at), [0, 3500])
})

test('a renderer resuming beyond the deadline cannot report a late successful attempt', async () => {
  const h = harness({ plan: () => ({ after: 0, error: true }) })
  const failure = assert.rejects(h.probeP1Audio(fixture, 209), error => error.code === 'timeout')
  await h.jump(9000); await failure
  assert.equal(h.audios.length, 1); assert.equal(h.frames.length, 0); assert.equal(h.timers.size, 0)
})

test('invalid, ambiguous or implausible media duration fails immediately without retrying', async () => {
  for (const duration of [NaN, Infinity, 0, -1, 604801, 213, 205]) {
    const h = harness({ plan: () => ({ after: 0, duration }) })
    const failure = assert.rejects(h.probeP1Audio(fixture, 209), error => error.code === 'response')
    await h.advance(0); await failure
    assert.equal(h.audios.length, 1); assert.equal(h.frames.length, 0); assert.equal(h.timers.size, 0)
  }
  const h = harness({ plan: () => ({ duration: 30.9 }) }), promise = h.probeP1Audio(fixture, 30)
  await h.advance(0); assert.deepEqual(await promise, { duration: 30.9 })
})

test('cancellation before mount, during metadata, or between retries unloads and preserves AbortError', async () => {
  const pre = harness(), already = new AbortController(), reason = new DOMException('User moved on', 'AbortError')
  already.abort(reason)
  await assert.rejects(pre.probeP1Audio(fixture, 209, already.signal), error => error === reason)
  assert.equal(pre.frames.length, 0); assert.equal(pre.audios.length, 0)
  for (const between of [false, true]) {
    const h = harness({ plan: () => between ? { after: 0, error: true } : { after: 1400, duration: 209 } }), controller = new AbortController()
    const failure = assert.rejects(h.probeP1Audio(fixture, 209, controller.signal), error => error === reason)
    if (between) await h.advance(0)
    controller.abort(reason); await failure
    assert.equal(h.frames.length, 0); assert.equal(h.timers.size, 0)
    assert.ok(h.audios.every(audio => audio.src === '' && audio.paused && audio.plays === 0))
    await h.advance(8000); assert.equal(h.audios.length, 1)
  }
})

test('a bridge that never starts is bounded and cancellation does not wait for its deadline', async () => {
  const h = harness({ runBridge: false }), controller = new AbortController()
  const failure = assert.rejects(h.probeP1Audio(fixture, 209, controller.signal), { name: 'AbortError' })
  controller.abort(); await h.advance(32); await failure
  assert.equal(h.frames.length, 0); assert.equal(h.timers.size, 0)
  const frozen = harness({ runBridge: false }), timeout = assert.rejects(frozen.probeP1Audio(fixture, 209), error => error.code === 'timeout')
  await frozen.advance(8000); await timeout
  assert.equal(frozen.frames.length, 0); assert.equal(frozen.timers.size, 0)
})

test('cancellation during mount or with an unresponsive bridge cannot retain media or replace AbortError at deadline', async () => {
  const controller = new AbortController(), reason = new DOMException('Changed queue', 'AbortError')
  const mounting = harness({ plan: () => null, onAppend: () => controller.abort(reason) })
  await assert.rejects(mounting.probeP1Audio(fixture, 209, controller.signal), error => error === reason)
  assert.equal(mounting.frames.length, 0); assert.equal(mounting.timers.size, 0)
  assert.ok(mounting.operations.findIndex(op => op.type === 'remove-src') < mounting.operations.findIndex(op => op.type === 'remove-frame'))
  const h = harness({ plan: () => null }), blocked = new AbortController()
  const failure = assert.rejects(h.probeP1Audio(fixture, 209, blocked.signal), error => error === reason)
  h.frames[0].contentWindow.postMessage = () => {}
  blocked.abort(reason); await h.advance(32); await failure
  assert.ok(h.audios.every(audio => !audio.src && audio.paused)); assert.equal(h.frames.length, 0); assert.equal(h.timers.size, 0)
  const late = harness({ runBridge: false }), near = new AbortController()
  const cancelled = assert.rejects(late.probeP1Audio(fixture, 209, near.signal), error => error === reason)
  await late.advance(7990); near.abort(reason); await late.advance(10); await cancelled
  assert.equal(late.frames.length, 0); assert.equal(late.timers.size, 0)
})

test('messages must come from this opaque frame and match the request; malformed result is rejected', async () => {
  const h = harness({ runBridge: false }), promise = h.probeP1Audio(fixture, 209), frame = h.frames[0], args = h.args(frame)
  const result = { type: args.message, requestId: args.requestId, duration: 209 }
  h.send(frame, result, {}); h.send(frame, result, frame.contentWindow, 'https://evil.example'); h.send(frame, { ...result, requestId: args.requestId + 1 })
  await flush(); assert.equal(h.frames.length, 1)
  h.send(frame, result); assert.deepEqual(await promise, { duration: 209 }); assert.equal(h.frames.length, 0)
  const bad = harness({ runBridge: false }), failure = assert.rejects(bad.probeP1Audio(fixture, 209), error => error.code === 'response'), badFrame = bad.frames[0], badArgs = bad.args(badFrame)
  bad.send(badFrame, { type: badArgs.message, requestId: badArgs.requestId, duration: 209, error: 'network' }); await failure
  assert.equal(bad.frames.length, 0)
})

test('bad URL/parameters and invalid expected durations fail before creating an iframe', async () => {
  for (const value of [fixture.replace('https:', 'http:'), fixture.replace('r1.googlevideo.com', 'googlevideo.com.evil.example'),
    fixture.replace('r1.googlevideo.com', 'user@r1.googlevideo.com'), fixture.replace('/videoplayback?', '/other?'), fixture + '#fragment',
    fixture + '&expire=4102444800', fixture + '&sig=duplicate', fixture + '&signature=conflict', fixture + '&n=', fixture + '&x=%0Aheader', fixture + '&dur=NaN',
    fixture.replace('expire=4102444800', 'expire=1'), fixture.replace('mime=audio%2Fmp4', 'mime=video%2Fmp4'),
    fixture.replace('mime=audio%2Fmp4', 'mime=video%2Fwebm'), fixture.replace('mime=audio%2Fmp4', 'mime=audio%2Fogg'), fixture.replace('clen=8192', 'clen=NaN'),
    ' ' + fixture, fixture.replace('sig=good_signature', 'sig=%3Cscript%3E')]) {
    const h = harness(); await assert.rejects(h.probeP1Audio(value, 209), error => error.code === 'response'); assert.equal(h.frames.length, 0)
  }
  for (const duration of [undefined, NaN, Infinity, 0, -1, 604801, '209']) {
    const h = harness(); await assert.rejects(h.probeP1Audio(fixture, duration), error => error.code === 'response'); assert.equal(h.frames.length, 0)
  }
})

test('concurrent independent probes do not cancel or accept messages for one another', async () => {
  const h = harness({ runBridge: false }), firstController = new AbortController()
  const first = assert.rejects(h.probeP1Audio(fixture, 209, firstController.signal), { name: 'AbortError' })
  const second = h.probeP1Audio(fixture.replace('n=good_n', 'n=other_n'), 209), secondFrame = h.frames[1], args = h.args(secondFrame)
  firstController.abort(); await h.advance(32); await first
  assert.equal(h.frames.length, 1)
  h.send(secondFrame, { type: args.message, requestId: args.requestId, duration: 209 }); assert.deepEqual(await second, { duration: 209 })
  assert.equal(h.frames.length, 0); assert.equal(h.timers.size, 0)
})
