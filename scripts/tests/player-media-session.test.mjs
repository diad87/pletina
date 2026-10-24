import assert from 'node:assert/strict'
import test from 'node:test'
import { writeWebQueue } from '../../web-port/queue-persistence.ts'
import { deferred, flush, harness, item, playable } from './helpers/player-harness.mjs'

const episode = () => item(750_000_000_000_001)
function session() {
  const handlers = new Map(), positions = []
  return {
    handlers, positions, playbackState: 'none', metadata: null,
    setActionHandler(action, handler) { handlers.set(action, handler) },
    setPositionState(position) { positions.push(position) },
    action(action, details = {}) { handlers.get(action)({ action, ...details }) },
  }
}
class Metadata { constructor(value) { Object.assign(this, value) } }
const web = (ms, options = {}) => harness({ inPwa: true, mediaSession: ms, metadata: Metadata, ...options })

test('repeated car play commands do not restart loading or playing, and pause cancels pending audio', async () => {
  const pending = deferred(), ms = session()
  const h = web(ms, { resolve: () => pending.promise })
  h.player.playQueue([item()], 0)
  ms.action('play')
  ms.action('play')
  assert.deepEqual(h.resolutions, [[1, false]])
  ms.action('pause')
  ms.action('pause')
  pending.resolve(playable())
  await flush()
  assert.equal(h.player.status, 'paused')
  assert.equal(ms.playbackState, 'paused')
  assert.equal(h.audio.plays, 0)
  ms.action('play')
  await flush()
  ms.action('play')
  assert.equal(h.audio.plays, 1)
  assert.equal(h.player.status, 'playing')
})

test('podcast car seeks use 15 seconds back and 30 forward, respect requested offsets and stay in the audio', async () => {
  const ms = session(), h = web(ms, { duration: () => 1000 })
  h.player.playQueue([episode()], 0)
  await flush()
  h.player.seek(100)
  ms.action('seekbackward')
  assert.equal(h.audio.currentTime, 85)
  ms.action('seekforward')
  assert.equal(h.audio.currentTime, 115)
  ms.action('seekbackward', { seekOffset: 25 })
  assert.equal(h.audio.currentTime, 90)
  ms.action('seekforward', { seekOffset: 5000 })
  assert.equal(h.audio.currentTime, 1000)
  ms.action('seekbackward', { seekOffset: 5000 })
  assert.equal(h.audio.currentTime, 0)
  ms.action('seekto', { seekTime: 250 })
  ms.action('seekto', { seekTime: NaN })
  ms.action('seekto', { seekTime: Infinity })
  assert.equal(h.audio.currentTime, 250)
  assert.deepEqual(ms.positions.at(-1), { duration: 1000, position: 250, playbackRate: 1 })
  assert.equal(h.player.status, 'playing')
})

test('car seek during podcast resolution wins over the saved checkpoint', async () => {
  const pending = deferred(), ms = session(), current = episode()
  const h = web(ms, { resolve: () => pending.promise, duration: () => 1000 })
  h.progress.set(current.track.id, { position: 500, completed: false })
  h.player.playQueue([current], 0)
  ms.action('seekforward', { seekOffset: 40 })
  pending.resolve(playable(current.track.id))
  await flush()
  assert.equal(h.audio.currentTime, 40)
  assert.equal(ms.positions.at(-1).position, 40)
})

test('car relative seeks read the active audio clock when timeupdate has not reached the page', async () => {
  const ms = session(), h = web(ms, { duration: () => 1000 })
  h.player.playQueue([episode()], 0)
  await flush()
  assert.equal(h.player.time, 0)
  h.audio.currentTime = 100
  ms.action('seekforward')
  assert.equal(h.audio.currentTime, 130)
  assert.equal(h.player.time, 130)
  h.audio.currentTime = 200
  ms.action('seekbackward')
  assert.equal(h.audio.currentTime, 185)
  assert.equal(h.player.time, 185)
  ms.action('pause')
  h.audio.currentTime = 250
  ms.action('seekforward', { seekOffset: 10 })
  assert.equal(h.audio.currentTime, 260, 'prepared paused audio also has a valid position')
  assert.equal(h.player.status, 'paused')
  assert.equal(h.audio.plays, 1, 'seeking never resumes paused audio')
})

test('car relative seeks fall back to the requested position during loading or invalid decoder time', async () => {
  const pending = deferred(), ms = session()
  const h = web(ms, { play: () => pending.promise, duration: () => 1000 })
  h.player.playQueue([episode()], 0)
  await flush()
  h.player.seek(50)
  h.audio.currentTime = 300
  ms.action('seekforward')
  assert.equal(h.player.time, 80, 'loading keeps the requested seek instead of the decoder position')
  h.audio.paused = false
  h.audio.dispatchEvent(new Event('playing'))
  pending.resolve()
  await flush()
  h.audio.currentTime = NaN
  ms.action('seekbackward')
  assert.equal(h.audio.currentTime, 65)
  assert.equal(h.player.time, 65)
})

