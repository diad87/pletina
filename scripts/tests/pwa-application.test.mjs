import assert from 'node:assert/strict'
import { createHash, webcrypto } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { buildPwa, sourceDirectory } from '../build-pwa.mjs'

const scope = 'https://example.test/pletina/'
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const copy = (value) => JSON.parse(JSON.stringify(value))

async function fixture(t) {
  const parent = resolve(tmpdir())
  const root = await mkdtemp(join(parent, 'pletina-application-tests-'))
  t.after(async () => {
    assert.equal(dirname(resolve(root)), parent)
    assert.match(basename(root), /^pletina-application-tests-/)
    await rm(root, { recursive: true, force: true })
  })
  const source = join(root, 'source')
  const application = join(root, 'vite')
  await cp(sourceDirectory, source, { recursive: true })
  // En modo aplicación debe desaparecer incluso un recurso legacy sin declarar.
  await mkdir(join(source, 'player'), { recursive: true })
  await writeFile(join(source, 'player', 'legacy-fixture.bin'), 'No publicar')
  await writeApplication(application, 'primera')
  return { root, source, application }
}

async function writeApplication(directory, version) {
  const chunk = Buffer.from(`export const release=${JSON.stringify(version)};\n`)
  const chunkName = `chunk.${sha256(chunk).slice(0, 8)}.js`
  const javascript = Buffer.from(`import {release} from './${chunkName}'; document.body.dataset.release=release;\n`)
  const scriptName = `main.${sha256(javascript).slice(0, 8)}.js`
  const font = Buffer.from([119, 79, 70, 50, 0, 255, 128, 12, ...Buffer.from(version)])
  const fontName = `font.${sha256(font).slice(0, 8)}.woff2`
  const css = Buffer.from(`@font-face{font-family:test;src:url('./${fontName}')}body{font-family:test}\n`)
  const cssName = `style.${sha256(css).slice(0, 8)}.css`
  const html = Buffer.from(`<!doctype html><html><head><link rel="stylesheet" href="./assets/${cssName}"><script type="module" src="./assets/${scriptName}"></script></head><body>Pletina ${version}</body></html>`)
  const assets = new Map([
    ['index.html', html], [`assets/${chunkName}`, chunk], [`assets/${scriptName}`, javascript],
    [`assets/${cssName}`, css], [`assets/${fontName}`, font],
  ])
  for (const [name, bytes] of assets) {
    await mkdir(dirname(join(directory, name)), { recursive: true })
    await writeFile(join(directory, name), bytes)
  }
  return assets
}

async function readTree(directory, base = directory) {
  const assets = new Map()
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      for (const item of await readTree(path, base)) assets.set(...item)
    } else if (entry.isFile()) {
      assets.set(relative(base, path).split(sep).join('/'), await readFile(path))
    }
  }
  return assets
}

async function buildAt(fixture, name, application = fixture.application) {
  const output = join(fixture.root, name)
  const result = await buildPwa({ source: fixture.source, output, application })
  return { ...result, output, assets: await readTree(output) }
}

