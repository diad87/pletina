// QA-only browser-native context investigation. No Node provider bootstrap,
// borrowed visitor, account, key, proxy, cross-origin DOM, media/body persistence
// or product change. Values remain in the isolated browser's RAM.
// Run: node scripts/tests/p1-context-bootstrap.browser.mjs --video <public-id>
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'

const args = process.argv.slice(2), option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback
const videoId = option('--video')
assert.match(videoId ?? '', /^[A-Za-z0-9_-]{11}$/, 'Supply --video; no musical IDs are embedded in this method')
const name = option('--report', 'p1-context-bootstrap-2026-10-23.json')
assert.match(name, /^p1-context-[a-z0-9.-]+\.json$/i)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const root = new URL('../../', import.meta.url), directory = new URL('artifacts/pwa-port/', root)
await mkdir(directory, { recursive: true })
const source = await readFile(new URL(import.meta.url)), sourceSha256 = hash(source), snapshot = `p1-context-source-${sourceSha256.slice(0, 16)}.mjs`
await writeFile(new URL(snapshot, directory), source)
const recipePath = 'artifacts/pwa-port/p1-static-recipe-c6acef753928cbe1.json'
const recipe = JSON.parse(await readFile(new URL(recipePath, root), 'utf8'))
const pwaSource = await readFile(new URL('web-port/youtube.ts', root), 'utf8')
const webVersion = pwaSource.match(/const WEB_VERSION = '([^']+)'/)?.[1]
assert.ok(webVersion && recipe.client.name === 'WEB_EMBEDDED_PLAYER' && recipe.client.id === 56)
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), videoId,
  scope: 'Read-only native-browser responseContext reuse and documented IFrame API message observation; no playback or full extractor claim.',
  execution: { scriptSha256: sourceSha256, snapshot: 'artifacts/pwa-port/' + snapshot, recipePath, recipeSha256: hash(await readFile(new URL(recipePath, root))),
    recipeFieldsUsed: ['client.version', 'player.signatureTimestamp'], clientVersion: recipe.client.version, signatureTimestamp: recipe.player.signatureTimestamp,
    sourceModules: await Promise.all(['core/Session.js', 'utils/HTTPClient.js', 'parser/types/RawResponse.d.ts'].map(async path => ({ path, sha256: hash(await readFile(new URL('node_modules/youtubei.js/dist/src/' + path, root))) }))) },
  policy: { productChanged: false, deployed: false, nodeProviderRequests: false, accountKeyOrProxy: false, manuallySuppliedCookies: false,
    browserSecurityOverrides: false, borrowedVisitorUsed: false, crossOriginDomRead: false, rawContextPersisted: false, signedUrlsOrAudioPersisted: false,
    iframeAutoplay: false, playbackCommandSent: false, officialIframeCodeRunsNormally: true, providerMediaRequestsBlockedForMetadataProbe: true },
  primarySources: [
    { url: 'https://developers.google.com/youtube/iframe_api_reference', consulted: '2026-10-23', relevance: 'Documented player construction, metadata/options/events and postMessage support; no account/bootstrap getter is documented.' },
    { url: 'https://github.com/LuanRT/YouTube.js/blob/main/src/core/Session.ts', consulted: '2026-10-23', relevance: 'Primary implementation; exact installed 18.2.0 files are hashed above rather than assuming mutable main matches.' },
  ], browserContext: null, iframe: null, network: { blockedMediaRequests: 0 }, errors: [] }
const persist = () => writeFile(new URL(name, directory), JSON.stringify(report, null, 2) + '\n')

