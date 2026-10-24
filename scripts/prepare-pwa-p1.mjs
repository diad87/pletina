// Build-time only. One neutral, public anonymous embed context and extracted
// functions become static app data; phones request their own media directly.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import { JsAnalyzer } from '../node_modules/youtubei.js/dist/src/utils/javascript/JsAnalyzer.js'
import { JsExtractor } from '../node_modules/youtubei.js/dist/src/utils/javascript/JsExtractor.js'
import { nsigMatcher, timestampMatcher } from '../node_modules/youtubei.js/dist/src/utils/javascript/matchers.js'

const root = fileURLToPath(new URL('../', import.meta.url)), sha = value => crypto.createHash('sha256').update(value).digest('hex')
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.5 Safari/605.1.15,gzip(gfe)'
const NEUTRAL_PUBLIC_EMBED = 'https://www.youtube.com/embed/M7lc1UVf-VE?html5=1'
async function publicText(url, maximum) {
  const address = new URL(url)
  assert.equal(address.origin, 'https://www.youtube.com'); assert.equal(address.username + address.password + address.hash, '')
  assert.ok(address.pathname.startsWith('/embed/') || /^\/s\/player\/[A-Za-z0-9_-]+\/player_[A-Za-z0-9_-]+\.vflset\/[A-Za-z_]+\/base\.js$/.test(address.pathname))
  const response = await fetch(address, { credentials: 'omit', redirect: 'error', headers: { 'User-Agent': UA, Referer: 'https://www.reddit.com/', 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(15000) })
  if (!response.ok || !response.body) { await response.body?.cancel(); throw Error('Public P1 bootstrap HTTP ' + response.status) }
  const reader = response.body.getReader(), parts = []; let total = 0
  try { while (true) { const part = await reader.read(); if (part.done) break; total += part.value.length; if (total > maximum) throw Error('Public P1 text exceeds its byte budget'); parts.push(part.value) } }
  catch (error) { await reader.cancel().catch(() => {}); throw error } finally { reader.releaseLock() }
  const bytes = Buffer.concat(parts); return { text: bytes.toString('utf8'), bytes: bytes.length, sha256: sha(bytes) }
}
function configuration(source) {
  const values = [], selected = {}; let position = 0
  while ((position = source.indexOf('ytcfg.set(', position)) >= 0) {
    position += 10; while (/\s/.test(source[position] ?? '')) position++
    assert.equal(source[position], '{'); assert.ok(values.length < 64)
    const start = position; let depth = 0, quoted = false, escaped = false
    for (; position < source.length; position++) {
      const char = source[position]
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue }
      if (char === '"') quoted = true
      else if (char === '{') depth++
      else if (char === '}' && --depth === 0) { position++; break }
    }
    assert.equal(depth, 0); values.push(JSON.parse(source.slice(start, position)))
  }
  for (const value of values) for (const key of ['INNERTUBE_CLIENT_NAME', 'INNERTUBE_CONTEXT_CLIENT_NAME', 'INNERTUBE_CLIENT_VERSION', 'VISITOR_DATA', 'INNERTUBE_CONTEXT', 'WEB_PLAYER_CONTEXT_CONFIGS']) if (Object.hasOwn(value, key)) {
    if (Object.hasOwn(selected, key)) assert.equal(JSON.stringify(selected[key]), JSON.stringify(value[key]), 'Ambiguous public P1 configuration')
    selected[key] = value[key]
  }
  return selected
}
function bounded(value, maximum) { assert.equal(typeof value, 'string'); assert.ok(value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value)); return value }
async function prepareRecipe(players) {
  const html = await publicText(NEUTRAL_PUBLIC_EMBED, 4 * 1024 * 1024), cfg = configuration(html.text)
  assert.equal(cfg.INNERTUBE_CLIENT_NAME, 'WEB_EMBEDDED_PLAYER'); assert.equal(cfg.INNERTUBE_CONTEXT_CLIENT_NAME, 56)
  const client = cfg.INNERTUBE_CONTEXT.client, embedded = cfg.WEB_PLAYER_CONTEXT_CONFIGS.WEB_PLAYER_CONTEXT_CONFIG_ID_EMBEDDED_PLAYER
  // Public rollout suffixes are opaque version tokens, not dates to reconstruct.
  const version = bounded(cfg.INNERTUBE_CLIENT_VERSION, 64); assert.match(version, /^[A-Za-z0-9._+-]{1,64}$/)
  const player = new URL(bounded(embedded.jsUrl, 2048), 'https://www.youtube.com'); assert.equal(player.search, '')
  let prepared = players.get(player.href)
  if (!prepared) {
    const code = await publicText(player, 5 * 1024 * 1024)
    const analyzer = new JsAnalyzer(code.text, { extractions: [{ friendlyName: 'nsigFunction', match: nsigMatcher }, { friendlyName: 'signatureTimestampVar', match: timestampMatcher, collectDependencies: false }] })
    const extracted = new JsExtractor(analyzer).buildScript({ disallowSideEffectInitializers: true, exportRawValues: true, rawValueOnly: ['signatureTimestampVar'] })
    prepared = { code, extracted }; players.set(player.href, prepared)
  }
  const { code, extracted } = prepared
  const signatureTimestamp = Number(extracted.exportedRawValues?.signatureTimestampVar)
  assert.ok(Number.isSafeInteger(signatureTimestamp) && signatureTimestamp > 0 && extracted.exported.includes('nsigFunction'))
  assert.ok(extracted.output.length > 0 && Buffer.byteLength(extracted.output) <= 2 * 1024 * 1024)
  const extras = {}
  for (const [name, maximum] of [['platform', 128], ['clientFormFactor', 128], ['osName', 128], ['osVersion', 128], ['browserName', 128], ['browserVersion', 128], ['gl', 128], ['deviceExperimentId', 4096], ['rolloutToken', 4096]]) if (client[name] != null) extras[name] = bounded(client[name], maximum)
  if (client.configInfo?.appInstallData != null) extras.configInfo = { appInstallData: bounded(client.configInfo.appInstallData, 8192) }
  const recipe = { context: { client: { clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: version, hl: 'en', userAgent: UA, visitorData: bounded(cfg.VISITOR_DATA ?? client.visitorData, 4096), ...extras }, thirdParty: { embedUrl: 'https://www.reddit.com/' } },
    playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS', signatureTimestamp, encryptedHostFlags: bounded(embedded.encryptedHostFlags, 32768) } },
    signatureTimestamp, script: extracted.output, createdAt: new Date().toISOString(), playerSHA: code.sha256 }
  return { recipe, html, player, code }
}
export async function preparePwaP1() {
  const info = JSON.parse(await fs.readFile(path.join(root, 'node_modules/youtubei.js/package.json'), 'utf8'))
  assert.equal(info.version, '18.2.0', 'Review analyzer compatibility when changing youtubei.js')
  // Native renews public context once on a proven SABR-only response. A static
  // PWA cannot read cross-origin embed HTML, so prepare two independent neutral
  // contexts at build time. They are generic, never selected by musical ID.
  const players = new Map(), first = await prepareRecipe(players), second = await prepareRecipe(players)
  const { recipe, html, player, code } = first
  const scripts = [...new Set([recipe.script, second.recipe.script])]
  const emitted = (name, value) => {
    const { script, ...data } = value
    return `export const ${name}: P1Recipe = { ...${JSON.stringify(data)}, script: decoders[${scripts.indexOf(script)}] }\n`
  }
  const output = path.join(root, 'web-port/p1-recipe.generated.ts')
  const source = '// Generated by scripts/prepare-pwa-p1.mjs from a neutral public, anonymous embed.\n// Contains public shared client state and extracted functions, no account, cookie, musical ID or audio URL.\n// Provider validity/portability is not guaranteed by a local cache TTL.\nimport type { P1Recipe } from "./youtube-p1"\nconst decoders = ' + JSON.stringify(scripts) + '\n' + emitted('p1Recipe', recipe) + emitted('p1FallbackRecipe', second.recipe)
  await fs.writeFile(output, source)
  const evidence = { schemaVersion: 1, preparedAt: recipe.createdAt, output: 'web-port/p1-recipe.generated.ts', outputSha256: sha(source),
    publicAnonymousContextIncluded: true, authCookiesOrAccountIncluded: false, perSongMappingsIncluded: false, audioOrSignedMediaUrlsIncluded: false,
    neutralBootstrap: { url: NEUTRAL_PUBLIC_EMBED, sha256: html.sha256, bytes: html.bytes },
    player: { path: player.pathname, sha256: code.sha256, bytes: code.bytes, signatureTimestamp: recipe.signatureTimestamp },
    decoder: { sha256: sha(recipe.script), bytes: Buffer.byteLength(recipe.script), analyzerVersion: info.version },
    contextSha256: sha(JSON.stringify({ context: recipe.context, playbackContext: recipe.playbackContext })),
    renewal: { neutralBootstrap: { url: NEUTRAL_PUBLIC_EMBED, sha256: second.html.sha256, bytes: second.html.bytes },
      contextSha256: sha(JSON.stringify({ context: second.recipe.context, playbackContext: second.recipe.playbackContext })),
      playerSHA: second.code.sha256, signatureTimestamp: second.recipe.signatureTimestamp,
      sharedDecoderCount: scripts.length, requestedOnlyForProvenSabrAndChangedEffectiveContext: true },
    limits: ['Two generic public anonymous contexts are prepared at build time; no phone requests pass through this build machine.', 'The second context is a bounded SABR-only renewal, not a per-song mapping or guaranteed runtime refresh.', 'No account authentication, cookie jar, API key, media download or complete player execution is used.', 'Client state may expire or vary by IP/cohort; failing it must preserve other sources and the official fallback.', 'No guaranteed lifetime is inferred from native six-hour cache policy.'] }
  const directory = path.join(root, 'artifacts/pwa-port'); await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, 'p1-recipe-build-' + evidence.outputSha256.slice(0, 16) + '.json'), JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify({ output: evidence.output, outputSha256: evidence.outputSha256, decoderBytes: evidence.decoder.bytes, playerSHA: code.sha256, anonymousPublicContextIncluded: true }))
  return evidence
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await preparePwaP1()
