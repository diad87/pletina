# Musify — Plan

Reproductor tipo Spotify para PC (Windows), 100% de uso personal. La prioridad es que sea **muy ligero**.

## Cómo funciona
Buscas un grupo, ves las carátulas de sus discos, eliges un disco y luego una canción. La app busca la canción en YouTube Music, guarda solo el ID del vídeo y reproduce **solo el audio en streaming**, directamente desde los servidores de YouTube.

- **No se descarga nada.** El audio se escucha mientras llega, como en Spotify.
- **No se usa el reproductor de YouTube.** Por eso no hay anuncios y tampoco hace falta un bloqueador que mantener.
- **Es mucho más ligero que incrustar YouTube.** El reproductor de YouTube carga varios MB de código y decodifica vídeo; aquí solo se reproduce el audio.
- **No hace falta servidor.** En una web haría falta un servidor en medio, porque la URL del stream solo funciona desde la IP que la pidió. Aquí tu PC la pide y tu PC la reproduce. Además, YouTube no bloquea las conexiones de casa como bloquea las de servidores en la nube.

## Por qué Tauri y no Electron
| | Musify (Tauri), medido | Electron (típico) |
|---|---|---|
| Instalador | 1,4 MB | ~100 MB |
| Ejecutable | 3,7 MB | ~150 MB |
| Memoria RAM | ~160 MB (casi toda es WebView2) | ~250–400 MB |
| Motor | WebView2 (ya viene con Windows 11) | Lleva su propio Chromium |

La única desventaja es que hace falta Rust para compilar la app. Para usarla no hace falta.

## Piezas
- **Interfaz**: Svelte 5 + TypeScript + Vite, con CSS propio y sin librerías de componentes.
- **Base de la app**: Tauri 2 (Rust).
- **Catálogo**: API de Deezer (sin clave). Las carátulas vienen de su servidor de imágenes y WebView2 las guarda en caché.
- **YouTube**: yt-dlp, que se usa solo para buscar y obtener la URL del stream, no para descargar. No va dentro del instalador: la app lo baja la primera vez y lo actualiza sola.
- **Reproducción**: elemento `<audio>` con el stream, y control con las teclas multimedia del teclado y el panel multimedia de Windows.
- **Datos**: SQLite en local (discos, canciones, IDs de vídeo, playlists, favoritos).

## Qué pasa al darle play a una canción
1. **Si la canción no tiene ID de vídeo guardado**, se busca en YouTube Music, se elige la mejor coincidencia y se guarda su ID.
2. Se pide a YouTube la URL del stream de audio y empieza a sonar. Esa URL caduca a las pocas horas, así que no se guarda.
3. Para evitar esperas:
   - Al abrir un disco, se buscan en segundo plano los IDs de todas sus canciones.
   - Mientras suena una canción, se prepara la URL de la siguiente.

## Cómo elegir el vídeo correcto
- Se prefieren los canales "*Grupo* - Topic", que son el audio oficial del disco.
- La duración tiene que parecerse a la de Deezer, con unos ±5 segundos de margen.
- Se descartan "live", "cover", "karaoke" o "remix" cuando el título original no los lleva.
- Si un vídeo falla, se prueba con el siguiente.
- Un botón de "esta no es" permite elegir otro vídeo, y esa elección queda guardada.

## Modelo de datos (SQLite)
- `artists`: deezer_id, nombre, imagen
- `albums`: deezer_id, artista, título, año, carátula
- `tracks`: deezer_id, disco, número de pista, título, duración
- `sources`: canción, ID del vídeo, duración, puntuación de coincidencia, si la verificaste tú
- `playlists`, `playlist_tracks`, `favorites`

