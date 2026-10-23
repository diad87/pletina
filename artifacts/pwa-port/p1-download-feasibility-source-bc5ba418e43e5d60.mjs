// Bounded P1 full-file CORS feasibility probe, based on the frozen real UI runner.
// Media bytes and signed URLs remain in RAM, never in artifacts or CacheStorage.
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
const diagnostic = args.includes('--exceptions'), reportName = option('--report', 'p1-song-download-feasibility.json')
const artistView = args.includes('--artist-view')
const songControl = option('--song-control', 'title')
assert.ok(['title', 'cover'].includes(songControl))
assert.match(reportName, /^p1-song-[a-z0-9.-]+\.json$/)
const source = await readFile(new URL(import.meta.url)), sha = value => crypto.createHash('sha256').update(value).digest('hex')
const directory = new URL('../../artifacts/pwa-port/', import.meta.url), began = Date.now(), timestamp = () => ({ at: new Date().toISOString(), elapsedMs: Date.now() - began })
const report = { schemaVersion: 1, testedAt: new Date().toISOString(), expectedBuild, build: null, query, expectedTitle: title, expectedArtist: artist,
  runnerSha256: sha(source), sourceSnapshot: `artifacts/pwa-port/p1-download-feasibility-source-${sha(source).slice(0, 16)}.mjs`,
  scope: 'Public compiled PWA, real catalog search and trusted play click. Desktop foreground only. Optional debugger timing is not comparable to ordinary runs.',
  policy: { providerMocks: false, nodeBootstrap: false, productMethodsReplaced: false, audioConstructorReplaced: false, sdkInjected: false,
    securityOverrides: false, autoplayOverrides: false, rawRecipeSaved: false, rawMediaUrlsSaved: false, mediaBytesSaved: false,
    exceptionLocalsRead: false, exceptionPropertiesRead: false, debuggerPauses: diagnostic, instrumentedTimings: diagnostic, physicalPhone: false, backgroundVerified: false },
  observationRpcCalls: 0, observationRpcWithGesture: 0, inputActions: [], checks: [], errors: [], exceptions: [], providerResponses: [], cdnHttp: [], networkFailures: [] }
const scrub = value => String(value ?? '').replace(/https?:\/\/[^\s"'<>]+/g, '[URL]').replace(/blob:[^\s"'<>]+/g, '[BLOB]').slice(0, 300)
const normalize = value => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms)), pending = new Set(), scriptAssets = new Map()
let browser, context, page, server, selectedMediaUrl = null

