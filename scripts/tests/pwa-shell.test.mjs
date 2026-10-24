import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

// Ejecuta el shell real. Solo se adapta el límite import() para controlar red/montaje.
const source = (await readFile(new URL('../../pwa/app.js', import.meta.url), 'utf8'))
  .replace('await import(playerURL.href)', 'await loadPlayer(playerURL.href)')
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve() }
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
class Element extends EventTarget {
  hidden = false
  disabled = false
  open = false
  textContent = ''
  dataset = {}
  attributes = new Map()
  children = []
  focuses = 0
  setAttribute(key, value) { this.attributes.set(key, value) }
  hasAttribute(key) { return this.attributes.has(key) }
  removeAttribute(key) { this.attributes.delete(key) }
  remove() { this.removed = true }
  focus() { this.focuses++ }
  append(...nodes) { this.children.push(...nodes) }
  replaceChildren(...nodes) { this.children = nodes }
  showModal() { this.open = true }
  close() { this.open = false }
}

function shell({ standalone = false, iosStandalone = false, href = 'https://example.test/pletina/',
  portable = false, waiting = false, load, storageDenied = false } = {}) {
  const ids = ['status', 'install', 'install-help', 'check-update', 'apply-update', 'headline', 'intro',
    'install-guide', 'guide-title', 'guide-steps', 'open-player', 'home-screen', 'player-screen',
    'launch-screen', 'launch-status', 'retry-launch', 'updates', 'version', 'player-host', 'back-home',
    'guide-context', 'guide-lead', 'close-guide']
  const nodes = new Map(ids.map(id => [id, new Element()]))
  const root = new Element(), manifest = new Element()
  if (portable) root.setAttribute('data-portable', '')
  nodes.get('headline').textContent = 'Dale al play'
  nodes.get('intro').textContent = 'Encuentra lo que te mueve. Guárdalo en tus listas. Llévalo contigo.'
  nodes.get('install').textContent = 'Instalar Pletina'
  nodes.get('open-player').textContent = 'Probar sin instalar'
  nodes.get('launch-status').textContent = 'Abriendo Pletina…'
  for (const id of ['player-screen', 'retry-launch', 'apply-update', 'check-update']) nodes.get(id).hidden = true
  const document = new EventTarget()
  Object.assign(document, {
    documentElement: root, visibilityState: 'visible',
    querySelector: selector => selector === 'link[rel="manifest"]' ? manifest : nodes.get(selector.slice(1)),
    createElement: () => new Element(), createElementNS: () => new Element(), createTextNode: text => ({ textContent: text }),
  })
  const window = new EventTarget()
  window.isSecureContext = !href.startsWith('file:')
  const sw = new EventTarget(), registration = new EventTarget(), messages = [], calls = { load: 0, mount: 0, reload: 0, register: 0, update: 0, storage: 0 }
  const worker = { state: 'installed', postMessage: message => messages.push(message) }
  Object.assign(registration, { waiting: waiting ? worker : null, installing: null, update: async () => { calls.update++ } })
  Object.assign(sw, {
    controller: {}, getRegistration: async () => registration,
    register: async () => { calls.register++; return registration },
  })
  const navigator = { serviceWorker: sw, standalone: iosStandalone, onLine: true,
    userAgent: iosStandalone ? 'iPhone Safari' : 'Chrome', platform: iosStandalone ? 'iPhone' : 'Win32', maxTouchPoints: 0 }
  const media = new EventTarget()
  media.matches = standalone
  const location = { href, protocol: new URL(href).protocol, reload: () => { calls.reload++ } }
  const storage = { getItem() { calls.storage++; if (storageDenied) throw new Error('Storage denied'); return null } }
  const timers = new Map()
  let timerId = 0
  runInNewContext(source, {
    document, window, navigator, location, URL, matchMedia: () => media, localStorage: storage,
    history: { state: null, replaceState(_state, _title, url) { location.href = url } },
    setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id }, clearTimeout: id => timers.delete(id),
    loadPlayer: async () => {
      calls.load++
      if (load) await load()
      return { mountPlayer: async () => { calls.mount++; return { destroy() {} } } }
    },
  }, { filename: 'pwa/app.js' })
  return { nodes, root, calls, messages, window, navigator, registration, media, document, timers, location,
    node: id => nodes.get(id),
    async click(id) { nodes.get(id).dispatchEvent(new Event('click')); await flush() },
  }
}

