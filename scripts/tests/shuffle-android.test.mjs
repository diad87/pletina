import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { compileModule } from 'svelte/compiler'
import * as svelte from 'svelte/internal/client'
import ts from 'typescript'
import { flush, item, sleepTimer } from './helpers/player-harness.mjs'

// Android recibe una cola ya ordenada; compilamos el mando real y simulamos solo su IPC.
const source = await readFile(new URL('../../src/lib/player-android.svelte.ts', import.meta.url), 'utf8')
const javascript = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
}).outputText
const compiled = ts.transpileModule(compileModule(javascript, { filename: 'player-android.svelte.js' }).js.code, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText
const queueSource = ts.transpileModule(await readFile(new URL('../../src/lib/queue.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText

function harness({ storage = new Map() } = {}) {
  const queue = {}, commands = []
  new Function('exports', 'localStorage', queueSource)(queue, {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  })
  const modules = {
    'svelte/internal/client': svelte,
    '@tauri-apps/api/core': {
      invoke: async (command, args) => { commands.push({ command, ...args }); return null },
    },
    './events': { listen: async () => () => {} },
    './api': { inTauri: true },
    './library.svelte': { library: { historyVersion: 0 }, toLib: (value) => value },
    './media': { isPodcast: () => false },
    './queue': queue,
    './toast.svelte': { toast: { show: () => {} } },
    './sleep-timer': sleepTimer,
  }
  const exports = {}, events = new EventTarget()
  new Function('require', 'exports', 'navigator', 'document', 'setInterval', compiled)(
    (name) => { assert.ok(name in modules, `Unmocked dependency: ${name}`); return modules[name] },
    exports, { userAgent: 'Android' }, events, () => 0,
  )
  return { player: new exports.AndroidPlayer(), commands, storage }
}

const ids = (values) => values.map((value) => value.track.id)
const entries = (player) => player.entries.map((entry) => entry.item.track.id)
const lastQueue = (h) => h.commands.filter((command) => command.cmd === 'setQueue').at(-1).args

test('Android starts a collection at a random song and preserves its original context order', async (t) => {
  t.mock.method(Math, 'random', () => 0.8)
  const h = harness(), tracks = [item(1), item(2), item(3), item(4)]
  h.player.shuffle = true
  h.player.playQueue(tracks, null, 'Mi playlist')
  await flush()
  assert.equal(h.player.current.track.id, 4)
  assert.equal(h.player.index, 0)
  assert.deepEqual([...entries(h.player)].sort((a, b) => a - b), [1, 2, 3, 4])
  assert.deepEqual(ids(h.player.queue), [1, 2, 3, 4])
  assert.deepEqual(h.player.entries.map((entry) => entry.ctx), [3, 0, 1, 2])
  assert.equal(h.player.context, 'Mi playlist')
  assert.equal(lastQueue(h).index, 0)
  assert.equal(lastQueue(h).play, true)
  assert.deepEqual(lastQueue(h).entries.map((entry) => entry.item.track.id), entries(h.player))
})

test('Android keeps an explicitly selected song first with shuffle enabled', async (t) => {
  t.mock.method(Math, 'random', () => 0.8)
  const h = harness(), tracks = [item(1), item(2), item(3), item(4)]
  h.player.shuffle = true
  for (const start of [0, 1]) {
    h.player.playQueue(tracks, start)
    await flush()
    assert.equal(h.player.current.track.id, start + 1)
    assert.equal(h.player.index, 0)
    assert.deepEqual([...entries(h.player)].sort((a, b) => a - b), [1, 2, 3, 4])
    assert.deepEqual(ids(h.player.queue), [1, 2, 3, 4])
    assert.equal(lastQueue(h).entries[0].ctx, start)
  }
})

test('Android collection playback without shuffle starts at the beginning; explicit positions stay intact', async () => {
  const h = harness(), tracks = [item(1), item(2), item(3)]
  h.player.playQueue(tracks, null)
  await flush()
  assert.equal(h.player.current.track.id, 1)
  assert.equal(h.player.index, 0)
  assert.deepEqual(entries(h.player), [1, 2, 3])
  h.player.playQueue(tracks, 2)
  await flush()
  assert.equal(h.player.current.track.id, 3)
  assert.equal(h.player.index, 2)
  assert.equal(lastQueue(h).index, 2)
})

test('Android retains the DJ queue after the selected start in both playback modes', async (t) => {
  t.mock.method(Math, 'random', () => 0.8)
  for (const shuffle of [false, true]) {
    const h = harness(), tracks = [item(1), item(2), item(3), item(4)]
    h.player.playQueue([item(10)], 0)
    h.player.addToQueue([item(90), item(91)])
    const keys = h.player.userQueue.map((entry) => entry.key)
    h.player.shuffle = shuffle
    h.player.playQueue(tracks, null)
    await flush()
    assert.equal(h.player.current.track.id, shuffle ? 4 : 1)
    assert.deepEqual(h.player.userQueue.map((entry) => entry.item.track.id), [90, 91])
    assert.deepEqual(h.player.userQueue.map((entry) => entry.key), keys)
    assert.deepEqual(entries(h.player).slice(1, 3), [90, 91])
    assert.deepEqual(ids(h.player.queue), [1, 2, 3, 4])
    assert.equal(lastQueue(h).index, 0)
  }
})

test('Android toggles shuffle without changing the current song, position or DJ queue', async (t) => {
  t.mock.method(Math, 'random', () => 0)
  const h = harness(), tracks = [item(1), item(2), item(3), item(4)]
  h.player.playQueue(tracks, 1)
  h.player.addToQueue([item(90), item(91)])
  h.player.seek(37)
  const uid = h.player.entries[h.player.index].uid
  const keys = h.player.userQueue.map((entry) => entry.key)
  const start = h.commands.length
  h.player.toggleShuffle()
  await flush()
  assert.equal(h.player.current.track.id, 2)
  assert.equal(h.player.entries[h.player.index].uid, uid)
  assert.equal(h.player.time, 37)
  assert.equal(h.player.index, 1)
  assert.deepEqual(h.player.userQueue.map((entry) => entry.key), keys)
  assert.deepEqual(entries(h.player), [1, 2, 90, 91, 4, 3])
  assert.deepEqual(h.commands.slice(start).map((command) => command.cmd), ['replace'])
  assert.deepEqual(h.commands.at(-1).args.entries.map((entry) => entry.item.track.id), [4, 3])
  assert.equal(h.commands.at(-1).args.from, 4)
  h.player.toggleShuffle()
  await flush()
  assert.equal(h.player.current.track.id, 2)
  assert.equal(h.player.time, 37)
  assert.deepEqual(entries(h.player), [1, 2, 90, 91, 3, 4])
  assert.deepEqual(h.player.userQueue.map((entry) => entry.key), keys)
  assert.deepEqual(h.commands.slice(start).map((command) => command.cmd), ['replace', 'replace'])
})

test('Android restores the shuffle preference for subsequent collection playback', async (t) => {
  t.mock.method(Math, 'random', () => 0.8)
  const h = harness(), tracks = [item(1), item(2), item(3), item(4)]
  h.player.playQueue(tracks, 0)
  h.player.toggleShuffle()
  assert.equal(h.storage.get('musify:shuffle'), 'true')
  const reopened = harness({ storage: h.storage })
  assert.equal(reopened.player.shuffle, true)
  reopened.player.playQueue(tracks, null)
  await flush()
  assert.equal(reopened.player.current.track.id, 4)
})
