# Musify

Reproductor de música personal tipo Spotify para Windows, Mac, Linux y Android. Busca grupos y discos en Deezer (carátulas y listas de canciones), encuentra cada canción en YouTube Music y la reproduce en streaming de solo audio, sin anuncios. Biblioteca, playlists, historial, cola tipo DJ y actualizaciones automáticas; en el PC, además, descargas para escuchar sin conexión y tu propia música.

![Inicio](docs/screenshots/inicio.png)

| | |
|---|---|
| ![Disco](docs/screenshots/disco.png) | ![Artista](docs/screenshots/artista.png) |
| **Disco:** la portada tiñe toda la pantalla | **Artista:** foto de cabecera y sus canciones más escuchadas |
| ![Sonando ahora](docs/screenshots/sonando.png) | ![Playlist](docs/screenshots/playlist.png) |
| **Sonando ahora:** pantalla completa con la cola | **Playlist:** se ordena arrastrando |

### En el móvil

La misma app, pensada para el dedo. La música suena en un servicio de Android: sigue con la pantalla apagada y se maneja desde la pantalla de bloqueo, la notificación y los auriculares.

<table>
  <tr>
    <td><img src="docs/screenshots/movil-inicio.png" alt="Inicio en el móvil" width="260"></td>
    <td><img src="docs/screenshots/movil-sonando.png" alt="Sonando ahora en el móvil" width="260"></td>
    <td><img src="docs/screenshots/movil-cola.png" alt="Cola en el móvil" width="260"></td>
  </tr>
  <tr>
    <td><b>Inicio</b>, con lo que suena abajo</td>
    <td><b>Sonando ahora</b>: se cierra deslizando hacia abajo</td>
    <td><b>Cola</b>: tu cola se ordena arrastrando el asa</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/movil-disco.png" alt="Disco en el móvil" width="260"></td>
    <td><img src="docs/screenshots/movil-biblioteca.png" alt="Tu biblioteca en el móvil" width="260"></td>
    <td><img src="docs/screenshots/movil-bloqueo.png" alt="Pantalla de bloqueo" width="260"></td>
  </tr>
  <tr>
    <td><b>Disco</b></td>
    <td><b>Tu biblioteca</b>: playlists, discos y la versión</td>
    <td><b>Pantalla de bloqueo</b>: sigue sonando con la pantalla apagada</td>
  </tr>
</table>

- **Tauri 2** (Rust) + **Svelte 5** + TypeScript. Instalador de unos 3 MB en Windows; el APK de Android, 12 MB.
- Datos en local (SQLite en la carpeta de datos de la app). El PC y el móvil tienen cada uno los suyos: todavía no se sincronizan.
- El audio de YouTube sale de yt-dlp, de youtubei.js o de un motor propio (se elige pulsando el número de versión, arriba a la izquierda; en el móvil, siempre el propio). Cada extractor se actualiza solo desde su fuente, sin reinstalar la app: yt-dlp desde su GitHub, youtubei.js desde npm y el motor propio desde este repositorio.
- En Android, la música la reproduce un servicio nativo (Media3/ExoPlayer) que pide el audio directamente al núcleo de Rust; la interfaz es el mando.

El plan, el estado de cada fase y las decisiones están en [PLAN.md](PLAN.md); lo del móvil, en [docs/plan-mobile.md](docs/plan-mobile.md).

## Android

No está en Google Play: se instala y se actualiza con [Obtainium](https://github.com/ImranR98/Obtainium), que baja el APK de cada versión de musify-releases.

1. Instalar Obtainium (de su GitHub o de F-Droid).
2. En Obtainium, «Añadir app» con la dirección `https://github.com/diad87/musify-releases` y «Añadir». Se queda con el `.apk` de la última versión (la de los extractores no cuenta: es una versión previa).
3. «Instalar». Android pedirá permitir instalar apps desde Obtainium la primera vez.

A partir de ahí, Obtainium avisa cuando hay versión nueva y la instala encima, sin perder la biblioteca. La app también lo dice en «Tu biblioteca». Sin Obtainium, el APK se puede bajar de la [última versión](https://github.com/diad87/musify-releases/releases/latest) e instalar a mano.

En el móvil todavía no hay música guardada en el teléfono ni descargas (fase 4 del plan).

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
3. GitHub Actions compila Windows, Mac, Linux y el APK de Android, los firma, genera `latest.json` y publica en [musify-releases](https://github.com/diad87/musify-releases), de donde las apps instaladas se actualizan solas (las de Android, con Obtainium).

Para publicar hace falta el secreto `RELEASES_TOKEN`. Sin él, Actions lo compila todo pero no lo publica; se publica a mano con los artefactos de esa ejecución:

```bash
gh run download <id> -R diad87/musify -D artifacts
node scripts/release.mjs artifacts vX.Y.Z notas.md
gh release create vX.Y.Z artifacts/_release/* -R diad87/musify-releases --title "Musify X.Y.Z" --notes-file notas.md
```

## Publicar extractores

Los extractores (receta y script del motor propio, youtubei.js) se publican aparte, sin sacar versión de la app:

1. Al cambiar uno, subir su `version` en `src-tauri/extractors.json`.
2. Subirlo a `main`: GitHub Actions lo empaqueta, lo firma y lo publica en la versión `extractores` de musify-releases. Las apps lo cambian solas en unas horas.

Cada día GitHub Actions mira también si hay youtubei.js nuevo y, si funciona, lo pone y lo publica. A mano: `node scripts/extractors.mjs` (o `--dry-run`, o `--to <carpeta>` para probar con `MUSIFY_EXTRACTORS_URL`).

## Claves de firma

Están en `%USERPROFILE%\.musify\` y en los secretos del repositorio: `updater.key` para escritorio y extractores (`TAURI_SIGNING_PRIVATE_KEY`) y `android.jks` para el APK (`ANDROID_KEYSTORE`), cada una con su contraseña. Sin ellas no se pueden publicar actualizaciones. Si se pierde la de Android, los móviles no aceptan la versión siguiente sin desinstalar (y perder la biblioteca): hay que guardar una copia de esa carpeta.

Uso personal.
