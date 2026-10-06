# Musify

Reproductor de música personal tipo Spotify para Windows, Mac y Linux. Busca grupos y discos en Deezer (carátulas y listas de canciones), encuentra cada canción en YouTube Music y la reproduce en streaming de solo audio, sin anuncios. Biblioteca, playlists, historial, descargas para escuchar sin conexión y actualizaciones automáticas.

![Inicio](docs/screenshots/inicio.png)

| | |
|---|---|
| ![Disco](docs/screenshots/disco.png) | ![Artista](docs/screenshots/artista.png) |
| ![Sonando ahora](docs/screenshots/sonando.png) | ![Playlist](docs/screenshots/playlist.png) |

- **Tauri 2** (Rust) + **Svelte 5** + TypeScript. Instalador de unos 2 MB en Windows.
- Datos en local (SQLite en la carpeta de datos de la app).
- yt-dlp se descarga solo la primera vez y se actualiza a diario.

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

La clave de firma está en `%USERPROFILE%\.musify\` y en los secretos del repositorio; sin ella no se pueden publicar actualizaciones.

Uso personal.
