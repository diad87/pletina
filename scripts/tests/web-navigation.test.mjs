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
function browser({ standalone = false, iosStandalone = false, historyLimit = Infinity, queuedTraversals = false } = {}) {
  const window = new EventTarget(), items = [null], storage = new Map(), events = []
  const traversals = []
  const document = new EventTarget()
  document.hidden = false
  const timers = new Map()
  let position = 0, departures = 0, now = 0, timerId = 0
  const performTraversal = ({ kind, delta }) => {
    const target = position + delta
    if (target >= 0 && target < items.length) { position = target; events.push(items[position]) }
    else if (kind === 'back' && position === 0) departures++
  }
  const traverse = (kind, delta) => {
    const request = { kind, delta }
    if (queuedTraversals) traversals.push(request)
    else performTraversal(request)
  }
  const history = {
    get state() { return structuredClone(items[position]) },
    get length() { return items.length },
    replaceState(value, _, url) { assert.equal(url, window.location.href); items[position] = structuredClone(value) },
    pushState(value, _, url) { assert.equal(url, window.location.href); items.splice(position + 1); items.push(structuredClone(value)); position++;
      while (items.length > historyLimit) { items.shift(); position-- } },
    back() { traverse('back', -1) },
    forward() { traverse('forward', 1) },
    go(delta) { traverse('go', delta) },
  }
  Object.assign(window, { history, document, location: { href: 'https://example.test/pletina/application/index.hash.html' },
    matchMedia: (query) => ({ matches: query === '(display-mode: standalone)' && standalone }),
    navigator: { standalone: iosStandalone },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { at: now + delay, fn }); return id },
    clearTimeout(id) { timers.delete(id) },
    sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } })
  const flushOne = () => {
    if (!events.length) return
    const event = new Event('popstate')
    Object.defineProperty(event, 'state', { value: structuredClone(events.shift()) })
    window.dispatchEvent(event)
  }
  const dueTimer = () => [...timers].find(([, timer]) => timer.at <= now)
  const flush = () => {
    let count = 0
    while (events.length || dueTimer()) {
      assert.ok(++count < 100, 'History events and due zero-delay tasks must settle')
      if (events.length) flushOne()
      else { const [id, timer] = dueTimer(); timers.delete(id); timer.fn() }
    }
  }
  return { window, items, get position() { return position }, get departures() { return departures },
    pendingTraversals: () => traversals.map(request => ({ ...request })),
    completeTraversal(index = 0) {
      assert.ok(index >= 0 && index < traversals.length, 'A pending traversal must exist before completing it')
      performTraversal(traversals.splice(index, 1)[0])
    },
    cancelTraversal(index) {
      assert.ok(index >= 0 && index < traversals.length, 'A pending traversal must exist before cancelling it')
      return traversals.splice(index, 1)[0]
    },
    setStandalone(value) { standalone = value }, flushOne, discardEvents() { events.length = 0 },
    flush,
    advance(ms) {
      const until = now + ms
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
        if (!next || next[1].at > until) break
        now = next[1].at; timers.delete(next[0]); next[1].fn(); flush()
      }
      now = until
    } }
}
function setup(options) { const nav = navigation(), h = browser(options); const dispose = initWebNavigation(nav, h.window, options); return { nav, h, dispose } }

