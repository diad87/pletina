# Arranque frío de Propio — 24 de octubre de 2026

Última ronda: **R12 retirada** (`21e0fa6` → `fedec82`): cambiar la preconexión
a `anonymous` no produjo reutilización TCP/TLS. El código conserva R11.
Comprobación posterior solicitada: **«Ni, Ni, Ni!» funciona por Native**, sin
Legacy ni sesión, con búsqueda incluida: 5234,7 ms en un único intento frío.

Ronda 11: se conserva un ahorro pequeño y repetido en la consulta DNS del
reproductor: **1,9735→0,007 ms de mediana, mejora en los doce pares**. No se
observó reutilización TCP/TLS ni una mejora consistente del arranque completo
entre las dos tandas. Rige el criterio incremental del usuario: cada ahorro
medible cuenta, manteniendo las comprobaciones del audio.

## Cambio y límites

`506986a` sugiere una [preconexión HTML](https://html.spec.whatwg.org/multipage/links.html#link-type-preconnect)
al origen del CDN después de verificar identidad, audio original y descifrado,
mientras continúa la sonda estricta. Sólo pasa un origen HTTPS de Googlevideo,
sin ruta, firma ni parámetros; no adelanta bytes ni reproducción. Conserva el
modo sin `crossorigin` del Audio actual. Admite dos sugerencias nuevas por
30 s, con deduplicación; ese límite no es un contador de sockets físicos y
retirar un enlace no los cierra. La caducidad se revisa al siguiente aviso.

No añade sondeos HTTP ni cambia URL, cabeceras, horarios, cuota compartida de
diez intentos o plazo de ocho segundos. Sigue exigiendo 206, rango exacto al
80 %, longitud, codificación y cuerpo completo; un 429 observado detiene los
reintentos. No hay cambio visual, de base de datos ni de descargas. En móvil
la sugerencia es inactiva: su reproductor nativo tiene otro transporte.

El control `ef6c194` y la candidata llevan la misma instrumentación BENCH:
fases de la sonda Rust y respuestas Media del WebView. Los registros tienen
campos cerrados, sin URL, IP, cookies ni cabeceras. Una cancelación no se marca
como éxito. `bodyMs` incluye validación y lectura; cero bytes leídos tras un
403 no acredita que el servidor enviara un cuerpo vacío. La observación añade
coste común a ambos brazos. En uso normal esos registros están desactivados.

## Medición en la app, sin sesión

Dos cohortes fijadas de doce casos: Epo, Maite y Pupu, dos repeticiones por
brazo, orden alternado, proceso y carpeta de WebView nuevos por caso, con
FreshDecoder. Las 24 carpetas se crean antes de lanzar cada proceso, sin
inspeccionar su contenido. No se reutilizan procesos ni perfiles y se omite la
lectura de caché persistente del decoder; las cachés del sistema y de la red
permanecen. Esta separación del navegador
es mayor que en R10: sus totales no son un control apareado de esta ronda.

| Primera petición Media: mediana | Control | Candidata | Pares con menor tiempo |
|---|---:|---:|---:|
| Consulta DNS | 1,9735 ms | 0,007 ms | 12/12 |
| Conexión, incluido TLS | 13,8365 ms | 12,9935 ms | 9/12 |
| Hasta cabeceras | 23,374 ms | 21,335 ms | 10/12 |
| Conexión reutilizada | 0/12 | 0/12 | — |

Los 24 primeros Media fueron 206/HTTP 1.1, sin caché de disco o service worker;
el observador estaba instalado antes de Music y Media. La diferencia pareada
mediana de DNS fue **−1,9655 ms**, y la de cabeceras, −2,1835 ms. Son offsets
observados por CDP; no prueban que el hint haya abierto un socket anticipado.
Se conserva el beneficio acotado de DNS; **no se acredita ahorro de handshake**.
Valores ausentes o −1 nunca se convierten en cero ni se restan relojes distintos.

| Búsqueda → `playing`: mediana | Control | Candidata | Pares más lentos |
|---|---:|---:|---:|
| Cohorte 1 | 4382,45 ms | 3533,00 ms | 2/6 |
| Cohorte 2 | 4398,65 ms | 4600,90 ms | 3/6 |

El agregado pasa de 4382,45 a 3980 ms; **siete pares mejoran y cinco empeoran**.
La mediana de sus diferencias es −28,1 ms, distinta de restar las medianas
agregadas. Cumplen la referencia de 3500 ms 4/12→5/12. La candidata oscila
entre 3336,7 y 5067,9 ms. Permanecen los casos desfavorables, incluido Maite
C1/repetición 2, que empeora 699,9 ms. Los 24 casos conservan el fallo histórico
del umbral de 300 ms: no se aprueban todas las metas.

La disponibilidad del CDN también difiere entre procesos: sondeos lógicos
terminados 31→29, respuestas 403 19→17, ningún 429 ni cancelación observada.
Dos Epo candidatos de C1 validaron a la primera mientras sus controles tuvieron
403. No se atribuye esa diferencia, ni los 402,45 ms de medianas agregadas,
a precalentar DNS. Dos sondas 206 del control tardaron 245–287 ms, casi todo
hasta cabeceras; la fase posterior de lectura y validación duró unos 0,018 ms.
Esta evidencia no justifica cambiar la lectura ni el calendario de reintentos.

## Validación y procedencia

**24/24 Native, IDs esperados y cero Legacy**. Se observó el prefijo en Audio
silenciado; el cronómetro incluye la búsqueda y excluye el arranque previo de
proceso/página. No mide sonido acústico ni canción completa hasta EOF.
Pasan 253 Rust en el control y **254 en la candidata**, con 30 ignoradas; ocho
controles DOM del script y los checks Android arm64/x86_64, sin avisos nuevos.
Los helpers tienen 64 tests Node/46 aserciones PowerShell y el analizador de red
13 tests; no son pruebas adicionales del producto. JavaScript/tipos no se
repiten para este cambio de Rust y script local, que tiene control DOM propio.

Control EXE: `8f5b7032db4ed9ef5330466ef9ac4bd07395ba206a2db9e153854086954b4ed5`.
Candidata EXE: `a6026c2f68a9d22540ae86c1aafa39ef324ccb9a02fbad79272447160d0bcf26`.
Fuentes, PE de pruebas y logs: `round11-control.local/source-proof.json.local`
y `round11-candidate.local/source-proof.json.local`. Índices cerrados:
`round11-cold-search-20261024-000632-df00c988-index.json.local` y
`round11-cold-search-20261024-000756-3a761864-index.json.local`. Las auditorías
normales y de red verifican procedencia, hashes, perfiles nuevos y las 24 filas.
Análisis: `round11-network-analysis.json.local`, SHA256
`c0915f9bc08eb59eec409fd0f9905d44f08fc3777ad6333e008a8fcca8a0f6f1`.
La revisión independiente de las 24 filas está en
`r11-independent-app-analysis.json.local`, SHA256
`81928752d6d11ef6c7f6e86c6d71b57dfd6e56503dd677a5dbc9e02eba54a942`.

El primer build release de la candidata falló por disco lleno, no por código.
Se conserva el log y se recuperó espacio comprimiendo únicamente caché de
compilación de este worktree; no se eliminaron archivos. La reconstrucción
terminó con las mismas fuentes. Toda la evidencia sigue en `capture-bench.local/`,
fuera de Git; cierre local `round11-final-manifest.json.local`.

Quedan pendientes reducir la espera de disponibilidad del CDN, aprovechar la
conexión del reproductor y estabilizar el total. No se repiten las 30 habituales,
archivos completos, Premium, anuncios reales ni rendimiento en móvil: no hay
nuevas cifras publicitarias ni aprobación de EOF. Oficial sigue experimental,
yt-dlp predeterminado y Propio conserva sus respaldos. Requiere reconstruir la
app; PWA, bundles, receta, `capture.js`, `youtubei.ts`, versiones/API y OTA no
cambian. Sólo se sube la rama de revisión, sin publicar versión o extractor.

## Ronda 12: preconexión anónima descartada

Se ensayó sólo `crossOrigin='anonymous'` antes de insertar el enlace, sin
alterar HTMLAudio ni las comprobaciones del CDN. La hipótesis era una
diferencia de [PrivacyMode entre preconexión](https://github.com/chromium/chromium/blob/main/services/network/network_context.cc)
y [petición real](https://github.com/chromium/chromium/blob/main/net/url_request/url_request_http_job.cc),
no una corrección demostrada de CORS. No se confirmó: **0/12 conexiones
reutilizadas en control y 0/11 en candidata; una respuesta no observada**.
El criterio se fijó antes de medir y el cambio se revirtió con `fedec82`.

Dos cohortes de doce casos, mismos tres IDs y método R11, carpetas anónimas
nuevas, FreshDecoder, sin actividad de compilación simultánea. No se repite
ningún caso fallido. La primera Media es HTTP/1.1 y 206 en las 23 observadas,
sin caché de disco ni Service Worker; mantienen conexión y TLS nuevos.

| Resultado | Control R11 | Candidata R12 |
|---|---:|---:|
| Casos programados | 12 | 12 |
| Native, ID correcto y reproducción observada | 12 | 11 |
| Sin reproducción al agotar el límite operativo | 0 | 1 |
| Mediana hasta reproducción, sólo casos medidos | 4444,8 ms | 4145,4 ms |
| Rango de casos medidos | 3427,6–5391,8 ms | 3274,4–5442,8 ms |
| Casos ≤3500 ms | 3/12 | 3/12 |
| Conexión: mediana de respuestas observadas | 12,804 ms | 13,341 ms |
| Cabeceras: mediana desde la petición Media | 21,067 ms | 21,661 ms |
| Reproducciones Legacy acreditadas | 0 | 0 |
| 429 observados | 0 | 0 |

Los once pares medibles mejoran seis veces y empeoran cinco; mediana del
cambio −83,1 ms. La diferencia entre medianas de poblaciones 12/11 no acredita
un ahorro: el fallo sigue contado y falta el mecanismo de red buscado.
Todos los casos conservan el incumplimiento histórico de 300 ms.

El fallo fue Pupu, cohorte 2, repetición 2: búsqueda Music 200, identidad
esperada y análisis de decoder completo; dos respuestas embedded sólo SABR,
sin URL/cipher. `NATIVE_EMBEDDED_SABR_ONLY` y WEB `video-unavailable` impidieron
llegar a descifrado, sonda, preconexión o Media. El proceso agotó 90 s, sin
selección final ni audio observado. El literal del auditor `wrong-video-id`
representa aquí selección ausente, **no entrega de otra canción**. No se
atribuye ese fallo al atributo, que no llegó a ejecutarse en ese intento.

Pasaron 254 Rust/30 ignoradas y 13 pruebas DOM de la candidata; helpers
77 Node/46 aserciones PowerShell. Tras revertir, las fuentes del producto
coinciden con R11 y pasan los ocho controles DOM del script original. No se
repiten Android, las 30 habituales, EOF, PCM, anuncios ni Premium para un
candidato retirado. La compresión NTFS se limitó a la caché `debug/deps` de
este worktree; recuperó 3,91 GB sin borrar archivos y terminó antes de medir.

Candidata: fuente `21e0fa6623bc6d9abfc0889c77f8d3134b8f7732`, EXE
`db6349bea9924c20f9840db354f1270f57db5d67568e9082000082154f315f64`.
Control: EXE `a6026c2f…bcf26`, fuente `506986a`, sin reetiquetar su procedencia
por los commits posteriores de documentación. Evidencia local ignorada:
`round12-cold-search-20261024-092842-c0ad455a-index.json.local`,
`round12-cold-search-20261024-092949-f8e2c269-index.json.local`, sus dos auditorías
y `round12-network-analysis.json.local` (SHA256
`257635b9e494762e08b000f10b10eb37ae06e00d1d41738b99f637e907898fef`).
Revisión independiente: `r12-independent-app-analysis.json.local`, SHA256
`a57f27aa195e5bcf5b03fb7b3ecc5e3b915058d2fc850be73bd56f21415bd263`.
Cierre previsto: `round12-final-manifest.json.local`, con dos pases de hashes.

Pendientes: disponibilidad del CDN, SABR sin URL y arranque estable. Mover
250→625 ms sería otra hipótesis, aún sin ensayar: puede adelantar o retrasar
375 ms y un intento lento también puede hacer perder el turno de 1 s. Añadir
otro sondeo sin más reduciría el cupo para alternativas. No se modifica el
calendario ni se presenta una mejora de esta ronda.

## Comprobación independiente: «Ni, Ni, Ni!»

Por petición del usuario se comprobó después [la versión Topic de Zazpikoloroa](https://www.youtube.com/watch?v=NGp3dh-hBe8),
ID `NGp3dh-hBe8`, con el binario R11 que corresponde al código restaurado.
Una búsqueda real por título, artista y duración seleccionó ese ID y arrancó
en **5234,7 ms**, Native, sin Legacy ni sesión y con decoder/perfil nuevos.
Los identificadores de pista/disco del banco son sintéticos; no representan
una selección real de Deezer. Hubo cuatro sondas lógicas, la última 206 válido,
y reproducción observada. No verifica EOF ni igualdad PCM. No reemplaza
ninguna de las 24 filas R12 ni se usa como comparación de rendimiento.
Evidencia: `ni-ni-ni-compatibility-verified.json.local`, SHA256
`da1cf0822e1a01d234c7b3ee185e93ab5f68440d6f46a88901fb13fc247e8f8b`.
