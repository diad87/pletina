// Full compiled PWA, production SW/IDB/cache and actual mobile-layout user actions.
// No product test hooks; the Audio observer never exports media addresses.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve, sep, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { createPwaServer } from '../preview-pwa.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const puppeteer = createRequire(import.meta.url)(option('--puppeteer', 'C:/Users/iunan/node_modules/puppeteer'))
const chrome = option('--chrome', 'C:/Users/iunan/.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe')
const query = option('--query', 'A solas con un ritmo lirico de violadores del verso')
const reportName = option('--report', 'downloads-browser.json')
assert.match(reportName, /^[a-z0-9-]+\.json$/i)
const directory = new URL('../../artifacts/pwa-parity/', import.meta.url)
const report = { testedAt: new Date().toISOString(), query, naturalQueryRequired: args.includes('--require-natural'), checks: [], searchAttempts: [], downloadAttempts: [], pageErrors: [], network: [],
  scope: 'Desktop Chrome emulates Android layout/taps; actual public music, compiled PWA and production SW. No physical phone, iOS, screen-off or cars claim.' }
const scrub = (value) => String(value ?? '').replace(/https?:\/\/[^\s"'<>]+/g, '[URL]').slice(0, 400)
let browser, server, page, profile, applicationURL, title, downloaded, selectedQuery = query, rowIndex = 0
const rowSelector = () => `.tracks li[data-reorder-index="${rowIndex}"]`
async function bounded(work, name, ms = 15000) {
  let timer
  try { return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timeout: ' + name)), ms) })]) }
  finally { clearTimeout(timer) }
}
async function check(name, work, ms = 20000) {
  console.log(JSON.stringify({ phase: name, state: 'start' }))
  try { const details = await bounded(work, name, ms); report.checks.push({ name, passed: true, ...(details ?? {}) }); console.log(JSON.stringify({ phase: name, state: 'passed' })); return true }
  catch (error) { report.checks.push({ name, passed: false, error: scrub(error.message) }); console.log(JSON.stringify({ phase: name, state: 'failed' })); return false }
}
async function clickText(selector, text) {
  const handle = await page.evaluateHandle((selector, text) => [...document.querySelectorAll(selector)].find((element) => element.textContent.trim() === text), selector, text)
  try { assert.ok(handle.asElement(), 'Action present: ' + text); await handle.asElement().click() } finally { await handle.dispose() }
}
function instrument() {
  const instances = [], events = [], transfers = []
  const NativeAudio = window.Audio
  let Wrapped
  Wrapped = new Proxy(NativeAudio, { construct(target, args, newTarget) {
    const audio = Reflect.construct(target, args, newTarget === Wrapped ? target : newTarget)
    const index = instances.push(audio) - 1
    for (const type of ['loadedmetadata', 'playing', 'pause', 'ended', 'seeked', 'error']) audio.addEventListener(type, () => {
      events.push({ type, index, at: Math.round(performance.now()), time: Number.isFinite(audio.currentTime) ? audio.currentTime : null, error: audio.error?.code ?? null })
    })
    return audio
  } })
  window.Audio = Wrapped
  window.addEventListener('pletina:download', ({ detail }) => transfers.push({ trackId: detail.trackId, state: detail.state, progress: detail.progress, error: detail.error ? String(detail.error).replace(/https?:\/\/[^\s]+/g, '[URL]') : null }))
  window.__qaAudio = { instances, events, transfers, snapshot() {
    return { title: navigator.mediaSession?.metadata?.title ?? null, online: navigator.onLine, events: events.slice(-40),
      instances: instances.map((audio, index) => ({ index, sourcePresent: Boolean(audio.src), localCache: Boolean(audio.src) && new URL(audio.src).origin === location.origin && new URL(audio.src).pathname.includes('/__audio__/'),
        time: Number.isFinite(audio.currentTime) ? audio.currentTime : null, duration: Number.isFinite(audio.duration) ? audio.duration : null,
        paused: audio.paused, readyState: audio.readyState, error: audio.error?.code ?? null, muted: audio.muted, volume: audio.volume })) }
  } }
}
const media = () => page.evaluate(() => window.__qaAudio.snapshot())
async function databaseState() {
  return page.evaluate(async () => {
    const cache = await caches.open('pletina-audio-downloads:v1')
    const keys = await cache.keys()
    const exists = (await indexedDB.databases()).some((entry) => entry.name === 'pletina-web-downloads')
    if (!exists) return { rows: [], cacheEntries: keys.length }
    const db = await new Promise((resolve, reject) => { const req = indexedDB.open('pletina-web-downloads'); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(new Error('Download DB failed')) })
    try {
      const rows = await new Promise((resolve, reject) => { const req = db.transaction('files').objectStore('files').getAll(); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(new Error('Download rows failed')) })
      return { cacheEntries: keys.length, rows: await Promise.all(rows.map(async (row) => ({ id: row.id, title: row.track.title, size: row.size,
        stageKeyValid: new URL(row.cacheKey).origin === location.origin && new URL(row.cacheKey).pathname.endsWith('/__audio__/' + row.id) && new URL(row.cacheKey).searchParams.has('stage'),
        cachePresent: Boolean(await cache.match(row.cacheKey)), cacheType: (await cache.match(row.cacheKey))?.type ?? null }))) }
    } finally { db.close() }
  })
}
async function search(value) {
  await clickText('.bottom-nav button', 'Buscar')
  await page.waitForSelector('input[aria-label="Buscar música"]', { visible: true })
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const response = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.hostname === 'api.deezer.com' && url.pathname === '/search/track' && url.searchParams.get('q') === value
  }, { timeout: 25000 }).catch((error) => error)
  await page.click('input[aria-label="Buscar música"]', { clickCount: 3 })
  await page.keyboard.press('Backspace')
  await page.type('input[aria-label="Buscar música"]', value)
  assert.equal(await page.$eval('input[aria-label="Buscar música"]', (node) => node.value), value, 'navigation focus must not select/overwrite part of the typed query')
  const received = await response
  if (received instanceof Error) throw received
  await page.waitForFunction((value) => document.querySelector('input[aria-label="Buscar música"]')?.value === value &&
    (document.querySelector('.tracks li[data-reorder-index="0"] .name') || document.querySelector('.page .empty-state') || document.querySelector('.page .error')) &&
    !document.querySelector('.stale'), { timeout: 25000 }, value)
  assert.ok(await page.$('.tracks li[data-reorder-index="0"] .name'), 'No song results for this search')
  const rows = await page.$$eval('.tracks li[data-reorder-index]', (nodes) => nodes.map((row) => ({ index: Number(row.dataset.reorderIndex),
    title: row.querySelector('.name').textContent.trim(), artist: row.querySelector('.by > span:last-child').textContent.trim() })))
  const selected = /solas|violadores/i.test(value) ? rows.find((row) => /solas.*ritmo.*l[ií]rico/i.test(row.title) && /violadores/i.test(row.artist)) ?? rows[0] : rows[0]
  rowIndex = selected.index
  return selected
}
async function waitPlaying(expectedTitle, timeout = 60000) {
  await page.waitForFunction(() => window.__qaAudio.instances.some((audio) => !audio.paused && audio.currentTime > 1) ||
    [...document.querySelectorAll('[role="status"]')].some((node) => node.textContent.includes('Pulsa Reproducir')), { timeout })
  let state = await media()
  if (!state.instances.some((audio) => !audio.paused && audio.time > 1)) {
    await page.click('.mini button[aria-label="Reproducir"]')
    await page.waitForFunction(() => window.__qaAudio.instances.some((audio) => !audio.paused && audio.currentTime > 1), { timeout: 20000 })
    state = await media()
  }
  assert.equal(state.title, expectedTitle, 'must play the selected song itself without an automatic skip')
  await page.waitForSelector('.mini button[aria-label="Pausa"]', { visible: true, timeout: 5000 })
  return state
}
async function goDownloads() {
  await clickText('.bottom-nav button', 'Tu biblioteca')
  await page.waitForSelector('.page .items .item')
  const handle = await page.evaluateHandle(() => [...document.querySelectorAll('.page .items .item')].find((node) => node.querySelector('.title')?.textContent.trim() === 'Descargas'))
  try { assert.ok(handle.asElement(), 'Downloads remains exposed in the mobile library'); await handle.asElement().click() } finally { await handle.dispose() }
  await page.waitForFunction(() => document.querySelector('.page-title')?.textContent.trim() === 'Descargas')
  rowIndex = 0
}
async function attemptDownload(value, existing = false) {
  const attempt = { query: value }
  report.downloadAttempts.push(attempt)
  try {
    if (!existing) { const row = await search(value); title = row.title }
    attempt.title = title
    const before = await page.evaluate(() => window.__qaAudio.transfers.length)
    await page.click(rowSelector() + ' button.more')
    await clickText('[role="menuitem"]', 'Descargar')
    await page.waitForFunction((before) => {
      const events = window.__qaAudio.transfers.slice(before), queued = events.find((entry) => entry.state === 'queued')
      return queued && events.some((entry) => entry.trackId === queued.trackId && ['done', 'error', 'cancelled'].includes(entry.state))
    }, { timeout: 110000 }, before)
    const events = await page.evaluate((before) => window.__qaAudio.transfers.slice(before), before)
    const queued = events.find((entry) => entry.state === 'queued'), terminal = events.findLast((entry) => entry.trackId === queued.trackId && ['done', 'error', 'cancelled'].includes(entry.state))
    attempt.events = events
    assert.equal(terminal.state, 'done', terminal.error ?? terminal.state)
    const state = await databaseState()
    attempt.database = state
    const saved = state.rows.find((row) => row.id === queued.trackId)
    assert.ok(saved?.stageKeyValid && saved.cachePresent && saved.cacheType === 'opaque', 'done requires a committed opaque response and internal staging pointer')
    assert.equal(saved.title, title)
    attempt.passed = true
    return { id: saved.id, title: saved.title }
  } catch (error) { attempt.passed = false; attempt.error = scrub(error.message); attempt.audio = await media().catch(() => null); return null }
}

try {
  profile = await mkdtemp(join(tmpdir(), 'pletina-downloads-qa-'))
  server = createPwaServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  browser = await puppeteer.launch({ headless: true, args: ['--mute-audio'], executablePath: chrome, userDataDir: profile, timeout: 15000 })
  report.browser = await browser.version()
  page = await browser.newPage()
  await page.setViewport({ width: 412, height: 915, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  await page.setUserAgent('Mozilla/5.0 (Linux; Android 15; QA) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36')
  await page.evaluateOnNewDocument(instrument)
  page.on('pageerror', (error) => report.pageErrors.push({ name: error.name, message: scrub(error.message) }))
  page.on('response', (response) => {
    const url = new URL(response.url())
    if (/(^|\.)(googlevideo\.com|youtube\.com|deezer\.com)$/.test(url.hostname)) report.network.push({ host: url.hostname, type: response.request().resourceType(), status: response.status() })
  })
  page.on('requestfailed', (request) => {
    const url = new URL(request.url())
    if (/(^|\.)(googlevideo\.com|youtube\.com|deezer\.com)$/.test(url.hostname)) report.network.push({ host: url.hostname, type: request.resourceType(), failure: scrub(request.failure()?.errorText) })
  })
  assert.ok(await check('minimal install opens compiled mobile UI with all four tabs', async () => {
    await page.goto(`http://127.0.0.1:${server.address().port}/pletina/`, { waitUntil: 'load', timeout: 20000 })
    await page.waitForFunction(() => navigator.serviceWorker.controller, { timeout: 20000 })
    report.build = await page.$eval('#version', (node) => node.textContent.trim())
    if (option('--expected-build', null)) assert.equal(report.build, option('--expected-build'))
    await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }), page.click('#open-player')])
    await page.waitForSelector('.bottom-nav', { visible: true, timeout: 15000 })
    applicationURL = page.url()
    const tabs = await page.$$eval('.bottom-nav button', (nodes) => nodes.map((node) => node.textContent.trim()))
    assert.deepEqual(tabs, ['Inicio', 'Buscar', 'Podcasts', 'Tu biblioteca'])
    return { tabs }
  }, 65000))
  const searched = await check('the requested song can be found by title and artist', async () => {
    const queries = args.includes('--require-natural') ? [query] : [...new Set([query, 'A solas con un ritmo', 'Violadores del Verso A solas'])]
    for (const value of queries) {
      const attempt = { query: value }; report.searchAttempts.push(attempt)
      try {
        const row = await search(value)
        assert.match(row.title, /solas.*ritmo.*l[ií]rico/i); assert.match(row.artist, /violadores/i)
        title = row.title; selectedQuery = value; attempt.passed = true; attempt.result = row
        return { usedQuery: value, ...row }
      } catch (error) {
        attempt.passed = false; attempt.error = scrub(error.message)
        attempt.ui = await page.evaluate(() => ({ input: document.querySelector('input[aria-label="Buscar música"]')?.value,
          notices: [...document.querySelectorAll('[role="status"],.empty-state,.error')].map((node) => node.textContent.trim()).slice(0, 5),
          titles: [...document.querySelectorAll('.tracks .name')].map((node) => node.textContent.trim()).slice(0, 8) }))
      }
    }
    throw new Error('The requested title was not returned by any of the three catalog searches')
  }, 85000)
  assert.ok(searched)
  await check('tapping the searched artist text plays that song and keeps the song list visible', async () => {
    const selector = rowSelector() + ' .by > span:last-child'
    const kind = await page.$eval(selector, (node) => node.tagName)
    assert.equal(kind, 'SPAN')
    await page.click(selector)
    await page.waitForFunction(() => document.querySelector('.mini .title'))
    assert.equal(await page.$eval('.mini .title', (node) => node.textContent.trim()), title)
    assert.ok(await page.$('.tracks li[data-reorder-index="0"]'), 'artist view must not replace search results')
    const state = await waitPlaying(title, 70000)
    if (await page.$('.mini button[aria-label="Pausa"]')) await page.click('.mini button[aria-label="Pausa"]')
    return { selectedTitle: title, tag: kind, audio: state }
  }, 95000)
  assert.ok(await check('real download validates bytes through production SW before completing', async () => {
    downloaded = await attemptDownload(selectedQuery, true)
    if (!downloaded) downloaded = await attemptDownload(query === 'Radiohead Creep' ? 'Daft Punk Get Lucky' : 'Radiohead Creep')
    assert.ok(downloaded, 'Neither real provider attempt produced a valid downloaded audio file; inspect downloadAttempts')
    await goDownloads()
    await page.waitForSelector('.tracks li[data-reorder-index="0"] .name')
    assert.equal(await page.$eval('.tracks li[data-reorder-index="0"] .name', (node) => node.textContent.trim()), downloaded.title)
    // The restored queue must refer to the actually downloaded song before leaving the app.
    await page.click('.tracks li[data-reorder-index="0"] .by > span:last-child')
    await waitPlaying(downloaded.title, 20000)
    await page.click('.mini button[aria-label="Pausa"]')
    return { downloaded, database: await databaseState() }
  }, 240000))
  assert.ok(await check('offline reload restores the queue paused and can reopen Downloads', async () => {
    await page.setOfflineMode(true)
    await page.reload({ waitUntil: 'load', timeout: 25000 })
    await page.waitForSelector('.bottom-nav', { visible: true })
    assert.equal(page.url(), applicationURL)
    await page.waitForSelector('.mini .title')
    assert.equal(await page.$eval('.mini .title', (node) => node.textContent.trim()), downloaded.title)
    const state = await media()
    assert.equal(state.online, false)
    assert.ok(state.instances.every((audio) => audio.paused), 'restoring metadata must not autoplay after reload')
    await goDownloads()
    await page.waitForSelector('.tracks li[data-reorder-index="0"] .name')
    return { audio: state, database: await databaseState() }
  }, 45000))
  assert.ok(await check('offline Play and seek use the stable local cache route', async () => {
    await page.click('.tracks li[data-reorder-index="0"] .by > span:last-child')
    let state = await waitPlaying(downloaded.title, 20000)
    const active = state.instances.find((audio) => !audio.paused)
    assert.ok(active.localCache && active.muted === false && active.volume > 0)
    await page.click('.mini button.open')
    await page.waitForSelector('.np input[aria-label="Posición"]:not([disabled])')
    const input = await page.$('.np input[aria-label="Posición"]')
    const bounds = await input.boundingBox()
    await page.touchscreen.tap(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await page.waitForFunction(() => window.__qaAudio.instances.some((audio) => !audio.paused && !audio.seeking && Number.isFinite(audio.duration) && audio.currentTime > audio.duration / 2 + 1), { timeout: 15000 })
    state = await media()
    assert.equal(state.online, false)
    assert.ok(state.events.some((entry) => entry.type === 'seeked' && entry.time > active.duration * 0.45))
    await page.click('.np button.close')
    await page.click('.mini button[aria-label="Pausa"]')
    return { audio: state }
  }, 50000))
  await check('removing a download removes UI entry, DB pointer and cache body without network fallback', async () => {
    await page.click('.tracks li[data-reorder-index="0"] button.more')
    await clickText('[role="menuitem"]', 'Quitar descarga')
    await page.waitForFunction(() => document.querySelector('.empty-state strong')?.textContent.includes('Aún no has descargado'))
    const state = await databaseState()
    assert.deepEqual(state.rows, []); assert.equal(state.cacheEntries, 0)
    const status = await page.evaluate(async (id) => (await fetch(new URL('../__audio__/' + id, location.href))).status, downloaded.id)
    assert.equal(status, 404)
    return { database: state, missingMediaStatus: status }
  }, 25000)
} catch (error) { report.fatal = scrub(error.message) }
finally {
  report.finishedAt = new Date().toISOString()
  if (page && !page.isClosed()) {
    report.finalAudio = await bounded(media, 'final snapshot', 3000).catch(() => null); report.finalDatabase = await bounded(databaseState, 'final database', 3000).catch(() => null)
    report.finalUI = await page.evaluate(() => ({ input: document.querySelector('input[aria-label="Buscar música"]')?.value,
      headings: [...document.querySelectorAll('h1,h2')].map((node) => node.textContent.trim()).slice(0, 10),
      notices: [...document.querySelectorAll('[role="status"],.empty-state,.error')].map((node) => node.textContent.trim()).slice(0, 8),
      rows: [...document.querySelectorAll('.tracks .name')].map((node) => node.textContent.trim()).slice(0, 5) })).catch(() => null)
  }
  report.passed = !report.fatal && report.checks.length >= 7 && report.checks.every((entry) => entry.passed) && report.pageErrors.length === 0
  await bounded(async () => { if (browser) await browser.close() }, 'browser cleanup', 5000).catch(() => browser?.process()?.kill())
  if (server) { server.closeAllConnections(); await bounded(() => new Promise((resolve) => server.close(resolve)), 'server cleanup', 2000).catch(() => {}) }
  if (profile) {
    const target = resolve(profile)
    assert.ok(target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith('pletina-downloads-qa-'))
    await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  }
  await mkdir(directory, { recursive: true })
  await writeFile(new URL(reportName, directory), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ report: 'artifacts/pwa-parity/' + reportName, passed: report.passed, checks: report.checks.map(({ name, passed }) => ({ name, passed })) }))
  if (!report.passed) process.exitCode = 1
}
