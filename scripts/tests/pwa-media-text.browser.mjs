// Compiled PWA + existing E2E harness, real Audio/DOMParser/IDB/SW and controlled HTTP sources.
// Run after npm run build:pwa: node scripts/tests/pwa-media-text.browser.mjs
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPwaServer } from '../preview-pwa.mjs'
import { createHarness, scrub } from './e2e/harness.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const workspace = fileURLToPath(new URL('../../', import.meta.url))
const browsers = option('--browsers', process.env.PLAYWRIGHT_BROWSERS_PATH ?? (existsSync('D:/tmp/pletina-e2e-browsers') ? 'D:/tmp/pletina-e2e-browsers' : undefined))
if (browsers) process.env.PLAYWRIGHT_BROWSERS_PATH = browsers
const playwright = await import('playwright')
const require = createRequire(import.meta.url)
const puppeteer = require('puppeteer-core')
const dist = resolve(option('--dist', join(workspace, 'dist-pwa')))
const build = (await readFile(join(dist, 'sw.js'), 'utf8')).match(/const VERSION = "([a-f0-9]{16})"/)?.[1]
assert.ok(build, 'Compile the PWA before running its media text regression')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const output = resolve(option('--output', join(workspace, 'artifacts/pwa-e2e', 'media-text-' + build + '-' + stamp)))
const chrome = option('--chrome', process.env.PLETINA_E2E_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe')
const summary = { schemaVersion: 1, build, startedAt: new Date().toISOString(), profiles: [], errors: [],
  scope: 'Compiled PWA, existing browser harness and synthetic HTTP lyrics/RSS/transcript fixtures; real browser Audio, DOMParser, IndexedDB and service worker. Desktop Chromium plus 320 px layout emulation; no physical phone or live-provider availability claim.' }
await mkdir(output, { recursive: true })
let pp, browser, server
const headers = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': '*', 'content-type': 'application/json' }
const transcriptURL = 'https://transcripts.pletina.test/episode-0.vtt'
const transcriptText = 'WEBVTT\n\n00:00:00.000 --> 00:00:20.000\nIntroducción de la transcripción QA\n\n00:00:20.000 --> 00:01:00.000\nSegundo segmento de la transcripción QA\n\n00:01:00.000 --> 00:01:30.000\nFinal de la transcripción QA\n'
const escapeXML = value => String(value).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c])

function textFixtures() {
  const requests = [], gates = new Map()
  let media, failRetry = true
  const bounded = async promise => {
    let timer
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Media text HTTP fixture gate timed out')), 15000) })]) }
    finally { clearTimeout(timer) }
  }
  return { requests, setMedia: value => { media = value }, release: () => { for (const gate of gates.values()) gate.release() },
    hold(title) {
      let entered, release, delivered
      const reached = new Promise(resolve => { entered = resolve }), blocked = new Promise(resolve => { release = resolve }),
        complete = new Promise(resolve => { delivered = resolve })
      const gate = { entered, blocked, delivered, release, reached: () => bounded(reached), completed: () => bounded(complete) }
      gates.set(title, gate)
      return gate
    },
    async handle(route) {
      const request = route.request(), url = new URL(request.url())
      if (url.hostname === 'lrclib.net') {
        const title = url.searchParams.get('track_name') ?? url.searchParams.get('q') ?? ''
        const row = { host: url.hostname, path: url.pathname, title, method: request.method() }
        requests.push(row)
        if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers, body: '' }); return true }
        const gate = gates.get(title)
        if (gate) { row.held = true; gate.entered(); await gate.blocked; gates.delete(title) }
        let status = 200, value
        const plain = title === 'Canción QA Dos'
        if (title === 'Canción QA Tres') { status = 404; value = { code: 404, message: 'TrackNotFound' } }
        else if (title === 'Canción QA Cuatro' && failRetry) { failRetry = false; status = 503; value = { message: 'Controlled temporary lyrics outage' } }
        else value = { id: 9001, trackName: title, artistName: url.searchParams.get('artist_name') ?? 'Artista QA Uno',
          albumName: url.searchParams.get('album_name') ?? 'Disco QA Uno', duration: 12,
          instrumental: title === 'Canción QA Siete',
          plainLyrics: plain ? 'Letra plana QA\nSegunda línea sin tiempos' : title + ': Primera línea QA\nSegunda línea QA\nFinal QA',
          syncedLyrics: plain ? null : '[00:00.00]' + title + ': Primera línea QA\n[00:05.00]Segunda línea QA\n[00:09.00]Final QA' }
        row.status = status
        try { await route.fulfill({ status, headers: status === 503 ? { ...headers, 'retry-after': '1', 'access-control-expose-headers': 'retry-after' } : headers,
          body: JSON.stringify(url.pathname.endsWith('/search') ? (status === 404 ? [] : [value]) : value) }) }
        catch (error) { if (!gate || !/Invalid InterceptionId|already handled|Target closed/i.test(error.message)) throw error; row.cancelledBeforeDelivery = true }
        finally { gate?.delivered() }
        return true
      }
      if (url.hostname === 'transcripts.pletina.test') {
        requests.push({ host: url.hostname, path: url.pathname, method: request.method() })
        await route.fulfill({ status: request.method() === 'OPTIONS' ? 204 : 200,
          headers: { ...headers, 'content-type': 'text/vtt; charset=utf-8' }, body: request.method() === 'OPTIONS' ? '' : transcriptText })
        return true
      }
      if (url.hostname === 'feeds.pletina.test' && url.pathname === '/rss') {
        assert.ok(media, 'The standard provider data must be available before RSS loads')
        requests.push({ host: url.hostname, path: url.pathname, method: request.method() })
        const xml = '<?xml version="1.0"?><rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel>' +
          '<title>' + media.rss.showTitle + '</title><language>es-ES</language><itunes:author>Autor QA</itunes:author><description>Descripción del programa QA.</description>' +
          media.rss.episodes.map((episode, i) => '<item><title>' + episode.title + '</title><guid>' + episode.guid + '</guid><description>Descripción QA.</description>' +
            '<itunes:duration>90</itunes:duration><enclosure url="' + escapeXML(episode.url) + '" type="audio/mp4"/>' +
            (i ? '' : '<podcast:transcript url="' + transcriptURL + '" type="text/vtt" language="es"/>') + '</item>').join('') + '</channel></rss>'
        await route.fulfill({ status: 200, headers: { ...headers, 'content-type': 'application/rss+xml' }, body: xml })
        return true
      }
      return false
    } }
}

