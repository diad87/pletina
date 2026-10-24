// Live allowed-download route and offline SW/cache validation, separate from canonical matching.
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import ts from 'typescript'
import puppeteer from 'puppeteer-core'

const compile = async name => ts.transpileModule(await readFile(new URL(`../../web-port/${name}.ts`, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
}).outputText
const target = process.argv[2] || 'https://diad87.github.io/pletina/'
const report = { schemaVersion: 1, testedAt: new Date().toISOString(),
  scope: 'Actual Audius explicitly-downloadable control, production download manager and PWA SW/cache/IDB. This is a route gate, not a canonical-catalog match; targetKind identifies which worker is tested.',
  providerResponsesMocked: false, sourceSelectionInjectedFromRealMetadata: true, syntheticLibraryId: true,
  noRuntimeBackend: true, targetKind: new URL(target).hostname === 'diad87.github.io' ? 'published Pages worker' : 'static compiled PWA QA worker',
  noAccountOrSubscription: true, physicalDevice: false, phoneScreenOffVerified: false, checks: [] }
const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ignoreDefaultArgs: ['--mute-audio', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'] })
let passed = false
try {
  const page = await browser.newPage()
  await page.goto(target, { waitUntil: 'load', timeout: 30000 })
  report.build = await page.$eval('#version', node => node.textContent.trim())
  if (process.argv[3]) assert.ok(report.build.includes(process.argv[3]), 'Expected compiled build')
  await page.waitForFunction(() => navigator.serviceWorker.controller, { timeout: 30000 })
  const session = await page.createCDPSession()
  const { result: root } = await session.send('Runtime.evaluate', { expression: 'globalThis', userGesture: false })
  const evaluate = async (fn, ...args) => {
    const { result, exceptionDetails } = await session.send('Runtime.callFunctionOn', { objectId: root.objectId,
      functionDeclaration: fn.toString(), arguments: args.map(value => ({ value })), awaitPromise: true, returnByValue: true, userGesture: false })
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text)
    return result.value
  }
  const [downloadCode, storeCode] = await Promise.all([compile('downloads'), compile('download-store')])
  const online = await evaluate(async function (downloadCode, storeCode) {
    const response = await fetch('https://api.audius.co/v1/tracks/dloY13J', { credentials: 'omit', referrerPolicy: 'no-referrer' })
    if (!response.ok) throw new Error('Audius metadata HTTP ' + response.status)
    const { data } = await response.json()
    const allowed = data.is_downloadable === true && data.is_download_gated === false && data.access?.download === true
    if (!allowed || !data.is_available || data.is_stream_gated || data.access?.stream !== true) throw new Error('Control is not publicly downloadable')
    const blob = text => URL.createObjectURL(new Blob([text], { type: 'text/javascript' }))
    const storeUrl = blob(storeCode), unusedUrl = blob('export function resolveRemoteTrack(){throw new Error("Uninjected resolver")};export function stream(){throw new Error("YouTube must not be called")};export function createDownloadCovers(){throw new Error("Uninjected covers")};')
    const moduleUrl = blob(downloadCode.replace("'./download-store'", JSON.stringify(storeUrl)).replace("'./audio'", JSON.stringify(unusedUrl)).replace("'./youtube'", JSON.stringify(unusedUrl)).replace("'./download-covers'", JSON.stringify(unusedUrl)))
    const storeModule = await import(storeUrl), module = await import(moduleUrl)
    const events = [], id = 1999999901, audioEvents = [], audioInstances = []
    const NativeAudio = globalThis.Audio
    globalThis.Audio = new Proxy(NativeAudio, { construct(target, args) {
      const audio = Reflect.construct(target, args), index = audioInstances.push(audio) - 1
      for (const name of ['loadedmetadata', 'loadeddata', 'canplay', 'seeked', 'seeking', 'error', 'suspend', 'stalled', 'progress']) audio.addEventListener(name, () => {
        audioEvents.push({ name, index, time: audio.currentTime, duration: Number.isFinite(audio.duration) ? audio.duration : null,
          readyState: audio.readyState, seeking: audio.seeking, error: audio.error?.code ?? null })
      })
      return audio
    } })
    const track = { id, title: data.title, duration: data.duration, artistId: 0, artistName: data.user.name,
      albumId: 0, albumTitle: 'Audius download route QA', albumArtistId: 0, explicit: false, cover: null }
    const store = storeModule.createDownloadStore({ scope: new URL('./', location.href) })
    const manager = module.createDownloadManager({ store, covers: false, emit: event => events.push(event), timeout: 60000,
      resolve: async () => ({ videoId: '', url: `https://api.audius.co/v1/tracks/${data.id}/stream`, title: data.title,
        channel: data.user.name, local: false, source: { provider: 'audius', id: data.id, download: { allowed, duration: data.duration } } }) })
    globalThis.__catalogDownloadProbe = { store, manager, events, track }
    await manager.enqueueDownloads([track]); await manager.idle()
    const terminal = events.findLast(event => ['done', 'error', 'cancelled'].includes(event.state))
    if (terminal?.state !== 'done') return { error: terminal?.error || 'Download did not complete', audioEvents: audioEvents.slice(-40),
      instances: audioInstances.map(audio => ({ time: audio.currentTime, duration: Number.isFinite(audio.duration) ? audio.duration : null,
        readyState: audio.readyState, seeking: audio.seeking, error: audio.error?.code ?? null })) }
    const row = await store.get(id), playable = await store.readDownloadedPlayable(id)
    const cached = await (await caches.open(storeModule.DOWNLOAD_CACHE)).match(row.cacheKey)
    globalThis.__catalogDownloadProbe.playable = playable
    return { provider: { id: data.id, title: data.title, artist: data.user.name, duration: data.duration, isrc: data.isrc,
      isDownloadable: data.is_downloadable, isDownloadGated: data.is_download_gated, access: data.access },
      terminal, savedSize: row.size, cachedType: cached.type, cachedStatus: cached.status, contentType: cached.headers.get('content-type'),
      mediaUrlInternal: new URL(playable.url).origin === location.origin, sourceIdsOrMediaUrlsInDatabase: /api\.audius|signature|https:\/\/.*\/stream/.test(JSON.stringify(row)) }
  }, downloadCode, storeCode)
  if (online.error) { report.checks.push({ name: 'Allowed download diagnostic', ...online }); throw new Error(online.error) }
  assert.ok(online.savedSize > 1000000); assert.equal(online.cachedStatus, 200)
  assert.equal(online.mediaUrlInternal, true); assert.equal(online.sourceIdsOrMediaUrlsInDatabase, false)
  report.checks.push({ name: 'Real allowed Audius file streams to CacheStorage, tail/duration validation precedes commit', ...online })
  await page.setOfflineMode(true)
  const offline = await evaluate(async function () {
    const probe = globalThis.__catalogDownloadProbe
    const response = await fetch(probe.playable.url)
    const bytes = await response.arrayBuffer(), length = bytes.byteLength
    const hash = await crypto.subtle.digest('SHA-256', bytes)
    const sha256 = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('')
    const audio = new Audio(probe.playable.url)
    audio.volume = 0.25
    probe.audio = audio
    const button = document.createElement('button'); button.id = 'catalog-offline-play'; button.textContent = 'Play downloaded Audius audio offline'
    button.onclick = event => { probe.trustedClick = event.isTrusted; audio.play().catch(error => probe.playError = error.name) }
    document.body.prepend(button)
    return { online: navigator.onLine, status: response.status, byteLength: length, sha256 }
  })
  assert.equal(offline.online, false); assert.equal(offline.status, 200); assert.equal(offline.byteLength, online.savedSize)
  await page.click('#catalog-offline-play')
  const snapshot = () => evaluate(function () {
    const probe = globalThis.__catalogDownloadProbe, audio = probe.audio
    return { online: navigator.onLine, time: audio.currentTime, duration: Number.isFinite(audio.duration) ? audio.duration : null,
      paused: audio.paused, muted: audio.muted, error: audio.error?.code ?? null, playError: probe.playError ?? null, trustedClick: probe.trustedClick }
  })
  const until = async test => {
    const started = Date.now()
    while (Date.now() - started < 25000) { const value = await snapshot(); if (test(value)) return value; if (value.error || value.playError) throw new Error(JSON.stringify(value)); await new Promise(resolve => setTimeout(resolve, 250)) }
    throw new Error('Offline audio timeout')
  }
  const initial = await until(value => value.time > 2 && !value.paused)
  await evaluate(function () { const probe = globalThis.__catalogDownloadProbe; probe.audio.currentTime = probe.track.duration / 2 })
  const afterSeek = await until(value => value.time > online.provider.duration / 2 + 1 && !value.paused)
  report.checks.push({ name: 'Offline native audio advances and seeks from the production SW internal route', ...offline, initial, afterSeek })
  await evaluate(async function () {
    const probe = globalThis.__catalogDownloadProbe
    probe.audio.pause(); probe.audio.removeAttribute('src'); probe.audio.load()
    await probe.manager.removeDownloads([probe.track.id]); await probe.store.close()
  })
  passed = true
} catch (error) {
  report.failure = { name: error.name, message: String(error.message).replace(/https?:\/\/[^\s]+/g, '[URL]').slice(0, 1000) }
  process.exitCode = 1
} finally {
  await browser.close(); report.pass = passed
  const output = new URL('../../artifacts/pwa-port/', import.meta.url); await mkdir(output, { recursive: true })
  const name = 'catalog-downloads-audius-live-' + report.testedAt.replace(/[:.]/g, '-') + '.json'
  await writeFile(new URL(name, output), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ pass: passed, report: name, checks: report.checks.length, failure: report.failure }))
}
