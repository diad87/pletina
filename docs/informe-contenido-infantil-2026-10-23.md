# Contenido infantil en Propio — 23 de octubre de 2026

**Estado: tres canciones comprobadas en la app por Native, sin Legacy;
latencia pendiente.** La primera revisión conservó un fallo `CIPHER_MISSING`;
la recuperación posterior se ejercitó realmente con SABR y la app final inició
las tres por audio directo. Se conservan los intentos anteriores. Esto no
aprueba compatibilidad universal ni los objetivos de arranque.
El corpus tiene tres canciones; no representa todo el catálogo infantil.

Se trabaja sólo en `musify-oficial`, rama `p1-oficial`, sin modificar `main`,
publicar una app/receta ni usar cuentas, cookies de cuenta o perfiles Premium.
Los tres bancos de la primera revisión usaron el commit limpio `d426c50f35d50e4de2f9d15203621d337e594677`
y el mismo binario, SHA-256
`afb495c09c893c3d073c66f4a3f84d4cb333c6702ea1054149d5d08bc1c54609`.
Los tres bancos finales usaron el commit limpio
`540521e5237e9eb78e9f2d3f896fa75ceca63276`, binario SHA-256
`2560b6543b83c6ad34b796a9bcc1b8fb0314255576afa016e9dd29ac168e1e54`.

## Búsqueda y arranque en la app

Music ya encontraba los tres IDs esperados con puntuación 112; no había un filtro
local que excluyera estas canciones. Los clientes rápidos no entregaban audio
directo y el control anterior acabó en Legacy. «Inicio» incluye búsqueda y
reproducción silenciada con avance del reloj; no es una escucha acústica.

| Canción | ID de YouTube | Control: Legacy | Primera revisión | Final: Native |
|---|---|---:|---|---:|
| Epoitaitaye | `DJzjkMBMook` | 4911,4 ms | 11831,9 ms; Legacy, `CIPHER_MISSING` | 14191,9 ms |
| Maite Zaitut! | `WtTRMAoN2Fw` | 2322,5 ms | 7726,6 ms; Native | 4873,6 ms |
| Pupu Eta Lore | `kcUgLakr7bU` | 2620,8 ms | 1660,7 ms; Native | 1675,6 ms |

Control `20261023-080957-784f49c6`: 0 Native, 3 fallos Native, 3 Legacy.
Primera revisión `20261023-093521-04ffeb1a`: 2 Native, 1 fallo Native, 1 Legacy.
Final `20261023-100330-55014111`: 3 Native, 0 fallos Native y 0 Legacy.
Ninguna fila cumple 300 ms; los bancos de búsqueda terminan con `ok=false`
por ese umbral, sin otros fallos en la revisión final. Ejercitan arranque, no EOF ni continuidad
completa; los contadores de anuncios ausentes no significan cero anuncios.

## Cambio implementado

VISIONOS sigue primero y conserva su receta. Sólo tras fallar ese nivel se
considera WEB_EMBEDDED_PLAYER, si una respuesta pública confirma el ID, permite
embed y contiene el aviso explícito de contenido infantil. Se descubren versión,
contexto y URL del reproductor; no basta el título ni `isFamilySafe`.
youtubei.js 18.1.0/Meriyah analiza el texto y extrae firma/`n`; QuickJS ejecuta
únicamente el fragmento extraído. Los adultos que resuelve la ruta rápida no
usan este decoder. Windows conserva Legacy; Android no dispone de ese respaldo.

Si algún formato de audio aporta `audioTrack`, `xtags` o idioma, todos los
candidatos deben identificar audio original explícito; ser predeterminado no
basta. Se comparte el parser existente y se rechazan DRC/DRM. Las respuestas
enteramente sin etiquetas conservan compatibilidad: los tres fixtures actuales
tienen cuatro variantes sin metadatos de pista. Esa excepción no demuestra por
sí sola la originalidad semántica de cualquier respuesta futura.

