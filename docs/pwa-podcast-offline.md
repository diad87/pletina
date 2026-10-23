# Episodios de YouTube sin conexión

La compilación `b698958a8a49ec05`, fuente `f3e890c`, amplía a los episodios de pódcast de YouTube la descarga P1 que ya existía para canciones. Conserva el botón de descarga del programa y la cola serial de la interfaz 0.11.2. Todo se guarda en el navegador, sin servidor intermedio, cuentas ni APK.

## Identidad y descarga

El episodio se resuelve mediante el ID de vídeo guardado en su ficha, sin búsquedas musicales ni sustitución por un título parecido. Se rechaza una respuesta que corresponda a otro vídeo. Música y episodios comparten ahora el constructor `youtubePlayable`, incluida la política de tamaño declarado positivo de hasta 256 MiB y duración finita de hasta 24 horas.

Un formato P1 con esos metadatos permite intentar la descarga del mismo audio seleccionado. El gestor conserva sus comprobaciones: espera la escritura completa de la respuesta opaca en caché, abre exclusivamente esa copia local, compara la duración y exige audio decodificable cerca del final antes de guardar el registro terminado. Una respuesta HTML, una transferencia fallida, una cancelación o un error de cuota no crean una descarga terminada. El tamaño sigue siendo declarado; JavaScript no lee ni calcula un hash del cuerpo opaco.

La descarga utiliza el plazo P1 existente, de 90 segundos a diez minutos por trabajo según la duración, compartido por los reintentos. Esto no garantiza descargar un episodio largo antes de que el proveedor o el navegador interrumpan la transferencia.

## Reproducción y posición

El registro mantiene el identificador de episodio, separado del catálogo musical y de los vídeos añadidos como canciones. Al abrir una copia local, el reproductor no necesita volver a consultar YouTube. Conserva el progreso del episodio y vuelve a abrirlo pausado; Reproducir reanuda desde la posición guardada.

La reproducción de episodios también puede reparar una dirección del cliente primario rechazada por el CDN mediante P1 del mismo vídeo. El permiso explícito de esa reparación sólo se activa para reproducción; renovar una descarga conserva su política anterior. Cancelar una resolución impide que una respuesta tardía se asigne al reproductor.

## Alcance y evidencia

Los episodios RSS conservan su audio directo y su política anterior de descarga. Esta mejora no habilita otro proveedor, no cambia la navegación ni añade un reproductor de vídeo.

La prueba dirigida conserva un control negativo reproducible con el motor anterior y nueve casos nuevos sobre metadatos, límites, identidad, separación de reproducción y descarga, cancelación, copia local y RSS. La validación de navegador usa el botón real del programa y dos episodios HTTP controlados: uno completo y otro con 403/HTML, seguido de recarga, reproducción, seek y restauración de progreso sin proveedores disponibles. Las respuestas AAC son sintéticas; esa prueba no acredita un proveedor real ni un teléfono físico.

La suspensión del navegador puede interrumpir descargas. Las pruebas físicas de esta versión en Android e iPhone, pantalla apagada y segundo plano permanecen pendientes. Tampoco se afirma disponibilidad universal de YouTube ni solución de sus rechazos persistentes.

## Publicación y resultados

Publicada en [Pletina](https://diad87.github.io/pletina/), distribución `ab3ea586689e12e2a5a53f4746efee82a39d3bf7`. El [informe de esta compilación](../artifacts/pwa-e2e/validation-b698958a8a49ec05.json) vincula 856 pruebas de lógica correctas, tipos sin errores ni avisos, 27 comprobaciones únicas de navegador y once comprobaciones de actualización desde 6bd. Las pruebas específicas de episodios pasan en Chrome, Firefox y WebKit de escritorio; los 27 incluyen preparaciones y regresiones, no 27 funciones nuevas.

Los primeros dos observadores confundieron la preparación de sesión por ID exacto y una consulta de metadatos del programa con resolución de otra fuente. Se conservaron sus fallos y fuentes originales. La revisión final exige que la consulta de metadatos sea del programa exacto y quede bloqueada durante la caída de red; sigue rechazando búsqueda musical, peticiones de reproducción remota y datos entregados por proveedores. Repetir las preparaciones no aumenta el total consolidado.

El [workflow](https://github.com/diad87/pletina/actions/runs/40029187417) terminó correctamente y los [33 archivos públicos](../artifacts/pwa-deploy/public-files-b698958a8a49ec05.json) coinciden con sus hashes. La primera consulta pública, realizada mientras Pages seguía desplegando, se conserva separada del resultado final. No se atribuye a esta versión un nuevo ensayo con proveedores reales.
