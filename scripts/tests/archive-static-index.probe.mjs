// QA only: generate a metadata index from generic discovery, verify outside the
// browser at build time, then test ordinary opaque HTMLAudio from Pages.
// No runtime proxy, app module, security override or stored media is used.
// node scripts/tests/archive-static-index.probe.mjs [--keys tame,egiozu,queen]
//   [--discovery artifacts/pwa-port/archive-discovery-identity-corpus-2026-10-23-final.json]
//   [--report safe-name.json] [--chrome executable]
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'
import { compareRecordingWaveform } from './helpers/recording-waveform.mjs'

const args = process.argv.slice(2), option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback
const discoveryPath = option('--discovery', 'artifacts/pwa-port/archive-discovery-identity-corpus-2026-10-23-final.json')
const keys = option('--keys', 'tame,egiozu,queen').split(',')
const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
const reportName = option('--report', `archive-static-index-${stamp}.json`)
assert.match(reportName, /^[a-z0-9.-]+\.json$/i)
const output = new URL('../../artifacts/pwa-port/', import.meta.url)
const discovery = JSON.parse(await readFile(new URL('../../' + discoveryPath, import.meta.url), 'utf8'))
const normalize = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ')
const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex')
const safeError = error => String(error?.message ?? error).replace(/https?:\/\/[^\s"'<>]+/g, '[URL]').slice(0, 450)
const report = { testedAt: new Date().toISOString(), input: discoveryPath,
  scope: 'Experimental metadata-only static index generated from generic discovery results. Build-time HTTP and PCM comparison are explicitly separate from browser runtime metadata checks and opaque HTMLAudio playback. No product modules or registry are imported.',
  policy: { productChanged: false, published: false, runtimeBackend: false, accountRequired: false, securityOverrides: false,
    mediaPersisted: false, downloadAllowed: false, fullMasterIdentityProven: false, physicalScreenOffVerified: false },
  limits: { compressedAudioBytesPerTrack: 8 * 1024 * 1024, candidateAttemptsPerTrack: 1,
    decodedPcmMemoryBounded: false, desktopOnly: true, acousticCoverage: 'Approximately 30-second official excerpt, not every second of the master.' },
  index: { schemaVersion: 1, generatedAt: new Date().toISOString(), entries: [] }, tracks: [], errors: [] }

async function bytesFrom(url, max, audio, trace) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(new DOMException('HTTP timeout', 'TimeoutError')), 30000)
  let response
  try {
    response = await fetch(url, { signal: controller.signal, credentials: 'omit' })
    const final = new URL(response.url)
    const observation = { status: response.status, host: final.hostname, contentType: response.headers.get('content-type'),
      declaredBytes: Number(response.headers.get('content-length')) || null, corsPolicy: response.headers.get('access-control-allow-origin') }
    trace.push(observation)
    if (response.status !== 200 || !response.body || observation.declaredBytes > max) throw new Error('HTTP status or declared byte budget rejected: ' + response.status)
    if (audio && !(final.hostname === 'archive.org' || final.hostname.endsWith('.archive.org') || final.hostname.endsWith('.dzcdn.net'))) throw new Error('Unexpected provider audio host')
    const reader = response.body.getReader(), chunks = []; let size = 0
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break
        size += part.value.byteLength
        if (size > max) throw new Error('Byte budget exceeded')
        chunks.push(part.value)
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error }
    const bytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), size)
    return { bytes, observation }
  } catch (error) {
    controller.abort(); if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {})
    throw error
  } finally { clearTimeout(timer) }
}
async function json(url, trace) { return JSON.parse((await bytesFrom(url, 2 * 1024 * 1024, false, trace)).bytes.toString('utf8')) }
const archiveUrl = source => 'https://archive.org/download/' + encodeURIComponent(source.item) + '/' + source.fileName.split('/').map(encodeURIComponent).join('/')

