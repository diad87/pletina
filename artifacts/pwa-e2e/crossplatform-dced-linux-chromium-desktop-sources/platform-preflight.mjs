// Browser-only preflight. SDK paths are inspected; no adb, emulator or DHU process is run.
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const workspace = fileURLToPath(new URL('../../../', import.meta.url))
export const PLATFORM_TARGETS = Object.freeze([
  { id: 'chromium-android-layout', engine: 'chromium', kind: 'desktop-emulation', device: 'Pixel 7', physical: false },
  { id: 'webkit-iphone-layout', engine: 'webkit', kind: 'desktop-emulation', device: 'iPhone 13', physical: false },
  { id: 'chromium-desktop', engine: 'chromium', kind: 'desktop-browser', physical: false },
  { id: 'firefox-desktop', engine: 'firefox', kind: 'desktop-browser', physical: false, optional: true },
  { id: 'android-physical', kind: 'physical-device', physical: true },
  { id: 'iphone-physical', kind: 'physical-device', physical: true },
  { id: 'android-auto', kind: 'car-integration', physical: false },
  { id: 'carplay', kind: 'car-integration', physical: false },
])
const scrub = value => String(value ?? '').replace(/https?:\/\/[^\s"'<>]+/g, '[URL]').replace(/\u001b\[[0-9;]*m/g, '').slice(0, 1600)
const file = path => ({ path, present: existsSync(path) })
function browserExecutable(path, browsersPath) {
  if (!browsersPath) return path
  // Also works when another module imported Playwright before this function set the env.
  const parts = path.split(/[\\/]/), index = parts.findIndex(part => /^(?:chromium|webkit|firefox)-\d+$/.test(part))
  return index < 0 ? path : join(browsersPath, ...parts.slice(index))
}
function wav() {
  const bytes = Buffer.alloc(16044)
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(16000, 40)
  return bytes
}
async function toolInventory(androidSdk) {
  const candidates = [androidSdk, process.env.ANDROID_SDK_ROOT, process.env.ANDROID_HOME,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Android', 'Sdk'), 'C:/Android/Sdk', 'D:/Android/Sdk']
    .filter(Boolean).map(path => resolve(path))
  const roots = [...new Set(candidates)].filter(path => existsSync(path))
  const sdk = roots.map(path => ({ path,
    adb: file(join(path, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb')),
    emulator: file(join(path, 'emulator', process.platform === 'win32' ? 'emulator.exe' : 'emulator')),
    dhu: file(join(path, 'extras', 'google', 'auto', process.platform === 'win32' ? 'desktop-head-unit.exe' : 'desktop-head-unit')),
  }))
  const manifest = await readFile(join(workspace, 'src-tauri/gen/android/app/src/main/AndroidManifest.xml'), 'utf8').catch(() => '')
  const service = await readFile(join(workspace, 'src-tauri/gen/android/app/src/main/java/dev/musify/desktop/PlaybackService.kt'), 'utf8').catch(() => '')
  return { androidSdk: sdk, androidCommandsExecuted: [],
    xcode: { supportedHost: process.platform === 'darwin', inspected: process.platform === 'darwin',
      applicationPresent: process.platform === 'darwin' && existsSync('/Applications/Xcode.app') },
    nativeAndroidSource: { mediaLibraryService: /class PlaybackService\s*:\s*MediaLibraryService/.test(service),
      automotiveMetadata: manifest.includes('com.google.android.gms.car.application'),
      mediaBrowserIntent: manifest.includes('android.media.browse.MediaBrowserService'),
      sourceInspectionOnly: true },
    physicalDeviceConnectionChecked: false,
  }
}
async function probe(engine, executable, origin) {
  if (!existsSync(executable)) return { status: 'blocked', reason: 'Executable is not installed at the selected path.', executable }
  let browser
  try {
    browser = await engine.launch({ headless: true, executablePath: executable, timeout: 20000 })
    const context = await browser.newContext({ serviceWorkers: 'allow' })
    const page = await context.newPage()
    await page.goto(origin, { waitUntil: 'load', timeout: 15000 })
    const capabilities = await page.evaluate(async () => {
      const audio = new Audio()
      const result = { secureContext: isSecureContext, indexedDB: false, cacheStorage: false, serviceWorker: false,
        mediaSession: 'mediaSession' in navigator, touchEvent: 'ontouchstart' in window,
        wav: audio.canPlayType('audio/wav'), aacMp4: audio.canPlayType('audio/mp4; codecs="mp4a.40.2"'),
        userAgent: navigator.userAgent }
      try {
        await new Promise((resolve, reject) => {
          const request = indexedDB.open('platform-preflight', 1)
          request.onupgradeneeded = () => request.result.createObjectStore('rows')
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            const db = request.result, tx = db.transaction('rows', 'readwrite')
            tx.objectStore('rows').put('kept', 'key')
            tx.oncomplete = () => { db.close(); result.indexedDB = true; resolve() }
            tx.onabort = () => { db.close(); reject(tx.error) }
          }
        })
      } catch (error) { result.indexedDBError = error.name }
      try {
        const cache = await caches.open('platform-preflight')
        await cache.put('/known', new Response('kept'))
        result.cacheStorage = await (await cache.match('/known')).text() === 'kept'
      } catch (error) { result.cacheStorageError = error.name }
      try {
        const registration = await navigator.serviceWorker.register('/sw.js')
        await Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))])
        result.serviceWorker = Boolean(registration.active)
      } catch (error) { result.serviceWorkerError = error.name }
      return result
    })
    // A real click activates a local WAV. This is a codec/host probe, not product playback.
    let audioProbe
    try {
      await page.locator('button').click()
      await page.waitForFunction(() => window.preflightAudio?.currentTime > 0.05 || window.preflightAudioFailure, undefined, { timeout: 5000 })
      audioProbe = await page.evaluate(() => ({
        status: window.preflightAudioFailure ? 'fail' : 'pass', error: window.preflightAudioFailure ?? null,
        time: window.preflightAudio?.currentTime ?? null, duration: window.preflightAudio?.duration ?? null,
      }))
    } catch (error) { audioProbe = { status: 'blocked', reason: scrub(error.message) } }
    const required = ['secureContext', 'indexedDB', 'cacheStorage', 'serviceWorker']
    return { status: required.every(name => capabilities[name]) ? 'pass' : 'fail',
      reason: 'Desktop browser launch and storage/SW preflight; no product feature or physical platform result.',
      executable, version: browser.version(), capabilities, audioProbe }
  } catch (error) { return { status: 'blocked', executable, reason: scrub(error.message) } }
  finally { await browser?.close().catch(() => {}) }
}

