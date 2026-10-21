# Pletina PWA: port de la APK 0.11.2

La referencia es la APK **0.11.2**, commit nativo `4b5691ff50d659fbd048f5a9cff1ddfa91c22a79`. Se reutilizan sus componentes Svelte y pantallas, sustituyendo los comandos de Rust y Android por adaptadores web. La [matriz de paridad](pwa-parity-0.11.2.md) distingue lo comprobado y las diferencias pendientes. El [informe del primer port](pwa-port-0.11.2.md) es histórico y describe una fase anterior.

Dirección: **https://diad87.github.io/pletina/**. GitHub Pages distribuye archivos estáticos. El catálogo y el audio se consultan directamente desde el navegador, sin backend propio, proxy ni microservidor en el móvil. La entrada pequeña muestra **Instalar** y prepara la aplicación completa al pulsar **Abrir Pletina**.

**Publicado y verificado: `fbb03046132d7478`**, código de producto `6a586c1` y runner `3108698`, commit de distribución `9760e5621d5bea66f0e28bd2c6ece184a2799806`. Pasan **355/355 pruebas de lógica, incluidas 33 de navegación**, tipos con **0 errores y 0 avisos** y compilaciones nativa y PWA. Los [22/22 archivos públicos coinciden por HTTP y SHA-256](../artifacts/pwa-deploy/public-files-fbb03046132d7478.json) y la [canción solicitada reproduce desde Pages, 3/3](../artifacts/pwa-port/browser-public-fbb03046132d7478.json). La entrada tiene **41.790 bytes** y la aplicación bajo demanda **469.984**, sin comprimir.

La [matriz E2E de esta release](../artifacts/pwa-e2e/coverage-fbb03046132d7478.md) reúne **193 comprobaciones correctas, 0 fallos, 0 bloqueadas y 5 no compatibles con el entorno**, de 198: Chrome 64 correctas, Firefox 65 y WebKit Linux 64. Son tres recorridos completos con diseños móviles y respuestas de proveedores controladas, usando aplicación, almacenamiento, worker y audio reales. El [mapa de funciones](pwa-e2e-function-map.md) detalla acciones y huecos. La [actualización A→B pasa 11/11](../artifacts/pwa-port/update-e2e-fbb03046132d7478.json), incluido el instalador que nunca había abierto la aplicación. El [resumen de validación](../artifacts/pwa-e2e/validation-fbb03046132d7478.json) conserva builds y límites. La [matriz anterior de `fb6f83d340d7857a`, 169/174](../artifacts/pwa-e2e/coverage-fb6f83d340d7857a.md), permanece histórica; ninguna sustituye las pruebas físicas.

Los ocho casos añadidos cubren cancelar y abandonar una importación pendiente, rollback/reintento de un guardado CSV, cambio de fuente mientras suena, radio con fallo parcial, cancelar el borrado de todas las descargas y dos recorridos de teclado/errores accesibles. La navegación tiene nombre y destino actual accesibles; la entrada de fuente asocia su error y limpia el estado inválido al editar. No se declara una auditoría completa de accesibilidad ni una prueba de lectores de pantalla físicos.

El cambio actual recupera las cuatro pestañas **Inicio, Buscar, Podcasts y Tu biblioteca**, la importación CSV, los podcasts RSS y YouTube, las descargas y el registro de audio compartible. También se adaptan la restauración de cola, el botón Atrás y el tamaño del viewport al reabrir. **No se declara paridad total:** la importación Spotify por URL sigue bloqueada y falta probar físicamente iPhone.

## Compilar

Trabajar en el checkout del port, no en un checkout antiguo de la app nativa:

```sh
npm run check
npm test
npm run build:pwa
```

`build:pwa` compila `web-port/`, incorpora la aplicación a `dist-pwa/application/` y genera la entrada, el worker y la prueba de audio independiente. La compilación nativa sigue con `npm run build`. No publicar ejecutando `scripts/build-pwa.mjs` directamente: es el constructor interno de la entrada mínima y no incorpora el port sin recibir la aplicación.

`npm run preview:pwa` sirve una previsualización estática en el ordenador; no forma parte de la app instalada. Abrir con `file://` no permite instalar ni actualizar una PWA. `dist-pwa-portable/Pletina.html` sigue siendo el antiguo Hola mundo autónomo, sin la aplicación musical.

## Instalar y actualizar

1. Abrir la dirección publicada con Chrome en Android o Safari en iPhone/iPad.
2. Pulsar **Instalar**. Android presenta el aviso nativo cuando está disponible y, en caso contrario, los pasos del menú.
3. En iOS, seguir **Compartir → Añadir a pantalla de inicio** y confirmar.
4. Abrir el icono con conexión y pulsar **Abrir Pletina**.
5. Para actualizar una instalación anterior, usar **Actualizar y abrir** en la entrada o **Actualizar** en el aviso de la aplicación.

