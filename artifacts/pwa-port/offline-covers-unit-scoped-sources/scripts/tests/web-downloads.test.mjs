import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import { IDBFactory } from 'fake-indexeddb'
import { createDownloadStore, DOWNLOAD_CACHE, MAX_DOWNLOAD_BYTES } from '../../web-port/download-store.ts'

const code = ts.transpileModule(await readFile(new URL('../../web-port/downloads.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText
const storeModule = await import('../../web-port/download-store.ts')
const ownershipApi = {}
new Function('exports', ts.transpileModule(await readFile(new URL('../../web-port/download-ownership.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText)(ownershipApi)
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
function downloadClock() {
  const timers = new Map()
  let now = 1792390000000, sequence = 0
  return { Date: { now: () => now }, performance: { now: () => now },
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { at: now + delay, fn }); return id },
    clearTimeout(id) { timers.delete(id) },
    async advance(ms) {
      const until = now + ms
      for (;;) {
        await flush()
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
        if (!next || next[1].at > until) break
        now = Math.max(now, next[1].at); timers.delete(next[0]); next[1].fn()
      }
      now = until; await flush()
    },
  }
}
const song = (id = 1, extra = {}) => ({ id, title: `Canción ${id}`, duration: 120, explicit: false,
  artistId: 10, artistName: 'Artista', albumId: 20, albumTitle: 'Álbum', albumArtistId: 10, cover: 'https://images.example/cover.jpg', ...extra })
const scope = 'https://app.example/pletina/'
const stage = (id = 1) => `${scope}__audio__/${id}?stage=1234567890-11111111-1111-4111-8111-111111111111`
function setup(t, options = {}) {
  const rows = new Map(), events = [], sources = [], validations = []
  let savedJobs = structuredClone(options.savedJobs ?? [])
  const journal = options.journal ?? { read: async () => structuredClone(savedJobs), write: async values => { savedJobs = structuredClone(values) } }
  const cache = {
    async put(key, value) {
      if (options.consumeBody) value = new Response(await value.arrayBuffer(), { status: value.status, headers: value.headers })
      rows.set(key, value); if (options.putError) throw options.putError
      if (options.putGate) await options.putGate(key)
    },
    async match(key) { const value = rows.get(key); return value?.clone ? value.clone() : value },
    async delete(key) { if (options.deleteError) throw options.deleteError; return rows.delete(typeof key === 'string' ? key : key.url) },
    async keys() { return [...rows.keys()].map(key => new Request(key)) },
  }
  const caches = { async open(name) { assert.equal(name, DOWNLOAD_CACHE); return cache } }
  const factory = new IDBFactory(), name = 'download-test-' + crypto.randomUUID()
  const store = createDownloadStore({ indexedDB: factory, name, scope, caches })
  t.after(() => store.close())
  const exports = {}
  new Function('exports', 'require', 'Audio', 'setTimeout', 'clearTimeout', 'Date', 'performance', code)(exports, (path) => path === './download-store' ? storeModule
    : path === './audio' ? { resolveRemoteTrack() { assert.fail('uninjected resolver') } }
    : path === './download-queue' ? { defaultDownloadQueueJournal: () => journal }
    : path === './download-ownership' ? { defaultDownloadOwnership: () => ({ acquire: async () => {}, assertOwned() {} }) }
    : path === './download-covers' ? { createDownloadCovers() { assert.fail('Cover I/O must be explicitly injected in audio-only unit tests') } }
    : path === './youtube' ? { stream() { assert.fail('uninjected stream') } } : assert.fail(path), options.Audio ?? globalThis.Audio,
    options.clock?.setTimeout ?? setTimeout, options.clock?.clearTimeout ?? clearTimeout, options.clock?.Date ?? Date, options.clock?.performance ?? performance)
  const manager = exports.createDownloadManager({
    covers: options.covers ?? false,
    store, caches, journal, online: options.online ?? (() => true), emit: (value) => events.push(value), timeout: options.useDefaultTimeout ? undefined : options.timeout ?? 2000, retryDelay: options.retryDelay ?? 0,
    ...(options.ownership ? { ownership: options.ownership } : {}),
    resolve: options.resolve ?? (async (query) => { sources.push(query.id); return { videoId: '9RfVp-GhKfs', local: false, url: 'https://r1.googlevideo.com/audio?signature=SECRET' } }),
    stream: options.stream ?? (async () => ({ videoId: '9RfVp-GhKfs', url: 'https://r1.googlevideo.com/audio?signature=SECRET', contentLength: options.size ?? 1234 })),
    fetch: options.fetch ?? (async (_url, init) => { assert.equal(init.mode, 'no-cors'); assert.equal(init.credentials, 'omit'); return new Response('opaque fixture bytes') }),
    validate: options.validate ?? (async (url) => { validations.push(url) }),
    storage: { estimate: async () => options.quota ?? { quota: 1024 ** 3, usage: 0 }, persist: async () => false },
  })
  return { ...manager, rows, events, sources, validations, store, factory, name, caches, exports, journal, readJournal: () => structuredClone(savedJobs) }
}

test('download metadata survives reopening and contains only library fields and an internal cache key', async (t) => {
  const h = setup(t)
  h.rows.set(stage(), new Response('media'))
  await h.store.put({ id: 1, track: song(1, { url: 'https://r1.googlevideo.com/a?signature=SECRET', token: 'SECRET' }), size: 1234, at: 12, cacheKey: stage() })
  await h.store.close()
  const reopened = createDownloadStore({ indexedDB: h.factory, name: h.name, scope, caches: h.caches })
  t.after(() => reopened.close())
  const rows = await reopened.list()
  assert.equal(rows.length, 1)
  assert.deepEqual(Object.keys(rows[0]), ['id', 'track', 'size', 'at', 'cacheKey'])
  assert.doesNotMatch(JSON.stringify(rows), /googlevideo|signature|SECRET|token/)
  assert.equal((await reopened.readDownloadedPlayable(1)).url, scope + '__audio__/1')
  assert.equal((await reopened.listDownloads())[0].path, scope + '__audio__/1')
})

test('download store rejects unsafe IDs, signed metadata, and nonlocal or malformed staging routes', async (t) => {
  const h = setup(t)
  for (const id of [0, -1, 1.5, 1_000_000_000_000_000]) await assert.rejects(() => h.enqueueDownloads([song(id)]))
  for (const cacheKey of ['https://r1.googlevideo.com/a?signature=SECRET', scope + '__audio__/1', stage().replace('/1?', '/2?'),
    stage() + '&extra=1', stage().replace('https://app.example', 'https://other.example')]) {
    await assert.rejects(() => h.store.put({ id: 1, track: song(), size: 1, at: 1, cacheKey }))
  }
  await assert.rejects(() => h.enqueueDownloads([song(1, { cover: 'https://r1.googlevideo.com/image?signature=SECRET' })]))
  assert.equal(h.events.length, 0)
})

test('downloads are serial, skip duplicates, and report done only after media validation and metadata commit', async (t) => {
  const validation = deferred(), started = deferred()
  const h = setup(t, { validate: async () => { started.resolve(); await validation.promise } })
  await h.enqueueDownloads([song(1), song(1), song(2)])
  await started.promise
  assert.deepEqual(h.sources, [1])
  assert.equal(await h.store.get(1), null)
  assert.ok(!h.events.some((value) => value.state === 'done'))
  validation.resolve()
  await h.idle()
  assert.deepEqual(h.sources, [1, 2])
  assert.deepEqual(h.events.filter((value) => value.state === 'done').map((value) => value.trackId), [1, 2])
  assert.equal((await h.listDownloads()).length, 2)
  assert.equal((await h.store.readDownloadedPlayable(1)).local, true)
  assert.doesNotMatch(JSON.stringify(await h.store.list()), /signature|SECRET|googlevideo/)
})

test('optional cover work starts only after the audio commit and completes before its done event', async t => {
  const entered = deferred(), gate = deferred(), covers = []
  t.after(() => gate.resolve())
  let h
  h = setup(t, { covers: { async save(url) {
    assert.equal((await h.store.list()).length, 1, 'Audio metadata is already durable')
    assert.equal((await h.store.readDownloadedPlayable(1)).local, true)
    assert.equal(h.events.some(event => event.state === 'done'), false)
    covers.push(url); entered.resolve(); await gate.promise
  }, async prune() {}, backfill() {}, async idle() {} } })
  await h.enqueueDownloads([song()])
  await Promise.race([entered.promise, h.idle().then(() => assert.fail('Audio completed without invoking the optional cover saver'))])
  assert.deepEqual(h.sources, [1])
  gate.resolve(); await h.idle()
  assert.deepEqual(covers, [song().cover])
  assert.deepEqual(h.events.filter(event => event.state === 'done').map(event => event.trackId), [1])
})

test('cover cache rejection or a synchronous image failure never retries audio or stops the next download', async t => {
  for (const synchronous of [false, true]) {
    const save = synchronous ? () => { throw new Error('optional cover failed synchronously') }
      : async () => { throw new DOMException('cover cache quota', 'QuotaExceededError') }
    const h = setup(t, { covers: { save, async prune() {}, backfill() {}, async idle() {} } })
    await h.enqueueDownloads([song(1), song(2)]); await h.idle()
    assert.deepEqual(h.sources, [1, 2])
    assert.deepEqual(h.events.filter(event => event.state === 'done').map(event => event.trackId), [1, 2])
    assert.equal(h.events.some(event => event.state === 'error'), false)
    assert.equal((await h.store.list()).length, 2)
  }
})

test('removal prunes shared cover references only after audio metadata is removed', async t => {
  const references = [], pruned = deferred()
  let h
  h = setup(t, { covers: { async save() {}, async prune() {
    references.push((await h.store.list()).map(row => row.id)); pruned.resolve()
  }, backfill() {}, async idle() {} } })
  await h.enqueueDownloads([song(1), song(2)]); await h.idle()
  await h.removeDownloads([1]); await pruned.promise
  assert.deepEqual(references, [[2]])
  assert.equal((await h.store.get(2)).track.cover, song(2).cover)
})

test('download listing schedules optional old-cover backfill without awaiting network or changing its result', async t => {
  let scans = 0
  const h = setup(t, { covers: { async save() {}, async prune() {}, backfill() { scans++; return new Promise(() => {}) }, async idle() {} } })
  await h.enqueueDownloads([song()]); await h.idle()
  const entries = await h.listDownloads()
  assert.equal(scans, 1)
  assert.deepEqual(entries.map(row => row.track.id), [1])
  assert.equal(entries[0].track.cover, song().cover)
})

test('a cover backfill or cleanup failure cannot fail the local listing or audio removal', async t => {
  const h = setup(t, { covers: { async save() {}, prune() { throw new Error('optional cleanup failure') },
    backfill() { throw new Error('optional backfill failure') }, async idle() {} } })
  await h.enqueueDownloads([song()]); await h.idle()
  assert.equal((await h.listDownloads()).length, 1)
  await h.removeDownloads([1])
  assert.equal(await h.store.get(1), null)
  assert.equal(h.rows.size, 0)
})

test('cancel discards only pending jobs while the active transfer finishes', async (t) => {
  const gate = deferred(), started = deferred()
  const h = setup(t, { validate: async () => { started.resolve(); await gate.promise } })
  await h.enqueueDownloads([song(1), song(2), song(3)])
  await started.promise
  await h.cancelDownloads()
  gate.resolve()
  await h.idle()
  assert.deepEqual(h.sources, [1])
  assert.deepEqual(h.events.filter((value) => value.state === 'cancelled').map((value) => value.trackId), [2, 3])
  assert.equal((await h.listDownloads())[0].track.id, 1)
})

test('metadata failure or cache.put failure rolls back staging and cannot report a completed download', async (t) => {
  for (const options of [{ validate: async () => { throw new Error('Not audio') } }, { putError: new DOMException('Quota exceeded', 'QuotaExceededError') }]) {
    const h = setup(t, options)
    await h.enqueueDownloads([song()]); await h.idle()
    assert.equal(h.rows.size, 0)
    assert.deepEqual(await h.store.list(), [])
    assert.ok(h.events.some((value) => value.state === 'error'))
    assert.ok(!h.events.some((value) => value.state === 'done'))
  }
})

test('known size and available browser quota are checked before requesting media bytes', async (t) => {
  for (const options of [{ size: MAX_DOWNLOAD_BYTES + 1 }, { size: 200, quota: { quota: 500, usage: 400 } }]) {
    const h = setup(t, { ...options, fetch: async () => assert.fail('must not fetch an oversized transfer') })
    await h.enqueueDownloads([song()]); await h.idle()
    assert.ok(h.events.some((value) => value.state === 'error'))
    assert.deepEqual(await h.listDownloads(), [])
  }
})

test('removing an active source prevents its late validation from committing stale media', async (t) => {
  const gate = deferred(), started = deferred()
  const h = setup(t, { validate: async () => { started.resolve(); await gate.promise } })
  await h.enqueueDownloads([song(1)])
  await started.promise
  await h.removeDownloads([1])
  gate.resolve(); await h.idle()
  assert.equal(h.rows.size, 0)
  assert.deepEqual(await h.store.list(), [])
  assert.ok(!h.events.some((value) => value.state === 'done'))
  assert.ok(h.events.some((value) => value.state === 'cancelled'))
})

test('removal during the initial cached lookup cannot announce the removed copy as completed', async (t) => {
  const lookup = deferred(), started = deferred()
  const h = setup(t)
  h.store.readDownloadedPlayable = async () => { started.resolve(); return lookup.promise }
  await h.enqueueDownloads([song(1)])
  await started.promise
  await h.removeDownloads([1])
  lookup.resolve({ videoId: '', url: scope + '__audio__/1', title: 'Removed copy', channel: '', local: true })
  await h.idle()
  assert.equal(h.sources.length, 0)
  assert.ok(!h.events.some((value) => value.state === 'done'))
  assert.ok(h.events.some((value) => value.state === 'cancelled'))
  assert.deepEqual(await h.store.list(), [])
})

test('cache eviction removes stale metadata and download removal deletes both metadata and cached response', async (t) => {
  const h = setup(t)
  await h.enqueueDownloads([song(1), song(2)]); await h.idle()
  const first = await h.store.get(1)
  h.rows.delete(first.cacheKey)
  assert.equal(await h.store.readDownloadedPlayable(1), null)
  assert.equal(await h.store.get(1), null)
  await h.removeDownloads([2])
  assert.equal(h.rows.size, 0)
  assert.deepEqual(await h.listDownloads(), [])
})

test('cold owner startup removes only unreferenced valid stages in its scope and never invents a completed download', async t => {
  const h = setup(t), referenced = stage(1), orphan = stage(2)
  const unrelated = [scope + '__audio__/3', stage(3) + '&other=1', stage(3).replace('/pletina/', '/another-app/'),
    stage(3).replace('app.example', 'another.example'), scope + 'cover.png']
  h.rows.set(referenced, new Response('complete file')); h.rows.set(orphan, new Response('abandoned before pointer commit'))
  for (const key of unrelated) h.rows.set(key, new Response('not owned by this sweep'))
  await h.store.put({ id: 1, track: song(), size: 13, at: 1, cacheKey: referenced })
  await h.store.close()
  assert.deepEqual(await h.pendingDownloads(), [])
  assert.equal(h.rows.has(orphan), false); assert.equal(h.rows.has(referenced), true)
  for (const key of unrelated) assert.equal(h.rows.has(key), true, key)
  assert.equal(await h.store.get(2), null); assert.deepEqual((await h.listDownloads()).map(row => row.track.id), [1])
  assert.deepEqual(h.events, []); assert.deepEqual(h.sources, [])
})

test('startup reconciliation preserves a valid file pointer even when unrelated row metadata is corrupt', async t => {
  const h = setup(t), key = stage(4)
  h.rows.set(key, new Response('complete file with a damaged title row'))
  const db = await new Promise((resolve, reject) => { const request = h.factory.open(h.name, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('files', { keyPath: 'id' })
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
  await new Promise((resolve, reject) => { const tx = db.transaction('files', 'readwrite'); tx.objectStore('files').put({ id: 4, cacheKey: key, track: null })
    tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error) }); db.close()
  await h.pendingDownloads()
  assert.equal(h.rows.has(key), true); assert.equal(await h.store.get(4), null)
  assert.deepEqual(h.events, [], 'a preserved corrupt reference is not a valid completed download')
})

test('resume and read during an active transfer never sweep its not-yet-committed stage', async t => {
  const gate = deferred(), entered = deferred(), h = setup(t, { validate: async () => { entered.resolve(); await gate.promise } })
  h.rows.set(stage(9), new Response('old abandoned stage'))
  await h.enqueueDownloads([song()]); await entered.promise
  assert.equal(h.rows.has(stage(9)), false)
  assert.equal(h.rows.size, 1); assert.equal(await h.store.get(1), null)
  const activeStage = [...h.rows.keys()][0]
  assert.deepEqual((await h.pendingDownloads()).map(track => track.id), [1])
  await h.resumeDownloads()
  assert.equal(h.rows.has(activeStage), true, 'an active stage with no pointer is valid while the owner is still working')
  gate.resolve(); await h.idle(); assert.equal((await h.store.get(1)).cacheKey, activeStage)
})

test('reconciliation failure keeps the durable FIFO untouched and does not start or announce a partial queue', async t => {
  const options = { savedJobs: [song(1), song(2)], deleteError: new Error('Cache deletion unavailable') }, h = setup(t, options)
  h.rows.set(stage(9), new Response('old orphan'))
  await assert.rejects(h.pendingDownloads(), /Cache deletion unavailable/)
  assert.deepEqual(h.readJournal().map(track => track.id), [1, 2]); assert.deepEqual(h.events, []); assert.deepEqual(h.sources, [])
  options.deleteError = null
  assert.deepEqual((await h.pendingDownloads()).map(track => track.id), [1, 2])
  assert.equal(h.rows.has(stage(9)), false)
  await h.resumeDownloads(); await h.idle()
  assert.deepEqual(h.sources, [1, 2]); assert.deepEqual(h.readJournal(), [])
})

test('lost ownership after enumerating cache keys stops reconciliation before any deletion or FIFO mutation', async t => {
  let owned = true
  const ownership = { acquire: async () => {}, assertOwned() { if (!owned) throw Object.assign(Error('Retired owner'), { code: 'queue-ownership-released' }) } }
  const gate = deferred(), entered = deferred(), h = setup(t, { ownership, savedJobs: [song()] })
  h.rows.set(stage(9), new Response('orphan must remain for the actual owner'))
  const cache = await h.caches.open(DOWNLOAD_CACHE), keys = cache.keys
  cache.keys = async () => { entered.resolve(); await gate.promise; return keys() }
  const pending = h.pendingDownloads(); await entered.promise; owned = false; gate.resolve()
  await assert.rejects(pending, { code: 'queue-ownership-released' })
  assert.equal(h.rows.has(stage(9)), true); assert.deepEqual(h.readJournal().map(track => track.id), [1]); assert.deepEqual(h.events, [])
})

test('a hung resolver times out, preserves its FIFO job and waits for explicit resume before the next song', async (t) => {
  const never = deferred()
  const h = setup(t, { timeout: 30, resolve: async (query) => query.id === 1 ? never.promise : { videoId: '9RfVp-GhKfs', local: false } })
  await h.enqueueDownloads([song(1), song(2)]); await h.idle()
  assert.deepEqual((await h.pendingDownloads()).map(track => track.id), [1, 2])
  assert.ok(!h.events.some((value) => value.state === 'done' || value.state === 'error'))
  never.resolve({ videoId: '9RfVp-GhKfs', local: false })
  await flush()
  assert.equal(await h.store.get(1), null)
  await h.resumeDownloads(); await h.idle()
  assert.deepEqual(h.events.filter(value => value.state === 'done').map(value => value.trackId), [1, 2])
  assert.deepEqual(h.readJournal(), [])
})

test('an interrupted transfer renews its source once and completes without exposing a failed attempt', async (t) => {
  const resolutions = [], fetched = []
  let generation = 0
  const h = setup(t, {
    resolve: async (query, refresh) => {
      resolutions.push([query.id, refresh])
      if (refresh) generation++
      return { videoId: '9RfVp-GhKfs', local: false }
    },
    stream: async () => ({ videoId: '9RfVp-GhKfs', url: `https://r1.googlevideo.com/audio?generation=${generation}`, contentLength: 1234 }),
    fetch: async (url) => {
      fetched.push(url)
      if (fetched.length === 1) throw new TypeError('Network request failed')
      return new Response('renewed audio')
    },
  })
  await h.enqueueDownloads([song()]); await h.idle()
  assert.deepEqual(resolutions, [[1, false], [1, true]])
  assert.deepEqual(fetched.map((url) => new URL(url).searchParams.get('generation')), ['0', '1'])
  assert.deepEqual(h.events.map((value) => value.state), ['queued', 'downloading', 'done'])
  assert.equal((await h.listDownloads()).length, 1)
  assert.equal(h.rows.size, 1)
})

test('a rejected cached audio is removed before retrying a fresh complete copy', async (t) => {
  const resolutions = [], stages = []
  let transfers = 0
  const h = setup(t, {
    resolve: async (query, refresh) => { resolutions.push([query.id, refresh]); return { videoId: '9RfVp-GhKfs', local: false } },
    fetch: async () => {
      if (++transfers === 2) assert.equal(h.rows.size, 0, 'the rejected opaque body cannot survive into the new attempt')
      return new Response('complete media attempt ' + transfers)
    },
    validate: async (url) => {
      stages.push(url)
      assert.equal(h.rows.size, 1)
      assert.equal(await h.store.get(1), null, 'the rejected copy must never enter the library')
      if (stages.length === 1) throw new Error('The media URL returned an expired or invalid body')
    },
  })
  await h.enqueueDownloads([song()]); await h.idle()
  assert.equal(transfers, 2)
  assert.notEqual(stages[0], stages[1])
  assert.deepEqual(resolutions, [[1, false], [1, true]])
  assert.equal(h.rows.has(stages[0]), false)
  assert.equal((await h.store.get(1)).cacheKey, stages[1])
  assert.deepEqual(h.events.map((value) => value.state), ['queued', 'downloading', 'done'])
})

test('two failed transfers pause the persisted FIFO without spinning and resume refreshes the interrupted source', async (t) => {
  const resolutions = []
  let current = 0, transfers = 0, failing = true
  const h = setup(t, {
    resolve: async (query, refresh) => { current = query.id; resolutions.push([query.id, refresh]); return { videoId: '9RfVp-GhKfs', local: false } },
    fetch: async () => {
      transfers++
      if (current === 1 && failing) throw new TypeError('Network request failed')
      return new Response('second song')
    },
  })
  await h.enqueueDownloads([song(1), song(2)]); await h.idle()
  assert.deepEqual(resolutions, [[1, false], [1, true]])
  assert.equal(transfers, 2)
  assert.deepEqual(h.events.filter((value) => ['error', 'done'].includes(value.state)), [])
  assert.deepEqual(h.readJournal().map(track => track.id), [1, 2])
  assert.equal(await h.store.get(1), null)
  assert.equal(h.rows.size, 0)
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(transfers, 2)
  failing = false; await h.resumeDownloads(); await h.idle()
  assert.deepEqual(resolutions, [[1, false], [1, true], [1, true], [2, false]])
  assert.equal(transfers, 4)
  assert.deepEqual(h.events.filter(value => value.state === 'done').map(value => value.trackId), [1, 2])
  assert.deepEqual(h.readJournal(), [])
})

test('quota, abort, timeout and metadata write errors do not trigger another download attempt', async (t) => {
  for (const name of ['QuotaExceededError', 'AbortError', 'TimeoutError', 'metadata']) {
    let transfers = 0, metadataWrites = 0
    const h = setup(t, { fetch: async () => {
      transfers++
      if (name !== 'metadata') throw new DOMException('Transfer stopped', name)
      return new Response('audio')
    } })
    if (name === 'metadata') h.store.put = async () => { metadataWrites++; throw new Error('IndexedDB write failed') }
    await h.enqueueDownloads([song()]); await h.idle()
    assert.equal(transfers, 1, name)
    assert.equal(metadataWrites, name === 'metadata' ? 1 : 0)
    assert.equal(h.rows.size, 0)
    assert.deepEqual(await h.store.list(), [])
    assert.ok(!h.events.some((value) => value.state === 'done'))
  }
})

test('removing a song while its renewed source is pending prevents a late retry from fetching or committing', async (t) => {
  const renewed = deferred(), refreshing = deferred()
  const resolutions = []
  let transfers = 0
  const h = setup(t, {
    resolve: async (query, refresh) => {
      resolutions.push([query.id, refresh])
      if (refresh) { refreshing.resolve(); return renewed.promise }
      return { videoId: '9RfVp-GhKfs', local: false }
    },
    fetch: async () => { transfers++; throw new TypeError('Network request failed') },
  })
  await h.enqueueDownloads([song()])
  await refreshing.promise
  await h.removeDownloads([1])
  renewed.resolve({ videoId: '9RfVp-GhKfs', local: false })
  await h.idle()
  assert.deepEqual(resolutions, [[1, false], [1, true]])
  assert.equal(transfers, 1)
  assert.equal(h.rows.size, 0)
  assert.deepEqual(await h.store.list(), [])
  assert.deepEqual(h.events.map((value) => value.state), ['queued', 'downloading', 'cancelled'])
})

test('cancelling the queued songs during source renewal still lets the active retry finish alone', async (t) => {
  const renewed = deferred(), refreshing = deferred()
  const resolutions = []
  let transfers = 0
  const h = setup(t, {
    resolve: async (query, refresh) => {
      resolutions.push([query.id, refresh])
      if (refresh) { refreshing.resolve(); return renewed.promise }
      return { videoId: '9RfVp-GhKfs', local: false }
    },
    fetch: async () => { if (++transfers === 1) throw new TypeError('Network request failed'); return new Response('renewed media') },
  })
  await h.enqueueDownloads([song(1), song(2), song(3)])
  await refreshing.promise
  await h.cancelDownloads()
  renewed.resolve({ videoId: '9RfVp-GhKfs', local: false })
  await h.idle()
  assert.deepEqual(resolutions, [[1, false], [1, true]])
  assert.deepEqual(h.events.filter((value) => value.state === 'cancelled').map((value) => value.trackId), [2, 3])
  assert.deepEqual((await h.listDownloads()).map((value) => value.track.id), [1])
})

test('the original transfer deadline bounds renewal waiting and preserves the pending FIFO without an automatic retry loop', async (t) => {
  const resolutions = []
  let current = 0, transfers = 0
  const h = setup(t, {
    timeout: 30, retryDelay: 80,
    resolve: async (query, refresh) => { current = query.id; resolutions.push([query.id, refresh]); return { videoId: '9RfVp-GhKfs', local: false } },
    fetch: async () => { transfers++; if (current === 1) throw new TypeError('Network request failed'); return new Response('next song') },
  })
  await h.enqueueDownloads([song(1), song(2)]); await h.idle()
  assert.deepEqual(resolutions, [[1, false]], 'an expired global deadline cannot start a renewed request or the next FIFO job')
  assert.equal(transfers, 1)
  assert.deepEqual(h.events.filter((value) => ['error', 'done'].includes(value.state)), [])
  assert.deepEqual((await h.listDownloads()).map((value) => value.track.id), [])
  assert.deepEqual(h.readJournal().map(track => track.id), [1, 2])
})

const externalPlayable = (download = {}, identity = {}, extra = {}) => ({ videoId: '', local: false,
  url: 'https://api.audius.co/v1/tracks/daMWzaJ/stream', title: 'Canción 1', channel: 'Artista',
  source: { provider: 'audius', id: 'daMWzaJ', download: { allowed: true, duration: 120, ...download }, ...identity }, ...extra })
const audioResponse = (body = 'complete audio bytes', headers = {}) => new Response(body, { headers: { 'content-type': 'audio/mpeg', ...headers } })
const p1Playable = (download = {}, extra = {}) => ({ videoId: '9RfVp-GhKfs', local: false,
  url: 'https://r1.googlevideo.com/videoplayback?itag=140&clen=1234&sig=FIXTURE', title: 'Canción 1', channel: 'Artista',
  source: { provider: 'youtube-p1', id: '9RfVp-GhKfs', download: { allowed: true, contentLength: 1234, duration: 120, ...download } }, ...extra })
// A pipeline fixture, not evidence about real opaque media. The live browser
// gate separately checks actual CacheStorage/HTMLAudio with the network off.
const opaqueResponse = () => ({ type: 'opaque', status: 0, clone() { return this },
  arrayBuffer() { assert.fail('opaque bytes cannot be counted or hashed') } })

test('P1 uses its selected locator, waits for complete cache.put, then validates duration and tail before a metadata-only commit', async t => {
  const entered = deferred(), gate = deferred(), source = p1Playable(), order = []
  const h = setup(t, { resolve: async () => source, stream: async () => assert.fail('must not resolve a second P1 format'),
    fetch: async (url, init) => { assert.equal(url, source.url); assert.equal(init.mode, 'no-cors'); assert.equal(init.credentials, 'omit'); order.push('fetch'); return opaqueResponse() },
    putGate: async () => { order.push('cache-body'); entered.resolve(); await gate.promise; order.push('cache-complete') },
    validate: async (url, _signal, expected) => { order.push('validate'); assert.equal(expected, 120); assert.equal(new URL(url).origin, new URL(scope).origin); assert.ok(new URL(url).searchParams.has('stage')); assert.equal(await h.store.get(1), null) },
  })
  await h.enqueueDownloads([song()])
  await Promise.race([entered.promise, h.idle().then(() => assert.fail('P1 must reach the opaque body transfer'))])
  assert.deepEqual(order, ['fetch', 'cache-body']); assert.equal(await h.store.get(1), null)
  assert.ok(!h.events.some(value => value.state === 'done'))
  gate.resolve(); await h.idle()
  assert.deepEqual(order, ['fetch', 'cache-body', 'cache-complete', 'validate'])
  const row = await h.store.get(1)
  assert.equal(row.size, 1234, 'opaque size is declared metadata, not an observed byte count')
  assert.equal(Object.hasOwn(row, 'source'), false)
  assert.doesNotMatch(JSON.stringify(row), /youtube-p1|googlevideo|FIXTURE|sha256/)
  assert.equal(h.events.filter(value => value.state === 'done').length, 1)
  await h.store.close()
  const reopened = createDownloadStore({ indexedDB: h.factory, name: h.name, scope, caches: h.caches })
  t.after(() => reopened.close())
  assert.equal((await reopened.readDownloadedPlayable(1)).local, true)
  assert.equal(Object.hasOwn(await reopened.get(1), 'source'), false)
})

test('P1 requires a consistent permitted same-ID Googlevideo locator with bounded duration and declared size before fetching', async t => {
  const good = p1Playable(), bad = [
    ...[{ allowed: false }, { contentLength: undefined }, { contentLength: 0 }, { contentLength: 1.5 },
      { contentLength: MAX_DOWNLOAD_BYTES + 1 }, { duration: undefined }, { duration: 0 }, { duration: Infinity }, { duration: 86401 },
      { contentLength: 1235 }].map(patch => p1Playable(patch)),
    ...['http://r1.googlevideo.com/file', 'https://googlevideo.com.evil.test/file', 'https://user@r1.googlevideo.com/file',
      'https://r1.googlevideo.com:8443/file', good.url + '#fragment', good.url + '&clen=1234',
      'blob:https://app.example/file'].map(url => ({ ...good, url })),
    { ...good, source: { ...good.source, id: 'aaaaaaaaaaa' } }, { ...good, videoId: '' },
  ]
  for (const source of bad) {
    const h = setup(t, { resolve: async () => source,
      stream: async () => assert.fail('invalid permission cannot switch formats'), fetch: async () => assert.fail('invalid permission must not fetch') })
    await h.enqueueDownloads([song()]); await h.idle()
    assert.equal(h.rows.size, 0); assert.deepEqual(await h.store.list(), []); assert.ok(!h.events.some(value => value.state === 'done'))
    assert.ok(h.events.some(value => value.state === 'error'))
  }
})

test('P1 validation rejection rolls back every body and renews only the same selected identity once', async t => {
  const resolutions = [], stages = []
  const h = setup(t, { resolve: async (_track, refresh) => { resolutions.push(refresh); return p1Playable() },
    stream: async () => assert.fail('P1 retries use the renewed selected Playable'), fetch: async () => opaqueResponse(),
    validate: async (url, _signal, expected) => { assert.equal(expected, 120); stages.push(url); throw new Error('No decodable tail') } })
  await h.enqueueDownloads([song()]); await h.idle()
  assert.deepEqual(resolutions, [false, true]); assert.equal(stages.length, 2); assert.notEqual(stages[0], stages[1])
  assert.equal(h.rows.size, 0); assert.deepEqual(await h.store.list(), []); assert.ok(!h.events.some(value => value.state === 'done'))
})

test('P1 transfer retry uses the renewed same-format URL and preserves legacy two-argument YouTube validation', async t => {
  const resolutions = [], fetched = [], duration = []
  const h = setup(t, { resolve: async (_track, refresh) => { resolutions.push(refresh); const value = p1Playable(); return { ...value, url: value.url + '&generation=' + Number(refresh) } },
    stream: async () => assert.fail('must not look up a different format'),
    fetch: async url => { fetched.push(new URL(url).searchParams.get('generation')); if (fetched.length === 1) throw new TypeError('Transfer interrupted'); return opaqueResponse() },
    validate: async (_url, _signal, expected) => { duration.push(expected) } })
  await h.enqueueDownloads([song()]); await h.idle()
  assert.deepEqual(resolutions, [false, true]); assert.deepEqual(fetched, ['0', '1']); assert.deepEqual(duration, [120])
  assert.equal(h.events.filter(value => value.state === 'done').length, 1)
  let legacyDuration = 'not invoked'
  const legacy = setup(t, { validate: async (_url, _signal, expected) => { legacyDuration = expected } })
  await legacy.enqueueDownloads([song()]); await legacy.idle()
  assert.equal(legacyDuration, undefined)
})

test('removing a P1 job during a pending cache body cannot commit late audio or leave a stage', async t => {
  const entered = deferred(), gate = deferred()
  const h = setup(t, { resolve: async () => p1Playable(), fetch: async () => opaqueResponse(),
    putGate: async () => { entered.resolve(); await gate.promise }, validate: async () => assert.fail('a removed body must never be validated') })
  await h.enqueueDownloads([song()])
  await Promise.race([entered.promise, h.idle().then(() => assert.fail('P1 must start the selected transfer'))])
  await h.removeDownloads([1]); gate.resolve(); await h.idle()
  assert.equal(h.rows.size, 0); assert.deepEqual(await h.store.list(), []); assert.ok(!h.events.some(value => value.state === 'done'))
})

test('a readable partial P1 response cannot become an opaque full-file success', async t => {
  for (const response of [new Response('part', { status: 206 }), new Response('part', { headers: { 'content-range': 'bytes 0-3/1234' } })]) {
    const h = setup(t, { resolve: async () => p1Playable(), fetch: async () => response.clone(),
      validate: async () => assert.fail('known partial responses must be rejected before validation') })
    await h.enqueueDownloads([song()]); await h.idle()
    assert.equal(h.rows.size, 0); assert.deepEqual(await h.store.list(), []); assert.ok(!h.events.some(value => value.state === 'done'))
  }
})

test('a longer P1 transfer can finish after ninety seconds within its duration-based total budget', async t => {
  const clock = downloadClock(), entered = deferred(), body = deferred()
  let signal
  const h = setup(t, { clock, useDefaultTimeout: true, resolve: async () => p1Playable({ duration: 180 }),
    fetch: async (_url, init) => { signal = init.signal; entered.resolve(); return body.promise } })
  await h.enqueueDownloads([song()]); await entered.promise
  await clock.advance(90001)
  assert.equal(signal.aborted, false, 'a full P1 body may need longer than the legacy ninety-second budget')
  body.resolve(opaqueResponse()); await h.idle()
  assert.equal(h.events.filter(value => value.state === 'done').length, 1)
})

test('P1 retries share the original job deadline instead of restarting a duration-based budget', async t => {
  const clock = downloadClock(), entered = deferred(), retrying = deferred(), firstBody = deferred(), secondBody = deferred()
  let transfers = 0, signal
  const h = setup(t, { clock, useDefaultTimeout: true, resolve: async () => p1Playable({ duration: 120 }),
    fetch: async (_url, init) => {
      signal = init.signal
      if (++transfers === 1) { entered.resolve(); return firstBody.promise }
      retrying.resolve(); return secondBody.promise
    } })
  await h.enqueueDownloads([song()]); await entered.promise
  await clock.advance(119000); assert.equal(signal.aborted, false)
  firstBody.reject(new TypeError('Transfer interrupted'))
  await flush(); await clock.advance(0); await retrying.promise
  await clock.advance(31000)
  assert.equal(signal.aborted, true, '120 seconds plus 30 seconds is measured from the job start, not attempt two')
  await h.idle(); secondBody.resolve(opaqueResponse())
  assert.equal(transfers, 2); assert.deepEqual(h.readJournal().map(value => value.id), [1])
  assert.ok(!h.events.some(value => value.state === 'done')); assert.equal(h.rows.size, 0)
})

test('the P1 adaptive budget is capped at ten minutes and keeps interrupted work in its durable FIFO', async t => {
  const clock = downloadClock(), entered = deferred(), body = deferred()
  let signal
  const h = setup(t, { clock, useDefaultTimeout: true, resolve: async () => p1Playable({ duration: 3600 }),
    fetch: async (_url, init) => { signal = init.signal; entered.resolve(); return body.promise } })
  await h.enqueueDownloads([song()]); await entered.promise
  await clock.advance(599999); assert.equal(signal.aborted, false)
  await clock.advance(1); assert.equal(signal.aborted, true)
  await h.idle(); body.resolve(opaqueResponse())
  assert.deepEqual(h.readJournal().map(value => value.id), [1]); assert.equal(h.rows.size, 0)
  assert.ok(!h.events.some(value => value.state === 'done'))
})

test('an explicit download timeout wins over P1 duration while legacy YouTube keeps ninety seconds', async t => {
  for (const legacy of [false, true]) {
    const clock = downloadClock(), entered = deferred(), body = deferred(), timeout = legacy ? 90000 : 1234
    let signal
    const h = setup(t, { clock, ...(legacy ? { useDefaultTimeout: true } : { timeout }),
      ...(legacy ? {} : { resolve: async () => p1Playable({ duration: 3600 }) }),
      fetch: async (_url, init) => { signal = init.signal; entered.resolve(); return body.promise } })
    await h.enqueueDownloads([song()]); await entered.promise
    await clock.advance(timeout - 1); assert.equal(signal.aborted, false)
    await clock.advance(1); assert.equal(signal.aborted, true)
    await h.idle(); body.resolve(opaqueResponse())
    assert.ok(!h.events.some(value => value.state === 'done')); assert.equal(h.rows.size, 0)
  }
})

test('external permitted audio uses CORS, preserves ISRC/version and never asks YouTube for its stream', async t => {
  let query, validatedDuration, requests = 0
  const body = 'complete audio bytes'
  const h = setup(t, { consumeBody: true,
    resolve: async value => { query = value; return externalPlayable() }, stream: async () => assert.fail('external audio must not use YouTube'),
    fetch: async (url, init) => {
      requests++; assert.equal(url, 'https://api.audius.co/v1/tracks/daMWzaJ/stream')
      assert.equal(init.mode, 'cors'); assert.equal(init.credentials, 'omit'); assert.equal(init.referrerPolicy, 'no-referrer')
      return audioResponse(body)
    }, validate: async (_url, _signal, expected) => { validatedDuration = expected },
  })
  await h.enqueueDownloads([song(1, { isrc: 'GXLEX2692321', titleVersion: '(Original)' })]); await h.idle()
  assert.equal(requests, 1); assert.equal(query.isrc, 'GXLEX2692321'); assert.equal(query.titleVersion, '(Original)')
  assert.equal(validatedDuration, 120)
  const row = await h.store.get(1)
  assert.equal(row.size, new TextEncoder().encode(body).length)
  assert.doesNotMatch(JSON.stringify(row), /api\.audius|\/stream|signature/)
  assert.equal((await h.store.readDownloadedPlayable(1)).local, true)
})

test('sources without a full-file download capability refuse before media requests', async t => {
  for (const provider of ['audius', 'verified']) {
    const h = setup(t, { resolve: async () => externalPlayable({ allowed: false }, { provider }),
      fetch: async () => assert.fail('not allowed to download'), stream: async () => assert.fail('must not switch to YouTube') })
    await h.enqueueDownloads([song()]); await h.idle()
    assert.match(h.events.find(event => event.state === 'error').error, /permite escuchar.*pero no descargar/)
    assert.deepEqual(await h.store.list(), []); assert.equal(h.rows.size, 0)
  }
})

const checkedBlobPlayable = async (bytes, provider = 'verified', extra = {}) => ({ videoId: '', local: false,
  url: 'blob:https://app.example/checked-file', title: 'Canción 1', channel: 'Artista',
  source: { provider, id: 'checked-file', startAt: 8.94, download: { allowed: true, contentLength: bytes.byteLength,
    sha256: [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join(''),
    duration: 187.168, mime: 'audio/mpeg' } }, ...extra })

test('complete verified Blob copies retain bytes, integrity, file duration and start offset across reopening without provider requests', async t => {
  const bytes = new TextEncoder().encode('Complete synthetic verified audio, not a music recording.')
  for (const provider of ['verified', 'archive', 'funkwhale']) {
    const playable = await checkedBlobPlayable(bytes, provider)
    let fetched = 0, validatedDuration
    const h = setup(t, { consumeBody: true, resolve: async () => playable,
      stream: async () => assert.fail('a checked Blob copy must not ask YouTube for another source'),
      fetch: async (url, init) => { fetched++; assert.equal(url, playable.url); assert.equal(init.credentials, 'omit'); assert.equal(init.mode, 'cors')
        return audioResponse(bytes, { 'content-length': String(bytes.length) }) },
      validate: async (_url, _signal, duration) => { validatedDuration = duration },
    })
    await h.enqueueDownloads([song()]); await h.idle()
    assert.equal(fetched, 1); assert.equal(validatedDuration, playable.source.download.duration)
    const saved = await h.store.get(1)
    assert.equal(saved.size, bytes.byteLength); assert.deepEqual(saved.source, playable.source)
    assert.deepEqual(new Uint8Array(await (await h.rows.get(saved.cacheKey).clone()).arrayBuffer()), bytes)
    assert.doesNotMatch(JSON.stringify(saved), /blob:|\/stream|googlevideo|expire|token/)
    await h.store.close()
    const reopened = createDownloadStore({ indexedDB: h.factory, name: h.name, scope, caches: h.caches })
    t.after(() => reopened.close())
    const local = await reopened.readDownloadedPlayable(1)
    assert.equal(local.local, true); assert.equal(local.url, scope + '__audio__/1'); assert.equal(local.source.startAt, 8.94)
    assert.equal(local.source.download.duration, 187.168); assert.equal(local.source.download.sha256, playable.source.download.sha256)
    assert.equal(h.events.at(-1).state, 'done')
  }
})

test('durable enqueue commits before queued events or transport and a journal write failure cannot announce work', async t => {
  const gate = deferred(), entered = deferred(); let saved = []
  const h = setup(t, { journal: { read: async () => [], write: async tracks => { entered.resolve(); await gate.promise; saved = structuredClone(tracks) } } })
  const enqueue = h.enqueueDownloads([song()]); await entered.promise
  assert.deepEqual(h.events, []); assert.deepEqual(h.sources, [])
  gate.resolve(); await enqueue; await h.idle()
  assert.equal(h.events.at(-1).state, 'done'); assert.deepEqual(saved, [])
  const rejected = setup(t, { journal: { read: async () => [], write: async () => { throw Error('Journal unavailable') } } })
  await assert.rejects(rejected.enqueueDownloads([song()]), /Journal unavailable/)
  assert.deepEqual(rejected.events, []); assert.deepEqual(rejected.sources, []); assert.deepEqual(await rejected.pendingDownloads(), [])
})

test('offline persisted jobs restore in order, deduplicate and start only on resume while online', async t => {
  let online = false
  const first = setup(t, { online: () => online })
  await first.enqueueDownloads([song(1), song(2), song(1)])
  assert.deepEqual(first.sources, []); assert.deepEqual(first.readJournal().map(track => track.id), [1, 2])
  const reopened = setup(t, { journal: first.journal, online: () => online })
  assert.deepEqual((await reopened.pendingDownloads()).map(track => track.id), [1, 2])
  await reopened.resumeDownloads(); await reopened.idle(); assert.deepEqual(reopened.sources, [])
  online = true; await reopened.resumeDownloads(); await reopened.idle()
  assert.deepEqual(reopened.sources, [1, 2]); assert.deepEqual(first.readJournal(), [])
})

test('typed provider network failures retain the interrupted job while permanent capability errors retire it', async t => {
  for (const code of ['network', 'timeout']) {
    const error = Object.assign(new Error('Provider temporarily unavailable'), { code })
    const h = setup(t, { resolve: async () => { throw error } })
    await h.enqueueDownloads([song()]); await h.idle()
    assert.deepEqual(h.readJournal().map(track => track.id), [1])
    assert.ok(!h.events.some(event => ['done', 'error'].includes(event.state)))
    assert.equal(h.events.at(-1).error, 'La conexión se ha interrumpido. Reintenta para continuar.')
  }
  const bad = await checkedBlobPlayable(new Uint8Array([1]), 'verified', { url: 'not a URL' })
  const h = setup(t, { resolve: async () => bad })
  await h.enqueueDownloads([song()]); await h.idle()
  assert.deepEqual(h.readJournal(), []); assert.equal(h.events.at(-1).state, 'error')
})

test('a failed post-file journal checkpoint is reconciled from the complete local file without a second media acquisition', async t => {
  let saved = [], writes = 0, fetched = 0
  const journal = { read: async () => structuredClone(saved), write: async tracks => {
    if (++writes === 2) throw Error('Checkpoint unavailable')
    saved = structuredClone(tracks)
  } }
  const h = setup(t, { journal, fetch: async () => { fetched++; return new Response('complete local file') } })
  await h.enqueueDownloads([song()]); await h.idle()
  assert.equal(fetched, 1); assert.ok(await h.store.readDownloadedPlayable(1))
  assert.deepEqual(saved.map(track => track.id), [1]); assert.equal(h.events.at(-1).state, 'error')
  assert.ok(!h.events.some(event => event.state === 'done'))
  await h.resumeDownloads(); await h.idle()
  assert.equal(fetched, 1); assert.deepEqual(saved, []); assert.equal(h.events.at(-1).state, 'done')
})

test('queued cancellation and removal persist before reopen and cannot resurrect a removed active job', async t => {
  const h = setup(t, { online: () => false })
  await h.enqueueDownloads([song(1), song(2)]); await h.removeDownloads([1])
  assert.deepEqual(h.readJournal().map(track => track.id), [2])
  await h.cancelDownloads(); assert.deepEqual(h.readJournal(), [])
  const reopened = setup(t, { journal: h.journal })
  await reopened.resumeDownloads(); await reopened.idle(); assert.deepEqual(reopened.sources, [])
  const gate = deferred(), started = deferred()
  const active = setup(t, { validate: async () => { started.resolve(); await gate.promise } })
  await active.enqueueDownloads([song(1), song(2)]); await started.promise
  assert.deepEqual(active.readJournal().map(track => track.id), [1, 2], 'the active job remains checkpointed until complete commit')
  await active.removeDownloads([1]); assert.deepEqual(active.readJournal().map(track => track.id), [2])
  gate.resolve(); await active.idle()
  assert.equal(await active.store.get(1), null); assert.deepEqual(active.readJournal(), [])
  assert.deepEqual(active.events.filter(event => event.state === 'done').map(event => event.trackId), [2])
})

test('two managers cannot overwrite, cancel or drain the same journal; closing its owner permits safe recovery', async t => {
  let held = false, saved = [], reads = 0, writes = 0
  const locks = { async request(_name, _options, callback) { await Promise.resolve(); if (held) return callback(null); held = true
    try { return await callback({}) } finally { held = false } } }
  const firstOwner = ownershipApi.createDownloadOwnership({ locks }), secondOwner = ownershipApi.createDownloadOwnership({ locks })
  t.after(() => { firstOwner.dispose(); secondOwner.dispose() })
  const journal = { read: async () => { reads++; return structuredClone(saved) }, write: async rows => { writes++; saved = structuredClone(rows) } }
  const first = setup(t, { ownership: firstOwner, journal, online: () => false })
  const second = setup(t, { ownership: secondOwner, journal })
  assert.deepEqual(await first.pendingDownloads(), [])
  await first.enqueueDownloads([song(1), song(2)])
  const before = { reads, writes }
  for (const action of [() => second.pendingDownloads(), () => second.enqueueDownloads([song(3)]), () => second.resumeDownloads(),
    () => second.cancelDownloads(), () => second.removeDownloads([1])]) await assert.rejects(action(), { code: 'queue-busy' })
  assert.deepEqual({ reads, writes }, before, 'loser has no journal IO at all')
  assert.deepEqual(saved.map(track => track.id), [1, 2]); assert.deepEqual(second.sources, []); assert.deepEqual(second.events, [])
  firstOwner.dispose(); await new Promise(resolve => setTimeout(resolve, 0))
  await second.resumeDownloads(); await second.idle()
  assert.deepEqual(second.sources, [1, 2]); assert.deepEqual(saved, [])
  assert.deepEqual(second.events.filter(event => event.state === 'done').map(event => event.trackId), [1, 2])
  await assert.rejects(first.resumeDownloads(), { code: 'queue-ownership-released' })
})

test('an invalidated owner cannot commit its late active file after the successor resumes the saved FIFO', async t => {
  let held = false, saved = []
  const locks = { async request(_name, _options, callback) { await Promise.resolve(); if (held) return callback(null); held = true
    try { return await callback({}) } finally { held = false } } }
  const journal = { read: async () => structuredClone(saved), write: async rows => { saved = structuredClone(rows) } }
  const firstOwner = ownershipApi.createDownloadOwnership({ locks }), secondOwner = ownershipApi.createDownloadOwnership({ locks })
  t.after(() => { firstOwner.dispose(); secondOwner.dispose() })
  const gate = deferred(), entered = deferred()
  const first = setup(t, { ownership: firstOwner, journal, validate: async () => { entered.resolve(); await gate.promise } })
  const second = setup(t, { ownership: secondOwner, journal })
  await first.enqueueDownloads([song(1), song(2)]); await entered.promise
  assert.deepEqual(saved.map(track => track.id), [1, 2])
  await assert.rejects(second.resumeDownloads(), { code: 'queue-busy' })
  firstOwner.dispose(); await new Promise(resolve => setTimeout(resolve, 0))
  await second.resumeDownloads(); await second.idle()
  gate.resolve(); await first.idle()
  assert.equal(await first.store.get(1), null); assert.ok(!first.events.some(event => event.state === 'done'))
  assert.deepEqual(second.sources, [1, 2]); assert.deepEqual(saved, [])
})

test('verified Blob capability cannot admit another origin, network URL, missing proof or invalid offsets', async t => {
  const bytes = new TextEncoder().encode('Checked fixture'), good = await checkedBlobPlayable(bytes)
  const changed = [
    { ...good, url: 'https://app.example/checked.mp3' }, { ...good, url: 'blob:https://other.example/file' },
    ...[{ startAt: -1 }, { startAt: 188 }, { startAt: NaN }, { id: '../file' },
      { download: { ...good.source.download, sha256: undefined } }, { download: { ...good.source.download, contentLength: 0 } },
      { download: { ...good.source.download, mime: 'text/html' } }].map(patch => ({ ...good, source: { ...good.source, ...patch } })),
    { ...good, source: { ...good.source, provider: 'youtube-p1' } },
  ]
  for (const value of changed) {
    const h = setup(t, { resolve: async () => value, fetch: async () => assert.fail('Unverified capability must not fetch') })
    await h.enqueueDownloads([song()]); await h.idle()
    assert.equal(await h.store.get(1), null); assert.ok(!h.events.some(event => event.state === 'done'))
  }
})

test('changed, truncated, wrong-MIME and partial verified Blob bodies roll back before completion', async t => {
  const bytes = new TextEncoder().encode('Checked complete fixture'), source = await checkedBlobPlayable(bytes)
  for (const response of [audioResponse(new Uint8Array(bytes.length)), audioResponse(bytes.slice(0, -1)),
    new Response(bytes, { headers: { 'content-type': 'audio/ogg' } }), new Response(bytes, { status: 206, headers: { 'content-type': 'audio/mpeg' } })]) {
    const h = setup(t, { consumeBody: true, resolve: async () => source, fetch: async () => response.clone() })
    await h.enqueueDownloads([song()]); await h.idle()
    assert.equal(await h.store.get(1), null); assert.equal(h.rows.size, 0); assert.ok(!h.events.some(event => event.state === 'done'))
  }
})

test('external downloads reject arbitrary URLs, unknown providers and unsafe IDs before fetching', async t => {
  for (const source of [externalPlayable({}, {}, { url: 'https://example.org/audio.mp3' }),
    externalPlayable({}, {}, { url: 'https://api.audius.co/v1/tracks/daMWzaJ/stream?preview=true' }),
    externalPlayable({}, { id: '../x' }), externalPlayable({}, { provider: 'verified' }),
    externalPlayable({}, { provider: 'archive' }), externalPlayable({ duration: 30 }), externalPlayable({ sha256: 'invalid' })]) {
    const h = setup(t, { resolve: async () => source, fetch: async () => assert.fail('unsafe external source') })
    await h.enqueueDownloads([song()]); await h.idle()
    assert.ok(h.events.some(event => event.state === 'error')); assert.deepEqual(await h.store.list(), [])
  }
})

test('external HTTP errors, partial bodies and non-audio responses cannot become completed downloads', async t => {
  for (const fetch of [async () => new Response('forbidden', { status: 403 }),
    async () => new Response('part', { status: 206, headers: { 'content-type': 'audio/mpeg', 'content-range': 'bytes 0-3/100' } }),
    async () => new Response('<html>Login</html>', { headers: { 'content-type': 'text/html' } }),
    async () => audioResponse(null),
    async () => audioResponse('too big', { 'content-length': String(MAX_DOWNLOAD_BYTES + 1) })]) {
    const h = setup(t, { consumeBody: true, resolve: async () => externalPlayable(), fetch })
    await h.enqueueDownloads([song()]); await h.idle()
    assert.ok(h.events.some(event => event.state === 'error')); assert.deepEqual(await h.store.list(), []); assert.equal(h.rows.size, 0)
  }
})

test('expected and declared lengths must match the whole streamed body, with one bounded renewed attempt', async t => {
  for (const [expected, declared, body] of [[10, 10, 'short'], [4, 4, 'overrun'], [10, 5, '12345']]) {
    let transfers = 0
    const h = setup(t, { consumeBody: true, resolve: async () => externalPlayable({ contentLength: expected }),
      fetch: async () => { transfers++; return audioResponse(body, { 'content-length': String(declared) }) } })
    await h.enqueueDownloads([song()]); await h.idle()
    assert.equal(transfers, 2); assert.equal(h.rows.size, 0); assert.deepEqual(await h.store.list(), [])
    assert.ok(!h.events.some(event => event.state === 'done'))
  }
})

test('a response without Content-Length records counted bytes only after the stream closes', async t => {
  let validated = 0
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array([1, 2, 3])); controller.enqueue(new Uint8Array([4, 5, 6, 7])); controller.close()
  } })
  const h = setup(t, { consumeBody: true, resolve: async () => externalPlayable(), fetch: async () => audioResponse(body),
    validate: async () => { validated++; assert.equal((await h.store.get(1)), null) } })
  await h.enqueueDownloads([song()]); await h.idle()
  assert.equal(validated, 1); assert.equal((await h.store.get(1)).size, 7)
})

test('stream errors roll back a partial external cache and renew the same source once', async t => {
  let transfers = 0
  const h = setup(t, { consumeBody: true, resolve: async () => externalPlayable(), fetch: async () => {
    transfers++
    if (transfers === 1) return audioResponse(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3])); controller.error(new TypeError('connection lost'))
    } }))
    assert.equal(h.rows.size, 0)
    return audioResponse('whole renewed body')
  } })
  await h.enqueueDownloads([song()]); await h.idle()
  assert.equal(transfers, 2); assert.equal(h.rows.size, 1); assert.equal((await h.store.get(1)).size, 18)
})

