# Arranque frío de Propio — 23 de octubre de 2026

**Mejora comprobada; 3,5 segundos totales y 300 ms siguen pendientes.** La segunda
ronda mide 4,499–5,504 s desde antes del IPC hasta `playing`, sin búsqueda, con un
vídeo por proceso frío. El usuario acepta cada mejora sustancial sobre la base;
no se presenta 1,25 s como requisito logrado. Continúa el
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