Se mantienen dirección, identidad y scope. Antes de activar una actualización, el worker prepara y verifica los SHA-256 de toda la aplicación. Si falla, conserva la versión anterior. Actualizar recarga e interrumpe el audio actual; conserva biblioteca y descargas. Comprueba versiones al abrir, recuperar conexión o volver a la app, sin ejecutarse mientras está cerrada. Los nombres de las opciones de instalación dependen del navegador: [Chrome](https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DAndroid&hl=es), [Apple](https://support.apple.com/guide/iphone/iphea86e5236/ios).

Si solo se había instalado la entrada mínima A y B ya está esperando, el botón explícito **Actualizar y abrir** prepara B antes de activar su worker; no intenta descargar el launcher retirado de A. Un fallo conserva la caché activa de A y habilita reintento. Reabrir automáticamente una aplicación guardada no consiente otra actualización: abre la versión activa sin preparar ni activar la que espera. Los clics se bloquean durante la preparación.

Las entradas antiguas conservan su JavaScript antiguo: este cambio no las parchea retroactivamente. Si su primer botón no abre la aplicación, usar una vez el botón secundario **Actualizar y abrir** y, al cargar la entrada nueva, **Abrir Pletina**. El control de compatibilidad usa una entrada d0 de QA, nunca publicada, y no demuestra migración del acceso desde un icono del sistema. Se conservan los [controles negativos del launcher antiguo](../artifacts/pwa-port/update-cold-negative-readywait-d0e466bf9a8d978a.json) y de [activación automática de `384c351ffd4fbd4e`](../artifacts/pwa-port/update-bootstrap-negative-autoopen-384c351ffd4fbd4e.json). Las aserciones incluyen ausencia de archivos opcionales en la caché mínima, conservación de A en fallo y preparación íntegra de B antes de activar.

## Atrás en la aplicación instalada

La protección de navegación introducida en **`4c2aaa1c19512425`** mantiene la misma página y el audio al usar Atrás desde Inicio en modo instalado. Atrás cierra primero el panel superior: Cola, Sonando ahora o menú, antes de recorrer las pantallas. Si queda otro panel, reutiliza su entrada de historial; no recarga ni crea otra entrada al gestionar ese Atrás. Una pestaña normal conserva su comportamiento habitual y puede abandonar el sitio desde la raíz.

El [recorrido integrado de fbb en Chrome standalone y su control de pestaña normal](../artifacts/pwa-e2e/back-root-library-fbb03046132d7478/summary.json) pasa **32/32**: incluye 22 casos de biblioteca y 10 comprobaciones de regresión. Atrás mediante la API conserva el mismo documento y Audio; no acredita el botón del sistema. El canal de Atrás UI quedó bloqueado en el control de automatización, fuera de esos 32 aprobados. La repetición física en Xiaomi e iPhone sigue pendiente; esta protección no evita que el sistema termine el proceso.

La regresión histórica de `4c2aaa1c19512425` conserva sus [42/42 en pestañas normales](../artifacts/pwa-e2e/back-root-4c2aaa1c19512425-library/summary.json) y [2/2 del menú de playlist](../artifacts/pwa-e2e/back-root-contextual-4c2aaa1c19512425/native-app-window/report.json). No se renombran como fbb ni se suman como funciones únicas a sus recorridos actuales.

## Catálogo, biblioteca y podcasts

Deezer proporciona canciones, discos, artistas, duración y carátulas mediante JSONP aislado. YouTube aporta audio MP4 seleccionado por comparación de metadatos, con selección manual alternativa. No se usa un proxy ni se ejecuta JavaScript remoto para descifrar fuentes.

Favoritos, discos, artistas, playlists, historial, canciones de YouTube, fuentes elegidas, programas y progreso de episodios se guardan en IndexedDB. La versión 2 migra los datos anteriores. Los IDs de programa y episodio permanecen estables para el mismo feed y GUID. La biblioteca web es independiente de la APK y de otros dispositivos.

Podcasts conserva búsqueda y filtros. Los programas RSS se descubren en Apple y se leen directamente desde el feed. Si el proveedor bloquea esa lectura se intenta la lista pública de episodios de Apple; algunos proveedores seguirán sin permitir acceso. El idioma procede del RSS, sin inferirlo del país. YouTube conserva búsqueda y páginas de episodios con continuaciones.

El reproductor mantiene cola y cola DJ, anterior/siguiente, avance, aleatorio, repetición, temporizador y Media Session. Conserva la cola y su posición sin guardar fuentes temporales de audio; al reabrir restaura pausado y obtiene una fuente al pulsar reproducir. **Enviar registro** comparte o descarga un JSON local acotado de estados, sin títulos ni URLs.

La corrección web de reanudación reconoce dos muestras de avance decodificado cuando WebKit reproduce pero deja pendiente la promesa nativa de `play()` y no emite `playing`. La [prueba dirigida en WebKit/WPE de Linux](../artifacts/pwa-e2e/resume-fixed-fb6f83d340d7857a/report.json) registra cinco reanudaciones con avance real y estado de reproducción correcto. No es una prueba de Safari en un iPhone.

Los proveedores no tienen disponibilidad garantizada. Un [intento local histórico de `fb6f83d340d7857a`](../artifacts/pwa-port/browser-local-e2e-user-song-fb6f83d340d7857a.json) encontró la canción, pero sus peticiones multimedia fueron bloqueadas por ORB antes de decodificar. Se conserva ese fallo; el [control HTTPS con una versión anterior](../artifacts/pwa-port/browser-public-provider-control-ee394d368c27123e.json) y la [prueba pública de `fb6f83d340d7857a`](../artifacts/pwa-port/browser-public-e2e-user-song-fb6f83d340d7857a.json) sí reprodujeron la canción. No se extrapola ese resultado a todo el catálogo.

## Importación

CSV conserva lectura, matching real, pausa/reintento, revisión y guardado, con duplicados y orden. Aplica las reglas nativas de delimitadores, comillas, 10 MB y 10.000 filas.

**Spotify por URL: diferencia pendiente.** Chrome rechaza la lectura del embed por CORS. oEmbed proporciona título e iframe, sin canciones; la API sin token responde 401 y la API del iframe no ofrece la lista de pistas. La interfaz informa y permite CSV. No se inventan datos ni se incorpora un intermediario. [Evidencia del navegador](../artifacts/pwa-port/imports-browser.json).

La importación de carpetas es de escritorio y tampoco está disponible en la interfaz móvil de la APK.

## Descargas y funcionamiento sin conexión

CacheStorage guarda el audio completo, separado de la caché versionada de la aplicación. IndexedDB `pletina-web-downloads` conserva sus metadatos. El worker sirve rutas locales `__audio__/<id>`. Antes de confirmar una descarga se valida que el audio guardado puede decodificarse. Si falla red, cuota, validación o escritura, no se marca como terminada. La cola es serial; cancelar elimina las pendientes y permite acabar la actual.

Las URLs temporales de YouTube no se guardan como campos de IndexedDB ni del snapshot de cola. La respuesta opaca del navegador puede retener internamente su URL de origen. La reproducción descargada usa una ruta local estable sin renovar fuentes remotas.

Tras la primera apertura completa, interfaz y datos locales pueden abrirse sin red. Buscar contenido nuevo o escuchar audio no descargado necesita conexión. Borrar los datos del sitio elimina biblioteca y audio. El servicio nativo Android de descargas no existe en una web; no se ha comprobado que las descargas en curso terminen con la PWA cerrada.

## Pantalla apagada y plataformas

El usuario confirmó en Xiaomi 15T Pro continuidad y cambio de canción con pantalla apagada en la prueba y el reproductor básico anteriores. En el primer port completo informó continuidad sin siguiente canción. La corrección posterior prepara la siguiente fuente en RAM y cambia el audio dentro del evento de fin, sin esperar a IndexedDB ni vaciarlo. Pasó en escritorio con pestaña oculta; el usuario indicó después que pasó a la siguiente, sin precisar bloqueo o build.

No se da por cerrada la incidencia física. La [transición histórica de `fb6f83d340d7857a`, 2/2](../artifacts/pwa-port/transition-e2e-fb6f83d340d7857a.json), pasa de Creep a Million Dollar Question con la pestaña oculta y el mismo Audio; es escritorio, sin bloqueo físico de pantalla. Historial: [pantalla apagada](pwa-screen-off-results.md), [reproductor inicial](pwa-player-results.md), [primer port](pwa-port-0.11.2.md). **La repetición en Xiaomi con el build identificado e iPhone/iPad siguen pendientes.** Android Auto y CarPlay no están implementados en esta distribución PWA.

## Publicación

La [batería E2E y sus límites por plataforma](pwa-platform-testing.md) distingue pruebas de navegador, teléfonos y coches. La distribución PWA no proporciona las integraciones nativas de Android Auto y CarPlay. El [protocolo físico](pwa-physical-e2e.md) conserva las comprobaciones pendientes.

El mecanismo activo es Pages desde **`gh-pages`**, ruta `/`. `scripts/publish-pwa.mjs` publica solo `dist-pwa/`, comprueba el estado remoto conocido y actualiza sin forzar la rama; admite `--dry-run`. `scripts/verify-pwa-deploy.mjs` compara HTTP y SHA-256 de todos los archivos y conserva informes por hash en `artifacts/pwa-deploy/`.

El workflow `.github/workflows/pwa.yml` está preparado pero no activo. No se han cambiado los ajustes de Pages. Los commits de distribución son distintos de la base nativa y de los commits del código del port.
