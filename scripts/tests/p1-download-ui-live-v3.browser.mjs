// Real compiled product UI and real providers. Diagnostic reads only: no QA
// Cache/IDB writes, DOM additions, Audio replacement, bootstrap or fixtures.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
import { createPwaServer } from '../preview-pwa.mjs'

const args = process.argv.slice(2), option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const build = option('--expected-build', ''), reportName = option('--report', `p1-opaque-download-${build}-euri-local-live.json`)
assert.match(build, /^[a-f0-9]{16}$/); assert.match(reportName, /^p1-opaque-download-[a-z0-9.-]+\.json$/)
const wanted = Object.freeze({ query: 'Pirritx Porrotx Euri Tanta', title: 'Euri Tanta', artist: 'Pirritx Porrotx',
  album: 'Euri Tanta Banintz (Joxan Ormazabal)', catalogId: 3266421971, videoId: 'CJ1A6FJnWTU', duration: 109 })
const source = await readFile(new URL(import.meta.url)), sha = value => crypto.createHash('sha256').update(value).digest('hex')
const directory = new URL('../../artifacts/pwa-port/', import.meta.url), began = Date.now()
const stamp = () => ({ at: new Date().toISOString(), elapsedMs: Date.now() - began })
const sourceSnapshot = `p1-download-ui-live-source-${sha(source).slice(0, 16)}.mjs`
const report = { schemaVersion: 1, expectedBuild: build, build: null, testedAt: new Date().toISOString(), wanted,
  runnerSha256: sha(source), sourceSnapshot: 'artifacts/pwa-port/' + sourceSnapshot, checks: [], errors: [], inputActions: [],
  providerResponses: [], cdnHttp: [], networkFailures: [], localRequests: [], progressObservations: [], phase: 'setup',
  scope: 'One Euri Tanta real-provider compiled-product UI download, read-only opaque-cache metadata, offline reload/native playback/tail seek, and UI removal. Desktop Chrome foreground only.',
  policy: { providerMocks: false, nodeBootstrap: false, productMethodsCalled: false, audioConstructorReplaced: false,
    domPrototypeAdded: false, qaCacheWrites: false, qaIdbWrites: false, securityOverrides: false, autoplayOverrides: false,
    rawMediaUrlsSaved: false, audioBytesSavedInArtifacts: false, opaqueBodyRead: false, bodyHashClaimed: false,
    actualBodyByteCountClaimed: false, physicalPhone: false, backgroundVerified: false },
  observationRpcCalls: 0, observationRpcWithGesture: 0, navigationObservationRetries: [] }
const scrub = value => String(value ?? '').replace(/https?:\/\/[^\s"'<>]+/g, '[URL]').replace(/blob:[^\s"'<>]+/g, '[BLOB]').slice(0, 400)
const normalize = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms)), pending = new Set(), cdn = new Map()
let browser, context, page, server

