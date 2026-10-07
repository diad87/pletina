package dev.musify.desktop

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import java.io.File
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject

/**
 * Servicio de música (docs/plan-mobile.md). Tiene el reproductor (ExoPlayer) y la cola, y sigue
 * sonando con la pantalla apagada. La interfaz lo maneja con un MediaController (PlayerPlugin.kt);
 * la notificación, la pantalla de bloqueo y los auriculares, por la sesión multimedia.
 *
 * Cada canción es una "entrada" de la interfaz (JSON en `mediaMetadata.extras`, ver
 * `itemFromEntry`) y suena como `musify://track/<id>`: su URL de YouTube se le pide al núcleo Rust
 * justo cuando ExoPlayer va a abrirla, y ExoPlayer prepara la siguiente antes de que acabe la actual.
 * La cola se guarda en files/cola.json para seguir donde estaba aunque Android cierre la app.
 */
@OptIn(UnstableApi::class)
class PlaybackService : MediaSessionService() {
  private var session: MediaSession? = null
  private lateinit var player: ExoPlayer
  private val main = Handler(Looper.getMainLooper())
  private val worker = Executors.newSingleThreadExecutor()

  /** Canción (id de Deezer) → consulta para el núcleo (TrackQuery en JSON). */
  private val queries = ConcurrentHashMap<String, String>()
  /** Reintentos seguidos de la canción actual. */
  private var retries = 0
  /** Se cortó por falta de red: en cuanto vuelva, se sigue en el mismo punto. */
  private var waitingForNetwork = false
  /** La canción actual ya se apuntó en el historial. */
  private var recorded = false
  private var networkCallback: ConnectivityManager.NetworkCallback? = null

