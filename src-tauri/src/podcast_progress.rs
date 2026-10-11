//! Posición de escucha por episodio, compartida con el servicio Android (sin WebView).
use crate::db::Db;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};

const EPISODE_BASE: u64 = 750_000_000_000_000;
const EPISODE_END: u64 = 1_000_000_000_000_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodcastProgress {
    pub id: u64,
    pub position: f64,
    /// Duración del audio reproducido; 0 si todavía no se conoce. No es la estimación del RSS.
    pub duration: f64,
    pub completed: bool,
}

fn episode_id(id: u64) -> Result<i64, String> {
    if !(EPISODE_BASE..EPISODE_END).contains(&id) {
        return Err("El identificador no corresponde a un episodio".into());
    }
    Ok((id - EPISODE_BASE) as i64)
}

pub fn read(db: &Db, id: u64) -> Result<Option<PodcastProgress>, String> {
    let episode = episode_id(id)?;
    db.0.lock().unwrap().query_row(
        "SELECT position, duration, completed FROM podcast_progress WHERE episode_id=?1",
        params![episode],
        |r| Ok(PodcastProgress { id, position: r.get(0)?, duration: r.get(1)?, completed: r.get(2)? }),
    ).optional().map_err(|e| e.to_string())
}

pub fn save(db: &Db, mut progress: PodcastProgress) -> Result<PodcastProgress, String> {
    let episode = episode_id(progress.id)?;
    if !progress.position.is_finite() || !progress.duration.is_finite()
        || progress.position < 0.0 || progress.duration < 0.0 {
        return Err("La posición de escucha no es válida".into());
    }
    if progress.duration > 0.0 { progress.position = progress.position.min(progress.duration); }
    db.0.lock().unwrap().execute(
        "INSERT INTO podcast_progress (episode_id, position, duration, completed) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(episode_id) DO UPDATE SET position=excluded.position, duration=excluded.duration,
         completed=excluded.completed, updated_at=unixepoch()",
        params![episode, progress.position, progress.duration, progress.completed],
    ).map_err(|e| format!("No se pudo guardar la posición del episodio: {e}"))?;
    Ok(progress)
}

#[tauri::command]
pub fn podcast_progress(ids: Vec<u64>, db: State<'_, Db>) -> Result<Vec<PodcastProgress>, String> {
    ids.into_iter().map(|id| read(&db, id)).collect::<Result<Vec<_>, _>>()
        .map(|rows| rows.into_iter().flatten().collect())
}

#[tauri::command]
pub fn save_podcast_progress(progress: PodcastProgress, db: State<'_, Db>, app: tauri::AppHandle) -> Result<(), String> {
    let progress = save(&db, progress)?;
    let _ = app.emit("podcast-progress", progress);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resumes_each_episode_after_reopening_and_keeps_completion() {
        let path = std::env::temp_dir().join(format!("pletina-progress-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let db = Db::open(&path).unwrap();
        db.0.lock().unwrap().execute_batch(
            "INSERT INTO podcast_shows (id, feed_url, title, author, description) VALUES (1, 'https://example.org/feed', 'Programa', '', '');
             INSERT INTO podcast_episodes (id, show_id, guid, audio_url) VALUES (1, 1, 'a', 'https://example.org/a'), (2, 1, 'b', 'https://example.org/b');"
        ).unwrap();
        let a = EPISODE_BASE + 1;
        let b = EPISODE_BASE + 2;
        save(&db, PodcastProgress { id: a, position: 137.5, duration: 3600.0, completed: false }).unwrap();
        save(&db, PodcastProgress { id: b, position: 1801.0, duration: 1800.0, completed: true }).unwrap();
        drop(db);
        let db = Db::open(&path).unwrap();
        let progress = read(&db, a).unwrap().unwrap();
        assert_eq!(progress.position, 137.5);
        assert!(!progress.completed);
        let progress = read(&db, b).unwrap().unwrap();
        assert_eq!(progress.position, 1800.0);
        assert!(progress.completed);
        // Volver a empezar o buscar a cero sustituye el progreso anterior.
        save(&db, PodcastProgress { id: b, position: 0.0, duration: 0.0, completed: false }).unwrap();
        assert!(!read(&db, b).unwrap().unwrap().completed);
        assert_eq!(read(&db, b).unwrap().unwrap().position, 0.0);
        assert_eq!(read(&db, a).unwrap().unwrap().position, 137.5);
        assert!(read(&db, 1).is_err());
        assert!(save(&db, PodcastProgress { id: a, position: f64::NAN, duration: 0.0, completed: false }).is_err());
        assert!(save(&db, PodcastProgress { id: a, position: -1.0, duration: 0.0, completed: false }).is_err());
        drop(db);
        let _ = std::fs::remove_file(path);
    }
}
