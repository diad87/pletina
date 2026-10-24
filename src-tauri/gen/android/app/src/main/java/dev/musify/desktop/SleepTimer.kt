package dev.musify.desktop

/** El plazo usa tiempo monotónico; `endsAt` solo sirve para enseñar la cuenta atrás. */
internal class SleepTimer {
  var mode = "off"
    private set
  var endsAt = 0L
    private set
  private var deadline = 0L

  fun set(minutes: Int, elapsed: Long, epoch: Long) {
    require(minutes == -1 || minutes in 0..1440) { "Elige entre 1 y 1440 minutos" }
    mode = when (minutes) {
      -1 -> "end"
      0 -> "off"
      else -> "time"
    }
    val duration = if (minutes > 0) minutes * 60_000L else 0L
    deadline = if (duration > 0) elapsed + duration else 0L
    endsAt = if (duration > 0) epoch + duration else 0L
  }

  fun clear() = set(0, 0, 0)

  /** Incluye el tiempo con la CPU dormida, aunque el callback del Handler haya llegado tarde. */
  fun remaining(elapsed: Long): Long? = if (mode == "time") (deadline - elapsed).coerceAtLeast(0) else null
}
