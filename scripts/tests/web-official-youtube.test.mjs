import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import { compileModule } from 'svelte/compiler'
import * as svelte from 'svelte/internal/client'

// Compile the production matching boundary and controller. Only provider/network
// and persistence dependencies are substituted; no iframe, YouTube or codec claim.
const source = async name => readFile(new URL('../../web-port/' + name, import.meta.url), 'utf8')
const commonJs = value => ts.transpileModule(value, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText
const [youtubeCode, audioCode, officialCode, controllerSource] = await Promise.all([
  source('youtube.ts').then(commonJs), source('audio.ts').then(commonJs),
  source('official-youtube.ts').then(commonJs), source('official-youtube.svelte.ts'),
])
const controllerCode = commonJs(compileModule(ts.transpileModule(controllerSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
}).outputText, { filename: 'official-youtube.svelte.js' }).js.code)

const videoId = 'aqz-KE-bpKQ', secondId = '9RfVp-GhKfs', thirdId = 'aaaaaaaaaaa'
const track = { id: 101, title: 'Airbag', artist: 'Radiohead', album: 'OK Computer', duration: 287 }
const alternative = (id = videoId, score = 90, extra = {}) => ({ videoId: id, title: track.title,
  artists: track.artist, album: track.album, duration: track.duration, score, origin: 'music', current: false, ...extra })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }

function harness() {
  const youtube = {}, audio = {}, official = {}, controller = {}
  const forbidden = name => () => assert.fail('Official playback must not call ' + name)
  new Function('exports', youtubeCode)(youtube)
  const storage = new Proxy({}, { get: (_target, key) => forbidden('storage.' + String(key)) })
  const requireAudio = path => path === './youtube' ? youtube : path === './storage' ? storage :
    path === './catalog-sources' ? { resolveCatalogSource: forbidden('alternate catalog resolver') } :
    path === './verified-audio' ? { resolveVerifiedAudio: forbidden('verified audio resolver'), disposeVerifiedAudio: forbidden('verified audio disposal') } :
    path === './funkwhale-audio' ? { resolveFunkwhaleAudio: forbidden('Funkwhale resolver'), disposeFunkwhaleAudio: forbidden('Funkwhale disposal') } :
    path === './podcast-audio' ? { resolvePodcastTrack: forbidden('podcast resolver') } :
      path === './download-store' ? { readDownloadedPlayable: forbidden('download read'), removeDownloadedTrack: forbidden('download removal') } :
        assert.fail('Unexpected audio import ' + path)
  new Function('exports', 'require', audioCode)(audio, requireAudio)
  const requireOfficial = path => path === './audio' ? { ...audio, alternatives: forbidden('default alternatives without an injected test provider') } :
    path === './youtube' ? youtube : path === './storage' ? storage :
      assert.fail('Unexpected official-player import ' + path)
  new Function('exports', 'require', 'navigator', officialCode)(official, requireOfficial, { onLine: true })
  new Function('exports', 'require', 'navigator', controllerCode)(controller, path => {
    if (path === './official-youtube') return official
    if (path === 'svelte/internal/client') return svelte
    assert.fail('Unexpected official-player controller import ' + path)
  }, { onLine: true })
  return { ...official, ...controller }
}

test('official playback rejects malformed metadata and non-song namespaces before provider work', async () => {
  const h = harness(), calls = []
  const invalid = [null, {}, { ...track, id: 0 }, { ...track, id: -1 }, { ...track, id: 1.5 },
    { ...track, id: NaN }, { ...track, id: Number.MAX_SAFE_INTEGER + 1 },
    { ...track, id: 500_000_000_000_000 }, { ...track, id: 1_000_000_000_000_000 },
    { ...track, title: '  ' }, { ...track, artist: '' }, { ...track, duration: Infinity }, { ...track, duration: -1 }]
  for (const value of invalid) {
    assert.throws(() => h.validateOfficialTrack(value))
    await assert.rejects(h.searchOfficialSources(value, { alternatives: async () => { calls.push(value); return [] }, online: () => true }))
  }
  assert.deepEqual(calls, [])
  const copy = h.validateOfficialTrack(track)
  assert.equal(copy.id, track.id)
  assert.equal(copy.title, track.title)
})

