// Compiled PWA backup UI, real browser file download/upload and IndexedDB.
// The existing HTTP provider fixtures supply only synthetic public metadata and
// silence. No product module is injected or invoked by this runner.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createPwaServer } from '../preview-pwa.mjs'
import { createHarness, scrub } from './e2e/harness.mjs'

const args = process.argv.slice(2), option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const workspace = fileURLToPath(new URL('../../', import.meta.url)), require = createRequire(import.meta.url)
const expectedBuild = option('--expected-build', ''); assert.match(expectedBuild, /^[a-f0-9]{16}$/)
const engines = option('--engines', 'chromium,firefox,webkit').split(',')
assert.ok(engines.length > 0 && new Set(engines).size === engines.length && engines.every(value => ['chromium', 'firefox', 'webkit'].includes(value)))
const browsers = option('--browsers', process.env.PLAYWRIGHT_BROWSERS_PATH ?? (existsSync('D:/tmp/pletina-e2e-browsers') ? 'D:/tmp/pletina-e2e-browsers' : null))
if (browsers) process.env.PLAYWRIGHT_BROWSERS_PATH = browsers
const playwright = require(option('--playwright', 'playwright'))
const dist = resolve(option('--dist', join(workspace, 'dist-pwa'))), worker = await readFile(join(dist, 'sw.js'), 'utf8')
assert.equal(worker.match(/const VERSION = "([a-f0-9]{16})"/)?.[1], expectedBuild, 'Use the frozen compiled distribution')
const output = resolve(option('--output', join(workspace, 'artifacts/pwa-e2e', `library-backup-${expectedBuild}-${new Date().toISOString().replace(/[:.]/g, '-')}`)))
await mkdir(output, { recursive: true })
const sha = value => crypto.createHash('sha256').update(value).digest('hex')
const source = await readFile(new URL(import.meta.url)), runnerHash = sha(source)
const qaFiles = ['scripts/tests/library-backup.browser.mjs', 'scripts/tests/e2e/harness.mjs', 'scripts/tests/e2e/provider-fixtures.mjs', 'scripts/tests/e2e/webkit-network-transport.mjs']
const sourceBindings = await Promise.all(qaFiles.map(async path => ({ path, sha256: sha(await readFile(join(workspace, path))) })))
const summary = { schemaVersion: 1, startedAt: new Date().toISOString(), build: expectedBuild, runnerSha256: runnerHash, sourceBindings,
  scope: 'Compiled PWA UI with synthetic HTTP metadata/silence fixtures; real file download/upload, IndexedDB and CacheStorage assertions. Desktop Chromium, Firefox and WebKit only; no physical mobile or APK migration.',
  policy: { productModulesReplaced: false, productAPIsInvokedByQA: false, browserStorageWritesByQA: false, providerMode: 'HTTP fixtures',
    audioObserver: 'Existing harness observer; not a media or audible-playback accreditation.', backupIncludesAudio: false, APKPrivateStorageAccess: false },
  engines: [], errors: [] }
await writeFile(join(output, `library-backup-source-${runnerHash.slice(0, 16)}.mjs`), source)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let server, browser, puppeteerBrowser
const platformTransports = []

