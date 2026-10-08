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

export function harness({ resolve = async (track) => playable(track.id), play, mediaSession, metadata } = {}) {
  const audios = [], messages = [], resolutions = [], sources = [], records = []
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
      recordPlay: async (item) => { records.push(item.track.id) },
    },
    './downloads.svelte': { downloads: { done: new Set(), start: () => {} } },
    './extractor/capture': {
      stopCapture: () => { stopped++ },
      setAudioSource: (audio, src) => { audio.src = src; sources.push(src) },
    },
    './library.svelte': { library: { historyVersion: 0 }, toLib: (value) => value },
    './media': { isPodcast: () => false, isYouTubeTrack: () => false, mediaUrl: (value) => value },
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
    player: exports.player, audios, messages, resolutions, sources, records, timers,
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
