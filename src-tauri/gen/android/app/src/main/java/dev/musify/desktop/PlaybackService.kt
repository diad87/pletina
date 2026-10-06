package dev.musify.desktop

import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Handler
import android.os.Looper
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
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject

/**
 * Servicio de música (fase 0 de docs/plan-mobile.md). Tiene el reproductor (ExoPlayer) y la cola,
 * y sigue sonando con la pantalla apagada. Cada canción entra como `musify://track/<id>` y su URL
 * de YouTube se le pide al núcleo Rust justo cuando ExoPlayer va a abrirla; ExoPlayer prepara la
 * siguiente antes de que acabe la actual.
 *
 * Para la prueba se arranca desde la actividad:
 * `adb shell am start -n dev.musify.desktop/.MainActivity --es fase0 "radiohead ok computer|estopa estopa"`
 */
@OptIn(UnstableApi::class)
class PlaybackService : MediaSessionService() {
  private var session: MediaSession? = null
  private lateinit var player: ExoPlayer
  private val main = Handler(Looper.getMainLooper())
  private val worker = Executors.newSingleThreadExecutor()

  /** Canción (id de Deezer) → consulta para el núcleo (TrackQuery en JSON). */
  private val queries = ConcurrentHashMap<String, String>()
  /** Canciones cuya URL hay que pedir de nuevo (caducada, otra red, 403). */
  private val refresh = ConcurrentHashMap.newKeySet<String>()
  /** Reintentos seguidos de la canción actual. */
  private var retries = 0
  private var networkCallback: ConnectivityManager.NetworkCallback? = null

  override fun onCreate() {
    super.onCreate()
    Fase0Log.init(this)
    Fase0Log.log("servicio: creado")

    val http = DefaultHttpDataSource.Factory().setAllowCrossProtocolRedirects(true)
    val resolving = ResolvingDataSource.Factory(http) { spec -> resolve(spec) }
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
    session = MediaSession.Builder(this, player).build()
    watchNetwork()
    heartbeat()
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_FASE0) {
      intent.getStringExtra(EXTRA_QUERIES)?.let { start(it.replace('|', '\n')) }
    }
    return super.onStartCommand(intent, flags, startId)
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    Fase0Log.log("app quitada de recientes; sonando=${player.isPlaying}")
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    Fase0Log.log("servicio: destruido")
    main.removeCallbacksAndMessages(null)
    networkCallback?.let { getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(it) }
    session?.run {
      player.release()
      release()
    }
    session = null
    worker.shutdown()
    super.onDestroy()
  }

  /** Monta la cola con los discos de las búsquedas y empieza a sonar. */
  private fun start(searches: String) {
    worker.execute {
      val json = MusifyCore.playlist(searches)
      if (json.startsWith("{")) {
        Fase0Log.log("lista: error ${JSONObject(json).optString("error")}")
        return@execute
      }
      val list = JSONArray(json)
      val items = (0 until list.length()).map { i ->
        val t = list.getJSONObject(i)
        val id = t.getLong("id").toString()
        queries[id] = JSONObject()
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
        MediaItem.Builder().setMediaId(id).setUri("musify://track/$id").setMediaMetadata(meta.build()).build()
      }
      Fase0Log.log("lista: ${items.size} canciones (${searches.replace('\n', '|')})")
      main.post {
        player.setMediaItems(items)
        player.prepare()
        player.play()
      }
    }
  }

  /** Lo llama ExoPlayer (en un hilo suyo) al abrir cada canción: le da la URL de YouTube. */
  private fun resolve(spec: DataSpec): DataSpec {
    if (spec.uri.scheme != "musify") return spec
    val id = spec.uri.lastPathSegment ?: return spec
    val query = queries[id] ?: throw IOException("canción desconocida: $id")
    val fresh = refresh.remove(id)
    val res = JSONObject(MusifyCore.resolve(query, fresh))
    if (res.has("error")) {
      Fase0Log.log("url $id: ERROR ${res.getString("error")} (${network()})")
      throw IOException(res.getString("error"))
    }
    if (spec.position == 0L || fresh) {
      Fase0Log.log("url $id: ${res.getLong("ms")} ms, vídeo ${res.getString("videoId")}${if (fresh) ", nueva" else ""} (${network()})")
    }
    return spec.withUri(Uri.parse(res.getString("url")))
  }

  private val listener = object : Player.Listener {
    override fun onMediaItemTransition(item: MediaItem?, reason: Int) {
      retries = 0
      val why = when (reason) {
        Player.MEDIA_ITEM_TRANSITION_REASON_AUTO -> "sola"
        Player.MEDIA_ITEM_TRANSITION_REASON_SEEK -> "salto"
        Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED -> "lista nueva"
        else -> "repetir"
      }
      Fase0Log.log("suena (${player.currentMediaItemIndex + 1}/${player.mediaItemCount}, $why): ${item?.mediaMetadata?.artist} — ${item?.mediaMetadata?.title}")
    }

    override fun onIsPlayingChanged(isPlaying: Boolean) {
      Fase0Log.log(if (isPlaying) "sonando" else "parado (${state()})")
    }

    override fun onPlayerError(error: PlaybackException) {
      Fase0Log.log("error: ${error.errorCodeName} ${error.message} (${network()})")
      val id = player.currentMediaItem?.mediaId ?: return
      // Problema de red o URL que ya no vale: se pide otra y se sigue en el mismo segundo.
      if (error.errorCode in 2000..2999 && retries < 3) {
        retries++
        refresh.add(id)
        val at = player.currentPosition
        main.postDelayed({
          Fase0Log.log("reintento $retries desde ${at / 1000} s")
          player.seekTo(player.currentMediaItemIndex, at)
          player.prepare()
          player.play()
        }, 1000L * retries)
      }
    }
  }

  private fun state() = when (player.playbackState) {
    Player.STATE_BUFFERING -> "cargando"
    Player.STATE_READY -> "listo"
    Player.STATE_ENDED -> "terminado"
    else -> "sin nada"
  }

  /** Cada minuto: el servicio sigue vivo y por dónde va (para ver la hora con la pantalla apagada). */
  private fun heartbeat() {
    main.postDelayed({
      if (player.mediaItemCount > 0) {
        Fase0Log.log("vivo: ${player.currentMediaItemIndex + 1}/${player.mediaItemCount} en ${player.currentPosition / 1000} s, ${if (player.isPlaying) "sonando" else state()} (${network()})")
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
        main.postDelayed({ Fase0Log.log("red: ${network()}") }, 500)
      }

      override fun onLost(network: Network) {
        Fase0Log.log("red: perdida")
      }
    }
    cm.registerDefaultNetworkCallback(callback)
    networkCallback = callback
  }

  companion object {
    const val ACTION_FASE0 = "dev.musify.FASE0"
    const val EXTRA_QUERIES = "queries"
  }
}