const requestKey = (request) => typeof request === 'string' ? request : request.url
class MemoryCache {
  entries = new Map()
  async put(request, response) { this.entries.set(requestKey(request), response.clone()) }
  async match(request) { return this.entries.get(requestKey(request))?.clone() }
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
    online: true, requests: [], override: undefined,
    async fetch(request) {
      const url = requestKey(request)
      this.requests.push({ url, cache: request.cache, method: request.method || 'GET' })
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
  const metadata = runInNewContext(`${build.assets.get('sw.js')}\n;({required: FILES, optional: OPTIONAL});`, {
    self: {
      registration: { scope: base },
      addEventListener(type, callback) {
        if (!handlers.has(type)) handlers.set(type, [])
        handlers.get(type).push(callback)
      },
      clients: { async claim() { calls.claim++ } },
      async skipWaiting() { calls.skipWaiting++ },
    },
    caches: storage, fetch: network.fetch.bind(network), crypto: webcrypto,
    URL, Request, Response, Uint8Array,
  }, { filename: 'built-application-sw.js' })
  const api = {
    storage, network, calls, metadata: copy(metadata),
    async dispatch(type, properties = {}) {
      const promises = []
      assert.ok(handlers.has(type), `Falta el manejador ${type}`)
      for (const callback of handlers.get(type)) {
        callback({ ...properties, waitUntil(promise) { promises.push(Promise.resolve(promise)) } })
      }
      await Promise.all(promises)
    },
    async prepare() {
      const replies = []
      await api.dispatch('message', { data: { type: 'PREPARE_APPLICATION' }, ports: [{ postMessage(value) { replies.push(copy(value)) } }] })
      assert.equal(replies.length, 1, 'El puerto debe recibir una respuesta al preparar la aplicación')
      return replies[0]
    },
    async fetch(path, { mode = 'cors', method = 'GET' } = {}) {
      const request = { url: new URL(path, base).href, mode, method }
      let response
      let count = 0
      for (const callback of handlers.get('fetch') || []) {
        callback({ request, respondWith(promise) { count++; response = Promise.resolve(promise) } })
      }
      assert.ok(count <= 1)
      return response ? await response : undefined
    },
  }
  return api
}

async function withLauncher(build, active, execute) {
  const name = build.optionalFiles.find((path) => /^application\/launcher\.[a-f0-9]{16}\.js$/.test(path))
  assert.ok(name)
  await active.fetch(name)
  const scriptURL = pathToFileURL(join(build.output, name))
  const localBase = new URL('./', scriptURL)
  const module = await import(scriptURL.href)
  const originalFetch = globalThis.fetch
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location')
  const navigations = []
  globalThis.fetch = (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    assert.ok(url.href.startsWith(localBase.href))
    const path = decodeURIComponent(url.href.slice(localBase.href.length))
    return active.fetch(`application/${path}`)
  }
  const navigate = (url) => { navigations.push(new URL(url)) }
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { assign: navigate, replace: navigate } })
  try { return await execute(() => module.mountPlayer(), navigations) }
  finally {
    globalThis.fetch = originalFetch
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation)
    else delete globalThis.location
  }
}

test('el build conserva la entrada mínima y publica el grafo Vite completo como opcional con SHA correctos', async (t) => {
  const source = await fixture(t)
  const first = await buildAt(source, 'first')
  const second = await buildAt(source, 'second')
  assert.equal(first.version, second.version)
  assert.deepEqual([...first.assets].map(([name, bytes]) => [name, sha256(bytes)]), [...second.assets].map(([name, bytes]) => [name, sha256(bytes)]))
  assert.match(first.applicationPage, /^application\/index\.[a-f0-9]{16}\.html$/)
  assert.ok(first.applicationPage.includes(sha256(first.assets.get(first.applicationPage)).slice(0, 16)))
  assert.equal([...first.assets.keys()].some((name) => name.startsWith('player/')), false)
  assert.equal(first.assets.has('application/index.html'), false)
  const optional = first.optionalFiles
  assert.equal(optional.length, 6)
  assert.ok(optional.every((name) => name.startsWith('application/')))
  assert.ok(optional.some((name) => name.endsWith('.css')))
  assert.ok(optional.some((name) => name.endsWith('.woff2')))
  const launcher = optional.find((name) => name.includes('/launcher.'))
  assert.ok(launcher.includes(sha256(first.assets.get(launcher)).slice(0, 16)))
  const shell = [...first.assets.keys()].find((name) => /^app\..+\.js$/.test(name))
  assert.ok(first.assets.get(shell).toString().includes(`./${launcher}`))
  const active = worker(first)
  assert.deepEqual(active.metadata.optional.map((file) => file.url).sort(), [...optional].sort())
  for (const file of [...active.metadata.required, ...active.metadata.optional]) assert.equal(file.sha256, sha256(first.assets.get(file.url)))
  assert.equal(active.metadata.required.some((file) => file.url.startsWith('application/')), false)
  assert.equal(first.bytes - first.initialBytes, optional.reduce((sum, name) => sum + first.assets.get(name).length, 0))
})

test('instalar y activar la PWA no solicita ni necesita los archivos de la aplicación', async (t) => {
  const build = await buildAt(await fixture(t), 'output')
  const active = worker(build)
  active.network.override = (url) => { if (url.includes('/application/')) throw new Error('Aplicación no disponible') }
  await active.dispatch('install')
  await active.dispatch('activate')
  assert.equal(active.network.requests.some((request) => request.url.includes('/application/')), false)
  const [key] = await active.storage.keys()
  const cache = await active.storage.open(key)
  for (const name of build.optionalFiles) assert.equal(await cache.match(new URL(name, scope).href), undefined)
  active.network.online = false
  assert.equal(await (await active.fetch('./', { mode: 'navigate' })).text(), build.assets.get('index.html').toString())
})

