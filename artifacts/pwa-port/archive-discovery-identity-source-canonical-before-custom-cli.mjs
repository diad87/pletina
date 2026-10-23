// Generic bounded Archive discovery -> official catalog preview -> PCM identity diagnostic.
// No curated source registry or song-specific Archive identifier/URL is consulted.
// node scripts/tests/archive-discovery-identity.browser.mjs [--only epoitaitaye|egiozu|iritsi|queen|violadores|tame]
//   [--report safe-name.json] [--chrome executable]
import { mkdir, writeFile } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'
import { compareRecordingWaveform } from './helpers/recording-waveform.mjs'

const args = process.argv.slice(2), option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback
const reportName = option('--report', `archive-discovery-identity-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.json`)
if (!/^[a-z0-9.-]+\.json$/i.test(reportName)) throw new Error('Unsafe report name')
const corpus = [
  { key: 'epoitaitaye', title: 'Epoitaitaye', artist: 'Pirritx Porrotx eta Marimotots', baseline: false },
  { key: 'egiozu', title: 'Egiozu Euskaraz', artist: 'Pirritx Porrotx eta Marimotots', album: 'Irrien Lagunak', baseline: true },
  { key: 'iritsi', title: 'Iritsi da Eguna', artist: 'Pirritx eta Porrotx', album: 'Eskerrik Asko!', baseline: true },
  { key: 'queen', title: 'Bohemian Rhapsody', artist: 'Queen', album: 'A Night At The Opera', baseline: false },
  { key: 'violadores', title: 'A solas con un ritmo lírico', artist: 'Violadores del Verso', baseline: false },
  { key: 'tame', title: 'The Less I Know The Better', artist: 'Tame Impala', album: 'Currents', baseline: false },
].filter(track => !option('--only', null) || track.key === option('--only'))
if (!corpus.length) throw new Error('Unknown corpus selection')
const report = { testedAt: new Date().toISOString(), scope: 'Generic discovery and excerpt identity diagnostics from real Pages origin; browser RAM only. No product/source-registry imports, no special-case source URLs, no accounts/proxies.',
  limits: { maximumArchiveItemsPerTrack: 5, maximumCandidateAudioAttemptsPerTrack: 2, maximumAllAudioBytesPerTrack: 8 * 1024 * 1024, previewMaximumBytesEach: 1024 * 1024 },
  desktopDiagnosticLimits: {
    byteBudgetScope: 'Compressed response bytes read by JavaScript; rejected response bodies are cancelled. This is not a strict bound on bytes already buffered by the browser or transferred on the wire.',
    decodedPcmMemoryBounded: false, decodeSampleRate: 44100, dedicatedWorkerUsed: false, globalPerTrackDeadlineEnforced: false,
    scope: 'Desktop QA only. Full-file decode and waveform work run in the browser page without a PCM allocation limit, dedicated worker or global pipeline deadline; not a deployable mobile runtime.',
  },
  policy: { productChanged: false, published: false, wholeRecordingIdentityClaimed: false, physicalBackgroundClaimed: false, mediaPersisted: false, signedUrlsPersisted: false, userGestureGrantedByObservation: false, browserSecurityOverrides: false, downloadAllowed: false },
  tracks: [], errors: [], archiveTransport: [] }
