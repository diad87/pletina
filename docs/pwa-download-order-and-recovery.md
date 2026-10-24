# Orden y recuperación de Descargas

La compilación `435e0dc36a054099`, fuente `cd5e6d1`, corrige el orden de Descargas y las marcas de archivos desaparecidos. Conserva la interfaz 0.11.2 y funciona íntegramente en la PWA, sin servidor intermedio ni cuentas.

## El mismo orden visible y de reproducción

La consulta de la APK 0.11.2 agrupa por artista y disco con `COLLATE NOCASE`, seguidos de la fecha de descarga ascendente. El port mostraba primero lo más reciente, por lo que podía invertir las entradas de un mismo disco. Ahora la lista visible usa aquella agrupación y fecha después de leer los metadatos actuales, incluidos los vídeos añadidos cuyo título o artista se haya editado.

La comparación sólo pliega las letras ASCII A–Z y compara los bytes UTF-8, como SQLite; no usa la ordenación regional ni mezcla letras acentuadas. La consulta nativa no especifica el desempate de coincidencias completas. La PWA usa el ID ascendente para mantenerlo estable al reabrir. El botón Reproducir crea la cola a partir del mismo orden visible. Esto no convierte Descargas en una playlist ni afirma que su orden sea siempre el número de pista de un disco.

## Recuperar una copia perdida sin recargar

Al abrir Descargas, la consulta comprueba qué archivos siguen en caché. Su resultado actualiza también las marcas «Descargada» de la PWA: si un archivo desapareció, vuelve a ofrecer Descargar. Las lecturas fallidas conservan el estado anterior; una lectura antigua no puede deshacer una descarga, eliminación o corrección de estado posterior. Las transferencias activas quedan fuera de esa reconciliación.

La lectura no incrementa por sí misma la versión que dispara otra consulta. Su snapshot de marcas se obtiene con `untrack`, de modo que el efecto de la vista no se suscribe accidentalmente al conjunto que está actualizando. Si una consulta de la lista falla y otra posterior funciona, la vista retira el error anterior.

## Conservar las descargas nuevas durante una comprobación antigua

La comprobación de caché puede terminar después de que otra operación haya guardado una copia nueva. La limpieza del registro ahora vuelve a leerlo dentro de una transacción de escritura y sólo elimina el puntero si sigue apuntando a la copia observada como ausente. Un puntero nuevo se conserva y puede comprobarse una vez más; no hay un bucle de reintentos ilimitado ni se borran cuerpos de audio desde esta reconciliación.

La [validación de esta compilación](../artifacts/pwa-e2e/validation-435e0dc36a054099.json) distingue pruebas de lógica, UI compilada y actualización. Los escenarios nuevos crean las descargas desde la interfaz. El caso de copia perdida elimina únicamente un cuerpo de caché como inyección de fallo; no siembra registros ni modifica las marcas del producto. No reproduce una expulsión real por presión de almacenamiento del móvil. El recorrido de orden comprueba además la cola del botón de colección y un final de pista real sin proveedores disponibles.

Estas correcciones no garantizan almacenamiento permanente ni resuelven rechazos de los proveedores. Los controles de navegador de escritorio no sustituyen la validación de esta versión instalada en Android o iPhone.

## Publicación y resultados

Publicada en [Pletina](https://diad87.github.io/pletina/), distribución `c7e669fe29c769473232caebb060ca2331ffd898`. Pasan 878 pruebas de lógica, tipos con cero errores y avisos y once comprobaciones de actualización desde b698. La compilación del frontend nativo compartido también termina correctamente; no se ejecuta la APK ni un servicio del móvil.

El [informe de la compilación](../artifacts/pwa-e2e/validation-435e0dc36a054099.json) consolida 33 comprobaciones de navegador: once por motor de escritorio, incluidas dos preparaciones, selección de audio y ocho recorridos multimedia. Los dos casos nuevos pasan después de corregir su preparación para pulsar «Ver más (12)»; el primer intento esperaba doce filas mientras la interfaz mostraba ocho y no llegó a descargar. Se conservan sus informes y fuentes, sin sumar las preparaciones repetidas. La corrección del observador no cambia las aserciones de orden, almacenamiento, reproducción o ausencia de proveedores.

El [workflow](https://github.com/diad87/pletina/actions/runs/40073366431) termina correctamente y los [33 archivos públicos](../artifacts/pwa-deploy/public-files-435e0dc36a054099.json) responden con sus hashes esperados. Los controles negativos de lógica conservan por separado el orden anterior, la limpieza anterior de punteros y las marcas anteriores de la interfaz, además de la suscripción reactiva que causaba una consulta adicional.
