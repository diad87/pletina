import assert from 'node:assert/strict'
import test from 'node:test'
import { deferred, flush, harness, item, playable, sleepTimer } from './helpers/player-harness.mjs'
import { androidHarness } from './helpers/android-player-harness.mjs'

const episode = (id) => item(750_000_000_000_000 + id)
function progress(audio, at) { audio.currentTime = at; audio.dispatchEvent(new Event('timeupdate')) }
function end(audio) { audio.currentTime = audio.duration; audio.paused = true; audio.dispatchEvent(new Event('ended')) }
async function advancePlayback(h, ms) {
  while (ms > 0) {
    const step = Math.min(20_000, ms)
    await h.advance(step)
    if (h.player.status === 'playing') progress(h.audio, h.audio.currentTime + step / 1000)
    ms -= step
  }
}

test('sleep presets and custom minutes accept only whole minutes from 1 to 1440', () => {
  const { SLEEP_PRESETS, MIN_SLEEP_MINUTES, MAX_SLEEP_MINUTES, isSleepMinutes } = sleepTimer
  assert.deepEqual([...SLEEP_PRESETS], [15, 30, 60])
  assert.equal(MIN_SLEEP_MINUTES, 1)
  assert.equal(MAX_SLEEP_MINUTES, 1440)
  for (const minutes of [1, 15, 30, 60, 77, 1440]) assert.equal(isSleepMinutes(minutes), true, String(minutes))
  for (const minutes of [0, -1, -2, 1.5, 1441, NaN, Infinity, '15', '', null, undefined]) {
    assert.equal(isSleepMinutes(minutes), false, String(minutes))
  }
})

test('a timed stop pauses at the current position, saves the podcast and keeps its queue', async () => {
  const h = harness(), a = episode(1), b = episode(2)
  assert.equal(h.player.sleepTimer.mode, 'off')
  h.player.playQueue([a, b], 0)
  await flush()
  progress(h.audio, 123.5)
  const start = h.now
  assert.equal(await h.player.setSleepTimer(1), true)
  assert.equal(h.player.sleepTimer.endsAt, start + 60_000)
  await advancePlayback(h, 59_999)
  const at = h.audio.currentTime
  assert.equal(h.audio.paused, false)
  await h.advance(1)
  assert.equal(h.audio.paused, true)
  assert.equal(h.player.status, 'paused')
  assert.equal(h.audio.currentTime, at)
  assert.equal(h.player.current.track.id, a.track.id)
  assert.equal(h.player.queue.length, 2)
  assert.equal(h.progress.get(a.track.id).position, at)
  assert.equal(h.progress.get(a.track.id).completed, false)
  assert.equal(h.player.sleepTimer.mode, 'off')
  await h.advance(120_000)
  assert.equal(h.player.status, 'paused', 'the progress watchdog must remain disarmed')
})

test('invalid custom durations preserve the timer; replacing and cancelling remove previous deadlines', async () => {
  const h = harness()
  h.player.playQueue([item()], 0)
  await flush()
  await h.player.setSleepTimer(1)
  const original = h.player.sleepTimer.endsAt
  for (const minutes of [1.5, 1441, -2, NaN, Infinity]) {
    assert.equal(await h.player.setSleepTimer(minutes), false)
    assert.equal(h.player.sleepTimer.endsAt, original)
  }
  await advancePlayback(h, 40_000)
  assert.equal(await h.player.setSleepTimer(2), true)
  await advancePlayback(h, 21_000)
  assert.equal(h.audio.paused, false)
  assert.equal(h.player.sleepTimer.mode, 'time')
  assert.equal(await h.player.setSleepTimer(0), true)
  await advancePlayback(h, 120_000)
  assert.equal(h.audio.paused, false)
  assert.equal(h.player.sleepTimer.mode, 'off')
})

