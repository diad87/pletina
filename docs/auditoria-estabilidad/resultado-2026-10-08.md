# Resultado de la auditoría de estabilidad — 8 de octubre de 2026

Informe histórico de la versión 0.10.0 antes de corregirla. El [seguimiento de correcciones y nuevas pruebas](correcciones-2026-10-08.md) conserva por separado los resultados posteriores.

**Pletina 0.10.0 no supera la auditoría. Ninguna de las cuatro plataformas queda aprobada.** Se ejecutaron las pruebas disponibles, se reprodujeron defectos y se dejaron identificados los recorridos parciales y bloqueados. Las pruebas pendientes de hardware y resistencia no se presentan como realizadas.

Referencia: `2d679e477d906682974d2ee763d3cf09c5b4a7a2`. El código de producto de `src/` y `src-tauri/` no se modificó. Se añadieron pruebas y documentación en un worktree aislado. Los binarios publicados se contrastaron con sus SHA256; Windows utilizó además un build QA de ese código con identidad independiente, sin el actualizador de aplicación activo.

El [Estado de los 70 casos](estado-casos-2026-10-08.md) resume el resultado: 6 pasan, 9 fallan, 38 son parciales y 17 están bloqueados. La [matriz de resultados de los 70 casos](resultado-2026-10-08.json) conserva lo probado, lo pendiente y las evidencias de cada caso. Los 9 casos fallidos no equivalen a 9 defectos P1: incluyen pruebas bajo inyección de fallos y casos que comparten causa. El [plan](../auditoria-estabilidad.md), los [casos originales](cases.json) y el [estado de partida](baseline.json) se conservan como referencia; sus estados iniciales no sustituyen este resultado.

## Defectos que impiden aprobar

Los siete defectos siguientes son P1 según el impacto definido en el plan. La prioridad P0 de algunos **casos** indica qué validar primero; no convierte automáticamente su resultado en un defecto P0. No se ha demostrado pérdida de una biblioteca existente en los recorridos ejecutados.

| ID | Fallo y disparador | Evidencia y alcance |
| --- | --- | --- |
| STAB-001 | Android acumula reintentos aunque la reproducción se haya recuperado; el cuarto corte termina saltando de A a B. | Servicio Kotlin original, JNI del APK publicado y ExoPlayer real en emulador API 35, con HTTP 503 controlado. Tres recuperaciones con 3 s de avance real antes del cuarto corte. La variante con 30 s entre cortes se confirmó con reloj simulado. |
| STAB-002 | Un retry pendiente deshace la pausa o actúa sobre otra pista. | Dos pruebas Android reales fallan: error en A→pausa→retry; y error en A→cambiar a B→pausa→retry antiguo. En la segunda, al comprobar 2,5 s después de pausar, B ya ha vuelto a `playWhenReady=true`. |
| STAB-003 | La vuelta de red reanuda aunque se haya pulsado pausa durante la espera. | Bloques Kotlin originales ejecutados con dobles de conectividad y reproductor. Esta variante no se reprodujo con una radio móvil física ni con ConnectivityManager real. |
| STAB-004 | El reproductor de escritorio puede mostrar que reproduce aunque el audio haya dejado de avanzar, sin recuperar ni terminar con error. | `player.svelte.ts` real compilado: `waiting/stalled`, posición detenida en 60 s y otros 180 s sin progreso. Audio, IPC y reloj son dobles. |
| STAB-005 | Un rechazo de `play()` al reanudar queda silenciado. | Regresión sobre el reproductor Svelte real, con promesa de audio rechazada. No es una prueba de decodificación del motor web. |
| STAB-006 | Si `play()` al reanudar nunca se resuelve, falta un límite de espera. | Regresión sobre el reproductor Svelte real, con promesa pendiente y reloj controlado. |
| STAB-007 | Helpers de SQLite descartan errores de escritura y pueden aparentar éxito sin guardar el cambio. | `db.rs` real y SQLite real: `SQLITE_READONLY`, `SQLITE_FULL` y `SQLITE_BUSY`. Afecta a ajustes, fuente seleccionada y referencias de descarga. Tres aserciones fallidas comparten esta causa; no son tres defectos independientes. |

Referencias de implementación: [PlaybackService.kt](../../src-tauri/gen/android/app/src/main/java/dev/musify/desktop/PlaybackService.kt), [reproductor](../../src/lib/player.svelte.ts), [base de datos](../../src-tauri/src/db.rs). Bajo la raíz `D:/tmp/pletina-stability-execution-20261008`, las pruebas y manifiestos de origen están en `android`, `core/db-run-2`, `core/direct-run-3` y `runs`.

