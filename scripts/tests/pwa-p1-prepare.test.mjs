import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

// Execute the actual bootstrap/parser/writer flow with synthetic public HTTP
// documents. Analyzer output and filesystem writes stay in memory; this never
// contacts YouTube, changes the shipped recipe or evaluates provider code.
const moduleURL = new URL('../prepare-pwa-p1.mjs', import.meta.url)
const source = (await readFile(moduleURL, 'utf8')).split('if (process.argv[1]')[0]
  .replace(/^import .*\r?$/gm, '').replace('export async function preparePwaP1', 'async function preparePwaP1')
  .replaceAll('import.meta.url', JSON.stringify(moduleURL.href))

function harness(version) {
  const requests = [], writes = new Map()
  const configuration = {
    INNERTUBE_CLIENT_NAME: 'WEB_EMBEDDED_PLAYER', INNERTUBE_CONTEXT_CLIENT_NAME: 56,
    INNERTUBE_CLIENT_VERSION: version, VISITOR_DATA: 'synthetic-public-visitor',
    INNERTUBE_CONTEXT: { client: { clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: version, platform: 'DESKTOP' } },
    WEB_PLAYER_CONTEXT_CONFIGS: { WEB_PLAYER_CONTEXT_CONFIG_ID_EMBEDDED_PLAYER: {
      encryptedHostFlags: 'synthetic-public-flags', jsUrl: '/s/player/synthetic/player_ias.vflset/en_US/base.js',
    } },
  }
  const fs = { readFile: async value => { assert.ok(value.replaceAll('\\', '/').endsWith('youtubei.js/package.json')); return '{"version":"18.2.0"}' },
    mkdir: async () => {}, writeFile: async (name, value) => { writes.set(name, value) } }
  const fetch = async (url, options) => {
    requests.push(url.href); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error')
    const bytes = new TextEncoder().encode(url.pathname.startsWith('/embed/')
      ? 'ytcfg.set(' + JSON.stringify(configuration) + ');' : 'synthetic player, never executed')
    return { ok: true, body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } }) }
  }
  class JsAnalyzer {}
  class JsExtractor { buildScript() { return { exportedRawValues: { signatureTimestampVar: 20746 }, exported: ['nsigFunction'], output: 'var exportedVars = {};' } } }
  const prepare = new Function('assert', 'fs', 'path', 'fileURLToPath', 'crypto', 'JsAnalyzer', 'JsExtractor', 'nsigMatcher', 'timestampMatcher', 'fetch', 'console',
    source + '\nreturn preparePwaP1;')(assert, fs, path, fileURLToPath, crypto, JsAnalyzer, JsExtractor, {}, {}, fetch, { log() {} })
  return { prepare, requests, writes }
}

test('public bootstrap preserves opaque rollout versions in the emitted recipe and hashes', async () => {
  for (const version of ['2.20261022.01.00-canary_control_2.20261023.01.00', 'release_1+fix-2.3', 'canary', 'v'.repeat(64)]) {
    const h = harness(version), report = await h.prepare()
    assert.equal(h.requests.length, 2); assert.equal(h.writes.size, 2)
    const recipe = [...h.writes.entries()].find(([name]) => name.endsWith('p1-recipe.generated.ts'))[1]
    assert.ok(recipe.includes('"clientVersion":' + JSON.stringify(version)), 'The published token must not be parsed as a date or truncated')
    assert.equal(crypto.createHash('sha256').update(recipe).digest('hex'), report.outputSha256)
    assert.equal(report.authCookiesOrAccountIncluded, false); assert.equal(report.audioOrSignedMediaUrlsIncluded, false)
  }
})

test('malformed version tokens stop before player source fetch or any recipe write', async () => {
  for (const version of ['', 'v'.repeat(65), '2.1 bad', '2.1\tbad', '2.1\r\nCookie:bad', '2.1é', '2.1/next', '2.1?key', '2.1"', '2.1%2B']) {
    const h = harness(version)
    await assert.rejects(h.prepare(), { name: 'AssertionError' })
    assert.equal(h.requests.length, 1); assert.equal(h.writes.size, 0)
  }
})
