// Compiled UI + real checked provider bytes; no module injection, provider mocks,
// Audio replacement, account, Node bootstrap or product method calls.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
import { createPwaServer } from '../preview-pwa.mjs'

const args = process.argv.slice(2), option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const build = option('--expected-build', ''), reportName = option('--report', `verified-download-${build}-local.json`)
assert.match(build, /^[a-f0-9]{16}$/); assert.match(reportName, /^verified-download-[a-z0-9.-]+\.json$/)
const wanted = { query: option('--query', 'Pirritx eta Porrotx Iritsi da Eguna'), title: option('--title', 'Iritsi da Eguna'),
  artist: option('--artist', 'Pirritx eta Porrotx'), album: option('--album', 'Eskerrik Asko!'), catalogId: Number(option('--catalog-id', '3250715431')),
  bytes: Number(option('--expected-bytes', '4633634')), sha256: option('--expected-sha', '35d6526ad255d903c0a2bfced09a7b3854f5ab6ff3404d37f19be4786564724f'),
  duration: Number(option('--expected-duration', '187.1684126984127')), startAt: Number(option('--expected-start', '8.94')) }
assert.ok(Number.isSafeInteger(wanted.catalogId) && wanted.catalogId > 0 && Number.isSafeInteger(wanted.bytes) && wanted.bytes > 0 && wanted.bytes <= 32 * 1024 ** 2)
assert.match(wanted.sha256, /^[a-f0-9]{64}$/); assert.ok(wanted.duration > 0 && wanted.startAt >= 0 && wanted.startAt < wanted.duration)
const source = await readFile(new URL(import.meta.url)), sha = value => crypto.createHash('sha256').update(value).digest('hex')
const directory = new URL('../../artifacts/pwa-port/', import.meta.url), sourceSnapshot = `verified-download-live-source-${sha(source).slice(0, 16)}.mjs`
const report = { schemaVersion: 1, build, testedAt: new Date().toISOString(), wanted, runnerSha256: sha(source),
  sourceSnapshot: 'artifacts/pwa-port/' + sourceSnapshot, checks: [], errors: [], inputActions: [], localRequests: [],
  scope: 'Compiled PWA real provider download, complete cached bytes/hash/decode, offline reload and trusted native playback/seek. Desktop Chrome foreground only.',
  policy: { providerMocks: false, nodeBootstrap: false, productMethodsCalled: false, audioConstructorReplaced: false,
    securityOverrides: false, autoplayOverrides: false, rawMediaUrlsSaved: false, mediaBytesSaved: false, physicalPhone: false, backgroundVerified: false },
  observationRpcCalls: 0, observationRpcWithGesture: 0 }
