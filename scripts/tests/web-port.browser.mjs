// Integrated Chrome QA of the real 0.11.2 web port. No product-only test hooks.
// node scripts/tests/web-port.browser.mjs [--url https://host/pletina/]
//   [--puppeteer packageOrPath] [--chrome executable] [--query 'Radiohead Creep']
//   [--ui-only | --selected-only] [--report browser-ui-followup.json]
//   [--expected-build buildHash]
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createPwaServer } from '../preview-pwa.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const require = createRequire(import.meta.url)
const puppeteer = require(option('--puppeteer', 'puppeteer'))
const directory = new URL('../../artifacts/pwa-port/', import.meta.url)
await mkdir(directory, { recursive: true })
const query = option('--query', 'Radiohead Creep')
const uiOnly = args.includes('--ui-only')
const selectedOnly = args.includes('--selected-only')
assert.ok(!(uiOnly && selectedOnly), 'Choose one QA mode')
const reportName = option('--report', 'browser.json')
assert.match(reportName, /^[a-z0-9-]+\.json$/i)
const screenshotName = (name) => `${reportName.replace(/\.json$/, '')}-${name}`
const report = {
  testedAt: new Date().toISOString(), build: null, query, runKind: selectedOnly ? 'Selected song diagnostic' : uiOnly ? 'UI and persistence follow-up' : 'complete integration', checks: [], errors: [], network: [],
  scope: 'Real Chrome desktop network/audio. Mobile layouts use desktop Chrome emulation only.',
  physicalScreenOffVerified: false, iOSPlaybackVerified: false,
  outputSilencedByChromeLaunchArgument: true, mediaElementMuted: false,
  backgroundTransitionAcceleratedBySeek: true, offlineMusicClaimed: false,
}
const scrub = (value) => String(value ?? '').replace(/https?:\/\/[^\s"'<>]+/g, '[URL]').slice(0, 450)
let server, browser, page, applicationUrl, backgroundPage
let applicationRequests = []
const media = () => page.evaluate(() => window.__qaAudio.snapshot())
async function waitAudio(predicate, timeout = 90000) {
  await page.waitForFunction(predicate, { polling: 200, timeout })
}
async function check(name, action) {
  process.stdout.write(`${name} ... `)
  try {
    const details = await action()
    report.checks.push({ name, pass: true, ...(details || {}) })
    process.stdout.write('passed\n')
    return true
  } catch (error) {
    const failure = { name, pass: false, error: scrub(error.message) }
    if (page && !page.isClosed()) failure.audio = await media().catch(() => null)
    report.checks.push(failure)
    process.stdout.write('FAILED\n')
    return false
  }
}
async function clickText(selector, text, exact = true) {
  const handle = await page.evaluateHandle((selector, text, exact) => [...document.querySelectorAll(selector)].find((element) => {
    const content = element.textContent.trim()
    return exact ? content === text : content.includes(text)
  }), selector, text, exact)
  const element = handle.asElement()
  assert.ok(element, `Visible action ${text}`)
  await element.click()
  await handle.dispose()
}
async function cacheApplicationPaths() {
  return page.evaluate(async () => {
    const paths = []
    for (const name of await caches.keys()) {
      if (!name.startsWith('pletina-pwa:')) continue
      for (const request of await (await caches.open(name)).keys()) {
        const path = new URL(request.url).pathname
        if (path.includes('/application/')) paths.push(path)
      }
    }
    return [...new Set(paths)].sort()
  })
}

async function selectedSongCheck() {
  const expectedTitle = await page.$eval('.tracks li[data-reorder-index="0"] .name', (element) => element.textContent.trim())
  // One deliberate start. No queue mutation or second click until real progress.
  await page.click('.tracks li[data-reorder-index="0"] .row[role="button"] .num')
  await waitAudio(() => window.__qaAudio.instances.some((audio) => !audio.paused && audio.currentTime > 2))
  const snapshot = await media()
  const sourceChoices = await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('pletina-web-library')
    request.onerror = () => reject(new Error('Could not read source identities'))
    request.onsuccess = () => {
      const db = request.result
      const rows = db.transaction('sources').objectStore('sources').getAll()
      rows.onerror = () => { db.close(); reject(new Error('Could not read source identities')) }
      rows.onsuccess = () => {
        const identities = rows.result.map((row) => ({ trackId: row.trackId, videoId: row.choice.videoId, title: row.choice.title, channel: row.choice.channel }))
        db.close(); resolve(identities)
      }
    }
  }))
  report.selectedSong = { expectedTitle, observedTitle: snapshot.mediaSession?.title, sourceChoices, audio: snapshot }
  assert.equal(snapshot.mediaSession?.title, expectedTitle, 'Audio must belong to the selected song, without automatic skip')
  if (query === 'Radiohead Creep') assert.ok(sourceChoices.some((source) => source.trackId === 138547415), 'Canonical Creep catalog ID selected')
  const active = snapshot.instances.find((audio) => !audio.paused)
  assert.equal(active.muted, false)
  assert.ok(active.volume > 0)
  return report.selectedSong
}

