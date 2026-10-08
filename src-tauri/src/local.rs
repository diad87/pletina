//! Música local: las carpetas que elige el usuario, con sus mp3, m4a, flac, ogg…
//!
//! Se leen las etiquetas de cada archivo y se agrupan en discos y artistas que la interfaz trata
//! igual que los de Deezer (mismas pantallas, playlists, historial, cola). Para no chocar con los
//! ids de Deezer, los ids locales que ve la interfaz son `LOCAL_BASE + id`.
//!
//! Carátulas, por orden: la incrustada en el archivo, la imagen de la carpeta (cover.jpg…) y,
//! si no hay ninguna, la del disco en Deezer. Las fotos de artista salen de Deezer.

use crate::db::Db;
use crate::deezer::{Album, AlbumDetail, AlbumRef, Artist, ArtistPage, ArtistRef, Deezer, TopTrack, Track};
use crate::youtube::normalize;
use lofty::picture::PictureType;
use lofty::prelude::*;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

type Res<T> = Result<T, String>;

/// Los ids de Deezer son mucho menores; los locales empiezan aquí (por debajo de 2^53, seguro en JavaScript).
pub const LOCAL_BASE: u64 = 1_000_000_000_000_000;
const FOLDERS_KEY: &str = "local_folders";
/// Formatos que reproduce el motor web de la app.
const AUDIO: &[&str] = &["mp3", "m4a", "aac", "flac", "ogg", "oga", "opus", "wav"];
/// Imágenes de carpeta que se usan como carátula (nombre sin extensión, en minúsculas).
const FOLDER_COVERS: &[&str] = &["cover", "folder", "front", "album", "albumart", "albumartsmall"];
const UNKNOWN_ARTIST: &str = "Artista desconocido";

pub fn is_local(id: u64) -> bool {
    id >= LOCAL_BASE
}

const fn ui(id: i64) -> u64 {
    LOCAL_BASE + id as u64
}

fn db_id(id: u64) -> i64 {
    (id - LOCAL_BASE) as i64
}

/// Escaneo en curso (solo uno a la vez).
#[derive(Default)]
pub struct Scanner(AtomicBool);

/// Evento "local-scan" para la interfaz.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanProgress {
    /// "scanning" | "covers" | "done"
    state: &'static str,
    done: usize,
    total: usize,
    added: usize,
    removed: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalLibrary {
    pub folders: Vec<String>,
    pub albums: Vec<Album>,
    pub artists: Vec<Artist>,
    pub tracks: u32,
    pub scanning: bool,
}

// ---------- Carpetas ----------

