//! Catálogo local para Android Auto. Solo necesita SQLite: funciona sin Tauri, WebView ni red.
//! Kotlin pagina los resultados de browse y crea la cola conservando el orden y las repeticiones.
//! Los IDs canónicos identifican carpetas o canciones; el servicio añade el contexto de la cola.

use crate::db::Db;
use crate::library::{LibTrack, TRACK_COLS, track_at};
use crate::youtube::normalize;
use reqwest::Url;
use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use std::path::Path;

type Res<T> = Result<T, String>;
const MAX_ID: u64 = 9_007_199_254_740_991;
/// La búsqueda por voz solo consulta la biblioteca del usuario, con un máximo de 100 resultados.
const SEARCH_LIMIT: usize = 100;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogItem {
    pub id: String,
    pub title: String,
    pub subtitle: String,
    pub artwork_uri: Option<String>,
    pub browsable: bool,
    pub playable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub track: Option<LibTrack>,
}

fn folder(id: &str, title: &str, subtitle: &str) -> CatalogItem {
    CatalogItem {
        id: id.into(), title: title.into(), subtitle: subtitle.into(), artwork_uri: None,
        browsable: true, playable: false, track: None,
    }
}

fn roots() -> Vec<CatalogItem> {
    vec![
        folder("liked", "Favoritos", "Canciones que te gustan"),
        folder("playlists", "Playlists", "Tus listas guardadas"),
        folder("downloads", "Descargas", "Para escuchar sin conexión"),
        folder("youtube", "YouTube", "Canciones añadidas por enlace"),
    ]
}

fn artwork_uri(cover: Option<&str>) -> Option<String> {
    let cover = cover.filter(|s| !s.is_empty())?;
    if let Ok(url) = Url::parse(cover) {
        if matches!(url.scheme(), "https" | "http" | "file") { return Some(url.to_string()); }
    }
    Url::from_file_path(cover).ok().map(|url| url.to_string())
}

fn song(track: LibTrack) -> CatalogItem {
    CatalogItem {
        id: format!("track:{}", track.id),
        title: track.title.clone(),
        subtitle: track.artist_name.clone(),
        artwork_uri: artwork_uri(track.cover.as_deref()),
        browsable: false,
        playable: true,
        track: Some(track),
    }
}

fn db_error(error: rusqlite::Error) -> String {
    format!("No se pudo leer la biblioteca para Android Auto: {error}")
}

fn parse_id(value: &str) -> Res<u64> {
    let id = value.parse::<u64>().ok().filter(|id| *id > 0 && *id <= MAX_ID);
    id.filter(|id| id.to_string() == value).ok_or_else(|| "El identificador de la biblioteca no es válido".into())
}

/// Solo se ofrecen pistas con metadatos y referencias utilizables por player::resolve.
/// No se comprueba la disponibilidad remota: esa comprobación sucede al reproducir.
fn available(db: &Db, track: &LibTrack) -> bool {
    if track.id == 0 || track.id > MAX_ID || track.title.trim().is_empty() || track.artist_name.trim().is_empty() {
        return false;
    }
    if crate::youtube_tracks::is_youtube(track.id) {
        return crate::youtube_tracks::video(db, track.id).is_ok();
    }
    if crate::podcasts::is_podcast(track.id) {
        return crate::podcasts::audio(db, track.id).is_ok_and(|audio| {
            if let Some(video) = audio.strip_prefix(crate::youtube_podcasts::PREFIX) {
                return video.len() == 11 && video.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'));
            }
            Url::parse(&audio).is_ok_and(|url| matches!(url.scheme(), "https" | "http") && url.host_str().is_some())
        });
    }
    if crate::local::is_local(track.id) {
        return crate::local::path(db, track.id).is_some_and(|path| Path::new(&path).is_file());
    }
    true
}

fn downloaded(db: &Db, id: u64) -> bool {
    db.download_path(id).is_some_and(|path| Path::new(&path).is_file())
}