export async function runPlatformPreflight(options = {}) {
  const browsersPath = options.browsersPath ?? process.env.PLAYWRIGHT_BROWSERS_PATH
  if (browsersPath) process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath
  const require = createRequire(import.meta.url)
  const report = { schemaVersion: 1, testedAt: new Date().toISOString(), host: { platform: process.platform, arch: process.arch, node: process.version },
    kind: 'platform-preflight', featureE2E: false, physicalPlatformsTested: false, engines: {}, targets: [], tools: await toolInventory(options.androidSdk),
    constraints: ['No adb, Android emulator, DHU or device daemon is launched.', 'Desktop emulation is not physical Android/iPhone, installed iOS PWA, Android Auto or CarPlay.'] }
  let server
  try {
    const playwright = require(options.playwrightPath ?? 'playwright')
    const packageFile = require.resolve((options.playwrightPath ?? 'playwright') + '/package.json')
    report.playwrightVersion = JSON.parse(await readFile(packageFile, 'utf8')).version
    const wave = wav()
    server = createServer((request, response) => {
      if (request.url === '/sw.js') { response.writeHead(200, { 'Content-Type': 'application/javascript' }); response.end("self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()))"); return }
      if (request.url === '/audio.wav') { response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wave.length }); response.end(wave); return }
      response.writeHead(200, { 'Content-Type': 'text/html' })
      response.end('<!doctype html><button onclick="window.preflightAudio=new Audio(\'/audio.wav\');preflightAudio.play().catch(e=>window.preflightAudioFailure=e.name)">Probe</button>')
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const origin = `http://127.0.0.1:${server.address().port}`
    for (const name of ['chromium', 'webkit', 'firefox']) {
      const executable = name === 'chromium' && options.chromePath ? resolve(options.chromePath)
        : browserExecutable(playwright[name].executablePath(), browsersPath)
      report.engines[name] = options.launch === false ? { status: 'blocked', reason: 'Launch was disabled; file inventory only.', ...file(executable) }
        : await probe(playwright[name], executable, origin)
    }
  } catch (error) { report.setupError = scrub(error.message) }
  finally {
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
    report.cleanup = { serverClosed: !server?.listening, browserProfiles: 'Disposable Playwright contexts; every launched browser closed in finally.' }
  }
  report.targets = PLATFORM_TARGETS.map(target => {
    if (target.engine) return { ...target, status: report.engines[target.engine]?.status ?? 'blocked',
      reason: report.engines[target.engine]?.reason ?? 'Playwright setup was unavailable.', scope: 'Engine preflight only; feature cases have separate results.' }
    if (target.kind === 'physical-device') return { ...target, status: 'blocked',
      reason: target.id === 'iphone-physical' ? 'No physical iPhone runner/evidence configured. Windows cannot run Apple iOS Simulator.' : 'No physical Android runner/evidence configured. Device connection was not inspected and no device automation was attempted.' }
    return { ...target, status: 'unsupported', reason: target.id === 'android-auto'
      ? 'This static PWA does not expose the native Android MediaLibraryService/MediaBrowserService required for Android Auto media integration. The APK source is a separate target, not exercised here.'
      : 'This static PWA is not a signed iOS CarPlay app with the audio entitlement and CarPlay scenes. A browser viewport cannot substitute for that integration.' }
  })
  report.counts = Object.fromEntries(['pass', 'fail', 'blocked', 'unsupported'].map(status => [status, report.targets.filter(target => target.status === status).length]))
  report.allRequestedPlatformsVerified = false
  report.finishedAt = new Date().toISOString()
  if (options.output) { const output = resolve(options.output); await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n') }
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
  const report = await runPlatformPreflight({ playwrightPath: option('--playwright', undefined), browsersPath: option('--browsers', undefined),
    chromePath: option('--chrome', undefined), androidSdk: option('--android-sdk', undefined), launch: !args.includes('--inventory-only'),
    output: option('--report', join(workspace, 'artifacts/pwa-e2e/platform-preflight.json')) })
  console.log(JSON.stringify({ kind: report.kind, engines: Object.fromEntries(Object.entries(report.engines).map(([name, result]) => [name, { status: result.status, version: result.version, capabilities: result.capabilities, audioProbe: result.audioProbe }])), counts: report.counts, allRequestedPlatformsVerified: false }, null, 2))
  if (report.setupError || Object.values(report.engines).some(engine => engine.status === 'fail')) process.exitCode = 1
}
