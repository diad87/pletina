// Real compiled P1 integration, without provider mocks or a Node bootstrap.
// All observations and declared programmatic seeks use CDP userGesture:false.
// Audio addresses and the public recipe stay inside browser RAM.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'
import { createPwaServer } from '../preview-pwa.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const expectedBuild = option('--expected-build', '')
const fullPlayback = args.includes('--full-playback')
assert.match(expectedBuild, /^[a-f0-9]{16}$/, '--expected-build is required')
const definitions = { nini: { videoId: 'NGp3dh-hBe8', title: 'Ni, Ni, Ni!' }, epoitaitaye: { videoId: 'DJzjkMBMook', title: 'Epoitaitaye' }, maite: { videoId: 'WtTRMAoN2Fw', title: 'Maite Zaitut!' }, iritsi: { videoId: 'fV-IUsecSsU', title: 'Iritsi da Eguna' } }
const cases = option('--cases', 'epoitaitaye,maite,iritsi').split(',')
assert.ok(cases.length > 0 && cases.length <= 4 && new Set(cases).size === cases.length && cases.every(name => Object.hasOwn(definitions, name)))
const reportName = option('--report', `p1-integrated-live-${expectedBuild}-local.json`)
assert.match(reportName, /^p1-integrated-[a-z0-9.-]+\.json$/)
const directory = new URL('../../artifacts/pwa-port/', import.meta.url)
const source = await readFile(new URL(import.meta.url)), sourceHash = crypto.createHash('sha256').update(source).digest('hex')
const beganAt = Date.now()
const timestamp = () => ({ at: new Date().toISOString(), elapsedMs: Date.now() - beganAt })
const report = { schemaVersion: 1, testedAt: new Date().toISOString(), expectedBuild, build: null,
  runnerSha256: sourceHash, sourceSnapshot: `artifacts/pwa-port/p1-integrated-source-${sourceHash.slice(0, 16)}.mjs`,
  scope: 'Compiled P1 check page; real anonymous browser provider requests, desktop Chrome foreground audio. No physical Android/iPhone, installed PWA, background, screen-off or audible human verification.',
  fullPlaybackRequested: fullPlayback,
  policy: { providerMocks: false, productMethodsReplaced: false, sdkInjected: false, nodeProviderBootstrap: false, runtimeBackend: false,
    signedUrlsPersisted: false, rawRecipePersisted: false, mediaPersisted: false, browserSecurityOverrides: false, autoplayOverrides: false,
    outputSilencedByLaunchArgument: false, physicalAndroid: false, physicalIPhone: false, background: false, screenOff: false,
    programmedSeekIsUserPlaybackProof: false, audibleHumanVerification: false },
  observationRpcCalls: 0, observationRpcWithGesture: 0, inputActions: [], checks: [], cases: [], errors: [],
  providerResponses: [], cdnResponses: [], cdnHttp: [], networkFailures: [] }
