// Compiled Svelte UI + real HTMLAudio. Provider bytes and failure modes come from HTTP fixtures.
// Reads of browser storage and the test-only Audio observer are assertions, never player commands.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

export const mediaScenarioInventory = Object.freeze([
  'selection-html-audio', 'pause-seek-next-previous-one-audio', 'media-session-metadata-and-idempotent-actions',
  'now-playing-synthetic-touch-swipe-threshold-and-interactive-origin',
  'home-surprise-album-starts-saved-album-in-track-order', 'artist-radio-builds-bounded-mixed-queue-and-plays',
  'context-play-next-prepends-dj-priority-without-interrupting-current',
  'dj-duplicates-reorder-play-remove-clear', 'shuffle-preserves-current-and-queue-membership', 'repeat-one-real-ended',
  'repeat-all-wraps-after-final-entry', 'automatic-next-real-ended-same-audio', 'sleep-at-end-does-not-start-prepared-successor',
  'sleep-custom-validation-and-one-minute-deadline', 'pause-during-delayed-resolution-prevents-late-autoplay',
  'rapid-song-selection-ignores-obsolete-player-response', 'provider-errors-stop-boundedly-and-explicit-retry-recovers',
  'reload-restores-current-dj-position-and-paused-intent', 'downloads-serial-duplicate-suppression-and-cancel-pending',
  'download-offline-reload-play-seek-from-local-service-worker', 'download-removal-clears-pointer-body-and-ui',
  'download-quotaFailure-rollback-and-no-false-done', 'download-storageFailure-rollback-and-no-false-done',
  'download-failMedia-rollback-and-no-false-done', 'download-retry-after-provider-failure-succeeds',
  'rss-podcast-direct-audio-progress-reload-and-resume', 'rss-completion-next-episode-and-relisten-from-zero',
  'youtube-podcast-keeps-episode-namespace-and-progress', 'audio-log-export-is-local-bounded-and-has-no-source-addresses',
].map(name => ({ id: 'media.' + name })))

