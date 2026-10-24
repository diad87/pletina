import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { IDBFactory } from 'fake-indexeddb'
import { createWebStorage } from '../../web-port/storage.ts'
import * as transcripts from '../../web-port/podcast-transcripts.ts'

const bytes = value => new TextEncoder().encode(value)
const parse = (value, mime = 'text/vtt') => transcripts.parseTranscript(bytes(value), mime, 'https://text.example/published.vtt')
const reference = (url, mimeType = 'text/vtt') => ({ url: `https://text.example/${url}`, mimeType, language: 'es' })
const source = await readFile(new URL('../../web-port/podcasts.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText
function engine(storage, overrides = {}) {
  const exports = {}
  new Function('exports', 'require', 'fetch', compiled)(exports, name => name === './storage' ? storage : name === './podcast-transcripts' ? { ...transcripts, ...overrides } : {}, globalThis.fetch)
  return exports
}

test('official namespace and alias resolve relative published references, reject HTML and credentials, and bound references', () => {
  const node = (namespaceURI, url, type, language = 'es') => ({ localName: 'transcript', namespaceURI,
    getAttribute(name) { return { url, type, language }[name] ?? null } })
  const official = 'https://podcastindex.org/namespace/1.0'
  const refs = transcripts.transcriptReferences({ children: [
    node(official, '../one.vtt', 'text/vtt; charset=utf-8'),
    node('https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/1.0.md', '/two.json', 'application/json'),
    node('urn:fake', '/fake.vtt', 'text/vtt'), node('', '/not-namespaced.vtt', 'text/vtt'),
    node(official, 'javascript:alert(1)', 'text/plain'), node(official, '/page.html', 'text/html'),
    node(official, 'https://user:secret@example.com/text', 'text/plain'), node(official, '../one.vtt', 'text/vtt'),
  ] }, 'https://feed.example/shows/rss')
  assert.deepEqual(refs, [reference('unused'), reference('unused')].map((value, index) => ({ ...value,
    url: `https://feed.example/${index ? 'two.json' : 'one.vtt'}`, mimeType: index ? 'application/json' : 'text/vtt' })))
  assert.equal(transcripts.normalizeTranscriptReferences(Array.from({ length: 100 }, (_, index) => reference(index))).length, 8)
})

test('VTT keeps cue times, speakers and text while discarding styles, notes and provider markup', () => {
  const result = parse('WEBVTT\r\n\r\nNOTE not spoken\r\n\r\nSTYLE\r\n::cue { color:red }\r\n\r\nfirst\r\n00:01.250 --> 00:03.000 align:start\r\n<v.loud Ana>Hola &amp; <b>gracias</b>.\r\n\r\n00:03.000 --> 00:04.000\r\nOtra frase.')
  assert.deepEqual(result.cues, [{ start: 1.25, end: 3, text: 'Ana: Hola & gracias.' }, { start: 3, end: 4, text: 'Otra frase.' }])
  assert.equal(result.text, 'Ana: Hola & gracias.\nOtra frase.')
  assert.equal(result.source, 'Transcripción del podcast'); assert.equal(result.instrumental, false)
  assert.doesNotMatch(result.text, /NOTE|STYLE|color:red|<b>/)
})

test('SRT, Podcasting 2.0 JSON and untimed plain text retain the published timing precision', () => {
  const srt = parse('1\n01:02:03,456 --> 01:02:04,500\nTexto\nen dos líneas.', 'application/x-subrip')
  assert.equal(srt.cues[0].start, 3723.456); assert.equal(srt.text, 'Texto\nen dos líneas.')
  const json = parse(JSON.stringify({ version: '1.0.0', segments: [
    { speaker: 'Ana', startTime: 2, body: 'de nuevo' }, { speaker: 'Luis', startTime: 1, endTime: 2, body: '<script>Texto inerte</script>' },
  ] }), 'application/json')
  assert.equal(json.cues[0].start, 1); assert.equal(json.cues[1].end, null)
  assert.equal(json.cues[0].text, 'Luis: <script>Texto inerte</script>')
  const plain = parse('Primera línea.\r\nSegunda línea.', 'text/plain')
  assert.equal(plain.text, 'Primera línea.\nSegunda línea.'); assert.deepEqual(plain.cues, [])
  assert.equal(transcripts.captionText('A & B, 2 < 3 y &#x1F600;'), 'A & B, 2 < 3 y 😀')
})

test('empty, malformed, HTML, oversized, invalid UTF-8 and invalid timing transcripts fail explicitly', () => {
  for (const [value, mime] of [
    ['00:01.000 --> 00:02.000\nTexto', 'text/vtt'], ['WEBVTT\n\n00:60:01.000 --> 00:60:02.000\nTexto', 'text/vtt'],
    ['WEBVTT\n\n00:02.000 --> 00:01.000\nTexto', 'text/vtt'], ['<!DOCTYPE html><html>Error</html>', 'text/plain'],
    ['<html>Error</html>', 'text/html'], [' ', 'text/plain'], ['{"segments":[]}', 'application/json'],
    ['{"segments":[{"startTime":-1,"body":"X"}]}', 'application/json'], ['{"segments":[{"startTime":2,"endTime":1,"body":"X"}]}', 'application/json'],
  ]) assert.throws(() => parse(value, mime))
  assert.throws(() => transcripts.parseTranscript(new Uint8Array([0xff]), 'text/plain', 'https://example.com'))
  assert.throws(() => parse('x'.repeat(4 * 1024 * 1024 + 1), 'text/plain'), /tamaño/)
  assert.throws(() => parse('á'.repeat(1024 * 1024 + 1), 'text/plain'), /texto admitido/)
  assert.throws(() => parse(JSON.stringify({ segments: Array.from({ length: 30_001 }, () => ({ startTime: 0, body: 'X' })) }), 'application/json'), /demasiados/)
})

test('network/CORS and HTTP errors stay retryable; success is cached, cloned and fetched without credentials or proxies', async t => {
  let requests = 0
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://text.example/retry.vtt'); assert.equal(options.credentials, 'omit'); assert.equal(options.mode, 'cors')
    assert.equal(options.headers.Accept, 'text/vtt')
    requests++
    if (requests === 1) throw new TypeError('Failed to fetch')
    if (requests === 2) return new Response('', { status: 503 })
    return new Response('WEBVTT\n\n00:01.000 --> 00:02.000\nPublicado')
  })
  await assert.rejects(transcripts.fetchTranscript(reference('retry.vtt')), /CORS.*Vuelve a intentarlo/)
  await assert.rejects(transcripts.fetchTranscript(reference('retry.vtt')), /503/)
  const found = await transcripts.fetchTranscript(reference('retry.vtt')); assert.equal(found.text, 'Publicado')
  found.cues[0].text = 'Changed externally'
  assert.equal((await transcripts.fetchTranscript(reference('retry.vtt'))).cues[0].text, 'Publicado')
  assert.equal(requests, 3)
})