const scrub = value => String(value ?? '').replace(/https?:\/\/[^\s"'<>]+/g, '[URL]').replace(/blob:[^\s"'<>]+/g, '[BLOB]').slice(0, 300)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let server, browser, context, page, audioObjectId
const pendingMetadata = new Set()
async function rpc(fn, value = null, returnByValue = true) {
  const executionContext = page.mainFrame().mainRealm().context
  assert.ok(executionContext, 'Browser execution context')
  report.observationRpcCalls++
  const result = await page.mainFrame().client.send('Runtime.callFunctionOn', { executionContextId: executionContext.id,
    functionDeclaration: fn.toString(), arguments: [{ value }], returnByValue, awaitPromise: true, userGesture: false })
  if (result.exceptionDetails) throw Error(scrub(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text))
  return returnByValue ? result.result.value : result.result
}
async function poll(label, fn, maximumMs = 15000) {
  const deadline = Date.now() + maximumMs
  let lastError
  do {
    try { const result = await fn(); if (result) return result } catch (error) { lastError = scrub(error.message) }
    await delay(150)
  } while (Date.now() < deadline)
  throw Error(label + ' timed out' + (lastError ? ': ' + lastError : ''))
}
async function check(name, fn, target = report.checks) {
  process.stdout.write(name + ' ... ')
  try { const details = await fn(); target.push({ name, pass: true, ...details }); process.stdout.write('passed\n') }
  catch (error) { target.push({ name, pass: false, error: scrub(error.message) }); process.stdout.write('FAILED\n'); throw error }
}
async function click(selector, purpose) {
  const point = await rpc(selector => {
    const element = document.querySelector(selector)
    if (!element) return null
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2
    const hit = document.elementFromPoint(x, y)
    return rect.width > 0 && rect.height > 0 && x > 0 && x < innerWidth && y > 0 && y < innerHeight && style.visibility !== 'hidden' && style.display !== 'none' && hit && (hit === element || element.contains(hit)) ? { x, y } : null
  }, selector)
  assert.ok(point, 'Visible control: ' + purpose)
  report.inputActions.push({ kind: 'real mouse click', purpose, at: new Date().toISOString() })
  await page.mouse.click(point.x, point.y)
}
const state = () => rpc(() => {
  const audio = document.querySelector('audio'), frames = [...document.querySelectorAll('iframe')]
  return { build: document.body.dataset.build ?? null, publicContextSha256: document.body.dataset.recipe ?? null,
    videoId: document.body.dataset.videoId ?? null, transport: document.body.dataset.transport ?? null,
    status: document.querySelector('#status')?.textContent.trim() ?? null,
    audioCount: document.querySelectorAll('audio').length, videoCount: document.querySelectorAll('video').length,
    frameCount: frames.length, visibleVideoFrames: frames.filter(frame => {
      const rect = frame.getBoundingClientRect(), style = getComputedStyle(frame)
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && !frame.hidden
    }).length,
    activation: { active: navigator.userActivation.isActive, ever: navigator.userActivation.hasBeenActive },
    audio: audio ? { time: audio.currentTime, duration: Number.isFinite(audio.duration) ? audio.duration : null,
      paused: audio.paused, ended: audio.ended, readyState: audio.readyState, errorCode: audio.error?.code ?? null,
      muted: audio.muted, volume: audio.volume, hasSrcAttribute: audio.hasAttribute('src'), networkState: audio.networkState } : null }
})
async function sameAudio() {
  report.observationRpcCalls++
  const result = await page.mainFrame().client.send('Runtime.callFunctionOn', { objectId: audioObjectId,
    functionDeclaration: 'function(){return this===document.querySelector("audio")}', returnByValue: true, userGesture: false })
  return result.result.value === true
}
async function seek(fraction, tail = false) {
  report.inputActions.push({ kind: 'declared programmatic seek', userGesture: false, target: tail ? 'duration minus 1.5 seconds' : '80 percent' })
  return rpc(({ fraction, tail }) => {
    const audio = document.querySelector('audio')
    if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 5) return null
    const target = tail ? audio.duration - 1.5 : audio.duration * fraction
    audio.currentTime = target
    return { target, duration: audio.duration }
  }, { fraction, tail })
}

try {
  let url = option('--url', null)
  if (!url) {
    server = createPwaServer()
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    url = `http://127.0.0.1:${server.address().port}/pletina/application/p1-check.html`
  }
  const target = new URL(url)
  assert.ok(target.protocol === 'https:' || target.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(target.hostname))
  assert.ok(target.pathname.endsWith('/application/p1-check.html'))
  report.originKind = server ? 'ephemeral static loopback serving unmodified dist-pwa' : 'supplied HTTPS compiled check page'
  browser = await puppeteer.launch({ headless: true,
    executablePath: option('--chrome', 'C:/Users/iunan/.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe'),
    ignoreDefaultArgs: ['--mute-audio', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], args: [] })
  const launchArgs = browser.process().spawnargs
  assert.ok(!launchArgs.some(value => /autoplay-policy|MediaEngagementBypassAutoplayPolicies|disable-web-security|ignore-certificate-errors/.test(value)))
  assert.ok(!launchArgs.includes('--mute-audio'))
  report.browser = await browser.version(); assert.match(report.browser, /Chrome\/148\./)
  context = await browser.createBrowserContext(); report.initialCookieCount = (await context.cookies()).length; assert.equal(report.initialCookieCount, 0)
  page = await context.newPage(); await page.setViewport({ width: 1100, height: 1000 })
  const cdp = page.mainFrame().client, cdnRequests = new Map()
  await cdp.send('Network.enable')
  cdp.on('Network.requestWillBeSent', event => {
    let endpoint; try { endpoint = new URL(event.request.url) } catch { return }
    if (!endpoint.hostname.endsWith('.googlevideo.com')) return
    cdnRequests.set(event.requestId, { ...timestamp(), urlSha256: crypto.createHash('sha256').update(event.request.url).digest('hex'),
      itag: endpoint.searchParams.get('itag'), resourceType: event.type })
  })
  cdp.on('Network.responseReceivedExtraInfo', event => {
    const request = cdnRequests.get(event.requestId)
    if (request) report.cdnHttp.push({ ...timestamp(), request, httpStatus: event.statusCode,
      contentType: String(event.headers['content-type'] ?? event.headers['Content-Type'] ?? '').split(';')[0] || null,
      contentLength: Number(event.headers['content-length'] ?? event.headers['Content-Length']) || null })
  })
  cdp.on('Network.loadingFailed', event => {
    const request = cdnRequests.get(event.requestId)
    if (request) report.networkFailures.push({ ...timestamp(), provider: 'googlevideo-cdp', request,
      error: scrub(event.errorText), blockedReason: event.blockedReason ?? null, corsError: event.corsErrorStatus?.corsError ?? null })
  })
  page.on('pageerror', error => report.errors.push({ kind: 'pageerror', message: scrub(error.message) }))
  page.on('requestfailed', request => {
    let endpoint; try { endpoint = new URL(request.url()) } catch { return }
    if (endpoint.hostname === 'www.youtube.com' || endpoint.hostname.endsWith('.googlevideo.com')) report.networkFailures.push({
      ...timestamp(), provider: endpoint.hostname.endsWith('.googlevideo.com') ? 'googlevideo' : 'youtube', error: scrub(request.failure()?.errorText) })
  })
  page.on('response', response => {
    const operation = (async () => {
      const endpoint = new URL(response.url())
      if (endpoint.hostname.endsWith('.googlevideo.com')) {
        report.cdnResponses.push({ ...timestamp(), urlSha256: crypto.createHash('sha256').update(response.url()).digest('hex'), status: response.status(), itag: endpoint.searchParams.get('itag'), type: response.request().resourceType(), contentType: response.headers()['content-type']?.split(';')[0] ?? null }); return
      }
      if (endpoint.hostname !== 'www.youtube.com' || endpoint.pathname !== '/youtubei/v1/player') return
      let request, body
      try { request = JSON.parse(response.request().postData() ?? '{}') } catch { return }
      try { body = await response.json() } catch { body = null }
      report.providerResponses.push({ ...timestamp(), client: ['VISIONOS', 'WEB_EMBEDDED_PLAYER'].includes(request.context?.client?.clientName) ? request.context.client.clientName : 'other',
        requestedVideoId: /^[\w-]{11}$/.test(request.videoId ?? '') ? request.videoId : null, httpStatus: response.status(),
        status: typeof body?.playabilityStatus?.status === 'string' ? body.playabilityStatus.status : null,
        exactResponseId: body?.videoDetails?.videoId === request.videoId,
        audioFormats: Array.isArray(body?.streamingData?.adaptiveFormats) ? body.streamingData.adaptiveFormats.filter(value => typeof value?.mimeType === 'string' && value.mimeType.startsWith('audio/')).length : 0,
        aac: Array.isArray(body?.streamingData?.adaptiveFormats) ? body.streamingData.adaptiveFormats.filter(value => typeof value?.mimeType === 'string' && value.mimeType.startsWith('audio/mp4')).slice(0, 4).map(value => ({
          itag: Number.isSafeInteger(value.itag) ? value.itag : null, mimeType: value.mimeType.slice(0, 100),
          contentLength: /^\d{1,12}$/.test(String(value.contentLength ?? '')) ? Number(value.contentLength) : null,
          signatureCipher: typeof value.signatureCipher === 'string', drc: value.isDrc === true })) : [] })
    })().catch(error => report.errors.push({ kind: 'provider metadata observation', message: scrub(error.message) }))
    pendingMetadata.add(operation); void operation.finally(() => pendingMetadata.delete(operation))
  })
  await check('compiled build and anonymous context are visible before any activation', async () => {
    await page.goto(url, { waitUntil: 'load', timeout: 30000 })
    const initial = await poll('Compiled build marker', async () => { const value = await state(); return value.build && value.publicContextSha256 ? value : null })
    assert.equal(initial.build, expectedBuild); report.build = initial.build
    assert.match(initial.publicContextSha256, /^[a-f0-9]{64}$/); report.publicContextSha256 = initial.publicContextSha256
    report.recipePreparedDisplay = await rpc(() => document.querySelector('#version')?.textContent.trim() ?? null)
    assert.equal(initial.activation.ever, false); assert.equal(initial.audioCount, 1); assert.equal(initial.audio.muted, false)
    audioObjectId = (await rpc(() => document.querySelector('audio'), null, false)).objectId; assert.ok(audioObjectId)
    return { build: initial.build, initialActivation: initial.activation, audioCount: initial.audioCount, unmutedAudio: true }
  })
  await check('Stop cancels a real pending resolution and it cannot revive after the full deadline', async () => {
    await click(`[data-song="${cases[0]}"]`, 'start a real pending P1 resolution for cancellation')
    const preparing = await state(); assert.match(preparing.status ?? '', /^Preparando/)
    await click('#stop', 'cancel while the public provider request is pending')
    await poll('Cancelled transport frames removed', async () => (await state()).frameCount === 0, 4000)
    const started = Date.now(); let samples = 0
    while (Date.now() - started < 26000) {
      const value = await state(); samples++
      assert.equal(value.status, 'Parada.'); assert.equal(value.audio.paused, true); assert.equal(value.audio.hasSrcAttribute, false)
      assert.equal(value.audioCount, 1); assert.equal(value.frameCount, 0); assert.equal(await sameAudio(), true)
      await delay(500)
    }
    return { observedMs: Date.now() - started, samples, noRevival: true, sameAudio: true }
  })
  for (const name of cases) {
    const song = definitions[name], result = { name, videoId: song.videoId, title: song.title, checks: [], samples: [], startedAt: new Date().toISOString() }
    report.cases.push(result)
    await check(name + ': one real button click starts unmuted native audio through P1', async () => {
      const began = Date.now(); await click(`[data-song="${name}"]`, 'single normal play click: ' + name)
      const playing = await poll('Unmuted P1 playback: ' + name, async () => {
        const value = await state(); result.samples.push(value)
        if (result.samples.length > 12) result.samples.shift()
        return value.videoId === song.videoId && value.transport === 'p1' && value.audio && !value.audio.paused && value.audio.time > 2 && value.audio.errorCode === null ? value : null
      }, 45000)
      assert.equal(playing.audio.muted, false); assert.ok(playing.audio.volume > 0); assert.equal(playing.audioCount, 1)
      assert.equal(playing.frameCount, 0); assert.equal(playing.visibleVideoFrames, 0); assert.equal(playing.videoCount, 0)
      assert.equal(page.frames().length, 1); assert.equal(await sameAudio(), true)
      result.elapsedToAdvancingAudioMs = Date.now() - began; result.duration = playing.audio.duration
      return { elapsedMs: result.elapsedToAdvancingAudioMs, duration: result.duration, transport: playing.transport, exactVideoId: true,
        time: playing.audio.time, paused: false, unmutedAudio: true, frameCount: 0, sameAudio: true, extraPlayInteraction: false }
    }, result.checks)
    if (fullPlayback) await check(name + ': complete uninterrupted native audio reaches natural ended without another interaction', async () => {
      const samples = [], deadline = Date.now() + (result.duration + 20) * 1000
      let last = 0, ended = false
      while (Date.now() < deadline) {
        const value = await state(), audio = value.audio
        assert.equal(value.frameCount, 0); assert.equal(value.videoCount, 0)
        assert.equal(audio.errorCode, null); assert.equal(audio.muted, false)
        assert.ok(audio.time >= last - 0.1); last = audio.time
        samples.push({ at: new Date().toISOString(), time: audio.time, paused: audio.paused, ended: audio.ended })
        if (audio.ended) { ended = true; break }
        assert.equal(audio.paused, false)
        await delay(1000)
      }
      assert.equal(ended, true); assert.ok(last >= result.duration - 0.1)
      return { samples, ended: true, duration: result.duration, seeks: 0, extraInteractions: 0, audibleHumanVerification: false }
    }, result.checks)
    if (!fullPlayback) await check(name + ': audio advances after a declared programmatic 80 percent seek', async () => {
      const requested = await seek(0.8); assert.ok(requested)
      const value = await poll('Advance after 80 percent seek', async () => { const value = await state(); return !value.audio.paused && value.audio.time > requested.target + 0.7 && !value.audio.errorCode ? value : null }, 15000)
      return { target: requested.target, time: value.audio.time, userGesture: false }
    }, result.checks)
    if (!fullPlayback) await check(name + ': natural ended follows a declared programmatic tail seek', async () => {
      const requested = await seek(0, true); assert.ok(requested)
      const value = await poll('Natural tail ended', async () => { const value = await state(); return value.audio.ended && value.audio.paused ? value : null }, 12000)
      assert.ok(value.audio.time >= value.audio.duration - 0.1); assert.equal(await sameAudio(), true)
      return { target: requested.target, ended: true, time: value.audio.time, duration: value.audio.duration }
    }, result.checks)
    await check(name + ': Stop unloads the source and leaves one silent empty audio element', async () => {
      await click('#stop', 'unload audio after natural end: ' + name)
      const value = await poll('Stopped empty audio', async () => { const value = await state(); return value.audio.paused && !value.audio.hasSrcAttribute && value.frameCount === 0 ? value : null })
      assert.equal(value.audioCount, 1); assert.equal(await sameAudio(), true)
      await delay(1000); const later = await state(); assert.equal(later.audio.paused, true); assert.equal(later.audio.hasSrcAttribute, false)
      return { paused: true, srcRemoved: true, frameCount: 0, audioCount: 1, sameAudio: true }
    }, result.checks)
  }
  await check('all observations used userGesture:false and no page runtime errors occurred', async () => {
    await Promise.all([...pendingMetadata]); assert.equal(report.observationRpcWithGesture, 0); assert.equal(report.errors.length, 0)
    assert.ok(report.providerResponses.some(value => value.client === 'WEB_EMBEDDED_PLAYER' && value.status === 'OK' && value.exactResponseId))
    return { observationRpcCalls: report.observationRpcCalls, observationRpcWithGesture: 0, compiledStaticRecipeUsed: true }
  })
} catch (error) {
  report.errors.push({ kind: 'runner failure', message: scrub(error.message) })
  if (page) try { report.lastState = await state() } catch { /* Context may already be gone. */ }
} finally {
  if (page) try { await page.mainFrame().client.send('Runtime.releaseObject', { objectId: audioObjectId }) } catch { /* Optional diagnostic reference. */ }
  await Promise.allSettled([...pendingMetadata]); await context?.close(); await browser?.close()
  if (server) await new Promise(resolve => server.close(resolve))
  report.resourcesClosed = true
}
await mkdir(directory, { recursive: true })
await writeFile(new URL(report.sourceSnapshot.replace('artifacts/pwa-port/', ''), directory), source)
await writeFile(new URL(reportName, directory), JSON.stringify(report, null, 2) + '\n')
const checks = [...report.checks, ...report.cases.flatMap(value => value.checks)]
console.log(JSON.stringify({ report: reportName, build: report.build, passed: checks.filter(value => value.pass).length,
  failed: checks.filter(value => !value.pass).length, cases: report.cases.map(value => ({ name: value.name, checks: value.checks.length, duration: value.duration })), errors: report.errors }))
if (report.errors.length || checks.some(value => !value.pass)) process.exitCode = 1