async function contextProbe(input) {
  const fresh = {}, summaries = [], pathValue = (object, path) => path.split('.').reduce((value, key) => value?.[key], object)
  const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, '0')).join('')
  const described = async (value, prefix, result = [], depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 12 || result.length > 120) return result
    for (const [key, child] of Object.entries(value).slice(0, 100)) {
      const path = prefix + '.' + key
      if (/visitor|experiment|rollout|config|hostflag|clientname|clientversion|appinstall|timestamp/i.test(key)) {
        result.push({ path, type: Array.isArray(child) ? 'array' : child === null ? 'null' : typeof child,
          ...(typeof child === 'string' ? { length: child.length, sha256: await digest(child) } : {}),
          ...(child && typeof child === 'object' ? { keys: Object.keys(child).slice(0, 25) } : {}) })
      }
      if (child && typeof child === 'object') await described(child, path, result, depth + 1)
    }
    return result
  }
  const extract = value => {
    const rc = value.responseContext ?? {}, client = {}
    const visitor = rc.visitorData ?? rc.webResponseContextExtensionData?.ytConfigData?.visitorData
    if (typeof visitor === 'string' && visitor.length > 0 && visitor.length <= 4096) client.visitorData = visitor
    if (typeof rc.rolloutToken === 'string' && rc.rolloutToken.length > 0 && rc.rolloutToken.length <= 4096) client.rolloutToken = rc.rolloutToken
    // These exact three mappings are used by Session.js 18.2.0 after /config.
    const group = rc.globalConfigGroup ?? {}, configInfo = {}
    for (const [key, part] of [['coldConfigData', group.rawColdConfigGroup?.configData], ['coldHashData', group.coldHashData], ['hotHashData', group.hotHashData]]) {
      if (typeof part === 'string' && part.length > 0 && part.length <= 32768) configInfo[key] = part
    }
    if (Object.keys(configInfo).length) client.configInfo = configInfo
    return client
  }
  async function request(label, endpoint, body) {
    const started = performance.now()
    try {
      const response = await fetch('https://www.youtube.com/youtubei/v1/' + endpoint + '?prettyPrint=false', {
        method: 'POST', credentials: 'omit', mode: 'cors', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(12000),
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(body),
      })
      if (!response.ok || !response.body) { await response.body?.cancel(); summaries.push({ label, readable: false, status: response.status }); return null }
      const reader = response.body.getReader(), chunks = []
      let count = 0
      try { while (true) { const part = await reader.read(); if (part.done) break; count += part.value.byteLength; if (count > 4 * 1024 ** 2) throw Error('RESPONSE_SIZE'); chunks.push(part.value) } }
      catch (error) { await reader.cancel().catch(() => {}); throw error }
      finally { reader.releaseLock() }
      const bytes = new Uint8Array(count); let offset = 0
      for (const part of chunks) { bytes.set(part, offset); offset += part.length }
      const value = JSON.parse(new TextDecoder().decode(bytes).replace(/^\)\]\}'\s*/, ''))
      const formats = (value.streamingData?.adaptiveFormats ?? []).filter(format => /^audio\//.test(format.mimeType ?? ''))
      summaries.push({ label, readable: true, status: response.status, bytes: count, elapsedMs: Math.round(performance.now() - started),
        apiError: value.error?.code ?? null, playability: value.playabilityStatus?.status ?? null, exactVideoId: value.videoDetails?.videoId === input.videoId,
        audioFormats: formats.length, audioCipherFormats: formats.filter(f => f.signatureCipher || f.cipher).length, directAudioFormats: formats.filter(f => f.url).length,
        responseContextKeys: Object.keys(value.responseContext ?? {}), publicContextFields: await described(value.responseContext, 'responseContext'),
        serviceTrackingKeyNames: (value.responseContext?.serviceTrackingParams ?? []).flatMap(row => (row.params ?? []).map(part => part.key)).filter(key => typeof key === 'string').slice(0, 80),
        extractedClientFields: Object.keys(extract(value)),
        noticeExact: pathValue(value, 'playabilityStatus.miniplayer.miniplayerRenderer.minimizedEndpoint.openPopupAction.popup.notificationActionRenderer.responseText.simpleText') === 'Miniplayer is off for videos made for kids. Tap play to resume',
        playableInEmbed: value.playabilityStatus?.playableInEmbed ?? null, familySafe: value.microformat?.playerMicroformatRenderer?.isFamilySafe ?? null })
      return value
    } catch (error) { summaries.push({ label, readable: false, error: error.name, code: error.message === 'RESPONSE_SIZE' ? error.message : 'BROWSER_REQUEST_FAILED' }); return null }
  }
  const control = await request('WEB-search-context-control', 'search', { context: { client: { clientName: 'WEB', clientVersion: input.webVersion, hl: 'en', gl: 'ES' } }, query: input.videoId })
  Object.assign(fresh, control ? extract(control) : {})
  const web = await request('WEB-player-browser-context', 'player', { videoId: input.videoId,
    context: { client: { clientName: 'WEB', clientVersion: input.webVersion, hl: 'en', gl: 'ES', ...fresh } }, contentCheckOk: true, racyCheckOk: true })
  const webClient = web ? { ...fresh, ...extract(web) } : fresh
  const base = { videoId: input.videoId, context: { client: { clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: input.embeddedVersion, hl: 'en' }, thirdParty: { embedUrl: 'https://www.reddit.com/' } },
    contentCheckOk: true, racyCheckOk: true, playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS', signatureTimestamp: input.signatureTimestamp } } }
  const initial = await request('embedded-no-visitor-response-context', 'player', base)
  const own = initial ? extract(initial) : {}
  if (Object.keys(own).length) await request('embedded-own-response-context-retry', 'player', { ...base, context: { ...base.context, client: { ...base.context.client, ...own } } })
  if (Object.keys(webClient).length) {
    await request('embedded-WEB-player-issued-context', 'player', { ...base, context: { ...base.context, client: { ...base.context.client, ...webClient } } })
    // Local 18.2.0 HTTPClient's documented-by-source client adaptation. No opaque
    // Node flags or experiment fields are borrowed into this variant.
    const { configInfo: _removedBy18_2, ...libraryClient } = webClient
    await request('embedded-library18_2-shape-with-browser-context', 'player', { ...base,
      context: { client: { ...base.context.client, ...libraryClient, clientScreen: 'EMBED' }, thirdParty: { embedUrl: 'https://www.google.com/' } } })
  }
  return { origin: location.origin, summaries, rawValuesReturnedToNode: false, standaloneBootstrapPositive: summaries.some(r => r.label.startsWith('embedded-') && r.exactVideoId && r.audioCipherFormats > 0) }
}

