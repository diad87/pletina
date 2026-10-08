//! Biblioteca: canciones que te gustan, discos y artistas guardados, playlists e historial.
//! Todo se guarda en la base de datos local; las canciones se copian de Deezer
//! para poder mostrar la biblioteca sin volver a preguntar.

use crate::db::Db;
use rusqlite::{Connection, Row, params};
use serde::{Deserialize, Serialize};
use tauri::State;

type Res<T> = Result<T, String>;

/// Una canción tal como se guarda en la biblioteca (lo justo para mostrarla y reproducirla).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibTrack {
    pub id: u64,
    pub title: String,
    pub duration: u32,
    pub explicit: bool,
    pub artist_id: u64,
    pub artist_name: String,
    pub album_id: u64,
    pub album_title: String,
    /// Artista del disco (para "ir al artista" desde la biblioteca).
    pub album_artist_id: u64,
    pub cover: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedAlbum {
    pub id: u64,
    pub title: String,
    pub artist_id: u64,
    pub artist_name: String,
    pub cover: Option<String>,
    pub release_date: Option<String>,
    pub record_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedArtist {
    pub id: u64,
    pub name: String,
    pub picture: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistSummary {
    pub id: i64,
    pub name: String,
    pub count: u32,
    pub duration: u32,
    /// Hasta 4 carátulas distintas, para el mosaico de portada.
    pub covers: Vec<String>,
}

/// Una canción dentro de una lista (playlist, favoritas o historial).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// Identifica la aparición en la lista (en playlists, la misma canción puede repetirse).
    pub entry_id: i64,
    pub track: LibTrack,
    /// Cuándo se añadió o se escuchó (segundos unix).
    pub at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistDetail {
    #[serde(flatten)]
    pub summary: PlaylistSummary,
    pub entries: Vec<Entry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryData {
    pub liked_ids: Vec<u64>,
    pub downloaded_ids: Vec<u64>,
    pub albums: Vec<SavedAlbum>,
    pub artists: Vec<SavedArtist>,
    pub playlists: Vec<PlaylistSummary>,
}

pub(crate) const TRACK_COLS: &str =
    "t.id, t.title, t.duration, t.explicit, t.artist_id, t.artist_name, t.album_id, t.album_title, t.album_artist_id, t.cover";

pub(crate) fn track_at(r: &Row, i: usize) -> rusqlite::Result<LibTrack> {
    Ok(LibTrack {
        id: r.get::<_, i64>(i)? as u64,
        title: r.get(i + 1)?,
        duration: r.get(i + 2)?,
        explicit: r.get(i + 3)?,
        artist_id: r.get::<_, i64>(i + 4)? as u64,
        artist_name: r.get(i + 5)?,
        album_id: r.get::<_, i64>(i + 6)? as u64,
        album_title: r.get(i + 7)?,
        album_artist_id: r.get::<_, i64>(i + 8)? as u64,
        cover: r.get(i + 9)?,
    })
}

pub(crate) fn upsert_track(conn: &Connection, t: &LibTrack) -> rusqlite::Result<()> {
    // La cola, favoritos e historial pueden llevar una copia anterior a una edición. Para
    // enlaces de YouTube manda la ficha guardada; solo su editor puede cambiar los metadatos.
    if crate::youtube_tracks::is_youtube(t.id)
        && conn.query_row("SELECT EXISTS(SELECT 1 FROM tracks WHERE id = ?1)", params![t.id as i64], |r| r.get::<_, bool>(0))?
    {
        return Ok(());
    }
    save_track_metadata(conn, t)
}

/// Escritura explícita desde el editor; los consumidores de biblioteca usan `upsert_track`.
pub(crate) fn save_track_metadata(conn: &Connection, t: &LibTrack) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO tracks (id, title, duration, explicit, artist_id, artist_name, album_id, album_title, album_artist_id, cover)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET
            title = excluded.title, duration = excluded.duration, explicit = excluded.explicit,
            artist_id = excluded.artist_id, artist_name = excluded.artist_name,
            album_id = excluded.album_id, album_title = excluded.album_title,
            album_artist_id = excluded.album_artist_id, cover = excluded.cover",
        params![
            t.id as i64,
            t.title,
            t.duration,
            t.explicit,
            t.artist_id as i64,
            t.artist_name,
            t.album_id as i64,
            t.album_title,
            t.album_artist_id as i64,
            t.cover
        ],
    )?;
    Ok(())
}

fn summaries(conn: &Connection, only: Option<i64>) -> rusqlite::Result<Vec<PlaylistSummary>> {
    let mut stmt = conn.prepare(
        "SELECT p.id, p.name, COUNT(pt.id), COALESCE(SUM(t.duration), 0)
         FROM playlists p
         LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
         LEFT JOIN tracks t ON t.id = pt.track_id
         WHERE ?1 IS NULL OR p.id = ?1
         GROUP BY p.id
         ORDER BY p.updated_at DESC, p.id DESC",
    )?;
    let mut list = stmt
        .query_map(params![only], |r| {
            Ok(PlaylistSummary { id: r.get(0)?, name: r.get(1)?, count: r.get(2)?, duration: r.get(3)?, covers: vec![] })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut covers = conn.prepare(
        "SELECT t.cover, MIN(pt.position) AS first
         FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
         WHERE pt.playlist_id = ?1 AND t.cover IS NOT NULL
         GROUP BY t.cover ORDER BY first LIMIT 4",
    )?;
    for p in &mut list {
        p.covers = covers.query_map(params![p.id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    }
    Ok(list)
}

fn touch(conn: &Connection, playlist: i64) -> rusqlite::Result<()> {
    conn.execute("UPDATE playlists SET updated_at = unixepoch() WHERE id = ?1", params![playlist])?;
    Ok(())
}

fn append(conn: &Connection, playlist: i64, tracks: &[LibTrack]) -> rusqlite::Result<()> {
    let mut next: i64 = conn.query_row(
        "SELECT COALESCE(MAX(position), -1) + 1 FROM playlist_tracks WHERE playlist_id = ?1",
        params![playlist],
        |r| r.get(0),
    )?;
    for t in tracks {
        upsert_track(conn, t)?;
        conn.execute(
            "INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?1, ?2, ?3)",
            params![playlist, t.id as i64, next],
        )?;
        next += 1;
    }
    touch(conn, playlist)
}

/// Bloquea la conexión, ejecuta `f` dentro de una transacción y traduce el error.
fn with_tx<T>(db: &Db, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Res<T> {
    let mut conn = db.0.lock().unwrap();
    let tx = conn.transaction().map_err(db_err)?;
    let out = f(&tx).map_err(db_err)?;
    tx.commit().map_err(db_err)?;
    Ok(out)
}

fn db_err(e: rusqlite::Error) -> String {
    format!("Error en la biblioteca: {e}")
}

fn clean_name(name: &str) -> String {
    let name = name.trim();
    if name.is_empty() { "Playlist sin nombre".to_string() } else { name.chars().take(100).collect() }
}

#[tauri::command]
pub fn library(db: State<'_, Db>) -> Res<LibraryData> {
    with_tx(&db, |c| {
        let liked_ids = c
            .prepare("SELECT track_id FROM liked_tracks")?
            .query_map([], |r| Ok(r.get::<_, i64>(0)? as u64))?
            .collect::<rusqlite::Result<_>>()?;
        let downloaded_ids = c
            .prepare("SELECT track_id FROM downloads")?
            .query_map([], |r| Ok(r.get::<_, i64>(0)? as u64))?
            .collect::<rusqlite::Result<_>>()?;
        let albums = c
            .prepare(
                "SELECT id, title, artist_id, artist_name, cover, release_date, record_type
                 FROM saved_albums ORDER BY added_at DESC",
            )?
            .query_map([], |r| {
                Ok(SavedAlbum {
                    id: r.get::<_, i64>(0)? as u64,
                    title: r.get(1)?,
                    artist_id: r.get::<_, i64>(2)? as u64,
                    artist_name: r.get(3)?,
                    cover: r.get(4)?,
                    release_date: r.get(5)?,
                    record_type: r.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(LibraryData { liked_ids, downloaded_ids, albums, artists: saved_artists(c)?, playlists: summaries(c, None)? })
    })
}

fn saved_artists(conn: &Connection) -> rusqlite::Result<Vec<SavedArtist>> {
    conn.prepare("SELECT id, name, picture FROM saved_artists ORDER BY added_at DESC, id DESC")?
        .query_map([], |r| Ok(SavedArtist { id: r.get::<_, i64>(0)? as u64, name: r.get(1)?, picture: r.get(2)? }))?
        .collect()
}

#[tauri::command]
pub fn set_artist_saved(artist: SavedArtist, saved: bool, db: State<'_, Db>) -> Res<()> {
    save_artist(&db, &artist, saved)
}

fn save_artist(db: &Db, artist: &SavedArtist, saved: bool) -> Res<()> {
    if artist.id == 0 || artist.id > 9_007_199_254_740_991 {
        return Err("El identificador del artista no es válido".into());
    }
    let name = artist.name.trim();
    if saved && (name.is_empty() || name.len() > 2000) {
        return Err("El nombre del artista no es válido".into());
    }
    with_tx(db, |c| {
        if saved {
            // Repetir el guardado actualiza los datos sin duplicar ni cambiar la fecha original.
            c.execute(
                "INSERT INTO saved_artists (id, name, picture) VALUES (?1, ?2, ?3)
                 ON CONFLICT(id) DO UPDATE SET name = excluded.name, picture = excluded.picture",
                params![artist.id as i64, name, artist.picture],
            )?;
        } else {
            c.execute("DELETE FROM saved_artists WHERE id = ?1", params![artist.id as i64])?;
        }
        Ok(())
    })
}

#[tauri::command]
pub fn set_liked(track: LibTrack, liked: bool, db: State<'_, Db>) -> Res<()> {
    with_tx(&db, |c| {
        if liked {
            upsert_track(c, &track)?;
            c.execute("INSERT OR IGNORE INTO liked_tracks (track_id) VALUES (?1)", params![track.id as i64])?;
        } else {
            c.execute("DELETE FROM liked_tracks WHERE track_id = ?1", params![track.id as i64])?;
        }
        Ok(())
    })
}

#[tauri::command]
pub fn liked_tracks(db: State<'_, Db>) -> Res<Vec<Entry>> {
    with_tx(&db, |c| {
        c.prepare(&format!(
            "SELECT l.added_at, {TRACK_COLS} FROM liked_tracks l JOIN tracks t ON t.id = l.track_id
             ORDER BY l.added_at DESC, l.rowid DESC"
        ))?
        .query_map([], |r| {
            let track = track_at(r, 1)?;
            Ok(Entry { entry_id: track.id as i64, at: r.get(0)?, track })
        })?
        .collect()
    })
}

#[tauri::command]
pub fn set_album_saved(album: SavedAlbum, saved: bool, db: State<'_, Db>) -> Res<()> {
    with_tx(&db, |c| {
        if saved {
            c.execute(
                "INSERT OR REPLACE INTO saved_albums (id, title, artist_id, artist_name, cover, release_date, record_type)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    album.id as i64,
                    album.title,
                    album.artist_id as i64,
                    album.artist_name,
                    album.cover,
                    album.release_date,
                    album.record_type
                ],
            )?;
        } else {
            c.execute("DELETE FROM saved_albums WHERE id = ?1", params![album.id as i64])?;
        }
        Ok(())
    })
}

/// Crea una playlist, opcionalmente ya con canciones ("Añadir a playlist → Nueva playlist").
#[tauri::command]
pub fn create_playlist(name: String, tracks: Vec<LibTrack>, db: State<'_, Db>) -> Res<PlaylistSummary> {
    with_tx(&db, |c| {
        c.execute("INSERT INTO playlists (name) VALUES (?1)", params![clean_name(&name)])?;
        let id = c.last_insert_rowid();
        append(c, id, &tracks)?;
        summaries(c, Some(id))?.pop().ok_or(rusqlite::Error::QueryReturnedNoRows)
    })
}

#[tauri::command]
pub fn rename_playlist(id: i64, name: String, db: State<'_, Db>) -> Res<()> {
    with_tx(&db, |c| {
        c.execute("UPDATE playlists SET name = ?2, updated_at = unixepoch() WHERE id = ?1", params![id, clean_name(&name)])?;
        Ok(())
    })
}

#[tauri::command]
pub fn delete_playlist(id: i64, db: State<'_, Db>) -> Res<()> {
    with_tx(&db, |c| {
        c.execute("DELETE FROM playlists WHERE id = ?1", params![id])?;
        Ok(())
    })
}

#[tauri::command]
pub fn playlist(id: i64, db: State<'_, Db>) -> Res<PlaylistDetail> {
    with_tx(&db, |c| {
        let summary = summaries(c, Some(id))?.pop().ok_or(rusqlite::Error::QueryReturnedNoRows)?;
        let entries = c
            .prepare(&format!(
                "SELECT pt.id, pt.added_at, {TRACK_COLS} FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
                 WHERE pt.playlist_id = ?1 ORDER BY pt.position, pt.id"
            ))?
            .query_map(params![id], |r| Ok(Entry { entry_id: r.get(0)?, at: r.get(1)?, track: track_at(r, 2)? }))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(PlaylistDetail { summary, entries })
    })
    .map_err(|e| if e.contains("no rows") { "Esta playlist ya no existe".to_string() } else { e })
}

#[tauri::command]
pub fn add_to_playlist(id: i64, tracks: Vec<LibTrack>, db: State<'_, Db>) -> Res<()> {
    with_tx(&db, |c| append(c, id, &tracks))
}

#[tauri::command]
pub fn remove_from_playlist(id: i64, entry_id: i64, db: State<'_, Db>) -> Res<()> {
    with_tx(&db, |c| {
        c.execute("DELETE FROM playlist_tracks WHERE id = ?1 AND playlist_id = ?2", params![entry_id, id])?;
        touch(c, id)
    })
}

/// Mueve una canción de la playlist a la posición `to` (0 = la primera).
#[tauri::command]
pub fn move_in_playlist(id: i64, entry_id: i64, to: usize, db: State<'_, Db>) -> Res<()> {
    with_tx(&db, |c| move_entry(c, id, entry_id, to))
}

fn move_entry(c: &Connection, playlist: i64, entry_id: i64, to: usize) -> rusqlite::Result<()> {
    let mut order: Vec<i64> = c
        .prepare("SELECT id FROM playlist_tracks WHERE playlist_id = ?1 ORDER BY position, id")?
        .query_map(params![playlist], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let Some(from) = order.iter().position(|e| *e == entry_id) else { return Ok(()) };
    let moved = order.remove(from);
    order.insert(to.min(order.len()), moved);
    let mut update = c.prepare("UPDATE playlist_tracks SET position = ?2 WHERE id = ?1")?;
    for (pos, entry) in order.iter().enumerate() {
        update.execute(params![entry, pos as i64])?;
    }
    touch(c, playlist)
}

/// Apunta una escucha en el historial (la llama el reproductor tras ~30 s de canción).
#[tauri::command]
pub fn record_play(track: LibTrack, db: State<'_, Db>) -> Res<()> {
    record(&db, &track)
}

/// Lo mismo, para quien no es la interfaz (el servicio de música de Android).
pub(crate) fn record(db: &Db, track: &LibTrack) -> Res<()> {
    with_tx(db, |c| {
        upsert_track(c, track)?;
        c.execute("INSERT INTO history (track_id) VALUES (?1)", params![track.id as i64])?;
        Ok(())
    })
}

#[tauri::command]
pub fn history(limit: u32, db: State<'_, Db>) -> Res<Vec<Entry>> {
    with_tx(&db, |c| {
        c.prepare(&format!(
            "SELECT h.id, h.played_at, {TRACK_COLS} FROM history h JOIN tracks t ON t.id = h.track_id
             ORDER BY h.played_at DESC, h.id DESC LIMIT ?1"
        ))?
        .query_map(params![limit], |r| Ok(Entry { entry_id: r.get(0)?, at: r.get(1)?, track: track_at(r, 2)? }))?
        .collect()
    })
}

#[tauri::command]
pub fn clear_history(db: State<'_, Db>) -> Res<()> {
    with_tx(&db, |c| {
        c.execute("DELETE FROM history", [])?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::OptionalExtension;

    fn track(id: u64, title: &str) -> LibTrack {
        LibTrack {
            id,
            title: title.into(),
            duration: 200,
            explicit: false,
            artist_id: 1,
            artist_name: "Grupo".into(),
            album_id: 10,
            album_title: "Disco".into(),
            album_artist_id: 1,
            cover: Some(format!("https://cdn/{id}.jpg")),
        }
    }

    fn db() -> Db {
        let path = std::env::temp_dir().join(format!("musify-lib-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        Db::open(&path).unwrap()
    }

    #[test]
    fn playlist_add_move_remove() {
        let db = db();
        let p = with_tx(&db, |c| {
            c.execute("INSERT INTO playlists (name) VALUES ('Prueba')", [])?;
            let id = c.last_insert_rowid();
            append(c, id, &[track(1, "Uno"), track(2, "Dos"), track(3, "Tres")])?;
            Ok(id)
        })
        .unwrap();
        let titles = |db: &Db| -> Vec<String> {
            with_tx(db, |c| {
                c.prepare("SELECT t.title FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id WHERE playlist_id = ?1 ORDER BY position, pt.id")?
                    .query_map(params![p], |r| r.get(0))?
                    .collect()
            })
            .unwrap()
        };
        assert_eq!(titles(&db), ["Uno", "Dos", "Tres"]);

        let third: i64 = with_tx(&db, |c| {
            c.query_row("SELECT id FROM playlist_tracks WHERE track_id = 3", [], |r| r.get(0)).optional()
        })
        .unwrap()
        .unwrap();
        // Mover "Tres" al principio.
        with_tx(&db, |c| move_entry(c, p, third, 0)).unwrap();
        assert_eq!(titles(&db), ["Tres", "Uno", "Dos"]);

        let s = with_tx(&db, |c| summaries(c, Some(p))).unwrap();
        assert_eq!(s[0].count, 3);
        assert_eq!(s[0].duration, 600);
        assert_eq!(s[0].covers.len(), 3);
    }

    #[test]
    fn saved_artists_survive_restart_and_repeated_save_remove() {
        let path = std::env::temp_dir().join(format!("musify-artists-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let artist = SavedArtist { id: 17, name: "  Björk  ".into(), picture: None };
        {
            let db = Db::open(&path).unwrap();
            save_artist(&db, &artist, true).unwrap();
            with_tx(&db, |c| {
                c.execute("UPDATE saved_artists SET added_at = 123 WHERE id = 17", [])?;
                Ok(())
            }).unwrap();
            let updated = SavedArtist { picture: Some("https://example.com/artist.jpg".into()), ..artist.clone() };
            save_artist(&db, &updated, true).unwrap();
            let artists = with_tx(&db, saved_artists).unwrap();
            assert_eq!(artists.len(), 1);
            assert_eq!(artists[0].name, "Björk");
            assert_eq!(artists[0].picture, updated.picture);
            let at: i64 = with_tx(&db, |c| c.query_row("SELECT added_at FROM saved_artists WHERE id = 17", [], |r| r.get(0))).unwrap();
            assert_eq!(at, 123);
        }
        {
            let db = Db::open(&path).unwrap();
            assert_eq!(with_tx(&db, saved_artists).unwrap()[0].id, artist.id);
            save_artist(&db, &artist, false).unwrap();
            save_artist(&db, &artist, false).unwrap();
        }
        {
            let db = Db::open(&path).unwrap();
            assert!(with_tx(&db, saved_artists).unwrap().is_empty());
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn migrations_keep_existing_sources() {
        // Una base de datos de la fase 2 (solo `sources`, user_version 0) se actualiza sin perder nada.
        let path = std::env::temp_dir().join(format!("musify-mig-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        {
            let c = Connection::open(&path).unwrap();
            c.execute_batch(
                "CREATE TABLE sources (track_id INTEGER PRIMARY KEY, video_id TEXT NOT NULL, title TEXT NOT NULL,
                 channel TEXT NOT NULL, duration INTEGER, score INTEGER NOT NULL, verified INTEGER NOT NULL DEFAULT 0,
                 updated_at INTEGER NOT NULL DEFAULT (unixepoch()));
                 INSERT INTO sources (track_id, video_id, title, channel, score) VALUES (7, 'abc', 'x', 'y', 90);",
            )
            .unwrap();
        }
        let db = Db::open(&path).unwrap();
        assert_eq!(db.source(7).unwrap().video_id, "abc");
        with_tx(&db, |c| c.query_row("SELECT COUNT(*) FROM playlists", [], |r| r.get::<_, i64>(0))).unwrap();
    }
}