test('cada archivo opcional pedido se verifica y después se sirve offline, incluidos CSS y fuentes binarias', async (t) => {
  const build = await buildAt(await fixture(t), 'output')
  const active = worker(build)
  await active.dispatch('install')
  await active.dispatch('activate')
  const before = active.network.requests.length
  for (const name of build.optionalFiles) {
    const response = await active.fetch(`${name}?first=1`)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), build.assets.get(name))
    assert.deepEqual(active.network.requests.at(-1), { url: new URL(name, scope).href, cache: 'reload', method: 'GET' })
  }
  assert.equal(active.network.requests.length - before, build.optionalFiles.length)
  active.network.online = false
  const downloaded = active.network.requests.length
  for (const name of build.optionalFiles) assert.deepEqual(Buffer.from(await (await active.fetch(name)).arrayBuffer()), build.assets.get(name))
  assert.equal(active.network.requests.length, downloaded)
})

test('el launcher espera todos los recursos verificados antes de navegar a la página publicada', async (t) => {
  const build = await buildAt(await fixture(t), 'output')
  const active = worker(build)
  await active.dispatch('install')
  await active.dispatch('activate')
  const font = build.optionalFiles.find((name) => name.endsWith('.woff2'))
  let release
  let started
  const reachedFont = new Promise((resolve) => { started = resolve })
  active.network.override = (url) => {
    if (url === new URL(font, scope).href) {
      started()
      return new Promise((resolve) => { release = () => resolve(new Response(build.assets.get(font))) })
    }
  }
  await withLauncher(build, active, async (mount, navigations) => {
    const mounting = mount()
    await reachedFont
    assert.deepEqual(navigations, [])
    release()
    await mounting
    assert.equal(navigations.length, 1)
    assert.equal(basename(navigations[0].pathname), basename(build.applicationPage))
  })
  const [key] = await active.storage.keys()
  const cache = await active.storage.open(key)
  for (const name of build.optionalFiles) assert.ok(await cache.match(new URL(name, scope).href), `Falta ${name}`)
})

test('el launcher no navega si un recurso de la aplicación falla la comprobación de integridad', async (t) => {
  const build = await buildAt(await fixture(t), 'output')
  const active = worker(build)
  await active.dispatch('install')
  await active.dispatch('activate')
  const css = build.optionalFiles.find((name) => name.endsWith('.css'))
  active.network.override = (url) => url === new URL(css, scope).href ? new Response('CSS de otra versión') : undefined
  await withLauncher(build, active, async (mount, navigations) => {
    await assert.rejects(mount(), /Versión incompleta/)
    assert.deepEqual(navigations, [])
  })
  const [key] = await active.storage.keys()
  assert.equal(await (await active.storage.open(key)).match(new URL(css, scope).href), undefined)
  assert.equal(active.calls.skipWaiting, 0)
  assert.equal(await (await active.fetch('./', { mode: 'navigate' })).text(), build.assets.get('index.html').toString())
})

test('el waiting worker prepara toda la aplicación antes de activar sin interrumpir la versión actual', async (t) => {
  const source = await fixture(t)
  const first = await buildAt(source, 'first')
  const application2 = join(source.root, 'vite-second')
  await writeApplication(application2, 'segunda')
  const second = await buildAt(source, 'second', application2)
  assert.notEqual(first.version, second.version)
  assert.notEqual(first.applicationPage, second.applicationPage)
  const storage = new MemoryCacheStorage()
  const active = worker(first, { storage })
  await active.dispatch('install')
  await active.dispatch('activate')
  assert.deepEqual(await active.prepare(), { ok: true })
  const [oldKey] = await storage.keys()
  await worker(first, { storage, base: 'https://example.test/pletina-other/' }).dispatch('install')
  await storage.open('pletina-screen-off:otra-prueba')
  const preserved = (await storage.keys()).filter((key) => key !== oldKey)
  const waiting = worker(second, { storage })
  await waiting.dispatch('install')
  assert.equal(waiting.network.requests.some((request) => request.url.includes('/application/')), false)
  const [newKey] = (await storage.keys()).filter((key) => key !== oldKey && !preserved.includes(key))
  const staging = await storage.open(newKey)
  assert.deepEqual(await waiting.prepare(), { ok: true })
  for (const name of second.optionalFiles) assert.ok(await staging.match(new URL(name, scope).href))
  assert.equal(waiting.calls.skipWaiting, 0)
  assert.equal(waiting.calls.claim, 0)
  assert.ok((await storage.keys()).includes(oldKey))
  active.network.online = false
  assert.equal(await (await active.fetch(first.applicationPage, { mode: 'navigate' })).text(), first.assets.get(first.applicationPage).toString())
  await waiting.dispatch('message', { data: { type: 'ACTIVATE_UPDATE' } })
  assert.equal(waiting.calls.skipWaiting, 1)
  await waiting.dispatch('activate')
  assert.deepEqual((await storage.keys()).sort(), [...preserved, newKey].sort())
  waiting.network.online = false
  assert.equal(await (await waiting.fetch(second.applicationPage, { mode: 'navigate' })).text(), second.assets.get(second.applicationPage).toString())
  const redirect = await waiting.fetch(`${first.applicationPage}?old=1`, { mode: 'navigate' })
  assert.equal(redirect.status, 302)
  assert.equal(redirect.headers.get('location'), new URL('?open=app', scope).href)
})

