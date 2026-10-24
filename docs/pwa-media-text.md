# Letras y transcripciones en la PWA

En **Sonando ahora**, **Letra** abre la letra de la canción actual y **Transcripción** abre el texto publicado por el autor del episodio. La barra de reproducción del ordenador tiene otro acceso. En móvil el texto ocupa el espacio de la portada, mantiene los controles de audio y permite desplazamiento táctil y con teclado.

Las consultas se realizan al abrir el panel. Una respuesta que llega después de cambiar de pista se descarta. El reproductor, sus fuentes, la cola y las descargas conservan su comportamiento. La interfaz distingue carga, ausencia, canción instrumental y fallo con reintento. Los enlaces de atribución abren la fuente publicada en otra pestaña.

## Fuentes y sincronización

- **LRCLIB:** consulta directa a `/api/get` por título, artista, álbum y duración; comprueba la grabación recibida, conserva las versiones y admite letra plana y LRC. Las peticiones se cancelan al sustituirse, se espacian y respetan los límites del proveedor. [Documentación del servicio](https://lrclib.net/docs).
- **Podcasts RSS:** lee `<podcast:transcript>` con el namespace oficial o su alias histórico. Admite texto UTF-8, WebVTT, SubRip y JSON de Podcasting 2.0. Los enlaces se guardan con el episodio y se renuevan; un episodio antiguo puede recuperar sus referencias por GUID aunque haya salido de los primeros 300 del programa. Los episodios exclusivos de YouTube no se presentan como si tuvieran una transcripción RSS. [Especificación del elemento](https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/tags/transcript.md).

Los fragmentos con tiempos permiten saltar en el audio. **Seguir** desplaza el texto y las letras empiezan con esta opción activada. Las transcripciones empiezan desactivadas: sus tiempos corresponden a la versión RSS y pueden variar al usar otro audio, por ejemplo una copia de YouTube con anuncios distintos.

## Acceso web y datos

La PWA hace las consultas desde el navegador, sin servidor intermedio. LRCLIB permite acceso CORS. El RSS y los archivos de transcripción de cada podcast también necesitan permitirlo; si no es posible leerlos, el panel muestra un error reintentable. No se interpreta HTML de terceros, ni se generan letras ni texto a partir del audio. Los cuerpos, los tiempos y las cachés tienen límites.

Al abrir una letra se envían sus metadatos a LRCLIB. Al abrir una transcripción se consulta el RSS si sus referencias necesitan renovarse y se descarga el documento del autor. No se envían el audio ni rutas del equipo. Las referencias de transcripción se pueden reconstruir desde el RSS si no estaban en una biblioteca anterior o en una copia de seguridad.

## Verificación

Las pruebas de lógica cubren selección de grabación, LRC, formatos de transcripción, límites, errores, cancelación y persistencia de referencias. Las pruebas de navegador usan la distribución real compilada y respuestas HTTP controladas para comprobar el panel, el cambio de pista y el diseño móvil. Sus resultados se registran por compilación y no sustituyen una prueba en un teléfono físico.