async function chromiumBridge({ context, page, report }) {
  let handler
  const marker = 'about:blank#pletina-backup-' + crypto.randomUUID()
  const target = puppeteerBrowser.waitForTarget(target => target.type() === 'page' && target.url() === marker, { timeout: 15000 })
  await page.goto(marker); const primary = await (await target).page(); assert.ok(primary)
  await primary.setRequestInterception(true)
  primary.on('request', request => {
    if (request.isInterceptResolutionHandled()) return
    if (!handler) { void request.continue(); return }
    const wrapped = { url: () => request.url(), method: () => request.method(), resourceType: () => request.resourceType(), frame: () => request.frame(),
      failure: () => request.failure(), headers: () => request.headers(), postDataJSON: () => JSON.parse(request.postData() || '{}') }
    const route = { request: () => wrapped, continue: () => request.continue(), abort: (code = 'failed') => request.abort(code),
      fulfill: value => request.respond({ status: value.status ?? 200, headers: value.headers, contentType: value.contentType, body: value.body }) }
    Promise.resolve(handler(route)).catch(async error => {
      if (page.isClosed()) return
      report.errors.push({ name: 'ProviderTransportError', message: scrub(error.message) })
      if (!request.isInterceptResolutionHandled()) await request.abort('failed').catch(() => {})
    })
  })
  report.networkTransport = 'Existing fixture contract through Puppeteer HTTP interception; real compiled UI and storage.'
  return { pages: () => context.pages(), route: async (_pattern, value) => { handler = value } }
}

