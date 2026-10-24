// Downloads enter through the real UI. Storage reads are assertions; no cover,
// download pointer, audio body or player command is seeded by this scenario.
import assert from 'node:assert/strict'

export const DOWNLOAD_COVERS_SCENARIO = 'downloaded-covers-survive-outage-and-prune-only-after-final-shared-removal'

export async function runDownloadCoversScenario(ctx, helpers) {
  const { page, fixture, tap } = ctx
  const { restoreNetwork, closeOverlays, pause, controlsOff, clearDownloads, reload,
    wait, menu, transferMark, terminal, downloadState, downloadsView, state, active, playing, nowPlaying } = helpers
  const sample = fixture.media.downloadCovers
  assert.equal(sample?.tracks?.length, 3, 'Dedicated cover fixtures must contain two shared references and one rejected image')
  const [first, second, invalid] = sample.tracks
  const row = index => `.tracks li[data-reorder-index="${index}"]`
  const coverState = () => page.evaluate(async () => {
    const cache = await caches.open('pletina-cover-downloads:v1')
    return Promise.all((await cache.keys()).map(async request => {
      const response = await cache.match(request), bytes = await response.arrayBuffer()
      const digest = await crypto.subtle.digest('SHA-256', bytes)
      const key = new URL(request.url)
      return { key: request.url, path: key.pathname, source: key.searchParams.get('url'), type: response.type,
        status: response.status, mime: response.headers.get('content-type'), measuredLength: response.headers.get('content-length'),
        bytes: bytes.byteLength, sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') }
    }))
  })
  async function waitCoverCount(count) {
    await wait(async count => (await (await caches.open('pletina-cover-downloads:v1')).keys()).length === count, count, 20000)
  }
  async function assertImage(selector) {
    await wait(selector => {
      const image = document.querySelector(selector)
      return image?.complete && image.naturalWidth === 192 && image.naturalHeight === 192 &&
        new URL(image.currentSrc || image.src).origin === location.origin && new URL(image.currentSrc || image.src).pathname.endsWith('/__covers__')
    }, selector)
    return page.evaluate(selector => {
      const image = document.querySelector(selector), source = new URL(image.currentSrc || image.src)
      return { width: image.naturalWidth, height: image.naturalHeight, local: source.origin === location.origin,
        path: source.pathname, original: source.searchParams.get('url') }
    }, selector)
  }
  const requests = [], observed = new Map()
  function request(request) {
    const url = new URL(request.url())
    if (!/(?:^|\.)(?:youtube\.com|googlevideo\.com|audius\.co|pletina\.test)$/.test(url.hostname)) return
    const value = { host: url.hostname, path: url.pathname, type: request.resourceType(), failed: null, responseStatus: null, fromServiceWorker: null }
    observed.set(request, value); requests.push(value)
  }
  const requestFailed = request => { const value = observed.get(request); if (value) value.failed = request.failure()?.errorText ?? 'failed' }
  const response = response => { const value = observed.get(response.request()); if (value) { value.responseStatus = response.status(); value.fromServiceWorker = response.fromServiceWorker() } }
  page.on('request', request); page.on('requestfailed', requestFailed); page.on('response', response)
  await restoreNetwork(); await fixture.reset(); await closeOverlays(); await pause(); await controlsOff(); await clearDownloads(); await reload()
  const fixtureStart = fixture.requests.length
  try {
    await waitCoverCount(0)
    await ctx.fillSearch('Buscar', sample.query)
    await wait(titles => titles.every((title, index) => document.querySelector(`.tracks li[data-reorder-index="${index}"] .name`)?.textContent.trim() === title), sample.tracks.map(track => track.title))
    const mark = await transferMark()
    for (let index = 0; index < sample.tracks.length; index++) await menu(index, 'Descargar')
    const terminalEvents = []
    for (const track of sample.tracks) {
      const event = await terminal(mark, track.id)
      assert.equal(event.state, 'done', 'An unavailable cover must not invalidate a complete audio download')
      terminalEvents.push(event)
    }
    await waitCoverCount(1)
    const saved = await downloadState(), covers = await coverState()
    assert.deepEqual(saved.rows.map(row => row.id), sample.tracks.map(track => track.id))
    assert.equal(saved.cacheEntries, 3); assert.ok(saved.rows.every(row => row.present && row.type === 'opaque'))
    assert.equal(covers[0].source, sample.sharedURL)
    assert.equal(new URL(covers[0].key).origin, new URL(page.url()).origin)
    assert.ok(covers[0].path.endsWith('/__covers__'))
    assert.ok(['basic', 'default'].includes(covers[0].type), 'Saved artwork must expose a readable synthetic body')
    assert.equal(covers[0].status, 200); assert.equal(covers[0].mime, 'image/png')
    assert.equal(covers[0].bytes, fixture.coverFile.bytes); assert.equal(covers[0].measuredLength, String(fixture.coverFile.bytes))
    assert.equal(covers[0].sha256, fixture.coverFile.sha256)
    assert.ok(!covers.some(cover => cover.source === sample.invalidURL), 'HTML with an image MIME cannot enter the raster cache')
    const records = await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => { const open = indexedDB.open('pletina-web-downloads'); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error) })
      try { return await new Promise((resolve, reject) => { const get = db.transaction('files').objectStore('files').getAll(); get.onsuccess = () => resolve(get.result); get.onerror = () => reject(get.error) }) }
      finally { db.close() }
    })
    assert.deepEqual(records.map(record => record.track.cover), [sample.sharedURL, sample.sharedURL, sample.invalidURL],
      'Downloaded metadata must retain permanent source references rather than session Blob URLs')
    assert.doesNotMatch(JSON.stringify(records), /blob:|[?&](?:sig|signature|expire)=/i)
    const imageResponses = fixture.requests.slice(fixtureStart).filter(value => value.fixtureCase === 'download-covers')
    assert.ok(imageResponses.some(value => value.path === new URL(sample.sharedURL).pathname && value.responseMime === 'image/png' && value.bodySha256 === fixture.coverFile.sha256))
    assert.ok(imageResponses.some(value => value.path === new URL(sample.invalidURL).pathname && value.invalidRaster === true))
    const rejectedImageAttempts = imageResponses.filter(value => value.invalidRaster && value.type === 'image').length
    assert.ok(rejectedImageAttempts <= 10, `A rejected cover must settle to its fallback rather than remount continuously (${rejectedImageAttempts} requests)`)
    const offline = await ctx.goOffline(true), fixtureMark = fixture.requests.length, requestMark = requests.length
    await reload(); await downloadsView()
    assert.equal(await page.evaluate(() => navigator.onLine), !offline.navigatorOfflineExpected)
    assert.ok((await state()).audios.every(audio => audio.paused))
    const libraryArtwork = [await assertImage(row(0) + ' .cover img'), await assertImage(row(1) + ' .cover img')]
    await tap(row(0) + ' .name')
    const audio = await playing(first.title)
    assert.equal(active(audio).local, true); assert.equal(audio.audios.length, 1)
    const miniArtwork = await assertImage('.mini .cover img')
    await nowPlaying()
    const playerArtwork = await assertImage('.np .art .cover img')
    const metadata = await page.evaluate(() => navigator.mediaSession?.metadata ? {
      title: navigator.mediaSession.metadata.title, artwork: Array.from(navigator.mediaSession.metadata.artwork, image => ({
        src: image.src, sizes: image.sizes, type: image.type,
      })),
    } : null)
    if (metadata) {
      assert.equal(metadata.title, first.title); assert.equal(metadata.artwork.length, 1)
      const artwork = metadata.artwork[0], local = new URL(artwork.src)
      assert.equal(local.origin, new URL(page.url()).origin); assert.ok(local.pathname.endsWith('/__covers__'))
      assert.equal(local.searchParams.get('url'), sample.sharedURL)
      assert.ok(!artwork.type, 'PWA MediaSession cannot guess JPEG for a cached PNG')
      assert.ok(!artwork.sizes, 'PWA MediaSession cannot advertise an unmeasured 500×500 size')
    }
    await closeOverlays(); await pause()
    await menu(0, 'Quitar descarga')
    await wait(async id => {
      const db = await new Promise(resolve => { const open = indexedDB.open('pletina-web-downloads'); open.onsuccess = () => resolve(open.result) })
      try { return await new Promise(resolve => { const get = db.transaction('files').objectStore('files').get(id); get.onsuccess = () => resolve(!get.result) }) }
      finally { db.close() }
    }, first.id)
    await wait(title => document.querySelector('.tracks li[data-reorder-index="0"] .name')?.textContent.trim() === title, second.title)
    await waitCoverCount(1)
    const retained = await coverState()
    assert.deepEqual(retained, covers, 'Removing one shared download must preserve the remaining cover and its exact readable bytes')
    await reload(); await downloadsView()
    const retainedArtwork = await assertImage(row(0) + ' .cover img')
    await menu(0, 'Quitar descarga')
    await wait(title => document.querySelector('.tracks li[data-reorder-index="0"] .name')?.textContent.trim() === title, invalid.title)
    await waitCoverCount(0)
    await tap(row(0) + ' .name')
    const invalidCoverAudio = await playing(invalid.title)
    assert.equal(active(invalidCoverAudio).local, true); assert.equal(active(invalidCoverAudio).error, null)
    const outageRequests = requests.slice(requestMark)
    assert.ok(outageRequests.every(value => value.failed !== null || value.fromServiceWorker === true || value.responseStatus === null),
      'Every observed external alias during the outage must fail or be satisfied by the local worker')
    const externalDeliveries = fixture.requests.slice(fixtureMark).filter(value => !value.injectedFailure && value.operation !== 'qa-cancelled-route')
    assert.deepEqual(externalDeliveries, [], 'Neither the original provider nor cover origin may deliver bytes after the outage')
    assert.equal(await page.locator('iframe[data-official-video]').count(), 0)
    return { downloadedIds: sample.tracks.map(track => track.id), sharedCoverIds: [first.id, second.id], terminalEvents,
      audioDatabase: saved, persistedCoverReferences: records.map(record => record.track.cover), raster: covers[0], fixture: fixture.coverFile, rejectedImageAttempts,
      libraryArtwork, miniArtwork, playerArtwork, mediaSession: metadata, retainedArtwork,
      retainedAfterFirstRemoval: retained.length, retainedAfterFinalSharedRemoval: 0, invalidCoverAudio,
      externalDeliveriesDuringOutage: 0, observedExternalAliases: outageRequests,
      networkMode: offline.mode, navigatorOfflineExpected: offline.navigatorOfflineExpected,
      scope: 'Real compiled UI download/removal, readable PNG bytes, production worker and browser-decoded artwork with provider/origin outage. Browser MediaSession metadata only; no physical lock-screen, live-provider or universal cover support claim.' }
  } finally {
    page.off('request', request); page.off('requestfailed', requestFailed); page.off('response', response)
    await restoreNetwork(); await fixture.reset(); await closeOverlays(); await pause(); await clearDownloads()
  }
}