test('official candidates keep the existing inclusive 45-point threshold with bounded valid unique choices', () => {
  const h = harness()
  const rows = [alternative(videoId, 44, { current: true }), alternative(secondId, 45), alternative(thirdId, 80),
    alternative(thirdId, 70), alternative('bbbbbbbbbbb', 99), alternative('ccccccccccc', 60),
    alternative('<script>bad', 100), alternative('ddddddddddd', Infinity), alternative('eeeeeeeeeee', NaN),
    alternative('fffffffffff', 100, { duration: NaN }), alternative('ggggggggggg', 100, { title: '' })]
  const selected = h.filterOfficialSources(track, rows)
  assert.deepEqual(selected.map(row => row.videoId), ['bbbbbbbbbbb', thirdId, 'ccccccccccc'])
  assert.equal(selected.length, 3)
  assert.ok(selected.every(row => Number.isFinite(row.score) && row.score >= 45))
  assert.deepEqual(h.filterOfficialSources(track, [alternative(videoId, 44), alternative(secondId, 45)]).map(row => row.videoId), [secondId])
  assert.equal(rows[0].score, 44, 'The caller input must not be promoted or mutated')
})

test('official filtering excludes unsolicited karaoke without excluding an explicitly requested karaoke version', () => {
  const h = harness(), karaoke = alternative(videoId, 100, { title: 'Airbag (Karaoke)' })
  assert.deepEqual(h.filterOfficialSources(track, [karaoke, alternative(secondId)]).map(row => row.videoId), [secondId])
  assert.deepEqual(h.filterOfficialSources({ ...track, title: 'Airbag (Karaoke)' }, [karaoke]).map(row => row.videoId), [videoId])
})

test('official iframe URLs have visible controls, no autoplay and validated video and parent origin', () => {
  const h = harness()
  for (const origin of ['https://app.example', 'http://127.0.0.1:4174']) {
    const url = new URL(h.officialEmbedUrl(videoId, origin))
    assert.equal(url.protocol, 'https:'); assert.equal(url.hostname, 'www.youtube.com')
    assert.equal(url.pathname, '/embed/' + videoId)
    assert.equal(url.searchParams.get('autoplay'), '0')
    assert.equal(url.searchParams.get('controls'), '1')
    assert.equal(url.searchParams.get('playsinline'), '1')
    assert.equal(url.searchParams.get('origin'), origin)
  }
  for (const id of ['bad', videoId + '?autoplay=1', '../' + videoId, '<script>']) {
    assert.throws(() => h.officialEmbedUrl(id, 'https://app.example'))
  }
  for (const origin of ['null', 'javascript:alert(1)', 'https://user:pass@app.example', 'https://app.example/path', 'https://app.example?autoplay=1']) {
    assert.throws(() => h.officialEmbedUrl(videoId, origin))
  }
})

test('automatic iframe URLs request autoplay and preserve a bounded whole-second playback position', () => {
  const h = harness(), url = new URL(h.officialEmbedUrl(videoId, 'https://app.example', true, 47.9))
  assert.equal(url.searchParams.get('autoplay'), '1')
  assert.equal(url.searchParams.get('start'), '47')
  assert.equal(url.searchParams.get('controls'), '1')
  assert.equal(url.searchParams.get('playsinline'), '1')
  assert.equal(url.searchParams.get('origin'), 'https://app.example')
  assert.equal(new URL(h.officialEmbedUrl(videoId, 'https://app.example', true)).searchParams.has('start'), false)
  assert.equal(new URL(h.officialEmbedUrl(videoId, 'https://app.example')).searchParams.get('autoplay'), '0')
  for (const position of [-1, Infinity, NaN, 604_801, '47', null]) {
    assert.throws(() => h.officialEmbedUrl(videoId, 'https://app.example', true, position))
  }
})

