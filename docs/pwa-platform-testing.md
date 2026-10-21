# Pruebas por plataforma de la PWA

Revisión del **21 de octubre de 2026**. Esta guía separa la cobertura E2E de funciones de la disponibilidad del entorno donde se ejecutan. La release publicada y verificada en [Pletina](https://diad87.github.io/pletina/) es **`fbb03046132d7478`**, código de producto `6a586c1`, runner `3108698`, commit de distribución `9760e5621d5bea66f0e28bd2c6ece184a2799806`. La [verificación HTTP y SHA-256](../artifacts/pwa-deploy/public-files-fbb03046132d7478.json) pasa **22/22 archivos** y la [prueba pública de la canción solicitada](../artifacts/pwa-port/browser-public-fbb03046132d7478.json), **3/3 comprobaciones**. Son pruebas de distribución y navegador de escritorio; no acreditan un teléfono físico. La [cobertura actual](../artifacts/pwa-e2e/coverage-fbb03046132d7478.md) registra 193 casos correctos de 198; las matrices anteriores permanecen identificadas por su build. El estado de distribución se conserva también en [pwa.md](pwa.md).

El [preflight reproducible](../scripts/tests/e2e/platform-preflight.mjs) genera [platform-preflight.json](../artifacts/pwa-e2e/platform-preflight.json). Comprueba motores y APIs de navegador usando un origen localhost efímero, datos de prueba y un WAV conocido. **No es una prueba E2E de funciones de Pletina**, ni acredita teléfonos, instalación desde la pantalla de inicio o coches. Los recorridos de producto tienen sus propios resultados; la [matriz de paridad](pwa-parity-0.11.2.md) conserva los anteriores.

## Estados y alcance

| Estado | Significado |
| --- | --- |
| `pass` | Se ejecutó y pasó la comprobación concreta descrita. En este JSON significa preflight del motor, no todas las funciones de la app. |
| `fail` | Se ejecutó una comprobación y su resultado no cumplió la condición esperada. |
| `blocked` | Faltó un requisito para ejecutarla, como binario, dispositivo, canal de automatización o sistema anfitrión. No cuenta como prueba superada. |
| `unsupported` | El entorno de ejecución o la distribución no expone la capacidad requerida: API, confirmación automatizable o integración. No cuenta como aprobado ni implica que la función sea incompatible en otro host. La ausencia de una integración de producto, como la de coche, sí requiere implementarla; ampliar el viewport no la crea. |

El resumen nunca debe convertir `blocked` o `unsupported` en `pass`. `allRequestedPlatformsVerified` permanece en `false`: este entorno no verifica físicamente las cuatro plataformas solicitadas. Una fixture comprueba el comportamiento frente a sus respuestas controladas; las consultas a proveedores reales y las pruebas físicas se registran por separado.

## Entorno encontrado y comprobado

Host **Windows**, Node **24.18.1**, Playwright **1.62.1**. Se descargaron los binarios oficiales WebKit y Firefox en `D:/tmp/pletina-e2e-browsers`, fuera del repositorio. Chromium usa el Chrome disponible indicado por `--chrome`. La [documentación de navegadores de Playwright](https://playwright.dev/docs/browsers) explica que cada versión necesita binarios compatibles y permite aislar su ubicación con `PLAYWRIGHT_BROWSERS_PATH`.

| Motor real ejecutado | Versión observada | Preflight | Límite observado |
| --- | --- | --- | --- |
| Chrome/Chromium en Windows | 153.0.8010.52 | Contexto seguro, IndexedDB, CacheStorage, worker activo y WAV tras clic: `pass` | Es Chrome de escritorio; la configuración móvil debe aplicarse en cada suite. |
| Playwright WebKit en Windows | 26.5, binario 2336 | Las mismas comprobaciones: `pass` | `navigator.mediaSession` no está expuesto en este runtime. Su ausencia debe tener un resultado explícito en los casos dependientes de esa API. |
| Playwright Firefox en Windows | 153.0, binario 1538 | Las mismas comprobaciones: `pass` | Es un destino adicional de escritorio, no una simulación del sistema Android/iOS. |

Los tres motores declararon compatibilidad AAC/MP4 mediante `canPlayType`; **ese sondeo no reproduce un MP4**. La reproducción comprobada por el preflight usa un WAV PCM local de un segundo, iniciado con un clic real de automatización. La disponibilidad de códecs depende también del sistema anfitrión. Playwright distingue expresamente su WebKit parcheado de Safari y recomienda macOS para la aproximación más cercana al comportamiento multimedia de Safari. [Fuente oficial](https://playwright.dev/docs/browsers).

El inventario encontró `adb.exe` y `emulator.exe` en el SDK bajo `D:/tmp/nuki-research/android-virtual-bt/sdk-preparation-20261017/sdk`. No encontró `extras/google/auto/desktop-head-unit.exe` en ese SDK. Son comprobaciones de archivos: **no se ejecutó ADB, el emulador, DHU ni un daemon de dispositivos**, ni se averiguó si hay un teléfono conectado. El host Windows no puede ejecutar Xcode/iOS Simulator; Apple publica sus [requisitos de Xcode para macOS](https://developer.apple.com/xcode/system-requirements).

## Qué significa cada destino

| ID del manifest | Ejecución posible aquí | Estado del preflight | Qué sigue sin acreditarse |
| --- | --- | --- | --- |
| `chromium-android-layout` | Chrome con parámetros de pantalla y entrada móvil | `pass` del motor | Chrome Android real, PWA instalada, bloqueo de pantalla, batería, sesión de audio del sistema y recuperación tras cerrar el proceso. |
| `webkit-iphone-layout` | WebKit Windows con parámetros iPhone | `pass` del motor | Safari de iPhone, PWA desde el icono, almacenamiento de Home Screen, permisos y ciclo de vida iOS. |
| `chromium-desktop` | Chrome real de escritorio | `pass` del motor | Funciones no incluidas en los casos E2E ejecutados. |
| `firefox-desktop` | Firefox real de escritorio, adicional | `pass` del motor | Las mismas reservas; no acredita un teléfono. |
| `android-physical` | No hay runner físico configurado en esta ejecución | `blocked` | Requiere evidencia de un Android identificado, build, navegador y protocolo ejecutado. |
| `iphone-physical` | No hay runner físico ni host Apple configurado | `blocked` | Requiere Safari/PWA instalada en iPhone y pruebas de sus restricciones reales. |
| `android-auto` | La PWA estática no expone el servicio multimedia Android | `unsupported` para esta distribución | La APK nativa es otro destino y necesita su propia conexión Android Auto/DHU o vehículo y sus E2E. |
| `carplay` | La PWA no es una app iOS con integración CarPlay | `unsupported` para esta distribución | Proyecto iOS firmado, capacidades CarPlay y pruebas en plataforma Apple/vehículo. |

Playwright [emula parámetros del dispositivo](https://playwright.dev/docs/emulation), como user agent, tamaño, viewport y entrada táctil. Eso permite automatizar diseño, navegación y flujos web con otra configuración; no emula el sistema operativo completo. Los resultados deben conservar `kind: desktop-emulation` y `physical: false`.

## Android Auto

Android Auto descubre y controla las apps de audio mediante un servicio nativo de exploración multimedia y una sesión multimedia. Android documenta las opciones `MediaBrowserServiceCompat` y `MediaLibraryService`, y los [requisitos del servicio](https://developer.android.com/training/cars/media/create-media-browser) y de su [declaración en el manifest](https://developer.android.com/training/cars/media/auto). Una llamada a Media Session de JavaScript no instala ese servicio Android.

La **APK** del repositorio sí contiene [PlaybackService : MediaLibraryService](../src-tauri/gen/android/app/src/main/java/dev/musify/desktop/PlaybackService.kt) y [manifest](../src-tauri/gen/android/app/src/main/AndroidManifest.xml) con servicio exportado, acciones de media y metadatos `com.google.android.gms.car.application`. Es evidencia de implementación nativa, no de funcionamiento probado en Android Auto. La distribución web compilada no contiene ni ejecuta ese componente Java/Kotlin. Por eso se clasifica como `unsupported` el destino **PWA actual → integración multimedia Android Auto**; es una conclusión del contrato oficial y del artefacto, no una prueba negativa en un coche.

El [Desktop Head Unit oficial](https://developer.android.com/training/cars/testing/dhu) puede ejecutarse en Windows, macOS y Linux. Se instala como herramienta del SDK en `extras/google/auto/` y necesita una conexión Android Auto preparada y la app Android instalada. Su mera presencia no demostraría compatibilidad de la PWA. En esta sesión solo se inspeccionaron rutas; no se intentó conectar, iniciar un servicio del teléfono ni eludir el rechazo previo de automatización ADB.

Una prueba nativa futura debe identificar APK/build, versión Android/Android Auto y entorno DHU o vehículo, y cubrir exploración de biblioteca, selección, reproducción/pausa, anterior/siguiente, reanudación, búsqueda/voz, pérdida de conexión y convivencia de audio. Es un plan de prueba pendiente, no un resultado de este trabajo.

## CarPlay

Apple exige una categoría admitida y el entitlement correspondiente para una app integrada. Para audio se usa `com.apple.developer.carplay-audio`; la [solicitud oficial de capacidades](https://developer.apple.com/documentation/carplay/requesting-carplay-entitlements) describe revisión, App ID, perfil de aprovisionamiento y configuración del proyecto Xcode. No se ha solicitado ninguna cuenta, capacidad o servicio de pago en esta tarea.

La PWA actual no incluye un target iOS firmado con escenas/capacidades CarPlay. La clasificación `unsupported` se refiere a esa integración de producto, no a la posibilidad de que un audio de teléfono llegue a unos altavoces. Una página web que suena o unos botones multimedia del navegador no acreditan catálogo, aplicación ni controles CarPlay.

El [simulador CarPlay de Apple](https://developer.apple.com/documentation/carplay/using-the-carplay-simulator) forma parte del entorno Xcode/Simulator y necesita una app habilitada. Apple advierte además que el simulador no basta para validar bloqueo del iPhone, Siri ni convivencia de audio, y recomienda pruebas en vehículo o equipo compatible. Ninguna de esas pruebas puede sustituirse por WebKit Windows o un viewport ancho. Este host no dispone del entorno macOS/Xcode que requieren esas herramientas.

## Repetir el preflight

Con la dependencia Playwright del repositorio instalada, desde la raíz del port:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = 'D:/tmp/pletina-e2e-browsers'
node node_modules/playwright/cli.js install webkit firefox
node scripts/tests/e2e/platform-preflight.mjs --browsers D:/tmp/pletina-e2e-browsers --chrome 'C:/Program Files/Google/Chrome/Application/chrome.exe'
```

La instalación descarga únicamente esos motores a la carpeta indicada. No instala ni sustituye Chrome. `--playwright <directorio>` permite usar un paquete Playwright externo compatible; `--android-sdk <ruta>` añade un SDK al inventario de archivos. `--report <ruta>` cambia el destino JSON y `--inventory-only` evita arrancar navegadores, dejando sus comprobaciones bloqueadas por no haberse ejecutado.

El módulo exporta `PLATFORM_TARGETS` y `runPlatformPreflight({ playwrightPath, browsersPath, chromePath, androidSdk, output, launch })` para el orquestador. El JSON incluye versión de esquema, host, versiones, capacidades observadas, motivos por destino y limpieza. Los errores de una función de producto pertenecen al informe E2E correspondiente; no se convierten en un bloqueo de preflight para ocultarlos.

Cada navegador usa un perfil desechable y se cierra en `finally`; el servidor escucha solo en loopback con puerto efímero y también se cierra al terminar. El worker, la base y la caché de este sondeo viven en esos contextos temporales. No se modifica la distribución publicada, el perfil personal del navegador ni un dispositivo.

## Runner E2E de producto

El [runner central](../scripts/tests/e2e/run.mjs) y su [harness](../scripts/tests/e2e/harness.mjs) abren la distribución compilada desde un servidor efímero, esperan al worker controlador y entran en la aplicación bajo demanda. Playwright controla la interfaz; `Audio` sigue siendo el constructor nativo. El observador de pruebas solo registra eventos y propiedades sanitizadas, sin direcciones de fuentes. Los proveedores se sustituyen en el transporte HTTP mediante [fixtures](../scripts/tests/e2e/provider-fixtures.mjs), con MP4/AAC reales y respuestas de error controladas. No se sustituyen módulos de producto. Se instala el reloj controlado antes de abrir la página; los casos de temporizador pueden adelantarlo. Los gestos DOM sintéticos y esos avances de reloj verifican sus manejadores, no suspensión del sistema, batería ni gestos físicos.

En este host, la interceptación Playwright de Chromium omitió peticiones de los iframes opacos: el gate detectó canciones reales en lugar de fixtures y falló. Repetir con el Chromium oficial de la versión instalada no corrigió ese control. El [diagnóstico Puppeteer](../artifacts/pwa-e2e/network-puppeteer-probe.json) sí interceptó los tres endpoints. Por ello Chromium usa Puppeteer para la red y Playwright para la UI, conectados al mismo navegador desechable antes de crear iframes. `defaultViewport: null` en Puppeteer conserva la emulación configurada por Playwright, y el harness comprueba el ancho real al abrir.

Firefox usa el transporte Playwright. WebKit Linux necesita además un [transporte QA](../scripts/tests/e2e/webkit-network-transport.mjs): su proceso multimedia omitía el routing al quedar la página controlada por el worker, como conserva el [control aislado](../artifacts/pwa-e2e/webkit-aac-controlled-probe-linux.json). Un proxy TLS efímero en loopback entrega el mismo handler de fixtures únicamente para cinco dominios definidos de audio AAC, RSS y portadas; rechaza los demás y no reenvía tráfico a Internet. El certificado de prueba se acepta solo en el contexto desechable mediante `ignoreHTTPSErrors`; no se instala en el sistema. Se conservan URLs, constructor Audio y worker del producto. El proxy, conexiones y certificado se cierran/eliminan en `finally`. El [inventario Linux](../artifacts/pwa-e2e/linux-runtime.json) identifica el runtime Ubuntu bajo WSL2, separado del preflight Windows. Los probes anteriores conservan su configuración original de dos hosts AAC; no se reescriben como evidencia de la allowlist ampliada. Ninguna de estas adaptaciones modifica la distribución ni acredita Safari iOS.

WebKit **26.5 en Windows** mantiene un bloqueo del transporte multimedia, acreditado por su [sondeo de siete controles](../artifacts/pwa-e2e/webkit-aac-probe.json); que el WAV del preflight funcione no resuelve ese problema. Los escenarios multimedia de esa combinación se registran `blocked`. El recorrido WebKit completo se ejecuta por separado en Linux con su transporte QA; un informe Linux no cambia retroactivamente el resultado Windows ni prueba un iPhone.

El [sondeo de almacenamiento WebKit Linux](../artifacts/pwa-e2e/webkit-storage-probe-linux.json) tampoco expone `navigator.storage.estimate`, incluso en contexto seguro y con configuraciones móvil/escritorio. El caso que inyecta una estimación de cuota insuficiente queda `unsupported` en ese runtime: no se inventa la API. Eso no clasifica las descargas como no soportadas ni determina el comportamiento de Safari iOS; los casos separados de error al escribir IndexedDB y de fallo al obtener el medio conservan sus propias aserciones.

Todas las suites incluyen un **gate estricto de fixtures**: búsqueda de QA, primer título esperado y petición de catálogo interceptada. Si falla, sus escenarios dependientes quedan `blocked` con motivo; datos reales inesperados no pueden pasar como cobertura determinista. Un smoke válido comprueba además avance de tiempo del medio real. Las respuestas controladas verifican lógica y UI; la disponibilidad de los proveedores públicos se acredita con otros informes.

El perfil de pantalla y el sistema anfitrión son datos distintos. Tanto `summary.host` como cada `report.host` incluyen `platform`, `arch` y `node`: un resultado `webkit-iphone-layout` en Linux o Windows sigue siendo WebKit de escritorio en ese host, nunca un iPhone. Los controles multimedia y de red deben leerse junto a ese campo.

### Qué significa «sin conexión» en estos recorridos

El [control de navegación](../scripts/tests/e2e/offline-navigation-probe.mjs) y su [seguimiento](../artifacts/pwa-e2e/offline-navigation-followup/report.json) aislaron límites de la automatización al recargar páginas controladas por un worker. En Firefox, la combinación de routing Playwright y `context.setOffline(true)` impedía la navegación; quitar el routing después de desconectar permitió usar la caché sin peticiones al servidor. El harness conserva la red desconectada y suspende solo esas rutas hasta volver a conectar. En Chromium sincroniza el estado de red de las dos sesiones CDP del puente; no reemplaza `navigator.onLine` en JavaScript.

En el control WebKit de este host, la recarga con el modo offline del protocolo falló incluso sin routing. Detener el origen real sí permitió recuperar el documento desde el worker. Por eso el runner usa para WebKit `mode: origin-and-provider-unavailable`: rechaza conexiones al servidor local y bloquea las respuestas remotas de fixtures. En ese modo **`navigator.onLine` permanece `true`** y el resultado lo conserva expresamente; acredita el uso de datos guardados con origen/proveedores inaccesibles, no una desconexión del sistema operativo. Chromium y Firefox usan `mode: browser-offline`, con `navigator.onLine === false`. Los informes registran modo, estado anterior/posterior y expectativas, sin convertir ambas condiciones en la misma prueba.

```powershell
node scripts/tests/e2e/run.mjs --suite smoke --profiles chromium-android-layout,webkit-iphone-layout,firefox-narrow
node scripts/tests/e2e/run.mjs --suite library --profiles firefox-narrow
node scripts/tests/e2e/run.mjs --suite responsive --profiles chromium-android-layout
node scripts/tests/e2e/run.mjs --suite media --profiles chromium-android-layout
node scripts/tests/e2e/run.mjs --suite all
```

También admite `--dist`, `--output`, `--browsers`, `--chrome` y `--puppeteer`. En `all` se ejecutan instalación, biblioteca, diseño/gestos, multimedia e historial final, en ese orden; los perfiles se ejecutan secuencialmente. Cada perfil escribe JSON incremental y captura al fallar. El resumen y el puntero `artifacts/pwa-e2e/latest.json` señalan la ejecución; los controles previos fallidos se conservan en sus carpetas.

`summary.counts` suma **casos de navegador**; `platformCounts` conserva aparte los destinos físicos bloqueados y las integraciones de coche no soportadas. El CLI devuelve error por casos de navegador fallidos/bloqueados o errores inesperados. Un caso `unsupported` permanece identificado y no cuenta como superado: por eso `browserFeatureChecksPassed` exige que todos los casos sean `pass`, aunque un destino no soportado por sí solo no haga fallar el proceso. `allRequestedPlatformsVerified` permanece en `false`.

Los errores originales se conservan. Solo puede excluirse del fallo global un error marcado explícitamente `handledExpected`, después de verificar su alcance y el comportamiento esperado de la UI; el resumen cuenta esos errores aparte. Spotify exige comprobar su explicación visible. Para los diagnósticos CORS de feeds WebKit durante un caso offline se exige además host/ruta exactos, un aborto `offline` inyectado en esa misma petición en los últimos cinco segundos y que el caso complete con éxito sus aserciones de UI/audio guardado. No se ignoran errores CORS generales ni errores de feeds online. Los errores restantes siguen siendo inesperados. Un problema del host o del harness necesita un control que lo aísle antes de clasificarlo como bloqueo; no se usa esa clasificación para ocultar un fallo de producto.

## Resultados E2E actuales: `fbb03046132d7478`

Cada perfil ejecuta la suite completa `all`, con **66 comprobaciones**. El [consolidado actual](../artifacts/pwa-e2e/coverage-fbb03046132d7478.md), sus [datos JSON](../artifacts/pwa-e2e/coverage-fbb03046132d7478.json) y el [resumen de validación](../artifacts/pwa-e2e/validation-fbb03046132d7478.json) conservan el alcance.

| Perfil y host | `pass` | `fail` | `blocked` | `unsupported` | Evidencia |
| --- | --- | --- | --- | --- | --- |
| Chromium Android layout, Windows x64, Chrome 153.0.8010.52 | 64 | 0 | 0 | 2 | [Resumen Windows](../artifacts/pwa-e2e/release-fbb03046132d7478-win/summary.json), [pasos](../artifacts/pwa-e2e/release-fbb03046132d7478-win/chromium-android-layout/report.json) |
| Firefox estrecho, Windows x64, Firefox 153.0 | 65 | 0 | 0 | 1 | [Resumen Windows](../artifacts/pwa-e2e/release-fbb03046132d7478-win/summary.json), [pasos](../artifacts/pwa-e2e/release-fbb03046132d7478-win/firefox-narrow/report.json) |
| WebKit iPhone layout, Linux x64 bajo WSL2, WebKit 26.5 | 64 | 0 | 0 | 2 | [Resumen Linux](../artifacts/pwa-e2e/release-fbb03046132d7478-linux/summary.json), [pasos](../artifacts/pwa-e2e/release-fbb03046132d7478-linux/webkit-iphone-layout/report.json) |

Son **193 correctas, 0 fallidas, 0 bloqueadas y 5 no compatibles de 198**, con cero errores inesperados y cierre de recursos. No se convierten en aprobados la confirmación de instalación física de los tres perfiles, el selector nativo de destinatarios de Web Share de Chromium ni la estimación de cuota ausente en WebKit Linux. Los destinos físicos y coches se contabilizan aparte; `allRequestedPlatformsVerified` sigue en `false`.

Los ocho casos nuevos del [mapa de funciones](pwa-e2e-function-map.md) cubren respuestas CSV en vuelo al cancelar o salir, aborto/rollback y reintento de guardado, cambio de fuente durante reproducción, radio parcial, cancelar «Quitar todas» y dos recorridos de teclado y errores ARIA. El fallo de persistencia aborta una transacción IndexedDB real después de una escritura nativa; no sustituye módulos de aplicación ni demuestra agotamiento físico de disco. El resto de variaciones y la lectura con VoiceOver/TalkBack permanecen fuera de ese alcance.

La [actualización actual, 11/11](../artifacts/pwa-port/update-e2e-fbb03046132d7478.json), verifica entrada mínima sin aplicación previamente abierta, fallo/reintento sin perder A, preparación íntegra antes de activar B, reapertura automática sin consentir otro worker, compatibilidad con entrada antigua y conservación de datos/descargas. La fixture antigua es d0 de QA, no la 4c publicada: su botón secundario permite actualizar y después abrir desde la entrada nueva; no se afirma parche retroactivo de su JavaScript ni migración del icono del SO. Se conservan los negativos de [launcher retirado](../artifacts/pwa-port/update-cold-negative-readywait-d0e466bf9a8d978a.json) y [autoboot de 384](../artifacts/pwa-port/update-bootstrap-negative-autoopen-384c351ffd4fbd4e.json). Los controles de caché mínima y bloqueo de clics siguen siendo aserciones, no excepciones del harness.

El [recorrido standalone actual y su control normal](../artifacts/pwa-e2e/back-root-library-fbb03046132d7478/summary.json) pasa **32/32**, con 22 casos de biblioteca y 10 de regresión, sin errores y con limpieza completa. Conserva documento y Audio mediante la API de historial; **no acredita Atrás UI del navegador ni Atrás del sistema Android**. Ambos canales siguen separados de los aprobados; la repetición física en Xiaomi e iPhone continúa pendiente. Los 32 casos y los 11 de actualización se informan aparte de los 198, sin sumarlos como funciones únicas.

## Regresión histórica de Atrás: `4c2aaa1c19512425`

El código `991f2b2` añade protección de raíz exclusivamente en modo instalado (`display-mode: standalone` o `navigator.standalone`). Desde Inicio, Atrás conserva documento y audio. Un panel abierto se cierra antes de cambiar de pantalla; los paneles anidados reutilizan un marcador preparado al abrir. La compactación del historial conserva la identidad de la vista para no desmontar un formulario o invalidar su callback de menú. Las pestañas normales permiten salir del sitio desde la raíz. No cambia el servicio de navegación nativo de la APK.

Pasan **355/355 pruebas de lógica, incluidas 33 de navegación**, tipos con **0 errores y 0 avisos** y las compilaciones nativa y PWA. El [recorrido de esta versión en ventana standalone de Chrome y su control de pestaña normal](../artifacts/pwa-e2e/back-root-library-4c2aaa1c19512425/summary.json) pasa **29/29**, con **0 errores**: 19 casos de biblioteca y 10 comprobaciones de apertura, regresión e invariantes. No son 29 funciones distintas. El modo standalone es el real de Chrome `--app`, sin sustituir su señal en JavaScript; no equivale a una instalación del sistema operativo. El control de Atrás por API conserva documento y Audio, los paneles se cierran en orden, Adelante se conserva y la pestaña normal puede salir de la raíz. Quedaron cerrados proceso, navegador, contextos y servidor, y se retiró la copia temporal.

El [control negativo de `e40b7797b8e470d8`](../artifacts/pwa-e2e/back-root-contextual-e40b7797b8e470d8/native-app-window/report.json) conserva el fallo del menú de playlist tras compactar el historial: la vista anterior se desmontaba y no aparecía la confirmación. El [control corregido de `4c2aaa1c19512425`](../artifacts/pwa-e2e/back-root-contextual-4c2aaa1c19512425/native-app-window/report.json) pasa **2/2** en ventana standalone de Chrome: la vista permanece conectada, aparece Eliminar y se borra la lista. Es una prueba de aplicación compilada y gestos UI, no un teléfono ni una repetición de toda la matriz multimedia.

La [regresión de biblioteca del build final en pestañas normales](../artifacts/pwa-e2e/back-root-4c2aaa1c19512425-library/summary.json) pasa **42/42** entre Chrome y Firefox, sin fallos ni errores inesperados y con limpieza completa de los recursos de prueba. Este recorrido, los 29 casos de ventana de app/control y el control contextual 2/2 conservan sus propios informes; sus solapamientos no se presentan como funciones únicas adicionales.

El [resumen de validación de aquella corrección](../artifacts/pwa-e2e/back-root-4c2aaa1c19512425-validation.json) reúne esos recorridos y conserva las limitaciones de los canales de entrada. Su entrada pesaba **38.720 bytes** y la aplicación bajo demanda **469.512**, sin comprimir; la actual pesa **41.790 + 469.984 bytes**, respectivamente.

La [documentación de Chromium](https://chromium.googlesource.com/chromium/src/+/main/docs/history_manipulation_intervention.md) distingue `history.back()/forward()` de los botones del navegador: solo estos últimos pueden saltar entradas creadas sin activación del usuario. Por eso los casos de API de historial no se presentan como pruebas del botón UI. En el informe, **`browserUIBack.status: blocked`** y **`androidSystemBackVerified: false`** permanecen separados de los 29 aprobados de la aplicación. En los documentos HTML de control, Alt+Izquierda entrega eventos DOM fiables pero no ejecuta el acelerador de Atrás de Chrome headless; dentro de Pletina el atajo lo atiende la propia app y llama a `nav.back()`. Ninguna vía acredita el botón UI ni el sistema Android. Siguen pendientes Xiaomi e iPhone físicos.

## Resultados E2E históricos: `fb6f83d340d7857a`

Para el build histórico **`fb6f83d340d7857a`**, cada recorrido completo seleccionado contiene **58 comprobaciones**, con estos resultados. Esta matriz no se renombra ni se atribuye a `4c2aaa1c19512425`. El [mapa de funciones](pwa-e2e-function-map.md) relaciona acciones y escenarios e identifica huecos; el [protocolo físico](pwa-physical-e2e.md) sigue pendiente y no suma aprobados.

| Perfil y host | `pass` | `fail` | `blocked` | `unsupported` | Evidencia |
| --- | --- | --- | --- | --- | --- |
| Chromium Android layout, Windows x64, Node 24.18.1, Chrome 153.0.8010.52 | 56 | 0 | 0 | 2 | [Resumen Windows](../artifacts/pwa-e2e/release-fb6f83d340d7857a-win/summary.json), [pasos](../artifacts/pwa-e2e/release-fb6f83d340d7857a-win/chromium-android-layout/report.json) |
| Firefox estrecho, Windows x64, Node 24.18.1, Firefox 153.0 | 57 | 0 | 0 | 1 | [Resumen Windows](../artifacts/pwa-e2e/release-fb6f83d340d7857a-win/summary.json), [pasos](../artifacts/pwa-e2e/release-fb6f83d340d7857a-win/firefox-narrow/report.json) |
| WebKit iPhone layout, Linux x64 bajo WSL2, Node 24.22.0, WebKit 26.5 | 56 | 0 | 0 | 2 | [Resumen Linux](../artifacts/pwa-e2e/release-fb6f83d340d7857a-linux/summary.json), [pasos](../artifacts/pwa-e2e/release-fb6f83d340d7857a-linux/webkit-iphone-layout/report.json) |

El total es **169 `pass`, 0 `fail`, 0 `blocked` y 5 `unsupported` en 174 casos de navegador**. No hay errores inesperados; WebKit conserva un diagnóstico CORS de la prueba negativa de Spotify, clasificado después de comprobar su explicación en la UI. Los tres contextos, navegadores, el puente Puppeteer, el proxy TLS y los servidores de pruebas quedaron cerrados. Los pasos conservan pruebas de instalación mínima/manifest/guía/caché, navegación y biblioteca, CSV y sus validaciones, elección de fuente, YouTube, podcasts, menús y listas contextuales, diseño adaptable, reproducción/cola/radio/álbum sorpresa/repetición/temporizador, restauración, descargas y recuperación de errores, reproducción local desde el worker sin conexión e historial.

Los cinco casos `unsupported` son la confirmación física de instalación en los tres motores, el selector nativo de destinatarios de Web Share en Chromium y la inyección de estimación de cuota ausente en WebKit Linux. Firefox y WebKit sí comprueban la alternativa de descarga local del registro JSON; no seleccionan destinatarios del sistema. Se conservan sin contarlos como aprobados; `browserFeatureChecksPassed` sigue por ello en `false`. Los dos destinos físicos siguen `blocked` y las dos integraciones de coche `unsupported` en contadores separados: **ningún teléfono ni coche se ha verificado con estos perfiles** y `allRequestedPlatformsVerified` permanece `false`.

La batería encontró además una regresión de reanudación de podcasts en WebKit: el audio avanzaba mientras la UI permanecía en «Cargando» porque no se repetía `playing` y `play()` podía quedar pendiente. El [fallo anterior](../artifacts/pwa-e2e/resume-loading-regression-before.json) se conserva. El [control nativo corregido](../artifacts/pwa-e2e/resume-fixed-fb6f83d340d7857a/report.json) pasa sus dos comprobaciones y cinco reanudaciones con promesa nativa pendiente y avance real, mostrando otra vez Pausa/autor. El Player confirma la misma fuente mediante promesa resuelta o dos muestras de avance fuera de un seek, con guardas de token e intención y el vigilante de decoder. Es evidencia de WebKit Linux con medios de prueba; no sustituye Safari/iPhone ni bloqueo físico de pantalla.
