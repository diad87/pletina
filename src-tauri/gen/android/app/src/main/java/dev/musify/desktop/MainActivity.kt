package dev.musify.desktop

import android.content.Intent
import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    startFase0(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    startFase0(intent)
  }

  /** Prueba de la fase 0 (ver PlaybackService): arranca el servicio de música con unos discos. */
  private fun startFase0(intent: Intent?) {
    val queries = intent?.getStringExtra("fase0") ?: return
    intent.removeExtra("fase0")
    startService(
      Intent(this, PlaybackService::class.java)
        .setAction(PlaybackService.ACTION_FASE0)
        .putExtra(PlaybackService.EXTRA_QUERIES, queries),
    )
  }
}
