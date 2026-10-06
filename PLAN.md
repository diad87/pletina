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
- **Estado (6 de octubre de 2026): prototipo hecho y medido. youtubei.js es viable**, y en escritorio es más rápido y fiable que yt-dlp. Está en la rama `p1-youtubei` de una copia aparte (`C:\Users\iunan\musify-p1`), porque el repositorio aún no tiene commits y la fase 5 se estaba haciendo en la carpeta principal.
- **Cómo funciona el prototipo:**
  - `youtubei.js` 18.1 (sin modificar) corre en la interfaz y solo se carga si se elige ese motor: 661 kB (165 kB comprimido) aparte del resto.
  - Sus peticiones HTTP las hace Rust con un comando propio (`http_fetch`, solo dominios de YouTube y Google). No hay CORS, se pueden mandar las cabeceras que el navegador no deja y no hace falta el plugin HTTP.
  - Rust le pide la URL con un evento y espera la respuesta. `player.rs` no cambia: donde llamaba a `ytdlp.stream(...)` ahora llama a `extractor::stream(...)`, que usa el motor elegido y, si youtubei.js falla, tira de yt-dlp.
  - Cuando hace falta descifrar la firma o el parámetro `n`, lo hace el motor JavaScript del webview dentro de un Web Worker. Así el código de YouTube no ve la app ni puede llamar a Rust. Funciona con la CSP actual, también en la app compilada; no hace falta `unsafe-eval`.
  - Opción en Inicio: "Audio de YouTube con: yt-dlp · youtubei.js (prueba)". Se recuerda entre sesiones. También se puede forzar al arrancar con `MUSIFY_ENGINE=youtubei`. yt-dlp sigue siendo el de por defecto.
- **Mediciones** con las 30 canciones de los 5 discos de `real_albums`, dentro de la app, en dos rondas (la segunda con yt-dlp primero):

  | | youtubei.js | yt-dlp |
  |---|---|---|
  | Tiempo en sacar la URL (mediana) | **88 ms** | 2,7 s |
  | URLs obtenidas | 60 de 60 | 60 de 60 |
  | Suenan en `<audio>` y se puede saltar al 80 % | **60 de 60** | 55 de 60 |
  | Formato | opus 251 (m4a 140 en 2 canciones) | el mismo |
  | Arranque | ~30 ms (sin bajar el reproductor de YouTube) | descarga yt-dlp (~18 MB) y necesita Node o Deno |

  - Las 5 URLs malas de yt-dlp dan 403 al pasar del primer MB, y la causa es de YouTube: repitiendo la misma petición a veces sale bien y a veces no. Con youtubei.js no ha pasado ni una vez en 89 intentos (60 en la app, 24 en Node y 5 en la app compilada). Probablemente influye que youtubei.js manda una sesión de visitante y yt-dlp no.
  - Una vez con la URL, empezar a sonar y saltar cuesta lo mismo con los dos (~0,65 s), porque eso depende de los servidores de YouTube.
  - Con el reproductor de la app y youtubei.js: de clic a sonar, 0,44 s con el vídeo ya guardado. La siguiente canción se prepara también con youtubei.js, y no hizo falta tirar de yt-dlp ninguna vez.
- **PO token** (la comprobación anti-bots de YouTube). Se probaron 11 clientes de YouTube:
  - **VISIONOS**: funciona sin PO token. Es el mismo que usa yt-dlp (versión 2026.08.19), y sus URLs no llevan firma ni `n`, así que ni siquiera hace falta bajar el reproductor de YouTube (2,5 MB) ni ejecutar su JavaScript.
  - IOS, ANDROID_VR, TV_SIMPLY y YTMUSIC dan URL, pero YouTube corta con 403 pasado el primer MB, y `<audio>` falla. MWEB da 403 desde el primer byte. WEB y ANDROID solo dan streaming SABR, sin URL directa.
  - TV responde "The page needs to be reloaded", y WEB_EMBEDDED y TV_EMBEDDED, "This video is unavailable".
  - youtubei.js **no genera** PO tokens: acepta uno ya hecho (`po_token` al crear la sesión o por vídeo) y lo añade a las URLs (`pot=`). Generarlo exige ejecutar BotGuard (p. ej. con `bgutils-js`), que en la app podría correr en el propio webview, porque es un navegador de verdad. Es el plan B si YouTube cierra VISIONOS.
  - Descifrado comprobado con los clientes web: con el `n` original YouTube da 403 y con el descifrado da 206. La primera vez el reproductor se baja y procesa en ~0,9 s, y queda guardado en IndexedDB; cada descifrado tarda ~8 ms en el worker.
