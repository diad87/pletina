// Ejecuta el Player real con api.inPwa=true; no valida políticas ni decoders del navegador.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { compileModule } from 'svelte/compiler'
import * as svelte from 'svelte/internal/client'
import ts from 'typescript'
import * as queuePersistence from '../../web-port/queue-persistence.ts'
import { deferred, flush, item, playable, sleepTimer } from './helpers/player-harness.mjs'

const commonJs = (source) => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText
const source = await readFile(new URL('../../src/lib/player.svelte.ts', import.meta.url), 'utf8')
const javascript = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
}).outputText
const compiled = commonJs(compileModule(javascript, { filename: 'web-player.svelte.js' }).js.code)
const queue = {}
new Function('exports', commonJs(await readFile(new URL('../../src/lib/queue.ts', import.meta.url), 'utf8')))(queue)

// El harness compartido no permite inyectar inPwa. Este adaptador local conserva su contrato
// sin cambiarlo y modela el reinicio de error/metadatos al sustituir la fuente de un Audio real.
function pwaHarness({ resolve = async (track) => playable(track.id), play, progress = new Map(), progressPosition,
  duration = () => 180, storage, metadata = true, online = true, downloaded = new Set(),
  readDownloaded = async () => null,
  location = 'https://app.example/pletina/application/app.html',
  automaticYouTubeSource = () => null, openAutomaticYouTubePlayer = () => true,
  retainWebAudioRequests = () => {},
  chooseSource = async (track, videoId) => ({ ...playable(track.id), videoId }) } = {}) {
  const audios = [], sources = [], resolutions = [], messages = [], records = [], audioOperations = [], sourceChoices = []
  const progressReads = [], progressWrites = [], officialOpens = [], offlineReads = []
  const events = new EventTarget()
  events.location = { href: location }
  events.localStorage = storage
  const timers = new Map()
  const audioSession = { type: 'auto' }
  const browserNavigator = { audioSession, onLine: online }
  let now = 0, timerId = 0, wallOffset = 0
  class Clock extends Date { static now() { return Date.now() + wallOffset } }
  class Audio extends EventTarget {
    #src = ''
    currentTime = 0
    duration = NaN
    paused = true
    error = null
    playbackRate = 1
    plays = 0
    loads = 0
    constructor() { super(); audios.push(this) }
    get src() { return this.#src }
    set src(value) {
      audioOperations.push({ type: 'src', value })
      this.#src = value
      this.currentTime = 0
      this.duration = NaN
      this.error = null
    }
    play() {
      audioOperations.push({ type: 'play', value: this.src })
      this.plays++
      if (!Number.isFinite(this.duration)) {
        this.duration = duration(this)
        if (metadata) {
          this.dispatchEvent(new Event('loadedmetadata'))
          this.dispatchEvent(new Event('durationchange'))
        }
      }
      return play ? play(this) : this.begin()
    }
    begin() {
      this.paused = false
      this.dispatchEvent(new Event('playing'))
      return Promise.resolve()
    }
    pause() { audioOperations.push({ type: 'pause' }); this.paused = true; this.dispatchEvent(new Event('pause')) }
    removeAttribute(name) { if (name === 'src') { audioOperations.push({ type: 'remove-src' }); this.src = '' } }
    load() { audioOperations.push({ type: 'load', value: this.src }); this.loads++ }
    fail(code = 4) {
      this.error = { code, message: 'Simulated media error' }
      this.dispatchEvent(new Event('error'))
    }
  }
  const modules = {
    'svelte/internal/client': svelte,
    '@tauri-apps/api/core': { convertFileSrc() { throw new Error('PWA must not use native file URLs') } },
    '@tauri-apps/api/window': { getCurrentWindow() { throw new Error('PWA must not open a native window') } },
    './api': {
      inPwa: true,
      inTauri: false,
      retainWebAudioRequests,
      readWebDownloadedPlayable(id) { offlineReads.push(id); return readDownloaded(id) },
      resolve(track, refresh) { resolutions.push([track.id, refresh]); return resolve(track, refresh) },
      automaticYouTubeSource,
      openAutomaticYouTubePlayer(track, source, at) {
        officialOpens.push({ id: track.id, videoId: source.videoId, at, status: exports.player.status, audioPaused: audios.at(-1).paused, src: audios.at(-1).src })
        return openAutomaticYouTubePlayer(track, source, at)
      },
      chooseSource(track, videoId) { sourceChoices.push([track.id, videoId]); return chooseSource(track, videoId) },
      recordPlay: async (value) => { records.push(value.track.id) },
    },
    './downloads.svelte': { downloads: { done: downloaded, start() {} } },
    './extractor/capture': {
      stopCapture() {},
      setAudioSource(audio, url) { audio.src = url; audio.load(); sources.push(url) },
    },
    './library.svelte': { library: { historyVersion: 0 }, toLib: (value) => value },
    './media': { isPodcast: (id) => id >= 500_000_000_000_000 && id < 1_000_000_000_000_000, isYouTubeTrack: () => false, mediaUrl: (value) => value },
    './toast.svelte': { toast: { show: (message) => messages.push(message) } },
    './podcast-progress.svelte': { episodeProgress: {
      position: async (id) => {
        progressReads.push(id)
        if (progressPosition) return progressPosition(id)
        const row = progress.get(id)
        return row && !row.completed ? row.position : 0
      },
      save: async (row) => { progressWrites.push(row); progress.set(row.id, row) }, flush: async () => {},
    } },
    './player-android.svelte': { isAndroid: false },
    './queue': { ...queue, load: (_key, fallback) => fallback, save() {} },
    './sleep-timer': sleepTimer,
    '../../web-port/queue-persistence': queuePersistence,
  }
  const exports = {}
  new Function('require', 'exports', 'Audio', 'navigator', 'MediaMetadata', 'setTimeout', 'clearTimeout', 'window', 'document', 'performance', 'Date', compiled)(
    (name) => { assert.ok(name in modules, `Unmocked PWA dependency: ${name}`); return modules[name] },
    exports, Audio, browserNavigator, undefined,
    (fn, delay) => { const id = ++timerId; timers.set(id, { at: now + delay, fn }); return id },
    (id) => timers.delete(id), events, events, { now: () => now }, Clock,
  )
  return {
    player: exports.player, audios, sources, resolutions, messages, records, audioSession, audioOperations, sourceChoices, progressReads, progressWrites, officialOpens, events, offlineReads,
    setOnline(value) { browserNavigator.onLine = value; events.dispatchEvent(new Event(value ? 'online' : 'offline')) },
    get audio() { return audios.at(-1) },
    jumpWall(ms) { wallOffset += ms },
    async advance(ms) {
      await flush()
      const until = now + ms
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
        if (!next || next[1].at > until) break
        now = Math.max(now, next[1].at)
        timers.delete(next[0])
        next[1].fn()
        await flush()
      }
      now = until
      await flush()
    },
  }
}

function emitAudioRetry(harness, detail) {
  const event = new Event('pletina:audio-retry')
  Object.defineProperty(event, 'detail', { value: detail })
  harness.events.dispatchEvent(event)
}

test('PWA audio retry reports only valid advancing attempts for the active loading song and clears on playing', async () => {
  const pending = deferred()
  const h = pwaHarness({ resolve: () => pending.promise })
  assert.equal(h.player.audioRetry, 0)
  h.player.playQueue([item(1)], 0)
  await flush()
  emitAudioRetry(h, { trackId: 1, attempt: 1, total: 2 })
  assert.equal(h.player.audioRetry, 1)
  emitAudioRetry(h, { trackId: 1, attempt: 2, total: 2 })
  assert.equal(h.player.audioRetry, 2)
  emitAudioRetry(h, { trackId: 1, attempt: 1, total: 2 })
  assert.equal(h.player.audioRetry, 2, 'a repeated older notification cannot move the displayed attempt backwards')
  pending.resolve(playable(1))
  await flush()
  assert.equal(h.player.status, 'playing')
  assert.equal(h.player.audioRetry, 0)
  emitAudioRetry(h, { trackId: 1, attempt: 2, total: 2 })
  assert.equal(h.player.audioRetry, 0, 'a loading notification cannot alter an already playing song')
})

test('PWA audio retry ignores malformed payloads and notifications for another song', async () => {
  const h = pwaHarness({ resolve: () => deferred().promise })
  emitAudioRetry(h, { trackId: 1, attempt: 1, total: 2 })
  assert.equal(h.player.audioRetry, 0, 'idle has no active loading operation')
  h.player.playQueue([item(1)], 0)
  await flush()
  for (const detail of [
    undefined, null, [], 'retry',
    { trackId: '1', attempt: 1, total: 2 },
    { trackId: 1.5, attempt: 1, total: 2 },
    { trackId: 2, attempt: 1, total: 2 },
    { trackId: 1, attempt: '1', total: 2 },
    { trackId: 1, attempt: 0, total: 2 },
    { trackId: 1, attempt: 3, total: 2 },
    { trackId: 1, attempt: NaN, total: 2 },
    { trackId: 1, attempt: Infinity, total: 2 },
    { trackId: 1, attempt: 1, total: '2' },
    { trackId: 1, attempt: 1, total: 3 },
  ]) {
    emitAudioRetry(h, detail)
    assert.equal(h.player.audioRetry, 0)
  }
  h.player.toggle()
})

test('PWA audio retry clears on replacement and cancel, ignoring late notifications for discarded loading work', async () => {
  const first = deferred(), second = deferred()
  const h = pwaHarness({ resolve: track => track.id === 1 ? first.promise : second.promise })
  h.player.playQueue([item(1), item(2)], 0)
  await flush()
  emitAudioRetry(h, { trackId: 1, attempt: 1, total: 2 })
  assert.equal(h.player.audioRetry, 1)
  h.player.playAt(1)
  assert.equal(h.player.audioRetry, 0, 'a new selection starts without the old retry label')
  emitAudioRetry(h, { trackId: 1, attempt: 2, total: 2 })
  assert.equal(h.player.audioRetry, 0)
  emitAudioRetry(h, { trackId: 2, attempt: 1, total: 2 })
  assert.equal(h.player.audioRetry, 1)
  h.player.toggle()
  assert.equal(h.player.status, 'paused')
  assert.equal(h.player.audioRetry, 0)
  emitAudioRetry(h, { trackId: 2, attempt: 2, total: 2 })
  assert.equal(h.player.audioRetry, 0)
  first.resolve(playable(1))
  second.resolve(playable(2))
  await flush()
  assert.equal(h.player.status, 'paused')
  assert.equal(h.player.audioRetry, 0)
  assert.deepEqual(h.sources, [])
})

