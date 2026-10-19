# Mapa de funciones y pruebas de la PWA

Auditoría del código de la interfaz 0.11.2 y de los escenarios E2E, 19 de octubre de 2026. Este mapa describe qué acciones comprueba cada caso y qué sigue pendiente. **No afirma cobertura exhaustiva ni convierte la emulación de pantalla en una prueba de Android o iPhone.**

Los estados finales deben consultarse en los manifiestos de ejecuciones completas bajo `artifacts/pwa-e2e/`. Que un caso aparezca aquí significa que está implementado, no que haya pasado en cada motor. Un requisito ausente produce `blocked` o `unsupported`; los errores inesperados permanecen como fallos.

La aplicación Svelte compilada, el historial del navegador, IndexedDB, CacheStorage, el service worker y HTMLAudio son los del producto. Las respuestas HTTP de proveedores y el AAC silencioso son fixtures deterministas. Eso prueba el comportamiento frente a esos contratos; no acredita disponibilidad actual de los proveedores ni reproducción física con la pantalla apagada.

## Acciones con escenarios

| Pantalla / función | Acciones y resultado que se comprueban | Escenarios | Límite de la evidencia |
| --- | --- | --- | --- |
| Entrada e instalación | Cero peticiones y cero archivos de aplicación opcional en caché antes de abrir; identidad, scope, manifest e iconos; guía por plataforma. | `install.minimal`, `install.manifest`, `install.guide` | La confirmación real del sistema es `install.native-prompt` y requiere un dispositivo. |
| Entrada sin servidor disponible | Recarga del instalador cacheado, sin descargar la aplicación opcional. Se registra el mecanismo de desconexión y el valor esperado de `navigator.onLine`. | `install.offline` | Servidor de origen detenido y modo offline del navegador son controles distintos; ninguno equivale por sí solo a modo avión físico. |
| Navegación y diseño | Cuatro pestañas móviles; Atrás/Adelante del navegador; búsqueda restaurada tras recarga; URL estable; barra inferior dentro del viewport; cambios de tamaño y señales DOM de retorno. | `library.navigation`, `responsive.resize`, `responsive.resume` | No prueba el botón del sistema Android ni reapertura después de que el SO mate el proceso. |
| Inicio y recientes | Tarjetas de descubrimiento; estado de «Ponme un disco» sin/con disco guardado; abrir tile fijado; abrir artista visto recientemente; desfijar directamente en Inicio y restaurar pin. | `library.discovery`, `library.home-and-menus` | No se prueban todas las tarjetas ni las flechas de desplazamiento de cada estantería. |
| «Ponme un disco» | Selección de un disco guardado, primera pista, orden del álbum y shuffle desactivado; reproducción real. | `media.home-surprise-album-starts-saved-album-in-track-order` | No comprueba la distribución estadística de la elección aleatoria. |
| Buscar música | Pistas, artistas y discos; ampliar/reducir resultados; consulta natural «canción de artista» con respuesta literal vacía y segunda petición normalizada; vacío; resultados parciales y reintento. | Los tres casos `library.search` y `library.search: natural…` | Las fixtures contienen 12 pistas, 2 artistas y 3 discos; no representan todo el catálogo. |
| Artista | Detalle, populares 5/8, favorito, filtros Todo/Sencillos y EP y vuelta; persistencia/eliminación del favorito. | `library.artist`, `library.persistence` | «Recopilatorios» no tiene un caso UI específico separado. |
| Radio de artista | Cola limitada, pistas únicas, alternancia de dos artistas, reproducción y avance real. | `media.artist-radio-builds-bounded-mixed-queue-and-plays` | La fixture tiene 12 pistas. Errores parciales y cancelación por cambio de ruta/reproducción no tienen E2E dedicado; hay [pruebas del algoritmo](../scripts/tests/artist-radio.test.mjs). |
| Disco | Detalle y cuatro pistas; guardar/quitar de biblioteca; fijar/desfijar y persistir; añadir álbum completo a playlist. | `library.album`, `library.persistence`, `library.playlists: append…` | No comprueba individualmente todos los textos de créditos, fechas o géneros. |
| Menú de pista | Ir al artista y al disco; Atrás cierra solamente el menú; likes; playlist existente/nueva; selección de fuente. | `library.home-and-menus`, `library.favorites`, `library.contextual-playlist`, `library.source-picker` | Los menús de tarjeta y de pista comparten operaciones, pero no se pulsan todas sus rutas alternativas. |
| Canciones que te gustan | Añadir dos, buscar ignorando acentos, limpiar búsqueda, quitar una manteniendo la otra. | `library.favorites` | No inyecta un fallo de escritura de IndexedDB en el guardado de likes. |
| Playlists | Crear vacía y desde menú de pista; renombrar/cancelar; fijar; añadir disco y duplicados; filtrar; impedir reorder con filtro; arrastrar; quitar una entrada; recargar; cancelar/borrar playlist y su pin. | Casos `library.playlists` y `library.contextual-playlist` | No comprueba cada combinación de playlist con música, RSS y YouTube mezclados. |
| CSV | Encabezados inválidos, tamaño mayor de 10 MB, proveedor fallando/reintento, revisión, duplicados, omisión, guardar y recargar; todo omitido y nombre vacío no permiten guardar; importar otra y cancelar una búsqueda pausada. | `library.csv`, `library.csv-validation` | Salir o cancelar mientras sigue una respuesta de catálogo en vuelo no tiene caso E2E específico. |
| Spotify por enlace | Un rechazo controlado muestra error y mantiene la alternativa CSV. El diagnóstico CORS de WebKit se conserva con `handledExpected` únicamente para el patrón y ámbito de este caso. | `library.csv` | No acredita importación positiva por enlace; la limitación web actual se documenta, no se sustituye por datos de ejemplo. |
| Elegir fuente | Pulsar candidato listado; enlace inválido; selección manual; fuente recordada al reabrir y recargar; cerrar diálogo. | `library.source-picker` | La elección se hace sobre una pista que no está reproduciéndose; el cambio de fuente durante playback no tiene E2E propio. |
| Canciones de YouTube | Enlace inválido; preview; cambiar enlace; título vacío no permite guardar; editar; guardar/actualizar sin duplicar; quitar. | `library.youtube` | La conservación en favoritos/playlists después de quitar de esta vista no tiene E2E específico. |
| Catálogo de pódcasts | RSS y YouTube; idiomas es/en/all; detalles de episodios; guardar dos programas, recargar y quitar uno conservando el otro. | `library.podcasts` | No prueba cada proveedor RSS, idioma, CORS o fallback Apple. Los parsers tienen [pruebas separadas](../scripts/tests/web-podcasts.test.mjs). |
| Audio de pódcasts | RSS y YouTube; posiciones; pausa/recarga/reanudación; completar, siguiente episodio y volver a escuchar desde cero. | `media.rss-podcast-*`, `media.rss-completion-*`, `media.youtube-podcast-*` | Sigue sujeto al transporte multimedia del motor anfitrión; un bloqueo del host no acredita ni refuta Safari iOS. |
| Reproductor | Selección correcta, un Audio, play/pause/seek/anterior/siguiente, avance real, shuffle/repeat, temporizadores, respuesta tardía/selección rápida y reintento explícito. | Casos `media.selection-*`, `media.pause-*`, `media.automatic-*`, `media.shuffle-*`, `media.repeat-*`, `media.sleep-*`, `media.provider-*` | AAC silencioso controlado; sin comprobación acústica ni bloqueo físico de pantalla. |
| Cola DJ | Duplicados, reordenar/reproducir/quitar/vaciar; prioridad «Reproducir a continuación» sin interrumpir; recuperación tras recarga. | `media.dj-*`, `media.context-play-next-*`, `media.reload-*` | No sustituye la suspensión real del proceso por el sistema. |
| Descargas | Cola serial y supresión de duplicados; cancelar pendientes; archivo local y seek tras recarga sin red; quitar; rollback por cuota, almacenamiento o proveedor y reintento. | Casos `media.downloads-*`, `media.download-*` | «Cancelar» de la confirmación de borrar todas no tiene una aserción E2E dedicada. Se prueban cuerpos AAC de fixture, no una biblioteca grande. |
| Historial | Empieza vacío; después de playback real, cancelar borrado mantiene entradas y borrar persiste tras recarga. | `library.discovery`, `library.history` | `library.history` queda `blocked` si no pasó el requisito de reproducción; no se siembra historial artificial. |
| Media Session y registro | Metadatos/handlers cuando la API existe; exportación local y acotada sin direcciones de fuentes. | `media.media-session-*`, `media.audio-log-export-*` | No confirma controles reales de bloqueo, auriculares, Android Auto o CarPlay. |

