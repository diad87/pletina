# Plan del motor propio basado en el reproductor de YouTube

El objetivo es que Musify siga obteniendo la canción cuando cambie la API interna de YouTube, con el menor mantenimiento posible y sin entregar anuncios al usuario. YouTube se encarga de reproducir con su código actualizado; Musify observa la entrega de audio al navegador y conserva únicamente el contenido identificado como la canción.

Este documento recoge el plan y su estado de implementación. La primera plataforma es Windows con WebView2. La prioridad es la continuidad de reproducción y la separación correcta de anuncios; después, reducir espera, memoria y CPU.

## Estado de la implementación — 6 de octubre de 2026

La captura oficial tiene un núcleo separado del adaptador YouTube y protocolo API 2. Es una **prueba experimental**, seleccionable como «Oficial (experimental)»: reproduce a 1× dentro de YouTube y retiene la fuente completa antes de entregarla a Musify. El motor predeterminado sigue siendo yt-dlp mientras no se supere la primera fase.

**Batería final del código actual: correcta.** `capture-bench.local/result-20261006-222951.json` pasó los cuatro controles MSE y las dos canciones reales, incluidas decodificación, cobertura continua, salto al 80 % y reproducción del final. Se ejecutó con las guardas de `abort`, `remove` y `changeType`, sin reintentos y usando únicamente la captura oficial para extraer el audio.

| Canción | Formato | Cobertura de audio | Bytes | Tiempo hasta extracción |
|---|---|---:|---:|---:|
| Airbag (`jNY_wLukVW0`) | WebM/Opus | 0..287,901 s | 4.881.724 | 299,7 s |
| Sucede (`nV-F1WSpJIA`) | MP4/AAC-LC | 0..187,333333 s | 3.034.789 | 215,4 s |

La espera incluye publicidad y la reproducción oficial completa a 1×. Ambos intentos observaron señales de anuncio al principio y en la transición posterior al final. Esta muestra no valida todavía anuncios intermedios ni todos los cambios posibles del sitio.

Implementado:

- Asociación MediaSource → URL → elemento multimedia, cuarentena con límite de memoria y comprobación de los tiempos codificados de WebM/Opus y MP4 fragmentado/AAC-LC. Una fuente presentada con identidad desconocida o mezclada no se entrega. La inicialización, el orden de los bytes y los ajustes de `SourceBuffer` se conservan; formatos y estructuras sin verificación se rechazan. Un aborto con bytes ya capturados, una eliminación de rangos o un cambio de formato invalidan la fuente tras realizarse la operación nativa; una excepción sin cambio no la invalida.
- Supervisor único, generaciones y secuencias, validación de la fuente confirmada, prioridad de reproducción sobre precarga y cancelación de búsquedas todavía sin ID. Watchdog por avance, reintentos limitados y cierre confirmado de ventanas. El avance de un anuncio en la misma fuente puede añadir hasta 180 s de espera; un latido, más bytes o un salto no amplían el plazo. Sin avance durante 60 s se activa la recuperación. Se conserva el último diagnóstico incluso al agotar el tiempo.
- Lector con cancelación, espera de SourceBuffer, cambios de revisión y recuperación de rangos expulsados tras EOS. La caché completa permite reconstruir la reproducción al saltar sin volver a extraer desde una posición parcial.
- Interacción explícita cuando YouTube necesita al usuario, conservación de las elecciones manuales y separación de errores temporales frente a vídeos eliminados.
- Modo oficial independiente de la búsqueda interna: usa el ID guardado o abre la elección manual, con búsqueda en el sitio oficial y enlace pegado. No llama a YouTube Music interno ni a yt-dlp para resolver una canción en ese modo. Las otras opciones conservan su búsqueda automática.
- Resultados del benchmark que exigen audio, saltos y final completo cuando se solicitan; conservan también el diagnóstico de los fallos. Pruebas automáticas y comprobaciones de CI antes de publicar.

El banco real se ejecuta con `scripts/bench-capture.ps1`, con identificador de aplicación, perfil WebView2 y base de datos propios. Usa el código incluido, no actualiza componentes y pide solamente la captura oficial. Los informes quedan en `capture-bench.local/`, fuera de Git. Ejemplo en PowerShell:

```powershell
./scripts/bench-capture.ps1 -VideoId @('jNY_wLukVW0', 'nV-F1WSpJIA')
```

**Primera batería real:** ambos intentos llegaron al reproductor oficial, sin resolver mediante los clientes internos de Musify, y entregaron cero bytes al fallar la validación. `jNY_wLukVW0` detectó el título visible vacío al comenzar la canción, aunque coincidían el ID del reproductor y la página. `nV-F1WSpJIA` eligió AAC/MP4, que el primer prototipo no analizaba. Estos resultados se conservaron como fallos; motivaron una espera de identificación a tiempo cero y el trabajo de validación de AAC.

La inspección posterior identificó una variante sin sesión iniciada que no contiene `ytmusic-player-bar`. Se acepta únicamente cuando el título del enlace del propio reproductor y el de `navigator.mediaSession.metadata` coinciden exactamente con el título del vídeo presentado. Una barra existente con título contradictorio sigue bloqueando la captura. Si las señales aún no están disponibles y el reloj está exactamente en cero, se pausa antes de observar la presentación y se espera un máximo de diez segundos; no se reclasifica contenido ya presentado con identidad desconocida.

Los ensayos completos detectaron además dos diferencias del navegador que el primer comprobador no contemplaba. En WebM, el tamaño exterior de Segment puede describir un archivo cuyos índices finales no se añaden a MSE: se comprueban estrictamente los hijos efectivamente añadidos. YouTube también puede sustituir la fuente antes de emitir `ended`: se observa el reloj anterior al cambio, pero cubrir los bytes descargados no basta para declarar completa una canción. Se exige también el EOF exitoso del reproductor oficial y que MediaSource siga en estado `ended`, o un evento `ended` real. Con ese EOF, puede cerrarse el audio mientras la identidad todavía sea contenido y el reloj cubra todos sus frames, aunque el vídeo termine después.

El marcador de un anuncio posterior puede aparecer cuando el elemento anterior ya ha terminado. En ese límite se conserva la identidad confirmada durante su última presentación: misma fuente y elemento, solamente observaciones de contenido, reloj exactamente al final, elemento nativo terminado y pausado, EOF exitoso y última observación hace como máximo 500 ms. Esto no rehabilita una fuente que haya mostrado identidad desconocida o de anuncio mientras avanzaba. Un evento `ended` sintético tampoco sustituye al estado real del elemento.

En AAC se observaron `timestampOffset=-0.036281179138321996` y una ventana de final finita. Se conserva una configuración inmutable desde el primer append, se transporta junto con la fuente verificada y se aplica antes de reproducir sus bytes. Se contrasta el rango que produciría descartar frames completos o recortar sus bordes con el rango real de audio del navegador. No se supone que el desplazamiento sea silencio ni se modifican los paquetes. Los cambios de configuración dentro de una fuente siguen sin estar admitidos. Estos bytes y ajustes forman una unidad: exportarlos como un MP4 independiente que ignore los ajustes todavía no está validado.

