import assert from 'node:assert/strict'
import { createHash, webcrypto } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { buildPwa, sourceDirectory } from '../build-pwa.mjs'

const scope = 'https://example.test/pletina/'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const snapshot = (files) => [...files].map(([name, bytes]) => [name, hash(bytes)])
  .sort(([a], [b]) => a.localeCompare(b))

async function sandbox(t) {
  const parent = resolve(tmpdir())
  const root = await mkdtemp(join(parent, 'pletina-optional-tests-'))
  t.after(async () => {
    assert.equal(dirname(resolve(root)), parent)
    assert.match(basename(root), /^pletina-optional-tests-/)
    await rm(root, { recursive: true, force: true })
  })
  return root
}

async function fixture(t) {
  const root = await sandbox(t)
  const source = join(root, 'source')
  // El contrato del grafo se prueba con módulos pequeños propios, sin ejecutar
  // el reproductor ni copiar módulos que otro trabajo pueda estar editando.
  await cp(sourceDirectory, source, {
    recursive: true,
    filter: (path) => {
      const name = relative(sourceDirectory, path)
      return name !== 'player' && !name.startsWith(`player${sep}`)
    },
  })
  await mkdir(join(source, 'player'))
  await writeFile(join(source, 'player', 'resolver.mjs'), "export const resolveAudio = (id) => 'version-1:' + id;\n")
  await writeFile(join(source, 'player', 'entry.mjs'), "import { resolveAudio } from './resolver.mjs';\nexport const mountPlayer = () => resolveAudio('fixture');\n")
  return { root, source }
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

async function buildAt({ root, source }, name) {
  const output = join(root, name)
  const result = await buildPwa({ source, output })
  return { ...result, output, assets: await readTree(output) }
}

function moduleNames(build) {
  const entry = build.optionalFiles.find((name) => /^player\/entry\.[a-f0-9]{16}\.js$/.test(name))
  const resolver = build.optionalFiles.find((name) => /^player\/resolver\.[a-f0-9]{16}\.js$/.test(name))
  const app = [...build.assets.keys()].find((name) => /^app\.[a-f0-9]{16}\.js$/.test(name))
  assert.ok(entry)
  assert.ok(resolver)
  assert.ok(app)
  return { entry, resolver, app }
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
  runInNewContext(build.assets.get('sw.js').toString(), {
    self: {
      registration: { scope: base },
      addEventListener(type, handler) {
        if (!handlers.has(type)) handlers.set(type, [])
        handlers.get(type).push(handler)
      },
      clients: { async claim() { calls.claim++ } },
      async skipWaiting() { calls.skipWaiting++ },
    },
    caches: storage, fetch: network.fetch.bind(network), crypto: webcrypto,
    URL, Request, Response, Uint8Array,
  }, { filename: 'built-optional-pwa-sw.js' })
  return {
    storage, network, calls,
    async dispatch(type, properties = {}) {
      const promises = []
      assert.ok(handlers.has(type), `Falta el manejador ${type}`)
      for (const handler of handlers.get(type)) {
        handler({ ...properties, waitUntil(promise) { promises.push(Promise.resolve(promise)) } })
      }
      await Promise.all(promises)
    },
    async fetch(path, { method = 'GET', mode = 'cors' } = {}) {
      const request = { url: new URL(path, base).href, method, mode }
      let response
      let count = 0
      for (const handler of handlers.get('fetch') || []) {
        handler({ request, respondWith(promise) { count++; response = Promise.resolve(promise) } })
      }
      assert.ok(count <= 1)
      return response ? await response : undefined
    },
  }
}

test('el build publica un grafo determinista con hashes calculados después de reescribir imports', async (t) => {
  const source = await fixture(t)
  const first = await buildAt(source, 'first')
  const second = await buildAt(source, 'second')
  assert.equal(first.version, second.version)
  assert.deepEqual(snapshot(first.assets), snapshot(second.assets))
  assert.equal(first.optionalFiles.length, 2)
  const { entry, resolver, app } = moduleNames(first)
  for (const name of [entry, resolver, app]) {
    assert.ok(name.includes(hash(first.assets.get(name)).slice(0, 16)), `El nombre debe representar los bytes finales de ${name}`)
  }
  assert.ok(first.assets.get(entry).toString().includes(`'./${basename(resolver)}'`))
  assert.doesNotMatch(first.assets.get(entry).toString(), /\.\/resolver\.mjs/)
  assert.ok(first.assets.get(app).toString().includes(`'./${entry}'`))
  assert.doesNotMatch(first.assets.get(app).toString(), /\.\/player\/entry\.mjs/)
  assert.equal(first.assets.has('player/entry.mjs'), false)
  assert.equal(first.assets.has('player/resolver.mjs'), false)
  const optionalBytes = first.optionalFiles.reduce((sum, name) => sum + first.assets.get(name).length, 0)
  assert.equal(first.bytes - first.initialBytes, optionalBytes)
  // Node resuelve el import real del módulo de prueba publicado y su dependencia.
  const published = await import(pathToFileURL(join(first.output, entry)).href)
  assert.equal(published.mountPlayer(), 'version-1:fixture')
})

test('los módulos reales se publican como opcionales y su grafo se puede importar sin iniciar reproducción', async (t) => {
  const root = await sandbox(t)
  const build = await buildAt({ root, source: sourceDirectory }, 'output')
  assert.equal(build.optionalFiles.length, 2)
  const { entry, resolver, app } = moduleNames(build)
  for (const name of [entry, resolver, app]) assert.ok(name.includes(hash(build.assets.get(name)).slice(0, 16)))
  assert.ok(build.assets.get(entry).toString().includes(basename(resolver)))
  assert.ok(build.assets.get(app).toString().includes(entry))
  const published = await import(pathToFileURL(join(build.output, entry)).href)
  assert.equal(typeof published.mountPlayer, 'function')
  const active = worker(build)
  await active.dispatch('install')
  const initialRequests = active.network.requests.length
  for (const name of build.optionalFiles) {
    assert.equal(active.network.requests.some((request) => request.url === new URL(name, scope).href), false)
    assert.equal(await (await active.fetch(name)).text(), build.assets.get(name).toString())
  }
  assert.equal(active.network.requests.length, initialRequests + 2)
})

test('la instalación y la activación no descargan opcionales aunque no estén disponibles', async (t) => {
  const source = await fixture(t)
  const build = await buildAt(source, 'output')
  const active = worker(build)
  active.network.override = (url) => {
    if (build.optionalFiles.some((name) => url === new URL(name, scope).href)) throw new Error('Los módulos opcionales no están publicados')
  }
  await active.dispatch('install')
  await active.dispatch('activate')
  const [key] = await active.storage.keys()
  const cache = await active.storage.open(key)
  for (const name of build.optionalFiles) {
    const url = new URL(name, scope).href
    assert.equal(active.network.requests.some((request) => request.url === url), false)
    assert.equal(await cache.match(url), undefined)
  }
  active.network.online = false
  const response = await active.fetch('./', { mode: 'navigate' })
  assert.equal(await response.text(), build.assets.get('index.html').toString())
  assert.equal(active.calls.claim, 1)
})

test('cada módulo se descarga y verifica al pedirlo y se puede volver a abrir offline', async (t) => {
  const source = await fixture(t)
  const build = await buildAt(source, 'output')
  const { entry, resolver } = moduleNames(build)
  const active = worker(build)
  await active.dispatch('install')
  await active.dispatch('activate')
  const initialRequests = active.network.requests.length
  for (const name of [entry, resolver]) {
    const response = await active.fetch(`${name}?first=1`)
    assert.equal(await response.text(), build.assets.get(name).toString())
    assert.deepEqual(active.network.requests.at(-1), { url: new URL(name, scope).href, method: 'GET', cache: 'reload' })
  }
  assert.equal(active.network.requests.length, initialRequests + 2)
  active.network.online = false
  const downloaded = active.network.requests.length
  for (const name of [entry, resolver]) {
    assert.equal(await (await active.fetch(`${name}?offline=1`)).text(), build.assets.get(name).toString())
  }
  assert.equal(active.network.requests.length, downloaded)
})

for (const failure of ['HTTP', 'integridad', 'redirección']) {
  test(`un opcional con fallo de ${failure} se rechaza sin contaminar la caché ni perder la instalación`, async (t) => {
    const source = await fixture(t)
    const build = await buildAt(source, 'output')
    const { entry } = moduleNames(build)
    const active = worker(build)
    await active.dispatch('install')
    await active.dispatch('activate')
    const oldKeys = await active.storage.keys()
    const cache = await active.storage.open(oldKeys[0])
    const cachedBefore = [...cache.entries.keys()].sort()
    const entryURL = new URL(entry, scope).href
    active.network.override = (url) => {
      if (url !== entryURL) return undefined
      if (failure === 'HTTP') return new Response('No disponible', { status: 503 })
      if (failure === 'integridad') return new Response('Código de otra versión')
      const redirected = new Response(build.assets.get(entry))
      Object.defineProperty(redirected, 'redirected', { value: true })
      return redirected
    }
    await assert.rejects(active.fetch(entry), /No se pudo descargar|Versión incompleta/)
    assert.equal(await cache.match(entryURL), undefined)
    assert.deepEqual([...cache.entries.keys()].sort(), cachedBefore)
    assert.deepEqual(await active.storage.keys(), oldKeys)
    active.network.online = false
    assert.equal(await (await active.fetch('./', { mode: 'navigate' })).text(), build.assets.get('index.html').toString())
    active.network.online = true
    active.network.override = undefined
    assert.equal(await (await active.fetch(entry)).text(), build.assets.get(entry).toString())
    assert.ok(await cache.match(entryURL), 'Se debe poder reintentar con el contenido correcto')
  })
}

test('la verificación compartida también evita mezclar el shell si se pierde una entrada obligatoria', async (t) => {
  const source = await fixture(t)
  const build = await buildAt(source, 'output')
  const { app } = moduleNames(build)
  const active = worker(build)
  await active.dispatch('install')
  await active.dispatch('activate')
  const [key] = await active.storage.keys()
  const cache = await active.storage.open(key)
  const appURL = new URL(app, scope).href
  assert.equal(await cache.delete(appURL), true)
  active.network.override = (url) => url === appURL ? new Response('Shell incompatible') : undefined
  await assert.rejects(active.fetch(app), /Versión incompleta/)
  assert.equal(await cache.match(appURL), undefined)
  assert.equal(await (await active.fetch('./', { mode: 'navigate' })).text(), build.assets.get('index.html').toString())
})

test('un cambio solo en resolver propaga los hashes y la actualización conserva el scope y la carga bajo demanda', async (t) => {
  const source = await fixture(t)
  const first = await buildAt(source, 'first')
  await writeFile(join(source.source, 'player', 'resolver.mjs'), "export const resolveAudio = (id) => 'version-2:' + id;\n")
  const second = await buildAt(source, 'second')
  const oldNames = moduleNames(first)
  const newNames = moduleNames(second)
  assert.notEqual(first.version, second.version)
  for (const name of ['entry', 'resolver', 'app']) assert.notEqual(oldNames[name], newNames[name])

  const storage = new MemoryCacheStorage()
  const active = worker(first, { storage })
  await active.dispatch('install')
  await active.dispatch('activate')
  for (const name of first.optionalFiles) await active.fetch(name)
  const [oldKey] = await storage.keys()
  for (const base of ['https://example.test/pletina-other/', 'https://example.test/other/']) {
    await worker(first, { storage, base }).dispatch('install')
  }
  await storage.open('pletina-screen-off:otra-prueba')
  const preserved = (await storage.keys()).filter((key) => key !== oldKey)
  const update = worker(second, { storage })
  await update.dispatch('install')
  assert.ok((await storage.keys()).includes(oldKey))
  assert.equal(update.calls.skipWaiting, 0)
  const [newKey] = (await storage.keys()).filter((key) => key !== oldKey && !preserved.includes(key))
  const staged = await storage.open(newKey)
  for (const name of second.optionalFiles) {
    assert.equal(await staged.match(new URL(name, scope).href), undefined)
    assert.equal(update.network.requests.some((request) => request.url === new URL(name, scope).href), false)
  }
  active.network.online = false
  assert.equal(await (await active.fetch(oldNames.entry)).text(), first.assets.get(oldNames.entry).toString())
  await update.dispatch('message', { data: { type: 'ACTIVATE_UPDATE' } })
  assert.equal(update.calls.skipWaiting, 1)
  await update.dispatch('activate')
  assert.deepEqual((await storage.keys()).sort(), [...preserved, newKey].sort())
  assert.equal(await (await update.fetch(newNames.entry)).text(), second.assets.get(newNames.entry).toString())
  assert.ok(await staged.match(new URL(newNames.entry, scope).href))
})

test('solo se interceptan los GET de opcionales declarados dentro del origen y ámbito correctos', async (t) => {
  const source = await fixture(t)
  const build = await buildAt(source, 'output')
  const { entry } = moduleNames(build)
  const active = worker(build)
  await active.dispatch('install')
  await active.dispatch('activate')
  active.network.online = false
  const downloaded = active.network.requests.length
  for (const [url, options] of [
    [new URL(entry, 'https://other.example/pletina/').href, {}],
    [new URL(entry, 'https://example.test/pletina-other/').href, {}],
    ['player/entry.0000000000000000.js', {}],
    ['player/entry.mjs', {}],
    [entry, { method: 'POST' }],
    [entry, { method: 'HEAD' }],
    ['https://rr1.googlevideo.com/videoplayback?test=1', {}],
  ]) {
    assert.equal(await active.fetch(url, options), undefined, `No debe interceptar ${options.method || 'GET'} ${url}`)
  }
  assert.equal(active.network.requests.length, downloaded)
})
