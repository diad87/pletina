# Modo coche de la PWA

Interfaz de conducción para usar Pletina en el móvil en soporte y aprovechar los mandos multimedia que el navegador recibe del coche. Todo funciona en la PWA, sin APK, aplicación iOS adicional ni servidor propio.

## Uso

Abre **Modo coche** con el icono del coche en la barra superior, o desde **Sonando ahora → Modo coche**. Entrar y salir conserva la canción, la posición y la cola; abrirlo no inicia reproducción automáticamente.

- **Sonando:** carátula, título y artista, progreso, botones grandes de anterior, reproducir/pausar y siguiente. Música: aleatorio y favorito. Pódcasts: retroceder 15 segundos y avanzar 30 segundos.
- **Tu música:** favoritos, descargas, las últimas 100 escuchas, colecciones fijadas, playlists, discos guardados y pódcasts guardados. Las colecciones y sus canciones se muestran en páginas de ocho elementos. Se conserva la colección al cambiar de sección; favoritos, recientes y descargas se actualizan al volver.
- **Cola:** canciones añadidas manualmente y continuación de la colección, en su orden real. Seleccionar una conserva la identidad de su aparición aunque haya canciones repetidas.

El diseño se adapta a vertical y horizontal, respeta las zonas seguras y usa navegación por botones. No incluye búsqueda escrita, letras ni edición de biblioteca en esta pantalla. Prepara la música antes de salir.

## Pantalla y mandos

**Mantener pantalla encendida**, en Tu música, utiliza Screen Wake Lock cuando el navegador lo ofrece. Recuerda la preferencia, libera el bloqueo al salir o pasar a segundo plano y vuelve a solicitarlo al recuperar visibilidad. Un rechazo o una liberación del sistema se muestra como tal, sin reintentos continuos. No impide bloquear el móvil con su botón físico. La pantalla completa se ofrece únicamente cuando el navegador la admite.

Media Session registra por separado reproducir, pausar, detener, anterior, siguiente, posición y saltos relativos. Las órdenes repetidas de reproducir/pausar no invierten el estado. Detener libera la fuente, conservando la cola y el punto para reanudar. Los saltos predeterminados son −15/+30 segundos en pódcasts y ±10 segundos en música; se respeta un desplazamiento válido enviado por el sistema. Cada API se comprueba por separado para tolerar soporte parcial.

Los saltos del mando usan el reloj del audio activo aunque el navegador haya retrasado `timeupdate`; mientras se prepara una fuente se conserva la posición guardada. Una pausa del sistema durante el arranque invalida la reproducción pendiente y permite reanudar con una orden nueva, sin que las respuestas tardías reanuden audio por su cuenta. Las pausas internas al cambiar de fuente conservan su comportamiento.

Título, artista, disco, carátula, estado y posición se comunican al sistema. La posición se limpia durante un cambio de fuente y al detenerse para no mostrar el tiempo de una canción bajo los metadatos de otra.

