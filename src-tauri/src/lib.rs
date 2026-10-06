mod db;
mod capture;
mod deezer;
mod downloads;
mod extractor;
mod library;
mod native;
mod player;
mod youtube;
mod ytdlp;

use db::Db;
use deezer::{AlbumDetail, ArtistPage, Deezer, SearchResults};
use player::{Alternative, Playable};
use tauri::{Manager, State};
use youtube::{TrackQuery, YouTubeMusic};
use ytdlp::YtDlp;

#[tauri::command]
async fn search(query: String, deezer: State<'_, Deezer>) -> Result<SearchResults, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(SearchResults { artists: vec![], albums: vec![] });
    }
    deezer.search(query).await
}

#[tauri::command]
async fn artist(id: u64, deezer: State<'_, Deezer>) -> Result<ArtistPage, String> {
    deezer.artist(id).await
}

#[tauri::command]
async fn album(id: u64, deezer: State<'_, Deezer>) -> Result<AlbumDetail, String> {
    deezer.album(id).await
}

/// Devuelve la URL del audio de una canción. `refresh` fuerza a pedir una URL nueva
/// (cuando la anterior ha caducado o ha fallado al reproducirse).
#[tauri::command]
async fn resolve(
    track: TrackQuery,
    refresh: bool,
    db: State<'_, Db>,
    ytm: State<'_, YouTubeMusic>,
    ytdlp: State<'_, YtDlp>,
    app: tauri::AppHandle,
) -> Result<Playable, String> {
    let playable = player::resolve(&track, refresh, &db, &ytm, &ytdlp).await?;
    // El archivo descargado se sirve por el protocolo de archivos locales: hay que permitirlo.
    if playable.local {
        app.asset_protocol_scope().allow_file(&playable.url).map_err(|e| e.to_string())?;
    }
    Ok(playable)
}

/// Vídeos que podrían ser la canción, para elegir otro a mano.
#[tauri::command]
async fn alternatives(
    track: TrackQuery,
    db: State<'_, Db>,
    ytm: State<'_, YouTubeMusic>,
    ytdlp: State<'_, YtDlp>,
) -> Result<Vec<Alternative>, String> {
    player::alternatives(&track, &db, &ytm, &ytdlp).await
}

/// Fija a mano el vídeo de una canción y lo devuelve listo para reproducir.
#[tauri::command]
async fn choose_source(
    track: TrackQuery,
    video_id: String,
    db: State<'_, Db>,
    ytdlp: State<'_, YtDlp>,
) -> Result<Playable, String> {
    player::choose(&track, &video_id, &db, &ytdlp).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Una sola ventana: abrir Musify otra vez trae al frente la que ya está abierta
        // (si no, sonarían dos reproductores a la vez).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Deezer::new())
        .manage(YouTubeMusic::new())
        .setup(|app| {
            let dir = app.path().app_local_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.manage(Db::open(&dir.join("musify.db"))?);
            app.manage(YtDlp::new(dir.join("bin")));
            extractor::init(app.handle().clone());
            native::init(dir.clone());
            app.manage(downloads::Downloads::start(app.handle()));

            // Prepara yt-dlp en segundo plano (descarga o actualización diaria).
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                handle.state::<YtDlp>().warm_up().await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            search,
            artist,
            album,
            resolve,
            alternatives,
            choose_source,
            library::library,
            library::set_liked,
            library::liked_tracks,
            library::set_album_saved,
            library::create_playlist,
            library::rename_playlist,
            library::delete_playlist,
            library::playlist,
            library::add_to_playlist,
            library::remove_from_playlist,
            library::move_in_playlist,
            library::record_play,
            library::history,
            library::clear_history,
            downloads::download,
            downloads::cancel_downloads,
            downloads::downloads_list,
            downloads::remove_downloads,
            downloads::download_dir_path,
            downloads::choose_download_dir,
            downloads::open_download_dir,
            downloads::reveal_download,
            extractor::http_fetch,
            extractor::extractor_reply,
            extractor::set_stream_engine,
            extractor::stream_engine,
            extractor::bench_plan,
            extractor::bench_report,
            extractor::bench_ytdlp,
            extractor::bench_probe,
            extractor::bench_native,
            extractor::bench_capture,
            extractor::capture_status,
            extractor::engine_stats,
            capture::capture_read,
            capture::capture_seek,
        ])
        // Al cerrar la ventana principal se cierra la app, aunque el motor propio tenga abierta su
        // ventana oculta con YouTube Music.
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                window.app_handle().exit(0);
            }
        })
        .run(tauri::generate_context!())
        .expect("error al arrancar Musify");
}
