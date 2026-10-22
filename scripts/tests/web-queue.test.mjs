import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeWebQueue, readWebQueue, writeWebQueue, WEB_QUEUE_KEY } from '../../web-port/queue-persistence.ts'
import { deferred, flush, harness, item, playable } from './helpers/player-harness.mjs'
import { toQuery } from '../../src/lib/queue.ts'

function memory() {
  const data = new Map(), writes = []
  let reads = 0
  return { data, writes, get reads() { return reads },
    getItem(key) { reads++; return data.get(key) ?? null },
    setItem(key, value) { data.set(key, value); writes.push({ key, value }) },
    removeItem(key) { data.delete(key) },
  }
}
const snapshot = (extra = {}) => ({ version: 1, savedAt: 123, queue: [item(1), item(2), item(1)],
  order: [2, 0, 1], pos: 1, context: 'Una lista', userQueue: [{ key: 5, item: item(90) }], manual: null,
  position: 45, duration: 180, repeat: 'all', shuffle: true, recorded: true, ...extra })
const web = (storage, options = {}) => harness({ inPwa: true, storage, ...options })

test('snapshot solo guarda metadatos permitidos, orden y duplicados; nunca Playable ni URLs de audio', () => {
  const secret = 'https://rr1.googlevideo.com/audio?sig=DO_NOT_PERSIST'
  const first = item(1)
  first.track.url = secret
  first.track.artist.pictureMedium = secret
  first.playable = { url: secret, local: false }
  first.cover = secret
  const value = normalizeWebQueue(snapshot({ queue: [first], order: [0], pos: 0, source: secret }))
  assert.doesNotMatch(JSON.stringify(value), /DO_NOT_PERSIST|playable|pictureMedium|googlevideo/)
  assert.equal(value.queue[0].cover, null)
  assert.equal(value.queue[0].track.titleVersion, null)
  const stored = memory()
  assert.equal(writeWebQueue(stored, value), true)
  assert.deepEqual(readWebQueue(stored), value)
  const copy = readWebQueue(stored); copy.queue[0].track.title = 'Mutado'
  assert.equal(readWebQueue(stored).queue[0].track.title, 'Canción 1')
})

test('restaurar la cola conserva la grabación y versión para resolver otra vez, sin persistir la fuente', async () => {
  const storage = memory(), original = item(1), queries = []
  original.track.isrc = 'QM6N21424821'
  original.track.titleVersion = 'Original'
  const provider = { provider: 'audius', id: 'stable-source', expiresAt: 1_800_000_000_000, startAt: 8.94,
    download: { allowed: false } }
  const first = web(storage, { resolve: async query => {
    queries.push(query)
    return { ...playable(1), url: 'https://audio.example/temporary?token=DO_NOT_PERSIST', source: provider }
  } })
  first.player.playQueue([original], 0)
  await flush()
  first.player.toggle()
  await flush()
  const raw = storage.data.get(WEB_QUEUE_KEY)
  assert.doesNotMatch(raw, /DO_NOT_PERSIST|stable-source|expiresAt|startAt|download|temporary/)
  const restored = web(storage, { resolve: async query => { queries.push(query); return playable(2) } })
  assert.equal(restored.player.status, 'paused')
  assert.equal(restored.player.current.track.isrc, original.track.isrc)
  assert.equal(restored.player.current.track.titleVersion, original.track.titleVersion)
  assert.deepEqual(restored.resolutions, [])
  restored.player.toggle()
  await flush()
  assert.equal(queries.length, 2)
  for (const query of queries) {
    assert.equal(query.isrc, 'QM6N21424821')
    assert.equal(query.titleVersion, 'Original')
    assert.equal(query.artist, 'Artista')
    assert.equal(query.album, 'Álbum')
    assert.doesNotMatch(JSON.stringify(query), /temporary|source|expiresAt/)
  }
  assert.deepEqual(restored.sources, ['https://audio.test/2'])
})

