# Captura oficial: diagnóstico, continuidad y latencia

**Último estado: API4/captura v25, sin promoción.** La vuelta a caché parcial
mantiene 8 s de reproducción continua, con todas las unidades publicadas
comparadas. El control completo Preso→De Aquí cerró 9263/9263 paquetes, cero
discrepancias y cero cortes: siguiente en 4,6 ms, pero inicio frío en 6074 ms.
Propio resolvió las 30 búsquedas frías por Rust, sin respaldo, con mediana
548,9 ms; ninguna cumple 300 ms. El detalle de esta continuación está al final.
Los controles anteriores conservan sus versiones, fallos y alcance originales.

La captura API4/v20 cerró Airbag y PRESO completas, sin cortes y con16430/16430
paquetes coincidentes con el audio original obtenido sin sesión. El arranque de
Airbag tardó6008,3ms sin anuncio: **continúa fuera del objetivo de3s y no se aprueba
la promoción**. El disco de seis canciones ROSALÍA medido en v19 cerró también
sin cortes, con50343/50343 paquetes coincidentes y cambios de1,5–3,6ms.
Este informe continúa el [informe anterior](informe-captura-youtube-2026-10-07.md);
los fallos y las medidas con Premium de aquel informe se conservan.

## Causa observada y corrección

El reproductor de adquisición recibía llamadas de pausa del propio sitio cada
100 ms. El lector entregaba y añadía audio con regularidad; no tenía un backoff
creciente. Las trazas acotadas de llamadas enlazaron la pausa con el reproductor
de la página. En el JavaScript público de YouTube, el componente
`ytd-consent-bump-v2-lightbox` instala precisamente un intervalo de 100 ms para
mantener pausado el vídeo mientras presenta el consentimiento. El código público,
las observaciones de DOM y el control posterior al cierre apoyan esta causa.
No se atribuye el problema al silencio nativo de WebView2.

El adaptador ahora detecta ese diálogo en www/music.youtube.com y pulsa un único
«Rechazar todo»/«Reject all» visible y habilitado. El texto visible debe coincidir
exactamente; una etiqueta de accesibilidad descriptiva debe comenzar por una
palabra de rechazo. Se rechazan controles ambiguos, deshabilitados, ocultos o con
una etiqueta de aceptación. No se repite el clic sobre el mismo control mientras
el diálogo siga abierto. Si no se puede resolver en 10 s, se pide interacción.
Mientras esté visible no se fuerza play ni se acredita presentación de canción.
Después del cierre se exige una observación nueva y, si falta el arranque, se usa
la repetición desde cero ya existente.

En el control v19 se envió el clic a 2280,6 ms del reloj de la página; el diálogo
ya no estaba visible a 3295,4 ms. Después cesó la pausa periódica. El reloj de
contenido avanzó a 1,000005× entre posiciones 1,043 y 40,394 s. Sólo hubo tres
eventos nativos de pausa: consentimiento, repetición de arranque y final. El audio
de Musify terminó naturalmente a 40,701 s, con cobertura continua [0;40,701].

El clic de consentimiento usa el control DOM ordinario, cuyo efecto se observó
en esta prueba. No se presenta como clic confiable ni como prueba de preferencias
persistidas. La omisión de anuncios conserva su protocolo nativo CDP y sus
validaciones. Velocidad 1×, retención de 1,5 s, silencio nativo, límites de memoria,
identidad y certificado de EOF permanecen vigentes. Este adaptador sigue
dependiendo de un diálogo y textos ES/EN conocidos; otros diseños deben fallar
con diagnóstico en vez de aceptar consentimiento por aproximación.

La revisión añadió dos regresiones: el callback anterior a retirar una fuente
podía terminarla con el modal visible, y un modal menor de500ms podía unir sus
dos lados como si hubiese observación continua. Captura v20 bloquea también ese
callback e invalida explícitamente el intervalo suspendido. Conserva contradicciones
ad/unknown sin conceder cobertura. Sólo una fuente limpia, sin ninguna unidad
publicada, con elemento/época/buffer/tupla/inventario originales y datos nativos
válidos puede repetirse desde cero; se reutiliza el límite existente de una
repetición. Un prefijo publicado se conserva como parcial y se informa el fallo.
El consentimiento anterior al primer append no liga una tupla todavía inexistente.
El rechazo elegible se intenta al tick de25ms; el diagnóstico sigue limitado a500ms.
Ni esta optimización ni las pruebas de regresión acreditan por sí solas la meta de3s.

## Controles cerrados sin sesión

Una instancia por control, superficie www.youtube.com, retención experimental
de 1,5 s y auditoría de todas las unidades históricas publicadas. Los eventos de
reproducción y rangos se miden en la app con volumen cero; no son una prueba de
salida acústica por los altavoces. «0 anuncios entregados» es el contador observado;
la comparación contra el original aporta la comprobación independiente.