/// Suelta el bloqueo antes de validar referencias, que también leen la base de datos.
fn tracks(db: &Db, sql: &str, id: Option<u64>) -> Res<Vec<LibTrack>> {
    let conn = db.0.lock().map_err(|_| "La biblioteca está ocupada después de un error")?;
    let mut statement = conn.prepare(sql).map_err(db_error)?;
    let read = |row: &rusqlite::Row<'_>| track_at(row, 0);
    let rows = if let Some(id) = id {
        statement.query_map(params![id as i64], read).map_err(db_error)?
    } else {
        statement.query_map([], read).map_err(db_error)?
    };
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_error)
}

fn playlist_folder(db: &Db, id: u64) -> Res<CatalogItem> {
    let conn = db.0.lock().map_err(|_| "La biblioteca está ocupada después de un error")?;
    let name: Option<String> = conn.query_row("SELECT name FROM playlists WHERE id = ?1", params![id as i64], |r| r.get(0))
        .optional().map_err(db_error)?;
    name.map(|name| folder(&format!("playlist:{id}"), &name, "Playlist"))
        .ok_or_else(|| "Esta playlist ya no existe".into())
}

pub fn browse(db: &Db, parent_id: &str) -> Res<Vec<CatalogItem>> {
    if parent_id == "root" { return Ok(roots()); }
    if parent_id == "playlists" {
        let conn = db.0.lock().map_err(|_| "La biblioteca está ocupada después de un error")?;
        return conn.prepare("SELECT id, name FROM playlists ORDER BY updated_at DESC, id DESC").map_err(db_error)?
            .query_map([], |row| {
                let id: i64 = row.get(0)?;
                let title: String = row.get(1)?;
                Ok(folder(&format!("playlist:{id}"), &title, "Playlist"))
            }).map_err(db_error)?.collect::<rusqlite::Result<Vec<_>>>().map_err(db_error);
    }
    let (sql, id) = match parent_id {
        "liked" => (format!("SELECT {TRACK_COLS} FROM liked_tracks l JOIN tracks t ON t.id = l.track_id ORDER BY l.added_at DESC, l.rowid DESC"), None),
        "downloads" => (format!("SELECT {TRACK_COLS} FROM downloads d JOIN tracks t ON t.id = d.track_id ORDER BY d.downloaded_at DESC, d.track_id DESC"), None),
        "youtube" => (format!("SELECT {TRACK_COLS} FROM youtube_tracks y JOIN tracks t ON t.id = y.track_id WHERE y.saved = 1 ORDER BY y.added_at DESC, y.track_id DESC"), None),
        _ => {
            let id = parse_id(parent_id.strip_prefix("playlist:").ok_or("Esta carpeta de la biblioteca no existe")?)?;
            playlist_folder(db, id)?;
            (format!("SELECT {TRACK_COLS} FROM playlist_tracks p JOIN tracks t ON t.id = p.track_id WHERE p.playlist_id = ?1 ORDER BY p.position, p.id"), Some(id))
        }
    };
    Ok(tracks(db, &sql, id)?.into_iter()
        .filter(|track| available(db, track) && (parent_id != "downloads" || downloaded(db, track.id)))
        .map(song).collect())
}

pub fn media_item(db: &Db, media_id: &str) -> Res<CatalogItem> {
    if media_id == "root" { return Ok(folder("root", "Pletina", "Tu biblioteca")); }
    if let Some(item) = roots().into_iter().find(|item| item.id == media_id) { return Ok(item); }
    if let Some(id) = media_id.strip_prefix("playlist:") { return playlist_folder(db, parse_id(id)?); }
    let id = parse_id(media_id.strip_prefix("track:").ok_or("Este elemento de la biblioteca no existe")?)?;
    let track = tracks(db, &format!("SELECT {TRACK_COLS} FROM tracks t WHERE t.id = ?1"), Some(id))?.pop()
        .filter(|track| available(db, track)).ok_or("Esta canción ya no está disponible en tu biblioteca")?;
    Ok(song(track))
}

