//! Canciones añadidas por enlace de YouTube, independientes del catálogo de Deezer.
//! El vínculo con el vídeo es permanente: quitar una canción del listado no rompe las
//! playlists, los favoritos, el historial ni la cola guardada que todavía la contienen.

use crate::db::Db;
use crate::library::{Entry, LibTrack, TRACK_COLS, save_track_metadata, track_at};
use reqwest::Url;
use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use std::time::Duration;
use tauri::State;

pub const YOUTUBE_BASE: u64 = 250_000_000_000_000;
const YOUTUBE_END: u64 = 500_000_000_000_000;
const MAX_DURATION: u32 = 7 * 24 * 60 * 60;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub video_id: String,
    pub title: String,
    pub artist: String,
    /// Cero cuando YouTube no indica la duración.
    pub duration: u32,
    pub cover: Option<String>,
}

pub fn is_youtube(id: u64) -> bool {
    (YOUTUBE_BASE..YOUTUBE_END).contains(&id)
}

fn valid_video_id(id: &str) -> bool {
    id.len() == 11 && id.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}

/// Solo se extrae un ID; nunca se visita la dirección aportada por el usuario.
fn parse_url(input: &str) -> Result<String, String> {
    let input = input.trim();
    if input.len() > 2048 {
        return Err("El enlace de YouTube es demasiado largo".into());
    }
    let with_scheme;
    let input = if input.contains("://") {
        input
    } else {
        with_scheme = format!("https://{input}");
        &with_scheme
    };
    let url = Url::parse(input).map_err(|_| "Pega el enlace de un vídeo de YouTube")?;
    if !matches!(url.scheme(), "https" | "http") || !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
        return Err("El enlace de YouTube no es válido".into());
    }
    let parts: Vec<_> = url.path().trim_end_matches('/').split('/').filter(|s| !s.is_empty()).collect();
    let id = match url.host_str() {
        Some("youtu.be" | "www.youtu.be") if parts.len() == 1 => parts[0].to_string(),
        Some("youtube.com" | "www.youtube.com" | "m.youtube.com" | "music.youtube.com") => {
            if parts == ["watch"] {
                let ids: Vec<_> = url.query_pairs().filter(|(key, _)| key == "v").map(|(_, value)| value.into_owned()).collect();
                if ids.len() != 1 {
                    return Err("El enlace debe señalar un único vídeo de YouTube".into());
                }
                ids[0].clone()
            } else if parts.len() == 2 && matches!(parts[0], "shorts" | "live" | "embed") {
                parts[1].to_string()
            } else {
                return Err("Pega un enlace a un vídeo, no a un canal o una playlist".into());
            }
        }
        _ => return Err("Solo se admiten enlaces de YouTube o YouTube Music".into()),
    };
    if !valid_video_id(&id) {
        return Err("El enlace no contiene un vídeo de YouTube válido".into());
    }
    Ok(id)
}

fn cover_for(video_id: &str) -> String {
    format!("https://i.ytimg.com/vi/{video_id}/hqdefault.jpg")
}

fn clean_text(value: &str, name: &str, limit: usize) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("Escribe {name}"));
    }
    if value.chars().count() > limit || value.chars().any(char::is_control) {
        return Err(format!("{name} no puede superar {limit} caracteres ni contener caracteres de control"));
    }
    Ok(value.to_string())
}

fn validate(mut preview: Preview) -> Result<Preview, String> {
    if !valid_video_id(&preview.video_id) {
        return Err("El vídeo de YouTube no es válido".into());
    }
    preview.title = clean_text(&preview.title, "el título", 300)?;
    preview.artist = clean_text(&preview.artist, "el artista o canal", 200)?;
    if preview.duration > MAX_DURATION {
        return Err("La duración de la canción no es válida".into());
    }
    // La interfaz puede devolver el campo de la vista previa, pero no elegir un servidor
    // arbitrario al que después se conectarían las descargas y la pantalla de bloqueo.
    preview.cover = Some(cover_for(&preview.video_id));
    Ok(preview)
}

