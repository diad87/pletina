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
function retryClock() {
  const timers = new Map()
  let now = 0, sequence = 0
  return {
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { at: now + delay, fn }); return id },
    clearTimeout: id => timers.delete(id),
    get size() { return timers.size },
    async advance(ms) {
      await flush()
      const until = now + ms
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
        if (!next || next[1].at > until) break
        now = Math.max(now, next[1].at)
        timers.delete(next[0]); next[1].fn()
        await flush()
      }
      now = until
      await flush()
    },
  }
}
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

function engine(overrides = {}, savedChoice = null, directVideo = id, podcastEpisode = null, downloaded = null, clock = {}) {
  const youtube = browserTransport()
  const calls = [], writes = [], removedDownloads = [], retryEvents = [], timerDelays = []
  const window = new EventTarget()
  window.addEventListener('pletina:audio-retry', event => retryEvents.push(event.detail))
  // Preserve asynchronous backoff without adding a real second to every legacy
  // fallback test. Directed deadline tests supply a fully controlled clock.
  const schedule = (fn, delay) => {
    timerDelays.push(delay)
    return clock.setTimeout ? clock.setTimeout(fn, delay) : setTimeout(fn, delay === 250 || delay === 750 ? 0 : delay)
  }
  const unschedule = clock.clearTimeout ?? clearTimeout
  const mocks = {
    ...youtube,
    searchMusic: async () => { calls.push('music'); return [candidate()] },
    searchVideos: async () => { calls.push('youtube'); return [] },
    stream: async (videoId) => { calls.push(videoId); return info(videoId) },
    resolveCatalogSource: async () => null,
    resolveVerifiedAudio: async () => null,
    disposeVerifiedAudio() {},
    resolveFunkwhaleAudio: async () => null,
    disposeFunkwhaleAudio() {},
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
  new Function('exports', 'require', 'window', 'setTimeout', 'clearTimeout', audioCode)(exports,
    (path) => ['./catalog-sources', './verified-audio', './funkwhale-audio'].includes(path) ? mocks : path === './download-store' ? downloads : path === './podcast-audio' ? podcasts : dependency(path),
    window, schedule, unschedule)
  return { ...exports, youtube, calls, writes, podcasts, removedDownloads, retryEvents, timerDelays, window }
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

test('a transient final source gets two fresh same-ID playback attempts without repeating searches', async () => {
  const streams = []
  let audio
  audio = engine({ stream: async (videoId, refresh, signal) => {
    streams.push({ videoId, refresh, signal })
    if (streams.length < 3) throw new audio.youtube.YouTubeError('Temporary CDN failure', 'network')
    return info(videoId)
  } })
  assert.equal((await audio.resolveTrack(query)).videoId, id)
  assert.deepEqual(streams.map(({ videoId, refresh }) => [videoId, refresh]), [[id, false], [id, true], [id, true]])
  assert.ok(streams.every(row => row.signal === streams[0].signal))
  assert.deepEqual(audio.calls, ['music'])
  assert.deepEqual(audio.timerDelays, [45000, 250, 750])
  assert.equal(audio.writes.length, 1)
})

test('an automatic listening-only download tries an exact allowed recording before returning and writes no YouTube association', async () => {
  const attempts = [], permitted = { videoId: '', url: 'blob:exact-download', title: query.title, channel: query.artist, local: false,
    source: { provider: 'funkwhale', id: 'exact-recording', download: { allowed: true } } }
  const audio = engine({
    stream: async () => { attempts.push('youtube'); return { ...info(), transport: 'p1' } },
    resolveVerifiedAudio: async () => { attempts.push('verified'); return null },
    resolveFunkwhaleAudio: async () => { attempts.push('funkwhale'); return permitted },
    resolveCatalogSource: async () => assert.fail('an exact allowed source already succeeded'),
  })
  assert.deepEqual(await audio.resolveRemoteTrack(query), permitted)
  assert.deepEqual(attempts, ['verified', 'youtube', 'funkwhale'])
  assert.deepEqual(audio.writes, [])
  assert.deepEqual(audio.retryEvents, [])
})

for (const code of ['network', 'timeout']) test(`a cached automatic ${code} failure refreshes its same video before doing any new search`, async () => {
  const streams = [], providers = []
  const saved = { videoId: second, title: query.title, channel: query.artist, duration: 287, score: 90, verified: false }
  let audio
  audio = engine({
    stream: async (videoId, refresh) => { streams.push([videoId, refresh]); if (streams.length < 3) throw new audio.youtube.YouTubeError('Transient saved source', code); return info(videoId) },
    searchMusic: async () => assert.fail('a cached transport failure must not trigger a new search'),
    resolveVerifiedAudio: async () => { providers.push('verified'); return null },
    resolveFunkwhaleAudio: async () => { providers.push('funkwhale'); return null },
  }, saved)
  assert.equal((await audio.resolveTrack(query)).videoId, second)
  assert.deepEqual(streams, [[second, false], [second, true], [second, true]])
  assert.deepEqual(providers, ['verified', 'funkwhale'])
  assert.deepEqual(audio.writes, [])
})

test('a transient initial manual or added source offers video only after the final definitive same-ID refusal', async () => {
  for (const direct of [false, true]) {
    const streams = []
    let audio, last
    audio = engine({ stream: async (videoId, refresh) => {
      streams.push([videoId, refresh])
      last = new audio.youtube.YouTubeError(streams.length < 3 ? 'Temporary delivery' : 'Final refusal', streams.length < 3 ? 'network' : 'unavailable')
      throw last
    } }, direct ? null : { videoId: second, title: query.title, channel: query.artist, duration: 287, score: 100, verified: true }, second)
    const track = direct ? { ...query, id: 250_000_000_000_001 } : query
    await assert.rejects(audio.resolveTrack(track), error => error.originalError === last && audio.getOfficialFallback(track, error)?.videoId === second)
    assert.deepEqual(streams, [[second, false], [second, true], [second, true]])
    assert.deepEqual(audio.calls, [])
    assert.deepEqual(audio.writes, [])
  }
})

test('downloads do not gain automatic retries when their selected stream fails transiently', async () => {
  const streams = []
  let audio
  audio = engine({ stream: async (videoId, refresh) => { streams.push([videoId, refresh]); throw new audio.youtube.YouTubeError('Temporary download source failure', 'network') } })
  await assert.rejects(audio.resolveRemoteTrack(query), error => error.code === 'network' && !audio.getOfficialFallback(query, error))
  assert.deepEqual(streams, [[id, false]])
  assert.deepEqual(audio.retryEvents, [])
})

const exactDownload = (provider, allowed) => ({ videoId: '', url: `blob:exact-${provider}`, title: query.title, channel: query.artist, local: false,
  source: { provider, id: 'exact-catalog-recording', download: { allowed } } })

test('download rescue tries each exact provider once and skips every listening-only alternative', async () => {
  const seen = [], original = exactDownload('verified', false), allowed = exactDownload('audius', true)
  const audio = engine({
    resolveVerifiedAudio: async () => { seen.push('verified'); return original },
    resolveFunkwhaleAudio: async () => { seen.push('funkwhale'); return exactDownload('funkwhale', false) },
    resolveCatalogSource: async () => { seen.push('catalog'); return allowed },
  })
  assert.deepEqual(await audio.resolveRemoteTrack(query), allowed)
  assert.deepEqual(seen, ['verified', 'funkwhale', 'catalog'])
  assert.deepEqual(audio.calls, [])
  assert.deepEqual(audio.writes, [])
})

test('a prohibited original remains prohibited when every exact download source is absent, denied or fails', async () => {
  for (const failure of [false, true]) {
    const seen = []
    const audio = engine({
      stream: async () => ({ ...info(), transport: 'p1' }),
      resolveVerifiedAudio: async () => { seen.push('verified'); return null },
      resolveFunkwhaleAudio: async () => { seen.push('funkwhale'); if (failure) throw new Error('Provider unavailable'); return exactDownload('funkwhale', false) },
      resolveCatalogSource: async () => { seen.push('catalog'); return exactDownload('audius', false) },
    })
    const result = await audio.resolveRemoteTrack(query)
    assert.equal(result.source.provider, 'youtube-p1')
    assert.equal(result.source.download.allowed, false)
    assert.deepEqual(seen, ['verified', 'funkwhale', 'catalog'])
    assert.equal(audio.writes.length, 1, 'without an alternate, the original metadata association retains prior semantics')
  }
})

test('cached automatic listening-only downloads may use exact allowed audio without replacing manual or added sources', async () => {
  for (const mode of ['automatic', 'manual', 'direct']) {
    let providers = 0
    const source = exactDownload('funkwhale', true)
    const audio = engine({ stream: async videoId => ({ ...info(videoId), transport: 'p1' }),
      resolveVerifiedAudio: async () => { providers++; return source },
    }, mode === 'direct' ? null : { videoId: second, title: query.title, channel: query.artist, duration: 287, score: 100, verified: mode === 'manual' }, second)
    const track = mode === 'direct' ? { ...query, id: 250_000_000_000_001 } : query
    const result = await audio.resolveRemoteTrack(track)
    assert.equal(result.source.provider, mode === 'automatic' ? 'funkwhale' : 'youtube-p1')
    assert.equal(providers, mode === 'automatic' ? 1 : 0)
    assert.deepEqual(audio.calls, [])
    assert.deepEqual(audio.writes, [])
  }
})

test('cancelling exact download discovery rejects late allowed audio without writing a YouTube choice', async () => {
  const gate = deferred()
  let signal
  const audio = engine({ stream: async () => ({ ...info(), transport: 'p1' }),
    resolveFunkwhaleAudio: async (_track, current) => { signal = current; return gate.promise },
  })
  const pending = audio.resolveRemoteTrack(query), rejected = assert.rejects(pending, { name: 'AbortError' })
  await flush()
  assert.ok(signal instanceof AbortSignal)
  audio.cancelAudioRequests()
  gate.resolve(exactDownload('funkwhale', true))
  await rejected
  assert.equal(signal.aborted, true)
  assert.deepEqual(audio.writes, [])
  assert.deepEqual(audio.retryEvents, [])
})

test('final audio fallback retries the same selected video twice with fresh streams before recovering', async () => {
  const streams = []
  let audio
  audio = engine({ stream: async (videoId, refresh, signal) => {
    streams.push({ videoId, refresh, signal })
    if (streams.length < 3) throw new audio.youtube.YouTubeError('No direct audio yet', 'format')
    return info(videoId)
  } })
  const result = await audio.resolveTrack(query)
  assert.equal(result.videoId, id)
  assert.deepEqual(streams.map(({ videoId, refresh }) => ({ videoId, refresh })), [
    { videoId: id, refresh: false }, { videoId: id, refresh: true }, { videoId: id, refresh: true },
  ])
  assert.ok(streams.every(attempt => attempt.signal === streams[0].signal), 'all attempts share the original operation cancellation and deadline')
  assert.deepEqual(audio.calls, ['music', 'youtube'], 'retries do not repeat searches or switch recording')
  assert.deepEqual(audio.retryEvents, [{ trackId: query.id, attempt: 1, total: 2 }, { trackId: query.id, attempt: 2, total: 2 }])
  assert.deepEqual(audio.timerDelays, [45000, 250, 750])
  assert.equal(audio.writes.length, 1)
  assert.equal(audio.writes[0].choice.videoId, id)
  assert.equal(audio.writes[0].choice.verified, false)
  assert.equal(Object.hasOwn(audio.writes[0].choice, 'url'), false)
})

test('a final manual or added source retries only its exact video without changing the stored selection', async () => {
  for (const direct of [false, true]) {
    const streams = []
    let audio
    audio = engine({ stream: async (videoId, refresh) => {
      streams.push([videoId, refresh])
      if (streams.length < 3) throw new audio.youtube.YouTubeError('Direct audio unavailable', 'unavailable')
      return info(videoId)
    } }, direct ? null : { videoId: second, title: 'Manual source', channel: 'Radiohead', duration: 287, score: 100, verified: true }, second)
    const track = direct ? { ...query, id: 250_000_000_000_001 } : query
    assert.equal((await audio.resolveTrack(track)).videoId, second)
    assert.deepEqual(streams, [[second, false], [second, true], [second, true]])
    assert.deepEqual(audio.calls, [])
    assert.deepEqual(audio.writes, [], 'an explicit association is never rewritten as an automatic one')
    assert.deepEqual(audio.retryEvents.map(event => event.trackId), [track.id, track.id])
  }
})

test('downloads and explicit source changes do not inherit the automatic playback retry policy', async () => {
  const streams = []
  let audio
  audio = engine({ stream: async (videoId, refresh) => {
    streams.push([videoId, refresh])
    throw new audio.youtube.YouTubeError('Direct audio unavailable', 'unavailable')
  } })
  await assert.rejects(audio.resolveRemoteTrack(query), error => error instanceof audio.OfficialFallbackError)
  assert.deepEqual(streams, [[id, false]])
  streams.length = 0
  await assert.rejects(audio.chooseSource(query, second), error => error.code === 'unavailable' && !(error instanceof audio.OfficialFallbackError))
  assert.deepEqual(streams, [[second, false]])
  assert.deepEqual(audio.retryEvents, [])
  assert.deepEqual(audio.writes, [])
})

test('a first fresh retry success avoids the second retry and preserves listening-only capabilities', async () => {
  let attempts = 0, audio
  const primary = { ...info(), transport: 'p1' }
  audio = engine({ stream: async () => {
    if (++attempts === 1) throw new audio.youtube.YouTubeError('Initial source unavailable', 'unavailable')
    return primary
  } })
  const result = await audio.resolveTrack(query)
  assert.equal(attempts, 2)
  assert.deepEqual(result.source, { provider: 'youtube-p1', id, expiresAt: primary.expiresAt, download: { allowed: false } })
  assert.deepEqual(audio.retryEvents, [{ trackId: query.id, attempt: 1, total: 2 }])
  assert.deepEqual(audio.timerDelays, [45000, 250])
})

test('two definitive fresh failures expose the last matched refusal and persist nothing', async () => {
  let attempts = 0, audio, original, latest
  audio = engine({ stream: async () => {
    const error = new audio.youtube.YouTubeError(++attempts === 1 ? 'Original refusal' : 'Fresh refusal', attempts === 2 ? 'format' : 'unavailable')
    if (attempts === 1) original = error
    latest = error
    throw error
  } })
  await assert.rejects(audio.resolveTrack(query), error => {
    assert.ok(error instanceof audio.OfficialFallbackError)
    assert.equal(error.originalError, latest)
    assert.notEqual(error.originalError, original)
    assert.equal(error.code, latest.code)
    assert.equal(error.message, latest.message)
    assert.equal(error.fallback.source.videoId, id)
    return true
  })
  assert.equal(attempts, 3)
  assert.equal(audio.retryEvents.length, 2)
  assert.deepEqual(audio.writes, [])
  assert.doesNotMatch(JSON.stringify(audio.retryEvents), /https|videoId|url/)
})

for (const code of ['network', 'timeout']) test(`a final ${code} error stays transient after both fresh retries and cannot offer a video`, async () => {
  let attempts = 0, audio, last
  audio = engine({ stream: async () => {
    if (++attempts === 1) throw new audio.youtube.YouTubeError('Original refusal', 'format')
    last = new audio.youtube.YouTubeError('Transient retry failure', code)
    throw last
  } })
  await assert.rejects(audio.resolveTrack(query), error => error === last && error.code === code && !(error instanceof audio.OfficialFallbackError))
  assert.equal(attempts, 3)
  assert.deepEqual(audio.writes, [])
  assert.equal(audio.retryEvents.length, 2)
})

for (const code of ['restricted', 'response']) test(`a fresh ${code} failure stops retries immediately without offering the old fallback`, async () => {
  let attempts = 0, audio, terminal
  audio = engine({ stream: async () => {
    if (++attempts === 1) throw new audio.youtube.YouTubeError('Original refusal', 'unavailable')
    terminal = new audio.youtube.YouTubeError('Terminal fresh response', code)
    throw terminal
  } })
  await assert.rejects(audio.resolveTrack(query), error => error === terminal && !(error instanceof audio.OfficialFallbackError))
  assert.equal(attempts, 2)
  assert.deepEqual(audio.timerDelays, [45000, 250])
  assert.equal(audio.retryEvents.length, 1)
  assert.deepEqual(audio.writes, [])
})

test('cancelling the final backoff prevents fresh requests, retry events, and later source writes', async () => {
  const clock = retryClock()
  let attempts = 0, audio
  audio = engine({ stream: async () => { attempts++; throw new audio.youtube.YouTubeError('Original refusal', 'format') } }, null, id, null, null, clock)
  const pending = audio.resolveTrack(query)
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  await flush()
  assert.deepEqual(audio.timerDelays, [45000, 250])
  audio.retainAudioRequests([])
  await rejected; await clock.advance(1000)
  assert.equal(attempts, 1)
  assert.deepEqual(audio.retryEvents, [])
  assert.deepEqual(audio.writes, [])
  assert.equal(clock.size, 0)
})

test('cancellation from the retry notification cannot start a request after the selection changes', async () => {
  const clock = retryClock()
  let attempts = 0, audio
  audio = engine({ stream: async () => { attempts++; throw new audio.youtube.YouTubeError('Original refusal', 'format') } }, null, id, null, null, clock)
  audio.window.addEventListener('pletina:audio-retry', () => audio.retainAudioRequests([]))
  const pending = audio.resolveTrack(query), rejected = assert.rejects(pending, { name: 'AbortError' })
  await clock.advance(250); await rejected
  assert.equal(attempts, 1)
  assert.deepEqual(audio.retryEvents, [{ trackId: query.id, attempt: 1, total: 2 }])
  assert.deepEqual(audio.writes, [])
  assert.equal(clock.size, 0)
})

test('an aborted in-progress fresh stream cannot return late audio or write its automatic source', async () => {
  const clock = retryClock(), gate = deferred()
  let attempts = 0, audio
  audio = engine({ stream: async () => {
    if (++attempts === 1) throw new audio.youtube.YouTubeError('Original refusal', 'unavailable')
    return gate.promise
  } }, null, id, null, null, clock)
  const pending = audio.resolveTrack(query), rejected = assert.rejects(pending, { name: 'AbortError' })
  await clock.advance(250)
  assert.equal(attempts, 2)
  audio.retainAudioRequests([])
  gate.resolve(info())
  await rejected; await clock.advance(1000)
  assert.equal(attempts, 2)
  assert.equal(audio.retryEvents.length, 1)
  assert.deepEqual(audio.writes, [])
  assert.equal(clock.size, 0)
})

test('the original operation deadline bounds a pending retry and never becomes another fallback', async () => {
  const clock = retryClock()
  let attempts = 0, audio
  audio = engine({ stream: async (_videoId, _refresh, signal) => {
    if (++attempts === 1) throw new audio.youtube.YouTubeError('Original refusal', 'format')
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } }, null, id, null, null, clock)
  const pending = audio.resolveTrack(query), rejected = assert.rejects(pending,
    error => error.code === 'timeout' && !(error instanceof audio.OfficialFallbackError))
  await clock.advance(250)
  assert.equal(attempts, 2)
  await clock.advance(44750); await rejected
  assert.deepEqual(audio.timerDelays, [45000, 250], 'a retry cannot create a new operation deadline')
  assert.equal(audio.retryEvents.length, 1)
  assert.deepEqual(audio.writes, [])
  assert.equal(clock.size, 0)
})

test('a manual choice supersedes a pending final retry without a late automatic association', async () => {
  const clock = retryClock(), gate = deferred()
  let attempts = 0, audio
  audio = engine({ stream: async (videoId) => {
    if (videoId === second) return info(second)
    if (++attempts === 1) throw new audio.youtube.YouTubeError('Original refusal', 'unavailable')
    return gate.promise
  } }, null, id, null, null, clock)
  const pending = audio.resolveTrack(query), rejected = assert.rejects(pending, { name: 'AbortError' })
  await clock.advance(250)
  assert.equal((await audio.chooseSource(query, second)).videoId, second)
  gate.resolve(info())
  await rejected; await clock.advance(1000)
  assert.equal(attempts, 2)
  assert.equal(audio.retryEvents.length, 1)
  assert.deepEqual(audio.writes.map(write => [write.choice.videoId, write.choice.verified]), [[second, true]])
  assert.equal(clock.size, 0)
})

test('P1 keeps the same music and episode identity without offering unverified offline downloads', async () => {
  const primary = { ...info(), transport: 'p1' }
  const music = engine({ stream: async () => primary })
  const song = await music.resolveTrack(query)
  assert.equal(song.videoId, id)
  assert.equal(song.url, primary.url)
  assert.deepEqual(song.source, { provider: 'youtube-p1', id, expiresAt: primary.expiresAt, download: { allowed: false } })
  const podcast = { ...query, id: 750_000_000_000_001 }
  const episode = engine({ stream: async () => primary }, null, id, { id: podcast.id, audioUrl: `youtube:${id}` })
  const result = await episode.resolveRemoteTrack(podcast)
  assert.equal(result.videoId, id)
  assert.deepEqual(result.source, song.source)
  assert.deepEqual(episode.writes, [], 'An episode never becomes a musical source association')
})
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
    const saved = { videoId: id, title: 'Elección anterior', channel: 'Radiohead', duration: 287, score: 100, verified: false }
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

test('el presupuesto permite tres candidatos Music y tres WEB más dos reintentos de la única alternativa final', async () => {
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
  assert.deepEqual(attempts, [id, second, third, ...webIds.slice(0, 3), id, id])
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
      assert.deepEqual(events, hasSaved ? Array(code === 'restricted' ? 1 : 3).fill(id) : ['music', ...Array(code === 'restricted' ? 1 : 3).fill(id)], `${code}, saved=${hasSaved}`)
      assert.deepEqual(audio.writes, [])
    }
  }
})

