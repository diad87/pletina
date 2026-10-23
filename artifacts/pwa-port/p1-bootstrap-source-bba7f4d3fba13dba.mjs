// Public autonomous visitor diagnostics justified by YouTube.js Session/ProtoUtils.
// No account, cookie, API key, PO token, proxy, security override or audio.
// All real anonymous visitor strings stay in Node/browser RAM; reports contain
// only hashes, lengths, protobuf field shapes and player metadata summaries.
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import puppeteer from 'puppeteer-core'
import { encodeVisitorData } from '../../node_modules/youtubei.js/dist/src/utils/ProtoUtils.js'

const args = process.argv.slice(2), option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback
const name = option('--report', 'p1-bootstrap-visitors-2026-10-23.json')
assert.match(name, /^p1-bootstrap-[a-z0-9.-]+\.json$/i)
const directory = new URL('../../artifacts/pwa-port/', import.meta.url)
await mkdir(directory, { recursive: true })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const source = await readFile(new URL(import.meta.url)), sourceHash = hash(source), snapshot = `p1-bootstrap-source-${sourceHash.slice(0, 16)}.mjs`
await writeFile(new URL(snapshot, directory), source)
const recipePath = 'artifacts/pwa-port/p1-static-recipe-c6acef753928cbe1.json', recipeBytes = await readFile(new URL('../../' + recipePath, import.meta.url)), recipe = JSON.parse(recipeBytes)
const frozenPath = 'artifacts/pwa-port/p1-web-transport-source-21491f1094d1f8fe.mjs', frozen = await readFile(new URL('../../' + frozenPath, import.meta.url), 'utf8')
assert.equal(hash(frozen), '21491f1094d1f8fe24a9cc96babb584b58fec3b95439a60a1401b3ba7e02fa38')
const paths = ['src/core/Session.js', 'src/core/Session.d.ts', 'src/utils/ProtoUtils.js', 'protos/generated/misc/params.js']
const codeSources = await Promise.all(paths.map(async path => {
  const relative = path.startsWith('protos/') ? path : 'src/' + path.slice(4)
  return { path: 'node_modules/youtubei.js/dist/' + relative, sha256: hash(await readFile(new URL('../../node_modules/youtubei.js/dist/' + relative, import.meta.url))) }
}))
const synthetic = { id: 'STATIC_TEST', timestamp: 1700000000 }
const parityHash = hash(encodeVisitorData(synthetic.id, synthetic.timestamp))
const report = { schemaVersion: 1, testedAt: new Date().toISOString(),
  execution: { scriptSha256: sourceHash, sourceSnapshot: 'artifacts/pwa-port/' + snapshot, recipeFile: recipePath, recipeSha256: hash(recipeBytes), frozenP1Helper: frozenPath, frozenP1HelperSha256: hash(frozen), codeSources },
  sources: ['https://github.com/LuanRT/YouTube.js/blob/main/src/core/Session.ts', 'https://github.com/LuanRT/YouTube.js/blob/main/src/utils/ProtoUtils.ts'],
  basis: { localGeneration: 'Session.js getSessionData uses encodeVisitorData(random 11-character identifier, current timestamp) when generating an anonymous session locally.',
    visitorEndpoint: 'Session.d.ts documents the public InnerTube /visitor_id endpoint as a source of anonymous visitor data.',
    protobuf: 'VisitorData schema fields 1 (string id) and 5 (int32 timestamp). This is an identifier, not a Proof-of-Origin/attestation token.' },
  policy: { productChanged: false, deployed: false, accountUsed: false, cookiesUsed: false, userKeysUsed: false, apiKeyUsed: false, poTokenUsed: false,
    protectedAuthenticationOrDrmAttempted: false, proxyUsed: false, browserSecurityOverrides: false, remoteJavascriptExecuted: false, mediaRequested: false,
    rawVisitorValuesPersisted: false, signedUrlsPersisted: false, observerUserGesture: false, browserGeneratedValueReturnedToNode: false },
  phases: [], transport: [], errors: [] }
