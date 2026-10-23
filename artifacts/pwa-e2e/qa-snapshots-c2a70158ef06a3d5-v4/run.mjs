import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { createPwaServer } from '../../preview-pwa.mjs'
import { createHarness, PROFILES, scrub } from './harness.mjs'

const workspace = fileURLToPath(new URL('../../../', import.meta.url))
const args = process.argv.slice(2)
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const browsersPath = option('--browsers', process.env.PLAYWRIGHT_BROWSERS_PATH ?? (existsSync('D:/tmp/pletina-e2e-browsers') ? 'D:/tmp/pletina-e2e-browsers' : undefined))
if (browsersPath) process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath
const playwright = await import('playwright')
const require = createRequire(import.meta.url)
const requested = option('--profiles', 'chromium-android-layout,webkit-iphone-layout,firefox-narrow').split(',').filter(Boolean)
for (const profile of requested) assert.ok(PROFILES[profile], `Unknown profile ${profile}`)
const suite = option('--suite', 'all')
assert.ok(['smoke', 'library', 'responsive', 'media', 'all'].includes(suite), 'Invalid suite')
const selectedMedia = option('--scenarios', null)?.split(',').filter(Boolean).map(id => id.startsWith('media.') ? id : 'media.' + id)
if (selectedMedia) {
  assert.equal(suite, 'media', '--scenarios is restricted to the media suite')
  assert.ok(selectedMedia.length && new Set(selectedMedia).size === selectedMedia.length, 'Select distinct media scenarios')
  const { mediaScenarioInventory } = await import('./media-scenarios.mjs')
  for (const id of selectedMedia) assert.ok(mediaScenarioInventory.some(item => item.id === id), 'Unknown media scenario: ' + id)
  if (!selectedMedia.includes('media.selection-html-audio')) selectedMedia.unshift('media.selection-html-audio')
}
const dist = resolve(option('--dist', join(workspace, 'dist-pwa')))
const worker = await readFile(join(dist, 'sw.js'), 'utf8')
const build = worker.match(/const VERSION = "([a-f0-9]{16})"/)?.[1]
assert.ok(build, 'Compiled PWA build required')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const output = resolve(option('--output', join(workspace, 'artifacts/pwa-e2e', `${build}-${stamp}`)))
await mkdir(output, { recursive: true })
const summary = { schemaVersion: 1, startedAt: new Date().toISOString(), build, suite, selectedMediaScenarios: selectedMedia ?? null, profiles: [],
  host: { platform: process.platform, arch: process.arch, node: process.version },
  scope: 'Compiled PWA with synthetic HTTP provider fixtures and real browser audio, IDB and service worker. Desktop browser/device-layout emulation only.',
  allRequestedPlatformsVerified: false, platforms: [
    { id: 'android-physical', status: 'blocked', reason: 'No physical-device runner executed; desktop Chromium emulation is separate evidence.' },
    { id: 'iphone-physical', status: 'blocked', reason: 'No physical iPhone/Safari/installed PWA runner executed; Windows WebKit is separate evidence.' },
    { id: 'android-auto', status: 'unsupported', reason: 'Current static PWA does not expose a native Android car media service.' },
    { id: 'carplay', status: 'unsupported', reason: 'Current static PWA does not contain a signed iOS CarPlay app and entitlement.' },
  ], errors: [] }
