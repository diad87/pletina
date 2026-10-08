// Audit only: compiles the real Svelte store and the unchanged ImportPlaylist script.
// IPC, lifecycle, timers and download events are controlled; this does not render a WebView.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { compileModule } from 'svelte/compiler'
import * as svelte from 'svelte/internal/client'
import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import ts from 'typescript'

const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function compile(source, filename) {
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText
  return ts.transpileModule(compileModule(js, { filename }).js.code, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
  }).outputText
}
const downloadCode = compile(await readFile(new URL('../../src/lib/downloads.svelte.ts', import.meta.url), 'utf8'), 'downloads.svelte.js')
const component = await readFile(new URL('../../src/views/ImportPlaylist.svelte', import.meta.url), 'utf8')
const script = component.match(/<script lang="ts">([\s\S]*?)<\/script>/)?.[1]
assert.ok(script, 'Exact component script must be present')
// Test-only accessors. The original script, functions, guards and runes are unchanged.
const importCode = compile(script + `
export const audit = {
  read, cancel, retry, save,
  setUrl(value) { url = value }, setFile(value) { file = value }, setName(value) { name = value },
  get phase() { return phase }, get results() { return results }, get source() { return source },
  get found() { return found }, get missing() { return missing }, get error() { return error },
  get progress() { return progress }, get name() { return name }, get file() { return file }
}`, 'import-audit.svelte.js')

function load(code, modules, globals = {}) {
  const exports = {}
  new Function('require', 'exports', ...Object.keys(globals), code)((name) => {
    assert.ok(name in modules, `Unmocked dependency: ${name}`)
    return modules[name]
  }, exports, ...Object.values(globals))
  return exports
}
const item = (id = 1) => ({ track: { id, title: `Fixture ${id}` }, cover: null, albumId: 1 })
function downloadsHarness(overrides = {}) {
  const calls = [], messages = [], callbacks = []
  const api = {
    inTauri: true,
    download: async (tracks) => { calls.push(['download', tracks.map((t) => t.id)]) },
    removeDownloads: async (ids) => { calls.push(['remove', ids]) },
    downloadsList: async () => { throw new Error('Library unavailable') },
    cancelDownloads: async () => { calls.push(['cancel']) },
    ...overrides,
  }
  const yt = new Set([500_000_000_000_002])
  const modules = {
    'svelte/internal/client': svelte,
    'svelte/reactivity': { SvelteMap, SvelteSet },
    './api': api,
    './events': { listen: async (_event, callback) => { callbacks.push(callback); return () => {} } },
    './library.svelte': { toLib: (value) => value.track },
    './media': { isLocal: (id) => id >= 1_000_000_000_000_000, isPodcast: (id) => id >= 500_000_000_000_000 && id < 1_000_000_000_000_000 },
    './player-android.svelte': { isAndroid: false },
    './podcasts': { youtubeEpisodes: yt },
    './toast.svelte': { toast: { show: (message) => messages.push(message) } },
  }
  const { downloads } = load(downloadCode, modules, { Image: class { src = '' } })
  return { downloads, api, calls, messages, emit: (trackId, state, progress = 0, error = null) => callbacks.forEach((cb) => cb({ payload: { trackId, state, progress, error } })) }
}

test('CORE-DL-010: initial persisted downloads remain available offline', async () => {
  const h = downloadsHarness()
  await h.downloads.init([2, 4])
  assert.deepEqual([...h.downloads.done], [2, 4])
  assert.equal(h.downloads.active.size, 0)
  assert.equal(h.calls.length, 0)
})

test('CORE-DL-007: completed/active/local/RSS are skipped, YouTube episodes are eligible', async () => {
  const h = downloadsHarness()
  await h.downloads.init([1])
  h.downloads.start([item(2)])
  h.downloads.start([item(1), item(2), item(1_000_000_000_000_001), item(500_000_000_000_001), item(500_000_000_000_002)])
  assert.deepEqual(h.calls, [['download', [2]], ['download', [500_000_000_000_002]]])
})

