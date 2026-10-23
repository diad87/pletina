// Standalone host capability probe. It imports no product/player modules, uses
// no provider mocks and never edits the production AAC fixture.
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { release } from 'node:os'
import { PROFILES } from '../../scripts/tests/e2e/harness.mjs'

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('D:/tmp/pletina-e2e-browsers')) process.env.PLAYWRIGHT_BROWSERS_PATH = 'D:/tmp/pletina-e2e-browsers'
const { webkit, chromium } = await import('playwright')
const aac = await readFile(new URL('../../scripts/tests/e2e/fixtures/silence-12s.m4a', import.meta.url))
const rate = 48000, seconds = 2, channels = 1, bits = 16, dataSize = rate * seconds * channels * bits / 8
const wav = Buffer.alloc(44 + dataSize)
wav.write('RIFF', 0); wav.writeUInt32LE(36 + dataSize, 4); wav.write('WAVEfmt ', 8)
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(channels, 22)
wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * channels * bits / 8, 28)
wav.writeUInt16LE(channels * bits / 8, 32); wav.writeUInt16LE(bits, 34)
wav.write('data', 36); wav.writeUInt32LE(dataSize, 40)
const requestLog = []
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname
  if (pathname === '/') return response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Isolated media capability probe</title><button id="start">Play exact fixture</button>')
  const bytes = pathname === '/fixture.m4a' ? aac : pathname === '/control.wav' ? wav : null
  if (!bytes) return response.writeHead(404).end()
  const contentType = pathname.endsWith('.m4a') ? 'audio/mp4' : 'audio/wav'
  const entry = { path: pathname, method: request.method, range: request.headers.range ?? null, contentType }
  requestLog.push(entry)
  const headers = { 'content-type': contentType, 'accept-ranges': 'bytes', 'cache-control': 'no-store' }
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
  if (range) {
    const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1
    if (start > end || start >= bytes.length) return response.writeHead(416, { ...headers, 'content-range': 'bytes */' + bytes.length }).end()
    entry.status = 206
    return response.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${bytes.length}`, 'content-length': end - start + 1 }).end(bytes.subarray(start, end + 1))
  }
  entry.status = 200
  response.writeHead(200, { ...headers, 'content-length': bytes.length }).end(bytes)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = 'http://127.0.0.1:' + server.address().port
const evidence = { schemaVersion: 1, startedAt: new Date().toISOString(),
  scope: 'Isolated native HTMLAudio on this Windows desktop; exact existing AAC bytes versus generated PCM WAV, no app/player/service worker/provider code.',
  host: { platform: process.platform, arch: process.arch, node: process.version, osRelease: release() },
  fixture: { path: 'scripts/tests/e2e/fixtures/silence-12s.m4a', size: aac.length, sha256: createHash('sha256').update(aac).digest('hex'), contentType: 'audio/mp4' },
  control: { format: 'WAV PCM signed 16-bit mono', rate, seconds, size: wav.length }, engines: [], requestLog }
let browser
try {
  for (const [name, engine] of [['webkit', webkit], ['chromium', chromium]]) {
    const launch = { headless: true }
    if (name === 'chromium' && existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')) launch.executablePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
    browser = await engine.launch(launch)
    const item = { engine: name, browserVersion: browser.version(), executablePath: launch.executablePath ?? engine.executablePath(),
      profile: name === 'webkit' ? 'webkit-iphone-layout' : 'chromium-desktop', pageErrors: [], cases: [] }
    evidence.engines.push(item)
    const context = await browser.newContext(name === 'webkit' ? PROFILES['webkit-iphone-layout'].context : PROFILES['chromium-desktop'].context)
    for (const path of ['/fixture.m4a', '/control.wav']) {
      const page = await context.newPage()
      page.on('pageerror', error => item.pageErrors.push({ name: error.name, message: error.message }))
      await page.goto(origin, { waitUntil: 'load' })
      const capabilities = await page.evaluate(path => {
        const audio = new Audio(), events = []
        window.probe = { audio, events, started: false, playResolved: false, playRejection: null }
        for (const type of ['loadstart', 'loadedmetadata', 'canplay', 'playing', 'pause', 'ended', 'error', 'timeupdate']) audio.addEventListener(type, () => events.push({ type, time: audio.currentTime, readyState: audio.readyState, errorCode: audio.error?.code ?? null }))
        document.querySelector('#start').onclick = () => {
          window.probe.started = true
          audio.src = path
          audio.volume = 0.8
          audio.play().then(() => { window.probe.playResolved = true }).catch(error => { window.probe.playRejection = { name: error.name, message: error.message } })
        }
        return Object.fromEntries(['audio/mp4', 'audio/mp4; codecs="mp4a.40.2"', 'audio/x-m4a', 'audio/wav', 'audio/wav; codecs="1"'].map(type => [type, audio.canPlayType(type)]))
      }, path)
      await page.locator('#start').click()
      let waitError = null
      await page.waitForFunction(() => window.probe.audio.currentTime > 0.25 || window.probe.audio.error || window.probe.playRejection, null, { timeout: 5000 }).catch(error => { waitError = error.message })
      const result = await page.evaluate(() => {
        const { audio, ...state } = window.probe
        return { ...state, currentTime: audio.currentTime, duration: Number.isFinite(audio.duration) ? audio.duration : null,
          paused: audio.paused, readyState: audio.readyState, networkState: audio.networkState,
          error: audio.error ? { code: audio.error.code, message: audio.error.message } : null }
      })
      item.cases.push({ path, capabilities, ...result, ...(waitError ? { waitError } : {}), advanced: result.currentTime > 0.25 })
      await page.close()
    }
    await context.close(); await browser.close(); browser = null
  }
  const wk = evidence.engines.find(item => item.engine === 'webkit'), chrome = evidence.engines.find(item => item.engine === 'chromium')
  evidence.conclusion = { webkitExactAacAdvanced: wk.cases[0].advanced, webkitPcmControlAdvanced: wk.cases[1].advanced,
    chromiumExactAacAdvanced: chrome.cases[0].advanced,
    interpretation: !wk.cases[0].advanced && wk.cases[1].advanced && chrome.cases[0].advanced
      ? 'The exact AAC fixture fails in isolated Windows WebKit while PCM advances there and identical AAC bytes advance in Chromium. This demonstrates a Windows WebKit AAC capability limitation independent of product/player/import code; it does not turn the preserved full-suite failure into a pass or establish physical iPhone behavior.'
      : 'Results require assessment; do not infer a host codec limitation without the cross-format and cross-engine control.' }
} catch (error) { evidence.probeError = { name: error.name, message: error.message }; process.exitCode = 1 }
finally {
  await browser?.close().catch(() => {})
  await new Promise(resolve => server.close(resolve))
  evidence.finishedAt = new Date().toISOString()
  await writeFile(new URL('./webkit-fixture-media-capability.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n')
}
console.log(JSON.stringify({ conclusion: evidence.conclusion, probeError: evidence.probeError, cases: evidence.engines.map(item => ({ engine: item.engine,
  cases: item.cases.map(({ path, capabilities, advanced, currentTime, error, playRejection }) => ({ path, capabilities, advanced, currentTime, error, playRejection })) })) }, null, 2))
