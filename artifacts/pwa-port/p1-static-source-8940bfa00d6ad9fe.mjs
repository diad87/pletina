// QA build-time prototype only. Public embed/player text stays in RAM. No player
// POST, media request, full-player execution, credentials, product import or deploy.
// Run: node scripts/tests/p1-static-decoder-prototype.mjs --bootstrap-video <id>
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import vm from 'node:vm'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { JsAnalyzer } from '../../node_modules/youtubei.js/dist/src/utils/javascript/JsAnalyzer.js'
import { JsExtractor } from '../../node_modules/youtubei.js/dist/src/utils/javascript/JsExtractor.js'
import { nsigMatcher, timestampMatcher } from '../../node_modules/youtubei.js/dist/src/utils/javascript/matchers.js'

const OFFICIAL_COMMIT = '9892b9c4968e7b57a239f3b5bdcb45e74852c848'
const MAX_TEXT = 5 * 1024 * 1024, MAX_SCRIPT = 2 * 1024 * 1024
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.5 Safari/605.1.15,gzip(gfe)'
const sha256 = value => createHash('sha256').update(value).digest('hex')
const root = new URL('../../', import.meta.url), directory = new URL('artifacts/pwa-port/', root)
const validPublicUrl = value => {
  const url = new URL(value)
  assert.equal(url.origin, 'https://www.youtube.com', 'PUBLIC_ORIGIN')
  assert.equal(url.username + url.password + url.hash, '', 'PUBLIC_URL_COMPONENTS')
  return url
}

async function publicText(value) {
  const url = validPublicUrl(value)
  const signal = AbortSignal.timeout(15000)
  const response = await fetch(url, { signal, redirect: 'error', credentials: 'omit', headers: {
    'User-Agent': UA, Referer: 'https://www.reddit.com/', 'Accept-Language': 'en-US,en;q=0.9',
  } })
  if (!response.ok || !response.body) { await response.body?.cancel(); throw Error('PUBLIC_HTTP') }
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_TEXT)) { await response.body.cancel(); throw Error('PUBLIC_SIZE') }
  const reader = response.body.getReader(), chunks = []
  let count = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      count += part.value.byteLength
      if (count > MAX_TEXT) throw Error('PUBLIC_SIZE')
      chunks.push(part.value)
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error }
  finally { reader.releaseLock() }
  const bytes = Buffer.concat(chunks)
  return { text: bytes.toString('utf8'), bytes: count, sha256: sha256(bytes) }
}

function jsonAfter(source, marker) {
  const values = []
  let position = 0
  while ((position = source.indexOf(marker, position)) !== -1) {
    position += marker.length
    while (/\s/.test(source[position] ?? '')) position++
    assert.ok(source[position] === '{' && values.length < 64, 'PUBLIC_JSON_MARKER')
    const start = position
    let depth = 0, quoted = false, escaped = false
    for (; position < source.length; position++) {
      const char = source[position]
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue }
      if (char === '"') quoted = true
      else if (char === '{') depth++
      else if (char === '}' && --depth === 0) { position++; break }
    }
    assert.equal(depth, 0, 'PUBLIC_JSON_TRUNCATED')
    values.push(JSON.parse(source.slice(start, position)))
  }
  return values
}

async function bootstrap(videoId) {
  assert.match(videoId, /^[A-Za-z0-9_-]{11}$/, 'BOOTSTRAP_ID_REQUIRED')
  const html = await publicText(`https://www.youtube.com/embed/${videoId}?html5=1`)
  // The visitor/flags/experiments in this HTML are deliberately never selected
  // into the reusable recipe. Only stable public client/player descriptors leave.
  const selected = {}, allow = ['INNERTUBE_CLIENT_NAME', 'INNERTUBE_CLIENT_VERSION', 'INNERTUBE_CONTEXT_CLIENT_NAME', 'WEB_PLAYER_CONTEXT_CONFIGS']
  for (const object of jsonAfter(html.text, 'ytcfg.set(')) for (const key of allow) if (Object.hasOwn(object, key)) {
    if (Object.hasOwn(selected, key)) assert.equal(JSON.stringify(selected[key]), JSON.stringify(object[key]), 'CONFIG_AMBIGUOUS')
    selected[key] = object[key]
  }
  assert.equal(selected.INNERTUBE_CLIENT_NAME, 'WEB_EMBEDDED_PLAYER', 'CONFIG_CLIENT')
  assert.equal(selected.INNERTUBE_CONTEXT_CLIENT_NAME, 56, 'CONFIG_CLIENT_ID')
  assert.match(selected.INNERTUBE_CLIENT_VERSION, /^\d+(?:\.\d+)+$/, 'CONFIG_VERSION')
  const config = selected.WEB_PLAYER_CONTEXT_CONFIGS?.WEB_PLAYER_CONTEXT_CONFIG_ID_EMBEDDED_PLAYER
  assert.equal(typeof config?.jsUrl, 'string', 'CONFIG_PLAYER')
  const player = validPublicUrl(new URL(config.jsUrl, 'https://www.youtube.com/'))
  assert.match(player.pathname, /^\/s\/player\/[A-Za-z0-9]{8,32}\/player_[A-Za-z0-9_-]+\.vflset\/[A-Za-z_]+\/base\.js$/, 'CONFIG_PLAYER_PATH')
  assert.equal(player.search, '', 'CONFIG_PLAYER_QUERY')
  const source = await publicText(player.href)
  return { client: { name: selected.INNERTUBE_CLIENT_NAME, id: 56, version: selected.INNERTUBE_CLIENT_VERSION },
    player: { path: player.pathname, sha256: source.sha256, bytes: source.bytes }, source: source.text,
    bootstrapEvidence: { bytes: html.bytes, sha256: html.sha256, method: 'Anonymous public embed GET at build time; seed video ID not persisted' } }
}

