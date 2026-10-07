package dev.musify.desktop

import android.content.Context
import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Registro de la app en el móvil: lo que hace el servicio de música (canciones, pausas, red, errores)
 * y los cierres por error. Va a logcat (etiqueta Musify) y a files/musify.log, que se envía desde
 * «Tu biblioteca» → «Enviar registro» (o `adb shell run-as dev.musify.desktop cat files/musify.log`).
 */
object MusifyLog {
  private const val TAG = "Musify"
  /** Al pasar de esto, se queda con la mitad más reciente (unos días de uso). */
  private const val MAX_BYTES = 512 * 1024
  private var file: File? = null
  private val clock = SimpleDateFormat("dd/MM HH:mm:ss", Locale.ROOT)

  fun init(context: Context) {
    if (file != null) return
    file = File(context.filesDir, "musify.log")
    // El de las versiones de prueba.
    File(context.filesDir, "fase0.log").delete()
  }

  fun file(context: Context): File = File(context.filesDir, "musify.log")

  @Synchronized
  fun log(message: String) {
    Log.i(TAG, message)
    val f = file ?: return
    try {
      f.appendText("${clock.format(Date())} $message\n")
      if (f.length() > MAX_BYTES) {
        val text = f.readText()
        f.writeText(text.substring(text.indexOf('\n', text.length / 2) + 1))
      }
    } catch (_: Exception) {
      // Sin archivo, queda en logcat.
    }
  }
}
