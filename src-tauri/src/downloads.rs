//! Descargas para escuchar sin conexión.
//!
//! Cola con dos descargas a la vez; el progreso llega a la interfaz con el evento "download".
//! Los archivos se guardan como `Carpeta/Artista/Disco/Canción.m4a` y la base de datos
//! recuerda dónde está cada uno (`resolve` lo reproduce en lugar del streaming).

use crate::db::Db;
use crate::library::{LibTrack, upsert_track};
use crate::player;
use crate::youtube::{TrackQuery, YouTubeMusic};
use crate::ytdlp::YtDlp;
use rusqlite::params;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::{Semaphore, mpsc};

type Res<T> = Result<T, String>;

const PARALLEL: usize = 2;
const DIR_KEY: &str = "download_dir";

/// Evento "download" para la interfaz.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    track_id: u64,
    /// "queued" | "downloading" | "done" | "error" | "cancelled"
    state: &'static str,
    progress: f32,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadEntry {
    pub track: LibTrack,
    pub path: String,
    pub size: u64,
    pub at: i64,
}

struct Job {
    track: LibTrack,
    /// Si al llegar su turno la generación ha cambiado, es que se canceló la cola.
    generation: u64,
}

pub struct Downloads {
    tx: mpsc::UnboundedSender<Job>,
    /// Canciones en cola o descargándose.
    pending: Mutex<HashSet<u64>>,
    generation: AtomicU64,
}

impl Downloads {
    pub fn start(app: &AppHandle) -> Self {
        let (tx, mut rx) = mpsc::unbounded_channel::<Job>();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let slots = Arc::new(Semaphore::new(PARALLEL));
            while let Some(job) = rx.recv().await {
                let Ok(permit) = slots.clone().acquire_owned().await else { break };
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    run(&app, job).await;
                    drop(permit);
                });
            }
        });
        Self { tx, pending: Mutex::new(HashSet::new()), generation: AtomicU64::new(0) }
    }
}

fn emit(app: &AppHandle, track_id: u64, state: &'static str, progress: f32, error: Option<String>) {
    let _ = app.emit("download", Progress { track_id, state, progress, error });
}

async fn run(app: &AppHandle, job: Job) {
    let downloads = app.state::<Downloads>();
    let id = job.track.id;
    if job.generation != downloads.generation.load(Ordering::SeqCst) {
        downloads.pending.lock().unwrap().remove(&id);
        emit(app, id, "cancelled", 0.0, None);
        return;
    }
    emit(app, id, "downloading", 0.0, None);
    let result = download_one(app, &job.track).await;
    downloads.pending.lock().unwrap().remove(&id);
    match result {
        Ok(()) => emit(app, id, "done", 1.0, None),
        Err(e) => emit(app, id, "error", 0.0, Some(e)),
    }
}

async fn download_one(app: &AppHandle, t: &LibTrack) -> Res<()> {
    let db = app.state::<Db>();
    let dir = download_dir(app, &db);
    // Avisa a la interfaz cada 2 % como mucho.
    let mut last = 0.0;
    let report = |p: f32| {
        if p - last >= 0.02 || p >= 1.0 {
            last = p;
            emit(app, t.id, "downloading", p, None);
        }
    };
    fetch(t, &dir, &db, &app.state::<YouTubeMusic>(), &app.state::<YtDlp>(), report).await
}

