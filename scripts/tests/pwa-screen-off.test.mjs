import assert from 'node:assert/strict'
import { createHash, webcrypto } from 'node:crypto'
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { buildScreenOff, sourceDirectory } from '../build-pwa-screen-off.mjs'

const scope = 'https://example.test/pletina/prueba-audio/'
const marker = '__SCREEN_OFF_VERSION__'
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function sandbox(t) {
  const parent = resolve(tmpdir())
  const root = await mkdtemp(join(parent, 'pletina-screen-off-tests-'))
  t.after(async () => {
    assert.equal(dirname(resolve(root)), parent)
    assert.match(basename(root), /^pletina-screen-off-tests-/)
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

const snapshot = (files) => [...files].map(([name, bytes]) => [name, sha256(bytes)])
  .sort(([a], [b]) => a.localeCompare(b))

async function buildAt(root, name, source = sourceDirectory) {
  const output = join(root, name)
  const result = await buildScreenOff({ source, output })
  return { ...result, assets: await readTree(output) }
}

async function buildPair(t, change = 'index.html') {
  const root = await sandbox(t)
  const source = join(root, 'source')
  await cp(sourceDirectory, source, { recursive: true })
  const first = await buildAt(root, 'first', source)
  const path = join(source, change)
  const suffix = change.endsWith('.html') ? '\n<!-- Nueva pantalla de prueba. -->\n' : '\n// Nueva política del worker.\n'
  await writeFile(path, `${await readFile(path, 'utf8')}${suffix}`)
  const second = await buildAt(root, 'second', source)
  assert.notEqual(first.version, second.version)
  return { first, second }
}

const requestKey = (request) => typeof request === 'string' ? request : request.url

class MemoryCache {
  entries = new Map()
  async put(request, response) { this.entries.set(requestKey(request), response.clone()) }
  async match(request) { return this.entries.get(requestKey(request))?.clone() }
  async delete(request) { return this.entries.delete(requestKey(request)) }
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
  assets.set(base, build.assets.get('index.html'))
  return {
    online: true,
    requests: [],
    override: undefined,
    async fetch(request) {
      const url = requestKey(request)
      this.requests.push({ url, method: request.method || 'GET', cache: request.cache })
      if (!this.online) throw new TypeError('Sin conexión')
      const override = await this.override?.(url)
      if (override) return override
      return assets.has(url) ? new Response(assets.get(url)) : new Response('No encontrado', { status: 404 })
    },
  }
}

function worker(build, { storage = new MemoryCacheStorage(), base = scope, network = assetNetwork(build, base) } = {}) {
  const handlers = new Map()
  const calls = { claim: 0, skipWaiting: 0 }
  const self = {
    registration: { scope: base },
    addEventListener(type, callback) {
      if (!handlers.has(type)) handlers.set(type, [])
      handlers.get(type).push(callback)
    },
    clients: { async claim() { calls.claim++ } },
    async skipWaiting() { calls.skipWaiting++ },
  }
  runInNewContext(build.assets.get('sw.js').toString(), {
    self, caches: storage, fetch: network.fetch.bind(network), crypto: webcrypto,
    URL, Request, Response, Uint8Array,
  }, { filename: 'built-screen-off-sw.js' })
  return {
    storage, network, calls,
    async dispatch(type) {
      const promises = []
      assert.ok(handlers.has(type), `Falta el manejador ${type}`)
      for (const callback of handlers.get(type)) callback({ waitUntil(promise) { promises.push(Promise.resolve(promise)) } })
      await Promise.all(promises)
    },
    async fetch(path, { method = 'GET', mode = 'navigate' } = {}) {
      const request = { url: new URL(path, base).href, method, mode }
      let response
      let count = 0
      for (const callback of handlers.get('fetch') || []) {
        callback({ request, respondWith(promise) { count++; response = Promise.resolve(promise) } })
      }
      assert.ok(count <= 1)
      return response ? await response : undefined
    },
  }
}

test('el build sustituye todas las versiones antes de calcular la integridad y es determinista', async (t) => {
  const root = await sandbox(t)
  const source = join(root, 'source')
  await cp(sourceDirectory, source, { recursive: true })
  for (const name of ['index.html', 'resolver.js']) {
    const path = join(source, name)
    const suffix = name.endsWith('.html') ? `\n<!-- ${marker} ${marker} -->` : `\n// ${marker} ${marker}\n`
    await writeFile(path, `${await readFile(path, 'utf8')}${suffix}`)
  }
  const manifestPath = join(source, 'manifest.webmanifest')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.testBuild = [marker, marker]
  await writeFile(manifestPath, JSON.stringify(manifest))
  const sourceBefore = snapshot(await readTree(source))
  const first = await buildAt(root, 'first', source)
  const second = await buildAt(root, 'second', source)
  assert.match(first.version, /^[a-f0-9]{16}$/)
  assert.equal(second.version, first.version)
  assert.deepEqual(snapshot(second.assets), snapshot(first.assets))
  assert.deepEqual(snapshot(await readTree(source)), sourceBefore)
  assert.equal(first.assets.has('README.md'), false)
  for (const name of ['index.html', 'app.js', 'resolver.js', 'manifest.webmanifest', 'sw.js']) {
    const content = first.assets.get(name).toString()
    assert.ok(content.includes(first.version), `Falta la versión en ${name}`)
    assert.doesNotMatch(content, /__SCREEN_OFF_(?:VERSION|INTEGRITY)__/, `Queda un marcador en ${name}`)
  }
  // La instalación real en VM valida los bytes ya transformados, no los fuentes con marcadores.
  await worker(first).dispatch('install')
})

test('el build rechaza un worker sin marcador de versión antes de producir la distribución', async (t) => {
  const root = await sandbox(t)
  const source = join(root, 'source')
  await cp(sourceDirectory, source, { recursive: true })
  const path = join(source, 'sw.js')
  await writeFile(path, (await readFile(path, 'utf8')).replaceAll(marker, 'versión-fija'))
  const output = join(root, 'output')
  await assert.rejects(buildScreenOff({ source, output }), /versión del service worker/)
  await assert.rejects(stat(output), { code: 'ENOENT' })
})

test('cambiar solo el worker genera una versión de caché nueva sin borrar la anterior al instalar', async (t) => {
  const { first, second } = await buildPair(t, 'sw.js')
  const storage = new MemoryCacheStorage()
  await worker(first, { storage }).dispatch('install')
  const [oldKey] = await storage.keys()
  const update = worker(second, { storage })
  await update.dispatch('install')
  assert.equal((await storage.keys()).length, 2)
  assert.ok((await storage.keys()).includes(oldKey))
  assert.equal(update.calls.claim, 0)
  assert.equal(update.calls.skipWaiting, 0)
})

test('el precache completo sirve la raíz, el índice y los scripts sin red incluso con query', async (t) => {
  const root = await sandbox(t)
  const build = await buildAt(root, 'output')
  const active = worker(build)
  await active.dispatch('install')
  const [key] = await active.storage.keys()
  const cache = await active.storage.open(key)
  for (const [name, bytes] of build.assets) {
    if (name === 'sw.js') continue
    const response = await cache.match(new URL(name, scope).href)
    assert.ok(response, `Falta el recurso de prueba ${name}`)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
  }
  await active.dispatch('activate')
  assert.equal(active.calls.claim, 1)
  active.network.online = false
  const downloaded = active.network.requests.length
  for (const [path, expected] of [['./?test=1', 'index.html'], ['index.html?test=2', 'index.html'], ['app.js?v=1', 'app.js'], ['resolver.js?test=3', 'resolver.js']]) {
    const response = await active.fetch(path)
    assert.equal(await response.text(), build.assets.get(expected).toString())
  }
  assert.equal(active.network.requests.length, downloaded)
})

test('activar una actualización elimina solo las versiones anteriores de su propio ámbito', async (t) => {
  const { first, second } = await buildPair(t)
  const storage = new MemoryCacheStorage()
  const active = worker(first, { storage })
  await active.dispatch('install')
  await active.dispatch('activate')
  const [oldKey] = await storage.keys()
  for (const base of ['https://example.test/pletina/prueba-audio-other/', 'https://example.test/otra-prueba/']) {
    await worker(first, { storage, base }).dispatch('install')
  }
  const unrelated = await storage.open('pletina-pwa:otra-version')
  await unrelated.put('https://example.test/pletina/index.html', new Response('PWA principal'))
  const preservedKeys = (await storage.keys()).filter((key) => key !== oldKey)
  const update = worker(second, { storage })
  await update.dispatch('install')
  active.network.online = false
  assert.equal(await (await active.fetch('./')).text(), first.assets.get('index.html').toString())
  const newKeys = (await storage.keys()).filter((key) => key !== oldKey && !preservedKeys.includes(key))
  assert.equal(newKeys.length, 1)
  await update.dispatch('activate')
  assert.deepEqual((await storage.keys()).sort(), [...preservedKeys, ...newKeys].sort())
  assert.equal(await (await unrelated.match('https://example.test/pletina/index.html')).text(), 'PWA principal')
  update.network.online = false
  assert.equal(await (await update.fetch('./')).text(), second.assets.get('index.html').toString())
})

for (const failure of ['HTTP', 'integridad', 'redirección', 'red']) {
  test(`un fallo de ${failure} durante install limpia la versión parcial y conserva la activa`, async (t) => {
    const { first, second } = await buildPair(t)
    const storage = new MemoryCacheStorage()
    const active = worker(first, { storage })
    await active.dispatch('install')
    await active.dispatch('activate')
    const oldKeys = await storage.keys()
    const network = assetNetwork(second)
    network.override = (url) => {
      if (!url.endsWith('/manifest.webmanifest')) return undefined
      if (failure === 'HTTP') return new Response('No disponible', { status: 503 })
      if (failure === 'red') throw new TypeError('Sin conexión durante la descarga')
      if (failure === 'integridad') return new Response('Contenido de otra compilación')
      const redirected = new Response(second.assets.get('manifest.webmanifest'))
      Object.defineProperty(redirected, 'redirected', { value: true })
      return redirected
    }
    const update = worker(second, { storage, network })
    await assert.rejects(update.dispatch('install'), /manifest\.webmanifest|Sin conexión/)
    assert.ok(network.requests.length > 1, 'El fallo debe ocurrir después de guardar otros recursos')
    assert.deepEqual(await storage.keys(), oldKeys)
    assert.equal(update.calls.claim, 0)
    assert.equal(update.calls.skipWaiting, 0)
    active.network.online = false
    assert.equal(await (await active.fetch('./')).text(), first.assets.get('index.html').toString())
  })
}

test('si se pierde un recurso de caché, el fallback rechaza otra versión y solo repone bytes verificados', async (t) => {
  const root = await sandbox(t)
  const build = await buildAt(root, 'output')
  const active = worker(build)
  await active.dispatch('install')
  await active.dispatch('activate')
  const [key] = await active.storage.keys()
  const cache = await active.storage.open(key)
  const appURL = new URL('app.js', scope).href
  assert.equal(await cache.delete(appURL), true)
  active.network.override = (url) => url === appURL ? new Response('Aplicación de otra versión') : undefined
  await assert.rejects(active.fetch('app.js?cdn=next', { mode: 'cors' }), /Versión incompleta: app\.js/)
  assert.equal(await cache.match(appURL), undefined, 'La respuesta incompatible no debe contaminar la caché')
  assert.equal(await (await active.fetch('./')).text(), build.assets.get('index.html').toString())

  active.network.override = undefined
  const response = await active.fetch('app.js?retry=1', { mode: 'cors' })
  assert.equal(await response.text(), build.assets.get('app.js').toString())
  assert.equal(await (await cache.match(appURL)).text(), build.assets.get('app.js').toString())
  assert.deepEqual(active.network.requests.at(-1), { url: appURL, method: 'GET', cache: 'reload' })
  active.network.online = false
  const downloaded = active.network.requests.length
  assert.equal(await (await active.fetch('app.js?offline=1', { mode: 'cors' })).text(), build.assets.get('app.js').toString())
  assert.equal(active.network.requests.length, downloaded)
})

test('el worker no intercepta audio, YouTube, la PWA principal, recursos ajenos ni métodos distintos de GET', async (t) => {
  const root = await sandbox(t)
  const build = await buildAt(root, 'output')
  const active = worker(build)
  await active.dispatch('install')
  await active.dispatch('activate')
  active.network.online = false
  const downloaded = active.network.requests.length
  for (const [url, options] of [
    ['https://rr1.googlevideo.com/videoplayback?test=1', {}],
    ['https://www.youtube.com/youtubei/v1/player', { method: 'POST' }],
    ['https://other.example/pletina/prueba-audio/app.js', {}],
    ['/pletina/index.html', {}],
    ['audio.mp3', {}],
    ['unknown.html', {}],
    ['index.html', { method: 'POST' }],
    ['app.js', { method: 'HEAD' }],
  ]) {
    assert.equal(await active.fetch(url, options), undefined, `No debe interceptar ${options.method || 'GET'} ${url}`)
  }
  assert.equal(active.network.requests.length, downloaded)
})
