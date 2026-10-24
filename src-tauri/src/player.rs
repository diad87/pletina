//! De canción de Deezer a audio reproducible: busca el vídeo (o usa el guardado),
//! saca la URL del stream y recuerda la elección.

use crate::db::{Db, Source};
use crate::extractor;
use crate::youtube::{self, CONFIDENT_SCORE, Candidate, MIN_SCORE, TrackQuery, YouTubeMusic};
use crate::ytdlp::YtDlp;
use serde::Serialize;
use std::sync::Mutex;
use tauri::Emitter;

// También invalida búsquedas que todavía no han obtenido un ID de YouTube.
#[derive(Clone, Copy, Default)]
struct NextLease {
    track_id: u64,
    sequence: u64,
}
#[derive(Default)]
struct EpochState {
    resolution: u64,
    prefetch: u64,
    next: [Option<NextLease>; 2],
}
#[derive(Default)]
struct RequestEpochs {
    state: Mutex<EpochState>,
}
static REQUESTS: RequestEpochs = RequestEpochs {
    state: Mutex::new(EpochState {
        resolution: 0,
        prefetch: 0,
        next: [None, None],
    }),
};
// Sólo los tests que ejercitan el resolvedor global comparten este cerrojo.
#[cfg(test)]
static RESOLUTION_TEST_LOCK: Mutex<()> = Mutex::new(());
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RequestTicket {
    pub resolution: u64,
    pub prefetch: Option<u64>,
    pub prefetch_slot: Option<u8>,
}
pub fn begin_resolution(foreground: bool) -> u64 {
    REQUESTS.begin_resolution(foreground)
}
pub fn resolution_current(ticket: u64) -> bool {
    REQUESTS.state.lock().unwrap().resolution == ticket
}
pub fn cancel_prefetch_requests(slot: Option<u8>) -> Result<u64, String> {
    REQUESTS.cancel_prefetch(slot)
}
fn checked_slot(slot: Option<u8>) -> Result<usize, String> {
    let slot = slot.unwrap_or(0);
    if slot > 1 {
        Err("Plaza de precarga no válida".into())
    } else {
        Ok(slot as usize)
    }
}
impl RequestEpochs {
    fn begin_resolution(&self, foreground: bool) -> u64 {
        let mut state = self.state.lock().unwrap();
        if foreground {
            state.resolution += 1;
        }
        state.resolution
    }
    fn cancel_prefetch(&self, slot: Option<u8>) -> Result<u64, String> {
        if let Some(slot) = slot {
            checked_slot(Some(slot))?;
        }
        let mut state = self.state.lock().unwrap();
        state.prefetch += 1;
        if let Some(slot) = slot {
            state.next[slot as usize] = None;
        } else {
            state.next = [None, None];
        }
        Ok(state.prefetch)
    }
    fn begin(
        &self,
        foreground: bool,
        expected_foreground: Option<u64>,
        slot: Option<u8>,
        track_id: u64,
    ) -> Result<RequestTicket, String> {
        let slot = checked_slot(slot)?;
        // La comprobación y el cambio de lease son atómicos respecto a foreground/cancel.
        let mut state = self.state.lock().unwrap();
        if !foreground && expected_foreground.is_some_and(|expected| expected != state.resolution) {
            return Err("CAPTURE_SUPERSEDED: la precarga pertenece a otra canción".into());
        }
        if foreground {
            state.resolution += 1;
            Ok(RequestTicket {
                resolution: state.resolution,
                prefetch: None,
                prefetch_slot: None,
            })
        } else {
            // C conserva su ventana al promover B: re-admitir el mismo ID en la misma plaza
            // actualiza el epoch de resolución, pero no revoca su lease de captura.
            let lease = match state.next[slot].filter(|lease| lease.track_id == track_id) {
                Some(lease) => lease,
                None => {
                    state.prefetch += 1;
                    let lease = NextLease {
                        track_id,
                        sequence: state.prefetch,
                    };
                    state.next[slot] = Some(lease);
                    lease
                }
            };
            Ok(RequestTicket {
                resolution: state.resolution,
                prefetch: Some(lease.sequence),
                prefetch_slot: Some(slot as u8),
            })
        }
    }
    fn lease_current(state: &EpochState, ticket: RequestTicket) -> bool {
        match (ticket.prefetch, ticket.prefetch_slot) {
            (None, None) => true,
            (Some(sequence), Some(slot @ 0..=1)) => {
                state.next[slot as usize].is_some_and(|lease| lease.sequence == sequence)
            }
            _ => false,
        }
    }
    fn prefetch_current(&self, ticket: RequestTicket) -> bool {
        Self::lease_current(&self.state.lock().unwrap(), ticket)
    }
    fn current(&self, ticket: RequestTicket) -> bool {
        let state = self.state.lock().unwrap();
        state.resolution == ticket.resolution && Self::lease_current(&state, ticket)
    }
}
fn begin_request(
    foreground: bool,
    expected_foreground: Option<u64>,
    slot: Option<u8>,
    track_id: u64,
) -> Result<RequestTicket, String> {
    REQUESTS.begin(foreground, expected_foreground, slot, track_id)
}
pub fn prefetch_current(ticket: RequestTicket) -> bool {
    REQUESTS.prefetch_current(ticket)
}
pub fn request_current(ticket: RequestTicket) -> bool {
    REQUESTS.current(ticket)
}
fn ensure_current(ticket: impl Into<Option<RequestTicket>>) -> Result<(), String> {
    if ticket.into().is_none_or(request_current) {
        Ok(())
    } else {
        Err("CAPTURE_SUPERSEDED: otra canción tiene prioridad".into())
    }
}

