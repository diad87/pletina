# Auditoría de estabilidad de Pletina

La auditoría cubre Android, Windows, macOS y Linux: instalación, reproducción, recuperación de errores, biblioteca, descargas, actualizaciones y uso prolongado. Su objetivo es encontrar fallos reproducibles y exigir evidencia por plataforma antes de declarar una versión estable. La [ejecución del 8 de octubre de 2026](auditoria-estabilidad/resultado-2026-10-08.md) termina sin aprobación: reproduce defectos y documenta la cobertura parcial y los bloqueos de hardware. Este documento conserva el plan y sus criterios de salida.

La referencia inicial es **0.10.0**, commit `2d679e477d906682974d2ee763d3cf09c5b4a7a2`. Se comparará con 0.9.0 y 0.9.1 cuando el comportamiento o la actualización lo requieran. Cada candidato corregido se identificará con su propio commit y SHA256 del instalador. Una corrección cambia la referencia de la ejecución siguiente; no convierte en aprobadas las pruebas anteriores.

El [seguimiento de correcciones del 8 de octubre](auditoria-estabilidad/correcciones-2026-10-08.md) documenta los cambios posteriores y su validación independiente.

Hay **70 casos preparados**: 22 específicos de Android, 24 de escritorio y 24 de núcleo y datos. El [índice de casos](auditoria-estabilidad/casos.md) permite revisarlos por área. Cada caso se expande en sus versiones, arquitecturas y dispositivos; los casos que comparten recorrido pueden reutilizar una misma evidencia si acredita todos sus resultados esperados.

Quedan fuera iOS, versión web, publicación en Play Store y radio de canción o artista, por decisión del usuario. Android Auto entra como integración multimedia, separada de usar el teléfono por Bluetooth en el coche.

## Hallazgos y observaciones de partida

| Evidencia | Resultado y alcance |
| --- | --- |
| Control Android de 0.10.0 | Bloques Kotlin originales ejecutados con dobles de Android y ExoPlayer reproducen acumulación de reintentos después de recuperarse, reintentos que deshacen una pausa o afectan a otra pista y reanudación al volver la red pese a una pausa. No reproduce una radio móvil física. |
| Reproductor de escritorio de 0.10.0 | 23 pruebas previas pasan. De 11 adicionales, 8 pasan y 3 fallan: búfer detenido sin vigilancia, error silencioso al reanudar y reanudación sin límite de espera. Audio, IPC y reloj están simulados. |
| APK público | Instalación limpia y actualización 0.9.1 a 0.10.0 correctas en Android 15 emulado con traducción ARM64. Firma y SHA256 correctos. No valida el teléfono del forero ni la conservación de una biblioteca poblada. |
| Red real | Cuatro búsquedas, siete vídeos y 28 lecturas parciales de audio correctas con el extractor nativo. No equivale a siete reproducciones completas ni a una prueba de cobertura móvil. |
| Instalación fallida del foro | Sigue sin causa identificada. El APK sólo incluye ARM64 y declara Android API24 como mínimo. Hay que identificar dispositivo, APK, firma previa y error de instalación. |
| Canción fallida del foro | Sigue sin identificar. Registrar título, artista, enlace o vídeo elegido, plataforma y versión antes de atribuir causa. |

Los registros previos están en `D:\tmp\pletina-forum-bugs-20261008`. La [matriz de casos](auditoria-estabilidad/cases.json) conserva estados previos y pasos; el [registro inicial](auditoria-estabilidad/baseline.json) distingue pruebas simuladas y pruebas de red o instalación.

## Entornos que deben validarse

| Plataforma | Matriz necesaria | Evidencia disponible y trabajo pendiente |
| --- | --- | --- |
| Android | Teléfono ARM64 de recursos limitados y uno de uso habitual; API24 declarada y versiones modernas disponibles; un dispositivo con gestión de batería del fabricante; Bluetooth y Android Auto por separado. | Emulador API35 disponible. Falta teléfono ARM64, cobertura real, reposo prolongado y coche. ARM64 traducido no sustituye hardware ARM64. |
| Windows | Windows 11 x64 limpio y actualizado; WebView2 presente, ausente y antiguo; usuario normal; instalación y actualización desde dos versiones. Verificar Windows 10 si se pretende anunciar compatibilidad. | Equipo local Windows 11 Pro, versión 10.0.26200. Las pruebas destructivas o de WebView2 requieren VM o perfil desechable. |
| macOS | Apple Silicon e Intel; versión mínima declarada 11.0 y una versión reciente realmente disponible; instalación descargada, primer arranque, actualización y audio WKWebView. | CI compila un paquete universal. No hay Mac local identificado. Falta reproducción y ciclo de vida en ambos tipos de hardware. La versión mínima del manifiesto no acredita compatibilidad efectiva. |
| Linux | Ubuntu 22.04 y 24.04 x64; AppImage y DEB; entorno sin códecs extra ni Node del usuario; X11 y Wayland si se anuncian; permisos de archivos y reposo. | Existen pruebas de AppImage empaquetada, GStreamer y WebKitGTK. Repetir con el instalador exacto del candidato y una máquina limpia. WSL sirve para parte de la automatización; no acredita audio ni suspensión de un escritorio físico. |