test('CORE-DL-010: rejected start clears only its batch and permits a retry', async () => {
  const h = downloadsHarness({ download: async () => { throw new Error('IPC unavailable') } })
  await h.downloads.init([1])
  h.downloads.start([item(2), item(3)])
  await flush()
  assert.equal(h.downloads.active.size, 0)
  assert.equal(h.downloads.queued.size, 0)
  assert.deepEqual([...h.downloads.done], [1])
  assert.ok(h.messages.some((message) => message.includes('IPC unavailable')))
  h.api.download = async () => {}
  h.downloads.start([item(2)])
  assert.equal(h.downloads.active.has(2), true)
})

test('CORE-DL-010: a late start rejection cannot clear a newer attempt', async () => {
  const oldStart = deferred()
  const h = downloadsHarness({ download: () => oldStart.promise })
  await h.downloads.init([])
  h.downloads.start([item(1)])
  h.emit(1, 'cancelled')
  h.api.download = async () => {}
  h.downloads.start([item(1)])
  const messages = h.messages.length
  oldStart.reject(new Error('stale IPC rejection'))
  await flush()
  assert.equal(h.downloads.active.has(1), true)
  assert.equal(h.downloads.queued.has(1), true)
  assert.equal(h.messages.length, messages)
  h.emit(1, 'done', 1)
  assert.equal(h.downloads.done.has(1), true)
})

test('CORE-DL-010: failed removal keeps badges and version, successful retry clears them', async () => {
  const h = downloadsHarness({ removeDownloads: async () => { throw new Error('permission denied') } })
  await h.downloads.init([1, 2])
  await h.downloads.remove([1])
  assert.deepEqual([...h.downloads.done], [1, 2])
  assert.equal(h.downloads.version, 0)
  assert.match(h.messages.at(-1), /permission denied/)
  h.api.removeDownloads = async () => {}
  await h.downloads.remove([1])
  assert.deepEqual([...h.downloads.done], [2])
  assert.equal(h.downloads.version, 1)
})

test('CORE-DL-007: cancel pending tracks while an active transfer finishes', async () => {
  const h = downloadsHarness()
  await h.downloads.init([])
  h.downloads.start([item(1), item(2), item(3)])
  h.emit(1, 'downloading', 0.5)
  h.downloads.cancel()
  assert.equal(h.downloads.active.size, 3, 'cancel requests backend cancellation; it must not pretend active work stopped')
  h.emit(2, 'cancelled')
  h.emit(3, 'cancelled')
  assert.deepEqual([...h.downloads.active.keys()], [1])
  h.emit(1, 'done', 1)
  assert.deepEqual([...h.downloads.done], [1])
  assert.equal(h.downloads.active.size, 0)
  assert.equal(h.downloads.queued.size, 0)
  assert.match(h.messages.at(-1), /Descarga terminada/)
})

test('CORE-DL-010: partial removal failure reconciles only downloads actually removed', async () => {
  const h = downloadsHarness({
    removeDownloads: async () => { throw new Error('second file is locked') },
    downloadsList: async () => [{ track: { id: 2 } }, { track: { id: 3 } }],
  })
  await h.downloads.init([1, 2, 3])
  await h.downloads.remove([1, 2])
  assert.deepEqual([...h.downloads.done], [2, 3])
  assert.equal(h.downloads.version, 1)
  assert.match(h.messages.at(-1), /second file is locked/)
  h.emit(1, 'downloading', 0.8)
  assert.equal(h.downloads.active.size, 0)
})

test('CORE-DL-010: stale reconciliation cannot remove a newly downloaded replacement', async () => {
  const pending = deferred()
  const h = downloadsHarness({
    removeDownloads: async () => { throw new Error('second file is locked') },
    downloadsList: () => pending.promise,
  })
  await h.downloads.init([1, 2])
  const removal = h.downloads.remove([1, 2])
  await flush()
  // A new source choice starts a replacement while the failed batch is being reconciled.
  h.downloads.done.delete(1)
  h.downloads.start([item(1)])
  h.emit(1, 'done', 1)
  pending.resolve([{ track: { id: 2 } }])
  await removal
  assert.equal(h.downloads.done.has(1), true)
  assert.equal(h.downloads.done.has(2), true)
  assert.equal(h.downloads.active.size, 0)
})

