package dev.musify.desktop

import android.content.ComponentName
import android.content.ContentValues
import android.content.Intent
import android.database.sqlite.SQLiteDatabase
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaBrowser
import androidx.media3.session.SessionResult
import androidx.media3.session.SessionToken
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Callable
import java.util.concurrent.CompletableFuture
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Usa SQLite, JNI y ExoPlayer reales, sin abrir Activity ni reproducir audio audible. */
@OptIn(UnstableApi::class)
@RunWith(AndroidJUnit4::class)
class CarPlaybackTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val context get() = instrumentation.targetContext
  private val database get() = File(context.dataDir, "musify.db")

  private data class Fixture(val first: Long, val second: Long, val playlist: Long, val audio: File)

  private fun <T> onMain(block: () -> T): T {
    val task = FutureTask(Callable { block() })
    instrumentation.runOnMainSync(task)
    return task.get(15, TimeUnit.SECONDS)
  }

  @Test
  fun mediaIdSelectionPreparesOfflineAndPreservesPlaylistDuplicates() {
    // La variante habitual puede contener la biblioteca del usuario: ni siquiera se abre su DB.
    assumeTrue("Esta prueba necesita el applicationIdSuffix .autotest", context.packageName.endsWith(".autotest"))
    MusifyCore.init(context.dataDir.absolutePath)
    val root = JSONObject(MusifyCore.browse("root"))
    assertFalse(root.toString(), root.has("error"))
    val fixture = seed()
    var browser: MediaBrowser? = null
    try {
      assertFixtureVisibleToRust(fixture)
      assertOffline(fixture.first, "Auto test A")
      assertOffline(fixture.second, "Auto test B")
      val connected = onMain {
        MediaBrowser.Builder(context, SessionToken(context, ComponentName(context, PlaybackService::class.java)))
          .buildAsync()
      }
      val controller = connected.get(15, TimeUnit.SECONDS)
      browser = controller
      val children = onMain { controller.getChildren("playlist:${fixture.playlist}", 0, Int.MAX_VALUE, null) }
        .get(15, TimeUnit.SECONDS)
      assertEquals(SessionResult.RESULT_SUCCESS, children.resultCode)
      val items = children.value!!
      assertEquals(listOf("Auto test A", "Auto test B", "Auto test A"), items.map { it.mediaMetadata.title.toString() })
      assertNotEquals("Las dos apariciones de A necesitan identidad propia", items[0].mediaId, items[2].mediaId)
      val request = MediaItem.Builder().setMediaId(items[1].mediaId).build()
      assertNull("El coche solo entrega un ID", request.localConfiguration)

      awaitReady(controller, 1) {
        controller.pause()
        controller.volume = 0f
        controller.repeatMode = Player.REPEAT_MODE_OFF
        controller.shuffleModeEnabled = false
        controller.setMediaItem(request)
        controller.prepare()
      }
      onMain {
        assertEquals(3, controller.mediaItemCount)
        assertEquals(1, controller.currentMediaItemIndex)
        assertEquals("Auto test B", controller.currentMediaItem!!.mediaMetadata.title.toString())
        assertEquals(listOf("Auto test A", "Auto test B", "Auto test A"),
          (0 until controller.mediaItemCount).map { controller.getMediaItemAt(it).mediaMetadata.title.toString() })
        assertFalse(controller.playWhenReady)
        assertFalse(controller.isPlaying)
        assertTrue(controller.hasNextMediaItem())
      }
      awaitReady(controller, 2) { controller.seekToNextMediaItem() }
      onMain {
        assertEquals(3, controller.mediaItemCount)
        assertEquals(2, controller.currentMediaItemIndex)
        assertEquals("Auto test A", controller.currentMediaItem!!.mediaMetadata.title.toString())
        assertFalse(controller.playWhenReady)
        assertFalse(controller.isPlaying)
      }
    } finally {
      browser?.let { controller ->
        onMain {
          controller.pause()
          controller.stop()
          controller.clearMediaItems()
          controller.release()
        }
      }
      onMain { context.stopService(Intent(context, PlaybackService::class.java)) }
      instrumentation.waitForIdleSync()
      remove(fixture)
    }
  }

  /** Instala el listener antes de la petición asíncrona a la sesión y espera sin bloquear main. */
  private fun awaitReady(browser: MediaBrowser, index: Int, request: () -> Unit) {
    val ready = CompletableFuture<Unit>()
    val listener = object : Player.Listener {
      override fun onEvents(player: Player, events: Player.Events) {
        if (player.playbackState == Player.STATE_READY && player.currentMediaItemIndex == index && player.mediaItemCount == 3) {
          ready.complete(Unit)
        }
      }
      override fun onPlayerError(error: PlaybackException) {
        ready.completeExceptionally(AssertionError("ExoPlayer: ${error.errorCodeName}", error))
      }
    }
    try {
      onMain {
        browser.addListener(listener)
        request()
      }
      ready.get(20, TimeUnit.SECONDS)
    } finally {
      onMain { browser.removeListener(listener) }
    }
  }

  private fun assertOffline(id: Long, title: String) {
    val query = JSONObject().put("id", id).put("title", title).put("artist", "Auto test")
      .put("album", "Auto test").put("duration", 4)
    val resolved = JSONObject(MusifyCore.resolve(query.toString(), false))
    assertFalse(resolved.toString(), resolved.has("error"))
    assertTrue("La prueba debe resolver un archivo local", resolved.getBoolean("local"))
  }

  /** Fallar antes de resolve si el SQLite de Android y el de Rust no ven la misma escritura. */
  private fun assertFixtureVisibleToRust(fixture: Fixture) {
    assertTrue("No existe el WAV local ${fixture.audio}", fixture.audio.isFile)
    val diagnostic = openDatabase().use { db ->
      val journal = db.rawQuery("PRAGMA journal_mode", null).use { it.moveToFirst(); it.getString(0) }
      val counts = db.rawQuery(
        "SELECT (SELECT COUNT(*) FROM tracks WHERE id IN (?, ?)), (SELECT COUNT(*) FROM downloads WHERE track_id IN (?, ?))",
        arrayOf(fixture.first.toString(), fixture.second.toString(), fixture.first.toString(), fixture.second.toString()),
      ).use { it.moveToFirst(); "tracks=${it.getLong(0)}, downloads=${it.getLong(1)}" }
      "package=${context.packageName}, db=${database.canonicalPath}, journal=$journal, $counts"
    }
    val nativeItem = JSONObject(MusifyCore.mediaItem("track:${fixture.first}"))
    val nativePlaylist = JSONObject(MusifyCore.browse("playlist:${fixture.playlist}"))
    val firstDownloaded = MusifyCore.isDownloaded(fixture.first)
    val secondDownloaded = MusifyCore.isDownloaded(fixture.second)
    Log.i("CarPlaybackTest", "$diagnostic; nativeItem=$nativeItem; nativePlaylist=$nativePlaylist; downloaded=$firstDownloaded/$secondDownloaded")
    assertFalse("Rust no ve la pista: $diagnostic; $nativeItem", nativeItem.has("error"))
    assertEquals(fixture.first, nativeItem.getJSONObject("item").getJSONObject("track").getLong("id"))
    assertFalse("Rust no ve la playlist: $diagnostic; $nativePlaylist", nativePlaylist.has("error"))
    val tracks = nativePlaylist.getJSONArray("items")
    assertEquals(3, tracks.length())
    assertEquals(listOf(fixture.first, fixture.second, fixture.first),
      (0 until tracks.length()).map { tracks.getJSONObject(it).getJSONObject("track").getLong("id") })
    assertTrue("Rust no ve ambas descargas: $diagnostic; downloaded=$firstDownloaded/$secondDownloaded", firstDownloaded && secondDownloaded)
  }

  private fun openDatabase(): SQLiteDatabase =
    // Rust conserva abierta una conexión en WAL. Evitar que SQLiteDatabase cambie el modo.
    SQLiteDatabase.openDatabase(database.absolutePath, null,
      SQLiteDatabase.OPEN_READWRITE or SQLiteDatabase.ENABLE_WRITE_AHEAD_LOGGING).also {
      it.setForeignKeyConstraintsEnabled(true)
    }

  private fun seed(): Fixture {
    val audio = File.createTempFile("auto-playback-", ".wav", context.cacheDir)
    audio.writeBytes(silentWav())
    try {
      openDatabase().use { db ->
        db.beginTransaction()
        try {
          // Rango inferior al namespace YouTube; los archivos de downloads evitan cualquier búsqueda remota.
          val first = db.rawQuery(
            "SELECT COALESCE(MAX(id), 200000000000000) + 1 FROM tracks WHERE id >= 200000000000000 AND id < 210000000000000", null,
          ).use { cursor -> cursor.moveToFirst(); cursor.getLong(0) }
          for ((id, title) in listOf(first to "Auto test A", first + 1 to "Auto test B")) {
            db.execSQL(
              "INSERT INTO tracks (id, title, duration, explicit, artist_id, artist_name, album_id, album_title, album_artist_id, cover) VALUES (?, ?, 4, 0, 1, 'Auto test', ?, 'Auto test', 1, NULL)",
              arrayOf<Any>(id, title, id),
            )
            db.execSQL("INSERT INTO downloads (track_id, path, size, video_id) VALUES (?, ?, ?, '')",
              arrayOf<Any>(id, audio.absolutePath, audio.length()))
          }
          val playlist = db.insertOrThrow("playlists", null, ContentValues().apply { put("name", "Auto playback fixture") })
          listOf(first, first + 1, first).forEachIndexed { position, trackId ->
            db.execSQL("INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?, ?, ?)",
              arrayOf<Any>(playlist, trackId, position))
          }
          db.setTransactionSuccessful()
          return Fixture(first, first + 1, playlist, audio)
        } finally {
          db.endTransaction()
        }
      }
    } catch (error: Throwable) {
      audio.delete()
      throw error
    }
  }

  private fun remove(fixture: Fixture) {
    try {
      openDatabase().use { db ->
        db.beginTransaction()
        try {
          db.delete("playlist_tracks", "playlist_id = ?", arrayOf(fixture.playlist.toString()))
          db.delete("playlists", "id = ?", arrayOf(fixture.playlist.toString()))
          val ids = arrayOf(fixture.first.toString(), fixture.second.toString())
          for (table in listOf("downloads", "history", "liked_tracks", "sources")) {
            db.delete(table, "track_id IN (?, ?)", ids)
          }
          db.delete("tracks", "id IN (?, ?)", ids)
          db.setTransactionSuccessful()
        } finally {
          db.endTransaction()
        }
      }
    } finally {
      fixture.audio.delete()
    }
  }

  private fun silentWav(): ByteArray {
    val sampleRate = 8000
    val dataBytes = sampleRate * 4 * 2 // 4 segundos PCM de 16 bits, mono.
    return ByteBuffer.allocate(44 + dataBytes).order(ByteOrder.LITTLE_ENDIAN).apply {
      put("RIFF".toByteArray(Charsets.US_ASCII)); putInt(36 + dataBytes)
      put("WAVEfmt ".toByteArray(Charsets.US_ASCII)); putInt(16)
      putShort(1); putShort(1); putInt(sampleRate); putInt(sampleRate * 2)
      putShort(2); putShort(16)
      put("data".toByteArray(Charsets.US_ASCII)); putInt(dataBytes)
      // El resto del ByteBuffer ya contiene ceros.
    }.array()
  }
}
