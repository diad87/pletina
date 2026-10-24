package dev.musify.desktop

import org.junit.Assert.*
import org.junit.Test

class PlaybackRecoveryTest {
  private class Fixture {
    data class Task(val at: Long, val action: () -> Unit, var cancelled: Boolean = false)
    var now = 0L
    var state = PlaybackRecovery.Snapshot("A", true, false, 0L)
    var internet = true
    var resumed = 0
    val tasks = mutableListOf<Task>()
    val policy = PlaybackRecovery({ state }, { internet }, { delay, action ->
      val task = Task(now + delay, action)
      tasks.add(task)
      val cancel: () -> Unit = { task.cancelled = true }
      cancel
    }, { resumed++ }).also { it.onPlayIntent(true) }
    fun advance(ms: Long, includeCancelled: Boolean = false) {
      val end = now + ms
      while (true) {
        val next = tasks.filter { it.at <= end }.minByOrNull { it.at } ?: break
        tasks.remove(next); now = next.at
        if (!next.cancelled || includeCancelled) next.action()
      }
      now = end
    }
    fun pause() {
      state = state.copy(playWhenReady = false, playing = false)
      policy.onPlayIntent(false)
    }
  }

  @Test fun consecutiveFailuresHaveABoundedBudget() {
    val f = Fixture()
    for (delay in listOf(1000L, 2000L, 3000L)) {
      assertEquals(PlaybackRecovery.Failure.RETRYING, f.policy.onFailure())
      f.advance(delay - 1); val before = f.resumed
      f.advance(1); assertEquals(before + 1, f.resumed)
    }
    assertEquals(PlaybackRecovery.Failure.EXHAUSTED, f.policy.onFailure())
    f.advance(10000); assertEquals(3, f.resumed)
  }

  @Test fun stableRecoveryStartsANewBudgetForEachSeparateCut() {
    val f = Fixture()
    repeat(20) {
      assertEquals(PlaybackRecovery.Failure.RETRYING, f.policy.onFailure())
      f.advance(1000)
      f.state = f.state.copy(playing = true)
      f.policy.onPlayingChanged()
      f.state = f.state.copy(positionMs = f.state.positionMs + 2000)
      f.advance(2000)
      f.state = f.state.copy(playing = false)
      f.policy.onPlayingChanged()
    }
    assertEquals(20, f.resumed)
  }

  @Test fun readyWithoutClockAdvanceDoesNotResetBudget() {
    val f = Fixture()
    repeat(3) { i ->
      assertEquals(PlaybackRecovery.Failure.RETRYING, f.policy.onFailure()); f.advance((i + 1) * 1000L)
      f.state = f.state.copy(playing = true); f.policy.onPlayingChanged(); f.advance(2000)
    }
    assertEquals(PlaybackRecovery.Failure.EXHAUSTED, f.policy.onFailure())
  }

  @Test fun shortPlaybackDoesNotResetBudget() {
    val f = Fixture()
    repeat(3) { i ->
      f.policy.onFailure(); f.advance((i + 1) * 1000L)
      f.state = f.state.copy(playing = true); f.policy.onPlayingChanged(); f.advance(500)
      f.state = f.state.copy(playing = false, positionMs = f.state.positionMs + 500)
      f.policy.onPlayingChanged(); f.advance(2000)
    }
    assertEquals(PlaybackRecovery.Failure.EXHAUSTED, f.policy.onFailure())
  }

  @Test fun pauseStopAndEntryChangesInvalidateEvenAlreadyDequeuedCallbacks() {
    repeat(20) { iteration ->
      for (operation in listOf("pause", "stop", "entry", "pause-play")) {
        val f = Fixture(); f.policy.onFailure(); f.advance(iteration * 40L)
        when (operation) {
          "pause" -> f.pause()
          "stop" -> f.policy.onPlayIntent(false) // ExoPlayer.stop may keep playWhenReady=true.
          "entry" -> { f.policy.onEntryChanged(); f.state = f.state.copy(entry = "B") }
          else -> { f.pause(); f.state = f.state.copy(playWhenReady = true); f.policy.onPlayIntent(true) }
        }
        // Even if cancellation loses a scheduler race, the generation guard must hold.
        f.advance(10000, includeCancelled = true)
        assertEquals("$operation iteration $iteration", 0, f.resumed)
      }
    }
  }

  @Test fun entryIdentityIsCheckedBeforeRetry() {
    val f = Fixture(); f.policy.onFailure(); f.state = f.state.copy(entry = "B")
    f.advance(1000); assertEquals(0, f.resumed)
  }

  @Test fun unvalidatedNetworkWaitsWithoutConsumingRetries() {
    val f = Fixture(); f.internet = false
    repeat(20) {
      assertEquals(PlaybackRecovery.Failure.WAITING_FOR_NETWORK, f.policy.onFailure())
      f.policy.onNetworkChanged(); f.advance(10000)
    }
    assertEquals(0, f.resumed)
    f.internet = true; f.policy.onNetworkChanged(); f.advance(1500)
    assertEquals(1, f.resumed)
    assertEquals(PlaybackRecovery.Failure.RETRYING, f.policy.onFailure())
    f.advance(1000); assertEquals(2, f.resumed)
  }

  @Test fun networkReturnRespectsPauseAndStopBeforeOrAfterNotification() {
    repeat(20) {
      for (notifyFirst in listOf(false, true)) {
        val f = Fixture(); f.internet = false; f.policy.onFailure()
        if (notifyFirst) { f.internet = true; f.policy.onNetworkChanged(); f.advance(it * 50L) }
        f.pause(); f.internet = true; f.policy.onNetworkChanged()
        f.advance(10000, includeCancelled = true); assertEquals(0, f.resumed)
      }
    }
  }

  @Test fun lossDuringBackoffWaitsForValidation() {
    val f = Fixture(); f.policy.onFailure(); f.internet = false; f.advance(1000)
    assertEquals(0, f.resumed)
    f.internet = true; f.policy.onNetworkChanged(); f.policy.onNetworkChanged(); f.advance(1500)
    assertEquals(1, f.resumed)
  }

  @Test fun anotherErrorReplacesPendingRetry() {
    val f = Fixture(); f.policy.onFailure(); f.advance(400); f.policy.onFailure()
    f.advance(600, includeCancelled = true); assertEquals(0, f.resumed)
    f.advance(1400); assertEquals(1, f.resumed)
  }

  @Test fun stoppedPlayerIgnoresErrorsAndNetworkReturn() {
    val f = Fixture(); f.policy.onPlayIntent(false)
    assertEquals(PlaybackRecovery.Failure.IGNORED, f.policy.onFailure())
    f.policy.onNetworkChanged(); f.advance(10000); assertEquals(0, f.resumed)
  }
}
