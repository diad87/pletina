# Captura oficial de YouTube: informe del 7 de octubre de 2026

**Decisión: no aprobar la entrega progresiva para uso normal ni sustituir Propio.**
Hay mejoras medibles de arranque, salto y transición, pero no está demostrada la exclusión de anuncios.
Además, 28 de las 30 últimas escuchas naturales no acreditan un inventario global completo, aunque todas llegaron al final y tuvieron cobertura MSE.

## Estado y aislamiento

El trabajo está en la rama `p1-oficial`, dentro de `C:\Users\iunan\musify-oficial`.
La carpeta original se mantuvo en `main`; sólo los archivos de esta captura se trasladaron mediante un stash selectivo al worktree. Esta evolución no se ha fusionado, enviado ni publicado.
Los ensayos usan `dev.musify.captureofficialtest`, con base de datos y perfil WebView2 separados de los del usuario.
`db.rs` y `downloads.rs` no tienen diferencias respecto del snapshot `f4868be`.

| Ruta | Estado efectivo |
| --- | --- |
| yt-dlp | Sigue siendo el motor predeterminado y el utilizado para las descargas. |
| Propio | Sigue recomendado: extracción rápida en Rust y respaldo histórico `capture_legacy`, separado de la captura nueva. |
| youtubei.js | Sin cambios en esta fase; tampoco cambia la receta del motor nativo. |
| Oficial normal | Retiene la fuente hasta EOF y la validación de su historia completa. Tiene el coste de esperar la canción. |
| Oficial progresivo | Sólo en el banco, con `MUSIFY_BENCH` y `MUSIFY_BENCH_PROGRESSIVE=1`. No aprobado. |

El baseline de las últimas tandas es `029d0cf`, protocolo API 3 y captura v5.
API 3 añade unidades de audio con tiempos absolutos, inventario por rangos, saltos por épocas y recuperación que conserva buffers válidos.
Dos sesiones atienden la canción actual y la siguiente; la precarga prepara también su Audio y MediaSource.
Desde `a3e6b24`, el Audio preparado puede empezar mientras termina la promoción nativa, con guardas contra respuestas obsoletas.
La UI sólo añade, desde `f4868be`, la recomendación de Propio, el texto de cuarentena y avisos de recuperación/promoción; los botones de interacción ya estaban en aquel snapshot.

## Por qué sigue sin aprobarse

Un contraejemplo controlado fija el comienzo real de un anuncio en **1,000 s**.
El anuncio reutiliza la fuente y el sitio sigue identificándola como contenido hasta **1,120 s**.
A velocidad 1×, el experimento entrega **100 ms de anuncio** antes de detectar el cambio.
La cuarentena completa retiene los bytes y rechaza esa fuente; no entrega ese fragmento.
No hay un plazo documentado para la señal del sitio que permita resolverlo añadiendo un retardo fijo.

`adsDelivered=0` sólo indica que no se entregaron unidades **ya etiquetadas** como anuncio.
Una unidad publicitaria mal clasificada como contenido no incrementa ese contador.
EOF y una cronología completa tampoco autentican, por sí solos, la identidad del audio remoto.
El contraejemplo, sus muestras y los límites del ensayo de velocidad se conservan en [la interpretación de seguridad](evidence/capture-2026-10-07/interpretacion.md).

## Método y lectura de las cifras

El corpus fija 30 IDs en [real-albums.capture.json](../tests/fixtures/real-albums.capture.json), seis canciones de cada uno de cinco discos.
La selección procede de la app; para extraer el audio se usa el reproductor oficial, no un cliente API propio.
Se conservan los informes originales, sus fallos, los motivos de interrupción y los metadatos de commit y SHA256 del binario.
Los [resultados por canción e historial](evidence/capture-2026-10-07/results.md) permiten revisar las filas; el [manifiesto](evidence/capture-2026-10-07/raw/manifest.json) identifica las fuentes.

- «Inicio» significa evento `playing` del HTMLAudioElement local, con volumen cero. No es una grabación acústica.
- «Tras restar publicidad observada» usa `startAdMs` hasta ese primer evento. Todos los casos de latencia y cambio en frío tuvieron publicidad observada; no son ensayos sin anuncios.
- Una transición natural mide `ended` de la anterior → `playing` de la siguiente con el mismo reloj del navegador. No se le resta la publicidad de la precarga.
- `ended`, cobertura MSE, inventario completo y `waiting` son comprobaciones distintas. El último checkpoint `live` puede preceder al evento final.
- `adsSeen` cuenta identidades de fuente por generación y época, no campañas únicas. Se suma una única instantánea final por vídeo y vida de caché, sin duplicar alias ni copias de progreso.
- Cero `waiting` dentro de una pista no acredita cero discontinuidades PCM ni cero espera entre canciones.