## Fases
1. **Esqueleto y catálogo.** App Tauri, búsqueda en Deezer, cuadrícula de carátulas y página de cada disco.
2. **Reproducción.** yt-dlp, búsqueda y streaming, y barra de reproducción tipo Spotify.
3. **Cola.** Siguiente/anterior, aleatorio, preparar la siguiente canción, "esta no es" y teclas multimedia.
4. **Biblioteca.** Favoritos, playlists e historial.
5. **Descargas.** Guardar canciones y discos en el PC para escucharlos sin conexión. yt-dlp ya sabe descargar el audio; la app reproducirá el archivo local si existe y si no, en streaming. Botón de descargar en disco y canción, y carpeta configurable.
6. **Linux y Mac, con instalación muy fácil en los tres.** Requisito: descargar un archivo y abrirlo, sin instalar nada más.
   - Windows: el instalador `.exe` actual (doble clic y listo).
   - Mac: un `.dmg` (arrastrar a Aplicaciones). Sin una cuenta de desarrollador de Apple (99 $/año) macOS avisa la primera vez y hay que abrirlo con clic derecho → Abrir; con la cuenta, se firma y no avisa.
   - Linux: un `.AppImage` (un solo archivo, doble clic) y también `.deb` para Ubuntu/Debian.
   - Los tres se generan solos con GitHub Actions en cada versión.
   - Que no dependa de nada instalado: la app baja el yt-dlp de cada sistema y, en lugar de usar Node, un motor de JavaScript pequeño que también se descarga sola.
   - Comprobar los formatos de audio: el motor web de Mac y Linux (WebKit) puede necesitar m4a en lugar de webm/opus.
7. **Móvil.** Tauri 2 también genera apps de Android e iOS con la misma interfaz. Depende del proyecto paralelo P1 (sacar el audio sin yt-dlp) y de sincronizar la biblioteca (Firebase).

### Actualizaciones automáticas en todas las plataformas
Requisito: se instala el "cascarón" una vez y, al publicar una versión en GitHub, se actualiza solo, sin que el usuario haga nada. Todas las actualizaciones van firmadas con una clave propia; la app rechaza cualquier versión sin esa firma. GitHub Actions compila y publica todo al subir una versión.

Dos capas:
1. **Contenido (interfaz + extractor de YouTube en JavaScript de P1):** se descarga de GitHub en segundo plano y se aplica al volver a abrir la app. Silencioso en las 5 plataformas, incluido iOS (Apple permite actualizar código JavaScript que corre en su motor web). Cubre casi todos los cambios, también los arreglos cuando YouTube cambia algo. Requiere servir la interfaz desde una carpeta local en lugar de llevarla dentro del ejecutable; hay que construirlo.
2. **Cascarón (el ejecutable, cuando cambia la parte de Rust):**
   - Windows, Mac, Linux (AppImage): actualizador oficial de Tauri. Descarga en segundo plano e instala al cerrar la app. Totalmente silencioso.
   - Android: la app no puede ir a Google Play (incumple sus normas por usar YouTube). Se instala el APK con **Obtainium**, que vigila las versiones de GitHub y, en Android 12 o superior, actualiza en segundo plano sin preguntar.
   - iOS: tampoco puede ir a la App Store. Con **SideStore/AltStore** (gratis) la app se instala y se renueva sola cada 7 días, y puede actualizarse desde una "fuente" en GitHub, pero iOS no deja que sea del todo automático. Con la cuenta de desarrollador (99 $/año) el certificado dura un año; la actualización del cascarón sigue pidiendo un toque.

### Proyecto paralelo P1: extractor de YouTube sin yt-dlp
yt-dlp es un programa de escritorio en Python: no funciona en Android ni en iOS. Hay que llevar su trabajo (buscar y sacar la URL del audio) a algo que funcione en todas partes. Se desarrolla en paralelo, en su propia rama, sin bloquear las fases 4–6.
- **Estado (6 de octubre de 2026):** rama `p1-youtubei`, sobre `main`. En Inicio se elige el motor: "Audio de YouTube con: yt-dlp · youtubei.js (prueba) · Propio". yt-dlp sigue siendo el de por defecto. **El recomendado es el motor propio**, hecho y medido en Windows.

