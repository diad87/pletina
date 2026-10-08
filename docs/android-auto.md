# Android Auto: integración y validación

Revisión de documentación y herramientas: 8 de octubre de 2026. La integración está implementada y probada con clientes multimedia en un emulador; todavía no está publicada ni probada en coche. Android Auto ejecuta la aplicación en el teléfono y presenta su interfaz multimedia en la pantalla del coche. Las pruebas de un `MediaBrowser` no sustituyen la validación con Android Auto.

## Validación realizada

- Compilación Rust para Android x86_64 y empaquetado Gradle del APK debug correctos.
- 57 pruebas del núcleo aprobadas; 19 pruebas de red o fixtures omitidas.
- 4 pruebas instrumentadas aprobadas en Android 15/API 35, sin omisiones: navegación Media3, navegación legacy, recuperación de contexto con canciones repetidas y selección por ID hasta ExoPlayer con un archivo descargado, sin abrir ninguna Activity.
- Las pruebas usan `dev.musify.desktop.autotest`; la instalación habitual de Pletina 0.9.0 se conserva.

La prueba de reproducción abre SQLite en WAL, igual que Rust, para que ambos motores vean los datos preparados. La última ejecución de Gradle y el informe JUnit confirman las cuatro pruebas sin fallos. Quedan pendientes DHU, coche real, controles del volante, búsqueda por voz del asistente y prueba en un teléfono ARM64.

## Contrato de la integración

