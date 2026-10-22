// Temporary QA runner. Imports existing product-independent E2E installation scenarios.
// Does not build, publish, modify product modules, or use a personal browser profile.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const args = process.argv.slice(2)
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const workspace = resolve(option('--workspace', process.platform === 'win32'
  ? 'C:/Users/iunan/.codex/worktrees/pwa-0-11-2-port/musify'
  : '/mnt/c/Users/iunan/.codex/worktrees/pwa-0-11-2-port/musify'))
const require = createRequire(join(workspace, 'package.json'))
const browsers = option('--browsers', process.env.PLAYWRIGHT_BROWSERS_PATH)
if (browsers) process.env.PLAYWRIGHT_BROWSERS_PATH = browsers
const playwright = require('playwright')
const moduleAt = name => import(pathToFileURL(join(workspace, name)).href)
const { createPwaServer } = await moduleAt('scripts/preview-pwa.mjs')
const { createHarness, PROFILES, scrub } = await moduleAt('scripts/tests/e2e/harness.mjs')
const { runInstallationScenarios } = await moduleAt('scripts/tests/e2e/installation-scenarios.mjs')
const profiles = option('--profiles', 'webkit-iphone-layout').split(',').filter(Boolean)
for (const id of profiles) assert.ok(PROFILES[id], `Unknown profile ${id}`)
const mode = option('--mode', 'installation')
assert.ok(['installation', 'visual'].includes(mode), 'Use --mode installation or visual')
const dist = resolve(option('--dist', join(workspace, 'dist-pwa')))
const build = (await readFile(join(dist, 'sw.js'), 'utf8')).match(/const VERSION = "([a-f0-9]{16})"/)?.[1]
assert.ok(build, 'Compiled PWA build required')
if (option('--expected-build')) assert.equal(build, option('--expected-build'))
const output = resolve(option('--output', join(workspace, 'artifacts/pwa-e2e', `install-guide-${build}-${mode}`)))
await mkdir(output, { recursive: true })
const summary = { schemaVersion: 1, build, mode, startedAt: new Date().toISOString(),
  scope: 'Temporary QA importing existing installation scenarios, or compiled HTML visual probes. Desktop emulation; no physical Safari/iPhone/Android or OS installation claim.',
  host: { platform: process.platform, arch: process.arch, node: process.version }, profiles: [], errors: [] }
const safe = value => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'string' ? scrub(item) : item))
const persist = () => writeFile(join(output, 'summary.json'), JSON.stringify(safe(summary), null, 2) + '\n')
let originAvailable = true, blockedOriginRequests = 0, server, browser
const networkAvailability = {
  setAvailable(value) { originAvailable = Boolean(value) },
  snapshot: () => ({ available: originAvailable, blockedOriginRequests }),
}
async function closeServer() {
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
  summary.serverClosed = !server?.listening
}

