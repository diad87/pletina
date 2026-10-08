//! Base de datos local (SQLite): qué vídeo de YouTube corresponde a cada canción
//! y la biblioteca (ver `library.rs`).

use rusqlite::{Connection, OptionalExtension, params};
use std::path::Path;
use std::sync::{Arc, Mutex};

/// Migraciones en orden; `PRAGMA user_version` guarda cuántas se han aplicado.
const MIGRATIONS: &[&str] = &[
    // 1: vídeos elegidos para cada canción.
    "
    CREATE TABLE IF NOT EXISTS sources (
        track_id   INTEGER PRIMARY KEY,  -- id de Deezer
        video_id   TEXT    NOT NULL,
        title      TEXT    NOT NULL,     -- título del vídeo, para depurar coincidencias
        channel    TEXT    NOT NULL,
        duration   INTEGER,
        score      INTEGER NOT NULL,
        verified   INTEGER NOT NULL DEFAULT 0,  -- elegido a mano por el usuario
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    ",
    // 2: biblioteca. Las canciones se copian de Deezer para poder mostrarlas sin conexión.
    "
    CREATE TABLE tracks (
        id              INTEGER PRIMARY KEY,
        title           TEXT    NOT NULL,
        duration        INTEGER NOT NULL,
        explicit        INTEGER NOT NULL DEFAULT 0,
        artist_id       INTEGER NOT NULL,
        artist_name     TEXT    NOT NULL,
        album_id        INTEGER NOT NULL,
        album_title     TEXT    NOT NULL,
        album_artist_id INTEGER NOT NULL,
        cover           TEXT
    );
    CREATE TABLE liked_tracks (
        track_id INTEGER PRIMARY KEY REFERENCES tracks(id),
        added_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE saved_albums (
        id           INTEGER PRIMARY KEY,
        title        TEXT    NOT NULL,
        artist_id    INTEGER NOT NULL,
        artist_name  TEXT    NOT NULL,
        cover        TEXT,
        release_date TEXT,
        record_type  TEXT,
        added_at     INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE playlists (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT    NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    -- Una fila por aparición: la misma canción puede estar dos veces en una playlist.
    CREATE TABLE playlist_tracks (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
        track_id    INTEGER NOT NULL REFERENCES tracks(id),
        position    INTEGER NOT NULL,
        added_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX playlist_tracks_order ON playlist_tracks(playlist_id, position);
    CREATE TABLE history (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        track_id  INTEGER NOT NULL REFERENCES tracks(id),
        played_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX history_played ON history(played_at DESC);
    ",
    // 3: descargas para escuchar sin conexión, y ajustes (carpeta de descargas).
    "
    CREATE TABLE downloads (
        track_id      INTEGER PRIMARY KEY REFERENCES tracks(id),
        path          TEXT    NOT NULL,
        size          INTEGER NOT NULL,
        video_id      TEXT    NOT NULL,
        downloaded_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    ",
    // 4: música local (carpetas del usuario). Los ids que ve la interfaz son LOCAL_BASE + id.
    "
    CREATE TABLE local_artists (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        name            TEXT    NOT NULL,
        key             TEXT    NOT NULL UNIQUE,  -- nombre normalizado, para agrupar
        picture         TEXT,                     -- foto de Deezer, si se encontró
        picture_checked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE local_albums (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        title         TEXT    NOT NULL,
        artist_id     INTEGER NOT NULL REFERENCES local_artists(id),
        year          TEXT,
        cover         TEXT,                     -- ruta de la carátula guardada, o URL de Deezer
        cover_checked INTEGER NOT NULL DEFAULT 0, -- ya se buscó en Deezer
        key           TEXT    NOT NULL UNIQUE
    );
    CREATE TABLE local_tracks (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        path      TEXT    NOT NULL UNIQUE,
        title     TEXT    NOT NULL,
        artist_id INTEGER NOT NULL REFERENCES local_artists(id),
        album_id  INTEGER NOT NULL REFERENCES local_albums(id),
        track_no  INTEGER,
        disc_no   INTEGER,
        duration  INTEGER NOT NULL,
        mtime     INTEGER NOT NULL,
        size      INTEGER NOT NULL
    );
    CREATE INDEX local_tracks_album ON local_tracks(album_id);
    CREATE INDEX local_tracks_artist ON local_tracks(artist_id);
    ",
    // 5: podcasts RSS. Las URLs se conservan para reproducir favoritos e historial al reiniciar.
    "
    CREATE TABLE podcast_shows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        feed_url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        author TEXT NOT NULL,
        description TEXT NOT NULL,
        image TEXT,
        language TEXT
    );
    CREATE TABLE podcast_episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        show_id INTEGER NOT NULL REFERENCES podcast_shows(id),
        guid TEXT NOT NULL,
        audio_url TEXT NOT NULL,
        UNIQUE(show_id, guid)
    );
    ",
];

#[derive(Debug, Clone)]
pub struct Source {
    pub video_id: String,
    pub title: String,
    pub channel: String,
    pub duration: Option<u32>,
    pub score: i32,
    /// Elegido a mano con "esta no es".
    pub verified: bool,
}

/// Una conexión compartida: clonarla no abre otra (en Android la usan Tauri y el servicio de música).
#[derive(Clone)]
pub struct Db(pub(crate) Arc<Mutex<Connection>>);

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        // Si el archivo ya tiene tablas, nunca se crea una base nueva encima.
        let had_data = has_content(path);
        let mut conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
        let tables: i64 = conn.query_row("SELECT COUNT(*) FROM sqlite_master", [], |r| r.get(0))?;
        if had_data && tables == 0 {
            return Err(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CANTOPEN),
                Some("La base de datos tiene contenido pero se ve vacía; no se toca. Cierra y vuelve a abrir Pletina.".into()),
            ));
        }
        backup_before_migrating(&conn, path)?;
        migrate(&mut conn)?;
        Ok(Self(Arc::new(Mutex::new(conn))))
    }

    pub fn source(&self, track_id: u64) -> Option<Source> {
        self.0
            .lock()
            .unwrap()
            .query_row(
                "SELECT video_id, title, channel, duration, score, verified FROM sources WHERE track_id = ?1",
                params![track_id as i64],
                |r| {
                    Ok(Source {
                        video_id: r.get(0)?,
                        title: r.get(1)?,
                        channel: r.get(2)?,
                        duration: r.get(3)?,
                        score: r.get(4)?,
                        verified: r.get(5)?,
                    })
                },
            )
            .optional()
            .ok()
            .flatten()
    }

    /// Una búsqueda antigua no puede sustituir la elección manual que terminó antes que ella.
    pub fn save_source(&self, track_id: u64, s: &Source) -> bool {
        self.0.lock().unwrap().execute(
            "INSERT INTO sources (track_id, video_id, title, channel, duration, score, verified, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, unixepoch())
             ON CONFLICT(track_id) DO UPDATE SET video_id = excluded.video_id,
               title = excluded.title, channel = excluded.channel, duration = excluded.duration,
               score = excluded.score, verified = excluded.verified, updated_at = excluded.updated_at
             WHERE sources.verified = 0 OR excluded.verified = 1",
            params![track_id as i64, s.video_id, s.title, s.channel, s.duration, s.score, s.verified],
        ).is_ok_and(|rows| rows == 1)
    }

    #[cfg(test)]
    pub fn delete_source(&self, track_id: u64) {
        let _ = self
            .0
            .lock()
            .unwrap()
            .execute("DELETE FROM sources WHERE track_id = ?1", params![track_id as i64]);
    }

    /// Un error de una petición anterior solo puede retirar su propia asociación automática.
    pub fn delete_automatic_source(&self, track_id: u64, video_id: &str) -> bool {
        self.0.lock().unwrap().execute(
            "DELETE FROM sources WHERE track_id = ?1 AND video_id = ?2 AND verified = 0",
            params![track_id as i64, video_id],
        ).is_ok_and(|rows| rows == 1)
    }
}

impl Db {
    /// Archivo descargado de una canción, si lo hay.
    pub fn download_path(&self, track_id: u64) -> Option<String> {
        self.0
            .lock()
            .unwrap()
            .query_row("SELECT path FROM downloads WHERE track_id = ?1", params![track_id as i64], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
    }

    /// Quita la descarga de la base de datos (no borra el archivo).
    pub fn forget_download(&self, track_id: u64) {
        let _ = self
            .0
            .lock()
            .unwrap()
            .execute("DELETE FROM downloads WHERE track_id = ?1", params![track_id as i64]);
    }

    pub fn setting(&self, key: &str) -> Option<String> {
        self.0
            .lock()
            .unwrap()
            .query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
    }

    pub fn set_setting(&self, key: &str, value: &str) {
        let _ = self.0.lock().unwrap().execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        );
    }
}

/// ¿Tiene el archivo algo más que la cabecera? Una base de datos sin tablas ocupa una sola
/// página (p. ej. la que deja `journal_mode = WAL` antes de crear nada).
fn has_content(path: &Path) -> bool {
    use std::io::Read;
    let Ok(mut file) = std::fs::File::open(path) else { return false };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut header = [0u8; 18];
    if file.read_exact(&mut header).is_err() {
        return false;
    }
    // Tamaño de página en los bytes 16-17 (1 significa 65536).
    let page = match u16::from_be_bytes([header[16], header[17]]) {
        1 => 65536,
        n => u64::from(n),
    };
    len > page
}

/// Antes de cambiar la estructura de una base de datos con datos, una copia completa al lado
/// (musify.db.antes-de-vN). Se guardan solo las 3 más recientes.
fn backup_before_migrating(conn: &Connection, path: &Path) -> rusqlite::Result<()> {
    let applied: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if applied == 0 || applied as usize >= MIGRATIONS.len() {
        return Ok(());
    }
    let backup = path.with_extension(format!("db.antes-de-v{}", MIGRATIONS.len()));
    let _ = std::fs::remove_file(&backup);
    conn.execute("VACUUM INTO ?1", params![backup.to_string_lossy()])?;
    // Limpieza: solo las 3 copias más recientes.
    if let Some(dir) = path.parent() {
        let mut copies: Vec<_> = std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with("musify.db.antes-de-v"))
            .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
            .collect();
        copies.sort_by(|a, b| b.0.cmp(&a.0));
        for (_, old) in copies.into_iter().skip(3) {
            let _ = std::fs::remove_file(old);
        }
    }
    Ok(())
}

fn migrate(conn: &mut Connection) -> rusqlite::Result<()> {
    let applied: usize = conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))? as usize;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(applied) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.execute_batch(&format!("PRAGMA user_version = {}", i + 1))?;
        tx.commit()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_late_search_preserves_the_manual_video() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        let db = Db(Arc::new(Mutex::new(conn)));
        let manual = Source { video_id: "chosenvideo".into(), title: "Chosen".into(), channel: "Artist".into(),
            duration: Some(180), score: 100, verified: true };
        let automatic = Source { video_id: "oldsearchid".into(), verified: false, ..manual.clone() };
        assert!(db.save_source(1, &manual));
        assert!(!db.save_source(1, &automatic));
        let saved = db.source(1).unwrap();
        assert_eq!(saved.video_id, manual.video_id);
        assert!(saved.verified);
        assert!(!db.delete_automatic_source(1, &automatic.video_id));
        assert!(!db.delete_automatic_source(1, &manual.video_id));
        let replacement = Source { video_id: "newchoiceid".into(), ..manual };
        assert!(db.save_source(1, &replacement));
        assert_eq!(db.source(1).unwrap().video_id, replacement.video_id);
        assert!(db.save_source(2, &automatic));
        assert!(!db.delete_automatic_source(2, "differentid"));
        assert!(db.delete_automatic_source(2, &automatic.video_id));
    }

    #[test]
    fn opens_header_only_file() {
        let dir = std::env::temp_dir().join(format!("musify-db-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("musify.db");

        // Lo que deja una base de datos que se abrió en modo WAL y se cerró sin crear nada: solo la cabecera.
        Connection::open(&path).unwrap().execute_batch("PRAGMA journal_mode = WAL;").unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 4096);
        assert!(!has_content(&path));

        let db = Db::open(&path).unwrap();
        db.set_setting("k", "v");
        drop(db);
        assert!(has_content(&path));
        assert_eq!(Db::open(&path).unwrap().setting("k").as_deref(), Some("v"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod repro {
    use super::*;

    /// Abre una base de datos real (copia) y cuenta filas: `MUSIFY_TEST_DB=ruta cargo test open_real_db -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn open_real_db() {
        let path = std::path::PathBuf::from(std::env::var("MUSIFY_TEST_DB").unwrap());
        let db = Db::open(&path).unwrap();
        let c = db.0.lock().unwrap();
        let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        let n = |t: &str| c.query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get::<_, i64>(0)).unwrap();
        println!("versión {v} · sources {} · history {} · settings {}", n("sources"), n("history"), n("settings"));
    }
}
