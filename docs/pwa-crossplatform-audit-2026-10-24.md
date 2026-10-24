# Verificación multiplataforma de Pletina PWA

La versión publicada durante el cierre de esta auditoría es `bbdda9c0c16f145e`, fuente de producto `5a6967c`. Incluye la corrección de contadores de más de una hora (`af7f849`): `59:59` pasa a `1:00:00`; también se formatea la duración total y las posiciones guardadas. La entrega `dced66a0c3e715b5` publicada antes con esa corrección fue sustituida por la entrega concurrente de letras y transcripciones. No se ha sobrescrito esa entrega posterior.

## Qué se ha comprobado

| Entorno | Evidencia | Alcance y límite |
| --- | --- | --- |
| Windows, Chrome 153 | Instalación automatizada 6/6; escritorio 51 comprobaciones correctas, 1 confirmación nativa no automatizada | Registro de PWA en un perfil de prueba, ventana independiente, cierre y reapertura del navegador, almacenamiento y reapertura sin red. La instalación usa CDP; no prueba el diálogo nativo ni un acceso del menú Inicio. |
| Windows, Firefox 153 | 50 comprobaciones correctas y 1 confirmación nativa no automatizada sobre `bbdd`; suite amplia anterior sobre `dced` conservada | Navegador real de Windows. La vista estrecha no equivale a Android. Biblioteca y responsive completos más diez casos de audio seleccionados. Los casos de instalación Chrome no se atribuyen a Firefox. |
| Linux, Chromium 151 en WSL2 | Instalación 6/6 y smoke 3/3 sobre `bbdd`; base de escritorio `dced`: 50 correctas, 1 fallo de señal offline, 1 confirmación nativa no automatizada | Binario Linux real. No es un escritorio Linux gráfico físico. Se usa `--no-sandbox` porque el entorno WSL ejecuta como root. |
| WebKit 26.5 en Linux, disposición iPhone | 11/11 comprobaciones finales sobre `bbdd`; suite amplia anterior y fallos preservados | No acredita Safari en macOS, un iPhone real, instalación de iOS ni políticas de suspensión del sistema. |
| Xiaomi 15T Pro del usuario | Confirmación directa: «Muestra horas y sigue sonando» | Tras pedir actualizar, abrir un pódcast largo, adelantar al minuto 61 y bloquear 30 segundos. No se leyó el hash instalado ni se reconfirmó desde qué icono se abrió. |
| iPhone físico | Instalación y música confirmadas por el usuario en una entrega anterior | No hay iPhone disponible para repetir la batería actual. |
| Mac físico | Pendiente | No hay Mac ni Safari de macOS disponibles. |
| Android Auto / CarPlay | Sin integración nativa de automóvil en esta PWA | Las pruebas de navegador y MediaSession no acreditan esos sistemas. |

Las 956 pruebas de lógica pasan y la comprobación de tipos termina sin errores ni avisos sobre las fuentes actuales. Las cuatro corridas finales suman 115 comprobaciones correctas, cero fallos y dos confirmaciones nativas fuera del runner; las doce comprobaciones de instalación se presentan por separado. Los números por navegador incluyen preparativos y pruebas agrupadas; no representan ese mismo número de funciones distintas. No se suman reejecuciones de un caso para aumentar la cobertura.

La cobertura de escritorio recorre búsqueda y selección de la fila completa, artista y disco, favoritos, listas e importaciones, metadatos personales, controles y posición, aleatorio/repetición, volumen, cola y orden, temporizador, descargas de colección, reapertura sin red, siguiente canción local y progreso de pódcasts. La copia de seguridad se comprobó mediante descarga y subida reales del archivo en Chrome y Firefox: 20/20 comprobaciones sobre la base `a2`, sin atribuirlas como una reejecución sobre `bbdd`.

## Contador de pódcasts

Además de los cuatro casos de lógica añadidos, se generó un AAC silencioso real de 3930 segundos y se sirvió mediante respuestas HTTP RSS/audio controladas. La PWA compilada decodificó el archivo; la barra visible se adelantó a 3599, 3600 y 3929 segundos, mostrando `59:59`, `1:00:00` y `1:05:29`, con total `1:05:30`. La captura se revisó visualmente. No se esperó una hora ni se afirma haber escuchado completo el archivo.