// This function is injected before the application. Signed media addresses stay only
// inside the browser; snapshots contain presence, counters and numeric media state.
function instrumentAudio() {
  const instances = []
  const events = []
  const handlers = {}
  const previousSource = new WeakMap()
  const revisions = new WeakMap()
  const NativeAudio = window.Audio
  const now = () => Math.round(performance.now())
  const snapshotOne = (audio, index) => ({
    index, srcPresent: Boolean(audio.currentSrc || audio.src), sourceRevision: revisions.get(audio) || 0,
    currentTime: Number.isFinite(audio.currentTime) ? Number(audio.currentTime.toFixed(3)) : null,
    duration: Number.isFinite(audio.duration) ? Number(audio.duration.toFixed(3)) : null,
    paused: audio.paused, ended: audio.ended, muted: audio.muted, volume: audio.volume,
    readyState: audio.readyState, networkState: audio.networkState, errorCode: audio.error?.code ?? null,
  })
  let WrappedAudio
  WrappedAudio = new Proxy(NativeAudio, {
    construct(target, args, newTarget) {
      const audio = Reflect.construct(target, args, newTarget === WrappedAudio ? target : newTarget)
      const index = instances.push(audio) - 1
      for (const type of ['loadstart', 'loadedmetadata', 'playing', 'pause', 'ended', 'seeking', 'seeked', 'error']) {
        audio.addEventListener(type, () => {
          if (type === 'loadstart' && audio.src !== previousSource.get(audio)) {
            previousSource.set(audio, audio.src)
            revisions.set(audio, (revisions.get(audio) || 0) + 1)
          }
          events.push({ type, at: now(), hidden: document.hidden, title: navigator.mediaSession?.metadata?.title ?? null, ...snapshotOne(audio, index) })
        })
      }
      return audio
    },
  })
  window.Audio = WrappedAudio
  if (navigator.mediaSession) {
    const original = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession)
    navigator.mediaSession.setActionHandler = (action, handler) => {
      handlers[action] = handler
      return original(action, handler)
    }
  }
  window.__qaAudio = {
    instances, events, handlers,
    snapshot: () => ({
      instances: instances.map(snapshotOne), events: events.slice(-100), hidden: document.hidden,
      online: navigator.onLine, iframeCount: document.querySelectorAll('iframe').length,
      handlers: Object.keys(handlers).filter((key) => typeof handlers[key] === 'function'),
      mediaSession: navigator.mediaSession ? {
        playbackState: navigator.mediaSession.playbackState,
        title: navigator.mediaSession.metadata?.title ?? null,
        artist: navigator.mediaSession.metadata?.artist ?? null,
      } : null,
    }),
  }
}