En MP4 fragmentado, las duraciones de la cabecera inicial no describen necesariamente todos los fragmentos añadidos. El analizador conserva esos valores como diagnóstico y obtiene la línea temporal de las muestras y sus timestamps; comprueba por separado la duración global `mehd` si existe. Mantiene el rechazo de fragmentos intermedios ausentes, solapados o reordenados, y exige que el resultado coincida con los rangos reales de SourceBuffer. Véanse [MSE ISO-BMFF, segmentos de inicialización](https://www.w3.org/TR/mse-byte-stream-format-isobmff/#initialization-segments) e ISO/IEC 14496-12, §8.8.2 y anexo A.8, referenciados en el analizador.

**Comprobación controlada en WebView2:** cuatro casos de audio generado localmente —tres AAC con distintas ventanas y un WebM/Opus con retraso y padding— reprodujeron hasta el final. Para cada caso, dos MediaSource independientes recibieron los mismos bytes y ajustes y produjeron idénticos rangos y duración. En el WebM, el rango codificado termina en 0,221 s y el audible analizado en aproximadamente 0,201 s; el navegador confirmó exactamente ese rango codificado. La comparación con SourceBuffer utiliza ahora el rango codificado, conserva el audible como diagnóstico y exige cubrir el mayor intervalo sin aumentar la tolerancia. Se reproduce con `./scripts/bench-capture.ps1 -MseOnly -TimeoutSeconds 120`; las muestras y su procedencia están en `tests/fixtures/mse-audio.json`, `tests/capture-mp4.test.mjs` y `tests/capture-core.test.mjs`. Esto comprueba temporización y decodificación, no identificación de anuncios.

**Primera captura real completa comprobada:** el informe `result-20261006-220255.json` registra «Airbag» (`jNY_wLukVW0`), WebM/Opus, con 4.881.724 bytes y 14.395 frames. El rango empieza en cero y termina en 287,901 s; Musify comprobó decodificación, salto al 80 % y reproducción del tramo final hasta `ended`. La captura tardó 323,6 s, incluida la espera inicial. Los cuatro controles MSE también pasaron. El mismo informe conserva un fallo de AAC (`nV-F1WSpJIA`): agotó 120 s en estado anuncio antes de comenzar la canción; la batería conjunta sigue marcada como fallida. No se interpreta el contador de segmentos publicitarios recibidos por Rust como una medida de los anuncios vistos en YouTube.

**AAC real comprobado:** `result-20261006-222415.json` pasó los cuatro controles MSE y la captura de «Sucede» (`nV-F1WSpJIA`). Conservó 3.034.789 bytes y 8.069 frames, con cobertura 0..187,333333 s, decodificación, salto al 80 % y final correcto en Musify. Tardó 209,2 s, tras un anuncio inicial de aproximadamente veinte segundos. Se aplicaron el desplazamiento y la ventana originales; no se reescribieron los paquetes. El ensayo anterior, `result-20261006-221856.json`, permanece como fallo del antiguo control de duración de la cabecera MP4.

Comprobaciones automáticas actuales: 115 pruebas JavaScript y 41 Rust pasan; 12 pruebas Rust de integración con red/datos locales permanecen ignoradas. TypeScript/Svelte no informa de errores ni avisos. La compilación de la aplicación de prueba también pasa. Las regresiones incluyen selección durante precarga, promoción de su prioridad, cancelación de resoluciones antiguas, rechazo de finales sintéticos, espera acotada de anuncios y fin de los reintentos cuando una caché incompleta no mejora. Los errores de selección se muestran dentro del diálogo y los ensayos cancelan cualquier carga pendiente antes de restaurar el volumen.

**Límite de la evidencia:** los tests controlan transiciones, tiempos y protocolo; no demuestran por sí solos ausencia de anuncios reales. El ID, título y URL pueden describir la canción pendiente durante un anuncio. Si YouTube modifica las señales de anuncios, el adaptador podría clasificar mal una fuente aunque sus tiempos sean correctos. Las comprobaciones del contenedor no resuelven esa identidad semántica. Tampoco se compara con una grabación canónica: si el reproductor oficial entregase una versión acortada con EOF válido, la captura completa de esa fuente no demostraría que contiene la obra entera. Por ello la fase 1 permanece abierta hasta verificar suficientes sesiones reales con anuncios al principio, durante la canción y con precarga.

Pendientes de ese criterio: promoción a motor principal, selección automática de resultados del sitio oficial, captura progresiva de baja latencia, descarga desde esta captura, recuperación automática de versiones de adaptador y portabilidad. Las descargas siguen utilizando su ruta existente de yt-dlp. No se considera terminada la independencia completa de las API de YouTube.

## Arquitectura objetivo

```text
Canción de la biblioteca → ID de vídeo
                              ↓
              Navegador con reproductor oficial
                              ↓
                Observación de audio y tiempo
                              ↓
             Clasificación y retención temporal
                 canción / anuncio / desconocido
                              ↓
               Audio de la canción → Musify
```

La ruta principal no construirá peticiones a InnerTube, imitará clientes como VISIONOS, interpretará `adaptiveFormats` ni descifrará firmas o tokens. El navegador oficial sí hará las peticiones que necesite: el desacoplamiento consiste en que nuestro código no conozca su contrato.

El motor tendrá cuatro piezas con responsabilidades separadas:

| Pieza | Responsabilidad |
|---|---|
| Captura del navegador | Observar fuentes y buffers mediante interfaces web, conservar formato y tiempos, y detectar capacidades. Sin selectores de YouTube. |
| Adaptador YouTube | Abrir el contenido, identificar canción y anuncios, gestionar consentimiento y detectar cuándo hace falta interacción. Concentrar aquí las dependencias del sitio. |
| Supervisor en Rust | Dar prioridad a la canción actual, gestionar una sesión activa, limitar recursos, cancelar trabajos y recuperar fallos. |
| Consumidor de audio | Reproducir únicamente rangos confirmados de canción, gestionar huecos, cambios de formato y saltos. |

El punto de partida es `src-tauri/src/capture.js`, `src-tauri/src/capture.rs` y `src/lib/extractor/capture.ts`. Los motores de API directa se conservan para comparación y uso opcional durante la transición; no serán necesarios para superar las pruebas de la nueva ruta.

## Fase 1 Demostrar la separación de canción y anuncios

Esta fase decide la viabilidad antes de integrar o acelerar nada.

1. Instrumentar el reproductor oficial a velocidad normal y registrar documentos, fuentes, buffers, formatos, tiempos multimedia y cambios de contenido. Probar sesiones sin anuncios, anuncios al principio y durante la reproducción, y contenido que llega antes de comenzar a sonar.
2. Preparar un reproductor de prueba local con audio identificable y secuencias controladas de anuncio y canción. Permitir que ambos precarguen datos y que reutilicen el mismo elemento multimedia.
3. Correlacionar cada rango de audio con su fuente, sesión y línea temporal. Comparar la clasificación con la referencia controlada y revisar las transiciones en YouTube real.
4. Introducir tres estados: canción confirmada, anuncio confirmado y desconocido. El estado desconocido retiene datos durante un tiempo y con una memoria limitados; no se entrega como canción ni se reclasifica por una suposición.
5. Conservar los segmentos de inicialización necesarios. Rechazar todos los primeros bloques desconocidos sin analizarlos puede hacer que la canción deje de decodificarse.

**Precaución técnica concreta:** el vídeo que aparece como actual en el momento de `appendBuffer` no identifica necesariamente los bytes añadidos. El reproductor puede estar precargando la canción mientras suena un anuncio. La URL de la página, un ID aislado o la duración tampoco bastan como prueba de identidad.

**Criterio para avanzar:** en el banco controlado, todos los rangos entregados pertenecen a la canción, se conserva su principio y final y no quedan huecos. En los casos reales, registrar por separado clasificaciones confirmadas, ambiguas y fallidas. Si no se puede establecer la correspondencia entre contenido y bytes, mantener esta fase abierta y evaluar otra fuente de observación antes de convertir el prototipo en motor principal.

## Fase 2 Separar la captura genérica del adaptador

Extraer de `capture.js` las referencias a `#movie_player`, métodos internos, selectores y textos. El núcleo usará los eventos y propiedades multimedia estándar donde sean suficientes. Las señales específicas de YouTube se contrastarán en el adaptador y podrán sustituirse sin cambiar el núcleo.

Definir un protocolo versionado entre JavaScript, Rust y la interfaz. Cada mensaje incluirá la generación de la petición, la sesión de captura, la fuente y una secuencia. Los segmentos conservarán su MIME, inicialización, discontinuidades y los ajustes de tiempo aplicables. Rechazar mensajes de sesiones canceladas o ventanas antiguas.

Detectar las rutas disponibles en ejecución:

- MSE con audio separado: primera ruta que se implementará y verificará.
- Cambios de códec o de `SourceBuffer`: conservar la información necesaria para reconstruir el audio.
- MSE en workers, buffers con audio y vídeo juntos y reproducción nativa de HLS: experimentos independientes con resultado explícito. No asumir que pasan por el mismo interceptor.
- Rutas que no se pueden copiar: informar de la capacidad que falta, sin confundirla con un vídeo borrado. Una posible captura del audio decodificado del proceso se evaluaría en un prototipo aparte, midiendo calidad, aislamiento y tiempo real; no se dará por disponible de antemano.

No fundamentar la compatibilidad en alterar `canConstructInDedicatedWorker` para obligar a YouTube a usar otra implementación. Esa técnica solo podrá mantenerse como compatibilidad temporal documentada.

**Criterio para avanzar:** el núcleo reproduce el banco local sin código de YouTube; cambiar selectores o métodos del adaptador no obliga a modificar captura, supervisor o consumidor.

## Fase 3 Hacer recuperable toda la sesión

Sustituir las aperturas independientes de ventanas por un controlador único con estados explícitos: apertura, consentimiento, espera de contenido, captura, recuperación, interacción necesaria, finalización y error.

- Dar prioridad a la canción que se escucha. Cancelar o suspender precargas antiguas y agrupar peticiones del mismo vídeo.
- Serializar creación, navegación y cierre. Una generación identifica qué operación puede modificar el estado actual.
- Vigilar por separado que la página responda, que avance la reproducción y que lleguen datos útiles. Un latido de JavaScript por sí solo no demuestra progreso.
- Aplicar reintentos acotados y tiempo máximo por estado. Al agotarlos, liberar la ventana y devolver un error concreto.
- Recuperar desde un punto validado, conservando los datos reutilizables y evitando duplicados o discontinuidades.
- Permitir mostrar la sesión del navegador cuando sea necesaria una acción del usuario y continuar después.
- Distinguir errores de red, identificación, formato, autenticación y contenido no disponible. Un fallo temporal no borra el vídeo elegido ni reemplaza una elección manual.

**Criterio para avanzar:** cambios rápidos de canción, red interrumpida y caída de la ventana no dejan procesos sin seguimiento, audio de otra canción ni esperas indefinidas.

## Fase 4 Integrar la reproducción y los saltos

El consumidor de `capture.ts` mantendrá un mapa de rangos disponibles. Finalizar una tanda de captura no equivale a terminar para siempre el lector: saltar hacia atrás a un hueco o a una zona expulsada de memoria debe reactivar la lectura.

La salida de Musify incluirá solo rangos confirmados de canción. El reproductor oficial podrá pasar un anuncio o usar su botón de salto cuando esté disponible; esos datos no se incorporarán a la canción. Esperar al anuncio puede aumentar la demora inicial, y el estado mostrado al usuario distinguirá esa espera de un fallo.

Cambiar la selección del motor propio para que la captura oficial sea la ruta principal cuando supere los criterios anteriores. Mantener archivos locales, cola, pausa, volumen, teclas multimedia e historial. Probar por separado descargas y evitar marcar una captura parcial como archivo completo.

**Criterio para avanzar:** reproducción completa, anuncio intermedio, pausas, repetición y saltos hacia delante y atrás conservan la canción correcta y su posición, sin filtrar anuncios ni perder fragmentos.

## Fase 5 Desacoplar también la búsqueda

`youtube.rs` consulta actualmente la API interna de YouTube Music. Aunque la captura sobreviva a un cambio, esa dependencia todavía puede impedir encontrar una canción nueva.

Separar búsqueda y reproducción: un ID guardado o elegido por el usuario debe reproducirse sin hacer búsquedas ni resolver una URL multimedia externa. La búsqueda interna existente podrá seguir como optimización opcional.

Preparar una ruta alternativa mediante la búsqueda del sitio oficial, con sus dependencias dentro del adaptador, y conservar las asociaciones verificadas. Si esa automatización no puede identificar el resultado con suficiente confianza, permitir elegir el vídeo en el navegador o pegar su enlace y recordar la elección. El resultado debe ser utilizable por el capturador sin pasar por yt-dlp ni youtubei.js.

**Criterio para avanzar:** desactivar los clientes internos propios no impide reproducir canciones guardadas ni incorporar una canción nueva mediante la ruta oficial. Medir también el porcentaje de búsquedas que requieren intervención.

## Fase 6 Probar resistencia a cambios y consumo

Crear dos bancos complementarios: escenarios deterministas para fallos y transiciones, y una batería real con IDs fijos y condiciones registradas. Las pruebas reales dependerán de la disponibilidad de contenido; los fallos no se ocultarán retirando canciones de la muestra.

| Cambio o fallo simulado | Resultado exigido |
|---|---|
| Respuestas incompatibles de los clientes API de Musify | La captura oficial sigue funcionando sin invocar esos clientes. No se bloquea la red del reproductor oficial. |
| DOM distinto o identidad ausente | Estado desconocido y recuperación acotada; ningún bloque ambiguo se entrega como canción. |
| Canción precargada durante un anuncio | Conservación del inicio y clasificación correcta por fuente y tiempo. |
| Anuncio a mitad y posterior reanudación | Ningún audio publicitario en la salida; continuidad de la canción. |
| Mensaje tardío de una ventana cerrada | Se descarta por generación. |
| Página viva sin avance de audio | El supervisor detecta el atasco y recupera o termina con error. |
| Nuevo formato, worker o ruta no soportada | Selección de una ruta comprobada o error de capacidad explícito. |
| Final de captura seguido de salto a un hueco | Se reanuda la captura y el consumidor incorpora los nuevos datos. |
| Fallo temporal con fuente elegida a mano | La elección manual permanece intacta. |

Registrar por separado: extracción disponible, canción identificada, inicio de reproducción, saltos, cobertura completa, anuncios descartados, segmentos ambiguos, intervención del usuario y recuperación. Un `ok` global solo será verdadero si pasan todas las comprobaciones solicitadas.

Medir p50 y p95 de clic a sonido y de salto, desglosando espera de anuncio, carga y captura; medir también CPU, memoria máxima y ventanas activas. Optimizar primero precarga y reutilización de datos. Evaluar después la aceleración de captura, conservándola solo si no introduce cortes, errores de clasificación ni más recuperaciones.

**Criterio de publicación:** cero anuncios filtrados y cero pérdidas de contenido en el banco controlado; cero sesiones abandonadas en las pruebas de estrés; informe explícito de éxito y fallos de la batería real. Fijar los presupuestos de latencia y recursos tras medir la primera versión funcional, sin reutilizar las cifras del extractor nativo como expectativa de la captura oficial.

## Fase 7 Desplegar y ampliar plataformas

Aprovechar el trabajo en curso de extractores firmados y versionados para actualizar el adaptador cuando haga falta. Añadir comprobación de funcionamiento, conservación de la última versión válida y vuelta atrás tras fallos repetidos atribuibles a una nueva versión. Una desconexión aislada no debe desactivar una versión buena. No cambiar el código que gobierna una captura ya iniciada a mitad de canción.

Probar primero con el motor seleccionable y promoverlo a predeterminado después de la batería completa. Renombrar el antiguo nivel «garantizado» como «captura oficial» y actualizar la documentación para separar mediciones históricas y comportamiento nuevo.

Extender posteriormente el puente a Mac y Linux, y después a Android e iOS. Cada plataforma debe demostrar sus capacidades multimedia, aislamiento y comportamiento en segundo plano antes de anunciar compatibilidad.

## Orden de implementación

1. Instrumentación y prueba de separación entre canción y anuncios.
2. Núcleo genérico, adaptador y protocolo de sesiones.
3. Supervisor y consumidor recuperables.
4. Integración como ruta principal y búsqueda alternativa.
5. Batería de cambios, optimización, despliegue gradual y portabilidad.

El primer entregable será una prueba reproducible que capture una canción completa sin anuncios usando únicamente el reproductor oficial, con los clientes internos de Musify desactivados. La separación entre contenido y datos debe quedar demostrada antes de invertir en velocidad o ampliar plataformas.

## Referencias técnicas

Los eventos y propiedades de los elementos multimedia se definen en el [estándar HTML](https://html.spec.whatwg.org/multipage/media.html). Los buffers y la construcción de Media Source en workers se describen en [Media Source Extensions](https://www.w3.org/TR/media-source/). Estos contratos son la base del núcleo genérico, sin asumir que todas las rutas de reproducción pasan por ellos.

La [API oficial del reproductor de YouTube](https://developers.google.com/youtube/iframe_api_reference) documenta controles para reproductores incrustados; acceder a métodos parecidos dentro de la página de YouTube Music no convierte ese acceso en un contrato público ni proporciona por sí mismo una API de extracción o identificación de anuncios.
