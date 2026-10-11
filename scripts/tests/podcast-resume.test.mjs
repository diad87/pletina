import assert from 'node:assert/strict'
import test from 'node:test'
import { deferred, flush, harness, item, playable } from './helpers/player-harness.mjs'

const episode = (id) => item(750_000_000_000_000 + id)
const progress = (audio, at) => { audio.currentTime = at; audio.dispatchEvent(new Event('timeupdate')) }
const saved = (position) => ({ position, completed: false })
const setup = (options = {}) => harness({ duration: () => 1000, ...options })

test('podcast checkpoints belong to each episode and survive replacing both queue and player', async () => {
  const h = setup(), a = episode(1), b = episode(2)
  h.progress.set(a.track.id, saved(120))
  h.progress.set(b.track.id, saved(360))
  h.player.playQueue([a, b], 0)
  await flush()
  assert.equal(h.audio.currentTime, 120)
  progress(h.audio, 185.5)
  h.player.playQueue([b], 0)
  await flush()
  assert.equal(h.progress.get(a.track.id).position, 185.5)
  assert.equal(h.audio.currentTime, 360)
  const reopened = setup({ progress: h.progress })
  reopened.player.playQueue([a], 0)
  await flush()
  assert.equal(reopened.audio.currentTime, 185.5)
  progress(reopened.audio, 212)
  reopened.player.toggle()
  assert.equal(h.progress.get(a.track.id).position, 212)
  reopened.player.seek(0)
  assert.equal(h.progress.get(a.track.id).position, 0)
  assert.equal(h.progress.get(a.track.id).completed, false)
})

test('completed episodes start again at zero and music never writes podcast progress', async () => {
  const h = setup(), a = episode(1)
  h.player.playQueue([a], 0)
  await flush()
  progress(h.audio, 1000)
  h.audio.dispatchEvent(new Event('ended'))
  assert.equal(h.progress.get(a.track.id).completed, true)
  h.player.toggle()
  await flush()
  assert.equal(h.audio.currentTime, 0)
  progress(h.audio, 20)
  h.player.toggle()
  assert.equal(h.progress.get(a.track.id).completed, false)
  h.player.playQueue([item(123)], 0)
  await flush()
  progress(h.audio, 70)
  h.player.toggle()
  assert.equal(h.progress.has(123), false)
})

test('late audio cannot seek a newer episode and a shorter source clamps the stored position', async () => {
  const pending = deferred(), a = episode(1), b = episode(2)
  const h = setup({ resolve: (t) => t.id === a.track.id ? pending.promise : Promise.resolve(playable(t.id)), duration: () => 100 })
  h.progress.set(a.track.id, saved(500))
  h.progress.set(b.track.id, saved(120))
  h.player.playQueue([a], 0)
  h.player.playQueue([b], 0)
  await flush()
  assert.equal(h.audio.currentTime, 99)
  pending.resolve(playable(a.track.id))
  await flush()
  assert.equal(h.audio.currentTime, 99)
  assert.equal(h.player.current.track.id, b.track.id)
  h.player.toggle()
  assert.equal(h.progress.get(b.track.id).completed, false)
})

for (const at of [0, 25]) {
  test(`explicit seek to ${at} during resolution wins over resume, including pause and later play`, async () => {
    const pending = deferred(), a = episode(1)
    const h = setup({ resolve: () => pending.promise })
    h.progress.set(a.track.id, saved(500))
    h.player.playQueue([a], 0)
    h.player.seek(at)
    h.player.toggle()
    pending.resolve(playable(a.track.id))
    await flush()
    assert.equal(h.player.status, 'paused')
    h.player.toggle()
    await flush()
    assert.equal(h.audio.currentTime, at)
    progress(h.audio, at + 7)
    h.events.dispatchEvent(new Event('pagehide'))
    assert.equal(h.progress.get(a.track.id).position, at + 7)
  })
}

test('pausing initial resolution preserves stored progress and does not autoplay the late result', async () => {
  const pending = deferred(), a = episode(1)
  const h = setup({ resolve: () => pending.promise })
  h.progress.set(a.track.id, saved(500))
  h.player.playQueue([a], 0)
  h.player.toggle()
  pending.resolve(playable(a.track.id))
  await flush()
  assert.equal(h.player.status, 'paused')
  assert.equal(h.progress.get(a.track.id).position, 500)
  h.player.toggle()
  await flush()
  assert.equal(h.audio.currentTime, 500)
})

for (const at of [0, 42]) {
  test(`seek to ${at} between metadata and playing saves later progress`, async () => {
    const pending = deferred(), a = episode(1)
    const h = setup({ play: () => pending.promise })
    h.progress.set(a.track.id, saved(500))
    h.player.playQueue([a], 0)
    await flush()
    assert.equal(h.audio.currentTime, 500)
    h.player.seek(at)
    h.audio.paused = false
    h.audio.dispatchEvent(new Event('playing'))
    pending.resolve()
    await flush()
    assert.equal(h.audio.currentTime, at)
    progress(h.audio, at + 10)
    h.player.toggle()
    assert.equal(h.progress.get(a.track.id).position, at + 10)
  })
}

test('podcast decoder repair preserves position without overwriting it with zero', async () => {
  const h = setup(), a = episode(1)
  h.player.playQueue([a], 0)
  await flush()
  progress(h.audio, 47)
  const old = h.audio
  await h.advance(30_000)
  assert.notEqual(h.audio, old)
  assert.equal(h.audio.currentTime, 47)
  assert.equal(h.progress.get(a.track.id).position, 47)
  progress(h.audio, 48)
  h.player.toggle()
  assert.equal(h.progress.get(a.track.id).position, 48)
})

test('window close waits for the final checkpoint before destroying the window', async () => {
  const writing = deferred(), a = episode(1)
  const h = setup({ inTauri: true, flushProgress: () => writing.promise })
  h.player.playQueue([a], 0)
  await flush()
  progress(h.audio, 74)
  let prevented = false
  const close = h.close({ preventDefault() { prevented = true } })
  await flush()
  assert.equal(prevented, true)
  assert.equal(h.progress.get(a.track.id).position, 74)
  assert.equal(h.destroyed, false)
  writing.resolve()
  await close
  assert.equal(h.destroyed, true)
})

test('startup URL renewal retains the restored podcast position', async () => {
  const pending = deferred(), a = episode(1)
  let attempts = 0
  const h = setup({ play: (audio) => {
    if (++attempts === 1) return pending.promise
    audio.paused = false
    audio.dispatchEvent(new Event('playing'))
    return Promise.resolve()
  } })
  h.progress.set(a.track.id, saved(500))
  h.player.playQueue([a], 0)
  await flush()
  h.audio.fail(4)
  pending.reject(new Error('Expired source'))
  await flush()
  assert.equal(h.player.status, 'playing')
  assert.equal(h.audio.currentTime, 500)
  assert.deepEqual(h.resolutions, [[a.track.id, false], [a.track.id, true]])
  h.player.toggle()
  assert.equal(h.progress.get(a.track.id).position, 500)
})
