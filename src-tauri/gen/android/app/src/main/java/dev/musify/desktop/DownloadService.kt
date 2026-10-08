package dev.musify.desktop

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import org.json.JSONObject

/**
 * Mientras hay descargas, mantiene viva la app (servicio en primer plano: si no, Android la congela
 * al salir de ella) y enseña el progreso en una notificación. Las descargas las hace el núcleo Rust
 * (src-tauri/src/downloads.rs); aquí solo se pregunta cada segundo cómo van y, cuando no queda
 * nada, el servicio se para solo.
 *
 * Lo arranca la interfaz al pedir descargas (PlayerPlugin, orden "downloadsStarted").
 */
class DownloadService : Service() {
  private val main = Handler(Looper.getMainLooper())
  /** Vueltas seguidas sin nada pendiente. */
  private var idle = 0
  private var running = false

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    MusifyLog.init(this)
    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(CHANNEL) == null) {
      manager.createNotificationChannel(NotificationChannel(CHANNEL, "Descargas", NotificationManager.IMPORTANCE_LOW))
    }
    val type = if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0
    ServiceCompat.startForeground(this, ID, notification(0, "", 0f), type)
    if (!running) MusifyLog.log("descargas: empiezan")
    running = true
    idle = 0
    main.removeCallbacks(poll)
    main.post(poll)
    return START_NOT_STICKY
  }

  private val poll = object : Runnable {
    override fun run() {
      val status = runCatching { JSONObject(MusifyCore.downloads()) }.getOrNull()
      val pending = status?.optInt("pending") ?: 0
      if (pending == 0) {
        // Un par de vueltas de margen: la interfaz arranca el servicio a la vez que pide las descargas.
        if (++idle >= 3) {
          stop("no queda nada")
          return
        }
      } else {
        idle = 0
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(ID, notification(pending, status!!.optString("title"), status.optDouble("progress", 0.0).toFloat()))
      }
      main.postDelayed(this, 1000)
    }
  }

  private fun notification(pending: Int, title: String, progress: Float): Notification {
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE)
    }
    return NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setContentTitle(
        when (pending) {
          0 -> "Preparando las descargas…"
          1 -> "Descargando 1 canción"
          else -> "Descargando $pending canciones"
        },
      )
      .setContentText(title)
      .setProgress(100, (progress * 100).toInt(), pending == 0 || progress <= 0f)
      .setContentIntent(open)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setCategory(NotificationCompat.CATEGORY_PROGRESS)
      .build()
  }

  private fun stop(why: String) {
    MusifyLog.log("descargas: se para el servicio ($why)")
    running = false
    main.removeCallbacks(poll)
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  /** Android 15 limita este tipo de servicio a 6 horas al día. */
  override fun onTimeout(startId: Int, fgsType: Int) {
    stop("límite de tiempo de Android")
  }

  override fun onDestroy() {
    main.removeCallbacks(poll)
    super.onDestroy()
  }

  companion object {
    private const val CHANNEL = "descargas"
    private const val ID = 2001
  }
}
