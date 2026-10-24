// Focused compiled-PWA regression: provider HTTP is controlled; product UI,
// service worker, storage and native browser Audio/MediaSession remain real.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { createPwaServer } from '../../preview-pwa.mjs'
import { createHarness, PROFILES, scrub } from './harness.mjs'

const args = process.argv.slice(2)
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const workspace = fileURLToPath(new URL('../../../', import.meta.url))
const temp = option('--temp', process.platform === 'win32' && existsSync('D:/tmp') ? 'D:/tmp/pletina-driving-browser-temp' : undefined)
if (temp) { await mkdir(temp, { recursive: true }); process.env.TEMP = temp; process.env.TMP = temp }
const browsers = option('--browsers', process.env.PLAYWRIGHT_BROWSERS_PATH ?? (existsSync('D:/tmp/pletina-e2e-browsers') ? 'D:/tmp/pletina-e2e-browsers' : undefined))
if (browsers) process.env.PLAYWRIGHT_BROWSERS_PATH = browsers
const playwright = await import('playwright')
const require = createRequire(import.meta.url)
const requested = option('--profiles', 'chromium-android-layout,webkit-iphone-layout').split(',').filter(Boolean)
for (const profile of requested) assert.ok(PROFILES[profile], 'Unknown profile ' + profile)
const dist = resolve(option('--dist', join(workspace, 'dist-pwa')))
const build = (await readFile(join(dist, 'sw.js'), 'utf8')).match(/const VERSION = "([a-f0-9]{16})"/)?.[1]
assert.ok(build, 'Compile the PWA before running this regression')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const defaultArtifacts = process.platform === 'win32' && existsSync('D:/tmp') ? 'D:/tmp/pletina-driving-mode' : join(workspace, 'artifacts/pwa-e2e')
const output = resolve(option('--output', join(defaultArtifacts, `driving-mode-${build}-${stamp}`)))
await mkdir(output, { recursive: true })
const summary = { schemaVersion: 1, build, startedAt: new Date().toISOString(), profiles: [], errors: [],
  scope: 'Compiled PWA, controlled provider HTTP and silent AAC, real browser Audio, MediaSession registration, IndexedDB and service worker. Desktop mobile-layout emulation only.',
  physicalAndroidVerified: false, physicalIPhoneVerified: false, carHardwareVerified: false,
  androidAutoCatalogClaimed: false, carPlayCatalogClaimed: false }
let server, browser, puppeteerBrowser, originAvailable = true
const networkAvailability = { setAvailable(value) { originAvailable = Boolean(value) }, snapshot: () => ({ available: originAvailable }) }
const persist = async () => {
  summary.counts = Object.fromEntries(['pass', 'fail', 'blocked', 'unsupported'].map(status => [status,
    summary.profiles.reduce((sum, report) => sum + report.checks.filter(check => check.status === status).length, 0)]))
  await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
}

async function chromiumBridge({ context, page, report }) {
  const marker = 'about:blank#driving-mode-' + crypto.randomUUID()
  const ready = puppeteerBrowser.waitForTarget(target => target.type() === 'page' && target.url() === marker, { timeout: 15000 })
  await page.goto(marker)
  const source = await (await ready).page()
  await source.setRequestInterception(true)
  report.networkTransport = 'Puppeteer HTTP interception and Playwright UI; production modules and SW retained.'
  return { pages: () => context.pages(), setOffline: value => source.setOfflineMode(value), route: async (_pattern, handler) => {
    source.on('request', request => {
      if (request.isInterceptResolutionHandled()) return
      const wrapped = { url: () => request.url(), method: () => request.method(), resourceType: () => request.resourceType(),
        headers: () => request.headers(), postDataJSON: () => JSON.parse(request.postData() || '{}') }
      const route = { request: () => wrapped, continue: () => request.continue(), abort: (code = 'failed') => request.abort(code),
        fulfill: value => request.respond({ status: value.status ?? 200, headers: value.headers, contentType: value.contentType, body: value.body }) }
      Promise.resolve(handler(route)).catch(async error => {
        if (page.isClosed()) return
        report.errors.push({ name: 'ProviderTransportError', message: scrub(error.message) })
        if (!request.isInterceptResolutionHandled()) await request.abort('failed').catch(() => {})
      })
    })
  } }
}