| Captura / informe local | Primer sonido ms | Cortes | Final natural / EOF y verificador completos | Paquetes coincidentes | Anuncios vistos / entregados | Diagnóstico |
|---|---:|---:|---|---:|---:|---|
| v13 `002553-a5cf2c90` | 6183,1 | 3 | Sí / sí | 2035/2035 | 0/0 | Pausas periódicas; reloj efectivo 0,938× |
| v14 `003718-778ea6b2` | 3774,5 | 0 | Sí / sí | 2035/2035 | 0/0 | Sigue la pausa periódica; instrumentación, sin corrección |
| v15 `004107-ee0dc3fb` | 4300,1 | 0 | Sí / sí | 2035/2035 | 0/0 | Sigue la pausa periódica; pila ampliada |
| v16 `004803-111ea48a` | 4177,2 | 6 | No / no | 4095/4095 | 3/0 | Plazo agotado, cambios de fuente y recuperaciones; coincidencia parcial no acredita EOF |
| v17 `005944-127cba4e` | Sin sonido | Sin entrega | No / no | Sin unidades | 0/0 | Rechazo no elegible; interacción y plazo agotado |
| v18 `010823-74ae3538` | Sin sonido | Sin entrega | No / no | Sin unidades | 0/0 | Un botón de rechazo válido, pero ARIA descriptiva descartada |
| v19 `011205-b4333095` | 5575,1 | 0 | Sí / sí | 2035/2035 | 0/0 | Cierre observado, reloj estable 1×; falla el tiempo de arranque |

Los 4095 paquetes del control v16 incluyen repeticiones de distintas épocas;
no equivalen a 4095 posiciones únicas ni a una canción completa. Sus anuncios
acumularon 101,228 s durante todo el intento, no en el arranque. En v19 la descarga
inicial de referencia falló, pero la comprobación final se recuperó y acreditó
446/446 unidades históricas, referencia completa y transporte sin cookies. Ese
fallo inicial queda registrado; no invalida por sí solo una referencia final
verificada ni elimina el fallo real de latencia.

## Disco seguido: seis canciones sin sesión

Una instancia con hasta tres captoras (actual y dos precargas), superficie WWW,
1×, retención experimental de1,5s y sin saltos durante la escucha. No hubo otros
bancos concurrentes. Se ejecutó una comprobación ligera del banco JavaScript
durante la segunda canción; no se compiló la app mientras se medía este disco.

| Canción | Inicio frío / transición ms | Final natural, EOF, cobertura y referencia completos | Paquetes coincidentes | Cortes / discrepancias | Fuentes publicitarias / entregadas | Espera publicitaria acumulada ms |
|---|---:|---|---:|---:|---:|---:|
| MALAMENTE | 6464,1 frío | Sí | 7502/7502 | 0/0 | 0/0 | 0 |
| QUE NO SALGA LA LUNA | 3,3 transición | Sí | 13478/13478 | 0/0 | 0/0 | 0 |
| PIENSO EN TU MIRÁ | 2,7 transición | Sí | 9689/9689 | 0/0 | 2/0 | 16230 |
| DE AQUÍ NO SALES | 3,6 transición | Sí | 7228/7228 | 0/0 | 1/0 | 10201 |
| RENIEGO | 1,5 transición | Sí | 10411/10411 | 0/0 | 1/0 | 5043 |
| PRESO | 3,1 transición | Sí | 2035/2035 | 0/0 | 1/0 | 9966 |

Las seis terminaron, con50343/50343 paquetes coincidentes y11302/11302 unidades
históricas comprobadas. Las cinco transiciones cumplen500ms. Las esperas de
anuncios sucedieron en las captoras de precarga y no se restan del tiempo de
transición. Los campos `startAdMs` de esas pistas siguen null; no se transforman
en una supuesta medida de arranque sin anuncios. El primer sonido de MALAMENTE
sin anuncio tardó6,464s y mantiene el fallo global de latencia. La referencia
inicial de MALAMENTE falló, pero el verificador final se recuperó y acreditó todo
lo publicado. Este resultado es seis canciones de la cohorte, no30 canciones
aprobadas ni una promoción del experimento.

Se observaron5 fuentes publicitarias y4 transiciones ad→content calificadas por
marcador propio a1×. Hubo4 clics nativos confiables, cada uno seguido de contenido
67/89/82/69ms después y antes del final nominal del anuncio: son4 omisiones
operativas correlacionadas, no prueba acústica de causalidad. La primera fuente
de PIENSO pasó ad→ad sin clic; no se deduce que fuera imposible de saltar. Su
desglose local distingue los dos anuncios y deja sin acreditar el reparto exacto
de los16230ms entre esas dos fuentes. La espera total observada fue41440ms,
consumida en precarga. `skippedAds`/`unskippableAdMs` originales permanecen null;
el contador derivado no reemplaza esos campos ni afirma espera mínima inevitable.

Informe `result-20261008-011527-c9b54a8a.json`, compilación
`434b656f64cc38fbec16eba2f3c0e2a70ab39f6c`, SHA256 del binario
`6514C99EB9B854F400ADD98137CC72C3E6BBBEF4369384BFA81D9AA77B0C87C6`.
SHA256 del informe
`fb42e8944fea110d888fddef2c6763cdf4c57a41860f89e7f4d596674daf2454`.
El resumen derivado permanece en `capture-bench.local/rosalia-v19-closed-summary.json`;
el informe original no se reescribe tras corregir el diagnóstico del banco.

## Control final v20: Airbag y Preso

| Canción | Inicio frío / siguiente ms | Anuncios vistos / entregados | Espera publicitaria acumulada ms | Paquetes coincidentes | EOF, cobertura, referencia y final natural | Cortes |
|---|---:|---:|---:|---:|---|---:|
| Airbag | 6008,3 frío | 0/0 | 0 | 14395/14395 | Sí | 0 |
| Preso | 6,6 siguiente | 1/0 | 5084 | 2035/2035 | Sí | 0 |