## Latencia y cambio en frío

Las cifras siguientes mantienen el alcance de cada banco. Un `ok` de medida no convierte la aceptación global en verdadera.

| Medida | Muestra y versiones | Resultado | Rango observado |
| --- | --- | --- | --- |
| Inicio tras restar publicidad observada | 26 filas de `083544`/`85cb60b` y cuatro reintentos de `121124`/`029d0cf` | 30/30 ≤3 s | 1,9711–2,8709 s |
| Salto al 80 %, fuera del rango capturado | Las mismas 30 filas | 30/30 ≤3 s | 0,4861–0,7073 s |
| Inicio total, incluidos anuncios | Las mismas 30 filas | Tiempo bruto; se informa aparte del criterio anuncio +3 s | 12,1166–77,3029 s |
| Cambio a destino frío, restando publicidad observada | `115924`/`029d0cf`, 30 destinos únicos | 30/30 ≤5 s | 2,0249–3,9799 s |
| Cambio a destino frío total | La misma tanda | Tiempo bruto; se informa aparte del criterio anuncio +5 s | 17,1131–38,2344 s |

El cambio frío más lento fue Paranoid Android, con **3,9799 s** descontando publicidad, dentro del umbral solicitado de 5 s.
Cada destino se expulsó de la caché antes del clic y se comprobó vacío; otra canción estaba sonando como contexto.
La tanda de latencia termina después de comprobar el salto: no prueba el final completo de las 30 canciones.
La selección última de latencia suma **47** identidades publicitarias observadas; los cambios fríos suman **35**. Ambas registran **0 entregas etiquetadas**.
No se presentan esas sumas como anuncios únicos entre tandas ni como garantía semántica.

## Escucha natural de los cinco discos, anterior al último par

Este agregado de referencia reúne tres binarios: Radiohead de `092755`/`a3e6b24`, Berri Txarrak de `101042`/`c603f8f` y los otros tres discos de `105216`/`029d0cf`. Es anterior al ensayo dirigido `122056`, detallado más abajo.
No es una tanda única ni una validación de los 30 temas con el último código.
Los intentos anteriores fallidos siguen en el historial; no se convierten en éxitos al seleccionar una repetición posterior.

| Disco | Commit | `ended` | Cobertura MSE | Inventario completo | Transiciones ≤500 ms | Máxima transición | Fuentes publicitarias observadas / entregadas etiquetadas |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Radiohead — OK Computer | `a3e6b24` | 6/6 | 6/6 | 0/6 | 5/5 | 4,4 ms | 17 / 0 |
| Berri Txarrak — Infrasoinuak | `c603f8f` | 6/6 | 6/6 | 0/6 | 5/5 | 6,9 ms | 13 / 0 |
| Extremoduro — Agila | `029d0cf` | 6/6 | 6/6 | 2/6 | 5/5 | 10,8 ms | 15 / 0 |
| ROSALÍA — El Mal Querer | `029d0cf` | 6/6 | 6/6 | 0/6 | 3/5 | 57.168,6 ms | 19 / 0 |
| The Beatles — Abbey Road | `029d0cf` | 6/6 | 6/6 | 0/6 | 5/5 | 4,0 ms | 13 / 0 |
| **Total** | Tres versiones | **30/30** | **30/30** | **2/30** | **23/25** | **57.168,6 ms** | **77 / 0** |

Sólo Buscando una luna y Sucede acreditan `complete=true`; las otras **28 filas conservan el fallo de inventario global**.
El experimento conserva el hueco cuantizado de 1 ms como hueco del inventario, aunque MSE reproduzca de forma continua.
La certificación normal de una fuente completa corrige ese caso dentro de una unidad verificada; no se ha ampliado la tolerancia del inventario experimental.

Hay **0 episodios `waiting` después del primer `playing` de cada pista**, pero **7 eventos brutos de espera de arranque**: cinco arranques de disco y las dos transiciones largas.
Los cinco arranques de disco, tras restar publicidad observada, fueron 2.092,4; 2.219,1; 2.124,0; 2.528,6 y 2.268,9 ms. Sus tiempos totales fueron 17,21–52,50 s.
No puede resumirse esta escucha como «30 canciones sin cortes» ni como «30 completas».

Los dos fallos de transición de Rosalía fueron:

- MALAMENTE duró 150,041 s y esperó 49.976 ms de publicidad al arrancar. QUE NO SALGA LA LUNA acumuló 199.123 ms de publicidad al prepararse y empezó **50.919,5 ms después** del final anterior.
- DE AQUÍ NO SALES duró 144,561 s. RENIEGO acumuló 199.189 ms de publicidad y empezó **57.168,6 ms después** del final anterior.