Las pruebas Android de runtime usan un APK de instrumentación independiente, seis archivos Kotlin originales y la biblioteca JNI exacta del APK publicado. Se ejecutan en un emulador x86_64 con traducción de ARM64, sin la interfaz Tauri completa. El audio está silenciado: se comprueban decodificación y avance, no audición física. El servidor HTTP loopback y su permiso de texto claro pertenecen al harness; no validan TLS ni una red celular.

El caso AND-012 también falla en la simulación de política: un transporte celular presente sin Internet validado consume reintentos y acaba saltando. No se atribuye esta observación al dispositivo del foro ni se presenta como una prueba de cobertura móvil.

## Linux: fallo observado que requiere aislamiento

La AppImage publicada presenta un bloqueo intermitente al reanudar tras seek y pausa en Ubuntu 24 bajo WSL: `readyState=4`, `paused=false` y eventos `playing`, pero `currentTime` queda en 6 s. Se observó con y sin silencio y usando extracción y FUSE. También hubo una pasada completa correcta de siete formatos y 210 inicios cálidos correctos. Por tanto, DESK-LIN-004 queda **fallido**, aunque otras pasadas terminen bien.

El control con el binario extraído del DEB pasó los siete formatos. El CI existente de Ubuntu 22 también pasó con exactamente el SHA de la AppImage publicada. La AppImage incluye WebKit 2.50.4/GStreamer 1.20.3; el DEB usa WebKit 2.52.6/GStreamer 1.24.2 del host de prueba. La causa puede estar en la combinación de bundle, motor web y audio virtual; queda pendiente reproducir en un escritorio físico y aislar esa diferencia. No se ha demostrado que todas las instalaciones Linux fallen ni que este sea el mismo problema comunicado en el foro.

## Defensas adicionales bajo inyección de fallos

El transporte móvil de descargas, `direct.rs`, se compiló sin modificarlo en un harness de Windows con HTTP local y archivos reales. El resolvedor de vídeo se sustituyó por una fixture. Se observaron tres incumplimientos bajo condiciones inyectadas:

- STAB-008 (P2): al renovar una URL con el mismo `itag` pero diferente `clen`, puede anunciar como completo un archivo truncado.
- STAB-009 (P2): una respuesta 206 con `Content-Range` incoherente puede concatenar bytes incorrectos y terminar con éxito.
- STAB-010 (P1 condicional): un parcial mayor que el tamaño esperado, cuyo borrado falla, entra en un bucle sin salida. El test confirmó una denegación de borrado mediante un handle Windows y terminó únicamente su proceso hijo tras 2500 ms.

Son defectos de defensa del código bajo esas precondiciones. No se ha observado que YouTube emita las dos respuestas incompatibles ni se ha demostrado la denegación de borrado equivalente en Android. `direct.rs` no es la ruta de descarga de la aplicación Windows. Se mantienen separados de los siete P1 anteriores y de las reproducciones Android completas.

Otras tres aserciones frontend fallan ante rechazo del puente de cancelación, evento `done` duplicado y progreso posterior a `done`. No se ha demostrado que el backend emita estos eventos fuera de orden; `cancel_downloads` no devuelve error de negocio. Se conservan como pruebas de robustez, sin contarlas como tres fallos confirmados del backend.

## Qué sí ha pasado

