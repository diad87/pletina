# Extractores y captura oficial: resultados del 7–8 de octubre de 2026

El modo progresivo sigue **experimental y no aprobado**. El extractor Propio resolvió las 30 búsquedas frías por la vía nativa, sin fallback, pero no alcanzó el objetivo de 300 ms. La captura Oficial mostró transiciones preparadas muy rápidas; la batería completa también registró arranques lentos, cortes y cuatro plazos agotados. Estos fallos quedan conservados: no se convierten en aprobaciones porque una captura posterior complete los bytes.

Todas las tandas que se relacionan abajo han cerrado. Los cinco álbumes Oficiales se ejecutaron a la vez en cinco instancias aisladas, cada una con hasta tres captoras: es una prueba de estrés, no una medida de uso normal con tres ventanas. El modo medido fue progresivo con retención de 1,5 s; la cuarentena de fuente completa del modo normal es otra política y no hereda estos resultados. Las campañas posteriores de anuncios, saltos y cambio frío son mediciones distintas y no sustituyen la escucha completa.

| Medida cerrada | Resultado | Alcance |
|---|---|---|
| Propio: 30 búsquedas frías | 30 vía nativa; 0 fallback; 444,8–1.649,2 ms, mediana 697,85 ms | Inicio de HTMLAudio; no verifica escucha completa ni EOF |
| Propio: escucha completa de cinco discos | 29 resoluciones rápidas y 1 respaldo Legacy; 30 finales naturales, 0 esperas durante escucha | Airbag necesitó Legacy porque no se obtuvo sesión de visitante; no tiene oráculo independiente de publicidad |
| Propio: siguientes naturales | 25/25, 3,7–13,2 ms, mediana 6,1 ms | Cumple el criterio de ≤100 ms; no demuestra 30 resoluciones rápidas |
| Oficial: cinco primeros arranques | 20.605,3–37.841,5 ms totales; 10.294,7–17.586,5 ms tras restar publicidad inicial observada | Los cinco tuvieron publicidad; no son arranques reales sin anuncio |
| Oficial: siguientes naturales | 21/25 tiempos válidos, 1,6–8,6 ms | Cuatro medidas quedan invalidadas tras fallos de la pista anterior |
| Oficial: fin y cobertura | 26/30 `ended`; 27/30 `native.complete`; 26/30 cobertura MSE declarada; 27/30 `referenceComplete`; 26/30 `verifier.complete` | Son criterios distintos |
| Oráculo de los 30 Oficiales | 394.825/394.826 paquetes coincidentes, 1 discrepancia | Incluye publicaciones repetidas durante recuperaciones; no es un total de paquetes canónicos únicos |
| Continuidad bajo estrés | 25 episodios `waiting` en seis pistas; cuatro plazos agotados | No se atribuye causalidad a CPU, red o disco sin medición suficiente |
| Publicidad en esos30 Oficiales | 47 fuentes observadas, 29 transiciones con marcador acreditadas, 9 clics confiables, 0 unidades declaradas como anuncio entregadas | Sus campos históricos no acreditan cuánto acortó cada clic; no sustituye la campaña específica de50 |
| Oficial: campaña publicitaria sin sesión | 50 transiciones acreditadas en 55 intentos; 13 clics nativos confiables, 12 seguidos por transición antes del final conocido | 0 discrepancias en todas las unidades entregadas; no ejercitó EOF de 30 canciones |
| Oficial: salto al 80 % no capturado | 30/30 destinos correctos; 2.003,2–2.270,1 ms, mediana 2.067,7 ms | 0/30 cumple ≤1 s; 0 discrepancias en todas las unidades entregadas |

La búsqueda ocupa gran parte del coste de Propio: mediana 388,184 ms (28/30 búsquedas superaron por sí solas 300 ms); resolución nativa, 167,596 ms; llamada player, 103,938 ms; validación CDN conservada, 57,221 ms; `play()`→`playing`, 41,5 ms. Son medianas de fases, no sumandos de una ejecución representativa. El visitante ya caliente cuesta una mediana de 0,018 ms; volver a optimizar esa fase no explica el resto.

