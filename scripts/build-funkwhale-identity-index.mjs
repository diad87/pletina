/**
 * Generate identity evidence from generic labels, never a per-song source URL.
 * Run: node scripts/build-funkwhale-identity-index.mjs [--input labels.json]
 * Input: [{title,artist,album,titleVersion?:string}]. No audio is written to disk.
 * Full files are hashed; acoustic identity covers official excerpts only.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compareRecordingWaveform } from './tests/helpers/recording-waveform.mjs'

export const POD = 'https://open.audio'
export const LIMITS = Object.freeze({ candidateBytes: 32 * 1024 ** 2, totalAudioBytes: 64 * 1024 ** 2,
  previewBytes: 1024 ** 2, metadataBytes: 2 * 1024 ** 2, candidatesPerRecording: 4,
  requestMilliseconds: 22000, verificationMilliseconds: 60000, maximumDurationSeconds: 900 })
export const DEFAULT_INPUTS = Object.freeze([
  { title: 'Cylinder Six', artist: 'Chris Zabriskie', album: 'Cylinders', titleVersion: '' },
  { title: 'Melted Wings', artist: 'Kai Engel', album: 'Written in Ink', titleVersion: '' },
  { title: '36 Ghosts IV', artist: 'Nine Inch Nails', album: 'Ghosts I-IV', titleVersion: '' },
])
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const HASH = /^[a-f0-9]{64}$/
export const normalize = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ')
export const normalizeIsrc = value => typeof value === 'string' && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(value.trim().replaceAll('-', '').toUpperCase()) ? value.trim().replaceAll('-', '').toUpperCase() : null
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const identifier = value => Number.isSafeInteger(value) && value > 0 && value < 250_000_000_000_000
const duration = value => Number.isFinite(value) && value >= 40 && value <= LIMITS.maximumDurationSeconds
const safeError = error => String(error?.message ?? error).replace(/https?:\/\/[^\s"'<>]+/g, '[URL]').slice(0, 300)
export function validateInput(input) {
  assert.ok(input && typeof input === 'object' && !Array.isArray(input), 'Invalid recording labels')
  assert.ok(Object.keys(input).every(key => ['title', 'artist', 'album', 'titleVersion'].includes(key)), 'Only generic recording labels are accepted')
  for (const key of ['title', 'artist', 'album']) assert.ok(typeof input[key] === 'string' && input[key].length <= 500 && normalize(input[key]), 'Invalid recording ' + key)
  assert.ok(input.titleVersion == null || typeof input.titleVersion === 'string' && input.titleVersion.length <= 500, 'Invalid recording version')
  return { title: input.title.trim(), artist: input.artist.trim(), album: input.album.trim(), titleVersion: input.titleVersion?.trim() ?? '' }
}
export function selectCanonical(input, searched) {
  assert.ok(Array.isArray(searched?.data) && searched.data.length <= 10, 'Invalid canonical search')
  const matches = searched.data.filter(track => identifier(track.id) && identifier(track.artist?.id) && identifier(track.album?.id) && duration(track.duration) &&
    normalize(track.title) === normalize(input.title) && normalize(track.artist.name) === normalize(input.artist) &&
    normalize(track.album.title) === normalize(input.album) && normalize(track.title_version) === normalize(input.titleVersion))
  assert.equal(new Set(matches.map(track => track.id)).size, 1, 'Canonical labels are absent or ambiguous')
  return matches[0]
}
export function hydrateCanonical(selected, fresh) {
  assert.ok(fresh && fresh.id === selected.id && fresh.artist?.id === selected.artist?.id && fresh.album?.id === selected.album?.id &&
    fresh.duration === selected.duration && duration(fresh.duration) && normalize(fresh.title) === normalize(selected.title) &&
    normalize(fresh.artist.name) === normalize(selected.artist.name) && normalize(fresh.album.title) === normalize(selected.album.title) &&
    normalize(fresh.title_version) === normalize(selected.title_version), 'Canonical hydration changed recording identity')
  const isrc = normalizeIsrc(fresh.isrc)
  const preview = typeof fresh.preview === 'string' ? new URL(fresh.preview) : null
  assert.ok(isrc && preview?.protocol === 'https:' && !preview.username && !preview.password && preview.hostname.endsWith('.dzcdn.net'), 'Canonical reference unavailable')
  return { id: fresh.id, isrc, title: fresh.title, titleVersion: fresh.title_version ?? '', artist: fresh.artist.name,
    album: fresh.album.title, duration: fresh.duration, artistId: fresh.artist.id, albumId: fresh.album.id }
}
export function selectNegative(canonical, album) {
  assert.ok(Array.isArray(album?.data) && album.data.length <= 100, 'Invalid canonical album')
  const selected = album.data.find(track => identifier(track.id) && track.id !== canonical.id && duration(track.duration) &&
    normalize(track.title) !== normalize(canonical.title) && normalize(track.artist?.name) === normalize(canonical.artist) && typeof track.preview === 'string')
  assert.ok(selected, 'No distinct same-artist musical negative reference')
  return selected
}
export function assertSourceClaims(canonical, ...claims) {
  for (const claim of claims) {
    if (!claim) continue
    for (const value of [claim.isrc, ...(claim.isrcs ?? [])]) {
      if (value == null || value === '') continue
      assert.equal(normalizeIsrc(value), canonical.isrc, 'Conflicting or malformed source ISRC')
    }
    // The canonical provider exposes no recording MBID. Do not silently accept
    // a declared identity that cannot be corroborated by this generator.
    for (const value of [claim.mbid, claim.recordingMbid, ...(claim.recordingMbids ?? [])]) {
      assert.ok(value == null || value === '', 'Uncorroborated source recording MBID')
    }
    if (claim.titleVersion != null) assert.equal(normalize(claim.titleVersion), normalize(canonical.titleVersion), 'Conflicting source version')
  }
}
function encoding(upload) {
  const mime = String(upload.mimetype ?? '').split(';')[0].trim().toLowerCase(), extension = String(upload.extension ?? '').replace(/^\./, '').toLowerCase()
  const formats = { 'audio/mpeg': ['mp3', false], 'audio/mp3': ['mp3', false], 'audio/ogg': ['vorbis', false],
    'audio/flac': ['flac', true], 'audio/x-flac': ['flac', true], 'audio/mp4': ['aac', false], 'audio/aac': ['aac', false],
    'audio/wav': ['pcm', true], 'audio/x-wav': ['pcm', true] }
  const format = formats[mime]
  return format && /^[a-z0-9]{2,5}$/.test(extension) ? { mime: mime === 'audio/mp3' ? 'audio/mpeg' : mime, extension,
    codec: mime === 'audio/ogg' && (upload.codec === 'opus' || extension === 'opus') ? 'opus' : format[0], lossless: format[1], bitrate: Number.isFinite(upload.bitrate) && upload.bitrate > 0 ? upload.bitrate : null } : null
}
export function providerCandidates(canonical, response) {
  assert.ok(Array.isArray(response?.results) && response.results.length <= 10, 'Invalid public library search')
  const candidates = []
  for (const track of response.results) {
    if (!identifier(track.id) || track.is_local !== true || track.is_playable !== true || track.content_category !== 'music' ||
      normalize(track.title) !== normalize(canonical.title) || normalize(track.album?.title) !== normalize(canonical.album) ||
      track.artist_credit?.length !== 1 || normalize(track.artist_credit[0].credit) !== normalize(canonical.artist) ||
      normalize(track.title_version) !== normalize(canonical.titleVersion)) continue
    try { assertSourceClaims(canonical, { isrc: track.isrc, mbid: track.mbid, titleVersion: track.title_version }) } catch { continue }
    for (const upload of track.uploads ?? []) {
      if (upload.is_local !== true || !duration(upload.duration) || Math.abs(upload.duration - canonical.duration) > 3 ||
        !Number.isSafeInteger(upload.size) || upload.size < 1 || upload.size > LIMITS.candidateBytes || !UUID.test(upload.uuid)) continue
      const format = encoding(upload)
      if (!format) continue
      try {
        assertSourceClaims(canonical, { isrc: upload.isrc, mbid: upload.mbid, recordingMbid: upload.recording_mbid, titleVersion: upload.title_version })
        const url = new URL(upload.listen_url, POD), matched = /^\/api\/v2\/listen\/([a-f0-9-]{36})\/$/i.exec(url.pathname)
        if (url.origin !== POD || url.username || url.password || url.hash || !matched || !UUID.test(matched[1]) ||
          [...url.searchParams.keys()].some(key => key !== 'upload') || url.searchParams.getAll('upload').length !== 1 || url.searchParams.get('upload') !== upload.uuid) continue
        candidates.push({ provider: 'funkwhale', pod: POD, apiVersion: 'v2', trackId: track.id, trackUuid: matched[1].toLowerCase(), uploadUuid: upload.uuid.toLowerCase(),
          title: track.title, titleVersion: track.title_version ?? null, artist: track.artist_credit[0].credit, album: track.album.title,
          duration: upload.duration, contentLength: upload.size, ...format, isrc: normalizeIsrc(track.isrc ?? upload.isrc), recordingMbid: null,
          declaredLicense: typeof track.license === 'string' ? track.license : null })
      } catch { /* A contradictory upload never reaches a media request. */ }
    }
  }
  return candidates.sort((a, b) => Number(b.lossless) - Number(a.lossless) || (b.bitrate ?? b.contentLength * 8 / b.duration) - (a.bitrate ?? a.contentLength * 8 / a.duration) || a.uploadUuid.localeCompare(b.uploadUuid))
}
export function verifiedEntry(canonical, negative, candidate, evidence, generatedAt) {
  assertSourceClaims(canonical, candidate, evidence.identifiers)
  assert.equal(evidence.status, 200, 'Complete audio HTTP 200 required')
  assert.equal(evidence.type, 'cors', 'Readable browser CORS audio required')
  assert.equal(evidence.bytes, candidate.contentLength, 'Complete file length changed')
  assert.ok(HASH.test(evidence.sha256) && HASH.test(evidence.reference?.sha256) && HASH.test(evidence.negative?.sha256), 'Missing full-file or reference hash')
  assert.equal(evidence.mime, candidate.mime, 'File MIME changed')
  assert.ok(Number.isFinite(evidence.duration) && Math.abs(evidence.duration - canonical.duration) <= 3 && Math.abs(evidence.duration - candidate.duration) <= 3, 'Decoded duration conflicts with recording')
  for (const reference of [evidence.reference, evidence.negative]) assert.ok(reference.bytes > 0 && reference.bytes <= LIMITS.previewBytes && reference.duration >= 28 && reference.duration <= 32, 'Invalid official excerpt')
  assert.ok(negative.id !== canonical.id && negative.isrc !== canonical.isrc && normalize(negative.artist) === normalize(canonical.artist) && negative.albumId === canonical.albumId, 'Negative reference identity is not distinct')
  const comparison = evidence.comparison, correlations = [comparison?.full?.correlation, ...(comparison?.windows ?? []).map(window => window.correlation)]
  assert.ok(comparison?.matched === true && correlations.length === 4 && correlations.every(value => Number.isFinite(value) && value >= .8 && value <= 1.0001), 'Excerpt or separated window did not match')
  assert.deepEqual(comparison.windows.map(window => window.referenceStartSeconds), [0, 10, 20])
  const offsets = comparison.windows.map(window => window.inferredPreviewStartInCandidateSeconds)
  assert.ok(offsets.every(Number.isFinite) && Math.max(...offsets) - Math.min(...offsets) <= .03 && comparison.alignmentSpreadSeconds <= .03 &&
    comparison.selfControl?.correlation >= .99 && comparison.negativeControl?.correlation < .4 && comparison.negativeControl?.correlation >= 0, 'Alignment or musical controls failed')
  return { catalog: canonical, source: { provider: candidate.provider, pod: candidate.pod, apiVersion: candidate.apiVersion, trackId: candidate.trackId,
    trackUuid: candidate.trackUuid, uploadUuid: candidate.uploadUuid, contentLength: evidence.bytes, sha256: evidence.sha256, mime: candidate.mime,
    extension: candidate.extension, codec: candidate.codec, bitrate: candidate.bitrate, lossless: candidate.lossless, duration: candidate.duration,
    isrc: candidate.isrc, recordingMbid: null, declaredLicense: candidate.declaredLicense },
    file: { bytes: evidence.bytes, sha256: evidence.sha256, mime: candidate.mime, durationSeconds: evidence.duration },
    proof: { generatedAt, identityScope: 'official-excerpt-only', fullMasterVerified: false, physicalBackgroundVerified: false,
      candidateAudio: { duration: evidence.duration, sampleRate: evidence.sampleRate, channels: evidence.channels },
      reference: { catalogId: canonical.id, isrc: canonical.isrc, ...evidence.reference },
      negative: { catalogId: negative.id, isrc: negative.isrc, title: negative.title, artist: negative.artist, album: negative.album, ...evidence.negative }, comparison },
    downloadAllowed: false }
}

