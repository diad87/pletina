package dev.musify.desktop

import android.app.Activity
import android.content.ComponentName
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.webkit.WebView
import androidx.annotation.OptIn
import androidx.core.content.ContextCompat
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONArray
import org.json.JSONObject

/**
 * Puente entre la interfaz y el servicio de música (PlaybackService). La interfaz manda órdenes
 * (src-tauri/src/native_player.rs → aquí) y este plugin las pasa al servicio con un MediaController.
 * Lo que cambia en el reproductor vuelve a la interfaz como eventos "player-timeline" (la cola) y
 * "player-status" (canción, posición, si suena...), por `MusifyCore.emit`.
 *
 * Tauri llama a las órdenes desde otro hilo; el MediaController solo se usa en el principal.
 */
@OptIn(UnstableApi::class)
@TauriPlugin
class PlayerPlugin(private val activity: Activity) : Plugin(activity) {
  private val main = Handler(Looper.getMainLooper())
  private var future: ListenableFuture<MediaController>? = null
  private var controller: MediaController? = null
  private val waiting = mutableListOf<(MediaController) -> Unit>()

  override fun load(webView: WebView) {
    main.post { connect() }
  }

  override fun onDestroy() {
    future?.let { MediaController.releaseFuture(it) }
    future = null
    controller = null
  }

  /** Conecta con el servicio (lo arranca si hace falta). */
  private fun connect() {
    if (future != null) return
    val token = SessionToken(activity, ComponentName(activity, PlaybackService::class.java))
    val f = MediaController.Builder(activity, token).buildAsync()
    future = f
    f.addListener({
      val c = runCatching { f.get() }.getOrNull()
      if (c == null) {
        future = null
        return@addListener
      }
      controller = c
      c.addListener(listener)
      val pending = waiting.toList()
      waiting.clear()
      pending.forEach { it(c) }
      emitTimeline(c)
      emitStatus(c)
    }, ContextCompat.getMainExecutor(activity))
  }

  /** Ejecuta en el hilo principal con el controlador listo, y responde a la interfaz. */
  private fun run(invoke: Invoke, block: (MediaController) -> JSObject?) {
    main.post {
      val task: (MediaController) -> Unit = { c ->
        try {
          invoke.resolve(block(c) ?: JSObject())
        } catch (e: Exception) {
          invoke.reject(e.message ?: e.toString())
        }
      }
      val c = controller
      if (c != null) task(c) else {
        waiting.add(task)
        connect()
      }
    }
  }

  private fun items(args: JSObject) = args.getJSONArray("entries").let { list ->
    (0 until list.length()).map { PlaybackService.itemFromEntry(list.getJSONObject(it)) }
  }

  // --- Órdenes ------------------------------------------------------------------------------

  @Command
  fun state(invoke: Invoke) = run(invoke) { c -> snapshot(c, withEntries = true) }

  /** Cambia toda la cola (`entries`) y empieza por `index` (en `positionMs`, si se da). */
  @Command
  fun setQueue(invoke: Invoke) {
    val args = invoke.getArgs()
    run(invoke) { c ->
      c.setMediaItems(items(args), args.optInt("index", 0), args.optLong("positionMs", 0))
      c.prepare()
      if (args.optBoolean("play", true)) c.play()
      null
    }
  }

  /** Mete canciones en la cola, en la posición `index`. */
  @Command
  fun insert(invoke: Invoke) {
    val args = invoke.getArgs()
    run(invoke) { c ->
      val list = items(args)
      val index = args.optInt("index", c.mediaItemCount).coerceIn(0, c.mediaItemCount)
      c.addMediaItems(index, list)
      if (c.playbackState == Player.STATE_IDLE || c.playbackState == Player.STATE_ENDED) {
        // No sonaba nada: empieza por lo que se acaba de meter.
        c.seekToDefaultPosition(index)
        c.prepare()
        c.play()
      }
      null
    }
  }

  /** Quita las canciones entre `from` (incluida) y `to` (sin incluir). */
  @Command
  fun remove(invoke: Invoke) {
    val args = invoke.getArgs()
    run(invoke) { c ->
      c.removeMediaItems(args.getInt("from"), args.getInt("to"))
      null
    }
  }

  @Command
  fun move(invoke: Invoke) {
    val args = invoke.getArgs()
    run(invoke) { c ->
      c.moveMediaItem(args.getInt("from"), args.getInt("to"))
      null
    }
  }

  /** Sustituye las canciones entre `from` y `to` por `entries` (aleatorio). La actual no se toca. */
  @Command
  fun replace(invoke: Invoke) {
    val args = invoke.getArgs()
    run(invoke) { c ->
      val from = args.getInt("from")
      val to = args.getInt("to").coerceAtMost(c.mediaItemCount)
      if (to > from) c.removeMediaItems(from, to)
      c.addMediaItems(from, items(args))
      null
    }
  }

