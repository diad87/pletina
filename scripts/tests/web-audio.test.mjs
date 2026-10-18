import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

// Compila los módulos reales; las peticiones y la biblioteca se inyectan sin red ni Tauri.
const compile = async (name) => ts.transpileModule(await readFile(new URL(`../../web-port/${name}.ts`, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText
const [youtubeCode, audioCode] = await Promise.all([compile('youtube'), compile('audio')])
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const id = 'aqz-KE-bpKQ', second = '9RfVp-GhKfs', third = 'aaaaaaaaaaa', fourth = 'bbbbbbbbbbb'
const query = { id: 1, title: 'Airbag', artist: 'Radiohead', album: 'OK Computer', duration: 287 }
const candidate = (videoId = id, extra = {}) => ({ videoId, title: 'Airbag', artists: ['Radiohead'], album: 'OK Computer', duration: 287, ...extra })
const info = (videoId = id) => ({ videoId, url: `https://example.googlevideo.com/audio/${videoId}`, title: 'Airbag', channel: 'Radiohead', duration: 287, expiresAt: Date.now() + 100000 })

function browserTransport() {
  const window = new EventTarget(), frames = []
  const append = (frame) => { frames.push(frame) }
  const document = { body: { append }, documentElement: { append }, createElement(name) {
    assert.equal(name, 'iframe')
    return { contentWindow: {}, setAttribute() {}, remove() { const i = frames.indexOf(this); if (i >= 0) frames.splice(i, 1) } }
  } }
  const exports = {}
  new Function('exports', 'window', 'document', youtubeCode)(exports, window, document)
  function args(frame = frames[0]) {
    const source = frame.srcdoc
    return JSON.parse(source.slice(source.lastIndexOf(')(') + 2, -')</script>'.length))
  }
  function send(result, { frame = frames[0], source = frame?.contentWindow, requestId = args(frame).requestId } = {}) {
    const event = new Event('message')
    Object.defineProperties(event, { source: { value: source }, data: { value: { type: 'pletina-web-youtube-json', requestId, result } } })
    window.dispatchEvent(event)
  }
  return { ...exports, frames, args, send }
}

function engine(overrides = {}, savedChoice = null, directVideo = id) {
  const youtube = browserTransport()
  const calls = [], writes = []
  const mocks = {
    ...youtube,
    searchMusic: async () => { calls.push('music'); return [candidate()] },
    searchVideos: async () => { calls.push('youtube'); return [] },
    stream: async (videoId) => { calls.push(videoId); return info(videoId) },
    ...overrides,
  }
  const storage = {
    readSourceChoice: async () => savedChoice,
    saveSourceChoice: async (trackId, choice) => { writes.push({ trackId, choice }); savedChoice = choice },
    readYouTubeVideo: async () => directVideo,
  }
  const exports = {}
  new Function('exports', 'require', audioCode)(exports, (path) => path === './youtube' ? mocks : path === './storage' ? storage : assert.fail(`Unexpected import ${path}`))
  return { ...exports, youtube, calls, writes }
}

const musicFixture = (items) => ({ contents: { tabbedSearchResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ musicShelfRenderer: { contents: items } }] } } } }] } } })
const song = (videoId = id) => ({ musicResponsiveListItemRenderer: { playlistItemData: { videoId }, flexColumns: [
  { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Air' }, { text: 'bag' }] } } },
  { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [
    { text: 'Radiohead', navigationEndpoint: { browseEndpoint: { browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_ARTIST' } } } } },
    { text: ' • ' }, { text: 'OK Computer', navigationEndpoint: { browseEndpoint: { browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_ALBUM' } } } } },
    { text: ' • ' }, { text: '4:47' },
  ] } } },
] } })
const video = (videoId = id, extra = {}) => ({ videoRenderer: { videoId, title: { runs: [{ text: 'Radiohead - ' }, { text: 'Airbag' }] },
  ownerText: { runs: [{ text: 'Radiohead' }] }, lengthText: { simpleText: '4:47' }, ...extra } })
const videoFixture = (items) => ({ contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: items } }] } } } } })
const playerFixture = (videoId = id) => ({ playabilityStatus: { status: 'OK' }, videoDetails: { videoId, title: 'Airbag', author: 'Radiohead', lengthSeconds: '287' },
  streamingData: { adaptiveFormats: [{ mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128000, url: `https://r1.googlevideo.com/audio?expire=${Math.floor(Date.now() / 1000) + 3600}` }] } })

test('el matching conserva puntuaciones y penalizaciones de Rust 0.11.2', () => {
  const audio = engine()
  assert.equal(audio.scoreCandidate(query, candidate(), 1), 111)
  assert.ok(audio.scoreCandidate(query, candidate(id, { title: 'Airbag (Live)', duration: 301, album: null }), 0) < audio.MIN_SCORE)
  assert.ok(audio.scoreCandidate({ ...query, title: 'Spoiler!', artist: 'Berri Txarrak', duration: 217 }, candidate(id, { title: 'Bakarrik Egoteko', artists: ['Berri Txarrak'], duration: 217, album: null }), 1) < audio.MIN_SCORE)
  assert.ok(audio.scoreCandidate(query, candidate(id, { artists: ['Someone Else'], duration: 200, album: null }), 0) < audio.MIN_SCORE)
  assert.equal(audio.normalize('Canción Ñandú!'), 'cancion nandu')
  assert.equal(audio.stripBrackets('Help! (Remastered [2009]) - Mono'), 'Help!  - Mono')
})

