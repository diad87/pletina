# Descarga de audio P1: lectura y caché opaca

Prueba acotada del 23 de octubre de 2026 sobre la **PWA pública `1ea46db9dc0b5af3`**, en Chrome 153 de escritorio. [Manifiesto y hashes](../artifacts/pwa-port/p1-download-feasibility-1ea46db9dc0b5af3-manifest.json). No valida cambios posteriores ni teléfonos físicos.

La lectura completa mediante CORS falló en las dos variantes ensayadas. Un prototipo posterior de caché opaca falló con 30 segundos y **superó con 90 segundos la validación local y la reproducción después de recargar sin red**. Eso demuestra una vía viable en ese Chrome de escritorio; aún no habilita una descarga P1 del producto. Cambiar únicamente `download.allowed` no acredita ese funcionamiento.

| Caso | Resultado observado |
| --- | --- |
| Ni, Ni, Ni! | Tres resoluciones P1 del mismo vídeo `NGp3dh-hBe8`, con identidad correcta en sus respuestas. Los doce localizadores distintos de AAC 140 y Opus 251/250/249 recibieron HTTP403. La interfaz avanzó a Euri Tanta; el runner rechazó esa canción diferente y no ejecutó una prueba de descarga sobre ella. |
| Euri Tanta | La canción exacta, catálogo `3266421971`, vídeo `CJ1A6FJnWTU`, se reprodujo mediante AAC140. El mismo localizador dio HTTP206 al reproductor y HTTP200 a dos `fetch` CORS: desde Pages y desde un marco opaco estándar. Ambas respuestas carecían de `Access-Control-Allow-Origin`; Chrome registró `MissingAllowOriginHeader` y JavaScript no pudo leer bytes. |

El segundo caso permite localizar el bloqueo de lectura: funcionaba el audio, la dirección era la misma y el servidor respondió HTTP200. No se obtuvo un hash del archivo ni se comprobó su cola decodificable. **Tampoco se demostró un archivo P1 real parcial** en esta ronda; los HTTP403 y la ausencia de acceso al cuerpo no permiten afirmar que el archivo estuviera truncado.

## Diferencia con las descargas actuales

[`audio.ts`](../web-port/audio.ts) marca P1 como fuente de escucha sin descarga. [`downloads.ts`](../web-port/downloads.ts) rechaza esa fuente antes de transferirla; su adaptador de archivos legibles admite otras fuentes y comprueba cuerpo, tamaño y, cuando corresponde, SHA256.

El camino primario de YouTube ya usa `fetch` con `no-cors`, espera `Cache.put` y valida audio desde la copia local. Una respuesta opaca puede almacenarse aunque JavaScript no pueda inspeccionar su cuerpo. En ese camino actual, la validación no recibe una duración esperada, y por tanto no ejecuta la comprobación adicional de duración y posición final disponible en `validateDownloadedAudio`.