Anotar sistema, arquitectura, dispositivo, memoria, motor web, motor de audio, instalador y red. Los sistemas no disponibles quedan **bloqueados**, no aprobados por extrapolación. Un solo equipo puede compartir varias sesiones, pero cada arquitectura y mecanismo de reproducción conserva su resultado.

## Corpus de reproducción

Mantener fixtures locales estables y una lista fechada de contenidos remotos disponibles. Usar identificadores y huellas para comparar versiones; comprobar disponibilidad antes de interpretar un fallo remoto como regresión.

| Grupo | Muestra mínima | Comprobaciones |
| --- | --- | --- |
| Música de catálogo | 30 pistas: búsquedas exactas, tildes, versiones, artistas homónimos, temas largos y cortos. | Coincidencia elegida, inicio audible, cambio automático, cola, mezcla, repetición y error de fuente. |
| Enlaces YouTube | 10 enlaces, incluyendo vídeo, Music y Shorts; un enlace retirado como negativo. | Identidad persistente del vídeo, renovación de URL y respuesta comprensible si no está disponible. |
| Pódcast RSS | Tres episodios, uno de al menos dos horas; MP3 y AAC cuando el catálogo los ofrezca. | Inicio, búsqueda temporal, pausa, velocidad si está disponible, redirecciones y continuidad con pantalla apagada. |
| Pódcast YouTube | Tres episodios, uno de al menos dos horas. | Extracción, reproducción y renovación durante una sesión larga. Se distingue de RSS aunque el título coincida. |
| Archivos y descargas | MP3, AAC/M4A, FLAC, Ogg/Vorbis, Opus y WebM donde sean funciones soportadas; archivo vacío y truncado. | Decodificación, duración, seek, fin real, reproducción sin conexión y error acotado. La biblioteca de archivos locales Android no se añade como función nueva. |

Para afirmar que una pista reproduce, observar avance real del tiempo y salida de audio capturada o audición registrada. Un HTTP 206, un evento `playing` simulado o metadatos visibles sólo acreditan su propia capa.

## Matriz de red y acciones concurrentes

Aplicar a música, RSS y pódcast YouTube, por separado, sobre una cola de tres elementos y sobre una pista larga. Las perturbaciones automatizadas se hacen en un entorno de pruebas, sin cambiar la conectividad del equipo de uso habitual.

1. Red estable como control; arranque frío, caché caliente y URL renovada.
2. Latencias de 100, 500 y 1500 ms, límites de 128 y 64 kbit/s y pérdida del 1 y 5 por ciento. Por debajo del caudal del audio se espera pausa o búfer informado, no continuidad físicamente imposible.
3. Cortes de 2, 10 y 60 segundos, antes del inicio y durante reproducción. Repetir cuatro cortes separados por al menos 30 segundos de audio recuperado para comprobar el contador.
4. Paso Wi-Fi a datos y vuelta; enlace presente sin Internet útil; DNS fallido; HTTP 403, 429 y 5xx; respuesta que no acaba; URL caducada y vídeo retirado.
5. Mientras se recupera: pausar, cambiar canción, buscar otra posición, cambiar cola, quitar una descarga y cerrar la interfaz. El resultado tardío de una operación anterior no debe gobernar la nueva.

Registrar intención del usuario, pista y token de operación, número de intento, posición y avance, conectividad observada, código de error y tiempos monotónicos. La presencia de transporte y la posibilidad de alcanzar el origen son señales distintas; se prueban ambas.

## Datos instalación y actualización

Preparar una biblioteca sintética con favoritos de canciones y artistas, programas y episodios RSS y YouTube, listas, historial, cola y descargas. Guardar una copia consistente de SQLite, sus recuentos y relaciones, además de las huellas de los archivos. Con WAL activo, usar copia de seguridad coherente o cerrar el proceso; copiar sólo el archivo principal mientras escribe no basta.

