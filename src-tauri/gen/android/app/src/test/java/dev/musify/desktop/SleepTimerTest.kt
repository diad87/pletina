package dev.musify.desktop

import org.junit.Assert.*
import org.junit.Test

class SleepTimerTest {
  @Test fun deadlineIncludesTimeSpentWithTheCpuAsleep() {
    val timer = SleepTimer()
    timer.set(15, 1000, 2_000_000)
    assertEquals("time", timer.mode)
    assertEquals(2_900_000L, timer.endsAt)
    assertEquals(900_000L, timer.remaining(1000))
    assertEquals(1L, timer.remaining(900_999))
    assertEquals(0L, timer.remaining(901_000))
    assertEquals(0L, timer.remaining(2_000_000))
  }

  @Test fun replacementStartsANewDeadline() {
    val timer = SleepTimer()
    timer.set(15, 0, 100_000)
    timer.set(30, 300_000, 400_000)
    assertEquals(1_200_000L, timer.remaining(900_000))
    assertEquals(2_200_000L, timer.endsAt)
  }

  @Test fun endAndCancellationRemoveTheTimedDeadline() {
    val timer = SleepTimer()
    timer.set(60, 1000, 100_000)
    timer.set(-1, 2000, 101_000)
    assertEquals("end", timer.mode)
    assertEquals(0L, timer.endsAt)
    assertNull(timer.remaining(Long.MAX_VALUE))
    timer.clear()
    assertEquals("off", timer.mode)
    assertEquals(0L, timer.endsAt)
    assertNull(timer.remaining(Long.MAX_VALUE))
  }

  @Test fun maximumCustomDurationDoesNotOverflow() {
    val timer = SleepTimer()
    timer.set(1440, 10, 20)
    assertEquals(86_400_000L, timer.remaining(10))
    assertEquals(86_400_020L, timer.endsAt)
  }

  @Test fun invalidDurationLeavesAnActiveTimerUnchanged() {
    val timer = SleepTimer()
    timer.set(15, 1000, 2000)
    for (minutes in listOf(-2, 1441, Int.MAX_VALUE)) {
      assertThrows(IllegalArgumentException::class.java) { timer.set(minutes, 0, 0) }
      assertEquals("time", timer.mode)
      assertEquals(902_000L, timer.endsAt)
    }
  }
}
