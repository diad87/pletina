import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const repo = 'C:/Users/iunan/.codex/worktrees/pwa-0-11-2-port/musify'
const output = join(repo, 'artifacts/pwa-e2e/install-guide-c8c217806395bf6d-visual-android')
const expectedBuild = 'c8c217806395bf6d'
const require = createRequire(join(repo, 'package.json'))
const playwrightModule = await import(pathToFileURL(require.resolve('playwright')).href)
const { chromium } = playwrightModule.default ?? playwrightModule
const { createPwaServer } = await import(pathToFileURL(join(repo, 'scripts/preview-pwa.mjs')).href)
const temp = await mkdtemp('D:/tmp/pletina-guide-android-')
const site = join(temp, 'site')
const report = { schemaVersion: 1, build: expectedBuild, requestedSourceCommit: '45850d968ecea74f1433b0f48eda66c71ca7d079',
  startedAt: new Date().toISOString(), scope: 'Chrome153 desktop, Android user agent/touch/mobile viewport, compiled production installation dialog. No physical Android or actual OS installation is claimed.',
  sourceChanged: false, applicationOpened: false, physicalAndroidVerified: false, cases: [], errors: [] }
let browser, server
const persist = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))

try {
  await mkdir(output, { recursive: true })
  await cp(join(repo, 'dist-pwa'), site, { recursive: true })
  const sw = await readFile(join(site, 'sw.js'), 'utf8')
  report.observedBuild = sw.match(/const VERSION = "([a-f0-9]{16})"/)?.[1]
  assert.equal(report.observedBuild, expectedBuild)
  server = createPwaServer({ directory: site })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const baseURL = `http://127.0.0.1:${server.address().port}/pletina/`
  browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
    args: ['--no-first-run', '--no-default-browser-check'] })
  report.browser = await browser.version()
  for (const viewport of [{ width: 393, height: 852 }, { width: 320, height: 568 }, { width: 852, height: 393 }]) {
    const id = `${viewport.width}x${viewport.height}`
    const row = { viewport, id, status: 'running', screenshots: [], errors: [] }
    report.cases.push(row)
    let context, page
    try {
      context = await browser.newContext({ viewport, screen: viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 1,
        userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36',
        serviceWorkers: 'allow' })
      await context.addInitScript(() => { window.__guideQaPromptCount = 0; addEventListener('beforeinstallprompt', () => window.__guideQaPromptCount++) })
      page = await context.newPage()
      page.on('pageerror', error => row.errors.push({ name: error.name, message: error.message }))
      await page.goto(baseURL, { waitUntil: 'load' })
      assert.equal(await page.locator('#version').textContent().catch(() => ''), expectedBuild)
      await page.locator('#install').click()
      await page.locator('#install-guide[open]').waitFor({ state: 'visible' })
      await settle(page)
      assert.equal((await page.locator('#guide-title').textContent()).trim(), 'Instalar en Android')
      const labels = (await page.locator('#guide-steps .guide-label').allTextContents()).map(s => s.trim())
      assert.deepEqual(labels, ['Más', 'Instalar y crear acceso directo', 'Instalar'])
      assert.equal(await page.locator('#guide-steps > li').count(), 3)
      assert.equal(await page.locator('#guide-steps > li .guide-icon > svg').count(), 3)
      row.title = 'Instalar en Android'
      row.labels = labels
      row.environment = await page.evaluate(() => ({ userAgent: navigator.userAgent, secureContext: isSecureContext,
        standalone: matchMedia('(display-mode: standalone)').matches, beforeInstallPromptCount: window.__guideQaPromptCount }))
      row.layout = await page.evaluate(() => {
        const dialog = document.querySelector('#install-guide'), r = dialog.getBoundingClientRect()
        return { innerWidth, innerHeight, documentClientWidth: document.documentElement.clientWidth,
          documentScrollWidth: document.documentElement.scrollWidth, dialogClientWidth: dialog.clientWidth,
          dialogScrollWidth: dialog.scrollWidth, dialogClientHeight: dialog.clientHeight, dialogScrollHeight: dialog.scrollHeight,
          dialogRect: { x: r.x, y: r.y, width: r.width, height: r.height }, horizontalOverflow: Math.max(0,
            document.documentElement.scrollWidth - document.documentElement.clientWidth, dialog.scrollWidth - dialog.clientWidth) }
      })
      assert.equal(row.layout.horizontalOverflow, 0)
      const topPath = `android-${id}-top.png`
      await page.screenshot({ path: join(output, topPath) })
      row.screenshots.push(topPath)
      row.cards = []
      for (let index = 0; index < 3; index++) {
        await page.locator('#guide-steps > li').nth(index).evaluate(card => {
          const dialog = document.querySelector('#install-guide'), heading = dialog.querySelector('.guide-heading')
          const dr = dialog.getBoundingClientRect(), cr = card.getBoundingClientRect()
          dialog.scrollTop += cr.top - dr.top - heading.getBoundingClientRect().height - 8
        })
        await settle(page)
        const card = await page.locator('#guide-steps > li').nth(index).evaluate(element => {
          const svg = element.querySelector('.guide-icon > svg'), sr = svg.getBoundingClientRect()
          const dialog = document.querySelector('#install-guide'), dr = dialog.getBoundingClientRect()
          const headerBottom = dialog.querySelector('.guide-heading').getBoundingClientRect().bottom
          return { label: element.querySelector('.guide-label').textContent.trim(), path: svg.querySelector('path').getAttribute('d'),
            svgWidth: sr.width, svgHeight: sr.height, svgFullyVisible: sr.left >= dr.left && sr.right <= dr.right &&
              sr.top >= Math.max(dr.top, headerBottom) && sr.bottom <= Math.min(innerHeight, dr.bottom) }
        })
        assert.ok(card.path.length > 0 && card.svgWidth > 0 && card.svgHeight > 0)
        assert.equal(card.svgFullyVisible, true, `Card ${index + 1} icon must be exposed below the sticky heading`)
        row.cards.push(card)
      }
      await page.locator('#install-guide').evaluate(dialog => { dialog.scrollTop = dialog.scrollHeight })
      await settle(page)
      row.footer = await page.locator('.guide-ready').evaluate(footer => {
        const r = footer.getBoundingClientRect(), dialog = document.querySelector('#install-guide'), dr = dialog.getBoundingClientRect(), image = footer.querySelector('img')
        return { text: footer.textContent.replace(/\s+/g, ' ').trim(), imageLoaded: image.complete && image.naturalWidth > 0,
          fullyVisible: r.top >= dialog.querySelector('.guide-heading').getBoundingClientRect().bottom && r.bottom <= Math.min(innerHeight, dr.bottom),
          bottomReached: Math.abs(dialog.scrollHeight - dialog.clientHeight - dialog.scrollTop) <= 1 }
      })
      assert.equal(row.footer.fullyVisible, true)
      assert.equal(row.footer.imageLoaded, true)
      assert.equal(row.footer.bottomReached, true)
      const bottomPath = `android-${id}-bottom.png`
      await page.screenshot({ path: join(output, bottomPath) })
      row.screenshots.push(bottomPath)
      await page.locator('#close-guide').click()
      await page.waitForFunction(() => !document.querySelector('#install-guide').open)
      row.closeReachedFromBottom = true
      assert.equal(await page.locator('#install-guide[open]').count(), 0)
      assert.equal(row.errors.length, 0)
      row.status = 'pass'
    } catch (error) {
      row.status = 'fail'; row.failure = { name: error.name, message: error.message }
      if (page && !page.isClosed()) { const p = `android-${id}-failure.png`; await page.screenshot({ path: join(output, p) }).catch(() => {}); row.screenshots.push(p) }
    } finally {
      if (context) { await context.close(); row.contextClosed = true }
      await persist()
    }
  }
} catch (error) { report.errors.push({ name: error.name, message: error.message }) }
finally {
  if (browser) { await browser.close(); report.browserClosed = true }
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); report.serverClosed = true }
  await rm(temp, { recursive: true, force: true }); report.temporarySiteRemoved = true
  report.finishedAt = new Date().toISOString()
  report.counts = { pass: report.cases.filter(c => c.status === 'pass').length, fail: report.cases.filter(c => c.status === 'fail').length }
  report.passed = report.cases.length === 3 && report.counts.fail === 0 && report.errors.length === 0
  await persist()
  console.log(JSON.stringify({ output, build: report.build, counts: report.counts, passed: report.passed,
    browserClosed: report.browserClosed, serverClosed: report.serverClosed, temporarySiteRemoved: report.temporarySiteRemoved }))
  if (!report.passed) process.exitCode = 1
}
