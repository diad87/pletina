import assert from 'node:assert/strict'
import { createHash, webcrypto } from 'node:crypto'
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { buildPortablePwa, buildPwa, sourceDirectory } from '../build-pwa.mjs'

const scope = 'https://example.test/pletina/'
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function sandbox(t) {
  const parent = resolve(tmpdir())
  const root = await mkdtemp(join(parent, 'pletina-pwa-tests-'))
  t.after(async () => {
    // La limpieza se limita al directorio temporal creado por esta prueba.
    assert.equal(dirname(resolve(root)), parent)
    assert.match(basename(root), /^pletina-pwa-tests-/)
    await rm(root, { recursive: true, force: true })
  })
  return root
}

async function readTree(directory, base = directory) {
  const files = new Map()
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      for (const item of await readTree(path, base)) files.set(...item)
    } else if (entry.isFile()) {
      files.set(relative(base, path).split(sep).join('/'), await readFile(path))
    }
  }
  return files
}

function snapshot(files) {
  return [...files].map(([name, bytes]) => [name, digest(bytes)]).sort(([a], [b]) => a.localeCompare(b))
}

async function buildAt(root, name, source = sourceDirectory) {
  // buildPwa exige que una salida alternativa todavía no exista.
  const output = join(root, name)
  const result = await buildPwa({ source, output })
  return { ...result, output, assets: await readTree(output) }
}

async function buildPair(t) {
  const root = await sandbox(t)
  const source = join(root, 'source')
  await cp(sourceDirectory, source, { recursive: true })
  const first = await buildAt(root, 'first', source)
  const htmlPath = join(source, 'index.html')
  const html = await readFile(htmlPath, 'utf8')
  assert.ok(html.includes('Hola mundo.'))
  await writeFile(htmlPath, html.replace('Hola mundo.', 'Hola mundo. Versión nueva.'))
  const second = await buildAt(root, 'second', source)
  assert.notEqual(first.version, second.version)
  return { first, second }
}

const requestKey = (request) => typeof request === 'string' ? request : request.url

class MemoryCache {
  entries = new Map()

  async put(request, response) {
    this.entries.set(requestKey(request), response.clone())
  }

  async match(request) {
    return this.entries.get(requestKey(request))?.clone()
  }
}

class MemoryCacheStorage {
  stores = new Map()

  async open(name) {
    if (!this.stores.has(name)) this.stores.set(name, new MemoryCache())
    return this.stores.get(name)
  }

  async keys() { return [...this.stores.keys()] }
  async delete(name) { return this.stores.delete(name) }
}

function assetNetwork(build, base = scope) {
  const assets = new Map([...build.assets].map(([name, bytes]) => [new URL(name, base).href, bytes]))
  return {
    online: true,
    requests: [],
    override: undefined,
    async fetch(request) {
      const url = requestKey(request)
      this.requests.push(url)
      if (!this.online) throw new TypeError('Sin conexión')
      const override = await this.override?.(url, request)
      if (override) return override
      return assets.has(url) ? new Response(assets.get(url)) : new Response('No encontrado', { status: 404 })
    },
  }
}

function worker(build, { storage = new MemoryCacheStorage(), base = scope, network = assetNetwork(build, base) } = {}) {
  const handlers = new Map()
  const calls = { skipWaiting: 0, claim: 0 }
  const self = {
    registration: { scope: base },
    addEventListener(type, handler) {
      if (!handlers.has(type)) handlers.set(type, [])
      handlers.get(type).push(handler)
    },
    async skipWaiting() { calls.skipWaiting++ },
    clients: { async claim() { calls.claim++ } },
  }
  runInNewContext(build.assets.get('sw.js').toString(), {
    self, caches: storage, fetch: network.fetch.bind(network), crypto: webcrypto,
    URL, Request, Response, Uint8Array,
  }, { filename: 'built-pwa-sw.js' })

  return {
    storage, network, calls,
    async dispatch(type, properties = {}) {
      const promises = []
      assert.ok(handlers.has(type), `Falta el manejador ${type}`)
      const event = { ...properties, waitUntil(promise) { promises.push(Promise.resolve(promise)) } }
      for (const handler of handlers.get(type)) handler(event)
      await Promise.all(promises)
    },
    async fetch(path, { method = 'GET', mode = 'navigate' } = {}) {
      const request = { url: new URL(path, base).href, method, mode }
      let response
      let count = 0
      for (const handler of handlers.get('fetch') || []) {
        handler({ request, respondWith(promise) { count++; response = Promise.resolve(promise) } })
      }
      assert.ok(count <= 1, 'La misma petición no puede tener dos respuestas del worker')
      return response ? await response : undefined
    },
  }
}

