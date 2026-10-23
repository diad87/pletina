// Separate diagnostic: caught-exception pauses alter timing and are not a
// performance/playback benchmark. No locals, payloads, URLs or recipe are read.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'
import { createPwaServer } from '../preview-pwa.mjs'

const args = process.argv.slice(2), option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const build = option('--expected-build', ''); assert.match(build, /^[a-f0-9]{16}$/)
const reportName = option('--report', `p1-iritsi-diagnostic-${build}-local.json`); assert.match(reportName, /^p1-iritsi-diagnostic-[a-z0-9.-]+\.json$/)
const source = await readFile(new URL(import.meta.url)), sha256 = value => crypto.createHash('sha256').update(value).digest('hex')
const directory = new URL('../../artifacts/pwa-port/', import.meta.url), began = Date.now()
const at = () => ({ at: new Date().toISOString(), instrumentedElapsedMs: Date.now() - began })
const report = { schemaVersion: 1, testedAt: new Date().toISOString(), expectedBuild: build, build: null,
  runnerSha256: sha256(source), sourceSnapshot: `artifacts/pwa-port/p1-iritsi-diagnostic-source-${sha256(source).slice(0, 16)}.mjs`,
  scope: 'Compiled anonymous browser Iritsi case, with caught-exception debugger pauses followed by immediate resume. Timings are instrumented and not comparable to uninstrumented runs.',
  policy: { providerMocks: false, productMethodsReplaced: false, nodeBootstrap: false, sdkInjected: false, runtimeBackend: false,
    browserSecurityOverrides: false, autoplayOverrides: false, rawRecipeSaved: false, signedUrlsSaved: false,
    mediaSaved: false, localsRead: false, exceptionPropertiesRead: false, physicalPhone: false, backgroundVerified: false },
  observationRpcCalls: 0, observationRpcWithGesture: 0, pauses: 0, ignoredExceptionValues: 0, exceptions: [], providerResponses: [], cdnHttp: [], errors: [] }
