# Pletina PWA: port de la APK 0.11.2

La referencia es la APK **0.11.2**, commit nativo `4b5691ff50d659fbd048f5a9cff1ddfa91c22a79`. Se reutilizan sus componentes Svelte y pantallas, sustituyendo los comandos de Rust y Android por adaptadores web. La [matriz de paridad](pwa-parity-0.11.2.md) distingue lo comprobado y las diferencias pendientes. El [informe del primer port](pwa-port-0.11.2.md) es histórico y describe una fase anterior.

Dirección: **https://diad87.github.io/pletina/**. GitHub Pages distribuye archivos estáticos. El catálogo y el audio se consultan directamente desde el navegador, sin backend propio, proxy ni microservidor en el móvil. La entrada pequeña muestra **Instalar** y prepara la aplicación completa al pulsar **Abrir Pletina**.

**Publicado y verificado: `92345453b622660a`**, código de producto `7da533f` y runner final `d989a10`, commit de distribución `33bffb339b59db5be991c7295d6a779c4ed5958e`. Pasan **392/392 pruebas de lógica, incluidas 45 de navegación**, tipos con **0 errores y 0 avisos** y compilaciones del frontend nativo y de la PWA. Los [22/22 archivos públicos coinciden por HTTP y SHA-256](../artifacts/pwa-deploy/public-files-92345453b622660a.json) y la [canción solicitada reproduce desde Pages, 3/3](../artifacts/pwa-port/browser-public-92345453b622660a.json). La entrada tiene **41.790 bytes** y la aplicación bajo demanda **473.210**, sin comprimir.

La [matriz E2E actual](../artifacts/pwa-e2e/coverage-92345453b622660a.md) reúne **205 correctas, 0 fallidas, 0 bloqueadas y 5 no compatibles de 210**: Chrome 68, Firefox 69 y WebKit Linux 68 correctas. Los [informes Windows](../artifacts/pwa-e2e/release-92345453b622660a-win-final/summary.json) y [WebKit Linux](../artifacts/pwa-e2e/release-92345453b622660a-linux-final/summary.json) son suites completas con respuestas de proveedores controladas; el [resumen de validación](../artifacts/pwa-e2e/validation-92345453b622660a.json) conserva alcances y limpieza. La [actualización A→B pasa 11/11](../artifacts/pwa-port/update-e2e-92345453b622660a-final.json), incluida la migración desde fbb con Chrome aislado, sin instrumentar el receptor ni `skipWaiting` y sin CDP ServiceWorker previo; el emisor conserva su registro de orden de mensajes. La [matriz anterior de fbb, 193/198](../artifacts/pwa-e2e/coverage-fbb03046132d7478.md), y la de [fb6, 169/174](../artifacts/pwa-e2e/coverage-fb6f83d340d7857a.md) permanecen históricas; ninguna sustituye las pruebas físicas.

Los ocho casos de la tanda fbb anterior cubren cancelar y abandonar una importación pendiente, rollback/reintento de un guardado CSV, cambio de fuente mientras suena, radio con fallo parcial, cancelar el borrado de todas las descargas y dos recorridos de teclado/errores accesibles. La navegación tiene nombre y destino actual accesibles; la entrada de fuente asocia su error y limpia el estado inválido al editar. No se declara una auditoría completa de accesibilidad ni una prueba de lectores de pantalla físicos.

El cambio actual recupera las cuatro pestañas **Inicio, Buscar, Podcasts y Tu biblioteca**, la importación CSV, los podcasts RSS y YouTube, las descargas y el registro de audio compartible. También se adaptan la restauración de cola, el botón Atrás y el tamaño del viewport al reabrir. **No se declara paridad total:** la importación Spotify por URL sigue bloqueada y falta probar físicamente iPhone.

## Cambios publicados el 22 de octubre

Este lote adapta comportamientos existentes: el primer Atrás desde Inicio instalado mantiene la app y muestra «Pulsa Atrás otra vez para salir»; un segundo dentro de **800 ms** permite salir mediante el navegador o el sistema. Cerrar un panel o volver por las pantallas sigue teniendo prioridad. Al regresar se rearma la protección para que la salida anterior no expulse otra vez la página. No se fuerza Home ni se minimiza Android mediante JavaScript; tampoco se garantiza continuidad de audio después de una salida deliberada.

También conecta la oclusión del teclado con la barra inferior, sin tratar foco o zoom como teclado; protege la ficha editada de un vídeo frente a copias antiguas de cola, favoritos e historial; renueva una vez una fuente de descarga fallida, conservando la intención de cancelar; y muestra error/reintento si falla todo el RSS consultado, en lugar de un falso vacío. Los resultados parciales y el fallback de «Todos los idiomas» permanecen. Reanudar el mismo ID conserva la copia de la cola, igual que la APK; iniciar una selección nueva desde Descargas usa los metadatos editados y el audio local, sin volver a transferirlo. El [mapa de funciones](pwa-e2e-function-map.md) identifica cuatro escenarios nuevos, con **70 comprobaciones por motor**.

## Compilar

