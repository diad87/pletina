//! Captura oficial experimental. Cada ventana tiene una generación nativa y cada conjunto de
//! bytes una revisión. Los callbacks no pueden elegir su sesión y las ventanas se serializan.
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "yt-engine";
pub const SCHEME: &str = "musify-capture:";
const KEEP: usize = 6;
const MAX_BYTES: usize = 96 * 1024 * 1024;
const MAX_SEGMENT_BYTES: usize = 4 * 1024 * 1024;
const READ_BYTES: usize = 1024 * 1024;
const READ_CHUNKS: usize = 32;
const HEARTBEAT_STALL: Duration = Duration::from_secs(12);
const PROGRESS_STALL: Duration = Duration::from_secs(60);
const MAX_RESETS: u8 = 2;
const MAX_WAIT: Duration = Duration::from_secs(20 * 60);
const MAX_AD_WAIT_CREDIT: Duration = Duration::from_secs(180);

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct TimelineSettings {
    timestamp_offset: f64,
    append_window_start: f64,
    append_window_end: Option<f64>,
    mode: String,
}

impl Default for TimelineSettings {
    fn default() -> Self {
        Self {
            timestamp_offset: 0.0,
            append_window_start: 0.0,
            append_window_end: None,
            mode: "segments".into(),
        }
    }
}

impl TimelineSettings {
    fn valid(&self) -> bool {
        self.timestamp_offset.is_finite()
            && self.append_window_start.is_finite()
            && self.append_window_start >= 0.0
            && self
                .append_window_end
                .is_none_or(|end| end.is_finite() && end > self.append_window_start)
            && self.mode == "segments"
    }

    fn from_message(value: Option<serde_json::Value>) -> Option<Self> {
        // API 2 en desarrollo: sólo la ausencia del objeto completo admite el default.
        let Some(value) = value else {
            return Some(Self::default());
        };
        if !value.as_object()?.contains_key("appendWindowEnd") {
            return None;
        }
        let settings: Self = serde_json::from_value(value).ok()?;
        settings.valid().then_some(settings)
    }
}

fn present_json<'de, D>(deserializer: D) -> Result<Option<serde_json::Value>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    // Distingue un objeto ausente (default de serde) de un null explícito inválido.
    serde_json::Value::deserialize(deserializer).map(Some)
}

struct Track {
    revision: u64,
    generation: u64,
    sequence: Option<u64>,
    opened: Instant,
    used: Instant,
    session_started: Instant,
    mime: String,
    chunks: Vec<Vec<u8>>,
    mimes: Vec<String>,
    bytes: usize,
    ads: usize,
    unknown: usize,
    quarantined: u64,
    verified: bool,
    verified_source: Option<u64>,
    verified_buffer: Option<u64>,
    timeline_settings: Option<TimelineSettings>,
    frames: u64,
    range_start: Option<f64>,
    range_end: Option<f64>,
    phase: String,
    title: String,
    author: String,
    duration: Option<f64>,
    first_ms: Option<u64>,
    playing_ms: Option<u64>,
    meta_ms: Option<u64>,
    done_ms: Option<u64>,
    error: Option<String>,
    why: Option<String>,
    last_diagnostic: Option<String>,
    last_read: Option<Instant>,
    last_msg: Instant,
    last_progress: Instant,
    position: f64,
    ad_observation: Option<(u64, f64, Instant)>,
    ad_wait_credit: Duration,
    resets: u8,
}

impl Track {
    fn new(revision: u64, generation: u64) -> Self {
        let now = Instant::now();
        Self {
            revision,
            generation,
            sequence: None,
            opened: now,
            used: now,
            session_started: now,
            mime: String::new(),
            chunks: vec![],
            mimes: vec![],
            bytes: 0,
            ads: 0,
            unknown: 0,
            quarantined: 0,
            verified: false,
            verified_source: None,
            verified_buffer: None,
            timeline_settings: None,
            frames: 0,
            range_start: None,
            range_end: None,
            phase: "unknown".into(),
            title: String::new(),
            author: String::new(),
            duration: None,
            first_ms: None,
            playing_ms: None,
            meta_ms: None,
            done_ms: None,
            error: None,
            why: None,
            last_diagnostic: None,
            last_read: None,
            last_msg: now,
            last_progress: now,
            position: 0.0,
            ad_observation: None,
            ad_wait_credit: Duration::ZERO,
            resets: 0,
        }
    }
    fn ms(&self) -> u64 {
        self.opened.elapsed().as_millis() as u64
    }
    fn ready(&self) -> bool {
        self.error.is_none() && self.first_ms.is_some()
    }
    fn protected(&self, now: Instant) -> bool {
        self.done_ms.is_none()
            && self.error.is_none()
            && (self
                .last_read
                .is_some_and(|at| now.saturating_duration_since(at) < Duration::from_secs(2))
                || now.saturating_duration_since(self.session_started) < Duration::from_secs(3))
    }
    fn stalled(&self, now: Instant) -> bool {
        self.done_ms.is_none()
            && self.error.is_none()
            && self.phase != "interaction"
            && (now.saturating_duration_since(self.last_msg) >= HEARTBEAT_STALL
                || now.saturating_duration_since(self.last_progress) >= PROGRESS_STALL)
    }
    fn wait_budget(&self) -> Duration {
        Duration::from_secs_f64(
            (self.duration.unwrap_or(0.0) + 120.0 + self.ad_wait_credit.as_secs_f64())
                .clamp(120.0, MAX_WAIT.as_secs_f64()),
        )
    }

    /// Sólo descuenta del presupuesto el tiempo observado de publicidad que avanza a 1x.
    /// Un heartbeat, un salto al omitir un anuncio o un cambio de fuente no compra tiempo.
    fn observe_ad_progress(&mut self, source: u64, position: f64, now: Instant) -> bool {
        let previous = self.ad_observation.replace((source, position, now));
        let Some((previous_source, previous_position, at)) = previous else {
            return false;
        };
        let elapsed = now.saturating_duration_since(at);
        let advance = position - previous_position;
        if source != previous_source
            || elapsed > HEARTBEAT_STALL
            || advance <= 0.05
            || advance > elapsed.as_secs_f64() + 0.25
        {
            return false;
        }
        let credit = Duration::from_secs_f64(advance.min(elapsed.as_secs_f64()));
        self.ad_wait_credit = (self.ad_wait_credit + credit).min(MAX_AD_WAIT_CREDIT);
        true
    }

    fn resume(&mut self, generation: u64) {
        let now = Instant::now();
        self.generation = generation;
        self.sequence = None;
        self.done_ms = None;
        self.error = None;
        self.why = None;
        self.last_diagnostic = None;
        self.phase = "unknown".into();
        self.quarantined = 0;
        self.verified = false;
        self.verified_source = None;
        self.verified_buffer = None;
        self.timeline_settings = None;
        self.frames = 0;
        self.range_start = None;
        self.range_end = None;
        self.session_started = now;
        self.last_msg = now;
        self.last_progress = now;
        self.ad_observation = None;
        self.ad_wait_credit = Duration::ZERO;
        self.used = now;
    }

    fn replay_complete(&mut self, revision: u64) -> bool {
        if !self.verified || self.done_ms.is_none() || self.error.is_some() {
            return false;
        }
        self.revision = revision;
        self.used = Instant::now();
        self.last_read = Some(self.used);
        true
    }

    fn mark_cancelled(&mut self) {
        if self.done_ms.is_none() {
            self.error
                .get_or_insert_with(|| "CAPTURE_CANCELLED: captura cancelada".into());
        }
    }
}

#[derive(Clone, Debug)]
struct Session {
    id: String,
    generation: u64,
    label: String,
    foreground: bool,
    ticket: Option<u64>,
}

#[derive(Default)]
struct Supervisor {
    tracks: HashMap<String, Track>,
    session: Option<Session>,
    cancellations: HashMap<String, u64>,
}

#[derive(Debug, PartialEq)]
enum StartDecision {
    Join(u64),
    Wait,
    Start,
}

