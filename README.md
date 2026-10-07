# Pletina

Reproductor de música tipo Spotify para Windows, Mac, Linux y Android. Busca grupos y discos en Deezer (carátulas y listas de canciones), encuentra cada canción en YouTube Music y la reproduce en streaming de solo audio, sin anuncios. Biblioteca, playlists, historial, cola tipo DJ, descargas para escuchar sin conexión (también en el móvil) y actualizaciones automáticas; en el PC, además, tu propia música.

Software libre con licencia [GPL-3.0](LICENSE). Antes se llamaba Musify.

![Inicio](docs/screenshots/inicio.png)

| | |
|---|---|
| ![Disco](docs/screenshots/disco.png) | ![Artista](docs/screenshots/artista.png) |
| **Disco:** la portada tiñe toda la pantalla | **Artista:** foto de cabecera y sus canciones más escuchadas |
| ![Sonando ahora](docs/screenshots/sonando.png) | ![Playlist](docs/screenshots/playlist.png) |
| **Sonando ahora:** pantalla completa con la cola | **Playlist:** se ordena arrastrando |

### En el móvil

La misma app, pensada para el dedo. La música suena en un servicio de Android: sigue con la pantalla apagada y se maneja desde la pantalla de bloqueo, la notificación y los auriculares. Los discos y playlists se descargan para escucharlos sin conexión, y siguen bajando aunque salgas de la app.

<table>
  <tr>
    <td width="33%"><img src="docs/screenshots/movil-inicio.png" alt="Inicio en el móvil" width="100%"></td>
    <td width="33%"><img src="docs/screenshots/movil-sonando.png" alt="Sonando ahora en el móvil" width="100%"></td>
    <td width="33%"><img src="docs/screenshots/movil-cola.png" alt="Cola en el móvil" width="100%"></td>
  </tr>
  <tr>
    <td><b>Inicio</b>, con lo que suena abajo</td>
    <td><b>Sonando ahora</b>: se cierra deslizando hacia abajo</td>
    <td><b>Cola</b>: tu cola se ordena arrastrando el asa</td>
  </tr>
  <tr>
    <td width="33%"><img src="docs/screenshots/movil-disco.png" alt="Disco en el móvil" width="100%"></td>
    <td width="33%"><img src="docs/screenshots/movil-biblioteca.png" alt="Tu biblioteca en el móvil" width="100%"></td>
    <td width="33%"><img src="docs/screenshots/movil-bloqueo.png" alt="Pantalla de bloqueo" width="100%"></td>
  </tr>
  <tr>
    <td><b>Disco</b></td>
    <td><b>Tu biblioteca</b>: playlists, discos y la versión</td>
    <td><b>Pantalla de bloqueo</b>: sigue sonando con la pantalla apagada</td>
  </tr>
</table>

## Instalar

