// ISOLATED QA PROTOTYPE, not an application-download E2E or product feature.
// One opaque response uses a temporary local QA CacheStorage key; no IDB download
// row or user-facing downloaded status is created. Finally removes that key.
// Real search UI diagnostic. No Audio proxy, injected SDK, product replacement,
// provider fixture or Node bootstrap. Optional caught-exception pauses are marked
// as instrumented timings and resume immediately without reading scopes/locals.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'
import { createPwaServer } from '../preview-pwa.mjs'

const args = process.argv.slice(2), option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const expectedBuild = option('--expected-build', ''); assert.match(expectedBuild, /^[a-f0-9]{16}$/)
const query = option('--query', ''), title = option('--title', ''), artist = option('--artist', '')
assert.ok(query.length > 0 && query.length <= 200 && title.length > 0 && title.length <= 200 && artist.length <= 200)
const diagnostic = args.includes('--exceptions'), reportName = option('--report', 'p1-song-opaque-download-prototype.json')
const artistView = args.includes('--artist-view')
const songControl = option('--song-control', 'title')
assert.ok(['title', 'cover'].includes(songControl))
assert.match(reportName, /^p1-song-[a-z0-9.-]+\.json$/)
const source = await readFile(new URL(import.meta.url)), sha = value => crypto.createHash('sha256').update(value).digest('hex')
const directory = new URL('../../artifacts/pwa-port/', import.meta.url), began = Date.now(), timestamp = () => ({ at: new Date().toISOString(), elapsedMs: Date.now() - began })
const report = { schemaVersion: 1, testedAt: new Date().toISOString(), expectedBuild, build: null, query, expectedTitle: title, expectedArtist: artist,
  runnerSha256: sha(source), sourceSnapshot: `artifacts/pwa-port/p1-opaque-download-prototype-source-${sha(source).slice(0, 16)}.mjs`,
  scope: 'ISOLATED QA PROTOTYPE: public PWA selects real audio; diagnostic-only no-cors Cache.put and added DOM Audio/buttons test a local staging key offline. Not product-download E2E. Desktop foreground only.',
  policy: { providerMocks: false, nodeBootstrap: false, productMethodsReplaced: false, audioConstructorReplaced: false, sdkInjected: false,
    securityOverrides: false, autoplayOverrides: false, rawRecipeSaved: false, rawMediaUrlsSaved: false, mediaBytesSavedInArtifacts: false,
    temporaryOpaqueCacheWrite: true, idbDownloadRowWritten: false, productDownloadedStateSet: false, prototypeDomAdded: true,
    exceptionLocalsRead: false, exceptionPropertiesRead: false, debuggerPauses: diagnostic, instrumentedTimings: diagnostic, physicalPhone: false, backgroundVerified: false },
  observationRpcCalls: 0, observationRpcWithGesture: 0, inputActions: [], checks: [], errors: [], exceptions: [], providerResponses: [], cdnHttp: [], networkFailures: [] }
const scrub = value => String(value ?? '').replace(/https?:\/\/[^\s"'<>]+/g, '[URL]').replace(/blob:[^\s"'<>]+/g, '[BLOB]').slice(0, 300)
const normalize = value => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms)), pending = new Set(), scriptAssets = new Map()
let browser, context, page, server, selectedMediaUrl = null, prototypeKey = null

