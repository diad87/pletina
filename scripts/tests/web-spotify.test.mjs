import assert from 'node:assert/strict'
import test from 'node:test'
import { parsePublicSpotifyPlaylistPage, readPublicSpotifyPlaylist } from '../../web-port/spotify.ts'

const id = '3cEYpjA9oz9GiPac4AsH4n'
const otherId = '37i9dQZF1DXcBWIGoYBM5M'
const row = (name = 'Song', extra = {}) => ({ itemV2: { __typename: 'TrackResponseWrapper', data: {
  __typename: 'Track', uri: 'spotify:track:4rzfv0JLZfVhOhbSQ8o5jZ', name,
  artists: { items: [{ profile: { name: 'Tyler, The Creator' } }, { profile: { name: 'Guest' } }] },
  duration: { totalMilliseconds: 180500 }, ...extra,
} } })
const page = (items = [row()], total = items.length, extra = {}, offset = 0) => ({ data: { playlistV2: {
  __typename: 'Playlist', id, uri: `spotify:playlist:${id}`, name: 'Real list', content: { items, totalCount: total,
    pagingInfo: { nextOffset: offset + items.length < total ? offset + items.length : null } }, ...extra,
} } })
const session = (extra = {}) => ({ accessToken: 'anonymous-token', accessTokenExpirationTimestampMs: Date.now() + 3600_000, isAnonymous: true, ...extra })
const json = (value, init) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' }, ...init })
const isToken = (url) => new URL(url).pathname === '/embed/api/token'
const variables = (url) => JSON.parse(new URL(url).searchParams.get('variables'))
const transport = (handler = () => json(page()), token = () => json(session())) => {
  const calls = []
  const fetch = async (url, options) => { calls.push({ url, options }); return isToken(url) ? token(url, options) : handler(url, options) }
  return { fetch, calls }
}

test('anonymous import uses only fixed Spotify endpoints with omitted credentials and no token in URLs or source', async () => {
  const client = transport()
  const result = await readPublicSpotifyPlaylist(id, client)
  assert.equal(result.name, 'Real list')
  assert.deepEqual(result.tracks, [{ title: 'Song', artists: ['Tyler, The Creator', 'Guest'], durationMs: 180500, isrc: null }])
  assert.deepEqual(result.warnings, [])
  assert.equal(client.calls.length, 2)
  for (const call of client.calls) {
    assert.equal(call.options.credentials, 'omit')
    assert.equal(call.options.redirect, 'error')
    assert.equal(call.options.cache, 'no-store')
    assert.doesNotMatch(call.url, /anonymous-token/)
  }
  assert.equal(client.calls[0].options.headers.Authorization, undefined)
  assert.equal(client.calls[1].options.headers.Authorization, 'Bearer anonymous-token')
  assert.equal(new URL(client.calls[1].url).origin, 'https://api-partner.spotify.com')
  assert.deepEqual(variables(client.calls[1].url), { uri: `spotify:playlist:${id}`, limit: 100, offset: 0, includeItemV3: false })
  assert.equal(JSON.parse(new URL(client.calls[1].url).searchParams.get('extensions')).persistedQuery.sha256Hash,
    'c685ca91fb0019c87ff1225f84e1d85b26cd631fa6187f3f0900da182cb0953d')
  assert.doesNotMatch(JSON.stringify(result), /anonymous-token|accessToken/)
})

test('pagination retains every ordered duplicate and advances past omitted items', async () => {
  const rows = Array.from({ length: 103 }, (_, index) => row(String(index % 3)))
  rows[1] = row('Podcast', { __typename: 'Episode', uri: `spotify:episode:${id}` })
  const client = transport(url => { const { offset, limit } = variables(url); return json(page(rows.slice(offset, offset + limit), rows.length, {}, offset)) })
  const result = await readPublicSpotifyPlaylist(id, client)
  assert.equal(result.tracks.length, 102)
  assert.equal(result.skipped, 1)
  assert.match(result.warnings[0], /1 entradas/)
  assert.deepEqual(result.tracks.map(track => track.title), rows.filter((_, index) => index !== 1).map(entry => entry.itemV2.data.name))
  assert.deepEqual(client.calls.filter(call => !isToken(call.url)).map(call => variables(call.url).offset), [0, 100])
})