- **rusty_ytdl:** no hizo falta probarlo. Su última versión (0.7.4) es de agosto de 2024 y no conoce VISIONOS ni SABR. youtubei.js, en cambio, saca versión cada pocas semanas (la 18.1 es de septiembre de 2026). Descartado.
- **Recomendación:**
  - Usar youtubei.js como motor del móvil (fase 7).
  - En escritorio, dejar la opción un tiempo en uso real y después hacerlo el motor por defecto, con yt-dlp de respaldo: la primera vez que suena una canción pasaría de ~3,5 s a ~1,5 s.
  - En la fase 6 ahorraría bajar yt-dlp y el motor de JavaScript en Mac y Linux. yt-dlp seguiría haciendo falta para las descargas (fase 5) hasta que se haga lo de "Pendiente".
- **Sobre que no le afecten los cambios de YouTube:** no se puede del todo (yt-dlp y youtubei.js se actualizan precisamente por eso), pero sí se puede evitar que un cambio rompa la app:
  - Varios motores detrás de `stream(video_id)`, con respaldo automático. Ya está hecho.
  - Una lista de clientes que se prueba en orden (hoy solo VISIONOS).
  - Actualizar youtubei.js sin reinstalar la app, como hoy se actualiza yt-dlp: bajar la última versión al arrancar y quedarse con la que trae la app si la nueva falla. Implica ejecutar código descargado, igual que con yt-dlp.
- **Pendiente para llevarlo al móvil:**
  - Búsqueda de respaldo en YouTube normal (hoy `ytdlp.search`): pasarla a `youtube.rs` (API interna, como la de YouTube Music) o a `yt.search` de youtubei.js. Sin esto, en el móvil solo se buscaría en YouTube Music.
  - Descargas sin yt-dlp: bajar desde Rust la URL que da youtubei.js, en trozos (el opus de YouTube se guarda tal cual).
  - `reqwest` usa la librería TLS del sistema; en Android conviene `rustls`.
  - En Mac, iOS y Linux (WebKit) puede hacer falta m4a en vez de opus. La elección de formato ya sabe caer a m4a: solo habría que darle preferencia allí.
  - Si una URL falla a mitad de canción, el reproductor ya pide otra y sigue donde iba; con youtubei.js eso tarda ~0,1 s en lugar de ~3 s.
- **Para integrarlo en la carpeta principal** (`p1-youtubei.patch` en la copia):
  - Archivos nuevos: `src-tauri/src/extractor.rs`, `src/lib/extractor/` (`youtubei.ts`, `fetch.ts`, `eval.worker.ts`, `engine.svelte.ts` y `bench.ts`) y `src/components/EngineSwitch.svelte`.
  - Cambios pequeños en archivos que ya existen:
    - `lib.rs`: el módulo, `extractor::init` y 8 comandos.
    - `player.rs`: 3 llamadas a `stream`.
    - `ytdlp.rs`: `VideoInfo` serializable, y `now` y `query_param` visibles para el módulo nuevo.
    - `main.ts`: `extractor.start()`.
    - `Home.svelte`: el selector.
    - `package.json`: `youtubei.js`.
  - `src-tauri/tauri.p1.conf.json` solo sirve para arrancar la copia a la vez que la app principal (`npx tauri dev --config src-tauri/tauri.p1.conf.json`: puerto 1430 e identificador `dev.musify.p1`). No hay que integrarlo.