const persist = () => writeFile(new URL(name, directory), JSON.stringify(report, null, 2) + '\n')
const safe = value => String(value?.message ?? value).replace(/(?:https?|blob):[^\s"'<>]+/g, '[URL]').slice(0, 250)
let browser
try {
  // Reuse only our exact frozen public-bootstrap parser/body mapping. Executing
  // this QA-owned helper is not evaluating any downloaded provider JavaScript.
  const ownBlock = frozen.slice(frozen.indexOf('const UA ='), frozen.indexOf('// The exact same QA-owned function'))
  const helperReport = { nodeBootstrap: [] }
  const configuration = new Function('assert', 'sha', 'report', 'persist', ownBlock + '\nreturn configuration;')(assert, hash, helperReport, async () => {})
  const cfg = await configuration({ title: 'Epoitaitaye', videoId: 'DJzjkMBMook', kind: 'public-reference-schema-only' })
  report.referenceBootstrap = helperReport.nodeBootstrap
  assert.equal(cfg.body.context.client.clientVersion, recipe.client.version)
  assert.equal(cfg.body.playbackContext.contentPlaybackContext.signatureTimestamp, recipe.player.signatureTimestamp)
  browser = await puppeteer.launch({ headless: true, executablePath: option('--chrome', 'C:/Users/iunan/.cache/puppeteer/chrome/win64-148.0.7778.97/chrome-win64/chrome.exe'),
    ignoreDefaultArgs: ['--mute-audio', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'], args: [], protocolTimeout: 120000 })
  report.browser = await browser.version()
  const page = await browser.newPage(), client = page.mainFrame().client, requests = new Map()
  await client.send('Network.enable')
  client.on('Network.requestWillBeSent', event => { const url = new URL(event.request.url); if (['www.youtube.com', 'music.youtube.com'].includes(url.hostname)) requests.set(event.requestId, { host: url.hostname, path: url.pathname, method: event.request.method }) })
  client.on('Network.loadingFailed', event => { const request = requests.get(event.requestId); if (request) report.transport.push({ ...request, failure: safe(event.errorText), cors: event.corsErrorStatus ?? null }) })
  await page.goto('https://diad87.github.io/pletina/', { waitUntil: 'domcontentloaded', timeout: 30000 })
  const call = async (fn, value) => {
    const context = page.mainFrame().mainRealm().context
    const reply = await client.send('Runtime.callFunctionOn', { executionContextId: context.id, functionDeclaration: fn.toString(), arguments: [{ value }], awaitPromise: true, returnByValue: true, userGesture: false })
    if (reply.exceptionDetails) throw Error(safe(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text))
    return reply.result.value
  }
  async function runtime() {
    const state = { visitors: new Map(), recipe: null, full: null }, hash = async input => [...new Uint8Array(await crypto.subtle.digest('SHA-256', typeof input === 'string' ? new TextEncoder().encode(input) : input))].map(byte => byte.toString(16).padStart(2, '0')).join('')
    const varint = value => { const out = []; do { const byte = value % 128; value = Math.floor(value / 128); out.push(byte | (value ? 128 : 0)) } while (value); return out }
    const encode = (id, timestamp) => encodeURIComponent(btoa(String.fromCharCode(...new Uint8Array([10, id.length, ...new TextEncoder().encode(id), 40, ...varint(timestamp)]))).replace(/\+/g, '-').replace(/\//g, '_'))
    const shape = async value => {
      if (typeof value !== 'string' || value.length > 4096) return { present: false }
      try {
        const decoded = Uint8Array.from(atob(decodeURIComponent(value).replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0)), fields = []
        let at = 0
        const read = () => { let n = 0, scale = 1, count = 0, byte; do { if (at >= decoded.length || count++ > 9) throw Error('varint'); byte = decoded[at++]; n += (byte & 127) * scale; scale *= 128 } while (byte & 128); return { n, bytes: count } }
        while (at < decoded.length) {
          const tag = read().n, field = Math.floor(tag / 8), wire = tag % 8
          if (!field) throw Error('tag')
          if (wire === 0) fields.push({ field, name: field === 5 ? 'timestamp' : 'unknown', wire: 'varint', encodedBytes: read().bytes })
          else if (wire === 2) { const length = read().n; if (length > decoded.length - at) throw Error('length'); const bytes = decoded.subarray(at, at + length); fields.push({ field, name: field === 1 ? 'id' : 'unknown', wire: 'length-delimited', bytes: length, ascii: [...bytes].every(byte => byte >= 32 && byte <= 126) }); at += length }
          else if (wire === 1 || wire === 5) { const bytes = wire === 1 ? 8 : 4; fields.push({ field, name: 'unknown', wire: 'fixed', bytes }); at += bytes }
          else throw Error('wire')
        }
        return { present: true, textBytes: value.length, binaryBytes: decoded.length, sha256: await hash(value), fields }
      } catch { return { present: true, textBytes: value.length, sha256: await hash(value), parseableAsVisitorProtobuf: false } }
    }
    async function request(host, endpoint, body) {
      const response = await fetch('https://' + host + '/youtubei/v1/' + endpoint + '?prettyPrint=false', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, credentials: 'omit', referrerPolicy: 'no-referrer', body: JSON.stringify(body), signal: AbortSignal.timeout(12000) })
      if (!response.body) return { summary: { status: response.status, readable: true, empty: true }, value: null }
      const reader = response.body.getReader(), chunks = []; let count = 0
      try { while (true) { const part = await reader.read(); if (part.done) break; count += part.value.byteLength; if (count > 2 * 1024 * 1024) throw Error('body-budget'); chunks.push(part.value) } }
      catch (error) { await reader.cancel().catch(() => {}); throw error } finally { reader.releaseLock() }
      const bytes = new Uint8Array(count); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length }
      let value; try { value = JSON.parse(new TextDecoder().decode(bytes).replace(/^\)\]\}'\s*/, '')) } catch { value = null }
      return { summary: { status: response.status, readable: true, responseBytes: count, responseSha256: await hash(bytes), apiErrorCode: value?.error?.code ?? null }, value }
    }
    function minimal(id, visitor) {
      return { videoId: id, context: { client: { clientName: state.recipe.client.name, clientVersion: state.recipe.client.version, hl: 'en', userAgent: state.full.context.client.userAgent,
        ...(visitor ? { visitorData: visitor } : {}) }, thirdParty: { embedUrl: 'https://www.reddit.com/' } }, contentCheckOk: true, racyCheckOk: true,
        playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS', signatureTimestamp: state.recipe.player.signatureTimestamp } } }
    }
    const actions = {
      async init(input) {
        state.recipe = input.recipe; state.full = input.full
        state.visitors.set('node-reference', input.full.context.client.visitorData)
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_', random = crypto.getRandomValues(new Uint8Array(11)), id = [...random].map(byte => alphabet[byte & 63]).join('')
        state.visitors.set('local-generated', encode(id, Math.floor(Date.now() / 1000)))
        return { nodeReference: await shape(state.visitors.get('node-reference')), locallyGenerated: await shape(state.visitors.get('local-generated')),
          encoderMatchesLibrarySyntheticVector: await hash(encode(input.synthetic.id, input.synthetic.timestamp)) === input.parityHash }
      },
      async player(input) {
        const visitor = state.visitors.get(input.visitor)
        if (!visitor) return { skipped: true, reason: 'Visitor source did not produce a value' }
        const body = input.full ? structuredClone(state.full) : minimal(input.videoId, visitor)
        body.videoId = input.videoId; body.context.client.visitorData = visitor
        const { summary, value } = await request('www.youtube.com', 'player', body), stream = value?.streamingData ?? {}, audio = (stream.adaptiveFormats ?? []).filter(item => /^audio\//.test(item.mimeType ?? ''))
        return { ...summary, exactVideoId: value?.videoDetails?.videoId === input.videoId, playability: value?.playabilityStatus?.status ?? null,
          reason: String(value?.playabilityStatus?.reason ?? '').slice(0, 180), playableInEmbed: value?.playabilityStatus?.playableInEmbed ?? null, sabrPresent: typeof stream.serverAbrStreamingUrl === 'string',
          formats: audio.map(item => ({ itag: item.itag, mime: item.mimeType, cipher: typeof item.signatureCipher === 'string' || typeof item.cipher === 'string', direct: typeof item.url === 'string', drc: item.isDrc === true, drm: !!(item.drmFamilies?.length || item.drmTrackType) })) }
      },
      async search(input) {
        const body = { context: { client: { clientName: input.clientName, clientVersion: input.version } }, query: 'music' }
        const { summary, value } = await request(input.host, 'search', body), visitor = value?.responseContext?.visitorData
        if (typeof visitor === 'string' && visitor.length <= 4096) state.visitors.set(input.label, visitor)
        return { ...summary, contextPresent: !!value?.responseContext, visitor: await shape(visitor), contentsPresent: !!value?.contents }
      },
      async visitor(input) {
        const body = { context: { client: { clientName: input.clientName, clientVersion: input.version, hl: 'en' } } }
        const { summary, value } = await request('www.youtube.com', 'visitor_id', body)
        const visitor = value?.responseContext?.visitorData ?? value?.visitorData
        if (typeof visitor === 'string' && visitor.length <= 4096) state.visitors.set(input.label, visitor)
        return { ...summary, topLevelKeys: value && typeof value === 'object' ? Object.keys(value).slice(0, 25) : [], contextPresent: !!value?.responseContext, visitor: await shape(visitor) }
      },
    }
    addEventListener('message', async event => {
      if (event.source !== parent || event.data?.type !== 'p1-bootstrap-command') return
      const { id, action, input } = event.data
      try { parent.postMessage({ type: 'p1-bootstrap-result', id, result: await actions[action](input) }, '*') }
      catch (error) { parent.postMessage({ type: 'p1-bootstrap-result', id, result: { error: error.name, message: String(error.message).replace(/https?:[^\s]+/g, '[URL]').slice(0, 180) } }, '*') }
    })
    parent.postMessage({ type: 'p1-bootstrap-ready' }, '*')
  }
  await call(async source => new Promise(resolve => {
    const frame = document.createElement('iframe'); frame.id = 'p1-bootstrap-runtime'; frame.sandbox = 'allow-scripts'; frame.hidden = true
    const timer = setTimeout(() => { removeEventListener('message', receive); resolve(false) }, 5000)
    const receive = event => { if (event.source === frame.contentWindow && event.origin === 'null' && event.data?.type === 'p1-bootstrap-ready') { clearTimeout(timer); removeEventListener('message', receive); resolve(true) } }
    addEventListener('message', receive); frame.srcdoc = '<script>(' + source + ')()<' + '/script>'; document.body.append(frame)
  }), runtime.toString())
  async function run(phase, action, input) {
    const result = await call(async ({ action, input }) => new Promise(resolve => {
      const frame = document.querySelector('#p1-bootstrap-runtime'), id = crypto.randomUUID(), timer = setTimeout(() => { removeEventListener('message', receive); resolve({ error: 'command-deadline' }) }, 15000)
      const receive = event => { if (event.source === frame.contentWindow && event.origin === 'null' && event.data?.type === 'p1-bootstrap-result' && event.data.id === id) { clearTimeout(timer); removeEventListener('message', receive); resolve(event.data.result) } }
      addEventListener('message', receive); frame.contentWindow.postMessage({ type: 'p1-bootstrap-command', id, action, input }, '*')
    }), { action, input })
    report.phases.push({ phase, action, ...(action === 'player' ? { videoId: input.videoId, visitorSource: input.visitor, includesBuildPublicContextExtras: !!input.full } : {}), result })
    await persist(); console.log(JSON.stringify({ phase, result })); return result
  }
  const initialized = await run('anonymous-identifier-schema-controls', 'init', { recipe: { client: recipe.client, player: recipe.player }, full: cfg.body, synthetic, parityHash })
  assert.equal(initialized.encoderMatchesLibrarySyntheticVector, true)
  const success = result => result.exactVideoId && result.playability === 'OK' && result.formats?.some(item => item.cipher && !item.drc && !item.drm)
  const first = await run('browser-generated-visitor-minimal-player', 'player', { videoId: 'DJzjkMBMook', visitor: 'local-generated' })
  if (success(first)) {
    for (const videoId of ['fV-IUsecSsU', 'WtTRMAoN2Fw', '___________']) await run('browser-generated-visitor-corpus', 'player', { videoId, visitor: 'local-generated' })
  } else {
    await run('browser-generated-visitor-full-public-context-diagnostic', 'player', { videoId: 'DJzjkMBMook', visitor: 'local-generated', full: true })
    for (const clientName of ['WEB_EMBEDDED_PLAYER', 'WEB']) {
      const label = 'visitor-endpoint-' + clientName
      const value = await run(label, 'visitor', { clientName, version: clientName === 'WEB' ? '2.20261007.00.00' : recipe.client.version, label })
      if (value.visitor?.present) await run(label + '-minimal-player', 'player', { videoId: 'DJzjkMBMook', visitor: label })
    }
  }
  await run('schema-music-reference-only', 'search', { host: 'music.youtube.com', clientName: 'WEB_REMIX', version: '1.20260901.01.00', label: 'music-schema' })
  await run('schema-web-reference-only', 'search', { host: 'www.youtube.com', clientName: 'WEB', version: '2.20261007.00.00', label: 'web-schema' })
  if (!success(first)) await run('contemporary-node-visitor-reference-positive-not-a-product-path', 'player', { videoId: 'DJzjkMBMook', visitor: 'node-reference', full: true })
} catch (error) { report.errors.push(safe(error)) }
finally { await browser?.close() }
report.summary = { autonomousMinimalCipher: report.phases.filter(phase => phase.action === 'player' && phase.visitorSource !== 'node-reference' && !phase.includesBuildPublicContextExtras && phase.result.exactVideoId && phase.result.playability === 'OK' && phase.result.formats?.some(format => format.cipher && !format.drm && !format.drc)).map(phase => ({ phase: phase.phase, videoId: phase.videoId, visitorSource: phase.visitorSource })),
  completeAudioOrPlaybackClaimed: false, rawValuesWritten: false, browsersClosed: true }
await persist()
console.log(JSON.stringify({ report: name, summary: report.summary, errors: report.errors }, null, 2))
if (report.errors.length) process.exitCode = 1
