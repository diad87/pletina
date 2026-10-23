# Arranque frío de Propio — 23 de octubre de 2026

**Ronda 4: POST anticipado verificado, sin mejora uniforme del total ni solución universal de SABR.**
El usuario acepta unos **600 ms como base provisional del camino habitual**;
la última tanda tiene mediana 642 ms, no una cota de 600 ms por canción.
El candidato inició los seis controles infantiles directos, pero una recuperación
tardó 9,813 s y una búsqueda posterior necesitó Legacy. El arranque infantil de
3,5 s y la fiabilidad de la ruta nativa ante SABR siguen pendientes.
Se conserva el historial de cada ronda; no se presenta 1,25 s como requisito logrado. Continúa el
[informe infantil](informe-contenido-infantil-2026-10-23.md), sin sustituir su historial.

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