export async function runMediaScenarios(ctx) {
  const { page, context, fixture, check, tap, clickText } = ctx
  const media = fixture.media
  const run = (name, fn) => check('media.' + name, fn)
  const visible = async selector => page.locator(selector).first().isVisible().catch(() => false)
  const row = index => `.tracks li[data-reorder-index="${index}"]`
  const wait = (fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout })
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const transferObserver = () => {
    if (window.__e2eTransfers) return
    window.__e2eTransfers = []
    window.addEventListener('pletina:download', ({ detail }) => window.__e2eTransfers.push({
      id: detail.trackId, state: detail.state, progress: detail.progress,
      error: detail.error ? String(detail.error).replace(/https?:\/\/[^\s]+/g, '[URL]') : null,
    }))
  }
  await page.addInitScript(transferObserver)
  await page.evaluate(transferObserver)
  const state = () => page.evaluate(() => {
    const qa = window.__qaAudio
    if (!qa) throw new Error('Audio observer was not installed before the application')
    return {
      title: document.querySelector('.mini .title')?.textContent.trim() ?? null,
      metadata: navigator.mediaSession?.metadata ? { title: navigator.mediaSession.metadata.title, artist: navigator.mediaSession.metadata.artist } : null,
      handlers: Object.keys(qa.handlers ?? {}).filter(name => typeof qa.handlers[name] === 'function'),
      online: navigator.onLine, events: (qa.events ?? []).map(event => ({ type: event.type, index: event.index, time: event.time ?? event.currentTime })).slice(-100),
      audios: qa.instances.map((audio, index) => ({ index, playing: !audio.paused, paused: audio.paused,
        time: Number.isFinite(audio.currentTime) ? audio.currentTime : null, duration: Number.isFinite(audio.duration) ? audio.duration : null,
        source: Boolean(audio.currentSrc || audio.src), local: Boolean(audio.src) && new URL(audio.src, location.href).origin === location.origin && new URL(audio.src, location.href).pathname.includes('/__audio__/'),
        host: audio.src ? new URL(audio.src, location.href).hostname : null, error: audio.error?.code ?? null,
        muted: audio.muted, volume: audio.volume, readyState: audio.readyState })),
    }
  })
  const active = value => value.audios.find(audio => audio.playing)
  async function closeOverlays() {
    if (await visible('dialog[open] [aria-label="Cerrar temporizador"]')) await tap('dialog[open] [aria-label="Cerrar temporizador"]')
    if (await visible('.queue-sheet .queue-panel button.close')) await tap('.queue-sheet .queue-panel button.close')
    if (await visible('.np > header > button[title="Cerrar (Esc)"]')) await tap('.np > header > button[title="Cerrar (Esc)"]')
  }
  async function pause() {
    if (await visible('.mini button[aria-label="Pausa"]')) await tap('.mini button[aria-label="Pausa"]')
    await wait(() => window.__qaAudio.instances.every(audio => audio.paused))
  }
  async function nowPlaying() {
    if (!await visible('.np')) { await page.locator('.mini button.open').waitFor(); await tap('.mini button.open') }
    await page.locator('.np .transport').waitFor()
  }
  async function queuePanel() {
    await nowPlaying()
    await tap('.np .extras button:has-text("Cola")')
    await page.locator('.queue-sheet .queue-panel').waitFor()
  }
  async function controlsOff() {
    if (!await visible('.mini')) return
    await nowPlaying()
    if (await visible('.np button.timer.active')) {
      await tap('.np button.timer'); await tap('dialog[open] button.cancel')
    }
    if (await visible('.np button[aria-label="Desactivar reproducción aleatoria"]')) await tap('.np button[aria-label="Desactivar reproducción aleatoria"]')
    for (let i = 0; i < 2 && !await visible('.np .buttons button[title="Repetir"]'); i++) {
      if (await visible('.np .buttons button[title="Repetir una"]')) await tap('.np .buttons button[title="Repetir una"]')
      else if (await visible('.np .buttons button[title="No repetir"]')) await tap('.np .buttons button[title="No repetir"]')
    }
    await closeOverlays()
    const dj = await page.evaluate(() => JSON.parse(localStorage.getItem('pletina:web:queue:v1') || 'null')?.userQueue.length ?? 0)
    if (dj) { await queuePanel(); await tap('.queue-sheet .queue-panel button.clear'); await closeOverlays() }
  }
  async function music() {
    await closeOverlays(); await pause(); await controlsOff()
    await ctx.fillSearch('Buscar', media.query)
    await page.locator(row(0) + ' .name').waitFor()
    return page.locator('.tracks li[data-reorder-index] .name').allTextContents()
  }
  async function playing(title, timeout = 15000) {
    await wait(title => document.querySelector('.mini .title')?.textContent.trim() === title &&
      (window.__qaAudio.instances.some(audio => !audio.paused && audio.currentTime > 0.15) ||
        [...document.querySelectorAll('[role="status"]')].some(node => node.textContent.includes('Pulsa Reproducir'))), title, timeout)
    let value = await state()
    if (!active(value)) {
      await tap('.mini button[aria-label="Reproducir"]')
      await wait(() => window.__qaAudio.instances.some(audio => !audio.paused && audio.currentTime > 0.15))
      value = await state()
    }
    assert.equal(value.title, title)
    assert.ok(active(value)?.error === null)
    await page.locator('.mini button[aria-label="Pausa"]').waitFor()
    return value
  }
  async function start(index = 0) {
    const titles = await music()
    if ((await state()).title === titles[index] && titles.length > 1) {
      const other = index ? 0 : 1
      await tap(row(other) + ' .name'); await playing(titles[other])
    }
    await tap(row(index) + ' .name')
    return { titles, state: await playing(titles[index]) }
  }
  async function seek(fraction) {
    await nowPlaying()
    const slider = page.locator('.np input[aria-label="Posición"]')
    await slider.waitFor()
    await wait(() => !document.querySelector('.np input[aria-label="Posición"]').disabled)
    const box = await slider.boundingBox()
    assert.ok(box?.width > 10)
    // Browser-generated pointer events exercise the Svelte input/change handlers.
    await page.mouse.click(box.x + box.width * fraction, box.y + box.height / 2)
  }
  async function menu(index, label) {
    await closeOverlays(); await tap(row(index) + ' button.more'); await clickText('[role="menuitem"]', label)
  }
  const transferMark = () => page.evaluate(() => window.__e2eTransfers.length)
  async function terminal(mark, id, timeout = 25000) {
    await wait(({ mark, id }) => window.__e2eTransfers.slice(mark).some(event => event.id === id && ['done', 'error', 'cancelled'].includes(event.state)), { mark, id }, timeout)
    return page.evaluate(({ mark, id }) => window.__e2eTransfers.slice(mark).findLast(event => event.id === id && ['done', 'error', 'cancelled'].includes(event.state)), { mark, id })
  }
  async function downloadState() {
    return page.evaluate(async () => {
      const cache = await caches.open('pletina-audio-downloads:v1'), keys = await cache.keys()
      if (!(await indexedDB.databases()).some(db => db.name === 'pletina-web-downloads')) return { rows: [], cacheEntries: keys.length }
      const db = await new Promise((resolve, reject) => { const request = indexedDB.open('pletina-web-downloads'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('Download database unavailable')) })
      try {
        const rows = await new Promise((resolve, reject) => { const request = db.transaction('files').objectStore('files').getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
        return { cacheEntries: keys.length, rows: await Promise.all(rows.map(async row => ({ id: row.id, title: row.track.title, size: row.size, present: Boolean(await cache.match(row.cacheKey)), type: (await cache.match(row.cacheKey))?.type }))) }
      } finally { db.close() }
    })
  }
  async function downloadsView() {
    await closeOverlays(); await clickText('.bottom-nav button', 'Tu biblioteca')
    await tap('.page .items .item:has(.title:text-is("Descargas"))')
    await page.locator('h1.page-title:text-is("Descargas")').waitFor()
  }
  async function clearDownloads() {
    await downloadsView()
    await wait(() => document.querySelectorAll('.page .queue li').length === 0, null, 25000)
    if (await visible('.summary button:has-text("Quitar todas")')) {
      await tap('.summary button:has-text("Quitar todas")'); await tap('.confirm button.danger')
      await wait(async () => {
        const request = indexedDB.open('pletina-web-downloads')
        const db = await new Promise(resolve => { request.onsuccess = () => resolve(request.result) })
        try { return await new Promise(resolve => { const query = db.transaction('files').objectStore('files').count(); query.onsuccess = () => resolve(query.result === 0) }) }
        finally { db.close() }
      })
    }
  }
  async function reload() {
    await closeOverlays(); await page.reload({ waitUntil: 'load' }); await page.locator('.bottom-nav').waitFor(); await frame()
  }

  // Windows WebKit's native media transport bypasses Playwright routes/proxy and service workers.
  // The isolated AAC probe distinguishes this test-host limitation from an application failure.
  // Linux CI must run the scenarios instead of inheriting a blanket WebKit exemption.
  const webkitVersion = ctx.engine === 'webkit' ? ctx.browser.version() : null
  if (process.platform === 'win32' && webkitVersion === '26.5') {
    for (const scenario of mediaScenarioInventory) await check(scenario.id, async () => ({
      status: 'blocked',
      reason: 'Windows WebKit native HTMLAudio bypasses the controlled provider transport and service worker. Same-origin HTTP AAC decodes; the seven-case host probe documents the transport failure. This does not determine Safari iOS behavior.',
      evidence: 'artifacts/pwa-e2e/webkit-aac-probe.json',
    }))
    return
  }

  const ready = await run('selection-html-audio', async () => {
    assert.ok(media?.tracks?.length >= 3, 'Three provider fixture songs are required')
    assert.ok(await page.evaluate(() => Boolean(window.__qaAudio?.instances)))
    await fixture.reset()
    const result = await start(0), value = result.state
    assert.ok(active(value).duration >= 11 && active(value).duration < 14, 'real AAC fixture must be decoded')
    assert.equal(active(value).muted, false); assert.ok(active(value).volume > 0)
    await pause()
    return { audio: value, media: 'Real silent AAC/MP4; no song-content claim' }
  })
  if (!ready) {
    for (const scenario of mediaScenarioInventory.slice(1)) await check(scenario.id, async () => ({ status: 'blocked', reason: 'The initial compiled-player audio prerequisite failed.' }))
    return
  }

  await run('pause-seek-next-previous-one-audio', async () => {
    const { titles, state: before } = await start(0), index = active(before).index
    await pause(); assert.ok((await state()).audios.every(audio => audio.paused))
    await tap('.mini button[aria-label="Reproducir"]'); await playing(titles[0])
    await seek(0.45)
    await wait(() => window.__qaAudio.instances.some(audio => !audio.paused && !audio.seeking && audio.currentTime > 4.5))
    await tap('.np button[title="Siguiente"]'); await playing(titles[1])
    await seek(0.01); await tap('.np button[title="Anterior"]'); const after = await playing(titles[0])
    assert.equal(active(after).index, index); assert.equal(after.audios.length, before.audios.length)
    await closeOverlays(); await pause()
    return { audio: after }
  })
  await run('now-playing-synthetic-touch-swipe-threshold-and-interactive-origin', async () => {
    const { titles, state: before } = await start(0)
    await nowPlaying()
    const swipe = (selector, distance, pointerType = 'touch') => page.evaluate(({ selector, distance, pointerType }) => {
      const origin = document.querySelector(selector), panel = document.querySelector('.np')
      if (!origin || !panel) throw new Error('Now-playing swipe origin is unavailable')
      const options = { bubbles: true, pointerId: 77, pointerType, isPrimary: true, clientX: 100, clientY: 200 }
      origin.dispatchEvent(new PointerEvent('pointerdown', options))
      panel.dispatchEvent(new PointerEvent('pointermove', { ...options, clientY: 200 + distance }))
      panel.dispatchEvent(new PointerEvent('pointerup', { ...options, clientY: 200 + distance }))
    }, { selector, distance, pointerType })
    await swipe('.np .meta h1', 30); await frame()
    assert.equal(await visible('.np'), true, 'A short movement must preserve the panel')
    await swipe('.np > header > button[title="Cerrar (Esc)"]', 160); await frame()
    assert.equal(await visible('.np'), true, 'A movement beginning on a button must be ignored')
    await swipe('.np .meta h1', 160, 'mouse'); await frame()
    assert.equal(await visible('.np'), true, 'The touch gesture must ignore a mouse pointer')
    await swipe('.np .meta h1', 130)
    await page.locator('.np').waitFor({ state: 'hidden' })
    const after = await playing(titles[0])
    assert.equal(active(after).index, active(before).index)
    await pause()
    return { source: 'Synthetic bubbling PointerEvent DOM events with pointerType touch; no physical finger or OS gesture claim', shortPixels: 30, acceptedPixels: 130, audioContinued: true }
  })
  await run('media-session-metadata-and-idempotent-actions', async () => {
    const { titles } = await start(0), before = await state()
    if (!await page.evaluate(() => 'mediaSession' in navigator)) return { status: 'unsupported', reason: 'This browser does not expose MediaSession.' }
    for (const action of ['play', 'pause', 'nexttrack', 'previoustrack', 'seekto']) if (!before.handlers.includes(action)) return { status: 'unsupported', reason: 'MediaSession action not supported: ' + action }
    assert.equal(before.metadata?.title, titles[0])
    await page.evaluate(() => { window.__qaAudio.handlers.pause({ action: 'pause' }); window.__qaAudio.handlers.pause({ action: 'pause' }) })
    assert.ok((await state()).audios.every(audio => audio.paused))
    await page.evaluate(() => window.__qaAudio.handlers.play({ action: 'play' }))
    await playing(titles[0])
    await page.evaluate(() => window.__qaAudio.handlers.seekto({ action: 'seekto', seekTime: 3 }))
    await wait(() => window.__qaAudio.instances.some(audio => audio.currentTime >= 3 && audio.currentTime < 6))
    await page.evaluate(() => window.__qaAudio.handlers.nexttrack({ action: 'nexttrack' }))
    const after = await playing(titles[1]); await pause()
    return { audio: after, source: 'Invoked handlers captured when the app registered browser MediaSession actions; no OS/car controls claim' }
  })
  await run('dj-duplicates-reorder-play-remove-clear', async () => {
    const { titles } = await start(0); await pause()
    for (const index of [2, 2, 1]) await menu(index, 'Añadir a la cola')
    await queuePanel()
    const selector = '.queue-sheet .mine li[data-reorder-index] .title'
    assert.deepEqual(await page.locator(selector).allTextContents(), [titles[2], titles[2], titles[1]])
    const source = await page.locator('.queue-sheet .mine li[data-reorder-index="2"] [data-reorder-handle]').boundingBox()
    const target = await page.locator('.queue-sheet .mine li[data-reorder-index="0"]').boundingBox()
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2); await page.mouse.down()
    await page.mouse.move(target.x + 20, target.y + 5, { steps: 8 }); await page.mouse.up()
    await wait(title => document.querySelector('.queue-sheet .mine li[data-reorder-index="0"] .title')?.textContent === title, titles[1])
    await tap('.queue-sheet .mine li[data-reorder-index="1"] button.remove')
    assert.equal(await page.locator('.queue-sheet .mine li[data-reorder-index]').count(), 2)
    await tap('.queue-sheet .mine li[data-reorder-index="0"] button.main')
    await playing(titles[1])
    assert.equal(await page.locator('.queue-sheet .mine li[data-reorder-index]').count(), 1)
    await tap('.queue-sheet .queue-panel button.clear')
    assert.equal(await page.locator('.queue-sheet .mine li[data-reorder-index]').count(), 0)
    await closeOverlays(); await pause()
    return { duplicateEntries: true, reorderGesture: 'Trusted pointer drag in mobile layout; physical touch not claimed' }
  })
  await run('home-surprise-album-starts-saved-album-in-track-order', async () => {
    await music()
    const album = fixture.albums[0]
    await tap('.grid .hit[aria-label="' + album.title + '"]')
    await page.locator('.hero h1').waitFor()
    let added = false
    if (await visible('button[title="Guardar en tu biblioteca"]')) {
      await tap('button[title="Guardar en tu biblioteca"]')
      await page.locator('button[title="Quitar de tu biblioteca"]').waitFor(); added = true
    }
    await ctx.tab('Inicio'); await tap('button.surprise')
    await wait(() => window.__qaAudio.instances.some(audio => !audio.paused && audio.currentTime > 0.15))
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('pletina:web:queue:v1')))
    const chosen = saved.queue[0].albumId
    const expected = fixture.tracks.filter(track => track.album.id === chosen).map(track => track.id)
    assert.equal(expected.length, 4, 'The surprise must select a saved fixture album')
    assert.deepEqual(saved.queue.map(item => item.track.id), expected)
    assert.deepEqual(saved.order, [0, 1, 2, 3]); assert.equal(saved.pos, 0); assert.equal(saved.shuffle, false)
    const value = await playing(saved.queue[0].track.title); await pause()
    if (added) {
      await ctx.fillSearch('Buscar', media.query)
      await tap('.grid .hit[aria-label="' + album.title + '"]')
      await tap('button[title="Quitar de tu biblioteca"]')
      await page.locator('button[title="Guardar en tu biblioteca"]').waitFor()
    }
    return { albumId: chosen, orderedTrackIds: expected, audio: value, randomnessDistributionClaimed: false }
  })
  await run('artist-radio-builds-bounded-mixed-queue-and-plays', async () => {
    await music(); await tap('.top-result')
    await page.locator('.banner h1').waitFor(); await tap('button.radio')
    const context = 'Radio de ' + fixture.artists[0].name
    await wait(context => JSON.parse(localStorage.getItem('pletina:web:queue:v1') || 'null')?.context === context &&
      window.__qaAudio.instances.some(audio => !audio.paused && audio.currentTime > 0.15), context)
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('pletina:web:queue:v1')))
    const ids = saved.queue.map(item => item.track.id), artists = saved.queue.map(item => item.track.artist.id)
    assert.equal(ids.length, 12); assert.ok(ids.length <= 45); assert.equal(new Set(ids).size, ids.length)
    assert.equal(artists[0], fixture.artists[0].id); assert.equal(new Set(artists).size, 2)
    assert.deepEqual(artists.slice(0, 8), [7, 8, 7, 8, 7, 8, 7, 8])
    await playing(saved.queue[0].track.title); await seek(0.91)
    const value = await playing(saved.queue[1].track.title); await closeOverlays(); await pause()
    return { context, trackIds: ids, artistIds: artists, audio: value }
  })
  await run('context-play-next-prepends-dj-priority-without-interrupting-current', async () => {
    const { titles } = await start(0)
    await menu(1, 'Añadir a la cola'); await menu(2, 'Reproducir a continuación')
    assert.equal((await state()).title, titles[0])
    await queuePanel()
    assert.deepEqual(await page.locator('.queue-sheet .mine li[data-reorder-index] .title').allTextContents(), [titles[2], titles[1]])
    await closeOverlays(); await seek(0.91)
    const value = await playing(titles[2]); await closeOverlays(); await pause()
    await queuePanel()
    assert.deepEqual(await page.locator('.queue-sheet .mine li[data-reorder-index] .title').allTextContents(), [titles[1]])
    await tap('.queue-sheet .queue-panel button.clear'); await closeOverlays()
    return { insertedFirst: titles[2], originalQueuedSongPreserved: titles[1], audio: value }
  })
  await run('shuffle-preserves-current-and-queue-membership', async () => {
    const { titles } = await start(0); await nowPlaying()
    await tap('.np button[aria-label="Activar reproducción aleatoria"]')
    assert.equal(await page.locator('.np button[aria-label="Desactivar reproducción aleatoria"]').getAttribute('aria-pressed'), 'true')
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('pletina:web:queue:v1')))
    assert.equal(saved.shuffle, true); assert.equal(saved.order.length, saved.queue.length)
    assert.equal(new Set(saved.order).size, saved.queue.length); assert.equal((await state()).title, titles[0])
    await tap('.np button[aria-label="Desactivar reproducción aleatoria"]'); await closeOverlays(); await pause()
    return { queued: saved.queue.length, uniquePositions: saved.order.length }
  })
  await run('repeat-one-real-ended', async () => {
    const { titles } = await start(0); await nowPlaying()
    await tap('.np button[title="Repetir"]'); await tap('.np button[title="Repetir una"]')
    const ended = (await state()).events.filter(event => event.type === 'ended').length
    await seek(0.91)
    await wait(({ title, ended }) => document.querySelector('.mini .title')?.textContent.trim() === title &&
      window.__qaAudio.events.filter(event => event.type === 'ended').length > ended && window.__qaAudio.instances.some(audio => !audio.paused && audio.currentTime < 3), { title: titles[0], ended })
    await tap('.np button[title="No repetir"]'); await closeOverlays(); await pause()
    return { actualEnded: true, title: titles[0] }
  })
  await run('repeat-all-wraps-after-final-entry', async () => {
    const titles = await music(), last = titles.length - 1
    await tap(row(last) + ' .name'); await playing(titles[last]); await nowPlaying(); await tap('.np button[title="Repetir"]')
    await seek(0.91); const value = await playing(titles[0])
    await tap('.np button[title="Repetir una"]'); await tap('.np button[title="No repetir"]'); await closeOverlays(); await pause()
    return { queueLength: titles.length, wrappedTo: value.title }
  })
  await run('automatic-next-real-ended-same-audio', async () => {
    const { titles, state: before } = await start(0), index = active(before).index
    await seek(0.91); const after = await playing(titles[1])
    assert.equal(active(after).index, index); assert.equal(after.audios.length, before.audios.length)
    assert.ok(after.events.some(event => event.type === 'ended'))
    await closeOverlays(); await pause()
    return { audio: after, sourceMayHaveBeenPrefetched: true, physicalScreenOffClaimed: false }
  })
  await run('sleep-at-end-does-not-start-prepared-successor', async () => {
    const { titles } = await start(0); await nowPlaying(); await tap('.np button.timer'); await tap('dialog[open] .end-option')
    const ended = (await state()).events.filter(event => event.type === 'ended').length
    await seek(0.91)
    await wait(ended => window.__qaAudio.events.filter(event => event.type === 'ended').length > ended && window.__qaAudio.instances.every(audio => audio.paused), ended)
    const value = await state(); assert.equal(value.title, titles[0]); assert.equal(await page.locator('.np button.timer.active').count(), 0)
    await closeOverlays()
    return { audio: value }
  })
  await run('sleep-custom-validation-and-one-minute-deadline', async () => {
    const { titles } = await start(0); await nowPlaying(); await tap('.np button.timer'); await tap('dialog[open] .custom-option')
    const input = page.locator('dialog[open] input[type="number"]')
    await input.fill('0'); await tap('dialog[open] button.start')
    assert.match(await page.locator('dialog[open] [role="alert"]').textContent(), /entre 1 y 1.440/)
    await input.fill('1'); await tap('dialog[open] button.start')
    assert.equal(await page.locator('.np button.timer.active').count(), 1)
    if (!page.clock?.fastForward) return { status: 'unsupported', reason: 'Playwright browser clock is unavailable; real minute test remains pending.' }
    await wait(() => document.querySelectorAll('iframe').length === 0)
    await page.clock.fastForward(61000)
    await wait(() => window.__qaAudio.instances.every(audio => audio.paused))
    assert.equal((await state()).title, titles[0]); assert.equal(await page.locator('.np button.timer.active').count(), 0)
    await closeOverlays()
    return { elapsed: '61 seconds on controlled browser clock; actual HTMLAudio, no real-time/physical claim' }
  })
  await run('pause-during-delayed-resolution-prevents-late-autoplay', async () => {
    await fixture.reset(); await reload(); await fixture.set({ delayPlayerMs: 1000 })
    const titles = await music(); await tap(row(0) + ' .name'); await page.locator('.mini button[aria-label="Reproducir"]').waitFor()
    await tap('.mini button[aria-label="Reproducir"]')
    await page.waitForTimeout(1300)
    let value = await state(); assert.equal(value.title, titles[0]); assert.ok(value.audios.every(audio => audio.paused))
    await fixture.reset(); await tap('.mini button[aria-label="Reproducir"]'); value = await playing(titles[0]); await pause()
    return { audio: value, delayedResponseMs: 1000 }
  })
  await run('rapid-song-selection-ignores-obsolete-player-response', async () => {
    await fixture.reset(); await reload(); await fixture.set({ delayPlayerMs: 800 })
    const titles = await music(); await tap(row(0) + ' .name'); await tap(row(1) + ' .name')
    const value = await playing(titles[1]); await page.waitForTimeout(900)
    assert.equal((await state()).title, titles[1]); assert.equal(value.audios.filter(audio => audio.playing).length, 1)
    await fixture.reset(); await pause()
    return { selected: titles[1], noObsoleteAutoplay: true }
  })
  await run('provider-errors-stop-boundedly-and-explicit-retry-recovers', async () => {
    await fixture.reset(); await reload(); await fixture.set({ failPlayer: true })
    const titles = await music(); await tap(row(0) + ' .name')
    await wait(() => [...document.querySelectorAll('[role="status"]')].some(node => node.textContent.includes('No se pudo reproducir')) &&
      !document.querySelector('.mini .artist')?.textContent.includes('Cargando') && window.__qaAudio.instances.every(audio => audio.paused), null, 25000)
    const failed = await state(); assert.ok(failed.audios.every(audio => audio.paused))
    await fixture.reset(); const result = await start(0); await pause()
    assert.equal(result.state.title, titles[0])
    return { boundedFailure: failed, recovered: result.state }
  })
  await run('reload-restores-current-dj-position-and-paused-intent', async () => {
    const { titles } = await start(0); await seek(0.3); await closeOverlays(); await pause(); await menu(2, 'Añadir a la cola')
    const before = await state(), time = before.audios.find(audio => audio.source).time
    await reload(); let value = await state(); assert.equal(value.title, titles[0]); assert.ok(value.audios.every(audio => audio.paused))
    await queuePanel(); assert.equal(await page.locator('.queue-sheet .mine li[data-reorder-index]').count(), 1); await closeOverlays()
    await tap('.mini button[aria-label="Reproducir"]'); value = await playing(titles[0]); assert.ok(active(value).time >= time - 0.5)
    await pause(); await controlsOff()
    return { restoredPosition: time, audio: value, autoplay: false }
  })

  let downloaded = false
  downloaded = await run('downloads-serial-duplicate-suppression-and-cancel-pending', async () => {
    await fixture.reset(); await clearDownloads(); await music(); await fixture.set({ holdDownload: true })
    const mark = await transferMark(), ids = media.tracks.map(track => track.id)
    await menu(0, 'Descargar')
    await wait(id => window.__e2eTransfers.some(event => event.id === id && event.state === 'downloading'), ids[0])
    await menu(1, 'Descargar'); await menu(2, 'Descargar')
    await downloadsView(); await tap('.page button.cancel')
    await fixture.set({ holdDownload: false })
    assert.equal((await terminal(mark, ids[0])).state, 'done')
    assert.equal((await terminal(mark, ids[1])).state, 'cancelled'); assert.equal((await terminal(mark, ids[2])).state, 'cancelled')
    const value = await downloadState(); assert.equal(value.rows.length, 1); assert.equal(value.rows[0].id, ids[0]); assert.ok(value.rows[0].present)
    // A completed item exposes removal rather than another download action.
    await page.locator(row(0) + ' button.more').waitFor(); await tap(row(0) + ' button.more')
    assert.equal(await page.locator('[role="menuitem"]:text-is("Descargar")').count(), 0)
    await page.keyboard.press('Escape')
    return { database: value, progress: 'Opaque bodies report queued/downloading/done; byte percentages are not invented.' }
  })
  await run('download-offline-reload-play-seek-from-local-service-worker', async () => {
    if (!downloaded) return { status: 'blocked', reason: 'No validated downloaded file is available from the preceding queue scenario.' }
    await downloadsView(); const title = await page.locator(row(0) + ' .name').textContent()
    await tap(row(0) + ' .name'); await playing(title); await pause()
    let originalFailure
    try {
      const offline = await ctx.goOffline(true)
      const navigatorOfflineExpected = offline?.navigatorOfflineExpected ?? true
      await reload(); assert.equal(await page.evaluate(() => navigator.onLine), !navigatorOfflineExpected)
      assert.ok((await state()).audios.every(audio => audio.paused)); await downloadsView()
      await tap(row(0) + ' .name'); let value = await playing(title); assert.equal(active(value).local, true)
      await seek(0.5)
      await wait(() => window.__qaAudio.instances.some(audio => !audio.paused && !audio.seeking && audio.currentTime > audio.duration / 2 + 0.3))
      value = await state(); assert.equal(active(value).local, true); assert.equal(value.online, !navigatorOfflineExpected)
      await closeOverlays(); await pause()
      return { audio: value, remoteFixturesDisabled: true,
        networkMode: offline?.mode ?? 'browser-offline', navigatorOfflineExpected,
        physicalAirplaneModeClaimed: false }
    } catch (error) { originalFailure = error; throw error }
    finally {
      await ctx.goOffline(false)
      if (!await visible('.app')) {
        try {
          await page.goto(ctx.getappURL(), { waitUntil: 'load' })
          await page.locator('.bottom-nav').waitFor(); await frame()
        } catch (error) {
          if (!originalFailure) throw error
          ctx.report.errors.push({ name: 'OfflineRecoveryError', message: String(error.message).replace(/https?:\/\/[^\s]+/g, '[URL]') })
        }
      }
    }
  })
  await run('download-removal-clears-pointer-body-and-ui', async () => {
    if (!downloaded) return { status: 'blocked', reason: 'No validated downloaded file exists.' }
    await downloadsView(); await tap(row(0) + ' button.more'); await clickText('[role="menuitem"]', 'Quitar descarga')
    await page.locator('.empty-state strong').waitFor()
    const value = await downloadState(); assert.deepEqual(value.rows, []); assert.equal(value.cacheEntries, 0)
    const status = await page.evaluate(async id => (await fetch(new URL('../__audio__/' + id, location.href))).status, media.tracks[0].id)
    assert.equal(status, 404)
    return { database: value, missingStatus: status }
  })
  for (const failure of ['quotaFailure', 'storageFailure', 'failMedia']) await run('download-' + failure + '-rollback-and-no-false-done', async () => {
    await fixture.reset(); await clearDownloads(); await music()
    const result = await fixture.set({ [failure]: true })
    if (result?.status === 'unsupported') return result
    const mark = await transferMark(), id = media.tracks[1].id
    try {
      await menu(1, 'Descargar'); const event = await terminal(mark, id)
      assert.equal(event.state, 'error', 'A platform/provider failure cannot be marked completed')
      const value = await downloadState(); assert.deepEqual(value.rows, []); assert.equal(value.cacheEntries, 0)
      return { event, database: value, injectedFailure: failure }
    } finally { await fixture.reset() }
  })
  await run('download-retry-after-provider-failure-succeeds', async () => {
    await fixture.reset(); await music(); const mark = await transferMark(), id = media.tracks[1].id
    await menu(1, 'Descargar'); assert.equal((await terminal(mark, id)).state, 'done')
    const value = await downloadState(); assert.ok(value.rows.find(row => row.id === id)?.present)
    await clearDownloads()
    return { databaseBeforeCleanup: value }
  })

  async function podcast(kind) {
    await closeOverlays(); await pause(); await controlsOff(); await ctx.fillSearch('Podcasts', kind.query)
    const section = kind === media.youtubePodcast ? '[aria-label="Pódcasts de YouTube"]' : '[aria-label="Resultados de pódcasts"]'
    const hit = `${section} .card button.hit[aria-label="${kind.showTitle}"]`
    await page.locator(hit).waitFor(); await tap(hit)
    await page.locator('.episodes .episode-play').first().waitFor()
  }
  async function progress(id) {
    return page.evaluate(async id => {
      const db = await new Promise(resolve => { const request = indexedDB.open('pletina-web-library'); request.onsuccess = () => resolve(request.result) })
      try { return await new Promise(resolve => { const request = db.transaction('progress').objectStore('progress').get(id); request.onsuccess = () => resolve(request.result ?? null) }) }
      finally { db.close() }
    }, id)
  }
  const currentId = () => page.evaluate(() => { const saved = JSON.parse(localStorage.getItem('pletina:web:queue:v1')); return (saved.manual ?? saved.queue[saved.order[saved.pos]]).track.id })
  await run('rss-podcast-direct-audio-progress-reload-and-resume', async () => {
    await fixture.reset(); await podcast(media.rss)
    await tap('.episodes li:nth-child(1) .episode-play'); let value = await playing(media.rss.episodes[0].title)
    assert.equal(active(value).host, 'media.pletina.test'); assert.ok(active(value).duration >= 89)
    await seek(0.1); await wait(() => window.__qaAudio.instances.some(audio => audio.currentTime >= 8 && !audio.seeking)); await closeOverlays(); await pause()
    const id = await currentId(); assert.ok(id >= 750_000_000_000_000)
    await wait(async id => {
      const db = await new Promise(resolve => { const request = indexedDB.open('pletina-web-library'); request.onsuccess = () => resolve(request.result) })
      try { return await new Promise(resolve => { const request = db.transaction('progress').objectStore('progress').get(id); request.onsuccess = () => resolve(request.result?.position >= 8) }) }
      finally { db.close() }
    }, id)
    const saved = await progress(id); assert.equal(saved.completed, false)
    await reload(); assert.ok((await state()).audios.every(audio => audio.paused)); await tap('.mini button[aria-label="Reproducir"]')
    value = await playing(media.rss.episodes[0].title); assert.ok(active(value).time >= saved.position - 0.5)
    await pause()
    return { id, saved, resumed: value, actualRSSBytes: true }
  })
  await run('rss-completion-next-episode-and-relisten-from-zero', async () => {
    await podcast(media.rss); await tap('.episodes li:nth-child(1) .episode-play'); await playing(media.rss.episodes[0].title)
    const id = await currentId(); await seek(0.985)
    await playing(media.rss.episodes[1].title); assert.equal((await progress(id)).completed, true)
    await closeOverlays(); await tap('.episodes li:nth-child(1) .episode-play')
    const value = await playing(media.rss.episodes[0].title); assert.ok(active(value).time < 3)
    await pause()
    return { completedEpisode: id, restartedAtZero: true }
  })
  await run('youtube-podcast-keeps-episode-namespace-and-progress', async () => {
    await podcast(media.youtubePodcast); await tap('.episodes li:nth-child(1) .episode-play')
    let value = await playing(media.youtubePodcast.episodeTitle)
    assert.equal(active(value).host, 'fixture.googlevideo.com')
    const id = await currentId(); assert.ok(id >= 750_000_000_000_000 && id < 1_000_000_000_000_000)
    await seek(0.1); await wait(() => window.__qaAudio.instances.some(audio => audio.currentTime >= 8 && !audio.seeking)); await closeOverlays(); await pause()
    const saved = await progress(id); assert.ok(saved.position >= 8)
    await reload(); assert.ok((await state()).audios.every(audio => audio.paused)); await tap('.mini button[aria-label="Reproducir"]')
    value = await playing(media.youtubePodcast.episodeTitle); assert.ok(active(value).time >= saved.position - 0.5); await pause()
    return { id, saved, resumed: value, separateFromStandaloneYouTubeTracks: true }
  })
  await run('audio-log-export-is-local-bounded-and-has-no-source-addresses', async () => {
    await closeOverlays(); await clickText('.bottom-nav button', 'Tu biblioteca')
    const nativeShare = await page.evaluate(() => typeof navigator.share === 'function' && Boolean(navigator.canShare?.({ files: [new File(['{}'], 'qa.json', { type: 'application/json' })] })))
    if (nativeShare) return { status: 'unsupported', reason: 'This engine delegates file sharing to an OS picker; automated recipient selection is outside browser-only E2E.' }
    const download = page.waitForEvent('download', { timeout: 15000 })
    await clickText('.page .about button', 'Enviar registro')
    const file = await download, path = await file.path()
    const text = await readFile(path, 'utf8'), value = JSON.parse(text)
    assert.equal(value.format, 'pletina-web-audio-log'); assert.ok(value.events.length > 0 && value.events.length <= 256)
    assert.doesNotMatch(text, /https?:|googlevideo|signature|visitorData|access_token/)
    for (const event of value.events) assert.deepEqual(Object.keys(event).sort(), ['at', 'status', 'time', 'type'])
    return { entries: value.events.length, sharedBy: 'Local JSON download fallback; OS share recipients not exercised' }
  })
  await fixture.reset(); await ctx.goOffline(false); await closeOverlays(); await pause()
}
