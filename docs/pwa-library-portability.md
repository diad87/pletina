# Copia portátil de la biblioteca PWA

Compilación `1ea46db9dc0b5af3`, fuente `af1c3f4a6900fb8ca8052328f8ed539bc2cc11ad`. Todo ocurre en el navegador: no hay servidor intermedio, cuentas ni subida de la copia.

## Uso

En **Tu biblioteca → Copia de seguridad**, pulsar **Preparar copia** y después **Guardar archivo** descarga un JSON. En otro dispositivo u otro origen de Pletina, **Elegir copia** muestra los recuentos sin escribir. **Añadir a mi biblioteca** confirma la incorporación; Cancelar o salir durante la revisión no cambia datos. Guardar e importar funcionan sin conexión una vez preparada la aplicación.

Incluye favoritos, listas con su orden y repeticiones, discos, artistas, historial, pódcasts, metadatos de episodios, progreso y elecciones locales de fuente de YouTube. No incluye archivos de música, descargas, cola de reproducción, ajustes, recetas de extracción, credenciales ni diagnósticos. Los archivos de audio deben descargarse de nuevo en el destino cuando la fuente lo permita.

## Conservación y validación

La importación conserva la biblioteca de destino y añade listas nuevas. Si coincide el nombre, añade ` (importada)` y un número cuando hace falta. Importar el mismo archivo otra vez crea más listas; no es sincronización. Los favoritos se unen y los metadatos y fuentes ya existentes prevalecen. El historial conserva la multiplicidad de escuchas en un mismo segundo sin añadirlas otra vez en una segunda importación. El progreso incorpora la marca más reciente; sin fechas fiables se conserva el destino.

Los IDs locales de vídeos y episodios se remapean por vídeo o por programa y GUID, incluyendo sus referencias. Las canciones existentes mantienen sus IDs; no se modifica la base de descargas ni CacheStorage. La reproducción y su cola no se sustituyen al importar. Los contadores locales se reparan desde los IDs del destino, sin confiar en contadores del archivo.

Se valida todo antes de abrir una única transacción de escritura sobre los 13 almacenes. Un fallo de escritura o cuota revierte la incorporación completa. La exportación lee una instantánea dentro de una única transacción. El formato `pletina-library`, versión 1, contiene 12 colecciones y no exporta el almacén interno `meta`.

Límites: 10 MiB de JSON UTF-8 y 100.000 filas en total. Máximos por colección: canciones y favoritos 20.000; discos y artistas 10.000; pódcasts 5.000; listas 1.000; entradas 20.000; historial 50.000; progreso, vídeos, fuentes y episodios 20.000 cada una. Se rechazan versiones futuras, referencias huérfanas, posiciones o IDs inválidos y URLs temporales o firmadas. Un feed con un enclosure firmado puede requerir actualizar sus metadatos antes de exportar. Si una biblioteca antigua tiene progreso sin metadatos del episodio, se pide abrir y actualizar el pódcast: no se descarta silenciosamente ese progreso.

Esto permite trasladar la **biblioteca PWA** entre dispositivos y direcciones de alojamiento. No accede a la base privada de la APK ni migra sus datos automáticamente. La APK de referencia no ofrece un botón de exportación; migrarla requiere primero disponer de sus datos mediante un mecanismo separado.

## Reanudación de pódcasts

El commit `f2000c5` corrige un fallo anterior: al reanudar un episodio de YouTube con el enlace resuelto ya caducado, el reproductor lo renueva y conserva la posición. RSS permanente y enlaces todavía vigentes mantienen su comportamiento. Las pruebas controlan además cancelación y cambio de selección mientras se renueva. No cambia el catálogo ni elimina las restricciones de CORS de algunos feeds.

## Verificación

La [validación de esta compilación](../artifacts/pwa-e2e/validation-1ea46db9dc0b5af3.json) distingue pruebas de lógica, recorridos de navegador, actualización y publicación. Los archivos e informes conservan sus hashes. Los proveedores de los recorridos de biblioteca usan metadatos sintéticos y audio silencioso por HTTP de QA; no hay ese servicio en el producto. WebKit de escritorio con tamaño móvil no constituye una prueba de iPhone.

Las nuevas funciones y la renovación de enlaces de pódcast siguen pendientes de comprobación física. La copia JSON tampoco demuestra supervivencia permanente frente a la eliminación de datos del navegador, ni importa música descargada desde otra instalación.

## Orden de trabajo restante

1. Completado en esta fase: renovación de audio de pódcast al reanudar y copia portátil de biblioteca PWA.
2. Ampliar recuperación de feeds y errores de proveedores reales. Migración desde APK pendiente de disponer de sus datos.
3. Ampliar descarga de audio: P1 sigue sin entregar un cuerpo completo legible para guardarlo de forma fiable; solo se descargan las fuentes que pasan la verificación íntegra.
4. Seguir mejorando resolución de canciones difíciles y disponibilidad entre redes, sin sustituir por otra grabación. El vídeo no garantiza segundo plano y no se abre por un simple timeout transitorio.
5. Validar en móviles sesiones largas, transición offline, cierre y reapertura, descargas y pantalla bloqueada. Las comprobaciones anteriores del usuario conservan su propio alcance y no se reasignan a este build.

Android Auto y CarPlay continúan fuera de esta distribución PWA. No se presenta paridad funcional total con servicios nativos del sistema.
