import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createProviderFixtures } from './provider-fixtures.mjs'

export const PROFILES = Object.freeze({
  'chromium-android-layout': { engine: 'chromium', kind: 'desktop-emulation', physical: false,
    context: { viewport: { width: 393, height: 852 }, screen: { width: 393, height: 852 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1,
      userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36' } },
  'webkit-iphone-layout': { engine: 'webkit', kind: 'desktop-emulation', physical: false,
    context: { viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' } },
  'firefox-narrow': { engine: 'firefox', kind: 'desktop-browser-narrow', physical: false,
    context: { viewport: { width: 393, height: 852 }, hasTouch: true, deviceScaleFactor: 1 } },
  'chromium-desktop': { engine: 'chromium', kind: 'desktop-browser', physical: false,
    context: { viewport: { width: 1440, height: 900 } } },
})
export const scrub = value => String(value ?? '').replace(/https?:\/\/[^\s"'<>]+/g, '[URL]')
  .replace(/\u001b\[[0-9;]*m/g, '').slice(0, 2400)
const safe = value => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'string' ? scrub(item) : item))
const escapeRegex = text => String(text).replace(/[.*+?^$()|[\]\\]/g, '\\$&')

export async function createHarness({ browser, baseURL, profile, engine, directory, report = {}, networkTransport, networkAvailability, contextOptions = {} }) {
  const id = typeof profile === 'string' ? profile : profile.id ?? profile.name
  const spec = PROFILES[id]
  assert.ok(spec, `Unknown browser profile: ${id}`)
  await mkdir(directory, { recursive: true })
  report.profile = id
  report.host = { platform: process.platform, arch: process.arch, node: process.version }
  report.engine = engine ?? spec.engine
  report.kind = spec.kind
  report.physical = false
  report.checks ??= []
  report.errors ??= []
  report.startedAt ??= new Date().toISOString()
  const context = await browser.newContext({ ...spec.context, ...(typeof profile === 'object' ? profile.context : {}), ...contextOptions, serviceWorkers: 'allow' })
  let page, fixture, providerContext, appURL = '', closed = false, activeCheck = ''
  const persist = async () => writeFile(join(directory, 'report.json'), JSON.stringify(safe(report), null, 2) + '\n')
  const isOfflineCheck = name => /^(?:install\.offline:|media\.download-offline-reload-play-seek-from-local-service-worker$)/.test(name)
  function recordPageError(error) {
    const observedAt = Date.now()
    const entry = { name: error.name, message: scrub(error.message), observedAt, duringCheck: activeCheck || null }
    // This is an observed WebKit diagnostic for deliberate offline feed aborts.
    // An exact matching injected request is evidence; broad CORS errors remain errors.
    const feed = /^\/{1,2}feeds\.pletina\.test\/(rss|english) due to access control checks\.$/.exec(entry.message)
    if (report.engine === 'webkit' && entry.name === 'Fetch API cannot load https' && feed && isOfflineCheck(activeCheck)) {
      const request = fixture?.requests.findLast(row => row.host === 'feeds.pletina.test' && row.path === '/' + feed[1] &&
        row.injectedFailure === 'offline' && Number.isFinite(row.failureAt) &&
        observedAt >= row.failureAt && observedAt - row.failureAt <= 5000)
      if (request) entry.expectedOfflineInjection = { host: request.host, path: request.path,
        injectedFailure: request.injectedFailure, failureAt: request.failureAt }
    }
    report.errors.push(entry)
  }
  try {
    await context.addInitScript(() => {
      if (window !== top) return
      const NativeAudio = window.Audio
      const qa = window.__qaAudio = { instances: [], events: [], handlers: {} }
      let Wrapped
      Wrapped = new Proxy(NativeAudio, { construct(target, args, newTarget) {
        const audio = Reflect.construct(target, args, newTarget === Wrapped ? target : newTarget)
        const index = qa.instances.push(audio) - 1
        for (const type of ['loadstart', 'loadedmetadata', 'durationchange', 'playing', 'pause', 'ended', 'seeking', 'seeked', 'error', 'waiting', 'stalled', 'timeupdate']) {
          audio.addEventListener(type, () => {
            let local = false
            try { local = new URL(audio.currentSrc || audio.src).origin === location.origin } catch { /* No source. */ }
            qa.events.push({ type, index, at: Math.round(performance.now()), time: Number.isFinite(audio.currentTime) ? audio.currentTime : null,
              paused: audio.paused, hidden: document.hidden, error: audio.error?.code ?? null, local })
            if (qa.events.length > 2500) qa.events.splice(0, qa.events.length - 2500)
          })
        }
        return audio
      } })
      window.Audio = Wrapped
      if (navigator.mediaSession) {
        const session = navigator.mediaSession, original = session.setActionHandler
        session.setActionHandler = function (action, handler) {
          const result = Reflect.apply(original, this, [action, handler])
          qa.handlers[action] = handler
          return result
        }
      }
    })
    page = await context.newPage()
    page.setDefaultTimeout(15000)
    page.setDefaultNavigationTimeout(30000)
    page.on('pageerror', recordPageError)
    await page.clock.install()
    providerContext = networkTransport ? await networkTransport({ context, page, report }) : context
    fixture = await createProviderFixtures(providerContext, { baseURL })
  } catch (error) { fixture?.release(); await context.close().catch(() => {}); throw error }

  async function settle() {
    if (page.isClosed()) return
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await page.evaluate(async () => {
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
          await Promise.all((document.querySelector('.view')?.getAnimations() ?? []).filter(animation => animation.playState !== 'finished').map(animation => animation.finished.catch(() => {})))
        })
        return
      } catch (error) {
        if (attempt === 2 || !/Execution context was destroyed|Cannot find context with specified id/i.test(error.message)) throw error
        // The launcher performs a real document navigation. Settle its new document,
        // rather than treating disposal of the clicked document's rAF as a product failure.
        await page.waitForLoadState('domcontentloaded')
      }
    }
  }
  async function tap(value) {
    const locator = typeof value === 'string' ? page.locator(value) : value
    await settle()
    await locator.scrollIntoViewIfNeeded()
    await settle()
    await locator.click()
    await settle()
  }
  async function clickText(selector, text, exact = true) {
    const locator = page.locator(selector).filter({ hasText: exact ? new RegExp('^\\s*' + escapeRegex(text) + '\\s*$') : text }).first()
    await tap(locator)
  }
  async function tab(name) {
    if (await page.locator('.bottom-nav').count()) await clickText('.bottom-nav button', name)
    else if (name !== 'Tu biblioteca') await clickText('.sidebar nav button', name)
    await settle()
  }
  async function fillSearch(name, text) {
    const podcasts = name === 'Podcasts' || name === 'Buscar pódcasts' || name === 'Buscar podcasts'
    await tab(podcasts ? 'Podcasts' : 'Buscar')
    const input = page.locator(podcasts ? 'input[aria-label="Buscar podcasts"]' : 'input[aria-label="Buscar música"]')
    await input.waitFor({ state: 'visible' })
    await settle()
    await input.fill(text)
    assert.equal(await input.inputValue(), text)
    await settle()
  }
  async function snapshot() {
    if (page.isClosed()) return { closed: true }
    return page.evaluate(() => {
      const qa = window.__qaAudio ?? { instances: [], events: [], handlers: {} }
      const route = history.state?.snapshot?.stack[history.state?.index]
      return { path: location.pathname, online: navigator.onLine, title: document.title,
        headings: [...document.querySelectorAll('.view h1,.view h2')].map(node => node.textContent.trim()).slice(0, 12),
        navigation: { index: history.state?.index, route: route && { name: route.name, id: route.id, query: route.query }, historyLength: history.length },
        tabs: [...document.querySelectorAll('.bottom-nav button')].map(node => node.textContent.trim()),
        notices: [...document.querySelectorAll('[role="alert"],.toast,.notice')].map(node => node.textContent.trim()).slice(0, 8),
        audio: { instances: qa.instances.map((audio, index) => { let local = false; try { local = new URL(audio.currentSrc || audio.src).origin === location.origin } catch {}
          return { index, srcPresent: Boolean(audio.src), local, time: Number.isFinite(audio.currentTime) ? audio.currentTime : null,
            duration: Number.isFinite(audio.duration) ? audio.duration : null, paused: audio.paused, ended: audio.ended,
            muted: audio.muted, volume: audio.volume, readyState: audio.readyState, error: audio.error?.code ?? null } }),
          events: qa.events.slice(-100), handlers: Object.keys(qa.handlers).filter(key => typeof qa.handlers[key] === 'function') },
        viewport: { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth },
      }
    })
  }
  async function check(name, action) {
    const startedAt = new Date().toISOString()
    const errorStart = report.errors.length
    activeCheck = name
    let entry
    console.log(`[${id}] ${name} ...`)
    try {
      const details = await action()
      entry = details && ['blocked', 'unsupported'].includes(details.status)
        ? { name, startedAt, ...details }
        : { name, startedAt, status: 'pass', ...(details && typeof details === 'object' ? details : {}) }
      if (!['pass', 'fail', 'blocked', 'unsupported'].includes(entry.status)) throw new Error('Invalid scenario status')
    } catch (error) {
      const index = report.checks.length + 1
      const screenshot = `${String(index).padStart(2, '0')}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 70)}.png`
      entry = { name, startedAt, status: 'fail', error: scrub(error.message), state: await snapshot().catch(() => null) }
      await page.screenshot({ path: join(directory, screenshot), fullPage: true }).then(() => { entry.screenshot = screenshot }).catch(() => {})
    }
    if (entry.status === 'pass' && isOfflineCheck(name)) {
      for (const error of report.errors.slice(errorStart)) {
        if (!error.expectedOfflineInjection || error.duringCheck !== name) continue
        error.handledExpected = true
        error.scope = name + '.offlineFixture'
        error.handledReason = 'The offline case passed its cached UI/media assertions; this exact feed request was deliberately aborted by its offline fixture.'
        ;(report.expectedHandledNetworkErrors ??= []).push({ ...error })
      }
    }
    activeCheck = ''
    entry.finishedAt = new Date().toISOString()
    report.checks.push(safe(entry))
    report.counts = Object.fromEntries(['pass', 'fail', 'blocked', 'unsupported'].map(status => [status, report.checks.filter(check => check.status === status).length]))
    await persist()
    console.log(`[${id}] ${name}: ${entry.status}`)
    return entry.status === 'pass'
  }
  async function open() {
    const expectedBuild = report.build
    const isApplicationURL = url => /\/application\/index\.[a-f0-9]{16}\.html$/.test(url.pathname)
    try { await page.goto(baseURL, { waitUntil: 'load' }) }
    catch (error) {
      // Warm standalone entries may replace the landing document before its
      // load completes. Accept that interruption only if the real app arrives.
      if (!/interrupted by another navigation|net::ERR_ABORTED/i.test(error.message)) throw error
      await page.waitForURL(isApplicationURL)
    }
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
    let automaticEntry = false
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        automaticEntry = await page.evaluate(() => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true)
        break
      } catch (error) {
        if (attempt === 2 || !/Execution context was destroyed|Cannot find context with specified id/i.test(error.message)) throw error
        await page.waitForLoadState('domcontentloaded')
      }
    }
    if (automaticEntry) {
      await page.waitForURL(isApplicationURL)
      await page.locator('.app').waitFor()
      report.build = await page.evaluate(async workerURL => {
        const response = await fetch(workerURL, { cache: 'no-store' })
        if (!response.ok) throw new Error('The served worker could not be read')
        return (await response.text()).match(/const VERSION = "([a-f0-9]{16})"/)?.[1] ?? null
      }, new URL('sw.js', baseURL).href)
      assert.match(report.build ?? '', /^[a-f0-9]{16}$/, 'The served worker must identify the compiled distribution')
    } else report.build = await page.locator('#version').textContent().then(value => value.trim())
    if (expectedBuild) assert.equal(report.build, expectedBuild, 'The served shell must match the compiled distribution under test')
    if (!automaticEntry) {
      await settle()
      await Promise.all([page.waitForURL(isApplicationURL), page.locator('#open-player').click()])
    }
    await page.locator('.app').waitFor()
    appURL = page.url()
    await settle()
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    assert.equal(viewport.width, spec.context.viewport.width, 'The network bridge must preserve the configured Playwright viewport')
    return { build: report.build, applicationPath: new URL(appURL).pathname, viewport, automaticEntry, physicalPlatform: false }
  }
  async function goOffline(value = true) {
    const before = await page.evaluate(() => navigator.onLine).catch(() => null)
    const useOriginGate = report.engine === 'webkit' && Boolean(networkAvailability)
    const mode = useOriginGate ? 'origin-and-provider-unavailable' : 'browser-offline'
    if (useOriginGate) {
      // WebKit's protocol-offline reload fails before consulting a controlled SW
      // even in the no-routing control. Cut off the real origin instead and
      // preserve navigator.onLine: this proves cached use, not OS offline state.
      await fixture.set({ offline: value })
      networkAvailability.setAvailable(!value)
    } else if (value) {
      await fixture.set({ offline: true })
      await context.setOffline(true)
      if (report.engine === 'firefox') await fixture.suspendRoutes()
      // Chromium's PP transport has its own real CDP network-state session.
      if (providerContext !== context && providerContext.setOffline) await providerContext.setOffline(true)
    } else {
      // Restore interception while the browser remains offline: no request can
      // escape to a live provider during the handoff back to fixture routing.
      if (report.engine === 'firefox') await fixture.resumeRoutes()
      await fixture.set({ offline: false })
      if (providerContext !== context && providerContext.setOffline) await providerContext.setOffline(false)
      // The real browser online event can synchronously resume persisted jobs.
      // Its controlled provider must already be available when that happens.
      await context.setOffline(false)
    }
    const after = await page.evaluate(() => navigator.onLine).catch(() => null)
    const result = { mode, navigatorOfflineExpected: value && !useOriginGate,
      expectedNavigatorOnline: useOriginGate || !value, before, after,
      ...(useOriginGate ? { originGate: networkAvailability.snapshot() } : {}) }
    report.offlineTransitions ??= []
    report.offlineTransitions.push({ requestedOffline: value, ...result, at: new Date().toISOString() })
    return result
  }
  async function close() {
    if (closed) return
    closed = true
    fixture.release()
    networkAvailability?.setAvailable(true)
    report.finalState = await snapshot().catch(() => null)
    report.fixture = { source: fixture.source, counts: fixture.counts, requests: fixture.requests.slice(-250) }
    report.contextClosed = false
    try { await context.close(); report.contextClosed = true }
    catch (error) { report.errors.push({ name: error.name, message: scrub(error.message) }) }
    report.finishedAt = new Date().toISOString()
    await persist()
  }
  return { page, context, browser, baseURL, getappURL: () => appURL, fixture, report, engine: engine ?? spec.engine,
    profile: id, check, clickText, tap, tab, fillSearch, settle, snapshot, open, goOffline, close }
}