impl Supervisor {
    fn owns(&self, id: &str, generation: u64) -> bool {
        self.session
            .as_ref()
            .is_some_and(|s| s.id == id && s.generation == generation)
    }
    fn cancellation(&self, id: &str) -> u64 {
        self.cancellations.get(id).copied().unwrap_or(0)
    }

    fn can_cancel(&self, id: &str, generation: Option<u64>, before: Option<u64>) -> bool {
        if generation.is_some_and(|generation| !self.owns(id, generation)) {
            return false;
        }
        before.is_none_or(|before| {
            self.session
                .as_ref()
                .is_some_and(|s| s.id == id && s.ticket.is_some_and(|ticket| ticket < before))
        })
    }

    fn request(&mut self, id: &str, refresh: bool, foreground: bool) -> StartDecision {
        if foreground {
            if let Some(session) = self.session.as_mut().filter(|s| s.id == id) {
                session.foreground = true;
            }
        }
        match &self.session {
            Some(s)
                if s.id == id
                    && !refresh
                    && self.tracks.get(id).is_some_and(|t| t.error.is_none()) =>
            {
                StartDecision::Join(s.generation)
            }
            Some(s)
                if !foreground
                    && s.id != id
                    && self
                        .tracks
                        .get(&s.id)
                        .is_some_and(|t| t.done_ms.is_none() && t.error.is_none()) =>
            {
                StartDecision::Wait
            }
            _ => StartDecision::Start,
        }
    }

    /// El caller mantiene TRANSITION: incluso la caché lista debe adoptar el ticket de la
    /// petición explícita antes de que el watchdog pueda cancelar su ventana de precarga.
    fn prepare(
        &mut self,
        id: &str,
        refresh: bool,
        foreground: bool,
        ticket: Option<u64>,
    ) -> (StartDecision, Option<Meta>) {
        let decision = self.request(id, refresh, foreground);
        if foreground && matches!(decision, StartDecision::Join(_)) {
            if let Some(session) = self.session.as_mut() {
                session.ticket = ticket;
            }
        }
        let cached = self.tracks.get(id).filter(|t| {
            !refresh
                && t.ready()
                && (t.done_ms.is_some() || self.session.as_ref().is_some_and(|s| s.id == id))
        });
        (decision, cached.map(meta))
    }

    fn trim(&mut self, keep_id: &str) {
        while self.tracks.len() > KEEP {
            let oldest = self
                .tracks
                .iter()
                .filter(|(id, t)| id.as_str() != keep_id && !t.protected(Instant::now()))
                .min_by_key(|(_, t)| t.used)
                .map(|(id, _)| id.clone());
            let Some(id) = oldest else { break };
            self.tracks.remove(&id);
        }
    }
}
pub static USED: AtomicU64 = AtomicU64::new(0);
static STATE: LazyLock<Mutex<Supervisor>> = LazyLock::new(Default::default);
/// Solo las operaciones de crear, cerrar y navegar ventanas mantienen este guard.
static TRANSITION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();
static SEQ: AtomicU64 = AtomicU64::new(1);
pub struct Meta {
    pub title: String,
    pub channel: Option<String>,
    pub duration: Option<f64>,
}

fn supported() -> Result<(), String> {
    if cfg!(windows) {
        Ok(())
    } else {
        Err("CAPTURE_UNSUPPORTED_PLATFORM: la captura oficial requiere Windows".into())
    }
}

fn request_current(ticket: Option<u64>) -> Result<(), String> {
    if ticket.is_some_and(|ticket| !crate::player::resolution_current(ticket)) {
        Err("CAPTURE_CANCELLED: resolución sustituida".into())
    } else {
        Ok(())
    }
}

/// Las precargas no sustituyen una presentación en curso. Una petición explícita del usuario
/// sí puede hacerlo; la solicitud antigua termina cancelada y nunca recupera la ventana.
pub async fn stream_with_priority(
    app: &AppHandle,
    video_id: &str,
    refresh: bool,
    foreground: bool,
    ticket: Option<u64>,
) -> Result<Meta, String> {
    supported()?;
    request_current(ticket)?;
    if !valid_id(video_id) {
        return Err("id de vídeo no válido".into());
    }
    let started = Instant::now();
    let cancellation = STATE.lock().unwrap().cancellation(video_id);
    let mut generation = None;
    let mut wait_budget = Duration::from_secs(120);
    loop {
        request_current(ticket)?;
        {
            let state = STATE.lock().unwrap();
            if state.cancellation(video_id) != cancellation {
                return Err("CAPTURE_CANCELLED: captura cancelada".into());
            }
            if let Some(t) = state.tracks.get(video_id) {
                if let Some(g) = generation {
                    if let Some(e) = &t.error {
                        return Err(e.clone());
                    }
                    // Una recuperación conserva la solicitud; otra canción no vuelve a abrirla.
                    if !state.owns(video_id, g)
                        && !state.session.as_ref().is_some_and(|s| s.id == video_id)
                        && t.done_ms.is_none()
                    {
                        return Err("CAPTURE_CANCELLED: otra canción sustituyó la captura".into());
                    }
                    if let Some(session) = state.session.as_ref().filter(|s| s.id == video_id) {
                        generation = Some(session.generation);
                    }
                    if t.ready() {
                        return Ok(meta(t));
                    }
                    wait_budget = wait_budget.max(t.wait_budget());
                    if started.elapsed() > wait_budget {
                        break;
                    }
                }
            }
        }
        if started.elapsed() > MAX_WAIT {
            break;
        }
        if generation.is_none() {
            let _guard = TRANSITION.lock().await;
            request_current(ticket)?;
            let (decision, cached) = {
                let mut state = STATE.lock().unwrap();
                if state.cancellation(video_id) != cancellation {
                    return Err("CAPTURE_CANCELLED: captura cancelada".into());
                }
                state.prepare(video_id, refresh, foreground, ticket)
            };
            if let Some(meta) = cached {
                return Ok(meta);
            }
            match decision {
                StartDecision::Join(g) => generation = Some(g),
                StartDecision::Start => {
                    generation =
                        Some(open_locked(app, video_id, None, false, foreground, ticket).await?);
                    USED.fetch_add(1, Ordering::Relaxed);
                }
                StartDecision::Wait => {}
            }
        }
        tokio::time::sleep(Duration::from_millis(80)).await;
    }
    let error = "CAPTURE_TIMEOUT: YouTube no entregó una presentación completa dentro del límite";
    if let Some(generation) = generation {
        fail_session(video_id, generation, error);
    }
    let _ = cancel(app, video_id, generation).await;
    Err(error.into())
}

fn meta(t: &Track) -> Meta {
    Meta {
        title: t.title.clone(),
        channel: (!t.author.is_empty()).then(|| t.author.clone()),
        duration: t.duration,
    }
}

