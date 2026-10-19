import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const code = ts.transpileModule(await readFile(new URL('../../web-port/catalog.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText
const PENDING = Symbol('pending')
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
const track = (extra = {}) => ({ id: 3240252511, title: 'A Solas Con un RItmo Lírico', duration: 118,
  artist: { id: 5094, name: 'Violadores del Verso' }, album: { id: 715224221, title: 'Genios' }, ...extra })
const artist = { id: 5094, name: 'Violadores del Verso' }
const album = { id: 715224221, title: 'Genios', artist }
const empty = { data: [] }
function engine(route = () => empty) {
  const exports = {}, frames = [], requests = [], window = new EventTarget()
  const args = (frame) => JSON.parse(frame.srcdoc.slice(frame.srcdoc.lastIndexOf(')(') + 2, -')</script>'.length))
  const send = (frame, value) => {
    const event = new Event('message')
    Object.defineProperties(event, { source: { value: frame.contentWindow }, origin: { value: 'null' },
      data: { value: { type: 'pletina-catalog', requestId: args(frame).requestId, json: JSON.stringify(value) } } })
    window.dispatchEvent(event)
  }
  const append = (frame) => {
    frames.push(frame)
    const config = args(frame), url = new URL(config.url)
    requests.push({ path: url.pathname, query: url.searchParams.get('q'), frame })
    const result = route(url, requests)
    if (result !== PENDING) queueMicrotask(() => send(frame, result))
  }
  const document = { body: { append }, documentElement: { append }, createElement(name) {
    assert.equal(name, 'iframe')
    return { contentWindow: {}, setAttribute() {}, remove() { const index = frames.indexOf(this); if (index >= 0) frames.splice(index, 1) } }
  } }
  new Function('exports', 'window', 'document', code)(exports, window, document)
  return { ...exports, frames, requests, send }
}
const literal = 'A solas con un ritmo lirico de violadores del verso'
const normalized = 'A solas con un ritmo lirico violadores del verso'

test('natural query retries only an empty track section and preserves original artist/album results', async () => {
  const api = engine((url) => url.pathname.endsWith('/artist') ? { data: [artist] } : url.pathname.endsWith('/album') ? { data: [album] }
    : url.searchParams.get('q') === literal ? empty : { data: [track()] })
  const result = await api.search(literal)
  assert.equal(result.tracks[0].id, 3240252511)
  assert.equal(result.artists[0].id, artist.id)
  assert.equal(result.albums[0].id, album.id)
  assert.deepEqual(result.failedSections, [])
  assert.deepEqual(api.requests.map(({ path, query }) => [path, query]), [
    ['/search/artist', literal], ['/search/album', literal], ['/search/track', literal], ['/search/track', normalized],
  ])
  assert.equal(api.frames.length, 0)
})

test('a successful original track response never incurs a natural-query fallback', async () => {
  const api = engine((url) => url.pathname.endsWith('/track') ? { data: [track()] } : empty)
  assert.equal((await api.search(literal)).tracks.length, 1)
  assert.equal(api.requests.length, 3)
})

test('isolated connectors work in English/case variants and substrings are never removed', async () => {
  for (const [query, fallback] of [['Creep BY Radiohead', 'Creep Radiohead'], ['  Canción de Artista  ', 'Canción Artista'],
    ['Canción de by Artista', 'Canción Artista'], ['de Canción by', 'Canción']]) {
    const api = engine()
    const result = await api.search(query)
    assert.deepEqual(result.tracks, [])
    assert.deepEqual(result.failedSections, [])
    assert.equal(api.requests.length, 4)
    assert.equal(api.requests[3].query, fallback)
  }
  for (const query of ['Adele', 'Goodbye', 'Canción del artista', 'De: artista', 'de by']) {
    const api = engine()
    await api.search(query)
    assert.equal(api.requests.length, 3)
  }
})

test('an original track network error is reported without retrying it as an empty response', async () => {
  const api = engine((url) => url.pathname.endsWith('/track') ? { error: { code: 4 } } : empty)
  const result = await api.search(literal)
  assert.deepEqual(result.failedSections, ['tracks'])
  assert.equal(api.requests.length, 3)
})

test('fallback failures remain failedSections and do not erase successful original sections', async () => {
  const api = engine((url) => url.pathname.endsWith('/artist') ? { data: [artist] } : url.pathname.endsWith('/album') ? { error: { code: 4 } }
    : url.searchParams.get('q') === literal ? empty : { error: { code: 4 } })
  const result = await api.search(literal)
  assert.equal(result.artists[0].id, artist.id)
  assert.deepEqual(result.tracks, [])
  assert.deepEqual(result.failedSections, ['albums', 'tracks'])
  assert.equal(api.requests.length, 4)
})

test('invalid fallback metadata is reported as a failed track section instead of silently dropping it', async () => {
  const api = engine((url) => url.pathname.endsWith('/track') && url.searchParams.get('q') === normalized ? { data: [track({ id: 'not-a-number' })] } : empty)
  assert.deepEqual((await api.search(literal)).failedSections, ['tracks'])
  assert.equal(api.requests.length, 4)
})

test('the original input is capped before requests, including text a connector could shorten', async () => {
  const api = engine()
  await assert.rejects(() => api.search('de '.repeat(800)), /2000/)
  await assert.rejects(() => api.search(' '.repeat(2001)), /2000/)
  assert.equal(api.requests.length, 0)
  assert.deepEqual((await api.search('')).tracks, [])
  assert.equal(api.requests.length, 0)
  await api.search('x'.repeat(2000))
  assert.equal(api.requests.length, 3)
})

test('fallback encodes arbitrary text as query data inside the existing isolated JSONP transport', async () => {
  const query = 'Canción de </script><script>https://example.invalid?x=1&y=2</script>'
  const api = engine()
  await api.search(query)
  assert.equal(api.requests.length, 4)
  for (const request of api.requests) {
    assert.equal(request.frame.sandbox, 'allow-scripts')
    assert.equal((request.frame.srcdoc.match(/<\/script>/g) ?? []).length, 1)
    assert.match(request.frame.srcdoc, /%3C%2Fscript%3E/)
  }
  assert.equal(api.requests[3].query, query.replace(' de ', ' '))
})

test('cancelling the fallback removes its iframe and a late message cannot finish the obsolete search', async () => {
  const controller = new AbortController()
  const api = engine((url) => url.pathname.endsWith('/track') && url.searchParams.get('q') === normalized ? PENDING : empty)
  const pending = api.search(literal, { signal: controller.signal })
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  await flush()
  assert.equal(api.frames.length, 1)
  const frame = api.frames[0]
  controller.abort()
  await rejected
  assert.equal(api.frames.length, 0)
  api.send(frame, { data: [track()] })
  assert.equal(api.frames.length, 0)
})