for (const late of ['resolve', 'reject']) {
  test(`a system interruption during initial play stays paused after late ${late} and one car Play resumes`, async () => {
    const pending = deferred(), ms = session()
    const h = web(ms, { play: audio => {
      if (audio.plays === 1) { audio.paused = false; return pending.promise }
      audio.paused = false
      audio.dispatchEvent(new Event('playing'))
      return Promise.resolve()
    } })
    h.player.playQueue([item()], 0)
    await flush()
    assert.equal(h.player.status, 'loading')
    h.audio.currentTime = 12
    h.audio.pause()
    assert.equal(h.player.status, 'paused')
    assert.equal(ms.playbackState, 'paused')
    assert.equal(h.player.time, 12)
    // Ni una promesa tardía ni un playing de esa intención cancelada autorizan audio.
    h.audio.paused = false
    h.audio.dispatchEvent(new Event('playing'))
    assert.equal(h.audio.paused, true)
    if (late === 'resolve') pending.resolve()
    else pending.reject(new DOMException('Interrupted', 'AbortError'))
    await flush()
    assert.equal(h.player.status, 'paused')
    assert.equal(h.audio.plays, 1)
    assert.deepEqual(h.messages, [])
    ms.action('play')
    await flush()
    assert.equal(h.player.status, 'playing')
    assert.equal(h.audio.currentTime, 12)
    assert.equal(h.audio.plays, 2)
    ms.action('play')
    assert.equal(h.audio.plays, 2, 'repeated car Play remains idempotent')
  })
}

test('one car Play can resume an interruption before the previous play promise settles', async () => {
  const previous = deferred(), ms = session()
  const h = web(ms, { play: audio => {
    audio.paused = false
    if (audio.plays === 1) return previous.promise
    audio.dispatchEvent(new Event('playing'))
    return Promise.resolve()
  } })
  h.player.playQueue([item()], 0)
  await flush()
  h.audio.pause()
  ms.action('play')
  await flush()
  assert.equal(h.player.status, 'playing')
  assert.equal(h.audio.plays, 2)
  previous.reject(new DOMException('Previous interruption', 'AbortError'))
  await flush()
  assert.equal(h.player.status, 'playing')
  assert.equal(h.audio.paused, false)
  assert.equal(h.audio.plays, 2)
  assert.deepEqual(h.messages, [])
})

test('internal source reset pauses do not cancel a new selection or its pending play', async () => {
  const nextSource = deferred(), nextPlay = deferred(), ms = session()
  let playingSecond = false
  const h = web(ms, {
    resolve: query => query.id === 2 ? nextSource.promise : Promise.resolve(playable(query.id)),
    play: audio => {
      audio.paused = false
      if (playingSecond) return nextPlay.promise
      audio.dispatchEvent(new Event('playing'))
      return Promise.resolve()
    },
  })
  h.player.playQueue([item(1)], 0)
  await flush()
  h.player.playQueue([item(2)], 0)
  assert.equal(h.player.status, 'loading', 'the synchronous reset pause does not cancel source resolution')
  h.audio.dispatchEvent(new Event('pause'))
  assert.equal(h.player.status, 'loading', 'a delayed reset pause without an active source is ignored')
  playingSecond = true
  h.audio.duration = NaN
  nextSource.resolve(playable(2))
  await flush()
  assert.equal(h.audio.paused, false)
  h.audio.dispatchEvent(new Event('pause'))
  assert.equal(h.player.status, 'loading', 'an old pause event cannot cancel the resumed element')
  h.audio.dispatchEvent(new Event('playing'))
  nextPlay.resolve()
  await flush()
  assert.equal(h.player.status, 'playing')
  assert.equal(h.player.current.track.id, 2)
  assert.equal(h.audio.plays, 2)
  assert.deepEqual(h.messages, [])
})

test('car stop releases audio and retains the podcast queue and checkpoint for an explicit play', async () => {
  const ms = session(), h = web(ms, { duration: () => 1000 }), current = episode()
  h.player.playQueue([current], 0)
  await flush()
  h.audio.currentTime = 123
  h.audio.dispatchEvent(new Event('timeupdate'))
  ms.action('stop')
  ms.action('stop')
  assert.equal(h.audio.src, '')
  assert.equal(h.audio.paused, true)
  assert.equal(h.player.status, 'idle')
  assert.equal(h.player.current.track.id, current.track.id)
  assert.equal(h.progress.get(current.track.id).position, 123)
  assert.equal(ms.playbackState, 'none')
  assert.equal(ms.positions.at(-1), undefined)
  ms.action('play')
  await flush()
  assert.equal(h.audio.currentTime, 123)
  assert.equal(h.player.status, 'playing')
})