fn folders(db: &Db) -> Vec<String> {
    db.setting(FOLDERS_KEY).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn save_folders(db: &Db, list: &[String]) -> Res<()> {
    let json = serde_json::to_string(list).map_err(|e| format!("No se pudieron guardar las carpetas: {e}"))?;
    db.set_setting(FOLDERS_KEY, &json).map_err(|e| format!("No se pudieron guardar las carpetas: {e}"))
}

fn covers_dir(app: &AppHandle) -> PathBuf {
    app.path().app_local_data_dir().unwrap_or_else(|_| PathBuf::from(".")).join("covers")
}

/// Permite servir las carátulas guardadas por el protocolo de archivos locales.
pub fn allow_covers(app: &AppHandle) {
    let dir = covers_dir(app);
    let _ = std::fs::create_dir_all(&dir);
    let _ = app.asset_protocol_scope().allow_directory(&dir, true);
}

// ---------- Lectura de archivos ----------

struct TrackInfo {
    title: String,
    artist: String,
    album_artist: Option<String>,
    album: String,
    track_no: Option<u32>,
    disc_no: Option<u32>,
    year: Option<String>,
    duration: u32,
    picture: Option<(Vec<u8>, String)>,
}

/// Del nombre del archivo: "01 - Canción" → (pista 1, "Canción"); "1-03 Canción" → (disco 1, pista 3, "Canción").
/// "1979" o "4ever" se quedan como título.
fn parse_file_name(stem: &str) -> (Option<u32>, Option<u32>, String) {
    let mut rest = stem.trim();
    let mut numbers = Vec::new();
    for _ in 0..2 {
        let digits = rest.trim_start_matches(|c: char| c.is_ascii_digit());
        if digits.len() == rest.len() {
            break;
        }
        let after = digits.trim_start_matches([' ', '-', '.', '_', ')']);
        if after.len() == digits.len() || after.is_empty() {
            break;
        }
        numbers.push(rest[..rest.len() - digits.len()].parse::<u32>().ok());
        rest = after.trim_start();
    }
    let (disc, track) = match numbers.as_slice() {
        [track] => (None, *track),
        [disc, track] => (*disc, *track),
        _ => (None, None),
    };
    (disc, track, rest.to_string())
}

fn non_empty(s: Option<impl AsRef<str>>) -> Option<String> {
    s.map(|s| s.as_ref().trim().to_string()).filter(|s| !s.is_empty())
}

/// Etiquetas del archivo; lo que falte se saca del nombre y de las carpetas (Artista/Disco/01 Canción.mp3).
fn read_tags(path: &Path) -> TrackInfo {
    let name = |p: Option<&Path>| p.and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned());
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let (disc_no, track_no, title) = parse_file_name(&stem);
    let mut info = TrackInfo {
        title,
        artist: name(path.parent().and_then(|p| p.parent())).unwrap_or_else(|| UNKNOWN_ARTIST.into()),
        album_artist: None,
        album: name(path.parent()).unwrap_or_else(|| "Sin disco".into()),
        track_no,
        disc_no,
        year: None,
        duration: 0,
        picture: None,
    };
    let Ok(file) = lofty::read_from_path(path) else { return info };
    info.duration = file.properties().duration().as_secs() as u32;
    let Some(tag) = file.primary_tag().or_else(|| file.first_tag()) else { return info };
    if let Some(t) = non_empty(tag.title()) {
        info.title = t;
    }
    if let Some(a) = non_empty(tag.artist()) {
        info.artist = a;
    }
    if let Some(a) = non_empty(tag.album()) {
        info.album = a;
    }
    info.album_artist = non_empty(tag.get_string(ItemKey::AlbumArtist));
    info.track_no = tag.track().or(info.track_no);
    info.disc_no = tag.disk().or(info.disc_no);
    info.year = tag.date().map(|d| d.year.to_string()).filter(|y| y != "0");
    let pictures = tag.pictures();
    if let Some(pic) = pictures.iter().find(|p| p.pic_type() == PictureType::CoverFront).or(pictures.first()) {
        let ext = pic.mime_type().and_then(|m| m.ext()).unwrap_or("jpg").to_string();
        info.picture = Some((pic.data().to_vec(), ext));
    }
    info
}

fn audio_files(root: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            audio_files(&path, out);
        } else if path
            .extension()
            .is_some_and(|e| AUDIO.contains(&e.to_string_lossy().to_lowercase().as_str()))
        {
            out.push(path);
        }
    }
}

/// Imagen de la carpeta del disco (cover.jpg, folder.png…), si la hay.
fn folder_cover(dir: &Path) -> Option<PathBuf> {
    std::fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).find(|p| {
        let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        let stem = p.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
        ["jpg", "jpeg", "png", "webp"].contains(&ext.as_str())
            && (FOLDER_COVERS.contains(&stem.as_str()) || stem.starts_with("albumart"))
    })
}

fn key(name: &str) -> String {
    let k = normalize(name);
    if k.is_empty() { name.trim().to_lowercase() } else { k }
}

fn artist_id(conn: &Connection, name: &str) -> rusqlite::Result<i64> {
    let k = key(name);
    conn.execute("INSERT OR IGNORE INTO local_artists (name, key) VALUES (?1, ?2)", params![name, k])?;
    conn.query_row("SELECT id FROM local_artists WHERE key = ?1", params![k], |r| r.get(0))
}