function assertPngDimensions(bytes, width, height) {
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  assert.equal(bytes.toString('ascii', 12, 16), 'IHDR')
  assert.equal(bytes.readUInt32BE(16), width)
  assert.equal(bytes.readUInt32BE(20), height)
}

test('el build es determinista y referencia el JavaScript publicado por su contenido', async (t) => {
  const root = await sandbox(t)
  const sourceBefore = snapshot(await readTree(sourceDirectory))
  const first = await buildAt(root, 'first')
  const second = await buildAt(root, 'second')
  assert.equal(first.version, second.version)
  assert.equal(first.bytes, second.bytes)
  assert.deepEqual(snapshot(first.assets), snapshot(second.assets))
  assert.deepEqual(snapshot(await readTree(sourceDirectory)), sourceBefore, 'Compilar no debe modificar los fuentes')

  const scripts = [...first.assets.keys()].filter((name) => /^app\.[a-f0-9]+\.js$/.test(name))
  assert.equal(scripts.length, 1)
  assert.ok(scripts[0].includes(digest(first.assets.get(scripts[0])).slice(0, 16)))
  assert.equal(first.assets.has('app.js'), false)
  const html = first.assets.get('index.html').toString()
  assert.ok(html.includes(`src="./${scripts[0]}"`))
  assert.ok(html.includes(first.version))
  assert.doesNotMatch(html + first.assets.get('sw.js'), /__APP_SCRIPT__|__BUILD_VERSION__|__PRECACHE_FILES__|__OPTIONAL_FILES__/)
  assert.ok(first.assets.has('.nojekyll'))
})

