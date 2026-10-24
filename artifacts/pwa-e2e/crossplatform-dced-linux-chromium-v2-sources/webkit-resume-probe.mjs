// Observe native play() promises and events during trusted pause/resume after seeking AAC.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createPwaServer } from '../../preview-pwa.mjs'
import { createHarness } from './harness.mjs'
import { createWebKitNetworkTransport } from './webkit-network-transport.mjs'
const { webkit } = await import('playwright')
const args = process.argv.slice(2)
const dist = args.includes('--dist') ? resolve(args[args.indexOf('--dist') + 1]) : fileURLToPath(new URL('../../../dist-pwa/', import.meta.url))
const output = args.includes('--output') ? resolve(args[args.indexOf('--output') + 1]) : fileURLToPath(new URL('../../../artifacts/pwa-e2e/webkit-resume-restore-probe/', import.meta.url))
const server = createPwaServer({ directory: dist })
let browser, transport, ctx
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  transport = await createWebKitNetworkTransport(); browser = await webkit.launch({ headless: true })
  ctx = await createHarness({ browser, baseURL: `http://127.0.0.1:${server.address().port}/pletina/`,
    profile: { id: 'webkit-iphone-layout', context: transport.contextOptions },
    directory: output,
    networkTransport: transport.connect, report: { host: { platform: process.platform, arch: process.arch }, checks: [], errors: [] } })
  await ctx.page.addInitScript(() => {
    const original = HTMLMediaElement.prototype.play
    window.__qaPlayPromises = []
    HTMLMediaElement.prototype.play = function(...args) {
      const row = { at: performance.now(), time: this.currentTime, state: 'pending' }
      window.__qaPlayPromises.push(row)
      const result = Reflect.apply(original, this, args)
      result.then(() => { row.state = 'resolved'; row.settledAt = performance.now() }, error => { row.state = error.name; row.settledAt = performance.now() })
      return result
    }
  })
  await ctx.check('resume.setup: real RSS AAC and trusted seek', async () => {
    await ctx.open(); await ctx.fillSearch('Podcasts', ctx.fixture.media.rss.query)
    await ctx.tap('[aria-label="Resultados de pódcasts"] .card button.hit[aria-label="Podcast QA RSS"]')
    await ctx.tap('.episodes li:nth-child(1) .episode-play')
    await ctx.page.waitForFunction(() => window.__qaAudio.instances.some(audio => !audio.paused && audio.currentTime > .2))
    await ctx.page.locator('.mini button[aria-label="Pausa"]').waitFor()
    await ctx.tap('.mini button.open')
    const box = await ctx.page.locator('.np input[aria-label="Posición"]').boundingBox()
    await ctx.page.mouse.click(box.x + box.width * .1, box.y + box.height / 2)
    await ctx.page.waitForFunction(() => window.__qaAudio.instances.some(audio => !audio.seeking && audio.currentTime >= 8))
    await ctx.tap('.np > header > button[title="Cerrar (Esc)"]')
    return ctx.snapshot()
  })
  await ctx.check('resume.observation: audio progression, UI and native promise settlement', async () => {
    const trials = []
    for (let i = 0; i < 5; i++) {
      await ctx.tap('.mini button[aria-label="Pausa"]')
      await ctx.page.waitForFunction(() => window.__qaAudio.instances.every(audio => audio.paused))
      await ctx.page.reload({ waitUntil: 'load' })
      await ctx.page.locator('.bottom-nav').waitFor()
      await ctx.tap('.mini button[aria-label="Reproducir"]')
      await ctx.page.locator('.mini button[aria-label="Pausa"]').waitFor()
      await ctx.tap('.mini button[aria-label="Pausa"]')
      await ctx.page.waitForFunction(() => window.__qaAudio.instances.every(audio => audio.paused))
      await ctx.page.waitForTimeout(1500)
      const mark = await ctx.page.evaluate(() => window.__qaAudio.events.length)
      const before = await ctx.page.evaluate(() => window.__qaAudio.instances[0].currentTime)
      await ctx.tap('.mini button[aria-label="Reproducir"]')
      await ctx.page.waitForFunction(time => window.__qaAudio.instances.some(audio => !audio.paused && audio.currentTime > time + .3), before)
      // Allow the product to observe two genuine timeupdate samples after a resumed seek.
      await ctx.page.locator('.mini button[aria-label="Pausa"]').waitFor({ timeout: 2000 }).catch(() => {})
      const trial = await ctx.page.evaluate(mark => ({ audioTime: window.__qaAudio.instances[0].currentTime,
        pauseButtonVisible: Boolean(document.querySelector('.mini button[aria-label="Pausa"]')),
        artistText: document.querySelector('.mini .artist')?.textContent,
        playPromises: window.__qaPlayPromises, events: window.__qaAudio.events.slice(mark),
      }), mark)
      trials.push(trial)
      if (!trial.pauseButtonVisible) break
    }
    const stuck = trials.find(trial => !trial.pauseButtonVisible)
    ctx.report.resumeObservations = trials
    assert.equal(Boolean(stuck), false, 'Audio advances after trusted resume while the application UI remains loading')
    return { trials }
  })
  if (ctx.report.checks.some(check => check.status === 'fail')) process.exitCode = 1
} finally {
  await ctx?.close(); await browser?.close(); await transport?.close()
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
}