test('PWA audio retry clears when resolution fails and an explicit retry starts clean', async () => {
  const failed = deferred(), replacement = deferred()
  let attempts = 0
  const h = pwaHarness({ resolve: () => ++attempts === 1 ? failed.promise : replacement.promise })
  h.player.playQueue([item(1)], 0)
  await flush()
  emitAudioRetry(h, { trackId: 1, attempt: 2, total: 2 })
  assert.equal(h.player.audioRetry, 2)
  failed.reject(new Error('No compatible audio'))
  await flush()
  assert.equal(h.player.status, 'idle')
  assert.equal(h.player.audioRetry, 0)
  emitAudioRetry(h, { trackId: 1, attempt: 1, total: 2 })
  assert.equal(h.player.audioRetry, 0)
  h.player.toggle()
  await flush()
  assert.equal(h.player.status, 'loading')
  assert.equal(h.player.audioRetry, 0)
  emitAudioRetry(h, { trackId: 1, attempt: 1, total: 2 })
  assert.equal(h.player.audioRetry, 1)
  replacement.resolve(playable(1))
  await flush()
  assert.equal(h.player.audioRetry, 0)
})

test('PWA audio retry clears when play resolves without a playing event', async () => {
  const pending = deferred()
  const h = pwaHarness({
    resolve: () => pending.promise,
    play: audio => { audio.paused = false; return Promise.resolve() },
  })
  h.player.playQueue([item(1)], 0)
  await flush()
  emitAudioRetry(h, { trackId: 1, attempt: 2, total: 2 })
  assert.equal(h.player.audioRetry, 2)
  pending.resolve(playable(1))
  await flush()
  assert.equal(h.player.status, 'playing')
  assert.equal(h.player.audioRetry, 0, 'the fulfilled-play confirmation resets the label even without playing')
})

test('PWA audio retry clears when the sleep deadline cancels a pending load', async () => {
  const pending = deferred()
  const h = pwaHarness({ resolve: () => pending.promise })
  h.player.playQueue([item(1)], 0)
  await flush()
  assert.equal(await h.player.setSleepTimer(1), true)
  emitAudioRetry(h, { trackId: 1, attempt: 1, total: 2 })
  assert.equal(h.player.audioRetry, 1)
  await h.advance(60_000)
  assert.equal(h.player.status, 'paused')
  assert.equal(h.player.audioRetry, 0)
  emitAudioRetry(h, { trackId: 1, attempt: 2, total: 2 })
  pending.resolve(playable(1))
  await flush()
  assert.equal(h.player.audioRetry, 0)
  assert.deepEqual(h.sources, [])
})

test('PWA reselecting a song cancelled by another selection starts a fresh resolution before old cleanup finishes', async () => {
  const obsolete = deferred(), fresh = deferred(), retained = []
  let attempts = 0, firstCancelled = false
  const h = pwaHarness({
    resolve: track => track.id === 1 ? ++attempts === 1 ? obsolete.promise : fresh.promise : Promise.resolve(playable(track.id)),
    // A provider can acknowledge cancellation after its media frame is removed.
    // Keep that rejection pending to exercise the player's actual promise cache.
    retainWebAudioRequests: ids => {
      retained.push([...ids])
      if (attempts > 0 && !ids.includes(1)) firstCancelled = true
    },
  })
  h.player.playQueue([item(1), item(2), item(3)], 0)
  await flush()
  h.player.playAt(1)
  await flush()
  assert.equal(firstCancelled, true)
  assert.equal(h.player.current.track.id, 2)
  assert.equal(h.player.status, 'playing')
  h.player.playAt(0)
  await flush()
  assert.equal(attempts, 2, 'the discarded resolution cannot be reused when its song is selected again')
  obsolete.reject(new DOMException('Cancelled source finished unloading', 'AbortError'))
  await flush()
  assert.equal(h.player.current.track.id, 1)
  assert.equal(h.player.status, 'loading')
  assert.deepEqual(h.messages, [], 'a replaced rejection cannot skip the newly selected song')
  h.player.playAt(0)
  await flush()
  assert.equal(attempts, 2, 'the obsolete finally cannot delete the new in-flight resolution')
  fresh.resolve(playable(1))
  await flush()
  assert.equal(h.player.current.track.id, 1)
  assert.equal(h.player.status, 'playing')
  assert.equal(h.audios.length, 1)
  assert.deepEqual(h.sources, ['https://audio.test/2', 'https://audio.test/1'])
  assert.ok(retained.some(ids => ids.join(',') === '2,3'))
})

test('PWA cancelling a pending load retires current and prefetched requests and a quick retry never inherits their promises', async () => {
  const obsolete = deferred(), fresh = deferred(), upcoming = deferred(), retained = []
  let attempts = 0
  const h = pwaHarness({
    resolve: track => track.id === 1 ? ++attempts === 1 ? obsolete.promise : fresh.promise : upcoming.promise,
    retainWebAudioRequests: ids => retained.push([...ids]),
  })
  h.player.playQueue([item(1), item(2)], 0)
  await flush()
  // The browser may prepare the following song on a visibility transition even
  // while the current provider request is still pending.
  h.events.dispatchEvent(new Event('visibilitychange'))
  await flush()
  assert.ok(h.resolutions.some(([id]) => id === 2))
  h.player.toggle()
  assert.equal(h.player.status, 'paused')
  assert.deepEqual(retained.at(-1), [], 'Cancel unloads both play resolutions through the existing API')
  h.player.toggle()
  await flush()
  assert.equal(attempts, 2)
  obsolete.reject(new DOMException('Late cancellation acknowledgement', 'AbortError'))
  upcoming.reject(new DOMException('Cancelled prefetch', 'AbortError'))
  await flush()
  assert.equal(h.player.current.track.id, 1)
  assert.equal(h.player.status, 'loading')
  assert.deepEqual(h.sources, [])
  assert.deepEqual(h.messages, [])
  h.player.playAt(0)
  await flush()
  assert.equal(attempts, 2, 'settling a retired promise cannot remove the replacement')
  fresh.resolve(playable(1))
  await flush()
  assert.equal(h.player.current.track.id, 1)
  assert.equal(h.player.status, 'playing')
  assert.deepEqual(h.sources, ['https://audio.test/1'])
  assert.equal(h.audios.length, 1)
})

test('PWA cancelling startup preserves an assigned source and seek for an explicit resume', async () => {
  const pendingPlay = deferred(), retained = []
  let plays = 0
  const h = pwaHarness({
    play: audio => ++plays === 1 ? pendingPlay.promise : audio.begin(),
    retainWebAudioRequests: ids => retained.push([...ids]),
  })
  h.player.playQueue([item(1)], 0)
  await flush()
  assert.equal(h.player.status, 'loading')
  h.player.seek(23)
  h.player.toggle()
  assert.equal(h.player.status, 'paused')
  assert.equal(h.player.time, 23)
  assert.equal(h.audio.src, 'https://audio.test/1')
  assert.deepEqual(retained.at(-1), [])
  h.player.toggle()
  await flush()
  assert.equal(h.player.status, 'playing')
  assert.equal(h.audio.currentTime, 23)
  pendingPlay.reject(new DOMException('Old play was cancelled', 'AbortError'))
  await flush()
  assert.equal(h.player.status, 'playing')
  assert.equal(h.player.current.track.id, 1)
  assert.deepEqual(h.resolutions, [[1, false]])
  assert.deepEqual(h.sources, ['https://audio.test/1'])
  assert.deepEqual(h.messages, [])
})

test('PWA autoplay rejection keeps the first source and queue ready for a second user tap', async () => {
  let attempt = 0
  const h = pwaHarness({ play: (audio) => ++attempt === 1
    ? Promise.reject(new DOMException('User activation required', 'NotAllowedError')) : audio.begin() })
  const audio = h.audio
  h.player.playQueue([item(1), item(2)], 0)
  await flush()
  assert.equal(h.audioSession.type, 'playback')
  assert.equal(h.player.status, 'paused')
  assert.equal(h.player.current.track.id, 1)
  assert.deepEqual(h.player.upcoming.map(({ item }) => item.track.id), [2])
  assert.equal(h.audio, audio)
  assert.equal(h.audios.length, 1)
  assert.equal(audio.paused, true)
  assert.equal(audio.src, 'https://audio.test/1')
  assert.deepEqual(h.sources, ['https://audio.test/1'])
  assert.deepEqual(h.resolutions.filter(([id]) => id === 1), [[1, false]])
  assert.equal(h.messages.length, 1)
  assert.match(h.messages[0], /Audio preparado.*Pulsa Reproducir/)

  const resolutions = [...h.resolutions]
  h.player.toggle()
  await flush()
  assert.equal(h.player.status, 'playing')
  assert.equal(h.player.current.track.id, 1)
  assert.equal(h.audio, audio)
  assert.equal(audio.plays, 2)
  assert.equal(audio.paused, false)
  assert.deepEqual(h.sources, ['https://audio.test/1'])
  assert.deepEqual(h.resolutions, resolutions, 'the second tap plays the already prepared URL')
  assert.equal(h.messages.length, 1)
})

