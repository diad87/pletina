# Harnesses de datos y descargas

Estos tests no modifican producto ni usan la biblioteca personal. Los perfiles SQLite y los archivos de descarga son sintéticos y se guardan en la carpeta de salida. Usar una carpeta nueva en cada ejecución.

## Frontend

```powershell
node scripts/audit-stability.mjs --profile data --out D:\tmp\pletina-audit
# O sólo la suite:
node --test scripts/tests/audit-frontend.test.mjs
```

Compila el store `downloads.svelte.ts` y el script original de `ImportPlaylist.svelte` con TypeScript y el compilador Svelte. Los accesores de inspección se añaden únicamente en memoria; no cambian los controles de concurrencia. IPC, eventos, reloj y lifecycle son adaptadores de prueba. No valida el DOM, WebView, transporte nativo ni la red.

La suite comprueba que el rechazo de cancelación IPC sea visible y que un `done` duplicado o un progreso tardío no alteren una transferencia terminada. También cubre duplicados en una misma tanda y un nuevo intento después de terminar, cancelar, fallar o quitar una descarga. El comando backend `cancel_downloads` no retorna error de negocio; estas condiciones del puente y los eventos adversariales se inyectan y no prueban que el backend los emita. `npm test` ejecuta esta suite junto con reproducción y favoritos; la compilación de instaladores usa el mismo comando.

## SQLite y transporte de descarga

Requieren Windows, Rust y un `target` ya compilado con las dependencias de `src-tauri/Cargo.lock`. Leen la caché sin ejecutar Cargo ni modificarla; compilan un pequeño ejecutable por harness mediante `rustc`. Si cambian el toolchain o las dependencias hay que regenerar la caché con el build habitual. La compilación falla explícitamente si no encuentra los artefactos esperados.

```powershell
$auditTarget = 'C:\ruta\a\target'
node scripts/tests/audit-db.mjs D:\tmp\pletina-audit\db-01 $auditTarget
node scripts/tests/audit-direct.mjs D:\tmp\pletina-audit\direct-01 $auditTarget
```

`audit-db.mjs` extrae el SQL de migración de los tags `v0.9.0` y `v0.9.1`, siembra valores sintéticos y compila el archivo **real** `src-tauri/src/db.rs`. Comprueba los valores completos de las tablas, backup previo, reapertura, WAL con proceso que sale sin cerrar SQLite, fallos de migración y concurrencia. Los errores de escritura son SQLite real: `query_only` produce `SQLITE_READONLY`, `max_page_count` produce `SQLITE_FULL` y una segunda conexión bloquea con `BEGIN IMMEDIATE`. No simula un volumen físicamente lleno ni ejecuta comandos Tauri. El manifiesto conserva SHA256 de fuente, esquemas y archivo de descarga.

`audit-direct.mjs` compila el archivo **real** `src-tauri/src/direct.rs` y usa HTTP en `127.0.0.1` con puerto efímero, archivos y reintentos reales. Sólo el resolvedor de vídeo y el lector del parámetro `clen` son adaptadores. Cubre HTTP 206 y 200, reanudación, renovación 403, conexión cortada, cambio de formato/tamaño, rango incorrecto, cuerpo excesivo y fallo de rename. Selecciona el reqwest 0.12 del producto mediante sus features; no usa el reqwest del actualizador. No descarga vídeos ni demuestra reproducción Android o audio válido.

El caso de parcial demasiado grande y no borrable se ejecuta en un **proceso hijo propio**: mantiene abierto un handle Windows que deniega borrado y verifica el error antes de llamar al código real. El runner termina sólo ese hijo tras2500ms si el bucle no devuelve. Su temporización es un límite del test; no demuestra una espera de usuario de2500ms. Los procesos normales tienen también límites; no quedan servidores ni tareas en segundo plano.

Cada runner guarda manifiesto, salida de compilación, log, resultados JSON, fixtures y ejecutable en su carpeta. Una aserción fallida devuelve exit 1. Una corrida con fallo de configuración del harness no cuenta como prueba del producto y debe excluirse de la conclusión. Los tests de SQLite y validación de rangos incluidos en los módulos Rust también se ejecutan con `cargo test`.

## Recuperación de audio

`npm test` incluye las regresiones originales y `player-recovery.test.mjs`: bloqueo sin avance, rechazo o timeout al reanudar, pausa durante una renovación, eventos tardíos, cambio de pista y controles MediaSession. El código Svelte es real; audio, IPC y reloj son dobles.

En Android, [android-recovery.ps1](android-recovery.ps1) compila el servicio Kotlin del repositorio y los tests de política, y ejecuta HTTP y Media3 reales en un emulador dedicado. Requiere un APK ARM64 para reutilizar su JNI, Java 21, Gradle y el SDK; su cabecera incluye el comando completo. El paquete de prueba es independiente y no incluye la interfaz Tauri. Las pruebas de conectividad desactivan y restauran la red del emulador; el script rechaza el dispositivo por defecto `emulator-5554` y dispositivos físicos. `-BuildOnly` compila sin instalar. No confundir esa validación con probar una biblioteca Rust recién compilada ni con un teléfono real.

En Linux, `linux-playback.py` usa WebKit y audio reales en una AppImage con un perfil sintético. `--stall-after-resume` fija la velocidad a cero en una fixture WAV y exige que el watchdog recree el decoder conservando URL y posición. `--resume-cycles 20` añade veinte ciclos de seek, pausa y reanudación en la misma pista. El modo provocado comprueba la defensa ante un reloj detenido; no reproduce la causa interna de un bloqueo espontáneo.

```sh
python3 scripts/tests/linux-playback.py Pletina.AppImage --stall-after-resume --output-dir /tmp/pletina-stall
python3 scripts/tests/linux-playback.py Pletina.AppImage --resume-cycles 20 --output-dir /tmp/pletina-resume
```