async function observe(fn, arg = null) {
  report.observationRpcCalls++
  const result = await page.mainFrame().client.send('Runtime.callFunctionOn', { executionContextId: page.mainFrame().mainRealm().context.id,
    functionDeclaration: fn.toString(), arguments: [{ value: arg }], returnByValue: true, awaitPromise: true, userGesture: false })
  if (result.exceptionDetails) throw Error(scrub(result.exceptionDetails.exception?.description || result.exceptionDetails.text))
  return result.result.value
}
async function poll(name, fn, maximum = 25000) {
  const end = Date.now() + maximum
  do {
    try { const value = await fn(); if (value) return value }
    catch (error) {
      const transition = /Cannot find context with specified id|Execution context was destroyed/.exec(String(error.message))
      if (error.name !== 'ProtocolError' || !transition) throw error
      report.navigationObservationRetries.push({ ...stamp(), polling: name, kind: transition[0] })
      // The next fn() obtains the current realm/context again. The original
      // poll deadline is unchanged; assertions and every other error propagate.
    }
    await delay(200)
  } while (Date.now() < end)
  throw Error(name + ' timed out')
}
async function click(selector, purpose, fraction = null) {
  await observe(selector => document.querySelector(selector)?.scrollIntoView({ block: 'center', behavior: 'instant' }), selector)
  const point = await observe(({ selector, fraction }) => {
    const node = document.querySelector(selector); if (!node) return null
    const r = node.getBoundingClientRect(), x = r.x + r.width * (fraction ?? .5), y = r.y + r.height / 2, hit = document.elementFromPoint(x, y)
    return r.width > 0 && r.height > 0 && hit && (hit === node || node.contains(hit)) ? { x, y } : null
  }, { selector, fraction })
  assert.ok(point, 'Visible control: ' + purpose)
  report.inputActions.push({ ...stamp(), kind: 'trusted mouse click', purpose, ...(fraction === null ? {} : { fraction }) })
  await page.mouse.click(point.x, point.y)
}
async function clickText(selector, text, purpose) {
  const point = await observe(({ selector, text }) => {
    const node = [...document.querySelectorAll(selector)].find(node => (node.querySelector('.title')?.textContent || node.textContent).trim() === text)
    if (!node) return null
    node.scrollIntoView({ block: 'center', behavior: 'instant' })
    const r = node.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2, hit = document.elementFromPoint(x, y)
    return r.width > 0 && r.height > 0 && hit && (hit === node || node.contains(hit)) ? { x, y } : null
  }, { selector, text })
  assert.ok(point, 'Visible text control: ' + text)
  report.inputActions.push({ ...stamp(), kind: 'trusted mouse click', purpose }); await page.mouse.click(point.x, point.y)
}
const playback = () => observe(() => {
  const slider = document.querySelector('.player input[aria-label="Posición"]')
  const frames = [...document.querySelectorAll('iframe')].map(frame => {
    const rect = frame.getBoundingClientRect(), style = getComputedStyle(frame)
    let youtubeHost = false
    try { const host = new URL(frame.getAttribute('src') || 'about:blank', location.href).hostname; youtubeHost = ['youtube.com', 'youtube-nocookie.com', 'youtu.be'].some(domain => host === domain || host.endsWith('.' + domain)) } catch {}
    // Application-owned srcdoc can contain a signed media locator. Inspect only
    // its known message marker in memory; never return src/srcdoc or a URL.
    return { hidden: frame.hidden, ariaHidden: frame.getAttribute('aria-hidden') === 'true', sandbox: [...frame.sandbox],
      metadataBridgeMarker: frame.hasAttribute('srcdoc') && frame.srcdoc.includes('pletina-youtube-p1-metadata'), youtubeHost,
      visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' }
  })
  let selected = null
  try {
    const saved = JSON.parse(localStorage.getItem('pletina:web:queue:v1') ?? 'null'), item = saved?.manual ?? saved?.queue?.[saved?.order?.[saved?.pos]]
    if (item?.track) selected = { catalogId: item.track.id, title: item.track.title, artist: item.track.artist?.name ?? null, duration: item.track.duration }
  } catch { /* An absent/corrupt queue is observable, not repaired by this QA. */ }
  return { online: navigator.onLine, selected, title: navigator.mediaSession?.metadata?.title ?? null,
    state: navigator.mediaSession?.playbackState ?? null, time: slider ? Number(slider.value) : null, duration: slider ? Number(slider.max) : null,
    videoModal: Boolean(document.querySelector('dialog[data-official-youtube][open]')), iframeCount: frames.length, frames,
    youtubeFrameCount: frames.filter(frame => frame.youtubeHost).length, visibleFrameCount: frames.filter(frame => frame.visible).length,
    unrecognizedFrameCount: frames.filter(frame => !(frame.hidden && frame.ariaHidden && frame.sandbox.length === 1 && frame.sandbox[0] === 'allow-scripts' && frame.metadataBridgeMarker && !frame.youtubeHost && !frame.visible)).length }
})
async function nativeAudio() {
  // Runtime.queryObjects inspects native instances without replacing Audio or
  // retaining them between observations. Every call explicitly lacks a gesture.
  const cdp = page.mainFrame().client, objectGroup = 'p1-download-native-observation'
  report.observationRpcCalls++
  try {
    const proto = await cdp.send('Runtime.evaluate', { expression: 'HTMLAudioElement.prototype', contextId: page.mainFrame().mainRealm().context.id,
      objectGroup, returnByValue: false, userGesture: false, silent: true })
    assert.ok(proto.result.objectId, 'Native Audio prototype must be observable')
    const objects = await cdp.send('Runtime.queryObjects', { prototypeObjectId: proto.result.objectId, objectGroup })
    const result = await cdp.send('Runtime.callFunctionOn', { objectId: objects.objects.objectId,
      functionDeclaration: `function () { return this.map(audio => {
        let localPath = null, external = false
        try { const url = new URL(audio.currentSrc || audio.src); external = url.origin !== location.origin; if (!external) localPath = url.pathname + url.search } catch {}
        return { localPath, external, paused: audio.paused, time: audio.currentTime, duration: Number.isFinite(audio.duration) ? audio.duration : null,
          error: audio.error?.code ?? null, seeking: audio.seeking, readyState: audio.readyState, muted: audio.muted, volume: audio.volume }
      }) }`, returnByValue: true, awaitPromise: false, userGesture: false })
    if (result.exceptionDetails) throw Error('Native Audio observation failed')
    return result.result.value
  } finally { await cdp.send('Runtime.releaseObjectGroup', { objectGroup }).catch(() => {}) }
}
const networkProbe = () => observe(async () => {
  const url = new URL('../__qa_p1_download_network_' + crypto.randomUUID(), location.href)
  try { const response = await fetch(url, { cache: 'no-store', credentials: 'omit' }); return { blocked: false, status: response.status } }
  catch { return { blocked: true } }
})
async function downloadsView() {
  await clickText('.sidebar .library button.item', 'Descargas', 'open real Downloads view')
  await poll('Downloads heading', () => observe(() => document.querySelector('.page-title')?.textContent.trim() === 'Descargas'))
}
async function mobileScreenshot(label) {
  const name = reportName.replace(/\.json$/, `-${label}-mobile.png`)
  report.inputActions.push({ ...stamp(), kind: 'declared viewport change without activation', width: 393, height: 852, purpose: label + ' screenshot on desktop Chrome; no mobile-platform claim' })
  await page.setViewport({ width: 393, height: 852 }); await delay(250)
  await mkdir(directory, { recursive: true }); await page.screenshot({ path: fileURLToPath(new URL(name, directory)), fullPage: true })
  await page.setViewport({ width: 1280, height: 1000 }); await delay(100)
  return name
}
async function savedFile() {
  return observe(async id => {
    if (!(await indexedDB.databases()).some(db => db.name === 'pletina-web-downloads')) return null
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('pletina-web-downloads'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(Error('Download database unavailable')) })
    try {
      const saved = await new Promise((resolve, reject) => { const r = db.transaction('files', 'readonly').objectStore('files').get(id); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(Error('Download row unavailable')) })
      if (!saved) return null
      const key = new URL(saved.cacheKey), cache = await caches.has('pletina-audio-downloads:v1') ? await caches.open('pletina-audio-downloads:v1') : null
      const response = cache ? await cache.match(saved.cacheKey) : null
      return { id: saved.id, title: saved.track?.title ?? null, declaredSize: saved.size, at: saved.at,
        cacheKeyPath: key.origin === location.origin ? key.pathname + key.search : null,
        internalPointer: key.origin === location.origin && key.pathname.endsWith('/__audio__/' + id),
        sourcePresent: saved.source !== undefined, cached: Boolean(response), responseType: response?.type ?? null, status: response?.status ?? null,
        storedTemporaryUrl: /blob:|googlevideo|[?&](?:sig|signature|expire)=/i.test(JSON.stringify(saved)), actualBodyBytes: null, sha256: null }
    } finally { db.close() }
  }, wanted.catalogId)
}
async function sourceChoice() {
  return observe(async id => {
    if (!(await indexedDB.databases()).some(db => db.name === 'pletina-web-library')) return null
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('pletina-web-library'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(Error('Library unavailable')) })
    try {
      const row = await new Promise((resolve, reject) => { const r = db.transaction('sources', 'readonly').objectStore('sources').get(id); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(Error('Source choice unavailable')) })
      return row?.choice ? { trackId: row.trackId, videoId: row.choice.videoId, title: row.choice.title, verified: row.choice.verified } : null
    } finally { db.close() }
  }, wanted.catalogId)
}
function assertExact(p) {
  assert.equal(p.selected?.catalogId, wanted.catalogId); assert.equal(p.selected?.title, wanted.title); assert.equal(p.title, wanted.title)
  assert.equal(p.videoModal, false); assert.equal(p.youtubeFrameCount, 0); assert.equal(p.visibleFrameCount, 0); assert.equal(p.unrecognizedFrameCount, 0)
}

