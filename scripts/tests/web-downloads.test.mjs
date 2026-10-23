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
    },
    async match(key) { const value = rows.get(key); return value?.clone ? value.clone() : value },
    async delete(key) { return rows.delete(key) },
  }
  const caches = { async open(name) { assert.equal(name, DOWNLOAD_CACHE); return cache } }
  const factory = new IDBFactory(), name = 'download-test-' + crypto.randomUUID()
  const store = createDownloadStore({ indexedDB: factory, name, scope, caches })
  t.after(() => store.close())
  const exports = {}
  new Function('exports', 'require', 'Audio', code)(exports, (path) => path === './download-store' ? storeModule
    : path === './audio' ? { resolveRemoteTrack() { assert.fail('uninjected resolver') } }
    : path === './download-queue' ? { defaultDownloadQueueJournal: () => journal }
    : path === './download-ownership' ? { defaultDownloadOwnership: () => ({ acquire: async () => {}, assertOwned() {} }) }
    : path === './youtube' ? { stream() { assert.fail('uninjected stream') } } : assert.fail(path), options.Audio ?? globalThis.Audio)
  const manager = exports.createDownloadManager({
    store, caches, journal, online: options.online ?? (() => true), emit: (value) => events.push(value), timeout: options.timeout ?? 2000, retryDelay: options.retryDelay ?? 0,
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
