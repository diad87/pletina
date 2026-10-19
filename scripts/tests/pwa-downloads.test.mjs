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
    caches, indexedDB, URL, Request, Response, crypto: webcrypto, Uint8Array,
    fetch() { network++; throw new Error('El audio guardado no debe usar la red.') },
  })
  return {
    indexedDB, caches, stores,
    get network() { return network },
    async fetch(url, options = {}) {
      let reply
      handlers.get('fetch')({ request: { url: new URL(url, scope).href, method: 'GET', mode: 'no-cors', ...options }, respondWith(value) { reply = value } })
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
  assert.equal(await (await h.fetch(stable, { headers: new Headers({ Range: 'bytes=4-' }) })).text(), 'audio-completo')
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