test('PWA retains its user-activated Audio across automatic and explicit song changes', async () => {
  const h = pwaHarness()
  const audio = h.audio
  h.player.playQueue([item(1), item(2), item(3)], 0)
  await flush()
  audio.currentTime = 180
  audio.paused = true
  audio.dispatchEvent(new Event('ended'))
  await flush()
  assert.equal(h.player.current.track.id, 2)
  assert.equal(h.player.status, 'playing')
  assert.equal(h.audio, audio)
  h.player.playAt(2)
  await flush()
  assert.equal(h.player.current.track.id, 3)
  assert.equal(h.player.status, 'playing')
  assert.equal(h.audios.length, 1)
  assert.equal(audio.plays, 3)
  assert.deepEqual(h.sources, ['https://audio.test/1', 'https://audio.test/2', 'https://audio.test/3'])
  assert.equal(h.messages.length, 0)
})

test('PWA resumes after native play resolves even when the browser omits playing', async () => {
  let attempt = 0
  const h = pwaHarness({ play: (audio) => {
    if (++attempt === 1) return audio.begin()
    audio.paused = false
    return Promise.resolve()
  } })
  h.player.playQueue([item(1), item(2)], 0)
  await flush()
  const audio = h.audio
  audio.currentTime = 12
  audio.dispatchEvent(new Event('timeupdate'))
  h.player.toggle()
  assert.equal(h.player.status, 'paused')
  h.player.toggle()
  await flush()
  assert.equal(audio.paused, false)
  assert.equal(h.player.status, 'playing', 'resolved native playback must restore the pause/seek controls without another playing event')
  audio.currentTime = 13
  audio.dispatchEvent(new Event('timeupdate'))
  assert.equal(h.player.time, 13)
  audio.currentTime = 180
  audio.paused = true
  audio.dispatchEvent(new Event('ended'))
  await flush()
  assert.equal(h.player.current.track.id, 2)
  assert.equal(h.player.status, 'playing')
})

test('PWA ignores an obsolete resolved play promise while a new song is still loading', async () => {
  const first = deferred(), second = deferred()
  let attempt = 0
  const h = pwaHarness({ play: (audio) => {
    audio.paused = false
    return ++attempt === 1 ? first.promise : second.promise
  } })
  h.player.playQueue([item(1), item(2)], 0)
  await flush()
  h.player.playAt(1)
  await flush()
  assert.equal(h.player.status, 'loading')
  first.resolve()
  await flush()
  assert.equal(h.player.current.track.id, 2)
  assert.equal(h.player.status, 'loading', 'the old source cannot confirm playback of the new one')
  second.resolve()
  await flush()
  assert.equal(h.player.status, 'playing')
})

test('PWA ignores a resolved play promise after the user has paused the pending start', async () => {
  const pending = deferred()
  const h = pwaHarness({ play: (audio) => { audio.paused = false; return pending.promise } })
  h.player.playQueue([item(1), item(2)], 0)
  await flush()
  h.player.toggle()
  assert.equal(h.player.status, 'paused')
  pending.resolve()
  await flush()
  assert.equal(h.player.status, 'paused')
  assert.equal(h.audio.paused, true)
  assert.equal(h.player.current.track.id, 1)
})

test('PWA resolved play without playing still repairs and stops a decoder that never advances', async () => {
  const h = pwaHarness({ resolve: async (track, refresh) => playable(track.id + (refresh ? 1000 : 0)),
    play: (audio) => { audio.paused = false; return Promise.resolve() } })
  h.player.playQueue([item(1)], 0)
  await flush()
  assert.equal(h.player.status, 'playing')
  await h.advance(30000)
  assert.equal(h.audios.length, 2, 'the existing watchdog must still rebuild a stalled decoder')
  assert.equal(h.audio.src, 'https://audio.test/1001')
  assert.equal(h.player.status, 'playing')
  await h.advance(30000)
  assert.equal(h.player.status, 'idle', 'a second stall must stop boundedly')
  assert.equal(h.audios.length, 2)
  assert.equal(h.messages.length, 1)
  assert.match(h.messages[0], /El audio no avanza/)
})

test('PWA confirms two advancing samples when WebKit leaves resume play pending without playing', async () => {
  const pending = deferred()
  let attempt = 0
  const h = pwaHarness({ play: (audio) => {
    if (++attempt !== 2) return audio.begin()
    audio.paused = false
    return pending.promise
  } })
  h.player.playQueue([item(750_000_000_000_001), item(750_000_000_000_002)], 0)
  await flush()
  const audio = h.audio
  audio.currentTime = 8
  audio.dispatchEvent(new Event('timeupdate'))
  h.player.toggle(); h.player.toggle()
  await flush()
  assert.equal(h.player.status, 'loading')
  audio.currentTime = 8.25
  audio.dispatchEvent(new Event('timeupdate'))
  await flush()
  assert.equal(h.player.status, 'loading', 'one sample cannot distinguish playback from a position jump')
  audio.currentTime = 8.55
  audio.dispatchEvent(new Event('timeupdate'))
  await flush()
  assert.equal(h.player.status, 'playing', 'real advancement must settle the pending start and restore UI controls')
  audio.currentTime = 8.8
  audio.dispatchEvent(new Event('timeupdate'))
  assert.equal(h.player.time, 8.8)
  h.player.toggle()
  assert.equal(h.progressWrites.at(-1).position, 8.8)
  h.player.toggle()
  await flush()
  audio.currentTime = 180; audio.paused = true; audio.dispatchEvent(new Event('ended'))
  await flush()
  assert.equal(h.player.current.track.id, 750_000_000_000_002)
  assert.equal(h.player.status, 'playing')
  pending.resolve()
  await flush()
  assert.equal(h.player.current.track.id, 750_000_000_000_002)
})

test('PWA never treats a seek jump as playback while native play remains pending', async () => {
  const pending = deferred()
  const h = pwaHarness({ play: (audio) => { audio.paused = false; return pending.promise } })
  h.player.playQueue([item(1)], 0)
  await flush()
  const audio = h.audio
  audio.currentTime = 0.2; audio.dispatchEvent(new Event('timeupdate'))
  audio.seeking = true; audio.dispatchEvent(new Event('seeking'))
  audio.currentTime = 45; audio.dispatchEvent(new Event('timeupdate'))
  audio.seeking = false; audio.dispatchEvent(new Event('seeked'))
  audio.dispatchEvent(new Event('timeupdate'))
  audio.dispatchEvent(new Event('timeupdate'))
  await flush()
  assert.equal(h.player.status, 'loading', 'seeking and repeated stationary samples must not confirm playback')
  audio.currentTime = 45.3; audio.dispatchEvent(new Event('timeupdate'))
  await flush()
  assert.equal(h.player.status, 'playing')
})

test('PWA late progress and play settlement after pause cannot restore playing intent', async () => {
  const pending = deferred()
  const h = pwaHarness({ play: (audio) => { audio.paused = false; return pending.promise } })
  h.player.playQueue([item(1), item(2)], 0)
  await flush()
  const audio = h.audio
  audio.currentTime = 0.3; audio.dispatchEvent(new Event('timeupdate'))
  h.player.toggle()
  audio.currentTime = 0.6; audio.dispatchEvent(new Event('timeupdate'))
  pending.resolve()
  await flush()
  assert.equal(h.player.status, 'paused')
  assert.equal(audio.paused, true)
  assert.equal(h.player.current.track.id, 1)
})

test('PWA ignores a late autoplay rejection from a previous song without pausing the new one', async () => {
  const firstPlay = deferred()
  let attempt = 0
  const h = pwaHarness({ play: (audio) => ++attempt === 1 ? firstPlay.promise : audio.begin() })
  h.player.playQueue([item(1), item(2), item(3)], 0)
  await flush()
  const audio = h.audio
  assert.equal(h.player.status, 'loading')
  h.player.playAt(1)
  await flush()
  assert.equal(h.player.current.track.id, 2)
  assert.equal(h.player.status, 'playing')
  assert.equal(h.audio, audio, 'song changes reuse the activated PWA audio element')

  firstPlay.reject(new DOMException('Old song lacked activation', 'NotAllowedError'))
  await flush()
  assert.equal(h.player.current.track.id, 2)
  assert.equal(h.player.status, 'playing', 'an obsolete rejection must not change current playback state')
  assert.equal(audio.paused, false)
  assert.equal(h.messages.length, 0, 'the current song does not need another activation prompt')

  audio.currentTime = 180
  audio.paused = true
  audio.dispatchEvent(new Event('ended'))
  await flush()
  assert.equal(h.player.current.track.id, 3, 'the late rejection must not clear the intent to play the next song')
  assert.equal(h.player.status, 'playing')
  assert.equal(h.audio, audio)
})

test('PWA source renewal keeps the same Audio and listening position', async () => {
  const h = pwaHarness({ resolve: async (track, refresh) => playable(track.id + (refresh ? 1000 : 0)) })
  h.player.playQueue([item(1), item(2)], 0)
  await flush()
  const audio = h.audio
  h.player.seek(42)
  audio.fail(4)
  await flush()
  assert.equal(h.player.status, 'playing')
  assert.equal(h.player.current.track.id, 1)
  assert.equal(h.audio, audio)
  assert.equal(h.audios.length, 1)
  assert.equal(audio.currentTime, 42)
  assert.equal(audio.src, 'https://audio.test/1001')
  assert.deepEqual(h.resolutions.filter(([id]) => id === 1), [[1, false], [1, true]])
  assert.deepEqual(h.sources, ['https://audio.test/1', 'https://audio.test/1001'])
  assert.equal(h.messages.length, 0)
})

test('PWA decoder repair may recreate Audio while preserving the current song and position', async () => {
  const h = pwaHarness({ resolve: async (track, refresh) => playable(track.id + (refresh ? 1000 : 0)) })
  h.player.playQueue([item(1), item(2)], 0)
  await flush()
  const original = h.audio
  h.player.seek(47)
  original.dispatchEvent(new Event('timeupdate'))
  await h.advance(30_000)
  const repaired = h.audio
  assert.notEqual(repaired, original)
  assert.equal(h.audios.length, 2)
  assert.equal(original.paused, true)
  assert.equal(original.src, '')
  assert.equal(repaired.src, 'https://audio.test/1001')
  assert.equal(repaired.currentTime, 47)
  assert.equal(h.player.current.track.id, 1)
  assert.equal(h.player.status, 'playing')
  assert.deepEqual(h.resolutions.filter(([id]) => id === 1), [[1, false], [1, true]])
  original.dispatchEvent(new Event('ended'))
  original.fail(4)
  await flush()
  assert.equal(h.player.current.track.id, 1, 'events from the retired decoder cannot advance the queue')
  assert.equal(h.player.status, 'playing')
  assert.equal(h.messages.length, 0)
})

