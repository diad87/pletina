# Correcciones de estabilidad — 8 de octubre de 2026

Correcciones sobre Pletina 0.10.0 (`2d679e477d906682974d2ee763d3cf09c5b4a7a2`), en la rama `codex/stability-fixes`. Este seguimiento separa las correcciones comprobadas de la [auditoría inicial](resultado-2026-10-08.md). No cambia retroactivamente los resultados de sus 70 casos ni certifica todas las plataformas.

## Cambios

| Área | Comportamiento corregido |
| --- | --- |
| Android, STAB-001 | Los reintentos se reinician tras reproducción sostenida y avance real, para que varios cortes separados no agoten un contador de toda la sesión. |
| Android, STAB-002/003 | Pausa, parada y cambio de entrada invalidan las recuperaciones pendientes. Volver a tener una red con Internet validado solo reanuda si sigue vigente la intención de reproducir. También se capturan los comandos de la sesión multimedia. |
| Escritorio, STAB-004 | Si el audio no avanza durante 30 s, se reconstruye el reproductor una vez conservando pista y posición. Si vuelve a bloquearse, se muestra un error que permite reintentar la misma pista. Los eventos `playing` duplicados no ocultan un reloj detenido. |
| Escritorio, STAB-005/006 | Reanudar maneja rechazos y limita la espera de `play()`. Pausar mientras se resuelve una fuente descarta sus resultados tardíos. Play y pausa de MediaSession son idempotentes. |
| SQLite, STAB-007 | Las escrituras de ajustes, fuentes y referencias de descarga devuelven errores a sus llamadores. No se anuncia un guardado que SQLite ha rechazado. Los cambios de carpeta muestran el error sin fingir un nuevo escaneo. |
| Descarga, STAB-008/009/010 | Una renovación con otro tamaño/formato reinicia el parcial. Se validan rango, longitud y codificación HTTP antes de añadir bytes. Un cuerpo excesivo se revierte al parcial previo; un archivo que no puede borrarse produce un error, sin bucle infinito. |
| Estado de descargas | Cancelación fallida visible; entradas y eventos terminales duplicados ignorados; progreso tardío no resucita transferencias terminadas. Un borrado parcialmente completado se reconcilia con la biblioteca. Respuestas antiguas de inicio o borrado no pisan un intento nuevo. |

Antes de eliminar audio por elección manual de fuente o retirada de una descarga, se comprueban las escrituras SQLite dentro de una transacción. Si no se puede eliminar el archivo, se revierten los metadatos. Esto no crea atomicidad conjunta entre SQLite y el sistema de archivos: un fallo físico durante el commit posterior al borrado sigue siendo un límite, no un caso certificado.

## Validación de las correcciones

| Prueba | Resultado y alcance |
| --- | --- |
| Frontend | **82/82** con `npm test`: 49 de reproducción, 8 de favoritos de pódcasts y 25 de datos/importación. Código Svelte real con adaptadores de audio, IPC y reloj; no sustituye el motor de audio del sistema. |
| Tipos y compilación | Svelte/TypeScript: 0 errores y 0 avisos. Build de interfaz correcto. |
| Rust | **72/72**, con 19 pruebas de red ignoradas por defecto. Se ejecutó además `direct::tests::downloads_a_song`: descarga real de 3 433 755 bytes correcta con la nueva validación HTTP. |
| SQLite real | **10/10**: migraciones desde 0.9.0/0.9.1, conservación de valores y backup, reaperturas, WAL, rollback, concurrencia y errores READONLY/FULL/BUSY. |
| HTTP y archivos reales | **12/12** con servidor loopback y resolvedor de prueba: reanudación, renovación, cortes, cambio de tamaño/formato, HTTP 200/206, rangos incompatibles, cuerpo excesivo y archivos bloqueados. El negativo de cuerpo excesivo detectó y permitió corregir un fallo de truncado del handle de Windows. |
| Android, política | **11/11** JVM; incluye 20 iteraciones por variante de cancelación y callbacks ya cancelados ejecutados deliberadamente. |
| Android, Media3 | **7/7** regresiones instrumentadas, con 20 carreras HTTP reales, y **4/4** integraciones existentes de MediaBrowser/JNI. Pasan pausa, parada, cambio de cola, cuarto corte con avance posterior y pérdida/vuelta de red mediante ConnectivityManager. |
| Windows, aplicación compilada | Build QA final correcto, con identidad `dev.musify.audit.stabilityfix20261008`. **3/3** reproducciones y saltos de posición por URL nativa, más **3/3** inicios desde la cola con el reproductor de la aplicación. Audio silenciado, con decodificación y avance reales en WebView2. |
| Linux, WebKit real | La AppImage anterior vuelve a bloquearse al reanudar WAV con el mismo harness. Con el reproductor nuevo y las bibliotecas publicadas intactas pasan **7/7** formatos y **20/20** ciclos adicionales de seek, pausa y reanudación. |
| Linux, recuperación provocada | Al fijar `playbackRate=0` únicamente en el WAV reanudado, el reloj real deja de avanzar. El watchdog reconstruye el decoder en **31,949 s**, conserva URL/posición y vuelve a avanzar con velocidad 1. Los otros seis formatos pasan. |

