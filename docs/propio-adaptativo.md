# Propio: configuración descubierta y recuperación automática

Trabajo en `p1-oficial`, sobre la integración de Pletina 0.9.1 en `3d7fb7a`.
El objetivo aprobado es reducir las reparaciones manuales cuando YouTube cambia
datos de configuración, conservando la rapidez y las comprobaciones del audio.

## Comportamiento

- La búsqueda y los podcasts de YouTube Music obtienen el contexto WEB_REMIX
  publicado por YouTube. La versión fija anterior queda como último recurso
  cuando no se puede descubrir ninguna configuración, no como sustituto de una
  configuración viva que YouTube haya rechazado.
- Las configuraciones WEB y WEB_REMIX tienen cachés independientes de seis
  horas, peticiones concurrentes compartidas y renovación limitada. Un fallo
  conserva la última configuración válida. No se escribe esta caché en disco.
- Un error de autorización o de estructura permite renovar y repetir una vez,
  sólo si cambió la petición efectiva. Una búsqueda vacía legítima no provoca
  renovación. No se ejecuta código de la página para obtener los datos.
- El audio sigue probando primero el nivel rápido actual. Clientes/recetas
  idénticos se deduplican; un rechazo estructural del cliente abre un circuito
  temporal de 30 segundos. Un vídeo privado, un error de red o un rechazo CDN no
  deshabilitan por ello el cliente para otros vídeos.
- Si ese nivel falla y la página pública identifica expresamente el vídeo como
  contenido infantil, permite su reproducción incrustada y confirma el ID,
  se prueba WEB_EMBEDDED_PLAYER. Se descubren su versión, contexto y URL del
  reproductor desde la página incrustada. No se activa por el título, el artista
  ni por `isFamilySafe` solamente, y no intenta superar un bloqueo de cuenta,
  edad o vídeo privado.
- Esta ruta calcula firma y `n` con un bundle local de los analizadores de
  youtubei.js 18.1.0 y Meriyah. El reproductor descargado se analiza como texto;
  sólo se ejecutan las funciones y dependencias extraídas. La configuración y
  las funciones preparadas tienen caché acotada en memoria: hasta cuatro scripts
  preparados, como máximo 8 MiB, sin conservar sus runtimes temporales.
  Si cualquier formato de audio aporta metadatos de pista, idioma o `xtags`,
  todos los candidatos deben identificar expresamente audio original. Una
  respuesta enteramente sin esas etiquetas conserva la compatibilidad de sus
  variantes de códec/bitrate; es el caso de los tres fixtures infantiles, no
  una prueba semántica universal de originalidad. Se rechazan DRC/DRM y se exige
  una sonda HTTP 206 con rango, tamaño total y cuerpo completos hacia el 80 %.
  Los rechazos transitorios CDN permiten hasta cinco intentos de la misma URL
  dentro de ocho segundos, sin multiplicar ese presupuesto por formato.
- Si la respuesta confirma el vídeo pero sólo ofrece SABR, sin URL ni cipher
  en ningún audio seleccionable, se relee la configuración incrustada una vez.
  Sólo se repite el POST si cambian su cuerpo o cabeceras efectivos, incluido
  el ST; un cambio de URL del reproductor por sí solo no basta. Se conservan
  los datos anteriores ante un fallo y la renovación se deduplica por vídeo
  durante 30 segundos. Se copian sólo campos públicos acotados del cliente,
  no contextos de cuenta, petición o seguimiento. No se decide según anuncios.
- Si tampoco resulta utilizable, se prueba el cliente WEB descubierto, con un presupuesto
  total de seis segundos. Sólo se aceptan el vídeo solicitado, formatos de audio
  compatibles y URLs HTTPS de GoogleVideo que superen una sonda no vacía. Las
  redirecciones no pueden llevar esa sonda a otra familia de dominios.
- El último respaldo en Windows sigue siendo Legacy. La captura progresiva
  nueva conserva su aprobación pendiente. Android usa el nivel directo; no tiene
  ventanas de captura como respaldo. Los adultos que resuelve el nivel rápido
  no descargan ni ejecutan el decoder JavaScript.

## Límites

El bootstrap web no describe VISIONOS: no se mezcla la versión web con esa
identidad. El cliente rápido VISIONOS conserva sus datos de receta; ésta sigue
siendo una reparación firmada excepcional. La alternativa WEB sólo sirve cuando
YouTube ofrece un audio directo que entendemos. Firmas nuevas, SABR, requisitos
de tokens o respuestas de estructura desconocida pueden requerir código o el
reproductor oficial. No se declara independencia total de la plataforma.

El decoder infantil usa QuickJS con un único trabajador: preparación limitada a
192 MiB y 12 segundos; descifrado a 32 MiB y un segundo; pila de 512 KiB.
El plazo incluye la espera del trabajador. Cancelar la petición interrumpe el
trabajo y conserva su plaza hasta que termina el runtime. La ruta incrustada
completa tiene un presupuesto exterior de 30 segundos. Son límites por runtime,
no una promesa de latencia ni un límite de memoria para toda la aplicación.

El runtime no recibe red, archivos, módulos, DOM ni callbacks de la aplicación.
Se retiran las entradas públicas de evaluación y constructores dinámicos; el
compilador privado sólo ejecuta el fragmento extraído en modo estricto. No se
evalúa el reproductor remoto completo. QuickJS está dentro del proceso de la
aplicación: este aislamiento no es un sandbox del sistema operativo.