test('PWA pause during resolution prevents the late URL from starting playback', async () => {
  const pending = deferred()
  const h = pwaHarness({ resolve: () => pending.promise })
  const audio = h.audio
  h.player.playQueue([item(1), item(2)], 0)
  assert.equal(h.player.status, 'loading')
  h.player.toggle()
  pending.resolve(playable(1))
  await flush()
  assert.equal(h.player.status, 'paused')
  assert.equal(h.player.current.track.id, 1)
  assert.equal(audio.plays, 0)
  assert.equal(audio.paused, true)
  assert.deepEqual(h.sources, [])
  assert.equal(h.audios.length, 1)
  h.player.toggle()
  await flush()
  assert.equal(h.player.status, 'playing')
  assert.equal(h.player.current.track.id, 1)
  assert.equal(h.audio, audio)
  assert.deepEqual(h.sources, ['https://audio.test/1'])
})

test('PWA pause during play() rejects late playing events without replacing the prepared source', async () => {
  const pending = deferred()
  let attempt = 0
  const h = pwaHarness({ play: (audio) => ++attempt === 1 ? pending.promise : audio.begin() })
  h.player.playQueue([item(1), item(2)], 0)
  await flush()
  const audio = h.audio
  assert.equal(h.player.status, 'loading')
  h.player.toggle()
  await audio.begin()
  pending.resolve()
  await flush()
  assert.equal(h.player.status, 'paused')
  assert.equal(h.player.current.track.id, 1)
  assert.equal(audio.paused, true, 'a delayed browser playing event honors the newer pause')
  assert.equal(audio.src, 'https://audio.test/1')
  assert.equal(h.audios.length, 1)
  h.player.toggle()
  await flush()
  assert.equal(h.player.status, 'playing')
  assert.equal(h.audio, audio)
  assert.equal(audio.plays, 2)
  assert.deepEqual(h.sources, ['https://audio.test/1'])
  assert.deepEqual(h.resolutions.filter(([id]) => id === 1), [[1, false]])
  assert.equal(h.messages.length, 0)
})

test('PWA starts its prepared next song synchronously at ended without resolving, pausing or unloading', async () => {
  const h = pwaHarness()
  h.player.playQueue([item(1), item(2), item(3)], 0)
  await flush()
  const audio = h.audio
  assert.ok(h.resolutions.some(([id]) => id === 2), 'the next song was resolved before the first finished')
  const resolutions = [...h.resolutions], operationsAt = h.audioOperations.length, plays = audio.plays
  audio.currentTime = 180
  audio.paused = true
  audio.dispatchEvent(new Event('ended'))
  // Deliberadamente no se drenan microtareas: play() debe empezar en la misma llamada de ended.
  assert.equal(audio.plays, plays + 1, 'no asynchronous storage or provider request may precede play()')
  assert.equal(audio.src, 'https://audio.test/2')
  assert.equal(h.audio, audio)
  assert.deepEqual(h.resolutions, resolutions, 'a ready next source must not call api.resolve again')
  assert.deepEqual(h.audioOperations.slice(operationsAt), [
    { type: 'src', value: 'https://audio.test/2' }, { type: 'load', value: 'https://audio.test/2' }, { type: 'play', value: 'https://audio.test/2' },
  ], 'prepared transitions load the new URL without pausing, removing src or loading an empty source')
  await flush()
  assert.equal(h.player.status, 'playing')
  assert.equal(h.player.current.track.id, 2)
})

test('PWA prepares the latest DJ order and never consumes the previously reserved song', async () => {
  const h = pwaHarness()
  h.player.playQueue([item(1), item(2)], 0)
  await flush()
  h.player.addToQueue([item(90), item(91)])
  await flush()
  const key = h.player.userQueue.find(({ item }) => item.track.id === 91).key
  h.player.moveInQueue(key, 0)
  await flush()
  assert.ok(h.resolutions.some(([id]) => id === 91), 'reordering refreshes the prepared next song while audio still plays')
  const before = [...h.resolutions], audio = h.audio, plays = audio.plays
  audio.paused = true
  audio.dispatchEvent(new Event('ended'))
  assert.equal(audio.plays, plays + 1)
  assert.equal(audio.src, 'https://audio.test/91')
  assert.equal(h.player.current.track.id, 91)
  assert.deepEqual(h.resolutions, before)
  await flush()
  assert.deepEqual(h.player.userQueue.map(({ item }) => item.track.id), [90])
})

test('PWA repeated queue entries start synchronously even when they share the same object', async () => {
  const repeated = item(1)
  const h = pwaHarness()
  h.player.playQueue([repeated, repeated, item(2)], 0)
  await flush()
  const audio = h.audio, plays = audio.plays
  audio.paused = true
  audio.dispatchEvent(new Event('ended'))
  assert.equal(audio.plays, plays + 1)
  assert.equal(audio.src, 'https://audio.test/1')
  assert.equal(h.player.current.track.id, 1)
  assert.deepEqual(h.player.upcoming.map(({ item }) => item.track.id), [2], 'the second entry was consumed instead of repeating the first position')
  await flush()
  const resolutions = [...h.resolutions], repeatedPlays = audio.plays
  audio.paused = true
  audio.dispatchEvent(new Event('ended'))
  assert.equal(audio.plays, repeatedPlays + 1)
  assert.equal(audio.src, 'https://audio.test/2')
  assert.deepEqual(h.resolutions, resolutions)
  await flush()
})

test('PWA repeat-one restarts the current song instead of consuming its prepared successor', async () => {
  const h = pwaHarness()
  h.player.cycleRepeat()
  h.player.cycleRepeat()
  h.player.playQueue([item(1), item(2)], 0)
  await flush()
  const audio = h.audio, resolutions = [...h.resolutions], plays = audio.plays
  audio.currentTime = 180
  audio.paused = true
  audio.dispatchEvent(new Event('ended'))
  assert.equal(audio.plays, plays + 1)
  assert.equal(audio.src, 'https://audio.test/1')
  assert.equal(audio.currentTime, 0)
  assert.equal(h.player.current.track.id, 1)
  assert.deepEqual(h.resolutions, resolutions)
  await flush()
  assert.equal(h.player.status, 'playing')
})

test('PWA a prefetch completing during pause never starts audio and is usable after resume', async () => {
  const next = deferred()
  const h = pwaHarness({ resolve: (track) => track.id === 2 ? next.promise : Promise.resolve(playable(track.id)) })
  h.player.playQueue([item(1), item(2)], 0)
  await flush()
  const audio = h.audio, plays = audio.plays
  assert.ok(h.resolutions.some(([id]) => id === 2))
  h.player.toggle()
  next.resolve(playable(2))
  await flush()
  assert.equal(h.player.status, 'paused')
  assert.equal(audio.paused, true)
  assert.equal(audio.plays, plays)
  assert.deepEqual(h.sources, ['https://audio.test/1'])
  h.player.toggle()
  await flush()
  assert.equal(h.player.status, 'playing')
  const resolutions = [...h.resolutions], resumedPlays = audio.plays
  audio.paused = true
  audio.dispatchEvent(new Event('ended'))
  assert.equal(audio.plays, resumedPlays + 1)
  assert.equal(audio.src, 'https://audio.test/2')
  assert.deepEqual(h.resolutions, resolutions)
  await flush()
})

test('PWA choosing the upcoming source replaces its prepared URL before the track ends', async () => {
  let selected = false
  const upcoming = item(2)
  const h = pwaHarness({
    resolve: async (track) => playable(track.id === 2 && selected ? '2-chosen' : track.id),
    chooseSource: async (track, videoId) => { selected = true; return { ...playable(`${track.id}-chosen`), videoId } },
  })
  h.player.playQueue([item(1), upcoming], 0)
  await flush()
  assert.equal(await h.player.useSource('9RfVp-GhKfs', upcoming), true)
  await flush()
  const audio = h.audio, before = [...h.resolutions], plays = audio.plays
  assert.equal(audio.src, 'https://audio.test/1', 'changing a later source must not interrupt the current song')
  audio.paused = true
  audio.dispatchEvent(new Event('ended'))
  assert.equal(audio.plays, plays + 1)
  assert.equal(audio.src, 'https://audio.test/2-chosen')
  assert.deepEqual(h.resolutions, before)
  await flush()
})

test('PWA a pending old prefetch cannot become the reservation after choosing a new source', async () => {
  const old = deferred()
  let selected = false
  const upcoming = item(2)
  const h = pwaHarness({
    resolve: (track) => track.id === 2 ? selected ? Promise.resolve(playable('2-chosen')) : old.promise : Promise.resolve(playable(track.id)),
    chooseSource: async (track, videoId) => { selected = true; return { ...playable(`${track.id}-chosen`), videoId } },
  })
  h.player.playQueue([item(1), upcoming], 0)
  await flush()
  assert.equal(await h.player.useSource('9RfVp-GhKfs', upcoming), true)
  old.resolve(playable('2-old'))
  await flush()
  const audio = h.audio, before = [...h.resolutions], plays = audio.plays
  audio.paused = true
  audio.dispatchEvent(new Event('ended'))
  assert.equal(audio.plays, plays + 1)
  assert.equal(audio.src, 'https://audio.test/2-chosen', 'the pending resolver started before source selection is obsolete')
  assert.deepEqual(h.resolutions, before)
  await flush()
})