let browser
try {
  browser = await puppeteer.launch({ headless: true, executablePath: option('--chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'),
    ignoreDefaultArgs: ['--mute-audio', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] })
  report.browser = await browser.version()
  const page = await browser.newPage(), client = await page.createCDPSession()
  await page.goto('https://diad87.github.io/pletina/', { waitUntil: 'domcontentloaded', timeout: 30000 })
  const { result: global } = await client.send('Runtime.evaluate', { expression: 'globalThis', userGesture: false })
  const call = async (fn, ...values) => {
    const result = await client.send('Runtime.callFunctionOn', { objectId: global.objectId, functionDeclaration: fn.toString(),
      arguments: values.map(value => ({ value })), awaitPromise: true, returnByValue: true, userGesture: false })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  report.origin = new URL(page.url()).origin
  for (const key of keys) {
    const seed = discovery.tracks.find(track => track.input.key === key)
    assert.ok(seed?.catalog && seed?.candidates?.length, 'Generic discovery has no candidate for ' + key)
    const track = { key, status: 'pending', discoverySelection: 'First candidate in the generic bounded discovery result; no provider item/URL is hardcoded in this script.',
      input: seed.input, buildHttp: [], build: {}, runtime: null, errors: [] }
    report.tracks.push(track)
    try {
      const exact = await json('https://api.deezer.com/track/' + seed.catalog.id, track.buildHttp)
      assert.equal(exact.id, seed.catalog.id)
      for (const [actual, expected] of [[exact.title, seed.catalog.title], [exact.artist?.name, seed.catalog.artist],
        [exact.album?.title, seed.catalog.album], [exact.title_version, seed.catalog.titleVersion]]) assert.equal(normalize(actual), normalize(expected))
      assert.equal(exact.isrc, seed.catalog.isrc); assert.match(exact.isrc, /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/)
      assert.ok(Math.abs(exact.duration - seed.catalog.duration) <= 3)
      assert.ok(exact.preview)
      track.build.catalog = { id: exact.id, title: exact.title, titleVersion: exact.title_version, artist: exact.artist.name, album: exact.album.title, duration: exact.duration, isrc: exact.isrc }
      const negativeId = seed.negativeCatalogControl?.id
      assert.ok(negativeId && negativeId !== exact.id)
      const negative = await json('https://api.deezer.com/track/' + negativeId, track.buildHttp)
      assert.equal(negative.id, negativeId); assert.notEqual(normalize(negative.title), normalize(exact.title))
      assert.equal(normalize(negative.artist?.name), normalize(exact.artist.name)); assert.ok(negative.preview)
      const candidate = seed.candidates[0], metadata = await json('https://archive.org/metadata/' + encodeURIComponent(candidate.item), track.buildHttp)
      assert.equal(metadata.metadata?.identifier, candidate.item)
      const file = metadata.files.find(file => file.name === candidate.fileName)
      assert.ok(file && !file.private && /MP3|M4A|AAC|Ogg|FLAC/i.test(file.format))
      assert.ok(Number.isSafeInteger(Number(file.size)) && Number(file.size) <= 8 * 1024 * 1024)
      const selected = { item: candidate.item, fileName: file.name, bytes: Number(file.size), md5: file.md5, sha1: file.sha1,
        format: file.format, declaredDuration: Number(file.length), source: file.source }
      track.build.source = selected
      const remaining = { bytes: 8 * 1024 * 1024 }
      const audio = async (url, maximum) => {
        const fetched = await bytesFrom(url, Math.min(maximum, remaining.bytes), true, track.buildHttp)
        remaining.bytes -= fetched.bytes.length; return fetched.bytes
      }
      const referenceBytes = await audio(exact.preview, 1024 * 1024), negativeBytes = await audio(negative.preview, 1024 * 1024)
      const candidateBytes = await audio(archiveUrl(selected), selected.bytes + 4096)
      assert.equal(candidateBytes.length, selected.bytes); assert.equal(digest('md5', candidateBytes), selected.md5); assert.equal(digest('sha1', candidateBytes), selected.sha1)
      selected.sha256 = digest('sha256', candidateBytes)
      track.build.compressedBytesRead = 8 * 1024 * 1024 - remaining.bytes
      const compare = Function('return async function(payload){const compare = ' + compareRecordingWaveform.toString() + ';' +
        'const context=new OfflineAudioContext(2,1,44100); const buffers=[];' +
        'for(const value of payload){const bytes=Uint8Array.from(atob(value),c=>c.charCodeAt(0)); buffers.push(await context.decodeAudioData(bytes.buffer));}' +
        'return {audio:buffers.map(b=>({duration:b.duration,sampleRate:b.sampleRate,channels:b.numberOfChannels})),comparison:compare(...buffers)};}')()
      track.build.identity = await call(compare, [candidateBytes.toString('base64'), referenceBytes.toString('base64'), negativeBytes.toString('base64')])
      track.build.durationCompatible = Math.abs(track.build.identity.audio[0].duration - exact.duration) <= 3
      if (!track.build.identity.comparison.matched || !track.build.durationCompatible) {
        track.status = 'index-rejected-excerpt-or-duration'; continue
      }
      const entry = { catalog: track.build.catalog, provider: 'archive', source: selected,
        proof: { generatedAt: new Date().toISOString(), comparison: track.build.identity.comparison, referenceSha256: digest('sha256', referenceBytes),
          negativeReferenceSha256: digest('sha256', negativeBytes), fullMasterIdentityProven: false }, downloadAllowed: false,
        runtimeIntegrity: 'Runtime compares Archive metadata checksums. Opaque playback bytes cannot be hashed by the PWA; trusts Archive file binding and retains a metadata/media TOCTOU limit.' }
      report.index.entries.push(entry)
      // Browser cannot read Node's fetched audio. Metadata is readable, while the
      // media request below is a distinct ordinary native request without CORS.
      track.runtime = await call(async function (entry) {
        const response = await fetch('https://archive.org/metadata/' + encodeURIComponent(entry.source.item), { credentials: 'omit', signal: AbortSignal.timeout(10000) })
        if (!response.ok) throw new Error('Runtime metadata HTTP ' + response.status)
        const meta = await response.json(), file = meta.files?.find(file => file.name === entry.source.fileName)
        const matched = !!file && Number(file.size) === entry.source.bytes && file.md5 === entry.source.md5 && file.sha1 === entry.source.sha1
        if (!matched) throw new Error('Runtime provider metadata changed')
        const url = 'https://archive.org/download/' + encodeURIComponent(entry.source.item) + '/' + entry.source.fileName.split('/').map(encodeURIComponent).join('/')
        let cors
        try { const res = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(10000) }); cors = { readable: true, status: res.status }; await res.body?.cancel() }
        catch (error) { cors = { readable: false, error: error.name } }
        globalThis.__staticIndexAudio?.audio.pause()
        document.querySelector('#static-index-probe')?.remove()
        const box = document.createElement('section'); box.id = 'static-index-probe'
        const audio = new Audio(); audio.preload = 'auto'; audio.volume = 0.25; audio.muted = false; audio.src = url
        const state = globalThis.__staticIndexAudio = { audio, events: [], clicks: [], error: null }
        for (const type of ['loadedmetadata', 'playing', 'pause', 'ended', 'error']) audio.addEventListener(type, () => state.events.push({ type, at: performance.now(), time: audio.currentTime, code: audio.error?.code ?? null }))
        const play = document.createElement('button'); play.id = 'static-index-play'; play.textContent = 'Play indexed audio'
        play.onclick = event => { state.clicks.push({ control: 'play', trusted: event.isTrusted }); audio.play().catch(error => { state.error = error.name }) }
        const seek = document.createElement('button'); seek.id = 'static-index-seek'; seek.textContent = 'Seek indexed audio'
        seek.onclick = event => { state.clicks.push({ control: 'seek', trusted: event.isTrusted }); audio.currentTime = audio.duration / 2 }
        box.append(play, seek); document.body.prepend(box)
        return { metadataHttp: response.status, currentMetadataChecksumMatchesIndex: true, audioBytesHashedAtRuntime: false, corsFetch: cors }
      }, entry)
      const snapshot = () => call(function () { const state = globalThis.__staticIndexAudio, audio = state.audio; return { time: audio.currentTime,
        duration: Number.isFinite(audio.duration) ? audio.duration : null, paused: audio.paused, muted: audio.muted, volume: audio.volume,
        error: audio.error?.code ?? null, playError: state.error, readyState: audio.readyState, seeking: audio.seeking,
        crossOrigin: audio.crossOrigin, hidden: document.hidden, clicks: state.clicks, events: state.events } })
      const wait = async (test, timeout = 20000) => {
        const start = Date.now()
        while (Date.now() - start < timeout) { const value = await snapshot(); if (value.error || value.playError) throw new Error('HTMLAudio failed: ' + JSON.stringify(value)); if (test(value)) return value; await new Promise(resolve => setTimeout(resolve, 250)) }
        throw new Error('HTMLAudio timed out: ' + JSON.stringify(await snapshot()))
      }
      await page.click('#static-index-play')
      track.runtime.initial = await wait(state => !state.paused && state.time > 2 && state.readyState >= 2)
      assert.equal(track.runtime.initial.crossOrigin, null); assert.equal(track.runtime.initial.muted, false)
      assert.ok(Math.abs(track.runtime.initial.duration - exact.duration) <= 3)
      await page.click('#static-index-seek')
      track.runtime.seek = await wait(state => !state.paused && !state.seeking && state.time > state.duration / 2 + 1)
      const foreground = await browser.newPage(); await foreground.goto('about:blank'); await foreground.bringToFront()
      track.runtime.hiddenBefore = await snapshot()
      await new Promise(resolve => setTimeout(resolve, 30000))
      track.runtime.hiddenAfter = await snapshot()
      assert.equal(track.runtime.hiddenBefore.hidden, true); assert.equal(track.runtime.hiddenAfter.hidden, true)
      assert.ok(track.runtime.hiddenAfter.time - track.runtime.hiddenBefore.time > 25)
      assert.equal(track.runtime.hiddenAfter.clicks.filter(click => click.control === 'play').length, 1)
      await call(function () { globalThis.__staticIndexAudio.audio.pause() }); await foreground.close(); await page.bringToFront()
      track.status = 'index-excerpt-verified-and-opaque-playback-pass'
    } catch (error) { track.status = 'probe-error'; track.errors.push(safeError(error)) }
    finally {
      await mkdir(output, { recursive: true }); await writeFile(new URL(reportName, output), JSON.stringify(report, null, 2) + '\n')
      await writeFile(new URL(reportName.replace(/\.json$/, '-index.json'), output), JSON.stringify(report.index, null, 2) + '\n')
      console.log(JSON.stringify({ key, status: track.status, errors: track.errors, correlation: track.build.identity?.comparison.full.correlation,
        corsFetch: track.runtime?.corsFetch, runtimeAudio: track.runtime?.initial && { duration: track.runtime.initial.duration, time: track.runtime.initial.time },
        hiddenAdvance: track.runtime?.hiddenAfter && track.runtime.hiddenAfter.time - track.runtime.hiddenBefore.time }))
    }
  }
} catch (error) { report.errors.push(safeError(error)) }
finally { await browser?.close() }
report.summary = { indexed: report.index.entries.length, opaquePlaybackPass: report.tracks.filter(track => track.status === 'index-excerpt-verified-and-opaque-playback-pass').map(track => track.key),
  rejected: report.tracks.filter(track => track.status === 'index-rejected-excerpt-or-duration').map(track => track.key),
  errors: report.tracks.filter(track => track.status === 'probe-error').map(track => track.key) }
report.finishedAt = new Date().toISOString()
await mkdir(output, { recursive: true }); await writeFile(new URL(reportName, output), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ report: reportName, summary: report.summary, errors: report.errors }, null, 2))
if (report.errors.length || report.summary.errors.length) process.exitCode = 1
