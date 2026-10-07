# Captura oficial de YouTube — P1

Trabajo aislado en `p1-oficial`, worktree `musify-oficial`. No publicar extractores,
fusionar ni hacer push a main. Sólo se permite push a esta rama. Estado: implementación
API4/captura v13 en validación; los resultados reales estarán en el
[informe](informe-captura-youtube-2026-10-07.md).

## Decisiones vigentes

El camino recomendado es **Propio**: nivel rápido en Rust, sin sesión y sin anuncios,
y captura oficial como respaldo. yt-dlp sigue predeterminado. La captura nueva sustituirá
el respaldo histórico cuando supere sus resultados y las pruebas de admisión.

La aprobación se mide **sin iniciar sesión**. Premium sólo sirve como referencia,
en un perfil separado y con acceso manual del usuario. Ningún agente introduce
credenciales. Perfiles, cookies, tokens, medios y volcados quedan fuera de Git.

Los anuncios se reproducen a1× y se saltan únicamente mediante el botón oficial visible
y habilitado, igual que una persona. No se bloquean ni aceleran. Un anuncio sin botón
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
6. **Velocidad.** La protección nativa mantiene1×. Se estudian2×/4×/16× sólo cuando
   puedan verificarse identidad, cobertura y anuncios a1×. Los12× reales observados
   históricamente al pedir16× no aprobaron esa seguridad. Si no se demuestra, se mantiene1×.

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