Los tres fallos originales Android de pausa, cambio a otra pista pausada y cuarto corte se reprodujeron de nuevo antes de probar la corrección. El control de política original reproduce además la vuelta de red tras pausa y la red sin validar. Se mantienen las aserciones originales de escritorio que detectaron el bloqueo, el rechazo y la espera ilimitada; ahora pasan. Las expectativas de número de temporizadores se adaptaron a la incorporación del watchdog.

Android usa un emulador API 35 con traducción ARM64, servicio Kotlin nuevo, JNI del APK 0.10.0 publicado y paquete de prueba independiente. El audio se silencia y se verifica decodificación y avance. No se compiló un nuevo JNI Android ni se ejecutó la interfaz Tauri completa. El emulador dedicado 5580 se cerró al terminar; no se utilizó el 5554.

Linux se ejecuta en Ubuntu 24 bajo WSL, con Xvfb, PulseAudio y perfiles aislados. Para separar el cambio del reproductor de las versiones de WebKit/GStreamer, una variante QA conserva todos los archivos de la AppImage publicada excepto `usr/bin/musify`; los manifiestos de las bibliotecas coinciden. La serie de 20 ciclos reanuda en 0,41–0,44 s sin bloqueo natural ni reconstrucción. La prueba con velocidad cero sí acredita la recuperación del watchdog en WebKit real, pero **no identifica ni elimina la causa original del bloqueo intermitente de GStreamer**. Se ha añadido una defensa comprobada. Sigue pendiente el contraste en escritorio físico.

También se ha construido una AppImage nueva con Ubuntu 24; sus bibliotecas difieren de las publicadas. Ambos bundles pasan la decodificación de siete formatos y la ejecución de Node. La AppImage nueva pasa además los siete formatos en la interfaz y la recuperación provocada. Son artefactos QA separados, no una versión publicada.

Los builds Linux contienen exactamente el reproductor y los módulos Rust finales, pero se compilaron antes de la última defensa del store de descargas contra rechazos IPC antiguos. Esa defensa está comprobada en la suite frontend de 82 pruebas y incluida en el build final Windows; no se atribuye al ejecutable Linux anterior. Los manifiestos registran esa diferencia.

## Repetición y evidencias

`npm test` incluye todas las suites frontend y se ejecuta en el workflow de instaladores. `cargo test` incluye nueve nuevas regresiones del núcleo. Los [harnesses de datos y recuperación](../../scripts/tests/README-audit.md) explican cómo repetir SQLite, HTTP y Android sin utilizar la biblioteca personal. El timeout del paso de reproducción Linux se amplía a 10 minutos para permitir observar la recuperación del watchdog.

Raíz local: `D:/tmp/pletina-stability-fixes-20261008`.

- `npm-test.log` y `frontend-check.log`: frontend final.
- `runs/2026-10-08T18-41-33.148Z-win32-90973df4`: tipos, build y suites de reproducción/favoritos.
- `runs/2026-10-08T18-43-54.248Z-win32-76fb2b5f`: núcleo final.
- `direct-live.log`: descarga real con el código corregido.
- `core/db-after-1`, `core/direct-after-3`, `core/before-after.json`: SQLite y transporte, con hashes de fuente y resultados.
- `android/results.json`, `android/final-source-manifest.json` y logs de instrumentación: regresiones del servicio.
- `windows/build-final.log`, `windows/native-result.json`: build y runtime Windows. SHA256 del ejecutable QA: `efa67413c1009e2c38b999856c15540b6cce268bf6a8459f2337ec800c86881c`.
- `linux/baseline-same-harness`, `linux/fixed-original-runtime`, `linux/fixed-original-runtime-stall`, `linux/fixed-original-runtime-20-cycles`: control anterior, nueva reproducción y recuperación. SHA256 de la variante con bibliotecas originales: `a50395e26e6e31303d8507d9edb901677d0884876a6f7bcbbd5efb24e5129397`.
- `linux/fixed-ubuntu24-stall`: GUI y recuperación con la AppImage compilada en Ubuntu 24. SHA256: `d925803751f11813468d84e816112aee34bb169a56553023202b3ce863259178`.
- `product-source-manifest.json`: hashes de los diez archivos de producto modificados.

## Cobertura que sigue pendiente

Los tests compartidos benefician a Windows, macOS y Linux, pero no acreditan ejecución nativa en macOS: no hay Mac disponible. Faltan teléfonos físicos y Android Auto real, las sesiones largas y la matriz completa de instalación, suspensión, batería, Bluetooth y fallos de almacenamiento. Se conserva el estado histórico de la auditoría para que estas carencias permanezcan visibles. Las correcciones no se han publicado como una versión nueva.
