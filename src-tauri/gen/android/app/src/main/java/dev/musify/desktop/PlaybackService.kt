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
import android.os.SystemClock
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
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
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaConstants
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaLibraryService.LibraryParams
import androidx.media3.session.MediaLibraryService.MediaLibrarySession
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionError
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture
import java.io.File
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong
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
class PlaybackService : MediaLibraryService() {
  private var session: MediaLibrarySession? = null
  private lateinit var player: ExoPlayer
  private val main = Handler(Looper.getMainLooper())
  private val worker = Executors.newSingleThreadExecutor()
  private val carLibrary = CarLibrary()
  private val librarySnapshots = ConcurrentHashMap<String, CarLibrary.Snapshot>()
  private val carQueueSequence = AtomicLong(System.currentTimeMillis())

  /** Canción (id de Deezer) → consulta para el núcleo (TrackQuery en JSON). */
  private val queries = ConcurrentHashMap<String, String>()
  private val recovery = PlaybackRecovery(
    snapshot = {
      PlaybackRecovery.Snapshot(player.currentMediaItem?.mediaId, player.playWhenReady, player.isPlaying, player.currentPosition)
    },
    hasInternet = { internetValidated },
    schedule = { delay, action ->
      val task = Runnable { action() }
      main.postDelayed(task, delay)
      val cancel: () -> Unit = { main.removeCallbacks(task) }
      cancel
    },
    resume = { resume(it) },
  )
  @Volatile private var internetValidated = false
  /** La canción actual ya se apuntó en el historial. */
  private var recorded = false
  private var networkCallback: ConnectivityManager.NetworkCallback? = null
  private var episodeGeneration = 0
  private val pendingEpisodeResume = mutableMapOf<String, Int>()
  private val episodeDurations = mutableMapOf<String, Long>()
  private val completedItems = mutableSetOf<String>()
  private var applyingEpisodeResume = false
  private var destroyed = false
  private val sleepTimer = SleepTimer()
  private var sleepItemId: String? = null
  private val sleepDeadline = Runnable { checkSleepDeadline() }

