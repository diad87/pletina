# Música P1 sin conexión mediante la caché del navegador

Compilación `6bdc970908569e3c`, fuente `9c437f92c385a418f95f5f014cf07d7ba756c5c6`. Amplía las descargas existentes a música resuelta por P1 cuando hay metadatos válidos del formato seleccionado. No usa servidor intermedio, cuentas, un APK ni enlaces manuales.

## Funcionamiento

Se conserva el mismo ID de vídeo y la misma dirección del formato que ya pasó las sondas de P1. La canción debe tener un tamaño declarado entero positivo de hasta 256 MiB y una duración finita de hasta 24 horas. Si faltan esos datos, no se habilita esa descarga; las alternativas exactas anteriores conservan su ruta.

El gestor descarga con `no-cors` y `credentials: omit` y espera a que `Cache.put` termine de guardar la respuesta completa en una clave temporal local. Después abre **esa copia de caché**, comprueba duración con tolerancia de tres segundos y exige audio decodificable cerca del final. El worker sirve esa ruta exclusivamente desde la caché: no completa una copia incompleta consultando al proveedor.

Sólo después guarda el registro y anuncia Descargada. Un error de transferencia, validación, cuota o cancelación retira el temporal y no crea un registro terminado. Se conserva el reintento existente con una fuente fresca y la recuperación de pendientes al reabrir. No se guardan URL firmadas, Blob URL, recetas ni una identidad P1 falsamente marcada como archivo verificado.

Las respuestas opacas ocultan el cuerpo a JavaScript. Por ello, el tamaño mostrado es **declarado**, no un recuento de bytes medidos, y no se afirma un hash del archivo. Esta vía comprueba una copia reproducible y su final; no una huella criptográfica de todos los bytes ni una verificación acústica del máster completo. Las fuentes legibles verificadas conservan sus comprobaciones de tamaño y hash.

Algunos servidores entregan el archivo lentamente. Para P1 se permite un plazo total por trabajo de `max(90 s, min(10 min, duración + 30 s))`, contado desde su inicio. Un reintento no reinicia ese plazo. Las opciones de timeout explícitas conservan prioridad y los otros trabajos mantienen su plazo anterior; el resolutor conserva sus 45 segundos. La vista distingue **En curso** de **En cola** cuando el navegador no expone el avance en bytes, sin inventar porcentajes.

## Evidencia

La [investigación previa](pwa-p1-download-feasibility.md) separa tres resultados sobre la publicación anterior: CORS no permite leer el archivo, la primera espera de 30 segundos no completó la copia y un prototipo con 90 segundos sí guardó y reprodujo Euri Tanta después de recargar sin conexión. El archivo opaco tardó aproximadamente 55 segundos en esa segunda ejecución; al usar direcciones frescas no se presenta esa diferencia como una comparación idéntica de rendimiento.

La aplicación compilada tiene además recorridos específicos de descarga P1 completa, recarga y reproducción local con proveedores caídos, y rechazo de un cuerpo HTML HTTP403 sin marcar Descargada ni dejar temporales. Se prueban junto a reparación del cliente primario, cancelación, Opus, AAC y rescate Audius exacto. Las [pruebas de la compilación](../artifacts/pwa-e2e/validation-6bdc970908569e3c.json) conservan resultados, fuentes QA y hashes; los fixtures sintéticos no se presentan como canciones comerciales reales.

## Canario público con proveedores reales

El [recorrido de la interfaz publicada](../artifacts/pwa-port/p1-opaque-download-6bdc970908569e3c-euri-public-live-v3.json) pasa **4/4** en Chrome 153 de escritorio: Euri Tanta, catálogo `3266421971`, vídeo `CJ1A6FJnWTU`, AAC140. Descarga mediante el menú normal, registra 1.767.085 bytes **declarados** y una respuesta opaca, recarga con bloqueo real de red y reproduce desde `/pletina/__audio__/3266421971`. La duración nativa es 108,999592 s; después de avanzar cerca del 90 % continúa sin error. Quitar descarga elimina el registro y la caché y deja 404 en la ruta local. No se escribieron datos de descarga mediante QA ni se sustituyó Audio.

El canario local previo recibió 403 antes de descargar. Los dos primeros intentos públicos fallaron por aserciones del observador (marcos ocultos de metadatos contados como vídeo y contexto CDP destruido durante navegación); sus archivos y fuentes se conservan. La versión final sólo admite puentes propios ocultos, rechaza vídeo y reintenta los dos errores de contexto conocidos dentro del plazo original.

El DOM registró «En curso» antes de terminar. Las dos capturas estrechas se tomaron cuando la transferencia ya había terminado: acreditan la vista final a 393 px, no una captura del estado en curso. No se compara la velocidad con el prototipo anterior ni se afirma lectura/hash del cuerpo opaco.

## Alcance

Esto habilita una ruta general para **canciones** P1, incluidos vídeos añadidos como canciones, sin mapas por título. El adaptador de episodios de pódcast P1 conserva su política anterior. Los proveedores aún pueden denegar todo el audio: la nueva descarga no resuelve un HTTP403 persistente ni garantiza que todas las canciones estén disponibles.

La suspensión del navegador puede interrumpir o retrasar una transferencia. Los pendientes se recuperan al volver a abrir, pero no se garantiza descargar con pantalla apagada. El almacenamiento sigue perteneciendo a este origen y perfil; depende del espacio y las políticas del navegador. Las copias JSON de biblioteca no incluyen estos archivos musicales. No se afirma una prueba física nueva de Android/iPhone ni una integración de Android Auto o CarPlay.

La misma publicación incorpora los [tres arreglos de recuperación de audio](pwa-audio-recovery.md). La paridad funcional completa con la APK sigue abierta, especialmente para servicios nativos y validación física.