for (const mode of ['standalone', 'iosStandalone']) {
  test(`first installed launch (${mode}) opens the player without a stored opened flag`, async () => {
    const pending = deferred(), h = shell({ [mode]: true, load: () => pending.promise })
    assert.equal(h.node('home-screen').hidden, true)
    assert.equal(h.root.hasAttribute('data-auto-launch'), true)
    assert.equal(h.node('launch-screen').hidden, false)
    assert.equal(h.node('launch-status').textContent, 'Abriendo Pletina…')
    await flush()
    assert.equal(h.calls.load, 1)
    assert.equal(h.calls.storage, 0)
    pending.resolve()
    await flush()
    assert.equal(h.calls.mount, 1)
    assert.equal(h.node('home-screen').hidden, true)
    assert.equal(h.node('player-screen').hidden, false)
    assert.equal(h.node('launch-screen').hidden, true)
    assert.equal(h.root.hasAttribute('data-auto-launch'), false)
  })
}

test('installed entry tolerates denied storage and never activates a waiting update', async () => {
  const h = shell({ standalone: true, storageDenied: true, waiting: true })
  await flush()
  assert.equal(h.calls.mount, 1)
  assert.equal(h.calls.storage, 0)
  assert.deepEqual(h.messages, [])
  assert.equal(h.calls.reload, 0)
  assert.equal(h.node('home-screen').hidden, true)
})

test('?open=app also opens the active player without consenting to a pending update', async () => {
  const h = shell({ href: 'https://example.test/pletina/?open=app', waiting: true })
  await flush()
  assert.equal(h.calls.load, 1)
  assert.equal(h.calls.mount, 1)
  assert.deepEqual(h.messages, [])
  assert.equal(h.node('home-screen').hidden, true)
})

test('failed installed launch keeps the welcome hidden and offers one explicit retry without a reload loop', async () => {
  const h = shell({ standalone: true, waiting: true, load: async () => { throw new Error('Network failed') } })
  await flush()
  assert.equal(h.node('home-screen').hidden, true)
  assert.equal(h.node('player-screen').hidden, true)
  assert.equal(h.root.hasAttribute('data-auto-launch'), true)
  assert.equal(h.node('launch-screen').hidden, false)
  assert.match(h.node('launch-status').textContent, /No se pudo abrir Pletina/)
  assert.equal(h.node('retry-launch').hidden, false)
  assert.equal(h.calls.reload, 0)
  assert.equal(h.calls.load, 1)
  h.window.dispatchEvent(new Event('online'))
  await flush()
  assert.match(h.node('launch-status').textContent, /No se pudo abrir Pletina/)
  assert.equal(h.calls.load, 1)
  assert.deepEqual(h.messages, [])
  await h.click('retry-launch')
  await h.click('retry-launch')
  assert.equal(h.calls.reload, 1)
  assert.equal(h.node('home-screen').hidden, true)
  assert.equal(h.node('retry-launch').disabled, true)
})

test('normal visits preserve the approved welcome and preview label before and after returning home', async () => {
  const h = shell()
  await flush()
  assert.equal(h.calls.load, 0)
  assert.equal(h.node('headline').textContent, 'Dale al play')
  assert.equal(h.node('intro').textContent, 'Encuentra lo que te mueve. Guárdalo en tus listas. Llévalo contigo.')
  assert.equal(h.node('install').textContent, 'Instalar Pletina')
  assert.equal(h.node('open-player').textContent, 'Probar sin instalar')
  await h.click('open-player')
  assert.equal(h.calls.mount, 1)
  await h.click('back-home')
  assert.equal(h.node('home-screen').hidden, false)
  assert.equal(h.node('open-player').textContent, 'Probar sin instalar')
  assert.equal(h.node('headline').textContent, 'Dale al play')
})

