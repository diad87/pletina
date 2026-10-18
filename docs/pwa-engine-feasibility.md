# Motor web directo: prueba acotada

> Informe histórico de viabilidad. La aplicación actual está documentada en [el port 0.11.2](pwa-port-0.11.2.md). Las demos y sondas iniciales citadas aquí pertenecen al checkout original y no están incluidas en este worktree.

Pruebas iniciales del 18 de octubre de 2026 en Windows, Chrome 148.0.7778.97 y Puppeteer 24.40.0. Perfil nuevo, sin cookies del usuario, extensiones, flags para desactivar seguridad, proxy ni servidor local. En esa fase no se modificó la PWA.

**Resultado: hay una ruta técnica real para investigar reproducción directa sin intermediario.** Desde una página HTTPS, un `iframe sandbox="allow-scripts"` con origen opaco `null` pudo consultar YouTube, obtener una URL de audio y entregarla mediante `postMessage` al padre. Un `<audio>` del padre reprodujo y avanzó después de saltar a mitad del archivo. Las pruebas iniciales de escritorio no validaban Android/iPhone. Posteriormente el usuario confirmó audio y cambio de fuente con pantalla apagada en Xiaomi 15T Pro, primero desde Chrome con la [prueba separada de bloqueo](pwa-screen-off-results.md) y después desde el icono de la PWA con el reproductor integrado; iOS sigue pendiente.

La [demo autónoma](experiments/audio-directo.html) permite pegar un enlace o ID y pulsar **Reproducir**. Otra comprobación independiente en Chrome 146.0.7680.153 abrió el HTML desde `file://`: el audio avanzó hasta 2,008 segundos y después del salto hasta 322,016 segundos, sin errores JavaScript ni de reproducción. Las únicas conexiones HTTPS observadas fueron a YouTube y su CDN de audio `googlevideo.com`; no hubo servidor ni proxy de Pletina.

## Resultados observados

| Prueba | Página HTTPS normal | Archivo `file://` |
|---|---|---|
| Deezer `GET /search/artist?q=radiohead&limit=1` con `fetch` | Bloqueado por CORS | Bloqueado por CORS |
| Mismo Deezer, `output=jsonp&callback=…`, etiqueta `script` | 1 artista legible | 1 artista legible |
| YouTube `GET /sw.js_data` | CORS | CORS |
| YouTube Music `POST /youtubei/v1/search`, JSON y `application/json` | Preflight bloqueado | Preflight bloqueado |
| Búsqueda Music/YouTube, JSON enviado como `text/plain` | CORS | HTTP 200, contenido y `visitorData` legibles |
| Player, JSON enviado como `text/plain` | CORS | JSON legible; requiere preparar sesión anónima |
| `fetch(..., {mode:'no-cors'})` de visitante | Respuesta opaca, cuerpo ilegible | Respuesta opaca, cuerpo ilegible |
| Audio HTTPS público compatible | `fetch` legible y `<audio>` carga | Igual |

El primer player sin `visitorData` devolvió `LOGIN_REQUIRED`/comprobación de bot. Con `visitorData` de la búsqueda anónima, los clientes `VISIONOS` 1.02, `IOS` 20.11.6 y `ANDROID_VR` 1.65.10 devolvieron `OK` y URLs directas de audio para `9RfVp-GhKfs` y `aqz-KE-bpKQ`. `ANDROID` 21.03.36 devolvió formatos, pero sin URL directa de audio en esos casos. No se usaron claves de usuario ni se enviaron cabeceras HTTP `Origin`, `Referer` o `User-Agent` personalizadas.