## Acciones que no existen en esta interfaz base

| Acción sugerida | Implementación inspeccionada | Consecuencia para el mapa |
| --- | --- | --- |
| «Radio desde una canción» | [El menú de pistas](../src/lib/actions.ts) ofrece cola, favoritos, playlists, artista/disco y fuente. El botón de radio está en [ArtistView](../src/views/ArtistView.svelte). | No se inventa una prueba de un control ausente. Se prueba la radio de artista. |
| Filtros u orden global de «Tu biblioteca» | [LibraryList](../src/components/LibraryList.svelte) muestra secciones/listas guardadas sin esos controles. | No se declara cobertura de filtros globales. Sí se prueban búsquedas internas y filtros discográficos. |
| Carpeta nativa de descargas en la PWA | [DownloadsView](../src/views/DownloadsView.svelte) muestra almacenamiento del navegador; los controles de carpeta se reservan a la app nativa de escritorio. | Una prueba web no debe exigir acceso a una carpeta nativa. |

## Huecos que siguen abiertos

Además de los límites de cada fila, quedan fuera de esta matriz: todas las variaciones de errores de guardado de biblioteca, fallos parciales/cancelación de radio, navegación durante importación en vuelo, menús de todas las tarjetas de Inicio, reproducción de todas las estanterías y las interacciones de accesibilidad completas con teclado/lector de pantalla. Las pruebas unitarias o de integración existentes pueden cubrir parte de esas reglas, pero no se presentan como E2E UI.

