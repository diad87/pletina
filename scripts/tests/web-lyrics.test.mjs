import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../../web-port/lyrics.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText
const track = { title: 'Song', artist: 'Artist', album: 'Album', duration: 180 }
const record = (extra = {}) => ({ id: 42, trackName: 'Song', artistName: 'Artist', albumName: 'Album', duration: 180,
  instrumental: false, plainLyrics: 'First\r\nSecond', syncedLyrics: '[00:01.25]First\n[00:03.50]Second\n[00:05.00]', ...extra })
const json = (value = record(), options = {}) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8' }, ...options })
function engine(handler = () => json()) {
  const exports = {}, calls = [], timers = new Map()
  let now = Date.parse('2026-10-24T12:00:00Z'), timerId = 0
  const request = async (url, options) => { calls.push({ url, options, at: now }); return handler(url, options) }
  const setTimer = (callback, milliseconds) => {
    const id = ++timerId
    timers.set(id, { callback, milliseconds })
    if (milliseconds <= 250) queueMicrotask(() => {
      if (!timers.has(id)) return
      timers.delete(id); now += milliseconds; callback()
    })
    return id
  }
  new Function('exports', 'fetch', 'Date', 'setTimeout', 'clearTimeout', compiled)(exports, request,
    class extends Date { static now() { return now } }, setTimer, id => timers.delete(id))
  return { ...exports, calls, advance(milliseconds) { now += milliseconds },
    timeout() { const entry = [...timers.values()].find(timer => timer.milliseconds === 12_000); assert.ok(entry); entry.callback() } }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('browser lyrics request uses the exact recording metadata, allowed client header and no credentials', async () => {
  const api = engine(), result = await api.lyricsGet({ ...track, title: ' SONG ' })
  assert.equal(api.calls.length, 1)
  const { url, options } = api.calls[0], request = new URL(url)
  assert.equal(request.origin + request.pathname, 'https://lrclib.net/api/get')
  assert.deepEqual(Object.fromEntries(request.searchParams), { track_name: 'SONG', artist_name: 'Artist', album_name: 'Album', duration: '180' })
  assert.equal(options.mode, 'cors'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error')
  assert.equal(options.cache, 'no-store'); assert.equal(options.headers.Accept, 'application/json')
  assert.match(options.headers['Lrclib-Client'], /Pletina\/.*https:\/\/github.com\/diad87\/pletina/)
  assert.equal(options.headers['User-Agent'], undefined)
  assert.deepEqual(result, { source: 'LRCLIB', sourceUrl: 'https://lrclib.net/tracks/42', instrumental: false,
    text: 'First\nSecond', cues: [{ start: 1.25, end: 3.5, text: 'First' }, { start: 3.5, end: 5, text: 'Second' }] })
})

test('separate recording versions are queried once and never accepted as the studio recording', async () => {
  const api = engine(url => json(record({ trackName: new URL(url).searchParams.get('track_name') })))
  await api.lyricsGet({ ...track, titleVersion: 'Live' })
  assert.equal(new URL(api.calls[0].url).searchParams.get('track_name'), 'Song (Live)')
  await api.lyricsGet({ ...track, title: 'Song (Live)', titleVersion: 'Live' })
  assert.equal(api.calls.length, 1, 'Equivalent complete titles share their cache entry')
  await api.lyricsGet({ ...track, title: 'Live Forever', titleVersion: 'Live' })
  assert.equal(new URL(api.calls[1].url).searchParams.get('track_name'), 'Live Forever (Live)', 'A version word inside the title is not a version suffix')
  assert.equal(await engine(() => json(record({ trackName: 'Song (Live)' }))).lyricsGet(track), null)
})

test('artist, known album and duration must match, while unknown duration/album remain optional', async () => {
  for (const extra of [{ artistName: 'Another Artist' }, { albumName: 'Other Album' }, { duration: 177.9 }, { duration: 0 }]) {
    assert.equal(await engine(() => json(record(extra))).lyricsGet(track), null)
  }
  assert.ok(await engine(() => json(record({ duration: 182 }))).lyricsGet(track))
  const api = engine(() => json(record({ albumName: 'Other Album', duration: 200 })))
  assert.ok(await api.lyricsGet({ ...track, album: '', duration: 0 }))
  assert.equal(new URL(api.calls[0].url).searchParams.has('album_name'), false)
  assert.equal(new URL(api.calls[0].url).searchParams.has('duration'), false)
  const long = engine(() => json(record({ duration: 5000 })))
  assert.ok(await long.lyricsGet({ ...track, duration: 5000 }))
  assert.equal(new URL(long.calls[0].url).searchParams.has('duration'), false)
})

test('instrumental and unavailable records produce distinct truthful results', async () => {
  const instrumental = await engine(() => json(record({ instrumental: true }))).lyricsGet(track)
  assert.equal(instrumental.instrumental, true); assert.equal(instrumental.text, ''); assert.deepEqual(instrumental.cues, [])
  assert.equal(await engine(() => new Response('not found', { status: 404 })).lyricsGet(track), null)
  assert.equal(await engine(() => json(record({ plainLyrics: null, syncedLyrics: '[ar:Artist]\ninvalid' }))).lyricsGet(track), null)
  const plain = await engine(() => json(record({ syncedLyrics: null }))).lyricsGet(track)
  assert.equal(plain.text, 'First\nSecond'); assert.deepEqual(plain.cues, [])
})

test('LRC handles repeated and simultaneous cues, empty silence boundaries, hours and signed offsets', async () => {
  const syncedLyrics = '\uFEFF[offset:+1500]\r\n[ar:Artist]\r\n[00:03.50][00:01.25] First\r\n[00:03.50]Second voice\n[00:03.50]Second voice\n[00:05]\n[01:00:00.1]Last'
  const result = await engine(() => json(record({ plainLyrics: null, syncedLyrics }))).lyricsGet(track)
  assert.deepEqual(result.cues, [{ start: 0, end: 2, text: 'First' }, { start: 2, end: 3.5, text: 'First' },
    { start: 2, end: 3.5, text: 'Second voice' }, { start: 3598.6, end: null, text: 'Last' }])
  assert.equal(result.text, 'First\nFirst\nSecond voice\nLast')
  const late = await engine(() => json(record({ plainLyrics: null, syncedLyrics: '[offset:+1000]\n[00:01]First\n[offset:-500]' }))).lyricsGet(track)
  assert.equal(late.cues[0].start, 1.5)
})

test('invalid timing tags never fabricate cues and huge synchronization falls back to plain text', async () => {
  const invalid = ['00:60', '-1:00', 'NaN:00', '00:NaN', '00:01.1234', '00:01.2.3', '01:60:00', '25:00:00']
  const result = await engine(() => json(record({ syncedLyrics: invalid.map(value => `[${value}]Invalid`).join('\n') }))).lyricsGet(track)
  assert.deepEqual(result.cues, [])
  const huge = await engine(() => json(record({ syncedLyrics: '[00:01]A\n'.repeat(5001) }))).lyricsGet(track)
  assert.deepEqual(huge.cues, []); assert.equal(huge.text, 'First\nSecond')
})

test('found/missing results have distinct TTLs and callers cannot mutate cached documents', async () => {
  const api = engine(), value = await api.lyricsGet(track)
  value.text = 'Changed'; value.cues[0].text = 'Changed'
  assert.equal((await api.lyricsGet(track)).cues[0].text, 'First')
  api.advance(10 * 60_000)
  await api.lyricsGet(track); assert.equal(api.calls.length, 1)
  api.advance(6 * 60 * 60_000)
  await api.lyricsGet(track); assert.equal(api.calls.length, 2)
  const missing = engine(() => new Response(null, { status: 404 }))
  await missing.lyricsGet(track); await missing.lyricsGet(track); assert.equal(missing.calls.length, 1)
  missing.advance(10 * 60_000)
  await missing.lyricsGet(track); assert.equal(missing.calls.length, 2)
})

test('cache is bounded and sequential network requests wait 250ms after the preceding response', async () => {
  const api = engine(url => json(record({ trackName: new URL(url).searchParams.get('track_name') })))
  for (let index = 0; index < 66; index++) await api.lyricsGet({ ...track, title: 'Song ' + index })
  await api.lyricsGet({ ...track, title: 'Song 0' })
  assert.equal(api.calls.length, 67)
  for (let index = 1; index < api.calls.length; index++) assert.ok(api.calls[index].at - api.calls[index - 1].at >= 250)
})

test('network and malformed-response errors remain retryable and are not cached as unavailable', async () => {
  for (const failure of [() => { throw new TypeError('Network error') }, () => new Response('<html>error</html>'),
    () => new Response('{oops', { headers: { 'content-type': 'application/json' } }), () => json({}),
    () => new Response('no', { status: 500 })]) {
    let attempt = 0
    const api = engine(() => ++attempt === 1 ? failure() : json())
    await assert.rejects(api.lyricsGet(track), /LRCLIB/)
    assert.ok(await api.lyricsGet(track)); assert.equal(api.calls.length, 2)
  }
})

test('response and lyric byte limits reject oversized text before use', async () => {
  const declared = engine(() => json(record(), { headers: { 'content-type': 'application/json', 'content-length': String(512 * 1024 + 1) } }))
  await assert.rejects(declared.lyricsGet(track), /tamaño permitido/)
  const streamed = engine(() => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(512 * 1024)); controller.enqueue(new Uint8Array(1)); controller.close()
  } }), { headers: { 'content-type': 'application/json' } }))
  await assert.rejects(streamed.lyricsGet(track), /tamaño permitido/)
  const multibyte = engine(() => json(record({ plainLyrics: 'é'.repeat(64 * 1024 + 1), syncedLyrics: null })))
  await assert.rejects(multibyte.lyricsGet(track), /tamaño permitido/)
})

