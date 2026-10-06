package dev.musify.desktop

import android.Manifest
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import java.io.File
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject

/**
 * Pantalla de la prueba de la fase 0 (docs/plan-mobile.md), sin la interfaz de Tauri: empieza a
 * sonar una lista de discos en el servicio de música y enseña el registro en directo. La música se
 * arranca desde aquí, con la app delante, como pide Android para que el servicio pase a primer plano
 * (notificación y controles en la pantalla de bloqueo).
 */
class Fase0Activity : ComponentActivity() {
  private val main = Handler(Looper.getMainLooper())
  private val worker = Executors.newSingleThreadExecutor()
  private var controllerFuture: ListenableFuture<MediaController>? = null
  private lateinit var status: TextView
  private lateinit var log: TextView

  private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
    Fase0Log.log("permiso de notificaciones: ${if (granted) "sí" else "no"}")
    start()
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    Fase0Log.init(this)

    val dp = resources.displayMetrics.density
    val root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setBackgroundColor(Color.rgb(15, 15, 16))
      setPadding((20 * dp).toInt(), (20 * dp).toInt(), (20 * dp).toInt(), (20 * dp).toInt())
    }
    ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      v.setPadding((20 * dp).toInt(), bars.top + (20 * dp).toInt(), (20 * dp).toInt(), bars.bottom + (20 * dp).toInt())
      insets
    }
    root.addView(TextView(this).apply {
      text = "Prueba: música con la pantalla apagada"
      textSize = 20f
      setTextColor(Color.WHITE)
      typeface = Typeface.DEFAULT_BOLD
    })
    status = TextView(this).apply {
      text = "Pulsa «Empezar». Cuando suene, apaga la pantalla y déjalo una hora."
      textSize = 15f
      setTextColor(Color.rgb(200, 200, 205))
      setPadding(0, (12 * dp).toInt(), 0, (12 * dp).toInt())
    }
    root.addView(status)
    val buttons = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
    buttons.addView(Button(this).apply {
      text = "Empezar"
      setOnClickListener { askThenStart() }
    })
    buttons.addView(Button(this).apply {
      text = "Enviar registro"
      setOnClickListener { shareLog() }
    })
    root.addView(buttons)
    log = TextView(this).apply {
      textSize = 11f
      typeface = Typeface.MONOSPACE
      setTextColor(Color.rgb(170, 170, 178))
    }
    root.addView(ScrollView(this).apply {
      addView(log)
      layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f)
    }, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
    setContentView(root, android.view.ViewGroup.LayoutParams(MATCH_PARENT, MATCH_PARENT))
    showLog()
  }

  override fun onDestroy() {
    main.removeCallbacksAndMessages(null)
    controllerFuture?.let { MediaController.releaseFuture(it) }
    worker.shutdown()
    super.onDestroy()
  }

  /** Últimas líneas del registro, cada 2 segundos. */
  private fun showLog() {
    val file = File(filesDir, "fase0.log")
    log.text = if (file.exists()) file.readLines().takeLast(80).reversed().joinToString("\n") else "(sin registro todavía)"
    main.postDelayed({ showLog() }, 2000)
  }

  /** Android 13 o superior: el permiso de notificaciones, para ver los controles de la música. */
  private fun askThenStart() {
    if (Build.VERSION.SDK_INT >= 33 &&
      ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) {
      askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
    } else {
      start()
    }
  }

  private fun start() {
    status.text = "Preparando la lista de discos…"
    Fase0Log.log("=== prueba nueva: $QUERIES")
    worker.execute {
      val items = try {
        playlist()
      } catch (e: Throwable) {
        Fase0Log.log("lista: ERROR $e")
        main.post { status.text = "No se pudo preparar la lista: $e" }
        return@execute
      }
      main.post { play(items) }
    }
  }

  /** Canciones de los discos de prueba (las saca el núcleo Rust de Deezer). */
  private fun playlist(): List<MediaItem> {
    val json = MusifyCore.playlist(QUERIES.replace('|', '\n'))
    if (json.startsWith("{")) throw IllegalStateException(JSONObject(json).optString("error"))
    val list = JSONArray(json)
    return (0 until list.length()).map { i ->
      val t = list.getJSONObject(i)
      val query = JSONObject()
        .put("id", t.getLong("id"))
        .put("title", t.getString("title"))
        .put("artist", t.getString("artist"))
        .put("album", t.getString("album"))
        .put("duration", t.getInt("duration"))
        .toString()
      val meta = MediaMetadata.Builder()
        .setTitle(t.getString("title"))
        .setArtist(t.getString("artist"))
        .setAlbumTitle(t.getString("album"))
      t.optString("cover").takeIf { it.isNotEmpty() && it != "null" }?.let { meta.setArtworkUri(Uri.parse(it)) }
      MediaItem.Builder()
        .setMediaId(t.getLong("id").toString())
        .setMediaMetadata(meta.build())
        .setRequestMetadata(
          MediaItem.RequestMetadata.Builder().setExtras(Bundle().apply { putString(PlaybackService.EXTRA_QUERY, query) }).build(),
        )
        .build()
    }
  }

  /** Conecta con el servicio de música y le pasa la lista (así Android lo deja en primer plano). */
  private fun play(items: List<MediaItem>) {
    status.text = "Conectando con el reproductor…"
    val token = SessionToken(this, ComponentName(this, PlaybackService::class.java))
    val future = MediaController.Builder(this, token).buildAsync()
    controllerFuture = future
    future.addListener({
      val controller = try {
        future.get()
      } catch (e: Exception) {
        Fase0Log.log("reproductor: ERROR al conectar $e")
        status.text = "No se pudo conectar con el reproductor: $e"
        return@addListener
      }
      Fase0Log.log("lista: ${items.size} canciones")
      controller.setMediaItems(items)
      controller.prepare()
      controller.play()
      status.text = "Sonando ${items.size} canciones. Ya puedes apagar la pantalla. Al terminar, vuelve aquí y pulsa «Enviar registro»."
    }, ContextCompat.getMainExecutor(this))
  }

  private fun shareLog() {
    val file = File(filesDir, "fase0.log")
    if (!file.exists()) {
      status.text = "Todavía no hay registro."
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

  companion object {
    /** Discos que nunca se han preparado en el móvil: más de dos horas seguidas. */
    const val QUERIES = "radiohead ok computer|extremoduro agila|rosalia el mal querer|berri txarrak infrasoinuak"
  }
}
