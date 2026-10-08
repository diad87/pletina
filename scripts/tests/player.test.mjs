// node --test scripts/tests/player.test.mjs
// Compila y ejecuta el reproductor de escritorio real con adaptadores controlados.
import assert from 'node:assert/strict'
import test from 'node:test'
import { deferred, flush, harness, item, playable } from './helpers/player-harness.mjs'

test('local audio plays even when optional MediaSession APIs throw', async () => {
  const h = harness({
    resolve: async () => playable(1, true),
    mediaSession: {
      setActionHandler() { throw new Error('Unsupported action') },
      set playbackState(_value) { throw new Error('Unsupported playback state') },
    },
    metadata: class { constructor() { throw new Error('Unsupported metadata') } },
  })
  h.player.playQueue([item()], 0)
  await flush()
  assert.equal(h.player.status, 'playing')
  assert.deepEqual(h.sources, ['asset:///music/1.mp3'])
  assert.equal(h.messages.length, 0)
  assert.equal(h.timers.size, 1, 'only the active progress watchdog remains')
})

test('local loopback transport uses its URL unchanged and never refreshes it as a remote source', async () => {
  const url = 'http://127.0.0.1:32123/random-token/opaque-file-id'
  const h = harness({ resolve: async () => ({ url, local: true }) })
  h.player.playQueue([item()], 0)
  await flush()
  assert.equal(h.player.status, 'playing')
  assert.deepEqual(h.sources, [url])
  h.audios.at(-1).fail(4)
  await flush()
  assert.equal(h.player.status, 'idle')
  assert.deepEqual(h.resolutions, [[1, false]])
  assert.equal(h.messages.length, 1)
})

for (const url of [
  String.raw`C:\Music\song.mp3`,
  String.raw`\\server\Music\song.mp3`,
  'http://127.0.0.1:32123@remote.test/song.mp3',
  'http://127.0.0.1:99999/song.mp3',
  'https://127.0.0.1:32123/song.mp3',
]) {
  test(`local path or unsupported transport still passes through convertFileSrc: ${url}`, async () => {
    const h = harness({ resolve: async () => ({ url, local: true }) })
    h.player.playQueue([item()], 0)
    await flush()
    assert.deepEqual(h.sources, [`asset://${url}`])
  })
}

test('unresolved backend request times out, can be retried, and cannot start late audio', async () => {
  const pending = deferred()
  let attempt = 0
  const h = harness({ resolve: () => ++attempt === 1 ? pending.promise : Promise.resolve(playable()) })
  h.player.playQueue([item()], 0)
  await h.advance(120_000)
  assert.equal(h.player.status, 'idle')
  assert.match(h.messages[0], /preparar el audio a tiempo/)
  h.player.toggle()
  await flush()
  assert.equal(h.player.status, 'playing')
  pending.resolve(playable(99))
  await flush()
  assert.deepEqual(h.sources, ['https://audio.test/1'])
  assert.equal(h.messages.length, 1)
})

test('a hung audio decoder times out, releases its source, and ignores late events', async () => {
  const pending = deferred()
  const h = harness({ play: () => pending.promise })
  h.player.playQueue([item()], 0)
  await flush()
  const audio = h.audios.at(-1)
  await h.advance(30_000)
  assert.equal(h.player.status, 'idle')
  assert.match(h.messages[0], /iniciar el audio/)
  assert.equal(audio.src, '')
  assert.equal(audio.paused, true)
  assert.ok(audio.loads > 0)
  pending.resolve()
  audio.paused = false
  audio.dispatchEvent(new Event('playing'))
  audio.fail()
  await flush()
  assert.equal(h.player.status, 'idle')
  assert.equal(h.messages.length, 1)
  assert.equal(h.timers.size, 0)
})

test('a current AbortError leaves loading and reports one failure', async () => {
  const h = harness({ play: () => Promise.reject(new DOMException('Interrupted', 'AbortError')) })
  h.player.playQueue([item()], 0)
  await flush()
  assert.equal(h.player.status, 'idle')
  assert.equal(h.messages.length, 1)
  assert.equal(h.audios.at(-2).src, '')
})

