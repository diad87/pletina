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
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaConstants
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaLibraryService.LibraryParams
import androidx.media3.session.MediaLibraryService.MediaLibrarySession
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionError
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
    session = MediaLibrarySession.Builder(this, player, callback).build()
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
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    MusifyLog.log("servicio: destruido")
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

  private val callback = object : MediaLibrarySession.Callback {
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
    ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> = background {
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
      retries = 0
      recorded = false
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
      if (!playWhenReady) save()
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
    }

    override fun onPlayerError(error: PlaybackException) {
      MusifyLog.log("error: ${error.errorCodeName} ${error.message} (${network()})")
      val item = player.currentMediaItem ?: return
      val id = trackId(item) ?: return
      // Siempre con URL nueva: la anterior puede haber caducado o ser de otra red.
      refresh.add(id)
      when {
        error.errorCode !in 2000..2999 -> skip("no se puede reproducir")
        network() == "sin red" -> {
          val next = nextOffline()
          if (next != null) {
            // Sin conexión solo suenan las descargadas: a la siguiente que lo esté.
            MusifyLog.log("sin red y «${item.mediaMetadata.title}» no está descargada: a la siguiente descargada (${next + 1})")
            MusifyCore.emit("player-error", JSONObject().put("message", "Sin conexión: suenan solo las canciones descargadas").toString())
            retries = 0
            player.seekTo(next, 0)
            player.prepare()
            player.play()
          } else {
            waitingForNetwork = true
            MusifyLog.log("esperando a que vuelva la red")
          }
        }
        retries < 3 -> {
          retries++
          main.postDelayed({ resume("reintento $retries") }, 1000L * retries)
        }
        else -> skip("no sale después de 3 intentos")
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
              if (error.isNotEmpty()) MusifyLog.log("historial: ERROR $error")
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
          MusifyLog.log("red: ${network()}")
          if (waitingForNetwork) {
            waitingForNetwork = false
            retries = 0
            resume("vuelve la red")
          }
        }, 1500)
      }

      override fun onLost(network: Network) {
        MusifyLog.log("red: perdida")
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