Una página HTTPS puede crear el mismo origen opaco mediante sandbox; no depende de abrir un archivo. Se verificó lectura real de la búsqueda desde ese frame, no una respuesta opaca. El navegador conserva sus comprobaciones CORS: este resultado depende de que el servidor de destino acepte esa combinación de origen y solicitud. [HTML: sandbox](https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox), [Fetch: respuesta opaca](https://fetch.spec.whatwg.org/#concept-filtered-response-opaque).

## Reproducción reproducible

Ejecutar desde la raíz, con las herramientas de QA ya instaladas:

```powershell
node docs/experiments/pwa-direct-audio-probe.mjs
```

El script admite como argumentos la ruta del paquete Puppeteer y del ejecutable Chrome. Abre `https://example.org/`, crea el frame con `srcdoc`, pide búsqueda y player directamente a YouTube y reproduce en el padre. El código contiene los endpoints, versiones, vídeo y parámetros exactos. `visitorData` y la URL temporal se obtienen en cada ejecución; no se guardan ni imprimen.

Resultado de la ejecución:

```json
{
  "pageOrigin": "https://example.org",
  "frameOrigin": "null",
  "playerStatus": "OK",
  "videoId": "aqz-KE-bpKQ",
  "itag": 140,
  "mime": "audio/mp4; codecs=\"mp4a.40.2\"",
  "bitrate": 131003,
  "contentLength": "10271496",
  "duration": 634.62458,
  "initial": { "from": 0.000151, "to": 3.460074, "advanced": true },
  "afterSeek": { "from": 320.047028, "to": 323.554934, "advanced": true },
  "mediaError": null
}
```

Se observaron dos respuestas HTTP 206 de tipo `media`. El salto a 320 segundos verifica reproducción lejos del comienzo del archivo. Se utilizó reproducción silenciada para la automatización; esto no demuestra autorización de autoplay audible. Una prueba separada de `fetch` con `Range` desde el padre HTTPS falló, aunque el elemento `<audio>` pudo cargar el mismo origen de audio: **streaming multimedia y descarga legible por JavaScript son capacidades distintas**.

## Demo autónoma para abrir

[audio-directo.html](experiments/audio-directo.html) contiene una prueba independiente de un solo archivo, sin librerías externas ni service worker. Se puede abrir directamente desde el explorador de archivos en Chrome de escritorio. Permite pegar un enlace/ID de YouTube y pulsar **Reproducir**; si el navegador exige otro gesto, aparece **Escuchar**. El ejemplo inicial es Big Buck Bunny.

Verificación real de esa demo mediante `file:///C:/Users/iunan/musify/docs/experiments/audio-directo.html`, Chrome 148, perfil nuevo y clic automatizado:

- El audio, **sin silenciar**, avanzó desde el inicio hasta 2,005 segundos.
- Tras saltar a 320 segundos, avanzó a 322,009 segundos, sin error multimedia.
- El frame auxiliar se retiró después de obtener la dirección y no hubo errores de JavaScript.
- Un enlace ajeno a YouTube se rechazó sin hacer nuevas peticiones al motor.

La demo comprueba `event.source` e identificador del mensaje, limita el ID a 11 caracteres válidos y acepta únicamente direcciones de audio HTTPS de `googlevideo.com` o sus subdominios. No ejecuta código recibido de YouTube; las respuestas de la API se leen como JSON. No imprime ni guarda URLs temporales ni tokens. La demo permanece separada; el mismo mecanismo se ha adaptado en `pwa/player/` como módulos bajo demanda que no se descargan en la instalación inicial.

## Alcance y siguiente experimento

Esta evidencia permitió añadir un reproductor web básico con cola y resolución al terminar cada pista. El usuario confirmó continuidad y siguiente pista con pantalla apagada en su Xiaomi, tanto en Chrome como desde la PWA instalada, siguiendo el protocolo solicitado de dos minutos. No demuestra colas largas, renovación tras caducar una URL pausada, cambios Wi-Fi/datos, música offline, Safari ni apertura de HTML mediante Quick Look en iOS. Los endpoints son internos y pueden cambiar.

Hay alternativas directas para funcionalidades parciales: catálogo Deezer por JSONP probado; archivos importados por el usuario; URLs de audio publicadas por proveedores que permiten su uso web; podcasts con audio accesible, comprobando cada fuente. El reproductor iframe oficial de YouTube evita extraer URLs, pero tiene interfaz y requisitos propios, no proporciona las descargas offline de Pletina ni sustituye su reproducción de solo audio en segundo plano. En HTML local puede faltar la identificación `Referer` y aparecer error 153. [API iframe](https://developers.google.com/youtube/iframe_api_reference#onError), [requisitos del reproductor](https://developers.google.com/youtube/terms/required-minimum-functionality), [políticas de reproducción](https://developers.google.com/youtube/terms/developer-policies).

No se propone añadir ningún servidor ni proxy externo. Puppeteer y Chrome son herramientas temporales de comprobación, no dependencias del producto.