pub fn search(db: &Db, query: &str) -> Res<Vec<CatalogItem>> {
    if query.chars().count() > 200 { return Err("La búsqueda no puede superar 200 caracteres".into()); }
    let query = normalize(query);
    if query.is_empty() { return Ok(vec![]); }
    let words: Vec<_> = query.split_whitespace().collect();
    // EXISTS evita repetir canciones de varias listas y excluye restos de canciones quitadas.
    let sql = format!("SELECT {TRACK_COLS} FROM tracks t WHERE
        EXISTS (SELECT 1 FROM liked_tracks l WHERE l.track_id = t.id)
        OR EXISTS (SELECT 1 FROM playlist_tracks p WHERE p.track_id = t.id)
        OR EXISTS (SELECT 1 FROM downloads d WHERE d.track_id = t.id)
        OR EXISTS (SELECT 1 FROM youtube_tracks y WHERE y.track_id = t.id AND y.saved = 1)
        ORDER BY t.title COLLATE NOCASE, t.id");
    let candidates = tracks(db, &sql, None)?;
    let conn = db.0.lock().map_err(|_| "La biblioteca está ocupada después de un error")?;
    // Una descarga cuyo archivo se borró no basta, por sí sola, para mantener una canción en los resultados.
    let retained: std::collections::HashSet<u64> = conn.prepare("SELECT track_id FROM liked_tracks UNION SELECT track_id FROM playlist_tracks
        UNION SELECT track_id FROM youtube_tracks WHERE saved = 1").map_err(db_error)?
        .query_map([], |row| row.get::<_, i64>(0).map(|id| id as u64)).map_err(db_error)?
        .collect::<rusqlite::Result<_>>().map_err(db_error)?;
    drop(conn);
    Ok(candidates.into_iter().filter(|track| {
        let text = normalize(&format!("{} {} {}", track.title, track.artist_name, track.album_title));
        words.iter().all(|word| text.contains(word)) && available(db, track)
            && (retained.contains(&track.id) || downloaded(db, track.id))
    }).take(SEARCH_LIMIT).map(song).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::save_track_metadata;

    fn db() -> Db { Db::open(Path::new(":memory:")).unwrap() }

    fn track(id: u64, title: &str) -> LibTrack {
        LibTrack { id, title: title.into(), duration: 210, explicit: false, artist_id: 7,
            artist_name: "Björk".into(), album_id: 8, album_title: "Homogenic".into(), album_artist_id: 7,
            cover: Some("https://example.com/cover.jpg".into()) }
    }

    fn add(db: &Db, track: &LibTrack, liked: bool) {
        let conn = db.0.lock().unwrap();
        save_track_metadata(&conn, track).unwrap();
        if liked { conn.execute("INSERT INTO liked_tracks (track_id) VALUES (?1)", params![track.id as i64]).unwrap(); }
    }

    #[test]
    fn catalog_is_available_after_restart_and_preserves_playlist_duplicates() {
        let path = std::env::temp_dir().join(format!("pletina-auto-catalog-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        {
            let db = Db::open(&path).unwrap();
            add(&db, &track(1, "Jóga"), true);
            add(&db, &track(2, "Bachelorette"), false);
            let conn = db.0.lock().unwrap();
            conn.execute_batch("INSERT INTO playlists (id, name) VALUES (12, 'Viaje');
                INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (12, 2, 0), (12, 1, 1), (12, 2, 2);").unwrap();
        }
        {
            // Sin AppHandle, Tauri o WebView: exactamente el acceso que hace JNI al arrancar solo.
            let db = Db::open(&path).unwrap();
            let root = browse(&db, "root").unwrap();
            assert_eq!(root.iter().map(|item| item.id.as_str()).collect::<Vec<_>>(), ["liked", "playlists", "downloads", "youtube"]);
            assert!(root.iter().all(|item| item.browsable && !item.playable && item.track.is_none()));
            assert_eq!(browse(&db, "playlists").unwrap()[0].id, "playlist:12");
            let playlist = browse(&db, "playlist:12").unwrap();
            assert_eq!(playlist.iter().map(|item| item.id.as_str()).collect::<Vec<_>>(), ["track:2", "track:1", "track:2"]);
            let recovered = media_item(&db, &playlist[1].id).unwrap();
            assert_eq!(recovered.track.unwrap().title, "Jóga");
            let json = serde_json::to_value(&playlist[0]).unwrap();
            assert_eq!(json["artworkUri"], "https://example.com/cover.jpg");
            assert_eq!(json["track"]["artistName"], "Björk");
            assert_eq!(json["playable"], true);
            db.0.lock().unwrap().execute("DELETE FROM playlists WHERE id = 12", []).unwrap();
            assert!(browse(&db, "playlist:12").is_err());
            assert!(browse(&db, "playlists").unwrap().is_empty());
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn downloads_require_files_and_invalid_sources_do_not_become_playable() {
        let db = db();
        let path = std::env::temp_dir().join(format!("pletina-auto-audio-{}.mp3", std::process::id()));
        std::fs::write(&path, b"audio fixture").unwrap();
        for (id, title) in [(1, "Descargada"), (2, "Borrada"), (3, "Directorio"), (4, "")] {
            add(&db, &track(id, title), false);
        }
        let orphan = crate::youtube_tracks::YOUTUBE_BASE + 123;
        add(&db, &track(orphan, "Sin vídeo asociado"), true);
        let local = crate::local::LOCAL_BASE + 123;
        add(&db, &track(local, "Archivo local borrado"), true);
        {
            let conn = db.0.lock().unwrap();
            for (id, file) in [(1, path.clone()), (2, path.with_extension("missing")), (3, std::env::temp_dir()), (4, path.clone())] {
                conn.execute("INSERT INTO downloads (track_id, path, size, video_id) VALUES (?1, ?2, 1, 'dQw4w9WgXcQ')", params![id, file.to_string_lossy()]).unwrap();
            }
        }
        let downloads = browse(&db, "downloads").unwrap();
        assert_eq!(downloads.len(), 1);
        assert_eq!(downloads[0].id, "track:1");
        assert!(browse(&db, "liked").unwrap().is_empty());
        assert!(media_item(&db, &format!("track:{orphan}")).is_err());
        assert!(media_item(&db, &format!("track:{local}")).is_err());
        std::fs::remove_file(&path).unwrap();
        assert!(browse(&db, "downloads").unwrap().is_empty());
        assert!(search(&db, "Descargada").unwrap().is_empty());
    }

    #[test]
    fn youtube_removal_preserves_referenced_tracks_and_search_matches_accents() {
        let db = db();
        let youtube = crate::youtube_tracks::save(&db, crate::youtube_tracks::Preview {
            video_id: "dQw4w9WgXcQ".into(), title: "Jóga · directo".into(), artist: "Björk".into(), duration: 200, cover: None,
        }).unwrap();
        add(&db, &track(4, "Sin referencias"), false);
        {
            let conn = db.0.lock().unwrap();
            conn.execute("INSERT INTO liked_tracks (track_id) VALUES (?1)", params![youtube.id as i64]).unwrap();
            conn.execute_batch("INSERT INTO playlists (id, name) VALUES (5, 'Viaje')").unwrap();
            conn.execute("INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (5, ?1, 0), (5, ?1, 1)", params![youtube.id as i64]).unwrap();
            conn.execute("UPDATE youtube_tracks SET saved = 0 WHERE track_id = ?1", params![youtube.id as i64]).unwrap();
        }
        assert!(browse(&db, "youtube").unwrap().is_empty());
        assert_eq!(browse(&db, "playlist:5").unwrap().len(), 2);
        assert!(media_item(&db, &format!("track:{}", youtube.id)).unwrap().playable);
        let results = search(&db, "bjork joga").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].track.as_ref().unwrap().id, youtube.id);
        assert!(search(&db, "Sin referencias").unwrap().is_empty());
        assert!(search(&db, "   ").unwrap().is_empty());
        for id in ["track:0", "track:-1", "track:01", "track:1 OR 1=1", "playlist:0", "../root"] {
            assert!(media_item(&db, id).is_err(), "{id}");
        }
    }
}