Descarga el archivo de tu sistema desde la [última versión](https://github.com/diad87/pletina-releases/releases/latest):

| Sistema | Archivo |
|---|---|
| Windows 10/11 | `Pletina_x.y.z_x64-setup.exe`: doble clic |
| Mac (chip de Apple o Intel, macOS 11+) | `Pletina_x.y.z_universal.dmg`: arrastrar a Aplicaciones |
| Linux (64 bits) | `Pletina_x.y.z_amd64.AppImage` (cualquier distribución) o `.deb` (Ubuntu/Debian) |
| Android 7 o superior (64 bits) | `Pletina_x.y.z_android.apk`, mejor con Obtainium (abajo) para que se actualice sola |

Mientras el instalador de Windows no esté firmado (ver [Code signing policy](#code-signing-policy)), Windows avisa la primera vez: «Más información» → «Ejecutar de todas formas». El de Mac no está firmado por Apple: la primera vez, clic derecho en la app → Abrir. Las actualizaciones no avisan, porque las baja la propia app.

Si tenías Musify, Pletina la sustituye al instalarse (o al actualizarse sola) y conserva tu biblioteca.

### Android, con Obtainium

No está en Google Play. [Obtainium](https://github.com/ImranR98/Obtainium) instala el APK desde aquí y lo actualiza cuando sale una versión nueva:

1. Instala Obtainium (desde su GitHub o desde F-Droid).
2. En Obtainium, «Añadir app», pega `https://github.com/diad87/pletina-releases` y pulsa «Añadir». Se queda con el `.apk` de la última versión (la de los extractores no cuenta: es una versión previa).
3. Pulsa «Instalar». La primera vez, Android pide permiso para instalar apps desde Obtainium.

Para escuchar sin conexión: ⬇ en un disco o una playlist, o «Descargar» en el menú ⋯ de una canción. Lo descargado está en Tu biblioteca → Descargas, y sin conexión suena también desde su disco o su playlist (lo que no está descargado se salta). Todavía no se puede escuchar la música guardada en el teléfono (fase 4 del plan).

### Se actualiza sola

En el PC, la app busca versiones nuevas al arrancar y cada pocas horas, las descarga en segundo plano y las instala al cerrarse (en Linux, con el AppImage). En Android, Obtainium avisa de cada versión y la instala encima sin perder la biblioteca. Todas las actualizaciones van firmadas: la app de escritorio no instala nada que no lleve nuestra firma, y Android no deja instalar encima un APK firmado por otro.

## Privacidad

Pletina no tiene cuentas, ni analíticas, ni servidores propios. Tu biblioteca, tus playlists y tu historial se guardan solo en tu equipo. Se conecta a:

- **Deezer**, para buscar artistas y discos y bajar las carátulas ([privacidad de Deezer](https://www.deezer.com/legal/personal-datas)).
- **YouTube y YouTube Music**, para encontrar cada canción y reproducir su audio ([privacidad de Google](https://policies.google.com/privacy)).
- **GitHub**, para buscar y bajar actualizaciones de la app y de los extractores de audio, y yt-dlp en el PC ([privacidad de GitHub](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement)).

El registro de errores no sale del equipo salvo que tú lo compartas con «Enviar registro».

## Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

La firma gratuita para proyectos de código abierto está solicitada a SignPath Foundation; hasta que la aprueben, los instaladores de Windows van sin firmar. Los instaladores se compilan en GitHub Actions a partir de este repositorio y solo se firman los que salen de ahí. Cada firma la aprueba a mano una persona del equipo.

- Committers and reviewers: [diad87](https://github.com/diad87)
- Approvers: [diad87](https://github.com/diad87)

Privacy: see [Privacidad](#privacidad). Pletina connects to Deezer, YouTube and GitHub as described there, sends no personal data and has no telemetry.

## Cómo funciona

- **Tauri 2** (Rust) + **Svelte 5** + TypeScript. Instalador de unos 3 MB en Windows; el APK de Android, 12 MB.
- Datos en local (SQLite en la carpeta de datos de la app). El PC y el móvil tienen cada uno los suyos: todavía no se sincronizan.
- El audio de YouTube sale de yt-dlp, de youtubei.js o de un motor propio (se elige pulsando el número de versión, arriba a la izquierda; en el móvil, siempre el propio). Cada extractor se actualiza solo desde su fuente, sin reinstalar la app: yt-dlp desde su GitHub, youtubei.js desde npm y el motor propio desde este repositorio.
- En Android, la música la reproduce un servicio nativo (Media3/ExoPlayer) que pide el audio directamente al núcleo de Rust; la interfaz es el mando. Las descargas usan el motor propio (allí no hay yt-dlp).
- Por dentro, algunas cosas conservan el nombre antiguo (el identificador `dev.musify.desktop`, el paquete de Android, la base de datos `musify.db`) para que las instalaciones de Musify sigan actualizándose y no pierdan la biblioteca.

El plan, el estado de cada fase y las decisiones están en [PLAN.md](PLAN.md); lo del móvil, en [docs/plan-mobile.md](docs/plan-mobile.md).

## Desarrollo

Requisitos: Node 24, Rust (toolchain MSVC en Windows), Visual Studio Build Tools (C++) y WebView2.

```bash
npm install
npm run tauri dev      # app en modo desarrollo
npm run build:local    # instalador sin firmar en src-tauri/target/release/bundle/
npm run dev            # solo la interfaz en el navegador, con datos de ejemplo (src/dev)
npm run check          # tipos
cd src-tauri && cargo test   # tests (con red: cargo test -- --ignored --nocapture)
```

**Android:** además, el SDK de Android con el NDK 27.3.13750724, Java 21 y el objetivo de Rust `aarch64-linux-android` (y `x86_64-linux-android` para el emulador). `npm run tauri android build -- --apk --target aarch64` compila el APK; sale firmado si está la clave en `%USERPROFILE%\.musify\android.jks`. En Windows, Tauri no puede crear el enlace a la librería de Rust: se copia `src-tauri/target/<objetivo>/release/libmusify_lib.so` a `src-tauri/gen/android/app/src/main/jniLibs/<abi>/` y se termina con Gradle (`gradlew.bat assembleUniversalRelease -x rustBuildUniversalRelease`). Detalles y pruebas en [docs/plan-mobile.md](docs/plan-mobile.md).

Las capturas de escritorio se sacan de la vista previa del navegador (`npm run dev`), por ejemplo `http://localhost:1420/?view=album&id=14879699&play=1&playId=14879699` (ver `src/dev/preview.ts`), a 1440×900. Las del móvil, del emulador de Android con la app de verdad.

## Publicar una versión

1. Subir la versión en `package.json` y `src-tauri/Cargo.toml`.
2. Commit y etiqueta anotada: `git tag -a vX.Y.Z` (el mensaje de la etiqueta son las notas de la versión) y `git push --follow-tags`.
3. GitHub Actions compila Windows, Mac, Linux y el APK de Android, los firma, genera `latest.json` y publica en [pletina-releases](https://github.com/diad87/pletina-releases), de donde las apps instaladas se actualizan solas (las de Android, con Obtainium).

Para publicar hace falta el secreto `RELEASES_TOKEN`. Sin él, Actions lo compila todo pero no lo publica; se publica a mano con los artefactos de esa ejecución:

```bash
gh run download <id> -R diad87/pletina -D artifacts
node scripts/release.mjs artifacts vX.Y.Z notas.md
gh release create vX.Y.Z artifacts/_release/* -R diad87/pletina-releases --title "Pletina X.Y.Z" --notes-file notas.md
```

## Publicar extractores

Los extractores (receta y script del motor propio, youtubei.js) se publican aparte, sin sacar versión de la app:

1. Al cambiar uno, subir su `version` en `src-tauri/extractors.json`.
2. Subirlo a `main`: GitHub Actions lo empaqueta, lo firma y lo publica en la versión `extractores` de pletina-releases. Las apps lo cambian solas en unas horas.

Cada día GitHub Actions mira también si hay youtubei.js nuevo y, si funciona, lo pone y lo publica. A mano: `node scripts/extractors.mjs` (o `--dry-run`, o `--to <carpeta>` para probar con `MUSIFY_EXTRACTORS_URL`).

## Claves de firma

Están en `%USERPROFILE%\.musify\` y en los secretos del repositorio: `updater.key` para escritorio y extractores (`TAURI_SIGNING_PRIVATE_KEY`) y `android.jks` para el APK (`ANDROID_KEYSTORE`), cada una con su contraseña. Sin ellas no se pueden publicar actualizaciones. Si se pierde la de Android, los móviles no aceptan la versión siguiente sin desinstalar (y perder la biblioteca): hay que guardar una copia de esa carpeta.

## Licencia

Pletina es software libre: puedes usarla, estudiarla, cambiarla y compartirla según la [GNU General Public License v3.0](LICENSE) o posterior. Si distribuyes una versión modificada, tiene que ir también con su código y la misma licencia.