test('end-of-item stops before repeat or the DJ queue starts another item', async () => {
  for (const repeat of ['off', 'one', 'all']) {
    const h = harness(), a = episode(1)
    h.player.playQueue([a, episode(2)], 0)
    h.player.playNext([episode(3)])
    h.player.repeat = repeat
    await flush()
    const audio = h.audio, plays = audio.plays
    assert.equal(await h.player.setSleepTimer(-1), true)
    end(audio)
    await flush()
    assert.equal(audio.paused, true, repeat)
    assert.equal(h.player.status, 'paused', repeat)
    assert.equal(h.player.current.track.id, a.track.id, repeat)
    assert.equal(h.player.userQueue.length, 1, repeat)
    assert.equal(audio.plays, plays, repeat)
    assert.equal(h.progress.get(a.track.id).completed, true, repeat)
    assert.equal(h.player.sleepTimer.mode, 'off', repeat)
  }
})

test('the end timer is consumed once and replacing it with a timed stop removes the end stop', async () => {
  const h = harness(), a = episode(1), b = episode(2)
  h.player.playQueue([a, b], 0)
  await flush()
  await h.player.setSleepTimer(-1)
  end(h.audio)
  await flush()
  h.player.toggle()
  await flush()
  end(h.audio)
  await flush()
  assert.equal(h.player.current.track.id, b.track.id)
  assert.equal(h.audio.paused, false)
  h.player.playQueue([a, b], 0)
  await flush()
  await h.player.setSleepTimer(-1)
  await h.player.setSleepTimer(60)
  end(h.audio)
  await flush()
  assert.equal(h.player.current.track.id, b.track.id)
  assert.equal(h.player.sleepTimer.mode, 'time')
})

test('arming end-of-item after the queue ended survives replay of the same item', async () => {
  const h = harness()
  h.player.playQueue([episode(1)], 0)
  await flush()
  end(h.audio)
  await flush()
  await h.player.setSleepTimer(-1)
  h.player.toggle()
  await flush()
  assert.equal(h.player.sleepTimer.mode, 'end')
  end(h.audio)
  await flush()
  assert.equal(h.player.sleepTimer.mode, 'off')
  assert.equal(h.player.status, 'paused')
})

test('timed expiry invalidates unresolved loads and explicit play can resume afterwards', async () => {
  const pending = deferred(), h = harness({ resolve: () => pending.promise })
  h.player.playQueue([episode(1)], 0)
  await h.player.setSleepTimer(1)
  await h.advance(60_000)
  assert.equal(h.player.status, 'paused')
  pending.resolve(playable())
  await flush()
  assert.deepEqual(h.sources, [])
  assert.equal(h.audio.paused, true)
  assert.equal(h.player.status, 'paused')
  h.player.toggle()
  await flush()
  assert.equal(h.player.status, 'playing')
})

test('late playing, source errors and watchdog callbacks after expiry cannot restart playback', async () => {
  const pending = deferred(), h = harness({ play: () => pending.promise })
  h.player.playQueue([episode(1)], 0)
  await flush()
  await h.player.setSleepTimer(1)
  h.elapse(60_000)
  h.events.dispatchEvent(new Event('focus'))
  h.audio.paused = false
  h.audio.dispatchEvent(new Event('playing'))
  pending.resolve()
  await flush()
  assert.equal(h.audio.paused, true)
  assert.equal(h.player.status, 'paused')
  const count = h.resolutions.length
  h.audio.fail(4)
  await h.advance(180_000)
  assert.equal(h.resolutions.length, count)
  assert.equal(h.messages.length, 0)
  assert.equal(h.player.status, 'paused')
})

test('a late load rejection after expiry cannot skip or report a playback failure', async () => {
  const pending = deferred(), h = harness({ resolve: () => pending.promise })
  h.player.playQueue([episode(1), episode(2)], 0)
  await h.player.setSleepTimer(1)
  await h.advance(60_000)
  pending.reject(new Error('offline'))
  await flush()
  assert.equal(h.player.current.track.id, episode(1).track.id)
  assert.equal(h.player.status, 'paused')
  assert.equal(h.messages.length, 0)
  assert.deepEqual(h.sources, [])
})

