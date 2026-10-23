// Compiled Svelte UI + real HTMLAudio. Provider bytes and failure modes come from HTTP fixtures.
// Reads of browser storage and the test-only Audio observer are assertions, never player commands.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

export const mediaScenarioInventory = Object.freeze([
  'selection-html-audio', 'music-unplayable-rescues-distinct-web-source-without-skipping-song',
  'p1-multiple-aac-isolates-invalid-and-denied-candidates-without-video-or-download',
  'p1-primary-network-rescues-same-id-with-native-aac-without-video',
  'p1-all-probes-transient-retries-same-id-and-stops-without-video',
  'youtube-unplayable-rescues-exact-audius-isrc-and-advances-with-same-audio',
  'audius-homonym-with-wrong-isrc-or-artist-never-starts-audio',
  'pause-seek-next-previous-one-audio', 'media-session-metadata-and-idempotent-actions',
  'artist-popular-selection-immediately-shows-loading-and-long-wait-feedback',
  'artist-current-byline-plays-row-and-guest-byline-only-navigates',
  'artist-latest-selection-wins-before-previous-provider-response',
  'artist-a-b-a-never-reuses-the-aborting-first-request',
  'artist-loading-cancel-prevents-late-play-and-explicit-retry-recovers',
  'artist-final-track-error-clears-loading-and-explicit-retry-keeps-track',
  'audio-final-retry-first-refresh-recovers-without-video-or-extra-click',
  'audio-final-retry-second-refresh-recovers-without-video-or-extra-click',
  'audio-final-retry-exhaustion-opens-video-only-after-three-audio-failures',
  'audio-final-retry-cancel-or-replace-prevents-late-audio-and-video',
  'now-playing-synthetic-touch-swipe-threshold-and-interactive-origin',
  'home-surprise-album-starts-saved-album-in-track-order', 'artist-radio-builds-bounded-mixed-queue-and-plays',
  'artist-radio-related-provider-failure-keeps-playable-seed-and-visible-warning',
  'source-change-during-playback-keeps-song-and-one-audio-through-resume',
  'context-play-next-prepends-dj-priority-without-interrupting-current',
  'dj-duplicates-reorder-play-remove-clear', 'shuffle-preserves-current-and-queue-membership', 'repeat-one-real-ended',
  'repeat-all-wraps-after-final-entry', 'automatic-next-real-ended-same-audio', 'sleep-at-end-does-not-start-prepared-successor',
  'sleep-custom-validation-and-one-minute-deadline', 'pause-during-delayed-resolution-prevents-late-autoplay',
  'rapid-song-selection-ignores-obsolete-player-response', 'provider-errors-stop-boundedly-and-explicit-retry-recovers',
  'reload-restores-current-dj-position-and-paused-intent', 'downloads-serial-duplicate-suppression-and-cancel-pending',
  'download-remove-all-cancel-preserves-files-and-reload-ui',
  'download-offline-reload-play-seek-from-local-service-worker', 'download-removal-clears-pointer-body-and-ui',
  'download-automatic-renewal-after-one-transfer-failure-and-offline-play',
  'offline-mixed-queue-skips-four-remote-entries-at-ended-with-one-audio',
  'offline-dj-missing-cache-repeat-all-stops-boundedly',
  'durable-download-queue-reopens-offline-and-resumes-fifo-online',
  'durable-download-cancellation-survives-reload-without-ghost-jobs',
  'durable-download-owner-window-handoff-preserves-pending-fifo',
  'download-startup-reconciles-orphan-stages-and-preserves-committed-files',
  'audius-permitted-full-file-download-hash-and-offline-playback',
  'download-quotaFailure-rollback-and-no-false-done', 'download-storageFailure-rollback-and-no-false-done',
  'download-failMedia-rollback-and-no-false-done', 'download-retry-after-provider-failure-succeeds',
  'rss-podcast-direct-audio-progress-reload-and-resume', 'rss-completion-next-episode-and-relisten-from-zero',
  'youtube-podcast-keeps-episode-namespace-and-progress', 'audio-log-export-is-local-bounded-and-has-no-source-addresses',
].map(name => ({ id: 'media.' + name })))