// This entire function executes in the browser. The optional opaque srcdoc is
// application-owned diagnostic code, subject to normal CORS and no cookies.
async function fullFileFeasibility(config) {
  async function readFull({ url, expectedBytes, maximumBytes, timeoutMs }) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs)
    let response, reader
    const result = { readable: false, status: null, responseType: null, mime: null, declaredBytes: null, contentRange: null,
      expectedBytes, actualBytes: 0, complete: false, error: null }
    try {
      response = await fetch(url, { mode: 'cors', credentials: 'omit', redirect: 'follow', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal })
      Object.assign(result, { status: response.status, responseType: response.type, mime: response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? null,
        declaredBytes: response.headers.get('content-length'), contentRange: response.headers.get('content-range') })
      if (response.type === 'opaque' || response.status !== 200 || result.contentRange || !['audio/mp4', 'audio/webm'].includes(result.mime) || !response.body) {
        await response.body?.cancel().catch(() => {}); result.error = 'not-readable-complete-audio-response'; return { result }
      }
      if (result.declaredBytes !== null && (!/^\d+$/.test(result.declaredBytes) || Number(result.declaredBytes) !== expectedBytes)) {
        await response.body.cancel().catch(() => {}); result.error = 'declared-size-mismatch'; return { result }
      }
      reader = response.body.getReader()
      const chunks = []
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        result.actualBytes += value.byteLength
        if (result.actualBytes > expectedBytes || result.actualBytes > maximumBytes) { await reader.cancel().catch(() => {}); result.error = 'byte-budget-exceeded'; return { result } }
        chunks.push(value)
      }
      result.complete = result.actualBytes === expectedBytes && result.actualBytes > 0
      result.readable = true
      if (!result.complete) { result.error = 'truncated-file'; return { result } }
      const bytes = new Uint8Array(result.actualBytes)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      return { result, bytes: bytes.buffer }
    } catch (error) {
      result.error = error?.name === 'AbortError' ? 'deadline-abort' : error?.name === 'TypeError' ? 'fetch-typeerror-cors-or-network' : 'fetch-failed'
      return { result }
    } finally { clearTimeout(timer); try { reader?.releaseLock() } catch { /* Detached/cancelled reader. */ } }
  }
  const maximumBytes = 8 * 1024 * 1024, parsed = new URL(config.url), expectedBytes = Number(parsed.searchParams.get('clen'))
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > maximumBytes) return { error: 'missing-or-oversized-declared-file', maximumBytes }
  const parameters = { url: config.url, expectedBytes, maximumBytes, timeoutMs: 10000 }
  let value
  if (config.origin === 'pages') value = await readFull(parameters)
  else value = await new Promise(resolve => {
    const frame = document.createElement('iframe'), nonce = crypto.randomUUID()
    frame.hidden = true; frame.sandbox = 'allow-scripts'; frame.referrerPolicy = 'no-referrer'
    const finish = value => { clearTimeout(timer); window.removeEventListener('message', receive); frame.remove(); resolve(value) }
    const receive = event => {
      if (event.source === frame.contentWindow && event.data?.kind === 'p1-download-feasibility' && event.data?.nonce === nonce) finish(event.data.value)
    }
    const timer = setTimeout(() => finish({ result: { error: 'opaque-frame-deadline', complete: false } }), 12000)
    window.addEventListener('message', receive)
    frame.srcdoc = '<!doctype html><script>(' + (async function (read, config, nonce) {
      const value = await read(config)
      parent.postMessage({ kind: 'p1-download-feasibility', nonce, value }, '*', value.bytes ? [value.bytes] : [])
    }).toString() + ')(' + readFull.toString() + ',' + JSON.stringify(parameters) + ',' + JSON.stringify(nonce) + ')</script>'
    document.body.append(frame)
  })
  const result = { origin: config.origin, maximumBytes, ...value.result, sha256: null, nativeValidation: null, bytesPersisted: false }
  if (value.bytes instanceof ArrayBuffer && value.bytes.byteLength === expectedBytes && value.result.complete) {
    result.sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', value.bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('')
    const objectUrl = URL.createObjectURL(new Blob([value.bytes], { type: value.result.mime })), audio = document.createElement('audio')
    try {
      result.nativeValidation = await new Promise(resolve => {
        let settled = false, tail = -1
        const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value) }
        const timer = setTimeout(() => finish({ valid: false, error: 'native-validation-deadline' }), 6000)
        const ready = () => { if (tail >= 0 && !audio.seeking && audio.readyState >= 2 && audio.currentTime >= tail - .1) finish({ valid: true, duration: audio.duration, tail: audio.currentTime, playCalled: false }) }
        audio.onerror = () => finish({ valid: false, error: 'native-decode-error', code: audio.error?.code ?? null })
        audio.onloadedmetadata = () => {
          if (!Number.isFinite(audio.duration) || Math.abs(audio.duration - config.expectedDuration) > 3) { finish({ valid: false, error: 'duration-mismatch', duration: Number.isFinite(audio.duration) ? audio.duration : null }); return }
          tail = Math.max(0, audio.duration - .25); audio.currentTime = tail; ready()
        }
        audio.onseeked = ready; audio.onloadeddata = ready; audio.oncanplay = ready
        audio.preload = 'auto'; audio.muted = true; audio.src = objectUrl; audio.load()
      })
    } finally { audio.pause(); audio.removeAttribute('src'); audio.load(); URL.revokeObjectURL(objectUrl) }
  }
  return result
}
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
    report.downloadFeasibility = []
    for (const origin of ['pages', 'opaque']) report.downloadFeasibility.push(await rpc(fullFileFeasibility, { origin, url: selectedUrl, expectedDuration: outcome.selected.duration }))
    report.fullFileReadable = report.downloadFeasibility.some(value => value.complete && value.nativeValidation?.valid === true)
  } else report.downloadFeasibility = [{ error: 'no-selected-native-media-locator', fullFileReadable: false }]
  report.screenshot = reportName.replace(/\.json$/, '.png'); await page.screenshot({ path: new URL(report.screenshot, directory).pathname.replace(/^\/C:/, 'C:'), fullPage: true })
  if (outcome.fallback.opened) await click('#official-youtube-close', 'close observed video fallback after evidence')
  else if (outcome.mediaSession.playbackState === 'playing') await click('.player .play', 'pause after native audio observation')
} catch (error) { report.errors.push({ kind: 'runner', message: scrub(error.message) }); if (page) try { report.lastState = await state() } catch { /* Navigation may have failed. */ } }
finally { await Promise.allSettled([...pending]); await context?.close(); await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); report.resourcesClosed = true }
await mkdir(directory, { recursive: true }); await writeFile(new URL(report.sourceSnapshot.replace('artifacts/pwa-port/', ''), directory), source)
await writeFile(new URL(reportName, directory), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ report: reportName, build: report.build, outcome: report.outcome, selected: report.finalState?.selected, fullFileReadable: report.fullFileReadable, downloadLocator: report.downloadLocator, downloadFeasibility: report.downloadFeasibility,
  fallback: report.finalState?.fallback, exceptions: report.exceptions, providerResponses: report.providerResponses, cdnHttp: report.cdnHttp, checks: report.checks, errors: report.errors }))
if (report.errors.length || report.checks.some(value => !value.pass)) process.exitCode = 1
