# Port web de Pletina 0.11.2

Preparado el **18 de octubre de 2026**. Base nativa exacta: commit `4b5691ff50d659fbd048f5a9cff1ddfa91c22a79`, versión **0.11.2**. Build final preparado: **`1785b6edf53a230b`**, con canción seleccionada comprobada después del ajuste de concurrencia. El informe amplio anterior corresponde a `3622b8aa49a2ee7f`; ambos se distinguen en la evidencia siguiente.

**Estado de publicación: publicado y verificado por HTTPS.** El build `1785b6edf53a230b` está en <https://diad87.github.io/pletina/>. La comparación pública pasó **22/22 archivos**, con HTTP 200 y SHA-256 coincidentes, y la prueba pública de instalación mínima, búsqueda y reproducción seleccionada pasó **3/3 comprobaciones** en Chrome de escritorio. Commit de distribución `gh-pages`: `cd4c6b68d5fe729a69f326952d65018d3149e4e7`, distinto de la base nativa 0.11.2. La prueba física de pantalla apagada del nuevo port sigue pendiente.

## Arquitectura y alcance

`web-port/main.ts` monta el `src/App.svelte` real y su aviso de actualizaciones. El build usa el modo `pwa`: `src/lib/api.ts` dirige las llamadas a `web-port/invoke.ts`, en lugar de invocar Rust o devolver los fixtures de desarrollo. La entrada mínima continúa en `pwa/` y descarga la aplicación compilada cuando se abre. Este port permite buscar por nombre o artista y reproducir desde los resultados; no es la demo anterior que pedía enlaces para formar una cola.

El catálogo se consulta directamente a Deezer mediante JSONP ejecutado en un frame aislado. `web-port/catalog.ts` transforma las respuestas al contrato de la interfaz y atiende búsquedas de canciones, artistas y discos, detalles, populares y recomendaciones. Los resultados conservan los metadatos necesarios para crear la cola.

`web-port/audio.ts` y `youtube.ts` sustituyen la parte del backend que elegía y extraía el audio. Buscan candidatos en YouTube Music, comparan título, artista, duración y disco con los umbrales del motor nativo y utilizan búsqueda WEB como respaldo. Prueban hasta tres candidatos y obtienen audio MP4 mediante VISIONOS desde un frame de origen opaco. Las respuestas se leen como JSON; no se descarga ni ejecuta el código del reproductor de YouTube. Los frames se retiran al terminar o cancelar.

Las solicitudes van directamente a `api.deezer.com`, `music.youtube.com`, `www.youtube.com` y la CDN de audio `googlevideo.com`, además de los servidores de imágenes del catálogo. No hay backend de Pletina, proxy ni microservidor. GitHub Pages solo aloja la distribución estática.

Se conserva el reproductor Svelte, con un elemento de audio mantenido entre cambios normales de canción y la lógica de recuperación existente. Continúan cola de disco/playlist, cola DJ, anterior/siguiente, posición, aleatorio, repetición, temporizador y Media Session donde el navegador lo ofrece. Si autoplay exige un gesto adicional, el audio queda preparado y se pide pulsar Reproducir, en lugar de tratarlo como una canción incorrecta.

La biblioteca se guarda en IndexedDB, base `pletina-web-library`, esquema 1. Incluye favoritos, discos y artistas, playlists y sus entradas, historial, vídeos añadidos y elecciones de fuente. Las URLs firmadas de audio solo permanecen en RAM y se renuevan; no se persisten como descargas. Los vídeos añadidos por enlace mantienen su mapeo de ID y no se sustituyen mediante búsqueda por título. El almacenamiento web es independiente de la base de datos nativa.

