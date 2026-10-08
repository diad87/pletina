# Captura oficial de YouTube — P1

Trabajo aislado en `p1-oficial`, worktree `musify-oficial`. No publicar extractores,
fusionar a main ni hacer push a main. Está autorizada la integración de `origin/main`
en esta rama y su push para revisión. Estado: implementación
API4/captura v25, todavía sin aprobar la promoción; el
[informe inicial](informe-captura-youtube-2026-10-07.md) y el
[diagnóstico del 8 de octubre](informe-captura-youtube-2026-10-08.md) conservan los resultados.

## Decisiones vigentes

El 8 de octubre el usuario aprobó reducir el mantenimiento del camino rápido:
descubrir la configuración que publica YouTube, renovar datos obsoletos sin
publicar una receta y probar alternativas verificadas antes del respaldo.
Rust conserva su prioridad; la receta firmada queda como reparación excepcional.
La configuración web no se atribuye al cliente VISIONOS y los cambios de
protocolo o descifrado todavía pueden requerir código. Esto no promueve la
captura progresiva ni cambia sus criterios de aprobación.

Esta adaptación está implementada: el descubrimiento anónimo real funciona y
30/30 canciones arrancaron por VISIONOS en la app, sin respaldo, con mediana de
653,4 ms incluyendo búsqueda. La meta de 300 ms sigue pendiente. Las pruebas
HTTP locales ejercitan renovación de cliente e identidad/sondas inválidas;
los límites y las mediciones se recogen en [Propio adaptativo](propio-adaptativo.md)
y en el [informe del 8 de octubre](informe-captura-youtube-2026-10-08.md).

El camino recomendado es **Propio**: audio directo en Rust, sin iniciar sesión,
y captura oficial como respaldo. yt-dlp sigue predeterminado. La captura nueva sustituirá
el respaldo histórico cuando supere sus resultados y las pruebas de admisión.

La aprobación se mide **sin iniciar sesión**. Premium sólo sirve como referencia,
en un perfil separado y con acceso manual del usuario. Ningún agente introduce
credenciales. Perfiles, cookies, tokens, medios y volcados quedan fuera de Git.

La captura nueva API4 permanece a1× y salta anuncios únicamente mediante el botón oficial visible
y habilitado, igual que una persona. No los bloquea ni acelera. Legacy conserva su
limitación histórica ante marcadores tardíos, descrita en PLAN y sin aprobación API4.
Un anuncio sin botón
observado no queda automáticamente clasificado como imposible de saltar.

## Implementación

1. **Clic nativo.** El adaptador propone las coordenadas de un botón conocido, visible,
   habilitado y comprobado mediante hit-test. Rust revalida la propuesta, su fuente,
   generación, época y caducidad. WebView2 ejecuta `Input.dispatchMouseEvent`, esperando
   la respuesta de cada evento antes del siguiente. Se registran evento confiable,
   cancelación y transición observada, separando intento de omisión efectiva.
   Para el umbral de50 sólo cuentan transiciones cuyo marcador publicitario explícito
   se observó a1× en esa misma fuente/generación/época. Un ID diferente, una copia
   del marcador o un registro antiguo sin esa evidencia no acredita otro anuncio.