#### Motor propio
- **Objetivo:** que funcione siempre que una persona pueda escuchar la canción en YouTube. Ninguna librería que imite la API interna de YouTube puede prometerlo (yt-dlp y youtubei.js se rompen cada vez que YouTube cambia algo). La única garantía real es usar el reproductor oficial, así que el motor tiene dos niveles:
  1. **Nivel rápido** (`native.rs`): una petición a la API interna de YouTube desde Rust, sin librerías ni programas externos.
     - Qué cliente de YouTube se imita, con qué versión y datos, va en una **receta** (`src-tauri/recipe/youtube.json`). Si YouTube cambia algo de eso, basta con publicar una receta con versión mayor: la app la baja sola (`MUSIFY_RECIPE_URL`) y se queda con la incluida si la nueva no vale.
     - Pide antes una **sesión de visitante** (`sw.js_data`). Sin ella, YouTube responde "inicia sesión para confirmar que no eres un bot": 0 de 30, frente a 30 de 30 con ella. Se busca por su forma (empieza por "Cgt"), no por su posición en la respuesta.
     - **Comprueba cada URL** pidiendo 1 KB hacia el 80 % antes de usarla. Es donde YouTube corta a veces (403); si pasa, pide otra.
  2. **Nivel garantizado** (`capture.rs` y `capture.js`): **el reproductor oficial de YouTube Music en una ventana oculta**. Su reproductor hace todo (PO token, descifrado, SABR o lo que YouTube use) y el motor copia el audio que le entrega al navegador: siempre pasa por Media Source, y el de audio va en un buffer propio.
     - El audio llega a Rust por el **canal nativo de WebView2** (`WebMessageReceived`), que solo existe en esa ventana. No hay puertos ni protocolos abiertos a la página, y la ventana no tiene permisos de Tauri.
     - La ventana usa **su propio perfil y su propio proceso navegador**: si YouTube o WebView2 fallan ahí, la interfaz de Musify no se entera. Hay una ventana nueva para cada canción y se cierra en cuanto la canción está entera, así que los cientos de MB de YouTube Music solo se gastan mientras se copia.
     - Comportamiento: rechaza las cookies ("Rechazar todo"), va siempre en silencio y deja pasar los anuncios como una persona (o los salta cuando sale el botón; nunca los acelera). La canción va a 16x y los últimos segundos más despacio, para no saltarse el final. La página se cree visible (`SetIsVisible`), para que el navegador no la frene.
     - **Se cura sola:** si la página deja de dar señales (latido cada segundo) mientras copia, se rehace la ventana y sigue desde el último segundo copiado. Si al acabar falta algún trozo, o saltas a una parte aún no copiada, el reproductor oficial va a ese punto. Si al rehacer la ventana YouTube elige otro formato (opus o AAC), se avisa al navegador (`changeType`).
  3. **En la app:** con el nivel rápido el `<audio>` reproduce la URL de YouTube. Con el garantizado, reproduce `musify-capture:<id>`, que la interfaz alimenta con Media Source a medida que llega (`capture.ts`): suena mientras se copia.
- **Mediciones** con las canciones de los 5 discos de `real_albums`, dentro de la app, en la misma tanda:

  | | yt-dlp | youtubei.js | Propio, rápido | Propio, garantizado |
  |---|---|---|---|---|
  | Hasta tener el audio (mediana) | 2 646 ms | 93 ms | **97 ms** (comprobado) | 1,5 s |
  | Empieza a sonar en el `<audio>` | ~25 ms | ~22 ms | ~39 ms | **15 ms** |
  | Suena y se puede saltar al 80 % | 25 de 30 | 30 de 30 | **30 de 30** | **39 de 39** (4 tandas) |
  | Saltar al 80 % (mediana) | ~0,6 s | ~0,6 s | ~0,6 s | 1,7–2,8 s |
  | Qué necesita | yt-dlp (18 MB) + Node o Deno | 660 kB de JavaScript | nada | nada |
  | Si YouTube cambia su API | esperar a que se actualice | sacar otra versión | publicar receta nueva | nada |

  - Las URLs malas de yt-dlp dan 403 al pasar del primer MB; se ve igual repitiendo la petición, así que es cosa de YouTube. El nivel rápido las detecta y las cambia antes de usarlas.
  - Con el reproductor de la app y el motor propio: de clic a sonar, 0,24–0,3 s con la búsqueda incluida; las siguientes canciones, ya preparadas, en ~26–51 ms (4 de 4 en cada prueba). Solo con el nivel garantizado: 1,5 s la primera canción nueva, 3–4 s si pasas enseguida a otra que aún no estaba preparada, y 26–52 ms las ya copiadas.
  - El nivel garantizado copia una canción entera en 7–25 s (16x).
- **Límites honestos:**
  - **DRM:** contenido cifrado (no la música normal de YouTube) no se puede sacar, y no se intentará.
  - **Contenido que pide iniciar sesión** (con restricción de edad, por ejemplo): hará falta enseñar la ventana del motor para iniciar sesión una vez, como haría una persona. Pendiente.
  - Si YouTube pidiera un **captcha**, igual: enseñar la ventana para resolverlo. Pendiente.
  - En el nivel garantizado, saltar a una parte aún no copiada tarda 1–3 s.
  - Las tiendas de apps no aceptan una app así (pasa igual con cualquier motor). En Android se instalaría con el APK; en iPhone, con Xcode (gratis caduca a los 7 días; con la cuenta de 99 $/año, al año).
