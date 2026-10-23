// Bounded new-client diagnostics. Real Pages-origin CORS; no proxy/account/PO token/DRM/JS deciphering.
// This is not a product patch or a phone/background test.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import puppeteer from 'puppeteer-core'
import ts from 'typescript'

const args = process.argv.slice(2), option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const reportName = option('--report', 'youtube-public-client-hypotheses-2026-10-23.json')
if (!/^[a-z0-9.-]+\.json$/i.test(reportName)) throw new Error('Unsafe report name')
const youtubeSource = await readFile(new URL('../../web-port/youtube.ts', import.meta.url), 'utf8')
const moduleCode = ts.transpileModule(youtubeSource, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText
const report = { testedAt: new Date().toISOString(), scope: 'Real Pages-origin opaque-frame public player metadata and any available plain audio URLs; no intermediary server, accounts, supplied tokens, DRM or protected authentication.',
  sourceSha256: createHash('sha256').update(youtubeSource).digest('hex'), hypotheses: [
    { client: 'MWEB', basis: 'Untested mobile-web client has documented ultralow formats/HLS policy; check actual VOD responses, not infer availability from client name.' },
    { client: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', basis: 'Public embedded TV client differs from the already-failed WEB_EMBEDDED and TVHTML5 requests; check bounded metadata without custom headers.' },
  ], policy: { productChanged: false, published: false, signedUrlsPersisted: false, mediaPersisted: false, observerUserGesture: false, browserSecurityOverrides: false, outputMuted: false,
    physicalAndroidVerified: false, physicalIPhoneVerified: false, screenOffVerified: false, hiddenVideoUsed: false, proxyUsed: false, authenticationOrDrmBypassed: false },
  sources: ['https://raw.githubusercontent.com/yt-dlp/yt-dlp/master/yt_dlp/extractor/youtube/_base.py', 'https://raw.githubusercontent.com/LuanRT/YouTube.js/main/src/utils/Constants.ts', 'https://raw.githubusercontent.com/LuanRT/Kira/main/README.md'],
  findingsFromSources: ['VISIONOS and ANDROID_VR document an unsupported Made-for-kids category; the artist/title alone does not establish this classification.', 'Current yt-dlp documents ANDROID_VR HTTP403 enforcement, so that previously-untried label is not treated as a promising route.', 'Kira implements SABR but explicitly needs a proxy or browser extension on mobile; protocol parsing does not remove the separately observed CORS obstacle.'],
  metadata: [], playback: [], networkFailures: [], errors: [] }
const safe = value => String(value?.message ?? value).replace(/(?:https?|blob):[^\s"'<>]+/g, '[URL]').slice(0, 350)
let browser
try {
  browser = await puppeteer.launch({ executablePath: option('--chrome', 'C:/Users/iunan/.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe'), headless: true,
    ignoreDefaultArgs: ['--mute-audio', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], args: [], protocolTimeout: 180000 })
  const page = await browser.newPage(), client = page.mainFrame().client, requests = new Map()
  await client.send('Network.enable')
  client.on('Network.requestWillBeSent', event => {
    const url = new URL(event.request.url)
    if (url.hostname.endsWith('.googlevideo.com') || url.hostname === 'googlevideo.com') requests.set(event.requestId, { host: url.hostname, resourceType: event.type })
  })
  client.on('Network.loadingFailed', event => {
    const request = requests.get(event.requestId)
    if (request) report.networkFailures.push({ ...request, errorText: safe(event.errorText), corsErrorStatus: event.corsErrorStatus ?? null, blockedReason: event.blockedReason ?? null })
  })
  await page.goto('https://diad87.github.io/pletina/', { waitUntil: 'domcontentloaded', timeout: 45000 })
  const call = async (fn, value = null) => {
    const context = page.mainFrame().mainRealm().context
    const response = await client.send('Runtime.callFunctionOn', { executionContextId: context.id, functionDeclaration: fn.toString(), arguments: [{ value }], returnByValue: true, awaitPromise: true, userGesture: false })
    if (response.exceptionDetails) throw new Error(safe(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text))
    return response.result.value
  }
  report.origin = await call(() => location.origin)
  const discovery = await call(async moduleCode => {
    const api = await import(URL.createObjectURL(new Blob([moduleCode], { type: 'text/javascript' })))
    const raw = await api.requestJson('music', 'search', { context: api.musicContext(), query: 'Epoitaitaye Pirritx Porrotx Marimotots', params: 'EgWKAQIIAWoKEAkQBRAKEAMQBA==' })
    const rows = api.parseMusicResults(raw), normalize = value => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    const exact = rows.find(row => normalize(row.title) === 'epoitaitaye' && row.artists.some(artist => /pirritx/.test(normalize(artist)) && /porrotx/.test(normalize(artist))) && row.duration >= 207 && row.duration <= 212)
    window.__publicClientProbe = { api, visitor: raw.responseContext?.visitorData, urls: new Map(), audio: null, events: [], requests: [] }
    return { candidates: rows.slice(0, 6), selected: exact ?? null, sessionAvailable: !!raw.responseContext?.visitorData }
  }, moduleCode)
  report.discovery = discovery
  const corpus = [
    ...(discovery.selected ? [{ kind: 'difficult-new', videoId: discovery.selected.videoId }] : []),
    { kind: 'difficult-existing', videoId: 'fV-IUsecSsU' },
    { kind: 'known-positive', videoId: 'gpfVjKXVnDc' },
    { kind: 'unavailable-negative', videoId: '___________' },
  ]
  for (const track of corpus) {
    const clients = ['MWEB', 'TV_EMBEDDED', ...(['difficult-new', 'known-positive'].includes(track.kind) ? ['VISIONOS_BASELINE'] : [])]
    for (const name of clients) {
      console.log('Checking', track.kind, name, track.videoId)
      const result = await call(async ({ track, name }) => {
        const state = window.__publicClientProbe
        const clients = {
          MWEB: { clientName: 'MWEB', clientVersion: '2.20260708.05.00', userAgent: 'Mozilla/5.0 (iPad; CPU OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1,gzip(gfe)', platform: 'MOBILE' },
          TV_EMBEDDED: { clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', clientVersion: '2.0', platform: 'TV' },
          VISIONOS_BASELINE: { clientName: 'VISIONOS', clientVersion: '1.02', deviceMake: 'Apple', deviceModel: 'RealityDevice17,1', osName: 'visionOS', osVersion: '26.5.23O471', platform: 'MOBILE' },
        }
        const client = { ...clients[name], hl: 'es', gl: 'ES', ...(state.visitor ? { visitorData: state.visitor } : {}) }
        try {
          const value = await state.api.requestJson('youtube', 'player', { context: { client, ...(name === 'TV_EMBEDDED' ? { thirdParty: { embedUrl: location.origin + '/pletina/' } } : {}) }, videoId: track.videoId, contentCheckOk: true, racyCheckOk: true })
          const stream = value.streamingData ?? {}, details = value.videoDetails ?? {}, formats = [...(stream.adaptiveFormats ?? []), ...(stream.formats ?? [])]
          const list = formats.filter(format => /^audio\//.test(format.mimeType ?? '')).map(format => ({ itag: format.itag, mimeType: format.mimeType, direct: typeof format.url === 'string', cipher: !!(format.signatureCipher || format.cipher), drm: !!(format.drmFamilies?.length || format.drmTrackType), drc: !!format.isDrc }))
          const candidate = formats.filter(format => /^audio\/(?:mp4|webm)/.test(format.mimeType ?? '') && typeof format.url === 'string' && !format.isDrc && !format.drmFamilies?.length && !format.drmTrackType && format.audioTrack?.audioIsDefault !== false).sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0]
          const key = track.videoId + ':' + name
          if (candidate && new URL(candidate.url).protocol === 'https:' && new URL(candidate.url).hostname.endsWith('.googlevideo.com')) state.urls.set(key, { url: candidate.url, itag: candidate.itag, mimeType: candidate.mimeType, duration: Number(details.lengthSeconds) })
          return { ...track, client: name, status: value.playabilityStatus?.status ?? null, reason: value.playabilityStatus?.reason?.slice(0, 250) ?? null,
            details: { id: details.videoId ?? null, title: details.title ?? null, author: details.author ?? null, duration: Number(details.lengthSeconds) || null, madeForKidsFlag: typeof details.isMadeForKids === 'boolean' ? details.isMadeForKids : null },
            audioFormats: list, adaptiveCount: stream.adaptiveFormats?.length ?? 0, progressiveCount: stream.formats?.length ?? 0,
            hlsManifestAvailable: typeof stream.hlsManifestUrl === 'string', dashManifestAvailable: typeof stream.dashManifestUrl === 'string', sabrAvailable: typeof stream.serverAbrStreamingUrl === 'string',
            directAudioCandidate: state.urls.has(key) ? { key, itag: candidate.itag, mimeType: candidate.mimeType } : null }
        } catch (error) { return { ...track, client: name, error: error.name, message: error.message } }
      }, { track, name })
      report.metadata.push(result)
      if (!result.directAudioCandidate) continue
      const key = result.directAudioCandidate.key
      await call(key => {
        const state = window.__publicClientProbe
        state.events = []
        state.audio?.pause(); state.audio = new Audio(); state.audio.muted = false; state.audio.volume = 0.8
        const audio = state.audio, candidate = state.urls.get(key)
        for (const type of ['loadedmetadata', 'playing', 'pause', 'error', 'seeked']) audio.addEventListener(type, () => state.events.push({ type, time: audio.currentTime, duration: Number.isFinite(audio.duration) ? audio.duration : null, error: audio.error?.code ?? null }))
        let button = document.querySelector('#public-client-play')
        if (!button) { button = document.createElement('button'); button.id = 'public-client-play'; button.style.cssText = 'position:fixed;left:20px;top:20px;z-index:999999;width:250px;height:70px'; document.body.append(button) }
        button.textContent = 'Play direct audio candidate'
        button.onclick = () => { audio.src = candidate.url; audio.play().catch(error => { state.playError = { name: error.name, message: error.message.slice(0, 200) } }) }
        state.playError = null
      }, key)
      const point = await call(() => { const rect = document.querySelector('#public-client-play').getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } })
      await page.mouse.click(point.x, point.y)
      const samples = [], started = Date.now()
      while (Date.now() - started < 12000) {
        const sample = await call(() => { const state = window.__publicClientProbe, audio = state.audio; return { time: audio.currentTime, duration: Number.isFinite(audio.duration) ? audio.duration : null, paused: audio.paused, muted: audio.muted, error: audio.error?.code ?? null, playError: state.playError, events: state.events } })
        samples.push(sample)
        if (sample.error || sample.playError || (!sample.paused && sample.time >= 2)) break
        await new Promise(resolve => setTimeout(resolve, 350))
      }
      report.playback.push({ videoId: track.videoId, kind: track.kind, client: name, actualTrustedPlayClicks: 1, samples, advanced: samples.some(sample => !sample.paused && !sample.muted && sample.time >= 2), extraAutoplayRescueClicks: 0, completeSongOrPhoneBackgroundClaimed: false })
      await call(() => { window.__publicClientProbe.audio?.pause() })
    }
  }
} catch (error) { report.errors.push(safe(error)) }
finally { await browser?.close() }
report.summary = { metadataRequests: report.metadata.length, playableDirectCandidates: report.playback.filter(result => result.advanced).map(({ kind, client, videoId }) => ({ kind, client, videoId })),
  newDifficultDirectPlayback: report.playback.some(result => result.advanced && result.kind.startsWith('difficult') && result.client !== 'VISIONOS_BASELINE'),
  noSabrReplayPerformed: true, unprovidedManifestsNotTested: true }
const directory = new URL('../../artifacts/pwa-port/', import.meta.url)
await mkdir(directory, { recursive: true })
await writeFile(new URL(reportName, directory), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ report: reportName, summary: report.summary, metadata: report.metadata.map(value => ({ videoId: value.videoId, client: value.client, status: value.status, audio: value.audioFormats?.length, hls: value.hlsManifestAvailable, sabr: value.sabrAvailable, error: value.error })), errors: report.errors }, null, 2))
if (report.errors.length) process.exitCode = 1
