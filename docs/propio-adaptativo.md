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
- Si ese nivel falla, se prueba el cliente WEB descubierto, con un presupuesto
  total de seis segundos. Sólo se aceptan el vídeo solicitado, formatos de audio
  compatibles y URLs HTTPS de GoogleVideo que superen una sonda no vacía. Las
  redirecciones no pueden llevar esa sonda a otra familia de dominios.
- El último respaldo de escritorio sigue siendo Legacy. La captura progresiva
  nueva conserva su aprobación pendiente. Android usa el nivel directo; no tiene
  ventanas de captura como respaldo.

## Límites

El bootstrap web no describe VISIONOS: no se mezcla la versión web con esa
identidad. El cliente rápido VISIONOS conserva sus datos de receta; ésta sigue
siendo una reparación firmada excepcional. La alternativa WEB sólo sirve cuando
YouTube ofrece un audio directo que entendemos. Firmas nuevas, SABR, requisitos
de tokens o respuestas de estructura desconocida pueden requerir código o el
reproductor oficial. No se declara independencia total de la plataforma.

La sonda verifica acceso a una muestra del audio, no la canción íntegra ni EOF.
Si el CDN responde 200 e ignora Range, la muestra tampoco demuestra acceso al
80 %. Las campañas de captura completa y anuncios tienen criterios separados.

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
