mod capture;
mod capture_audit;
mod capture_bench;
mod capture_legacy;
mod capture_pcm;
mod capture_reference;
mod capture_verify;
mod db;
mod deezer;
mod downloads;
mod extractor;
mod extractors;
mod library;
mod local;
mod native;
mod player;
mod updater;
mod youtube;
mod ytdlp;

use db::Db;
use deezer::{AlbumDetail, ArtistPage, Deezer, SearchResults};
use player::{Alternative, Playable};
use tauri::{Manager, State};
use tauri_plugin_opener::OpenerExt;
use youtube::{TrackQuery, YouTubeMusic};
use ytdlp::YtDlp;

#[tauri::command]
async fn search(
    query: String,
    deezer: State<'_, Deezer>,
    db: State<'_, Db>,
) -> Result<SearchResults, String> {
    let query = query.trim();
    let empty = || SearchResults {
        artists: vec![],
        albums: vec![],
        local_artists: vec![],
        local_albums: vec![],
    };
    if query.is_empty() {
        return Ok(empty());
    }
    let (local_artists, local_albums) = local::search(&db, query);
    match deezer.search(query).await {
        Ok(found) => Ok(SearchResults {
            local_artists,
            local_albums,
            ..found
        }),
        // Sin conexión: al menos lo que haya en la música local.
        Err(_) if !local_artists.is_empty() || !local_albums.is_empty() => Ok(SearchResults {
            local_artists,
            local_albums,
            ..empty()
        }),
        Err(e) => Err(e),
    }
}

#[tauri::command]
async fn artist(
    id: u64,
    deezer: State<'_, Deezer>,
    db: State<'_, Db>,
) -> Result<ArtistPage, String> {
    if local::is_local(id) {
        local::artist(&db, id)
    } else {
        deezer.artist(id).await
    }
}

#[tauri::command]
async fn album(
    id: u64,
    deezer: State<'_, Deezer>,
    db: State<'_, Db>,
) -> Result<AlbumDetail, String> {
    if local::is_local(id) {
        local::album(&db, id)
    } else {
        deezer.album(id).await
    }
}

/// Devuelve la URL del audio de una canción. `refresh` fuerza a pedir una URL nueva
/// (cuando la anterior ha caducado o ha fallado al reproducirse).
#[tauri::command]
async fn resolve(
    track: TrackQuery,
    refresh: bool,
    foreground: Option<bool>,
    expected_foreground: Option<u64>,
    next_slot: Option<u8>,
    request_id: Option<String>,
    db: State<'_, Db>,
    ytm: State<'_, YouTubeMusic>,
    ytdlp: State<'_, YtDlp>,
    app: tauri::AppHandle,
) -> Result<Playable, String> {
    let playable = player::resolve_with_priority(
        &track,
        refresh,
        &db,
        &ytm,
        &ytdlp,
        foreground.unwrap_or(true),
        expected_foreground,
        request_id.as_deref(),
        next_slot,
    )
    .await?;
    // El archivo descargado se sirve por el protocolo de archivos locales: hay que permitirlo.
    if playable.local {
        app.asset_protocol_scope()
            .allow_file(&playable.url)
            .map_err(|e| e.to_string())?;
    }
    Ok(playable)
}

/// Invalida búsquedas pendientes y detiene la captura activa al cancelar la carga.
#[tauri::command]
async fn cancel_resolve(app: tauri::AppHandle) -> Result<(), String> {
    let epoch = player::begin_resolution(true);
    let (official, legacy) = tokio::join!(
        capture::cancel_before(&app, epoch),
        capture_legacy::cancel_before(&app, epoch)
    );
    official.and(legacy)
}

