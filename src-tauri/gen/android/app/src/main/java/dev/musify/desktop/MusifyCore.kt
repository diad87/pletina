package dev.musify.desktop

/**
 * El núcleo Rust de Musify (src-tauri/src/android.rs), llamado directamente desde el servicio de
 * música, sin pasar por la interfaz ni por Tauri. `resolve`, `recordPlay` y `playlist` bloquean: no
 * llamarlas desde el hilo principal.
 */
object MusifyCore {
  init {
    System.loadLibrary("musify_lib")
  }

  /** Carpeta de datos de la app (`context.dataDir`, la misma que usa Tauri). Antes que nada. */
  external fun init(dataDir: String)

  /** URL del audio de una canción (TrackQuery en JSON): `{url, local, videoId, ms}` o `{error}`. */
  external fun resolve(query: String, refresh: Boolean): String

  /** Apunta una escucha en el historial (LibTrack en JSON). Devuelve el error, o "" si fue bien. */
  external fun recordPlay(track: String): String

  /** Aviso a la interfaz, si la app está abierta (evento de Tauri con datos en JSON). */
  external fun emit(event: String, payload: String)

  /** Prueba de la fase 0: canciones de los discos de cada búsqueda (una por línea), en JSON. */
  external fun playlist(queries: String): String
}
