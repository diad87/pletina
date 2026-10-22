// Real desktop Chrome, temporary profile/site, no musical network or production output changes.
// node scripts/tests/pwa-update.browser.mjs --playwright packageOrPath --chrome executable
//   [--application dist-web-port] [--prototype pathToOldDist] [--report update-browser.json]
//   [--cold-only] [--shell-source readonlyPwaSourceSnapshot]
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
const coldOnly = args.includes('--cold-only')
const traceMigrationReceiver = args.includes('--trace-migration-receiver')
const migrationCDP = args.includes('--migration-cdp')
assert.ok(!coldOnly || !option('--prototype', null), '--cold-only cannot also test prototype migration')
const { chromium } = createRequire(import.meta.url)(option('--playwright', 'playwright'))
const browserOptions = { headless: true, ...(option('--chrome', null) ? { executablePath: option('--chrome') } : {}) }
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
  playlistFixture: coldOnly ? 'No playlist or metadata fixture is seeded in the cold-installer-only run.' : 'Created through app UI; two duplicate local metadata entries seeded directly in test IndexedDB. No signed URLs.',
  audioFixture: coldOnly ? 'No audio fixture is seeded in the cold-installer-only run.' : 'Known PCM WAV bytes seeded in the product download database and CacheStorage. Persistence and SW route bytes only; no playback or YouTube download claim.',
  runKind: coldOnly ? 'cold-installer-update-only' : 'cold-installer-and-opened-application-updates',
}
const scrub = (value) => String(value ?? '').replace(/https?:\/\/[^\s"'<>]+/g, '[URL]')
  .replace(/[A-Z]:[\\/][^\s\n"']+/gi, '[path]').replace(/\u001b\[[0-9;]*m/g, '').slice(0, 700)
let temporary, browser, server, page, gate, live = 'A', phase = 'setup', origin
const servers = new Map(), requests = [], blockedHosts = new Set()
let failingPath = null
const migrationTraceWorkers = []
async function collectMigrationTrace() {
  if (!traceMigrationReceiver || migrationTraceWorkers.length === 0) return
  report.prototypeReceiverTrace = await Promise.all(migrationTraceWorkers.map(async ({ worker, version }) => {
    try {
      return { version, ...await worker.evaluate(() => ({ observedVersion: typeof VERSION === 'string' ? VERSION : null,
        traceReset: !globalThis.__qaMigrationTrace, entries: globalThis.__qaMigrationTrace ?? [] })) }
    } catch (error) { return { version, error: scrub(error.message) } }
  }))
}
async function workerDiagnostics() {
  // The ServiceWorker domain belongs to a page target, not Chrome's Browser target.
  const session = await page.context().newCDPSession(page)
  const versions = [], registrations = [], errors = []
  const path = value => { try { return new URL(value).pathname } catch { return scrub(value) } }
  session.on('ServiceWorker.workerVersionUpdated', event => versions.push(...event.versions.map(version => ({
    versionId: version.versionId, registrationId: version.registrationId, targetId: version.targetId ?? null,
    scriptPath: path(version.scriptURL), status: version.status, runningStatus: version.runningStatus,
    controlledClients: version.controlledClients,
  }))))
  session.on('ServiceWorker.workerRegistrationUpdated', event => registrations.push(...event.registrations.map(registration => ({
    registrationId: registration.registrationId, scopePath: path(registration.scopeURL), isDeleted: registration.isDeleted,
  }))))
  session.on('ServiceWorker.workerErrorReported', event => errors.push({ ...event.errorMessage,
    errorMessage: scrub(event.errorMessage.errorMessage), sourceURL: path(event.errorMessage.sourceURL) }))
  try {
    await session.send('ServiceWorker.enable')
    let targetInfos = [], targetError = null
    try { ({ targetInfos } = await session.send('Target.getTargets')) }
    catch (error) { targetError = scrub(error.message) }
    await new Promise(resolve => setTimeout(resolve, 100))
    return { kind: 'Passive CDP snapshot; no worker method was invoked or replaced.', versions, registrations, errors,
      errorScope: 'Only worker errors emitted during this snapshot; absence does not establish no earlier worker error.', targetError,
      targets: targetInfos.filter(target => target.type === 'service_worker' && target.url.startsWith(origin)).map(target => ({
        targetId: target.targetId, type: target.type, scriptPath: path(target.url), attached: target.attached,
      })) }
  } finally { await session.detach() }
}
async function check(name, action) {
  process.stdout.write(`${name} ... `)
  try {
    const details = await action()
    report.checks.push({ name, pass: true, ...details })
    process.stdout.write('passed\n')
  } catch (error) {
    report.checks.push({ name, pass: false, error: scrub(error.message) })
    if (phase.startsWith('cold-') && page) {
      report.coldFailure = await coldState().catch(failure => ({ diagnosticError: scrub(failure.message) }))
      report.coldFailure.requests = requests.filter(request => request.phase.startsWith('cold-'))
      await page.screenshot({ path: join(artifactDirectory, reportName.replace(/\.json$/, '-cold-failure.png')), fullPage: true }).catch(() => {})
    }
    if (phase === 'prototype-migration' && page) {
      report.prototypeFailure = await coldState().catch(failure => ({ diagnosticError: scrub(failure.message) }))
      report.prototypeFailure.requests = requests.filter(request => request.phase === phase)
      await page.screenshot({ path: join(artifactDirectory, reportName.replace(/\.json$/, '-migration-failure.png')), fullPage: true }).catch(() => {})
    }
    if (!phase.startsWith('cold-') && phase !== 'prototype-migration' && page) {
      report.updateFailure = { phase, ...await coldState().catch(failure => ({ diagnosticError: scrub(failure.message) })) }
      report.updateFailure.requests = requests.filter(request => request.phase === phase)
      await page.screenshot({ path: join(artifactDirectory, reportName.replace(/\.json$/, '-update-failure.png')), fullPage: true }).catch(() => {})
    }
    if (browser?.isConnected()) report.workerDiagnostic = await workerDiagnostics().catch(error => ({ error: scrub(error.message) }))
    if (phase === 'prototype-migration') await collectMigrationTrace()
    process.stdout.write('FAILED\n')
    throw error
  }
}
const defer = () => {
  let resolve
  const promise = new Promise((yes) => { resolve = yes })
  return { promise, resolve }
}
function waveFixture() {
  const result = Buffer.alloc(44 + 1600)
  result.write('RIFF', 0); result.writeUInt32LE(result.length - 8, 4); result.write('WAVEfmt ', 8)
  result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22)
  result.writeUInt32LE(8000, 24); result.writeUInt32LE(16000, 28); result.writeUInt16LE(2, 32)
  result.writeUInt16LE(16, 34); result.write('data', 36); result.writeUInt32LE(1600, 40)
  return result
}
const fixtureBytes = waveFixture(), fixtureHash = digest(fixtureBytes)
const podcastId = 500000000000101, episodeId = 750000000000101
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
  await waitForWorkerState('active')
}
async function waitForWorkerState(kind) {
  // Playwright 1.62 treats an async predicate's Promise as truthy; poll the
  // resolved boolean ourselves so a false first read cannot advance the server.
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const ready = await page.evaluate(async kind => {
      const registration = await navigator.serviceWorker.getRegistration()
      return kind === 'waiting' ? registration?.waiting?.state === 'installed'
        : Boolean(navigator.serviceWorker.controller && registration?.active?.state === 'activated')
    }, kind)
    if (ready) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('Timed out waiting for service worker state: ' + kind)
}
async function snapshot() {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration()
    const workerState = worker => worker ? { state: worker.state, scriptPath: new URL(worker.scriptURL).pathname } : null
    const cacheInfo = []
    for (const name of await caches.keys()) {
      if (!name.startsWith('pletina-pwa:')) continue
      cacheInfo.push({ version: name.split(':').at(-1), paths: (await (await caches.open(name)).keys()).map((request) => new URL(request.url).pathname).sort() })
    }
    return {
      scope: registration ? new URL(registration.scope).pathname : null,
      registrations: (await navigator.serviceWorker.getRegistrations()).length,
      active: registration?.active?.state ?? null, waiting: registration?.waiting?.state ?? null,
      workers: { controller: workerState(navigator.serviceWorker.controller), active: workerState(registration?.active),
        waiting: workerState(registration?.waiting), installing: workerState(registration?.installing) },
      cacheInfo,
    }
  })
}
async function coldState() {
  return { serviceWorker: await snapshot(), ...await page.evaluate(() => ({
    path: location.pathname, status: document.querySelector('#status')?.textContent,
    version: document.querySelector('#version')?.textContent,
    button: { text: document.querySelector('#open-player')?.textContent, disabled: document.querySelector('#open-player')?.disabled },
    appVisible: Boolean(document.querySelector('.app')), controller: Boolean(navigator.serviceWorker.controller),
    openedBefore: localStorage.getItem('pletina:web:opened'), online: navigator.onLine,
  })) }
}
async function database() {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const operation = indexedDB.open('pletina-web-library')
    operation.onerror = () => reject(new Error('Could not open test library'))
    operation.onsuccess = () => {
      const db = operation.result
      const names = ['playlists', 'entries', 'tracks', 'podcasts', 'progress', 'episodes', 'sources', 'meta']
      const transaction = db.transaction(names)
      const result = { version: db.version, episodeIdentityUnique: transaction.objectStore('episodes').index('identity').unique }
      for (const name of names) {
        const request = transaction.objectStore(name).getAll()
        request.onsuccess = () => { result[name] = request.result }
      }
      transaction.oncomplete = () => { db.close(); resolve(result) }
      transaction.onabort = () => { db.close(); reject(new Error('Could not read test library')) }
    }
  }))
}
async function seedLegacyLibrary() {
  await page.evaluate(({ podcastId, episodeId }) => new Promise((resolve, reject) => {
    const operation = indexedDB.open('pletina-web-library', 1)
    operation.onupgradeneeded = () => {
      const db = operation.result
      const stores = ['tracks', 'likes', 'albums', 'artists', 'podcasts', 'playlists', 'entries', 'history', 'progress', 'youtube', 'sources', 'meta']
      for (const name of stores) db.createObjectStore(name, {
        keyPath: name === 'likes' ? 'trackId' : ['entries', 'history'].includes(name) ? 'entryId'
          : ['youtube', 'sources'].includes(name) ? 'trackId' : name === 'meta' ? 'key' : 'id',
        autoIncrement: ['playlists', 'entries', 'history'].includes(name),
      })
      operation.transaction.objectStore('entries').createIndex('playlistId', 'playlistId')
      operation.transaction.objectStore('youtube').createIndex('videoId', 'videoId', { unique: true })
    }
    operation.onerror = () => reject(new Error('Could not seed v1 library'))
    operation.onsuccess = () => {
      const db = operation.result, tx = db.transaction(['podcasts', 'progress', 'meta'], 'readwrite')
      tx.objectStore('podcasts').put({ id: podcastId, at: 1700000000, order: 1, saved: true, value: {
        id: podcastId, title: 'Podcast de QA', author: 'Autor de QA', description: 'Metadatos locales de prueba',
        image: null, feedUrl: 'https://podcast.example/qa.xml', language: 'es', episodeCount: 1,
      } })
      tx.objectStore('progress').put({ id: episodeId, position: 57, duration: 600, completed: false })
      tx.objectStore('meta').put({ key: 'order', value: 1 })
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onabort = () => { db.close(); reject(new Error('Could not commit v1 fixtures')) }
    }
  }), { podcastId, episodeId })
}
async function seedDownloadAndEpisode() {
  await page.evaluate(async ({ bytes, episodeId, podcastId }) => {
    const track = { id: 101, title: 'Canción de QA', duration: 180, explicit: false,
      artistId: 1, artistName: 'Artista de QA', albumId: 1, albumTitle: 'Álbum de QA', albumArtistId: 1, cover: null }
    const root = new URL('../', location.href)
    const key = new URL(`__audio__/101?stage=${Date.now()}-${crypto.randomUUID()}`, root).href
    await (await caches.open('pletina-audio-downloads:v1')).put(key, new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'audio/wav' } }))
    await new Promise((resolve, reject) => {
      const opening = indexedDB.open('pletina-web-downloads', 1)
      opening.onupgradeneeded = () => opening.result.createObjectStore('files', { keyPath: 'id' })
      opening.onerror = () => reject(new Error('Could not open download fixture database'))
      opening.onsuccess = () => {
        const db = opening.result, tx = db.transaction('files', 'readwrite')
        tx.objectStore('files').put({ id: 101, track, size: bytes.length, at: 1700000000, cacheKey: key })
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onabort = () => { db.close(); reject(new Error('Could not commit download fixture')) }
      }
    })
    await new Promise((resolve, reject) => {
      const opening = indexedDB.open('pletina-web-library')
      opening.onerror = () => reject(new Error('Could not open episode fixture database'))
      opening.onsuccess = () => {
        const db = opening.result, tx = db.transaction(['podcasts', 'episodes'], 'readwrite')
        const request = tx.objectStore('podcasts').get(podcastId)
        request.onsuccess = () => tx.objectStore('podcasts').put({ ...request.result, episodeIds: [episodeId] })
        tx.objectStore('episodes').put({ id: episodeId, podcastId, guid: 'qa-stable-episode', value: {
          id: episodeId, title: 'Episodio de QA', description: 'Metadatos persistidos', publishedAt: null,
          duration: 600, audioUrl: 'https://podcast.example/qa-episode.mp3', image: null, explicit: false,
        } })
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onabort = () => { db.close(); reject(new Error('Could not commit episode fixture')) }
      }
    })
  }, { bytes: [...fixtureBytes], episodeId, podcastId })
}
async function downloadSnapshot() {
  return page.evaluate(async () => {
    const rows = await new Promise((resolve, reject) => {
      const opening = indexedDB.open('pletina-web-downloads')
      opening.onerror = () => reject(new Error('Could not read download fixture'))
      opening.onsuccess = () => {
        const db = opening.result, tx = db.transaction('files'), request = tx.objectStore('files').getAll()
        request.onsuccess = () => { const rows = request.result; tx.oncomplete = () => { db.close(); resolve(rows) } }
        tx.onabort = () => { db.close(); reject(new Error('Could not read download fixture')) }
      }
    })
    const saved = rows.find(row => row.id === 101)
    if (!saved) throw new Error('Download metadata vanished')
    const cache = await caches.open('pletina-audio-downloads:v1'), cached = await cache.match(saved.cacheKey)
    if (!cached) throw new Error('Cached download bytes vanished')
    const hash = async response => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await response.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, '0')).join('')
    const cachedSha256 = await hash(cached)
    const stable = new URL('../__audio__/101', location.href), response = await fetch(stable)
    return { rows, stablePath: stable.pathname, status: response.status, cachedSha256, servedSha256: await hash(response),
      online: navigator.onLine, controlled: Boolean(navigator.serviceWorker.controller), cacheName: 'pletina-audio-downloads:v1' }
  })
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
  await waitForWorkerState('waiting')
}