- **Pendiente:**
  - Decidir dónde se publica la receta: tiene que ser un sitio público (un gist o un repositorio público pequeño), porque este repositorio es privado.
  - Búsqueda de respaldo en YouTube normal sin yt-dlp (hoy `ytdlp.search`): pasarla a `youtube.rs`.
  - Descargas sin yt-dlp: guardar lo que copia el nivel garantizado o bajar la URL del nivel rápido.
- **Móvil (fase 7):** el nivel rápido es Rust y funciona igual. El garantizado necesita en cada sistema una WebView controlada por código nativo, con su canal nativo. Tauri no deja abrir una segunda ventana en el móvil, y Android no deja leer lo que una página envía a un protocolo propio.
  - **Android:** plugin en Kotlin con su `WebView`, `addJavascriptInterface` como canal y `addDocumentStartJavaScript` para el script. Para que suene con la pantalla apagada hará falta un servicio en primer plano (igual con cualquier motor).
  - **iOS:** `WKWebView` con `WKUserScript` y `WKScriptMessageHandler`. Primero hay que comprobar cómo reproduce YouTube Music en iPhone: si usa HLS en vez de Media Source, se captura la URL HLS que pide su reproductor y se reproduce tal cual (iOS sabe hacerlo).
  - En Mac y Linux, lo mismo con WKWebView y WebKitGTK.

#### Primer prototipo: youtubei.js
- La librería (18.1, sin modificar) corre en la interfaz. Rust le hace las peticiones (`http_fetch`) y el descifrado va en un Web Worker. Funciona: 60 de 60 en dos rondas y ~90 ms. Pero imita la API interna igual que yt-dlp, y para seguir los cambios de YouTube hay que sacar una versión nueva de la app.
- **PO token:** de 11 clientes de YouTube, solo VISIONOS da audio completo sin él (es el que usa yt-dlp 2026.08.19). IOS, ANDROID_VR, TV_SIMPLY y YTMUSIC cortan con 403 pasado el primer MB; MWEB, desde el primer byte. WEB y ANDROID solo dan SABR; TV dice "The page needs to be reloaded"; los *_EMBEDDED, "This video is unavailable". youtubei.js no genera PO tokens: acepta uno hecho y lo pone en las URLs (`pot=`).
- **rusty_ytdl:** descartado. Su última versión es de agosto de 2024 y no conoce VISIONOS ni SABR.

#### Notas técnicas (WebView2)
- El receptor de mensajes de wry (la base de Tauri) va antes que el nuestro y corta la cadena con los mensajes que no son texto. Por eso `capture.js` manda texto con el prefijo `musify:`, que Tauri descarta en el primer carácter.
- Destruir una WebView y crear otra en seguida con el mismo nombre ha llegado a tumbar el proceso navegador de WebView2 (acceso inválido en `msedge.dll`, al cerrarse). De ahí el perfil aparte, un nombre nuevo por ventana y el cierre ordenado (primero `about:blank`).
- Reutilizar la misma página de YouTube Music para muchas canciones acaba colgándola (sin gastar CPU), sobre todo tras saltos. De ahí la ventana nueva por canción y el vigilante.
- Los ejecutables de los tests no llevaban el manifiesto de Windows (comctl32 v6) y no arrancaban (`STATUS_ENTRYPOINT_NOT_FOUND`) en cuanto el código de ventanas fue alcanzable desde ellos. `build.rs` ahora incrusta el manifiesto con el enlazador en todos (`windows-app-manifest.xml`).
- Al cerrar la ventana principal se cierra la app, aunque haya una ventana del motor abierta.

#### Qué cambia respecto a `main`
- Archivos nuevos:
  - `src-tauri/src/`: `extractor.rs` (elige motor, `http_fetch` y las mediciones), `native.rs`, `capture.rs` y `capture.js`.
  - `src-tauri/recipe/youtube.json` y `src-tauri/windows-app-manifest.xml`.
  - `src/lib/extractor/`: `capture.ts`, `engine.svelte.ts`, `youtubei.ts`, `fetch.ts`, `eval.worker.ts` y `bench.ts`.
  - `src/components/EngineSwitch.svelte`.
