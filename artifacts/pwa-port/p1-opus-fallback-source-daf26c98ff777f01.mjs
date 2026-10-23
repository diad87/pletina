// Derived from the frozen real-UI diagnostic f94fa896a8ca1229. This QA runner
// changes only transport for AAC belonging to one explicitly selected video.
// Provider JSON, other videos, Opus, the decoder and the audio element stay real.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'
import { createPwaServer } from '../preview-pwa.mjs'

const args = process.argv.slice(2), option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const expectedBuild = option('--expected-build', ''), videoId = option('--video-id', 'NGp3dh-hBe8')
const query = option('--query', 'Pirritx Porrotx Ni, Ni, Ni!'), title = option('--title', 'Ni, Ni, Ni!'), artist = option('--artist', 'Pirritx Porrotx')
const catalogId = Number(option('--catalog-id', '3266784871'))
assert.match(expectedBuild, /^[a-f0-9]{16}$/); assert.match(videoId, /^[A-Za-z0-9_-]{11}$/)
assert.ok(Number.isSafeInteger(catalogId) && catalogId > 0 && query.length > 0 && query.length <= 200 && title.length > 0 && title.length <= 200 && artist.length > 0 && artist.length <= 200)
const reportName = option('--report', `p1-opus-fallback-${expectedBuild}-local.json`)
assert.match(reportName, /^p1-opus-fallback-[a-z0-9.-]+\.json$/)
const directory = new URL('../../artifacts/pwa-port/', import.meta.url), source = await readFile(new URL(import.meta.url))
const sha = value => crypto.createHash('sha256').update(value).digest('hex'), sourceHash = sha(source)
const began = Date.now(), timestamp = () => ({ at: new Date().toISOString(), elapsedMs: Date.now() - began })
const report = { schemaVersion: 1, testedAt: new Date().toISOString(), expectedBuild, build: null, query, expectedTitle: title, expectedArtist: artist,
  expectedCatalogId: catalogId, expectedVideoId: videoId, runnerSha256: sourceHash,
  sourceSnapshot: `artifacts/pwa-port/p1-opus-fallback-source-${sourceHash.slice(0, 16)}.mjs`,
  derivedFrom: { file: 'scripts/tests/p1-song-ui-diagnostic.browser.mjs', sha256: 'f94fa896a8ca12291af760d2adb17d47fa023018b8d7072658d46f0cf9571c9e' },
  scope: 'Real compiled UI and provider responses; forced AAC transport failure for the selected video only. Desktop foreground Opus proof, not natural Ni failure, physical mobile, background or audible human verification.',
  policy: { providerResponsesModified: false, nodeBootstrap: false, productMethodsReplaced: false, audioConstructorReplaced: false, decoderReplaced: false,
    sdkInjected: false, securityOverrides: false, autoplayOverrides: false, rawRecipeSaved: false, rawMediaUrlsSaved: false, mediaBytesSaved: false,
    physicalPhone: false, backgroundVerified: false, naturalFailureClaimed: false, outputSilencedByLaunchArgument: false },
  faultInjection: { type: 'target-video AAC HTTP request abort', targetVideoId: videoId, aacItags: [139, 140, 141],
    attribution: 'Exact player response video ID plus content locator and itag; locators stay in RAM', blockedAAC: [], otherVideosBlocked: 0, opusBlocked: 0 },
  observationRpcCalls: 0, observationRpcWithGesture: 0, inputActions: [], checks: [], errors: [], providerResponses: [], cdnRequests: [], cdnHttp: [], networkFailures: [], samples: [] }
const scrub = value => String(value ?? '').replace(/https?:\/\/[^\s"'<>]+/g, '[URL]').replace(/blob:[^\s"'<>]+/g, '[BLOB]').slice(0, 300)
const normalize = value => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms)), pending = new Set(), media = new Map(), mediaByHash = new Map()
let browser, context, page, server, cdp, prototypeId, armed = false

