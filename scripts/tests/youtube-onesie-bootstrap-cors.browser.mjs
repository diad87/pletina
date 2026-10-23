// Read-only Onesie prerequisite check. No keys are extracted/persisted and no
// encryption, Onesie playback, protected-auth assertion or media request is made.
import { mkdir, writeFile } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'

const report = { testedAt: new Date().toISOString(), scope: 'Normal Pages-origin and opaque-frame GET of the public TV configuration used by the current GoogleVideo Onesie example.',
  source: 'https://raw.githubusercontent.com/LuanRT/googlevideo/main/examples/onesie-request/main.ts',
  hypothesis: 'A distinct public bootstrap could expose the provider-issued Onesie transport configuration without a proxy. Test CORS before considering implementation.',
  results: [], transport: [], errors: [], productChanged: false, mediaRequested: false, keysExtracted: false, credentialsOrTokensUsed: false, remoteProviderJavascriptExecuted: false,
  browserSecurityOverrides: false, observerUserGesture: false, outputMuted: false, protectedAuthenticationOrDrmAttempted: false }
let browser
try {
  browser = await puppeteer.launch({ executablePath: 'C:/Users/iunan/.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe', headless: true,
    ignoreDefaultArgs: ['--mute-audio', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], args: [] })
  const page = await browser.newPage(), client = page.mainFrame().client, requests = new Set()
  await client.send('Network.enable')
  client.on('Network.requestWillBeSent', event => { const url = new URL(event.request.url); if (url.hostname === 'www.youtube.com' && url.pathname === '/tv_config') requests.add(event.requestId) })
  client.on('Network.responseReceivedExtraInfo', event => { if (requests.has(event.requestId)) report.transport.push({ kind: 'http-status', status: event.statusCode }) })
  client.on('Network.loadingFailed', event => { if (requests.has(event.requestId)) report.transport.push({ kind: 'failed', error: event.errorText, corsErrorStatus: event.corsErrorStatus ?? null }) })
  await page.goto('https://diad87.github.io/pletina/', { waitUntil: 'domcontentloaded', timeout: 45000 })
  const context = page.mainFrame().mainRealm().context
  const inspect = async () => {
    const url = 'https://www.youtube.com/tv_config?action_get_config=true&client=lb4&theme=cl'
    const probe = async url => {
      try {
        const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(10000) })
        if (!response.ok || !response.body) { await response.body?.cancel(); return { readable: false, status: response.status } }
        // Never return content, key values or token fields. Only accessibility and shape.
        const text = await response.text()
        return { readable: true, status: response.status, contentType: response.headers.get('content-type'), textBytes: text.length, tvConfigPrefix: text.startsWith(')]}'), onesieConfigMarkerPresent: text.includes('onesieHotConfig') }
      } catch (error) { return { readable: false, error: error.name, message: error.message } }
    }
    const top = await probe(url)
    const opaque = await new Promise(resolve => {
      const frame = document.createElement('iframe'), id = crypto.randomUUID()
      frame.sandbox = 'allow-scripts'; frame.hidden = true
      const finish = result => { clearTimeout(timer); window.removeEventListener('message', receive); frame.remove(); resolve(result) }
      const receive = event => { if (event.source === frame.contentWindow && event.origin === 'null' && event.data?.id === id) finish(event.data.result) }
      const timer = setTimeout(() => finish({ readable: false, error: 'timeout' }), 13000)
      window.addEventListener('message', receive)
      frame.srcdoc = '<script>(' + (async ({ url, id, probeSource }) => { const probe = Function('return (' + probeSource + ')')(); parent.postMessage({ id, result: await probe(url) }, '*') }).toString() + ')(' + JSON.stringify({ url, id, probeSource: probe.toString() }).replaceAll('<', '\\u003c') + ')<' + '/script>'
      document.body.append(frame)
    })
    return [{ origin: location.origin, ...top }, { origin: 'opaque-null', ...opaque }]
  }
  const result = await client.send('Runtime.callFunctionOn', { executionContextId: context.id, functionDeclaration: inspect.toString(), returnByValue: true, awaitPromise: true, userGesture: false })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  report.results = result.result.value
} catch (error) { report.errors.push(String(error.message).replace(/https?:\/\/[^\s"'<>]+/g, '[URL]').slice(0, 300)) }
finally { await browser?.close() }
report.conclusion = report.results.some(result => result.readable && result.onesieConfigMarkerPresent)
  ? 'A configuration marker is readable, but no keys, Onesie request, complete audio or background playback has been tested.'
  : 'The tested bootstrap is not readable from the normal PWA or opaque frame; stopped before configuration keys, transport encryption or Onesie playback. No generic audio solution established.'
const directory = new URL('../../artifacts/pwa-port/', import.meta.url)
await mkdir(directory, { recursive: true })
await writeFile(new URL('youtube-onesie-bootstrap-cors-2026-10-23.json', directory), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
if (report.errors.length) process.exitCode = 1
