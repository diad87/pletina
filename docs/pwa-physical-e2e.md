# Pruebas físicas de la PWA

El usuario dispone de un Xiaomi 15T Pro y no tiene un iPhone disponible. Esta batería no ha ejecutado un runner en teléfonos físicos. Hay una confirmación manual parcial descrita abajo; **el protocolo completo de Android y las pruebas de iPhone siguen pendientes**. Los pasos del protocolo no cuentan como resultados superados por estar enumerados aquí.

El **19 de octubre de 2026**, el usuario respondió «todo bien» al recorrido desde el icono: buscar «A solas con un ritmo lirico de violadores del verso», tocar el título para reproducir, volver con Atrás a Inicio y comprobar las cuatro pestañas tras reabrir. Añadió que el audio se detiene al salir y la app reaparece pausada; aclaró que salir significa **pulsar Atrás hasta abandonar la app**. Se registra como confirmación manual de búsqueda/reproducción y navegación/reapertura, no como reproducción continuada en segundo plano. [Evidencia y respuesta literal](../artifacts/pwa-port/android-installed-navigation-user-report-2026-10-19.json).

No proporcionó el hash abierto ni versiones de Android/navegador; no se atribuye este resultado al build publicado. Tampoco acredita salir con Inicio, quitar la app de recientes, bloqueo de pantalla, avance automático de canción ni conservación exacta del segundo de reproducción. La restauración pausada sí coincide con el diseño del Player, que no reproduce automáticamente al iniciar una nueva página.

