// Desktop QA only. A hidden tab is not proof that a phone display is off.
// node scripts/tests/pwa-screen-off.browser.mjs [url] [puppeteerPackage] [chromeExecutable]
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const puppeteer = require(process.argv[3] || 'puppeteer')
const target = process.argv[2] || 'https://diad87.github.io/pletina/prueba-audio/'
const output = new URL('../../artifacts/pwa-screen-off/desktop-background.json', import.meta.url)
const browser = await puppeteer.launch({
  headless: true, args: ['--mute-audio'],
  ...(process.argv[4] ? { executablePath: process.argv[4] } : {}),
})
const report = {
  testedAt: new Date().toISOString(), browser: await browser.version(),
  target, evidenceScope: 'desktop-background-tab-only',
  screenOffAutomaticallyVerified: false,
  qaAudioOutputMuted: true, qaMediaElementMuted: false,
  qaAcceleratedSeekToEndSeconds: 1,
  notes: 'The tool prepares 30 seconds. QA seeks to the final second to test transitions quickly. No physical screen-off or mobile result is claimed.',
  serviceWorker: null, cases: [], errors: [],
}

const readLog = (page) => page.evaluate(() => {
  const key = Object.keys(localStorage).find((item) => item.startsWith('pletina:screen-off:test1:'))
  return key ? JSON.parse(localStorage.getItem(key)) : null
})

try {
  const page = await browser.newPage()
  page.on('pageerror', (error) => report.errors.push({ source: 'page', name: error.name }))
  await page.goto(target, { waitUntil: 'load', timeout: 30000 })
  if (new URL(target).protocol !== 'file:') {
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), { timeout: 30000, polling: 200 })
    report.serviceWorker = await page.evaluate(async () => {
      const names = (await caches.keys()).filter((name) => name.startsWith('pletina-screen-off:'))
      const entries = []
      for (const name of names) {
        const cache = await caches.open(name)
        entries.push({ name, paths: (await cache.keys()).map((request) => new URL(request.url).pathname) })
      }
      return { controlled: Boolean(navigator.serviceWorker.controller), caches: entries }
    })
  }
  for (const mode of ['prepared', 'on-ended']) {
    const result = { mode, pipelinePass: false }
    let background
    try {
      await page.select('#mode', mode)
      await page.click('#prepare')
      await page.waitForFunction(() => !document.getElementById('start').disabled, { timeout: 45000, polling: 200 })
      result.prepared = await page.$eval('#audio', (audio) => ({ time: audio.currentTime, duration: audio.duration, paused: audio.paused }))
      await page.click('#start')
      await page.waitForFunction(() => {
        const audio = document.getElementById('audio')
        return !audio.paused && audio.currentTime > audio.duration - 29
      }, { timeout: 15000, polling: 200 })
      await page.$eval('#audio', (audio) => { audio.currentTime = audio.duration - 1 })
      await page.waitForFunction(() => !document.getElementById('audio').seeking, { timeout: 15000, polling: 100 })
      background = await browser.newPage()
      await background.goto('about:blank')
      await page.waitForFunction(() => {
        const key = Object.keys(localStorage).find((item) => item.startsWith('pletina:screen-off:test1:'))
        return JSON.parse(localStorage.getItem(key)).events.some((event) => event.event === 'next-playing')
      }, { timeout: 25000, polling: 250 })
      await new Promise((resolve) => setTimeout(resolve, 2200))
      result.audio = await page.$eval('#audio', (audio) => ({
        time: audio.currentTime, paused: audio.paused, muted: audio.muted, error: audio.error?.code || null,
      }))
      result.log = await readLog(page)
      const nextPlaying = result.log.events.find((event) => event.event === 'next-playing')
      const resolver = result.log.events.find((event) => event.event === 'resolver-start' && event.which.startsWith('next-'))
      result.noUrlsOrTokens = !/googlevideo\.com|visitorData/.test(JSON.stringify(result.log))
      result.pipelinePass = Boolean(nextPlaying?.hidden && resolver &&
        resolver.hidden === (mode === 'on-ended') && result.audio.time > 1 &&
        !result.audio.paused && !result.audio.muted && !result.audio.error &&
        !result.log.physicalScreenOffConfirmed && result.noUrlsOrTokens)
    } catch (error) {
      result.error = { name: error.name }
      result.log = await readLog(page).catch(() => null)
      result.status = await page.$eval('#status', (element) => element.textContent).catch(() => null)
    } finally {
      if (background) await background.close()
      await page.bringToFront()
      if (await page.$eval('#stop', (button) => !button.disabled)) await page.click('#stop')
    }
    report.cases.push(result)
  }
} catch (error) {
  report.errors.push({ source: 'runner', name: error.name })
} finally {
  await browser.close()
  await mkdir(new URL('./', output), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
}

console.log(JSON.stringify({
  report: fileURLToPath(output), browser: report.browser,
  scope: report.evidenceScope, serviceWorkerControlled: report.serviceWorker?.controlled,
  cases: report.cases.map(({ mode, pipelinePass, audio }) => ({ mode, pipelinePass, audio })),
  errors: report.errors,
}, null, 2))
if (report.errors.length || report.cases.length !== 2 || report.cases.some((item) => !item.pipelinePass)) process.exitCode = 1
