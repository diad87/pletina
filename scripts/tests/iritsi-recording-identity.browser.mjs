// Identity investigation only. Real provider responses, normal HTTPS/CORS, audio in RAM.
// No music/previews/signed media URLs are written to disk. This does not activate a source.
// node scripts/tests/iritsi-recording-identity.browser.mjs [--report safe-name.json] [--chrome path]
import { mkdir, writeFile } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'

const args = process.argv.slice(2)
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback
const reportName = option('--report', `iritsi-recording-identity-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.json`)
if (!/^[a-z0-9.-]+\.json$/i.test(reportName)) throw new Error('Unsafe report filename')
const report = {
  testedAt: new Date().toISOString(),
  scope: 'Real Pages-origin JSONP metadata and CORS audio decode; normalized waveform correlation in browser RAM. No playback or phone background proof.',
  catalog: { id: 3250715431, title: 'Iritsi da Eguna', artist: 'Pirritx eta Porrotx', album: 'Eskerrik Asko!', isrc: 'QM6N21424821', durationSeconds: 169 },
  candidate: { provider: 'ALEA / Kantari', article: 'https://alea.eus/araba/1473099329086-iritsi-da-eguna-pirritx-eta-porrotx', publicAudio: 'https://alea.tok-md.com/iritsidaeguna.mp3' },
  browserPolicyOverrides: false, outputMuted: false, observationWithUserGesture: false,
  physicalAndroidVerified: false, physicalIPhoneVerified: false, productSourceActivated: false,
  wholeRecordingIdentityProven: false, mediaPersisted: false, signedUrlsPersisted: false,
  stages: [], errors: [],
}
const cleanError = error => String(error?.message ?? error).replace(/https?:\/\/[^\s"'<>]+/g, '[URL]').slice(0, 300)
let browser
try {
  browser = await puppeteer.launch({
    executablePath: option('--chrome', 'C:/Users/iunan/.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe'),
    headless: true,
    ignoreDefaultArgs: ['--mute-audio', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
    args: [], protocolTimeout: 180000,
  })
  const page = await browser.newPage()
  await page.goto('https://diad87.github.io/pletina/', { waitUntil: 'domcontentloaded', timeout: 45000 })
  const call = async (fn, input = null) => {
    const context = page.mainFrame().mainRealm().context
    const result = await page.mainFrame().client.send('Runtime.callFunctionOn', {
      executionContextId: context.id, functionDeclaration: fn.toString(), arguments: [{ value: input }],
      returnByValue: true, awaitPromise: true, userGesture: false,
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  report.origin = await call(() => location.origin)
  const metadata = await call(async () => {
    const jsonpUrl = url => new Promise((resolve, reject) => {
      const callback = 'pletinaIdentity_' + crypto.randomUUID().replaceAll('-', '')
      const script = document.createElement('script')
      const timer = setTimeout(() => done(new Error('Deezer JSONP timeout')), 20000)
      const done = (error, result) => { clearTimeout(timer); delete window[callback]; script.remove(); error ? reject(error) : resolve(result) }
      window[callback] = result => done(null, result)
      script.onerror = () => done(new Error('Deezer JSONP network error'))
      script.src = `${url}${url.includes('?') ? '&' : '?'}callback=${callback}`
      document.head.append(script)
    })
    const jsonp = path => jsonpUrl(`https://api.deezer.com/${path}${path.includes('?') ? '&' : '?'}output=jsonp`)
    const exact = await jsonp('track/3250715431')
    if (exact.error || !exact.preview || exact.isrc !== 'QM6N21424821') {
      return { exact: { id: exact.id, title: exact.title, isrc: exact.isrc, previewAvailable: !!exact.preview, error: exact.error ?? null }, identityAccepted: false }
    }
    const album = await jsonp(`album/${exact.album.id}/tracks?limit=30`)
    // A different musical recording is a harder negative than the album's spoken interludes.
    const other = album.data?.find(track => track.id !== exact.id && track.preview && track.duration >= 90)
    const negative = other ? await jsonp(`track/${other.id}`) : null
    let apple = null, appleSearch = null
    try {
      const response = await jsonpUrl('https://itunes.apple.com/search?term=Pirritx%20Porrotx%20Iritsi%20da%20Eguna&entity=song&limit=30&country=es')
      const norm = text => String(text ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
      apple = response.results?.find(track => norm(track.trackName) === norm(exact.title) && norm(track.artistName) === norm(exact.artist.name) && norm(track.collectionName) === norm(exact.album.title) && Math.abs(track.trackTimeMillis / 1000 - exact.duration) <= 3 && track.previewUrl)
      appleSearch = { total: response.resultCount, identityMatched: !!apple }
    } catch (error) { appleSearch = { error: error.name } }
    window.__pletinaIdentityAudio = { exact, negative, apple, buffers: new Map() }
    const safe = track => track ? { id: track.id, title: track.title, artist: track.artist?.name, album: track.album?.title, duration: track.duration, isrc: track.isrc, previewAvailable: !!track.preview } : null
    return { exact: safe(exact), negative: safe(negative), appleSearch, apple: apple ? { id: apple.trackId, title: apple.trackName, artist: apple.artistName, album: apple.collectionName, duration: apple.trackTimeMillis / 1000, isrcAvailable: false, previewAvailable: !!apple.previewUrl } : null, identityAccepted: true, albumTracks: album.data?.length ?? 0 }
  })
  report.stages.push({ name: 'Official catalog metadata and reference selection', result: metadata })
  if (!metadata.identityAccepted) throw new Error('Exact official ISRC/preview reference unavailable')
  const decode = await call(async () => {
    const state = window.__pletinaIdentityAudio
    const context = new OfflineAudioContext(2, 1, 44100)
    const fetchDecode = async (label, url) => {
      const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(40000) })
      if (!response.ok) throw new Error(label + ' HTTP ' + response.status)
      const bytes = await response.arrayBuffer()
      const size = bytes.byteLength
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('')
      const buffer = await context.decodeAudioData(bytes)
      state.buffers.set(label, buffer)
      let digitalPadding = null
      if (label === 'candidate') {
        const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index))
        let first = -1, last = -1
        for (let i = 0; i < buffer.length; i++) if (channels.some(channel => channel[i] !== 0)) { first = i; break }
        for (let i = buffer.length - 1; i >= 0; i--) if (channels.some(channel => channel[i] !== 0)) { last = i; break }
        digitalPadding = { predicate: 'A PCM sample is nonzero when any decoded channel sample !== 0; no RMS or psychoacoustic threshold.', totalSamples: buffer.length, firstNonzeroSample: first, lastNonzeroSample: last, leadingExactZeroSeconds: first / buffer.sampleRate, trailingExactZeroSeconds: (buffer.length - last - 1) / buffer.sampleRate, conservativeStartOffsetSeconds: Math.max(0, Math.floor((first / buffer.sampleRate - 0.25) * 100) / 100), proposedStartOffsetReason: 'Skips only a proven all-channel exact-zero prefix and leaves at least 250 ms of that zero prefix; no musical tail trimming proposed.' }
      }
      return { label, status: response.status, corsReadable: true, contentType: response.headers.get('content-type'), bytes: size, sha256, durationSeconds: buffer.duration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels, ...(digitalPadding ? { digitalPadding } : {}) }
    }
    const results = []
    for (const [label, url] of [['candidate', 'https://alea.tok-md.com/iritsidaeguna.mp3'], ['exactReference', state.exact.preview], ['negativeReference', state.negative?.preview], ['appleReference', state.apple?.previewUrl]]) {
      if (!url) continue
      try { results.push(await fetchDecode(label, url)) }
      catch (error) { results.push({ label, error: error.name, detail: error.message.replace(/https?:\/\/[^\s]+/g, '[URL]') }) }
    }
    await context.close?.()
    return results
  })
  report.stages.push({ name: 'CORS complete file fetch and in-memory decode', result: decode })
  if (!decode.some(entry => entry.label === 'exactReference' && entry.durationSeconds)) throw new Error('No decoded exact reference')
  if (!decode.some(entry => entry.label === 'candidate' && entry.durationSeconds)) throw new Error('No decoded candidate')
  const comparison = await call(() => {
    const state = window.__pletinaIdentityAudio
    const sampleRate = 2205
    const mono = buffer => {
      const step = buffer.sampleRate / sampleRate
      const output = new Float64Array(Math.floor(buffer.length / step))
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index))
      for (let i = 0; i < output.length; i++) {
        let sum = 0, count = 0
        for (let s = Math.floor(i * step); s < Math.floor((i + 1) * step); s++) for (const data of channels) { sum += data[s]; count++ }
        output[i] = sum / count
      }
      return output
    }
    const fft = (real, imag, inverse = false) => {
      const n = real.length
      for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1
        for (; j & bit; bit >>= 1) j ^= bit
        j ^= bit
        if (i < j) { [real[i], real[j]] = [real[j], real[i]]; [imag[i], imag[j]] = [imag[j], imag[i]] }
      }
      for (let width = 2; width <= n; width <<= 1) {
        const angle = (inverse ? 2 : -2) * Math.PI / width
        const wr = Math.cos(angle), wi = Math.sin(angle)
        for (let start = 0; start < n; start += width) {
          let ur = 1, ui = 0
          for (let j = 0; j < width / 2; j++) {
            const even = start + j, odd = even + width / 2
            const vr = real[odd] * ur - imag[odd] * ui, vi = real[odd] * ui + imag[odd] * ur
            real[odd] = real[even] - vr; imag[odd] = imag[even] - vi
            real[even] += vr; imag[even] += vi
            const next = ur * wr - ui * wi; ui = ur * wi + ui * wr; ur = next
          }
        }
      }
      if (inverse) for (let i = 0; i < n; i++) { real[i] /= n; imag[i] /= n }
    }
    const correlate = (candidate, reference) => {
      const n = candidate.length, m = reference.length
      if (m > n || m < sampleRate) throw new Error('Invalid reference window')
      const mean = reference.reduce((sum, sample) => sum + sample, 0) / m
      let referenceEnergy = 0, size = 1
      while (size < n + m - 1) size <<= 1
      const ar = new Float64Array(size), ai = new Float64Array(size), br = new Float64Array(size), bi = new Float64Array(size)
      ar.set(candidate)
      for (let i = 0; i < m; i++) { const x = reference[i] - mean; br[m - 1 - i] = x; referenceEnergy += x * x }
      fft(ar, ai); fft(br, bi)
      for (let i = 0; i < size; i++) { const r = ar[i] * br[i] - ai[i] * bi[i]; ai[i] = ar[i] * bi[i] + ai[i] * br[i]; ar[i] = r }
      fft(ar, ai, true)
      let sum = 0, energy = 0
      for (let i = 0; i < m; i++) { sum += candidate[i]; energy += candidate[i] ** 2 }
      let best = { correlation: -Infinity, offsetSeconds: null }
      const peaks = []
      for (let offset = 0; offset <= n - m; offset++) {
        const variance = energy - sum * sum / m
        const value = variance > 1e-12 ? ar[offset + m - 1] / Math.sqrt(variance * referenceEnergy) : 0
        if (value > best.correlation) best = { correlation: value, offsetSeconds: offset / sampleRate }
        if (offset % sampleRate === 0) peaks.push({ offsetSeconds: offset / sampleRate, correlation: value })
        if (offset < n - m) { sum += candidate[offset + m] - candidate[offset]; energy += candidate[offset + m] ** 2 - candidate[offset] ** 2 }
      }
      peaks.sort((a, b) => b.correlation - a.correlation)
      return { ...best, referenceSeconds: m / sampleRate, sampleRate, coarseWholeSecondControls: peaks.slice(0, 3) }
    }
    const candidate = mono(state.buffers.get('candidate'))
    const results = []
    for (const label of ['exactReference', 'negativeReference', 'appleReference']) {
      const buffer = state.buffers.get(label)
      if (!buffer) continue
      const reference = mono(buffer)
      const full = correlate(candidate, reference)
      const windows = []
      for (const start of [0, 10, 20, 40, 60, 80]) {
        const end = Math.min(reference.length, (start + 8) * sampleRate)
        if (end - start * sampleRate < 5 * sampleRate) continue
        const match = correlate(candidate, reference.subarray(start * sampleRate, end))
        windows.push({ referenceStartSeconds: start, ...match, inferredPreviewStartInCandidateSeconds: match.offsetSeconds - start })
      }
      results.push({ label, full, windows, alignmentSpreadSeconds: windows.length ? Math.max(...windows.map(w => w.inferredPreviewStartInCandidateSeconds)) - Math.min(...windows.map(w => w.inferredPreviewStartInCandidateSeconds)) : null })
    }
    // This self-control tests the implementation, not the song's identity.
    const self = correlate(candidate, candidate.subarray(40 * sampleRate, 48 * sampleRate))
    return { algorithm: 'Mean-removed normalized waveform cross-correlation, FFT convolution; mono box-filter downsample to 2205 Hz; exhaustive offset scan.', results, selfControl: self }
  })
  report.stages.push({ name: 'Waveform identity comparison with distinct-song and self controls', result: comparison })
  const exact = comparison.results.find(result => result.label === 'exactReference')
  const negative = comparison.results.find(result => result.label === 'negativeReference')
  const apple = comparison.results.find(result => result.label === 'appleReference')
  report.referenceExcerptCompatible = exact.full.correlation >= 0.8 && exact.windows.every(window => window.correlation >= 0.8) && exact.alignmentSpreadSeconds <= 0.02 && comparison.selfControl.correlation >= 0.99 && (!negative || negative.full.correlation < 0.4)
  report.independentAppleExcerptCompatible = !!apple && apple.full.correlation >= 0.8 && apple.alignmentSpreadSeconds <= 0.02
  report.referenceCoverageLimits = 'Both references are approximately 30 s and align to nearly the same candidate interval. Their offsets are relative to the preview, not evidence that the preview begins at original master time zero. No independent comparison covers the remainder of the recording.'
  report.publication = { source: 'https://alea.eus/araba/1473099329086-iritsi-da-eguna-pirritx-eta-porrotx', publisher: 'ALEA / Kantari', publishedDate: '2016-09-05', attribution: 'Iritsi da eguna - Pirritx eta Porrotx', audioDownloadPermissionVerified: false, blanketSiteFooterNotUsedAsMusicDownloadPermission: true }
  report.conclusion = report.referenceExcerptCompatible
    ? 'The complete official reference excerpt and its separated windows strongly match the candidate at a consistent offset. This supports the same recorded excerpt, not verification of all unreferenced seconds or complete master identity.'
    : 'The automatic waveform threshold did not establish reference identity. Do not activate automatic substitution on this evidence.'
} catch (error) { report.errors.push(cleanError(error)); report.conclusion ??= 'Investigation incomplete; no automatic source activation.' }
finally { await browser?.close() }
const directory = new URL('../../artifacts/pwa-port/', import.meta.url)
await mkdir(directory, { recursive: true })
await writeFile(new URL(reportName, directory), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
if (report.errors.length) process.exitCode = 1