/// El caller mantiene TRANSITION, incluso durante el cierre de la ventana anterior.
async fn open_locked(
    app: &AppHandle,
    video_id: &str,
    at: Option<f64>,
    recovery: bool,
    foreground: bool,
    ticket: Option<u64>,
) -> Result<u64, String> {
    supported()?;
    request_current(ticket)?;
    let _ = APP.set(app.clone());
    watchdog(app);
    let generation = SEQ.fetch_add(1, Ordering::Relaxed);
    let label = format!("{LABEL}-{generation}");
    #[cfg(debug_assertions)]
    eprintln!(
        "[captura] {video_id} generation={generation} open foreground={foreground} recovery={recovery}"
    );
    let old = {
        let mut state = STATE.lock().unwrap();
        let old = state.session.take();
        let previous_resets = state.tracks.get(video_id).map(|t| t.resets).unwrap_or(0);
        let previous_duration = state.tracks.get(video_id).and_then(|t| t.duration);
        match (at, state.tracks.get_mut(video_id)) {
            (Some(_), Some(t)) if !t.chunks.is_empty() => t.resume(generation),
            _ => {
                let mut t = Track::new(generation, generation);
                if recovery {
                    t.resets = previous_resets;
                    t.duration = previous_duration;
                }
                state.tracks.insert(video_id.into(), t);
            }
        }
        state.session = Some(Session {
            id: video_id.into(),
            generation,
            label: label.clone(),
            foreground,
            ticket,
        });
        state.trim(video_id);
        old
    };
    // Publicar la sustitución antes de esperar evita que un consumidor confunda el cierre
    // de una recuperación con una cancelación; el callback antiguo ya no es propietario.
    if let Some(old) = old {
        if let Err(error) = close_session(app, &old).await {
            let mut state = STATE.lock().unwrap();
            if let Some(t) = state.tracks.get_mut(video_id) {
                t.error = Some(error.clone());
            }
            // Conserva la ventana que no se pudo cerrar y no crea una segunda.
            if state.owns(video_id, generation) {
                state.session = Some(old);
            }
            return Err(error);
        }
    }
    let result = match request_current(ticket) {
        Ok(()) => create_window(app, video_id, generation, &label, at)
            .await
            .and_then(|_| request_current(ticket)),
        Err(e) => Err(e),
    };
    if let Err(e) = result {
        fail_session(video_id, generation, &e);
        let old = {
            let mut state = STATE.lock().unwrap();
            if state.owns(video_id, generation) {
                state.session.take()
            } else {
                None
            }
        };
        if let Some(s) = old {
            let _ = close_session(app, &s).await;
        }
        return Err(e);
    }
    Ok(generation)
}

async fn create_window(
    app: &AppHandle,
    video_id: &str,
    generation: u64,
    label: &str,
    at: Option<f64>,
) -> Result<(), String> {
    let start = at.map(|s| format!("#musify-t={s:.1}")).unwrap_or_default();
    let url = format!("https://music.youtube.com/watch?v={video_id}{start}");
    let target = serde_json::to_string(video_id).map_err(|e| e.to_string())?;
    let script = format!(
        "Object.defineProperty(window,'__musifyGeneration',{{value:{generation},writable:false}});Object.defineProperty(window,'__musifyTarget',{{value:{target},writable:false}});\n{}",
        crate::extractors::capture_script()
    );
    let profile = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("yt-engine");
    let window = WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::External("about:blank".parse().unwrap()),
    )
    .title("Musify · reproductor de YouTube")
    .data_directory(profile)
    .visible(std::env::var("MUSIFY_SHOW_ENGINE").is_ok())
    .skip_taskbar(true)
    .focused(false)
    .inner_size(960.0, 640.0)
    .initialization_script(script)
    .build()
    .map_err(|e| format!("CAPTURE_WINDOW: {e}"))?;
    let id = video_id.to_string();
    let (tx, rx) = tokio::sync::oneshot::channel();
    window
        .with_webview(move |pw| {
            #[cfg(windows)]
            let result = unsafe { attach(&pw, &url, &id, generation) }
                .map_err(|e| format!("CAPTURE_BRIDGE: {e}"));
            #[cfg(not(windows))]
            let result: Result<(), String> = {
                let _ = (pw, url, id, generation);
                Err("CAPTURE_UNSUPPORTED_PLATFORM".into())
            };
            let _ = tx.send(result);
        })
        .map_err(|e| format!("CAPTURE_BRIDGE: {e}"))?;
    tokio::time::timeout(Duration::from_secs(10), rx)
        .await
        .map_err(|_| "CAPTURE_BRIDGE_TIMEOUT".to_string())?
        .map_err(|_| "CAPTURE_BRIDGE_CLOSED".to_string())?
}

#[cfg(windows)]
unsafe fn attach(
    pw: &tauri::webview::PlatformWebview,
    url: &str,
    id: &str,
    generation: u64,
) -> windows_core::Result<()> {
    use webview2_com::{WebMessageReceivedEventHandler, take_pwstr};
    use windows_core::{HSTRING, PWSTR};
    let id = id.to_string();
    unsafe {
        let controller = pw.controller();
        let core = controller.CoreWebView2()?;
        let handler = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut source = PWSTR::null();
            args.Source(&mut source)?;
            let source = take_pwstr(source);
            let mut text = PWSTR::null();
            if args.TryGetWebMessageAsString(&mut text).is_ok() {
                let text = take_pwstr(text);
                if let Some(json) = text.strip_prefix("musify:") {
                    receive(&id, generation, &source, json);
                }
            }
            Ok(())
        }));
        let mut token = 0i64;
        core.add_WebMessageReceived(&handler, &mut token)?;
        controller.SetIsVisible(true)?;
        core.Navigate(&HSTRING::from(url))
    }
}

#[derive(Deserialize)]
struct Message {
    musify: u8,
    v: Option<String>,
    generation: Option<u64>,
    sequence: Option<u64>,
    kind: String,
    mime: Option<String>,
    classification: Option<String>,
    source: Option<u64>,
    s: Option<u64>,
    ad: Option<bool>,
    data: Option<String>,
    #[serde(rename = "type")]
    event: Option<String>,
    state: Option<String>,
    #[serde(rename = "bytesQuarantined")]
    bytes_quarantined: Option<u64>,
    verified: Option<bool>,
    #[serde(
        default,
        rename = "timelineSettings",
        deserialize_with = "present_json"
    )]
    timeline_settings: Option<serde_json::Value>,
    frames: Option<u64>,
    #[serde(rename = "rangeStart")]
    range_start: Option<f64>,
    #[serde(rename = "rangeEnd")]
    range_end: Option<f64>,
    duration: Option<f64>,
    title: Option<String>,
    author: Option<String>,
    reason: Option<String>,
    code: Option<String>,
    why: Option<String>,
    position: Option<f64>,
}

fn source_kind(source: &str) -> Option<bool> {
    let url = reqwest::Url::parse(source).ok()?;
    if url.scheme() != "https" || url.port_or_known_default() != Some(443) {
        return None;
    }
    match url.host_str()? {
        "music.youtube.com" => Some(true),
        "consent.youtube.com" => Some(false),
        _ => None,
    }
}

