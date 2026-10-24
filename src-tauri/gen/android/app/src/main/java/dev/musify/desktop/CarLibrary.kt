package dev.musify.desktop

import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.util.UnstableApi
import java.security.MessageDigest
import org.json.JSONObject

/** Biblioteca del coche: lee SQLite a través de Rust, también sin Activity ni WebView. */
@OptIn(UnstableApi::class)
internal class CarLibrary(
  private val browseJson: (String) -> String = { MusifyCore.browse(it) },
  private val itemJson: (String) -> String = { MusifyCore.mediaItem(it) },
  private val searchJson: (String) -> String = { MusifyCore.search(it) },
) {
  data class Selection(val items: List<MediaItem>, val index: Int)
  data class Snapshot(val count: Int, val fingerprint: List<Byte>)
  private data class Location(val parent: String, val index: Int, val trackId: Long)

  fun root(): MediaItem = MediaItem.Builder().setMediaId("root").setMediaMetadata(
    MediaMetadata.Builder().setTitle("Pletina").setIsBrowsable(true).setIsPlayable(false)
      .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED).build(),
  ).build()

  fun children(parent: String, page: Int, pageSize: Int): List<MediaItem> {
    val nodes = nodes(parent)
    return slice(nodes, page, pageSize).map { (index, node) -> browsableItem(node, parent, index) }
  }

  fun search(query: String, page: Int, pageSize: Int): List<MediaItem> = children(searchParent(query), page, pageSize)

  fun count(parent: String): Int = nodes(parent).size

  /** También detecta ediciones/reordenaciones aunque no cambie el número de canciones. */
  fun snapshot(parent: String): Snapshot {
    val nodes = nodes(parent)
    val digest = MessageDigest.getInstance("SHA-256")
    nodes.forEach { digest.update(it.toString().toByteArray(Charsets.UTF_8)) }
    return Snapshot(nodes.size, digest.digest().toList())
  }

  fun item(id: String): MediaItem {
    val requestedId = id.removePrefix("auto:")
    if (requestedId == "root") return root()
    val location = location(requestedId)
    val node = node(location?.let { "track:${it.trackId}" } ?: requestedId)
    return browsableItem(node, location?.parent, location?.index ?: 0).buildUpon().setMediaId(id).build()
  }

  /** Seleccionar una canción del coche mantiene la lista entera y sus repeticiones. */
  fun selection(request: MediaItem): Selection {
    val search = request.requestMetadata.searchQuery?.trim()
    if (search != null) return playlist(if (search.isEmpty()) "liked" else searchParent(search), null)
    val id = request.mediaId.removePrefix("auto:")
    val location = location(id)
    if (location != null) return playlist(location.parent, location)
    val node = node(id)
    if (node.optBoolean("browsable")) return playlist(id, null)
    return Selection(listOf(playbackItem(node, id, 0, "Tu biblioteca")), 0)
  }

  fun single(request: MediaItem): MediaItem {
    val id = request.mediaId.removePrefix("auto:")
    val location = location(id)
    val node = node(location?.let { "track:${it.trackId}" } ?: id)
    return playbackItem(node, id, location?.index ?: 0, location?.parent?.let(::label) ?: "Tu biblioteca")
  }

  private fun playlist(parent: String, location: Location?): Selection {
    val nodes = nodes(parent)
    val playable = nodes.withIndex().filter { it.value.optBoolean("playable") && it.value.has("track") }
    require(playable.isNotEmpty()) { "No hay canciones en esta lista" }
    val selected = if (location == null) 0 else {
      playable.indexOfFirst { it.index == location.index && it.value.getJSONObject("track").getLong("id") == location.trackId }
        .takeIf { it >= 0 }
        // Si la lista cambió desde que se mostró, seguimos buscando la canción elegida.
        ?: playable.indexOfFirst { it.value.getJSONObject("track").getLong("id") == location.trackId }
          .takeIf { it >= 0 }
        ?: throw IllegalArgumentException("Esta canción ya no está en la lista")
    }
    val context = label(parent)
    val items = playable.map { (index, node) -> playbackItem(node, contextualId(parent, index, node), index, context) }
    return Selection(items, selected)
  }

  private fun nodes(parent: String): List<JSONObject> {
    val result = response(if (parent.startsWith(SEARCH)) searchJson(parent.removePrefix(SEARCH)) else browseJson(parent))
    val items = result.getJSONArray("items")
    return (0 until items.length()).map { items.getJSONObject(it) }
  }

  private fun node(id: String): JSONObject = response(itemJson(id)).getJSONObject("item")

  private fun response(json: String): JSONObject = JSONObject(json).also {
    require(!it.has("error")) { it.optString("error", "No se pudo leer la biblioteca") }
  }

  private fun browsableItem(node: JSONObject, parent: String?, index: Int): MediaItem {
    val track = node.optJSONObject("track")
    val playable = node.optBoolean("playable") && track != null
    val metadata = MediaMetadata.Builder()
      .setTitle(node.optString("title"))
      .setSubtitle(node.optString("subtitle"))
      .setIsBrowsable(node.optBoolean("browsable"))
      .setIsPlayable(playable)
      .setMediaType(if (playable) MediaMetadata.MEDIA_TYPE_MUSIC else MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
    if (track != null) {
      metadata.setArtist(track.optString("artistName"))
        .setAlbumTitle(track.optString("albumTitle"))
        .setDurationMs(track.optLong("duration") * 1000)
    }
    node.optString("artworkUri").takeIf { it.startsWith("https://") }?.let { metadata.setArtworkUri(Uri.parse(it)) }
    // No mandamos todo el JSON de la cola al coche: evita respuestas Binder enormes.
    return MediaItem.Builder()
      .setMediaId(if (playable && parent != null) contextualId(parent, index, node) else node.getString("id"))
      .setMediaMetadata(metadata.build()).build()
  }

  private fun playbackItem(node: JSONObject, mediaId: String, index: Int, context: String): MediaItem {
    require(node.optBoolean("playable")) { "Este elemento no es una canción" }
    val lib = node.getJSONObject("track")
    val id = lib.getLong("id")
    val artist = JSONObject().put("id", lib.optLong("artistId")).put("name", lib.optString("artistName"))
    val track = JSONObject().put("id", id).put("title", lib.optString("title"))
      .put("titleVersion", JSONObject.NULL).put("duration", lib.optLong("duration"))
      .put("trackPosition", 0).put("diskNumber", 0).put("explicitLyrics", lib.optBoolean("explicit"))
      .put("isrc", JSONObject.NULL).put("artist", artist)
    val item = JSONObject().put("track", track).put("albumId", lib.optLong("albumId"))
      .put("albumTitle", lib.optString("albumTitle")).put("artistId", lib.optLong("albumArtistId"))
      .put("cover", lib.opt("cover") ?: JSONObject.NULL)
    val query = JSONObject().put("id", id).put("title", lib.optString("title"))
      .put("artist", lib.optString("artistName")).put("album", lib.optString("albumTitle"))
      .put("duration", lib.optLong("duration"))
    val entry = JSONObject().put("uid", "auto:$mediaId").put("item", item).put("lib", lib).put("query", query)
      .put("user", false).put("key", 0).put("ctx", index).put("context", context)
    return PlaybackService.itemFromEntry(entry)
  }

  private fun label(parent: String): String = when (parent) {
    "liked" -> "Canciones que te gustan"
    "downloads" -> "Descargas"
    "youtube" -> "Canciones de YouTube"
    else -> if (parent.startsWith(SEARCH)) "Búsqueda: ${parent.removePrefix(SEARCH)}" else node(parent).optString("title", "Tu biblioteca")
  }

  private fun contextualId(parent: String, index: Int, node: JSONObject): String =
    "browse/${Uri.encode(parent)}/$index/${node.getJSONObject("track").getLong("id")}"

  private fun location(id: String): Location? {
    if (!id.startsWith("browse/")) return null
    val parts = id.split('/')
    require(parts.size == 4) { "La canción solicitada no es válida" }
    val parent = Uri.decode(parts[1])
    val index = parts[2].toIntOrNull()
    val trackId = parts[3].toLongOrNull()
    require(parent.isNotBlank() && index != null && index >= 0 && trackId != null && trackId > 0) { "La canción solicitada no es válida" }
    return Location(parent, index, trackId)
  }

  private fun slice(nodes: List<JSONObject>, page: Int, pageSize: Int): List<IndexedValue<JSONObject>> {
    require(page >= 0 && pageSize > 0) { "La página solicitada no es válida" }
    val start = page.toLong() * pageSize
    if (start >= nodes.size) return emptyList()
    val end = (start + pageSize).coerceAtMost(nodes.size.toLong()).toInt()
    return (start.toInt() until end).map { IndexedValue(it, nodes[it]) }
  }

  companion object {
    private const val SEARCH = "search:"
    fun searchParent(query: String): String {
      require(query.isNotBlank() && query.length <= 200) { "Escribe una búsqueda de hasta 200 caracteres" }
      return SEARCH + query.trim()
    }
  }
}
