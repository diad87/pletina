# Prueba de pantalla bloqueada

Harness PWA separado de la aplicación y de `pwa/`. Sirve para comprobar en un
dispositivo real si el navegador reproduce audio y cambia de pista después de
bloquear físicamente la pantalla. Usa solicitudes directas desde el navegador,
sin backend ni proxy para resolver o transportar el audio.

## Abrir e instalar

La distribución está publicada en <https://diad87.github.io/pletina/prueba-audio/>.
Para generar sus archivos estáticos, ejecuta `npm run build:pwa` y después
`npm run build:pwa:screen-off`. La segunda orden añade `prueba-audio/` a `dist-pwa/`.
`localhost` también permite probar el service worker en el propio equipo;
una dirección HTTP de la red local no equivale a `localhost` en el móvil. Para
instalar y preparar la caché hace falta abrir la página con conexión.

- **iPhone/iPad:** abre la dirección en Safari, pulsa Compartir y «Añadir a la
  pantalla de inicio». Inicia después la prueba desde ese icono.
- **Android:** abre la dirección en el navegador y usa su menú «Instalar
  aplicación» o «Añadir a pantalla de inicio», según lo que ofrezca.

La caché offline contiene **solo los archivos del harness**, no la música ni los
resultados de resolución. La prueba de reproducción necesita conexión. El worker
solo atiende GET de los archivos estáticos enumerados en `sw.js`, dentro de su
propio origen y ámbito; no intercepta YouTube, Google Video ni otras rutas.

## Protocolo en dispositivo real

Haz cada ejecución desde cero. Los dos campos contienen la misma muestra por
defecto: se reproducen sus últimos 30 segundos y luego se vuelve a solicitar y
abrir desde el principio. Así se distingue el cambio de fuente sin introducir
otra pista que pueda no estar disponible. Después puedes repetir con dos pistas
distintas. Anota dispositivo,
versión del sistema, navegador, modo y duración del bloqueo. Mantén la conexión
disponible durante la prueba.

1. Elige uno de los dos modos:
   - **Siguiente preparada en primer plano:** resuelve las dos pistas mientras
     la página está visible. Comprueba si al terminar la primera puede comenzar
     la siguiente con una URL ya preparada.
   - **Resolver al terminar, con pantalla bloqueada:** prepara solo la primera.
     La resolución de la segunda debe comenzar desde el evento `ended`, después
     de bloquear. Este modo comprueba también si el navegador puede ejecutar esa
     resolución en segundo plano.
2. Prepara la primera pista y espera a sus metadatos. Sitúala en
   `max(0, duración − 30 segundos)`; no uses una duración todavía desconocida.
3. Pulsa **Empezar** directamente con un toque para proporcionar el gesto de
   usuario que permite iniciar el audio. Comprueba que se oye la primera pista.
4. Bloquea físicamente el móvil con su botón y mantenlo bloqueado **dos minutos**.
   No desbloquees para consultar el estado durante ese intervalo. Comprueba de
   oído si continúa el audio y si empieza la segunda pista. Opcionalmente repite
   manteniéndolo bloqueado **diez minutos**.
5. Desbloquea, revisa los eventos y exporta el JSON del resultado. Registra también
   lo observado de oído y cualquier interrupción de red.

Repite ambos modos en una pestaña de Safari y desde el icono instalado de iOS,
como ejecuciones separadas. Haz lo mismo en Android con pestaña y aplicación
instalada cuando estén disponibles. No supongas que comparten estado, permisos o
caché. Un evento `visibilitychange` con estado `hidden` solo indica que la página
se ha ocultado: **no demuestra que la pantalla estuviera apagada o bloqueada**.

El JSON debe contener únicamente el diagnóstico necesario, sin URLs firmadas de
audio, tokens ni cookies. Antes de compartirlo, comprueba ese contenido. Guarda
los resultados por ejecución para no mezclar los dos modos o contextos.

## Alcance de la evidencia

No hay un iPhone disponible localmente para verificar este protocolo. La
existencia del harness, su caché o una prueba de escritorio no confirma el
comportamiento de iOS con pantalla bloqueada; hacen falta las ejecuciones reales
anteriores. Una reproducción que continúa tampoco demuestra por sí sola que la
resolución de la siguiente pista haya podido ejecutarse: compáralo entre modos.

El service worker usa caché primero. Su marcador `__SCREEN_OFF_VERSION__` debe
sustituirse por el hash de todo el código fuente durante el build o la preparación
de la distribución. **No publiques estos archivos fuente sin esa sustitución**;
usa la distribución generada para que cada cambio tenga una versión de caché
distinta. Su limpieza solo elimina versiones de su propio ámbito.