/// Los tests proporcionan su propio supervisor, sin contaminar el estado de la app.
fn apply_message(
    state: &mut Supervisor,
    id: &str,
    generation: u64,
    source: &str,
    m: Message,
    now: Instant,
) -> bool {
    let Some(music) = source_kind(source) else {
        return false;
    };
    if !state.owns(id, generation)
        || m.musify != 1
        || m.v.as_deref() != Some(id)
        || m.generation != Some(generation)
    {
        return false;
    }
    let Some(sequence) = m.sequence else {
        return false;
    };
    let Some(t) = state
        .tracks
        .get_mut(id)
        .filter(|t| t.generation == generation)
    else {
        return false;
    };
    if t.sequence.is_some_and(|previous| sequence <= previous) {
        return false;
    }
    t.sequence = Some(sequence);
    t.last_msg = now;
    if t.error.is_some() || t.done_ms.is_some() {
        return false;
    }
    let ms = t.ms();
    #[cfg(debug_assertions)]
    let previous = (t.phase.clone(), t.error.clone());
    #[cfg(debug_assertions)]
    let previous_ad_credit_step = t.ad_wait_credit.as_secs() / 15;
    #[cfg(debug_assertions)]
    let event = m.event.clone();
    let mut finished = false;
    let says_content = m.state.as_deref() == Some("content");
    let says_ad = m.state.as_deref() == Some("ad");
    let excludes_content = m.state.as_deref().is_some_and(|state| state != "content");
    match m.kind.as_str() {
        "seg" if music => {
            if m.ad == Some(true) || m.classification.as_deref() == Some("ad") {
                t.ads += 1;
                return false;
            }
            if m.classification.as_deref() != Some("content")
                || t.phase != "content"
                || !t.verified
                || m.source != t.verified_source
                || m.s != t.verified_buffer
            {
                t.unknown += 1;
                return false;
            }
            let Some(mime) = m.mime.filter(|mime| mime.starts_with("audio/")) else {
                return false;
            };
            let Some(data) = m.data else { return false };
            if data.len() > MAX_SEGMENT_BYTES.div_ceil(3) * 4 {
                t.error = Some("CAPTURE_CAPACITY: segmento demasiado grande".into());
                return false;
            }
            let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) else {
                return false;
            };
            if bytes.is_empty() {
                return false;
            }
            if t.bytes.saturating_add(bytes.len()) > MAX_BYTES {
                t.error = Some("CAPTURE_CAPACITY: audio excede el límite de memoria".into());
                return false;
            }
            if t.mime.is_empty() {
                t.mime = mime.clone();
            }
            t.bytes += bytes.len();
            t.chunks.push(bytes);
            t.mimes.push(mime);
            t.first_ms.get_or_insert(ms);
            t.last_progress = now;
        }
        "event" => {
            if m.event.as_deref() == Some("diagnostic") {
                if let Some(reason) = m.reason.as_deref() {
                    t.last_diagnostic = Some(reason.chars().take(2048).collect());
                }
            }
            if let Some(phase) = m.state.filter(|s| {
                matches!(
                    s.as_str(),
                    "unknown" | "content" | "ad" | "ambiguous" | "interaction"
                )
            }) {
                t.phase = phase;
                if t.phase != "content" {
                    t.verified = false;
                }
                if t.phase != "ad" {
                    t.ad_observation = None;
                }
            }
            if m.source.is_some() && m.source != t.verified_source {
                t.verified = false;
            }
            if m.verified == Some(true)
                && t.phase == "content"
                && m.event.as_deref() == Some("diagnostic")
            {
                t.verified = false;
                t.timeline_settings = None;
                if let (Some(source), Some(buffer), Some(frames), Some(start), Some(end)) =
                    (m.source, m.s, m.frames, m.range_start, m.range_end)
                {
                    if frames > 0
                        && start.is_finite()
                        && start >= 0.0
                        && end.is_finite()
                        && end > start
                    {
                        if let Some(settings) = TimelineSettings::from_message(m.timeline_settings)
                        {
                            t.verified = true;
                            t.verified_source = Some(source);
                            t.verified_buffer = Some(buffer);
                            t.timeline_settings = Some(settings);
                            t.frames = frames;
                            t.range_start = Some(start);
                            t.range_end = Some(end);
                        }
                    }
                }
            }
            if let Some(bytes) = m.bytes_quarantined {
                if bytes > t.quarantined && t.phase != "ad" {
                    t.last_progress = now;
                }
                t.quarantined = bytes;
            }
            let content_metadata = says_content
                || (!excludes_content
                    && (matches!(m.event.as_deref(), Some("playing" | "meta"))
                        || (m.event.as_deref() == Some("diagnostic")
                            && m.verified == Some(true)
                            && t.verified)));
            if music && content_metadata {
                t.duration = m
                    .duration
                    .filter(|d| d.is_finite() && *d > 0.0)
                    .or(t.duration);
                if let Some(title) = m.title.filter(|s| !s.is_empty()) {
                    t.title = title;
                }
                if let Some(author) = m.author.filter(|s| !s.is_empty()) {
                    t.author = author;
                }
            }
            match m.event.as_deref() {
                Some("playing") if music => {
                    t.playing_ms.get_or_insert(ms);
                }
                Some("meta") if music => {
                    t.meta_ms.get_or_insert(ms);
                }
                Some("ended") if music => {
                    if t.bytes == 0
                        || t.phase != "content"
                        || !t.verified
                        || m.source != t.verified_source
                        || m.s != t.verified_buffer
                    {
                        t.error = Some(
                            "CAPTURE_IDENTITY_UNCERTAIN: terminó sin audio de contenido verificado"
                                .into(),
                        );
                    } else {
                        t.done_ms = Some(ms);
                        t.why = m.why;
                        finished = true;
                    }
                }
                Some("error") => {
                    let reason = m
                        .reason
                        .unwrap_or_else(|| "YouTube no puede reproducirla".into());
                    t.error = Some(match m.code {
                        Some(code) if !reason.starts_with(&code) => format!("{code}: {reason}"),
                        _ => reason,
                    });
                }
                Some("interaction") => {
                    t.phase = "interaction".into();
                    t.error = Some(format!(
                        "CAPTURE_REQUIRES_INTERACTION: {}",
                        m.reason
                            .unwrap_or_else(|| "Abre YouTube para continuar".into())
                    ));
                }
                Some("progress" | "diagnostic") if music => {
                    if let Some(position) = m.position.filter(|p| p.is_finite() && *p >= 0.0) {
                        let advances = if t.phase == "ad" {
                            says_ad
                                && m.event.as_deref() == Some("diagnostic")
                                && m.source.is_some_and(|source| {
                                    t.observe_ad_progress(source, position, now)
                                })
                        } else {
                            position > t.position + 0.05
                        };
                        if advances {
                            t.last_progress = now;
                        }
                        t.position = position;
                    }
                }
                _ => {}
            }
        }
        _ => {}
    }
    #[cfg(debug_assertions)]
    if previous.0 != t.phase
        || previous.1 != t.error
        || previous_ad_credit_step != t.ad_wait_credit.as_secs() / 15
        || matches!(event.as_deref(), Some("playing" | "ended" | "interaction"))
    {
        let code = t
            .error
            .as_deref()
            .and_then(|e| e.split(':').next())
            .unwrap_or("");
        let code = if code.starts_with("CAPTURE_")
            && code
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
        {
            code
        } else {
            ""
        };
        let event = match event.as_deref() {
            Some(
                event @ ("playing" | "ended" | "interaction" | "diagnostic" | "progress" | "meta"
                | "error"),
            ) => event,
            _ => "unknown",
        };
        eprintln!(
            "[captura] {id} generation={generation} state={} event={} code={code} frames={} bytes={} position={:.3} adWaitMs={} waitBudgetMs={}",
            t.phase,
            event,
            t.frames,
            t.bytes,
            t.position,
            t.ad_wait_credit.as_millis(),
            t.wait_budget().as_millis()
        );
        if event == "error" && !code.is_empty() {
            if let Some(reason) = t.error.as_deref().filter(|reason| !reason.contains("://")) {
                let detail: String = reason.chars().take(2048).collect();
                eprintln!(
                    "[captura] {id} generation={generation} reason={}",
                    detail.replace(['\r', '\n'], " ")
                );
            }
        }
    }
    finished
}

fn receive(id: &str, generation: u64, source: &str, data: &str) {
    if source_kind(source).is_none() {
        return;
    }
    if data.len() > MAX_SEGMENT_BYTES.div_ceil(3) * 4 + 16 * 1024 {
        fail_session(id, generation, "CAPTURE_CAPACITY: mensaje demasiado grande");
        return;
    }
    let Ok(message) = serde_json::from_str(data) else {
        return;
    };
    let finished = apply_message(
        &mut STATE.lock().unwrap(),
        id,
        generation,
        source,
        message,
        Instant::now(),
    );
    if finished {
        close_when_idle(id.to_string(), generation);
    }
}
fn fail_session(id: &str, generation: u64, reason: &str) {
    let mut state = STATE.lock().unwrap();
    if state.owns(id, generation)
        && let Some(t) = state.tracks.get_mut(id)
    {
        t.error = Some(reason.into());
    }
}

