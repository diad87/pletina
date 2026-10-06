package dev.musify.desktop

import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.activity.enableEdgeToEdge
import androidx.core.content.FileProvider
import java.io.File

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    fase0(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    fase0(intent)
  }

  /**
   * Prueba de la fase 0 (ver PlaybackService), desde los accesos directos del icono o por adb:
   * `--es fase0 "disco|disco"` arranca el servicio de música con esos discos; `--es fase0log 1`
   * comparte el registro (WhatsApp, correo...).
   */
  private fun fase0(intent: Intent?) {
    intent ?: return
    intent.getStringExtra("fase0")?.let { queries ->
      intent.removeExtra("fase0")
      Fase0Log.init(this)
      Fase0Log.log("=== prueba nueva: $queries")
      startService(
        Intent(this, PlaybackService::class.java)
          .setAction(PlaybackService.ACTION_FASE0)
          .putExtra(PlaybackService.EXTRA_QUERIES, queries),
      )
      Toast.makeText(this, "Prueba en marcha: apaga la pantalla y deja que suene", Toast.LENGTH_LONG).show()
    }
    if (intent.getStringExtra("fase0log") != null) {
      intent.removeExtra("fase0log")
      shareLog()
    }
  }

  private fun shareLog() {
    val file = File(filesDir, "fase0.log")
    if (!file.exists()) {
      Toast.makeText(this, "Todavía no hay registro de la prueba", Toast.LENGTH_LONG).show()
      return
    }
    val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
    val send = Intent(Intent.ACTION_SEND)
      .setType("text/plain")
      .putExtra(Intent.EXTRA_SUBJECT, "Musify: registro de la prueba")
      .putExtra(Intent.EXTRA_TEXT, file.readText().takeLast(60_000))
      .putExtra(Intent.EXTRA_STREAM, uri)
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    startActivity(Intent.createChooser(send, "Enviar registro de la prueba"))
  }
}