test('429 and 503 honor Retry-After without parsing their bodies, including HTTP dates', async () => {
  for (const status of [429, 503]) {
    let attempt = 0
    const api = engine(() => ++attempt === 1 ? new Response('<html>busy</html>', { status, headers: { 'retry-after': '20' } }) : json())
    await assert.rejects(api.lyricsGet(track), /20 segundos/)
    await assert.rejects(api.lyricsGet(track), /20 segundos/)
    assert.equal(api.calls.length, 1)
    api.advance(20_000)
    assert.ok(await api.lyricsGet(track)); assert.equal(api.calls.length, 2)
  }
  const dated = engine(() => new Response(null, { status: 429, headers: { 'retry-after': 'Sat, 24 Oct 2026 12:00:10 GMT' } }))
  await assert.rejects(dated.lyricsGet(track), /10 segundos/)
})

test('latest selection cancels the active fetch and skips intervening queued songs', async () => {
  let running = 0, maximum = 0
  const api = engine((url, { signal }) => {
    maximum = Math.max(maximum, ++running)
    if (new URL(url).searchParams.get('track_name') === 'Song') return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { running--; reject(signal.reason) }, { once: true })
    })
    running--; return json(record({ trackName: 'Latest' }))
  })
  const first = api.lyricsGet(track), firstFailure = assert.rejects(first, { name: 'AbortError' })
  await tick()
  const skipped = api.lyricsGet({ ...track, title: 'Skipped' }), skippedFailure = assert.rejects(skipped, { name: 'AbortError' })
  const latest = api.lyricsGet({ ...track, title: 'Latest' })
  await Promise.all([firstFailure, skippedFailure])
  assert.ok(await latest); assert.equal(maximum, 1)
  assert.deepEqual(api.calls.map(call => new URL(call.url).searchParams.get('track_name')), ['Song', 'Latest'])
})

