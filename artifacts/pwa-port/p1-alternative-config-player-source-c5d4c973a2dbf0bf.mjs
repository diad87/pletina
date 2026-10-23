// QA only: library-defined Session /config fields reused in the same opaque
// browser frame. No Node bootstrap, keys, accounts, tokens, media or product edit.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import puppeteer from 'puppeteer-core'

const args = process.argv.slice(2), option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const videos = option('--videos', '').split(',')
assert.ok(videos.length > 0 && videos.length <= 3 && videos.every(id => /^[\w-]{11}$/.test(id)), 'Supply 1-3 public IDs via --videos')
const name = option('--report', 'p1-alternative-config-player-2026-10-23.json')
assert.match(name, /^p1-alternative-[\w.-]+\.json$/)
const root = new URL('../../', import.meta.url), directory = new URL('artifacts/pwa-port/', root)
const sha = value => createHash('sha256').update(value).digest('hex')
const source = await readFile(new URL(import.meta.url)), sourceSha = sha(source), sourceSnapshot = `p1-alternative-config-player-source-${sourceSha.slice(0, 16)}.mjs`
await mkdir(directory, { recursive: true }); await writeFile(new URL(sourceSnapshot, directory), source)
const recipePath = 'artifacts/pwa-port/p1-static-recipe-c6acef753928cbe1.json', recipeBytes = await readFile(new URL(recipePath, root)), recipe = JSON.parse(recipeBytes)
const constants = await readFile(new URL('node_modules/youtubei.js/dist/src/utils/Constants.js', root), 'utf8')
const webVersion = constants.match(/\bWEB: \{[^}]*?\n\s+VERSION: '([^']+)'/)?.[1]
assert.match(webVersion ?? '', /^\d+(?:\.\d+)+$/)
assert.equal(recipe.client.name, 'WEB_EMBEDDED_PLAYER'); assert.equal(recipe.client.id, 56)
assert.ok(Number.isSafeInteger(recipe.player.signatureTimestamp) && recipe.player.signatureTimestamp > 0)
const input = { videos, webVersion, embeddedVersion: recipe.client.version, signatureTimestamp: recipe.player.signatureTimestamp }
const report = {
  schemaVersion: 1, testedAt: new Date().toISOString(), scope: 'Library-defined Session configInfo and own anonymous visitor reused in RAM; no audio request or playback proof.',
  execution: { scriptSha256: sourceSha, sourceSnapshot: 'artifacts/pwa-port/' + sourceSnapshot,
    recipePath, recipeSha256: sha(recipeBytes), recipeFieldsUsed: ['client.version', 'player.signatureTimestamp'], ...input,
    sessionSha256: sha(await readFile(new URL('node_modules/youtubei.js/dist/src/core/Session.js', root))),
    httpClientSha256: sha(await readFile(new URL('node_modules/youtubei.js/dist/src/utils/HTTPClient.js', root))) },
  mapping: 'Session18.2 maps /config response globalConfigGroup into WEB configInfo. HTTPClient18.2 removes configInfo when switching away from WEB; embedded uses only its own fresh response visitor, not WEB configInfo.',
  sources: ['https://github.com/LuanRT/YouTube.js/blob/204715b6acfb063dc306d8677e36fdbf09f293c5/src/core/Session.ts',
    'https://github.com/LuanRT/YouTube.js/blob/204715b6acfb063dc306d8677e36fdbf09f293c5/src/utils/HTTPClient.ts'],
  policy: { productChanged: false, nodeProviderRequests: false, borrowedVisitor: false, accountOrKey: false, cookieJar: false,
    securityOverrides: false, remoteJavascriptExecuted: false, observerUserGesture: false, mediaRequested: false,
    signedUrlsOrRawConfigurationPersisted: false, phoneOrBackgroundPlaybackClaimed: false },
  results: null, transport: [], errors: []
}
let browser
try {
  browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
    ignoreDefaultArgs: ['--mute-audio', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], args: [], protocolTimeout: 180000 })
  report.browser = await browser.version()
  const page = await browser.newPage(), client = page.mainFrame().client, requests = new Map()
  await client.send('Network.enable')
  client.on('Network.requestWillBeSent', event => { const u = new URL(event.request.url); if (u.hostname === 'www.youtube.com' && /^\/youtubei\/v1\/(?:config|player)$/.test(u.pathname)) requests.set(event.requestId, { path: u.pathname, method: event.request.method }) })
  client.on('Network.loadingFailed', event => { if (requests.has(event.requestId)) report.transport.push({ ...requests.get(event.requestId), error: event.errorText, cors: event.corsErrorStatus ?? null }) })
  await page.goto('https://diad87.github.io/pletina/', { waitUntil: 'domcontentloaded', timeout: 45000 })
  const inspect = async function (input) {
    const opaqueRuntime = async input => {
      const summary = { config: [], players: [] }, saved = {}
      const safe = value => String(value ?? '').replace(/https?:\/\/[^\s"'<>]+/g, '[URL]').slice(0, 180)
      const request = async (endpoint, body) => {
        const response = await fetch('https://www.youtube.com/youtubei/v1/' + endpoint + '?prettyPrint=false', {
          method: 'POST', credentials: 'omit', mode: 'cors', referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
          body: JSON.stringify(body), signal: AbortSignal.timeout(12000) })
        if (!response.body) return { response, value: {} }
        const reader = response.body.getReader(), chunks = []; let count = 0
        try { while (true) { const { done, value } = await reader.read(); if (done) break; count += value.byteLength; if (count > 4 * 1024 * 1024) throw new Error('response-budget'); chunks.push(value) } }
        finally { await reader.cancel().catch(() => {}) }
        const bytes = new Uint8Array(count); let offset = 0
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
        return { response, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\)\]\}'\s*/, '')), count }
      }
      for (const kind of ['WEB', 'WEB_EMBEDDED_PLAYER']) {
        const client = { hl: 'en', gl: 'US', clientName: kind, clientVersion: kind === 'WEB' ? input.webVersion : input.embeddedVersion }
        if (kind !== 'WEB') client.clientScreen = 'EMBED'
        const context = { client, ...(kind !== 'WEB' ? { thirdParty: { embedUrl: 'https://www.google.com/' } } : {}) }
        try {
          const { response, value, count } = await request('config', { context }), group = value.responseContext?.globalConfigGroup, configInfo = {}
          for (const [key, field] of [['coldConfigData', group?.rawColdConfigGroup?.configData], ['coldHashData', group?.coldHashData], ['hotHashData', group?.hotHashData]]) {
            if (typeof field === 'string' && field.length > 0 && field.length <= 32768) configInfo[key] = field
          }
          const visitor = value.responseContext?.visitorData
          saved[kind] = { context, configInfo, visitor: typeof visitor === 'string' && visitor.length > 0 && visitor.length <= 4096 ? visitor : null }
          summary.config.push({ kind, status: response.status, readable: true, bytes: count, visitorPresent: !!saved[kind].visitor,
            configInfoFields: Object.keys(configInfo), configDataPresent: typeof value.configData === 'string' && value.configData.length > 0,
            configDataLength: typeof value.configData === 'string' ? value.configData.length : 0,
            onesieHotConfigMarkerPresent: JSON.stringify(value).includes('onesieHotConfig'), encryptedHostFlagsMarkerPresent: JSON.stringify(value).includes('encryptedHostFlags'),
            responseContextKeys: Object.keys(value.responseContext ?? {}).slice(0, 30), topLevelKeys: Object.keys(value).slice(0, 30) })
        } catch (error) { summary.config.push({ kind, readable: false, error: error.name, message: safe(error.message) }) }
      }
      for (const videoId of input.videos) for (const variant of ['WEB-configInfo', 'WEB-no-configInfo', 'EMBEDDED-own-config-visitor']) {
        const kind = variant.startsWith('WEB-') ? 'WEB' : 'WEB_EMBEDDED_PLAYER', state = saved[kind]
        if (!state) { summary.players.push({ videoId, variant, skipped: 'config unavailable' }); continue }
        const context = structuredClone(state.context)
        if (state.visitor) context.client.visitorData = state.visitor
        if (variant === 'WEB-configInfo' && Object.keys(state.configInfo).length) context.client.configInfo = state.configInfo
        const body = { videoId, context, contentCheckOk: true, racyCheckOk: true,
          playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS', signatureTimestamp: input.signatureTimestamp } } }
        try {
          const { response, value, count } = await request('player', body), stream = value.streamingData ?? {}, audio = (stream.adaptiveFormats ?? []).filter(f => /^audio\//.test(f.mimeType ?? ''))
          summary.players.push({ videoId, variant, status: response.status, readable: true, bytes: count,
            playability: value.playabilityStatus?.status ?? null, reason: safe(value.playabilityStatus?.reason), exactVideoId: value.videoDetails?.videoId === videoId,
            duration: Number(value.videoDetails?.lengthSeconds) || null, sabrPresent: typeof stream.serverAbrStreamingUrl === 'string',
            hlsPresent: typeof stream.hlsManifestUrl === 'string', dashPresent: typeof stream.dashManifestUrl === 'string',
            directAudioCount: audio.filter(f => typeof f.url === 'string').length, cipherAudioCount: audio.filter(f => typeof f.signatureCipher === 'string' || typeof f.cipher === 'string').length,
            audioFormats: audio.map(f => ({ itag: f.itag, mime: f.mimeType, bitrate: f.bitrate ?? null })), apiErrorCode: value.error?.code ?? null })
        } catch (error) { summary.players.push({ videoId, variant, readable: false, error: error.name, message: safe(error.message) }) }
      }
      return summary
    }
    return await new Promise(resolve => {
      const frame = document.createElement('iframe'), id = crypto.randomUUID()
      frame.sandbox = 'allow-scripts'; frame.hidden = true
      const finish = value => { clearTimeout(timer); removeEventListener('message', receive); frame.remove(); resolve(value) }
      const receive = event => { if (event.source === frame.contentWindow && event.origin === 'null' && event.data?.id === id) finish(event.data.result) }
      const timer = setTimeout(() => finish({ error: 'opaque-deadline' }), 150000)
      addEventListener('message', receive)
      frame.srcdoc = '<script>(' + (async ({ id, input, source }) => { try { const run = Function('return (' + source + ')')(); parent.postMessage({ id, result: await run(input) }, '*') } catch(error) { parent.postMessage({ id, result: { error: error.name } }, '*') } }).toString() + ')(' + JSON.stringify({ id, input, source: opaqueRuntime.toString() }).replaceAll('<', '\u003c') + ')<' + '/script>'
      document.body.append(frame)
    })
  }
  const result = await client.send('Runtime.callFunctionOn', { executionContextId: page.mainFrame().mainRealm().context.id, functionDeclaration: inspect.toString(),
    arguments: [{ value: input }], awaitPromise: true, returnByValue: true, userGesture: false })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  report.results = result.result.value
} catch (error) { report.errors.push(error.message.replace(/https?:\/\/[^\s"'<>]+/g, '[URL]').slice(0, 300)) }
finally { await browser?.close() }
report.conclusion = report.results?.players?.some(p => p.directAudioCount || p.cipherAudioCount || p.sabrPresent || p.hlsPresent || p.dashPresent)
  ? 'A response supplies some streaming structure; it has not been fetched, decoded, played, or shown to continue in background.'
  : 'Readable /config fields did not establish a streaming route for the tested contexts. No media was requested.'
await writeFile(new URL(name, directory), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
if (report.errors.length || report.results?.error) process.exitCode = 1