test('CORE-DL-010: mixed success/error reports correct track and completion count', async () => {
  const h = downloadsHarness()
  await h.downloads.init([])
  h.downloads.start([item(1), item(2), item(3)])
  h.emit(1, 'done', 1)
  h.emit(2, 'error', 0, 'network lost')
  h.emit(3, 'done', 1)
  assert.deepEqual([...h.downloads.done], [1, 3])
  assert.ok(h.messages.some((message) => message.includes('Fixture 2') && message.includes('network lost')))
  assert.equal(h.messages.at(-1), '2 canciones descargadas')
})

test('CORE-DL-010 REGRESSION: a rejected cancellation must be observable', async () => {
  const h = downloadsHarness({ cancelDownloads: async () => { throw new Error('cancel IPC failed') } })
  await h.downloads.init([])
  h.downloads.start([item(1)])
  const before = h.messages.length
  h.downloads.cancel()
  await flush()
  assert.ok(h.messages.slice(before).some((message) => /cancel IPC failed/.test(message)), 'cancelDownloads rejection is silently swallowed')
})

test('CORE-DL-010 adversarial events: duplicate terminal event should not duplicate completion', async () => {
  const h = downloadsHarness()
  await h.downloads.init([])
  h.downloads.start([item(1)])
  h.emit(1, 'done', 1)
  const version = h.downloads.version, messages = h.messages.length
  h.emit(1, 'done', 1)
  assert.equal(h.downloads.version, version, 'duplicate done increments version and announces another completion')
  assert.equal(h.messages.length, messages)
})

test('CORE-DL-010 adversarial events: late progress must not resurrect a completed job', async () => {
  const h = downloadsHarness()
  await h.downloads.init([])
  h.downloads.start([item(1)])
  h.emit(1, 'done', 1)
  h.emit(1, 'downloading', 0.9)
  assert.equal(h.downloads.active.has(1), false, 'done and active are simultaneously true after late progress')
})

test('CORE-DL-007: duplicate playlist entries enqueue a track only once', async () => {
  const h = downloadsHarness()
  await h.downloads.init([])
  h.downloads.start([item(1), item(1), item(2), item(1)])
  assert.deepEqual(h.calls, [['download', [1, 2]]])
  assert.equal(h.downloads.active.size, 2)
  assert.equal(h.messages.at(-1), 'Descargando 2 canciones…')
})

test('CORE-DL-010: cancelled/failed jobs ignore late progress and accept an explicit retry', async () => {
  for (const state of ['cancelled', 'error']) {
    const h = downloadsHarness()
    await h.downloads.init([])
    h.downloads.start([item(1)])
    h.emit(1, state, 0, 'network lost')
    h.emit(1, 'downloading', 0.5)
    h.emit(1, 'done', 1)
    assert.equal(h.downloads.active.size, 0)
    assert.equal(h.downloads.done.size, 0)
    h.downloads.start([item(1)])
    h.emit(1, 'downloading', 0.2)
    assert.equal(h.downloads.active.get(1), 0.2)
    h.emit(1, 'done', 1)
    assert.equal(h.downloads.done.has(1), true)
    assert.equal(h.downloads.active.size, 0)
  }
})

test('CORE-DL-010: removal and a fresh download reset terminal state', async () => {
  const h = downloadsHarness()
  await h.downloads.init([])
  h.downloads.start([item(1)])
  h.emit(1, 'done', 1)
  await h.downloads.remove([1])
  h.emit(1, 'downloading', 0.9)
  assert.equal(h.downloads.active.size, 0, 'late progress after removal stays terminal')
  h.downloads.start([item(1)])
  h.emit(1, 'downloading', 0.1)
  assert.equal(h.downloads.active.get(1), 0.1)
  h.emit(1, 'done', 1)
  assert.equal(h.downloads.done.has(1), true)
  assert.equal(h.downloads.version, 3)
})

