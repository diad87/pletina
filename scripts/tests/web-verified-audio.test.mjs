import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const compile = async name => ts.transpileModule(await readFile(new URL(`../../web-port/${name}.ts`, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText
const data = {}, api = {}
new Function('exports', await compile('verified-sources'))(data)
new Function('exports', await compile('verified-archive-source'))(data)
new Function('exports', 'require', await compile('verified-audio'))(api, path => {
  assert.ok(['./verified-sources', './verified-archive-source'].includes(path)); return data
})
const original = data.IRITSI_ALEA_CANDIDATE
const query = { id: original.identity.catalogId, isrc: original.identity.isrc, titleVersion: null,
  title: original.identity.title, artist: original.identity.artist, album: original.identity.album, duration: original.identity.catalogDurationSeconds }
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
async function setup(extra = {}) {
  const bytes = new TextEncoder().encode('Synthetic media bytes for integrity testing, not a music file.')
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('')
  const source = { ...original, file: { ...original.file, bytes: bytes.length, sha256: hash } }
  const requests = [], blobs = [], revoked = []
  const resolver = api.createVerifiedAudioResolver([source], {
    fetch: async (url, options) => { requests.push({ url, options }); return new Response(bytes, { headers: { 'content-length': bytes.length } }) },
    createObjectURL: blob => { blobs.push(blob); return `blob:https://pletina.example/${blobs.length}` },
    revokeObjectURL: url => revoked.push(url), ...extra,
  })
  return { ...resolver, source, bytes, requests, blobs, revoked }
}

test('curated identity rejects homonyms, another artist, album, edition, ISRC, catalog ID and duration', () => {
  assert.equal(api.matchesVerifiedRecording(query, original), true)
  assert.equal(api.matchesVerifiedRecording({ ...query, isrc: null }, original), true, 'the exact checked catalog ID may lack an ISRC in a search row')
  for (const patch of [{ id: query.id + 1 }, { isrc: 'QM6N21424822' }, { artist: 'Other artist' }, { title: query.title + ' (Live)' },
    { album: 'Another release' }, { titleVersion: 'Karaoke' }, { duration: 46 }, { duration: NaN }]) {
    assert.equal(api.matchesVerifiedRecording({ ...query, ...patch }, original), false, JSON.stringify(patch))
  }
  assert.equal(api.matchesVerifiedRecording(query, { ...original, enabled: false }), false)
})

test('the exact full checked bytes become the playback Blob, with no second media request or persistent URL', async () => {
  const h = await setup()
  const playable = await h.resolve(query)
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0].options.mode, 'cors')
  assert.equal(h.requests[0].options.credentials, 'omit')
  assert.equal(h.requests[0].options.redirect, 'error')
  assert.deepEqual(new Uint8Array(await h.blobs[0].arrayBuffer()), h.bytes)
  assert.equal(playable.source.provider, 'verified')
  assert.equal(playable.source.download.allowed, false)
  assert.equal(playable.source.startAt, 8.94)
  assert.ok(!('url' in playable.source) && !('url' in playable.source.download))
  assert.equal((await h.resolve(query)).url, playable.url)
  assert.equal(h.requests.length, 1)
  h.dispose()
  assert.deepEqual(h.revoked, [playable.url])
})

test('integrity rejects changed, truncated and excess bytes before creating an Audio URL', async () => {
  for (const kind of ['changed', 'truncated', 'excess', 'header']) {
    const h = await setup({ fetch: async () => {
      const length = new TextEncoder().encode('Synthetic media bytes for integrity testing, not a music file.').length
      if (kind === 'header') return new Response(new Uint8Array(length), { headers: { 'content-length': length + 1 } })
      return new Response(new Uint8Array(length + (kind === 'truncated' ? -1 : kind === 'excess' ? 1 : 0)))
    } })
    await assert.rejects(h.resolve(query), /cambiado|incompleta|coincide/)
    assert.deepEqual(h.blobs, [])
    h.dispose()
  }
})

test('transport failures are not cached as missing songs and another recording never triggers a request', async () => {
  let attempts = 0
  const h = await setup({ fetch: async () => { attempts++; throw new TypeError('Network offline') } })
  assert.equal(await h.resolve({ ...query, artist: 'Other artist' }), null)
  assert.equal(attempts, 0)
  await assert.rejects(h.resolve(query), /Network offline/)
  await assert.rejects(h.resolve(query), /Network offline/)
  assert.equal(attempts, 2)
  assert.deepEqual(h.blobs, [])
})

test('abort and disposal prevent a late checked response becoming a playable Blob', async () => {
  for (const kind of ['abort', 'dispose']) {
    const gate = deferred(), started = deferred(), controller = new AbortController()
    const h = await setup({ fetch: async () => { started.resolve(); await gate.promise; return new Response(h.bytes, { headers: { 'content-length': h.bytes.length } }) } })
    const pending = h.resolve(query, controller.signal)
    const rejected = assert.rejects(pending, { name: 'AbortError' })
    await started.promise
    if (kind === 'abort') controller.abort(new DOMException('Stop', 'AbortError'))
    else h.dispose()
    gate.resolve()
    await rejected
    assert.deepEqual(h.blobs, [])
  }
})

test('concurrent checked resolutions share the same Blob without revoking audio already handed to the player', async () => {
  const h = await setup()
  const [first, second] = await Promise.all([h.resolve(query), h.resolve(query)])
  assert.equal(first.url, second.url)
  assert.equal(h.blobs.length, 1)
  assert.deepEqual(h.revoked, [])
  h.dispose()
  assert.deepEqual(h.revoked, [first.url])
})

test('HTTP denial and unreadable opaque bodies cannot become a verified source', async () => {
  for (const response of [new Response('denied', { status: 403 }), { ok: true, type: 'opaque', body: null }]) {
    const h = await setup({ fetch: async () => response })
    await assert.rejects(h.resolve(query), /leer/)
    assert.deepEqual(h.blobs, [])
  }
})

test('the transfer deadline cancels the request and cannot cache a failed source', async () => {
  let attempts = 0
  const h = await setup({ timeout: 10, fetch: async (_url, options) => {
    attempts++
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
  } })
  await assert.rejects(h.resolve(query), { name: 'TimeoutError' })
  await assert.rejects(h.resolve(query), { name: 'TimeoutError' })
  assert.equal(attempts, 2)
  assert.deepEqual(h.blobs, [])
})

test('oversized streaming bodies are cancelled before the rest of the file is read', async () => {
  let cancelled = 0
  const h = await setup({ fetch: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1000)) },
    cancel() { cancelled++ },
  })) })
  await assert.rejects(h.resolve(query), /tamaño/)
  assert.equal(cancelled, 1)
  assert.deepEqual(h.blobs, [])
})