test('404/410 mean absent while HTML and advertised or streamed oversized responses fail', async t => {
  for (const status of [404, 410]) {
    t.mock.method(globalThis, 'fetch', async () => new Response('', { status }))
    assert.equal(await transcripts.fetchTranscript(reference(`missing-${status}`)), null)
  }
  t.mock.method(globalThis, 'fetch', async () => new Response('Error', { headers: { 'content-type': 'text/html' } }))
  await assert.rejects(transcripts.fetchTranscript(reference('html')), /página web/)
  t.mock.method(globalThis, 'fetch', async () => new Response('X', { headers: { 'content-length': 5 * 1024 * 1024 } }))
  await assert.rejects(transcripts.fetchTranscript(reference('large-header')), /tamaño/)
  t.mock.method(globalThis, 'fetch', async () => new Response('x'.repeat(4 * 1024 * 1024 + 1)))
  await assert.rejects(transcripts.fetchTranscript(reference('large-body')), /tamaño/)
})

test('document cache has an eight-entry bound and timeouts stay retryable with a clear message', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.ok(options.signal instanceof AbortSignal)
    calls++
    return new Response('Texto', { headers: { 'content-type': 'text/plain' } })
  })
  for (let index = 0; index < 9; index++) await transcripts.fetchTranscript(reference(`bounded-${index}`, 'text/plain'))
  await transcripts.fetchTranscript(reference('bounded-8', 'text/plain'))
  assert.equal(calls, 9)
  await transcripts.fetchTranscript(reference('bounded-0', 'text/plain'))
  assert.equal(calls, 10, 'The oldest of nine documents must have been evicted')
  t.mock.method(globalThis, 'fetch', async () => { throw new DOMException('Timed out', 'TimeoutError') })
  await assert.rejects(transcripts.fetchTranscript(reference('timeout.vtt')), /tardó demasiado.*Vuelve a intentarlo/)
  t.mock.method(globalThis, 'fetch', async () => new Response('WEBVTT\n\n00:01.000 --> 00:02.000\nReintentado'))
  assert.equal((await transcripts.fetchTranscript(reference('timeout.vtt'))).text, 'Reintentado')
})

