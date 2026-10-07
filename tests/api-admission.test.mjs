import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/lib/api.ts', import.meta.url), 'utf8')
const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText.replace(/^import[^\n]+\n/gm, '')
let serial = 0
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
async function setup(t, tauriInvoke, listen) {
  const key = `__admissionApi${++serial}`
  globalThis[key] = { tauriInvoke, listen }
  t.after(() => delete globalThis[key])
  const prelude = `const window = { __TAURI_INTERNALS__: {} }; const { tauriInvoke, listen } = globalThis.${key};\n`
  return import(`data:text/javascript;base64,${Buffer.from(prelude + javascript).toString('base64')}`)
}

test('la suscripción termina antes de invoke, filtra requestId y se suelta al resolver', async t => {
  const registered = deferred(), result = deferred(), received = [], calls = []
  let listener, removed = 0
  const api = await setup(t, (command, args) => { calls.push({ command, args }); return result.promise }, async (event, callback) => {
    assert.equal(event, 'player:foreground-admitted'); listener = callback
    await registered.promise
    return () => removed++
  })
  const pending = api.resolve({ id: 1 }, false, true, { onAdmitted: value => received.push(value) })
  await new Promise(setImmediate)
  assert.equal(calls.length, 0)
  registered.resolve(); await new Promise(setImmediate)
  const requestId = calls[0].args.requestId
  listener({ payload: { requestId: 'otro' } })
  listener({ payload: { requestId, resolution: 8 } })
  listener({ payload: { requestId, resolution: 8 } })
  assert.deepEqual(received, [{ requestId, resolution: 8 }])
  result.resolve({ url: 'audio' }); await pending
  assert.equal(removed, 1)
})

test('fallo del listener conserva resolve normal y el rechazo de choose limpia la suscripción', async t => {
  const calls = []
  const api = await setup(t, async (command, args) => { calls.push({ command, args }); return { url: 'audio' } }, async () => { throw new Error('sin eventos') })
  await api.resolve({ id: 1 }, false, true, { onAdmitted() {} })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args.requestId, undefined)
  let removed = 0
  const rejecting = await setup(t, async () => { throw new Error('interacción') }, async () => () => removed++)
  await assert.rejects(rejecting.chooseSource({ id: 1 }, 'aaaaaaaaaaa', true, { onAdmitted() {} }), /interacción/)
  assert.equal(removed, 1)
})

test('cancelar mientras se registra el listener evita invocar y next transmite la época esperada', async t => {
  const registered = deferred(), calls = []
  let current = true, removed = 0
  const api = await setup(t, async (command, args) => { calls.push({ command, args }); return {} }, async () => {
    await registered.promise; return () => removed++
  })
  const pending = api.resolve({ id: 1 }, false, true, { onAdmitted() {}, isCurrent: () => current })
  current = false; registered.resolve()
  await assert.rejects(pending, error => error.name === 'AbortError')
  assert.equal(calls.length, 0)
  assert.equal(removed, 1)
  await api.resolve({ id: 2 }, false, false, { expectedForeground: 8, nextSlot: 1 })
  assert.equal(calls[0].args.expectedForeground, 8)
  assert.equal(calls[0].args.nextSlot, 1)
  assert.equal(calls[0].args.requestId, undefined)
  await api.cancelPrefetch(0)
  assert.deepEqual(calls[1], { command: 'cancel_prefetch', args: { nextSlot: 0 } })
  await api.cancelPrefetch()
  assert.deepEqual(calls[2], { command: 'cancel_prefetch', args: undefined })
})