for (const failure of ['HTTP', 'integridad', 'redirección']) {
  test(`preparar una actualización con fallo de ${failure} conserva la activa, responde false y permite reintentar`, async (t) => {
    const source = await fixture(t)
    const first = await buildAt(source, 'first')
    const application2 = join(source.root, 'vite-second')
    await writeApplication(application2, 'segunda')
    const second = await buildAt(source, 'second', application2)
    const storage = new MemoryCacheStorage()
    const active = worker(first, { storage })
    await active.dispatch('install')
    await active.dispatch('activate')
    await active.prepare()
    const [oldKey] = await storage.keys()
    const waiting = worker(second, { storage })
    await waiting.dispatch('install')
    const target = new URL(second.applicationPage, scope).href
    waiting.network.override = (url) => {
      if (url !== target) return undefined
      if (failure === 'HTTP') return new Response('No disponible', { status: 503 })
      if (failure === 'integridad') return new Response('HTML de otra versión')
      const redirected = new Response(second.assets.get(second.applicationPage))
      Object.defineProperty(redirected, 'redirected', { value: true })
      return redirected
    }
    assert.deepEqual(await waiting.prepare(), { ok: false })
    assert.equal(waiting.calls.skipWaiting, 0)
    assert.equal(waiting.calls.claim, 0)
    assert.ok((await storage.keys()).includes(oldKey))
    const [newKey] = (await storage.keys()).filter((key) => key !== oldKey)
    assert.equal(await (await storage.open(newKey)).match(target), undefined)
    active.network.online = false
    assert.equal(await (await active.fetch(first.applicationPage, { mode: 'navigate' })).text(), first.assets.get(first.applicationPage).toString())
    waiting.network.override = undefined
    assert.deepEqual(await waiting.prepare(), { ok: true })
    assert.ok(await (await storage.open(newKey)).match(target))
    assert.equal(waiting.calls.skipWaiting, 0)
  })
}

test('el redirect de una página antigua y la caché se limitan al origen, ámbito, navegación y GET esperados', async (t) => {
  const build = await buildAt(await fixture(t), 'output')
  const active = worker(build)
  await active.dispatch('install')
  await active.dispatch('activate')
  active.network.online = false
  const before = active.network.requests.length
  const stale = 'application/index.0000000000000000.html'
  for (const [url, options] of [
    [new URL(stale, 'https://other.example/pletina/').href, { mode: 'navigate' }],
    [new URL(stale, 'https://example.test/pletina-other/').href, { mode: 'navigate' }],
    [stale, { mode: 'cors' }],
    [stale, { mode: 'navigate', method: 'POST' }],
    [build.applicationPage, { method: 'HEAD' }],
    ['application/index.not-a-build.html', { mode: 'navigate' }],
    ['application/assets/unknown.js', {}],
    ['https://rr1.googlevideo.com/videoplayback?test=1', {}],
  ]) {
    assert.equal(await active.fetch(url, options), undefined, `No debe interceptar ${options.method || 'GET'} ${url}`)
  }
  const redirect = await active.fetch(stale, { mode: 'navigate' })
  assert.equal(redirect.status, 302)
  assert.equal(redirect.headers.get('location'), new URL('?open=app', scope).href)
  assert.equal(active.network.requests.length, before)
})

test('el build rechaza una aplicación sin index.html sin producir una salida parcial', async (t) => {
  const source = await fixture(t)
  await rm(join(source.application, 'index.html'))
  const output = join(source.root, 'invalid')
  await assert.rejects(buildPwa({ source: source.source, output, application: source.application }), /aplicación web compilada/)
  await assert.rejects(stat(output), { code: 'ENOENT' })
})