// Same Puppeteer HTTP transport as the standard runner: it reaches opaque provider
// frames while Playwright operates only the compiled UI. Product modules are untouched.
function networkTransport(fixture) {
  return async ({ context, page, report }) => {
    const marker = 'about:blank#media-text-' + crypto.randomUUID()
    const target = pp.waitForTarget(target => target.type() === 'page' && target.url() === marker, { timeout: 15000 })
    await page.goto(marker)
    const sourcePage = await (await target).page()
    assert.ok(sourcePage)
    await sourcePage.setRequestInterception(true)
    let providerHandler
    sourcePage.on('request', request => {
      if (request.isInterceptResolutionHandled()) return
      const wrapped = { url: () => request.url(), method: () => request.method(), resourceType: () => request.resourceType(),
        frame: () => request.frame(), failure: () => request.failure(), headers: () => request.headers(), postDataJSON: () => JSON.parse(request.postData() || '{}') }
      const route = { request: () => wrapped, continue: () => request.continue(), abort: (code = 'failed') => request.abort(code),
        fulfill: value => request.respond({ status: value.status ?? 200, headers: value.headers, contentType: value.contentType, body: value.body }) }
      void (async () => {
        if (await fixture.handle(route)) return
        if (providerHandler) await providerHandler(route)
        else await route.continue()
      })().catch(async error => {
        if (page.isClosed()) return
        report.errors.push({ name: 'ProviderTransportError', message: scrub(error.message) })
        if (!request.isInterceptResolutionHandled()) await request.abort('failed').catch(() => {})
      })
    })
    report.networkTransport = 'Standard Puppeteer HTTP bridge plus media text HTTP fixtures; Playwright UI and production service worker.'
    return { pages: () => context.pages(), setOffline: value => sourcePage.setOfflineMode(value), route: async (_pattern, handler) => { providerHandler = handler } }
  }
}

