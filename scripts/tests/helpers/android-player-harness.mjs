// Compiles the Android controller with real Svelte runes; only the native IPC is simulated.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { compileModule } from 'svelte/compiler'
import * as svelte from 'svelte/internal/client'
import ts from 'typescript'
import { sleepTimer } from './player-harness.mjs'

const source = ts.transpileModule(await readFile(new URL('../../../src/lib/player-android.svelte.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
}).outputText
const compiled = ts.transpileModule(compileModule(source, { filename: 'player-android.svelte.js' }).js.code, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText

export function androidHarness(snapshot = {}) {
  const events = new EventTarget(), listeners = new Map(), commands = [], messages = [], failures = new Map()
  let now = 1_700_000_000_000
  let state = {
    entries: [], index: -1, positionMs: 0, durationMs: 0, playing: false,
    playWhenReady: false, state: 'idle', repeat: 'off', at: now,
    sleepTimer: { mode: 'off', endsAt: 0 }, ...snapshot,
  }
  const modules = {
    'svelte/internal/client': svelte,
    '@tauri-apps/api/core': { invoke: async (command, { cmd, args }) => {
      commands.push({ command, cmd, args })
      if (failures.has(cmd)) throw failures.get(cmd)
      return cmd === 'state' ? state : null
    } },
    './events': { listen: async (event, fn) => { listeners.set(event, fn); return () => listeners.delete(event) } },
    './api': { inTauri: true },
    './library.svelte': { library: { historyVersion: 0 }, toLib: (value) => value },
    './media': { isPodcast: (id) => id >= 500_000_000_000_000, isYouTubeTrack: () => false },
    './queue': { load: (_, fallback) => fallback, save: () => {}, toQuery: (value) => value.track },
    './toast.svelte': { toast: { show: (message) => messages.push(message) } },
    './sleep-timer': sleepTimer,
  }
  const exports = {}
  new Function('require', 'exports', 'navigator', 'document', 'setInterval', 'Date', compiled)(
    (name) => { assert.ok(name in modules, `Unmocked dependency: ${name}`); return modules[name] },
    exports, { userAgent: 'Android' }, events, () => 0, class extends Date { static now() { return now } },
  )
  return {
    player: new exports.AndroidPlayer(), events, commands, messages, failures,
    emit: (event, payload) => listeners.get(event)?.({ payload }),
    setState: (next) => { state = { ...state, ...next } },
    elapse: (ms) => { now += ms },
  }
}
