// node --test scripts/tests/podcast-favorites.test.mjs
// Ejecuta el estado real de la biblioteca con las runas de Svelte; el IPC se controla
// para comprobar fallos y respuestas fuera de orden sin depender de la red.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { compileModule } from 'svelte/compiler'
import * as svelte from 'svelte/internal/client'
import { SvelteSet } from 'svelte/reactivity'
import ts from 'typescript'

const source = await readFile(new URL('../../src/lib/library.svelte.ts', import.meta.url), 'utf8')
const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText
const compiled = ts.transpileModule(compileModule(javascript, { filename: 'library.svelte.js' }).js.code, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText

const podcast = (id = 500_000_000_000_001, feedUrl = 'https://example.com/feed.xml') => ({
  id, feedUrl, title: 'Un programa', author: 'Su autor', description: '', image: null, language: 'es', episodeCount: 3,
})
const rss = podcast()
const youtube = podcast(rss.id + 1, 'youtube:PLprograma')
const data = (podcasts = []) => ({ likedIds: [750_000_000_000_001], downloadedIds: [], albums: [], artists: [], playlists: [], podcasts })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function harness(overrides = {}) {
  const messages = [], calls = []
  const api = {
    library: async () => data(),
    setPodcastSaved: async (id, saved) => { calls.push([id, saved]) },
    ...overrides,
  }
  const modules = {
    'svelte/internal/client': svelte,
    'svelte/reactivity': { SvelteSet },
    './api': api,
    './toast.svelte': { toast: { show: (message) => messages.push(message) } },
  }
  const exports = {}
  new Function('require', 'exports', compiled)((name) => {
    assert.ok(name in modules, `Unmocked dependency: ${name}`)
    return modules[name]
  }, exports)
  return { library: exports.library, messages, calls, api }
}

test('loads saved RSS and YouTube programs independently of liked episodes', async () => {
  const h = harness({ library: async () => data([rss, youtube]) })
  await h.library.load()
  assert.deepEqual(h.library.podcasts.map((p) => p.feedUrl), [rss.feedUrl, youtube.feedUrl])
  assert.equal(h.library.isPodcastSaved(rss.id), true)
  assert.equal(h.library.isPodcastSaved(youtube.id), true)
  assert.deepEqual([...h.library.liked], data().likedIds)
})

test('save and remove programs only after IPC succeeds, ignoring repeated clicks while busy', async () => {
  const pending = deferred()
  const calls = []
  const h = harness({ setPodcastSaved: (id, saved) => { calls.push([id, saved]); return pending.promise } })
  await h.library.load()
  const saving = h.library.togglePodcast(rss)
  await h.library.togglePodcast(rss)
  assert.deepEqual(calls, [[rss.id, true]])
  assert.equal(h.library.isPodcastSaved(rss.id), false)
  assert.equal(h.library.savingPodcasts.has(rss.id), true)
  pending.resolve()
  await saving
  assert.equal(h.library.isPodcastSaved(rss.id), true)
  assert.equal(h.library.savingPodcasts.has(rss.id), false)
  await h.library.togglePodcast(rss)
  assert.deepEqual(calls, [[rss.id, true], [rss.id, false]])
  assert.equal(h.library.isPodcastSaved(rss.id), false)
  assert.deepEqual([...h.library.liked], data().likedIds)
})

test('failed writes retain the previous favorites and release the busy state for retry', async () => {
  const h = harness({
    library: async () => data([rss]),
    setPodcastSaved: async () => { throw new Error('Disco lleno') },
  })
  await h.library.load()
  await h.library.togglePodcast(rss)
  await h.library.togglePodcast(youtube)
  assert.deepEqual(h.library.podcasts.map((p) => p.id), [rss.id])
  assert.equal(h.library.savingPodcasts.size, 0)
  assert.equal(h.library.version, 0)
  assert.equal(h.messages.length, 2)
  assert.ok(h.messages.every((message) => message.includes('Disco lleno')))
  h.api.setPodcastSaved = async () => {}
  await h.library.togglePodcast(youtube)
  assert.equal(h.library.isPodcastSaved(youtube.id), true)
})

test('independent program saves can complete in either order without dropping a favorite', async () => {
  const one = deferred(), two = deferred()
  const h = harness({ setPodcastSaved: (id) => id === rss.id ? one.promise : two.promise })
  const first = h.library.togglePodcast(rss)
  const second = h.library.togglePodcast(youtube)
  two.resolve()
  await second
  one.resolve()
  await first
  assert.deepEqual(new Set(h.library.podcasts.map((p) => p.id)), new Set([rss.id, youtube.id]))
  assert.equal(h.library.savingPodcasts.size, 0)
})

test('failed library reload keeps the last available favorites', async () => {
  const h = harness({ library: async () => data([rss, youtube]) })
  await h.library.load()
  h.api.library = async () => { throw new Error('No se puede leer la biblioteca') }
  assert.equal(await h.library.load(), null)
  assert.deepEqual(h.library.podcasts.map((p) => p.id), [rss.id, youtube.id])
})

test('a library response started before a successful save cannot erase it', async () => {
  const pending = deferred()
  const h = harness({ library: () => pending.promise })
  const loading = h.library.load()
  await h.library.togglePodcast(rss)
  pending.resolve(data())
  await loading
  assert.equal(h.library.isPodcastSaved(rss.id), true)
})

test('a library response started before a successful removal cannot restore it', async () => {
  const h = harness({ library: async () => data([rss]) })
  await h.library.load()
  const pending = deferred()
  h.api.library = () => pending.promise
  const loading = h.library.load()
  await h.library.togglePodcast(rss)
  pending.resolve(data([rss]))
  await loading
  assert.equal(h.library.isPodcastSaved(rss.id), false)
})

test('a stale initial load still recovers other favorites while retaining the new save', async () => {
  const pending = deferred()
  const h = harness({ library: () => pending.promise })
  const loading = h.library.load()
  await h.library.togglePodcast(rss)
  pending.resolve(data([youtube]))
  await loading
  assert.deepEqual(new Set(h.library.podcasts.map((p) => p.id)), new Set([rss.id, youtube.id]))
})
