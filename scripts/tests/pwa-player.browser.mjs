// Real Chrome desktop QA. Mobile user agents below check layout only.
// node scripts/tests/pwa-player.browser.mjs [puppeteerPackage] [chromeExecutable]
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createPwaServer } from '../preview-pwa.mjs'

const require = createRequire(import.meta.url)
const puppeteer = require(process.argv[2] || 'puppeteer')
const outputDirectory = new URL('../../artifacts/pwa-player/', import.meta.url)
await mkdir(outputDirectory, { recursive: true })
const server = createPwaServer()
const servedModules = []
server.on('request', (request) => {
  const path = new URL(request.url, 'http://localhost').pathname
  if (path.includes('/player/')) servedModules.push(path)
})
let browser
let desktopPage
const report = {
  testedAt: new Date().toISOString(), build: null, checks: [], errors: [],
  evidenceScope: 'Chrome desktop; mobile user agents and viewports are UI emulation only',
  screenOffAutomaticallyVerified: false, iOSPlaybackVerified: false,
  qaAudioOutputMuted: true, qaMediaElementMuted: false,
  qaMediaThroughputBytesPerSecond: 65536, qaSeekToEndSeconds: 1,
}
function checked(name, condition, details = {}) {
  report.checks.push({ name, pass: Boolean(condition), ...details })
  assert.ok(condition, name)
}
const playerVisible = (page) => page.waitForSelector('#player-host .pp-links', { visible: true, timeout: 15000 })
const cacheModules = (page) => page.evaluate(async () => {
  const results = []
  for (const name of await caches.keys()) {
    if (!name.startsWith('pletina-pwa:')) continue
    for (const request of await (await caches.open(name)).keys()) {
      const path = new URL(request.url).pathname
      if (path.includes('/player/')) results.push(path)
    }
  }
  return results.sort()
})

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const url = `http://127.0.0.1:${server.address().port}/pletina/`
  browser = await puppeteer.launch({ headless: true, args: ['--mute-audio'],
    ...(process.argv[3] ? { executablePath: process.argv[3] } : {}) })
  report.browser = await browser.version()
  const page = await browser.newPage()
  desktopPage = page
  page.on('pageerror', (error) => report.errors.push({ source: 'desktop', name: error.name }))
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), { timeout: 20000, polling: 200 })
  await page.waitForNetworkIdle({ idleTime: 300, timeout: 10000 })
  report.build = await page.$eval('#version', (element) => element.textContent)
  checked('initial-install-does-not-request-player', servedModules.length === 0, { requests: [...servedModules] })
  checked('initial-install-does-not-cache-player', (await cacheModules(page)).length === 0)

  await page.click('#open-player')
  await playerVisible(page)
  const firstModules = [...servedModules]
  checked('open-downloads-only-two-hashed-modules', firstModules.length === 2 && new Set(firstModules).size === 2 &&
    firstModules.every((path) => /\/player\/[^/]+\.[a-f0-9]+\.js$/.test(path)), { requests: firstModules })
  checked('opened-player-is-cached', (await cacheModules(page)).length === 2)
  await page.click('#back-home')
  checked('back-home-is-visible', await page.$eval('#home-screen', (element) => !element.hidden))

  await page.setOfflineMode(true)
  await page.reload({ waitUntil: 'load' })
  await page.click('#open-player')
  await playerVisible(page)
  checked('offline-reload-and-open-player', servedModules.length === firstModules.length,
    { networkModuleRequestsAfterReload: servedModules.length - firstModules.length })
  await page.setOfflineMode(false)

  // These are Chrome layout checks, never Safari/iPhone playback evidence.
  report.emulatedUI = []
  const profiles = [
    { name: 'Android UI emulated in Chrome desktop', width: 393, height: 852,
      userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36', image: 'android-ui-emulated.png' },
    { name: 'iPhone UI emulated in Chrome desktop', width: 390, height: 844,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', image: 'iphone-ui-emulated.png' },
  ]
  for (const profile of profiles) {
    const context = await browser.createBrowserContext()
    try {
      const mobile = await context.newPage()
      mobile.on('pageerror', (error) => report.errors.push({ source: profile.name, name: error.name }))
      await mobile.setUserAgent(profile.userAgent)
      await mobile.setViewport({ width: profile.width, height: profile.height, isMobile: true, hasTouch: true })
      await mobile.goto(url, { waitUntil: 'load' })
      const installVisible = await mobile.$eval('#install', (element) => !element.hidden)
      await mobile.click('#open-player')
      await playerVisible(mobile)
      const layout = await mobile.evaluate(() => ({
        viewport: innerWidth, content: document.documentElement.scrollWidth,
        input: (() => { const r = document.querySelector('.pp-links').getBoundingClientRect(); return { left: r.left, right: r.right } })(),
      }))
      checked(profile.name, installVisible && layout.content <= layout.viewport + 2 &&
        layout.input.left >= 0 && layout.input.right <= layout.viewport + 2, { layout })
      await mobile.screenshot({ path: fileURLToPath(new URL(profile.image, outputDirectory)), fullPage: true })
      report.emulatedUI.push({ name: profile.name, screenshot: profile.image, layout, playbackTested: false })
    } finally { await context.close() }
  }
  await page.bringToFront()

  // Limit only media throughput. API requests remain direct; no audio payload is saved.
  const cdp = await page.createCDPSession()
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditionsByRule', { offline: false,
    matchedNetworkConditions: [{ urlPattern: 'https://*.googlevideo.com/*', latency: 0,
      downloadThroughput: 65536, uploadThroughput: -1 }] })
  const directRequests = []
  report.directRequests = directRequests
  report.mediaResponses = []
  page.on('request', (request) => {
    const requestURL = new URL(request.url())
    if (requestURL.hostname.endsWith('youtube.com') && requestURL.pathname.startsWith('/youtubei/')) {
      directRequests.push({ at: Date.now(), host: requestURL.hostname, path: requestURL.pathname })
    }
  })
  page.on('response', (response) => {
    const host = new URL(response.url()).hostname
    if (host === 'googlevideo.com' || host.endsWith('.googlevideo.com') || host.endsWith('youtube.com')) {
      report.mediaResponses.push({ at: Date.now(), host, status: response.status() })
    }
  })
  await page.evaluate(() => {
    window.__playerQAEvents = []
    const audio = document.querySelector('#player-host audio')
    for (const event of ['playing', 'pause', 'ended', 'loadedmetadata', 'seeked', 'error']) {
      audio.addEventListener(event, () => window.__playerQAEvents.push({ event, at: Date.now(), hidden: document.hidden,
        time: audio.currentTime, mediaError: audio.error?.code || null }))
    }
  })
  await page.$eval('.pp-links', (element) => { element.value = 'aqz-KE-bpKQ\naqz-KE-bpKQ' })
  await page.click('.pp-prepare')
  // The user presses Play as soon as the source is prepared. Browsers may defer
  // metadata preloading until this gesture; metadata is not a prerequisite here.
  await page.waitForFunction(() => !document.querySelector('.pp-play').disabled, { timeout: 45000, polling: 200 })
  checked('queue-prepares-two-entries', await page.$$eval('.pp-queue button', (buttons) => buttons.length === 2))
  report.beforePlayGesture = await page.$eval('#player-host audio', (audio) => ({
    readyState: audio.readyState, networkState: audio.networkState, sourcePresent: Boolean(audio.getAttribute('src')),
    mediaError: audio.error?.code || null,
  }))
  await page.click('.pp-play')
  await page.waitForFunction(() => {
    const audio = document.querySelector('#player-host audio')
    return !audio.paused && !audio.muted && audio.currentTime > 1.2
  }, { timeout: 20000, polling: 200 })
  checked('first-audio-really-advances-unmuted', true)
  await page.click('.pp-play')
  checked('pause-button-pauses', await page.$eval('#player-host audio', (audio) => audio.paused))
  await page.click('.pp-play')
  await page.waitForFunction(() => !document.querySelector('#player-host audio').paused, { polling: 200 })

  const background = await browser.newPage()
  await background.goto('about:blank')
  await page.waitForFunction(() => document.hidden, { timeout: 10000, polling: 200 })
  const hiddenFrom = Date.now()
  await page.$eval('.pp-progress', (slider) => {
    const audio = document.querySelector('#player-host audio')
    slider.value = String(audio.duration - 1)
    slider.dispatchEvent(new Event('input', { bubbles: true }))
    slider.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await page.waitForFunction(() => {
    const current = document.querySelector('.pp-queue button[aria-current="true"]')
    const audio = document.querySelector('#player-host audio')
    return current?.dataset.index === '1' && !audio.paused && audio.currentTime > 1.2
  }, { timeout: 30000, polling: 250 })
  const second = await page.$eval('#player-host audio', (audio) => ({
    time: audio.currentTime, muted: audio.muted, paused: audio.paused, error: audio.error?.code || null,
  }))
  const events = await page.evaluate(() => window.__playerQAEvents)
  const hiddenRequests = directRequests.filter((request) => request.at >= hiddenFrom)
  checked('ended-resolves-and-plays-next-in-background', events.some((event) => event.event === 'ended' && event.hidden) &&
    events.some((event) => event.event === 'playing' && event.hidden) && hiddenRequests.length >= 2 &&
    !second.error && !second.muted && !second.paused, { second })
  report.audio = { directRequests, events, second, hiddenFrom,
    physicalScreenOff: 'not tested', iPhonePlayback: 'not tested', androidPhysicalPlayback: 'not tested' }
  await background.close()
  await page.bringToFront()
  await page.click('.pp-stop')
  checked('stop-clears-audio', await page.$eval('#player-host audio', (audio) => audio.paused && !audio.getAttribute('src')))
} catch (error) {
  report.errors.push({ source: 'runner', name: error.name, message: error.name === 'AssertionError' ? error.message : undefined })
  if (desktopPage) report.failureState = await desktopPage.evaluate(() => {
    const audio = document.querySelector('#player-host audio')
    return {
      online: navigator.onLine, hidden: document.hidden,
      status: document.querySelector('.pp-status')?.textContent,
      title: document.querySelector('.pp-title')?.textContent,
      playDisabled: document.querySelector('.pp-play')?.disabled,
      liveIframes: document.querySelectorAll('iframe').length,
      audio: audio ? { time: audio.currentTime, paused: audio.paused, muted: audio.muted,
        readyState: audio.readyState, networkState: audio.networkState,
        mediaError: audio.error?.code || null, sourcePresent: Boolean(audio.getAttribute('src')) } : null,
    }
  }).catch(() => null)
} finally {
  if (browser) await browser.close()
  await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.() })
  await writeFile(new URL('browser.json', outputDirectory), JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify({ build: report.build, browser: report.browser, checks: report.checks,
  errors: report.errors, evidenceScope: report.evidenceScope,
  report: fileURLToPath(new URL('browser.json', outputDirectory)) }, null, 2))
if (report.errors.length || report.checks.some((check) => !check.pass)) process.exitCode = 1
