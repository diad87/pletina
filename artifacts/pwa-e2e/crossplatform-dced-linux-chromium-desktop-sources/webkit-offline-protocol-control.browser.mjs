// Independent host diagnostic: production SW, seeded known AAC, and a native
// HTMLAudio element on a QA document. No Pletina player/module is imported or
// replaced. Fixture seeding is explicit; this is not a physical-phone test.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createPwaServer } from '../../preview-pwa.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const root = fileURLToPath(new URL('../../../', import.meta.url))
const dist = resolve(option('--dist', join(root, 'dist-pwa')))
const output = resolve(option('--output', join(root, 'artifacts/pwa-e2e/webkit-offline-protocol-control.json')))
const worker = await readFile(join(dist, 'sw.js'))
const build = String(worker).match(/const VERSION = "([a-f0-9]{16})"/)?.[1]
assert.ok(build)
if (option('--browsers', null)) process.env.PLAYWRIGHT_BROWSERS_PATH = option('--browsers')
const engine = option('--engine', 'webkit')
assert.ok(['webkit', 'firefox'].includes(engine))
const playwright = await import('playwright')
const aac = await readFile(new URL('./fixtures/silence-12s.m4a', import.meta.url))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const report = { build, engine, startedAt: new Date().toISOString(), host: { platform: process.platform, node: process.version },
  scope: 'Standalone native HTMLAudio on an explicit QA document; unmodified production SW plus seeded basic/opaque AAC caches. Desktop ' + engine + ' host diagnostic, not Pletina feature or physical mobile validation.',
  fixture: { bytes: aac.length, sha256: digest(aac), mime: 'audio/mp4', duration: 12 },
  workerSha256: digest(worker), browserSecurityOverrides: false, cases: [], errors: [] }