async function iframeProbe(input) {
  const out = { provider: 'Official YouTube IFrame API', autoplay: false, playbackCommands: [], crossOriginDomRead: false,
    ready: false, apiError: null, eventTypes: [], messages: [], contextFields: [], publicMethods: null, debugText: [], framesRemoved: false }
  const container = document.createElement('div'); container.id = 'p1-context-player-host'; document.body.prepend(container)
  let player, frame, receivedBytes = 0
  const receive = event => {
    if (!frame || event.source !== frame.contentWindow || !['https://www.youtube.com', 'https://www.youtube-nocookie.com'].includes(event.origin) || out.messages.length >= 60) return
    let value = event.data
    if (typeof value === 'string') { if (value.length > 65536 || (receivedBytes += value.length) > 512 * 1024) return; try { value = JSON.parse(value) } catch { return } }
    if (!value || typeof value !== 'object') return
    const kind = typeof value.event === 'string' ? value.event.slice(0, 80) : 'no-event-name'
    out.messages.push({ event: kind, keys: Object.keys(value).slice(0, 25), infoKeys: value.info && typeof value.info === 'object' ? Object.keys(value.info).slice(0, 50) : [] })
    const visit = (row, prefix, depth = 0) => {
      if (!row || typeof row !== 'object' || depth > 8 || out.contextFields.length >= 80) return
      for (const [key, child] of Object.entries(row).slice(0, 80)) {
        const path = prefix + '.' + key
        if (/visitor|encryptedhostflags|deviceexperiment|rollouttoken|appinstalldata|coldconfig|coldhash|hothash|innertube/i.test(key)) out.contextFields.push({ path, type: typeof child, length: typeof child === 'string' ? child.length : null })
        if (key === 'debugText' && typeof child === 'string' && child.length <= 65536 && out.debugText.length < 10) {
          let parsed = null
          try { parsed = JSON.parse(child) } catch { /* A text diagnostic is not executable data. */ }
          out.debugText.push({ length: child.length, json: parsed !== null, keys: parsed && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 80) : [] })
          if (parsed && typeof parsed === 'object') visit(parsed, path + '.json', depth + 1)
        }
        if (child && typeof child === 'object') visit(child, path, depth + 1)
      }
    }
    visit(value, 'message')
  }
  window.addEventListener('message', receive)
  try {
    if (!globalThis.YT?.Player) await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('IFRAME_API_DEADLINE')), 12000)
      globalThis.onYouTubeIframeAPIReady = () => { clearTimeout(timer); resolve() }
      const script = document.createElement('script'); script.src = 'https://www.youtube.com/iframe_api'; script.onerror = () => { clearTimeout(timer); reject(Error('IFRAME_API_NETWORK')) }; document.head.append(script)
    })
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 16000)
      player = new YT.Player(container.id, { width: 480, height: 270, videoId: input.videoId,
        playerVars: { autoplay: 0, controls: 1, playsinline: 1, hl: 'en', origin: location.origin }, events: {
          onReady(event) { out.ready = true; out.eventTypes.push('onReady'); try { out.publicMethods = { modules: event.target.getOptions(), playerState: event.target.getPlayerState(), duration: event.target.getDuration() } } catch { out.publicMethodError = true }; clearTimeout(timer); setTimeout(resolve, 1500) },
          onError(event) { out.apiError = event.data; out.eventTypes.push('onError'); clearTimeout(timer); resolve() },
          onApiChange() { out.eventTypes.push('onApiChange') },
        } })
      frame = player.getIframe()
      out.frameOrigin = new URL(frame.src).origin
      out.frameQueryKeys = [...new URL(frame.src).searchParams.keys()]
    })
  } catch (error) { out.error = ['IFRAME_API_DEADLINE', 'IFRAME_API_NETWORK'].includes(error.message) ? error.message : 'IFRAME_PROBE_FAILED' }
  finally { window.removeEventListener('message', receive); player?.destroy(); container.remove(); out.framesRemoved = !document.querySelector('#p1-context-player-host'); delete globalThis.onYouTubeIframeAPIReady }
  return out
}

