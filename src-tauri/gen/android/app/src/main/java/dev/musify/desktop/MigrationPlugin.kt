package dev.musify.desktop

import android.app.Activity
import android.content.Intent
import android.provider.DocumentsContract
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.IOException
import java.security.MessageDigest

@TauriPlugin
class MigrationPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun saveLibrary(invoke: Invoke) {
    val picker = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = "application/json"
      putExtra(Intent.EXTRA_TITLE, invoke.getArgs().getString("fileName"))
    }
    try {
      startActivityForResult(invoke, picker, "onLibraryDestination")
    } catch (_: Exception) {
      invoke.reject("No se pudo abrir el selector de archivos.")
    }
  }

  @ActivityCallback
  fun onLibraryDestination(invoke: Invoke, result: ActivityResult) {
    if (result.resultCode == Activity.RESULT_CANCELED) {
      invoke.resolve(JSObject().put("saved", false))
      return
    }
    val uri = result.data?.data
    if (result.resultCode != Activity.RESULT_OK || uri?.scheme != "content") {
      invoke.reject("No se pudo abrir el archivo elegido.")
      return
    }

    // Close through ContentResolver so the provider can commit the document before reopening it.
    Thread {
      val resolver = activity.contentResolver
      try {
        val bytes = invoke.getArgs().getString("json").toByteArray(Charsets.UTF_8)
        val output = resolver.openOutputStream(uri, "wt") ?: throw IOException()
        output.use { it.write(bytes) }
        val expected = MessageDigest.getInstance("SHA-256").digest(bytes)
        val actual = MessageDigest.getInstance("SHA-256")
        val input = resolver.openInputStream(uri) ?: throw IOException()
        input.use {
          val buffer = ByteArray(16 * 1024)
          var count = it.read(buffer)
          while (count != -1) {
            actual.update(buffer, 0, count)
            count = it.read(buffer)
          }
        }
        if (!MessageDigest.isEqual(expected, actual.digest())) throw IOException()
        invoke.resolve(JSObject().put("saved", true))
      } catch (_: Exception) {
        // ACTION_CREATE_DOCUMENT creates a new document. Remove a failed partial export.
        runCatching { DocumentsContract.deleteDocument(resolver, uri) }
        invoke.reject("No se pudo guardar y verificar la copia.")
      }
    }.start()
  }
}