Fuente de Airbag estable a1,000001× tras el consentimiento; sin recuperación.
Preso necesitó una recuperación en precarga: una interrupción previa había usado
el único replay y la apertura posterior del modal impidió otro. La generación4
falló con0 unidades, conservando el diagnóstico; la generación7 independiente
cerró completa, a1,000008×, y estaba lista antes de acabar Airbag. No se amplió el
límite de replay ni se concedió continuidad al intervalo suspendido. Ambas filas
cerraron con3688/3688 unidades históricas y16430/16430 paquetes coincidentes,
0 discrepancias y0 cortes. El tiempo frío de Airbag sigue fallando.

El anuncio de la recuperación de Preso recibió1 clic nativo confiable, seguido
de contenido74ms después, a posición publicitaria5,069s frente a39,921s de
duración nominal. Es1 omisión operativa correlacionada. Sus5084ms se consumieron
en precarga y no se restan de la transición de6,6ms.

Informe `result-20261008-013534-51928ad5.json`, compilación
`74bcfa81a5c46b250a41321929af912b54bb7c91`; únicamente había documentación
modificada durante el build. SHA256 del binario
`3E505E28F2D822C0F6BBB003B87890D95746662785B5D9D9A90C359F5718BD6C`.
SHA256 del informe
`b9a550063ece21ab6189d8d97f545a31931497774648461ba577f31750963117`.
Derivado ignorado: `capture-bench.local/airbag-preso-v20-closed-summary.json`.

## Control Propio con búsqueda incluida

PRESO en `result-20261008-014148-33f7123c.json`, mismo binario v20: Rust resolvió
la URL nativa, fast1/fallback0, sin usar Oficial ni Legacy. Primer sonido736ms;
búsqueda413,423ms y extracción156,176ms. Final natural40,701s, cobertura[0;40,701],
0 cortes. Sigue fallando300ms; la búsqueda ya consume más que todo el presupuesto.
No se ejercitó el oráculo de paquetes en esta ruta, por lo que no se le atribuye
comparación de unidades. SHA256 del informe:
`0780394288f31dde3c96ee9585d2d0380c5022fe52d1569f1207ca5dd12c5e9e`.

## Cambiar a tres canciones sin caché de audio

Oficial v20, perfil desconectado y contexto preparado antes del cronómetro, con
el destino expulsado explícitamente. Los tres `destinationBeforeClick` eran null
y `destinationWasCached=false`; el tiempo incluye crear/presentar el destino.

| Destino | Cambio total ms | Anuncio observado ms | Residual ms | Paquetes históricos coincidentes | Diagnóstico |
|---|---:|---:|---:|---:|---|
| PRESO | 9537,4 | 5133 | 4404,4 | 25/25 | Supera3s más anuncio observado |
| QUE NO SALGA LA LUNA | 9442,6 | 5317 | 4125,6 | 29/29 | Supera3s más anuncio observado |
| MALAMENTE | 14215,4 | 10050 | 4165,4 | 70/70 | Supera3s más anuncio observado |

3 fuentes publicitarias,3 transiciones calificadas a1× y3 clics confiables,
seguidos de contenido118/96/70ms después y antes de su final nominal. Las
omisiones son correlaciones operativas; no se afirma que los20500ms observados
fuesen inevitables. Las32 unidades históricas incluyen10 de MALAMENTE usadas
antes como contexto; las22 unidades actuales de destino no sustituyen ese
inventario. Los124/124 paquetes coinciden,0 discrepancias y0 unidades con sesión
desconocida/autenticada. Sólo se verificaron prefijos: EOF e inventario de canción
completa no se ejercitaron y permanecen false.

Informe `result-20261008-014310-34ce0eec.json`, binario `74bcfa8`;
SHA256 `432f768665e920814d57dbe4e231e81b522367cbfed525805e6fafa401dc03de`.

## Salto al80% aún no capturado

PRESO, v20, `result-20261008-014634-7aafa8b1.json`: primer sonido6049,6ms,
0 anuncios; salto correcto a una zona no capturada en2088,5ms. Fallan los
objetivos de3s y1s. Las24 unidades históricas publicadas antes/después del salto
contienen100/100 paquetes coincidentes,0 discrepancias y sesión desconectada;
no se ejercitó EOF, referencia completa ni cobertura de la canción entera.
SHA256 del informe:
`47e04d7d95bfa7a8b2c08ea48606ffcf3ab622cb513110837cfed335325435c9`.
La retención de1,5s y la reserva de0,5s siguen intactas; no se reducen para hacer
pasar el cronómetro sin evidencia independiente que justifique otro margen.

## Referencia Premium anterior, separada

No se repitió Premium en esta continuación. Estas medidas proceden de las pocas
pruebas anteriores, con acceso manual del usuario y sin contribuir a aprobar:

| Perfil / prueba | Inicio frío ms | Siguiente ms | Seek80% ms | Anuncios vistos / entregados | Espera por anuncios |
|---|---:|---:|---:|---:|---:|
| Sin sesión, Airbag→Preso v20 actual | 6008,3 | 6,6 | No medido | 1/0 | 5084ms en precarga |
| Sin sesión, disco ROSALÍA v19 actual | 6464,1 | 1,5–3,6 | No medido | 5/0 | 41440ms acumulados en precarga |
| Propio/Rust sin sesión, Preso actual | 736 | No medido | No medido | Sin captura publicitaria | No aplicable |
| Sin sesión, Preso v20, control de seek | 6049,6 | No medido | 2088,5 | 0/0 | 0 |
| Premium anterior, Preso→Malamente completos | 5390,7 | 8,2 | No medido | 0/0 | 0 |
| Premium anterior, control corto de seek | 3897,1 | No medido | 2106,3 | 0/0 | 0 |