test('colas antiguas sin identificación y metadatos nulos siguen siendo resolubles sin inventar una versión', () => {
  for (const metadata of [{}, { isrc: null, titleVersion: null }]) {
    const value = item(1)
    Object.assign(value.track, metadata)
    const stored = normalizeWebQueue(snapshot({ queue: [value], order: [0], pos: 0, userQueue: [] }))
    const query = toQuery(stored.queue[0])
    assert.equal(query.isrc, null)
    assert.equal(query.titleVersion, null)
    assert.equal(query.id, 1)
    assert.equal(query.artist, 'Artista')
  }
})

test('restaurar cero aplica el inicio verificado al pulsar play y una posición posterior conserva los segundos reales', async () => {
  for (const position of [0, 32]) {
    const storage = memory()
    writeWebQueue(storage, snapshot({ queue: [item(1)], order: [0], pos: 0, userQueue: [], position, duration: 187.1804 }))
    const h = web(storage, { duration: () => 187.1804, resolve: async () => ({ ...playable(), videoId: '',
      source: { provider: 'verified', id: 'recording', startAt: 8.94, download: { allowed: true } } }) })
    assert.equal(h.player.time, position)
    assert.equal(h.player.status, 'paused')
    assert.equal(h.audio.plays, 0)
    h.player.toggle()
    await flush()
    assert.equal(h.audio.currentTime, Math.max(position, 8.94))
    assert.equal(h.player.time, Math.max(position, 8.94))
    assert.equal(h.player.duration, 187.1804)
    assert.equal(h.audio.plays, 1)
    assert.doesNotMatch(storage.data.get(WEB_QUEUE_KEY), /source|recording|startAt|download/)
  }
})

test('corrupción de cursores, permutación, claves DJ, duración o versión rechaza la cola entera', () => {
  for (const change of [{ version: 2 }, { pos: -1 }, { pos: 3 }, { order: [0, 0, 2] }, { order: [0, 1] },
    { order: [0, 1, 3] }, { position: NaN }, { duration: Infinity }, { shuffle: 'yes' }, { repeat: 'random' },
    { userQueue: [{ key: 1, item: item(90) }, { key: 1, item: item(91) }] }, { userQueue: [{ key: Number.MAX_SAFE_INTEGER, item: item(90) }] }]) {
    assert.throws(() => normalizeWebQueue(snapshot(change)))
  }
  const storage = memory()
  storage.data.set(WEB_QUEUE_KEY, '{broken')
  assert.equal(readWebQueue(storage), null)
  assert.equal(storage.data.has(WEB_QUEUE_KEY), false)
  storage.data.set(WEB_QUEUE_KEY, JSON.stringify(snapshot({ pos: 999 })))
  assert.equal(readWebQueue(storage), null)
})

test('persistencia acotada y fallos de almacenamiento no dejan una cola antigua que pueda reaparecer', () => {
  const storage = memory()
  storage.data.set('another-feature', 'keep')
  assert.equal(writeWebQueue(storage, snapshot()), true)
  assert.throws(() => normalizeWebQueue(snapshot({ queue: Array.from({ length: 10001 }, () => item(1)), userQueue: [] })))
  const long = item(1); long.track.title = 'é'.repeat(4000)
  assert.equal(writeWebQueue(storage, snapshot({ queue: Array.from({ length: 300 }, () => long),
    order: Array.from({ length: 300 }, (_, i) => i), pos: 0, userQueue: [] })), false)
  assert.equal(storage.data.has(WEB_QUEUE_KEY), false)
  assert.equal(storage.data.get('another-feature'), 'keep')
  storage.setItem = () => { throw new DOMException('Quota', 'QuotaExceededError') }
  assert.equal(writeWebQueue(storage, snapshot()), false)
  assert.equal(readWebQueue({ getItem() { throw new Error('Disabled') }, removeItem() { throw new Error('Disabled') } }), null)
  assert.equal(writeWebQueue(undefined, snapshot()), false)
})

test('cola vacía y reproducción DJ sin disco original se serializan sin inventar posiciones', () => {
  const empty = normalizeWebQueue(snapshot({ queue: [], order: [], pos: -1, userQueue: [], position: 123, duration: 180 }))
  assert.equal(empty.position, 0); assert.equal(empty.duration, 0)
  const manual = normalizeWebQueue(snapshot({ queue: [], order: [], pos: -1, manual: item(90), position: 95 }))
  assert.equal(manual.manual.track.id, 90)
  assert.equal(manual.position, 95)
  assert.throws(() => normalizeWebQueue(snapshot({ queue: [], order: [], pos: -1 })), /sin canción/)
})