  /** Pantalla encendida / apagada, para el registro. */
  private val screen = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      Fase0Log.log(if (intent.action == Intent.ACTION_SCREEN_OFF) "pantalla apagada" else "pantalla encendida")
    }
  }

  override fun onCreate() {
    super.onCreate()
    Fase0Log.init(this)
    MusifyCore.init(dataDir.absolutePath)
    Fase0Log.log("servicio: creado")

    val http = DefaultHttpDataSource.Factory().setAllowCrossProtocolRedirects(true)
    // DefaultDataSource: además de http, archivos (música guardada en el móvil).
    val upstream = DefaultDataSource.Factory(this, http)
    val resolving = ResolvingDataSource.Factory(upstream) { spec -> resolve(spec) }
    player = ExoPlayer.Builder(this)
      .setMediaSourceFactory(DefaultMediaSourceFactory(resolving))
      .setAudioAttributes(
        AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(),
        /* handleAudioFocus = */ true,
      )
      .setHandleAudioBecomingNoisy(true)
      .setWakeMode(C.WAKE_MODE_NETWORK)
      .build()
    player.addListener(listener)
    session = MediaSession.Builder(this, player).setCallback(callback).build()
    restore()
    watchNetwork()
    tick()
    heartbeat()
    registerReceiver(screen, IntentFilter().apply {
      addAction(Intent.ACTION_SCREEN_OFF)
      addAction(Intent.ACTION_SCREEN_ON)
    })
    val free = getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(packageName) == true
    Fase0Log.log("ahorro de batería de Android: ${if (free) "sin restricciones" else "con restricciones (lo normal)"}")
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

  override fun onTaskRemoved(rootIntent: Intent?) {
    Fase0Log.log("app quitada de recientes; sonando=${player.isPlaying}")
    save()
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    Fase0Log.log("servicio: destruido")
    save()
    main.removeCallbacksAndMessages(null)
    runCatching { unregisterReceiver(screen) }
    networkCallback?.let { getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(it) }
    session?.run {
      player.release()
      release()
    }
    session = null
    worker.shutdown()
    super.onDestroy()
  }

  private val callback = object : MediaSession.Callback {
    /** Canciones que manda un controlador (Media3 les quita la URI): se les vuelve a poner. */
    override fun onAddMediaItems(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
      mediaItems: MutableList<MediaItem>,
    ): ListenableFuture<MutableList<MediaItem>> {
      val items = mediaItems.map { item ->
        val entry = entryOf(item)
        if (entry != null) {
          remember(entry)
          itemFromEntry(entry)
        } else {
          // Prueba de la fase 0 (Fase0Activity): solo trae la consulta.
          item.requestMetadata.extras?.getString(EXTRA_QUERY)?.let { queries[item.mediaId] = it }
          item.buildUpon().setUri("musify://track/${item.mediaId}").build()
        }
      }
      return Futures.immediateFuture(items.toMutableList())
    }

    /** "Play" en los auriculares o en la tarjeta de Android con la app cerrada: la última cola. */
    override fun onPlaybackResumption(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
    ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
      val saved = loadSaved() ?: return Futures.immediateFailedFuture(UnsupportedOperationException("no hay cola guardada"))
      return Futures.immediateFuture(saved)
    }
  }

  private fun remember(entry: JSONObject) {
    val query = entry.optJSONObject("query") ?: return
    queries[query.getLong("id").toString()] = query.toString()
  }

  /** Lo llama ExoPlayer (en un hilo suyo) al abrir cada canción: le da la URL de YouTube o el archivo. */
  private fun resolve(spec: DataSpec): DataSpec {
    if (spec.uri.scheme != "musify") return spec
    val id = spec.uri.lastPathSegment ?: return spec
    val query = queries[id] ?: throw IOException("canción desconocida: $id")
    val fresh = refresh.remove(id)
    val res = JSONObject(MusifyCore.resolve(query, fresh))
    if (res.has("error")) {
      val error = res.getString("error")
      Fase0Log.log("url $id: ERROR $error (${network()})")
      throw IOException(error)
    }
    if (spec.position == 0L || fresh) {
      Fase0Log.log("url $id: ${res.getLong("ms")} ms, vídeo ${res.optString("videoId")}${if (fresh) ", nueva" else ""} (${network()})")
    }
    val url = res.getString("url")
    return spec.withUri(if (res.optBoolean("local")) Uri.fromFile(File(url)) else Uri.parse(url))
  }

  private val listener = object : Player.Listener {
    override fun onMediaItemTransition(item: MediaItem?, reason: Int) {
      retries = 0
      recorded = false
      val why = when (reason) {
        Player.MEDIA_ITEM_TRANSITION_REASON_AUTO -> "sola"
        Player.MEDIA_ITEM_TRANSITION_REASON_SEEK -> "salto"
        Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED -> "lista nueva"
        else -> "repetir"
      }
      Fase0Log.log("suena (${player.currentMediaItemIndex + 1}/${player.mediaItemCount}, $why): ${item?.mediaMetadata?.artist} — ${item?.mediaMetadata?.title}")
      save()
    }

    override fun onTimelineChanged(timeline: androidx.media3.common.Timeline, reason: Int) {
      if (reason == Player.TIMELINE_CHANGE_REASON_PLAYLIST_CHANGED) save()
    }

    override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
      val why = when (reason) {
        Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST -> "pedido (botón, notificación, bloqueo o auriculares)"
        Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_FOCUS_LOSS -> "otra app o una llamada se ha quedado el sonido"
        Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_BECOMING_NOISY -> "se han desconectado los auriculares"
        Player.PLAY_WHEN_READY_CHANGE_REASON_REMOTE -> "desde otro dispositivo"
        Player.PLAY_WHEN_READY_CHANGE_REASON_END_OF_MEDIA_ITEM -> "fin de la canción"
        Player.PLAY_WHEN_READY_CHANGE_REASON_SUPPRESSED_TOO_LONG -> "demasiado rato en silencio"
        else -> "otro motivo ($reason)"
      }
      Fase0Log.log("${if (playWhenReady) "reanudar" else "pausa"}: $why")
      if (!playWhenReady) save()
    }

    override fun onPlaybackSuppressionReasonChanged(reason: Int) {
      when (reason) {
        Player.PLAYBACK_SUPPRESSION_REASON_NONE -> Fase0Log.log("vuelve el sonido")
        Player.PLAYBACK_SUPPRESSION_REASON_TRANSIENT_AUDIO_FOCUS_LOSS -> Fase0Log.log("en silencio un momento: otro sonido (notificación, llamada...)")
        else -> Fase0Log.log("en silencio un momento (motivo $reason)")
      }
    }

    override fun onIsPlayingChanged(isPlaying: Boolean) {
      Fase0Log.log(if (isPlaying) "sonando" else "parado (${state()})")
    }

    override fun onPlayerError(error: PlaybackException) {
      Fase0Log.log("error: ${error.errorCodeName} ${error.message} (${network()})")
      val item = player.currentMediaItem ?: return
      val id = trackId(item) ?: return
      // Siempre con URL nueva: la anterior puede haber caducado o ser de otra red.
      refresh.add(id)
      when {
        error.errorCode !in 2000..2999 -> skip("no se puede reproducir")
        network() == "sin red" -> {
          waitingForNetwork = true
          Fase0Log.log("esperando a que vuelva la red")
        }
        retries < 3 -> {
          retries++
          main.postDelayed({ resume("reintento $retries") }, 1000L * retries)
        }
        else -> skip("no sale después de 3 intentos")
      }
    }
  }

  /** Sigue en la misma canción y el mismo segundo. */
  private fun resume(why: String) {
    val at = player.currentPosition
    Fase0Log.log("$why desde ${at / 1000} s")
    player.seekTo(player.currentMediaItemIndex, at)
    player.prepare()
    player.play()
  }

  /** Esta canción no sale: a la siguiente, para que la música no se pare. */
  private fun skip(why: String) {
    val title = player.currentMediaItem?.mediaMetadata?.title
    Fase0Log.log("se salta ($why)")
    MusifyCore.emit("player-error", JSONObject().put("message", "No se pudo reproducir «$title»: $why").toString())
    retries = 0
    if (player.hasNextMediaItem()) {
      player.seekToNextMediaItem()
      player.prepare()
      player.play()
    }
  }

  /** Cada 5 s mientras suena: apunta la canción en el historial a los 30 s (o la mitad si es corta). */
  private fun tick() {
    main.postDelayed({
      if (player.isPlaying && !recorded) {
        val duration = player.duration.takeIf { it > 0 } ?: 60_000
        if (player.currentPosition >= minOf(30_000, duration / 2)) {
          recorded = true
          val lib = player.currentMediaItem?.let { entryOf(it) }?.optJSONObject("lib")
          if (lib != null) {
            worker.execute {
              val error = MusifyCore.recordPlay(lib.toString())
              if (error.isNotEmpty()) Fase0Log.log("historial: ERROR $error")
            }
          }
        }
      }
      if (player.isPlaying) save(quiet = true)
      tick()
    }, 5_000)
  }

  // --- Cola guardada ------------------------------------------------------------------------

  private val savedFile get() = File(filesDir, "cola.json")
  private var lastSave = 0L

  /** Guarda la cola, la canción y el segundo (con `quiet`, como mucho cada 30 s). */
  private fun save(quiet: Boolean = false) {
    if (quiet && System.currentTimeMillis() - lastSave < 30_000) return
    lastSave = System.currentTimeMillis()
    val entries = JSONArray()
    for (i in 0 until player.mediaItemCount) {
      entryOf(player.getMediaItemAt(i))?.let { entries.put(it) }
    }
    if (entries.length() != player.mediaItemCount) return // cola de la prueba de la fase 0: no se guarda
    val data = JSONObject()
      .put("entries", entries)
      .put("index", player.currentMediaItemIndex)
      .put("position", player.currentPosition)
      .put("repeat", player.repeatMode)
      .toString()
    worker.execute { runCatching { savedFile.writeText(data) } }
  }

  private fun loadSaved(): MediaSession.MediaItemsWithStartPosition? = runCatching {
    val data = JSONObject(savedFile.readText())
    val entries = data.getJSONArray("entries")
    val items = (0 until entries.length()).map { i -> entries.getJSONObject(i).also { remember(it) }.let { itemFromEntry(it) } }
    if (items.isEmpty()) return null
    player.repeatMode = data.optInt("repeat", Player.REPEAT_MODE_OFF)
    MediaSession.MediaItemsWithStartPosition(items, data.optInt("index", 0).coerceIn(0, items.size - 1), data.optLong("position", 0))
  }.getOrNull()

  /** Al arrancar, la última cola, en pausa (así la interfaz la enseña y "play" sigue donde iba). */
  private fun restore() {
    val saved = loadSaved() ?: return
    player.setMediaItems(saved.mediaItems, saved.startIndex, saved.startPositionMs)
    Fase0Log.log("cola recuperada: ${saved.mediaItems.size} canciones, en la ${saved.startIndex + 1}")
  }

  // --- Registro y red -----------------------------------------------------------------------

  private fun state() = when (player.playbackState) {
    Player.STATE_BUFFERING -> "cargando"
    Player.STATE_READY -> "listo"
    Player.STATE_ENDED -> "terminado"
    else -> "sin nada"
  }

  /** Cada minuto, en el registro: el servicio sigue vivo y por dónde va. */
  private fun heartbeat() {
    main.postDelayed({
      if (player.mediaItemCount > 0 && player.playWhenReady) {
        val doze = getSystemService(PowerManager::class.java)?.isDeviceIdleMode == true
        Fase0Log.log("vivo: ${player.currentMediaItemIndex + 1}/${player.mediaItemCount} en ${player.currentPosition / 1000} s, ${if (player.isPlaying) "sonando" else state()} (${network()}${if (doze) ", reposo profundo" else ""})")
      }
      heartbeat()
    }, 60_000)
  }

  private fun network(): String {
    val cm = getSystemService(ConnectivityManager::class.java) ?: return "?"
    val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return "sin red"
    return when {
      caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
      caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "datos"
      else -> "otra red"
    }
  }

  private fun watchNetwork() {
    val cm = getSystemService(ConnectivityManager::class.java) ?: return
    val callback = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        main.postDelayed({
          Fase0Log.log("red: ${network()}")
          if (waitingForNetwork) {
            waitingForNetwork = false
            retries = 0
            resume("vuelve la red")
          }
        }, 1500)
      }

      override fun onLost(network: Network) {
        Fase0Log.log("red: perdida")
      }
    }
    cm.registerDefaultNetworkCallback(callback)
    networkCallback = callback
  }

  companion object {
    /** La entrada de la interfaz (JSON), en `mediaMetadata.extras`. */
    const val EXTRA_ENTRY = "entry"
    /** Prueba de la fase 0: solo la consulta, en `requestMetadata.extras`. */
    const val EXTRA_QUERY = "query"

    /** Canciones (id de Deezer) cuya URL hay que pedir de nuevo; también la usa PlayerPlugin ("reload"). */
    val refresh: MutableSet<String> = ConcurrentHashMap.newKeySet()

    fun entryOf(item: MediaItem): JSONObject? =
      item.mediaMetadata.extras?.getString(EXTRA_ENTRY)?.let { runCatching { JSONObject(it) }.getOrNull() }

    fun trackId(item: MediaItem): String? =
      entryOf(item)?.optJSONObject("query")?.optLong("id")?.toString() ?: item.mediaId.takeIf { it.isNotEmpty() }

    /**
     * De una entrada de la interfaz (ver src/lib/player-android.svelte.ts) a lo que suena:
     * `{uid, item: QueueItem, lib: LibTrack, query: TrackQuery, user, key, ctx, context}`.
     */
    fun itemFromEntry(entry: JSONObject): MediaItem {
      val item = entry.getJSONObject("item")
      val track = item.getJSONObject("track")
      val meta = MediaMetadata.Builder()
        .setTitle(track.optString("title"))
        .setArtist(track.optJSONObject("artist")?.optString("name"))
        .setAlbumTitle(item.optString("albumTitle"))
        .setExtras(Bundle().apply { putString(EXTRA_ENTRY, entry.toString()) })
      item.optString("cover").takeIf { it.isNotEmpty() && it != "null" }?.let {
        meta.setArtworkUri(if (it.startsWith("http")) Uri.parse(it) else Uri.fromFile(File(it)))
      }
      val id = entry.getJSONObject("query").getLong("id")
      return MediaItem.Builder()
        .setMediaId(entry.optString("uid", id.toString()))
        .setUri("musify://track/$id")
        .setMediaMetadata(meta.build())
        .build()
    }
  }
}