Las pruebas Premium pertenecen a otra compilación; no prueban el comportamiento
de v19/v20 ni sustituyen la comprobación sin sesión. Su procedencia y los cambios
fríos adicionales están en el [informe anterior](informe-captura-youtube-2026-10-07.md).

## Procedencia y privacidad

Rama `p1-oficial`; controles ejecutados desde copias inmutables del binario.
El control Preso v19 corresponde a `434b656f64cc38fbec16eba2f3c0e2a70ab39f6c`.
Informe v19 SHA256:
`36f11c270cc191049d27d5095fab358e47ec925394d8cc962af70476a0dcd1e0`.
Diario nativo SHA256:
`7a6930236cb71d34a816c0104e4952f6d42f4fe06efd63271d051051c8ba98ec`.

Los informes completos, diarios, referencias, scripts públicos y resumen de
controles están en carpetas `*.local` ignoradas por Git. Las trazas nuevas guardan
funciones filtradas, categorías, coordenadas de código y contadores; no guardan
URLs de la sesión, etiquetas de cuenta ni credenciales. La auditoría limita las
pilas a 20 muestras por documento y conserva receptor, argumentos, promesas y
excepciones originales; añade coste de observación y no es una medida acústica.
Los directorios nativos usan PID, fecha y secuencia exclusiva para evitar colisiones.

