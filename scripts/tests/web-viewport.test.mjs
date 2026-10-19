import assert from 'node:assert/strict'
import test from 'node:test'
import { initWebViewport } from '../../web-port/viewport.ts'

function browser(t, { innerHeight = 800, visualHeight = 800 } = {}) {
  const originals = Object.fromEntries(['window', 'document', 'requestAnimationFrame', 'cancelAnimationFrame'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const window = new EventTarget(), document = new EventTarget(), viewport = new EventTarget(), values = new Map(), frames = new Map()
  let nextFrame = 0
  Object.assign(window, { innerHeight, visualViewport: viewport })
  viewport.height = visualHeight
  Object.assign(document, { hidden: false, documentElement: { style: { setProperty: (key, value) => values.set(key, value), removeProperty: (key) => values.delete(key) } } })
  Object.assign(globalThis, { window, document, requestAnimationFrame: (callback) => { const id = ++nextFrame; frames.set(id, callback); return id }, cancelAnimationFrame: (id) => frames.delete(id) })
  const dispose = initWebViewport()
  t.after(() => {
    dispose()
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  })
  return { window, document, viewport, values, dispose, flush() { for (const [id, callback] of [...frames]) { frames.delete(id); callback() } } }
}

test('a keyboard-sized visual viewport constrains the dock then pageshow restores the full app height', (t) => {
  const h = browser(t, { innerHeight: 800, visualHeight: 420 })
  assert.equal(h.values.get('--pletina-viewport-height'), '420px')
  h.viewport.height = 800
  h.window.dispatchEvent(new Event('pageshow'))
  h.flush()
  assert.equal(h.values.get('--pletina-viewport-height'), '800px')
  h.window.innerHeight = 760
  h.viewport.height = 790
  h.viewport.dispatchEvent(new Event('resize'))
  h.flush()
  assert.equal(h.values.get('--pletina-viewport-height'), '760px', 'the dock must fit inside both reported viewport bounds')
})

test('returning from the background refreshes stale viewport dimensions and cleanup releases listeners', (t) => {
  const h = browser(t)
  h.document.hidden = true
  h.viewport.height = 500
  h.document.dispatchEvent(new Event('visibilitychange'))
  h.flush()
  assert.equal(h.values.get('--pletina-viewport-height'), '800px')
  h.document.hidden = false
  h.document.dispatchEvent(new Event('visibilitychange'))
  h.flush()
  assert.equal(h.values.get('--pletina-viewport-height'), '500px')
  h.dispose()
  h.window.dispatchEvent(new Event('pageshow'))
  h.flush()
  assert.equal(h.values.has('--pletina-viewport-height'), false)
})

test('invalid visual viewport metrics fall back to a finite window height', (t) => {
  const h = browser(t, { innerHeight: 819.75, visualHeight: NaN })
  assert.equal(h.values.get('--pletina-viewport-height'), '819px')
  h.viewport.height = 0
  h.window.dispatchEvent(new Event('focus'))
  h.flush()
  assert.equal(h.values.get('--pletina-viewport-height'), '819px')
})