async function visualProbe(spec, profile, baseURL, directory, report) {
  assert.equal(spec.engine, 'webkit', 'Visual probes target WebKit explicitly')
  const cases = [
    { id: 'iphone-390x844', viewport: { width: 390, height: 844 } },
    { id: 'iphone-320x568', viewport: { width: 320, height: 568 } },
    { id: 'iphone-844x390', viewport: { width: 844, height: 390 } },
    { id: 'ipad-desktop-810x1080', viewport: { width: 810, height: 1080 }, ipad: true },
  ]
  for (const item of cases) {
    const result = { id: item.id, viewport: item.viewport, status: 'fail', physical: false }
    report.checks.push(result)
    let context
    try {
      context = await browser.newContext({ ...spec.context, viewport: item.viewport, screen: item.viewport,
        ...(item.ipad ? { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15' } : {}), serviceWorkers: 'allow' })
      if (item.ipad) await context.addInitScript(() => {
        Object.defineProperty(navigator, 'platform', { configurable: true, get: () => 'MacIntel' })
        Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, get: () => 5 })
      })
      const page = await context.newPage()
      page.setDefaultTimeout(15000)
      page.on('pageerror', error => report.errors.push({ name: error.name, message: scrub(error.message), during: item.id }))
      await page.goto(baseURL, { waitUntil: 'load' })
      assert.equal((await page.locator('#version').textContent()).trim(), build)
      await page.locator('#install').click()
      await page.locator('#install-guide[open]').waitFor()
      const title = await page.locator('#guide-title').textContent()
      assert.match(title, item.ipad ? /iPad/ : /iPhone/)
      const cards = page.locator('#guide-steps > li')
      assert.equal(await cards.count(), 3, 'The iOS guide must have three visual steps')
      const metrics = await page.evaluate(() => {
        const dialog = document.querySelector('#install-guide')
        const box = dialog.getBoundingClientRect()
        const rect = element => {
          const value = element.getBoundingClientRect()
          return { x: value.x, y: value.y, width: value.width, height: value.height }
        }
        return { viewport: { width: innerWidth, height: innerHeight }, title: document.querySelector('#guide-title').textContent,
          dialog: { ...rect(dialog), clientWidth: dialog.clientWidth, scrollWidth: dialog.scrollWidth, clientHeight: dialog.clientHeight, scrollHeight: dialog.scrollHeight },
          documentOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          cards: [...document.querySelectorAll('#guide-steps > li')].map(element => ({ text: element.textContent.trim(), ...rect(element),
            svgCount: element.querySelectorAll('.guide-icon svg').length,
            icons: [...element.querySelectorAll('.guide-icon svg')].map(icon => ({ ...rect(icon), pathCount: icon.querySelectorAll('path,rect,circle,line,polyline,polygon').length })) })),
          close: rect(document.querySelector('#close-guide')),
          platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints,
        }
      })
      assert.ok(metrics.documentOverflowX <= 1, 'No horizontal document overflow')
      assert.ok(metrics.dialog.scrollWidth <= metrics.dialog.clientWidth + 1, 'No horizontal dialog clipping')
      assert.ok(metrics.dialog.x >= -1 && metrics.dialog.x + metrics.dialog.width <= item.viewport.width + 1)
      assert.ok(metrics.dialog.y >= -1 && metrics.dialog.y + metrics.dialog.height <= item.viewport.height + 1)
      assert.ok(metrics.cards.every(card => card.svgCount > 0 && card.icons.every(icon => icon.width > 0 && icon.height > 0 && icon.pathCount > 0)), 'Each visual step has a rendered inline SVG')
      const topScreenshot = `${item.id}-open.png`
      await page.screenshot({ path: join(directory, topScreenshot), fullPage: false })
      await page.locator('#install-guide').evaluate(dialog => { dialog.scrollTop = dialog.scrollHeight })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const bottom = await page.evaluate(() => {
        const dialog = document.querySelector('#install-guide'), ready = document.querySelector('.guide-ready').getBoundingClientRect(), close = document.querySelector('#close-guide').getBoundingClientRect()
        return { scrollTop: dialog.scrollTop, atBottom: Math.abs(dialog.scrollHeight - dialog.clientHeight - dialog.scrollTop) <= 2,
          readyVisible: ready.top >= 0 && ready.bottom <= innerHeight, closeVisible: close.top >= 0 && close.bottom <= innerHeight }
      })
      assert.ok(bottom.atBottom && bottom.readyVisible && bottom.closeVisible, 'Bottom content and close remain reachable')
      const bottomScreenshot = `${item.id}-bottom.png`
      await page.screenshot({ path: join(directory, bottomScreenshot), fullPage: false })
      await page.locator('#close-guide').click()
      assert.equal(await page.locator('#install-guide[open]').count(), 0)
      const closedScreenshot = `${item.id}-closed.png`
      await page.screenshot({ path: join(directory, closedScreenshot), fullPage: false })
      Object.assign(result, { status: 'pass', metrics, bottom, closed: true, screenshots: [topScreenshot, bottomScreenshot, closedScreenshot], emulatedIPadDesktopSignals: Boolean(item.ipad) })
    } catch (error) { result.error = scrub(error.message) }
    finally { await context?.close(); result.contextClosed = true }
    console.log(`${profile} ${item.id}: ${result.status}`)
  }
}

try {
  const distribution = createPwaServer({ directory: dist })
  const { createServer } = await import('node:http')
  server = createServer((request, response) => {
    if (!originAvailable) { blockedOriginRequests++; request.socket.destroy(); return }
    distribution.emit('request', request, response)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const baseURL = `http://127.0.0.1:${server.address().port}/pletina/`
  for (const profile of profiles) {
    const spec = PROFILES[profile], directory = join(output, profile)
    await mkdir(directory, { recursive: true })
    const report = { profile, engine: spec.engine, build, checks: [], errors: [], physical: false }
    summary.profiles.push(report)
    let ctx
    try {
      const chrome = option('--chrome', process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined)
      browser = await playwright[spec.engine].launch({ headless: true, timeout: 20000,
        ...(spec.engine === 'chromium' && chrome && existsSync(chrome) ? { executablePath: chrome, args: ['--mute-audio'] } : {}) })
      report.browserVersion = browser.version()
      if (mode === 'visual') await visualProbe(spec, profile, baseURL, directory, report)
      else {
        ctx = await createHarness({ browser, baseURL, profile, engine: spec.engine, directory, report, networkAvailability })
        await runInstallationScenarios(ctx)
      }
    } catch (error) { report.errors.push({ name: error.name, message: scrub(error.message) }) }
    finally {
      await ctx?.close()
      await browser?.close()
      report.browserClosed = !browser?.isConnected()
      browser = null
      report.counts = Object.fromEntries(['pass', 'fail', 'blocked', 'unsupported'].map(status => [status, report.checks.filter(check => check.status === status).length]))
      await writeFile(join(directory, 'report.json'), JSON.stringify(safe(report), null, 2) + '\n')
      await persist()
    }
  }
} catch (error) { summary.errors.push({ name: error.name, message: scrub(error.message) }) }
finally {
  await browser?.close()
  await closeServer()
  summary.finishedAt = new Date().toISOString()
  summary.counts = Object.fromEntries(['pass', 'fail', 'blocked', 'unsupported'].map(status => [status,
    summary.profiles.reduce((sum, item) => sum + (item.counts?.[status] ?? 0), 0)]))
  summary.errors.push(...summary.profiles.flatMap(report => report.errors.map(error => ({ profile: report.profile, ...error }))))
  await persist()
  console.log(JSON.stringify({ output, build, mode, counts: summary.counts, errors: summary.errors.length, serverClosed: summary.serverClosed }, null, 2))
  if (summary.counts.fail || summary.counts.blocked || summary.errors.length) process.exitCode = 1
}