export function prepareStaticDecoder(source) {
  assert.ok(typeof source === 'string' && source.length > 0 && Buffer.byteLength(source) <= MAX_TEXT, 'DECODER_SOURCE_SIZE')
  const analyzer = new JsAnalyzer(source, { extractions: [
    { friendlyName: 'nsigFunction', match: nsigMatcher },
    { friendlyName: 'signatureTimestampVar', match: timestampMatcher, collectDependencies: false },
  ] })
  const result = new JsExtractor(analyzer).buildScript({ disallowSideEffectInitializers: true, exportRawValues: true, rawValueOnly: ['signatureTimestampVar'] })
  const timestamp = result.exportedRawValues?.signatureTimestampVar
  assert.ok(typeof timestamp === 'string' && /^\d+$/.test(timestamp), 'DECODER_TIMESTAMP')
  const signatureTimestamp = Number(timestamp)
  assert.ok(Number.isSafeInteger(signatureTimestamp) && signatureTimestamp > 0 && result.exported.includes('nsigFunction'), 'DECODER_EXPORT')
  assert.ok(result.output.length > 0 && Buffer.byteLength(result.output) <= MAX_SCRIPT, 'DECODER_SCRIPT_SIZE')
  return { script: result.output, signatureTimestamp }
}

// Same argument-only processor as P1 18.1.0, independent of its AST bundle.
// This dummy URL is synthetic input, is never fetched and is not a media source.
function processValues(exportedVars, sig, n) {
  const url = exportedVars.nsigFunction('https://ytjs.googlevideo.com/videoplayback?expire=1234567890&n=' + encodeURIComponent(n || ''), 'sig', sig || '')
  for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(url))) {
    if (!['constructor', 'clone', 'set', 'get'].includes(name) && typeof url[name] === 'function') url[name]()
  }
  const result = {}
  if (sig != null) { const value = url.get('sig'); result.sig = typeof value === 'string' && value ? decodeURIComponent(value) : undefined }
  if (n != null) { const value = url.get('n'); result.n = typeof value === 'string' && value ? decodeURIComponent(value) : undefined }
  return result
}

const harden = `
  for (const fn of [function(){}, async function(){}, function*(){}, async function*(){}]) {
    Object.defineProperty(Object.getPrototypeOf(fn), 'constructor', { value: undefined, writable: false, configurable: false });
  }
  for (const name of ['eval','Function','SharedArrayBuffer','Atomics','WebAssembly']) {
    Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false });
  }
`
function contextForP1(bundle) {
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: true, wasm: false } })
  vm.runInContext(bundle, context, { timeout: 3000 })
  vm.runInContext('globalThis.__api = __musifyYouTubeDecoder; delete globalThis.__musifyYouTubeDecoder;' + harden, context, { timeout: 1000 })
  return context
}
function staticRuntime(prepared) {
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } })
  vm.runInContext(harden, context, { timeout: 1000 })
  // Executes the extracted dependencies only. The full player source is never
  // passed to runInContext, eval, Function or the decoder runtime.
  vm.runInContext(`"use strict";\n${prepared.script}\nglobalThis.__decode = ${processValues.toString()};`, context, { timeout: 1000 })
  return context
}
function callDecoder(context, method, args) {
  context.__args = args
  try {
    const result = vm.runInContext(method, context, { timeout: 1000 })
    const out = JSON.parse(JSON.stringify(result))
    for (const [field, input] of [['sig', args[0]], ['n', args[1]]]) {
      if (input == null) continue
      const value = out[field]
      if (typeof value !== 'string' || !value.length || value.length > 4096 || value.startsWith('enhanced_except_') || field === 'n' && value === input) return { status: 'rejected' }
    }
    return { status: 'decoded', output: out }
  } catch { return { status: 'rejected' } }
  finally { delete context.__args }
}

