// Real compiled WebKit foreground smoke. Observations arrive from an inert
// init-script console observer: no evaluate RPC that could emulate user gestures.
// Only two physical mouse inputs are used (the existing Play and Stop buttons).
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { webkit } from 'playwright'
import { createPwaServer } from '../preview-pwa.mjs'

const args = process.argv.slice(2), option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const build = option('--expected-build', ''), dist = resolve(option('--dist', 'dist-pwa'))
assert.match(build, /^[a-f0-9]{16}$/)
assert.equal((await readFile(resolve(dist, 'sw.js'), 'utf8')).match(/const VERSION = "([a-f0-9]{16})"/)?.[1], build)
const reportName = option('--report', `p1-integrated-webkit-${build}-epoitaitaye-local.json`)
assert.match(reportName, /^p1-integrated-webkit-[a-z0-9.-]+\.json$/)
const directory = new URL('../../artifacts/pwa-port/', import.meta.url), source = await readFile(new URL(import.meta.url)), sha = value => createHash('sha256').update(value).digest('hex')
const report = { schemaVersion: 1, testedAt: new Date().toISOString(), expectedBuild: build, build: null,
  runnerSha256: sha(source), sourceSnapshot: `artifacts/pwa-port/p1-integrated-webkit-source-${sha(source).slice(0, 16)}.mjs`,
  scope: 'Real compiled diagnostic page and anonymous provider requests in desktop Linux WebKit foreground. Headless unmuted media state only; no human audible, full-file, physical iPhone, installed PWA, background or screen-off assertion.',
  policy: { providerMocks: false, nodeProviderBootstrap: false, runtimeBackend: false, productMethodsReplaced: false,
    observerIsInitScriptOnly: true, evaluateRpcCalls: 0, observerRpcWithUserGesture: 0, realMouseInputsOnly: true,
    browserSecurityOverrides: false, autoplayOverrides: false, mediaOrSignedUrlsPersisted: false,
    rawAnonymousRecipePersistedByRunner: false, physicalIPhoneVerified: false, screenOffVerified: false },
  checks: [], inputs: [], samples: [], bridgeMessages: [], network: [], errors: [] }
