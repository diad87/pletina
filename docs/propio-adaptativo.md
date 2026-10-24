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
  sólo se ejecutan las funciones y dependencias extraídas. La preparación
  selectiva calcula dependencias cuando se necesitan, conservando la presencia
  histórica de declaraciones y el orden de emisión de la biblioteca fijada;
  no cambia sus reglas de selección ni evalúa el player completo. La configuración y
  las funciones preparadas tienen caché acotada en memoria: hasta cuatro scripts
  preparados, como máximo 8 MiB, sin conservar sus runtimes temporales.
  Desde `8983e26`, una caché separada en datos locales de la app permite
  reutilizarlas tras reiniciar: cuatro entradas, 8 MiB y seis horas. Exige
  descargar de nuevo la fuente y comprobar URL, SHA y versión del analizador;
  un fallo vuelve al análisis. No conserva URLs de audio ni cookies, y sus
  checksums detectan corrupción, no modificaciones maliciosas de un usuario local.
  El POST puede adelantarse con un ST provisional, pero sólo se reutiliza
  si el análisis completo confirma ese ST y se cumplen las guardas habituales.
  Comprobar la página pública, descubrir la configuración y preparar las
  funciones locales puede solaparse; el POST espera confirmar el ID y su aviso
  infantil. El descubrimiento admite gzip con límite de 4 MiB descomprimidos;
  el cliente de sondas de audio conserva su política independiente.
  Si cualquier formato de audio aporta metadatos de pista, idioma o `xtags`,
  todos los candidatos deben identificar expresamente audio original. Una
  respuesta enteramente sin esas etiquetas conserva la compatibilidad de sus
  variantes de códec/bitrate; es el caso de los tres fixtures infantiles, no
  una prueba semántica universal de originalidad. Se rechazan DRC/DRM y se exige
  una sonda HTTP 206 con rango, tamaño total y cuerpo completos hacia el 80 %.
  Los rechazos transitorios CDN permiten hasta ocho intentos de la misma URL
  en los instantes 0/0,25/1/2/3/4/5/6 s, dentro de ocho segundos, sin multiplicar
  ese presupuesto por formato. Se omiten turnos vencidos con 50 ms de margen
  del planificador; un 429 detiene los reintentos. No se relaja la sonda 206.
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
ha aislado qué campo concreto causó la diferencia. La app final `540521e`
inició las tres por Native sin Legacy, con búsqueda incluida: Epoitaitaye
14191,9 ms, Maite Zaitut! 4873,6 ms y Pupu Eta Lore 1675,6 ms. No cumplen 300 ms.

El ensayo directo final resolvió las tres mediante WEB_EMBEDDED_PLAYER/251:
8033, 7240 y 1188 ms. Pasaron las sondas de inicio/80 % y las comprobaciones de
reproducción inicial, salto y cola. No fue escucha completa en la app. En una
prueba separada, los tres archivos completos fueron idénticos byte a byte a las
referencias 251 obtenidas con yt-dlp y FFmpeg los decodificó sin errores.

La regresión final con búsqueda de las 30 canciones habituales conservó 30 rutas
Native, cero respaldos y ningún fallo distinto del umbral de 300 ms: mediana
592,35 ms, intervalo 463,7–1004,6 ms. Ninguna cumplió ese umbral. No mide EOF ni
continuidad completa. Preparar un reproductor en frío tardó 6,85 segundos en
QuickJS; la caché evita repetirlo para el mismo reproductor, pero YouTube puede
publicar distintos scripts. Ese tiempo y los límites del runtime no miden RSS
de la aplicación ni predicen el rendimiento de Android.

El [informe infantil](informe-contenido-infantil-2026-10-23.md) separa esos
resultados, fallos e historial. La revisión final pasó 196 pruebas Rust y
`cargo check --tests --offline` para Android x86_64/arm64. Además, un harness del mismo decoder pasó 6 pruebas de
aislamiento y el fixture real en un emulador Android 15 x86_64: preparación de
10911,5 ms, con los mismos límites y cuatro firmas/`n` idénticas a V8. No ejecutó
la app, JNI ni ExoPlayer; la reproducción Android y el dispositivo ARM físico
siguen pendientes. No se presenta el corpus de tres canciones como compatibilidad
con todo el catálogo infantil ni como una medición de ausencia de publicidad.