test('the install help opens the guide without consuming the native install prompt', async () => {
  const h = shell()
  let prompts = 0
  const event = new Event('beforeinstallprompt', { cancelable: true })
  Object.assign(event, { prompt: async () => { prompts++ }, userChoice: Promise.resolve({ outcome: 'dismissed' }) })
  h.window.dispatchEvent(event)
  await h.click('install-help')
  assert.equal(h.node('install-guide').open, true)
  assert.equal(prompts, 0)
  await h.click('install')
  assert.equal(prompts, 1, 'the native prompt is only used by its installation click')
})

test('appinstalled opens the active app directly and hides the welcome without activating a waiting update', async () => {
  const pending = deferred(), h = shell({ waiting: true, load: () => pending.promise })
  await flush()
  assert.equal(h.calls.load, 0)
  h.window.dispatchEvent(new Event('appinstalled'))
  assert.equal(h.node('home-screen').hidden, true)
  assert.equal(h.root.hasAttribute('data-auto-launch'), true)
  assert.equal(h.node('launch-screen').hidden, false)
  assert.equal(h.node('launch-status').textContent, 'Abriendo Pletina…')
  await flush()
  assert.equal(h.calls.load, 1)
  assert.deepEqual(h.messages, [])
  pending.resolve()
  await flush()
  assert.equal(h.calls.mount, 1)
  assert.equal(h.node('player-screen').hidden, false)
  assert.equal(h.node('home-screen').hidden, true)
  assert.equal(h.root.hasAttribute('data-auto-launch'), false)
  assert.deepEqual(h.messages, [])
})

test('an appinstalled launch failure retains direct entry when the user explicitly retries from its browser tab', async () => {
  const h = shell({ load: async () => { throw new Error('Network failed') } })
  await flush()
  h.window.dispatchEvent(new Event('appinstalled'))
  await flush()
  assert.equal(h.node('home-screen').hidden, true)
  assert.equal(h.node('retry-launch').hidden, false)
  assert.equal(new URL(h.location.href).searchParams.get('open'), 'app')
  assert.equal(h.calls.reload, 0)
  await h.click('retry-launch')
  assert.equal(h.calls.reload, 1)
  const retried = shell({ href: h.location.href })
  await flush()
  assert.equal(retried.node('home-screen').hidden, true)
  assert.equal(retried.calls.mount, 1)
})

test('a waiting update leaves one primary action instead of duplicate open/update buttons', async () => {
  const h = shell({ waiting: true })
  await flush()
  assert.equal(h.node('apply-update').hidden, false)
  assert.equal(h.node('install').hidden, true)
  assert.equal(h.node('open-player').hidden, true)
  assert.equal(h.node('install-help').hidden, false)
  assert.equal(h.calls.load, 0)
  assert.deepEqual(h.messages, [])
})

for (const portable of ['file', 'attribute']) {
  test(`portable entry (${portable}) never autolaunches, installs or registers a worker`, async () => {
    const h = shell({ standalone: true, iosStandalone: true,
      href: portable === 'file' ? 'file:///C:/Pletina.html?open=app' : 'https://example.test/pletina/?open=app',
      portable: portable === 'attribute' })
    await flush()
    assert.equal(h.calls.load, 0)
    assert.equal(h.calls.register, 0)
    assert.equal(h.node('install').hidden, true)
    assert.equal(h.node('install-help').hidden, true)
    assert.equal(h.node('open-player').hidden, true)
    assert.equal(h.root.hasAttribute('data-auto-launch'), false)
    assert.equal(h.node('home-screen').hidden, false)
  })
}