- **Repetir las mediciones:**
  1. Crear la lista de vídeos: `MUSIFY_BENCH_IDS=plan.json cargo test bench_videos -- --ignored --nocapture`.
  2. Añadir a `plan.json` qué medir (`"full": true, "ytdlp": true, "audio": true`; opcional `"survey"`, `"e2e"`).
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
- [x] **Rediseño de la interfaz.** Misma estructura con más profundidad: color de cada página sacado de su carátula, tipografía Figtree incluida, barra superior que se tiñe al hacer scroll, tarjetas con botón de reproducir flotante, accesos rápidos y filas desplazables en Inicio, artista con foto de cabecera y populares, pantalla completa "Sonando ahora" con la cola y esqueletos de carga. Vista previa en el navegador con datos de ejemplo (`npm run dev` fuera de la app; datos en `src/dev`).
- [ ] **Fase 6: Linux y Mac** (en curso)
  - [x] Código adaptado: yt-dlp de cada sistema, formato de audio según el motor web (m4a en Mac, opus en Linux), firma ad hoc en Mac.
  - [x] GitHub Actions compila Windows (.exe), Mac universal (.dmg) y Linux (.AppImage y .deb) al subir una etiqueta `v*` o a mano. Tarda unos 10 minutos (Mac 4, Windows 7, Linux 9). Ojo: el repositorio de código es privado y los minutos de Actions gratuitos son 2.000 al mes; los de Mac cuentan ×10 y los de Windows ×2, así que cada versión gasta unos 65 minutos (unas 30 versiones al mes).
  - [x] Versión 0.1.0 publicada en `musify-releases` con los cuatro instaladores: Windows `.exe` (2 MB), Mac universal `.dmg` (6 MB), Linux `.AppImage` (80 MB, lleva el motor web dentro) y `.deb` (3 MB).
  - [ ] Probar los de Mac y Linux en un equipo real (están compilados, pero no probados).
  - [x] Actualizaciones automáticas (desde la 0.2.0): la app busca versión nueva al arrancar y cada 6 horas en `musify-releases/releases/latest/download/latest.json`, la descarga en segundo plano y la instala al cerrarse (en Windows, instalador silencioso). Si hay una lista, la barra superior muestra «Versión X lista · Reiniciar».
    - Firmadas con una clave propia (minisign). La privada está en `%USERPROFILE%\.musify\` (clave + contraseña) y como secretos `TAURI_SIGNING_PRIVATE_KEY*` en el repositorio de código. **Si se pierde, las apps instaladas no aceptarán más versiones**: hay que guardarla en un sitio seguro.
    - Publicar una versión: subir la versión en `package.json` (y `Cargo.toml`), commit y etiqueta anotada `vX.Y.Z` cuyo mensaje son las notas. GitHub Actions compila, firma, genera `latest.json` (`scripts/release.mjs`) y publica en `musify-releases`.
    - Para que publique solo necesita el secreto `RELEASES_TOKEN` (token con permiso de escritura solo sobre `musify-releases`). Sin él, compila pero no publica, y hay que publicar a mano con `scripts/release.mjs` y `gh release create`.
    - Compilar en local sin firmar: `npm run build:local`.
    - **Probado de principio a fin en Windows (6 oct 2026):** la 0.2.0 instalada encontró la 0.2.1, la descargó en segundo plano y, al cerrarla, se instaló sola en silencio y volvió a abrirse ya en 0.2.1.
- [x] **Música local** (0.3.0): «Tu música» en la barra lateral → «Añadir carpeta» (una o varias). Se leen las etiquetas (título, artista, artista del disco, disco, pista, año, duración, carátula) de mp3, m4a, flac, ogg, opus y wav; si faltan, se sacan del nombre del archivo y de las carpetas (Artista/Disco/01 Canción). Carátulas: la incrustada, la imagen de la carpeta (cover.jpg, folder.jpg…) o la de Deezer; fotos de artista de Deezer. Discos y artistas locales funcionan como los de Deezer (páginas, búsqueda «En tu música», playlists, historial, cola) y suenan desde el archivo, sin YouTube. Escaneo incremental al arrancar; quitar una carpeta quita lo suyo.
  - Probado en la app real con mp3 de prueba (con etiquetas y carátula incrustada, y sin etiquetas).
- [x] **Cola de reproducción tipo DJ** (0.3.0): «Reproducir a continuación» y «Añadir a la cola» en canciones, discos (también clic derecho en las tarjetas) y playlists; lo añadido suena antes de seguir con el disco o la playlist. Panel lateral «Cola» (botón de la barra de reproducción): sonando, tu cola (arrastrar para reordenar, quitar, vaciar), lo que viene; se pueden arrastrar canciones desde cualquier lista. «Guardar como playlist».
- [x] **Protección de la base de datos:** copia completa antes de cada migración (`musify.db.antes-de-vN`, se guardan 3) y la app se niega a crear una base nueva encima de un archivo con datos. (El 6 oct 2026 una prueba en desarrollo dejó la base de datos viéndose vacía; los datos se recuperaron del archivo principal.)
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
