// Anonymous public-library discovery -> canonical reference identity -> native audio.
// QA only: no product registry/imports, credentials, native bridge, proxy or persisted media.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import puppeteer from 'puppeteer-core'
import { compareRecordingWaveform } from './helpers/recording-waveform.mjs'

const args = process.argv.slice(2), option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback
const config = { title: option('--title', 'Cylinder Six'), artist: option('--artist', 'Chris Zabriskie'), album: option('--album', 'Cylinders'), titleVersion: option('--version', '') }
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const report = { schemaVersion: 1, testedAt: new Date().toISOString(), input: config,
  scope: 'Real public Funkwhale library through the Pages origin, selected via title/artist/album then official catalog detail and excerpt acoustic comparison. Browser-only native audio, seek and hidden tab.',
  providerResponsesMocked: false, noRuntimeBackend: true, noAccountsSubscriptionsOrKeys: true, credentials: 'omit',
  productChanged: false, mediaOrSignedUrlsPersisted: false, physicalDevice: false, phoneScreenOffVerified: false,
  wholeMasterVerified: false,
  execution: { scriptSha256: sha256(await readFile(new URL(import.meta.url))), helperSha256: sha256(await readFile(new URL('./helpers/recording-waveform.mjs', import.meta.url))) },
  checks: [], errors: [] }