async function stageOpaquePrototype(config) {
  const parsed = new URL(config.url), declaredBytes = Number(parsed.searchParams.get('clen')), maximumDeclaredBytes = 8 * 1024 * 1024
  if (!Number.isSafeInteger(declaredBytes) || declaredBytes <= 0 || declaredBytes > maximumDeclaredBytes) throw Error('Declared source size exceeds the QA budget or is missing')
  const key = new URL('../__audio__/999900001?stage=' + Date.now() + '-qaopaquecontrol', location.href).href
  // Set the local key before awaiting network, so every failure can clean up.
  window.__qaOpaqueKey = key
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000), cache = await caches.open('pletina-audio-downloads:v1')
  let put, completed = false
  try {
    const response = await fetch(config.url, { mode: 'no-cors', credentials: 'omit', redirect: 'follow', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal })
    const metadata = { type: response.type, status: response.status, readableHeaders: [...response.headers].length > 0 }
    if (response.type !== 'opaque') throw Error('QA expected an opaque source response')
    put = cache.put(key, response)
    void put.then(() => { if (controller.signal.aborted) return cache.delete(key) }).catch(() => {})
    await Promise.race([put, new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(Error('Opaque transfer deadline')), { once: true }))])
    if (controller.signal.aborted) throw Error('Opaque transfer deadline')
    const stored = await cache.match(key)
    if (!stored || stored.type !== 'opaque') throw Error('Opaque response was not retained in the QA cache')
    completed = true
    return { key, keyPath: new URL(key).pathname + new URL(key).search, declaredBytes, maximumDeclaredBytes,
      actualBodyBytes: null, sha256: null, bodyReadable: false, metadata, cachePutCompleted: true, cacheType: stored.type,
      actualByteLimitEnforced: false, declaredByteBudgetOnly: true }
  } finally {
    clearTimeout(timer)
    if (!completed) { controller.abort(); await cache.delete(key).catch(() => false) }
  }
}

function installPrototypeAudio(config) {
  document.querySelector('#qa-opaque-prototype')?.remove()
  const panel = document.createElement('section'), title = document.createElement('strong'), play = document.createElement('button'), audio = document.createElement('audio')
  panel.id = 'qa-opaque-prototype'
  panel.style.cssText = 'position:fixed;z-index:999999;left:20px;top:20px;padding:20px;background:#fff;color:#000;max-width:480px;border:3px solid #a00'
  title.textContent = 'Prototipo QA de caché opaca (no es una descarga de Pletina)'
  play.id = 'qa-opaque-play'; play.textContent = 'Reproducir copia QA sin red'; play.style.cssText = 'display:block;margin:16px 0;padding:16px'
  audio.controls = true; audio.preload = 'auto'; audio.volume = .3; audio.muted = false
  const observation = window.__qaOpaqueAudio = { audio, expectedDuration: config.expectedDuration, trustedPlayClicks: [], playFailures: [], events: [] }
  for (const type of ['loadedmetadata', 'loadeddata', 'canplay', 'seeked', 'playing', 'ended', 'error']) audio.addEventListener(type, () => observation.events.push({ type, time: Number.isFinite(audio.currentTime) ? audio.currentTime : null, duration: Number.isFinite(audio.duration) ? audio.duration : null, error: audio.error?.code ?? null }))
  play.onclick = event => {
    observation.trustedPlayClicks.push(event.isTrusted)
    audio.currentTime = 0
    audio.play().catch(error => observation.playFailures.push(error.name))
  }
  panel.append(title, play, audio); document.body.append(panel); audio.src = config.key; audio.load()
  return { prototypeDomAdded: true, nativeCanPlayAac: audio.canPlayType('audio/mp4; codecs="mp4a.40.2"'), nativeCanPlayOpus: audio.canPlayType('audio/webm; codecs="opus"') }
}

async function validatePrototypeTail(config) {
  const value = window.__qaOpaqueAudio, audio = value?.audio
  if (!audio) throw Error('QA Audio is missing')
  if (!Number.isFinite(audio.duration) || Math.abs(audio.duration - config.expectedDuration) > 3) throw Error('Cached audio duration mismatch')
  const tail = Math.max(0, audio.duration - .25)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(Error('Cached tail seek deadline')), 10000)
    const finish = error => { clearTimeout(timer); for (const type of ['seeked', 'canplay', 'loadeddata']) audio.removeEventListener(type, ready); audio.removeEventListener('error', failed); error ? reject(error) : resolve() }
    const ready = () => { if (!audio.seeking && audio.readyState >= 2 && audio.currentTime >= tail - .1) finish() }
    const failed = () => finish(Error('Cached tail decode failed'))
    for (const type of ['seeked', 'canplay', 'loadeddata']) audio.addEventListener(type, ready)
    audio.addEventListener('error', failed)
    try { audio.currentTime = tail; ready() } catch (error) { finish(error) }
  })
  return { duration: audio.duration, tail: audio.currentTime, readyState: audio.readyState, error: audio.error?.code ?? null,
    paused: audio.paused, localPath: new URL(audio.currentSrc || audio.src).pathname + new URL(audio.currentSrc || audio.src).search,
    online: navigator.onLine, nativeDecodableTail: true }
}