  /** Pantalla encendida / apagada, para el registro. */
  private val screen = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      MusifyLog.log(if (intent.action == Intent.ACTION_SCREEN_OFF) "pantalla apagada" else "pantalla encendida")
    }
  }

  override fun onCreate() {
    super.onCreate()
    MusifyLog.init(this)
    MusifyCore.init(dataDir.absolutePath)
    coversDir = covers(this)
    MusifyLog.log("servicio: creado")

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
    // stop() can leave playWhenReady=true, and a redundant pause emits no listener event.
    // Capture the command itself, including commands from notifications and external clients.
    val sessionPlayer = object : ForwardingPlayer(player) {
      override fun play() {
        recovery.onPlayIntent(true)
        super.play()
      }
      override fun pause() {
        recovery.onPlayIntent(false)
        super.pause()
      }
      override fun setPlayWhenReady(playWhenReady: Boolean) {
        recovery.onPlayIntent(playWhenReady)
        super.setPlayWhenReady(playWhenReady)
      }
      override fun stop() {
        recovery.onPlayIntent(false)
        super.stop()
      }
    }
    session = MediaLibrarySession.Builder(this, sessionPlayer, callback)
      .setSessionExtras(Bundle().apply { putBundle(SLEEP_TIMER_EXTRA, sleepExtras()) }).build()
    restore()
    watchNetwork()
    tick()
    heartbeat()
    watchLibrary()
    registerReceiver(screen, IntentFilter().apply {
      addAction(Intent.ACTION_SCREEN_OFF)
      addAction(Intent.ACTION_SCREEN_ON)
    })
    val free = getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(packageName) == true
    MusifyLog.log("ahorro de batería de Android: ${if (free) "sin restricciones" else "con restricciones (lo normal)"}")
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? = session

  override fun onTaskRemoved(rootIntent: Intent?) {
    MusifyLog.log("app quitada de recientes; sonando=${player.isPlaying}")
    save()
    saveEpisodeProgress()
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    MusifyLog.log("servicio: destruido")
    recovery.onPlayIntent(false)
    save()
    saveEpisodeProgress()
    destroyed = true
    episodeGeneration++
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

  private val callback = object : MediaLibrarySession.Callback {
    override fun onConnectAsync(mediaSession: MediaSession, controller: MediaSession.ControllerInfo): ListenableFuture<MediaSession.ConnectionResult> {
      checkSleepDeadline()
      // Conservar las órdenes de biblioteca para Android Auto y los navegadores multimedia.
      val commands = if (controller.isTrusted) MediaSession.ConnectionResult.DEFAULT_SESSION_AND_LIBRARY_COMMANDS
        else MediaSession.ConnectionResult.DEFAULT_UNTRUSTED_SESSION_AND_LIBRARY_COMMANDS
      val result = MediaSession.ConnectionResult.AcceptedResultBuilder(mediaSession, controller)
        .setAvailableSessionCommands(commands.buildUpon()
          .add(SessionCommand(SLEEP_TIMER_COMMAND, Bundle.EMPTY))
          .add(SessionCommand(CANCEL_END_SLEEP_TIMER_COMMAND, Bundle.EMPTY)).build())
        .build()
      return Futures.immediateFuture(result)
    }

    override fun onCustomCommand(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
      customCommand: SessionCommand,
      args: Bundle,
    ): ListenableFuture<SessionResult> {
      if (customCommand.customAction == CANCEL_END_SLEEP_TIMER_COMMAND) {
        if (sleepTimer.mode == "end") clearSleepTimer()
        return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
      }
      if (customCommand.customAction != SLEEP_TIMER_COMMAND) return super.onCustomCommand(mediaSession, controller, customCommand, args)
      val minutes = args.getInt("minutes", Int.MIN_VALUE)
      val result = when {
        minutes != -1 && minutes !in 0..1440 -> SessionResult.RESULT_ERROR_BAD_VALUE
        minutes == -1 && player.currentMediaItem == null -> SessionResult.RESULT_ERROR_INVALID_STATE
        else -> {
          setSleepTimer(minutes)
          SessionResult.RESULT_SUCCESS
        }
      }
      return Futures.immediateFuture(SessionResult(result))
    }

    override fun onGetLibraryRoot(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<MediaItem>> {
      // El navegador legacy espera en el hilo principal: la raíz debe responder inmediatamente.
      val resultParams = LibraryParams.Builder().setExtras(Bundle().apply {
        putBoolean("android.media.browse.SEARCH_SUPPORTED", true)
        putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM)
        putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_PLAYABLE, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM)
      }).build()
      return Futures.immediateFuture(LibraryResult.ofItem(carLibrary.root(), resultParams))
    }

    override fun onGetChildren(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      parentId: String,
      page: Int,
      pageSize: Int,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> = libraryTask {
      LibraryResult.ofItemList(carLibrary.children(parentId, page, pageSize), params)
    }

    override fun onGetItem(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      mediaId: String,
    ): ListenableFuture<LibraryResult<MediaItem>> = libraryTask {
      LibraryResult.ofItem(carLibrary.item(mediaId), null)
    }

    override fun onSubscribe(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      parentId: String,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<Void>> = libraryTask {
      val snapshot = carLibrary.snapshot(parentId)
      librarySnapshots[parentId] = snapshot
      main.post { if (this@PlaybackService.session === session) session.notifyChildrenChanged(browser, parentId, snapshot.count, params) }
      LibraryResult.ofVoid(params)
    }

    override fun onSearch(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      query: String,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<Void>> = libraryTask {
      val count = carLibrary.count(CarLibrary.searchParent(query))
      main.post { if (this@PlaybackService.session === session) session.notifySearchResultChanged(browser, query, count, params) }
      LibraryResult.ofVoid(params)
    }

    override fun onGetSearchResult(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      query: String,
      page: Int,
      pageSize: Int,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> = libraryTask {
      LibraryResult.ofItemList(carLibrary.search(query, page, pageSize), params)
    }

    /** Canciones que manda un controlador (Media3 les quita la URI): se les vuelve a poner. */
    override fun onAddMediaItems(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
      mediaItems: MutableList<MediaItem>,
    ): ListenableFuture<MutableList<MediaItem>> {
      saveEpisodeProgress()
      // ctx identifica una aparición en la cola de fondo de la app. Las adiciones externas
      // necesitan posiciones nuevas incluso si añaden dos veces la misma canción.
      val entries = (0 until player.mediaItemCount).mapNotNull { entryOf(player.getMediaItemAt(it)) }
      val nextContext = (entries.filter { !it.optBoolean("user") }.maxOfOrNull { it.optInt("ctx", -1) } ?: -1) + 1
      val context = entries.firstOrNull { !it.optBoolean("user") }?.optString("context")
      return background {
        mediaItems.mapIndexed { index, item ->
          if (controller.packageName == packageName) nativeItem(item, controller)
          else carQueueItem(item, nextContext + index, context)
        }.toMutableList()
      }
    }

    /** Android Auto (también legacy) pide una canción por ID, sin abrir antes la app. */
    override fun onSetMediaItems(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
      mediaItems: MutableList<MediaItem>,
      startIndex: Int,
      startPositionMs: Long,
    ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
      if (sleepTimer.mode == "end") clearSleepTimer()
      saveEpisodeProgress()
      // Invalidate immediately; resolving an external queue happens asynchronously.
      recovery.onEntryChanged()
      return background {
        val fromApp = controller.packageName == packageName && mediaItems.all {
          entryOf(it) != null || it.requestMetadata.extras?.getString(EXTRA_QUERY) != null
        }
        if (!fromApp && mediaItems.size == 1) {
          val selected = carLibrary.selection(mediaItems[0])
          selected.items.forEach { entryOf(it)?.let(::remember) }
          MediaSession.MediaItemsWithStartPosition(selected.items, selected.index, startPositionMs.takeIf { it >= 0 } ?: 0)
        } else {
          val items = mediaItems.mapIndexed { index, item ->
            if (fromApp) nativeItem(item, controller) else carQueueItem(item, index, null)
          }
          MediaSession.MediaItemsWithStartPosition(items, startIndex, startPositionMs)
        }
      }
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

  /** La app aporta su cola completa; los controladores externos solo eligen IDs de SQLite. */
  private fun nativeItem(item: MediaItem, controller: MediaSession.ControllerInfo): MediaItem {
    if (controller.packageName == packageName) {
      entryOf(item)?.let {
        remember(it)
        return itemFromEntry(it)
      }
      // Compatibilidad con la prueba nativa inicial, que mandaba únicamente la consulta.
      item.requestMetadata.extras?.getString(EXTRA_QUERY)?.let { query ->
        val id = JSONObject(query).getLong("id").toString()
        queries[id] = query
        return item.buildUpon().setUri("musify://track/$id").build()
      }
    }
    return carLibrary.single(item).also { entryOf(it)?.let(::remember) }
  }

  private fun carQueueItem(item: MediaItem, contextIndex: Int, context: String?): MediaItem {
    val resolved = carLibrary.single(item)
    val entry = requireNotNull(entryOf(resolved))
      .put("uid", "car-queue:${carQueueSequence.incrementAndGet()}")
      .put("ctx", contextIndex)
    if (context != null) entry.put("context", context)
    remember(entry)
    return itemFromEntry(entry)
  }

  private fun <T> background(block: () -> T): ListenableFuture<T> {
    val future = SettableFuture.create<T>()
    worker.execute {
      if (!future.isCancelled) {
        try { future.set(block()) } catch (error: Exception) { future.setException(error) }
      }
    }
    return future
  }

  private fun <T : Any> libraryTask(block: () -> LibraryResult<T>): ListenableFuture<LibraryResult<T>> = background {
    try { block() } catch (error: Exception) {
      MusifyLog.log("biblioteca del coche: ${error.message}")
      LibraryResult.ofError(SessionError.ERROR_BAD_VALUE)
    }
  }

  private fun remember(entry: JSONObject) {
    val query = entry.optJSONObject("query") ?: return
    queries[query.getLong("id").toString()] = query.toString()
  }

  /** El mismo espacio de ids que podcasts.rs; no incluye la música local. */
  private fun isPodcast(id: String?): Boolean =
    id?.toLongOrNull()?.let { it >= 500_000_000_000_000L && it < 1_000_000_000_000_000L } == true

  /** Lo llama ExoPlayer (en un hilo suyo) al abrir cada canción: le da la URL de YouTube o el archivo. */
  private fun resolve(spec: DataSpec): DataSpec {
    if (spec.uri.scheme != "musify") return spec
    val id = spec.uri.lastPathSegment ?: return spec
    val query = queries[id] ?: throw IOException("canción desconocida: $id")
    val fresh = refresh.remove(id)
    val res = JSONObject(MusifyCore.resolve(query, fresh))
    if (res.has("error")) {
      val error = res.getString("error")
      MusifyLog.log("url $id: ERROR $error (${network()})")
      throw IOException(error)
    }
    if (spec.position == 0L || fresh) {
      MusifyLog.log("url $id: ${res.getLong("ms")} ms, vídeo ${res.optString("videoId")}${if (fresh) ", nueva" else ""} (${network()})")
    }
    val url = res.getString("url")
    return spec.withUri(if (res.optBoolean("local")) Uri.fromFile(File(url)) else Uri.parse(url))
  }

  private val listener = object : Player.Listener {
    override fun onMediaItemTransition(item: MediaItem?, reason: Int) {
      if (sleepTimer.mode == "end") {
        if (reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO || reason == Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT) {
          finishSleepTimer()
        } else if (item?.mediaId != sleepItemId) clearSleepTimer()
      }
      recovery.onEntryChanged()
      recorded = false
      resumeEpisode(item, reason)
      val why = when (reason) {
        Player.MEDIA_ITEM_TRANSITION_REASON_AUTO -> "sola"
        Player.MEDIA_ITEM_TRANSITION_REASON_SEEK -> "salto"
        Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED -> "lista nueva"
        else -> "repetir"
      }
      MusifyLog.log("suena (${player.currentMediaItemIndex + 1}/${player.mediaItemCount}, $why): ${item?.mediaMetadata?.artist} — ${item?.mediaMetadata?.title}")
      save()
    }

    override fun onTimelineChanged(timeline: androidx.media3.common.Timeline, reason: Int) {
      if (reason == Player.TIMELINE_CHANGE_REASON_PLAYLIST_CHANGED) save()
    }

    override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
      if (!playWhenReady && reason == Player.PLAY_WHEN_READY_CHANGE_REASON_END_OF_MEDIA_ITEM && sleepTimer.mode == "end") {
        player.currentMediaItem?.let { completedItems.add(it.mediaId) }
        finishSleepTimer()
      } else if (playWhenReady && checkSleepDeadline()) {
        // La pausa ya ha notificado el nuevo estado: no restablecer la intención anterior.
        return
      }
      val why = when (reason) {
        Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST -> "pedido (botón, notificación, bloqueo o auriculares)"
        Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_FOCUS_LOSS -> "otra app o una llamada se ha quedado el sonido"
        Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_BECOMING_NOISY -> "se han desconectado los auriculares"
        Player.PLAY_WHEN_READY_CHANGE_REASON_REMOTE -> "desde otro dispositivo"
        Player.PLAY_WHEN_READY_CHANGE_REASON_END_OF_MEDIA_ITEM -> "fin de la canción"
        Player.PLAY_WHEN_READY_CHANGE_REASON_SUPPRESSED_TOO_LONG -> "demasiado rato en silencio"
        else -> "otro motivo ($reason)"
      }
      MusifyLog.log("${if (playWhenReady) "reanudar" else "pausa"}: $why")
      recovery.onPlayIntent(playWhenReady)
      if (!playWhenReady) {
        save()
        saveEpisodeProgress()
      }
    }

    override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
      val old = oldPosition.mediaItem
      if (old != null && old.mediaId !in pendingEpisodeResume && !applyingEpisodeResume) {
        val ended = reason == Player.DISCONTINUITY_REASON_AUTO_TRANSITION || old.mediaId in completedItems
        writeEpisodeProgress(old, oldPosition.positionMs, episodeDurations[old.mediaId] ?: 0, ended)
      }
      // Un salto dentro del mismo episodio es una decisión del usuario, incluido volver a cero.
      if (old?.mediaId == newPosition.mediaItem?.mediaId && reason == Player.DISCONTINUITY_REASON_SEEK) {
        if (!applyingEpisodeResume && old != null && old.mediaId in pendingEpisodeResume) {
          // Un seek del usuario durante la lectura gana a la reanudación pendiente.
          episodeGeneration++
          pendingEpisodeResume.remove(old.mediaId)
        }
        newPosition.mediaItem?.let { completedItems.remove(it.mediaId) }
        saveEpisodeProgress()
      }
    }

    override fun onPlaybackStateChanged(playbackState: Int) {
      val item = player.currentMediaItem ?: return
      if (playbackState == Player.STATE_READY && player.duration > 0) {
        episodeDurations[item.mediaId] = player.duration
        if (isPodcast(trackId(item)) && player.currentPosition >= player.duration) {
          // Una fuente distinta (RSS/YouTube) puede ser más corta que la escucha anterior.
          player.seekTo((player.duration - 1000).coerceAtLeast(0))
        }
      }
      if (playbackState == Player.STATE_ENDED) {
        completedItems.add(item.mediaId)
        saveEpisodeProgress()
        if (sleepTimer.mode == "end") finishSleepTimer()
      }
    }

    override fun onPlaybackSuppressionReasonChanged(reason: Int) {
      when (reason) {
        Player.PLAYBACK_SUPPRESSION_REASON_NONE -> MusifyLog.log("vuelve el sonido")
        Player.PLAYBACK_SUPPRESSION_REASON_TRANSIENT_AUDIO_FOCUS_LOSS -> MusifyLog.log("en silencio un momento: otro sonido (notificación, llamada...)")
        else -> MusifyLog.log("en silencio un momento (motivo $reason)")
      }
    }

    override fun onIsPlayingChanged(isPlaying: Boolean) {
      MusifyLog.log(if (isPlaying) "sonando" else "parado (${state()})")
      recovery.onPlayingChanged()
      if (!isPlaying) saveEpisodeProgress()
    }

    override fun onPlayerError(error: PlaybackException) {
      MusifyLog.log("error: ${error.errorCodeName} ${error.message} (${network()})")
      if (checkSleepDeadline()) return
      val item = player.currentMediaItem ?: return
      val id = trackId(item) ?: return
      // Siempre con URL nueva: la anterior puede haber caducado o ser de otra red.
      refresh.add(id)
      // A stopped/paused player must not advance the queue or start a delayed recovery.
      if (!recovery.wantsPlayback()) return
      when {
        error.errorCode !in 2000..2999 -> skip("no se puede reproducir")
        !internetValidated -> {
          val next = nextOffline()
          if (next != null) {
            if (sleepTimer.mode == "end") {
              finishSleepTimer()
              return
            }
            // Sin conexión solo suenan las descargadas: a la siguiente que lo esté.
            MusifyLog.log("sin red y «${item.mediaMetadata.title}» no está descargada: a la siguiente descargada (${next + 1})")
            MusifyCore.emit("player-error", JSONObject().put("message", "Sin conexión: suenan solo las canciones descargadas").toString())
            recovery.onEntryChanged()
            player.seekTo(next, 0)
            player.prepare()
            player.play()
          } else {
            recovery.onFailure()
            MusifyLog.log("esperando a que vuelva la red")
          }
        }
        recovery.onFailure() == PlaybackRecovery.Failure.EXHAUSTED -> skip("no sale después de 3 intentos")
      }
    }
  }

  /** Sin red: la siguiente canción de la cola que está descargada, o null si no hay ninguna. */
  private fun nextOffline(): Int? {
    val timeline = player.currentTimeline
    if (timeline.isEmpty) return null
    val repeat = if (player.repeatMode == Player.REPEAT_MODE_ONE) Player.REPEAT_MODE_ALL else player.repeatMode
    val start = player.currentMediaItemIndex
    var i = timeline.getNextWindowIndex(start, repeat, player.shuffleModeEnabled)
    while (i != C.INDEX_UNSET && i != start) {
      val id = trackId(player.getMediaItemAt(i))?.toLongOrNull()
      if (id != null && MusifyCore.isDownloaded(id)) return i
      i = timeline.getNextWindowIndex(i, repeat, player.shuffleModeEnabled)
    }
    return null
  }

  /** Sigue en la misma canción y el mismo segundo. */
  private fun resume(why: String) {
    if (destroyed || checkSleepDeadline() || !recovery.wantsPlayback()) return
    val at = player.currentPosition
    MusifyLog.log("$why desde ${at / 1000} s")
    player.seekTo(player.currentMediaItemIndex, at)
    player.prepare()
    player.play()
  }

  /** Esta canción no sale: a la siguiente, para que la música no se pare. */
  private fun skip(why: String) {
    val title = player.currentMediaItem?.mediaMetadata?.title
    MusifyLog.log("se salta ($why)")
    MusifyCore.emit("player-error", JSONObject().put("message", "No se pudo reproducir «$title»: $why").toString())
    if (sleepTimer.mode == "end") {
      finishSleepTimer()
      return
    }
    if (checkSleepDeadline() || !recovery.wantsPlayback()) return
    recovery.onEntryChanged()
    if (player.hasNextMediaItem()) {
      player.seekToNextMediaItem()
      player.prepare()
      player.play()
    }
  }

  /** Cada 5 s mientras suena: apunta la canción en el historial a los 30 s (o la mitad si es corta). */
  private fun tick() {
    main.postDelayed({
      checkSleepDeadline()
      if (player.isPlaying && !recorded) {
        val duration = player.duration.takeIf { it > 0 } ?: 60_000
        if (player.currentPosition >= minOf(30_000, duration / 2)) {
          recorded = true
          val lib = player.currentMediaItem?.let { entryOf(it) }?.optJSONObject("lib")
          if (lib != null) {
            worker.execute {
              val error = MusifyCore.recordPlay(lib.toString())
              if (error.isNotEmpty()) MusifyLog.log("historial: ERROR $error")
            }
          }
        }
      }
      if (player.isPlaying) {
        save(quiet = true)
        saveEpisodeProgress()
      }
      tick()
    }, 5_000)
  }

  // --- Temporizador de apagado --------------------------------------------------------------

  private fun sleepExtras() = Bundle().apply {
    putString("mode", sleepTimer.mode)
    putLong("endsAt", sleepTimer.endsAt)
  }

  private fun publishSleepTimer() {
    session?.let { current ->
      current.setSessionExtras(Bundle(current.sessionExtras).apply { putBundle(SLEEP_TIMER_EXTRA, sleepExtras()) })
    }
    MusifyCore.emit("sleep-timer", JSONObject().put("mode", sleepTimer.mode).put("endsAt", sleepTimer.endsAt).toString())
  }

  private fun setSleepTimer(minutes: Int) {
    main.removeCallbacks(sleepDeadline)
    sleepTimer.set(minutes, SystemClock.elapsedRealtime(), System.currentTimeMillis())
    sleepItemId = if (minutes == -1) player.currentMediaItem?.mediaId else null
    player.setPauseAtEndOfMediaItems(minutes == -1)
    sleepTimer.remaining(SystemClock.elapsedRealtime())?.let { main.postDelayed(sleepDeadline, it) }
    publishSleepTimer()
    MusifyLog.log("temporizador: ${sleepTimer.mode}${if (minutes > 0) ", $minutes min" else ""}")
    if (minutes == -1 && player.playbackState == Player.STATE_ENDED) finishSleepTimer()
  }

  private fun clearSleepTimer() {
    main.removeCallbacks(sleepDeadline)
    sleepTimer.clear()
    sleepItemId = null
    player.setPauseAtEndOfMediaItems(false)
    publishSleepTimer()
  }

  private fun finishSleepTimer() {
    // Invalida también los reintentos ya desencolados y la espera de una red validada.
    recovery.onPlayIntent(false)
    // Pausar antes de quitar el freno al final del elemento impide que arranque el siguiente.
    player.pause()
    clearSleepTimer()
    save()
    saveEpisodeProgress()
    MusifyLog.log("temporizador: pausa")
  }

  /** Devuelve true si acaba de vencer; los reintentos no pueden deshacer esta pausa. */
  private fun checkSleepDeadline(): Boolean {
    val remaining = sleepTimer.remaining(SystemClock.elapsedRealtime()) ?: return false
    if (remaining == 0L) {
      finishSleepTimer()
      return true
    }
    main.removeCallbacks(sleepDeadline)
    main.postDelayed(sleepDeadline, remaining)
    return false
  }

  // --- Progreso de podcasts ------------------------------------------------------------------

  /** La cola puede cambiar o la WebView puede cerrarse; cada episodio conserva su propio punto. */
  private fun writeEpisodeProgress(item: MediaItem, position: Long, duration: Long, completed: Boolean) {
    val id = trackId(item)?.toLongOrNull() ?: return
    if (!isPodcast(id.toString())) return
    val data = JSONObject().put("id", id)
      .put("position", position.coerceAtLeast(0) / 1000.0)
      .put("duration", duration.coerceAtLeast(0) / 1000.0)
      .put("completed", completed).toString()
    worker.execute {
      val error = MusifyCore.savePodcastProgress(data)
      if (error.isNotEmpty()) MusifyLog.log("progreso del podcast: ERROR $error")
    }
  }

  private fun saveEpisodeProgress() {
    val item = player.currentMediaItem ?: return
    // Preparar un audio emite eventos en posición cero antes de recuperar lo guardado.
    if (item.mediaId in pendingEpisodeResume) return
    val duration = player.duration.takeIf { it > 0 } ?: episodeDurations[item.mediaId] ?: 0
    if (duration > 0) episodeDurations[item.mediaId] = duration
    writeEpisodeProgress(item, player.currentPosition, duration, item.mediaId in completedItems)
  }

  private fun resumeEpisode(item: MediaItem?, reason: Int) {
    val generation = ++episodeGeneration
    val id = item?.let { trackId(it) }?.toLongOrNull() ?: return
    if (!isPodcast(id.toString())) return
    completedItems.remove(item.mediaId)
    // Repetir un episodio terminado empieza desde el principio, sin releer la posición anterior.
    if (reason == Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT) return
    pendingEpisodeResume[item.mediaId] = generation
    // El mismo worker ordena primero el guardado del episodio anterior y luego esta lectura.
    // Dejar acabar los callbacks del salto antes de leer (guardan la posición anterior).
    main.post read@ {
      if (destroyed) return@read
      worker.execute {
        val raw = MusifyCore.podcastProgress(id)
        val saved = runCatching { JSONObject(raw) }.getOrNull()
        val position = if (saved?.optBoolean("completed") == false) {
          (saved.optDouble("position", 0.0) * 1000).toLong().coerceAtLeast(0)
        } else 0L
        main.post apply@ {
          if (pendingEpisodeResume[item.mediaId] == generation) pendingEpisodeResume.remove(item.mediaId)
          if (destroyed || generation != episodeGeneration || player.currentMediaItem?.mediaId != item.mediaId) return@apply
          if (saved?.has("error") == true) {
            MusifyLog.log("recuperar podcast: ${saved.optString("error")}")
            return@apply
          }
          val duration = player.duration.takeIf { it > 0 }
          val at = if (duration != null) position.coerceAtMost((duration - 1000).coerceAtLeast(0)) else position
          if (at > 0 || saved?.optBoolean("completed") == true) {
            applyingEpisodeResume = true
            player.seekTo(at)
            applyingEpisodeResume = false
          }
          save()
        }
      }
    }
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
    MusifyLog.log("cola recuperada: ${saved.mediaItems.size} canciones, en la ${saved.startIndex + 1}")
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
        MusifyLog.log("vivo: ${player.currentMediaItemIndex + 1}/${player.mediaItemCount} en ${player.currentPosition / 1000} s, ${if (player.isPlaying) "sonando" else state()} (${network()}${if (doze) ", reposo profundo" else ""})")
      }
      heartbeat()
    }, 60_000)
  }

  /** La app puede editar SQLite mientras el coche conserva una carpeta en pantalla. */
  private fun watchLibrary() {
    main.postDelayed({
      val current = session
      if (current != null) {
        val parents = librarySnapshots.keys.filter { parent ->
          val subscribed = current.getSubscribedControllers(parent).isNotEmpty()
          if (!subscribed) librarySnapshots.remove(parent)
          subscribed
        }
        if (parents.isNotEmpty()) worker.execute {
          for (parent in parents) {
            val previous = librarySnapshots[parent] ?: continue
            val next = try { carLibrary.snapshot(parent) } catch (error: Exception) {
              // Un fallo temporal no cancela la suscripción: se reintenta en el siguiente ciclo.
              MusifyLog.log("biblioteca del coche: no se pudo actualizar $parent: ${error.message}")
              continue
            }
            if (next == previous) continue
            librarySnapshots[parent] = next
            main.post {
              if (session === current) current.notifyChildrenChanged(parent, next.count, null)
            }
          }
        }
      }
      watchLibrary()
    }, 5_000)
  }

  private fun network(): String {
    val cm = getSystemService(ConnectivityManager::class.java) ?: return "?"
    val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return "sin red"
    val transport = when {
      caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
      caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "datos"
      else -> "otra red"
    }
    return if (validated(caps)) transport else "$transport sin Internet validado"
  }

  private fun watchNetwork() {
    val cm = getSystemService(ConnectivityManager::class.java) ?: return
    var current = cm.activeNetwork
    internetValidated = validated(current?.let { cm.getNetworkCapabilities(it) })
    val callback = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        main.post {
          current = network
          internetValidated = false
        }
      }

      override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
        // Use callback data, not a synchronous query which can describe a different network.
        val ready = validated(capabilities)
        main.post {
          if (current == network) {
            internetValidated = ready
            recovery.onNetworkChanged()
          }
        }
      }

      override fun onLost(network: Network) {
        main.post {
          if (current == network) {
            current = null
            internetValidated = false
            MusifyLog.log("red: perdida")
          }
        }
      }
    }
    cm.registerDefaultNetworkCallback(callback)
    networkCallback = callback
  }

  companion object {
    const val SLEEP_TIMER_COMMAND = "dev.musify.desktop.SET_SLEEP_TIMER"
    const val CANCEL_END_SLEEP_TIMER_COMMAND = "dev.musify.desktop.CANCEL_END_SLEEP_TIMER"
    const val SLEEP_TIMER_EXTRA = "sleepTimer"
    internal fun validated(capabilities: NetworkCapabilities?): Boolean =
      capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true &&
        capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)

    /** La entrada de la interfaz (JSON), en `mediaMetadata.extras`. */
    const val EXTRA_ENTRY = "entry"
    /** Prueba de la fase 0: solo la consulta, en `requestMetadata.extras`. */
    const val EXTRA_QUERY = "query"

    /** Carátulas de los discos descargados (las guarda src-tauri/src/downloads.rs). */
    @Volatile var coversDir: File? = null

    fun covers(context: Context) = File(context.dataDir, "descargas/_portadas")

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
        .setIsBrowsable(false)
        .setIsPlayable(true)
        .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
        .setExtras(Bundle().apply { putString(EXTRA_ENTRY, entry.toString()) })
      // La carátula guardada al descargar, si la hay: así se ve también sin conexión.
      val saved = coversDir?.let { File(it, "${item.optLong("albumId")}.jpg") }?.takeIf { it.exists() }
      if (saved != null) {
        meta.setArtworkUri(Uri.fromFile(saved))
      } else {
        item.optString("cover").takeIf { it.isNotEmpty() && it != "null" }?.let {
          meta.setArtworkUri(if (it.startsWith("http")) Uri.parse(it) else Uri.fromFile(File(it)))
        }
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