Esta ruta necesita una app nueva; no se distribuye publicando la receta o los
scripts OTA existentes. La PWA necesita su propia integración web. Después de
instalar el motor, éste descubre el reproductor publicado y sus funciones sin
una receta nueva mientras el analizador comprenda su estructura. La renovación
retiene el mutex global de configuración durante la preparación; queda pendiente
medir y mejorar ese coste cuando hay resoluciones concurrentes.

## Continuación: arranque frío

**Criterio vigente del usuario:** los 3,5 s son una referencia para el arranque frío; se acepta cualquier avance pequeño que sea medible y repetible, sin relajar las garantías de identidad, audio original, aislamiento ni límites. Cada mejora debe indicar qué etapa mide: un ahorro local o una llamada IPC menos no acredita por sí solo un menor arranque total. Este criterio no promueve Oficial ni cambia los resultados históricos.

El [informe del 23 de octubre](informe-arranque-frio-2026-10-23.md) recoge primero
`8983e26`, la comparación consecutiva con el binario anterior y los hashes.
QuickJS C O2 reduce la mediana offline de preparación de 7804 a 6604 ms;
el bundle, los límites y el aislamiento no cambian. Debug ya usaba O2.
En la app, el decoder persistente cargó en 115–141 ms tras reiniciar, incluida
descarga de la fuente, pero el arranque total siguió condicionado por CDN.
Las seis búsquedas infantiles usaron Native sin Legacy y todas superaron
300 ms. La regresión de 30 conservó Native sin respaldo, con mediana 587,55 ms.
Los tres archivos completos siguen coincidiendo con las referencias; no se
acreditan escucha completa en la app, publicidad vista/saltada ni rendimiento Android nuevo.

