// Provider responses enter through HTTP/JSONP. The compiled application, parsers,
// IndexedDB, service worker and HTMLAudio are real. No application module is mocked.
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const cover = 'https://images.pletina.test/cover.svg'
const artistNames = ['Artista QA Uno', 'Artista QA Dos']
const titles = ['Uno', 'Dos', 'Tres', 'Cuatro', 'Cinco', 'Seis', 'Siete', 'Ocho', 'Nueve', 'Diez', 'Once', 'Doce']
const artists = artistNames.map((name, i) => ({ id: 7 + i, name, picture_medium: cover, picture_big: cover,
  picture_xl: cover, nb_album: i ? 1 : 2, nb_fan: 12345 }))
const albums = [11, 12, 13].map((id, i) => ({ id, title: 'Disco QA ' + titles[i], artist: artists[i === 2 ? 1 : 0],
  cover_medium: cover, cover_big: cover, cover_xl: cover, release_date: '2026-01-0' + (i + 1),
  record_type: ['album', 'single', 'compile'][i], nb_tracks: 4, explicit_lyrics: false, fans: 500 - i,
  label: 'QA', duration: 48, genres: { data: [{ name: 'Pruebas' }] } }))
const tracks = titles.map((name, i) => ({ id: 101 + i, title: 'Canción QA ' + name, title_short: 'Canción QA ' + name,
  title_version: '', duration: 12, artist: artists[i >= 8 ? 1 : 0], artistName: artists[i >= 8 ? 1 : 0].name,
  album: albums[Math.floor(i / 4)], track_position: i % 4 + 1, disk_number: 1, explicit_lyrics: false,
  isrc: 'QATEST' + String(i).padStart(6, '0'), videoId: 'qaAudio' + String(i + 1).padStart(3, '0') + String.fromCharCode(97 + i) }))
const webRescueTrack = { ...tracks[0], id: 190, title: 'Canción QA Rescate WEB', title_short: 'Canción QA Rescate WEB',
  videoId: 'qaMusicBad1' }
const webRescue = { query: 'QA Rescate WEB', track: webRescueTrack, musicVideoId: webRescueTrack.videoId,
  webVideoId: 'qaWebGood1a', nextTrackId: tracks[3].id }
const audiusRescueTrack = { ...tracks[0], id: 191, title: 'Canción QA Rescate Audius', title_short: 'Canción QA Rescate Audius',
  isrc: 'QAABC2600191', videoId: 'qaAudBad01a' }
const audiusRejectedTrack = { ...tracks[0], id: 192, title: 'Canción QA Homónima Audius', title_short: 'Canción QA Homónima Audius',
  isrc: 'QAABC2600192', videoId: 'qaAudBad02b' }
const audiusRescue = { query: 'QA Rescate Audius', track: audiusRescueTrack, sourceId: 'Qa191', nextTrackId: tracks[3].id,
  rejected: { query: 'QA Homónima Audius', track: audiusRejectedTrack } }
const p1MultiTrack = { ...tracks[0], id: 193, title: 'Canción QA AAC múltiple', title_short: 'Canción QA AAC múltiple',
  isrc: 'QAABC2600193', videoId: 'qaP1Multi1a' }
const p1Multi = { query: 'QA P1 AAC', track: p1MultiTrack, videoId: p1MultiTrack.videoId, nextTrackId: tracks[3].id }
const p1TransientTracks = ['Red primaria', 'CDN agotado'].map((name, i) => ({ ...tracks[0], id: 204 + i,
  title: 'P1 QA ' + name, title_short: 'P1 QA ' + name, isrc: 'QAABC2600' + (204 + i), videoId: 'qaP1Tran0' + (i + 1) + String.fromCharCode(97 + i) }))
const p1Transient = { tracks: p1TransientTracks, query: track => 'QA transitorio ' + track.title }
const p1CodecTracks = ['Opus rescate', 'AAC preferente'].map((name, i) => ({ ...tracks[0], id: 206 + i,
  title: 'P1 QA ' + name, title_short: 'P1 QA ' + name, isrc: 'QAABC2600' + (206 + i), videoId: 'qaP1Opus0' + (i + 1) + String.fromCharCode(97 + i) }))
const p1Codecs = { tracks: p1CodecTracks, query: track => 'QA formatos ' + track.title }
const p1PrimaryRepairTracks = ['CDN primario denegado', 'Primario sano', 'Cancelar renovación'].map((name, i) => ({ ...tracks[0], id: 208 + i,
  title: 'P1 QA ' + name, title_short: 'P1 QA ' + name, isrc: 'QAABC2600' + (208 + i), videoId: 'qaP1Fix00' + (i + 1) + String.fromCharCode(97 + i) }))
const p1PrimaryRepair = { tracks: p1PrimaryRepairTracks, query: track => 'QA reparación ' + track.title }
// A separate artist/top namespace keeps selection races independent from source
// caches and the radio/search fixtures used by the rest of the suite.
const selectionArtists = [{ ...artists[0], id: 9, name: 'Artista QA Selección' }, { ...artists[1], id: 10, name: 'Artista QA Invitado' }]
const selectionAlbum = { ...albums[0], id: 14, title: 'Disco QA Selección', artist: selectionArtists[0] }
const selectionTracks = ['A', 'B', 'C', 'D'].map((letter, i) => ({ ...tracks[i], id: 194 + i,
  title: 'Selección QA ' + letter, title_short: 'Selección QA ' + letter, artist: selectionArtists[i === 3 ? 1 : 0],
  artistName: selectionArtists[i === 3 ? 1 : 0].name, album: selectionAlbum, isrc: 'QAABC260019' + (4 + i),
  videoId: 'qaPick000' + (i + 1) + letter.toLowerCase() }))
const artistSelection = { query: 'QA Artist Selection', artists: selectionArtists, album: selectionAlbum, tracks: selectionTracks }
const retryTracks = ['Primero', 'Segundo', 'Agotado', 'Cancelar', 'Cambiar', 'Destino'].map((name, i) => ({ ...tracks[0], id: 198 + i,
  title: 'Reintento QA ' + name, title_short: 'Reintento QA ' + name, isrc: 'QAABC2600' + (198 + i),
  videoId: 'qaRetry00' + (i + 1) + String.fromCharCode(97 + i) }))
const audioRetry = { tracks: retryTracks, query: name => 'QA Reintento ' + name }
const castVideos = ['qaCast0001a', 'qaCast0002b']
const episodes = ['Episodio QA Uno', 'Episodio QA Dos'].map((title, i) => ({ title, duration: 90, guid: 'rss-' + i,
  url: 'https://media.pletina.test/episode-' + i + '.m4a' }))
const media = { query: 'QA Media', tracks: tracks.slice(0, 3), webRescue, audiusRescue, p1Multi, p1Transient, p1Codecs, p1PrimaryRepair, artistSelection, audioRetry, rss: { query: 'QA Podcast', showTitle: 'Podcast QA RSS', episodes },
  youtubePodcast: { query: 'QA Podcast', showTitle: 'Podcast QA YouTube', episodeTitle: 'Episodio QA YouTube Uno' } }