Se verifican ID, HTTPS/GoogleVideo y un 206 exacto con rango, total y cuerpo
completo hacia el 80 %. Los errores CDN transitorios permiten hasta cinco
intentos de la misma URL en ocho segundos; la ruta completa tiene 30 segundos.
No se acepta un 403 ni se acredita EOF con una sonda de 1 KiB.

La recuperación posterior sólo se activa con estado OK, ID correcto, audio
seleccionable sin ninguna URL/cipher y un endpoint SABR HTTPS de GoogleVideo.
Relee la configuración una vez, conservando la anterior ante errores. Sólo
repite el POST si cambia la petición efectiva, incluido ST y cabeceras; se
deduplica por vídeo durante 30 s y comparte el límite total de 30 s. Un cambio
de URL del player sin cambio de petición no provoca otro POST. El contexto
copia diez campos públicos acotados, sin cuenta, petición ni seguimiento.

El A/B de tres pares devolvió cuatro cipher tanto con contexto mínimo como
ampliado: no demuestra causalidad de esos campos. En la prueba real posterior
`kids-embedded-sabr-live.log`, las tres resolvieron en 13858,9 / 4702,0 / 1138,6 ms.
Maite ejercitó SABR_ONLY → petición efectiva nueva → audio aceptado. Cambiaron
visitante, flags y configuración de experimentos; versión y URL del player no.
Son resolución y sonda, separadas del banco de app indicado arriba.

## Resolución directa y reproducción parcial

Banco final `20261023-100445-6c00317a`: 3/3 WEB_EMBEDDED_PLAYER, Opus/251,
sin Legacy, `ok=true`. Todas las sondas de inicio y 80 % devolvieron 206.

| Canción | Resolución | Inicio del Audio | Salto al 80 % + avance de 0,5 s | Cola hasta ended |
|---|---:|---:|---:|---:|
| Epoitaitaye | 8033 ms | 93 ms | 621 ms | 523 ms |
| Maite Zaitut! | 7240 ms | 24 ms | 611 ms | 542 ms |
| Pupu Eta Lore | 1188 ms | 28 ms | 606 ms | 522 ms |

El reloj de Audio comienza después de resolver y sondear la URL: esos 24–93 ms
no son el arranque completo de la app. Se reprodujeron inicio, un tramo al 80 %
y la cola; **no se escucharon las canciones completas en la app**. Duraciones
del Audio: 209,181, 141,621 y 163,301 s. El éxito posterior no borra el fallo
de Epoitaitaye en la búsqueda anterior.
El primer banco directo `20261023-093712-1199f964` también cerró 3/3, con otra
configuración y otros tiempos; sus registros originales se conservan.

## Archivos completos y regresión habitual

En la prueba final separada (`kids-native-full-files-sabr-final.log`), Native descargó los tres
archivos 251 completos. Sus SHA-256 coinciden con referencias descargadas por
yt-dlp y FFmpeg terminó la decodificación de los tres con código 0.

| Canción | Bytes | SHA-256, igual en Native y referencia |
|---|---:|---|
| Epoitaitaye | 3592710 | `306c937476e05e6765865c1596e4e9aca27e7fe390ba7d7485c09861cc4891a9` |
| Maite Zaitut! | 2393910 | `bfa77ce5415db8c86cc199921b7c93d1256ab8805f8dc9cd1e904dc03de38261` |
| Pupu Eta Lore | 2646193 | `cb75b7fe67b69eadb417e9b3dec94844341cf377801dac406ad495ba720ab114` |

Esto acredita esos archivos completos mediante dos extractores, no independencia
total de YouTube ni una auditoría semántica universal de publicidad/contenido.
La descarga y decodificación no sustituyen una escucha continua en la app.