#[tauri::command]
pub async fn preview_youtube_track(url: String) -> Result<Preview, String> {
    let video_id = parse_url(&url)?;
    let info = tokio::time::timeout(Duration::from_secs(40), crate::native::resolve(&video_id, false))
        .await
        .map_err(|_| "YouTube tardó demasiado en responder. Vuelve a intentarlo.")?
        .map_err(|e| format!("No se pudo leer este vídeo de YouTube: {e}"))?;
    validate(Preview {
        cover: None,
        video_id,
        title: info.title,
        artist: info.channel.filter(|a| !a.trim().is_empty()).unwrap_or_else(|| "YouTube".into()),
        duration: info.duration.filter(|d| d.is_finite() && *d >= 0.0).map(|d| d.round() as u32).unwrap_or(0),
    })
}

/// Guarda o actualiza metadatos sin cambiar la identidad ni las referencias existentes.
pub(crate) fn save(db: &Db, preview: Preview) -> Result<LibTrack, String> {
    let preview = validate(preview)?;
    let mut conn = db.0.lock().unwrap();
    let tx = conn.transaction().map_err(db_err)?;
    let existing: Option<i64> = tx
        .query_row("SELECT track_id FROM youtube_tracks WHERE video_id = ?1", params![preview.video_id], |r| r.get(0))
        .optional()
        .map_err(db_err)?;
    let id = match existing {
        Some(id) => id as u64,
        None => tx
            .query_row(
                "SELECT COALESCE(MAX(id), ?1) + 1 FROM tracks WHERE id >= ?1 AND id < ?2",
                params![YOUTUBE_BASE as i64, YOUTUBE_END as i64],
                |r| r.get::<_, i64>(0),
            )
            .map_err(db_err)? as u64,
    };
    if !is_youtube(id) {
        return Err("No se pueden guardar más canciones de YouTube".into());
    }
    let track = LibTrack {
        id,
        title: preview.title,
        duration: preview.duration,
        explicit: false,
        artist_id: 0,
        artist_name: preview.artist,
        // Cada vídeo tiene su propia portada incluso cuando comparten artista.
        album_id: id,
        album_title: "YouTube".into(),
        album_artist_id: 0,
        cover: preview.cover,
    };
    save_track_metadata(&tx, &track).map_err(db_err)?;
    tx.execute(
        "INSERT INTO youtube_tracks (track_id, video_id, saved) VALUES (?1, ?2, 1)
         ON CONFLICT(video_id) DO UPDATE SET saved = 1",
        params![id as i64, preview.video_id],
    )
    .map_err(db_err)?;
    tx.commit().map_err(db_err)?;
    Ok(track)
}

#[tauri::command]
pub fn save_youtube_track(
    video_id: String,
    title: String,
    artist: String,
    duration: u32,
    cover: Option<String>,
    db: State<'_, Db>,
) -> Result<LibTrack, String> {
    save(&db, Preview { video_id, title, artist, duration, cover })
}

fn list(db: &Db) -> Result<Vec<Entry>, String> {
    let conn = db.0.lock().unwrap();
    let mut stmt = conn
        .prepare(&format!(
            "SELECT y.track_id, y.added_at, {TRACK_COLS} FROM youtube_tracks y
             JOIN tracks t ON t.id = y.track_id WHERE y.saved = 1 ORDER BY y.added_at DESC, y.track_id DESC"
        ))
        .map_err(db_err)?;
    stmt.query_map([], |r| Ok(Entry { entry_id: r.get(0)?, at: r.get(1)?, track: track_at(r, 2)? }))
        .and_then(|rows| rows.collect())
        .map_err(db_err)
}

#[tauri::command]
pub fn youtube_tracks(db: State<'_, Db>) -> Result<Vec<Entry>, String> {
    list(&db)
}

