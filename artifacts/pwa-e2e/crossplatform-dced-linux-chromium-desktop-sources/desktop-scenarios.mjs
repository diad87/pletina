// Desktop-specific UI contracts. The compiled application and browser audio/storage
// remain real; provider responses are the same controlled HTTP fixtures as mobile.
import assert from 'node:assert/strict'
import { runSearchHitTargetScenario, SEARCH_HOMONYM_SCENARIO_ID } from './search-hit-targets-scenario.mjs'

export const desktopScenarioInventory = [
  'desktop.layout', SEARCH_HOMONYM_SCENARIO_ID, 'desktop.transport', 'desktop.shuffle-repeat',
  'desktop.media-session', 'desktop.volume', 'desktop.queue',
  'desktop.loading-status-and-cancel', 'desktop.sleep-timer', 'desktop.download-album-offline',
  'desktop.podcast-progress-resume',
].map(id => ({ id }))

export async function runDesktopScenarios(ctx) {
  const { page, fixture, check, tap } = ctx
  const tracks = fixture.media.tracks
  const row = index => page.locator(`ol.tracks > li[data-reorder-index="${index}"]`)
  const wait = (fn, value, timeout = 15000) => page.waitForFunction(fn, value, { timeout })
  const visible = selector => page.locator(selector).first().isVisible().catch(() => false)
  const queueSnapshot = () => page.evaluate(() => JSON.parse(localStorage.getItem('pletina:web:queue:v1') || 'null'))
  const state = () => page.evaluate(() => ({
    title: document.querySelector('.player .info .title')?.textContent.trim() ?? null,
    selectedId: (() => { const saved = JSON.parse(localStorage.getItem('pletina:web:queue:v1') || 'null'); return (saved?.manual ?? saved?.queue?.[saved.order?.[saved.pos]])?.track?.id ?? null })(),
    audio: window.__qaAudio.instances.map((audio, index) => ({ index, time: audio.currentTime, duration: audio.duration,
      paused: audio.paused, seeking: audio.seeking, muted: audio.muted, volume: audio.volume, error: audio.error?.code ?? null,
      source: audio.currentSrc ? new URL(audio.currentSrc, location.href).pathname : null,
      local: audio.currentSrc ? new URL(audio.currentSrc, location.href).origin === location.origin : null })),
    handlers: Object.keys(window.__qaAudio.handlers), metadata: navigator.mediaSession?.metadata?.title ?? null,
    audioEvents: window.__qaAudio.events.map(({ type, index }) => ({ type, index })),
    width: innerWidth, mobileDock: Boolean(document.querySelector('.bottom-nav')),
  }))
  const closePanels = async () => {
    if (await visible('.np > header > button[title="Cerrar (Esc)"]')) await tap('.np > header > button[title="Cerrar (Esc)"]')
    if (await visible('.queue-panel button.close')) await tap('.queue-panel button.close')
  }
  const pause = async () => {
    await closePanels()
    if (await visible('.player button[aria-label="Pausa"]')) await tap('.player button[aria-label="Pausa"]')
    await wait(() => window.__qaAudio.instances.every(audio => audio.paused))
  }
  const search = async () => {
    await pause(); await fixture.reset(); await ctx.fillSearch('Buscar', fixture.media.query)
    await wait(titles => titles.every((title, index) =>
      document.querySelector(`ol.tracks > li[data-reorder-index="${index}"] .name`)?.textContent.trim() === title), tracks.map(track => track.title))
  }
  const playing = async track => {
    await wait(({ id, title }) => {
      const saved = JSON.parse(localStorage.getItem('pletina:web:queue:v1') || 'null')
      return document.querySelector('.player .info .title')?.textContent.trim() === title &&
        (id == null || (saved?.manual ?? saved?.queue?.[saved.order?.[saved.pos]])?.track?.id === id) &&
        window.__qaAudio.instances.some(audio => !audio.paused && !audio.seeking && !audio.error && audio.currentTime > .15)
    }, { id: track.id, title: track.title })
    await page.locator('.player button[aria-label="Pausa"]').waitFor()
    return state()
  }
  const start = async index => {
    await search()
    const old = await state()
    // A paused current row resumes its existing queue. Explicitly change first
    // so every transport case starts a fresh deterministic Search queue.
    if (old.selectedId === tracks[index].id) {
      await tap(row(index ? 0 : 1).locator('.name')); await playing(tracks[index ? 0 : 1])
      await search()
    }
    await tap(row(index).locator('.name'))
    return playing(tracks[index])
  }
  const seek = async fraction => {
    const slider = page.locator('.player input[aria-label="Posición"]')
    await slider.waitFor(); await wait(() => !document.querySelector('.player input[aria-label="Posición"]').disabled)
    const box = await slider.boundingBox(); assert.ok(box?.width > 100)
    await page.mouse.click(box.x + box.width * fraction, box.y + box.height / 2)
    await wait(() => window.__qaAudio.instances.some(audio => !audio.seeking && !audio.paused && audio.currentTime > 1))
  }
  const openQueue = async () => {
    await closePanels(); await tap('.player button.queue-btn'); await page.locator('.queue-panel').waitFor()
    assert.equal(await page.locator('.queue-sheet').count(), 0, 'Desktop uses its side panel, not the mobile queue sheet')
  }
  const menu = async (index, label) => {
    await row(index).hover(); await tap(row(index).locator('button.more'))
    await tap(page.getByRole('menuitem', { name: label, exact: true }))
  }

  await check('desktop.layout', async () => {
    assert.ok((page.viewportSize()?.width ?? 0) > 720)
    assert.equal(await page.locator('.bottom-nav').count(), 0)
    assert.equal(await page.locator('.player').count(), 1)
    return { layout: 'actual 1440px desktop sidebar and PlayerBar', viewportEmulationOfPhone: false }
  })
  // Reuse the full homonym/body/title/cover/album/metadata/keyboard assertion,
  // including exact audio ID and one-click Search -> album navigation.
  await runSearchHitTargetScenario(ctx)

  await check('desktop.transport', async () => {
    const before = await start(0), audioIndex = before.audio.find(audio => !audio.paused).index
    await pause(); assert.ok((await state()).audio.every(audio => audio.paused))
    await tap('.player button[aria-label="Reproducir"]'); await playing(tracks[0])
    await seek(.4)
    await wait(() => window.__qaAudio.instances.some(audio => audio.currentTime > 3 && audio.currentTime < 7))
    await tap('.player button[title="Siguiente"]'); await playing(tracks[1])
    await seek(.04); await tap('.player button[title="Anterior"]'); const after = await playing(tracks[0])
    assert.equal(after.audio.length, before.audio.length)
    assert.equal(after.audio.find(audio => !audio.paused).index, audioIndex)
    assert.equal(await page.locator('iframe[data-official-video]').count(), 0)
    await pause()
    return { audio: after, actualDesktopControls: true, sameAudioElement: true }
  })

  await check('desktop.shuffle-repeat', async () => {
    await start(0); await pause(); const before = await queueSnapshot()
    const ids = queue => queue.queue.map(item => item.track.id).sort((a, b) => a - b)
    await tap('.player button[aria-label="Activar reproducción aleatoria"]')
    await page.locator('.player button[aria-label="Desactivar reproducción aleatoria"][aria-pressed="true"]').waitFor()
    const shuffled = await queueSnapshot()
    assert.equal(shuffled.shuffle, true); assert.deepEqual(ids(shuffled), ids(before))
    assert.equal(shuffled.queue[shuffled.order[shuffled.pos]].track.id, tracks[0].id)
    await tap('.player button[title="Repetir"]'); assert.equal((await queueSnapshot()).repeat, 'all')
    await tap('.player button[title="Repetir una"]'); assert.equal((await queueSnapshot()).repeat, 'one')
    await tap('.player button[title="No repetir"]'); assert.equal((await queueSnapshot()).repeat, 'off')
    await tap('.player button[aria-label="Desactivar reproducción aleatoria"]')
    assert.equal((await queueSnapshot()).shuffle, false)
    return { preservedCurrent: tracks[0].id, queueMembershipUnchanged: true, repeatCycle: ['all', 'one', 'off'] }
  })

  await check('desktop.media-session', async () => {
    const before = await start(0)
    if (!await page.evaluate(() => 'mediaSession' in navigator)) return { status: 'unsupported', reason: 'This browser does not expose MediaSession.' }
    for (const action of ['play', 'pause', 'nexttrack', 'previoustrack', 'seekto']) assert.ok(before.handlers.includes(action), action)
    assert.equal(before.metadata, tracks[0].title)
    await page.evaluate(() => { window.__qaAudio.handlers.pause({ action: 'pause' }); window.__qaAudio.handlers.pause({ action: 'pause' }) })
    await wait(() => window.__qaAudio.instances.every(audio => audio.paused))
    await page.evaluate(() => window.__qaAudio.handlers.play({ action: 'play' })); await playing(tracks[0])
    await page.evaluate(() => window.__qaAudio.handlers.seekto({ action: 'seekto', seekTime: 3 }))
    await wait(() => window.__qaAudio.instances.some(audio => !audio.paused && audio.currentTime >= 3 && audio.currentTime < 6))
    await page.evaluate(() => window.__qaAudio.handlers.nexttrack({ action: 'nexttrack' })); const after = await playing(tracks[1])
    assert.equal(after.audio.length, before.audio.length); await pause()
    return { capturedBrowserHandlers: true, nativeOSControlsClaimed: false, after }
  })

  await check('desktop.volume', async () => {
    await start(0)
    const slider = page.locator('.player input[aria-label="Volumen"]')
    await slider.focus(); await slider.press('Home'); await slider.press('ArrowRight')
    await wait(() => window.__qaAudio.instances.some(audio => !audio.paused && audio.volume > 0 && audio.volume < .1))
    const lowered = await state()
    await tap('.player button[title="Silenciar"]')
    await wait(() => window.__qaAudio.instances.some(audio => !audio.paused && audio.muted))
    await tap('.player button[title="Activar sonido"]')
    await wait(() => window.__qaAudio.instances.some(audio => !audio.paused && !audio.muted && audio.volume > 0))
    await slider.focus(); await slider.press('End')
    await wait(() => window.__qaAudio.instances.some(audio => !audio.paused && audio.volume === 1))
    await pause()
    return { actualKeyboardRangeInput: true, lowered: lowered.audio, muteUnmuteKeptPlaying: true }
  })

  await check('desktop.queue', async () => {
    await start(0); await pause(); await search()
    for (const index of [2, 2, 1]) await menu(index, 'Añadir a la cola')
    await openQueue()
    const titles = () => page.locator('.queue-panel .mine li[data-reorder-index] .title').allTextContents()
    assert.deepEqual(await titles(), [tracks[2].title, tracks[2].title, tracks[1].title])
    await page.locator('.queue-panel .mine li[data-reorder-index="2"]').dragTo(
      page.locator('.queue-panel .mine li[data-reorder-index="0"]'), { targetPosition: { x: 24, y: 2 } })
    await wait(title => document.querySelector('.queue-panel .mine li[data-reorder-index="0"] .title')?.textContent === title, tracks[1].title)
    await tap('.queue-panel .mine li[data-reorder-index="1"] button.remove')
    assert.deepEqual(await titles(), [tracks[1].title, tracks[2].title])
    await tap('.queue-panel .mine li[data-reorder-index="0"] button.main'); await playing(tracks[1]); await pause()
    await openQueue(); assert.deepEqual(await titles(), [tracks[2].title])
    await tap('.queue-panel button.save'); await page.locator('.hero input[aria-label="Nombre de la playlist"]').waitFor()
    assert.deepEqual((await page.locator('ol.tracks .name').allTextContents()).map(text => text.trim()), [tracks[1].title, tracks[2].title])
    await closePanels(); await tap('.player button.queue-btn'); await tap('.queue-panel button.clear')
    assert.deepEqual(await titles(), []); await closePanels()
    return { desktopHTMLDragAndDrop: true, duplicatesAllowed: true, removePlayConsumeSaveClear: true }
  })

  await check('desktop.loading-status-and-cancel', async () => {
    await pause(); await fixture.reset()
    const sample = fixture.media.artistSelection, track = sample.tracks[1]
    await ctx.fillSearch('Buscar', sample.query)
    await wait(title => document.querySelector('ol.tracks .name')?.textContent.trim() === title, sample.tracks[0].title)
    await tap('.top-result'); await page.locator('.banner h1').filter({ hasText: sample.artists[0].name }).waitFor()
    const gate = fixture.holdNextPlayer(track.videoId)
    try {
      await tap(row(1).locator('.name')); await gate.waitForRequest()
      await page.locator('.player .now[aria-busy="true"]').waitFor()
      assert.equal((await page.locator('.player .title').textContent()).trim(), track.title)
      assert.equal((await page.locator('.player .hint').textContent()).trim(), 'Preparando audio…')
      await page.locator('.player button[aria-label="Cancelar carga"]').waitFor()
      assert.ok((await state()).audio.every(audio => audio.paused))
      await page.clock.runFor(6100)
      assert.equal((await page.locator('.player .hint.loading-wait').textContent()).trim(), 'Está tardando… Puedes elegir otra canción')
      assert.match(await page.locator('.player .loading-status[role="status"]').textContent(), /Está tardando/)
      await tap('.player button[aria-label="Cancelar carga"]')
      await page.locator('.player button[aria-label="Reproducir"]').waitFor()
      gate.release(); const delivery = await gate.waitForDelivery()
      assert.ok((await state()).audio.every(audio => audio.paused), 'Cancelling cannot start late audio')
      await tap('.player button[aria-label="Reproducir"]'); const after = await playing(track); await pause()
      return { actualHeldHTTPResponse: true, sixSecondFeedbackClockAdvanced: true, cancellationPreventedLatePlay: true, delivery, audio: after }
    } finally { gate.release(); await fixture.reset(); await pause() }
  })

  await check('desktop.sleep-timer', async () => {
    await start(0)
    await tap('.player button.timer'); await page.locator('dialog[data-sleep-timer][open]').waitFor()
    await tap('dialog[data-sleep-timer] button.custom-option')
    const input = page.locator('dialog[data-sleep-timer] input[type="number"]')
    await input.fill('0'); await tap('dialog[data-sleep-timer] form button[type="submit"]')
    await page.locator('dialog[data-sleep-timer] .error').waitFor()
    await input.fill('1'); await tap('dialog[data-sleep-timer] form button[type="submit"]')
    await page.locator('dialog[data-sleep-timer][open]').waitFor({ state: 'hidden' })
    await page.locator('.player button.timer.active').waitFor()
    await page.clock.fastForward(60050)
    await wait(() => window.__qaAudio.instances.every(audio => audio.paused))
    assert.equal(await page.locator('.player button.timer.active').count(), 0)
    return { customValidation: true, oneMinuteDeadline: true, clock: 'Browser clock advanced; no real OS sleep claim.' }
  })

  await check('desktop.download-album-offline', async () => {
    await pause()
    await tap(page.locator('.sidebar .items .item').filter({ hasText: 'Descargas' }).first())
    await page.locator('h1.page-title').filter({ hasText: 'Descargas' }).waitFor()
    const existingTitles = (await page.locator('ol.tracks .name').allTextContents()).map(text => text.trim())
    await search(); const album = fixture.albums[0]
    await tap(page.locator(`.grid .hit[aria-label="${album.title}"]`))
    await page.locator('.hero h1').filter({ hasText: album.title }).waitFor()
    const expected = fixture.tracks.filter(track => track.album.id === album.id)
    await tap('.actions button[title="Descargar"]')
    await page.locator('.actions button[title="Descargado · clic para quitar"]').waitFor({ timeout: 45000 })
    await tap(page.locator('.sidebar .items .item').filter({ hasText: 'Descargas' }).first())
    await page.locator('h1.page-title').filter({ hasText: 'Descargas' }).waitFor()
    const downloadedTitles = (await page.locator('ol.tracks .name').allTextContents()).map(text => text.trim())
    assert.deepEqual(new Set(downloadedTitles), new Set([...existingTitles, ...expected.map(track => track.title)]),
      'Downloading a whole album must add its four files and preserve previous downloads')
    const before = fixture.requests.filter(request => request.host.endsWith('.googlevideo.com')).length
    const transition = await ctx.goOffline(true)
    try {
      assert.equal(await page.evaluate(() => navigator.onLine), false)
      await page.reload({ waitUntil: 'load' }); await page.locator('.player').waitFor()
      assert.equal(await page.locator('.bottom-nav').count(), 0)
      assert.deepEqual(new Set((await page.locator('ol.tracks .name').allTextContents()).map(text => text.trim())), new Set(downloadedTitles))
      await tap('.actions button.big-play[title="Reproducir"]')
      await wait(() => window.__qaAudio.instances.some(audio => !audio.paused && !audio.error && audio.currentTime > .2 && new URL(audio.src).pathname.includes('/__audio__/')))
      const first = await state(), audioIndex = first.audio.find(audio => !audio.paused).index
      const slider = page.locator('.player input[aria-label="Posición"]'), box = await slider.boundingBox(); assert.ok(box)
      await page.mouse.click(box.x + box.width * .96, box.y + box.height / 2)
      await wait(({ id, index }) => {
        const saved = JSON.parse(localStorage.getItem('pletina:web:queue:v1') || 'null'), audio = window.__qaAudio.instances[index]
        return saved?.queue?.[saved.order?.[saved.pos]]?.track?.id !== id && audio && !audio.paused && !audio.error && audio.currentTime > .15 &&
          new URL(audio.src).pathname.includes('/__audio__/') && window.__qaAudio.events.some(event => event.type === 'ended' && event.index === index)
      }, { id: first.selectedId, index: audioIndex }, 20000)
      const after = await state(); assert.equal(after.audio.length, first.audio.length)
      assert.equal(fixture.requests.filter(request => request.host.endsWith('.googlevideo.com')).length, before)
      await pause()
      return { albumId: album.id, downloadedSongs: expected.length, reloadPersisted: true, offlineTransition: transition,
        actualLocalAudioAndSeek: true, realEndedAdvancedQueue: true, audio: after, providerTransfersWhileOffline: 0 }
    } finally { await ctx.goOffline(false) }
  })

  await check('desktop.podcast-progress-resume', async () => {
    await pause(); await fixture.reset()
    const show = fixture.media.rss
    await ctx.fillSearch('Podcasts', show.query)
    await tap(`[aria-label="Resultados de pódcasts"] .card button.hit[aria-label="${show.showTitle}"]`)
    await page.locator('.episodes .episode-play').first().waitFor()
    await tap('.episodes li:nth-child(1) .episode-play')
    const before = await playing({ title: show.episodes[0].title })
    assert.ok(before.selectedId >= 750_000_000_000_000)
    assert.ok(before.audio.some(audio => !audio.paused && audio.duration >= 89))
    await seek(.1); await wait(() => window.__qaAudio.instances.some(audio => !audio.seeking && audio.currentTime >= 8))
    await pause()
    const position = await page.evaluate(async id => {
      const db = await new Promise(resolve => { const request = indexedDB.open('pletina-web-library'); request.onsuccess = () => resolve(request.result) })
      try { return await new Promise(resolve => { const request = db.transaction('progress').objectStore('progress').get(id); request.onsuccess = () => resolve(request.result ?? null) }) }
      finally { db.close() }
    }, before.selectedId)
    assert.ok(position?.position >= 8); assert.equal(position.completed, false)
    await page.reload({ waitUntil: 'load' }); await page.locator('.player').waitFor()
    assert.ok((await state()).audio.every(audio => audio.paused), 'Reload must preserve paused intent')
    await tap('.player button[aria-label="Reproducir"]')
    const resumed = await playing({ id: before.selectedId, title: show.episodes[0].title })
    assert.ok(resumed.audio.some(audio => !audio.paused && audio.time >= position.position - .5))
    await pause()
    return { episodeId: before.selectedId, savedPosition: position.position, sameEpisodeAfterReload: true, resumed }
  })
}