| Función | Estado en este port |
| --- | --- |
| Buscar canciones, artistas y discos | Implementado; búsqueda real comprobada |
| Reproducir desde resultados sin pegar enlaces | Implementado; canción seleccionada comprobada |
| Artistas, discos, populares y recomendaciones | Adaptadores directos implementados |
| Favoritos, playlists e historial | IndexedDB; favoritos y playlists comprobados tras recargar |
| Cola normal y DJ, aleatorio, repetición y temporizador | Interfaz y lógica existentes reutilizadas |
| Elegir otra fuente o añadir un vídeo de YouTube | Adaptado con elección local persistente |
| Interfaz y metadatos locales sin red | Comprobado después de guardar la app; no incluye música offline |
| Podcasts, carpetas locales y descargas de canciones | No portados en esta fase |
| Importar Spotify por URL o CSV | No portado; flujo completo oculto en la PWA |
| Android Auto y CarPlay | Aplazados |

El matching interno de canciones importadas existe, pero no hay flujo de importación expuesto: ni la lectura por URL de Spotify ni `read_playlist_csv` están implementados en el adaptador. Una función implementada no equivale a una prueba física en Android o iOS. La evidencia de navegador se delimita a continuación.

## Tamaño y compilación

La orden para generar la distribución completa es:

```sh
npm run build:pwa
```

Ejecuta `scripts/build-web-pwa.mjs`: Vite compila `web-port/`, el constructor incorpora el resultado a `dist-pwa/application/`, genera la entrada, manifiesto y worker, crea el HTML portable y añade la herramienta diagnóstica separada. Ejecutar solo `scripts/build-pwa.mjs` omitiría la app completa.

Medición del build final `1785b6edf53a230b`, por suma de archivos **sin comprimir**:

| Grupo | Bytes | Aproximación decimal |
| --- | ---: | ---: |
| Entrada, manifiesto, iconos y service worker | 35.884 | 35,9 KB |
| Aplicación bajo demanda: HTML, JS, CSS, fuentes y lanzador | 410.560 | 410,6 KB |
| Ambos grupos | 446.444 | 446,4 KB |

Son tamaños de archivos, no una medición del tráfico comprimido del navegador. No incluyen la herramienta diagnóstica independiente ni música. La prueba registra **cero solicitudes a `application/` en la instalación inicial**. La primera apertura descarga y verifica los recursos de la app antes de entrar. El HTML final es `application/index.25394c4f48704476.html` y su JavaScript principal `application/assets/index-BSCGGeHI.js`; no deben utilizarse como dirección estable de instalación. Los tamaños y nombres cambian al recompilar una modificación.

`dist-pwa-portable/Pletina.html` sigue siendo únicamente la copia local de Hola mundo. No es el port musical ni proporciona instalación o actualización como PWA desde `file://`.

## Pruebas del build

El informe consolidado [`artifacts/pwa-port/browser.json`](../artifacts/pwa-port/browser.json) reúne **12 comprobaciones correctas** de tres ejecuciones sobre el build anterior `3622b8aa49a2ee7f`; conserva los resultados fallidos del primer runner. Tras el ajuste de concurrencia se repitió instalación, búsqueda y reproducción de la canción seleccionada sobre el build final `1785b6edf53a230b`, con **3/3 comprobaciones correctas** en [`browser-final-selected-song.json`](../artifacts/pwa-port/browser-final-selected-song.json). Chrome utilizado: **148.0.7778.97** de escritorio. La salida de sonido se silenció mediante el argumento de Chrome; el elemento de audio permaneció con `muted: false`.

| Comprobación | Evidencia |
| --- | --- |
| Instalación mínima y carga completa bajo demanda | Cero solicitudes de aplicación antes de abrir; recursos guardados después |
| Búsqueda por nombre/artista | Resultados reales en la interfaz Svelte |
| Canción seleccionada inicialmente | «Creep», Radiohead, ID de catálogo `138547415` → vídeo `9RfVp-GhKfs` |
| Reproducción de esa canción | Build final: una única instancia; posición 2,13 s, duración 238,64 s, sin error multimedia |
| Transporte de audio | Respuesta HTTP 206 `audio/mp4` desde `googlevideo.com` |
| Pausa y posición | Controles de la interfaz sobre el mismo elemento de audio |
| Fin y siguiente pista con pestaña oculta | Pasó a la siguiente y el audio avanzó; la fuente puede estar precargada. Se adelantó la pista a 1,2 s del final |
| Media Session | Handlers de pausa y siguiente controlaron reproducción real |
| Favorito, cola manual y playlist | Acciones de la interfaz comprobadas en repetición dirigida |
| Persistencia tras recargar | Favorito y playlist recuperados de IndexedDB |
| Recarga offline | Abrieron interfaz cacheada y metadatos locales; no se probó audio offline |
| Diseño móvil | Android 393 px e iPhone 390 px sin desbordamiento horizontal; emulación de Chrome |

