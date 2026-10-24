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
const diagnostic = args.includes('--exceptions'), reportName = option('--report', 'p1-song-ui-diagnostic.json')
const artistView = args.includes('--artist-view')
const mobile = args.includes('--mobile')
const songControl = option('--song-control', 'title')
assert.ok(['title', 'cover', 'artist', 'album', 'row'].includes(songControl))
assert.ok(!mobile || songControl !== 'album', 'The album column is hidden on mobile')
assert.match(reportName, /^p1-song-[a-z0-9.-]+\.json$/)
const source = await readFile(new URL(import.meta.url)), sha = value => crypto.createHash('sha256').update(value).digest('hex')
const directory = new URL('../../artifacts/pwa-port/', import.meta.url), began = Date.now(), timestamp = () => ({ at: new Date().toISOString(), elapsedMs: Date.now() - began })
const report = { schemaVersion: 1, testedAt: new Date().toISOString(), expectedBuild, build: null, query, expectedTitle: title, expectedArtist: artist,
  runnerSha256: sha(source), sourceSnapshot: `artifacts/pwa-port/p1-song-ui-diagnostic-source-${sha(source).slice(0, 16)}.mjs`,
  scope: 'Public compiled PWA, real catalog search and trusted play click. Desktop foreground only. Optional debugger timing is not comparable to ordinary runs.',
  inputMode: mobile ? 'Trusted touchscreen taps, Android layout emulation; not a physical phone or OS keyboard.' : 'Trusted mouse clicks in desktop layout',
  policy: { providerMocks: false, nodeBootstrap: false, productMethodsReplaced: false, audioConstructorReplaced: false, sdkInjected: false,
    securityOverrides: false, autoplayOverrides: false, rawRecipeSaved: false, rawMediaUrlsSaved: false, mediaBytesSaved: false,
    exceptionLocalsRead: false, exceptionPropertiesRead: false, debuggerPauses: diagnostic, instrumentedTimings: diagnostic, physicalPhone: false, backgroundVerified: false },
  observationRpcCalls: 0, observationRpcWithGesture: 0, inputActions: [], checks: [], errors: [], exceptions: [], providerResponses: [], cdnHttp: [], networkFailures: [] }