async function scenarios(ctx, fixtures, profile) {
  const { page, tap, check } = ctx
  const closePanel = async () => { if (await page.locator('.np').count()) await tap('.np > header > .close') }
  async function song(index, { waitForText = true } = {}) {
    await closePanel()
    const track = ctx.fixture.tracks[index]
    await ctx.fillSearch('Buscar', track.title)
    const row = page.locator('ol.tracks > li[data-reorder-index]').filter({ has: page.locator('.name').filter({ hasText: new RegExp('^' + track.title + '$') }) }).first()
    await row.waitFor()
    await tap(row.locator('.name'))
    await page.waitForFunction(title => [...document.querySelectorAll('.mini .title,.player .title')].some(node => node.textContent.trim() === title) &&
      window.__qaAudio.instances.some(audio => !audio.paused && audio.currentTime > .05 && !audio.error), track.title)
    await openText('Letra')
    if (waitForText) await page.waitForFunction(() => !document.querySelector('.media-text .spinner'))
  }
  async function openText(label) {
    const open = page.locator('.mini button[aria-label="Sonando ahora"],.player button[title="Sonando ahora"]').filter({ visible: true }).first()
    await tap(open)
    const toggle = page.locator('.np header').getByRole('button', { name: label, exact: true })
    await toggle.waitFor()
    if (await toggle.getAttribute('aria-pressed') !== 'true') await tap(toggle)
    await page.getByRole('region', { name: label, exact: true }).waitFor()
  }
  async function pause() {
    const button = page.locator('.np').getByRole('button', { name: 'Pausa', exact: true })
    if (await button.count()) await tap(button)
    await page.waitForFunction(() => window.__qaAudio.instances.every(audio => audio.paused))
  }
  async function layout() {
    const result = await page.evaluate(() => {
      const region = document.querySelector('.media-text'), reading = region?.querySelector('.reading')
      const rect = region.getBoundingClientRect()
      return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, left: rect.left, right: rect.right,
        height: rect.height, readingHeight: reading?.clientHeight ?? 0, readingScrollHeight: reading?.scrollHeight ?? 0 }
    })
    assert.ok(result.documentWidth <= result.viewport + 1 && result.left >= -1 && result.right <= result.viewport + 1, 'Text and page fit the configured viewport')
    assert.ok(result.height > 100 && result.readingHeight > 40, 'Readable text panel retains usable height')
    return result
  }
  await check('media-text.lyrics-synchronized-follow-seek-source-and-layout', async () => {
    await song(0); await pause()
    const region = page.getByRole('region', { name: 'Letra', exact: true })
    assert.equal(await region.locator('.cue').count(), 3)
    assert.equal(await region.getByRole('button', { name: 'Seguir', exact: true }).getAttribute('aria-pressed'), 'true')
    await tap(region.locator('.cue').nth(1))
    await page.waitForFunction(() => window.__qaAudio.instances.some(audio => Math.abs(audio.currentTime - 5) < .3) && document.querySelector('.media-text [data-cue="1"]')?.getAttribute('aria-current') === 'true')
    await tap(region.getByRole('button', { name: 'Seguir', exact: true }))
    assert.equal(await region.getByRole('button', { name: 'Seguir', exact: true }).getAttribute('aria-pressed'), 'false')
    assert.match(await region.locator('.source').textContent(), /LRCLIB/)
    const source = new URL(await region.locator('.source a').getAttribute('href'))
    assert.equal(source.hostname, 'lrclib.net')
    assert.equal(await region.locator('.source a').getAttribute('rel'), 'noopener noreferrer')
    const viewport = await layout()
    await page.screenshot({ path: join(output, profile, 'lyrics.png'), fullPage: true })
    return { cues: 3, seekSeconds: 5, pausedSeek: true, followToggle: true, sourceHost: source.hostname, layout: viewport }
  })
  await check('media-text.plain-lyrics-have-readable-lines-without-seek-or-follow', async () => {
    await song(1); await pause()
    const region = page.getByRole('region', { name: 'Letra', exact: true })
    assert.equal(await region.locator('.plain').textContent(), 'Letra plana QA\nSegunda línea sin tiempos')
    assert.equal(await region.locator('.cue,.follow').count(), 0)
    return { plainLines: 2, layout: await layout() }
  })
  await check('media-text.missing-lyrics-have-explicit-empty-state', async () => {
    await song(2); await pause()
    await page.getByText('No hay letra disponible para esta canción.', { exact: true }).waitFor()
    assert.equal(await page.locator('.media-text .source,.media-text .reading').count(), 0)
    return { explicitMissing: true }
  })
  await check('media-text.transient-error-can-retry-without-changing-track', async () => {
    await song(3); await pause()
    await page.getByText('No se pudo cargar la letra.', { exact: true }).waitFor()
    // Respect the controlled provider's Retry-After; advance the harness clock,
    // rather than requiring the user-visible retry to bypass rate limiting.
    await page.clock.fastForward(1001)
    await tap(page.locator('.media-text').getByRole('button', { name: 'Reintentar', exact: true }))
    await page.locator('.media-text .cue').first().waitFor()
    assert.equal((await page.locator('.np h1').textContent()).trim(), 'Canción QA Cuatro')
    const requests = fixtures.requests.filter(row => row.title === 'Canción QA Cuatro')
    assert.ok(requests.some(row => row.status === 503) && requests.some(row => row.status === 200))
    return { retryRecovered: true, retryAfterMilliseconds: 1001, statusCodes: requests.map(row => row.status) }
  })
  await check('media-text.replacing-track-during-lyrics-fetch-ignores-late-response', async () => {
    const gate = fixtures.hold('Canción QA Cinco')
    try {
      await song(4, { waitForText: false }); await gate.reached()
      await page.getByText('Buscando letra…', { exact: true }).waitFor()
      await song(5); await pause()
      gate.release(); await gate.completed(); await ctx.settle()
      assert.equal((await page.locator('.np h1').textContent()).trim(), 'Canción QA Seis')
      assert.equal(await page.locator('.media-text .cue').count(), 3)
      assert.match(await page.locator('.media-text .cue').first().textContent(), /Canción QA Seis/)
      assert.doesNotMatch(await page.locator('.media-text').textContent(), /Canción QA Cinco/)
      assert.equal(await page.locator('.media-text .spinner').count(), 0)
      return { heldTitle: 'Canción QA Cinco', currentTitle: 'Canción QA Seis', lateResponseDiscarded: true }
    } finally { gate.release() }
  })
  await check('media-text.instrumental-song-has-explicit-state', async () => {
    await song(6); await pause()
    await page.getByText('Esta canción es instrumental.', { exact: true }).waitFor()
    assert.equal(await page.locator('.media-text .reading').count(), 0)
    return { instrumental: true }
  })
  await check('media-text.published-rss-transcript-source-default-follow-and-seek', async () => {
    await closePanel(); await ctx.fillSearch('Buscar podcasts', ctx.fixture.media.rss.query)
    // Accessible name lives on the card hit button, independently of its visual text.
    await tap(page.locator('[aria-label="Resultados de pódcasts"] .card button.hit[aria-label="' + ctx.fixture.media.rss.showTitle + '"]'))
    await page.locator('.episodes .episode-play').first().waitFor()
    await tap(page.locator('.episodes .episode-play').first())
    await page.waitForFunction(() => window.__qaAudio.instances.some(audio => !audio.paused && audio.duration >= 89 && audio.currentTime > .05))
    await openText('Transcripción'); await pause()
    const region = page.getByRole('region', { name: 'Transcripción', exact: true })
    await region.locator('.cue').first().waitFor()
    assert.equal(await region.locator('.cue').count(), 3)
    assert.equal(await region.getByRole('button', { name: 'Seguir', exact: true }).getAttribute('aria-pressed'), 'false')
    await tap(region.locator('.cue').nth(1))
    await page.waitForFunction(() => window.__qaAudio.instances.some(audio => Math.abs(audio.currentTime - 20) < .3))
    await page.getByText('Los tiempos corresponden al audio del RSS y pueden variar en otras versiones.', { exact: true }).waitFor()
    assert.equal(await region.locator('.source a').getAttribute('href'), transcriptURL)
    assert.ok(fixtures.requests.some(row => row.host === 'feeds.pletina.test'))
    assert.ok(fixtures.requests.some(row => row.host === 'transcripts.pletina.test'))
    const viewport = await layout()
    await page.screenshot({ path: join(output, profile, 'transcript.png'), fullPage: true })
    return { cues: 3, defaultFollow: false, seekSeconds: 20, publishedRSSSourceFetched: true, layout: viewport }
  })
  await check('media-text.episode-without-published-transcript-shows-empty-state', async () => {
    await closePanel(); await tap(page.locator('.episodes .episode-play').nth(1)); await openText('Transcripción')
    await page.getByText('Este episodio no tiene una transcripción disponible.', { exact: true }).waitFor()
    assert.equal(await page.locator('.media-text .reading,.media-text .source').count(), 0)
    await pause()
    return { explicitMissing: true, noInventedTranscript: true }
  })
}

