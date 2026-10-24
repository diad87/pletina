import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const exports = {}
const source = ts.transpileModule(readFileSync(new URL('../../src/lib/driving-wake-lock.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText
vm.runInNewContext(source, { exports })
const { createDrivingWakeLock } = exports

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function page(visibilityState = 'visible') {
  const listeners = new Set()
  return {
    visibilityState,
    listeners,
    addEventListener(type, listener) {
      assert.equal(type, 'visibilitychange')
      listeners.add(listener)
    },
    removeEventListener(type, listener) {
      assert.equal(type, 'visibilitychange')
      listeners.delete(listener)
    },
    visibility(value) {
      this.visibilityState = value
      for (const listener of [...listeners]) listener()
    },
  }
}

function lock() {
  const listeners = new Set()
  return {
    released: false,
    releases: 0,
    listeners,
    addEventListener(type, listener) { assert.equal(type, 'release'); listeners.add(listener) },
    removeEventListener(type, listener) { assert.equal(type, 'release'); listeners.delete(listener) },
    async release() { this.releases += 1; this.systemRelease() },
    systemRelease() {
      this.released = true
      for (const listener of [...listeners]) listener()
    },
  }
}

function harness(visibilityState = 'visible') {
  const document = page(visibilityState)
  const requests = []
  const states = []
  const controller = createDrivingWakeLock(state => states.push(state), {
    document,
    wakeLock: {
      request(type) {
        assert.equal(type, 'screen')
        const result = deferred()
        requests.push(result)
        return result.promise
      },
    },
  })
  return { controller, document, requests, states }
}

const flush = async () => { await Promise.resolve(); await Promise.resolve() }

test('missing browser API and server rendering remain safe', () => {
  for (const environment of [undefined, {}, { document: page() }]) {
    const states = []
    const controller = createDrivingWakeLock(state => states.push(state), environment)
    controller.setEnabled(true)
    controller.setEnabled(false)
    controller.destroy()
    controller.destroy()
    assert.deepEqual(states, ['unsupported'])
  }
})

test('enabled screen acquires one lock and disabling releases it and listeners', async () => {
  const { controller, document, requests, states } = harness()
  controller.setEnabled(true)
  controller.setEnabled(true)
  assert.equal(requests.length, 1)
  const acquired = lock()
  requests[0].resolve(acquired)
  await flush()
  assert.deepEqual(states, ['off', 'requesting', 'active'])
  controller.setEnabled(false)
  assert.equal(acquired.releases, 1)
  assert.equal(acquired.listeners.size, 0)
  assert.equal(states.at(-1), 'off')
  controller.destroy()
  assert.equal(document.listeners.size, 0)
})

test('hidden screen waits, releases on backgrounding, and reacquires on return', async () => {
  const { controller, document, requests, states } = harness('hidden')
  controller.setEnabled(true)
  assert.equal(requests.length, 0)
  document.visibility('visible')
  assert.equal(requests.length, 1)
  const first = lock()
  requests[0].resolve(first)
  await flush()
  document.visibility('hidden')
  assert.equal(first.releases, 1)
  assert.equal(states.at(-1), 'off')
  document.visibility('visible')
  const second = lock()
  requests[1].resolve(second)
  await flush()
  assert.equal(states.at(-1), 'active')
  controller.destroy()
  assert.equal(second.releases, 1)
})

test('disabling during a request releases its eventual result without activating', async () => {
  const { controller, requests, states } = harness()
  controller.setEnabled(true)
  controller.setEnabled(false)
  const acquired = lock()
  requests[0].resolve(acquired)
  await flush()
  assert.equal(acquired.releases, 1)
  assert.deepEqual(states, ['off', 'requesting', 'off'])
  assert.equal(requests.length, 1)
  controller.destroy()
})

test('destroy during a request releases the late lock without callbacks or new requests', async () => {
  const { controller, document, requests, states } = harness()
  controller.setEnabled(true)
  controller.destroy()
  const statesAtDestroy = [...states]
  controller.setEnabled(true)
  document.visibility('hidden')
  document.visibility('visible')
  const acquired = lock()
  requests[0].resolve(acquired)
  await flush()
  assert.equal(acquired.releases, 1)
  assert.equal(document.listeners.size, 0)
  assert.deepEqual(states, statesAtDestroy)
  assert.equal(requests.length, 1)
})

test('a new enable during an old request waits and then acquires a fresh lock', async () => {
  const { controller, requests, states } = harness()
  controller.setEnabled(true)
  controller.setEnabled(false)
  controller.setEnabled(true)
  assert.equal(requests.length, 1)
  const stale = lock()
  requests[0].resolve(stale)
  await flush()
  assert.equal(stale.releases, 1)
  assert.equal(requests.length, 2)
  assert.equal(states.at(-1), 'requesting')
  const acquired = lock()
  requests[1].resolve(acquired)
  await flush()
  assert.equal(states.at(-1), 'active')
  controller.destroy()
})

test('backgrounding during a request never accepts the old lock after returning', async () => {
  const { controller, document, requests, states } = harness()
  controller.setEnabled(true)
  document.visibility('hidden')
  document.visibility('visible')
  assert.equal(requests.length, 1)
  const stale = lock()
  requests[0].resolve(stale)
  await flush()
  assert.equal(stale.releases, 1)
  assert.equal(requests.length, 2)
  assert.equal(states.includes('active'), false)
  requests[1].resolve(lock())
  await flush()
  assert.equal(states.at(-1), 'active')
  controller.destroy()
})

test('rejection remains unavailable without retrying until visibility changes', async () => {
  const { controller, document, requests, states } = harness()
  controller.setEnabled(true)
  requests[0].reject(new Error('power saving'))
  await flush()
  assert.equal(states.at(-1), 'unavailable')
  controller.setEnabled(true)
  document.visibility('visible')
  await flush()
  assert.equal(requests.length, 1)
  document.visibility('hidden')
  document.visibility('visible')
  requests[1].resolve(lock())
  await flush()
  assert.equal(states.at(-1), 'active')
  controller.destroy()
})

test('a system release reports unavailability without looping and can recover', async () => {
  const { controller, document, requests, states } = harness()
  controller.setEnabled(true)
  const acquired = lock()
  requests[0].resolve(acquired)
  await flush()
  acquired.systemRelease()
  await flush()
  assert.equal(states.at(-1), 'unavailable')
  assert.equal(requests.length, 1)
  assert.equal(acquired.listeners.size, 0)
  document.visibility('hidden')
  document.visibility('visible')
  requests[1].resolve(lock())
  await flush()
  assert.equal(states.at(-1), 'active')
  controller.destroy()
})

test('a lock released before delivery is unavailable and does not cause retries', async () => {
  const { controller, requests, states } = harness()
  controller.setEnabled(true)
  const acquired = lock()
  acquired.systemRelease()
  requests[0].resolve(acquired)
  await flush()
  assert.equal(states.at(-1), 'unavailable')
  assert.equal(requests.length, 1)
  controller.destroy()
})
