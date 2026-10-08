// Diagnóstico de v0.10.0: node --test scripts/tests/forum-playback.test.mjs
// Ejecuta player.svelte.ts real. IPC, Audio y reloj son controlados; no prueba YouTube ni códecs reales.
// Los casos marcados REGRESSION expresan el comportamiento esperado y fallan si el hueco sigue presente.
import assert from 'node:assert/strict'
import test from 'node:test'
import { deferred, flush, harness, item, playable } from './helpers/player-harness.mjs'

function start(audio) {
  audio.paused = false
  audio.dispatchEvent(new Event('playing'))
  return Promise.resolve()
}

function progress(audio, seconds) {
  audio.currentTime = seconds
  audio.dispatchEvent(new Event('timeupdate'))
}

test('slow resolution and slow audio can each finish just before their separate deadlines', async () => {
  const resolution = deferred()
  const playback = deferred()
  const h = harness({ resolve: () => resolution.promise, play: () => playback.promise })
  h.player.playQueue([item()], 0)
  await h.advance(119_999)
  assert.equal(h.player.status, 'loading')
  assert.equal(h.sources.length, 0)
  resolution.resolve(playable())
  await flush()
  await h.advance(29_999)
  assert.equal(h.player.status, 'loading')
  start(h.audios.at(-1))
  playback.resolve()
  await flush()
  await h.advance(10_000)
  assert.equal(h.player.status, 'playing')
  assert.deepEqual(h.sources, ['https://audio.test/1'])
  assert.deepEqual(h.messages, [])
  assert.equal(h.timers.size, 1, 'startup deadlines are cleared; the progress watchdog remains')
})

test('a timed-out song advances once, and late resolution cannot replace the next song', async () => {
  const slow = deferred()
  const h = harness({ resolve: (track) => track.id === 1 ? slow.promise : Promise.resolve(playable(track.id)) })
  h.player.playQueue([item(1), item(2), item(3)], 0)
  await h.advance(120_000)
  assert.equal(h.player.current.track.id, 2)
  assert.equal(h.player.status, 'playing')
  assert.equal(h.messages.length, 1)
  slow.resolve(playable(1))
  await flush()
  assert.deepEqual(h.sources, ['https://audio.test/2'])
  assert.equal(h.player.current.track.id, 2)
})

test('offline resolution stops after three songs; reconnect and manual retry recover the same queue', async () => {
  let online = false
  const h = harness({ resolve: async (track) => {
    if (!online) throw new Error('Network is unreachable')
    return playable(track.id)
  } })
  h.player.playQueue([item(1), item(2), item(3), item(4)], 0)
  await flush()
  await flush()
  assert.equal(h.player.status, 'idle')
  assert.equal(h.player.current.track.id, 3)
  assert.deepEqual(h.resolutions, [[1, false], [2, false], [3, false]])
  assert.equal(h.messages.length, 3)
  assert.ok(h.audios.every((audio) => !audio.src))
  online = true
  h.player.toggle()
  await flush()
  assert.equal(h.player.status, 'playing')
  assert.equal(h.player.current.track.id, 3)
  h.audios.at(-1).dispatchEvent(new Event('ended'))
  await flush()
  assert.equal(h.player.current.track.id, 4)
  assert.equal(h.player.status, 'playing')
  assert.equal(h.messages.length, 3)
})

test('offline downloaded audio can still play after remote resolution failed', async () => {
  const h = harness({ resolve: async (track) => {
    if (track.id === 1) throw new Error('Network is unreachable')
    return { url: 'http://127.0.0.1:34567/token/download', local: true }
  } })
  h.player.playQueue([item(1), item(2)], 0)
  await flush()
  assert.equal(h.player.current.track.id, 2)
  assert.equal(h.player.status, 'playing')
  assert.deepEqual(h.sources, ['http://127.0.0.1:34567/token/download'])
  assert.deepEqual(h.resolutions, [[1, false], [2, false]])
  assert.equal(h.messages.length, 1)
})

test('a middle-of-song network error renews a manual queue song without losing position or album order', async () => {
  const h = harness({ resolve: async (track, refresh) => playable(track.id + (refresh ? 1000 : 0)) })
  h.player.playQueue([item(1), item(2)], 0)
  await flush()
  h.player.addToQueue([item(90), item(91)])
  h.player.next()
  await flush()
  const failed = h.audios.at(-1)
  progress(failed, 87)
  failed.fail(2, 'Network connection lost')
  await flush()
  assert.equal(h.player.current.track.id, 90)
  assert.equal(h.player.status, 'playing')
  assert.equal(h.audios.at(-1).currentTime, 87)
  assert.equal(h.player.time, 87)
  assert.deepEqual(h.resolutions.filter(([, refresh]) => refresh), [[90, true]])
  failed.fail(2)
  failed.dispatchEvent(new Event('ended'))
  await flush()
  assert.equal(h.player.current.track.id, 90)
  h.audios.at(-1).dispatchEvent(new Event('ended'))
  await flush()
  assert.equal(h.player.current.track.id, 91)
  h.audios.at(-1).dispatchEvent(new Event('ended'))
  await flush()
  assert.equal(h.player.current.track.id, 2)
  assert.equal(h.player.status, 'playing')
  assert.equal(h.messages.filter((message) => message.startsWith('No se pudo')).length, 0)
})