async function liveLyrics() {
  // Fresh context has no fixture transport, catalog writes, or library operations.
  // Only availability metadata is returned; copyrighted lyric payload stays in memory.
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await page.goto(option('--live-origin', 'https://diad87.github.io/pletina/'), { waitUntil: 'domcontentloaded' })
    return await page.evaluate(async () => {
      const params = new URLSearchParams({ track_name: 'I Want to Live', artist_name: 'Borislav Slavov',
        album_name: "Baldur's Gate 3 (Original Game Soundtrack)", duration: '233' })
      const response = await fetch('https://lrclib.net/api/get?' + params, { mode: 'cors', credentials: 'omit', redirect: 'error', cache: 'no-store',
        headers: { Accept: 'application/json', 'Lrclib-Client': 'Pletina/0.11.2 (https://github.com/diad87/pletina)' }, signal: AbortSignal.timeout(15000) })
      const value = await response.json()
      return { testedAt: new Date().toISOString(), pageOrigin: location.origin, requestHost: 'lrclib.net', status: response.status,
        responseType: response.type, readableCorsResponse: response.ok && response.type === 'cors',
        id: value.id, duration: value.duration, instrumental: value.instrumental,
        plainCharacters: typeof value.plainLyrics === 'string' ? value.plainLyrics.length : 0,
        synchronizedCharacters: typeof value.syncedLyrics === 'string' ? value.syncedLyrics.length : 0,
        credentialsOmitted: true, customClientHeader: true, lyricTextRecorded: false }
    })
  } finally { await context.close() }
}