fn watchdog(app: &AppHandle) {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::Relaxed) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let _guard = TRANSITION.lock().await;
            let action = {
                let mut state = STATE.lock().unwrap();
                let Some(session) = state.session.clone() else {
                    continue;
                };
                let Some(t) = state.tracks.get_mut(&session.id) else {
                    continue;
                };
                if let Err(error) = request_current(session.ticket) {
                    t.error = Some(error);
                    t.phase = "cancelled".into();
                }
                // El usuario necesita esta misma ventana para iniciar sesión o resolver el reto.
                if t.phase == "interaction" {
                    continue;
                }
                if t.error.is_some() {
                    Some((session, false))
                } else if t.stalled(Instant::now()) {
                    if t.resets >= MAX_RESETS || !t.chunks.is_empty() {
                        t.error = Some("CAPTURE_STALLED: el reproductor dejó de avanzar".into());
                        Some((session, false))
                    } else {
                        t.resets += 1;
                        Some((session, true))
                    }
                } else {
                    None
                }
            };
            let Some((session, restart)) = action else {
                continue;
            };
            if restart {
                // La cuarentena requiere empezar desde cero; nunca mezcla sesiones parciales.
                let _ = open_locked(
                    &app,
                    &session.id,
                    None,
                    true,
                    session.foreground,
                    session.ticket,
                )
                .await;
            } else {
                let old = {
                    let mut state = STATE.lock().unwrap();
                    if state.owns(&session.id, session.generation) {
                        state.session.take()
                    } else {
                        None
                    }
                };
                if let Some(old) = old {
                    let _ = close_session(&app, &old).await;
                }
            }
        }
    });
}

fn close_when_idle(id: String, generation: u64) {
    let Some(app) = APP.get().cloned() else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let _guard = TRANSITION.lock().await;
        let old = {
            let mut state = STATE.lock().unwrap();
            if state.owns(&id, generation)
                && state.tracks.get(&id).is_some_and(|t| t.done_ms.is_some())
            {
                state.session.take()
            } else {
                None
            }
        };
        if let Some(old) = old {
            let _ = close_session(&app, &old).await;
        }
    });
}

async fn close_session(app: &AppHandle, session: &Session) -> Result<(), String> {
    let result = close_window(app, &session.label).await;
    if let Err(error) = &result {
        let mut state = STATE.lock().unwrap();
        if state.session.is_none() {
            state.session = Some(session.clone());
        }
        if let Some(t) = state
            .tracks
            .get_mut(&session.id)
            .filter(|t| t.generation == session.generation)
        {
            t.error.get_or_insert_with(|| error.clone());
        }
    }
    result
}

