import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
const workspace = 'C:/Users/iunan/.codex/worktrees/pwa-0-11-2-port/musify'
const output = 'D:/tmp/pletina-welcome-release/harness-standalone-cc8c27ed537f3353'
await mkdir(output, { recursive: true }); await mkdir(join(output, 'browser-temp'), { recursive: true })
process.env.TEMP = join(output, 'browser-temp'); process.env.TMP = process.env.TEMP
const require = createRequire(workspace + '/package.json')
const playwright = require('playwright'), puppeteer = require('puppeteer-core')
const { createPwaServer } = await import(pathToFileURL(workspace + '/scripts/preview-pwa.mjs'))
const { createHarness, scrub } = await import(pathToFileURL(workspace + '/scripts/tests/e2e/harness.mjs'))
const report = { build: 'cc8c27ed537f3353', checks: [], errors: [],
  scope: 'Local compiled PWA, createHarness.open(), clean browser context, navigator.standalone=true init script only in top-level documents. No installation or physical-platform claim.' }
let server, pp, browser, ctx
try {
  server = createPwaServer({ directory: workspace + '/dist-pwa' })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const baseURL = `http://127.0.0.1:${server.address().port}/pletina/`
  pp = await puppeteer.launch({ headless: true, defaultViewport: null, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--mute-audio'] })
  browser = await playwright.chromium.connectOverCDP(pp.wsEndpoint())
  const transport = async ({ context, page }) => {
    const marker = 'about:blank#harness-standalone-' + crypto.randomUUID()
    const ready = pp.waitForTarget(target => target.type() === 'page' && target.url() === marker)
    await page.goto(marker)
    const source = await (await ready).page(); await source.setRequestInterception(true)
    return { pages: () => context.pages(), route: async (_pattern, handler) => {
      source.on('request', request => {
        if (request.isInterceptResolutionHandled()) return
        const wrapped = { url: () => request.url(), method: () => request.method(), resourceType: () => request.resourceType(), headers: () => request.headers(), postDataJSON: () => JSON.parse(request.postData() || '{}') }
        const route = { request: () => wrapped, continue: () => request.continue(), abort: (code = 'failed') => request.abort(code),
          fulfill: value => request.respond({ status: value.status ?? 200, headers: value.headers, contentType: value.contentType, body: value.body }) }
        Promise.resolve(handler(route)).catch(async error => { report.errors.push({ name: 'TransportError', message: scrub(error.message) }); if (!request.isInterceptResolutionHandled()) await request.abort('failed').catch(() => {}) })
      })
    } }
  }
  ctx = await createHarness({ browser, baseURL, profile: 'chromium-android-layout', directory: output, report, networkTransport: transport })
  await ctx.context.addInitScript(() => {
    if (window !== top) return
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: true })
    try { window.__qaHarnessInitialOpened = localStorage.getItem('pletina:web:opened') } catch { window.__qaHarnessInitialOpened = null }
  })
  const passed = await ctx.check('harness.open: standalone auto-entry without prior opened flag', async () => {
    const value = await ctx.open()
    assert.equal(value.automaticEntry, true); assert.equal(value.build, report.build); assert.equal(value.build, 'cc8c27ed537f3353')
    assert.equal(value.viewport.width, 393); assert.equal(value.viewport.height, 852); assert.equal(value.physicalPlatform, false)
    await ctx.page.locator('.app').waitFor(); assert.match(new URL(ctx.page.url()).pathname, /\/application\/index\.[a-f0-9]{16}\.html$/)
    const initialOpened = await ctx.page.evaluate(() => window.__qaHarnessInitialOpened)
    assert.equal(initialOpened, null)
    const visibleLandingCTAs = await ctx.page.locator('#home-screen #install:visible, #home-screen #open-player:visible').count()
    assert.equal(visibleLandingCTAs, 0)
    await ctx.page.screenshot({ path: join(output, 'standalone-current-app.png'), fullPage: true })
    return { ...value, initialOpenedFlag: initialOpened, visibleLandingCTAs, standaloneSignalEmulated: true, actualInstallationVerified: false }
  })
  report.passed = passed && report.errors.length === 0
} catch (error) { report.errors.push({ name: error.name, message: scrub(error.message) }); report.passed = false }
finally {
  await ctx?.close(); await browser?.close().catch(() => {}); await pp?.close().catch(() => {})
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
  report.browserClosed = !browser?.isConnected(); report.puppeteerClosed = !pp?.connected; report.serverClosed = !server?.listening
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ output, build: report.build, passed: report.passed, checks: report.checks, errors: report.errors,
    browserClosed: report.browserClosed, serverClosed: report.serverClosed }, null, 2))
  if (!report.passed) process.exitCode = 1
}