test('cached selection cancels waiting requests and caller cancellation/timeout release the queue', async () => {
  const api = engine((url, { signal }) => new URL(url).searchParams.get('track_name') === 'Song' ? json() :
    new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })))
  await api.lyricsGet(track)
  const pending = api.lyricsGet({ ...track, title: 'Other' }), cancelled = assert.rejects(pending, { name: 'AbortError' })
  await tick()
  assert.ok(await api.lyricsGet(track)); await cancelled
  const controller = new AbortController(), aborting = api.lyricsGet({ ...track, title: 'Other' }, controller.signal)
  const aborted = assert.rejects(aborting, { name: 'AbortError' })
  await tick(); controller.abort(); await aborted
  const timed = api.lyricsGet({ ...track, title: 'Other' }), timedOut = assert.rejects(timed, { name: 'TimeoutError' })
  await tick(); api.timeout(); await timedOut
  assert.ok(await api.lyricsGet(track))
})

test('empty metadata returns unavailable while invalid fields and already aborted signals never fetch', async () => {
  const api = engine()
  assert.equal(await api.lyricsGet({ ...track, title: ' ' }), null)
  for (const invalid of [{ title: 'a'.repeat(513) }, { artist: null }, { duration: NaN }, { duration: -1 }, { duration: 2.5 }, { titleVersion: 42 }]) {
    await assert.rejects(api.lyricsGet({ ...track, ...invalid }), /datos de la canción/)
  }
  const controller = new AbortController(); controller.abort()
  await assert.rejects(api.lyricsGet(track, controller.signal), { name: 'AbortError' })
  assert.equal(api.calls.length, 0)
})