try {
  let url = option('--url', null)
  if (!url) {
    server = createPwaServer()
    server.on('request', (request) => {
      const path = new URL(request.url, 'http://localhost').pathname
      if (path.includes('/application/')) applicationRequests.push(path)
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    url = `http://127.0.0.1:${server.address().port}/pletina/`
  }
  report.originKind = option('--url', null) ? 'public HTTPS supplied by caller' : 'ephemeral localhost static QA server'
  browser = await puppeteer.launch({ headless: true, args: ['--mute-audio'],
    ...(option('--chrome', null) ? { executablePath: option('--chrome') } : {}) })
  report.browser = await browser.version()
  page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1000 })
  await page.evaluateOnNewDocument(instrumentAudio)
  page.on('pageerror', (error) => report.errors.push({ name: error.name, message: scrub(error.message) }))
  page.on('response', (response) => {
    const requestUrl = new URL(response.url())
    if (!server && requestUrl.pathname.includes('/application/')) applicationRequests.push(requestUrl.pathname)
    if (/(^|\.)(youtube\.com|googlevideo\.com|deezer\.com)$/.test(requestUrl.hostname)) {
      // Only host/status; no visitor IDs, JSONP query, media URLs or signatures.
      const mediaHeaders = response.request().resourceType() === 'media' ? {
        contentType: response.headers()['content-type'] ?? null,
        contentLength: response.headers()['content-length'] ?? null,
      } : {}
      report.network.push({ host: requestUrl.hostname, status: response.status(), resourceType: response.request().resourceType(), ...mediaHeaders })
    }
  })
  page.on('requestfailed', (request) => {
    const host = new URL(request.url()).hostname
    if (/(^|\.)(youtube\.com|googlevideo\.com|deezer\.com)$/.test(host)) {
      report.network.push({ host, resourceType: request.resourceType(), failure: scrub(request.failure()?.errorText) })
    }
  })

  const opened = await check('initial install stays small; opening downloads the full app on demand', async () => {
    await page.goto(url, { waitUntil: 'load' })
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), { polling: 200, timeout: 25000 })
    await page.waitForNetworkIdle({ idleTime: 300, timeout: 10000 })
    report.build = await page.$eval('#version', (element) => element.textContent.trim())
    if (option('--expected-build', null)) assert.equal(report.build, option('--expected-build'), 'Expected published build')
    assert.equal(applicationRequests.length, 0, 'No initial application network request')
    assert.equal((await cacheApplicationPaths()).length, 0, 'No initial application cache')
    await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }), page.click('#open-player')])
    await page.waitForSelector('.app .sidebar', { visible: true, timeout: 20000 })
    applicationUrl = page.url()
    assert.match(new URL(applicationUrl).pathname, /\/application\/index\.[a-f0-9]+\.html$/)
    assert.ok(applicationRequests.length > 0)
    const cached = await cacheApplicationPaths()
    assert.ok(cached.length >= 5, 'Application resources saved for later offline UI use')
    return { initialApplicationRequests: 0, downloadedPaths: [...new Set(applicationRequests)].sort(), cachedPaths: cached }
  })
  assert.ok(opened, 'Application must open before dependent checks')

  const searched = await check('name and artist search renders real internal song results', async () => {
    await page.type('input[aria-label="Buscar música"]', query)
    await page.waitForSelector('.tracks li[data-reorder-index] .row', { visible: true, timeout: 45000 })
    const results = await page.$$eval('.tracks li[data-reorder-index] .row', (rows) => rows.slice(0, 8).map((row) => ({
      title: row.querySelector('.name')?.textContent.trim(), artist: row.querySelector('.by')?.textContent.trim(),
    })))
    assert.ok(results.length >= (selectedOnly ? 1 : 2))
    if (query === 'Radiohead Creep') assert.ok(results.some((result) => /creep/i.test(result.title) && /radiohead/i.test(result.artist)), 'Expected canonical catalog match')
    const screenshot = screenshotName('desktop-search.png')
    await page.screenshot({ path: fileURLToPath(new URL(screenshot, directory)), fullPage: true })
    return { results, screenshot }
  })
  assert.ok(searched, 'Search must succeed before playback checks')

  if (!uiOnly) await check('the selected first song itself reaches audible playback', selectedSongCheck)
  if (selectedOnly) {
    await page.evaluate(() => window.__qaAudio.handlers.pause?.({ action: 'pause' }))
  } else {

  await check('favorite, manual queue and playlist use the real UI', async () => {
    await page.click('.tracks li[data-reorder-index="0"] button.heart')
    await page.waitForSelector('.tracks li[data-reorder-index="0"] button.heart.on')
    // Full QA has already verified one clean start; do not click it again.
    // UI-only follow-up starts the main list before adding a manual queue entry.
    if (uiOnly) await page.click('.tracks li[data-reorder-index="0"] .row[role="button"] .num')
    await page.click('.tracks li[data-reorder-index="1"] button.more')
    await clickText('[role="menuitem"]', 'Añadir a la cola')
    await page.click('.player button[title="Cola de reproducción"]')
    await page.waitForSelector('.queue-panel .mine li[data-reorder-index="0"]')
    await page.click('.queue-panel button[title="Guardar como playlist"]')
    await page.waitForSelector('input[aria-label="Nombre de la playlist"]')
    await page.click('input[aria-label="Nombre de la playlist"]', { clickCount: 3 })
    await page.type('input[aria-label="Nombre de la playlist"]', 'QA web persistente')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => [...document.querySelectorAll('.sidebar .item')].some((item) => item.textContent.includes('QA web persistente')), { polling: 200 })
    return { playlist: 'QA web persistente', favoriteSaved: true, queuedItems: 1 }
  })

  const playing = !uiOnly && await check('real resolved audio advances with muted=false and Media Session metadata', async () => {
    await waitAudio(() => window.__qaAudio.instances.some((audio) => !audio.paused && audio.currentTime > 2))
    const audio = await media()
    const active = audio.instances.find((item) => !item.paused)
    assert.equal(active.muted, false)
    assert.ok(active.volume > 0)
    assert.ok(audio.mediaSession?.title)
    assert.equal(audio.mediaSession.title, report.selectedSong.expectedTitle)
    for (const action of ['play', 'pause', 'nexttrack', 'previoustrack', 'seekto']) assert.ok(audio.handlers.includes(action), action)
    return { audio }
  })

  if (playing) {
    await check('pause and seek controls affect the same audio element', async () => {
      await page.click('.player .play')
      await waitAudio(() => window.__qaAudio.instances.every((audio) => audio.paused), 5000)
      const range = await page.$('.player input[aria-label="Posición"]')
      await range.focus()
      await page.keyboard.press('Home')
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('Tab')
      await waitAudio(() => window.__qaAudio.instances.some((audio) => audio.currentTime >= 2 && audio.currentTime < 5), 8000)
      await page.click('.player .play')
      await waitAudio(() => window.__qaAudio.instances.some((audio) => !audio.paused && audio.currentTime > 4), 10000)
      return { audio: await media() }
    })
    await check('hidden desktop tab reaches ended and plays the queued next track', async () => {
      const before = await media()
      const playingEvents = before.events.filter((event) => event.type === 'playing').length
      const count = before.instances.length
      await page.evaluate(() => { const audio = window.__qaAudio.instances.find((item) => !item.paused); audio.currentTime = audio.duration - 1.2 })
      backgroundPage = await browser.newPage()
      await backgroundPage.goto('about:blank')
      await backgroundPage.bringToFront()
      await page.waitForFunction(() => document.hidden, { polling: 200, timeout: 5000 })
      await page.waitForFunction((oldCount) => {
        const events = window.__qaAudio.events
        return events.some((event) => event.type === 'ended' && event.hidden) &&
          events.filter((event) => event.type === 'playing').length > oldCount &&
          window.__qaAudio.instances.some((audio) => !audio.paused && audio.currentTime > 1 && audio.currentTime < 20)
      }, { polling: 200, timeout: 120000 }, playingEvents)
      const after = await media()
      assert.equal(after.instances.length, count, 'PWA reuses its audio element between tracks')
      assert.ok(after.events.some((event) => event.type === 'playing' && event.hidden))
      await page.bringToFront()
      await backgroundPage.close(); backgroundPage = null
      return { audio: after, acceleration: 'QA seek to duration - 1.2 seconds; real ended event and media bytes. Source resolution may have been prefetched in foreground.' }
    })
    await page.bringToFront()
    await check('Media Session pause and next handlers control real playback', async () => {
      await page.evaluate(() => window.__qaAudio.handlers.pause({ action: 'pause' }))
      await waitAudio(() => window.__qaAudio.instances.every((audio) => audio.paused), 5000)
      const before = await media()
      const count = before.events.filter((event) => event.type === 'playing').length
      await page.evaluate(() => window.__qaAudio.handlers.nexttrack({ action: 'nexttrack' }))
      await page.waitForFunction((oldCount) => window.__qaAudio.events.filter((event) => event.type === 'playing').length > oldCount && window.__qaAudio.instances.some((audio) => !audio.paused && audio.currentTime > 1), { polling: 200, timeout: 90000 }, count)
      const after = await media()
      assert.equal(after.instances.length, before.instances.length)
      return { audio: after, actionSource: 'QA invokes handlers registered through the browser Media Session API; no OS hardware event claimed' }
    })
    await page.evaluate(() => window.__qaAudio.handlers.pause?.({ action: 'pause' }))
  }

  await check('reload restores favorites and playlist from IndexedDB', async () => {
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('.sidebar')
    await page.waitForFunction(() => [...document.querySelectorAll('.sidebar .item')].some((item) => item.textContent.includes('QA web persistente')), { polling: 200, timeout: 15000 })
    await clickText('.sidebar .item', 'Canciones que te gustan', false)
    await page.waitForSelector('.tracks li[data-reorder-index="0"] .name', { timeout: 10000 })
    const title = await page.$eval('.tracks li[data-reorder-index="0"] .name', (element) => element.textContent.trim())
    if (query === 'Radiohead Creep') assert.match(title, /creep/i)
    const databases = await page.evaluate(async () => (await indexedDB.databases()).map((db) => ({ name: db.name, version: db.version })))
    assert.ok(databases.length)
    return { favoriteTitle: title, databases }
  })
  await check('offline reload opens cached UI and locally stored playlist/favorite metadata', async () => {
    await page.setOfflineMode(true)
    await page.reload({ waitUntil: 'load', timeout: 15000 })
    await page.waitForSelector('.sidebar')
    await page.waitForFunction(() => [...document.querySelectorAll('.sidebar .item')].some((item) => item.textContent.includes('QA web persistente')), { polling: 200, timeout: 15000 })
    await clickText('.sidebar .item', 'QA web persistente', false)
    await page.waitForSelector('.tracks li[data-reorder-index="0"] .name')
    const playlistCount = await page.$$eval('.tracks li[data-reorder-index]', (elements) => elements.length)
    assert.ok(playlistCount >= 2)
    await clickText('.sidebar .item', 'Canciones que te gustan', false)
    await page.waitForSelector('.tracks li[data-reorder-index="0"] .name')
    return { online: await page.evaluate(() => navigator.onLine), playlistCount, meaning: 'App shell and IndexedDB metadata available offline; no offline media playback tested or claimed' }
  })
  await page.setOfflineMode(false)

  report.emulatedLayouts = []
  for (const profile of [
    { name: 'Android UI emulated in desktop Chrome', width: 393, height: 852, image: 'android-ui-emulated.png', userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36' },
    { name: 'iPhone UI emulated in desktop Chrome', width: 390, height: 844, image: 'iphone-ui-emulated.png', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' },
  ]) {
    await check(profile.name, async () => {
      const mobile = await browser.newPage()
      try {
        await mobile.setUserAgent(profile.userAgent)
        await mobile.setViewport({ width: profile.width, height: profile.height, isMobile: true, hasTouch: true, deviceScaleFactor: 1 })
        await mobile.setOfflineMode(true)
        await mobile.goto(applicationUrl, { waitUntil: 'load', timeout: 20000 })
        await mobile.waitForSelector('.app.mobile .bottom-nav')
        const findSearch = await mobile.evaluateHandle(() => [...document.querySelectorAll('.bottom-nav button')].find((button) => button.textContent.trim() === 'Buscar'))
        await findSearch.asElement().click()
        await mobile.waitForSelector('input[aria-label="Buscar música"]', { visible: true })
        const layout = await mobile.evaluate(() => ({
          width: innerWidth, viewportWidth: visualViewport.width,
          documentWidth: document.documentElement.scrollWidth,
          tabs: [...document.querySelectorAll('.bottom-nav button')].map((button) => button.textContent.trim()),
          input: (() => { const r = document.querySelector('input[aria-label="Buscar música"]').getBoundingClientRect(); return { x: r.x, right: r.right, width: r.width } })(),
        }))
        assert.ok(layout.documentWidth <= layout.width + 1, 'No horizontal page overflow')
        assert.ok(layout.input.width > 100 && layout.input.right <= layout.width)
        assert.deepEqual(layout.tabs, ['Inicio', 'Buscar', 'Podcasts', 'Tu biblioteca'])
        const screenshot = screenshotName(profile.image)
        await mobile.screenshot({ path: fileURLToPath(new URL(screenshot, directory)), fullPage: true })
        report.emulatedLayouts.push({ name: profile.name, ...layout, screenshot, playbackVerified: false })
        return { layout }
      } finally { await mobile.close() }
    })
  }
  }
} catch (error) {
  report.fatal = scrub(error.message)
} finally {
  if (page && !page.isClosed()) {
    report.finalAudio = await media().catch(() => null)
    report.finalUI = await page.evaluate(() => ({
      title: document.title, online: navigator.onLine,
      notices: [...document.querySelectorAll('[role="status"], .status .error')].map((element) => element.textContent.trim()).filter(Boolean).slice(0, 8),
    })).catch(() => null)
    if (report.finalUI) report.finalUI.notices = report.finalUI.notices.map(scrub)
  }
  report.finishedAt = new Date().toISOString()
  report.passed = !report.fatal && report.checks.every((check) => check.pass) && report.errors.length === 0
  try {
    await writeFile(new URL(reportName, directory), `${JSON.stringify(report, null, 2)}\n`)
  } finally {
    // Cleanup also runs if exporting the report fails.
    await Promise.allSettled([
      browser?.close(),
      server ? new Promise((resolve) => server.close(resolve)) : undefined,
    ])
  }
  process.stdout.write(`Report: artifacts/pwa-port/${reportName}; ${report.passed ? 'PASS' : 'FAIL'}\n`)
  if (!report.passed) process.exitCode = 1
}
