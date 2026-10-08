# Captura oficial: diagnóstico de pausas y consentimiento

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
