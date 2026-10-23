// Compiled PWA live UI canary. No Spotify/catalog responses are mocked.
// node scripts/tests/web-spotify.browser.mjs --expected-build HASH
//   [--url https://host/pletina/] [--report safe-name.json] [--chrome executable]
// Desktop Chrome at 393x852 is a layout check, not physical installed-phone evidence.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
import { createPwaServer } from '../preview-pwa.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const expectedBuild = option('--expected-build', null)
assert.match(expectedBuild ?? '', /^[a-f0-9]{16}$/, 'Explicit compiled build required')
const reportName = option('--report', `spotify-ui-${expectedBuild}-${option('--url', null) ? 'public' : 'local'}.json`)
assert.match(reportName, /^[a-z0-9.-]+\.json$/i)
const stem = reportName.replace(/\.json$/i, '')
const directory = new URL('../../artifacts/spotify-import-investigation/', import.meta.url)
await mkdir(directory, { recursive: true })
const scriptSha256 = createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex')
const playlistId = '3cEYpjA9oz9GiPac4AsH4n'
const expectedName = 'Spotify Web API Testing playlist'
const qaName = 'QA Spotify ' + new Date().toISOString().replace(/[:.]/g, '-')
const scrub = value => String(value ?? '').replace(/(?:https?|blob):[^\s"'<>]+/g, '[URL]').replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').slice(0, 700)
const report = {
  schemaVersion: 1, testedAt: new Date().toISOString(), expectedBuild, build: null, playlistId,
  execution: { script: 'scripts/tests/web-spotify.browser.mjs', scriptSha256 },
  scope: 'Compiled PWA UI, real direct Spotify metadata, live catalog matching, review-before-save, order and reload persistence.',
  viewport: { width: 393, height: 852 }, physicalPhoneVerified: false, installedPwaVerified: false,
  providerResponsesMocked: false, runtimeProxy: false, securityOverrides: false, login: false,
  tokensPersisted: false, rawRequestHeadersPersisted: false, checks: [], network: [], tokenResponses: [], playlistResponses: [], errors: [],
}
let server, browser, context, page, stage = 'start'
const pending = new Set()
const record = (name, detail = {}) => report.checks.push({ name, pass: true, ...detail })
const snapshot = () => page.evaluate(() => ({
  title: document.querySelector('.hero h1,.page-title')?.textContent?.trim() ?? null,
  alerts: [...document.querySelectorAll('[role="alert"]')].map(x => x.textContent.trim()),
  status: [...document.querySelectorAll('[role="status"]')].map(x => x.textContent.trim()),
  totals: [...document.querySelectorAll('.totals strong')].map(x => x.textContent.trim()),
  buttons: [...document.querySelectorAll('.actions button')].map(x => ({ text: x.textContent.trim(), disabled: x.disabled })),
}))
async function clickText(selector, text, exact = true) {
  const handle = await page.evaluateHandle((selector, text, exact) => [...document.querySelectorAll(selector)].find(x => exact ? x.textContent.trim() === text : x.textContent.includes(text)), selector, text, exact)
  assert.ok(handle.asElement(), 'UI action exists: ' + text)
  await handle.asElement().click()
  await handle.dispose()
}
async function librarySnapshot() {
  return page.evaluate(async () => {
    if (!(await indexedDB.databases()).some(x => x.name === 'pletina-web-library')) return { playlists: [], entries: [] }
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('pletina-web-library')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(new Error('Cannot read library database'))
    })
    try {
      const transaction = db.transaction(['playlists', 'entries'])
      const getAll = store => new Promise((resolve, reject) => {
        const request = transaction.objectStore(store).getAll()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(new Error('Cannot read library rows'))
      })
      const [playlists, entries] = await Promise.all([getAll('playlists'), getAll('entries')])
      return { playlists: playlists.map(x => ({ id: x.id, name: x.name })), entries: entries.map(x => ({ playlistId: x.playlistId, trackId: x.trackId, position: x.position })) }
    } finally { db.close() }
  })
}
async function awaitNetworkRecords() { await Promise.allSettled([...pending]) }
async function waitForReviewOrInterruption() {
  await page.waitForFunction(() => Boolean(document.querySelector('#playlist-name')) || Boolean(document.querySelector('[role="alert"]')), { polling: 200, timeout: 120000 })
}
try {
  let url = option('--url', null)
  if (url) assert.equal(new URL(url).protocol, 'https:')
  else {
    server = createPwaServer()
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    url = `http://127.0.0.1:${server.address().port}/pletina/`
  }
  report.target = { origin: new URL(url).origin, path: new URL(url).pathname }
  browser = await puppeteer.launch({ headless: true, args: ['--mute-audio'], executablePath: option('--chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe') })
  report.browserVersion = await browser.version()
  context = await browser.createBrowserContext()
  page = await context.newPage()
  await page.setViewport({ width: 393, height: 852, isMobile: true, hasTouch: true, deviceScaleFactor: 1 })
  await page.setUserAgent('Mozilla/5.0 (Linux; Android 15; Xiaomi 15T Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36')
  page.on('pageerror', error => report.errors.push({ name: error.name, message: scrub(error.message) }))
  page.on('request', request => {
    const url = new URL(request.url())
    if (!/(?:^|\.)spotify\.com$/.test(url.hostname)) return
    const headers = request.headers()
    const entry = { method: request.method(), host: url.hostname, path: url.pathname, cookiePresent: Boolean(headers.cookie), authorizationPresent: Boolean(headers.authorization) }
    if (url.hostname === 'api-partner.spotify.com') {
      entry.operationName = url.searchParams.get('operationName')
      try { const variables = JSON.parse(url.searchParams.get('variables')); entry.page = { uri: variables.uri, limit: variables.limit, offset: variables.offset } } catch {}
    }
    report.network.push(entry)
  })
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.hostname !== 'open.spotify.com' && url.hostname !== 'api-partner.spotify.com') return
    if (response.request().method() === 'OPTIONS') return
    const work = (async () => {
      if (url.pathname === '/embed/api/token') {
        const data = await response.json()
        report.tokenResponses.push({ status: response.status(), anonymous: data.isAnonymous === true, tokenPresent: typeof data.accessToken === 'string' && Boolean(data.accessToken), expiresInFuture: Number(data.accessTokenExpirationTimestampMs) > Date.now() })
      } else if (url.hostname === 'api-partner.spotify.com' && url.pathname.endsWith('/query')) {
        const data = await response.json(), playlist = data?.data?.playlistV2
        report.playlistResponses.push({ status: response.status(), typename: playlist?.__typename ?? null, id: playlist?.id ?? null, uri: playlist?.uri ?? null, name: playlist?.name ?? null, itemCount: playlist?.content?.items?.length ?? null, totalCount: playlist?.content?.totalCount ?? null })
      }
    })().catch(error => report.errors.push({ scope: 'network-observation', name: error.name, message: scrub(error.message) }))
    pending.add(work)
    void work.finally(() => pending.delete(work))
  })
  stage = 'open compiled PWA'
  await page.goto(url, { waitUntil: 'load' })
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), { timeout: 30000 })
  report.build = await page.$eval('#version', x => x.textContent.trim())
  assert.equal(report.build, expectedBuild)
  await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 45000 }), page.click('#open-player')])
  await page.waitForSelector('.app.mobile .bottom-nav', { timeout: 30000 })
  record('compiled build and fresh mobile layout', { build: report.build })
  stage = 'open import form'
  await clickText('.bottom-nav button', 'Tu biblioteca')
  await page.click('button.import')
  await page.waitForSelector('#spotify-url')
  report.libraryBeforeRead = await librarySnapshot()
  assert.equal(report.libraryBeforeRead.playlists.length, 0)
  await page.type('#spotify-url', `https://open.spotify.com/playlist/${playlistId}`)
  stage = 'read real Spotify link and match catalog'
  await clickText('form button', 'Buscar canciones')
  await waitForReviewOrInterruption()
  if (!await page.$('#playlist-name')) {
    const retry = await page.evaluate(() => [...document.querySelectorAll('.actions button')].some(x => x.textContent.trim() === 'Reintentar búsqueda'))
    if (retry) {
      report.firstCatalogInterruption = await snapshot()
      await clickText('.actions button', 'Reintentar búsqueda')
      await waitForReviewOrInterruption()
    }
  }
  await awaitNetworkRecords()
  report.readOnlyMetadataVerified = report.tokenResponses.some(x => x.status === 200 && x.anonymous && x.tokenPresent) && report.playlistResponses.some(x => x.status === 200 && x.id === playlistId && x.uri === 'spotify:playlist:' + playlistId && x.name === expectedName && x.itemCount === 5 && x.totalCount === 5)
  assert.equal(report.readOnlyMetadataVerified, true, 'Actual compiled UI obtained five real Spotify items anonymously')
  assert.ok(report.network.some(x => x.host === 'open.spotify.com' && x.path === '/embed/api/token'))
  assert.ok(report.network.some(x => x.host === 'api-partner.spotify.com' && x.operationName === 'queryPlaylist' && x.authorizationPresent))
  assert.equal(report.network.some(x => x.cookiePresent || x.host === 'accounts.spotify.com'), false)
  const cookies = await context.cookies()
  report.spotifyCookieCount = cookies.filter(x => /(?:^|\.)spotify\.com$/.test(x.domain.replace(/^\./, ''))).length
  assert.equal(report.spotifyCookieCount, 0)
  record('real direct Spotify metadata without login cookies', { sourceCount: 5 })
  assert.ok(await page.$('#playlist-name'), 'Catalog matching reached review; inspect interruption report if not')
  stage = 'review before save'
  const review = await page.evaluate(() => ({ name: document.querySelector('#playlist-name').value,
    totals: [...document.querySelectorAll('.totals strong')].map(x => Number(x.textContent.trim())),
    found: [...document.querySelectorAll('.track-details ol li')].map(x => ({ title: x.querySelector('strong').textContent.trim(), artist: x.querySelector('span').textContent.trim() })),
    omitted: [...document.querySelectorAll('.track-details ul li')].map(x => ({ title: x.querySelector('strong').textContent.trim(), artist: x.querySelector('span').textContent.trim() })),
    warnings: [...document.querySelectorAll('.warnings p')].map(x => x.textContent.trim()),
  }))
  assert.equal(review.name, expectedName)
  assert.equal(review.totals.reduce((sum, count) => sum + count, 0), 5)
  assert.equal(review.found.length, review.totals[0])
  report.review = review
  report.libraryBeforeSave = await librarySnapshot()
  assert.equal(report.libraryBeforeSave.playlists.length, 0)
  assert.equal(report.libraryBeforeSave.entries.length, 0)
  if (review.found.length) await clickText('.track-details summary', 'Canciones que se guardarán', false)
  report.reviewScreenshot = stem + '-review.png'
  await page.screenshot({ path: fileURLToPath(new URL(report.reviewScreenshot, directory)), fullPage: true })
  record('review shows correct source and creates no playlist', { found: review.totals[0], omitted: review.totals[1] })
  if (review.found.length) {
    stage = 'save reviewed matches'
    await page.focus('#playlist-name')
    await page.keyboard.down('Control')
    await page.keyboard.press('KeyA')
    await page.keyboard.up('Control')
    await page.keyboard.type(qaName)
    assert.equal(await page.$eval('#playlist-name', input => input.value), qaName, 'QA name replaces the original input')
    await clickText('.actions button', 'Guardar playlist')
    await page.waitForFunction(name => document.querySelector('.hero h1')?.textContent.trim() === name, { timeout: 30000 }, qaName)
    const savedTitles = await page.$$eval('.tracks li[data-reorder-index] .name', nodes => nodes.map(x => x.textContent.trim()))
    assert.deepEqual(savedTitles, review.found.map(x => x.title))
    report.saved = { name: qaName, titles: savedTitles }
    report.libraryAfterSave = await librarySnapshot()
    assert.equal(report.libraryAfterSave.playlists.length, 1)
    assert.equal(report.libraryAfterSave.playlists[0].name, qaName)
    assert.equal(report.libraryAfterSave.entries.length, review.found.length)
    record('save preserves reviewed matches and order', { count: savedTitles.length })
    stage = 'reload saved playlist'
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('.app.mobile .bottom-nav', { timeout: 30000 })
    await clickText('.bottom-nav button', 'Tu biblioteca')
    await page.waitForFunction(name => [...document.querySelectorAll('.items .item')].some(x => x.textContent.includes(name)), { timeout: 15000 }, qaName)
    await clickText('.items .item', qaName, false)
    await page.waitForSelector('.tracks li[data-reorder-index] .name', { timeout: 15000 })
    const reloadedTitles = await page.$$eval('.tracks li[data-reorder-index] .name', nodes => nodes.map(x => x.textContent.trim()))
    assert.deepEqual(reloadedTitles, savedTitles)
    assert.deepEqual(await librarySnapshot(), report.libraryAfterSave)
    report.savedScreenshot = stem + '-saved.png'
    await page.screenshot({ path: fileURLToPath(new URL(report.savedScreenshot, directory)), fullPage: true })
    record('saved playlist survives reload in order', { count: reloadedTitles.length })
    report.actualSaveVerified = true
  } else {
    report.actualSaveVerified = false
    report.saveSkipped = 'The live catalog returned no matched songs. Spotify metadata and review succeeded; save/persistence are not claimed.'
  }
  report.pass = true
} catch (error) {
  report.pass = false
  report.failure = { stage, name: error.name, message: scrub(error.message), state: await snapshot().catch(() => null) }
  report.failureScreenshot = stem + '-failure.png'
  await page?.screenshot({ path: fileURLToPath(new URL(report.failureScreenshot, directory)), fullPage: true }).catch(() => {})
  process.exitCode = 1
} finally {
  await awaitNetworkRecords()
  await context?.close().catch(() => {})
  await browser?.close().catch(() => {})
  if (server) await new Promise(resolve => server.close(resolve))
  report.finishedAt = new Date().toISOString()
  await writeFile(new URL(reportName, directory), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ report: reportName, pass: report.pass, build: report.build, readOnlyMetadataVerified: report.readOnlyMetadataVerified, actualSaveVerified: report.actualSaveVerified, found: report.review?.totals?.[0], failure: report.failure?.message }))
}
