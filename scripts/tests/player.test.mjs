// node --test scripts/tests/player.test.mjs
// Ejecuta el reproductor real, compilando TypeScript y las runas de Svelte con las dependencias del proyecto.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { compileModule } from 'svelte/compiler'
import * as svelte from 'svelte/internal/client'
import ts from 'typescript'

const source = await readFile(new URL('../../src/lib/player.svelte.ts', import.meta.url), 'utf8')
const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText
const compiled = ts.transpileModule(compileModule(javascript, { filename: 'player.svelte.js' }).js.code, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const item = (id = 1) => ({
  track: { id, title: `Canción ${id}`, duration: 180, artist: { id: 1, name: 'Artista' } },
  albumId: 1, albumTitle: 'Álbum', artistId: 1, cover: null,
})
const playable = (id = 1, local = false) => ({ url: local ? `/music/${id}.mp3` : `https://audio.test/${id}`, local })

function harness({ resolve = async (track) => playable(track.id), play, mediaSession, metadata } = {}) {
  const audios = [], messages = [], resolutions = [], sources = []
  const timers = new Map()
  let now = 0, timerId = 0, stopped = 0
  class Audio extends EventTarget {
    src = ''
    currentTime = 0
    duration = NaN
    paused = true
    error = null
    playbackRate = 1
    loads = 0
    constructor() { super(); audios.push(this) }
    play() {
      if (play) return play(this)
      this.paused = false
      this.dispatchEvent(new Event('playing'))
      return Promise.resolve()
    }
    pause() { this.paused = true; this.dispatchEvent(new Event('pause')) }
    removeAttribute(name) { if (name === 'src') this.src = '' }
    load() { this.loads++ }
    fail(code = 4, message = 'Simulated media error') {
      this.error = { code, message }
      this.dispatchEvent(new Event('error'))
    }
  }
  const modules = {
    'svelte/internal/client': svelte,
    '@tauri-apps/api/core': { convertFileSrc: (path) => `asset://${path}` },
    './api': {
      resolve: (track, refresh) => { resolutions.push([track.id, refresh]); return resolve(track, refresh) },
      chooseSource: (track) => resolve(track, true),
      recordPlay: async () => {},
    },
    './downloads.svelte': { downloads: { done: new Set(), start: () => {} } },
    './extractor/capture': {
      stopCapture: () => { stopped++ },
      setAudioSource: (audio, src) => { audio.src = src; sources.push(src) },
    },
    './library.svelte': { library: { historyVersion: 0 }, toLib: (value) => value },
    './media': { isPodcast: () => false, mediaUrl: (value) => value },
    './toast.svelte': { toast: { show: (message) => messages.push(message) } },
    './player-android.svelte': { isAndroid: false },
    './queue': {
      load: (_key, fallback) => fallback,
      playOrder: (length) => Array.from({ length }, (_, index) => index),
      save: () => {}, toQuery: (value) => value.track,
    },
  }
  const exports = {}
  new Function('require', 'exports', 'Audio', 'navigator', 'MediaMetadata', 'setTimeout', 'clearTimeout', compiled)(
    (name) => { assert.ok(name in modules, `Unmocked dependency: ${name}`); return modules[name] },
    exports, Audio, mediaSession ? { mediaSession } : {}, metadata,
    (fn, delay) => { const id = ++timerId; timers.set(id, { at: now + delay, fn }); return id },
    (id) => timers.delete(id),
  )
  return {
    player: exports.player, audios, messages, resolutions, sources, timers,
    get stopped() { return stopped },
    async advance(ms) {
      await flush()
      const until = now + ms
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
        if (!next || next[1].at > until) break
        now = next[1].at
        timers.delete(next[0])
        next[1].fn()
        await flush()
      }
      now = until
      await flush()
    },
  }
}

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
  assert.equal(h.timers.size, 0)
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
  assert.equal(h.timers.size, 0)
})
