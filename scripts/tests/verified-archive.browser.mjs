// Actual Pages-origin canonical lookup -> curated full-file/SHA Blob -> native audio.
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import ts from 'typescript'
import puppeteer from 'puppeteer-core'

const compile = async name => ts.transpileModule(await readFile(new URL(`../../web-port/${name}.ts`, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
}).outputText
const report = { schemaVersion: 1, testedAt: new Date().toISOString(),
  scope: 'Real public canonical catalog metadata and curated Archive complete MP3, production verified-audio module in browser from Pages. Native audio, full RAM decode, seek and hidden desktop tab only.',
  providerResponsesMocked: false, noRuntimeBackend: true, noAccountOrSubscription: true,
  mediaOrSignedUrlsPersisted: false, physicalDevice: false, phoneScreenOffVerified: false, checks: [] }
const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ignoreDefaultArgs: ['--mute-audio', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] })
let passed = false
try {
  const page = await browser.newPage()
  await page.goto('https://diad87.github.io/pletina/', { waitUntil: 'load', timeout: 30000 })
  const session = await page.createCDPSession()
  const { result: root } = await session.send('Runtime.evaluate', { expression: 'globalThis', userGesture: false })
  const evaluate = async (fn, ...args) => {
    const { result, exceptionDetails } = await session.send('Runtime.callFunctionOn', { objectId: root.objectId,
      functionDeclaration: fn.toString(), arguments: args.map(value => ({ value })), awaitPromise: true, returnByValue: true, userGesture: false })
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text)
    return result.value
  }
  const codes = await Promise.all(['catalog', 'verified-sources', 'verified-archive-source', 'verified-audio'].map(compile))
  const identity = await evaluate(async function (codes) {
    const blobModule = text => URL.createObjectURL(new Blob([text], { type: 'text/javascript' }))
    const [catalogUrl, aleaUrl, archiveUrl] = codes.slice(0, 3).map(blobModule)
    const sourceUrl = blobModule(codes[3].replace("'./verified-sources'", JSON.stringify(aleaUrl)).replace("'./verified-archive-source'", JSON.stringify(archiveUrl)))
    const catalog = await import(catalogUrl), verified = await import(sourceUrl), { EGIOZU_ARCHIVE_CANDIDATE: registered } = await import(archiveUrl)
    for (const url of [catalogUrl, aleaUrl, archiveUrl, sourceUrl]) URL.revokeObjectURL(url)
    const toQuery = detail => ({ id: detail.id, title: detail.title, titleVersion: detail.titleVersion, artist: detail.artist.name,
      album: detail.album.title, duration: detail.duration, isrc: detail.isrc })
    const query = toQuery(catalog.mapTopTrack(await catalog.requestCatalog('/track/3266797141')))
    const rejectedEdition = toQuery(catalog.mapTopTrack(await catalog.requestCatalog('/track/3266743431')))
    const rejected = await verified.resolveVerifiedAudio(rejectedEdition)
    const source = await verified.resolveVerifiedAudio(query)
    if (!source || rejected) throw new Error('Canonical association gate failed')
    const bytes = await (await fetch(source.url)).arrayBuffer(), byteLength = bytes.byteLength
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
    const context = new AudioContext()
    let decoded
    try { const audio = await context.decodeAudioData(bytes); decoded = { duration: audio.duration, channels: audio.numberOfChannels, sampleRate: audio.sampleRate } }
    finally { await context.close() }
    globalThis.__verifiedArchiveProbe = { verified, query, source }
    return { query, rejectedEdition, rejectedResult: rejected, identity: source.source, blobSchemeOnly: new URL(source.url).protocol === 'blob:',
      byteLength, sha256, expectedSha256: registered.file.sha256, expectedBytes: registered.file.bytes, decoded }
  }, codes)
  assert.equal(identity.blobSchemeOnly, true); assert.equal(identity.identity.provider, 'archive')
  assert.equal(identity.identity.startAt, 0); assert.equal(identity.identity.download.allowed, false)
  assert.equal(identity.byteLength, identity.expectedBytes); assert.equal(identity.sha256, identity.expectedSha256)
  assert.ok(Math.abs(identity.decoded.duration - identity.query.duration) < 3)
  assert.equal(identity.rejectedEdition.isrc, 'QM7281675301')
  report.checks.push({ name: 'Canonical identity, different-edition rejection and complete verified file', ...identity })
  await evaluate(function () {
    const probe = globalThis.__verifiedArchiveProbe, audio = new Audio(probe.source.url)
    audio.volume = 0.25; probe.audio = audio
    const button = document.createElement('button'); button.id = 'verified-archive-play'; button.textContent = 'Play verified Archive recording'
    button.onclick = event => { probe.trustedClick = event.isTrusted; audio.play().catch(error => probe.playError = error.name) }
    document.body.prepend(button)
  })
  await page.click('#verified-archive-play')
  const snapshot = () => evaluate(function () {
    const probe = globalThis.__verifiedArchiveProbe, audio = probe.audio
    return { time: audio.currentTime, duration: Number.isFinite(audio.duration) ? audio.duration : null, paused: audio.paused,
      muted: audio.muted, error: audio.error?.code ?? null, playError: probe.playError ?? null, trustedClick: probe.trustedClick,
      visibility: document.visibilityState }
  })
  const until = async condition => {
    const started = Date.now()
    while (Date.now() - started < 25000) { const value = await snapshot(); if (condition(value)) return value; if (value.error || value.playError) throw new Error(JSON.stringify(value)); await new Promise(resolve => setTimeout(resolve, 250)) }
    throw new Error('Verified Archive audio timeout')
  }
  const initial = await until(value => value.time > 2 && !value.paused)
  await evaluate(function () { globalThis.__verifiedArchiveProbe.audio.currentTime = 63 })
  const afterSeek = await until(value => value.time > 64 && !value.paused)
  const front = await browser.newPage(); await front.goto('about:blank'); await front.bringToFront()
  const hiddenBefore = await snapshot()
  await new Promise(resolve => setTimeout(resolve, 10000))
  const hiddenAfter = await snapshot()
  assert.equal(hiddenAfter.visibility, 'hidden'); assert.ok(hiddenAfter.time - hiddenBefore.time > 8)
  report.checks.push({ name: 'Native audio starts with one trusted click, seeks and advances in a hidden desktop tab', initial, afterSeek, hiddenBefore, hiddenAfter })
  await page.bringToFront()
  await evaluate(function () {
    const probe = globalThis.__verifiedArchiveProbe
    probe.audio.pause(); probe.audio.removeAttribute('src'); probe.audio.load(); probe.verified.disposeVerifiedAudio()
  })
  passed = true
} catch (error) {
  report.failure = { name: error.name, message: String(error.message).replace(/https?:\/\/[^\s]+/g, '[URL]').slice(0, 1000) }
  process.exitCode = 1
} finally {
  await browser.close(); report.pass = passed
  const output = new URL('../../artifacts/pwa-port/', import.meta.url); await mkdir(output, { recursive: true })
  const name = 'verified-archive-live-' + report.testedAt.replace(/[:.]/g, '-') + '.json'
  await writeFile(new URL(name, output), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ pass: passed, report: name, checks: report.checks.length, failure: report.failure }))
}
