# Arranque frío de Propio — 23 de octubre de 2026

**Ronda 10: una oportunidad adicional durante la espera del CDN.**
Se conserva una comprobación a 1,5 s dentro del hueco entre los turnos antiguos.
En cuatro intentos recibió el fragmento válido 467–475 ms antes del siguiente
turno de 2 s, después de tres rechazos. Es un adelanto dentro de esa espera;
la comparación entre procesos todavía no acredita un menor primer sonido total.
El [cierre R10](#ronda-10-oportunidad-adicional-durante-la-espera-del-cdn)
incluye los dos experimentos, los pares desfavorables y un inicio de 9356 ms.

**Cierre anterior, ronda 9:**
Se conservan dos cambios pequeños: seis copias JSON evitadas y una llamada
IPC menos al descartar ambas precargas. Las 30 canciones habituales arrancan
por Native, con los IDs esperados y cero Legacy: mediana 631,7 ms en una tanda,
sin atribuir la diferencia frente a otras tandas a estos cambios. En frío, la
candidata usa Native en sus seis intentos, con tiempos de 3438,7–5694,4 ms.
El [cierre R9](#ronda-9-mejoras-pequeñas-y-medición-del-total) conserva también
el control que recurrió a Legacy y el defecto de clasificación del banco.

**Criterio vigente del usuario:** 3,5 s es una referencia. Se acepta cualquier
mejora pequeña, medible y repetible, indicando su alcance y conservando las
comprobaciones de identidad, audio original, aislamiento y límites.

**Cierre anterior, ronda 8:**
La nueva comparación fría de la app dio 3649,15 ms de mediana en R7 y
3950,70 ms en el candidato con contexto oficial; cuatro de seis pares
empeoraron. Sólo 1/6 y 2/6, respectivamente, cumplieron 3500 ms, siempre
Pupu. Los doce fueron Native, con identidad correcta y sin Legacy.
El candidato `fa46e10` se retiró mediante `ab7f7ff`; código y binario de
banco quedaron restaurados a R7. No se presenta la variación entre tandas
como una mejora de producto. La meta estable de 3,5 s sigue pendiente.

Las pruebas CDN no justificaron añadir parámetros, cambiar de servidor
ni adelantar sondas. En Maite hubo rechazos a unos 3 s y éxitos a unos
4 s desde el POST; Epo seguía rechazando a 4 s. Son muestras, no un
umbral universal ni prueba de publicidad. Todo se midió sin sesión.
Se conservan los fallos y el [informe infantil](informe-contenido-infantil-2026-10-23.md).

## Ronda 1: cambios y límites

- QuickJS C usa optimización O2 en release; el resto de la app conserva `s`.
  En desarrollo ya se usaba O2: no se atribuye a esa opción la diferencia de los bancos de app.
- El POST del player puede solaparse con el análisis usando un ST provisional.
  Sólo se reutiliza su respuesta si coincide con el ST del analizador completo;
  siguen vigentes las comprobaciones de identidad, audio original, firma y sonda.
- La caché persistente del decoder admite cuatro entradas, 8 MiB y seis horas.
  Para leerla se descarga de nuevo el JS y se vinculan URL, SHA de fuente y
  versión del bundle/runtime. Detecta corrupción, caducidad y cambios; un fallo
  vuelve al análisis. No guarda URLs de audio, cookies ni runtimes. Sus hashes
  no autentican archivos frente a un usuario local que pueda reescribirlos.
- Se mantienen un trabajador, preparación de 192 MiB/12 s, descifrado de
  32 MiB/1 s y pila de 512 KiB. No hay E/S dentro de QuickJS ni evaluación del
  player completo; sigue siendo aislamiento dentro del proceso, no del sistema operativo.

El perfil offline (`decoder-cold-profile-summary.json.local`) dio **7804 → 6604 ms** de mediana al cambiar
C de `s` a O2, tres pasadas por opción. El harness final release dio 6219 ms,
cuatro firmas/`n` idénticas y 6/6 pruebas de aislamiento. La biblioteca C estática
pasó de 2,10 a 3,09 MB; no se ha medido el incremento del ejecutable/APK.
Parseo y dependencias consumieron aproximadamente la mitad cada uno. Cambiar
el recorrido AST o el umbral de GC no mejoró QuickJS consistentemente y se descartó.
En esta primera ronda el bundle permaneció idéntico: 297436 bytes, SHA-256 `6a18ed0ae8c909c36d5b96731fad6bb3fc9a5ea4088ed4865266f0f98c35f0e6`.

## Ronda 1: app aislada, comparación consecutiva

Milisegundos de resolución directa, sin búsqueda. `FreshDecoder` omite sólo
lecturas de disco en el banco: conserva memoria, escrituras y todas las guardas.
No significa que cada fila analice un reproductor diferente desde cero.
**Los 1252 ms de Pupu reutilizaban memoria de esa tanda: no eran un primer
arranque del decoder en un proceso nuevo.**

| Canción | Binario anterior | Nuevo FreshDecoder | Nuevo tras reiniciar |
|---|---:|---:|---:|
| Epoitaitaye | 14086 | 7525 | 7530 |
| Maite Zaitut! | 10410 | 7606 | 7423 |
| Pupu Eta Lore | 1547 | 1252 | 1224 |

Las nueve filas usaron WEB_EMBEDDED_PLAYER/251, con sondas 206 de inicio/80 %
y audio, salto y cola correctos. En el nuevo banco frío, iniciar Audio **después
de resolver** tardó 92/24/27 ms; seek al 80 % con avance de 0,5 s, 623/624/607 ms;
cola hasta `ended`, 522/543/521 ms. No fue escucha continua completa ni prueba acústica.

La preparación fría de Epo/Maite tardó 6292/6677 ms, incluyendo descarga,
POST paralelo y guardado; Pupu reutilizó memoria. Tras reiniciar, Epo cargó de
disco en 115 ms, incluida descarga del JS, y las otras filas usaron memoria.
El total apenas bajó porque persistió la espera CDN; no es arranque instantáneo
ni demuestra qué causó esa espera. Un 403 temporal no acredita publicidad.

| Búsqueda + primer audio | FreshDecoder | Tras reiniciar |
|---|---:|---:|
| Epoitaitaye | 8311,8 ms | 8398,5 ms |
| Maite Zaitut! | 7633,2 ms | 8049,8 ms |
| Pupu Eta Lore | 1676,1 ms | 1518,9 ms |

Seis filas Native, cero Legacy; sin estancamientos después del inicio en la
ventana breve observada, con esperas iniciales registradas. Todas incumplen
300 ms. Preparar Epo pasó de 6439 ms a 141 ms desde disco; el resto usó memoria.
Regresión habitual: **30 Native, 0 Legacy**, mínimo 448,2, mediana 587,55 y máximo
1031,7 ms; sólo falla 300 ms en las 30. La tanda previa dio 463,7/592,35/1004,6 ms:
no basta para atribuir una mejora al nivel rápido. No acredita EOF o cortes completos.

Por separado (`kids-cold-full-files.log`) se descargaron los tres archivos 251 completos: hashes
idénticos a las referencias yt-dlp del [informe infantil](informe-contenido-infantil-2026-10-23.md#archivos-completos-y-regresión-habitual)
y tres decodificaciones FFmpeg `-xerror` con salida 0. No sustituye escuchar las
canciones enteras en la app ni una campaña de transiciones publicitarias.

## Ronda 1: procedencia y validación

Código nuevo: `8983e26`. El candidato se compiló sobre `9892b9c` con los cambios
de ese código todavía sin commit; SHA del binario
`f013e35b94c7a800fb96cf19bc156e990c92894135906525e15221c0568784b4`.
El control ejecutado consecutivamente fue el binario inmutable `44f75e3`, SHA
`288364beb3df04b2e35a8d9a2c3e22cab782b6defe3f8cd123006399e9c5941e`.

Resultados JSON conservados en `capture-bench.local`, fuera de Git; SHA-256:

| Informe | SHA-256 |
|---|---|
| `result-kids-cold-reference.local.json` | `b42e633b0296ef9269cd4ef55421ddc3a1bc7a851c574ba8b561132fe4ecb5f0` |
| `20261023-105353-8340dd35` directo frío | `56833e0b234b0c2e9495cfcee0b9b09f411fdf7c5efeb91b251d8904117a38d3` |
| `20261023-105502-0d22a7c3` directo reinicio | `60b0a468a516a4cc8548a5d0c7af8b991811e1521d73d2128e58f7bfb92e87bf` |
| `20261023-105134-e2712c2d` búsqueda fría | `4cab1c3826c244f2cc64e83b590b42c6054ced178fda16424927cbffbe2f5d3b` |
| `20261023-105239-9ad10c97` búsqueda reinicio | `674871e7143f24d5a7a42c38d40dd5def82889a7414c9d3e8467d5bb780f7477` |
| `20261023-105639-7f1ce41a` regresión 30 | `2de53969307275cbe2660318dbde55c90272594a00d8d4d5766b61fb6719a1a3` |

Pasaron 207 pruebas Rust (27 ignoradas), 387 JavaScript, tipos sin errores ni
avisos y checks Android arm64/x86_64 sin avisos nuevos. El primer pase Rust falló
por `WouldBlock` en un socket local del test; se corrigió su modo bloqueante y
se repitió completo. No se repitió rendimiento Android ni reproducción JNI/ExoPlayer.

Trabajo sólo en `p1-oficial`, base Pletina 0.9.1; main posterior sigue pendiente
de integración. Sin sesión, cookies de cuenta ni Premium. No se midieron anuncios
vistos/saltados ni se promueve Oficial. No se publica app, PWA, receta ni OTA.
Quedan pendientes la meta de arranque, más corpus, escucha continua y dispositivos reales.

## Ronda 2: preparación selectiva y arranque realmente frío

El analizador privado, fijado a youtubei.js 18.1.0, calcula las dependencias
sólo cuando las necesita el fragmento seleccionado: evita 4514 de 5329 recorridos
en el fixture medido. Conserva la presencia histórica de cada declaración y el
orden de emisión; usa las reglas originales de dependencias, matchers y parser.
No evalúa el player completo. Las cuatro firmas/`n`, el ST y el script emitido
coinciden exactamente con el control, también al preparar repetidamente.

QuickJS pasó de unos 6,0 s en el perfil anterior a **3887,7 ms** en el harness
productivo final; los 3,5 s del prototipo eran tiempo de preparación, no sonido.
No se repiten aquí los cambios de recorrido/GC descartados en la primera ronda.
Un puente experimental Oxc produjo el AST en 89,9 ms, pero su JSON de 46,35 MB
agotó el límite QuickJS al importarse: no se incorpora ni se amplían las guardas.

El descubrimiento admite gzip con límite de **4 MiB ya descomprimidos**. Identidad
pública, configuración y preparación local se solapan; el POST espera la
confirmación infantil y del ID. La sonda conserva sus comprobaciones 206 y
puede reintentar la misma URL en 0/0,25/1/2/3/4/5/6 s, máximo ocho intentos dentro
de ocho segundos. Omite turnos vencidos, con 50 ms de margen del planificador;
un 429 detiene los reintentos. No se interpreta un 403 temporal como publicidad.

Cada fila siguiente es el primer vídeo de **su propio proceso**, sin sesión,
con `FreshDecoder` y preparación `analyzed`. El control inmutable anterior no
guardaba el total hasta `playing`: sólo su extracción es comparable. Todos los
tiempos de app de este informe son **debug**, no release.

| Canción | Control: extracción | Nuevo: extracción | Nuevo: IPC → `playing` |
|---|---:|---:|---:|
| Epoitaitaye | 7617 ms | 4848 ms | 4979 ms |
| Maite Zaitut! | 14160 ms | 5376 ms | 5504 ms |
| Pupu Eta Lore | 7667 ms | 4376 ms | 4499 ms |

El total nuevo incluye IPC, sondas y arranque de Audio silenciado; mide un evento
de reproducción, no una medición acústica. Las seis filas usaron Native/251 con
sondas 206 e inicio, salto y cola correctos. No fueron escuchas continuas completas.
Una primera repetición del candidato dio extracción 4869/5390/4292 ms. Parte de
la diferencia frente al control depende de la disponibilidad CDN: no se atribuye
toda la reducción al analizador ni se promete este tiempo para todo el catálogo.

La tanda con búsqueda incluida dio **5926/5550,9/1492 ms**, tres Native y cero
Legacy; sólo incumple 300 ms. Reutilizó decoders de disco/memoria/disco: no es
otra medición de primer análisis frío. El reinicio del candidato inicial dio
extracción 4734/5249/1299 ms; sus preparaciones fueron análisis/disco/memoria,
respectivamente. La caché reduce trabajo, pero no elimina la disponibilidad CDN.

La regresión habitual conservó **30 Native, 0 Legacy**, con mínimo 439,9,
mediana 612,4 y máximo 1120 ms. Todas incumplen 300 ms. Además, Octopus's Garden
eligió `A7coEcXjd7Q` frente a `BynfJeqdwQU` del corpus: sólo 29/30 IDs coinciden.
Se conserva ese fallo de selección; no se presenta esta tanda como treinta
identidades correctas. Dos controles posteriores, binario anterior y actual,
eligieron el ID esperado con el algoritmo de búsqueda sin cambios: compatible
con variación de candidatos remotos, no una regresión determinista acreditada.
El corpus espera la mezcla 2019 aunque la pista Deezer indique Remastered 2009;
no se ha demostrado equivalencia de mezclas. Este banco no mide EOF o continuidad.

Se repitió la descarga completa de los tres archivos 251 con el candidato:
hashes idénticos a las referencias anteriores y tres decodificaciones FFmpeg
`-xerror` con salida 0 (`kids-cold-accepted-full-files.log` y
`kids-cold-accepted-complete-audio.local.json`). Sólo acredita estos tres archivos;
no sustituye la escucha continua en la app ni una campaña publicitaria.

El control corresponde al código `8983e26`, binario `f013e35b94c7a800fb96cf19bc156e990c92894135906525e15221c0568784b4`.
El código final es `0aa9e1c`. El candidato se compiló sobre `5915dd1` con esos
cambios todavía sin commit,
binario `4d6a29eab5a228a5303fe80fd94a0193c4b177133378934c78596af64ccbee5b`;
la repetición inicial usó `f93fde37100eff354a59fada0a3c548d94c9aad6492fd71b0c7eac871f572718d`.
El nuevo bundle mide 300001 bytes, SHA-256
`c632a24294f1b6fbc60ae98e76f8d0424abd36d0127db41b2c15471ccb782206`.

| Informe de la ronda 2 | SHA-256 |
|---|---|
| `result-more-reference-DJzjkMBMook.local.json` | `711fcf1579b04e7eeb2ef3b5ffe582ec3c430d987c851f1c23dfbbc9a766eca8` |
| `result-more-reference-WtTRMAoN2Fw.local.json` | `69659f0b9011d063acb60615f4a1f96af9fe3887f773580c65f728abe6472252` |
| `result-more-reference-kcUgLakr7bU.local.json` | `6136ede2d26202f2232c7d8c3c024c4c281a250a1d2f0475b10b674ed0013194` |
| `20261023-112915-de169137` primer candidato, Epoitaitaye | `40ee9e55512f2c84e5e179bcb8ecd1429e2d0da92a10eba353b8699c5478a452` |
| `20261023-113138-a6ac45b0` primer candidato, Maite Zaitut! | `d9063803c71418e76b754337a0fcb537a70c518f89213ed26ca220a6df094201` |
| `20261023-113304-686e82d8` primer candidato, Pupu Eta Lore | `7f6c33e80d133264f9f03190e28f6e67ed73d4243bc68b2373f50d55ccc3f780` |
| `20261023-113818-2a50b13b` Epoitaitaye | `0477ac614bf623672ec4cf8efba6cefaae94cdcd023a3791af0f046e3990e9bb` |
| `20261023-113953-a72d2dbe` Maite Zaitut! | `ddb7a8c612b5ed755ccf8100843711f7999532698b93121666b9259d685473b3` |
| `20261023-114014-5c267b9d` Pupu Eta Lore | `2e8200426377bf148efa35bdfd57bc75909b6519d680ce8e00ec81090e3deb33` |
| `20261023-114038-c3a37e84` búsqueda infantil | `e0308cb4ee00646c94ff28482deee9096cdbe0ab9f2eba721f05e76667872995` |
| `20261023-114134-50ad55cd` regresión 30 | `bfe62c41715a8224666251a69c9bc6c664e907860150110d7d99ea24d6dac200` |
| `20261023-113554-bf9dabbe` reinicio, candidato inicial | `b6a0187b794216f3c65fd886562a8498439ed91b73217dd38bc26f7602aee0f6` |
| `result-identity-20261023-114601-ce527f2f.json.local` control ID anterior | `b432902f8d11e4224d01126cc9b4331c050ebfa6d134a1f5d062039c865090a0` |
| `result-identity-20261023-114643-dc1e209a.json.local` control ID actual | `77cd41dd830a0f5d80e86ac24b1a0dfb8f67d26b8a7d3190348c594e62813f00` |
| `kids-cold-accepted-complete-audio.local.json` | `3969c97e9d74e95da359e20bb8b219faf25f510c513f2a2fc550d59989e3ee23` |
| `android-decoder-harness.local/result-20261023-114735-83d55128.json.local` | `6f2cdb76d2ce343f23f17346bb6936584acb923ab32127435104feb5e57cb798` |

Validación: 400 pruebas JavaScript, incluidas 23 del decoder; 210 Rust y 27
ignoradas; tipos sin errores ni avisos. El harness QuickJS pasó sus seis pruebas
de aislamiento y cuatro formatos reales exactos. El generador reproduce el
bundle. Siguen los límites 192 MiB/12 s, 32 MiB/1 s, pila de 512 KiB y un trabajador.
Los checks Android `--tests --offline` arm64/x86_64 pasan sin avisos nuevos.
En Android 15/API 35 x86_64, el mismo harness pasó seis pruebas de aislamiento
y cuatro formatos exactos. Preparó en **6747,1 ms frente a 10911,5 ms** de la
réplica anterior (−38,2 %, una medición por versión), con los límites intactos.
No ejecutó app, JNI, ExoPlayer, audio ni red; no mide un dispositivo ARM físico.
El runner añade `-Release` con rutas y marcadores separados y diez comprobaciones
simuladas; `-NoBuild` conserva compatibilidad debug. No se compiló una app release.

La ronda queda cerrada con mejora sustancial; siguen pendientes 3,5 s totales,
300 ms, más corpus y escucha continua/dispositivos reales. No se accedió a
Premium ni se midieron anuncios vistos/saltados. No cambia la aprobación de
Oficial ni se publican una app, receta o scripts OTA.

## Ronda 3: parser acotado, controles y fallos conservados

`bef47a7` especializa dos operaciones del parser privado: acceso al token y
asignación de los offsets de cada nodo. No cambia el lexer ni las validaciones
de sintaxis. El generador exige youtubei.js 18.1.0, Meriyah 7.4.0 y la llamada
exacta con sus opciones; una deriva detiene la generación para revisión.
Se mantienen los presupuestos 192 MiB/12 s, 32 MiB/1 s y pila de 512 KiB.
El bundle mide 296967 bytes, SHA-256
`2a3f0b44c121d1e5663b04d59097cf132ce77991ff799fe64c5c27c32e2f53c6`.

En el par QuickJS serial invertido, la preparación pasó de **4026,4 a 3798,1 ms**
(−5,7 %, una réplica por versión). Los perfiles previos daban aproximadamente
7 %. Otro par tuvo un control atípico y el primero coincidió con pruebas Rust:
se conservan, pero no justifican anunciar 29 % ni una ganancia igual en la app.
Cuatro fixtures y sus cuatro formatos conservan script, ST y firmas/`n` exactos.
Pasan seis pruebas QuickJS de aislamiento y 28 casos de sintaxis/error adicionales.

Se añade un reloj común sólo al diagnóstico del banco, sin URLs ni datos de
cuenta. También se corrige la restauración del entorno: Windows/.NET dejaba
presente una variable al asignarle `null`; ahora se elimina explícitamente si
antes no existía, preservando valores vacíos y no vacíos que sí existían.
Las tres situaciones y diez casos de perfiles/snapshots pasan.

### App: comparación final válida

Dos intentos por canción y binario, alternando el orden; cada uno abre un
proceso nuevo, sin sesión y con `FreshDecoder`. Ambos usan los ocho turnos CDN
habituales. Son builds **debug**, sin búsqueda. `playing` corresponde a Audio
silenciado, avance, salto al 80 % y final tras saltar a la cola; no escucha
continua completa ni medición acústica. Los rangos sólo incluyen éxitos.

| Canción | Control: Native / intentos | Control: IPC → `playing` | Candidato: Native / intentos | Candidato: IPC → `playing` |
|---|---:|---:|---:|---:|
| Epoitaitaye | 2/2 | 4957–5775 ms | 2/2 | 4805–5826 ms |
| Maite Zaitut! | 2/2 | 5714–9137 ms | 1/2 | 4834 ms |
| Pupu Eta Lore | 2/2 | 4744–4838 ms | 1/2 | 4755 ms |

No hay una mejora estable del tiempo total demostrada. Epo tiene mediana
5366 → 5315,5 ms; Maite y Pupu sólo tienen un éxito de dos en el candidato.
Los dos fallos son `NATIVE_EMBEDDED_SABR_ONLY`: las dos respuestas del servidor,
incluida la renovación acotada, carecen de URL directa. La clasificación ocurre
antes del descifrado; no se encontró una relación lógica con estos cambios,
pero eso no borra los fallos ni demuestra su causa. El banco `native-direct`
no ejecuta el respaldo Legacy. En total: diez inicios/saltos/colas correctos,
22 sondas estrictas, doce respuestas 403 y ningún 429. Un 403 no identifica
un anuncio. Ninguna fila medida cumple los 3,5 s.

El control es el binario inmutable `4d6a29eab5a228a5303fe80fd94a0193c4b177133378934c78596af64ccbee5b`
de `0aa9e1c`. El candidato final es `f5c849bba5c964e1879924252e2b5b9f48c79490e37436fca3fe3c039a260f18`,
compilado sobre `bdf6a6c` con el código que pasó a `bef47a7`; el arreglo posterior
de restauración pertenece al runner externo, no al ejecutable.

Una comparación inicial de doce casos con el candidato experimental `0d6003ef…`
queda invalidada para atribuir mejoras al parser: aunque su metadata decía
ocho turnos, la variable vacía activaba dieciséis. Se conserva separada y no
se usa en la tabla. Los otros ensayos fríos tampoco se borran: el primer
Epo dio 4343 ms, la tanda siguiente 6227/8646/4222 ms; la comprobación final
dio Epo 4918 ms, un fallo SABR de Maite, Pupu 4658 ms y Maite 5474 ms al repetir.
Su variación impide escoger sólo el mejor tiempo como resultado general.

### Regresión, archivos y Android

Los 30 temas de `real_albums` arrancaron por Native, sin Legacy, con **30/30 IDs
esperados**: mínimo 474,1, mediana 630,85 y máximo 1218,1 ms, incluida búsqueda.
El usuario acepta aproximadamente 600 ms provisionalmente para este camino;
no significa que todos los casos estén por debajo de 600 ms. El informe bruto
mantiene sus treinta incumplimientos del antiguo umbral de 300 ms, que queda
como aspiración; no se reescriben resultados históricos. No mide EOF/publicidad.

La descarga completa inicial verificó dos archivos y falló al resolver Maite
en 11,4 s; su código genérico no permite asignar una causa más precisa. Una única
réplica diagnóstica obtuvo los tres archivos, idénticos a las referencias
independientes, y FFmpeg `-xerror` decodificó los tres sin error. En esa réplica
Maite necesitó seis sondas, con primer 206 a los 4,003 s. Este éxito no corrige
retroactivamente el primer fallo. Se conservan los hashes de audio de la ronda 2.

Pasan **430 pruebas JavaScript, 210 Rust (27 ignoradas)**, tipos sin errores
ni avisos, generación reproducible y checks Android arm64/x86_64 sin avisos
nuevos. El harness Android 15 x86_64 pasa seis pruebas y cuatro formatos exactos.
Preparó en **7073,8 ms**, frente a 6747,1 ms anteriores: réplicas únicas, sin
ganancia Android acreditada. No ejecuta APK, JNI, ExoPlayer, audio ni red.
El AVD pide 2 GiB y el emulador lo eleva a 2560 MiB; quedó cerrado al acabar.

| Perfil / campaña nueva | Resultado | Anuncios vistos / saltados / espera |
|---|---|---|
| Sin sesión: comparación infantil final | Control 6/6 Native; candidato 4/6 | No medidos; 403 no se cuenta como anuncio |
| Sin sesión: 30 temas habituales | 30/30 Native, 30 IDs correctos, mediana 631 ms | No medidos |
| Sin sesión: archivos completos | Primera tanda 2/3; réplica diagnóstica 3/3 idénticos | Sin campaña publicitaria |
| Premium | No se usó en esta ronda | No medidos |

### Ensayos descartados y siguiente paso

Dieciséis sondeos sólo en BENCH hicieron 35 peticiones y recibieron 31 respuestas
403, frente a 14 y diez con ocho sondeos; ocho casos correctos, ningún 429.
Sólo uno aprovechó un intervalo nuevo. No se demuestra una ganancia estable
y se retira el experimento del código, conservando evidencias locales.
Tampoco se acorta la lectura de la página: admitir antes perdería comprobaciones
de duplicados, límite y final del cuerpo, sin ahorro temporal medido.

Un prototipo separado importa sólo las raíces AST necesarias: 822 ms dentro de
QuickJS y 62,9 MB asignados, con salida exacta. **No incluye el parser WASM** ni
prueba un presupuesto combinado: retiene 44 MB de JSON fuera de la VM. No entra
en producción. Harían falta exportación selectiva acotada, límites conjuntos,
cancelación, fuel y pruebas adversariales antes de medir una mejora completa.

Prioridad siguiente: diagnosticar y recuperar respuestas sólo SABR sin perder
las comprobaciones; después reducir más el parser y medir 3,5 s en un corpus
mayor. Los 600 ms habituales son una base provisional aceptada, no una nueva
aprobación de la captura progresiva. No cambian yt-dlp predeterminado, Propio,
Legacy, la receta ni los scripts OTA. Este código requiere una app nueva;
no actualiza la PWA. `origin/main` avanzó a `1868d4f` (youtubei.js 18.3.0):
queda por integrar y revisar esa dependencia antes de publicar.

Las evidencias permanecen ignoradas en `capture-bench.local`, sin medios,
perfiles, tokens ni respuestas completas en Git. Referencias de procedencia:

| Artefacto local | SHA-256 |
|---|---|
| `round3-cold-final-pair-analysis.json.local` | `9e2b9ddf14ec13c8f4056eb1630c7ffec618a9a2d2411b732ed80ab66cb5f631` |
| `round3-cold-final-pair-index.json.local` | `de9fa79f614e50516a7d9b6899cef02885baaf2a42632c172065ce7c42432b8b` |
| `round3-cold-pair-confounded-analysis.json.local` | `027484d8d2174c3524ce63880100de4724bccdb15bae8580ade7a6db5a010bbd` |
| `round3-poll-analysis.json.local` | `4cc9f1eb7bfdbc8ce9c3042483b58308c011362730ec18d7fa5ff6886ec6483d` |
| `result-20261023-124433-1474c077.json` | `b99d74c34f615fd187b174f2787392eefdf465d66961cd3a7647c6b2f19349ae` |
| `round3-complete-files-diagnostic.log.local` | `1a1d052d1f4468ffd85a40537e4f24de4b670a3b1c389433c4dba921273c3a26` |
| `round3-complete-audio-verified.json.local` | `70c579f356daf637b5e1d6d334fe5957a6971096c1dea217237ecb1760a851b2` |
| `android-decoder-harness.local/result-20261023-124743-f92e52d7.json.local` | `03a26b274a0ab82e4ea7f3c4d6acd64b9c2469eb551251bc32b2a29a8513ffd2` |

## Ronda 4: anticipo de metadatos y diagnóstico SABR

El código `3fa0237fe8def0cdba6db3ffb47950f425a5989e` adelanta el POST público del
player mientras se valida watch y se analiza el JavaScript, sólo en el camino
frío que ya tenía un indicio de ST. La respuesta, incluso si contiene un error
HTTP o `SABR_ONLY`, permanece retenida hasta que watch confirme estado OK, ID
exacto, reproducción incrustada permitida y el aviso explícito made-for-kids.
Además, el analizador completo debe confirmar el mismo ST usado en la petición.
`isFamilySafe` no sustituye el aviso infantil. Una discrepancia descarta la
respuesta anticipada; no permite entregar ni cachear una URL o sondear el CDN.

Los aciertos de caché y los casos sin indicio mantienen su recorrido anterior.
El rechazo de watch cancela los futuros pendientes; un POST que ya llegó al
servidor no puede deshacerse y supone hasta una consulta pública adicional en
ese caso. Las pruebas cubren una petición loopback iniciada antes de admitir,
éxito y SABR retenidos, rechazo por MFK/ID/estado/embed, ST contradictorio,
ambas órdenes de finalización y cancelación. No se modifica la recuperación
SABR acotada ya existente ni se repite un POST con el mismo cuerpo efectivo.

Se conservan identidad, audio original, descifrado y sonda estricta 206 al 80 %;
los ocho turnos de la primera candidata comparten el mismo presupuesto CDN de
ocho segundos, con parada ante 429 y sin ráfagas para recuperar turnos vencidos.
La ruta incrustada sigue limitada a 30 s. El camino rápido, el respaldo Legacy,
los límites QuickJS de 192 MiB/12 s y 32 MiB/1 s, la pila de 512 KiB y el único
trabajador no cambian. El bundle continúa siendo `2a3f0b44…`, el de la ronda 3.

El diagnóstico añade correlación por intento y conteos de formatos, URL/cipher
y transformaciones necesarias; los cambios de configuración se expresan como
booleanos. Sólo registra IDs públicos validados, versión/STS públicos y códigos
cerrados: no URLs, visitantes, firmas, tokens ni errores remotos completos.
Se calcula únicamente en el banco. Los seis candidatos de la comparación
registran POST y respuesta anteriores a la validación de watch, y consumo
posterior a esa validación y a la comprobación del ST. Esto verifica el orden
del anticipo; no demuestra por sí solo una reducción del arranque.

### Doce controles fríos, incluidos los fallos

Índice `cold-paired-20261023-140026-433bf723-index.json.local`: dos intentos por
canción y binario, orden alternado, proceso nuevo por fila, perfil anónimo,
`FreshDecoder`, política CDN habitual y builds **debug**. Es resolución directa,
sin búsqueda ni Legacy. `playing` mide el evento de Audio silenciado; después se
comprueban avance, salto al 80 % y final tras saltar a la cola. No es escucha
continua completa ni medición acústica. Preparación suma los decoders necesarios
en ese intento, incluida una eventual renovación; no equivale sólo al parseo.

Todos los tiempos están en milisegundos. El orden corresponde al índice local.

| Orden | Canción | Versión / réplica | Preparación | Extracción | IPC → `playing` | Primer 206 CDN | Resultado |
|---:|---|---|---:|---:|---:|---:|---|
| 0 | Epoitaitaye | Control 1 | 4045,1 | 5504 | 5636 | Intento 1 | Inicio, salto y cola correctos |
| 1 | Epoitaitaye | Candidato 1 | 4071,8 | 4579 | 4722 | Intento 1 | Inicio, salto y cola correctos |
| 2 | Maite Zaitut! | Candidato 1 | 4020,4 | 4748 | 4877 | Intento 2 | Inicio, salto y cola correctos |
| 3 | Maite Zaitut! | Control 1 | 3898,7 | — | — | No hubo sonda | Fallo nativo tras dos respuestas SABR |
| 4 | Pupu Eta Lore | Control 1 | 3772,6 | 4252 | 4375 | Intento 1 | Inicio, salto y cola correctos |
| 5 | Pupu Eta Lore | Candidato 1 | 4043,7 | 4596 | 4724 | Intento 1 | Inicio, salto y cola correctos |
| 6 | Epoitaitaye | Candidato 2 | 4002,6 | 4462 | 4595 | Intento 1 | Inicio, salto y cola correctos |
| 7 | Epoitaitaye | Control 2 | 3871,8 | 4805 | 4933 | Intento 1 | Recuperación SABR; inicio, salto y cola correctos |
| 8 | Maite Zaitut! | Control 2 | 3781,7 | 5278 | 5406 | Intento 3 | Inicio, salto y cola correctos |
| 9 | Maite Zaitut! | Candidato 2 | 4010,8 | 4468 | 4656 | Intento 1 | Inicio, salto y cola correctos |
| 10 | Pupu Eta Lore | Candidato 2 | 8851,8 | 9686 | 9813 | Intento 1 | Recuperación SABR y segundo JS analizado; inicio, salto y cola correctos |
| 11 | Pupu Eta Lore | Control 2 | 3754,8 | 4306 | 4428 | Intento 1 | Inicio, salto y cola correctos |

Resultado: **control 5/6 Native; candidato 6/6 Native**. Los once éxitos fueron
WEB_EMBEDDED_PLAYER/251, con salto de 606–623 ms y cola de 521–543 ms. Hubo
14 sondas CDN: once éxitos 206, tres respuestas 403 y ningún 429. El fallo del
control de Maite terminó como vídeo no disponible; el diagnóstico conserva
`NATIVE_EMBEDDED_SABR_ONLY` antes del respaldo WEB. No se asigna cero tiempo a
esa fila ni se sustituye por un intento posterior. Este banco no ejercita Legacy.

| Canción | Control: éxitos / intentos | Control: `playing`, mediana [rango] | Candidato: éxitos / intentos | Candidato: `playing`, mediana [rango] |
|---|---:|---:|---:|---:|
| Epoitaitaye | 2/2 | 5284,5 [4933–5636] | 2/2 | 4658,5 [4595–4722] |
| Maite Zaitut! | 1/2 | 5406 [un éxito] | 2/2 | 4766,5 [4656–4877] |
| Pupu Eta Lore | 2/2 | 4401,5 [4375–4428] | 2/2 | 7268,5 [4724–9813] |

Las medianas sólo incluyen éxitos y cada grupo tiene como máximo dos muestras.
**No se atribuyen causalmente al anticipo los 626 ms de diferencia de Epo.**
El primer control tardó 1127,7 ms en obtener embed; el segundo renovó la
configuración tras SABR. La disponibilidad remota, esas renovaciones y la red
también cambian entre intentos. Pupu empeora en esta muestra: la segunda
respuesta utilizable requirió otra configuración y otro análisis de JavaScript,
con 8851,8 ms de preparación acumulada. No se descarta ese dato como atípico ni
se afirma una solución universal de SABR a partir de seis éxitos. Ningún inicio
frío medido alcanza 3,5 s; tampoco se ha demostrado una mejora uniforme del total.

### Camino habitual y búsqueda infantil

La regresión `20261023-140339-56e863a6` conserva **30 Native, 0 Legacy y 30/30 IDs
esperados**: mínimo 453,4, mediana **642,15** y máximo 1317,9 ms, incluida búsqueda.
Es compatible con la base provisional de aproximadamente 600 ms aceptada por
el usuario, no con una cota de 600 ms por canción. Los treinta incumplimientos
del umbral histórico de 300 ms permanecen en el resultado. El banco mide búsqueda
e inicio, no EOF, continuidad completa ni publicidad.

La tanda infantil con búsqueda `20261023-140456-bda257e2` demuestra por qué los
seis controles directos no bastan para cerrar la fiabilidad:

| Canción | ID seleccionado | Búsqueda → `playing` | Ruta observada |
|---|---|---:|---|
| Epoitaitaye | `DJzjkMBMook` | 5369,6 ms | Native |
| Maite Zaitut! | `WtTRMAoN2Fw` | 6085,7 ms | Native |
| Pupu Eta Lore | `kcUgLakr7bU` | 5188,6 ms | Legacy, tras dos respuestas SABR |

Los tres IDs son los esperados. Sólo Epo es la primera canción del proceso nuevo
con `FreshDecoder`; Maite y Pupu continúan en ese mismo proceso. Maite analizó otro
reproductor y Pupu reutilizó memoria, por lo que estas tres cifras no son tres
arranques fríos independientes. La aplicación sí ejercitó Legacy para Pupu:
el éxito del respaldo no se cuenta como éxito nativo ni acredita soporte de esa
misma situación en Android. Tampoco equivale a una escucha completa.

### Descartes, validación y procedencia

El parser WASM quedó archivado sólo en `.local` y fuera del cambio productivo.
El prototipo inicial rápido no bastaba: el despacho portable seguro dio
aproximadamente **8,0–8,4 s** y la alternativa indirecta **6,503 s**, frente a
**4,445 s** del preparador compatible en ese control. No se conserva una variante
con riesgo de pila para presentar un mejor tiempo, ni se amplían los límites.
El último microexperimento de GC dio **3498,9 → 3361,4 ms** (−3,93 %, un solo
par), con cuatro formatos exactos. Se descarta por no acreditar una mejora
estable y sustancial; no hay cambio productivo de GC.

Pasaron **217 pruebas Rust (27 ignoradas), 430 JavaScript**, tipos sin errores
ni avisos y checks Android arm64/x86_64 sin avisos nuevos. No se repitió aquí
rendimiento del harness Android ni reproducción JNI/ExoPlayer.

La revalidación de archivos completos pasó **3/3 en un único pase**, sin repetir
la campaña, en 11,22 s. Los tres archivos 251 coinciden por SHA-256 con las
referencias independientes anteriores y FFmpeg `-xerror` terminó con salida 0
para los tres. Maite recibió cinco 403 y el primer 206 en el sexto intento,
aproximadamente a los 4 s; eso no prueba reproducción ni salto de anuncios.
Se acredita el contenido completo de estos archivos, no escucha continua en
la app, ausencia universal de anuncios ni una campaña de sesiones publicitarias.

El candidato es el commit limpio `3fa0237fe8def0cdba6db3ffb47950f425a5989e`, binario
`adef5ea3a90fb8a4ea0dc332eb7d0ef76187c5a236722bb99bb04e4089b41213`.
El control es el binario inmutable de la ronda 3,
`f5c849bba5c964e1879924252e2b5b9f48c79490e37436fca3fe3c039a260f18`;
se conserva su metadata original de compilación sobre `bdf6a6c` con cambios
posteriormente registrados, sin atribuirle un checkout limpio que no tuvo.
Las doce metadata registran exactamente las seis variables permitidas del banco,
sin overrides, con `FreshDecoder` y primera preparación `analyzed`; no se convierte
una reutilización posterior dentro de la misma fila en otro arranque frío.

| Evidencia local de la ronda 4 | SHA-256 |
|---|---|
| `cold-paired-20261023-140026-433bf723-index.json.local` | `cb7b52423c47009851868377c1f1b4bdbbec0f5d857265a3169ebf9aa9546153` |
| `round4-cold-analysis.json.local` | `19bf2909672f642aa2b820a66ac81fd2b4d717621971418063bf1f2ca4502717` |
| `result-20261023-140339-56e863a6.json` | `35fb38873f32135468472c32367ae28540750687ab29a155590a9fb1efe36703` |
| `result-20261023-140456-bda257e2.json` | `8aef84624c01b370b7267816bdcd6b9963c862ee2e3e8d2251a57c301142dbb2` |
| `round4-complete-audio-verified.json.local` | `0cd0431129d3cd9b1c761a50417821aa2c098ea003c1f4eb405ece42d4d28d98` |
| `round4-final-manifest.json.local` | `3b98ddf2d9a8fcb99e9ebb562075e7ec29a8087cfd5230a745640a0103a3d42b` |

El índice y el análisis conservan cada intento y las huellas de sus informes y
stderr, incluido el fallo. El manifiesto reúne las huellas de 72 artefactos.
No se usó Premium ni se midieron anuncios vistos o
saltados; un 403 temporal no demuestra publicidad. No cambia la aprobación de
Oficial, yt-dlp predeterminado, Propio/Legacy, la receta ni OTA. Quedan abiertas
la meta de arranque infantil, la fiabilidad SABR y la validación más amplia.

## Ronda 5: renovación temprana y presupuesto compartido

Código `80100dd699568910dd0bcaa29ff6fc737db9a229`, candidato limpio **debug**
`6348a600b094509e2d0171496b23c872fc636398846111bfa3848ca205df8db5`.
Control inmutable de la ronda 4, commit limpio `3fa0237`, binario `adef5ea3…`;
la procedencia original se conserva byte a byte. No se atribuye al control una
compilación posterior sobre el commit documental `9046dd9`.

### Cambio y límites

Tras una respuesta provisional SABR, el coordinador espera la admisión de watch
(MFK, identidad, estado y permiso de inserción) antes de reservar la única
renovación. Conserva AST1 mientras descarga configuración y fuente alternativas.
Sólo cancela realmente el futuro propietario de AST1 si la fuente completa tiene
otro SHA y cambia el cuerpo efectivo en campos independientes del ST. La VM
interrumpida conserva su permiso hasta que sale: no aparecen dos trabajadores.
La respuesta alternativa sigue retenida hasta que el análisis completo confirme
su ST; después continúan identidad, audio original, descifrado y sonda 206.

Una fuente con el mismo SHA reutiliza el análisis inicial. Si cambia únicamente
el reproductor, se termina AST1 y se conserva la recuperación secuencial: los dos
ST completos deben producir cuerpos distintos para autorizar POST2. Un primer
indicio de ST erróneo conserva su única petición correctiva. Una discrepancia
después de POST2 falla sin POST3. Las reservas de caché se vinculan a la instancia
exacta para no borrar un fallo o una configuración concurrentes más recientes.

La preparación y su reemplazo comparten un **plazo absoluto de 12 s**, incluidas
colas, bloqueos, descarga, caché y análisis; una renovación no reinicia ese reloj.
La resolución embedded exterior conserva su límite separado de 30 s, y el CDN
sus ocho turnos dentro de ocho segundos. No cambia el parser, su bundle, los
presupuestos de memoria/pila ni el nivel rápido habitual. Los tests cubren además
watch rechazado, cancelación, fuente idéntica, AST1 terminado durante la descarga,
cambios sólo de ST, concurrencia y agotamiento del presupuesto compartido.

### Veinticuatro arranques independientes

Índice `cold-paired-20261023-150518-68feba4d-index.json.local`: cuatro repeticiones
por canción y binario, orden alternado, proceso nuevo por fila, sin sesión,
`FreshDecoder`, seis variables permitidas y ningún override de política.
No se omiten fallos ni lentitudes. Todas las filas terminaron con exit 0 y pasaron
identidad, 206 de inicio/80 %, avance de Audio, salto y cola. Es resolución directa
sin búsqueda ni Legacy. `playing` es un evento de Audio silenciado, no una medida
acústica ni escucha continua de cada canción.

Milisegundos; las medianas y rangos describen cuatro muestras por grupo.

| Canción | Control: éxitos | Control: `playing`, mediana [rango] | Candidato: éxitos | Candidato: `playing`, mediana [rango] |
|---|---:|---:|---:|---:|
| Epoitaitaye | 4/4 | 4508 [4439–4723] | 4/4 | 4519 [4422–4670] |
| Maite Zaitut! | 4/4 | 4532,5 [4377–5088] | 4/4 | 4541,5 [4490–4748] |
| Pupu Eta Lore | 4/4 | 4507,5 [4378–5267] | 4/4 | 5090 [4340–5557] |

| Orden | Canción | Binario / réplica | `playing` | Preparación terminada | POST | Resultado |
|---:|---|---|---:|---:|---:|---|
| 0 | Epo | Control 1 | 4723 | 4090,8 | 1 | Correcto |
| 1 | Epo | Candidato 1 | 4670 | 4009,0 | 1 | Correcto |
| 2 | Maite | Candidato 1 | 4748 | 4056,3 | 1 | Correcto |
| 3 | Maite | Control 1 | 5088 | 4465,1 | 1 | Correcto |
| 4 | Pupu | Control 1 | 5267 | 4131,2 | 2 | SABR recuperado; correcto |
| 5 | Pupu | Candidato 1 | 5100 | 4338,1 | 1 | Correcto |
| 6 | Epo | Candidato 2 | 4422 | 3747,7 | 1 | Correcto |
| 7 | Epo | Control 2 | 4476 | 3860,8 | 1 | Correcto |
| 8 | Maite | Control 2 | 4490 | 3843,5 | 1 | Correcto |
| 9 | Maite | Candidato 2 | 4509 | 3831,0 | 1 | Correcto |
| 10 | Pupu | Candidato 2 | 5080 | 4343,9 | 1 | Correcto |
| 11 | Pupu | Control 2 | 4575 | 3918,3 | 1 | Correcto |
| 12 | Epo | Control 3 | 4540 | 3762,9 | 1 | Correcto |
| 13 | Epo | Candidato 3 | 4441 | 3777,5 | 1 | Correcto |
| 14 | Maite | Candidato 3 | 4574 | 3844,7 | 1 | Correcto |
| 15 | Maite | Control 3 | 4377 | 3751,0 | 1 | Correcto |
| 16 | Pupu | Control 3 | 4440 | 3803,9 | 1 | Correcto |
| 17 | Pupu | Candidato 3 | 5557 | 3827,1 | 1 | Correcto |
| 18 | Epo | Candidato 4 | 4597 | 3948,3 | 1 | Correcto |
| 19 | Epo | Control 4 | 4439 | 3810,0 | 1 | Correcto |
| 20 | Maite | Control 4 | 4575 | 3887,1 | 1 | Correcto |
| 21 | Maite | Candidato 4 | 4490 | 3846,1 | 1 | Correcto |
| 22 | Pupu | Candidato 4 | 4340 | 3781,4 | 1 | Correcto |
| 23 | Pupu | Control 4 | 4378 | 3802,5 | 1 | Correcto |

**24/24 funcionales, 24 Native, cero Legacy.** Hubo 25 POST: sólo el control de
Pupu de orden 4 necesitó la renovación antigua, con otra configuración pero el
mismo reproductor/ST. Su evento adicional `memory`, de 0,0187 ms con ID nulo,
se conserva separado; no acredita otro análisis completo. Los 24 sondeos CDN
internos pasaron en el primer turno, sin 403/429; no se estresó aquí su límite.
Las trazas verifican consumo posterior a watch/ST y descifrado/CDN posteriores.

**Ninguno de los doce candidatos activó la renovación temprana.** Epo y Maite
quedan prácticamente iguales; Pupu empeora 582,5 ms de mediana (12,9 %). No se
atribuye esa variación a una rama que no se ejecutó, ni se demuestra una ganancia
causal o estable. La preparación terminada de la tabla no es CPU pura ni incluye
trabajo cancelado; el análisis local conserva también la fase mural y todos los
resultados. En el control antiguo, la renovación posterior queda fuera de esa
fase, por lo que tampoco se compara ésta como si fuera la extracción completa.

### Ejecución real del reemplazo, separada del A/B

El primer control tras compilar, `20261023-150354-88d18762`, sí recibió SABR y
ejercitó `reserved` a 958,3 ms, `replaced` a 1206,5 ms con
`initialCancelled:true`, y `ready` a 5333,1 ms. POST2 empezó a 1245,8 ms y
terminó a 1505,7 ms; permaneció retenido hasta consumirse a 5338,8 ms tras
comprobar el ST completo. No hubo POST3. Reemplazo terminado en 4119,6 ms,
fase mural de 5336,0 ms, extracción de 6120 ms y `playing` de **6279 ms**;
inicio, salto y cola correctos. El sondeo CDN tardó 478,1 ms.

Este dato acredita cancelación y reemplazo reales, **no cuánto se ahorró**:
no existe un control equivalente de esa misma respuesta remota, y la duración/CPU
de AST1 cancelado es desconocida. No se mezcla con las medianas de los 24 casos.
La implementación se conserva en evaluación en esta rama; no se promueve por
velocidad ni se prolonga la campaña para escoger resultados más favorables.

### Camino habitual, búsqueda infantil y archivos completos

La tanda habitual `20261023-150834-2706ff63` conserva **30 Native, cero Legacy**,
30 IDs esperados y ninguna pausa posterior al arranque en la ventana observada.
Búsqueda más `playing`: mínimo **491,2**, mediana **703,1**, máximo **1358,1 ms**.
La mediana anterior fue 642,15 ms: esta tanda tampoco mejora el camino habitual.
Los treinta fallos del umbral histórico de 300 ms permanecen en el informe;
`ok:false` no se oculta ni se presenta como aprobación de ese umbral.

La búsqueda infantil `20261023-150933-5bdfd3f2` conserva los tres IDs correctos:

| Canción | Búsqueda → `playing` | Ruta y diagnóstico |
|---|---:|---|
| Epoitaitaye | 4064,5 ms | Legacy; Native falló con `NATIVE_EMBEDDED_CONFIG` |
| Maite Zaitut! | 4869,7 ms | Native; primer análisis efectivo en este proceso |
| Pupu Eta Lore | 1820,4 ms | Native; decoder reutilizado de memoria |

Sólo Epo es la primera búsqueda del proceso nuevo con `FreshDecoder`. Su embed
se descargó (152067 bytes, 189,1 ms), pero no se obtuvo configuración válida:
falló antes de descargar el player, lanzar POST o preparar un decoder. El banco
no guardó ese HTML, por lo que no determina qué campo faltaba. No se atribuye a
SABR, publicidad o la cancelación nueva. Maite analizó el decoder en 4054,1 ms;
Pupu usó memoria en 0,0188 ms. No son tres arranques fríos independientes.
Las tres filas superan 300 ms y el éxito por Legacy no cuenta como éxito nativo.

En una prueba separada, los **tres archivos 251 completos** se obtuvieron en un
único pase de 11,09 s. Los tres hashes coinciden con las referencias independientes
de yt-dlp; FFmpeg `-xerror` terminó con salida 0 para los tres. Esto comprueba esos
archivos completos; el banco de inicio/salto/cola no acredita escuchar las tres
canciones enteras en la app ni una campaña publicitaria.

### Descartes, validación y alcance

- Acorn 8.19 con el mismo analizador conservó en V8 las cuatro fuentes por cuatro
  formatos, pero agotó 12 s en QuickJS frente a 4622,6 ms de Meriyah. Se descartó; no se
  aumentaron límites ni se incorporó el parser alternativo al producto.
- Dos ajustes de posiciones de Meriyah dieron 3679,5 ms de control frente a
  3698,1 (+0,51 %) y 3621,3 (−1,58 %), con salidas exactas. No acreditan una mejora
  sustancial y no se incorporaron. Son microcontroles, no tiempos de la app.
- Pasaron **226 pruebas Rust, 27 ignoradas, 430 JavaScript**, tipos sin errores
  ni avisos y checks Android arm64/x86_64 sin avisos nuevos. No se ejecutó emulador,
  reproducción móvil ni rendimiento de Android en esta ronda.

| Perfil | Medidas de esta ronda | Anuncios vistos / saltados / entregados |
|---|---|---|
| Sin sesión | 24 A/B, control inicial, 30 habituales, 3 búsquedas infantiles y 3 archivos | No medidos; SABR/403 no los identifican |
| Premium | No repetidas; referencias anteriores permanecen separadas | No medidos en esta ronda |

No cambia la aprobación de Oficial ni de su entrega progresiva. yt-dlp continúa
predeterminado y Propio conserva Legacy. No cambian `capture.js`, la receta,
`youtubei.ts`, el bundle ni la API de extractores: este cambio Rust necesita una
compilación nueva de la app y no llega mediante publicar sólo un extractor o la
PWA. Sin push a main, publicación de extractores, etiquetas ni releases.

La meta de **3,5 s infantiles sigue pendiente**. El siguiente trabajo debe reducir
la preparación completa (aproximadamente 3,8–4,3 s aquí) y resolver configuraciones
que fallan antes de él, manteniendo los mismos controles y midiendo el total.

Evidencias en `capture-bench.local`, ignoradas; el manifiesto final conserva las
huellas de informes, errores, metadata, procedencias, fuentes y verificaciones.

| Evidencia local de la ronda 5 | SHA-256 |
|---|---|
| Índice de los 24 controles | `924ccccc355cf1769cf30b16b6f8eaa801e3fee929d399e4082b116e9ce43136` |
| Análisis de los controles | `3aad6b10947f8d2d24ee4bbfc817458cfa245b09780f9e18eb4e0ac9b9f8bd01` |
| `round5-complete-audio-verified.json.local` | `aeeb79b6a67afe0f278cd8a97e9401b7a57a812e092850017077b62b2cb4fd5c` |
| `android-round5-final-checks-20261023-150002.json.local` | `c1d032eae68fee61793eb05866f1628f34074d8ca021c86d1f9f8684a133e94a` |
| `round5-final-manifest.json.local` | `c20d13cc3bd70e9a4c37975d7a0361a81e7c45f10b692c6cdce11a90b72b093f` |

Se verificaron las **185 huellas** del manifiesto sin discrepancias. Incluye los
dos ejecutables inmutables y su procedencia; los documentos quedan fuera para
evitar hashes circulares. Sólo se suben código y resúmenes, en `p1-oficial`.

## Ronda 6: Clang, parser y configuraciones canary

Las fases A/B siguientes conservan sus controles y fallos. Las fases C/D/E documentan después la precarga y el ejecutable final; la meta no se declara cumplida para todas las canciones. No se ha publicado una versión ni actualizado la aplicación instalada.

### Cambios y procedencia

| Commit | Cambio | Alcance acreditado aquí |
|---|---|---|
| `093bb35` | Diagnóstico cerrado de configuración y una redescarga acotada ante documento inválido | Pruebas locales de campos, renovación, plazos y transporte |
| `fb4f3d5` | QuickJS con Clang y dispatch directo en Windows | Comparación aislada y 24 intentos en aplicación release, fase A |
| `b666871` | Conservación completa de versiones oficiales con sufijo canary | POST de metadatos fallido por `SABR_ONLY`, conservado; una reproducción canary posterior en la fase B sí funciona |
| `1028f0f` | Menos objetos de posición y recorridos AST innecesarios | Diferenciales, perfil aislado, fase B release y regresión de búsqueda 30 |

Se conserva íntegra la distribución `rquickjs-sys 0.14.0`: 306 archivos originales, inventario, licencias y parches trazables. El archivo `.crate` original tiene SHA-256 `cee271d0eeba64f0915b846cb7ae02e16faf3dfdffdca91731101d9d30fe3423`. Sólo cambian los archivos upstream `build.rs` y `quickjs/quickjs.c`. El dispatch directo usa saltos calculados dentro del intérprete: no introduce JIT, ejecución completa del player ni E/S en la VM.

El compilador se selecciona exclusivamente para QuickJS y el destino Windows/MSVC. La adaptación de `stdatomic.h` para el Clang del NDK copia sin modificar la cabecera instalada de Visual Studio a `OUT_DIR`; no distribuye esa cabecera ni modifica el SDK. Se mantienen assertions, atomics, O2, un único worker, preparación de 192 MiB/12 s, decodificación de 32 MiB/1 s y pila de 512 KiB.

La medición local usa NDK clang-cl 18.0.4; el workflow usa el LLVM ya instalado en Windows CI, que puede ser la versión 20. No se ha ejecutado esa CI como parte de esta evidencia: compatibilidad y rendimiento allí siguen sin acreditarse. Linux, macOS y Android no usan este selector de compilador de Windows. La modificación requiere reconstruir la aplicación; una receta del extractor no sustituye el código C.

En el harness aislado, MSVC/switch promedió 3620,55 ms, Clang/switch 3675,5 ms y Clang/dispatch directo 2816,6 ms. Cada motor pasó siete pruebas de aislamiento; el directo conservó las salidas de cuatro fixtures y cuatro formatos por fixture. Estos tiempos no son tiempos de arranque de la aplicación. Se excluyó un primer control Clang/switch que reutilizaba por error el binario directo.

### Fase A: 24 intentos release, sin sesión

Dos intentos por canción y binario, orden alternado, proceso nuevo y `FreshDecoder` en cada intento. Esa opción omite lecturas de la caché de decoder en disco; no borra cachés del sistema operativo o de red ni elimina la memoria usada dentro de un proceso. Las variables experimentales de política estaban ausentes. Ambos binarios corresponden a `fb4f3d574dda419c55828541fdb62aeb92588214`.

La tabla muestra medianas de `firstSoundMs`, desde el inicio de la operación hasta `playing` en un Audio silenciado. Es una observación de reproducción, no una medida acústica. «Con búsqueda» incluye buscar y resolver; «ID directo» empieza con el vídeo conocido y no sustituye esa prueba.

| Modalidad | Canción | MSVC/switch, ms | Clang/directo, ms | Reproducciones control → candidato |
|---|---|---:|---:|---:|
| Con búsqueda | Epoitaitaye (`DJzjkMBMook`) | 5490,50 | 4613,00 | 2/2 → 2/2 |
| Con búsqueda | Maite Zaitut! (`WtTRMAoN2Fw`) | 5410,45 | 5053,80 | 2/2 → 2/2 |
| Con búsqueda | Pupu Eta Lore (`kcUgLakr7bU`) | 4833,05 | 3999,35 | 2/2 → 2/2 |
| ID directo | Epoitaitaye | 4625,00 | 5565,00¹ | 2/2 → 1/2 |
| ID directo | Maite Zaitut! | 4679,00 | 4781,00 | 2/2 → 2/2 |
| ID directo | Pupu Eta Lore | 4585,50 | 3818,00 | 2/2 → 2/2 |

¹ Un único tiempo medido; el otro intento falló. No es una mediana de dos éxitos ni permite omitir el fallo.

Con búsqueda, la mediana de los seis intentos pasa de 5064,55 a 4585,30 ms (−9,46 %); los doce eligieron el ID esperado y utilizaron Native, sin Legacy. El criterio histórico de 300 ms sigue fallando en todos y se conserva separado del objetivo actual de 3500 ms. En ID directo hubo seis éxitos del control y cinco del candidato: sus medianas entre éxitos son 4604,50 y 4384 ms, respectivamente, con distinta completitud y disponibilidad de red. Los 403 observados no permiten atribuir toda la diferencia a CPU ni a publicidad.

Los once ID directos que reprodujeron usaron `WEB_EMBEDDED_PLAYER`, formato 251, sondas 206 al comienzo y al 80 %, reproducción, salto y comprobación breve de la cola correctos. No hubo escucha continua completa. Las búsquedas no registraron cortes ni esperas después de `playing` en su breve ventana inicial; eso no acredita cero cortes durante la canción ni EOF. No se midieron anuncios vistos, saltados o entregados, ni se usó Premium.

### Fallo de configuración y corrección canary

El segundo Epoitaitaye directo del candidato falló con `CONFIG_VERSION_FORMAT` dos veces, a 198,31 y 321,94 ms. Consumió la renovación y terminó sin POST de player, análisis, descifrado, sonda CDN ni audio. Otro intento del control, Maite, sí recuperó una primera configuración rechazada y reprodujo; ambas situaciones quedan en el histórico.

La versión concreta del fallo histórico no se guardó. Una reproducción pública posterior mostró un token oficial con sufijo `canary_control` que la gramática anterior rechazaba. `b666871` admite tokens ASCII acotados y conserva íntegro el valor en cuerpo y cabecera, manteniendo la igualdad de campos, identidad del vídeo, comprobación MFK, ST del análisis completo, selección original y sondas estrictas. No se atribuye el rechazo a gzip.

La prueba real de metadatos aceptó esa configuración y devolvió HTTP 200 con el ID correcto y ST 20746, pero terminó **FAILED / `SABR_ONLY`**: cuatro candidatos originales sin URL ni cipher. No hubo sonda CDN ni reproducción ni prueba de Legacy. Demuestra la corrección de admisión del token, no recuperación universal del audio. La reproducción canary posterior de la fase B es otro intento y no borra este fallo.

### Parser combinado: evidencia aislada

`1028f0f` conserva el parser completo y sus límites. Especializa snapshots de posición, nodos hoja y un filtro negativo previo al matcher de timestamp; las coincidencias posibles, escapes Unicode y rangos inválidos siguen por el matcher original. Versión, hash de Meriyah, opciones y puntos de transformación están fijados; `currentLocation`, posiciones UTF-16 y diagnósticos se conservan.

Un perfil alternado de dos controles y dos candidatos dio 2415 → 2080 ms de preparación interna: −335 ms, −13,87 %. Excluye la evaluación inicial del bundle y usa un asset de perfil, por lo que no es una mejora medida del arranque de la aplicación final. El diferencial conserva 889 casos de sintaxis/errores (650 rechazos), 38 casos específicos y cuatro fixtures con cuatro formatos exactos por fixture en Node; el perfil QuickJS conserva script y ST. El bundle productivo generado tiene 300436 bytes y SHA-256 `a982864f70e47700d48f89a01132e3c8b9b6643ee7616596a6e1218aacfb9b31`.

### Fase B: aplicación intermedia con búsqueda y regresión 30

El índice `round6-cold-search-20261023-170034-44e65ca0` compara el Clang de la fase A (`3527396c…`, `fb4f3d5`) con el release final (`019577f7…`, `1028f0f`). Hay dos intentos por canción y binario, doce procesos distintos, perfil anónimo, `FreshDecoder`, primera preparación `analyzed` y ninguna variable experimental de política. Los doce hashes de informes y doce de stderr coinciden con el índice; las métricas y metadatos coinciden con los informes originales.

| Canción, búsqueda incluida | Clang anterior: mediana [dos intentos], ms | Final: mediana [dos intentos], ms | Native / IDs correctos | ≤3500 ms |
|---|---:|---:|---:|---:|
| Epoitaitaye | 5525,75 [6032,2; 5019,3] | 4670,80 [5765,1; 3576,5] | 4/4 | 0/4 |
| Maite Zaitut! | 5463,75 [4984,2; 5943,3] | 5071,85 [5572,9; 4570,8] | 4/4 | 0/4 |
| Pupu Eta Lore | 4039,10 [4052,9; 4025,3] | 3633,45 [3566,8; 3700,1] | 4/4 | 0/4 |

La mediana de los seis controles es 5001,75 ms y la de los seis candidatos 4135,45 ms (−866,30 ms; −17,32 %). El candidato oscila entre 3566,8 y 5765,1 ms. Son muestras pequeñas con disponibilidad CDN variable y dos cambios entre versiones, no una atribución exclusiva al parser. No hubo Legacy ni fallos de extracción; todos conservan el fallo histórico de 300 ms y fallan el objetivo de 3500 ms. Los doce registran cero cortes y esperas después de empezar en la ventana breve, con `completeNotExercised=true`; no se acredita EOF ni escucha completa.

La fila 9, Maite candidata, usa la versión pública con sufijo `canary_experiment`, obtiene cuatro ciphers válidos y conserva el preview sólo después de comprobar ST 20746 mediante el análisis completo. Reproduce por Native a 4570,8 ms con el ID esperado. Ésta sí acredita un arranque canary concreto; no transforma el ensayo anterior `SABR_ONLY` en éxito ni demuestra compatibilidad universal.

La regresión `result-20261023-170430-f3e039dc.json`, del mismo binario final y perfil anónimo, tiene **30 Native, 0 Legacy, 0 fallos de extracción y 30/30 IDs exactamente iguales al corpus** `tests/fixtures/real-albums.capture.json`. Inicio con búsqueda: mínimo 437,1, mediana 693,4 y máximo 1559,7 ms. Los treinta conservan únicamente el fallo histórico de 300 ms; `gaps=0` cubre sólo el inicio breve y `completeNotExercised=true` en todos. Es una tanda en un proceso, no treinta primeros arranques aislados. No acredita anuncios, transiciones naturales, archivos completos ni cero cortes durante treinta canciones.

### Ensayos descartados y comprobaciones cerradas

| Ensayo | Resultado aislado | Decisión |
|---|---|---|
| Clang O3 frente a O2, dos pares | 3055,7 → 3017,4 ms, −1,25 %, con deriva temporal | No se adopta; no hay ganancia robusta |
| `RustAllocator` limitado al Runtime frente al CRT | 2853,75 → 2993,3 ms, +4,89 % | No se adopta; sin cambio de allocator global |
| AOT del parser WASM | Sólo estudio; no hay compilador AOT probado con fuel, cancelación y pila acreditados | No implementado ni medido; no se relajan límites |

Las pruebas cerradas pasan: 434 JS, 233 Rust y 28 Rust ignoradas; tipos sin errores ni avisos; regeneración del bundle idéntica. El log Rust anterior de 231/27 queda conservado y no se confunde con el posterior de 233/28. Estos checks no sustituyen la validación final en aplicación.

El cierre de archivos completos, Android, precarga y procedencia aparece después de las fases C/D/E.

### Evidencia local de esta fase

Los informes y logs originales permanecen ignorados, sin publicar URLs firmadas ni datos de sesión. SHA-256 completos:

| Archivo bajo `capture-bench.local/` | SHA-256 |
|---|---|
| `round6-release-config-analysis.json.local` | `7bf8c14df8b6af67f6bae8596d5eab6cc4c5eeaccc0c14aabaf137e72b3f757f` |
| `round6-cold-search-20261023-163104-5cfa5f43-index.json.local` | `1262d3719c9b2e25ff6fc3552ddd1fff9a2bae06218c9dbc3eba715ef1acbc0f` |
| `cold-paired-20261023-163221-50fcc93d-index.json.local` | `64f8b059670c5dc6e85016c73aa4201432c7dcc46b4a69c2da8036a4032aad88` |
| `quickjs-direct-dispatch-closed.json.local` | `3f883b0f8db12a9d651c72df98e8a2e5c3d789006bc8449cfb09b09414e99cb8` |
| `canary-fix-summary.json.local` | `4000ff4949c6704a8763675110cad00d36f5362fcd62f45e270dfcfa47d62fe5` |
| `combined-parser.local/20261023-164803-quickjs.json.local` | `813158a5defcc893bd0bfbb36c8aedaea79e76481fe1a13e397db2c6c7c38f80` |
| `round6-discarded-frontend-experiments.json.local` | `e1a62266452748496bd1cf8da8d469ec6b8dab3a66c828ff5c79dbdb9ad95b34` |
| `round6-final-all-js-tests.log.local` | `022f32bacfb4c6f4819ab5763215177eaf285c21c4579b534eb9af4e9a1df1e9` |
| `round6-canary-parser-rust-tests.log.local` | `fefd3e8f3ba6c9061ec38af8bf95b7ece30f52eef8b75d4e9446a1bcc5c63ad3` |
| `round6-final-bundle-check.log.local` | `5844581fed0659c73551a7e4cab0a5e0b657473736bc8a1f3e7b102c47aa89b1` |
| `round6-typecheck.log.local` | `bb0271dc4ee6c27a9d576ab9eabf4e62d672c8a9152df5e7013bce452cdb916c` |
| `round6-final-search-analysis.json.local` | `e99f3eb31bead6e51630870c1a9cef75c2cc92516aaf1c6bfa0d1679319cb0e2` |
| `round6-cold-search-20261023-170034-44e65ca0-index.json.local` | `11373e12da126133763add0be02ef2eca0a6e9fee539a7e14b77c419c3df4525` |
| `result-round6-cold-search-20261023-170034-44e65ca0-9.json.local` | `f6062c8a52c3983a1250a48cdba8d8f0d57685355757fed0095ad5e77b15cb0f` |
| `stderr-round6-cold-search-20261023-170034-44e65ca0-9.log.local` | `541d69e5bf4d1ea664d1d53728234b68ba9bd5970d0a646a97998b4c4f7c048f` |
| `result-20261023-170430-f3e039dc.json` | `3f83d37f953dff8baedeae439d7232c8ab1f1f377b5e2f15679aa784286aedb0` |
| `metadata-20261023-170430-f3e039dc.json` | `5322c7a50a0209fb5ce4e728bba19d4d891f7ceeb7c043845a69c979db88b4a3` |

Los índices verifican los hashes de los 24 informes y sus 24 stderr. Los metadatos declaran proceso frío, perfil anónimo, omisión de caché de decoder y ausencia de variables experimentales; sus hashes registrados no son una segunda atestación independiente. Binario control: `d25139ada3b495279d7fae8af4a6a01d3d5e3465dabb3473ac0f314e3105aed8`. Candidato fase A: `3527396c2caca582b407bd73262bb05ff57e6a9f6ae54ec156e184abae2ea2ec`. No corresponden al binario final de la fase B.

La fase B verifica por separado otros doce informes y doce stderr. Binario final: `019577f7b058e9edfcd5d42ac014a6fb45aa6c50f6f28d6b2d22f6e58ad0bbbb`, commit `1028f0faaaed05efaf3437ac71f7e497272eb85f`, release NDK clang-cl 18.0.4. Corpus usado para contrastar los 30 IDs: SHA-256 `6756d46eb38be94261e9d56bdb2a88db8ac8a345e3f6965fc3db9a92ca2fd9dd`.

### Precarga inicial acotada: fases C y D

`3439ee5` adelanta únicamente los GET públicos watch/embed de la primera
resolución foreground sin caché del proceso. No adelanta AST, POST, admisión de
configuración, consumo o descifrado. `7ba7f01` reduce la demora de 100 a 25 ms;
`ab50207` elimina la demora intencional. Cada resultado pertenece al ID y a la
resolución que lo solicitó; se adopta una sola vez y sigue todas las guardas.
Son dos documentos de hasta 4 MiB cada uno, no una cota de RSS. Cada GET dispone
de cuatro segundos desde su despacho; adoptar no reinicia el transporte. El
plazo de admisión/configuración empieza al adoptar y no es una cota única de
cuatro segundos desde la reserva. Drop aborta tareas pendientes, pero no desenvía
una petición; invalidar un ticket no equivale por sí solo a destruir el futuro
Native. El coste posible es de dos GET adicionales en el primer camino rápido
del proceso, aunque finalmente no necesite el respaldo incrustado.

Dos intentos por canción y binario en cada fase; búsqueda incluida y un proceso
anónimo nuevo con FreshDecoder por intento. Control C/D: `019577f7…`, sin esta
precarga. Candidato C: `56227e70…` (100 ms); D: `b22edb24…` (25 ms).

| Fase / canción | Control: dos intentos, ms | Candidato: dos intentos, ms |
|---|---:|---:|
| C / Epoitaitaye | 5757,8; 6623,2 | 5593,1; 3459,8 |
| C / Maite Zaitut! | 5608,4; 4634,0 | 4974,2; 5400,8 |
| C / Pupu Eta Lore | 3549,7; 3603,0 | 3605,8; 3509,3 |
| D / Epoitaitaye | 3569,4; 5574,6 | 3504,4; 4466,0 |
| D / Maite Zaitut! | 4658,6; 5511,0 | 5442,8; 6394,8 |
| D / Pupu Eta Lore | 3579,8; 3524,3 | 3496,1; 3422,2 |

Las 24 filas reproducen por Native con el ID esperado, sin Legacy. C pasa de
mediana 5121,2 a 4290 ms y de 0/6 a 1/6 dentro de 3500 ms. Sin embargo, cinco de
los seis candidatos adoptan antes de cumplirse los 100 ms: sólo uno obtiene
unos 17,7 ms reales de adelanto de GET. El control registra doce 403 y el
candidato siete; no se atribuye la diferencia de 831,2 ms al hedge.

D pasa de mediana 4119,2 a 3985,2 ms y de 0/6 a 2/6 dentro de 3500 ms.
**Epo a 3504,4 ms sigue siendo un incumplimiento.** Los seis candidatos sí
despachan ambos GET antes de adoptar, con 53,94–93,57 ms de adelanto. Ambos
grupos registran ocho 403; Maite empeora y uno de sus intentos tarda 6394,8 ms,
con SABR_ONLY recuperado mediante POST2 y tres 403. No se borran estos resultados
por las medidas posteriores. Los relojes de diagnóstico pueden empezar antes
por la reserva nueva: se comparan duraciones de etapa y firstSoundMs, nunca
atMs entre distintos binarios.

La regresión habitual de D (`20261023-173925-99d78677`) conserva 30 Native,
cero Legacy y 30 IDs exactos, mínimo 538,9 / mediana 775 / máximo 1066,9 ms.
Sólo observa el comienzo, sin acreditar EOF ni escucha completa.

### Fase E: versión final sin espera intencional

Comparación fija de 25 frente a 0 ms, dos intentos por canción/binario, orden
alternado, doce procesos independientes, perfil anónimo y FreshDecoder.
Índice `round6-cold-search-20261023-175143-43d118f5-index.json.local`.
Las doce filas usan Native con el ID esperado, sin Legacy; sus hashes de
informe/stderr y metadatos se contrastan con el índice y los dos binarios.
El ejecutable candidato corresponde al árbol limpio `ab50207`, release,
NDK clang-cl 18.0.4; SHA-256
`e24d090f3fb029b73335d358b9abd9bf07990f4560bbb3ceae4c0433c8326cb9`.

| Canción | 25 ms: dos intentos, ms | Final 0 ms: dos intentos, ms | Final ≤3500 ms |
|---|---:|---:|---:|
| Epoitaitaye | 3986,1; 5515,2 | 3410,7; 3360,1 | 2/2 |
| Maite Zaitut! | 4610,7; 5477,2 | 5484,9; 4390,4 | 0/2 |
| Pupu Eta Lore | 3434,1; 4082,9 | 3328,3; 3466,9 | 2/2 |

Epo y Pupu cumplen en sus cuatro intentos candidatos. Maite reproduce por
Native, pero los dos intentos incumplen. Sus primeros sondeos CDN devuelven
403: acepta el cuarto a unos dos segundos del primero en la fila de 5484,9 ms,
y el tercero a unos un segundo en la de 4390,4 ms. Es un diagnóstico de esas
solicitudes, no una prueba publicitaria ni de la causa del rechazo.

La mediana de los seis controles es 4346,8 ms y la de los seis candidatos
3438,8 ms; el objetivo pasa de 1/6 a 4/6. El cambio de temporización sólo
elimina 25 ms intencionales: **no se atribuyen los 908 ms de diferencia al
ajuste**, dada la variación de CDN y red. Las comparaciones aisladas anteriores
son la evidencia de la mejora de CPU. No se sigue repitiendo la tanda para
escoger intentos mejores. La meta de 3,5 s consistente en las tres canciones
continúa pendiente.

La regresión final `20261023-175250-7ecfa231` tiene 30 Native, cero Legacy,
ningún fallo de extracción y 30 IDs esperados: mínimo 499, mediana 699,95 y
máximo 3523,6 ms. El máximo es MALAMENTE (`mw2XM-PSqXY`): búsqueda 428,675 ms,
resolución Native 3050,102 ms y player 3041,140 ms; validación 6,243 ms.
No usa la alternativa incrustada; no se atribuye al hedge sin un control.
Se conservan el outlier y los treinta fallos del umbral histórico de 300 ms.
Los gaps/stalls observados sólo cubren el inicio breve; las treinta filas
mantienen completeNotExercised. No son treinta primeros arranques independientes.

### Archivos completos, validación y pendientes

La única ejecución nueva de `real_kids_complete_files`, sobre `7ba7f01`,
termina correctamente con tres archivos 251 frescos. El verificador exige los
tres IDs, hashes/longitudes del stdout y mtime posterior al comienzo; vuelve
a calcular las referencias independientes de yt-dlp. Los tres coinciden byte
a byte y FFmpeg 8.1 `-xerror` termina con salida 0.

| Canción | Bytes completos | Referencia idéntica | FFmpeg |
|---|---:|---|---:|
| Epoitaitaye | 3592710 | Sí | 0 |
| Maite Zaitut! | 2393910 | Sí | 0 |
| Pupu Eta Lore | 2646193 | Sí | 0 |

El ajuste posterior de 25 a 0 ms afecta al adelanto foreground; este test usa
la entrada nativa sin esa prioridad. No se presenta la comprobación de archivos
como escucha continua en la app, prueba acústica o campaña de anuncios.

- 434 pruebas JavaScript, tipos sin errores ni avisos y bundle regenerado idéntico.
- 241 pruebas Rust aprobadas/28 ignoradas en la variante de 100 ms; la variante
  final de 0 ms pasa sus 60 pruebas dirigidas/2 ignoradas, incluidos ocho casos
  de precarga, configuración, límites, renovación y plazos.
- Android arm64/x86_64: `cargo check --tests --offline --locked` correcto en
  `ab50207`, sin avisos nuevos; metadata `android-clang-vendor-checks-20261023-174816.json.local`.
  Son checks de compilación, sin nueva prueba de APK, JNI, ExoPlayer o rendimiento móvil.
- Se descartan O3, otro allocator, el sondeo de prefijo y gzip del bootstrap
  sin ganancia material demostrada. El control previo de AAC140 y Opus251 falla
  y pasa en los mismos puntos muestreados; no justifica cambiar la preferencia
  de calidad o añadir más sondeos. No prueba disponibilidad simultánea exacta
  ni excluye una mejora futura. La revisión detecta que ocho es la cota de
  intentos del primer candidato: los siguientes admiten uno cada uno dentro
  del mismo plazo CDN de ocho segundos. No es un contador global de ocho
  peticiones; una política intercalada necesitaría definirlo explícitamente.

| Perfil | Evidencia de esta ronda | Anuncios vistos / saltados / entregados |
|---|---|---|
| Sin sesión | A/B/C/D/E, corpus habitual y tres archivos completos | No medidos en esta ronda |
| Premium | No repetido; referencias históricas separadas | No medidos en esta ronda |

Epo ya no necesita Legacy en las pruebas finales: sigue la ruta Native y
conserva identidad, audio original y sondas estrictas. El respaldo Legacy se
mantiene para otros fallos; no se garantiza todo el catálogo. Quedan pendientes
los 3,5 s consistentes, la recuperación uniforme de SABR, la integración de
`origin/main`/youtubei.js 18.3, CI con su LLVM concreto y rendimiento móvil real.
No cambia la aprobación de Oficial/progresiva ni sus límites. yt-dlp continúa
predeterminado y Propio recomendado. No cambian UI, db.rs, downloads.rs,
capture.js, receta, youtubei.ts ni API de extractores; sí cambia el bundle
privado compilado. Requiere una app nueva; no actualiza la PWA ni se entrega
publicando sólo un extractor. Sin etiquetas, releases, publicación de
extractores ni cambios en main; sólo push de p1-oficial para revisión.

### Procedencia final y commits

Además de los commits de configuración, Clang y parser de la tabla inicial:

| Commit | Cambio |
|---|---|
| `3439ee5` | GET públicos iniciales acotados en paralelo, 100 ms |
| `7ba7f01` | Demora de 25 ms |
| `ab50207` | Sin espera intencional, tests dirigidos finales |

El manifiesto local `round6-final-manifest.json.local` registra **867 archivos**,
verificados en dos pasadas sobre el árbol limpio `ab50207`; SHA-256
`f9987f1a21b83a21608843b3dbeeb5da416c8dea9b10f92d4b58d2c29c1558ce`.
Incluye fuentes, inventario/licencias vendor, ejecutables inmutables,
procedencias, índices, todos los resultados y stderr de comparación, audio,
referencias y verificadores. Los documentos quedan fuera para evitar hashes
circulares. Hay 616 referencias excluidas: 88 de compilación y 528 externas
(principalmente Cargo registry). Las 42 nominales sin resolver son 39 bins de
documentación vendor no instalados y tres alias cuyos archivos sí están
incluidos por rutas completas. Ningún informe medido falta. No equivalen a
fallos de los hashes incluidos. Los archivos
de perfil, cuentas, dependencias instaladas y artefactos target no se recorren.
Sólo código y resúmenes se suben a la rama; los raws y audios permanecen en
carpetas locales ignoradas.

## Ronda 7: decodificador mínimo y transporte compartido de Music

Código guardado en `98f964b` (asset mínimo) y `a32092b` (transporte Music). Se conservan los controles aislados y después la única tanda final de aplicación. Pasan 245 pruebas Rust/30 ignoradas, 436 JavaScript, tipos, ambos assets reproducibles y checks Android; esos controles no equivalen a lograr 3,5 s estables.

La VM desechable que calcula firma/n carga ahora sólo el asset de ejecución (3.398 bytes), sin volver a cargar el analizador completo (300.534 bytes). El mismo ejecutable Clang 18 y la misma creación de runtime compararon ambos assets en orden ABBA, con 32 llamadas por brazo. La media de la llamada completa pasó de 39,94 a 24,19 ms: unos 15,76 ms menos. Incluye cola, validación, creación, evaluación, hardening, ejecución y destrucción; no es el tiempo de análisis AST ni de arranque de la app. Cuatro fixtures por cuatro formatos conservaron script, ST, firma y n exactos frente al golden independiente y al asset completo. La VM sigue acotada dentro del proceso, con un trabajador y límites de preparación de 192 MiB/12 s, ejecución de 32 MiB/1 s y pila de 512 KiB; no constituye una frontera de aislamiento del sistema operativo. No se introduce caché de VM.

El bootstrap público y la búsqueda Music comparten transporte HTTP conservando sus políticas y cabeceras por petición. Una tanda anónima S→C→C→S, en cuatro procesos nuevos de depuración, dio dos respuestas válidas por brazo y 20 candidatos por respuesta. Las medianas fueron 789,05 ms con transportes separados y 678,19 ms con transporte compartido. Es una observación con n=2 por brazo, sin medida de sonido ni atribución causal universal. Ambos brazos usaron el mismo logger basado en JSON Value; las respuestas remotas no fueron byte-idénticas. Después se serializó el diagnóstico antes de escribirlo, validando en prueba sintética que los bytes del log permanecen iguales; no se repitió la red para seleccionar otro resultado. El tiempo no asignado entre fases incluye logging y otros trabajos, no sólo conexión o parseo.

Se descartó cambiar la cabecera `Range` por el parámetro `range=`. Una única tanda de tres POST y nueve GET comparó A–B–A sobre la misma URL validada por canción: A usa cabecera y B usa query, sin cambiar UA, Origin ni Referer. Epo y Maite devolvieron 403/403/403; Pupu devolvió 206/200/206. El 200 declaraba 1.024 bytes pero carecía de Content-Range y se rechazó. Los seis 403 no incluían Retry-After. No hubo SABR ni 429 en esta tanda, ni reproducción, Legacy o prueba de EOF. La muestra sólo cubre los primeros instantes de esas respuestas; un 403 no identifica anuncios. Incluso una mejora de la sonda query no demostraría que la URL original usada por HTMLAudio esté lista para reproducir y buscar. No se cambia Range ni el calendario: los registros no aportan una señal que prediga disponibilidad, y redistribuir los mismos ocho intentos desplazaría la espera entre ventanas. Permanecen la validación 206/rango/longitud/encoding exactos, el plazo CDN compartido de 8 s, la detención ante 429 y la omisión de slots vencidos. El límite de ocho corresponde al formato preferido; los candidatos posteriores conservan su política ya documentada bajo el mismo plazo.

Procedencia compacta (artefactos privados ignorados, sin URLs firmadas en este documento):

| Evidencia | Archivo bajo `capture-bench.local` | SHA256 |
|---|---|---|
| Miniasset, medidas completas | `decoder-minimal.local/result.json.local` | `1dbb818adef203bb5b84367adc8e73ee0caf504a16018265c06278e421f60c9b` |
| Miniasset, cuatro fixtures exactos | `decoder-minimal.local/golden.json.local` | `02159c867f8f349042878c9263d4710428d68df1a6bfed288f7cbbc5a06e2e24` |
| Transporte, cuatro intentos y límites | `music-transport-20261023-192950-analysis.json.local` | `162ca5c741ef5194d8264c39070f8df2a731ce7c7363f78e9a21719ac8784ea5` |
| Range A–B–A, manifiesto de 12 artefactos | `range-query-probe-1792776496688.local/manifest.json.local` | `94c6d2298e9348292c5fe2579c1e698ec9f6ba61ca4f956c4bbcf115218a6250` |

### Comparación final en la app: una tanda fija, sin sesión

Release, dos intentos por canción y binario, orden alternado, proceso nuevo y
FreshDecoder en cada intento. Incluye búsqueda hasta `playing` de Audio silenciado,
sin borrar cachés del sistema operativo o de red ni acreditar medida acústica.
Control: `e24d090f…`, fuente `ab50207`. Candidato: `500457c7…`, fuente limpia
`a32092b`; Clang18/O2, mismo código C y calendario CDN. El índice es
`round7-cold-search-20261023-194012-b8e4b651-index.json.local`.

| Canción | Control: dos intentos, ms | Candidato: dos intentos, ms | Candidato ≤3500 ms |
|---|---:|---:|---:|
| Epoitaitaye | 4121,8; 3482,0 | 5456,8; 5400,0 | 0/2 |
| Maite Zaitut! | 5747,3; 4533,7 | 5729,1; 5464,6 | 0/2 |
| Pupu Eta Lore | 3823,6; 3621,3 | 3660,3; 3413,6 | 1/2 |

Los doce informes, stderr, metadatos y dos ejecutables se contrastaron con sus
huellas. Hay doce Native, cero Legacy y doce IDs esperados. **El total no mejora:**
mediana de seis intentos 3972,7 → 5428,4 ms; sólo 1/6 cumple 3500 ms en cada brazo.
Los doce incumplimientos históricos de 300 ms permanecen en los datos. No se
repitió la tanda para escoger resultados más favorables ni se sustituyen los
intentos rápidos de R6: los resultados de ambas rondas siguen separados.

| Etapa observada, mediana de seis por brazo | Control, ms | Candidato, ms |
|---|---:|---:|
| Búsqueda | 617,118 | 502,588 |
| Preparación completa | 2686,883 | 2637,758 |
| Descifrado | 41,0115 | 24,2492 |

La búsqueda y el descifrado mejoran en los seis pares: la primera ahorra
42,7–209,5 ms y el segundo unos 16,76 ms de mediana. La preparación no muestra
una regresión sistemática. Esto acredita mejoras de esas etapas, **no del
arranque total ni un máximo estable**. Los loggers antiguos de Native siguen
idénticos en ambos ejecutables; las nuevas líneas Music se serializan antes de
escribir para no añadir la fragmentación del diagnóstico preliminar.

Epo candidato registra tres 403 antes del 206 en ambos intentos: ventanas CDN
de unos 2027/2039 ms frente a 425/17 ms del control, que no registra 403.
El segundo Maite candidato espera unos 2027 ms y tres 403 frente a 1028 ms y
dos 403 en su control. Esas esperas explican los totales observados más altos;
no demuestran que compartir el pool provoque el rechazo ni que sea publicidad.
El primer Pupu candidato recupera SABR_ONLY con preview2 válido antes de verificar
ST; se consume esa segunda respuesta y arranca en 3660,3 ms. No se oculta el
incumplimiento ni se atribuye la recuperación al nuevo asset.

### Corpus habitual y archivos completos

La tanda final `20261023-194208-d35cce0a` mantiene **30 Native, cero Legacy,
cero fallos de extracción y 30 IDs exactamente iguales al corpus**. Inicio con
búsqueda: mínimo 507, mediana 737,45 y máximo 2020,6 ms. La mediana anterior de
R6 fue 699,95 ms; tampoco se acredita una mejora del corpus habitual en esta tanda.
El máximo es Airbag (`jNY_wLukVW0`): búsqueda 598,353 ms, Native 1000,547 ms
(validación 881,341; player 79,760), con unos 401,3 ms entre inicio del observador
Audio y `playing`. No se atribuye ese conjunto a CPU o al pool sin un control.
Las treinta filas conservan el fallo de 300 ms y completeNotExercised; gaps/stalls
0/0 sólo cubren el prefijo, no EOF, la canción completa o transiciones naturales.

Se repitió una sola vez el test de los tres archivos completos con el ejecutable
de tests de `a32092b`, cuya copia inmutable y hash se registran en
`round7-complete-audio-test.json.local`. Los tres archivos 251 son nuevos de esa
ejecución, coinciden byte a byte con las referencias de yt-dlp y FFmpeg 8.1
`-xerror` termina con 0 para cada uno. El verificador no admite archivos antiguos
para cubrir fallos; resultado **3/3**, SHA-256 del informe
`8a3a47f57762d9ade154e058a19be6fedbbe33d31c0629cff640cf77ea9e504a`.
Se conservan copias de los archivos anteriores en una carpeta local ignorada.
Esta prueba acredita esos archivos, no escucha continua en la app ni una
campaña de transiciones publicitarias.

Los checks Android arm64 y x86_64 pasan sobre `a32092b`, sin avisos nuevos y
con ambos assets registrados: metadata `android-clang-vendor-checks-20261023-193446.json.local`.
No se midió APK, JNI, ExoPlayer ni rendimiento Android. Las 245 pruebas Rust
(30 ignoradas), 436 JavaScript, tipos y regeneración de ambos assets pasan
en este snapshot. La prueba nueva de formato del logger forma parte de las 245.

### Alcance y pendientes

Se conservan ambos cambios por su mejora medida de búsqueda/descifrado, sin
promoverlos como logro de los 3,5 s ni como mejora estable del total. Epo sigue
funcionando por Native sin Legacy en esta tanda, pero sus dos tiempos actuales
son mayores que los de R6. Queda pendiente reducir la espera CDN y volver a
acreditar el objetivo total; no se cambia el calendario sin una señal útil.

Todas las medidas nuevas son sin sesión. Premium y anuncios vistos/saltados/
entregados no se midieron de nuevo. No cambia Oficial, su aprobación progresiva,
sus límites ni el respaldo Legacy de Propio. yt-dlp sigue predeterminado.
No se modifica UI, db.rs, downloads.rs, capture.js, receta, youtubei.ts ni API
de extractores. El ABI de caché incluye ambos assets y exige una app reconstruida;
la mejora no llega por publicar un extractor ni cambia la PWA. No hay etiquetas,
release, publicación de extractores, merge ni push a main; sólo la rama p1-oficial.

### Procedencia final

Ejecutable release candidato: SHA-256
`500457c7529fe68df18ec53e5a4ba7729837fcb93a37c38b5ab15adca0f9a132`.
Asset completo: `d8ab279061005efb04bf43a79794e7aeec2b0dff47a2d3e522f82f3a1d9b2f30`;
ejecución mínima: `dc4418c255b34dce1667f26d2279b1def32016d195ba51aca93bb0a53bf54ac8`.
El manifiesto local `round7-final-manifest.json.local` contiene **507 archivos**,
verificados en dos pasadas sobre `a32092b`, base `0045015`; SHA-256
`68cbeeb76fab838105b15031d688b5c1687fc7d80ea5c7e970c65d7b19ff083c`.
Incluye ambos ejecutables y procedencias, todas las filas de la comparación,
errores, metadatos, fuentes, pruebas, referencias y verificadores de audio.
Los documentos quedan fuera para evitar hashes circulares. Las 307 referencias
excluidas son 43 rutas target y 264 fuentes Cargo externas; las 39 nominales sin
resolver son nombres de binarios npm del lockfile de documentación upstream.
Ninguna evidencia medida falta. Estos casos no se confunden con fallos de las
huellas de archivos incluidos. Sólo se suben
código y resúmenes; raws, medios y perfiles permanecen fuera de Git.

## Ronda 8: diagnóstico del CDN y candidato retirado

Se contrastaron tres variantes de URL, un estudio temporal y el contexto oficial omitido. La comparación fría de app con este último no acreditó mejora: se retira el candidato y se conserva R7. La meta estable de 3500 ms sigue pendiente.

### Tres variantes sin beneficio observado

Cada variante usó una respuesta nueva por canción y tres GET consecutivos A/B/A sobre el mismo audio original itag 251. Se mantuvieron identidad, ST y descifrado verificados, Range, respuesta 206 y validación exacta de 1024 bytes al 80%; no se aceptaron respuestas 200 ni se siguieron redirecciones.

| Variante B | Primer GET desde inicio del POST | Epoitaitaye | Maite Zaitut! | Pupu Eta Lore |
|---|---:|---|---|---|
| `alr=yes` | 306,736–366,971 ms | 403/403/403 | 403/403/403 | 206/206/206 |
| Servidor secundario publicado; ALR fijo en todos los brazos | 2603,829–2616,581 ms | 403/403/403 | 403/403/403 | 206/206/206 |
| `cver` igual a la versión descubierta; sin ALR | 2601,192–2609,924 ms | 403/403/403 | 403/403/403 | 206/206/206 |

Total: 9 POST y 27 GET del helper, 18 respuestas 403 y 9 respuestas 206 estrictas; cero respuestas 429, 200 o cabeceras Location. Todas las conexiones observadas usaron IPv4 y HTTP/1.1. El contador corresponde a las solicitudes CDN del diagnóstico; no incluye los GET de descubrimiento.

No se observó ventaja de ninguna variante en esas muestras. ALR se ensayó mucho antes que las otras dos: no son tres mediciones equivalentes del arranque frío. El secundario combina cambio de host con `fallback_count=1`; el resultado tampoco separa esos dos efectos. Las fechas HTTP tienen resolución de un segundo, sin Age ni Retry-After que identifiquen un reloj de admisión.

### Estudio fijo de la edad del POST y del primer GET

Se prepararon configuración y AST antes de T0. Por ID se mantuvieron cuerpo, configuración y ST fijos, con una respuesta firmada propia por intento y orden ABCCBA. A envía POST en T0 y GET inmediato más GET en T0 + 4 s; B omite el GET inmediato; C retrasa el POST 1 s y mantiene el GET en T0 + 4 s. Cada GET usa un cliente nuevo y conserva la URL recibida sin parámetros añadidos.

| Brazo | Edad real del POST en el GET común de Maite | Maite | Epo |
|---|---:|---|---|
| A | 3996,047 / 3998,270 ms | GET inicial 403; GET común 206, 2/2 | 4 GET con 403 |
| B | 3987,132 / 3996,252 ms | GET común 206, 2/2 | 2 GET con 403 |
| C | 3007,287 / 3006,017 ms | GET común 403, 2/2 | 2 GET con 403 |

Se ejecutaron exactamente 12 POST y 16 GET: cuatro respuestas 206 estrictas y doce 403; cero respuestas 429 o redirecciones. Todos los casos llegaron al CDN, con itag 251 e identidad correcta. Las tardanzas frente al GET previsto fueron 1,467–13,595 ms, mucho menores que el segundo que separaba los brazos. Epo no mostró disponibilidad en ninguna de sus ocho sondas, incluidas las enviadas aproximadamente 4 s después del POST.

En Maite, el GET inicial de esa respuesta no fue necesario para los éxitos observados a unos 4 s. Retrasar el POST 1 s mantuvo el 403 en las dos réplicas. Es compatible con disponibilidad dependiente de la edad de los metadatos, pero no identifica el inicio interno de un bloqueo ni separa POST, cabeceras y EOF de respuesta. Respuestas diferentes y estado compartido del servidor impiden atribuir una causalidad universal. Tampoco puede descartarse influencia de solicitudes de brazos anteriores.

Estos datos no justifican añadir sondas de activación ni esperar siempre 4 s: Pupu ya respondía 206 inmediatamente. Una mejora futura necesitaría un retraso evitable concreto y una comparación fría apareada de su eliminación, conservando las validaciones y el presupuesto de solicitudes. No se ha seleccionado un nuevo umbral ni cambiado el calendario productivo.

### Alcance y procedencia

Los diagnósticos HTTP usaron la revisión `60938ebd8322f154fb698570d61ba18d0f083f0f` con inclusión temporal sólo de pruebas. Sus manifiestos registran la restauración de `native_embedded.rs` al SHA256 `7f1c79c8fea91f5881fe8001b6c5556be3740e295813d9a9d9cb86100c5605a2`. La candidata posterior y su retirada se distinguen al final.

| Evidencia local | SHA256 |
|---|---|
| `round8-cdn-fixed-diagnostics.json.local` | `7505e75640ac400dd2102da164843cfd04173ba951589269748016804192f7ca` |
| `post-get-causal-1792779718429.local/report.json.local` | `41b8f504d50db82080ccbe7df023add17e14f0d9f87115075ceb27a5f953871a` |
| `post-get-causal-1792779718429.local/summary.json.local` | `e6d4bfbde820188a2c61d70d8d6666110825cc2d601d6f2cf7b89042da6b5e49` |
| `post-get-causal-1792779718429.local/manifest.json.local` | `2cb037b9c2e1c549f979828729ea4626040f5726dfe835a131c5ed8711f667a5` |

Los EXEs de los tres primeros diagnósticos no se archivaron: sus hashes fueron observados al ejecutarlos, pero el artefacto de `target/debug` se sobrescribió posteriormente. El estudio causal sí conserva su EXE inmutable, SHA256 `700cbf0ebef05feaea1fb60e91fb302b3f99edfad5054f93c2aae31f64782186`, además de procedencia de compilación y ejecución. La revisión independiente contrastó informes, manifiestos, contratos y archivos pequeños; no volvió a calcular hashes de EXEs.

Se conservó un fallo inicial de compilación del helper cver por codificación UTF-8, corregido antes de su única tanda de red. Los contratos locales finales pasaron: ALR 1, secundario 4 y cver 1; causal 3. No se omitieron intentos CDN fallidos.

Los 206 y `bodyEof` sólo acreditan el fragmento HTTP de 1024 bytes. No prueban EOF de canción, igualdad de archivo completo, anuncio reproducido o saltado, ni mejora del primer sonido. Las respuestas, URLs firmadas y logs brutos permanecen fuera de Git; sólo corresponden al diagnóstico local.

### Contexto publicado: diagnóstico inconcluso

Se contrastó A/B/A, donde B añadía únicamente el objeto `embeddedPlayerContext` descubierto en la misma configuración. Hubo 9 POST y sólo 3 GET: Maite y Pupu devolvieron SABR_ONLY en sus seis brazos, sin URL utilizable ni comparación CDN. Epo respondió 403/206/206 a aproximadamente POST + 2,6 s; también pasó el último A, por lo que el resultado no aísla una ventaja de B. No se atribuyen estos estados a anuncios. Reporte SHA256: `c39ed6ad1d31b1106d4c4b414e52fd7d0a8125d3677848fa96f3f7349bfd940d`; manifiesto: `ee9ea6e0cc5a99234d65ace17f49360d64ed154910040c22296f4f3aca49c277`.

### Comparación en app: candidata retirada

Una tanda fija comparó R7 (`a32092b`, binario `500457c7529fe68df18ec53e5a4ba7729837fcb93a37c38b5ab15adca0f9a132`) con la candidata `fa46e10`, binario `f929f7a77ed5fd85de7d15f6c70f4d0c320b704b7b5567af57720d74584f2458`. Ambos eran release de fuentes limpias, con idéntica política CDN. Hubo dos réplicas por ID y binario, orden alternado, proceso nuevo anónimo y FreshDecoder: doce casos, todos conservados.

| Canción | Réplica | R7, ms | Candidata, ms | Diferencia, ms | Respuestas 403 R7/candidata |
|---|---:|---:|---:|---:|---:|
| Epoitaitaye | 1 | 3683,7 | 5034,6 | +1350,9 | 0/2 |
| Epoitaitaye | 2 | 3545,2 | 3556,7 | +11,5 | 0/0 |
| Maite Zaitut! | 1 | 5412,6 | 5789,7 | +377,1 | 3/3 |
| Maite Zaitut! | 2 | 4577,4 | 4344,7 | −232,7 | 2/2 |
| Pupu Eta Lore | 1 | 3614,6 | 3499,6 | −115,0 | 0/0 |
| Pupu Eta Lore | 2 | 3383,5 | 3478,0 | +94,5 | 0/0 |

La mediana pasó de 3649,15 a 3950,70 ms; cuatro de seis pares fueron más lentos. El objetivo exacto ≤3500 ms se cumplió en 1/6 controles y 2/6 candidatas, siempre Pupu. Las doce selecciones usaron Native e ID esperado, sin Legacy. No se observaron cortes posteriores al arranque en la ventana breve; todas conservaron el fallo histórico del umbral 300 ms. Esto no acredita EOF, escucha completa ni ausencia de anuncios.

Las sondas lógicas terminadas fueron 11 frente a 13 y los 403, 5 frente a 7. Sólo Epo 1 añadió reintentos: la fase CDN hasta terminar el 206 pasó de 282,165 a 1028,329 ms, sin explicar por sí sola toda la diferencia de primer sonido. Preparación mediana: 2581,83→2621,84 ms; análisis+preview: 2521,92→2577,17 ms, más alto en cinco pares y sin ser una medida de CPU pura. Pupu candidata 2 recuperó un SABR_ONLY antes del éxito. No puede atribuirse toda la diferencia al contexto ni generalizarse causalidad a partir de seis pares.

`firstSoundMs` incluye búsqueda hasta `playing` de Audio silenciado; excluye el arranque previo del proceso y no es una medida acústica. Se verificaron las evidencias de frío, los doce casos únicos y 60 archivos pequeños; el auditor original ya verificó los binarios. Índice SHA256: `7ccaffe43de1e6155f3816c056db8788f24d5b857d9faa9cac98df7e58fb427d`; auditoría `round8-app-audit.json.local`: `71b0b5a1437203cac38dc8eebfcdb3672ce545b14bd89b84a182a88fe05fa7a8`.

`fa46e10` sólo fue una candidata: `ab7f7ff` la revierte y deja el producto idéntico a R7, con el binario de banco R7 restaurado. No se ejecutó una campaña 30, archivos completos o Android de cierre para esta candidata descartada; los resultados anteriores de R7 conservan su procedencia histórica. Todos los intentos malos de R8 permanecen en los artefactos locales.

El manifiesto final local conserva 479 archivos verificados en dos pases, SHA256 `f3e8efd6e7b6649da321c88eb6df39862a327cc9066e3abcf8ba2bde3b346b32`. `round8-source-proof.json.local` vincula la candidata y su EXE de pruebas al código: primer pase 247 aprobadas y un timeout del decoder; pase serial 248 aprobadas, ambos con 30 ignoradas. Los 39 enlaces sin resolver del manifiesto son referencias del package-lock de documentación QuickJS, no evidencia medida ausente.

Todas las pruebas nuevas fueron sin sesión. Premium y una campaña con anuncios reales
no se ejercitaron en R8; no hay nuevas cifras de anuncios vistos, saltados o entregados.
Los 28 tests sintéticos de los nuevos auditores y los contratos PowerShell pasaron;
no se confunden con pruebas del producto ni con mediciones adicionales de app.

## Ronda 9: mejoras pequeñas y medición del total

### Cambios conservados

`4bace13` mueve los seis valores permitidos de la configuración JSON ya poseída,
en lugar de clonarlos. Se mantienen selección, igualdad completa ante conflictos,
límites y errores. En los tres HTML anónimos conservados se evitan seis copias
por documento; esos valores suman unos 41,1 KB serializados, que no son una
medida de memoria asignada.

Un ensayo Rust offline en **depuración** mide análisis JSON y validación completa:
20 calentamientos y ocho bloques A/B/B/A/B/A/A/B, 250 operaciones por bloque,
1000 por brazo y HTML. Las salidas coinciden. Estos tiempos corresponden a
esa etapa local; no acreditan una ganancia release o del primer sonido.

| HTML | Media anterior, µs | Media nueva, µs | Ahorro observado, µs |
|---|---:|---:|---:|
| Epoitaitaye | 1656,49 | 1627,47 | 29,03 |
| Maite Zaitut! | 2046,05 | 1917,99 | 128,06 |
| Pupu Eta Lore | 2003,27 | 1826,91 | 176,36 |

Hay dispersión y rangos solapados, especialmente en Epo. La reducción de copias
es determinista; no se generaliza ese ahorro temporal a toda reproducción.
Datos y procedencia: `capture-bench.local/config-move-ab*.json.local`.
El EXE privado de ese ensayo no se archivó: se conservan su hash, helper,
fuentes y logs; esa evidencia no tiene una copia binaria inmutable.

`cb592e2` agrupa la cancelación cuando **ambas plazas 0 y 1** pertenecen a
precargas obsoletas: dos llamadas pasan a una usando el comando existente.
La barrera de cancelación sigue precediendo a las nuevas resoluciones. Si una
plaza se está promoviendo a canción actual, se conserva la cancelación individual.
Las pruebas cubren respuestas pendientes, Audio preparados, cancelación anterior
y promoción. Falta medir el ahorro temporal de este caso en la app; no interviene
en el primer arranque con cola vacía. Sólo cambia coordinación de reproducción,
sin modificación visual, de base de datos o descargas.

### Una tanda fría, sin sesión

Se ejecutaron exactamente doce procesos, dos por ID y binario, orden alternado,
FreshDecoder y política CDN idéntica. Control R7 `a32092b`, EXE `500457c7…`;
candidata `cb592e2`, EXE
`7e710907547280552885640bbfb4b88bc04d48bf0ab5f7b662b8e7b8aee242ee`.
Ambos son release Clang 18/O2, de fuentes limpias y con sus configuraciones guardadas.

| Canción | Réplica | Control, ms | Candidata, ms | Ruta control/candidata |
|---|---:|---:|---:|---|
| Epoitaitaye | 1 | 3451,4 | 5393,6 | Native/Native |
| Epoitaitaye | 2 | 5323,9 | 5694,4 | Native/Native |
| Maite Zaitut! | 1 | 6481,0 | 5492,0 | Legacy/Native |
| Maite Zaitut! | 2 | 4473,6 | 4637,5 | Native/Native |
| Pupu Eta Lore | 1 | 3533,6 | 3438,7 | Native/Native |
| Pupu Eta Lore | 2 | 3316,9 | 3441,1 | Native/Native |

Son tiempos brutos desde búsqueda hasta `playing` de Audio silenciado; excluyen
el arranque previo del proceso y no son mediciones acústicas. Los doce IDs son
correctos; la candidata es Native 6/6 y Legacy 0/6. El primer control de Maite
usó Legacy y no permite comparar el mismo camino. Cuatro de los otros cinco
pares empeoraron. No se acredita reducción del total ni causalidad entre los
cambios locales y esa variación. Los logs conservan 10/17 sondas lógicas
terminadas y 5/11 respuestas 403 en control/candidata; ninguna 429. El inventario
no cuenta todas las peticiones físicas ni permite atribuir rechazos a anuncios.

La clasificación del runner contiene otro fallo: PowerShell 5.1 interpreta
como ANSI el literal UTF-8 sin BOM que debía separar el umbral histórico de
300 ms. Lo añade a `row.failures` y el auditor lo conserva; por eso la auditoría
original marca **0/12 elegibles**. Los doce informes originales conservan ese
fallo de latencia. No se alteran ni se repite la tanda para obtener aprobaciones.
El diagnóstico offline con el parser real de PowerShell confirma la diferencia
de caracteres. La tabla anterior es descriptiva, no una campaña aprobada.

Índice: `round9-cold-search-20261023-222347-6fe0476e-index.json.local`;
auditoría: `round9-app-audit.json.local`, SHA256
`fb35ef1319ee21a067a1f08d9a79d362afdf9c66091c00071ee1152f0e4694bd`.
El diagnóstico separado `round9-filter-encoding-diagnostic.json.local` mantiene
la procedencia y los archivos usados intactos. Una copia nueva del runner
construye el literal de forma compatible con PowerShell 5.1; su validación
offline conserva también un fallo real diferente. No se ejecutó esa copia.

### Regresión habitual y validación

La única tanda de `real_albums`, en un proceso y sin sesión, conserva **30/30
Native, 30 IDs esperados y cero Legacy**, mediana **631,7 ms**, rango
451,9–970,5 ms. No hay huecos ni esperas observados en los prefijos. Las 30
filas superan 300 ms y el banco termina con ese fallo; no es una aprobación
de todas las metas. No son treinta arranques fríos ni escucha hasta EOF.
Informe `result-20261023-222507-a56c3647.json`, vinculado al EXE de la candidata.
La diferencia frente a la mediana histórica R7 no se atribuye a R9.

Pasan 441 pruebas JavaScript, tipos con cero errores/avisos y 245 pruebas Rust
en serial, con 30 de red ignoradas. Se conservan logs y hashes del código y EXE
de pruebas en `round9-source-test-proof.json.local`. Los checks Android arm64 y
x86_64 terminan con código 0 y sin avisos nuevos frente a su referencia. Se
conservan dos fallos del helper: tratamiento de stderr y serialización excesiva
de metadatos PowerShell. El helper corregido registra ambos checks en
`round9-final-android-clang-vendor-checks-20261023-223222.json.local`;
una compilación no mide rendimiento en dispositivo. No cambian `capture.js`, receta, `youtubei.ts`,
versiones/API ni bundles del decoder. Requiere reconstruir la app.

### Experimentos descartados y pendientes

El historial simplificado del analizador conserva los resultados semánticos,
pero las tres fuentes con ABBA completo pasan de 2112,3 a 2237,5 ms de preparación
aislada. Se descarta. Se preservan 15 verificaciones exactas y un fallo inicial
del runner por tratamiento de stderr, sin sustituirlo. El índice de timestamp
también conserva salidas y límites, pero se aparca antes de perfilar: añadiría
dos barridos completos para evitar unas pocas consultas sobre rangos cortos.
Ningún prototipo pasa a las fuentes productivas.

Se conserva el ahorro local y sigue pendiente reducir la espera del CDN,
medir la cancelación agrupada en uso real y conseguir un arranque frío menor
y más estable. Oficial conserva su estado experimental y Propio su respaldo.
Premium, anuncios reales y archivos completos no se repitieron en esta ronda;
no hay nuevas cifras de anuncios vistos, saltados, entregados o espera publicitaria.
No se publica OTA, instalador, versión o etiqueta. La evidencia bruta continúa
fuera de Git, bajo `capture-bench.local/`; el manifiesto final de esta ronda es
`round9-final-manifest.json.local`.

## Ronda 10: oportunidad adicional durante la espera del CDN

### Cambio conservado y coste

`114df0b` conserva los ocho turnos anteriores y añade uno a 1,5 s. Ese intento
adicional vence al llegar a 2 s, antes de despachar el turno antiguo. Todas las
comprobaciones son secuenciales. El primer formato admite nueve intentos y los
otros uno cada uno, sujetos a una **cuota global efectiva de diez**, que cuenta
también los abortados. Se conserva el plazo global de 8 s y los 2 s por intento
normal. No se modifican URL, calidad, identidad, audio original ni validación
estricta de 206, rango al 80 %, longitud, codificación y cuerpo completo de la sonda.
Un 429 observado sigue deteniendo la validación.

El intento extra puede añadir una petición cuando falle. Su cancelación puede
cerrar una conexión HTTP/1.1: preservar el horario de despacho no garantiza la
misma latencia de conexión. Las pruebas verifican cuotas compartidas, descarte
antes del siguiente turno, vencimiento sin consumir token, errores terminales
y cancelación. Los logs cuentan sondeos terminados; no inventarían un despacho
abortado sin registro ni todas las peticiones físicas con redirecciones.

### Dos experimentos, sin reemplazar intentos

Los 35 éxitos Native anteriores no incluían ninguno en el turno de 250 ms;
diecisiete sondas allí devolvieron 403. Eso justificó probar A, que trasladaba
ese turno a 1,5 s. Sus dos tandas no acreditaron mejora: `06823dc` quedó retirado
con `91c1d44`. Cinco éxitos en el nuevo turno tampoco demostraban adelanto:
los controles tenían menos rechazos iniciales y todos sus reintentos exitosos
terminaban ya alrededor de 1 s.

B conserva también los 250 ms. Cada experimento tuvo dos cohortes fijadas de
doce procesos: tres IDs, dos repeticiones por brazo, orden alternado, sin sesión
y FreshDecoder. Se preservan **48/48 Native, IDs correctos y cero Legacy** entre
los cuatro conjuntos. Todas las filas conservan el fallo histórico de 300 ms.

| Experimento / cohorte | Mediana control, ms | Mediana candidata, ms | Pares más lentos |
|---|---:|---:|---:|
| A / 1, retirado | 3877,55 | 4957,05 | 5/6 |
| A / 2, retirado | 4428,25 | 4330,05 | 5/6 |
| B / 1, conservado | 4361,90 | 4673,05 | 4/6 |
| B / 2, conservado | 4585,55 | 4786,10 | 4/6 |

Son tiempos desde búsqueda hasta `playing` de Audio silenciado, excluyendo el
arranque previo del proceso. No son medidas acústicas, treinta arranques fríos
habituales ni escucha hasta EOF. Las respuestas y edades de URL recibidas de
YouTube difieren entre procesos; la tabla **no acredita una mejora global**.

### Beneficio acotado observado en B

Cuatro intentos de B recibieron su primer 206 completo en el turno adicional,
tras los tres 403 anteriores. El margen se calcula como
`2000 - (startedMs + ms)`, en el mismo reloj del presupuesto CDN: indica cuánto
antes del siguiente turno antiguo había terminado la sonda. No es un ahorro
medido de primer sonido frente a otro proceso.

| Caso candidato B | Margen antes del turno antiguo, ms |
|---|---:|
| Cohorte 1, Epo, repetición 1 | 472,68 |
| Cohorte 1, Epo, repetición 2 | 469,13 |
| Cohorte 1, Maite, repetición 2 | 467,13 |
| Cohorte 2, Maite, repetición 1 | 475,29 |

La ventana desde el primer intento CDN hasta completar el primer 206 válido
también fue menor de media en ambas cohortes:

| Cohorte B | Media control, ms | Media candidata, ms |
|---|---:|---:|
| 1 | 1116,9 | 943,9 |
| 2 | 856,3 | 606,4 |

Son observaciones entre procesos con respuestas remotas distintas, no una
estimación causal ni un ahorro de CPU. El análisis independiente conserva las
24 filas y sus relojes en `r10b-independent-cdn-analysis.json.local`, SHA256
`480824c45556cb72bdbdc73211fb3c2e614c5c0507ec0867425f52b668edbb92`.

B se conserva por esa oportunidad útil repetida en ambas cohortes. Su agregado
de primer sonido fue 4413,75→4786,10 ms de mediana; mejoraron cuatro pares y
empeoraron ocho. Los sondeos terminados fueron 31→30 y los 403, 19→18, con cero
429; esas diferencias tampoco aíslan causalidad. No se observaron huecos de
ordinal compatibles con aborto del extra en estas muestras.

**Pupu, cohorte 2 candidata, 9356 ms, permanece íntegro.** La búsqueda tardó
5523,943 ms y la preparación 3509,094 ms; el primer sondeo CDN fue válido en
17,8935 ms. No hubo SABR ni turno extra. Dentro de la búsqueda, los timers de
configuración Music y API suman unos 478 ms; el resto no está descompuesto.
El fallback de búsqueda por baja confianza es una hipótesis pendiente, no una
causa probada. Este resultado no se atribuye a la espera adicional del CDN.

### Validación y evidencias

Pasan **247 Rust**, con 30 ignoradas, y los checks Android arm64/x86_64
con código 0, sin avisos nuevos. El primer build de pruebas de B falló por el
préstamo temporal de un array del test; se corrigió y se conserva su log. La
fuente final y su PE de pruebas están archivados en
`capture-bench.local/round10b.local/source-proof.json.local`. Los helpers tienen
48 pruebas Node y 31 comprobaciones PowerShell; no son pruebas adicionales del
producto. No se repiten JavaScript/tipos, 30 habituales o archivos completos
para este cambio localizado de Rust. No cambian bundles, receta, `capture.js`,
`youtubei.ts`, versiones ni API; requiere una app reconstruida.

Release B: commit `114df0b`, EXE
`9b0fc70dbe30b8f26dcaf351178ff16e1d362d8fc1057ef435ac26221c33811c`.
El control de ambos experimentos es R9 `cb592e2`, EXE `7e710907…`. A también
conserva su EXE `f86f6e84…`. Las cuatro auditorías verifican hashes de binarios,
configuraciones, políticas, planes, informes y logs, sin alterar los originales.
Los doce pares de B y el caso lento están en
`round10b-closed-audit-summary.json.local`, SHA256
`db540fbcde87d0b394fd44960bea0346fb22691ea5692a5dfeca714c9e2b032e`.
El cierre A es `round10a-closed-results.json.local`; el diagnóstico independiente
inicial es `r10-cdn-schedule-proposal.json.local`.

Continúan pendientes un primer sonido total menor y más estable, la explicación
de las búsquedas lentas y las campañas anteriores de Oficial. No se repiten
Premium, anuncios reales, EOF o rendimiento móvil; no hay nuevas cifras de
publicidad vista, omitida, entregada o esperada. La evidencia bruta sigue fuera
de Git. No se publica versión, etiqueta o extractor OTA; la rama se sube para
revisión. Manifiesto local de cierre: `round10-final-manifest.json.local`.