test('official search resolves metadata only once and neither resolves MP4 nor persists a selected source', async () => {
  const h = harness(), calls = []
  const result = await h.searchOfficialSources(track, { online: () => true, alternatives: async (query, signal) => {
    calls.push({ query, signal }); return [alternative(videoId, 44), alternative(secondId, 80), alternative(thirdId, 70)]
  } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].query.id, track.id)
  assert.ok(calls[0].signal instanceof AbortSignal)
  assert.deepEqual(result.map(row => row.videoId), [secondId, thirdId])
  assert.ok(result.every(row => !Object.hasOwn(row, 'url')), 'No signed media source belongs in the official-player choices')
})

test('direct YouTube entries use their stored immutable video ID without catalog matching', async () => {
  const h = harness(), direct = { ...track, id: 250_000_000_000_001 }, reads = []
  const result = await h.searchOfficialSources(direct, { online: () => true,
    readYouTubeVideo: async id => { reads.push(id); return secondId }, alternatives: async () => assert.fail('Direct IDs must not search for substitutes') })
  assert.deepEqual(reads, [direct.id])
  assert.deepEqual(result.map(row => row.videoId), [secondId])
  await assert.rejects(h.searchOfficialSources(direct, { online: () => true,
    readYouTubeVideo: async () => 'https://example.org/not-a-video', alternatives: async () => assert.fail('Invalid stored IDs must not search') }))
})

test('offline and already cancelled official searches perform no provider or stored-ID reads', async () => {
  const h = harness(), calls = [], controller = new AbortController()
  const options = { alternatives: async () => { calls.push('search'); return [] }, readYouTubeVideo: async () => { calls.push('read'); return videoId } }
  controller.abort()
  await assert.rejects(h.searchOfficialSources(track, { ...options, online: () => false }))
  await assert.rejects(h.searchOfficialSources({ ...track, id: 250_000_000_000_001 }, { ...options, online: () => false }))
  await assert.rejects(h.searchOfficialSources(track, { ...options, online: () => true, signal: controller.signal }), { name: 'AbortError' })
  assert.deepEqual(calls, [])
})

test('the official search deadline aborts the real provider signal and cannot leave a hung promise', async () => {
  const h = harness(), never = deferred()
  let providerSignal
  await assert.rejects(h.searchOfficialSources(track, { online: () => true, timeout: 20,
    alternatives: async (_query, signal) => { providerSignal = signal; return never.promise } }))
  assert.ok(providerSignal instanceof AbortSignal)
  assert.equal(providerSignal.aborted, true)
  never.resolve([alternative()])
  await flush()
})

test('cancelling a pending official search rejects even when a provider ignores its signal', async () => {
  const h = harness(), pending = deferred(), controller = new AbortController()
  let providerSignal
  const operation = h.searchOfficialSources(track, { online: () => true, signal: controller.signal,
    alternatives: async (_query, signal) => { providerSignal = signal; return pending.promise } })
  const cancelled = assert.rejects(operation, { name: 'AbortError' })
  await flush(); controller.abort(); await cancelled
  assert.equal(providerSignal.aborted, true)
  pending.resolve([alternative()]); await flush()
})

test('controller opening presents choices without auto-selecting and only permits an explicit eligible ID', async () => {
  const h = harness(), c = h.createOfficialYouTubeController({ online: () => true, alternatives: async () => [alternative(), alternative(secondId, 70)] })
  try {
    c.open(track); await flush()
    assert.equal(c.automatic, false); assert.equal(c.startAt, 0)
    assert.equal(c.opened, true); assert.equal(c.status, 'ready'); assert.equal(c.selected, null)
    assert.equal(c.select('not-valid'), false)
    assert.equal(c.select(thirdId), false, 'A valid but unoffered ID cannot enter the iframe')
    assert.equal(c.selected, null)
    assert.equal(c.select(secondId), true)
    assert.equal(c.selected.videoId, secondId)
    assert.equal(c.track.id, track.id)
    assert.equal(c.sources.length, 2)
    c.close()
    assert.equal(c.opened, false); assert.equal(c.selected, null); assert.equal(c.track, null)
  } finally { c.close() }
})

