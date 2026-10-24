// Native browser control: no Pletina product code or storage is loaded.
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
const html = '<!doctype html><title>native offline SW control</title><script>navigator.serviceWorker.register("/sw.js")</script>'
const worker = `self.addEventListener('install',e=>e.waitUntil(caches.open('control').then(c=>c.put('/',new Response(${JSON.stringify(html)},{headers:{'content-type':'text/html'}})))));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>{if(e.request.mode==='navigate')e.respondWith(caches.open('control').then(c=>c.match('/')));});`
const server = createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Content-Type', request.url === '/sw.js' ? 'text/javascript' : 'text/html')
  response.end(request.url === '/sw.js' ? worker : html)
})
const report = { testedAt: new Date().toISOString(), scope: 'Native Chromium, minimal caching service worker and Playwright offline emulation. No Pletina product code, provider, physical device or song playback.', states: [] }
let browser
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  browser = await chromium.launch({ headless: true, executablePath: 'C:/Users/iunan/.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe' })
  report.browser = browser.version()
  const context = await browser.newContext({ serviceWorkers: 'allow' })
  await context.route('**/*', route => route.continue())
  const page = await context.newPage()
  await page.goto('http://127.0.0.1:' + server.address().port)
  await page.waitForFunction(() => navigator.serviceWorker.controller)
  const snapshot = async phase => ({ phase, ...await page.evaluate(() => ({ online: navigator.onLine, controlled: Boolean(navigator.serviceWorker.controller), title: document.title })) })
  report.states.push(await snapshot('controlled-before'))
  await context.setOffline(true)
  report.states.push(await snapshot('controlled-offline'))
  await page.reload({ waitUntil: 'load' })
  report.states.push(await snapshot('controlled-cached-reload'))
  report.networkProbe = await page.evaluate(async () => {
    try { const response = await fetch('/uncached-network-probe', { cache: 'no-store' }); return { delivered: true, status: response.status } }
    catch (error) { return { delivered: false, error: error.name } }
  })
  report.reproducedNavigatorOfflineReset = report.states[1].online === false && report.states[2].online === true && report.networkProbe.delivered === false
} catch (error) { report.failure = { name: error.name, message: error.message }; process.exitCode = 1 }
finally {
  await browser?.close()
  report.browserClosed = !browser || !browser.isConnected()
  await new Promise(resolve => server.close(resolve))
  report.serverClosed = !server.listening
  await writeFile(new URL('./offline-covers-chrome148-sw-offline-control.json', import.meta.url), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
}
