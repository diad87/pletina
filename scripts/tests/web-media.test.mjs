import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
import coverRouting from '../../pwa/cover-routing.mjs'

const source = await readFile(new URL('../../src/lib/media.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText
const image = 'https://images.example/cover.png'
function media({ href = 'https://app.example/pletina/application/index.1234567890abcdef.html', manifest = '../manifest.webmanifest',
  controller, pwa = true, native = false } = {}) {
  const exports = {}, converted = []
  const modules = { './api': { inPwa: pwa, inTauri: native }, '../../pwa/cover-routing.mjs': { __esModule: true, default: coverRouting },
    '@tauri-apps/api/core': { convertFileSrc(value) { converted.push(value); return 'asset://' + value } } }
  const document = { querySelector() { return manifest === null ? null : { href: new URL(manifest, href).href } } }
  new Function('require', 'exports', 'window', 'document', 'navigator', compiled)(
    name => { assert.ok(name in modules, 'Unknown module: ' + name); return modules[name] }, exports,
    { location: { href } }, document, { serviceWorker: controller ? { controller: { scriptURL: controller } } : {} })
  return { ...exports, converted }
}

test('PWA media URLs use the same manifest root from the installer and hashed application document', () => {
  for (const [href, manifest, expected] of [
    ['https://app.example/pletina/', './manifest.webmanifest', 'https://app.example/pletina/'],
    ['https://app.example/pletina/application/index.1234567890abcdef.html', '../manifest.webmanifest', 'https://app.example/pletina/'],
    ['https://app.example/nested/project/application/index.html?view=library', '../manifest.webmanifest', 'https://app.example/nested/project/'],
  ]) {
    const helper = media({ href, manifest }), local = helper.mediaUrl(image)
    assert.equal(local, coverRouting(expected).local(image)); assert.equal(helper.mediaUrl(local), local)
  }
})

test('PWA root falls back to its own controller and known document layout without using an alien manifest', () => {
  const expected = coverRouting('https://app.example/pletina/').local(image)
  for (const manifest of [null, 'https://alien.example/manifest.webmanifest']) {
    assert.equal(media({ manifest, controller: 'https://app.example/pletina/sw.js' }).mediaUrl(image), expected)
    assert.equal(media({ manifest }).mediaUrl(image), expected)
  }
  assert.equal(media({ href: 'https://app.example/pletina/', manifest: null }).mediaUrl(image), expected)
})

test('PWA leaves unsupported existing image protocols and signed URLs intact and never double-wraps a local route', () => {
  const helper = media()
  for (const value of [null, '', 'data:image/png;base64,abc', 'blob:https://app.example/id', 'asset://cover', 'http://images.example/a',
    image + '?sig=token', 'https://']) assert.equal(helper.mediaUrl(value), value || null)
  const local = helper.mediaUrl(image)
  assert.equal(helper.mediaUrl(local), local)
  assert.equal(helper.mediaUrl(local + '&url=' + encodeURIComponent(image)), null)
})

test('native and development image URLs retain their previous conversion behavior', () => {
  const native = media({ pwa: false, native: true })
  assert.equal(native.mediaUrl(image), image)
  assert.equal(native.mediaUrl('/private/cover.png'), 'asset:///private/cover.png')
  assert.deepEqual(native.converted, ['/private/cover.png'])
  const dev = media({ pwa: false })
  assert.equal(dev.mediaUrl(image), image); assert.equal(dev.mediaUrl('/cover.png'), '/cover.png')
})
