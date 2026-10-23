# Recuperación de audio y conservación de la grabación

El commit `c349e9b` corrige tres rutas generales del motor web. No incorpora un servidor, cuentas, otro reproductor ni asociaciones por canción.

## Renovación después de un rechazo del servidor de audio

El cliente inicial podía devolver un JSON válido y una dirección que el CDN rechazaba al reproducir. La reparación solicitaba otra dirección al mismo cliente; una segunda respuesta JSON correcta impedía alcanzar P1, aunque P1 pudiera entregar audio del mismo vídeo.

Cuando la reproducción solicita renovar una dirección primaria todavía vigente, ahora prueba primero P1 para el mismo ID. Se mantienen las comprobaciones de identidad, audio original, formatos y metadatos. Si P1 falla, se permite una solicitud nueva al cliente inicial. No se repite P1 dentro de esa solicitud ni se convierte su fallo de red en una afirmación de contenido ausente. Cancelar impide continuar o guardar un resultado tardío.

El orden inicial, las direcciones caducadas y los aciertos de caché conservan su ruta anterior. La reparación exige una opción explícita de reproducción: las renovaciones de descarga no cambian a una fuente P1 por ese motivo. No se amplía el plazo global ni se realizan búsquedas para cambiar de grabación.

## Un formato caducado no descarta sus alternativas

`parsePlayer()` comprueba la caducidad dentro de la selección de formatos. Si el AAC preferido ha caducado, puede elegir otro AAC válido del mismo vídeo. Si todos los elegibles han caducado, conserva el error de caducidad. La prioridad de calidad y el requisito de audio original siguen considerando todos los metadatos; un hermano doblado o de identidad no confirmada no queda autorizado por descartar el primero.

## Una fuente independiente ante un fallo transitorio

La reproducción automática puede consultar también el rescate Audius existente cuando YouTube termina en un error tipado de red o timeout. Se exige la misma comprobación de ISRC, artista, versión, duración y disponibilidad que antes. La consulta se memoriza una sola vez dentro de la operación y comparte su plazo y cancelación. Una coincidencia sólo por título no sirve.

Si la fuente independiente está vacía, falla o no confirma la grabación, se conserva el error original y no se escribe una nueva elección de YouTube. La ampliación no se aplica a elecciones manuales, vídeos añadidos, pódcasts ni descargas. No modifica las ramas anteriores de rescate por contenido no disponible.

## Verificación y límites

Las pruebas dirigidas conservan controles negativos contra el motor anterior, incluyendo siete fallos con las pruebas actuales y el módulo `youtube.ts` anterior congelados en una copia aislada. Las nuevas pruebas comprueban el opt-in de reproducción, la exclusión de descargas, cancelación, vídeo incorrecto, caducidad y rescates exactos ante fallos transitorios.

Los recorridos de navegador usan la aplicación compilada, respuestas HTTP controladas y audio AAC sintético real. Comprueban rechazo del CDN después de JSON correcto, recuperación sin un segundo clic ni vídeo, cliente inicial sano, cancelación y rescate Audius con el mismo Audio. No equivalen a pruebas físicas, de sonido audible o de todos los proveedores.

La [investigación de descargas P1](pwa-p1-download-feasibility.md) conserva aparte los canarios reales de la publicación anterior. Los doce HTTP403 observados para Ni, Ni, Ni! no quedan resueltos por corregir el caso distinto en que el cliente inicial impide alcanzar P1. No se afirma cobertura universal.
