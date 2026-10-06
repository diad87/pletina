# Musify

Reproductor de música personal tipo Spotify para Windows, Mac y Linux. Busca grupos y discos en Deezer (carátulas y listas de canciones), encuentra cada canción en YouTube Music y la reproduce en streaming de solo audio, sin anuncios. Biblioteca, playlists, historial, descargas para escuchar sin conexión y actualizaciones automáticas.

![Inicio](docs/screenshots/inicio.png)

| | |
|---|---|
| ![Disco](docs/screenshots/disco.png) | ![Artista](docs/screenshots/artista.png) |
| ![Sonando ahora](docs/screenshots/sonando.png) | ![Playlist](docs/screenshots/playlist.png) |

- **Tauri 2** (Rust) + **Svelte 5** + TypeScript. Instalador de unos 2 MB en Windows.
- Datos en local (SQLite en la carpeta de datos de la app).
- El audio de YouTube sale de yt-dlp, de youtubei.js o de un motor propio (se elige en Inicio). Cada extractor se actualiza solo desde su fuente, sin reinstalar la app: yt-dlp desde su GitHub, youtubei.js desde npm y el motor propio desde este repositorio.

El plan, el estado de cada fase y las decisiones están en [PLAN.md](PLAN.md).

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

Las capturas se sacan de la vista previa del navegador (`npm run dev`), por ejemplo `http://localhost:1420/?view=album&id=14879699&play=1&playId=14879699` (ver `src/dev/preview.ts`).

## Publicar una versión

1. Subir la versión en `package.json` y `src-tauri/Cargo.toml`.
2. Commit y etiqueta anotada: `git tag -a vX.Y.Z` (el mensaje de la etiqueta son las notas de la versión) y `git push --follow-tags`.
3. GitHub Actions compila Windows, Mac y Linux, los firma, genera `latest.json` y publica en [musify-releases](https://github.com/diad87/musify-releases), de donde las apps instaladas se actualizan solas.

## Publicar extractores

Los extractores (receta y script del motor propio, youtubei.js) se publican aparte, sin sacar versión de la app:

1. Al cambiar uno, subir su `version` en `src-tauri/extractors.json`.
2. Subirlo a `main`: GitHub Actions lo empaqueta, lo firma y lo publica en la versión `extractores` de musify-releases. Las apps lo cambian solas en unas horas.

Cada día GitHub Actions mira también si hay youtubei.js nuevo y, si funciona, lo pone y lo publica. A mano: `node scripts/extractors.mjs` (o `--dry-run`, o `--to <carpeta>` para probar con `MUSIFY_EXTRACTORS_URL`).

La clave de firma está en `%USERPROFILE%\.musify\` y en los secretos del repositorio; sin ella no se pueden publicar actualizaciones. Para que GitHub Actions publique en musify-releases hace falta además el secreto `RELEASES_TOKEN`.

Uso personal.
