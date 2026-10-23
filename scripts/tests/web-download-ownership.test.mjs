import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const api = {}
new Function('exports', ts.transpileModule(await readFile(new URL('../../web-port/download-ownership.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText)(api)
function lockHub() {
  let held = false
  const calls = []
  return { calls, locks: { async request(name, options, callback) {
    calls.push({ name, options })
    await Promise.resolve()
    if (held) return callback(null)
    held = true
    try { return await callback({ name, mode: 'exclusive' }) } finally { held = false }
  } } }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test('one exclusive Web Lock is held across idle and repeated operations, without pagehide release or an expiring lease', async () => {
  const hub = lockHub(), first = api.createDownloadOwnership({ locks: hub.locks }), second = api.createDownloadOwnership({ locks: hub.locks })
  const pending = first.acquire(); assert.equal(first.acquire(), pending)
  await pending; first.assertOwned(); await first.acquire(); await tick()
  assert.equal(hub.calls.length, 1)
  assert.deepEqual(hub.calls[0], { name: api.DOWNLOAD_OWNER_LOCK, options: { mode: 'exclusive', ifAvailable: true } })
  await assert.rejects(second.acquire(), { code: 'queue-busy' })
  await assert.rejects(second.acquire(), { code: 'queue-busy' })
  first.dispose(); await tick(); await second.acquire(); second.assertOwned()
  assert.throws(() => first.assertOwned(), { code: 'queue-ownership-released' })
  await assert.rejects(first.acquire(), { code: 'queue-ownership-released' })
  second.dispose()
})

test('a missing, denied or throwing Web Locks API fails closed with a stable UI error', async () => {
  for (const locks of [null, {}, { request() { throw new DOMException('Denied', 'SecurityError') } },
    { request: async () => { throw new Error('Storage denied') } }]) {
    const owner = api.createDownloadOwnership({ locks })
    await assert.rejects(owner.acquire(), { code: 'queue-ownership-unavailable' })
    assert.throws(() => owner.assertOwned(), { code: 'queue-busy' })
    owner.dispose()
  }
})

test('disposal before asynchronous lock admission cannot revive an invalidated context', async () => {
  let enter
  const gate = new Promise(resolve => { enter = resolve })
  const owner = api.createDownloadOwnership({ locks: { request: async (_name, _options, callback) => { await gate; return callback({}) } } })
  const pending = owner.acquire(); owner.dispose(); enter()
  await assert.rejects(pending, { code: 'queue-ownership-released' })
})
