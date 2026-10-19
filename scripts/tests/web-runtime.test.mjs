import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const compile = async (path) => ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText
const [eventCode, diagnosticCode, captureCode] = await Promise.all([
  compile('../../src/lib/events.ts'), compile('../../web-port/diagnostics.ts'), compile('../../web-port/capture.ts'),
])

test('PWA events keep the Tauri payload shape, event isolation and unlisten contract without IPC', async () => {
  const window = new EventTarget(), exports = {}
  new Function('exports', 'require', 'window', eventCode)(exports, (path) => path === './api' ? { inPwa: true }
    : path === '@tauri-apps/api/event' ? { listen() { assert.fail('PWA must not use native IPC') } } : assert.fail(path), window)
  const received = []
  const unlisten = await exports.listen('download', (event) => received.push(event))
  const progress = { trackId: 12, state: 'downloading', progress: 0.5, error: null }
  window.dispatchEvent(new CustomEvent('download', { detail: progress }))
  window.dispatchEvent(new CustomEvent('pletina:other', { detail: progress }))
  window.dispatchEvent(new Event('pletina:download'))
  assert.equal(received.length, 0)
  window.dispatchEvent(new CustomEvent('pletina:download', { detail: progress }))
  assert.deepEqual(received, [{ event: 'download', id: 1, payload: progress }])
  unlisten(); unlisten()
  window.dispatchEvent(new CustomEvent('pletina:download', { detail: progress }))
  assert.equal(received.length, 1)
})

function diagnostics({ shared, canShare = false, stored = null, storageFails = false } = {}) {
  let saved = stored, blob
  const links = [], timers = [], revoked = []
  const storage = { getItem() { return saved }, setItem(_key, value) { if (storageFails) throw new Error('Disabled'); saved = value } }
  const document = { body: { append(link) { links.push(link) } }, createElement(name) {
    assert.equal(name, 'a')
    return { clicked: false, removed: false, click() { this.clicked = true }, remove() { this.removed = true } }
  } }
  const url = { createObjectURL(value) { blob = value; return 'blob:local-test' }, revokeObjectURL(value) { revoked.push(value) } }
  const exports = {}
  new Function('exports', 'localStorage', 'navigator', 'document', 'URL', 'setTimeout', diagnosticCode)(exports, storage,
    { canShare: () => canShare, share: shared }, document, url, (callback) => timers.push(callback))
  return { ...exports, links, timers, revoked, get blob() { return blob }, get saved() { return saved } }
}
const audio = () => ({ currentTime: 42.123456, paused: false, readyState: 4, ended: false, error: null,
  src: 'https://secret.googlevideo.com/audio?signature=SECRET', title: 'PRIVATE TITLE' })

test('audio log is bounded, persists locally, and never serializes source URLs, title or media error text', () => {
  const log = diagnostics(), a = audio()
  a.error = { code: 4, message: 'https://private.invalid/?token=SECRET' }
  for (let i = 0; i < 300; i++) log.recordAudioEvent('error', a)
  log.recordAudioEvent('https://untrusted.invalid/SECRET', a)
  const value = log.readWebLog()
  assert.equal(value.events.length, 256)
  assert.deepEqual(Object.keys(value.events[0]), ['at', 'type', 'time', 'status'])
  assert.equal(value.events[0].time, 42.123)
  assert.equal(value.events[0].status, 'error')
  assert.doesNotMatch(JSON.stringify(value), /https:|SECRET|PRIVATE|signature|token/)
  const reloaded = diagnostics({ stored: log.saved })
  assert.equal(reloaded.readWebLog().events.length, 256)
  const copy = reloaded.readWebLog(); copy.events[0].type = 'changed'
  assert.equal(reloaded.readWebLog().events[0].type, 'error', 'exporting must not expose a mutable reference to the ring')
})

test('diagnostics sanitizes saved rows, tolerates unavailable storage and throttles timeupdate', () => {
  const stored = JSON.stringify([{ at: 1, type: 'playing', time: 1, status: 'playing', url: 'https://private.invalid' },
    { at: 1, type: 'https://private.invalid', time: 1, status: 'playing' }])
  const log = diagnostics({ stored, storageFails: true }), a = audio()
  for (let i = 0; i < 30; i++) log.recordAudioEvent('timeupdate', a)
  assert.equal(log.readWebLog().events.length, 2)
  assert.doesNotMatch(JSON.stringify(log.readWebLog()), /https:|url/)
})

test('capture observes each Audio once while keeping source changes and load behavior', () => {
  const entries = [], exports = {}
  new Function('exports', 'require', captureCode)(exports, () => ({ recordAudioEvent: (type) => entries.push(type) }))
  const a = new EventTarget()
  a.loads = 0; a.load = () => { a.loads++ }
  exports.setAudioSource(a, 'https://audio.example/1')
  exports.setAudioSource(a, 'https://audio.example/2')
  a.dispatchEvent(new Event('playing'))
  assert.deepEqual(entries, ['source', 'source', 'playing'])
  assert.equal(a.src, 'https://audio.example/2')
  assert.equal(a.loads, 2)
})

test('sharing sends a local JSON file when supported; cancellation does not start a second download', async () => {
  const shared = []
  const log = diagnostics({ canShare: true, shared: async (value) => shared.push(value) })
  log.recordAudioEvent('playing', audio())
  await log.shareWebLog()
  assert.equal(shared.length, 1)
  assert.equal(shared[0].files[0].type, 'application/json')
  assert.doesNotMatch(await shared[0].files[0].text(), /https:|SECRET|PRIVATE/)
  assert.equal(log.links.length, 0)
  const cancelled = diagnostics({ canShare: true, shared: async () => { throw new DOMException('Cancelled', 'AbortError') } })
  await cancelled.shareWebLog()
  assert.equal(cancelled.links.length, 0)
})

test('unsupported or rejected sharing falls back to a local JSON download and releases its object URL', async () => {
  for (const options of [{}, { canShare: true, shared: async () => { throw new Error('Unavailable') } }]) {
    const log = diagnostics(options)
    await log.shareWebLog()
    assert.equal(log.links.length, 1)
    assert.equal(log.links[0].clicked, true)
    assert.equal(log.links[0].removed, true)
    assert.match(log.links[0].download, /^pletina-audio-\d{4}-\d{2}-\d{2}\.json$/)
    assert.equal(JSON.parse(await log.blob.text()).format, 'pletina-web-audio-log')
    log.timers.forEach((callback) => callback())
    assert.deepEqual(log.revoked, ['blob:local-test'])
  }
})
