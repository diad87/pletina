// Directed compiled-app regression. HTTP fixtures exercise the real modal,
// parsers, IDB, service worker and native Audio. YouTube playback is not tested.
// node scripts/tests/official-youtube.browser.mjs [--dist directory]
//   [--profiles chromium-android-layout,firefox-narrow,webkit-iphone-layout]
//   [--browsers directory] [--chrome executable] [--output directory]
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createPwaServer } from '../preview-pwa.mjs'
import { createHarness, PROFILES, scrub } from './e2e/harness.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const workspace = fileURLToPath(new URL('../../', import.meta.url))
const browsers = option('--browsers', process.env.PLAYWRIGHT_BROWSERS_PATH ?? (existsSync('D:/tmp/pletina-e2e-browsers') ? 'D:/tmp/pletina-e2e-browsers' : undefined))
if (browsers) process.env.PLAYWRIGHT_BROWSERS_PATH = browsers
const playwright = await import('playwright')
const require = createRequire(import.meta.url)
const requested = option('--profiles', 'chromium-android-layout,firefox-narrow,webkit-iphone-layout').split(',').filter(Boolean)
assert.ok(requested.length && new Set(requested).size === requested.length, 'Request at least one distinct profile')
for (const profile of requested) assert.ok(PROFILES[profile], `Unknown profile ${profile}`)
const dist = resolve(option('--dist', join(workspace, 'dist-pwa')))
const worker = await readFile(join(dist, 'sw.js'), 'utf8')
const build = worker.match(/const VERSION = "([a-f0-9]{16})"/)?.[1]
assert.ok(build, 'A compiled PWA distribution is required; this runner never rebuilds it')
const output = resolve(option('--output', join(workspace, 'artifacts/pwa-e2e', 'official-youtube-' + build + '-' + process.platform)))
await mkdir(output, { recursive: true })
const summary = { schemaVersion: 1, build, startedAt: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, node: process.version },
  scope: 'Compiled PWA and real browser DOM, trusted clicks, native AAC Audio, IDB and service worker. Synthetic HTTP search responses and a benign static document at the official embed URL. Desktop engines/layouts only.',
  youtubePlaybackVerified: false, physicalAndroidVerified: false, physicalIPhoneVerified: false,
  screenOffVerified: false, productionBackendAdded: false, profiles: [], errors: [] }