test('a user skip during slow HTTP 403 recovery ignores the old URL when it arrives', async () => {
  const renewed = deferred()
  const h = harness({ resolve: (track, refresh) =>
    refresh ? renewed.promise : Promise.resolve(playable(track.id)) })
  h.player.playQueue([item(1), item(2)], 0)
  await flush()
  const old = h.audios.at(-1)
  progress(old, 62)
  old.fail(4, 'HTTP response 403')
  await flush()
  assert.equal(h.player.status, 'loading')
  h.player.next()
  await flush()
  renewed.resolve(playable(1001))
  await flush()
  assert.equal(h.player.current.track.id, 2)
  assert.equal(h.player.status, 'playing')
  assert.equal(h.player.time, 0)
  assert.ok(!h.sources.includes('https://audio.test/1001'))
  assert.equal(h.messages.length, 0)
})

test('a refresh timeout during a middle-of-song cutoff advances only once', async () => {
  const renewed = deferred()
  const h = harness({ resolve: (track, refresh) =>
    refresh ? renewed.promise : Promise.resolve(playable(track.id)) })
  h.player.playQueue([item(1), item(2), item(3)], 0)
  await flush()
  const failed = h.audios.at(-1)
  progress(failed, 95)
  failed.fail(2)
  await h.advance(120_000)
  assert.equal(h.player.current.track.id, 2)
  assert.equal(h.player.status, 'playing')
  assert.equal(h.messages.length, 1)
  renewed.reject(new Error('Late network failure'))
  failed.fail(4)
  failed.dispatchEvent(new Event('ended'))
  await flush()
  assert.equal(h.player.current.track.id, 2)
  assert.equal(h.messages.length, 1)
})

test('a temporary buffering stall that recovers by itself retains the track and queue', async () => {
  const h = harness()
  h.player.playQueue([item(1), item(2)], 0)
  await flush()
  const audio = h.audios.at(-1)
  progress(audio, 60)
  audio.dispatchEvent(new Event('waiting'))
  audio.dispatchEvent(new Event('stalled'))
  await h.advance(10_000)
  start(audio)
  progress(audio, 61)
  assert.equal(h.player.current.track.id, 1)
  assert.equal(h.player.status, 'playing')
  assert.equal(h.player.time, 61)
  assert.equal(h.messages.length, 0)
  assert.equal(h.resolutions.filter(([, refresh]) => refresh).length, 0)
})

test('REGRESSION: a permanent buffering stall cannot remain shown as playing indefinitely', async (t) => {
  const h = harness()
  h.player.playQueue([item(1), item(2)], 0)
  await flush()
  const audio = h.audios.at(-1)
  progress(audio, 60)
  audio.dispatchEvent(new Event('waiting'))
  audio.dispatchEvent(new Event('stalled'))
  await h.advance(180_000)
  t.diagnostic(JSON.stringify({ status: h.player.status, time: h.player.time, song: h.player.current.track.id,
    renewals: h.resolutions.filter(([, refresh]) => refresh).length, messages: h.messages, timers: h.timers.size }))
  assert.ok(h.player.status !== 'playing' || h.player.current.track.id !== 1 ||
    h.resolutions.some(([, refresh]) => refresh), 'No progress for 180 s: no timeout, retry, queue advance or visible stalled state')
})

test('REGRESSION: a rejected resume must report a retryable playback error', async (t) => {
  let plays = 0
  const h = harness({ play: (audio) => ++plays === 1
    ? start(audio) : Promise.reject(new DOMException('Playback was interrupted', 'AbortError')) })
  h.player.playQueue([item()], 0)
  await flush()
  progress(h.audios.at(-1), 35)
  h.player.toggle()
  assert.equal(h.player.status, 'paused')
  h.player.toggle()
  await flush()
  t.diagnostic(JSON.stringify({ status: h.player.status, plays, messages: h.messages, timers: h.timers.size }))
  assert.ok(h.messages.length > 0 || h.player.status === 'idle', 'Resume rejected but its error was swallowed; the UI gives no explanation of the failure')
})

test('REGRESSION: a pending resume must have a bounded wait like the initial play', async (t) => {
  const pending = deferred()
  let plays = 0
  const h = harness({ play: (audio) => ++plays === 1 ? start(audio) : pending.promise })
  h.player.playQueue([item()], 0)
  await flush()
  h.player.toggle()
  h.player.toggle()
  await h.advance(180_000)
  t.diagnostic(JSON.stringify({ status: h.player.status, plays, messages: h.messages, timers: h.timers.size }))
  assert.ok(h.messages.length > 0 || h.player.status === 'idle', 'Resume stayed pending for 180 s with no timeout or recovery')
})