La instalación real, pantalla apagada, batería, llamadas/interrupciones de audio, proceso terminado/reapertura, Safari/Home Screen de iPhone y la conexión a un coche requieren [evidencia física separada](pwa-physical-e2e.md). Los [límites de plataforma y las herramientas disponibles](pwa-platform-testing.md) conservan esos destinos como pendientes o no compatibles cuando corresponde. Una tabla de viewports no acredita esas integraciones.

## Archivos de pruebas

- [Instalación](../scripts/tests/e2e/installation-scenarios.mjs), [biblioteca](../scripts/tests/e2e/library-scenarios.mjs), [multimedia](../scripts/tests/e2e/media-scenarios.mjs) y [responsive](../scripts/tests/e2e/responsive-scenarios.mjs).
- [Fixtures HTTP](../scripts/tests/e2e/provider-fixtures.mjs), [harness](../scripts/tests/e2e/harness.mjs) y [runner](../scripts/tests/e2e/run.mjs).
- [Control de navegación offline](../scripts/tests/e2e/offline-navigation-probe.mjs): separa routing, modo offline del contexto y servidor de origen detenido.

Para una conclusión de ejecución se necesita una corrida completa `--suite all`, su build, sus checks reales, sus errores conservados y la confirmación de cierre de recursos. No se reemplaza esa corrida sumando fragmentos de distintas versiones del inventario.
