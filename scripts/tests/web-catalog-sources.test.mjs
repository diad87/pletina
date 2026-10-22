import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const compile = async name => ts.transpileModule(await readFile(new URL(`../../web-port/${name}.ts`, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText
const [code, catalogCode] = await Promise.all([compile('catalog-sources'), compile('catalog')])
const mapping = {}; new Function('exports', catalogCode)(mapping)
const query = { id: 4260344111, title: 'The One', titleVersion: null, artist: 'JAMES V', album: 'The One', duration: 220, isrc: 'GXLEX2692321' }
const candidate = (extra = {}) => ({ id: 'daMWzaJ', title: 'The One', user: { name: 'JAMES V' }, duration: 220, isrc: query.isrc,
  is_available: true, is_delete: false, is_streamable: true, is_stream_gated: false,
  is_downloadable: false, is_download_gated: false, access: { stream: true, download: true }, remix_of: { tracks: [] }, ...extra })
const rawDetail = (extra = {}) => ({ id: query.id, title: query.title, title_version: '', artist: { id: 1, name: query.artist },
  album: { id: 2, title: query.album }, duration: query.duration, isrc: query.isrc, ...extra })
function engine({ result = { data: [candidate()] }, request, catalog = async () => rawDetail(), timers } = {}) {
  const exports = {}, calls = [], catalogCalls = []
  const fetch = async (url, options) => {
    calls.push({ url, options })
    if (request) return request(url, options)
    return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(result) }
  }
  const require = name => {
    assert.equal(name, './catalog')
    return { ...mapping, requestCatalog: async (...args) => { catalogCalls.push(args); return catalog(...args) } }
  }
  new Function('exports', 'require', 'fetch', 'setTimeout', 'clearTimeout', code)(exports, require, fetch,
    timers?.setTimeout ?? setTimeout, timers?.clearTimeout ?? clearTimeout)
  return { ...exports, calls, catalogCalls }
}

test('generic ISRC lookup accepts the same recording and returns only a constructed provider URL', async () => {
  const api = engine({ result: { data: [candidate({ stream: { url: 'https://attacker.invalid/?signature=secret' } })] } })
  const playable = await api.resolveCatalogSource(query)
  assert.equal(playable.url, 'https://api.audius.co/v1/tracks/daMWzaJ/stream')
  assert.equal(playable.videoId, '')
  assert.deepEqual({ ...playable.source, expiresAt: undefined }, { provider: 'audius', id: 'daMWzaJ', expiresAt: undefined,
    download: { allowed: false, duration: 220 } })
  assert.equal(api.catalogCalls.length, 0)
  assert.equal(api.calls.length, 1)
  assert.equal(api.calls[0].url, 'https://api.audius.co/v1/tracks?isrc=GXLEX2692321&limit=25')
  assert.equal(api.calls[0].options.credentials, 'omit')
  assert.equal(api.calls[0].options.redirect, 'error')
  assert.equal(api.calls[0].options.referrerPolicy, 'no-referrer')
})

test('another valid ISRC is not tied to a closed list of test recordings', async () => {
  const wanted = { ...query, id: 4248921261, title: 'Dancefloor', artist: 'Quinn Ayers', album: 'Dancefloor', duration: 155, isrc: 'QMDA72636635' }
  const api = engine({ result: { data: [candidate({ id: 'q7r1Kgb', title: wanted.title, user: { name: wanted.artist }, duration: wanted.duration, isrc: wanted.isrc })] } })
  assert.equal((await api.resolveCatalogSource(wanted)).source.id, 'q7r1Kgb')
})

test('ISRC normalization accepts conventional hyphens and rejects non-ISRC identifiers', () => {
  const api = engine()
  assert.equal(api.normalizeIsrc(' gx-lex-26-92321 '), query.isrc)
  for (const value of ['', null, 1, 'GXLEX269232', 'GXLEX26923210', '12LEX2692321', 'GXLEX26<script>', 'https://example.org']) {
    assert.equal(api.normalizeIsrc(value), null)
  }
})

test('same title by another artist or with a different ISRC/duration never substitutes', async () => {
  for (const extra of [{ user: { name: 'Another Artist' } }, { isrc: 'QMDA72636635' }, { duration: 30 }, { duration: 224 },
    { duration: null }, { duration: Infinity }, { title: 'Something Else' }]) {
    const api = engine({ result: { data: [candidate(extra)] } })
    assert.equal(await api.resolveCatalogSource(query), null, JSON.stringify(extra))
  }
})

test('live, cover, karaoke, instrumental, remix and changed versions are rejected even with matching ISRC', async () => {
  for (const version of ['Live', 'Karaoke', 'Instrumental', 'Cover', 'Remix', 'Acoustic', 'Sped Up', 'Remastered']) {
    const api = engine({ result: { data: [candidate({ title: `The One (${version})` })] } })
    assert.equal(await api.resolveCatalogSource(query), null, version)
  }
  for (const extra of [{ cover_original_song_title: 'The One' }, { cover_original_artist: 'JAMES V' },
    { stem_of: { parent_track_id: 'x' } }, { remix_of: { tracks: [{ parent_track_id: 'x' }] } }, { remix_of: { tracks: 'bad' } }]) {
    assert.equal(engine().matchAudiusRecording(query, candidate(extra)), null)
  }
})

test('the requested version must be present and artist prefixes only identify that same artist', () => {
  const api = engine()
  assert.ok(api.matchAudiusRecording({ ...query, titleVersion: '(Live)' }, candidate({ title: 'The One (Live)' })))
  assert.equal(api.matchAudiusRecording({ ...query, titleVersion: '(Live)' }, candidate()), null)
  assert.ok(api.matchAudiusRecording(query, candidate({ title: 'JAMES V - The One' })))
  assert.equal(api.matchAudiusRecording(query, candidate({ title: 'Another Artist - The One' })), null)
  assert.equal(api.matchAudiusRecording({ ...query, title: 'Remixology', titleVersion: 'Remix' }, candidate({ title: 'Remixology' })), null)
})

test('gated, unavailable, deleted, non-streamable and unknown provider IDs are rejected', async () => {
  for (const extra of [{ is_stream_gated: true }, { is_available: false }, { is_delete: true }, { is_streamable: false },
    { access: { stream: false } }, { access: {} }, { is_stream_gated: undefined }, { id: '../../other' },
    { id: 'https://example.org' }, { id: 'a?preview=true' }, { id: '' }, { id: 'í' }, { id: 'x'.repeat(31) }]) {
    const api = engine({ result: { data: [candidate(extra)] } })
    assert.equal(await api.resolveCatalogSource(query), null, JSON.stringify(extra))
  }
})

test('download is allowed only when explicitly downloadable and ungated, independently of stream access', async () => {
  const allowed = engine({ result: { data: [candidate({ is_downloadable: true })] } })
  assert.equal((await allowed.resolveCatalogSource(query)).source.download.allowed, true)
  for (const extra of [{ is_downloadable: true, is_download_gated: true }, { is_downloadable: true, access: { stream: true, download: false } },
    { is_downloadable: true, is_download_gated: undefined }, { is_downloadable: undefined }]) {
    assert.equal((await engine({ result: { data: [candidate(extra)] } }).resolveCatalogSource(query)).source.download.allowed, false)
  }
})

test('missing ISRC is hydrated from the same numeric catalog recording before provider access', async () => {
  const api = engine()
  assert.equal((await api.resolveCatalogSource({ ...query, isrc: null })).source.id, 'daMWzaJ')
  assert.equal(api.catalogCalls.length, 1)
  assert.deepEqual(api.catalogCalls[0], ['/track/4260344111', { signal: undefined }, true])
  assert.equal(api.calls.length, 1)
})

test('hydration never imports an ISRC from a different ID, artist, album, title, duration or version', async () => {
  for (const extra of [{ id: query.id + 1 }, { title: 'Another Song' }, { artist: { id: 1, name: 'Another Artist' } },
    { album: { id: 2, title: 'Another Album' } }, { duration: 30 }, { title_version: '(Live)' }, { isrc: null }]) {
    const api = engine({ catalog: async () => rawDetail(extra) })
    assert.equal(await api.resolveCatalogSource({ ...query, isrc: null }), null, JSON.stringify(extra))
    assert.equal(api.calls.length, 0)
  }
  const missing = engine({ catalog: async () => null })
  assert.equal(await missing.resolveCatalogSource({ ...query, isrc: null }), null)
  assert.equal(missing.calls.length, 0)
})

test('direct YouTube, podcasts, local tracks and invalid queries trigger no hydration or provider request', async () => {
  for (const change of [{ id: 0 }, { id: -1 }, { id: 1.5 }, { id: 250000000000000 }, { id: 500000000000000 },
    { id: 1000000000000000 }, { title: '' }, { title: '!!!' }, { artist: '' }, { artist: '---' }, { album: null },
    { duration: 0 }, { duration: NaN }, { titleVersion: {} }]) {
    const api = engine()
    assert.equal(await api.resolveCatalogSource({ ...query, ...change, isrc: null }), null)
    assert.equal(api.catalogCalls.length, 0); assert.equal(api.calls.length, 0)
  }
})

test('empty valid responses return null but HTTP, transport and malformed payload failures remain typed', async () => {
  assert.equal(await engine({ result: { data: [] } }).resolveCatalogSource(query), null)
  for (const request of [async () => { throw new TypeError('Failed to fetch') },
    async () => ({ ok: false, status: 503 }),
    async () => ({ ok: true, headers: new Headers(), text: async () => 'not JSON' }),
    async () => ({ ok: true, headers: new Headers({ 'content-length': '2000000' }), text: async () => '{}' }),
    async () => ({ ok: true, headers: new Headers(), text: async () => 'x'.repeat(1024 * 1024 + 1) })]) {
    const api = engine({ request })
    await assert.rejects(api.resolveCatalogSource(query), error => error instanceof api.CatalogSourceError && ['network', 'protocol'].includes(error.code))
  }
  for (const result of [{ error: 'failure' }, { data: {} }, { data: Array(26).fill(candidate()) }]) {
    const api = engine({ result })
    await assert.rejects(api.resolveCatalogSource(query), error => error.code === 'protocol')
  }
})

test('hydration network/protocol errors are not confused with catalog absence', async () => {
  const broken = engine({ catalog: async () => { throw new Error('network') } })
  await assert.rejects(broken.resolveCatalogSource({ ...query, isrc: null }), error => error.code === 'network')
  const malformed = engine({ catalog: async () => ({ id: 'bad' }) })
  await assert.rejects(malformed.resolveCatalogSource({ ...query, isrc: null }), error => error.code === 'protocol')
})

test('chunked oversized payloads stop at the byte bound and cancel the reader', async () => {
  let reads = 0, cancelled = 0, released = 0
  const api = engine({ request: async () => ({ ok: true, headers: new Headers(), body: { getReader: () => ({
    read: async () => { reads++; return { done: false, value: new Uint8Array(600000) } },
    cancel: async () => { cancelled++ }, releaseLock: () => { released++ },
  }) } }) })
  await assert.rejects(api.resolveCatalogSource(query), error => error.code === 'protocol')
  assert.equal(reads, 2); assert.equal(cancelled, 1); assert.equal(released, 1)
})

test('already aborted input starts no work and abort during hydration cannot advance to Audius', async () => {
  const controller = new AbortController(); controller.abort(new DOMException('Stop', 'AbortError'))
  const api = engine()
  await assert.rejects(api.resolveCatalogSource(query, controller.signal), { name: 'AbortError' })
  assert.equal(api.calls.length, 0); assert.equal(api.catalogCalls.length, 0)
  const second = new AbortController()
  const hydrated = engine({ catalog: async () => { second.abort(new DOMException('Replaced', 'AbortError')); return rawDetail() } })
  await assert.rejects(hydrated.resolveCatalogSource({ ...query, isrc: null }, second.signal), { name: 'AbortError' })
  assert.equal(hydrated.calls.length, 0)
})

test('aborting an in-flight provider request preserves the reason and clears listeners/timer', async () => {
  const controller = new AbortController(), original = new DOMException('Replaced', 'AbortError')
  let removed = 0, cleared = 0
  const remove = controller.signal.removeEventListener.bind(controller.signal)
  controller.signal.removeEventListener = (...args) => { removed++; return remove(...args) }
  const api = engine({ request: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }), timers: { setTimeout: () => 1, clearTimeout: () => { cleared++ } } })
  const pending = api.resolveCatalogSource(query, controller.signal)
  for (let i = 0; i < 5; i++) await Promise.resolve()
  controller.abort(original)
  await assert.rejects(pending, error => error === original)
  assert.equal(removed, 1); assert.equal(cleared, 1)
})

test('provider deadline is finite and its timeout remains distinct from an empty result', async () => {
  let fire, milliseconds, cleared = 0
  const api = engine({ request: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }), timers: { setTimeout: (callback, delay) => { fire = callback; milliseconds = delay; return 1 }, clearTimeout: () => { cleared++ } } })
  const pending = api.resolveCatalogSource(query)
  for (let i = 0; i < 5; i++) await Promise.resolve()
  assert.ok(milliseconds > 0 && milliseconds <= 7000)
  fire()
  await assert.rejects(pending, error => error.code === 'timeout')
  assert.equal(cleared, 1)
})
