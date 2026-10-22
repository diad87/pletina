// Real catalog/provider check: one normal song click must open a matching, visible
// YouTube fallback and start it with sound, without a menu/source/iframe Play click.
// All DOM/media observations explicitly use CDP userGesture:false. Puppeteer's
// evaluate/$eval/waitForFunction helpers would grant activation and invalidate this test.
// node scripts/tests/automatic-youtube-live.browser.mjs [--url https://host/pletina/]
//   [--expected-build hash] [--chrome executable] [--report automatic-youtube-live.json]
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
const reportName = option('--report', 'automatic-youtube-live.json')
assert.match(reportName, /^[a-z0-9-]+\.json$/i)
const expectedBuild = option('--expected-build', null)
if (expectedBuild) assert.match(expectedBuild, /^[a-f0-9]{16}$/)
const query = 'Pirritx eta Porrotx Iritsi da Eguna'
const expectedTitle = 'Iritsi da Eguna'
const matchingVideos = ['fV-IUsecSsU', 'PStEJ1pAR6s']
const report = {
  testedAt: new Date().toISOString(), build: null, query, checks: [], errors: [], providerPlayback: [],
  scope: 'Compiled PWA, real catalog and provider, desktop Chrome, foreground automatic fallback only.',
  proofMethod: 'One real song-row mouse click; read-only CDP observations with userGesture:false; no follow-up interaction before playback proof.',
  physicalAndroidVerified: false, physicalIPhoneVerified: false, installedPwaVerified: false,
  backgroundVerified: false, screenOffVerified: false, offlinePlaybackVerified: false,
  providerResponsesMocked: false, productMethodsReplaced: false, playerSdkInjected: false,
  browserPolicyOverrides: false, outputSilencedByChromeLaunchArgument: false,
  observationRpcCalls: 0, observationRpcWithGesture: 0,
  primaryAttempt: { songRowClicks: 0, sourceClicks: 0, menuClicks: 0, iframeClicks: 0, testApiPlayCalls: 0, samples: [] },
  inputActions: [],
}
const scrub = value => String(value ?? '').replace(/https?:\/\/[^\s"'<>]+/g, '[URL]').slice(0, 350)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let browser, context, page, server
const pendingResponses = new Set()

async function noGesture(frame, fn, value = null) {
  const executionContext = frame.mainRealm().context
  if (!executionContext) throw new Error('Frame execution context is not ready')
  report.observationRpcCalls++
  const response = await frame.client.send('Runtime.callFunctionOn', {
    executionContextId: executionContext.id, functionDeclaration: fn.toString(), arguments: [{ value }],
    returnByValue: true, awaitPromise: true, userGesture: false,
  })
  if (response.exceptionDetails) throw new Error(scrub(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text))
  return response.result.value
}
const parentRead = (fn, value) => noGesture(page.mainFrame(), fn, value)
async function poll(name, action, timeout = 15000) {
  const deadline = Date.now() + timeout
  let lastError
  do {
    try { const result = await action(); if (result) return result }
    catch (error) { lastError = scrub(error.message) }
    await delay(200)
  } while (Date.now() < deadline)
  throw new Error(`${name} timed out${lastError ? ': ' + lastError : ''}`)
}
async function check(name, action) {
  process.stdout.write(`${name} ... `)
  try {
    const details = await action()
    report.checks.push({ name, pass: true, ...details })
    process.stdout.write('passed\n')
  } catch (error) {
    report.checks.push({ name, pass: false, error: scrub(error.message) })
    process.stdout.write('FAILED\n')
    throw error
  }
}
async function mouseClick(selector, purpose) {
  const center = await parentRead(selector => {
    const node = document.querySelector(selector)
    if (!node) return null
    const rect = node.getBoundingClientRect(), style = getComputedStyle(node)
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2
    if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden' ||
      x <= 0 || y <= 0 || x >= innerWidth || y >= innerHeight) return null
    const hit = document.elementFromPoint(x, y)
    if (!hit || (hit !== node && !node.contains(hit))) return null
    return { x, y }
  }, selector)
  assert.ok(center, `Visible unobstructed control for ${purpose}`)
  report.inputActions.push({ kind: 'real mouse click', purpose })
  await page.mouse.click(center.x, center.y)
}
const activation = () => parentRead(() => ({
  active: navigator.userActivation.isActive, ever: navigator.userActivation.hasBeenActive,
}))
const parentState = () => parentRead(() => {
  const dialog = document.querySelector('dialog[data-official-youtube][open]')
  const iframe = dialog?.querySelector('iframe[data-official-video]')
  let embed = null
  if (iframe) {
    const url = new URL(iframe.src), rect = iframe.getBoundingClientRect(), style = getComputedStyle(iframe)
    const width = Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left))
    const height = Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top))
    embed = { host: url.hostname, videoId: url.pathname.split('/').at(-1),
      declaredVideoId: iframe.dataset.videoId, autoplay: url.searchParams.get('autoplay'),
      playsinline: url.searchParams.get('playsinline'), apiEnabled: url.searchParams.get('enablejsapi'),
      originMatches: url.searchParams.get('origin') === location.origin,
      autoplayDelegated: iframe.allow.split(';').some(value => value.trim() === 'autoplay'),
      width: rect.width, height: rect.height, visibleFraction: rect.width * rect.height > 0 ? width * height / (rect.width * rect.height) : 0,
      visible: style.display !== 'none' && style.visibility !== 'hidden',
      referrerPolicy: iframe.referrerPolicy }
  }
  return { appPresent: Boolean(document.querySelector('.app .sidebar')), dialogOpen: Boolean(dialog), embed,
    dialogTrack: dialog?.querySelector('.track')?.textContent.trim() ?? null,
    mediaTitle: navigator.mediaSession?.metadata?.title ?? null,
    mediaPlaybackState: navigator.mediaSession?.playbackState ?? null,
    activation: { active: navigator.userActivation.isActive, ever: navigator.userActivation.hasBeenActive } }
})
const frameMedia = frame => noGesture(frame, () => {
  const media = document.querySelector('video'), player = document.querySelector('.html5-video-player')
  const visible = node => {
    const rect = node.getBoundingClientRect(), style = getComputedStyle(node)
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
  }
  // YouTube currently serves both desktop and touch embed markup to Chrome.
  // The touch title/link was observed in the real provider DOM, not inferred
  // from the requested iframe ID or Pletina's catalog label.
  const titleLink = document.querySelector('.ytp-title-link,.ytmVideoInfoVideoTitle')
  const canonical = document.querySelector('link[rel="canonical"]')
  let contentVideoId = null
  try { if (titleLink?.href) contentVideoId = new URL(titleLink.href).searchParams.get('v') } catch {}
  let canonicalVideoId = null
  try { if (canonical?.href) canonicalVideoId = new URL(canonical.href).searchParams.get('v') } catch {}
  if (!contentVideoId) contentVideoId = canonicalVideoId
  return {
    media: media ? { time: media.currentTime, duration: Number.isFinite(media.duration) ? media.duration : null,
      paused: media.paused, ended: media.ended, readyState: media.readyState, errorCode: media.error?.code ?? null,
      muted: media.muted, volume: media.volume, playbackRate: media.playbackRate } : null,
    adShowing: player ? player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting') : null,
    visibleAdBadges: [...document.querySelectorAll('.ytp-ad-text,.ytp-ad-simple-ad-badge,.ytp-ad-badge,.ytp-ad-preview-text')].filter(visible).length,
    visibleErrors: [...document.querySelectorAll('.ytp-error-content-wrap,.ytp-error-content')].filter(visible).map(node => node.textContent.trim()).filter(Boolean).slice(0, 2),
    contentTitle: titleLink?.textContent.trim() || document.title || null, contentVideoId, canonicalVideoId,
    titleEvidence: titleLink ? { kind: 'provider DOM title link', class: titleLink.className } : { kind: 'provider document.title' },
    documentTitle: document.title,
  }
})

