# Arranque frío de Propio — 23 de octubre de 2026

**Mejora comprobada, objetivo de 300 ms pendiente.** Se reduce el coste de
preparar el decoder y se reutiliza después de reiniciar. Los tres casos
infantiles siguen arrancando por Native, pero esperar disponibilidad del audio
puede dominar el tiempo total. Continúa el [informe infantil](informe-contenido-infantil-2026-10-23.md), sin sustituir su historial.

## Cambios y límites

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
El bundle permanece idéntico: 297436 bytes, SHA-256 `6a18ed0ae8c909c36d5b96731fad6bb3fc9a5ea4088ed4865266f0f98c35f0e6`.

## App aislada: comparación consecutiva

Milisegundos de resolución directa, sin búsqueda. `FreshDecoder` omite sólo
lecturas de disco en el banco: conserva memoria, escrituras y todas las guardas.
No significa que cada fila analice un reproductor diferente desde cero.

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

## Procedencia y validación

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