La sonda verifica acceso a una muestra del audio, no la canción íntegra ni EOF.
La ruta incrustada exige 206 exacto. En el nivel rápido, un 200 que ignore Range
sólo acredita acceso al prefijo, no al 80 %. Las campañas de captura completa
y anuncios tienen criterios separados. Una URL que pasa de 403 a 206 tras
esperar no acredita que se haya reproducido o saltado publicidad.

La configuración se obtiene sin sesión, cookies de cuenta ni perfil Premium.
Sólo se conservan los campos necesarios y los errores públicos son categorías
locales. Los datos en bruto, si hacen falta para diagnóstico, permanecen en
carpetas `.local` ignoradas. No se publica receta, script ni app en este trabajo.

## Validación

Se prueban configuración cambiante, caché/renovación concurrente, límites y
rechazo de datos incoherentes. Los transportes HTTP locales ejercitan rechazos
de versión, renovación efectiva, identidad incorrecta y sondas inválidas.
La prueba real anónima del bootstrap y el banco de treinta canciones se registran
por separado: una prueba de arranque no acredita escucha completa ni ausencia
de cortes hasta EOF. Los resultados se incorporan al informe del 8 de octubre.

## Resultados del 8 de octubre

La app aislada, sobre el commit limpio `c6d1238`, resolvió e inició las 30 canciones
de `real_albums` sin sesión, todas por VISIONOS y con el vídeo esperado. La mediana
con búsqueda fue 653,4 ms (456,5–1200,5 ms); ninguna cumplió 300 ms y 29 tardaron
menos de un segundo. La extracción nativa por separado tuvo mediana de 174,7 ms.
Esta tanda conserva la funcionalidad del nivel rápido, pero no demuestra una
mejora de latencia frente al control anterior ni ejercita la alternativa WEB.

Una medición separada de WEB con Airbag, Sucede y Come Together produjo 0/3
URLs aceptadas: el cliente respondió `video-unavailable` en 284,8, 95,3 y
197,2 ms. Los vídeos sí funcionaron por VISIONOS. La alternativa queda acotada
y verificada cuando obtiene audio, pero no demuestra reemplazar al cliente
rápido actual ni eliminar su receta. Su rechazo permite continuar hacia Legacy.

El bootstrap real obtuvo WEB_REMIX `1.20261006.10.00` y WEB `2.20261007.01.00`,
con visitante y reutilización de caché, en 187,8 y 108,6 ms respectivamente.
La fuente de producción es `sw.js_data` del dominio de cada cliente. La primera
prueba con portadas falló por consentimiento/formato y motivó esa corrección.
El valor `v1` es un protocolo base cuando la fuente no lo declara; descubrir
una versión de cliente no acredita descubrir cualquier versión futura de API.

Pasaron 165 pruebas Rust, con 20 pruebas ignoradas, en el commit de código.
Tras ajustar la categoría final de error, pasaron otra vez las 18 pruebas de
Native. El build de la app Windows y `cargo check --tests` para Android x86_64
son correctos. No se ejecutaron pruebas instrumentadas en Android ni se accedió
a Premium. El [informe](informe-captura-youtube-2026-10-08.md) conserva la tabla,
procedencia y límites: arranque silenciado por eventos/reloj, sin campaña nueva
de EOF, continuidad o comparación independiente de publicidad.

## Contenido infantil: trabajo del 23 de octubre

La búsqueda Music ya encontraba las tres canciones del corpus infantil con
puntuación 112; el problema estaba en la obtención del audio directo. El control
de app inició las tres por Legacy. En `d426c50`, el nuevo ensayo con búsqueda
inició dos por Native y Epoitaitaye por Legacy, tras `CIPHER_MISSING`; tardaron
7726,6, 1660,7 y 11831,9 ms, respectivamente. Ese intento fallido se conserva.
Después se añadió la renovación SABR acotada: una prueba real posterior resolvió
las tres y recuperó Maite Zaitut! tras una configuración efectiva nueva. No se
ha aislado qué campo concreto causó la diferencia; falta medir la app final.

Un ensayo directo posterior resolvió las tres mediante WEB_EMBEDDED_PLAYER/251:
14073, 7446 y 8325 ms. Pasaron las sondas de inicio/80 % y las comprobaciones de
reproducción inicial, salto y cola. No fue escucha completa en la app. En una
prueba separada, los tres archivos completos fueron idénticos byte a byte a las
referencias 251 obtenidas con yt-dlp y FFmpeg los decodificó sin errores.

La regresión con búsqueda de las 30 canciones habituales conservó 30 rutas
Native, cero respaldos y ningún fallo distinto del umbral de 300 ms: mediana
595,5 ms, intervalo 431,7–949,1 ms. Ninguna cumplió ese umbral. No mide EOF ni
continuidad completa. Preparar un reproductor en frío tardó 6,85 segundos en
QuickJS; la caché evita repetirlo para el mismo reproductor, pero YouTube puede
publicar distintos scripts. Ese tiempo y los límites del runtime no miden RSS
de la aplicación ni predicen el rendimiento de Android.

El [informe infantil](informe-contenido-infantil-2026-10-23.md) separa esos
resultados, fallos e historial. Android x86_64/arm64 compilaba antes de la última
guarda de selección. Además, un harness del mismo decoder pasó 6 pruebas de
aislamiento y el fixture real en un emulador Android 15 x86_64: preparación de
10911,5 ms, con los mismos límites y cuatro firmas/`n` idénticas a V8. No ejecutó
la app, JNI ni ExoPlayer; la reproducción Android y el dispositivo ARM físico
siguen pendientes. No se presenta el corpus de tres canciones como compatibilidad
con todo el catálogo infantil ni como una medición de ausencia de publicidad.
