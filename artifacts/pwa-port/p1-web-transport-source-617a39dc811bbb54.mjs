// Bounded normal-browser transport diagnostic for the new P1 embedded client.
// No product imports/edits, Rust build, proxy, account, API key, player execution,
// signature transform, media fetch or persisted signed URL. Fresh anonymous
// public bootstrap values obtained by this QA's Node GET stay in RAM only.
// That control is explicitly NOT a bootstrap available to a standalone PWA.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'

const args = process.argv.slice(2), option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const round = option('--round', 'baseline')
assert.ok(['baseline', 'generic'].includes(round))
const official = option('--official', 'C:/Users/iunan/musify-oficial')
const reportName = option('--report', round === 'generic' ? 'p1-web-transport-generic-2026-10-23.json' : 'p1-web-transport-2026-10-23.json')
assert.match(reportName, /^[a-z0-9.-]+\.json$/i)
const names = option('--only', 'epoitaitaye,iritsi,maite').split(',')
const cases = {
  epoitaitaye: { title: 'Epoitaitaye', videoId: 'DJzjkMBMook', kind: 'P1-native-positive' },
  iritsi: { title: 'Iritsi da Eguna', videoId: 'fV-IUsecSsU', kind: 'PWA-difficult' },
  maite: { title: 'Maite Zaitut!', videoId: 'WtTRMAoN2Fw', kind: 'P1-native-positive' },
  pupu: { title: 'Pupu Eta Lore', videoId: 'kcUgLakr7bU', kind: 'P1-native-positive-control' },
}
assert.ok(names.length > 0 && names.length <= 4 && names.every(name => Object.hasOwn(cases, name)))
const sha = value => createHash('sha256').update(value).digest('hex')
const scrub = value => String(value?.message ?? value).replace(/(?:https?|blob):[^\s"'<>]+/g, '[URL]').slice(0, 350)
const directory = new URL('../../artifacts/pwa-port/', import.meta.url)
await mkdir(directory, { recursive: true })
const script = await readFile(new URL(import.meta.url)), scriptSha256 = sha(script), snapshotName = `p1-web-transport-source-${scriptSha256.slice(0, 16)}.mjs`
await writeFile(new URL(snapshotName, directory), script)
const sourceFiles = ['docs/informe-contenido-infantil-2026-10-23.md', 'src-tauri/src/native_embedded.rs', 'src-tauri/src/youtube_session.rs']
let frozenProvenance
if (round === 'generic') {
  const bytes = await readFile(new URL('p1-web-transport-2026-10-23.json', directory))
  assert.equal(sha(bytes), 'a26aa9f5e8782b0bd488b025f9bd70fa17bdf3cd7cc1ab8298b348ea9d43b8e6', 'First report remains immutable')
  const prior = JSON.parse(bytes), original = await readFile(new URL('../../' + prior.execution.sourceSnapshot, import.meta.url), 'utf8')
  assert.equal(sha(original), prior.execution.scriptSha256)
  const block = text => text.slice(text.indexOf('async function configuration(song) {'), text.indexOf('// The exact same QA-owned function'))
  assert.equal(sha(block(script.toString('utf8'))), sha(block(original)), 'P1 config/body port stays identical to the first frozen runner')
  frozenProvenance = { firstReport: 'artifacts/pwa-port/p1-web-transport-2026-10-23.json', firstReportSha256: sha(bytes),
    firstSourceSnapshot: prior.execution.sourceSnapshot, firstSourceSha256: prior.execution.scriptSha256,
    portedConfigurationFunctionSha256: sha(block(original)), officialHead: prior.execution.officialHead, officialSources: prior.execution.officialSources,
    officialCheckoutReadThisRound: false }
}
const youtubeSource = round === 'generic' ? await readFile(new URL('../../web-port/youtube.ts', import.meta.url), 'utf8') : ''
const versions = round === 'generic' ? { music: youtubeSource.match(/const MUSIC_VERSION = '([\d.]+)'/)?.[1], web: youtubeSource.match(/const WEB_VERSION = '([\d.]+)'/)?.[1] } : null
if (versions) { assert.match(versions.music ?? '', /^[\d.]+$/); assert.match(versions.web ?? '', /^[\d.]+$/) }
const report = { schemaVersion: 1, testedAt: new Date().toISOString(), round, scope: round === 'generic'
  ? 'One generic public embedded recipe reused across IDs with a Music visitor freshly obtained in browser RAM. Opaque WEB metadata compares the P1 notice gate; no audio.'
  : 'P1 WEB_EMBEDDED_PLAYER public bootstrap and player metadata transport from ordinary Pages and opaque origins; not a playback or background test.',
  execution: { scriptSha256, sourceSnapshot: 'artifacts/pwa-port/' + snapshotName,
    ...(frozenProvenance ? { frozenProvenance, pwaVersionSourceSha256: sha(youtubeSource), versions } : { officialHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: official, encoding: 'utf8' }).trim(),
      officialSources: await Promise.all(sourceFiles.map(async path => ({ path, sha256: sha(await readFile(official + '/' + path)) }))) }) },
  policy: { productChanged: false, rustBuilt: false, proxyUsed: false, accountOrSubscriptionUsed: false, apiKeyUsed: false, cookieJarUsed: false,
    borrowedCredentialsUsed: false, protectedAuthenticationOrDrmAttempted: false, remoteJavascriptExecuted: false, mediaRequested: false,
    signedUrlsPersisted: false, visitorOrFlagsValuesPersisted: false, securityOverrides: false, backgroundThrottleOverrides: false, observerUserGesture: false, outputMuted: false,
    diagnosticBootstrap: 'Fresh anonymous public HTML and JS read by QA Node GET in memory; availability through Node does not establish PWA CORS access.' },
  requestDifferenceFromNative: { clientName: 'WEB_EMBEDDED_PLAYER', clientId: 56, copiedBodyFields: 'P1 allowlist including its public embedded context and fresh ST',
    browserContentType: 'text/plain;charset=UTF-8', nativeContentType: 'application/json',
    omittedNativeHeaders: ['User-Agent override', 'Origin override', 'Accept-Encoding override', 'X-Youtube-Client-Name', 'X-Youtube-Client-Version', 'X-Goog-Visitor-Id'],
    reason: 'The browser owns forbidden headers; text/plain avoids adding a JSON/custom-header preflight. No header restriction is bypassed.' },
  nodeBootstrap: [], corsReads: [], player: [], webEligibility: [], controls: [], transport: [], errors: [],
}
const persist = () => writeFile(new URL(reportName, directory), JSON.stringify(report, null, 2) + '\n')
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.5 Safari/605.1.15,gzip(gfe)'
const publicPlayers = new Map()
async function publicGet(url, maximum = 4 * 1024 * 1024) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': UA, Referer: 'https://www.reddit.com/', 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'error' })
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Public bootstrap HTTP ' + response.status) }
  const declared = response.headers.get('content-length')
  if (declared && Number(declared) > maximum) { await response.body.cancel(); throw new Error('Public bootstrap declared over budget') }
  const reader = response.body.getReader(), chunks = []; let count = 0
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break
      count += part.value.byteLength
      if (count > maximum) throw new Error('Public bootstrap exceeded byte budget')
      chunks.push(part.value)
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error }
  finally { reader.releaseLock() }
  const bytes = Buffer.concat(chunks)
  return { text: bytes.toString('utf8'), bytes: count, sha256: sha(bytes), status: response.status }
}
function jsonAfter(text, marker) {
  const result = []; let start = 0
  while ((start = text.indexOf(marker, start)) >= 0) {
    start += marker.length
    while (/\s/.test(text[start] ?? '')) start++
    if (text[start] !== '{' || result.length >= 64) throw new Error('Public JSON marker invalid')
    let depth = 0, quoted = false, escaped = false, end = start
    for (; end < text.length; end++) {
      const char = text[end]
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue }
      if (char === '"') quoted = true
      else if (char === '{') depth++
      else if (char === '}' && --depth === 0) { end++; break }
    }
    result.push(JSON.parse(text.slice(start, end)))
  }
  return result
}
async function configuration(song) {
  const embed = 'https://www.youtube.com/embed/' + song.videoId + '?html5=1', html = await publicGet(embed)
  const selected = {}, allowed = ['INNERTUBE_CLIENT_NAME', 'INNERTUBE_CLIENT_VERSION', 'INNERTUBE_CONTEXT_CLIENT_NAME', 'VISITOR_DATA', 'INNERTUBE_CONTEXT', 'WEB_PLAYER_CONTEXT_CONFIGS']
  for (const object of jsonAfter(html.text, 'ytcfg.set(')) for (const key of allowed) if (key in object) {
    if (key in selected && JSON.stringify(selected[key]) !== JSON.stringify(object[key])) throw new Error('Ambiguous public configuration')
    selected[key] = object[key]
  }
  assert.equal(selected.INNERTUBE_CLIENT_NAME, 'WEB_EMBEDDED_PLAYER'); assert.equal(selected.INNERTUBE_CONTEXT_CLIENT_NAME, 56)
  const version = selected.INNERTUBE_CLIENT_VERSION, client = selected.INNERTUBE_CONTEXT?.client ?? {}, context = selected.WEB_PLAYER_CONTEXT_CONFIGS?.WEB_PLAYER_CONTEXT_CONFIG_ID_EMBEDDED_PLAYER
  assert.match(version, /^\d+(?:\.\d+)+$/)
  const visitor = selected.VISITOR_DATA ?? client.visitorData, flags = context?.encryptedHostFlags
  assert.ok(typeof visitor === 'string' && visitor.length > 0 && visitor.length <= 4096)
  assert.ok(typeof flags === 'string' && flags.length > 0 && flags.length <= 32768)
  if (client.clientName) assert.equal(client.clientName, 'WEB_EMBEDDED_PLAYER')
  if (client.clientVersion) assert.equal(client.clientVersion, version)
  if (client.visitorData) assert.equal(client.visitorData, visitor)
  const player = new URL(context?.jsUrl, 'https://www.youtube.com')
  assert.equal(player.origin, 'https://www.youtube.com'); assert.match(player.pathname, /^\/s\/player\/[a-zA-Z0-9_-]+\/player_[a-zA-Z0-9_-]+\.vflset\/[a-zA-Z_]+\/base\.js$/)
  assert.equal(player.search, ''); assert.equal(player.hash, '')
  let code = publicPlayers.get(player.href)
  if (!code) { code = await publicGet(player.href); publicPlayers.set(player.href, code) }
  const stamps = [...code.text.matchAll(/signatureTimestamp\s*:\s*(\d+)/g)].map(match => Number(match[1]))
  const unique = [...new Set(stamps)]
  assert.equal(unique.length, 1, 'One unambiguous public signature timestamp, no remote JS evaluation')
  const extras = {}
  for (const [name, maximum] of [['platform', 128], ['clientFormFactor', 128], ['osName', 128], ['osVersion', 128], ['browserName', 128], ['browserVersion', 128], ['gl', 128], ['deviceExperimentId', 4096], ['rolloutToken', 4096]]) {
    if (client[name] === undefined) continue
    assert.ok(typeof client[name] === 'string' && client[name].length > 0 && client[name].length <= maximum && !/[^\x20-\x7e]/.test(client[name]))
    extras[name] = client[name]
  }
  if (client.configInfo?.appInstallData !== undefined) {
    assert.ok(typeof client.configInfo.appInstallData === 'string' && client.configInfo.appInstallData.length <= 8192)
    extras.configInfo = { appInstallData: client.configInfo.appInstallData }
  }
  const body = { videoId: song.videoId, context: { client: { clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: version, hl: 'en', userAgent: UA, visitorData: visitor, ...extras }, thirdParty: { embedUrl: 'https://www.reddit.com/' } },
    contentCheckOk: true, racyCheckOk: true, playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS', signatureTimestamp: unique[0], encryptedHostFlags: flags } } }
  report.nodeBootstrap.push({ ...song, embed: { status: html.status, bytes: html.bytes, sha256: html.sha256 }, clientName: selected.INNERTUBE_CLIENT_NAME, clientVersion: version,
    clientId: 56, visitorPresent: true, flagsPresent: true, contextFields: Object.keys(extras), player: { path: player.pathname, status: code.status, bytes: code.bytes, sha256: code.sha256, signatureTimestamp: unique[0] },
    bodySha256: sha(JSON.stringify(body)), copiedRequestAccountOrTracking: false })
  await persist()
  return { body, embed, player: player.href }
}

// The exact same QA-owned function runs in the top frame and the sandboxed
// opaque frame. It does not execute provider HTML/JS or expose signed URL values.
async function browserProbe(input) {
  const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('')
  const safe = value => String(value?.message ?? value).replace(/(?:https?|blob):[^\s"'<>]+/g, '[URL]').slice(0, 250)
  const begin = performance.now()
  try {
    const response = await fetch(input.url, { method: input.body ? 'POST' : 'GET', credentials: 'omit', mode: 'cors', referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(12000), ...(input.body ? { headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(input.body) } : {}) })
    if (!response.ok || !response.body) { await response.body?.cancel(); return { readable: false, status: response.status, elapsedMs: Math.round(performance.now() - begin) } }
    const maximum = 4 * 1024 * 1024, length = response.headers.get('content-length')
    if (length && Number(length) > maximum) { await response.body.cancel(); return { readable: false, error: 'declared-byte-budget', status: response.status } }
    const reader = response.body.getReader(), chunks = []; let count = 0
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break
        count += part.value.byteLength; if (count > maximum) throw new Error('body-byte-budget')
        chunks.push(part.value)
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error }
    finally { reader.releaseLock() }
    const bytes = new Uint8Array(count); let at = 0
    for (const part of chunks) { bytes.set(part, at); at += part.length }
    const text = new TextDecoder().decode(bytes), common = { readable: true, status: response.status, type: response.type, contentType: response.headers.get('content-type')?.split(';')[0] ?? null,
      bytes: count, sha256: await hash(bytes), elapsedMs: Math.round(performance.now() - begin) }
    if (!input.body) return { ...common, markers: { embeddedClient: text.includes('WEB_EMBEDDED_PLAYER'), ytcfg: text.includes('ytcfg.set('), signatureTimestamp: text.includes('signatureTimestamp') } }
    let value
    try { value = JSON.parse(text.replace(/^\)\]\}'\s*/, '')) } catch { return { ...common, json: false } }
    const requestBodySha256 = await hash(new TextEncoder().encode(JSON.stringify(input.body)))
    if (input.kind === 'music-visitor') {
      const visitor = value.responseContext?.visitorData
      return { ...common, requestBodySha256, visitorPresent: typeof visitor === 'string' && visitor.length > 0 && visitor.length <= 4096,
        visitorBytes: typeof visitor === 'string' ? visitor.length : 0,
        visitorSha256: typeof visitor === 'string' ? await hash(new TextEncoder().encode(visitor)) : null,
        privateVisitor: typeof visitor === 'string' && visitor.length <= 4096 ? visitor : null }
    }
    const stream = value.streamingData ?? {}, audio = (stream.adaptiveFormats ?? []).filter(format => /^audio\//.test(format.mimeType ?? ''))
    const path = value.playabilityStatus?.miniplayer?.miniplayerRenderer?.minimizedEndpoint?.openPopupAction?.popup?.notificationActionRenderer?.responseText?.simpleText
    const asset = typeof value.assets?.js === 'string' ? new URL(value.assets.js, 'https://www.youtube.com') : null
    return { ...common, requestBodySha256, json: true, playability: value.playabilityStatus?.status ?? null, reason: safe(value.playabilityStatus?.reason ?? ''),
      exactVideoId: value.videoDetails?.videoId === input.body.videoId, videoId: value.videoDetails?.videoId ?? null, title: value.videoDetails?.title ?? null,
      duration: Number(value.videoDetails?.lengthSeconds) || null, playableInEmbed: value.playabilityStatus?.playableInEmbed ?? null,
      explicitMadeForKidsNotice: path === 'Miniplayer is off for videos made for kids. Tap play to resume',
      noticePresent: typeof path === 'string', noticeSha256: typeof path === 'string' ? await hash(new TextEncoder().encode(path)) : null,
      isFamilySafe: typeof value.microformat?.playerMicroformatRenderer?.isFamilySafe === 'boolean' ? value.microformat.playerMicroformatRenderer.isFamilySafe : null,
      assetsJsPresent: !!asset, assetsJsPublicPath: asset?.origin === 'https://www.youtube.com' && !asset.search && !asset.hash ? asset.pathname : null,
      responseSignatureTimestamp: typeof value.playerConfig?.html5PlaybackConfiguration?.signatureTimestamp === 'number' ? value.playerConfig.html5PlaybackConfiguration.signatureTimestamp : null,
      sabrPresent: typeof stream.serverAbrStreamingUrl === 'string', hlsPresent: typeof stream.hlsManifestUrl === 'string', dashPresent: typeof stream.dashManifestUrl === 'string',
      adaptiveCount: stream.adaptiveFormats?.length ?? 0, audioFormats: audio.map(format => ({ itag: format.itag, mime: format.mimeType, bitrate: format.bitrate ?? null,
        directUrlPresent: typeof format.url === 'string', signatureCipherPresent: typeof format.signatureCipher === 'string', cipherPresent: typeof format.cipher === 'string',
        drc: format.isDrc === true, drm: !!(format.drmFamilies?.length || format.drmTrackType), original: format.audioTrack?.isOriginal ?? format.audioTrack?.audioIsOriginal ?? null,
        audioTrackMetadataPresent: !!format.audioTrack, xtagsPresent: !!format.xtags, languageMetadataPresent: typeof format.language === 'string' })) }
  } catch (error) { return { readable: false, error: error.name, message: safe(error), elapsedMs: Math.round(performance.now() - begin) } }
}
let browser, page
try {
  browser = await puppeteer.launch({ headless: true, executablePath: option('--chrome', 'C:/Users/iunan/.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe'),
    ignoreDefaultArgs: ['--mute-audio', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], args: [], protocolTimeout: 180000 })
  report.browser = await browser.version(); page = await browser.newPage()
  const client = page.mainFrame().client, requests = new Map()
  await client.send('Network.enable')
  client.on('Network.requestWillBeSent', event => {
    const url = new URL(event.request.url)
    if (['www.youtube.com', 'music.youtube.com'].includes(url.hostname)) requests.set(event.requestId, { host: url.hostname, method: event.request.method,
      route: url.pathname.startsWith('/youtubei/') ? 'player' : url.pathname.startsWith('/s/player/') ? 'base.js' : url.pathname.startsWith('/embed/') ? 'embed' : url.pathname === '/sw.js_data' ? 'sw.js_data' : 'watch' })
  })
  client.on('Network.responseReceivedExtraInfo', event => { const item = requests.get(event.requestId); if (item) report.transport.push({ ...item, phase: 'response-headers', status: event.statusCode,
    allowOrigin: event.headers['access-control-allow-origin'] ?? event.headers['Access-Control-Allow-Origin'] ?? null }) })
  client.on('Network.loadingFailed', event => { const item = requests.get(event.requestId); if (item) report.transport.push({ ...item, phase: 'failed', error: scrub(event.errorText), corsErrorStatus: event.corsErrorStatus ?? null, blockedReason: event.blockedReason ?? null }) })
  await page.goto('https://diad87.github.io/pletina/', { waitUntil: 'domcontentloaded', timeout: 30000 })
  const call = async (fn, value) => {
    const context = page.mainFrame().mainRealm().context
    const response = await client.send('Runtime.callFunctionOn', { executionContextId: context.id, functionDeclaration: fn.toString(), arguments: [{ value }], returnByValue: true, awaitPromise: true, userGesture: false })
    if (response.exceptionDetails) throw new Error(scrub(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text))
    return response.result.value
  }
  async function runBoth(input) {
    return call(async ({ input, source }) => {
      if (input.usePwaVisitor) {
        if (typeof window.__p1BrowserVisitor !== 'string' || !window.__p1BrowserVisitor) throw new Error('No fresh browser Music visitor available')
        input.body = { ...input.body, context: { ...input.body.context, client: { ...input.body.context.client, visitorData: window.__p1BrowserVisitor } } }
      }
      const probe = Function('return (' + source + ')')(), top = input.onlyOpaque ? null : await probe(input)
      const opaque = await new Promise(resolve => {
        const frame = document.createElement('iframe'), id = crypto.randomUUID(); frame.sandbox = 'allow-scripts'; frame.hidden = true
        const finish = value => { clearTimeout(timer); window.removeEventListener('message', receive); frame.remove(); resolve(value) }
        const receive = event => {
          if (event.source !== frame.contentWindow || event.origin !== 'null' || event.data?.id !== id) return
          const result = event.data.result
          if (input.kind === 'music-visitor') { window.__p1BrowserVisitor = result.privateVisitor; delete result.privateVisitor }
          finish(result)
        }
        const timer = setTimeout(() => finish({ readable: false, error: 'opaque-frame-deadline' }), 15000)
        window.addEventListener('message', receive)
        frame.srcdoc = '<script>(' + (async ({ id, input, source }) => { const probe = Function('return (' + source + ')')(); parent.postMessage({ id, result: await probe(input) }, '*') }).toString() + ')(' + JSON.stringify({ id, input, source }).replaceAll('<', '\\u003c') + ')<' + '/script>'
        document.body.append(frame)
      })
      return [...(top ? [{ origin: location.origin, ...top }] : []), { origin: 'opaque-null', ...opaque }]
    }, { input, source: browserProbe.toString() })
  }
  let firstConfig
  if (round === 'generic') {
    const results = await runBoth({ kind: 'music-visitor', onlyOpaque: true, url: 'https://music.youtube.com/youtubei/v1/search?prettyPrint=false',
      body: { context: { client: { clientName: 'WEB_REMIX', clientVersion: versions.music, hl: 'es', gl: 'ES' } }, query: 'music', params: 'EgWKAQIIAWoKEAkQBRAKEAMQBA==' } })
    report.browserVisitor = { source: 'Anonymous Music search through the normal opaque browser request', queryContainsTestVideoId: false, results, rawValueReturnedToNode: false }
    assert.ok(results[0].readable && results[0].visitorPresent, 'Fresh Music visitor must be obtained by the PWA browser itself')
    await persist()
  }
  for (const [index, name] of names.entries()) {
    const song = cases[name]
    console.log('Checking fresh P1 configuration and browser body:', name)
    let cfg
    try { cfg = round === 'generic' && firstConfig ? firstConfig : await configuration(song) } catch (error) { report.nodeBootstrap.push({ ...song, error: scrub(error) }); await persist(); continue }
    firstConfig ??= cfg
    if (round === 'generic' && index === 0) {
      const recipe = { ...cfg.body, videoId: undefined, context: { ...cfg.body.context, client: { ...cfg.body.context.client, visitorData: undefined } } }
      report.genericRecipe = { publicBootstrapRequestsPerCorpus: 1, perVideoBootstrapUsed: false, reusedAcrossVideoIds: true, visitorExcludedFromRecipe: true,
        titleOrSongSpecificFieldsCopied: false, recipeSha256WithoutVisitorOrVideoId: sha(JSON.stringify(recipe)), player: report.nodeBootstrap[0].player,
        limits: 'A fresh build-time/public recipe is tested immediately, not proof of six-hour validity or unchanged future YouTube experiments.' }
      report.controls.push({ kind: 'same-generic-recipe-with-its-own-fresh-bootstrap-visitor', videoId: song.videoId,
        results: await runBoth({ onlyOpaque: true, url: 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false', body: cfg.body }) })
    }
    if (round === 'baseline' && index === 0) {
      for (const [kind, url] of [['embed', cfg.embed], ['base.js', cfg.player], ['web-bootstrap', 'https://www.youtube.com/sw.js_data'], ['music-bootstrap', 'https://music.youtube.com/sw.js_data'], ['watch', 'https://www.youtube.com/watch?v=' + song.videoId + '&hl=en']]) {
        const results = await runBoth({ url }); report.corsReads.push({ kind, videoId: song.videoId, results }); await persist()
      }
    }
    const body = { ...cfg.body, videoId: song.videoId }
    const results = await runBoth({ url: 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false', body,
      ...(round === 'generic' ? { onlyOpaque: true, usePwaVisitor: true } : {}) })
    report.player.push({ ...song, bodySha256BeforeBrowserVisitorReplacement: sha(JSON.stringify(body)), genericRecipe: round === 'generic', results }); await persist()
    if (round === 'generic') {
      const webBody = { videoId: song.videoId, context: { client: { clientName: 'WEB', clientVersion: versions.web, hl: 'en', gl: 'ES', userAgent: UA } }, contentCheckOk: true, racyCheckOk: true,
        playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS', signatureTimestamp: cfg.body.playbackContext.contentPlaybackContext.signatureTimestamp } } }
      report.webEligibility.push({ ...song, client: 'WEB', source: 'Existing PWA WEB version with fresh Music browser visitor; metadata only, no old audio/transport replay.',
        results: await runBoth({ onlyOpaque: true, usePwaVisitor: true, url: 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false', body: webBody }) })
      await persist()
    }
    console.log(JSON.stringify({ case: name, results: results.map(result => ({ origin: result.origin, readable: result.readable, status: result.status, playability: result.playability, audio: result.audioFormats?.length, cipher: result.audioFormats?.filter(format => format.signatureCipherPresent || format.cipherPresent).length, sabr: result.sabrPresent, error: result.error })) }))
  }
  if (firstConfig) {
    const body = { ...firstConfig.body, videoId: '___________' }
    report.player.push({ title: 'Invalid video negative control', videoId: body.videoId, kind: 'negative-control', bodySha256: sha(JSON.stringify(body)),
      results: await runBoth({ url: 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false', body,
        ...(round === 'generic' ? { onlyOpaque: true, usePwaVisitor: true } : {}) }) })
  }
} catch (error) { report.errors.push(scrub(error)) }
finally { await browser?.close() }
report.summary = { requestedCases: names, publicConfigurationsObtained: report.nodeBootstrap.filter(value => !value.error).length,
  browserBootstrapReadable: report.corsReads.some(entry => entry.results.some(result => result.readable)),
  playerMetadataReadable: report.player.some(entry => entry.kind !== 'negative-control' && entry.results.some(result => result.readable && result.json)),
  exactAudioCipherReturned: report.player.some(entry => entry.kind !== 'negative-control' && entry.results.some(result => result.exactVideoId && result.audioFormats?.some(format => format.signatureCipherPresent || format.cipherPresent))),
  completePlaybackEstablished: false, standaloneBrowserBootstrapEstablished: false, mediaOrSignedUrlsWritten: false }
report.browsersClosed = true
await persist()
console.log(JSON.stringify({ report: reportName, summary: report.summary, errors: report.errors }, null, 2))
if (report.errors.length) process.exitCode = 1