const spotifyId = '0123456789ABCDEFGHIJKL'
const spotify = { id: spotifyId, uri: 'spotify:playlist:' + spotifyId,
  url: 'https://open.spotify.com/playlist/' + spotifyId, name: 'Spotify QA Orden y Duplicados',
  tracks: [tracks[0], tracks[1], tracks[0], { id: 999, title: 'Canción inexistente',
    artist: { name: 'Artista inexistente' }, duration: 12 }] }
const spotifyToken = 'fixture-anonymous-token'
const runs = (...texts) => ({ runs: texts.map(text => ({ text })) })
const duration = seconds => Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0')
const normalize = text => String(text).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
function selected(query) {
  const q = normalize(query)
  const primaryRepair = p1PrimaryRepairTracks.find(track => q.includes(normalize(track.title)))
  if (primaryRepair) return [primaryRepair]
  const codec = p1CodecTracks.find(track => q.includes(normalize(track.title)))
  if (codec) return [codec]
  const transient = p1TransientTracks.find(track => q.includes(normalize(track.title)))
  if (transient) return [transient]
  const retry = retryTracks.find(track => q === normalize(audioRetry.query(track.title.replace('Reintento QA ', ''))) || q.includes(normalize(track.title)))
  if (retry) return q === normalize(audioRetry.query('Cambiar')) ? [retry, retryTracks.at(-1)] : [retry]
  if (q === normalize(artistSelection.query)) return selectionTracks
  const selection = selectionTracks.filter(track => q.includes(normalize(track.title)))
  if (selection.length) return selection
  // The search queue includes another healthy song: skipping the requested song
  // must not masquerade as successful recovery. Audio matching sees only song 190.
  if (q === normalize(webRescue.query)) return [webRescueTrack, tracks[3]]
  if (q.includes(normalize(webRescueTrack.title))) return [webRescueTrack]
  if (q === normalize(audiusRescue.query)) return [audiusRescueTrack, tracks[3]]
  if (q.includes(normalize(audiusRescueTrack.title))) return [audiusRescueTrack]
  if (q === normalize(audiusRescue.rejected.query) || q.includes(normalize(audiusRejectedTrack.title))) return [audiusRejectedTrack]
  if (q === normalize(p1Multi.query)) return [p1MultiTrack, tracks[3]]
  if (q.includes(normalize(p1MultiTrack.title))) return [p1MultiTrack]
  // Regression: the catalog returns no literal result for "title de artist";
  // the real adapter must issue its second query without the linking word.
  if (q === 'cancion qa uno de artista qa uno') return []
  if (/noencontr|missing|inexistente|zzzz/.test(q)) return []
  const match = tracks.filter(track => q.includes(normalize(track.title)) || normalize(track.title).includes(q) && q.length > 7)
  return match.length ? match : tracks
}
const musicRow = track => ({ musicResponsiveListItemRenderer: { playlistItemData: { videoId: track.videoId },
  flexColumns: [
    { musicResponsiveListItemFlexColumnRenderer: { text: runs(track.title) } },
    { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [
      { text: track.artist.name, navigationEndpoint: { browseEndpoint: { browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_ARTIST' } } } } },
      { text: ' • ' }, { text: track.album.title, navigationEndpoint: { browseEndpoint: { browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_ALBUM' } } } } },
      { text: ' • ' }, { text: duration(track.duration) },
    ] } } },
  ] } })
const videoRow = track => ({ videoRenderer: { videoId: track.videoId, title: runs(track.title), ownerText: runs(track.artist.name),
  lengthText: runs(duration(track.duration)), thumbnail: { thumbnails: [{ url: cover }] } } })
const podcastShow = { musicResponsiveListItemRenderer: { navigationEndpoint: { browseEndpoint: { browseId: 'MPSPqapodcast' } },
  flexColumns: [media.youtubePodcast.showTitle, 'Podcast • Autor QA'].map(text => ({ musicResponsiveListItemFlexColumnRenderer: { text: runs(text) } })),
  thumbnail: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: cover }] } } } } }
