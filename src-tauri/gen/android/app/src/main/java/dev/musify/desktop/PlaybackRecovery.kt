package dev.musify.desktop

/** Main-thread recovery policy. A delayed action belongs to one playback intent and queue entry. */
internal class PlaybackRecovery(
  private val snapshot: () -> Snapshot,
  private val hasInternet: () -> Boolean,
  private val schedule: (Long, () -> Unit) -> (() -> Unit),
  private val resume: (String) -> Unit,
) {
  data class Snapshot(val entry: String?, val playWhenReady: Boolean, val playing: Boolean, val positionMs: Long)
  enum class Failure { IGNORED, WAITING_FOR_NETWORK, RETRYING, EXHAUSTED }

  private var requested = false
  private var generation = 0L
  private var attempts = 0
  private var waiting = false
  private var cancelRetry: (() -> Unit)? = null
  private var cancelStable: (() -> Unit)? = null

  fun wantsPlayback(): Boolean = canResume(snapshot())

  fun onPlayIntent(play: Boolean) {
    requested = play
    if (!play) onEntryChanged()
  }

  fun onEntryChanged() {
    invalidate()
    attempts = 0
    waiting = false
  }

  fun onFailure(): Failure {
    invalidate()
    waiting = false
    if (!canResume(snapshot())) return Failure.IGNORED
    if (!hasInternet()) {
      waiting = true
      return Failure.WAITING_FOR_NETWORK
    }
    if (attempts >= 3) return Failure.EXHAUSTED
    attempts++
    retryAfter(1000L * attempts, "reintento $attempts")
    return Failure.RETRYING
  }

  /** Availability alone is insufficient: called again when the default network is validated. */
  fun onNetworkChanged() {
    if (waiting && hasInternet() && canResume(snapshot())) {
      waiting = false
      retryAfter(1500L, "vuelve la red")
    }
  }

  /** READY can flap without decoding. Reset only after sustained playback and clock advance. */
  fun onPlayingChanged() {
    cancelStable?.invoke()
    cancelStable = null
    val before = snapshot()
    if (attempts == 0 || !before.playing || !canResume(before)) return
    val token = generation
    cancelStable = schedule(2000L) {
      if (token == generation) {
        cancelStable = null
        val now = snapshot()
        if (canResume(now) && now.entry == before.entry && now.playing && now.positionMs - before.positionMs >= 1000L) {
          attempts = 0
        }
      }
    }
  }

  private fun retryAfter(delayMs: Long, why: String) {
    cancelRetry?.invoke()
    val token = generation
    val entry = snapshot().entry
    cancelRetry = schedule(delayMs) {
      if (token == generation) {
        cancelRetry = null
        val now = snapshot()
        if (canResume(now) && now.entry == entry) {
          if (hasInternet()) resume(why) else waiting = true
        }
      }
    }
  }

  private fun canResume(state: Snapshot) = requested && state.playWhenReady && state.entry != null

  private fun invalidate() {
    generation++
    cancelRetry?.invoke()
    cancelStable?.invoke()
    cancelRetry = null
    cancelStable = null
  }
}