La release actual publicada en [Pletina](https://diad87.github.io/pletina/) y el build de referencia son **`fb6f83d340d7857a`** (`gh-pages`: `0ad01788b2a9a0dea12ae4c65f20bab87a9ee65a`). La [verificación pública HTTP/SHA-256](../artifacts/pwa-deploy/public-files-fb6f83d340d7857a.json) pasa **22/22 archivos** y la [prueba pública de navegador](../artifacts/pwa-port/browser-public-e2e-user-song-fb6f83d340d7857a.json), **3/3 comprobaciones**. Es evidencia de distribución y navegador de escritorio, no de instalación o reproducción física. Antes de comenzar, actualizar si hace falta y confirmar ese build en la entrada; si cambia la release, registrar el nuevo.

Registrar modelo, versión del sistema, versión del navegador, build mostrado en la entrada, modo Chrome/Safari o icono instalado, conexión y fecha. Conservar resultado de cada paso, captura si falla y el JSON de «Enviar registro» cuando afecte al audio. No publicar URLs temporales del audio ni datos personales.

| Caso | Pasos y resultado esperado |
| --- | --- |
| Instalación Android | Abrir Pages en Chrome, pulsar Instalar y completar el aviso o instrucciones. Abrir desde el icono, comprobar modo independiente y las cuatro pestañas. |
| Instalación iPhone | Abrir Pages en Safari, pulsar Instalar y seguir Compartir → Añadir a pantalla de inicio. Abrir el icono y comprobar área segura, navegación y apertura completa. |
| Búsqueda y selección | Buscar «A solas con un ritmo lirico de violadores del verso». Tocar el título de la canción: debe sonar; tocar el artista debe abrir su ficha. Borrar la consulta, probar otra y resultado vacío. |
| Atrás y reapertura | Entrar en Buscar, abrir disco/artista, usar Atrás repetidamente, cerrar y reabrir. Se conserva una ruta coherente y la barra Inicio/Buscar/Podcasts/Tu biblioteca permanece accesible. Repetir desde Sonando ahora y desde la cola. |
| Teclado y orientación | Abrir teclado en Buscar, cerrarlo, girar horizontal/vertical, volver desde otra app. La barra inferior queda visible y ningún control sale del área usable. |
| Sonando ahora | Abrir/cerrar, deslizar poco y mucho, mover progreso, pulsar favorito. Deslizar desde un botón no debe cerrar por accidente. La reproducción no se detiene al cerrar el panel. |
| Bloqueo y cambio de pista | Preparar al menos tres canciones, adelantar la primera a 30 s del final, bloquear durante 3 min. Deben sonar la segunda y siguientes sin desbloquear. Repetir desde el icono, después de otra app y con conexión móvil. |
| Duración en segundo plano | Reproducir una cola al menos 20 min con pantalla apagada. Anotar cortes, saltos, ahorro de batería y si se necesitó desbloquear. El tiempo largo no se sustituye por un reloj virtual. |
| Controles del sistema | Desde la pantalla bloqueada y notificación: pausa/reanudar, siguiente/anterior y desplazamiento si el sistema los ofrece. Metadatos y posición corresponden a la pista actual; un toque no provoca dos saltos. |
| Interrupciones | Recibir llamada/alarma, desconectar auriculares/Bluetooth, volver desde otra app de audio. Anotar el comportamiento real de pausa/reanudación y ausencia de dos audios simultáneos. |
| Cola y temporizador | Añadir duplicados a DJ, reordenar, quitar una entrada, saltar, vaciar, aleatorio/repetir. Probar fin de canción y temporizador de minutos con pantalla bloqueada. Se respeta la intención de pausa. |
| Estado al reabrir | Con cola y posición avanzadas, cerrar desde recientes y abrir otra vez. Conserva cola/posición/biblioteca y empieza pausado. Repetir tras recuperación del proceso por el sistema; no asumir equivalencia con recargar. |
| Biblioteca | Crear/renombrar/fijar playlist, añadir disco y duplicados, reordenar, borrar una entrada, cancelar y confirmar eliminación. Guardar/quitar artistas, discos y favoritos; comprobar tras reabrir. |
| Importación y fuentes | Importar CSV con aciertos/omitidas/duplicados. Comprobar selección manual de fuente, validación de enlace y elección recordada. Spotify por URL debe explicar su limitación y permitir CSV. |
| YouTube personal | Previsualizar enlace, editar título/artista, guardar y actualizar sin duplicar. Reproducir y eliminar; comprobar persistencia y cola. |
| Podcasts | Buscar RSS y YouTube, filtros de idioma, guardar programa, reproducir episodio y reabrir a mitad. Continúa desde la posición guardada, marca final y pasa al siguiente. Bloquear también en el cambio. |
| Descargas | Descargar dos canciones, cancelar pendientes, comprobar aviso de completado. Activar modo avión, cerrar/reabrir desde icono, reproducir y avanzar hasta final y siguiente descargada; quitar y verificar espacio/estado. Repetir con corte de red y espacio insuficiente si es reproducible. |
| Actualización real | Crear biblioteca y descarga en A; publicar B manteniendo identidad/scope y pulsar Actualizar. Conserva datos y descargas y abre desde el mismo icono. Un fallo de red durante preparación conserva A y permite reintentar. |
| Registro | Enviar registro ofrece compartir o descargar JSON local, sin URLs del audio ni títulos. Comprobar el selector nativo de compartir en cada sistema. |

## Android Auto y CarPlay

La PWA actual no proporciona esas integraciones. No se pueden marcar como compatibles por sonar mediante Bluetooth ni por mostrar controles multimedia del teléfono. Véanse los requisitos y fuentes en [pruebas por plataforma](pwa-platform-testing.md).

Si se desarrolla el destino nativo de coche, necesitará una batería independiente: instalación/detección, exploración de catálogo/biblioteca, búsqueda y voz, seleccionar/reproducir/pausar, anterior/siguiente sin duplicar, metadatos/progreso, cola, reanudación, llamadas/navegación, desconexión/reconexión y restricciones al conducir. Ejecutar en Android Auto/DHU o CarPlay/Simulator y después en vehículo/equipo compatible, con versión del software y evidencia. Todos esos resultados están pendientes.