- Cambios pequeños en archivos que ya existen:
  - `lib.rs`: módulos, `init`, comandos y cerrar la app con la ventana principal.
  - `player.rs`: 3 llamadas a `stream`.
  - `ytdlp.rs`: `VideoInfo` serializable, y `now` y `query_param` visibles.
  - `player.svelte.ts`: `setAudioSource` en vez de `audio.src`, y `stopCapture` al cambiar de canción.
  - `main.ts` y `Home.svelte`: arranque y selector.
  - `build.rs`, `Cargo.toml` (`base64`; y en Windows `webview2-com` y `windows-core`) y `package.json` (`youtubei.js`).
  - CSP: `blob:` en `media-src`, para Media Source.
- Para probar la rama con otra copia de la app abierta, hay que arrancarla con otro identificador y otro puerto (`tauri dev --config` con `identifier`, `devUrl` y `beforeDevCommand` distintos). Si no, por ser de una sola instancia, la nueva se cierra al momento; y con el mismo identificador abrirían la misma base de datos.

#### Repetir las mediciones
1. Crear la lista de vídeos: `MUSIFY_BENCH_IDS=plan.json cargo test bench_videos -- --ignored --nocapture`.
2. Añadir a `plan.json` qué medir:
   - motores: `"ytdlp"`, `"full"` (youtubei.js), `"tier1"` (rápido) o `"tier2": {"count": N}` (garantizado);
   - `"audio": true` para comprobar el `<audio>`;
   - `"e2e": [{"query": "...", "tracks": 3, "engine": "propio"}]` para probar con el reproductor de la app.
3. Arrancar la app con `MUSIFY_BENCH=plan.json`; el resultado queda en `plan.result.json`.

## Riesgos y limitaciones
- Reproducir el audio fuera del reproductor de YouTube va contra sus condiciones de uso. Para uso personal es asumible.
- yt-dlp no es oficial. Cuando YouTube cambia algo, deja de funcionar hasta que sale una actualización (normalmente en horas o días). La app lo actualiza sola.
- La primera vez que suena una canción nueva tarda unos 2–4 segundos. Las siguientes empiezan casi al instante gracias a la precarga.

## Decisiones
- [x] Uso personal
- [x] App de escritorio para Windows; prioridad ligereza → Tauri
- [x] Streaming de solo audio, sin el reproductor de YouTube. Las descargas para escuchar sin conexión llegan en la fase 5.
- [x] Datos en local (SQLite). Firebase solo cuando llegue el móvil (fase 7).
- [x] Hoja de ruta: 4 biblioteca → 5 descargas → 6 Linux y Mac → 7 móvil.

## Estado
- [x] **Fase 1: esqueleto y catálogo.** Búsqueda de artistas y discos, discografía por secciones (álbumes / sencillos y EP / recopilatorios), página de disco con su lista de canciones (agrupada por CD si tiene varios), atrás/adelante que recuerda la búsqueda y el scroll, y "Visto recientemente" en Inicio.
- [x] **Fase 2: reproducción.** Clic en una canción (o en el botón grande del disco) y suena. El disco entero hace de cola: al acabar una canción pasa a la siguiente, que ya se ha preparado mientras sonaba la anterior. Barra de reproducción con anterior/siguiente, barra de progreso, volumen (se recuerda) y espacio para pausar.
  - Búsqueda directa en YouTube Music (~0,7 s) y puntuación de cada resultado por duración, título, artista y disco; penaliza directos, covers, remixes, etc. Si no hay una coincidencia clara, también busca en YouTube normal. Con 5 discos de prueba acertó 30 de 30 canciones.
  - La primera vez que suena una canción tarda ~3,5 s (búsqueda + yt-dlp). Después el vídeo elegido queda en SQLite y la URL en memoria mientras no caduque.
  - yt-dlp se descarga solo en el primer arranque y se actualiza una vez al día. Usa Node como motor de JavaScript si está instalado (YouTube lo exige para algunos formatos).
  - Si la URL caduca a mitad de canción, se pide otra y sigue donde iba. Si un vídeo ya no existe, se busca otro.
- [x] **Fase 3: cola y "esta no es".**
  - Aleatorio (la canción que suena se queda y se baraja el resto) y repetir (disco / una canción). Se recuerdan entre sesiones.
  - "¿No es esta canción?" (botón ⇄ de la barra): lista de hasta 16 vídeos de YouTube Music y YouTube con miniatura, duración (en rojo si no cuadra con el disco) y cuál está en uso. También se puede pegar un enlace de YouTube. La elección queda guardada como verificada y es la que suena a partir de entonces.
  - Teclas multimedia y panel multimedia de Windows: comprobado que aparece con título, artista y carátula, y que siguiente/anterior/play/pausa funcionan.
  - Una sola instancia: abrir Musify otra vez trae al frente la ventana que ya está abierta.
  - Puntuación más estricta: una canción con otro título ya no puede colarse aunque sea del mismo grupo y dure lo mismo.
