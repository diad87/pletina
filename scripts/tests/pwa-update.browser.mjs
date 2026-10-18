// Real desktop Chrome, temporary profile/site, no musical network or production output changes.
// node scripts/tests/pwa-update.browser.mjs --playwright packageOrPath --chrome executable
//   [--application dist-web-port] [--prototype pathToOldDist] [--report update-browser.json]
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPwa, sourceDirectory } from '../build-pwa.mjs'
import { createPwaServer } from '../preview-pwa.mjs'

const workspace = fileURLToPath(new URL('../../', import.meta.url))
const args = process.argv.slice(2)
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const { chromium } = createRequire(import.meta.url)(option('--playwright', 'playwright'))
const digest = (value) => createHash('sha256').update(value).digest('hex')
const artifactDirectory = join(workspace, 'artifacts', 'pwa-port')
const reportName = option('--report', 'update-browser.json')
assert.match(reportName, /^[a-z0-9-]+\.json$/i)
const report = {
  testedAt: new Date().toISOString(), browser: null, checks: [], errors: [], messages: [],
  scope: 'Desktop Chrome, real installed/controlling service worker and IndexedDB; isolated temporary browser profile and localhost site.',
  osShortcutInstallationVerified: false, androidVerified: false, iOSVerified: false,
  externalMusicNetworkUsed: false, productionDirectoriesMutated: false,
  updateTrigger: 'registration.update() accelerates the normal check; update/ retry buttons and product message handlers are real.',
  playlistFixture: 'Created and renamed through app UI; two duplicate local metadata entries seeded directly in test IndexedDB. No audio files or signed URLs.',
}
const scrub = (value) => String(value ?? '').replace(/https?:\/\/[^\s"'<>]+/g, '[URL]')
  .replace(/[A-Z]:[\\/][^\s\n"']+/gi, '[path]').replace(/\u001b\[[0-9;]*m/g, '').slice(0, 700)
let temporary, browser, server, page, gate, live = 'A', phase = 'setup', origin
const servers = new Map(), requests = [], blockedHosts = new Set()
let failingPath = null
async function check(name, action) {
  process.stdout.write(`${name} ... `)
  try {
    const details = await action()
    report.checks.push({ name, pass: true, ...details })
    process.stdout.write('passed\n')
  } catch (error) {
    report.checks.push({ name, pass: false, error: scrub(error.message) })
    process.stdout.write('FAILED\n')
    throw error
  }
}
const defer = () => {
  let resolve
  const promise = new Promise((yes) => { resolve = yes })
  return { promise, resolve }
}
async function context() {
  const result = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'allow' })
  await result.route('**/*', (route) => {
    const url = new URL(route.request().url())
    if (url.origin === origin) return route.continue()
    blockedHosts.add(url.hostname)
    return route.abort('blockedbyclient')
  })
  await result.exposeBinding('__qaUpdateLog', ({ frame }, value) => {
    report.messages.push({ phase, path: new URL(frame.url()).pathname, ...value })
  })
  await result.addInitScript(() => {
    if (window.top !== window) return
    const postMessage = ServiceWorker.prototype.postMessage
    ServiceWorker.prototype.postMessage = function (...args) {
      if (['PREPARE_APPLICATION', 'ACTIVATE_UPDATE'].includes(args[0]?.type)) {
        void window.__qaUpdateLog({ type: args[0].type, state: this.state }).catch(() => {})
      }
      return Reflect.apply(postMessage, this, args)
    }
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      void window.__qaUpdateLog({ type: 'controllerchange' }).catch(() => {})
    })
  })
  return result
}
async function newPage(browserContext) {
  const result = await browserContext.newPage()
  result.on('pageerror', (error) => report.errors.push({ phase, message: scrub(error.message) }))
  return result
}
async function installed() {
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.getRegistration()
    return navigator.serviceWorker.controller && registration?.active?.state === 'activated'
  }, { timeout: 30000 })
}
async function snapshot() {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration()
    const cacheInfo = []
    for (const name of await caches.keys()) {
      if (!name.startsWith('pletina-pwa:')) continue
      cacheInfo.push({ version: name.split(':').at(-1), paths: (await (await caches.open(name)).keys()).map((request) => new URL(request.url).pathname).sort() })
    }
    return {
      scope: registration ? new URL(registration.scope).pathname : null,
      registrations: (await navigator.serviceWorker.getRegistrations()).length,
      active: registration?.active?.state ?? null, waiting: registration?.waiting?.state ?? null,
      cacheInfo,
    }
  })
}
async function database() {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const operation = indexedDB.open('pletina-web-library')
    operation.onerror = () => reject(new Error('Could not open test library'))
    operation.onsuccess = () => {
      const db = operation.result
      const names = ['playlists', 'entries', 'tracks']
      const transaction = db.transaction(names)
      const result = {}
      for (const name of names) {
        const request = transaction.objectStore(name).getAll()
        request.onsuccess = () => { result[name] = request.result }
      }
      transaction.oncomplete = () => { db.close(); resolve(result) }
      transaction.onabort = () => { db.close(); reject(new Error('Could not read test library')) }
    }
  }))
}
async function openApplication() {
  await page.locator('#open-player').click()
  await page.waitForURL(/\/application\/index\.[a-f0-9]{16}\.html$/, { waitUntil: 'load', timeout: 30000 })
  await page.locator('.app .sidebar').waitFor({ state: 'visible', timeout: 20000 })
}
async function openPlaylist(name) {
  await page.locator('.sidebar .item').filter({ hasText: name }).click()
  await page.locator('.tracks li[data-reorder-index]').nth(1).waitFor({ state: 'visible' })
  assert.equal(await page.locator('.tracks li[data-reorder-index]').count(), 2)
}
async function prepareWaiting() {
  await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration()).update() })
  await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting), { timeout: 30000 })
}

