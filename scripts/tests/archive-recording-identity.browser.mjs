// One bounded Internet Archive recording identity investigation. Audio remains in browser RAM.
// node scripts/tests/archive-recording-identity.browser.mjs [--report safe-name.json]
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'

const args = process.argv.slice(2)
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const reportName = option('--report', 'archive-egiozu-recording-identity-2026-10-22.json')
if (!/^[a-z0-9.-]+\.json$/i.test(reportName)) throw new Error('Unsafe report name')
const report = { testedAt: new Date().toISOString(), scope: 'One bounded Archive/Deezer identity probe, normal Pages-origin browser CORS, no account, audio in RAM.',
  candidate: { provider: 'Internet Archive', id: 'EgiozuEuskarazPirritxPorrotxEtaMarimotots', title: 'Egiozu Euskaraz', page: 'https://archive.org/details/EgiozuEuskarazPirritxPorrotxEtaMarimotots', audio: 'https://archive.org/download/EgiozuEuskarazPirritxPorrotxEtaMarimotots/Egiozu_euskaraz_Pirritx_Porrotx_eta_Marimotots_.mp3' },
  outputMuted: false, observationWithGesture: false, securityOverrides: false, mediaPersisted: false, signedUrlsPersisted: false, productActivated: false, fullMasterVerified: false, physicalBackgroundVerified: false, errors: [], stages: [] }