let server, browser, puppeteerBrowser
let originAvailable = true, blockedOriginRequests = 0
const networkAvailability = {
  setAvailable(value) { originAvailable = Boolean(value) },
  snapshot: () => ({ available: originAvailable, blockedOriginRequests }),
}
const persist = async () => {
  summary.counts = Object.fromEntries(['pass', 'fail', 'blocked', 'unsupported'].map(status => [status,
    summary.profiles.reduce((sum, profile) => sum + (profile.counts?.[status] ?? 0), 0)]))
  summary.platformCounts = Object.fromEntries(['pass', 'fail', 'blocked', 'unsupported'].map(status => [status,
    summary.platforms.filter(platform => platform.status === status).length]))
  summary.expectedHandledErrors = summary.errors.filter(error => error.handledExpected === true).length
  summary.unexpectedErrors = summary.errors.filter(error => error.handledExpected !== true)
  await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
}
function executable(engine) {
  if (engine !== 'chromium') return undefined
  const selected = option('--chrome', process.env.PLETINA_E2E_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe')
  return existsSync(selected) ? selected : undefined
}
async function chromiumBridge({ context, page, report }) {
  // Playwright attaches before opaque frames exist. Puppeteer owns only HTTP interception.
  const marker = 'about:blank#pletina-e2e-' + crypto.randomUUID()
  const targetReady = puppeteerBrowser.waitForTarget(target => target.type() === 'page' && target.url() === marker, { timeout: 15000 })
  await page.goto(marker)
  const puppeteerPage = await (await targetReady).page()
  assert.ok(puppeteerPage, 'The disposable Playwright page must have a matching Puppeteer target')
  await puppeteerPage.setRequestInterception(true)
  report.networkTransport = 'Puppeteer HTTP interception + Playwright UI; unchanged provider fixtures and production service worker.'
  return {
    pages: () => context.pages(),
    setOffline: value => puppeteerPage.setOfflineMode(value),
    route: async (_pattern, handler) => {
      puppeteerPage.on('request', request => {
        if (request.isInterceptResolutionHandled()) return
        const wrapped = { url: () => request.url(), method: () => request.method(), resourceType: () => request.resourceType(),
          frame: () => request.frame(), failure: () => request.failure(),
          headers: () => request.headers(), postDataJSON: () => JSON.parse(request.postData() || '{}') }
        const route = { request: () => wrapped, continue: () => request.continue(), abort: (code = 'failed') => request.abort(code),
          fulfill: value => request.respond({ status: value.status ?? 200, headers: value.headers, contentType: value.contentType, body: value.body }) }
        Promise.resolve(handler(route)).catch(async error => {
          if (page.isClosed()) return
          report.errors.push({ name: 'ProviderTransportError', message: scrub(error.message) })
          if (!request.isInterceptResolutionHandled()) await request.abort('failed').catch(() => {})
        })
      })
    },
  }
}
async function smoke(ctx) {
  await ctx.check('smoke.search-play: real compiled search and media advance', async () => {
    await ctx.fillSearch('Buscar', ctx.fixture.media.query)
    const row = ctx.page.locator('ol.tracks > li[data-reorder-index]').first()
    await row.waitFor()
    assert.equal((await row.locator('.name').textContent()).trim(), ctx.fixture.tracks[0].title, 'HTTP fixtures must supply the song; live provider results cannot pass')
    assert.ok(ctx.fixture.requests.some(request => request.host === 'api.deezer.com' && request.path === '/search/track'), 'Fixture routing must intercept catalog track search')
    await ctx.tap(row.locator('.name'))
    await ctx.page.waitForFunction(() => window.__qaAudio.instances.some(audio => !audio.paused && audio.currentTime > 0.1 && !audio.error))
    const state = await ctx.snapshot()
    return { audio: state.audio.instances, fixtureMedia: true, firstSong: ctx.fixture.tracks[0].title,
      interceptedTrackSearches: ctx.fixture.requests.filter(request => request.host === 'api.deezer.com' && request.path === '/search/track').length }
  })
}
async function fixtureGate(ctx) {
  return ctx.check('setup.fixture: opaque-frame catalog requests are controlled', async () => {
    const before = ctx.fixture.requests.filter(request => request.host === 'api.deezer.com' && request.path === '/search/track').length
    await ctx.fillSearch('Buscar', ctx.fixture.media.query)
    const row = ctx.page.locator('ol.tracks > li[data-reorder-index]').first()
    await row.waitFor()
    assert.equal((await row.locator('.name').textContent()).trim(), ctx.fixture.tracks[0].title, 'HTTP fixtures must supply the song; live provider results cannot pass')
    const after = ctx.fixture.requests.filter(request => request.host === 'api.deezer.com' && request.path === '/search/track').length
    assert.ok(after > before, 'Fixture routing must intercept this catalog track search')
    await ctx.tab('Inicio')
    return { firstSong: ctx.fixture.tracks[0].title, interceptedTrackSearches: after - before, playbackStarted: false }
  })
}
async function blockRemaining(ctx, reason) {
  if (suite === 'smoke') { await ctx.check('smoke.search-play', async () => ({ status: 'blocked', reason })); return }
  const suites = []
  if (suite === 'all' || suite === 'library') suites.push(['./library-scenarios.mjs', 'libraryScenarioInventory', 'library'])
  if (suite === 'all' || suite === 'responsive') suites.push(['./responsive-scenarios.mjs', 'responsiveScenarioInventory', 'responsive'])
  if (suite === 'all' || suite === 'media') suites.push(['./media-scenarios.mjs', 'mediaScenarioInventory', 'media'])
  for (const [file, name, fallback] of suites) {
    let inventory = []
    try { inventory = (await import(file))[name] ?? [] } catch { /* A missing suite is explicitly blocked below. */ }
    if (!inventory.length) inventory = [{ id: fallback + '.scenarios' }]
    if (fallback === 'media' && selectedMedia) inventory = inventory.filter(item => selectedMedia.includes(typeof item === 'string' ? item : item.id ?? item.name))
    for (const item of inventory) await ctx.check(typeof item === 'string' ? item : item.id ?? item.name, async () => ({ status: 'blocked', reason }))
  }
}
async function loadScenario(ctx, file, name) {
  if (!existsSync(fileURLToPath(new URL(file, import.meta.url)))) {
    await ctx.check(name, async () => ({ status: 'blocked', reason: `${file} is not available yet.` }))
    return null
  }
  const action = (await import(file))[name]
  assert.equal(typeof action, 'function', `Scenario export ${name} is required`)
  return action
}
try {
  const distribution = createPwaServer({ directory: dist })
  server = createServer((request, response) => {
    if (!originAvailable) { blockedOriginRequests++; request.socket.destroy(); return }
    distribution.emit('request', request, response)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const baseURL = `http://127.0.0.1:${server.address().port}/pletina/`
  for (const profile of requested) {
    const spec = PROFILES[profile]
    const report = { profile, engine: spec.engine, checks: [], errors: [], build, providerMode: 'fixture', host: summary.host }
    summary.profiles.push(report)
    let ctx, platformTransport
    try {
      if (spec.engine === 'webkit') {
        const { createWebKitNetworkTransport } = await import('./webkit-network-transport.mjs')
        platformTransport = await createWebKitNetworkTransport()
      }
      if (spec.engine === 'chromium') {
        const puppeteer = require(option('--puppeteer', 'puppeteer-core'))
        report.puppeteerVersion = require(option('--puppeteer', 'puppeteer-core') + '/package.json').version
        puppeteerBrowser = await puppeteer.launch({ headless: true, defaultViewport: null, executablePath: executable('chromium') ?? playwright.chromium.executablePath(),
          args: ['--mute-audio'], timeout: 20000 })
        browser = await playwright.chromium.connectOverCDP(puppeteerBrowser.wsEndpoint(), { timeout: 20000 })
      } else browser = await playwright[spec.engine].launch({ headless: true, timeout: 20000 })
      report.browserVersion = browser.version()
      ctx = await createHarness({ browser, baseURL, profile, engine: spec.engine, directory: join(output, profile), report, networkAvailability,
        ...(spec.engine === 'chromium' ? { networkTransport: chromiumBridge } : {}),
        ...(platformTransport ? { contextOptions: platformTransport.contextOptions, networkTransport: platformTransport.connect } : {}) })
      if (suite === 'all') {
        const installation = await loadScenario(ctx, './installation-scenarios.mjs', 'runInstallationScenarios')
        if (installation) await installation(ctx)
      }
      const opened = await ctx.check('setup.open: install shell and open compiled application', ctx.open)
      if (!opened) { await blockRemaining(ctx, 'The compiled application did not open; dependent feature cases were not executed.'); continue }
      const controlled = await fixtureGate(ctx)
      if (!controlled) { await blockRemaining(ctx, 'Strict provider-fixture gate failed. Live provider data cannot verify deterministic feature scenarios.'); continue }
      if (suite === 'smoke') await smoke(ctx)
      let library
      if (suite === 'library' || suite === 'all') {
        library = await loadScenario(ctx, './library-scenarios.mjs', 'runLibraryScenarios')
        if (library) await library(ctx)
      }
      if (suite === 'responsive' || suite === 'all') {
        const responsive = await loadScenario(ctx, './responsive-scenarios.mjs', 'runResponsiveScenarios')
        if (responsive) await responsive(ctx)
      }
      if (suite === 'media' || suite === 'all') {
        const media = await loadScenario(ctx, './media-scenarios.mjs', 'runMediaScenarios')
        if (media) await media(ctx, { scenarioIds: selectedMedia })
      }
      if (suite === 'all' && library) {
        const { runLibraryHistoryScenario } = await import('./library-scenarios.mjs')
        if (runLibraryHistoryScenario) await runLibraryHistoryScenario(ctx)
      }
    } catch (error) {
      const unavailable = !ctx && /executable|browser.*launch|spawn|not installed/i.test(error.message)
      report.checks.push({ name: ctx ? 'suite.execution' : 'setup.browser', status: unavailable ? 'blocked' : 'fail', error: scrub(error.message) })
      report.counts = Object.fromEntries(['pass', 'fail', 'blocked', 'unsupported'].map(status => [status, report.checks.filter(check => check.status === status).length]))
    } finally {
      await ctx?.close()
      await browser?.close().catch(() => {})
      await puppeteerBrowser?.close().catch(() => {})
      if (platformTransport) {
        report.networkTransportClosed = false
        try { await platformTransport.close(); report.networkTransportClosed = true }
        catch (error) { report.errors.push({ name: 'NetworkTransportCleanupError', message: scrub(error.message) }) }
      }
      report.browserClosed = !browser?.isConnected()
      if (spec.engine === 'chromium') report.puppeteerBrowserClosed = !puppeteerBrowser?.connected
      browser = null
      puppeteerBrowser = null
      if (report.errors.length) summary.errors.push(...report.errors.map(error => ({ profile, ...error })))
      await mkdir(join(output, profile), { recursive: true })
      await writeFile(join(output, profile, 'report.json'), JSON.stringify(report, null, 2) + '\n')
      await persist()
    }
  }
} catch (error) { summary.errors.push({ message: scrub(error.message) }) }
finally {
  await browser?.close().catch(() => {})
  await puppeteerBrowser?.close().catch(() => {})
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
  summary.serverClosed = !server?.listening
  summary.finishedAt = new Date().toISOString()
  await persist()
  summary.browserFeatureChecksPassed = summary.profiles.length === requested.length && summary.profiles.every(profile =>
    profile.checks.length > 0 && profile.checks.every(check => check.status === 'pass')) && summary.unexpectedErrors.length === 0
  await persist()
  await mkdir(join(workspace, 'artifacts/pwa-e2e'), { recursive: true })
  await writeFile(join(workspace, 'artifacts/pwa-e2e/latest.json'), JSON.stringify({ build, suite, directory: output,
    summary: join(output, 'summary.json'), allRequestedPlatformsVerified: false }, null, 2) + '\n')
  console.log(JSON.stringify({ output, build, counts: summary.counts, platformCounts: summary.platformCounts, browserFeatureChecksPassed: summary.browserFeatureChecksPassed,
    allRequestedPlatformsVerified: false }, null, 2))
  if (summary.counts.fail || summary.counts.blocked || summary.unexpectedErrors.length) process.exitCode = 1
}
