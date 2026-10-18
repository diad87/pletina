# Pletina PWA: instalación mínima y app 0.11.2

El port web reutiliza la interfaz Svelte de Pletina **0.11.2**, con búsqueda por nombre o artista y reproducción de canciones sin pegar enlaces. La entrada de instalación sigue siendo pequeña: muestra **Instalar** y carga la aplicación completa solo al pulsar **Abrir Pletina**. GitHub Pages sirve archivos estáticos; el catálogo y el audio se consultan directamente desde el navegador, sin backend, proxy ni microservidor en el móvil.

**Estado de publicación: publicado y verificado por HTTPS.** El build final `1785b6edf53a230b` está en <https://diad87.github.io/pletina/>. Sus **22/22 archivos** respondieron HTTP 200 y coincidieron con los SHA-256 locales; la prueba pública de instalación mínima, búsqueda y reproducción de la canción seleccionada pasó **3/3 comprobaciones** en Chrome de escritorio. El [informe del port 0.11.2](pwa-port-0.11.2.md) enlaza los resultados y delimita la validación móvil pendiente.

## Compilar y comprobar

Desde la raíz de este port, la orden de compilación completa es:

```sh
npm run build:pwa
```

Este wrapper compila `web-port/` en modo `pwa`, incorpora la aplicación a `dist-pwa/application/`, genera la entrada instalable y su service worker y añade la herramienta diagnóstica independiente de pantalla apagada. También crea `dist-pwa-portable/Pletina.html`.

**No ejecutes `scripts/build-pwa.mjs` directamente para publicar el port.** Es el constructor de la entrada mínima y sus pruebas; sin el parámetro de aplicación no incorpora la app Svelte. Tampoco hace falta encadenar otra compilación de la prueba de audio: `npm run build:pwa` ya la incluye.

Para ejecutar las pruebas de la PWA y sus adaptadores:

```sh
npm run test:pwa
```

La previsualización opcional en el ordenador compila el mismo port y sirve los archivos estáticos en `http://localhost:4174/pletina/`:

```sh
npm run preview:pwa
```

Admite `npm run preview:pwa -- --port 4175`. Es una herramienta de desarrollo local; la aplicación publicada no la utiliza. En un móvil, `localhost` señala al propio móvil: para instalar, abre la dirección HTTPS publicada.

`dist-pwa-portable/Pletina.html` sigue siendo una copia autónoma de **Hola mundo** para abrir con doble clic. No contiene la app musical, no se instala como PWA y se actualiza sustituyendo el archivo. La instalación y las actualizaciones del port necesitan una dirección HTTPS estable, como GitHub Pages.

## Instalar en Android o iPhone

Para instalar o abrir el port publicado:

1. Abre <https://diad87.github.io/pletina/> con conexión: Chrome en Android o Safari en iPhone/iPad.
2. Pulsa **Instalar**. En Android abre el aviso nativo cuando está disponible; en caso contrario muestra los pasos del menú del navegador.
3. En iPhone/iPad la guía indica **Compartir → Añadir a pantalla de inicio**. Mantén **Abrir como app web** si aparece y confirma **Añadir**.
4. Abre el icono con conexión. Pulsa **Abrir Pletina** para obtener la aplicación completa.
5. En **Buscar**, escribe una canción o artista y pulsa una canción de los resultados. Si el navegador pide otro gesto para empezar el audio, pulsa **Reproducir**.

