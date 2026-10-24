import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import coverRouting from '../../pwa/cover-routing.mjs'

const code = ts.transpileModule(await readFile(new URL('../../web-port/download-covers.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText
const scope = new URL('https://app.example/pletina/'), routing = coverRouting(scope)
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
const cover = 'https://images.example/cover.png'
const image = (bytes = png, extra = {}) => new Response(bytes, { headers: { 'content-type': 'image/png', ...extra } })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
function harness(options = {}) {
  const rows = new Map(), requests = [], writes = [], validations = []
  let refs = options.refs ?? [cover], active = 0, peak = 0
  const cache = {
    async match(key) { return rows.get(typeof key === 'string' ? key : key.url)?.clone() },
    async put(key, response) {
      if (options.putError) throw options.putError
      if (options.putGate) await options.putGate(key)
      const url = typeof key === 'string' ? key : key.url
      rows.set(url, response.clone()); writes.push(url)
    },
    async keys() { return [...rows.keys()].map(url => new Request(url)) },
    async delete(key) { return rows.delete(typeof key === 'string' ? key : key.url) },
  }
  const caches = { async open(name) { assert.equal(name, routing.cacheName); return cache } }
  const exports = {}
  new Function('exports', 'require', 'Image', 'URL', code)(exports, path => {
    assert.equal(path, '../pwa/cover-routing.mjs'); return { __esModule: true, default: coverRouting }
  }, options.Image ?? class { naturalWidth = 1; naturalHeight = 1; async decode() {} }, options.URL ?? URL)
  const manager = exports.createDownloadCovers({ scope, caches, list: async () => refs.map(cover => ({ track: { cover } })),
    online: options.online ?? (() => true), timeout: options.timeout ?? 2000,
    validate: options.nativeValidation ? undefined : options.validate ?? (async (response) => { validations.push(await response.clone().arrayBuffer()) }),
    fetch: async (url, init) => {
      assert.equal(init.mode, 'cors'); assert.equal(init.credentials, 'omit'); assert.equal(init.referrerPolicy, 'no-referrer')
      requests.push(url); active++; peak = Math.max(peak, active)
      try { return await (options.fetch ? options.fetch(url, init) : image()) } finally { active-- }
    },
  })
  return { ...manager, exports, rows, requests, writes, validations, cache, setRefs: next => { refs = next }, get peak() { return peak } }
}

test('cover cache stores only fully read, native-decodable raster bytes under the canonical local key', async () => {
  const h = harness({ nativeValidation: true })
  await h.save(cover)
  assert.deepEqual(h.requests, [cover])
  const saved = h.rows.get(routing.key(cover))
  assert.equal(saved.type, 'default')
  assert.equal(saved.headers.get('content-type'), 'image/png')
  assert.equal(saved.headers.get('content-length'), String(png.length))
  assert.deepEqual(new Uint8Array(await saved.clone().arrayBuffer()), new Uint8Array(png))
  assert.doesNotMatch([...h.rows.keys()].join(''), /blob:|googlevideo/)
})

test('cover cache rejects opaque, HTML, SVG, oversized, excessive-dimension and undecodable images', async () => {
  const oversized = new Uint8Array(routing.limits.maxBytes + 1)
  const dimensions = Buffer.from(png); dimensions.writeUInt32BE(4097, 16)
  const inputs = [
    () => ({ type: 'opaque', status: 0, headers: new Headers(), body: null }),
    () => new Response('<html>not an image</html>', { headers: { 'content-type': 'text/html' } }),
    () => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }),
    () => image(oversized), () => image(dimensions),
  ]
  for (const fetch of inputs) {
    const h = harness({ fetch })
    await h.save(cover)
    assert.equal(h.rows.size, 0)
    assert.equal(h.validations.length, 0)
  }
  const h = harness({ validate: async () => { throw new Error('decoder rejected valid-looking header') } })
  await h.save(cover)
  assert.equal(h.rows.size, 0)
})

test('CORS rejection, quota errors and an ignored fetch timeout never produce an unhandled cover failure', async () => {
  for (const options of [
    { fetch: async () => { throw new TypeError('CORS blocked') } },
    { putError: new DOMException('quota exhausted', 'QuotaExceededError') },
    { fetch: async () => new Promise(() => {}), timeout: 20 },
  ]) {
    const h = harness(options)
    await h.save(cover); await h.idle()
    assert.equal(h.rows.size, 0)
  }
})

test('Deezer size variants share one key and try the original only if the preferred readable image fails', async () => {
  const original = 'https://cdn-images.dzcdn.net/images/cover/abc/500x500-000000-80-0-0.jpg'
  const candidates = routing.candidates(original)
  assert.equal(candidates.length, 2)
  const h = harness({ refs: [original], fetch: async url => url === candidates[0]
    ? new Response('missing', { status: 404 }) : image() })
  await h.save(original)
  assert.deepEqual(h.requests, candidates)
  assert.equal(h.rows.size, 1)
  assert.equal(h.rows.has(routing.key(candidates[0])), true)
  await h.save(candidates[0])
  assert.equal(h.requests.length, 2)
})

test('duplicate requests coalesce, cover network jobs are serial and invalid metadata never contacts a host', async () => {
  const gate = deferred(), started = deferred(), second = 'https://images.example/second.png'
  const h = harness({ refs: [cover, second], fetch: async () => { started.resolve(); await gate.promise; return image() } })
  const first = h.save(cover), duplicate = h.save(cover), next = h.save(second)
  await started.promise
  assert.equal(h.requests.length, 1)
  assert.equal(first, duplicate)
  gate.resolve(); await Promise.all([first, duplicate, next])
  assert.equal(h.peak, 1)
  assert.equal(h.rows.size, 2)
  for (const invalid of [null, '', 'http://images.example/a.png', 'https://user:pass@images.example/a.png', 'https://images.example/a.png?token=temporary']) await h.save(invalid)
  assert.equal(h.requests.length, 2)
})

test('removing one shared reference retains its cover until the final download disappears', async () => {
  const h = harness({ refs: [cover, cover] })
  await h.save(cover)
  h.setRefs([cover]); await h.prune()
  assert.equal(h.rows.size, 1)
  h.setRefs([]); await h.prune()
  assert.equal(h.rows.size, 0)
  assert.equal(h.requests.length, 1)
})

test('removal during network or native decode prevents a late orphan cover commit', async () => {
  for (const during of ['network', 'decode']) {
    const entered = deferred(), gate = deferred()
    const h = harness({ fetch: async () => { if (during === 'network') { entered.resolve(); await gate.promise } return image() },
      validate: async () => { if (during === 'decode') { entered.resolve(); await gate.promise } } })
    const saved = h.save(cover)
    await entered.promise
    h.setRefs([])
    const pruned = h.prune()
    gate.resolve(); await Promise.all([saved, pruned]); await h.idle()
    assert.equal(h.rows.size, 0)
    assert.equal(h.writes.length, 0)
  }
})

test('a local cache write finishing after timeout/removal is swept without deleting another referenced cover', async () => {
  const entered = deferred(), gate = deferred(), second = 'https://images.example/retained.png'
  let delayed = true
  const h = harness({ refs: [cover, second], timeout: 30, putGate: async key => {
    if (key === routing.key(cover) && delayed) { entered.resolve(); await gate.promise }
  } })
  const saved = h.save(cover)
  await entered.promise
  h.setRefs([second]); await saved
  delayed = false
  await h.save(second)
  gate.resolve(); await flush(); await h.idle()
  assert.deepEqual([...h.rows.keys()], [routing.key(second)])
})

test('offline backfill only collects orphans, while online backfill admits at most 32 missing unique families', async () => {
  const refs = Array.from({ length: 40 }, (_, i) => `https://images.example/${i}.png`)
  const h = harness({ refs })
  h.backfill(); h.backfill()
  await h.idle()
  assert.equal(h.requests.length, 32)
  assert.equal(h.rows.size, 32)
  const off = harness({ refs, online: () => false })
  off.rows.set(routing.key(cover), await routing.readRaster(image()))
  off.backfill(); await off.idle()
  assert.equal(off.requests.length, 0)
  assert.equal(off.rows.size, 0)
})

test('FIFO storage caps enforce 256 canonical families and 64 MiB measured stored lengths', async () => {
  const refs = Array.from({ length: 257 }, (_, i) => `https://images.example/${i}.png`)
  const h = harness({ refs })
  for (const url of refs) h.rows.set(routing.key(url), new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(png.length) } }))
  await h.prune()
  assert.equal(h.rows.size, 256)
  assert.equal(h.rows.has(routing.key(refs[0])), false)
  const large = harness({ refs: refs.slice(0, 14) })
  // Storage metadata models entries already admitted by readRaster. Budgeting
  // reads their measured header without allocating fourteen five-MiB bodies.
  for (const url of refs.slice(0, 14)) large.rows.set(routing.key(url), new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(5 * 1024 ** 2) } }))
  await large.prune()
  assert.equal(large.rows.size, 12)
  assert.equal(large.rows.has(routing.key(refs[0])), false)
  assert.equal(large.rows.has(routing.key(refs[1])), false)
})

test('native image validation releases Blob URLs on decode success, invalid dimensions and failure', async () => {
  for (const outcome of ['ok', 'dimensions', 'decode']) {
    const revoked = [], made = [], h = harness({ nativeValidation: true,
      URL: { createObjectURL(blob) { made.push(blob); return 'blob:local-cover' }, revokeObjectURL(url) { revoked.push(url) } },
      Image: class { naturalWidth = outcome === 'dimensions' ? 4097 : 1; naturalHeight = 1; async decode() { if (outcome === 'decode') throw new Error('decode failure') } },
    })
    await h.save(cover)
    assert.equal(h.rows.size, outcome === 'ok' ? 1 : 0)
    assert.equal(made.length, 1)
    assert.deepEqual(revoked, ['blob:local-cover'])
  }
})
