# P1 nativo adaptado a la PWA

Compilación `73187a1127b5ae37`, fuentes de producto `1b2c953474342564c6fe811224fdb37fb57a5a0f`.

Se revisó el motor Native de `musify-oficial` en `566d3aa415669367dbfcb9d0f488b4a48e72b36c`, incluida su prueba de **Ni, Ni, Ni!**, vídeo Topic `NGp3dh-hBe8`. La mejora estaba en el motor Rust Embedded; el adaptador TypeScript anterior de youtubei.js seguía igual. [Auditoría de las diferencias](../artifacts/pwa-port/p1-native-audit-566d3aa.json).

## Método general

- P1 prefiere Opus cuando el navegador confirma soporte nativo; conserva AAC para los demás navegadores. La identidad del vídeo y la política de pista original siguen siendo obligatorias.
- Cuando una respuesta correcta solo contiene SABR y metadatos de audio sin localizadores, prueba **un segundo contexto anónimo diferente**, con el mismo vídeo. Valida también la segunda respuesta y su descifrador. Ambos POST comparten un plazo de 15 segundos; no renueva ante restricciones, DRM, identidad incorrecta o cifrado mal formado.
- Una sola sonda aislada comparte **ocho segundos y diez intentos** entre formatos. Conserva las oportunidades nativas de 0, 250, 1000, 1500, 2000, 3000, 4000, 5000 y 6000 ms para el preferido. El turno de 1500 ms termina antes del de 2000 ms. Las alternativas usan el tiempo y cupo restantes: no se garantiza intentar las cuatro.
- No ejecuta un vídeo oculto. Retira la fuente de cada elemento de sondeo antes de continuar y entrega el audio al mismo reproductor de la aplicación.

La diferencia necesaria con Native es el descubrimiento del contexto: una PWA no puede leer libremente el HTML de YouTube a través de CORS. El proceso de compilación prepara **dos contextos públicos independientes del mismo ejemplo neutro**, compartiendo el descifrador cuando coincide. No hay excepciones ni correspondencias por canción, servidor de ejecución, cuentas, cookies o URL de audio almacenadas en la receta. Los móviles solicitan el audio directamente al proveedor. Este reemplazo estático no equivale a renovar HTML por vídeo en cada teléfono: los contextos pueden caducar o cambiar por cohorte y siguen necesitando futuras actualizaciones de la aplicación.

Las sondas web comprueban metadatos y duración mediante HTMLAudio. No pueden acreditar el rango HTTP 206 de Rust ni observar un 429; no se inventan esos estados.

## Verificación real

La [PWA compilada reprodujo Ni, Ni, Ni! completa](../artifacts/pwa-port/p1-integrated-nini-73187a1127b5ae37-full-local.json): **125,581 segundos**, desde el comienzo hasta `ended`, sin saltos, otro toque ni vídeo. No usó un contexto obtenido para esa canción, respuestas simuladas ni excepciones del navegador. Son seis comprobaciones aprobadas en Chrome de escritorio; no una comparación acústica ni un teléfono físico.

**125,581 segundos es la duración de la canción, no su espera de carga.** A los 7,301 segundos del toque se observaron 2,005 segundos de audio avanzado, lo que sitúa el arranque de ese intento en aproximadamente 5,3 segundos. No es una media ni un tiempo máximo garantizado.

La [búsqueda real de la aplicación](../artifacts/pwa-port/p1-song-nini-73187a1127b5ae37-title-local.json) seleccionó la pista de catálogo `3266784871`, ISRC `QM6N21490049`, del disco Zazpikoloroa. Un toque en el título inició audio nativo del mismo vídeo. Las respuestas CDN 403 transitorias acabaron en 206, sin abrir la ficha del disco ni el recurso de vídeo.

La [repetición en la web pública](../artifacts/pwa-port/p1-song-nini-73187a1127b5ae37-cover-public.json), después de verificar los 33 archivos, pulsó la **carátula pequeña de esa fila**: también inició audio nativo de la pista exacta, sin abrir disco o vídeo. El título está probado en la aplicación compilada local y la carátula en la publicación; ambos destinos tienen además regresión controlada en los tres motores de escritorio.

Otros [15 controles reales](../artifacts/pwa-port/p1-integrated-other-songs-73187a1127b5ae37-local.json) verificaron arranque, salto al 80 %, final natural tras un salto a la cola y parada para Epoitaitaye, Iritsi da Eguna y Maite Zaitut!. No se presentan esos saltos como reproducción completa de las tres canciones.

Las pruebas controladas cubren además renovación SABR, códecs, cancelación, recuperación y selección de título/carátula. El fallo de búsqueda comunicado por el usuario no se reprodujo; se conserva como regresión comprobada y no se atribuye a tocar una tarjeta de disco. [Validación conjunta](../artifacts/pwa-e2e/validation-73187a1127b5ae37.json).

## Portadas sin conexión

Las descargas guardan también portadas públicas legibles y decodificables, con límites de 5 MiB por imagen, 4096 píxeles por lado y 16 megapíxeles. Una caché aparte conserva hasta 64 MiB y 256 familias por instalación, sobrevive a actualizaciones y mantiene una portada compartida hasta borrar su última canción. Las variaciones de tamaño conocidas de Deezer comparten familia. La recuperación opcional de portadas antiguas no bloquea la lista.

Una portada rechazada no invalida el audio descargado. Se corrigió un bucle real de imágenes fallidas: 95–137 peticiones en la versión anterior frente a 1–3 en los controles actuales. Cambiar después a una canción con portada válida recupera la imagen del mismo minirreproductor.

## Límites pendientes

La actualización real desde la distribución anterior `435e0dc36a054099`, con la aplicación cerrada y el botón de la portada, pasó y conservó ámbito, identidad, marcadores y caché ajena. El control con la aplicación anterior abierta no activó el worker esperando tras pulsar su botón interno; conservó la versión vieja y ambas cachés completas. Los ensayos sintéticos de actualización caliente también conservaron fallos. No se declara una actualización 11/11 ni persistencia de portadas a través de ese recorrido fallido. Para recoger esta publicación se recomienda **cerrar Pletina y usar «Actualizar y abrir» en la portada**, sin reinstalar. Los informes y sus alcances están en la validación conjunta.

Pantalla apagada y segundo plano de **esta versión** siguen pendientes de prueba física Android/iPhone. El audio usa HTMLAudio y MediaSession, pero el resultado de escritorio no sustituye esa comprobación. Tampoco se promete catálogo universal, almacenamiento permanente, descargas garantizadas en segundo plano, Android Auto o CarPlay.