try {
  let target = option('--url', '')
  if (!target) {
    server = createPwaServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    target = `http://127.0.0.1:${server.address().port}/pletina/`
  }
  const url = new URL(target)
  assert.ok(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
  report.originKind = server ? 'ephemeral static loopback serving unmodified compiled dist-pwa' : 'supplied HTTPS'
  browser = await puppeteer.launch({ headless: true, executablePath: option('--chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'),
    ignoreDefaultArgs: ['--mute-audio', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], args: [] })
  assert.ok(!browser.process().spawnargs.some(v => /autoplay-policy|MediaEngagementBypassAutoplayPolicies|disable-web-security|ignore-certificate-errors|--mute-audio/.test(v)))
  report.browser = await browser.version(); context = await browser.createBrowserContext(); assert.equal((await context.cookies()).length, 0)
  page = await context.newPage(); await page.setViewport({ width: 1280, height: 1000 })
  page.on('pageerror', error => report.errors.push({ ...stamp(), category: 'page', message: scrub(error.message) }))
  const cdp = page.mainFrame().client; await cdp.send('Network.enable')
  cdp.on('Network.requestWillBeSent', event => {
    let u; try { u = new URL(event.request.url) } catch { return }
    if (u.hostname.endsWith('.googlevideo.com')) cdn.set(event.requestId, { ...stamp(), phase: report.phase, urlSha256: sha(event.request.url), itag: u.searchParams.get('itag'), type: event.type })
    if (u.origin === url.origin && u.pathname.endsWith('/__audio__/' + wanted.catalogId)) report.localRequests.push({ ...stamp(), phase: report.phase, path: '/__audio__/' + wanted.catalogId, type: event.type, method: event.request.method })
  })
  cdp.on('Network.responseReceivedExtraInfo', event => {
    const request = cdn.get(event.requestId); if (!request) return
    const header = key => Object.entries(event.headers ?? {}).find(([name]) => name.toLowerCase() === key)?.[1]
    report.cdnHttp.push({ ...stamp(), request, status: event.statusCode,
      contentType: typeof header('content-type') === 'string' ? header('content-type').split(';')[0].slice(0, 60) : null,
      declaredContentLength: /^\d+$/.test(String(header('content-length') ?? '')) ? Number(header('content-length')) : null,
      allowOriginPresent: typeof header('access-control-allow-origin') === 'string' })
  })
  cdp.on('Network.loadingFailed', event => { const request = cdn.get(event.requestId); if (request) report.networkFailures.push({ ...stamp(), request, error: scrub(event.errorText), blockedReason: event.blockedReason ?? null }) })
  page.on('response', response => {
    const work = (async () => {
      const u = new URL(response.url()); if (!['www.youtube.com', 'music.youtube.com'].includes(u.hostname) || u.pathname !== '/youtubei/v1/player') return
      let request, body; try { request = JSON.parse(response.request().postData() ?? '{}'); body = await response.json() } catch { return }
      const requestedVideoId = /^[\w-]{11}$/.test(request.videoId ?? '') ? request.videoId : null
      report.providerResponses.push({ ...stamp(), phase: report.phase, requestedVideoId,
        client: ['VISIONOS', 'WEB_EMBEDDED_PLAYER', 'WEB'].includes(request.context?.client?.clientName) ? request.context.client.clientName : 'other',
        httpStatus: response.status(), status: typeof body?.playabilityStatus?.status === 'string' ? body.playabilityStatus.status : null,
        exactResponseId: requestedVideoId !== null && body?.videoDetails?.videoId === requestedVideoId,
        audioFormats: Array.isArray(body?.streamingData?.adaptiveFormats) ? body.streamingData.adaptiveFormats.filter(f => typeof f?.mimeType === 'string' && f.mimeType.startsWith('audio/')).length : 0 })
    })().catch(() => report.errors.push({ category: 'observer', message: 'Provider metadata observation failed' }))
    pending.add(work); void work.finally(() => pending.delete(work))
  })
  await page.goto(target, { waitUntil: 'load', timeout: 30000 })
  report.build = await observe(() => document.querySelector('#version')?.textContent.trim() ?? '')
  assert.equal(report.build, build)
  await poll('Shell service worker control', () => observe(() => Boolean(navigator.serviceWorker.controller)))
  await click('#open-player', 'open compiled Pletina')
  await poll('Application search', () => observe(() => Boolean(document.querySelector('.topbar input'))))
  await observe(() => {
    window.__p1DownloadUiEvents = []
    window.addEventListener('pletina:download', ({ detail }) => window.__p1DownloadUiEvents.push({ trackId: detail.trackId, state: detail.state,
      progress: detail.progress, error: detail.error ? String(detail.error).replace(/https?:\/\/[^\s]+/g, '[URL]') : null }))
  })
  await click('.topbar input', 'focus music search'); await page.keyboard.type(wanted.query)
  report.inputActions.push({ ...stamp(), kind: 'trusted keyboard typing', characters: wanted.query.length })
  const selected = await poll('Exact Euri catalog row', async () => {
    const rows = await observe(() => [...document.querySelectorAll('.tracks li[data-reorder-index]')].map(row => ({ index: row.dataset.reorderIndex,
      title: row.querySelector('.name')?.textContent.trim() ?? '', artist: row.querySelector('.by')?.textContent.trim() ?? '', text: row.textContent })))
    return rows.find(row => normalize(row.title) === normalize(wanted.title) && wanted.artist.split(/\s+/).every(w => normalize(row.artist).includes(normalize(w))) && normalize(row.text).includes(normalize(wanted.album)))
  }, 45000)
  report.selectedRow = { index: selected.index, title: selected.title, artist: selected.artist }
  const row = `.tracks li[data-reorder-index="${selected.index}"]`
  report.phase = 'online-play'
  await click(row + ' .name', 'one normal title click on exact Euri row')
  const initial = await poll('Exact song native playback', async () => { const p = await playback(); return p.videoModal || p.state === 'playing' && p.time > 2 ? p : null }, 120000)
  assertExact(initial); assert.equal(initial.state, 'playing'); assert.ok(Math.abs(initial.duration - wanted.duration) < 3)
  report.onlinePlayback = initial; report.onlineNative = await nativeAudio()
  report.selectedSource = await sourceChoice(); assert.equal(report.selectedSource?.trackId, wanted.catalogId); assert.equal(report.selectedSource?.videoId, wanted.videoId)
  assert.ok(report.providerResponses.some(r => r.client === 'WEB_EMBEDDED_PLAYER' && r.requestedVideoId === wanted.videoId && r.exactResponseId && r.status === 'OK'), 'Real P1 must have resolved this exact video')
  await click('.player .play', 'pause the real song before downloading')
  await poll('Native player paused', async () => (await playback()).state === 'paused')
  report.checks.push({ name: 'one normal UI click plays the exact P1 video natively and retains its catalog/source identity', pass: true })

  report.phase = 'download'; report.downloadStarted = stamp()
  await click(row + ' button.more', 'open exact song menu'); await clickText('[role="menuitem"]', 'Descargar', 'download the exact song through product UI')
  await downloadsView()
  let lastProgress = -10000
  const terminal = await poll('Product opaque download commits', async () => {
    const state = await observe(id => ({ terminal: window.__p1DownloadUiEvents.findLast(e => e.trackId === id && ['done', 'error', 'cancelled'].includes(e.state)) ?? null,
      lastEvent: window.__p1DownloadUiEvents.findLast(e => e.trackId === id) ?? null, visible: [...document.querySelectorAll('.queue li')].map(row => ({ title: row.querySelector('.title')?.textContent.trim(), label: row.querySelector('.pct')?.textContent.trim() })) }), wanted.catalogId)
    if (Date.now() - began - lastProgress >= 10000) {
      lastProgress = Date.now() - began; report.progressObservations.push({ ...stamp(), ...state })
      console.log(JSON.stringify({ phase: 'waiting-product-download', elapsedMs: Date.now() - began, lastEvent: state.lastEvent, visible: state.visible }))
    }
    if (!report.loadingScreenshot && state.visible.some(row => row.title === wanted.title && row.label === 'En curso')) report.loadingScreenshot = await mobileScreenshot('download-in-progress')
    return state.terminal
  }, 620000)
  report.downloadFinished = stamp(); report.downloadEvents = await observe(() => window.__p1DownloadUiEvents)
  assert.equal(terminal.state, 'done', terminal.error ?? terminal.state)
  const onlineFile = await savedFile(); assert.ok(onlineFile)
  assert.equal(onlineFile.id, wanted.catalogId); assert.equal(onlineFile.title, wanted.title)
  assert.equal(onlineFile.internalPointer, true); assert.equal(onlineFile.storedTemporaryUrl, false); assert.equal(onlineFile.sourcePresent, false)
  assert.equal(onlineFile.cached, true); assert.equal(onlineFile.responseType, 'opaque'); assert.equal(onlineFile.status, 0)
  report.committedFile = onlineFile; report.downloadSource = await sourceChoice(); assert.equal(report.downloadSource?.videoId, wanted.videoId)
  await poll('Downloaded title visible', () => observe(title => [...document.querySelectorAll('.tracks .name')].some(node => node.textContent.trim() === title), wanted.title))
  report.doneScreenshot = await mobileScreenshot('download-done')
  report.checks.push({ name: 'real Download menu commits an opaque local copy with exact metadata and no persisted signed URL', pass: true })

  report.phase = 'offline-reload'; report.onlineNetworkProbe = await networkProbe(); assert.equal(report.onlineNetworkProbe.blocked, false)
  const offline = { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }
  await cdp.send('Network.overrideNetworkState', offline); await cdp.send('Network.emulateNetworkConditions', offline)
  report.beforeReloadNetworkProbe = await networkProbe(); assert.equal(report.beforeReloadNetworkProbe.blocked, true)
  assert.equal((await playback()).online, false)
  await page.reload({ waitUntil: 'load', timeout: 30000 })
  await poll('Cached application reload', () => observe(() => Boolean(document.querySelector('.sidebar'))))
  report.afterReloadNetworkProbe = await networkProbe(); assert.equal(report.afterReloadNetworkProbe.blocked, true)
  await page.mainFrame().client.send('Network.overrideNetworkState', offline)
  assert.equal((await playback()).online, false)
  await downloadsView()
  report.offlineFile = await savedFile(); assert.deepEqual(report.offlineFile, onlineFile)
  const index = await observe(title => [...document.querySelectorAll('.tracks li[data-reorder-index]')].find(row => row.querySelector('.name')?.textContent.trim() === title)?.dataset.reorderIndex ?? null, wanted.title)
  assert.notEqual(index, null)
  report.phase = 'offline-play'
  await click(`.tracks li[data-reorder-index="${index}"] .name`, 'one real downloaded title click while network is blocked')
  const localStart = await poll('Offline UI/native playback advances', async () => { const p = await playback(); return p.state === 'playing' && p.time > 1 ? p : null })
  assertExact(localStart); assert.equal(localStart.online, false); assert.ok(Math.abs(localStart.duration - wanted.duration) < 3)
  const nativeStart = await nativeAudio()
  assert.ok(nativeStart.some(a => a.localPath?.split('?')[0].endsWith('/__audio__/' + wanted.catalogId) && !a.paused && a.time > 0 && !a.error && !a.muted && a.volume > 0), 'Actual native Audio must play the internal downloaded route')
  await click('.player input[aria-label="Posición"]', 'trusted UI seek to final ten percent of local audio', .9)
  const localTail = await poll('Offline native tail seek advances', async () => {
    const p = await playback(), actual = await nativeAudio()
    return p.state === 'playing' && p.time > wanted.duration * .88 && actual.some(a => a.localPath?.split('?')[0].endsWith('/__audio__/' + wanted.catalogId) && !a.paused && !a.seeking && a.time > wanted.duration * .88 && a.readyState >= 2 && !a.error) ? { ui: p, native: actual } : null
  })
  assertExact(localTail.ui)
  const afterTail = await poll('Offline playback keeps advancing after the tail seek', async () => { const p = await playback(); return p.time > localTail.ui.time ? p : null }, 5000)
  report.offlinePlayback = { initial: localStart, nativeInitial: nativeStart, tail: localTail, afterTail, nativeAfterTail: await nativeAudio() }
  assert.ok(report.localRequests.some(r => r.phase === 'offline-play' && r.type === 'Media'), 'Native playback must request the cached local route')
  report.checks.push({ name: 'offline reload retains the product download and normal UI playback plus native tail seek works without network', pass: true })
  report.screenshot = reportName.replace(/\.json$/, '.png'); await mkdir(directory, { recursive: true })
  await page.screenshot({ path: fileURLToPath(new URL(report.screenshot, directory)), fullPage: true })
  await click('.player .play', 'pause before removing the downloaded file')

  report.phase = 'ui-remove'
  await click(`.tracks li[data-reorder-index="${index}"] button.more`, 'open downloaded song menu')
  await clickText('[role="menuitem"]', 'Quitar descarga', 'remove the download through product UI')
  await poll('Downloaded row is removed', async () => await savedFile() === null && await observe(title => ![...document.querySelectorAll('.tracks .name')].some(n => n.textContent.trim() === title), wanted.title))
  report.removed = await observe(async ({ id, keyPath }) => {
    const cache = await caches.has('pletina-audio-downloads:v1') ? await caches.open('pletina-audio-downloads:v1') : null
    const present = cache ? Boolean(await cache.match(new URL(keyPath, location.origin).href)) : false
    const stable = new URL('../__audio__/' + id, location.href), response = await fetch(stable, { cache: 'no-store', credentials: 'omit' })
    return { cachedStageRetained: present, localRouteStatus: response.status,
      downloadedTitleStillVisible: [...document.querySelectorAll('.tracks .name')].some(n => n.textContent.trim() === 'Euri Tanta') }
  }, { id: wanted.catalogId, keyPath: onlineFile.cacheKeyPath })
  assert.equal(report.removed.cachedStageRetained, false); assert.equal(report.removed.localRouteStatus, 404); assert.equal(report.removed.downloadedTitleStillVisible, false)
  report.checks.push({ name: 'real Quitar descarga removes the IDB pointer and cache entry and the local route returns 404 offline', pass: true })
} catch (error) {
  report.errors.push({ ...stamp(), category: 'runner', message: scrub(error.message) })
  if (page) report.lastPlayback = await playback().catch(() => null)
  if (page) report.lastNative = await nativeAudio().catch(() => null)
  if (page) {
    report.failureScreenshot = reportName.replace(/\.json$/, '-failure.png'); await mkdir(directory, { recursive: true })
    await page.screenshot({ path: fileURLToPath(new URL(report.failureScreenshot, directory)), fullPage: true }).catch(() => {})
  }
} finally {
  await Promise.allSettled([...pending]); await context?.close(); await browser?.close()
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
  report.resourcesClosed = true
}
await mkdir(directory, { recursive: true }); await writeFile(new URL(sourceSnapshot, directory), source)
await writeFile(new URL(reportName, directory), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ report: reportName, build: report.build, passed: report.checks.filter(c => c.pass).length, errors: report.errors, resourcesClosed: report.resourcesClosed }))
if (report.errors.length || report.checks.length !== 4 || report.checks.some(c => !c.pass)) process.exitCode = 1