export async function buildIndex(inputs, { fetchJson, verify, now = () => new Date().toISOString(), provenance = {} }) {
  assert.ok(Array.isArray(inputs) && inputs.length > 0 && inputs.length <= 100, 'Use one to 100 generic label inputs')
  const index = { schemaVersion: 1, generatedAt: now(), generator: provenance,
    policy: { identityScope: 'official-excerpt-only', fullMasterVerified: false, downloadAllowed: false, mediaPersisted: false },
    limits: LIMITS, inputs: [], entries: [] }
  const node = await fetchJson(POD + '/api/v1/instance/nodeinfo/2.0/')
  assert.equal(node.metadata?.library?.anonymousCanListen, true, 'Pod does not allow anonymous listening')
  index.provider = { pod: POD, apiVersion: 'v2', softwareVersion: node.software?.version ?? null }
  for (const raw of inputs) {
    const input = validateInput(raw), outcome = { labels: input, status: 'pending', candidates: 0, indexed: 0, rejected: [] }
    index.inputs.push(outcome)
    try {
      const searched = await fetchJson('https://api.deezer.com/search/track?q=' + encodeURIComponent(input.title + ' ' + input.artist) + '&limit=10')
      const selected = selectCanonical(input, searched), detail = await fetchJson('https://api.deezer.com/track/' + selected.id), canonical = hydrateCanonical(selected, detail)
      const album = await fetchJson(`https://api.deezer.com/album/${canonical.albumId}/tracks?limit=100`), selectedNegative = selectNegative(canonical, album)
      const negativeDetail = await fetchJson('https://api.deezer.com/track/' + selectedNegative.id)
      const negative = hydrateCanonical({ ...selectedNegative, album: { id: canonical.albumId, title: canonical.album } }, negativeDetail)
      assert.notEqual(negative.isrc, canonical.isrc, 'Negative ISRC must identify another recording')
      const discovered = await fetchJson(POD + '/api/v2/tracks/?q=' + encodeURIComponent(input.title) + '&page_size=10')
      const candidates = providerCandidates(canonical, discovered); outcome.candidates = candidates.length
      let remaining = LIMITS.totalAudioBytes
      for (const candidate of candidates.slice(0, LIMITS.candidatesPerRecording)) {
        const reservation = candidate.contentLength + 2 * LIMITS.previewBytes
        if (reservation > remaining) { outcome.rejected.push({ uploadUuid: candidate.uploadUuid, reason: 'Aggregate audio byte budget' }); continue }
        // Reserve even for network/decode failures, which can consume bytes
        // without returning evidence. A failed candidate cannot reset a budget.
        remaining -= reservation
        try {
          const evidence = await verify(candidate, detail.preview, negativeDetail.preview, reservation)
          assert.ok(Number.isFinite(evidence.totalBytesRead) && evidence.totalBytesRead >= candidate.contentLength && evidence.totalBytesRead <= reservation, 'Aggregate audio budget exceeded')
          const entry = verifiedEntry(canonical, negative, candidate, evidence, now())
          if (!index.entries.some(old => old.source.uploadUuid === entry.source.uploadUuid && old.catalog.id === entry.catalog.id)) { index.entries.push(entry); outcome.indexed++ }
        } catch (error) { outcome.rejected.push({ uploadUuid: candidate.uploadUuid, reason: safeError(error) }) }
      }
      outcome.status = outcome.indexed ? 'indexed' : 'no-verified-upload'
    } catch (error) { outcome.status = 'rejected'; outcome.rejected.push({ reason: safeError(error) }) }
  }
  return index
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(LIMITS.requestMilliseconds), credentials: 'omit', referrerPolicy: 'no-referrer' })
  if (response.status !== 200 || !response.body) { await response.body?.cancel(); throw new Error('Metadata HTTP ' + response.status) }
  const reader = response.body.getReader(), chunks = []; let length = 0
  try { while (true) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > LIMITS.metadataBytes) throw new Error('Metadata budget exceeded'); chunks.push(part.value) } }
  catch (error) { await reader.cancel().catch(() => {}); throw error }
  return JSON.parse(Buffer.concat(chunks, length).toString('utf8'))
}