La canción seleccionada pasó dos veces en el build previo y de nuevo en el final. Se conservan [`browser-selected-song.json`](../artifacts/pwa-port/browser-selected-song.json), [`browser-selected-song-first.json`](../artifacts/pwa-port/browser-selected-song-first.json) y [`browser-final-selected-song.json`](../artifacts/pwa-port/browser-final-selected-song.json), que registran IDs y estado del medio sin direcciones firmadas.

Después del despliegue, la misma comprobación sobre **la dirección pública HTTPS** pasó **3/3** con el build final. [`browser-public-selected-song.json`](../artifacts/pwa-port/browser-public-selected-song.json) verifica instalación mínima, búsqueda real y reproducción de Creep desde el catálogo, sin error multimedia. Es una comprobación de escritorio sobre el servicio publicado; no acredita pantalla bloqueada ni iOS.

El informe original [`browser-first-queue-order.json`](../artifacts/pwa-port/browser-first-queue-order.json) sigue marcado como fallido. El runner añadió una canción a la cola manual mientras el reproductor estaba inactivo, lo que inicia reproducción, y después pulsó otra canción. Falló su expectativa sobre la cola y, por dependencia, las de playlist y persistencia. La repetición dirigida [`browser-ui-followup.json`](../artifacts/pwa-port/browser-ui-followup.json) corrigió la secuencia y pasó esas comprobaciones con el mismo build.

Esa primera ejecución solapada registró también **dos errores multimedia 4** y avanzó a otras canciones. No acredita el éxito inicial de Creep ni permite atribuir una causa al fallo. Se conserva como evidencia de controles y transiciones posteriores. La comprobación limpia de la canción seleccionada, con un solo clic y sin manipular la cola, pasó después sin error. No se declara resuelta una causa que no se haya identificado.

La suite final pasó **216/216 pruebas automáticas** y `npm run check` terminó con **0 errores y 0 avisos**. La compilación nativa `npm run build` volvió a pasar tras la corrección final. La regresión añadida reproduce un rechazo de autoplay tardío de una canción anterior que podía poner en pausa el estado de la nueva: falló antes de comprobar el token y la instancia de audio y pasó después, junto con **45/45 pruebas dirigidas de reproductor**. No se atribuyen a este fallo los errores multimedia 4 sin causa identificada.

El runner es `scripts/tests/web-port.browser.mjs`. Puede usar un servidor estático efímero solo para QA, que cierra al terminar, o recibir `--url` para comprobar una publicación. Ese servidor no es una dependencia de la app. Las capturas [`desktop-search.png`](../artifacts/pwa-port/desktop-search.png), [`android-ui-emulated.png`](../artifacts/pwa-port/android-ui-emulated.png) e [`iphone-ui-emulated.png`](../artifacts/pwa-port/iphone-ui-emulated.png) documentan el diseño; no convierten Chrome en Safari ni en un teléfono real.

## Pantalla apagada y límites pendientes

La evidencia física previa corresponde a **otro reproductor**, el básico publicado antes de este port. En Xiaomi 15T Pro, el usuario confirmó continuidad y nueva fuente al terminar una pista con Chrome bloqueado; después confirmó **«Funciona instalada y bloqueada»** desde el icono de la PWA anterior. Se registró el protocolo de dos minutos, sin recibir versión exacta del sistema/navegador ni JSON del teléfono.

Se conservan las confirmaciones textuales en [`android-user-confirmation.json`](../artifacts/pwa-screen-off/android-user-confirmation.json) y [`android-installed-user-confirmation.json`](../artifacts/pwa-screen-off/android-installed-user-confirmation.json). El contexto está en los informes históricos de [pantalla apagada](pwa-screen-off-results.md) y [primera integración](pwa-player-results.md); otros artefactos antiguos mencionados allí pertenecen al entorno original y no están necesariamente copiados a este worktree.