async fn close_window(app: &AppHandle, label: &str) -> Result<(), String> {
    let Some(window) = app.get_webview_window(label) else {
        return Ok(());
    };
    let _ = window.navigate("about:blank".parse().unwrap());
    tokio::time::sleep(Duration::from_millis(300)).await;
    let _ = window.destroy();
    for _ in 0..50 {
        if app.get_webview_window(label).is_none() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err("CAPTURE_WINDOW_CLOSE: la ventana anterior no se pudo cerrar".into())
}

async fn cancel(app: &AppHandle, id: &str, generation: Option<u64>) -> Result<(), String> {
    cancel_matching(app, id, generation, None).await
}

async fn cancel_matching(
    app: &AppHandle,
    id: &str,
    generation: Option<u64>,
    before: Option<u64>,
) -> Result<(), String> {
    let _guard = TRANSITION.lock().await;
    {
        let mut state = STATE.lock().unwrap();
        if !state.can_cancel(id, generation, before) {
            return Ok(());
        }
        *state.cancellations.entry(id.into()).or_default() += 1;
    }
    let old = {
        let mut state = STATE.lock().unwrap();
        if state
            .session
            .as_ref()
            .is_some_and(|s| s.id == id && generation.is_none_or(|g| g == s.generation))
        {
            if let Some(t) = state.tracks.get_mut(id) {
                t.mark_cancelled();
            }
            state.session.take()
        } else {
            None
        }
    };
    if let Some(old) = old {
        return close_session(app, &old).await;
    }
    Ok(())
}
#[tauri::command]
pub async fn capture_cancel(
    app: AppHandle,
    video_id: String,
    generation: Option<u64>,
) -> Result<(), String> {
    if !valid_id(&video_id) {
        return Err("id de vídeo no válido".into());
    }
    cancel(&app, &video_id, generation).await
}

/// La comprobación se repite bajo TRANSITION para proteger también una promoción que conserva
/// la generación. Los benchmarks sin ticket no pertenecen a la cola de resolución del usuario.
pub async fn cancel_before(app: &AppHandle, ticket: u64) -> Result<(), String> {
    let session = STATE
        .lock()
        .unwrap()
        .session
        .clone()
        .filter(|session| session.ticket.is_some_and(|current| current < ticket));
    if let Some(session) = session {
        cancel_matching(app, &session.id, Some(session.generation), Some(ticket)).await
    } else {
        Ok(())
    }
}
#[tauri::command]
pub async fn capture_show(app: AppHandle) -> Result<(), String> {
    supported()?;
    let _guard = TRANSITION.lock().await;
    let label = STATE
        .lock()
        .unwrap()
        .session
        .as_ref()
        .map(|s| s.label.clone())
        .ok_or("No hay captura activa")?;
    let window = app
        .get_webview_window(&label)
        .ok_or("No hay ventana de captura")?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn capture_seek(app: AppHandle, video_id: String, at: f64) -> Result<(), String> {
    supported()?;
    if !valid_id(&video_id) || !at.is_finite() || at < 0.0 {
        return Err("salto no válido".into());
    }
    let _guard = TRANSITION.lock().await;
    {
        let mut state = STATE.lock().unwrap();
        let capturing = state.session.as_ref().is_some_and(|s| s.id == video_id);
        if let Some(t) = state.tracks.get_mut(&video_id) {
            if t.replay_complete(SEQ.fetch_add(1, Ordering::Relaxed)) {
                return Ok(());
            }
            // El gate ya observó la presentación completa o sigue haciéndolo. El lector espera
            // los bytes de destino; nunca salta el reproductor oficial y rompe su cobertura.
            if t.error.is_none() && (t.verified || capturing) {
                return Ok(());
            }
        }
    }
    open_locked(
        &app,
        &video_id,
        None,
        false,
        true,
        Some(crate::player::begin_resolution(false)),
    )
    .await
    .map(|_| ())
}

fn read_bounds(t: &Track, from: usize, revision: Option<u64>) -> (usize, usize, bool) {
    let reset = revision.is_some_and(|revision| revision != t.revision) || from > t.chunks.len();
    let start = if reset { 0 } else { from };
    let mut end = start;
    let mut bytes = 0;
    for chunk in t.chunks.iter().skip(start).take(READ_CHUNKS) {
        if end > start && bytes + chunk.len() > READ_BYTES {
            break;
        }
        bytes += chunk.len();
        end += 1;
    }
    (start, end, reset)
}

/// Frame: u32 LE longitud JSON, JSON, y pares longitud u32 LE + bytes de cada chunk.
#[tauri::command]
pub async fn capture_read(
    video_id: String,
    from: usize,
    revision: Option<u64>,
) -> Result<tauri::ipc::Response, String> {
    let deadline = Instant::now() + Duration::from_millis(1500);
    loop {
        {
            let mut state = STATE.lock().unwrap();
            let t = state
                .tracks
                .get_mut(&video_id)
                .ok_or("No hay captura de esa canción")?;
            t.last_read = Some(Instant::now());
            t.used = Instant::now();
            let (start, end, reset) = read_bounds(t, from, revision);
            if end > start
                || reset
                || t.done_ms.is_some()
                || t.error.is_some()
                || Instant::now() > deadline
            {
                let chunks = &t.chunks[start..end];
                let head = json!({ "mime": t.mime, "mimes": &t.mimes[start..end], "duration": t.duration,
                    "timelineSettings": t.timeline_settings,
                    "done": t.done_ms.is_some() && end == t.chunks.len(), "error": t.error,
                    "revision": t.revision, "generation": t.generation, "reset": reset, "from": start, "next": end }).to_string();
                let mut out = Vec::with_capacity(
                    4 + head.len() + chunks.iter().map(|c| c.len() + 4).sum::<usize>(),
                );
                out.extend((head.len() as u32).to_le_bytes());
                out.extend(head.as_bytes());
                for chunk in chunks {
                    out.extend((chunk.len() as u32).to_le_bytes());
                    out.extend(chunk);
                }
                return Ok(tauri::ipc::Response::new(out));
            }
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

pub fn status(video_id: &str) -> Option<serde_json::Value> {
    let state = STATE.lock().unwrap();
    let t = state.tracks.get(video_id)?;
    Some(
        json!({ "mime": t.mime, "chunks": t.chunks.len(), "bytes": t.bytes, "ads": t.ads,
        "unknown": t.unknown, "state": t.phase, "bytesQuarantined": t.quarantined,
        "verified": t.verified, "frames": t.frames, "rangeStart": t.range_start, "rangeEnd": t.range_end,
        "verifiedSource": t.verified_source, "verifiedBuffer": t.verified_buffer,
        "timelineSettings": t.timeline_settings,
        "duration": t.duration, "firstMs": t.first_ms, "playingMs": t.playing_ms, "metaMs": t.meta_ms,
        "title": t.title, "doneMs": t.done_ms, "error": t.error, "why": t.why, "resets": t.resets,
        "lastDiagnostic": t.last_diagnostic,
        "lastPosition": t.position, "adWaitMs": t.ad_wait_credit.as_millis(),
        "lastProgressAgoMs": t.last_progress.elapsed().as_millis(), "waitBudgetMs": t.wait_budget().as_millis(),
        "generation": t.generation, "revision": t.revision }),
    )
}
fn valid_id(id: &str) -> bool {
    id.len() == 11
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "aaaaaaaaaaa";
    const SOURCE: &str = "https://music.youtube.com/watch?v=aaaaaaaaaaa";
    fn state() -> Supervisor {
        let mut state = Supervisor::default();
        state.session = Some(Session {
            id: ID.into(),
            generation: 10,
            label: "test-10".into(),
            foreground: true,
            ticket: None,
        });
        state.tracks.insert(ID.into(), Track::new(5, 10));
        state
    }
    fn message(sequence: u64, fields: serde_json::Value) -> Message {
        let mut value = json!({ "musify":1, "v":ID, "generation":10, "sequence":sequence });
        value
            .as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        serde_json::from_value(value).unwrap()
    }
    fn content(sequence: u64) -> Message {
        message(
            sequence,
            json!({ "kind":"seg", "classification":"content", "source":7, "s":3, "mime":"audio/webm", "data":"GkXfow==" }),
        )
    }
    fn apply(state: &mut Supervisor, message: Message) -> bool {
        apply_message(state, ID, 10, SOURCE, message, Instant::now())
    }

    #[test]
    fn rejects_obsolete_windows_and_unproven_audio() {
        let mut state = state();
        apply(&mut state, content(1));
        assert_eq!(state.tracks[ID].bytes, 0);
        apply(
            &mut state,
            message(
                2,
                json!({"kind":"event","type":"diagnostic","state":"content","source":7,"s":3,"verified":true,"frames":4,"rangeStart":0.0,"rangeEnd":0.08}),
            ),
        );
        apply_message(&mut state, ID, 9, SOURCE, content(3), Instant::now());
        let mut wrong = content(3);
        wrong.generation = Some(9);
        apply(&mut state, wrong);
        let mut wrong = content(3);
        wrong.v = Some("bbbbbbbbbbb".into());
        apply(&mut state, wrong);
        apply_message(
            &mut state,
            ID,
            10,
            "https://consent.youtube.com/",
            content(3),
            Instant::now(),
        );
        apply_message(
            &mut state,
            ID,
            10,
            "https://music.youtube.com.evil.test/",
            content(4),
            Instant::now(),
        );
        assert_eq!(state.tracks[ID].bytes, 0);
        apply(&mut state, content(4));
        apply(&mut state, content(4));
        apply(&mut state, content(2));
        assert_eq!(state.tracks[ID].chunks, vec![vec![0x1a, 0x45, 0xdf, 0xa3]]);
        let mut ad = content(5);
        ad.ad = Some(true);
        apply(&mut state, ad);
        assert_eq!(
            (state.tracks[ID].chunks.len(), state.tracks[ID].ads),
            (1, 1)
        );
    }

    #[test]
    fn observed_content_cannot_authorize_another_source_or_buffer() {
        let mut state = state();
        apply(
            &mut state,
            message(
                1,
                json!({"kind":"event","type":"diagnostic","state":"content","source":7,"s":3}),
            ),
        );
        apply(&mut state, content(2));
        assert_eq!(state.tracks[ID].bytes, 0);
        // Incluso verified requiere una cobertura concreta y válida.
        apply(
            &mut state,
            message(
                3,
                json!({"kind":"event","type":"diagnostic","state":"content","source":7,"s":3,"verified":true,"frames":4,"rangeStart":2.0,"rangeEnd":1.0}),
            ),
        );
        apply(&mut state, content(4));
        assert_eq!(state.tracks[ID].bytes, 0);
        apply(
            &mut state,
            message(
                5,
                json!({"kind":"event","type":"diagnostic","state":"content","source":7,"s":3,"verified":true,"frames":4,"rangeStart":0.0,"rangeEnd":0.08}),
            ),
        );
        let mut wrong = content(6);
        wrong.source = Some(8);
        apply(&mut state, wrong);
        let mut wrong = content(7);
        wrong.s = Some(4);
        apply(&mut state, wrong);
        assert_eq!(state.tracks[ID].bytes, 0);
        apply(&mut state, content(8));
        assert_eq!(state.tracks[ID].bytes, 4);
        assert!(!apply(
            &mut state,
            message(9, json!({"kind":"event","type":"ended","source":8,"s":3}))
        ));
        assert!(state.tracks[ID].done_ms.is_none());
    }
    #[test]
    fn heartbeat_alone_does_not_hide_audio_stall() {
        let mut state = state();
        let old = Instant::now() - Duration::from_secs(70);
        state.tracks.get_mut(ID).unwrap().last_progress = old;
        apply(
            &mut state,
            message(1, json!({"kind":"event","type":"progress","position":0})),
        );
        assert!(state.tracks[ID].stalled(Instant::now()));
        apply(
            &mut state,
            message(
                2,
                json!({"kind":"event","type":"diagnostic","bytesQuarantined":2048}),
            ),
        );
        assert!(!state.tracks[ID].stalled(Instant::now()));
    }

    #[test]
    fn moving_advertisement_earns_bounded_time_without_becoming_song_metadata() {
        let mut state = state();
        let start = Instant::now();
        for second in 0..=150 {
            apply_message(
                &mut state,
                ID,
                10,
                SOURCE,
                message(
                    second + 1,
                    json!({"kind":"event","type":"diagnostic",
                    "state":"ad","source":7,"position":second,"duration":300,"title":"Ad"}),
                ),
                start + Duration::from_secs(second),
            );
        }
        let t = &state.tracks[ID];
        assert_eq!(t.ad_wait_credit, Duration::from_secs(150));
        assert_eq!(t.wait_budget(), Duration::from_secs(270));
        assert!(!t.stalled(start + Duration::from_secs(151)));
        assert_eq!(t.duration, None);
        assert!(t.title.is_empty());
        assert!(!t.ready());
        assert!(!t.verified);
        apply_message(
            &mut state,
            ID,
            10,
            SOURCE,
            message(
                152,
                json!({"kind":"event","type":"diagnostic",
                "state":"content","source":8,"position":0,"duration":100}),
            ),
            start + Duration::from_secs(151),
        );
        let t = &state.tracks[ID];
        assert!(t.ad_observation.is_none());
        assert_eq!(t.wait_budget(), Duration::from_secs(370));
    }

    #[test]
    fn ad_heartbeats_and_downloaded_bytes_cannot_hide_a_frozen_clock() {
        let mut state = state();
        let start = Instant::now();
        state.tracks.get_mut(ID).unwrap().last_progress = start;
        for second in 0..=60 {
            apply_message(
                &mut state,
                ID,
                10,
                SOURCE,
                message(
                    second + 1,
                    json!({"kind":"event","type":"diagnostic",
                    "state":"ad","source":7,"position":5,"bytesQuarantined":second*1000}),
                ),
                start + Duration::from_secs(second),
            );
        }
        let t = &state.tracks[ID];
        assert_eq!(t.ad_wait_credit, Duration::ZERO);
        assert_eq!(t.wait_budget(), Duration::from_secs(120));
        assert!(t.stalled(start + PROGRESS_STALL));
        assert_eq!(t.last_msg, start + Duration::from_secs(60));
    }

    #[test]
    fn ad_skip_source_changes_and_unobserved_intervals_buy_no_wait_credit() {
        let mut t = Track::new(1, 1);
        let start = Instant::now();
        assert!(!t.observe_ad_progress(1, 0.0, start));
        assert!(!t.observe_ad_progress(1, 100.0, start + Duration::from_secs(1)));
        assert!(!t.observe_ad_progress(2, 101.0, start + Duration::from_secs(2)));
        assert!(!t.observe_ad_progress(2, 0.0, start + Duration::from_secs(3)));
        assert!(!t.observe_ad_progress(2, 0.0, start + Duration::from_secs(4)));
        assert!(!t.observe_ad_progress(2, 20.0, start + Duration::from_secs(24)));
        assert_eq!(t.ad_wait_credit, Duration::ZERO);
        assert!(t.observe_ad_progress(2, 21.2, start + Duration::from_secs(25)));
        assert_eq!(t.ad_wait_credit, Duration::from_secs(1));
    }

    #[test]
    fn ad_wait_credit_cannot_make_an_endless_ad_session_or_survive_resume() {
        let mut t = Track::new(1, 1);
        let start = Instant::now();
        for second in 0..=600 {
            t.observe_ad_progress(7, second as f64, start + Duration::from_secs(second));
        }
        assert_eq!(t.ad_wait_credit, MAX_AD_WAIT_CREDIT);
        assert_eq!(t.wait_budget(), Duration::from_secs(300));
        t.duration = Some(1190.0);
        assert_eq!(t.wait_budget(), MAX_WAIT);
        t.resume(2);
        assert_eq!(t.ad_wait_credit, Duration::ZERO);
        assert!(t.ad_observation.is_none());
    }

    #[test]
    fn latest_diagnostic_reason_is_bounded_separate_from_terminal_reason_and_reset() {
        let mut state = state();
        apply(
            &mut state,
            message(
                1,
                json!({"kind":"event","type":"diagnostic",
            "state":"ad","reason":"paused=true readyState=2 visible=false"}),
            ),
        );
        assert_eq!(
            state.tracks[ID].last_diagnostic.as_deref(),
            Some("paused=true readyState=2 visible=false")
        );
        apply(
            &mut state,
            message(2, json!({"kind":"event","type":"diagnostic","state":"ad"})),
        );
        assert!(state.tracks[ID].last_diagnostic.is_some());
        let reason = "ñ".repeat(3000);
        apply(
            &mut state,
            message(
                3,
                json!({"kind":"event","type":"diagnostic","reason":reason}),
            ),
        );
        let t = state.tracks.get_mut(ID).unwrap();
        assert_eq!(t.last_diagnostic.as_ref().unwrap().chars().count(), 2048);
        assert!(t.why.is_none());
        t.mark_cancelled();
        assert!(
            t.last_diagnostic.is_some(),
            "a timeout/cancellation must retain the evidence"
        );
        t.resume(11);
        assert!(t.last_diagnostic.is_none());
    }

    #[test]
    fn postroll_and_unknown_observations_do_not_replace_song_metadata() {
        let mut state = state();
        apply(
            &mut state,
            message(
                1,
                json!({"kind":"event","type":"diagnostic","state":"ad","duration":11.621,"title":"Anuncio","author":"Marca"}),
            ),
        );
        assert_eq!(state.tracks[ID].duration, None);
        apply(
            &mut state,
            message(
                2,
                json!({"kind":"event","type":"playing","duration":288.0,"title":"Airbag","author":"Radiohead"}),
            ),
        );
        for (sequence, phase) in [(3, "ad"), (4, "unknown"), (5, "ambiguous")] {
            apply(
                &mut state,
                message(
                    sequence,
                    json!({"kind":"event","type":"diagnostic","state":phase,"duration":11.621,"title":"Anuncio","author":"Marca"}),
                ),
            );
        }
        let t = &state.tracks[ID];
        assert_eq!(t.duration, Some(288.0));
        assert_eq!(t.title, "Airbag");
        assert_eq!(t.author, "Radiohead");
        assert_eq!(t.wait_budget(), Duration::from_secs(408));
    }

    #[test]
    fn cancellation_preserves_the_timeout_cause() {
        let mut t = Track::new(1, 1);
        t.error = Some("CAPTURE_TIMEOUT: no hubo una presentación completa".into());
        t.mark_cancelled();
        assert_eq!(
            t.error.as_deref(),
            Some("CAPTURE_TIMEOUT: no hubo una presentación completa")
        );
        let mut pending = Track::new(2, 2);
        pending.mark_cancelled();
        assert!(
            pending
                .error
                .as_deref()
                .unwrap()
                .starts_with("CAPTURE_CANCELLED")
        );
    }

    #[test]
    fn interaction_reports_action_without_treating_window_as_stalled() {
        let mut state = state();
        apply(
            &mut state,
            message(
                1,
                json!({"kind":"event","type":"interaction","reason":"Inicia sesión"}),
            ),
        );
        let t = &state.tracks[ID];
        assert_eq!(t.phase, "interaction");
        assert!(
            t.error
                .as_deref()
                .unwrap()
                .starts_with("CAPTURE_REQUIRES_INTERACTION")
        );
        assert!(!t.stalled(Instant::now() + MAX_WAIT));
        assert!(state.owns(ID, 10));
    }

    #[test]
    fn prefetch_waits_for_quarantine_and_foreground_can_replace_it() {
        let mut state = state();
        state.session.as_mut().unwrap().foreground = false;
        state.tracks.get_mut(ID).unwrap().session_started =
            Instant::now() - Duration::from_secs(180);
        // Ningún lector existe todavía: la cuarentena no ha terminado.
        assert_eq!(
            state.request("bbbbbbbbbbb", false, false),
            StartDecision::Wait
        );
        assert_eq!(state.request(ID, false, true), StartDecision::Join(10));
        assert!(state.session.as_ref().unwrap().foreground);
        assert_eq!(
            state.request("bbbbbbbbbbb", false, true),
            StartDecision::Start
        );
        state.tracks.get_mut(ID).unwrap().done_ms = Some(180_000);
        assert_eq!(
            state.request("bbbbbbbbbbb", false, false),
            StartDecision::Start
        );
    }

    #[test]
    fn ready_prefetch_adopts_foreground_ticket_before_returning_cached_audio() {
        for done in [None, Some(180_000)] {
            let mut state = state();
            let session = state.session.as_mut().unwrap();
            session.foreground = false;
            session.ticket = Some(4);
            let t = state.tracks.get_mut(ID).unwrap();
            t.first_ms = Some(179_000);
            t.done_ms = done;
            t.chunks = vec![vec![1, 2, 3]];
            let (decision, cached) = state.prepare(ID, false, true, Some(5));
            assert!(cached.is_some(), "ready audio must remain available");
            assert_eq!(decision, StartDecision::Join(10));
            let session = state.session.as_ref().unwrap();
            assert!(session.foreground);
            assert_eq!(session.ticket, Some(5));
            assert!(!state.can_cancel(ID, Some(10), Some(5)));
            assert_eq!(state.tracks[ID].chunks, vec![vec![1, 2, 3]]);
            assert_eq!(state.tracks[ID].revision, 5);
        }
        // Reproducir otra entrada de caché no promociona la ventana de un vídeo distinto.
        let mut state = state();
        state.session.as_mut().unwrap().ticket = Some(4);
        let mut other = Track::new(20, 20);
        other.first_ms = Some(1);
        other.done_ms = Some(2);
        state.tracks.insert("bbbbbbbbbbb".into(), other);
        assert!(
            state
                .prepare("bbbbbbbbbbb", false, true, Some(5))
                .1
                .is_some()
        );
        assert_eq!(state.session.as_ref().unwrap().ticket, Some(4));
    }

    #[test]
    fn revision_resets_cursor_but_window_resume_preserves_it() {
        let mut t = Track::new(5, 10);
        t.chunks = vec![vec![1], vec![2]];
        t.mimes = vec!["audio/webm".into(); 2];
        t.resume(11);
        assert_eq!(read_bounds(&t, 1, Some(5)), (1, 2, false));
        assert_eq!(t.generation, 11);
        let mut fresh = Track::new(12, 12);
        fresh.chunks = vec![vec![3]];
        assert_eq!(read_bounds(&fresh, 1, Some(5)), (0, 1, true));
        assert_eq!(read_bounds(&fresh, usize::MAX, None), (0, 1, true));
    }

    #[test]
    fn seek_replays_verified_cache_without_recapture_or_data_loss() {
        let mut t = Track::new(5, 10);
        t.chunks = vec![vec![1], vec![2]];
        t.mimes = vec!["audio/webm".into(); 2];
        t.duration = Some(180.0);
        t.done_ms = Some(180_000);
        t.verified = true;
        assert!(t.replay_complete(11));
        assert_eq!(read_bounds(&t, 2, Some(5)), (0, 2, true));
        assert_eq!(t.generation, 10);
        assert_eq!(t.duration, Some(180.0));
        assert_eq!(t.chunks, vec![vec![1], vec![2]]);
        t.verified = false;
        assert!(!t.replay_complete(12));
        assert_eq!(t.revision, 11);
    }

    #[test]
    fn cancellation_fence_preserves_new_and_promoted_sessions() {
        let mut state = state();
        state.session.as_mut().unwrap().ticket = Some(4);
        assert!(state.can_cancel(ID, Some(10), Some(5)));
        // Misma ventana promovida antes de adquirir TRANSITION.
        state.session.as_mut().unwrap().ticket = Some(5);
        assert!(!state.can_cancel(ID, Some(10), Some(5)));
        state.session.as_mut().unwrap().ticket = None;
        assert!(!state.can_cancel(ID, Some(10), Some(5)));
        assert!(!state.can_cancel(ID, Some(9), None));
        assert!(state.can_cancel(ID, Some(10), None));
    }

    #[test]
    fn invalid_timeline_settings_revoke_proof_and_reject_delivery() {
        let proof = json!({"kind":"event","type":"diagnostic","state":"content",
            "source":7,"s":3,"verified":true,"frames":4,"rangeStart":0.0,"rangeEnd":0.08});
        let valid = json!({"timestampOffset":-0.021,"appendWindowStart":0.0,
            "appendWindowEnd":null,"mode":"segments"});
        let mut invalid = vec![json!(null), json!({}), json!("default")];
        for (field, value) in [
            ("timestampOffset", json!(null)),
            ("timestampOffset", json!("Infinity")),
            ("appendWindowStart", json!(-0.1)),
            ("appendWindowStart", json!(null)),
            ("appendWindowEnd", json!(0)),
            ("appendWindowEnd", json!(-1)),
            ("appendWindowEnd", json!("Infinity")),
            ("mode", json!("sequence")),
        ] {
            let mut settings = valid.clone();
            settings[field] = value;
            invalid.push(settings);
        }
        let mut missing_end = valid;
        missing_end
            .as_object_mut()
            .unwrap()
            .remove("appendWindowEnd");
        invalid.push(missing_end);
        for settings in invalid {
            let mut state = state();
            // Un nuevo proof inválido debe revocar incluso el anterior de la misma fuente.
            apply(&mut state, message(1, proof.clone()));
            assert!(state.tracks[ID].verified);
            assert_eq!(
                state.tracks[ID].timeline_settings,
                Some(TimelineSettings::default())
            );
            let mut bad = proof.clone();
            bad["timelineSettings"] = settings.clone();
            apply(&mut state, message(2, bad));
            apply(&mut state, content(3));
            let t = &state.tracks[ID];
            assert!(!t.verified, "{settings}");
            assert!(t.timeline_settings.is_none(), "{settings}");
            assert_eq!(t.bytes, 0, "{settings}");
        }
    }

    #[test]
    fn timeline_settings_keep_infinity_and_survive_cached_replay() {
        let mut state = state();
        assert!(state.tracks[ID].timeline_settings.is_none());
        let settings = json!({"timestampOffset":-0.021333,"appendWindowStart":0.0,
            "appendWindowEnd":null,"mode":"segments"});
        apply(
            &mut state,
            message(
                1,
                json!({"kind":"event","type":"diagnostic",
            "state":"content","source":7,"s":3,"verified":true,"frames":4,
            "rangeStart":0.0,"rangeEnd":0.08,"timelineSettings":settings}),
            ),
        );
        apply(&mut state, content(2));
        assert!(apply(
            &mut state,
            message(
                3,
                json!({"kind":"event","type":"ended",
            "source":7,"s":3})
            )
        ));
        let t = state.tracks.get_mut(ID).unwrap();
        assert_eq!(
            serde_json::to_value(&t.timeline_settings).unwrap(),
            settings
        );
        assert_eq!(
            t.timeline_settings.as_ref().unwrap().append_window_end,
            None
        );
        assert!(t.replay_complete(11));
        assert_eq!(
            serde_json::to_value(&t.timeline_settings).unwrap(),
            settings
        );
        assert_eq!(read_bounds(t, 1, Some(5)), (0, 1, true));
        t.resume(12);
        assert!(t.timeline_settings.is_none());
        assert!(!t.verified);
    }

    #[test]
    fn timeline_settings_validate_finite_clocks_without_arbitrary_limits() {
        let settings = TimelineSettings {
            timestamp_offset: -1e12,
            append_window_start: 1e12,
            append_window_end: Some(2e12),
            ..Default::default()
        };
        assert!(settings.valid());
        for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert!(
                !TimelineSettings {
                    timestamp_offset: value,
                    ..settings.clone()
                }
                .valid()
            );
            assert!(
                !TimelineSettings {
                    append_window_start: value,
                    ..settings.clone()
                }
                .valid()
            );
            assert!(
                !TimelineSettings {
                    append_window_end: Some(value),
                    ..settings.clone()
                }
                .valid()
            );
        }
        assert!(
            !TimelineSettings {
                append_window_end: Some(settings.append_window_start),
                ..settings
            }
            .valid()
        );
    }

    #[test]
    fn batches_are_bounded_and_capacity_failure_is_explicit() {
        let mut t = Track::new(1, 1);
        t.chunks = vec![vec![0; READ_BYTES / 2]; 4];
        assert_eq!(read_bounds(&t, 0, None), (0, 2, false));
        t.chunks = vec![vec![0]; READ_CHUNKS + 10];
        assert_eq!(read_bounds(&t, 0, None), (0, READ_CHUNKS, false));
        let mut state = state();
        let t = state.tracks.get_mut(ID).unwrap();
        t.phase = "content".into();
        t.verified = true;
        t.verified_source = Some(7);
        t.verified_buffer = Some(3);
        t.bytes = MAX_BYTES;
        apply(&mut state, content(1));
        assert!(
            state.tracks[ID]
                .error
                .as_deref()
                .unwrap()
                .starts_with("CAPTURE_CAPACITY")
        );
        assert!(state.tracks[ID].chunks.is_empty());
    }
    #[test]
    fn late_close_cannot_own_replacement_and_errors_are_not_video_deletion() {
        let mut state = state();
        state.session.as_mut().unwrap().generation = 11;
        assert!(!state.owns(ID, 10));
        assert!(state.owns(ID, 11));
        let mut state = self::state();
        apply(
            &mut state,
            message(
                1,
                json!({"kind":"event","type":"error","code":"CAPTURE_STALLED","reason":"El reproductor dejó de avanzar"}),
            ),
        );
        assert_eq!(
            state.tracks[ID].error.as_deref(),
            Some("CAPTURE_STALLED: El reproductor dejó de avanzar")
        );
        assert!(!crate::player::is_gone(
            state.tracks[ID].error.as_ref().unwrap()
        ));
    }
}
