// Real compiled UI integration. Provider/catalog bodies and media are never mocked.
// --scenario smoke|queue|cancel injects failed YouTube network requests to reach
// the fallback; --scenario natural changes no network responses. Desktop QA only.
// node scripts/tests/funkwhale-rescue-live.browser.mjs --expected-build HASH
//   [--case cylinder|melted|nin] [--scenario smoke|queue|cancel|natural]
//   [--url https://host/pletina/] [--report safe-name.json] [--chrome executable]
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'
import { createPwaServer } from '../preview-pwa.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const cases = {
  cylinder: { id: 2934405891, title: 'Cylinder Six', artist: 'Chris Zabriskie', album: 'Cylinders', isrc: 'GBKPL1370800', duration: 105.64,
    bytes: 4441693, mime: 'audio/mpeg', sha256: '95d4d22ad284ffd07c3df0d80a92afb699da3d98d9c1202d4006ba50cff67e35' },
  melted: { id: 2988892451, title: 'Melted Wings', artist: 'Kai Engel', album: 'Written in Ink', isrc: 'GBSMU2086183', duration: 133.333333,
    bytes: 5527791, mime: 'audio/mpeg', sha256: 'decbd6a2fd02f3d9bb48f35e02df8c0642155bf095fb1bda1b4159157ec7f802' },
  nin: { id: 57428851, title: '36 Ghosts IV', artist: 'Nine Inch Nails', album: 'Ghosts I-IV', isrc: 'USTC40852265', duration: 139.0439,
    bytes: 1740870, mime: 'audio/ogg', sha256: '00c641b9102dcfbd1b1c2f12f7b99ad6fee7af0bf0a3c947359cd07547d7caf7' },
}
const caseName = option('--case', 'cylinder'), scenario = option('--scenario', 'smoke')
assert.ok(Object.hasOwn(cases, caseName), 'Known canonical recording')
assert.ok(['smoke', 'queue', 'cancel', 'natural'].includes(scenario), 'Known integration scenario')
const song = cases[caseName], second = caseName === 'melted' ? cases.cylinder : cases.melted
const describe = {
  scenarios: {
    smoke: 'Real catalog + one title click -> real Funkwhale full-file SHA -> seek -> desktop hidden tab -> navigation.',
    queue: 'Smoke plus add a different canonical song through its real menu, prepare it, reach real ended hidden/offline and play the next blob.',
    cancel: 'Hold first real Funkwhale media request temporarily, select a different song through UI, release old request, reject stale playback.',
    natural: 'No injected network failures: records whether ordinary YouTube or Funkwhale wins; passing does not imply Funkwhale was reached.',
  },
  cases, limitations: ['Desktop Chrome is not an Android/iPhone or screen-off test.', 'Chrome Ogg support cannot establish iOS compatibility.',
    'Known file hashes verify bytes, while source identity evidence covers an official excerpt, not an independently verified whole master.',
    'Cancellation checks stale-playback suppression; transport abort is observed separately, never inferred.'],
}
if (args.includes('--describe')) { console.log(JSON.stringify(describe, null, 2)); process.exit(0) }
const expectedBuild = option('--expected-build', null)
assert.match(expectedBuild ?? '', /^[a-f0-9]{16}$/, 'Explicit freshly compiled build required')
const reportName = option('--report', `funkwhale-rescue-live-${expectedBuild}-${caseName}-${scenario}.json`)
assert.match(reportName, /^[a-z0-9.-]+\.json$/i)
const directory = new URL('../../artifacts/pwa-port/', import.meta.url)
await mkdir(directory, { recursive: true })
const scrub = value => String(value ?? '').replace(/(?:https?|blob):[^\s"'<>]+/g, '[URL]').slice(0, 500)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const report = { schemaVersion: 1, testedAt: new Date().toISOString(), expectedBuild, build: null, caseName, scenario,
  expectedRecording: song, secondRecording: ['queue', 'cancel'].includes(scenario) ? second : null,
  execution: { scriptSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex') },
  scope: describe.scenarios[scenario], limitations: describe.limitations,
  checks: [], errors: [], network: [], inputActions: [], primarySongClicks: 0, sourceMenuClicks: 0, iframePlaybackClicks: 0,
  browserSecurityOverrides: false, backgroundThrottleOverrides: false, outputMuted: false, providerResponsesMocked: false,
  observationRpcCalls: 0, observationRpcWithGesture: 0, mediaFilesWritten: false, mediaUrlsPersisted: false,
  physicalAndroidVerified: false, physicalIPhoneVerified: false, installedPwaVerified: false, phoneScreenOffVerified: false,
  wholeMasterIndependentlyVerified: false,
  faultInjection: { youtubeNetworkFailure: scenario !== 'natural', heldFunkwhaleRequest: scenario === 'cancel', offlineForPreparedQueue: false },
}
let server, browser, page, background, terminalError, heldRequest, holdArmed = scenario === 'cancel', holdReleased = false, holdTimer

function observeAudio() {
  const audios = [], events = [], blobs = new Map(), NativeAudio = Audio, create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL)
  let sequence = 0
  URL.createObjectURL = blob => {
    const url = create(blob)
    if (blob instanceof Blob) {
      const value = { key: ++sequence, bytes: blob.size, mime: blob.type, sha256: null, revoked: false }
      blobs.set(url, value)
      void blob.arrayBuffer().then(bytes => crypto.subtle.digest('SHA-256', bytes)).then(hash => {
        value.sha256 = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('')
      }).catch(() => { value.hashError = true })
    }
    return url
  }
  URL.revokeObjectURL = url => { const blob = blobs.get(url); if (blob) blob.revoked = true; return revoke(url) }
  const current = () => {
    try {
      const queue = JSON.parse(localStorage.getItem('pletina:web:queue:v1') ?? 'null')
      const item = queue?.manual ?? queue?.queue?.[queue?.order?.[queue?.pos]]
      return { item: item ? { id: item.track.id, title: item.track.title, artist: item.track.artist.name, album: item.albumTitle, isrc: item.track.isrc ?? null } : null,
        repeat: queue?.repeat ?? null, userQueue: (queue?.userQueue ?? []).map(row => row.item?.track?.id ?? row.track?.id ?? null) }
    } catch { return { item: null, repeat: null, userQueue: [] } }
  }
  const audioState = (audio, index) => {
    const source = audio.currentSrc || audio.src
    return { index, sourceKind: source.startsWith('blob:') ? 'blob' : source.startsWith('https:') ? 'https' : source ? 'other' : 'empty',
      blob: blobs.get(source) ?? null, currentTime: Number.isFinite(audio.currentTime) ? Number(audio.currentTime.toFixed(3)) : null,
      duration: Number.isFinite(audio.duration) ? Number(audio.duration.toFixed(3)) : null,
      paused: audio.paused, ended: audio.ended, muted: audio.muted, volume: audio.volume, error: audio.error?.code ?? null }
  }
  let Wrapped
  Wrapped = new Proxy(NativeAudio, { construct(target, args, newTarget) {
    const audio = Reflect.construct(target, args, newTarget === Wrapped ? target : newTarget), index = audios.push(audio) - 1
    for (const type of ['loadstart', 'loadedmetadata', 'playing', 'pause', 'ended', 'seeking', 'seeked', 'error']) audio.addEventListener(type, () => {
      events.push({ type, at: Math.round(performance.now()), hidden: document.hidden, canonicalId: current().item?.id, ...audioState(audio, index) })
      if (events.length > 400) events.shift()
    })
    return audio
  } })
  window.Audio = Wrapped
  window.__funkwhaleIntegrationObserver = { snapshot() {
    const queue = current(), test = document.createElement('audio')
    return { audio: audios.map(audioState), events: events.slice(), blobs: [...blobs.values()].map(blob => ({ ...blob })), current: queue.item,
      repeat: queue.repeat, userQueue: queue.userQueue, hidden: document.hidden, online: navigator.onLine,
      codecs: { mp3: test.canPlayType('audio/mpeg'), oggVorbis: test.canPlayType('audio/ogg; codecs="vorbis"'), oggOpus: test.canPlayType('audio/ogg; codecs="opus"') },
      videoIframeCount: [...document.querySelectorAll('iframe')].filter(frame => /youtube(?:-nocookie)?\.com\/embed\//.test(frame.src)).length,
      tabs: [...document.querySelectorAll('.bottom-nav button')].map(button => button.textContent.trim()),
      mediaSession: navigator.mediaSession ? { title: navigator.mediaSession.metadata?.title ?? null, artist: navigator.mediaSession.metadata?.artist ?? null, playbackState: navigator.mediaSession.playbackState } : null,
      nowPlayingOpen: !!document.querySelector('.np[role="dialog"]'), searchValue: document.querySelector('input[aria-label="Buscar música"]')?.value ?? null,
      notices: [...document.querySelectorAll('.notice,[role="alert"]')].map(node => node.textContent.trim()).slice(0, 4) }
  } }
}

async function read(fn, value = null) {
  report.observationRpcCalls++
  const context = page.mainFrame().mainRealm().context
  const response = await page.mainFrame().client.send('Runtime.callFunctionOn', { executionContextId: context.id,
    functionDeclaration: fn.toString(), arguments: [{ value }], awaitPromise: true, returnByValue: true, userGesture: false })
  if (response.exceptionDetails) throw new Error(scrub(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text))
  return response.result.value
}
const snapshot = () => read(() => window.__funkwhaleIntegrationObserver.snapshot())
const active = state => state.audio.find(audio => !audio.paused && !audio.error && audio.sourceKind !== 'empty')
const persist = () => writeFile(new URL(reportName, directory), JSON.stringify(report, null, 2) + '\n')
async function poll(label, action, timeout = 20000) {
  const start = Date.now(); let last
  while (Date.now() - start < timeout) {
    try { const value = await action(); if (value) return value } catch (error) { last = scrub(error.message) }
    await delay(200)
  }
  throw new Error(label + ' timed out' + (last ? ': ' + last : ''))
}
async function check(name, action) {
  process.stdout.write(name + ' ... ')
  try { const result = await action(); report.checks.push({ name, pass: true, ...result }); process.stdout.write('passed\n'); return result }
  catch (error) { report.checks.push({ name, pass: false, error: scrub(error.message), state: page ? await snapshot().catch(() => null) : null }); process.stdout.write('FAILED\n'); throw error }
  finally { await persist() }
}
async function click(selector, purpose, fraction = 0.5) {
  const point = await read(({ selector, fraction }) => {
    const element = document.querySelector(selector)
    if (!element) return null
    element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
    const rect = element.getBoundingClientRect(), x = rect.left + rect.width * fraction, y = rect.top + rect.height / 2, hit = document.elementFromPoint(x, y)
    return rect.width && rect.height && x >= 0 && x < innerWidth && y >= 0 && y < innerHeight && hit && (hit === element || element.contains(hit)) ? { x, y } : null
  }, { selector, fraction })
  assert.ok(point, 'Visible unobstructed UI: ' + purpose)
  report.inputActions.push({ action: 'trusted mouse click', purpose })
  await page.mouse.click(point.x, point.y)
}
const offline = value => page.mainFrame().client.send('Network.emulateNetworkConditions', { offline: value, latency: 0, downloadThroughput: value ? 0 : -1, uploadThroughput: value ? 0 : -1 })
function assertCanonical(state, expected) {
  assert.equal(state.current?.id, expected.id, 'Exact canonical catalog ID')
  assert.equal(state.current.title, expected.title); assert.equal(state.current.artist, expected.artist); assert.equal(state.current.album, expected.album)
  if (state.current.isrc) assert.equal(state.current.isrc.replaceAll('-', '').toUpperCase(), expected.isrc)
  assert.equal(state.mediaSession?.title, expected.title)
  assert.equal(state.videoIframeCount, 0, 'No video fallback')
  assert.equal(state.audio.length, 1, 'PWA retains its single Audio element')
  assert.ok(state.audio.filter(audio => !audio.paused).length <= 1, 'At most one playing Audio output')
}
function assertRescue(state, expected) {
  assertCanonical(state, expected)
  const audio = active(state)
  assert.ok(audio, 'Unpaused error-free native Audio')
  assert.equal(audio.sourceKind, 'blob'); assert.equal(audio.blob?.bytes, expected.bytes); assert.equal(audio.blob.sha256, expected.sha256)
  assert.equal(audio.muted, false); assert.ok(audio.volume > 0)
  assert.ok(Math.abs(audio.duration - expected.duration) <= 2, 'Full duration rather than the reference preview')
  return audio
}
async function search(expected) {
  const state = await snapshot()
  if (state.nowPlayingOpen) await click('.np button[title="Cerrar (Esc)"]', 'close Sonando ahora')
  await click('.bottom-nav button:nth-child(2)', 'open Buscar')
  await poll('Music search input', () => read(() => !!document.querySelector('input[aria-label="Buscar música"]')))
  await read(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await click('input[aria-label="Buscar música"]', 'focus catalog search')
  await page.keyboard.press('Control+A'); await page.keyboard.type(expected.title)
  return await poll('Exact title, artist and album row', () => read(expected => {
    const rows = [...document.querySelectorAll('.tracks li[data-reorder-index]')]
    const row = rows.find(row => row.querySelector('.name')?.textContent.trim() === expected.title && row.querySelector('.by')?.textContent.trim() === expected.artist && row.querySelector('.album button')?.textContent.trim() === expected.album)
    return row ? { index: row.dataset.reorderIndex, title: expected.title, artist: expected.artist, album: expected.album } : null
  }, expected), 45000)
}
async function titleClick(selection, purpose) {
  await click(`.tracks li[data-reorder-index="${selection.index}"] .name`, purpose)
  report.primarySongClicks++
}
async function awaitPlayback(expected, requireRescue = true) {
  let anchor
  return await poll('Native Audio advances without an extra playback click', async () => {
    const state = await snapshot(), audio = active(state)
    if (state.videoIframeCount) throw new Error('Video fallback appeared')
    if (state.current?.id !== expected.id || !audio || audio.currentTime < 0.1 || requireRescue && audio.blob?.sha256 !== expected.sha256) return null
    if (!anchor || anchor.key !== audio.blob?.key) anchor = { key: audio.blob?.key, time: audio.currentTime, wall: Date.now() }
    if (audio.currentTime - anchor.time < 2 || Date.now() - anchor.wall < 1800) return null
    if (requireRescue) assertRescue(state, expected); else assertCanonical(state, expected)
    return state
  }, 125000)
}
async function openNowPlaying() {
  if (!(await snapshot()).nowPlayingOpen) await click('.mini .open', 'open Sonando ahora')
  await poll('Now Playing dialog', async () => (await snapshot()).nowPlayingOpen)
}
async function releaseHeld(reason) {
  if (!heldRequest || holdReleased) return
  holdReleased = true; clearTimeout(holdTimer)
  report.heldRequest.releasedAt = Date.now(); report.heldRequest.releaseReason = reason
  await heldRequest.continue().catch(error => { report.heldRequest.releaseError = scrub(error.message) })
}

try {
  let url = option('--url', null)
  if (!url) {
    server = createPwaServer()
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    url = `http://127.0.0.1:${server.address().port}/pletina/`
  } else assert.equal(new URL(url).protocol, 'https:')
  report.target = { origin: new URL(url).origin, path: new URL(url).pathname, temporaryStaticQaPreview: !!server }
  browser = await puppeteer.launch({ headless: true, executablePath: option('--chrome', 'C:/Users/iunan/.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe'),
    ignoreDefaultArgs: ['--mute-audio', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], args: [], protocolTimeout: 180000 })
  report.browser = await browser.version()
  page = await browser.newPage()
  await page.setViewport({ width: 393, height: 852, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
  await page.evaluateOnNewDocument(observeAudio)
  page.on('pageerror', error => report.errors.push({ name: error.name, message: scrub(error.message) }))
  await page.setRequestInterception(true)
  page.on('request', request => {
    const url = new URL(request.url())
    if (scenario !== 'natural' && /^(?:www\.youtube\.com|music\.youtube\.com|youtubei\.googleapis\.com|youtube\.googleapis\.com)$/.test(url.hostname)) {
      report.network.push({ at: Date.now(), host: url.hostname, kind: 'youtube', injectedFailure: 'failed' })
      void request.abort('failed').catch(() => {}); return
    }
    if (holdArmed && url.hostname === 'open.audio' && /^\/api\/v2\/listen\//.test(url.pathname)) {
      holdArmed = false; heldRequest = request
      report.heldRequest = { at: Date.now(), host: url.hostname, kind: 'real provider media temporarily delayed; body unchanged' }
      holdTimer = setTimeout(() => { void releaseHeld('bounded 30000ms timeout') }, 30000)
      return
    }
    void request.continue().catch(() => {})
  })
  page.on('requestfailed', request => {
    const url = new URL(request.url())
    if (url.hostname === 'open.audio' || url.hostname.endsWith('.wasabisys.com')) report.network.push({ at: Date.now(), host: url.hostname, kind: 'provider', failure: scrub(request.failure()?.errorText) })
  })
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.hostname === 'open.audio' || url.hostname.endsWith('.wasabisys.com') || url.hostname === 'api.audius.co') report.network.push({ at: Date.now(), host: url.hostname,
      kind: /\/listen\//.test(url.pathname) || /^audio\//.test(response.headers()['content-type'] ?? '') ? 'media' : 'metadata', status: response.status(), mime: response.headers()['content-type']?.split(';')[0] ?? null })
  })
  await check('expected compiled launcher opens through the normal control', async () => {
    await page.goto(url, { waitUntil: 'load', timeout: 30000 })
    await poll('Service worker control', () => read(() => !!navigator.serviceWorker.controller), 30000)
    report.build = await read(() => document.querySelector('#version')?.textContent.trim() ?? null)
    assert.equal(report.build, expectedBuild)
    const activation = await read(() => ({ active: navigator.userActivation.isActive, ever: navigator.userActivation.hasBeenActive }))
    assert.equal(activation.ever, false)
    await click('#open-player', 'open the music app')
    await poll('Four mobile tabs', () => read(() => document.querySelectorAll('.bottom-nav button').length === 4), 30000)
    return { activationBeforeInput: activation, codecs: (await snapshot()).codecs }
  })
  await check('exact canonical row is selected once through its title', async () => {
    const selected = await search(song)
    await titleClick(selected, 'play the exact recording with one title click')
    return { selected, primarySongClicks: report.primarySongClicks }
  })
  if (scenario === 'cancel') {
    await check('a pending real media load is superseded through ordinary search and title selection', async () => {
      await poll('First actual Funkwhale media request held', () => heldRequest, 60000)
      const firstState = await snapshot()
      assert.equal(firstState.current?.id, song.id); assert.equal(active(firstState), undefined)
      const selected = await search(second)
      await titleClick(selected, 'replace the loading recording with a different exact song')
      await poll('New canonical item current', async () => (await snapshot()).current?.id === second.id)
      await releaseHeld('different song selected through UI')
      return { firstState, selected, heldRequest: report.heldRequest }
    })
    await check('only the replacement recording starts and advances', async () => ({ state: await awaitPlayback(second) }))
    await check('late completion never replaces or plays over the new recording', async () => {
      const before = await snapshot(), time = assertRescue(before, second).currentTime
      await delay(12000)
      const after = await snapshot(); assertRescue(after, second)
      assert.ok(active(after).currentTime >= time + 10)
      const obsolete = after.blobs.filter(blob => blob.sha256 === song.sha256).map(blob => blob.key)
      assert.equal(after.events.some(event => event.type === 'playing' && obsolete.includes(event.blob?.key)), false, 'Obsolete checked blob never played')
      return { state: after, stalePlaybackSuppressed: true, obsoleteBlobCreated: obsolete.length > 0,
        transportAbortObserved: report.network.some(row => row.kind === 'provider' && row.failure?.includes('ABORTED')) }
    })
  } else {
    await check(scenario === 'natural' ? 'natural source selection advances and records whether Funkwhale was actually used' : 'the single title click starts the exact checked Funkwhale bytes without video', async () => {
      const state = await awaitPlayback(song, scenario !== 'natural')
      report.funkwhaleReached = active(state)?.blob?.sha256 === song.sha256
      if (scenario !== 'natural') assert.ok(report.network.some(row => row.injectedFailure), 'Deliberate YouTube outage occurred')
      return { state, funkwhaleReached: report.funkwhaleReached, noSecondPlaybackClick: true }
    })
    await check('visible seek reaches the middle of the same recording', async () => {
      await openNowPlaying(); const before = await snapshot(), key = active(before)?.blob?.key
      await click('.np input[aria-label="Posición"]', 'seek through the visible progress bar')
      const state = await poll('Mid-recording seek', async () => {
        const state = await snapshot(), audio = active(state)
        return audio && audio.currentTime >= audio.duration * .4 && audio.currentTime <= audio.duration * .6 ? state : null
      })
      if (scenario !== 'natural') assertRescue(state, song); else assertCanonical(state, song)
      assert.equal(active(state).blob?.key, key)
      return { state }
    })
    await check('the same unmuted recording advances for ten seconds in a real hidden desktop tab', async () => {
      const before = await snapshot(), time = active(before).currentTime, mediaRequests = report.network.filter(row => row.kind === 'media').length
      background = await browser.newPage(); await background.goto('about:blank'); await background.bringToFront()
      await poll('Page is genuinely hidden', async () => (await snapshot()).hidden)
      await delay(10500)
      const after = await snapshot()
      if (scenario !== 'natural') assertRescue(after, song); else assertCanonical(after, song)
      assert.equal(after.hidden, true); assert.ok(active(after).currentTime >= time + 9)
      await page.bringToFront(); await background.close(); background = null
      return { state: after, hiddenWaitMs: 10500, mediaRequestsAdded: report.network.filter(row => row.kind === 'media').length - mediaRequests, phoneClaimed: false }
    })
    await check('album Back and Home preserve navigation and audio', async () => {
      await click('.np .from button.link', 'open the playing recording album')
      await poll('Album Back control', () => read(() => !!document.querySelector('.topbar button[title="Atrás"]')))
      const time = active(await snapshot()).currentTime
      await click('.topbar button[title="Atrás"]', 'return through app Back')
      await click('.bottom-nav button:nth-child(1)', 'go to Inicio')
      await delay(1200)
      const state = await snapshot()
      assertCanonical(state, song); assert.deepEqual(state.tabs, ['Inicio', 'Buscar', 'Podcasts', 'Tu biblioteca']); assert.ok(active(state)?.currentTime > time)
      return { state, hardwareBackClaimed: false }
    })
    if (scenario === 'queue') {
      await check('a different exact recording is added through its real queue menu', async () => {
        // Give the real network a whole track of preparation time, independent
        // of how long the earlier hidden/seek/navigation checks took.
        await openNowPlaying()
        await click('.np input[aria-label="Posición"]', 'seek near the start before preparing a different queued recording', .05)
        await poll('Playback near start', async () => { const state = await snapshot(), audio = active(state); return audio && audio.currentTime < audio.duration * .12 ? state : null })
        const selected = await search(second)
        await click(`.tracks li[data-reorder-index="${selected.index}"] button[title="Más opciones"]`, 'open the different recording menu')
        const menuSelector = await poll('Reproducir a continuación menu entry', () => read(() => {
          const buttons = [...document.querySelectorAll('[role="menu"] button, .context-menu button, .menu button')]
          const index = buttons.findIndex(button => button.textContent.trim() === 'Reproducir a continuación')
          return index < 0 ? null : { index, selector: '[role="menu"] button, .context-menu button, .menu button' }
        }))
        const point = await read(({ selector, index }) => {
          const element = [...document.querySelectorAll(selector)][index], rect = element.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2, hit = document.elementFromPoint(x, y)
          return element === hit || element.contains(hit) ? { x, y } : null
        }, menuSelector)
        assert.ok(point); report.inputActions.push({ action: 'trusted mouse click', purpose: 'Reproducir a continuación' }); await page.mouse.click(point.x, point.y)
        await poll('Different canonical song entered user queue', async () => (await snapshot()).userQueue.includes(second.id))
        assertCanonical(await snapshot(), song)
        return { selected, menuAction: 'Reproducir a continuación', sourceMenuWasNotUsed: true }
      })
      await check('the next real recording is prepared while the first keeps playing', async () => {
        const state = await poll('Second full checked Blob ready', async () => { const state = await snapshot(); return state.blobs.some(blob => blob.sha256 === second.sha256 && !blob.revoked) ? state : null }, 125000)
        assertRescue(state, song)
        return { state }
      })
      await check('real ended starts the different prepared recording while hidden and offline', async () => {
        await openNowPlaying()
        const before = await snapshot(), mediaRequests = report.network.filter(row => row.kind === 'media').length
        await click('.np input[aria-label="Posición"]', 'focus seek for real ended acceleration')
        await page.keyboard.press('End'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Tab')
        await poll('First recording near end', async () => { const state = await snapshot(), audio = active(state); return audio && audio.duration - audio.currentTime < 4 ? state : null })
        await offline(true); report.faultInjection.offlineForPreparedQueue = true
        background = await browser.newPage(); await background.goto('about:blank'); await background.bringToFront()
        await poll('Hidden before transition', async () => (await snapshot()).hidden)
        await delay(10500)
        const after = await snapshot(); assertRescue(after, second)
        assert.equal(after.hidden, true); assert.equal(after.online, false)
        const events = after.events.filter(event => event.at > (before.events.at(-1)?.at ?? 0))
        assert.ok(events.some(event => event.type === 'ended' && event.hidden))
        assert.ok(events.some(event => event.type === 'playing' && event.hidden && event.canonicalId === second.id))
        assert.ok(active(after).currentTime >= 4)
        assert.equal(report.network.filter(row => row.kind === 'media').length, mediaRequests)
        await page.bringToFront(); await background.close(); background = null; await offline(false)
        return { state: after, preparationUsesRealProvider: true, phoneOrScreenOffClaimed: false }
      })
    }
  }
} catch (error) { terminalError = error; report.errors.push({ kind: 'terminal', message: scrub(error.message) }) }
finally {
  await releaseHeld('test cleanup')
  clearTimeout(holdTimer)
  if (page && !page.isClosed()) report.finalState = await snapshot().catch(() => null)
  await background?.close().catch(() => {})
  await browser?.close()
  if (server) await new Promise(resolve => server.close(resolve))
  report.pass = !terminalError && report.checks.length === (scenario === 'cancel' ? 5 : scenario === 'queue' ? 9 : 6) && report.checks.every(check => check.pass)
  await persist()
}
console.log(JSON.stringify({ build: report.build, caseName, scenario, pass: report.pass, checks: report.checks.map(({ name, pass }) => ({ name, pass })), report: reportName, errors: report.errors }, null, 2))
if (!report.pass) process.exitCode = 1