La investigación no encontró una diferencia de transporte que, por sí sola, impida intentar ese mismo almacenamiento opaco para P1. [Cache.put admite respuestas opacas](https://developer.mozilla.org/en-US/docs/Web/API/Cache/put); el servicio de esa respuesta mediante [respondWith exige una petición con modo `no-cors`](https://developer.mozilla.org/en-US/docs/Web/API/FetchEvent/respondWith), como la del elemento de audio usado aquí. Una respuesta opaca tampoco permite declarar verificados el tamaño corporal o su hash.

## Prototipo opaco separado

Se hizo una única ronda adicional sobre Euri Tanta y la misma build pública. [Manifiesto independiente y hashes](../artifacts/pwa-port/p1-opaque-download-prototype-1ea46db9dc0b5af3-manifest.json). El clic normal en la interfaz volvió a reproducir la canción exacta mediante AAC140: catálogo `3266421971`, vídeo `CJ1A6FJnWTU`, duración observada aproximada de 109 segundos. Después se pausó la aplicación.

El prototipo hizo un `fetch` con `no-cors` del localizador que acababa de reproducirse y esperó `Cache.put` en una entrada temporal aislada. Chrome observó HTTP200 y `audio/mp4` en ese GET, con tamaño declarado de 1.767.085 bytes. `Cache.put` no resolvió antes del plazo de 30 segundos y se abortó la operación. Ese resultado no identifica por sí solo si la espera ocurrió al transferir el cuerpo o al almacenarlo; tampoco demuestra un archivo parcial.

Por ese fallo **no se ejecutaron en la primera ronda las comprobaciones offline, de duración/cola de la copia ni de persistencia tras recargar**. La inspección final no encontró la entrada temporal; se cerraron el contexto y el navegador. No se creó un registro de descarga ni se mostró la canción como descargada.

Se autorizó una única comparación con la misma canción, el presupuesto de 90 segundos del gestor actual y observación de contadores de red de Chrome. [Manifiesto de la comparación de 90 segundos](../artifacts/pwa-port/p1-opaque-download-prototype-1ea46db9dc0b5af3-90s-manifest.json). Se resolvió un localizador firmado nuevo mediante la misma interfaz normal; no es una repetición byte a byte de la petición anterior. El GET acabó a los 55,543 segundos según CDP y `Cache.put` completó dentro del plazo. Esto acredita que 30 segundos resultan insuficientes para una transferencia como la observada, sin identificar la causa del primer fallo ni garantizar una velocidad futura.

La segunda ronda superó tres comprobaciones: reproducción normal de Euri; metadatos y cola decodificables desde la copia temporal con red efectivamente bloqueada; y persistencia más reproducción local después de recargar offline. La copia midió 108,999592 segundos y decodificó la posición 108,749592 con `readyState=4` antes y después de recargar. Un clic confiable en el botón del prototipo inició audio sin silenciar y el tiempo avanzó hasta 1,998575 segundos. Los dos controles de red nuevos fallaron como se esperaba. Se eliminó la entrada temporal al finalizar y se cerró el navegador, sin registro de descarga del producto.

El límite de 8 MiB era exclusivamente sobre el tamaño declarado: el cuerpo opaco no permitió contar bytes desde JavaScript ni calcular SHA256. Los contadores CDP diagnósticos observaron 1.767.085 bytes codificados recibidos para ese GET; no son una comprobación accesible al producto ni un hash de integridad. La duración, el final decodificable y el inicio offline no equivalen a comparar cada muestra musical del archivo.

Era un prototipo diagnóstico, con una clave temporal y controles DOM propios claramente etiquetados; no una prueba E2E de una función de descarga del producto. El informe fallido y el snapshot exacto de su runner se conservan sin sobrescribir los canarios CORS anteriores.

## Comprobación necesaria antes de habilitarlo

Antes de habilitar este camino en el producto hace falta integrar y probar esa secuencia con su gestor real: esperar transferencia y `Cache.put` dentro de un presupuesto acotado, validar la duración esperada y el audio decodificable cerca del final, y solo entonces guardar el puntero de la descarga. La reproducción tras recargar sin red ya pasó en el prototipo, pero necesita su regresión integrada. Un fallo, cancelación o cierre debe retirar la entrada temporal sin marcarla como terminada.

Si otro localizador permite CORS, existe una comprobación adicional posible: contar todos los bytes dentro de un límite, compararlos con el tamaño declarado del formato seleccionado, calcular SHA256 y validar duración y cola antes de confirmar. Esta ronda no obtuvo un localizador legible que superara ese requisito.

## Alcance conservado

La primera ronda usó dos canciones y dos peticiones CORS diagnósticas, un máximo de 8 MiB legibles por petición y un plazo de 10 segundos por transferencia; no escribió audio en CacheStorage. Se hicieron después dos intentos opacos sobre Euri, uno de 30 segundos y otro de 90, ambos con 8 MiB declarados como límite. Las URL firmadas permanecieron exclusivamente en memoria, y no se guardaron archivos musicales entre los artefactos. Se conservan los informes completos, el fallo anterior y los snapshots exactos de los tres runners. Los navegadores se cerraron.

No hubo cuentas, proxy, cambios de producto, receta, build o publicación, ni excepciones de seguridad o autoplay. No se afirma funcionamiento móvil, pantalla apagada, segundo plano, disponibilidad universal ni verificación acústica del máster completo.