test('unknown-size external audio enforces available storage while consuming and never retries quota failures', async t => {
  let transfers = 0
  const h = setup(t, { consumeBody: true, quota: { quota: 105, usage: 100 }, resolve: async () => externalPlayable(),
    fetch: async () => { transfers++; return audioResponse('ten bytes!') } })
  await h.enqueueDownloads([song()]); await h.idle()
  assert.equal(transfers, 1); assert.equal(h.rows.size, 0)
  assert.match(h.events.find(event => event.state === 'error').error, /espacio/)
})

test('a declared checksum is checked against the full cached body before metadata commit', async t => {
  const bytes = new TextEncoder().encode('whole audio')
  const expected = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('')
  for (const [sha256, success] of [[expected, true], ['0'.repeat(64), false]]) {
    const h = setup(t, { consumeBody: true, resolve: async () => externalPlayable({ sha256 }), fetch: async () => audioResponse(bytes) })
    await h.enqueueDownloads([song()]); await h.idle()
    assert.equal(h.events.some(event => event.state === 'done'), success)
    assert.equal((await h.store.list()).length, success ? 1 : 0)
    assert.equal(h.rows.size, success ? 1 : 0)
  }
})

test('a preview duration fails validation and cannot mark its external song as downloaded', async t => {
  let validations = 0
  const h = setup(t, { consumeBody: true, resolve: async () => externalPlayable(), fetch: async () => audioResponse('preview'),
    validate: async (_url, _signal, expected) => { validations++; assert.equal(expected, 120); throw new Error('Only a 30-second preview') } })
  await h.enqueueDownloads([song()]); await h.idle()
  assert.equal(validations, 2); assert.equal(h.rows.size, 0); assert.deepEqual(await h.store.list(), [])
})