test('pausar y reiniciar rehidrata la misma cola y segundo sin autoplay; Play vuelve a resolver la fuente', async () => {
  const storage = memory(), first = web(storage)
  first.player.playQueue([item(1), item(2)], 0, 'Álbum completo')
  await flush()
  first.player.seek(47.5)
  first.player.toggle()
  await flush()
  const restarted = web(storage, { resolve: async (track) => playable(track.id + 100) })
  assert.equal(restarted.player.status, 'paused')
  assert.equal(restarted.player.current.track.id, 1)
  assert.equal(restarted.player.time, 47.5)
  assert.equal(restarted.player.context, 'Álbum completo')
  assert.deepEqual(restarted.player.queue.map(value => value.track.id), [1, 2])
  assert.deepEqual(restarted.sources, [])
  assert.deepEqual(restarted.resolutions, [])
  assert.equal(restarted.audio.plays, 0)
  restarted.player.toggle()
  await flush()
  assert.equal(restarted.player.status, 'playing')
  assert.equal(restarted.audio.currentTime, 47.5)
  assert.equal(restarted.sources[0], 'https://audio.test/101', 'no previous stream address was retained')
})

test('cola DJ activa, apariciones duplicadas, reordenación, nuevas claves y vaciado sobreviven al reinicio', async () => {
  const storage = memory(), h = web(storage)
  h.player.playQueue([item(1), item(2), item(1)], 0, 'Lista duplicada')
  await flush()
  h.player.addToQueue([item(90), item(90), item(91)])
  const [a, b, c] = h.player.userQueue.map(value => value.key)
  h.player.moveInQueue(c, 0)
  h.player.removeFromQueue(a)
  h.player.playFromQueue(c)
  await flush()
  h.player.seek(12)
  h.player.toggle()
  await flush()
  const restored = web(storage)
  assert.equal(restored.player.manual.track.id, 91)
  assert.deepEqual(restored.player.userQueue.map(value => [value.key, value.item.track.id]), [[b, 90]])
  assert.deepEqual(restored.player.queue.map(value => value.track.id), [1, 2, 1])
  assert.equal(restored.player.time, 12)
  restored.player.addToQueue([item(92)])
  assert.ok(restored.player.userQueue[1].key > b)
  restored.player.clearQueue()
  await flush()
  const cleared = web(storage)
  assert.deepEqual(cleared.player.userQueue, [])
  assert.equal(cleared.player.current.track.id, 91, 'clear DJ queue leaves the current song intact')
  cleared.player.next()
  await flush()
  assert.equal(cleared.player.current.track.id, 2, 'then continues the original list cursor')
})

test('snapshot síncrono no puede restaurar tarde ni un write pendiente sustituir una elección más nueva', async () => {
  const storage = memory(), oldSource = deferred()
  writeWebQueue(storage, snapshot({ queue: [item(1)], order: [0], pos: 0, userQueue: [] }))
  const h = web(storage, { resolve: (track) => track.id === 2 ? oldSource.promise : Promise.resolve(playable(track.id)) })
  assert.equal(h.player.current.track.id, 1)
  h.player.playQueue([item(2)], 0)
  h.player.playQueue([item(3)], 0)
  await flush()
  assert.equal(readWebQueue(storage).queue[0].track.id, 3)
  oldSource.resolve(playable(2))
  await flush()
  assert.equal(h.player.current.track.id, 3)
  assert.equal(readWebQueue(storage).queue[0].track.id, 3)
  assert.deepEqual(h.sources, ['https://audio.test/3'])
})

