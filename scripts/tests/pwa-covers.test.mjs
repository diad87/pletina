import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import coverRouting from '../../pwa/cover-routing.mjs'

const root = 'https://app.example/nested/pletina/'
const routing = coverRouting(root)
const original = 'https://e-cdns-images.dzcdn.net/images/cover/abcdef0123456789/500x500-000000-80-0-0.jpg'
const large = original.replace('500x500', '1000x1000')
const png = await readFile(new URL('../../pwa/icons/icon-192.png', import.meta.url))
const response = (bytes = png, type = 'image/png', extra = {}) => new Response(bytes, { headers: { 'content-type': type, ...extra } })
const workerSource = (await readFile(new URL('../../pwa/sw.js', import.meta.url), 'utf8'))
  .replace('__COVER_ROUTING_FACTORY__', coverRouting.toString())
  .replace('__BUILD_VERSION__', '"covers-test"').replace('__PRECACHE_FILES__', '[]').replace('__OPTIONAL_FILES__', '[]')

function worker({ online = true, network = async () => response() } = {}) {
  const handlers = new Map(), stores = new Map(), requests = [], writes = []
  const caches = { async open(name) {
    if (!stores.has(name)) stores.set(name, new Map())
    const rows = stores.get(name)
    return { async match(key) { return rows.get(String(key))?.clone() },
      async put(key, value) { writes.push({ name, key: String(key) }); rows.set(String(key), value.clone()) } }
  }, async keys() { return [...stores.keys()] }, async delete(name) { return stores.delete(name) } }
  runInNewContext(workerSource, { self: { registration: { scope: root }, navigator: { onLine: online },
    clients: { async claim() {} }, addEventListener(type, fn) { handlers.set(type, fn) } },
    caches, URL, Request, Response, Headers, Uint8Array, AbortController, DOMException, setTimeout, clearTimeout,
    async fetch(url, options) { requests.push({ url: String(url), options }); return network(url, options) } })
  return { stores, writes, requests, caches,
    async fetch(url, method = 'GET') {
      let result
      handlers.get('fetch')({ request: { url: new URL(url, root).href, method, mode: 'no-cors', headers: new Headers() },
        respondWith(value) { result = value } })
      return result ? await result : undefined
    }, async activate() { let work; handlers.get('activate')({ waitUntil(value) { work = value } }); await work } }
}

test('cover route keys preserve scope and collapse only known Deezer size families', () => {
  assert.equal(routing.cacheName, 'pletina-cover-downloads:v1')
  for (const value of [original, original.replace('500x500', '56x56'), large]) assert.equal(routing.key(value), routing.local(large))
  assert.equal(routing.parse(routing.local(original)), original)
  assert.deepEqual(routing.candidates(original), [large, original])
  assert.deepEqual(routing.candidates(large), [large])
  for (const value of ['https://podcast.example/art/500x500-cover.png', original.replace('dzcdn.net', 'dzcdn.net.evil.invalid'),
    original.replace('/images/cover/', '/unrelated/cover/')]) {
    assert.equal(routing.key(value), routing.local(value)); assert.deepEqual(routing.candidates(value), [value])
  }
  const other = coverRouting('https://app.example/another/')
  assert.notEqual(routing.key(original), other.key(original)); assert.equal(other.parse(routing.local(original)), null)
})

test('cover normalization rejects nonpermanent URLs, credentials, fragments and ambiguous local query parameters', () => {
  for (const value of ['', null, 1, 'file:///cover.png', 'data:image/png,hi', 'blob:https://app.example/id',
    'http://images.example/cover.jpg', 'https://user:pass@images.example/a.jpg', original + '#x', original + '?token=secret',
    original + '?X-Amz-Signature=secret', original + '?Expires=1799999999', original + '\n', 'https://images.example:8443/a',
    'https://images.example/' + 'x'.repeat(4000)]) {
    assert.equal(routing.normalize(value), null); assert.equal(routing.key(value), null); assert.equal(routing.local(value), null)
    assert.deepEqual(routing.candidates(value), [])
  }
  const local = routing.local(original)
  for (const value of [local + '&url=' + encodeURIComponent(large), local + '&other=1', local + '#x',
    local.replace('/__covers__?', '/__covers__/extra?'), local.replace('app.example', 'other.example'),
    new URL('__covers__?url=' + encodeURIComponent(original + '?sig=secret'), root).href]) assert.equal(routing.parse(value), null)
  assert.equal(routing.normalize(original + '?width=300&quality=80'), original + '?width=300&quality=80')
})

test('readable raster policy returns only bounded synthetic image bytes with measured headers', async () => {
  const accepted = await routing.readRaster(response())
  assert.ok(accepted); assert.deepEqual(Buffer.from(await accepted.clone().arrayBuffer()), png)
  assert.equal(accepted.headers.get('content-length'), String(png.length)); assert.equal(accepted.headers.get('content-type'), 'image/png')
  assert.equal(accepted.headers.get('x-content-type-options'), 'nosniff')
  assert.match(accepted.headers.get('content-security-policy'), /default-src 'none'/)
  for (const invalid of [response('<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml'), response('<html>not image</html>', 'image/png'),
    response(png, 'text/html'), response(png.subarray(0, 35)), response(png, 'image/png', { 'content-range': 'bytes 0-10/100' }),
    new Response(png, { status: 206, headers: { 'content-type': 'image/png' } }),
    response(png, 'image/png', { 'content-length': String(routing.limits.maxBytes + 1) })]) assert.equal(await routing.readRaster(invalid), null)
  const opaque = response(); Object.defineProperty(opaque, 'type', { value: 'opaque' })
  assert.equal(await routing.readRaster(opaque), null)
})