test('el rechazo final de audio reintenta la mejor coincidencia sin repetir búsquedas, exponer URLs ni escribir asociaciones', async () => {
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
      assert.equal(error.originalError, failures.get(id))
      assert.equal(error.cause, error.originalError)
      return true
    })
    assert.deepEqual(events, ['music', id, 'web', second, id, id])
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
  assert.deepEqual(events, [fourth, fourth, fourth], 'all three attempts keep the explicit source without another video or catalog')
  assert.deepEqual(audio.writes, [])
})

test('la mejor alternativa conserva el último mensaje y clasificación de sus propios reintentos', async () => {
  let final
  const audio = engine({
    searchVideos: async () => [candidate(second, { album: null })],
    stream: async videoId => {
      const error = new audio.youtube.YouTubeError(videoId === id ? 'Retirada' : 'Sin MP4', videoId === id ? 'unavailable' : 'format')
      if (videoId === id) final = error
      throw error
    },
  })
  await assert.rejects(audio.resolveTrack(query), error => {
    assert.equal(error.originalError, final)
    assert.equal(error.code, 'unavailable')
    assert.equal(error.toString(), 'Retirada')
    assert.equal(error.fallback.reason, 'unavailable')
    assert.equal(audio.getOfficialFallback(query, error).videoId, id)
    return true
  })
})

