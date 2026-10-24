// UI scenarios against the compiled application. Provider fixtures enter through HTTP
// responses; these tests never replace application modules or expose product globals.
import assert from 'node:assert/strict'
import { runPodcastRecoveryScenario } from './podcast-recovery-scenario.mjs'

export const libraryScenarioInventory = [
  { id: 'library.navigation', actions: ['four mobile tabs', 'browser Back/Forward', 'query replacement', 'reload', 'viewport bounds'] },
  { id: 'library.discovery', actions: ['discovery cards', 'artist detail', 'album detail', 'recently viewed navigation', 'pinned tile navigation', 'unpin on Home'] },
  { id: 'library.search', actions: ['songs/artists/albums', 'song row starts selected song and opens album', 'artist menu opens detail without playback', 'natural title de artist fallback', 'expand/collapse tracks', 'empty results', 'partial-provider retry', 'artist discography filters'] },
  { id: 'library.favorites', actions: ['save/remove artist', 'save/remove album', 'like/filter/unlike song'] },
  { id: 'library.playlists', actions: ['create empty/from track menu', 'rename/cancel', 'pin/unpin', 'append album', 'duplicates', 'filter/clear', 'reorder', 'remove entry', 'delete/cancel'] },
  { id: 'library.csv', actions: ['invalid/oversized file', 'provider failure', 'retry/cancel', 'cancel pending catalog response', 'navigate away during pending match', 'ignore obsolete matches without saving', 'all omitted', 'empty name', 'review matches/omissions', 'transaction abort rollback and retry', 'save duplicate entries', 'reload'] },
  { id: 'library.spotify', actions: ['anonymous guest token and persisted-query metadata HTTP contracts', 'public URL review without writes', 'save order and duplicates', 'reload', 'explicit provider 403 explains CSV fallback', 'cancel held token/metadata responses', 'leave during metadata read without ghost creation'] },
  { id: 'library.youtube', actions: ['reject invalid link', 'preview/change link', 'edit/validate metadata', 'save/update without duplicate', 'remove saved link', 'edited metadata survives old player copies in favorites/queue/history/downloads without transferring audio again'] },
  { id: 'library.source-picker', actions: ['choose listed candidate', 'invalid link', 'manual choice', 'remember choice', 'native dialog close'] },
  { id: 'library.podcasts', actions: ['RSS and YouTube search', 'language filters', 'episode detail', 'save/remove show', 'reload persistence', 'total feed failure/error/retry/genuine empty'] },
  { id: 'library.history', actions: ['empty history', 'recorded history after media scenarios', 'cancel clear', 'clear and reload'] },
]

function ui(ctx) {
  const { page } = ctx
  const settle = () => page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    await Promise.all((document.querySelector('.view')?.getAnimations() ?? []).map(a => a.finished.catch(() => {})))
  })
  const tap = async (selector) => { await settle(); await ctx.tap(selector) }
  const text = async (selector, label, exact = true) => { await settle(); await ctx.clickText(selector, label, exact) }
  const wait = (fn, value, timeout = 15000) => page.waitForFunction(fn, value, { timeout })
  const mobile = async () => await page.locator('.bottom-nav').count() > 0
  const tab = async (label) => {
    if (await mobile()) await text('.bottom-nav button', label)
    else if (label !== 'Tu biblioteca') await text('.sidebar nav button', label)
    await settle()
  }
  const library = async (label) => {
    await tab('Tu biblioteca')
    await text('.items .item', label, false)
    await settle()
  }
  const fill = async (selector, value) => { await settle(); await page.locator(selector).fill(value); await settle() }
  const search = async (query) => {
    await tab('Buscar'); await fill('input[aria-label="Buscar música"]', query)
    if (query) await page.locator('ol.tracks > li[data-reorder-index]').first().waitFor()
    await settle()
  }
  const rows = () => page.locator('ol.tracks > li[data-reorder-index]')
  const titles = () => rows().locator('.name').allTextContents()
  const rowMenu = async (index = 0) => {
    const row = rows().nth(index)
    if (!await mobile()) await row.hover()
    await tap(`ol.tracks > li[data-reorder-index="${await row.getAttribute('data-reorder-index')}"] button.more`)
    await page.locator('[role="menu"]').first().waitFor()
  }
  const menu = (label) => text('[role="menuitem"]', label)
  const addToPlaylist = async (name) => {
    if (await mobile()) await menu('Añadir a playlist')
    else await page.getByRole('menuitem', { name: 'Añadir a playlist', exact: true }).hover()
    await menu(name)
  }
  const rename = async (name) => {
    await page.locator('input[aria-label="Nombre de la playlist"]').waitFor()
    await fill('input[aria-label="Nombre de la playlist"]', name)
    await page.locator('input[aria-label="Nombre de la playlist"]').press('Enter')
    await wait(name => document.querySelector('.hero h1')?.textContent.trim() === name, name)
  }
  return { settle, tap, text, wait, mobile, tab, library, fill, search, rows, titles, rowMenu, menu, addToPlaylist, rename }
}

// Inspect the real database without creating a schema or changing product data.
// The report contains only the unchanged assertion and row counts, never rows.
async function readLibraryState(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const opening = indexedDB.open('pletina-web-library')
    opening.onupgradeneeded = () => opening.transaction.abort()
    opening.onerror = () => reject(opening.error)
    opening.onsuccess = () => {
      const db = opening.result, stores = ['tracks', 'playlists', 'entries', 'meta'], rows = {}
      const tx = db.transaction(stores, 'readonly')
      tx.oncomplete = () => { db.close(); resolve(rows) }
      tx.onabort = () => { db.close(); reject(tx.error || new Error('Library inspection aborted.')) }
      for (const store of stores) {
        const request = tx.objectStore(store).getAll()
        request.onsuccess = () => { rows[store] = request.result }
      }
    }
  }))
}