La integración utiliza los [controles web Media Session](https://web.dev/articles/media-session) y [Screen Wake Lock](https://www.w3.org/TR/screen-wake-lock/). El sistema decide qué órdenes y metadatos entrega a Bluetooth, a la pantalla bloqueada o al coche. El modo no registra una app con icono ni catálogo propio en Android Auto o CarPlay, y no proyecta la interfaz web en esas pantallas.

## Validación

`npm run check`, `npm test` y `npm run build:pwa` comprueban tipos, lógica y distribución. Se añaden dieciséis pruebas de mandos Media Session sobre el reproductor real y diez de Wake Lock, incluidas carreras de cierre, pérdida de visibilidad y respuestas tardías.

**Actual publicada `e6e79b96d898769a`:** incorpora las correcciones de saltos desde posición atrasada e interrupción durante carga. Tipos sin errores ni avisos; **982/982 pruebas de lógica** y [20/20 casos de navegador](../artifacts/pwa-e2e/driving-mode-e6e79b96d898769a/summary.json) aprobados, diez en Chromium y diez en Firefox, sin errores. [Despliegue correcto](https://github.com/diad87/pletina/actions/runs/40105817115) y [33/33 archivos públicos HTTP/SHA](../artifacts/pwa-deploy/public-files-e6e79b96d898769a.json). Fuente `7e84907`, publicación `ad084a0`. No se reasigna a esta compilación la evidencia WebKit anterior. La interfaz y el CSS conservan sus bytes respecto a `8fb7144c78afe773`.

**Compilación anterior `8fb7144c78afe773`:** tipos sin errores ni avisos y **976/976 pruebas de lógica** aprobadas. El [informe de navegador](../artifacts/pwa-e2e/driving-mode-8fb7144c78afe773/summary.json) consolida **25 casos correctos, cero fallos y cinco bloqueados**, incluidos los preparativos: diez en Chromium, diez en Firefox y cinco de interfaz/biblioteca en WebKit. Los cinco casos de audio WebKit están bloqueados por la limitación de transporte del motor Windows 26.5; no se atribuyen a Safari de iPhone. Se conservan los informes de diagnóstico y la procedencia de cada perfil, sin sumar reejecuciones.

La inspección visual comprueba [título largo a 320 px](../artifacts/pwa-e2e/driving-mode-8fb7144c78afe773/playing-long-title-320x568.png), [horizontal](../artifacts/pwa-e2e/driving-mode-8fb7144c78afe773/playing-844x390.png) y [pódcast](../artifacts/pwa-e2e/driving-mode-8fb7144c78afe773/podcast-320x568.png). Los controles principales y secundarios quedan completos; salir, Escape y Atrás conservan el audio y devuelven el foco al activador. Los ensayos usan HTTP y audio controlados, no mandos físicos.

El recorrido de navegador se ejecuta con `npm run test:pwa:driving` después de compilar. Usa la distribución compilada, proveedores HTTP controlados, audio AAC silencioso y almacenamiento real del navegador. Distingue la emulación de tamaños móviles de los dispositivos físicos.

La [verificación de la web publicada](../artifacts/pwa-e2e/driving-mode-release-e6e79b96d898769a/report.json) pasa **6/6 comprobaciones**: versión activa, entrada desde la portada, aplicación, Modo coche, secciones/tamaños y salida/Atrás. Se usa un perfil aislado, sin reproducción ni cambios de biblioteca. El [registro de publicación](../artifacts/pwa-port/driving-mode-release-e6e79b96d898769a.json) vincula fuente, despliegue y evidencias.

Siguen pendientes pruebas en un Android y un iPhone reales, con la PWA instalada, mandos del coche, llamadas/interrupciones, cambios de red, sesiones largas y pantalla bloqueada. Las pruebas de escritorio no acreditan esos comportamientos ni integración nativa con Android Auto o CarPlay. Esta implementación está publicada en [Pletina](https://diad87.github.io/pletina/). Para actualizar, cierra la app y pulsa **Actualizar y abrir** en la portada, sin reinstalar.

Mejoras de interfaz pendientes: controles compactos de reproducción también en Tu música y Cola; conservar la página válida al refrescar una colección; trasladar el foco al contenido nuevo cuando desaparece el botón que lo abrió. Son ajustes distintos de las correcciones de audio ya verificadas.

## Archivos de trabajo

Durante esta tarea C: se quedó sin espacio. Se recuperó App.svelte y se trasladaron temporalmente las evidencias y las compilaciones a D:. Cuando volvió a haber espacio suficiente, `artifacts` se devolvió íntegro a su carpeta original. `dist-web-port`, `dist-pwa` y `dist-pwa-portable` siguen en `D:/tmp/pletina-driving-builds/`, conservando sus rutas originales con junctions de Windows. Los perfiles temporales y las capturas nuevas también se generan en D:.