try {
  await mkdir(artifactDirectory, { recursive: true })
  temporary = await mkdtemp(join(tmpdir(), 'pletina-update-browser-'))
  const shell = join(temporary, 'shell')
  await cp(resolve(workspace, option('--shell-source', sourceDirectory)), shell, { recursive: true })
  report.sourceShellAppSha256 = digest(await readFile(join(shell, 'app.js')))
  const application = resolve(workspace, option('--application', 'dist-web-port'))
  const applicationSnapshot = join(temporary, 'application-base')
  await cp(application, applicationSnapshot, { recursive: true })
  const baseBuild = await buildPwa({ source: shell, application: applicationSnapshot, output: join(temporary, 'site-base') })
  report.baseDistributionVersion = baseBuild.version
  process.stdout.write('Immutable source snapshot ready: ' + baseBuild.version + '\n')
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
    const observed = { phase, version, path: pathname }
    requests.push(observed)
    response.once('finish', () => { observed.status = response.statusCode })
    if (pathname === failingPath) { response.writeHead(503, { 'Cache-Control': 'no-store' }); response.end('QA interrupted download'); return }
    if (gate?.path === pathname && version === 'B') { gate.entered.resolve(); await gate.release.promise }
    servers.get(version).emit('request', request, response)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${server.address().port}`
  const url = `${origin}/pletina/`
  browser = await chromium.launch(browserOptions)
  report.browser = browser.version()
  const coldContext = await context()
  page = await newPage(coldContext)
  const retiredA = builds.A.optionalFiles.filter(path => !builds.B.optionalFiles.includes(path)).map(path => '/pletina/' + path)
  const allOptional = new Set([...builds.A.optionalFiles, ...builds.B.optionalFiles].map(path => '/pletina/' + path))
  report.coldInstaller = { applicationOpenedBeforeUpdate: false, retiredOptionalPaths: retiredA }
  phase = 'cold-minimal-A-waiting-B'
  await check('cold installer A waits for B without ever requesting or caching the application', async () => {
    live = 'A'
    await page.goto(url, { waitUntil: 'load' }); await installed()
    const initial = await coldState()
    assert.ok(initial.version.includes(builds.A.version))
    assert.equal(initial.openedBefore, null)
    assert.equal(initial.appVisible, false)
    assert.equal(requests.filter(request => request.phase === phase && allOptional.has(request.path)).length, 0)
    assert.equal(initial.serviceWorker.cacheInfo.flatMap(cache => cache.paths).filter(path => allOptional.has(path)).length, 0)
    live = 'B'; await prepareWaiting()
    const waiting = await coldState()
    assert.equal(waiting.serviceWorker.waiting, 'installed')
    assert.ok(waiting.version.includes(builds.A.version))
    assert.equal(waiting.serviceWorker.cacheInfo.flatMap(cache => cache.paths).filter(path => allOptional.has(path)).length, 0)
    assert.equal(requests.filter(request => request.phase === phase && allOptional.has(request.path)).length, 0)
    report.coldInstaller.beforeOpen = waiting
    return { oldVersion: builds.A.version, waitingVersion: builds.B.version, initialOptionalDownloads: 0, applicationOpened: false }
  })
  phase = 'cold-primary-open-failed'
  failingPath = '/pletina/' + builds.B.applicationPage
  await check('cold primary open prepares waiting B and a failed preparation preserves A with a visible retry', async () => {
    await page.locator('#open-player').click()
    await page.locator('#status').filter({ hasText: 'No se pudo' }).waitFor({ timeout: 20000 })
    await page.waitForFunction(() => !document.querySelector('#open-player').disabled)
    const state = await coldState()
    report.coldInstaller.failedPreparation = state
    assert.equal(state.serviceWorker.waiting, 'installed')
    assert.ok(state.version.includes(builds.A.version))
    assert.equal(state.appVisible, false)
    assert.equal(state.path, '/pletina/')
    const messages = report.messages.filter(message => message.phase === phase)
    assert.ok(messages.some(message => message.type === 'PREPARE_APPLICATION' && message.state === 'installed'), 'Primary open must prepare the waiting worker before importing any retired A launcher')
    assert.equal(messages.filter(message => message.type === 'ACTIVATE_UPDATE').length, 0)
    assert.ok(requests.some(request => request.phase === phase && request.path === failingPath && request.status === 503), 'Preparation must actually fetch the failing B application')
    assert.equal(requests.filter(request => request.phase.startsWith('cold-') && retiredA.includes(request.path)).length, 0, 'The primary action must not request retired A optional files')
    assert.deepEqual(state.serviceWorker.cacheInfo.find(cache => cache.version === builds.A.version),
      report.coldInstaller.beforeOpen.serviceWorker.cacheInfo.find(cache => cache.version === builds.A.version),
      'Every active A cached resource must survive failed preparation')
    return { waitingVersion: builds.B.version, activationMessages: 0, retryEnabled: true, activeACachePreserved: true }
  })
  phase = 'cold-primary-open-retry'
  failingPath = null
  gate = { path: '/pletina/' + builds.B.applicationPage, entered: defer(), release: defer() }
  await check('cold primary retry prepares all of B before activation, opens it automatically and reloads offline', async () => {
    await page.locator('#open-player').click()
    let timeout
    try { await Promise.race([gate.entered.promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Cold retry never requested the gated B application')), 20000) })]) }
    finally { clearTimeout(timeout) }
    assert.equal((await snapshot()).waiting, 'installed')
    assert.equal(await page.locator('#open-player').isDisabled(), true)
    assert.ok((await coldState()).version.includes(builds.A.version))
    assert.equal(report.messages.filter(message => message.phase === phase && message.type === 'ACTIVATE_UPDATE').length, 0)
    gate.release.resolve(); gate = null
    await page.waitForURL(origin + '/pletina/' + builds.B.applicationPage, { waitUntil: 'load', timeout: 30000 })
    await page.locator('.app .sidebar').waitFor()
    assert.equal(await page.title(), 'Pletina QA B')
    const messages = report.messages.filter(message => message.phase === phase).map(message => message.type)
    assert.ok(messages.indexOf('PREPARE_APPLICATION') >= 0)
    assert.ok(messages.indexOf('ACTIVATE_UPDATE') > messages.indexOf('PREPARE_APPLICATION'))
    assert.equal(requests.filter(request => request.phase.startsWith('cold-') && retiredA.includes(request.path)).length, 0)
    const installedB = await snapshot()
    assert.deepEqual(installedB.cacheInfo.map(cache => cache.version), [builds.B.version])
    for (const path of builds.B.optionalFiles) assert.ok(installedB.cacheInfo[0].paths.includes('/pletina/' + path))
    await coldContext.setOffline(true)
    await page.reload({ waitUntil: 'load', timeout: 20000 })
    await page.locator('.app .sidebar').waitFor()
    assert.equal(await page.title(), 'Pletina QA B')
    assert.equal(await page.evaluate(() => navigator.onLine), false)
    assert.equal((await snapshot()).waiting, null)
    report.coldInstaller.completed = { messageOrder: messages, oldOptionalRequests: 0, offline: true }
    return { newApplicationPath: new URL(page.url()).pathname, messageOrder: messages, allOptionalFilesCached: true, oldOptionalRequests: 0, offline: true }
  })
  await coldContext.close(); page = null
  failingPath = null; live = 'A'
  if (!coldOnly) {
  const fullContext = await context()
  page = await newPage(fullContext)
  const playlistName = 'QA actualización persistente'
  let expectedDatabase, expectedDownload
  phase = 'full-A'
  await check('full A installs without application downloads; app opens on demand', async () => {
    await page.goto(url, { waitUntil: 'load' })
    await installed()
    assert.equal(requests.filter((request) => request.phase === phase && request.path.includes('/application/')).length, 0)
    await seedLegacyLibrary()
    await openApplication()
    assert.equal(await page.title(), 'Pletina QA A')
    const state = await snapshot()
    assert.equal(state.scope, '/pletina/')
    assert.equal(state.registrations, 1)
    const library = await database()
    assert.equal(library.version, 2)
    assert.equal(library.episodeIdentityUnique, true)
    assert.equal(library.podcasts[0].id, podcastId)
    assert.deepEqual(library.progress, [{ id: episodeId, position: 57, duration: 600, completed: false }])
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
  await check('v1 podcast progress upgrades intact; v2 episode and known WAV fixture are durable before update', async () => {
    await seedDownloadAndEpisode()
    expectedDatabase = await database()
    expectedDownload = await downloadSnapshot()
    assert.equal(expectedDatabase.version, 2)
    assert.equal(expectedDatabase.episodes[0].guid, 'qa-stable-episode')
    assert.equal(expectedDatabase.progress[0].position, 57)
    assert.equal(expectedDownload.cachedSha256, fixtureHash)
    assert.equal(expectedDownload.servedSha256, fixtureHash)
    assert.equal(expectedDownload.status, 200)
    report.downloadFixture = { trackId: 101, bytes: fixtureBytes.length, sha256: fixtureHash, stablePath: expectedDownload.stablePath,
      playbackTested: false, providerDownloaded: false }
    return { librarySchemaFrom: 1, librarySchemaTo: expectedDatabase.version, podcastId, episodeId,
      progress: expectedDatabase.progress[0], download: report.downloadFixture }
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
    assert.deepEqual(await downloadSnapshot(), expectedDownload)
    const messageMark = report.messages.length
    await page.goto(url + '?open=app', { waitUntil: 'load' })
    await page.waitForURL(/\/application\/index\.[a-f0-9]{16}\.html$/, { waitUntil: 'load', timeout: 30000 })
    await page.locator('.app .sidebar').waitFor()
    report.warmReentry = { title: await page.title(), ...await coldState(), messages: report.messages.slice(messageMark) }
    assert.equal(report.warmReentry.title, 'Pletina QA A', 'Automatic re-entry must reopen cached A while B waits for an explicit update gesture')
    assert.equal(report.warmReentry.messages.filter(message => ['PREPARE_APPLICATION', 'ACTIVATE_UPDATE'].includes(message.type)).length, 0,
      'Automatic re-entry must not prepare or activate B without an explicit update gesture')
    assert.equal((await snapshot()).waiting, 'installed')
    assert.deepEqual(await database(), expectedDatabase)
    assert.deepEqual(await downloadSnapshot(), expectedDownload)
    await page.locator('.web-update button').waitFor()
    return { waitingVersion: builds.B.version, currentApplication: 'A', initialOptionalDownloads: 0, automaticReentryKeptA: true, automaticUpdateMessages: 0 }
  })
  phase = 'failed-preparation'
  failingPath = `/pletina/${builds.B.applicationPage}`
  await check('a failed application preparation keeps A active and the playlist intact', async () => {
    await page.locator('.web-update button').click()
    await page.locator('.web-update').filter({ hasText: 'No se pudo completar la actualización' }).waitFor()
    assert.equal(await page.title(), 'Pletina QA A')
    assert.equal((await snapshot()).waiting, 'installed')
    assert.deepEqual(await database(), expectedDatabase)
    assert.deepEqual(await downloadSnapshot(), expectedDownload)
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
    assert.deepEqual(await downloadSnapshot(), expectedDownload)
    gate.release.resolve()
    gate = null
    await page.waitForURL(`${origin}/pletina/${builds.B.applicationPage}`, { waitUntil: 'load', timeout: 30000 })
    await page.locator('.app .sidebar').waitFor()
    assert.equal(await page.title(), 'Pletina QA B')
    const messages = report.messages.filter((message) => message.phase === phase).map((message) => message.type)
    assert.ok(messages.indexOf('PREPARE_APPLICATION') >= 0)
    assert.ok(messages.indexOf('ACTIVATE_UPDATE') > messages.indexOf('PREPARE_APPLICATION'))
    assert.deepEqual(await database(), expectedDatabase)
    assert.deepEqual(await downloadSnapshot(), expectedDownload)
    const state = await snapshot()
    assert.equal(state.waiting, null)
    assert.deepEqual(state.cacheInfo.map((cache) => cache.version), [builds.B.version])
    for (const path of builds.B.optionalFiles) assert.ok(state.cacheInfo[0].paths.includes(`/pletina/${path}`), `Cached ${path}`)
    return { messageOrder: messages, newApplicationPath: new URL(page.url()).pathname,
      cachedOptionalFiles: builds.B.optionalFiles.length, preservedDatabase: true }
  })
  phase = 'offline-B'
  await check('updated B reopens offline with playlist, podcast progress and identical downloaded/cache-route bytes', async () => {
    await fullContext.setOffline(true)
    await page.reload({ waitUntil: 'load', timeout: 20000 })
    await openPlaylist(playlistName)
    assert.equal(await page.title(), 'Pletina QA B')
    assert.deepEqual(await database(), expectedDatabase)
    const downloaded = await downloadSnapshot()
    assert.deepEqual({ ...downloaded, online: true }, expectedDownload)
    assert.equal(downloaded.online, false)
    assert.equal(downloaded.cachedSha256, fixtureHash)
    assert.equal(downloaded.servedSha256, fixtureHash)
    return { online: await page.evaluate(() => navigator.onLine), playlistId: expectedDatabase.playlists[0].id,
      entryIds: expectedDatabase.entries.map((row) => row.entryId), podcastId, episodeId,
      podcastPosition: expectedDatabase.progress[0].position, downloadedTrackId: 101,
      cachedSha256: downloaded.cachedSha256, swRouteSha256: downloaded.servedSha256, swRouteStatus: downloaded.status,
      downloadedBytes: fixtureBytes.length, fixturePlaybackClaimed: false, providerDownloadClaimed: false }
  })
  await fullContext.close()
  page = null

  const prototype = option('--prototype', null)
  if (prototype) {
    // This migration has an independent cold profile and data. Recreate Chrome,
    // too: accumulated prior-context state stalled native skipWaiting in the
    // combined QA process; the isolated real-distribution controls did not.
    const previousBrowserVersion = browser.version()
    await browser.close()
    report.migrationBrowserIsolation = { previousBrowserClosed: !browser.isConnected(),
      mode: 'Fresh disposable Chrome process with the same launch options; no previous test contexts or emulation.', previousBrowserVersion }
    browser = await chromium.launch(browserOptions)
    report.migrationBrowserIsolation.migrationBrowserVersion = browser.version()
    assert.equal(browser.version(), previousBrowserVersion)
    phase = 'prototype-migration'
    const old = join(temporary, 'prototype')
    await cp(resolve(prototype), old, { recursive: true })
    const worker = await readFile(join(old, 'sw.js'), 'utf8')
    report.prototypeVersion = worker.match(/const VERSION = "([a-f0-9]{16})"/)?.[1] ?? null
    const previousOptional = JSON.parse(worker.match(/const OPTIONAL = (\[[^\n]+\])/)?.[1] ?? '[]').map(file => file.url)
    const previousFull = previousOptional.some(path => path.startsWith('application/'))
    const oldManifest = JSON.parse(await readFile(join(old, 'manifest.webmanifest'), 'utf8'))
    assert.deepEqual({ id: oldManifest.id, scope: oldManifest.scope, start_url: oldManifest.start_url }, report.manifestIdentity)
    servers.set('prototype', createPwaServer({ directory: old }))
    live = 'prototype'
    const migrationContext = await context()
    page = await newPage(migrationContext)
    const migrationSession = migrationCDP ? await migrationContext.newCDPSession(page) : null
    report.prototypeCDP = { enabled: migrationCDP, scope: migrationCDP ? 'Passive page-target ServiceWorker observation enabled before the migration; no worker methods invoked or replaced.' : 'ServiceWorker CDP domain is not enabled before the migration.', events: [], errors: [] }
    migrationSession?.on('ServiceWorker.workerVersionUpdated', event => report.prototypeCDP.events.push({ at: new Date().toISOString(), versions: event.versions.map(value => ({
      versionId: value.versionId, registrationId: value.registrationId, targetId: value.targetId ?? null,
      scriptPath: new URL(value.scriptURL).pathname, status: value.status, runningStatus: value.runningStatus, controlledClients: value.controlledClients,
    })) }))
    migrationSession?.on('ServiceWorker.workerErrorReported', event => {
      const error = { phase, kind: 'workererror', ...event.errorMessage, errorMessage: scrub(event.errorMessage.errorMessage), sourceURL: scrub(event.errorMessage.sourceURL) }
      report.prototypeCDP.errors.push(error); report.errors.push(error)
    })
    await migrationSession?.send('ServiceWorker.enable')
    try { await check(previousFull ? 'existing cold full distribution migrates through explicit legacy update and the same scope'
      : 'existing prototype migrates to full app through the same scope and manifest identity', async () => {
      await page.goto(url, { waitUntil: 'load' })
      await installed()
      if (!previousFull) {
        await page.locator('#open-player').click()
        await page.waitForFunction(() => !document.querySelector('#player-screen').hidden)
      }
      await page.evaluate(async () => {
        localStorage.setItem('qa:migration-sentinel', 'kept')
        await (await caches.open('qa:unrelated-cache')).put(new Request(new URL('qa-sentinel', location.href)), new Response('kept'))
      })
      const before = await snapshot()
      if (previousFull) {
        assert.equal(before.cacheInfo.flatMap(cache => cache.paths).filter(path => path.includes('/application/')).length, 0)
        assert.equal(await page.evaluate(() => localStorage.getItem('pletina:web:opened')), null)
      } else {
        assert.ok(before.cacheInfo.some((cache) => cache.paths.some((path) => path.includes('/player/'))))
        await page.locator('#back-home').click()
      }
      live = 'A'
      await prepareWaiting()
      if (traceMigrationReceiver) {
        for (const worker of migrationContext.serviceWorkers()) {
          const version = await worker.evaluate(() => typeof VERSION === 'string' ? VERSION : null).catch(() => null)
          if (version !== report.prototypeVersion && version !== builds.A.version) continue
          migrationTraceWorkers.push({ worker, version })
          await worker.evaluate(() => {
            globalThis.__qaMigrationTrace = []
            const add = value => { if (globalThis.__qaMigrationTrace.length < 100) globalThis.__qaMigrationTrace.push({ at: new Date().toISOString(), ...value }) }
            self.addEventListener('message', event => add({ event: 'message-received', type: typeof event.data?.type === 'string' ? event.data.type.slice(0, 60) : null }))
            const original = self.skipWaiting
            self.skipWaiting = function(...args) {
              add({ event: 'native-skipWaiting-called' })
              let result
              try { result = Reflect.apply(original, this, args) }
              catch (error) { add({ event: 'native-skipWaiting-threw', error: String(error) }); throw error }
              result.then(() => add({ event: 'native-skipWaiting-resolved' }), error => add({ event: 'native-skipWaiting-rejected', error: String(error) }))
              return result
            }
          })
        }
        assert.ok(migrationTraceWorkers.some(value => value.version === report.prototypeVersion))
        assert.ok(migrationTraceWorkers.some(value => value.version === builds.A.version))
        report.prototypeReceiverInstrumentation = 'Diagnostic message observers and delegating wrappers on both real workers, identified by VERSION. Native skipWaiting is never invoked separately; original promise returned unchanged. This instrumented run is diagnostic evidence.'
      }
      await page.locator('#apply-update').waitFor({ state: 'visible' })
      await page.locator('#apply-update').click()
      // Older shells reload to the new installer; the current public full shell
      // records an explicit open intent and enters the prepared application.
      await page.waitForFunction((version) => Boolean(document.querySelector('.app')) ||
        document.querySelector('#version')?.textContent.includes(version) &&
        document.querySelector('#open-player') && !document.querySelector('#open-player').disabled,
      builds.A.version, { timeout: 30000 })
      const newPrimaryOpenUsed = await page.locator('#open-player').isVisible()
      if (newPrimaryOpenUsed) await openApplication()
      else await page.locator('.app .sidebar').waitFor({ state: 'visible', timeout: 20000 })
      assert.equal(await page.title(), 'Pletina QA A')
      await collectMigrationTrace()
      const after = await snapshot()
      assert.equal(after.scope, before.scope)
      assert.equal(after.registrations, 1)
      assert.deepEqual(after.cacheInfo.map((cache) => cache.version), [builds.A.version])
      assert.equal(after.cacheInfo.some((cache) => cache.paths.some((path) => path.includes('/player/'))), false)
      const preserved = await page.evaluate(async () => ({
        sentinel: localStorage.getItem('qa:migration-sentinel'), unrelatedCache: (await caches.keys()).includes('qa:unrelated-cache'),
      }))
      assert.deepEqual(preserved, { sentinel: 'kept', unrelatedCache: true })
      const retired = previousOptional.filter(path => !builds.A.optionalFiles.includes(path)).map(path => '/pletina/' + path)
      assert.equal(requests.filter(request => request.phase === phase && retired.includes(request.path)).length, 0)
      return { prototypeVersion: report.prototypeVersion, newVersion: builds.A.version, scope: after.scope,
        previousDistributionKind: previousFull ? 'cold-full-application' : 'opened-player-prototype',
        previousApplicationOpened: !previousFull, explicitLegacySecondaryUpdateButtonUsed: true,
        newPrimaryOpenUsedAfterUpdate: newPrimaryOpenUsed,
        newApplicationAutoOpenedAfterExplicitUpdate: !newPrimaryOpenUsed,
        legacyPrimaryAutoMigrationClaimed: false, retiredOptionalRequests: 0,
        registrationCount: after.registrations, manifestIdentityUnchanged: true, oldVersionCacheRemoved: true,
        ...(!previousFull ? { legacyPlayerCacheRemoved: true } : {}),
        localStoragePreserved: true, unrelatedCachePreserved: true, osShortcutMigrationVerified: false }
    }) } finally { await migrationSession?.detach() }
    await migrationContext.close()
    page = null
  } else report.pending = ['Prototype migration requires --prototype pointing to an existing compiled prototype.']
  }
} catch (error) {
  report.fatal = scrub(error.message)
} finally {
  gate?.release.resolve()
  await browser?.close().catch(() => {})
  report.browserClosed = !browser || !browser.isConnected()
  report.browserProfile = 'Disposable Playwright launch profile; browser.close releases it.'
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
  report.passed = !report.fatal && report.checks.length >= (coldOnly ? 3 : option('--prototype', null) ? 11 : 10)
    && report.checks.every((check) => check.pass) && report.errors.length === 0
  await mkdir(artifactDirectory, { recursive: true })
  await writeFile(join(artifactDirectory, reportName), `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`Report: artifacts/pwa-port/${reportName}; ${report.passed ? 'PASS' : 'FAIL'}\n`)
  if (!report.passed) process.exitCode = 1
}