let browser
const safeError = value => String(value?.message ?? value).replace(/https?:\/\/[^\s"'<>]+/g, '[URL]').slice(0, 350)

async function probeTrack(config) {
  const MAX_ITEMS = 5, MAX_AUDIO = 2, MAX_BYTES = 8 * 1024 * 1024
  const result = { input: config, status: 'pending', catalog: null, searches: [], items: [], candidates: [], comparisons: [], errors: [], audioBytesRead: 0 }
  const normalize = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ')
  const safe = value => String(value ?? '').replace(/https?:\/\/[^\s"'<>]+/g, '[URL]').slice(0, 350)
  const jsonp = path => new Promise((resolve, reject) => {
    const callback = 'archiveDiscovery_' + crypto.randomUUID().replaceAll('-', ''), script = document.createElement('script')
    const done = (error, data) => { clearTimeout(timer); delete window[callback]; script.remove(); error ? reject(error) : resolve(data) }
    const timer = setTimeout(() => done(new Error('Catalog JSONP timeout')), 14000)
    window[callback] = data => done(null, data); script.onerror = () => done(new Error('Catalog JSONP network error'))
    script.src = `https://api.deezer.com/${path}${path.includes('?') ? '&' : '?'}output=jsonp&callback=${callback}`; document.head.append(script)
  })
  const limitedFetch = async (url, maximum, audio = false) => {
    const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(audio ? 22000 : 11000) })
    if (!response.ok || response.type === 'opaque' || !response.body) {
      if (response.body) await response.body.cancel().catch(() => {})
      throw new Error('Unreadable HTTP response ' + response.status)
    }
    const declared = response.headers.get('content-length')
    if (declared !== null && Number(declared) > maximum) {
      await response.body.cancel().catch(() => {})
      throw new Error('Declared response exceeds byte budget')
    }
    const reader = response.body.getReader(), chunks = []
    let length = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        length += part.value.byteLength
        if (audio) result.audioBytesRead += part.value.byteLength
        if (length > maximum || (audio && result.audioBytesRead > MAX_BYTES)) throw new Error('Response exceeds audio/byte budget')
        chunks.push(part.value)
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return { response, bytes }
  }
  const json = async url => {
    const { response, bytes } = await limitedFetch(url, 2 * 1024 * 1024)
    return { status: response.status, value: JSON.parse(new TextDecoder().decode(bytes)) }
  }
  const duration = value => {
    if (typeof value === 'number') return value
    if (typeof value !== 'string' || !value.trim()) return null
    if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value)
    if (/^(?:\d+:){1,2}\d+(?:\.\d+)?$/.test(value)) return value.split(':').reduce((total, part) => total * 60 + Number(part), 0)
    return null
  }
  const audioFile = file => /\.(?:mp3|m4a|ogg|opus|flac|mp4|webm)$/i.test(file.name ?? '') || /^(?:VBR MP3|MP3|Ogg Vorbis|Ogg Opus|Flac|FLAC|AAC|MPEG4 Audio|M4A)$/i.test(file.format ?? '')
  const safeTrack = track => ({ id: track.id, title: safe(track.title), artist: safe(track.artist?.name), album: safe(track.album?.title), duration: track.duration, isrc: track.isrc ?? null, previewAvailable: !!track.preview, titleVersion: track.title_version ?? null })
  let exact, negative
  try {
    const query = config.title
    const found = await jsonp('search/track?q=' + encodeURIComponent(query) + '&limit=25')
    if (!Array.isArray(found.data)) throw new Error('Catalog search shape invalid')
    const matches = found.data.filter(track => Number.isSafeInteger(track.id) && track.id > 0 &&
      normalize(track.title) === normalize(config.title) && normalize(track.artist?.name) === normalize(config.artist) &&
      (!config.album || normalize(track.album?.title) === normalize(config.album)) &&
      !normalize(track.title_version) && Number.isFinite(track.duration) && track.duration > 60)
    if (!matches.length) {
      result.status = 'catalog-no-match'; result.catalogSearch = { returned: found.data.length, firstResults: found.data.slice(0, 5).map(safeTrack) }; return result
    }
    const selected = matches[0]
    exact = await jsonp('track/' + selected.id)
    const canonicalDetail = exact && exact.id === selected.id && Number.isSafeInteger(exact.id) && exact.id > 0 &&
      exact.artist?.id === selected.artist?.id && exact.album?.id === selected.album?.id &&
      normalize(exact.title) === normalize(selected.title) && normalize(exact.title) === normalize(config.title) &&
      normalize(exact.artist?.name) === normalize(selected.artist?.name) && normalize(exact.artist?.name) === normalize(config.artist) &&
      normalize(exact.album?.title) === normalize(selected.album?.title) && (!config.album || normalize(exact.album?.title) === normalize(config.album)) &&
      normalize(exact.title_version) === normalize(selected.title_version) && !normalize(exact.title_version) &&
      Number.isFinite(exact.duration) && exact.duration === selected.duration && exact.duration > 60 &&
      typeof exact.isrc === 'string' && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(exact.isrc) &&
      (!selected.isrc || selected.isrc === exact.isrc)
    result.catalogHydration = { selectedId: selected.id, detailId: exact?.id ?? null,
      sameArtistId: exact?.artist?.id === selected.artist?.id, sameAlbumId: exact?.album?.id === selected.album?.id,
      canonicalIdentityChecked: !!canonicalDetail, requestedAlbumEqualityRequired: !!config.album,
      selected: safeTrack(selected), hydrated: exact ? safeTrack(exact) : null }
    if (!canonicalDetail) throw new Error('Hydrated catalog detail does not match the selected canonical recording')
    if (!exact.preview) throw new Error('Exact canonical catalog detail lacks reference audio')
    result.catalog = safeTrack(exact)
    const album = await jsonp(`album/${exact.album.id}/tracks?limit=30`)
    const other = album.data?.find(track => track.id !== exact.id && normalize(track.title) !== normalize(exact.title) && track.duration > 60 && track.preview)
    if (other) negative = await jsonp('track/' + other.id)
    result.negativeCatalogControl = negative ? safeTrack(negative) : null
  } catch (error) { result.errors.push({ stage: 'catalog', error: safe(error.message) }); result.status = 'probe-error'; return result }

  const phrase = value => '"' + value.replaceAll(/["\\]/g, ' ') + '"'
  const titleQuery = `mediatype:audio AND (${phrase(exact.title)})`
  // Discovery tolerates catalog punctuation/artist-credit differences. Artist
  // tokens narrow an album search; they never establish recording identity.
  const artistTokens = [...new Set(normalize(exact.artist.name).split(' ').filter(token => token.length >= 4))]
  const albumQuery = `mediatype:audio AND (${phrase(exact.album.title)}) AND (${artistTokens.map(phrase).join(' OR ') || phrase(exact.artist.name)})`
  const itemIds = new Set(), items = []
  for (const [kind, query, rows] of [['title', titleQuery, 3], ['album-and-artist', albumQuery, 2]]) {
    try {
      const url = new URL('https://archive.org/advancedsearch.php')
      url.searchParams.set('q', query); url.searchParams.set('output', 'json'); url.searchParams.set('rows', String(rows)); url.searchParams.set('page', '1')
      for (const field of ['identifier', 'title', 'creator']) url.searchParams.append('fl[]', field)
      const { status, value } = await json(url.href)
      if (!value.response || !Array.isArray(value.response.docs) || !Number.isFinite(value.response.numFound)) throw new Error('Archive search shape invalid')
      const discovered = []
      for (const item of value.response.docs) {
        if (typeof item.identifier !== 'string' || !/^[\w.-]+$/.test(item.identifier) || itemIds.has(item.identifier) || items.length >= MAX_ITEMS) continue
        itemIds.add(item.identifier); items.push(item); discovered.push(item.identifier)
      }
      result.searches.push({ kind, query, httpStatus: status, numFound: value.response.numFound, discovered })
    } catch (error) { result.errors.push({ stage: 'archive-search-' + kind, error: safe(error.message) }) }
  }
  const metadata = await Promise.allSettled(items.map(async item => {
    const { status, value } = await json('https://archive.org/metadata/' + encodeURIComponent(item.identifier))
    if (!value.metadata || !Array.isArray(value.files)) throw new Error('Archive metadata/filelist shape invalid')
    const restricted = value.is_dark === true || value.metadata['access-restricted-item'] === 'true'
    const observation = { id: item.identifier, status, title: safe(value.metadata.title), creatorDeclared: safe(value.metadata.creator), restricted, fileCount: value.files.length, licenseDeclared: safe(value.metadata.licenseurl), uploaderNotTreatedAsArtist: true,
      mediaFilesObserved: value.files.filter(audioFile).slice(0, 15).map(file => ({ fileName: safe(file.name), bytes: Number(file.size), declaredDuration: duration(file.length), format: safe(file.format), source: safe(file.source) })) }
    result.items.push(observation)
    if (restricted) return []
    const wanted = normalize(exact.title), artist = normalize(exact.artist.name), candidates = []
    for (const file of value.files) {
      const name = file.name
      if (typeof name !== 'string' || !audioFile(file) || name.length > 1000 || name.split('/').some(part => part === '.' || part === '..') || file.private === 'true') continue
      const bytes = Number(file.size), seconds = duration(file.length), text = normalize(name.replace(/\.[^.]+$/, ''))
      if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_BYTES) continue
      const nameHasTitle = text.includes(wanted), itemHasTitle = normalize(value.metadata.title).includes(wanted)
      if (!nameHasTitle && !(itemHasTitle && value.files.filter(audioFile).length === 1)) continue
      if (seconds !== null && Math.abs(seconds - exact.duration) > Math.max(25, exact.duration * 0.15)) continue
      const score = (nameHasTitle ? 10 : 0) + (itemHasTitle ? 3 : 0) + (text.includes(artist) ? 2 : 0) + (file.source === 'original' ? 1 : 0)
      const path = name.split('/').map(encodeURIComponent).join('/')
      const endpoints = [{ kind: 'archive-download', url: 'https://archive.org/download/' + encodeURIComponent(item.identifier) + '/' + path }]
      // The Archive metadata API publishes its own serving host/directory. This
      // is a provider CDN, not a proxy, and normal CORS still applies.
      if (typeof value.d1 === 'string' && /^[a-z0-9.-]+\.archive\.org$/i.test(value.d1) && typeof value.dir === 'string' && /^\/\d+\/items\/[\w.-]+$/.test(value.dir)) endpoints.push({ kind: 'provider-cdn', url: 'https://' + value.d1 + value.dir + '/' + path })
      candidates.push({ item: item.identifier, fileName: name, bytes, declaredDuration: seconds, fileTitle: safe(file.title), source: safe(file.source), score, endpoints })
    }
    return candidates
  }))
  const candidates = []
  for (let i = 0; i < metadata.length; i++) {
    const value = metadata[i]
    if (value.status === 'fulfilled') candidates.push(...value.value)
    else result.errors.push({ stage: 'archive-metadata', item: items[i].identifier, error: safe(value.reason?.message ?? value.reason) })
  }
  candidates.sort((a, b) => b.score - a.score || a.bytes - b.bytes)
  result.candidates = candidates.slice(0, 10).map(({ endpoints, ...safe }) => ({ ...safe, endpointKinds: endpoints.map(endpoint => endpoint.kind) }))
  result.discoveryCompleteWithinBounds = !result.errors.some(error => error.stage.startsWith('archive-search-') || error.stage === 'archive-metadata')
  if (!candidates.length) {
    result.status = result.discoveryCompleteWithinBounds ? 'no-candidates' : 'probe-error'
    result.statusDetail = result.discoveryCompleteWithinBounds ? 'No eligible audio candidate inside the bounded item/format/size/duration policy; not universal catalog absence.' : 'Discovery incomplete because at least one search or metadata request failed.'
    return result
  }

  const context = new OfflineAudioContext(2, 1, 44100)
  const fetchDecode = async (url, maxBytes) => {
    const { bytes, response } = await limitedFetch(url, Math.min(maxBytes, MAX_BYTES - result.audioBytesRead), true)
    const length = bytes.byteLength, sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('')
    const buffer = await context.decodeAudioData(bytes.buffer)
    return { buffer, details: { httpStatus: response.status, corsReadable: true, bytes: length, sha256, duration: buffer.duration, sampleRate: buffer.sampleRate } }
  }
  let reference, negativeReference
  try {
    reference = await fetchDecode(exact.preview, 1024 * 1024)
    result.referenceAudio = reference.details
    if (negative?.preview) { negativeReference = await fetchDecode(negative.preview, 1024 * 1024); result.negativeAudio = negativeReference.details }
    if (!negativeReference) throw new Error('No decoded distinct-song negative control; identity cannot be accepted')
  } catch (error) { result.errors.push({ stage: 'reference-audio', error: safe(error.message) }); result.status = 'probe-error'; return result }
  let attempts = 0
  for (const candidate of candidates) {
    if (attempts >= MAX_AUDIO) break
    if (candidate.bytes > MAX_BYTES - result.audioBytesRead) { result.errors.push({ stage: 'budget', item: candidate.item, fileName: safe(candidate.fileName), reason: 'Candidate does not fit remaining bounded audio budget' }); continue }
    for (const endpoint of candidate.endpoints) {
      if (attempts >= MAX_AUDIO) break
      attempts++
      const comparison = { item: candidate.item, fileName: candidate.fileName, endpointKind: endpoint.kind, attempt: attempts, status: 'pending' }
      try {
      const audio = await fetchDecode(endpoint.url, candidate.bytes + 4096)
      comparison.audio = audio.details
      const fullDuration = Math.abs(audio.buffer.duration - exact.duration) <= Math.max(25, exact.duration * 0.15)
      if (!fullDuration) { comparison.status = 'rejected-duration'; comparison.expectedDuration = exact.duration }
      else {
        comparison.waveform = compare(audio.buffer, reference.buffer, negativeReference.buffer)
        comparison.status = comparison.waveform.matched ? 'verified-excerpt-match' : 'rejected-waveform'
      }
      } catch (error) { comparison.status = 'probe-error'; comparison.error = safe(error.message) }
      result.comparisons.push(comparison)
      // Only retry another endpoint after a transport failure. A readable file
      // rejected acoustically must never be retried into a match.
      if (comparison.status !== 'probe-error') break
    }
  }
  result.candidateAudioAttempts = attempts
  result.verificationIncomplete = !result.discoveryCompleteWithinBounds || result.comparisons.some(comparison => comparison.status === 'probe-error')
  result.status = result.comparisons.some(comparison => comparison.status === 'verified-excerpt-match') ? 'verified-excerpt-match'
    : result.verificationIncomplete ? 'probe-error' : result.comparisons.some(comparison => comparison.status.startsWith('rejected')) ? 'no-verified-match' : 'probe-error'
  return result
}

try {
  browser = await puppeteer.launch({ executablePath: option('--chrome', 'C:/Users/iunan/.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe'), headless: true,
    ignoreDefaultArgs: ['--mute-audio', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], args: [], protocolTimeout: 240000 })
  const page = await browser.newPage()
  const observedRequests = new Map()
  let currentTrack = null
  const client = page.mainFrame().client
  await client.send('Network.enable')
  client.on('Network.requestWillBeSent', event => {
    const url = new URL(event.request.url)
    if (url.hostname === 'archive.org' || url.hostname.endsWith('.archive.org')) observedRequests.set(event.requestId, { track: currentTrack, host: url.hostname })
  })
  client.on('Network.loadingFailed', event => {
    const request = observedRequests.get(event.requestId)
    if (request) report.archiveTransport.push({ ...request, errorText: safeError(event.errorText), corsErrorStatus: event.corsErrorStatus ?? null, blockedReason: event.blockedReason ?? null })
  })
  await page.goto('https://diad87.github.io/pletina/', { waitUntil: 'domcontentloaded', timeout: 45000 })
  report.origin = new URL(page.url()).origin
  const probe = Function('return async function(config) { const compare = ' + compareRecordingWaveform.toString() + '; return await (' + probeTrack.toString() + ')(config); }')()
  for (const track of corpus) {
    currentTrack = track.key
    console.log('Discovering and verifying:', track.key)
    const context = page.mainFrame().mainRealm().context
    const response = await page.mainFrame().client.send('Runtime.callFunctionOn', { executionContextId: context.id, functionDeclaration: probe.toString(), arguments: [{ value: track }], awaitPromise: true, returnByValue: true, userGesture: false })
    if (response.exceptionDetails) report.tracks.push({ input: track, status: 'probe-error', error: safeError(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text) })
    else report.tracks.push(response.result.value)
    const result = report.tracks.at(-1)
    console.log(JSON.stringify({ track: track.key, status: result.status, catalog: result.catalog, searches: result.searches, candidates: result.candidates?.length, comparisons: result.comparisons?.map(item => ({ item: item.item, status: item.status, correlation: item.waveform?.full.correlation })), errors: result.errors }))
    await mkdir(new URL('../../artifacts/pwa-port/', import.meta.url), { recursive: true })
    await writeFile(new URL('../../artifacts/pwa-port/' + reportName, import.meta.url), JSON.stringify(report, null, 2) + '\n')
  }
} catch (error) { report.errors.push(safeError(error)) }
finally { await browser?.close() }
report.summary = { tracks: report.tracks.length, excerptMatches: report.tracks.filter(track => track.status === 'verified-excerpt-match').length,
  newExcerptMatches: report.tracks.filter(track => !track.input.baseline && track.status === 'verified-excerpt-match').map(track => track.input.key),
  baselinesMatched: report.tracks.filter(track => track.input.baseline && track.status === 'verified-excerpt-match').map(track => track.input.key),
  outcomes: Object.fromEntries(report.tracks.map(track => [track.input.key, track.status])) }
await mkdir(new URL('../../artifacts/pwa-port/', import.meta.url), { recursive: true })
await writeFile(new URL('../../artifacts/pwa-port/' + reportName, import.meta.url), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ report: reportName, summary: report.summary, errors: report.errors }, null, 2))
if (report.errors.length) process.exitCode = 1