try {
  let url = option('--url', null)
  if (!url) {
    server = createPwaServer()
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    url = `http://127.0.0.1:${server.address().port}/pletina/`
  }
  assert.ok(['https:', 'http:'].includes(new URL(url).protocol))
  report.originKind = server ? 'ephemeral static localhost QA' : 'supplied HTTPS/HTTP landing page'
  browser = await puppeteer.launch({ headless: true,
    executablePath: option('--chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'),
    ignoreDefaultArgs: ['--mute-audio'] })
  const launchArgs = browser.process().spawnargs
  assert.ok(!launchArgs.some(value => /autoplay-policy|MediaEngagementBypassAutoplayPolicies|disable-web-security|ignore-certificate-errors/.test(value)), 'No autoplay/security launch override')
  assert.ok(!launchArgs.includes('--mute-audio'), 'Browser audio must not be muted by launch arguments')
  report.browser = await browser.version()
  context = await browser.createBrowserContext()
  report.initialCookieCount = (await context.cookies()).length
  assert.equal(report.initialCookieCount, 0, 'Disposable empty browser context')
  page = await context.newPage()
  await page.setViewport({ width: 1280, height: 1000 })
  page.on('pageerror', error => report.errors.push({ name: error.name, message: scrub(error.message) }))
  page.on('response', response => {
    // Read real provider response metadata only. No URLs, visitor/session values,
    // proof tokens, response bodies or signed media addresses enter the report.
    const operation = (async () => {
      const endpoint = new URL(response.url())
      if (!['www.youtube.com', 'music.youtube.com'].includes(endpoint.hostname) || endpoint.pathname !== '/youtubei/v1/player') return
      let request
      try { request = JSON.parse(response.request().postData() ?? '{}') } catch { return }
      const client = request.context?.client?.clientName
      if (client !== 'VISIONOS') return
      let body
      try { body = await response.json() } catch { body = null }
      report.providerPlayback.push({ client, videoId: /^[\w-]{11}$/.test(request.videoId ?? '') ? request.videoId : null,
        httpStatus: response.status(), playabilityStatus: typeof body?.playabilityStatus?.status === 'string' ? body.playabilityStatus.status : null })
    })().catch(error => report.errors.push({ kind: 'provider metadata observation', message: scrub(error.message) }))
    pendingResponses.add(operation)
    void operation.finally(() => pendingResponses.delete(operation))
  })

  await check('open the expected compiled PWA without observer-created user activation', async () => {
    await page.goto(url, { waitUntil: 'load', timeout: 30000 })
    report.build = await parentRead(() => document.querySelector('#version')?.textContent.trim() ?? null)
    assert.ok(report.build, 'Landing page exposes its build')
    if (expectedBuild) assert.equal(report.build, expectedBuild)
    await poll('Service worker controller', () => parentRead(() => Boolean(navigator.serviceWorker.controller)), 25000)
    report.activationBeforeInteraction = await activation()
    assert.equal(report.activationBeforeInteraction.ever, false, 'Read-only CDP observations cannot activate the page')
    await mouseClick('#open-player', 'open Pletina from the installer')
    await poll('Application shell', () => parentRead(() => Boolean(document.querySelector('.app .sidebar'))), 30000)
    report.applicationActivationBeforeSearch = await activation()
    return { build: report.build, observerDidNotActivateLandingPage: true }
  })

  await check('find the exact catalog song and click its normal play row once', async () => {
    const search = 'input[aria-label="Buscar música"]'
    await mouseClick(search, 'focus the normal music search input')
    report.inputActions.push({ kind: 'real keyboard typing', purpose: 'search the catalog', characters: query.length })
    await page.keyboard.type(query)
    const selection = await poll('Exact first catalog row', () => parentRead(() => {
      const row = document.querySelector('.tracks li[data-reorder-index="0"]')
      return row?.querySelector('.name') ? { title: row.querySelector('.name').textContent.trim(), artist: row.querySelector('.by')?.textContent.trim() ?? null } : null
    }), 45000)
    assert.equal(selection.title.toLowerCase(), expectedTitle.toLowerCase())
    assert.match(selection.artist ?? '', /pirritx.*porrotx/i)
    report.selected = selection
    report.primaryAttempt.activationBeforeSongClick = await activation()
    await mouseClick('.tracks li[data-reorder-index="0"] .row[role="button"] .num', 'play the selected catalog song')
    report.primaryAttempt.songRowClicks++
    report.primaryAttempt.startedAt = new Date().toISOString()
    return { selected: selection, songRowClicks: 1 }
  })

  await check('direct-source failure opens a visible matching autoplay iframe automatically', async () => {
    const state = await poll('Automatic official iframe', async () => {
      const value = await parentState()
      return value.embed ? value : null
    }, 100000)
    report.primaryAttempt.fallback = state
    assert.match(state.dialogTrack ?? '', /^Iritsi da Eguna\s*[·–-]/i)
    assert.equal(state.mediaTitle, expectedTitle, 'Current song must remain the selected song, without automatic skip')
    assert.equal(state.embed.host, 'www.youtube.com')
    assert.ok(matchingVideos.includes(state.embed.videoId), 'Only a sufficiently matched recording of this song is allowed')
    assert.equal(state.embed.declaredVideoId, state.embed.videoId)
    assert.equal(state.embed.autoplay, '1')
    assert.equal(state.embed.playsinline, '1')
    assert.equal(state.embed.apiEnabled, '1')
    assert.equal(state.embed.originMatches, true)
    assert.equal(state.embed.autoplayDelegated, true)
    assert.equal(state.embed.visible, true)
    assert.ok(state.embed.width >= 200 && state.embed.height >= 200)
    assert.ok(state.embed.visibleFraction > 0.5, 'More than half of the official video must be visible')
    await Promise.all([...pendingResponses])
    const rejected = report.providerPlayback.filter(value => matchingVideos.includes(value.videoId) && ['UNPLAYABLE', 'ERROR'].includes(value.playabilityStatus))
    assert.ok(rejected.length > 0, 'A real direct-source rejection must precede the fallback')
    return { videoId: state.embed.videoId, rejectedDirectSources: rejected, noAdditionalPlaybackClick: true }
  })

  await check('the exact content advances unmuted without another click or test API play call', async () => {
    const started = Date.now(), samples = report.primaryAttempt.samples
    let anchor = null, passed = false
    while (Date.now() - started < 45000) {
      const frame = page.frames().find(value => {
        try { const address = new URL(value.url()); return address.hostname === 'www.youtube.com' && address.pathname === '/embed/' + report.primaryAttempt.fallback.embed.videoId }
        catch { return false }
      })
      if (!frame) { await delay(250); continue }
      let sample
      try { sample = await frameMedia(frame) }
      catch (error) { samples.push({ elapsed: Date.now() - started, contextWait: scrub(error.message) }); await delay(250); continue }
      sample.visibleErrors = sample.visibleErrors.map(scrub)
      sample.elapsed = Date.now() - started
      samples.push(sample)
      assert.equal(sample.visibleErrors.length, 0, 'Official player must not display an error')
      if (sample.media) assert.equal(sample.media.errorCode, null, 'Official HTMLMediaElement must not fail')
      const media = sample.media
      const validContent = media && !media.paused && !media.ended && !media.muted && media.volume > 0 && media.readyState >= 3 &&
        media.playbackRate === 1 && Math.abs(media.duration - 169.6) < 2 && sample.adShowing === false && sample.visibleAdBadges === 0 &&
        /iritsi da eguna/i.test(sample.contentTitle ?? '') && sample.contentVideoId === report.primaryAttempt.fallback.embed.videoId &&
        (!sample.canonicalVideoId || sample.canonicalVideoId === report.primaryAttempt.fallback.embed.videoId)
      if (validContent && media.time > 0.1 && !anchor) anchor = { time: media.time, elapsed: sample.elapsed }
      if (validContent && anchor && media.time > 2 && media.time - anchor.time > 1 && sample.elapsed - anchor.elapsed > 1000) { passed = true; break }
      await delay(300)
    }
    assert.ok(passed, 'Two real content samples must advance by >1s, reach >2s, remain unmuted, and show no ad/error')
    const state = await parentState()
    assert.equal(state.mediaTitle, expectedTitle, 'Playback must not auto-skip to another catalog song')
    assert.equal(state.embed?.videoId, report.primaryAttempt.fallback.embed.videoId)
    assert.equal(report.primaryAttempt.songRowClicks, 1)
    report.primaryAttempt.provedAt = new Date().toISOString()
    report.primaryAttempt.noAdditionalPlaybackInteraction = true
    report.primaryAttempt.lastParentState = state
    const screenshot = reportName.replace('.json', '-playing.png')
    await page.screenshot({ path: fileURLToPath(new URL(screenshot, output)), fullPage: true })
    return { initialContentSample: anchor, finalContentSample: samples.at(-1), screenshot, songRowClicks: 1,
      iframeClicks: 0, sourceClicks: 0, menuClicks: 0, testApiPlayCalls: 0, observerGestureGranted: false }
  })

  await check('the visible close control removes the official player', async () => {
    await mouseClick('#official-youtube-close', 'close after automatic playback was proved')
    await poll('Official iframe removal', () => parentRead(() => !document.querySelector('dialog[data-official-youtube][open] iframe')), 5000)
    assert.equal((await parentState()).appPresent, true)
    return { iframeRemoved: true, applicationStillOpen: true }
  })

  await check('a separate normal play attempt reopens the fallback and browser Back removes it', async () => {
    await poll('Search row after close', () => parentRead(() => Boolean(document.querySelector('.tracks li[data-reorder-index="0"] .row[role="button"] .num'))), 15000)
    await mouseClick('.tracks li[data-reorder-index="0"] .row[role="button"] .num', 'separate reopen for Back cleanup after playback proof')
    const reopened = await poll('Reopened automatic iframe', async () => {
      const state = await parentState()
      return state.embed ? state : null
    }, 100000)
    assert.ok(matchingVideos.includes(reopened.embed.videoId))
    await parentRead(() => { history.back(); return true })
    await poll('Browser Back iframe removal', () => parentRead(() => !document.querySelector('dialog[data-official-youtube][open] iframe')), 5000)
    assert.equal((await parentState()).appPresent, true)
    return { separateSongRowClicks: 1, iframeRemoved: true, applicationStillOpen: true,
      scope: 'Browser history API cleanup only; no physical Android Back claim' }
  })
} catch (error) {
  report.failure = { name: error.name, message: scrub(error.message) }
  if (page && !page.isClosed()) {
    report.finalParentState = await parentState().catch(() => null)
    const screenshot = reportName.replace('.json', '-failure.png')
    await page.screenshot({ path: fileURLToPath(new URL(screenshot, output)), fullPage: true }).then(() => { report.failureScreenshot = screenshot }).catch(() => {})
  }
  process.exitCode = 1
} finally {
  await Promise.allSettled([...pendingResponses])
  if (context) { await context.close(); report.contextClosed = true }
  if (browser) { await browser.close(); report.browserClosed = true }
  if (server) { await new Promise(resolve => server.close(resolve)); report.staticQaServerClosed = true }
  report.finishedAt = new Date().toISOString()
  await writeFile(new URL(reportName, output), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ build: report.build, passed: report.checks.filter(value => value.pass).length,
    failed: report.checks.filter(value => !value.pass).length, report: reportName, observedWithUserGesture: false }))
}