test('car stop during resolution prevents a late source from starting', async () => {
  const pending = deferred(), ms = session(), h = web(ms, { resolve: () => pending.promise })
  h.player.playQueue([item()], 0)
  ms.action('stop')
  pending.resolve(playable())
  await flush()
  assert.equal(h.audio.plays, 0)
  assert.equal(h.player.status, 'idle')
  assert.equal(ms.playbackState, 'none')
  assert.equal(ms.positions.at(-1), undefined)
})

test('a new selection clears the previous position while metadata names the pending song', async () => {
  const pending = deferred(), ms = session()
  const h = web(ms, { resolve: query => query.id === 2 ? pending.promise : Promise.resolve(playable(query.id)) })
  h.player.playQueue([item(1)], 0)
  await flush()
  h.player.seek(80)
  h.player.playQueue([item(2)], 0)
  assert.equal(ms.metadata.title, 'Canción 2')
  assert.equal(ms.playbackState, 'paused')
  assert.equal(ms.positions.at(-1), undefined)
  h.audio.dispatchEvent(new Event('durationchange'))
  assert.equal(ms.positions.at(-1), undefined, 'old decoder duration is not exposed for the new song')
  // El adaptador no reinicia el decoder al asignar src; el navegador sí lo hace.
  h.audio.currentTime = 0
  h.audio.duration = NaN
  pending.resolve(playable(2))
  await flush()
  assert.equal(ms.playbackState, 'playing')
  assert.deepEqual(ms.positions.at(-1), { duration: 180, position: 0, playbackRate: 1 })
})

test('pause and rate changes refresh position; the end of the queue clears it', async () => {
  const ms = session(), h = web(ms)
  h.player.playQueue([item()], 0)
  await flush()
  h.audio.currentTime = 42
  ms.action('pause')
  assert.equal(ms.playbackState, 'paused')
  assert.equal(ms.positions.at(-1).position, 42)
  h.audio.playbackRate = 1.5
  h.audio.dispatchEvent(new Event('ratechange'))
  assert.equal(ms.positions.at(-1).playbackRate, 1.5)
  h.audio.playbackRate = NaN
  h.audio.dispatchEvent(new Event('ratechange'))
  assert.equal(ms.positions.at(-1).playbackRate, 1)
  ms.action('nexttrack')
  assert.equal(ms.playbackState, 'paused')
  assert.equal(h.player.time, 0)
  assert.equal(ms.positions.at(-1), undefined)
})

test('terminal audio errors clear active playback and position while keeping the selected metadata', async () => {
  const ms = session(), h = web(ms, { resolve: async () => ({ ...playable(), local: false }) })
  h.player.playQueue([item()], 0)
  await flush()
  h.audio.currentTime = 12
  h.audio.fail(3)
  await flush()
  assert.equal(h.player.status, 'idle')
  assert.equal(ms.playbackState, 'none')
  assert.equal(ms.positions.at(-1), undefined)
  assert.equal(ms.metadata.title, 'Canción 1')
})

test('restored PWA queue advertises its paused metadata and position without starting audio', () => {
  const data = new Map(), storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) }
  writeWebQueue(storage, {
    version: 1, savedAt: 123, queue: [item()], order: [0], pos: 0, context: 'Álbum',
    userQueue: [], manual: null, position: 67, duration: 181, repeat: 'off', shuffle: false, recorded: false,
  })
  const ms = session(), h = web(ms, { storage })
  assert.equal(ms.metadata.title, 'Canción 1')
  assert.equal(ms.playbackState, 'paused')
  assert.deepEqual(ms.positions.at(-1), { duration: 181, position: 67, playbackRate: 1 })
  assert.equal(h.audio.plays, 0)
  assert.deepEqual(h.resolutions, [])
  h.audio.currentTime = 150
  ms.action('seekforward')
  assert.equal(h.player.time, 77, 'a restored queue uses its saved position, not the unprepared decoder')
  assert.equal(h.audio.plays, 0)
})

test('unsupported car actions, metadata and playback state do not block other handlers or position', async () => {
  const ms = session(), register = ms.setActionHandler
  ms.setActionHandler = function (action, handler) {
    if (action === 'stop' || action === 'seekbackward') throw new Error('Unsupported action')
    register.call(this, action, handler)
  }
  Object.defineProperty(ms, 'playbackState', { set() { throw new Error('Unsupported playback state') } })
  const h = web(ms, { metadata: class { constructor() { throw new Error('Unsupported metadata') } } })
  h.player.playQueue([item()], 0)
  await flush()
  assert.equal(h.player.status, 'playing')
  assert.ok(ms.handlers.has('seekforward'), 'registration continues after an unsupported action')
  ms.action('seekforward')
  assert.equal(h.audio.currentTime, 10)
  assert.equal(ms.positions.at(-1).position, 10)
  assert.deepEqual(h.messages, [])
})