En su [segunda ronda](informe-arranque-frio-2026-10-23.md#ronda-2-preparación-selectiva-y-arranque-realmente-frío), `0aa9e1c`,
la preparación selectiva reduce el harness QuickJS a 3887,7 ms sin cambiar los
límites ni las firmas emitidas. Con un vídeo por proceso y disco omitido,
la extracción de los tres infantiles baja de 7617/14160/7667 a 4848/5376/4376 ms.
El total nuevo desde IPC hasta `playing`, sin búsqueda, es 4979/5504/4499 ms;
el control no medía ese total. Son builds debug. Los 1252 ms históricos de Pupu
reutilizaban memoria y no eran un primer arranque. La meta de 3,5 s totales sigue
pendiente; el usuario permite consolidar mejoras sustanciales.
Con búsqueda y decoders reutilizados, los tres casos dieron 5926/5550,9/1492 ms,
todos Native. La regresión conservó 30 Native y cero Legacy, mediana 612,4 ms,
pero sólo 29 IDs esperados: Octopus's Garden eligió otro ID. Ese fallo se conserva
junto con los treinta incumplimientos de 300 ms; no se acredita una tanda completa
aprobada ni EOF mediante estos arranques.
Los controles anterior y nuevo volvieron a elegir el ID esperado, con búsqueda
sin cambios; no prueban equivalencia entre la mezcla 2019 del corpus y Remastered
2009 de Deezer ni borran el fallo observado.
El harness Android 15 x86_64 pasó seis pruebas y cuatro formatos exactos con
preparación de 6747,1 ms, frente a 10911,5 ms en la réplica anterior; los límites
no cambian. Es una medición por versión sin app, JNI, ExoPlayer, audio ni red,
no rendimiento de un dispositivo ARM físico. Se repitieron los tres archivos
completos, idénticos a sus referencias y decodificables sin errores.

La [tercera ronda](informe-arranque-frio-2026-10-23.md#ronda-3-parser-acotado-controles-y-fallos-conservados),
`bef47a7`, especializa dos operaciones del parser privado y exige versiones y
opciones exactas al generar. El par serial QuickJS baja de 4026,4 a 3798,1 ms
(5,7 %), con firmas y límites intactos. No acredita una mejora estable del total:
control frío 6/6 Native frente a 4/6 del candidato, con dos respuestas sólo SABR.
No se encontró un cambio lógico que explique esas respuestas, pero los fallos
se conservan y la recuperación SABR pasa a ser la siguiente prioridad.
El ensayo de dieciséis sondeos no dio una ventaja estable y se retiró; siguen
los ocho habituales. Se corrige además el entorno del banco, que confundía
variable ausente y vacía, y se conserva la primera comparación invalidada.

Los 30 temas habituales dieron Native sin Legacy e IDs correctos, mediana
630,85 ms y rango 474,1–1218,1 ms. El usuario acepta aproximadamente 600 ms como
base provisional de ese camino; no se garantiza ese máximo por canción.
300 ms queda como aspiración y 3,5 s fríos infantiles sigue pendiente.
Pasan 430 pruebas JavaScript, 210 Rust y checks Android. El harness Android
mantiene salida exacta, pero 7073,8 ms frente a 6747,1 ms en réplicas únicas
no demuestra mejora móvil. La descarga completa inicial fue 2/3; la réplica
diagnóstica obtuvo 3/3 idénticos y decodificables, sin borrar el primer fallo.
No se usan Premium ni nuevos datos publicitarios para aprobar este cambio.
El bundle nativo requiere una app nueva; no llega por OTA ni cambia la PWA.

La [cuarta ronda](informe-arranque-frio-2026-10-23.md#ronda-4-anticipo-de-metadatos-y-diagnóstico-sabr),
`3fa0237`, inicia antes el POST público de metadatos y mantiene su resultado y
errores en cuarentena hasta verificar watch y ST. El parser y sus límites siguen
iguales. Los diagnósticos distinguen respuestas SABR, renovación efectiva y un
segundo análisis sin emitir URLs, firmas ni visitantes. El candidato obtiene
6/6 Native en dos intentos por cada canción infantil; el control, 5/6. Epo pasa
de mediana 5284,5 a 4658,5 ms, pero no se puede separar la variación de red/SABR
de la mejora. Pupu tarda 9813 ms en una recuperación con otro JS: los 3,5 s
siguen pendientes. Con búsqueda, dos infantiles usan Native y Pupu requiere
Legacy tras dos SABR. Las 30 habituales conservan Native e IDs correctos,
mediana 642,15 ms. No se promociona Oficial ni se publica una app o extractor.
Un parser WASM seguro de 6,5–8,4 s y un ajuste GC con sólo 3,9 % en un par se
descartan; las fuentes y evidencias del experimento quedan fuera de Git.

La [quinta ronda](informe-arranque-frio-2026-10-23.md#ronda-5-renovación-temprana-y-presupuesto-compartido),
`80100dd`, prepara una renovación al detectar SABR provisional, después de la
admisión de watch. Conserva el primer análisis mientras descarga la alternativa;
sólo lo cancela si la fuente completa tiene otro SHA y la petición cambia por
campos independientes del ST. Una fuente idéntica reutiliza el análisis. Si sólo
cambia el reproductor, espera los ST de ambos análisis completos antes de decidir
si corresponde el segundo POST. No acepta una respuesta por su ST provisional.
El máximo es una renovación y dos POST de esta ruta. La preparación comparte
un plazo absoluto de 12 segundos, incluidas sus colas, descargas y renovación,
sin reiniciarlo al sustituir el análisis; el plazo exterior sigue en 30 segundos.
Se mantienen identidad, audio original y sonda estricta 206, con los mismos
ocho sondeos y presupuesto CDN. Pasan 226 pruebas Rust, con 27 ignoradas,
430 JavaScript, tipos y checks Android arm64/x86_64 sin avisos nuevos.
Los 24 casos A/B completan, 12 por binario. Las medianas control/candidato son
4508/4519 ms en Epo, 4532,5/4541,5 en Maite y 4507,5/5090 en Pupu. Ninguno de
los 12 candidatos ejercita la renovación temprana; un control separado de
6279 ms sí registra cancelación real de AST1 y análisis de AST2, sin cuantificar
una ganancia. Las 30 habituales conservan Native, sin Legacy, con mediana
703,1 ms y rango 491,2–1358,1. Con búsqueda, Epo usa Legacy en 4064,5 ms;
Maite y Pupu usan Native en 4869,7 y 1820,4 ms. El proceso usa FreshDecoder:
Epo es el primer caso, Maite realiza el primer análisis efectivo y Pupu reutiliza
memoria. Los tres archivos completos coinciden con sus
referencias y FFmpeg termina con código 0. La evaluación permanece en la rama:
no acredita mejora de velocidad ni recuperación universal de SABR, y los 3,5 s
siguen pendientes. No se añaden campañas para escoger mejores resultados.

La [sexta ronda](informe-arranque-frio-2026-10-23.md#ronda-6-clang-parser-y-configuraciones-canary), `093bb35`–`ab50207`, corrige el rechazo de configuraciones oficiales con sufijo canary y mejora la preparación nativa mediante Clang/dispatch directo y el parser privado especializado. La primera resolución foreground adelanta únicamente dos GET públicos, acotados y vinculados al ID; conserva admisión, ST completo, audio original y sondas estrictas. En la tanda final anónima, con búsqueda y un proceso nuevo/FreshDecoder por intento, Epo tarda 3410,7/3360,1 ms y Pupu 3328,3/3466,9 ms: Native sin Legacy y dentro de 3,5 s. Maite tarda 5484,9/4390,4 ms, con rechazos CDN iniciales; el objetivo consistente sigue pendiente. Los doce controles/candidatos usan Native e ID correcto. Se conservan también los fallos y tiempos anteriores, sin atribuir la variación de CDN al adelanto de 25 ms. Las 30 habituales mantienen Native/IDs, mediana 699,95 ms y máximo 3523,6 ms, sólo en el inicio breve. Los tres archivos completos vuelven a coincidir con sus referencias y decodifican sin errores. Android arm64/x86_64 compila sin avisos nuevos en ab50207; no se midió rendimiento móvil ni Premium. Requiere una app reconstruida: no llega con una receta OTA ni cambia la PWA. Siguen pendientes main/youtubei.js 18.3 y CI con su LLVM concreto; Oficial no se promueve y Propio conserva Legacy.

La [séptima ronda](informe-arranque-frio-2026-10-23.md#ronda-7-decodificador-mínimo-y-transporte-compartido-de-music), `98f964b`/`a32092b`, carga sólo el código de ejecución para firma/n y comparte el transporte Music sin compartir cookies ni cabeceras de identidad. Preserva límites, worker, validación original y ST; el ABI de caché incluye los dos assets. En seis pares fríos mejoran búsqueda 617→503 ms y descifrado 41→24 ms, pero el total empeora 3972,7→5428,4 ms al registrar más esperas CDN. Sólo 1/6 cumple 3500 ms en cada brazo; doce Native e IDs correctos, sin Legacy. No se presenta como mejora estable de arranque ni se repite para seleccionar resultados mejores.

**Arranque frío, octava ronda:** un único A/B frío, anónimo y con búsqueda, no acredita mejora al conservar el contexto oficial del embed: mediana 3649,15→3950,70 ms, cuatro de seis pares peores. Los doce son Native/ID correcto y cero Legacy; sólo 1/6 y 2/6 cumplen 3500 ms, todos Pupu. `fa46e10` se retiró con `ab7f7ff`; código y binario de banco vuelven a R7. ALR, secundario publicado y cver no adelantaron el CDN en sus muestras; el estudio temporal no justifica un nuevo umbral o más sondas. El contexto previo fue inconcluso y conservó seis SABR sin repetirlos. Candidato: 248 Rust pasan en serial tras un timeout del decoder en el pase paralelo; no se amplían límites. No se repiten 30 canciones, archivos completos, Android, Premium o anuncios para un candidato descartado: las pruebas R7 siguen siendo históricas. Persiste la meta estable de 3,5 s, sin publicación. [Informe y seis pares](informe-arranque-frio-2026-10-23.md#ronda-8-diagnóstico-del-cdn-y-candidato-retirado).

Las 30 habituales mantienen Native/IDs, mediana 737,45 ms; sólo se observa el prefijo. Los tres archivos completos vuelven a coincidir con referencias y FFmpeg termina con 0. Pasan 245 Rust/30 ignoradas, 436 JS, tipos y ambos checks Android sin avisos nuevos; no se mide rendimiento móvil. El diagnóstico de range query no mejora los 403 y rechaza un 200 sin Content-Range: se conserva el método y calendario actual. Oficial no se promueve y Legacy sigue como respaldo; requiere app reconstruida, sin cambio de PWA ni receta OTA.

**Arranque frío, novena ronda (`4bace13`, `cb592e2`):** seis copias JSON evitadas; ahorro medio local de 29/128/176 µs por HTML en depuración. Descartar ambas precargas pasa de dos cancelaciones IPC a una, pendiente de medir en la app. La tanda habitual conserva 30 Native/IDs, cero Legacy y mediana 631,7 ms. La candidata fría usa Native 6/6, pero no acredita un menor total; se conservan el control con Legacy y el fallo de codificación del banco. [Resultados, límites y experimentos descartados](informe-arranque-frio-2026-10-23.md#ronda-9-mejoras-pequeñas-y-medición-del-total). Oficial sigue experimental.

**Arranque frío, décima ronda:** A (`06823dc`) se retiró con `91c1d44`; B (`114df0b`) se conserva como mejora acotada de espera: en 4/12 candidatos, la respuesta 206 se completó 467–475 ms antes del antiguo turno de 2 s. La media observada de ventana CDN baja 1117→944 y 856→606 ms entre procesos; no demuestra menor total: 8/12 pares empeoran. Pasan 247 Rust/30 ignoradas y compilan Android arm64/x86_64; sin nueva evidencia de rendimiento móvil, EOF, anuncios o Premium. Requiere app reconstruida; OTA y PWA siguen iguales. Rige el criterio incremental sin relajar garantías; Oficial sigue experimental. [Informe R10](informe-arranque-frio-2026-10-23.md#ronda-10-oportunidad-adicional-durante-la-espera-del-cdn).

**Arranque frío, undécima ronda:** el diagnóstico (`ef6c194`) acompaña la preconexión (`506986a`), retenida por un ahorro acotado observado de DNS de ≈1,97 ms en 12/12 pares; ninguna de las 24 primeras respuestas del reproductor registra reutilización TCP/TLS.
El total mejora en 7 pares y empeora en 5: mediana pareada −28,1 ms y agregada 4382,45→3980 ms, sin mejora consistente entre cohortes (C1 mejora, C2 empeora).
Los 24 casos conservan Native e ID correcto, sin Legacy; pasan 254 Rust/30 ignoradas y ambos checks Android, sin medir rendimiento móvil.
Se aceptan avances pequeños medibles y repetibles sin relajar garantías; 3,5 s sigue como referencia y Oficial permanece experimental.
Requiere app reconstruida; PWA y OTA siguen iguales. [Informe R11 y límites](informe-arranque-frio-2026-10-24.md).

**Arranque frío, duodécima ronda:** `21e0fa6` se retira con `fedec82`: preconexión `anonymous` sin reutilización TCP/TLS (0/12 control, 0/11 candidata, un dato ausente). Control 12/12 Native; candidata 11/12 y Pupu sin reproducción por SABR-only antes de llegar al hint, conservando el timeout de 90 s. No se entrega otra canción ni se atribuye el fallo al atributo. Once pares: seis mejores/cinco peores, mediana del cambio −83,1 ms, sin mecanismo confirmado. Pasan 254 Rust; código restaurado a R11, sin cambio de OTA/PWA ni publicación. «Ni, Ni, Ni!» (`NGp3dh-hBe8`) se comprueba aparte: Native e ID correcto, sin Legacy ni sesión, 5234,7 ms con búsqueda en un intento frío. [Informe R12, límites y pendientes](informe-arranque-frio-2026-10-24.md#ronda-12-preconexión-anónima-descartada).

**Arranque frío, rondas 13–14:** el atajo ASCII del parser se descarta antes de integrar (sólo 3/8 pares mejoran). `38a4ded` conserva el decoder en disco 30 días, con descarga actual y URL/SHA/ABI/checksum exactos; RAM sigue a seis horas. Ensayo con caché controlada de doce horas: 24/24 Native/ID, cero Legacy; 23 filas y once pares elegibles por un archivo de DB de PID antiguo. Preparación 2741,6→66,1 ms; Pupu 3532,1→1706,1 ms, pero Maite empeora 3/4 pares, con mayor ventana CDN observada. Mediana del cambio total en once pares −53,6 ms; sin mejora uniforme ni efecto en primer uso con caché vacía. Pasan 256 Rust y checks Android arm64/x86_64. Pendiente solapar POST de metadatos y `watch` al acertar la caché. [Informe R14 y límites](informe-arranque-frio-2026-10-24.md#ronda-14-conservar-el-análisis-verificado-entre-días). Requiere nueva app; sin OTA/PWA, promoción de Oficial ni publicación.

**Arranque frío, ronda 15:** `025f9e8` solapa el POST de metadatos con `watch` en aciertos de disco, tras validar la fuente fresca y liberar COMPILED. Retiene la respuesta hasta admitir identidad; conserva recuperación y máximo dos POST. Comparación anónima con la misma caché en ambos brazos: 24/24 Native/ID, cero Legacy; diez pares elegibles, ocho mejores/dos peores, cambio mediano −270,1 ms (−66,1/−1123,1 ms por cohorte). Espera watch→metadatos 232,35→0,36 ms. Se conservan dos exclusiones de prueba y todas las regresiones; no hay arranque uniforme de 3500 ms ni mejora de primer uso sin caché. Pasan 261 Rust y checks Android. [Informe R15 y límites](informe-arranque-frio-2026-10-24.md#ronda-15-metadatos-en-paralelo-con-caché-verificada). Requiere nueva app; sin publicación ni cambio OTA/PWA.