Trabajar en el checkout del port, no en un checkout antiguo de la app nativa:

```sh
npm run check
npm test
npm run build:pwa
```

`build:pwa` compila `web-port/`, incorpora la aplicación a `dist-pwa/application/` y genera la entrada, el worker y la prueba de audio independiente. El frontend nativo se compila con `npm run build`; ese comando no construye una APK ni el binario Rust. No publicar ejecutando `scripts/build-pwa.mjs` directamente: es el constructor interno de la entrada mínima y no incorpora el port sin recibir la aplicación.

`npm run preview:pwa` sirve una previsualización estática en el ordenador; no forma parte de la app instalada. Abrir con `file://` no permite instalar ni actualizar una PWA. `dist-pwa-portable/Pletina.html` sigue siendo el antiguo Hola mundo autónomo, sin la aplicación musical.

## Instalar y actualizar

1. Abrir la dirección publicada con Chrome en Android o Safari en iPhone/iPad.
2. Pulsar **Instalar**. Android presenta el aviso nativo cuando está disponible y, en caso contrario, los pasos del menú.
3. En iOS, seguir **Compartir → Añadir a pantalla de inicio** y confirmar.
4. Abrir el icono con conexión y pulsar **Abrir Pletina**.
5. Para actualizar una instalación anterior, usar **Actualizar y abrir** en la entrada o **Actualizar** en el aviso de la aplicación.

Se mantienen dirección, identidad y scope. Antes de activar una actualización, el worker prepara y verifica los SHA-256 de toda la aplicación. Si falla, conserva la versión anterior. Actualizar recarga e interrumpe el audio actual; conserva biblioteca y descargas. Comprueba versiones al abrir, recuperar conexión o volver a la app, sin ejecutarse mientras está cerrada. Los nombres de las opciones de instalación dependen del navegador: [Chrome](https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DAndroid&hl=es), [Apple](https://support.apple.com/guide/iphone/iphea86e5236/ios).

Si solo se había instalado la entrada mínima A y B ya está esperando, el botón explícito **Actualizar y abrir** prepara B antes de activar su worker; no intenta descargar el launcher retirado de A. Un fallo conserva la caché activa de A y habilita reintento. Reabrir automáticamente una aplicación guardada no consiente otra actualización: abre la versión activa sin preparar ni activar la que espera. Los clics se bloquean durante la preparación.

Las entradas antiguas conservan su JavaScript antiguo: este cambio no las parchea retroactivamente. Si su primer botón no abre la aplicación, usar una vez el botón secundario **Actualizar y abrir** y, al cargar la entrada nueva, **Abrir Pletina**. El control final migra una copia de la distribución fbb publicada, en un proceso Chrome nuevo; no demuestra migración del acceso desde un icono del sistema. Los controles anteriores con d0 de QA, nunca publicado, conservan los [negativos del launcher antiguo](../artifacts/pwa-port/update-cold-negative-readywait-d0e466bf9a8d978a.json) y de [activación automática de 384](../artifacts/pwa-port/update-bootstrap-negative-autoopen-384c351ffd4fbd4e.json). Las aserciones incluyen caché mínima sin aplicación opcional, conservación de A en fallo y preparación íntegra de B antes de activar.

## Atrás en la aplicación instalada

Atrás cierra primero el panel superior: Cola, Sonando ahora o menú, antes de recorrer las pantallas. Si queda otro panel, reutiliza su entrada de historial; no recarga ni crea otra entrada al gestionar ese Atrás. Desde Inicio instalado, el primer toque protege documento/audio y el segundo dentro de 800 ms permite salir; si vence la ventana, se vuelve al estado protegido. Una pestaña normal puede abandonar el sitio desde la raíz sin ese contrato de doble toque.

El [recorrido integrado actual de Chrome standalone y su control normal](../artifacts/pwa-e2e/back-root-library-92345453b622660a-final/summary.json) pasa **35/35**: 24 casos de biblioteca y 11 de navegación. El [recorrido corto](../artifacts/pwa-e2e/back-root-short-92345453b622660a-retry2/summary.json) pasa **11/11** y se informa aparte. Atrás mediante la API conserva documento/Audio en el primer toque y permite la salida deliberada; el canal Atrás UI permanece bloqueado, fuera de esos aprobados. El retorno por Adelante observado cargó una página nueva; el rearme de BFCache se cubre en lógica, sin afirmar un BFCache físico de la app.

El [informe físico del Xiaomi del 22 de octubre](../artifacts/pwa-port/android-installed-double-back-user-report-2026-10-22.json) confirma un funcionamiento parcial: el doble toque muy rápido no sale y, cuando sale, se para el audio. El usuario desea volver a Inicio de Android manteniendo la reproducción; la salida publicada **no implementa ese objetivo**. La PWA no puede ordenar que Android mueva su ventana al fondo. Para hacerlo automáticamente hace falta una capa nativa; en la PWA se debe usar el botón o gesto Inicio del sistema. La causa del toque muy rápido sigue sin identificar; iPhone y el protocolo físico completo continúan pendientes.

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
