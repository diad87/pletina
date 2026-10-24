// Read the compiled UI and real native Audio; provider data enters through the
// homonym HTTP fixture. No product module, DOM or player command is replaced.
import assert from 'node:assert/strict'

export const SEARCH_HOMONYM_SCENARIO_ID = 'media.search-song-row-starts-selected-audio-and-opens-album-with-one-touch'

export async function runSearchHitTargetScenario(ctx) {
  const { page, fixture } = ctx
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
    const touch = ctx.engine !== 'firefox' && await page.evaluate(() => navigator.maxTouchPoints > 0)
    const tap = async locator => {
      await ctx.settle(); await locator.scrollIntoViewIfNeeded(); await ctx.settle()
      // The shared ctx.tap uses mouse clicks, even in a mobile-layout context.
      // This regression deliberately exercises actual browser touch input.
      if (touch) await locator.tap()
      else await locator.click()
      await ctx.settle()
    }
    const restoreViewport = async () => {
      if (!originalViewport) return
      await page.setViewportSize(originalViewport)
      // WebKit applies matchMedia and Svelte's responsive navigation after the
      // viewport command returns. Wait for that real UI before choosing a tab.
      await page.locator(originalViewport.width <= 720 ? '.bottom-nav' : '.sidebar nav').waitFor({ state: 'visible' })
      await ctx.settle()
    }
    const row = index => page.locator(`.tracks li[data-reorder-index="${index}"]`)
    const wait = (predicate, value) => page.waitForFunction(predicate, value, { timeout: 15000 })
    const snapshot = () => page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem('pletina:web:queue:v1') || 'null')
      const route = history.state?.snapshot?.stack[history.state?.index]
      return { route: route && { name: route.name, id: route.id, query: route.query },
        selectedId: (saved?.manual ?? saved?.queue[saved.order[saved.pos]])?.track.id ?? null,
        title: document.querySelector('.mini .title, .player .info .title')?.textContent.trim() ?? null,
        playingEvents: window.__qaAudio.events.filter(event => event.type === 'playing').length,
        loadstartEvents: window.__qaAudio.events.filter(event => event.type === 'loadstart').length,
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
      const mark = await page.evaluate(() => window.__qaSearchTouchEvents.length)
      await tap(locator)
      await wait(({ title, videoId }) => document.querySelector('.mini .title, .player .info .title')?.textContent.trim() === title &&
        window.__qaAudio.instances.some(audio => !audio.paused && audio.currentTime > .15 && !audio.error &&
          new URL(audio.currentSrc || audio.src, location.href).pathname === '/audio/' + videoId), { title: track.title, videoId: track.videoId })
      const events = await page.evaluate(mark => window.__qaSearchTouchEvents.slice(mark), mark)
      if (touch) {
        assert.ok(events.some(event => event.type === 'touchstart' && event.trusted), 'The row must receive a trusted touchstart')
        assert.ok(events.some(event => event.type === 'pointerdown' && event.pointerType === 'touch' && event.trusted),
          'A narrow viewport with a mouse click cannot satisfy the touch regression')
      }
      const value = await snapshot()
      assert.equal(value.route.name, 'album'); assert.equal(value.route.id, sample.album.id)
      assert.notEqual(await page.evaluate(() => document.querySelector('input[aria-label="Buscar música"]')?.value ?? ''), sample.query,
        'Opening the selected album must leave the search query screen')
      assert.equal(value.selectedId, track.id); assert.equal(value.officialVideo, false)
      assert.equal(value.audios.filter(audio => !audio.paused).length, 1)
      return { hit, events, state: value }
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
    const menuRoute = async (index, label, name, id) => {
      const before = await snapshot()
      if ((page.viewportSize()?.width ?? 0) > 720) await row(index).hover()
      await tap(row(index).locator('button.more'))
      await tap(page.getByRole('menuitem', { name: label, exact: true }))
      return assertNavigationOnly(before, name, id)
    }
    let titleResult, reselectedResult, coverResult, bylineResult, bodyResult, desktopAlbumResult, artistRoute, menuAlbumRoute, cardAlbumRoute, keyboardResult, spaceResult
    try {
      await fixture.reset(); await pause(); await search()
      assert.equal(await page.locator('input[aria-label="Buscar música"]').evaluate(node => document.activeElement === node), true,
        'The first song tap must work with the search input still focused, as in the reported screen')
      await page.evaluate(() => {
        window.__qaSearchTouchEvents = []
        const record = event => {
          const target = event.target instanceof Element ? event.target : null
          window.__qaSearchTouchEvents.push({ type: event.type, trusted: event.isTrusted, pointerType: event.pointerType ?? null,
            rowIndex: target?.closest('li[data-reorder-index]')?.getAttribute('data-reorder-index') ?? null })
        }
        const types = ['touchstart', 'pointerdown', 'click']
        for (const type of types) document.addEventListener(type, record, { capture: true, passive: true })
        window.__qaStopSearchTouchEvents = () => { for (const type of types) document.removeEventListener(type, record, true) }
      })
      titleResult = await playFrom(row(0).locator('.name'), first, 0)
      await search()
      const beforeReselect = await snapshot(), playingBeforeReselect = beforeReselect.audios.find(audio => !audio.paused)
      assert.ok(playingBeforeReselect, 'The current song must still be playing when selected again from Search')
      assert.equal(beforeReselect.selectedId, first.id, 'The long dedicated audio fixture must not finish before its reselection')
      assert.equal(playingBeforeReselect.path, '/audio/' + first.videoId)
      reselectedResult = await playFrom(row(0).locator('.artist-name'), first, 0)
      const playingAfterReselect = reselectedResult.state.audios.find(audio => !audio.paused)
      assert.equal(reselectedResult.state.loadstartEvents, beforeReselect.loadstartEvents,
        'Reselecting the playing song must not reload or restart its audio resource')
      assert.equal(playingAfterReselect.index, playingBeforeReselect.index)
      assert.equal(playingAfterReselect.path, playingBeforeReselect.path)
      assert.ok(playingAfterReselect.time >= playingBeforeReselect.time, 'Reselecting the current song must keep its position advancing')
      await pause(); await search()
      await playFrom(row(1).locator('.name'), second, 1); await pause()
      await search()
      coverResult = await playFrom(row(0).locator('.thumb'), first, 0)
      assert.equal(coverResult.state.audios.length, titleResult.state.audios.length)
      assert.equal(coverResult.state.audios.find(audio => !audio.paused).index, titleResult.state.audios.find(audio => !audio.paused).index)
      await pause(); await search()
      assert.equal(await row(1).locator('.by button').count(), 0, 'PWA song metadata must not contain an implicit artist navigation button')
      bylineResult = await playFrom(row(1).locator('.artist-name'), second, 1)
      await pause(); await search()
      bodyResult = await playFrom(row(0).locator('.main'), first, 0)
      await pause(); await search()
      const menuBefore = await snapshot()
      await tap(row(1).locator('button.more'))
      const menuOpen = await snapshot()
      assert.equal(menuOpen.route.name, 'search'); assert.equal(menuOpen.selectedId, menuBefore.selectedId)
      assert.equal(menuOpen.playingEvents, menuBefore.playingEvents)
      assert.ok(menuOpen.audios.every(audio => audio.paused), 'Opening the row menu must not start playback')
      await page.keyboard.press('Escape'); await ctx.settle()
      await row(1).locator('button.more').focus(); await page.keyboard.press('Enter')
      await page.getByRole('menuitem', { name: 'Ir al artista', exact: true }).waitFor()
      const keyboardMenuOpen = await snapshot()
      assert.equal(keyboardMenuOpen.route.name, 'search'); assert.equal(keyboardMenuOpen.selectedId, menuBefore.selectedId)
      assert.equal(keyboardMenuOpen.playingEvents, menuBefore.playingEvents)
      assert.ok(keyboardMenuOpen.audios.every(audio => audio.paused), 'Enter on the menu button must not bubble into song playback')
      await page.keyboard.press('Escape'); await ctx.settle()
      artistRoute = await menuRoute(0, 'Ir al artista', 'artist', sample.artist.id)
      await search()
      await page.setViewportSize({ width: 1100, height: originalViewport?.height ?? 844 })
      await row(0).locator('.album .album-name').waitFor({ state: 'visible' })
      assert.equal(await row(0).locator('.album button').count(), 0, 'The visible PWA album text must also be song-row content')
      desktopAlbumResult = await playFrom(row(0).locator('.album .album-name'), first, 0)
      await pause(); await search()
      await row(1).hover()
      const heartBefore = await snapshot()
      await row(1).locator('button.heart').focus(); await page.keyboard.press('Enter')
      const heartAfter = await snapshot()
      assert.equal(heartAfter.route.name, 'search'); assert.equal(heartAfter.selectedId, heartBefore.selectedId)
      assert.equal(heartAfter.playingEvents, heartBefore.playingEvents)
      assert.ok(heartAfter.audios.every(audio => audio.paused), 'Liking a song must not start it or open its album')
      await row(1).locator('button.heart').focus(); await page.keyboard.press('Space')
      const heartRestored = await snapshot()
      assert.equal(heartRestored.route.name, 'search'); assert.equal(heartRestored.selectedId, heartBefore.selectedId)
      assert.equal(heartRestored.playingEvents, heartBefore.playingEvents)
      menuAlbumRoute = await menuRoute(1, 'Ir al disco', 'album', sample.album.id)
      await restoreViewport()
      await search()
      await row(1).locator('.row').focus(); await page.keyboard.press('Enter')
      await wait(({ videoId, albumId }) => {
        const route = history.state?.snapshot?.stack[history.state?.index]
        return route?.name === 'album' && route.id === albumId && window.__qaAudio.instances.some(audio =>
          !audio.paused && audio.currentTime > .15 && !audio.error && new URL(audio.currentSrc || audio.src, location.href).pathname === '/audio/' + videoId)
      }, { videoId: second.videoId, albumId: sample.album.id })
      keyboardResult = await snapshot()
      assert.equal(keyboardResult.selectedId, second.id)
      await pause(); await search()
      await row(0).locator('.row').focus(); await page.keyboard.press('Space')
      await wait(({ videoId, albumId }) => {
        const route = history.state?.snapshot?.stack[history.state?.index]
        return route?.name === 'album' && route.id === albumId && window.__qaAudio.instances.some(audio =>
          !audio.paused && audio.currentTime > .15 && !audio.error && new URL(audio.currentSrc || audio.src, location.href).pathname === '/audio/' + videoId)
      }, { videoId: first.videoId, albumId: sample.album.id })
      spaceResult = await snapshot()
      assert.equal(spaceResult.selectedId, first.id)
      await pause(); await search()
      const before = await snapshot()
      await tap(page.locator('.grid').getByRole('button', { name: sample.album.title, exact: true }))
      cardAlbumRoute = await assertNavigationOnly(before, 'album', sample.album.id)
      return { homonymousTitle: first.title, songId: first.id, albumId: sample.album.id, artistId: sample.artist.id,
        input: touch ? 'trusted touch via locator.tap' : ctx.engine === 'firefox' ? 'mouse; Firefox touch emulation is unsupported' : 'mouse in desktop profile',
        titleHit: titleResult.hit, coverHit: coverResult.hit, bylineHit: bylineResult.hit, rowBodyHit: bodyResult.hit, desktopAlbumHit: desktopAlbumResult.hit,
        titleInputEvents: titleResult.events, songTargetsStartedAudioAndOpenedAlbum: true, samePlaybackAudio: true,
        currentPlayingReselectionKeptSourceAndPosition: true, reselectionInputEvents: reselectedResult.events,
        titleAndCoverStartedWithoutSecondPlayGesture: true, explicitArtistRoute: artistRoute,
        bylineAndAlbumTextPlayedTheirSong: true, menuAndHeartDidNotPlayOrOpenAlbum: true, keyboardMenuAndHeartWereIsolated: true,
        keyboardEnterSelectedId: keyboardResult.selectedId, keyboardSpaceSelectedId: spaceResult.selectedId,
        explicitAlbumMenuRoute: menuAlbumRoute, explicitAlbumCardRoute: cardAlbumRoute,
        fixtureOnly: true, hardTrackAvailabilityClaimed: false, reportedUserTapCauseReproduced: false,
        scope: 'Controlled homonymous song/album in the compiled PWA. Touch-enabled Chrome/WebKit use trusted touch with search focused; a song-row title, cover, byline, body or desktop album text starts that exact song and opens its album in one gesture. Context menu and heart remain separate actions, and Enter starts the focused song. Physical Android keyboard behavior and real recording availability are separate checks.' }
    } finally {
      await page.evaluate(() => { window.__qaStopSearchTouchEvents?.(); delete window.__qaStopSearchTouchEvents; delete window.__qaSearchTouchEvents }).catch(() => {})
      await restoreViewport()
      await pause(); await fixture.reset()
    }
  })
}
