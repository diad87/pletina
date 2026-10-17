import assert from 'node:assert/strict'
import test from 'node:test'
import { flush, harness, item } from './helpers/player-harness.mjs'

const ids = (items) => items.map((item) => item.track.id)
const tracks = () => [item(1), item(2), item(3), item(4)]

test('collection Play chooses its first song at random and plays each entry once', async (t) => {
  t.mock.method(Math, 'random', () => 0.8)
  const h = harness(), items = tracks()
  h.player.toggleShuffle()
  h.player.playQueue(items, null, 'Gym')
  await flush()
  assert.equal(h.player.current.track.id, 4)
  assert.equal(h.player.context, 'Gym')
  assert.deepEqual(ids(h.player.queue), [1, 2, 3, 4])
  const played = [h.player.current.track.id]
  while (h.player.hasNext) {
    h.player.next()
    await flush()
    played.push(h.player.current.track.id)
  }
  assert.deepEqual(played.sort(), [1, 2, 3, 4])
})

test('every song can be the first, including the first and last entries', async (t) => {
  let random = 0
  t.mock.method(Math, 'random', () => random)
  const h = harness(), items = tracks()
  h.player.toggleShuffle()
  for (let index = 0; index < items.length; index++) {
    random = (index + 0.5) / items.length
    h.player.playQueue(items, null)
    await flush()
    assert.equal(h.player.current.track.id, items[index].track.id)
  }
})

test('selecting a particular song keeps it first with shuffle on', async (t) => {
  t.mock.method(Math, 'random', () => 0.8)
  const h = harness()
  h.player.toggleShuffle()
  h.player.playQueue(tracks(), 1)
  await flush()
  assert.equal(h.player.current.track.id, 2)
  assert.deepEqual(ids([h.player.current, ...h.player.upcoming.map((next) => next.item)]).sort(), [1, 2, 3, 4])
})

test('ordinary collection Play and explicit selection retain their sequential order', async () => {
  const h = harness()
  h.player.playQueue(tracks(), null)
  await flush()
  assert.equal(h.player.current.track.id, 1)
  assert.deepEqual(ids(h.player.upcoming.map((next) => next.item)), [2, 3, 4])
  h.player.playQueue(tracks(), 2)
  await flush()
  assert.equal(h.player.current.track.id, 3)
  assert.deepEqual(ids(h.player.upcoming.map((next) => next.item)), [4])
})

test('toggling shuffle keeps the current audio and position and preserves DJ priority', async (t) => {
  t.mock.method(Math, 'random', () => 0.8)
  const h = harness()
  h.player.playQueue(tracks(), 1)
  await flush()
  h.player.seek(42)
  h.player.addToQueue([item(90), item(91)])
  const audio = h.audio
  for (let i = 0; i < 2; i++) {
    h.player.toggleShuffle()
    await flush()
    assert.equal(h.player.current.track.id, 2)
    assert.equal(h.audio, audio)
    assert.equal(h.audio.currentTime, 42)
    assert.equal(h.player.status, 'playing')
    assert.deepEqual(h.player.userQueue.map(({ item }) => item.track.id), [90, 91])
  }
  h.player.toggleShuffle()
  h.player.playQueue(tracks(), null)
  await flush()
  assert.equal(h.player.current.track.id, 4)
  h.player.next()
  await flush()
  assert.equal(h.player.current.track.id, 90)
  h.player.next()
  await flush()
  assert.equal(h.player.current.track.id, 91)
  h.player.next()
  await flush()
  assert.notEqual(h.player.current.track.id, 4)
})

test('shuffle preserves duplicate playlist entries and handles empty and single-song collections', async (t) => {
  t.mock.method(Math, 'random', () => 0.8)
  const h = harness()
  h.player.toggleShuffle()
  h.player.playQueue([item(1), item(2), item(1)], null)
  await flush()
  assert.deepEqual(ids([h.player.current, ...h.player.upcoming.map((next) => next.item)]).sort(), [1, 1, 2])
  h.player.playQueue([item(7)], null)
  await flush()
  assert.equal(h.player.current.track.id, 7)
  assert.equal(h.player.hasNext, false)
  const audio = h.audio
  h.player.playQueue([], null)
  assert.equal(h.player.current.track.id, 7)
  assert.equal(h.audio, audio)
})
