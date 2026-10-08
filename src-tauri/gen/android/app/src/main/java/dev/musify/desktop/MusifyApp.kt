package dev.musify.desktop

import android.app.Application

/** Apunta en el registro cualquier cierre por error (ver MusifyLog). */
class MusifyApp : Application() {
  override fun onCreate() {
    super.onCreate()
    MusifyLog.init(this)
    val previous = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { thread, error ->
      MusifyLog.log("CIERRE en ${thread.name}: ${error.stackTraceToString().take(4000)}")
      previous?.uncaughtException(thread, error)
    }
  }
}
