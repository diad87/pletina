// UI unit audit: runs the real component script with Svelte's rune compiler.
// API, lifecycle and object URLs are controlled; this does not render a browser
// or exercise IndexedDB, file persistence, navigation, media or mobile behavior.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { compileModule } from 'svelte/compiler'
import * as svelte from 'svelte/internal/client'
import ts from 'typescript'

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const component = await readFile(new URL('../../src/views/LibraryBackup.svelte', import.meta.url), 'utf8')
const script = component.match(/<script lang="ts">([\s\S]*?)<\/script>/)?.[1]
assert.ok(script, 'The real LibraryBackup component script must be present')
const exposed = script + `
export const audit = {
  prepare, readFile, cancel, restore,
  setInput(value) { input = value },
  get phase() { return phase }, get busy() { return busy },
  get error() { return error }, get success() { return success },
  get downloadUrl() { return downloadUrl }, get downloadName() { return downloadName },
  get exported() { return exported }, get preview() { return preview },
  get fileName() { return fileName }, get content() { return content }
}`
const js = ts.transpileModule(exposed, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
}).outputText
const code = ts.transpileModule(compileModule(js, { filename: 'library-backup-audit.svelte.js' }).js.code, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText
const summary = { likes: 3, playlists: 2, entries: 6, albums: 1, artists: 1, history: 4, podcasts: 1, progress: 2 }
const document = { format: 'test-ui-only', payload: { orderedIds: [7, 3, 7] } }
const text = JSON.stringify(document)

function harness(options = {}) {
  const calls = [], urls = [], revoked = [], lifecycle = [], navCalls = []
  const api = {
    exportWebLibrary: async () => { calls.push(['export']); return options.export ? options.export() : document },
    previewWebLibraryBackup: async (value) => { calls.push(['preview', value]); return options.preview ? options.preview(value) : summary },
    importWebLibraryBackup: async (value) => { calls.push(['import', value]); return options.import ? options.import(value) : { playlists: 2, likes: 3 } },
    invalidateDiscovery: () => { calls.push(['invalidate']) },
  }
  const library = {
    version: 4, historyVersion: 6,
    load: async () => { calls.push(['load']); return options.load ? options.load() : true },
  }
  const modules = {
    'svelte/internal/client': svelte,
    svelte: { onDestroy: (callback) => lifecycle.push(callback) },
    '../lib/api': api,
    '../lib/library.svelte': { library },
    '../lib/nav.svelte': { nav: { ready: () => navCalls.push('ready') } },
    '../lib/theme.svelte': { theme: { clear() {}, neutral() {} } },
  }
  const exports = {}
  const URL = {
    createObjectURL: (blob) => {
      assert.ok(blob instanceof Blob)
      const url = `blob:ui-audit-${urls.length + 1}`
      urls.push({ url, blob })
      return url
    },
    revokeObjectURL: (url) => revoked.push(url),
  }
  new Function('require', 'exports', 'URL', 'Blob', code)((name) => {
    assert.ok(name in modules, `Unmocked UI dependency: ${name}`)
    return modules[name]
  }, exports, URL, Blob)
  // A bound browser input is not a plain object proxied by $state. This small
  // class keeps the controlled value reference equally stable in the unit.
  class InputValue { value = 'selected.json' }
  const audit = exports.audit, input = new InputValue()
  audit.setInput(input)
  return {
    audit, calls, urls, revoked, library, navCalls, input,
    destroy() { for (const callback of lifecycle.splice(0)) callback() },
    counts: (kind) => calls.filter(([value]) => value === kind).length,
    read(value = text, extra = {}) {
      return audit.readFile({ currentTarget: { files: [{ name: 'selected.json', size: value.length, text: async () => value, ...extra }] } })
    },
  }
}

function noSharedMutation(h) {
  assert.equal(h.counts('import'), 0)
  assert.equal(h.counts('load'), 0)
  assert.equal(h.counts('invalidate'), 0)
  assert.equal(h.library.version, 4)
  assert.equal(h.library.historyVersion, 6)
  assert.deepEqual(h.navCalls, ['ready'])
}

test('backup UI prepares one export and revokes only its own object URLs on replacement and destroy', async () => {
  const pending = deferred(), h = harness({ export: () => pending.promise })
  const first = h.audit.prepare()
  await h.audit.prepare()
  assert.equal(h.audit.phase, 'exporting'); assert.equal(h.audit.busy, true)
  assert.equal(h.counts('export'), 1); assert.equal(h.urls.length, 0)
  pending.resolve(document); await first
  assert.equal(h.audit.phase, 'idle'); assert.equal(h.audit.busy, false)
  assert.deepEqual(h.audit.exported, summary)
  assert.match(h.audit.downloadName, /^pletina-biblioteca-\d{4}-\d{2}-\d{2}\.json$/)
  assert.equal(h.urls[0].blob.type, 'application/json')
  assert.deepEqual(JSON.parse(await h.urls[0].blob.text()), document)
  await h.audit.prepare()
  assert.deepEqual(h.revoked, ['blob:ui-audit-1'])
  h.destroy()
  assert.deepEqual(h.revoked, ['blob:ui-audit-1', 'blob:ui-audit-2'])
  noSharedMutation(h)
})

for (const stage of ['export', 'preview']) test(`backup UI ignores ${stage} results after leaving the page without creating a Blob URL`, async () => {
  const pending = deferred(), h = harness({ [stage]: () => pending.promise })
  const operation = h.audit.prepare()
  await flush()
  assert.equal(h.counts(stage), 1)
  h.destroy()
  pending.resolve(stage === 'export' ? document : summary)
  await operation
  assert.equal(h.urls.length, 0); assert.deepEqual(h.revoked, [])
  assert.equal(h.audit.downloadUrl, ''); assert.equal(h.audit.exported, null)
  if (stage === 'export') assert.equal(h.counts('preview'), 0)
  noSharedMutation(h)
})

test('backup UI previews a file without importing and cancelling its review makes restore a no-op', async () => {
  const h = harness()
  await h.read()
  assert.equal(h.audit.phase, 'review'); assert.deepEqual(h.audit.preview, summary)
  assert.equal(h.audit.fileName, 'selected.json'); assert.equal(h.audit.content, text)
  assert.deepEqual(h.calls, [['preview', text]])
  noSharedMutation(h)
  h.audit.cancel(); await h.audit.restore()
  assert.equal(h.audit.phase, 'idle'); assert.equal(h.audit.preview, null)
  assert.equal(h.audit.content, null); assert.equal(h.audit.fileName, ''); assert.equal(h.input.value, '')
  noSharedMutation(h)
})

for (const stage of ['reading', 'preview']) test(`backup UI ignores a pending file ${stage} result after destroy`, async () => {
  const pending = deferred(), h = harness(stage === 'preview' ? { preview: () => pending.promise } : {})
  const operation = h.read(text, stage === 'reading' ? { text: () => pending.promise } : {})
  await flush()
  assert.equal(h.audit.phase, 'reading')
  h.destroy()
  pending.resolve(stage === 'reading' ? text : summary)
  await operation
  assert.equal(h.audit.preview, null); assert.equal(h.audit.content, null)
  assert.equal(h.audit.error, ''); assert.equal(h.urls.length, 0)
  if (stage === 'reading') assert.equal(h.counts('preview'), 0)
  noSharedMutation(h)
})

test('backup UI rejects an oversized file before reading or previewing it', async () => {
  let reads = 0
  const h = harness()
  await h.read('', { size: 10 * 1024 * 1024 + 1, text: async () => { reads++; throw new Error('must not read') } })
  assert.equal(reads, 0); assert.equal(h.counts('preview'), 0)
  assert.equal(h.audit.phase, 'idle'); assert.equal(h.audit.preview, null)
  assert.match(h.audit.error, /10 MB/); assert.equal(h.input.value, '')
  noSharedMutation(h)
})

test('backup UI imports once on explicit confirmation, even with repeated taps before shared refresh completes', async () => {
  const imported = deferred(), loaded = deferred()
  const h = harness({ import: () => imported.promise, load: () => loaded.promise })
  await h.read()
  const operation = h.audit.restore()
  await h.audit.restore(); h.audit.cancel(); await h.audit.prepare(); await h.read('another file')
  assert.equal(h.audit.phase, 'importing'); assert.equal(h.audit.busy, true)
  assert.deepEqual(h.calls, [['preview', text], ['import', text]])
  imported.resolve({ playlists: 2, likes: 3 }); await flush()
  await h.audit.restore()
  assert.equal(h.counts('import'), 1); assert.equal(h.counts('load'), 1)
  loaded.resolve(true); await operation
  assert.equal(h.audit.phase, 'idle'); assert.equal(h.audit.preview, null); assert.equal(h.audit.content, null)
  assert.match(h.audit.success, /2 listas y 3 favoritos/)
  assert.equal(h.library.version, 5); assert.equal(h.library.historyVersion, 7)
  assert.equal(h.counts('invalidate'), 1); assert.deepEqual(h.navCalls, ['ready'])
  await h.audit.restore()
  assert.equal(h.counts('import'), 1, 'A successful import consumes the reviewed input')
})

test('backup UI refreshes committed shared library state after navigation without changing the disposed view', async () => {
  const imported = deferred(), h = harness({ import: () => imported.promise })
  await h.read()
  const operation = h.audit.restore()
  h.destroy()
  imported.resolve({ playlists: 2, likes: 3 }); await operation
  assert.equal(h.counts('import'), 1); assert.equal(h.counts('load'), 1); assert.equal(h.counts('invalidate'), 1)
  assert.equal(h.library.version, 5); assert.equal(h.library.historyVersion, 7)
  assert.equal(h.audit.success, ''); assert.equal(h.audit.error, '')
  assert.equal(h.audit.phase, 'importing', 'No state update is applied to the disposed page')
  assert.deepEqual(h.navCalls, ['ready']); assert.equal(h.urls.length, 0)
})

test('backup UI keeps the reviewed input after a failed import and permits one explicit retry', async () => {
  let attempts = 0
  const h = harness({ import: async () => { if (++attempts === 1) throw new Error('storage temporarily unavailable'); return { playlists: 2, likes: 3 } } })
  await h.read(); await h.audit.restore()
  assert.equal(h.audit.phase, 'review'); assert.deepEqual(h.audit.preview, summary)
  assert.equal(h.audit.content, text); assert.match(h.audit.error, /storage temporarily unavailable/)
  assert.equal(h.counts('load'), 0); assert.equal(h.counts('invalidate'), 0)
  await h.audit.restore()
  assert.equal(h.counts('import'), 2); assert.equal(h.counts('load'), 1)
  assert.equal(h.audit.error, ''); assert.equal(h.audit.phase, 'idle')
  assert.match(h.audit.success, /Copia añadida/); assert.deepEqual(h.navCalls, ['ready'])
})

test('backup UI does not duplicate a committed import if refreshing the library fails', async () => {
  const h = harness({ load: async () => { throw new Error('shared refresh unavailable') } })
  await h.read(); await h.audit.restore(); await h.audit.restore()
  assert.equal(h.counts('import'), 1); assert.equal(h.counts('load'), 1)
  assert.equal(h.audit.phase, 'idle'); assert.equal(h.audit.content, null); assert.equal(h.audit.preview, null)
  assert.match(h.audit.error, /ya se ha guardado/)
  assert.doesNotMatch(h.audit.error, /No se pudo importar/)
  assert.deepEqual(h.navCalls, ['ready'])
})

test('backup UI reports a stale shared refresh without retrying the committed merge', async () => {
  const h = harness({ load: async () => false })
  await h.read(); await h.audit.restore(); await h.audit.restore()
  assert.equal(h.counts('import'), 1); assert.equal(h.library.version, 5); assert.equal(h.library.historyVersion, 7)
  assert.equal(h.counts('invalidate'), 1)
  assert.match(h.audit.success, /Vuelve a abrir Tu biblioteca/)
  assert.deepEqual(h.navCalls, ['ready'])
})

for (const stage of ['export', 'preview', 'read']) test(`backup UI can retry a failed ${stage} without retaining an obsolete review or Blob`, async () => {
  let attempts = 0
  const failOnce = async (value) => { if (++attempts === 1) throw new Error('temporary failure'); return value }
  const h = harness(stage === 'export' ? { export: () => failOnce(document) } : stage === 'preview' ? { preview: () => failOnce(summary) } : {})
  const operation = () => stage === 'read' ? h.read(text, { text: () => failOnce(text) }) : h.audit.prepare()
  await operation()
  assert.equal(h.audit.phase, 'idle'); assert.match(h.audit.error, /temporary failure/)
  assert.equal(h.audit.preview, null); assert.equal(h.audit.content, null); assert.equal(h.urls.length, 0)
  await operation()
  assert.equal(h.audit.error, '')
  if (stage === 'read') { assert.equal(h.audit.phase, 'review'); assert.deepEqual(h.audit.preview, summary) }
  else { assert.equal(h.audit.phase, 'idle'); assert.equal(h.urls.length, 1) }
  noSharedMutation(h)
})
