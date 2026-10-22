// Compiled-UI QA of the real curated recording rescue. No product imports/mocks.
// All DOM/media observations use CDP userGesture:false; play/seek/repeat use actual UI input.
// node scripts/tests/catalog-rescue-live.browser.mjs --expected-build HASH
//   [--case iritsi|egiozu] [--url https://host/pletina/] [--report safe-name.json] [--chrome executable]
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'
import { createPwaServer } from '../preview-pwa.mjs'

const args = process.argv.slice(2)
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback
const caseName = option('--case', 'iritsi')
const cases = {
  iritsi: { id: 3250715431, title: 'Iritsi da Eguna', album: 'Eskerrik Asko!', bytes: 4_633_634, duration: 187.180408, start: 8.94, host: 'alea.tok-md.com' },
  egiozu: { id: 3266797141, title: 'Egiozu Euskaraz', album: 'Irrien Lagunak', bytes: 2_029_320, duration: 126.8325, start: 0, host: 'archive.org' },
}
assert.ok(Object.hasOwn(cases, caseName), 'Known recording case')
const song = cases[caseName]
const expectedBuild = option('--expected-build', null)
assert.match(expectedBuild ?? '', /^[a-f0-9]{16}$/, 'Pass the freshly compiled expected build explicitly')
const reportName = option('--report', `catalog-rescue-live-${caseName}-${expectedBuild}.json`)
assert.match(reportName, /^[a-z0-9.-]+\.json$/i)
const directory = new URL('../../artifacts/pwa-port/', import.meta.url)
await mkdir(directory, { recursive: true })
const scrub = value => String(value ?? '').replace(/(?:https?|blob):[^\s"'<>]+/g, '[URL]').slice(0, 400)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const report = {
  testedAt: new Date().toISOString(), expectedBuild, build: null, caseName, expectedRecording: song, checks: [], errors: [], network: [], inputActions: [],
  scope: 'Real compiled PWA UI, real catalog and curated full recording, desktop Chrome mobile layout; no phone or installed-PWA claim.',
  physicalAndroidVerified: false, physicalIPhoneVerified: false, installedPwaVerified: false, screenOffVerified: false,
  browserSecurityOverrides: false, backgroundThrottleOverrides: false, outputMuted: false, providerResponsesMocked: false,
  observationRpcCalls: 0, observationRpcWithGesture: 0, primarySongClicks: 0, sourceMenuClicks: 0, iframePlaybackClicks: 0,
  mediaFilesWritten: false, mediaUrlsPersisted: false, networkOfflineFaultInjection: false,
}
let server, browser, page, background, terminalError

function observeAudio() {
  const instances = [], events = [], blobs = new Map(), revisions = new WeakMap(), previous = new WeakMap()
  const NativeAudio = window.Audio, createObjectURL = URL.createObjectURL.bind(URL)
  URL.createObjectURL = value => {
    const url = createObjectURL(value)
    if (value instanceof Blob) blobs.set(url, { bytes: value.size, mime: value.type })
    return url
  }
  const one = (audio, index) => {
    const src = audio.currentSrc || audio.src
    return { index, sourceKind: src.startsWith('blob:') ? 'blob' : src.startsWith('https:') ? 'https' : src ? 'other' : 'empty',
      sourceRevision: revisions.get(audio) ?? 0, blob: blobs.get(src) ?? null,
      currentTime: Number.isFinite(audio.currentTime) ? Number(audio.currentTime.toFixed(3)) : null,
      duration: Number.isFinite(audio.duration) ? Number(audio.duration.toFixed(3)) : null,
      paused: audio.paused, ended: audio.ended, muted: audio.muted, volume: audio.volume, error: audio.error?.code ?? null }
  }
  let Wrapped
  Wrapped = new Proxy(NativeAudio, { construct(target, args, newTarget) {
    const audio = Reflect.construct(target, args, newTarget === Wrapped ? target : newTarget), index = instances.push(audio) - 1
    for (const type of ['loadstart', 'loadedmetadata', 'playing', 'pause', 'ended', 'seeking', 'seeked', 'error']) audio.addEventListener(type, () => {
      if (type === 'loadstart' && audio.src !== previous.get(audio)) { previous.set(audio, audio.src); revisions.set(audio, (revisions.get(audio) ?? 0) + 1) }
      events.push({ type, at: Math.round(performance.now()), hidden: document.hidden, ...one(audio, index) })
    })
    return audio
  } })
  window.Audio = Wrapped
  window.__catalogRescueObserver = { snapshot() {
    let current = null, repeat = null
    try {
      const queue = JSON.parse(localStorage.getItem('pletina:web:queue:v1') ?? 'null')
      const item = queue?.manual ?? queue?.queue?.[queue?.order?.[queue?.pos]]
      if (item) current = { id: item.track.id, title: item.track.title, artist: item.track.artist.name, album: item.albumTitle, isrc: item.track.isrc ?? null }
      repeat = queue?.repeat ?? null
    } catch {}
    return { audio: instances.map(one), events: events.slice(-150), hidden: document.hidden, online: navigator.onLine, current, repeat,
      videoIframeCount: [...document.querySelectorAll('iframe')].filter(frame => /youtube(?:-nocookie)?\.com\/embed\//.test(frame.src)).length,
      mediaSession: navigator.mediaSession ? { title: navigator.mediaSession.metadata?.title ?? null, artist: navigator.mediaSession.metadata?.artist ?? null, playbackState: navigator.mediaSession.playbackState } : null,
      tabs: [...document.querySelectorAll('.bottom-nav button')].map(button => button.textContent.trim()),
      nowPlayingOpen: !!document.querySelector('.np[role="dialog"]'),
      searchValue: document.querySelector('input[aria-label="Buscar música"]')?.value ?? null,
      searchRows: [...document.querySelectorAll('.tracks li[data-reorder-index]')].slice(0, 4).map(row => ({ title: row.querySelector('.name')?.textContent.trim(), artist: row.querySelector('.by')?.textContent.trim() })),
      notices: [...document.querySelectorAll('.notice,[role="alert"]')].map(node => node.textContent.trim()).slice(0, 4),
      navigation: { route: history.state?.snapshot?.stack?.[history.state?.index]?.name ?? null },
    }
  } }
}

async function read(fn, value = null) {
  report.observationRpcCalls++
  const context = page.mainFrame().mainRealm().context
  const response = await page.mainFrame().client.send('Runtime.callFunctionOn', {
    executionContextId: context.id, functionDeclaration: fn.toString(), arguments: [{ value }], returnByValue: true, awaitPromise: true, userGesture: false,
  })
  if (response.exceptionDetails) throw new Error(scrub(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text))
  return response.result.value
}
const snapshot = () => read(() => window.__catalogRescueObserver.snapshot())
async function poll(label, action, timeout = 15000) {
  const started = Date.now()
  let error
  while (Date.now() - started < timeout) {
    try { const value = await action(); if (value) return value } catch (failure) { error = scrub(failure.message) }
    await delay(180)
  }
  throw new Error(label + ' timed out' + (error ? ': ' + error : ''))
}
async function check(name, action) {
  process.stdout.write(name + ' ... ')
  try { const result = await action(); report.checks.push({ name, pass: true, ...result }); process.stdout.write('passed\n'); return result }
  catch (error) {
    report.checks.push({ name, pass: false, error: scrub(error.message), state: page ? await snapshot().catch(() => null) : null })
    process.stdout.write('FAILED\n'); throw error
  } finally { await writeFile(new URL(reportName, directory), JSON.stringify(report, null, 2) + '\n') }
}
async function click(selector, purpose, fraction = 0.5) {
  const point = await read(({ selector, fraction }) => {
    const element = document.querySelector(selector)
    if (!element) return null
    element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
    const rect = element.getBoundingClientRect(), x = rect.left + rect.width * fraction, y = rect.top + rect.height / 2
    const hit = document.elementFromPoint(x, y)
    if (!rect.width || !rect.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight || !hit || !(hit === element || element.contains(hit))) return null
    return { x, y }
  }, { selector, fraction })
  assert.ok(point, 'Visible unobstructed UI action: ' + purpose)
  report.inputActions.push({ action: 'trusted mouse click', purpose })
  await page.mouse.click(point.x, point.y)
}
const active = state => state.audio.find(audio => !audio.paused && !audio.error)
// Chrome 148 supports this direct CDP command; Puppeteer 25's newer ByRule
// wrapper has an incompatible schema with that installed browser. No responses are mocked.
const offline = value => page.mainFrame().client.send('Network.emulateNetworkConditions', {
  offline: value, latency: 0, downloadThroughput: value ? 0 : -1, uploadThroughput: value ? 0 : -1,
})
const assertSong = state => {
  assert.equal(state.current?.id, song.id, 'Canonical catalog song remains current')
  assert.equal(state.current?.title, song.title)
  assert.equal(state.current?.album, song.album)
  assert.equal(state.mediaSession?.title, song.title)
  assert.match(state.current?.artist ?? '', /Pirritx.*Porrotx/i)
  assert.equal(state.videoIframeCount, 0, 'No official video fallback is opened')
}

try {
  let url = option('--url', null)
  if (!url) {
    server = createPwaServer()
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    url = `http://127.0.0.1:${server.address().port}/pletina/`
  } else assert.equal(new URL(url).protocol, 'https:')
  report.target = { origin: new URL(url).origin, path: new URL(url).pathname, temporaryStaticQaPreview: !!server }
  browser = await puppeteer.launch({ headless: true,
    executablePath: option('--chrome', 'C:/Users/iunan/.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe'),
    ignoreDefaultArgs: ['--mute-audio', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], args: [], protocolTimeout: 180000 })
  report.browser = await browser.version()
  page = await browser.newPage()
  await page.setViewport({ width: 393, height: 852, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
  await page.evaluateOnNewDocument(observeAudio)
  page.on('pageerror', error => report.errors.push({ name: error.name, message: scrub(error.message) }))
  page.on('response', response => {
    const url = new URL(response.url())
    if (/^(?:alea\.tok-md\.com|archive\.org|.*\.archive\.org|api\.audius\.co|api\.deezer\.com|www\.youtube\.com|music\.youtube\.com)$/.test(url.hostname)) report.network.push({ host: url.hostname, status: response.status(), resourceType: response.request().resourceType() })
  })
  await check('launcher opens the expected compiled app through its normal control', async () => {
    await page.goto(url, { waitUntil: 'load', timeout: 30000 })
    await poll('Service worker control', () => read(() => !!navigator.serviceWorker.controller), 30000)
    report.build = await read(() => document.querySelector('#version')?.textContent.trim() ?? null)
    assert.equal(report.build, expectedBuild)
    const activation = await read(() => ({ active: navigator.userActivation.isActive, ever: navigator.userActivation.hasBeenActive }))
    assert.equal(activation.ever, false, 'Observer did not grant a gesture')
    await click('#open-player', 'open Pletina from installer')
    await poll('App mobile navigation', () => read(() => !!document.querySelector('.app.mobile .bottom-nav')), 30000)
    const state = await snapshot()
    assert.deepEqual(state.tabs, ['Inicio', 'Buscar', 'Podcasts', 'Tu biblioteca'])
    return { activationBeforeInput: activation, tabs: state.tabs }
  })
  await check('search and select the exact song with one normal title click', async () => {
    await click('.bottom-nav button:nth-child(2)', 'open Buscar')
    await poll('Music search input', () => read(() => !!document.querySelector('input[aria-label="Buscar música"]')))
    // BottomNav focuses/selects the input on the next animation frame. Let that
    // real UI behavior settle before trusted typing, or it can select early letters.
    await read(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await click('input[aria-label="Buscar música"]', 'focus song search')
    await page.keyboard.type(song.title)
    const selection = await poll('Matching catalog row', () => read(song => {
      const rows = [...document.querySelectorAll('.tracks li[data-reorder-index]')]
      const row = rows.find(row => row.querySelector('.name')?.textContent.trim() === song.title && /pirritx.*porrotx/i.test(row.querySelector('.by')?.textContent ?? '') && row.querySelector('.album button')?.textContent.trim() === song.album)
      return row ? { index: row.dataset.reorderIndex, title: row.querySelector('.name').textContent.trim(), artist: row.querySelector('.by').textContent.trim(), album: row.querySelector('.album button').textContent.trim() } : null
    }, song), 45000)
    report.selected = selection
    await click(`.tracks li[data-reorder-index="${selection.index}"] .name`, 'play the exact song through its title')
    report.primarySongClicks++
    return { selected: selection, primarySongClicks: report.primarySongClicks }
  })
  await check('the single click starts full direct audio beyond verified zero padding, without video', async () => {
    const samples = [], began = Date.now()
    let anchor, final
    while (Date.now() - began < 125000) {
      const state = await snapshot(), audio = active(state)
      if (state.videoIframeCount) throw new Error('Video fallback appeared instead of full direct audio')
      if (audio?.sourceKind === 'blob' && audio.currentTime >= Math.max(0.1, song.start - 0.04)) {
        samples.push({ atMs: Date.now() - began, audio, current: state.current })
        anchor ??= { wall: Date.now(), time: audio.currentTime }
        if (audio.currentTime - anchor.time >= 2 && Date.now() - anchor.wall >= 1800) { final = state; break }
      }
      await delay(250)
    }
    report.primarySamples = samples
    assert.ok(final, 'No second playback click may rescue autoplay')
    assertSong(final)
    assert.equal(final.audio.length, 1, 'PWA keeps one Audio element')
    const audio = active(final)
    assert.equal(audio.muted, false); assert.ok(audio.volume > 0)
    assert.equal(audio.blob?.bytes, song.bytes, 'Audio uses the complete checked file held in RAM')
    assert.ok(Math.abs(audio.duration - song.duration) < 2, 'Full recording duration within MP3 decoder estimation tolerance, never a preview')
    const firstPlaying = final.events.find(event => event.type === 'playing' && event.sourceKind === 'blob')
    assert.ok(firstPlaying, 'Direct source playing event observed')
    assert.ok(firstPlaying.currentTime >= Math.max(0, song.start - 0.04) && firstPlaying.currentTime < song.start + 1.06, 'Start offset skips only the verified zero prefix')
    return { state: final, firstPlaying, primarySongClicks: 1, noAdditionalPlaybackAction: true }
  })
  await check('real seek UI reaches the middle of the same recording', async () => {
    await click('.mini .open', 'open Sonando ahora')
    await poll('Now playing dialog', () => read(() => !!document.querySelector('.np[role="dialog"]')))
    await click('.np input[aria-label="Posición"]', 'seek to the middle through the visible progress bar')
    const result = await poll('Mid-recording playback', async () => {
      const state = await snapshot(), audio = active(state)
      return audio && audio.currentTime >= song.duration * 0.4 && audio.currentTime <= song.duration * 0.6 ? state : null
    })
    assertSong(result)
    assert.equal(result.audio.length, 1)
    return { state: result, testPerformedByUi: true }
  })
  await check('repeat-one reaches real ended and restarts the same checked audio offline in a hidden tab', async () => {
    await click('.np button[title="Repetir"]', 'enable repeat-all')
    await click('.np button[title="Repetir una"]', 'enable repeat-one')
    await poll('Repeat one persisted', async () => (await snapshot()).repeat === 'one')
    const before = await snapshot(), requestsBefore = report.network.filter(row => row.host === song.host || row.host.endsWith('.' + song.host)).length
    await click('.np input[aria-label="Posición"]', 'focus progress for end-of-track acceleration')
    await page.keyboard.press('End'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Tab')
    await poll('Near end after UI keyboard seek', async () => { const state = await snapshot(), audio = active(state); return audio && audio.duration - audio.currentTime < 4 ? state : null })
    await offline(true)
    report.networkOfflineFaultInjection = true
    background = await browser.newPage(); await background.goto('about:blank'); await background.bringToFront()
    await poll('Real hidden desktop tab', async () => (await snapshot()).hidden)
    await delay(10500)
    const after = await snapshot()
    assertSong(after)
    assert.equal(after.hidden, true); assert.equal(after.online, false)
    assert.equal(after.audio.length, 1)
    const newEvents = after.events.filter(event => event.at > (before.events.at(-1)?.at ?? 0))
    assert.ok(newEvents.some(event => event.type === 'ended' && event.hidden), 'Real ended happened while hidden')
    assert.ok(newEvents.some(event => event.type === 'playing' && event.hidden && event.currentTime >= Math.max(0, song.start - 0.04) && event.currentTime < song.start + 1.06), 'Real repeat starts at the verified offset while hidden')
    assert.ok(active(after)?.currentTime >= song.start + 4 && active(after)?.currentTime < song.start + 25, 'Restarted audio advances in the hidden tab')
    assert.equal(report.network.filter(row => row.host === song.host || row.host.endsWith('.' + song.host)).length, requestsBefore, 'No second source fetch needed for repetition')
    assert.equal(after.audio[0].sourceRevision, before.audio[0].sourceRevision, 'Same existing verified blob is repeated')
    await page.bringToFront(); await background.close(); background = null; await offline(false)
    return { state: after, offlineRepeat: true, hiddenWaitMs: 10500, acceleration: 'Trusted UI End/ArrowLeft seek; the browser emits real ended. Existing checked blob is repeated, not proof of a different queued song or phone background.' }
  })
  await check('opening the album, using Back and going Home retains four tabs and playback', async () => {
    // Mobile top-level Search intentionally has no on-screen Back button. Enter
    // the album via Now Playing first, then exercise its real Back UI.
    await click('.np .from button.link', 'open the current album from Sonando ahora')
    await poll('Player overlay closed', async () => !(await snapshot()).nowPlayingOpen)
    await poll('Album Back button', () => read(() => !!document.querySelector('.topbar button[title="Atrás"]')))
    const before = await snapshot(), time = active(before)?.currentTime
    await click('.topbar button[title="Atrás"]', 'return from the album through Back UI')
    await poll('Search tab active after Back', () => read(() => document.querySelector('.bottom-nav button[aria-current="page"]')?.textContent.trim() === 'Buscar'))
    await click('.bottom-nav button:nth-child(1)', 'return to Inicio through its normal tab')
    await poll('Home tab active', () => read(() => document.querySelector('.bottom-nav button[aria-current="page"]')?.textContent.trim() === 'Inicio'))
    await delay(1200)
    const after = await snapshot()
    assertSong(after)
    assert.deepEqual(after.tabs, ['Inicio', 'Buscar', 'Podcasts', 'Tu biblioteca'])
    assert.ok(active(after)?.currentTime > time, 'Navigation does not stop audio')
    return { state: after, hardwareBackOrAndroidHomeClaimed: false }
  })
} catch (error) { terminalError = error; report.errors.push({ kind: 'terminal', message: scrub(error.message) }) }
finally {
  if (page && !page.isClosed()) report.finalState = await snapshot().catch(() => null)
  await background?.close().catch(() => {})
  await browser?.close()
  if (server) await new Promise(resolve => server.close(resolve))
  report.pass = !terminalError && report.checks.length === 6 && report.checks.every(check => check.pass)
  await writeFile(new URL(reportName, directory), JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify({ build: report.build, pass: report.pass, checks: report.checks.map(({ name, pass }) => ({ name, pass })), report: reportName, errors: report.errors }, null, 2))
if (!report.pass) process.exitCode = 1