const safe = value => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'string' ? scrub(item) : item))
const persist = async () => {
  summary.counts = Object.fromEntries(['pass', 'fail', 'blocked', 'unsupported'].map(status => [status,
    summary.profiles.reduce((sum, profile) => sum + profile.checks.filter(check => check.status === status).length, 0)]))
  await writeFile(join(output, 'summary.json'), JSON.stringify(safe(summary), null, 2) + '\n')
}
const fixtureIds = { first: 'qaAudio001a', second: 'qaOfficialB', mismatch: 'qaMismatch1' }
const fixtureTrack = { id: 101, title: 'Canción QA Uno', artist: 'Artista QA Uno', album: 'Disco QA Uno', duration: 12 }
const candidates = [
  { ...fixtureTrack, videoId: fixtureIds.first },
  { ...fixtureTrack, videoId: fixtureIds.second },
  { videoId: fixtureIds.mismatch, title: 'Grabación ajena', artist: 'Autor distinto', album: 'Otro disco', duration: 480 },
]
const runs = value => ({ runs: [{ text: value }] })
const duration = value => Math.floor(value / 60) + ':' + String(value % 60).padStart(2, '0')
const musicRow = row => ({ musicResponsiveListItemRenderer: { playlistItemData: { videoId: row.videoId }, flexColumns: [
  { musicResponsiveListItemFlexColumnRenderer: { text: runs(row.title) } },
  { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [
    { text: row.artist, navigationEndpoint: { browseEndpoint: { browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_ARTIST' } } } } },
    { text: ' • ' },
    { text: row.album, navigationEndpoint: { browseEndpoint: { browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_ALBUM' } } } } },
    { text: ' • ' }, { text: duration(row.duration) },
  ] } } },
] } })
const videoRow = row => ({ videoRenderer: { videoId: row.videoId, title: runs(row.title), ownerText: runs(row.artist), lengthText: runs(duration(row.duration)) } })
const embedDocument = '<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Documento de embed controlado</title>' +
  '<style>body{margin:0;padding:12px;background:#17202a;color:white;font:16px sans-serif}button{padding:12px}</style>' +
  '<h1 style="font-size:18px">Documento de embed controlado</h1><p>Solo prueba de interfaz, sin reproductor de YouTube.</p>' +
  '<button id="control">Control QA del documento</button><output id="trusted"></output>' +
  '<script>document.getElementById("control").addEventListener("click",event=>{document.getElementById("trusted").textContent=String(event.isTrusted)})</script></html>'
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS', 'cache-control': 'no-store' }
let server, browser, puppeteerBrowser

async function chromiumBridge({ context, page, report }) {
  const marker = 'about:blank#official-youtube-' + crypto.randomUUID()
  const target = puppeteerBrowser.waitForTarget(target => target.type() === 'page' && target.url() === marker, { timeout: 15000 })
  await page.goto(marker)
  const source = await (await target).page()
  assert.ok(source, 'The disposable Playwright page must have a Puppeteer HTTP target')
  await source.setRequestInterception(true)
  report.networkTransport = 'Puppeteer HTTP interception plus Playwright DOM, unchanged production modules and service worker.'
  return { pages: () => context.pages(), setOffline: value => source.setOfflineMode(value),
    route: async (_pattern, handler) => {
      source.on('request', request => {
        if (request.isInterceptResolutionHandled()) return
        const wrapped = { url: () => request.url(), method: () => request.method(), resourceType: () => request.resourceType(),
          headers: () => request.headers(), postDataJSON: () => JSON.parse(request.postData() || '{}') }
        const route = { request: () => wrapped, continue: () => request.continue(), abort: (reason = 'failed') => request.abort(reason),
          fulfill: value => request.respond({ status: value.status ?? 200, headers: value.headers, contentType: value.contentType, body: value.body }) }
        Promise.resolve(handler(route)).catch(async error => {
          if (page.isClosed()) return
          report.errors.push({ name: 'ProviderTransportError', message: scrub(error.message) })
          if (!request.isInterceptResolutionHandled()) await request.abort('failed').catch(() => {})
        })
      })
    } }
}

function holdNextSearch(control) {
  let reached, release, delivered
  const gate = { claimed: false, closed: false, reached: new Promise(resolve => { reached = resolve }),
    released: new Promise(resolve => { release = resolve }), delivered: new Promise(resolve => { delivered = resolve }),
    claim() { this.claimed = true; reached() }, release, finish: delivered }
  control.gate = gate
  return gate
}
async function bounded(promise, message, timeout = 15000) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeout) })]) }
  finally { clearTimeout(timer) }
}

