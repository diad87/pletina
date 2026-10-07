# Musify en el móvil: primero Android

Estado: sin empezar. Plan del 6 de octubre de 2026.

## Decisiones
- **Primero Android.** iPhone, más adelante (ver al final).
- **Sin tiendas oficiales ni cuentas de pago.** El APK lo firmamos nosotros, se publica en [musify-releases](https://github.com/diad87/musify-releases) y se instala y actualiza con **Obtainium**.
- **Android Auto y CarPlay, fuera por ahora.** No hay acceso a corto plazo. Se diseña de forma que Android Auto se pueda añadir después sin rehacer nada; CarPlay exige una cuenta de pago de Apple, así que queda descartado.
- **Uso personal**, como el resto del proyecto.

## Qué tiene que hacer la primera versión
- Lo mismo que en el PC: buscar, discos, artistas, biblioteca, playlists, historial y la cola tipo DJ.
- **Seguir sonando con otra app delante y con la pantalla apagada**, también al pasar a canciones que aún no estaban preparadas. Es el requisito que más cuesta y el que se prueba primero.
- Controles en la notificación, la pantalla de bloqueo y los auriculares (bluetooth incluidos).
- Las actualizaciones: la app con Obtainium y los extractores solos (ya hecho, ver `PLAN.md`).
- Para la segunda tanda: música guardada en el móvil y descargas para escuchar sin conexión.

## Qué sirve de lo que ya hay

| Pieza | En Android |
|---|---|
| Interfaz (Svelte) | Sirve. Hay que adaptarla a pantalla táctil. |
| Biblioteca, base de datos y Deezer (`db.rs`, `library.rs`, `deezer.rs`) | Sirven tal cual. |
| Búsqueda en YouTube Music (`youtube.rs`) | Sirve. |
| **Motor propio, nivel rápido** (`native.rs` + receta) | **Es el motor del móvil.** Es Rust puro: no usa la interfaz, ni yt-dlp, ni Tauri, así que puede preparar canciones con la pantalla apagada. Su receta ya se actualiza sola. |
| Extractores que se actualizan solos (`extractors.rs`) | Sirve tal cual. |
| yt-dlp | No existe en Android. Hay que sustituir lo que hace: la búsqueda de respaldo en YouTube normal (pasarla a `youtube.rs`) y las descargas. |
| youtubei.js | Vive en la interfaz, y Android congela la interfaz con la pantalla apagada. Solo sirve como respaldo con la app delante. |
| Ventana oculta (`capture.rs`) | Hecha para WebView2 (Windows) y necesita una página viva. En Android haría falta un plugin propio, y con la pantalla apagada no se sostiene. Fuera de la primera versión. |
| Reproductor (`player.svelte.ts` con `<audio>`) | **No sirve en segundo plano**: el `<audio>` de la interfaz se para cuando Android la congela. La reproducción pasa a ExoPlayer en un servicio (abajo). |
| Plugins de escritorio (instancia única, actualizador de Tauri) | Solo en escritorio. |

## Cómo se monta

```text
Interfaz (Svelte, en la WebView)          Notificación, bloqueo, auriculares
            │  órdenes / estado                        │
            ▼                                          ▼
   Plugin de Musify (Kotlin) ──── MediaSession ──── Servicio de música
                                                   ExoPlayer (Media3)
                                                       │ "¿URL de la canción X?"
                                                       ▼
                                            Núcleo Rust: resolver canciones
                                            (motor propio), biblioteca,
                                            historial, guardar la cola
```

- **La música vive en un servicio, no en la interfaz.** Un `MediaLibraryService` de Media3 en primer plano (tipo `mediaPlayback`, con su notificación) tiene el reproductor (ExoPlayer) y la cola. La notificación, la pantalla de bloqueo, los auriculares y la interfaz son mandos de ese servicio. Se usa `MediaLibraryService` y no el más simple `MediaSessionService` porque es el que necesitará Android Auto: así se podrá añadir sin rehacer el servicio.
- **Las canciones se resuelven al momento de sonar.** Cada canción entra en la cola de ExoPlayer como `musify://track/<id>`. Cuando ExoPlayer va a abrirla, un `ResolvingDataSource` le pide al núcleo Rust la URL de YouTube: el motor propio la busca y la comprueba, y si estaba guardada la reutiliza. ExoPlayer ya prepara la siguiente antes de que acabe la actual, así que la precarga viene incluida, también con la pantalla apagada.
- **URLs que caducan o cambian de red.** Las de YouTube caducan a las pocas horas y van ligadas a la IP. Al pasar de Wi-Fi a datos dejan de valer, así que no basta con reintentar: ante un error de red o un 403, se pide una URL nueva y se sigue desde el mismo segundo.
- **Formatos.** ExoPlayer reproduce opus/webm y m4a, así que la receta actual (opus primero) vale.
- **El núcleo Rust no depende de Tauri.** En Android, el Rust de Tauri lo arranca la pantalla de la app. Si Android cierra la pantalla (o la vuelve a abrir el botón de los auriculares) con el servicio sonando, el servicio tiene que poder arrancar el núcleo él solo: carga la librería, le da la carpeta de datos y lo llama por JNI. Por eso la base de datos, la biblioteca, el motor propio y los extractores se arrancan con su propia función y su propio runtime, y Tauri los usa igual que el servicio. Eso también es lo que pide Android Auto el día que llegue.
- **La cola en Android es la de ExoPlayer.** Ya tiene siguiente, anterior, aleatorio, repetir, insertar, mover y quitar. Lo de la cola tipo DJ se traduce así:
  - «Reproducir a continuación»: insertar detrás de la actual.
  - «Añadir a la cola»: insertar detrás de lo último que añadiste tú, antes de lo que queda del disco o la playlist.

  El historial lo apunta el núcleo cuando ExoPlayer cambia de canción. La cola y la posición se guardan en SQLite, para seguir donde estabas si Android cierra el proceso (`onPlaybackResumption` de Media3).
- **La interfaz es un mando.** `player.svelte.ts` pasa a tener dos motores con los mismos métodos (`playQueue`, `playNext`, `addToQueue`, `toggle`, `next`…): el de escritorio, el de ahora sin tocar, y el de Android, que manda órdenes al plugin y recibe el estado. Al volver a la app, la interfaz pide el estado entero (cola, canción, posición) en vez de fiarse de los avisos que se perdió mientras estaba congelada.
- **Compilar para Android.** Hay que hacer que el Rust compile para Android:
  - lo de escritorio (yt-dlp, actualizador de Tauri, instancia única, ventana oculta, procesos externos) solo se compila para escritorio;
  - `reqwest` tiene que usar `rustls`, porque el TLS del sistema obligaría a compilar OpenSSL para Android.

  Todo se compila en Windows, con Android Studio (SDK, NDK y Java 17). No hace falta Mac.

## Fases

### Fase 0: ¿funciona con la pantalla apagada?
Antes de adaptar nada, se prueba lo que puede tumbar el plan. Hace falta un Android físico con la depuración USB activada.
1. Proyecto Android (`tauri android init`) y el Rust compilando para Android (lo de escritorio separado, `rustls`).
2. Desde el móvil, con Wi-Fi y con datos: el motor propio saca 30 canciones de los discos de prueba y suenan en ExoPlayer.
3. Un servicio mínimo con ExoPlayer y `ResolvingDataSource`, sin interfaz de verdad. Una playlist de 15 canciones nunca preparadas, sonando 60 minutos con la pantalla apagada.
4. A mitad de canción: pasar de Wi-Fi a datos y quitar la cobertura un momento. Recibir una llamada. Quitar la app de recientes.

**Sale bien si** pasa de canción y prepara las nuevas con la pantalla apagada, se recupera al cambiar de red y no se corta en una hora. **Si el motor propio no funciona desde el móvil** (YouTube podría tratar distinto las conexiones móviles), se para aquí: probar otra receta (llega sola) o decidir otro camino, antes de seguir.

**Cómo se hace:** el APK de prueba (rama `android-fase0`) trae un icono aparte, «Musify · prueba», con su pantalla: «Empezar» monta 47 canciones de 4 discos y «Enviar registro» comparte `files/fase0.log`. No hace falta cable. El registro apunta cada canción, lo que tarda en prepararse, la red, los errores, los cierres y una línea por minuto.

**Resultados (6 oct 2026):**
- **Emulador** (Android 15, en el PC): con la pantalla apagada, salta a canciones nuevas (≈1 s cada una). Sin red, espera y sigue sola cuando vuelve, con una URL nueva desde el mismo segundo; pasa de datos a Wi-Fi sin cortarse.
- **Xiaomi del usuario, primera versión:** sonaba (0,85 s para preparar la canción con Wi-Fi) y siguió sin cortes al pasar de Wi-Fi a datos. Pero Android cerró el servicio al minuto y medio, porque no estaba en primer plano (por eso tampoco había controles en la pantalla de bloqueo). Arreglado: la música se arranca con un `MediaController` desde la pantalla de prueba.
- **Xiaomi, segunda versión, 9 minutos con datos móviles:**
  - prepara cada canción en 1,1–1,25 s;
  - ExoPlayer preparó la siguiente minuto y medio antes de que acabara la actual;
  - pasó de canción solo y siguió vivo todo el rato.

- **Xiaomi, tercera prueba, 31 minutos:**
  - 7 canciones seguidas, cada una preparada en 0,8–1,5 s;
  - varios cambios entre Wi-Fi y datos en 20 segundos sin cortarse;
  - pausas y reanudaciones que siempre volvieron a sonar;
  - ningún cierre del servicio;
  - notificación grande con controles (confirmado por el usuario).

  En la segunda prueba hubo una pausa a las 22:21 que no se reanudó; no se sabe si la pidió el usuario. Desde la versión 4 el registro apunta el motivo de cada pausa (botón, otra app o llamada, auriculares), la pantalla encendida o apagada, el ahorro de batería y el reposo profundo de Android.

  Falta confirmar la hora completa con la pantalla apagada.

### Fase 1: el reproductor de verdad
- El núcleo Rust con su propio arranque, usado igual por Tauri y por el servicio.
- El servicio completo:
  - notificación con carátula;
  - pantalla de bloqueo y auriculares;
  - ceder el sonido a llamadas y a otras apps, y pausar al desconectar los auriculares;
  - historial;
  - guardar la cola y volver a ella.
- El plugin con sus órdenes y su estado. `player.svelte.ts` con el motor de Android.
- Tests de la cola tipo DJ en el motor de Android con los mismos casos que el de escritorio, y comprobar que en el PC todo sigue igual.

**Sale bien si** con la interfaz de escritorio tal cual, en el móvil se puede buscar, montar una cola, apagar la pantalla, y al volver ver la cola y la canción correctas.

**Hecho (7 oct 2026, rama `android-fase0`):**
- **Núcleo** (`android.rs`):
  - usa la misma base de datos que la app (`Db` se comparte con `Arc`): vídeos elegidos, elecciones de «¿No es esta canción?» e historial;
  - si el servicio arranca sin la app, la abre él con la carpeta que le da Kotlin (`MusifyCore.init(dataDir)`), carga los extractores guardados y usa el motor propio.
  - JNI: `resolve` (el `player::resolve` de siempre), `recordPlay` y `emit` (avisos a la interfaz).
- **Servicio** (`PlaybackService.kt`):
  - cada canción es una «entrada» de la interfaz (JSON en `mediaMetadata.extras`);
  - apunta el historial a los 30 s;
  - guarda la cola en `files/cola.json` y la recupera al arrancar (en pausa) y al pulsar «play» con la app cerrada (`onPlaybackResumption`);
  - reintenta con URL nueva, espera a que vuelva la red y salta lo que no sale.
- **Puente** (`PlayerPlugin.kt` + `native_player.rs`): órdenes `setQueue`, `insert`, `remove`, `move`, `replace`, `skipTo`, `play`, `pause`, `next`, `previous`, `seek`, `setRepeat`, `setVolume`, `reload` y `state`; eventos `player-timeline` y `player-status`.
- **Interfaz** (`player-android.svelte.ts`):
  - mismo `PlayerApi` que el reproductor de escritorio, así que las pantallas no cambian;
  - la cola tipo DJ va justo detrás de la actual en la cola nativa;
  - el aleatorio reordena solo lo que queda del disco y respeta tu cola; al quitarlo, sigue en orden desde donde iba.
- **Arranque:** en Android lo que se pide a Rust en los primeros instantes se rechaza («not allowed by ACL»). `main.ts` espera a `ipcReady` y `listen` reintenta.
- **Probado en el emulador:** tocar una canción la hace sonar en el servicio; con la pantalla apagada salta y prepara canciones nuevas; al volver, la interfaz enseña la correcta. También funcionan «Añadir a la cola», el aleatorio (activar y quitar), repetir, el historial apuntado por el servicio, «¿No es esta canción?» (cambia el vídeo en el mismo segundo) y matar la app y volver (cola recuperada en el segundo exacto).

### Fase 2: interfaz táctil
- Barra de abajo con Inicio, Buscar y Biblioteca. Minirreproductor siempre visible. «Sonando ahora» y la cola a pantalla completa.
- Pulsación larga en lugar de clic derecho, y nada que dependa de pasar el ratón por encima.
- Reordenar la cola con el dedo: el arrastrar de ahora (HTML5) no funciona con pantallas táctiles.
- Botón «atrás» de Android, zonas seguras (muesca, barra de gestos) y teclado.

**Hecho (7 oct 2026, rama `android-fase0`):**
- **Estructura** (por debajo de 720 px de ancho; el escritorio no cambia): barra de abajo (Inicio, Buscar, Tu biblioteca), minirreproductor encima, «Sonando ahora» y la cola a pantalla completa, y menús que salen desde abajo (también el «¿No es esta canción?»).
- **Con el dedo:**
  - pulsación larga en lugar de clic derecho;
  - lo que en el escritorio sale al pasar el ratón está siempre a la vista o no está: la X de quitar de la cola, el ♥ y el «⋯» de cada canción, y el punto de la barra de progreso;
  - fuera los botones invisibles que se podían pulsar sin querer: el «play» de las tarjetas, solo si ya suena; las flechas de las estanterías.
- **Reordenar** (`lib/reorder.ts`): la cola y las playlists se ordenan arrastrando el asa de la izquierda, con desplazamiento automático cerca de los bordes. El arrastrar de HTML5 se queda para el escritorio.
- **«Sonando ahora»** se cierra deslizando hacia abajo (`touch-action: none`, si no, el navegador se queda el gesto).
- **Android** (`MainActivity.kt`):
  - «atrás» cierra lo abierto o vuelve atrás, y si no queda nada pasa la app a segundo plano sin parar la música;
  - zonas seguras con `MusifyInsets` (el WebView no da `env(safe-area-inset-*)`);
  - iconos claros en las barras aunque el móvil esté en modo claro;
  - con el teclado abierto el WebView se queda encima y la barra de abajo se esconde.
- **Lo que aún no hay en el móvil no se enseña:** importar carpetas y descargas (fase 4), y el selector de motor (solo el propio).
- **Probado en el emulador:**
  - reordenar playlist y cola (el orden llega a la base de datos y al servicio);
  - quitar de la cola;
  - deslizar para cerrar: corto vuelve, largo cierra;
  - botones y barra de progreso con el dedo;
  - buscar con el teclado abierto y al cerrarlo.

### Fase 3: instalar y actualizar
- Clave de firma propia para Android, guardada como la de escritorio (`~/.musify` y secretos de GitHub).
- GitHub Actions compila el APK en cada versión y lo publica en musify-releases (`Musify_X.Y.Z_android.apk`).
- Obtainium apunta a musify-releases y se queda con el `.apk`. En Android 12 o superior puede actualizar sin preguntar; hay que comprobarlo en el móvil.
- Comprobar que actualizar conserva la base de datos.

**Hecho (7 oct 2026, sale en la 0.5.0):**
- **Clave de firma:** `~/.musify/android.jks` (RSA 4096, válida 100 años, alias `musify`) y su contraseña en `android.password`, junto a las del actualizador. En GitHub, secretos `ANDROID_KEYSTORE` (el archivo en base64) y `ANDROID_KEYSTORE_PASSWORD`. Gradle firma las versiones con ella; si falta, el APK sale sin firmar. **Si se pierde, los móviles no aceptan la versión siguiente sin desinstalar**: hay que guardar una copia de `~/.musify`.
- **R8** (reduce el APK de las versiones): reglas para no tocar lo que se busca por nombre (funciones nativas de Rust, el plugin del reproductor y el puente con la interfaz).
- **GitHub Actions** (`build.yml`, trabajo `android`): en cada etiqueta compila el APK, solo ARM de 64 bits (12 MB), y `release.mjs` lo publica como `Musify_X.Y.Z_android.apk`. Si falla solo el APK, lo de escritorio se publica igual.
- **Obtainium:** instrucciones en el README. Basta con la dirección de musify-releases: hay un solo `.apk` por versión y la de los extractores es una versión previa, así que no la toma.
- **En la app:**
  - icono propio, también en escritorio, que hasta ahora llevaba el de Tauri;
  - un solo icono en el móvil: fuera la pantalla de prueba de la fase 0;
  - en «Tu biblioteca», la versión, el aviso de versión nueva (mira el `latest.json` de escritorio y lleva a la página de descarga) y «Enviar registro»;
  - el registro pasa a `files/musify.log`, con tope de 512 KB.
- **De las versiones de prueba a esta:** las de prueba iban firmadas con la clave de depuración del PC, así que hay que desinstalarlas una vez antes de instalar la firmada (Android no deja cambiar de firma). A partir de ahí, todas se instalan encima.
- **Probado en el emulador:**
  - la versión firmada desde cero: arranca, busca, suena en el servicio y comparte el registro;
  - el APK de GitHub instalado encima del firmado en el PC: Android lo acepta como actualización y conserva historial y cola;
  - con la 0.5.0 ya publicada, la 0.4.0 avisa de que hay versión nueva, y el APK de musify-releases se instala encima conservando historial y cola;
  - en escritorio, la app de verdad (con otro identificador para no tocar la instalada): busca y suena.
- **Falta en el móvil:** instalar Obtainium, añadir la app y comprobar que la versión siguiente se instala sola.

### Fase 4: música del móvil y sin conexión
- Música guardada en el móvil: lista de Android (`MediaStore`, permiso de audio), con las mismas carátulas y la misma agrupación que en el PC.
- Descargas sin yt-dlp: el núcleo baja por trozos la URL del motor propio a la carpeta de la app. Sirve también para el PC (está pendiente en P1).
- Modo avión: biblioteca, música local y descargas.

**Hecho, descargas y sin conexión (7 oct 2026, sale en la 0.6.0):**
- **Descargar sin yt-dlp** (`direct.rs`): la URL del motor propio, a trozos de 10 MB (YouTube frena las descargas de una sola petición), en un `.part` que se retoma donde iba. Si la URL caduca o YouTube la corta, se pide otra y se sigue en el mismo byte. El formato es el que da YouTube, normalmente opus en `.webm`. En el escritorio sigue yt-dlp.
- **Dónde:** `descargas/Artista/Disco/Canción.webm` dentro de la carpeta de la app (sin permisos; se borra al desinstalar), y la carátula de cada disco en `descargas/_portadas/<disco>.jpg`.
- **Con la app cerrada** (`DownloadService.kt`): mientras hay descargas, un servicio en primer plano (tipo `dataSync`) mantiene viva la app y enseña el progreso en una notificación. Pregunta cada segundo al núcleo cómo van (`MusifyCore.downloads()`) y se para solo al acabar. La primera vez se pide permiso para las notificaciones.
- **Sin conexión:**
  - `resolve` ya daba el archivo descargado antes que nada;
  - si una canción no está descargada y no hay red, el servicio salta a la siguiente descargada (`MusifyCore.isDownloaded`) y avisa, en vez de esperar a la red;
  - la notificación y la pantalla de bloqueo usan la carátula guardada;
  - en la interfaz, las carátulas salen de la caché del WebView (Deezer las deja guardar 150 días), y lo que necesita internet dice «Sin conexión» con un botón a Descargas.
- **En la interfaz:** lo mismo que en el escritorio (⬇ en discos y playlists, «Descargar» en el menú de cada canción, «Descargas» en Tu biblioteca), sin lo de elegir o abrir carpeta.
- **Probado en el emulador:**
  - dos discos (27 canciones, 79 MB) con la app en segundo plano: 26 s el primero, y el servicio se para solo;
  - en modo avión, desde cero: arranca, «Descargas» suena;
  - una playlist mezclada salta a las descargadas;
  - la pantalla de bloqueo, con carátula;
  - buscar dice «Sin conexión».
- **Falta:** la música guardada en el teléfono (`MediaStore`) y, quizá, descargar solo con wifi.

## Pruebas antes de darla por buena

| Prueba | Tiene que pasar |
|---|---|
| 60 minutos con la pantalla apagada, 10 cambios de canción o más | Sigue sonando y prepara canciones que no estaban preparadas |
| Otra app delante, volver a Musify | Un solo reproductor; cola y posición correctas |
| Controles de bloqueo, notificación y auriculares | Hacen lo que dicen, sin saltos perdidos ni sonidos duplicados |
| Llamada y otra app con sonido | Cede el sonido y vuelve; si pausaste tú, no vuelve sola |
| Wi-Fi → datos, sin cobertura un rato, URL caducada | Sigue en la misma canción y el mismo segundo |
| Quitar la app de recientes sonando; reiniciar el móvil | Se para o sigue según Android, y al volver está la cola |
| Ahorro de batería del fabricante | Anotar lo que pase en tu móvil; no pedir que se desactive como solución |
| Actualizar con Obtainium | Se conservan biblioteca, playlists e historial |
| Modo avión | Música local y descargada sonando, biblioteca navegable |

## Más adelante
- **Android Auto**, cuando haya acceso: el servicio ya será un `MediaLibraryService`. Faltaría:
  - publicar la biblioteca por carpetas (Favoritos, Playlists, Recientes, Descargadas);
  - declarar el soporte en el manifiesto;
  - con un APK que no viene de Google Play, activar «Orígenes desconocidos» en los ajustes de desarrollador de Android Auto.
- **iPhone, gratis:**
  - Se instala con **SideStore** y un Apple ID normal: la app se firma en el propio iPhone. Con una cuenta gratis la firma dura 7 días; SideStore la renueva desde el propio iPhone y se puede automatizar con Atajos.
  - El audio con la pantalla apagada no necesita cuenta de pago: es un permiso normal de la app. Con AVPlayer y el mismo núcleo Rust, pidiendo m4a, porque AVPlayer no reproduce opus/webm.
  - Hay que comprobar que GitHub Actions (macOS) puede compilar la app sin firmar, para no necesitar un Mac. Y hace falta un iPhone para probarla.
  - Sin CarPlay: exige una cuenta de pago.
- **Sincronizar con el PC** (favoritos, playlists, historial y vídeos elegidos), cuando el reproductor del móvil sea estable. Sin URLs de YouTube (caducan) ni rutas de archivos.

## Riesgos
- **Que YouTube no sirva al motor propio desde el móvil.** Se ve en la fase 0. Sin el motor propio en segundo plano, solo quedarían youtubei.js y la ventana oculta, que necesitan la app delante.
- **Ahorro de batería de algunos fabricantes** (Xiaomi, Samsung, Huawei…), que cierran servicios aunque estén en primer plano. Se prueba en el móvil que se vaya a usar.
- **Condiciones de YouTube:** reproducir su audio fuera de su reproductor va contra ellas, igual que en el PC. Es para uso personal y no se publica en tiendas.
