# Captura oficial de YouTube — P1

Trabajo aislado en `p1-oficial`, worktree `musify-oficial`. No publicar extractores,
fusionar ni hacer push a main. Sólo se permite push a esta rama. Estado: implementación
API4/captura v13 medida, todavía sin aprobar la promoción; los resultados reales están en el
[informe](informe-captura-youtube-2026-10-07.md).

## Decisiones vigentes

El camino recomendado es **Propio**: nivel rápido en Rust, sin sesión y sin anuncios,
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
   evita arrancar al borde del buffer. Los resultados tardíos de clic conservan
   su solicitud original aunque ya haya comenzado otro anuncio.
3. **Verificación independiente.** Para el mismo vídeo se descarga el audio nativo sin
   cookies, preferentemente con el mismo formato/itag. El banco compara todos los
   paquetes publicados, incluidos los anteriores a saltos y recuperaciones, mediante
   hashes de contenido y tiempos; si no coincide, intenta PCM estricto con FFmpeg.
   Una discrepancia, paquete omitido o alineación no verificable impide aprobar.
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
   encontraron publicidad acelerada con señales tardías incluso tras corregir la
   propiedad playbackRate. Los12× reales observados históricamente al pedir16× no
   aprobaron esa seguridad. No se repite ese riesgo con anuncios reales: se mantiene1×.
7. **Silencio nativo.** Rust impone `ICoreWebView2_8.SetIsMuted(true)` y lee `IsMuted`
   antes de registrar el puente y navegar en Oficial, Legacy y el perfil manual.
   Si falla, no navega. El perfil manual se verifica antes de mostrarlo, también
   al reutilizarlo. Esto silencia la ventana de adquisición sin detener ni acelerar
   el anuncio y sin tocar el Audio principal ni el mezclador del sistema.

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

La demora máxima independiente del marcador sigue sin medirse;1,5s conserva su carácter
experimental. Continúan pendientes el arranque/búsqueda, el seek, la estabilidad del
productor/entrega y una nueva tanda completa sin fallos. El [informe](informe-captura-youtube-2026-10-07.md)
contiene la tabla por canción, diagnósticos, procedencia, anuncios y commits.

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
