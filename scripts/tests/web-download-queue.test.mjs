import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import ts from 'typescript'

const compile = async file => ts.transpileModule(await readFile(new URL('../../web-port/' + file + '.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText
const store = {}, queue = {}
new Function('exports', await compile('download-store'))(store)
new Function('exports', 'require', await compile('download-queue'))(queue, path => path === './download-store' ? store : assert.fail(path))
const track = id => ({ id, title: 'Canción ' + id, duration: 180, explicit: false, artistId: 1, artistName: 'Artista',
  albumId: 2, albumTitle: 'Disco', albumArtistId: 1, cover: null })
const journal = factory => queue.createDownloadQueueJournal({ indexedDB: factory })

test('download queue survives reopening with stable metadata, original FIFO and no resolved addresses', async () => {
  const factory = new IDBFactory(), first = journal(factory)
  const rows = [track(2), { ...track(1), url: 'https://example.googlevideo.com/videoplayback?sig=temporary', source: { url: 'blob:temporary' } }]
  await first.write(rows)
  const restored = await journal(factory).read()
  assert.deepEqual(restored, [track(2), track(1)])
  assert.doesNotMatch(JSON.stringify(restored), /googlevideo|sig=|blob:|"url"|"source"/)
})

test('download queue deduplicates by ID without changing first position or its metadata', async () => {
  const saved = journal(new IDBFactory())
  await saved.write([track(1), track(2), { ...track(1), title: 'Later duplicate' }])
  assert.deepEqual(await saved.read(), [track(1), track(2)])
})

test('queued snapshots are copied before awaiting IDB and cannot finish out of order', async () => {
  const saved = journal(new IDBFactory()), rows = [track(1)]
  const first = saved.write(rows)
  rows[0].title = 'Mutated later'; rows.push(track(2))
  await first
  assert.deepEqual(await saved.read(), [track(1)])
  const second = saved.write([track(2)]), last = saved.write([track(3), track(4)])
  await Promise.all([second, last])
  assert.deepEqual(await saved.read(), [track(3), track(4)])
})

test('completed or cancelled pending jobs remain removed after reopening', async () => {
  const factory = new IDBFactory(), saved = journal(factory)
  await saved.write([track(1), track(2)])
  await saved.write([track(2)])
  assert.deepEqual(await journal(factory).read(), [track(2)])
  await saved.write([])
  assert.deepEqual(await journal(factory).read(), [])
})

test('invalid metadata and a signed artwork address cannot replace a durable queue', async () => {
  const saved = journal(new IDBFactory())
  await saved.write([track(1)])
  for (const bad of [null, [{ ...track(2), id: -1 }], [{ ...track(2), title: '' }],
    [{ ...track(2), cover: 'https://example.test/art?token=temporary' }]]) {
    await assert.rejects(saved.write(bad))
    assert.deepEqual(await saved.read(), [track(1)])
  }
})

test('job count and metadata byte limits fail without destroying a previous checkpoint', async () => {
  const saved = journal(new IDBFactory())
  await saved.write([track(1)])
  await assert.rejects(saved.write(Array.from({ length: 10001 }, (_, i) => track(i + 1))), /demasiado grande/)
  await assert.rejects(saved.write(Array.from({ length: 700 }, (_, i) => ({ ...track(i + 1), title: 'x'.repeat(4000) }))), /demasiado grande/)
  assert.deepEqual(await saved.read(), [track(1)])
})

test('an aborted write rolls back, reports failure and permits a later explicit retry', async t => {
  const saved = journal(new IDBFactory())
  await saved.write([track(1)])
  const original = IDBObjectStore.prototype.put
  const mock = t.mock.method(IDBObjectStore.prototype, 'put', function (...args) {
    const result = Reflect.apply(original, this, args)
    if (this.name === 'state') this.transaction.abort()
    return result
  })
  await assert.rejects(saved.write([track(2)]), /conservar la cola/)
  mock.mock.restore()
  assert.deepEqual(await saved.read(), [track(1)])
  await saved.write([track(3)])
  assert.deepEqual(await saved.read(), [track(3)])
})

test('corrupt stored metadata is reported rather than executed or silently rewritten', async () => {
  const factory = new IDBFactory(), saved = journal(factory)
  await saved.write([track(1)])
  const open = factory.open(queue.DOWNLOAD_QUEUE_DATABASE, 1)
  const db = await new Promise((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error) })
  await new Promise((resolve, reject) => {
    const tx = db.transaction('state', 'readwrite')
    tx.objectStore('state').put({ version: 2, tracks: [track(99)] }, 'pending')
    tx.oncomplete = resolve; tx.onabort = () => reject(tx.error)
  })
  await assert.rejects(saved.read(), /no es válida/)
  db.close()
})