async function inspect(page) {
  // Read-only inspection: never opens a nonexistent schema or writes rows.
  return page.evaluate(async () => {
    const library = await new Promise((resolve, reject) => {
      const request = indexedDB.open('pletina-web-library')
      request.onupgradeneeded = () => request.transaction.abort()
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result, names = [...db.objectStoreNames], rows = {}, tx = db.transaction(names, 'readonly')
        tx.oncomplete = () => { db.close(); resolve(rows) }; tx.onabort = () => { db.close(); reject(tx.error ?? Error('Inspection aborted')) }
        for (const name of names) { const item = tx.objectStore(name).getAll(); item.onsuccess = () => { rows[name] = item.result } }
      }
    })
    const cacheNames = await caches.keys(), cacheKeys = {}
    for (const name of cacheNames.filter(value => value === 'pletina-audio-downloads:v1')) cacheKeys[name] = (await (await caches.open(name)).keys()).map(value => value.url).sort()
    const names = typeof indexedDB.databases === 'function' ? (await indexedDB.databases()).map(value => value.name) : []
    const downloadDB = names.includes('pletina-web-downloads') ? await new Promise((resolve, reject) => {
      const request = indexedDB.open('pletina-web-downloads'); request.onupgradeneeded = () => request.transaction.abort(); request.onerror = () => reject(request.error)
      request.onsuccess = () => { const db = request.result, names = [...db.objectStoreNames], rows = {}, tx = db.transaction(names, 'readonly');
        tx.oncomplete = () => { db.close(); resolve(rows) }; tx.onabort = () => { db.close(); reject(tx.error) }
        for (const name of names) { const item = tx.objectStore(name).getAll(); item.onsuccess = () => { rows[name] = item.result } }
      }
    }) : null
    return { library, downloadDB, cacheKeys }
  })
}
const fingerprint = value => sha(JSON.stringify(value))
const counts = value => Object.fromEntries(Object.entries(value.library).map(([key, rows]) => [key, rows.length]))
async function waitForSnapshot(page, predicate, description, timeout = 20000) {
  const deadline = Date.now() + timeout; let last
  do { last = await inspect(page); if (predicate(last)) return last; await delay(100) } while (Date.now() < deadline)
  throw Error(description + ' timed out; counts=' + JSON.stringify(counts(last)))
}
async function libraryButton(ctx, title) { await ctx.tap(ctx.page.locator('.sidebar .items > button.item').filter({ has: ctx.page.locator('.title', { hasText: new RegExp('^' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }) }).first()) }
async function createPlaylist(ctx, name, indexes) {
  await ctx.tap(ctx.page.getByRole('button', { name: 'Importar de Spotify', exact: true }))
  const rows = indexes.map(index => ctx.fixture.tracks[index])
  const csv = 'Title,Artist,Duration (ms)\n' + rows.map(track => `${track.title},${track.artist.name},${track.duration * 1000}`).join('\n')
  await ctx.page.locator('#playlist-csv').setInputFiles({ name: name + '.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
  await ctx.tap(ctx.page.getByRole('button', { name: 'Buscar canciones del CSV', exact: true }))
  await ctx.page.locator('#playlist-name').waitFor(); await ctx.page.locator('#playlist-name').fill(name)
  await ctx.tap(ctx.page.getByRole('button', { name: 'Guardar playlist', exact: true }))
  await ctx.page.locator('.hero h1').filter({ hasText: name }).waitFor()
  assert.deepEqual((await ctx.page.locator('ol.tracks .name').allTextContents()).map(value => value.trim()), rows.map(track => track.title))
  return rows.map(track => track.id)
}
async function seed(ctx, name, indexes, rich) {
  const ids = await createPlaylist(ctx, name, indexes), first = ctx.page.locator('ol.tracks li[data-reorder-index]').first()
  await ctx.tap(first.locator('button.heart'))
  if (rich) {
    await ctx.tap(first.locator('.name'))
    await waitForSnapshot(ctx.page, value => value.library.history.length > 0, 'Real fixture playback recorded in history')
    const pause = ctx.page.locator('.player button[title="Pausa (espacio)"]').first(); await pause.waitFor(); await ctx.tap(pause)
    await ctx.tap(first.locator('.album button.link'))
    await ctx.page.locator('.hero h1').filter({ hasText: ctx.fixture.albums[0].title }).waitFor()
    await ctx.tap(ctx.page.getByRole('button', { name: 'Guardar en tu biblioteca', exact: true }))
    await ctx.tap(ctx.page.locator('.hero .meta button.link').first())
    await ctx.page.locator('.banner h1').waitFor()
    await ctx.tap(ctx.page.locator('button.favorite[title="Añadir a artistas favoritos"]'))
  }
  const value = await waitForSnapshot(ctx.page, value => value.library.playlists.some(row => row.name === name) && value.library.likes.some(row => row.trackId === ids[0]) &&
    (!rich || value.library.albums.length > 0 && value.library.artists.length > 0), 'UI seed is durable')
  return { value, ids }
}
async function backupPage(ctx) { await libraryButton(ctx, 'Copia de seguridad'); await ctx.page.locator('.backup h1').waitFor() }
async function upload(ctx, buffer, name = 'source-backup.json') {
  await ctx.page.getByLabel('Archivo de copia de seguridad', { exact: true }).setInputFiles({ name, mimeType: 'application/json', buffer })
}
async function preview(ctx, bytes) { await upload(ctx, bytes); await ctx.page.locator('.backup .review').waitFor(); assert.equal(await ctx.page.getByRole('button', { name: 'Añadir a mi biblioteca', exact: true }).isEnabled(), true) }
async function saveExport(ctx, directory) {
  await backupPage(ctx); await ctx.tap(ctx.page.getByRole('button', { name: 'Preparar copia', exact: true }))
  const link = ctx.page.getByRole('link', { name: 'Guardar archivo', exact: true }); await link.waitFor()
  const result = ctx.page.waitForEvent('download'); await ctx.tap(link); const download = await result
  assert.match(download.suggestedFilename(), /^pletina-biblioteca-\d{4}-\d{2}-\d{2}\.json$/)
  const stream = await download.createReadStream(); assert.ok(stream); const chunks = []; let length = 0
  for await (const chunk of stream) { length += chunk.length; assert.ok(length <= 10 * 1024 * 1024); chunks.push(chunk) }
  const bytes = Buffer.concat(chunks), payload = JSON.parse(bytes.toString('utf8'))
  assert.equal(payload.format, 'pletina-library'); assert.equal(payload.version, 1)
  assert.deepEqual(Object.keys(payload.library).sort(), ['tracks', 'likes', 'albums', 'artists', 'podcasts', 'playlists', 'entries', 'history', 'progress', 'youtube', 'sources', 'episodes'].sort())
  assert.ok(!JSON.stringify(payload).match(/googlevideo|blob:|data:audio|"(?:downloads|downloadQueue|meta|settings|recipe)"\s*:/i))
  await writeFile(join(directory, 'synthetic-library-export.json'), bytes)
  return { bytes, payload, sha256: sha(bytes), filename: download.suggestedFilename() }
}

async function scenarios(sourceCtx, destinationCtx, directory) {
  let exported, initial
  const { check } = destinationCtx, page = destinationCtx.page
  await check('backup.source-ui-and-real-file-export', async () => {
    const sourceState = await seed(sourceCtx, 'QA Copia Origen', [0, 1, 0], true)
    exported = await saveExport(sourceCtx, directory)
    assert.equal(exported.payload.library.playlists.length, 1); assert.equal(exported.payload.library.entries.length, 3)
    assert.ok(exported.payload.library.likes.length && exported.payload.library.history.length && exported.payload.library.albums.length && exported.payload.library.artists.length)
    assert.deepEqual(exported.payload.library.entries.sort((a, b) => a.position - b.position).map(row => row.trackId), sourceState.ids)
    return { file: 'synthetic-library-export.json', bytes: exported.bytes.length, sha256: exported.sha256, sourceCounts: counts(sourceState.value), order: sourceState.ids, actualFileDownload: true }
  })
  assert.ok(exported, 'Source file is required for dependent cases')
  await check('backup.preview-is-readonly-and-current-playlist-is-preserved', async () => {
    const seeded = await seed(destinationCtx, 'QA Lista Actual', [2], false); initial = seeded.value
    assert.equal(initial.library.playlists[0].id, exported.payload.library.playlists[0].id, 'Real independent contexts must exercise a playlist-ID collision')
    await backupPage(destinationCtx); await preview(destinationCtx, exported.bytes)
    const after = await inspect(page); assert.deepEqual(after, initial)
    const labels = await page.locator('.backup .review dl dt').allTextContents(), values = await page.locator('.backup .review dl dd').allTextContents()
    assert.equal(Number(values[labels.indexOf('Listas')]), 1); assert.equal(Number(values[labels.indexOf('Canciones en listas')]), 3)
    await page.screenshot({ path: join(directory, 'preview-readonly.png'), fullPage: true })
    return { before: counts(initial), after: counts(after), fingerprint: fingerprint(after), previewLabels: labels, previewValues: values, screenshot: 'preview-readonly.png' }
  })
  await check('backup.cancel-and-leave-preview-have-no-ghost-import', async () => {
    await destinationCtx.tap(page.locator('.backup .review').getByRole('button', { name: 'Cancelar', exact: true }))
    assert.equal(await page.locator('.backup .review').count(), 0); assert.deepEqual(await inspect(page), initial)
    await preview(destinationCtx, exported.bytes); await destinationCtx.tab('Inicio'); await delay(350); await backupPage(destinationCtx)
    assert.equal(await page.locator('.backup .review').count(), 0); assert.deepEqual(await inspect(page), initial)
    return { cancelDiscardedPreview: true, navigationDiscardedPreview: true, storageUnchanged: true, scope: 'Leaving a completed file preview; no artificial File.text delay.' }
  })
  for (const [name, bytes, expectedError] of [
    ['malformed', Buffer.from('{'), /No se pudo leer/],
    ['future-version', Buffer.from(JSON.stringify({ ...exported.payload, version: 9999 })), /No se pudo leer/],
    ['oversized', Buffer.alloc(10 * 1024 * 1024 + 1, 32), /10 MB/],
  ]) await check('backup.reject-' + name + '-without-writes', async () => {
    await upload(destinationCtx, bytes, name + '.json'); const alert = page.locator('.backup [role="alert"]'); await alert.waitFor()
    assert.match(await alert.textContent(), expectedError); assert.equal(await page.locator('.backup .review').count(), 0)
    assert.deepEqual(await inspect(page), initial)
    return { fileBytes: bytes.length, storageUnchanged: true, alert: (await alert.textContent()).trim() }
  })
  await check('backup.explicit-merge-remaps-playlist-and-keeps-duplicates-and-existing-data', async () => {
    await preview(destinationCtx, exported.bytes); assert.deepEqual(await inspect(page), initial)
    await destinationCtx.tap(page.getByRole('button', { name: 'Añadir a mi biblioteca', exact: true }))
    await page.locator('.backup .success[role="status"]').waitFor()
    const after = await waitForSnapshot(page, value => value.library.playlists.length === 2, 'Explicit UI merge committed')
    const original = initial.library.playlists[0], existing = after.library.playlists.find(row => row.id === original.id), imported = after.library.playlists.find(row => row.id !== original.id)
    assert.deepEqual(existing, original); assert.equal(imported.name, 'QA Copia Origen')
    assert.deepEqual(after.library.entries.filter(row => row.playlistId === original.id), initial.library.entries)
    const importedRows = after.library.entries.filter(row => row.playlistId === imported.id).sort((a, b) => a.position - b.position)
    assert.deepEqual(importedRows.map(row => row.trackId), [101, 102, 101]); assert.equal(new Set(importedRows.map(row => row.entryId)).size, 3)
    assert.deepEqual(after.library.likes.map(row => row.trackId).sort(), [101, 103]); assert.ok(after.library.history.some(row => row.trackId === 101))
    assert.ok(after.library.albums.length && after.library.artists.length)
    assert.deepEqual(after.downloadDB, initial.downloadDB); assert.deepEqual(after.cacheKeys, initial.cacheKeys)
    await page.screenshot({ path: join(directory, 'merge-success.png'), fullPage: true })
    return { originalPlaylistId: original.id, importedPlaylistId: imported.id, order: importedRows.map(row => row.trackId), counts: counts(after),
      existingDataPreserved: true, downloadStoreUnchanged: true, downloadCacheUnchanged: true, downloadDataWasInitiallyEmpty: !initial.downloadDB || Object.values(initial.downloadDB).every(rows => !rows.length), screenshot: 'merge-success.png' }
  })
  await check('backup.reload-shows-both-playlists-with-correct-order-and-no-playback', async () => {
    await page.reload({ waitUntil: 'load' }); await page.locator('.app').waitFor()
    await libraryButton(destinationCtx, 'QA Lista Actual'); assert.deepEqual((await page.locator('ol.tracks .name').allTextContents()).map(value => value.trim()), [destinationCtx.fixture.tracks[2].title])
    await libraryButton(destinationCtx, 'QA Copia Origen'); assert.deepEqual((await page.locator('ol.tracks .name').allTextContents()).map(value => value.trim()), [destinationCtx.fixture.tracks[0].title, destinationCtx.fixture.tracks[1].title, destinationCtx.fixture.tracks[0].title])
    assert.equal(await page.evaluate(() => navigator.mediaSession?.playbackState === 'playing'), false)
    return { originalAndImportedVisible: true, duplicatesInOrder: true, reloadPersisted: true, playbackNotStarted: true }
  })
}

try {
  server = createPwaServer({ directory: dist }); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const baseURL = `http://127.0.0.1:${server.address().port}/pletina/`
  for (const engine of engines) {
    const engineReport = { engine, layout: 'desktop 1440x900', build: expectedBuild, checks: [], errors: [], contexts: [] }; summary.engines.push(engineReport)
    const directory = join(output, engine); await mkdir(directory, { recursive: true }); let sourceCtx, destinationCtx
    try {
      if (engine === 'chromium') {
        const puppeteer = require(option('--puppeteer', 'puppeteer-core')), candidate = option('--chrome', process.env.PLETINA_E2E_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe')
        puppeteerBrowser = await puppeteer.launch({ headless: true, defaultViewport: null, executablePath: existsSync(candidate) ? candidate : playwright.chromium.executablePath(), args: ['--mute-audio'], timeout: 20000 })
        browser = await playwright.chromium.connectOverCDP(puppeteerBrowser.wsEndpoint(), { timeout: 20000 })
      } else browser = await playwright[engine].launch({ headless: true, timeout: 20000 })
      engineReport.browserVersion = browser.version()
      async function harness(kind) {
        const report = { engine, build: expectedBuild, checks: [], errors: [], role: kind }; engineReport.contexts.push(report)
        // The existing WebKit transport has one HTTP fixture handler. Give
        // source and destination separate transports so media attribution and
        // teardown cannot accidentally cross their isolated storage contexts.
        let platformTransport
        if (engine === 'webkit') { const { createWebKitNetworkTransport } = await import('./e2e/webkit-network-transport.mjs'); platformTransport = await createWebKitNetworkTransport(); platformTransports.push(platformTransport) }
        const ctx = await createHarness({ browser, baseURL, profile: 'chromium-desktop', engine, directory: join(directory, kind), report,
          ...(engine === 'chromium' ? { networkTransport: chromiumBridge } : {}),
          ...(platformTransport ? { contextOptions: platformTransport.contextOptions, networkTransport: platformTransport.connect } : {}) })
        const opened = await ctx.check('setup.open', ctx.open); assert.ok(opened, 'Compiled application must open')
        return ctx
      }
      sourceCtx = await harness('source'); destinationCtx = await harness('destination')
      await scenarios(sourceCtx, destinationCtx, directory)
    } catch (error) { engineReport.errors.push({ name: error.name, message: scrub(error.message) }) }
    finally {
      await sourceCtx?.close(); await destinationCtx?.close(); await browser?.close().catch(() => {}); await puppeteerBrowser?.close().catch(() => {})
      for (const transport of platformTransports.splice(0)) await transport.close()
      if (engine === 'webkit') engineReport.networkTransportClosed = true
      engineReport.browserClosed = !browser?.isConnected(); browser = null; puppeteerBrowser = null
      engineReport.checks = engineReport.contexts.flatMap(context => context.checks.map(check => ({ context: context.role, ...check })))
      engineReport.errors.push(...engineReport.contexts.flatMap(context => context.errors.map(error => ({ context: context.role, ...error }))))
      engineReport.counts = Object.fromEntries(['pass', 'fail', 'blocked', 'unsupported'].map(status => [status, engineReport.checks.filter(check => check.status === status).length]))
      await writeFile(join(directory, 'summary.json'), JSON.stringify(engineReport, null, 2) + '\n')
    }
  }
} catch (error) { summary.errors.push({ name: error.name, message: scrub(error.message) }) }
finally {
  await browser?.close().catch(() => {}); await puppeteerBrowser?.close().catch(() => {}); for (const transport of platformTransports.splice(0)) await transport.close()
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections() }); summary.serverClosed = !server?.listening
  summary.finishedAt = new Date().toISOString(); summary.counts = Object.fromEntries(['pass', 'fail', 'blocked', 'unsupported'].map(status => [status, summary.engines.reduce((count, engine) => count + (engine.counts?.[status] ?? 0), 0)]))
  summary.allPassed = summary.engines.length === engines.length && summary.engines.every(engine => !engine.errors.length && engine.counts.pass > 0 && !engine.counts.fail && !engine.counts.blocked) && !summary.errors.length
  summary.sourceBindingsUnchanged = (await Promise.all(sourceBindings.map(async value => sha(await readFile(join(workspace, value.path))) === value.sha256))).every(Boolean)
  await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  console.log(JSON.stringify({ output, build: expectedBuild, counts: summary.counts, allPassed: summary.allPassed, sourceBindingsUnchanged: summary.sourceBindingsUnchanged, serverClosed: summary.serverClosed }))
  if (!summary.allPassed || !summary.sourceBindingsUnchanged) process.exitCode = 1
}
