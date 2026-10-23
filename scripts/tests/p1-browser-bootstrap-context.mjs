// QA/build helper, not a runtime service. Returns one public anonymous context
// in memory. It never writes visitor/flags or a recipe to disk and never requests
// player metadata/media. Caller owns any later experimental static publication.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const FROZEN_HELPER = 'artifacts/pwa-port/p1-web-transport-source-21491f1094d1f8fe.mjs'
const FROZEN_SHA = '21491f1094d1f8fe24a9cc96babb584b58fec3b95439a60a1401b3ba7e02fa38'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

export async function buildPublicAnonymousEmbedContext({ bootstrapVideoId = 'M7lc1UVf-VE' } = {}) {
  assert.match(bootstrapVideoId, /^[A-Za-z0-9_-]{11}$/)
  const frozen = await readFile(new URL('../../' + FROZEN_HELPER, import.meta.url), 'utf8')
  assert.equal(hash(frozen), FROZEN_SHA, 'Frozen QA bootstrap mapping must not silently change')
  const start = frozen.indexOf('const UA ='), end = frozen.indexOf('// The exact same QA-owned function')
  assert.ok(start > 0 && end > start)
  const evidence = { nodeBootstrap: [] }
  // This is our own hash-pinned parser and HTTP routine. Remote player source is
  // parsed as text for ST; no provider JavaScript is evaluated by this helper.
  const configuration = new Function('assert', 'sha', 'report', 'persist', frozen.slice(start, end) + '\nreturn configuration;')(assert, hash, evidence, async () => {})
  const value = await configuration({ videoId: bootstrapVideoId, title: 'Neutral public bootstrap', kind: 'public-anonymous-build-context' })
  const { videoId: _neutralSeedId, ...genericBody } = value.body
  return {
    genericBody,
    generatedAt: new Date().toISOString(),
    evidence: {
      source: FROZEN_HELPER, sourceSha256: FROZEN_SHA,
      bootstrap: evidence.nodeBootstrap[0],
      bodyExcludingVideoIdSha256: hash(JSON.stringify(genericBody)),
      provenance: 'Own fresh public embed GET without cookies, Authorization, API key or account. No cookie jar and no raw state written by this helper.',
      identityScope: 'Generic anonymous client context; no music ID or audio is selected by this helper.',
      validity: 'Lifetime and portability across IPs remain experimental. Native cache TTL is not an upstream validity guarantee.',
      providerJavascriptExecuted: false,
    },
  }
}
