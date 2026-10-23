// Isolated cross-origin fixture transport control, no app/player code.
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { PROFILES } from '../../scripts/tests/e2e/harness.mjs'
import { createProviderFixtures } from '../../scripts/tests/e2e/provider-fixtures.mjs'
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('D:/tmp/pletina-e2e-browsers')) process.env.PLAYWRIGHT_BROWSERS_PATH = 'D:/tmp/pletina-e2e-browsers'
const { webkit } = await import('playwright')
const server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><button id="play">Play intercepted fixture AAC</button>'))
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = 'http://127.0.0.1:' + server.address().port
const report = { startedAt: new Date().toISOString(), scope: 'Native HTMLAudio with the unchanged provider fixture route; no app, player, source resolver, import or service worker code.', cases: [] }
let browser
try {
  browser = await webkit.launch({ headless: true })
  report.browserVersion = browser.version()
  for (const clockInstalled of [false, true]) {
    const context = await browser.newContext(PROFILES['webkit-iphone-layout'].context)
    const fixture = await createProviderFixtures(context, { baseURL: origin })
    const page = await context.newPage(), pageErrors = [], networkErrors = []
    page.on('pageerror', error => pageErrors.push({ name: error.name, message: error.message }))
    page.on('requestfailed', request => networkErrors.push({ host: new URL(request.url()).hostname, path: new URL(request.url()).pathname, failure: request.failure() }))
    if (clockInstalled) await page.clock.install()
    await page.goto(origin, { waitUntil: 'load' })
    await page.evaluate(() => {
      const audio = new Audio(), events = []
      window.probe = { audio, events, playResolved: false, playRejection: null }
      for (const type of ['loadstart', 'loadedmetadata', 'canplay', 'playing', 'error', 'timeupdate']) audio.addEventListener(type, () => events.push({ type, currentTime: audio.currentTime, errorCode: audio.error?.code ?? null }))
      document.querySelector('#play').onclick = () => {
        audio.src = 'https://fixture.googlevideo.com/audio/qaAudio001a?expire=' + (Math.floor(Date.now() / 1000) + 7200)
        audio.play().then(() => { window.probe.playResolved = true }).catch(error => { window.probe.playRejection = { name: error.name, message: error.message } })
      }
    })
    await page.locator('#play').click()
    let waitError = null
    await page.waitForFunction(() => window.probe.audio.currentTime > 0.25 || window.probe.audio.error || window.probe.playRejection, null, { timeout: 5000 }).catch(error => { waitError = error.message })
    const state = await page.evaluate(() => {
      const { audio, ...rest } = window.probe
      return { ...rest, currentTime: audio.currentTime, duration: Number.isFinite(audio.duration) ? audio.duration : null,
        readyState: audio.readyState, networkState: audio.networkState, error: audio.error ? { code: audio.error.code, message: audio.error.message } : null }
    })
    report.cases.push({ clockInstalled, ...state, waitError, pageErrors, networkErrors, fixtureRequests: fixture.requests })
    await context.close()
  }
} catch (error) { report.probeError = { name: error.name, message: error.message }; process.exitCode = 1 }
finally {
  await browser?.close().catch(() => {})
  await new Promise(resolve => server.close(resolve))
  report.finishedAt = new Date().toISOString()
  await writeFile(new URL('./webkit-fixture-transport-control.json', import.meta.url), JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify(report, null, 2))
