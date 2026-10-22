// Native Chromium app-window regression. No product module or platform signal is mocked.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { createPwaServer } from '../../preview-pwa.mjs'
import { createHarness, scrub } from './harness.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const workspace = fileURLToPath(new URL('../../../', import.meta.url))
const browsers = option('--browsers', process.env.PLAYWRIGHT_BROWSERS_PATH ?? (existsSync('D:/tmp/pletina-e2e-browsers') ? 'D:/tmp/pletina-e2e-browsers' : undefined))
if (browsers) process.env.PLAYWRIGHT_BROWSERS_PATH = browsers
const playwright = await import('playwright')
const require = createRequire(import.meta.url)
const puppeteer = require('puppeteer-core')
const dist = resolve(option('--dist', join(workspace, 'dist-pwa')))
const worker = await readFile(join(dist, 'sw.js'), 'utf8')
const build = worker.match(/const VERSION = "([a-f0-9]{16})"/)?.[1]
assert.ok(build, 'A compiled distribution is required')
const output = resolve(option('--output', join(workspace, 'artifacts/pwa-e2e', 'back-root-' + build)))
await mkdir(output, { recursive: true })
const chrome = option('--chrome', process.env.PLETINA_E2E_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe')
const executablePath = existsSync(chrome) ? chrome : playwright.chromium.executablePath()
const summary = { schemaVersion: 1, build, startedAt: new Date().toISOString(),
  runKind: args.includes('--probe-only') ? 'native-window-signal-preflight' : 'compiled-application-back-regression',
  host: { platform: process.platform, arch: process.arch, node: process.version }, profiles: [], errors: [],
  scope: 'Real headless Chromium desktop app window (--app), native display-mode and Audio, compiled app/SW/IDB, controlled HTTP provider responses. No OS installation, phone or Android system Back is asserted.',
  physicalInstallationVerified: false, androidSystemBackVerified: false, signalMocked: false,
  keyboardEvidence: 'AltLeft inside App is handled by App.onKeydown and calls nav.back. It is not a browser Back actuator. Only the two plain HTML control documents assess the headless browser accelerator.',
  protocolReference: 'https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setEmulatedMedia' }
let server, pw, pp, temporarySite
const persist = () => writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')

async function launch(app, baseURL) {
  pp = await puppeteer.launch({ headless: true, defaultViewport: null, executablePath,
    args: ['--mute-audio', ...(app ? ['--app=' + baseURL] : [])], timeout: 20000 })
  pw = await playwright.chromium.connectOverCDP(pp.wsEndpoint(), { timeout: 20000 })
}
async function closeBrowsers() {
  const process = pp?.process()
  const closeErrors = []
  await pw?.close().catch(error => closeErrors.push(scrub(error.message)))
  await pp?.close().catch(error => closeErrors.push(scrub(error.message)))
  if (process && process.exitCode === null && process.signalCode === null) {
    await new Promise(resolve => { const timeout = setTimeout(resolve, 3000); process.once('exit', () => { clearTimeout(timeout); resolve() }) })
  }
  const result = { browserClosed: !pw?.isConnected(), puppeteerBrowserClosed: !pp?.connected,
    browserProcessClosed: !process || process.exitCode !== null || process.signalCode !== null, closeErrors }
  pw = null; pp = null
  return result
}
async function mode(page) {
  return page.evaluate(() => ({ standalone: matchMedia('(display-mode: standalone)').matches,
    browser: matchMedia('(display-mode: browser)').matches, navigatorStandalone: navigator.standalone === true }))
}
async function probeModes(baseURL) {
  const results = []
  for (const app of [false, true]) {
    try {
      await launch(app, baseURL)
      const context = pw.contexts()[0]
      const pages = context.pages()
      const page = pages.find(page => page.url().startsWith(baseURL)) ?? pages[0] ?? await context.newPage()
      await page.goto(baseURL)
      const cdp = await context.newCDPSession(page)
      const row = { appArgument: app, browserVersion: pw.version(), before: await mode(page) }
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'display-mode', value: 'standalone' }] })
      row.afterCdpOverride = await mode(page)
      await cdp.send('Emulation.setEmulatedMedia', { features: [] })
      row.afterReset = await mode(page)
      assert.equal(row.before.standalone, app, 'The native window type supplies the signal')
      const beforeURL = new URL('/__qa_back_control__/before', baseURL).href
      const afterURL = new URL('/__qa_back_control__/after', baseURL).href
      await page.goto(beforeURL); await page.goto(afterURL)
      await page.locator('button').click()
      await page.keyboard.press('Alt+ArrowLeft')
      let navigated = true
      try { await page.waitForURL(beforeURL, { timeout: 1000 }) } catch { navigated = false }
      row.keyboardBack = { status: navigated ? 'pass' : 'blocked', navigated,
        reason: navigated ? 'Keyboard accelerator traversed browser history.' : 'Headless Chrome delivered trusted DOM key events but did not execute the browser Back accelerator, including in a normal-window positive control.',
        observed: await page.evaluate(() => ({ path: location.pathname, keys: window.__qaControlKeys })),
        physicalBackClaimed: false }
      if (!navigated) {
        await page.evaluate(() => history.back())
        await page.waitForFunction(url => location.href === url, beforeURL, { timeout: 5000 })
        await page.locator('button').waitFor()
        row.keyboardBack.apiControlTraversed = true
      }
      results.push(row)
    } finally { Object.assign(results.at(-1) ?? {}, await closeBrowsers()) }
  }
  return results
}
async function bridge({ context, page, report }) {
  const marker = 'about:blank#back-root-' + crypto.randomUUID()
  const target = pp.waitForTarget(target => target.type() === 'page' && target.url() === marker, { timeout: 15000 })
  await page.goto(marker)
  const sourcePage = await (await target).page()
  assert.ok(sourcePage)
  await sourcePage.setRequestInterception(true)
  report.networkTransport = 'Puppeteer HTTP interception and Playwright UI; production modules and service worker retained.'
  return { pages: () => context.pages(), setOffline: value => sourcePage.setOfflineMode(value),
    route: async (_pattern, handler) => {
      sourcePage.on('request', request => {
        if (request.isInterceptResolutionHandled()) return
        const wrapped = { url: () => request.url(), method: () => request.method(), resourceType: () => request.resourceType(),
          headers: () => request.headers(), postDataJSON: () => JSON.parse(request.postData() || '{}') }
        const route = { request: () => wrapped, continue: () => request.continue(), abort: (code = 'failed') => request.abort(code),
          fulfill: value => request.respond({ status: value.status ?? 200, headers: value.headers, contentType: value.contentType, body: value.body }) }
        Promise.resolve(handler(route)).catch(async error => {
          if (page.isClosed()) return
          report.errors.push({ name: 'ProviderTransportError', message: scrub(error.message) })
          if (!request.isInterceptResolutionHandled()) await request.abort('failed').catch(() => {})
        })
      })
    } }
}
async function nativeAppBrowser(baseURL, report) {
  const real = pw.contexts()[0]
  await pp.waitForTarget(target => target.type() === 'page' && target.url().startsWith(baseURL), { timeout: 10000 })
  const pages = real.pages()
  const page = pages.find(page => page.url().startsWith(baseURL))
  assert.ok(page, 'Chrome --app must create an actual app-window target')
  report.initialWindowSignal = await mode(page)
  assert.equal(report.initialWindowSignal.standalone, true)
  const proxy = new Proxy(real, { get(target, key) {
    if (key === 'newPage') return async () => page
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  return { version: () => pw.version(), async newContext(options) {
    await page.setViewportSize(options.viewport)
    const cdp = await real.newCDPSession(page)
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...options.viewport, deviceScaleFactor: 1, mobile: true })
    await cdp.send('Emulation.setUserAgentOverride', { userAgent: options.userAgent })
    return proxy
  } }
}
async function runProfile(app, baseURL) {
  const id = app ? 'native-app-window' : 'normal-browser'
  const report = { build, checks: [], errors: [], mode: id }
  summary.profiles.push(report)
  let ctx
  try {
    await launch(app, baseURL)
    report.browserVersion = pw.version()
    ctx = await createHarness({ browser: app ? await nativeAppBrowser(baseURL, report) : pw, baseURL,
      profile: 'chromium-android-layout', engine: 'chromium', directory: join(output, id), report, networkTransport: bridge })
    report.kind = app ? 'native-desktop-app-window-mobile-layout' : 'desktop-browser-mobile-layout'
    report.lifecycle = []
    await ctx.context.exposeBinding('__qaRecordBackLifecycle', (_source, value) => {
      report.lifecycle.push({ ...value, stage: report.exitControlStage ?? null })
      if (report.lifecycle.length > 250) report.lifecycle.shift()
    })
    await ctx.context.addInitScript(() => {
      if (window !== top) return
      window.__qaBackPops = 0
      window.__qaDocumentToken = crypto.randomUUID()
      window.__qaBackEvents = []
      const record = (type, event) => {
        const state = history.state
        void window.__qaRecordBackLifecycle({ type, persisted: event?.persisted ?? null,
          path: location.pathname, documentToken: window.__qaDocumentToken,
          index: state?.index ?? null, boundary: state?.rootBoundary === true,
          rootId: state?.rootId ?? null, at: performance.now() }).catch(() => {})
      }
      for (const type of ['pageshow', 'pagehide', 'popstate']) addEventListener(type, event => record(type, event))
      for (const type of ['back', 'forward']) {
        const original = history[type]
        history[type] = function (...args) { record('history.' + type); return original.apply(this, args) }
      }
      addEventListener('popstate', event => {
        window.__qaBackPops++
        const s = event.state
        window.__qaBackEvents.push({ sequence: window.__qaBackPops, session: s?.session, index: s?.index,
          overlay: s?.overlay, boundary: s?.rootBoundary === true, protected: s?.protectedRoot === true,
          route: s?.snapshot?.stack[s?.index]?.name, at: performance.now() })
        if (window.__qaBackEvents.length > 64) window.__qaBackEvents.shift()
      })
    })
    const { page, check, tap } = ctx
    // An earlier Pletina installer may auto-open its optional app in standalone mode.
    // This real external control document measures leaving the app without that redirect.
    const priorURL = app ? new URL('/__qa_back_control__/before', baseURL).href : baseURL + '?back-root-prior=1'
    const opened = await check('back.open: compiled application retains the native window mode', async () => {
      if (app) {
        // Starting outside the service-worker scope must not race the first shell install.
        report.bootstrapStage = 'prepare-controller'
        await page.goto(baseURL, { waitUntil: 'load' })
        await page.evaluate(() => navigator.serviceWorker.ready)
        if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) await page.reload({ waitUntil: 'load' })
        await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
      }
      report.bootstrapStage = 'prior-document'
      await page.goto(priorURL)
      report.bootstrapStage = 'open-application'
      try { await ctx.open() }
      catch (error) {
        report.bootstrapWorker = await page.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration()
          return { controller: Boolean(navigator.serviceWorker.controller), readyState: document.readyState,
            registration: registration ? { active: registration.active?.state, waiting: registration.waiting?.state,
              installing: registration.installing?.state, scopePath: new URL(registration.scope).pathname } : null }
        }).catch(() => null)
        throw error
      }
      report.modeSignal = await mode(page)
      assert.equal(report.modeSignal.standalone, app)
      report.bootstrapStage = 'application-open'
      return { signal: report.modeSignal }
    })
    if (!opened) return
    if (args.includes('--contextual-probe')) {
      await check('back.contextual-probe: opening a long-history playlist menu retains its live action', async () => {
        report.contextualTrace = []
        const state = () => page.evaluate(() => ({ index: history.state?.index, distance: history.state?.rootDistance,
          length: history.state?.snapshot?.stack.length, route: history.state?.snapshot?.stack[history.state?.index],
          overlay: history.state?.overlay, boundary: history.state?.rootBoundary === true,
          menu: [...document.querySelectorAll('[role="menuitem"]')].map(node => node.textContent.trim()),
          confirmations: [...document.querySelectorAll('.confirm')].map(node => node.textContent.trim()),
          heading: document.querySelector('.hero h1')?.textContent.trim(), pops: window.__qaBackPops }))
        const step = async (name, fn) => {
          report.contextualTrace.push({ name, phase: 'before', ...await state() })
          await fn()
          report.contextualTrace.push({ name, phase: 'after', ...await state() })
        }
        const text = (selector, name) => ctx.clickText(selector, name)
        await ctx.fillSearch('Buscar', ctx.fixture.media.query)
        await step('track menu', () => tap('ol.tracks > li[data-reorder-index="0"] button.more'))
        await step('add to playlist', () => text('[role="menuitem"]', 'Añadir a playlist'))
        await step('new playlist', () => text('[role="menuitem"]', 'Nueva playlist'))
        await page.locator('.hero button[title="Cambiar nombre"]').waitFor()
        await tap('.hero button[title="Cambiar nombre"]')
        const title = 'E2E Contextual Probe'
        const input = page.locator('input[aria-label="Nombre de la playlist"]')
        await input.fill(title); await input.press('Enter')
        await page.waitForFunction(title => document.querySelector('.hero h1')?.textContent.trim() === title, title)
        for (let n = 0; n < 60; n++) {
          const current = await state()
          if (current.length > 32 && current.distance + current.length - current.index >= 36) break
          await ctx.tab('Tu biblioteca')
          await ctx.clickText('.items .item', title, false)
          await page.locator('.hero h1').waitFor()
        }
        const before = await state()
        report.contextualTrace.push({ name: 'before more-options rebase', ...before })
        const hero = await page.locator('.hero').elementHandle()
        await step('playlist more options', () => tap('.actions button[title="Más opciones"]'))
        report.contextualHeroRetained = await hero.evaluate(node => node.isConnected)
        report.contextualTrace.push({ name: 'hero identity after opening menu', retained: report.contextualHeroRetained, ...await state() })
        await step('delete playlist menu action', () => text('[role="menuitem"]', 'Eliminar playlist'))
        await page.locator('.confirm button').filter({ hasText: /^\s*Eliminar\s*$/ }).waitFor({ timeout: 4000 })
        assert.equal(report.contextualHeroRetained, true, 'History maintenance must retain the live playlist component')
        await text('.confirm button', 'Eliminar')
        await page.locator('.greeting').waitFor()
        return { longHistory: before.length, livePlaylistRetained: true, confirmationVisible: true, deleted: true }
      })
      return
    }
    if (app && args.includes('--library-first')) {
      const { runLibraryScenarios } = await import('./library-scenarios.mjs')
      report.libraryFirst = true
      await runLibraryScenarios(ctx)
    }
    const route = () => page.evaluate(() => {
      const state = history.state
      return { index: state?.index, name: state?.snapshot?.stack[state?.index]?.name,
        overlay: state?.overlay, boundary: state?.rootBoundary, pops: window.__qaBackPops }
    })
    async function traverse(direction, expected) {
      const before = await page.evaluate(() => window.__qaBackPops)
      await page.evaluate(direction => history[direction](), direction)
      await page.waitForFunction(({ before, expected }) => {
        const s = history.state, r = s?.snapshot?.stack[s?.index]
        return window.__qaBackPops > before && s?.overlay === false && !s?.rootBoundary && r?.name === expected
      }, { before, expected })
      await ctx.settle()
      if (expected === 'home') await page.locator('.greeting').waitFor()
      if (expected === 'search') await page.locator('input[aria-label="Buscar música"]').waitFor()
    }
    async function protectedBack(delta = -1) {
      const before = await page.evaluate(() => window.__qaBackPops)
      await page.evaluate(delta => history.go(delta), delta)
      await page.waitForFunction(before => {
        const s = history.state
        return window.__qaBackPops > before && s?.index === 0 && s?.overlay === false &&
          s?.protectedRoot === true && !s?.rootBoundary && s?.snapshot?.stack[0]?.name === 'home'
      }, before)
      await ctx.settle()
      const events = await page.evaluate(before => window.__qaBackEvents.filter(event => event.sequence > before), before)
      assert.ok(events.some(event => event.boundary), 'Back must actually traverse the root sentinel')
      assert.equal(events.at(-1).boundary, false)
      assert.equal(events.at(-1).protected, true)
      assert.equal(events.at(-1).route, 'home')
      assert.ok(events.every(event => event.session === events[0].session))
      return events
    }
    async function root() {
      for (let n = 0; n < 128 && (await route()).index > 0; n++) {
        const before = (await route()).index
        await page.evaluate(() => history.back())
        await page.waitForFunction(before => history.state?.index < before && !history.state?.overlay && !history.state?.rootBoundary, before)
        await ctx.settle()
      }
      assert.deepEqual({ index: (await route()).index, name: (await route()).name }, { index: 0, name: 'home' })
      await page.locator('.greeting').waitFor()
    }
    let identity
    const capture = async () => ({ document: await page.evaluateHandle(() => document),
      audio: await page.evaluateHandle(() => window.__qaAudio.instances.find(audio => !audio.paused)) })
    async function advancingSame() {
      assert.ok(identity)
      assert.equal(await page.evaluate(({ document: previous, audio }) => document === previous &&
        window.__qaAudio.instances.length === 1 && window.__qaAudio.instances[0] === audio && !audio.paused && !audio.error,
      identity), true, 'Back must retain the same document and native Audio')
      const time = await identity.audio.evaluate(audio => audio.currentTime)
      await page.waitForFunction(({ audio, time }) => !audio.paused && !audio.error && audio.currentTime > time + 0.1, { audio: identity.audio, time })
      return { sameDocument: true, sameAudio: true, advanced: true, time: await identity.audio.evaluate(audio => audio.currentTime) }
    }
    const playing = await check('back.setup: native window mode, controlled RSS and real audio', async () => {
      await ctx.fillSearch('Buscar', ctx.fixture.media.query)
      const row = page.locator('ol.tracks > li[data-reorder-index]').first()
      await row.waitFor()
      assert.equal((await row.locator('.name').textContent()).trim(), ctx.fixture.tracks[0].title)
      assert.ok(ctx.fixture.requests.some(request => request.host === 'api.deezer.com' && request.path === '/search/track'))
      await ctx.fillSearch('Podcasts', ctx.fixture.media.rss.query)
      const show = page.locator('[aria-label="Resultados de pódcasts"] .hit[aria-label=' + JSON.stringify(ctx.fixture.media.rss.showTitle) + ']')
      await tap(show); await page.locator('.episodes .episode-play').first().waitFor()
      await tap(page.locator('.episodes .episode-play').first())
      await page.waitForFunction(() => window.__qaAudio.instances.length === 1 && window.__qaAudio.instances[0].currentTime > 0.2 &&
        !window.__qaAudio.instances[0].paused && !window.__qaAudio.instances[0].error)
      await page.locator('.mini button[aria-label="Pausa"]').waitFor()
      await root()
      identity = await capture()
      return { signal: report.modeSignal, root: await route(), ...await advancingSame(), physicalInstallationVerified: false }
    })
    if (!playing) return
    if (!app) {
      await check('back.browser: normal root Back can leave the application', async () => {
        await Promise.all([page.waitForURL(priorURL), page.evaluate(() => history.back())])
        await page.locator('#open-player').waitFor()
        assert.equal(await page.locator('.app').count(), 0)
        return { previousDocumentRestored: true, applicationExited: true, signal: await mode(page), physicalAndroidBackClaimed: false }
      })
      return
    }
    await check('back.root: isolated history Back rearms after the exit window and keeps audio and document', async () => {
      const observations = []
      for (let n = 0; n < 5; n++) { const events = await protectedBack(); observations.push({ events, ...await route(), ...await advancingSame() }) }
      return { observations }
    })
    await check('back.search-forward: Back reaches Home and Forward restores search', async () => {
      await ctx.fillSearch('Buscar', ctx.fixture.media.query)
      await page.locator('ol.tracks > li[data-reorder-index]').first().waitFor()
      await traverse('back', 'home'); await advancingSame()
      await traverse('forward', 'search')
      assert.equal(await page.locator('input[aria-label="Buscar música"]').inputValue(), ctx.fixture.media.query)
      await traverse('back', 'home')
      return advancingSame()
    })
    await check('back.overlays: queue then now-playing close without losing Forward', async () => {
      await tap('.mini button.open')
      await tap('.np .extras button:has-text("Cola")')
      await page.locator('.queue-sheet .queue-panel').waitFor()
      let before = await page.evaluate(() => window.__qaBackPops)
      await page.evaluate(() => history.back())
      await page.locator('.queue-sheet .queue-panel').waitFor({ state: 'hidden' })
      await page.locator('.np').waitFor()
      await page.waitForFunction(before => window.__qaBackPops > before && history.state?.overlay === true && history.state?.preparedOverlay === true, before)
      before = await page.evaluate(() => window.__qaBackPops)
      await page.evaluate(() => history.back())
      await page.locator('.np').waitFor({ state: 'hidden' })
      await page.waitForFunction(before => window.__qaBackPops > before && history.state?.index === 0 && history.state?.overlay === false &&
        !history.state?.rootBoundary && history.state?.snapshot?.stack[0]?.name === 'home', before)
      await traverse('forward', 'search')
      assert.equal(await page.locator('input[aria-label="Buscar música"]').inputValue(), ctx.fixture.media.query)
      await traverse('back', 'home')
      return advancingSame()
    })
    await check('back.overlay-traversal: go(-2) crosses the boundary and closes the overlay', async () => {
      await tap('.mini button.open'); await page.locator('.np').waitFor()
      const events = await protectedBack(-2)
      await page.locator('.np').waitFor({ state: 'hidden' })
      await advancingSame()
      await traverse('forward', 'search')
      assert.equal(await page.locator('input[aria-label="Buscar música"]').inputValue(), ctx.fixture.media.query)
      await traverse('back', 'home')
      return { events, ...await advancingSame() }
    })
    await check('back.reload: overlay reload restores paused state and one Back reaches Home', async () => {
      await traverse('forward', 'search')
      await tap('.mini button.open'); await page.locator('.np').waitFor()
      const oldDocument = await page.evaluate(() => window.__qaDocumentToken)
      await page.reload({ waitUntil: 'load' })
      await page.locator('.app').waitFor()
      assert.notEqual(await page.evaluate(() => window.__qaDocumentToken), oldDocument)
      await page.waitForFunction(() => history.state?.overlay === false)
      assert.equal(await page.locator('.np').count(), 0)
      assert.equal(await page.evaluate(() => window.__qaAudio.instances.every(audio => audio.paused)), true)
      await tap('.mini button[aria-label="Reproducir"]')
      await page.waitForFunction(() => window.__qaAudio.instances.some(audio => !audio.paused && audio.currentTime > 0.2))
      identity = await capture()
      await traverse('back', 'home')
      await advancingSame()
      for (let n = 0; n < 3; n++) await protectedBack()
      await advancingSame(); await traverse('forward', 'search')
      return { documentReloaded: true, restoredPaused: true, forwardRestored: true, ...await advancingSame() }
    })
    await check('back.double-root: two quick history Back gestures leave the app and Forward can restore it', async () => {
      report.exitControlStage = 'fresh-predecessor'
      // A long library session can prune the original external document from Chrome's
      // history. Keep all earlier long-session checks, then create a recent real predecessor
      // for the exit control; API back cannot simulate the OS action beyond an empty history.
      await page.goto(priorURL, { waitUntil: 'load' })
      await page.goto(ctx.getappURL(), { waitUntil: 'load' })
      await page.locator('.app').waitFor()
      await page.locator('.greeting').waitFor()
      await page.locator('.mini button[aria-label="Reproducir"]').click()
      await page.waitForFunction(() => window.__qaAudio.instances.length === 1 && !window.__qaAudio.instances[0].paused &&
        window.__qaAudio.instances[0].currentTime > 0.2 && !window.__qaAudio.instances[0].error)
      identity = await capture()
      const time = await identity.audio.evaluate(audio => audio.currentTime)
      report.exitControlStage = 'first-back'
      await page.evaluate(() => history.back())
      await page.waitForFunction(() => history.state?.rootBoundary === true)
      const departed = page.waitForURL(priorURL, { waitUntil: 'commit', timeout: 10000 })
      void departed.catch(() => {}) // El evaluate también puede fallar antes de que se espere esta promesa.
      const first = await page.evaluate(({ document: previous, audio, time }) => {
        const s = history.state, last = window.__qaBackEvents.findLast(event => event.boundary)
        const value = { sameDocument: document === previous, sameAudio: window.__qaAudio.instances[0] === audio,
          audioPlaying: !audio.paused && !audio.error, time: audio.currentTime, previousTime: time,
          route: s?.snapshot?.stack[s?.index]?.name, boundary: s?.rootBoundary === true,
          elapsedSinceFirstBack: performance.now() - last.at, historyLength: history.length }
        if (!value.sameDocument || !value.sameAudio || !value.audioPlaying || !value.boundary || value.route !== 'home') {
          throw new Error('The first root Back must preserve the live application and its audio on the sentinel')
        }
        history.back()
        return value
      }, { ...identity, time })
      report.firstExitBack = first
      await departed
      report.exitControlStage = 'departed'
      assert.ok(first.elapsedSinceFirstBack < 800, 'The second gesture must reach the browser during the 800 ms exit window')
      await page.locator('button').waitFor()
      assert.equal(await page.locator('.app').count(), 0, 'The real previous control document must replace the application')
      report.exitControlStage = 'forward-return'
      await Promise.all([page.waitForURL(ctx.getappURL(), { waitUntil: 'commit' }), page.evaluate(() => history.forward())])
      await page.locator('.app').waitFor()
      await page.waitForFunction(() => history.state?.index === 0 && history.state?.overlay === false &&
        history.state?.protectedRoot === true && !history.state?.rootBoundary)
      await page.locator('.greeting').waitFor()
      report.exitControlStage = 'first-back-after-forward'
      const returnedDocument = await page.evaluate(() => window.__qaDocumentToken)
      await protectedBack()
      assert.equal(page.url(), ctx.getappURL())
      assert.equal(await page.evaluate(() => window.__qaDocumentToken), returnedDocument, 'The first Back immediately after Forward must protect the returned app again')
      return { first, historyBackCallsToExit: 2, freshExternalPredecessor: true, previousDocumentRestored: true, forwardRestoredHome: true, firstBackAfterForwardProtected: true,
        actualBrowserHistoryTraversal: true, physicalAndroidBackClaimed: false,
        audioContinuationAfterExitClaimed: false, systemHomeOrMinimizeClaimed: false }
    })
  } catch (error) { report.errors.push({ name: error.name, message: scrub(error.message), stack: scrub(error.stack) }) }
  finally {
    await ctx?.close()
    Object.assign(report, await closeBrowsers())
    report.finishedAt = new Date().toISOString()
    await mkdir(join(output, id), { recursive: true })
    await writeFile(join(output, id, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  }
}
try {
  temporarySite = await mkdtemp(join(tmpdir(), 'pletina-back-root-'))
  const immutableDist = join(temporarySite, 'site')
  await cp(dist, immutableDist, { recursive: true, errorOnExist: true, force: false })
  assert.equal(await readFile(join(immutableDist, 'sw.js'), 'utf8'), worker, 'The distribution must remain unchanged while the test snapshot is copied')
  summary.distributionSnapshot = 'An isolated temporary copy is served throughout the run. The source distribution is not modified.'
  const distribution = createPwaServer({ directory: immutableDist })
  server = createServer((request, response) => {
    if (new URL(request.url, 'http://localhost').pathname.startsWith('/__qa_back_control__/')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><title>Back accelerator control</title><button>Trusted gesture</button><script>window.__qaControlKeys=[];addEventListener("keydown",e=>__qaControlKeys.push({key:e.key,alt:e.altKey,trusted:e.isTrusted}))</script>')
      return
    }
    distribution.emit('request', request, response)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const baseURL = 'http://127.0.0.1:' + server.address().port + '/pletina/'
  summary.modeProbe = await probeModes(baseURL)
  summary.browserUIBack = { status: summary.modeProbe.every(row => row.keyboardBack.navigated) ? 'pass' : 'blocked',
    scope: 'Desktop browser keyboard accelerator control, separate from DOM History API traversal and physical Android Back.' }
  summary.allRequestedBackInputsVerified = false
  if (!args.includes('--probe-only')) for (const app of args.includes('--contextual-probe') ? [true] : [true, false]) await runProfile(app, baseURL)
} catch (error) { summary.errors.push({ name: error.name, message: scrub(error.message) }) }
finally {
  await closeBrowsers()
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
  summary.serverClosed = !server?.listening
  if (temporarySite) {
    const resolvedSite = resolve(temporarySite)
    assert.equal(dirname(resolvedSite), resolve(tmpdir()), 'Cleanup is restricted to the generated temporary directory')
    assert.ok(basename(resolvedSite).startsWith('pletina-back-root-'))
    await rm(resolvedSite, { recursive: true, force: true })
  }
  summary.temporarySiteRemoved = !temporarySite || !existsSync(temporarySite)
  summary.finishedAt = new Date().toISOString()
  summary.counts = Object.fromEntries(['pass', 'fail', 'blocked', 'unsupported'].map(status => [status,
    summary.profiles.reduce((total, profile) => total + profile.checks.filter(check => check.status === status).length, 0)]))
  summary.passed = summary.serverClosed && summary.temporarySiteRemoved && summary.errors.length === 0 && summary.profiles.every(profile => profile.errors.length === 0 &&
    profile.browserClosed && profile.puppeteerBrowserClosed && profile.browserProcessClosed && profile.closeErrors.length === 0 && profile.contextClosed && profile.checks.every(check => check.status === 'pass')) &&
    (args.includes('--probe-only') || summary.profiles.length === (args.includes('--contextual-probe') ? 1 : 2))
  summary.applicationChecksExecuted = !args.includes('--probe-only')
  summary.applicationPassed = summary.applicationChecksExecuted ? summary.passed : null
  await persist()
  console.log(JSON.stringify({ output, build, counts: summary.counts, passed: summary.passed, signalMocked: false, serverClosed: summary.serverClosed }, null, 2))
  if (!summary.passed) process.exitCode = 1
}