test('PWA a late prefetch from the previous collection cannot replace the new next song', async () => {
  const stale = deferred()
  const h = pwaHarness({ resolve: (track) => track.id === 2 ? stale.promise : Promise.resolve(playable(track.id)) })
  h.player.playQueue([item(1), item(2)], 0)
  await flush()
  h.player.playQueue([item(3), item(4)], 0)
  await flush()
  stale.resolve(playable(2))
  await flush()
  const audio = h.audio, before = [...h.resolutions], plays = audio.plays
  assert.equal(audio.src, 'https://audio.test/3')
  audio.paused = true
  audio.dispatchEvent(new Event('ended'))
  assert.equal(audio.plays, plays + 1)
  assert.equal(audio.src, 'https://audio.test/4')
  assert.equal(h.player.current.track.id, 4)
  assert.deepEqual(h.resolutions, before)
  await flush()
})

test('PWA never consumes an expired prepared URL and can resolve a replacement normally', async () => {
  let nextLoads = 0
  const expired = { ...playable(2), url: 'https://audio.test/expired?expire=1' }
  const h = pwaHarness({ resolve: async (track) => track.id === 2 && ++nextLoads === 1 ? expired : playable(track.id) })
  h.player.playQueue([item(1), item(2)], 0)
  await flush()
  const audio = h.audio, plays = audio.plays
  audio.paused = true
  audio.dispatchEvent(new Event('ended'))
  assert.equal(audio.plays, plays, 'an expired reservation must not be sent to the media element')
  assert.ok(!h.sources.includes(expired.url))
  await flush()
  assert.equal(audio.src, 'https://audio.test/2')
  assert.equal(h.player.current.track.id, 2)
  assert.equal(h.player.status, 'playing')
  assert.equal(nextLoads, 2)
})

const verified = (id = 1, extra = {}) => ({ ...playable(id), videoId: '',
  source: { provider: 'verified', id: 'curated-recording', startAt: 8.94, ...extra } })

test('PWA empieza en el silencio verificado y conserva tiempo y duración reales, sin repetir play ni metadata seeks', async () => {
  const h = pwaHarness({ resolve: async () => verified(), duration: () => 187.1804 })
  h.player.playQueue([item(1)], 0)
  await flush()
  assert.equal(h.audio.currentTime, 8.94)
  assert.equal(h.player.time, 8.94)
  assert.equal(h.player.duration, 187.1804, 'the real file duration is never shifted or trimmed')
  assert.equal(h.audio.plays, 1)
  h.audio.currentTime = 23
  h.audio.dispatchEvent(new Event('timeupdate'))
  h.audio.dispatchEvent(new Event('loadedmetadata'))
  assert.equal(h.audio.currentTime, 23, 'repeated metadata cannot restart the source intro')
  h.player.seek(0)
  assert.equal(h.audio.currentTime, 0, 'an explicit seek may replay the original silence')
  h.player.toggle(); h.player.toggle()
  await flush()
  assert.equal(h.audio.currentTime, 0, 'pause/resume preserves the explicit position')
})

test('PWA precarga e inicia la siguiente grabación en el punto verificado dentro del mismo ended', async () => {
  const h = pwaHarness({ resolve: async track => track.id === 2 ? verified(2) : playable(track.id), duration: () => 187.1804 })
  h.player.playQueue([item(1), item(2)], 0)
  await flush()
  const audio = h.audio, before = [...h.resolutions], plays = audio.plays
  audio.paused = true
  audio.dispatchEvent(new Event('ended'))
  assert.equal(audio.plays, plays + 1)
  assert.equal(audio.currentTime, 8.94)
  assert.equal(h.player.current.track.id, 2)
  assert.deepEqual(h.resolutions, before)
  await flush()
  assert.equal(h.player.duration, 187.1804)
})

test('PWA repetir una grabación verificada conserva el archivo y vuelve al inicio audible con un solo play', async () => {
  const h = pwaHarness({ resolve: async () => verified(), duration: () => 187.1804 })
  h.player.cycleRepeat(); h.player.cycleRepeat()
  h.player.playQueue([item(1)], 0)
  await flush()
  const audio = h.audio, resolutions = [...h.resolutions], plays = audio.plays
  audio.currentTime = 187.1804
  audio.paused = true
  audio.dispatchEvent(new Event('ended'))
  assert.equal(audio.currentTime, 8.94)
  assert.equal(audio.plays, plays + 1)
  assert.deepEqual(h.resolutions, resolutions)
  await flush()
  assert.equal(h.player.time, 8.94)
  assert.equal(h.player.duration, 187.1804)
})

test('PWA reconstruir una fuente desde cero vuelve al punto verificado; un seek explícito pendiente conserva cero', async () => {
  const h = pwaHarness({ resolve: async track => verified(track.id) })
  h.player.playQueue([item(1)], 0)
  await flush()
  h.player.seek(0)
  h.audio.fail(4)
  await flush()
  assert.equal(h.audio.currentTime, 8.94)
  assert.equal(h.audio.plays, 2)
  assert.deepEqual(h.resolutions, [[1, false], [1, true]])

  const pending = deferred(), chosen = pwaHarness({ resolve: () => pending.promise })
  chosen.player.playQueue([item(1)], 0)
  chosen.player.seek(0)
  pending.resolve(verified())
  await flush()
  assert.equal(chosen.audio.currentTime, 0)
  assert.equal(chosen.player.time, 0)
  assert.equal(chosen.audio.plays, 1)
})

test('PWA los metadatos tardíos no sustituyen un seek explícito por el inicio verificado tras playing', async () => {
  const play = deferred()
  const h = pwaHarness({ resolve: async () => verified(), play: () => play.promise, metadata: false,
    duration: () => 187.1804 })
  h.player.playQueue([item(1)], 0)
  await flush()
  assert.equal(h.player.status, 'loading')
  h.player.seek(0)
  h.audio.begin()
  h.audio.dispatchEvent(new Event('loadedmetadata'))
  h.audio.dispatchEvent(new Event('durationchange'))
  play.resolve()
  await flush()
  assert.equal(h.audio.currentTime, 0)
  assert.equal(h.player.time, 0)
  assert.equal(h.player.duration, 187.1804)
  assert.equal(h.audio.plays, 1)
})

test('PWA rechaza offsets inválidos o fuera del audio y no aplica el salto a podcasts ni copias sin metadatos verificados', async () => {
  for (const startAt of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER, 61, '8.94']) {
    const h = pwaHarness({ resolve: async () => verified(1, { startAt }) })
    h.player.playQueue([item(1)], 0)
    await flush()
    assert.equal(h.audio.currentTime, 0, `invalid source start ${String(startAt)}`)
    assert.equal(h.player.time, 0)
    assert.equal(h.audio.plays, 1)
  }
  const short = pwaHarness({ resolve: async () => verified(), duration: () => 5 })
  short.player.playQueue([item(1)], 0)
  await flush()
  assert.equal(short.audio.currentTime, 0)
  assert.equal(short.player.time, 0, 'short media invalidates an otherwise bounded source offset')
  for (const [id, source] of [
    [1, { ...playable(1), local: true, url: 'https://app.example/pletina/__audio__/1' }],
    [750_000_000_000_001, verified()],
  ]) {
    const h = pwaHarness({ resolve: async () => source })
    h.player.playQueue([item(id)], 0)
    await flush()
    assert.equal(h.audio.currentTime, 0)
    assert.equal(h.audio.plays, 1)
  }
})

test('PWA la caducidad declarada por la fuente limita la reserva aunque la URL tenga más vigencia', async () => {
  let loads = 0
  const initial = { ...verified(2, { expiresAt: Date.now() + 120_000 }),
    url: 'https://audio.test/first?expire=' + (Math.floor(Date.now() / 1000) + 7200) }
  const h = pwaHarness({ resolve: async track => track.id === 2 ? ++loads === 1 ? initial : verified('fresh') : playable(track.id) })
  h.player.playQueue([item(1), item(2)], 0)
  await flush()
  h.jumpWall(70_000)
  const audio = h.audio, plays = audio.plays
  audio.paused = true
  audio.dispatchEvent(new Event('ended'))
  assert.equal(audio.plays, plays, 'the earlier metadata expiration prevents synchronous reuse')
  await flush()
  assert.equal(loads, 2)
  assert.equal(audio.plays, plays + 1)
  assert.equal(audio.src, 'https://audio.test/fresh')
  assert.equal(audio.currentTime, 8.94)
})

test('PWA una URL anterior al vencimiento declarado tampoco se reutiliza y NaN o infinito no alargan el TTL', async () => {
  for (const sourceExpiry of [Date.now() + 7200_000, NaN, Infinity]) {
    let loads = 0
    const initial = { ...verified(2, { expiresAt: sourceExpiry }),
      url: 'https://audio.test/old' + (Number.isFinite(sourceExpiry) ? '?expire=' + (Math.floor(Date.now() / 1000) + 120) : '') }
    const h = pwaHarness({ resolve: async track => track.id === 2 ? ++loads === 1 ? initial : verified('fresh') : playable(track.id) })
    h.player.playQueue([item(1), item(2)], 0)
    await flush()
    h.jumpWall(6 * 60_000)
    const plays = h.audio.plays
    h.audio.paused = true
    h.audio.dispatchEvent(new Event('ended'))
    assert.equal(h.audio.plays, plays)
    await flush()
    assert.equal(loads, 2)
    assert.equal(h.audio.src, 'https://audio.test/fresh')
  }
})

test('PWA repetir y precargar una aparición duplicada renuevan una fuente que ya ha caducado', async () => {
  for (const repeat of [false, true]) {
    let loads = 0
    const h = pwaHarness({ resolve: async () => verified(++loads, { expiresAt: Date.now() + (loads === 1 ? 120_000 : 3600_000) }) })
    if (repeat) { h.player.cycleRepeat(); h.player.cycleRepeat() }
    h.player.playQueue([item(1), item(1)], 0)
    await flush()
    h.jumpWall(130_000)
    if (!repeat) {
      h.audio.currentTime = 100
      h.audio.dispatchEvent(new Event('timeupdate'))
      await flush()
      assert.deepEqual(h.resolutions, [[1, false], [1, true]])
    }
    const plays = h.audio.plays
    h.audio.paused = true
    h.audio.dispatchEvent(new Event('ended'))
    if (repeat) assert.equal(h.audio.plays, plays, 'repeat waits for a fresh source rather than reopening an expired URL')
    await flush()
    assert.equal(h.audio.src, 'https://audio.test/2')
    assert.equal(h.audio.currentTime, 8.94)
    assert.equal(h.audio.plays, plays + 1)
    assert.equal(loads, 2)
  }
})