fn remove(db: &Db, id: u64) -> Result<(), String> {
    if !is_youtube(id) {
        return Err("Esta canción no procede de un enlace de YouTube".into());
    }
    db.0.lock().unwrap().execute("UPDATE youtube_tracks SET saved = 0 WHERE track_id = ?1", params![id as i64]).map_err(db_err)?;
    Ok(())
}

#[tauri::command]
pub fn remove_youtube_track(id: u64, db: State<'_, Db>) -> Result<(), String> {
    remove(&db, id)
}

/// El vídeo elegido al importar se mantiene aunque se quite del listado principal.
pub fn video(db: &Db, id: u64) -> Result<String, String> {
    if !is_youtube(id) {
        return Err("Esta canción no procede de un enlace de YouTube".into());
    }
    let video: Option<String> =
        db.0.lock()
            .unwrap()
            .query_row("SELECT video_id FROM youtube_tracks WHERE track_id = ?1", params![id as i64], |r| r.get(0))
            .optional()
            .map_err(db_err)?;
    video.filter(|id| valid_video_id(id)).ok_or_else(|| "No se encuentra el vídeo guardado de esta canción".into())
}

fn db_err(error: rusqlite::Error) -> String {
    format!("No se pudo acceder a las canciones de YouTube: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn preview(video_id: &str) -> Preview {
        Preview { video_id: video_id.into(), title: "  Una canción  ".into(), artist: "  Un artista  ".into(), duration: 215, cover: None }
    }

    #[test]
    fn accepts_only_individual_youtube_urls() {
        for url in [
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLsomething&t=31",
            "https://music.youtube.com/watch?v=dQw4w9WgXcQ&si=example",
            "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://youtu.be/dQw4w9WgXcQ?si=example",
            " https://www.youtube.com/shorts/dQw4w9WgXcQ ",
            "http://youtube.com/watch?v=dQw4w9WgXcQ",
            "youtube.com/watch?v=dQw4w9WgXcQ",
            "https://youtube.com/live/dQw4w9WgXcQ",
        ] {
            assert_eq!(parse_url(url).unwrap(), "dQw4w9WgXcQ", "{url}");
        }
        for url in [
            "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
            "https://evil-youtube.com/watch?v=dQw4w9WgXcQ",
            "https://youtube.com@evil.example/watch?v=dQw4w9WgXcQ",
            "https://evil.example@youtube.com/watch?v=dQw4w9WgXcQ",
            "https://youtube.com:1234/watch?v=dQw4w9WgXcQ",
            "file://youtube.com/watch?v=dQw4w9WgXcQ",
            "https://youtu.be/dQw4w9WgXcQ/extra",
            "https://youtube.com/watch?v=dQw4w9WgXcQ&v=jNY_wLukVW0",
            "https://youtube.com/playlist?list=PLsomething",
            "https://youtube.com/@channel",
            "https://youtube.com/watch?v=too-short",
            "https://youtube.com/watch?v=bad!bad!bad",
        ] {
            assert!(parse_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn validates_editable_metadata_and_ignores_arbitrary_cover_urls() {
        let mut input = preview("dQw4w9WgXcQ");
        input.cover = Some("http://127.0.0.1/private".into());
        let valid = validate(input.clone()).unwrap();
        assert_eq!(valid.title, "Una canción");
        assert_eq!(valid.artist, "Un artista");
        assert_eq!(valid.cover.as_deref(), Some("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"));
        input.title = " ".into();
        assert!(validate(input.clone()).is_err());
        input.title = "x".repeat(301);
        assert!(validate(input.clone()).is_err());
        input.title = "Canción\0oculta".into();
        assert!(validate(input).is_err());
        let mut input = preview("dQw4w9WgXcQ");
        input.artist = " ".into();
        assert!(validate(input).is_err());
        let mut input = preview("dQw4w9WgXcQ");
        input.duration = MAX_DURATION + 1;
        assert!(validate(input).is_err());
        assert!(!is_youtube(YOUTUBE_BASE - 1));
        assert!(is_youtube(YOUTUBE_BASE + 1));
        assert!(!is_youtube(YOUTUBE_END));
    }

    #[test]
    fn duplicates_and_removal_preserve_playlists_favorites_history_and_identity() {
        let db = Db::open(std::path::Path::new(":memory:")).unwrap();
        let first = save(&db, preview("dQw4w9WgXcQ")).unwrap();
        {
            let conn = db.0.lock().unwrap();
            conn.execute("INSERT INTO playlists (id, name) VALUES (1, 'Mi lista')", []).unwrap();
            conn.execute("INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (1, ?1, 0)", params![first.id as i64])
                .unwrap();
            conn.execute("INSERT INTO liked_tracks (track_id) VALUES (?1)", params![first.id as i64]).unwrap();
            conn.execute("INSERT INTO history (track_id) VALUES (?1)", params![first.id as i64]).unwrap();
        }
        let mut edited = preview("dQw4w9WgXcQ");
        edited.title = "Título corregido".into();
        let duplicate = save(&db, edited.clone()).unwrap();
        assert_eq!(duplicate.id, first.id);
        assert_eq!(list(&db).unwrap().len(), 1);
        assert_eq!(list(&db).unwrap()[0].track.title, "Título corregido");
        remove(&db, first.id).unwrap();
        assert!(list(&db).unwrap().is_empty());
        assert_eq!(video(&db, first.id).unwrap(), "dQw4w9WgXcQ");
        let second = save(&db, preview("jNY_wLukVW0")).unwrap();
        assert_ne!(second.id, first.id);
        assert_eq!(save(&db, edited).unwrap().id, first.id);
        assert_eq!(list(&db).unwrap().len(), 2);
        let conn = db.0.lock().unwrap();
        for table in ["playlist_tracks", "liked_tracks", "history"] {
            let count: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table} WHERE track_id = ?1"), params![first.id as i64], |r| r.get(0))
                .unwrap();
            assert_eq!(count, 1, "{table}");
        }
        assert!(conn.query_row("PRAGMA foreign_key_check", [], |_| Ok(())).optional().unwrap().is_none());
    }

    #[test]
    fn old_queue_and_library_copies_do_not_undo_edited_youtube_metadata() {
        let db = Db::open(std::path::Path::new(":memory:")).unwrap();
        let old = save(&db, preview("dQw4w9WgXcQ")).unwrap();
        let mut edited = preview("dQw4w9WgXcQ");
        edited.title = "Título corregido".into();
        edited.artist = "Artista corregido".into();
        edited.duration = 321;
        save(&db, edited).unwrap();
        // Mismo camino que usa descargar, marcar favorito o añadir a una playlist.
        crate::library::upsert_track(&db.0.lock().unwrap(), &old).unwrap();
        // La cola nativa de Android también puede conservar la copia vieja al registrar.
        crate::library::record(&db, &old).unwrap();
        let tracks = list(&db).unwrap();
        assert_eq!(tracks[0].track.title, "Título corregido");
        assert_eq!(tracks[0].track.artist_name, "Artista corregido");
        assert_eq!(tracks[0].track.duration, 321);
        let conn = db.0.lock().unwrap();
        let history_title: String = conn
            .query_row(
                "SELECT t.title FROM history h JOIN tracks t ON t.id = h.track_id WHERE h.track_id = ?1",
                params![old.id as i64],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(history_title, "Título corregido");
    }

    /// Vista previa real, con el motor Rust que también funciona en Android, sin yt-dlp.
    #[tokio::test]
    #[ignore]
    async fn real_youtube_preview_uses_native_extractor() {
        let preview = preview_youtube_track("https://youtu.be/dQw4w9WgXcQ".into()).await.unwrap();
        assert_eq!(preview.video_id, "dQw4w9WgXcQ");
        assert!(!preview.title.is_empty());
        assert!(!preview.artist.is_empty());
        assert!(preview.duration > 0);
        assert_eq!(preview.cover.as_deref(), Some("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"));
    }
}
