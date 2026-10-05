# Musify

Reproductor de música personal tipo Spotify para escritorio. Busca grupos y discos en Deezer (carátulas y listas de canciones), encuentra cada canción en YouTube Music y la reproduce en streaming de solo audio, sin anuncios. Biblioteca, playlists, historial y descargas para escuchar sin conexión.

- **Tauri 2** (Rust) + **Svelte 5** + TypeScript. Instalador de unos 2 MB.
- Datos en local (SQLite en `%LOCALAPPDATA%\dev.musify.desktop`).
- yt-dlp se descarga solo la primera vez y se actualiza a diario.

El plan, el estado de cada fase y las decisiones están en [PLAN.md](PLAN.md).

## Desarrollo

Requisitos: Node 24, Rust (toolchain MSVC en Windows), Visual Studio Build Tools (C++) y WebView2.

```bash
npm install
npm run tauri dev      # app en modo desarrollo
npm run tauri build    # instalador en src-tauri/target/release/bundle/
npm run check          # tipos
cd src-tauri && cargo test   # tests (con red: cargo test -- --ignored --nocapture)
```

Las versiones publicadas (instaladores y actualizaciones automáticas) están en el repositorio público [musify-releases](https://github.com/diad87/musify-releases).

Uso personal.