const prototypeAudioState = () => rpc(() => {
  const value = window.__qaOpaqueAudio, audio = value?.audio
  return audio ? { paused: audio.paused, time: audio.currentTime, duration: Number.isFinite(audio.duration) ? audio.duration : null,
    error: audio.error?.code ?? null, readyState: audio.readyState, muted: audio.muted, volume: audio.volume,
    path: new URL(audio.currentSrc || audio.src).pathname + new URL(audio.currentSrc || audio.src).search,
    trustedPlayClicks: value.trustedPlayClicks, playFailures: value.playFailures, events: value.events, online: navigator.onLine } : null
})
const uncachedNetworkProbe = () => rpc(async () => {
  try { const response = await fetch(new URL('../__qa_opaque_network_' + crypto.randomUUID(), location.href), { cache: 'no-store', credentials: 'omit' }); return { blocked: false, status: response.status } }
  catch { return { blocked: true } }
})

async function rpc(fn, value = null) {
  report.observationRpcCalls++
  const executionContext = page.mainFrame().mainRealm().context
  const result = await page.mainFrame().client.send('Runtime.callFunctionOn', { executionContextId: executionContext.id,
    functionDeclaration: fn.toString(), arguments: [{ value }], returnByValue: true, awaitPromise: true, userGesture: false })
  if (result.exceptionDetails) throw Error(scrub(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text))
  return result.result.value
}
async function poll(name, fn, maximumMs = 15000) {
  const deadline = Date.now() + maximumMs; let last
  do { try { const value = await fn(); if (value) return value } catch (error) { last = scrub(error.message) }; await delay(200) } while (Date.now() < deadline)
  throw Error(name + ' timed out' + (last ? ': ' + last : ''))
}
async function click(selector, purpose) {
  if (artistView) {
    report.inputActions.push({ ...timestamp(), kind: 'declared viewport scroll without activation', purpose })
    await rpc(selector => document.querySelector(selector)?.scrollIntoView({ block: 'center', behavior: 'instant' }), selector)
  }
  const point = await rpc(selector => { const node = document.querySelector(selector); if (!node) return null
    const rect = node.getBoundingClientRect(), style = getComputedStyle(node), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2
    const hit = document.elementFromPoint(x, y)
    return rect.width > 0 && rect.height > 0 && x > 0 && x < innerWidth && y > 0 && y < innerHeight && style.visibility !== 'hidden' && style.display !== 'none' && hit && (hit === node || node.contains(hit)) ? { x, y } : null
  }, selector)
  assert.ok(point, 'Visible control: ' + purpose); report.inputActions.push({ ...timestamp(), kind: 'trusted mouse click', purpose }); await page.mouse.click(point.x, point.y)
}
const state = () => rpc(() => {
  const dialog = document.querySelector('dialog[data-official-youtube][open]'), frame = dialog?.querySelector('iframe[data-official-video]')
  let selected = null
  try {
    const saved = JSON.parse(localStorage.getItem('pletina:web:queue:v1') ?? 'null'), item = saved?.manual ?? saved?.queue?.[saved?.order?.[saved?.pos]]
    if (item?.track) selected = { catalogId: item.track.id, title: item.track.title, titleVersion: item.track.titleVersion ?? null,
      artist: item.track.artist?.name ?? null, album: item.albumTitle ?? null, duration: item.track.duration, isrc: item.track.isrc ?? null }
  } catch { /* Missing queue is reported as null. */ }
  const slider = document.querySelector('.player input[aria-label="Posición"]')
  return { selected, mediaSession: { title: navigator.mediaSession?.metadata?.title ?? null, artist: navigator.mediaSession?.metadata?.artist ?? null,
    playbackState: navigator.mediaSession?.playbackState ?? null }, progress: slider ? { time: Number(slider.value), duration: Number(slider.max), disabled: slider.disabled } : null,
    playerTitle: document.querySelector('.player .title')?.textContent.trim() ?? null,
    playerHint: document.querySelector('.player .hint')?.textContent.trim() ?? null,
    fallback: { opened: Boolean(dialog), track: dialog?.querySelector('.track')?.textContent.trim() ?? null, videoId: frame?.dataset.videoId ?? null,
      visible: frame ? (() => { const r = frame.getBoundingClientRect(), s = getComputedStyle(frame); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' })() : false },
    frameCount: document.querySelectorAll('iframe').length,
    notices: [...document.querySelectorAll('.notice[role="status"], .error[role="alert"]')].map(element => element.textContent.trim()).slice(0, 4),
    activation: { active: navigator.userActivation.isActive, ever: navigator.userActivation.hasBeenActive } }
})
const knownYouTube = new Set(['Este vídeo no ofrece audio MP4 compatible.', 'YouTube no confirmó el vídeo solicitado o devolvió otro vídeo distinto.',
  'La dirección de audio ha caducado. Vuelve a intentarlo.', 'YouTube no permite reproducir esta fuente de audio en Pletina.', 'YouTube no permite reproducir este vídeo ahora.',
  'La dirección de audio no estuvo disponible a tiempo.', 'La dirección de audio no confirmó los metadatos esperados.', 'No se pudo comprobar la dirección de audio de YouTube.'])
try {
  let url = option('--url', 'https://diad87.github.io/pletina/')
  if (args.includes('--local')) {
    assert.ok(!args.includes('--url'), 'Use either --local or --url')
    server = createPwaServer()
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    url = `http://127.0.0.1:${server.address().port}/pletina/`
  }
  const target = new URL(url)
  assert.ok(target.protocol === 'https:' || target.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(target.hostname))
  report.originKind = server ? 'ephemeral static loopback serving unmodified dist-pwa' : target.protocol === 'https:' ? 'supplied public HTTPS' : 'supplied loopback static QA'
  browser = await puppeteer.launch({ headless: true, executablePath: option('--chrome', 'C:/Users/iunan/.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe'),
    ignoreDefaultArgs: ['--mute-audio', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], args: [] })
  assert.ok(!browser.process().spawnargs.some(value => /autoplay-policy|MediaEngagementBypassAutoplayPolicies|disable-web-security|ignore-certificate-errors|--mute-audio/.test(value)))
  report.browser = await browser.version(); context = await browser.createBrowserContext(); assert.equal((await context.cookies()).length, 0)
  page = await context.newPage(); await page.setViewport({ width: 1280, height: 1000 }); const cdp = page.mainFrame().client, cdn = new Map()
  await cdp.send('Network.enable')
  if (diagnostic) {
    await cdp.send('Debugger.enable')
    cdp.on('Debugger.scriptParsed', event => { let asset = 'anonymous-or-opaque-script'; try { const name = new URL(event.url).pathname.split('/').at(-1); if (/^[A-Za-z0-9_.-]{1,150}$/.test(name)) asset = name } catch { /* No source URL is saved. */ }; scriptAssets.set(event.scriptId, asset) })
    cdp.on('Debugger.paused', event => {
      const resume = cdp.send('Debugger.resume').catch(() => {}); pending.add(resume); void resume.finally(() => pending.delete(resume))
      const first = typeof event.data?.description === 'string' ? event.data.description.split('\n')[0] : '', match = /^(P1EngineError|P1ProbeError|YouTubeError): (.+)$/.exec(first)
      if (!match) return
      const [, category, value] = match
      if (!(category === 'P1EngineError' && /^[A-Za-z0-9 .-]{1,160}$/.test(value) || knownYouTube.has(value))) return
      report.exceptions.push({ ...timestamp(), category, message: value, functions: event.callFrames.slice(0, 6).map(frame => ({
        name: /^[A-Za-z0-9_$ .<>-]{0,100}$/.test(frame.functionName) ? frame.functionName || '(anonymous)' : '(omitted)',
        asset: scriptAssets.get(frame.location.scriptId) ?? 'anonymous-or-opaque-script', line: frame.location.lineNumber + 1, column: frame.location.columnNumber + 1 })) })
    })
  }
  page.on('request', request => {
    try {
      const endpoint = new URL(request.url())
      if (request.resourceType() === 'media' && request.frame() === page.mainFrame() && endpoint.protocol === 'https:' && endpoint.hostname.endsWith('.googlevideo.com')) selectedMediaUrl = request.url()
    } catch { /* Detached probe frames cannot identify the selected main Audio. */ }
  })
  cdp.on('Network.requestWillBeSent', event => { let endpoint; try { endpoint = new URL(event.request.url) } catch { return }; if (endpoint.hostname.endsWith('.googlevideo.com')) cdn.set(event.requestId, { ...timestamp(), urlSha256: sha(event.request.url), itag: endpoint.searchParams.get('itag'), resourceType: event.type ?? null }) })
  cdp.on('Network.responseReceivedExtraInfo', event => {
    const request = cdn.get(event.requestId)
    if (!request) return
    const header = key => Object.entries(event.headers ?? {}).find(([name]) => name.toLowerCase() === key)?.[1]
    const origin = header('access-control-allow-origin')
    report.cdnHttp.push({ ...timestamp(), request, httpStatus: event.statusCode,
      corsAllowOrigin: typeof origin !== 'string' ? null : /^(?:\*|null|https:\/\/[A-Za-z0-9.-]+(?::\d+)?)$/.test(origin) ? origin : '[unexpected-value]',
      corsAllowCredentials: header('access-control-allow-credentials') === 'true',
      contentType: typeof header('content-type') === 'string' ? header('content-type').split(';')[0].trim().slice(0, 60) : null,
      contentLength: /^\d+$/.test(String(header('content-length') ?? '')) ? Number(header('content-length')) : null })
  })
  cdp.on('Network.loadingFailed', event => { const request = cdn.get(event.requestId); if (request) report.networkFailures.push({ ...timestamp(), request, error: scrub(event.errorText), blockedReason: event.blockedReason ?? null,
    corsError: typeof event.corsErrorStatus?.corsError === 'string' && /^[A-Za-z]{1,100}$/.test(event.corsErrorStatus.corsError) ? event.corsErrorStatus.corsError : null }) })
  page.on('response', response => {
    const operation = (async () => {
      const endpoint = new URL(response.url()); if (!['www.youtube.com', 'music.youtube.com'].includes(endpoint.hostname) || endpoint.pathname !== '/youtubei/v1/player') return
      let request, body; try { request = JSON.parse(response.request().postData() ?? '{}'); body = await response.json() } catch { return }
      const formats = Array.isArray(body?.streamingData?.adaptiveFormats) ? body.streamingData.adaptiveFormats : []
      report.providerResponses.push({ ...timestamp(), client: ['VISIONOS', 'WEB_EMBEDDED_PLAYER', 'WEB'].includes(request.context?.client?.clientName) ? request.context.client.clientName : 'other',
        requestedVideoId: /^[\w-]{11}$/.test(request.videoId ?? '') ? request.videoId : null, httpStatus: response.status(),
        status: typeof body?.playabilityStatus?.status === 'string' ? body.playabilityStatus.status : null, exactResponseId: body?.videoDetails?.videoId === request.videoId,
        playableInEmbed: typeof body?.playabilityStatus?.playableInEmbed === 'boolean' ? body.playabilityStatus.playableInEmbed : null,
        audioFormatCount: formats.filter(value => typeof value?.mimeType === 'string' && value.mimeType.startsWith('audio/')).length,
        aac: formats.filter(value => typeof value?.mimeType === 'string' && value.mimeType.startsWith('audio/mp4')).slice(0, 8).map(value => {
          const cipher = typeof value.signatureCipher === 'string' ? value.signatureCipher : typeof value.cipher === 'string' ? value.cipher : null
          const fields = cipher === null ? null : new URLSearchParams(cipher), signature = fields?.get('s')
          return { itag: Number.isSafeInteger(value.itag) ? value.itag : null, mimeType: value.mimeType.slice(0, 100),
            contentLength: /^\d{1,12}$/.test(String(value.contentLength ?? '')) ? Number(value.contentLength) : null,
            cipherPresent: cipher !== null, cipherLength: cipher?.length ?? null, signatureInputLength: signature?.length ?? null,
            signatureInputHasAsciiControl: typeof signature === 'string' ? /[\u0000-\u001f\u007f]/.test(signature) : null,
            directUrlPresent: typeof value.url === 'string', drc: value.isDrc === true,
            drmPresent: Object.hasOwn(value, 'licenseInfos') || Object.hasOwn(value, 'drmTrackType') || Object.hasOwn(value, 'keySystems') ||
              Object.hasOwn(value, 'drmFamilies') && (!Array.isArray(value.drmFamilies) || value.drmFamilies.length > 0),
            hasOriginalityMetadata: ['audioTrack', 'xtags', 'language', 'languageCode'].some(key => value[key] != null) }
        }) })
    })().catch(() => { report.errors.push({ kind: 'observer', message: 'PROVIDER_METADATA_OBSERVATION_FAILED' }) })
    pending.add(operation); void operation.finally(() => pending.delete(operation))
  })
  await page.goto(url, { waitUntil: 'load', timeout: 30000 })
  report.build = await poll('Landing build', () => rpc(() => document.querySelector('#version')?.textContent.trim() ?? null)); assert.equal(report.build, expectedBuild)
  report.initialActivation = await rpc(() => navigator.userActivation.hasBeenActive); assert.equal(report.initialActivation, false)
  await click('#open-player', 'open compiled Pletina')
  await poll('Search input', () => rpc(() => Boolean(document.querySelector('input[aria-label="Buscar música"]'))), 45000)
  await click('input[aria-label="Buscar música"]', 'focus normal search')
  report.inputActions.push({ ...timestamp(), kind: 'trusted keyboard typing', characters: query.length }); await page.keyboard.type(query)
  const readRows = () => rpc(() => [...document.querySelectorAll('.tracks li[data-reorder-index]')].slice(0, 30).map(element => ({
    index: element.dataset.reorderIndex, title: element.querySelector('.name')?.textContent.trim() ?? '', artist: element.querySelector('.by')?.textContent.trim() ?? '', album: element.querySelector('.album')?.textContent.trim() ?? '' })))
  let rows = await poll('Canonical track search result', async () => {
    const rows = await rpc(() => [...document.querySelectorAll('.tracks li[data-reorder-index]')].slice(0, 30).map(element => ({
      index: element.dataset.reorderIndex, title: element.querySelector('.name')?.textContent.trim() ?? '', artist: element.querySelector('.by')?.textContent.trim() ?? '', album: element.querySelector('.album')?.textContent.trim() ?? '' })))
    return rows.some(row => normalize(row.title) === normalize(title) && artist.split(/\s+/).every(word => normalize(row.artist).includes(normalize(word)))) ? rows : null
  }, 45000)
  report.searchResults = rows
  let selected = rows.find(row => normalize(row.title) === normalize(title) && artist.split(/\s+/).every(word => normalize(row.artist).includes(normalize(word))))
  if (artistView) {
    await click(`.tracks li[data-reorder-index="${selected.index}"] .by button.link`, 'open artist from canonical search result')
    report.artistHeading = await poll('Canonical artist page', () => rpc(() => document.querySelector('.banner h1')?.textContent.trim() ?? null))
    assert.ok(artist.split(/\s+/).every(word => normalize(report.artistHeading).includes(normalize(word))))
    await poll('Artist popular songs', async () => (await readRows()).length > 0)
    if (await rpc(() => document.querySelector('.page > button.more')?.textContent.trim() === 'Mostrar más')) await click('.page > button.more', 'expand artist popular songs')
    rows = await readRows()
    selected = rows.find(row => normalize(row.title) === normalize(title))
    assert.ok(selected?.title, 'The exact preferred song must exist in artist popular songs')
    report.artistPopularSelection = { preferredTitle: title, preferredTitleFound: normalize(selected.title) === normalize(title), rows, selected }
  }
  report.clickedRow = selected
  if (diagnostic) await cdp.send('Debugger.setPauseOnExceptions', { state: 'all' })
  report.songControl = artistView ? songControl : 'number'
  report.started = timestamp(); await click(`.tracks li[data-reorder-index="${selected.index}"] ${artistView ? songControl === 'cover' ? '.thumb' : '.name' : '.num'}`, artistView ? `single artist popular ${songControl} click` : 'single normal song play click')
  const outcome = await poll('Native audio or official fallback', async () => {
    const value = await state()
    return value.fallback.opened || value.mediaSession.playbackState === 'playing' && value.progress?.time > 2 ? value : null
  }, 120000)
  report.finalState = outcome; report.outcome = outcome.fallback.opened ? 'official-video-fallback' : 'native-audio'
  if (artistView) {
    assert.equal(outcome.selected?.title, selected.title, 'The played catalog entry must be the chosen popular row')
    assert.equal(outcome.mediaSession.title, selected.title, 'Media metadata must name the chosen popular song')
    report.covers = await rpc(async selector => {
      const describe = async image => {
        if (!image) return null
        const address = image.currentSrc || image.src
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(address))
        return { addressSha256: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join(''),
          loaded: image.complete && image.naturalWidth > 0, width: image.naturalWidth, height: image.naturalHeight }
      }
      return { row: await describe(document.querySelector(selector + ' .thumb img')), player: await describe(document.querySelector('.mini .thumb img,.player .thumb img')) }
    }, `.tracks li[data-reorder-index="${selected.index}"]`)
    assert.ok(report.covers.row?.loaded && report.covers.player?.loaded, 'Both selected and player artwork must load')
    assert.equal(report.covers.row.addressSha256, report.covers.player.addressSha256, 'Player artwork must belong to the selected row')
  }
  if (diagnostic) await cdp.send('Debugger.setPauseOnExceptions', { state: 'none' })
  report.checks.push({ name: 'normal song click plays native audio without a video modal', pass: report.outcome === 'native-audio', outcome: report.outcome })
  if (report.outcome === 'native-audio' && selectedMediaUrl) {
    const selectedUrl = selectedMediaUrl
    report.downloadLocator = { urlSha256: sha(selectedUrl), itag: new URL(selectedUrl).searchParams.get('itag'),
      expectedBytes: Number(new URL(selectedUrl).searchParams.get('clen')), rawUrlSaved: false }
    const declaredDuration = Number(new URL(selectedUrl).searchParams.get('dur'))
    const expectedDuration = Number.isFinite(declaredDuration) && declaredDuration > 0 ? declaredDuration : outcome.progress.duration || outcome.selected.duration
    assert.ok(Number.isFinite(expectedDuration) && expectedDuration > 0)
    await click('.player .play', 'pause the real app before the separate QA prototype')
    report.prototype = { expectedDuration, actualBodyBytes: null, sha256: null, productDownloadVerified: false }
    report.prototype.onlineNetworkControl = await uncachedNetworkProbe(); assert.equal(report.prototype.onlineNetworkControl.blocked, false)
    const stage = await rpc(stageOpaquePrototype, { url: selectedUrl })
    prototypeKey = stage.key
    const { key: _key, ...safeStage } = stage
    report.prototype.stage = safeStage
    const offline = { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }
    await cdp.send('Network.overrideNetworkState', offline); await cdp.send('Network.emulateNetworkConditions', offline)
    report.prototype.beforeReloadNetworkControl = await uncachedNetworkProbe(); assert.equal(report.prototype.beforeReloadNetworkControl.blocked, true)
    assert.equal(await rpc(() => navigator.onLine), false)
    report.prototype.initialDom = await rpc(installPrototypeAudio, { key: prototypeKey, expectedDuration })
    await poll('Prototype cached metadata without network', async () => { const value = await prototypeAudioState(); return value?.duration > 0 ? value : null })
    report.prototype.beforeOfflineReload = await rpc(validatePrototypeTail, { expectedDuration })
    assert.equal(report.prototype.beforeOfflineReload.online, false)
    report.checks.push({ name: 'QA prototype opaque stage decodes metadata and its tail with actual traffic offline', pass: true })

    await page.reload({ waitUntil: 'load', timeout: 30000 })
    await poll('Service worker still controls the cached app after offline reload', () => rpc(() => Boolean(navigator.serviceWorker.controller)))
    report.prototype.afterReloadNetworkControl = await uncachedNetworkProbe(); assert.equal(report.prototype.afterReloadNetworkControl.blocked, true)
    await page.mainFrame().client.send('Network.overrideNetworkState', offline)
    assert.equal(await rpc(() => navigator.onLine), false)
    report.prototype.retainedCache = await rpc(async key => {
      const response = await (await caches.open('pletina-audio-downloads:v1')).match(key)
      return { present: Boolean(response), type: response?.type ?? null, status: response?.status ?? null }
    }, prototypeKey)
    assert.deepEqual(report.prototype.retainedCache, { present: true, type: 'opaque', status: 0 })
    report.prototype.reloadedDom = await rpc(installPrototypeAudio, { key: prototypeKey, expectedDuration })
    await poll('Prototype cached metadata after offline reload', async () => { const value = await prototypeAudioState(); return value?.duration > 0 ? value : null })
    report.prototype.afterOfflineReload = await rpc(validatePrototypeTail, { expectedDuration })
    await click('#qa-opaque-play', 'trusted click on the explicit QA prototype playback button')
    const started = await poll('Prototype native playback advances offline', async () => { const value = await prototypeAudioState(); return value && !value.paused && value.time > 1 && !value.error ? value : null })
    await delay(800)
    report.prototype.playback = await prototypeAudioState()
    assert.ok(!report.prototype.playback.paused && !report.prototype.playback.muted && report.prototype.playback.volume > 0 && report.prototype.playback.time > started.time + .4)
    assert.deepEqual(report.prototype.playback.trustedPlayClicks, [true]); assert.deepEqual(report.prototype.playback.playFailures, [])
    report.prototype.idbDownloadRow = await rpc(async () => {
      if (!(await indexedDB.databases()).some(db => db.name === 'pletina-web-downloads')) return false
      const db = await new Promise((resolve, reject) => { const request = indexedDB.open('pletina-web-downloads'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(Error('QA database inspection failed')) })
      try {
        if (!db.objectStoreNames.contains('files')) return false
        return await new Promise((resolve, reject) => { const request = db.transaction('files').objectStore('files').get(999900001); request.onsuccess = () => resolve(Boolean(request.result)); request.onerror = () => reject(Error('QA row inspection failed')) })
      } finally { db.close() }
    })
    assert.equal(report.prototype.idbDownloadRow, false)
    report.checks.push({ name: 'QA prototype opaque cache survives offline reload and native playback advances after one trusted QA-button click', pass: true })
  } else throw Error('The prototype requires the exact selected song to play natively first')
  report.screenshot = reportName.replace(/\.json$/, '.png'); await page.screenshot({ path: new URL(report.screenshot, directory).pathname.replace(/^\/C:/, 'C:'), fullPage: true })
  if (outcome.fallback.opened) await click('#official-youtube-close', 'close observed video fallback after evidence')
  // The application was paused before testing the separate QA Audio. Do not
  // toggle its restored paused state into an unrelated offline playback attempt.
} catch (error) { report.errors.push({ kind: 'runner', message: scrub(error.message) }); if (page) try { report.lastState = await state() } catch { /* Navigation may have failed. */ } }
finally {
  if (page && !page.isClosed()) try {
    report.prototypeCleanup = await rpc(async key => {
      const value = window.__qaOpaqueAudio
      if (value?.audio) { value.audio.pause(); value.audio.removeAttribute('src'); value.audio.load() }
      document.querySelector('#qa-opaque-prototype')?.remove()
      const target = key || window.__qaOpaqueKey
      if (!target) return { stageKeyKnown: false, removed: false, retained: false }
      const cache = await caches.open('pletina-audio-downloads:v1'), removed = await cache.delete(target), retained = Boolean(await cache.match(target))
      return { stageKeyKnown: true, removed, retained }
    }, prototypeKey)
  } catch { report.errors.push({ kind: 'prototype-cleanup', message: 'QA_OPAQUE_KEY_CLEANUP_FAILED' }) }
  await Promise.allSettled([...pending]); await context?.close(); await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); report.resourcesClosed = true
}
await mkdir(directory, { recursive: true }); await writeFile(new URL(report.sourceSnapshot.replace('artifacts/pwa-port/', ''), directory), source)
await writeFile(new URL(reportName, directory), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ report: reportName, build: report.build, outcome: report.outcome, selected: report.finalState?.selected, downloadLocator: report.downloadLocator, prototype: report.prototype, prototypeCleanup: report.prototypeCleanup,
  fallback: report.finalState?.fallback, exceptions: report.exceptions, providerResponses: report.providerResponses, cdnHttp: report.cdnHttp, checks: report.checks, errors: report.errors }))
if (report.errors.length || report.checks.some(value => !value.pass)) process.exitCode = 1