| Bloque | Resultado comprobado |
| --- | --- |
| Compilación y tipos | Svelte, TypeScript y build de interfaz correctos. Build Windows QA correcto. |
| Pruebas existentes | Rust: 63 pasan y 19 siguen ignoradas. Reproductor: 23 pasan. Favoritos de pódcasts: 8 pasan. |
| Regresiones de escritorio | 8 pasan y 3 fallan, conservando las aserciones que detectan STAB-004/005/006. |
| Frontend de datos | 15 pasan y 3 aserciones de robustez fallan. Pasan cancelación de importación, respuestas tardías, destrucción, retry, doble guardado y error de escritura modelado. |
| SQLite | 7 pasan y 3 fallan por STAB-007. Las migraciones de los esquemas de 0.9.0 y 0.9.1 a 7 conservan todos los valores de 15 tablas y su backup; pasan WAL tras salida abrupta, rollback, rechazo de DB corrupta sin sobrescribirla y 400 escrituras concurrentes. |
| Transporte de descarga | 6 pasan y 3 fallan bajo las condiciones inyectadas descritas arriba. Pasan 206 normal, continuación de parcial, renovación 403, corte HTTP, cambio de formato y error de rename con parcial conservado. |
| Red real | 4 búsquedas, 7 vídeos y 28 lecturas Range correctas. Acredita búsqueda, resolución y bytes recibidos, no reproducción completa. |
| Windows/WebView2 | 8 comprobaciones de audio y seek entre nativo, youtubei, yt-dlp y captura oficial; 7 inicios en cola correctos. youtubei sirve sus 2 pistas sin fallback. Audio silenciado: se comprueba decodificación y avance, no audición física. |
| Windows/persistencia | 100 aperturas y cierres normales del build QA; 12 tablas idénticas antes/después, `integrity_check=ok`, sin infracciones FK ni procesos propios supervivientes. No incluye cierres durante descarga ni preferencias de localStorage. |
| Android/runtime | YouTube público reproduce con JNI y ExoPlayer. Audio de episodio RSS con URL sembrada en SQLite y servido por HTTP loopback: 30 aperturas en el mismo proceso, seek a 120 s, pausa/reanuda y reconexión del controlador tras pasar la Activity de prueba al fondo. p95 de 920 ms hasta reproducir y superar 500 ms de posición; no mide arranque de la aplicación, lectura del feed ni inicio audible de un RSS remoto. |
| Android/persistencia e integración | Cola duplicada restaura pausa a 15 s y repeat-all tras guardado ordenado, detención y relanzamiento en otro proceso; el archivo y la referencia de descarga sembrados permiten reproducir, y los favoritos sembrados sobreviven. No prueba cierre durante escritura ni el flujo de descarga. Cuatro pruebas existentes pasan: navegación por MediaBrowser/Media3, recuperación del contexto y duplicados, y preparación de audio local mediante JNI. No sustituyen un coche o Android Auto físico. |
| Linux/paquete | Siete formatos con GStreamer incluido; Node incluido funciona. HTTP local, límites del registro, 524 archivos y cierre del listener correctos. AppImage y DEB resuelven YouTube y descargan/reproducen un WebM real. |
| Artefactos | Hashes correctos. Firmas updater válidas en NSIS, AppImage y tar universal; contenido alterado rechazado. Mappings Intel/ARM de macOS coherentes. Mach-O universal y mínimos 11.0 comprobados. Esto no valida Gatekeeper ni ejecución macOS. |

No se agregan estas cifras en una supuesta tasa global de éxito: mezclan capas, repeticiones y ámbitos distintos. Una prueba de una capa no aprueba automáticamente un caso completo de plataforma.

## Cobertura pendiente y criterios para cerrar

macOS carece de pruebas de ejecución: no hay Mac Intel ni Apple Silicon disponible. En Android faltan teléfono ARM64, batería/OEM, llamadas, Bluetooth, Android Auto real, matriz de versiones y el flujo completo de descargas Tauri. Windows necesita VM limpia para instalación, WebView2 ausente, upgrades y desinstalación. Linux necesita escritorio físico, suspensión, salidas de audio y controles de instalación/upgrade completos.

No se iniciaron las sesiones de 8 h de música y 2 h de pódcast: siguen abiertos los prerrequisitos funcionales. Tampoco se declara cubierta toda la matriz de latencia, caudal, pérdida de paquetes y cambios de red. La reproducción breve de una fuente no demuestra continuidad durante un episodio largo.

Para cerrar: corregir y repetir los siete P1, resolver el bloqueo observado de la AppImage, tratar las defensas de descarga y completar los casos parciales/bloqueados sobre el mismo candidato final. Los fallos intermitentes requieren las 20 repeticiones y la sesión larga definidas en el plan.

Las pruebas se ejecutaron en perfiles y archivos sintéticos. Se detuvo el emulador 5580 propio; el 5554 permaneció conectado. Los procesos y listeners propios de Windows/Linux quedaron cerrados. Los fallos iniciales de configuración de harness —foco y visibilidad WAL de las fixtures Android, CLI GStreamer incompatible y dependencia reqwest incorrecta— están documentados y excluidos del recuento de defectos de producto.

## Repetición y evidencias

```sh
node scripts/audit-stability.mjs --profile quick
node scripts/audit-stability.mjs --profile core
node scripts/audit-stability.mjs --profile data
node scripts/audit-stability.mjs --profile network
```

Las suites de regresión y robustez conservan sus salidas fallidas; no se relajaron aserciones para conseguir un resultado verde. Los harnesses de SQLite y descarga tienen instrucciones en [README-audit.md](../../scripts/tests/README-audit.md).

Raíz de evidencias: `D:/tmp/pletina-stability-execution-20261008`. Cada bloque contiene manifiestos, logs y resultados; los recorridos previos reutilizados del APK se identifican como tales y están en `D:/tmp/pletina-forum-bugs-20261008/apk`. La matriz JSON enlaza cada resultado con sus archivos y limita expresamente su alcance.