export async function runMediaScenarios(ctx, { scenarioIds = null } = {}) {
  const { page, context, fixture, check, tap, clickText } = ctx
  const media = fixture.media
  const requested = scenarioIds ? new Set(scenarioIds.map(name => name.replace(/^media\./, ''))) : null
  const selectedScenario = name => !requested || name === 'selection-html-audio' || requested.has(name)
  const run = (name, fn) => selectedScenario(name) ? check('media.' + name, fn) : true
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
    if (await visible('dialog[data-official-youtube][open] #official-youtube-close')) await tap('dialog[data-official-youtube][open] #official-youtube-close')
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
    // Search deliberately keeps its previous rows during the debounce/network
    // phase. An existing row can still belong to the preceding rescue query.
    await wait(titles => {
      const rows = [...document.querySelectorAll('.tracks li[data-reorder-index] .name')]
      return titles.every((title, index) => rows[index]?.textContent.trim() === title)
    }, media.tracks.map(track => track.title))
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

  // These scenarios need the browser's actual offline signal to select local
  // queue entries. Unlike an offline reload, WebKit can exercise the existing
  // document with protocol-offline mode while its production worker stays put.
  async function offlineInDocument() {
    if (ctx.engine !== 'webkit') return ctx.goOffline(true)
    await fixture.set({ offline: true })
    await context.setOffline(true)
    assert.equal(await page.evaluate(() => navigator.onLine), false, 'The offline queue must observe a browser-originated offline state')
    return { mode: 'browser-offline-existing-document', navigatorOfflineExpected: true }
  }
  async function restoreNetwork() {
    // ctx.goOffline uses an origin gate on WebKit. Restore protocol-offline too
    // when a preceding scenario used it without navigation.
    await context.setOffline(false)
    await ctx.goOffline(false)
  }
  function observeProviderRequests() {
    const attempts = [], rows = new Map()
    const observe = request => {
      const url = new URL(request.url())
      if (/(?:^|\.)(?:youtube\.com|googlevideo\.com|audius\.co)$/.test(url.hostname))
        {
          const row = { host: url.hostname, path: url.pathname, type: request.resourceType(), failed: null, responseStatus: null, fromServiceWorker: null }
          rows.set(request, row); attempts.push(row)
        }
    }
    const failed = request => { const row = rows.get(request); if (row) row.failed = request.failure()?.errorText ?? 'failed' }
    const response = value => { const row = rows.get(value.request()); if (row) { row.responseStatus = value.status(); row.fromServiceWorker = value.fromServiceWorker() } }
    page.on('request', observe)
    page.on('requestfailed', failed); page.on('response', response)
    return { attempts, stop: () => { page.off('request', observe); page.off('requestfailed', failed); page.off('response', response) } }
  }
  function assertOfflineProviderDelivery(observer, mark, fixtureMark) {
    const observed = observer.attempts.slice(mark)
    assert.deepEqual(observed.filter(row => row.type !== 'media'), [], 'Offline queue navigation must not start remote API, source-resolution or fetch requests')
    for (const row of observed) {
      // Firefox reports the original URL of an opaque cached Response as a
      // media request. The standalone native control proves its HTTP200 comes
      // from the production SW, even with both servers physically unavailable.
      assert.ok(row.failed && row.responseStatus === null || row.fromServiceWorker === true && [200, 206].includes(row.responseStatus),
        'Every observed media alias must fail offline or be delivered by the service worker, never external network')
    }
    const delivered = fixture.requests.slice(fixtureMark).filter(row => /(?:^|\.)(?:youtube\.com|googlevideo\.com|audius\.co)$/.test(row.host))
    assert.deepEqual(delivered, [], 'No provider request may reach the external HTTP fixture transport while offline')
    return { appProviderRequests: 0, externalFixtureDeliveries: 0, nativeMediaObservations: observed }
  }
  async function offlineQueueHostLimitation() {
    if (ctx.engine !== 'webkit' || process.platform !== 'linux') return null
    const evidence = 'artifacts/pwa-e2e/webkit-offline-protocol-1662d64a013d4781-linux.json'
    let control
    try { control = JSON.parse(await readFile(new URL('../../../' + evidence, import.meta.url), 'utf8')) } catch { return null }
    if (!control.hostProtocolLimitConfirmed || !control.workerUnchanged || control.host.platform !== process.platform ||
      control.browserVersion !== ctx.browser.version()) return null
    return { status: 'unsupported', reason: 'This exact desktop WebKit host rejects production-SW cached HTMLAudio with mediaError4 under protocol-offline mode. Independent native controls reproduce it with both readable and opaque known AAC, without the Pletina Player. Origin-gate cached playback passes but does not set navigator.onLine=false, so it cannot verify offline queue selection. Physical iPhone behavior remains unverified.',
      evidence, controlBuild: control.build, controlBrowserVersion: control.browserVersion, physicalPhoneClaimed: false }
  }
  async function sourceChoiceSnapshot() {
    return page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('pletina-web-library')
        request.onupgradeneeded = () => request.transaction.abort()
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
      })
      try {
        return await new Promise((resolve, reject) => {
          const request = db.transaction('sources').objectStore('sources').getAll()
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
        })
      } finally { db.close() }
    })
  }
  function assertEarlierChoicesPreserved(before, after) {
    const current = new Map(after.map(row => [row.trackId, row.choice]))
    for (const row of before) assert.deepEqual(current.get(row.trackId), row.choice,
      'Fresh fixture jobs must preserve earlier source choices, including the manually changed recording')
  }
  async function pendingDownloadCheckpoint() {
    return page.evaluate(async () => {
      if (!(await indexedDB.databases()).some(db => db.name === 'pletina-web-download-queue')) return null
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('pletina-web-download-queue')
        request.onupgradeneeded = () => request.transaction.abort()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(new Error('Pending download checkpoint unavailable'))
      })
      try {
        return await new Promise((resolve, reject) => {
          const request = db.transaction('state', 'readonly').objectStore('state').get('pending')
          request.onsuccess = () => resolve(request.result ?? null)
          request.onerror = () => reject(request.error)
        })
      } finally { db.close() }
    })
  }
  function assertPendingCheckpoint(checkpoint, expectedIds) {
    assert.equal(checkpoint?.version, 1)
    assert.deepEqual(checkpoint.tracks.map(track => track.id), expectedIds)
    const fields = new Set(['id', 'title', 'duration', 'explicit', 'artistId', 'artistName', 'albumId', 'albumTitle', 'albumArtistId', 'cover', 'isrc', 'titleVersion'])
    for (const track of checkpoint.tracks) for (const key of Object.keys(track)) assert.ok(fields.has(key), `Unexpected durable job field ${key}`)
    // Permanent cover artwork is catalog metadata. Media locators, Blob URLs,
    // capabilities and expiring provider credentials must never be checkpointed.
    assert.doesNotMatch(JSON.stringify(checkpoint), /blob:|googlevideo\.com|api\.audius\.co|signatureCipher|access_token|visitorData|[?&](?:expire|sig|token)=/i)
  }
  async function removeCachedBody(id) {
    return page.evaluate(async id => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('pletina-web-downloads')
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
      })
      try {
        const row = await new Promise((resolve, reject) => {
          const request = db.transaction('files').objectStore('files').get(id)
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
        })
        if (!row) throw new Error('Eviction control requires an actual committed download')
        return (await caches.open('pletina-audio-downloads:v1')).delete(row.cacheKey)
      } finally { db.close() }
    }, id)
  }
  async function downloadMusic(indices) {
    for (const index of indices) {
      const mark = await transferMark(), id = fixture.tracks[index].id
      await menu(index, 'Descargar')
      assert.equal((await terminal(mark, id)).state, 'done')
    }
  }
  async function cleanDownloadScenario() {
    await restoreNetwork(); await fixture.reset(); await closeOverlays(); await pause()
    await downloadsView()
    if (await visible('.page button.cancel')) await tap('.page button.cancel')
    await clearDownloads()
  }

  // Windows WebKit's native media transport bypasses Playwright routes/proxy and service workers.
  // The isolated AAC probe distinguishes this test-host limitation from an application failure.
  // Linux CI must run the scenarios instead of inheriting a blanket WebKit exemption.
  const webkitVersion = ctx.engine === 'webkit' ? ctx.browser.version() : null
  if (process.platform === 'win32' && webkitVersion === '26.5') {
    for (const scenario of mediaScenarioInventory.filter(scenario => selectedScenario(scenario.id.replace(/^media\./, '')))) await check(scenario.id, async () => ({
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
    for (const scenario of mediaScenarioInventory.slice(1).filter(scenario => selectedScenario(scenario.id.replace(/^media\./, '')))) await check(scenario.id, async () => ({ status: 'blocked', reason: 'The initial compiled-player audio prerequisite failed.' }))
    return
  }

  const selection = media.artistSelection
  const selectionIds = ['artist-popular-selection-immediately-shows-loading-and-long-wait-feedback',
    'artist-current-byline-plays-row-and-guest-byline-only-navigates', 'artist-latest-selection-wins-before-previous-provider-response',
    'artist-a-b-a-never-reuses-the-aborting-first-request', 'artist-loading-cancel-prevents-late-play-and-explicit-retry-recovers',
    'artist-final-track-error-clears-loading-and-explicit-retry-keeps-track']
  async function captureSelection(name) {
    const directory = new URL('../../../artifacts/pwa-e2e/', import.meta.url)
    await mkdir(directory, { recursive: true })
    const filename = `artist-selection-${ctx.report.build}-${ctx.profile}-${name}.png`
    await writeFile(new URL(filename, directory), await page.screenshot({ fullPage: true }))
    return 'artifacts/pwa-e2e/' + filename
  }
  async function selectionArtist() {
    await closeOverlays(); await pause(); await controlsOff(); await fixture.reset(); await reload()
    await ctx.fillSearch('Buscar', selection.query)
    await wait(title => document.querySelector('.tracks li[data-reorder-index="0"] .name')?.textContent.trim() === title, selection.tracks[0].title)
    await tap('.top-result')
    await wait(name => document.querySelector('.banner h1')?.textContent.trim() === name && document.querySelectorAll('.tracks li[data-reorder-index]').length === 4, selection.artists[0].name)
  }
  async function selectedLoading(index) {
    const selected = row(index)
    await page.locator(selected + ' .row.loading[aria-busy="true"][aria-current="true"]').waitFor()
    assert.equal((await page.locator(selected + ' .loading-text').textContent()).trim(), 'Preparando audio…')
    await page.locator('.mini[aria-busy="true"]').waitFor()
    assert.equal((await page.locator('.mini .title').textContent()).trim(), selection.tracks[index].title)
    assert.equal((await page.locator('.mini .artist').textContent()).trim(), 'Preparando audio…')
    await page.locator('.mini button[aria-label="Cancelar carga"]').waitFor()
    assert.ok((await state()).audios.every(audio => audio.paused), 'The preceding source must stop while the selected song resolves')
    assert.equal(await page.locator('.banner h1').textContent(), selection.artists[0].name, 'A song click must not navigate away from its artist')
  }
  async function selectedPlaying(index) {
    const expected = selection.tracks[index]
    await wait(({ title, videoId }) => document.querySelector('.mini .title')?.textContent.trim() === title &&
      document.querySelector('.mini')?.getAttribute('aria-busy') !== 'true' &&
      window.__qaAudio.instances.some(audio => !audio.paused && audio.currentTime > .15 && new URL(audio.currentSrc || audio.src).pathname === '/audio/' + videoId),
    { title: expected.title, videoId: expected.videoId })
    const value = await state()
    assert.equal(value.audios.length, 1); assert.equal(value.audios.filter(audio => audio.playing).length, 1)
    assert.equal(value.title, expected.title)
    await wait(index => document.querySelector(`.tracks li[data-reorder-index="${index}"] .row`)?.getAttribute('aria-busy') !== 'true', index)
    assert.equal(await page.locator(row(index) + ' .row[aria-busy="true"]').count(), 0, 'The playing row must finish loading')
    return value
  }
  async function observeSelectionSources() {
    await page.evaluate(() => {
      const qa = window.__qaAudio, audio = qa.instances[0]
      qa.selectionSamples = []
      const observe = event => {
        const identity = value => { try { return new URL(value).pathname.match(/^\/audio\/([\w-]{11})$/)?.[1] ?? null } catch { return null } }
        qa.selectionSamples.push({ event: event.type, videoId: identity(audio.currentSrc || audio.src), requestedVideoId: identity(audio.src),
          paused: audio.paused, time: Number.isFinite(audio.currentTime) ? audio.currentTime : null,
          duration: Number.isFinite(audio.duration) ? audio.duration : null, readyState: audio.readyState,
          at: performance.now(), playing: qa.instances.filter(value => !value.paused).length })
      }
      const events = ['playing', 'timeupdate', 'loadstart', 'emptied', 'pause']
      for (const event of events) audio.addEventListener(event, observe)
      observe({ type: 'initial' })
      qa.stopSelectionObserver = () => { for (const event of events) audio.removeEventListener(event, observe) }
    })
  }
  function assertSelectedSource(samples, expected) {
    // play() clears paused before a new resource becomes currentSrc. A queued
    // reset timeupdate may still name the former source before the new playing
    // event; it is not evidence that the old recording resumed. The requested
    // resource must already be the latest selection throughout, and every real
    // playing event plus subsequent progress must identify that selection.
    const firstPlaying = samples.findIndex(sample => sample.event === 'playing')
    const active = samples.filter(sample => !sample.paused)
    assert.ok(firstPlaying >= 0 && active.every(sample => sample.requestedVideoId === expected && sample.playing === 1) &&
      samples.filter(sample => sample.event === 'playing').every(sample => sample.videoId === expected) &&
      samples.slice(firstPlaying).filter(sample => !sample.paused).every(sample => sample.videoId === expected), JSON.stringify({ expected, samples }))
    for (const sample of samples.slice(0, firstPlaying)) {
      if (sample.paused || sample.videoId === expected || sample.readyState === 0 || sample.time === 0) continue
      const sameOldSource = samples.slice(0, firstPlaying).filter(value => value.videoId === sample.videoId && value.time !== null)
      const times = sameOldSource.map(value => value.time)
      assert.ok(times.length > 1 && Math.max(...times) - Math.min(...times) <= .1,
        JSON.stringify({ expected, reason: 'The former source advanced before the new source started', samples }))
    }
  }
  async function selectionCleanup() {
    fixture.release()
    await page.evaluate(() => { window.__qaAudio?.stopSelectionObserver?.() }).catch(() => {})
    await fixture.reset(); await closeOverlays(); await pause()
  }
  if (selectionIds.some(selectedScenario)) {
    await run(selectionIds[0], async () => {
      await selectionArtist(); const gate = fixture.holdNextPlayer(selection.tracks[1].videoId)
      try {
        await tap(row(0) + ' .name'); await selectedPlaying(0)
        await tap(row(1) + ' .name'); await gate.waitForRequest(); await selectedLoading(1)
        const screenshot = await captureSelection('loading')
        // Only the application's six-second feedback clock advances. The HTTP
        // provider response remains held, so this cannot simulate a fast source.
        await page.clock.runFor(6100)
        await page.locator('.mini .loading-wait').waitFor()
        assert.equal((await page.locator('.mini .loading-wait').textContent()).trim(), 'Está tardando… Puedes elegir otra canción')
        const waitingScreenshot = await captureSelection('long-wait')
        gate.release(); const delivery = await gate.waitForDelivery(); const value = await selectedPlaying(1)
        return { selected: selection.tracks[1].title, actualHTTPGate: true, delivery: delivery.playerGate, audio: value,
          feedbackClockAdvancedMs: 6100, physicalWaitClaimed: false, screenshots: [screenshot, waitingScreenshot] }
      } finally { await selectionCleanup() }
    })
    await run(selectionIds[1], async () => {
      await selectionArtist(); const gate = fixture.holdNextPlayer(selection.tracks[1].videoId)
      try {
        await tap(row(0) + ' .name'); await selectedPlaying(0)
        // Same-artist bylines are deliberately row content on an artist page;
        // guest-artist links retain navigation and stop propagation.
        const byline = await page.locator(row(1) + ' .by .artist-name').count() ? row(1) + ' .by .artist-name' : row(1) + ' .by button.link'
        await tap(byline); await frame()
        assert.equal((await state()).title, selection.tracks[1].title, 'The byline of the already-open artist must select its song, rather than silently navigating to the same artist')
        await gate.waitForRequest(); await selectedLoading(1)
        gate.release(); await gate.waitForDelivery(); await selectedPlaying(1)
        await tap(row(3) + ' .by button.artist-name')
        await wait(name => document.querySelector('.banner h1')?.textContent.trim() === name, selection.artists[1].name)
        assert.equal((await state()).title, selection.tracks[1].title)
        assert.equal((await state()).audios.filter(audio => audio.playing).length, 1)
        return { currentArtistByline: 'selected row without navigation', guestArtistByline: 'navigated without changing audio', audio: await state() }
      } finally { await selectionCleanup() }
    })
    await run(selectionIds[2], async () => {
      await selectionArtist(); const b = fixture.holdNextPlayer(selection.tracks[1].videoId), c = fixture.holdNextPlayer(selection.tracks[2].videoId)
      try {
        await tap(row(0) + ' .name'); await selectedPlaying(0)
        await tap(row(1) + ' .name'); await b.waitForRequest(); await selectedLoading(1)
        await tap(row(2) + ' .name'); await c.waitForRequest(); await selectedLoading(2)
        await observeSelectionSources(); b.release(); const oldDelivery = await b.waitForDelivery(); await frame()
        await selectedLoading(2); assert.equal(await page.locator(row(1) + ' .row.loading').count(), 0)
        c.release(); await c.waitForDelivery(); const value = await selectedPlaying(2)
        const samples = await page.evaluate(() => window.__qaAudio.selectionSamples)
        assertSelectedSource(samples, selection.tracks[2].videoId)
        return { obsoleteRequest: oldDelivery.playerGate, selected: selection.tracks[2].title, samples, audio: value }
      } finally { await selectionCleanup() }
    })
    await run(selectionIds[3], async () => {
      await selectionArtist(); const mark = fixture.requests.length, a = fixture.holdNextPlayer(selection.tracks[0].videoId), b = fixture.holdNextPlayer(selection.tracks[1].videoId)
      try {
        await tap(row(0) + ' .name'); await a.waitForRequest()
        await tap(row(1) + ' .name'); await b.waitForRequest()
        await observeSelectionSources(); await tap(row(0) + ' .name')
        const value = await selectedPlaying(0)
        assert.equal(fixture.requests.slice(mark).filter(request => request.operation === 'player' && request.videoId === selection.tracks[0].videoId).length, 2,
          'Returning to A must issue a fresh player request while its first request is being aborted')
        a.release(); b.release(); await Promise.all([a.waitForDelivery(), b.waitForDelivery()]); await frame()
        assert.equal((await state()).title, selection.tracks[0].title)
        const samples = await page.evaluate(() => window.__qaAudio.selectionSamples)
        assertSelectedSource(samples, selection.tracks[0].videoId)
        return { gestureSequence: 'A → B → A', freshARequests: 2, samples, audio: value }
      } finally { await selectionCleanup() }
    })
    await run(selectionIds[4], async () => {
      await selectionArtist(); const gate = fixture.holdNextPlayer(selection.tracks[1].videoId)
      try {
        await tap(row(0) + ' .name'); await selectedPlaying(0)
        await tap(row(1) + ' .name'); await gate.waitForRequest(); await selectedLoading(1)
        await tap('.mini button[aria-label="Cancelar carga"]')
        await page.locator('.mini button[aria-label="Reproducir"]').waitFor()
        gate.release(); const delivery = await gate.waitForDelivery(); await frame()
        const stopped = await state(); assert.equal(stopped.title, selection.tracks[1].title); assert.ok(stopped.audios.every(audio => audio.paused))
        assert.equal(await page.locator('.mini[aria-busy="true"]').count(), 0, 'The cancelled selection must finish loading')
        await tap('.mini button[aria-label="Reproducir"]'); const value = await selectedPlaying(1)
        return { cancelledDelivery: delivery.playerGate, lateAutoplay: false, explicitRetry: true, audio: value }
      } finally { await selectionCleanup() }
    })
    await run(selectionIds[5], async () => {
      await selectionArtist(); await fixture.set({ failPlayer: true })
      try {
        const last = selection.tracks.length - 1
        await tap(row(last) + ' .name')
        await wait(() => [...document.querySelectorAll('[role="status"]')].some(node => node.textContent.includes('No se pudo reproducir')) &&
          window.__qaAudio.instances.every(audio => audio.paused) && !document.querySelector('.mini[aria-busy="true"]'))
        assert.equal((await state()).title, selection.tracks[last].title)
        assert.equal(await visible('dialog[data-official-youtube][open]'), false)
        await page.locator('.mini button[aria-label="Reproducir"]').waitFor()
        await fixture.set({ failPlayer: false }); await tap('.mini button[aria-label="Reproducir"]')
        const value = await selectedPlaying(last)
        return { queuePosition: 'final entry: no automatic-next policy change', retainedTitle: selection.tracks[last].title, visibleFailure: true, explicitRetry: true, audio: value }
      } finally { await selectionCleanup() }
    })
  }

  const retryIds = ['audio-final-retry-first-refresh-recovers-without-video-or-extra-click',
    'audio-final-retry-second-refresh-recovers-without-video-or-extra-click',
    'audio-final-retry-exhaustion-opens-video-only-after-three-audio-failures',
    'audio-final-retry-cancel-or-replace-prevents-late-audio-and-video']
  if (retryIds.some(selectedScenario)) {
    const retries = media.audioRetry
    assert.ok(retries?.tracks?.length === 6 && fixture.planPlayer, 'Dedicated final-retry HTTP fixtures are required')
    const trace = (mark, id) => fixture.requests.slice(mark).filter(request => request.fixtureCase === 'audio-final-retry' && (!id || request.videoId === id))
      .map(({ operation, videoId, clientName, playability, cycle, requestedTrackId, candidateIds }) => ({ operation,
        ...(videoId ? { videoId } : {}), ...(clientName ? { clientName } : {}), ...(playability ? { playability } : {}), ...(cycle ? { cycle } : {}),
        ...(requestedTrackId ? { requestedTrackId } : {}), ...(candidateIds ? { candidateIds } : {}) }))
    const observe = () => {
      if (window.__qaRetry) return
      const observation = window.__qaRetry = { events: [], clicks: [] }
      window.addEventListener('pletina:audio-retry', ({ detail }) => observation.events.push({ trackId: detail.trackId, attempt: detail.attempt, total: detail.total }))
      document.addEventListener('click', event => {
        const title = event.target.closest?.('.tracks li[data-reorder-index] .name')
        if (title) observation.clicks.push({ title: title.textContent.trim(), trusted: event.isTrusted })
      }, true)
    }
    async function retrySearch(track) {
      await closeOverlays(); await pause(); await controlsOff(); await fixture.reset(); await reload()
      await page.evaluate(observe)
      await ctx.fillSearch('Buscar', retries.query(track.title.replace('Reintento QA ', '')))
      await wait(title => document.querySelector('.tracks li[data-reorder-index="0"] .name')?.textContent.trim() === title, track.title)
    }
    const retryEvents = track => page.evaluate(id => window.__qaRetry.events.filter(event => event.trackId === id), track.id)
    async function retryBusy(track, attempt) {
      await wait(({ title, message }) => document.querySelector('.mini .title')?.textContent.trim() === title &&
        document.querySelector('.mini[aria-busy="true"] .artist')?.textContent.trim() === message &&
        document.querySelector('.mini button[aria-label="Cancelar carga"]'), { title: track.title, message: `Reintentando audio (${attempt}/2)…` })
      assert.equal(await visible('dialog[data-official-youtube][open]'), false)
      assert.equal(await page.locator('iframe[data-official-video]').count(), 0)
      assert.deepEqual(await retryEvents(track), Array.from({ length: attempt }, (_, i) => ({ trackId: track.id, attempt: i + 1, total: 2 })))
    }
    async function retryPlaying(track) {
      // No helper may supply another Play gesture: automatic recovery must use
      // the original title click and the same native Audio pipeline.
      await wait(({ title, videoId }) => document.querySelector('.mini .title')?.textContent.trim() === title &&
        window.__qaAudio.instances.some(audio => !audio.paused && !audio.error && audio.readyState >= 2 && audio.currentTime > .2 &&
          new URL(audio.currentSrc || audio.src).pathname === '/audio/' + videoId), { title: track.title, videoId: track.videoId })
      await page.locator('.mini button[aria-label="Pausa"]').waitFor()
      const value = await state()
      assert.equal(value.audios.length, 1); assert.equal(value.title, track.title)
      if (value.metadata) assert.equal(value.metadata.title, track.title)
      assert.equal(await page.locator('iframe[data-official-video]').count(), 0)
      assert.equal(await visible('dialog[data-official-youtube][open]'), false)
      return value
    }
    async function queueIdentity() {
      return page.evaluate(() => {
        const queue = JSON.parse(localStorage.getItem('pletina:web:queue:v1') || 'null')
        return { currentId: queue?.queue?.[queue.order?.[queue.pos]]?.track.id ?? null, ids: queue?.queue?.map(item => item.track.id) ?? [] }
      })
    }
    async function retryCleanup() {
      fixture.release(); await closeOverlays()
      await page.evaluate(() => { window.__qaAudio?.stopSelectionObserver?.() }).catch(() => {})
      if (await visible('.mini button[aria-label="Cancelar carga"]')) await tap('.mini button[aria-label="Cancelar carga"]')
      await pause(); await fixture.reset()
    }
    for (const attempt of [1, 2]) await run(retryIds[attempt - 1], async () => {
      const track = retries.tracks[attempt - 1]
      await retrySearch(track); fixture.planPlayer(track.videoId, { rejectCycles: attempt })
      const gate = fixture.holdNextPlayer(track.videoId, { clientName: 'VISIONOS', occurrence: attempt + 1 }), mark = fixture.requests.length
      try {
        await tap(row(0) + ' .name'); await gate.waitForRequest(); await retryBusy(track, attempt)
        const screenshot = await captureSelection('audio-retry-' + attempt)
        assert.deepEqual(await queueIdentity(), { currentId: track.id, ids: [track.id] })
        gate.release(); await gate.waitForDelivery(); const value = await retryPlaying(track)
        const players = trace(mark, track.videoId).filter(request => request.operation === 'player')
        const expected = Array.from({ length: attempt }, (_, i) => [
          { operation: 'player', videoId: track.videoId, clientName: 'VISIONOS', playability: 'UNPLAYABLE', cycle: i + 1 },
          { operation: 'player', videoId: track.videoId, clientName: 'WEB_EMBEDDED_PLAYER', playability: 'UNPLAYABLE', cycle: i + 1 },
        ]).flat().concat({ operation: 'player', videoId: track.videoId, clientName: 'VISIONOS', playability: 'OK', cycle: attempt + 1 })
        assert.deepEqual(players, expected, 'Only the chosen recording may be retried; stop immediately after success')
        const searches = trace(mark).filter(request => /^(music|web)-search$/.test(request.operation))
        assert.deepEqual(searches.map(request => request.operation), ['music-search', 'web-search'], 'Final audio retries cannot repeat discovery or modal searches')
        assert.deepEqual(await retryEvents(track), Array.from({ length: attempt }, (_, i) => ({ trackId: track.id, attempt: i + 1, total: 2 })))
        assert.deepEqual(await page.evaluate(() => window.__qaRetry.clicks), [{ title: track.title, trusted: true }])
        assert.deepEqual(await queueIdentity(), { currentId: track.id, ids: [track.id] })
        await page.waitForTimeout(200)
        assert.deepEqual(trace(mark, track.videoId).filter(request => request.operation === 'player'), expected, 'Successful retry must not launch another attempt')
        return { recoveredOnRetry: attempt, screenshot, originalTrustedClicks: 1, searches: searches.length, events: await retryEvents(track), players, sameAudio: true, audio: value }
      } finally { await retryCleanup() }
    })
    await run(retryIds[2], async () => {
      const track = retries.tracks[2]
      await retrySearch(track); fixture.planPlayer(track.videoId, { rejectCycles: 3 })
      const gate = fixture.holdNextPlayer(track.videoId, { clientName: 'VISIONOS', occurrence: 3 }), mark = fixture.requests.length
      try {
        await tap(row(0) + ' .name'); await gate.waitForRequest(); await retryBusy(track, 2)
        assert.equal(trace(mark).filter(request => request.operation === 'official-embed').length, 0, 'No video document before the last audio attempt settles')
        gate.release(); await gate.waitForDelivery()
        await page.locator('dialog[data-official-youtube][open] iframe[data-official-video]').waitFor({ state: 'visible' })
        const source = new URL(await page.locator('iframe[data-official-video]').getAttribute('src'))
        assert.equal(source.pathname, '/embed/' + track.videoId); assert.equal(source.searchParams.get('autoplay'), '1')
        await wait(id => JSON.parse(localStorage.getItem('pletina:web:queue:v1') || 'null')?.queue?.some(item => item.track.id === id), track.id)
        assert.deepEqual(await queueIdentity(), { currentId: track.id, ids: [track.id] })
        assert.equal((await state()).title, track.title)
        assert.ok((await state()).audios.every(audio => audio.paused && !audio.source))
        assert.deepEqual(await retryEvents(track), [{ trackId: track.id, attempt: 1, total: 2 }, { trackId: track.id, attempt: 2, total: 2 }])
        const players = trace(mark, track.videoId).filter(request => request.operation === 'player')
        assert.deepEqual(players, [1, 2, 3].flatMap(cycle => ['VISIONOS', 'WEB_EMBEDDED_PLAYER'].map(clientName => ({ operation: 'player', videoId: track.videoId, clientName, playability: 'UNPLAYABLE', cycle }))))
        assert.equal(trace(mark).filter(request => /^(music|web)-search$/.test(request.operation)).length, 2)
        assert.deepEqual(await page.evaluate(() => window.__qaRetry.clicks), [{ title: track.title, trusted: true }])
        await wait(() => document.querySelector('iframe[data-official-video]')?.contentWindow !== null)
        await page.waitForTimeout(200)
        assert.equal(trace(mark).filter(request => request.operation === 'official-embed').length, 1)
        assert.equal(trace(mark, track.videoId).filter(request => request.operation === 'player').length, 6, 'Three total cycles are a hard bound, not an endless recovery loop')
        return { audioCycles: 3, finalVideoId: track.videoId, events: await retryEvents(track), players,
          officialEmbedDocuments: 1, originalTrustedClicks: 1, videoContent: 'benign HTTP fixture; no YouTube playback or autoplay-policy claim' }
      } finally { await retryCleanup() }
    })
    await run(retryIds[3], async () => {
      const results = []
      for (const mode of ['cancel', 'replace']) {
        const track = retries.tracks[mode === 'cancel' ? 3 : 4], destination = retries.tracks[5]
        await retrySearch(track); fixture.planPlayer(track.videoId, { rejectCycles: 1 })
        const gate = fixture.holdNextPlayer(track.videoId, { clientName: 'VISIONOS', occurrence: 2 }), mark = fixture.requests.length
        try {
          await tap(row(0) + ' .name'); await gate.waitForRequest(); await retryBusy(track, 1)
          await observeSelectionSources()
          if (mode === 'cancel') {
            await tap('.mini button[aria-label="Cancelar carga"]')
            await page.locator('.mini button[aria-label="Reproducir"]').waitFor()
            await wait(() => !document.querySelector('.mini[aria-busy="true"]'))
          } else {
            await tap(row(1) + ' .name'); await retryPlaying(destination)
          }
          gate.release(); const delivery = await gate.waitForDelivery(); await page.waitForTimeout(1000)
          assert.deepEqual(await retryEvents(track), [{ trackId: track.id, attempt: 1, total: 2 }])
          assert.equal(trace(mark, track.videoId).filter(request => request.operation === 'player').length, 3,
            'Retired retry cannot continue to P1, another retry or video after the late HTTP response')
          assert.equal(trace(mark).filter(request => request.operation === 'official-embed').length, 0)
          assert.equal(await page.locator('iframe[data-official-video]').count(), 0)
          const value = await state(); assert.equal(value.audios.length, 1)
          const samples = await page.evaluate(() => window.__qaAudio.selectionSamples)
          if (mode === 'cancel') {
            assert.equal(value.title, track.title); assert.ok(value.audios.every(audio => audio.paused))
            assert.ok(samples.every(sample => sample.paused), 'The released cancelled response cannot briefly start native audio')
            // Explicit user retry gets a new operation; the cancelled reply must
            // never itself revive playback or consume its next retry budget.
            await tap('.mini button[aria-label="Reproducir"]'); await retryPlaying(track)
          } else {
            assert.equal(value.title, destination.title)
            assert.ok(active(value)?.time > .2)
            assertSelectedSource(samples, destination.videoId)
          }
          results.push({ mode, cancelledTrackId: track.id, heldDelivery: delivery.playerGate,
            events: await retryEvents(track), noLateAudioOrVideo: true, samples, observed: value })
        } finally { await retryCleanup() }
      }
      return { controls: results, providerReplies: 'real HTTP interception, no application promises or decoder replacement' }
    })
  }

  await run('music-unplayable-rescues-distinct-web-source-without-skipping-song', async () => {
    const rescue = media.webRescue
    assert.ok(rescue?.track && rescue.musicVideoId !== rescue.webVideoId)
    const readChoice = () => page.evaluate(id => new Promise((resolve, reject) => {
      const request = indexedDB.open('pletina-web-library')
      request.onupgradeneeded = () => request.transaction.abort()
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('sources', 'readonly')
        let choice = null
        const get = tx.objectStore('sources').get(id)
        get.onsuccess = () => { choice = get.result?.choice ?? null }
        tx.oncomplete = () => { db.close(); resolve(choice) }
        tx.onabort = () => { db.close(); reject(tx.error) }
      }
    }), rescue.track.id)
    await fixture.reset(); await closeOverlays(); await pause(); await controlsOff()
    assert.equal(await readChoice(), null, 'The dedicated song must not reuse a previously saved source')
    const mark = fixture.requests.length
    const attempts = () => fixture.requests.slice(mark).filter(request => request.fixtureCase === 'music-unplayable-web-rescue')
      .map(({ operation, candidateIds, videoId, clientName, playability }) => ({ operation,
        ...(candidateIds ? { candidateIds } : {}), ...(videoId ? { videoId } : {}), ...(clientName ? { clientName } : {}), ...(playability ? { playability } : {}) }))
    let completed = false
    try {
      await fixture.set({ musicUnplayableWebRescue: true })
      await ctx.fillSearch('Buscar', rescue.query)
      await wait(title => document.querySelector('.tracks li[data-reorder-index="0"] .name')?.textContent.trim() === title, rescue.track.title)
      assert.equal(await page.locator('.tracks li[data-reorder-index]').count(), 2,
        'A healthy second song makes an unintended skip observable')
      await tap(row(0) + ' .name')
      const before = await playing(rescue.track.title), first = active(before)
      await wait(({ index, time }) => {
        const audio = window.__qaAudio.instances[index]
        return audio && !audio.paused && !audio.seeking && !audio.error && audio.readyState >= 2 && audio.currentTime > time + 0.1
      }, { index: first.index, time: first.time })
      const value = await state()
      assert.equal(value.title, rescue.track.title)
      assert.equal(value.audios.length, 1)
      assert.equal(active(value).index, first.index)
      assert.ok(active(value).duration >= 11 && active(value).duration < 14, 'The real 12-second AAC must decode')
      const mediaSessionAvailable = await page.evaluate(() => 'mediaSession' in navigator)
      if (mediaSessionAvailable) {
        assert.equal(value.metadata?.title, rescue.track.title)
        assert.equal(value.metadata?.artist, rescue.track.artistName)
      }
      const saved = await readChoice()
      assert.equal(saved?.videoId, rescue.webVideoId, 'Persist the working WEB recording, never the unavailable Music result')
      assert.equal(saved.verified, false)
      assert.ok(saved.score >= 70)
      await wait(id => {
        const queue = JSON.parse(localStorage.getItem('pletina:web:queue:v1') || 'null')
        return queue?.queue[queue.order[queue.pos]]?.track.id === id
      }, rescue.track.id)
      const queue = await page.evaluate(() => {
        const queue = JSON.parse(localStorage.getItem('pletina:web:queue:v1'))
        return { currentId: queue.queue[queue.order[queue.pos]].track.id, ids: queue.queue.map(item => item.track.id) }
      })
      assert.equal(queue.currentId, rescue.track.id)
      assert.deepEqual(queue.ids, [rescue.track.id, rescue.nextTrackId])
      const trace = attempts(), players = trace.filter(attempt => attempt.operation === 'player')
      assert.deepEqual(players.map(({ videoId, clientName, playability }) => ({ videoId, clientName, playability })), [
        { videoId: rescue.musicVideoId, clientName: 'VISIONOS', playability: 'UNPLAYABLE' },
        { videoId: rescue.musicVideoId, clientName: 'WEB_EMBEDDED_PLAYER', playability: 'UNPLAYABLE' },
        { videoId: rescue.webVideoId, clientName: 'VISIONOS', playability: 'OK' },
      ], 'Only the unavailable Music ID gets one P1 rescue; the healthy distinct WEB ID needs VISIONOS once')
      const music = trace.findIndex(attempt => attempt.operation === 'music-search')
      const denied = trace.findIndex(attempt => attempt.operation === 'player' && attempt.videoId === rescue.musicVideoId && attempt.clientName === 'VISIONOS')
      const deniedP1 = trace.findIndex(attempt => attempt.operation === 'player' && attempt.videoId === rescue.musicVideoId && attempt.clientName === 'WEB_EMBEDDED_PLAYER')
      const web = trace.findIndex(attempt => attempt.operation === 'web-search')
      const accepted = trace.findIndex(attempt => attempt.operation === 'player' && attempt.videoId === rescue.webVideoId)
      assert.ok(music >= 0 && denied > music && deniedP1 > denied && web > deniedP1 && accepted > web,
        'A high-confidence Music result must fail VISIONOS then P1 before the distinct WEB rescue is searched and tried')
      assert.deepEqual(trace[music].candidateIds, [rescue.musicVideoId])
      assert.deepEqual(trace[web].candidateIds, [rescue.webVideoId])
      assert.ok(trace.some(attempt => attempt.operation === 'media' && attempt.videoId === rescue.webVideoId))
      assert.ok(!trace.some(attempt => attempt.operation === 'media' && attempt.videoId === rescue.musicVideoId))
      completed = true
      return { requestedTrackId: rescue.track.id, currentTrackId: queue.currentId, savedVideoId: saved.videoId,
        attempts: trace, sameSong: true, realDecoderProgress: true, audioInstances: value.audios.length,
        mediaSession: mediaSessionAvailable ? { status: 'pass', metadata: value.metadata } : { status: 'unsupported', reason: 'MediaSession is not exposed by this engine.' },
        scope: 'Controlled HTTP Music VISIONOS+P1 UNPLAYABLE / distinct WEB VISIONOS OK; P1 rejected before decoder/probe; real silent AAC, no live-provider or physical-phone claim.' }
    } finally {
      ctx.report.webRescue = { completed, requestedTrackId: rescue.track.id, attempts: attempts() }
      await closeOverlays(); await pause(); await fixture.reset()
    }
  })

  for (const [index, name] of ['p1-primary-network-rescues-same-id-with-native-aac-without-video',
    'p1-all-probes-transient-retries-same-id-and-stops-without-video'].entries()) await run(name, async () => {
    const track = media.p1Transient?.tracks[index]
    assert.ok(track, 'Dedicated P1 transient HTTP fixture is required')
    await closeOverlays(); await pause(); await controlsOff(); await fixture.reset(); await reload()
    const mark = fixture.requests.length, began = Date.now()
    const trace = () => fixture.requests.slice(mark).filter(request => request.fixtureCase === 'p1-transient')
      .map(({ operation, videoId, clientName, cycle, playability, injectedFailure, responseStatus, itag, candidateIds }) => ({ operation,
        ...(videoId ? { videoId } : {}), ...(clientName ? { clientName } : {}), ...(cycle ? { cycle } : {}),
        ...(playability ? { playability } : {}), ...(injectedFailure ? { injectedFailure } : {}),
        ...(responseStatus ? { responseStatus } : {}), ...(itag ? { itag } : {}), ...(candidateIds ? { candidateIds } : {}) }))
    try {
      await fixture.set({ p1Transient: true })
      await ctx.fillSearch('Buscar', media.p1Transient.query(track))
      await wait(title => document.querySelector('.tracks li[data-reorder-index="0"] .name')?.textContent.trim() === title, track.title)
      assert.equal(await page.locator('.tracks li[data-reorder-index]').count(), 1)
      await page.evaluate(() => {
        const observation = window.__p1TransientQA = { officialObserved: false, clicks: [], retries: [] }
        const inspect = () => { if (document.querySelector('iframe[data-official-video],dialog[data-official-youtube][open]')) observation.officialObserved = true }
        observation.observer = new MutationObserver(inspect)
        observation.observer.observe(document.body, { subtree: true, childList: true, attributes: true })
        observation.click = event => { if (event.target.closest?.('.tracks .name,.mini button[aria-label="Reproducir"]')) observation.clicks.push({ trusted: event.isTrusted }) }
        observation.retry = event => observation.retries.push(event.detail)
        document.addEventListener('click', observation.click, true)
        window.addEventListener('pletina:audio-retry', observation.retry)
      })
      await tap(row(0) + ' .name')
      if (index === 0) {
        // No second Play gesture can mask a failure of automatic P1 recovery.
        await wait(title => document.querySelector('.mini .title')?.textContent.trim() === title &&
          window.__qaAudio.instances.some(audio => !audio.paused && !audio.error && audio.currentTime > .2), track.title)
        const audio = active(await state())
        assert.ok(audio && !audio.muted && audio.volume > 0 && audio.duration >= 11 && audio.duration < 14)
        const locator = await page.evaluate(index => {
          const audio = window.__qaAudio.instances[index], url = new URL(audio.currentSrc || audio.src)
          return { path: url.pathname, videoId: url.searchParams.get('qa_transient') }
        }, audio.index)
        assert.deepEqual(locator, { path: '/videoplayback', videoId: track.videoId })
      } else {
        await wait(() => [...document.querySelectorAll('[role="status"]')].some(node => node.textContent.includes('No se pudo reproducir')) &&
          !document.querySelector('.mini[aria-busy="true"]') && window.__qaAudio.instances.every(audio => audio.paused), null, 35000)
      }
      const observed = await page.evaluate(() => {
        const value = window.__p1TransientQA, queue = JSON.parse(localStorage.getItem('pletina:web:queue:v1') || 'null')
        return { officialObserved: value.officialObserved, clicks: value.clicks, retries: value.retries,
          currentId: queue?.queue?.[queue.order?.[queue.pos]]?.track.id ?? null, ids: queue?.queue?.map(item => item.track.id) ?? [] }
      })
      const cycles = index === 0 ? 1 : 3, attempts = trace(), players = attempts.filter(request => request.operation === 'player')
      assert.deepEqual(players.map(({ videoId, clientName, cycle }) => ({ videoId, clientName, cycle })),
        Array.from({ length: cycles }, (_, i) => ['VISIONOS', 'WEB_EMBEDDED_PLAYER'].map(clientName => ({ videoId: track.videoId, clientName, cycle: i + 1 }))).flat())
      assert.ok(players.filter(request => request.clientName === 'WEB_EMBEDDED_PLAYER').every(request => request.playability === 'OK'))
      if (index === 0) assert.equal(players[0].injectedFailure, 'primary-network')
      else {
        const probes = attempts.filter(request => request.operation === 'media')
        assert.ok(probes.length >= 6 && probes.every(request => request.responseStatus === 403))
        for (const cycle of [1, 2, 3]) assert.deepEqual([...new Set(probes.filter(request => request.cycle === cycle).map(request => request.itag))].sort(), [139, 140])
      }
      assert.deepEqual(attempts.filter(request => request.operation.endsWith('-search')).map(request => request.operation), ['music-search'], 'Transient failures cannot launch another text search')
      assert.deepEqual(observed.retries, index === 0 ? [] : [1, 2].map(attempt => ({ trackId: track.id, attempt, total: 2 })))
      assert.deepEqual(observed.clicks, [{ trusted: true }])
      assert.equal(observed.officialObserved, false); assert.equal(observed.currentId, track.id); assert.deepEqual(observed.ids, [track.id])
      assert.equal(await page.locator('iframe[data-official-video]').count(), 0)
      const value = await state(); assert.equal(value.title, track.title); assert.equal(value.audios.length, 1)
      const settledRequests = players.length
      await page.waitForTimeout(250)
      assert.equal(trace().filter(request => request.operation === 'player').length, settledRequests, 'Recovery must stop after success or bounded final transient failure')
      return { sameId: track.videoId, elapsedMs: Date.now() - began, cycles, attempts, observed, audio: value,
        scope: 'Synthetic HTTP network/CDN faults, real compiled resolver and native silent AAC. No live-provider or physical-phone claim.' }
    } finally {
      ctx.report.p1Transient ??= []
      ctx.report.p1Transient.push({ trackId: track.id, attempts: trace() })
      await page.evaluate(() => {
        const value = window.__p1TransientQA
        value?.observer?.disconnect()
        if (value?.click) document.removeEventListener('click', value.click, true)
        if (value?.retry) window.removeEventListener('pletina:audio-retry', value.retry)
        delete window.__p1TransientQA
      })
      await closeOverlays(); await pause(); await fixture.reset()
    }
  })

  await run('p1-multiple-aac-isolates-invalid-and-denied-candidates-without-video-or-download', async () => {
    const rescue = media.p1Multi
    assert.ok(rescue?.track && rescue.videoId === rescue.track.videoId)
    await fixture.reset(); await closeOverlays(); await pause(); await controlsOff()
    const mark = fixture.requests.length
    const attempts = () => fixture.requests.slice(mark).filter(request => request.fixtureCase === 'p1-multi-aac-rescue')
      .map(({ operation, candidateIds, videoId, clientName, playability, candidate, responseStatus, type }) => ({ operation,
        ...(candidateIds ? { candidateIds } : {}), ...(videoId ? { videoId } : {}), ...(clientName ? { clientName } : {}),
        ...(playability ? { playability } : {}), ...(candidate ? { candidate } : {}), ...(responseStatus ? { responseStatus } : {}), type }))
    let observationInstalled = false, completed = false
    try {
      await fixture.set({ p1MultiAacRescue: true })
      await ctx.fillSearch('Buscar', rescue.query)
      await wait(title => document.querySelector('.tracks li[data-reorder-index="0"] .name')?.textContent.trim() === title, rescue.track.title)
      assert.equal(await page.locator('.tracks li[data-reorder-index]').count(), 2, 'A healthy successor makes an unintended song skip observable')
      const before = await state()
      assert.equal(before.audios.length, 1)
      await page.evaluate(() => {
        const observation = window.__p1MultiQA = { clicks: [], officialObserved: false }
        const inspect = () => { if (document.querySelector('iframe[data-official-video],dialog[data-official-youtube][open]')) observation.officialObserved = true }
        const click = event => {
          const button = event.target instanceof Element ? event.target.closest('.tracks .name,.mini button[aria-label="Reproducir"]') : null
          if (button) observation.clicks.push({ kind: button.matches('.tracks .name') ? 'track' : 'extra-play', trusted: event.isTrusted })
        }
        observation.observer = new MutationObserver(inspect)
        observation.observer.observe(document.body, { childList: true, subtree: true, attributes: true })
        observation.click = click; document.addEventListener('click', click, true); inspect()
      })
      observationInstalled = true
      await tap(row(0) + ' .name')
      // Do not use playing(): its second-Play recovery would hide an autoplay
      // regression. This case permits exactly the normal title click.
      await wait(title => document.querySelector('.mini .title')?.textContent.trim() === title &&
        window.__qaAudio.instances.some(audio => !audio.paused && !audio.error && audio.currentTime > 0.2), rescue.track.title)
      const value = await state(), first = active(value)
      assert.equal(value.audios.length, 1); assert.equal(first.index, before.audios[0].index)
      assert.equal(first.muted, false); assert.ok(first.volume > 0)
      assert.ok(first.duration >= 11 && first.duration < 14, 'The existing real twelve-second AAC fixture must decode')
      const selected = await page.evaluate(index => {
        const audio = window.__qaAudio.instances[index], url = new URL(audio.currentSrc || audio.src)
        return { candidate: url.searchParams.get('qa'), videoId: url.searchParams.get('qa_video'), path: url.pathname }
      }, first.index)
      assert.deepEqual(selected, { candidate: 'p1-good', videoId: rescue.videoId, path: '/videoplayback' })
      await wait(({ index, time }) => {
        const audio = window.__qaAudio.instances[index]
        return audio && !audio.paused && !audio.error && audio.currentTime > time + 0.15
      }, { index: first.index, time: first.time })
      const trace = attempts()
      assert.deepEqual(trace.filter(row => row.operation === 'player').map(({ videoId, clientName, playability }) => ({ videoId, clientName, playability })), [
        { videoId: rescue.videoId, clientName: 'VISIONOS', playability: 'UNPLAYABLE' },
        { videoId: rescue.videoId, clientName: 'WEB_EMBEDDED_PLAYER', playability: 'OK' },
      ])
      assert.equal(trace.filter(row => row.operation === 'music-search').length, 1)
      assert.equal(trace.filter(row => row.operation === 'web-search').length, 0, 'P1 recovery must not search for another recording')
      assert.equal(trace.filter(row => row.operation === 'media' && row.candidate === 'p1-invalid-locator').length, 0,
        'A rejected locator must never reach the browser media transport')
      assert.ok(trace.some(row => row.operation === 'media' && row.candidate === 'p1-denied' && row.responseStatus === 403))
      assert.ok(trace.some(row => row.operation === 'media' && row.candidate === 'p1-good'))
      const navigation = await page.evaluate(() => {
        const queue = JSON.parse(localStorage.getItem('pletina:web:queue:v1'))
        return { currentId: queue.queue[queue.order[queue.pos]].track.id, ids: queue.queue.map(item => item.track.id),
          officialObserved: window.__p1MultiQA.officialObserved, clicks: window.__p1MultiQA.clicks }
      })
      assert.equal(navigation.currentId, rescue.track.id)
      assert.deepEqual(navigation.ids, [rescue.track.id, rescue.nextTrackId])
      assert.equal(navigation.officialObserved, false)
      assert.deepEqual(navigation.clicks, [{ kind: 'track', trusted: true }])
      assert.equal(await page.locator('iframe[data-official-video]').count(), 0)
      if (await page.evaluate(() => 'mediaSession' in navigator)) {
        assert.equal(value.metadata?.title, rescue.track.title); assert.equal(value.metadata?.artist, rescue.track.artistName)
      }

      // #playable is private. Exercise the public download contract rather than
      // pretending to inspect its provider field or importing another resolver.
      const downloadsBefore = await downloadState(), transfer = await transferMark(), requestMark = fixture.requests.length
      await menu(0, 'Descargar')
      const denied = await terminal(transfer, rescue.track.id)
      assert.equal(denied.state, 'error')
      assert.match(denied.error, /permite escuchar.*no descargarla.*sin conexión/)
      assert.deepEqual(await downloadState(), downloadsBefore, 'P1 cannot leave a download row, body or partial cache entry')
      assert.equal(fixture.requests.slice(requestMark).filter(row => row.fixtureCase === 'p1-multi-aac-rescue' &&
        (row.operation === 'player' || row.operation === 'media')).length, 0,
      'The cached P1 source must reject download permission before any transfer or renewed player request')
      const after = await state()
      assert.equal(after.title, rescue.track.title); assert.equal(after.audios.length, 1); assert.equal(active(after)?.index, first.index)
      assert.equal(await page.locator('dialog[data-official-youtube][open]').count(), 0)
      completed = true
      return { requestedTrackId: rescue.track.id, videoId: rescue.videoId, selected, attempts: trace, sameAudio: true,
        sameSongAndQueue: true, extraPlayInteractions: 0, officialVideoOpened: false,
        sourceContract: { expectedProvider: 'youtube-p1', privateProviderDirectlyInspected: false,
          p1TransportObserved: true, downloadAllowed: false, downloadDenialObservedThroughUI: true },
        download: denied, scope: 'Synthetic same-ID multi-AAC HTTP fixture: invalid locator, denied metadata source, valid real silent AAC. No user-song, live-provider or physical-phone claim.' }
    } finally {
      ctx.report.p1MultiAac = { completed, requestedTrackId: rescue.track.id, attempts: attempts() }
      if (observationInstalled) await page.evaluate(() => {
        const observation = window.__p1MultiQA
        observation?.observer?.disconnect(); if (observation?.click) document.removeEventListener('click', observation.click, true)
        delete window.__p1MultiQA
      })
      await closeOverlays(); await pause(); await fixture.reset()
    }
  })

  await run('youtube-unplayable-rescues-exact-audius-isrc-and-advances-with-same-audio', async () => {
    const rescue = media.audiusRescue
    assert.ok(rescue?.track && rescue.sourceId)
    await fixture.reset(); await closeOverlays(); await pause(); await controlsOff()
    const mark = fixture.requests.length
    const attempts = () => fixture.requests.slice(mark).filter(request => request.fixtureCase === 'audius-catalog-rescue')
      .map(({ operation, candidateIds, videoId, clientName, playability, sourceId, isrc, requestedTrackId }) => ({ operation,
        ...(candidateIds ? { candidateIds } : {}), ...(videoId ? { videoId } : {}), ...(clientName ? { clientName } : {}), ...(playability ? { playability } : {}),
        ...(sourceId ? { sourceId } : {}), ...(isrc ? { isrc } : {}), ...(requestedTrackId ? { requestedTrackId } : {}) }))
    try {
      await fixture.set({ audiusCatalogRescue: true })
      await ctx.fillSearch('Buscar', rescue.query)
      await wait(title => document.querySelector('.tracks li[data-reorder-index="0"] .name')?.textContent.trim() === title, rescue.track.title)
      assert.equal(await page.locator('.tracks li[data-reorder-index]').count(), 2)
      await tap(row(0) + ' .name')
      const first = await playing(rescue.track.title), audio = active(first)
      assert.equal(audio.host, 'api.audius.co', 'The requested recording must play from its accepted Audius ID')
      assert.equal(first.audios.length, 1)
      assert.ok(audio.duration >= 11 && audio.duration < 14, 'Decode the real AAC fixture, not metadata alone')
      assert.equal(await visible('dialog[data-official-youtube][open]'), false)
      const trace = attempts(), denied = trace.findIndex(attempt => attempt.operation === 'player' && attempt.playability === 'UNPLAYABLE')
      assert.deepEqual(trace.filter(attempt => attempt.operation === 'player').map(({ videoId, clientName, playability }) => ({ videoId, clientName, playability })), [
        { videoId: rescue.track.videoId, clientName: 'VISIONOS', playability: 'UNPLAYABLE' },
        { videoId: rescue.track.videoId, clientName: 'WEB_EMBEDDED_PLAYER', playability: 'UNPLAYABLE' },
      ], 'The same unavailable recording gets exactly two ordered transports before external catalog rescue')
      const deniedP1 = trace.findIndex(attempt => attempt.operation === 'player' && attempt.clientName === 'WEB_EMBEDDED_PLAYER')
      const catalog = trace.findIndex(attempt => attempt.operation === 'catalog-search')
      assert.ok(denied >= 0 && deniedP1 > denied && catalog > deniedP1, 'Both bounded YouTube transports must reject the same ID before catalog rescue')
      assert.equal(trace[catalog].isrc, rescue.track.isrc)
      assert.deepEqual(trace[catalog].candidateIds, ['WrongIsrc', 'WrongArtist', rescue.sourceId])
      assert.ok(trace.some(attempt => attempt.operation === 'media' && attempt.sourceId === rescue.sourceId))
      assert.ok(!trace.some(attempt => attempt.operation === 'media' && ['WrongIsrc', 'WrongArtist'].includes(attempt.sourceId)))
      const persisted = await page.evaluate(id => new Promise((resolve, reject) => {
        const request = indexedDB.open('pletina-web-library')
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const db = request.result, tx = db.transaction('sources'), get = tx.objectStore('sources').get(id)
          let found = null
          get.onsuccess = () => { found = get.result ?? null }
          tx.oncomplete = () => { db.close(); resolve(found) }
          tx.onabort = () => { db.close(); reject(tx.error) }
        }
      }), rescue.track.id)
      assert.equal(persisted, null, 'External audio is never saved as a YouTube source choice')
      const next = fixture.tracks.find(track => track.id === rescue.nextTrackId)
      assert.ok(next)
      await wait(title => document.querySelector('.mini .title')?.textContent.trim() === title &&
        window.__qaAudio.instances.some(audio => !audio.paused && audio.currentTime > 0.15 && !audio.error), next.title, 20000)
      const after = await state()
      assert.equal(after.audios.length, 1)
      assert.equal(active(after).index, audio.index)
      assert.equal(active(after).host, 'fixture.googlevideo.com')
      assert.ok(after.events.some(event => event.type === 'ended' && event.index === audio.index))
      return { requestedTrackId: rescue.track.id, acceptedSourceId: rescue.sourceId, isrc: rescue.track.isrc,
        nextTrackId: rescue.nextTrackId, attempts: attempts(), sameAudio: true, realDecoderProgressAndEnded: true,
        scope: 'Compiled UI + real synthetic AAC; controlled provider HTTP, no live-catalog or physical-phone claim.' }
    } finally { await closeOverlays(); await pause(); await fixture.reset() }
  })

  await run('audius-homonym-with-wrong-isrc-or-artist-never-starts-audio', async () => {
    const rejected = media.audiusRescue?.rejected
    assert.ok(rejected?.track)
    await fixture.reset(); await closeOverlays(); await pause(); await controlsOff()
    const mark = fixture.requests.length
    try {
      await fixture.set({ audiusCatalogRescue: true })
      await ctx.fillSearch('Buscar', rejected.query)
      await wait(title => document.querySelector('.tracks li[data-reorder-index="0"] .name')?.textContent.trim() === title, rejected.track.title)
      assert.equal(await page.locator('.tracks li[data-reorder-index]').count(), 1)
      await tap(row(0) + ' .name')
      await page.locator('dialog[data-official-youtube][open]').waitFor({ timeout: 15000 })
      const trace = fixture.requests.slice(mark).filter(request => request.fixtureCase === 'audius-catalog-rescue')
      assert.deepEqual(trace.filter(attempt => attempt.operation === 'player').map(({ videoId, clientName, playability }) => ({ videoId, clientName, playability })), [
        { videoId: rejected.track.videoId, clientName: 'VISIONOS', playability: 'UNPLAYABLE' },
        { videoId: rejected.track.videoId, clientName: 'WEB_EMBEDDED_PLAYER', playability: 'UNPLAYABLE' },
        { videoId: rejected.track.videoId, clientName: 'VISIONOS', playability: 'UNPLAYABLE' },
        { videoId: rejected.track.videoId, clientName: 'WEB_EMBEDDED_PLAYER', playability: 'UNPLAYABLE' },
        { videoId: rejected.track.videoId, clientName: 'VISIONOS', playability: 'UNPLAYABLE' },
        { videoId: rejected.track.videoId, clientName: 'WEB_EMBEDDED_PLAYER', playability: 'UNPLAYABLE' },
      ], 'Rejected homonyms cannot play; the original ID receives at most two fresh final audio retries before video')
      const catalog = trace.filter(request => request.operation === 'catalog-search')
      assert.ok(catalog.length >= 1)
      assert.equal(catalog[0].isrc, rejected.track.isrc)
      assert.deepEqual(catalog[0].candidateIds, ['WrongIsrc', 'WrongArtist'])
      assert.equal(trace.filter(request => request.operation === 'media').length, 0,
        'Matching titles with another ISRC or artist must never reach HTMLAudio')
      const value = await state()
      assert.ok(value.audios.every(audio => audio.paused && audio.host !== 'api.audius.co'))
      assert.equal(value.title, rejected.track.title)
      return { requestedTrackId: rejected.track.id, rejectedCandidateIds: catalog[0].candidateIds,
        externalMediaRequests: 0, directAudioPaused: true, retainedExistingOfficialFallback: true,
        scope: 'Controlled HTTP homonyms rejected by the real compiled strict mapper; no provider-content claim.' }
    } finally { await closeOverlays(); await pause(); await fixture.reset() }
  })

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
  await run('artist-radio-related-provider-failure-keeps-playable-seed-and-visible-warning', async () => {
    // The preceding successful radio legitimately caches related artists for an hour.
    // A real document reload gives this failure case a fresh API cache without mocking it.
    await fixture.reset(); await reload(); await music(); await tap('.top-result')
    await page.locator('.banner h1').waitFor()
    const seed = fixture.artists[0], path = '/artist/' + seed.id + '/related', mark = fixture.requests.length
    fixture.failNext(path)
    try {
      await tap('button.radio')
      const received = () => fixture.requests.slice(mark).some(request => request.host === 'api.deezer.com' && request.path === path)
      const deadline = Date.now() + 5000
      while (!received() && Date.now() < deadline) await page.waitForTimeout(25)
      assert.ok(received(), 'The related-artist request must reach the HTTP fixture after a real cache-clearing reload')
      await wait(() => document.querySelector('#artist-radio-status')?.textContent.includes('Algunos artistas no se han podido cargar') &&
        document.querySelector('button.radio')?.getAttribute('aria-busy') === 'false')
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('pletina:web:queue:v1')))
      const expected = fixture.tracks.filter(track => track.artist.id === seed.id).map(track => track.id)
      assert.equal(saved.context, 'Radio de ' + seed.name)
      assert.deepEqual(saved.queue.map(item => item.track.id).sort((a, b) => a - b), expected.sort((a, b) => a - b))
      assert.equal(new Set(saved.queue.map(item => item.track.id)).size, expected.length)
      assert.ok(saved.queue.every(item => item.track.artist.id === seed.id))
      assert.equal(await page.locator('#artist-radio-status.error').count(), 0, 'A usable partial radio must remain available')
      const value = await playing(saved.queue[0].track.title); await pause()
      return { failedPath: path, seedTrackIds: expected, warningVisible: true, audio: value, cancellationClaimed: false }
    } finally { await fixture.reset() }
  })
  await run('source-change-during-playback-keeps-song-and-one-audio-through-resume', async () => {
    const { titles, state: before } = await start(0), index = active(before).index
    const oldVideoId = await page.evaluate(index => new URL(window.__qaAudio.instances[index].currentSrc).pathname.split('/').at(-1), index)
    assert.match(oldVideoId, /^[\w-]{11}$/)
    const chosen = media.tracks.find(track => track.videoId !== oldVideoId)
    assert.ok(chosen, 'The replacement must differ from the currently decoded fixture video')
    const dialog = page.locator('dialog[aria-label="Elegir otro vídeo"]')
    try {
      await nowPlaying(); await tap('.np .extras button:has-text("¿No es esta canción?")')
      await dialog.locator('button.alt').first().waitFor()
      await dialog.locator('form input').fill(chosen.videoId)
      await tap(dialog.locator('form button'))
      await dialog.waitFor({ state: 'hidden' })
      await wait(({ index, videoId }) => {
        const audio = window.__qaAudio.instances[index]
        return !audio.paused && !audio.error && audio.currentTime > .15 &&
          new URL(audio.currentSrc || audio.src).pathname === '/audio/' + videoId
      }, { index, videoId: chosen.videoId })
      let value = await playing(titles[0])
      assert.equal(value.audios.length, before.audios.length); assert.equal(active(value).index, index)
      await page.evaluate(index => {
        const qa = window.__qaAudio, audio = qa.instances[index]
        qa.sourceObservations = []
        const observe = event => {
          if (audio.paused) return
          let videoId = null
          try {
            const source = new URL(audio.currentSrc || audio.src)
            if (source.hostname === 'fixture.googlevideo.com') videoId = source.pathname.match(/^\/audio\/([\w-]{11})$/)?.[1] ?? null
          } catch { /* An empty source is recorded as invalid rather than throwing from the observer. */ }
          qa.sourceObservations.push({ type: event.type, index, time: audio.currentTime,
            videoId,
            activeCount: qa.instances.filter(item => !item.paused).length })
          if (qa.sourceObservations.length > 100) qa.sourceObservations.shift()
        }
        for (const type of ['playing', 'timeupdate']) audio.addEventListener(type, observe)
        qa.stopSourceObservation = () => { for (const type of ['playing', 'timeupdate']) audio.removeEventListener(type, observe) }
      }, index)
      await closeOverlays(); await pause(); await tap('.mini button[aria-label="Reproducir"]')
      value = await playing(titles[0])
      const at = active(value).time
      await wait(({ index, at }) => !window.__qaAudio.instances[index].paused && window.__qaAudio.instances[index].currentTime > at + .3, { index, at })
      await nowPlaying(); await tap('.np .extras button:has-text("¿No es esta canción?")')
      await dialog.locator('button.alt.current img').waitFor()
      const remembered = await dialog.locator('button.alt.current img').getAttribute('src')
      assert.equal(new URL(remembered).pathname, '/vi/' + chosen.videoId + '/mqdefault.jpg')
      await tap(dialog.locator('button[title="Cerrar (Esc)"]'))
      const observations = await page.evaluate(() => window.__qaAudio.sourceObservations)
      assert.ok(observations.some(sample => sample.type === 'timeupdate'), 'The new source must advance after a trusted pause/resume')
      assert.ok(observations.every(sample => sample.videoId === chosen.videoId && sample.activeCount === 1), 'The old source cannot return or overlap the selected source')
      value = await state()
      assert.equal(value.title, titles[0]); assert.equal(value.audios.length, before.audios.length)
      assert.equal(value.audios.filter(audio => audio.playing).length, 1); assert.equal(active(value).index, index)
      await closeOverlays(); await pause()
      return { title: titles[0], previousVideoId: oldVideoId, selectedVideoId: chosen.videoId, observations, audio: value,
        scope: 'Synthetic AAC sources; verifies source identity, decoder continuity and UI, not recording content' }
    } finally {
      await page.evaluate(() => {
        const qa = window.__qaAudio
        qa?.stopSourceObservation?.()
        if (qa) { delete qa.stopSourceObservation; delete qa.sourceObservations }
      }).catch(() => {})
      if (await dialog.isVisible().catch(() => false)) await tap(dialog.locator('button[title="Cerrar (Esc)"]')).catch(() => {})
    }
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
    const titles = await music(); await tap(row(0) + ' .name'); await page.locator('.mini button[aria-label="Cancelar carga"]').waitFor()
    await tap('.mini button[aria-label="Cancelar carga"]')
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
    try {
      const titles = await music(), mark = fixture.requests.length
      await tap(row(0) + ' .name')
      await wait(() => [...document.querySelectorAll('[role="status"]')].some(node => node.textContent.includes('No se pudo reproducir')) &&
        !document.querySelector('.mini[aria-busy="true"]') && window.__qaAudio.instances.every(audio => audio.paused), null, 25000)
      const failed = await state(); assert.ok(failed.audios.every(audio => audio.paused))
      assert.equal(await page.locator('dialog[data-official-youtube][open]').count(), 0, 'Provider restrictions cannot open an automatic video fallback')
      assert.equal(await page.locator('iframe[data-official-video]').count(), 0)
      const failures = () => fixture.requests.slice(mark).filter(request => request.playability === 'LOGIN_REQUIRED')
      const count = failures().length
      assert.ok(count > 0 && count <= 3, 'Restricted sources must stop within the existing three-song failure budget')
      await page.waitForTimeout(150)
      assert.equal(failures().length, count, 'The stopped player cannot keep issuing restricted player requests')
      await fixture.reset(); const result = await start(0); await pause()
      assert.equal(result.state.title, titles[0])
      return { boundedFailure: failed, providerClassification: 'restricted', failedPlayerRequests: count,
        officialVideoOpened: false, recovered: result.state }
    } finally { await fixture.reset(); await closeOverlays(); await pause() }
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
  await run('download-remove-all-cancel-preserves-files-and-reload-ui', async () => {
    if (!downloaded) return { status: 'blocked', reason: 'No validated downloaded file is available from the preceding queue scenario.' }
    await downloadsView()
    const before = await downloadState(), titles = await page.locator('.tracks li[data-reorder-index] .name').allTextContents()
    assert.ok(before.rows.length > 0 && before.rows.every(file => file.present))
    await tap('.summary button:has-text("Quitar todas")')
    await page.locator('.confirm button.danger').waitFor()
    assert.deepEqual(await downloadState(), before, 'Opening the confirmation cannot remove database entries or cache bodies')
    await clickText('.confirm button', 'Cancelar')
    await page.locator('.confirm').waitFor({ state: 'hidden' })
    assert.deepEqual(await downloadState(), before)
    await reload(); await page.locator('h1.page-title:text-is("Descargas")').waitFor()
    const after = await downloadState()
    assert.deepEqual(after, before, 'Cancellation must survive reload without deleting downloaded audio')
    assert.deepEqual(await page.locator('.tracks li[data-reorder-index] .name').allTextContents(), titles)
    assert.equal(await page.locator('.confirm').count(), 0)
    assert.equal(await visible('.summary button:has-text("Quitar todas")'), true)
    return { databaseBefore: before, databaseAfterReload: after, titles, confirmationCancelled: true }
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
  await run('download-automatic-renewal-after-one-transfer-failure-and-offline-play', async () => {
    await fixture.reset(); await clearDownloads(); await music()
    const track = media.tracks[2], path = '/audio/' + track.videoId
    const requestMark = fixture.requests.length, mark = await transferMark()
    fixture.failNext(path)
    let originalFailure
    try {
      await menu(2, 'Descargar')
      const event = await terminal(mark, track.id)
      assert.equal(event.state, 'done', 'A single interrupted transfer must finish without a second download gesture')
      const events = await page.evaluate(({ mark, id }) => window.__e2eTransfers.slice(mark).filter(event => event.id === id).map(event => event.state), { mark, id: track.id })
      assert.deepEqual(events, ['queued', 'downloading', 'done'], 'A recovered attempt must not emit an intermediate terminal error')
      const requests = fixture.requests.slice(requestMark)
      const first = requests.findIndex(request => request.path === path)
      const next = requests.findIndex((request, index) => index > first && request.path === path)
      assert.ok(first >= 0 && next > first, 'Both the interrupted request and a new audio transfer must reach the controlled HTTP provider')
      assert.ok(requests.slice(first + 1, next).some(request => request.path.endsWith('/player')),
        'A fresh provider player request must renew the source between transfers; a browser transport retry alone cannot pass')
      const database = await downloadState()
      assert.equal(database.rows.length, 1); assert.equal(database.rows[0].id, track.id)
      assert.ok(database.rows[0].present); assert.equal(database.cacheEntries, 1, 'No failed staging body may remain alongside the completed download')
      await downloadsView(); await tap(row(0) + ' .name'); await playing(track.title); await pause()
      const offline = await ctx.goOffline(true)
      const navigatorOfflineExpected = offline?.navigatorOfflineExpected ?? true
      await reload(); assert.equal(await page.evaluate(() => navigator.onLine), !navigatorOfflineExpected)
      assert.ok((await state()).audios.every(audio => audio.paused), 'Reloading the recovered download must preserve paused intent')
      await downloadsView(); await tap(row(0) + ' .name'); await playing(track.title)
      await seek(0.5)
      await wait(() => window.__qaAudio.instances.some(audio => !audio.paused && !audio.seeking && audio.currentTime > audio.duration / 2 + 0.3))
      const audio = await state(); assert.equal(active(audio).local, true)
      await closeOverlays(); await pause()
      return { downloadGestures: 1, events, renewedBetweenTransfers: true,
        controlledAudioRequests: requests.filter(request => request.path === path).length,
        database, audio, networkMode: offline?.mode ?? 'browser-offline', navigatorOfflineExpected,
        physicalAirplaneModeClaimed: false }
    } catch (error) { originalFailure = error; throw error }
    finally {
      await ctx.goOffline(false); await fixture.reset()
      try {
        if (!await visible('.app')) { await page.goto(ctx.getappURL(), { waitUntil: 'load' }); await page.locator('.bottom-nav').waitFor(); await frame() }
        await closeOverlays(); await pause(); await clearDownloads()
      } catch (error) {
        if (!originalFailure) throw error
        ctx.report.errors.push({ name: 'DownloadRetryRecoveryError', message: String(error.message).replace(/https?:\/\/[^\s]+/g, '[URL]') })
      }
    }
  })
  await run('offline-mixed-queue-skips-four-remote-entries-at-ended-with-one-audio', async () => {
    const hostLimitation = await offlineQueueHostLimitation(); if (hostLimitation) return hostLimitation
    await fixture.reset(); await clearDownloads(); await music(); await downloadMusic([0, 5])
    const { titles, state: before } = await start(0), index = active(before).index
    const observer = observeProviderRequests()
    try {
      const offline = await offlineInDocument(), mark = observer.attempts.length, fixtureMark = fixture.requests.length
      await seek(.91)
      await wait(({ title, index }) => document.querySelector('.mini .title')?.textContent.trim() === title &&
        !window.__qaAudio.instances[index].paused && window.__qaAudio.instances[index].currentTime > .15,
      { title: titles[5], index })
      const after = await state()
      assert.equal(after.audios.length, before.audios.length)
      assert.equal(active(after).index, index); assert.equal(active(after).local, true)
      assert.ok(after.events.filter(event => event.type === 'ended').length > before.events.filter(event => event.type === 'ended').length)
      const delivery = assertOfflineProviderDelivery(observer, mark, fixtureMark)
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('pletina:web:queue:v1')))
      assert.equal(saved.queue[saved.order[saved.pos]].track.id, fixture.tracks[5].id)
      assert.equal(saved.queue.length, titles.length, 'Skipping does not erase the main queue')
      return { skippedIds: fixture.tracks.slice(1, 5).map(track => track.id), automaticEnded: true,
        extraPlayGesture: false, sameAudio: true, providerDelivery: delivery, audio: after,
        networkMode: offline.mode, physicalScreenOffClaimed: false }
    } finally { observer.stop(); await cleanDownloadScenario() }
  })

  await run('offline-dj-missing-cache-repeat-all-stops-boundedly', async () => {
    const hostLimitation = await offlineQueueHostLimitation(); if (hostLimitation) return hostLimitation
    await fixture.reset(); await clearDownloads(); await music(); await downloadMusic([0, 2, 5])
    const { titles, state: before } = await start(0), index = active(before).index
    await menu(2, 'Añadir a la cola'); await menu(5, 'Añadir a la cola')
    await nowPlaying(); await tap('.np button[title="Repetir"]'); await closeOverlays()
    assert.equal(await removeCachedBody(fixture.tracks[2].id), true, 'Explicit QA cache eviction leaves a stale downloaded marker for the real player to reconcile')
    const observer = observeProviderRequests()
    try {
      const offline = await offlineInDocument(), mark = observer.attempts.length, fixtureMark = fixture.requests.length
      await seek(.91)
      await wait(({ title, index }) => document.querySelector('.mini .title')?.textContent.trim() === title &&
        !window.__qaAudio.instances[index].paused && window.__qaAudio.instances[index].currentTime > .15,
      { title: titles[5], index })
      const checkpoint = await page.evaluate(() => JSON.parse(localStorage.getItem('pletina:web:queue:v1')))
      assert.equal(checkpoint.manual.track.id, fixture.tracks[5].id); assert.equal(checkpoint.userQueue.length, 0)
      assert.equal(checkpoint.pos, 0, 'DJ playback keeps the main queue cursor')
      assert.ok(!(await downloadState()).rows.some(row => row.id === fixture.tracks[2].id), 'A missing cache body must retire its stale download pointer')
      await downloadsView(); await tap('.summary button:has-text("Quitar todas")'); await tap('.confirm button.danger')
      await wait(() => document.querySelector('.empty-state strong')?.textContent.includes('Aún no has descargado'))
      await seek(.91)
      await wait(() => window.__qaAudio.instances.every(audio => audio.paused) &&
        [...document.querySelectorAll('[role="status"]')].some(node => node.textContent.includes('Sin conexión') && node.textContent.includes('descargadas')))
      const stopped = await state(), ended = stopped.events.filter(event => event.type === 'ended').length
      await page.waitForTimeout(200)
      const settled = await state()
      assert.equal(settled.audios.length, before.audios.length)
      assert.equal(settled.events.filter(event => event.type === 'ended').length, ended, 'Repeat-all with no local files must stop rather than circulate')
      const delivery = assertOfflineProviderDelivery(observer, mark, fixtureMark)
      assert.equal(await page.locator('dialog[data-official-youtube][open]').count(), 0)
      return { evictedId: fixture.tracks[2].id, playedDjId: fixture.tracks[5].id, stalePointerRemoved: true,
        exhaustedRepeatAllStopped: true, providerDelivery: delivery, audio: settled,
        networkMode: offline.mode, physicalAirplaneModeClaimed: false }
    } finally { observer.stop(); await cleanDownloadScenario() }
  })

  await run('durable-download-queue-reopens-offline-and-resumes-fifo-online', async () => {
    await fixture.reset(); await clearDownloads(); await reload(); await music()
    const indices = [3, 4, 5], ids = indices.map(index => fixture.tracks[index].id), earlierChoices = await sourceChoiceSnapshot()
    // Earlier cases deliberately persist a manual source for track101. Use
    // distinct untouched fixture recordings; never erase that product choice.
    const gate = fixture.holdNextPlayer(fixture.tracks[indices[0]].videoId, { clientName: 'VISIONOS' })
    let offline
    try {
      await menu(indices[0], 'Descargar'); await gate.waitForRequest()
      await menu(indices[1], 'Descargar'); await menu(indices[2], 'Descargar'); await downloadsView()
      await wait(() => document.querySelectorAll('.page .queue li').length === 3)
      assertPendingCheckpoint(await pendingDownloadCheckpoint(), ids)
      assert.deepEqual((await downloadState()).rows, [], 'An unresolved source cannot already be a completed file')
      offline = await ctx.goOffline(true); gate.release()
      await reload(); await downloadsView()
      await wait(() => document.querySelectorAll('.page .queue li').length === 3)
      assertPendingCheckpoint(await pendingDownloadCheckpoint(), ids)
      assert.deepEqual((await downloadState()).rows, [])
      assert.equal((await downloadState()).cacheEntries, 0, 'Reopening offline cannot commit an empty or partial response')
      assert.equal(await page.evaluate(() => window.__e2eTransfers.filter(event => event.state === 'done').length), 0)
      const mark = await transferMark()
      await ctx.goOffline(false)
      let automaticOnlineResume = true
      if (!offline.navigatorOfflineExpected) {
        // WebKit's origin/provider gate preserves navigator.onLine. It cannot
        // prove a browser online event; exercise the visible retry action and
        // report that narrower behavior rather than dispatching a fake event.
        automaticOnlineResume = false
        await page.getByRole('button', { name: 'Reintentar descargas', exact: true }).waitFor()
        await tap(page.getByRole('button', { name: 'Reintentar descargas', exact: true }))
      }
      for (const id of ids) assert.equal((await terminal(mark, id)).state, 'done')
      const completed = await page.evaluate(mark => window.__e2eTransfers.slice(mark).filter(event => event.state === 'done').map(event => event.id), mark)
      assert.deepEqual(completed, ids, 'Resumption must preserve FIFO and complete every job exactly once')
      assertPendingCheckpoint(await pendingDownloadCheckpoint(), [])
      const files = await downloadState()
      assert.equal(files.rows.length, 3); assert.equal(files.cacheEntries, 3)
      assert.ok(files.rows.every(row => row.present))
      assertEarlierChoicesPreserved(earlierChoices, await sourceChoiceSnapshot())
      return { persistedIds: ids, resumedIds: completed, automaticOnlineResume,
        checkpointContainsOnlyCatalogMetadata: true, falseCompletedWhileOffline: false,
        database: files, networkMode: offline.mode, physicalBackgroundDownloadClaimed: false }
    } finally { gate.release(); await cleanDownloadScenario() }
  })

  await run('durable-download-cancellation-survives-reload-without-ghost-jobs', async () => {
    await fixture.reset(); await clearDownloads(); await reload(); await music()
    const ids = fixture.tracks.slice(0, 3).map(track => track.id)
    try {
      const offline = await offlineInDocument()
      for (let index = 0; index < 3; index++) await menu(index, 'Descargar')
      await downloadsView(); await wait(() => document.querySelectorAll('.page .queue li').length === 3)
      assertPendingCheckpoint(await pendingDownloadCheckpoint(), ids)
      await tap('.page button.cancel')
      await wait(() => document.querySelectorAll('.page .queue li').length === 0)
      assertPendingCheckpoint(await pendingDownloadCheckpoint(), [])
      await restoreNetwork()
      const observer = observeProviderRequests()
      try {
        await reload(); await downloadsView(); await frame()
        assertPendingCheckpoint(await pendingDownloadCheckpoint(), [])
        assert.deepEqual((await downloadState()).rows, [])
        assert.equal((await downloadState()).cacheEntries, 0)
        assert.equal(await page.locator('.page .queue li').count(), 0)
        await page.waitForTimeout(200)
        assert.deepEqual(observer.attempts, [], 'Cancelled durable jobs cannot restart a provider request after reload')
        return { cancelledIds: ids, persistedPendingIds: [], noGhostTransfers: true, networkMode: offline.mode }
      } finally { observer.stop() }
    } finally { await cleanDownloadScenario() }
  })

  await run('durable-download-owner-window-handoff-preserves-pending-fifo', async () => {
    await fixture.reset(); await clearDownloads(); await closeOverlays(); await pause()
    const appURL = ctx.getappURL(), indices = [3, 4], ids = indices.map(index => fixture.tracks[index].id), earlierChoices = await sourceChoiceSnapshot()
    let owner, gate, nextGate
    try {
      // Keep the harness Page object alive, while releasing its actual app
      // document. The extra page can then become the first real queue owner.
      ctx.report.ownerDiagnostics = { initial: await page.evaluate(async () => ({ locks: await navigator.locks.query(), statuses: [...document.querySelectorAll('[role="status"]')].map(n=>n.textContent.trim()) })) }
      await page.evaluate(() => addEventListener('pagehide', e => localStorage.setItem('pletina:qa:owner-pagehide', JSON.stringify({persisted:e.persisted,at:Date.now()})), {once:true}))
      await page.goto('about:blank')
      owner = await context.newPage(); await fixture.attachPage(owner)
      owner.setDefaultTimeout(15000)
      await owner.goto(appURL, { waitUntil: 'load' }); await owner.locator('.bottom-nav').waitFor()
      await owner.locator('.bottom-nav button').filter({ hasText: /^\s*Buscar\s*$/ }).click()
      await owner.locator('input[aria-label="Buscar música"]').fill(media.query)
      await owner.waitForFunction(title => document.querySelector('.tracks li[data-reorder-index="0"] .name')?.textContent.trim() === title, fixture.tracks[0].title)
      const ownerDownload = async index => {
        await owner.locator(row(index) + ' button.more').click()
        await owner.getByRole('menuitem', { name: 'Descargar', exact: true }).click()
      }
      gate = fixture.holdNextPlayer(fixture.tracks[indices[0]].videoId, { clientName: 'VISIONOS' })
      await ownerDownload(indices[0])
      ctx.report.ownerDiagnostics.afterDownloadClick = await owner.evaluate(async () => ({ locks: await navigator.locks.query(), pagehide: JSON.parse(localStorage.getItem('pletina:qa:owner-pagehide')||'null'), statuses: [...document.querySelectorAll('[role="status"]')].map(n=>n.textContent.trim()), notices: [...document.querySelectorAll('.toast')].map(n=>n.textContent.trim()) }))
      await gate.waitForRequest(); await ownerDownload(indices[1])
      ctx.report.ownerDiagnostics.firstGateReached = true
      nextGate = fixture.holdNextPlayer(fixture.tracks[indices[1]].videoId, { clientName: 'VISIONOS' })
      await page.goto(appURL, { waitUntil: 'load' }); await page.locator('.bottom-nav').waitFor(); await frame()
      await downloadsView()
      await page.locator('.page [role="status"]').filter({ hasText: 'otra ventana' }).waitFor()
      assertPendingCheckpoint(await pendingDownloadCheckpoint(), ids)
      assert.deepEqual((await downloadState()).rows, [])
      const mark = fixture.requests.length
      await music(); await menu(2, 'Descargar')
      await wait(() => [...document.querySelectorAll('[role="status"]')].some(node =>
        node.textContent.includes('No se pudo empezar la descarga') && node.textContent.includes('otra ventana')))
      assertPendingCheckpoint(await pendingDownloadCheckpoint(), ids)
      assert.equal(fixture.requests.slice(mark).filter(request => request.operation === 'player' && request.videoId === fixture.tracks[2].videoId).length, 0,
        'The losing window must fail before starting a new media operation')
      assert.equal(gate.claimed, true)
      gate.release(); await nextGate.waitForRequest()
      ctx.report.ownerDiagnostics.secondGateReached = true
      assertPendingCheckpoint(await pendingDownloadCheckpoint(), [ids[1]])
      assert.ok((await downloadState()).rows.find(row => row.id === ids[0])?.present,
        'The owning window must continue and commit its first job while the other window is blocked')
      await owner.close(); owner = null; nextGate.release()
      ctx.report.ownerDiagnostics.ownerReallyClosed = true
      await wait(async () => !(await navigator.locks.query()).held.some(lock => lock.name === 'pletina-download-owner:v1'))
      await downloadsView()
      const transferStart = await transferMark()
      await tap(page.getByRole('button', { name: 'Reintentar descargas', exact: true }))
      assert.equal((await terminal(transferStart, ids[1])).state, 'done')
      const completed = await page.evaluate(mark => window.__e2eTransfers.slice(mark).filter(event => event.state === 'done').map(event => event.id), transferStart)
      assert.deepEqual(completed, [ids[1]], 'The handoff resumes only the remaining FIFO, without downloading the committed first job again')
      assertPendingCheckpoint(await pendingDownloadCheckpoint(), [])
      const files = await downloadState()
      assert.equal(files.rows.length, 2); assert.equal(files.cacheEntries, 2)
      assert.ok(files.rows.every(row => row.present && ids.includes(row.id)))
      assertEarlierChoicesPreserved(earlierChoices, await sourceChoiceSnapshot())
      return { pages: 2, losingWindowDidNotOverwriteJobs: true, ownerContinuedAndCommittedIds: [ids[0]], ownerTabClosed: true, resumedIds: completed,
        explicitRetryAfterHandoff: true, database: files,
        additionalPageTransport: ctx.engine === 'chromium' ? 'Same Puppeteer HTTP fixture bridge as the primary page; no application module replacement' : 'Playwright per-page HTTP provider fixtures; no application module replacement', physicalMultiwindowClaimed: false }
    } finally {
      if (owner && !owner.isClosed()) await owner.close().catch(() => {})
      if (!page.isClosed() && new URL(page.url()).protocol.startsWith('http')) await page.evaluate(() => localStorage.removeItem('pletina:qa:owner-pagehide')).catch(() => {})
      gate?.release()
      nextGate?.release()
      if (!await visible('.app')) { await page.goto(appURL, { waitUntil: 'load' }); await page.locator('.bottom-nav').waitFor(); await frame() }
      await cleanDownloadScenario()
    }
  })

  await run('download-startup-reconciles-orphan-stages-and-preserves-committed-files', async () => {
    await fixture.reset(); await clearDownloads(); await music(); await downloadMusic([0])
    const track = fixture.tracks[0]
    let seeded
    try {
      seeded = await page.evaluate(async ({ id, videoId }) => {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('pletina-web-downloads'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
        })
        let saved
        try { saved = await new Promise((resolve, reject) => { const request = db.transaction('files').objectStore('files').get(id); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) }) }
        finally { db.close() }
        const cache = await caches.open('pletina-audio-downloads:v1')
        if (!saved || !await cache.match(saved.cacheKey)) throw new Error('Orphan control requires a real committed download')
        const orphan = new URL('../__audio__/998?stage=' + Date.now() + '-' + crypto.randomUUID(), location.href).href
        const foreign = new URL('../qa-unrelated-cache-marker', location.href).href
        const body = await fetch('https://fixture.googlevideo.com/audio/' + videoId, { mode: 'no-cors', credentials: 'omit' })
        await cache.put(orphan, body)
        await cache.put(foreign, new Response('Unrelated QA cache marker', { headers: { 'content-type': 'text/plain' } }))
        return { saved, orphan, foreign }
      }, { id: track.id, videoId: fixture.tracks[5].videoId })
      assert.equal((await downloadState()).cacheEntries, 3)
      await reload(); await downloadsView()
      await wait(async orphan => !await (await caches.open('pletina-audio-downloads:v1')).match(orphan), seeded.orphan)
      const reconciled = await page.evaluate(async seeded => {
        const cache = await caches.open('pletina-audio-downloads:v1'), db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('pletina-web-downloads'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
        })
        try {
          const saved = await new Promise((resolve, reject) => { const request = db.transaction('files').objectStore('files').get(seeded.saved.id); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
          return { saved, committedPresent: Boolean(await cache.match(seeded.saved.cacheKey)), orphanPresent: Boolean(await cache.match(seeded.orphan)),
            foreignValue: await (await cache.match(seeded.foreign))?.text(), cacheEntries: (await cache.keys()).length }
        } finally { db.close() }
      }, seeded)
      assert.deepEqual(reconciled.saved, seeded.saved, 'Startup reconciliation cannot rewrite the committed metadata or pointer')
      assert.equal(reconciled.committedPresent, true); assert.equal(reconciled.orphanPresent, false)
      assert.equal(reconciled.foreignValue, 'Unrelated QA cache marker'); assert.equal(reconciled.cacheEntries, 2)
      await tap(row(0) + ' .name'); const audio = await playing(track.title); assert.equal(active(audio).local, true)
      await pause()
      await page.evaluate(async foreign => { await (await caches.open('pletina-audio-downloads:v1')).delete(foreign) }, seeded.foreign)
      return { explicitSeededOrphanStageRemoved: true, unrelatedKeyPreserved: true, committedPointerAndMetadataPreserved: true,
        realCommittedDownloadReplayed: true, audio, physicalPhoneClaimed: false }
    } finally {
      if (seeded) await page.evaluate(async foreign => { await (await caches.open('pletina-audio-downloads:v1')).delete(foreign) }, seeded.foreign).catch(() => {})
      await cleanDownloadScenario()
    }
  })

  await run('audius-permitted-full-file-download-hash-and-offline-playback', async () => {
    await fixture.reset(); await clearDownloads(); await reload()
    await fixture.set({ audiusCatalogRescue: true, audiusDownloadAllowed: true })
    const track = media.audiusRescue.track
    try {
      await ctx.fillSearch('Buscar', media.audiusRescue.query)
      await wait(title => document.querySelector('.tracks li[data-reorder-index="0"] .name')?.textContent.trim() === title, track.title)
      const mark = await transferMark(); await menu(0, 'Descargar')
      assert.equal((await terminal(mark, track.id)).state, 'done')
      const copy = await page.evaluate(async id => {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('pletina-web-downloads'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
        })
        try {
          const row = await new Promise((resolve, reject) => {
            const request = db.transaction('files').objectStore('files').get(id)
            request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
          })
          const response = await (await caches.open('pletina-audio-downloads:v1')).match(row.cacheKey)
          if (!response || response.type === 'opaque') throw new Error('The CORS-permitted full-file fixture must remain readable for independent hashing')
          const bytes = await response.arrayBuffer(), hash = await crypto.subtle.digest('SHA-256', bytes)
          return { id: row.id, storedBytes: row.size, actualBytes: bytes.byteLength, type: response.headers.get('content-type'),
            sha256: [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('') }
        } finally { db.close() }
      }, track.id)
      assert.equal(copy.sha256, fixture.audioFile.sha256); assert.equal(copy.actualBytes, fixture.audioFile.bytes)
      assert.equal(copy.storedBytes, fixture.audioFile.bytes); assert.equal(copy.type, fixture.audioFile.mime)
      const offline = await ctx.goOffline(true)
      await reload(); await downloadsView(); await tap(row(0) + ' .name'); await playing(track.title)
      await seek(.5)
      await wait(() => window.__qaAudio.instances.some(audio => !audio.paused && !audio.seeking && audio.currentTime > audio.duration / 2 + .3))
      const value = await state(); assert.equal(active(value).local, true)
      return { fullFile: copy, downloadPermission: 'Controlled Audius metadata explicitly allows full download',
        originalRecordingClaimed: false, verifiedBlobOffsetCoveredByUnitTestsOnly: true,
        audio: value, networkMode: offline.mode, physicalPhoneClaimed: false }
    } finally { await cleanDownloadScenario() }
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
