import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

// Compila los módulos reales; las peticiones y la biblioteca se inyectan sin red ni Tauri.
const compile = async (name) => ts.transpileModule(await readFile(new URL(`../../web-port/${name}.ts`, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText
const [youtubeCode, audioCode, podcastCode] = await Promise.all([compile('youtube'), compile('audio'), compile('podcast-audio')])
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

function engine(overrides = {}, savedChoice = null, directVideo = id, podcastEpisode = null, downloaded = null) {
  const youtube = browserTransport()
  const calls = [], writes = [], removedDownloads = []
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
    readPodcastEpisode: async (episodeId) => {
      calls.push(`podcast:${episodeId}`)
      return typeof podcastEpisode === 'function' ? podcastEpisode(episodeId) : podcastEpisode
    },
  }
  const downloads = { readDownloadedPlayable: async () => downloaded, removeDownloadedTrack: async (trackId) => { downloaded = null; removedDownloads.push(trackId) } }
  const podcasts = {}
  const dependency = (path) => path === './youtube' ? mocks : path === './storage' ? storage : assert.fail(`Unexpected import ${path}`)
  new Function('exports', 'require', podcastCode)(podcasts, dependency)
  const exports = {}
  new Function('exports', 'require', audioCode)(exports, (path) => path === './download-store' ? downloads : path === './podcast-audio' ? podcasts : dependency(path))
  return { ...exports, youtube, calls, writes, podcasts, removedDownloads }
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

test('contentLength corresponde al formato seleccionado y solo admite enteros positivos hasta 2 GiB', () => {
  const yt = browserTransport(), fixture = playerFixture()
  fixture.streamingData.adaptiveFormats[0].contentLength = '123456'
  fixture.streamingData.adaptiveFormats.push({ mimeType: 'video/mp4', bitrate: 999999, contentLength: '987654', url: 'https://r1.googlevideo.com/video' })
  assert.equal(yt.parsePlayer(fixture, id).contentLength, 123456)
  for (const value of ['0', '-1', '1.5', '1e3', '2147483649', Number.MAX_SAFE_INTEGER, NaN, Infinity]) {
    fixture.streamingData.adaptiveFormats[0].contentLength = value
    assert.equal(yt.parsePlayer(fixture, id).contentLength, undefined)
  }
  fixture.streamingData.adaptiveFormats[0].contentLength = 2 * 1024 ** 3
  assert.equal(yt.parsePlayer(fixture, id).contentLength, 2 * 1024 ** 3)
  delete fixture.streamingData.adaptiveFormats[0].contentLength
  fixture.streamingData.adaptiveFormats[0].url += '&clen=54321'
  assert.equal(yt.parsePlayer(fixture, id).contentLength, 54321)
  fixture.streamingData.adaptiveFormats[0].contentLength = '54322'
  assert.equal(yt.parsePlayer(fixture, id).contentLength, undefined, 'contradictory sizes cannot be used as a download completion guarantee')
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

test('un refresh rechazado invalida la URL anterior y el siguiente intento pide otro player', async () => {
  const yt = browserTransport()
  const initial = yt.stream(id)
  yt.send({ responseContext: { visitorData: 'anonymous-fixture' } })
  await flush()
  yt.send(playerFixture())
  const previous = await initial
  const renewal = yt.stream(id, true)
  const rejected = assert.rejects(renewal, (error) => error.code === 'unavailable')
  await flush()
  assert.equal(yt.args().body.videoId, id)
  yt.send({ playabilityStatus: { status: 'UNPLAYABLE' } })
  await rejected
  const retry = yt.stream(id)
  await flush()
  assert.equal(yt.frames.length, 1, 'the failed refresh must not leave the previous URL reusable in RAM')
  assert.equal(yt.args().url.includes('/player?'), true)
  const replacement = playerFixture()
  replacement.streamingData.adaptiveFormats[0].url += '&attempt=2'
  yt.send(replacement)
  assert.notEqual((await retry).url, previous.url)
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

test('Music de confianza sin audio amplía a WEB y corta al encontrar la misma canción reproducible', async () => {
  for (const code of ['unavailable', 'format']) {
    const events = []
    const audio = engine({
      searchMusic: async () => { events.push('music'); return [candidate()] },
      searchVideos: async () => { events.push('web'); return [second, third, fourth].map((videoId) => candidate(videoId, { title: 'Radiohead - Airbag', album: null })) },
      stream: async (videoId) => {
        events.push(videoId)
        if (videoId !== third) throw new audio.youtube.YouTubeError('Audio rechazado', code)
        return info(videoId)
      },
    })
    const resolved = await audio.resolveTrack(query)
    assert.equal(resolved.videoId, third, code)
    assert.equal(resolved.title, query.title)
    assert.deepEqual(events, ['music', id, 'web', second, third], 'WEB is a later phase and stops immediately after success')
    assert.deepEqual(audio.writes.map((row) => row.choice.videoId), [third])
    assert.equal(Object.hasOwn(audio.writes[0].choice, 'url'), false)
  }
})

test('una fuente guardada rechazada no se reintenta aunque aparezca sola en Music y duplicada en WEB', async () => {
  for (const code of ['unavailable', 'format']) {
    const events = []
    const saved = { videoId: id, title: 'Elección anterior', channel: 'Radiohead', duration: 287, score: 100, verified: true }
    const audio = engine({
      searchMusic: async () => { events.push('music'); return [candidate(), candidate()] },
      searchVideos: async () => { events.push('web'); return [candidate(), candidate(second, { title: 'Radiohead - Airbag', album: null }), candidate()] },
      stream: async (videoId) => {
        events.push(videoId)
        if (videoId === id) throw new audio.youtube.YouTubeError('Fuente guardada rechazada', code)
        return info(videoId)
      },
    }, saved)
    assert.equal((await audio.resolveTrack(query)).videoId, second, code)
    assert.deepEqual(events, [id, 'music', 'web', second], 'saved and search duplicates must share the attempted-ID set')
    assert.deepEqual(audio.writes.map((row) => row.choice.videoId), [second])
  }
})

test('el presupuesto permite tres intentos Music y tres WEB distintos dentro de la misma operación', async () => {
  const attempts = [], phases = [], signals = []
  const webIds = ['ccccccccccc', 'ddddddddddd', 'eeeeeeeeeee', 'fffffffffff']
  const audio = engine({
    searchMusic: async (_query, signal) => { phases.push('music'); signals.push(signal); return [id, second, third, fourth].map((videoId) => candidate(videoId)) },
    searchVideos: async (_query, signal) => {
      phases.push('web'); signals.push(signal)
      return [id, second, third, ...webIds].map((videoId) => candidate(videoId, { title: 'Radiohead - Airbag', album: null }))
    },
    stream: async (videoId, _refresh, signal) => {
      attempts.push(videoId); signals.push(signal)
      throw new audio.youtube.YouTubeError('Sin formato compatible', 'format')
    },
  })
  await assert.rejects(() => audio.resolveTrack(query), (error) => error.code === 'format')
  assert.deepEqual(phases, ['music', 'web'])
  assert.deepEqual(attempts, [id, second, third, ...webIds.slice(0, 3)])
  assert.equal(new Set(attempts).size, 6)
  assert.ok(signals[0] instanceof AbortSignal)
  assert.ok(signals.every((signal) => signal === signals[0]), 'fallback phases must share cancellation and the existing 45-second operation deadline')
  assert.deepEqual(audio.writes, [])
})

test('un éxito dentro de Music evita ampliar WEB incluso tras rechazos previos', async () => {
  const attempts = []
  let webSearches = 0
  const audio = engine({
    searchMusic: async () => [id, second, third, fourth].map((videoId) => candidate(videoId)),
    searchVideos: async () => { webSearches++; return [candidate(fourth)] },
    stream: async (videoId) => {
      attempts.push(videoId)
      if (videoId !== third) throw new audio.youtube.YouTubeError('Vídeo retirado', 'unavailable')
      return info(videoId)
    },
  })
  assert.equal((await audio.resolveTrack(query)).videoId, third)
  assert.deepEqual(attempts, [id, second, third])
  assert.equal(webSearches, 0)
  assert.deepEqual(audio.writes.map((row) => row.choice.videoId), [third])
})

test('network, timeout y restricted no amplían WEB ni sustituyen una elección explícita', async () => {
  for (const code of ['network', 'timeout', 'restricted']) {
    for (const hasSaved of [false, true]) {
      const events = []
      const saved = hasSaved ? { videoId: id, title: 'Elegida', channel: 'Radiohead', duration: 287, score: 100, verified: true } : null
      let failure
      const audio = engine({
        searchMusic: async () => { events.push('music'); return [candidate()] },
        searchVideos: async () => { events.push('web'); return [candidate(second)] },
        stream: async (videoId) => { events.push(videoId); failure = new audio.youtube.YouTubeError('Fallo transitorio o restricción', code); throw failure },
      }, saved)
      await assert.rejects(() => audio.resolveTrack(query), (error) => error === failure)
      assert.deepEqual(events, hasSaved ? [id] : ['music', id], `${code}, saved=${hasSaved}`)
      assert.deepEqual(audio.writes, [])
    }
  }
})

test('el rechazo de audio ofrece la mejor coincidencia ya obtenida sin búsquedas, URLs ni escrituras adicionales', async () => {
  for (const code of ['unavailable', 'format']) {
    const events = [], failures = new Map()
    const audio = engine({
      searchMusic: async () => { events.push('music'); return [candidate(id, { url: 'https://r1.googlevideo.com/DO_NOT_FORWARD' })] },
      searchVideos: async () => { events.push('web'); return [candidate(second, { album: null })] },
      stream: async (videoId) => {
        events.push(videoId)
        const error = new audio.youtube.YouTubeError('Audio no permitido', code)
        failures.set(videoId, error)
        throw error
      },
    })
    let failure
    await assert.rejects(audio.resolveTrack(query), error => {
      failure = error
      assert.ok(error instanceof audio.OfficialFallbackError)
      assert.ok(error instanceof audio.youtube.YouTubeError)
      assert.equal(error.code, code)
      assert.equal(error.toString(), 'Audio no permitido')
      assert.equal(error.originalError, failures.get(second))
      assert.equal(error.cause, error.originalError)
      return true
    })
    assert.deepEqual(events, ['music', id, 'web', second])
    const source = audio.getOfficialFallback(query, failure)
    assert.equal(source.videoId, id)
    assert.equal(source.score, 112)
    assert.equal(source.current, false)
    assert.equal(failure.fallback.trackId, query.id)
    assert.equal(failure.fallback.reason, code)
    assert.ok(Object.isFrozen(failure.fallback) && Object.isFrozen(failure.fallback.source))
    assert.doesNotMatch(JSON.stringify(failure.fallback), /DO_NOT_FORWARD|googlevideo|\"url\"/)
    source.title = 'Caller copy'
    assert.equal(audio.getOfficialFallback(query, failure).title, query.title)
    assert.deepEqual(audio.writes, [])
    assert.deepEqual(audio.removedDownloads, [])
  }
})

test('la alternativa conserva la fuente manual exacta aunque otra coincidencia tenga mayor puntuación', async () => {
  const saved = { videoId: fourth, title: 'Airbag (versión elegida)', channel: 'Canal elegido', duration: 290, score: 100, verified: true }
  const events = []
  const audio = engine({
    searchMusic: async () => { events.push('music'); return [candidate()] },
    searchVideos: async () => { events.push('web'); return [] },
    stream: async videoId => { events.push(videoId); throw new audio.youtube.YouTubeError('Sin audio', 'unavailable') },
  }, saved)
  await assert.rejects(audio.resolveTrack(query), error => {
    const source = audio.getOfficialFallback(query, error)
    assert.equal(source.videoId, fourth)
    assert.equal(source.title, saved.title)
    assert.equal(source.artists, saved.channel)
    assert.equal(source.duration, saved.duration)
    assert.equal(source.current, true)
    assert.equal(source.score, 100)
    return true
  })
  assert.deepEqual(events, [fourth, 'music', id, 'web'])
  assert.deepEqual(audio.writes, [])
})

test('elegir los metadatos de la mejor alternativa conserva el último mensaje y clasificación del resolver', async () => {
  let final
  const audio = engine({
    searchVideos: async () => [candidate(second, { album: null })],
    stream: async videoId => {
      const error = new audio.youtube.YouTubeError(videoId === id ? 'Retirada' : 'Sin MP4', videoId === id ? 'unavailable' : 'format')
      if (videoId === second) final = error
      throw error
    },
  })
  await assert.rejects(audio.resolveTrack(query), error => {
    assert.equal(error.originalError, final)
    assert.equal(error.code, 'format')
    assert.equal(error.toString(), 'Sin MP4')
    assert.equal(error.fallback.reason, 'format')
    assert.equal(audio.getOfficialFallback(query, error).videoId, id)
    return true
  })
})

test('un fallo transitorio entre rechazos de formato impide la alternativa automática y conserva el error original', async () => {
  for (const code of ['network', 'timeout', 'restricted', 'response']) {
    let final
    const audio = engine({
      searchMusic: async () => [candidate(), candidate(second), candidate(third)],
      searchVideos: async () => assert.fail('A mixed failure must not add a WEB search'),
      stream: async videoId => {
        const error = new audio.youtube.YouTubeError('Fallo ' + videoId, videoId === second ? code : 'format')
        if (videoId === third) final = error
        throw error
      },
    })
    await assert.rejects(audio.resolveTrack(query), error => {
      assert.equal(error, final)
      assert.equal(audio.getOfficialFallback(query, error), null)
      return true
    })
    assert.deepEqual(audio.writes, [])
  }
})

test('la alternativa rechaza karaoke no solicitado y coincidencias por debajo del umbral', async () => {
  for (const row of [candidate(id, { title: 'Airbag (Karaoke)' }), candidate(id, { title: 'Other song', artists: ['Another artist'], duration: 200, album: null })]) {
    const audio = engine({
      searchMusic: async () => [row], searchVideos: async () => [],
      stream: async () => { throw new audio.youtube.YouTubeError('Sin audio', 'unavailable') },
    })
    await assert.rejects(audio.resolveTrack(query), error => {
      assert.equal(audio.getOfficialFallback(query, error), null)
      return true
    })
    assert.deepEqual(audio.writes, [])
  }
})

test('la lectura de alternativa valida tipo y canción sin reinterpretar errores ni namespace de pódcast', async () => {
  const audio = engine({ stream: async () => { throw new audio.youtube.YouTubeError('Sin formato', 'format') } })
  let failure
  await assert.rejects(audio.resolveTrack(query), error => { failure = error; return true })
  for (const track of [{ ...query, id: 2 }, { ...query, id: 750_000_000_000_001 }, { ...query, id: 1_000_000_000_000_001 }, null]) {
    assert.equal(audio.getOfficialFallback(track, failure), null)
  }
  for (const error of [new Error('Sin formato'), new audio.youtube.YouTubeError('Sin formato', 'format'),
    { ...failure, fallback: { ...failure.fallback, source: { ...failure.fallback.source, videoId: 'bad' } } }]) {
    assert.equal(audio.getOfficialFallback(query, error), null)
  }
})

test('resolver una descarga devuelve solo el mismo rechazo tipado y nunca abre un reproductor ni guarda la selección', async () => {
  const audio = engine({ stream: async () => { throw new audio.youtube.YouTubeError('Sin audio', 'unavailable') } })
  await assert.rejects(audio.resolveRemoteTrack(query), error => {
    assert.equal(audio.getOfficialFallback(query, error).videoId, id)
    return true
  })
  // The module harness permits only transport/storage/download imports, with no player/controller/UI dependency.
  assert.deepEqual(audio.writes, [])
  assert.deepEqual(audio.calls, ['music', 'youtube'])
})

test('un vídeo añadido ofrece solo su ID original y los pódcast no ofrecen alternativa al fallar YouTube', async () => {
  const direct = { ...query, id: 250_000_000_000_001 }
  const audio = engine({ stream: async () => { throw new audio.youtube.YouTubeError('Sin audio', 'unavailable') } }, null, second)
  await assert.rejects(audio.resolveTrack(direct), error => {
    const source = audio.getOfficialFallback(direct, error)
    assert.equal(source.videoId, second)
    assert.equal(source.title, direct.title)
    assert.equal(source.current, true)
    return true
  })
  assert.deepEqual(audio.calls, [], 'No music or WEB search for a direct video')
  const podcast = { ...query, id: 750_000_000_000_002 }
  const episode = engine({ stream: async () => { throw new episode.youtube.YouTubeError('Sin audio', 'unavailable') } }, null, id,
    { id: podcast.id, audioUrl: `youtube:${third}` })
  await assert.rejects(episode.resolveTrack(podcast), error => {
    assert.equal(episode.getOfficialFallback(podcast, error), null)
    assert.equal(error instanceof episode.OfficialFallbackError, false)
    return true
  })
})

test('cancelar antes del rechazo de Music impide que ese rechazo abra el fallback WEB', async () => {
  const pendingStream = deferred(), attempts = []
  let webSearches = 0
  const audio = engine({
    searchMusic: async () => [candidate()],
    searchVideos: async () => { webSearches++; return [candidate(second)] },
    stream: async (videoId) => { attempts.push(videoId); return pendingStream.promise },
  })
  const resolving = audio.resolveTrack(query)
  const cancelled = assert.rejects(resolving, { name: 'AbortError' })
  await flush()
  assert.deepEqual(attempts, [id])
  audio.cancelAudioRequests()
  pendingStream.reject(new audio.youtube.YouTubeError('Vídeo retirado', 'unavailable'))
  await cancelled
  assert.equal(webSearches, 0)
  assert.deepEqual(audio.writes, [])
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

test('un YouTube añadido no busca sustitutos ni cambia su ID tras rechazo y refresh', async () => {
  const attempts = [], direct = { ...query, id: 250_000_000_000_001 }
  const audio = engine({ stream: async (videoId, refresh) => {
    attempts.push([videoId, refresh])
    throw new audio.youtube.YouTubeError('Vídeo directo retirado', 'unavailable')
  } })
  await assert.rejects(() => audio.resolveTrack(direct), (error) => error.code === 'unavailable')
  await assert.rejects(() => audio.resolveTrack(direct, true), (error) => error.code === 'unavailable')
  assert.deepEqual(attempts, [[id, false], [id, true]])
  assert.deepEqual(audio.calls, [], 'direct-video failures cannot enter either catalog search')
  assert.deepEqual(audio.writes, [])
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

test('episodios RSS usan su fuente persistida sin buscar ni resolver en YouTube', async () => {
  const track = { ...query, id: 750_000_000_000_001 }
  const episode = { id: track.id, audioUrl: 'https://audio.example.org/episode.mp3?public=1&x=2#fragment' }
  const audio = engine({}, null, id, episode)
  assert.deepEqual(await audio.resolveTrack(track), { videoId: '', url: 'https://audio.example.org/episode.mp3?public=1&x=2', title: track.title, channel: track.artist, local: false })
  assert.deepEqual(audio.calls, [`podcast:${track.id}`])
  assert.deepEqual(audio.writes, [])
  await assert.rejects(() => audio.alternatives(track), /audio original del pódcast/)
  await assert.rejects(() => audio.chooseSource(track, second), /audio original del pódcast/)
  for (const source of ['http://audio.example.org/e.mp3', 'javascript:alert(1)', 'data:audio/mp3,hi', 'file:///secret.mp3',
    'https://user:password@audio.example.org/e.mp3', 'https://audio.example.org/\ne.mp3']) {
    assert.throws(() => audio.podcasts.podcastAudioUrl(source))
  }
})

test('episodios YouTube conservan namespace y renuevan solo el stream temporal en RAM', async () => {
  const track = { ...query, id: 750_000_000_000_002 }, loaded = []
  const audio = engine({ stream: async (...args) => { loaded.push(args); return info(args[0]) } }, null, id,
    { id: track.id, audioUrl: `youtube:${second}` })
  assert.equal((await audio.resolveTrack(track)).videoId, second)
  await audio.resolveTrack(track, true)
  assert.deepEqual(loaded.map(([videoId, refresh]) => [videoId, refresh]), [[second, false], [second, true]])
  assert.ok(!audio.calls.includes('music') && !audio.calls.includes('youtube'))
  assert.deepEqual(audio.writes, [], 'a podcast stream must never become a music source choice')
})

test('programas y episodios desconocidos o corruptos no caen en el matching musical', async () => {
  for (const [episodeId, row] of [[500_000_000_000_001, null], [750_000_000_000_001, null],
    [750_000_000_000_001, { id: 750_000_000_000_002, audioUrl: 'https://audio.example/e.mp3' }],
    [750_000_000_000_001, { id: 750_000_000_000_001, audioUrl: 'youtube:invalid' }]]) {
    const audio = engine({}, null, id, row)
    await assert.rejects(() => audio.resolveTrack({ ...query, id: episodeId }))
    assert.ok(!audio.calls.includes('music') && !audio.calls.includes('youtube'))
    assert.deepEqual(audio.writes, [])
  }
})

test('cancelar mientras se lee un episodio impide iniciar después su extractor', async () => {
  const pendingEpisode = deferred(), episodeId = 750_000_000_000_003
  const audio = engine({}, null, id, () => pendingEpisode.promise)
  const pending = audio.resolveTrack({ ...query, id: episodeId })
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  await flush()
  audio.cancelAudioRequests()
  pendingEpisode.resolve({ id: episodeId, audioUrl: `youtube:${second}` })
  await rejected
  assert.deepEqual(audio.calls, [`podcast:${episodeId}`])
})

test('copia descargada se reproduce sin red y cambiar fuente elimina la copia anterior', async () => {
  const local = { videoId: '', url: 'https://app.example/pletina/__audio__/1', title: 'Airbag', channel: 'Radiohead', local: true }
  const audio = engine({}, null, id, null, local)
  assert.deepEqual(await audio.resolveTrack(query), local)
  assert.deepEqual(audio.calls, [])
  assert.equal((await audio.resolveRemoteTrack(query)).local, false, 'the downloader can resolve a remote source without selecting its own cache')
  await audio.chooseSource(query, second)
  assert.deepEqual(audio.removedDownloads, [query.id])
  assert.equal((await audio.resolveTrack(query)).videoId, second)
})