const known = new Map([
  ['Este vídeo no ofrece audio MP4 compatible.', 'format'],
  ['YouTube no confirmó el vídeo solicitado o devolvió otro vídeo distinto.', 'response'],
  ['La dirección de audio ha caducado. Vuelve a intentarlo.', 'response'],
  ['YouTube no permite reproducir esta fuente de audio en Pletina.', 'unavailable'],
  ['YouTube no permite reproducir este vídeo ahora.', 'restricted'],
  ['La dirección de audio no estuvo disponible a tiempo.', 'timeout'],
  ['La dirección de audio no confirmó los metadatos esperados.', 'response'],
  ['No se pudo comprobar la dirección de audio de YouTube.', 'network'],
])
const safeError = error => /^[A-Za-z0-9 .:-]{1,180}$/.test(String(error?.message)) ? String(error.message) : 'DIAGNOSTIC_STEP_FAILED'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let server, browser, context, page
const pending = new Set()
async function rpc(fn) {
  report.observationRpcCalls++
  const executionContext = page.mainFrame().mainRealm().context
  const result = await page.mainFrame().client.send('Runtime.callFunctionOn', { executionContextId: executionContext.id,
    functionDeclaration: fn.toString(), returnByValue: true, awaitPromise: true, userGesture: false })
  if (result.exceptionDetails) throw Error('READ_ONLY_OBSERVATION_FAILED')
  return result.result.value
}
const state = () => rpc(() => {
  const audio = document.querySelector('audio')
  return { build: document.body.dataset.build ?? null, contextSha256: document.body.dataset.recipe ?? null,
    status: document.querySelector('#status')?.textContent.trim() ?? null,
    transport: document.body.dataset.transport ?? null, videoId: document.body.dataset.videoId ?? null,
    frameCount: document.querySelectorAll('iframe').length, audioCount: document.querySelectorAll('audio').length,
    audio: { paused: audio.paused, time: audio.currentTime, duration: Number.isFinite(audio.duration) ? audio.duration : null,
      readyState: audio.readyState, errorCode: audio.error?.code ?? null, hasSrc: audio.hasAttribute('src'), muted: audio.muted },
    everActivated: navigator.userActivation.hasBeenActive }
})
try {
  let url = option('--url', null)
  if (!url) { server = createPwaServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }); url = `http://127.0.0.1:${server.address().port}/pletina/application/p1-check.html` }
  const target = new URL(url); assert.ok(target.protocol === 'https:' || target.protocol === 'http:' && target.hostname === '127.0.0.1'); assert.ok(target.pathname.endsWith('/application/p1-check.html'))
  browser = await puppeteer.launch({ headless: true, executablePath: option('--chrome', 'C:/Users/iunan/.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe'),
    ignoreDefaultArgs: ['--mute-audio', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], args: [] })
  assert.ok(!browser.process().spawnargs.some(value => /autoplay-policy|MediaEngagementBypassAutoplayPolicies|disable-web-security|ignore-certificate-errors|--mute-audio/.test(value)))
  report.browser = await browser.version(); context = await browser.createBrowserContext(); assert.equal((await context.cookies()).length, 0)
  page = await context.newPage(); await page.setViewport({ width: 1100, height: 1000 })
  const cdp = page.mainFrame().client, scripts = new Map(), cdn = new Map()
  await cdp.send('Debugger.enable'); await cdp.send('Network.enable')
  cdp.on('Debugger.scriptParsed', event => {
    let asset = 'anonymous-or-opaque-script'
    try { const parsed = new URL(event.url); if (parsed.protocol === 'http:' || parsed.protocol === 'https:') { const name = parsed.pathname.split('/').at(-1); if (/^[A-Za-z0-9_.-]{1,150}$/.test(name)) asset = name } }
    catch { /* No URL or script source is retained. */ }
    scripts.set(event.scriptId, asset)
  })
  cdp.on('Debugger.paused', event => {
    report.pauses++
    // Resume is dispatched before inspecting the already supplied exception
    // metadata. No evaluation or scope/property request is issued while paused.
    const resume = cdp.send('Debugger.resume').catch(() => {})
    pending.add(resume); void resume.finally(() => pending.delete(resume))
    const description = typeof event.data?.description === 'string' ? event.data.description.split('\n')[0] : ''
    const match = /^(P1EngineError|P1ProbeError|YouTubeError): (.+)$/.exec(description)
    if (!match) { report.ignoredExceptionValues++; return }
    const [, category, value] = match
    const message = category === 'P1EngineError' && /^[A-Za-z0-9 .-]{1,160}$/.test(value) ? value : known.has(value) ? value : null
    if (!message) { report.ignoredExceptionValues++; return }
    report.exceptions.push({ ...at(), category, message, knownCode: known.get(message) ?? null,
      functions: event.callFrames.slice(0, 7).map(frame => ({ name: /^[A-Za-z0-9_$ .<>-]{0,100}$/.test(frame.functionName) ? frame.functionName || '(anonymous)' : '(name omitted)',
        asset: scripts.get(frame.location.scriptId) ?? 'anonymous-or-opaque-script', line: frame.location.lineNumber + 1, column: frame.location.columnNumber + 1 })) })
  })
  cdp.on('Network.requestWillBeSent', event => {
    let endpoint; try { endpoint = new URL(event.request.url) } catch { return }
    if (endpoint.hostname.endsWith('.googlevideo.com')) cdn.set(event.requestId, { ...at(), urlSha256: sha256(event.request.url), itag: endpoint.searchParams.get('itag') })
  })
  cdp.on('Network.responseReceivedExtraInfo', event => { const request = cdn.get(event.requestId); if (request) report.cdnHttp.push({ ...at(), request, httpStatus: event.statusCode }) })
  page.on('response', response => {
    const operation = (async () => {
      const endpoint = new URL(response.url())
      if (endpoint.hostname !== 'www.youtube.com' || endpoint.pathname !== '/youtubei/v1/player') return
      let request, body; try { request = JSON.parse(response.request().postData() ?? '{}'); body = await response.json() } catch { return }
      report.providerResponses.push({ ...at(), client: ['VISIONOS', 'WEB_EMBEDDED_PLAYER'].includes(request.context?.client?.clientName) ? request.context.client.clientName : 'other',
        exactRequestId: request.videoId === 'fV-IUsecSsU', httpStatus: response.status(), status: typeof body?.playabilityStatus?.status === 'string' ? body.playabilityStatus.status : null,
        exactResponseId: body?.videoDetails?.videoId === request.videoId,
        aac: Array.isArray(body?.streamingData?.adaptiveFormats) ? body.streamingData.adaptiveFormats.filter(value => typeof value?.mimeType === 'string' && value.mimeType.startsWith('audio/mp4')).slice(0, 4).map(value => ({
          itag: Number.isSafeInteger(value.itag) ? value.itag : null, mimeType: value.mimeType.slice(0, 100),
          contentLength: /^\d{1,12}$/.test(String(value.contentLength ?? '')) ? Number(value.contentLength) : null,
          signatureCipher: typeof value.signatureCipher === 'string', drc: value.isDrc === true,
          drmPresent: Array.isArray(value.drmFamilies) ? value.drmFamilies.length > 0 : Object.hasOwn(value, 'drmFamilies') || Object.hasOwn(value, 'licenseInfos') || Object.hasOwn(value, 'drmTrackType'),
          hasOriginalityMetadata: ['audioTrack', 'xtags', 'language', 'languageCode'].some(key => value[key] != null) })) : [] })
    })().catch(() => { report.errors.push('PROVIDER_METADATA_OBSERVATION_FAILED') })
    pending.add(operation); void operation.finally(() => pending.delete(operation))
  })
  await page.goto(url, { waitUntil: 'load', timeout: 30000 })
  for (let i = 0; i < 100; i++) { const initial = await state(); if (initial.build && initial.contextSha256) { report.initialState = initial; break }; await delay(100) }
  assert.equal(report.initialState?.build, build); assert.equal(report.initialState.everActivated, false); report.build = build
  await cdp.send('Debugger.setPauseOnExceptions', { state: 'all' })
  const point = await rpc(() => { const rect = document.querySelector('[data-song="iritsi"]').getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } })
  report.click = { ...at(), kind: 'real mouse click', song: 'iritsi' }; await page.mouse.click(point.x, point.y)
  const deadline = Date.now() + 40000
  while (Date.now() < deadline) {
    const value = await state()
    if (value.status?.startsWith('No ha podido') || value.status?.startsWith('El audio') || !value.audio.paused && value.audio.time > 2) { report.finalState = value; break }
    await delay(200)
  }
  report.finalState ??= await state()
  await cdp.send('Debugger.setPauseOnExceptions', { state: 'none' }); await delay(100)
  report.diagnosticCompleted = true
} catch (error) { report.errors.push(safeError(error)) }
finally {
  await Promise.allSettled([...pending]); await context?.close(); await browser?.close(); if (server) await new Promise(resolve => server.close(resolve))
  report.resourcesClosed = true
}
await mkdir(directory, { recursive: true }); await writeFile(new URL(report.sourceSnapshot.replace('artifacts/pwa-port/', ''), directory), source)
await writeFile(new URL(reportName, directory), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ report: reportName, build: report.build, completed: report.diagnosticCompleted ?? false,
  pauses: report.pauses, exceptions: report.exceptions, providerResponses: report.providerResponses, cdnHttp: report.cdnHttp,
  finalState: report.finalState, errors: report.errors }))
if (report.errors.length || !report.diagnosticCompleted) process.exitCode = 1
