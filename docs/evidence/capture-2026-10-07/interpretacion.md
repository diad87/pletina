El ensayo de velocidad demuestra capacidad de decodificación local y un fallo en la interpretación inicial de la seguridad publicitaria. No justifica promover la entrega progresiva experimental al modo normal.

[rates.json](rates.json) reanaliza las 2.864 observaciones de doce casos nativos de WebView2: un AAC sintético de 2,048 s, con un tono de referencia publicitaria entre 1 y 1,5 s. Todos llegaron al final y conservaron la cobertura esperada. Se solicitaron tasas constantes y cambios a 1× ante marcadores tempranos o tardíos; no se aceleraron anuncios reales ni se descargó audio remoto para esta prueba.

| Tasa solicitada | Pendiente del reloj observado | Avance total / tiempo pared |
| --- | --- | --- |
| 1× | 0,99755× | 0,97470× |
| 2× | 1,97770× | 1,93038× |
| 4× | 3,85424× | 3,64993× |
| 16× | 12,03084× | 12,52370× |

La pendiente es una regresión de `currentTime` frente al reloj de pared. El cociente global también incluye los efectos de arranque y final. El criterio original admitía una desviación del 25%; por tanto, el caso solicitado a 16× pasó, pero no midió 16× exactos. Son observaciones del reloj del elemento multimedia, no una medición acústica ni una comparación del PCM de salida a cada velocidad. Tampoco miden la latencia de YouTube, el inicio en tres segundos o un salto a una zona todavía no capturada.

Los casos con marcador temprano a 4× y 16× se habían marcado incorrectamente como `adRatePreserved=true`: la propiedad `playbackRate` ya mostraba 1 antes del inicio publicitario conocido, pero el reloj siguió avanzando demasiado rápido. Los 500 ms de referencia quedaron entre muestras exteriores separadas por, como máximo, 370,9 ms y 24,9 ms respectivamente. Los límites inferiores del ritmo observado son 1,348× y 20,080×. Este último describe un avance discontinuo de `currentTime`; no significa que se haya medido una reproducción acústica estable a 20×. El análisis conserva las muestras testigo y un margen de 25 ms para cuantización y temporizadores. Ambos resultados corregidos son `false`. Los casos coherentes con 1× quedan en `null`: consistencia no equivale a garantía.

El límite de identidad existe incluso sin acelerar. La prueba `a late site ad marker is a measured counterexample to unconditional progressive zero-ad attribution`, en `tests/capture-core.test.mjs`, fija el inicio publicitario real en 1 s y retrasa su señal visible hasta 1,12 s. Con reproducción a 1×, el experimento ya publicó 100 ms pertenecientes al intervalo publicitario antes de detectar el cambio. La variante normal retuvo todos los bytes y rechazó esa fuente al aparecer la contradicción. Esta regresión y la prueba de cuarentena hasta EOF se ejecutaron correctamente.

`adsDelivered=0` significa que no se publicaron unidades identificadas como anuncio por el clasificador. No demuestra ausencia semántica de publicidad: una unidad erróneamente clasificada como contenido no incrementa ese contador. El contraejemplo dispone de una referencia externa al clasificador y, por eso, descubre contaminación que el contador interno puede omitir. Ni EOF ni una cronología completa autentican por sí solos la naturaleza del audio remoto.

Se mantiene el experimento sólo en el banco explícito. El modo normal espera la validación de la fuente observada completa antes de publicar, con el coste correspondiente de latencia. La promoción exige resolver la atribución antes de entregar bytes y demostrarlo con referencias independientes; acelerar o reducir la espera no resuelve el contraejemplo.

La procedencia incluye SHA256 del informe original, navegador y analizador del commit `85cb60b`; el commit del binario original no quedó registrado. La revisión de los 113 campos de texto de `rates.json` no encontró credenciales, cookies, tokens, URLs firmadas ni rutas personales absolutas. Sólo contiene datos técnicos, procedencia del audio sintético y rutas relativas del proyecto.