test('duplicate errors after one remote refresh skip only one song and ignore old events', async () => {
  const first = deferred()
  const refreshed = deferred()
  let attempts = 0
  const h = harness({ play: (audio) => {
    if (++attempts === 1) return first.promise
    if (attempts === 2) return refreshed.promise
    audio.paused = false
    audio.dispatchEvent(new Event('playing'))
    return Promise.resolve()
  } })
  h.player.playQueue([item(1), item(2), item(3)], 0)
  await flush()
  const old = h.audios.at(-1)
  old.fail(4)
  first.reject(new DOMException('Unsupported source', 'NotSupportedError'))
  await flush()
  const retry = h.audios.at(-1)
  retry.fail(4)
  refreshed.reject(new DOMException('Unsupported source', 'NotSupportedError'))
  await flush()
  old.fail(4)
  retry.fail(4)
  old.dispatchEvent(new Event('ended'))
  await flush()
  assert.equal(h.player.current.track.id, 2)
  assert.equal(h.player.status, 'playing')
  assert.equal(h.messages.length, 1)
  assert.match(h.messages[0], /fuente de audio/)
  assert.deepEqual(h.sources, ['https://audio.test/1', 'https://audio.test/1', 'https://audio.test/2'])
  assert.deepEqual(h.resolutions.filter(([id]) => id === 1), [[1, false], [1, true]])
})

test('selecting a new song while resolving prevents an old result from replacing it', async () => {
  const pending = deferred()
  const h = harness({ resolve: (track) => track.id === 1 ? pending.promise : Promise.resolve(playable(track.id)) })
  h.player.playQueue([item(1), item(2)], 0)
  h.player.playAt(1)
  await flush()
  pending.resolve(playable(1))
  await flush()
  assert.equal(h.player.current.track.id, 2)
  assert.equal(h.player.status, 'playing')
  assert.deepEqual(h.sources, ['https://audio.test/2'])
  assert.equal(h.messages.length, 0)
})

test('network failure during startup refreshes once without a duplicate queue advance', async () => {
  const pending = deferred()
  let attempts = 0
  const h = harness({ play: (audio) => {
    if (++attempts === 1) return pending.promise
    audio.paused = false
    audio.dispatchEvent(new Event('playing'))
    return Promise.resolve()
  } })
  h.player.playQueue([item()], 0)
  await flush()
  h.audios.at(-1).fail(2)
  pending.reject(new Error('Network error'))
  await flush()
  assert.deepEqual(h.resolutions, [[1, false], [1, true]])
  assert.equal(h.player.status, 'playing')
  assert.equal(h.messages.length, 0)
})

test('an expired remote URL reported as code 4 refreshes and recovers during startup', async () => {
  const pending = deferred()
  const h = harness({
    resolve: async (_track, refresh) => playable(refresh ? 99 : 1),
    play: (audio) => {
      if (audio.src === 'https://audio.test/1') return pending.promise
      audio.paused = false
      audio.dispatchEvent(new Event('playing'))
      return Promise.resolve()
    },
  })
  h.player.playQueue([item()], 0)
  await flush()
  h.audios.at(-1).fail(4, 'HTTP response 403')
  pending.reject(new DOMException('Unsupported source', 'NotSupportedError'))
  await flush()
  assert.deepEqual(h.resolutions, [[1, false], [1, true]])
  assert.deepEqual(h.sources, ['https://audio.test/1', 'https://audio.test/99'])
  assert.equal(h.player.status, 'playing')
  assert.equal(h.messages.length, 0)
})

test('code 4 during remote playback refreshes once and preserves the position', async () => {
  const h = harness({ resolve: async (_track, refresh) => playable(refresh ? 99 : 1) })
  h.player.playQueue([item()], 0)
  await flush()
  h.audios.at(-1).currentTime = 42
  h.audios.at(-1).fail(4, 'HTTP response 403')
  await flush()
  assert.equal(h.player.status, 'playing')
  assert.equal(h.audios.at(-1).currentTime, 42)
  assert.deepEqual(h.resolutions, [[1, false], [1, true]])
  h.audios.at(-1).fail(4, 'HTTP response 403')
  await flush()
  assert.equal(h.player.status, 'idle')
  assert.equal(h.messages.length, 1)
  assert.equal(h.resolutions.length, 2)
})

test('unsupported local audio fails without re-extracting or diagnosing the format as certain', async () => {
  const h = harness({
    resolve: async () => playable(1, true),
    play: (audio) => {
      audio.fail(4)
      return Promise.reject(new DOMException('Unsupported source', 'NotSupportedError'))
    },
  })
  h.player.playQueue([item()], 0)
  await flush()
  assert.equal(h.player.status, 'idle')
  assert.deepEqual(h.resolutions, [[1, false]])
  assert.equal(h.messages.length, 1)
  assert.match(h.messages[0], /fuente de audio/)
  assert.doesNotMatch(h.messages[0], /formato/)
})