/// Busca el vídeo de la canción, lo descarga en `dir` y lo apunta en la base de datos.
async fn fetch(
    t: &LibTrack,
    dir: &Path,
    db: &Db,
    ytm: &YouTubeMusic,
    ytdlp: &YtDlp,
    mut report: impl FnMut(f32),
) -> Res<()> {
    if db.download_path(t.id).is_some_and(|p| Path::new(&p).exists()) {
        return Ok(());
    }

    let q = TrackQuery {
        id: t.id,
        title: t.title.clone(),
        artist: t.artist_name.clone(),
        album: t.album_title.clone(),
        duration: t.duration,
    };
    let target = target_path(dir, t)?;

    let mut video_id = player::find_video(&q, db, ytm, ytdlp).await?;
    let file = match ytdlp.download(&video_id, &target, &mut report).await {
        Ok(file) => file,
        // El vídeo guardado ya no existe: se busca otro una vez.
        Err(e) if player::is_gone(&e) => {
            db.delete_source(t.id);
            video_id = player::resolve(&q, false, db, ytm, ytdlp).await?.video_id;
            ytdlp.download(&video_id, &target, &mut report).await?
        }
        Err(e) => return Err(e),
    };

    let size = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
    let conn = db.0.lock().unwrap();
    upsert_track(&conn, t).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO downloads (track_id, path, size, video_id) VALUES (?1, ?2, ?3, ?4)",
        params![t.id as i64, file.to_string_lossy(), size as i64, video_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// `Carpeta/Artista/Disco/Canción` (sin extensión). Si ya hay otra canción con ese nombre, añade el id.
fn target_path(dir: &Path, t: &LibTrack) -> Res<PathBuf> {
    let folder = dir.join(safe_name(&t.artist_name)).join(safe_name(&t.album_title));
    std::fs::create_dir_all(&folder).map_err(|e| format!("No se pudo crear la carpeta {}: {e}", folder.display()))?;
    let stem = safe_name(&t.title);
    let taken = std::fs::read_dir(&folder)
        .map(|entries| {
            entries.flatten().any(|e| e.path().file_stem().is_some_and(|s| s.to_string_lossy().eq_ignore_ascii_case(&stem)))
        })
        .unwrap_or(false);
    Ok(folder.join(if taken { format!("{stem} ({})", t.id) } else { stem }))
}

/// Nombre válido en Windows, Mac y Linux.
fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || r#"<>:"/\|?*"#.contains(c) { ' ' } else { c })
        .collect();
    let mut cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    cleaned = cleaned.trim_end_matches(['.', ' ']).chars().take(80).collect::<String>().trim_end_matches(['.', ' ']).to_string();
    // Nombres reservados de Windows: CON, PRN, AUX, NUL, COM1–9, LPT1–9.
    let upper = cleaned.to_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&upper.as_str())
        || (upper.len() == 4 && (upper.starts_with("COM") || upper.starts_with("LPT")) && upper.as_bytes()[3].is_ascii_digit());
    if cleaned.is_empty() {
        "Sin título".to_string()
    } else if reserved {
        format!("_{cleaned}")
    } else {
        cleaned
    }
}

fn download_dir(app: &AppHandle, db: &Db) -> PathBuf {
    db.setting(DIR_KEY).map(PathBuf::from).unwrap_or_else(|| {
        app.path()
            .audio_dir()
            .or_else(|_| app.path().home_dir().map(|h| h.join("Music")))
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("Musify")
    })
}

#[tauri::command]
pub fn download(tracks: Vec<LibTrack>, app: AppHandle, db: State<'_, Db>, downloads: State<'_, Downloads>) -> Res<()> {
    let generation = downloads.generation.load(Ordering::SeqCst);
    for track in tracks {
        let id = track.id;
        if db.download_path(id).is_some_and(|p| Path::new(&p).exists()) {
            emit(&app, id, "done", 1.0, None);
            continue;
        }
        if downloads.pending.lock().unwrap().insert(id) {
            emit(&app, id, "queued", 0.0, None);
            downloads.tx.send(Job { track, generation }).map_err(|_| "La cola de descargas no está disponible")?;
        }
    }
    Ok(())
}

/// Vacía la cola: lo que no ha empezado se descarta; lo que se está descargando termina.
#[tauri::command]
pub fn cancel_downloads(downloads: State<'_, Downloads>) {
    downloads.generation.fetch_add(1, Ordering::SeqCst);
}

#[tauri::command]
pub fn downloads_list(db: State<'_, Db>) -> Res<Vec<DownloadEntry>> {
    let conn = db.0.lock().unwrap();
    let mut stmt = conn
        .prepare(&format!(
            "SELECT d.path, d.size, d.downloaded_at, {} FROM downloads d JOIN tracks t ON t.id = d.track_id
             ORDER BY t.artist_name COLLATE NOCASE, t.album_title COLLATE NOCASE, d.downloaded_at",
            crate::library::TRACK_COLS
        ))
        .map_err(|e| e.to_string())?;
    stmt.query_map([], |r| {
        Ok(DownloadEntry { path: r.get(0)?, size: r.get::<_, i64>(1)? as u64, at: r.get(2)?, track: crate::library::track_at(r, 3)? })
    })
    .and_then(|rows| rows.collect())
    .map_err(|e| e.to_string())
}

/// Borra los archivos descargados (y las carpetas de disco/artista que queden vacías).
#[tauri::command]
pub fn remove_downloads(track_ids: Vec<u64>, db: State<'_, Db>) -> Res<()> {
    for id in track_ids {
        if let Some(path) = db.download_path(id) {
            let path = PathBuf::from(path);
            let _ = std::fs::remove_file(&path);
            // remove_dir solo borra carpetas vacías: si hay algo más, se queda.
            if let Some(album) = path.parent() {
                if std::fs::remove_dir(album).is_ok() {
                    if let Some(artist) = album.parent() {
                        let _ = std::fs::remove_dir(artist);
                    }
                }
            }
        }
        db.forget_download(id);
    }
    Ok(())
}