const safe = value => String(value ?? '').replace(/(?:https?|blob):[^\s"'<>]+/g, '[URL]').slice(0, 250)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const prefix = 'PLETINA_WEBKIT_P1_OBSERVE '
let server, browser, context, page, latest
const pendingObservations = new Set()
async function poll(label, condition, maximumMs) {
  const until = Date.now() + maximumMs
  do { if (condition(latest)) return latest; await delay(100) } while (Date.now() < until)
  throw Error(label + ' timed out')
}
async function check(name, work) {
  process.stdout.write(name + ' ... ')
  try { const details = await work(); report.checks.push({ name, pass: true, ...details }); process.stdout.write('pass\n') }
  catch (error) { report.checks.push({ name, pass: false, error: safe(error.message) }); process.stdout.write('fail\n'); throw error }
}
async function click(name, point) {
  assert.ok(point && Number.isFinite(point.x) && Number.isFinite(point.y), 'Observed real button geometry')
  report.inputs.push({ kind: 'real mouse click', name, at: new Date().toISOString() })
  await page.mouse.click(point.x, point.y)
}
try {
  server = createPwaServer({ directory: dist })
  await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes) })
  browser = await webkit.launch({ headless: true })
  report.browser = await browser.version()
  context = await browser.newContext({ viewport: { width: 1100, height: 1000 }, serviceWorkers: 'allow' })
  report.initialCookieCount = (await context.cookies()).length
  assert.equal(report.initialCookieCount, 0)
  await context.addInitScript(({ prefix }) => {
    if (window !== top) return
    let original = null, sequence = 0
    addEventListener('message', event => {
      if (event.origin !== 'null' || ![...document.querySelectorAll('iframe')].some(frame => frame.contentWindow === event.source)) return
      const data = event.data, result = data?.result
      console.log(prefix + JSON.stringify({ kind: 'bridge', at: Math.round(performance.now()),
        channel: data?.type === 'pletina-web-youtube-json' ? 'youtube-json' : data?.type === 'pletina-youtube-p1-metadata' ? 'metadata' : typeof data?.id === 'string' ? 'isolated-decoder' : 'other',
        errorCode: ['network', 'timeout', 'response', 'cancelled'].includes(data?.error) ? data.error : null,
        resultKeys: result && typeof result === 'object' ? Object.keys(result).filter(key => ['result', 'error', 'timeout', 'stopped'].includes(key)) : [],
        decoderError: result?.error === true, decoderTimeout: result?.timeout === true,
        decoderOutputCount: Array.isArray(result?.result) ? result.result.length : null,
        providerStatus: typeof result?.playabilityStatus?.status === 'string' ? result.playabilityStatus.status : null,
        exactRequestedVideo: result?.videoDetails?.videoId === 'DJzjkMBMook' }))
    })
    const rect = selector => {
      const element = document.querySelector(selector)
      if (!element) return null
      const box = element.getBoundingClientRect(), x = box.x + box.width / 2, y = box.y + box.height / 2, style = getComputedStyle(element), hit = document.elementFromPoint(x, y)
      return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && hit && (hit === element || element.contains(hit)) ? { x, y } : null
    }
    const observe = event => {
      const audio = document.querySelector('audio')
      if (!audio) return
      if (!original) original = audio
      console.log(prefix + JSON.stringify({ sequence: ++sequence, event, at: Math.round(performance.now()),
        build: document.body?.dataset.build ?? null, transport: document.body?.dataset.transport ?? null, videoId: document.body?.dataset.videoId ?? null,
        status: document.querySelector('#status')?.textContent.trim() ?? null, sameAudio: original === audio,
        audioCount: document.querySelectorAll('audio').length, videoCount: document.querySelectorAll('video').length,
        frames: document.querySelectorAll('iframe').length, visibility: document.visibilityState,
        activation: navigator.userActivation ? { active: navigator.userActivation.isActive, ever: navigator.userActivation.hasBeenActive } : null,
        audio: { time: Number.isFinite(audio.currentTime) ? audio.currentTime : null, duration: Number.isFinite(audio.duration) ? audio.duration : null,
          paused: audio.paused, error: audio.error?.code ?? null, muted: audio.muted, volume: audio.volume, hasSource: audio.hasAttribute('src'), ended: audio.ended },
        controls: { play: rect('[data-song="epoitaitaye"]'), stop: rect('#stop') } }))
    }
    addEventListener('DOMContentLoaded', () => {
      const audio = document.querySelector('audio')
      for (const name of ['loadedmetadata', 'playing', 'timeupdate', 'pause', 'ended', 'error']) audio?.addEventListener(name, () => observe(name))
      observe('ready'); setInterval(() => observe('sample'), 250)
    }, { once: true })
  }, { prefix })
  page = await context.newPage()
  page.on('console', message => {
    const text = message.text()
    if (!text.startsWith(prefix)) return
    try {
      const value = JSON.parse(text.slice(prefix.length))
      if (value.kind === 'bridge') { report.bridgeMessages.push(value); return }
      latest = value; report.samples.push(latest); if (report.samples.length > 180) report.samples.shift()
    } catch { report.errors.push('Malformed own observer event') }
  })
  page.on('pageerror', error => report.errors.push(safe(error.message)))
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.hostname.endsWith('.googlevideo.com')) report.network.push({ provider: 'googlevideo', status: response.status(), type: response.request().resourceType(), itag: url.searchParams.get('itag'), urlSha256: sha(response.url()) })
    else if (url.hostname === 'www.youtube.com' && url.pathname === '/youtubei/v1/player') {
      const operation = (async () => {
        let request, result
        try { request = JSON.parse(response.request().postData() ?? '{}') } catch { request = null }
        try { result = await response.json() } catch { result = null }
        report.network.push({ provider: 'youtube-player', status: response.status(),
          client: ['VISIONOS', 'WEB_EMBEDDED_PLAYER'].includes(request?.context?.client?.clientName) ? request.context.client.clientName : 'other',
          playability: result?.playabilityStatus?.status ?? null, exactVideoId: result?.videoDetails?.videoId === request?.videoId,
          aacFormats: (result?.streamingData?.adaptiveFormats ?? []).filter(format => typeof format?.mimeType === 'string' && format.mimeType.startsWith('audio/mp4')).map(format => ({
            itag: Number.isSafeInteger(format.itag) ? format.itag : null, cipher: typeof format.signatureCipher === 'string' || typeof format.cipher === 'string', directUrl: typeof format.url === 'string', drc: format.isDrc === true })) })
      })().catch(() => report.errors.push('Provider metadata observation failed'))
      pendingObservations.add(operation); void operation.finally(() => pendingObservations.delete(operation))
    }
  })
  await check('frozen compiled build ready before any playback activation', async () => {
    await page.goto(`http://127.0.0.1:${server.address().port}/pletina/application/p1-check.html`, { waitUntil: 'load', timeout: 30000 })
    const initial = await poll('Observer ready', value => value?.build && value.controls.play && value.controls.stop, 15000)
    assert.equal(initial.build, build); report.build = initial.build
    assert.equal(initial.audioCount, 1); assert.equal(initial.audio.muted, false); assert.equal(initial.sameAudio, true)
    if (initial.activation) assert.equal(initial.activation.ever, false)
    return { build, activation: initial.activation, sameAudio: true }
  })
  await check('one real play click starts the compiled P1 AAC and advances without a visible video', async () => {
    await click('existing Epoitaitaye Play button', latest.controls.play)
    const started = await poll('P1 audio advance', value => value?.transport === 'p1' && value.videoId === 'DJzjkMBMook' && !value.audio.paused && value.audio.time > 2 && value.audio.error === null, 45000)
    assert.equal(started.sameAudio, true); assert.equal(started.audioCount, 1); assert.equal(started.videoCount, 0); assert.equal(started.frames, 0)
    assert.equal(started.audio.muted, false); assert.ok(started.audio.volume > 0)
    return { duration: started.audio.duration, time: started.audio.time, unmutedState: true, visibleVideo: false, sameAudio: true, extraPlayInteraction: false }
  })
  await check('Stop unloads P1 and removes temporary frames while preserving the same player', async () => {
    await click('existing Stop button', latest.controls.stop)
    const stopped = await poll('Stopped empty audio', value => value?.audio.paused && !value.audio.hasSource && value.frames === 0, 5000)
    assert.equal(stopped.sameAudio, true); assert.equal(stopped.audioCount, 1)
    await delay(500)
    assert.equal(latest.audio.paused, true); assert.equal(latest.audio.hasSource, false)
    return { paused: true, sourceRemoved: true, sameAudio: true, frames: 0 }
  })
} catch (error) {
  report.errors.push(safe(error.message))
  report.lastState = latest ?? null
} finally {
  await Promise.allSettled([...pendingObservations])
  await context?.close(); await browser?.close()
  if (server) await new Promise(resolve => server.close(resolve))
  report.resourcesClosed = true
}
await mkdir(directory, { recursive: true })
await writeFile(new URL(report.sourceSnapshot.replace('artifacts/pwa-port/', ''), directory), source)
await writeFile(new URL(reportName, directory), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ report: reportName, build: report.build, browser: report.browser, passed: report.checks.filter(check => check.pass).length, failed: report.checks.filter(check => !check.pass).length, inputs: report.inputs.length, errors: report.errors }))
if (report.errors.length || report.checks.some(check => !check.pass)) process.exitCode = 1
