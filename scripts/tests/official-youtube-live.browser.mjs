// Real provider check of the compiled PWA's explicit, visible YouTube fallback.
// No provider interception, product module replacement, hidden player or ad blocking.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createPwaServer } from '../preview-pwa.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const require = createRequire(import.meta.url)
const puppeteer = require(option('--puppeteer', 'puppeteer-core'))
const output = new URL('../../artifacts/pwa-port/', import.meta.url)
await mkdir(output, { recursive: true })
const reportName = option('--report', 'official-youtube-live.json')
assert.match(reportName, /^[a-z0-9-]+\.json$/i)
const query = option('--query', 'Pirritx eta Porrotx Iritsi da Eguna')
const report = { testedAt: new Date().toISOString(), query, build: null, checks: [], errors: [],
  scope: 'Compiled PWA, real catalog and visible official YouTube iframe in desktop Chrome. Foreground content only.',
  providerResponsesMocked: false, physicalDevice: false, backgroundVerified: false, screenOffVerified: false,
  offlinePlaybackVerified: false, outputSilencedByChromeLaunchArgument: true }
const scrub = value => String(value ?? '').replace(/https?:\/\/[^\s"'<>]+/g, '[URL]').slice(0, 350)
let browser, page, server
async function check(name, action) {
  process.stdout.write(`${name} ... `)
  try { const details = await action(); report.checks.push({ name, pass: true, ...details }); process.stdout.write('passed\n') }
  catch (error) { report.checks.push({ name, pass: false, error: scrub(error.message) }); process.stdout.write('FAILED\n'); throw error }
}
async function textClick(selector, text) {
  const handle = await page.evaluateHandle((selector, text) => [...document.querySelectorAll(selector)].find(node => node.textContent.trim() === text), selector, text)
  assert.ok(handle.asElement(), `Action ${text}`)
  await handle.asElement().click(); await handle.dispose()
}
try {
  let url = option('--url', null)
  if (!url) {
    server = createPwaServer()
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    url = `http://127.0.0.1:${server.address().port}/pletina/`
  }
  report.originKind = server ? 'ephemeral static localhost QA' : 'public HTTPS'
  browser = await puppeteer.launch({ headless: true, executablePath: option('--chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'), args: ['--mute-audio'] })
  report.browser = await browser.version()
  page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 1000 })
  page.on('pageerror', error => report.errors.push({ name: error.name, message: scrub(error.message) }))
  await check('open the expected compiled PWA', async () => {
    await page.goto(url, { waitUntil: 'load', timeout: 30000 })
    report.build = await page.$eval('#version', node => node.textContent.trim())
    if (option('--expected-build', null)) assert.equal(report.build, option('--expected-build'))
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), { timeout: 25000 })
    await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }), page.click('#open-player')])
    await page.waitForSelector('.app .sidebar', { visible: true, timeout: 20000 })
    return { build: report.build }
  })
  await check('open the selected song through the real contextual action', async () => {
    await page.type('input[aria-label="Buscar música"]', query)
    const row = '.tracks li[data-reorder-index="0"]'
    await page.waitForSelector(`${row} button.more`, { visible: true, timeout: 45000 })
    const title = await page.$eval(`${row} .name`, node => node.textContent.trim())
    if (query.includes('Iritsi da Eguna')) assert.equal(title.toLowerCase(), 'iritsi da eguna')
    report.selectedTitle = title
    await page.click(`${row} button.more`)
    await textClick('[role="menuitem"]', 'Reproducir con YouTube')
    await page.waitForSelector('dialog[data-official-youtube][open]', { visible: true, timeout: 10000 })
    return { title }
  })
  await check('choose a matching source with explicit foreground limitations', async () => {
    const dialog = 'dialog[data-official-youtube][open]'
    await page.waitForFunction(() => document.querySelector('dialog[data-official-youtube][open] [data-video-id]'), { timeout: 45000 })
    assert.equal(await page.$(`${dialog} iframe`), null, 'No video before explicit selection')
    report.dialogText = await page.$eval(dialog, node => node.textContent.replace(/\s+/g, ' ').trim().slice(0, 1000))
    assert.match(report.dialogText, /segundo plano/i)
    assert.match(report.dialogText, /descarga/i)
    await page.click(`${dialog} [data-video-id]`)
    await page.waitForSelector(`${dialog} iframe`, { visible: true, timeout: 10000 })
    const info = await page.$eval(`${dialog} iframe`, frame => {
      const url = new URL(frame.src), rect = frame.getBoundingClientRect()
      return { host: url.hostname, path: url.pathname, autoplay: url.searchParams.get('autoplay'), playsinline: url.searchParams.get('playsinline'),
        apiEnabled: url.searchParams.get('enablejsapi'), originMatches: url.searchParams.get('origin') === location.origin,
        width: rect.width, height: rect.height, referrerPolicy: frame.referrerPolicy }
    })
    assert.equal(info.host, 'www.youtube.com'); assert.equal(info.autoplay, '0'); assert.equal(info.playsinline, '1')
    assert.equal(info.apiEnabled, '1'); assert.equal(info.originMatches, true)
    assert.ok(info.width >= 200 && info.height >= 200)
    if (query.includes('Iritsi da Eguna')) assert.ok(['/embed/fV-IUsecSsU', '/embed/PStEJ1pAR6s'].includes(info.path))
    report.videoId = info.path.split('/').at(-1)
    return info
  })
  await check('the exact content advances after a real visible Play click', async () => {
    await page.evaluate(() => {
      window.__qaOfficialVideo = { ready: false, events: [] }
      const attach = () => {
        const frame = document.querySelector('dialog[data-official-youtube] iframe')
        frame.id ||= 'qa-existing-official-player'
        window.__qaOfficialVideo.player = new YT.Player(frame.id, { events: {
          onReady: () => { window.__qaOfficialVideo.ready = true },
          onError: event => window.__qaOfficialVideo.events.push({ type: 'error', code: event.data }),
          onAutoplayBlocked: () => window.__qaOfficialVideo.events.push({ type: 'autoplayBlocked' }),
        } })
      }
      if (window.YT?.Player) attach()
      else { window.onYouTubeIframeAPIReady = attach; const script = document.createElement('script'); script.src = 'https://www.youtube.com/iframe_api'; document.head.append(script) }
    })
    await page.waitForFunction(() => window.__qaOfficialVideo?.ready, { timeout: 15000 })
    const frameHandle = await page.$('dialog[data-official-youtube] iframe'), frame = await frameHandle.contentFrame()
    const before = reportName.replace('.json', '-before.png')
    await frameHandle.scrollIntoView()
    await page.screenshot({ path: fileURLToPath(new URL(before, output)), fullPage: true })
    const playSelector = '[aria-label="Reproducir vídeo"], [aria-label="Play video"], .ytp-large-play-button, .ytmCuedOverlayPlayButton'
    const play = await frame.waitForSelector(playSelector, { visible: true, timeout: 5000 }).catch(() => null)
    let gesture
    if (play) { await play.click(); gesture = { kind: 'visible DOM Play control' } }
    else {
      // The current mobile-style cued overlay has a central red Play button, as
      // observed in the preserved before/after provider-probe screenshots. Its
      // current frame box determines the viewport coordinate; never call playVideo.
      const box = await frameHandle.boundingBox()
      assert.ok(box && box.width >= 200 && box.height >= 200)
      gesture = { kind: 'central visible cued Play button', x: box.x + box.width / 2, y: box.y + box.height / 2 }
      await page.mouse.click(gesture.x, gesture.y)
    }
    report.playGesture = gesture
    const samples = []
    report.officialSamples = samples
    for (let attempt = 0; attempt < 70; attempt++) {
      const sample = await page.evaluate(() => {
        const qa = window.__qaOfficialVideo, p = qa.player
        const videoId = new URL(p.getVideoUrl()).searchParams.get('v')
        return { videoId, state: p.getPlayerState(), time: p.getCurrentTime(), duration: p.getDuration(), muted: p.isMuted(), volume: p.getVolume(), events: qa.events }
      })
      samples.push(sample)
      const earlier = samples.find(value => value.state === 1 && value.time > 0.1)
      if (sample.state === 1 && earlier && sample.time > 2 && sample.time > earlier.time + 1) break
      assert.equal(sample.events.filter(value => value.type === 'error').length, 0, 'No official player error')
      await new Promise(resolve => setTimeout(resolve, 300))
    }
    const last = samples.at(-1)
    assert.equal(last.videoId, report.videoId); assert.equal(last.state, 1); assert.ok(last.time > 2)
    assert.equal(last.muted, false); assert.ok(last.volume > 0)
    if (query.includes('Iritsi da Eguna')) assert.ok(Math.abs(last.duration - 170) < 2)
    const ad = await frame.evaluate(() => ({ adShowing: Boolean(document.querySelector('.ad-showing, .ad-interrupting')), badges: document.querySelectorAll('.ytp-ad-text, .ytp-ad-badge').length }))
    assert.equal(ad.adShowing, false); assert.equal(ad.badges, 0)
    const after = reportName.replace('.json', '-after.png')
    await page.screenshot({ path: fileURLToPath(new URL(after, output)), fullPage: true })
    return { samples, ad, before, after, gesture }
  })
  await check('closing destroys the video instead of leaving hidden playback', async () => {
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('dialog[data-official-youtube][open] iframe'), { timeout: 5000 })
    assert.equal(await page.$('dialog[data-official-youtube] iframe'), null)
    return { iframeRemoved: true }
  })
} catch (error) { report.failure = { name: error.name, message: scrub(error.message) }; process.exitCode = 1 }
finally {
  if (browser) { await browser.close(); report.browserClosed = true }
  if (server) { await new Promise(resolve => server.close(resolve)); report.staticQaServerClosed = true }
  report.finishedAt = new Date().toISOString()
  await writeFile(new URL(reportName, output), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ build: report.build, passed: report.checks.filter(value => value.pass).length, failed: report.checks.filter(value => !value.pass).length, report: reportName }))
}