2. **Entrega progresiva experimental.** Cada unidad debe conservar identidad, fuente,
   configuración y cobertura confirmadas. Se retienen los últimos1,5s, configurables,
   y una contradicción descarta la cuarentena. El EOF válido libera la cola retenida.
   El modo normal conserva la cuarentena completa hasta terminar las pruebas reales.
   El lector espera0,5s continuos aceptados por MSE antes de reproducir; el margen
   evita arrancar al borde del buffer. También exige esa reserva al adoptar un salto,
   en el ledger nativo, el lote MSE terminado y el buffer real. Sólo el extremo de
   audio validado por EOF permite una cola menor; la duración nominal no la recorta.
   Los saltos tienen IDs monótonos y admisión nativa antes de operar. Una respuesta
   antigua no mueve el reloj ni adopta otra generación. Volver a caché parcial
   reorienta el productor hacia el extremo útil sin esperar el IPC para sonar.
   El banco comprueba también ocho segundos de continuidad tras cancelar el salto
   anterior, conservando las esperas reales, incluidas las anteriores al regreso.
   Las continuaciones mantienen los bytes originales; un bloque incompleto queda
   retenido hasta terminar. Sólo en el experimento WebM, los huecos y las nuevas
   inicializaciones pueden conservar una vista de paquetes originales ordenados.
   Las repeticiones deben ser idénticas en configuración, metadatos y bloque entero;
   los índices publicados y todos los bytes copiados son inmutables. Un paquete
   nuevo no puede aprovechar observaciones anteriores a su llegada. La vista
   derivada nunca acredita EOF, certificado completo ni libera la última cola N;
   su final requiere una recaptura original limpia. Los bytes retenidos de todos
   los fragmentos y sus copias del parser cuentan en el límite; éste no mide el
   heap JavaScript exacto ni el pico temporal del parseo.
   Si el origen se agota mientras su captor prepara el destino, la espera sigue
   siendo visible en el banco. Los resultados tardíos de clic conservan
   su solicitud original aunque ya haya comenzado otro anuncio.
3. **Verificación independiente.** Para el mismo vídeo se descarga el audio nativo sin
   cookies, preferentemente con el mismo formato/itag. El banco compara todos los
   paquetes publicados, incluidos los anteriores a saltos y recuperaciones, mediante
   hashes de contenido y tiempos; si no coincide, intenta PCM estricto con FFmpeg.
   Una discrepancia, paquete omitido o alineación no verificable impide aprobar.
   La resolución anónima realiza como máximo dos intentos por cliente, solicitando
   visitante fresco en el segundo intento. Los fallos conservan categorías por
   etapa, sin URLs firmadas, visitantes ni datos de cuenta. El nivel rápido usa el
   mismo diagnóstico privado del banco y valida el campo del visitante decodificado:
   los identificadores que empiezan por dígito o guion no se rechazan por `Cgs`.
   La referencia se descarga por rangos verificados de256KiB, como máximo cuatro
   simultáneos, conservando un mismo validador HTTP. El final exige todos los paquetes
   que producen muestras, incluidos los recortes por appendWindow; no basta con
   que los paquetes recibidos sean correctos. PCM usa el desplazamiento declarado.
   El recorte del último AAC se admite sólo con muestras enteras exactas, el mismo
   payload/configuración/origen y appendWindowEnd igual al final independiente:
   no amplía tolerancias ni oculta una muestra final ausente.
4. **Precarga de dos canciones.** Tres ventanas como máximo: actual y dos siguientes.
   Los Audio preparados se conservan por canción/plaza al avanzar; promocionar B no
   cancela C. El supervisor da prioridad a la actual y limita memoria total y por pista.
5. **Final y cuantización.** API4 incorpora índices de paquetes y certificado
   `complete-source-v1`, ligado a la fuente original, época, inicialización y ajustes.
   Sólo un EOF limpio y todos sus índices permiten acreditar el intervalo completo.
   Un hueco de representación de1ms con MSE continuo y decodificación correcta no
   equivale a un paquete perdido. Un salto sin capturar conserva su hueco real.
   Si la recuperación tras un salto encuentra ese hueco de representación, vuelve
   a presentar una fuente original desde cero. Sólo el certificado nuevo acredita
   su cobertura; los bytes ya entregados se conservan.
   Se prueba una segunda superficie pública (`www.youtube.com`) cuando Music cambia
   los ajustes MSE para anticipar otro vídeo. No se mezcla ese inventario ni se
   interpreta el cambio como EOF. Una incompatibilidad repetida debe detener las
   recargas automáticas y conservar el audio ya publicado.
6. **Velocidad.** La captura nueva permanece a1×. Los ensayos controlados a2×/4×/16×
   encontraron publicidad acelerada con señales tardías. A4×/16× también se midió
   después de volver playbackRate a1; ese tramo posterior a2× quedó sin acreditar.
   Los12× reales observados históricamente al pedir16× no
   aprobaron esa seguridad. No se repite ese riesgo con anuncios reales: se mantiene1×.