const podcastDetail = { header: { musicResponsiveHeaderRenderer: {
  title: runs(media.youtubePodcast.showTitle), straplineTextOne: runs('Autor QA'),
  description: { musicDescriptionShelfRenderer: { description: runs('Descripción QA YouTube.') } },
  thumbnail: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: cover }] } } },
} }, contents: castVideos.map((videoId, i) => ({ musicMultiRowListItemRenderer: {
  onTap: { watchEndpoint: { videoId } }, title: runs('Episodio QA YouTube ' + titles[i]),
  description: runs('Descripción QA.'), subtitle: runs('1 oct 2026'),
  playbackProgress: { musicPlaybackProgressRenderer: { durationText: runs('1 min 30 s') } },
} })) }
function rss(english) {
  return '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>' +
    '<title>' + (english ? 'Podcast QA English' : media.rss.showTitle) + '</title><language>' + (english ? 'en' : 'es-ES') + '</language>' +
    '<itunes:author>Autor QA</itunes:author><description>Descripción del programa QA.</description><itunes:image href="' + cover + '"/>' +
    episodes.map((episode, i) => '<item><title>' + episode.title + '</title><guid>' + (english ? 'en-' : '') + episode.guid +
      '</guid><pubDate>Thu, 01 Oct 2026 12:00:00 GMT</pubDate><description>Descripción del episodio QA.</description><itunes:duration>90</itunes:duration>' +
      '<enclosure url="' + episode.url + '" type="audio/mp4"/><itunes:explicit>no</itunes:explicit></item>').join('') + '</channel></rss>'
}
export async function createProviderFixtures(context, { baseURL } = {}) {
  const audio = await readFile(new URL('./fixtures/silence-12s.m4a', import.meta.url))
  const castAudio = await readFile(new URL('./fixtures/silence-90s.m4a', import.meta.url))
  // Generated silence, never music: ffmpeg -f lavfi -i anullsrc=r=48000:cl=stereo -t 12 -c:a libopus -b:a 32k -vbr off -application audio -map_metadata -1 -fflags +bitexact -flags:a +bitexact.
  const opusAudio = await readFile(new URL('./fixtures/silence-12s.webm', import.meta.url))
  const flags = {}, failures = [], requests = [], counts = {}
  const pending = new Set()
  const catalogGates = new Set()
  const playerGates = new Set()
  const spotifyGates = new Set()
  const playerPlans = new Map()
  const transientCycles = new Map()
  const releaseDownloads = () => { for (const resolve of pending) resolve(); pending.clear() }
  const release = () => { releaseDownloads(); for (const gate of catalogGates) gate.release(); for (const gate of playerGates) gate.release(); for (const gate of spotifyGates) gate.release() }
  // Hold the actual guest-token or playlist HTTP response. Cancellation still
  // runs through the compiled reader and its AbortSignal; no API is replaced.
  function holdNextSpotifyRequest(stage) {
    if (!['token', 'playlist'].includes(stage)) throw new Error('Invalid Spotify fixture gate stage.')
    let reached, delivered, resume, claimed = false
    const entered = new Promise(resolve => { reached = resolve }), completed = new Promise(resolve => { delivered = resolve }),
      blocked = new Promise(resolve => { resume = resolve })
    const bounded = async (promise, message) => { let timer; try { return await Promise.race([promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 15000) })]) } finally { clearTimeout(timer) } }
    const gate = { stage, get claimed() { return claimed },
      claim(row) { claimed = true; row.spotifyGate = 'held'; reached(row); return blocked },
      release() { resume(); spotifyGates.delete(gate) },
      delivered(row, cancelled = false) { row.spotifyGate = cancelled ? 'aborted-before-delivery' : 'delivered'; delivered({ ...row }) },
      waitForRequest: () => bounded(entered, 'The import did not reach its Spotify ' + stage + ' HTTP gate.'),
      waitForDelivery: () => bounded(completed, 'The released Spotify ' + stage + ' response was not handled.') }
    spotifyGates.add(gate); return gate
  }
  function holdNextPlayer(videoId, { clientName = null, occurrence = 1 } = {}) {
    if (!/^[\w-]{11}$/.test(videoId)) throw new Error('Invalid player gate identity.')
    if (clientName !== null && !['VISIONOS', 'WEB_EMBEDDED_PLAYER'].includes(clientName) || !Number.isInteger(occurrence) || occurrence < 1 || occurrence > 10) throw new Error('Invalid player gate selection.')
    let reached, delivered, resume, claimed = false, seen = 0
    const entered = new Promise(resolve => { reached = resolve }), completed = new Promise(resolve => { delivered = resolve }),
      blocked = new Promise(resolve => { resume = resolve })
    const bounded = async (promise, message) => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 15000) })]) } finally { clearTimeout(timer) } }
    const gate = { videoId, get claimed() { return claimed },
      matches(id, client) { return id === videoId && (!clientName || clientName === client) && ++seen === occurrence },
      claim(row) { claimed = true; row.playerGate = 'held'; reached(row); return blocked },
      release() { resume(); playerGates.delete(gate) },
      delivered(row, cancelled = false) { row.playerGate = cancelled ? 'aborted-before-delivery' : 'delivered'; delivered({ ...row }) },
      waitForRequest: () => bounded(entered, 'The selected fixture video never reached its HTTP player gate.'),
      waitForDelivery: () => bounded(completed, 'The released fixture player response was not delivered.') }
    playerGates.add(gate); return gate
  }
  function planPlayer(videoId, { rejectCycles = 1 } = {}) {
    if (!retryTracks.some(track => track.videoId === videoId) || !Number.isInteger(rejectCycles) || rejectCycles < 0 || rejectCycles > 3) throw new Error('Invalid retry response plan.')
    playerPlans.set(videoId, { rejectCycles, cycle: 0 })
  }
  // A single real JSONP response can remain in flight while the user cancels or
  // leaves import. No application promise, parser or storage module is replaced.
  function holdNextCatalogSearch() {
    let reached, delivered, resume, claimed = false, released = false
    const entered = new Promise(resolve => { reached = resolve })
    const completed = new Promise(resolve => { delivered = resolve })
    const blocked = new Promise(resolve => { resume = resolve })
    const bounded = async (promise, description, timeout = 15000) => {
      let timer
      try {
        return await Promise.race([promise, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(description)), timeout)
        })])
      } finally { clearTimeout(timer) }
    }
    const gate = {
      get claimed() { return claimed },
      claim(row) { claimed = true; row.catalogGate = 'held'; reached(row); return blocked },
      release() { released = true; resume(); catalogGates.delete(gate) },
      delivered(row) { row.catalogGate = 'delivered'; delivered(row) },
      waitForRequest: () => bounded(entered, 'The CSV import did not issue the catalog request held by its fixture.'),
      waitForDelivery: () => bounded(completed, 'The released catalog response was not delivered.'),
      get released() { return released },
    }
    catalogGates.add(gate)
    return gate
  }
  async function abortNextLibraryWrite(store) {
    if (!['likes', 'playlists', 'entries'].includes(store)) throw new Error('Unsupported library fault store.')
    const page = context.pages().find(page => page.url().includes('/application/'))
    if (!page) throw new Error('A compiled application page is required for the library transaction fault.')
    await page.evaluate(store => {
      if (window.__e2eLibraryAbort) throw new Error('A library transaction fault is already armed.')
      const prototype = IDBObjectStore.prototype
      const fault = window.__e2eLibraryAbort = { store, attempts: 0, successfulNativeWrites: 0, transactionAborts: 0,
        originals: {}, wrappers: {} }
      for (const method of ['put', 'add']) {
        const original = fault.originals[method] = prototype[method]
        prototype[method] = fault.wrappers[method] = function(...args) {
          const request = Reflect.apply(original, this, args)
          if (this.transaction.db.name === 'pletina-web-library' && this.name === store && fault.attempts === 0) {
            fault.attempts++
            const transaction = this.transaction
            // First allow the native write, then abort its real transaction.
            // This exercises rollback; it does not fabricate a quota error.
            request.addEventListener('success', () => {
              fault.successfulNativeWrites++
              transaction.addEventListener('abort', () => { fault.transactionAborts++ }, { once: true })
              transaction.abort()
            }, { once: true })
          }
          return request
        }
      }
    }, store)
    return {
      snapshot: () => page.evaluate(() => {
        const fault = window.__e2eLibraryAbort
        if (!fault) throw new Error('The library transaction fault is no longer installed.')
        return { database: 'pletina-web-library', store: fault.store, attempts: fault.attempts,
          successfulNativeWrites: fault.successfulNativeWrites, transactionAborts: fault.transactionAborts }
      }),
      restore: () => page.evaluate(() => {
        const fault = window.__e2eLibraryAbort
        if (!fault) return
        for (const method of ['put', 'add']) {
          if (IDBObjectStore.prototype[method] === fault.wrappers[method]) IDBObjectStore.prototype[method] = fault.originals[method]
        }
        delete window.__e2eLibraryAbort
      }),
    }
  }
  async function set(values) {
    Object.assign(flags, values)
    if (values.holdDownload === false) releaseDownloads()
    if (Object.hasOwn(values, 'quotaFailure') || Object.hasOwn(values, 'storageFailure')) for (const page of context.pages()) {
      const capabilities = await page.evaluate(values => {
        if (typeof navigator.storage?.estimate === 'function') {
          if (!window.__e2eOriginalEstimate) window.__e2eOriginalEstimate = navigator.storage.estimate.bind(navigator.storage)
          navigator.storage.estimate = values.quotaFailure ? async () => ({ usage: 1024, quota: 1024 }) : window.__e2eOriginalEstimate
        }
        if (!window.__e2eOriginalPut) window.__e2eOriginalPut = IDBObjectStore.prototype.put
        const original = window.__e2eOriginalPut
        IDBObjectStore.prototype.put = function(...args) {
          if (values.storageFailure && this.name === 'files' && this.transaction.db.name === 'pletina-web-downloads') throw new DOMException('Fixture storage failure', 'UnknownError')
          return original.apply(this, args)
        }
        return { storageEstimate: typeof navigator.storage?.estimate === 'function' }
      }, { quotaFailure: Boolean(flags.quotaFailure), storageFailure: Boolean(flags.storageFailure) })
      if (values.quotaFailure && !capabilities.storageEstimate) return { status: 'unsupported',
        reason: 'This browser does not expose navigator.storage.estimate; the quota-estimation failure cannot be injected without fabricating a platform API.' }
    }
  }
  function failNext(path, count = 1) { failures.push({ path, remaining: count }) }
  async function reset() { release(); await set({ quotaFailure: false, storageFailure: false, holdDownload: false }); for (const key of Object.keys(flags)) delete flags[key]; failures.splice(0); playerPlans.clear(); transientCycles.clear() }
  const cancelledRouteError = error => /^(?:route\.(?:fulfill|abort|continue):\s*)?(?:Route is already handled!?|Request is already handled|Target (?:page, context or browser|page|context|browser) has been closed|Target closed|Invalid InterceptionId)/i.test(String(error.message))
  function cancellationProof(request, ownerPage = null) {
    let frame
    try { frame = request.frame?.() } catch { /* Service worker requests have no frame. */ }
    if (ownerPage?.isClosed()) return 'the additional request page is closed'
    if (frame?.page?.()?.isClosed()) return 'the request page is closed'
    if (typeof frame?.isDetached === 'function' && frame.isDetached()) return 'the request frame is detached'
    if (request.failure?.()) return 'the browser reports a failed/cancelled request'
    return null
  }
  function recordCancelledRoute(request, proof) {
    const url = new URL(request.url())
    requests.push({ host: url.hostname, path: url.pathname, method: request.method(), type: request.resourceType(),
      operation: 'qa-cancelled-route', handledExpected: true, reason: proof })
  }
  const respond = async route => {
    const request = route.request(), url = new URL(request.url())
    let playerGate = null, spotifyGate = null
    if (baseURL && url.origin === new URL(baseURL).origin) return route.continue()
    if (!/^https?:$/.test(url.protocol)) return route.continue()
    const row = { host: url.hostname, path: url.pathname, method: request.method(), type: request.resourceType() }
    requests.push(row)
    const countKey = url.hostname + url.pathname
    counts[countKey] = (counts[countKey] ?? 0) + 1
    if (flags.offline) {
      row.injectedFailure = 'offline'
      row.failureAt = Date.now()
      return route.abort('internetdisconnected')
    }
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': '*', 'cache-control': 'no-store' }
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers, body: '' })
    const spotifyStage = url.hostname === 'open.spotify.com' && url.pathname === '/embed/api/token' ? 'token'
      : url.hostname === 'api-partner.spotify.com' && url.pathname === '/pathfinder/v1/query' ? 'playlist' : null
    if (spotifyStage) {
      row.spotifyStage = spotifyStage
      spotifyGate = [...spotifyGates].find(gate => !gate.claimed && gate.stage === spotifyStage)
      if (spotifyGate) await spotifyGate.claim(row)
    }
    const catalogGate = url.hostname === 'api.deezer.com' && url.pathname === '/search/track'
      ? [...catalogGates].find(gate => !gate.claimed) : null
    if (catalogGate) await catalogGate.claim(row)
    const failed = failures.find(failure => failure.remaining > 0 && (url.pathname.includes(failure.path) || request.url().includes(failure.path)))
    if (failed) {
      failed.remaining--
      if (url.hostname === 'api.deezer.com') return route.fulfill({ status: 200, contentType: 'text/javascript',
        body: (url.searchParams.get('callback') || '__pletinaCatalog') + '(' + JSON.stringify({ error: { code: 4, message: 'Fixture failure' } }) + ');' })
      return route.abort('failed')
    }
    const json = async value => {
      try {
        await route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify(value) })
        playerGate?.delivered(row)
        spotifyGate?.delivered(row)
      } catch (error) {
        const proof = cancellationProof(request)
        if ((playerGate || spotifyGate) && cancelledRouteError(error) && proof) {
          recordCancelledRoute(request, proof)
          playerGate?.delivered(row, true); spotifyGate?.delivered(row, true); return
        }
        throw error
      }
    }
    const jsonp = async value => {
      await route.fulfill({ status: 200, headers, contentType: 'text/javascript',
        body: (url.searchParams.get('callback') || '__pletinaPodcasts') + '(' + JSON.stringify(value) + ');' })
      catalogGate?.delivered(row)
    }
    if (spotifyStage) {
      if (flags.spotifyDenied403) {
        row.injectedFailure = 'spotify-denied-403'
        await route.fulfill({ status: 403, headers, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture Spotify access denied' }) })
        spotifyGate?.delivered(row)
        return
      }
      if (request.method() !== 'GET') return route.abort('blockedbyclient')
      if (spotifyStage === 'token') return json({ accessToken: spotifyToken, isAnonymous: true,
        accessTokenExpirationTimestampMs: Date.now() + 3600000 })
      let variables, extensions
      try {
        variables = JSON.parse(url.searchParams.get('variables'))
        extensions = JSON.parse(url.searchParams.get('extensions'))
      } catch { return route.abort('blockedbyclient') }
      row.spotifyOperation = url.searchParams.get('operationName')
      row.spotifyAuthorizationValid = request.headers().authorization === 'Bearer ' + spotifyToken
      row.spotifyOffset = variables?.offset
      row.spotifyLimit = variables?.limit
      if (row.spotifyOperation !== 'queryPlaylist' || !row.spotifyAuthorizationValid || variables?.uri !== spotify.uri ||
        !Number.isInteger(variables.offset) || variables.offset < 0 || !Number.isInteger(variables.limit) || variables.limit < 1 || variables.limit > 1000 ||
        extensions?.persistedQuery?.version !== 1 || !/^[a-f0-9]{64}$/i.test(extensions?.persistedQuery?.sha256Hash ?? '')) {
        row.fixtureRejected = 'Unexpected Spotify request contract'
        return route.abort('blockedbyclient')
      }
      // Deliberately shorter server pages exercise the real explicit-nextOffset
      // reader; the duplicate straddles pages, so loss/reordering cannot pass.
      const pageTracks = spotify.tracks.slice(variables.offset, variables.offset + Math.min(variables.limit, 2))
      const nextOffset = variables.offset + pageTracks.length < spotify.tracks.length ? variables.offset + pageTracks.length : null
      return json({ data: { playlistV2: { __typename: 'Playlist', id: spotify.id, uri: spotify.uri, name: spotify.name,
        content: { totalCount: spotify.tracks.length, pagingInfo: { offset: variables.offset, limit: variables.limit, nextOffset },
          items: pageTracks.map(track => ({
            itemV2: { __typename: 'TrackResponseWrapper', data: { __typename: 'Track',
              uri: 'spotify:track:' + String(track.id).padStart(22, '0'), name: track.title,
              artists: { items: [{ profile: { name: track.artist.name } }] }, duration: { totalMilliseconds: track.duration * 1000 } } },
          })) } } } })
    }
    if (url.hostname === 'api.deezer.com') {
      const q = url.searchParams.get('q') || ''
      if (url.pathname === '/chart/0/albums' || url.pathname === '/search/album') return jsonp({ data: /zzzz|inexistente/i.test(q) ? [] : normalize(q) === normalize(artistSelection.query) ? [selectionAlbum] : albums })
      if (url.pathname === '/chart/0/artists' || url.pathname === '/search/artist') return jsonp({ data: /zzzz|inexistente/i.test(q) ? [] : normalize(q) === normalize(artistSelection.query) ? [selectionArtists[0]] : artists })
      if (url.pathname.startsWith('/search')) return jsonp({ data: selected(q), total: selected(q).length })
      const match = /^\/(artist|album|track)\/(\d+)(?:\/(albums|top|related|tracks))?$/.exec(url.pathname)
      if (match) {
        const [, type, raw, child] = match, id = Number(raw)
        if (type === 'artist' && selectionArtists.some(artist => artist.id === id)) {
          if (child === 'top') return jsonp({ data: id === selectionArtists[0].id ? selectionTracks : selectionTracks.filter(track => track.artist.id === id) })
          if (child === 'albums') return jsonp({ data: [selectionAlbum] })
          if (child === 'related') return jsonp({ data: [] })
          return jsonp(selectionArtists.find(artist => artist.id === id))
        }
        if (type === 'album' && id === selectionAlbum.id) return jsonp(child === 'tracks' ? { data: selectionTracks } : selectionAlbum)
        if (type === 'artist') {
          if (child === 'albums') return jsonp({ data: albums.filter(album => album.artist.id === id) })
          if (child === 'top') return jsonp({ data: tracks.filter(track => track.artist.id === id).slice(0, 10) })
          if (child === 'related') return jsonp({ data: artists.filter(artist => artist.id !== id) })
          return jsonp(artists.find(artist => artist.id === id) || artists[0])
        }
        if (type === 'album') return jsonp(child === 'tracks' ? { data: tracks.filter(track => track.album.id === id) } : albums.find(album => album.id === id) || albums[0])
        return jsonp([webRescueTrack, audiusRescueTrack, audiusRejectedTrack, p1MultiTrack, ...p1TransientTracks, ...p1CodecTracks, ...retryTracks, ...selectionTracks, ...tracks].find(track => track.id === id) || tracks[0])
      }
      return jsonp({ error: { code: 800 } })
    }
    const audiusStream = url.hostname === 'api.audius.co' && /^\/v1\/tracks\/[A-Za-z0-9]+\/stream$/.test(url.pathname)
    if (url.hostname === 'api.audius.co') {
      if (url.pathname === '/v1/tracks') {
        const isrc = url.searchParams.get('isrc')
        const track = [audiusRescueTrack, audiusRejectedTrack].find(track => track.isrc === isrc)
        if (!flags.audiusCatalogRescue || !track) return json({ data: [] })
        const base = { title: track.title, duration: track.duration, user: { name: track.artist.name }, isrc: track.isrc,
          is_available: true, is_delete: false, is_streamable: true, is_stream_gated: false,
          access: { stream: true, download: Boolean(flags.audiusDownloadAllowed) },
          is_downloadable: Boolean(flags.audiusDownloadAllowed), is_download_gated: false, remix_of: { tracks: [] } }
        const candidates = [{ ...base, id: 'WrongIsrc', isrc: 'QAABC2600999' },
          { ...base, id: 'WrongArtist', user: { name: 'Otro artista con título idéntico' } }]
        if (track.id === audiusRescueTrack.id) candidates.push({ ...base, id: audiusRescue.sourceId })
        Object.assign(row, { fixtureCase: 'audius-catalog-rescue', operation: 'catalog-search', isrc,
          requestedTrackId: track.id, candidateIds: candidates.map(candidate => candidate.id) })
        return json({ data: candidates })
      }
      if (!audiusStream) return route.abort('blockedbyclient')
      Object.assign(row, { fixtureCase: 'audius-catalog-rescue', operation: 'media', sourceId: url.pathname.split('/')[3] })
    }
    if (url.hostname === 'itunes.apple.com') {
      const shows = [false, true].map((english, i) => ({ collectionId: 900 + i, kind: 'podcast',
        collectionName: english ? 'Podcast QA English' : media.rss.showTitle, artistName: 'Autor QA',
        artworkUrl600: cover, feedUrl: 'https://feeds.pletina.test/' + (english ? 'english' : 'rss') }))
      if (url.pathname === '/search') return jsonp({ results: flags.emptyPodcastDirectory ? [] : shows,
        resultCount: flags.emptyPodcastDirectory ? 0 : shows.length })
      return jsonp({ results: episodes.map((episode, i) => ({ kind: 'podcast-episode', episodeContentType: 'audio',
        episodeUrl: episode.url, trackName: episode.title, episodeGuid: episode.guid, trackTimeMillis: 90000,
        releaseDate: '2026-10-01T12:00:00Z', artworkUrl600: cover, trackId: 9010 + i })) })
    }
    if (url.hostname === 'feeds.pletina.test') {
      if (flags.failPodcastFeeds) {
        row.injectedFailure = 'rss-http-503'
        return route.fulfill({ status: 503, headers, contentType: 'text/plain', body: 'Fixture RSS unavailable' })
      }
      return route.fulfill({ status: 200, headers, contentType: 'application/rss+xml', body: rss(url.pathname === '/english') })
    }
    if (['www.youtube.com', 'www.youtube-nocookie.com'].includes(url.hostname) && /^\/embed\/[\w-]{11}$/.test(url.pathname) && retryTracks.some(track => track.videoId === url.pathname.split('/').at(-1))) {
      Object.assign(row, { fixtureCase: 'audio-final-retry', operation: 'official-embed', videoId: url.pathname.split('/').at(-1) })
      return route.fulfill({ status: 200, headers, contentType: 'text/html', body: '<!doctype html><title>Controlled visible official-player frame</title><p>Video fixture</p>' })
    }
    if (url.hostname === 'www.youtube.com' || url.hostname === 'music.youtube.com') {
      let body
      try { body = request.postDataJSON() || {} } catch { body = {} }
      if (url.pathname.endsWith('/browse')) return json(podcastDetail)
      if (url.pathname.endsWith('/search')) {
        if (body.params === 'EgWKAQJQAWoMEA4QChADEAQQCRAF') return json({ items: flags.emptyYoutubePodcasts ? [] : [podcastShow] })
        let selectedTracks = selected(body.query || '')
        if (flags.p1PrimaryRepair && selectedTracks.length === 1 && p1PrimaryRepairTracks.some(track => track.id === selectedTracks[0].id)) {
          Object.assign(row, { fixtureCase: 'p1-primary-repair', operation: url.hostname === 'music.youtube.com' ? 'music-search' : 'web-search',
            requestedTrackId: selectedTracks[0].id, candidateIds: selectedTracks.map(track => track.videoId) })
        }
        if (flags.p1Codecs && selectedTracks.length === 1 && p1CodecTracks.some(track => track.id === selectedTracks[0].id)) {
          Object.assign(row, { fixtureCase: 'p1-codecs', operation: url.hostname === 'music.youtube.com' ? 'music-search' : 'web-search',
            requestedTrackId: selectedTracks[0].id, candidateIds: selectedTracks.map(track => track.videoId) })
        }
        if (flags.p1Transient && selectedTracks.length === 1 && p1TransientTracks.some(track => track.id === selectedTracks[0].id)) {
          Object.assign(row, { fixtureCase: 'p1-transient', operation: url.hostname === 'music.youtube.com' ? 'music-search' : 'web-search',
            requestedTrackId: selectedTracks[0].id, candidateIds: selectedTracks.map(track => track.videoId) })
        }
        if (selectedTracks.length === 1 && retryTracks.some(track => track.id === selectedTracks[0].id)) {
          Object.assign(row, { fixtureCase: 'audio-final-retry', operation: url.hostname === 'music.youtube.com' ? 'music-search' : 'web-search',
            requestedTrackId: selectedTracks[0].id, candidateIds: selectedTracks.map(track => track.videoId) })
        }
        if (flags.p1MultiAacRescue && selectedTracks.length === 1 && selectedTracks[0].id === p1MultiTrack.id) {
          Object.assign(row, { fixtureCase: 'p1-multi-aac-rescue', operation: url.hostname === 'music.youtube.com' ? 'music-search' : 'web-search',
            candidateIds: [p1Multi.videoId] })
        }
        if (flags.audiusCatalogRescue && selectedTracks.length === 1 && [audiusRescueTrack.id, audiusRejectedTrack.id].includes(selectedTracks[0].id)) {
          Object.assign(row, { fixtureCase: 'audius-catalog-rescue', operation: url.hostname === 'music.youtube.com' ? 'music-search' : 'web-search',
            requestedTrackId: selectedTracks[0].id, candidateIds: selectedTracks.map(track => track.videoId) })
        }
        if (flags.musicUnplayableWebRescue && selectedTracks.length === 1 && selectedTracks[0].id === webRescueTrack.id) {
          const music = url.hostname === 'music.youtube.com'
          selectedTracks = [{ ...webRescueTrack, videoId: music ? webRescue.musicVideoId : webRescue.webVideoId }]
          Object.assign(row, { fixtureCase: 'music-unplayable-web-rescue', operation: music ? 'music-search' : 'web-search',
            candidateIds: selectedTracks.map(track => track.videoId) })
        }
        if (url.hostname === 'music.youtube.com') return json({ contents: { tabbedSearchResultsRenderer: { tabs: [{ tabRenderer: {
          content: { sectionListRenderer: { contents: [{ musicShelfRenderer: { contents: selectedTracks.map(musicRow) } }] } },
        } }] } } })
        return json({ responseContext: { visitorData: 'fixture-visitor' }, contents: {
          twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: selectedTracks.map(videoRow) } }] } } },
        } })
      }
      if (url.pathname.endsWith('/player')) {
        const playerVideoId = body.videoId || tracks[0].videoId
        playerGate = [...playerGates].find(gate => !gate.claimed && gate.matches(playerVideoId, body.context?.client?.clientName ?? null)) ?? null
        Object.assign(row, { operation: 'player', videoId: playerVideoId, clientName: body.context?.client?.clientName ?? null })
        if (playerGate) {
          await playerGate.claim(row)
        }
        if (flags.delayPlayerMs) await new Promise(resolve => setTimeout(resolve, flags.delayPlayerMs))
        const videoId = body.videoId || tracks[0].videoId
        const clientName = body.context?.client?.clientName ?? null
        const primaryRepair = flags.p1PrimaryRepair && p1PrimaryRepairTracks.find(track => track.videoId === videoId)
        if (primaryRepair) {
          Object.assign(row, { fixtureCase: 'p1-primary-repair', operation: 'player', videoId, clientName, playability: 'OK' })
          if (!['VISIONOS', 'WEB_EMBEDDED_PLAYER'].includes(clientName)) return route.abort('blockedbyclient')
          const source = clientName === 'VISIONOS' ? 'primary' : 'p1'
          return json({ playabilityStatus: { status: 'OK', playableInEmbed: true },
            videoDetails: { videoId, title: primaryRepair.title, author: primaryRepair.artist.name, lengthSeconds: '12' },
            streamingData: { adaptiveFormats: [{ itag: 140, bitrate: 128000, mimeType: 'audio/mp4; codecs="mp4a.40.2"',
              contentLength: String(audio.length), audioTrack: { audioIsDefault: true, displayName: 'Original' },
              url: 'https://fixture.googlevideo.com/videoplayback?expire=' + (Math.floor(Date.now() / 1000) + 7200) +
                '&itag=140&mime=audio%2Fmp4&clen=' + audio.length + '&qa_primary_repair=' + videoId + '&qa_source=' + source }] } })
        }
        const codec = flags.p1Codecs && p1CodecTracks.find(track => track.videoId === videoId)
        if (codec) {
          Object.assign(row, { fixtureCase: 'p1-codecs', operation: 'player', videoId, clientName })
          if (clientName === 'VISIONOS') {
            row.playability = 'UNPLAYABLE'
            return json({ playabilityStatus: { status: 'UNPLAYABLE' }, videoDetails: { videoId } })
          }
          if (clientName !== 'WEB_EMBEDDED_PLAYER') return route.abort('blockedbyclient')
          row.playability = 'OK'
          const format = (itag, bitrate, mime, bytes) => ({ itag, bitrate, mimeType: mime === 'audio/webm' ? 'audio/webm; codecs="opus"' : 'audio/mp4; codecs="mp4a.40.2"',
            contentLength: String(bytes.length), audioTrack: { audioIsDefault: true, displayName: 'Original' },
            url: 'https://fixture.googlevideo.com/videoplayback?expire=' + (Math.floor(Date.now() / 1000) + 7200) +
              '&itag=' + itag + '&mime=' + encodeURIComponent(mime) + '&clen=' + bytes.length + '&qa_codecs=' + videoId })
          // Opus is deliberately first and higher bitrate. A healthy AAC must
          // still win. Bytes below are real Opus/WebM, never renamed AAC.
          return json({ playabilityStatus: { status: 'OK', playableInEmbed: true },
            videoDetails: { videoId, title: codec.title, author: codec.artist.name, lengthSeconds: '12' },
            streamingData: { adaptiveFormats: [format(251, 160000, 'audio/webm', opusAudio), format(140, 128000, 'audio/mp4', audio)] } })
        }
        const transient = flags.p1Transient && p1TransientTracks.find(track => track.videoId === videoId)
        if (transient) {
          if (clientName === 'VISIONOS') transientCycles.set(videoId, (transientCycles.get(videoId) ?? 0) + 1)
          const cycle = transientCycles.get(videoId) ?? 0
          Object.assign(row, { fixtureCase: 'p1-transient', operation: 'player', videoId, clientName, cycle })
          if (clientName === 'VISIONOS') {
            if (transient.id === p1TransientTracks[0].id) {
              row.injectedFailure = 'primary-network'; return route.abort('failed')
            }
            row.playability = 'UNPLAYABLE'
            return json({ playabilityStatus: { status: 'UNPLAYABLE' }, videoDetails: { videoId } })
          }
          if (clientName !== 'WEB_EMBEDDED_PLAYER') return route.abort('blockedbyclient')
          row.playability = 'OK'
          const format = (itag, bitrate) => ({ itag, bitrate, mimeType: 'audio/mp4; codecs="mp4a.40.2"', contentLength: String(audio.length),
            audioTrack: { audioIsDefault: true, displayName: 'Original' },
            url: 'https://fixture.googlevideo.com/videoplayback?expire=' + (Math.floor(Date.now() / 1000) + 7200) +
              '&itag=' + itag + '&mime=audio%2Fmp4&clen=' + audio.length + '&qa_transient=' + videoId + '&qa_cycle=' + cycle })
          return json({ playabilityStatus: { status: 'OK', playableInEmbed: true },
            videoDetails: { videoId, title: transient.title, author: transient.artist.name, lengthSeconds: '12' },
            streamingData: { adaptiveFormats: [format(140, 128000), format(139, 64000)] } })
        }
        const plan = playerPlans.get(videoId)
        if (plan) {
          if (clientName === 'VISIONOS') plan.cycle++
          Object.assign(row, { fixtureCase: 'audio-final-retry', cycle: plan.cycle, playability: plan.cycle <= plan.rejectCycles ? 'UNPLAYABLE' : 'OK' })
          if (plan.cycle <= plan.rejectCycles) return json({ playabilityStatus: { status: 'UNPLAYABLE' }, videoDetails: { videoId } })
        }
        if (flags.p1MultiAacRescue && videoId === p1Multi.videoId) {
          Object.assign(row, { fixtureCase: 'p1-multi-aac-rescue', operation: 'player', videoId, clientName })
          if (clientName === 'VISIONOS') {
            row.playability = 'UNPLAYABLE'
            return json({ playabilityStatus: { status: 'UNPLAYABLE' }, videoDetails: { videoId } })
          }
          if (clientName !== 'WEB_EMBEDDED_PLAYER') return route.abort('blockedbyclient')
          row.playability = 'OK'
          const locator = (candidate, itag, path = '/videoplayback') => 'https://fixture.googlevideo.com' + path +
            '?expire=' + (Math.floor(Date.now() / 1000) + 7200) + '&itag=' + itag + '&mime=audio%2Fmp4&clen=' + audio.length +
            '&qa=' + candidate + '&qa_video=' + videoId
          const aac = (candidate, itag, bitrate, path) => ({ itag, bitrate, mimeType: 'audio/mp4; codecs="mp4a.40.2"',
            contentLength: String(audio.length), audioTrack: { audioIsDefault: true, displayName: 'Original' },
            url: locator(candidate, itag, path) })
          // No real-song claim and no decoder fixture. The first AAC has an
          // invalid path, the second returns HTTP403, the third is real AAC.
          return json({ playabilityStatus: { status: 'OK', playableInEmbed: true },
            videoDetails: { videoId, title: p1MultiTrack.title, author: p1MultiTrack.artist.name, lengthSeconds: '12' },
            streamingData: { adaptiveFormats: [aac('p1-invalid-locator', 141, 256000, '/not-a-permitted-audio-path'),
              aac('p1-denied', 140, 192000), aac('p1-good', 139, 128000)] } })
        }
        if (flags.audiusCatalogRescue && [audiusRescueTrack.videoId, audiusRejectedTrack.videoId].includes(videoId)) {
          if (flags.audiusNetworkRescue && videoId === audiusRescueTrack.videoId) {
            Object.assign(row, { fixtureCase: 'audius-catalog-rescue', operation: 'player', videoId, clientName, injectedFailure: 'youtube-network-before-audius' })
            return route.abort('failed')
          }
          Object.assign(row, { fixtureCase: 'audius-catalog-rescue', operation: 'player', videoId, clientName, playability: 'UNPLAYABLE' })
          // Every transport receives a controlled rejection for this exact ID;
          // in particular P1 must stop before a decoder or metadata media probe.
          return json({ playabilityStatus: { status: 'UNPLAYABLE' }, videoDetails: { videoId } })
        }
        const rescue = flags.musicUnplayableWebRescue && [webRescue.musicVideoId, webRescue.webVideoId].includes(videoId)
        if (rescue) Object.assign(row, { fixtureCase: 'music-unplayable-web-rescue', operation: 'player', videoId, clientName })
        if (flags.failPlayer || rescue && videoId === webRescue.musicVideoId) {
          // The generic bounded-error case exercises a restriction, which must
          // not open the official-player fallback. The separate rescue case
          // deliberately keeps its unavailable-audio classification.
          const status = rescue && videoId === webRescue.musicVideoId ? 'UNPLAYABLE' : 'LOGIN_REQUIRED'
          Object.assign(row, { playability: status, videoId })
          return json({ playabilityStatus: { status }, videoDetails: { videoId } })
        }
        if (rescue) row.playability = 'OK'
        const track = [webRescue.musicVideoId, webRescue.webVideoId].includes(videoId) ? webRescueTrack
          : [...retryTracks, ...selectionTracks, ...tracks].find(track => track.videoId === videoId), cast = castVideos.indexOf(videoId)
        const bytes = cast >= 0 ? castAudio : audio
        return json({ playabilityStatus: { status: 'OK' }, videoDetails: { videoId, title: track?.title || 'Episodio QA YouTube ' + titles[Math.max(0, cast)],
          author: track?.artist.name || 'Autor QA', lengthSeconds: String(cast >= 0 ? 90 : 12) },
        streamingData: { adaptiveFormats: [{ mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 64000,
          contentLength: String(bytes.length), url: 'https://fixture.googlevideo.com/audio/' + videoId + '?expire=' + (Math.floor(Date.now() / 1000) + 7200) + '&clen=' + bytes.length }] } })
      }
      return route.abort()
    }
    if (url.hostname === 'fixture.googlevideo.com' || url.hostname === 'media.pletina.test' || audiusStream) {
      const primaryRepair = flags.p1PrimaryRepair && p1PrimaryRepairTracks.find(track => track.videoId === url.searchParams.get('qa_primary_repair'))
      if (primaryRepair) {
        const source = url.searchParams.get('qa_source'), rejected = source === 'primary' && primaryRepair.id !== p1PrimaryRepairTracks[1].id
        const body = rejected ? 'Controlled primary CDN403; same-ID P1 AAC is available' : audio
        Object.assign(row, { fixtureCase: 'p1-primary-repair', operation: 'media', videoId: primaryRepair.videoId, source,
          responseStatus: rejected ? 403 : request.headers().range ? 206 : 200,
          responseMime: rejected ? 'text/plain' : 'audio/mp4', bodySha256: createHash('sha256').update(body).digest('hex') })
        if (rejected) {
          row.injectedFailure = 'primary-cdn-http-403'
          return route.fulfill({ status: 403, headers, contentType: 'text/plain', body })
        }
      }
      const codec = flags.p1Codecs && p1CodecTracks.find(track => track.videoId === url.searchParams.get('qa_codecs'))
      if (codec) {
        const opus = url.searchParams.get('itag') === '251'
        Object.assign(row, { fixtureCase: 'p1-codecs', operation: 'media', videoId: codec.videoId, itag: opus ? 251 : 140,
          responseMime: opus ? 'audio/webm' : 'audio/mp4', bodySha256: createHash('sha256').update(opus ? opusAudio : audio).digest('hex') })
        if (!opus && codec.id === p1CodecTracks[0].id) {
          const body = 'Controlled AAC source denied; Opus remains available'
          Object.assign(row, { responseStatus: 403, injectedFailure: 'p1-aac-cdn-http-403',
            responseMime: 'text/plain', bodySha256: createHash('sha256').update(body).digest('hex') })
          return route.fulfill({ status: 403, headers, contentType: 'text/plain', body })
        }
      }
      const transient = flags.p1Transient && p1TransientTracks.find(track => track.videoId === url.searchParams.get('qa_transient'))
      if (transient) {
        Object.assign(row, { fixtureCase: 'p1-transient', operation: 'media', videoId: transient.videoId,
          cycle: Number(url.searchParams.get('qa_cycle')), itag: Number(url.searchParams.get('itag')) })
        if (transient.id === p1TransientTracks[1].id) {
          Object.assign(row, { responseStatus: 403, injectedFailure: 'p1-all-metadata-http-403' })
          return route.fulfill({ status: 403, headers, contentType: 'text/plain', body: 'Controlled transient CDN failure' })
        }
      }
      const videoId = /^\/audio\/([\w-]{11})$/.exec(url.pathname)?.[1]
      if (retryTracks.some(track => track.videoId === videoId)) Object.assign(row, { fixtureCase: 'audio-final-retry', operation: 'media', videoId })
      if (flags.p1MultiAacRescue && url.searchParams.get('qa_video') === p1Multi.videoId) {
        const candidate = url.searchParams.get('qa')
        Object.assign(row, { fixtureCase: 'p1-multi-aac-rescue', operation: 'media', videoId: p1Multi.videoId, candidate })
        if (candidate !== 'p1-good') {
          Object.assign(row, { responseStatus: 403, injectedFailure: 'p1-candidate-http-403' })
          return route.fulfill({ status: 403, headers, contentType: 'text/plain', body: 'Controlled AAC candidate denied' })
        }
      }
      if (flags.musicUnplayableWebRescue && [webRescue.musicVideoId, webRescue.webVideoId].includes(videoId)) {
        Object.assign(row, { fixtureCase: 'music-unplayable-web-rescue', operation: 'media', videoId })
      }
      const download = request.resourceType() === 'fetch'
      if (flags.holdDownload && download) await new Promise(resolve => pending.add(resolve))
      if (flags.failMedia) return route.fulfill({ status: 403, headers, contentType: 'text/plain', body: 'Fixture denied audio' })
      const bytes = codec && url.searchParams.get('itag') === '251' ? opusAudio
        : url.hostname === 'media.pletina.test' || castVideos.some(id => url.pathname.includes(id)) ? castAudio : audio
      const contentType = codec && url.searchParams.get('itag') === '251' ? 'audio/webm' : 'audio/mp4'
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range || '')
      if (range) {
        const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1
        if (start > end || start >= bytes.length) {
          if (primaryRepair) Object.assign(row, { responseStatus: 416, bodySha256: createHash('sha256').update('').digest('hex') })
          return route.fulfill({ status: 416, headers: { ...headers, 'content-range': 'bytes */' + bytes.length }, body: '' })
        }
        if (primaryRepair) Object.assign(row, { responseStatus: 206, bodySha256: createHash('sha256').update(bytes.subarray(start, end + 1)).digest('hex') })
        return route.fulfill({ status: 206, headers: { ...headers, 'accept-ranges': 'bytes', 'content-range': 'bytes ' + start + '-' + end + '/' + bytes.length },
          contentType, body: bytes.subarray(start, end + 1) })
      }
      return route.fulfill({ status: 200, headers: { ...headers, 'accept-ranges': 'bytes' }, contentType, body: bytes })
    }
    if (url.hostname === 'open.spotify.com') return route.fulfill({ status: 403, headers, contentType: 'text/html', body: '<!doctype html><title>Fixture access denied</title>' })
    if (['images.pletina.test', 'i.ytimg.com'].includes(url.hostname)) return route.fulfill({ status: 200, headers, contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#6847ab"/><circle cx="100" cy="100" r="50" fill="#bcd784"/></svg>' })
    return route.abort('blockedbyclient')
  }
  async function handleRoute(route, ownerPage = null) {
    const request = route.request(), before = cancellationProof(request, ownerPage)
    if (before) { recordCancelledRoute(request, before); return }
    try { await respond(route) }
    catch (error) {
      const proof = cancellationProof(request, ownerPage)
      if (cancelledRouteError(error) && proof) { recordCancelledRoute(request, proof); return }
      throw error
    }
  }
  const handler = route => handleRoute(route)
  let routingActive = false
  async function resumeRoutes() {
    if (!routingActive) { await context.route('**/*', handler); routingActive = true }
  }
  async function suspendRoutes() {
    if (routingActive && context.unroute) { await context.unroute('**/*', handler); routingActive = false }
  }
  async function attachPage(page) {
    if (typeof context.attachPage === 'function') await context.attachPage(page)
    else await page.route('**/*', route => handleRoute(route, page))
  }
  await resumeRoutes()
  return { data: { artists, albums, tracks }, artists, albums, tracks, media, spotify, requests, counts, flags, set, reset, failNext,
    audioFile: { bytes: audio.length, sha256: createHash('sha256').update(audio).digest('hex'), mime: 'audio/mp4', duration: 12 },
    opusAudioFile: { bytes: opusAudio.length, sha256: createHash('sha256').update(opusAudio).digest('hex'), mime: 'audio/webm', codec: 'opus', duration: 12.008 },
    // Additional pages must share the primary transport: Chromium opaque-frame
    // fetches need the same Puppeteer HTTP bridge, while other engines route normally.
    attachPage,
    holdNextCatalogSearch, holdNextPlayer, holdNextSpotifyRequest, planPlayer, abortNextLibraryWrite, release, suspendRoutes, resumeRoutes,
    source: 'Synthetic HTTP provider contracts with real silent AAC/MP4 media; no live provider availability or physical phone claim.' }
}