try {
  await mkdir(artifactDirectory, { recursive: true })
  temporary = await mkdtemp(join(tmpdir(), 'pletina-update-browser-'))
  const shell = join(temporary, 'shell')
  await cp(sourceDirectory, shell, { recursive: true })
  const application = resolve(workspace, option('--application', 'dist-web-port'))
  const applicationSnapshot = join(temporary, 'application-base')
  await cp(application, applicationSnapshot, { recursive: true })
  const baseBuild = await buildPwa({ source: shell, application: applicationSnapshot, output: join(temporary, 'site-base') })
  report.baseDistributionVersion = baseBuild.version
  const compiledHtml = await readFile(join(applicationSnapshot, 'index.html'), 'utf8')
  report.sourceCompiledHtmlSha256 = digest(compiledHtml)
  const builds = {}
  for (const name of ['A', 'B']) {
    const app = join(temporary, `application-${name}`)
    await cp(applicationSnapshot, app, { recursive: true })
    await writeFile(join(app, 'index.html'), compiledHtml.replace(/<title>[^<]*<\/title>/,
      `<meta name="qa-release" content="${name}"><title>Pletina QA ${name}</title>`))
    const output = join(temporary, `site-${name}`)
    builds[name] = await buildPwa({ source: shell, application: app, output })
    servers.set(name, createPwaServer({ directory: output }))
  }
  assert.notEqual(builds.A.version, builds.B.version)
  assert.notEqual(builds.A.applicationPage, builds.B.applicationPage)
  report.builds = Object.fromEntries(Object.entries(builds).map(([name, value]) => [name, {
    version: value.version, applicationPage: value.applicationPage, optionalFiles: value.optionalFiles,
  }]))
  const compiledWorker = await readFile(join(temporary, 'site-A', 'sw.js'), 'utf8')
  report.sourceApplicationAssets = JSON.parse(compiledWorker.match(/const OPTIONAL = (\[[^\n]+\])/)[1])
    .filter((file) => file.url.startsWith('application/assets/'))
  const manifest = JSON.parse(await readFile(join(temporary, 'site-A', 'manifest.webmanifest'), 'utf8'))
  report.manifestIdentity = { id: manifest.id, scope: manifest.scope, start_url: manifest.start_url }

  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname
    const version = live
    requests.push({ phase, version, path: pathname })
    if (pathname === failingPath) { response.writeHead(503, { 'Cache-Control': 'no-store' }); response.end('QA interrupted download'); return }
    if (gate?.path === pathname && version === 'B') { gate.entered.resolve(); await gate.release.promise }
    servers.get(version).emit('request', request, response)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${server.address().port}`
  const url = `${origin}/pletina/`
  browser = await chromium.launch({ headless: true,
    ...(option('--chrome', null) ? { executablePath: option('--chrome') } : {}) })
  report.browser = browser.version()
  const fullContext = await context()
  page = await newPage(fullContext)
  const playlistName = 'QA actualización persistente'
  let expectedDatabase
  phase = 'full-A'
  await check('full A installs without application downloads; app opens on demand', async () => {
    await page.goto(url, { waitUntil: 'load' })
    await installed()
    assert.equal(requests.filter((request) => request.path.includes('/application/')).length, 0)
    await openApplication()
    assert.equal(await page.title(), 'Pletina QA A')
    const state = await snapshot()
    assert.equal(state.scope, '/pletina/')
    assert.equal(state.registrations, 1)
    return { applicationPath: new URL(page.url()).pathname, serviceWorker: state }
  })
  await check('UI-created playlist and duplicate entries persist in real IndexedDB before update', async () => {
    await page.locator('.sidebar button[title="Crear playlist"]').click()
    await page.locator('input[aria-label="Nombre de la playlist"]').fill(playlistName)
    await page.locator('input[aria-label="Nombre de la playlist"]').press('Enter')
    await page.locator('.sidebar .item').filter({ hasText: playlistName }).waitFor()
    const current = await database()
    const playlistId = current.playlists.find((row) => row.name === playlistName)?.id
    assert.ok(Number.isSafeInteger(playlistId))
    await page.evaluate((playlistId) => new Promise((resolve, reject) => {
      const operation = indexedDB.open('pletina-web-library')
      operation.onerror = () => reject(new Error('Could not seed local metadata'))
      operation.onsuccess = () => {
        const db = operation.result
        const transaction = db.transaction(['tracks', 'entries'], 'readwrite')
        transaction.objectStore('tracks').put({ id: 101, title: 'Canción de QA', duration: 180, explicit: false,
          artistId: 1, artistName: 'Artista de QA', albumId: 1, albumTitle: 'Álbum de QA', albumArtistId: 1, cover: null })
        for (const position of [0, 1]) transaction.objectStore('entries').add({ playlistId, trackId: 101, position, at: 1700000000 })
        transaction.oncomplete = () => { db.close(); resolve() }
        transaction.onabort = () => { db.close(); reject(new Error('Could not seed local metadata')) }
      }
    }), playlistId)
    expectedDatabase = await database()
    assert.equal(expectedDatabase.entries.length, 2)
    assert.notEqual(expectedDatabase.entries[0].entryId, expectedDatabase.entries[1].entryId)
    await page.reload({ waitUntil: 'load' })
    await openPlaylist(playlistName)
    return { playlistId, entryIds: expectedDatabase.entries.map((row) => row.entryId), duplicateTrackId: 101 }
  })
  phase = 'waiting-B'
  live = 'B'
  await check('B waits behind the real update banner without replacing A or eagerly caching its app', async () => {
    await prepareWaiting()
    await page.locator('.web-update button').waitFor()
    assert.equal(await page.title(), 'Pletina QA A')
    const state = await snapshot()
    assert.equal(state.waiting, 'installed')
    const waiting = state.cacheInfo.find((cache) => cache.version === builds.B.version)
    assert.ok(waiting)
    assert.equal(waiting.paths.filter((path) => path.includes('/application/')).length, 0)
    assert.deepEqual(await database(), expectedDatabase)
    return { waitingVersion: builds.B.version, currentApplication: 'A', initialOptionalDownloads: 0 }
  })
  phase = 'failed-preparation'
  failingPath = `/pletina/${builds.B.applicationPage}`
  await check('a failed application preparation keeps A active and the playlist intact', async () => {
    await page.locator('.web-update button').click()
    await page.locator('.web-update').filter({ hasText: 'No se pudo completar la actualización' }).waitFor()
    assert.equal(await page.title(), 'Pletina QA A')
    assert.equal((await snapshot()).waiting, 'installed')
    assert.deepEqual(await database(), expectedDatabase)
    assert.equal(report.messages.filter((message) => message.phase === phase && message.type === 'ACTIVATE_UPDATE').length, 0)
    assert.equal(await page.locator('.web-update button').isEnabled(), true)
    return { oldApplicationRemainedActive: true, activationMessages: 0, retryEnabled: true }
  })
  phase = 'retry-preparation'
  failingPath = null
  gate = { path: `/pletina/${builds.B.applicationPage}`, entered: defer(), release: defer() }
  await check('retry waits for the complete application before PREPARE_APPLICATION permits activation', async () => {
    await page.locator('.web-update button').click()
    let timeout
    try {
      await Promise.race([gate.entered.promise, new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Preparation did not request the gated HTML')), 20000)
      })])
    } finally { clearTimeout(timeout) }
    assert.equal(await page.locator('.web-update button').isDisabled(), true)
    assert.equal(await page.title(), 'Pletina QA A')
    assert.equal((await snapshot()).waiting, 'installed')
    assert.equal(report.messages.filter((message) => message.phase === phase && message.type === 'ACTIVATE_UPDATE').length, 0)
    assert.deepEqual(await database(), expectedDatabase)
    gate.release.resolve()
    gate = null
    await page.waitForURL(`${origin}/pletina/${builds.B.applicationPage}`, { waitUntil: 'load', timeout: 30000 })
    await page.locator('.app .sidebar').waitFor()
    assert.equal(await page.title(), 'Pletina QA B')
    const messages = report.messages.filter((message) => message.phase === phase).map((message) => message.type)
    assert.ok(messages.indexOf('PREPARE_APPLICATION') >= 0)
    assert.ok(messages.indexOf('ACTIVATE_UPDATE') > messages.indexOf('PREPARE_APPLICATION'))
    assert.deepEqual(await database(), expectedDatabase)
    const state = await snapshot()
    assert.equal(state.waiting, null)
    assert.deepEqual(state.cacheInfo.map((cache) => cache.version), [builds.B.version])
    for (const path of builds.B.optionalFiles) assert.ok(state.cacheInfo[0].paths.includes(`/pletina/${path}`), `Cached ${path}`)
    return { messageOrder: messages, newApplicationPath: new URL(page.url()).pathname,
      cachedOptionalFiles: builds.B.optionalFiles.length, preservedDatabase: true }
  })
  phase = 'offline-B'
  await check('updated B reopens offline with the same playlist ID, entry IDs and duplicate metadata', async () => {
    await fullContext.setOffline(true)
    await page.reload({ waitUntil: 'load', timeout: 20000 })
    await openPlaylist(playlistName)
    assert.equal(await page.title(), 'Pletina QA B')
    assert.deepEqual(await database(), expectedDatabase)
    return { online: await page.evaluate(() => navigator.onLine), playlistId: expectedDatabase.playlists[0].id,
      entryIds: expectedDatabase.entries.map((row) => row.entryId), musicOfflineClaimed: false }
  })
  await fullContext.close()
  page = null

  const prototype = option('--prototype', null)
  if (prototype) {
    phase = 'prototype-migration'
    const old = join(temporary, 'prototype')
    await cp(resolve(prototype), old, { recursive: true })
    const worker = await readFile(join(old, 'sw.js'), 'utf8')
    report.prototypeVersion = worker.match(/const VERSION = "([a-f0-9]{16})"/)?.[1] ?? null
    const oldManifest = JSON.parse(await readFile(join(old, 'manifest.webmanifest'), 'utf8'))
    assert.deepEqual({ id: oldManifest.id, scope: oldManifest.scope, start_url: oldManifest.start_url }, report.manifestIdentity)
    servers.set('prototype', createPwaServer({ directory: old }))
    live = 'prototype'
    const migrationContext = await context()
    page = await newPage(migrationContext)
    await check('existing prototype migrates to full app through the same scope and manifest identity', async () => {
      await page.goto(url, { waitUntil: 'load' })
      await installed()
      await page.locator('#open-player').click()
      await page.waitForFunction(() => !document.querySelector('#player-screen').hidden)
      await page.evaluate(async () => {
        localStorage.setItem('qa:migration-sentinel', 'kept')
        await (await caches.open('qa:unrelated-cache')).put(new Request(new URL('qa-sentinel', location.href)), new Response('kept'))
      })
      const before = await snapshot()
      assert.ok(before.cacheInfo.some((cache) => cache.paths.some((path) => path.includes('/player/'))))
      await page.locator('#back-home').click()
      live = 'A'
      await prepareWaiting()
      await page.locator('#apply-update').waitFor({ state: 'visible' })
      await page.locator('#apply-update').click()
      await page.waitForFunction((version) => document.querySelector('#version')?.textContent.includes(version), builds.A.version, { timeout: 30000 })
      await openApplication()
      assert.equal(await page.title(), 'Pletina QA A')
      const after = await snapshot()
      assert.equal(after.scope, before.scope)
      assert.equal(after.registrations, 1)
      assert.deepEqual(after.cacheInfo.map((cache) => cache.version), [builds.A.version])
      assert.equal(after.cacheInfo.some((cache) => cache.paths.some((path) => path.includes('/player/'))), false)
      const preserved = await page.evaluate(async () => ({
        sentinel: localStorage.getItem('qa:migration-sentinel'), unrelatedCache: (await caches.keys()).includes('qa:unrelated-cache'),
      }))
      assert.deepEqual(preserved, { sentinel: 'kept', unrelatedCache: true })
      return { prototypeVersion: report.prototypeVersion, newVersion: builds.A.version, scope: after.scope,
        registrationCount: after.registrations, manifestIdentityUnchanged: true, legacyPlayerCacheRemoved: true,
        localStoragePreserved: true, unrelatedCachePreserved: true, osShortcutMigrationVerified: false }
    })
    await migrationContext.close()
    page = null
  } else report.pending = ['Prototype migration requires --prototype pointing to an existing compiled prototype.']
} catch (error) {
  report.fatal = scrub(error.message)
} finally {
  gate?.release.resolve()
  await browser?.close().catch(() => {})
  if (server) {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections() })
    report.localServerClosed = !server.listening
  }
  if (temporary) {
    assert.equal(dirname(resolve(temporary)), resolve(tmpdir()))
    assert.match(basename(temporary), /^pletina-update-browser-/)
    await rm(temporary, { recursive: true, force: true })
    report.temporarySiteRemoved = true
  }
  report.blockedExternalHosts = [...blockedHosts].sort()
  report.finishedAt = new Date().toISOString()
  report.passed = !report.fatal && report.checks.length >= (option('--prototype', null) ? 7 : 6)
    && report.checks.every((check) => check.pass) && report.errors.length === 0
  await mkdir(artifactDirectory, { recursive: true })
  await writeFile(join(artifactDirectory, reportName), `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`Report: artifacts/pwa-port/${reportName}; ${report.passed ? 'PASS' : 'FAIL'}\n`)
  if (!report.passed) process.exitCode = 1
}