const archive = data.EGIOZU_ARCHIVE_CANDIDATE
const archiveQuery = { id: archive.identity.catalogId, isrc: archive.identity.isrc, titleVersion: null, title: archive.identity.title,
  artist: archive.identity.artist, album: archive.identity.album, duration: archive.identity.catalogDurationSeconds }
test('curated Archive association accepts the checked recording and rejects the same-title other edition', () => {
  assert.equal(api.matchesVerifiedRecording(archiveQuery, archive), true)
  for (const patch of [{ id: 3266743431, isrc: 'QM7281675301', album: 'Tipi-tapa, Korrika!' },
    { id: archiveQuery.id + 1 }, { isrc: 'QM7281675301' }, { album: 'Tipi-tapa, Korrika!' }, { titleVersion: 'Live' },
    { artist: 'Pirritx eta Porrotx' }, { duration: 30 }]) {
    assert.equal(api.matchesVerifiedRecording({ ...archiveQuery, ...patch }, archive), false)
  }
})

test('Archive uses only the curated item URL and checked complete bytes, returns provider archive at zero and disables downloads', async () => {
  const bytes = new TextEncoder().encode('Synthetic complete Archive integrity bytes, not music.')
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('')
  const registration = { ...archive, file: { ...archive.file, bytes: bytes.length, sha256 } }
  let fetched = 0, blob
  const h = api.createVerifiedAudioResolver([registration], {
    fetch: async (url, options) => {
      fetched++; assert.equal(url, archive.url); assert.equal(options.redirect, 'follow'); assert.equal(options.credentials, 'omit')
      const response = new Response(bytes, { headers: { 'content-length': bytes.length } })
      Object.defineProperty(response, 'url', { value: 'https://dn710802.ca.archive.org/0/items/EgiozuEuskarazPirritxPorrotxEtaMarimotots/Egiozu_euskaraz_Pirritx_Porrotx_eta_Marimotots_.mp3' })
      return response
    }, createObjectURL: value => { blob = value; return 'blob:https://example.org/archive-checked' }, revokeObjectURL() {},
  })
  assert.equal(await h.resolve({ ...archiveQuery, isrc: 'QM7281675301' }), null)
  const source = await h.resolve(archiveQuery)
  assert.equal(fetched, 1)
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes)
  assert.equal(source.source.provider, 'archive'); assert.equal(source.source.startAt, 0); assert.equal(source.source.download.allowed, false)
  assert.equal((await h.resolve(archiveQuery)).url, source.url); assert.equal(fetched, 1)
  h.dispose()
})

test('Archive rejects uncurated initial URLs, unsafe redirects and changed/truncated full files', async () => {
  const bytes = new TextEncoder().encode('Synthetic complete Archive integrity bytes, not music.')
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('')
  const registration = { ...archive, file: { ...archive.file, bytes: bytes.length, sha256 } }
  for (const url of [archive.url + '?download=1', archive.url.replace('archive.org', 'evil.test'),
    archive.url.replace('https:', 'http:'), archive.url.replace('/download/', '/other/'), archive.url.replace('Egiozu_euskaraz', 'other')]) {
    const h = api.createVerifiedAudioResolver([{ ...registration, url }], { fetch: async () => assert.fail('untrusted URL requested') })
    await assert.rejects(h.resolve(archiveQuery), /fuente verificada/)
  }
  for (const url of ['https://evil.test/audio.mp3', archive.url + '?x=1', archive.url.replace('archive.org', 'archive.org.evil.test'),
    'https://ia801.test.archive.org/0/items/OtherItem/OtherFile.mp3']) {
    const response = new Response(bytes)
    Object.defineProperty(response, 'url', { value: url })
    const h = api.createVerifiedAudioResolver([registration], { fetch: async () => response, createObjectURL() { assert.fail('unsafe redirect') } })
    await assert.rejects(h.resolve(archiveQuery), /dirección ajena/)
  }
  for (const body of [new Uint8Array(bytes.length), bytes.slice(0, -1), new Uint8Array(bytes.length + 1)]) {
    const h = api.createVerifiedAudioResolver([registration], { fetch: async () => new Response(body), createObjectURL() { assert.fail('unchecked body') } })
    await assert.rejects(h.resolve(archiveQuery), /coincide|incompleta|tamaño/)
  }
})