async function moduleComparison(official) {
  const modules = ['JsAnalyzer.js', 'JsExtractor.js', 'matchers.js', 'helpers.js']
  return Promise.all(modules.map(async name => {
    const installed = await readFile(new URL('node_modules/youtubei.js/dist/src/utils/javascript/' + name, root))
    const baseline = await readFile(path.join(official, 'node_modules/youtubei.js/dist/src/utils/javascript', name))
    return { name, baselineSha256: sha256(baseline), installedSha256: sha256(installed), identical: installed.equals(baseline) }
  }))
}

export async function buildStaticRecipe({ bootstrapVideoId, official = 'C:/Users/iunan/musify-oficial' }) {
  const installed = JSON.parse(await readFile(new URL('node_modules/youtubei.js/package.json', root), 'utf8'))
  const baseline = JSON.parse(await readFile(path.join(official, 'node_modules/youtubei.js/package.json'), 'utf8'))
  assert.equal(installed.version, '18.2.0', 'INSTALLED_VERSION')
  assert.equal(baseline.version, '18.1.0', 'BASELINE_VERSION')
  const bundle = execFileSync('git', ['show', `${OFFICIAL_COMMIT}:src-tauri/src/youtube-decoder.bundle.js`], { cwd: official, maxBuffer: 4 * 1024 * 1024 })
  const discovered = await bootstrap(bootstrapVideoId)
  const started = performance.now(), prepared = prepareStaticDecoder(discovered.source), prepareMs = performance.now() - started
  assert.ok(!prepared.script.includes(bootstrapVideoId), 'SONG_ID_IN_STATIC_SCRIPT')
  const oldContext = contextForP1(bundle.toString('utf8'))
  oldContext.__source = discovered.source
  const oldStarted = performance.now()
  const previous = vm.runInContext('__api.prepare(__source)', oldContext, { timeout: 15000 })
  const previousPrepareMs = performance.now() - oldStarted
  delete oldContext.__source
  assert.equal(previous.signatureTimestamp, prepared.signatureTimestamp, 'TIMESTAMP_CHANGED')
  const runtime = staticRuntime(prepared)
  const syntheticSig = '0123456789abcdef0123456789abcdef01234567.89abcdef0123456789abcdef0123456789abcdef01'
  const vectors = [
    { name: 'sig-and-n', sig: syntheticSig, n: 'QAStaticProbe0123456789abcdef' },
    { name: 'signature-only', sig: syntheticSig },
    { name: 'n-only', n: 'AnotherQAStaticNValue_0123456789' },
    { name: 'quoted-values', sig: '"\\);globalThis.injection=true;//' + syntheticSig, n: 'QA_quote"slash\\andpercent%20' },
  ]
  const checks = []
  for (const vector of vectors) {
    const newer = callDecoder(runtime, '__decode(exportedVars, ...__args)', [vector.sig ?? null, vector.n ?? null])
    oldContext.__script = previous.script
    const older = callDecoder(oldContext, '__api.decode(__script, ...__args)', [vector.sig ?? null, vector.n ?? null])
    delete oldContext.__script
    assert.deepEqual(newer, older, 'PURE_DECODER_VERSION_MISMATCH')
    assert.notEqual(runtime.injection, true, 'INPUT_EXECUTED')
    checks.push({ name: vector.name, pass: true, outcome: newer.status,
      sigInputLength: vector.sig?.length ?? null, nInputLength: vector.n?.length ?? null,
      outputSha256: newer.output ? sha256(JSON.stringify(newer.output)) : null,
      outputLengths: newer.output ? Object.fromEntries(Object.entries(newer.output).map(([key, value]) => [key, value.length])) : null })
  }
  assert.ok(checks.some(check => check.outcome === 'decoded'), 'NO_SUCCESSFUL_SYNTHETIC_VECTOR')
  const createdAt = new Date().toISOString()
  const recipe = { schemaVersion: 1, createdAt,
    // Proposed local freshness policy, NOT a server-guaranteed lifetime.
    expiresAt: new Date(Date.parse(createdAt) + 6 * 3600_000).toISOString(), expiryMeaning: 'Conservative local policy only; upstream may change earlier',
    client: discovered.client, player: { ...discovered.player, signatureTimestamp: prepared.signatureTimestamp },
    decoder: { script: prepared.script, sha256: sha256(prepared.script), bytes: Buffer.byteLength(prepared.script), libraryVersion: installed.version, exportName: 'nsigFunction' },
    omittedRuntimeContext: ['videoId', 'visitorData', 'encryptedHostFlags', 'deviceExperimentId', 'rolloutToken', 'appInstallData'],
    runtimeStatus: 'Decoder material only. Generic player context, eligibility, CDN access and playback remain separate gates.' }
  return { recipe, evidence: { bootstrap: discovered.bootstrapEvidence,
    baseline: { commit: OFFICIAL_COMMIT, libraryVersion: baseline.version, bundleSha256: sha256(bundle), prepareMs: previousPrepareMs,
      preparedScriptSha256: sha256(previous.script), preparedScriptBytes: Buffer.byteLength(previous.script) },
    installed: { libraryVersion: installed.version, prepareMs, preparedScriptSha256: recipe.decoder.sha256, preparedScriptBytes: recipe.decoder.bytes },
    moduleComparison: await moduleComparison(official), preparedScriptsIdentical: previous.script === prepared.script,
    checks, comparisonScope: 'Synthetic s/n values in isolated Node V8 contexts; no real URL signature validity, media, native QuickJS or browser-worker assertion.' } }
}

