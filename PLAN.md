# Pletina — Plan

Pletina se llamaba Musify hasta la 0.7.0 (7 oct 2026); los repositorios pasaron a `diad87/pletina` y `diad87/pletina-releases`, y GitHub redirige las direcciones viejas. Los nombres internos (identificador `dev.musify.desktop`, `musify.db`, el crate `musify`) no cambian, para que las instalaciones sigan actualizándose sin perder la biblioteca.

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
7. **Móvil: primero Android.** APK propio, sin tiendas ni cuentas de pago, instalado y actualizado con Obtainium. La misma interfaz (Tauri), pero la música suena en un servicio de Android con ExoPlayer, para que siga con la pantalla apagada, y el audio sale del motor propio, que es Rust y no necesita la interfaz. iPhone más adelante, gratis (SideStore). Android Auto y CarPlay, fuera por ahora. Plan completo en [docs/plan-mobile.md](docs/plan-mobile.md).

### Actualizaciones automáticas en todas las plataformas
Requisito: se instala el "cascarón" una vez y, al publicar una versión en GitHub, se actualiza solo, sin que el usuario haga nada. Todas las actualizaciones van firmadas con una clave propia; la app rechaza cualquier versión sin esa firma. GitHub Actions compila y publica todo al subir una versión.

Tres capas:
1. **Extractores (hecho, 0.4.0):** lo que saca el audio de YouTube se actualiza por separado, cada pieza desde su fuente y sin tocar el resto de la app. Ver "Extractores que se actualizan solos" más abajo. En Android funciona igual, porque lo baja y lo comprueba la parte de Rust. Allí lo que importa es la receta, que es lo que usará el motor del móvil; youtubei.js y la ventana oculta solo funcionan con la app delante.
2. **Contenido (la interfaz):** se descargaría de GitHub en segundo plano y se aplicaría al volver a abrir la app. Requiere servir la interfaz desde una carpeta local en lugar de llevarla dentro del ejecutable; está sin hacer.
3. **Cascarón (el ejecutable, cuando cambia la parte de Rust):**
   - Windows, Mac, Linux (AppImage): actualizador oficial de Tauri. Descarga en segundo plano e instala al cerrar la app. Totalmente silencioso.
   - Android: sin Google Play (decidido; además incumple sus normas por usar YouTube). APK firmado con clave propia y publicado en pletina-releases; **Obtainium** lo vigila y lo instala. En Android 12 o superior puede actualizar sin preguntar; está por comprobar en el móvil.
   - iOS (más adelante): sin App Store ni cuenta de pago (decidido). Con **SideStore** y un Apple ID gratis, la firma dura 7 días y se renueva desde el propio iPhone. Actualizar el cascarón pide un toque.

### Extractores que se actualizan solos
Cada extractor se actualiza desde su fuente, sin reinstalar ni actualizar el resto de la app:

| Extractor | De dónde sale | Cómo llega a la app |
|---|---|---|
| yt-dlp | sus versiones en GitHub (yt-dlp/yt-dlp) | la app lo actualiza una vez al día (`yt-dlp -U`) |
| youtubei.js | npm | GitHub Actions mira cada día si hay versión nueva; si pasa las pruebas, la pone en `main`, la empaqueta con nuestro código (`youtubei.ts`) y la publica |
| Receta del motor propio | este repositorio (`src-tauri/recipe/youtube.json`) | se publica al subir el cambio a `main` |
| Script de la ventana oculta | este repositorio (`src-tauri/src/capture.js`) | se publica al subir el cambio a `main` |

- **Publicación** (`.github/workflows/extractors.yml` y `scripts/extractors.mjs`): en la versión `extractores` de diad87/pletina-releases (marcada como "pre-release" para que no la tome el actualizador de la app). Cada extractor va como `<nombre>-api<api>-v<versión>.<ext>`, firmado con la misma clave que las actualizaciones de la app, y un índice, `extractores.json`.
- **En la app** (`src-tauri/src/extractors.rs`): al arrancar y cada 6 horas mira el índice. Si hay un extractor con la `api` que entiende y una versión mayor que la suya, lo baja, comprueba el resumen y la firma, y lo usa desde ese momento: la receta y el script en la siguiente canción, y youtubei.js en cuanto vuelve a hacer falta. Lo guarda para los siguientes arranques.
- **Seguridad:** la firma cubre también el nombre del archivo (extractor, api y versión). Nadie puede hacer pasar un extractor viejo por uno nuevo tocando el índice, ni colar uno sin la clave.
- **Si el nuevo falla**, se sigue funcionando:
  - Receta: si no se entiende o no es de YouTube, no se usa; si con ella no sale el audio, se prueba la incluida y después la ventana oculta.
  - youtubei.js: si el módulo no carga, se usa el incluido; si no saca el audio, yt-dlp.
  - Script de la ventana oculta: no tiene respaldo automático. Si uno sale mal, se arregla publicando otro.
- **`api` y `version`** (en `src-tauri/extractors.json`): al cambiar un extractor hay que subir su `version` (si no, `scripts/extractors.mjs` se niega a publicarlo). Si cambia cómo habla con la app (lo que espera de Rust o de la interfaz), se sube su `api` aquí y en `API` de `extractors.rs`, y ese extractor nuevo solo lo usan las apps que ya lo entienden. Las más viejas siguen con el último de su `api` hasta que se actualiza la app.
- **Lo que no se puede cambiar así:** el código en Rust del motor propio (`native.rs`, `capture.rs`) y cómo se elige el motor (`extractor.rs`). Eso necesita una versión de la app, que en escritorio también se instala sola.
- **Móvil:** el mismo sistema sirve en Android e iOS, porque el que baja y comprueba es Rust. Con la pantalla apagada solo cuenta la receta del motor propio (Rust); youtubei.js y la ventana oculta necesitan la interfaz viva. yt-dlp no existe allí. Ver [docs/plan-mobile.md](docs/plan-mobile.md).
- **Probado** (6 oct 2026, en el entorno aislado de Claude, ver "Estado"):
  - con un canal local con la versión 2 de los tres, la app los cambió solos;
  - tras reiniciar sin conexión al canal, siguió usando los guardados;
  - sonaron 2 de 2 canciones con youtubei.js descargado y 2 de 2 con la receta descargada;
  - la ventana oculta, con su script descargado, copió una canción entera.
- **Probar sin publicar:** `node scripts/extractors.mjs --to <carpeta>` y arrancar la app con `MUSIFY_EXTRACTORS_URL=<carpeta>`.