- Usar `MediaLibraryService` y devolver una `MediaLibrarySession` desde `onGetSession`. Implementar la raíz y los hijos de la biblioteca mediante los callbacks de Media3. El reproductor existente y su sesión deben seguir compartidos con la interfaz del teléfono. [MediaLibraryService](https://developer.android.com/media/media3/session/serve-content).
- Declarar el servicio exportado de tipo `mediaPlayback`, los permisos `FOREGROUND_SERVICE` y `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, y ambos filtros: `androidx.media3.session.MediaLibraryService` y `android.media.browse.MediaBrowserService`. El segundo permite el descubrimiento por clientes de la API anterior. [Declaración Media3](https://developer.android.com/media/media3/session/serve-content).
- En `application`, declarar `com.google.android.gms.car.application` apuntando a `@xml/automotive_app_desc`. Ese recurso contiene `<automotiveApp><uses name="media"/></automotiveApp>`. [Manifest de Android Auto](https://developer.android.com/training/cars/media/auto).
- Resolver en `onAddMediaItems` o `onSetMediaItems` las peticiones que solo traen un `mediaId`. Auto puede iniciar la reproducción a través de `playFromMediaId`; no se puede exigir que el cliente envíe una URI o los metadatos privados de la cola del teléfono. [Callbacks de sesión](https://developer.android.com/reference/androidx/media3/session/MediaSession.Callback).
- Devolver IDs estables, raíz rápida y nodos con marcas navegable/reproducible correctas. Respetar las indicaciones del cliente: habitualmente cuatro carpetas raíz como máximo. Android Auto y AAOS no soportan paginación; no depender de `page`/`pageSize` para mostrar el catálogo completo. [Jerarquía](https://developer.android.com/training/cars/media/create-media-browser/content-hierarchy).
- Proporcionar icono de aplicación y un icono monocromo de atribución. [Iconos y manifest](https://developer.android.com/training/cars/media/configure-manifest).

## Compilar desde este repositorio

Requisitos definidos por el proyecto: Java 21, NDK `27.3.13750724`, SDK compatible con `compileSdk = 37`, Node/npm y los targets Rust de Android. Gradle usa el wrapper del repositorio. Configurar las rutas para la sesión de PowerShell; este ejemplo coincide con el equipo de desarrollo revisado:

```powershell
$env:ANDROID_HOME = 'C:\Users\iunan\Android\Sdk'
$env:NDK_HOME = Join-Path $env:ANDROID_HOME 'ndk\27.3.13750724'
$env:JAVA_HOME = 'C:\Program Files\Microsoft\jdk-21.0.12.8-hotspot'
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:PATH"
```

Desde la raíz del repositorio, para un teléfono ARM64:

```powershell
npm run tauri -- android build --apk --target aarch64 --ci
```

Para el emulador x86_64:

```powershell
npm run tauri -- android build --debug --apk --target x86_64 --ci
```

Los argumentos se comprobaron con `npm run tauri -- android build --help`. Estos comandos también generan los archivos Gradle de Tauri que no están versionados; en un worktree nuevo no se debe comenzar invocando Gradle directamente. La firma de release usa la configuración existente de `app/build.gradle.kts`; no copiar contraseñas a scripts ni al repositorio.

Si en Windows falla únicamente la creación del enlace a `libmusify_lib.so`, el README documenta copiar la biblioteca recién compilada al ABI correspondiente y terminar con Gradle. Para el caso debug x86_64:

```powershell
$autoJni = 'src-tauri\gen\android\app\src\main\jniLibs\x86_64'
New-Item -ItemType Directory -Force -Path $autoJni | Out-Null
Copy-Item -LiteralPath 'src-tauri\target\x86_64-linux-android\debug\libmusify_lib.so' -Destination (Join-Path $autoJni 'libmusify_lib.so')
Push-Location 'src-tauri\gen\android'
.\gradlew.bat :app:assembleUniversalDebug -x rustBuildUniversalDebug -PabiList=x86_64 -ParchList=x86_64 -PtargetList=x86_64
Pop-Location
```

Si se ha configurado `CARGO_TARGET_DIR`, adaptar la ruta de origen. No saltarse el paso de Rust con una biblioteca vieja: las funciones JNI nuevas deben estar presentes. Para release ARM64 cambian el target a `aarch64-linux-android`, el perfil a `release`, el ABI a `arm64-v8a` y las tareas a `assembleUniversalRelease`/`rustBuildUniversalRelease`.

## Probar sin alterar la biblioteca habitual

Usar un APK debug con `applicationIdSuffix = ".autotest"`, conservando el namespace Kotlin `dev.musify.desktop` y los símbolos JNI. Su aplicación y sus datos quedan separados como `dev.musify.desktop.autotest`. La prueba debe instalarse con ese ID verificado, sin desinstalar ni borrar los datos de `dev.musify.desktop`.

El script `scripts/android-auto-test.init.gradle` establece el sufijo sin editar `build.gradle.kts`. Tras generar los archivos de Tauri y copiar la biblioteca nativa si fuera necesario, ejecutar desde `src-tauri/gen/android`:

```powershell
$env:ANDROID_SERIAL = 'emulator-5554'
.\gradlew.bat --no-configuration-cache -I ..\..\..\scripts\android-auto-test.init.gradle :app:printAutoTestApplicationIds
.\gradlew.bat --no-configuration-cache -I ..\..\..\scripts\android-auto-test.init.gradle :app:connectedUniversalDebugAndroidTest -x rustBuildUniversalDebug
```

La tarea de inspección debe mostrar `dev.musify.desktop.autotest`. El APK queda en `app/build/outputs/apk/universal/debug/`; es una instalación de pruebas para el ABI compilado, no un instalador para publicar. `CarPlaybackTest` comprueba el sufijo antes de crear datos de prueba y se omite en el paquete habitual. Las otras pruebas no modifican la biblioteca.

Una prueba instrumentada de `MediaBrowser` debe conectar con el servicio del paquete aislado, solicitar raíz e hijos y reproducir por ID sin pasar URI. Cubrir biblioteca vacía y poblada, listas, favoritos, descargas, búsqueda si se anuncia, ID desconocido y reconexión. Verificar que la cola y los controles se sincronizan con el teléfono. No hacer peticiones de red lentas en el hilo principal del servicio.

Probar también arranque del servicio antes de abrir cualquier Activity y cuando no puede mostrarse una Activity. Las pruebas con datos vacíos y detención forzada se realizan exclusivamente en el paquete aislado. Estos casos forman parte de las [pruebas oficiales de apps multimedia](https://developer.android.com/training/cars/testing).

## Prueba completa con Android Auto

La opción de desarrollador «Orígenes desconocidos» de Android Auto permite probar aplicaciones multimedia instaladas fuera de una fuente de confianza. Esa excepción no se aplica a las aplicaciones que usan Android for Cars App Library. Para este servicio multimedia no hace falta publicar en Play para realizar la prueba. Activar el modo desarrollador de Android Auto pulsando diez veces en la información de versión y habilitar la opción en su menú. [Pruebas y orígenes desconocidos](https://developer.android.com/training/cars/testing).

El Desktop Head Unit (DHU) emula la pantalla de Android Auto y se instala desde las herramientas del SDK. Se conecta al teléfono con Android Auto actualizado. Para el túnel ADB, iniciar «Head unit server» en los ajustes de desarrollador del teléfono y ejecutar:

```powershell
adb -s SERIAL_DEL_TELEFONO forward tcp:5277 tcp:5277
& "$env:ANDROID_HOME\extras\google\auto\desktop-head-unit.exe"
```

Seleccionar el teléfono explícitamente cuando también hay emuladores conectados. Los diálogos de configuración inicial se atienden en el teléfono. [Preparación y conexión del DHU](https://developer.android.com/training/cars/testing/dhu).

Validar en DHU y, después, en un coche detenido: descubrimiento de Pletina, navegación, selección de canción, pausa, siguiente/anterior, carátula, desconexión/reconexión, pantalla del teléfono apagada, pérdida de red y reproducción descargada. Registrar equipo, versión del APK y versión de Android Auto. La navegación por servicio en un emulador normal no demuestra compatibilidad completa con Auto.

## Herramientas verificadas en este equipo

| Elemento | Resultado de inspección |
|---|---|
| SDK | `C:\Users\iunan\Android\Sdk` |
| NDK | `27.3.13750724` |
| SDK instalados | `android-36`, `android-37.0` |
| Build Tools / ADB | `36.0.0` / `37.0.1` |
| JDK | Microsoft OpenJDK `21.0.12` |
| Targets Rust | `aarch64-linux-android`, `x86_64-linux-android`, además de ARMv7 e i686 |
| AVD | `musify-prueba`, Android 35 Google APIs x86_64; conectado como `emulator-5554` |
| Pletina existente | `dev.musify.desktop`, versión `0.9.0`, debug; `run-as` accesible |
| Firma existente | Certificado `Android Debug`, verificado con `apksigner` |
| Android Auto del AVD | Solo paquete de sistema `AndroidAutoStubPrebuilt`; no prueba Auto funcional |
| DHU | No instalado en `extras/google/auto` |
| Teléfono/coche | No conectado durante esta inspección |

No se modificó la biblioteca existente. Para copiar el APK existente con esta versión de ADB fue necesario `adb pull -Z`, pues la transferencia comprimida se truncó.
