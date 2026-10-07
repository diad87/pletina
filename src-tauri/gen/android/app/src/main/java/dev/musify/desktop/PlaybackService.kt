package dev.musify.desktop

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.PowerManager
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
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONObject

/**
 * Servicio de música (fase 0 de docs/plan-mobile.md). Tiene el reproductor (ExoPlayer) y la cola,
 * y sigue sonando con la pantalla apagada. Cada canción entra como `musify://track/<id>` y su URL
 * de YouTube se le pide al núcleo Rust justo cuando ExoPlayer va a abrirla; ExoPlayer prepara la
 * siguiente antes de que acabe la actual.
 *
 * La lista llega de un MediaController (la pantalla de la prueba, `Fase0Activity`): Media3 quita las
 * URIs de lo que mandan los controladores, así que cada canción trae su consulta en
 * `requestMetadata.extras` y aquí se le pone su `musify://track/<id>` (`onAddMediaItems`).
 */
@OptIn(UnstableApi::class)
class PlaybackService : MediaSessionService() {
  private var session: MediaSession? = null
  private lateinit var player: ExoPlayer
  private val main = Handler(Looper.getMainLooper())

  /** Canción (id de Deezer) → consulta para el núcleo (TrackQuery en JSON). */
  private val queries = ConcurrentHashMap<String, String>()
  /** Canciones cuya URL hay que pedir de nuevo (caducada, otra red, 403). */
  private val refresh = ConcurrentHashMap.newKeySet<String>()
  /** Reintentos seguidos de la canción actual. */
  private var retries = 0
  /** Se cortó por falta de red: en cuanto vuelva, se sigue en el mismo punto. */
  private var waitingForNetwork = false
  private var networkCallback: ConnectivityManager.NetworkCallback? = null

  /** Pantalla encendida / apagada, para saber en qué condiciones pasa cada cosa. */
  private val screen = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      Fase0Log.log(if (intent.action == Intent.ACTION_SCREEN_OFF) "pantalla apagada" else "pantalla encendida")
    }
  }

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
    session = MediaSession.Builder(this, player).setCallback(callback).build()
    watchNetwork()
    heartbeat()
    registerReceiver(screen, IntentFilter().apply {
      addAction(Intent.ACTION_SCREEN_OFF)
      addAction(Intent.ACTION_SCREEN_ON)
    })
    val power = getSystemService(PowerManager::class.java)
    val free = power?.isIgnoringBatteryOptimizations(packageName) == true
    Fase0Log.log("ahorro de batería de Android: ${if (free) "sin restricciones" else "con restricciones (lo normal)"}")
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

  override fun onTaskRemoved(rootIntent: Intent?) {
    Fase0Log.log("app quitada de recientes; sonando=${player.isPlaying}")
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    Fase0Log.log("servicio: destruido")
    main.removeCallbacksAndMessages(null)
    runCatching { unregisterReceiver(screen) }
    networkCallback?.let { getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(it) }
    session?.run {
      player.release()
      release()
    }
    session = null
    super.onDestroy()
  }

  private val callback = object : MediaSession.Callback {
    /** Canciones que manda un controlador: se apunta su consulta y se les pone su URI. */
    override fun onAddMediaItems(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
      mediaItems: MutableList<MediaItem>,
    ): ListenableFuture<MutableList<MediaItem>> {
      val items = mediaItems.map { item ->
        item.requestMetadata.extras?.getString(EXTRA_QUERY)?.let { queries[item.mediaId] = it }
        item.buildUpon().setUri("musify://track/${item.mediaId}").build()
      }
      return Futures.immediateFuture(items.toMutableList())
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

    /** Por qué se pausa o se reanuda (botón, otra app, auriculares...). */
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
    }

    /** Silencios cortos sin pausar: una notificación, el timbre de una llamada... */
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
      val id = player.currentMediaItem?.mediaId ?: return
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
    Fase0Log.log("se salta ($why)")
    retries = 0
    if (player.hasNextMediaItem()) {
      player.seekToNextMediaItem()
      player.prepare()
      player.play()
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
    /** Consulta de la canción para el núcleo (TrackQuery en JSON), en `requestMetadata.extras`. */
    const val EXTRA_QUERY = "query"
  }
}
