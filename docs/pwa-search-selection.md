# Seleccionar una canción desde Buscar

La PWA trata cada fila de **Canciones** como una única selección: tocar la carátula, el título, el artista, el espacio de la fila o el nombre del disco inicia esa canción y abre su disco. Se sale de la pantalla de búsqueda sin exigir un segundo toque en la canción. Atrás conserva la búsqueda anterior.

La reproducción se solicita antes de navegar y no espera a descargar los datos del disco. Si ya suena esa canción, seleccionarla vuelve a abrir el disco sin pausarla ni reiniciarla; si estaba pausada, se reanuda. El menú ⋯ y el corazón siguen siendo acciones independientes. Enter y Espacio activan una fila enfocada; las teclas sobre esos controles secundarios no activan también la fila.

El comportamiento se limita a los resultados de búsqueda de la PWA mediante `openAlbumOnPlay`. Las filas de discos, artistas, playlists y descargas conservan su comportamiento anterior, igual que la interfaz nativa. Los discos mostrados en la sección **Discos** siguen siendo tarjetas de navegación al disco.

La comprobación anterior solo verificaba título y carátula. No acreditaba que tocar otros metadatos tuviera la misma acción. La captura del usuario y su aclaración han definido ahora este contrato completo; no se atribuye el problema a que tocara una tarjeta equivocada.

El canario real con búsqueda **Eminem**, en un navegador con pulsaciones táctiles y vista Android, toca el artista bajo **Without Me**: reproduce la pista de catálogo `916424` y muestra **The Eminem Show**, sin vídeo ni segundo toque. No es un teléfono físico ni una prueba del teclado del sistema.

Las pruebas controladas incluyen título, carátula, artista, cuerpo de fila, disco visible en escritorio, repetición de una canción ya en reproducción, reanudación, menú, favoritos y activación por teclado. Las pulsaciones táctiles se acreditan con eventos de confianza `touchstart` y `pointerType: touch`; una ventana estrecha con clics de ratón no basta. Firefox se declara aparte como ratón.

Las primeras comprobaciones con una muestra de audio de doce segundos quedaron cortas para la prueba de volver a seleccionar una canción: terminaba durante la preparación y empezaba la siguiente. Se conserva ese fallo de QA y se usa una muestra de noventa segundos, comprobando la identidad antes de repetir la selección. No se cambió el producto para ocultar esa finalización natural.

La prueba de teclado detectó además que Espacio llegaba al atajo global del reproductor: podía pausar una selección recién iniciada o reanudar al marcar un favorito. La fila de Buscar detiene esa propagación para Enter y Espacio, permite la acción propia de los botones hijos y solo selecciona cuando el foco está directamente en la fila. Se conservaron las ejecuciones fallidas de `e74729a4dd1d6894`; la corrección pasó en `dc8d0aa30fcaeae5`. La compilación final también elimina el tooltip «Cancelar carga» y el icono de pausa al pasar el ratón en esas filas, porque su nueva acción es seleccionar y abrir el disco.

Compilación publicada **7141fda94599aec1**, fuente `e1e35cd2efdeb3146868f67e9ce5fc9d6c06e15a`. [Validación final](../artifacts/pwa-e2e/validation-7141fda94599aec1.json): 14/14 comprobaciones de navegador, tipos sin errores ni avisos y 33/33 archivos públicos verificados. El canario real público inicia «Without Me» al tocar su artista, abre «The Eminem Show» y retira el buscador; se conserva su captura. No acredita un teléfono físico ni la reproducción completa o con pantalla apagada.
