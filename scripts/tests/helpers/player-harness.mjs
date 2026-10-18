// Ejecuta el reproductor real, compilando TypeScript y las runas de Svelte con las dependencias del proyecto.
// Los adaptadores Audio/IPC y el reloj son simulados: no valida red, transporte de captura ni códecs.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { compileModule } from 'svelte/compiler'
import * as svelte from 'svelte/internal/client'
import ts from 'typescript'

const source = await readFile(new URL('../../../src/lib/player.svelte.ts', import.meta.url), 'utf8')
const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText
const compiled = ts.transpileModule(compileModule(javascript, { filename: 'player.svelte.js' }).js.code, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText
const queueSource = await readFile(new URL('../../../src/lib/queue.ts', import.meta.url), 'utf8')
const queue = {}
new Function('exports', ts.transpileModule(queueSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText)(queue)

export const sleepTimer = {}
new Function('exports', ts.transpileModule(await readFile(new URL('../../../src/lib/sleep-timer.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText)(sleepTimer)

export const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
export const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
export const item = (id = 1) => ({
  track: { id, title: `Canción ${id}`, duration: 180, artist: { id: 1, name: 'Artista' } },
  albumId: 1, albumTitle: 'Álbum', artistId: 1, cover: null,
})
export const playable = (id = 1, local = false) => ({ url: local ? `/music/${id}.mp3` : `https://audio.test/${id}`, local })

export function harness({ resolve = async (track) => playable(track.id), play, mediaSession, metadata,
  progress = new Map(), duration = () => 180, inTauri = false, flushProgress = async () => {} } = {}) {
  const audios = [], messages = [], resolutions = [], sources = [], records = []
  const events = new EventTarget()
  let closeHandler, destroyed = false
  const timers = new Map()
  let now = 0, timerId = 0, stopped = 0
  let wall = 1_700_000_000_000
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [wall])) }
    static now() { return wall }
  }
  class Audio extends EventTarget {
    src = ''
    currentTime = 0
    duration = NaN
    paused = true
    error = null
    playbackRate = 1
    loads = 0
    plays = 0
    constructor() { super(); audios.push(this) }
    play() {
      this.plays++
      if (!Number.isFinite(this.duration)) {
        this.duration = duration(this)
        this.dispatchEvent(new Event('loadedmetadata'))
        this.dispatchEvent(new Event('durationchange'))
      }
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
    '@tauri-apps/api/window': { getCurrentWindow: () => ({
      onCloseRequested: async (fn) => { closeHandler = fn }, destroy: async () => { destroyed = true },
    }) },
    './api': {
      inTauri,
      resolve: (track, refresh) => { resolutions.push([track.id, refresh]); return resolve(track, refresh) },
      chooseSource: (track) => resolve(track, true),
      recordPlay: async (item) => { records.push(item.track.id) },
    },
    './downloads.svelte': { downloads: { done: new Set(), start: () => {} } },
    './extractor/capture': {
      stopCapture: () => { stopped++ },
      setAudioSource: (audio, src) => { audio.src = src; sources.push(src) },
    },
    './library.svelte': { library: { historyVersion: 0 }, toLib: (value) => value },
    './media': { isPodcast: (id) => id >= 500_000_000_000_000 && id < 1_000_000_000_000_000,
      isYouTubeTrack: () => false, mediaUrl: (value) => value },
    './podcast-progress.svelte': { episodeProgress: {
      position: async (id) => progress.get(id)?.completed ? 0 : progress.get(id)?.position ?? 0,
      save: async (value) => { progress.set(value.id, { ...value }) }, flush: flushProgress,
    } },
    './toast.svelte': { toast: { show: (message) => messages.push(message) } },
    './player-android.svelte': { isAndroid: false },
    './sleep-timer': sleepTimer,
    './queue': {
      load: (_key, fallback) => fallback,
      playOrder: queue.playOrder,
      save: () => {}, toQuery: (value) => value.track,
    },
  }
  const exports = {}
  new Function('require', 'exports', 'Audio', 'navigator', 'MediaMetadata', 'setTimeout', 'clearTimeout', 'window', 'document', 'Date', 'performance', compiled)(
    (name) => { assert.ok(name in modules, `Unmocked dependency: ${name}`); return modules[name] },
    exports, Audio, mediaSession ? { mediaSession } : {}, metadata,
    (fn, delay) => { const id = ++timerId; timers.set(id, { at: now + delay, fn }); return id },
    (id) => timers.delete(id),
    events, events, FakeDate, { now: () => now },
  )
  return {
    player: exports.player, audios, messages, resolutions, sources, records, timers,
    progress, events, get audio() { return audios.at(-1) },
    get destroyed() { return destroyed }, close: (event) => closeHandler(event),
    get stopped() { return stopped },
    get now() { return wall },
    shiftWall(ms) { wall += ms },
    elapse(ms) { now += ms; wall += ms },
    async advance(ms) {
      await flush()
      const until = now + ms
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
        if (!next || next[1].at > until) break
        const at = Math.max(now, next[1].at)
        wall += at - now
        now = at
        timers.delete(next[0])
        next[1].fn()
        await flush()
      }
      wall += until - now
      now = until
      await flush()
    },
  }
}