El primer observador adelantaba al final exacto: el reproductor terminaba la cola y volvía a cero. Se conserva ese intento como error de preparación de la prueba, sin cambiar el producto para ocultarlo. El usuario confirmó después el contador y el audio con pantalla apagada en su Xiaomi.

## Instalación y desconexión

El test de instalación crea un perfil independiente, usa las operaciones CDP de instalación y lanzamiento, verifica el modo `standalone`, reinicia el navegador y retira únicamente su instalación de prueba. Necesita permisos explícitos de automatización del navegador; no reproduce la confirmación nativa de instalación.

La desconexión no se da por demostrada solo por `navigator.onLine`. Antes y después de recargar se solicita una URL nueva fuera del ámbito de Pletina: debe fallar con `ERR_INTERNET_DISCONNECTED`, sin respuesta HTTP ni caché. A su vez, el documento de la app debe proceder del service worker. Esto pasa en Windows y Linux. En Linux la propiedad `navigator.onLine` vuelve a `true` tras recargar pese a esa desconexión acreditada; queda registrada como limitación del entorno de automatización.

Algunas pruebas amplias de cola automática siguen dependiendo de recibir un evento `online` real después de la recarga. Si el protocolo del navegador no lo emite, se conserva el resultado negativo y la cola observada; no se atribuye automáticamente un fallo a Pletina ni se acredita la reanudación por conectividad del sistema operativo.

El control independiente de Firefox 153 en Windows presenta esa limitación de evento. Su comprobación final conserva los tres trabajos y verifica su recuperación en el orden correcto mediante una recarga con red; no la presenta como reanudación automática causada por un evento `online` que no se observó.

La identidad real del manifiesto es `https://diad87.github.io/`, mientras que ámbito y URL inicial son `https://diad87.github.io/pletina/`. Se corrigió el observador, que resolvía `id: "./"` contra una base incorrecta; no se cambió el ID del producto, para conservar las instalaciones existentes. [Reglas de identidad del manifiesto](https://developer.chrome.com/docs/capabilities/pwa-manifest-id).

## Resultados que no se presentan como resueltos

- No hay validación completa en Mac ni repetición de la batería actual en iPhone físico.
- Los controles MediaSession se comprueban como API y callbacks; no como botones reales del sistema o del coche.
- Una descarga que continúa con pantalla apagada y la suspensión del sistema necesitan una prueba física específica. Los navegadores de prueba no la sustituyen.
- La migración real `a2 → dced` con la app cerrada pasa. El intento con la app abierta terminó con navegación abortada y varios cambios de controlador; no se acredita la actualización en caliente. Se recomienda cerrar Pletina y usar «Actualizar y abrir» en la portada.
- Edge no pudo arrancar en el intento de automatización usado aquí. Ese resultado no demuestra un fallo de la PWA en Edge.

## Trazabilidad de la batería

Se conservaron los resultados originales y sus fuentes antes de corregir las pruebas. Había expectativas antiguas de permanecer en Buscar tras reproducir una canción, selectores del minirreproductor móvil usados en escritorio, estado de caché/cola compartido entre casos y un observador de conectividad omitido cuando otro caso ya había instalado el observador de transferencias. Las correcciones son de QA y no sustituyen módulos del producto.

En WebKit, una prueba de caída del origen mantiene `navigator.onLine=true`. Se observó que las peticiones bloqueadas correspondían exclusivamente al siguiente episodio de una cola conservada, mientras el actual se reproducía desde su copia local. La prueba distingue ahora ese escenario: permite como máximo tres precargas fallidas del ID sucesor, ninguna respuesta externa y ninguna petición del episodio actual. Con señal offline real sigue exigiendo cero búsquedas o consultas de audio.

Los informes finales conservan versión, plataforma anfitriona, motor, fuentes de QA y hashes de la distribución. Los canarios de red real sobre la web pública se separan de las respuestas HTTP sintéticas. «Ni, Ni, Ni!» inició audio nativo sobre `dced`; «Without Me» lo hizo sobre `bbdd`. Son comprobaciones de arranque en primer plano, sin afirmar reproducción completa ni pantalla apagada.

[Informe de evidencias por versión y entorno](../artifacts/pwa-e2e/crossplatform-audit-2026-10-24.json).