El botón está disponible aunque el navegador no permita invocar el aviso de instalación programáticamente. En iOS la web muestra instrucciones; la confirmación de añadirla corresponde al usuario. Los nombres de las opciones pueden variar: [ayuda de Chrome](https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DAndroid&hl=es) y [guía de Apple](https://support.apple.com/guide/iphone/iphea86e5236/ios).

El build final preparado `1785b6edf53a230b` contiene **35.884 bytes iniciales** y **410.560 bytes de aplicación bajo demanda**, sin comprimir. La instalación inicial no solicita los archivos de `application/`. La primera apertura verifica y guarda ese conjunto antes de entrar en la app. Después de abrirla una vez, el icono instalado puede volver directamente a Pletina mientras se conserve el indicador local. Los tamaños y el hash cambian al recompilar una modificación.

## Música y biblioteca

Se conservan las pantallas de Inicio, Buscar, artistas, discos, biblioteca y reproducción de la app nativa. El catálogo de Deezer aporta nombres, artistas, discos, duración y carátulas. El adaptador usa JSONP aislado para acceder al catálogo; selecciona el vídeo correspondiente mediante búsqueda y comparación de metadatos y obtiene audio MP4 directamente de YouTube.

La interfaz no requiere enlaces para buscar o escuchar canciones. Se conserva también la posibilidad de añadir un vídeo de YouTube y el selector **¿No es esta canción?** para recordar una fuente elegida manualmente.

Favoritos, discos y artistas guardados, playlists, historial y elecciones de vídeo se almacenan en **IndexedDB del navegador**. Las preferencias siguen en almacenamiento local. El reproductor mantiene cola normal y DJ, anterior/siguiente, posición, aleatorio, repetición y temporizador. No hay sincronización entre dispositivos ni conexión con la base de datos de la instalación nativa.

Esta fase no porta el catálogo de podcasts, la importación de carpetas, las descargas de música ni la importación de Spotify por URL o CSV. El flujo de importación está oculto en la PWA; que exista matching interno no lo convierte en una función disponible. Las demás acciones nativas sin adaptar se ocultan o devuelven un mensaje de indisponibilidad. Android Auto y CarPlay siguen fuera de esta fase.

## Actualizar sin reinstalar

Para distribuir cambios, ejecuta `npm run build:pwa` y publica el contenido de `dist-pwa/`, conservando la dirección, el `id` y el `scope` del manifiesto. La PWA comprueba actualizaciones al abrirse, al volver a estar visible y al recuperar conexión; no descarga versiones mientras está cerrada.

La aplicación completa muestra un aviso **Hay una nueva versión de Pletina** con **Actualizar**. Al pulsarlo, el worker pendiente prepara los archivos de la app nueva en su caché separada y verifica sus SHA-256 antes de activarse. Si esa preparación falla, informa del fallo y conserva activa la versión anterior. Después de activar, vuelve a la entrada estable y abre la app nueva. La biblioteca local se conserva; no hace falta reinstalar el icono. Aplicar la actualización recarga la aplicación e interrumpe la reproducción actual.

La entrada mínima también permite **Buscar actualizaciones** y **Actualizar y abrir**. Los archivos llevan nombres derivados del contenido y cada versión utiliza una caché propia. El navegador puede activar una versión pendiente al cerrar todas las ventanas de la PWA. El nombre y el icono que muestra el sistema pueden actualizarse más tarde que el contenido.

## Sin conexión y pantalla apagada

Tras una primera apertura completa con red, la interfaz guardada y los metadatos locales pueden abrirse sin conexión. Eso se comprobó en Chrome de escritorio. **La música no está descargada:** buscar canciones nuevas y reproducir audio de YouTube requieren conexión. Los datos dependen de que el navegador conserve su caché e IndexedDB; borrar los datos del sitio o liberar ese almacenamiento elimina esa disponibilidad.

El usuario confirmó continuidad y siguiente pista con pantalla físicamente apagada en **Xiaomi 15T Pro**, primero con la herramienta diagnóstica y después con el reproductor básico instalado anterior. Esa evidencia está en [el registro histórico de pantalla apagada](pwa-screen-off-results.md) y [el informe histórico de la primera integración](pwa-player-results.md).

**El nuevo port 0.11.2 todavía no tiene una prueba física de pantalla apagada.** Sus pruebas de escritorio verifican audio real y siguiente pista con la pestaña oculta; las vistas móviles son emulación de diseño en Chrome. iPhone/iPad, Safari y la PWA instalada en iOS siguen pendientes de prueba real. Los informes anteriores no acreditan automáticamente esos entornos ni este nuevo build.

## Publicación

El sitio utiliza GitHub Pages desde la rama **`gh-pages`** en modo de publicación por rama. El commit de distribución `cd4c6b68d5fe729a69f326952d65018d3149e4e7` está publicado y sus archivos HTTPS se comprobaron con `scripts/verify-pwa-deploy.mjs`: [22/22 correctos](../artifacts/pwa-deploy/public-files.json). Es un commit de archivos estáticos, distinto de la base nativa 0.11.2. La dirección raíz y <https://diad87.github.io/pletina/prueba-audio/> mantienen su ubicación.

El workflow `.github/workflows/pwa.yml` está preparado para compilar, comprobar y desplegar `dist-pwa/` mediante GitHub Actions. **Todavía no es el mecanismo activo de publicación.** Para usarlo habría que incorporar esos cambios a la rama configurada y cambiar **Settings → Pages → Build and deployment → Source → GitHub Actions**. Su presencia en el repositorio no acredita un despliegue.

El alojamiento estático distribuye el código de Pletina. No procesa las búsquedas ni retransmite canciones. Los endpoints internos de YouTube pueden cambiar y requieren nuevas comprobaciones cuando se modifique el motor.