test('raster limits check actual streamed bytes and native dimensions instead of trusting headers', async () => {
  let cancelled = false
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(routing.limits.maxBytes + 1)) }, cancel() { cancelled = true } })
  assert.equal(await routing.readRaster(new Response(stream, { headers: { 'content-type': 'image/png', 'content-length': '1' } })), null)
  assert.equal(cancelled, true)
  for (const width of [0, 4097, 0xffff_ffff]) {
    const tooLarge = Buffer.from(png); tooLarge.writeUInt32BE(width, 16)
    assert.equal(await routing.readRaster(response(tooLarge)), null)
  }
  const wrongSignature = Buffer.from(png); wrongSignature[0] = 0
  assert.equal(await routing.readRaster(response(wrongSignature)), null)
  const controller = new AbortController()
  let aborted = false
  const pending = routing.readRaster(new Response(new ReadableStream({ cancel() { aborted = true } }), { headers: { 'content-type': 'image/png' } }), controller.signal)
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(aborted, true)
})

test('JPEG and WebP headers are dimension-bounded; unsupported animation and incomplete containers are rejected', async () => {
  // Header-policy fixtures only; the saver separately requires native image decoding.
  const jpeg = Buffer.from([255, 216, 255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0, 255, 217])
  assert.ok(await routing.readRaster(response(jpeg, 'image/jpeg')))
  const largeJpeg = Buffer.from(jpeg); largeJpeg[9] = 0x20
  assert.equal(await routing.readRaster(response(largeJpeg, 'image/jpeg')), null)
  const webp = Buffer.alloc(26); webp.write('RIFF'); webp.writeUInt32LE(18, 4); webp.write('WEBPVP8L', 8); webp.writeUInt32LE(5, 16); webp[20] = 0x2f
  // VP8L needs enough complete container bytes; this thirty-byte variant is the bounded header control.
  const complete = Buffer.concat([webp, Buffer.from([0, 0, 0, 0])]); complete.writeUInt32LE(22, 4); complete.writeUInt32LE(9, 16)
  assert.ok(await routing.readRaster(response(complete, 'image/webp')))
  complete.writeUInt32LE(100, 4)
  assert.equal(await routing.readRaster(response(complete, 'image/webp')), null)
  assert.equal(await routing.readRaster(response(jpeg, 'image/png')), null)
})

test('cover worker serves a cached raster family without network and preserves it during activation', async () => {
  const h = worker({ online: false, network: async () => assert.fail('Cached art must not use the network') })
  await (await h.caches.open(routing.cacheName)).put(routing.key(original), await routing.readRaster(response()))
  const writes = h.writes.length
  const value = await h.fetch(routing.local(original.replace('500x500', '56x56')))
  assert.equal(value.status, 200); assert.deepEqual(Buffer.from(await value.arrayBuffer()), png)
  assert.equal(h.requests.length, 0); assert.equal(h.writes.length, writes)
  await h.caches.open('pletina-pwa:' + encodeURIComponent(root) + ':old')
  await h.activate()
  assert.ok(h.stores.has(routing.cacheName)); assert.ok(!(await h.caches.keys()).some(key => key.endsWith(':old')))
})

test('online view fetches are bounded readable CORS requests and never populate the cover cache', async () => {
  const h = worker({ network: async (url, options) => {
    assert.equal(options.mode, 'cors'); assert.equal(options.credentials, 'omit'); assert.equal(options.referrerPolicy, 'no-referrer')
    assert.ok(options.signal); return url === large ? response('denied', 'text/html') : response()
  } })
  const value = await h.fetch(routing.local(original))
  assert.equal(value.status, 200); assert.deepEqual(Buffer.from(await value.arrayBuffer()), png)
  assert.deepEqual(h.requests.map(row => row.url), [large, original]); assert.equal(h.writes.length, 0)
  assert.equal(h.stores.get(routing.cacheName).size, 0)
})

test('unsupported or CORS-blocked images redirect only to the validated remote URL; poisoned cache is never served', async () => {
  for (const network of [async () => response('<svg/>', 'image/svg+xml'), async () => { throw new TypeError('CORS blocked') }]) {
    const h = worker({ network })
    const value = await h.fetch(routing.local(original))
    assert.equal(value.status, 302); assert.equal(value.headers.get('location'), original)
    assert.equal((await value.arrayBuffer()).byteLength, 0); assert.equal(h.writes.length, 0)
  }
  const offline = worker({ online: false })
  await (await offline.caches.open(routing.cacheName)).put(routing.key(original), response('<html>untrusted</html>', 'image/png'))
  assert.equal((await offline.fetch(routing.local(original))).status, 404); assert.equal(offline.requests.length, 0)
  for (const value of [routing.local(original) + '&extra=1', new URL('__covers__?url=' + encodeURIComponent('javascript:alert(1)'), root).href]) {
    assert.equal((await offline.fetch(value)).status, 404); assert.equal(offline.requests.length, 0)
  }
  assert.equal(await offline.fetch(routing.local(original), 'POST'), undefined)
})