export async function runLibraryScenarios(ctx) {
  const { page, fixture, check } = ctx
  const u = ui(ctx)
  const tracks = fixture.data?.tracks ?? fixture.tracks
  const artists = fixture.data?.artists ?? fixture.artists
  const albums = fixture.data?.albums ?? fixture.albums
  assert.ok(tracks?.length >= 9 && albums?.length >= 3 && artists?.length >= 2, 'Library scenarios require the agreed provider fixtures')
  const first = tracks[0], second = tracks[1], third = tracks[2]
  const artistName = artists[0].name
  const albumTitle = albums[0].title
  const query = fixture.media.query
  const playlistName = 'E2E Biblioteca'
  const renamedPlaylist = 'E2E Biblioteca Renombrada'
  const importedName = 'E2E CSV Duplicados'
  const trackArtist = first.artist?.name ?? first.artistName ?? artistName
  const currentRoute = () => page.evaluate(() => history.state?.snapshot?.stack[history.state.index]?.name)

  await check('library.navigation: four tabs, browser history, reload and viewport', async () => {
    if (!await page.locator('.app').count()) {
      if (!await page.locator('#open-player').count()) await page.goto(ctx.baseURL, { waitUntil: 'load' })
      await Promise.all([page.waitForURL(url => url.pathname.includes('/application/')), u.tap('#open-player')])
    }
    await page.locator('.app').waitFor()
    if (await u.mobile()) {
      assert.deepEqual(await page.locator('.bottom-nav button').allTextContents().then(xs => xs.map(x => x.trim())), ['Inicio', 'Buscar', 'Podcasts', 'Tu biblioteca'])
    } else {
      assert.deepEqual(await page.locator('.sidebar nav button').allTextContents().then(xs => xs.map(x => x.trim())), ['Inicio', 'Buscar', 'Podcasts'])
    }
    await u.tab('Inicio')
    const url = page.url()
    await u.search(query)
    await page.evaluate(() => history.back())
    await page.locator('.greeting').waitFor()
    assert.equal(page.url(), url)
    await page.evaluate(() => history.forward())
    await u.wait(q => document.querySelector('input[aria-label="Buscar música"]')?.value === q, query)
    await page.reload({ waitUntil: 'load' })
    await u.wait(q => document.querySelector('input[aria-label="Buscar música"]')?.value === q, query)
    await page.evaluate(() => history.back())
    await page.locator('.greeting').waitFor()
    const size = await page.evaluate(() => {
      const rect = document.querySelector('.bottom-nav')?.getBoundingClientRect()
      return { width: innerWidth, document: document.documentElement.scrollWidth, height: innerHeight,
        bottom: rect?.bottom ?? null, navHeight: rect?.height ?? null }
    })
    assert.ok(size.document <= size.width + 1)
    if (size.bottom !== null) assert.ok(size.navHeight > 0 && size.bottom <= size.height + 1)
    return { sameURL: true, restoredQuery: true, viewport: size }
  })

  await check('library.discovery: home cards and empty history', async () => {
    await u.tab('Inicio')
    assert.equal(await page.locator('button.surprise').isDisabled(), true)
    await page.locator('.recommendations[aria-busy="false"] .card .hit').first().waitFor()
    assert.ok(await page.locator('.recommendations .card .hit').count() >= 2)
    await u.library('Historial')
    assert.match(await page.locator('.empty-state').textContent(), /Aún no has escuchado nada/)
    return { discoveryCards: true, initiallyEmptyHistory: true }
  })

  await check('library.search: tracks, artists, albums and expanded results', async () => {
    await u.search(query)
    assert.equal(await u.rows().count(), 8)
    assert.equal((await u.titles())[0].trim(), first.title)
    await u.text('button.more', 'Ver más', false)
    assert.equal(await u.rows().count(), tracks.length)
    await u.text('button.more', 'Ver menos')
    assert.equal(await u.rows().count(), 8)
    assert.equal(await page.locator('.top-result .top-name').textContent(), artistName)
    assert.ok(await page.locator('.grid .card .hit').count() >= albums.length)
    const pauseButton = page.locator('.mini button[aria-label="Pausa"], .player button[title="Pausa (espacio)"]').first()
    const playbackState = () => page.evaluate(() => {
      const queue = JSON.parse(localStorage.getItem('pletina:web:queue:v1') || 'null')
      return { selectedId: queue?.queue[queue.order[queue.pos]]?.track.id ?? null,
        audios: window.__qaAudio.instances.map(audio => ({ paused: audio.paused, time: audio.currentTime, duration: audio.duration, error: audio.error?.code ?? null })),
        playingEvents: window.__qaAudio.events.filter(event => event.type === 'playing').length,
        title: document.querySelector('.mini .title, .player .info .title')?.textContent.trim() }
    })
    let selected, afterArtist
    try {
      await u.tap(u.rows().first().locator('.name'))
      await u.wait(() => window.__qaAudio.instances.some(audio => !audio.paused && audio.currentTime > .15 && !audio.error))
      await pauseButton.waitFor()
      await u.tap(pauseButton)
      await u.wait(() => window.__qaAudio.instances.every(audio => audio.paused))
      selected = await playbackState()
      assert.equal(await currentRoute(), 'album')
      assert.equal(selected.selectedId, first.id)
      assert.equal(selected.title, first.title)
      assert.ok(selected.audios.some(audio => audio.time > 0 && audio.duration > 0 && audio.time < Math.min(30, audio.duration / 2)),
        'Pause before the product records this short playback in history')
      const playingEvents = selected.playingEvents
      // Search song rows now both play and open their album. Navigation alone
      // remains an explicit menu action; it must not change the paused song.
      await u.search(query)
      await u.rowMenu(1); await u.menu('Ir al artista')
      await u.wait(name => document.querySelector('.banner h1')?.textContent === name, trackArtist)
      assert.equal(await currentRoute(), 'artist')
      afterArtist = await playbackState()
      assert.equal(afterArtist.selectedId, first.id)
      assert.equal(afterArtist.title, first.title)
      assert.equal(afterArtist.playingEvents, playingEvents)
      assert.ok(afterArtist.audios.every(audio => audio.paused), 'Artist navigation must not play or resume a song')
      await u.library('Historial')
      assert.match(await page.locator('.empty-state').textContent(), /Aún no has escuchado nada/)
      await u.search(query)
    } finally {
      if (await pauseButton.isVisible().catch(() => false)) await u.tap(pauseButton)
    }
    return { tracks: tracks.length, artists: artists.length, albums: albums.length,
      titleStartedTrackId: selected.selectedId, titleOpenedSelectedAlbum: true, artistMenuOpenedWithoutPlayback: true,
      pausedBeforeHistoryThreshold: true, historyRemainedEmpty: true, audioAfterArtist: afterArtist.audios }
  })

  await check('library.search: natural song de artist retries the empty literal query', async () => {
    const requests = () => fixture.requests.filter(request => request.host === 'api.deezer.com' && request.path === '/search/track').length
    const before = requests()
    const natural = `${first.title} de ${trackArtist}`
    await u.tab('Buscar'); await u.fill('input[aria-label="Buscar música"]', natural)
    await u.wait(title => {
      const rows = document.querySelectorAll('ol.tracks > li[data-reorder-index]')
      return rows.length === 1 && rows[0].querySelector('.name')?.textContent.trim() === title && !document.querySelector('.stale')
    }, first.title)
    const delta = requests() - before
    assert.ok(delta >= 2, 'The empty literal query and normalized retry must both pass through provider HTTP fixtures')
    assert.equal((await u.titles())[0].trim(), first.title)
    await u.tap('.top-result')
    await u.wait(name => document.querySelector('.banner h1')?.textContent === name, artistName)
    await u.search(query)
    return { naturalQuery: natural, selectedTrackId: first.id, title: first.title, interceptedTrackRequests: delta, artistOpenedWithoutPlayback: true }
  })

  await check('library.search: empty results and partial-provider retry remain explicit', async () => {
    await u.tab('Buscar'); await u.fill('input[aria-label="Buscar música"]', 'zzzz inexistente')
    await u.wait(() => document.querySelector('.empty-state strong')?.textContent.includes('No hay resultados'))
    fixture.failNext('/search/artist')
    await u.fill('input[aria-label="Buscar música"]', query)
    await page.locator('.partial-error').waitFor()
    assert.ok(await u.rows().count() > 0, 'A failed artist section must not hide available songs')
    await u.text('.partial-error button', 'Reintentar')
    await page.locator('.partial-error').waitFor({ state: 'detached' })
    await page.locator('.top-result').waitFor()
    return { emptyState: true, partialResultsUsable: true, retriedFailedSection: true }
  })

  await check('library.artist: detail, favorites and discography filters', async () => {
    await u.search(query); await u.tap('.top-result')
    await u.wait(name => document.querySelector('.banner h1')?.textContent === name, artistName)
    await u.tap('button.favorite[title="Añadir a artistas favoritos"]')
    await page.locator('button.favorite[aria-pressed="true"]:not(:disabled)').waitFor()
    const chips = await page.locator('.chips button').allTextContents()
    assert.equal(await u.rows().count(), 5)
    await u.text('button.more', 'Mostrar más')
    assert.equal(await u.rows().count(), 8)
    await u.text('button.more', 'Mostrar menos')
    assert.equal(await u.rows().count(), 5)
    assert.ok(chips.some(label => label.includes('Álbumes')))
    assert.ok(chips.some(label => label.includes('Sencillos y EP')))
    await u.text('.chips button', 'Sencillos y EP', false)
    assert.equal(await page.locator('.grid .hit').count(), 1)
    await u.text('.chips button', 'Todo')
    assert.equal(await page.locator('.grid .hit').count(), 2)
    return { artist: artistName, favorite: true, filters: chips.map(x => x.trim()) }
  })

  const albumReady = await check('library.album: detail, save, pin and library persistence', async () => {
    await u.search(query); await u.tap(`.grid .hit[aria-label=${JSON.stringify(albumTitle)}]`)
    await u.wait(title => document.querySelector('.hero h1')?.textContent === title, albumTitle)
    assert.equal(await u.rows().count(), 4)
    await u.tap('button[title="Guardar en tu biblioteca"]')
    await page.locator('button[title="Quitar de tu biblioteca"]').waitFor()
    await u.tap('button[aria-label="Fijar en Inicio"]')
    await page.locator('button[aria-label="Desfijar de Inicio"][aria-pressed="true"]').waitFor()
    await u.tab('Inicio')
    await page.locator(`.tile-pin[aria-label=${JSON.stringify('Desfijar de Inicio: ' + albumTitle)}]`).waitFor()
    await page.reload({ waitUntil: 'load' })
    await page.locator(`.tile-pin[aria-label=${JSON.stringify('Desfijar de Inicio: ' + albumTitle)}]`).waitFor()
    await u.library(albumTitle)
    await page.locator('button[title="Quitar de tu biblioteca"]').waitFor()
    return { album: albumTitle, tracks: 4, savedAndPinnedAcrossReload: true }
  })

  await check('library.home-and-menus: song destinations, recent cards and direct unpin', async () => {
    if (!albumReady) return { status: 'blocked', reason: 'The preceding saved album/pin prerequisite failed.' }
    await u.search(query); await u.rowMenu(0); await u.menu('Ir al artista')
    await u.wait(name => document.querySelector('.banner h1')?.textContent === name, artistName)
    await page.evaluate(() => history.back())
    await u.wait(() => history.state?.snapshot?.stack[history.state.index]?.name === 'search')
    await u.rows().first().waitFor()
    await u.rowMenu(0); await u.menu('Ir al disco')
    await u.wait(title => document.querySelector('.hero h1')?.textContent === title, albumTitle)
    await page.evaluate(() => history.back())
    await u.wait(() => history.state?.snapshot?.stack[history.state.index]?.name === 'search')
    await u.rows().first().waitFor()
    await u.rowMenu(0); await page.evaluate(() => history.back())
    await page.locator('[role="menu"]').waitFor({ state: 'detached' })
    assert.equal(await currentRoute(), 'search')
    await u.tab('Inicio')
    assert.equal(await page.locator('button.surprise').isDisabled(), false)
    await u.tap(`.tile-hit[title=${JSON.stringify(albumTitle)}]`)
    await u.wait(title => document.querySelector('.hero h1')?.textContent === title, albumTitle)
    await u.tab('Inicio')
    const recents = page.locator('.shelf').filter({ has: page.getByRole('heading', { name: 'Visto recientemente', exact: true }) })
    const recentArtist = recents.locator(`.hit[aria-label=${JSON.stringify(artistName)}]`)
    await recentArtist.waitFor(); await ctx.tap(recentArtist)
    await u.wait(name => document.querySelector('.banner h1')?.textContent === name, artistName)
    await u.tab('Inicio')
    await u.tap(`.tile-pin[aria-label=${JSON.stringify('Desfijar de Inicio: ' + albumTitle)}]`)
    assert.equal(await page.locator(`.tile-pin[aria-label=${JSON.stringify('Desfijar de Inicio: ' + albumTitle)}]`).count(), 0)
    // Restore the original saved/pinned prerequisite for the later removal scenario.
    await u.library(albumTitle); await u.tap('button[aria-label="Fijar en Inicio"]')
    await page.locator('button[aria-label="Desfijar de Inicio"][aria-pressed="true"]').waitFor()
    return { menuBackClosedOnlyOverlay: true, songArtistAndAlbumNavigation: true, pinnedTileAndRecentArtistOpened: true,
      directHomeUnpin: true, surpriseEnabledOnlyWithSavedAlbum: true }
  })

  await check('library.favorites: like, search, clear and remove one song', async () => {
    await u.search(query)
    for (const index of [0, 1]) { await u.rowMenu(index); await u.menu('Añadir a Canciones que te gustan') }
    await u.library('Canciones que te gustan')
    await u.wait(() => document.querySelectorAll('ol.tracks > li[data-reorder-index]').length === 2)
    await u.fill('input[aria-label="Buscar en Canciones que te gustan"]', 'cancion dos')
    assert.equal(await u.rows().count(), 1)
    assert.equal((await u.titles())[0].trim(), second.title)
    await u.tap('button[aria-label="Limpiar búsqueda"]')
    assert.equal(await u.rows().count(), 2)
    const before = await u.titles()
    await u.rowMenu(0); await u.menu('Quitar de Canciones que te gustan')
    await u.wait(() => document.querySelectorAll('ol.tracks > li[data-reorder-index]').length === 1)
    const remaining = (await u.titles())[0].trim()
    assert.notEqual(remaining, before[0].trim())
    return { accentInsensitiveSearch: true, removedOnlyOne: true, remaining }
  })

  const playlistCreated = await check('library.playlists: create, rename/cancel and pin', async () => {
    await u.tab('Tu biblioteca'); await u.tap('[title="Crear playlist"]')
    await u.rename(playlistName)
    await u.tap('.hero button[title="Cambiar nombre"]')
    await u.fill('input[aria-label="Nombre de la playlist"]', 'No guardar este nombre')
    await page.locator('input[aria-label="Nombre de la playlist"]').press('Escape')
    assert.equal(await page.locator('.hero h1').textContent(), playlistName)
    await u.tap('.hero button[title="Cambiar nombre"]'); await u.rename(renamedPlaylist)
    await u.tap('button[aria-label="Fijar en Inicio"]')
    await u.tab('Inicio')
    await page.locator(`.tile-pin[aria-label=${JSON.stringify('Desfijar de Inicio: ' + renamedPlaylist)}]`).waitFor()
    return { playlistName: renamedPlaylist, renameCancel: true, pinned: true }
  })

  await check('library.playlists: append album, duplicate entries, filter and reorder', async () => {
    if (!playlistCreated) return { status: 'blocked', reason: 'Playlist creation failed in the preceding UI scenario.' }
    await u.search(query); await u.tap(`.grid .hit[aria-label=${JSON.stringify(albumTitle)}]`)
    await u.rows().first().waitFor()
    await u.tap('.actions button[title="Más opciones"]'); await u.addToPlaylist(renamedPlaylist)
    for (let i = 0; i < 2; i++) { await u.rowMenu(0); await u.addToPlaylist(renamedPlaylist) }
    await u.library(renamedPlaylist)
    await u.wait(() => document.querySelectorAll('ol.tracks > li[data-reorder-index]').length === 6)
    assert.equal((await u.titles()).filter(title => title.trim() === first.title).length, 3)
    await u.fill('input[aria-label="Buscar en esta playlist"]', 'cancion dos')
    assert.equal(await u.rows().count(), 1)
    assert.equal(await page.locator('[data-reorder-handle]').count(), 0)
    if (!await u.mobile()) {
      await u.fill('input[aria-label="Buscar en esta playlist"]', 'cancion qa')
      const filteredOrder = await u.titles()
      const target = await u.rows().nth(1).locator('.row').boundingBox()
      assert.ok(target)
      await u.rows().first().locator('.row').dragTo(u.rows().nth(1).locator('.row'), { targetPosition: { x: 30, y: target.height - 4 } })
      await u.settle()
      assert.deepEqual(await u.titles(), filteredOrder, 'Filtering disables desktop drag reorder as well as mobile handles')
    }
    await page.locator('input[aria-label="Buscar en esta playlist"]').press('Escape')
    await u.wait(() => document.querySelectorAll('ol.tracks > li[data-reorder-index]').length === 6)
    const before = (await u.titles()).map(x => x.trim())
    if (await u.mobile()) {
      await page.locator('[data-reorder-handle]').first().scrollIntoViewIfNeeded()
      await page.evaluate(() => {
        const row = document.querySelector('ol.tracks > li[data-reorder-index]'), content = document.querySelector('.content')
        content.scrollTop += row.getBoundingClientRect().top - content.getBoundingClientRect().top - 90
      })
      await u.settle()
      const from = await page.locator('[data-reorder-handle]').first().boundingBox()
      const to = await u.rows().nth(1).boundingBox()
      assert.ok(from && to)
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
      await page.mouse.down(); await page.mouse.move(from.x + from.width / 2, to.y + to.height * 0.8, { steps: 12 }); await page.mouse.up()
    } else {
      const target = await u.rows().nth(1).locator('.row').boundingBox()
      assert.ok(target)
      await u.rows().first().locator('.row').dragTo(u.rows().nth(1).locator('.row'), { targetPosition: { x: 30, y: target.height - 4 } })
    }
    await u.wait(title => document.querySelector('ol.tracks > li[data-reorder-index] .name')?.textContent.trim() === title, before[1])
    await u.rowMenu(4); await u.menu('Quitar de esta playlist')
    await u.wait(() => document.querySelectorAll('ol.tracks > li[data-reorder-index]').length === 5)
    assert.equal((await u.titles()).filter(title => title.trim() === first.title).length, 2)
    await page.reload({ waitUntil: 'load' })
    await u.wait(() => document.querySelectorAll('ol.tracks > li[data-reorder-index]').length === 5)
    assert.equal((await u.titles())[0].trim(), before[1])
    return { duplicateEntriesIndependent: true, filteredReorderDisabled: true, reorderedAndPersisted: true, remaining: 5 }
  })

  await check('library.spotify: public URL uses the real reader, reviews before writing and saves ordered duplicates', async () => {
    await fixture.set({ spotifyDenied403: false })
    await u.tab('Tu biblioteca'); await u.tap('button.import')
    // A fresh application document also resets any in-memory anonymous token.
    await page.reload({ waitUntil: 'load' }); await page.locator('#spotify-url').waitFor()
    const before = await readLibraryState(page), requestStart = fixture.requests.length
    await u.fill('#spotify-url', fixture.spotify.url)
    assert.match(await page.locator('form .hint').textContent(), /públic|CSV/i)
    assert.doesNotMatch(await page.locator('form .hint').textContent(), /aún no está disponible/i)
    await u.text('form button', 'Buscar canciones')
    await page.locator('#playlist-name').waitFor()
    assert.equal(await page.locator('#playlist-name').inputValue(), fixture.spotify.name)
    assert.deepEqual(await page.locator('.totals strong').allTextContents(), ['3', '1'])
    await u.text('summary', 'Canciones que se guardarán (3)')
    const expectedTitles = [first.title, second.title, first.title]
    assert.deepEqual(await page.locator('.track-details ol li strong').allTextContents(), expectedTitles)
    assert.deepEqual(await readLibraryState(page), before, 'Reading Spotify and reviewing its matches must not create library rows')
    const providerRequests = fixture.requests.slice(requestStart).filter(row => row.spotifyStage)
    assert.equal(providerRequests.filter(row => row.spotifyStage === 'token').length, 1)
    const metadata = providerRequests.filter(row => row.spotifyStage === 'playlist')
    assert.equal(metadata.length, 2)
    assert.deepEqual(metadata.map(row => row.spotifyOffset), [0, 2], 'The reader must follow the explicit nextOffset from both fixture pages')
    assert.ok(metadata.every(row => row.spotifyOperation === 'queryPlaylist' && row.spotifyAuthorizationValid === true && !row.fixtureRejected),
      'Only the anonymous fixture contract may provide playlist metadata')
    const name = 'E2E Spotify Enlace Duplicados'
    await u.fill('#playlist-name', name); await u.text('.actions button', 'Guardar playlist')
    await u.wait(name => document.querySelector('.hero h1')?.textContent.trim() === name, name)
    assert.deepEqual((await u.titles()).map(title => title.trim()), expectedTitles)
    const saved = await readLibraryState(page)
    assert.equal(saved.playlists.length, before.playlists.length + 1)
    const playlist = saved.playlists.find(list => list.name === name)
    assert.ok(playlist)
    assert.equal(saved.entries.filter(entry => entry.playlistId === playlist.id).length, 3)
    await page.reload({ waitUntil: 'load' })
    await u.wait(name => document.querySelector('.hero h1')?.textContent.trim() === name, name)
    assert.deepEqual((await u.titles()).map(title => title.trim()), expectedTitles)
    await u.tap('.actions button[title="Más opciones"]'); await u.menu('Eliminar playlist')
    await u.text('.confirm button', 'Eliminar'); await page.locator('.greeting').waitFor()
    return { anonymousGuestToken: true, realReaderAndMatcher: true, persistedQueryContract: true, explicitNextOffsetPages: [0, 2],
      found: 3, omitted: 1, noWritesBeforeSave: true, orderedDuplicateEntries: true,
      persistedAcrossReload: true, temporaryPlaylistDeleted: true, providerSource: 'Synthetic intercepted HTTP only' }
  })

  for (const stage of ['token', 'playlist']) await check('library.spotify-in-flight: cancelling the held ' + stage + ' response preserves the next review', async () => {
    await u.tab('Tu biblioteca'); await u.tap('button.import')
    await page.reload({ waitUntil: 'load' }); await page.locator('#spotify-url').waitFor()
    const before = await readLibraryState(page), requestStart = fixture.requests.length
    const searches = () => fixture.requests.slice(requestStart).filter(row => row.host === 'api.deezer.com' && row.path === '/search/track').length
    const gate = fixture.holdNextSpotifyRequest(stage)
    const nextName = 'E2E Spotify Cancelada ' + stage
    try {
      await u.fill('#spotify-url', fixture.spotify.url); await u.text('form button', 'Buscar canciones')
      const held = await gate.waitForRequest()
      assert.equal(held.spotifyStage, stage)
      assert.match(await page.locator('.loading [role="status"]').textContent(), /Leyendo tu lista/)
      assert.equal(await page.locator('#playlist-name').count(), 0)
      await u.text('.loading button', 'Cancelar'); await page.locator('#playlist-csv').waitFor()
      const csv = `Track Name,Artist Name(s)\n"${second.title}","${trackArtist}"\n`
      await page.locator('#playlist-csv').setInputFiles({ name: nextName + '.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
      await u.text('details.csv button', 'Buscar canciones del CSV'); await page.locator('#playlist-name').waitFor()
      assert.equal(await page.locator('#playlist-name').inputValue(), nextName)
      gate.release(); await gate.waitForDelivery(); await u.settle()
      assert.equal(await page.locator('#playlist-name').inputValue(), nextName)
      assert.deepEqual(await page.locator('.totals strong').allTextContents(), ['1', '0'])
      assert.equal(await page.locator('[role="alert"]').count(), 0)
      assert.equal(searches(), 1, 'The cancelled Spotify read must never start catalog matching')
      if (stage === 'token') assert.equal(fixture.requests.slice(requestStart).filter(row => row.spotifyStage === 'playlist').length, 0,
        'A cancelled token request must not issue the playlist metadata request')
      assert.deepEqual(await readLibraryState(page), before, 'Cancelling the read and reviewing a replacement must not create a ghost playlist')
      await u.text('.actions button', 'Importar otra lista')
      await page.reload({ waitUntil: 'load' }); await page.locator('#spotify-url').waitFor()
      assert.deepEqual(await readLibraryState(page), before)
      return { heldStage: stage, cancelledBeforeMatching: true, nextReviewPreserved: true,
        noGhostPlaylist: true, noWritesBeforeSave: true, reloadUnchanged: true }
    } finally { gate.release() }
  })

  await check('library.spotify-in-flight: leaving during metadata read ignores the late response and preserves navigation', async () => {
    await u.tab('Tu biblioteca'); await u.tap('button.import')
    await page.reload({ waitUntil: 'load' }); await page.locator('#spotify-url').waitFor()
    const before = await readLibraryState(page), requestStart = fixture.requests.length
    const gate = fixture.holdNextSpotifyRequest('playlist')
    try {
      await u.fill('#spotify-url', fixture.spotify.url); await u.text('form button', 'Buscar canciones')
      await gate.waitForRequest()
      await u.tab('Inicio'); await page.locator('.greeting').waitFor()
      const destination = await page.evaluate(() => ({ url: location.href, index: history.state?.index, route: history.state?.snapshot?.stack[history.state?.index] }))
      gate.release(); await gate.waitForDelivery(); await u.settle()
      assert.deepEqual(await page.evaluate(() => ({ url: location.href, index: history.state?.index, route: history.state?.snapshot?.stack[history.state?.index] })), destination)
      assert.equal(await page.locator('.greeting').count(), 1)
      assert.equal(await page.locator('.import-page, #playlist-name').count(), 0)
      assert.equal(fixture.requests.slice(requestStart).filter(row => row.host === 'api.deezer.com' && row.path === '/search/track').length, 0,
        'Leaving the metadata read must prevent all catalog matching')
      assert.deepEqual(await readLibraryState(page), before)
      await u.tab('Tu biblioteca'); await u.tap('button.import'); await page.locator('#spotify-url').waitFor()
      assert.equal(await page.locator('#spotify-url').inputValue(), '')
      assert.equal(await page.locator('#playlist-name, .result, [role="alert"]').count(), 0)
      await page.reload({ waitUntil: 'load' }); await page.locator('#spotify-url').waitFor()
      assert.deepEqual(await readLibraryState(page), before)
      return { heldStage: 'playlist', destination: 'home', navigationPreserved: true,
        noCatalogMatching: true, noGhostPlaylist: true, reopenedImportEmpty: true, reloadUnchanged: true }
    } finally { gate.release() }
  })

  const csvCreated = await check('library.csv: explicit Spotify denial, invalid CSV, retry, review and save', async () => {
    await u.tab('Tu biblioteca'); await u.tap('button.import')
    const errors = ctx.report.errors ??= []
    const spotifyErrorStart = errors.length, requestStart = fixture.requests.length
    await fixture.set({ spotifyDenied403: true })
    try {
      await u.fill('#spotify-url', fixture.spotify.url)
      await u.text('form button', 'Buscar canciones')
      await page.locator('[role="alert"]').waitFor()
      assert.match(await page.locator('[role="alert"]').textContent(), /Spotify/)
      assert.match(await page.locator('details.csv').textContent(), /CSV/)
      assert.match(await page.locator('form .hint').textContent(), /públic|CSV/i)
      assert.doesNotMatch(await page.locator('form .hint').textContent(), /aún no está disponible/i)
      assert.ok(fixture.requests.slice(requestStart).some(row => row.injectedFailure === 'spotify-denied-403'))
      await u.settle()
    } finally { await fixture.set({ spotifyDenied403: false }) }
    // Windows WebKit also emits this handled fetch rejection as a pageerror.
    // Keep the original diagnostic and annotate only the exact negative case,
    // after verifying that the application explained the failure to the user.
    const expectedSpotifyErrors = errors.slice(spotifyErrorStart).filter(error =>
      error.name === 'Fetch API cannot load https' &&
      /^\/{1,2}(?:open\.spotify\.com\/embed\/api\/token|api-partner\.spotify\.com\/pathfinder\/v1\/query)(?:\?[^ ]*)? due to access control checks\.$/.test(error.message))
    for (const error of expectedSpotifyErrors) {
      error.handledExpected = true
      error.scope = 'library.csv.spotify-denied-403'
      ;(ctx.report.expectedHandledNetworkErrors ??= []).push({ ...error,
        reason: 'The deliberate direct Spotify import rejection is displayed in the UI; other page errors remain failures.' })
    }
    await page.locator('#playlist-csv').setInputFiles({ name: 'invalid.csv', mimeType: 'text/csv', buffer: Buffer.from('Wrong,Headers\na,b\n') })
    await u.text('details.csv button', 'Buscar canciones del CSV')
    await page.locator('[role="alert"]').waitFor()
    assert.match(await page.locator('[role="alert"]').textContent(), /CSV|columna|título|artista/i)
    const quote = value => '"' + String(value).replaceAll('"', '""') + '"'
    const csv = ['Track Name,Artist Name(s),Duration (ms)', ...[first, first, second].map(track =>
      `${quote(track.title)},${quote(track.artist?.name ?? track.artistName ?? trackArtist)},${track.duration * 1000}`), 'Canción inexistente,Artista inexistente,12000'].join('\n')
    await page.locator('#playlist-csv').setInputFiles({ name: 'duplicate-entries.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
    fixture.failNext('/search/track')
    await u.text('details.csv button', 'Buscar canciones del CSV')
    await page.getByRole('button', { name: 'Reintentar búsqueda', exact: true }).waitFor()
    assert.match(await page.locator('[role="alert"]').textContent(), /detenido|conexión|catálogo/i)
    await u.text('.actions button', 'Reintentar búsqueda')
    await page.locator('#playlist-name').waitFor()
    assert.deepEqual(await page.locator('.totals strong').allTextContents(), ['3', '1'])
    await u.text('summary', 'Canciones que se guardarán (3)')
    assert.equal(await page.locator('.track-details ol li').count(), 3)
    await u.fill('#playlist-name', importedName)
    await u.text('.actions button', 'Guardar playlist')
    await u.wait(name => document.querySelector('.hero h1')?.textContent === name, importedName)
    assert.deepEqual((await u.titles()).map(x => x.trim()), [first.title, first.title, second.title])
    await page.reload({ waitUntil: 'load' })
    await u.wait(() => document.querySelectorAll('ol.tracks > li[data-reorder-index]').length === 3)
    assert.deepEqual((await u.titles()).map(x => x.trim()), [first.title, first.title, second.title])
    return { found: 3, omitted: 1, retriedProviderFailure: true, repeatedEntriesPreserved: true,
      spotifyDenied403Visible: true, expectedHandledNetworkErrors: expectedSpotifyErrors.length }
  })

  await check('library.csv-validation: size limit, all omitted, empty name and cancel', async () => {
    await u.tab('Tu biblioteca'); await u.tap('button.import')
    const input = page.locator('#playlist-csv')
    const upload = (name, content) => input.setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.isBuffer(content) ? content : Buffer.from(content) })
    await upload('too-large.csv', Buffer.alloc(10 * 1024 * 1024 + 1, 32))
    await u.text('details.csv button', 'Buscar canciones del CSV')
    await page.locator('[role="alert"]').waitFor()
    assert.match(await page.locator('[role="alert"]').textContent(), /10 MB/)
    await upload('missing.csv', 'Track Name,Artist Name(s)\nCanción inexistente,Artista inexistente\n')
    await u.text('details.csv button', 'Buscar canciones del CSV')
    await page.locator('#playlist-name').waitFor()
    assert.deepEqual(await page.locator('.totals strong').allTextContents(), ['0', '1'])
    assert.equal(await page.getByRole('button', { name: 'Guardar playlist', exact: true }).isDisabled(), true)
    await u.text('.actions button', 'Importar otra lista')
    const quote = value => '"' + String(value).replaceAll('"', '""') + '"'
    const known = `Track Name,Artist Name(s)\n${quote(first.title)},${quote(trackArtist)}\n`
    await upload('known.csv', known); await u.text('details.csv button', 'Buscar canciones del CSV')
    await page.locator('#playlist-name').waitFor()
    await u.fill('#playlist-name', '')
    assert.equal(await page.getByRole('button', { name: 'Guardar playlist', exact: true }).isDisabled(), true)
    await u.text('.actions button', 'Importar otra lista')
    await upload('cancel.csv', known); fixture.failNext('/search/track')
    await u.text('details.csv button', 'Buscar canciones del CSV')
    await page.getByRole('button', { name: 'Reintentar búsqueda', exact: true }).waitFor()
    await u.text('.actions button', 'Cancelar')
    await input.waitFor()
    assert.equal(await input.evaluate(element => element.files.length), 0)
    assert.equal(await page.locator('#playlist-name').count(), 0)
    assert.equal(await page.locator('[role="alert"]').count(), 0)
    return { oversizedFileRejected: true, allOmittedCannotSave: true, blankNameCannotSave: true,
      importAnotherReset: true, cancelledPausedImport: true, createdPlaylist: false }
  })

  await check('library.csv-in-flight: cancel ignores the old response while a new import reaches review', async () => {
    await u.tab('Tu biblioteca'); await u.tap('button.import')
    await u.wait(() => !document.querySelector('iframe[hidden][aria-hidden="true"]'))
    const before = await readLibraryState(page)
    const searches = () => fixture.requests.filter(row => row.host === 'api.deezer.com' && row.path === '/search/track').length
    const requestCount = searches()
    const csv = values => ['Track Name,Artist Name(s)', ...values.map(track =>
      `"${track.title.replaceAll('"', '""')}","${trackArtist.replaceAll('"', '""')}"`)].join('\n')
    const upload = (name, values) => page.locator('#playlist-csv').setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(csv(values)) })
    const gate = fixture.holdNextCatalogSearch()
    try {
      await upload('E2E CSV Obsoleta.csv', [first, second, third])
      await u.text('details.csv button', 'Buscar canciones del CSV')
      await gate.waitForRequest()
      assert.match(await page.locator('.progress-label').textContent(), /0 de 3/)
      await u.text('.actions button', 'Cancelar')
      await page.locator('#playlist-csv').waitFor()
      assert.equal(await page.locator('#playlist-csv').evaluate(input => input.files.length), 0)
      await upload('E2E CSV Nueva.csv', [second])
      await u.text('details.csv button', 'Buscar canciones del CSV')
      await page.locator('#playlist-name').waitFor()
      assert.equal(await page.locator('#playlist-name').inputValue(), 'E2E CSV Nueva')
      assert.deepEqual(await page.locator('.totals strong').allTextContents(), ['1', '0'])
      gate.release(); await gate.waitForDelivery()
      await u.wait(() => !document.querySelector('iframe[hidden][aria-hidden="true"]'))
      await u.settle()
      assert.equal(await page.locator('#playlist-name').inputValue(), 'E2E CSV Nueva')
      assert.deepEqual(await page.locator('.totals strong').allTextContents(), ['1', '0'])
      assert.equal(await page.locator('[role="alert"]').count(), 0)
      assert.equal(searches() - requestCount, 2, 'The cancelled three-track import must not request its remaining tracks')
      assert.deepEqual(await readLibraryState(page), before, 'Neither import may write library rows before the user saves')
      await u.text('.actions button', 'Importar otra lista')
      await page.reload({ waitUntil: 'load' }); await page.locator('#playlist-csv').waitFor()
      assert.deepEqual(await readLibraryState(page), before, 'Cancellation must remain free of persisted changes after reload')
      return { heldCatalogResponseConsumed: true, oldImportCancelled: true, newReviewPreserved: true,
        matchingRequests: 2, remainingOldTracksRequested: false, persistedLibraryUnchanged: true, reloadUnchanged: true }
    } finally { gate.release() }
  })

  await check('library.csv-in-flight: leaving the view prevents late matching, saving or navigation', async () => {
    await u.tab('Tu biblioteca'); await u.tap('button.import')
    await u.wait(() => !document.querySelector('iframe[hidden][aria-hidden="true"]'))
    const before = await readLibraryState(page)
    const searches = () => fixture.requests.filter(row => row.host === 'api.deezer.com' && row.path === '/search/track').length
    const requestCount = searches(), gate = fixture.holdNextCatalogSearch()
    try {
      const csv = ['Track Name,Artist Name(s)', ...[first, second, third].map(track =>
        `"${track.title.replaceAll('"', '""')}","${trackArtist.replaceAll('"', '""')}"`)].join('\n')
      await page.locator('#playlist-csv').setInputFiles({ name: 'E2E CSV Abandonada.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
      await u.text('details.csv button', 'Buscar canciones del CSV')
      await gate.waitForRequest()
      assert.match(await page.locator('.progress-label').textContent(), /0 de 3/)
      await u.tab('Inicio')
      await page.locator('.greeting').waitFor()
      const destination = await page.evaluate(() => ({ url: location.href, index: history.state?.index, route: history.state?.snapshot?.stack[history.state?.index] }))
      gate.release(); await gate.waitForDelivery()
      await u.wait(() => !document.querySelector('iframe[hidden][aria-hidden="true"]'))
      await u.settle()
      assert.deepEqual(await page.evaluate(() => ({ url: location.href, index: history.state?.index, route: history.state?.snapshot?.stack[history.state?.index] })), destination)
      assert.equal(await page.locator('.greeting').count(), 1)
      assert.equal(await page.locator('.import-page, #playlist-name').count(), 0)
      assert.equal(searches() - requestCount, 1, 'The disposed import must stop before matching another row')
      assert.deepEqual(await readLibraryState(page), before, 'Leaving an unsaved import must not write library rows')
      await u.tab('Tu biblioteca'); await u.tap('button.import')
      await page.locator('#playlist-csv').waitFor()
      assert.equal(await page.locator('#playlist-csv').evaluate(input => input.files.length), 0)
      assert.equal(await page.locator('#playlist-name, .result, [role="alert"]').count(), 0)
      await page.reload({ waitUntil: 'load' }); await page.locator('#playlist-csv').waitFor()
      assert.deepEqual(await readLibraryState(page), before)
      return { heldCatalogResponseConsumed: true, navigationPreserved: true, destination: 'home',
        matchingRequests: 1, remainingOldTracksRequested: false, reopenedImportEmpty: true,
        persistedLibraryUnchanged: true, reloadUnchanged: true }
    } finally { gate.release() }
  })

  await check('library.csv-storage: a real transaction abort rolls back partial save and permits retry', async () => {
    await u.tab('Tu biblioteca'); await u.tap('button.import')
    const name = 'E2E CSV Reintento IDB'
    const csv = ['Track Name,Artist Name(s)', ...[first, second].map(track =>
      `"${track.title.replaceAll('"', '""')}","${trackArtist.replaceAll('"', '""')}"`)].join('\n')
    await page.locator('#playlist-csv').setInputFiles({ name: name + '.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
    await u.text('details.csv button', 'Buscar canciones del CSV')
    await page.locator('#playlist-name').waitFor()
    assert.deepEqual(await page.locator('.totals strong').allTextContents(), ['2', '0'])
    const before = await readLibraryState(page)
    const routeBefore = await page.evaluate(() => ({ index: history.state?.index, route: history.state?.snapshot?.stack[history.state?.index] }))
    const searchesBeforeSave = fixture.requests.filter(row => row.host === 'api.deezer.com' && row.path === '/search/track').length
    const fault = await fixture.abortNextLibraryWrite('entries')
    let observed
    try {
      await u.text('.actions button', 'Guardar playlist')
      await page.locator('.import-page [role="alert"]').waitFor()
      assert.match(await page.locator('.import-page [role="alert"]').textContent(), /No se pudo guardar la playlist/)
      observed = await fault.snapshot()
      assert.deepEqual(observed, { database: 'pletina-web-library', store: 'entries', attempts: 1,
        successfulNativeWrites: 1, transactionAborts: 1 })
      assert.deepEqual(await readLibraryState(page), before, 'An aborted first entry must roll back playlist, metadata and sequence writes together')
      assert.deepEqual(await page.evaluate(() => ({ index: history.state?.index, route: history.state?.snapshot?.stack[history.state?.index] })), routeBefore)
      assert.equal(await page.locator('#playlist-name').inputValue(), name)
      assert.deepEqual(await page.locator('.totals strong').allTextContents(), ['2', '0'])
      assert.equal(await page.getByRole('button', { name: 'Guardar playlist', exact: true }).isEnabled(), true)
    } finally { await fault.restore() }
    await u.text('.actions button', 'Guardar playlist')
    await u.wait(name => document.querySelector('.hero h1')?.textContent.trim() === name, name)
    assert.deepEqual((await u.titles()).map(title => title.trim()), [first.title, second.title])
    assert.equal(fixture.requests.filter(row => row.host === 'api.deezer.com' && row.path === '/search/track').length, searchesBeforeSave,
      'Retrying persistence must reuse the reviewed matches without another catalog lookup')
    await page.reload({ waitUntil: 'load' })
    await u.wait(name => document.querySelector('.hero h1')?.textContent.trim() === name, name)
    assert.deepEqual((await u.titles()).map(title => title.trim()), [first.title, second.title])
    await u.tap('.actions button[title="Más opciones"]'); await u.menu('Eliminar playlist')
    await u.text('.confirm button', 'Eliminar'); await page.locator('.greeting').waitFor()
    await u.tab('Tu biblioteca')
    assert.ok(!(await page.locator('.items .title').allTextContents()).includes(name))
    return { fault: observed, realTransactionRollback: true, noLateNavigationOnFailure: true,
      reviewPreserved: true, retrySavedReviewedTracks: true, retryPersistedAcrossReload: true, temporaryPlaylistDeleted: true }
  })

  await check('library.source-picker: candidates, invalid link, manual choice and remembered source', async () => {
    await u.search(query); await u.rowMenu(7); await u.menu('¿No es esta canción?')
    const dialog = page.locator('dialog[aria-label="Elegir otro vídeo"]')
    await dialog.locator('button.alt').first().waitFor()
    assert.ok(await dialog.locator('button.alt').count() >= 1)
    await ctx.tap(dialog.locator('button.alt').first())
    await dialog.waitFor({ state: 'hidden' })
    await u.rowMenu(7); await u.menu('¿No es esta canción?')
    await dialog.locator('button.alt.current').waitFor()
    await u.fill('dialog[aria-label="Elegir otro vídeo"] form input', 'esto no es un enlace')
    await u.text('dialog[aria-label="Elegir otro vídeo"] form button', 'Usar')
    assert.match(await dialog.locator('.link-error').textContent(), /no parece/)
    await u.fill('dialog[aria-label="Elegir otro vídeo"] form input', `https://youtu.be/${third.videoId}`)
    await u.text('dialog[aria-label="Elegir otro vídeo"] form button', 'Usar')
    await dialog.waitFor({ state: 'hidden' })
    await u.rowMenu(7); await u.menu('¿No es esta canción?')
    await dialog.locator('button.alt.current').waitFor()
    assert.ok(await dialog.locator('button.alt').count() >= 2)
    const selected = await dialog.locator('button.alt.current .title').textContent()
    await u.tap('dialog[aria-label="Elegir otro vídeo"] button[title="Cerrar (Esc)"]')
    await dialog.waitFor({ state: 'hidden' })
    await page.reload({ waitUntil: 'load' })
    await u.rows().first().waitFor()
    await u.rowMenu(7); await u.menu('¿No es esta canción?')
    await dialog.locator('button.alt.current').waitFor()
    assert.equal(await dialog.locator('button.alt.current .title').textContent(), selected)
    await u.tap('dialog[aria-label="Elegir otro vídeo"] button[title="Cerrar (Esc)"]')
    return { listedCandidateChosen: true, invalidInputRejected: true, manualChoiceRemembered: true, selected }
  })

  await check('library.youtube: preview, edit, save/update and remove personal link', async () => {
    await u.library('Canciones de YouTube')
    await u.fill('#youtube-url', 'not-a-youtube-link')
    await u.text('.url-form button', 'Continuar')
    await page.locator('[role="alert"]').waitFor()
    assert.match(await page.locator('[role="alert"]').textContent(), /YouTube|vídeo|enlace/i)
    await u.fill('#youtube-url', `https://youtu.be/${third.videoId}`)
    await u.text('.url-form button', 'Continuar')
    await page.locator('#youtube-title').waitFor()
    await u.text('.review button', 'Cambiar enlace')
    assert.equal(await page.locator('#youtube-title').count(), 0)
    assert.equal(await page.locator('#youtube-url').isEnabled(), true)
    await u.text('.url-form button', 'Continuar'); await page.locator('#youtube-title').waitFor()
    await u.fill('#youtube-title', '')
    assert.equal(await page.locator('.review button[type="submit"]').isDisabled(), true)
    await u.fill('#youtube-title', 'E2E Enlace YouTube')
    await u.fill('#youtube-artist', 'Canal E2E')
    await u.text('.review button', 'Guardar canción')
    await u.wait(() => document.querySelectorAll('ol.tracks > li[data-reorder-index]').length === 1)
    assert.equal((await u.titles())[0].trim(), 'E2E Enlace YouTube')
    await u.fill('#youtube-url', `https://youtu.be/${third.videoId}`)
    await u.text('.url-form button', 'Continuar')
    await page.locator('#youtube-title').waitFor()
    await u.fill('#youtube-title', 'E2E Enlace Actualizado')
    await u.text('.review button', 'Guardar canción')
    await u.wait(() => document.querySelector('ol.tracks .name')?.textContent.trim() === 'E2E Enlace Actualizado')
    assert.equal(await u.rows().count(), 1)
    await u.rowMenu(0); await u.menu('Quitar de Canciones de YouTube')
    await u.wait(() => document.querySelectorAll('ol.tracks > li[data-reorder-index]').length === 0)
    return { invalidLinkRejected: true, changeLinkResetReview: true, blankTitleCannotSave: true,
      editedMetadata: true, sameVideoUpdatedWithoutDuplicate: true, removed: true }
  })

  await check('library.youtube: edited metadata survives old playback copies and downloaded audio across reload', async () => {
    if (process.platform === 'win32' && ctx.engine === 'webkit' && ctx.browser.version() === '26.5') return {
      status: 'blocked', reason: 'Windows WebKit native audio bypasses the controlled fixture transport; this integration requires real fixture audio.',
      evidence: 'artifacts/pwa-e2e/webkit-aac-probe.json',
    }
    const original = { title: 'E2E YouTube Cola Anterior', artist: 'E2E Canal Anterior' }
    const edited = { title: 'E2E YouTube Ficha Corregida', artist: 'E2E Canal Corregido' }
    const listName = 'E2E YouTube Cola Guardada'
    let savedId, createdPlaylistId, initialHistoryCount = 0, initiallyLiked = false, failure, stage = 'setup'
    const visible = selector => page.locator(selector).first().isVisible().catch(() => false)
    const closeOverlays = async () => {
      if (await visible('.queue-panel button.close')) await u.tap('.queue-panel button.close')
      if (await visible('.np > header > button[title="Cerrar (Esc)"]')) await u.tap('.np > header > button[title="Cerrar (Esc)"]')
    }
    const pause = async () => {
      await closeOverlays()
      if (await visible('.mini button[aria-label="Pausa"]')) await u.tap('.mini button[aria-label="Pausa"]')
      await u.wait(() => window.__qaAudio.instances.every(audio => audio.paused))
    }
    const inspect = () => page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('pletina-web-library')
      request.onupgradeneeded = () => request.transaction.abort()
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result, names = ['tracks', 'likes', 'playlists', 'entries', 'history', 'youtube'], result = {}
        const tx = db.transaction(names, 'readonly')
        tx.oncomplete = () => { db.close(); resolve(result) }
        tx.onabort = () => { db.close(); reject(tx.error) }
        for (const name of names) { const get = tx.objectStore(name).getAll(); get.onsuccess = () => { result[name] = get.result } }
      }
    }))
    const cacheSnapshot = () => page.evaluate(async id => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('pletina-web-downloads')
        request.onupgradeneeded = () => request.transaction.abort()
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
      })
      try {
        const row = await new Promise((resolve, reject) => {
          const request = db.transaction('files', 'readonly').objectStore('files').get(id)
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
        })
        if (!row) return null
        const cache = await caches.open('pletina-audio-downloads:v1'), response = await cache.match(row.cacheKey)
        if (!response) return { missingBody: true }
        // Opaque bytes are deliberately unreadable. Preserve that distinction in evidence.
        const bytes = response.type === 'opaque' ? null : await response.clone().arrayBuffer()
        const digest = bytes ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(b => b.toString(16).padStart(2, '0')).join('') : null
        return { id: row.id, track: row.track, cacheKey: row.cacheKey, size: row.size, at: row.at,
          type: response.type, bodyPresent: true, readableBytes: bytes?.byteLength ?? null, readableSha256: digest,
          cacheKeys: (await cache.keys()).map(key => key.url).sort() }
      } finally { db.close() }
    }, savedId)
    const save = async metadata => {
      await u.library('Canciones de YouTube')
      await u.fill('#youtube-url', `https://youtu.be/${third.videoId}`)
      await u.text('.url-form button', 'Continuar'); await page.locator('#youtube-title').waitFor()
      await u.fill('#youtube-title', metadata.title); await u.fill('#youtube-artist', metadata.artist)
      await u.text('.review button', 'Guardar canción')
      await u.wait(title => document.querySelector('ol.tracks .name')?.textContent.trim() === title, metadata.title)
      assert.equal(await u.rows().count(), 1)
    }
    const assertEditedRow = async (allowOtherRows = false) => {
      await u.rows().first().waitFor()
      if (!allowOtherRows) assert.equal(await u.rows().count(), 1)
      const titles = (await u.titles()).map(title => title.trim())
      assert.equal(titles.filter(title => title === edited.title).length, 1)
      assert.ok(!titles.includes(original.title))
      const row = u.rows().filter({ has: page.getByText(edited.title, { exact: true }) })
      assert.equal((await row.locator('.by').textContent()).trim(), edited.artist)
    }
    const mediaRequests = () => fixture.requests.filter(request => request.host.endsWith('.googlevideo.com') || request.host === 'media.pletina.test').length
    const transferObserver = () => {
      if (window.__e2eTransfers) return
      window.__e2eTransfers = []
      window.addEventListener('pletina:download', ({ detail }) => window.__e2eTransfers.push({ id: detail.trackId, state: detail.state }))
    }
    await page.addInitScript(transferObserver); await page.evaluate(transferObserver)
    try {
      await fixture.reset(); await save(original)
      const before = await inspect(), row = before.tracks.find(track => track.title === original.title)
      assert.ok(row?.id >= 250_000_000_000_000 && row.id < 500_000_000_000_000)
      savedId = row.id
      initialHistoryCount = before.history.length
      initiallyLiked = before.likes.some(like => like.trackId === savedId)
      assert.equal(initiallyLiked, false, 'This temporary YouTube fixture must start outside favorites')
      stage = 'real playback before edit'
      await u.tap('ol.tracks .name')
      await u.wait(() => window.__qaAudio.instances.some(audio => !audio.paused && audio.currentTime > 0.15))
      await pause()
      const firstAudio = await page.evaluate(() => window.__qaAudio.instances.map(audio => ({ time: audio.currentTime, duration: audio.duration, paused: audio.paused })))
      assert.ok(firstAudio.some(audio => audio.duration >= 11 && audio.duration < 14 && audio.time < audio.duration / 2 && audio.paused), 'Pause the real 12-second fixture before recording history')
      const mark = await page.evaluate(() => window.__e2eTransfers.length)
      await u.rowMenu(0); await u.menu('Descargar')
      await u.wait(({ mark, id }) => window.__e2eTransfers.slice(mark).some(event => event.id === id && ['done', 'error', 'cancelled'].includes(event.state)), { mark, id: savedId }, 25000)
      const terminal = await page.evaluate(({ mark, id }) => window.__e2eTransfers.slice(mark).findLast(event => event.id === id && ['done', 'error', 'cancelled'].includes(event.state)), { mark, id: savedId })
      assert.equal(terminal.state, 'done')
      const cachedBefore = await cacheSnapshot(), beforeMetadataMedia = mediaRequests()
      assert.ok(cachedBefore?.bodyPresent && cachedBefore.size > 0)

      stage = 'edit while the player keeps an old copy'
      await save(edited)
      assert.equal(await page.locator('.mini .title').textContent(), original.title, 'The player intentionally still holds the pre-edit queue copy')
      assert.equal(await page.locator('.mini .artist').textContent(), original.artist)
      stage = 'favorite and playlist from the old current item'
      await u.tap('.mini button[aria-label="Me gusta"]')
      await page.locator('.mini button[aria-label="Me gusta"].on').waitFor()
      await u.tap('.mini button.open'); await u.tap('.np .extras button:has-text("Cola")')
      await page.locator('.queue-panel button.save').waitFor()
      assert.equal((await page.locator('.queue-panel .scroll > .row .title').first().textContent()).trim(), original.title)
      await u.tap('.queue-panel button.save')
      createdPlaylistId = (await inspect()).playlists.find(list => !before.playlists.some(previous => previous.id === list.id))?.id
      assert.ok(createdPlaylistId, 'Saving the real queue must create exactly one new playlist')
      await closeOverlays()
      // Closing the overlays can blur the automatic name editor behind them.
      if (!await visible('input[aria-label="Nombre de la playlist"]')) await u.tap('.hero button[title="Cambiar nombre"]')
      await u.rename(listName); await assertEditedRow()
      const stored = await inspect()
      assert.deepEqual(stored.tracks.filter(track => track.id === savedId).map(track => [track.title, track.artistName]), [[edited.title, edited.artist]])
      assert.ok(stored.likes.some(like => like.trackId === savedId))
      const savedList = stored.playlists.find(list => list.name === listName)
      assert.ok(savedList && stored.entries.some(entry => entry.playlistId === savedList.id && entry.trackId === savedId))
      await u.library('Canciones que te gustan'); await assertEditedRow(true)
      await u.library('Descargas'); await assertEditedRow()
      assert.deepEqual(await cacheSnapshot(), cachedBefore, 'Metadata reads/edits must preserve the stored download and cached response')
      assert.equal(mediaRequests(), beforeMetadataMedia, 'Editing and library reads must not transfer the audio again')

      stage = 'record history from the old current item'
      // Resume the old current item, then use the real seek control to exercise record_play(old).
      await u.tap('.mini button[aria-label="Reproducir"]')
      await u.wait(() => window.__qaAudio.instances.some(audio => !audio.paused && audio.currentTime > 0.2))
      await u.tap('.mini button.open')
      const seek = page.locator('.np input[aria-label="Posición"]'); await seek.waitFor()
      await u.wait(() => !document.querySelector('.np input[aria-label="Posición"]').disabled)
      const box = await seek.boundingBox(); assert.ok(box?.width > 10)
      await page.mouse.click(box.x + box.width * 0.68, box.y + box.height / 2)
      await u.wait(() => window.__qaAudio.instances.some(audio => !audio.paused && !audio.seeking && audio.currentTime > audio.duration / 2))
      await pause(); await closeOverlays(); await u.library('Historial'); await assertEditedRow(true)
      const recorded = await inspect()
      assert.ok(recorded.history.some(entry => entry.trackId === savedId))
      assert.equal(recorded.tracks.filter(track => track.id === savedId).length, 1)
      assert.equal(recorded.tracks.find(track => track.id === savedId).title, edited.title)
      stage = 'reload and local downloaded playback'
      await page.reload({ waitUntil: 'load' }); await page.locator('.app').waitFor(); await assertEditedRow(true)
      for (const label of [listName, 'Canciones que te gustan', 'Descargas']) { await u.library(label); await assertEditedRow(label === 'Canciones que te gustan') }
      const waitForLocalPlayback = async () => {
        await u.wait(() => document.querySelector('.mini button[aria-label="Pausa"]') &&
          window.__qaAudio.instances.some(audio => !audio.paused && !audio.seeking && !audio.error && audio.readyState >= 2 &&
            audio.currentTime > 0.15 && new URL(audio.src, location.href).origin === location.origin &&
            new URL(audio.src, location.href).pathname.includes('/__audio__/')))
        const ready = await page.evaluate(() => {
          const index = window.__qaAudio.instances.findIndex(audio => !audio.paused)
          return { index, time: window.__qaAudio.instances[index].currentTime }
        })
        // A restored seek position is not proof of playback. Observe further real
        // progress after the UI and native media are ready, before reading metadata.
        await u.wait(({ index, time }) => {
          const audio = window.__qaAudio.instances[index]
          return document.querySelector('.mini button[aria-label="Pausa"]') && audio && !audio.paused &&
            !audio.seeking && !audio.error && audio.readyState >= 2 && audio.currentTime > time + 0.05 &&
            new URL(audio.src, location.href).origin === location.origin && new URL(audio.src, location.href).pathname.includes('/__audio__/')
        }, ready)
      }
      const beforeLocalMedia = mediaRequests()
      await u.tap('ol.tracks .name')
      await waitForLocalPlayback()
      // Shared APK behavior: clicking the current ID resumes its existing queue
      // item. Editing the library does not rewrite that live/restored queue copy.
      assert.equal(await page.locator('.mini .title').textContent(), original.title)
      assert.equal(await page.locator('.mini .artist').textContent(), original.artist)
      await pause()
      // The collection play button explicitly builds a new queue from the
      // canonical Downloads rows, so this is the fresh-selection metadata check.
      await u.tap('.actions button.big-play[title="Reproducir"]')
      await waitForLocalPlayback()
      assert.equal(await page.locator('.mini .title').textContent(), edited.title)
      assert.equal(await page.locator('.mini .artist').textContent(), edited.artist)
      await pause()
      assert.equal(mediaRequests(), beforeLocalMedia, 'Playback from the existing download must stay local')
      assert.deepEqual(await cacheSnapshot(), cachedBefore)
      return { realAudio: '12-second controlled AAC fixture', oldQueueCopy: true, favoriteAndQueuePlaylistCanonical: true,
        oldCurrentHistoryCanonical: true, playlistFavoriteHistoryDownloadsSurviveReload: true, sameId: savedId,
        storedDownloadAndCacheUnchanged: true, cacheType: cachedBefore.type,
        readableBodySha256Compared: cachedBefore.type !== 'opaque', opaqueBodyNotReadable: cachedBefore.type === 'opaque',
        sameIdRowResumesSavedQueueCopy: true, explicitDownloadCollectionUsesCanonicalMetadata: true,
        metadataAudioRequests: 0, localPlaybackAudioRequests: 0 }
    } catch (error) {
      failure = error
      ctx.report.youtubeMetadataFailure = { stage, error: error.message, state: await ctx.snapshot() }
      throw error
    } finally {
      try {
        await closeOverlays(); await pause()
        if (!initiallyLiked && await visible('.mini button[aria-label="Me gusta"].on')) await u.tap('.mini button[aria-label="Me gusta"]')
        if (createdPlaylistId) {
          const created = (await inspect()).playlists.find(list => list.id === createdPlaylistId)
          if (created) {
            await u.library(created.name); await u.tap('.actions button[title="Más opciones"]'); await u.menu('Eliminar playlist')
            await u.text('.confirm button', 'Eliminar'); await page.locator('.greeting').waitFor()
          }
        }
        if (savedId) {
          await u.library('Canciones de YouTube')
          if (await u.rows().count()) {
            await u.rowMenu(0)
            if (await visible('[role="menuitem"]:text-is("Quitar descarga")')) {
              await u.menu('Quitar descarga'); await u.rowMenu(0)
            }
            await u.menu('Quitar de Canciones de YouTube')
          }
          await u.library('Historial')
          if (initialHistoryCount === 0 && await visible('button.ghost:has-text("Borrar historial")')) {
            await u.text('button.ghost', 'Borrar historial'); await u.text('.confirm button', 'Borrar')
          }
        }
        await pause()
      } catch (error) {
        if (!failure) throw error
        ctx.report.youtubeMetadataCleanupError = { stage, error: error.message }
      }
    }
  })

  await check('library.podcasts: RSS/YouTube catalogs, language filtering and saved-show reload', async () => {
    const podcast = fixture.media.rss, youtube = fixture.media.youtubePodcast
    await u.tab('Podcasts'); await u.fill('input[aria-label="Buscar podcasts"]', podcast.query)
    await page.locator('[aria-label="Resultados de pódcasts"] .hit').first().waitFor()
    await page.locator('[aria-label="Pódcasts de YouTube"] .hit').first().waitFor()
    assert.equal(await page.locator('[aria-label="Resultados de pódcasts"] .hit').count(), 1)
    await page.locator('select[aria-label="Idioma de los pódcasts"]').selectOption('all')
    await u.wait(() => document.querySelectorAll('[aria-label="Resultados de pódcasts"] .hit').length === 2)
    await page.locator('select[aria-label="Idioma de los pódcasts"]').selectOption('en')
    await u.wait(() => document.querySelectorAll('[aria-label="Resultados de pódcasts"] .hit').length === 1)
    assert.equal(await page.locator('[aria-label="Pódcasts de YouTube"] .hit').count(), 1, 'Unknown YouTube language remains visible')
    await page.locator('select[aria-label="Idioma de los pódcasts"]').selectOption('es')
    await page.locator(`[aria-label="Resultados de pódcasts"] .hit[aria-label=${JSON.stringify(podcast.showTitle)}]`).waitFor()
    await u.tap(`[aria-label="Resultados de pódcasts"] .hit[aria-label=${JSON.stringify(podcast.showTitle)}]`)
    await page.locator('.episodes .episode').first().waitFor()
    assert.deepEqual(await page.locator('.episodes .episode h3').allTextContents(), podcast.episodes.map(e => e.title))
    await u.tap('button.favorite[title="Guardar programa en Tus pódcasts"]')
    await page.locator('button.favorite[aria-pressed="true"]:not(:disabled)').waitFor()
    await u.tab('Podcasts'); await u.fill('input[aria-label="Buscar podcasts"]', youtube.query)
    await page.locator(`[aria-label="Pódcasts de YouTube"] .hit[aria-label=${JSON.stringify(youtube.showTitle)}]`).waitFor()
    await u.tap(`[aria-label="Pódcasts de YouTube"] .hit[aria-label=${JSON.stringify(youtube.showTitle)}]`)
    await page.locator('.episodes .episode').first().waitFor()
    assert.equal(await page.locator('.episodes .episode h3').first().textContent(), youtube.episodeTitle)
    await u.tap('button.favorite[title="Guardar programa en Tus pódcasts"]')
    await page.locator('button.favorite[aria-pressed="true"]:not(:disabled)').waitFor()
    await page.reload({ waitUntil: 'load' })
    await page.locator('button.favorite[aria-pressed="true"]').waitFor()
    await u.tab('Podcasts')
    await page.locator('[aria-label="Tus pódcasts"] .hit').first().waitFor()
    assert.equal(await page.locator('[aria-label="Tus pódcasts"] .hit').count(), 2)
    await u.tap(`[aria-label=${JSON.stringify('Quitar ' + youtube.showTitle + ' de Tus pódcasts')}]`)
    await u.wait(() => document.querySelectorAll('[aria-label="Tus pódcasts"] .hit').length === 1)
    return { languageFilters: ['es', 'all', 'en'], rssEpisodes: podcast.episodes.length, savedAcrossReload: true, rssLeftSavedForMediaScenarios: true }
  })

  await check('library.persistence: saved artist/album and pin removal survive reload', async () => {
    await u.tab('Tu biblioteca')
    await page.locator(`[aria-label=${JSON.stringify('Quitar a ' + artistName + ' de artistas favoritos')}]`).waitFor()
    await u.library(albumTitle)
    await u.tap('button[title="Quitar de tu biblioteca"]')
    await page.locator('button[title="Guardar en tu biblioteca"]').waitFor()
    await u.tap('button[aria-label="Desfijar de Inicio"]')
    await u.tab('Tu biblioteca')
    await u.tap(`[aria-label=${JSON.stringify('Quitar a ' + artistName + ' de artistas favoritos')}]`)
    await page.locator(`[aria-label=${JSON.stringify('Quitar a ' + artistName + ' de artistas favoritos')}]`).waitFor({ state: 'detached' })
    await page.reload({ waitUntil: 'load' })
    await page.locator('.items').waitFor()
    assert.equal(await page.locator(`[aria-label=${JSON.stringify('Quitar a ' + artistName + ' de artistas favoritos')}]`).count(), 0)
    await u.tab('Inicio')
    assert.equal(await page.locator(`.tile-pin[aria-label=${JSON.stringify('Desfijar de Inicio: ' + albumTitle)}]`).count(), 0)
    return { artistRemoved: true, albumRemoved: true, albumUnpinned: true }
  })

  await check('library.playlists: cancellation and permanent deletion remove the pinned list', async () => {
    if (!playlistCreated) return { status: 'blocked', reason: 'Playlist creation failed in the preceding UI scenario.' }
    await u.library(renamedPlaylist)
    await u.tap('.actions button[title="Más opciones"]'); await u.menu('Eliminar playlist')
    await u.text('.confirm button', 'Cancelar')
    assert.equal(await page.locator('.hero h1').textContent(), renamedPlaylist)
    await u.tap('.actions button[title="Más opciones"]'); await u.menu('Eliminar playlist')
    await u.text('.confirm button', 'Eliminar')
    await page.locator('.greeting').waitFor()
    await u.tab('Tu biblioteca')
    assert.ok(!(await page.locator('.items .title').allTextContents()).includes(renamedPlaylist))
    await u.tab('Inicio')
    assert.equal(await page.locator(`.tile-pin[aria-label=${JSON.stringify('Desfijar de Inicio: ' + renamedPlaylist)}]`).count(), 0)
    assert.equal(await currentRoute(), 'home')
    return { cancelKeptList: true, deletedPlaylistAndPin: true, importedPlaylistKeptForMediaScenarios: csvCreated ? importedName : null }
  })

  await check('library.contextual-playlist: create from a song and delete the temporary list', async () => {
    await u.search(query); await u.rowMenu(0); await u.addToPlaylist('Nueva playlist')
    await page.locator('.hero button[title="Cambiar nombre"]').waitFor()
    assert.equal(await u.rows().count(), 1)
    assert.equal((await u.titles())[0].trim(), first.title)
    await u.tap('.hero button[title="Cambiar nombre"]'); await u.rename('E2E Playlist Contextual Temporal')
    await u.tap('.actions button[title="Más opciones"]'); await u.menu('Eliminar playlist')
    await u.text('.confirm button', 'Eliminar'); await page.locator('.greeting').waitFor()
    return { createdFromTrackMenu: true, firstTrackPreserved: true, temporaryListDeleted: true }
  })
  await runPodcastRecoveryScenario(ctx)
}

