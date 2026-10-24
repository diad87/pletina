package dev.musify.desktop

import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@OptIn(UnstableApi::class)
@RunWith(AndroidJUnit4::class)
class CarLibraryTest {
  private fun song(id: Long, title: String) = JSONObject()
    .put("id", "track:$id").put("title", title).put("subtitle", "Artista")
    .put("browsable", false).put("playable", true)
    .put("track", JSONObject().put("id", id).put("title", title).put("artistName", "Artista")
      .put("artistId", 3).put("albumArtistId", 3).put("albumId", 4).put("albumTitle", "Disco")
      .put("duration", 120).put("explicit", false).put("cover", JSONObject.NULL))

  @Test
  fun selectionRecoversContextAndDuplicateOccurrenceWithoutAnInMemoryCache() {
    val first = song(1, "Primera")
    val second = song(250_000_000_000_123, "Vídeo independiente")
    var songs = listOf(first, second, first)
    fun library() = CarLibrary(
      browseJson = { JSONObject().put("items", JSONArray(songs)).toString() },
      itemJson = { id ->
        JSONObject().put("item", when (id) {
          "playlist:12" -> JSONObject().put("id", id).put("title", "Viaje").put("browsable", true)
          "track:1" -> first
          else -> second
        }).toString()
      },
    )
    val shown = library().children("playlist:12", 0, Int.MAX_VALUE)
    assertEquals(3, shown.map { it.mediaId }.distinct().size)
    val selected = library().selection(MediaItem.Builder().setMediaId(shown[2].mediaId).build())
    assertEquals(2, selected.index)
    assertEquals(listOf("1", "250000000000123", "1"), selected.items.map { PlaybackService.trackId(it) })
    val entry = PlaybackService.entryOf(selected.items[1])!!
    assertEquals(250_000_000_000_123, entry.getJSONObject("query").getLong("id"))
    assertEquals("Viaje", entry.getString("context"))
    assertFalse(entry.getBoolean("user"))
    assertEquals(1, entry.getInt("ctx"))
    assertEquals("Vídeo independiente", entry.getJSONObject("item").getJSONObject("track").getString("title"))

    // La lista se editó después de mostrarse en el coche: sigue siendo la canción elegida.
    songs = listOf(second, first)
    val moved = library().selection(MediaItem.Builder().setMediaId(shown[1].mediaId).build())
    assertEquals(0, moved.index)
    songs = listOf(first)
    assertThrows(IllegalArgumentException::class.java) {
      library().selection(MediaItem.Builder().setMediaId(shown[1].mediaId).build())
    }
  }
}
