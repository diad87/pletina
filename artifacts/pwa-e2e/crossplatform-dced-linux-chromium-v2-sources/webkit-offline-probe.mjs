// Host-only diagnosis: a minimal cached navigation, without any product code.
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
if (process.platform === 'win32') process.env.PLAYWRIGHT_BROWSERS_PATH ||= 'D:/tmp/pletina-e2e-browsers'
const { webkit } = await import('playwright')
const requests = []
const server = createServer((request, response) => {
  requests.push(request.url)
  if (request.url === '/sw.js') {
    response.writeHead(200, { 'content-type': 'text/javascript' })
    response.end("self.addEventListener('install',e=>e.waitUntil(caches.open('offline-probe').then(async c=>{await c.add('/');await self.skipWaiting()})));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>{if(new URL(e.request.url).pathname==='/')e.respondWith(caches.open('offline-probe').then(c=>c.match('/')))});")
    return
  }
  response.writeHead(200, { 'content-type': 'text/html' })
  response.end('<!doctype html><h1>Cached navigation probe</h1>')
})
const report = { host: { platform: process.platform, arch: process.arch }, at: new Date().toISOString(), scope: 'Bare WebKit navigation/SW automation probe; no product or physical iPhone claim', cases: [] }
let browser
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  browser = await webkit.launch({ headless: true }); report.browser = browser.version()
  for (const intercepted of [false, true]) {
    const result = { intercepted }; report.cases.push(result)
    const context = await browser.newContext({ serviceWorkers: 'allow' })
    try {
      if (intercepted) await context.route('**/*', route => route.continue())
      const page = await context.newPage()
      await page.goto(`http://127.0.0.1:${server.address().port}/`)
      await page.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready })
      await page.waitForFunction(() => navigator.serviceWorker.controller)
      result.before = await page.evaluate(async () => ({ controlled: Boolean(navigator.serviceWorker.controller), cached: Boolean(await caches.match('/')) }))
      const mark = requests.length
      await context.setOffline(true)
      result.onlineAfterSetOffline = await page.evaluate(() => navigator.onLine)
      try { result.fetchCachedWhileOffline = await page.evaluate(async () => (await fetch('/')).status) }
      catch (error) { result.fetchError = { name: error.name, message: String(error.message).replace(/https?:\/\/[^\s]+/g, '[URL]') } }
      try {
        await page.reload({ waitUntil: 'load', timeout: 10000 })
        result.reload = await page.locator('h1').textContent()
      } catch (error) { result.reloadError = { name: error.name, message: String(error.message).replace(/https?:\/\/[^\s]+/g, '[URL]') } }
      result.networkRequestsWhileOffline = requests.slice(mark)
    } finally { await context.setOffline(false); await context.close() }
  }
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  const directory = new URL('../../../artifacts/pwa-e2e/', import.meta.url); await mkdir(directory, { recursive: true })
  await writeFile(new URL('webkit-offline-probe-' + process.platform + '.json', directory), JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify(report, null, 2))
