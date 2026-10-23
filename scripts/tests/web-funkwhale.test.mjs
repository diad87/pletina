import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import ts from 'typescript'

const code = ts.transpileModule(await readFile(new URL('../../web-port/funkwhale.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText
const pod = 'https://open.audio', trackUuid = '1cee2898-d5f2-4ce8-9bf3-7f64c6587421', uploadUuid = '51b06556-531b-43a9-b714-ab399c986f69'
const query = { id: 2934405891, title: 'Cylinder Six', titleVersion: '', artist: 'Chris Zabriskie', album: 'Cylinders', duration: 105, isrc: 'GBKPL1370800' }
const locator = { pod, trackId: 432473, trackUuid, uploadUuid }
const listen = `${pod}/api/v2/listen/${trackUuid}/?upload=${uploadUuid}`
const sample = new Uint8Array([73, 68, 51, 4, 1, 2, 3, 4])
const node = () => ({ software: { name: 'funkwhale', version: '2.0.12.dev0+f10a9e72' }, metadata: { library: { anonymousCanListen: true } } })
const upload = (extra = {}) => ({ uuid: uploadUuid, listen_url: listen.slice(pod.length), is_local: true, duration: 105,
  size: sample.length, mimetype: 'audio/mpeg', extension: 'mp3', bitrate: 320000, ...extra })
const row = (extra = {}) => ({ id: locator.trackId, fid: `${pod}/federation/music/tracks/${trackUuid}`, title: query.title,
  title_version: '', album: { title: query.album }, artist_credit: [{ credit: query.artist, joinphrase: '' }],
  is_local: true, is_playable: true, content_category: 'music', license: 'cc-by-4.0', uploads: [upload()], ...extra })
const response = (value, headers = {}, url = '') => {
  const result = new Response(value, { headers })
  if (url) Object.defineProperty(result, 'url', { value: url })
  return result
}
function engine(config = {}) {
  const exports = {}, calls = []
  new Function('exports', 'document', code)(exports, config.document)
  const transport = async (url, options) => {
    calls.push({ url, options })
    if (config.request) return config.request(url, options)
    const value = url.includes('nodeinfo') ? config.node ?? node() : { results: config.rows ?? [row()] }
    return response(JSON.stringify(value), { 'content-type': 'application/json' })
  }
  return { ...exports, calls, discover: (track = query, signal, options = {}) => exports.discoverFunkwhaleCandidates(track, signal, {
    fetch: transport, verifiedSources: [locator], canPlayType: () => 'probably', ...options,
  }), transport }
}
const candidate = (extra = {}) => ({ ...locator, provider: 'funkwhale', apiVersion: 'v2', title: query.title, titleVersion: '',
  artist: query.artist, album: query.album, duration: 105, contentLength: sample.length, mime: 'audio/mpeg', extension: 'mp3', codec: 'mp3',
  bitrate: 320000, lossless: false, isrc: null, recordingMbid: null, declaredLicense: 'cc-by-4.0', ...extra })
const errorCode = code => error => error.name === 'FunkwhaleError' && error.code === code

test('verified locator permits generic discovery with public v2 routes and explicit no-credential CORS', async () => {
  const api = engine(), found = await api.discover()
  assert.equal(found.length, 1)
  assert.deepEqual(found[0], candidate({ titleVersion: null }))
  assert.equal(api.calls[0].url, `${pod}/api/v1/instance/nodeinfo/2.0/`)
  assert.equal(api.calls[1].url, `${pod}/api/v2/tracks/?q=Cylinder%20Six&page_size=20`)
  for (const call of api.calls) {
    assert.equal(call.options.credentials, 'omit')
    assert.equal(call.options.mode, 'cors')
    assert.equal(call.options.redirect, 'error')
    assert.equal(call.options.referrerPolicy, 'no-referrer')
  }
})

test('missing, empty or invalid verified index performs zero provider requests', async () => {
  for (const verifiedSources of [undefined, [], [{ ...locator, pod: 'https://elsewhere.invalid' }], [{ ...locator, uploadUuid: '../bad' }]]) {
    const api = engine()
    assert.deepEqual(await api.discover(query, undefined, { verifiedSources }), [])
    assert.equal(api.calls.length, 0)
  }
})

test('malformed canonical identities never reach provider discovery', async () => {
  for (const patch of [{ id: -1 }, { id: 250_000_000_000_000 }, { title: '' }, { artist: ' ' }, { duration: NaN }, { duration: 0 }, { album: null }, { isrc: null }, { isrc: 'bad' }]) {
    const api = engine()
    assert.deepEqual(await api.discover({ ...query, ...patch }), [])
    assert.equal(api.calls.length, 0)
  }
})

test('same title, different artist, album, qualifier, version or duration is rejected', async () => {
  for (const extra of [{ title: 'Cylinder Six (Live)' }, { title_version: '(Remastered)' }, { title_version: 'Karaoke' },
    { album: { title: 'Another Release' } }, { artist_credit: [{ credit: 'Another Artist' }] },
    { uploads: [upload({ duration: 109 })] }, { uploads: [upload({ duration: null })] }]) {
    assert.deepEqual(await engine({ rows: [row(extra)] }).discover(), [], JSON.stringify(extra))
  }
  const api = engine({ rows: [row({ title: 'Cylinder Six (Live)', title_version: '(Live)' })] })
  assert.equal((await api.discover({ ...query, titleVersion: '(Live)' })).length, 1)
  assert.deepEqual(await engine().discover({ ...query, titleVersion: '(Live)' }), [])
})

test('multiple artist credits must match the complete requested artist string', async () => {
  const rows = [row({ artist_credit: [{ credit: 'Chris Zabriskie', joinphrase: ' & ' }, { credit: 'Another Artist', joinphrase: '' }] })]
  assert.deepEqual(await engine({ rows }).discover(), [])
  assert.equal((await engine({ rows }).discover({ ...query, artist: 'Chris Zabriskie & Another Artist' })).length, 1)
})

test('claimed ISRC and recording MBIDs cannot be malformed or contradictory', async () => {
  for (const extra of [{ isrc: 'GBKPL1370801' }, { isrc: 'malformed' }, { mbid: 'not-a-uuid' },
    { mbid: trackUuid, uploads: [upload({ mbid: uploadUuid })] }, { uploads: [upload({ isrc: 'GBKPL1370801' })] }]) {
    assert.deepEqual(await engine({ rows: [row(extra)] }).discover(), [])
  }
  const found = await engine({ rows: [row({ isrc: 'GB-KPL-13-70800', mbid: trackUuid, uploads: [upload({ mbid: trackUuid })] })] }).discover()
  assert.equal(found[0].isrc, query.isrc)
  assert.equal(found[0].recordingMbid, trackUuid)
})

test('only local playable music with the exact indexed upload identity is eligible', async () => {
  for (const extra of [{ is_local: false }, { is_playable: false }, { is_public: false }, { is_private: true }, { content_category: 'podcast' }, { id: locator.trackId + 1 },
    { fid: 'https://attacker.invalid/file' }, { uploads: [upload({ is_local: false })] }, { uploads: [upload({ uuid: trackUuid })] },
    { uploads: [upload({ is_public: false })] },
    { uploads: [upload({ size: 0 })] }, { uploads: [upload({ size: 32 * 1024 ** 2 + 1 })] }]) {
    assert.deepEqual(await engine({ rows: [row(extra)] }).discover(), [], JSON.stringify(extra))
  }
})

test('listen route rejects arbitrary origins, duplicate parameters, transcodes and different UUIDs', async () => {
  for (const listen_url of [`https://attacker.invalid/api/v2/listen/${trackUuid}/?upload=${uploadUuid}`, `${listen}&upload=${uploadUuid}`,
    `${listen}&to=mp3`, `${listen}#x`, listen.replace('/v2/', '/v1/'), listen.replace(trackUuid, uploadUuid),
    listen.replace(uploadUuid, '../wrong'), `https://user:pass@open.audio/api/v2/listen/${trackUuid}/?upload=${uploadUuid}`]) {
    assert.deepEqual(await engine({ rows: [row({ uploads: [upload({ listen_url })] })] }).discover(), [], listen_url)
  }
})

test('browser codec compatibility filters unsupported OGG without assuming iPhone support', async () => {
  const rows = [row({ uploads: [upload({ mimetype: 'audio/ogg', extension: 'ogg' })] })]
  const api = engine({ rows }), probes = []
  assert.deepEqual(await api.discover(query, undefined, { canPlayType: mime => { probes.push(mime); return '' } }), [])
  assert.deepEqual(probes, ['audio/ogg; codecs="vorbis"'])
  assert.equal((await api.discover(query, undefined, { canPlayType: () => 'maybe' }))[0].codec, 'vorbis')
})

test('default browser compatibility uses one detached media probe, with no src or playback', async () => {
  let elements = 0, probes = 0
  const document = { createElement(tag) { assert.equal(tag, 'audio'); elements++; return { canPlayType(mime) { assert.equal(mime, 'audio/mpeg'); probes++; return 'probably' } } } }
  const api = engine({ rows: [row(), row()], document })
  const found = await api.discover(query, undefined, { canPlayType: undefined })
  assert.equal(found.length, 1)
  assert.equal(elements, 1)
  assert.equal(probes, 2)
})

test('formats must be recognized audio with coherent MIME extension and codec', async () => {
  for (const extra of [{ mimetype: 'video/mp4', extension: 'mp4' }, { mimetype: 'application/vnd.apple.mpegurl', extension: 'm3u8' },
    { mimetype: 'audio/mpeg', extension: 'ogg' }, { codec: 'alac' }, { extension: 'exe' }]) {
    assert.deepEqual(await engine({ rows: [row({ uploads: [upload(extra)] })] }).discover(), [])
  }
  assert.equal((await engine({ rows: [row({ uploads: [upload({ mimetype: 'audio/flac', extension: 'flac' })] })] }).discover())[0].lossless, true)
})

test('ranking favors supported lossless, then quality tiers and bitrate only within a codec', () => {
  const api = engine(), mp3 = candidate({ contentLength: 4000000, bitrate: 320000 }), opus = candidate({ codec: 'opus', contentLength: 2000000, bitrate: 160000 }),
    flac = candidate({ codec: 'flac', lossless: true, contentLength: 20000000, bitrate: 1500000 }), lowMp3 = candidate({ bitrate: 96000 })
  assert.deepEqual(api.rankFunkwhaleCandidates([mp3, flac, opus, lowMp3]), [flac, opus, mp3, lowMp3])
  const midMp3 = candidate({ bitrate: 192000 })
  assert.deepEqual(api.rankFunkwhaleCandidates([midMp3, mp3]), [mp3, midMp3])
})

test('duplicate search results do not duplicate candidates', async () => {
  assert.equal((await engine({ rows: [row(), row()] }).discover()).length, 1)
})

test('private instances and unknown API versions are errors, not empty catalogs', async () => {
  const privateNode = node(); privateNode.metadata.library.anonymousCanListen = false
  await assert.rejects(engine({ node: privateNode }).discover(), errorCode('permission'))
  for (const version of ['1.4.0', '3.0.0', null]) {
    const metadata = node(); metadata.software.version = version
    await assert.rejects(engine({ node: metadata }).discover(), errorCode('protocol'))
  }
})

test('provider HTTP, malformed JSON and oversized payload errors remain distinguishable from no matches', async () => {
  await assert.rejects(engine({ request: async () => new Response('{}', { status: 503 }) }).discover(), errorCode('network'))
  await assert.rejects(engine({ request: async () => response('<html>', { 'content-type': 'text/html' }) }).discover(), errorCode('protocol'))
  await assert.rejects(engine({ request: async () => response('{', { 'content-type': 'application/json' }) }).discover(), errorCode('protocol'))
  await assert.rejects(engine({ request: async () => response('x'.repeat(1024 ** 2 + 1), { 'content-type': 'application/json' }) }).discover(), errorCode('protocol'))
  assert.deepEqual(await engine({ rows: [] }).discover(), [])
})

test('HTTP error metadata bodies are cancelled without reading unbounded error pages', async () => {
  let cancelled = false
  const api = engine({ request: async () => new Response(new ReadableStream({ cancel() { cancelled = true } }), { status: 503 }) })
  await assert.rejects(api.discover(), errorCode('network'))
  assert.equal(cancelled, true)
})

test('global discovery timeout covers node and search even when fetch ignores abort', async () => {
  const api = engine({ request: async url => url.includes('nodeinfo') ? response(JSON.stringify(node()), { 'content-type': 'application/json' }) : new Promise(() => {}) })
  await assert.rejects(api.discover(query, undefined, { timeout: 15 }), errorCode('timeout'))
  assert.equal(api.calls.length, 2)
})

test('abort reason is preserved before requests and while discovery is pending', async () => {
  const controller = new AbortController(), reason = new DOMException('Test cancelled', 'AbortError'), api = engine({ request: async () => new Promise(() => {}) })
  const pending = api.discover(query, controller.signal)
  controller.abort(reason)
  await assert.rejects(pending, value => value === reason)
  const other = engine()
  await assert.rejects(other.discover(query, controller.signal), value => value === reason)
  assert.equal(other.calls.length, 0)
})

test('full file fetch constructs the known route and returns verified complete bytes, hash and actual MIME only', async () => {
  const api = engine(), calls = []
  const file = await api.fetchFunkwhaleAudio(candidate(), undefined, { fetch: async (url, options) => {
    calls.push({ url, options }); return response(sample, { 'content-type': 'audio/mpeg', 'content-length': String(sample.length) }, listen)
  } })
  assert.deepEqual(file.bytes, sample)
  assert.equal(file.sha256, createHash('sha256').update(sample).digest('hex'))
  assert.equal(file.mime, 'audio/mpeg')
  assert.deepEqual(Object.keys(file).sort(), ['bytes', 'mime', 'sha256'])
  assert.equal(calls[0].url, listen)
  assert.equal(calls[0].options.credentials, 'omit')
  assert.equal(calls[0].options.mode, 'cors')
})

test('unrecognized candidate locators and file bounds fail before network', async () => {
  for (const extra of [{ pod: 'https://attacker.invalid' }, { trackUuid: '../../etc' }, { apiVersion: 'v1' }, { provider: 'unknown' },
    { contentLength: 0 }, { contentLength: 32 * 1024 ** 2 + 1 }, { mime: 'text/html' }]) {
    let calls = 0
    await assert.rejects(engine().fetchFunkwhaleAudio(candidate(extra), undefined, { fetch: async () => { calls++; throw new Error('must not run') } }), errorCode('protocol'))
    assert.equal(calls, 0)
  }
})

test('truncated, oversized and partial media can never become verified audio', async () => {
  for (const makeResponse of [() => response(sample.subarray(1), { 'content-type': 'audio/mpeg' }),
    () => response(new Uint8Array(sample.length + 1), { 'content-type': 'audio/mpeg' }),
    () => response(sample, { 'content-type': 'audio/mpeg', 'content-length': '30' }),
    () => response(sample, { 'content-type': 'audio/mpeg', 'content-range': 'bytes 0-7/100' }),
    () => new Response(sample, { status: 206, headers: { 'content-type': 'audio/mpeg' } }),
    () => response(sample, { 'content-type': 'audio/ogg' }), () => response(sample, { 'content-type': 'text/html' })]) {
    await assert.rejects(engine().fetchFunkwhaleAudio(candidate(), undefined, { fetch: async () => makeResponse() }), errorCode('protocol'))
  }
})

test('opaque media is rejected and only the provider own storage redirect is accepted', async () => {
  const api = engine()
  const opaque = response(sample, { 'content-type': 'audio/mpeg' }); Object.defineProperty(opaque, 'type', { value: 'opaque' })
  await assert.rejects(api.fetchFunkwhaleAudio(candidate(), undefined, { fetch: async () => opaque }), errorCode('protocol'))
  for (const url of ['https://attacker.invalid/music.mp3', 'https://s3.eu-central-2.wasabisys.com/another-bucket/music.mp3',
    'http://open.audio/music.mp3', 'https://user:secret@open.audio/music.mp3']) {
    await assert.rejects(api.fetchFunkwhaleAudio(candidate(), undefined, { fetch: async () => response(sample, { 'content-type': 'audio/mpeg' }, url) }), errorCode('protocol'))
  }
  const file = await api.fetchFunkwhaleAudio(candidate(), undefined, { fetch: async () => response(sample, { 'content-type': 'audio/mpeg' },
    'https://s3.eu-central-2.wasabisys.com/open-audio/music.mp3?X-Amz-Signature=not-persisted') })
  assert.equal(file.bytes.length, sample.length)
  assert.equal(JSON.stringify(file).includes('Signature'), false)
})

test('body reads are cancelled on abort and per-file timeout', async () => {
  let cancelled = false
  const request = async () => response(new ReadableStream({ start(controller) { controller.enqueue(sample.subarray(0, 2)) }, cancel() { cancelled = true } }), { 'content-type': 'audio/mpeg' })
  const api = engine(), controller = new AbortController(), reason = new DOMException('Cancelled during media', 'AbortError')
  const pending = api.fetchFunkwhaleAudio(candidate(), controller.signal, { fetch: request })
  await new Promise(resolve => setTimeout(resolve, 5)); controller.abort(reason)
  await assert.rejects(pending, value => value === reason)
  assert.equal(cancelled, true)
  cancelled = false
  await assert.rejects(api.fetchFunkwhaleAudio(candidate(), undefined, { fetch: request, timeout: 15 }), errorCode('timeout'))
  assert.equal(cancelled, true)
})

test('file timeout also settles an uncooperative pending fetch', async () => {
  await assert.rejects(engine().fetchFunkwhaleAudio(candidate(), undefined, { fetch: async () => new Promise(() => {}), timeout: 15 }), errorCode('timeout'))
})

test('completed operations remove their parent abort listener', async () => {
  const controller = new AbortController(), originalAdd = controller.signal.addEventListener.bind(controller.signal), originalRemove = controller.signal.removeEventListener.bind(controller.signal)
  let added = 0, removed = 0
  controller.signal.addEventListener = (...args) => { added++; return originalAdd(...args) }
  controller.signal.removeEventListener = (...args) => { removed++; return originalRemove(...args) }
  await engine().discover(query, controller.signal)
  await engine().fetchFunkwhaleAudio(candidate(), controller.signal, { fetch: async () => response(sample, { 'content-type': 'audio/mpeg' }) })
  assert.equal(added, removed)
})
