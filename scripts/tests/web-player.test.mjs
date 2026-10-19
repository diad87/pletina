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
  location = 'https://app.example/pletina/application/app.html',
  chooseSource = async (track, videoId) => ({ ...playable(track.id), videoId }) } = {}) {
  const audios = [], sources = [], resolutions = [], messages = [], records = [], audioOperations = [], sourceChoices = []
  const progressReads = [], progressWrites = []
  const events = new EventTarget()
  events.location = { href: location }
  const timers = new Map()
  const audioSession = { type: 'auto' }
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
    exports, Audio, { audioSession }, undefined,
    (fn, delay) => { const id = ++timerId; timers.set(id, { at: now + delay, fn }); return id },
    (id) => timers.delete(id), events, events, { now: () => now }, Clock,
  )
  return {
    player: exports.player, audios, sources, resolutions, messages, records, audioSession, audioOperations, sourceChoices, progressReads, progressWrites,
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
