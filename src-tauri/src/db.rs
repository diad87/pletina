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
    // 6: artistas favoritos y canciones añadidas directamente desde YouTube.
    "
    CREATE TABLE saved_artists (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        picture TEXT,
        added_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE youtube_tracks (
        track_id INTEGER PRIMARY KEY REFERENCES tracks(id),
        video_id TEXT NOT NULL UNIQUE,
        added_at INTEGER NOT NULL DEFAULT (unixepoch()),
        saved INTEGER NOT NULL DEFAULT 1
    );
    ",
    // 7: programas de podcasts favoritos. Sus metadatos siguen en podcast_shows.
    "
    CREATE TABLE saved_podcasts (
        show_id INTEGER PRIMARY KEY REFERENCES podcast_shows(id),
        added_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    ",
];

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

    pub fn save_source(&self, track_id: u64, s: &Source) {
        let _ = self.0.lock().unwrap().execute(
            "INSERT OR REPLACE INTO sources (track_id, video_id, title, channel, duration, score, verified, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, unixepoch())",
            params![track_id as i64, s.video_id, s.title, s.channel, s.duration, s.score, s.verified],
        );
    }

    pub fn delete_source(&self, track_id: u64) {
        let _ = self
            .0
            .lock()
            .unwrap()
            .execute("DELETE FROM sources WHERE track_id = ?1", params![track_id as i64]);
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

    #[test]
    fn migration_seven_preserves_version_six_library_and_podcast_data() {
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("pletina-migration-seven-{}-{nonce}.db", std::process::id()));
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
            for migration in &MIGRATIONS[..6] {
                conn.execute_batch(migration).unwrap();
            }
            conn.execute_batch(
                "PRAGMA user_version = 6;
                 INSERT INTO sources (track_id, video_id, title, channel, score) VALUES (7, 'video', 'Canción', 'Artista', 90);
                 INSERT INTO tracks (id, title, duration, artist_id, artist_name, album_id, album_title, album_artist_id)
                    VALUES (7, 'Canción', 120, 1, 'Artista', 2, 'Disco', 1);
                 INSERT INTO liked_tracks (track_id) VALUES (7);
                 INSERT INTO saved_albums (id, title, artist_id, artist_name) VALUES (2, 'Disco', 1, 'Artista');
                 INSERT INTO saved_artists (id, name) VALUES (1, 'Artista');
                 INSERT INTO playlists (id, name) VALUES (1, 'Mi lista');
                 INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (1, 7, 0);
                 INSERT INTO history (track_id) VALUES (7);
                 INSERT INTO downloads (track_id, path, size, video_id) VALUES (7, 'audio.webm', 42, 'video');
                 INSERT INTO settings (key, value) VALUES ('keep', 'value');
                 INSERT INTO youtube_tracks (track_id, video_id, saved) VALUES (7, 'video', 1);
                 INSERT INTO local_artists (id, name, key) VALUES (1, 'Local', 'local');
                 INSERT INTO local_albums (id, title, artist_id, key) VALUES (1, 'Disco local', 1, 'local-album');
                 INSERT INTO local_tracks (path, title, artist_id, album_id, duration, mtime, size)
                    VALUES ('local.flac', 'Canción local', 1, 1, 10, 100, 200);
                 INSERT INTO podcast_shows (id, feed_url, title, author, description, language)
                    VALUES (1, 'https://feed.example/rss', 'Programa RSS', 'Autora', 'Descripción', 'es'),
                           (2, 'youtube:MPSPtest', 'Programa YouTube', 'Canal', 'Vídeos', NULL);
                 INSERT INTO podcast_episodes (show_id, guid, audio_url)
                    VALUES (1, 'rss-episode', 'https://audio.example/episode.mp3'), (2, 'video', 'youtube:video');",
            ).unwrap();
        }
        {
            let db = Db::open(&path).unwrap();
            assert_eq!(db.source(7).unwrap().video_id, "video");
            assert_eq!(db.setting("keep").as_deref(), Some("value"));
            assert_eq!(db.download_path(7).as_deref(), Some("audio.webm"));
            let conn = db.0.lock().unwrap();
            assert_eq!(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 7);
            for table in ["sources", "tracks", "liked_tracks", "saved_albums", "saved_artists", "playlists",
                "playlist_tracks", "history", "downloads", "settings", "youtube_tracks", "local_artists", "local_albums", "local_tracks"]
            {
                assert_eq!(conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get::<_, i64>(0)).unwrap(), 1, "{table}");
            }
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM podcast_shows", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
            let audio: String = conn.query_row("SELECT audio_url FROM podcast_episodes WHERE guid = 'rss-episode'", [], |r| r.get(0)).unwrap();
            assert_eq!(audio, "https://audio.example/episode.mp3");
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM podcast_episodes", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
            assert!(crate::podcasts::saved_shows(&conn).unwrap().is_empty());
            assert!(conn.execute("INSERT INTO saved_podcasts (show_id) VALUES (999)", []).is_err());
            conn.execute("INSERT INTO saved_podcasts (show_id) VALUES (1), (2)", []).unwrap();
            let saved = crate::podcasts::saved_shows(&conn).unwrap();
            assert_eq!(saved.len(), 2);
            assert_eq!(saved[0].feed_url, "youtube:MPSPtest");
            assert_eq!(saved[1].title, "Programa RSS");
        }
        // La copia previa sigue siendo v6 y conserva los datos originales.
        let backup = path.with_extension("db.antes-de-v7");
        {
            let conn = Connection::open(&backup).unwrap();
            assert_eq!(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 6);
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM podcast_episodes", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
            assert!(conn.prepare("SELECT * FROM saved_podcasts").is_err());
        }
        std::fs::remove_file(path).unwrap();
        std::fs::remove_file(backup).unwrap();
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