test('parser skips local, episodes, missing and invalid metadata but preserves unavailable music metadata', () => {
  const result = parsePublicSpotifyPlaylistPage(page([
    row('Unavailable', { playability: { playable: false }, duration: { totalMilliseconds: -1 } }),
    row('Local', { uri: 'spotify:local:test' }), row('Episode', { __typename: 'Episode' }),
    row(''), row('Missing artist', { artists: { items: [] } }), row('Huge artist', { artists: { items: [{ profile: { name: 'ü'.repeat(501) } }] } }),
    { itemV2: { __typename: 'NotFound' } }, row('Huge title', { name: 'ü'.repeat(1001) }),
  ]), id)
  assert.equal(result.count, 8)
  assert.equal(result.skipped, 7)
  assert.deepEqual(result.tracks, [{ title: 'Unavailable', artists: ['Tyler, The Creator', 'Guest'], durationMs: null, isrc: null }])
})

test('parser validates playlist identity, totals, GraphQL errors and missing public lists', () => {
  for (const value of [null, {}, { errors: [{ message: 'SECRET' }] }, page([], 0, { uri: `spotify:playlist:${otherId}` }),
    page([], 0, { id: otherId }), page([], 0, { __typename: 'Other' }), page([], -1), page([], 1.5), page([], NaN), page([], 10001), page(Array.from({ length: 101 }, () => row()))]) {
    assert.throws(() => parsePublicSpotifyPlaylistPage(value, id), /Spotify|10.000/)
  }
  assert.throws(() => parsePublicSpotifyPlaylistPage({ data: { playlistV2: { __typename: 'NotFound' } } }, id), /No se encontró/)
  assert.throws(() => parsePublicSpotifyPlaylistPage({ data: { playlistV2: { __typename: 'GenericError', message: 'SECRET' } } }, id), /pública/)
  assert.equal(parsePublicSpotifyPlaylistPage(page([], 0), id).tracks.length, 0)
})

test('incomplete, growing or renamed pagination fails instead of silently importing a partial list', async () => {
  for (const response of [page([], 1), page([row()], 0)]) {
    await assert.rejects(readPublicSpotifyPlaylist(id, transport(() => json(response))), /cambió|todas/)
  }
  for (const last of [page([], 101, {}, 100), page([row()], 102, {}, 100), page([row()], 101, { name: 'Changed' }, 100)]) {
    const client = transport(url => json(variables(url).offset === 0 ? page(Array.from({ length: 100 }, () => row()), 101) : last))
    await assert.rejects(readPublicSpotifyPlaylist(id, client), /cambió|todas/)
  }
  const repeated = page(Array.from({ length: 100 }, () => row()), 101)
  repeated.data.playlistV2.content.pagingInfo.nextOffset = 0
  await assert.rejects(readPublicSpotifyPlaylist(id, transport(() => json(repeated))), /cambió|todas/)
})

test('expired, malformed, non-anonymous and oversized guest tokens cannot reach metadata', async () => {
  for (const value of [{}, session({ isAnonymous: false }), session({ accessToken: 'has whitespace' }), session({ accessToken: '' }),
    session({ accessToken: 'a'.repeat(8193) }), session({ accessTokenExpirationTimestampMs: Date.now() - 1 }),
    session({ accessTokenExpirationTimestampMs: Infinity }), session({ accessTokenExpirationTimestampMs: Date.now() + 2 * 86_400_000 })]) {
    const client = transport(() => assert.fail('Invalid token must not reach metadata'), () => json(value))
    await assert.rejects(readPublicSpotifyPlaylist(id, client), /sesión pública/)
    assert.equal(client.calls.length, 1)
  }
})

test('resolved anonymous token stays in memory for the same transport and refreshes only once after 401', async () => {
  let issued = 0, requests = 0
  const client = transport(() => ++requests === 1 ? new Response('', { status: 401 }) : json(page()), () => json(session({ accessToken: `guest-${++issued}` })))
  await readPublicSpotifyPlaylist(id, client)
  await readPublicSpotifyPlaylist(id, client)
  assert.equal(issued, 2)
  assert.equal(client.calls.at(-1).options.headers.Authorization, 'Bearer guest-2')
  let attempts = 0
  const refused = transport(() => { attempts++; return new Response('', { status: 401 }) })
  await assert.rejects(readPublicSpotifyPlaylist(id, refused), /caducado/)
  assert.equal(attempts, 2)
  assert.equal(refused.calls.filter(call => isToken(call.url)).length, 2)
})