#[tauri::command]
async fn cancel_prefetch(app: tauri::AppHandle, next_slot: Option<u8>) -> Result<(), String> {
    let epoch = player::cancel_prefetch_requests(next_slot)?;
    let (official, legacy) =
        tokio::join!(capture::cancel_next_before(&app, epoch, next_slot), async {
            if next_slot.is_none_or(|slot| slot == 0) {
                capture_legacy::cancel_next_before(&app, epoch).await
            } else {
                Ok(())
            }
        });
    official.and(legacy)
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

/// La búsqueda se realiza en YouTube Music y el usuario elige el enlace del vídeo.
#[tauri::command]
async fn open_youtube_search(track: TrackQuery, app: tauri::AppHandle) -> Result<(), String> {
    let mut url =
        reqwest::Url::parse("https://music.youtube.com/search").map_err(|e| e.to_string())?;
    url.query_pairs_mut().append_pair("q", &track.search_text());
    app.opener()
        .open_url(url.to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Fija a mano el vídeo de una canción y lo devuelve listo para reproducir.
#[tauri::command]
async fn choose_source(
    track: TrackQuery,
    video_id: String,
    foreground: Option<bool>,
    request_id: Option<String>,
    db: State<'_, Db>,
    ytdlp: State<'_, YtDlp>,
) -> Result<Playable, String> {
    player::choose(
        &track,
        &video_id,
        &db,
        &ytdlp,
        foreground.unwrap_or(true),
        request_id.as_deref(),
    )
    .await
}

/// Guarda una asociación manual sin abrir el extractor ni modificar la canción actual.
#[tauri::command]
fn remember_source(track: TrackQuery, video_id: String, db: State<'_, Db>) -> Result<(), String> {
    player::remember_source(&track, &video_id, &db)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    let isolated_bench = std::env::var_os("MUSIFY_BENCH").is_some()
        && context.config().identifier == "dev.musify.captureofficialtest";
    let mut builder = tauri::Builder::default();
    if !isolated_bench {
        // Una sola ventana: abrir Musify otra vez trae al frente la que ya está abierta
        // (si no, sonarían dos reproductores a la vez).
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }
    builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Deezer::new())
        .manage(updater::Pending::default())
        .manage(local::Scanner::default())
        .manage(YouTubeMusic::new())
        .setup(move |app| {
            let dir = app.path().app_local_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let path = if isolated_bench {
                dir.join(format!("musify-bench-{}.db", std::process::id()))
            } else {
                dir.join("musify.db")
            };
            let db = match Db::open(&path) {
                Ok(db) => db,
                Err(e) => {
                    // Sin base de datos no se puede seguir, pero se avisa en vez de cerrarse sin más.
                    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.hide();
                    }
                    app.dialog()
                        .message(format!(
                            "No se pudo abrir la base de datos.\n\n{e}\n\n{}",
                            path.display()
                        ))
                        .title("Musify")
                        .kind(MessageDialogKind::Error)
                        .show(|_| std::process::exit(1));
                    return Ok(());
                }
            };
            app.manage(db);
            app.manage(YtDlp::new(dir.join("bin")));
            extractor::init(app.handle().clone());
            app.manage(downloads::Downloads::start(app.handle()));
            // Música local: carátulas guardadas visibles y escaneo de lo nuevo al arrancar.
            local::allow_covers(app.handle());
            // Las mediciones usan exactamente el código incluido y no actualizan programas,
            // extractores ni la app mientras se observa la captura oficial.
            if std::env::var_os("MUSIFY_BENCH").is_none() {
                extractors::start(app.handle());
                updater::start(app.handle());
                local::start_scan(app.handle());
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    handle.state::<YtDlp>().warm_up().await;
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            search,
            artist,
            album,
            resolve,
            alternatives,
            open_youtube_search,
            choose_source,
            remember_source,
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
            updater::install_update,
            local::local_library,
            local::add_local_folder,
            local::remove_local_folder,
            local::scan_local,
            local::reveal_local,
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
            extractors::extractor_module,
            capture::capture_read,
            capture_audit::capture_audit_status,
            capture::capture_limits,
            capture::capture_profile_open,
            capture::capture_profile_status,
            capture_verify::capture_verify_prepare,
            capture_verify::capture_verify_check,
            capture_bench::capture_bench_native_search,
            capture::capture_begin,
            capture::capture_prefetch,
            capture::capture_seek,
            capture::capture_cancel,
            capture::capture_show,
            capture_legacy::capture_legacy_read,
            capture_legacy::capture_legacy_seek,
            capture_legacy::capture_legacy_cancel,
            capture_bench::capture_bench_catalog,
            capture_bench::capture_bench_checkpoint,
            capture_bench::capture_bench_forget,
            cancel_resolve,
            cancel_prefetch,
        ])
        // Al cerrar la ventana principal se cierra la app, aunque el motor propio tenga abierta su
        // ventana oculta con YouTube Music.
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                window.app_handle().exit(0);
            }
        })
        .build(context)
        .expect("error al arrancar Musify")
        .run(|app, event| {
            // Al cerrar la app se instala la actualización que haya descargada.
            if let tauri::RunEvent::Exit = event {
                updater::install_pending(app);
            }
        });
}
