// Tests offline media through a browser CacheStorage opaque response, without reading cross-origin bytes.
import { createRequire } from 'node:module'
import { constants } from 'node:fs'
import { readFile, mkdir, writeFile, mkdtemp, rm, copyFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve, sep, basename } from 'node:path'
import ts from 'typescript'
const puppeteer = createRequire(import.meta.url)('C:/Users/iunan/node_modules/puppeteer')
async function phase(name, work, ms = 15000) {
  console.log(JSON.stringify({ phase: name, state: 'start' }))
  let timer
  try {
    const result = await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Phase timeout: ' + name)), ms)
    })])
    console.log(JSON.stringify({ phase: name, state: 'passed' }))
    return result
  } finally { clearTimeout(timer) }
}
const source = ts.transpileModule(await readFile(new URL('../../web-port/youtube.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
}).outputText
const worker = `self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>{if(new URL(e.request.url).pathname==='/audio')e.respondWith(caches.open('pletina-opaque-probe').then(c=>c.match('/audio')).then(r=>r||new Response('Missing',{status:404})));});`
const server = createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Content-Type', request.url === '/sw.js' ? 'text/javascript' : 'text/html')
  response.end(request.url === '/sw.js' ? worker : '<!doctype html><meta charset="utf-8"><title>Opaque audio QA</title>')
})
let browser, profile
const report = { testedAt: new Date().toISOString(), scope: 'Ephemeral desktop browser CacheStorage probe, no production or physical-device claim', checks: [] }
try {
  await phase('server', () => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)), 5000)
  profile = await mkdtemp(join(tmpdir(), 'pletina-opaque-cache-'))
  browser = await phase('browser', () => puppeteer.launch({ headless: true, args: ['--mute-audio'], userDataDir: profile, timeout: 15000,
    executablePath: 'C:/Users/iunan/.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe' }), 20000)
  const page = await browser.newPage()
  page.setDefaultTimeout(12000)
  await phase('service-worker', async () => {
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 10000 })
    await page.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready })
    await page.waitForFunction(() => navigator.serviceWorker.controller, { timeout: 10000 })
  })
  report.browser = await browser.version()
  report.checks.push({ name: 'resolve direct Googlevideo source', ...await phase('resolve', () => page.evaluate(async (moduleCode) => {
      const youtube = await import(URL.createObjectURL(new Blob([moduleCode], { type: 'text/javascript' })))
      const stream = await youtube.stream('9RfVp-GhKfs')
      window.__opaqueSource = stream.url
      return { sourceResolved: true, contentLength: stream.contentLength ?? null }
  }, source), 35000) })
  const first = await phase('opaque-fetch-headers', () => page.evaluate(async () => {
      window.__opaqueAbort = new AbortController()
      window.__opaqueTimer = setTimeout(() => window.__opaqueAbort.abort(), 35000)
      window.__opaqueResponse = await fetch(window.__opaqueSource, { mode: 'no-cors', credentials: 'omit', signal: window.__opaqueAbort.signal })
      window.__opaqueSource = null
      return { responseType: window.__opaqueResponse.type }
  }), 15000)
  const stored = await phase('complete-cache-put', () => page.evaluate(async () => {
    try {
      const response = window.__opaqueResponse
      await (await caches.open('pletina-opaque-probe')).put('/audio', response)
      const audio = new Audio(); window.__opaqueAudio = audio
      audio.src = '/audio'
      return { cacheEntries: (await (await caches.open('pletina-opaque-probe')).keys()).length }
    } finally { clearTimeout(window.__opaqueTimer); window.__opaqueResponse = null }
  }), 35000)
  report.checks.push({ name: 'store the complete opaque media response', ...first, ...stored })
  if (!first.error) {
    await page.mouse.click(5, 5)
    await phase('play', async () => {
      await page.evaluate(() => window.__opaqueAudio.play())
      await page.waitForFunction(() => window.__opaqueAudio.currentTime > 1, { timeout: 12000 })
    })
    report.checks.push({ name: 'play through the stable same-origin cache route', ...await page.evaluate(() => ({ time: window.__opaqueAudio.currentTime, duration: window.__opaqueAudio.duration, error: window.__opaqueAudio.error?.code ?? null })) })
    await page.setOfflineMode(true)
    await phase('offline-reload-and-seek', async () => {
      await page.evaluate(() => { const audio = window.__opaqueAudio; audio.pause(); audio.removeAttribute('src'); audio.load(); audio.src = '/audio'; return audio.play() })
      await page.waitForFunction(() => window.__opaqueAudio.currentTime > 1, { timeout: 10000 })
      await page.evaluate(() => { window.__opaqueAudio.currentTime = window.__opaqueAudio.duration / 2 })
      await page.waitForFunction(() => window.__opaqueAudio.currentTime > window.__opaqueAudio.duration / 2 + 1, { timeout: 10000 })
    }, 25000)
    report.checks.push({ name: 'reload media and seek with browser offline', ...await page.evaluate(() => ({ time: window.__opaqueAudio.currentTime, duration: window.__opaqueAudio.duration, online: navigator.onLine, error: window.__opaqueAudio.error?.code ?? null })) })
  }
} catch (error) { report.error = error.name + ': ' + error.message.replace(/https?:\/\/[^\s]+/g, '[URL]') }
finally {
  await phase('browser-cleanup', async () => { if (browser) await browser.close() }, 5000).catch(() => { browser?.process()?.kill() })
  server.closeAllConnections()
  await phase('server-cleanup', () => new Promise((resolve) => server.close(resolve)), 2000).catch(() => {})
  if (profile) {
    const target = resolve(profile), parent = resolve(tmpdir()) + sep
    if (!target.startsWith(parent) || !basename(target).startsWith('pletina-opaque-cache-')) throw new Error('Profile cleanup outside its temporary directory.')
    await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  }
  report.cleanup = { serverClosed: !server.listening, profileRemoved: true }
}
const directory = new URL('../../artifacts/pwa-parity/', import.meta.url)
await mkdir(directory, { recursive: true })
await copyFile(new URL('opaque-audio-probe.json', directory), new URL('opaque-audio-probe-first-success.json', directory), constants.COPYFILE_EXCL).catch(() => {})
await writeFile(new URL('opaque-audio-probe.json', directory), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
if (report.error) process.exitCode = 1
