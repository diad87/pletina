package dev.musify.desktop

import android.content.ComponentName
import android.media.browse.MediaBrowser as LegacyBrowser
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaBrowser
import androidx.media3.session.SessionResult
import androidx.media3.session.SessionToken
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.Callable
import java.util.concurrent.CompletableFuture
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Conecta directamente con el servicio, sin lanzar MainActivity ni la WebView. */
@OptIn(UnstableApi::class)
@RunWith(AndroidJUnit4::class)
class CarLibraryServiceTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private val context get() = instrumentation.targetContext
  private val component get() = ComponentName(context, PlaybackService::class.java)

  private fun <T> onMain(block: () -> T): T {
    val task = FutureTask(Callable { block() })
    instrumentation.runOnMainSync(task)
    return task.get(15, TimeUnit.SECONDS)
  }

  @Test
  fun media3BrowserLoadsLibraryWithoutOpeningActivity() {
    val future = onMain { MediaBrowser.Builder(context, SessionToken(context, component)).buildAsync() }
    val browser = future.get(15, TimeUnit.SECONDS)
    try {
      val root = onMain { browser.getLibraryRoot(null) }.get(15, TimeUnit.SECONDS)
      assertEquals(SessionResult.RESULT_SUCCESS, root.resultCode)
      assertTrue(root.value!!.mediaMetadata.isBrowsable == true)
      val children = onMain { browser.getChildren(root.value!!.mediaId, 0, 100, null) }
        .get(15, TimeUnit.SECONDS)
      assertEquals(SessionResult.RESULT_SUCCESS, children.resultCode)
      assertEquals(setOf("liked", "playlists", "downloads", "youtube"), children.value!!.map { it.mediaId }.toSet())
      for (folder in children.value!!) {
        assertTrue(folder.mediaMetadata.isBrowsable == true)
        val contents = onMain { browser.getChildren(folder.mediaId, 0, Int.MAX_VALUE, null) }
          .get(15, TimeUnit.SECONDS)
        assertEquals("No se pudo abrir ${folder.mediaId}", SessionResult.RESULT_SUCCESS, contents.resultCode)
        assertNotNull(contents.value)
      }
      val unknown = onMain { browser.getItem("invalid:android-auto-test") }.get(15, TimeUnit.SECONDS)
      assertNotEquals(SessionResult.RESULT_SUCCESS, unknown.resultCode)
    } finally {
      onMain { browser.release() }
    }
  }

  /** Android Auto usa también la interfaz antigua; una prueba Media3 sola no la cubre. */
  @Test
  fun platformBrowserDiscoversAndBrowsesTheSameService() {
    val connected = CompletableFuture<Unit>()
    lateinit var browser: LegacyBrowser
    onMain {
      browser = LegacyBrowser(context, component, object : LegacyBrowser.ConnectionCallback() {
        override fun onConnected() { connected.complete(Unit) }
        override fun onConnectionFailed() { connected.completeExceptionally(AssertionError("Falló la conexión legacy")) }
        override fun onConnectionSuspended() { connected.completeExceptionally(AssertionError("Conexión legacy suspendida")) }
      }, null)
      browser.connect()
    }
    try {
      connected.get(15, TimeUnit.SECONDS)
      val loaded = CompletableFuture<List<LegacyBrowser.MediaItem>>()
      onMain {
        browser.subscribe(browser.root, object : LegacyBrowser.SubscriptionCallback() {
          override fun onChildrenLoaded(parentId: String, children: MutableList<LegacyBrowser.MediaItem>) {
            loaded.complete(children)
          }
          override fun onError(parentId: String) {
            loaded.completeExceptionally(AssertionError("No se pudo navegar $parentId"))
          }
        })
      }
      val folders = loaded.get(15, TimeUnit.SECONDS)
      assertEquals(4, folders.size)
      assertTrue(folders.all { it.isBrowsable && !it.isPlayable })
      assertEquals(setOf("liked", "playlists", "downloads", "youtube"), folders.map { it.mediaId }.toSet())
    } finally {
      onMain { browser.disconnect() }
    }
  }
}