Probar instalación limpia, actualización desde 0.9.0 y 0.9.1, reapertura tras interrupción de escritura y recuperación después de disco lleno o permisos denegados. Las versiones 0.9.0 y 0.9.1 parten del esquema 5; el candidato 0.10.0 llega al 7. La prueba existente de migración 6 a 7 no sustituye la secuencia completa 5 a 7.

Ninguna prueba de estabilidad exige borrar la biblioteca habitual, cambiar certificados del equipo o degradar una instalación personal. Para interrupciones y errores de almacenamiento usar perfiles, aplicaciones de prueba o máquinas desechables. Un fallo de firma o paquete debe diagnosticarse antes de proponer desinstalar. No se presupone que el downgrade sea compatible con una base de datos migrada.

## Sesiones prolongadas y recursos

Ejecutar por plataforma una sesión de música de ocho horas y un pódcast de al menos dos horas. Añadir 100 transiciones de pista, 50 pausas y reanudaciones, 30 cambios de posición, 10 ciclos de suspensión y 10 cambios de salida de audio. En Android cubrir pantalla bloqueada, segundo plano, ahorro de batería, llamada o pérdida de foco, auriculares y reconexión. Separar la terminación deliberada por el sistema del fallo espontáneo y exigir recuperación posterior.

Tomar muestras de memoria del árbol completo de procesos, CPU, hilos, handles o descriptores, conexiones y archivos temporales cada 30 segundos. Registrar batería en móvil y compararla con una sesión de control en el mismo dispositivo, brillo, red y salida de audio. No extrapolar consumo de un emulador a un teléfono.

Los umbrales siguientes son objetivos iniciales de la auditoría, no garantías ya alcanzadas:

- Cero cierres inesperados, ANR, corrupción, pérdida de biblioteca, reproducción de una pista antigua o reanudación contraria a una pausa explícita.
- En fixture local y red controlada: respuesta visual a controles en menos de un segundo; inicio local p95 menor de un segundo e inicio remoto p95 menor de diez segundos, con al menos 30 muestras por ruta y equipo. Informar arranque frío y caliente separados.
- Ante falta persistente de progreso durante 30 segundos, mostrar un estado veraz y una acción acotada de recuperación. Ninguna espera puede quedar indefinida. Registrar si el límite actual de código incumple este objetivo.
- Tras 15 minutos de calentamiento, comparar ventanas de 15 minutos equivalentes al principio y al final. Un crecimiento sostenido mayor del 20 por ciento y 100 MiB, o crecimiento monotónico de handles, hilos o conexiones, exige investigar. Una subida puntual de caché no demuestra por sí sola una fuga.
- Tras cada interrupción, identidad de pista, posición, cola, favoritos y descargas conservan el contrato del escenario; no hay dos audios simultáneos ni temporales completos contados como descargas válidas.

## Orden de ejecución

| Fase | Trabajo | Condición para avanzar |
| --- | --- | --- |
| 1 | Fijar commit, binarios, corpus, biblioteca sintética y entorno. Registrar 0.9.0 como control donde proceda. | Evidencia identificable y entorno aislado. |
| 2 | Tipos, compilación, pruebas del núcleo y regresiones de reproducción. | Defectos conocidos identificados; ningún fallo se oculta para poner la ejecución en verde. |
| 3 | Reproducir los fallos Android y escritorio con el runtime real; corregir en un candidato independiente y repetir. | Fallos cerrados con prueba antes y después. Preparar el plan no los marca como corregidos. |
| 4 | Instaladores, actualización, base de datos, descargas y fallos de almacenamiento. | Sin pérdida de datos ni bloqueo de arranque. |
| 5 | Audio y perturbaciones de red en cada plataforma y arquitectura. | Estados correctos y recuperación repetible. |
| 6 | Sesiones largas, suspensión, foco, Bluetooth y Android Auto. | Evidencia de duración completa, métricas y controles correctos. |
| 7 | Consolidar defectos, repetir las rutas afectadas en el mismo commit final y emitir resultado por plataforma. | Criterios de salida cumplidos o limitaciones explícitas. |

No se fija una fecha de aprobación a partir del tiempo de compilación. Las sesiones de ocho horas pueden ejecutarse en paralelo en equipos separados. Si falta un Mac, un teléfono o un coche, su validación conserva el estado pendiente.

## Automatización preparada

Desde la raíz del worktree, con dependencias instaladas mediante `npm ci`:

```sh
node scripts/audit-stability.mjs --profile quick --dry-run
node scripts/audit-stability.mjs --profile quick
node scripts/audit-stability.mjs --profile core
node scripts/audit-stability.mjs --profile data
node scripts/audit-stability.mjs --profile network
```