let browser
try {
  browser = await puppeteer.launch({ headless: true, executablePath: option('--chrome', 'C:/Users/iunan/.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe'),
    ignoreDefaultArgs: ['--mute-audio', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], args: [], protocolTimeout: 120000 })
  const page = await browser.newPage()
  report.browser = await browser.version()
  await page.setRequestInterception(true)
  page.on('request', request => { const url = new URL(request.url()); if (url.hostname === 'googlevideo.com' || url.hostname.endsWith('.googlevideo.com')) { report.network.blockedMediaRequests++; void request.abort('blockedbyclient') } else void request.continue() })
  await page.goto('https://diad87.github.io/pletina/', { waitUntil: 'domcontentloaded', timeout: 30000 })
  const client = await page.createCDPSession(), context = await client.send('Runtime.evaluate', { expression: 'globalThis', userGesture: false })
  const call = async (fn, value) => {
    const result = await client.send('Runtime.callFunctionOn', { objectId: context.result.objectId, functionDeclaration: fn.toString(),
      arguments: [{ value }], returnByValue: true, awaitPromise: true, userGesture: false })
    if (result.exceptionDetails) throw Error('BROWSER_EVALUATION_FAILED')
    return result.result.value
  }
  const input = { videoId, webVersion, embeddedVersion: recipe.client.version, signatureTimestamp: recipe.player.signatureTimestamp }
  report.browserContext = await call(async ({ source, input }) => new Promise(resolve => {
    const frame = document.createElement('iframe'), id = crypto.randomUUID(); frame.sandbox = 'allow-scripts'; frame.hidden = true
    const finish = value => { clearTimeout(timer); window.removeEventListener('message', receive); frame.remove(); resolve(value) }
    const receive = event => { if (event.source === frame.contentWindow && event.origin === 'null' && event.data?.id === id) finish(event.data.result) }
    const timer = setTimeout(() => finish({ error: 'OPAQUE_CONTEXT_DEADLINE' }), 75000)
    window.addEventListener('message', receive)
    frame.srcdoc = '<script>(' + (async ({ source, input, id }) => { const probe = Function('return (' + source + ')')(); parent.postMessage({ id, result: await probe(input) }, '*') }).toString() + ')(' + JSON.stringify({ source, input, id }).replaceAll('<', '\\u003c') + ')<' + '/script>'
    document.body.append(frame)
  }), { source: contextProbe.toString(), input })
  await persist()
  report.iframe = await call(iframeProbe, input)
} catch (error) { report.errors.push({ name: error.name, code: 'CONTEXT_QA_FAILED' }) }
finally { await browser?.close(); report.browsersClosed = true }
report.summary = { responseContextBootstrapPositive: report.browserContext?.standaloneBootstrapPositive ?? false,
  iframeReady: report.iframe?.ready ?? false, iframeContextFieldCount: report.iframe?.contextFields?.length ?? 0,
  noRuntimeBackendOrBorrowedVisitor: true, mediaPlayed: false, contextValuesPersisted: false }
await persist()
console.log(JSON.stringify({ report: 'artifacts/pwa-port/' + name, ...report.summary, errors: report.errors }))