test('PWA sleep at end stops instead of starting the already prepared next source', async () => {
  const h = pwaHarness()
  h.player.playQueue([item(1), item(2)], 0)
  await flush()
  assert.equal(await h.player.setSleepTimer(-1), true)
  const audio = h.audio, plays = audio.plays
  audio.paused = true
  audio.dispatchEvent(new Event('ended'))
  await flush()
  assert.equal(audio.plays, plays)
  assert.equal(h.player.status, 'paused')
  assert.equal(h.player.current.track.id, 1)
  assert.deepEqual(h.sources, ['https://audio.test/1'])
})

test('PWA prepares podcast resume position before ended and starts synchronously at that position', async () => {
  const first = 750_000_000_000_001, second = first + 1
  const progress = new Map([[first, { position: 23, completed: false }], [second, { position: 71, completed: false }]])
  const h = pwaHarness({ progress })
  h.player.playQueue([item(first), item(second)], 0)
  await flush()
  const audio = h.audio, plays = audio.plays, reads = [...h.progressReads]
  assert.equal(audio.currentTime, 23)
  assert.ok(reads.includes(second), 'the next episode position is read while the first is still active')
  audio.currentTime = 180
  audio.paused = true
  audio.dispatchEvent(new Event('ended'))
  assert.equal(audio.plays, plays + 1)
  assert.equal(audio.currentTime, 71)
  assert.deepEqual(h.progressReads, reads, 'no IndexedDB read may precede the prepared episode play')
  assert.equal(h.progressWrites.findLast((row) => row.id === first).completed, true)
  await flush()
})

test('PWA a repeated completed podcast restarts at zero instead of its earlier resume point', async () => {
  const id = 750_000_000_000_001
  const h = pwaHarness({ progress: new Map([[id, { position: 37, completed: false }]]) })
  const episode = item(id)
  h.player.playQueue([episode, episode], 0)
  await flush()
  assert.equal(h.audio.currentTime, 37)
  h.audio.currentTime = 180
  h.audio.paused = true
  h.audio.dispatchEvent(new Event('ended'))
  assert.equal(h.audio.currentTime, 0)
  await flush()
})

test('PWA permanent RSS reserves do not expire during a long current episode', async () => {
  const first = 750_000_000_000_001, second = first + 1
  const h = pwaHarness({ resolve: async (track) => ({ ...playable(track.id), videoId: '' }) })
  h.player.playQueue([item(first), item(second)], 0)
  await flush()
  const audio = h.audio, plays = audio.plays, resolutions = [...h.resolutions]
  h.jumpWall(65 * 60_000)
  audio.currentTime = 180
  audio.paused = true
  audio.dispatchEvent(new Event('ended'))
  assert.equal(audio.plays, plays + 1, 'a permanent RSS URL remains synchronously usable after an hour')
  assert.deepEqual(h.resolutions, resolutions)
  await flush()
})

for (const expiry of ['url', 'source']) test(`PWA resumes a paused YouTube podcast only after refreshing its expired ${expiry}`, async () => {
  const id = 750_000_000_000_001, renewal = deferred(), now = Date.now()
  const original = { ...playable(id), videoId: '9RfVp-GhKfs',
    url: 'https://r1.googlevideo.com/podcast-old?expire=' + (Math.floor(now / 1000) + (expiry === 'url' ? 120 : 7200)),
    ...(expiry === 'source' ? { source: { provider: 'youtube-p1', id: '9RfVp-GhKfs', expiresAt: now + 120_000, download: { allowed: false } } } : {}) }
  const h = pwaHarness({ resolve: (_track, refresh) => refresh ? renewal.promise : original })
  h.player.playQueue([item(id)], 0); await flush()
  h.audio.currentTime = 37; h.audio.dispatchEvent(new Event('timeupdate')); h.player.toggle()
  h.jumpWall(70_000)
  const audio = h.audio, plays = audio.plays
  h.player.toggle(); await flush()
  assert.deepEqual(h.resolutions, [[id, false], [id, true]], 'Refresh must precede another attempt to play the expired URL')
  assert.equal(audio.plays, plays); assert.equal(audio.paused, true); assert.equal(h.player.status, 'loading')
  const fresh = { ...original, url: 'https://r1.googlevideo.com/podcast-fresh?expire=' + (Math.floor(now / 1000) + 7200), source: undefined }
  renewal.resolve(fresh); await flush()
  assert.equal(h.player.current.track.id, id); assert.equal(h.player.status, 'playing')
  assert.equal(h.player.time, 37); assert.equal(audio.currentTime, 37)
  assert.equal(audio.plays, plays + 1); assert.equal(h.audio, audio); assert.equal(h.audios.length, 1)
  assert.deepEqual(h.sources, [original.url, fresh.url]); assert.deepEqual(h.messages, [])
})

for (const mode of ['pause', 'replace']) test(`PWA a late podcast renewal cannot undo a newer ${mode} intent`, async () => {
  const id = 750_000_000_000_001, renewal = deferred(), now = Date.now()
  const original = { ...playable(id), videoId: '9RfVp-GhKfs',
    url: 'https://r1.googlevideo.com/podcast-old?expire=' + (Math.floor(now / 1000) + 120) }
  const h = pwaHarness({ resolve: (track, refresh) => track.id !== id ? playable(track.id) : refresh ? renewal.promise : original })
  h.player.playQueue([item(id)], 0); await flush()
  h.audio.currentTime = 37; h.audio.dispatchEvent(new Event('timeupdate')); h.player.toggle(); h.jumpWall(70_000)
  const plays = h.audio.plays
  h.player.toggle(); await flush()
  assert.deepEqual(h.resolutions.filter(([value]) => value === id), [[id, false], [id, true]])
  assert.equal(h.audio.plays, plays)
  if (mode === 'pause') h.player.toggle()
  else h.player.playQueue([item(7)], 0)
  await flush()
  const current = h.player.current.track.id, status = h.player.status, source = h.audio.src, settledPlays = h.audio.plays
  renewal.resolve({ ...original, url: 'https://r1.googlevideo.com/late-podcast?expire=' + (Math.floor(now / 1000) + 7200) })
  await flush()
  assert.equal(h.player.current.track.id, current); assert.equal(h.player.status, status)
  assert.equal(h.audio.src, source); assert.equal(h.audio.plays, settledPlays)
  assert.ok(!h.sources.some(url => url.includes('late-podcast')))
  if (mode === 'pause') { assert.equal(status, 'paused'); assert.equal(h.player.time, 37) }
  else { assert.equal(current, 7); assert.equal(status, 'playing') }
  assert.deepEqual(h.messages, [])
})

for (const kind of ['rss', 'youtube-valid']) test(`PWA a paused ${kind} episode keeps its still-usable source and position`, async () => {
  const id = 750_000_000_000_001, now = Date.now(), source = kind === 'rss'
    ? { ...playable(id), videoId: '', url: 'https://audio.example.org/published-episode.mp3' }
    : { ...playable(id), videoId: '9RfVp-GhKfs', url: 'https://r1.googlevideo.com/podcast-valid?expire=' + (Math.floor(now / 1000) + 7200) }
  const h = pwaHarness({ resolve: () => source })
  h.player.playQueue([item(id)], 0); await flush()
  h.audio.currentTime = 37; h.audio.dispatchEvent(new Event('timeupdate')); h.player.toggle()
  h.jumpWall(kind === 'rss' ? 65 * 60_000 : 120_000)
  const plays = h.audio.plays
  h.player.toggle(); await flush()
  assert.equal(h.player.status, 'playing'); assert.equal(h.audio.currentTime, 37)
  assert.equal(h.audio.plays, plays + 1); assert.deepEqual(h.resolutions, [[id, false]])
  assert.deepEqual(h.sources, [source.url]); assert.deepEqual(h.messages, [])
})

test('PWA refreshes a temporary upcoming podcast while current audio still advances', async () => {
  const id = 750_000_000_000_001
  let prepared = 0
  const h = pwaHarness({ resolve: async (track) => track.id !== id ? playable(track.id) : {
    ...playable(id), videoId: '9RfVp-GhKfs', url: `https://r1.googlevideo.com/a${++prepared}?expire=${Math.floor(Date.now() / 1000) + (prepared === 1 ? 180 : 7200)}`,
  } })
  h.player.playQueue([item(1), item(id)], 0)
  await flush()
  const audio = h.audio
  h.jumpWall(70_000)
  audio.currentTime = 70
  audio.dispatchEvent(new Event('timeupdate'))
  await flush()
  assert.deepEqual(h.resolutions.filter(([value]) => value === id), [[id, false], [id, true]])
  const plays = audio.plays, resolutions = [...h.resolutions]
  audio.currentTime = 180
  audio.paused = true
  audio.dispatchEvent(new Event('ended'))
  assert.equal(audio.plays, plays + 1)
  assert.match(audio.src, /\/a2\?/)
  assert.deepEqual(h.resolutions, resolutions)
  await flush()
})

test('PWA temporary source refresh backs off after failure and keeps an unexpired reservation', async () => {
  let loads = 0
  const original = { ...playable(2), videoId: '9RfVp-GhKfs', url: `https://r1.googlevideo.com/a?expire=${Math.floor(Date.now() / 1000) + 180}` }
  const h = pwaHarness({ resolve: async (track) => {
    if (track.id !== 2) return playable(track.id)
    if (++loads === 1) return original
    throw new Error('Temporary network failure')
  } })
  h.player.playQueue([item(1), item(2)], 0)
  await flush()
  h.jumpWall(70_000)
  for (let i = 0; i < 8; i++) { h.audio.currentTime = 70 + i; h.audio.dispatchEvent(new Event('timeupdate')); await flush() }
  assert.equal(loads, 2, 'repeated timeupdate events must not retry a failing provider continuously')
  const plays = h.audio.plays
  h.audio.paused = true
  h.audio.dispatchEvent(new Event('ended'))
  assert.equal(h.audio.plays, plays + 1, 'the original source remains usable before its conservative expiry')
  assert.equal(h.audio.src, original.url)
  await flush()
})