/** Run after media scenarios have genuinely played a fixture long enough to record it. */
export async function runLibraryHistoryScenario(ctx) {
  const { page, check } = ctx
  const u = ui(ctx)
  await check('library.history: recorded plays, cancel clear, clear and reload', async () => {
    const playback = ctx.report.checks.find(entry => entry.name === 'media.selection-html-audio')
    if (!playback || playback.status !== 'pass') return {
      status: 'blocked', reason: 'Recording history requires the preceding real-playback scenario to pass.',
      prerequisite: playback?.name ?? 'media.selection-html-audio', prerequisiteStatus: playback?.status ?? 'not-run',
      ...(playback?.evidence ? { evidence: playback.evidence } : {}),
    }
    await u.library('Historial')
    await u.rows().first().waitFor()
    const count = await u.rows().count()
    assert.ok(count > 0, 'Media scenarios must create history through playback, not direct database writes')
    await u.text('button.ghost', 'Borrar historial')
    await u.text('.confirm button', 'Cancelar')
    assert.equal(await u.rows().count(), count)
    await u.text('button.ghost', 'Borrar historial')
    await u.text('.confirm button', 'Borrar')
    await u.wait(() => document.querySelectorAll('ol.tracks > li[data-reorder-index]').length === 0)
    assert.match(await page.locator('.empty-state').textContent(), /Aún no has escuchado nada/)
    await page.reload({ waitUntil: 'load' })
    await page.locator('.empty-state').waitFor()
    assert.match(await page.locator('.empty-state').textContent(), /Aún no has escuchado nada/)
    return { recordedEntries: count, cancelKeptHistory: true, clearedAcrossReload: true }
  })
}