test('private, missing, rate-limited and provider format failures stay explicit without refresh loops or secret error text', async () => {
  for (const [status, pattern] of [[403, /pública/], [404, /No se encontró/], [429, /limitado/], [500, /conectar/]]) {
    const client = transport(() => new Response('SECRET provider detail', { status }))
    await assert.rejects(readPublicSpotifyPlaylist(id, client), error => pattern.test(error.message) && !error.message.includes('SECRET'))
    assert.equal(client.calls.length, 2)
  }
  await assert.rejects(readPublicSpotifyPlaylist(id, transport(() => json({ errors: [{ message: 'SECRET changed persisted query' }] }))), /no se pudo leer/)
  await assert.rejects(readPublicSpotifyPlaylist(id, transport(() => { throw new TypeError('https://private.invalid/SECRET') })),
    error => /navegador/.test(error.message) && !error.message.includes('SECRET'))
})

test('announced and streamed response limits cancel bodies and invalid UTF8 or JSON never becomes metadata', async () => {
  const over = 4 * 1024 * 1024 + 1
  await assert.rejects(readPublicSpotifyPlaylist(id, transport(() => new Response('', { headers: { 'content-length': String(over) } }))), /demasiado grande/)
  let cancelled = false
  await assert.rejects(readPublicSpotifyPlaylist(id, transport(() => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(over)) }, cancel() { cancelled = true },
  })))), /demasiado grande/)
  assert.equal(cancelled, true)
  for (const body of [new Uint8Array([0xc3, 0x28]), '<html>SECRET</html>', '{broken']) {
    await assert.rejects(readPublicSpotifyPlaylist(id, transport(() => new Response(body))), /no se pudo leer/)
  }
})

test('invalid IDs and pre-aborted import make no network request', async () => {
  const fetch = () => assert.fail('Must not fetch')
  await assert.rejects(readPublicSpotifyPlaylist('../../outside', { fetch }), /identificador/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(readPublicSpotifyPlaylist(id, { fetch, signal: controller.signal }), { name: 'AbortError' })
})

test('cancellation during a guest request settles immediately even if a transport ignores abort; a fresh import succeeds', async () => {
  let entered, finish
  const waiting = new Promise(resolve => { entered = resolve })
  let first = true
  const client = transport(() => json(page()), () => {
    if (!first) return json(session())
    first = false; entered()
    return new Promise(resolve => { finish = resolve })
  })
  const controller = new AbortController()
  const pending = readPublicSpotifyPlaylist(id, { ...client, signal: controller.signal })
  await waiting; controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  const result = await readPublicSpotifyPlaylist(id, client)
  assert.equal(result.tracks.length, 1)
  finish(json(session({ accessToken: 'obsolete' })))
  await Promise.resolve(); await Promise.resolve()
  await readPublicSpotifyPlaylist(id, client)
  assert.equal(client.calls.at(-1).options.headers.Authorization, 'Bearer anonymous-token')
})

test('cancel during streamed metadata cancels the reader and never fetches the next page', async () => {
  let entered, cancelled = false
  const waiting = new Promise(resolve => { entered = resolve })
  const client = transport(() => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{')); entered() }, cancel() { cancelled = true },
  })))
  const controller = new AbortController()
  const pending = readPublicSpotifyPlaylist(id, { ...client, signal: controller.signal })
  await waiting; controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(cancelled, true)
  assert.equal(client.calls.length, 2)
})

test('request deadline bounds a stalled metadata body and releases its reader', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let entered, cancelled = false
  const waiting = new Promise(resolve => { entered = resolve })
  const client = transport(() => new Response(new ReadableStream({ start() { entered() }, cancel() { cancelled = true } })))
  const pending = readPublicSpotifyPlaylist(id, client)
  await waiting
  t.mock.timers.tick(12_000)
  await assert.rejects(pending, /tardó demasiado/)
  assert.equal(cancelled, true)
})