#[tauri::command]
pub fn download_dir_path(app: AppHandle, db: State<'_, Db>) -> String {
    download_dir(&app, &db).to_string_lossy().into_owned()
}

/// Abre el selector de carpetas del sistema. Las descargas nuevas irán a la carpeta elegida;
/// las anteriores se quedan donde están.
#[tauri::command]
pub async fn choose_download_dir(app: AppHandle, db: State<'_, Db>) -> Res<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Carpeta para las descargas")
        .set_directory(download_dir(&app, &db))
        .pick_folder(move |folder| {
            let _ = tx.send(folder);
        });
    let Some(folder) = rx.await.map_err(|e| e.to_string())? else { return Ok(None) };
    let path = folder.into_path().map_err(|e| e.to_string())?;
    let path = path.to_string_lossy().into_owned();
    db.set_setting(DIR_KEY, &path);
    Ok(Some(path))
}

#[tauri::command]
pub fn open_download_dir(app: AppHandle, db: State<'_, Db>) -> Res<()> {
    let dir = download_dir(&app, &db);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener().open_path(dir.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

/// Muestra el archivo de una canción descargada en el explorador.
#[tauri::command]
pub fn reveal_download(track_id: u64, app: AppHandle, db: State<'_, Db>) -> Res<()> {
    let path = db.download_path(track_id).ok_or("Esta canción no está descargada")?;
    app.opener().reveal_item_in_dir(path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Descarga completa (búsqueda + yt-dlp + base de datos) y que después suene el archivo, con red:
    /// `cargo test real_fetch -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn real_fetch() {
        let root = std::env::temp_dir().join(format!("musify-fetch-{}", std::process::id()));
        let dir = root.join("Descargas");
        std::fs::create_dir_all(&root).unwrap();
        let db = Db::open(&root.join("test.db")).unwrap();
        let ytm = YouTubeMusic::new();
        let ytdlp = YtDlp::new(PathBuf::from(env!("LOCALAPPDATA")).join("dev.musify.desktop").join("bin"));
        let track = LibTrack {
            id: 138539971,
            title: "Airbag".into(),
            duration: 287,
            explicit: false,
            artist_id: 399,
            artist_name: "Radiohead".into(),
            album_id: 14879699,
            album_title: "OK Computer".into(),
            album_artist_id: 399,
            cover: None,
        };

        let mut steps = 0;
        fetch(&track, &dir, &db, &ytm, &ytdlp, |_| steps += 1).await.unwrap();
        let path = db.download_path(track.id).expect("apuntada en la base de datos");
        println!("{steps} avisos de progreso → {path}");
        assert!(path.ends_with(r"Radiohead\OK Computer\Airbag.m4a") || path.ends_with("Radiohead/OK Computer/Airbag.m4a"));

        let q = TrackQuery { id: track.id, title: "Airbag".into(), artist: "Radiohead".into(), album: "OK Computer".into(), duration: 287 };
        let playable = player::resolve(&q, false, &db, &ytm, &ytdlp).await.unwrap();
        assert!(playable.local, "si está descargada, suena el archivo");
        assert_eq!(playable.url, path);

        // Si se borra el archivo a mano, vuelve al streaming.
        std::fs::remove_file(&path).unwrap();
        let playable = player::resolve(&q, false, &db, &ytm, &ytdlp).await.unwrap();
        assert!(!playable.local && playable.url.contains("googlevideo.com"));
        assert!(db.download_path(track.id).is_none());

        drop(db);
        for d in [dir.join("Radiohead").join("OK Computer"), dir.join("Radiohead"), dir.clone()] {
            std::fs::remove_dir(d).unwrap();
        }
        for f in ["test.db", "test.db-wal", "test.db-shm"] {
            let _ = std::fs::remove_file(root.join(f));
        }
        let _ = std::fs::remove_dir(&root);
    }

    #[test]
    fn safe_names() {
        assert_eq!(safe_name("AC/DC"), "AC DC");
        assert_eq!(safe_name("What?: \"Live\" <2009>"), "What Live 2009");
        assert_eq!(safe_name("Fin..."), "Fin");
        assert_eq!(safe_name("con"), "_con");
        assert_eq!(safe_name("COM1"), "_COM1");
        assert_eq!(safe_name("   "), "Sin título");
        assert_eq!(safe_name("Canción Ñandú"), "Canción Ñandú");
    }
}