El baseline sólo iniciaba la precarga después del primer `playing`, perdiendo la espera inicial disponible.
No sabemos si aquellos anuncios eran omitibles: v5 no recogía evidencia suficiente del botón ni de los intentos de omisión.

## Fallos históricos y correcciones

| Ensayo | Fallo conservado y evolución |
| --- | --- |
| API 2, `220255` / `221856` | Airbag pasó; AAC agotó la espera durante un anuncio. El siguiente intento AAC falló por interpretar la duración de su cabecera MP4 como duración total. |
| API 2, `222415` / `222951` | Tras conservar los ajustes originales de SourceBuffer, AAC pasó; la batería conjunta posterior pasó cuatro controles MSE y dos canciones reales. Extracción completa: Airbag 299,7 s; Sucede 215,4 s. Es una muestra de dos, no una garantía general. |
| API 3, `080647` | Inicio residual de unos 4,677 s, salto fallido tras cambiar la inicialización WebM y primer rango desde 0,021 s. El fallo permanece registrado. |
| `083544` | 26 filas correctas y cuatro fallidas: tres esperas agotadas durante anuncios, sin inicio medido, y El día de la bestia con 4,941 s residuales. Los cuatro reintentos de `121124` pasan; no borran el intento original. |
| `085653` | Airbag → Paranoid Android tardó 649,3 ms pese al buffer preparado. `a3e6b24` evita esperar la promoción nativa para empezar ese Audio. |
| `092755` | Dardararen Bat retuvo el último paquete por comparar 212,981 con 212,98100000000002. `c603f8f` admite sólo el redondeo de cuatro EPSILON; no altera bytes ni cobertura. |
| `101042` | Buscando una luna se atascó ante 251,733333 frente a 251,73333333333332. `029d0cf` exige prueba terminal completa para admitir la cuantización del reloj; la repetición `105216` llegó al final. |
| Continuación tras timeout | El banco continuó automáticamente con la siguiente pista. Ese comienzo no se cuenta como transición natural desde un `ended` que no ocurrió. Las tandas interrumpidas conservan sus checkpoints y motivos. |

Las fases sintéticas comprueban el análisis de WebM/Opus y MP4/AAC, las épocas, cancelaciones y decodificación MSE.
Las muestras AAC y Opus generadas localmente conservan el PCM al comparar con FFmpeg; no se comparó el PCM de canciones remotas.
Los doce casos nativos de velocidad usaron AAC sintético: solicitar 16× produjo un ritmo observado cercano a 12×, no 16× exactos.
La revisión corrigió dos supuestos éxitos de conservación de velocidad publicitaria: la propiedad `playbackRate=1` no bastaba para demostrar el ritmo real.
Estos ensayos no justifican acelerar anuncios reales ni prueban el objetivo de identidad.

## Código nuevo y ensayo de precarga

La captura v6 añade telemetría de omisión; no permite atribuir retrospectivamente omitibilidad a los anuncios de v5.
La admisión temprana notifica sólo después de reservar o promover la plaza foreground y valida la época antes de abrir next.
Permite preparar la siguiente durante anuncios de arranque, también cuando la actual era una precarga pendiente.
El Audio ya preparado mantiene la barrera de promoción y reproducción; señales obsoletas se descartan y una señal perdida conserva la ruta anterior.
Los hitos de admisión, solicitud de precarga y `playing` comparten el reloj del navegador.
El ensayo dirigido siguiente comprueba la admisión temprana y la transición en la app. Aprovechar esa oportunidad de preparación no garantiza ocultar anuncios arbitrariamente largos ni cumplir siempre 500 ms.

### Controles normales

Los dos controles usaron el binario `029d0cf`, con `progressiveExperiment=false` confirmado por el backend. Ambos verificaron la captura completa y un salto de control al final; no fueron escuchas completas de principio a fin dentro de Musify.

| Canción / informe | Inicio total | Publicidad observada al inicio | Inicio menos publicidad | Audio verificado / ended | Fuentes publicitarias / entregadas etiquetadas | Resultado |
| --- | --- | --- | --- | --- | --- | --- |
| El día de la bestia / `121258` | 306,435 s | 20,023 s | 286,412 s | 0..284,421 s | 1 / 0 | Completo, cobertura MSE y final correctos |
| Preso / `121807` | 48,7321 s | 5,990 s | 42,7421 s | 0..40,701 s | 1 / 0 | Completo, cobertura MSE y final correctos |

La cuarentena conserva su validación, con el coste de esperar la presentación oficial completa. No cumple el objetivo de arranque progresivo. Los eventos de espera del salto de control se conservan aparte en los resultados; no se presentan como una escucha natural sin cortes.

### Par real con el código nuevo

El informe `122056`, binario `4fd3003` y captura v6/API 3, repite MALAMENTE → QUE NO SALGA LA LUNA. Las dos canciones llegaron a `ended`, con cobertura MSE y cero `waiting` después de comenzar, pero ambas conservaron **EOF sin verificación global completa** por el intervalo inicial Opus de 1 ms. El ensayo sigue marcado como fallido.

