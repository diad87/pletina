//! De canción de Deezer a audio reproducible: busca el vídeo (o usa el guardado),
//! saca la URL del stream y recuerda la elección.

use crate::db::{Db, Source};
use crate::extractor;
use crate::youtube::{self, CONFIDENT_SCORE, Candidate, MIN_SCORE, TrackQuery, YouTubeMusic};
use crate::ytdlp::YtDlp;
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};

// También invalida búsquedas que todavía no han obtenido un ID de YouTube.
#[derive(Default)]
struct RequestEpochs { resolution: AtomicU64, prefetch: AtomicU64 }
static REQUESTS: RequestEpochs = RequestEpochs { resolution: AtomicU64::new(0), prefetch: AtomicU64::new(0) };
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RequestTicket {
    pub resolution: u64,
    pub prefetch: Option<u64>,
}
pub fn begin_resolution(foreground: bool) -> u64 {
    REQUESTS.begin_resolution(foreground)
}
pub fn resolution_current(ticket: u64) -> bool { REQUESTS.resolution.load(Ordering::SeqCst) == ticket }
pub fn cancel_prefetch_requests() -> u64 { REQUESTS.cancel_prefetch() }
impl RequestEpochs {
    fn begin_resolution(&self, foreground: bool) -> u64 {
        if foreground { self.resolution.fetch_add(1, Ordering::SeqCst) + 1 }
        else { self.resolution.load(Ordering::SeqCst) }
    }
    fn cancel_prefetch(&self) -> u64 { self.prefetch.fetch_add(1, Ordering::SeqCst) + 1 }
    fn begin(&self, foreground: bool) -> RequestTicket {
        RequestTicket { resolution: self.begin_resolution(foreground), prefetch: (!foreground).then(|| self.cancel_prefetch()) }
    }
    fn prefetch_current(&self, ticket: RequestTicket) -> bool {
        ticket.prefetch.is_none_or(|p| self.prefetch.load(Ordering::SeqCst) == p)
    }
    fn current(&self, ticket: RequestTicket) -> bool {
        self.resolution.load(Ordering::SeqCst) == ticket.resolution && self.prefetch_current(ticket)
    }
}
fn begin_request(foreground: bool) -> RequestTicket { REQUESTS.begin(foreground) }
pub fn prefetch_current(ticket: RequestTicket) -> bool {
    REQUESTS.prefetch_current(ticket)
}
pub fn request_current(ticket: RequestTicket) -> bool {
    REQUESTS.current(ticket)
}
fn ensure_current(ticket: RequestTicket) -> Result<(), String> {
    if request_current(ticket) { Ok(()) } else { Err("CAPTURE_SUPERSEDED: otra canción tiene prioridad".into()) }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Playable {
    pub video_id: String,
    /// URL del stream, o ruta del archivo si `local`.
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

#[cfg(test)]
pub async fn resolve(
    q: &TrackQuery,
    refresh: bool,
    db: &Db,
    ytm: &YouTubeMusic,
    ytdlp: &YtDlp,
) -> Result<Playable, String> {
    resolve_with_priority(q, refresh, db, ytm, ytdlp, true).await
}

pub async fn resolve_with_priority(
    q: &TrackQuery,
    refresh: bool,
    db: &Db,
    ytm: &YouTubeMusic,
    ytdlp: &YtDlp,
    foreground: bool,
) -> Result<Playable, String> {
    let ticket = begin_request(foreground);
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
        match extractor::stream_with_priority(ytdlp, &src.video_id, refresh, foreground, Some(ticket)).await {
            Ok(info) => { ensure_current(ticket)?; return Ok(playable(src, info.url)); },
            // El vídeo ya no existe: se busca otro.
            Err(e) if is_gone(&e) && !src.verified => {
                ensure_current(ticket)?;
                if !db.delete_automatic_source(q.id, &src.video_id) {
                    let chosen = db.source(q.id).ok_or("El vídeo de la canción ha cambiado; vuelve a intentarlo")?;
                    let info = extractor::stream_with_priority(ytdlp, &chosen.video_id, false, foreground, Some(ticket)).await?;
                    ensure_current(ticket)?;
                    return Ok(playable(chosen, info.url));
                }
                gone = Some(src.video_id);
            }
            Err(e) => return Err(e),
        }
    }

    if extractor::stream_engine() == "oficial" {
        ensure_current(ticket)?;
        return Err("SOURCE_SELECTION_REQUIRED: Busca el vídeo en YouTube y pega su enlace para asociarlo a esta canción".into());
    }

    let mut candidates = search(q, ytm, ytdlp, false).await?;
    ensure_current(ticket)?;
    candidates.retain(|(c, s, _)| *s >= MIN_SCORE && gone.as_ref() != Some(&c.video_id));

    #[cfg(debug_assertions)]
    for (c, s, _) in candidates.iter().take(3) {
        eprintln!("[match] {} — {} → {} {:?} {:?}s ({s})", q.artist, q.title, c.title, c.artists, c.duration);
    }

    let mut last_err = None;
    for (c, score, _) in candidates.into_iter().take(MAX_ATTEMPTS) {
        ensure_current(ticket)?;
        match extractor::stream_with_priority(ytdlp, &c.video_id, refresh, foreground, Some(ticket)).await {
            Ok(info) => {
                ensure_current(ticket)?;
                let src = Source {
                    video_id: c.video_id,
                    title: c.title,
                    channel: c.artists.join(", "),
                    duration: c.duration,
                    score,
                    verified: false,
                };
                if !db.save_source(q.id, &src) {
                    let chosen = db.source(q.id).ok_or("No se pudo guardar el vídeo de la canción")?;
                    let info = extractor::stream_with_priority(ytdlp, &chosen.video_id, false, foreground, Some(ticket)).await?;
                    ensure_current(ticket)?;
                    return Ok(playable(chosen, info.url));
                }
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
    let current = db.source(q.id);
    let found = if extractor::stream_engine() == "oficial" {
        Vec::new()
    } else {
        search(q, ytm, ytdlp, true).await?
    };
    let mut list: Vec<Alternative> = found
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
    if db.save_source(q.id, &src) {
        Ok(src.video_id)
    } else {
        db.source(q.id).map(|chosen| chosen.video_id).ok_or_else(|| "No se pudo guardar el vídeo de la canción".into())
    }
}

/// El usuario elige el vídeo de una canción: se guarda como verificado y se devuelve listo para sonar.
/// Si estaba descargada, se borra el archivo (era de otro vídeo).
pub async fn choose(q: &TrackQuery, video_id: &str, db: &Db, ytdlp: &YtDlp, foreground: bool) -> Result<Playable, String> {
    let ticket = begin_request(foreground);
    let info = extractor::stream_with_priority(ytdlp, video_id, false, foreground, Some(ticket)).await?;
    ensure_current(ticket)?;
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
    if !db.save_source(q.id, &src) {
        return Err("No se pudo guardar el vídeo elegido".into());
    }
    Ok(playable(src, info.url))
}

/// Asocia el enlace elegido para otra canción sin preparar audio ni afectar la reproducción.
/// Los metadatos son los del catálogo; la disponibilidad del vídeo se comprueba al reproducirlo.
pub fn remember_source(q: &TrackQuery, video_id: &str, db: &Db) -> Result<(), String> {
    if video_id.len() != 11 || !video_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err("El ID del vídeo de YouTube no es válido".into());
    }
    let src = Source {
        video_id: video_id.to_string(),
        title: q.title.clone(),
        channel: q.artist.clone(),
        duration: Some(q.duration),
        score: 100,
        verified: true,
    };
    if !db.save_source(q.id, &src) {
        return Err("No se pudo guardar el vídeo elegido".into());
    }
    if let Some(path) = db.download_path(q.id) {
        let _ = std::fs::remove_file(path);
        db.forget_download(q.id);
    }
    Ok(())
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
    // Solo desaparición explícita. "webpage" contiene "age" y no significa que el vídeo
    // haya desaparecido; tampoco una restricción de edad o un fallo temporal de captura.
    ["private video", "video is private", "video has been removed", "video has been deleted", "account has been terminated"]
        .iter()
        .any(|w| err.contains(w))
}

fn playable(src: Source, url: String) -> Playable {
    Playable { video_id: src.video_id, url, title: src.title, channel: src.channel, local: false }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn next_requests_are_latest_wins_without_cancelling_the_current_track() {
        let requests = RequestEpochs::default();
        let current = requests.begin(true);
        let slow_b = requests.begin(false);
        let c = requests.begin(false);
        assert!(!requests.current(slow_b), "B cannot replace C after a slow search");
        assert!(requests.current(c));
        assert!(requests.current(current), "prefetch cannot cancel foreground");
        let new_b = requests.begin(false);
        assert!(!requests.current(c));
        assert!(!requests.current(slow_b), "B→C→B needs a new admission");
        assert!(requests.current(new_b));
        let promotion = requests.begin(true);
        assert!(!requests.current(new_b), "old pending results are obsolete");
        assert!(requests.prefetch_current(new_b), "already-admitted next survives until promotion");
        assert!(requests.current(promotion));
        let cancellation = requests.cancel_prefetch();
        assert!(!requests.prefetch_current(new_b));
        let later = requests.begin(false);
        assert!(later.prefetch.unwrap() > cancellation, "queued cancel cannot affect a newer next lease");
        assert!(requests.current(promotion));
    }
    use crate::deezer::Deezer;

    #[test]
    fn remembering_a_manual_video_is_independent_of_playback_resolution() {
        let db = Db::open(std::path::Path::new(":memory:")).unwrap();
        let q = TrackQuery { id: 77, title: "Airbag".into(), artist: "Radiohead".into(), album: "OK Computer".into(), duration: 288 };
        let playing = begin_resolution(true);
        remember_source(&q, "jNY_wLukVW0", &db).unwrap();
        assert!(resolution_current(playing), "asociar otra canción no cancela la que suena");
        begin_resolution(true);
        let remembered = db.source(q.id).unwrap();
        assert!(remembered.verified);
        assert_eq!(remembered.video_id, "jNY_wLukVW0");
        assert_eq!((remembered.title.as_str(), remembered.channel.as_str(), remembered.duration), ("Airbag", "Radiohead", Some(288)));
        for invalid in ["", "jNY_wLukVW0?", "bad/id12345", "á234567890"] {
            assert!(remember_source(&q, invalid, &db).is_err());
        }
        assert_eq!(db.source(q.id).unwrap().video_id, "jNY_wLukVW0");
    }

    #[test]
    fn transient_errors_do_not_erase_sources() {
        for error in [
            "Unable to download webpage: timed out",
            "Sign in to confirm your age",
            "Capture unavailable: no audio progress",
            "El reproductor de YouTube se quedó colgado",
            "Service unavailable (503)",
            "Video unavailable. Sign in to confirm your age",
            "This video is not available in your country",
        ] {
            assert!(!is_gone(error), "{error}");
        }
        assert!(is_gone("ERROR: Video unavailable. This video has been removed"));
        assert!(is_gone("ERROR: Private video. Sign in if you've been granted access"));
    }

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

    /// Resolución completa (búsqueda + yt-dlp + base de datos), con red:
    /// `cargo test real_resolve -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn real_resolve() {
        let dir = std::env::temp_dir().join("musify-test");
        std::fs::create_dir_all(&dir).unwrap();
        let db = Db::open(&dir.join("test.db")).unwrap();
        let ytm = YouTubeMusic::new();
        let ytdlp = YtDlp::new(std::path::PathBuf::from(env!("LOCALAPPDATA")).join("dev.musify.desktop").join("bin"));
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
        let ytdlp = YtDlp::new(std::path::PathBuf::from(env!("LOCALAPPDATA")).join("dev.musify.desktop").join("bin"));
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
        let chosen = choose(&q, &other.video_id, &db, &ytdlp, true).await.unwrap();
        assert_eq!(chosen.video_id, other.video_id);
        let src = db.source(q.id).unwrap();
        assert!(src.verified);
        let again = resolve(&q, false, &db, &ytm, &ytdlp).await.unwrap();
        assert_eq!(again.video_id, other.video_id, "se recuerda la elección manual");
        println!("elegido a mano: {} ({})", chosen.title, chosen.channel);
        db.delete_source(q.id);
    }
}
