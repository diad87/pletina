// Read-only discovery/transport research. No app changes, provider credentials or media artifacts.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'

const report = { schemaVersion: 1, testedAt: new Date().toISOString(),
  scope: 'Actual Pages-origin public search, provider detail, CORS complete-media bytes and native audio. Controls are performances, not verified commercial-catalog masters.',
  sourceResponsesMocked: false, productChanged: false, noRuntimeBackend: true, noLoginOrKeys: true,
  mediaFilesPersisted: false, physicalDevice: false, phoneScreenOffVerified: false, checks: [] }
const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ignoreDefaultArgs: ['--mute-audio', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] })
let passed = false
try {
  const page = await browser.newPage()
  await page.goto('https://diad87.github.io/pletina/', { waitUntil: 'domcontentloaded', timeout: 30000 })
  const session = await page.createCDPSession()
  const { result: root } = await session.send('Runtime.evaluate', { expression: 'globalThis', userGesture: false })
  const evaluate = async (fn, ...args) => {
    const { result, exceptionDetails } = await session.send('Runtime.callFunctionOn', { objectId: root.objectId,
      functionDeclaration: fn.toString(), arguments: args.map(value => ({ value })), awaitPromise: true, returnByValue: true, userGesture: false })
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text)
    return result.value
  }
  const discovery = await evaluate(async function () {
    const json = async url => {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000)
      try { const response = await fetch(url, { credentials: 'omit', signal: controller.signal }); if (!response.ok) throw new Error('Metadata HTTP ' + response.status); return { status: response.status, type: response.type, data: await response.json() } }
      finally { clearTimeout(timer) }
    }
    const sepia = await json('https://sepiasearch.org/api/v1/search/videos?search=Beethoven&count=10&categoryOneOf=1')
    const candidate = sepia.data.data.find(video => /Sonate au Clair de Lune/i.test(video.name))
    if (!candidate) throw new Error('No bounded PeerTube performance control')
    const candidateUrl = new URL(candidate.url)
    if (candidateUrl.protocol !== 'https:' || candidateUrl.username || candidateUrl.password || candidateUrl.port) throw new Error('Unsafe control origin')
    const detail = await json(`${candidateUrl.origin}/api/v1/videos/${candidate.uuid}`)
    const files = (detail.data.files ?? []).filter(file => /\.mp4$/.test(new URL(file.fileUrl).pathname) && new URL(file.fileUrl).origin === candidateUrl.origin && file.size > 0 && file.size <= 16 * 1024 ** 2).sort((a, b) => a.size - b.size)
    if (!files.length) throw new Error('No small progressive PeerTube MP4 control')
    const wiki = await json('https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=filetype%3Aaudio%20Beethoven&gsrnamespace=6&gsrlimit=2&prop=imageinfo&iiprop=url%7Cmime%7Csize%7Ccommonmetadata&format=json&origin=*')
    const common = Object.values(wiki.data.query.pages).find(item => /Symphonie 5/.test(item.title)) ?? Object.values(wiki.data.query.pages)[0]
    const media = common?.imageinfo?.[0]
    if (!media || new URL(media.url).hostname !== 'upload.wikimedia.org') throw new Error('No Commons audio control')
    const controls = [
      { provider: 'peertube', searchStatus: sepia.status, searchType: sepia.type, searchResults: sepia.data.total,
        detailStatus: detail.status, detailType: detail.type, public: detail.data.privacy?.id === 1, title: detail.data.name,
        uploader: detail.data.account?.displayName, expectedDuration: detail.data.duration, metadataBytes: files[0].size,
        downloadEnabled: detail.data.downloadEnabled, url: files[0].fileUrl, mime: 'video/mp4', canonicalMasterVerified: false },
      { provider: 'commons', searchStatus: wiki.status, searchType: wiki.type, title: common.title,
        performers: media.commonmetadata?.find(field => field.name === 'Artist')?.value,
        metadataBytes: media.size, url: media.url, mime: media.mime, canonicalMasterVerified: false },
    ]
    globalThis.__openAudioCatalogProbe = { controls, blobs: [], audio: null }
    return controls
  })
  report.checks.push({ name: 'Anonymous cross-origin public search and progressive-media discovery', controls: discovery })
  for (let index = 0; index < discovery.length; index++) {
    const fetched = await evaluate(async function (index) {
      const probe = globalThis.__openAudioCatalogProbe, control = probe.controls[index]
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 25000)
      try {
        const response = await fetch(control.url, { credentials: 'omit', signal: controller.signal })
        if (!response.ok || !response.body) throw new Error('Audio HTTP ' + response.status)
        const reader = response.body.getReader(), chunks = []
        let bytes = 0
        while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 16 * 1024 ** 2) { await reader.cancel(); throw new Error('Audio control exceeds limit') }; chunks.push(part.value) }
        const body = new Uint8Array(bytes)
        let offset = 0
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length }
        const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', body))].map(byte => byte.toString(16).padStart(2, '0')).join('')
        if (probe.audio) { probe.audio.pause(); probe.audio.removeAttribute('src'); probe.audio.load() }
        const blob = URL.createObjectURL(new Blob([body], { type: control.mime })); probe.blobs.push(blob)
        const audio = new Audio(blob); audio.volume = 0.25; probe.audio = audio
        document.getElementById('open-audio-control-play')?.remove()
        const button = document.createElement('button'); button.id = 'open-audio-control-play'; button.textContent = `Play ${control.provider} control`
        button.onclick = event => { probe.trustedClick = event.isTrusted; audio.play().catch(error => probe.playError = error.name) }
        probe.playError = null
        document.body.prepend(button)
        return { provider: control.provider, status: response.status, type: response.type, contentType: response.headers.get('content-type'), byteLength: bytes,
          metadataBytes: control.metadataBytes, sha256, canonicalMasterVerified: false }
      } finally { clearTimeout(timer) }
    }, index)
    assert.equal(fetched.status, 200); assert.equal(fetched.byteLength, fetched.metadataBytes)
    await page.click('#open-audio-control-play')
    const snapshot = () => evaluate(function () {
      const probe = globalThis.__openAudioCatalogProbe, audio = probe.audio
      return { time: audio.currentTime, duration: Number.isFinite(audio.duration) ? audio.duration : null, paused: audio.paused,
        muted: audio.muted, error: audio.error?.code ?? null, playError: probe.playError, trustedClick: probe.trustedClick, visibility: document.visibilityState }
    })
    const until = async condition => {
      const started = Date.now()
      while (Date.now() - started < 20000) { const value = await snapshot(); if (condition(value)) return value; if (value.error || value.playError) throw new Error(JSON.stringify(value)); await new Promise(resolve => setTimeout(resolve, 250)) }
      throw new Error('Native audio control timeout')
    }
    const initial = await until(value => value.time > 2 && !value.paused)
    if (discovery[index].expectedDuration) assert.ok(Math.abs(initial.duration - discovery[index].expectedDuration) < 3)
    const midpoint = initial.duration / 2
    await evaluate(function (time) { globalThis.__openAudioCatalogProbe.audio.currentTime = time }, midpoint)
    const afterSeek = await until(value => value.time > midpoint + 1 && !value.paused)
    const front = await browser.newPage(); await front.goto('about:blank'); await front.bringToFront()
    const hiddenBefore = await snapshot()
    await new Promise(resolve => setTimeout(resolve, 10000))
    const hiddenAfter = await snapshot()
    assert.ok(hiddenAfter.time - hiddenBefore.time > 8)
    await page.bringToFront(); await front.close()
    report.checks.push({ name: 'Complete public file and native audio transport: ' + fetched.provider, ...fetched, initial, afterSeek, hiddenBefore, hiddenAfter })
  }
  await evaluate(function () {
    const probe = globalThis.__openAudioCatalogProbe
    probe.audio.pause(); probe.audio.removeAttribute('src'); probe.audio.load()
    for (const blob of probe.blobs) URL.revokeObjectURL(blob)
  })
  passed = true
} catch (error) {
  report.failure = { name: error.name, message: String(error.message).replace(/https?:\/\/[^\s]+/g, '[URL]').slice(0, 1000) }
  process.exitCode = 1
} finally {
  await browser.close(); report.pass = passed
  const output = new URL('../../artifacts/pwa-port/', import.meta.url); await mkdir(output, { recursive: true })
  const name = 'open-audio-catalog-transports-' + report.testedAt.replace(/[:.]/g, '-') + '.json'
  await writeFile(new URL(name, output), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ pass: passed, report: name, checks: report.checks.length, failure: report.failure }))
}
