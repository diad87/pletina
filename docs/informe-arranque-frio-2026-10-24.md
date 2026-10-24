# Arranque frío de Propio — 24 de octubre de 2026

Última ronda: **R15 solapa los metadatos con la comprobación del vídeo también
al acertar la caché de disco** (`025f9e8`). Diez pares elegibles: ocho mejoran y
dos empeoran, cambio mediano **−270,1 ms** hasta `playing`. La espera tras validar
el vídeo para consumir los metadatos pasa de 232,35 a 0,36 ms de mediana.
Ayuda al reabrir con caché; no cambia el primer uso con caché vacía. El total
sigue variable, hasta 5611 ms en la candidata. [Método y límites R15](#ronda-15-metadatos-en-paralelo-con-caché-verificada).

R14 conserva el análisis verificado en disco durante 30 días en vez de seis
horas (`38a4ded`), evitando repetirlo si la fuente actual es idéntica. Sus
mediciones y regresiones permanecen [separadas](#ronda-14-conservar-el-análisis-verificado-entre-días).

R12 se retiró (`21e0fa6` → `fedec82`): la preconexión `anonymous` no produjo
reutilización TCP/TLS. R13 se descartó antes de integrar código. La
comprobación independiente de **«Ni, Ni, Ni!» funciona por Native**, sin
Legacy ni sesión: 5234,7 ms en un único intento frío con búsqueda incluida.

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

## Ronda 13: optimización del parser descartada

Se ensayó fuera del producto un atajo ASCII al buscar palabras reservadas.
Conservó los 1429 casos de sintaxis y 32 resultados exactos de firma/n; los
16 procesos QuickJS nuevos dieron resultados correctos. Sólo tres de ocho
pares mejoraron: mediana del cambio **+43,5 ms**, con medianas por repetición
de −218 y +844,5 ms. No cumplió el criterio previo; no se integró ni se midió en la app.
El prototipo, los fallos iniciales de helpers anteriores a las mediciones y
todas las filas permanecen ignorados. Resultado:
`keyword-ascii.local/quickjs-20261024-105710.local/result.json.local`, SHA256
`023657d09adb7351979e3d5ae44a93beed461755e804ff1d06457d09fdbddf5a`.

## Ronda 14: conservar el análisis verificado entre días

`38a4ded` amplía sólo la vida del decoder preparado **en disco, 6 h→30 días**.
Antes de consultarlo sigue descargando el reproductor actual y exige URL,
SHA256 de esa fuente, ABI y checksum exactos. Si cambia la fuente o el
analizador, no hay acierto. Leer no renueva su edad. Se conservan cuatro
entradas/8 MiB, los límites y las comprobaciones de identidad, audio original,
firma/n y sonda 206 al 80 %. No amplía las cachés en RAM/configuración de
seis horas. La ABI actual vincula los assets y el código del decoder; un
cambio futuro de semántica del motor también deberá invalidarla explícitamente.

Se fijaron dos cohortes de doce casos sin sesión: Epo, Maite y Pupu dos veces
por brazo, orden alternado, proceso y carpeta de WebView nuevos. Ambos brazos
reciben antes de cada caso los mismos cuatro registros derivados con edad
controlada de doce horas; sólo cambian fecha y checksum respecto al original.
FreshDecoder está ausente. No representa primer uso, caché vacía ni doce horas
de envejecimiento natural. Se restaura el inventario original tras cada caso;
las 24 restauraciones y los dos inventarios finales coinciden. No se leen
perfiles, cuentas ni contenido de SQLite.

**24/24 Native, ID correcto, cero Legacy**. Control: doce preparaciones
`analyzed`; candidata: doce `disk`, todas con descarga de fuente actual.
La auditoría admite **23 filas y once pares completos**: el primer Epo del
control reutilizó un PID cuyo archivo de DB de pruebas se creó el día anterior.
Falla la prueba previa de frescura del archivo, aunque reprodujo correctamente.
Se conserva su tiempo descriptivo, sin repetirlo ni dispensar el requisito.
Los bindings observados de fuente/ABI/script/ST no cambiaron; el binario antiguo
no registra el fingerprint por petición, por lo que no se acredita igualdad
exacta de la variante remota entre brazos sólo por compartir el fixture.

| Mediana, salvo contadores | Control R11 | Candidata R14 |
|---|---:|---:|
| Preparación, doce casos por brazo | 2741,6 ms | 66,1 ms |
| Búsqueda → `playing`, todos los tiempos descriptivos | 4541,6 ms | 3932,6 ms |
| Búsqueda → `playing`, sólo once pares elegibles | 4515,8 ms | 5574,3 ms |
| Pupu, cuatro pares elegibles | 3532,1 ms | 1706,1 ms |
| Maite, cuatro pares elegibles | 4783,3 ms | 5736,2 ms |
| Casos ≤3500 ms, todos los tiempos | 2/12 | 6/12 |
| Sondeos lógicos completados / respuestas 403 | 31 / 19 | 48 / 36 |
| 429 observados | 0 | 0 |

En los once pares elegibles mejoran seis y empeoran cinco; la mediana de sus
diferencias es **−53,6 ms**. Restar las medianas de cada brazo produce otra
cifra: esta muestra pequeña es sensible al orden y a las esperas remotas.
Pupu mejora en cuatro de cuatro pares, mediana pareada −1780,0 ms. Maite
empeora en tres de cuatro; su ventana de sonda CDN pasa de 1289,4 a 4030,0 ms
de mediana. La candidata alcanza 5916,0 ms. No se afirma una mejora uniforme
del total ni el cumplimiento estable de 3500 ms.

La preparación mejora en las dos cohortes: cambios pareados medianos de
−2719,2 ms en los cinco pares elegibles de C1 y −2624,3 ms en los seis de C2.
Incluye descarga y trabajo de metadatos solapado; no es tiempo puro de CPU
ni se suma a otras fases. Se conserva el cambio por evitar el análisis
repetido y el beneficio observado en Pupu, con las regresiones totales visibles.
Las primeras 24 Media fueron 206/HTTP 1.1, sin reutilización de conexión ni
caché del navegador. La política CDN no cambia: nueve turnos, diez intentos
compartidos y ocho segundos. Más 403 tras llegar antes al CDN no demuestran
una causa publicitaria ni justifican añadir intentos sin otra prueba.

Validación: **256 pruebas Rust aprobadas, 30 ignoradas**, dos nuevas sobre edad
y vinculación exacta. El helper de cierre falló después de finalizar los tests
por serialización de PowerShell; se recuperó la prueba del mismo log y PE,
sin repetirlos. No quedó persistido el exit code de Cargo; sí su resumen
correcto y `build-finished.success`. Build release y checks Android arm64 y
x86_64 `--tests --offline --locked` con exit 0, sin avisos nuevos en los checks.
Helpers: 99 tests Node, 71 aserciones PowerShell y siete checks de sintaxis.
No se repiten tipos/JavaScript para un cambio aislado del almacén Rust.

Control EXE `a6026c2f…bcf26`, fuente `506986a`, conservando su procedencia.
Candidata EXE
`708384d1ed4ce6140f4ab3195da5948736dd55a1cf37ee896f16ddac16e104e1`,
fuente `38a4ded`. Evidencia ignorada en `capture-bench.local/`:

- Índices `round14-cold-search-20261024-112615-a208e23c-index.json.local` y
  `round14-cold-search-20261024-112855-cf95f71a-index.json.local`, con sus recibos.
- Fixture `round14-aged-cache-fixture.local/manifest.json.local`, SHA256
  `7275b5300a28343e7688f2d40168ad72bc41c18a958720f439da0237b5ca4507`.
- Revisión independiente `r14-independent-app-analysis.json.local`, SHA256
  `7fa5081579768b65d33bf4cc89cdb486e79af4056eeab821139dc5b138915d29`.
- Red `round14-network-analysis.json.local`, SHA256
  `ea66d96de08e121e312e4ea34a3b02f97b5a3d86dbd3b1f59bffc9b7c05922a7`.
- Fuentes/log/PE `round14-candidate.local/source-proof.json.local`, SHA256
  `a14dd046830a16f4ed5de0e8392e99237694c010404f432e1a0c14be0211b27f`.
- Android `round14-final-android-clang-vendor-checks-20261024-113328.json.local`,
  SHA256 `dbd6a4d628ca158569f7f64a87d46c62e0bf93c1181b759a7468ee9a64ac73a4`.

Cierre local: `round14-final-manifest.json.local`, después del commit de docs,
con dos pases de hashes. No se acredita canción completa, EOF, PCM, las 30
habituales, campañas de anuncios, Premium ni rendimiento móvil. La ventana
breve silenciada no observó cortes, pero no sustituye esas pruebas. Oficial
sigue experimental, yt-dlp predeterminado y Propio conserva sus respaldos.
El cambio requiere reconstruir la app; PWA, receta, `capture.js`, `youtubei.ts`,
versiones/API y OTA no cambian. Sólo rama de revisión, sin publicación.

Al cerrar R14 quedó identificado este solapamiento, **entonces sin implementar**:
un acierto de disco espera al resultado de `watch` antes del POST de metadatos.
La ruta con análisis ya puede enviarlo en paralelo y retener su respuesta hasta
admitir la identidad. Se estudiará reutilizar ese mismo mecanismo, con
cancelación, plazo y cupo intactos; no adelantar descifrado ni acceso al audio.
Los GET iniciales de watch/embed ya se solapan con los clientes rápidos.
Analizar anticipadamente la variante de la portada requiere comprobarla: no
siempre coincide con la de embedded.

## Ronda 15: metadatos en paralelo con caché verificada

`025f9e8` adelanta un único POST de metadatos sólo cuando el decoder viene de
disco, hay ID y no se está preparando una fuente de reemplazo. El ST procede
del decoder vinculado a la fuente recién descargada. Instala el decoder y
limpia su reserva antes de liberar COMPILED y esperar la petición. Conserva
la cuarentena de `admitted_request`: ni éxito ni error se consumen antes de
admitir la identidad de `watch`; no adelanta descifrado, recuperación ni CDN.
Las rutas RAM, memory-sha, análisis y reemplazo mantienen su comportamiento.

Conserva el resultado incluso si es un error para consumir POST1 una sola vez.
No emite EarlySabr en este camino: no hay AST pendiente. La recuperación
secuencial sigue admitiendo sólo POST2 con cuerpo efectivo distinto y una
renovación. El POST anticipado comparte los 12 s de preparación; un caso lento
puede fallar antes que en el control, que lo enviaba después. Cancelar conserva
el decoder válido y no deja cooldown. No amplía plazos ni cuotas.

Comparación anónima fijada antes de medir: dos cohortes de doce, Epo/Maite/Pupu,
dos repeticiones por brazo y orden alternado. Proceso y carpeta de WebView nuevos
por caso; FreshDecoder ausente. Ambos brazos reciben los mismos bytes de la
fixture R14, fijada inicialmente a doce horas, y descargan la fuente actual.
**Las 24 preparaciones iniciales son disk**; aquí no se compara análisis con
caché ni se mide primer uso. No hubo repeticiones de casos ni cohortes extra.
El control no registra el fingerprint por petición: compartir la fixture no
prueba una repetición exacta de la variante remota, aunque cada acierto siga
exigiendo coincidencia con la fuente actual.

**24/24 Native, IDs correctos y cero Legacy**. Son **22 filas elegibles y diez
pares completos**, cinco por cohorte. Se conservan dos exclusiones:

- C1/Pupu/candidata/repetición 2: después del disk inicial correcto, una
  recuperación SABR añadió una preparación RAM sin ID y un segundo POST. El
  comprobador congelado exige una sola preparación y la excluye; no se modifica
  después de medir, aunque la recuperación termine reproduciendo correctamente.
- C2/Pupu/control/repetición 1: falla la prueba de frescura de un archivo DB
  preexistente con el mismo PID. Sólo se inspeccionó su metadata, sin abrir SQLite.

| Pares completos elegibles | Cohorte 1 | Cohorte 2 |
|---|---:|---:|
| Número de pares | 5 | 5 |
| Mejoran / empeoran hasta `playing` | 4 / 1 | 4 / 1 |
| Mediana candidata − control, hasta `playing` | −66,1 ms | −1123,1 ms |
| Mediana del cambio watch → primer Consumed | −252,85 ms | −235,07 ms |

Cumple el criterio previo de mejora pareada en ambas cohortes y mínimo diez
pares. Se conserva el cambio. El cambio total mediano de los diez pares es
**−270,1 ms**. Los doce POST iniciales candidatos empiezan antes de terminar
`watch`; los doce controles esperan. ST y orden de consumo coinciden, sin
contradicciones observadas. La espera watch → Consumed pasa de **232,35 a
0,36 ms** de mediana en los doce casos por brazo. Es una medición del mismo
reloj Native, no una resta entre relojes de navegador y Rust.

Los 24 tiempos, incluidos los dos casos excluidos, dan medianas descriptivas
de 3309,0→1840,65 ms y rangos 1650,8–6600,4→1301,2–5611,0 ms. Llegan a ≤3500 ms
6/12→7/12. No se atribuyen esos 1468,35 ms de diferencia agregada al código ni
se suman a los ahorros R14. Las dos regresiones elegibles quedan visibles:
Maite C1/repetición 1, **+44,1 ms**, y Epo C2/repetición 1, **+2966,3 ms**.
La espera CDN sigue variable; no se acredita un arranque uniforme de 3500 ms.

Se observaron 12 POST en control y 13 en candidata, máximo dos por caso; la
petición adicional corresponde a la recuperación SABR de Pupu conservada.
Sondeos lógicos completados 47→38, respuestas 403 35→26 y ningún 429. No se
acredita que toda esa diferencia remota proceda del solapamiento ni que un
403 sea un anuncio. Los 24 primeros Media fueron 206/HTTP 1.1 y ninguna conexión
se reutilizó. Se verificó igualdad de los bloques de sonda estricta, calendario,
validación/selección de audio y cuerpo de metadatos frente a R14: mismos nueve
turnos, diez intentos compartidos y ocho segundos, con validación al 80 % y
cuerpo de sonda completo. El límite de logs sigue siendo invocaciones lógicas
completadas, no un inventario de GET físicos y redirecciones.

Pasan **261 Rust, cero fallos/30 ignoradas**, exit 0 y sin avisos del compilador
de tests. Cinco pruebas nuevas cubren exclusiones, POST HTTP local/ST, mutex,
cuarentena, cancelación y recuperación de uno/dos POST. Ejercitan el helper y
las primitivas reales, no una lectura persistente completa. Build release y
checks Android arm64/x86_64 `--tests --offline --locked`: exit 0, sin avisos
nuevos en los checks. Helpers: 108 tests Node/72 aserciones PowerShell/siete
checks de sintaxis. Las fuentes quedan intactas durante validación y medidas.

Control EXE `708384d1…04e1`, fuente `38a4ded`; candidata, fuente `025f9e8`, EXE
`d78efd571e41bad902aeb95d4fbfd06ae99c17a85112fdb809646f15de5c8930`.
Evidencia ignorada en `capture-bench.local/`: índices
`round15-cold-search-20261024-120939-3c4e4f57-index.json.local` y
`round15-cold-search-20261024-121149-7dcc04b6-index.json.local`, sus auditorías,
`round15-network-analysis.json.local` (SHA256
`13b90d88001d145230d99fa9d1518a823380e9eed4c6e3e23fe0436ac39173db`),
`r15-independent-app-analysis.json.local` (SHA256
`4fe2958ebc0f6aa69b27fb6d9077db2fe81cac3c5f27eb9971838a4b21aa13cf`),
`round15-candidate.local/source-proof.json.local` y
`round15-policy-equivalence.json.local`. Android:
`round15-final-android-clang-vendor-checks-20261024-121508.json.local`, SHA256
`b230776d18f07962265d0aabe6cd73da8d7fead20b330f34de734fa9b93c428a`.
Cierre después del commit de docs: `round15-final-manifest.json.local`, dos
pases de hashes, sin incluir perfiles ni DB. Originales de caché restaurados.

No se repiten EOF, PCM, las 30 habituales, campañas reales con anuncios, Premium
ni rendimiento móvil. La observación breve de HTMLAudio silenciado no sustituye
esas pruebas. Oficial sigue experimental, yt-dlp predeterminado y Propio
conserva sus respaldos. Requiere nueva app; PWA/OTA, receta, capture.js,
youtubei.ts, versiones/API, UI, db.rs y downloads.rs no cambian. Sólo rama de
revisión; no se publica versión ni extractor. Pendientes: disponibilidad CDN,
primer uso sin caché y corregir el exceso de rigor del helper en una futura
campaña, conservando las exclusiones de ésta.