### Proyecto paralelo P1: extractor de YouTube sin yt-dlp
yt-dlp es un programa de escritorio en Python: no funciona en Android ni en iOS. Hay que llevar su trabajo (buscar y sacar la URL del audio) a algo que funcione en todas partes. Se desarrolla en paralelo, en su propia rama, sin bloquear las fases 4–6.
- **Estado (24 de octubre de 2026):** la evolución de captura está aislada en `p1-oficial`, worktree `C:\Users\iunan\musify-oficial`. [Pletina 0.12.0 está publicada](https://github.com/diad87/pletina-releases/releases/tag/v0.12.0), etiqueta en `9f54f4c`: integra `v0.11.2` y `origin/main` `1868d4f`, conservando sus funciones y recuperación de reproducción y descargas. El snapshot inicial API 2 fue `f4868be`; ahora captura usa v25/API4. Se elige entre yt-dlp, youtubei.js, Propio (recomendado) y Oficial (experimental en Windows). yt-dlp sigue siendo el predeterminado en escritorio. Se publica con autorización del usuario, sin fusionar ni hacer push a main ni OTA separada de extractores. Windows, macOS, Linux y Android compilan y firman; los archivos públicos, firmas, procedencia e índice del actualizador están verificados. Falta `RELEASES_TOKEN` para futuras subidas automáticas; esta se completó con la sesión local de GitHub. youtubei.js general pasa a 18.3.0; el descifrador privado conserva sus dependencias fijadas y assets idénticos a R15. Las mediciones R15 preceden a esta integración. El [plan P1](docs/plan-captura-youtube.md) recoge la tabla de comprobaciones y límites.

#### Plan de evolución del motor propio

**Criterio vigente del usuario:** los 3,5 s son una referencia para el arranque frío; se acepta cualquier avance pequeño que sea medible y repetible, sin relajar las garantías de identidad, audio original, aislamiento ni límites. Cada mejora debe indicar qué etapa mide: un ahorro local o una llamada IPC menos no acredita por sí solo un menor arranque total. Este criterio no promueve Oficial ni cambia los resultados históricos.

La prioridad acordada es que **Propio siga como camino recomendado**, con el nivel rápido Rust sin sesión y la captura oficial como respaldo frente a cambios de la API, conservando el objetivo de no entregar anuncios. yt-dlp sigue predeterminado. El [plan de captura oficial](docs/plan-captura-youtube.md) recoge las decisiones y criterios nuevos, todos medidos sin Premium; Premium se usa sólo como referencia en un perfil separado y con acceso manual del usuario.

La app puede publicarse con Oficial experimental antes de cumplir las metas de promoción; la progresiva nueva continúa limitada al banco y Propio conserva Legacy. El empaquetado local v25/API4 se comprobó sin firmar ni publicar. La integración con `origin/main` conserva Pletina 0.9.1, el canal `diad87/pletina-releases`, Spotify, podcasts, Android y SHA256SUMS/procedencia. Adapta la coordinación P1 a la cola y reproducción móvil de main; en móvil la captura oficial responde explícitamente que no está disponible. Publicar sólo el script no lleva la mejora Rust/lector a una app API1. Los [detalles](docs/informe-captura-youtube-2026-10-08.md) separan esta integración de la promoción y de un instalador listo para distribuir.

API4/captura v25 incorpora clic nativo WebView2 sobre el botón oficial revalidado, retención experimental configurable de1,5s, dos precargas paralelas con prioridad para la actual y límites de memoria explícitos. El certificado EOF y los índices de paquetes distinguen la cuantización de1ms de un paquete perdido sin rellenar huecos entre saltos. El banco compara todos los bytes publicados con audio nativo del mismo vídeo, mediante paquetes exactos o PCM estricto con FFmpeg; conserva el diario fuera de Git incluso al expulsar caché. Receta y youtubei.js no cambian. La captura nueva permanece a1×; los anuncios se omiten con el botón, sin bloquearlos ni acelerarlos. Rust impone y confirma el silencio nativo de cada ventana de adquisición antes de navegar, también en Legacy y el acceso manual, sin silenciar el reproductor principal. Si el arranque pierde una observación antes de publicar audio, sólo se permite una repetición en la misma fuente: se descarta la cobertura anterior, se espera pausado un cero nativo estable y se verifica de nuevo todo el recorrido.

**Estado: validación API4 ejecutada el7–8 de octubre, no aprobada para promoción.** Propio resolvió30 búsquedas frías sin fallback, en445–1.649ms: no cumple300ms. En la escucha completa hubo29 resoluciones rápidas y un respaldo histórico por visitante ausente;30 finales naturales,0 esperas y25 transiciones de3,7–13,2ms, que cumplen100ms. La campaña específica sin sesión alcanzó50 transiciones publicitarias acreditadas en55 intentos,13 clics nativos confiables y12 omisiones correlacionadas antes del final conocido;0 discrepancias en todo lo publicado, pero arranques residuales de3,634–6,014s. Los30 saltos no capturados al80% tardaron2,003–2,270s y los30 cambios fríos4,103–4,972s más anuncios: no cumplen las metas nuevas. Los cinco discos Oficiales bajo estrés registraron25 esperas y cuatro plazos agotados. El rechazo del último AAC de Sucede se corrigió con muestras exactas y una repetición cerró8069/8069 paquetes, sin cortes. El control del silencio nativo verificó el audio completo, pero tuvo cinco cortes. Premium quedó aparte: dos canciones completas sin anuncios, inicio5,391s, siguiente8,2ms, seek2,106s y cambios fríos4,135–4,392s; no contribuye a aprobar. El [informe](docs/informe-captura-youtube-2026-10-07.md) conserva tabla por canción, anuncios, procedencia, fallos y commits. Las evidencias anteriores se trasladaron a `capture-evidence.local/legacy-2026-10-07/`, ignorada por Git, con32 hashes verificados; en docs queda un [resumen](docs/evidence/capture-2026-10-07/README.md).

**Continuación del8 de octubre, v20:** las pausas del reproductor oficial cada100ms provenían del consentimiento inline de YouTube. El adaptador pulsa un único «Rechazar todo» visible y habilitado en el diálogo conocido ES/EN, admitiendo su etiqueta accesible descriptiva; mientras esté abierto no fuerza play ni acredita canción. La suspensión invalida también el intervalo menor de500ms y el EOF previo a detach; sólo una fuente limpia sin publicar puede repetirse desde cero. En v19, PRESO cerró con0 cortes,2035/2035 paquetes coincidentes y reloj estable1×, pero inicio5,575s sin anuncio. ROSALÍA también en v19 cerró6/6 completas,50343/50343 paquetes coincidentes,0 cortes y cinco cambios de1,5–3,6ms con una instancia y sus dos precargas. Consumió41,440s de publicidad en segundo plano, con4 omisiones operativas tras clics confiables; el inicio frío sin anuncio6,464s sigue fallando. El [diagnóstico](docs/informe-captura-youtube-2026-10-08.md) conserva también los intentos fallidos y la procedencia. Continúa como experimento progresivo, sin cambios1×/N1,5/API4.

El control final v20 Airbag→Preso cerró2/2 completas,16430/16430 paquetes coincidentes,0 cortes y transición6,6ms; primer sonido6,008s sin anuncio. Preso recuperó una presentación descartada con0 unidades y consumió5,084s de anuncio en precarga tras clic nativo. Propio/Preso confirmó Rust sin fallback, búsqueda incluida736ms y final natural sin cortes: falla300ms. Tres cambios sin audio en caché tardaron4,126–4,404s más publicidad observada (124/124 paquetes históricos, sólo prefijos); seek80% no capturado2,089s correcto funcionalmente pero falla1s (100/100 paquetes, sin EOF). Son7 canciones distintas comprobadas en las tandas nuevas completas, no30.

Para promover quedan pendientes30 canciones completas sin discrepancias ni cortes, las metas de arranque/salto y una cota independiente del retraso de señal que permita fijar N. El banco distingue URL nativa de Legacy mediante el tipo real de fuente y acepta priming AAC negativo sólo al comprobar que el consumidor cubre [0,duración]; los raws previos no se reescriben. El modo normal sigue reteniendo la fuente completa y Propio conserva el respaldo histórico. Un margen finito no elimina el caso controlado de señal retrasada más allá de ese margen; los criterios son empíricos, no una garantía absoluta.

**Control de latencia v21 del 8 de octubre:** se reutilizan cálculos del inventario sin cachear las puertas de seguridad, se elimina la espera fija de 300 ms al cerrar y el lector exige 0,5 s continuos antes de adoptar un salto. Dos retiros reales tardaron 30,3/31,0 ms incluyendo auditoría. Preso cerró completa sin cortes con 2035/2035 paquetes coincidentes, pero inició en 5,535 s. De Aquí No Sales cambió en 2,1 ms y terminó sin cortes, con un anuncio omitido tras clic nativo y 5,238 s consumidos en precarga; sus 20 verificaciones fallaron por referencia ausente, por lo que no se acredita comparación independiente. El seek nuevo tardó 2,375 s, con 111/111 paquetes de prefijos; el destino tenía 540 ms aceptados, pero sigue habiendo espera del origen. La auditoría ya observa todos los paquetes de Preso, sin anuncios allí; aún no mide retraso independiente publicitario. 343 pruebas JavaScript y 100 Rust aprobadas, 13 Rust ignoradas. El [informe actualizado](docs/informe-captura-youtube-2026-10-08.md) conserva los fallos. Sigue sin promoción ni sustitución de Legacy; falta replanificar el productor tras volver a caché parcial desde otro seek enviado.

**Continuación v22–v25 del 8 de octubre:** el supervisor replanifica el productor al volver a caché parcial y bloquea respuestas obsoletas. El núcleo conserva los bytes originales entre seeks, incluyendo clusters pendientes y relleno WebM fuera de orden con duplicados idénticos. Tras tres fallos registrados, v25 mantuvo 8,002 s continuos al volver: adopción local 0,6 ms, reloj retomado 90,7 ms, 121 unidades/528 paquetes coincidentes, sin espera de escucha. La vista parcial ingirió el relleno pero el ensayo no llegó a escuchar sus paquetes nuevos; tampoco acredita EOF ni permite liberar la cola de N. El control completo Preso→De Aquí v25 cerró 9263/9263 paquetes, cero discrepancias y cortes, siguiente 4,6 ms e inicio frío 6074 ms; no tuvo anuncios. El control v24 de ambas vio dos fuentes publicitarias, una transición acreditada y una omisión correlacionada tras clic confiable, con 11019 ms en precarga. La cota independiente del marcador sigue sin medirse.

Propio/v25 resolvió 30/30 búsquedas frías por Rust con vídeo esperado y ningún respaldo: mínimo 435,7 ms, mediana 548,9 ms, máximo 1318,4 ms; ninguna cumple 300 ms y esta tanda no prueba 30 canciones hasta EOF. Rust valida ahora la estructura del visitante, admitiendo los tokens válidos que no empiezan por `Cgt`; no se atribuye a este bug el fallo histórico sin diagnóstico específico. El salto al 80 % no preparado tardó 2461,7 ms, con 560 ms de reserva en destino y 117/117 paquetes de prefijos, pero cortó el origen durante 1916,1 ms. 374/374 tests JavaScript, 109 Rust aprobados/13 ignorados, tipos y build Windows correctos. El [informe actualizado](docs/informe-captura-youtube-2026-10-08.md) conserva fallos, límites y commits. Faltan las metas frías, continuidad del origen, cierre verificable de la vista parcial y la cohorte conjunta de 30 canciones/50 transiciones. Sin uso nuevo de Premium, promoción, push, fusión ni publicación; N=1,5 s, 1×, yt-dlp predeterminado y Rust→Legacy en Propio se conservan.

**Integración con main 0.9.1 (8 de octubre):** tipos y build Vite correctos, 374/374 pruebas JavaScript y 139 Rust aprobadas/19 ignoradas en Windows; `cargo check --lib` y `--tests` Android x86_64 offline correctos. Las reaperturas JNI de ExoPlayer no cancelan la selección manual ni la precarga P1, comprobado con una regresión sin red. No se repitieron campañas reales ni Premium ni se preparó un instalador. La integración no promueve la progresiva ni aprueba los objetivos pendientes.

**Propio adaptativo (8 de octubre, implementado):** la búsqueda descubre WEB_REMIX y renueva datos obsoletos; el audio conserva su ruta rápida y añade WEB descubierto antes de Legacy. Configuraciones y peticiones idénticas se reutilizan y los rechazos estructurales abren un circuito temporal, sin deshabilitar un cliente por un vídeo privado o un fallo CDN. Pasan 165 pruebas Rust (20 ignoradas); la renovación y las sondas inválidas se comprobaron con transporte HTTP local. El descubrimiento real sin sesión obtuvo Music y WEB en 187,8 y 108,6 ms; Android x86_64 pasa `cargo check --tests`. En la app, 30/30 búsquedas y arranques usaron VISIONOS, con vídeo correcto y ningún respaldo: mínimo 456,5 ms, mediana 653,4 ms, máximo 1200,5 ms, 0/30 cumplen 300 ms. Este banco no ejercitó WEB ni comprobó EOF o publicidad. WEB probado aparte rechazó 3/3 vídeos que VISIONOS sí reproduce; no acredita reemplazarlo. La receta VISIONOS aún puede necesitar una reparación; el descubrimiento web no resuelve cambios de protocolo, firmas o SABR. El [diseño](docs/propio-adaptativo.md) y el [informe](docs/informe-captura-youtube-2026-10-08.md) detallan el alcance. La progresiva Oficial sigue pendiente de aprobación.

**Contenido infantil (23 de octubre, tres casos comprobados):** Propio descubre WEB_EMBEDDED_PLAYER y las funciones de firma/`n` del reproductor actual, con análisis local y ejecución limitada en QuickJS. Sólo se activa tras confirmar el vídeo y su aviso infantil público; exige audio original (explícito cuando hay pistas etiquetadas) y un rango 206 exacto al 80 %. La disponibilidad CDN temporal permite ahora hasta ocho intentos dentro de ocho segundos, conservando URL e identidad y deteniéndose ante 429. Una respuesta SABR sin localizadores permite renovar una vez, sólo si cambia la petición efectiva, con deduplicación de 30 s. Esta recuperación se ejercitó realmente en Maite Zaitut!.

La app `540521e` inició Epoitaitaye, Maite Zaitut! y Pupu Eta Lore por Native sin Legacy, en 14,2 / 4,9 / 1,7 s incluida búsqueda; la primera revisión había necesitado Legacy para Epoitaitaye por `CIPHER_MISSING`. Los tres archivos completos coinciden byte a byte con referencias yt-dlp/251 y FFmpeg los decodifica sin errores. La app comprueba inicio, salto al 80 % y cola, no escucha continua completa. Las 30 canciones de regresión conservan audio Native sin respaldos, mediana 592 ms (464–1005 ms). Ninguna fila cumple 300 ms: el análisis en frío sigue siendo caro.

Pasan 196 pruebas Rust; Android x86_64/arm64 compila. El mismo decoder pasó seis pruebas y cuatro firmas de referencia en Android 15 x86_64 con los límites originales, preparando en 10,9 s; no es prueba de JNI, ExoPlayer o ARM físico. El nivel rápido conserva su prioridad, Legacy sigue en Windows y yt-dlp sigue predeterminado. No se modifican db.rs, downloads.rs, interfaz visual, receta ni scripts OTA. La mejora necesita una app nueva y la PWA su integración web equivalente. El [informe infantil](docs/informe-contenido-infantil-2026-10-23.md) conserva fallos, hashes, commits y pendientes; no promueve la progresiva Oficial ni acredita todo el catálogo o anuncios vistos/saltados.

**Arranque frío (23 de octubre, primera ronda):** `8983e26` solapa el POST con el análisis validado, conserva decoders entre reinicios con caché acotada y usa QuickJS C O2 en release. La preparación offline bajó de mediana 7804 a 6604 ms; debug ya usaba O2. La tanda directa con FreshDecoder tardó 7525/7606/1252 ms: Pupu reutilizaba memoria, no era un primer arranque. La caché de disco redujo la preparación a 115 ms al reiniciar, pero la disponibilidad CDN mantuvo el total en 7530/7423/1224 ms. Las seis búsquedas infantiles y las 30 habituales usaron Native sin Legacy; todas incumplen 300 ms. La regresión de 30 dio mediana 587,55 ms. Los tres archivos completos siguen siendo idénticos a las referencias, sin acreditar escucha continua en la app ni anuncios vistos/saltados. Pasan 207 pruebas Rust, 387 JavaScript y checks Android arm64/x86_64. El [informe de arranque frío](docs/informe-arranque-frio-2026-10-23.md) separa el control, el candidato y sus hashes; sin publicación ni promoción de Oficial.

**Arranque frío, segunda ronda (`0aa9e1c`):** el analizador calcula sólo dependencias necesarias, conservando exactamente script, ST y cuatro firmas/`n` de referencia. El harness QuickJS final baja a 3887,7 ms, sin ampliar límites. Con un vídeo por proceso, las extracciones pasan de 7617/14160/7667 a 4848/5376/4376 ms; el total nuevo IPC→`playing` es 4979/5504/4499 ms, sin búsqueda. El control anterior no medía ese total. Todos son bancos debug, Native/251 y sondas/inicio/salto/cola correctos; no escucha completa. Descubrimiento gzip acotado y ocho turnos CDN mejoran la oportunidad de empezar, sin atribuir un 403 a anuncios. Con búsqueda y decoders reutilizados, los tres casos dieron 5926/5550,9/1492 ms. La regresión conservó 30 Native y cero Legacy, mediana 612,4 ms, pero sólo 29 IDs esperados: Octopus's Garden eligió otro ID y se conserva el fallo. Todas las filas superan 300 ms. El usuario acepta mejoras sustanciales; 3,5 s totales siguen pendientes. Pasan 400 pruebas JavaScript, 210 Rust (27 ignoradas) y tipos sin avisos; el [informe](docs/informe-arranque-frio-2026-10-23.md#ronda-2-preparación-selectiva-y-arranque-realmente-frío) conserva procedencia y límites. No cambia la aprobación de Oficial ni se publica una app o receta.

La segunda ronda también repitió los tres archivos completos, idénticos a las referencias y con decodificación sin errores. El harness Android 15 x86_64 pasó seis pruebas y cuatro formatos exactos: preparación 6747,1 ms frente a 10911,5 ms en una réplica por versión, con límites intactos. Los checks arm64/x86_64 pasan; no se ejecutaron app Android, JNI, ExoPlayer ni ARM físico.

**Arranque frío, tercera ronda (`bef47a7`):** dos operaciones del parser privado reducen la preparación QuickJS de 4026,4 a 3798,1 ms en un par serial (5,7 %), sin cambiar salida ni presupuestos. El generador detiene una deriva de versiones/opciones; el banco restaura correctamente variables ausentes y comparte un reloj de diagnóstico. No se acredita una mejora estable del total: control frío 6/6 Native frente a 4/6 del candidato, con dos fallos `SABR_ONLY`. La primera comparación se invalidó por un flag vacío que activaba otro calendario y se conserva separada. Dieciséis sondeos duplicaron solicitudes sin ganancia estable y se retiraron; siguen ocho. La prioridad es diagnosticar y recuperar SABR, después reducir más el parser y medir 3,5 s infantiles. Pasan 430 pruebas JavaScript, 210 Rust (27 ignoradas), tipos y checks Android; el harness móvil conserva cuatro formatos exactos, pero su única réplica de 7073,8 ms no acredita mejora. La primera descarga completa fue 2/3; una réplica diagnóstica obtuvo 3/3 idénticos y decodificables sin borrar el fallo inicial. Sin nueva campaña de anuncios ni Premium. El [informe](docs/informe-arranque-frio-2026-10-23.md#ronda-3-parser-acotado-controles-y-fallos-conservados) conserva tablas y hashes.

**Criterio provisional aceptado por el usuario:** unos **600 ms para el camino rápido habitual**. La nueva tanda da 30/30 Native e IDs correctos, mediana 630,85 ms y rango 474,1–1218,1 ms. No es un máximo garantizado por canción; 300 ms queda como aspiración y los raws conservan el umbral anterior. La aceptación provisional no promueve Oficial ni cumple los 3,5 s infantiles. Antes de publicar queda integrar `origin/main` `1868d4f` y revisar youtubei.js 18.3.0 frente al bundle privado fijado a 18.1.0. No cambia la PWA ni se publican scripts OTA.

**Arranque frío, cuarta ronda (`3fa0237`):** el POST público de metadatos se adelanta a la confirmación watch; su resultado y sus errores permanecen retenidos hasta validar MFK/ID/estado/embed y ST completo. No cambia el parser ni el calendario CDN. Los diagnósticos correlacionan POST/renovación sin guardar URLs, visitantes ni firmas. Dos intentos por canción/binario dieron 6/6 Native del candidato frente a 5/6 del control: Epo pasó de mediana 5284,5 a 4658,5 ms, pero red y SABR impiden atribuir toda la diferencia al cambio. Pupu necesitó 9813 ms al recuperar SABR con otro reproductor; no se acredita mejora universal ni 3,5 s. La regresión habitual conserva 30/30 Native e IDs correctos, mediana 642,15 ms; en la tanda infantil con búsqueda Pupu sí necesitó Legacy tras dos SABR. Se descartaron un parser WASM más lento y un ajuste GC sin mejora sustancial. Pasan 217 pruebas Rust (27 ignoradas), 430 JavaScript, tipos y checks Android sin avisos nuevos. El [informe](docs/informe-arranque-frio-2026-10-23.md#ronda-4-anticipo-de-metadatos-y-diagnóstico-sabr) conserva todos los intentos. Sigue pendiente reducir el análisis frío y la recuperación; sin publicación ni promoción de Oficial.

**Arranque frío, quinta ronda (`80100dd`, en evaluación):** una respuesta SABR admitida permite descargar la alternativa durante AST1 y cancelarlo sólo cuando otra fuente y un cambio independiente del ST justifican reemplazarlo. Fuente idéntica reutiliza AST1; un cambio sólo de reproductor conserva la recuperación secuencial con ST completos. Una renovación, dos POST y un plazo compartido de 12 s, incluidas colas, descargas y análisis; sin adelantar consumo, descifrado o CDN a la verificación. El primer control real canceló AST1 y empezó en 6279 ms, sin control equivalente para atribuir una ganancia. Los 24 A/B pasan (12/binario), pero ninguno de los 12 candidatos activó esa recuperación: medianas Epo 4508→4519, Maite 4532,5→4541,5 y Pupu 4507,5→5090 ms. No se acredita mejora sustancial ni se repite la tanda para escoger resultados favorables. Las 30 habituales conservan Native, cero Legacy e IDs correctos, mediana 703,1 ms; Epo infantil con búsqueda necesitó Legacy por `NATIVE_EMBEDDED_CONFIG`. Los tres archivos completos coinciden con las referencias y decodifican sin errores. Pasan 226 Rust (27 ignoradas), 430 JavaScript, tipos y ambos checks Android sin avisos nuevos. Acorn y ajustes de posiciones se descartaron por rendimiento. El [informe](docs/informe-arranque-frio-2026-10-23.md#ronda-5-renovación-temprana-y-presupuesto-compartido) conserva intentos, diagnóstico y procedencia. Siguen pendientes 3,5 s infantiles y medir una mejora estable; sin publicación ni promoción de Oficial.

**Arranque frío, sexta ronda (`093bb35`–`ab50207`):** se corrige la admisión de versiones oficiales canary y se recupera una configuración inválida una sola vez, sin relajar identidad ni límites. Clang/dispatch directo y especializaciones del parser reducen la preparación en controles aislados; la primera resolución foreground adelanta dos GET públicos acotados. En la comparación final, con búsqueda y un proceso anónimo/FreshDecoder por intento, Epo tarda 3410,7/3360,1 ms y Pupu 3328,3/3466,9 ms, por Native sin Legacy. Maite tarda 5484,9/4390,4 ms: sólo 4/6 candidatos cumplen 3,5 s. Los doce intentos control/candidato tienen identidad y ruta Native correctas; no se atribuye toda la variación al hedge. La regresión final conserva 30 Native/IDs y cero Legacy, mediana 699,95 ms y outlier MALAMENTE de 3523,6 ms; sólo observa el inicio. Tres archivos infantiles completos coinciden con yt-dlp y FFmpeg termina sin errores. Pasan 434 JS, tipos, 241 Rust/28 ignoradas en la variante de 100 ms y 60 dirigidas/2 ignoradas en la final de 0 ms, además de ambos checks Android sin avisos nuevos. Siguen pendientes los 3,5 s consistentes, SABR uniforme, integrar main/youtubei.js 18.3, CI LLVM y rendimiento móvil real. El [informe](docs/informe-arranque-frio-2026-10-23.md#ronda-6-clang-parser-y-configuraciones-canary) conserva todas las fases y los fallos; no se publica ni se promueve Oficial.

**Arranque frío, séptima ronda (`98f964b`, `a32092b`):** un asset de ejecución de 3398 bytes evita cargar el analizador al descifrar; se comparte el transporte anónimo de Music conservando políticas por petición. En seis pares de la app mejoran búsqueda (mediana 617→503 ms) y descifrado (41→24 ms), pero el total empeora 3972,7→5428,4 ms por mayores esperas CDN observadas; sólo 1/6 cumple 3500 en cada brazo. Los doce usan Native e ID correcto, sin Legacy. No se repite la tanda para escoger resultados favorables. Las 30 habituales mantienen Native/IDs, mediana 737,45 ms y máximo 2020,6 ms; sólo observa el inicio. Los tres archivos completos vuelven a coincidir y FFmpeg termina con 0. Pasan 245 Rust/30 ignoradas, 436 JS, tipos, ambos assets reproducibles y Android arm64/x86_64 sin avisos nuevos. Range query se descarta tras una única prueba A–B–A: no evita 403 y el 200 sin Content-Range se rechaza. Sigue pendiente mejorar el total estable y la disponibilidad CDN, sin promoción de Oficial ni publicación. El [informe](docs/informe-arranque-frio-2026-10-23.md#ronda-7-decodificador-mínimo-y-transporte-compartido-de-music) conserva todas las filas, métricas de etapa y huellas.

**Arranque frío, octava ronda (`fa46e10`, retirada `ab7f7ff`):** un único A/B frío, anónimo y con búsqueda, no acredita mejora al conservar el contexto oficial del embed: mediana 3649,15→3950,70 ms, cuatro de seis pares peores. Los doce son Native/ID correcto y cero Legacy; sólo 1/6 y 2/6 cumplen 3500 ms, todos Pupu. `fa46e10` se retiró con `ab7f7ff`; código y binario de banco vuelven a R7. ALR, secundario publicado y cver no adelantaron el CDN en sus muestras; el estudio temporal no justifica un nuevo umbral o más sondas. El contexto previo fue inconcluso y conservó seis SABR sin repetirlos. Candidato: 248 Rust pasan en serial tras un timeout del decoder en el pase paralelo; no se amplían límites. No se repiten 30 canciones, archivos completos, Android, Premium o anuncios para un candidato descartado: las pruebas R7 siguen siendo históricas. Persiste la meta estable de 3,5 s, sin publicación. [Informe y seis pares](docs/informe-arranque-frio-2026-10-23.md#ronda-8-diagnóstico-del-cdn-y-candidato-retirado).

**Arranque frío, novena ronda (`4bace13`, `cb592e2`):** seis copias JSON evitadas; ahorro medio local de 29/128/176 µs por HTML en depuración. Descartar ambas precargas pasa de dos cancelaciones IPC a una, pendiente de medir en la app. La tanda habitual conserva 30 Native/IDs, cero Legacy y mediana 631,7 ms. La candidata fría usa Native 6/6, pero no acredita un menor total; se conservan el control con Legacy y el fallo de codificación del banco. [Resultados, límites y experimentos descartados](docs/informe-arranque-frio-2026-10-23.md#ronda-9-mejoras-pequeñas-y-medición-del-total). Oficial sigue experimental.

**Arranque frío, décima ronda:** A (`06823dc`) se retiró con `91c1d44`; B (`114df0b`) se conserva como mejora acotada de espera: en 4/12 candidatos, la respuesta 206 se completó 467–475 ms antes del antiguo turno de 2 s. La media observada de ventana CDN baja 1117→944 y 856→606 ms entre procesos; no demuestra menor total: 8/12 pares empeoran. Pasan 247 Rust/30 ignoradas y compilan Android arm64/x86_64; sin nueva evidencia de rendimiento móvil, EOF, anuncios o Premium. Requiere app reconstruida; OTA y PWA siguen iguales. Rige el criterio incremental sin relajar garantías; Oficial sigue experimental. [Informe R10](docs/informe-arranque-frio-2026-10-23.md#ronda-10-oportunidad-adicional-durante-la-espera-del-cdn).

**Arranque frío, undécima ronda:** el diagnóstico (`ef6c194`) acompaña la preconexión (`506986a`), retenida por un ahorro acotado observado de DNS de ≈1,97 ms en 12/12 pares; ninguna de las 24 primeras respuestas del reproductor registra reutilización TCP/TLS.
El total mejora en 7 pares y empeora en 5: mediana pareada −28,1 ms y agregada 4382,45→3980 ms, sin mejora consistente entre cohortes (C1 mejora, C2 empeora).
Los 24 casos conservan Native e ID correcto, sin Legacy; pasan 254 Rust/30 ignoradas y ambos checks Android, sin medir rendimiento móvil.
Se aceptan avances pequeños medibles y repetibles sin relajar garantías; 3,5 s sigue como referencia y Oficial permanece experimental.
Requiere app reconstruida; PWA y OTA siguen iguales. [Informe R11 y límites](docs/informe-arranque-frio-2026-10-24.md).

**Arranque frío, duodécima ronda:** `21e0fa6` se retira con `fedec82`: preconexión `anonymous` sin reutilización TCP/TLS (0/12 control, 0/11 candidata, un dato ausente). Control 12/12 Native; candidata 11/12 y Pupu sin reproducción por SABR-only antes de llegar al hint, conservando el timeout de 90 s. No se entrega otra canción ni se atribuye el fallo al atributo. Once pares: seis mejores/cinco peores, mediana del cambio −83,1 ms, sin mecanismo confirmado. Pasan 254 Rust; código restaurado a R11, sin cambio de OTA/PWA ni publicación. «Ni, Ni, Ni!» (`NGp3dh-hBe8`) se comprueba aparte: Native e ID correcto, sin Legacy ni sesión, 5234,7 ms con búsqueda en un intento frío. [Informe R12, límites y pendientes](docs/informe-arranque-frio-2026-10-24.md#ronda-12-preconexión-anónima-descartada).

**Arranque frío, rondas 13–14:** el atajo ASCII del parser se descarta antes de integrar (sólo 3/8 pares mejoran). `38a4ded` conserva el decoder en disco 30 días, con descarga actual y URL/SHA/ABI/checksum exactos; RAM sigue a seis horas. Ensayo con caché controlada de doce horas: 24/24 Native/ID, cero Legacy; 23 filas y once pares elegibles por un archivo de DB de PID antiguo. Preparación 2741,6→66,1 ms; Pupu 3532,1→1706,1 ms, pero Maite empeora 3/4 pares, con mayor ventana CDN observada. Mediana del cambio total en once pares −53,6 ms; sin mejora uniforme ni efecto en primer uso con caché vacía. Pasan 256 Rust y checks Android arm64/x86_64. Pendiente solapar POST de metadatos y `watch` al acertar la caché. [Informe R14 y límites](docs/informe-arranque-frio-2026-10-24.md#ronda-14-conservar-el-análisis-verificado-entre-días). Requiere nueva app; sin OTA/PWA, promoción de Oficial ni publicación.

**Arranque frío, ronda 15:** `025f9e8` solapa el POST de metadatos con `watch` en aciertos de disco, tras validar la fuente fresca y liberar COMPILED. Retiene la respuesta hasta admitir identidad; conserva recuperación y máximo dos POST. Comparación anónima con la misma caché en ambos brazos: 24/24 Native/ID, cero Legacy; diez pares elegibles, ocho mejores/dos peores, cambio mediano −270,1 ms (−66,1/−1123,1 ms por cohorte). Espera watch→metadatos 232,35→0,36 ms. Se conservan dos exclusiones de prueba y todas las regresiones; no hay arranque uniforme de 3500 ms ni mejora de primer uso sin caché. Pasan 261 Rust y checks Android. [Informe R15 y límites](docs/informe-arranque-frio-2026-10-24.md#ronda-15-metadatos-en-paralelo-con-caché-verificada). Requiere nueva app; sin publicación ni cambio OTA/PWA.

La descripción y las mediciones siguientes corresponden al prototipo histórico; «nivel garantizado» era su denominación, no una garantía frente a cualquier cambio de plataforma. Sus tiempos no describen la nueva captura experimental a velocidad normal.

#### Motor propio
- **Objetivo:** que funcione siempre que una persona pueda escuchar la canción en YouTube. Las librerías que imitan su API interna pueden romperse al cambiar esa API. Usar el reproductor oficial reduce esa dependencia, aunque aún requiere identificar correctamente el audio. El prototipo histórico tenía dos niveles:
  1. **Nivel rápido** (`native.rs`): una petición a la API interna de YouTube desde Rust, sin librerías ni programas externos.
     - Qué cliente de YouTube se imita, con qué versión y datos, va en una **receta** (`src-tauri/recipe/youtube.json`). Si YouTube cambia algo de eso, basta con cambiar la receta y subir su versión: se publica y la app la baja sola (ver "Extractores que se actualizan solos"). Si la nueva no vale, se queda con la incluida.
     - Pide antes una **sesión de visitante** (`sw.js_data`). Sin ella, YouTube responde "inicia sesión para confirmar que no eres un bot": 0 de 30, frente a 30 de 30 con ella. Se busca por su forma (empieza por "Cgt"), no por su posición en la respuesta.
     - **Comprueba cada URL** pidiendo 1 KB hacia el 80 % antes de usarla. Es donde YouTube corta a veces (403); si pasa, pide otra.
  2. **«Nivel garantizado», nombre histórico**: **el reproductor oficial de YouTube Music en una ventana oculta**. Su reproductor obtiene el audio y el prototipo interceptaba Media Source con audio separado. Esa ruta no es universal: workers, HLS, multiplexación o cambios de formato necesitan soporte explícito. En `p1-oficial`, Propio conserva este respaldo en `capture_legacy.rs` y `capture-legacy.js`; `capture.rs` y los módulos del núcleo desarrollan la captura nueva sin reemplazarlo.
     - El audio llega a Rust por el **canal nativo de WebView2** (`WebMessageReceived`), que solo existe en esa ventana. No hay puertos ni protocolos abiertos a la página, y la ventana no tiene permisos de Tauri.
     - La ventana usa **su propio perfil y su propio proceso navegador**: si YouTube o WebView2 fallan ahí, la interfaz de Musify no se entera. Hay una ventana nueva para cada canción y se cierra en cuanto la canción está entera, así que los cientos de MB de YouTube Music solo se gastan mientras se copia.
     - Comportamiento histórico: rechaza las cookies ("Rechazar todo"), va en silencio y solicita 1× para los anuncios que detecta, o intenta omitirlos cuando aparece el botón. Eso no garantiza su velocidad ante un marcador tardío. La canción solicita 16× y los últimos segundos van más despacio. La página se cree visible (`SetIsVisible`), para que el navegador no la frene. La captura nueva API4 se mantiene a1×.
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
  | Si YouTube cambia su API | esperar a que se actualice | sacar otra versión | publicar receta nueva | sin imitar esa API; DOM/MSE pueden requerir adaptación |

  - Las URLs malas de yt-dlp dan 403 al pasar del primer MB; se ve igual repitiendo la petición, así que es cosa de YouTube. El nivel rápido las detecta y las cambia antes de usarlas.
  - Con el reproductor de la app y el motor propio: de clic a sonar, 0,24–0,3 s con la búsqueda incluida; las siguientes canciones, ya preparadas, en ~26–51 ms (4 de 4 en cada prueba). Solo con el nivel garantizado: 1,5 s la primera canción nueva, 3–4 s si pasas enseguida a otra que aún no estaba preparada, y 26–52 ms las ya copiadas.
  - El nivel garantizado copia una canción entera en 7–25 s (16x).
- **Límites honestos:**
  - **DRM:** contenido cifrado (no la música normal de YouTube) no se puede sacar, y no se intentará.
  - **Contenido que pide iniciar sesión** (con restricción de edad, por ejemplo): hará falta enseñar la ventana del motor para iniciar sesión una vez, como haría una persona. Pendiente.
  - Si YouTube pidiera un **captcha**, igual: enseñar la ventana para resolverlo. Pendiente.
  - En el nivel garantizado, saltar a una parte aún no copiada tarda 1–3 s.
  - Las tiendas de apps no aceptan una app así (pasa igual con cualquier motor). No se publicará en ellas: en Android, APK propio con Obtainium; en iPhone, SideStore con un Apple ID gratis.
- **Pendiente:**
  - Búsqueda de respaldo en YouTube normal sin yt-dlp (hoy `ytdlp.search`): pasarla a `youtube.rs`.
  - Descargas sin yt-dlp: guardar lo que copia el nivel garantizado o bajar la URL del nivel rápido.
- **Móvil (fase 7, ver [docs/plan-mobile.md](docs/plan-mobile.md)):** el nivel rápido es Rust, no necesita la interfaz y es el motor de la primera versión de Android: puede preparar canciones con la pantalla apagada. El garantizado se queda fuera de esa primera versión. Necesita en cada sistema una WebView controlada por código nativo, con su canal nativo, y una página viva, cosa que Android no sostiene con la pantalla apagada. Tauri no deja abrir una segunda ventana en el móvil, y Android no deja leer lo que una página envía a un protocolo propio. Notas para cuando toque:
  - **Android:** plugin en Kotlin con su `WebView`, `addJavascriptInterface` como canal y `addDocumentStartJavaScript` para el script. Para que suene con la pantalla apagada hará falta un servicio en primer plano (igual con cualquier motor).
  - **iOS:** `WKWebView` con `WKUserScript` y `WKScriptMessageHandler`. Primero hay que comprobar cómo reproduce YouTube Music en iPhone: si usa HLS en vez de Media Source, se captura la URL HLS que pide su reproductor y se reproduce tal cual (iOS sabe hacerlo).
  - En Mac y Linux, lo mismo con WKWebView y WebKitGTK.

#### Primer prototipo: youtubei.js
- La librería (18.1, sin modificar) corre en la interfaz. Rust le hace las peticiones (`http_fetch`) y el descifrado va en un Web Worker. Funciona: 60 de 60 en dos rondas y ~90 ms. Pero imita la API interna igual que yt-dlp. Para seguir los cambios de YouTube depende de que salga una youtubei.js nueva; desde la 0.4.0 esa versión llega sola, sin actualizar la app (ver "Extractores que se actualizan solos").
- **PO token:** de 11 clientes de YouTube, solo VISIONOS da audio completo sin él (es el que usa yt-dlp 2026.08.19). IOS, ANDROID_VR, TV_SIMPLY y YTMUSIC cortan con 403 pasado el primer MB; MWEB, desde el primer byte. WEB y ANDROID solo dan SABR; TV dice "The page needs to be reloaded"; los *_EMBEDDED, "This video is unavailable". youtubei.js no genera PO tokens: acepta uno hecho y lo pone en las URLs (`pot=`).
- **rusty_ytdl:** descartado. Su última versión es de agosto de 2024 y no conoce VISIONOS ni SABR.

#### Notas técnicas (WebView2)
- El receptor de mensajes de wry (la base de Tauri) va antes que el nuestro y corta la cadena con los mensajes que no son texto. Por eso `capture.js` manda texto con el prefijo `musify:`, que Tauri descarta en el primer carácter.
- Destruir una WebView y crear otra en seguida con el mismo nombre ha llegado a tumbar el proceso navegador de WebView2 (acceso inválido en `msedge.dll`, al cerrarse). De ahí el perfil aparte, un nombre nuevo por ventana y el cierre ordenado (primero `about:blank`).
- Reutilizar la misma página de YouTube Music para muchas canciones acaba colgándola (sin gastar CPU), sobre todo tras saltos. De ahí la ventana nueva por canción y el vigilante.
- Los ejecutables de los tests no llevaban el manifiesto de Windows (comctl32 v6) y no arrancaban (`STATUS_ENTRYPOINT_NOT_FOUND`) en cuanto el código de ventanas fue alcanzable desde ellos. `build.rs` ahora incrusta el manifiesto con el enlazador en todos (`windows-app-manifest.xml`).
- Al cerrar la ventana principal se cierra la app, aunque haya una ventana del motor abierta.

#### Integración en `main` (0.4.0)
- Archivos del motor:
  - `src-tauri/src/`: `extractor.rs` (elige motor, `http_fetch` y las mediciones), `native.rs`, `capture.rs` y `capture.js`; y `extractors.rs`, que actualiza los extractores.
  - `src-tauri/recipe/youtube.json`, `src-tauri/extractors.json` y `src-tauri/windows-app-manifest.xml`.
  - `src/lib/extractor/`: `capture.ts`, `engine.svelte.ts`, `host.ts`, `youtubei.ts`, `fetch.ts`, `eval.worker.ts` y `bench.ts`.
  - `src/components/EngineSwitch.svelte` (en la 0.5.0 se quita de Inicio para dejar la interfaz limpia: el motor se elige en el menú del número de versión de la barra lateral).
- Cambios en archivos que ya existían:
  - `lib.rs`: módulos, arranque, comandos y cerrar la app con la ventana principal.
  - `player.rs`: 3 llamadas a `stream`.
  - `ytdlp.rs`: `VideoInfo` serializable, y `now` y `query_param` visibles.
  - `player.svelte.ts`: `setAudioSource` en vez de `audio.src`, y `stopCapture` al cambiar de canción.
  - `main.ts` y `Home.svelte`: arranque y selector.
  - `build.rs`, `Cargo.toml` (`base64`, `sha2`, `minisign-verify`; y en Windows `webview2-com` y `windows-core`) y `package.json` (`youtubei.js`).
  - CSP: `blob:` en `media-src` (Media Source) y en `script-src` (youtubei.js descargado).
- Al integrarlo, youtubei.ts dejó de importar nada de la app: lo que necesita (peticiones por Rust y el worker para el código de YouTube) se lo da `host.ts` con `setup`. Así el mismo archivo va dentro de la app y se publica suelto.
- Para probar con otra copia de la app abierta, hay que arrancarla con otro identificador y otro puerto (`tauri dev --config` con `identifier`, `devUrl` y `beforeDevCommand` distintos). Si no, por ser de una sola instancia, la nueva se cierra al momento; y con el mismo identificador abrirían la misma base de datos.

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
- [x] Móvil (6 oct 2026): primero Android, con APK propio y Obtainium. Sin tiendas oficiales ni cuentas de pago. Android Auto y CarPlay, fuera por ahora. iPhone, más adelante y gratis (SideStore), sin CarPlay.

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
  - [x] Versión 0.1.0 publicada en `pletina-releases` con los cuatro instaladores: Windows `.exe` (2 MB), Mac universal `.dmg` (6 MB), Linux `.AppImage` (80 MB, lleva el motor web dentro) y `.deb` (3 MB).
  - [ ] Probar los de Mac y Linux en un equipo real (están compilados, pero no probados).
  - [x] Actualizaciones automáticas (desde la 0.2.0): la app busca versión nueva al arrancar y cada 6 horas en `pletina-releases/releases/latest/download/latest.json`, la descarga en segundo plano y la instala al cerrarse (en Windows, instalador silencioso). Si hay una lista, la barra superior muestra «Versión X lista · Reiniciar».
    - Firmadas con una clave propia (minisign). La privada está en `%USERPROFILE%\.musify\` (clave + contraseña) y como secretos `TAURI_SIGNING_PRIVATE_KEY*` en el repositorio de código. **Si se pierde, las apps instaladas no aceptarán más versiones**: hay que guardarla en un sitio seguro.
    - Publicar una versión: subir la versión en `package.json` (y `Cargo.toml`), commit y etiqueta anotada `vX.Y.Z` cuyo mensaje son las notas. GitHub Actions compila, firma, genera `latest.json` (`scripts/release.mjs`) y publica en `pletina-releases`.
    - Para que publique solo necesita el secreto `RELEASES_TOKEN` (token con permiso de escritura solo sobre `pletina-releases`). Sin él, compila pero no publica, y hay que publicar a mano con `scripts/release.mjs` y `gh release create`.
    - Compilar en local sin firmar: `npm run build:local`.
    - **Probado de principio a fin en Windows (6 oct 2026), pero dentro del entorno aislado de Claude (ver más abajo):** la 0.2.0 instalada encontró la 0.2.1, la descargó en segundo plano y, al cerrarla, se instaló sola en silencio y volvió a abrirse ya en 0.2.1. Falta verlo con el Musify que abre el usuario desde el menú Inicio.
- [x] **Música local** (0.3.0): «Tu música» en la barra lateral → «Añadir carpeta» (una o varias). Se leen las etiquetas (título, artista, artista del disco, disco, pista, año, duración, carátula) de mp3, m4a, flac, ogg, opus y wav; si faltan, se sacan del nombre del archivo y de las carpetas (Artista/Disco/01 Canción). Carátulas: la incrustada, la imagen de la carpeta (cover.jpg, folder.jpg…) o la de Deezer; fotos de artista de Deezer. Discos y artistas locales funcionan como los de Deezer (páginas, búsqueda «En tu música», playlists, historial, cola) y suenan desde el archivo, sin YouTube. Escaneo incremental al arrancar; quitar una carpeta quita lo suyo.
  - Probado con mp3 de prueba (con etiquetas y carátula incrustada, y sin etiquetas), con la app lanzada desde el entorno aislado de Claude (ver abajo).
- [x] **Cola de reproducción tipo DJ** (0.3.0): «Reproducir a continuación» y «Añadir a la cola» en canciones, discos (también clic derecho en las tarjetas) y playlists; lo añadido suena antes de seguir con el disco o la playlist. Panel lateral «Cola» (botón de la barra de reproducción): sonando, tu cola (arrastrar para reordenar, quitar, vaciar), lo que viene; se pueden arrastrar canciones desde cualquier lista. «Guardar como playlist».
- [x] **Protección de la base de datos:** copia completa antes de cada migración (`musify.db.antes-de-vN`, se guardan 3) y la app se niega a crear una base nueva encima de un archivo con datos. (El 6 oct 2026 una prueba en desarrollo dejó la base de datos viéndose vacía; los datos se recuperaron del archivo principal.)
  - 0.3.1: una base de datos con solo la cabecera (4 KB, sin tablas) cuenta como vacía y se usa; antes la protección la rechazaba y la app se cerraba al arrancar sin decir nada. Si la base de datos no se puede abrir, ahora sale un aviso con el error y la ruta.
  - **Ojo al probar desde Claude (app de escritorio):** los comandos que lanza Claude corren dentro de su paquete MSIX, y lo que escriben en `%LOCALAPPDATA%` va a `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\…`. Lo que se instale, actualice o se pruebe desde ahí usa otra carpeta de datos que el Musify que abres desde el menú Inicio. Las actualizaciones automáticas de 0.2.0 → 0.2.1 → 0.3.0 se probaron en esa copia aislada; en el equipo real todavía no.
- [x] **Motor de audio propio y extractores que se actualizan solos** (0.4.0): el trabajo de P1 integrado (selector en Inicio: yt-dlp, youtubei.js o Propio; yt-dlp sigue por defecto). La receta y el script del motor propio y youtubei.js se publican y se actualizan por separado, sin reinstalar la app; youtubei.js nuevo se coge solo de npm. Ver "Extractores que se actualizan solos".
  - **Falta para que sea automático del todo:** el secreto `RELEASES_TOKEN` en GitHub. Sin él, GitHub Actions no puede publicar en pletina-releases y hay que publicar a mano (`node scripts/extractors.mjs`, con `gh` y la clave en `~/.musify`).
- [ ] **Fase 7: móvil, empezando por Android.** Plan en [docs/plan-mobile.md](docs/plan-mobile.md). Hechas las fases 0 a 3 (0.5.0): suena con la pantalla apagada en un servicio nativo, interfaz táctil, y APK firmado que se instala y se actualiza con Obtainium. De la 4, hechas las descargas y escuchar sin conexión (0.6.0); falta la música guardada en el teléfono.

## Repositorios
- Código (privado): https://github.com/diad87/musify — rama `main`.
- Versiones (público): https://github.com/diad87/pletina-releases — instaladores y canal de actualizaciones automáticas.

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
- `src-tauri/src/extractor.rs`: elige con qué se saca el audio (yt-dlp, youtubei.js o el motor propio). El motor propio está en `native.rs` (nivel rápido, con la receta de `recipe/youtube.json`) y `capture.rs` + `capture.js` (ventana oculta).
- `src-tauri/src/extractors.rs`: baja, comprueba y pone en uso los extractores nuevos (`extractors.json` tiene sus versiones). Se publican con `scripts/extractors.mjs`.
- `src-tauri/src/db.rs`: SQLite local (`%LOCALAPPDATA%\dev.musify.desktop\musify.db`).
- `src-tauri/src/lib.rs`: comandos que llama la interfaz (`search`, `artist`, `album`, `resolve`).
- `src/lib/`: llamadas a esos comandos con caché, historial propio (`nav.svelte.ts`), reproductor y cola (`player.svelte.ts`), vistos recientemente y formatos.
- `src/views/`: pantallas (Inicio, Búsqueda, Artista, Disco).
- `src/components/`: piezas comunes (barra superior, menú lateral, tarjeta, carátula, iconos).