function directedTransport(underlying, requests, control) {
  return async parameters => {
    const transport = underlying ? await underlying(parameters) : parameters.context
    return { pages: () => transport.pages(),
      ...(transport.setOffline ? { setOffline: value => transport.setOffline(value) } : {}),
      route: (pattern, handler) => transport.route(pattern, async route => {
        const request = route.request(), url = new URL(request.url())
        const embed = ['www.youtube.com', 'www.youtube-nocookie.com'].includes(url.hostname) && /^\/embed\/[\w-]{11}$/.test(url.pathname)
        if (embed) {
          requests.push({ operation: 'embed-document', host: url.hostname, videoId: url.pathname.split('/').at(-1),
            autoplay: url.searchParams.get('autoplay'), resourceType: request.resourceType(), method: request.method() })
          return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8',
            headers: { 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" }, body: embedDocument })
        }
        if (['www.youtube.com', 'music.youtube.com'].includes(url.hostname) && url.pathname === '/youtubei/v1/search') {
          if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors, body: '' })
          let body
          try { body = request.postDataJSON() ?? {} } catch { body = {} }
          if (String(body.query ?? '').includes(fixtureTrack.title)) {
            const music = url.hostname === 'music.youtube.com'
            const row = { operation: music ? 'music-search' : 'web-search', candidateIds: candidates.map(row => row.videoId) }
            requests.push(row)
            const gate = control.gate && !control.gate.claimed ? control.gate : null
            if (gate) { row.delivery = 'held'; gate.claim(); await gate.released }
            const response = music
              ? { contents: { tabbedSearchResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ musicShelfRenderer: { contents: candidates.map(musicRow) } }] } } } }] } } }
              : { responseContext: { visitorData: 'fixture-visitor' }, contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: candidates.map(videoRow) } }] } } } } }
            try {
              await route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(response) })
              row.delivery = gate ? 'released-after-close' : 'delivered'
            } catch (error) {
              // Only this deliberately held response may have its real request
              // cancelled by closing the modal before HTTP delivery resumes.
              if (!gate?.closed || !/interception|intercept|cancel|abort|invalid.*id|request.*not.*found|already.*handled|disposed|target.*closed/i.test(error.message)) throw error
              row.delivery = 'cancelled-request-rejected-delivery'
            } finally { gate?.finish() }
            return
          }
        }
        return handler(route)
      }) }
  }
}

async function installObservers(context) {
  await context.addInitScript(() => {
    if (window !== top) return
    const qa = window.__officialYouTubeQA = { sourceWrites: [], clicks: [] }
    for (const method of ['put', 'add']) {
      const original = IDBObjectStore.prototype[method]
      IDBObjectStore.prototype[method] = function (...args) {
        if (this.name === 'sources' && this.transaction.db.name === 'pletina-web-library') {
          qa.sourceWrites.push({ method, trackId: args[0]?.trackId, videoId: args[0]?.choice?.videoId })
        }
        return Reflect.apply(original, this, args)
      }
    }
    document.addEventListener('click', event => {
      const button = event.target instanceof Element ? event.target.closest('[role="menuitem"],[data-official-source],#official-youtube-close,#official-youtube-retry') : null
      if (!button) return
      qa.clicks.push({ kind: button.hasAttribute('data-official-source') ? 'choose' : button.id || 'menu',
        label: button.getAttribute('role') === 'menuitem' ? button.textContent.trim() : null,
        videoId: button.getAttribute('data-video-id'), trusted: event.isTrusted })
    }, true)
  })
}

async function storedState(page) {
  return page.evaluate(async () => {
    const sources = await new Promise((resolve, reject) => {
      const open = indexedDB.open('pletina-web-library')
      open.onerror = () => reject(new Error('The library could not be read'))
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('sources', 'readonly'), get = tx.objectStore('sources').getAll()
        get.onsuccess = () => resolve(get.result.map(row => ({ trackId: row.trackId, videoId: row.choice.videoId, score: row.choice.score, verified: row.choice.verified })).sort((a, b) => a.trackId - b.trackId))
        get.onerror = () => reject(new Error('Saved source rows could not be read'))
        tx.oncomplete = () => db.close()
      }
    })
    const queue = JSON.parse(localStorage.getItem('pletina:web:queue:v1') || 'null')
    return { sources, queue: queue && { ids: queue.queue.map(item => item.track.id), order: queue.order, pos: queue.pos,
      manualId: queue.manual?.track.id ?? null }, writes: window.__officialYouTubeQA.sourceWrites.length }
  })
}