test('timeupdate guarda como máximo cada diez segundos; pagehide conserva el cursor exacto inmediatamente', async () => {
  const storage = memory(), h = web(storage)
  h.player.playQueue([item(1)], 0)
  await flush()
  const initial = storage.writes.length
  h.elapse(9000); h.audio.currentTime = 2; h.audio.dispatchEvent(new Event('timeupdate'))
  await flush()
  assert.equal(storage.writes.length, initial)
  h.elapse(1000); h.audio.currentTime = 12; h.audio.dispatchEvent(new Event('timeupdate'))
  await flush()
  assert.equal(storage.writes.length, initial + 1)
  assert.equal(readWebQueue(storage).position, 12)
  h.audio.currentTime = 13.25
  h.events.dispatchEvent(new Event('pagehide'))
  assert.equal(readWebQueue(storage).position, 13.25, 'must not depend on the last UI timeupdate')
})

test('ended entrega src/play antes de escribir; fin de cola restaura pausado en cero', async () => {
  const storage = memory(), h = web(storage)
  h.player.playQueue([item(1), item(2)], 0)
  await flush()
  const writes = storage.writes.length, plays = h.audio.plays
  h.audio.paused = true
  h.audio.dispatchEvent(new Event('ended'))
  assert.equal(h.audio.plays, plays + 1, 'next play stays synchronous in ended')
  assert.equal(storage.writes.length, writes, 'no localStorage write in the critical handoff')
  await flush()
  assert.equal(readWebQueue(storage).pos, 1)
  h.audio.currentTime = 180
  h.audio.paused = true
  h.audio.dispatchEvent(new Event('ended'))
  await flush()
  assert.equal(readWebQueue(storage).position, 0)
  const restored = web(storage)
  assert.equal(restored.player.current.track.id, 2)
  assert.equal(restored.player.status, 'paused')
  assert.equal(restored.player.time, 0)
})

test('reiniciar no duplica historial y conserva aleatorio, repetición y posición de episodio', async () => {
  const storage = memory(), h = web(storage)
  h.player.playQueue([item(1), item(2)], 0)
  await flush()
  h.audio.currentTime = 31
  h.audio.dispatchEvent(new Event('timeupdate'))
  h.player.toggleShuffle()
  h.player.cycleRepeat()
  h.player.toggle()
  await flush()
  const order = [...h.player.order]
  assert.deepEqual(h.records, [1])
  const restored = web(storage)
  assert.deepEqual([...restored.player.order], order)
  assert.equal(restored.player.repeat, 'all')
  assert.equal(restored.player.shuffle, true)
  restored.player.toggle()
  await flush()
  restored.audio.currentTime = 35
  restored.audio.dispatchEvent(new Event('timeupdate'))
  await flush()
  assert.deepEqual(restored.records, [], 'this is the same listening session')
  const episode = item(750_000_000_000_001)
  writeWebQueue(storage, snapshot({ queue: [episode], order: [0], pos: 0, userQueue: [], position: 125 }))
  const podcast = web(storage, { progress: new Map([[episode.track.id, { position: 3, completed: false }]]) })
  podcast.player.toggle()
  await flush()
  assert.equal(podcast.audio.currentTime, 125, 'queue checkpoint wins for the restored current episode')
})

test('restaurar y reproducir una descarga usa resolve y la ruta local del service worker sin volver a red', async () => {
  const storage = memory()
  writeWebQueue(storage, snapshot({ queue: [item(1)], order: [0], pos: 0, userQueue: [], position: 20 }))
  const h = web(storage, { resolve: async () => ({ ...playable(1), local: true, url: 'https://app.example/pletina/__audio__/1' }) })
  assert.deepEqual(h.resolutions, [])
  h.player.toggle()
  await flush()
  assert.deepEqual(h.resolutions, [[1, false]])
  assert.equal(h.sources[0], 'https://app.example/pletina/__audio__/1')
  assert.equal(h.player.status, 'playing')
  assert.equal(h.audio.currentTime, 20)
})

test('el reproductor nativo no lee ni escribe el snapshot web', async () => {
  const storage = memory()
  storage.data.set(WEB_QUEUE_KEY, JSON.stringify(snapshot()))
  const h = harness({ storage })
  h.player.playQueue([item(3)], 0)
  await flush()
  h.audio.currentTime = 12
  h.audio.dispatchEvent(new Event('timeupdate'))
  h.events.dispatchEvent(new Event('pagehide'))
  await flush()
  assert.equal(storage.reads, 0)
  assert.equal(storage.writes.length, 0)
})