for (const code of [2, 4]) {
  test(`local playback error ${code} does not refresh a file source`, async () => {
    const h = harness({ resolve: async () => playable(1, true) })
    h.player.playQueue([item()], 0)
    await flush()
    h.audios.at(-1).fail(code)
    await flush()
    assert.equal(h.player.status, 'idle')
    assert.deepEqual(h.resolutions, [[1, false]])
    assert.equal(h.messages.length, 1)
  })
}

test('repeated unsupported audio stops after three failures and releases every source', async () => {
  const h = harness({ play: (audio) => {
    audio.fail(4)
    return Promise.reject(new Error('Unsupported format'))
  } })
  h.player.playQueue([item(1), item(2), item(3), item(4)], 0)
  await flush()
  await flush()
  await flush()
  assert.equal(h.player.current.track.id, 3)
  assert.equal(h.player.status, 'idle')
  assert.equal(h.messages.length, 3)
  assert.deepEqual(h.resolutions, [[1, false], [1, true], [2, false], [2, true], [3, false], [3, true]])
  assert.ok(h.audios.every((audio) => !audio.src))
  assert.equal(h.timers.size, 0)
})

test('choosing an alternative source also times out and returns to a retryable state', async () => {
  const pending = deferred()
  let attempts = 0
  const h = harness({ resolve: () => ++attempts === 2 ? pending.promise : Promise.resolve(playable()) })
  h.player.playQueue([item()], 0)
  await flush()
  const alternative = h.player.useSource('video')
  await h.advance(120_000)
  assert.equal(await alternative, false)
  assert.equal(h.player.status, 'idle')
  assert.equal(h.messages.length, 1)
  h.player.toggle()
  await flush()
  assert.equal(h.player.status, 'playing')
  pending.resolve(playable(99))
  await flush()
  assert.ok(!h.sources.includes('https://audio.test/99'))
})

test('a chosen remote source reported as code 4 refreshes before reporting success', async () => {
  let resolutions = 0
  const h = harness({
    resolve: async () => playable([1, 2, 99][resolutions++]),
    play: (audio) => {
      if (audio.src === 'https://audio.test/2') {
        audio.fail(4, 'HTTP response 403')
        return Promise.reject(new DOMException('Unsupported source', 'NotSupportedError'))
      }
      audio.paused = false
      audio.dispatchEvent(new Event('playing'))
      return Promise.resolve()
    },
  })
  h.player.playQueue([item()], 0)
  await flush()
  assert.equal(await h.player.useSource('video'), true)
  assert.equal(h.player.status, 'playing')
  assert.equal(resolutions, 3)
  assert.deepEqual(h.resolutions, [[1, false], [1, true]])
  assert.deepEqual(h.sources, ['https://audio.test/1', 'https://audio.test/2', 'https://audio.test/99'])
  assert.equal(h.messages.length, 1)
  assert.match(h.messages[0], /^Hecho:/)
})

test('cancelling the final song during resolution does not restart it later', async () => {
  const pending = deferred()
  const h = harness({ resolve: () => pending.promise })
  h.player.playQueue([item()], 0)
  h.player.next()
  pending.resolve(playable())
  await flush()
  assert.equal(h.player.status, 'idle')
  assert.equal(h.sources.length, 0)
  assert.equal(h.messages.length, 0)
})

test('an interrupted play from a replaced audio element leaves the current song alone', async () => {
  const pending = deferred()
  let attempts = 0
  const h = harness({ play: (audio) => {
    if (++attempts === 1) return pending.promise
    audio.paused = false
    audio.dispatchEvent(new Event('playing'))
    return Promise.resolve()
  } })
  h.player.playQueue([item(1), item(2)], 0)
  await flush()
  const old = h.audios.at(-1)
  h.player.next()
  await flush()
  pending.reject(new DOMException('Replaced', 'AbortError'))
  old.dispatchEvent(new Event('pause'))
  old.fail(4)
  await flush()
  assert.equal(h.player.current.track.id, 2)
  assert.equal(h.player.status, 'playing')
  assert.equal(h.messages.length, 0)
  assert.equal(h.timers.size, 1, 'the replacement song owns one progress watchdog')
})