7. **Silencio nativo.** Rust impone `ICoreWebView2_8.SetIsMuted(true)` y lee `IsMuted`
   antes de registrar el puente y navegar en Oficial, Legacy y el perfil manual.
   Si falla, no navega. El perfil manual se verifica antes de mostrarlo, también
   al reutilizarlo. Esto silencia la ventana de adquisición sin detener ni acelerar
   el anuncio y sin tocar el Audio principal ni el mezclador del sistema.
8. **Consentimiento dentro de la página.** El diálogo oficial de www/music puede
   pausar el reproductor cada100ms hasta resolverse. Se pulsa sólo un rechazo
   visible, habilitado e inequívoco en el componente conocido, con texto ES/EN exacto
   y etiqueta accesible compatible con rechazo. Mientras esté visible no se fuerza
   play ni se acredita canción. Si sigue abierto a los10s, se pide interacción.
   El cierre exige una nueva observación y conserva la verificación de arranque y EOF.
   Este clic DOM se distingue de la omisión nativa CDP de anuncios. La auditoría
   opcional conserva contadores y cierre observado, nunca textos de cuenta.
   El intervalo suspendido no une cobertura ni permite EOF, también si dura menos
   de500ms o el sitio retira la fuente antes del siguiente callback. Las contradicciones
   siguen registradas. Sólo sin unidades publicadas y con todos los bindings nativos
   limpios puede repetirse desde cero, dentro del límite de una repetición. Los bytes
   ya publicados siguen como parciales si se interrumpe la presentación después.
9. **Trabajo y cierre sin esperas ciegas.** Se reutilizan sólo rangos e índices
   calculados a partir del inventario inmutable, ligados a versión, tupla, fuente,
   época y buffers nativos. Identidad, reloj, retención, cobertura y EOF se comprueban
   de nuevo. El cierre revoca la sesión, finaliza la auditoría y confirma destrucción;
   ya no añade300ms fijos. Si no desaparece en5s, conserva la plaza y comunica fallo.
   La auditoría privada registra el estado real al terminar play() y en el evento
   play; no convierte la llamada en presentación ni inventa posición cero. Esto
   permite observar el primer paquete cuando el navegador realmente expone cero
   con datos listos y luego avanza; las puertas del análisis independiente no cambian.

El banco aislado permite tandas paralelas con identificador propio, SQLite por proceso
y nombres de informe únicos. La batería de cobertura puede dividirse en los cinco
álbumes (seis canciones y cinco transiciones naturales cada uno); se registra esa
carga concurrente y no sustituye la medición normal de arranque.
Cada proceso ejecuta una copia inmutable del binario, con SHA y procedencia de compilación.
La observación funciona cada25ms y conserva el límite máximo de500ms entre relojes;
la publicación agrupa tramos durante75ms y el EOF válido libera siempre la cola final.
Si el arranque pierde un intervalo antes de preparar cualquier unidad, se permite
una sola repetición desde cero en la misma ventana. Se descarta toda la historia
anterior; identidad incierta, cambios MSE, seeks previos y un segundo fallo siguen
rechazándose. Sólo la nueva presentación entera puede certificar el final.

Retener1,5s no es una prueba universal: el ensayo controlado con marcador retrasado1,7s
conserva180ms de anuncio entregado en el experimento. La admisión será empírica y
explícita; no se presenta como inmunidad total a cambios de YouTube.

## Pruebas en la aplicación

Se conservan las30 canciones de `real_albums`: seis de OK Computer, Infrasoinuak,
Agila, El Mal Querer y Abbey Road. Los fallos permanecen en el informe y los reintentos
no borran los intentos originales. Búsqueda fría y reproducción se miden juntas en
Propio; preparar un ID fuera del cronómetro no cuenta como búsqueda incluida.

| Caso sin Premium | Criterio |
|---|---|
| Propio con nivel rápido: primer sonido, incluida búsqueda | ≤300ms |
| Propio con nivel rápido: transición natural | ≤100ms |
| Respaldo oficial: primer sonido | ≤3s más la parte de anuncio que no pudo saltarse |
| Respaldo oficial: transición natural | ≤500ms |
| Respaldo oficial: salto al80% aún no capturado | ≤1s |
| Audio publicado | 0 discrepancias con la referencia |
| Cobertura y escucha | EOF, principio/final completos y0 cortes |
| Cohorte publicitaria | ≥50 transiciones reales distintas, sin sesión |