/// Aviso opcional para comenzar next tras reservar/promover la plaza foreground.
/// No equivale a audio disponible: capture lo emite después de begin, antes de ready.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForegroundAdmission {
    request_id: String,
    resolution: u64,
    track_id: u64,
    video_id: String,
    engine: &'static str,
    max_sessions: usize,
    prefetch_slots: usize,
}
impl ForegroundAdmission {
    fn new(
        request_id: Option<&str>,
        ticket: impl Into<Option<RequestTicket>>,
        track_id: u64,
        video_id: &str,
        engine: &str,
    ) -> Option<Self> {
        let ticket = ticket.into()?;
        let request_id = request_id.filter(|id| !id.is_empty())?;
        if ticket.prefetch.is_some() || engine != "oficial" || !valid_video_id(video_id) {
            return None;
        }
        Some(Self {
            request_id: request_id.into(),
            resolution: ticket.resolution,
            track_id,
            video_id: video_id.into(),
            engine: "oficial",
            max_sessions: crate::capture::limits().ok()?.max_sessions,
            prefetch_slots: crate::capture::limits().ok()?.prefetch_slots,
        })
    }
    fn matches(&self, ticket: RequestTicket, video_id: &str) -> bool {
        ticket.prefetch.is_none()
            && ticket.resolution == self.resolution
            && video_id == self.video_id
    }
    pub fn emit(&self, app: &tauri::AppHandle, ticket: Option<RequestTicket>, video_id: &str) {
        if ticket.is_some_and(|t| self.matches(t, video_id) && request_current(t)) {
            // Un listener ausente sólo pierde la precarga temprana; no falla la reproducción.
            let _ = app.emit_to("main", "player:foreground-admitted", self);
        }
    }
}
fn valid_video_id(video_id: &str) -> bool {
    video_id.len() == 11
        && video_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

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

fn db_write_error(e: rusqlite::Error) -> String {
    format!("No se pudo actualizar la biblioteca: {e}")
}

#[cfg(any(test, target_os = "android"))]
pub async fn resolve(
    q: &TrackQuery,
    refresh: bool,
    db: &Db,
    ytm: &YouTubeMusic,
    ytdlp: &YtDlp,
) -> Result<Playable, String> {
    // ExoPlayer abre y reintenta cada MediaPeriod por su cuenta. Una apertura JNI
    // no sustituye una elección manual ni otra carga de audio del servicio.
    resolve_with_ticket(q, refresh, db, ytm, ytdlp, true, None, None).await
}

pub async fn resolve_with_priority(
    q: &TrackQuery,
    refresh: bool,
    db: &Db,
    ytm: &YouTubeMusic,
    ytdlp: &YtDlp,
    foreground: bool,
    expected_foreground: Option<u64>,
    request_id: Option<&str>,
    next_slot: Option<u8>,
) -> Result<Playable, String> {
    let ticket = begin_request(foreground, expected_foreground, next_slot, q.id)?;
    resolve_with_ticket(q, refresh, db, ytm, ytdlp, foreground, Some(ticket), request_id).await
}

async fn resolve_with_ticket(
    q: &TrackQuery,
    refresh: bool,
    db: &Db,
    ytm: &YouTubeMusic,
    ytdlp: &YtDlp,
    foreground: bool,
    ticket: Option<RequestTicket>,
    request_id: Option<&str>,
) -> Result<Playable, String> {
    // Enlaces añadidos por el usuario: nunca se sustituyen buscando otra canción por título.
    // El mapeo se conserva aunque se quite la canción del listado de YouTube.
    if crate::youtube_tracks::is_youtube(q.id) {
        let video_id = crate::youtube_tracks::video(db, q.id)?;
        if let Some(path) = db.download_path(q.id) {
            if std::path::Path::new(&path).exists() {
                return Ok(Playable { video_id, url: path, title: q.title.clone(), channel: q.artist.clone(), local: true });
            }
            db.forget_download(q.id).map_err(db_write_error)?;
        }
        let admission = ForegroundAdmission::new(request_id, ticket, q.id, &video_id, extractor::stream_engine());
        let info = extractor::stream_with_admission(ytdlp, &video_id, refresh, foreground, ticket, admission).await?;
        ensure_current(ticket)?;
        return Ok(Playable { video_id, url: info.url, title: q.title.clone(), channel: q.artist.clone(), local: false });
    }
    // Episodios: el audio publicado en el RSS, también desde el servicio nativo de Android.
    if crate::podcasts::is_podcast(q.id) {
        let audio = crate::podcasts::audio(db, q.id)?;
        // Episodio de YouTube Music: es un vídeo, suena con el motor de siempre (o descargado).
        if let Some(video_id) = audio.strip_prefix(crate::youtube_podcasts::PREFIX) {
            if let Some(path) = db
                .download_path(q.id)
                .filter(|p| std::path::Path::new(p).exists())
            {
                return Ok(Playable {
                    video_id: video_id.to_string(),
                    url: path,
                    title: q.title.clone(),
                    channel: q.artist.clone(),
                    local: true,
                });
            }
            let admission = ForegroundAdmission::new(
                request_id,
                ticket,
                q.id,
                video_id,
                extractor::stream_engine(),
            );
            let info = extractor::stream_with_admission(
                ytdlp,
                video_id,
                refresh,
                foreground,
                ticket,
                admission,
            )
            .await?;
            ensure_current(ticket)?;
            return Ok(Playable {
                video_id: video_id.to_string(),
                url: info.url,
                title: q.title.clone(),
                channel: q.artist.clone(),
                local: false,
            });
        }
        return Ok(Playable {
            video_id: String::new(),
            url: audio,
            title: q.title.clone(),
            channel: q.artist.clone(),
            local: false,
        });
    }
    // Música local: el propio archivo, sin YouTube.
    if crate::local::is_local(q.id) {
        let path = crate::local::path(db, q.id).ok_or("Esta canción ya no está en tu música")?;
        if !std::path::Path::new(&path).exists() {
            return Err("No se encuentra el archivo (¿se ha movido o borrado?)".into());
        }
        return Ok(Playable {
            video_id: String::new(),
            url: path,
            title: q.title.clone(),
            channel: q.artist.clone(),
            local: true,
        });
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
        db.forget_download(q.id).map_err(db_write_error)?;
    }

    let mut gone = None;
    if let Some(src) = db.source(q.id) {
        let admission = ForegroundAdmission::new(
            request_id,
            ticket,
            q.id,
            &src.video_id,
            extractor::stream_engine(),
        );
        match extractor::stream_with_admission(
            ytdlp,
            &src.video_id,
            refresh,
            foreground,
            ticket,
            admission,
        )
        .await
        {
            Ok(info) => {
                ensure_current(ticket)?;
                return Ok(playable(src, info.url));
            }
            // El vídeo ya no existe: se busca otro.
            Err(e) if is_gone(&e) && !src.verified => {
                ensure_current(ticket)?;
                if !db.delete_automatic_source(q.id, &src.video_id).map_err(db_write_error)? {
                    let chosen = db
                        .source(q.id)
                        .ok_or("El vídeo de la canción ha cambiado; vuelve a intentarlo")?;
                    let admission = ForegroundAdmission::new(
                        request_id,
                        ticket,
                        q.id,
                        &chosen.video_id,
                        extractor::stream_engine(),
                    );
                    let info = extractor::stream_with_admission(
                        ytdlp,
                        &chosen.video_id,
                        false,
                        foreground,
                        ticket,
                        admission,
                    )
                    .await?;
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

    if extractor::stream_engine() == "propio" {
        // Sólo una sesión de visitante, compartida por el nivel rápido. El trabajo
        // puede continuar si otra canción sustituye ésta, sin tocar sus leases.
        tokio::spawn(crate::native::warm_visitor());
    }
    let search_started = std::time::Instant::now();
    let mut candidates = search(q, ytm, ytdlp, false).await?;
    if std::env::var_os("MUSIFY_BENCH").is_some() {
        eprintln!("[search-timing] {} totalMs={:.3}", q.id, search_started.elapsed().as_secs_f64() * 1000.0);
    }
    ensure_current(ticket)?;
    candidates.retain(|(c, s, _)| *s >= MIN_SCORE && gone.as_ref() != Some(&c.video_id));

    #[cfg(debug_assertions)]
    for (c, s, _) in candidates.iter().take(3) {
        eprintln!(
            "[match] {} — {} → {} {:?} {:?}s ({s})",
            q.artist, q.title, c.title, c.artists, c.duration
        );
    }

    let mut last_err = None;
    for (c, score, _) in candidates.into_iter().take(MAX_ATTEMPTS) {
        ensure_current(ticket)?;
        match extractor::stream_with_priority(ytdlp, &c.video_id, refresh, foreground, ticket)
            .await
        {
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
                if !db.save_source(q.id, &src).map_err(db_write_error)? {
                    let chosen = db
                        .source(q.id)
                        .ok_or("No se pudo guardar el vídeo de la canción")?;
                    let info = extractor::stream_with_priority(
                        ytdlp,
                        &chosen.video_id,
                        false,
                        foreground,
                        ticket,
                    )
                    .await?;
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
    if crate::youtube_tracks::is_youtube(q.id) {
        return Err("Esta canción usa el enlace de YouTube que añadiste".into());
    }
    if crate::podcasts::is_podcast(q.id) {
        return Err("Los episodios usan el audio original del podcast".into());
    }
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
    if crate::youtube_tracks::is_youtube(q.id) {
        return crate::youtube_tracks::video(db, q.id);
    }
    if crate::podcasts::is_podcast(q.id) {
        return crate::podcasts::youtube_video(db, q.id)
            .ok_or_else(|| "La descarga de episodios todavía no está disponible".into());
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
    if db.save_source(q.id, &src).map_err(db_write_error)? {
        Ok(src.video_id)
    } else {
        db.source(q.id)
            .map(|chosen| chosen.video_id)
            .ok_or_else(|| "No se pudo guardar el vídeo de la canción".into())
    }
}

/// Recuperación de una descarga: comprueba hasta tres coincidencias nuevas con su
/// motor de descarga, sin tickets, admisión ni ventanas de captura de reproducción.
pub async fn find_download_replacement(
    q: &TrackQuery,
    failed_video: &str,
    db: &Db,
    ytm: &YouTubeMusic,
    ytdlp: &YtDlp,
) -> Result<String, String> {
    download_replacement_with(q, failed_video, db, || search(q, ytm, ytdlp, false), |id| async move {
        #[cfg(desktop)]
        { ytdlp.stream(&id, false).await.map(|_| ()) }
        #[cfg(mobile)]
        { crate::native::resolve(&id, false).await.map(|_| ()).map_err(|e| e.to_string()) }
    }).await
}

async fn download_replacement_with<S, Search, P, Probe>(
    q: &TrackQuery,
    failed_video: &str,
    db: &Db,
    search: S,
    mut probe: P,
) -> Result<String, String>
where
    S: FnOnce() -> Search,
    Search: std::future::Future<Output = Result<Vec<Scored>, String>>,
    P: FnMut(String) -> Probe,
    Probe: std::future::Future<Output = Result<(), String>>,
{
    if crate::youtube_tracks::is_youtube(q.id) {
        return Err("Esta canción usa el enlace de YouTube que añadiste".into());
    }
    if crate::podcasts::is_podcast(q.id) {
        return Err("Los episodios usan el audio original del podcast".into());
    }
    let chosen = || db.source(q.id).filter(|source| source.verified).map(|source| source.video_id);
    if let Some(id) = chosen() {
        return Ok(id);
    }
    db.delete_automatic_source(q.id, failed_video).map_err(db_write_error)?;
    let candidates = search().await?;
    if let Some(id) = chosen() {
        return Ok(id);
    }
    let mut last_err = None;
    for (c, score, _) in candidates.into_iter()
        .filter(|(c, score, _)| *score >= MIN_SCORE && c.video_id != failed_video)
        .take(MAX_ATTEMPTS)
    {
        let checked = probe(c.video_id.clone()).await;
        // Una elección manual hecha mientras se buscaba/comprobaba sigue mandando,
        // también si la comprobación automática acaba de fallar.
        if let Some(id) = chosen() {
            return Ok(id);
        }
        match checked {
            Ok(()) => {
                let source = Source { video_id: c.video_id, title: c.title, channel: c.artists.join(", "),
                    duration: c.duration, score, verified: false };
                if db.save_source(q.id, &source).map_err(db_write_error)? {
                    return Ok(source.video_id);
                }
                return chosen().ok_or_else(|| "No se pudo guardar el vídeo de la canción".into());
            }
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap_or_else(|| "No se ha encontrado en YouTube".into()))
}

/// El usuario elige el vídeo de una canción: se guarda como verificado y se devuelve listo para sonar.
/// Si estaba descargada, se borra el archivo (era de otro vídeo).
pub async fn choose(
    q: &TrackQuery,
    video_id: &str,
    db: &Db,
    ytdlp: &YtDlp,
    foreground: bool,
    request_id: Option<&str>,
) -> Result<Playable, String> {
    if crate::youtube_tracks::is_youtube(q.id) {
        return Err("Esta canción usa el enlace de YouTube que añadiste".into());
    }
    if crate::podcasts::is_podcast(q.id) {
        return Err("Los episodios usan el audio original del podcast".into());
    }
    let ticket = begin_request(foreground, None, None, q.id)?;
    let admission = ForegroundAdmission::new(
        request_id,
        ticket,
        q.id,
        video_id,
        extractor::stream_engine(),
    );
    let info = extractor::stream_with_admission(
        ytdlp,
        video_id,
        false,
        foreground,
        Some(ticket),
        admission,
    )
    .await?;
    ensure_current(ticket)?;
    let src = Source {
        video_id: video_id.to_string(),
        title: info.title,
        channel: info.channel.unwrap_or_default(),
        duration: info.duration.map(|d| d.round() as u32),
        score: 100,
        verified: true,
    };
    remember_choice(db, q.id, &src)?;
    Ok(playable(src, info.url))
}

fn remember_choice(db: &Db, id: u64, src: &Source) -> Result<(), String> {
    use rusqlite::{OptionalExtension, params};
    let mut conn = db.0.lock().unwrap();
    let tx = conn.transaction().map_err(db_write_error)?;
    let path: Option<String> = tx.query_row("SELECT path FROM downloads WHERE track_id = ?1", params![id as i64], |r| r.get(0))
        .optional().map_err(db_write_error)?;
    // Verifica ambas escrituras antes de tocar el archivo. Si el borrado falla, la transacción
    // revierte la elección y su descarga: no queda una fuente nueva asociada al audio anterior.
    crate::db::write_source(&tx, id, src).map_err(db_write_error)?;
    tx.execute("DELETE FROM downloads WHERE track_id = ?1", params![id as i64]).map_err(db_write_error)?;
    if let Some(path) = path {
        crate::downloads::remove_file_if_present(std::path::Path::new(&path))?;
    }
    tx.commit().map_err(db_write_error)
}

/// Asocia el enlace elegido para otra canción sin preparar audio ni afectar la reproducción.
/// Los metadatos son los del catálogo; la disponibilidad del vídeo se comprueba al reproducirlo.
pub fn remember_source(q: &TrackQuery, video_id: &str, db: &Db) -> Result<(), String> {
    if crate::youtube_tracks::is_youtube(q.id) {
        return Err("Esta canción usa el enlace de YouTube que añadiste".into());
    }
    if crate::podcasts::is_podcast(q.id) {
        return Err("Los episodios usan el audio original del podcast".into());
    }
    if video_id.len() != 11
        || !video_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
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
    remember_choice(db, q.id, &src)
}

/// Candidatos puntuados, de mejor a peor y sin repetidos. Con `everywhere` busca siempre
/// también en YouTube normal; si no, solo cuando YouTube Music no da una coincidencia clara.
async fn search(
    q: &TrackQuery,
    ytm: &YouTubeMusic,
    ytdlp: &YtDlp,
    everywhere: bool,
) -> Result<Vec<Scored>, String> {
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
    [
        "private video",
        "video is private",
        "video has been removed",
        "video has been deleted",
        "account has been terminated",
    ]
    .iter()
    .any(|w| err.contains(w))
}

fn playable(src: Source, url: String) -> Playable {
    Playable {
        video_id: src.video_id,
        url,
        title: src.title,
        channel: src.channel,
        local: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn two_next_leases_survive_promotion_and_only_the_replaced_slot_is_revoked() {
        let requests = RequestEpochs::default();
        let current = requests.begin(true, None, None, 1).unwrap();
        let b = requests
            .begin(false, Some(current.resolution), Some(0), 2)
            .unwrap();
        let c = requests
            .begin(false, Some(current.resolution), Some(1), 3)
            .unwrap();
        assert!(requests.current(b) && requests.current(c) && requests.current(current));
        let promotion = requests.begin(true, None, None, 2).unwrap();
        assert!(!requests.current(c));
        assert!(
            requests.prefetch_current(c),
            "admitted C remains alive across B promotion"
        );
        let resumed_c = requests
            .begin(false, Some(promotion.resolution), Some(1), 3)
            .unwrap();
        assert_eq!(resumed_c.prefetch, c.prefetch);
        let d = requests
            .begin(false, Some(promotion.resolution), Some(0), 4)
            .unwrap();
        assert!(!requests.prefetch_current(b));
        assert!(requests.current(resumed_c) && requests.current(d));
        let fence = requests.cancel_prefetch(Some(0)).unwrap();
        assert!(!requests.prefetch_current(d));
        assert!(requests.current(resumed_c));
        let new_b = requests
            .begin(false, Some(promotion.resolution), Some(0), 2)
            .unwrap();
        assert!(new_b.prefetch.unwrap() > fence);
        requests.cancel_prefetch(None).unwrap();
        assert!(!requests.prefetch_current(new_b) && !requests.prefetch_current(resumed_c));
        assert!(requests.current(promotion));
    }
    #[test]
    fn a_late_foreground_signal_cannot_replace_either_new_tracks_prefetch() {
        let requests = RequestEpochs::default();
        let a = requests.begin(true, None, None, 1).unwrap();
        let b = requests.begin(true, None, None, 2).unwrap();
        let c = requests
            .begin(false, Some(b.resolution), Some(0), 3)
            .unwrap();
        let d = requests
            .begin(false, Some(b.resolution), Some(1), 4)
            .unwrap();
        assert!(
            requests
                .begin(false, Some(a.resolution), Some(0), 5)
                .is_err()
        );
        assert!(requests.current(c) && requests.current(d));
        assert!(
            requests
                .begin(false, Some(b.resolution), Some(2), 6)
                .is_err()
        );
        assert!(requests.cancel_prefetch(Some(2)).is_err());
        assert!(requests.current(c) && requests.current(d));
    }
    #[test]
    fn concurrent_foreground_admission_cannot_attach_early_next_to_a_different_track() {
        use std::sync::{Arc, Barrier};
        for _ in 0..32 {
            let requests = Arc::new(RequestEpochs::default());
            let a = requests.begin(true, None, None, 1).unwrap();
            let barrier = Arc::new(Barrier::new(2));
            let other_requests = Arc::clone(&requests);
            let other_barrier = Arc::clone(&barrier);
            let background = std::thread::spawn(move || {
                other_barrier.wait();
                other_requests.begin(false, Some(a.resolution), Some(1), 3)
            });
            barrier.wait();
            let current = requests.begin(true, None, None, 2).unwrap();
            let previous_prefetch = background.join().unwrap();
            if let Ok(ticket) = previous_prefetch.as_ref() {
                assert_eq!(ticket.resolution, a.resolution);
                assert!(!requests.current(*ticket));
            }
            let next = requests
                .begin(false, Some(current.resolution), Some(1), 3)
                .unwrap();
            assert_eq!(next.prefetch, Some(1));
            assert!(requests.current(next) && requests.current(current));
        }
    }
    #[test]
    fn early_prefetch_notice_requires_an_official_known_foreground_and_matches_its_ticket() {
        let foreground = RequestTicket {
            resolution: 7,
            prefetch: None,
            prefetch_slot: None,
        };
        let background = RequestTicket {
            resolution: 7,
            prefetch: Some(2),
            prefetch_slot: Some(0),
        };
        let video = "jNY_wLukVW0";
        for engine in ["propio", "youtubei", "ytdlp"] {
            assert!(
                ForegroundAdmission::new(Some("play-7"), foreground, 77, video, engine).is_none()
            );
        }
        assert!(ForegroundAdmission::new(None, foreground, 77, video, "oficial").is_none());
        assert!(ForegroundAdmission::new(Some(""), foreground, 77, video, "oficial").is_none());
        assert!(
            ForegroundAdmission::new(Some("play-7"), background, 77, video, "oficial").is_none()
        );
        assert!(
            ForegroundAdmission::new(Some("play-7"), foreground, 77, "not-an-id", "oficial")
                .is_none()
        );
        let notice =
            ForegroundAdmission::new(Some("play-7"), foreground, 77, video, "oficial").unwrap();
        assert!(notice.matches(foreground, video));
        assert!(!notice.matches(background, video));
        assert!(!notice.matches(
            RequestTicket {
                resolution: 8,
                prefetch: None,
                prefetch_slot: None
            },
            video
        ));
        assert!(!notice.matches(foreground, "abcdefghijk"));
        let payload = serde_json::to_value(notice).unwrap();
        assert_eq!(payload["requestId"], "play-7");
        assert_eq!(payload["resolution"], 7);
        assert_eq!(payload["trackId"], 77);
        assert_eq!(payload["videoId"], video);
        assert_eq!(payload["engine"], "oficial");
    }
    use crate::deezer::Deezer;

    #[test]
    fn remembering_a_manual_video_is_independent_of_playback_resolution() {
        let _requests = RESOLUTION_TEST_LOCK.lock().unwrap();
        let db = Db::open(std::path::Path::new(":memory:")).unwrap();
        let q = TrackQuery {
            id: 77,
            title: "Airbag".into(),
            artist: "Radiohead".into(),
            album: "OK Computer".into(),
            duration: 288,
        };
        let playing = begin_resolution(true);
        remember_source(&q, "jNY_wLukVW0", &db).unwrap();
        assert!(
            resolution_current(playing),
            "asociar otra canción no cancela la que suena"
        );
        begin_resolution(true);
        let remembered = db.source(q.id).unwrap();
        assert!(remembered.verified);
        assert_eq!(remembered.video_id, "jNY_wLukVW0");
        assert_eq!(
            (
                remembered.title.as_str(),
                remembered.channel.as_str(),
                remembered.duration
            ),
            ("Airbag", "Radiohead", Some(288))
        );
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
        assert!(is_gone(
            "ERROR: Video unavailable. This video has been removed"
        ));
        assert!(is_gone(
            "ERROR: Private video. Sign in if you've been granted access"
        ));
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
        for query in [
            "radiohead ok computer",
            "berri txarrak infrasoinuak",
            "extremoduro agila",
            "rosalia el mal querer",
            "the beatles abbey road",
        ] {
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
                        println!(
                            "  {:<38} SIN COINCIDENCIA ({:?})",
                            q.title,
                            other.map(|(c, s)| (&c.title, s))
                        );
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

    fn download_query() -> TrackQuery {
        TrackQuery { id: 7, title: "Fixture".into(), artist: "Artista".into(), album: "Disco".into(), duration: 180 }
    }

    fn download_candidate(id: &str, score: i32) -> Scored {
        (Candidate { video_id: id.into(), title: "Fixture".into(), artists: vec!["Artista".into()],
            album: Some("Disco".into()), duration: Some(180) }, score, "music")
    }

    fn download_source(id: &str, verified: bool) -> Source {
        Source { video_id: id.into(), title: "Fixture".into(), channel: "Artista".into(),
            duration: Some(180), score: 100, verified }
    }

    #[tokio::test]
    async fn download_recovery_skips_gone_and_unplayable_without_superseding_playback() {
        let _requests = RESOLUTION_TEST_LOCK.lock().unwrap();
        let db = Db::open(std::path::Path::new(":memory:")).unwrap();
        let q = download_query();
        db.save_source(q.id, &download_source("gone", false)).unwrap();
        let playing = begin_request(true, None, None, 77).unwrap();
        let next = begin_request(false, Some(playing.resolution), Some(1), 78).unwrap();
        let calls = std::cell::RefCell::new(Vec::new());
        let found = download_replacement_with(&q, "gone", &db,
            || async { Ok(vec![download_candidate("gone", 100), download_candidate("low", MIN_SCORE - 1),
                download_candidate("private", 99), download_candidate("unavailable", 98),
                download_candidate("playable", 97), download_candidate("unused", 96)]) },
            |id| {
                calls.borrow_mut().push(id.clone());
                std::future::ready(if id == "playable" { Ok(()) } else { Err(format!("{id}: unavailable")) })
            }).await.unwrap();
        assert_eq!(found, "playable");
        assert_eq!(*calls.borrow(), ["private", "unavailable", "playable"]);
        let saved = db.source(q.id).unwrap();
        assert_eq!(saved.video_id, "playable");
        assert_eq!(saved.score, 97);
        assert!(!saved.verified);
        assert!(ensure_current(playing).is_ok());
        assert!(ensure_current(next).is_ok());
    }

    #[tokio::test]
    async fn download_recovery_stops_after_three_failed_candidates_and_keeps_the_error() {
        let db = Db::open(std::path::Path::new(":memory:")).unwrap();
        let q = download_query();
        db.save_source(q.id, &download_source("gone", false)).unwrap();
        let calls = std::cell::RefCell::new(Vec::new());
        let error = download_replacement_with(&q, "gone", &db,
            || async { Ok(["first", "second", "third", "fourth"].into_iter()
                .map(|id| download_candidate(id, 100)).collect()) },
            |id| {
                calls.borrow_mut().push(id.clone());
                std::future::ready(Err(format!("{id}: unavailable")))
            }).await.unwrap_err();
        assert_eq!(error, "third: unavailable");
        assert_eq!(*calls.borrow(), ["first", "second", "third"]);
        assert!(db.source(q.id).is_none(), "no guarda un candidato que no se pudo reproducir");
    }

    #[tokio::test]
    async fn download_recovery_preserves_manual_choices_before_and_during_awaits() {
        let q = download_query();
        let db = Db::open(std::path::Path::new(":memory:")).unwrap();
        db.save_source(q.id, &download_source("manual-before", true)).unwrap();
        let calls = std::cell::Cell::new(0);
        assert_eq!(download_replacement_with(&q, "gone", &db,
            || { calls.set(calls.get() + 1); std::future::ready(Ok(vec![])) },
            |_| { calls.set(calls.get() + 1); std::future::ready(Ok(())) }).await.unwrap(), "manual-before");
        assert_eq!(calls.get(), 0);

        // Elección manual mientras se busca, antes de comprobar ningún resultado.
        let db = Db::open(std::path::Path::new(":memory:")).unwrap();
        assert_eq!(download_replacement_with(&q, "gone", &db,
            || async {
                tokio::task::yield_now().await;
                db.save_source(q.id, &download_source("manual-search", true)).unwrap();
                Ok(vec![download_candidate("automatic", 100)])
            },
            |_| { calls.set(calls.get() + 1); std::future::ready(Ok(())) }).await.unwrap(), "manual-search");
        assert_eq!(calls.get(), 0);

        // Tanto un probe válido como uno fallido deben respetar la elección nueva.
        for probe_ok in [true, false] {
            let db = Db::open(std::path::Path::new(":memory:")).unwrap();
            let found = download_replacement_with(&q, "gone", &db,
                || async { Ok(vec![download_candidate("automatic", 100)]) },
                |_| async {
                    tokio::task::yield_now().await;
                    db.save_source(q.id, &download_source("manual-probe", true)).unwrap();
                    if probe_ok { Ok(()) } else { Err("unavailable".into()) }
                }).await.unwrap();
            assert_eq!(found, "manual-probe");
            assert!(db.source(q.id).unwrap().verified);
        }
    }

    #[tokio::test]
    async fn download_recovery_propagates_database_and_search_failures() {
        let q = download_query();
        let db = Db::open(std::path::Path::new(":memory:")).unwrap();
        db.save_source(q.id, &download_source("gone", false)).unwrap();
        db.0.lock().unwrap().execute_batch("PRAGMA query_only=ON;").unwrap();
        let calls = std::cell::Cell::new(0);
        let error = download_replacement_with(&q, "gone", &db,
            || { calls.set(calls.get() + 1); std::future::ready(Ok(vec![])) },
            |_| std::future::ready(Ok(()))).await.unwrap_err();
        assert!(error.starts_with("No se pudo actualizar la biblioteca:"));
        assert_eq!(calls.get(), 0);
        assert_eq!(db.source(q.id).unwrap().video_id, "gone");

        db.0.lock().unwrap().execute_batch("PRAGMA query_only=OFF;").unwrap();
        let error = download_replacement_with(&q, "gone", &db,
            || async { Ok(vec![download_candidate("playable", 100)]) },
            |_| async {
                db.0.lock().unwrap().execute_batch("PRAGMA query_only=ON;").unwrap();
                Ok(())
            }).await.unwrap_err();
        assert!(error.starts_with("No se pudo actualizar la biblioteca:"));
        assert!(db.source(q.id).is_none());

        db.0.lock().unwrap().execute_batch("PRAGMA query_only=OFF;").unwrap();
        assert_eq!(download_replacement_with(&q, "gone", &db,
            || async { Err("search failed".into()) },
            |_| std::future::ready(Ok(()))).await.unwrap_err(), "search failed");
    }

    #[tokio::test]
    async fn download_recovery_never_remaps_youtube_links_or_podcasts() {
        let db = Db::open(std::path::Path::new(":memory:")).unwrap();
        for id in [crate::youtube_tracks::YOUTUBE_BASE + 7, 750_000_000_000_007] {
            let q = TrackQuery { id, ..download_query() };
            db.save_source(id, &download_source("fixed", false)).unwrap();
            let calls = std::cell::Cell::new(0);
            assert!(download_replacement_with(&q, "fixed", &db,
                || { calls.set(calls.get() + 1); std::future::ready(Ok(vec![])) },
                |_| { calls.set(calls.get() + 1); std::future::ready(Ok(())) }).await.is_err());
            assert_eq!(calls.get(), 0);
            assert_eq!(db.source(id).unwrap().video_id, "fixed");
        }
    }

    #[tokio::test]
    async fn native_reopens_do_not_supersede_ui_selection_or_prefetch() {
        let _requests = RESOLUTION_TEST_LOCK.lock().unwrap();
        let db = Db::open(std::path::Path::new(":memory:")).unwrap();
        db.0.lock().unwrap().execute_batch(
            "INSERT INTO podcast_shows (id, feed_url, title, author, description)
             VALUES (1, 'https://example.org/feed.xml', 'Podcast', 'Autora', '');
             INSERT INTO podcast_episodes (id, show_id, guid, audio_url)
             VALUES (1, 1, 'episode', 'https://audio.example.org/episode.mp3');",
        ).unwrap();
        let q = TrackQuery {
            id: 750_000_000_000_001,
            title: "Episodio".into(),
            artist: "Autora".into(),
            album: "Podcast".into(),
            duration: 60,
        };
        let ytm = YouTubeMusic::new();
        let ytdlp = YtDlp::new(std::path::PathBuf::new());
        let selection = begin_request(true, None, None, 77).unwrap();
        let next = begin_request(false, Some(selection.resolution), Some(1), 78).unwrap();

        // Las aperturas y reintentos JNI no revocan las operaciones de la interfaz.
        for refresh in [false, true] {
            let audio = resolve(&q, refresh, &db, &ytm, &ytdlp).await.unwrap();
            assert_eq!(audio.url, "https://audio.example.org/episode.mp3");
            assert!(ensure_current(selection).is_ok());
            assert!(ensure_current(next).is_ok());
        }

        // Una nueva intención de la interfaz sigue invalidando sus tickets anteriores.
        let replacement = begin_request(true, None, None, 79).unwrap();
        assert!(ensure_current(selection).is_err());
        assert!(ensure_current(next).is_err());
        assert!(ensure_current(None).is_ok());
        assert!(ForegroundAdmission::new(Some("native"), None, q.id, "jNY_wLukVW0", "oficial").is_none());
        resolve(&q, true, &db, &ytm, &ytdlp).await.unwrap();
        assert!(ensure_current(replacement).is_ok());
    }

    #[test]
    fn manual_choice_keeps_previous_source_and_download_when_writes_or_removal_fail() {
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("pletina-choice-{}-{nonce}.webm", std::process::id()));
        std::fs::write(&path, b"old audio").unwrap();
        let db = Db::open(std::path::Path::new(":memory:")).unwrap();
        let old = Source { video_id: "old".into(), title: "Fixture".into(), channel: "Fixture".into(), duration: None, score: 90, verified: true };
        db.save_source(7, &old).unwrap();
        {
            let conn = db.0.lock().unwrap();
            conn.execute_batch("INSERT INTO tracks (id,title,duration,artist_id,artist_name,album_id,album_title,album_artist_id) VALUES (7,'Fixture',1,1,'Fixture',1,'Fixture',1);").unwrap();
            conn.execute("INSERT INTO downloads (track_id,path,size,video_id) VALUES (7,?1,9,'old')", rusqlite::params![path.to_string_lossy()]).unwrap();
            conn.execute_batch("PRAGMA query_only=ON;").unwrap();
        }
        let new = Source { video_id: "new".into(), ..old };
        assert!(remember_choice(&db, 7, &new).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"old audio");
        assert_eq!(db.source(7).unwrap().video_id, "old");
        assert!(db.download_path(7).is_some());

        db.0.lock().unwrap().execute_batch("PRAGMA query_only=OFF;").unwrap();
        // Un directorio provoca un fallo real de remove_file en todas las plataformas.
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(remember_choice(&db, 7, &new).is_err());
        assert_eq!(db.source(7).unwrap().video_id, "old");
        assert!(db.download_path(7).is_some());
        std::fs::remove_dir(&path).unwrap();
        std::fs::write(&path, b"old audio").unwrap();
        remember_choice(&db, 7, &new).unwrap();
        assert_eq!(db.source(7).unwrap().video_id, "new");
        assert!(db.download_path(7).is_none());
        assert!(!path.exists());
    }

    /// Un enlace mantiene su vídeo al reiniciar aunque otra caché sugiera una coincidencia,
    /// y el mismo resolvedor usado por Android y escritorio reproduce su descarga sin red.
    #[tokio::test]
    async fn youtube_link_keeps_its_video_and_offline_audio_after_reopening() {
        use crate::youtube_tracks::{Preview, YOUTUBE_BASE};
        use rusqlite::params;
        let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("pletina-youtube-{}-{unique}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        let database = dir.join("library.db");
        let audio = dir.join("song.webm");
        std::fs::write(&audio, b"downloaded audio").unwrap();
        let q = {
            let db = Db::open(&database).unwrap();
            let track = crate::youtube_tracks::save(&db, Preview {
                video_id: "dQw4w9WgXcQ".into(),
                title: "Mi título".into(),
                artist: "Mi artista".into(),
                duration: 215,
                cover: None,
            }).unwrap();
            db.save_source(track.id, &Source {
                video_id: "jNY_wLukVW0".into(), title: "Otra canción".into(), channel: "Otro".into(),
                duration: Some(215), score: 100, verified: true,
            }).unwrap();
            db.0.lock().unwrap().execute(
                "INSERT INTO downloads (track_id, path, size, video_id) VALUES (?1, ?2, 16, 'dQw4w9WgXcQ')",
                params![track.id as i64, audio.to_string_lossy()],
            ).unwrap();
            TrackQuery { id: track.id, title: track.title, artist: track.artist_name, album: track.album_title, duration: track.duration }
        };
        let db = Db::open(&database).unwrap();
        let ytm = YouTubeMusic::new();
        let ytdlp = YtDlp::new(std::path::PathBuf::new());
        assert_eq!(find_video(&q, &db, &ytm, &ytdlp).await.unwrap(), "dQw4w9WgXcQ");
        for refresh in [false, true] {
            let p = resolve(&q, refresh, &db, &ytm, &ytdlp).await.unwrap();
            assert!(p.local);
            assert_eq!(p.video_id, "dQw4w9WgXcQ");
            assert_eq!(p.url, audio.to_string_lossy());
            assert_eq!(p.title, "Mi título");
            assert_eq!(p.channel, "Mi artista");
        }
        assert_eq!(alternatives(&q, &db, &ytm, &ytdlp).await.err().as_deref(), Some("Esta canción usa el enlace de YouTube que añadiste"));
        assert_eq!(choose(&q, "jNY_wLukVW0", &db, &ytdlp, true, None).await.err().as_deref(), Some("Esta canción usa el enlace de YouTube que añadiste"));
        assert_eq!(remember_source(&q, "jNY_wLukVW0", &db).err().as_deref(), Some("Esta canción usa el enlace de YouTube que añadiste"));
        let missing = TrackQuery { id: YOUTUBE_BASE + 98765, ..q };
        assert!(find_video(&missing, &db, &ytm, &ytdlp).await.is_err());
        assert!(resolve(&missing, false, &db, &ytm, &ytdlp).await.is_err());
        assert!(db.source(missing.id).is_none());
        drop(db);
        std::fs::remove_file(audio).unwrap();
        std::fs::remove_file(database).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }

    /// El mismo resolvedor sirve al escritorio y a Android, sin buscar el episodio en YouTube.
    #[tokio::test]
    async fn podcast_uses_persisted_audio_and_rejects_music_sources() {
        let _requests = RESOLUTION_TEST_LOCK.lock().unwrap();
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
            choose(&q, "video", &db, &ytdlp, true, None)
                .await
                .err()
                .as_deref(),
            Some("Los episodios usan el audio original del podcast"),
        );
        assert_eq!(
            remember_source(&q, "jNY_wLukVW0", &db).err().as_deref(),
            Some("Los episodios usan el audio original del podcast"),
        );
        assert!(db.source(q.id).is_none());
        assert_eq!(
            find_video(&q, &db, &ytm, &ytdlp).await.err().as_deref(),
            Some("La descarga de episodios todavía no está disponible"),
        );
        db.0.lock().unwrap().execute(
            "UPDATE podcast_episodes SET audio_url='youtube:jNY_wLukVW0' WHERE id=1",
            [],
        ).unwrap();
        assert_eq!(find_video(&q, &db, &ytm, &ytdlp).await.unwrap(), "jNY_wLukVW0");
        assert!(db.source(q.id).is_none(), "el episodio conserva su fuente propia");
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
        db.delete_source(q.id).unwrap();

        let t = std::time::Instant::now();
        let first = resolve(&q, false, &db, &ytm, &ytdlp).await.unwrap();
        println!(
            "primera vez: {:?} → {} ({})",
            t.elapsed(),
            first.title,
            first.video_id
        );
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
        db.delete_source(q.id).unwrap();
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
        assert_eq!(
            list.iter().filter(|a| a.current).count(),
            1,
            "una marcada como en uso"
        );
        assert!(
            list.iter().any(|a| a.origin == "youtube"),
            "incluye YouTube normal"
        );

        // Elegir a mano un directo: queda guardado como verificado y es lo que suena después.
        let other = list.iter().find(|a| !a.current).unwrap();
        let chosen = choose(&q, &other.video_id, &db, &ytdlp, true, None)
            .await
            .unwrap();
        assert_eq!(chosen.video_id, other.video_id);
        let src = db.source(q.id).unwrap();
        assert!(src.verified);
        let again = resolve(&q, false, &db, &ytm, &ytdlp).await.unwrap();
        assert_eq!(
            again.video_id, other.video_id,
            "se recuerda la elección manual"
        );
        println!("elegido a mano: {} ({})", chosen.title, chosen.channel);
        db.delete_source(q.id).unwrap();
    }
}
