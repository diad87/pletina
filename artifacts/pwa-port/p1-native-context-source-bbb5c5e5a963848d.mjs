// Research only: compare anonymous Native request fields with ordinary browser
// requests. Per-video Node bootstrap is a labelled control, not a PWA backend.
// No raw configuration, visitor, signed locator or media body is written.
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import puppeteer from 'puppeteer-core'

const sha = value => createHash('sha256').update(value).digest('hex')
const directory = new URL('../../artifacts/pwa-port/', import.meta.url)
const source = await readFile(new URL(import.meta.url)), report = {
  schemaVersion: 1, testedAt: new Date().toISOString(), videoId: 'NGp3dh-hBe8',
  scope: 'Real anonymous request-shape comparison; Node per-video context is research control only. No audio playback claim.',
  policy: { runtimeBackend: false, accounts: false, cookies: false, browserSecurityOverrides: false,
    rawConfigurationPersisted: false, signedUrlsPersisted: false, mediaRequested: false, productChanged: false },
  sourceSha256: sha(source), contexts: [], results: [], errors: [],
}
const frozen = await readFile(new URL('p1-web-transport-source-21491f1094d1f8fe.mjs', directory), 'utf8')
assert.equal(sha(frozen), '21491f1094d1f8fe24a9cc96babb584b58fec3b95439a60a1401b3ba7e02fa38')
const begin = frozen.indexOf('const UA ='), end = frozen.indexOf('// The exact same QA-owned function')
assert.ok(begin > 0 && end > begin)
const configuration = new Function('assert', 'sha', 'report', 'persist', frozen.slice(begin, end) + '\nreturn configuration;')(
  assert, sha, { nodeBootstrap: report.contexts }, async () => {})
const perVideo = await configuration({ videoId: report.videoId, title: 'Ni, Ni, Ni!', kind: 'research-per-video-control' })
const recipeSource = await readFile(new URL('../../web-port/p1-recipe.generated.ts', import.meta.url), 'utf8')
const moduleCode = ts.transpileModule(recipeSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
const recipeModule = {}; new Function('exports', moduleCode)(recipeModule)
const recipe = recipeModule.p1Recipe
const neutral = { videoId: report.videoId, context: recipe.context, playbackContext: recipe.playbackContext, contentCheckOk: true, racyCheckOk: true }
const anotherNeutral = await configuration({ videoId: 'M7lc1UVf-VE', title: 'Neutral IFrame API example', kind: 'second-neutral-control' })
anotherNeutral.body.videoId = report.videoId
const otherPublic = await configuration({ videoId: 'jNQXAC9IVRw', title: 'Neutral non-musical public video', kind: 'other-neutral-control' })
otherPublic.body.videoId = report.videoId
const flagsOnly = structuredClone(neutral)
flagsOnly.playbackContext.contentPlaybackContext.encryptedHostFlags = perVideo.body.playbackContext.contentPlaybackContext.encryptedHostFlags
const visitorOnly = structuredClone(neutral)
visitorOnly.context.client.visitorData = perVideo.body.context.client.visitorData
report.neutral = { preparedAt: recipe.createdAt, playerSHA: recipe.playerSHA, contextSHA: sha(JSON.stringify(neutral)) }
let browser
try {
  browser = await puppeteer.launch({ headless: true, executablePath: 'C:/Users/iunan/.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe', args: [] })
  const context = await browser.createBrowserContext(); assert.equal((await context.cookies()).length, 0)
  const page = await context.newPage(); await page.goto('https://diad87.github.io/pletina/', { waitUntil: 'domcontentloaded' })
  const inspect = async function (bodies) {
    return await new Promise(resolve => {
      const frame = document.createElement('iframe'), id = crypto.randomUUID(); frame.hidden = true; frame.sandbox = 'allow-scripts'
      const finish = result => { clearTimeout(timer); removeEventListener('message', receive); frame.remove(); resolve(result) }
      const receive = event => { if (event.source === frame.contentWindow && event.origin === 'null' && event.data?.id === id) finish(event.data.results) }
      const timer = setTimeout(() => finish([{ error: 'deadline' }]), 90000)
      const run = async ({ id, bodies }) => {
        const results = [], summary = (value, requested) => {
          const stream = value.streamingData ?? {}, audio = (stream.adaptiveFormats ?? []).filter(f => /^audio\//.test(f.mimeType ?? ''))
          return { status: value.playabilityStatus?.status ?? null, exactId: value.videoDetails?.videoId === requested,
            sabr: typeof stream.serverAbrStreamingUrl === 'string', formats: audio.map(f => ({ itag: f.itag, mime: f.mimeType,
              url: typeof f.url === 'string', cipher: typeof f.signatureCipher === 'string' || typeof f.cipher === 'string' })) }
        }
        for (const [label, body] of Object.entries(bodies)) for (const headersMode of ['plain']) {
          try {
            const headers = { 'Content-Type': headersMode === 'plain' ? 'text/plain' : 'application/json' }
            if (headersMode !== 'plain') Object.assign(headers, { 'X-Youtube-Client-Name': '56', 'X-Youtube-Client-Version': body.context.client.clientVersion, 'X-Goog-Visitor-Id': body.context.client.visitorData })
            const response = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', { method: 'POST', credentials: 'omit', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(12000) })
            const text = await response.text(); if (text.length > 4 * 1024 * 1024) throw Error('size')
            results.push({ label, headersMode, http: response.status, ...summary(JSON.parse(text), body.videoId) })
          } catch (error) { results.push({ label, headersMode, error: error.name }) }
        }
        parent.postMessage({ id, results }, '*')
      }
      addEventListener('message', receive)
      frame.srcdoc = '<script>(' + run.toString() + ')(' + JSON.stringify({ id, bodies }).replaceAll('<', '\\u003c') + ')<' + '/script>'
      document.body.append(frame)
    })
  }
  const response = await page.mainFrame().client.send('Runtime.callFunctionOn', {
    executionContextId: page.mainFrame().mainRealm().context.id, functionDeclaration: inspect.toString(),
    arguments: [{ value: { neutral, perVideo: perVideo.body, anotherNeutral: anotherNeutral.body, otherPublic: otherPublic.body, flagsOnly, visitorOnly } }], userGesture: false, awaitPromise: true, returnByValue: true,
  })
  assert.ok(!response.exceptionDetails); report.results = response.result.value
} catch (error) { report.errors.push(error.name) }
finally { await browser?.close(); report.resourcesClosed = true }
await mkdir(directory, { recursive: true })
report.sourceSnapshot = `artifacts/pwa-port/p1-native-context-source-${sha(source).slice(0, 16)}.mjs`
await writeFile(new URL(report.sourceSnapshot.replace('artifacts/pwa-port/', ''), directory), source)
await writeFile(new URL('p1-native-context-compare-fields-2026-10-24.json', directory), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ results: report.results, errors: report.errors }))
if (report.errors.length) process.exitCode = 1
