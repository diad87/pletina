package dev.musify.desktop

import android.app.Application

/** Apunta en el registro de la prueba cualquier cierre por error (ver Fase0Log). */
class MusifyApp : Application() {
  override fun onCreate() {
    super.onCreate()
    Fase0Log.init(this)
    val previous = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { thread, error ->
      Fase0Log.log("CIERRE en ${thread.name}: ${error.stackTraceToString().take(4000)}")
      previous?.uncaughtException(thread, error)
    }
  }
}