/// Guarda (o actualiza) una canción, su disco y su artista; pone la carátula si el disco no tiene.
fn save_track(conn: &Connection, path: &Path, info: &TrackInfo, mtime: i64, size: i64, covers: &Path) -> rusqlite::Result<()> {
    let album_artist = info.album_artist.clone().unwrap_or_else(|| info.artist.clone());
    let track_artist = artist_id(conn, &info.artist)?;
    let album_artist_id = artist_id(conn, &album_artist)?;
    let album_key = format!("{}\u{1f}{}", key(&album_artist), key(&info.album));
    conn.execute(
        "INSERT OR IGNORE INTO local_albums (title, artist_id, year, key) VALUES (?1, ?2, ?3, ?4)",
        params![info.album, album_artist_id, info.year, album_key],
    )?;
    let (album_id, cover): (i64, Option<String>) =
        conn.query_row("SELECT id, cover FROM local_albums WHERE key = ?1", params![album_key], |r| Ok((r.get(0)?, r.get(1)?)))?;
    if info.year.is_some() {
        conn.execute("UPDATE local_albums SET year = COALESCE(year, ?2) WHERE id = ?1", params![album_id, info.year])?;
    }

    // Una carátula de Deezer (URL) se sustituye por una propia si aparece.
    if cover.as_deref().is_none_or(|c| c.starts_with("http")) {
        let mut saved = None;
        if let Some((data, ext)) = &info.picture {
            let file = covers.join(format!("local-{album_id}.{ext}"));
            if std::fs::write(&file, data).is_ok() {
                saved = Some(file);
            }
        } else if let Some(img) = path.parent().and_then(folder_cover) {
            let ext = img.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_else(|| "jpg".into());
            let file = covers.join(format!("local-{album_id}.{ext}"));
            if std::fs::copy(&img, &file).is_ok() {
                saved = Some(file);
            }
        }
        if let Some(file) = saved {
            conn.execute("UPDATE local_albums SET cover = ?2 WHERE id = ?1", params![album_id, file.to_string_lossy()])?;
        }
    }

    conn.execute(
        "INSERT INTO local_tracks (path, title, artist_id, album_id, track_no, disc_no, duration, mtime, size)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(path) DO UPDATE SET title = excluded.title, artist_id = excluded.artist_id,
            album_id = excluded.album_id, track_no = excluded.track_no, disc_no = excluded.disc_no,
            duration = excluded.duration, mtime = excluded.mtime, size = excluded.size",
        params![path.to_string_lossy(), info.title, track_artist, album_id, info.track_no, info.disc_no, info.duration, mtime, size],
    )?;
    Ok(())
}

// ---------- Escaneo ----------

/// Recorre las carpetas: añade lo nuevo, actualiza lo cambiado y quita lo que ya no está.
fn scan(app: &AppHandle) -> Res<(usize, usize)> {
    let db = app.state::<Db>();
    let covers = covers_dir(app);
    std::fs::create_dir_all(&covers).map_err(|e| e.to_string())?;

    let mut files = Vec::new();
    for folder in folders(&db) {
        audio_files(Path::new(&folder), &mut files);
    }

    let known: HashMap<String, (i64, i64)> = {
        let conn = db.0.lock().unwrap();
        let mut stmt = conn.prepare("SELECT path, mtime, size FROM local_tracks").map_err(|e| e.to_string())?;
        stmt.query_map([], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))
            .and_then(|rows| rows.collect())
            .map_err(|e| e.to_string())?
    };

    let total = files.len();
    let progress = |done, added, removed| {
        let _ = app.emit("local-scan", ScanProgress { state: "scanning", done, total, added, removed });
    };
    let mut seen = HashSet::new();
    let mut added = 0;
    for (i, path) in files.iter().enumerate() {
        let path_str = path.to_string_lossy().into_owned();
        seen.insert(path_str.clone());
        let Ok(meta) = std::fs::metadata(path) else { continue };
        let mtime = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs() as i64);
        let size = meta.len() as i64;
        if known.get(&path_str) == Some(&(mtime, size)) {
            continue;
        }
        // Las etiquetas se leen sin bloquear la base de datos.
        let info = read_tags(path);
        let conn = db.0.lock().unwrap();
        if save_track(&conn, path, &info, mtime, size, &covers).is_ok() {
            added += 1;
        }
        drop(conn);
        if i % 25 == 0 {
            progress(i, added, 0);
        }
    }

    // Lo que ya no está (archivo borrado o carpeta quitada), fuera; y los discos y artistas que se queden vacíos.
    let gone: Vec<&String> = known.keys().filter(|p| !seen.contains(*p)).collect();
    let conn = db.0.lock().unwrap();
    for path in &gone {
        let _ = conn.execute("DELETE FROM local_tracks WHERE path = ?1", params![path]);
    }
    let empty_albums: Vec<(i64, Option<String>)> = conn
        .prepare("SELECT id, cover FROM local_albums WHERE id NOT IN (SELECT album_id FROM local_tracks)")
        .and_then(|mut s| s.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect())
        .unwrap_or_default();
    for (id, cover) in empty_albums {
        if let Some(c) = cover.filter(|c| !c.starts_with("http")) {
            let _ = std::fs::remove_file(c);
        }
        let _ = conn.execute("DELETE FROM local_albums WHERE id = ?1", params![id]);
    }
    let _ = conn.execute(
        "DELETE FROM local_artists WHERE id NOT IN (SELECT artist_id FROM local_tracks)
           AND id NOT IN (SELECT artist_id FROM local_albums)",
        [],
    );
    progress(total, added, gone.len());
    Ok((added, gone.len()))
}