async function scenarios(ctx, requests, directory, control) {
  const { page, tap } = ctx
  const dialog = page.locator('dialog[data-official-youtube]')
  const options = dialog.locator('[data-official-source]')
  const frames = dialog.locator('iframe[data-official-video]')
  const embedCount = () => requests.filter(row => row.operation === 'embed-document').length
  const searchCount = () => requests.filter(row => row.operation.endsWith('-search')).length
  const openMenu = async () => {
    await tap(page.locator('ol.tracks > li[data-reorder-index]').first().locator('button.more'))
    await tap(page.getByRole('menuitem', { name: 'Reproducir con YouTube', exact: true }))
    await dialog.waitFor({ state: 'visible' })
  }
  const frameBounds = async () => {
    await frames.scrollIntoViewIfNeeded()
    const bounds = await frames.boundingBox(), viewport = page.viewportSize()
    assert.ok(bounds && viewport)
    const visibleWidth = Math.max(0, Math.min(viewport.width, bounds.x + bounds.width) - Math.max(0, bounds.x))
    const visibleHeight = Math.max(0, Math.min(viewport.height, bounds.y + bounds.height) - Math.max(0, bounds.y))
    assert.ok(bounds.width >= 200 && bounds.height >= 200 && visibleWidth >= 200 && visibleHeight >= 200,
      'At least 200 × 200 CSS pixels of the official frame must be visibly inside the viewport')
    return { width: bounds.width, height: bounds.height, visibleWidth, visibleHeight }
  }
  let baseline
  const opened = await ctx.check('setup.open-compiled-pwa', ctx.open)
  if (!opened) return
  const prepared = await ctx.check('setup.fixture-track-and-native-audio', async () => {
    await ctx.fillSearch('Buscar', ctx.fixture.media.query)
    const row = page.locator('ol.tracks > li[data-reorder-index]').first()
    await page.waitForFunction(title => document.querySelector('ol.tracks > li[data-reorder-index] .name')?.textContent.trim() === title, fixtureTrack.title)
    assert.ok(ctx.fixture.requests.some(row => row.host === 'api.deezer.com' && row.path === '/search/track'), 'Catalog results must be controlled HTTP data')
    await tap(row.locator('.name'))
    await page.waitForFunction(() => window.__qaAudio.instances.some(audio => !audio.paused && audio.currentTime > 0.15 && !audio.error))
    baseline = await storedState(page)
    assert.equal(baseline.sources.find(row => row.trackId === fixtureTrack.id)?.videoId, fixtureIds.first)
    assert.ok(baseline.writes > 0, 'The passive IDB observer must detect the initial native source save')
    return { trackId: fixtureTrack.id, savedVideoId: fixtureIds.first, realNativeAACAdvanced: true }
  })
  if (!prepared) return
  const modal = await ctx.check('official.menu-lists-two-matches-without-embedding-or-writing', async () => {
    await openMenu()
    assert.equal(await dialog.getAttribute('aria-label'), 'Ver en YouTube')
    await page.waitForFunction(() => document.querySelectorAll('dialog[data-official-youtube] [data-official-source]').length === 2)
    assert.deepEqual((await options.evaluateAll(nodes => nodes.map(node => node.dataset.videoId))).sort(), [fixtureIds.first, fixtureIds.second].sort())
    assert.equal(await dialog.locator(`[data-video-id="${fixtureIds.mismatch}"]`).count(), 0, 'A mismatching recording below score 45 cannot be offered')
    await ctx.settle()
    assert.equal(await frames.count(), 0, 'Opening or receiving search results cannot auto-select a video')
    assert.equal(embedCount(), 0)
    assert.ok(await page.evaluate(() => window.__qaAudio.instances.every(audio => audio.paused)), 'Opening the official player must pause native audio')
    assert.deepEqual(await storedState(page), baseline, 'Candidate searches must not change the native queue or saved source')
    const clicked = await page.evaluate(() => window.__officialYouTubeQA.clicks.find(row => row.label === 'Reproducir con YouTube'))
    assert.equal(clicked?.trusted, true, 'The public menu action must receive a trusted browser click')
    assert.ok(searchCount() >= 3, 'The native resolver plus the modal Music and WEB searches must use controlled HTTP responses')
    return { eligibleOptions: 2, belowThresholdOptionExcluded: true, embedsBeforeChoice: 0, nativeAudioPaused: true, savedSourceWrites: 0 }
  })
  if (!modal) return
  const selected = await ctx.check('official.explicit-second-choice-loads-visible-autoplay-zero-frame', async () => {
    await tap(dialog.locator(`[data-official-source][data-video-id="${fixtureIds.second}"]`))
    await frames.waitFor({ state: 'visible' })
    assert.equal(await frames.count(), 1)
    const source = new URL(await frames.getAttribute('src'))
    assert.ok(['www.youtube.com', 'www.youtube-nocookie.com'].includes(source.hostname))
    assert.equal(source.pathname, '/embed/' + fixtureIds.second)
    assert.equal(source.protocol, 'https:')
    assert.equal(source.searchParams.get('autoplay'), '0')
    assert.equal(await frames.getAttribute('title'), 'Reproductor oficial de YouTube')
    const portrait = await frameBounds()
    const frame = page.frameLocator('dialog[data-official-youtube] iframe[data-official-video]')
    await frame.getByRole('button', { name: 'Control QA del documento', exact: true }).click()
    assert.equal(await frame.locator('#trusted').textContent(), 'true')
    assert.deepEqual(requests.filter(row => row.operation === 'embed-document').map(row => row.videoId), [fixtureIds.second], 'Only the explicitly chosen recording may be embedded')
    assert.ok(requests.filter(row => row.operation === 'embed-document').every(row => row.autoplay === '0'))
    assert.deepEqual(await storedState(page), baseline)
    const choice = await page.evaluate(() => window.__officialYouTubeQA.clicks.find(row => row.kind === 'choose'))
    assert.deepEqual(choice && { videoId: choice.videoId, trusted: choice.trusted }, { videoId: fixtureIds.second, trusted: true })
    await page.screenshot({ path: join(directory, 'official-visible-frame.png'), fullPage: true })
    const originalViewport = page.viewportSize()
    let landscape
    try {
      await page.setViewportSize({ width: 852, height: 393 })
      await ctx.settle()
      landscape = await frameBounds()
      await page.screenshot({ path: join(directory, 'official-visible-frame-landscape.png'), fullPage: true })
    } finally { await page.setViewportSize(originalViewport); await ctx.settle() }
    return { videoId: fixtureIds.second, autoplay: '0', portrait, landscape,
      sandbox: await frames.getAttribute('sandbox'), allow: await frames.getAttribute('allow'),
      controlledDocumentLoaded: true, controlledDocumentTrustedClick: true, youtubePlaybackVerified: false }
  })
  if (!selected) return
  const closed = await ctx.check('official.close-destroys-frame-without-restoring-native-playback', async () => {
    const playingBefore = await page.evaluate(() => window.__qaAudio.events.filter(event => event.type === 'playing').length)
    await tap('#official-youtube-close')
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(await page.locator('iframe[data-official-video]').count(), 0)
    await ctx.settle()
    assert.ok(await page.evaluate(() => window.__qaAudio.instances.every(audio => audio.paused)))
    assert.equal(await page.evaluate(() => window.__qaAudio.events.filter(event => event.type === 'playing').length), playingBefore)
    assert.deepEqual(await storedState(page), baseline)
    return { liveOfficialFrames: 0, savedSourceWrites: 0, nativeAudioResumed: false, queuePreserved: true }
  })
  if (!closed) return
  const backed = await ctx.check('official.browser-back-closes-only-the-modal', async () => {
    const before = await page.evaluate(() => ({ path: location.pathname, index: history.state.index,
      token: window.__officialDocumentToken ??= crypto.randomUUID() }))
    await openMenu()
    await page.waitForFunction(() => document.querySelectorAll('dialog[data-official-youtube] [data-official-source]').length === 2)
    await tap(dialog.locator(`[data-official-source][data-video-id="${fixtureIds.first}"]`))
    await frames.waitFor({ state: 'visible' })
    await page.frameLocator('dialog[data-official-youtube] iframe[data-official-video]').locator('#control').waitFor()
    await page.goBack()
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(await page.locator('iframe[data-official-video]').count(), 0)
    assert.deepEqual(await page.evaluate(() => ({ path: location.pathname, index: history.state.index,
      token: window.__officialDocumentToken })), before, 'Browser Back must retain the document and underlying route')
    assert.deepEqual(await storedState(page), baseline)
    assert.ok(await page.evaluate(() => window.__qaAudio.instances.every(audio => audio.paused)))
    return { browserHistoryTraversal: true, physicalAndroidBackClaimed: false, underlyingRoutePreserved: true,
      documentPreserved: true, iframeRemoved: true, nativeAudioResumed: false }
  })
  if (!backed) return
  const cancelled = await ctx.check('official.late-search-after-close-cannot-reopen-or-select', async () => {
    const beforeSearches = searchCount(), beforeEmbeds = embedCount(), gate = holdNextSearch(control)
    try {
      await openMenu()
      await bounded(gate.reached, 'Opening the modal did not reach its held HTTP search')
      assert.equal(await options.count(), 0)
      assert.equal(await frames.count(), 0)
      await tap('#official-youtube-close')
      await dialog.waitFor({ state: 'hidden' })
      gate.closed = true
      gate.release()
      await bounded(gate.delivered, 'The held HTTP search did not finish delivery after closing')
      await page.waitForTimeout(150)
      await ctx.settle()
      assert.equal(await dialog.isVisible(), false)
      assert.equal(await page.locator('iframe[data-official-video]').count(), 0)
      assert.equal(searchCount() - beforeSearches, 1, 'Cancellation must stop the search before a subsequent provider search')
      assert.equal(embedCount(), beforeEmbeds)
      assert.deepEqual(await storedState(page), baseline)
      assert.ok(await page.evaluate(() => window.__qaAudio.instances.every(audio => audio.paused)))
      return { heldHttpSearches: 1, newEmbeds: 0, reopened: false, savedSourceWrites: 0,
        delivery: requests.findLast(row => row.operation.endsWith('-search'))?.delivery }
    } finally { gate.release(); control.gate = null }
  })
  if (!cancelled) return
  await ctx.check('official.offline-open-does-not-search-or-embed', async () => {
    const searches = searchCount(), embeds = embedCount()
    // No navigation is needed: this is the browser's real offline signal on the
    // loaded app, including WebKit. No navigator.onLine replacement is used.
    await ctx.goOffline(true)
    try {
      assert.equal(await page.evaluate(() => navigator.onLine), false)
      await openMenu()
      await page.waitForFunction(() => /conexión|sin conexión|internet|conect/i.test(document.querySelector('dialog[data-official-youtube]')?.textContent ?? ''))
      assert.equal(await frames.count(), 0)
      assert.equal(await options.count(), 0)
      assert.equal(searchCount(), searches, 'Offline opening cannot request new candidate searches')
      assert.equal(embedCount(), embeds, 'Offline opening cannot load a YouTube document')
      assert.deepEqual(await storedState(page), baseline)
      await tap('#official-youtube-close')
      await dialog.waitFor({ state: 'hidden' })
      return { navigatorOnline: false, newSearches: 0, newEmbeds: 0, savedSourceWrites: 0, offlineSignalMocked: false }
    } finally { await ctx.goOffline(false) }
  })
}