test('CORE-DL-010: an already persisted download ignores stale progress', async () => {
  const h = downloadsHarness()
  await h.downloads.init([1])
  h.emit(1, 'downloading', 0.5)
  h.emit(1, 'done', 1)
  assert.equal(h.downloads.active.size, 0)
  assert.equal(h.downloads.version, 0)
  await h.downloads.remove([1])
  h.emit(1, 'downloading', 0.9)
  h.emit(1, 'done', 1)
  assert.equal(h.downloads.active.size, 0)
  assert.equal(h.downloads.done.size, 0)
  assert.equal(h.downloads.version, 1)
})

const original = (id = 1) => ({ title: `Track ${id}`, artists: ['Fixture artist'], durationMs: 180000, isrc: null })
const track = (id = 1) => ({ id, title: `Track ${id}`, duration: 180, artistName: 'Fixture artist' })
const playlist = (tracks = [original(1)]) => ({ name: 'Audit playlist', tracks, skipped: 0 })
function importHarness(overrides = {}) {
  const messages = [], calls = [], navigation = [], destroy = [], timers = []
  const library = { version: 0, load: async () => { calls.push(['load']) } }
  const api = {
    readSpotifyPlaylist: async () => playlist(),
    readPlaylistCsv: async () => playlist(),
    matchImportTrack: async (value) => track(Number(value.title.split(' ').at(-1))),
    createPlaylist: async (name, tracks) => { calls.push(['create', name, tracks]); return { id: 8, name } },
    ...overrides,
  }
  const modules = {
    'svelte/internal/client': svelte,
    'svelte': { onDestroy: (callback) => destroy.push(callback) },
    '../lib/api': api,
    '../lib/library.svelte': { library },
    '../lib/nav.svelte': { nav: { ready: () => {}, go: (page) => navigation.push(page) } },
    '../lib/theme.svelte': { theme: { clear: () => {}, setColor: () => {} } },
    '../lib/toast.svelte': { toast: { show: (message) => messages.push(message) } },
  }
  const { audit } = load(importCode, modules, { setTimeout: (callback, ms) => { timers.push({ callback, ms }); return timers.length } })
  audit.setUrl('https://open.spotify.com/playlist/audit')
  return {
    state: audit, api, library, calls, messages, navigation,
    destroy: () => destroy.forEach((callback) => callback()),
    async tick() { await flush(); for (const timer of timers.splice(0)) { assert.equal(timer.ms, 150); timer.callback() }; await flush() },
  }
}

test('CORE-IMP-012: cancel pending CSV read prevents parsing and late UI mutation', async () => {
  const pending = deferred()
  let parsed = 0
  const h = importHarness({ readPlaylistCsv: async () => { parsed++; return playlist() } })
  h.state.setFile({ name: 'fixture.csv', size: 10, text: () => pending.promise })
  const reading = h.state.read('csv')
  assert.equal(h.state.phase, 'reading')
  h.state.cancel()
  pending.resolve('title,artist\nFixture,Artist')
  await reading
  assert.equal(parsed, 0)
  assert.equal(h.state.phase, 'input')
  assert.equal(h.state.source, null)
})

test('CORE-IMP-012: an old read cannot overwrite a newer import', async () => {
  const old = deferred(), next = deferred()
  let count = 0
  const h = importHarness({ readSpotifyPlaylist: () => ++count === 1 ? old.promise : next.promise })
  const first = h.state.read('spotify')
  h.state.cancel()
  const second = h.state.read('spotify')
  next.resolve({ ...playlist([original(2)]), name: 'New import' })
  await second
  old.resolve({ ...playlist(), name: 'Stale import' })
  await first
  assert.equal(h.state.name, 'New import')
  assert.deepEqual(h.state.found.map((value) => value.id), [2])
  assert.equal(h.state.phase, 'review')
})

test('CORE-IMP-012: dispose during matching suppresses late results and navigation', async () => {
  const pending = deferred()
  const h = importHarness({ matchImportTrack: () => pending.promise })
  const reading = h.state.read('spotify')
  await flush()
  assert.equal(h.state.phase, 'matching')
  h.destroy()
  pending.resolve(track())
  await reading
  assert.equal(h.state.results.length, 0)
  assert.equal(h.navigation.length, 0)
  await h.state.save()
  assert.equal(h.calls.length, 0)
})

