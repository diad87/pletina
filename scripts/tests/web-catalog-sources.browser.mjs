// Live provider gate from the real static PWA origin. No interception, proxy or credentials.
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import ts from 'typescript'
import puppeteer from 'puppeteer-core'

const output = new URL('../../artifacts/pwa-port/', import.meta.url)
const compile = async name => ts.transpileModule(await readFile(new URL(`../../web-port/${name}.ts`, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
}).outputText
const report = { schemaVersion: 1, testedAt: new Date().toISOString(),
  scope: 'Real Audius and Deezer requests from GitHub Pages; native HTMLAudio and full-file in-memory decode. Desktop only.',
  noProviderMocks: true, noRuntimeBackend: true, noLoginOrApplicationKey: true,
  physicalDevice: false, phoneScreenOffVerified: false, mediaOrSignedUrlsPersisted: false, checks: [] }
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
  const [catalogCode, sourceCode] = await Promise.all([compile('catalog'), compile('catalog-sources')])
  await evaluate(async function (catalogCode, sourceCode) {
    const catalogUrl = URL.createObjectURL(new Blob([catalogCode], { type: 'text/javascript' }))
    const sourceUrl = URL.createObjectURL(new Blob([sourceCode.replace("'./catalog'", JSON.stringify(catalogUrl))], { type: 'text/javascript' }))
    globalThis.__catalogProbe = { catalog: await import(catalogUrl), sources: await import(sourceUrl) }
    URL.revokeObjectURL(sourceUrl); URL.revokeObjectURL(catalogUrl)
  }, catalogCode, sourceCode)
  const controls = await evaluate(async function () {
    const { catalog, sources } = globalThis.__catalogProbe
    const controls = []
    for (const isrc of ['GXLEX2692321', 'QMDA72636635', 'QZVN42200039']) {
      const raw = await catalog.requestCatalog('/track/isrc:' + isrc)
      const detail = catalog.mapTopTrack(raw)
      const query = { id: detail.id, title: detail.title, titleVersion: detail.titleVersion, artist: detail.artist.name,
        album: detail.album.title, duration: detail.duration, isrc: detail.isrc }
      const source = await sources.resolveCatalogSource(query)
      controls.push({ query, source })
    }
    const first = controls[0]
    globalThis.__catalogProbe.first = first
    const hydrated = await sources.resolveCatalogSource({ ...first.query, isrc: null })
    const wrongArtist = await sources.resolveCatalogSource({ ...first.query, artist: 'Another Artist' })
    const remix = await sources.resolveCatalogSource({ ...first.query, titleVersion: '(Remix)' })
    const exactMissing = await sources.resolveCatalogSource({ id: 3250715431, title: 'Iritsi da Eguna', artist: 'Pirritx eta Porrotx',
      album: 'Eskerrik Asko!', duration: 169, isrc: 'QM6N21424821' })
    return { controls, hydrated, wrongArtist, remix, exactMissing }
  })
  report.checks.push({ name: 'Canonical catalog recording matches with independent public ISRC lookup', ...controls })
  assert.equal(controls.controls.filter(control => control.source?.source?.provider === 'audius').length, 3)
  assert.equal(controls.hydrated?.source?.id, controls.controls[0].source.source.id)
  assert.equal(controls.wrongArtist, null); assert.equal(controls.remix, null); assert.equal(controls.exactMissing, null)
  await evaluate(function () {
    const button = document.createElement('button'); button.id = 'catalog-audio-play'; button.textContent = 'Play verified catalog audio'
    const audio = new Audio(globalThis.__catalogProbe.first.source.url)
    audio.crossOrigin = 'anonymous'; audio.volume = 0.25; audio.preload = 'auto'
    globalThis.__catalogProbe.audio = audio
    button.onclick = event => { globalThis.__catalogProbe.trustedClick = event.isTrusted; audio.play().catch(error => globalThis.__catalogProbe.playError = error.name) }
    document.body.prepend(button)
  })
  await page.click('#catalog-audio-play')
  const snapshot = () => evaluate(function () {
    const state = globalThis.__catalogProbe, audio = state.audio
    return { time: audio.currentTime, duration: Number.isFinite(audio.duration) ? audio.duration : null, paused: audio.paused,
      muted: audio.muted, volume: audio.volume, error: audio.error?.code ?? null, playError: state.playError ?? null,
      trustedClick: state.trustedClick, visibility: document.visibilityState }
  })
  const until = async condition => {
    const start = Date.now()
    while (Date.now() - start < 25000) { const value = await snapshot(); if (condition(value)) return value; if (value.error || value.playError) throw new Error(JSON.stringify(value)); await new Promise(resolve => setTimeout(resolve, 250)) }
    throw new Error('Live audio timeout')
  }
  const initial = await until(value => value.time > 2)
  await evaluate(function () { globalThis.__catalogProbe.audio.currentTime = 110 })
  const afterSeek = await until(value => value.time > 111 && !value.paused)
  const foreground = await browser.newPage(); await foreground.goto('about:blank'); await foreground.bringToFront()
  const hiddenBefore = await snapshot()
  await new Promise(resolve => setTimeout(resolve, 10000))
  const hiddenAfter = await snapshot()
  await page.bringToFront()
  assert.ok(hiddenAfter.time - hiddenBefore.time > 8)
  const bytes = await evaluate(async function () {
    const response = await fetch(globalThis.__catalogProbe.first.source.url, { credentials: 'omit', referrerPolicy: 'no-referrer' })
    if (!response.ok) throw new Error('Full audio HTTP ' + response.status)
    const buffer = await response.arrayBuffer(), byteLength = buffer.byteLength
    const digest = await crypto.subtle.digest('SHA-256', buffer)
    const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
    const context = new AudioContext()
    try {
      const decoded = await context.decodeAudioData(buffer)
      return { status: response.status, contentType: response.headers.get('content-type'), byteLength, sha256,
        decodedDuration: decoded.duration, decodedChannels: decoded.numberOfChannels, sampleRate: decoded.sampleRate }
    } finally { await context.close() }
  })
  assert.ok(bytes.byteLength > 1000000)
  assert.ok(Math.abs(bytes.decodedDuration - controls.controls[0].query.duration) < 3)
  report.checks.push({ name: 'Unmuted native audio advances and seeks after one trusted click; complete file decodes',
    initial, afterSeek, hiddenBefore, hiddenAfter, bytes })
  await evaluate(function () { const audio = globalThis.__catalogProbe.audio; audio.pause(); audio.removeAttribute('src'); audio.load() })
  passed = true
} catch (error) {
  report.failure = { name: error.name, message: String(error.message).replace(/https?:\/\/[^\s]+/g, '[URL]').slice(0, 1000) }
  process.exitCode = 1
} finally {
  await browser.close()
  report.pass = passed
  await mkdir(output, { recursive: true })
  const name = 'catalog-sources-audius-canonical-live-' + report.testedAt.replace(/[:.]/g, '-') + '.json'
  await writeFile(new URL(name, output), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ pass: passed, report: name, checks: report.checks.length, failure: report.failure }))
}
