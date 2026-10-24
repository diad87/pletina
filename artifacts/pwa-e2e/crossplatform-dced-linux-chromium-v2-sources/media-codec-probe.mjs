// Separates host WebKit codec/gesture behavior from the compiled player's behavior.
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
if (process.platform === 'win32') process.env.PLAYWRIGHT_BROWSERS_PATH ||= 'D:/tmp/pletina-e2e-browsers'
const { webkit } = await import('playwright')
const bytes = await readFile(new URL('./fixtures/silence-12s.m4a', import.meta.url))
const proxyRequests = []
const server = createServer((request, response) => {
  if (request.url === '/sw.js') {
    response.writeHead(200, { 'content-type': 'text/javascript' })
    response.end("self.addEventListener('install',e=>e.waitUntil(caches.open('codec-probe').then(async c=>{await c.put('/cached-audio.m4a',await fetch('/audio.m4a'));await self.skipWaiting()})));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>{if(new URL(e.request.url).pathname==='/cached-audio.m4a')e.respondWith(caches.open('codec-probe').then(c=>c.match('/cached-audio.m4a')))});")
    return
  }
  if (request.url === '/cached-audio.m4a') { response.writeHead(404); response.end('SW-only fixture'); return }
  if (/^https?:/.test(request.url)) proxyRequests.push({ method: request.method, path: new URL(request.url).pathname })
  if (request.url.endsWith('/audio.m4a')) { response.writeHead(200, { 'content-type': 'audio/mp4', 'content-length': bytes.length, 'accept-ranges': 'bytes' }); response.end(bytes); return }
  response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><meta name="viewport" content="width=device-width"><button onclick="window.a.play().catch(e=>window.rejected={name:e.name,message:e.message})">Play</button>')
})
server.on('connect', (request, socket) => { proxyRequests.push({ method: 'CONNECT', host: request.url }); socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n') })
let browser
const report = { testedAt: new Date().toISOString(), host: { platform: process.platform, arch: process.arch },
  scope: 'WebKit host codec probe; bare HTMLAudio, no product or physical iPhone claim', cases: [] }
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  browser = await webkit.launch({ headless: true }); report.browser = browser.version()
  const cases = process.env.PLETINA_CODEC_PROBE_EXTENDED
    ? [[true, 'service-worker-remote', false], [true, 'service-worker-remote', true]]
    : [[false, false, false], [true, false, false], [true, true, false], [true, true, true], [true, 'proxy-http', false], [true, 'proxy-https', false], [true, 'service-worker', false]]
  for (const [mobile, remote, clock] of cases) {
    const result = { mobile, interceptedCrossOrigin: remote, browserClock: clock, routeHits: [], network: [] }; report.cases.push(result)
    const proxyMark = proxyRequests.length
    const context = await browser.newContext({ ...(typeof remote === 'string' && remote.startsWith('proxy-') ? { proxy: { server: `http://127.0.0.1:${server.address().port}` } } : {}), ...(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' } : {}) })
    try {
      if (remote === true || remote === 'service-worker-remote') await context.route('https://fixture.googlevideo.com/**', route => {
        result.routeHits.push({ type: route.request().resourceType(), range: route.request().headers().range ?? null })
        return route.fulfill({ status: 200, contentType: 'audio/mp4', headers: { 'access-control-allow-origin': '*', 'content-length': String(bytes.length), 'accept-ranges': 'bytes' }, body: bytes })
      })
      const page = await context.newPage()
      page.on('response', response => { if (response.request().resourceType() === 'media') result.network.push({ type: 'response', status: response.status() }) })
      page.on('requestfailed', request => { if (request.resourceType() === 'media') result.network.push({ type: 'failure', error: request.failure()?.errorText }) })
      if (clock) await page.clock.install()
      await page.goto(`http://127.0.0.1:${server.address().port}/`)
      if (remote === 'service-worker' || remote === 'service-worker-remote') {
        await page.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready })
        await page.waitForFunction(() => navigator.serviceWorker.controller)
        result.serviceWorkerControlsPage = true
      }
      await page.evaluate(url => { window.a = new Audio(); window.a.preload = 'auto'; window.a.src = url; window.a.load(); window.rejected = null },
        remote === 'service-worker' ? '/cached-audio.m4a' : remote === 'proxy-http' ? 'http://fixture.googlevideo.com/audio.m4a' : remote ? 'https://fixture.googlevideo.com/audio.m4a' : '/audio.m4a')
      await page.locator('button').click()
      await page.waitForFunction(() => window.a.currentTime > 0.2 || window.a.error || window.rejected, null, { timeout: 5000 }).catch(() => {})
      Object.assign(result, await page.evaluate(() => ({ time: window.a.currentTime, duration: Number.isFinite(window.a.duration) ? window.a.duration : null,
        paused: window.a.paused, readyState: window.a.readyState, error: window.a.error ? { code: window.a.error.code, message: window.a.error.message } : null,
        rejected: window.rejected, canAAC: window.a.canPlayType('audio/mp4; codecs="mp4a.40.2"') })))
      result.passed = result.time > 0.2 && !result.error && !result.rejected
      result.proxyRequests = proxyRequests.slice(proxyMark)
    } catch (error) { result.error = { name: error.name, message: String(error.message).replace(/https?:\/\/[^\s]+/g, '[URL]') } }
    finally { await context.close() }
  }
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  const directory = new URL('../../../artifacts/pwa-e2e/', import.meta.url); await mkdir(directory, { recursive: true })
  const file = process.env.PLETINA_CODEC_PROBE_EXTENDED ? 'webkit-aac-controlled-probe-' + process.platform + '.json'
    : process.platform === 'win32' ? 'webkit-aac-probe.json' : 'webkit-aac-probe-' + process.platform + '.json'
  await writeFile(new URL(file, directory), JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify(report, null, 2))