test('parsers mantienen metadatos y excluyen anuncios, recomendaciones, lives y shorts', () => {
  const yt = browserTransport()
  assert.deepEqual(yt.parseMusicResults(musicFixture([song(), song(), { promotedVideoRenderer: song(second) }])) , [candidate()])
  const fixture = videoFixture([video(), video(second, { isLiveNow: true }), video(third, { navigationEndpoint: { reelWatchEndpoint: {} } }),
    { adSlotRenderer: { items: [video(fourth)] } }])
  fixture.secondaryContents = videoFixture([video(fourth)])
  assert.deepEqual(yt.parseVideoResults(fixture), [candidate(id, { title: 'Radiohead - Airbag', album: null })])
  assert.throws(() => yt.parseMusicResults({}), /No se reconoce/)
  assert.throws(() => yt.parseVideoResults({}), /No se reconoce/)
  assert.deepEqual(yt.parseVideoResults(videoFixture([])), [])
  for (const invalid of ['19 M', '1:99', 'live', '0:00']) assert.equal(yt.parseDuration(invalid), null)
})

test('IDs y enlaces se validan sin visitar dominios arbitrarios', () => {
  const yt = browserTransport()
  for (const value of [id, `https://youtu.be/${id}?t=2`, `music.youtube.com/watch?v=${id}`, `https://youtube.com/shorts/${id}`]) assert.equal(yt.parseVideoId(value), id)
  for (const value of [`https://youtube.com.evil.invalid/watch?v=${id}`, `https://youtube.com/watch?v=${id}&v=${second}`,
    `https://user:pass@youtube.com/watch?v=${id}`, `https://youtube.com:444/watch?v=${id}`, `https://youtu.be/${id}/extra`, 'https://youtube.com/playlist?list=x']) assert.throws(() => yt.parseVideoId(value))
  for (const value of ['http://r1.googlevideo.com/x', 'https://googlevideo.com.evil.invalid/x', 'https://user:pass@googlevideo.com/x', 'https://googlevideo.com:444/x']) assert.throws(() => yt.audioUrl(value))
})

test('player solo selecciona audio MP4 del origen permitido y calcula caducidad conservadora', () => {
  const yt = browserTransport(), fixture = playerFixture()
  fixture.streamingData.adaptiveFormats.push({ mimeType: 'video/mp4', bitrate: 999999, url: 'https://r1.googlevideo.com/video' },
    { mimeType: 'audio/mp4', bitrate: 999998, url: 'https://evil.invalid/audio' },
    { mimeType: 'audio/mp4', bitrate: 999997, isDrc: true, url: 'https://r1.googlevideo.com/drc' })
  const value = yt.parsePlayer(fixture, id)
  assert.match(value.url, /^https:\/\/r1\.googlevideo\.com\/audio\?/)
  assert.equal(value.title, 'Airbag')
  assert.ok(value.expiresAt > Date.now() && value.expiresAt <= Date.now() + 20 * 60_000)
  assert.throws(() => yt.parsePlayer({ ...fixture, videoDetails: { videoId: second } }, id), /otro vídeo/)
  assert.throws(() => yt.parsePlayer({ playabilityStatus: { status: 'UNPLAYABLE' } }, id), (error) => error.code === 'unavailable')
  fixture.streamingData.adaptiveFormats = [{ mimeType: 'audio/mp4', url: 'https://r1.googlevideo.com/audio?expire=1' }]
  assert.throws(() => yt.parsePlayer(fixture, id), /caducado/)
})

test('sandbox valida emisor/ID, escapa cierre de script y se limpia al cancelar', async () => {
  const yt = browserTransport(), before = new AbortController()
  before.abort()
  await assert.rejects(() => yt.requestJson('music', 'search', {}, before.signal), { name: 'AbortError' })
  assert.equal(yt.frames.length, 0)
  const during = new AbortController()
  const pending = yt.requestJson('music', 'search', { query: '</script><script>bad</script>' }, during.signal)
  assert.equal(yt.frames[0].sandbox, 'allow-scripts')
  assert.equal((yt.frames[0].srcdoc.match(/<\/script>/g) || []).length, 1)
  assert.match(yt.frames[0].srcdoc, /\\u003c\/script>/)
  const original = yt.frames[0]
  yt.send({ malicious: true }, { source: {} })
  yt.send({ malicious: true }, { requestId: yt.args().requestId + 1 })
  assert.equal(yt.frames.length, 1)
  during.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(yt.frames.length, 0)
  yt.send({ late: true }, { frame: original })
  const next = yt.requestJson('youtube', 'search', {})
  yt.send({ good: true })
  assert.deepEqual(await next, { good: true })
  assert.equal(yt.frames.length, 0)
})

