// Ejecuta el Player real con api.inPwa=true; no valida políticas ni decoders del navegador.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { compileModule } from 'svelte/compiler'
import * as svelte from 'svelte/internal/client'
import ts from 'typescript'
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
function pwaHarness({ resolve = async (track) => playable(track.id), play,
  chooseSource = async (track, videoId) => ({ ...playable(track.id), videoId }) } = {}) {
  const audios = [], sources = [], resolutions = [], messages = [], records = [], audioOperations = [], sourceChoices = []
  const events = new EventTarget()
  const timers = new Map()
  const audioSession = { type: 'auto' }
  let now = 0, timerId = 0
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
        this.duration = 180
        this.dispatchEvent(new Event('loadedmetadata'))
        this.dispatchEvent(new Event('durationchange'))
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
      resolve(track, refresh) { resolutions.push([track.id, refresh]); return resolve(track, refresh) },
      chooseSource(track, videoId) { sourceChoices.push([track.id, videoId]); return chooseSource(track, videoId) },
      recordPlay: async (value) => { records.push(value.track.id) },
    },
    './downloads.svelte': { downloads: { done: new Set(), start() {} } },
    './extractor/capture': {
      stopCapture() {},
      setAudioSource(audio, url) { audio.src = url; audio.load(); sources.push(url) },
    },
    './library.svelte': { library: { historyVersion: 0 }, toLib: (value) => value },
    './media': { isPodcast: () => false, isYouTubeTrack: () => false, mediaUrl: (value) => value },
    './toast.svelte': { toast: { show: (message) => messages.push(message) } },
    './podcast-progress.svelte': { episodeProgress: { position: async () => 0, save: async () => {}, flush: async () => {} } },
    './player-android.svelte': { isAndroid: false },
    './queue': { ...queue, load: (_key, fallback) => fallback, save() {} },
    './sleep-timer': sleepTimer,
  }
  const exports = {}
  new Function('require', 'exports', 'Audio', 'navigator', 'MediaMetadata', 'setTimeout', 'clearTimeout', 'window', 'document', 'performance', compiled)(
    (name) => { assert.ok(name in modules, `Unmocked PWA dependency: ${name}`); return modules[name] },
    exports, Audio, { audioSession }, undefined,
    (fn, delay) => { const id = ++timerId; timers.set(id, { at: now + delay, fn }); return id },
    (id) => timers.delete(id), events, events, { now: () => now },
  )
  return {
    player: exports.player, audios, sources, resolutions, messages, records, audioSession, audioOperations, sourceChoices,
    get audio() { return audios.at(-1) },
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