async function main() {
  const args = process.argv.slice(2), option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback
  const bootstrapVideoId = option('--bootstrap-video'), official = option('--official', 'C:/Users/iunan/musify-oficial')
  assert.ok(typeof bootstrapVideoId === 'string', 'Use --bootstrap-video with one public 11-character ID')
  const reportName = option('--report', 'p1-static-decoder-prototype-2026-10-23.json')
  assert.match(reportName, /^p1-static-[a-z0-9.-]+\.json$/i)
  await mkdir(directory, { recursive: true })
  const source = await readFile(new URL(import.meta.url)), sourceSha256 = sha256(source), snapshot = `p1-static-source-${sourceSha256.slice(0, 16)}.mjs`
  await writeFile(new URL(snapshot, directory), source)
  const report = { schemaVersion: 1, testedAt: new Date().toISOString(), execution: { scriptSha256: sourceSha256, snapshot: 'artifacts/pwa-port/' + snapshot },
    policy: { productChanged: false, deployed: false, privateLocalFixturesUsed: false, accountsKeysCookiesOrProxy: false,
      playerPostRequested: false, mediaRequested: false, fullPlayerExecuted: false, bootstrapValuesPersisted: false,
      signedUrlsPersisted: false, musicalVideoIdInRecipe: false, browserWorkerImplemented: false }, checks: [], errors: [] }
  try {
    const { recipe, evidence } = await buildStaticRecipe({ bootstrapVideoId, official })
    const scriptName = `p1-static-functions-${recipe.decoder.sha256.slice(0, 16)}.js`
    await writeFile(new URL(scriptName, directory), recipe.decoder.script)
    const { script: _script, ...decoderMetadata } = recipe.decoder
    const persistedRecipe = { ...recipe, decoder: { ...decoderMetadata, source: 'artifacts/pwa-port/' + scriptName } }
    const recipeName = `p1-static-recipe-${recipe.player.sha256.slice(0, 16)}.json`
    await writeFile(new URL(recipeName, directory), JSON.stringify(persistedRecipe, null, 2) + '\n')
    Object.assign(report, { recipe: persistedRecipe, recipeFile: 'artifacts/pwa-port/' + recipeName, evidence, checks: evidence.checks,
      limitations: ['Only extracted functions execute; the complete public player is analyzed as text.',
        'Node vm is a QA comparison context, not a browser sandbox or an OS security boundary.',
        'The candidate browser design is a dedicated worker in an opaque sandbox iframe with connect-src none, worker-src blob and external termination; it has not been implemented or tested here.',
        'An opaque iframe alone does not remove worker network/import APIs. Worker CSP, input/output protocol and blocking imports/network require independent validation.',
        'Browser workers offer termination but no equivalent hard 32 MiB per-runtime memory cap; build-time extraction avoids mobile AST preparation.',
        'Static functions do not establish reusable flags/visitor/experiments, made-for-kids eligibility, CDN access, playback or background behavior.'] })
  } catch (error) {
    report.errors.push({ name: error?.name ?? 'Error', code: /^[A-Z][A-Z0-9_ ]{1,100}$/.test(error?.message ?? '') ? error.message : 'QA_STEP_FAILED' })
    process.exitCode = 1
  }
  await writeFile(new URL(reportName, directory), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ report: 'artifacts/pwa-port/' + reportName, pass: !report.errors.length, checks: report.checks.length,
    scriptBytes: report.recipe?.decoder.bytes ?? null, scriptsIdentical: report.evidence?.preparedScriptsIdentical ?? null, errors: report.errors }))
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main()