Los eventos `playing`, `waiting`, `ended`, tiempos y rangos se observan dentro de
WebView2 con volumen cero. La comparación de paquetes/PCM es independiente de las
etiquetas de anuncios. Premium se mide aparte, con pocas tandas, sin contribuir a aprobar.
La demora máxima del marcador necesita una referencia externa del inicio publicitario;
no puede deducirse comparando el marcador consigo mismo.

El banco usa identificador y base de datos aislados. Cada ejecución anónima crea un
perfil nuevo; se exige observar `LOGGED_IN=false`, nunca inferirlo por ausencia de datos.
El perfil `premium-manual` persiste separado y se abre para el acceso del usuario.

```powershell
./scripts/bench-capture.ps1 -Suite native-search -CorpusPath tests/fixtures/real-albums.capture.json
./scripts/bench-capture.ps1 -Suite album -CorpusPath tests/fixtures/real-albums.capture.json -AuditAllAudio
./scripts/bench-capture.ps1 -Suite ad-transitions -CorpusPath tests/fixtures/real-albums.capture.json -AuditAllAudio
./scripts/bench-capture.ps1 -Suite profile-login
```

Configuración: `MUSIFY_BENCH_HOLDBACK_SECONDS` (1,5), `MUSIFY_CAPTURE_MAX_SESSIONS`
(3), `MUSIFY_CAPTURE_TRACK_MB` (96) y `MUSIFY_CAPTURE_CACHE_MB` (288).
Una configuración inválida o un total menor que el límite por pista debe fallar con
diagnóstico. Estos límites acotan audio almacenado; la memoria del navegador se mide aparte.
`-NoSeek` comprueba EOF completo sin mezclarlo con la prueba de salto.
El probe se congela al retirar la sesión, confirma sus contadores en Rust y se cierra
después. Una confirmación perdida mantiene la evidencia incompleta. Las comprobaciones
periódicas se agrupan por vídeo; la final toma un snapshot nuevo y conserva los fallos.

## Promoción y mantenimiento

La app puede publicarse con los otros extractores y con Oficial experimental
antes de alcanzar las metas de promoción. La configuración actual conserva
yt-dlp predeterminado, youtubei→yt-dlp y Propio→Rust→Legacy; no encadena los tres
motores automáticamente. La entrega progresiva nueva sigue restringida al banco
con opt-in; el uso normal de Oficial retiene la fuente completa hasta validarla.
Publicar esa versión no equivale a activar progresiva ni sustituir Legacy.

**Empaquetado revisado el 8 de octubre, antes de la integración:** el paquete local v25/API4 coincide
con el bundle incluido y ambos scripts pasan comprobación de sintaxis. No está
firmado ni publicado. Una app API1 no acepta el script API4 ni recibe por él las
mejoras Rust/lector: la entrega requiere una nueva app compatible.

**Integración del 8 de octubre:** `p1-oficial` incorpora `origin/main` en `b1733bb`,
Pletina 0.9.1, por petición del usuario. Conserva su nombre visible, canal
`diad87/pletina-releases`, Spotify, podcasts y su aviso de anuncios, Android y las
comprobaciones SHA256SUMS/procedencia. Los identificadores y nombres internos
Musify permanecen. Captura mantiene v25/API4; receta y youtubei v1/API1.
El [informe](informe-captura-youtube-2026-10-08.md) separa esta integración y las
comprobaciones de código de las mediciones históricas y la promoción pendiente.
Se sube la rama para revisión; no se publica la app ni los extractores.

**Validación cerrada, no aprobada (7–8 de octubre).** Propio resolvió30 búsquedas
frías por Rust, sin fallback, en445–1.649ms (mediana698): no cumple300ms.
En la escucha completa de los cinco discos hubo29 resoluciones rápidas y un respaldo
Legacy por sesión de visitante ausente;30 finales naturales y0 esperas durante escucha.
Las25 transiciones tardaron3,7–13,2ms: cumplen100ms. Se corrigió el diagnóstico del
banco que confundía Legacy con URL directa y priming AAC negativo con inicio ausente;
los informes históricos permanecen intactos.

