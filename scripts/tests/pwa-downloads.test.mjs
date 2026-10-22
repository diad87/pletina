import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { webcrypto } from 'node:crypto'
import { IDBFactory } from 'fake-indexeddb'

const source = (await readFile(new URL('../../pwa/sw.js', import.meta.url), 'utf8'))
  .replace('__BUILD_VERSION__', '"download-test"').replace('__PRECACHE_FILES__', '[]').replace('__OPTIONAL_FILES__', '[]')
const scope = 'https://example.test/pletina/'
const cacheName = 'pletina-audio-downloads:v1'
const databaseName = 'pletina-web-downloads'
const stable = scope + '__audio__/123'
const stage = stable + '?stage=1792390000000-01234567-89ab-cdef-0123-456789abcdef'

function harness() {
  const indexedDB = new IDBFactory(), handlers = new Map(), stores = new Map()
  let network = 0
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map())
      const rows = stores.get(name)
      return { async match(key) { return rows.get(key)?.clone() }, async put(key, response) { rows.set(key, response.clone()) } }
    },
    async keys() { return [...stores.keys()] },
    async delete(key) { return stores.delete(key) },
  }
  runInNewContext(source, {
    self: { registration: { scope }, addEventListener(type, callback) { handlers.set(type, callback) }, clients: { async claim() {} } },
    caches, indexedDB, URL, Request, Response, Headers, crypto: webcrypto, Uint8Array,
    fetch() { network++; throw new Error('El audio guardado no debe usar la red.') },
  })
  return {
    indexedDB, caches, stores,
    get network() { return network },
    async fetch(url, options = {}) {
      let reply
      handlers.get('fetch')({ request: { url: new URL(url, scope).href, method: 'GET', mode: 'no-cors', headers: new Headers(), ...options }, respondWith(value) { reply = value } })
      return reply ? await reply : undefined
    },
    async activate() { let work; handlers.get('activate')({ waitUntil(value) { work = value } }); await work },
  }
}

async function save(h, row) {
  await new Promise((resolve, reject) => {
    const opening = h.indexedDB.open(databaseName, 1)
    opening.onupgradeneeded = () => opening.result.createObjectStore('files', { keyPath: 'id' })
    opening.onerror = () => reject(opening.error)
    opening.onsuccess = () => {
      const db = opening.result, tx = db.transaction('files', 'readwrite')
      tx.objectStore('files').put(row)
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onabort = () => { db.close(); reject(tx.error) }
    }
  })
}

test('a downloaded route resolves committed metadata and cached bytes without network, including range requests', async () => {
  const h = harness()
  await (await h.caches.open(cacheName)).put(stage, new Response('audio-completo'))
  await save(h, { id: 123, cacheKey: stage })
  assert.equal(await (await h.fetch(stable)).text(), 'audio-completo')
  const range = await h.fetch(stable, { headers: new Headers({ Range: 'bytes=4-' }) })
  assert.equal(range.status, 206)
  assert.equal(range.headers.get('content-range'), 'bytes 4-13/14')
  assert.equal(await range.text(), 'o-completo')
  assert.equal(h.network, 0)
})

test('readable downloaded audio serves bounded, open-ended and suffix byte ranges locally', async () => {
  const h = harness()
  await (await h.caches.open(cacheName)).put(stage, new Response('0123456789', { headers: { 'content-type': 'audio/mpeg' } }))
  await save(h, { id: 123, cacheKey: stage })
  const whole = await h.fetch(stable)
  assert.equal(whole.status, 200); assert.equal(whole.headers.get('accept-ranges'), 'bytes')
  assert.equal(whole.headers.get('content-length'), '10'); assert.equal(await whole.text(), '0123456789')
  for (const [range, expected, start, end] of [['bytes=2-5', '2345', 2, 5], ['bytes=7-', '789', 7, 9],
    ['bytes=-3', '789', 7, 9], ['bytes=-99', '0123456789', 0, 9], ['bytes=0-99', '0123456789', 0, 9], ['bytes=0-0', '0', 0, 0]]) {
    const response = await h.fetch(stage, { headers: new Headers({ range }) })
    assert.equal(response.status, 206, range)
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/10`)
    assert.equal(response.headers.get('content-length'), String(expected.length))
    assert.equal(response.headers.get('content-type'), 'audio/mpeg')
    assert.equal(await response.text(), expected)
  }
  assert.equal(h.network, 0)
})

test('invalid, multiple, reversed or unsatisfied readable ranges return 416 without remote traffic', async () => {
  const h = harness()
  await (await h.caches.open(cacheName)).put(stage, new Response('0123456789'))
  for (const range of ['bytes=10-', 'bytes=5-2', 'bytes=-0', 'bytes=-', 'bytes=0-1,4-5', 'items=0-1', 'bytes=9007199254740992-', 'bytes=0-9007199254740992']) {
    const response = await h.fetch(stage, { headers: new Headers({ range }) })
    assert.equal(response.status, 416, range)
    assert.equal(response.headers.get('content-range'), 'bytes */10')
    assert.equal(response.headers.get('content-length'), '0')
    assert.equal(await response.text(), '')
  }
  assert.equal(h.network, 0)
})

test('opaque legacy YouTube bodies pass through unchanged even when audio asks for a range', async () => {
  const h = harness()
  const opaque = { type: 'opaque', status: 0, clone() { return this }, blob() { assert.fail('cannot read opaque bytes') } }
  await (await h.caches.open(cacheName)).put(stage, opaque)
  assert.equal(await h.fetch(stage, { headers: new Headers({ range: 'bytes=5-' }) }), opaque)
  assert.equal(h.network, 0)
})

test('a staging route validates cached media before any completed database row exists', async () => {
  const h = harness()
  await (await h.caches.open(cacheName)).put(stage, new Response('temporal'))
  assert.equal(await (await h.fetch(stage)).text(), 'temporal')
  assert.equal((await h.fetch(stable)).status, 404)
  const dbs = await h.indexedDB.databases()
  assert.equal(dbs.some((row) => row.name === databaseName), false, 'a miss must not create an empty database')
})

test('uncommitted, evicted, malformed and foreign paths cannot become completed downloads or fetch remote audio', async () => {
  const h = harness()
  for (const url of [stable, stable + '?stage=invalid', stable + '?other=value', scope + '__audio__/0', scope + '__audio__/0123', scope + '__audio__/123/no']) {
    assert.equal((await h.fetch(url)).status, 404)
  }
  await save(h, { id: 123, cacheKey: 'https://foreign.test/__audio__/123?stage=1792390000000-test' })
  assert.equal((await h.fetch(stable)).status, 404)
  await save(h, { id: 123, cacheKey: stage })
  assert.equal((await h.fetch(stable)).status, 404, 'a database row without cached media is not playable')
  assert.equal(h.network, 0)
})

test('app cache cleanup preserves downloaded audio while leaving other scopes and methods to the browser', async () => {
  const h = harness()
  await (await h.caches.open(cacheName)).put(stage, new Response('conservar'))
  await h.caches.open('pletina-pwa:' + encodeURIComponent(scope) + ':old')
  await h.activate()
  assert.equal(await (await (await h.caches.open(cacheName)).match(stage)).text(), 'conservar')
  assert.equal(h.stores.size, 1)
  for (const [url, options] of [
    ['https://foreign.test/pletina/__audio__/123', {}],
    ['https://example.test/other/__audio__/123', {}],
    [stable, { method: 'POST' }],
    [stable, { method: 'HEAD' }],
  ]) assert.equal(await h.fetch(url, options), undefined)
})