async function main() {
  const args = process.argv.slice(2), option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback
  const inputs = args.includes('--input') ? JSON.parse(await readFile(resolve(option('--input')), 'utf8')) : DEFAULT_INPUTS
  const output = resolve(option('--output', 'web-port/funkwhale-identity-index.json'))
  const { default: puppeteer } = await import('puppeteer-core')
  const browser = await puppeteer.launch({ headless: true, executablePath: option('--chrome', process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'), protocolTimeout: 75000 })
  try {
    const page = await browser.newPage(); await page.goto('https://diad87.github.io/pletina/', { waitUntil: 'domcontentloaded', timeout: 30000 })
    const client = await page.createCDPSession(), { result: root } = await client.send('Runtime.evaluate', { expression: 'globalThis', userGesture: false })
    const verifier = async function (candidate, preview, negativePreview, budget) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60000)
      let remaining = budget, totalBytesRead = 0
      const bounded = async (url, max) => {
        const response = await fetch(url, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' })
        if (response.status !== 200 || response.type !== 'cors' || !response.body) { await response.body?.cancel(); throw new Error('Readable complete CORS audio required') }
        if (Number(response.headers.get('content-length')) > Math.min(max, remaining)) { await response.body.cancel(); throw new Error('Declared audio exceeds budget') }
        const reader = response.body.getReader(), chunks = []; let length = 0
        try { while (true) { const part = await reader.read(); if (part.done) break; length += part.value.length; remaining -= part.value.length; totalBytesRead += part.value.length; if (length > max || remaining < 0) throw new Error('Audio byte budget exceeded'); chunks.push(part.value) } }
        catch (error) { await reader.cancel().catch(() => {}); throw error }
        const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
        const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('')
        return { bytes, sha256, response }
      }
      // These bounded tag scans only find contradictions. Missing tags never
      // substitute for the independent canonical excerpt comparison.
      const tags = bytes => {
        const text = new TextDecoder('windows-1252').decode(bytes.subarray(0, 256 * 1024))
        const isrcs = [...text.matchAll(/\bISRC=([A-Z]{2}[A-Z0-9]{3}\d{7})/gi)].map(match => match[1])
        const recordingMbids = [...text.matchAll(/\bMUSICBRAINZ_(?:TRACKID|RECORDINGID)=([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})/gi)].map(match => match[1])
        if (String.fromCharCode(...bytes.subarray(0, 3)) === 'ID3' && [3, 4].includes(bytes[3])) {
          const sync = part => [...part].reduce((sum, value) => sum * 128 + (value & 127), 0), end = Math.min(bytes.length, sync(bytes.subarray(6, 10)) + 10, 256 * 1024)
          for (let position = 10; position + 10 <= end;) {
            const id = String.fromCharCode(...bytes.subarray(position, position + 4)); if (!/^[A-Z0-9]{4}$/.test(id)) break
            const size = bytes[3] === 4 ? sync(bytes.subarray(position + 4, position + 8)) : new DataView(bytes.buffer, bytes.byteOffset + position + 4, 4).getUint32(0)
            if (!size || position + 10 + size > end) break
            const frame = bytes.subarray(position + 10, position + 10 + size)
            if (['TSRC', 'TXXX', 'UFID'].includes(id)) {
              const encoding = id === 'UFID' ? 'utf-8' : frame[0] === 1 ? 'utf-16' : frame[0] === 2 ? 'utf-16be' : frame[0] === 0 ? 'windows-1252' : 'utf-8'
              const text = new TextDecoder(encoding).decode(id === 'UFID' ? frame : frame.subarray(1)).replaceAll('\u0000', ' ')
              if (id === 'TSRC' || /isrc/i.test(text)) isrcs.push(...(text.toUpperCase().match(/\b[A-Z]{2}[A-Z0-9]{3}\d{7}\b/g) ?? []))
              if (/musicbrainz/i.test(text)) recordingMbids.push(...(text.match(/\b[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\b/gi) ?? []))
            }
            position += 10 + size
          }
        }
        return { isrcs: [...new Set(isrcs)], recordingMbids: [...new Set(recordingMbids)] }
      }
      try {
        const url = candidate.pod + '/api/v2/listen/' + candidate.trackUuid + '/?upload=' + candidate.uploadUuid
        const full = await bounded(url, Math.min(candidate.contentLength, 32 * 1024 ** 2)), reference = await bounded(preview, 1024 ** 2), negative = await bounded(negativePreview, 1024 ** 2)
        const context = new OfflineAudioContext(1, 1, 22050), audio = []
        for (const fetched of [full, reference, negative]) audio.push(await context.decodeAudioData(fetched.bytes.buffer.slice(0)))
        return { status: full.response.status, type: full.response.type, bytes: full.bytes.length, sha256: full.sha256,
          mime: full.response.headers.get('content-type')?.split(';')[0].trim().toLowerCase(), duration: audio[0].duration, sampleRate: audio[0].sampleRate,
          channels: audio[0].numberOfChannels, totalBytesRead, identifiers: tags(full.bytes),
          reference: { bytes: reference.bytes.length, sha256: reference.sha256, duration: audio[1].duration },
          negative: { bytes: negative.bytes.length, sha256: negative.sha256, duration: audio[2].duration }, comparison: compare(...audio) }
      } finally { clearTimeout(timer); controller.abort() }
    }
    const wrapped = Function('return async function(...args){const compare=' + compareRecordingWaveform.toString() + ';return await (' + verifier.toString() + ')(...args)}')()
    const verify = async (...values) => {
      const response = await client.send('Runtime.callFunctionOn', { objectId: root.objectId, functionDeclaration: wrapped.toString(),
        arguments: values.map(value => ({ value })), awaitPromise: true, returnByValue: true, userGesture: false })
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
      return response.result.value
    }
    const index = await buildIndex(inputs, { fetchJson, verify, provenance: { script: 'scripts/build-funkwhale-identity-index.mjs',
      sha256: hash(await readFile(new URL(import.meta.url))), helperSha256: hash(await readFile(new URL('./tests/helpers/recording-waveform.mjs', import.meta.url))) } })
    assert.ok(index.entries.length, 'No verified files; existing index not overwritten')
    await writeFile(output, JSON.stringify(index, null, 2) + '\n')
    console.log(JSON.stringify({ output, recordings: new Set(index.entries.map(entry => entry.catalog.id)).size, files: index.entries.length, inputs: index.inputs }, null, 2))
  } finally { await browser.close() }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main().catch(error => { console.error(safeError(error)); process.exitCode = 1 })