La campaña específica anónima alcanzó50 transiciones publicitarias acreditadas en55
intentos:13 clics confiables y12 omisiones correlacionadas antes del final conocido.
Espera publicitaria5,035–20,520s;0 discrepancias en todas las unidades publicadas.
Pero los arranques residuales tardaron3,634–6,014s; los30 seeks no capturados tardaron
2,003–2,270s y los30 cambios fríos4,103–4,972s más publicidad. Los cinco discos Oficiales
bajo estrés tuvieron25 esperas y cuatro plazos agotados;25 canciones tuvieron a la vez
ended y verificación independiente completa, frente a26 de cada contador por separado.
Sólo20 filas carecieron de fallos al considerar también tiempos y continuidad.
El falso rechazo final AAC de Sucede se
corrigió y una repetición real cerró8069/8069 paquetes, sin cortes ni discrepancias.
El control del silencio nativo confirmó todos los paquetes y EOF, pero sufrió cinco
cortes. Premium quedó separado: dos canciones completas sin anuncios, inicio5,391s,
next8,2ms; seek no capturado2,106s y dos cambios fríos4,135–4,392s. No aprueba la cohorte.

**Continuación del8 de octubre, captura v19.** El control de PRESO cerró con0 cortes,
2035/2035 paquetes coincidentes y reloj estable1× después de rechazar el consentimiento
inline. La pausa periódica provenía del diálogo de YouTube; el lector no tenía un
backoff creciente. El arranque sin anuncios tardó5,575s y sigue fuera de objetivo.
Los intentos intermedios fallidos y la recuperación de referencia quedan registrados
en el [diagnóstico](informe-captura-youtube-2026-10-08.md). La escucha consecutiva de
ROSALÍA cerró6/6 completas,50343/50343 paquetes coincidentes,0 cortes y cinco cambios
de1,5–3,6ms. Cinco fuentes publicitarias consumieron41,440s en precarga, con4 omisiones
operativas después de clics confiables; no se restan de los cambios preparados. El
inicio frío fue6,464s sin anuncio y sigue fallando. Captura v20 protege también los
callbacks de detach y la suspensión menor de500ms; no cambia1×/N1,5/API4. Las tandas
siguen siendo el experimento progresivo, no el modo normal promovido.

El control final v20 de Airbag→Preso cerró2/2 completas,16430/16430 paquetes
coincidentes,0 cortes y transición6,6ms. Airbag inició en6,008s sin anuncio;
Preso recuperó una fuente descartada antes de publicar y omitió un anuncio tras
clic nativo, con5,084s consumidos en precarga. Son7 canciones distintas entre ese
control y ROSALÍA, no8 ni30. Propio resolvió Preso por Rust, sin fallback y con
búsqueda incluida, en736ms; ended/cobertura y0 cortes, pero falla300ms. Tres
destinos oficiales sin audio preparado tardaron4,126–4,404s más publicidad
observada;124/124 paquetes históricos coincidentes, sólo prefijos sin EOF.
El salto correcto no capturado al80% en v20 tardó2,089s, con100/100 paquetes
coincidentes,0 anuncios y sin prueba de canción completa; falla1s.

La demora máxima independiente del marcador sigue sin medirse;1,5s conserva su carácter
experimental. Continúan pendientes el arranque/búsqueda, el seek y una nueva tanda
completa sin fallos. El [informe inicial](informe-captura-youtube-2026-10-07.md)
contiene las30 canciones, la campaña publicitaria, Premium y la procedencia anterior.

El control v21 del 8 de octubre
cerró Preso verificada (2035/2035, 0 cortes) y De Aquí sin cortes pero sin referencia
independiente: no aprueba esa segunda canción. Inicio 5,535 s, siguiente 2,1 ms,
seek no capturado 2,375 s y retiros confirmados de 30,3/31,0 ms. La auditoría ya
observa el primer paquete completo de Preso, pero todavía no acredita retraso de
anuncio ni permite reducir N. También falta conservar producción del origen en
un seek temprano y replanificar el motor al volver a caché parcial tras enviar otro
salto; invalidar el reply sólo protege el reloj del lector.