function fakeAudio(duration, tailWorks = true) {
  return class extends EventTarget {
    duration = duration; readyState = 1; seeking = false; time = 0; src = ''; preload = ''; paused = true
    get currentTime() { return this.time }
    set currentTime(value) {
      this.time = value
      queueMicrotask(() => { this.readyState = tailWorks ? 2 : 1; this.dispatchEvent(new Event(tailWorks ? 'seeked' : 'error')) })
    }
    load() { if (this.src) queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata'))) }
    pause() {}
    removeAttribute(name) { if (name === 'src') this.src = '' }
  }
}
test('default external audio validation requires expected duration plus decodable tail; legacy two-argument validation remains compatible', async t => {
  const signal = new AbortController().signal
  const valid = setup(t, { Audio: fakeAudio(120) })
  await valid.exports.validateDownloadedAudio(stage(), signal, 120)
  const preview = setup(t, { Audio: fakeAudio(30) })
  await assert.rejects(preview.exports.validateDownloadedAudio(stage(), signal, 120), /duración/)
  const truncated = setup(t, { Audio: fakeAudio(120, false) })
  await assert.rejects(truncated.exports.validateDownloadedAudio(stage(), signal, 120), /audio reproducible/)
  await truncated.exports.validateDownloadedAudio(stage(), signal)
})
