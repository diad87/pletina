// Research only: public Session bootstraps from the actual PWA origin and an
// opaque sandbox. No provider token, key, response body, cookie or media URL is
// persisted. Browser CORS remains enabled; no request is sent by Node.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import puppeteer from 'puppeteer-core'

const base = new URL('../../', import.meta.url)
const libraryBase = new URL('node_modules/youtubei.js/', base)
const packageInfo = JSON.parse(await readFile(new URL('package.json', libraryBase), 'utf8'))
const sessionBytes = await readFile(new URL('dist/src/core/Session.js', libraryBase))
const constants = await readFile(new URL('dist/src/utils/Constants.js', libraryBase), 'utf8')
// Read public version identifiers only. Never use built-in keys/static visitors.
const version = name => constants.match(new RegExp(`${name}: \\{[^}]*?\\n\\s+VERSION: '([^']+)'`))?.[1]
const versions = { WEB: version('WEB'), WEB_EMBEDDED: version('WEB_EMBEDDED') }
if (Object.values(versions).some(value => !/^\d+(?:\.\d+){1,5}$/.test(value ?? ''))) throw new Error('Public client versions unavailable')
const report = {
  testedAt: new Date().toISOString(), scope: 'Public Session18.2 sw.js_data and config endpoint bootstrap; browser-readable access only.',
  provenance: { library: `youtubei.js@${packageInfo.version}`, sessionSha256: createHash('sha256').update(sessionBytes).digest('hex'),
    upstreamCommit: '204715b6acfb063dc306d8677e36fdbf09f293c5',
    upstreamSession: 'https://github.com/LuanRT/YouTube.js/blob/204715b6acfb063dc306d8677e36fdbf09f293c5/src/core/Session.ts',
    p1Commit: '0aa9e1c1ad21a6b66924c18af41aab2d78533cf7', publicClientVersions: versions },
  constraints: { credentials: 'omit', keysUsed: false, borrowedVisitorUsed: false, nodeSeedContextUsed: false, customHeadersUsed: false,
    remoteJavascriptExecuted: false, browserSecurityOverrides: false, observerUserGesture: false, rawConfigurationPersisted: false,
    mediaRequested: false, playbackOrPhysicalPhoneClaimed: false, maximumDecodedResponseBytes: 2 * 1024 * 1024 },
  results: [], transport: [], errors: [], productChanged: false
}
let browser
try {
  browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
    ignoreDefaultArgs: ['--mute-audio', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], args: [] })
  const page = await browser.newPage(), client = page.mainFrame().client, requests = new Map()
  await client.send('Network.enable')
  client.on('Network.requestWillBeSent', event => {
    const url = new URL(event.request.url)
    if (url.hostname === 'www.youtube.com' && ['/sw.js_data', '/youtubei/v1/config'].includes(url.pathname)) {
      requests.set(event.requestId, { path: url.pathname, method: event.request.method, origin: event.request.headers.Origin ?? 'browser-managed' })
    }
  })
  client.on('Network.responseReceivedExtraInfo', event => {
    if (requests.has(event.requestId)) report.transport.push({ ...requests.get(event.requestId), kind: 'http-status', status: event.statusCode })
  })
  client.on('Network.loadingFailed', event => {
    if (requests.has(event.requestId)) report.transport.push({ ...requests.get(event.requestId), kind: 'failed', error: event.errorText, corsErrorStatus: event.corsErrorStatus ?? null })
  })
  await page.goto('https://diad87.github.io/pletina/', { waitUntil: 'domcontentloaded', timeout: 45000 })
  const context = page.mainFrame().mainRealm().context
  const inspect = async function (versions) {
    const run = async versions => {
      const boundedText = async response => {
        if (!response.body) return ''
        const reader = response.body.getReader(), parts = []; let length = 0
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            length += value.byteLength
            if (length > 2 * 1024 * 1024) throw new Error('response-too-large')
            parts.push(value)
          }
          const bytes = new Uint8Array(length); let cursor = 0
          for (const part of parts) { bytes.set(part, cursor); cursor += part.byteLength }
          return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        } finally { await reader.cancel().catch(() => {}) }
      }
      const inputs = [
        { label: 'sw-js-data', url: 'https://www.youtube.com/sw.js_data', method: 'GET' },
        { label: 'config-web', url: 'https://www.youtube.com/youtubei/v1/config?prettyPrint=false', method: 'POST',
          context: { client: { hl: 'en', gl: 'US', clientName: 'WEB', clientVersion: versions.WEB } } },
        { label: 'config-embedded', url: 'https://www.youtube.com/youtubei/v1/config?prettyPrint=false', method: 'POST',
          context: { client: { hl: 'en', gl: 'US', clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: versions.WEB_EMBEDDED, clientScreen: 'EMBED' }, thirdParty: { embedUrl: 'https://www.google.com/' } } }
      ]
      const results = []
      for (const input of inputs) {
        try {
          const response = await fetch(input.url, { method: input.method, credentials: 'omit', signal: AbortSignal.timeout(12000),
            ...(input.context ? { headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify({ context: input.context }) } : {}) })
          const text = await boundedText(response)
          const result = { label: input.label, readable: true, status: response.status, type: response.type, textBytes: new TextEncoder().encode(text).byteLength }
          if (input.label === 'sw-js-data') {
            result.antiXssiPrefix = text.startsWith(")]}'")
            if (result.antiXssiPrefix) {
              const data = JSON.parse(text.slice(5)), device = data?.[0]?.[2]?.[0]?.[0]
              // Shape only; don't even extract the neighbouring API-key slot.
              result.deviceArrayPresent = Array.isArray(device)
              result.visitorPresent = typeof device?.[13] === 'string' && device[13].length > 0
              result.clientVersionPresent = typeof device?.[16] === 'string' && device[16].length > 0
              result.configArrayPresent = Array.isArray(device?.[61])
              result.browserNamePresent = typeof device?.[86] === 'string'
            }
          } else {
            const data = JSON.parse(text), group = data?.responseContext?.globalConfigGroup
            result.responseContextPresent = !!data?.responseContext && typeof data.responseContext === 'object'
            result.configDataPresent = typeof data?.configData === 'string' && data.configData.length > 0
            result.coldConfigDataPresent = typeof group?.rawColdConfigGroup?.configData === 'string' && group.rawColdConfigGroup.configData.length > 0
            result.coldHashDataPresent = typeof group?.coldHashData === 'string' && group.coldHashData.length > 0
            result.hotHashDataPresent = typeof group?.hotHashData === 'string' && group.hotHashData.length > 0
            result.error = data?.error ? { code: data.error.code ?? null, status: data.error.status ?? null } : null
          }
          results.push(result)
        } catch (error) { results.push({ label: input.label, readable: false, error: error.name, message: error.message.replace(/https?:\/\/[^\s"'<>]+/g, '[URL]').slice(0, 200) }) }
      }
      return results
    }
    const top = await run(versions)
    const opaque = await new Promise(resolve => {
      const frame = document.createElement('iframe'), id = crypto.randomUUID()
      frame.sandbox = 'allow-scripts'; frame.hidden = true
      const finish = result => { clearTimeout(timer); window.removeEventListener('message', receive); frame.remove(); resolve(result) }
      const receive = event => { if (event.source === frame.contentWindow && event.origin === 'null' && event.data?.id === id) finish(event.data.result) }
      const timer = setTimeout(() => finish([{ label: 'all', readable: false, error: 'timeout' }]), 40000)
      window.addEventListener('message', receive)
      frame.srcdoc = '<script>(' + (async ({ versions, id, source }) => { const run = Function('return (' + source + ')')(); parent.postMessage({ id, result: await run(versions) }, '*') }).toString() + ')(' + JSON.stringify({ versions, id, source: run.toString() }).replaceAll('<', '\u003c') + ')<' + '/script>'
      document.body.append(frame)
    })
    return [...top.map(result => ({ origin: location.origin, ...result })), ...opaque.map(result => ({ origin: 'opaque-null', ...result }))]
  }
  const evaluation = await client.send('Runtime.callFunctionOn', { executionContextId: context.id, functionDeclaration: inspect.toString(),
    arguments: [{ value: versions }], returnByValue: true, awaitPromise: true, userGesture: false })
  if (evaluation.exceptionDetails) throw new Error(evaluation.exceptionDetails.exception?.description ?? evaluation.exceptionDetails.text)
  report.results = evaluation.result.value
} catch (error) { report.errors.push(error.message.replace(/https?:\/\/[^\s"'<>]+/g, '[URL]').slice(0, 300)) }
finally { await browser?.close() }
report.conclusion = report.results.some(result => result.visitorPresent || result.coldConfigDataPresent || result.configDataPresent)
  ? 'A bootstrap contains readable session/configuration structure. No embedded player request, full audio or background playback was demonstrated by this probe.'
  : 'Neither tested Session bootstrap supplied browser-readable visitor/configuration material. No new direct-audio route established; no media or token transport attempted.'
const output = new URL('artifacts/pwa-port/p1-alternative-session-2026-10-23.json', base)
await mkdir(new URL('.', output), { recursive: true })
report.scriptSha256 = createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex')
await writeFile(output, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
if (report.errors.length) process.exitCode = 1
