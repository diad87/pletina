// Real-cipher diagnostic only. Node's anonymous public embed bootstrap is a
// positive control, not a session shipped to the PWA or a production backend.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import puppeteer from 'puppeteer-core'
import { prepareStaticDecoder } from './p1-static-decoder-prototype.mjs'

const args = process.argv.slice(2), option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const cases = { epoitaitaye: { videoId: 'DJzjkMBMook', title: 'Epoitaitaye' }, maite: { videoId: 'WtTRMAoN2Fw', title: 'Maite Zaitut!' }, iritsi: { videoId: 'fV-IUsecSsU', title: 'Iritsi da Eguna' } }
const name = option('--case', 'epoitaitaye'); assert.ok(Object.hasOwn(cases, name))
const requestedItag = Number(option('--itag', '140')); assert.ok([140, 251].includes(requestedItag))
const song = cases[name], directory = new URL('../../artifacts/pwa-port/', import.meta.url)
const sha = value => crypto.createHash('sha256').update(value).digest('hex')
const source = await fs.readFile(new URL(import.meta.url)), sourceHash = sha(source)
const reportName = option('--report', `p1-live-decoder-${name}-${requestedItag}-2026-10-23.json`)
assert.match(reportName, /^p1-live-decoder-[a-z0-9.-]+\.json$/)
const report = { schemaVersion: 1, testedAt: new Date().toISOString(), song, scriptSha256: sourceHash,
  sourceSnapshot: `artifacts/pwa-port/p1-live-decoder-source-${sourceHash.slice(0, 16)}.mjs`, checks: [], errors: [],
  scope: 'Real cipher, isolated browser worker and CDN/audio control. Embed configuration obtained anonymously by QA Node in RAM; not autonomous PWA bootstrap.',
  policy: { productChanged: false, published: false, borrowedCredentials: false, accountsOrCookies: false, runtimeProxy: false,
    fullPlayerExecuted: false, signedUrlsOrSessionValuesPersisted: false, mediaPersisted: false, browserSecurityOverrides: false,
    physicalPhone: false, screenOffVerified: false, audibleAutoplayVerified: false } }
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.5 Safari/605.1.15,gzip(gfe)'
async function publicText(url) {
  const response = await fetch(url, { redirect: 'error', headers: { 'User-Agent': UA, Referer: 'https://www.reddit.com/', 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(15000) })
  if (!response.ok || !response.body) { await response.body?.cancel(); throw Error('PUBLIC_HTTP_' + response.status) }
  const reader = response.body.getReader(), parts = []; let length = 0
  try { while (true) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > 5 * 1024 * 1024) throw Error('PUBLIC_SIZE'); parts.push(part.value) } }
  catch (error) { await reader.cancel().catch(() => {}); throw error } finally { reader.releaseLock() }
  const bytes = Buffer.concat(parts); return { text: bytes.toString('utf8'), bytes: bytes.length, sha256: sha(bytes) }
}
function configurations(text) {
  const results = []; let position = 0
  while ((position = text.indexOf('ytcfg.set(', position)) >= 0) {
    position += 'ytcfg.set('.length; while (/\s/.test(text[position] ?? '')) position++
    assert.equal(text[position], '{'); assert.ok(results.length < 64)
    const start = position; let depth = 0, quoted = false, escaped = false
    for (; position < text.length; position++) {
      const char = text[position]
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue }
      if (char === '"') quoted = true
      else if (char === '{') depth++
      else if (char === '}' && --depth === 0) { position++; break }
    }
    assert.equal(depth, 0); results.push(JSON.parse(text.slice(start, position)))
  }
  return Object.assign({}, ...results)
}
let browser
try {
  const embed = await publicText(`https://www.youtube.com/embed/${song.videoId}?html5=1`), cfg = configurations(embed.text)
  assert.equal(cfg.INNERTUBE_CLIENT_NAME, 'WEB_EMBEDDED_PLAYER')
  const context = cfg.WEB_PLAYER_CONTEXT_CONFIGS.WEB_PLAYER_CONTEXT_CONFIG_ID_EMBEDDED_PLAYER
  const player = new URL(context.jsUrl, 'https://www.youtube.com')
  assert.equal(player.origin, 'https://www.youtube.com'); assert.match(player.pathname, /^\/s\/player\/[A-Za-z0-9_-]+\/player_[A-Za-z0-9_-]+\.vflset\/[A-Za-z_]+\/base\.js$/)
  assert.equal(player.search, ''); assert.equal(player.hash, '')
  const code = await publicText(player.href), prepared = prepareStaticDecoder(code.text)
  const client = cfg.INNERTUBE_CONTEXT.client, extras = {}
  for (const key of ['platform', 'clientFormFactor', 'osName', 'osVersion', 'browserName', 'browserVersion', 'gl', 'deviceExperimentId', 'rolloutToken']) if (typeof client[key] === 'string') extras[key] = client[key]
  if (typeof client.configInfo?.appInstallData === 'string') extras.configInfo = { appInstallData: client.configInfo.appInstallData }
  const body = { videoId: song.videoId, context: { client: { clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: cfg.INNERTUBE_CLIENT_VERSION, hl: 'en', userAgent: UA, visitorData: cfg.VISITOR_DATA ?? client.visitorData, ...extras }, thirdParty: { embedUrl: 'https://www.reddit.com/' } },
    contentCheckOk: true, racyCheckOk: true, playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS', signatureTimestamp: prepared.signatureTimestamp, encryptedHostFlags: context.encryptedHostFlags } } }
  report.control = { bootstrapSha256: embed.sha256, bootstrapBytes: embed.bytes, playerPath: player.pathname, playerSha256: code.sha256, playerBytes: code.bytes,
    scriptSha256: sha(prepared.script), scriptBytes: Buffer.byteLength(prepared.script), signatureTimestamp: prepared.signatureTimestamp, bodySha256: sha(JSON.stringify(body)) }
  browser = await puppeteer.launch({ headless: true, executablePath: 'C:/Users/iunan/.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe',
    ignoreDefaultArgs: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], args: [], protocolTimeout: 120000 })
  const page = await browser.newPage(); report.browser = await browser.version()
  report.cdnResponses = []; report.networkFailures = []; report.cdnHeaders = []
  const cdp = page.mainFrame().client, cdnRequests = new Set()
  await cdp.send('Network.enable')
  cdp.on('Network.requestWillBeSent', event => { try { if (new URL(event.request.url).hostname.endsWith('.googlevideo.com')) cdnRequests.add(event.requestId) } catch {} })
  cdp.on('Network.responseReceivedExtraInfo', event => { if (cdnRequests.has(event.requestId)) report.cdnHeaders.push({ status: event.statusCode, allowOrigin: event.headers['access-control-allow-origin'] ?? event.headers['Access-Control-Allow-Origin'] ?? null }) })
  cdp.on('Network.loadingFailed', event => { if (cdnRequests.has(event.requestId)) report.networkFailures.push({ error: event.errorText, blockedReason: event.blockedReason ?? null, corsError: event.corsErrorStatus ?? null }) })
  page.on('response', response => { try { const url = new URL(response.url()); if (url.hostname.endsWith('.googlevideo.com')) report.cdnResponses.push({ status: response.status(), itag: url.searchParams.get('itag'), type: response.request().resourceType(), contentType: response.headers()['content-type']?.split(';')[0] ?? null, allowOrigin: response.headers()['access-control-allow-origin'] ?? null }) } catch {} })
  await page.goto('https://diad87.github.io/pletina/', { waitUntil: 'domcontentloaded' })
  const call = async (fn, value) => {
    const context = page.mainFrame().mainRealm().context
    const result = await page.mainFrame().client.send('Runtime.callFunctionOn', { executionContextId: context.id, functionDeclaration: fn.toString(), arguments: [{ value }], returnByValue: true, awaitPromise: true, userGesture: false })
    if (result.exceptionDetails) { const first = result.exceptionDetails.exception?.description?.split('\n')[0] ?? ''; throw Error(/^Error: [A-Z0-9_]+$/.test(first) ? first.slice(7) : 'BROWSER_STEP_FAILED') }
    return result.result.value
  }
  const preparedResult = await call(async ({ body, script, requestedItag }) => {
    // This generic bridge returns to the page only. Signed URLs/bodies never
    // leave browser RAM and are absent from the diagnostic return object.
    const opaque = (fn, value, maximumMs = 25000) => new Promise((resolve, reject) => {
      const frame = document.createElement('iframe'), id = crypto.randomUUID(); frame.sandbox = 'allow-scripts'; frame.hidden = true
      const finish = (error, result) => { clearTimeout(timer); window.removeEventListener('message', receive); frame.remove(); error ? reject(Error(error)) : resolve(result) }
      const receive = event => { if (event.source === frame.contentWindow && event.origin === 'null' && event.data?.id === id) finish(event.data.error, event.data.result) }
      const timer = setTimeout(() => finish('OPAQUE_DEADLINE'), maximumMs)
      window.addEventListener('message', receive)
      const bridge = async ({ id, source, value }) => {
        try { const fn = Function('return (' + source + ')')(), result = await fn(value); parent.postMessage({ id, result }, '*') }
        catch { parent.postMessage({ id, error: 'OPAQUE_REQUEST_FAILED' }, '*') }
      }
      frame.srcdoc = '<script>(' + bridge.toString() + ')(' + JSON.stringify({ id, source: fn.toString(), value }).replaceAll('<', '\\u003c') + ')<' + '/script>'
      document.body.append(frame)
    })
    const response = await opaque(async body => {
      const response = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000) })
      if (!response.ok) throw Error('PLAYER_HTTP')
      const text = await response.text(); if (text.length > 4 * 1024 * 1024) throw Error('PLAYER_SIZE')
      return JSON.parse(text)
    }, body)
    if (response.playabilityStatus?.status !== 'OK' || response.videoDetails?.videoId !== body.videoId) return { status: response.playabilityStatus?.status ?? null, exactId: false }
    const format = response.streamingData?.adaptiveFormats?.find(format => format.itag === requestedItag && format.mimeType?.startsWith('audio/') && !format.isDrc && !format.drmFamilies?.length)
    if (!format) return { status: 'OK', exactId: true, compatibleAudio: false }
    const cipher = new URLSearchParams(format.signatureCipher ?? format.cipher ?? '')
    if ([...cipher.keys()].some(key => !['url', 's', 'sp'].includes(key)) || ['url', 's', 'sp'].some(key => cipher.getAll(key).length > 1)) throw Error('CIPHER_FIELDS')
    const url = new URL(format.url ?? cipher.get('url')), sig = cipher.get('s'), n = url.searchParams.get('n'), sp = cipher.get('sp') ?? 'signature'
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.googlevideo.com') || url.username || url.password || url.port || url.hash || !['sig', 'signature', 'lsig'].includes(sp)) throw Error('AUDIO_ORIGIN')
    const transformed = await new Promise((resolve, reject) => {
      const frame = document.createElement('iframe'), id = crypto.randomUUID(); frame.sandbox = 'allow-scripts'; frame.hidden = true
      const finish = (error, result) => { clearTimeout(timer); window.removeEventListener('message', receive); frame.remove(); error ? reject(Error(error)) : resolve(result) }
      const receive = event => { if (event.source === frame.contentWindow && event.origin === 'null' && event.data?.id === id) finish(event.data.error, event.data.result) }
      const timer = setTimeout(() => finish('DECODER_PARENT_DEADLINE'), 3500); window.addEventListener('message', receive)
      const run = ({ id, script, sig, n }) => {
        const processValues = (exportedVars, sig, n) => {
          const url = exportedVars.nsigFunction('https://ytjs.googlevideo.com/videoplayback?expire=1234567890&n=' + encodeURIComponent(n || ''), 'sig', sig || '')
          for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(url))) if (!['constructor', 'clone', 'set', 'get'].includes(name) && typeof url[name] === 'function') url[name]()
          const result = {}; if (sig != null) result.sig = decodeURIComponent(url.get('sig')); if (n != null) result.n = decodeURIComponent(url.get('n')); return result
        }
        const workerSource = `const send=postMessage.bind(globalThis),compile=Function;onmessage=({data})=>{try{const fn=compile('sig','n',${JSON.stringify('"use strict";\n' + script + '\nreturn (' + processValues.toString() + ')(exportedVars,sig,n);')});send({result:fn(data.sig,data.n)})}catch{send({error:'DECODER_FAILED'})}};`
        const blob = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' })); let worker
        const finish = result => { clearTimeout(timer); worker?.terminate(); URL.revokeObjectURL(blob); parent.postMessage({ id, ...result }, '*') }
        const timer = setTimeout(() => finish({ error: 'DECODER_DEADLINE' }), 1500)
        try { worker = new Worker(blob); worker.onmessage = event => finish(event.data); worker.onerror = event => { event.preventDefault(); finish({ error: 'WORKER_ERROR' }) }; worker.postMessage({ sig, n }) }
        catch { finish({ error: 'WORKER_SETUP' }) }
      }
      frame.srcdoc = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\' \'unsafe-eval\'; worker-src blob:; connect-src \'none\'; base-uri \'none\'; form-action \'none\'"><script>(' + run.toString() + ')(' + JSON.stringify({ id, script, sig, n }).replaceAll('<', '\\u003c') + ')<' + '/script>'
      document.body.append(frame)
    })
    for (const [key, input] of [['sig', sig], ['n', n]]) if (input != null && (typeof transformed[key] !== 'string' || !transformed[key].length || transformed[key].length > 4096 || transformed[key].startsWith('enhanced_except_') || key === 'n' && transformed[key] === input)) throw Error('DECODER_OUTPUT')
    if (sig) url.searchParams.set(sp, transformed.sig); if (n) url.searchParams.set('n', transformed.n)
    window.__p1Live = { url: url.href, format, opaque }
    let range
    try { range = await opaque(async url => { const response = await fetch(url, { credentials: 'omit', headers: { Range: 'bytes=1024-2047' }, signal: AbortSignal.timeout(8000) }); const bytes = await response.arrayBuffer(); return { readable: true, status: response.status, bytes: bytes.byteLength, contentRange: response.headers.get('content-range') } }, url.href, 10000) }
    catch { range = { readable: false } }
    const audio = new Audio(); audio.muted = true; audio.preload = 'auto'; window.__p1Live.audio = audio
    for (const [name, action] of [['start', () => audio.play()], ['seek', () => { audio.currentTime = audio.duration * 0.8 }], ['tail', () => { audio.currentTime = audio.duration - 2 }]]) {
      const button = document.createElement('button'); button.id = 'p1qa-' + name; button.textContent = name; button.onclick = () => Promise.resolve(action()).catch(() => {}); document.body.prepend(button)
    }
    audio.src = url.href
    const metadata = await new Promise(resolve => { const timer = setTimeout(() => resolve({ error: 'metadata-deadline' }), 15000); audio.onloadedmetadata = () => { clearTimeout(timer); resolve({ duration: audio.duration }) }; audio.onerror = () => { clearTimeout(timer); resolve({ error: audio.error?.code }) }; audio.load() })
    return { status: 'OK', exactId: true, itag: format.itag, mime: format.mimeType, declaredBytes: Number(format.contentLength), bitrate: format.bitrate,
      signatureCharsetValid: /^[A-Za-z0-9_.-]+={0,2}$/.test(transformed.sig), nCharsetValid: /^[A-Za-z0-9_.-]+$/.test(transformed.n),
      inputLengths: { sig: sig?.length ?? null, n: n?.length ?? null }, outputLengths: { sig: transformed.sig?.length ?? null, n: transformed.n?.length ?? null }, range, metadata }
  }, { body, script: prepared.script, requestedItag })
  report.result = preparedResult
  const check = (name, pass, details = {}) => { report.checks.push({ name, pass, ...details }); assert.ok(pass, name) }
  check('exact requested audio metadata deciphered in browser worker', preparedResult.exactId && preparedResult.outputLengths?.sig > 0)
  check('CDN selected audio loads in ordinary HTMLAudio', preparedResult.metadata?.duration > 0, { metadata: preparedResult.metadata })
  await page.click('#p1qa-start')
  await page.waitForFunction(() => window.__p1Live.audio.currentTime > 2 && !window.__p1Live.audio.paused, { timeout: 15000 })
  check('native audio advances from beginning', true)
  await page.click('#p1qa-seek')
  await page.waitForFunction(() => window.__p1Live.audio.currentTime > window.__p1Live.audio.duration * 0.8 + 1, { timeout: 12000 })
  check('audio advances after 80 percent seek', true)
  await page.click('#p1qa-tail'); await page.waitForFunction(() => window.__p1Live.audio.ended, { timeout: 10000 })
  check('tail reaches natural ended', true)
  const full = await call(async () => {
    const { url, opaque, format } = window.__p1Live
    try {
      return await opaque(async ({ url, declared }) => {
        const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(20000) })
        if (!response.ok || !response.body) return { readable: false, status: response.status }
        const reader = response.body.getReader(), parts = []; let size = 0
        try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 32 * 1024 * 1024) throw Error('MEDIA_SIZE'); parts.push(part.value) } }
        catch { await reader.cancel().catch(() => {}); return { readable: false, error: 'transfer-failed' } } finally { reader.releaseLock() }
        const all = new Uint8Array(size); let offset = 0; for (const part of parts) { all.set(part, offset); offset += part.length }
        const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', all))].map(value => value.toString(16).padStart(2, '0')).join('')
        return { readable: true, status: response.status, bytes: size, declared, exactLength: size === declared, sha256 }
      }, { url, declared: Number(format.contentLength) })
    } catch { return { readable: false, error: 'opaque-cdn-blocked' } }
  }, null)
  report.fullFile = full
  await call(() => { const audio = window.__p1Live?.audio; if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load() }; delete window.__p1Live; document.querySelectorAll('[id^="p1qa-"]').forEach(node => node.remove()); return true }, null)
} catch (error) {
  const message = String(error?.message ?? error)
  report.errors.push(/^[A-Z0-9_ -]{1,180}$/.test(message) ? message : 'QA_ASSERTION_OR_BROWSER_STEP_FAILED')
} finally { await browser?.close(); report.browsersClosed = true }
await fs.mkdir(directory, { recursive: true })
await fs.writeFile(new URL(report.sourceSnapshot.replace('artifacts/pwa-port/', ''), directory), source)
await fs.writeFile(new URL(reportName, directory), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ report: reportName, checks: report.checks, result: report.result, fullFile: report.fullFile, errors: report.errors }))
if (report.errors.length) process.exitCode = 1