El script de reproductor público observado fue
[player_es6, revisión 5203c085](https://www.youtube.com/s/player/5203c085/player_es6.vflset/es_ES/base.js).
El componente de consentimiento se inspeccionó en una copia del JavaScript
público de la página, clave `ytmainappweb.kevlar_base.en_US.q4zxEzgOMq0.es5.O`,
SHA256 `83ccd912d477277c2a743d66b196e519318db1d90a486d196a8c64ad7d612350`.
Su URL completa no se conservó; no se atribuye ese componente al archivo player_es6.

## Commits de esta continuación

| Commit | Cambio |
|---|---|
| `a6b60f8` | Llamadas de reproducción y tiempos del lector en auditoría privada |
| `a83549f` | Cadena acotada de llamantes para diagnosticar las pausas |
| `9cabd04` | Origen filtrado de pilas y directorios de auditoría exclusivos |
| `897ef75` | Guardar la captura durante el consentimiento y resolver el rechazo |
| `a9dcdb0` | Controles Polymer y evidencia persistente del cierre |
| `434b656` | Admitir etiquetas accesibles descriptivas de rechazo |
| `3354669` | Acreditar una referencia final recuperada sin reescribir el intento inicial |
| `74bcfa8` | Invalidar intervalos de consentimiento y proteger también el EOF previo a detach |

Este informe y las actualizaciones de los dos planes se guardan en un commit
final de documentación; su identificador se entrega al usuario al cerrar el trabajo.

La captura subió de v13 a v20. API4 no cambia: los nuevos datos de diagnóstico
son opcionales y exclusivos del banco. Receta, youtubei.ts, db.rs, downloads.rs
y la interfaz visual no se modificaron. Propio conserva Rust y su respaldo Legacy;
yt-dlp sigue predeterminado. No hubo push, fusión ni publicación de extractores.

Comprobación de código:331/331 pruebas JavaScript,100 Rust aprobadas/13 ignoradas/0
fallos, tipos y Svelte sin errores ni avisos, build Windows correcto y
`git diff --check` limpio. Las pruebas ignoradas de red no se cuentan como aprobadas.

## Pendientes para promover

Las seis canciones de ROSALÍA y Airbag cerraron sin cortes:7 canciones distintas;
PRESO aparece repetida en los controles. Faltan una nueva cohorte completa de
las30 canciones sin cortes, el arranque ≤3s, el seek ≤1s,
las metas de búsqueda fría y la cota independiente del retraso del marcador para
fijar N. Las 50 transiciones publicitarias de la campaña anterior no se borran,
pero tampoco sustituyen esa cota. Premium no se ha utilizado en esta continuación;
las pocas medidas anteriores están separadas en el informe del 7–8 de octubre.
El modo normal continúa reteniendo la fuente completa y la nueva captura no
sustituye todavía el respaldo de Propio.

## Continuación de latencia: API4/v21

Se reutilizan sólo proyecciones aritméticas del inventario, ligadas a versión,
configuración, época y objetos nativos. Identidad, reloj, retención, cobertura y
EOF siguen comprobándose cada vez. La auditoría privada observa el reloj real
después del play() nativo y en el evento play. No inventa cero ni concede
presentación a la llamada; el analizador mantiene sus puertas independientes.

El cierre revoca la sesión y confirma la auditoría y la destrucción, sin esperar
300 ms fijos. Un fallo conserva la plaza. El lector exige 0,5 s continuos en ledger
y MSE antes de adoptar un salto; sólo EOF validado permite una cola corta. Conserva
buffers y reloj mientras espera. Un salto preparado invalida replies antiguos
sólo en el lector: no cancela ni replanifica trabajo nativo ya enviado.

### Escucha completa sin sesión

`result-20261008-090356-02582bed.json`: una instancia, WWW, 1×, N=1,5 s,
máximo tres ventanas y 96/288 MiB por pista/total. No se compiló ni se ejecutaron
otros bancos durante la escucha. Ambas terminaron sin cortes observados, pero
**sólo Preso tiene comparación independiente completa**.

| Canción | Inicio frío / siguiente ms | Final natural / EOF / MSE continuo | Comparación independiente | Anuncios vistos / entregados | Espera publicitaria ms |
|---|---:|---|---|---:|---:|
| Preso | 5535,3 frío | Sí, 0–40,701 s | 2035/2035 paquetes; 448 unidades; 0 discrepancias | 0/0 | 0 |
| De Aquí No Sales | 2,1 siguiente | Sí, 0–144,561 s | No acreditada: falta referencia compatible sin sesión | 1/0 | 5238 en precarga |

De Aquí conserva sus 20 verificaciones fallidas, incluida la final. Sus 1620
unidades y 7228 frames locales no sustituyen la referencia. La causa nativa
específica no quedó registrada; no se atribuye a bloqueo o cambio de YouTube
por conjetura. La cohorte falla por inicio superior a 3 s y referencia ausente.

Un clic nativo confiable a posición publicitaria 5,210631 s, frente a 29,941 s
nominales, precedió una nueva fuente de contenido 96 ms después. Es una omisión
temprana correlacionada. Sus 5238 ms sucedieron en precarga y no se descuentan de
la transición de 2,1 ms. La espera inevitable no quedó determinada.

Las ventanas se crearon en 350,644/124,237 ms hasta devolver Navigate, sin medir
carga de página. Sus retiros confirmados tardaron 30,308/31,041 ms: finalización
15,101/15,511 y cierre 15,207/15,530 ms. Ambas auditorías terminaron sin pérdidas
ni errores. Dos controles no atribuyen todo el cambio de arranque a esta mejora.

### Salto sin sesión

`result-20261008-090902-0090d305.json`: inicio de Preso en 5643 ms; salto correcto
al 80 % aún no capturado en 2374,7 ms, fuera de la meta de 1 s. Sus 27 unidades
históricas contienen 111/111 paquetes coincidentes, sin discrepancias y con
transporte/captura anónimos. Es una prueba de prefijos: no acredita EOF ni canción
completa. Al adoptar 32,5608 s, MSE ya cubría hasta 33,101 s: 540,2 ms por delante,
frente a 0,2 ms en v20. El waiting del destino dura 0,6 ms hasta seeked/playing,
frente a 233,2 ms antes. Se conservan los dos waiting del ensayo: el origen se
agota mientras se prepara el destino y el seek nativo emite otro. No se afirma
cero cortes. N=1,5 s sigue imponiendo un mínimo incompatible con 1 s para bytes
todavía no presentados.

### Medición independiente del marcador

`preso-disputa-v21-independent-delay.json` acredita ahora todos los 2035 paquetes
presentados de Preso, incluido el primero. Esa fuente no tuvo anuncios. Las
fuentes de De Aquí carecen de referencia compatible en este proceso; además,
su canción mantiene un primer paquete sin presentación observada en la auditoría.
Los seis episodios observados de señal no son seis anuncios únicos. Hay **cero
transiciones con retraso independiente medido**; el máximo sigue null. N no
cambia ni se promueve el experimento por esta medición.

### Comprobación y pendientes

343/343 pruebas JavaScript, 100 Rust aprobadas y 13 ignoradas, Svelte/TypeScript
sin errores ni avisos y build Windows correcto. Compilación limpia de
`308be5760ab5bd0a96de143d71dd9b09b5a8c197`, binario SHA256
`c0239dc2e497a63edd7b64acad32e80eb8b2d72c51e9dd4f05ba76fa93d3a7a9`.
El segundo control sólo tenía documentación modificada y usó el mismo binario.

| Artefacto local | SHA256 |
|---|---|
| Escucha `090356-02582bed` | `4590c724a41ca47333ea361040e747c9c190a38d9759c66949ddc1f27ea5854d` |
| Salto `090902-0090d305` | `3caa531e230a2edd5dcba91f03c9a4b7a666a395a54d62a82c683490345b0bab` |
| Análisis independiente v21 | `07e1302552bdfa22ac175be320a651bae9904d309076f21da4e0169aee606db1` |

Commits: `62726d5` (proyecciones y reloj de auditoría), `6a608bb` (cierre) y
`308be57` (reserva al adoptar seeks). Captura v21, API4 sin cambio. Receta,
youtubei, db.rs, downloads.rs y la interfaz visual no cambiaron. No hubo Premium,
push, fusión ni publicación; las referencias Premium anteriores siguen separadas.

Siguen pendientes las metas frías, la cota independiente del marcador y una
cohorte nueva de 30 canciones completamente verificadas. También la continuidad
del origen durante un seek temprano y la replanificación del productor al volver
a caché parcial después de enviar otro salto: ignorar el reply local impide mover
otra vez el reloj, pero el prefijo puede agotarse mientras el motor va al destino
previo. Estos límites no mezclan identidad ni acreditan huecos; impiden dar por
acabado el objetivo.

## Continuación de seguridad y continuidad: API4/v22–v25

Trabajo aislado en `p1-oficial`, sin modificar la carpeta compartida de `main`.
Todas las tandas nuevas se midieron sin sesión. La nueva captura oficial usó
WWW, 1×, N=1,5 s, reserva continua de 0,5 s, dos precargas y límites de
96 MiB por pista/288 MiB total. No hubo otros bancos, builds ni tests concurrentes
durante las mediciones de latencia.
La primera señal de sonido se mide por el evento del reproductor de Musify;
el avance de reloj se comprueba aparte, sin presentarlo como medición acústica.

### Cambios y límites

- El supervisor admite intenciones de salto con identificadores crecientes y
  vuelve a comprobar propiedad, generación, revisión y cancelación al completar
  operaciones asíncronas. Volver a caché parcial replanifica el productor al
  borde útil del origen; las respuestas del destino abandonado no mueven el reloj.
- El núcleo conserva continuaciones exactas del append original, incluso cuando
  su último cluster está pendiente. La nueva vista experimental WebM mantiene
  paquetes originales de varios runs, admite relleno fuera de orden y elimina
  sólo duplicados idénticos en bytes, configuración y metadatos. No altera los
  bytes anteriores ni los índices ya publicados; tampoco concede presentación
  previa a paquetes nuevos que llegan tarde. Una contradicción bloquea entrega.
- Esa vista es **parcial**: no puede emitir EOF, certificado ni liberar los
  últimos N segundos, ni siquiera mediante una llamada directa al sellado.
  Completar una captura que la haya usado requiere una recaptura limpia; todavía
  falta resolver ese cierre y recuperación sin interrumpir la escucha.
- El presupuesto cuenta los bytes originales y las copias retenidas del parser.
  No equivale a medir todo el heap JavaScript ni los picos transitorios de parseo.
- La referencia independiente realiza como máximo dos intentos por cliente;
  el segundo intento solicita un visitante anónimo fresco. Los diagnósticos
  contienen categorías acotadas, sin URLs firmadas ni datos de cuenta.
- Rust valida la estructura decodificada del visitante en lugar de exigir `Cgt`:
  tokens válidos pueden empezar por `Cgs`. Se probó con los 64 caracteres
  iniciales posibles del identificador decodificado. No se atribuye a este bug
  el fallo histórico de De Aquí,
  cuya causa específica no quedó registrada. La receta no cambió.

### Vuelta a caché: intentos conservados

El banco llena 3 s del origen, envía un salto al 80 % y vuelve a 0,1 s después
de observar que el motor recibió el primer salto. Exige 8 s posteriores de reloj
en reproducción, crecimiento del ledger/MSE y rechazo de la respuesta antigua.
El alcance es siempre **prefijos sin EOF**, también cuando el subtest pasa.

| Versión / informe local | Inicio frío ms | Adopción local / reloj retomado ms | Resultado de continuidad | Paquetes comparados / discrepancias |
|---|---:|---:|---|---:|
| v22 `100630-52c7c77d` | 5696,8 | 0,5 / 91,4 | Fallo: prefijo agotado a 3,080 s; deadline 30 s | 157 / 0 |
| v23 `101900-4864e748` | 5122,5 | 0,6 / 95,9 | Fallo: ordinal reiniciado mientras el cluster seguía pendiente; corte a 3,920 s | 595 / 0 |
| v24 `103439-3095cde1` | 5811,9 | 0,6 / 86,4 | Fallo: relleno 20–30 s tras 30–40 s, con repetición de bloques; timeline ambiguo | 202 / 0 |
| v25 `111240-90adaff4` | — | — | Fallo de arranque: consentimiento visible interrumpió presentación; 0 unidades entregadas | 0 / no ejercitado |
| v25 `111353-71a63979` | 5715,9 | 0,6 / 90,7 | Pasa vuelta: 8,002 s continuos; respuesta antigua rechazada, productor replanificado | 528 / 0 |

El éxito v25 compara las 121 unidades históricas publicadas, con transporte y
captura anónimos. MSE crece de 0–3,081 a 0–9,421 s durante el criterio, y el
ledger final llega a 10,481 s. No hay esperas de escucha; se conserva el waiting
durante el seek de 0,8 ms, seguido por playing a 1,4 ms. Los 90,7 ms exigen además
seek terminado y avance de reloj superior a 40 ms. La fila global sigue fallando
por el inicio frío. La vista derivada sí ingirió el mismo relleno 20–30 s y
los 500 bloques repetidos del fallo v24, pero la escucha quedó antes de 20 s:
no demuestra reproducción de esos paquetes nuevos ni cierre completo.
La recuperación del intento v24 vio un anuncio y esperó
19,633 s, sin clic nativo y sin publicidad entregada según el contador local;
no se convierte en aprobación de una transición independiente.

### Escucha completa y publicidad sin sesión

| Control / canción | Inicio frío / siguiente ms | EOF, referencia y MSE completos | Paquetes / unidades | Cortes | Fuentes publicitarias / entregadas; espera ms |
|---|---:|---|---:|---:|---|
| v24 `104241-ffa95d55` / Preso | 5809,5 frío | Sí, 0–40,701 s | 2035 / 446 | 0 | 0 / 0; 0 |
| v24 `104241-ffa95d55` / De Aquí | 3,1 siguiente | Sí, 0–144,561 s | 7228 / 1634 | 0 | 2 / 0; 11019 en precarga |
| v25 `112042-76cc0021` / Preso | 6074 frío | Sí, 0–40,701 s | 2035 / 452 | 0 | 0 / 0; 0 |
| v25 `112042-76cc0021` / De Aquí | 4,6 siguiente | Sí, 0–144,561 s | 7228 / 1628 | 0 | 0 / 0; 0 |

Cada tanda contiene 9263 paquetes y 2080 unidades, sin discrepancias, conservando
todas las unidades históricas. En v25 los 25 controles del oráculo, incluidos
ambos finales, mantienen `allPublishedUnits=true`; captura y referencia finales
acreditan anonimato. Ambas tandas fallan únicamente el tiempo del primer sonido
en sus filas; dos canciones repetidas no constituyen la cohorte de 30 distintas.

En v24 hay dos identidades de fuente publicitaria pero **una** transición
publicitaria acreditada, con marcador y tasa 1×. Un request y dispatch nativo
produjeron un clic confiable a posición 5,039168 s de 109,261 s nominales; el
contenido apareció 46 ms después. Cuenta como una omisión temprana correlacionada,
no como dos anuncios saltados. Las 39 observaciones de tasa no tienen violaciones.
Los 11019 ms de publicidad ocurrieron en precarga y no se restan del cambio
de 3,1 ms. La parte inevitable del anuncio permanece sin determinar.
En v25 no hubo anuncios ni clics: esa tanda no valida su comportamiento.

`preso-disputa-v24-independent-delay.json` acredita los 2035 paquetes presentados
de Preso, incluido el primero, pero esa fuente no tuvo publicidad. Los cuatro
runs de De Aquí siguen sin medida: tres carecen de anclas de payload canónico y
uno tiene inventario coincidente pero presentación incompleta del primer paquete.
Ocho episodios de señal no son ocho anuncios únicos. Hay cero transiciones con
retraso independiente medido; el máximo es null. **N permanece en 1,5 s** y la
entrega progresiva sigue exclusivamente experimental.

### Propio: camino principal conservado

El control completo v24 `104744-6cde322c` terminó ambas canciones naturalmente,
con cobertura del consumidor y cero cortes. Preso resolvió por Rust en 697,9 ms
con búsqueda incluida (búsqueda 411,0; resolución 125,6); falla 300 ms. De Aquí
usó **Legacy** y cambió en 254,1 ms: falla 100 ms. Para Legacy, publicidad,
tasa, EOF y comparación API4 no están acreditados; `complete=false` se conserva.
Los dos fallos rápidos del contador son intentos, no dos canciones fallidas.

Tras la corrección del visitante, v25 `111625-e0978fa6` resolvió las **30/30**
búsquedas frías de `real_albums` por Rust: vídeo esperado en todas, ningún
respaldo Legacy ni nueva captura oficial. Mínimo 435,7 ms, mediana 548,9 ms,
máximo 1318,4 ms; 29/30 por debajo de 1 s, **0/30 dentro de 300 ms**.
Un 403 de validación CDN se recuperó dentro del nivel rápido. No se atribuye
causalmente la mediana al cambio de parser a partir de una sola tanda.
Son arranques con búsqueda y caché reseteadas, no 30 canciones escuchadas hasta
EOF ni comparación independiente de canciones completas. La telemetría
publicitaria de captura no aplica a esta ruta directa.

| Canción | Primer sonido con búsqueda ms | Ruta / criterio |
|---|---:|---|
| Radiohead — Airbag | 1318,4 | Rust; falla ≤300 ms |
| Radiohead — Paranoid Android | 539,0 | Rust; falla ≤300 ms |
| Radiohead — Subterranean Homesick Alien | 626,6 | Rust; falla ≤300 ms |
| Radiohead — Exit Music (For A Film) | 641,9 | Rust; falla ≤300 ms |
| Radiohead — Let Down | 553,2 | Rust; falla ≤300 ms |
| Radiohead — Karma Police | 564,1 | Rust; falla ≤300 ms |
| Berri Txarrak — Dardararen Bat | 643,5 | Rust; falla ≤300 ms |
| Berri Txarrak — Zuri | 496,0 | Rust; falla ≤300 ms |
| Berri Txarrak — Infrasoinuak | 507,4 | Rust; falla ≤300 ms |
| Berri Txarrak — Spoiler! | 602,9 | Rust; falla ≤300 ms |
| Berri Txarrak — Zaldi Zauritua | 498,0 | Rust; falla ≤300 ms |
| Berri Txarrak — Beude | 523,4 | Rust; falla ≤300 ms |
| Extremoduro — Buscando una luna | 485,3 | Rust; falla ≤300 ms |
| Extremoduro — Prometeo | 463,9 | Rust; falla ≤300 ms |
| Extremoduro — Sucede | 435,7 | Rust; falla ≤300 ms |
| Extremoduro — So payaso | 462,4 | Rust; falla ≤300 ms |
| Extremoduro — El día de la bestia | 663,2 | Rust; falla ≤300 ms |
| Extremoduro — Tomás | 573,6 | Rust; falla ≤300 ms |
| ROSALÍA — MALAMENTE Cap.1: Augurio | 473,4 | Rust; falla ≤300 ms |
| ROSALÍA — QUE NO SALGA LA LUNA Cap.2: Boda | 544,6 | Rust; falla ≤300 ms |
| ROSALÍA — PIENSO EN TU MIRÁ Cap.3: Celos | 472,1 | Rust; falla ≤300 ms |
| ROSALÍA — DE AQUÍ NO SALES Cap.4: Disputa | 559,0 | Rust; falla ≤300 ms |
| ROSALÍA — RENIEGO Cap.5: Lamento | 605,2 | Rust; falla ≤300 ms |
| ROSALÍA — PRESO Cap.6: Clausura | 447,8 | Rust; falla ≤300 ms |
| The Beatles — Come Together (Remastered 2009) | 456,1 | Rust; falla ≤300 ms |
| The Beatles — Something (Remastered 2009) | 516,5 | Rust; falla ≤300 ms |
| The Beatles — Maxwell's Silver Hammer (Remastered 2009) | 667,1 | Rust; falla ≤300 ms |
| The Beatles — Oh! Darling (Remastered 2009) | 571,7 | Rust; falla ≤300 ms |
| The Beatles — Octopus's Garden (Remastered 2009) | 615,6 | Rust; falla ≤300 ms |
| The Beatles — I Want You (She's So Heavy) (Remastered 2009) | 581,8 | Rust; falla ≤300 ms |

### Salto aún no capturado

v25 `111503-760b5a46`: Preso inicia en 5559,4 ms; destino al 80 % adoptado
correctamente en **2461,7 ms**, fuera de la meta de 1 s. El destino MSE contiene
560,2 ms continuos por delante. Se comparan 28 unidades y 117/117 paquetes,
cero discrepancias y captura/referencia anónimas: prefijos, sin EOF.
El origen 0–0,521 s se agota antes de que llegue el destino: waiting a
6060,5 ms y playing a 7976,6 ms, **1916,1 ms de corte real**. Se conserva también
el waiting de seek de 0,4 ms. `gaps=[]` no acredita cero cortes en este ensayo.
Falta conservar producción suficiente del origen mientras se prepara el salto.

### Premium: referencia histórica separada

No se accedió a la cuenta ni al perfil Premium en esta continuación. Las pocas
medidas anteriores se conservan en el [informe inicial](informe-captura-youtube-2026-10-07.md)
y no aprueban ninguna meta sin sesión ni describen v25.

| Prueba Premium histórica | Primer sonido ms | Siguiente / salto ms | Anuncios vistos / saltados / entregados; espera | Alcance |
|---|---:|---:|---|---|
| Preso→Malamente | 5390,7 | 8,2 siguiente | 0 / 0 / 0; 0 ms | 2 completas, 2035+7502 paquetes, 0 discrepancias y cortes |
| Seek no preparado | 3897,1 | 2106,3 salto | 0 / 0 / 0; 0 ms | Sólo 104 paquetes de prefijos; no EOF |

### Comprobación, commits y pendientes

374/374 pruebas JavaScript, 109 Rust aprobadas/13 ignoradas/0 fallos,
Svelte/TypeScript con cero errores y avisos, build Windows correcto. Las pruebas
ignoradas no cuentan como aprobadas. El test de reserva ahora espera la nueva
lectura pendiente en lugar de resolver por error la anterior después de un
sleep fijo; los criterios y las comprobaciones negativas no se relajaron.
Build v25 de código limpio `a397744186324513d647181c65842598d6c5b1d4`, binario SHA256
`597c5a9b9bfc73b5346b781672e1399701a49687fdd09b44ac6a1a079c0740ce`.
El último control sólo tenía documentación modificada y usó ese mismo binario.

| Informe local | SHA256 |
|---|---|
| v22 vuelta `100630-52c7c77d` | `283d61872b39407af1c56fa46c1ef0281111c1172f196909875df07b0c0b22e7` |
| v23 vuelta `101900-4864e748` | `415752090c5f2d728bd827808a6dd32f04bc59d619fd815b2ca79f5d9e29d422` |
| v24 vuelta `103439-3095cde1` | `093cd903d3e1276f7cbd4dfa1040a285046fb48b0380f74ca09a0a3ef7115c4b` |
| v24 completas `104241-ffa95d55` | `d6c69540207de301333f38ef613834c99f346d38ab174823004bbe60e5cdbf41` |
| v24 Propio `104744-6cde322c` | `7821db6d39727c8788f410ec78218682756b10d6768817ea968344e593ec39fd` |
| v24 demora independiente | `b98f99e56062b80ab390953ac1302bb9e0d2f0dd8b92ec58d5aac8ae53212c8b` |
| v25 arranque `111240-90adaff4` | `05439ad6198c3194bd53bce3d4203f1853b94a132d4a2ee83cb7548d4d789a45` |
| v25 vuelta `111353-71a63979` | `86d3b13e40ebd9441b4bc03489ef86fdf1e749b9c70a28cdd5d237ae132a8c64` |
| v25 salto `111503-760b5a46` | `aa145f1682603be03fbccd788964bbdba5a87f0db1cdd9e5b1735b94b26e6983` |
| v25 Rust30 `111625-e0978fa6` | `68f711c47af40f99f55b9421f29c2571d95365a454b6bc628ee8969a05a13c56` |
| v25 completas `112042-76cc0021` | `aa5ae2b11e37b03d81aedfc3fef540575f447c45f3f05a7db6864ecc40d4a338` |

Commits locales de código y tests: `ffccb5e` (referencias y diagnóstico),
`5a176a8` (auditoría de readiness), `c0642be` (intenciones y replanificación),
`578936d` (banco de vuelta), `9fb6754` (continuación exacta), `9e11a4f`
(cluster pendiente), `3b91a1b` (diagnóstico rápido), `cdc61a3` (visitante),
`3b87cdb` (inventario WebM parcial) y `a397744` (test de reserva).
El commit final de documentación se identifica al entregar el resultado.
Captura subió a v25; API4, receta v1 y youtubei v1 se conservan. Se modificaron
el lector y su supervisor internos para coordinar saltos; no db.rs, downloads.rs
ni la interfaz visual. Raw, audio, logs y perfiles siguen en carpetas `.local`
ignoradas. No hubo push, fusión ni publicación.

Quedan el inicio frío Rust ≤300 ms/oficial ≤3 s, el salto no preparado ≤1 s sin
agotar el origen, el cierre verificable de la vista parcial y la recuperación
sin cortes. N=1,5 s impone más de 1 s para audio aún no presentado: reducirlo exige
la cota independiente del marcador que todavía falta. También una nueva cohorte
conjunta de 30 canciones completas y 50 transiciones reales con publicidad, sin
discrepancias, cortes ni fallos de tiempo. Las campañas anteriores no sustituyen
esa aprobación. yt-dlp continúa predeterminado; Propio conserva Rust→Legacy y
la entrega progresiva nueva continúa siendo sólo el experimento del banco.