  @Command
  fun skipTo(invoke: Invoke) {
    val args = invoke.getArgs()
    run(invoke) { c ->
      c.seekToDefaultPosition(args.getInt("index"))
      if (c.playbackState == Player.STATE_IDLE) c.prepare()
      c.play()
      null
    }
  }

  @Command
  fun play(invoke: Invoke) = run(invoke) { c ->
    if (c.playbackState == Player.STATE_IDLE || c.playbackState == Player.STATE_ENDED) c.prepare()
    c.play()
    null
  }

  @Command
  fun pause(invoke: Invoke) = run(invoke) { c ->
    c.pause()
    null
  }

  @Command
  fun next(invoke: Invoke) = run(invoke) { c ->
    c.seekToNextMediaItem()
    null
  }

  /** Como en cualquier reproductor: si lleva más de 3 s, al principio; si no, la anterior. */
  @Command
  fun previous(invoke: Invoke) = run(invoke) { c ->
    c.seekToPrevious()
    null
  }

  @Command
  fun seek(invoke: Invoke) {
    val args = invoke.getArgs()
    run(invoke) { c ->
      c.seekTo(args.getLong("positionMs"))
      null
    }
  }

  @Command
  fun setRepeat(invoke: Invoke) {
    val args = invoke.getArgs()
    run(invoke) { c ->
      c.repeatMode = when (args.getString("mode")) {
        "all" -> Player.REPEAT_MODE_ALL
        "one" -> Player.REPEAT_MODE_ONE
        else -> Player.REPEAT_MODE_OFF
      }
      null
    }
  }

  @Command
  fun setVolume(invoke: Invoke) {
    val args = invoke.getArgs()
    run(invoke) { c ->
      c.volume = args.getDouble("volume").toFloat().coerceIn(0f, 1f)
      null
    }
  }

  /** La canción actual con URL nueva (p. ej. tras elegir otro vídeo), en el mismo segundo. */
  @Command
  fun reload(invoke: Invoke) = run(invoke) { c ->
    val item = c.currentMediaItem ?: return@run null
    PlaybackService.trackId(item)?.let { PlaybackService.refresh.add(it) }
    val index = c.currentMediaItemIndex
    val position = c.currentPosition
    c.stop()
    c.seekTo(index, position)
    c.prepare()
    c.play()
    null
  }

  // --- Estado hacia la interfaz -------------------------------------------------------------

  private val listener = object : Player.Listener {
    override fun onEvents(player: Player, events: Player.Events) {
      val c = controller ?: return
      if (events.contains(Player.EVENT_TIMELINE_CHANGED)) emitTimeline(c)
      if (events.containsAny(
          Player.EVENT_MEDIA_ITEM_TRANSITION,
          Player.EVENT_IS_PLAYING_CHANGED,
          Player.EVENT_PLAYBACK_STATE_CHANGED,
          Player.EVENT_PLAY_WHEN_READY_CHANGED,
          Player.EVENT_POSITION_DISCONTINUITY,
          Player.EVENT_REPEAT_MODE_CHANGED,
          Player.EVENT_TIMELINE_CHANGED,
        )
      ) emitStatus(c)
    }
  }

  private fun entries(c: MediaController): JSONArray {
    val list = JSONArray()
    for (i in 0 until c.mediaItemCount) list.put(PlaybackService.entryOf(c.getMediaItemAt(i)) ?: JSONObject.NULL)
    return list
  }

  private fun snapshot(c: MediaController, withEntries: Boolean): JSObject {
    val state = JSObject()
    if (withEntries) state.put("entries", entries(c))
    state.put("index", c.currentMediaItemIndex)
    state.put("positionMs", c.currentPosition)
    state.put("durationMs", if (c.duration == C.TIME_UNSET) -1 else c.duration)
    state.put("playing", c.isPlaying)
    state.put("playWhenReady", c.playWhenReady)
    state.put(
      "state",
      when (c.playbackState) {
        Player.STATE_BUFFERING -> "buffering"
        Player.STATE_READY -> "ready"
        Player.STATE_ENDED -> "ended"
        else -> "idle"
      },
    )
    state.put(
      "repeat",
      when (c.repeatMode) {
        Player.REPEAT_MODE_ALL -> "all"
        Player.REPEAT_MODE_ONE -> "one"
        else -> "off"
      },
    )
    // Momento de la foto: la interfaz calcula la posición actual a partir de aquí.
    state.put("at", System.currentTimeMillis())
    state.put("uptime", SystemClock.elapsedRealtime())
    return state
  }

  private fun emitTimeline(c: MediaController) {
    MusifyCore.emit("player-timeline", JSONObject().put("entries", entries(c)).toString())
  }

  private fun emitStatus(c: MediaController) {
    MusifyCore.emit("player-status", snapshot(c, withEntries = false).toString())
  }
}