Regresión final `20261023-100639-60b2875c`: las 30 canciones habituales arrancaron por
Native, con 0 fallos Native, 0 Legacy y 0 capturas nuevas. Con búsqueda incluida:
mínimo **463,7 ms**, mediana **592,35 ms**, máximo **1004,6 ms**. Las 30 incumplen
300 ms; no hubo otros fallos. Este banco tampoco mide EOF ni cortes completos.
La primera revisión había registrado 431,7 / 595,5 / 949,1 ms; no se atribuye a
la nueva recuperación una mejora de rendimiento a partir de esta diferencia.

## Diagnóstico CDN y verificaciones

Los primeros ensayos Rust conservaron 403 en Epoitaitaye y Maite Zaitut!.
Sobre las mismas respuestas, QuickJS y V8 produjeron script/ST y firmas/`n`
idénticos. La diferencia inicial de `cver` motivó un A/B con éste y User-Agent:
12/12 sondas posteriores dieron 206; no explicó por sí sola los 403 variables.
Se observaron metadatos de preroll de 6 s y de 15 s con salto a los 5 s, y URLs
que pasaron de 403 a 206 al esperar. Es compatible con disponibilidad temporal;
no demuestra anuncios reproducidos, vistos o saltados. Upstream también calcula
disponibilidad desde esos metadatos en
[`_get_available_at_timestamp`](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/youtube/_video.py#L3618-L3652)
(consulta del 23 de octubre; enlace a `master`, no revisión fijada).

El bundle reproducible tiene 10 pruebas dirigidas; pasaron 387 pruebas JS y el
chequeo de tipos, sin errores. La suite Rust de la recuperación final pasó
196 pruebas, con 26 ignoradas y cero fallos, incluidas las regresiones de pistas
ambiguas, renovación concurrente y POST sin cambios. Android x86_64 y arm64
pasaron `cargo check --tests --offline` sobre esa misma revisión de fuentes.
La última revisión del banco detectó un contrato anterior roto al exigir el
final a todas las URLs. Se corrigió con `nativeTail` explícito sólo en
`native-direct`: los otros bancos conservan su conducta. Tres regresiones
comprueban cola correcta, corrupta y prematura sin exigir buffer completo.
La suite completa de `540521e` había quedado en 383/384 por ese contrato;
`44f75e3` la cerró en 387/387, sin cambios en el código Rust del motor.

El control posterior `20261023-101655-cd4f0059`, compilación limpia de
`44f75e33aaf87981eb939b076b6729c926bd8486`, confirmó el plan con `nativeTail`
real dentro de la app: 3/3 Native/251, sondas 206, saltos al 80 % y finales
correctos. Resoluciones: 13834 / 13852 / 1316 ms; arranques de Audio posteriores:
101 / 34 / 32 ms; salto más avance: 620 / 620 / 607 ms; colas: 523 / 542 / 522 ms.
No repite búsqueda ni cambia los resultados de ese banco en `540521e`.
Binario SHA-256 `288364beb3df04b2e35a8d9a2c3e22cab782b6defe3f8cd123006399e9c5941e`.

Un harness del mismo `youtube_decoder.rs` y bundle pasó 6/6 pruebas de
aislamiento y el fixture real en el AVD `musify-prueba`: Android 15/API 35,
x86_64, WHPX y 2 GiB de RAM. Las cuatro firmas/`n` coincidieron byte a byte con
V8. Preparar tardó 10911,5 ms con los mismos límites, sin ampliarlos; malloc
posterior fue 137757909 bytes, **no pico ni RSS**. Ejecución local
`20261023-094252-0cccbc93`, sin APK, DB, red, resolución nativa, JNI ni ExoPlayer.
No equivale a reproducción Android ni a una medición en dispositivo ARM físico.

QuickJS tiene un trabajador, pila de 512 KiB, preparación de 192 MiB/12 s y
descifrado de 32 MiB/1 s. La espera cuenta en el plazo y cancelar interrumpe el
trabajo. El análisis real en frío en Windows tardó 6,85 s; se conservan hasta
cuatro scripts preparados (8 MiB), sin runtimes. No son medidas de RSS ni
promesas de latencia para otros dispositivos o reproductores.
No se proporcionan red, archivos, DOM, módulos ni callbacks de la aplicación.
El fragmento ejecuta en modo estricto sin entradas públicas de compilación;
no se evalúa el reproductor remoto completo. Es aislamiento dentro del proceso,
no un sandbox del sistema operativo. Los datos en bruto permanecen en `.local`.

## Procedencia y pendientes

| Informe local | SHA-256 del JSON |
|---|---|
| `20261023-093521-04ffeb1a` | `ba3d82ebed9162013afe2a0b6847f2f6d655169696a81818ff9947a95987fbb3` |
| `20261023-093712-1199f964` | `a384caae35d3e89eca6739a7265f5fc86a42dcd1925eedd5c50bfb27a2d305c5` |
| `20261023-093926-faaca128` | `bc057c19790f9016394cb79a573c36dafd6ad14a89d6299e2c873dee5bd497f2` |
| `20261023-100330-55014111` | `026ff64c985a81026dae3ca490014baf6a19f205f8b9c3f629c1982c1fc07187` |
| `20261023-100445-6c00317a` | `17a548c74214e54524d4c1d10c607b78f5b4f722a8391f921a5ae3876ab06cf4` |
| `20261023-100639-60b2875c` | `c21382afed7ef76c27408f07e95bb7789e580c332b8303374a713802a1c81431` |
| `20261023-101655-cd4f0059` | `cdb904d717e033d73a0b7f04071a68c37034f2d569a5523cb40028b03c9d36ba` |

Harness Android: ELF `753a2912e4509f87e659cd75724f943f89ae49b7ad0a6ed074df53eb02fad0b6`;
fuente decoder `797f8e90db3026fb16ef654a4c33fb335960c9c5bd9a4552436e1375baf8b97a`;
bundle `6a18ed0ae8c909c36d5b96731fad6bb3fc9a5ea4088ed4865266f0f98c35f0e6`.

Base de los bancos: integración de `b1733bb` (Pletina 0.9.1). El `origin/main`
consultado en esta tarea, `4b5691f` (0.11.2), no forma parte de esta medición;
habrá que integrar y validar esa base antes de preparar una publicación.

Commits de código: `9098acb` (reproducción del fallo), `3a5f724` (decoder y ruta
infantil), `d426c50` (original explícito en pistas etiquetadas), `540521e`
(renovación SABR), `44f75e3` (banco de cola nativa y validación). Las evidencias
completas permanecen ignoradas, fuera de Git.
Sin cambios en db.rs, downloads.rs, interfaz visual ni versiones/protocolo OTA.

La mejora requiere una versión nueva de la app: receta/scripts no sustituyen
este Rust compilado. Escritorio la descarga en segundo plano y la instala al
cerrar/reiniciar; Android necesita un APK actualizado; la PWA requiere una
integración web equivalente. No se ha publicado ninguno en esta tarea.

Pendiente: reducir el análisis en frío y la espera de inicio; ampliar el corpus
infantil, escuchar canciones completas en la app y probar reproducción Android
con JNI/ExoPlayer en ARM físico. La renovación mantiene el mutex global de
configuración durante la preparación y puede retrasar otras resoluciones;
su prioridad bajo precarga no se ha medido. No hay nueva tanda Premium ni se
acreditan anuncios vistos/saltados: sólo archivos originales coincidentes en
estos tres casos. La progresiva Oficial conserva sus criterios pendientes.
Las comprobaciones positivas no autorizan declarar compatibilidad total ni
ausencia universal de anuncios; se conserva el historial de intentos fallidos.

Continuación: el [informe de arranque frío](informe-arranque-frio-2026-10-23.md)
documenta `8983e26`, la preparación optimizada y la caché persistente, con un
control consecutivo del binario anterior. Conserva separados el primer análisis,
el reinicio y la espera CDN; no reemplaza los resultados e intentos de este informe.
