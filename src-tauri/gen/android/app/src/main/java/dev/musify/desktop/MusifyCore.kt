package dev.musify.desktop

/**
 * El núcleo Rust de Musify (src-tauri/src/android.rs), llamado directamente desde el servicio de
 * música, sin pasar por la interfaz ni por Tauri. Las dos funciones bloquean: no llamarlas desde el
 * hilo principal.
 */
object MusifyCore {
  init {
    System.loadLibrary("musify_lib")
  }

  /** Canciones de los discos que se encuentren con cada búsqueda (una por línea): JSON. */
  external fun playlist(queries: String): String

  /** URL del audio de una canción (TrackQuery en JSON): `{url, videoId, ms}` o `{error}`. */
  external fun resolve(query: String, refresh: Boolean): String
}
