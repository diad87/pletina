// Provider responses enter through HTTP/JSONP. The compiled application, parsers,
// IndexedDB, service worker and HTMLAudio are real. No application module is mocked.
import { readFile } from 'node:fs/promises'

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
const castVideos = ['qaCast0001a', 'qaCast0002b']
const episodes = ['Episodio QA Uno', 'Episodio QA Dos'].map((title, i) => ({ title, duration: 90, guid: 'rss-' + i,
  url: 'https://media.pletina.test/episode-' + i + '.m4a' }))
const media = { query: 'QA Media', tracks: tracks.slice(0, 3), rss: { query: 'QA Podcast', showTitle: 'Podcast QA RSS', episodes },
  youtubePodcast: { query: 'QA Podcast', showTitle: 'Podcast QA YouTube', episodeTitle: 'Episodio QA YouTube Uno' } }
const runs = (...texts) => ({ runs: texts.map(text => ({ text })) })
const duration = seconds => Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0')
const normalize = text => String(text).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
function selected(query) {
  const q = normalize(query)
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
  const flags = {}, failures = [], requests = [], counts = {}
  const pending = new Set()
  const catalogGates = new Set()
  const releaseDownloads = () => { for (const resolve of pending) resolve(); pending.clear() }
  const release = () => { releaseDownloads(); for (const gate of catalogGates) gate.release() }
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
  async function reset() { release(); await set({ quotaFailure: false, storageFailure: false, holdDownload: false }); for (const key of Object.keys(flags)) delete flags[key]; failures.splice(0) }
  const handler = async route => {
    const request = route.request(), url = new URL(request.url())
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
    const json = value => route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify(value) })
    const jsonp = async value => {
      await route.fulfill({ status: 200, headers, contentType: 'text/javascript',
        body: (url.searchParams.get('callback') || '__pletinaPodcasts') + '(' + JSON.stringify(value) + ');' })
      catalogGate?.delivered(row)
    }
    if (url.hostname === 'api.deezer.com') {
      const q = url.searchParams.get('q') || ''
      if (url.pathname === '/chart/0/albums' || url.pathname === '/search/album') return jsonp({ data: /zzzz|inexistente/i.test(q) ? [] : albums })
      if (url.pathname === '/chart/0/artists' || url.pathname === '/search/artist') return jsonp({ data: /zzzz|inexistente/i.test(q) ? [] : artists })
      if (url.pathname.startsWith('/search')) return jsonp({ data: selected(q), total: selected(q).length })
      const match = /^\/(artist|album|track)\/(\d+)(?:\/(albums|top|related|tracks))?$/.exec(url.pathname)
      if (match) {
        const [, type, raw, child] = match, id = Number(raw)
        if (type === 'artist') {
          if (child === 'albums') return jsonp({ data: albums.filter(album => album.artist.id === id) })
          if (child === 'top') return jsonp({ data: tracks.filter(track => track.artist.id === id).slice(0, 10) })
          if (child === 'related') return jsonp({ data: artists.filter(artist => artist.id !== id) })
          return jsonp(artists.find(artist => artist.id === id) || artists[0])
        }
        if (type === 'album') return jsonp(child === 'tracks' ? { data: tracks.filter(track => track.album.id === id) } : albums.find(album => album.id === id) || albums[0])
        return jsonp(tracks.find(track => track.id === id) || tracks[0])
      }
      return jsonp({ error: { code: 800 } })
    }
    if (url.hostname === 'itunes.apple.com') {
      const shows = [false, true].map((english, i) => ({ collectionId: 900 + i, kind: 'podcast',
        collectionName: english ? 'Podcast QA English' : media.rss.showTitle, artistName: 'Autor QA',
        artworkUrl600: cover, feedUrl: 'https://feeds.pletina.test/' + (english ? 'english' : 'rss') }))
      if (url.pathname === '/search') return jsonp({ results: shows, resultCount: shows.length })
      return jsonp({ results: episodes.map((episode, i) => ({ kind: 'podcast-episode', episodeContentType: 'audio',
        episodeUrl: episode.url, trackName: episode.title, episodeGuid: episode.guid, trackTimeMillis: 90000,
        releaseDate: '2026-10-01T12:00:00Z', artworkUrl600: cover, trackId: 9010 + i })) })
    }
    if (url.hostname === 'feeds.pletina.test') return route.fulfill({ status: 200, headers, contentType: 'application/rss+xml', body: rss(url.pathname === '/english') })
    if (url.hostname === 'www.youtube.com' || url.hostname === 'music.youtube.com') {
      let body
      try { body = request.postDataJSON() || {} } catch { body = {} }
      if (url.pathname.endsWith('/browse')) return json(podcastDetail)
      if (url.pathname.endsWith('/search')) {
        if (body.params === 'EgWKAQJQAWoMEA4QChADEAQQCRAF') return json({ items: [podcastShow] })
        const selectedTracks = selected(body.query || '')
        if (url.hostname === 'music.youtube.com') return json({ contents: { tabbedSearchResultsRenderer: { tabs: [{ tabRenderer: {
          content: { sectionListRenderer: { contents: [{ musicShelfRenderer: { contents: selectedTracks.map(musicRow) } }] } },
        } }] } } })
        return json({ responseContext: { visitorData: 'fixture-visitor' }, contents: {
          twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: selectedTracks.map(videoRow) } }] } } },
        } })
      }
      if (url.pathname.endsWith('/player')) {
        if (flags.delayPlayerMs) await new Promise(resolve => setTimeout(resolve, flags.delayPlayerMs))
        if (flags.failPlayer) return json({ playabilityStatus: { status: 'UNPLAYABLE' } })
        const track = tracks.find(track => track.videoId === body.videoId), cast = castVideos.indexOf(body.videoId)
        const bytes = cast >= 0 ? castAudio : audio
        const videoId = body.videoId || tracks[0].videoId
        return json({ playabilityStatus: { status: 'OK' }, videoDetails: { videoId, title: track?.title || 'Episodio QA YouTube ' + titles[Math.max(0, cast)],
          author: track?.artist.name || 'Autor QA', lengthSeconds: String(cast >= 0 ? 90 : 12) },
        streamingData: { adaptiveFormats: [{ mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 64000,
          contentLength: String(bytes.length), url: 'https://fixture.googlevideo.com/audio/' + videoId + '?expire=' + (Math.floor(Date.now() / 1000) + 7200) + '&clen=' + bytes.length }] } })
      }
      return route.abort()
    }
    if (url.hostname === 'fixture.googlevideo.com' || url.hostname === 'media.pletina.test') {
      const download = request.resourceType() === 'fetch'
      if (flags.holdDownload && download) await new Promise(resolve => pending.add(resolve))
      if (flags.failMedia) return route.fulfill({ status: 403, headers, contentType: 'text/plain', body: 'Fixture denied audio' })
      const bytes = url.hostname === 'media.pletina.test' || castVideos.some(id => url.pathname.includes(id)) ? castAudio : audio
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range || '')
      if (range) {
        const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1
        if (start > end || start >= bytes.length) return route.fulfill({ status: 416, headers: { ...headers, 'content-range': 'bytes */' + bytes.length }, body: '' })
        return route.fulfill({ status: 206, headers: { ...headers, 'accept-ranges': 'bytes', 'content-range': 'bytes ' + start + '-' + end + '/' + bytes.length },
          contentType: 'audio/mp4', body: bytes.subarray(start, end + 1) })
      }
      return route.fulfill({ status: 200, headers: { ...headers, 'accept-ranges': 'bytes' }, contentType: 'audio/mp4', body: bytes })
    }
    if (url.hostname === 'open.spotify.com') return route.fulfill({ status: 403, headers, contentType: 'text/html', body: '<!doctype html><title>Fixture access denied</title>' })
    if (['images.pletina.test', 'i.ytimg.com'].includes(url.hostname)) return route.fulfill({ status: 200, headers, contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#6847ab"/><circle cx="100" cy="100" r="50" fill="#bcd784"/></svg>' })
    return route.abort('blockedbyclient')
  }
  let routingActive = false
  async function resumeRoutes() {
    if (!routingActive) { await context.route('**/*', handler); routingActive = true }
  }
  async function suspendRoutes() {
    if (routingActive && context.unroute) { await context.unroute('**/*', handler); routingActive = false }
  }
  await resumeRoutes()
  return { data: { artists, albums, tracks }, artists, albums, tracks, media, requests, counts, flags, set, reset, failNext,
    holdNextCatalogSearch, abortNextLibraryWrite, release, suspendRoutes, resumeRoutes,
    source: 'Synthetic HTTP provider contracts with real silent AAC/MP4 media; no live provider availability or physical phone claim.' }
}