try {
  server = createPwaServer({ directory: dist })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const baseURL = `http://127.0.0.1:${server.address().port}/pletina/`
  pp = await puppeteer.launch({ headless: true, defaultViewport: null,
    executablePath: existsSync(chrome) ? chrome : playwright.chromium.executablePath(), args: ['--mute-audio'], timeout: 20000 })
  browser = await playwright.chromium.connectOverCDP(pp.wsEndpoint(), { timeout: 20000 })
  for (const profile of ['chromium-desktop', 'chromium-mobile-320']) {
    const report = { build, checks: [], errors: [], browserVersion: browser.version(), requestedProfile: profile }
    summary.profiles.push(report)
    const fixture = textFixtures()
    let ctx
    try {
      ctx = await createHarness({ browser, baseURL, profile: profile === 'chromium-desktop' ? profile : 'chromium-android-layout',
        engine: 'chromium', directory: join(output, profile), report, networkTransport: networkTransport(fixture) })
      fixture.setMedia(ctx.fixture.media)
      const opened = await ctx.check('setup.compiled-pwa-opens-with-controlled-providers', () => ctx.open())
      if (!opened) continue
      if (profile === 'chromium-mobile-320') { await ctx.page.setViewportSize({ width: 320, height: 740 }); await ctx.settle() }
      report.testedViewport = await ctx.page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
      await scenarios(ctx, fixture, profile)
    } catch (error) { report.errors.push({ name: error.name, message: scrub(error.message) }) }
    finally { fixture.release(); report.textFixtureRequests = fixture.requests; await ctx?.close() }
  }
  if (args.includes('--live-lyrics')) {
    try { summary.liveLyrics = await liveLyrics() }
    catch (error) { summary.liveLyrics = { readableCorsResponse: false, error: scrub(error.message) } }
  }
} catch (error) { summary.errors.push({ name: error.name, message: scrub(error.message) }) }
finally {
  const process = pp?.process()
  await browser?.close().catch(error => summary.errors.push({ name: error.name, message: scrub(error.message) }))
  await pp?.close().catch(error => summary.errors.push({ name: error.name, message: scrub(error.message) }))
  if (process && process.exitCode === null && process.signalCode === null) await new Promise(resolve => {
    const timer = setTimeout(resolve, 3000); process.once('exit', () => { clearTimeout(timer); resolve() })
  })
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.() })
  summary.cleanup = { browserClosed: !browser?.isConnected(), puppeteerBrowserClosed: !pp?.connected,
    processClosed: !process || process.exitCode !== null || process.signalCode !== null, serverClosed: !server?.listening }
  summary.finishedAt = new Date().toISOString()
  summary.counts = Object.fromEntries(['pass', 'fail', 'blocked', 'unsupported'].map(status => [status,
    summary.profiles.reduce((sum, report) => sum + report.checks.filter(check => check.status === status).length, 0)]))
  summary.passed = summary.counts.fail === 0 && summary.profiles.length === 2 && summary.counts.pass === 18 &&
    summary.errors.length === 0 && summary.profiles.every(report => report.errors.length === 0) && Object.values(summary.cleanup).every(Boolean) &&
    (!args.includes('--live-lyrics') || summary.liveLyrics?.readableCorsResponse === true)
  await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
}
console.log(JSON.stringify({ build, passed: summary.passed, counts: summary.counts, errors: summary.errors,
  profileErrors: summary.profiles.map(report => ({ profile: report.requestedProfile, errors: report.errors })), cleanup: summary.cleanup, report: join(output, 'summary.json') }, null, 2))
if (!summary.passed) process.exitCode = 1