- [x] **Fase 4: biblioteca.**
  - ♥ en cada canción (lista, barra de reproducción y menú) → "Canciones que te gustan".
  - ♥ en la cabecera de un disco → se guarda en "Tu biblioteca".
  - Playlists: crear (botón + de la barra lateral, o "Añadir a playlist → Nueva playlist"), renombrar (clic en el nombre), eliminar (con confirmación), añadir canciones o discos enteros, quitar canciones y reordenarlas arrastrando. Portada en mosaico con las carátulas.
  - Historial: cada canción que suena más de 30 s (o la mitad, si es corta). Vista "Historial" con borrar todo, e Inicio con "Escuchado recientemente".
  - Menú "⋯" y clic derecho en cualquier canción: me gusta, añadir a playlist, quitar de la playlist, ir al artista, ir al disco y "¿No es esta canción?" (ahora funciona con cualquier canción, no solo la que suena).
  - Base de datos con migraciones (`PRAGMA user_version`); la de las fases anteriores se actualiza sin perder los vídeos ya elegidos (comprobado con un test y con la base de datos real).
- [x] **Fase 5: descargas.**
  - Botón ⬇ en discos, playlists y "Canciones que te gustan" (con anillo de progreso mientras baja), y "Descargar" en el menú ⋯ de cada canción. Dos descargas a la vez; las canciones descargadas llevan un icono verde y las que están bajando, su porcentaje.
  - Se guardan en `Música\Musify\Artista\Disco\Canción.m4a` (formato que se reproduce en cualquier sitio); la carpeta se puede cambiar. Sin recodificar: el audio tal cual lo da YouTube.
  - Al reproducir, si la canción está descargada suena el archivo (sin conexión); si el archivo se borró a mano, vuelve al streaming.
  - Vista "Descargas": carpeta (abrir / cambiar), lo que se está descargando con su progreso y botón para cancelar lo pendiente, y lo descargado con tamaño, reproducir todo y quitar todas.
  - Si con "¿No es esta canción?" se elige otro vídeo para una canción descargada, se borra el archivo antiguo y se vuelve a descargar.
  - Probado con una descarga real de principio a fin (test `real_fetch`).
- [ ] Fase 6: Linux y Mac
- [ ] Fase 7: móvil

## Repositorios
- Código (privado): https://github.com/diad87/musify — rama `main`.
- Versiones (público): https://github.com/diad87/musify-releases — instaladores y canal de actualizaciones automáticas.

## Desarrollo
- Requisitos: Node 24, Rust (rustup, toolchain MSVC), Visual Studio Build Tools 2022 (C++) y WebView2 (viene con Windows 11).
- Arrancar en modo desarrollo: `npm run tauri dev`
- Crear el instalador: `npm run tauri build`; queda en `src-tauri/target/release/bundle/nsis/`.
- Comprobar tipos: `npm run check`
- Tests: `cargo test` en `src-tauri`. Con red: `cargo test -- --ignored --nocapture` (elección de vídeo con discos reales y resolución completa).

### Estructura
- `src-tauri/src/deezer.rs`: cliente de Deezer (búsqueda, artista, disco). Limpia los datos antes de pasarlos a la interfaz.
- `src-tauri/src/youtube.rs`: búsqueda en YouTube Music y puntuación de coincidencias (con tests).
- `src-tauri/src/ytdlp.rs`: descarga/actualización de yt-dlp, URL del audio y búsqueda de respaldo.
- `src-tauri/src/player.rs`: de canción de Deezer a audio reproducible (usa lo guardado o busca, y lo guarda).
- `src-tauri/src/db.rs`: SQLite local (`%LOCALAPPDATA%\dev.musify.desktop\musify.db`).
- `src-tauri/src/lib.rs`: comandos que llama la interfaz (`search`, `artist`, `album`, `resolve`).
- `src/lib/`: llamadas a esos comandos con caché, historial propio (`nav.svelte.ts`), reproductor y cola (`player.svelte.ts`), vistos recientemente y formatos.
- `src/views/`: pantallas (Inicio, Búsqueda, Artista, Disco).
- `src/components/`: piezas comunes (barra superior, menú lateral, tarjeta, carátula, iconos).