let browser
const scrub = value => String(value).replace(/https?:\/\/[^\s"'<>]+/g, '[URL]').slice(0, 300)
try {
  browser = await puppeteer.launch({ executablePath: option('--chrome', 'C:/Users/iunan/.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe'), headless: true,
    ignoreDefaultArgs: ['--mute-audio', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], args: [], protocolTimeout: 180000 })
  const page = await browser.newPage()
  await page.goto('https://diad87.github.io/pletina/', { waitUntil: 'domcontentloaded', timeout: 45000 })
  const call = async (fn, value = null) => {
    const context = page.mainFrame().mainRealm().context
    const result = await page.mainFrame().client.send('Runtime.callFunctionOn', { executionContextId: context.id, functionDeclaration: fn.toString(), arguments: [{ value }], awaitPromise: true, returnByValue: true, userGesture: false })
    if (result.exceptionDetails) throw new Error(scrub(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text))
    return result.result.value
  }
  report.origin = await call(() => location.origin)
  const selection = await call(async () => {
    const jsonp = path => new Promise((resolve, reject) => {
      const name = 'archiveIdentity_' + crypto.randomUUID().replaceAll('-', ''), script = document.createElement('script')
      const done = (error, data) => { clearTimeout(timer); delete window[name]; script.remove(); error ? reject(error) : resolve(data) }
      const timer = setTimeout(() => done(new Error('Catalog JSONP timeout')), 20000)
      window[name] = data => done(null, data); script.onerror = () => done(new Error('Catalog JSONP network error'))
      script.src = `https://api.deezer.com/${path}${path.includes('?') ? '&' : '?'}output=jsonp&callback=${name}`; document.head.append(script)
    })
    const response = await jsonp('search/track?q=Egiozu%20Euskaraz&limit=25')
    if (!Array.isArray(response.data)) throw new Error('Search did not return valid catalog results')
    const normalize = value => String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    const eligible = response.data.filter(track => normalize(track.title) === 'egiozu euskaraz' && /pirritx|porrotx|marimotots/.test(normalize(track.artist?.name)) && Math.abs(track.duration - 126.8325) <= 7).slice(0, 3)
    const details = []
    for (const track of eligible) details.push(await jsonp(`track/${track.id}`))
    let negative = null
    if (details[0]?.album?.id) {
      const album = await jsonp(`album/${details[0].album.id}/tracks?limit=30`)
      const other = album.data?.find(track => !details.some(detail => detail.id === track.id) && track.preview && track.duration > 90)
      if (other) negative = await jsonp(`track/${other.id}`)
    }
    const safe = track => ({ id: track.id, title: track.title, artist: track.artist?.name, album: track.album?.title, duration: track.duration, isrc: track.isrc ?? null, previewAvailable: !!track.preview })
    window.__archiveIdentity = { tracks: details, negative, buffers: new Map() }
    return { total: response.total, returned: response.data.length, boundedCandidates: details.map(safe), negative: negative ? safe(negative) : null, firstResults: response.data.slice(0, 8).map(safe) }
  })
  report.stages.push({ name: 'Bounded exact-title artist/duration catalog selection', result: selection })
  if (!selection.boundedCandidates.length) {
    report.conclusion = 'No catalog candidate passed exact-title, expected artist and duration bounds. No broader search, substitution or source registry entry created.'
  } else {
    const decode = await call(async url => {
      const state = window.__archiveIdentity, context = new OfflineAudioContext(2, 1, 44100), results = []
      const sources = [['candidate', url], ...state.tracks.map((track, index) => ['reference' + index, track.preview]), ['negativeReference', state.negative?.preview]]
      for (const [label, url] of sources) {
        if (!url) continue
        try {
          const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(40000) })
          if (!response.ok) throw new Error('HTTP ' + response.status)
          const bytes = await response.arrayBuffer(), length = bytes.byteLength
          const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('')
          const buffer = await context.decodeAudioData(bytes); state.buffers.set(label, buffer)
          let digitalPadding = null
          if (label === 'candidate') {
            const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index))
            let first = -1, last = -1
            for (let i = 0; i < buffer.length; i++) if (channels.some(channel => channel[i] !== 0)) { first = i; break }
            for (let i = buffer.length - 1; i >= 0; i--) if (channels.some(channel => channel[i] !== 0)) { last = i; break }
            digitalPadding = { firstNonzeroSample: first, lastNonzeroSample: last, leadingExactZeroSeconds: first / buffer.sampleRate, trailingExactZeroSeconds: (buffer.length - last - 1) / buffer.sampleRate, conservativeStartOffsetSeconds: Math.max(0, Math.floor((first / buffer.sampleRate - 0.25) * 100) / 100) }
          }
          results.push({ label, status: response.status, corsReadable: true, bytes: length, sha256, durationSeconds: buffer.duration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels, digitalPadding })
        } catch (error) { results.push({ label, error: error.name, message: error.message.replace(/https?:\/\/[^\s]+/g, '[URL]') }) }
      }
      return results
    }, report.candidate.audio)
    report.stages.push({ name: 'Complete browser CORS fetch and memory-only decode', result: decode })
    // Reuse the exact already-tested comparison function body with only its state/key names adapted.
    // The body contains no imports or network/media addresses. Keep a provenance SHA for reproducibility.
    const iritsiScript = await readFile(new URL('iritsi-recording-identity.browser.mjs', import.meta.url), 'utf8')
    const body = iritsiScript.match(/const comparison = await call\(\(\) => \{([\s\S]+?)\n  \}\)\n  report\.stages\.push\(\{ name: 'Waveform identity comparison/)
    if (!body) throw new Error('Shared waveform comparison body was not found')
    const adapted = body[1].replace('window.__pletinaIdentityAudio', 'window.__archiveIdentity')
      .replace("['exactReference', 'negativeReference', 'appleReference']", "['reference0', 'reference1', 'reference2', 'negativeReference']")
      // Permit signed alignment offsets: one file may omit a few encoder-delay
      // samples present in the official preview. Only the comparison array gets
      // 500 ms zero padding; the decoded audio and strict identity thresholds do not change.
      .replace("const candidate = mono(state.buffers.get('candidate'))", "const rawCandidate = mono(state.buffers.get('candidate')); const candidate = new Float64Array(rawCandidate.length + sampleRate); candidate.set(rawCandidate, sampleRate / 2)")
    const comparison = await call(Function('return function () {' + adapted + '}')())
    comparison.observerPadding = { leadingSeconds: 0.5, trailingSeconds: 0.5, reason: 'Allow negative preview-relative offsets caused by encoder padding/cropped initial samples; no audio changes.', returnedOffsetsCorrectedForPadding: true }
    for (const result of comparison.results) {
      result.full.offsetSeconds -= 0.5
      for (const window of result.windows) { window.offsetSeconds -= 0.5; window.inferredPreviewStartInCandidateSeconds -= 0.5 }
      for (const sample of [result.full, ...result.windows]) for (const peak of sample.coarseWholeSecondControls) peak.offsetSeconds -= 0.5
    }
    report.stages.push({ name: 'Same waveform algorithm with self and different-song controls', result: comparison })
    const matches = comparison.results.filter(result => result.label.startsWith('reference') && result.full.correlation >= 0.8 && result.windows.every(window => window.correlation >= 0.8) && result.alignmentSpreadSeconds <= 0.02)
    const negative = comparison.results.find(result => result.label === 'negativeReference')
    report.compatibleReferenceIndices = comparison.selfControl.correlation >= 0.99 && negative && negative.full.correlation < 0.4 ? matches.map(result => Number(result.label.replace('reference', ''))) : []
    report.conclusion = report.compatibleReferenceIndices.length ? 'At least one official catalog excerpt strongly matches the Archive recording; full master and upload rights remain independently unverified.' : 'No reference passed the strict waveform and control criteria; no automatic source entry created.'
    report.downloadAllowed = false
    report.rightsNote = 'Uploader Public Domain Mark is self-declared and is not independent evidence of music download rights.'
  }
} catch (error) { report.errors.push(scrub(error.message)); report.conclusion ??= 'Probe incomplete; no source activation.' }
finally { await browser?.close() }
const directory = new URL('../../artifacts/pwa-port/', import.meta.url)
await mkdir(directory, { recursive: true })
await writeFile(new URL(reportName, directory), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
if (report.errors.length) process.exitCode = 1