let browser, context, page, originAvailable = true
const document = `<!doctype html><meta name="viewport" content="width=device-width"><title>Native cached audio control</title>
<h1>Native cached audio control</h1><button id="play">Play cached AAC</button><audio id="audio" controls></audio><output id="state"></output>
<script>
const audio = document.querySelector('#audio');
window.control = { id: 101, events: [], settled: null };
for (const type of ['loadstart','loadedmetadata','playing','timeupdate','pause','error','ended']) audio.addEventListener(type, () => {
  control.events.push({type,time:Number.isFinite(audio.currentTime)?audio.currentTime:null,error:audio.error?.code??null});
  document.querySelector('#state').textContent=type;
});
document.querySelector('#play').onclick=()=>{
  control.events=[];control.settled=null;audio.pause();audio.removeAttribute('src');audio.load();
  audio.src='/pletina/__audio__/'+control.id;audio.load();
  audio.play().then(()=>control.settled='fulfilled',error=>control.settled=error.name);
};
</script>`
const distribution = createPwaServer({ directory: dist })
const media = createServer((_request, response) => {
  if (!originAvailable) { response.destroy(); return }
  response.writeHead(200, { 'content-type': 'audio/mp4', 'content-length': aac.length, 'cache-control': 'no-store' }); response.end(aac)
})
const server = createServer((request, response) => {
  if (!originAvailable) { response.destroy(); return }
  if (new URL(request.url, 'http://localhost').pathname === '/pletina/qa-native-offline-control.html') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); response.end(document); return
  }
  distribution.emit('request', request, response)
})
const listen = target => new Promise((resolve, reject) => { target.once('error', reject); target.listen(0, '127.0.0.1', resolve) })
try {
  await listen(server); await listen(media)
  browser = await playwright[engine].launch({ headless: true })
  context = await browser.newContext({ serviceWorkers: 'allow' }); page = await context.newPage()
  page.on('pageerror', error => report.errors.push({ name: error.name, message: String(error.message).replace(/https?:\/\/[^\s]+/g, '[URL]') }))
  const base = 'http://127.0.0.1:' + server.address().port + '/pletina/'
  const nativeRequests = [], requestRows = new Map()
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.origin === new URL(base).origin || request.resourceType() !== 'media') return
    const row = { path: url.pathname, type: request.resourceType(), failed: null, responseStatus: null, fromServiceWorker: null }
    requestRows.set(request, row); nativeRequests.push(row)
  })
  page.on('requestfailed', request => { const row = requestRows.get(request); if (row) row.failed = request.failure()?.errorText ?? 'failed' })
  page.on('response', response => { const row = requestRows.get(response.request()); if (row) { row.responseStatus = response.status(); row.fromServiceWorker = response.fromServiceWorker() } })
  await page.goto(base + 'qa-native-offline-control.html')
  await page.evaluate(async () => { await navigator.serviceWorker.register('/pletina/sw.js', { scope: '/pletina/' }); await navigator.serviceWorker.ready })
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
  const seeded = await page.evaluate(async ({ mediaURL, bytes }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('pletina-web-downloads', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('files', { keyPath: 'id' })
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })
    try {
      const cache = await caches.open('pletina-audio-downloads:v1'), results = []
      for (const [id, opaque] of [[101, false], [102, true]]) {
        const key = new URL('__audio__/' + id + '?stage=' + Date.now() + '-' + crypto.randomUUID(), location.href).href
        const response = opaque ? await fetch(mediaURL, { mode: 'no-cors', credentials: 'omit' })
          : new Response(new Uint8Array(bytes), { headers: { 'content-type': 'audio/mp4', 'content-length': String(bytes.length) } })
        results.push({ id, type: response.type })
        await cache.put(key, response)
        await new Promise((resolve, reject) => {
          const tx = db.transaction('files', 'readwrite')
          tx.objectStore('files').put({ id, cacheKey: key })
          tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error)
        })
      }
      return results
    } finally { db.close() }
  }, { mediaURL: 'http://127.0.0.1:' + media.address().port + '/silence.m4a', bytes: [...aac] })
  assert.deepEqual(seeded.map(row => row.type), ['default', 'opaque'])
  report.seeded = seeded
  const sample = async (mode, id) => {
    const requestMark = nativeRequests.length
    const fetchResult = await page.evaluate(async id => {
      try { const result = await fetch('/pletina/__audio__/' + id); return { fulfilled: true, status: result.status, type: result.type } }
      catch (error) { return { fulfilled: false, name: error.name } }
    }, id)
    await page.evaluate(id => { window.control.id = id }, id)
    await page.locator('#play').click()
    await page.waitForFunction(() => { const a = document.querySelector('#audio'); return a.error || !a.paused && a.currentTime > .25 || control.settled && control.settled !== 'fulfilled' }, null, { timeout: 5000 }).catch(() => {})
    const value = await page.evaluate(() => {
      const a = document.querySelector('#audio')
      return { online: navigator.onLine, sourceLocal: new URL(a.src).origin === location.origin,
        advanced: !a.paused && a.currentTime > .25, time: a.currentTime,
        duration: Number.isFinite(a.duration) ? a.duration : null, error: a.error?.code ?? null,
        settled: control.settled, events: control.events.slice(-12) }
    })
    await page.evaluate(() => { const a = document.querySelector('#audio'); a.pause(); a.removeAttribute('src'); a.load() })
    report.cases.push({ mode, cacheType: id === 101 ? 'basic-readable' : 'opaque', fetch: fetchResult, audio: value,
      externalNativeMediaRequests: nativeRequests.slice(requestMark) })
  }
  await sample('online', 101); await sample('online', 102)
  await context.setOffline(true)
  await sample('protocol-offline', 101); await sample('protocol-offline', 102)
  await context.setOffline(false)
  await sample('online-restored', 101); await sample('online-restored', 102)
  originAvailable = false
  await sample('origin-network-unavailable', 101); await sample('origin-network-unavailable', 102)
  const cases = mode => report.cases.filter(row => row.mode === mode)
  report.hostProtocolLimitConfirmed = cases('online').every(row => row.audio.advanced) &&
    cases('online-restored').every(row => row.audio.advanced) && cases('origin-network-unavailable').every(row => row.audio.advanced) &&
    cases('protocol-offline').every(row => row.audio.online === false && !row.audio.advanced && row.audio.error)
  report.browserVersion = browser.version()
  report.workerUnchanged = digest(await readFile(join(dist, 'sw.js'))) === report.workerSha256
} finally {
  originAvailable = true
  await context?.close(); report.contextClosed = true
  await browser?.close(); report.browserClosed = true
  await Promise.all([server, media].map(target => new Promise(resolve => { target.closeAllConnections(); target.close(resolve) })))
  report.serversClosed = true; report.completedAt = new Date().toISOString()
  await mkdir(resolve(output, '..'), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify({ build, output, hostProtocolLimitConfirmed: report.hostProtocolLimitConfirmed,
  cases: report.cases.map(row => ({ mode: row.mode, cacheType: row.cacheType, fetch: row.fetch, advanced: row.audio.advanced, error: row.audio.error })), errors: report.errors.length }))