test('seek retains the end timer, selecting another item cancels it and a timed stop survives selection', async () => {
  const h = harness()
  h.player.playQueue([episode(1), episode(2)], 0)
  await flush()
  await h.player.setSleepTimer(-1)
  h.player.seek(50)
  assert.equal(h.player.sleepTimer.mode, 'end')
  h.player.next()
  await flush()
  assert.equal(h.player.sleepTimer.mode, 'off')
  await h.player.setSleepTimer(15)
  const deadline = h.player.sleepTimer.endsAt
  h.player.playAt(0)
  await flush()
  assert.equal(h.player.sleepTimer.mode, 'time')
  assert.equal(h.player.sleepTimer.endsAt, deadline)
})

test('an unplayable item with an end timer stops without advancing the queue', async () => {
  const pending = deferred()
  const h = harness({ resolve: (track) => track.id === 1 ? pending.promise : Promise.resolve(playable(track.id)) })
  h.player.playQueue([item(1), item(2)], 0)
  await h.player.setSleepTimer(-1)
  pending.reject(new Error('unavailable'))
  await flush()
  assert.equal(h.player.current.track.id, 1)
  assert.equal(h.player.sleepTimer.mode, 'off')
  assert.ok(h.player.status === 'idle' || h.player.status === 'paused')
  assert.equal(h.messages.length, 1)
})

test('a local decoder failure with an end timer resumes the same position with one Play', async () => {
  const h = harness({ resolve: async (track) => playable(track.id, true) })
  h.player.playQueue([item(1), item(2)], 0)
  await flush()
  h.player.playNext([item(90)])
  progress(h.audio, 47)
  await h.player.setSleepTimer(-1)
  const failed = h.audio
  failed.fail(3, 'Decoder failed')
  await flush()
  assert.equal(h.player.current.track.id, 1)
  assert.equal(h.player.status, 'paused')
  assert.equal(h.player.time, 47)
  assert.equal(h.player.sleepTimer.mode, 'off')
  assert.deepEqual(h.player.userQueue.map(({ item }) => item.track.id), [90])
  assert.equal(h.messages.length, 2, 'one queue confirmation and one playback failure')
  h.player.toggle()
  await flush()
  assert.notEqual(h.audio, failed)
  assert.equal(h.audio.error, null)
  assert.equal(h.audio.paused, false)
  assert.equal(h.audio.currentTime, 47)
  assert.equal(h.player.status, 'playing')
  assert.equal(h.player.current.track.id, 1)
  assert.deepEqual(h.player.userQueue.map(({ item }) => item.track.id), [90])
  assert.equal(h.messages.length, 2, 'the first Play must not report the stale decoder error')
})

test('an end timer survives automatic decoder recovery and applies to the replacement audio', async () => {
  const h = harness({ resolve: async (track) => playable(track.id, true) })
  h.player.playQueue([episode(1), episode(2)], 0)
  await flush()
  progress(h.audio, 47)
  await h.player.setSleepTimer(-1)
  const previous = h.audio
  await h.advance(30_000)
  assert.notEqual(h.audio, previous)
  assert.equal(h.audio.currentTime, 47)
  assert.equal(h.player.sleepTimer.mode, 'end')
  end(h.audio)
  await flush()
  assert.equal(h.player.current.track.id, episode(1).track.id)
  assert.equal(h.player.status, 'paused')
  assert.equal(h.player.sleepTimer.mode, 'off')
})

test('an overdue timer is enforced after frozen UI callbacks resume', async () => {
  for (const wake of ['visibilitychange', 'playing', 'timeupdate', 'timeout']) {
    const h = harness()
    h.player.playQueue([item()], 0)
    await flush()
    await h.player.setSleepTimer(1)
    h.elapse(61_000)
    if (wake === 'visibilitychange') h.events.dispatchEvent(new Event('visibilitychange'))
    else if (wake === 'timeout') await h.advance(0)
    else h.audio.dispatchEvent(new Event(wake))
    await flush()
    assert.equal(h.audio.paused, true, wake)
    assert.equal(h.player.status, 'paused', wake)
    assert.equal(h.player.sleepTimer.mode, 'off', wake)
    assert.equal(h.messages.length, 0, wake)
  }
})

