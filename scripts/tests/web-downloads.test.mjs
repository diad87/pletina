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
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
const song = (id = 1, extra = {}) => ({ id, title: `Canción ${id}`, duration: 120, explicit: false,
  artistId: 10, artistName: 'Artista', albumId: 20, albumTitle: 'Álbum', albumArtistId: 10, cover: 'https://images.example/cover.jpg', ...extra })
const scope = 'https://app.example/pletina/'
const stage = (id = 1) => `${scope}__audio__/${id}?stage=1234567890-11111111-1111-4111-8111-111111111111`
function setup(t, options = {}) {
  const rows = new Map(), events = [], sources = [], validations = []
  const cache = {
    async put(key, value) { rows.set(key, value); if (options.putError) throw options.putError },
    async match(key) { return rows.get(key) },
    async delete(key) { return rows.delete(key) },
  }
  const caches = { async open(name) { assert.equal(name, DOWNLOAD_CACHE); return cache } }
  const factory = new IDBFactory(), name = 'download-test-' + crypto.randomUUID()
  const store = createDownloadStore({ indexedDB: factory, name, scope, caches })
  t.after(() => store.close())
  const exports = {}
  new Function('exports', 'require', code)(exports, (path) => path === './download-store' ? storeModule
    : path === './audio' ? { resolveRemoteTrack() { assert.fail('uninjected resolver') } }
    : path === './youtube' ? { stream() { assert.fail('uninjected stream') } } : assert.fail(path))
  const manager = exports.createDownloadManager({
    store, caches, emit: (value) => events.push(value), timeout: options.timeout ?? 2000, retryDelay: options.retryDelay ?? 0,
    resolve: options.resolve ?? (async (query) => { sources.push(query.id); return { videoId: '9RfVp-GhKfs', local: false, url: 'https://r1.googlevideo.com/audio?signature=SECRET' } }),
    stream: options.stream ?? (async () => ({ videoId: '9RfVp-GhKfs', url: 'https://r1.googlevideo.com/audio?signature=SECRET', contentLength: options.size ?? 1234 })),
    fetch: options.fetch ?? (async (_url, init) => { assert.equal(init.mode, 'no-cors'); assert.equal(init.credentials, 'omit'); return new Response('opaque fixture bytes') }),
    validate: options.validate ?? (async (url) => { validations.push(url) }),
    storage: { estimate: async () => options.quota ?? { quota: 1024 ** 3, usage: 0 }, persist: async () => false },
  })
  return { ...manager, rows, events, sources, validations, store, factory, name, caches, exports }
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

test('cancel discards only pending jobs while the active transfer finishes', async (t) => {
  const gate = deferred(), started = deferred()
  const h = setup(t, { validate: async () => { started.resolve(); await gate.promise } })
  await h.enqueueDownloads([song(1), song(2), song(3)])
  await started.promise
  h.cancelDownloads()
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

test('a hung resolver times out without committing or blocking the next queued transfer', async (t) => {
  const never = deferred()
  const h = setup(t, { timeout: 30, resolve: async (query) => query.id === 1 ? never.promise : { videoId: '9RfVp-GhKfs', local: false } })
  await h.enqueueDownloads([song(1), song(2)]); await h.idle()
  assert.ok(h.events.some((value) => value.trackId === 1 && value.state === 'error'))
  assert.ok(h.events.some((value) => value.trackId === 2 && value.state === 'done'))
  never.resolve({ videoId: '9RfVp-GhKfs', local: false })
  await flush()
  assert.equal(await h.store.get(1), null)
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

test('a persistent transfer failure is bounded to two attempts and does not hold the next queued song', async (t) => {
  const resolutions = []
  let current = 0, transfers = 0
  const h = setup(t, {
    resolve: async (query, refresh) => { current = query.id; resolutions.push([query.id, refresh]); return { videoId: '9RfVp-GhKfs', local: false } },
    fetch: async () => {
      transfers++
      if (current === 1) throw new TypeError('Network request failed')
      return new Response('second song')
    },
  })
  await h.enqueueDownloads([song(1), song(2)]); await h.idle()
  assert.deepEqual(resolutions, [[1, false], [1, true], [2, false]])
  assert.equal(transfers, 3)
  assert.deepEqual(h.events.filter((value) => value.state === 'error').map((value) => value.trackId), [1])
  assert.deepEqual(h.events.filter((value) => value.state === 'done').map((value) => value.trackId), [2])
  assert.equal(await h.store.get(1), null)
  assert.equal(h.rows.size, 1)
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
  h.cancelDownloads()
  renewed.resolve({ videoId: '9RfVp-GhKfs', local: false })
  await h.idle()
  assert.deepEqual(resolutions, [[1, false], [1, true]])
  assert.deepEqual(h.events.filter((value) => value.state === 'cancelled').map((value) => value.trackId), [2, 3])
  assert.deepEqual((await h.listDownloads()).map((value) => value.track.id), [1])
})

test('the original transfer deadline also bounds retry waiting and the next queued download can still finish', async (t) => {
  const resolutions = []
  let current = 0, transfers = 0
  const h = setup(t, {
    timeout: 30, retryDelay: 80,
    resolve: async (query, refresh) => { current = query.id; resolutions.push([query.id, refresh]); return { videoId: '9RfVp-GhKfs', local: false } },
    fetch: async () => { transfers++; if (current === 1) throw new TypeError('Network request failed'); return new Response('next song') },
  })
  await h.enqueueDownloads([song(1), song(2)]); await h.idle()
  assert.deepEqual(resolutions, [[1, false], [2, false]], 'an expired global deadline cannot start a renewed request')
  assert.equal(transfers, 2)
  assert.deepEqual(h.events.filter((value) => value.state === 'error').map((value) => value.trackId), [1])
  assert.deepEqual(h.events.filter((value) => value.state === 'done').map((value) => value.trackId), [2])
  assert.deepEqual((await h.listDownloads()).map((value) => value.track.id), [2])
})