async function runDrivingScenarios(ctx, directory) {
  const { page, tap, check, fixture } = ctx
  const mediaBlocked = process.platform === 'win32' && ctx.engine === 'webkit' && ctx.browser.version() === '26.5'
    ? { reason: 'Windows WebKit 26.5 native HTMLAudio bypasses the controlled provider transport/proxy and service worker. Same-origin AAC decodes in the host probe; this does not determine Safari iOS behavior.',
      evidence: 'artifacts/pwa-e2e/webkit-aac-probe.json', physicalIPhoneClaimed: false } : null
  const viewports = [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 320, height: 568 }]
  const dialog = () => page.getByRole('dialog', { name: 'Modo coche', exact: true })
  const counted = new Set(['Cola', 'Favoritos', 'Descargas', 'Recientes', 'Reproducir todo', 'Conducir QA'])
  const button = name => dialog().getByRole('button', counted.has(name) ? { name: new RegExp('^' + name + '(?:\\s|\\d|$)') } : { name, exact: true })
  const wait = (fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout })
  const open = async () => {
    if (!await dialog().isVisible()) await tap(page.getByRole('button', { name: 'Modo coche', exact: true }))
    await dialog().waitFor({ state: 'visible' }); await ctx.settle()
  }
  const close = async () => {
    const wasOpen = await dialog().isVisible()
    if (wasOpen) await tap(button('Salir del modo coche'))
    await dialog().waitFor({ state: 'hidden' })
    if (wasOpen) {
      ;(ctx.report.focusTransfers ??= []).push(await page.evaluate(() => ({ tag: document.activeElement?.tagName,
        label: document.activeElement?.getAttribute('aria-label'), className: document.activeElement?.className })))
      await wait(() => document.activeElement?.getAttribute('aria-label') === 'Modo coche')
    }
  }
  const section = async name => { await tap(button(name)); await ctx.settle() }
  const audioState = () => page.evaluate(() => {
    const qa = window.__qaAudio
    return { audios: qa.instances.map((audio, index) => ({ index, playing: !audio.paused && !audio.ended, time: audio.currentTime,
      duration: audio.duration, error: audio.error?.code ?? null, src: audio.currentSrc || audio.src })),
      metadata: navigator.mediaSession?.metadata && { title: navigator.mediaSession.metadata.title, artist: navigator.mediaSession.metadata.artist },
      queue: JSON.parse(localStorage.getItem('pletina:web:queue:v1') || 'null'),
      handlers: Object.keys(qa.handlers).filter(key => typeof qa.handlers[key] === 'function') }
  })
  const playing = async title => {
    await wait(title => navigator.mediaSession?.metadata?.title === title && window.__qaAudio.instances.some(audio => !audio.paused && !audio.error && audio.currentTime > .1), title)
    const value = await audioState()
    assert.equal(value.audios.filter(audio => audio.playing).length, 1, 'Exactly one native audio plays')
    return value
  }
  const paused = () => wait(() => window.__qaAudio.instances.every(audio => audio.paused))
  const screenshot = async name => { await page.screenshot({ path: join(directory, name + '.png'), fullPage: true }); return name + '.png' }
  const layout = async (name, required = ['Sonando', 'Tu música', 'Cola', 'Salir del modo coche']) => {
    const state = await dialog().evaluate(node => {
      const r = node.getBoundingClientRect()
      return { viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth,
        dialog: { x: r.x, y: r.y, right: r.right, bottom: r.bottom }, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }
    })
    const { width, height } = state.viewport
    assert.ok(state.documentWidth <= width + 1, `${name}: no horizontal document overflow`)
    assert.ok(state.dialog.x >= -1 && state.dialog.y >= -1 && state.dialog.right <= width + 1 && state.dialog.bottom <= height + 1, `${name}: dialog fits the viewport`)
    assert.ok(state.scrollWidth <= state.clientWidth + 1, `${name}: no horizontal car-mode overflow`)
    state.controls = []
    for (const label of required) {
      const target = button(label), box = await target.boundingBox()
      assert.ok(box && box.x >= -1 && box.y >= -1 && box.x + box.width <= width + 1 && box.y + box.height <= height + 1, `${name}: ${label} is fully visible without scrolling`)
      assert.ok(box.width >= 44 && box.height >= 44, `${name}: ${label} target is at least 44 px`)
      const clear = await target.evaluate(node => { const r = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) })
      assert.equal(clear, true, `${name}: ${label} is not covered by another control`)
      state.controls.push({ label, ...box })
    }
    state.screenshot = await screenshot(name)
    return state
  }
  const search = async () => {
    await close(); await ctx.fillSearch('Buscar', fixture.media.query)
    await wait(titles => titles.every((title, i) => document.querySelector(`.tracks li[data-reorder-index="${i}"] .name`)?.textContent.trim() === title), fixture.media.tracks.map(track => track.title))
  }
  const row = index => page.locator(`.tracks li[data-reorder-index="${index}"]`)
  const menu = async (index, label) => { await tap(row(index).locator('button.more')); await tap(page.getByRole('menuitem', { name: label, exact: true })) }
  const selectCollection = async label => {
    await section('Tu música')
    if (await button('Volver a Tu música').isVisible()) await tap(button('Volver a Tu música'))
    await tap(button(label)); await button('Reproducir todo').waitFor()
  }
  const collectionTracks = () => dialog().getByRole('button', { name: /^Reproducir (?!todo(?:\s|\d|$)).+/ })
  const collectionTitles = () => collectionTracks().evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label').replace(/^Reproducir /, '')))
  const waitForCollectionTitles = titles => wait(titles => {
    const nodes = [...document.querySelectorAll('[role="dialog"][aria-label="Modo coche"] button.track[aria-label^="Reproducir "]')]
    return nodes.length === titles.length && nodes.every((node, i) => node.getAttribute('aria-label') === 'Reproducir ' + titles[i])
  }, titles)
  let favoriteTitles, downloadedTitle
  const playlistName = 'Conducir QA'

  await check('driving.empty: idle playback, empty queue and all viewport sizes', async () => {
    const layouts = []
    for (const size of viewports) {
      await page.setViewportSize(size); await ctx.settle(); await open(); await section('Sonando')
      assert.equal((await audioState()).audios.some(audio => audio.playing), false)
      if (await button('Reproducir').count()) assert.equal(await button('Reproducir').isDisabled(), true)
      layouts.push(await layout(`empty-${size.width}x${size.height}`))
      await section('Cola'); assert.equal(await collectionTracks().count(), 0)
      await section('Tu música')
      for (const label of ['Favoritos', 'Descargas', 'Recientes']) await button(label).waitFor()
      await close()
    }
    return { layouts }
  })
  await check('driving.wake-preference: toggle persists and close releases acquired native locks', async () => {
    await page.setViewportSize(viewports[0]); await open(); await section('Tu música')
    const wake = button('Mantener pantalla encendida')
    if (!await wake.isVisible()) { await close(); return { nativeWakeLockSupported: false, expectedFallback: 'The unsupported switch is hidden' } }
    if (await wake.getAttribute('aria-pressed') === 'true') await tap(wake)
    assert.equal(await wake.getAttribute('aria-pressed'), 'false')
    assert.equal(await page.evaluate(() => localStorage.getItem('pletina:driving:awake')), 'false')
    await tap(wake); assert.equal(await wake.getAttribute('aria-pressed'), 'true')
    await close(); await wait(() => (window.__qaDrivingWake?.sentinels ?? []).every(sentinel => sentinel.released))
    await open(); await section('Tu música'); assert.equal(await wake.getAttribute('aria-pressed'), 'true')
    await tap(wake); await close(); await open(); await section('Tu música')
    assert.equal(await wake.getAttribute('aria-pressed'), 'false', 'The saved disabled preference survives reopening')
    await tap(wake); await close(); await wait(() => (window.__qaDrivingWake?.sentinels ?? []).every(sentinel => sentinel.released))
    return page.evaluate(() => ({ nativeWakeLockSupported: true, preferenceRestored: true, nativeAcquisitions: window.__qaDrivingWake?.sentinels.length ?? 0,
      nativeRequestErrors: window.__qaDrivingWake?.errors ?? [], allAcquiredSentinelsReleased: (window.__qaDrivingWake?.sentinels ?? []).every(sentinel => sentinel.released), hardwareScreenSleepClaimed: false }))
  })
  const seeded = await check('driving.setup: favorites, playlist and download are created through UI', async () => {
    await page.setViewportSize(viewports[0]); await search()
    for (const i of [0, 1, 2]) await menu(i, 'Añadir a Canciones que te gustan')
    await menu(0, 'Añadir a playlist'); await tap(page.getByRole('menuitem', { name: 'Nueva playlist', exact: true }))
    await page.locator('.hero button[title="Cambiar nombre"]').waitFor()
    await tap(page.locator('.hero button[title="Cambiar nombre"]'))
    const input = page.getByRole('textbox', { name: 'Nombre de la playlist', exact: true })
    await input.waitFor(); await input.fill(playlistName); await input.press('Enter')
    await wait(name => document.querySelector('.hero h1')?.textContent.trim() === name, playlistName)
    await search(); await menu(1, 'Añadir a playlist'); await tap(page.getByRole('menuitem', { name: playlistName, exact: true }))
    if (mediaBlocked) return { favoriteIds: fixture.media.tracks.map(track => track.id), playlistName,
      downloadStatus: 'blocked', downloadBlock: mediaBlocked, dataSource: 'Product UI and controlled provider HTTP' }
    await page.evaluate(() => { window.__qaDrivingTransfers = []; window.addEventListener('pletina:download', event => window.__qaDrivingTransfers.push({ id: event.detail.trackId, state: event.detail.state })) })
    await menu(0, 'Descargar')
    await wait(id => window.__qaDrivingTransfers.some(row => row.id === id && ['done', 'error'].includes(row.state)), fixture.tracks[0].id, 30000)
    assert.equal(await page.evaluate(id => window.__qaDrivingTransfers.findLast(row => row.id === id && ['done', 'error'].includes(row.state))?.state, fixture.tracks[0].id), 'done')
    downloadedTitle = fixture.tracks[0].title
    assert.ok(fixture.requests.some(request => request.host === 'api.deezer.com' && request.path === '/search/track'))
    return { favoriteIds: fixture.media.tracks.map(track => track.id), playlistName, downloadedTitle, dataSource: 'Product UI and controlled provider HTTP' }
  })
  if (!seeded) return
  await check('driving.library: selected collection persists through tabs and rotation', async () => {
    await open(); await selectCollection('Favoritos'); favoriteTitles = await collectionTitles()
    assert.deepEqual([...favoriteTitles].sort(), fixture.media.tracks.map(track => track.title).sort())
    const layouts = []
    for (const size of viewports) {
      await page.setViewportSize(size); await ctx.settle(); assert.deepEqual(await collectionTitles(), favoriteTitles)
      layouts.push(await layout(`favorites-${size.width}x${size.height}`))
      await section('Cola'); await section('Tu música'); await waitForCollectionTitles(favoriteTitles)
      assert.deepEqual(await collectionTitles(), favoriteTitles)
    }
    await page.setViewportSize(viewports[0]); await selectCollection(playlistName)
    assert.deepEqual(await collectionTitles(), fixture.media.tracks.slice(0, 2).map(track => track.title))
    if (mediaBlocked) {
      for (const label of ['Descargas', 'Recientes']) {
        await section('Tu música'); await tap(button('Volver a Tu música')); await tap(button(label))
        await dialog().getByText('Todavía no hay nada aquí.', { exact: true }).waitFor()
        assert.equal(await collectionTracks().count(), 0)
      }
      await close()
      return { favoriteTitles, playlistName, layouts, emptyDownloadAndRecentNavigation: true, playbackStatus: 'blocked', playbackBlock: mediaBlocked }
    }
    await tap(button('Reproducir todo')); await playing(fixture.tracks[0].title)
    const queue = (await audioState()).queue
    assert.deepEqual(queue.queue.map(item => item.track.id), fixture.media.tracks.slice(0, 2).map(track => track.id))
    await page.evaluate(() => window.__qaAudio.handlers.seekto({ action: 'seekto', seekTime: 7 }))
    await wait(async () => {
      const db = await new Promise((resolve, reject) => { const request = indexedDB.open('pletina-web-library'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
      try { return await new Promise(resolve => { const request = db.transaction('history', 'readonly').objectStore('history').count(); request.onsuccess = () => resolve(request.result > 0) }) }
      finally { db.close() }
    })
    await section('Sonando'); await tap(button('Pausa')); await paused()
    await selectCollection('Descargas'); assert.deepEqual(await collectionTitles(), [downloadedTitle])
    await selectCollection('Recientes'); assert.ok(await collectionTracks().count() > 0)
    return { favoriteTitles, playlistName, queueIds: queue.queue.map(item => item.track.id), layouts }
  })
  if (mediaBlocked) {
    for (const name of ['transport', 'exit', 'media-session', 'podcast', 'offline']) await check('driving.' + name + ': native media prerequisite', async () => ({ status: 'blocked', ...mediaBlocked }))
    return
  }
  await check('driving.transport: play, pause, next, previous and selected queue use one audio', async () => {
    await selectCollection('Favoritos'); await tap(button('Reproducir todo')); const initial = await playing(favoriteTitles[0])
    await section('Sonando')
    const pauseMark = await page.evaluate(() => window.__qaAudio.events.length)
    await button('Pausa').focus(); await page.keyboard.press('Space'); await paused()
    await wait(mark => window.__qaAudio.events.slice(mark).some(event => event.type === 'pause'), pauseMark)
    assert.equal(await page.evaluate(mark => window.__qaAudio.events.slice(mark).filter(event => event.type === 'pause').length, pauseMark), 1,
      'Space on the focused transport button pauses exactly once')
    const layouts = []
    for (const size of viewports) {
      await page.setViewportSize(size); await ctx.settle()
      layouts.push(await layout(`playing-${size.width}x${size.height}`, ['Sonando', 'Tu música', 'Cola', 'Salir del modo coche', 'Anterior', 'Reproducir', 'Siguiente', 'Aleatorio', 'Quitar de favoritos']))
    }
    await page.setViewportSize(viewports[2]); await ctx.settle()
    const heading = dialog().locator('.track-meta h1'), actualTitle = await heading.textContent()
    let longTitleLayout
    try {
      await heading.evaluate(node => { node.textContent = 'Una canción con un título deliberadamente largo para ocupar dos líneas completas' })
      await ctx.settle()
      const headingLines = await heading.evaluate(node => node.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(node).lineHeight))
      assert.ok(headingLines >= 1.8 && headingLines <= 2.2, 'The typography stress must actually occupy two lines')
      longTitleLayout = await layout('playing-long-title-320x568', ['Sonando', 'Tu música', 'Cola', 'Salir del modo coche', 'Anterior', 'Reproducir', 'Siguiente', 'Aleatorio', 'Quitar de favoritos'])
      longTitleLayout.scope = 'CSS-only two-line h1 text stress; media metadata, queue and product state are unchanged'
    } finally { await heading.evaluate((node, title) => { node.textContent = title }, actualTitle) }
    await page.setViewportSize(viewports[0]); await button('Reproducir').focus(); await page.keyboard.press('Space'); await playing(favoriteTitles[0])
    const navMark = await page.evaluate(() => window.__qaAudio.events.length)
    await button('Tu música').focus(); await page.keyboard.press('Space')
    assert.equal(await button('Tu música').getAttribute('aria-current'), 'page')
    assert.deepEqual(await page.evaluate(mark => window.__qaAudio.events.slice(mark).filter(event => event.type === 'pause'), navMark), [],
      'Space on the navigation button changes sections without toggling playback')
    await section('Sonando')
    await tap(button('Siguiente')); await playing(favoriteTitles[1]); await tap(button('Anterior')); await playing(favoriteTitles[0])
    await section('Cola'); await tap(button('Reproducir ' + favoriteTitles[2])); const after = await playing(favoriteTitles[2])
    assert.equal(after.audios.find(audio => audio.playing).index, initial.audios.find(audio => audio.playing).index)
    await section('Sonando'); await tap(button('Pausa')); await paused()
    return { layouts, longTitleLayout, selectedFromQueue: favoriteTitles[2], nativeAudioReused: true, spaceOnTransportAndNavigationVerified: true }
  })
  await check('driving.exit: exit button, Escape and browser Back preserve uninterrupted audio', async () => {
    const actions = [], title = favoriteTitles[0]
    ctx.report.exitProgress = []
    for (const action of ['button', 'Escape', 'history.back']) {
      ctx.report.exitProgress.push({ action, stage: 'start' })
      await open(); await selectCollection('Favoritos'); await tap(button('Reproducir ' + title)); await playing(title); await section('Sonando')
      const before = (await audioState()).audios.find(audio => audio.playing), mark = await page.evaluate(() => window.__qaAudio.events.length)
      if (action === 'button') await close()
      else if (action === 'Escape') await page.keyboard.press('Escape')
      else await page.evaluate(() => history.back())
      await dialog().waitFor({ state: 'hidden' }); await ctx.settle()
      ctx.report.exitProgress.push(await page.evaluate(action => ({ action, stage: 'closed', focusedTag: document.activeElement?.tagName,
        focusedLabel: document.activeElement?.getAttribute('aria-label'), focusedClass: document.activeElement?.className }), action))
      await wait(() => document.activeElement?.getAttribute('aria-label') === 'Modo coche')
      const after = (await playing(title)).audios.find(audio => audio.playing)
      assert.equal(after.index, before.index); assert.equal(after.src, before.src); assert.ok(after.time >= before.time)
      assert.deepEqual(await page.evaluate(mark => window.__qaAudio.events.slice(mark).filter(event => event.type === 'pause'), mark), [], action + ' must not pause native audio')
      actions.push({ action, audioIndex: after.index, timeBefore: before.time, timeAfter: after.time })
      await tap(page.locator('.mini button[aria-label="Pausa"]')); await paused()
    }
    return { actions, browserBackSource: 'Real browser history API; phone system Back and car hardware unverified' }
  })
  await check('driving.media-session: registered system handlers operate the car-mode player', async () => {
    await open(); await selectCollection('Favoritos'); await tap(button('Reproducir todo')); await playing(favoriteTitles[0]); await section('Sonando')
    const before = await audioState(), required = ['play', 'pause', 'nexttrack', 'previoustrack', 'seekto']
    if (!required.every(action => before.handlers.includes(action))) return { status: 'unsupported', handlers: before.handlers, reason: 'This desktop browser omits a required native MediaSession action' }
    await page.evaluate(() => { window.__qaAudio.handlers.pause({ action: 'pause' }); window.__qaAudio.handlers.pause({ action: 'pause' }) }); await paused()
    await page.evaluate(() => window.__qaAudio.handlers.play({ action: 'play' })); await playing(favoriteTitles[0])
    await page.evaluate(() => window.__qaAudio.handlers.nexttrack({ action: 'nexttrack' })); await playing(favoriteTitles[1])
    await page.evaluate(() => window.__qaAudio.handlers.previoustrack({ action: 'previoustrack' })); await playing(favoriteTitles[0])
    await page.evaluate(() => window.__qaAudio.handlers.seekto({ action: 'seekto', seekTime: 3 })); await wait(() => window.__qaAudio.instances.some(audio => !audio.paused && audio.currentTime >= 3 && audio.currentTime < 6))
    await tap(button('Pausa')); await paused(); await close()
    return { registeredActions: before.handlers, invokedActions: required, source: 'Native registration observed; handlers invoked by QA. Actual Bluetooth buttons/car display unverified.' }
  })
  await check('driving.podcast: skip 30/15 seconds uses same episode and fits all viewports', async () => {
    await close(); await ctx.fillSearch('Podcasts', fixture.media.rss.query)
    await tap(page.locator('[aria-label="Resultados de pódcasts"]').getByRole('button', { name: fixture.media.rss.showTitle, exact: true }))
    await page.locator('.episodes .episode-play').first().waitFor(); await tap(page.locator('.episodes .episode-play').first())
    const before = await playing(fixture.media.rss.episodes[0].title)
    await open(); await section('Sonando'); await tap(button('Avanzar 30 segundos'))
    await wait(() => window.__qaAudio.instances.some(audio => !audio.paused && audio.currentTime >= 30 && audio.currentTime < 35))
    await tap(button('Retroceder 15 segundos')); await wait(() => window.__qaAudio.instances.some(audio => !audio.paused && audio.currentTime >= 15 && audio.currentTime < 21))
    await tap(button('Pausa')); await paused()
    const layouts = []
    for (const size of viewports) {
      await page.setViewportSize(size); await ctx.settle()
      layouts.push(await layout(`podcast-${size.width}x${size.height}`, ['Sonando', 'Tu música', 'Cola', 'Salir del modo coche', 'Reproducir', 'Retroceder 15 segundos', 'Avanzar 30 segundos']))
    }
    assert.equal((await audioState()).audios.find(audio => audio.src).index, before.audios.find(audio => audio.playing).index)
    await page.setViewportSize(viewports[0]); await close()
    return { title: fixture.media.rss.episodes[0].title, forwardSeconds: 30, backwardSeconds: 15, layouts }
  })
  await check('driving.offline: downloaded collection starts without provider response bytes', async () => {
    await open(); await selectCollection('Descargas'); const mark = fixture.requests.length; await ctx.goOffline(true)
    try {
      await tap(button('Reproducir ' + downloadedTitle)); const state = await playing(downloadedTitle)
      assert.equal(new URL(state.audios.find(audio => audio.playing).src).origin, new URL(page.url()).origin)
      assert.deepEqual(fixture.requests.slice(mark).filter(request => !request.injectedFailure), [])
      await section('Sonando'); await tap(button('Pausa')); await paused()
      return { title: downloadedTitle, localAudio: true, screenshot: await screenshot('offline-downloaded'), physicalAirplaneModeClaimed: false }
    } finally { await ctx.goOffline(false); await close() }
  })
}

try {
  const distribution = createPwaServer({ directory: dist })
  server = createServer((request, response) => { if (!originAvailable) { request.socket.destroy(); return }; distribution.emit('request', request, response) })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const baseURL = `http://127.0.0.1:${server.address().port}/pletina/`
  for (const profile of requested) {
    const spec = PROFILES[profile], directory = join(output, profile), report = { profile, engine: spec.engine, build, checks: [], errors: [] }
    summary.profiles.push(report)
    let ctx, transport
    try {
      if (spec.engine === 'webkit') transport = await (await import('./webkit-network-transport.mjs')).createWebKitNetworkTransport()
      if (spec.engine === 'chromium') {
        const chrome = option('--chrome', process.env.PLETINA_E2E_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe')
        puppeteerBrowser = await require('puppeteer-core').launch({ headless: true, defaultViewport: null,
          executablePath: existsSync(chrome) ? chrome : playwright.chromium.executablePath(), args: ['--mute-audio'], timeout: 20000 })
        browser = await playwright.chromium.connectOverCDP(puppeteerBrowser.wsEndpoint(), { timeout: 20000 })
      } else browser = await playwright[spec.engine].launch({ headless: true, timeout: 20000 })
      report.browserVersion = browser.version()
      ctx = await createHarness({ browser, baseURL, profile, engine: spec.engine, directory, report, networkAvailability,
        ...(spec.engine === 'chromium' ? { networkTransport: chromiumBridge } : {}),
        ...(transport ? { contextOptions: transport.contextOptions, networkTransport: transport.connect } : {}) })
      await ctx.context.addInitScript(() => {
        if (window !== top) return
        const qa = window.__qaDrivingWake = { sentinels: [], errors: [] }
        if (!navigator.wakeLock?.request) return
        const nativeRequest = navigator.wakeLock.request.bind(navigator.wakeLock)
        navigator.wakeLock.request = async (...args) => {
          try { const sentinel = await nativeRequest(...args); qa.sentinels.push(sentinel); return sentinel }
          catch (error) { qa.errors.push({ name: error.name, message: error.message }); throw error }
        }
      })
      if (await ctx.check('setup.open: compiled PWA and real service worker', ctx.open)) await runDrivingScenarios(ctx, directory)
    } catch (error) { report.checks.push({ name: ctx ? 'driving.execution' : 'setup.browser', status: 'fail', error: scrub(error.message) }) }
    finally {
      originAvailable = true; await ctx?.close(); await browser?.close().catch(() => {}); await puppeteerBrowser?.close().catch(() => {})
      await transport?.close().catch(error => report.errors.push({ name: 'TransportCleanupError', message: scrub(error.message) }))
      report.browserClosed = !browser?.isConnected(); browser = null; puppeteerBrowser = null
      report.counts = Object.fromEntries(['pass', 'fail', 'blocked', 'unsupported'].map(status => [status, report.checks.filter(check => check.status === status).length]))
      summary.errors.push(...report.errors.map(error => ({ profile, ...error })))
      await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n'); await persist()
    }
  }
} catch (error) { summary.errors.push({ name: error.name, message: scrub(error.message) }) }
finally {
  await browser?.close().catch(() => {}); await puppeteerBrowser?.close().catch(() => {})
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
  summary.serverClosed = !server?.listening; summary.finishedAt = new Date().toISOString()
  summary.browserChecksPassed = summary.profiles.length === requested.length && summary.profiles.every(report => report.checks.length >= 10 && report.checks.every(check => check.status === 'pass')) && summary.errors.length === 0
  summary.unblockedBrowserChecksPassed = summary.profiles.length === requested.length && summary.profiles.every(report => report.checks.length >= 10 && report.checks.every(check => check.status !== 'fail')) && summary.errors.length === 0
  await persist(); console.log(JSON.stringify({ output, build, counts: summary.counts, browserChecksPassed: summary.browserChecksPassed, carHardwareVerified: false }, null, 2))
  if (!summary.browserChecksPassed) process.exitCode = 1
}