test('clock corrections cannot shorten or lengthen the selected duration', async () => {
  for (const change of [-3_600_000, 3_600_000]) {
    const h = harness()
    h.player.playQueue([item()], 0)
    await flush()
    await h.player.setSleepTimer(1)
    h.shiftWall(change)
    await advancePlayback(h, 30_000)
    h.events.dispatchEvent(new Event('visibilitychange'))
    assert.equal(h.audio.paused, false)
    await advancePlayback(h, 30_000)
    assert.equal(h.audio.paused, true)
    assert.equal(h.player.sleepTimer.mode, 'off')
  }
})

const entry = (id) => ({ uid: String(id), item: item(id), lib: item(id), query: item(id).track, user: false, key: 0, ctx: id - 1, context: 'Programa' })

test('Android restores the native timer and synchronizes it after returning from the background', async () => {
  const timer = { mode: 'time', endsAt: 1_700_000_060_000 }
  const h = androidHarness({ entries: [entry(1)], index: 0, state: 'ready', playing: true, sleepTimer: timer })
  await flush()
  assert.equal(h.player.sleepTimer.mode, 'time')
  assert.equal(h.player.sleepTimer.endsAt, timer.endsAt)
  h.elapse(61_000)
  assert.equal(h.player.sleepTimer.mode, 'time', 'only the native service consumes its timer')
  h.setState({ sleepTimer: { mode: 'off', endsAt: 0 }, playing: false })
  h.events.dispatchEvent(new Event('visibilitychange'))
  await flush()
  assert.equal(h.player.sleepTimer.mode, 'off')
  assert.equal(h.player.status, 'paused')
  assert.equal(h.commands.filter((command) => command.cmd === 'state').length, 2)
})

test('Android sends only valid timer commands and waits for native confirmation', async () => {
  const h = androidHarness({ entries: [entry(1)], index: 0, state: 'ready' })
  await flush()
  for (const minutes of [1.5, 1441, -2, NaN, Infinity]) assert.equal(await h.player.setSleepTimer(minutes), false)
  assert.equal(h.commands.filter((command) => command.cmd === 'setSleepTimer').length, 0)
  for (const minutes of [15, 30, 60, 77, -1, 0]) {
    assert.equal(await h.player.setSleepTimer(minutes), true)
    assert.equal(h.commands.at(-1).command, 'player_native')
    assert.equal(h.commands.at(-1).cmd, 'setSleepTimer')
    assert.equal(h.commands.at(-1).args.minutes, minutes)
    assert.equal(h.player.sleepTimer.mode, 'off')
  }
  h.emit('sleep-timer', { mode: 'end', endsAt: 0 })
  assert.equal(h.player.sleepTimer.mode, 'end')
  h.emit('sleep-timer', { mode: 'off', endsAt: 0 })
  assert.equal(h.player.sleepTimer.mode, 'off')
})

test('Android status events retain native timer state and failed commands leave it intact', async () => {
  const h = androidHarness({ entries: [entry(1)], index: 0, state: 'ready' })
  await flush()
  const timer = { mode: 'time', endsAt: 1_700_000_060_000 }
  h.emit('player-status', {
    index: 0, positionMs: 12_000, durationMs: 180_000, playing: true,
    playWhenReady: true, state: 'ready', repeat: 'one', at: 1_700_000_000_000, sleepTimer: timer,
  })
  assert.equal(h.player.sleepTimer.mode, 'time')
  assert.equal(h.player.sleepTimer.endsAt, timer.endsAt)
  h.failures.set('setSleepTimer', 'service unavailable')
  assert.equal(await h.player.setSleepTimer(0), false)
  assert.equal(h.player.sleepTimer.mode, 'time')
  assert.equal(h.messages.length, 1)
})

test('a timer requires an item but cancelling is allowed with an empty player', async () => {
  for (const h of [harness(), androidHarness()]) {
    await flush()
    assert.equal(await h.player.setSleepTimer(15), false)
    assert.equal(await h.player.setSleepTimer(-1), false)
    assert.equal(await h.player.setSleepTimer(0), true)
    assert.equal(h.player.sleepTimer.mode, 'off')
  }
})