const scrub = value => String(value ?? '').replace(/https?:\/\/[^\s"'<>]+/g, '[URL]').replace(/blob:[^\s"'<>]+/g, '[BLOB]').slice(0, 350)
const normalize = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let browser, context, page, server
async function observe(fn, arg = null) {
  report.observationRpcCalls++
  const result = await page.mainFrame().client.send('Runtime.callFunctionOn', { executionContextId: page.mainFrame().mainRealm().context.id,
    functionDeclaration: fn.toString(), arguments: [{ value: arg }], returnByValue: true, awaitPromise: true, userGesture: false })
  if (result.exceptionDetails) throw Error(scrub(result.exceptionDetails.exception?.description || result.exceptionDetails.text))
  return result.result.value
}
async function poll(name, fn, maximum = 25000) {
  const end = Date.now() + maximum; let last
  do { const value = await fn(); if (value) return value; last = value; await delay(200) } while (Date.now() < end)
  throw Error(name + ' timed out' + (last ? ': ' + scrub(JSON.stringify(last)) : ''))
}
async function click(selector, purpose, fraction = null) {
  await observe(selector => document.querySelector(selector)?.scrollIntoView({ block: 'center', behavior: 'instant' }), selector)
  const point = await observe(({ selector, fraction }) => {
    const node = document.querySelector(selector); if (!node) return null
    const r = node.getBoundingClientRect(), x = r.x + r.width * (fraction ?? .5), y = r.y + r.height / 2, hit = document.elementFromPoint(x, y)
    return r.width > 0 && r.height > 0 && hit && (hit === node || node.contains(hit)) ? { x, y } : null
  }, { selector, fraction })
  assert.ok(point, 'Visible control: ' + purpose)
  report.inputActions.push({ kind: 'trusted mouse click', purpose, ...(fraction === null ? {} : { fraction }) })
  await page.mouse.click(point.x, point.y)
}
async function clickText(selector, text, purpose) {
  const point = await observe(({ selector, text }) => {
    const node = [...document.querySelectorAll(selector)].find(node => (node.querySelector('.title')?.textContent || node.textContent).trim() === text)
    if (!node) return null
    node.scrollIntoView({ block: 'center', behavior: 'instant' })
    const r = node.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2, hit = document.elementFromPoint(x, y)
    return r.width > 0 && r.height > 0 && hit && (hit === node || node.contains(hit)) ? { x, y } : null
  }, { selector, text })
  assert.ok(point, 'Visible text control: ' + text)
  report.inputActions.push({ kind: 'trusted mouse click', purpose }); await page.mouse.click(point.x, point.y)
}
const playback = () => observe(() => {
  const slider = document.querySelector('.player input[aria-label="Posición"]')
  return { online: navigator.onLine, title: navigator.mediaSession?.metadata?.title ?? null,
    state: navigator.mediaSession?.playbackState ?? null, time: slider ? Number(slider.value) : null, duration: slider ? Number(slider.max) : null,
    videoModal: Boolean(document.querySelector('dialog[data-official-youtube][open]')), iframeCount: document.querySelectorAll('iframe').length }
})
async function downloadsView() {
  await clickText('.sidebar .library button.item', 'Descargas', 'open real Downloads view')
  await poll('Downloads heading', () => observe(() => document.querySelector('.page-title')?.textContent.trim() === 'Descargas'))
}
async function cachedFile() {
  return observe(async id => {
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('pletina-web-downloads'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(Error('Download database unavailable')) })
    try {
      const saved = await new Promise((resolve, reject) => { const request = db.transaction('files').objectStore('files').get(id); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(Error('Download row unavailable')) })
      if (!saved) return null
      const cache = await caches.open('pletina-audio-downloads:v1'), response = await cache.match(saved.cacheKey)
      if (!response || response.type === 'opaque') throw Error('Cached complete file is not readable')
      const bytes = await response.arrayBuffer(), hash = await crypto.subtle.digest('SHA-256', bytes)
      const decoder = new AudioContext(); let decoded
      try { const file = await decoder.decodeAudioData(bytes.slice(0)); decoded = { duration: file.duration, channels: file.numberOfChannels, sampleRate: file.sampleRate } }
      finally { await decoder.close() }
      return { id: saved.id, title: saved.track.title, provider: saved.source?.provider ?? null, sourceId: saved.source?.id ?? null,
        size: saved.size, byteLength: bytes.byteLength, sha256: [...new Uint8Array(hash)].map(n => n.toString(16).padStart(2, '0')).join(''),
        status: response.status, contentType: response.headers.get('content-type'), decoded, startAt: saved.source?.startAt ?? 0,
        fileDuration: saved.source?.download?.duration ?? null, expectedSha256: saved.source?.download?.sha256 ?? null,
        internalPointer: new URL(saved.cacheKey).origin === location.origin && new URL(saved.cacheKey).pathname.endsWith('/__audio__/' + id),
        storedTemporaryUrl: /blob:|googlevideo|[?&](?:sig|signature|expire)=/i.test(JSON.stringify(saved)) }
    } finally { db.close() }
  }, wanted.catalogId)
}
try {
  let target = option('--url', 'https://diad87.github.io/pletina/')
  if (args.includes('--local')) {
    assert.ok(!args.includes('--url')); server = createPwaServer()
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    target = `http://127.0.0.1:${server.address().port}/pletina/`
  }
  const url = new URL(target); assert.ok(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
  report.originKind = server ? 'ephemeral static QA serving unmodified dist-pwa' : 'supplied HTTPS'
  browser = await puppeteer.launch({ headless: true, executablePath: option('--chrome', 'C:/Users/iunan/.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe'),
    ignoreDefaultArgs: ['--mute-audio', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], args: [] })
  assert.ok(!browser.process().spawnargs.some(value => /autoplay-policy|disable-web-security|ignore-certificate-errors|--mute-audio/.test(value)))
  context = await browser.createBrowserContext(); page = await context.newPage(); await page.setViewport({ width: 1280, height: 1000 })
  report.browser = await browser.version()
  page.on('pageerror', error => report.errors.push({ category: 'page', message: scrub(error.message) }))
  const cdp = page.mainFrame().client; await cdp.send('Network.enable')
  cdp.on('Network.requestWillBeSent', event => { let u; try { u = new URL(event.request.url) } catch { return }
    if (u.origin === url.origin && u.pathname.endsWith('/__audio__/' + wanted.catalogId)) report.localRequests.push({ path: '/__audio__/' + wanted.catalogId, type: event.type, method: event.request.method }) })
  await page.goto(target, { waitUntil: 'load', timeout: 30000 })
  const actual = await observe(() => document.querySelector('#version')?.textContent.trim() ?? '')
  assert.ok(actual.includes(build), 'Expected compiled installation shell build')
  await poll('Shell service worker control', () => observe(() => Boolean(navigator.serviceWorker.controller)))
  await click('#open-player', 'open compiled Pletina')
  await poll('Application search', () => observe(() => Boolean(document.querySelector('.topbar input'))))
  await observe(() => { window.__verifiedDownloadQA = []; window.addEventListener('pletina:download', ({ detail }) => window.__verifiedDownloadQA.push({ trackId: detail.trackId, state: detail.state, progress: detail.progress, error: detail.error ? String(detail.error).replace(/https?:\/\/[^\s]+/g, '[URL]') : null })) })
  await click('.topbar input', 'focus normal music search'); await page.keyboard.type(wanted.query)
  report.inputActions.push({ kind: 'trusted keyboard typing', characters: wanted.query.length })
  const selected = await poll('Exact canonical recording row', async () => {
    const rows = await observe(() => [...document.querySelectorAll('.tracks li[data-reorder-index]')].map(row => ({ index: row.dataset.reorderIndex,
      title: row.querySelector('.name')?.textContent.trim() ?? '', text: row.textContent, artist: row.querySelector('.by')?.textContent.trim() ?? '' })))
    return rows.find(row => normalize(row.title) === normalize(wanted.title) && normalize(row.text).includes(normalize(wanted.artist)) && normalize(row.text).includes(normalize(wanted.album)))
  })
  report.selectedRow = { index: selected.index, title: selected.title, artist: selected.artist }
  const row = `.tracks li[data-reorder-index="${selected.index}"]`
  await click(row + ' button.more', 'open selected song menu'); await clickText('[role="menuitem"]', 'Descargar', 'download exact selected recording')
  const terminal = await poll('Committed checked download', () => observe(id => window.__verifiedDownloadQA.findLast(event => event.trackId === id && ['done', 'error', 'cancelled'].includes(event.state)) ?? null, wanted.catalogId), 125000)
  report.downloadEvents = await observe(() => window.__verifiedDownloadQA)
  assert.equal(terminal.state, 'done', terminal.error ?? terminal.state)
  const onlineFile = await cachedFile(); assert.ok(onlineFile)
  assert.equal(onlineFile.id, wanted.catalogId); assert.equal(onlineFile.size, wanted.bytes); assert.equal(onlineFile.byteLength, wanted.bytes)
  assert.equal(onlineFile.sha256, wanted.sha256); assert.equal(onlineFile.expectedSha256, wanted.sha256)
  assert.equal(onlineFile.startAt, wanted.startAt); assert.ok(Math.abs(onlineFile.decoded.duration - wanted.duration) < .1)
  assert.equal(onlineFile.internalPointer, true); assert.equal(onlineFile.storedTemporaryUrl, false)
  report.checks.push({ name: 'real checked provider file commits complete hash-bound bytes with stable metadata and offset', pass: true, file: onlineFile })
  await downloadsView(); await poll('Downloaded song row', () => observe(title => [...document.querySelectorAll('.tracks .name')].some(n => n.textContent.trim() === title), wanted.title))
  await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 })
  await page.reload({ waitUntil: 'load', timeout: 30000 })
  await poll('Offline application reload', () => observe(() => Boolean(document.querySelector('.sidebar')) && !navigator.onLine))
  await downloadsView()
  const offlineFile = await cachedFile(); assert.equal(offlineFile.sha256, wanted.sha256); assert.equal(offlineFile.byteLength, wanted.bytes)
  const index = await observe(title => [...document.querySelectorAll('.tracks li[data-reorder-index]')].find(row => row.querySelector('.name')?.textContent.trim() === title)?.dataset.reorderIndex ?? null, wanted.title)
  assert.notEqual(index, null)
  await click(`.tracks li[data-reorder-index="${index}"] .name`, 'single offline downloaded song title click')
  const initial = await poll('Offline native progress with preserved source offset', async () => { const p = await playback(); return p.state === 'playing' && p.time > wanted.startAt + 1 ? p : null })
  assert.equal(initial.title, wanted.title); assert.equal(initial.online, false); assert.equal(initial.videoModal, false); assert.equal(initial.iframeCount, 0)
  assert.ok(initial.time >= wanted.startAt && Math.abs(initial.duration - wanted.duration) < 1)
  await click('.player input[aria-label="Posición"]', 'trusted seek to eighty percent of downloaded file', .8)
  const afterSeek = await poll('Offline seek and further native progress', async () => { const p = await playback(); return p.state === 'playing' && p.time > wanted.duration * .78 + 1 ? p : null })
  assert.equal(afterSeek.title, wanted.title); assert.equal(afterSeek.videoModal, false)
  assert.ok(report.localRequests.some(request => request.type === 'Media'), 'Offline playback must request the internal cached media route')
  report.checks.push({ name: 'offline reload preserves full file, source offset, native title and working seek without provider access', pass: true, initial, afterSeek, file: offlineFile })
  report.screenshot = reportName.replace(/\.json$/, '.png'); await page.screenshot({ path: fileURLToPath(new URL(report.screenshot, directory)), fullPage: true })
  await click('.player .play', 'pause after offline observation')
} catch (error) {
  report.errors.push({ category: 'runner', message: scrub(error.message) })
  if (page) report.lastPlayback = await playback().catch(() => null)
} finally {
  await context?.close(); await browser?.close(); if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
  report.resourcesClosed = true
}
await mkdir(directory, { recursive: true }); await writeFile(new URL(sourceSnapshot, directory), source)
await writeFile(new URL(reportName, directory), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ report: reportName, build, passed: report.checks.filter(c => c.pass).length, errors: report.errors }))
if (report.errors.length || report.checks.length !== 2 || report.checks.some(c => !c.pass)) process.exitCode = 1