**Continuación v22–v25 del 8 de octubre.** Las intenciones crecientes y las
comprobaciones nativas de propietario impiden que un salto antiguo adopte de nuevo
el reloj. Volver a caché parcial replanifica ahora el productor hacia el borde útil
del origen. Después de tres intentos fallidos conservados, v25 mantuvo 8,002 s
continuos: adopción local 0,6 ms, reloj retomado 90,7 ms, 121 unidades y 528/528
paquetes históricos coincidentes, sin espera de escucha. La vista parcial WebM
ingirió relleno fuera de orden y 500 bloques repetidos sin perder el prefijo;
el ensayo no llegó a reproducir esos paquetes nuevos. La vista sigue sin poder
certificar EOF ni liberar la cola retenida: falta su cierre mediante recaptura
limpia y recuperación sin cortes.

El control completo v25 Preso→De Aquí cerró 2/2, 9263/9263 paquetes, cero
discrepancias y cortes; siguiente 4,6 ms, inicio frío 6074 ms. No tuvo publicidad.
El control completo v24 de esas dos canciones también cerró verificado y sin
cortes; sus dos fuentes publicitarias produjeron una transición acreditada y una
omisión temprana correlacionada tras clic nativo, con 11019 ms en precarga.
El análisis independiente aún no mide demora del marcador: N permanece 1,5 s.

Propio/v25 resolvió las 30 búsquedas frías por Rust, vídeo correcto y ningún
respaldo: mínimo 435,7 ms, mediana 548,9 ms, máximo 1318,4 ms; ninguna cumple
300 ms. Se corrigió la validación del visitante decodificado, que ya no exige
un prefijo base64 fijo; no se atribuye a esa corrección el fallo histórico cuya
causa faltaba. Son arranques, no 30 escuchas completas. El seek al 80 % no
preparado tardó 2461,7 ms con 560 ms de reserva de destino y 117/117 paquetes
de prefijos, pero el origen se agotó durante 1916,1 ms. Sigue pendiente.
374 pruebas JavaScript y 109 Rust aprobadas, 13 Rust ignoradas; tipos y build
Windows correctos. Premium no se utilizó; sus referencias históricas están
separadas en el [informe](informe-captura-youtube-2026-10-08.md), junto con todos
los fallos, hashes y commits. Propio conserva Rust→Legacy, yt-dlp predeterminado,
la nueva progresiva experimental a 1×, sin promoción ni publicación.

La entrega progresiva pasa a normal sólo después de30 canciones completas distintas y
50 transiciones publicitarias reales sin sesión, cero discrepancias, cobertura y tiempos
correctos. Los informes parciales pueden superar sus medidas y seguir pendientes de
aprobación. Si falla una canción, se informa su motivo y se conserva la reproducción ya
confirmada durante la recuperación del tramo ausente.

El núcleo usa interfaces multimedia estándar; el adaptador concentra las señales del
sitio. MSE en workers, HLS, multiplexación, cambios de códec y otras plataformas siguen
necesitando pruebas específicas. Apoyarse en el reproductor reduce la dependencia de su
API interna, pero identificar anuncios y copiar su audio todavía depende de capacidades
observables. Receta y youtubei.ts no cambian en esta iteración.

Las evidencias históricas detalladas y sus32 hashes se trasladaron a
`capture-evidence.local/legacy-2026-10-07/`, ignorada por Git. En docs queda sólo un
[resumen histórico](evidence/capture-2026-10-07/README.md).

Referencias de implementación: [WebView2 CallDevToolsProtocolMethod](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2?view=webview2-1.0.3296.44),
[CDP Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/) y
[ffprobe: hashes de paquetes](https://ffmpeg.org/ffprobe-all.html).
Silencio del motor: [WebView2 ICoreWebView2_8](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2_8?view=webview2-1.0.3967.48).
