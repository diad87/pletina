import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../../web-port/podcasts.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText
function engine() {
  const exports = {}, window = new EventTarget(), frames = []
  const document = { body: { append(frame) { frames.push(frame) } }, createElement(name) {
    assert.equal(name, 'iframe')
    return { contentWindow: {}, setAttribute() {}, remove() { const index = frames.indexOf(this); if (index >= 0) frames.splice(index, 1) } }
  } }
  new Function('exports', 'require', 'window', 'document', compiled)(exports, () => ({}), window, document)
  const args = (frame = frames[0]) => JSON.parse(frame.srcdoc.slice(frame.srcdoc.lastIndexOf(')(') + 2, -')</script>'.length))
  const send = (value, { frame = frames[0], source = frame?.contentWindow, origin = 'null', requestId = args(frame).requestId } = {}) => {
    const event = new Event('message')
    Object.defineProperties(event, { source: { value: source }, origin: { value: origin },
      data: { value: { type: 'pletina-podcast-directory', requestId, json: JSON.stringify(value) } } })
    window.dispatchEvent(event)
  }
  return { ...exports, frames, args, send }
}
const api = engine()
const entry = { appleId: 1, feedUrl: 'https://feed.example/podcast.xml', title: 'Programa', author: 'Autora', image: null }
const episode = (overrides = {}) => ({ kind: 'podcast-episode', episodeContentType: 'audio', trackId: 30,
  episodeGuid: 'stable-guid', trackName: 'Episodio', description: '<p>Una &amp; otra</p>', trackTimeMillis: 125999,
  releaseDate: '2026-10-19T00:00:00Z', episodeUrl: 'https://audio.example/episode.mp3?tracking=public', ...overrides })

test('language normalization follows RSS declarations, not country names', () => {
  for (const [input, expected] of [['es-ES','es'], ['ES_mx','es'], ['spa','es'], ['eng','en'], ['cat','ca'], ['baq','eu'], ['ger','de']]) assert.equal(api.normalizeLanguage(input), expected)
  for (const input of ['Spanish', 'und', 'mul', 'zxx', '']) assert.equal(api.normalizeLanguage(input), null)
  assert.equal(api.filterLanguage('all'), null)
  assert.throws(() => api.filterLanguage('invalid-language'))
})
test('RSS duration handles seconds, hours, invalid fields and u32 overflow', () => {
  for (const [input, expected] of [['95',95], ['02:30',150], ['1:02:03',3723], ['1:60',0], ['1:02:99',0], ['-5',0], ['4294967295:20',0]]) assert.equal(api.durationSeconds(input), expected)
})
test('public feed/media URLs are HTTP(S), relative URLs resolve and HTTPS is preferred for playback', () => {
  assert.equal(api.webURL('/audio.m4a?x=1&y=2','https://feed.example/rss',true), 'https://feed.example/audio.m4a?x=1&y=2')
  assert.equal(api.webURL('http://media.example/audio.mp3',undefined,true),'https://media.example/audio.mp3')
  for(const url of ['javascript:alert(1)','file:///private.mp3','https://user:pass@host.example/rss','data:audio/mp3,abc']) assert.equal(api.webURL(url),null)
})
test('descriptions are bounded inert text and XML byte decoding respects declared encodings', () => {
  assert.equal(api.plainText('<p>Ideas &amp; <b>ciencia</b>.</p>'),'Ideas & ciencia .')
  assert.equal(api.plainText('a'.repeat(5000)).length,4000)
  const prefix = new TextEncoder().encode("<?xml version='1.0' encoding='ISO-8859-1'?><rss>Caf")
  const bytes = new Uint8Array([...prefix,0xe9,...new TextEncoder().encode('</rss>')])
  assert.match(api.decodeXML(bytes),/Café/)
  assert.throws(()=>api.decodeXML(new Uint8Array([0xff])))
})
test('directory results deduplicate feed identity and do not turn Apple IDs into internal IDs', () => {
  const rows = api.directoryEntries({results:[
    {collectionId:1,collectionName:'Uno',artistName:'A',feedUrl:entry.feedUrl,artworkUrl600:'http://images.example/cover.jpg'},
    {collectionId:2,collectionName:'Duplicado',feedUrl:entry.feedUrl},
    {collectionId:3,feedUrl:'javascript:alert(1)'},
  ]})
  assert.equal(rows.length,1);assert.equal(rows[0].appleId,1);assert.equal(rows[0].image,'https://images.example/cover.jpg')
  assert.equal(rows[0].id,undefined)
})
test('Apple fallback maps full episode URLs/GUIDs, excludes previews/video, and never guesses language', () => {
  const detail = api.appleDetail({results:[episode(),episode({trackName:'Duplicate'}),
    episode({episodeGuid:'video',episodeContentType:'video'}),episode({episodeGuid:'unsafe',episodeUrl:'javascript:alert(1)'}),
    episode({episodeGuid:'preview',episodeUrl:undefined,previewUrl:'https://audio.example/preview.mp3'}),
  ]},entry)
  assert.equal(detail.episodes.length,1);assert.equal(detail.episodes[0].guid,'stable-guid')
  assert.equal(detail.episodes[0].duration,125);assert.match(detail.episodes[0].audioUrl,/episode\.mp3/)
  assert.equal(detail.podcast.language,null);assert.equal(detail.podcast.episodeCount,1)
  assert.equal(detail.podcast.id,undefined);assert.equal(detail.episodes[0].id,undefined)
})
test('Apple JSONP is allowlisted and script payload escapes source markup', async () => {
  const api = engine(), pending = api.requestApple('search',{term:'</script>podcast',media:'podcast',entity:'podcast',country:'ES',limit:'30'})
  const config = api.args()
  assert.equal(new URL(config.url).origin,'https://itunes.apple.com')
  assert.equal(new URL(config.url).searchParams.get('callback'),'__pletinaPodcasts')
  assert.equal(api.frames[0].sandbox,'allow-scripts')
  assert.equal(api.frames[0].srcdoc.split('</script>').length,2)
  api.send({results:[]});assert.deepEqual(await pending,{results:[]});assert.equal(api.frames.length,0)
  assert.throws(()=>api.appleURL('https://evil.example',{}))
  assert.throws(()=>api.appleURL('search',{term:'a'.repeat(251)}))
  assert.throws(()=>api.appleURL('lookup',{id:'1&callback=evil'}))
})
test('JSONP ignores a different frame, nonopaque origin and wrong request ID', async () => {
  const api = engine(), pending = api.requestApple('search',{term:'podcast'})
  let settled=false;pending.then(()=>settled=true)
  api.send({results:[1]},{source:{}});api.send({results:[2]},{origin:'https://evil.example'});api.send({results:[3]},{requestId:999})
  await Promise.resolve();assert.equal(settled,false)
  api.send({results:[]});assert.deepEqual(await pending,{results:[]})
})
test('abort cancels a JSONP frame and prevents late completion', async () => {
  const api=engine(), controller=new AbortController()
  const pending=api.requestApple('search',{term:'podcast'},{signal:controller.signal})
  controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(api.frames.length,0)
  assert.throws(()=>api.requestApple('search',{term:'podcast'},{signal:controller.signal}),{name:'AbortError'})
})