const scrub = value => String(value ?? '').replace(/https?:\/\/[^\s"'<>]+/g, '[URL]').replace(/blob:[^\s"'<>]+/g, '[BLOB]').slice(0, 300)
const normalize = value => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms)), pending = new Set(), scriptAssets = new Map()
let browser, context, page, server
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
    await rpc(selector => (selector.startsWith('menu:') ? [...document.querySelectorAll('[role="menuitem"]')].find(node => node.textContent.trim() === selector.slice(5)) : document.querySelector(selector))?.scrollIntoView({ block: 'center', behavior: 'instant' }), selector)
  }
  const point = await rpc(selector => { const node = selector.startsWith('menu:') ? [...document.querySelectorAll('[role="menuitem"]')].find(node => node.textContent.trim() === selector.slice(5)) : document.querySelector(selector); if (!node) return null
    const rect = node.getBoundingClientRect(), style = getComputedStyle(node), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2
    const hit = document.elementFromPoint(x, y)
    return rect.width > 0 && rect.height > 0 && x > 0 && x < innerWidth && y > 0 && y < innerHeight && style.visibility !== 'hidden' && style.display !== 'none' && hit && (hit === node || node.contains(hit)) ? { x, y } : null
  }, selector)
  assert.ok(point, 'Visible control: ' + purpose); report.inputActions.push({ ...timestamp(), kind: mobile ? 'trusted touchscreen tap' : 'trusted mouse click', purpose })
  if (mobile) await page.touchscreen.tap(point.x, point.y)
  else await page.mouse.click(point.x, point.y)
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
  const bar = document.querySelector('.mini .bar')
  const route = history.state?.snapshot?.stack[history.state?.index]
  return { selected, route: route && { name: route.name, id: route.id }, albumHeading: document.querySelector('.hero h1')?.textContent.trim() ?? null,
    searchQuery: document.querySelector('input[aria-label="Buscar música"]')?.value ?? null, mediaSession: { title: navigator.mediaSession?.metadata?.title ?? null, artist: navigator.mediaSession?.metadata?.artist ?? null,
    playbackState: navigator.mediaSession?.playbackState ?? null }, progress: slider ? { time: Number(slider.value), duration: Number(slider.max), disabled: slider.disabled } : bar && selected ? { time: Number(bar.style.getPropertyValue('--progress')) * selected.duration, duration: selected.duration, source: 'Rendered mini progress fraction times catalog duration' } : null,
    playerTitle: document.querySelector('.mini .title,.player .title')?.textContent.trim() ?? null,
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
  page = await context.newPage(); await page.setViewport(mobile ? { width: 393, height: 852, isMobile: true, hasTouch: true, deviceScaleFactor: 1 } : { width: 1280, height: 1000 })
  if (mobile) await page.setUserAgent('Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36')
  const cdp = page.mainFrame().client, cdn = new Map()
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
  cdp.on('Network.requestWillBeSent', event => { let endpoint; try { endpoint = new URL(event.request.url) } catch { return }; if (endpoint.hostname.endsWith('.googlevideo.com')) cdn.set(event.requestId, { ...timestamp(), urlSha256: sha(event.request.url), itag: endpoint.searchParams.get('itag') }) })
  cdp.on('Network.responseReceivedExtraInfo', event => { const request = cdn.get(event.requestId); if (request) report.cdnHttp.push({ ...timestamp(), request, httpStatus: event.statusCode }) })
  cdp.on('Network.loadingFailed', event => { const request = cdn.get(event.requestId); if (request) report.networkFailures.push({ ...timestamp(), request, error: scrub(event.errorText), blockedReason: event.blockedReason ?? null }) })
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
  if (mobile) {
    await poll('Mobile navigation', () => rpc(() => Boolean(document.querySelector('.bottom-nav'))))
    await click('.bottom-nav button:nth-child(2)', 'open Buscar from mobile navigation')
  }
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
    await click(`.tracks li[data-reorder-index="${selected.index}"] .more-cell button`, 'open selected song options')
    await click('menu:Ir al artista', 'open artist explicitly from selected song menu')
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
  report.songControl = songControl
  const songTarget = { title: '.name', cover: '.thumb', artist: '.artist-name', album: '.album-name', row: '.row' }[songControl]
  report.started = timestamp(); await click(`.tracks li[data-reorder-index="${selected.index}"] ${songTarget}`, artistView ? `single artist popular ${songControl} click` : `single search song ${songControl} click`)
  const outcome = await poll('Native audio or official fallback', async () => {
    const value = await state()
    return value.fallback.opened || value.mediaSession.playbackState === 'playing' && value.progress?.time > 2 ? value : null
  }, 120000)
  report.finalState = outcome; report.outcome = outcome.fallback.opened ? 'official-video-fallback' : 'native-audio'
  if (!artistView) {
    assert.equal(outcome.route?.name, 'album', 'Selecting a search song opens its album')
    assert.equal(outcome.selected?.title, selected.title, 'The selected song must already play without a second album-row tap')
    report.openedAlbum = await poll('Selected album is visible', async () => { const value = await state(); return value.route?.name === 'album' && value.albumHeading ? value : null })
    assert.equal(normalize(report.openedAlbum.albumHeading), normalize(selected.album))
    assert.notEqual(report.openedAlbum.searchQuery, query, 'The search screen must be closed')
  }
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
  report.screenshot = reportName.replace(/\.json$/, '.png'); await page.screenshot({ path: new URL(report.screenshot, directory).pathname.replace(/^\/C:/, 'C:'), fullPage: true })
  if (outcome.fallback.opened) await click('#official-youtube-close', 'close observed video fallback after evidence')
  else if (outcome.mediaSession.playbackState === 'playing') await click(mobile ? '.mini button[aria-label="Pausa"]' : '.player .play', 'pause after native audio observation')
} catch (error) { report.errors.push({ kind: 'runner', message: scrub(error.message) }); if (page) try { report.lastState = await state() } catch { /* Navigation may have failed. */ } }
finally { await Promise.allSettled([...pending]); await context?.close(); await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); report.resourcesClosed = true }
await mkdir(directory, { recursive: true }); await writeFile(new URL(report.sourceSnapshot.replace('artifacts/pwa-port/', ''), directory), source)
await writeFile(new URL(reportName, directory), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ report: reportName, build: report.build, outcome: report.outcome, selected: report.finalState?.selected,
  fallback: report.finalState?.fallback, exceptions: report.exceptions, providerResponses: report.providerResponses, cdnHttp: report.cdnHttp, checks: report.checks, errors: report.errors }))
if (report.errors.length || report.checks.some(value => !value.pass)) process.exitCode = 1