function locator(address) {
  try {
    const url = new URL(address), id = url.searchParams.get('id'), itag = url.searchParams.get('itag')
    if (url.protocol !== 'https:' || !(url.hostname === 'googlevideo.com' || url.hostname.endsWith('.googlevideo.com')) || !id || !/^\d{1,6}$/.test(itag ?? '')) return null
    return { key: id + ':' + itag, contentIdSha256: sha(id), itag: Number(itag), urlSha256: sha(address) }
  } catch { return null }
}
function association(address) {
  const value = locator(address); if (!value) return null
  const entries = media.get(value.key) ?? []
  if (!entries.length) return null
  const ids = [...new Set(entries.map(entry => entry.videoId))], mimes = [...new Set(entries.map(entry => entry.mimeType))]
  return { ...value, videoId: ids.length === 1 ? ids[0] : null, mimeType: mimes.length === 1 ? mimes[0] : null, ambiguous: ids.length !== 1 || mimes.length !== 1 }
}
async function rpc(fn, value = null) {
  report.observationRpcCalls++
  const executionContext = page.mainFrame().mainRealm().context
  const result = await cdp.send('Runtime.callFunctionOn', { executionContextId: executionContext.id, functionDeclaration: fn.toString(),
    arguments: [{ value }], returnByValue: true, awaitPromise: true, userGesture: false })
  if (result.exceptionDetails) throw Error(scrub(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text))
  return result.result.value
}
async function poll(name, fn, maximumMs = 15000) {
  const deadline = Date.now() + maximumMs; let last
  do { try { const value = await fn(); if (value) return value } catch (error) { if (error.fatal) throw error; last = scrub(error.message) }; await delay(200) } while (Date.now() < deadline)
  throw Error(name + ' timed out' + (last ? ': ' + last : ''))
}
async function click(selector, purpose) {
  report.inputActions.push({ ...timestamp(), kind: 'declared viewport scroll without activation', purpose })
  await rpc(selector => document.querySelector(selector)?.scrollIntoView({ block: 'center', behavior: 'instant' }), selector)
  const point = await rpc(selector => { const node = document.querySelector(selector); if (!node) return null
    const rect = node.getBoundingClientRect(), style = getComputedStyle(node), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2, hit = document.elementFromPoint(x, y)
    return rect.width > 0 && rect.height > 0 && x > 0 && x < innerWidth && y > 0 && y < innerHeight && style.visibility !== 'hidden' && style.display !== 'none' && hit && (hit === node || node.contains(hit)) ? { x, y } : null
  }, selector)
  assert.ok(point, 'Visible control: ' + purpose); report.inputActions.push({ ...timestamp(), kind: 'trusted mouse click', purpose }); await page.mouse.click(point.x, point.y)
}
async function audioState() {
  // Main-realm heap inspection, not an Audio constructor proxy or product API.
  // Metadata probes are isolated in opaque iframes, using another prototype.
  report.observationRpcCalls++
  const objects = await cdp.send('Runtime.queryObjects', { prototypeObjectId: prototypeId, objectGroup: 'p1-opus-audio-observation' })
  try {
    report.observationRpcCalls++
    const result = await cdp.send('Runtime.callFunctionOn', { objectId: objects.objects.objectId, returnByValue: true, awaitPromise: true, userGesture: false,
      functionDeclaration: `async function(){return Promise.all(Array.from(this).map(async a=>{
        const address=a.currentSrc||a.src;let url=null;try{url=new URL(address)}catch{}
        const hash=async value=>value?[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join(''):null;
        return {urlSha256:await hash(address),contentIdSha256:await hash(url?.searchParams.get('id')),itag:Number(url?.searchParams.get('itag'))||null,
          time:a.currentTime,duration:Number.isFinite(a.duration)?a.duration:null,paused:a.paused,ended:a.ended,readyState:a.readyState,errorCode:a.error?.code??null,muted:a.muted,volume:a.volume,hasSource:Boolean(address)}}))}` })
    if (result.exceptionDetails) throw Error('Audio observation failed')
    return result.result.value
  } finally { await cdp.send('Runtime.releaseObject', { objectId: objects.objects.objectId }).catch(() => {}) }
}
async function state() {
  const ui = await rpc(() => {
    let selected = null
    try { const value = JSON.parse(localStorage.getItem('pletina:web:queue:v1') ?? 'null'), item = value?.manual ?? value?.queue?.[value?.order?.[value?.pos]]
      if (item?.track) selected = { catalogId: item.track.id, title: item.track.title, artist: item.track.artist?.name ?? null, album: item.albumTitle ?? null, duration: item.track.duration }
    } catch { /* Report null for missing queue. */ }
    const slider = document.querySelector('.player input[aria-label="Posición"]')
    return { selected, mediaSession: { title: navigator.mediaSession?.metadata?.title ?? null, playbackState: navigator.mediaSession?.playbackState ?? null },
      progress: slider ? { time: Number(slider.value), duration: Number(slider.max), disabled: slider.disabled } : null,
      playerHint: document.querySelector('.player .hint')?.textContent.trim() ?? null,
      fallbackOpened: Boolean(document.querySelector('dialog[data-official-youtube][open]')),
      visibleVideoFrames: [...document.querySelectorAll('iframe[data-official-video]')].filter(frame => { const r = frame.getBoundingClientRect(), s = getComputedStyle(frame); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' }).length }
  })
  const audios = await audioState()
  return { ...timestamp(), ...ui, audios: audios.map(audio => {
    const known = [...mediaByHash.values()].filter(value => value.contentIdSha256 === audio.contentIdSha256 && value.itag === audio.itag)
    const ids = [...new Set(known.map(value => value.videoId))], mimes = [...new Set(known.map(value => value.mimeType))]
    return { ...audio, attributedVideoId: ids.length === 1 ? ids[0] : null, mimeType: mimes.length === 1 ? mimes[0] : null }
  }) }
}
async function check(name, fn) {
  try { const details = await fn(); report.checks.push({ name, pass: true, ...details }) }
  catch (error) { report.checks.push({ name, pass: false, error: scrub(error.message) }); throw error }
}

try {
  let url = option('--url', 'https://diad87.github.io/pletina/')
  if (args.includes('--local')) {
    assert.ok(!args.includes('--url'), 'Use either --local or --url'); server = createPwaServer()
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    url = `http://127.0.0.1:${server.address().port}/pletina/`
  }
  const target = new URL(url); assert.ok(target.protocol === 'https:' || target.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(target.hostname))
  report.originKind = server ? 'ephemeral static loopback serving unmodified dist-pwa' : target.protocol === 'https:' ? 'supplied public HTTPS' : 'supplied static loopback'
  browser = await puppeteer.launch({ headless: true, executablePath: option('--chrome', 'C:/Users/iunan/.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe'),
    ignoreDefaultArgs: ['--mute-audio', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], args: [] })
  assert.ok(!browser.process().spawnargs.some(value => /autoplay-policy|MediaEngagementBypassAutoplayPolicies|disable-web-security|ignore-certificate-errors|--mute-audio/.test(value)))
  report.browser = await browser.version(); context = await browser.createBrowserContext(); assert.equal((await context.cookies()).length, 0)
  page = await context.newPage(); await page.setViewport({ width: 1280, height: 1000 }); cdp = page.mainFrame().client
  await cdp.send('Network.enable'); const cdn = new Map()
  cdp.on('Network.requestWillBeSent', event => { const value = locator(event.request.url); if (!value) return
    const known = association(event.request.url), safe = { ...timestamp(), urlSha256: value.urlSha256, itag: value.itag, videoId: known?.videoId ?? null, mimeType: known?.mimeType ?? null }
    cdn.set(event.requestId, safe); report.cdnRequests.push(safe)
  })
  cdp.on('Network.responseReceivedExtraInfo', event => { const request = cdn.get(event.requestId); if (request) report.cdnHttp.push({ ...timestamp(), request, httpStatus: event.statusCode }) })
  cdp.on('Network.loadingFailed', event => { const request = cdn.get(event.requestId); if (request) report.networkFailures.push({ ...timestamp(), request, error: scrub(event.errorText), blockedReason: event.blockedReason ?? null }) })
  page.on('response', response => {
    const operation = (async () => {
      const endpoint = new URL(response.url()); if (!['www.youtube.com', 'music.youtube.com'].includes(endpoint.hostname) || endpoint.pathname !== '/youtubei/v1/player') return
      let request, body; try { request = JSON.parse(response.request().postData() ?? '{}'); body = await response.json() } catch { return }
      const id = /^[A-Za-z0-9_-]{11}$/.test(request.videoId ?? '') ? request.videoId : null
      const exact = body?.videoDetails?.videoId === id, formats = Array.isArray(body?.streamingData?.adaptiveFormats) ? body.streamingData.adaptiveFormats.slice(0, 64) : []
      const safeFormats = []
      for (const format of formats) {
        if (typeof format?.mimeType !== 'string' || !format.mimeType.startsWith('audio/')) continue
        const mime = format.mimeType.slice(0, 120), cipher = typeof format.signatureCipher === 'string' ? format.signatureCipher : typeof format.cipher === 'string' ? format.cipher : null
        const address = typeof format.url === 'string' ? format.url : cipher ? new URLSearchParams(cipher).get('url') : null
        const value = address ? locator(address) : null
        safeFormats.push({ itag: Number.isSafeInteger(format.itag) ? format.itag : null, mimeType: mime,
          contentLength: /^\d{1,12}$/.test(String(format.contentLength ?? '')) ? Number(format.contentLength) : null, cipherPresent: cipher !== null, directUrlPresent: typeof format.url === 'string' })
        if (exact && id && body?.playabilityStatus?.status === 'OK' && value) {
          const entry = { videoId: id, mimeType: mime, contentIdSha256: value.contentIdSha256, itag: value.itag }
          const known = media.get(value.key) ?? []; known.push(entry); media.set(value.key, known)
          mediaByHash.set(value.contentIdSha256 + ':' + value.itag + ':' + id, entry)
        }
      }
      report.providerResponses.push({ ...timestamp(), client: ['VISIONOS', 'WEB_EMBEDDED_PLAYER', 'WEB'].includes(request.context?.client?.clientName) ? request.context.client.clientName : 'other',
        requestedVideoId: id, httpStatus: response.status(), status: typeof body?.playabilityStatus?.status === 'string' ? body.playabilityStatus.status : null,
        exactResponseId: exact, formats: safeFormats })
    })().catch(() => report.errors.push({ kind: 'observer', message: 'PROVIDER_METADATA_OBSERVATION_FAILED' }))
    pending.add(operation); void operation.finally(() => pending.delete(operation))
  })
  await page.setRequestInterception(true)
  page.on('request', request => {
    const operation = (async () => {
      let known = association(request.url())
      if (armed && locator(request.url()) && !known && pending.size) {
        // The browser may finish consuming player JSON while CDP finishes its
        // independent metadata observation. Never guess an unknown media ID.
        await Promise.race([Promise.allSettled([...pending]), delay(1500)])
        known = association(request.url())
      }
      if (armed && known?.videoId === videoId && !known.ambiguous &&
        ([139, 140, 141].includes(known.itag) || known.mimeType?.startsWith('audio/mp4'))) {
        report.faultInjection.blockedAAC.push({ ...timestamp(), videoId, urlSha256: known.urlSha256, itag: known.itag, mimeType: known.mimeType })
        if (!request.isInterceptResolutionHandled()) await request.abort('failed')
      } else if (!request.isInterceptResolutionHandled()) await request.continue()
    })().catch(error => report.errors.push({ kind: 'interceptor', message: scrub(error.message) }))
    pending.add(operation); void operation.finally(() => pending.delete(operation))
  })
  await page.goto(url, { waitUntil: 'load', timeout: 30000 })
  report.build = await poll('Landing build', () => rpc(() => document.querySelector('#version')?.textContent.trim() ?? null)); assert.equal(report.build, expectedBuild)
  assert.equal(await rpc(() => navigator.userActivation.hasBeenActive), false)
  await click('#open-player', 'open compiled Pletina')
  await poll('Search input', () => rpc(() => Boolean(document.querySelector('input[aria-label="Buscar música"]'))), 45000)
  await click('input[aria-label="Buscar música"]', 'focus normal search')
  report.inputActions.push({ ...timestamp(), kind: 'trusted keyboard typing', characters: query.length }); await page.keyboard.type(query)
  const readRows = () => rpc(() => [...document.querySelectorAll('.tracks li[data-reorder-index]')].slice(0, 30).map(element => ({ index: element.dataset.reorderIndex,
    title: element.querySelector('.name')?.textContent.trim() ?? '', artist: element.querySelector('.by')?.textContent.trim() ?? '', album: element.querySelector('.album')?.textContent.trim() ?? '' })))
  const match = row => normalize(row.title) === normalize(title) && artist.split(/\s+/).every(word => normalize(row.artist).includes(normalize(word)))
  let rows = await poll('Canonical search result', async () => { const value = await readRows(); return value.some(match) ? value : null }, 45000)
  report.searchResults = rows; let selected = rows.find(match)
  await click(`.tracks li[data-reorder-index="${selected.index}"] .by button.link`, 'open canonical artist')
  report.artistHeading = await poll('Artist page', () => rpc(() => document.querySelector('.banner h1')?.textContent.trim() ?? null))
  assert.ok(artist.split(/\s+/).every(word => normalize(report.artistHeading).includes(normalize(word))))
  await poll('Artist popular songs', async () => (await readRows()).length > 0)
  if (await rpc(() => document.querySelector('.page > button.more')?.textContent.trim() === 'Mostrar más')) await click('.page > button.more', 'expand artist popular songs')
  rows = await readRows(); selected = rows.find(match); assert.ok(selected, 'Exact song must be in popular songs')
  report.clickedRow = selected
  const prototype = await cdp.send('Runtime.evaluate', { expression: 'HTMLAudioElement.prototype', returnByValue: false, userGesture: false, objectGroup: 'p1-opus-audio-observation' })
  prototypeId = prototype.result.objectId; assert.ok(prototypeId)
  report.browserCodecSupport = await rpc(() => { const probe = document.createElement('audio'); return {
    aac: probe.canPlayType('audio/mp4; codecs="mp4a.40.2"'), opusWebM: probe.canPlayType('audio/webm; codecs="opus"'), opusOgg: probe.canPlayType('audio/ogg; codecs="opus"') } })
  armed = true; report.started = timestamp()
  await click(`.tracks li[data-reorder-index="${selected.index}"] .name`, 'one normal selected song title click')
  await check('forced AAC failure selects real Opus from the exact same video and catalog song', async () => {
    const playing = await poll('Target same-video Opus advances', async () => {
      const value = await state(); report.samples.push(value); if (report.samples.length > 16) report.samples.shift()
      if (value.fallbackOpened) throw Object.assign(Error('Official video fallback opened'), { fatal: true })
      if (value.selected && value.selected.catalogId !== catalogId) throw Object.assign(Error('Selection silently skipped to another catalog song'), { fatal: true })
      const active = value.audios.filter(audio => !audio.paused && audio.time > 2 && audio.readyState >= 3 && audio.errorCode === null)
      return active.length === 1 ? { value, audio: active[0] } : null
    }, 120000)
    assert.ok(report.faultInjection.blockedAAC.length > 0, 'Fault injection must actually intercept target AAC')
    assert.equal(playing.audio.attributedVideoId, videoId); assert.match(playing.audio.mimeType ?? '', /^audio\/(?:webm|ogg).*opus/i)
    assert.ok([249, 250, 251].includes(playing.audio.itag), 'Expected actual provider Opus encoding')
    assert.equal(playing.audio.muted, false); assert.ok(playing.audio.volume > 0)
    assert.equal(playing.value.mediaSession.title, title); assert.equal(playing.value.visibleVideoFrames, 0)
    assert.equal(playing.value.audios.filter(audio => audio.hasSource).length, 1, 'Only one main-realm audio source may be active')
    report.playing = playing
    return { exactVideoId: videoId, exactCatalogId: catalogId, itag: playing.audio.itag, mimeType: playing.audio.mimeType, duration: playing.audio.duration, time: playing.audio.time,
      forcedAACRequests: report.faultInjection.blockedAAC.length, fallbackOpened: false, unmutedAudio: true }
  })
  await check('same selected Opus source keeps advancing without another play interaction', async () => {
    const first = report.playing.audio; await delay(2200); const value = await state(), active = value.audios.filter(audio => !audio.paused && audio.readyState >= 3)
    assert.equal(value.selected?.catalogId, catalogId); assert.equal(active.length, 1); assert.equal(active[0].urlSha256, first.urlSha256)
    assert.equal(active[0].attributedVideoId, videoId); assert.ok(active[0].time > first.time + 1); assert.equal(value.fallbackOpened, false)
    report.finalState = value; return { time: active[0].time, advance: active[0].time - first.time, sameUrlHash: true, sameVideoId: true }
  })
  report.screenshot = reportName.replace(/\.json$/, '.png'); await page.screenshot({ path: new URL(report.screenshot, directory).pathname.replace(/^\/C:/, 'C:'), fullPage: true })
  await click('.player .play', 'pause after evidence')
} catch (error) {
  report.errors.push({ kind: 'runner', message: scrub(error.message) }); if (page && prototypeId) try { report.lastState = await state() } catch { /* Preserve primary failure. */ }
} finally {
  await context?.close(); await Promise.allSettled([...pending]); await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); report.resourcesClosed = true
}
await mkdir(directory, { recursive: true }); await writeFile(new URL(report.sourceSnapshot.replace('artifacts/pwa-port/', ''), directory), source)
await writeFile(new URL(reportName, directory), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ report: reportName, build: report.build, runnerSha256: sourceHash, blockedAAC: report.faultInjection.blockedAAC.length, checks: report.checks, errors: report.errors, resourcesClosed: report.resourcesClosed }))
if (report.errors.length || report.checks.some(value => !value.pass)) process.exitCode = 1
