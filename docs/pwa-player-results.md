# Primer reproductor web de Pletina

> Informe histórico del reproductor básico anterior. El estado del port de la app 0.11.2 está en [su informe](pwa-port-0.11.2.md). La prueba física de Xiaomi descrita aquí no corresponde al port nuevo. Las rutas de artefactos antiguos documentan el entorno original; no todas están copiadas a este worktree.

18 de octubre de 2026. Build `85d3cde632c1480f`.

La instalación mínima conserva su manifiesto, dirección y ámbito. El reproductor
se abre desde **Abrir reproductor**, tanto en el navegador como en la aplicación
instalada. Sus dos módulos se publican con nombres que incluyen el hash final de
su contenido y se descargan únicamente cuando se abre esa función. El audio se
resuelve directamente desde el navegador; GitHub Pages sirve archivos estáticos.

- Entrada inicial: **34.344 bytes** sin comprimir, incluidos los archivos que
  prepara el service worker.
- Módulos opcionales de reproducción: **20.960 bytes** sin comprimir.
- Una cola de enlaces o IDs de YouTube, títulos y autor, reproducción/pausa,
  anterior/siguiente, detener y posición de reproducción.
- El siguiente audio se obtiene al finalizar el actual. Se usa un único elemento
  de audio y controles Media Session donde están disponibles.
- La biblioteca, las descargas musicales y los sistemas del coche quedan fuera
  de esta primera integración. La caché del código no contiene música.

## Comprobaciones

`npm run test:pwa` pasa **33/33** pruebas de compilación, grafo de módulos, hashes,
caché bajo demanda, rollback, actualización, ámbitos, validación de enlaces y
parsing de cola. La copia portable vuelve a abrir desde un directorio distinto,
sin conexión, sin servidor y sin peticiones HTTP; conserva solo «Hola mundo».

La prueba de Chrome 148 de escritorio pasa **13/13** comprobaciones de navegador:
no solicita módulos del reproductor al instalar, solicita exactamente dos al
abrirlo, los guarda, permite recargar y abrir la interfaz sin red, prepara la cola
y reproduce audio real con `muted: false`. Pausa, detención y resolución de la
siguiente pista con la pestaña oculta también pasan. Se limita la salida de sonido
de Chrome y el caudal multimedia durante QA; no se guarda el audio recibido.

El runner es `scripts/tests/pwa-player.browser.mjs` y el resultado está en
`artifacts/pwa-player/browser.json`. Usa un servidor de archivos temporal en el
ordenador para QA y lo cierra al terminar; no forma parte de la aplicación.
Las capturas con tamaños de Android e iPhone comprueban solo la distribución de
la interfaz en Chrome; no son ejecución de Safari ni teléfonos físicos.

La publicación está activa en <https://diad87.github.io/pletina/>. Se verificaron
por HTTPS los 17 archivos de la distribución completa contra sus SHA-256 locales
(incluida la herramienta diagnóstica separada). Una comprobación adicional de la
web pública verificó cero peticiones de módulos al instalar, los dos módulos al
abrir y la reapertura con el navegador sin red, con respuestas del service worker;
se conserva en `artifacts/pwa-player/public.json`. Al preparar esa comprobación se
corrigió su contador para distinguir peticiones del navegador de descargas de
red: también hay eventos de petición cuando responde la caché.

La primera versión del runner esperaba metadatos antes de pulsar Reproducir y
agotó el tiempo. Se conservó ese informe en
`artifacts/pwa-player/browser-first-metadata-wait.json`. Se corrigió la prueba para
seguir el flujo real: cola preparada, botón habilitado y clic en Reproducir. No
se cambió el producto para obtener ese resultado.

## Comprobación física

El usuario confirmó que el audio continuó y volvió a empezar con la pantalla
apagada en **Xiaomi 15T Pro, desde Chrome**, con la herramienta diagnóstica
independiente. El [registro de pantalla apagada](pwa-screen-off-results.md)
distingue esa observación de la automatización.

Después confirmó **«Funciona instalada y bloqueada»** en la prueba solicitada del
reproductor integrado desde su icono: continuidad y siguiente pista con pantalla
apagada durante dos minutos en el mismo Xiaomi. Se registra como observación
física del usuario, sin JSON diagnóstico ni versión exacta instalada. El build
publicado e indicado para esa prueba era `85d3cde632c1480f`. La confirmación se
limita a ese dispositivo y protocolo; siguen pendientes iPhone, otros modelos y
sesiones largas.