La tabla conserva la medida nativa fría de cada canción y su ejecución Oficial. **E** = HTMLAudio `ended`; **N** = captura nativa completa; **C** = cobertura MSE comprobada por el lector; **R** = inventario presentable de referencia completo; **V** = aprobación final del oráculo. S/N/? significan sí/no/no acreditado. «Ad inicial» usa `startAdMs` en el primer arranque, nunca el `adMs` acumulado de las recuperaciones. Los guiones de las pistas siguientes no afirman ausencia de publicidad durante su precarga. «Ads fuentes/entregadas» cuenta identidades de fuente observadas y unidades declaradas como anuncio entregadas, sin sumarlas de nuevo en cada snapshot.

| Disco / pista | ID | Propio frio, ms | Oficial frio / next, ms | Ad inicial, ms | E / N / C / R / V | Paquetes iguales / comparados | Mismatch | Esperas | Ads fuentes/entregadas | Incidencia |
|---|---|---:|---:|---:|---|---:|---:|---:|---:|---|
| Beatles: Come Together (Remastered 2009) | `oolpPmuK2I8` | 745.6 | 33044.5 frio | 19731 | N / N / ? / N / N | 19081/19081 | 0 | 8 | 2/0 | arranque >3s tras ad; sin ended; esperas registradas |
| Beatles: Something (Remastered 2009) | `VWO3nEuWo4k` | 573.5 | INVALIDO | - | S / S / S / S / S | 9115/9115 | 0 | 0 | 1/0 | transicion invalidada |
| Beatles: Maxwell's Silver Hammer (Remastered 2009) | `mJag19WoAe0` | 808.0 | 6.4 next | - | N / S / ? / S / S | 29224/29224 | 0 | 1 | 3/0 | sin ended; esperas registradas |
| Beatles: Oh! Darling (Remastered 2009) | `9BznFjbcBVs` | 1199.7 | INVALIDO | - | S / S / S / S / S | 10363/10363 | 0 | 0 | 1/0 | transicion invalidada |
| Beatles: Octopus's Garden (Remastered 2009) | `BynfJeqdwQU` | 1056.5 | 2.9 next | - | S / S / S / S / S | 8541/8541 | 0 | 0 | 1/0 | - |
| Beatles: I Want You (She's So Heavy) (Remastered 2009) | `tAe2Q_LhY8g` | 636.5 | 1.6 next | - | S / S / S / S / S | 23367/23367 | 0 | 0 | 1/0 | - |
| Berri Txarrak: Dardararen Bat | `F2Pt8-m_1U8` | 959.0 | 37841.5 frio | 20255 | S / S / S / S / S | 10649/10649 | 0 | 4 | 1/0 | arranque >3s tras ad; esperas registradas |
| Berri Txarrak: Zuri | `gVUgA4_b5p0` | 856.7 | 8.6 next | - | S / S / S / S / S | 11174/11174 | 0 | 0 | 2/0 | - |
| Berri Txarrak: Infrasoinuak | `f80n7fX8eRI` | 715.8 | 2.8 next | - | S / S / S / S / S | 11608/11608 | 0 | 0 | 1/0 | - |
| Berri Txarrak: Spoiler! | `D1_Tn-qfVP0` | 1649.2 | 4.4 next | - | S / S / S / S / S | 10853/10853 | 0 | 0 | 2/0 | - |
| Berri Txarrak: Zaldi Zauritua | `h06uM_MSFQc` | 608.6 | 3.2 next | - | S / S / S / S / S | 8620/8620 | 0 | 0 | 2/0 | - |
| Berri Txarrak: Beude | `Iz9xXxadIwE` | 725.3 | 7.8 next | - | S / S / S / S / S | 8992/8992 | 0 | 0 | 1/0 | - |
| Rosalia: MALAMENTE Cap.1: Augurio | `mw2XM-PSqXY` | 529.4 | 20605.3 frio | 8581 | S / S / S / S / S | 7502/7502 | 0 | 0 | 2/0 | arranque >3s tras ad |
| Rosalia: QUE NO SALGA LA LUNA Cap.2: Boda | `nlEPSY6qA28` | 672.7 | 3.9 next | - | S / S / S / S / S | 13478/13478 | 0 | 0 | 2/0 | - |
| Rosalia: PIENSO EN TU MIRÁ Cap.3: Celos | `isfVUG54CLc` | 777.0 | 4.9 next | - | S / S / S / S / S | 9689/9689 | 0 | 0 | 2/0 | - |
| Rosalia: DE AQUÍ NO SALES Cap.4: Disputa | `vk4dTui5EQo` | 673.0 | 2.6 next | - | S / S / S / S / S | 7228/7228 | 0 | 0 | 2/0 | - |
| Rosalia: RENIEGO Cap.5: Lamento | `G0rPjW6xXFA` | 947.2 | 2.0 next | - | S / S / S / S / S | 10411/10411 | 0 | 0 | 2/0 | - |
| Rosalia: PRESO Cap.6: Clausura | `ngBCsDOTNOM` | 498.0 | 5.6 next | - | S / S / S / S / S | 2035/2035 | 0 | 0 | 1/0 | - |
| Extremoduro: Buscando una luna | `q9IjQAef8VI` | 532.3 | 27893.7 frio | 17599 | N / N / ? / N / N | 16872/16872 | 0 | 1 | 2/0 | arranque >3s tras ad; sin ended; esperas registradas |
| Extremoduro: Prometeo | `__KB0cUvYeE` | 488.1 | INVALIDO | - | N / N / ? / S / N | 36905/36905 | 0 | 1 | 5/0 | transicion invalidada; sin ended; esperas registradas |
| Extremoduro: Sucede | `nV-F1WSpJIA` | 474.5 | INVALIDO | - | S / S / S / N / N | 8068/8069 | 1 | 0 | 1/0 | transicion invalidada; tail AAC: ver diagnostico |
| Extremoduro: So payaso | `K81nvSfmc4I` | 559.7 | 2.2 next | - | S / S / S / S / S | 14084/14084 | 0 | 0 | 1/0 | - |
| Extremoduro: El día de la bestia | `nHj3OuvqMaw` | 919.1 | 6.7 next | - | S / S / S / S / S | 14221/14221 | 0 | 0 | 1/0 | - |
| Extremoduro: Tomás | `cBZXB0jIHr8` | 444.8 | 2.7 next | - | S / S / S / S / S | 4369/4369 | 0 | 0 | 1/0 | - |
| Radiohead: Airbag | `jNY_wLukVW0` | 1045.3 | 36995.5 frio | 19591 | S / S / S / S / S | 14395/14395 | 0 | 10 | 1/0 | arranque >3s tras ad; esperas registradas |
| Radiohead: Paranoid Android | `DExBeFCx3mQ` | 915.3 | 4.4 next | - | S / S / S / S / S | 19199/19199 | 0 | 0 | 1/0 | - |
| Radiohead: Subterranean Homesick Alien | `_fTWmUlTEqE` | 679.9 | 6.2 next | - | S / S / S / S / S | 13385/13385 | 0 | 0 | 2/0 | - |
| Radiohead: Exit Music (For A Film) | `Bf01riuiJWA` | 952.8 | 7.9 next | - | S / S / S / S / S | 13360/13360 | 0 | 0 | 1/0 | - |
| Radiohead: Let Down | `ZVgHPSyEIqk` | 596.0 | 3.5 next | - | S / S / S / S / S | 14965/14965 | 0 | 0 | 1/0 | - |
| Radiohead: Karma Police | `nbCOAPR33ME` | 602.4 | 5.8 next | - | S / S / S / S / S | 13072/13072 | 0 | 0 | 1/0 | - |

Los valores negativos de `firstSoundMs` en Something, Oh! Darling, Prometeo y Sucede no son latencias negativas: se rechazan como transiciones naturales inválidas. Maxwell's Silver Hammer tenía inventario independiente y captura nativa completos, pero el consumidor no produjo `ended` dentro del plazo. Prometeo tenía referencia cubierta, pero no final nativo acreditado. Come Together y Buscando una luna quedaron con referencias incompletas. Las25 canciones con ended y oráculo completos son la intersección de esos dos contadores de26; al exigir además tiempos y continuidad, sólo20 filas carecen de fallos en esta batería. No equivale a30 canciones aprobadas.

En estos dos últimos casos, las fuentes habían recibido `endOfStream` y tenían sus bytes, pero su reloj no había terminado: el canal dejó de emitir observaciones; el supervisor abrió otra generación desde cero y el plazo global venció durante esa segunda presentación. Los últimos relojes de la primera generación fueron 166,439/259,961 s y 197,974/251,733 s. No hay evidencia de que esos dos fallos fueran un recorte del último paquete.

La revisión encontró escrituras de journal y auditoría síncronas en el camino de mensajes WebView2 y relecturas periódicas del inventario por el verificador. Pueden añadir carga en la prueba de cinco instancias; no se ha demostrado que causen los cortes. Además, estos journals completos son instrumentación del banco. Antes de atribuir una causa conviene medir duración de callbacks/escrituras y eventos de fallo o bloqueo del renderer.

**Sucede: discrepancia histórica localizada, todavía conservada.** El único mismatch es el último AAC, paquete publicado 8.068 / referencia 8.069 (la referencia incluye priming). Son los mismos 349 bytes y el mismo hash `080367662c4a77ee524a210ba8306fdc1610ae74eb61b5afb195586ea97a6a6c`. La referencia declara PTS 8.261.056/44.100 y duración 344/44.100; la fuente y unidad publicada declaran PTS 8.262.656/44.100 y duración 1.024/44.100. El offset fijo −1.600/44.100 alinea exactamente sus inicios; `appendWindowEnd=187,33333333333337` termina exactamente tras las 344 muestras de referencia. No se encontró un payload distinto ni evidencia que permita etiquetarlo automáticamente como publicidad.

Se corrigió el comparador para reconocer exclusivamente ese recorte final declarado, manteniendo hash, tamaño, configuración y origen fijo; el inventario independiente limita su frame AAC final por su propia duración demux. Las 15 pruebas Rust dirigidas pasan, incluida una reproducción FFmpeg y negativos de ±1 muestra, ventana infinita, bytes/configuración distintos y cola ausente. El conjunto final tiene93 pruebas Rust y308 JavaScript aprobadas.

**Repetición cerrada de Sucede:** `result-20261007-234121-d63c608d.json`, binario limpio `3bb3e3af9e0f6868552eb5a884fa793631f97de8`, anónimo, superficie auto/Music, progresivo y retención 1,5 s. El resultado es 8.069/8.069 paquetes iguales, 0 mismatch, `complete/referenceComplete/allPublishedUnits/captureAnonymous=true`, final natural y cobertura MSE comprobados, 0 episodios waiting. Arranque 17.700,9 ms; publicidad inicial observada 11.894 ms; residual 5.806,9 ms, todavía por encima de 3 s. La repetición confirma la corrección del comparador, pero no sustituye el fallo histórico v11 ni aprueba la velocidad o el límite semántico de publicidad.

La comprobación independiente compara todos los paquetes publicados contra una referencia obtenida sin cookies, con configuración, reloj fijo e inventario presentable; el fallback PCM sólo acredita coincidencia exacta cuando puede establecer ese origen. `playing`, `ended`, avance del reloj y cobertura MSE describen el reproductor HTMLAudio, habitualmente silenciado en el banco: no prueban salida audible por los altavoces ni por sí solos identidad semántica o ausencia de publicidad.

**Publicidad y retención de 1,5 s.** Cero unidades etiquetadas como anuncio es un contador del clasificador, no una prueba independiente de ausencia semántica. La auditoría offline de Rosalía reconoce 50.343 paquetes exactos en sus seis canciones, pero no acredita los primeros 20 ms de presentación de cada fuente: el reloj pasa de `readyState=1` en cero a reproducción ya avanzada. No concede anclas ni una medida del retraso de señal; los 23 runs quedan sin medición y el retraso sigue `null`. El ensayo del marcador tardío también demuestra el límite: una señal que llega después de la retención puede dejar salir audio antes de ser clasificado. No se promueve el experimento a modo normal.

Controles cerrados posteriores, separados del estrés:

| Control | Arranque / transición | Fin / oráculo | Observación |
|---|---|---|---|
| Premium, Preso (`231721-cce37617`) | 5.390,7 ms; ad inicial 0 | 2.035/2.035, 0 mismatch, captura/referencia/oráculo completos | 0 esperas; supera 3 s; sesión identificada, no elegible para aprobación sin Premium |
| Premium, Malamente (mismo run) | next 8,2 ms | 7.502/7.502, 0 mismatch, completos | 0 esperas; control separado |
| Premium, salto al 80 % de Preso (`235829-809b58ea`) | inicio 3.897,1 ms; seek 2.106,3 ms; ad 0 | 104/104 paquetes publicados iguales | Destino no capturado; seek correcto, supera 1 s; no ejercita EOF |
| Premium, cambios fríos (`235902-21a1d710`) | Preso 4.392,2 ms; Malamente 4.134,5 ms; ad 0 | 27/27 y 70/70 paquetes publicados iguales | Desde otra pista realmente reproduciéndose; destinos sin caché; ambos superan 3 s; sólo prefijos |
| WWW anónimo, Preso (`231452-ad0ae8e8`) | 5.737,4 ms; ad inicial 0 | 2.035/2.035, 0 mismatch, completos, cobertura MSE sí | 0 esperas en escucha normal; 1 durante tail/seek del smoke; no acredita ended natural de la canción completa |
| Silencio nativo, Preso anónimo (`235150-c2359726`) | 4.223,3 ms; ad inicial 0 | 2.035/2.035, 0 mismatch, EOF, referencia, consumidor y cobertura completos | 5 cortes durante escucha normal; falla latencia y continuidad |

El último control confirma `ICoreWebView2_8.IsMuted=true` en la captora **antes de navegar**. Rust impone y lee de vuelta `SetIsMuted(true)` en Oficial, Legacy y el perfil manual; si la interfaz nativa o la confirmación fallan, no navega. El acceso manual nace oculto en `about:blank` y sólo se muestra tras confirmar; al reutilizarlo se vuelve a comprobar. Esto silencia la salida de esa ventana sin detener el reloj del reproductor. No modifica el audio principal de Musify ni el mezclador del sistema. La prueba verificó los bytes y el avance del reproductor; no convierte sus cinco cortes en éxito ni constituye una medida acústica de altavoces. La API nativa está documentada por [Microsoft](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2_8?view=webview2-1.0.3967.48).

Historial de fallos que se conserva:

| Run | Binario | Resultado histórico |
|---|---|---|
| `213401` | `0b2118e` / v7 | Registro inconcluso anterior a la cobertura independiente completa; no aprobación retrospectiva |
| `220141` | `e28f485` | Preso completo, pero 13 peticiones de skip nativo y 0 despachos por validación CDP; arranque 25.633,3 ms |
| `222302` | `8b1704b` | Preso completo; arranque 11.468 ms |
| Premium Music `222539` | `8b1704b` | Registro inconcluso tras incompatibilidad de tupla MSE al anticipar la siguiente pista; no se acredita EOF |
| WWW `223931-3daf7325` | `5e85caa` / v10 | 0 unidades; intervalo inicial no observado 0→1,120104 s |
| WWW `224901-cb1c7492` | `da94976` / v11 | Inicio rechazado por intervalo de observación de 545 ms; no primer sonido ni EOF |
| WWW `230351-5d03dafe` | `dde2149` / v12 | Replay reanudado antes de observar cero estable; comienzo no observado en 0,008785 s |

Campañas anónimas cerradas posteriores al estrés:

| Tanda | Resultado y criterio |
|---|---|
| Latency 30 `231748-ffca02ae` | 30 destinos al 80 % no capturados, correctos; 2.003,2 / 2.067,7 / 2.270,1 ms mínimo/mediana/máximo; 0/30 ≤1 s. Arranque 9.268–25.436,9 ms; residual 3.939,9–5.514,9 ms tras restar publicidad inicial de 5.199–20.521 ms. 3.510/3.510 paquetes, 853 unidades, 0 discrepancias; todo el historial publicado anónimo. Los waiting durante seek quedan separados de escucha normal; no ejercita EOF. |
| Anuncios `231543-6c47466a` | Se alcanzaron 50 transiciones distintas con marcador explícito, fuente/generación/época y observación previa a 1×, en 55 intentos de un máximo de 100. Se vieron 71 identidades de fuente publicitaria, no 71 comerciales únicos. 13 solicitudes/despachos/clics confiables; 12 transiciones ligadas ocurrieron ≤1 s después del clic y antes del final conocido, con ≥1 s restante; un clic queda sin efecto confirmado. Espera observada 5.035 / 19.746 / 20.520 ms mínimo/mediana/máximo. Arranque total 8.902,2–25.911 ms; residual 3.634,2–6.014 ms, mediana 4.214,3; 0/55 ≤3 s. 7.026/7.026 paquetes, 1.675 unidades, 0 discrepancias y toda publicación anónima. |
| Cambio frío 30 `232646-5cd3a121` | 30 destinos sin caché, desde otro tema realmente reproduciéndose y sin cola para precargar el destino. Total 9.344,9 / 21.674,4 / 24.974,2 ms mínimo/mediana/máximo; residual 4.102,6 / 4.512,9 / 4.971,5 ms al restar publicidad. 0/30 ≤3 s; 30/30 cumple el umbral anterior de 5 s más publicidad. Los 30 tuvieron publicidad observada: espera 5.093 / 17.338 / 20.517 ms. 40 fuentes, 28 transiciones acreditadas, 11 clics confiables y 10 transiciones ligadas antes del final conocido. 872/872 paquetes, 225 unidades, 0 discrepancias, todas las publicaciones anónimas. Sólo prefijos; no EOF. |
| Propio, cinco discos `232343 / 232511 / 232521 / 232531 / 232541` | 30 finales naturales; 0 waiting durante escucha y 0 huecos internos observados. 29 resoluciones rápidas y 1 respaldo Legacy (Airbag: «YouTube no dio sesión de visitante»). Los 25 siguientes positivos tardaron 3,7 / 6,1 / 13,2 ms mínimo/mediana/máximo. Primeras pistas: Radiohead 3.790,3; Berri 716,7; Extremoduro 777; Rosalía 661; Beatles 879,3 ms. Los cinco fallan ≤300 ms; esta tanda concurrente no sustituye las 30 búsquedas frías secuenciales. |
| Repetición Sucede `234121-d63c608d` | 8.069/8.069, 0 discrepancias, final/cobertura/verificación completos, 0 waiting; residual 5.806,9 ms; la discrepancia histórica se conserva. |

En anuncios, latencia y cambio frío hubo **0 violaciones observadas de velocidad publicitaria** y **0 unidades declaradas como anuncio entregadas**. La comprobación independiente de todas las unidades publicadas dio 0 discrepancias. Sólo los 50 de la campaña dedicada cumplen por sí solos el umbral de transiciones reales; los intentos de prefijos no acreditan treinta canciones completas. Las 12 omisiones de esa campaña son correlaciones operativas con el clic y el final conocido, no prueba acústica independiente de causalidad. No encontrar un botón no demuestra que el anuncio fuera imposible de saltar; restar la espera observada no demuestra su duración mínima inevitable.

Dos resultados nativos de la escucha completa, Buscando una luna y Sucede, declararon `coverageOk=false`: el único rango era respectivamente `[-0,013061;251,733333]` y `[-0,013061;187,333333]`, con ended y duración exactamente en el extremo final. Ambos contienen [0,duración] sin hueco interno. El comparador exigía inicio exactamente cero y confundía priming AAC negativo con audio ausente. Se corrigió sólo el diagnóstico de URL directa y se probó contra ambos casos y contra inicio/final realmente ausentes y huecos. El comparador de captura Oficial conserva sus extremos estrictos. Los raws antiguos y sus flags no se reescriben.

El banco también había etiquetado Airbag como `nativeDirect=true` al no recibir progreso API4. Su `selectedSource.kind=capture-legacy` y el contador de motor prueban que fue Legacy. El diagnóstico nuevo toma el tipo real de fuente, conserva el final/cobertura del consumidor y deja explícitamente sin acreditar EOF, publicidad y velocidad del productor Legacy mediante la auditoría API4. Esta escucha confirma funcionamiento del respaldo histórico; no le atribuye el oráculo de la captura nueva.

Procedencia: los 30 Oficiales proceden de `result-20261007-225308-{24cb92fb,512ecec1,812bb2c0,82d59c5a,842f436e}.json`, binario `da94976fbc4ec2243cf31f62cad049e7a9787a83`, API4, v11, perfil anónimo, superficie auto/Music, modo progresivo y retención 1,5 s; los cinco metadata declaran árbol limpio. Native30 usa `result-20261007-222456.json`, binario `8b1704b5ce5d0b04d797965c884c6fb22a5e5ee0`, también limpio. Premium2 y guard WWW usan `883be4fcf6831280cae257e0f0d3db7cf9515f18`, limpio. Estos IDs remiten a raws locales ignorados; no se incluyen perfiles, cookies, URLs firmadas ni audio.

Los runs de anuncios, seek y los dos controles Premium completos usan el binario limpio `883be4f` / API4 / v13. Switch30 y los cinco discos Propio usan `e537097` / v13. Sucede usa `3bb3e3a`. Silencio nativo y los controles Premium cortos de seek/switch usan `aace31c`; estos últimos ejecutaron su copia inmutable mediante NoBuild, aunque el HEAD ya incluyera el diagnóstico del banco. El control final `result-20261008-000120-44431111.json` recompiló `0e878cd`, con sólo documentación modificada: Preso se resolvió rápido, empezó en707,2ms, terminó naturalmente, tuvo cobertura completa y0 esperas; `nativeDirect=true`, `legacyCapture=false`, fast1/fallback0. No cumple300ms. Cada metadata conserva el SHA del ejecutable y la procedencia de su compilación; no se atribuye una prueba al último commit sólo por cercanía temporal.

Verificación de código final: **308/308 pruebas JavaScript**, **93 Rust aprobadas,13 ignoradas y0 fallos**, `npm run check` sin errores ni avisos, build de app Windows correcto y `git diff --check` limpio. Las pruebas Rust ignoradas de red no cuentan como aprobadas; las tandas WebView2 anteriores son las medidas reales. El build avisa del tamaño del bundle youtubei existente. Ninguna de estas comprobaciones sustituye los criterios fallidos de rendimiento, continuidad o evidencia publicitaria.

Se modificaron internamente el lector MSE y el reproductor para entregar tramos y conservar dos Audio preparados; no se cambiaron controles visuales, `db.rs` ni `downloads.rs`. yt-dlp sigue predeterminado y Propio recomendado, con respaldo histórico. La captura progresiva sólo se habilita mediante el banco experimental; el modo normal Oficial conserva la fuente entera en cuarentena. Los límites configurables96MB por pista/288MB total acotan audio almacenado, no la memoria completa de WebView2. `capture.js` quedó versionado como13 y el protocolo como API4 en manifest y host; receta/youtubei conservan versión1. El cambio de `scripts/extractors.mjs` sólo incluye el módulo de auditoría al empaquetar: no se ejecutó publicación, push ni merge.

Los raws y hashes quedan en `capture-bench.local/` y `capture-evidence.local/`, ignorados por Git; en docs sólo se conserva este resumen y los resúmenes históricos. Los2MB antiguos salieron del árbol actual con verificación de sus32 hashes; sus blobs permanecen en commits anteriores porque no se reescribió la historia. El usuario introdujo Premium manualmente en un perfil separado. No se guardan en Git credenciales, cookies, tokens, perfiles ni datos de cuenta. Sólo las observaciones públicas de sesión desconectada cuentan para aprobación.

**Trabajo pendiente para aprobar:**

- Reducir la búsqueda/arranque frío de Propio a300ms; sus siguientes ya cumplen100ms.
- Medir de forma independiente el inicio del audio publicitario y su retraso máximo hasta el marcador. Actualmente N=1,5s no tiene una cota demostrada. El caso controlado de marcador1,7s tardío entregó180ms de anuncio sintético; no se oculta por las50 transiciones reales sin discrepancia.
- Corregir el ritmo de entrega y los cortes, instrumentando callbacks, journals y renderer para separar causas; lograr30 canciones completas verificadas sin fallos en una sesión normal y conservar también la prueba de estrés.
- Reducir arranque/cambio frío a3s y seek no capturado a1s. Con1,5s retenidos y0,5s de reserva, el seek observado de unos2s muestra un coste estructural: no se rebaja el margen sin evidencia de seguridad.
- Recuperar huecos con más eficacia tras pérdida de observación/latido; las recuperaciones conservan el prefijo publicado, pero los plazos agotados prueban que no evitan todos los cortes.
- Mantener captura nueva a1×. Los ensayos controlados de2×/4×/16× aceleraron intervalos publicitarios antes de la señal, incluso cuando playbackRate ya indicaba1. No se repite ese riesgo con publicidad real. Los resultados históricos de unos12× no autorizan acelerarla.
- Promover la captura progresiva y reemplazar Legacy sólo cuando supere el umbral completo; estas tandas **no lo aprueban**. Premium continúa siendo referencia y no aporta a la cohorte anónima.

Commits de la evolución API4 y esta validación, todos en `p1-oficial`:

| Commit | Cambio |
|---|---|
| `8b2f68d` | API4, clic nativo, dos precargas, límites y auditoría |
| `0b2118e` | Evidencias en carpeta local ignorada y criterios sin sesión |
| `e28f485` | Referencia completa, rangos HTTP verificados y cierre del probe |
| `8b1704b` | Solicitudes CDP válidas y reserva de reproducción |
| `5e85caa` | Superficie WWW alternativa y límite de recuperaciones repetidas |
| `da94976` | Transiciones con marcador ligado e inventario temporal |
| `dde2149` | Replay inicial sin reutilizar cobertura |
| `883be4f` | Pausa hasta observar el seek nativo asentado en cero |
| `8eb715e` | Inventario exacto separado de presentación inicial no observada |
| `e537097` | Eliminación de estado redundante de peticiones |
| `3bb3e3a` | Recorte final AAC exacto en muestras y pruebas FFmpeg |
| `aace31c` | Silencio nativo obligatorio antes de navegar |
| `0e878cd` | Diagnóstico correcto de Legacy y priming AAC directo |

La captura API2 se rescató inicialmente en el worktree independiente con `f4868be`, sin cambiar la rama de la carpeta compartida. La historia anterior a API4 también queda conservada:

| Commit | Cambio anterior |
|---|---|
| `f4868be` | Snapshot API2 con verificación completa y banco real |
| `85cb60b` | API3 y aislamiento del experimento tras publicidad tardía |
| `3b17b7d` | Banco y procedencia de medidas |
| `ea3153b` | Continuidad Opus de fuentes completas |
| `a3e6b24` | Reproducción preparada antes de promoción nativa |
| `14bc9d9` | Cambios fríos y tandas interrumpidas |
| `a68c411` | Evidencia reproducible y fallos iniciales |
| `c603f8f` | EOF equivalente por redondeo con último paquete conservado |
| `1f2e7ec` | Separación de anuncios, finales y cobertura |
| `42cb6de` | Fallos reales Opus/AAC con procedencia |
| `029d0cf` | Reloj terminal AAC sin retener último paquete |
| `4fd3003` | Precarga tras admisión y telemetría de skip |
| `74f06eb` | Informe de30 canciones y límites del experimento |

Este informe y los dos planes se guardan en un commit final de documentación. No hay publicación, fusión ni push a main.