/// Carátulas y fotos que faltan, desde Deezer (una búsqueda por disco o artista, una sola vez).
async fn fetch_missing_art(app: &AppHandle) {
    let db = app.state::<Db>();
    let deezer = app.state::<Deezer>();
    let albums: Vec<(i64, String, String)> = {
        let conn = db.0.lock().unwrap();
        conn.prepare(
            "SELECT a.id, a.title, ar.name FROM local_albums a JOIN local_artists ar ON ar.id = a.artist_id
             WHERE a.cover IS NULL AND a.cover_checked = 0",
        )
        .and_then(|mut s| s.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect())
        .unwrap_or_default()
    };
    if !albums.is_empty() {
        let _ = app.emit("local-scan", ScanProgress { state: "covers", done: 0, total: albums.len(), added: 0, removed: 0 });
    }
    for (id, title, artist) in albums {
        let query = if artist == UNKNOWN_ARTIST { title.clone() } else { format!("{artist} {title}") };
        let cover = match deezer.search(&query).await {
            Ok(found) => found
                .albums
                .into_iter()
                .find(|a| {
                    let (want, got) = (key(&title), key(&a.title));
                    let same_title = want == got || got.starts_with(&want) || want.starts_with(&got);
                    let same_artist = artist == UNKNOWN_ARTIST || a.artist.as_ref().is_some_and(|ar| key(&ar.name) == key(&artist));
                    same_title && same_artist
                })
                .and_then(|a| a.cover_xl.or(a.cover_medium)),
            Err(_) => continue, // sin conexión: se vuelve a intentar en el próximo escaneo
        };
        {
            let conn = db.0.lock().unwrap();
            let _ = conn.execute("UPDATE local_albums SET cover = ?2, cover_checked = 1 WHERE id = ?1", params![id, cover]);
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }

    let artists: Vec<(i64, String)> = {
        let conn = db.0.lock().unwrap();
        conn.prepare("SELECT id, name FROM local_artists WHERE picture IS NULL AND picture_checked = 0 AND name != ?1")
            .and_then(|mut s| s.query_map(params![UNKNOWN_ARTIST], |r| Ok((r.get(0)?, r.get(1)?)))?.collect())
            .unwrap_or_default()
    };
    for (id, name) in artists {
        let picture = match deezer.search(&name).await {
            Ok(found) => found.artists.into_iter().find(|a| key(&a.name) == key(&name)).and_then(|a| a.picture_xl),
            Err(_) => continue,
        };
        {
            let conn = db.0.lock().unwrap();
            let _ = conn.execute("UPDATE local_artists SET picture = ?2, picture_checked = 1 WHERE id = ?1", params![id, picture]);
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

/// Lanza un escaneo en segundo plano (si no hay ya uno en marcha).
pub fn start_scan(app: &AppHandle) {
    if app.state::<Scanner>().0.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let scan_app = app.clone();
        let result = tauri::async_runtime::spawn_blocking(move || scan(&scan_app)).await;
        let (added, removed) = match result {
            Ok(Ok(counts)) => counts,
            _ => (0, 0),
        };
        let _ = app.emit("local-changed", ());
        fetch_missing_art(&app).await;
        app.state::<Scanner>().0.store(false, Ordering::SeqCst);
        let _ = app.emit("local-scan", ScanProgress { state: "done", done: 0, total: 0, added, removed });
        let _ = app.emit("local-changed", ());
    });
}

// ---------- Consultas para la interfaz ----------

const ALBUM_SELECT: &str = "SELECT a.id, a.title, a.year, a.cover, ar.id, ar.name, ar.picture,
        (SELECT COUNT(*) FROM local_tracks t WHERE t.album_id = a.id)
    FROM local_albums a JOIN local_artists ar ON ar.id = a.artist_id";

fn album_row(r: &Row) -> rusqlite::Result<Album> {
    let cover: Option<String> = r.get(3)?;
    Ok(Album {
        id: ui(r.get(0)?),
        title: r.get(1)?,
        cover_medium: cover.clone(),
        cover_xl: cover,
        release_date: r.get(2)?,
        record_type: Some("album".into()),
        nb_tracks: r.get(7)?,
        explicit_lyrics: false,
        fans: 0,
        artist: Some(ArtistRef { id: ui(r.get(4)?), name: r.get(5)?, picture_medium: r.get(6)? }),
    })
}

const ARTIST_SELECT: &str = "SELECT ar.id, ar.name, ar.picture,
        (SELECT COUNT(*) FROM local_albums a WHERE a.artist_id = ar.id),
        (SELECT a.cover FROM local_albums a WHERE a.artist_id = ar.id AND a.cover IS NOT NULL LIMIT 1)
    FROM local_artists ar";

fn artist_row(r: &Row) -> rusqlite::Result<Artist> {
    // Sin foto de artista, la carátula de uno de sus discos.
    let picture: Option<String> = r.get::<_, Option<String>>(2)?.or(r.get(4)?);
    Ok(Artist {
        id: ui(r.get(0)?),
        name: r.get(1)?,
        picture_medium: picture.clone(),
        picture_xl: picture,
        nb_album: r.get(3)?,
        nb_fan: 0,
    })
}

const TRACK_SELECT: &str = "SELECT t.id, t.title, t.duration, t.track_no, t.disc_no, ar.id, ar.name
    FROM local_tracks t JOIN local_artists ar ON ar.id = t.artist_id";

fn track_row(r: &Row) -> rusqlite::Result<Track> {
    Ok(Track {
        id: ui(r.get(0)?),
        title: r.get(1)?,
        title_version: None,
        duration: r.get(2)?,
        track_position: r.get::<_, Option<u32>>(3)?.unwrap_or(0),
        disk_number: r.get::<_, Option<u32>>(4)?.unwrap_or(1),
        explicit_lyrics: false,
        isrc: None,
        artist: ArtistRef { id: ui(r.get(5)?), name: r.get(6)?, picture_medium: None },
    })
}

pub fn album(db: &Db, id: u64) -> Res<AlbumDetail> {
    let conn = db.0.lock().unwrap();
    let a = conn
        .query_row(&format!("{ALBUM_SELECT} WHERE a.id = ?1"), params![db_id(id)], album_row)
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or("Este disco ya no está en tu música")?;
    let tracks: Vec<Track> = conn
        .prepare(&format!("{TRACK_SELECT} WHERE t.album_id = ?1 ORDER BY COALESCE(t.disc_no, 1), t.track_no IS NULL, t.track_no, t.title"))
        .and_then(|mut s| s.query_map(params![db_id(id)], track_row)?.collect())
        .map_err(|e| e.to_string())?;
    Ok(AlbumDetail {
        id: a.id,
        title: a.title,
        cover_big: a.cover_medium.clone(),
        cover_xl: a.cover_xl,
        release_date: a.release_date,
        record_type: Some("album".into()),
        label: None,
        duration: tracks.iter().map(|t| t.duration).sum(),
        nb_tracks: tracks.len() as u32,
        explicit_lyrics: false,
        genres: vec![],
        artist: a.artist.unwrap_or(ArtistRef { id: 0, name: UNKNOWN_ARTIST.into(), picture_medium: None }),
        tracks,
    })
}

pub fn artist(db: &Db, id: u64) -> Res<ArtistPage> {
    let conn = db.0.lock().unwrap();
    let artist = conn
        .query_row(&format!("{ARTIST_SELECT} WHERE ar.id = ?1"), params![db_id(id)], artist_row)
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or("Este artista ya no está en tu música")?;
    let albums: Vec<Album> = conn
        .prepare(&format!("{ALBUM_SELECT} WHERE a.artist_id = ?1 ORDER BY a.year DESC, a.title"))
        .and_then(|mut s| s.query_map(params![db_id(id)], album_row)?.collect())
        .map_err(|e| e.to_string())?;
    // Sus canciones (en lugar de "las más escuchadas" de Deezer), con su disco.
    let top: Vec<TopTrack> = conn
        .prepare(&format!(
            "SELECT t.id, t.title, t.duration, t.track_no, t.disc_no, ar.id, ar.name, a.id, a.title, a.cover
             FROM local_tracks t JOIN local_artists ar ON ar.id = t.artist_id JOIN local_albums a ON a.id = t.album_id
             WHERE t.artist_id = ?1 ORDER BY a.year DESC, a.title, COALESCE(t.disc_no, 1), t.track_no IS NULL, t.track_no LIMIT 50"
        ))
        .and_then(|mut s| {
            s.query_map(params![db_id(id)], |r| {
                let cover: Option<String> = r.get(9)?;
                Ok(TopTrack {
                    track: track_row(r)?,
                    album: AlbumRef { id: ui(r.get(7)?), title: r.get(8)?, cover_medium: cover.clone(), cover_big: cover },
                })
            })?
            .collect()
        })
        .map_err(|e| e.to_string())?;
    Ok(ArtistPage { artist, albums, top })
}

/// Artistas y discos locales que coinciden con la búsqueda.
pub fn search(db: &Db, query: &str) -> (Vec<Artist>, Vec<Album>) {
    let q = format!("%{}%", query.trim());
    let conn = db.0.lock().unwrap();
    let artists = conn
        .prepare(&format!("{ARTIST_SELECT} WHERE ar.name LIKE ?1 ORDER BY ar.name LIMIT 8"))
        .and_then(|mut s| s.query_map(params![q], artist_row)?.collect())
        .unwrap_or_default();
    let albums = conn
        .prepare(&format!("{ALBUM_SELECT} WHERE a.title LIKE ?1 OR ar.name LIKE ?1 ORDER BY ar.name, a.year LIMIT 30"))
        .and_then(|mut s| s.query_map(params![q], album_row)?.collect())
        .unwrap_or_default();
    (artists, albums)
}

/// Archivo de una canción local.
pub fn path(db: &Db, track_id: u64) -> Option<String> {
    db.0.lock()
        .unwrap()
        .query_row("SELECT path FROM local_tracks WHERE id = ?1", params![db_id(track_id)], |r| r.get(0))
        .optional()
        .ok()
        .flatten()
}

// ---------- Comandos ----------

#[tauri::command]
pub fn local_library(db: State<'_, Db>, scanner: State<'_, Scanner>) -> Res<LocalLibrary> {
    let folders = folders(&db);
    let conn = db.0.lock().unwrap();
    let albums = conn
        .prepare(&format!("{ALBUM_SELECT} ORDER BY ar.name COLLATE NOCASE, a.year, a.title COLLATE NOCASE"))
        .and_then(|mut s| s.query_map([], album_row)?.collect())
        .map_err(|e| e.to_string())?;
    let artists = conn
        .prepare(&format!(
            "{ARTIST_SELECT} WHERE ar.id IN (SELECT artist_id FROM local_albums) ORDER BY ar.name COLLATE NOCASE"
        ))
        .and_then(|mut s| s.query_map([], artist_row)?.collect())
        .map_err(|e| e.to_string())?;
    let tracks = conn.query_row("SELECT COUNT(*) FROM local_tracks", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    Ok(LocalLibrary { folders, albums, artists, tracks, scanning: scanner.0.load(Ordering::SeqCst) })
}

/// Abre el selector de carpetas, la añade y la escanea.
#[tauri::command]
pub async fn add_local_folder(app: AppHandle, db: State<'_, Db>) -> Res<Vec<String>> {
    let picked = crate::downloads::pick_folder(&app, "Carpeta con tu música", None).await?;
    let mut list = folders(&db);
    if let Some(folder) = picked {
        let path = folder.to_string_lossy().into_owned();
        if !list.contains(&path) {
            list.push(path);
            save_folders(&db, &list)?;
            start_scan(&app);
        }
    }
    Ok(list)
}

#[tauri::command]
pub fn remove_local_folder(path: String, app: AppHandle, db: State<'_, Db>) -> Res<Vec<String>> {
    let mut list = folders(&db);
    list.retain(|f| f != &path);
    save_folders(&db, &list)?;
    start_scan(&app);
    Ok(list)
}

#[tauri::command]
pub fn scan_local(app: AppHandle) {
    start_scan(&app);
}

/// Muestra el archivo de una canción local en el explorador.
#[tauri::command]
pub fn reveal_local(track_id: u64, app: AppHandle, db: State<'_, Db>) -> Res<()> {
    let file = path(&db, track_id).ok_or("No se encuentra el archivo")?;
    app.opener().reveal_item_in_dir(file).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_changes_report_write_failure_and_keep_previous_setting() {
        let db = Db::open(Path::new(":memory:")).unwrap();
        save_folders(&db, &["original".to_string()]).unwrap();
        db.0.lock().unwrap().execute_batch("PRAGMA query_only=ON;").unwrap();
        assert!(save_folders(&db, &["replacement".to_string()]).is_err());
        assert_eq!(folders(&db), ["original"]);
        db.0.lock().unwrap().execute_batch("PRAGMA query_only=OFF;").unwrap();
        save_folders(&db, &["replacement".to_string()]).unwrap();
        assert_eq!(folders(&db), ["replacement"]);
    }

    #[test]
    fn titles_from_file_names() {
        assert_eq!(parse_file_name("01 - Airbag"), (None, Some(1), "Airbag".into()));
        assert_eq!(parse_file_name("07. Karma Police"), (None, Some(7), "Karma Police".into()));
        assert_eq!(parse_file_name("1-03 Paranoid Android"), (Some(1), Some(3), "Paranoid Android".into()));
        assert_eq!(parse_file_name("Paranoid Android"), (None, None, "Paranoid Android".into()));
        assert_eq!(parse_file_name("1979"), (None, None, "1979".into()));
        assert_eq!(parse_file_name("4ever"), (None, None, "4ever".into()));
    }

    #[test]
    fn scan_folder_with_tags_and_folder_cover() {
        // Carpeta Artista/Disco con un mp3 sin etiquetas y una imagen cover.jpg.
        let root = std::env::temp_dir().join(format!("musify-local-{}", std::process::id()));
        let album_dir = root.join("Berri Txarrak").join("Infrasoinuak");
        std::fs::create_dir_all(&album_dir).unwrap();
        std::fs::write(album_dir.join("02 - Zuri.mp3"), b"no es un mp3 de verdad").unwrap();
        std::fs::write(album_dir.join("cover.jpg"), b"jpeg").unwrap();
        let covers = root.join("covers");
        std::fs::create_dir_all(&covers).unwrap();
        let db = Db::open(&root.join("test.db")).unwrap();

        let path = album_dir.join("02 - Zuri.mp3");
        let info = read_tags(&path);
        assert_eq!((info.title.as_str(), info.artist.as_str(), info.album.as_str()), ("Zuri", "Berri Txarrak", "Infrasoinuak"));
        save_track(&db.0.lock().unwrap(), &path, &info, 1, 2, &covers).unwrap();

        let lib = {
            let conn = db.0.lock().unwrap();
            conn.query_row(&format!("{ALBUM_SELECT} LIMIT 1"), [], album_row).unwrap()
        };
        assert_eq!(lib.title, "Infrasoinuak");
        assert!(lib.cover_xl.as_deref().is_some_and(|c| c.ends_with(".jpg")), "usa cover.jpg de la carpeta");
        assert!(lib.id >= LOCAL_BASE);
        let detail = album(&db, lib.id).unwrap();
        assert_eq!(detail.tracks[0].title, "Zuri");
        assert_eq!(super::path(&db, detail.tracks[0].id).unwrap(), path.to_string_lossy());

        drop(db);
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod real_files {
    use super::*;

    /// Lee una carpeta real de música (no la modifica). Carpeta en MUSIFY_TEST_MUSIC:
    /// `MUSIFY_TEST_MUSIC=C:\ruta cargo test real_tags -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_tags() {
        let root = PathBuf::from(std::env::var("MUSIFY_TEST_MUSIC").expect("MUSIFY_TEST_MUSIC"));
        let mut files = Vec::new();
        audio_files(&root, &mut files);
        for f in &files {
            let i = read_tags(f);
            println!(
                "{} → «{}» · {} · {} (artista del disco: {:?}) · pista {:?} · {:?} · {} s · carátula incrustada: {}",
                f.file_name().unwrap().to_string_lossy(),
                i.title,
                i.artist,
                i.album,
                i.album_artist,
                i.track_no,
                i.year,
                i.duration,
                i.picture.as_ref().map_or("no".to_string(), |(d, ext)| format!("{} KB {ext}", d.len() / 1024))
            );
        }
        assert!(!files.is_empty());
    }
}
