# Integración de P1 en la PWA

23 de octubre de 2026. Integración parcial, build `2cbb1fcf0376491f`, fuente `91a7097a5bff4998dfa0a433039ff8ce86bce247`. La interfaz procede de la APK 0.11.2; no se fusiona la base 0.9.1 de la rama P1.

## Cambios incorporados

- Búsqueda Music: admite las estructuras planas y con pestañas conocidas, y distingue una lista vacía de un error de API.
- Identidad: una respuesta de reproducción debe confirmar exactamente el ID solicitado; no basta con estado OK.
- Audio original: si hay etiquetas de idioma o pista, exige identificación explícita de original. Descarta doblajes, audio descriptivo, DRC, DRM, etiquetas corruptas y contradicciones. Conserva la selección MP4 por calidad y la compatibilidad con respuestas completamente sin etiquetas.
- El lector FormatXTags está acotado y mantiene la semántica de Rust para Base64 canónico y UTF-8/BOM.

La [procedencia y revisión](../artifacts/pwa-port/p1-parser-port-2026-10-23.json) fija las funciones de P1, los hashes de archivos y los resultados: **568/568 pruebas de lógica**, **59/59 dirigidas**, tipos **0 errores y 0 avisos**, y 2.048 representaciones contrastadas con un serializador independiente. Esto no implica que P1 completo esté trasladado.

## Ruta embedded y decoder: investigación sin activar

Se han obtenido formatos cifrados de Epoitaitaye, Iritsi da Eguna y Maite Zaitut desde un frame opaco normal. Las peticiones son públicas, anónimas y directas, sin claves, cookies, proxy ni cabeceras privilegiadas. Sin embargo, el cuerpo de control se preparó con una configuración pública obtenida por Node durante QA: **no demuestra arranque autónomo de la PWA**.

El navegador no pudo leer por CORS el bootstrap ni `base.js`. Una receta estática de funciones y timestamp resulta viable: **173.175 bytes** y salida idéntica entre los analizadores 18.1 y 18.2, con cuatro vectores sintéticos. No incluye visitantes, flags, IDs musicales ni URLs firmadas. El [informe del prototipo](../artifacts/pwa-port/p1-static-feasibility-2026-10-23.json) delimita la prueba; **no acredita descifrado de audio real ni reproducción**.

Al combinar la configuración con visitantes nuevos obtenidos en el navegador mediante búsquedas válidas Music o WEB, el player embedded devuelve ERROR sin audio. Omitir el visitante tampoco funciona; la búsqueda con el propio cliente embedded devuelve error de API y no proporciona visitante. El control contemporáneo con su visitante de bootstrap sí devuelve cuatro formatos cifrados. El [manifiesto de transporte](../artifacts/pwa-port/p1-web-transport-final-manifest-2026-10-23.json) fija cinco informes, sus fuentes y los intentos fallidos. Estos resultados acotan el obstáculo de esta ruta; no prueban la imposibilidad de cualquier método web futuro.

El POST WEB legible sí aporta el aviso infantil exacto que utiliza P1, la identidad solicitada y estado OK para los tres casos; ofrece SABR, sin URLs ni cipher de audio. Por tanto, esa comprobación de P1 es trasladable y no es el obstáculo pendiente. No se infiere contenido infantil a partir del título.

El [ensayo del sandbox](../artifacts/pwa-port/p1-decoder-sandbox-2026-10-23.json) pasa seis controles sintéticos en Chrome: worker sin DOM, red y almacenamiento de la aplicación denegados, terminación del bucle y limpieza. Los workers blob heredan la CSP de su documento; [documentación MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy#csp_in_workers). Es investigación, sin código de proveedor ejecutado en el navegador ni decoder añadido a la distribución.

La optimización posterior `8983e26` de P1 mejora caché y paralelismo nativos. Su caché verifica de nuevo `base.js` por red antes de aceptar el resultado; no elimina la petición bloqueada por CORS en este ensayo. Se revisó el commit fijado, sin modificar el checkout P1 que seguía avanzando.

## Alcance de la publicación

La versión incorpora los cambios de parser y selección descritos. Mantiene el transporte VISIONOS existente, Funkwhale/Audius y los rescates anteriores; no incorpora una sesión obtenida en el ordenador, un servidor, cuentas ni el prototipo de decoder. **Epoitaitaye no queda resuelta por esta integración.**

La [validación de la compilación](../artifacts/pwa-e2e/validation-2cbb1fcf0376491f.json) separa pruebas con fixtures, reproducción real y actualización. Las pruebas de escritorio y WebKit Linux no acreditan pantalla bloqueada ni ejecución física de este build en Android o iPhone.