test('automatic opening selects a prepared source synchronously without a provider query or persistence', () => {
  const h = harness(), calls = [], c = h.createOfficialYouTubeController({ online: () => true,
    alternatives: async () => { calls.push('search'); return [] } })
  const prepared = alternative(videoId, 45, { title: '  Airbag  ', url: 'https://attacker.example/not-the-iframe' })
  try {
    assert.equal(c.openAutomatic(track, prepared, 47.9), true)
    assert.equal(c.opened, true); assert.equal(c.automatic, true); assert.equal(c.status, 'ready')
    assert.equal(c.error, null); assert.equal(c.track.id, track.id); assert.equal(c.startAt, 47)
    assert.equal(c.selected.videoId, videoId); assert.equal(c.selected.title, 'Airbag')
    assert.deepEqual(c.sources.map(row => row.videoId), [videoId])
    assert.equal(Object.hasOwn(c.selected, 'url'), false)
    prepared.videoId = secondId
    assert.equal(c.selected.videoId, videoId, 'A later mutation of the prepared source cannot replace the selected video')
    assert.deepEqual(calls, [])
    c.close()
    assert.equal(c.opened, false); assert.equal(c.automatic, false); assert.equal(c.selected, null)
    assert.equal(c.startAt, 0); assert.equal(c.status, 'idle'); assert.equal(c.track, null)
  } finally { c.close() }
})

test('automatic opening rejects malformed or low-scoring prepared sources without fallback searching', () => {
  const h = harness(), c = h.createOfficialYouTubeController({ online: () => true,
    alternatives: async () => assert.fail('An invalid prepared source must not trigger another query') })
  const invalid = [null, {}, alternative('../' + videoId), alternative(videoId, 44),
    alternative(videoId, Infinity), alternative(videoId, 100, { title: 'Airbag (Karaoke)' }),
    alternative(videoId, 90, { duration: NaN }), alternative(videoId, 90, { origin: 'external' })]
  try {
    for (const value of invalid) {
      assert.equal(c.openAutomatic(track, alternative()), true)
      assert.equal(c.openAutomatic(track, value), false)
      assert.equal(c.opened, false); assert.equal(c.automatic, false); assert.equal(c.status, 'idle')
      assert.equal(c.track, null); assert.equal(c.selected, null); assert.equal(c.sources.length, 0)
    }
    for (const startAt of [-1, Infinity, NaN, 604_801, '47', null]) {
      assert.equal(c.openAutomatic(track, alternative(), startAt), false)
      assert.equal(c.opened, false); assert.equal(c.startAt, 0)
    }
    assert.equal(c.openAutomatic({ ...track, id: 500_000_000_000_000 }, alternative()), false)
    assert.equal(c.opened, false)
  } finally { c.close() }
})

test('automatic opening preserves an explicitly selected karaoke source without admitting an unsolicited substitute', () => {
  const h = harness(), c = h.createOfficialYouTubeController({ online: () => true,
    alternatives: async () => assert.fail('An explicit version must not trigger another query') })
  const selected = alternative(videoId, 45, { title: 'Airbag (Karaoke)', current: true })
  try {
    assert.equal(c.openAutomatic(track, selected), true)
    assert.equal(c.selected.videoId, videoId); assert.equal(c.selected.current, true)
    assert.equal(c.selected.title, selected.title)
    assert.deepEqual(h.filterOfficialSources(track, [selected]), [], 'Manual discovery must still reject unsolicited karaoke')
    assert.equal(c.openAutomatic(track, { ...selected, current: false }), false)
    assert.equal(c.openAutomatic(track, { ...selected, current: 'true' }), false)
    assert.equal(c.openAutomatic(track, { ...selected, score: 44 }), false, 'Explicit choice does not lower the score boundary')
  } finally { c.close() }
})

test('automatic opening cancels a previous manual search and ignores late results or rejection', async () => {
  for (const rejectOld of [false, true]) {
    const h = harness(), pending = deferred(), calls = []
    const c = h.createOfficialYouTubeController({ online: () => true, alternatives: async (query, signal) => {
      calls.push({ id: query.id, signal }); return pending.promise
    } })
    try {
      c.open(track); await flush()
      assert.equal(c.status, 'loading')
      assert.equal(c.openAutomatic({ ...track, id: 102, title: 'Second track' }, alternative(secondId), 30), true)
      assert.equal(calls[0].signal.aborted, true)
      if (rejectOld) pending.reject(new Error('Obsolete search failed'))
      else pending.resolve([alternative(thirdId)])
      await flush()
      assert.equal(calls.length, 1)
      assert.equal(c.track.id, 102); assert.equal(c.automatic, true); assert.equal(c.status, 'ready')
      assert.equal(c.selected.videoId, secondId); assert.equal(c.startAt, 30); assert.equal(c.error, null)
      c.close(); await flush()
      assert.equal(c.opened, false); assert.equal(c.selected, null); assert.equal(c.status, 'idle')
    } finally { c.close() }
  }
})