test('native navigation remains synchronous without installing browser history', () => {
  const nav = navigation()
  nav.go({ name: 'search', query: 'Creep' }); nav.go({ name: 'artist', id: 1 })
  assert.equal(nav.viewKey, nav.index)
  nav.back(); assert.deepEqual(nav.route, { name: 'search', query: 'Creep' })
  assert.equal(nav.viewKey, nav.index)
  nav.forward(); assert.equal(nav.route.name, 'artist')
  assert.equal(nav.viewKey, nav.index)
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

test('the library backup page survives reload and returns to the existing library route', () => {
  const { nav, h, dispose } = setup()
  nav.go({ name: 'library' })
  nav.go({ name: 'library-backup' })
  dispose()
  const restored = navigation()
  const cleanup = initWebNavigation(restored, h.window)
  assert.equal(restored.route.name, 'library-backup')
  restored.back(); h.flush()
  assert.equal(restored.route.name, 'library')
  restored.forward(); h.flush()
  assert.equal(restored.route.name, 'library-backup')
  cleanup()
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

test('installed Home consumes isolated Back gestures without leaving or growing history', () => {
  let notices = 0
  const { nav, h } = setup({ standalone: true, onRootBack: () => notices++ })
  const length = h.items.length
  assert.equal(h.position, 2, 'Two guards must precede the fresh Home entry')
  for (let press = 0; press < 12; press++) {
    h.window.history.back(); h.flush()
    assert.equal(nav.route.name, 'home')
    assert.equal(h.window.history.state.rootBoundary, undefined)
    assert.equal(h.window.history.state.rootGuardDepth, 2)
    assert.equal(h.position, 2, 'Each isolated Back must re-anchor immediately, without an exit window')
  }
  assert.equal(notices, 12)
  assert.equal(h.departures, 0)
  assert.equal(h.items.length, length)
})

test('normal browser tabs can still leave Home with Back', () => {
  const { h } = setup()
  h.window.history.back(); h.flush()
  assert.equal(h.departures, 1)
  assert.equal(h.items.length, 1)
})

test('iOS standalone detection also protects Home without display-mode support', () => {
  const { nav, h } = setup({ iosStandalone: true })
  h.window.history.back(); h.flush()
  assert.equal(nav.route.name, 'home'); assert.equal(h.departures, 0)
  assert.equal(h.window.history.state.rootGuardDepth, 2); assert.equal(h.position, 2)
})

test('installed root bounce preserves previous views and the browser Forward branch', () => {
  const { nav, h } = setup({ standalone: true })
  nav.go({ name: 'search', query: 'Canción' }); nav.go({ name: 'album', id: 12 })
  h.window.history.back(); h.flush(); assert.equal(nav.route.query, 'Canción')
  h.window.history.back(); h.flush(); assert.equal(nav.route.name, 'home')
  const length = h.items.length
  h.window.history.back(); h.flush()
  assert.equal(nav.route.name, 'home'); assert.equal(nav.canForward, true)
  h.window.history.forward(); h.flush(); assert.equal(nav.route.query, 'Canción')
  h.window.history.forward(); h.flush(); assert.equal(nav.route.name, 'album')
  assert.equal(h.items.length, length); assert.equal(h.departures, 0)
})

test('installed Home overlay closes before the protected root consumes another Back', () => {
  const { nav, h } = setup({ standalone: true })
  let closes = 0
  nav.overlay(true, () => { closes++; return true })
  h.window.history.back(); h.flush()
  assert.equal(closes, 1); assert.equal(nav.route.name, 'home')
  nav.overlay(false, () => false)
  h.window.history.back(); h.flush()
  assert.equal(closes, 1); assert.equal(h.departures, 0)
})

test('reloading an installed route does not add another root boundary', () => {
  const { nav, h, dispose } = setup({ standalone: true })
  nav.go({ name: 'search', query: 'Conservada' })
  const length = h.items.length
  dispose()
  const reloaded = navigation(); initWebNavigation(reloaded, h.window); h.flush()
  assert.equal(h.items.length, length); assert.equal(reloaded.route.query, 'Conservada')
  h.window.history.back(); h.flush(); h.window.history.back(); h.flush()
  assert.equal(reloaded.route.name, 'home'); assert.equal(h.departures, 0)
})

test('legacy installed navigation gains a root boundary without losing query or Forward', () => {
  const { nav, h, dispose } = setup()
  nav.go({ name: 'search', query: 'Anterior' }); nav.go({ name: 'album', id: 12 })
  nav.back(); h.flush(); dispose(); h.setStandalone(true)
  const migrated = navigation(); initWebNavigation(migrated, h.window); h.flush()
  assert.equal(migrated.route.query, 'Anterior'); assert.equal(migrated.canForward, true)
  h.window.history.back(); h.flush(); h.window.history.back(); h.flush()
  assert.equal(migrated.route.name, 'home'); assert.equal(h.departures, 0)
  h.window.history.forward(); h.flush(); h.window.history.forward(); h.flush()
  assert.equal(migrated.route.name, 'album')
})

test('installed overlay reload after Back repairs Forward and keeps the root protected', () => {
  const { nav, h, dispose } = setup({ standalone: true })
  nav.go({ name: 'search', query: 'Podcast' }); nav.go({ name: 'album', id: 12 })
  nav.back(); h.flush(); nav.overlay(true, () => true); h.flush(); dispose()
  const reloaded = navigation(); initWebNavigation(reloaded, h.window); h.flush()
  assert.equal(reloaded.route.query, 'Podcast'); assert.equal(reloaded.canForward, true)
  h.window.history.back(); h.flush(); h.window.history.back(); h.flush()
  assert.equal(reloaded.route.name, 'home'); assert.equal(h.departures, 0)
  h.window.history.forward(); h.flush(); h.window.history.forward(); h.flush()
  assert.equal(reloaded.route.name, 'album')
})

test('navigation during a pending root bounce waits for Home before adding its route', () => {
  const { nav, h } = setup({ standalone: true })
  h.window.history.back(); h.flushOne()
  nav.go({ name: 'library' })
  h.flush()
  assert.equal(nav.route.name, 'library')
  h.window.history.back(); h.flush(); assert.equal(nav.route.name, 'home')
  h.window.history.back(); h.flush(); assert.equal(h.departures, 0)
})

test('reload while on the root boundary returns to Home and preserves Forward', () => {
  const { nav, h, dispose } = setup({ standalone: true })
  nav.go({ name: 'search', query: 'Guardada' }); nav.back(); h.flush()
  h.window.history.back(); dispose(); h.discardEvents()
  const reloaded = navigation(); initWebNavigation(reloaded, h.window); h.flush()
  assert.equal(reloaded.route.name, 'home'); assert.equal(h.window.history.state.rootBoundary, undefined)
  h.window.history.forward(); h.flush(); assert.equal(reloaded.route.query, 'Guardada')
  assert.equal(h.departures, 0)
})

test('large legacy histories migrate in a bounded batch while retaining the current route', () => {
  const h = browser({ standalone: true }), nav = navigation()
  const stack = [{ name: 'home' }, ...Array.from({ length: 100 }, (_, i) => ({ name: 'search', query: `Consulta ${i}` }))]
  h.window.history.replaceState({ pletinaNavigation: 1, session: 'legacy', index: 40, overlay: false,
    snapshot: { stack, index: 40 } }, '', h.window.location.href)
  initWebNavigation(nav, h.window); h.flush()
  assert.equal(nav.route.query, 'Consulta 39')
  assert.ok(h.items.length <= 65)
  while (nav.canBack) { nav.back(); h.flush() }
  h.window.history.back(); h.flush()
  assert.equal(nav.route.name, 'home'); assert.equal(h.departures, 0)
})

test('jumping from an installed Home overlay to the boundary closes it without a phantom Forward', () => {
  const { nav, h } = setup({ standalone: true })
  let closes = 0
  nav.overlay(true, () => { closes++; return true })
  h.window.history.go(-2); h.flush()
  assert.equal(closes, 1); assert.equal(nav.route.name, 'home')
  const length = h.items.length
  h.window.history.forward(); h.flush()
  assert.equal(nav.route.name, 'home'); assert.equal(nav.canForward, false)
  assert.equal(h.items.length, length)
  nav.overlay(false, () => false)
  nav.go({ name: 'library' }); h.flush()
  assert.equal(nav.route.name, 'library')
  h.window.history.back(); h.flush(); h.window.history.back(); h.flush()
  assert.equal(nav.route.name, 'home'); assert.equal(h.departures, 0)
})

test('jumping over routes and an overlay repairs the installed Forward branch once', () => {
  const { nav, h } = setup({ standalone: true })
  nav.go({ name: 'search', query: 'Salto' }); nav.go({ name: 'album', id: 12 }); nav.back(); h.flush()
  let closes = 0
  nav.overlay(true, () => { closes++; return true })
  h.window.history.go(-3); h.flush()
  assert.equal(closes, 1); assert.equal(nav.route.name, 'home')
  nav.overlay(false, () => false)
  h.window.history.forward(); h.flush(); assert.equal(nav.route.query, 'Salto')
  h.window.history.forward(); h.flush(); assert.equal(nav.route.name, 'album')
  assert.equal(h.position, h.items.length - 1)
  assert.equal(h.departures, 0)
})

test('large legacy overlay reload performs only the bounded root reconstruction', () => {
  const h = browser({ standalone: true }), nav = navigation()
  const stack = [{ name: 'home' }, ...Array.from({ length: 999 }, (_, i) => ({ name: 'search', query: `Q${i}` }))]
  h.window.history.replaceState({ pletinaNavigation: 1, session: 'legacy', index: 0, overlay: true,
    snapshot: { stack, index: 0 } }, '', h.window.location.href)
  let pushes = 0
  const push = h.window.history.pushState
  h.window.history.pushState = (...args) => { pushes++; push(...args) }
  initWebNavigation(nav, h.window); h.flush()
  assert.ok(pushes <= 64); assert.equal(nav.route.name, 'home')
  nav.go({ name: 'library' }); h.flush(); assert.equal(nav.route.name, 'library')
  h.window.history.back(); h.flush(); h.window.history.back(); h.flush()
  assert.equal(nav.route.name, 'home'); assert.equal(h.departures, 0)
})

test('invalid persisted entry indices and boundary flags cannot restore a broken route', () => {
  for (const corrupt of [{ index: -1 }, { index: undefined }, { index: 2 }, { index: 0, rootBoundary: true, overlay: true }]) {
    const h = browser({ standalone: true }), nav = navigation()
    h.window.history.replaceState({ pletinaNavigation: 1, session: 'legacy', overlay: false, protectedRoot: true,
      snapshot: { stack: [{ name: 'home' }], index: 0 }, ...corrupt }, '', h.window.location.href)
    initWebNavigation(nav, h.window); h.flush()
    assert.equal(nav.route.name, 'home')
    h.window.history.back(); h.flush(); assert.equal(h.departures, 0)
  }
})

test('installed overlay Back closes without pushState so browser history stays eligible for UI Back', () => {
  const { nav, h } = setup({ standalone: true })
  nav.go({ name: 'search', query: 'Adelante' }); nav.go({ name: 'album', id: 12 }); nav.back(); h.flush()
  nav.overlay(true, () => true); h.flush()
  h.window.history.pushState = () => assert.fail('Handling Back must not create entries without a user activation')
  h.window.history.back(); h.flush(); assert.equal(nav.route.query, 'Adelante')
  h.window.history.back(); h.flush(); h.window.history.back(); h.flush()
  assert.equal(nav.route.name, 'home'); assert.equal(h.departures, 0)
  h.window.history.forward(); h.flush(); assert.equal(nav.route.query, 'Adelante')
  h.window.history.forward(); h.flush(); assert.equal(nav.route.name, 'album')
})

test('installed long sessions retain a root boundary when the browser prunes old entries', () => {
  const { nav, h } = setup({ standalone: true, historyLimit: 50 })
  for (let index = 0; index < 120; index++) { nav.go({ name: 'search', query: `Búsqueda ${index}` }); h.flush() }
  assert.equal(nav.route.query, 'Búsqueda 119')
  while (nav.canBack) { h.window.history.back(); h.flush() }
  for (let index = 0; index < 4; index++) { h.window.history.back(); h.window.history.back(); h.flush() }
  assert.equal(nav.route.name, 'home'); assert.equal(h.departures, 0)
})

test('compacting installed history while opening a menu preserves its current view and callbacks', () => {
  const { nav, h } = setup({ standalone: true, historyLimit: 50 })
  for (let index = 0; index < 33; index++) { nav.go({ name: 'search', query: `Consulta ${index}` }); h.flush() }
  nav.go({ name: 'playlist', id: 3 }); h.flush()
  const index = nav.index, viewKey = nav.viewKey
  assert.equal(typeof viewKey, 'number')
  nav.overlay(true, () => true); h.flush()
  assert.ok(nav.index < index, 'Opening this menu must exercise history compaction')
  assert.equal(nav.viewKey, viewKey, 'The keyed view and its menu action closure must remain mounted')
  assert.deepEqual(nav.route, { name: 'playlist', id: 3 })
  nav.overlay(false, () => false); h.flush()
  assert.equal(nav.viewKey, viewKey, 'Closing the menu must preserve local confirmation state')
  nav.back(); h.flush()
  assert.notEqual(nav.viewKey, viewKey, 'A real route traversal must still change the keyed view')
  assert.equal(nav.route.name, 'search')
})

test('closing an installed overlay during forward preparation queues the next navigation until it settles', () => {
  const { nav, h } = setup({ standalone: true })
  nav.go({ name: 'search', query: 'Antes' }); nav.go({ name: 'album', id: 12 }); nav.back(); h.flush()
  nav.overlay(true, () => true)
  nav.overlay(false, () => false)
  nav.go({ name: 'library' }); h.flush()
  assert.equal(nav.route.name, 'library')
  h.window.history.back(); h.flush(); assert.equal(nav.route.query, 'Antes')
  h.window.history.back(); h.flush(); h.window.history.back(); h.flush()
  assert.equal(nav.route.name, 'home'); assert.equal(h.departures, 0)
})

test('choosing a destination from an installed overlay discards obsolete Forward without an extra Back', () => {
  const { nav, h } = setup({ standalone: true })
  nav.go({ name: 'search', query: 'Menú' }); nav.go({ name: 'album', id: 12 }); nav.back(); h.flush()
  nav.overlay(true, () => true); h.flush()
  nav.go({ name: 'artist', id: 7 }); nav.overlay(false, () => false); h.flush()
  assert.equal(nav.route.name, 'artist'); assert.equal(nav.canForward, false)
  h.window.history.back(); h.flush(); assert.equal(nav.route.query, 'Menú')
  h.window.history.back(); h.flush(); h.window.history.back(); h.flush()
  assert.equal(nav.route.name, 'home'); assert.equal(h.departures, 0)
})

test('nested installed panels reuse the consumed guard without pushState after Back', async () => {
  const { nav, h } = setup({ standalone: true })
  let layers = 2
  const remaining = () => layers > 0
  const close = () => {
    if (!layers) return false
    layers--
    queueMicrotask(() => nav.overlay(remaining(), close, remaining))
    return true
  }
  nav.overlay(true, close, remaining)
  h.window.history.pushState = () => assert.fail('The remaining panel must reuse its marker after system Back')
  h.window.history.back(); h.flush(); await Promise.resolve(); h.flush()
  assert.equal(layers, 1); assert.equal(h.window.history.state.overlay, true)
  h.window.history.back(); h.flush(); await Promise.resolve(); h.flush()
  assert.equal(layers, 0); assert.equal(h.window.history.state.overlay, false)
  h.window.history.back(); h.flush()
  assert.equal(nav.route.name, 'home'); assert.equal(h.departures, 0)
})

test('jumping nested panels directly to the installed boundary closes every remaining layer', async () => {
  const { nav, h } = setup({ standalone: true })
  let layers = 2
  const remaining = () => layers > 0
  const close = () => { if (!layers) return false; layers--; return true }
  nav.overlay(true, close, remaining)
  h.window.history.pushState = () => assert.fail('A boundary traversal must not create another overlay entry')
  h.window.history.go(-2); h.flush()
  nav.overlay(remaining(), close, remaining); h.flush()
  assert.equal(layers, 0); assert.equal(nav.route.name, 'home')
  h.window.history.back(); h.flush(); assert.equal(h.departures, 0)
})

test('two Home Back calls in the same task cannot cross either installed root guard', () => {
  const { nav, h } = setup({ standalone: true })
  const length = h.items.length
  assert.equal(h.position, 2)
  for (let burst = 0; burst < 6; burst++) {
    h.window.history.back(); h.window.history.back()
    assert.equal(h.position, 0, 'Both native traversals happen before any queued popstate is delivered')
    assert.equal(h.departures, 0)
    h.flush()
    assert.equal(nav.route.name, 'home'); assert.equal(h.position, 2)
    assert.equal(h.window.history.state.rootBoundary, undefined)
    assert.equal(h.window.history.state.rootGuardDepth, 2)
  }
  assert.equal(h.items.length, length)
})

test('a second Home Back after the first popstate still returns to the protected Home anchor', () => {
  const { nav, h } = setup({ standalone: true })
  const length = h.items.length
  for (let burst = 0; burst < 6; burst++) {
    h.window.history.back(); h.flushOne()
    h.window.history.back(); h.flush()
    assert.equal(nav.route.name, 'home'); assert.equal(h.position, 2)
    assert.equal(h.departures, 0); assert.equal(h.window.history.state.rootBoundary, undefined)
  }
  assert.equal(h.items.length, length)
})

test('a second queued Back can interrupt the pending root repair without stranding Home or consuming Forward', () => {
  const { nav, h } = setup({ standalone: true, queuedTraversals: true })
  nav.go({ name: 'search', query: 'Adelante tras travesías pendientes' })
  h.window.history.back(); h.completeTraversal(); h.flush()
  assert.equal(nav.route.name, 'home')
  const homePosition = h.position, length = h.items.length
  h.window.history.back(); h.window.history.back()
  assert.equal(h.position, homePosition, 'History calls are requests; they do not complete before their queued traversal')
  assert.deepEqual(h.pendingTraversals().map(request => request.kind), ['back', 'back'])
  h.completeTraversal(); h.flushOne()
  assert.equal(h.window.history.state.rootBoundary, true)
  // A due repair task may run while the second native Back is still pending.
  // Flushing tasks does not complete queued native traversals in this mode.
  h.flush()
  // Chrome reported Back pop, a Forward request, then another Back pop without
  // completing that Forward. Represent that interruption explicitly; the test
  // does not assert which internal browser mechanism cancels the request.
  const repairIndex = h.pendingTraversals().findIndex(request => request.delta > 0)
  assert.ok(repairIndex >= 0, 'Expose the requested positive traversal before completing the second Back')
  const interruptedRepair = h.cancelTraversal(repairIndex)
  h.completeTraversal(); h.flushOne()
  assert.equal(h.window.history.state.rootDistance, 0)
  h.flush()
  let completions = 0
  while (h.pendingTraversals().length) {
    assert.ok(++completions < 20, 'Root recovery must finish without an unbounded traversal loop')
    h.completeTraversal(); h.flush()
  }
  assert.equal(h.position, homePosition, JSON.stringify({ interruptedRepair, pending: h.pendingTraversals(), state: h.window.history.state }))
  assert.equal(nav.route.name, 'home', 'Root repair may not overshoot into the existing Forward route')
  assert.equal(h.window.history.state.rootBoundary, undefined)
  assert.equal(h.departures, 0); assert.equal(h.items.length, length); assert.equal(nav.canForward, true)
  h.window.history.forward(); h.completeTraversal(); h.flush()
  assert.equal(nav.route.query, 'Adelante tras travesías pendientes')
  assert.equal(h.position, homePosition + 1); assert.equal(h.pendingTraversals().length, 0)
})

test('rapid Back from interior routes returns Home and further gestures cannot leave it', () => {
  let notices = 0
  const { nav, h } = setup({ standalone: true, onRootBack: () => notices++ })
  nav.go({ name: 'search', query: 'Dos gestos' }); nav.go({ name: 'artist', id: 7 })
  h.window.history.back(); h.window.history.back(); h.flush()
  assert.equal(nav.route.name, 'home'); assert.equal(h.departures, 0)
  assert.equal(h.window.history.state.rootBoundary, undefined)
  h.window.history.back(); h.flush()
  assert.ok(notices > 0); assert.equal(h.departures, 0); assert.equal(nav.route.name, 'home')
})

test('a route or overlay chosen while a root bounce is pending remains operable', () => {
  for (const action of ['route', 'overlay']) {
    const { nav, h } = setup({ standalone: true })
    h.window.history.back(); h.flushOne()
    if (action === 'route') nav.go({ name: 'library' })
    else nav.overlay(true, () => true)
    h.flush()
    assert.equal(h.window.history.state.rootBoundary, undefined)
    assert.equal(action === 'route' ? nav.route.name : h.window.history.state.overlay, action === 'route' ? 'library' : true)
    h.window.history.back(); h.flush()
    assert.equal(nav.route.name, 'home'); assert.equal(h.departures, 0)
    h.window.history.back(); h.window.history.back(); h.flush()
    assert.equal(nav.route.name, 'home'); assert.equal(h.departures, 0)
  }
})

test('repeated root protection leaves native and application Forward routes intact', () => {
  for (const native of [true, false]) {
    const { nav, h } = setup({ standalone: true })
    nav.go({ name: 'search', query: 'Adelante sin salir' }); nav.back(); h.flush()
    const length = h.items.length
    h.window.history.back(); h.window.history.back(); h.flush()
    assert.equal(nav.route.name, 'home', 'Queued guard pops must not overshoot into the Forward route')
    assert.equal(h.window.history.state.index, 0); assert.equal(h.window.history.state.rootBoundary, undefined)
    assert.equal(nav.canForward, true)
    if (native) h.window.history.forward()
    else nav.forward()
    h.flush()
    assert.equal(nav.route.query, 'Adelante sin salir')
    assert.equal(h.departures, 0); assert.equal(h.items.length, length)
  }
})

test('double Back after compaction cannot enter older session entries or create new history', () => {
  const { nav, h } = setup({ standalone: true, historyLimit: 50 })
  for (let index = 0; index < 100; index++) { nav.go({ name: 'search', query: `Compactada ${index}` }); h.flush() }
  while (nav.canBack) { h.window.history.back(); h.flush() }
  const length = h.items.length, homePosition = h.position, rootId = h.window.history.state.rootId
  h.window.history.pushState = () => assert.fail('Protecting Home during Back must not create entries')
  h.window.history.back(); h.window.history.back(); h.flush()
  assert.equal(nav.route.name, 'home'); assert.equal(h.departures, 0)
  assert.equal(h.position, homePosition); assert.equal(h.window.history.state.rootId, rootId)
  assert.equal(h.items.length, length)
})

test('installed guards keep double Back away from unknown and foreign-session predecessors', () => {
  for (const prior of [{ external: true }, { pletinaNavigation: 1, session: 'another-session', index: 0, overlay: false,
    snapshot: { stack: [{ name: 'home' }], index: 0 } }]) {
    const h = browser({ standalone: true }), nav = navigation()
    h.window.history.replaceState(prior, '', h.window.location.href)
    h.window.history.pushState(null, '', h.window.location.href)
    initWebNavigation(nav, h.window); h.flush()
    const homePosition = h.position, length = h.items.length
    h.window.history.back(); h.window.history.back(); h.flush()
    assert.equal(h.position, homePosition); assert.equal(h.departures, 0)
    assert.deepEqual(h.items[0], prior)
    assert.equal(nav.route.name, 'home'); assert.equal(h.items.length, length)
  }
})

test('923 installed state with one old guard migrates to two guards while retaining routes and Forward', () => {
  for (const initial of ['route', 'boundary']) {
    const h = browser({ standalone: true }), nav = navigation()
    const stack = [{ name: 'home' }, { name: 'search', query: 'Guardada en923' }, { name: 'album', id: 12 }]
    const old = index => ({ pletinaNavigation: 1, session: 'session923', index, overlay: false, protectedRoot: true,
      rootId: 'legacy923-root', rootDistance: index + 1, snapshot: { stack, index } })
    // The original boundary predates later views; session storage holds their Forward branch.
    h.window.history.replaceState({ ...old(0), rootDistance: 0, rootBoundary: true,
      snapshot: { stack: [stack[0]], index: 0 } }, '', h.window.location.href)
    for (let index = 0; index < stack.length; index++) h.window.history.pushState(old(index), '', h.window.location.href)
    h.window.sessionStorage.setItem('pletina:web:navigation:/pletina/', JSON.stringify({ session: 'session923',
      snapshot: { stack, index: initial === 'boundary' ? 0 : 1 } }))
    if (initial === 'boundary') h.window.history.go(-h.position)
    else h.window.history.back()
    h.discardEvents()
    const dispose = initWebNavigation(nav, h.window); h.flush()
    if (initial === 'route') assert.equal(nav.route.query, 'Guardada en923')
    else assert.equal(nav.route.name, 'home')
    assert.equal(nav.canForward, true)
    assert.equal(h.window.history.state.rootGuardDepth, 2)
    const rootId = h.window.history.state.rootId
    assert.equal(h.items.filter(entry => entry?.rootId === rootId && entry.rootBoundary).length, 2)
    const length = h.items.length
    if (initial === 'route') { nav.back(); h.flush() }
    assert.equal(nav.route.name, 'home')
    const homePosition = h.position
    h.window.history.back(); h.window.history.back(); h.flush()
    assert.equal(nav.route.name, 'home'); assert.equal(h.position, homePosition); assert.equal(h.departures, 0)
    nav.forward(); h.flush(); assert.equal(nav.route.query, 'Guardada en923')
    nav.forward(); h.flush(); assert.equal(nav.route.name, 'album')
    dispose()
    const reloaded = navigation(); initWebNavigation(reloaded, h.window); h.flush()
    assert.equal(reloaded.route.name, 'album'); assert.equal(h.items.length, length, 'Recognized two-guard state must not migrate again')
  }
})

test('reload from either pending installed guard returns Home without duplicating its protected history', () => {
  for (const calls of [1, 2]) {
    const { h, dispose } = setup({ standalone: true })
    const length = h.items.length
    for (let call = 0; call < calls; call++) h.window.history.back()
    dispose(); h.discardEvents()
    const reloaded = navigation(); initWebNavigation(reloaded, h.window); h.flush()
    assert.equal(reloaded.route.name, 'home'); assert.equal(h.departures, 0)
    assert.equal(h.position, 2); assert.equal(h.window.history.state.rootBoundary, undefined)
    assert.equal(h.items.length, length)
    h.window.history.back(); h.window.history.back(); h.flush(); assert.equal(h.departures, 0)
  }
})

test('a multi-entry Back across compacted roots restores the current Home and stays protected', () => {
  const { nav, h } = setup({ standalone: true, historyLimit: 50 })
  for (let index = 0; index < 60; index++) { nav.go({ name: 'search', query: `Salto ${index}` }); h.flush() }
  const start = { route: nav.route, position: h.position, rootId: h.window.history.state.rootId }
  h.window.history.go(-h.position); h.flush()
  assert.equal(nav.route.name, 'home', JSON.stringify({ start, position: h.position, state: h.window.history.state,
    guards: h.items.flatMap((entry, index) => entry?.rootBoundary ? [{ index, rootId: entry.rootId, distance: entry.rootDistance }] : []) }))
  assert.equal(h.departures, 0)
  assert.equal(h.window.history.state.rootBoundary, undefined)
  h.window.history.back(); h.window.history.back(); h.flush()
  assert.equal(nav.route.name, 'home'); assert.equal(h.departures, 0)
})

test('page-cache restoration from either guard anchors Home even when its initial popstate is omitted', () => {
  for (const calls of [1, 2]) {
    const { nav, h } = setup({ standalone: true })
    const length = h.items.length
    for (let call = 0; call < calls; call++) h.window.history.back()
    h.discardEvents()
    const show = new Event('pageshow'); Object.defineProperty(show, 'persisted', { value: true })
    h.window.dispatchEvent(show); h.flush()
    assert.equal(nav.route.name, 'home'); assert.equal(h.position, 2)
    assert.equal(h.window.history.state.rootBoundary, undefined); assert.equal(h.items.length, length)
    h.window.history.back(); h.window.history.back(); h.flush(); assert.equal(h.departures, 0)
  }
})

test('background and focus lifecycle do not weaken a pending Home guard after time passes', () => {
  for (const mode of ['hidden', 'pagehide', 'focus']) {
    const { nav, h } = setup({ standalone: true })
    h.window.history.back()
    if (mode === 'hidden') { h.window.document.hidden = true; h.window.document.dispatchEvent(new Event('visibilitychange')) }
    else if (mode === 'pagehide') h.window.dispatchEvent(new Event('pagehide'))
    h.advance(5000)
    if (mode === 'hidden') { h.window.document.hidden = false; h.window.document.dispatchEvent(new Event('visibilitychange')) }
    else if (mode === 'pagehide') h.window.dispatchEvent(new Event('pageshow'))
    else h.window.dispatchEvent(new Event('focus'))
    h.flush()
    assert.equal(nav.route.name, 'home'); assert.equal(h.window.history.state.rootBoundary, undefined, mode)
    h.window.history.back(); h.window.history.back(); h.flush()
    assert.equal(h.departures, 0); assert.equal(h.position, 2)
  }
})