test('fallos mixtos reintentan una única alternativa y las restricciones o respuestas impiden vídeo', async () => {
  for (const code of ['network', 'timeout', 'restricted', 'response']) {
    let final
    const audio = engine({
      searchMusic: async () => [candidate(), candidate(second), candidate(third)],
      searchVideos: async () => assert.fail('A mixed failure must not add a WEB search'),
      stream: async videoId => {
        const error = new audio.youtube.YouTubeError('Fallo ' + videoId, videoId === second ? code : 'format')
        if (videoId === second) final = error
        throw error
      },
    })
    await assert.rejects(audio.resolveTrack(query), error => {
      if (code === 'restricted' || code === 'response') {
        assert.equal(error, final)
        assert.equal(audio.getOfficialFallback(query, error), null)
        assert.equal(audio.retryEvents.length, 0)
      } else {
        assert.equal(audio.getOfficialFallback(query, error)?.videoId, id)
        assert.equal(error.originalError.code, 'format')
        assert.equal(audio.retryEvents.length, 2)
      }
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

test('fuente guardada no se sustituye por red; una selección automática retirada permite otro vídeo', async () => {
  const saved = { videoId: id, title: 'Saved', channel: 'Artist', duration: 287, score: 100, verified: true }
  let searches = 0
  const failing = engine({ stream: async () => { throw new Error('Offline') }, searchMusic: async () => { searches++; return [] } }, saved)
  await assert.rejects(() => failing.resolveTrack(query), /Offline/)
  assert.equal(searches, 0)
  const removed = engine({ searchMusic: async () => [candidate(), candidate(second)], stream: async (videoId) => {
    if (videoId === id) throw new removed.youtube.YouTubeError('Removed', 'unavailable')
    return info(videoId)
  } }, { ...saved, verified: false })
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
  assert.deepEqual(attempts, [[id, false], [id, true], [id, true], [id, true], [id, true], [id, true]])
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

const catalogAudio = { videoId: '', url: 'https://api.audius.co/v1/tracks/Ab12/stream', title: query.title,
  channel: query.artist, local: false, source: { provider: 'audius', id: 'Ab12', download: { allowed: false } } }

test('a verified recording is resolved before text search and never persisted as a YouTube source', async () => {
  const seen = [], target = { ...query, isrc: 'GBAYE9701376', titleVersion: null }
  const audio = engine({ resolveVerifiedAudio: async (track, signal) => { seen.push({ track, signal }); return catalogAudio } })
  assert.deepEqual(await audio.resolveTrack(target), catalogAudio)
  assert.equal(seen[0].track, target)
  assert.ok(seen[0].signal instanceof AbortSignal)
  assert.deepEqual(audio.calls, [])
  assert.deepEqual(audio.writes, [])
})

test('catalog rescue follows definitive YouTube rejection and retains complete recording identity', async () => {
  const seen = [], target = { ...query, isrc: 'GBAYE9701376', titleVersion: null }
  const audio = engine({ stream: async () => { throw new audio.youtube.YouTubeError('No audio', 'format') },
    resolveCatalogSource: async (track, signal) => { seen.push({ track, signal }); return catalogAudio } })
  assert.deepEqual(await audio.resolveTrack(target), catalogAudio)
  assert.equal(seen[0].track.isrc, target.isrc)
  assert.ok(seen[0].signal instanceof AbortSignal)
  assert.deepEqual(audio.calls, ['music', 'youtube'])
  assert.deepEqual(audio.writes, [])
})

test('an empty YouTube search may recover a strict catalog recording; provider failure preserves the existing fallback', async () => {
  const empty = engine({ searchMusic: async () => [], searchVideos: async () => [], resolveCatalogSource: async () => catalogAudio })
  assert.deepEqual(await empty.resolveTrack(query), catalogAudio)
  const failed = engine({ stream: async () => { throw new failed.youtube.YouTubeError('No audio', 'unavailable') },
    resolveCatalogSource: async () => { throw new Error('Catalog network failure') } })
  await assert.rejects(failed.resolveTrack(query), error => failed.getOfficialFallback(query, error)?.videoId === id)
})

test('temporary network failures and manual sources do not trigger an alternate catalog', async () => {
  for (const code of ['network', 'timeout', 'restricted']) {
    const audio = engine({ stream: async () => { throw new audio.youtube.YouTubeError('Retry later', code) },
      resolveCatalogSource: async () => assert.fail('network is not an absent recording') })
    await assert.rejects(audio.resolveTrack(query), error => error.code === code)
  }
  const saved = { videoId: id, title: query.title, channel: query.artist, duration: query.duration, score: 100, verified: true }
  const manual = engine({ stream: async () => { throw new manual.youtube.YouTubeError('Unavailable', 'format') },
    resolveVerifiedAudio: async () => assert.fail('manual choice has priority'),
    resolveCatalogSource: async () => assert.fail('manual choice has priority') }, saved)
  await assert.rejects(manual.resolveTrack(query), error => manual.getOfficialFallback(query, error)?.videoId === id)
  assert.deepEqual(manual.writes, [])
})

test('downloaded songs, podcasts and directly added videos never enter catalog rescue', async () => {
  const skip = { resolveFunkwhaleAudio: async () => assert.fail('not a catalog track'), resolveVerifiedAudio: async () => assert.fail('not a catalog track'), resolveCatalogSource: async () => assert.fail('not a catalog track') }
  const local = { ...catalogAudio, local: true, url: 'https://app.example/pletina/__audio__/1' }
  assert.deepEqual(await engine(skip, null, id, null, local).resolveTrack(query), local)
  assert.equal((await engine(skip).resolveTrack({ ...query, id: 250_000_000_000_001 })).videoId, id)
  const episode = { id: 750_000_000_000_001, audioUrl: 'https://podcast.example/episode.mp3' }
  assert.equal((await engine(skip, null, id, episode).resolveTrack({ ...query, id: episode.id })).url, episode.audioUrl)
})

test('Funkwhale follows exhausted YouTube sources before Audius or a visible video and keeps catalog identity', async () => {
  const seen = [], target = { ...query, isrc: 'GBAYE9701376', titleVersion: 'Original' }
  const source = { ...catalogAudio, source: { provider: 'funkwhale', id: 'public-upload', download: { allowed: false } } }
  const audio = engine({ stream: async () => { throw new audio.youtube.YouTubeError('No direct audio', 'format') },
    resolveFunkwhaleAudio: async (track, signal) => { seen.push({track, signal}); return source },
    resolveCatalogSource: async () => assert.fail('Funkwhale already recovered the recording') })
  assert.deepEqual(await audio.resolveTrack(target), source)
  assert.deepEqual(audio.calls, ['music', 'youtube'])
  assert.deepEqual(audio.writes, [])
  assert.equal(seen[0].track, target)
  assert.ok(seen[0].signal instanceof AbortSignal)
})

test('verified Funkwhale rescue can survive YouTube search or stream network failure without persisting absence', async () => {
  for (const phase of ['search', 'stream', 'cached']) {
    const saved = phase === 'cached' ? { videoId: id, title: query.title, channel: query.artist, duration: query.duration, score: 90, verified: false } : null
    const audio = engine({ searchMusic: async () => { if (phase === 'search') throw new Error('offline'); return [candidate()] },
      searchVideos: async () => { if (phase === 'search') throw new Error('offline'); return [] },
      stream: async () => { throw new audio.youtube.YouTubeError('YouTube down', 'network') },
      resolveFunkwhaleAudio: async () => catalogAudio }, saved)
    assert.deepEqual(await audio.resolveTrack(query), catalogAudio, phase)
    assert.deepEqual(audio.writes, [])
  }
})

test('Funkwhale does not replace working YouTube or an explicitly selected source', async () => {
  assert.equal((await engine({resolveFunkwhaleAudio: async () => assert.fail('working YouTube has priority')}).resolveTrack(query)).videoId, id)
  const saved = { videoId: id, title: query.title, channel: query.artist, duration: query.duration, score: 100, verified: true }
  for (const code of ['format', 'network']) {
    const audio = engine({ stream: async () => { throw new audio.youtube.YouTubeError('No audio', code) },
      resolveFunkwhaleAudio: async () => assert.fail('manual selection has priority') }, saved)
    await assert.rejects(audio.resolveTrack(query), error => code === 'format' ? audio.getOfficialFallback(query,error)?.videoId === id : error.code === code)
  }
})

test('a failed Funkwhale attempt preserves the original YouTube error or existing Audius rescue', async () => {
  const audio = engine({ stream: async () => { throw new audio.youtube.YouTubeError('No audio', 'unavailable') },
    resolveFunkwhaleAudio: async () => { throw new Error('Provider unavailable') }, resolveCatalogSource: async () => catalogAudio })
  assert.deepEqual(await audio.resolveTrack(query), catalogAudio)
  const offline = engine({ searchMusic: async () => { throw new Error('Original search failure') }, searchVideos: async () => [],
    resolveFunkwhaleAudio: async () => { throw new Error('Funkwhale failure') } })
  await assert.rejects(offline.resolveTrack(query), /Original search failure/)
})

test('cancellation during Funkwhale cannot return late audio and disposes its cache', async () => {
  const gate = deferred(); let signal, disposed = 0
  const audio = engine({ searchMusic: async () => [], searchVideos: async () => [],
    resolveFunkwhaleAudio: async (_track, current) => { signal = current; return gate.promise }, disposeFunkwhaleAudio: () => disposed++ })
  const pending = audio.resolveTrack(query), rejected = assert.rejects(pending, {name:'AbortError'})
  await flush()
  audio.cancelAudioRequests()
  gate.resolve(catalogAudio)
  await rejected
  assert.ok(signal.aborted)
  assert.equal(disposed, 1)
  assert.deepEqual(audio.writes, [])
})

test('changing tracks aborts obsolete acquisitions while retaining the current and prepared track', async () => {
  const gates = new Map([1,2,3].map(id=>[id,deferred()])), signals = new Map()
  const audio=engine({searchMusic:async()=>[],searchVideos:async()=>[],
    resolveFunkwhaleAudio:async(track,signal)=>{signals.set(track.id,signal);await gates.get(track.id).promise;return catalogAudio}})
  const old=audio.resolveTrack({...query,id:1}),prepared=audio.resolveTrack({...query,id:2})
  const rejected=assert.rejects(old,{name:'AbortError'})
  await flush()
  audio.retainAudioRequests([2,3])
  assert.ok(signals.get(1).aborted)
  assert.equal(signals.get(2).aborted,false)
  const current=audio.resolveTrack({...query,id:3})
  await flush()
  for(const gate of gates.values())gate.resolve()
  await rejected
  assert.deepEqual(await prepared,catalogAudio)
  assert.deepEqual(await current,catalogAudio)
})

test('player changes do not cancel downloads or share their resolution with downloaded playback of the same ID', async () => {
  const gate=deferred();let remoteSignal
  const local={...catalogAudio,local:true,url:'https://pwa.example/__audio__/1'}
  const audio=engine({searchMusic:async(_text,signal)=>{remoteSignal=signal;await gate.promise;return[candidate()]}},null,id,null,local)
  const download=audio.resolveRemoteTrack(query)
  await flush()
  assert.equal((await audio.resolveTrack(query)).url,local.url,'playback must not join a remote-download operation')
  audio.retainAudioRequests([2,3])
  assert.equal(remoteSignal.aborted,false,'unrelated player changes must not abort a download')
  gate.resolve()
  assert.equal((await download).videoId,id)
  assert.equal(remoteSignal.aborted,false)
})

test('a manual source cancels an older download and a new download waits for the pending manual choice',async()=>{
  const searchGate=deferred()
  const audio=engine({searchMusic:async()=>{await searchGate.promise;return[candidate()]}})
  const old=audio.resolveRemoteTrack(query),rejected=assert.rejects(old,{name:'AbortError'})
  await flush()
  assert.equal((await audio.chooseSource(query,second)).videoId,second)
  searchGate.resolve()
  await rejected
  assert.deepEqual(audio.writes.map(w=>[w.choice.videoId,w.choice.verified]),[[second,true]],'old download cannot overwrite the explicit association')
  const choiceGate=deferred()
  const waiting=engine({stream:async videoId=>{await choiceGate.promise;return info(videoId)},searchMusic:async()=>assert.fail('download must wait for explicit selection')})
  const selected=waiting.chooseSource(query,second)
  await flush()
  const download=waiting.resolveRemoteTrack(query)
  choiceGate.resolve()
  assert.equal((await selected).videoId,second)
  assert.equal((await download).videoId,second)
  assert.deepEqual(waiting.writes.map(w=>[w.choice.videoId,w.choice.verified]),[[second,true]])
})

test('cancelling a delayed external source prevents its completion and disposes checked blobs', async () => {
  const gate = deferred(); let disposed = 0, signal
  const audio = engine({ searchMusic: async () => [], searchVideos: async () => [],
    resolveCatalogSource: async (_track, current) => { signal = current; return gate.promise },
    disposeVerifiedAudio: () => disposed++ })
  const pending = audio.resolveTrack(query)
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  await flush()
  audio.cancelAudioRequests()
  assert.ok(signal.aborted)
  gate.resolve(catalogAudio)
  await rejected
  assert.equal(disposed, 1)
  assert.deepEqual(audio.writes, [])
})
