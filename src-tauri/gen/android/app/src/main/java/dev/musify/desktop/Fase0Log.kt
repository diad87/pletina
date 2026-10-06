package dev.musify.desktop

import android.content.Context
import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Registro de la prueba de la fase 0 (docs/plan-mobile.md): en logcat (etiqueta MusifyFase0) y en
 * files/fase0.log, para leerlo después de una hora con la pantalla apagada:
 * `adb shell run-as dev.musify.desktop cat files/fase0.log`.
 */
object Fase0Log {
  private const val TAG = "MusifyFase0"
  private var file: File? = null
  private val clock = SimpleDateFormat("HH:mm:ss", Locale.ROOT)

  fun init(context: Context) {
    file = File(context.filesDir, "fase0.log")
  }

  @Synchronized
  fun log(message: String) {
    Log.i(TAG, message)
    try {
      file?.appendText("${clock.format(Date())} $message\n")
    } catch (_: Exception) {
      // Sin archivo, queda en logcat.
    }
  }
}
