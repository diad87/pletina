# Pletina PWA: port de la APK 0.11.2

La referencia es la APK **0.11.2**, commit nativo `4b5691ff50d659fbd048f5a9cff1ddfa91c22a79`. Se reutilizan sus componentes Svelte y pantallas, sustituyendo los comandos de Rust y Android por adaptadores web. La [matriz de paridad](pwa-parity-0.11.2.md) distingue lo comprobado y las diferencias pendientes. El [informe del primer port](pwa-port-0.11.2.md) es histórico y describe una fase anterior.

Dirección: **https://diad87.github.io/pletina/**. GitHub Pages distribuye archivos estáticos. El catálogo y el audio se consultan directamente desde el navegador, sin backend propio, proxy ni microservidor en el móvil. La entrada pequeña muestra **Instalar** y prepara la aplicación completa al pulsar **Abrir Pletina**.

**Publicado y verificado: `fb6f83d340d7857a`**, código `0086a25`, commit de distribución `0ad01788b2a9a0dea12ae4c65f20bab87a9ee65a`. Pasan **333/333 pruebas**, tipos con **0 errores y 0 avisos**, compilaciones nativa y PWA y auditoría de dependencias con **0 vulnerabilidades**. Los [22/22 archivos públicos coinciden por HTTP y SHA-256](../artifacts/pwa-deploy/public-files-fb6f83d340d7857a.json). La entrada tiene **38.720 bytes** y la aplicación bajo demanda **466.906**, sin comprimir.

La [matriz E2E de esta versión](../artifacts/pwa-e2e/coverage-fb6f83d340d7857a.md) reúne **169 comprobaciones correctas, 0 fallos, 0 bloqueadas y 5 no compatibles con el entorno**, de 174: Chrome 56 correctas, Firefox 57 y WebKit 56. Son navegadores de escritorio con diseños móviles y respuestas de proveedores controladas, usando la aplicación, almacenamiento, worker y audio reales. El [mapa de funciones](pwa-e2e-function-map.md) detalla acciones y huecos. Además pasan la [actualización A→B, 7/7](../artifacts/pwa-port/update-e2e-fb6f83d340d7857a.json), y la [reproducción pública de la canción solicitada, 3/3](../artifacts/pwa-port/browser-public-e2e-user-song-fb6f83d340d7857a.json). Estos resultados no sustituyen las pruebas físicas pendientes.

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

## Catálogo, biblioteca y podcasts

Deezer proporciona canciones, discos, artistas, duración y carátulas mediante JSONP aislado. YouTube aporta audio MP4 seleccionado por comparación de metadatos, con selección manual alternativa. No se usa un proxy ni se ejecuta JavaScript remoto para descifrar fuentes.

Favoritos, discos, artistas, playlists, historial, canciones de YouTube, fuentes elegidas, programas y progreso de episodios se guardan en IndexedDB. La versión 2 migra los datos anteriores. Los IDs de programa y episodio permanecen estables para el mismo feed y GUID. La biblioteca web es independiente de la APK y de otros dispositivos.

Podcasts conserva búsqueda y filtros. Los programas RSS se descubren en Apple y se leen directamente desde el feed. Si el proveedor bloquea esa lectura se intenta la lista pública de episodios de Apple; algunos proveedores seguirán sin permitir acceso. El idioma procede del RSS, sin inferirlo del país. YouTube conserva búsqueda y páginas de episodios con continuaciones.

El reproductor mantiene cola y cola DJ, anterior/siguiente, avance, aleatorio, repetición, temporizador y Media Session. Conserva la cola y su posición sin guardar fuentes temporales de audio; al reabrir restaura pausado y obtiene una fuente al pulsar reproducir. **Enviar registro** comparte o descarga un JSON local acotado de estados, sin títulos ni URLs.

La corrección web de reanudación reconoce dos muestras de avance decodificado cuando WebKit reproduce pero deja pendiente la promesa nativa de `play()` y no emite `playing`. La [prueba dirigida en WebKit/WPE de Linux](../artifacts/pwa-e2e/resume-fixed-fb6f83d340d7857a/report.json) registra cinco reanudaciones con avance real y estado de reproducción correcto. No es una prueba de Safari en un iPhone.

Los proveedores no tienen disponibilidad garantizada. Un [intento local de esta versión](../artifacts/pwa-port/browser-local-e2e-user-song-fb6f83d340d7857a.json) encontró la canción, pero sus peticiones multimedia fueron bloqueadas por ORB antes de decodificar. Se conserva ese fallo; el [control HTTPS recién ejecutado con la versión anterior](../artifacts/pwa-port/browser-public-provider-control-ee394d368c27123e.json) y la [prueba pública actual](../artifacts/pwa-port/browser-public-e2e-user-song-fb6f83d340d7857a.json) sí reprodujeron la canción. No se extrapola ese resultado a todo el catálogo.

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

No se da por cerrada la incidencia física. La [transición de esta versión, 2/2](../artifacts/pwa-port/transition-e2e-fb6f83d340d7857a.json), pasa de Creep a Million Dollar Question con la pestaña oculta y el mismo Audio; es escritorio, sin bloqueo físico de pantalla. Historial: [pantalla apagada](pwa-screen-off-results.md), [reproductor inicial](pwa-player-results.md), [primer port](pwa-port-0.11.2.md). **La repetición en Xiaomi con el build identificado e iPhone/iPad siguen pendientes.** Android Auto y CarPlay no están implementados en esta distribución PWA.

## Publicación

La [batería E2E y sus límites por plataforma](pwa-platform-testing.md) distingue pruebas de navegador, teléfonos y coches. La distribución PWA no proporciona las integraciones nativas de Android Auto y CarPlay. El [protocolo físico](pwa-physical-e2e.md) conserva las comprobaciones pendientes.

El mecanismo activo es Pages desde **`gh-pages`**, ruta `/`. `scripts/publish-pwa.mjs` publica solo `dist-pwa/`, comprueba el estado remoto conocido y actualiza sin forzar la rama; admite `--dry-run`. `scripts/verify-pwa-deploy.mjs` compara HTTP y SHA-256 de todos los archivos y conserva informes por hash en `artifacts/pwa-deploy/`.

El workflow `.github/workflows/pwa.yml` está preparado pero no activo. No se han cambiado los ajustes de Pages. Los commits de distribución son distintos de la base nativa y de los commits del código del port.