El **port 0.11.2 no tiene todavía prueba física de pantalla apagada**, ni en ese Xiaomi ni en otros Android. Su resultado de pestaña oculta es de escritorio y acelera la transición mediante un salto temporal. Tampoco hay ejecución física en iPhone/iPad, Safari o PWA instalada de iOS. La emulación de tamaño no verifica reproducción, restricciones del sistema ni segundo plano.

La comprobación física pendiente del port publicado debe buscar y reproducir una canción desde la nueva interfaz, formar una cola, adelantarla hasta unos 30 segundos antes del final y bloquear el teléfono dos minutos. Hay que confirmar continuidad y siguiente canción sin intervención, anotando dispositivo y versiones. Quedan sesiones largas, renovación tras una pausa prolongada y cambios entre Wi-Fi y datos. Los endpoints internos pueden cambiar; el éxito de unas canciones no garantiza disponibilidad de todo el catálogo.

La disponibilidad offline comprobada corresponde a interfaz y biblioteca de metadatos. No se han portado las descargas. Reproducir un recurso multimedia no demuestra que JavaScript pueda descargar sus bytes por CORS. Borrar los datos del sitio o perder el almacenamiento del navegador exige preparar de nuevo la app y puede borrar la biblioteca web.

## Actualizaciones y despliegue

El worker verifica SHA-256 y separa cachés por versión. El botón **Actualizar** solicita `PREPARE_APPLICATION` al worker pendiente: primero guarda y verifica todos los recursos nuevos bajo demanda y después envía `ACTIVATE_UPDATE`. Si falla el staging, se informa del fallo y la versión activa sigue disponible para reintentar. Al activarse, la app redirige a la entrada estable `?open=app`, evitando conservar un HTML antiguo con hash. La biblioteca IndexedDB no se elimina al cambiar la caché de código.

La prueba E2E [`update-browser.json`](../artifacts/pwa-port/update-browser.json) pasó **7/7 comprobaciones** en Chrome de escritorio 153.0.8010.52 con los assets compilados finales. Creó variantes A/B temporales de HTML para provocar una actualización: mantuvo A activa al fallar la preparación, permitió reintentar y verificó el orden `PREPARE_APPLICATION → ACTIVATE_UPDATE → controllerchange`. La versión actualizada volvió a abrir sin red con el mismo ID de playlist y las mismas entradas duplicadas. La playlist se creó y renombró desde la interfaz; los metadatos de esas dos entradas se sembraron en IndexedDB como fixture de QA. No se usó audio ni una red externa de música.

También comprobó la migración desde el prototipo `85d3cde632c1480f` manteniendo una única registration, `id`, `scope` y `start_url`, preservando almacenamiento local y cachés ajenas. Es una prueba real del worker y la base de datos en escritorio; no acredita la migración del icono del sistema en Android/iOS. El servidor estático temporal quedó cerrado y el sitio de pruebas se eliminó. Las variantes de QA no sustituyen el build final de distribución.

La publicación utiliza **Pages por rama `gh-pages`**, no GitHub Actions. `.github/workflows/pwa.yml` prepara el mecanismo alternativo de Actions, con comprobaciones y build completo, pero aún no está activo. El build final `1785b6edf53a230b` corresponde al commit de distribución `cd4c6b68d5fe729a69f326952d65018d3149e4e7`, con hash de la distribución `a96aee2dc35b15a1ca35d829dd8bb6a15e5dc826a79abccc40afc5386eec5e17`. `scripts/verify-pwa-deploy.mjs` comprobó **22/22 archivos públicos**, todos con HTTP 200 y SHA-256 idénticos a los locales; el resultado está en [`artifacts/pwa-deploy/public-files.json`](../artifacts/pwa-deploy/public-files.json). La identidad de los archivos publicados queda verificada. Esto no sustituye la comprobación física de reproducción móvil pendiente.
