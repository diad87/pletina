//! De canción de Deezer a audio reproducible: busca el vídeo (o usa el guardado),
//! saca la URL del stream y recuerda la elección.

use crate::db::{Db, Source};
use crate::extractor;
use crate::youtube::{self, CONFIDENT_SCORE, Candidate, MIN_SCORE, TrackQuery, YouTubeMusic};
use crate::ytdlp::YtDlp;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Playable {
    pub video_id: String,
    /// URL del stream, o ruta del archivo si `local` (HTTP loopback en Linux).
    pub url: String,
    pub title: String,
    pub channel: String,
    /// Canción descargada: se reproduce el archivo, sin conexión.
    pub local: bool,
}

/// Un vídeo que podría ser la canción, para elegir a mano ("esta no es").
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Alternative {
    pub video_id: String,
    pub title: String,
    pub artists: String,
    pub album: Option<String>,
    pub duration: Option<u32>,
    pub score: i32,
    /// "music" (YouTube Music) o "youtube".
    pub origin: &'static str,
    /// Es el vídeo que se está usando ahora.
    pub current: bool,
}

/// Cuántos vídeos se prueban si los primeros no se pueden reproducir.
const MAX_ATTEMPTS: usize = 3;

type Scored = (Candidate, i32, &'static str);

pub async fn resolve(
    q: &TrackQuery,
    refresh: bool,
    db: &Db,
    ytm: &YouTubeMusic,
    ytdlp: &YtDlp,
) -> Result<Playable, String> {
    // Episodios: el audio publicado en el RSS, también desde el servicio nativo de Android.
    if crate::podcasts::is_podcast(q.id) {
        let audio = crate::podcasts::audio(db, q.id)?;
        // Episodio de YouTube Music: es un vídeo, suena con el motor de siempre (o descargado).
        if let Some(video_id) = audio.strip_prefix(crate::youtube_podcasts::PREFIX) {
            if let Some(path) = db.download_path(q.id).filter(|p| std::path::Path::new(p).exists()) {
                return Ok(Playable { video_id: video_id.to_string(), url: path, title: q.title.clone(), channel: q.artist.clone(), local: true });
            }
            let info = extractor::stream(ytdlp, video_id, refresh).await?;
            return Ok(Playable {
                video_id: video_id.to_string(),
                url: info.url,
                title: q.title.clone(),
                channel: q.artist.clone(),
                local: false,
            });
        }
        return Ok(Playable { video_id: String::new(), url: audio, title: q.title.clone(), channel: q.artist.clone(), local: false });
    }
    // Música local: el propio archivo, sin YouTube.
    if crate::local::is_local(q.id) {
        let path = crate::local::path(db, q.id).ok_or("Esta canción ya no está en tu música")?;
        if !std::path::Path::new(&path).exists() {
            return Err("No se encuentra el archivo (¿se ha movido o borrado?)".into());
        }
        return Ok(Playable { video_id: String::new(), url: path, title: q.title.clone(), channel: q.artist.clone(), local: true });
    }

    if let Some(path) = db.download_path(q.id) {
        if std::path::Path::new(&path).exists() {
            let src = db.source(q.id);
            return Ok(Playable {
                video_id: src.as_ref().map(|s| s.video_id.clone()).unwrap_or_default(),
                url: path,
                title: src.as_ref().map(|s| s.title.clone()).unwrap_or_default(),
                channel: src.map(|s| s.channel).unwrap_or_default(),
                local: true,
            });
        }
        // Borrado a mano desde el explorador: se vuelve al streaming.
        db.forget_download(q.id);
    }

    let mut gone = None;
    if let Some(src) = db.source(q.id) {
        match extractor::stream(ytdlp, &src.video_id, refresh).await {
            Ok(info) => return Ok(playable(src, info.url)),
            // El vídeo ya no existe: se busca otro.
            Err(e) if is_gone(&e) => {
                db.delete_source(q.id);
                gone = Some(src.video_id);
            }
            Err(e) => return Err(e),
        }
    }

    let mut candidates = search(q, ytm, ytdlp, false).await?;
    candidates.retain(|(c, s, _)| *s >= MIN_SCORE && gone.as_ref() != Some(&c.video_id));

    #[cfg(debug_assertions)]
    for (c, s, _) in candidates.iter().take(3) {
        eprintln!("[match] {} — {} → {} {:?} {:?}s ({s})", q.artist, q.title, c.title, c.artists, c.duration);
    }

    let mut last_err = None;
    for (c, score, _) in candidates.into_iter().take(MAX_ATTEMPTS) {
        match extractor::stream(ytdlp, &c.video_id, refresh).await {
            Ok(info) => {
                let src = Source {
                    video_id: c.video_id,
                    title: c.title,
                    channel: c.artists.join(", "),
                    duration: c.duration,
                    score,
                    verified: false,
                };
                db.save_source(q.id, &src);
                return Ok(playable(src, info.url));
            }
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap_or_else(|| "No se ha encontrado en YouTube".to_string()))
}

/// Todos los vídeos que podrían ser la canción (YouTube Music y YouTube), mejor puntuados primero.
pub async fn alternatives(
    q: &TrackQuery,
    db: &Db,
    ytm: &YouTubeMusic,
    ytdlp: &YtDlp,
) -> Result<Vec<Alternative>, String> {
    if crate::podcasts::is_podcast(q.id) {
        return Err("Los episodios usan el audio original del podcast".into());
    }
    let current = db.source(q.id);
    let mut list: Vec<Alternative> = search(q, ytm, ytdlp, true)
        .await?
        .into_iter()
        .take(16)
        .map(|(c, score, origin)| Alternative {
            current: current.as_ref().is_some_and(|s| s.video_id == c.video_id),
            video_id: c.video_id,
            title: c.title,
            artists: c.artists.join(", "),
            album: c.album,
            duration: c.duration,
            score,
            origin,
        })
        .collect();

    // El vídeo en uso siempre aparece, aunque no salga en la búsqueda (p. ej. pegado a mano).
    if let Some(src) = current {
        if !list.iter().any(|a| a.current) {
            list.insert(
                0,
                Alternative {
                    video_id: src.video_id,
                    title: src.title,
                    artists: src.channel,
                    album: None,
                    duration: src.duration,
                    score: src.score,
                    origin: "youtube",
                    current: true,
                },
            );
        }
    }
    Ok(list)
}

/// Solo el vídeo de una canción, sin pedir la URL del audio (para descargar):
/// el guardado o la mejor coincidencia, que queda guardada.
pub async fn find_video(q: &TrackQuery, db: &Db, ytm: &YouTubeMusic, ytdlp: &YtDlp) -> Result<String, String> {
    if crate::podcasts::is_podcast(q.id) {
        return crate::podcasts::youtube_video(db, q.id).ok_or_else(|| "La descarga de episodios todavía no está disponible".into());
    }
    if let Some(src) = db.source(q.id) {
        return Ok(src.video_id);
    }
    let (c, score, _) = search(q, ytm, ytdlp, false)
        .await?
        .into_iter()
        .find(|(_, s, _)| *s >= MIN_SCORE)
        .ok_or("No se ha encontrado en YouTube")?;
    let src = Source {
        video_id: c.video_id,
        title: c.title,
        channel: c.artists.join(", "),
        duration: c.duration,
        score,
        verified: false,
    };
    db.save_source(q.id, &src);
    Ok(src.video_id)
}

/// El usuario elige el vídeo de una canción: se guarda como verificado y se devuelve listo para sonar.
/// Si estaba descargada, se borra el archivo (era de otro vídeo).
pub async fn choose(q: &TrackQuery, video_id: &str, db: &Db, ytdlp: &YtDlp) -> Result<Playable, String> {
    if crate::podcasts::is_podcast(q.id) {
        return Err("Los episodios usan el audio original del podcast".into());
    }
    let info = extractor::stream(ytdlp, video_id, false).await?;
    if let Some(path) = db.download_path(q.id) {
        let _ = std::fs::remove_file(path);
        db.forget_download(q.id);
    }
    let src = Source {
        video_id: video_id.to_string(),
        title: info.title,
        channel: info.channel.unwrap_or_default(),
        duration: info.duration.map(|d| d.round() as u32),
        score: 100,
        verified: true,
    };
    db.save_source(q.id, &src);
    Ok(playable(src, info.url))
}

/// Candidatos puntuados, de mejor a peor y sin repetidos. Con `everywhere` busca siempre
/// también en YouTube normal; si no, solo cuando YouTube Music no da una coincidencia clara.
async fn search(q: &TrackQuery, ytm: &YouTubeMusic, ytdlp: &YtDlp, everywhere: bool) -> Result<Vec<Scored>, String> {
    let text = q.search_text();
    let mut scored: Vec<Scored> = Vec::new();
    let mut errors = Vec::new();

    match ytm.search_songs(&text).await {
        Ok(found) => scored.extend(found.into_iter().take(10).enumerate().map(|(i, c)| {
            let s = youtube::score(q, &c, i);
            (c, s, "music")
        })),
        Err(e) => errors.push(e),
    }

    let best = scored.iter().map(|(_, s, _)| *s).max().unwrap_or(i32::MIN);
    if everywhere || best < CONFIDENT_SCORE {
        match ytdlp.search(&text, &q.artist).await {
            Ok(found) => scored.extend(found.into_iter().enumerate().map(|(i, c)| {
                // Algo menos de confianza que en YouTube Music a igualdad de lo demás.
                let s = youtube::score(q, &c, i + 3);
                (c, s, "youtube")
            })),
            Err(e) => errors.push(e),
        }
    }

    if scored.is_empty() && !errors.is_empty() {
        return Err(errors.join(" · "));
    }

    scored.sort_by(|a, b| b.1.cmp(&a.1));
    let mut seen = std::collections::HashSet::new();
    scored.retain(|(c, _, _)| seen.insert(c.video_id.clone()));
    Ok(scored)
}

pub(crate) fn is_gone(err: &str) -> bool {
    let err = err.to_lowercase();
    ["unavailable", "not available", "private", "removed", "terminated", "age"]
        .iter()
        .any(|w| err.contains(w))
}

fn playable(src: Source, url: String) -> Playable {
    Playable { video_id: src.video_id, url, title: src.title, channel: src.channel, local: false }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deezer::Deezer;

    /// Comprueba la elección de vídeo con discos reales (usa la red):
    /// `cargo test real_albums -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn real_albums() {
        let deezer = Deezer::new();
        let ytm = YouTubeMusic::new();
        let mut misses = 0;
        let mut total = 0;
        for query in ["radiohead ok computer", "berri txarrak infrasoinuak", "extremoduro agila", "rosalia el mal querer", "the beatles abbey road"] {
            let found = deezer.search(query).await.unwrap();
            let album = deezer.album(found.albums[0].id).await.unwrap();
            println!("\n== {} — {}", album.artist.name, album.title);
            for t in album.tracks.iter().take(6) {
                let q = TrackQuery {
                    id: t.id,
                    title: t.title.clone(),
                    artist: t.artist.name.clone(),
                    album: album.title.clone(),
                    duration: t.duration,
                };
                let mut scored: Vec<_> = ytm
                    .search_songs(&q.search_text())
                    .await
                    .unwrap()
                    .into_iter()
                    .take(10)
                    .enumerate()
                    .map(|(i, c)| {
                        let s = youtube::score(&q, &c, i);
                        (c, s)
                    })
                    .collect();
                scored.sort_by(|a, b| b.1.cmp(&a.1));
                total += 1;
                match scored.first() {
                    Some((c, s)) if *s >= MIN_SCORE => println!(
                        "  {:<38} {:>4}s → {:<38} {:>4?}s {:?} [{s}]",
                        q.title, q.duration, c.title, c.duration, c.artists
                    ),
                    other => {
                        misses += 1;
                        println!("  {:<38} SIN COINCIDENCIA ({:?})", q.title, other.map(|(c, s)| (&c.title, s)));
                    }
                }
            }
        }
        println!("\n{} de {total} sin coincidencia en YouTube Music", misses);
    }
}

#[cfg(test)]
mod resolve_tests {
    use super::*;

    /// El mismo resolvedor sirve al escritorio y a Android, sin buscar el episodio en YouTube.
    #[tokio::test]
    async fn podcast_uses_persisted_audio_and_rejects_music_sources() {
        let db = Db::open(std::path::Path::new(":memory:")).unwrap();
        db.0.lock().unwrap().execute_batch(
            "INSERT INTO podcast_shows (id, feed_url, title, author, description)
             VALUES (1, 'https://example.org/feed.xml', 'Un podcast', 'Autora', '');
             INSERT INTO podcast_episodes (id, show_id, guid, audio_url)
             VALUES (1, 1, 'episodio-1', 'https://audio.example.org/episode.mp3');",
        ).unwrap();
        let q = TrackQuery {
            id: 750_000_000_000_001,
            title: "Un episodio".into(),
            artist: "Autora".into(),
            album: "Un podcast".into(),
            duration: 3600,
        };
        let ytm = YouTubeMusic::new();
        let ytdlp = YtDlp::new(std::path::PathBuf::new());
        for refresh in [false, true] {
            let playable = resolve(&q, refresh, &db, &ytm, &ytdlp).await.unwrap();
            assert_eq!(playable.url, "https://audio.example.org/episode.mp3");
            assert_eq!(playable.title, q.title);
            assert_eq!(playable.channel, q.artist);
            assert!(playable.video_id.is_empty());
            assert!(!playable.local);
        }
        assert!(db.source(q.id).is_none());
        assert_eq!(
            alternatives(&q, &db, &ytm, &ytdlp).await.err().as_deref(),
            Some("Los episodios usan el audio original del podcast"),
        );
        assert_eq!(
            choose(&q, "video", &db, &ytdlp).await.err().as_deref(),
            Some("Los episodios usan el audio original del podcast"),
        );
        assert_eq!(
            find_video(&q, &db, &ytm, &ytdlp).await.err().as_deref(),
            Some("La descarga de episodios todavía no está disponible"),
        );
        let missing = TrackQuery { id: q.id + 1, ..q };
        assert!(resolve(&missing, false, &db, &ytm, &ytdlp).await.is_err());
        assert!(db.source(missing.id).is_none());
    }

    /// Resolución completa (búsqueda + yt-dlp + base de datos), con red:
    /// `cargo test real_resolve -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn real_resolve() {
        let dir = std::env::temp_dir().join("musify-test");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(&dir.join("test.db")).unwrap();
        let ytm = YouTubeMusic::new();
        let ytdlp = YtDlp::new(std::env::temp_dir().join(format!("pletina-test-resolve-{}", std::process::id())).join("bin"));
        let q = TrackQuery {
            id: 138539971,
            title: "Airbag".into(),
            artist: "Radiohead".into(),
            album: "OK Computer".into(),
            duration: 287,
        };
        db.delete_source(q.id);

        let t = std::time::Instant::now();
        let first = resolve(&q, false, &db, &ytm, &ytdlp).await.unwrap();
        println!("primera vez: {:?} → {} ({})", t.elapsed(), first.title, first.video_id);
        assert!(first.url.contains("googlevideo.com"));
        assert!(db.source(q.id).is_some(), "se guarda la elección");

        let t = std::time::Instant::now();
        let again = resolve(&q, false, &db, &ytm, &ytdlp).await.unwrap();
        println!("segunda vez (guardada): {:?}", t.elapsed());
        assert_eq!(again.video_id, first.video_id);
        println!("URL: {}", again.url);
    }

    /// Lista de alternativas y elección manual, con red:
    /// `cargo test real_alternatives -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn real_alternatives() {
        let dir = std::env::temp_dir().join("musify-test");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(&dir.join("test.db")).unwrap();
        let ytm = YouTubeMusic::new();
        let ytdlp = YtDlp::new(std::env::temp_dir().join(format!("pletina-test-alternatives-{}", std::process::id())).join("bin"));
        let q = TrackQuery {
            id: 999_001,
            title: "Zuri".into(),
            artist: "Berri Txarrak".into(),
            album: "Infrasoinuak".into(),
            duration: 223,
        };
        db.delete_source(q.id);
        resolve(&q, false, &db, &ytm, &ytdlp).await.unwrap();

        let list = alternatives(&q, &db, &ytm, &ytdlp).await.unwrap();
        for a in &list {
            println!(
                "{} {:<45} {:<25} {:>5?}s {:>4} {}",
                if a.current { "*" } else { " " },
                a.title,
                a.artists,
                a.duration,
                a.score,
                a.origin
            );
        }
        assert_eq!(list.iter().filter(|a| a.current).count(), 1, "una marcada como en uso");
        assert!(list.iter().any(|a| a.origin == "youtube"), "incluye YouTube normal");

        // Elegir a mano un directo: queda guardado como verificado y es lo que suena después.
        let other = list.iter().find(|a| !a.current).unwrap();
        let chosen = choose(&q, &other.video_id, &db, &ytdlp).await.unwrap();
        assert_eq!(chosen.video_id, other.video_id);
        let src = db.source(q.id).unwrap();
        assert!(src.verified);
        let again = resolve(&q, false, &db, &ytm, &ytdlp).await.unwrap();
        assert_eq!(again.video_id, other.video_id, "se recuerda la elección manual");
        println!("elegido a mano: {} ({})", chosen.title, chosen.channel);
        db.delete_source(q.id);
    }
}