test('CORE-IMP-012: cancelling during throttle prevents the next lookup', async () => {
  let matched = 0
  const h = importHarness({ readSpotifyPlaylist: async () => playlist([original(1), original(2)]), matchImportTrack: async () => { matched++; return track() } })
  const reading = h.state.read('spotify')
  await flush()
  assert.equal(h.state.results.length, 1)
  h.state.cancel()
  await h.tick()
  await reading
  assert.equal(matched, 1)
  assert.equal(h.state.phase, 'input')
  assert.equal(h.state.results.length, 0)
})

test('CORE-IMP-011: oversized CSV is rejected before its contents or parser are accessed', async () => {
  let accesses = 0
  const h = importHarness()
  h.state.setFile({ name: 'large.csv', size: 10 * 1024 * 1024 + 1, text: async () => { accesses++; return '' } })
  await h.state.read('csv')
  assert.equal(accesses, 0)
  assert.equal(h.state.phase, 'input')
  assert.equal(h.state.file, null)
  assert.match(h.state.error, /10 MB/)
})

test('CORE-IMP-013: matching failure retains progress, retry starts at the pending row, duplicates survive', async () => {
  const queried = []
  let fail = true
  const h = importHarness({
    readSpotifyPlaylist: async () => playlist([original(1), original(2), original(1)]),
    matchImportTrack: async (value) => { queried.push(value.title); if (value.title === 'Track 2' && fail) throw new Error('offline'); return track(Number(value.title.at(-1))) },
  })
  const reading = h.state.read('spotify')
  await h.tick()
  await reading
  assert.equal(h.state.phase, 'paused')
  assert.equal(h.state.results.length, 1)
  assert.equal(h.state.missing.length, 0)
  fail = false
  h.state.retry()
  await h.tick()
  assert.equal(h.state.phase, 'review')
  assert.deepEqual(h.state.found.map((value) => value.id), [1, 2, 1])
  assert.deepEqual(queried, ['Track 1', 'Track 2', 'Track 2'])
  await h.state.save()
  assert.deepEqual(h.calls.find((call) => call[0] === 'create')[2].map((value) => value.id), [1, 2, 1])
})

test('CORE-IMP-013: double save creates one playlist and cancel during save cannot discard the commit', async () => {
  const pending = deferred()
  let creates = 0
  const h = importHarness({ createPlaylist: () => { creates++; return pending.promise } })
  await h.state.read('spotify')
  const saving = h.state.save()
  await h.state.save()
  h.state.cancel()
  assert.equal(h.state.phase, 'saving')
  assert.equal(creates, 1)
  pending.resolve({ id: 9, name: 'Saved' })
  await saving
  assert.equal(h.library.version, 1)
  assert.deepEqual(h.navigation, [{ name: 'playlist', id: 9 }])
})

test('CORE-IMP-013: leaving during save preserves the committed library update without navigation', async () => {
  const pending = deferred()
  const h = importHarness({ createPlaylist: () => pending.promise })
  await h.state.read('spotify')
  const saving = h.state.save()
  h.destroy()
  pending.resolve({ id: 9, name: 'Saved after leave' })
  await saving
  assert.equal(h.library.version, 1)
  assert.deepEqual(h.calls, [['load']])
  assert.equal(h.navigation.length, 0)
  assert.match(h.messages.at(-1), /Saved after leave/)
})

test('CORE-IMP-013: failed playlist write remains reviewable and retry retains the same contents', async () => {
  const h = importHarness({ createPlaylist: async () => { throw new Error('SQLITE_FULL') } })
  await h.state.read('spotify')
  await h.state.save()
  assert.equal(h.state.phase, 'review')
  assert.equal(h.state.found.length, 1)
  assert.equal(h.library.version, 0)
  assert.equal(h.navigation.length, 0)
  assert.match(h.state.error, /SQLITE_FULL/)
  h.api.createPlaylist = async (name, tracks) => { assert.deepEqual(tracks.map((value) => value.id), [1]); return { id: 9, name } }
  await h.state.save()
  assert.equal(h.library.version, 1)
})