test('stream conserva URL solo en RAM y refresh fuerza otro player conservando sesión anónima', async () => {
  const yt = browserTransport()
  const pending = yt.stream(id)
  assert.equal(yt.args().url.includes('/search?'), true)
  yt.send({ responseContext: { visitorData: 'anonymous-fixture' } })
  await flush()
  assert.equal(yt.args().body.context.client.clientName, 'VISIONOS')
  yt.send(playerFixture())
  const first = await pending
  assert.equal(yt.frames.length, 0)
  assert.equal((await yt.stream(id)).url, first.url)
  assert.equal(yt.frames.length, 0)
  const refresh = yt.stream(id, true)
  await flush()
  assert.equal(yt.args().url.includes('/player?'), true)
  yt.send(playerFixture())
  await refresh
  assert.equal(yt.frames.length, 0)
})

test('resolve usa matching, deduplica cargas y guarda elección sin URL firmada', async () => {
  const gate = deferred()
  let searches = 0
  const audio = engine({ searchMusic: async () => { searches++; await gate.promise; return [candidate()] } })
  const a = audio.resolveTrack(query), b = audio.resolveTrack(query)
  await flush()
  assert.equal(searches, 1)
  gate.resolve()
  assert.deepEqual(await a, await b)
  assert.equal(audio.writes.length, 1)
  assert.equal(Object.hasOwn(audio.writes[0].choice, 'url'), false)
  assert.equal(audio.writes[0].choice.verified, false)
  assert.equal(audio.calls.includes('youtube'), false)
})

test('fallback WEB y máximo tres candidatos, sin guardar un fallo como una elección', async () => {
  const attempted = []
  const audio = engine({ searchMusic: async () => [], searchVideos: async () => [id, second, third, fourth].map((videoId) => candidate(videoId, { title: 'Radiohead - Airbag', album: null })),
    stream: async (videoId) => { attempted.push(videoId); throw new Error('No audio') } })
  await assert.rejects(() => audio.resolveTrack(query), /No audio/)
  assert.deepEqual(attempted, [id, second, third])
  assert.equal(audio.writes.length, 0)
})

test('fuente guardada no se sustituye por un error de red; un vídeo retirado sí permite otro', async () => {
  const saved = { videoId: id, title: 'Saved', channel: 'Artist', duration: 287, score: 100, verified: true }
  let searches = 0
  const failing = engine({ stream: async () => { throw new Error('Offline') }, searchMusic: async () => { searches++; return [] } }, saved)
  await assert.rejects(() => failing.resolveTrack(query), /Offline/)
  assert.equal(searches, 0)
  const removed = engine({ searchMusic: async () => [candidate(), candidate(second)], stream: async (videoId) => {
    if (videoId === id) throw new removed.youtube.YouTubeError('Removed', 'unavailable')
    return info(videoId)
  } }, saved)
  assert.equal((await removed.resolveTrack(query)).videoId, second)
})

test('YouTube añadido usa mapeo inmutable, y alternativas incluyen la elección actual', async () => {
  const audio = engine()
  const direct = { ...query, id: 250_000_000_000_001 }
  assert.equal((await audio.resolveTrack(direct)).videoId, id)
  assert.deepEqual(audio.calls, [id])
  await assert.rejects(() => audio.chooseSource(direct, second), /enlace de YouTube/)
  const missing = engine({}, null, null)
  await assert.rejects(() => missing.resolveTrack(direct), /No se encuentra/)
  assert.equal(missing.calls.length, 0)
  const current = engine({}, { videoId: second, title: 'Elegida', channel: 'Canal', duration: 287, score: 100, verified: true })
  const alternatives = await current.alternatives(query)
  assert.equal(alternatives[0].videoId, second)
  assert.equal(alternatives[0].current, true)
  assert.equal(alternatives[1].current, false)
})

test('elegir fuente cancela resolución vieja y ningún resultado tardío sobrescribe la elección', async () => {
  const gate = deferred()
  const audio = engine({ stream: async (videoId) => videoId === id ? gate.promise : info(videoId) })
  const old = audio.resolveTrack(query)
  const oldRejected = assert.rejects(old, { name: 'AbortError' })
  await flush()
  const chosen = await audio.chooseSource(query, second)
  assert.equal(chosen.videoId, second)
  gate.resolve(info(id))
  await oldRejected
  assert.deepEqual(audio.writes.map((row) => row.choice.videoId), [second])
  assert.equal(audio.writes[0].choice.verified, true)
})

test('resolve concurrente espera elección manual pendiente y cancelar limpia operaciones', async () => {
  const gate = deferred()
  let loads = 0
  const audio = engine({ stream: async () => { loads++; return gate.promise } })
  const chosen = audio.chooseSource(query, second)
  const resolving = audio.resolveTrack(query)
  await flush()
  assert.equal(loads, 1)
  gate.resolve(info(second))
  assert.deepEqual(await chosen, await resolving)
  const slow = deferred()
  const cancel = engine({ stream: async () => slow.promise })
  const pending = cancel.resolveTrack(query)
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  await flush()
  cancel.cancelAudioRequests()
  slow.resolve(info())
  await rejected
  assert.equal(cancel.writes.length, 0)
})