test('la copia portable contiene sus recursos en un solo HTML y no aumenta la descarga de Pages', async (t) => {
  const root = await sandbox(t)
  const build = await buildAt(root, 'web')
  const output = join(root, 'portable', 'Pletina.html')
  const portable = await buildPortablePwa({ directory: build.output, output })
  const html = await readFile(output, 'utf8')
  assert.equal(Buffer.byteLength(html), portable.bytes)
  assert.match(html, /<html[^>]+data-portable/)
  assert.match(html, /<script>[\s\S]+<\/script>/)
  assert.match(html, /src="data:image\/png;base64,/)
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+rel="(?:manifest|icon|apple-touch-icon)"|(?:src|href)="\.\//)
  assert.equal(build.files.includes('Pletina.html'), false)
  assert.deepEqual((await readdir(join(root, 'portable'))), ['Pletina.html'])
})

test('el manifiesto mantiene identidad relativa y los PNG tienen las dimensiones anunciadas', async (t) => {
  const root = await sandbox(t)
  const build = await buildAt(root, 'output')
  const manifest = JSON.parse(build.assets.get('manifest.webmanifest'))
  for (const base of [scope, 'https://another.example/nested/demo/']) {
    for (const field of ['id', 'scope', 'start_url']) {
      assert.equal(typeof manifest[field], 'string')
      assert.doesNotMatch(manifest[field], /^(?:[a-z]+:|\/)/i)
      assert.equal(new URL(manifest[field], base).href, base, `${field} debe respetar la ruta de publicación`)
    }
  }
  assert.equal(manifest.display, 'standalone')
  assert.ok(manifest.icons.length >= 2)
  assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192'))
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512'))
  for (const icon of manifest.icons) {
    assert.equal(icon.type, 'image/png')
    assert.doesNotMatch(icon.src, /^(?:[a-z]+:|\/)/i)
    const url = new URL(icon.src, scope)
    assert.ok(url.href.startsWith(scope))
    const [width, height] = icon.sizes.split('x').map(Number)
    const bytes = build.assets.get(url.pathname.slice(new URL(scope).pathname.length))
    assert.ok(bytes, `Falta el icono ${icon.src}`)
    assertPngDimensions(bytes, width, height)
  }
  assertPngDimensions(build.assets.get('icons/apple-touch-icon.png'), 180, 180)
  assert.match(build.assets.get('index.html').toString(), /rel="apple-touch-icon"[^>]+sizes="180x180"[^>]+href="\.\/icons\/apple-touch-icon\.png"/)
})

test('un cambio exclusivo del service worker genera otra versión y otra caché', async (t) => {
  const root = await sandbox(t)
  const source = join(root, 'source')
  await cp(sourceDirectory, source, { recursive: true })
  const first = await buildAt(root, 'first', source)
  const path = join(source, 'sw.js')
  await writeFile(path, `${await readFile(path, 'utf8')}\n// Cambio de política del worker.\n`)
  const second = await buildAt(root, 'second', source)
  assert.notEqual(first.version, second.version)
  const unchangedAssets = (build) => snapshot(new Map([...build.assets].filter(([name]) => !['index.html', 'sw.js'].includes(name))))
  assert.deepEqual(unchangedAssets(first), unchangedAssets(second))

  const storage = new MemoryCacheStorage()
  await worker(first, { storage }).dispatch('install')
  const firstKeys = await storage.keys()
  await worker(second, { storage }).dispatch('install')
  const secondKeys = await storage.keys()
  assert.equal(firstKeys.length, 1)
  assert.equal(secondKeys.length, 2)
  assert.ok(secondKeys.includes(firstKeys[0]))
})

test('la instalación guarda los assets iniciales y permite navegar sin red a la raíz y al índice con query', async (t) => {
  const root = await sandbox(t)
  const build = await buildAt(root, 'output')
  const active = worker(build)
  await active.dispatch('install')
  const [key] = await active.storage.keys()
  assert.ok(key)
  const cache = await active.storage.open(key)
  for (const [name, bytes] of build.assets) {
    if (name === 'sw.js' || name === '.nojekyll' || build.optionalFiles.includes(name)) continue
    const response = await cache.match(new URL(name, scope).href)
    assert.ok(response, `El precache debe contener ${name}`)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
  }
  assert.equal(active.calls.skipWaiting, 0)
  await active.dispatch('activate')
  assert.equal(active.calls.claim, 1)
  active.network.online = false
  const downloaded = active.network.requests.length
  for (const path of ['/pletina/', '/pletina/index.html?x=1']) {
    const response = await active.fetch(path)
    assert.ok(response)
    assert.equal(await response.text(), build.assets.get('index.html').toString())
  }
  const script = [...build.assets.keys()].find((name) => /^app\..+\.js$/.test(name))
  const cachedScript = await active.fetch(`${script}?v=offline`, { mode: 'cors' })
  assert.equal(await cachedScript.text(), build.assets.get(script).toString())
  assert.equal(active.network.requests.length, downloaded, 'El arranque offline no debe necesitar la red')
})

test('una actualización conserva la versión activa hasta su activación y respeta las cachés de otros scopes', async (t) => {
  const { first, second } = await buildPair(t)
  const storage = new MemoryCacheStorage()
  const active = worker(first, { storage })
  await active.dispatch('install')
  await active.dispatch('activate')
  const [oldKey] = await storage.keys()

  // Cachés con otros ámbitos o nombres deben sobrevivir a esta activación.
  for (const base of ['https://example.test/pletina-other/', 'https://other.example/pletina/']) {
    await worker(first, { storage, base }).dispatch('install')
  }
  await (await storage.open('music-library')).put('https://example.test/song', new Response('conservar'))
  const preservedKeys = (await storage.keys()).filter((key) => key !== oldKey)
  const update = worker(second, { storage })
  await update.dispatch('install')
  const newKeys = (await storage.keys()).filter((key) => key !== oldKey && !preservedKeys.includes(key))
  assert.equal(newKeys.length, 1)
  const [newKey] = newKeys
  assert.ok((await storage.keys()).includes(oldKey))
  assert.equal(update.calls.skipWaiting, 0, 'Descargar una actualización no debe activarla por sorpresa')
  assert.equal(update.calls.claim, 0)
  active.network.online = false
  assert.equal(await (await active.fetch('/pletina/')).text(), first.assets.get('index.html').toString())

  const staged = await storage.open(newKey)
  for (const name of second.assets.keys()) {
    if (name !== 'sw.js' && name !== '.nojekyll' && !second.optionalFiles.includes(name)) assert.ok(await staged.match(new URL(name, scope).href))
  }
  await update.dispatch('message', { data: { type: 'ACTIVATE_UPDATE' } })
  assert.equal(update.calls.skipWaiting, 1)
  await update.dispatch('activate')
  assert.deepEqual((await storage.keys()).sort(), [...preservedKeys, newKey].sort())
  assert.equal(await (await (await storage.open('music-library')).match('https://example.test/song')).text(), 'conservar')
  assert.equal(update.calls.claim, 1)
  update.network.online = false
  assert.equal(await (await update.fetch('/pletina/index.html?updated=1')).text(), second.assets.get('index.html').toString())
})

for (const failure of ['HTTP', 'integridad']) {
  test(`un fallo de ${failure} rechaza la instalación incompleta y conserva la caché anterior`, async (t) => {
    const { first, second } = await buildPair(t)
    const storage = new MemoryCacheStorage()
    const active = worker(first, { storage })
    await active.dispatch('install')
    await active.dispatch('activate')
    const oldKeys = await storage.keys()
    const network = assetNetwork(second)
    // El manifiesto se descarga después de otros assets: el rollback también limpia lo ya guardado.
    network.override = (url) => url.endsWith('/manifest.webmanifest')
      ? failure === 'HTTP' ? new Response('Servicio no disponible', { status: 503 }) : new Response('Contenido de otra versión')
      : undefined
    const update = worker(second, { storage, network })
    await assert.rejects(update.dispatch('install'), /manifest\.webmanifest/)
    assert.ok(network.requests.length > 1)
    assert.deepEqual(await storage.keys(), oldKeys)
    assert.equal(update.calls.skipWaiting, 0)
    assert.equal(update.calls.claim, 0)
    active.network.online = false
    assert.equal(await (await active.fetch('/pletina/')).text(), first.assets.get('index.html').toString())
  })
}

test('el worker deja al navegador las peticiones ajenas, los POST y otros orígenes', async (t) => {
  const root = await sandbox(t)
  const build = await buildAt(root, 'output')
  const active = worker(build)
  await active.dispatch('install')
  await active.dispatch('activate')
  active.network.online = false
  const downloaded = active.network.requests.length
  for (const [url, options] of [
    ['https://other.example/pletina/index.html', {}],
    ['/pletina/index.html', { method: 'POST' }],
    ['/other/', {}],
    ['/pletina-other/', {}],
    ['/pletina/unknown.html', {}],
    ['/pletina/api/search?q=test', { mode: 'cors' }],
  ]) {
    assert.equal(await active.fetch(url, options), undefined, `No debe interceptar ${options.method || 'GET'} ${url}`)
  }
  assert.equal(active.network.requests.length, downloaded)
})