El perfil `quick` ejecuta comprobación Svelte y TypeScript, pruebas previas del reproductor, favoritos de pódcasts, regresiones del foro y build de interfaz. `core` ejecuta pruebas Rust normales con un único trabajo y un único hilo de pruebas; los casos ignorados siguen omitidos y se anotan como tales. `data` ejecuta pruebas del frontend de importación y descargas; sus aserciones de robustez se distinguen de defectos demostrados del backend. `network` ejecuta la sonda de búsqueda y audio real con el código del tag; necesita Internet y no prueba salida audible. Los harnesses adicionales de SQLite y transporte tienen instrucciones en [README-audit.md](../scripts/tests/README-audit.md).

Cada ejecución crea una carpeta nueva en `artifacts/stability/` con JSON, commit, cambios locales, entorno, comandos, duración y un log por suite. `--out carpeta` permite elegir otra carpeta base. Un fallo conserva código de salida distinto de cero; herramienta ausente se registra como bloqueada y un vencimiento como timeout. La aprobación de las suites no aprueba automáticamente los casos manuales.

Requisitos de `core` y `network`: Rust y herramientas nativas disponibles en la sesión. En Windows usar un entorno de compilación MSVC; en Linux instalar las dependencias del workflow cuando se compile Tauri. `CARGO_TARGET_DIR` puede dirigir la caché a una carpeta de auditoría. No se usan claves de publicación para estos perfiles.

Para comprobar un AppImage ya construido, ejecutar los scripts existentes `scripts/test-linux-appimage.sh` y `scripts/tests/linux-playback.py` con ese artefacto y guardar SHA256 y logs. Para Android, seguir el aislamiento y las pruebas instrumentadas descritas en [Android Auto](android-auto.md), verificando el ID `.autotest` antes de sembrar datos. Esa documentación contiene resultados históricos y no acredita por sí sola el candidato actual.

Los controles JVM de reintentos están en `D:\tmp\pletina-forum-bugs-20261008\android\run-harness.ps1`; antes de ejecutarlos sobre un candidato, adaptar la ruta del generador y verificar el hash que emite. Aún no son una suite portátil del repositorio. La matriz distingue automatizaciones listas, adaptables y pendientes.

La CI actual comprueba tipos, pruebas de reproductor y favoritos, compilación de los instaladores y núcleo Rust en escritorio; Linux añade reproducción de la AppImage. El trabajo Android compila el APK. Todavía no incorpora toda esta matriz, sesiones largas, validación física ni los nuevos fallos de regresión. Preparar esta auditoría no modifica ni dispara el workflow de publicación.

## Evidencias y resultado por caso

Usar la [plantilla de resultado](auditoria-estabilidad/result-template.json). Cada caso debe incluir identificador, versión, commit, plataforma y dispositivo, pasos efectivos, esperado y observado, inicio y fin, repeticiones, perturbaciones y archivos de evidencia. Registrar los casos sin ejecutar como pendientes; los que necesitan un recurso ausente como bloqueados; los que se omiten requieren motivo y no cuentan como aprobados.

Adjuntar según el caso: logcat y estado del servicio Android; logs de aplicación y fallos del sistema; captura de audio o confirmación auditiva; vídeo de controles; huellas y comparación de SQLite y archivos; resultados JUnit o TAP; series de CPU, memoria y energía. Para fallos de streaming registrar origen, vídeo o episodio y código HTTP. Evitar guardar credenciales, URLs firmadas completas o bibliotecas personales en artefactos que puedan publicarse.

## Criterios de salida

La prioridad de un caso indica su orden y el riesgo que debe cubrir; la severidad del defecto se asigna al observar el impacto. **P0**: pérdida o corrupción de datos, instalación que inutiliza datos existentes, cierre o bloqueo general reproducible. **P1**: reproducción rota en una ruta soportada, saltos indebidos, espera sin límite, control que contradice la intención del usuario o actualización que falla de forma reproducible. **P2**: degradación recuperable con impacto limitado y alternativa demostrada. Ajustar severidad según el impacto reproducido, conservando la justificación.

Para dar por aprobada una plataforma, todos sus casos P0 y P1 deben pasar sobre el mismo candidato final, con el hardware y formatos que se pretenden soportar, y completar sus sesiones largas. Un P0 o P1 bloqueado impide declararla validada. Los defectos intermitentes corregidos requieren al menos 20 repeticiones del disparador y una sesión larga posterior. Los P2 abiertos se enumeran con impacto y límite conocido.

Una versión puede tener resultados distintos en cada plataforma. La conclusión final debe decir exactamente cuáles se han aprobado y cuáles siguen pendientes; ningún conjunto finito de pruebas permite prometer que nunca fallará.