const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ignoreDefaultArgs: ['--mute-audio', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], protocolTimeout: 120000 })
let passed = false
try {
  const page = await browser.newPage()
  await page.goto('https://diad87.github.io/pletina/', { waitUntil: 'domcontentloaded', timeout: 30000 })
  const session = await page.createCDPSession()
  const { result: root } = await session.send('Runtime.evaluate', { expression: 'globalThis', userGesture: false })
  const evaluate = async (fn, ...parameters) => {
    const { result, exceptionDetails } = await session.send('Runtime.callFunctionOn', { objectId: root.objectId,
      functionDeclaration: fn.toString(), arguments: parameters.map(value => ({ value })), awaitPromise: true, returnByValue: true, userGesture: false })
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text)
    return result.value
  }
  const probe = async function (config) {
    const normalize = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    const id3Identifiers = bytes => {
      const out = { tagVersion: null, inspectedFrames: [], isrc: [], recordingMbids: [] }
      if (String.fromCharCode(...bytes.subarray(0, 3)) !== 'ID3') return out
      out.tagVersion = bytes[3]
      if (![3, 4].includes(bytes[3])) return out
      const sync = part => [...part].reduce((total, value) => total * 128 + (value & 127), 0)
      const end = Math.min(bytes.length, sync(bytes.subarray(6, 10)) + 10)
      for (let position = 10; position + 10 <= end;) {
        const id = String.fromCharCode(...bytes.subarray(position, position + 4))
        if (!/^[A-Z0-9]{4}$/.test(id)) break
        const size = bytes[3] === 4 ? sync(bytes.subarray(position + 4, position + 8)) : new DataView(bytes.buffer, bytes.byteOffset + position + 4, 4).getUint32(0)
        if (!size || position + 10 + size > end) break
        out.inspectedFrames.push(id)
        const frame = bytes.subarray(position + 10, position + 10 + size)
        if (['TSRC', 'TXXX', 'UFID'].includes(id)) {
          const encoding = id === 'UFID' ? 'utf-8' : frame[0] === 1 ? 'utf-16' : frame[0] === 2 ? 'utf-16be' : frame[0] === 0 ? 'windows-1252' : 'utf-8'
          const text = new TextDecoder(encoding).decode(id === 'UFID' ? frame : frame.subarray(1)).replaceAll('\u0000', ' ').trim()
          if (id === 'TSRC' || /isrc/i.test(text)) out.isrc.push(...(text.toUpperCase().match(/\b[A-Z]{2}[A-Z0-9]{3}\d{7}\b/g) ?? []))
          if (id === 'UFID' && /musicbrainz/i.test(text) || /musicbrainz.*(?:track|recording)/i.test(text)) out.recordingMbids.push(...(text.match(/\b[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\b/gi) ?? []))
        }
        position += 10 + size
      }
      out.inspectedFrames = [...new Set(out.inspectedFrames)]
      return out
    }
    const vorbisIdentifiers = bytes => {
      if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'OggS') return null
      // Bounded ASCII-key inspection, not an exhaustive container/tag parser.
      const text = new TextDecoder('windows-1252').decode(bytes.subarray(0, 256 * 1024))
      return { inspectedBytes: Math.min(bytes.length, 256 * 1024),
        isrc: [...text.matchAll(/\bISRC=([A-Z]{2}[A-Z0-9]{3}\d{7})/gi)].map(match => match[1].toUpperCase()),
        recordingMbids: [...text.matchAll(/\bMUSICBRAINZ_TRACKID=([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})/gi)].map(match => match[1]),
      }
    }
    const jsonp = path => new Promise((resolve, reject) => {
      const callback = 'funkwhaleCanonical_' + crypto.randomUUID().replaceAll('-', ''), script = document.createElement('script')
      const done = (error, data) => { clearTimeout(timer); script.remove(); delete window[callback]; error ? reject(error) : resolve(data) }
      const timer = setTimeout(() => done(new Error('Catalog JSONP timeout')), 12000)
      window[callback] = value => done(null, value); script.onerror = () => done(new Error('Catalog metadata network error'))
      script.src = `https://api.deezer.com/${path}${path.includes('?') ? '&' : '?'}output=jsonp&callback=${callback}`; document.head.append(script)
    })
    const boundedFetch = async (url, maximum) => {
      const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(22000), referrerPolicy: 'no-referrer' })
      if (!response.ok || response.type === 'opaque' || !response.body) { void response.body?.cancel(); throw new Error('Unreadable provider HTTP ' + response.status) }
      const declared = response.headers.get('content-length')
      if (declared !== null && Number(declared) > maximum) { await response.body.cancel(); throw new Error('Declared body exceeds limit') }
      const reader = response.body.getReader(), chunks = []; let length = 0
      try {
        while (true) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > maximum) throw new Error('Body exceeds limit'); chunks.push(part.value) }
      } catch (error) { await reader.cancel().catch(() => {}); throw error }
      const bytes = new Uint8Array(length); let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
      return { bytes, response }
    }
    const json = async url => { const { bytes, response } = await boundedFetch(url, 2 * 1024 ** 2); return { value: JSON.parse(new TextDecoder().decode(bytes)), status: response.status, type: response.type } }
    const node = await json('https://open.audio/api/v1/instance/nodeinfo/2.0/')
    if (node.value.metadata?.library?.anonymousCanListen !== true) throw new Error('The public pod does not permit anonymous listening')
    const searched = await jsonp('search/track?q=' + encodeURIComponent(`${config.title} ${config.artist}`) + '&limit=10')
    const selected = searched.data?.find(track => normalize(track.title) === normalize(config.title) && normalize(track.artist?.name) === normalize(config.artist) &&
      normalize(track.album?.title) === normalize(config.album) && normalize(track.title_version) === normalize(config.titleVersion))
    if (!selected) return { status: 'canonical-not-found', library: { count: node.value.metadata.library.tracks?.total } }
    const canonical = await jsonp('track/' + selected.id)
    if (canonical.id !== selected.id || canonical.artist?.id !== selected.artist?.id || canonical.album?.id !== selected.album?.id ||
      normalize(canonical.title) !== normalize(selected.title) || normalize(canonical.artist.name) !== normalize(selected.artist.name) || normalize(canonical.album.title) !== normalize(selected.album.title) ||
      canonical.duration !== selected.duration || normalize(canonical.title_version) !== normalize(selected.title_version) || normalize(canonical.title_version) !== normalize(config.titleVersion) ||
      !/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(canonical.isrc) || !canonical.preview) throw new Error('Canonical hydration mismatch')
    const album = await jsonp(`album/${canonical.album.id}/tracks?limit=30`)
    const negative = album.data?.find(track => track.id !== canonical.id && track.preview && track.duration >= 40)
    if (!negative) throw new Error('No distinct musical negative control')
    const result = { status: 'pending', library: { anonymousCanListen: true, metadataTracks: node.value.metadata.library.tracks?.total, softwareVersion: node.value.software?.version },
      canonicalSelection: { id: selected.id, title: selected.title, artist: selected.artist.name, album: selected.album.title, duration: selected.duration, titleVersion: selected.title_version ?? null },
      canonical: { id: canonical.id, title: canonical.title, titleVersion: canonical.title_version ?? null, artist: canonical.artist.name, album: canonical.album.title, duration: canonical.duration, isrc: canonical.isrc },
      canonicalIdentityChecks: { sameTrackId: true, sameArtistId: true, sameAlbumId: true, sameTitleArtistAlbum: true, sameDuration: true, sameTitleVersion: true, requestedVersionEqual: true, isrcFormatValid: true },
      negative: { id: negative.id, title: negative.title, titleVersion: negative.title_version ?? null }, rejected: [], metadata: null }
    const discovered = await json('https://open.audio/api/v2/tracks/?q=' + encodeURIComponent(config.title) + '&page_size=10')
    result.metadata = { status: discovered.status, type: discovered.type, count: discovered.value.count }
    const candidates = []
    for (const track of discovered.value.results ?? []) {
      const identity = normalize(track.title) === normalize(canonical.title) && normalize(track.album?.title) === normalize(canonical.album.title) &&
        track.artist_credit?.length === 1 && normalize(track.artist_credit[0].credit) === normalize(canonical.artist.name)
      const upload = track.uploads?.find(upload => upload.is_local && Number.isFinite(upload.duration) && Math.abs(upload.duration - canonical.duration) <= 3 && upload.size > 0 && upload.size <= 8 * 1024 ** 2)
      if (!identity || !track.is_local || !track.is_playable || track.content_category !== 'music' || !upload) {
        result.rejected.push({ id: track.id, title: track.title, artists: track.artist_credit?.map(credit => credit.credit), album: track.album?.title,
          playable: track.is_playable, local: track.is_local, eligibleIdentity: identity, eligibleUpload: !!upload }); continue
      }
      const url = new URL(upload.listen_url, 'https://open.audio')
      if (url.origin !== 'https://open.audio' || !/^\/api\/v2\/listen\/[a-f0-9-]{36}\/$/.test(url.pathname) ||
        [...url.searchParams.keys()].some(key => key !== 'upload') || url.searchParams.get('upload') !== upload.uuid) throw new Error('Unexpected provider listen route')
      candidates.push({ track, upload, url: url.href })
    }
    if (!candidates.length) { result.status = 'no-eligible-public-file'; return result }
    const picked = candidates[0], full = await boundedFetch(picked.url, 8 * 1024 ** 2)
    if (full.bytes.length !== picked.upload.size) throw new Error('Complete provider file size does not match metadata')
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', full.bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('')
    const reference = await boundedFetch(canonical.preview, 1024 ** 2), other = await boundedFetch(negative.preview, 1024 ** 2)
    const hashBytes = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('')
    result.referenceAudio = { bytes: reference.bytes.length, sha256: await hashBytes(reference.bytes), status: reference.response.status, type: reference.response.type }
    result.negativeAudio = { bytes: other.bytes.length, sha256: await hashBytes(other.bytes), status: other.response.status, type: other.response.type }
    const context = new OfflineAudioContext(1, 1, 22050)
    const fullDecoded = await context.decodeAudioData(full.bytes.buffer.slice(0))
    const referenceDecoded = await context.decodeAudioData(reference.bytes.buffer)
    const otherDecoded = await context.decodeAudioData(other.bytes.buffer)
    result.referenceAudio.duration = referenceDecoded.duration
    result.negativeAudio.duration = otherDecoded.duration
    const waveform = compare(fullDecoded, referenceDecoded, otherDecoded)
    const delivered = new URL(full.response.url), signedFields = [...delivered.searchParams.keys()].filter(key => /signature|credential|expires|token/i.test(key))
    result.source = { provider: 'funkwhale', pod: 'open.audio', id: picked.track.id, uploadId: picked.upload.uuid, localUpload: picked.upload.is_local, declaredLicense: picked.track.license ?? null,
      bytes: full.bytes.length, sha256: digest, status: full.response.status, type: full.response.type,
      contentType: full.response.headers.get('content-type'), duration: fullDecoded.duration, sampleRate: fullDecoded.sampleRate, channels: fullDecoded.numberOfChannels,
      delivery: { redirected: full.response.redirected, host: delivered.hostname, signedQueryFieldsPresent: signedFields.length > 0,
        declaredValiditySeconds: /^\d+$/.test(delivered.searchParams.get('X-Amz-Expires') ?? '') ? Number(delivered.searchParams.get('X-Amz-Expires')) : null, fullUrlPersisted: false },
      identityMetadata: { trackMbid: picked.track.mbid ?? null, trackIsrc: picked.track.isrc ?? null, uploadMbid: picked.upload.mbid ?? null, uploadIsrc: picked.upload.isrc ?? null,
        trackIdentityFields: Object.keys(picked.track).filter(key => /isrc|mbid|musicbrainz/i.test(key)), uploadIdentityFields: Object.keys(picked.upload).filter(key => /isrc|mbid|musicbrainz/i.test(key)), id3: id3Identifiers(full.bytes), vorbis: vorbisIdentifiers(full.bytes) } }
    result.waveform = waveform
    result.status = waveform.matched && Math.abs(fullDecoded.duration - canonical.duration) <= 3 ? 'verified-excerpt-match' : 'rejected-waveform-or-duration'
    if (result.status === 'verified-excerpt-match') {
      const blob = URL.createObjectURL(new Blob([full.bytes], { type: full.response.headers.get('content-type')?.split(';')[0] || picked.upload.mimetype }))
      const audio = new Audio(blob); audio.volume = 0.25
      globalThis.__funkwhaleCanonical = { audio, blob }
      const button = document.createElement('button'); button.id = 'funkwhale-canonical-play'; button.textContent = 'Play verified public-library recording'
      button.onclick = event => { globalThis.__funkwhaleCanonical.trustedClick = event.isTrusted; audio.play().catch(error => globalThis.__funkwhaleCanonical.playError = error.name) }
      document.body.prepend(button)
    }
    return result
  }
  const wrapped = Function('return async function(config) { const compare = ' + compareRecordingWaveform.toString() + '; return await (' + probe.toString() + ')(config); }')()
  const identity = await evaluate(wrapped, config)
  report.checks.push({ name: 'Canonical public-library identity and complete-file cross-origin access', ...identity })
  assert.equal(identity.status, 'verified-excerpt-match')
  await page.click('#funkwhale-canonical-play')
  const snapshot = () => evaluate(function () {
    const probe = globalThis.__funkwhaleCanonical, audio = probe.audio
    return { time: audio.currentTime, duration: Number.isFinite(audio.duration) ? audio.duration : null, paused: audio.paused,
      muted: audio.muted, error: audio.error?.code ?? null, playError: probe.playError ?? null, trustedClick: probe.trustedClick, visibility: document.visibilityState }
  })
  const until = async condition => {
    const started = Date.now()
    while (Date.now() - started < 20000) { const value = await snapshot(); if (condition(value)) return value; if (value.error || value.playError) throw new Error(JSON.stringify(value)); await new Promise(resolve => setTimeout(resolve, 250)) }
    throw new Error('Native verified public-library playback timed out')
  }
  const initial = await until(value => value.time > 2 && !value.paused)
  const midpoint = initial.duration / 2
  await evaluate(function (time) { globalThis.__funkwhaleCanonical.audio.currentTime = time }, midpoint)
  const afterSeek = await until(value => value.time > midpoint + 1 && !value.paused)
  const front = await browser.newPage(); await front.goto('about:blank'); await front.bringToFront()
  const hiddenBefore = await snapshot(); await new Promise(resolve => setTimeout(resolve, 10000)); const hiddenAfter = await snapshot()
  assert.ok(hiddenAfter.time - hiddenBefore.time > 8); assert.equal(hiddenAfter.visibility, 'hidden')
  report.checks.push({ name: 'One trusted click, native audio/seek and hidden-tab progression', initial, afterSeek, hiddenBefore, hiddenAfter })
  await page.bringToFront()
  await evaluate(function () { const probe = globalThis.__funkwhaleCanonical; probe.audio.pause(); probe.audio.removeAttribute('src'); probe.audio.load(); URL.revokeObjectURL(probe.blob) })
  passed = true
} catch (error) {
  report.errors.push({ name: error.name, message: String(error.message).replace(/https?:\/\/[^\s]+/g, '[URL]').slice(0, 1000) })
  process.exitCode = 1
} finally {
  await browser.close(); report.pass = passed
  const directory = new URL('../../artifacts/pwa-port/', import.meta.url); await mkdir(directory, { recursive: true })
  const name = 'funkwhale-canonical-' + report.testedAt.replace(/[:.]/g, '-') + '.json'
  await writeFile(new URL(name, directory), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ pass: passed, report: name, checks: report.checks.length, errors: report.errors }))
}
