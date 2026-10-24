// Read the compiled UI and real native Audio; provider data enters through the
// homonym HTTP fixture. No product module, DOM or player command is replaced.
import assert from 'node:assert/strict'

export const SEARCH_HOMONYM_SCENARIO_ID = 'media.search-homonym-title-and-cover-play-while-explicit-targets-navigate'

export async function runSearchHitTargetScenario(ctx) {
  const { page, fixture, tap } = ctx
  return ctx.check(SEARCH_HOMONYM_SCENARIO_ID, async () => {
    const sample = fixture.media.searchHomonyms
    assert.ok(sample?.query && sample.tracks?.length >= 2 && sample.album && sample.artist,
      'Search hit targets require the dedicated song/album homonym HTTP fixture')
    const [first, second] = sample.tracks
    assert.equal(first.title, sample.album.title, 'The song and album must really share the displayed title')
    assert.notEqual(first.id, second.id); assert.notEqual(first.title, second.title)
    for (const track of [first, second]) {
      assert.equal(track.album.id, sample.album.id); assert.equal(track.artist.id, sample.artist.id)
    }
    const originalViewport = page.viewportSize()
    const row = index => page.locator(`.tracks li[data-reorder-index="${index}"]`)
    const wait = (predicate, value) => page.waitForFunction(predicate, value, { timeout: 15000 })
    const snapshot = () => page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem('pletina:web:queue:v1') || 'null')
      const route = history.state?.snapshot?.stack[history.state?.index]
      return { route: route && { name: route.name, id: route.id, query: route.query },
        selectedId: (saved?.manual ?? saved?.queue[saved.order[saved.pos]])?.track.id ?? null,
        title: document.querySelector('.mini .title, .player .info .title')?.textContent.trim() ?? null,
        playingEvents: window.__qaAudio.events.filter(event => event.type === 'playing').length,
        audios: window.__qaAudio.instances.map((audio, index) => ({ index, paused: audio.paused, time: audio.currentTime,
          error: audio.error?.code ?? null, path: audio.src ? new URL(audio.currentSrc || audio.src, location.href).pathname : null })),
        officialVideo: Boolean(document.querySelector('dialog[data-official-youtube][open]')) }
    })
    const pause = async () => {
      const button = page.locator('.mini button[aria-label="Pausa"], .player button[title="Pausa (espacio)"]').first()
      if (await button.isVisible().catch(() => false)) await tap(button)
      await wait(() => window.__qaAudio.instances.every(audio => audio.paused))
    }
    const search = async () => {
      await ctx.fillSearch('Buscar', sample.query)
      await wait(titles => !document.querySelector('.stale') && titles.every((title, index) =>
        document.querySelector(`.tracks li[data-reorder-index="${index}"] .name`)?.textContent.trim() === title), [first.title, second.title])
      const route = (await snapshot()).route
      assert.equal(route.name, 'search'); assert.equal(route.query, sample.query)
      await page.locator('.grid').getByRole('button', { name: sample.album.title, exact: true }).waitFor()
    }
    const hitTarget = async locator => {
      await locator.scrollIntoViewIfNeeded()
      return locator.evaluate(node => {
        const box = node.getBoundingClientRect(), target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
        return { width: box.width, height: box.height, targetIsInside: Boolean(target && node.contains(target)),
          rowIndex: target?.closest('li[data-reorder-index]')?.getAttribute('data-reorder-index') ?? null,
          albumCard: Boolean(target?.closest('.card')), buttonClass: target?.closest('button')?.className ?? null }
      })
    }
    const playFrom = async (locator, track, expectedIndex) => {
      const hit = await hitTarget(locator)
      assert.ok(hit.width > 0 && hit.height > 0 && hit.targetIsInside)
      assert.equal(hit.rowIndex, String(expectedIndex)); assert.equal(hit.albumCard, false,
        'The song title/cover hit target cannot be an overlapping album card')
      await tap(locator)
      await wait(({ title, videoId }) => document.querySelector('.mini .title, .player .info .title')?.textContent.trim() === title &&
        window.__qaAudio.instances.some(audio => !audio.paused && audio.currentTime > .15 && !audio.error &&
          new URL(audio.currentSrc || audio.src, location.href).pathname === '/audio/' + videoId), { title: track.title, videoId: track.videoId })
      const value = await snapshot()
      assert.equal(value.route.name, 'search'); assert.equal(value.route.query, sample.query)
      assert.equal(value.selectedId, track.id); assert.equal(value.officialVideo, false)
      assert.equal(value.audios.filter(audio => !audio.paused).length, 1)
      return { hit, state: value }
    }
    const assertNavigationOnly = async (before, name, id) => {
      await wait(({ name, id }) => {
        const route = history.state?.snapshot?.stack[history.state?.index]
        return route?.name === name && route.id === id
      }, { name, id })
      const value = await snapshot()
      assert.equal(value.selectedId, before.selectedId); assert.equal(value.playingEvents, before.playingEvents)
      assert.ok(value.audios.every(audio => audio.paused), 'Explicit metadata navigation cannot start or resume audio')
      return value.route
    }
    let titleResult, coverResult, artistRoute, desktopAlbumRoute, cardAlbumRoute
    try {
      await fixture.reset(); await pause(); await search()
      titleResult = await playFrom(row(0).locator('.name'), first, 0)
      await pause()
      await playFrom(row(1).locator('.name'), second, 1); await pause()
      coverResult = await playFrom(row(0).locator('.thumb'), first, 0)
      assert.equal(coverResult.state.audios.length, titleResult.state.audios.length)
      assert.equal(coverResult.state.audios.find(audio => !audio.paused).index, titleResult.state.audios.find(audio => !audio.paused).index)
      await pause()
      let before = await snapshot()
      await tap(row(0).locator('.artist-name'))
      artistRoute = await assertNavigationOnly(before, 'artist', sample.artist.id)
      await search()
      await page.setViewportSize({ width: 1100, height: originalViewport?.height ?? 844 })
      await row(0).locator('.album .link').waitFor({ state: 'visible' })
      before = await snapshot()
      await tap(row(0).locator('.album .link'))
      desktopAlbumRoute = await assertNavigationOnly(before, 'album', sample.album.id)
      if (originalViewport) await page.setViewportSize(originalViewport)
      await search()
      before = await snapshot()
      await tap(page.locator('.grid').getByRole('button', { name: sample.album.title, exact: true }))
      cardAlbumRoute = await assertNavigationOnly(before, 'album', sample.album.id)
      return { homonymousTitle: first.title, songId: first.id, albumId: sample.album.id, artistId: sample.artist.id,
        titleHit: titleResult.hit, coverHit: coverResult.hit, songTargetsKeptSearch: true, samePlaybackAudio: true,
        titleAndCoverStartedWithoutSecondPlayGesture: true, explicitArtistRoute: artistRoute,
        explicitDesktopAlbumRoute: desktopAlbumRoute, explicitAlbumCardRoute: cardAlbumRoute,
        fixtureOnly: true, hardTrackAvailabilityClaimed: false, reportedUserTapCauseReproduced: false,
        scope: 'Controlled homonymous song/album and actual title/cover hit testing in the compiled UI; explicit artist/card/desktop album links retain navigation. No claim about the unavailable real Ni Ni Ni recording or the user exact tap.' }
    } finally {
      if (originalViewport) await page.setViewportSize(originalViewport)
      await pause(); await fixture.reset()
    }
  })
}