| Canción | Inicio / transición | Publicidad observada | Final local | Inventario global | Fuentes publicitarias / entregadas etiquetadas |
| --- | --- | --- | --- | --- | --- |
| MALAMENTE | Inicio 23,8044 s; 2,8034 s tras restar anuncio | 21,001 s al inicio | 150,041 s | Incompleto | 2 / 0 |
| QUE NO SALGA LA LUNA | Transición **2 ms** | 10,014 s ya observados al promocionar la precarga; no se restan de la transición | 269,561 s | Incompleto | 3 / 0 |

Los eventos del primer Audio registran la admisión a t+417,6 ms, la petición de precarga a t+417,7 ms y `playing` a t+23.803,1 ms, respecto a su observador. La preparación se pidió **23,3854 s antes** de que empezara a sonar. La promoción nativa de la segunda canción tardó unos 648 ms desde su petición; su Audio preparado ya estaba sonando durante esa espera.

La telemetría de los anuncios iniciales de MALAMENTE conserva diez intentos sobre el botón «Saltar», diez eventos observados y cero excepciones. Los eventos eran sintéticos y terminaron con `defaultPrevented=true`; eso no prueba que el sitio los ignorase ni que causaran la omisión. En la precarga de QUE, las 185 comprobaciones no encontraron ninguno de los tres selectores conocidos y no hubo intentos de clic. Tampoco demuestra que el anuncio fuera imposible de omitir mediante otro control.

La sesión anterior había acumulado 199,123 s de publicidad en esa precarga; ésta registró 10,014 s al promocionarla. Por tanto, el resultado de 2 ms **no permite atribuir causalmente** la desaparición de los 50,9 s anteriores a la nueva lógica. Sí prueba que la precarga se inicia antes del primer `playing`. No se ha repetido RENIEGO con v6 ni toda la batería de 30 canciones sobre este binario.

La tabla automática por canción selecciona este nuevo par como último intento: su agregado de transiciones pasa a **24/25** dentro de 500 ms y mantiene el fallo anterior de RENIEGO. Esa selección combina cuatro versiones; suma 78 identidades publicitarias observadas y cero unidades etiquetadas como anuncio entregadas. La tabla de referencia anterior conserva **23/25**, sus 77 identidades y sus dos fallos históricos. Los 28 inventarios globales incompletos siguen sin resolverse.

### Comprobaciones y commits

Código `4fd3003`: **227/227 pruebas JavaScript**, sin omisiones; **46 pruebas Rust correctas**, 12 de integración ignoradas; TypeScript/Svelte sin errores ni avisos. Compilación Tauri de la app aislada correcta. Se corrigió también la llamada de un test Rust al nuevo argumento opcional de admisión. No se publicaron extractores ni instaladores.

Las tandas `115924`, `121124`, `121258` y `121807` reutilizaron exactamente el ejecutable de `029d0cf`, comprobado por SHA256. Sus metadatos muestran archivos editados mientras corría la batería; esas modificaciones aún no estaban en el binario. El ensayo `122056` se compiló después del commit `4fd3003`, con captura v6/API 3.

| Commit local | Cambio |
| --- | --- |
| `f4868be` | Snapshot API 2 trasladado al worktree propio. |
| `85cb60b` | API 3 y aislamiento del experimento tras el contraejemplo de anuncios tardíos. |
| `3b17b7d` | Banco real, resultados y procedencia. |
| `ea3153b` | Continuidad Opus de fuentes completas certificadas en modo normal. |
| `a3e6b24` | Inicio inmediato del Audio preparado mientras termina su promoción nativa. |
| `14bc9d9` | Cambios en frío y registro de interrupciones. |
| `a68c411` | Evidencia y fallos de las primeras tandas. |
| `c603f8f` | Comparación de EOF equivalente por redondeo binario. |
| `1f2e7ec` | Separación de anuncios etiquetados, finales y cobertura en el resumidor. |
| `42cb6de` | Evidencia de los fallos Opus y AAC, con hashes y diagnósticos. |
| `029d0cf` | Validación estricta de la representación terminal del reloj AAC. |
| `4fd3003` | Admisión temprana, telemetría de omisión y modo efectivo en los informes. |

El commit documental posterior conserva este informe, los planes y las nuevas evidencias; su identificador se entrega al cerrar el trabajo. Todos los commits están en `p1-oficial`, sin push ni merge.

Resolver la atribución antes de entregar bytes sigue siendo el requisito que bloquea la aprobación, aunque las medidas temporales mejoren.
Hasta entonces se mantienen la cuarentena normal, el experimento explícito y la separación respecto de Propio y `main`.
