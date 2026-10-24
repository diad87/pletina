# Port web de Pletina 0.11.2

<!-- podcast-controls-a2-summary:start -->
**Actual: `a2e6b8da9fb17c07`, publicada y verificada**, fuente `0f930563fb29b3f4d61c75ab09fbf135c1ee9882`. [Controles del pódcast](pwa-podcast-controls.md): play circular sin compresión, descarga con área fija de 44 × 44 px y fila de controles que permite saltos; el mensaje queda debajo en móvil. Inspección visual antes/después en seis anchos (320–1280 px), tipos sin errores/avisos y [33/33 archivos públicos HTTP/SHA](../artifacts/pwa-deploy/public-files-a2e6b8da9fb17c07.json). [Workflow correcto](https://github.com/diad87/pletina/actions/runs/40081086271). La inspección usa Firefox de escritorio y respuestas HTTP controladas; no acredita un móvil físico ni reproducción. Las 14 comprobaciones de selección de canciones corresponden a la entrega anterior.
<!-- podcast-controls-a2-summary:end -->

## Historial anterior a a2e6b8da9fb17c07

<!-- search-row-7141-summary:start -->
**Anterior: `7141fda94599aec1`, publicada y verificada**, fuente `e1e35cd2efdeb3146868f67e9ce5fc9d6c06e15a`. [Seleccionar una canción desde Buscar](pwa-search-selection.md): tocar cualquier parte de una fila de Canciones reproduce esa canción, abre su disco y deja la búsqueda. Repetir la selección no pausa ni reinicia; ⋯ y favoritos siguen siendo independientes, también con teclado. El comportamiento se limita a Buscar de la PWA.

[Validación](../artifacts/pwa-e2e/validation-7141fda94599aec1.json): tipos **0 errores/0 avisos**, **14/14 comprobaciones** con preparación y audio base incluidos (5 Chrome, 5 Firefox y 4 WebKit). Chrome/WebKit usan pulsaciones táctiles de confianza; Firefox usa ratón. Son navegadores de escritorio con emulación de vista, no móviles físicos. El canario sobre la web pública toca «Eminem» bajo **Without Me** y reproduce esa canción mostrando **The Eminem Show**, sin vídeo ni segundo toque. [Workflow correcto](https://github.com/diad87/pletina/actions/runs/40080270874); [33/33 archivos públicos HTTP/SHA](../artifacts/pwa-deploy/public-files-7141fda94599aec1.json). Distribución: **910.558 bytes**.

Para actualizar, cerrar Pletina y usar **«Actualizar y abrir»** en la portada. El motor P1 y el almacenamiento conservan los cambios anteriores; esta entrega no vuelve a acreditar pantalla apagada, descarga en segundo plano ni Auto/CarPlay.
<!-- search-row-7141-summary:end -->

## Historial anterior a 7141fda94599aec1

<!-- native-p1-731-summary:start -->
**Anterior: `73187a1127b5ae37`, publicada y verificada**, fuente de producto `1b2c953474342564c6fe811224fdb37fb57a5a0f`. [Motor P1 nativo adaptado a la PWA](pwa-p1-native-renewal.md): renovación única de contexto público ante SABR sin localizadores, Opus cuando el navegador lo admite y reintentos con un presupuesto compartido de ocho segundos/diez intentos. Sin servidor intermedio, cuentas ni excepciones por canción. **Ni, Ni, Ni! sonó completa durante 125,581 segundos: esa es la duración, no la carga.** El arranque del canario rondó 5,3 segundos; no es una media ni un máximo garantizado. La selección del título de la canción en la búsqueda real inició audio sin abrir un disco o vídeo. Las portadas descargadas ahora permanecen sin red y se elimina un bucle de peticiones de imágenes fallidas.

[Validación](../artifacts/pwa-e2e/validation-73187a1127b5ae37.json): **926/926** pruebas de lógica, tipos **0 errores/0 avisos**, **39/39** comprobaciones únicas por perfil de navegador (14 Chrome, 14 Firefox y 11 WebKit de escritorio, incluidas preparaciones deduplicadas), canario completo de Ni **6/6** y tres canciones adicionales con saltos/final/parada **15/15**. Las pruebas controladas no sustituyen móviles físicos. Distribución **33 archivos, 910.010 bytes**; entrada **63.376**, aplicación bajo demanda **801.061**. [Workflow correcto](https://github.com/diad87/pletina/actions/runs/40078003538) y [33/33 archivos públicos HTTP/SHA](../artifacts/pwa-deploy/public-files-73187a1127b5ae37.json).

La migración real desde 435e con la app cerrada y el botón de la portada pasa. El control con la app abierta quedó esperando la activación, conservando la versión anterior; los fallos sintéticos de actualización caliente también siguen registrados. **Para actualizar: cerrar Pletina y usar «Actualizar y abrir» en la portada, sin reinstalar.** No se declara actualización 11/11, catálogo universal, nueva prueba física de pantalla apagada, descargas garantizadas en segundo plano ni Auto/CarPlay.
<!-- native-p1-731-summary:end -->

## Historial anterior a 73187a1127b5ae37

<!-- downloads-parity-435-summary:start -->
**Anterior: `435e0dc36a054099`, publicada y verificada**, fuente `cd5e6d1d10a2732181b6c6b9d2b2204e7432ed44`. [Orden y recuperación de Descargas](pwa-download-order-and-recovery.md): lista y botón de colección usan la agrupación por artista/disco y fecha ascendente de la APK; el desempate por ID es estable. Si falta un cuerpo de audio, abrir Descargas retira su marca y permite descargarlo otra vez sin recargar. Las comprobaciones antiguas sólo retiran el puntero observado como ausente, conservan una copia posterior y no deshacen eventos nuevos de la interfaz. Una consulta fallida deja de mostrar su error cuando una posterior tiene éxito. Todo PWA, sin servidor intermedio ni cuentas.

[Validación de esta compilación](../artifacts/pwa-e2e/validation-435e0dc36a054099.json): **878/878** pruebas de lógica, tipos **0 errores/0 avisos**, **33/33** comprobaciones únicas de navegador y actualización desde b698 **11/11**. Son once por motor Chrome/Firefox/WebKit de escritorio, incluidas preparaciones: orden visible/cola y siguiente real sin red, recuperación de una copia expulsada mediante fallo controlado sin recarga y regresiones de descargas de canciones y pódcasts P1. El primer observador omitía pulsar «Ver más (12)» antes de esperar doce resultados; sus seis fallos, anteriores a descargar, se conservan. La repetición sólo cambia esos dos pasos de preparación y no suma los preparativos repetidos. No hay un ensayo nuevo con proveedores reales ni teléfonos físicos.

Distribución **33 archivos, 885.074 bytes**, entrada **51.243** y aplicación bajo demanda **788.258**; CSS, fuentes y receta P1 idénticos a b698. Publicación `c7e669fe29c769473232caebb060ca2331ffd898`, [workflow correcto](https://github.com/diad87/pletina/actions/runs/40073366431) y [33/33 archivos públicos HTTP/SHA](../artifacts/pwa-deploy/public-files-435e0dc36a054099.json). No se promete almacenamiento permanente, disponibilidad universal, resolución de Ni, Ni, Ni!, descargas en segundo plano ni paridad de las integraciones nativas.
<!-- downloads-parity-435-summary:end -->

## Historial anterior a 435e0dc36a054099

<!-- podcast-p1-b698-summary:start -->
**Anterior: `b698958a8a49ec05`, publicada y verificada**, fuente `f3e890ce8a7b99ce3803d14c9df5be168431e63c`. [Episodios de YouTube sin conexión](pwa-podcast-offline.md): el botón del programa permite guardar también audio P1 con los mismos límites y comprobación local que las canciones. Conserva el vídeo exacto, el identificador de episodio y su posición. Un archivo rechazado no se marca como descargado. La reparación del CDN primario mediante P1 se activa para reproducción de episodios, sin cambiar la renovación de descargas ni la política RSS. Todo PWA, sin servidor intermedio ni cuentas.

[Validación de esta compilación](../artifacts/pwa-e2e/validation-b698958a8a49ec05.json): **856/856** pruebas de lógica y tipos con **0 errores/0 avisos**; **27/27** comprobaciones únicas en Chrome, Firefox y WebKit de escritorio, incluidas preparaciones. El nuevo recorrido usa el botón real del programa, descarga serial de dos episodios, rechazo 403/HTML del segundo, caché opaca, recarga sin red y reproducción/seek/reanudación local desde aproximadamente 45 de 90 segundos. Los dos errores iniciales del observador quedan conservados: preparación de sesión por ID exacto y consulta de metadatos del programa bloqueada al reabrir. Las preparaciones repetidas no se suman. Son respuestas HTTP sintéticas y navegadores de escritorio, no un proveedor o teléfono real.

Actualización desde 6bd **11/11**, con biblioteca, progreso y descargas conservados. Distribución **33 archivos, 883.757 bytes**, entrada **51.243** y aplicación bajo demanda **786.941**; CSS, fuentes y receta P1 idénticos a 6bd. Publicación `ab3ea586689e12e2a5a53f4746efee82a39d3bf7`, [workflow correcto](https://github.com/diad87/pletina/actions/runs/40029187417) y [33/33 archivos públicos HTTP/SHA](../artifacts/pwa-deploy/public-files-b698958a8a49ec05.json). No se afirma disponibilidad universal, solución de Ni, Ni, Ni!, descarga en segundo plano ni una nueva prueba física Android/iPhone.
<!-- podcast-p1-b698-summary:end -->

## Historial anterior a b698958a8a49ec05

<!-- p1-cache-6bd-summary:start -->
**Anterior: `6bdc970908569e3c`, publicada y verificada**, fuente `9c437f92c385a418f95f5f014cf07d7ba756c5c6`. [Música P1 sin conexión](pwa-p1-offline-cache.md): habilita descarga cuando el formato seleccionado confirma tamaño declarado y duración; espera el guardado completo en caché y comprueba duración y audio cerca del final antes de marcarla terminada. No guarda URL firmadas ni afirma un SHA del cuerpo opaco. La fila distingue «En curso» de «En cola» sin inventar porcentajes; el plazo P1 se adapta a la duración, con diez minutos máximos por trabajo y sin reiniciarlo en cada reintento. Se mantiene todo PWA, sin servidor intermedio ni cuentas.

Incluye [tres arreglos generales del motor](pwa-audio-recovery.md): reparación del CDN primario mediante P1 del mismo vídeo, elección de un formato fresco aunque otro haya caducado y rescate Audius exacto ante errores transitorios de YouTube. [Validación](../artifacts/pwa-e2e/validation-6bdc970908569e3c.json): **847/847** pruebas de lógica, tipos **0 errores/0 avisos**, **45/45** comprobaciones multimedia controladas en tres motores de escritorio y actualización desde 1ea **11/11**. Los 45 consolidan por ID las dos revisiones del observador Windows; no suman preparaciones repetidas. Los informes conservan los fallos iniciales de QA y los canarios reales con su propio alcance. El [canario público de la UI actual](../artifacts/pwa-port/p1-opaque-download-6bdc970908569e3c-euri-public-live-v3.json) pasa **4/4** con Euri Tanta: descarga desde su menú, caché opaca, recarga offline, reproducción y seek local, y borrado con ruta 404. El canario local previo no llegó a descargar por 403 del proveedor; los dos primeros intentos públicos tuvieron errores de observación y quedan preservados. El prototipo anterior 3/3 conserva su propio alcance; ninguna ejecución es un teléfono físico.

Distribución **33 archivos, 883.783 bytes**; entrada **51.243** y aplicación bajo demanda **786.967**. Publicación `4b7c6711af6ed59797a2c1c293b153f08b64b1f1`, [workflow correcto](https://github.com/diad87/pletina/actions/runs/40023845199) y [33/33 archivos públicos HTTP/SHA](../artifacts/pwa-deploy/public-files-6bdc970908569e3c.json). **No se afirma disponibilidad universal ni resolución de los 403 persistentes de Ni, Ni, Ni!** La nueva descarga P1 se aplica a canciones; los episodios P1 mantienen su política anterior. Pantalla apagada, segundo plano y descargas de esta versión instalada siguen pendientes de prueba física.
<!-- p1-cache-6bd-summary:end -->

## Historial anterior a 6bdc970908569e3c

<!-- library-1ea-summary:start -->
**Anterior: `1ea46db9dc0b5af3`, publicada y verificada**, fuente `af1c3f4a6900fb8ca8052328f8ed539bc2cc11ad`. [Copia portátil de biblioteca](pwa-library-portability.md) en **Tu biblioteca → Copia de seguridad**: archivo JSON local, revisión previa e incorporación que conserva los datos existentes y el orden y repeticiones de las listas. No incluye música descargada ni migra la base privada de la APK. También renueva el enlace de un pódcast de YouTube si caducó mientras estaba pausado, conservando la posición. Todo PWA, sin servidor intermedio ni cuentas.

[Validación de esta compilación](../artifacts/pwa-e2e/validation-1ea46db9dc0b5af3.json): **814/814** de lógica, tipos **0 errores/0 avisos**, copia de biblioteca **30/30** en tres motores de escritorio (incluye dos preparaciones por motor), regresión de pódcasts **6/6** en Chrome (tres preparaciones) y actualización desde C8 **11/11**. Los recorridos nuevos usan proveedores HTTP de QA; no acreditan teléfonos físicos ni audio comercial real. El fallo inicial de un selector del runner móvil se conserva separado con su corrección, sin contarlo como aprobado.

Distribución **33 archivos, 881.649 bytes**; entrada **51.243** y aplicación bajo demanda **784.833**. Fuentes tipográficas y receta P1 idénticas a C8; CSS actualizado para la nueva vista. Publicación `c03c2ec2aab2f2127a265e42515a0333fde9a50b`, [workflow correcto](https://github.com/diad87/pletina/actions/runs/40018900487) y [33/33 archivos públicos HTTP/SHA](../artifacts/pwa-deploy/public-files-1ea46db9dc0b5af3.json). **P1 sigue sin descarga offline fiable y no se afirma cobertura universal ni paridad total.** Estas funciones nuevas están pendientes de prueba física; los informes históricos conservan su propio alcance.
<!-- library-1ea-summary:end -->

## Historial anterior a 1ea46db9dc0b5af3

> Informe histórico de la primera fase y de su corrección de audio. El estado actual y la ampliación a la APK completa están en [pwa.md](pwa.md) y en la [matriz de paridad](pwa-parity-0.11.2.md).

Actualizado el **18 de octubre de 2026**. Base nativa exacta: commit `4b5691ff50d659fbd048f5a9cff1ddfa91c22a79`, versión **0.11.2**. Build publicado actual: **`74d9ad3aebca421b`**, con corrección de la transición a siguiente pista. El primer build publicado fue `1785b6edf53a230b` y el informe amplio anterior corresponde a `3622b8aa49a2ee7f`; cada ejecución se identifica a continuación.

**Estado de publicación: `74d9ad3aebca421b` publicado y verificado por HTTPS.** Está en <https://diad87.github.io/pletina/>. La comparación pública pasó **22/22 archivos**, con HTTP 200 y SHA-256 coincidentes; las pruebas local y pública de Creep → Million Dollar Question pasaron **2/2 comprobaciones cada una** en Chrome de escritorio con pestaña oculta. Commit de distribución `gh-pages`: `d004cea9ebdde641b75a51ec6b1ad8eaf947c1c0`, distinto de la base nativa 0.11.2.

JavaScript principal `application/assets/index-pDy3iFgl.js`, **35.884 bytes iniciales** y **411.523 bytes bajo demanda**. La comprobación de tipos terminó con **0 errores y 0 avisos**, la suite pasó **226/226** y la compilación nativa final también pasó. La prueba física del build anterior informó continuidad con pantalla apagada, pero fallo al pasar a la siguiente; **falta repetirla con la corrección y no se declara resuelta la incidencia móvil**.

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

Medición del build actual `74d9ad3aebca421b`, por suma de archivos **sin comprimir**:

| Grupo | Bytes | Aproximación decimal |
| --- | ---: | ---: |
| Entrada, manifiesto, iconos y service worker | 35.884 | 35,9 KB |
| Aplicación bajo demanda: HTML, JS, CSS, fuentes y lanzador | 411.523 | 411,5 KB |
| Ambos grupos | 447.407 | 447,4 KB |

Son tamaños de archivos, no una medición del tráfico comprimido del navegador. No incluyen la herramienta diagnóstica independiente ni música. La prueba registra **cero solicitudes a `application/` en la instalación inicial**. La primera apertura descarga y verifica los recursos de la app antes de entrar. El HTML actual es `application/index.7537ce85bd4c59da.html` y su JavaScript principal `application/assets/index-pDy3iFgl.js`; no deben utilizarse como dirección estable de instalación. Los tamaños y nombres cambian al recompilar una modificación. El anterior `1785b6edf53a230b` medía 35.884 bytes iniciales y 410.560 bajo demanda.

`dist-pwa-portable/Pletina.html` sigue siendo únicamente la copia local de Hola mundo. No es el port musical ni proporciona instalación o actualización como PWA desde `file://`.

## Pruebas del build

El informe consolidado [`artifacts/pwa-port/browser.json`](../artifacts/pwa-port/browser.json) reúne **12 comprobaciones correctas** de tres ejecuciones sobre el build anterior `3622b8aa49a2ee7f`; conserva los resultados fallidos del primer runner. Tras el ajuste inicial de concurrencia se repitió instalación, búsqueda y reproducción de la canción seleccionada sobre el primer build publicado `1785b6edf53a230b`, con **3/3 comprobaciones correctas** en [`browser-final-selected-song.json`](../artifacts/pwa-port/browser-final-selected-song.json). Chrome utilizado: **148.0.7778.97** de escritorio. La salida de sonido se silenció mediante el argumento de Chrome; el elemento de audio permaneció con `muted: false`. La corrección posterior `74d9ad3aebca421b` tiene sus pruebas específicas de transición en la sección siguiente.

| Comprobación | Evidencia |
| --- | --- |
| Instalación mínima y carga completa bajo demanda | Cero solicitudes de aplicación antes de abrir; recursos guardados después |
| Búsqueda por nombre/artista | Resultados reales en la interfaz Svelte |
| Canción seleccionada inicialmente | «Creep», Radiohead, ID de catálogo `138547415` → vídeo `9RfVp-GhKfs` |
| Reproducción de esa canción | Build `1785b6edf53a230b`: una única instancia; posición 2,13 s, duración 238,64 s, sin error multimedia |
| Transporte de audio | Respuesta HTTP 206 `audio/mp4` desde `googlevideo.com` |
| Pausa y posición | Controles de la interfaz sobre el mismo elemento de audio |
| Fin y siguiente pista con pestaña oculta | Pasó a la siguiente y el audio avanzó; la fuente puede estar precargada. Se adelantó la pista a 1,2 s del final |
| Media Session | Handlers de pausa y siguiente controlaron reproducción real |
| Favorito, cola manual y playlist | Acciones de la interfaz comprobadas en repetición dirigida |
| Persistencia tras recargar | Favorito y playlist recuperados de IndexedDB |
| Recarga offline | Abrieron interfaz cacheada y metadatos locales; no se probó audio offline |
| Diseño móvil | Android 393 px e iPhone 390 px sin desbordamiento horizontal; emulación de Chrome |

La canción seleccionada pasó dos veces en `3622b8aa49a2ee7f` y de nuevo en `1785b6edf53a230b`. Se conservan [`browser-selected-song.json`](../artifacts/pwa-port/browser-selected-song.json), [`browser-selected-song-first.json`](../artifacts/pwa-port/browser-selected-song-first.json) y [`browser-final-selected-song.json`](../artifacts/pwa-port/browser-final-selected-song.json), que registran IDs y estado del medio sin direcciones firmadas.

Después de aquel despliegue, la misma comprobación sobre **la dirección pública HTTPS** pasó **3/3** con `1785b6edf53a230b`. [`browser-public-selected-song.json`](../artifacts/pwa-port/browser-public-selected-song.json) verifica instalación mínima, búsqueda real y reproducción de Creep desde el catálogo, sin error multimedia. Es una comprobación de escritorio sobre el servicio publicado; no acredita pantalla bloqueada ni iOS.

El informe original [`browser-first-queue-order.json`](../artifacts/pwa-port/browser-first-queue-order.json) sigue marcado como fallido. El runner añadió una canción a la cola manual mientras el reproductor estaba inactivo, lo que inicia reproducción, y después pulsó otra canción. Falló su expectativa sobre la cola y, por dependencia, las de playlist y persistencia. La repetición dirigida [`browser-ui-followup.json`](../artifacts/pwa-port/browser-ui-followup.json) corrigió la secuencia y pasó esas comprobaciones con el mismo build.

Esa primera ejecución solapada registró también **dos errores multimedia 4** y avanzó a otras canciones. No acredita el éxito inicial de Creep ni permite atribuir una causa al fallo. Se conserva como evidencia de controles y transiciones posteriores. La comprobación limpia de la canción seleccionada, con un solo clic y sin manipular la cola, pasó después sin error. No se declara resuelta una causa que no se haya identificado.

En la verificación de `1785b6edf53a230b` pasaron **216/216 pruebas automáticas**, `npm run check` con **0 errores y 0 avisos** y la compilación nativa `npm run build`. Aquella regresión reproduce un rechazo de autoplay tardío de una canción anterior que podía poner en pausa el estado de la nueva: falló antes de comprobar el token y la instancia de audio y pasó después, junto con **45/45 pruebas dirigidas de reproductor**. No se atribuyen a este fallo los errores multimedia 4 sin causa identificada. La corrección actual amplía la suite a **226/226**.

El runner es `scripts/tests/web-port.browser.mjs`. Puede usar un servidor estático efímero solo para QA, que cierra al terminar, o recibir `--url` para comprobar una publicación. Ese servidor no es una dependencia de la app. Las capturas [`desktop-search.png`](../artifacts/pwa-port/desktop-search.png), [`android-ui-emulated.png`](../artifacts/pwa-port/android-ui-emulated.png) e [`iphone-ui-emulated.png`](../artifacts/pwa-port/iphone-ui-emulated.png) documentan el diseño; no convierten Chrome en Safari ni en un teléfono real.

## Pantalla apagada y límites pendientes

La evidencia física previa corresponde a **otro reproductor**, el básico publicado antes de este port. En Xiaomi 15T Pro, el usuario confirmó continuidad y nueva fuente al terminar una pista con Chrome bloqueado; después confirmó **«Funciona instalada y bloqueada»** desde el icono de la PWA anterior. Se registró el protocolo de dos minutos, sin recibir versión exacta del sistema/navegador ni JSON del teléfono.

Se conservan las confirmaciones textuales en [`android-user-confirmation.json`](../artifacts/pwa-screen-off/android-user-confirmation.json) y [`android-installed-user-confirmation.json`](../artifacts/pwa-screen-off/android-installed-user-confirmation.json). El contexto está en los informes históricos de [pantalla apagada](pwa-screen-off-results.md) y [primera integración](pwa-player-results.md); otros artefactos antiguos mencionados allí pertenecen al entorno original y no están necesariamente copiados a este worktree.

El usuario probó después el port en el contexto solicitado de PWA instalada y respondió **«reproduce bien con la pantalla apagada, pero no pasa a la siguiente cancion»**. El registro [`android-installed-user-report-1785b6edf53a230b.json`](../artifacts/pwa-port/android-installed-user-report-1785b6edf53a230b.json) separa continuidad correcta y siguiente incorrecta. Xiaomi 15T Pro es el dispositivo identificado en las respuestas previas. `1785b6edf53a230b` era el build indicado para la prueba; no se ha confirmado el hash abierto ni recibido diagnóstico automático. También siguen sin confirmar la cola restante y el comportamiento al desbloquear. **La causa no está confirmada y la continuación bloqueada no está validada.**

La pestaña oculta de escritorio no había detectado este comportamiento y su prueba acelera la transición mediante un salto temporal. No hay ejecución física en otros Android, iPhone/iPad, Safari o PWA instalada de iOS. La emulación de tamaño no verifica restricciones del sistema ni segundo plano.

### Corrección publicada de la transición preparada

La lectura del código identifica una espera evitable: la precarga anterior obtenía la URL, pero al terminar la pista se vaciaba el elemento y `api.resolve` volvía a abrir IndexedDB antes de reproducir, incluso cuando la URL seguía en la caché RAM del adaptador. Eso demuestra una diferencia de la ruta de transición; no confirma que el teléfono se haya suspendido en ese punto.

La corrección conserva una única fuente siguiente en RAM con caducidad. Si al terminar sigue siendo la siguiente válida, asigna su URL, carga esa URL y llama a `play()` en la misma llamada del evento `ended`, conservando el elemento y sin pausa, retirada de `src`, carga vacía ni nuevo `api.resolve`. También repasa la reserva al ocultar la página si se quiere reproducir y tras reanudar, para renovar una reserva caducada durante una pausa. Si la fuente no está preparada o ha caducado, sigue disponible la ruta normal de resolución.

La regresión principal falló antes de la corrección y después pasó. **17/17 pruebas PWA de reproductor** comprueban la llamada síncrona, cambios de cola DJ, duplicados y repetición, pausa durante precarga, fuente elegida manualmente, respuesta tardía de una colección anterior, caducidad y temporizador al final. Otra regresión detectó que una precarga pendiente podía volver a reservar una fuente anterior tras elegir otra; se invalidó también esa entrada pendiente y pasó. Estas son pruebas de lógica, no una ejecución del sistema móvil. El build publicado es `74d9ad3aebca421b`, con **226/226 pruebas generales**, tipos sin errores ni avisos y compilación nativa final correcta. Falta la repetición física.

En [`transition-local-74d9ad3aebca421b.json`](../artifacts/pwa-port/transition-local-74d9ad3aebca421b.json), Chrome 148 de escritorio reprodujo Creep y preparó Million Dollar Question, ambas seleccionadas desde el catálogo. Los IDs registrados son `138547415` → `9RfVp-GhKfs` y `138548049` → `Ufiq21B3WqI`. Con `hidden: true`, al terminar la primera, el mismo elemento recibió `src`, `load()` con la nueva URL y `play()` dentro de la propia llamada de `ended`. El audio de la segunda avanzó; no hubo nueva apertura de IndexedDB, pausa explícita, retirada/carga vacía, iframe ni peticiones al proveedor en esa transición. Se aceleró el final mediante seek. Es evidencia real de escritorio con fuentes preparadas, no pantalla físicamente apagada.

La repetición sobre **la dirección pública HTTPS** también pasó **2/2**, con exactamente esas dos canciones: [`transition-public-74d9ad3aebca421b.json`](../artifacts/pwa-port/transition-public-74d9ad3aebca421b.json). Conservó el mismo Audio y la llamada síncrona de `play()` de la segunda dentro de `ended`, con pestaña oculta, sin reset, acceso a IndexedDB ni nueva resolución en esa transición. Tampoco acredita el bloqueo físico del teléfono.

Los intentos anteriores [`transition-local-74d9ad3aebca421b-acoustic.json`](../artifacts/pwa-port/transition-local-74d9ad3aebca421b-acoustic.json) y [`transition-local-74d9ad3aebca421b-row-center.json`](../artifacts/pwa-port/transition-local-74d9ad3aebca421b-row-center.json) se conservan fallidos: el primero no obtuvo una fuente utilizable para la versión acústica y el segundo no completó el inicio esperado al pulsar el centro de la fila. No se cuentan como transiciones correctas ni se atribuyen sus fallos a la pantalla bloqueada.

Los diagnósticos aislados [`lifecycle-browser.json`](../artifacts/pwa-port/lifecycle-browser.json) y [`lifecycle-script-control.json`](../artifacts/pwa-port/lifecycle-script-control.json) usan el Player compilado con SHA-256 `f1a27c39007bfa51a3094de1977dc1cd304aad99d93b7ec28b852d1906ff1edc`, API controlada y WAV locales decodificados por Chrome 153. No son la app completa ni el motor de YouTube. Pasaron **seis casos más un control** solo de escritorio: cola, limitación de CPU, fuente preparada, rechazo simulado de autoplay y comandos de ciclo de vida. La visibilidad medida fue `hidden: false`: el comando de freeze no suspendió la transición relevante, por lo que no acredita ejecución bajo suspensión. El control de deshabilitar JavaScript explícitamente sí impidió `ended` y las solicitudes de la siguiente fuente durante 5,51 segundos; al habilitarlo la reproducción siguió. Es un control artificial que muestra el límite de depender de JavaScript, no una reproducción del bloqueo de Android.

La repetición física debe confirmar el build corregido, buscar y reproducir desde la nueva interfaz y comprobar que existe una canción siguiente en la cola. Después, adelantar hasta unos 30 segundos antes del final y bloquear dos minutos. Hay que registrar continuidad, siguiente canción sin intervención y estado al desbloquear, con dispositivo y versiones. Quedan sesiones largas, renovación tras una pausa prolongada y cambios entre Wi-Fi y datos. Los endpoints internos pueden cambiar; el éxito de unas canciones no garantiza disponibilidad de todo el catálogo.

La disponibilidad offline comprobada corresponde a interfaz y biblioteca de metadatos. No se han portado las descargas. Reproducir un recurso multimedia no demuestra que JavaScript pueda descargar sus bytes por CORS. Borrar los datos del sitio o perder el almacenamiento del navegador exige preparar de nuevo la app y puede borrar la biblioteca web.

## Actualizaciones y despliegue

El worker verifica SHA-256 y separa cachés por versión. El botón **Actualizar** solicita `PREPARE_APPLICATION` al worker pendiente: primero guarda y verifica todos los recursos nuevos bajo demanda y después envía `ACTIVATE_UPDATE`. Si falla el staging, se informa del fallo y la versión activa sigue disponible para reintentar. Al activarse, la app redirige a la entrada estable `?open=app`, evitando conservar un HTML antiguo con hash. La biblioteca IndexedDB no se elimina al cambiar la caché de código.

La prueba E2E [`update-browser.json`](../artifacts/pwa-port/update-browser.json) pasó **7/7 comprobaciones** en Chrome de escritorio 153.0.8010.52 con los assets compilados de `1785b6edf53a230b` (`index-BSCGGeHI.js`). Creó variantes A/B temporales de HTML para provocar una actualización: mantuvo A activa al fallar la preparación, permitió reintentar y verificó el orden `PREPARE_APPLICATION → ACTIVATE_UPDATE → controllerchange`. La versión actualizada volvió a abrir sin red con el mismo ID de playlist y las mismas entradas duplicadas. La playlist se creó y renombró desde la interfaz; los metadatos de esas dos entradas se sembraron en IndexedDB como fixture de QA. No se usó audio ni una red externa de música. No se presenta como una nueva ejecución E2E sobre `74d9ad3aebca421b`.

También comprobó la migración desde el prototipo `85d3cde632c1480f` manteniendo una única registration, `id`, `scope` y `start_url`, preservando almacenamiento local y cachés ajenas. Es una prueba real del worker y la base de datos en escritorio; no acredita la migración del icono del sistema en Android/iOS. El servidor estático temporal quedó cerrado y el sitio de pruebas se eliminó. Las variantes de QA no sustituyen el build final de distribución.

La publicación utiliza **Pages por rama `gh-pages`**, no GitHub Actions. `.github/workflows/pwa.yml` prepara el mecanismo alternativo de Actions, con comprobaciones y build completo, pero aún no está activo. El primer build publicado `1785b6edf53a230b` corresponde al commit de distribución `cd4c6b68d5fe729a69f326952d65018d3149e4e7`, con hash de distribución `a96aee2dc35b15a1ca35d829dd8bb6a15e5dc826a79abccc40afc5386eec5e17`. Su comparación **22/22 archivos públicos** está archivada en [`public-files-1785b6edf53a230b.json`](../artifacts/pwa-deploy/public-files-1785b6edf53a230b.json); la prueba física posterior detectó el problema de siguiente canción.

La corrección `74d9ad3aebca421b` está publicada en el commit de distribución `d004cea9ebdde641b75a51ec6b1ad8eaf947c1c0`, árbol `73fed410a0178b7347f1067af6d3edf46b53981c`, hash de distribución `64070fa0c9e0c740f89fdba89895afaa6794e03e74d458ae273a634ecf9ac013`. Pages terminó el build y su comparación HTTPS pasó **22/22 archivos**, todos con HTTP 200 y SHA-256 coincidentes: [`public-files-74d9ad3aebca421b.json`](../artifacts/pwa-deploy/public-files-74d9ad3aebca421b.json). También pasó la transición pública de dos canciones indicada antes. La verificación de publicación y escritorio no sustituye la repetición física pendiente.
