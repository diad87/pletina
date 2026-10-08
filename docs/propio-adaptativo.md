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