test('a later manual opening restores explicit choice without retaining automatic playback or its position', async () => {
  const h = harness(), pending = deferred(), c = h.createOfficialYouTubeController({ online: () => true,
    alternatives: async () => pending.promise })
  try {
    assert.equal(c.openAutomatic(track, alternative(), 47), true)
    c.open({ ...track, id: 102 })
    assert.equal(c.automatic, false); assert.equal(c.startAt, 0); assert.equal(c.selected, null)
    assert.equal(c.status, 'loading')
    pending.resolve([alternative(secondId)]); await flush()
    assert.equal(c.automatic, false); assert.equal(c.status, 'ready'); assert.equal(c.selected, null)
    assert.equal(c.select(secondId), true)
  } finally { c.close() }
})

test('the application automatic entry point exposes only a validated ready selection', () => {
  const h = harness()
  try {
    assert.equal(h.openAutomaticOfficialYouTube(track, alternative(secondId), 12.9), true)
    assert.equal(h.officialYouTube.selected.videoId, secondId)
    assert.equal(h.officialYouTube.automatic, true); assert.equal(h.officialYouTube.startAt, 12)
  } finally { h.closeOfficialYouTube() }
})

test('closing during official search aborts it and a late completion cannot reopen or select a video', async () => {
  const h = harness(), pending = deferred()
  let signal
  const c = new h.OfficialYouTubeController({ online: () => true,
    alternatives: async (_track, current) => { signal = current; return pending.promise } })
  c.open(track); await flush()
  assert.equal(c.status, 'loading')
  c.close()
  assert.equal(signal.aborted, true)
  pending.resolve([alternative()]); await flush()
  assert.equal(c.opened, false); assert.equal(c.status, 'idle'); assert.equal(c.track, null)
  assert.equal(c.sources.length, 0); assert.equal(c.selected, null)
})

test('opening another song aborts stale work and ignores both late results and late rejection', async () => {
  for (const rejectOld of [false, true]) {
    const h = harness(), pending = deferred(), calls = []
    const c = h.createOfficialYouTubeController({ online: () => true, alternatives: async (query, signal) => {
      calls.push({ id: query.id, signal }); return query.id === track.id ? pending.promise : [alternative(secondId)]
    } })
    try {
      c.open(track); await flush()
      c.open({ ...track, id: 102, title: 'Second track' }); await flush()
      assert.equal(calls[0].signal.aborted, true)
      if (rejectOld) pending.reject(new Error('Obsolete provider failure'))
      else pending.resolve([alternative()])
      await flush()
      assert.equal(c.track.id, 102); assert.equal(c.status, 'ready'); assert.equal(c.error, null)
      assert.deepEqual(c.sources.map(row => row.videoId), [secondId]); assert.equal(c.selected, null)
    } finally { c.close() }
  }
})

test('official retry starts a new bounded attempt without retaining the earlier selection', async () => {
  const h = harness(), calls = []
  const c = h.createOfficialYouTubeController({ online: () => true, alternatives: async (_query, signal) => {
    calls.push(signal)
    if (calls.length === 1) throw new Error('Fixture unavailable')
    return [alternative(secondId)]
  } })
  try {
    c.open(track); await flush()
    assert.equal(c.status, 'error'); assert.ok(c.error); assert.equal(c.selected, null)
    c.retry(); await flush()
    assert.equal(calls.length, 2); assert.notEqual(calls[0], calls[1])
    assert.equal(c.status, 'ready'); assert.equal(c.error, null); assert.equal(c.selected, null)
    assert.equal(c.select(secondId), true)
    c.retry(); await flush()
    assert.equal(c.selected, null, 'Retry cannot autoplay a prior selection')
  } finally { c.close() }
})