test('PWA a late saved position from a cancelled preparation cannot replace the current DJ reserve', async () => {
  const first = 750_000_000_000_001, second = first + 1
  const position = deferred()
  const h = pwaHarness({ progressPosition: (id) => id === first ? position.promise : Promise.resolve(52) })
  h.player.playQueue([item(1), item(first)], 0)
  await flush()
  h.player.playNext([item(second)])
  await flush()
  position.resolve(99)
  await flush()
  const plays = h.audio.plays
  h.audio.paused = true
  h.audio.dispatchEvent(new Event('ended'))
  assert.equal(h.audio.plays, plays + 1)
  assert.equal(h.player.current.track.id, second)
  assert.equal(h.audio.currentTime, 52)
  await flush()
})

test('PWA cached audio uses only the same-origin service worker media route and remains local', async () => {
  for (const origin of ['https://app.example', 'http://127.0.0.1:4174', 'http://localhost:4174', 'http://[::1]:4174']) {
    const url = origin + '/pletina/__audio__/12'
    const h = pwaHarness({ location: origin + '/pletina/application/app.html', resolve: async () => ({ ...playable(12), local: true, url }) })
    h.player.playQueue([item(12)], 0)
    await flush()
    assert.equal(h.audio.src, url)
    assert.equal(h.player.status, 'playing')
    h.audio.fail(4)
    await flush()
    assert.deepEqual(h.resolutions, [[12, false]], 'a cached local source must not be refreshed as a remote stream')
  }
})

test('PWA rejects downloaded sources outside its scope, origin or stable numeric route', async () => {
  for (const url of ['https://other.example/pletina/__audio__/12', 'https://app.example/other/__audio__/12',
    'https://app.example/pletina/__audio__/12?token=secret', 'https://app.example/pletina/__audio__/12#x',
    'https://app.example/pletina/__audio__/%31%32', 'https://app.example/pletina/__audio__/12/extra',
    'https://app.example/pletina/__audio__/9007199254740992', 'https://user:pass@app.example/pletina/__audio__/12',
    'http://app.example/pletina/__audio__/12', 'blob:https://app.example/12', 'file:///music/12.mp3', '/music/12.mp3']) {
    const h = pwaHarness({ resolve: async () => ({ ...playable(12), local: true, url }) })
    h.player.playQueue([item(12)], 0)
    await flush()
    assert.equal(h.audio.plays, 0, `must reject ${url}`)
    assert.deepEqual(h.sources, [])
    assert.ok(h.messages.some((message) => message.includes('dirección local válida')))
  }
})

const officialSource = { videoId: 'fV-IUsecSsU', title: 'Canción', artists: 'Artista', album: null,
  duration: 170, score: 90, current: false, origin: 'music' }

test('PWA active unavailable source opens prepared official playback without skipping the song or resolving again', async () => {
  const unavailable = new Error('Direct source rejected')
  const h = pwaHarness({ resolve: async () => { throw unavailable },
    automaticYouTubeSource: (_track, error) => error === unavailable ? officialSource : null })
  h.player.playQueue([item(1), item(2)], 0)
  await flush()
  assert.equal(h.player.current.track.id, 1)
  assert.equal(h.player.pos, 0)
  assert.deepEqual(h.resolutions, [[1, false]], 'No new search or next-track start')
  assert.deepEqual(h.officialOpens, [{ id: 1, videoId: 'fV-IUsecSsU', at: 0, status: 'paused', audioPaused: true, src: '' }])
  assert.deepEqual(h.sources, [])
  assert.deepEqual(h.messages, [], 'A handled direct-source rejection is not reported as a skipped song')
})

test('PWA late unavailable result after pause or next cannot open an automatic video', async () => {
  for (const action of ['pause', 'next']) {
    const pending = deferred(), unavailable = new Error('Late unavailable source')
    const h = pwaHarness({ resolve: track => track.id === 1 ? pending.promise : Promise.resolve(playable(track.id)),
      automaticYouTubeSource: (_track, error) => error === unavailable ? officialSource : null })
    h.player.playQueue([item(1), item(2)], 0)
    await flush()
    if (action === 'pause') h.player.toggle()
    else h.player.next()
    pending.reject(unavailable)
    await flush()
    assert.deepEqual(h.officialOpens, [], action)
    assert.equal(h.player.current.track.id, action === 'pause' ? 1 : 2)
    assert.equal(h.player.status, action === 'pause' ? 'paused' : 'playing')
  }
})

test('PWA prefetch rejection never opens the official player while another song is playing', async () => {
  const unavailable = new Error('Upcoming source rejected')
  const h = pwaHarness({ resolve: async track => { if (track.id === 2) throw unavailable; return playable(track.id) },
    automaticYouTubeSource: (_track, error) => error === unavailable ? officialSource : null })
  h.player.playQueue([item(1), item(2)], 0)
  await flush()
  assert.ok(h.resolutions.some(([id]) => id === 2), 'The next source was actually requested')
  assert.deepEqual(h.officialOpens, [])
  assert.equal(h.player.current.track.id, 1)
  assert.equal(h.player.status, 'playing')
})

test('PWA unavailable renewal carries listening position to automatic playback and clears direct Audio first', async () => {
  const unavailable = new Error('Renewed direct source rejected')
  const h = pwaHarness({ resolve: async (track, refresh) => { if (refresh) throw unavailable; return playable(track.id) },
    automaticYouTubeSource: (_track, error) => error === unavailable ? officialSource : null })
  h.player.playQueue([item(1)], 0)
  await flush()
  h.audio.currentTime = 47
  h.audio.dispatchEvent(new Event('timeupdate'))
  h.audio.fail(4)
  await flush()
  assert.deepEqual(h.resolutions, [[1, false], [1, true]])
  assert.deepEqual(h.officialOpens, [{ id: 1, videoId: 'fV-IUsecSsU', at: 47, status: 'paused', audioPaused: true, src: '' }])
  assert.equal(h.player.current.track.id, 1)
})

test('PWA rejected official launch returns to the bounded normal failure path', async () => {
  const unavailable = new Error('No compatible source')
  const h = pwaHarness({ resolve: async track => { if (track.id === 1) throw unavailable; return playable(track.id) },
    automaticYouTubeSource: (_track, error) => error === unavailable ? officialSource : null,
    openAutomaticYouTubePlayer: () => false })
  h.player.playQueue([item(1), item(2)], 0)
  await flush()
  assert.equal(h.officialOpens.length, 1)
  assert.equal(h.player.current.track.id, 2)
  assert.equal(h.player.status, 'playing')
  assert.equal(h.messages.length, 1)
})

const localAudio = id => ({ ...playable(id), local: true, url: `https://app.example/pletina/__audio__/${id}` })

test('PWA offline cold selection skips more than three unavailable songs without resolving remote sources', async () => {
  const h = pwaHarness({ online: false, downloaded: new Set([6]), readDownloaded: async id => id === 6 ? localAudio(id) : null })
  h.player.playQueue([1, 2, 3, 4, 5, 6].map(id => item(id)), 0)
  await flush()
  assert.equal(h.player.current.track.id, 6)
  assert.equal(h.player.status, 'playing')
  assert.deepEqual(h.resolutions, [], 'being offline must never invoke a source extractor, including prefetch')
  assert.deepEqual(h.sources, [localAudio(6).url])
  assert.ok(h.offlineReads.every(id => id === 1 || id === 6))
  assert.equal(h.audios.length, 1)
})

test('PWA offline ended skips unavailable entries and starts the verified local reserve synchronously', async () => {
  const h = pwaHarness({ online: false, downloaded: new Set([1, 6]), readDownloaded: async id => [1, 6].includes(id) ? localAudio(id) : null })
  h.player.playQueue([1, 2, 3, 4, 5, 6].map(id => item(id)), 0)
  await flush()
  const audio = h.audio, plays = audio.plays, reads = [...h.offlineReads]
  audio.paused = true
  audio.dispatchEvent(new Event('ended'))
  assert.equal(audio.plays, plays + 1, 'local storage must be read during preparation, not between ended and play')
  assert.equal(audio.src, localAudio(6).url)
  assert.deepEqual(h.offlineReads, reads)
  await flush()
  assert.equal(h.player.current.track.id, 6)
  assert.equal(h.player.status, 'playing')
  assert.equal(h.audios.length, 1)
  assert.deepEqual(h.resolutions, [])
})

test('PWA offline DJ order validates stale download markers and resumes the main queue after available requests', async () => {
  const downloaded = new Set([1, 4, 91, 92, 93])
  const h = pwaHarness({ online: false, downloaded, readDownloaded: async id => id !== 91 && downloaded.has(id) ? localAudio(id) : null })
  h.player.playQueue([1, 2, 3, 4].map(id => item(id)), 0)
  await flush()
  h.player.addToQueue([90, 91, 92, 93].map(id => item(id)))
  await flush()
  assert.ok(!downloaded.has(91), 'missing cache reconciles a stale downloaded marker')
  for (const expected of [92, 93, 4]) {
    h.audio.paused = true
    h.audio.dispatchEvent(new Event('ended'))
    await flush()
    assert.equal(h.player.current.track.id, expected)
    assert.equal(h.player.status, 'playing')
  }
  assert.deepEqual(h.player.userQueue, [])
  assert.equal(h.player.pos, 3)
  assert.deepEqual(h.resolutions, [])
})