try {
  server = createPwaServer({ directory: dist })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const baseURL = `http://127.0.0.1:${server.address().port}/pletina/`
  for (const profile of requested) {
    const spec = PROFILES[profile], directory = join(output, profile)
    const report = { build, profile, engine: spec.engine, checks: [], errors: [], directedRequests: [] }
    summary.profiles.push(report)
    const control = { gate: null }
    let ctx, platformTransport, processHandle, profileDirectory
    try {
      if (spec.engine === 'webkit' && process.platform !== 'win32') {
        const { createWebKitNetworkTransport } = await import('./e2e/webkit-network-transport.mjs')
        platformTransport = await createWebKitNetworkTransport()
      }
      if (spec.engine === 'chromium') {
        const chrome = option('--chrome', process.env.PLETINA_E2E_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe')
        puppeteerBrowser = await require(option('--puppeteer', 'puppeteer-core')).launch({ headless: true, defaultViewport: null,
          executablePath: existsSync(chrome) ? chrome : playwright.chromium.executablePath(), args: ['--mute-audio'], timeout: 20000 })
        processHandle = puppeteerBrowser.process()
        profileDirectory = processHandle?.spawnargs.find(arg => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length)
        browser = await playwright.chromium.connectOverCDP(puppeteerBrowser.wsEndpoint(), { timeout: 20000 })
      } else browser = await playwright[spec.engine].launch({ headless: true, timeout: 20000 })
      report.browserVersion = browser.version()
      ctx = await createHarness({ browser, baseURL, profile, engine: spec.engine, directory, report,
        networkTransport: directedTransport(spec.engine === 'chromium' ? chromiumBridge : platformTransport?.connect, report.directedRequests, control),
        ...(platformTransport ? { contextOptions: platformTransport.contextOptions } : {}) })
      await installObservers(ctx.context)
      await scenarios(ctx, report.directedRequests, directory, control)
    } catch (error) {
      const unavailable = !ctx && /executable|browser.*launch|spawn|not installed/i.test(error.message)
      report.checks.push({ name: ctx ? 'suite.execution' : 'setup.browser', status: unavailable ? 'blocked' : 'fail', error: scrub(error.message) })
    } finally {
      control.gate?.release()
      await ctx?.close()
      await browser?.close().catch(error => report.errors.push({ name: 'BrowserCleanupError', message: scrub(error.message) }))
      await puppeteerBrowser?.close().catch(error => report.errors.push({ name: 'PuppeteerCleanupError', message: scrub(error.message) }))
      if (processHandle && processHandle.exitCode === null && processHandle.signalCode === null) {
        await new Promise(resolve => { const timer = setTimeout(resolve, 3000); processHandle.once('exit', () => { clearTimeout(timer); resolve() }) })
      }
      if (platformTransport) {
        report.networkTransportClosed = false
        try { await platformTransport.close(); report.networkTransportClosed = true }
        catch (error) { report.errors.push({ name: 'NetworkTransportCleanupError', message: scrub(error.message) }) }
      }
      report.browserClosed = !browser?.isConnected()
      if (spec.engine === 'chromium') Object.assign(report, { puppeteerBrowserClosed: !puppeteerBrowser?.connected,
        browserProcessClosed: !processHandle || processHandle.exitCode !== null || processHandle.signalCode !== null,
        ephemeralProfileRemoved: !profileDirectory || !existsSync(profileDirectory) })
      report.counts = Object.fromEntries(['pass', 'fail', 'blocked', 'unsupported'].map(status => [status, report.checks.filter(check => check.status === status).length]))
      browser = null; puppeteerBrowser = null
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'report.json'), JSON.stringify(safe(report), null, 2) + '\n')
      await persist()
    }
  }
} catch (error) { summary.errors.push({ name: error.name, message: scrub(error.message) }) }
finally {
  await browser?.close().catch(() => {})
  await puppeteerBrowser?.close().catch(() => {})
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
  summary.serverClosed = !server?.listening
  summary.finishedAt = new Date().toISOString()
  summary.featureChecksPassed = summary.profiles.length === requested.length && summary.profiles.every(report =>
    report.checks.length === 8 && report.checks.every(check => check.status === 'pass') && !report.errors.length &&
    report.contextClosed && report.browserClosed && report.networkTransportClosed !== false &&
    report.browserProcessClosed !== false && report.ephemeralProfileRemoved !== false) && !summary.errors.length
  await persist()
  console.log(JSON.stringify({ build, output, counts: summary.counts, featureChecksPassed: summary.featureChecksPassed,
    youtubePlaybackVerified: false, physicalAndroidVerified: false, physicalIPhoneVerified: false, serverClosed: summary.serverClosed }, null, 2))
  if (!summary.featureChecksPassed) process.exitCode = 1
}