const show = { title: 'Programa', author: 'Autora', description: '', image: null, feedUrl: 'https://feed.example/rss', language: 'es', episodeCount: 2 }
const episode = guid => ({ guid, title: guid, description: '', publishedAt: null, duration: 100, audioUrl: `https://audio.example/${guid}.mp3`, image: null, explicit: false })

test('legacy episodes acquire durable references without replacing visible episodes, IDs, progress or library; backup can reconstruct refs', async t => {
  const factory = new IDBFactory(), name = 'transcript-storage', store = createWebStorage({ indexedDB: factory, name })
  t.after(() => store.close())
  const first = await store.savePodcastDetail({ podcast: show, episodes: [episode('old'), episode('new')] })
  const id = first.episodes[0].id
  assert.equal((await store.readPodcastTranscripts(id)).checked, false)
  await store.storageInvoke('set_podcast_saved', { id: first.podcast.id, saved: true })
  await store.storageInvoke('save_podcast_progress', { progress: { id, position: 42, duration: 100, completed: false } })
  await store.savePodcastDetail({ podcast: show, episodes: [episode('new')] })
  await store.savePodcastTranscripts(id, [reference('persist.vtt')])
  const before = await store.readPodcastTranscripts(id)
  assert.equal(before.checked, true); assert.equal(before.guid, 'old')
  assert.deepEqual((await store.readPodcastDetail(show.feedUrl)).episodes.map(value => value.id), [first.episodes[1].id])
  await store.close()
  const reopened = createWebStorage({ indexedDB: factory, name }); t.after(() => reopened.close())
  assert.deepEqual(await reopened.readPodcastTranscripts(id), before)
  assert.equal((await reopened.storageInvoke('library')).podcasts[0].id, first.podcast.id)
  assert.equal((await reopened.storageInvoke('podcast_progress', { ids: [id] }))[0].position, 42)
  const backup = await reopened.exportBackup()
  assert.doesNotMatch(JSON.stringify(backup), /persist\.vtt|transcriptsChecked|"transcripts"/)
  const imported = createWebStorage({ indexedDB: new IDBFactory(), name: 'imported-transcripts' }); t.after(() => imported.close())
  await imported.importBackup(backup)
  const rows = (await imported.exportBackup()).library.episodes, restoredId = rows.find(row => row.guid === 'old').id
  assert.equal((await imported.readPodcastTranscripts(restoredId)).checked, false)
  await reopened.savePodcastTranscripts(id, [], Date.now() - 600_001)
  assert.equal((await reopened.readPodcastTranscripts(id)).checked, false)
  await reopened.savePodcastTranscripts(id, [])
  assert.deepEqual((await reopened.readPodcastTranscripts(id)).references, [])
  assert.equal((await reopened.readPodcastTranscripts(id)).checked, true)
})

test('fresh absence and YouTube podcasts return null; failed text retries without caching an error', async () => {
  let references = [], calls = 0, feedUrl = show.feedUrl
  const api = engine({ async readPodcastTranscripts() { return { ...show, guid: 'old', feedUrl, checked: true, references: structuredClone(references) } } }, {
    async fetchTranscript() { calls++; if (calls === 1) throw new Error('CORS. Vuelve a intentarlo.'); return parse('Publicado', 'text/plain') },
  })
  assert.equal(await api.transcript(1), null); assert.equal(calls, 0)
  references = [reference('fresh.vtt')]
  await assert.rejects(api.transcript(1), /CORS/)
  assert.equal((await api.transcript(1)).text, 'Publicado'); assert.equal(calls, 2)
  feedUrl = 'youtube:PLpodcast'
  assert.equal(await api.transcript(1), null); assert.equal(calls, 2)
})

test('an unreadable stale RSS keeps published references; with no known reference it reports retryable failure', async t => {
  let references = [reference('known.vtt')], feedRequests = 0, saves = 0
  t.mock.method(globalThis, 'fetch', async () => { feedRequests++; throw new TypeError('CORS') })
  const api = engine({ async readPodcastTranscripts() { return { feedUrl: show.feedUrl, guid: 'old', language: 'es', checked: false, references: structuredClone(references) } },
    async savePodcastTranscripts() { saves++ } }, { async fetchTranscript() { return parse('Texto anterior', 'text/plain') } })
  assert.equal((await api.transcript(1)).text, 'Texto anterior'); assert.equal(saves, 0)
  references = []
  await assert.rejects(api.transcript(1), /CORS.*Vuelve a intentarlo/)
  await assert.rejects(api.transcript(1), /CORS/)
  assert.equal(feedRequests, 3); assert.equal(saves, 0)
})
