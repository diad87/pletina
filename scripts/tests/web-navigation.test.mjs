import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { compileModule } from 'svelte/compiler'
import * as svelte from 'svelte/internal/client'
import ts from 'typescript'
import { initWebNavigation } from '../../web-port/navigation.ts'

const source = await readFile(new URL('../../src/lib/nav.svelte.ts', import.meta.url), 'utf8')
const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText
const compiled = ts.transpileModule(compileModule(javascript, { filename: 'nav.svelte.js' }).js.code, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText
function navigation() {
  const exports = {}
  new Function('exports', 'require', compiled)(exports, (name) => name === 'svelte' ? { untrack: (fn) => fn() } : svelte)
  return exports.nav
}
function browser() {
  const window = new EventTarget(), items = [null], storage = new Map(), events = []
  let position = 0
  const history = {
    get state() { return structuredClone(items[position]) },
    replaceState(value, _, url) { assert.equal(url, window.location.href); items[position] = structuredClone(value) },
    pushState(value, _, url) { assert.equal(url, window.location.href); items.splice(position + 1); items.push(structuredClone(value)); position++ },
    back() { if (position > 0) { position--; events.push(items[position]) } },
    forward() { if (position < items.length - 1) { position++; events.push(items[position]) } },
    go(delta) { const target = position + delta; if (target >= 0 && target < items.length) { position = target; events.push(items[position]) } },
  }
  Object.assign(window, { history, location: { href: 'https://example.test/pletina/application/index.hash.html' },
    sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } })
  return { window, items, get position() { return position }, flush() {
    while (events.length) { const event = new Event('popstate'); Object.defineProperty(event, 'state', { value: structuredClone(events.shift()) }); window.dispatchEvent(event) }
  } }
}
function setup() { const nav = navigation(), h = browser(); const dispose = initWebNavigation(nav, h.window); return { nav, h, dispose } }

test('native navigation remains synchronous without installing browser history', () => {
  const nav = navigation()
  nav.go({ name: 'search', query: 'Creep' }); nav.go({ name: 'artist', id: 1 })
  nav.back(); assert.deepEqual(nav.route, { name: 'search', query: 'Creep' })
  nav.forward(); assert.equal(nav.route.name, 'artist')
})
test('Android/browser Back and Forward move the app without changing its URL', () => {
  const { nav, h } = setup()
  nav.go({ name: 'search', query: '' }); nav.replace({ name: 'search', query: 'Radiohead Creep' })
  nav.go({ name: 'album', id: 12 })
  assert.equal(h.items.length, 3, 'typing must replace the current history entry')
  h.window.history.back(); h.flush(); assert.deepEqual(nav.route, { name: 'search', query: 'Radiohead Creep' })
  nav.back(); h.flush(); assert.equal(nav.route.name, 'home')
  nav.forward(); h.flush(); assert.equal(nav.route.query, 'Radiohead Creep')
  nav.forward(); h.flush(); assert.equal(nav.route.name, 'album')
})
test('a branch after Back discards old Forward routes coherently', () => {
  const { nav, h } = setup()
  nav.go({ name: 'search', query: 'A' }); nav.go({ name: 'artist', id: 1 }); nav.back(); h.flush()
  nav.go({ name: 'podcasts', query: 'Ciencia' })
  assert.equal(nav.canForward, false)
  h.window.history.back(); h.flush(); h.window.history.forward(); h.flush()
  assert.equal(nav.route.name, 'podcasts')
  assert.equal(h.items.length, 3)
})
test('Back closes a custom overlay first, then returns to the previous route', () => {
  const { nav, h } = setup()
  nav.go({ name: 'search', query: 'Creep' })
  let open = true, closes = 0
  nav.overlay(true, () => { open = false; closes++; return true })
  h.window.history.back(); h.flush()
  nav.overlay(false, () => false)
  assert.equal(open, false); assert.equal(closes, 1); assert.equal(nav.route.name, 'search')
  h.window.history.back(); h.flush(); assert.equal(nav.route.name, 'home')
  nav.forward(); h.flush(); assert.equal(nav.route.name, 'search')
})
test('an overlay on Home consumes Back without leaving the installed app', () => {
  const { nav, h } = setup()
  let closes = 0
  nav.overlay(true, () => { closes++; return true })
  h.window.history.back(); h.flush()
  assert.equal(closes, 1); assert.equal(nav.route.name, 'home'); assert.equal(h.position, 0)
})
test('closing an overlay then navigating before popstate does not lose the route', () => {
  const { nav, h } = setup()
  nav.go({ name: 'library' })
  nav.overlay(true, () => true)
  nav.overlay(false, () => false)
  nav.go({ name: 'downloads' }); h.flush()
  assert.equal(nav.route.name, 'downloads')
  nav.back(); h.flush(); assert.equal(nav.route.name, 'library')
  nav.back(); h.flush(); assert.equal(nav.route.name, 'home')
})
test('navigating directly from a menu replaces its guard instead of adding a phantom Back', () => {
  const { nav, h } = setup()
  nav.go({ name: 'search', query: 'Creep' }); nav.overlay(true, () => true)
  nav.go({ name: 'artist', id: 12 }); nav.overlay(false, () => false)
  assert.equal(h.items.length, 3)
  nav.back(); h.flush(); assert.equal(nav.route.name, 'search')
})
test('reload restores the current query and both navigation directions from the same session', () => {
  const { nav, h, dispose } = setup()
  nav.go({ name: 'search', query: 'Radiohead Creep' }); nav.go({ name: 'album', id: 12 }); nav.back(); h.flush(); dispose()
  const reloaded = navigation(); initWebNavigation(reloaded, h.window)
  assert.deepEqual(reloaded.route, { name: 'search', query: 'Radiohead Creep' })
  assert.equal(reloaded.canForward, true)
  reloaded.forward(); h.flush(); assert.equal(reloaded.route.name, 'album')
  reloaded.back(); h.flush(); reloaded.back(); h.flush(); assert.equal(reloaded.route.name, 'home')
})
test('reload with an open overlay consumes its temporary entry without a phantom Back', () => {
  const { nav, h, dispose } = setup()
  nav.go({ name: 'search', query: 'Creep' }); nav.overlay(true, () => true); dispose()
  const reloaded = navigation(); initWebNavigation(reloaded, h.window); h.flush()
  assert.equal(reloaded.route.name, 'search')
  reloaded.back(); h.flush(); assert.equal(reloaded.route.name, 'home')
})
test('opening and closing an overlay after Back preserves the existing Forward route', () => {
  for (const physicalBack of [true, false]) {
    const { nav, h } = setup()
    nav.go({ name: 'search', query: 'Creep' }); nav.go({ name: 'album', id: 12 }); nav.back(); h.flush()
    nav.overlay(true, () => true)
    if (physicalBack) h.window.history.back()
    else nav.overlay(false, () => false)
    h.flush()
    assert.equal(nav.route.name, 'search'); assert.equal(nav.canForward, true)
    nav.forward(); h.flush(); assert.equal(nav.route.name, 'album')
    nav.back(); h.flush(); nav.back(); h.flush(); assert.equal(nav.route.name, 'home')
  }
})
test('rapid overlay reopen/close cancels obsolete queued guards', () => {
  const { nav, h } = setup()
  nav.go({ name: 'library' })
  nav.overlay(true, () => true); nav.overlay(false, () => false)
  nav.overlay(true, () => true); nav.overlay(false, () => false)
  h.flush()
  nav.back(); h.flush(); assert.equal(nav.route.name, 'home')
})