test('PWA offline repeat-all follows the existing shuffled order and wraps without retrying skipped positions', async () => {
  const available = new Set([2, 4])
  const h = pwaHarness({ online: false, downloaded: available, readDownloaded: async id => available.has(id) ? localAudio(id) : null })
  h.player.playQueue([1, 2, 3, 4, 5].map(id => item(id)), 3)
  await flush()
  h.player.shuffle = true
  h.player.order = [3, 0, 4, 2, 1]
  h.player.pos = 0
  h.player.cycleRepeat()
  await flush()
  h.player.next()
  await flush()
  assert.equal(h.player.current.track.id, 2)
  assert.equal(h.player.pos, 4)
  h.player.next()
  await flush()
  assert.equal(h.player.current.track.id, 4)
  assert.equal(h.player.pos, 0)
  assert.deepEqual(h.player.order, [3, 0, 4, 2, 1])
  assert.deepEqual(h.resolutions, [])
})

test('PWA offline corrupt local copies cannot loop through repeat-all or stop before a later valid download', async () => {
  const available = new Set([1, 2, 3, 4, 5])
  const h = pwaHarness({ online: false, downloaded: available, readDownloaded: async id => localAudio(id),
    play: audio => {
      if (!audio.src.endsWith('/5')) { audio.error = { code: 3 }; return Promise.reject(new Error('Corrupt cached bytes')) }
      return audio.begin()
    } })
  h.player.cycleRepeat()
  h.player.playQueue([1, 2, 3, 4, 5].map(id => item(id)), 0)
  // Five independent storage + play rejection chains, not a real timer/backoff.
  for (let pass = 0; pass < 6; pass++) await flush()
  assert.equal(h.player.current.track.id, 5)
  assert.equal(h.player.status, 'playing')
  assert.equal(h.audio.plays, 5, 'each failed cache is attempted at most once despite repeat-all')
  assert.deepEqual(h.resolutions, [])
  h.audio.fail(3)
  await flush()
  assert.equal(h.player.status, 'idle')
  assert.equal(h.audio.plays, 5, 'exhausted repeat-all must stop, not replay known broken downloads')
  assert.ok(h.messages.some(message => message.includes('Sin conexión') && message.includes('descargad')))
})

test('PWA offline absence of downloads stops explicitly without showing the official video fallback', async () => {
  const h = pwaHarness({ online: false, automaticYouTubeSource: () => officialSource })
  h.player.cycleRepeat()
  h.player.playQueue([item(1), item(2)], 0)
  await flush()
  assert.equal(h.player.status, 'idle')
  assert.equal(h.audio.plays, 0)
  assert.deepEqual(h.resolutions, [])
  assert.deepEqual(h.officialOpens, [])
  assert.ok(h.messages.some(message => message.includes('Sin conexión') && message.includes('descargad')))
})

test('PWA offline previous scans backward for a local copy instead of bouncing forward or opening a remote source', async () => {
  const available = new Set([1, 5])
  const h = pwaHarness({ online: false, downloaded: available, readDownloaded: async id => available.has(id) ? localAudio(id) : null })
  h.player.playQueue([1, 2, 3, 4, 5].map(id => item(id)), 4)
  await flush()
  h.player.prev()
  await flush()
  assert.equal(h.player.current.track.id, 1)
  assert.equal(h.player.pos, 0)
  assert.equal(h.player.status, 'playing')
  assert.deepEqual(h.resolutions, [])
})

test('PWA switching offline retires pending network work and late results cannot replace the downloaded selection', async () => {
  const remote = deferred()
  const h = pwaHarness({ resolve: () => remote.promise, downloaded: new Set([4]), readDownloaded: async id => id === 4 ? localAudio(id) : null })
  h.player.playQueue([1, 2, 3, 4].map(id => item(id)), 0)
  await flush()
  h.setOnline(false)
  await flush()
  assert.equal(h.player.current.track.id, 4)
  assert.equal(h.player.status, 'playing')
  remote.resolve(playable(1))
  await flush()
  assert.deepEqual(h.sources, [localAudio(4).url])
  assert.equal(h.audios.length, 1)
})

test('PWA cancelled or replaced offline reads cannot autoplay or advance the newest selection', async () => {
  for (const action of ['pause', 'replace']) {
    const old = deferred()
    const h = pwaHarness({ online: false, downloaded: new Set([1, 2]), readDownloaded: id => id === 1 ? old.promise : Promise.resolve(localAudio(id)) })
    h.player.playQueue([item(1), item(2)], 0)
    await flush()
    if (action === 'pause') h.player.toggle()
    else h.player.playAt(1)
    await flush()
    old.resolve(null)
    await flush()
    assert.equal(h.player.current.track.id, action === 'pause' ? 1 : 2)
    assert.equal(h.player.status, action === 'pause' ? 'paused' : 'playing')
    assert.deepEqual(h.sources, action === 'pause' ? [] : [localAudio(2).url])
    assert.deepEqual(h.resolutions, [])
  }
})

test('PWA offline repeat-one repeats a playable copy but escapes a broken one to another downloaded song', async () => {
  const available = new Set([1, 4])
  const h = pwaHarness({ online: false, downloaded: available, readDownloaded: async id => available.has(id) ? localAudio(id) : null })
  h.player.cycleRepeat(); h.player.cycleRepeat()
  h.player.playQueue([1, 2, 3, 4].map(id => item(id)), 0)
  await flush()
  const audio = h.audio, plays = audio.plays
  audio.paused = true
  audio.dispatchEvent(new Event('ended'))
  assert.equal(audio.plays, plays + 1)
  assert.equal(h.player.current.track.id, 1)
  await flush()
  audio.fail(4)
  await flush()
  assert.equal(h.player.current.track.id, 4)
  assert.equal(h.player.repeat, 'one')
  assert.equal(h.player.status, 'playing')
  assert.deepEqual(h.resolutions, [])
})

test('PWA offline restored queue resolves the stored copy at its saved position without autoplay on reopening', async () => {
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
  const options = { online: false, storage, downloaded: new Set([1, 3]), readDownloaded: async id => [1, 3].includes(id) ? localAudio(id) : null }
  const previous = pwaHarness(options)
  previous.player.playQueue([item(1), item(2), item(3)], 0, 'Lista sin conexión')
  await flush()
  previous.audio.currentTime = 47
  previous.audio.dispatchEvent(new Event('timeupdate'))
  previous.player.toggle()
  await flush()
  const h = pwaHarness(options)
  assert.equal(h.player.status, 'paused')
  assert.equal(h.player.current.track.id, 1)
  assert.equal(h.player.time, 47)
  assert.equal(h.audio.plays, 0)
  assert.deepEqual(h.offlineReads, [])
  h.player.toggle()
  await flush()
  assert.equal(h.player.status, 'playing')
  assert.equal(h.audio.currentTime, 47)
  assert.equal(h.player.context, 'Lista sin conexión')
  assert.deepEqual(h.resolutions, [])
})

test('PWA offline downloaded verified offsets survive startup and repeat while explicit seek-zero stays available', async () => {
  const local = { ...localAudio(1), source: { provider: 'verified', id: 'bounded-source', startAt: 8.94 } }
  const h = pwaHarness({ online: false, downloaded: new Set([1]), readDownloaded: async () => local })
  h.player.cycleRepeat(); h.player.cycleRepeat()
  h.player.playQueue([item(1)], 0)
  await flush()
  assert.equal(h.audio.currentTime, 8.94)
  assert.equal(h.player.duration, 180, 'the UI keeps the actual file duration')
  h.player.seek(0)
  assert.equal(h.audio.currentTime, 0)
  h.audio.paused = true
  h.audio.dispatchEvent(new Event('ended'))
  await flush()
  assert.equal(h.audio.currentTime, 8.94)
  assert.equal(h.audios.length, 1)
  for (const startAt of [-1, NaN, Infinity, 61, 180]) {
    const invalid = pwaHarness({ online: false, downloaded: new Set([1]), readDownloaded: async () => ({ ...local, source: { ...local.source, startAt } }) })
    invalid.player.playQueue([item(1)], 0)
    await flush()
    assert.equal(invalid.audio.currentTime, 0, `reject unbounded offset ${startAt}`)
  }
})

test('PWA offline never accepts a remote value from the local-copy facade or reuses an earlier remote preparation', async () => {
  const h = pwaHarness({ downloaded: new Set([1, 2, 3]), readDownloaded: async id => id === 3 ? localAudio(3) : playable(id) })
  h.player.playQueue([item(1), item(2), item(3)], 0)
  await flush()
  assert.ok(h.resolutions.some(([id]) => id === 2), 'the old next source really was prepared online')
  h.setOnline(false)
  await flush()
  h.audio.paused = true
  h.audio.dispatchEvent(new Event('ended'))
  await flush()
  assert.equal(h.player.current.track.id, 3)
  assert.equal(h.audio.src, localAudio(3).url)
  assert.deepEqual(h.sources, ['https://audio.test/1', localAudio(3).url])
  assert.deepEqual(h.officialOpens, [])
})

test('PWA offline explicit selection validates an existing copy even when its downloaded hint has not caught up', async () => {
  const downloaded = new Set()
  const h = pwaHarness({ online: false, downloaded, readDownloaded: async id => localAudio(id) })
  h.player.playQueue([item(9)], 0)
  await flush()
  assert.equal(h.player.status, 'playing')
  assert.equal(h.audio.src, localAudio(9).url)
  assert.ok(downloaded.has(9))
  assert.deepEqual(h.resolutions, [])
})

test('PWA reconnection during a pending local read retries the same selection online and ignores its late missing-cache result', async () => {
  const local = deferred(), downloaded = new Set([1, 2])
  const h = pwaHarness({ online: false, downloaded, readDownloaded: () => local.promise })
  h.player.playQueue([item(1), item(2)], 0)
  await flush()
  assert.equal(h.player.status, 'loading')
  h.setOnline(true)
  await flush()
  assert.equal(h.player.status, 'playing')
  assert.equal(h.player.current.track.id, 1)
  local.resolve(null)
  await flush()
  assert.equal(h.player.current.track.id, 1)
  assert.ok(downloaded.has(1), 'an obsolete local read must not remove a newer downloaded hint')
  assert.deepEqual(h.sources, ['https://audio.test/1'])
})
