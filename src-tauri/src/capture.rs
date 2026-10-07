//! API 3: unidades confirmadas, caché append-only y dos sesiones (actual + siguiente).
//! generation identifica la ventana nativa, epoch un recorrido/seek. EOF no prueba cobertura.
use crate::player::RequestTicket;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
pub const LABEL: &str = "yt-engine";
pub const SCHEME: &str = "musify-capture:";
const KEEP: usize = 6;
const MAX_BYTES: usize = 96 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 192 * 1024 * 1024;
const MAX_SEGMENT_BYTES: usize = 4 * 1024 * 1024;
const READ_BYTES: usize = 1024 * 1024;
const READ_CHUNKS: usize = 32;
const HEARTBEAT_STALL: Duration = Duration::from_secs(12);
const PROGRESS_STALL: Duration = Duration::from_secs(60);
const MAX_RESETS: u8 = 2;
const MAX_WAIT: Duration = Duration::from_secs(20 * 60);
const MAX_AD_WAIT_CREDIT: Duration = Duration::from_secs(180);
// Sólo redondeo IEEE754; nunca cubre un frame ausente.
const RANGE_EPSILON: f64 = 0.000001;
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct TimelineSettings {
    timestamp_offset: f64,
    append_window_start: f64,
    append_window_end: Option<f64>,
    mode: String,
}
impl TimelineSettings {
    fn valid(&self) -> bool {
        self.timestamp_offset.is_finite()
            && self.append_window_start.is_finite()
            && self.append_window_start >= 0.0
            && self
                .append_window_end
                .is_none_or(|v| v.is_finite() && v > self.append_window_start)
            && self.mode == "segments"
    }
    fn from_message(value: &Value) -> Option<Self> {
        if !value.as_object()?.contains_key("appendWindowEnd") {
            return None;
        }
        let settings: Self = serde_json::from_value(value.clone()).ok()?;
        settings.valid().then_some(settings)
    }
}
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
struct Range {
    start: f64,
    end: f64,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Unit {
    verified: bool,
    index: usize,
    generation: u64,
    epoch: u64,
    source: u64,
    s: u64,
    unit: u64,
    init_key: String,
    init_bytes: usize,
    mime: String,
    range_start: f64,
    range_end: f64,
    decode_start: f64,
    decode_end: f64,
    frames: u64,
    timeline_settings: TimelineSettings,
}
impl Unit {
    fn from_message(m: &Message, generation: u64) -> Option<Self> {
        let result = Self {
            verified: true,
            index: 0,
            generation,
            epoch: m.epoch?,
            source: m.source?,
            s: m.s?,
            unit: m.unit?,
            init_key: m.init_key.clone()?,
            init_bytes: m.init_bytes?,
            mime: m.mime.clone()?,
            range_start: m.range_start?,
            range_end: m.range_end?,
            decode_start: m.decode_start?,
            decode_end: m.decode_end?,
            frames: m.frames?,
            timeline_settings: TimelineSettings::from_message(m.timeline_settings.as_ref()?)?,
        };
        (m.verified == Some(true)
            && result.frames > 0
            && result.init_bytes > 0
            && !result.init_key.is_empty()
            && result.init_key.len() <= 256
            && result.mime.starts_with("audio/")
            && result.mime.len() <= 256
            && [
                result.range_start,
                result.range_end,
                result.decode_start,
                result.decode_end,
            ]
            .iter()
            .all(|v| v.is_finite())
            && result.range_start >= 0.0
            && result.range_end > result.range_start
            && result.decode_start <= result.range_start + RANGE_EPSILON
            && result.decode_end + RANGE_EPSILON >= result.range_end
            && result.decode_end > result.decode_start)
            .then_some(result)
    }
}
fn union(ranges: &mut Vec<Range>, range: Range) {
    ranges.push(range);
    ranges.sort_by(|a, b| a.start.total_cmp(&b.start));
    let mut merged: Vec<Range> = Vec::with_capacity(ranges.len());
    for current in ranges.drain(..) {
        if let Some(previous) = merged
            .last_mut()
            .filter(|p| current.start <= p.end + RANGE_EPSILON)
        {
            previous.end = previous.end.max(current.end);
        } else {
            merged.push(current);
        }
    }
    *ranges = merged;
}
fn covers(ranges: &[Range], start: f64, end: f64) -> bool {
    ranges
        .iter()
        .any(|r| r.start <= start + RANGE_EPSILON && r.end + RANGE_EPSILON >= end)
}
struct Track {
    revision: u64,
    generation: u64,
    epoch: u64,
    sequence: Option<u64>,
    opened: Instant,
    used: Instant,
    session_started: Instant,
    chunks: Vec<Vec<u8>>,
    units: Vec<Unit>,
    ranges: Vec<Range>,
    bytes: usize,
    proof: Option<Unit>,
    accepted: Option<(u64, u64, u64)>,
    last_unit: Option<u64>,
    phase: String,
    title: String,
    author: String,
    duration: Option<f64>,
    first_ms: Option<u64>,
    playing_ms: Option<u64>,
    meta_ms: Option<u64>,
    done_ms: Option<u64>,
    error: Option<String>,
    soft_error: Option<String>,
    why: Option<String>,
    last_diagnostic: Option<String>,
    eof: bool,
    eof_end: Option<f64>,
    complete: bool,
    epoch_done: bool,
    recovering: bool,
    last_read: Option<Instant>,
    last_msg: Instant,
    last_progress: Instant,
    position: f64,
    resets: u8,
    seek_operation: u64,
    target: f64,
    quarantined: u64,
    unknown: usize,
    ads_observations: usize,
    ads_sources: HashSet<(u64, u64, u64)>,
    ads_delivered: usize,
    ad_observation: Option<(u64, f64, Instant)>,
    ad_wait_credit: Duration,
    ad_presented: Duration,
    ad_rate_violations: usize,
    ad_rate_observations: usize,
}
impl Track {
    fn new(generation: u64, epoch: u64, revision: u64) -> Self {
        let now = Instant::now();
        Self {
            revision,
            generation,
            epoch,
            sequence: None,
            opened: now,
            used: now,
            session_started: now,
            chunks: vec![],
            units: vec![],
            ranges: vec![],
            bytes: 0,
            proof: None,
            accepted: None,
            last_unit: None,
            phase: "opening".into(),
            title: String::new(),
            author: String::new(),
            duration: None,
            first_ms: None,
            playing_ms: None,
            meta_ms: None,
            done_ms: None,
            error: None,
            soft_error: None,
            why: None,
            last_diagnostic: None,
            eof: false,
            eof_end: None,
            complete: false,
            epoch_done: false,
            recovering: false,
            last_read: None,
            last_msg: now,
            last_progress: now,
            position: 0.0,
            resets: 0,
            seek_operation: 0,
            target: 0.0,
            quarantined: 0,
            unknown: 0,
            ads_observations: 0,
            ads_sources: HashSet::new(),
            ads_delivered: 0,
            ad_observation: None,
            ad_wait_credit: Duration::ZERO,
            ad_presented: Duration::ZERO,
            ad_rate_violations: 0,
            ad_rate_observations: 0,
        }
    }
    fn ms(&self) -> u64 {
        self.opened.elapsed().as_millis() as u64
    }
    fn ready(&self) -> bool {
        !self.chunks.is_empty()
    }
    fn begin_epoch(&mut self, generation: u64, epoch: u64, target: f64, recovering: bool) {
        if generation != self.generation {
            self.sequence = None;
        }
        self.generation = generation;
        self.epoch = epoch;
        self.target = target;
        self.proof = None;
        self.accepted = None;
        self.last_unit = None;
        self.error = None;
        self.soft_error = None;
        self.why = None;
        self.last_diagnostic = None;
        self.epoch_done = false;
        self.recovering = recovering;
        self.phase = "opening".into();
        self.session_started = Instant::now();
        self.last_msg = self.session_started;
        self.last_progress = self.session_started;
        self.position = target;
        self.quarantined = 0;
        self.ad_observation = None;
        self.ad_wait_credit = Duration::ZERO;
    }
    fn fail(&mut self, error: String) {
        if self.ready() {
            self.soft_error.get_or_insert(error);
        } else {
            self.error.get_or_insert(error);
        }
        self.proof = None;
        self.epoch_done = true;
        self.recovering = false;
    }
    fn stalled(&self, now: Instant) -> bool {
        !self.epoch_done
            && self.phase != "interaction"
            && (now.duration_since(self.last_msg) >= HEARTBEAT_STALL
                || now.duration_since(self.last_progress) >= PROGRESS_STALL)
    }
    fn wait_budget(&self) -> Duration {
        Duration::from_secs_f64(
            (self.duration.unwrap_or(0.0) + 120.0 + self.ad_wait_credit.as_secs_f64())
                .clamp(120.0, MAX_WAIT.as_secs_f64()),
        )
    }
    fn observe_ad_progress(&mut self, source: u64, position: f64, now: Instant) -> bool {
        let previous = self.ad_observation.replace((source, position, now));
        let Some((old_source, old_position, old_time)) = previous else {
            return false;
        };
        let wall = now.duration_since(old_time);
        let advance = position - old_position;
        if source != old_source
            || wall > HEARTBEAT_STALL
            || advance <= 0.05
            || advance > wall.as_secs_f64() + 0.25
        {
            return false;
        }
        let observed = Duration::from_secs_f64(advance.min(wall.as_secs_f64()));
        self.ad_presented += observed;
        self.ad_wait_credit = (self.ad_wait_credit + observed).min(MAX_AD_WAIT_CREDIT);
        true
    }
    fn first_gap(&self) -> f64 {
        self.ranges
            .first()
            .filter(|r| r.start <= RANGE_EPSILON)
            .map_or(0.0, |r| r.end)
    }
    fn finish(&mut self, end: f64, why: Option<String>) {
        // Es el extremo del audio probado por EOF, no duración nominal del vídeo ni
        // el último bloque disponible. Un seek posterior no puede rebajar ese extremo.
        if !end.is_finite()
            || end <= 0.0
            || self
                .ranges
                .last()
                .is_some_and(|r| r.end > end + RANGE_EPSILON)
        {
            self.fail("CAPTURE_INCOMPLETE: EOF anterior a rangos de audio ya confirmados".into());
            return;
        }
        self.eof = true;
        self.eof_end = Some(self.eof_end.map_or(end, |known| known.max(end)));
        self.epoch_done = true;
        self.why = why;
        self.proof = None;
        self.complete = self
            .eof_end
            .is_some_and(|end| covers(&self.ranges, 0.0, end));
        self.recovering = false;
        if self.complete {
            let ms = self.ms();
            self.done_ms.get_or_insert(ms);
            self.soft_error = None;
            self.error = None;
        } else {
            self.fail(
                "CAPTURE_INCOMPLETE: faltan rangos de audio confirmados; se puede recuperar".into(),
            );
        }
    }
}
#[derive(Clone, Debug)]
struct Session {
    id: String,
    generation: u64,
    label: String,
    foreground: bool,
    ticket: Option<RequestTicket>,
    active: bool,
}
#[derive(Default)]
struct Supervisor {
    tracks: HashMap<String, Track>,
    sessions: Vec<Session>,
    cancellations: HashMap<String, u64>,
    // El lector puede dejar de consultar tras EOF, pero aún necesitará estos bytes al saltar.
    foreground: Option<(String, Option<RequestTicket>)>,
}
impl Supervisor {
    fn owns(&self, id: &str, generation: u64) -> bool {
        self.sessions
            .iter()
            .any(|s| s.active && s.id == id && s.generation == generation)
    }
    fn session(&self, id: &str) -> Option<&Session> {
        self.sessions.iter().find(|s| s.active && s.id == id)
    }
    fn cancellation(&self, id: &str) -> u64 {
        self.cancellations.get(id).copied().unwrap_or(0)
    }
    fn total_bytes(&self) -> usize {
        self.tracks.values().map(|t| t.bytes).sum()
    }
    fn trim(&mut self, keep: &str, incoming: usize) {
        while self.tracks.len() > KEEP
            || self.total_bytes().saturating_add(incoming) > MAX_TOTAL_BYTES
        {
            let oldest = self
                .tracks
                .iter()
                .filter(|(id, _)| {
                    id.as_str() != keep
                        && self.session(id).is_none()
                        && self
                            .foreground
                            .as_ref()
                            .is_none_or(|(current, _)| current != *id)
                })
                .min_by_key(|(_, t)| t.used)
                .map(|(id, _)| id.clone());
            let Some(oldest) = oldest else { break };
            self.tracks.remove(&oldest);
        }
    }
    fn victim(&self, id: &str, foreground: bool) -> Option<Session> {
        self.sessions
            .iter()
            .find(|s| !s.active || (s.id != id && s.foreground == foreground))
            .cloned()
    }
    fn promote(&mut self, id: &str, ticket: Option<RequestTicket>) {
        self.foreground = Some((id.into(), ticket));
        if let Some(session) = self.sessions.iter_mut().find(|s| s.active && s.id == id) {
            session.foreground = true;
            session.ticket = ticket;
        }
    }
    fn release_foreground(&mut self, id: &str) {
        if self
            .foreground
            .as_ref()
            .is_some_and(|(current, _)| current == id)
        {
            self.foreground = None;
        }
    }
    fn cancel_generation(
        &mut self,
        id: &str,
        generation: Option<u64>,
        mark: bool,
    ) -> Option<Session> {
        if generation.is_some_and(|g| self.tracks.get(id).is_none_or(|t| t.generation != g)) {
            return None;
        }
        self.release_foreground(id);
        *self.cancellations.entry(id.into()).or_default() += 1;
        if mark {
            if let Some(t) = self.tracks.get_mut(id).filter(|t| !t.complete) {
                t.fail("CAPTURE_CANCELLED: captura cancelada".into());
                t.phase = "cancelled".into();
            }
        }
        self.session(id).cloned()
    }
}
pub static USED: AtomicU64 = AtomicU64::new(0);
static STATE: LazyLock<Mutex<Supervisor>> = LazyLock::new(Default::default);
// Sólo operaciones de ventanas; nunca se mantiene el mutex de datos durante await/eval.
static TRANSITION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();
static SEQ: AtomicU64 = AtomicU64::new(1);
fn next_id() -> u64 {
    SEQ.fetch_add(1, Ordering::Relaxed)
}
pub struct Meta {
    pub title: String,
    pub channel: Option<String>,
    pub duration: Option<f64>,
}
fn meta(t: &Track) -> Meta {
    Meta {
        title: t.title.clone(),
        channel: (!t.author.is_empty()).then(|| t.author.clone()),
        duration: t.duration,
    }
}
fn supported() -> Result<(), String> {
    if cfg!(windows) {
        Ok(())
    } else {
        Err("CAPTURE_UNSUPPORTED_PLATFORM: la captura oficial requiere Windows".into())
    }
}
fn request_current(ticket: Option<RequestTicket>) -> Result<(), String> {
    if ticket.is_some_and(|t| !crate::player::request_current(t)) {
        Err("CAPTURE_CANCELLED: resolución sustituida".into())
    } else {
        Ok(())
    }
}
/// Devuelve metadatos con la primera unidad confirmada, sin esperar el EOF.
pub async fn stream_with_priority(
    app: &AppHandle,
    video_id: &str,
    refresh: bool,
    foreground: bool,
    ticket: Option<RequestTicket>,
) -> Result<Meta, String> {
    supported()?;
    request_current(ticket)?;
    if !valid_id(video_id) {
        return Err("id de vídeo no válido".into());
    }
    // El contador se toma dentro de la misma admisión serializada que abre/promueve la sesión.
    let cancellation = begin(app, video_id, refresh, foreground, ticket, None, false).await?;
    let mut generation;
    let started = Instant::now();
    let mut budget = Duration::from_secs(120);
    loop {
        request_current(ticket)?;
        {
            let state = STATE.lock().unwrap();
            if cancellation != state.cancellation(video_id) {
                return Err("CAPTURE_CANCELLED: captura cancelada".into());
            }
            let t = state
                .tracks
                .get(video_id)
                .ok_or("CAPTURE_CANCELLED: caché sustituida")?;
            generation = t.generation;
            if t.ready() {
                return Ok(meta(t));
            }
            if let Some(error) = t.error.as_ref().filter(|_| !t.recovering) {
                return Err(error.clone());
            }
            budget = budget.max(t.wait_budget());
            if !state.owns(video_id, t.generation) && !t.recovering {
                return Err("CAPTURE_CANCELLED: sesión sustituida".into());
            }
            if started.elapsed() > budget || started.elapsed() > MAX_WAIT {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    let error = "CAPTURE_TIMEOUT: YouTube no entregó audio confirmado dentro del límite";
    fail_session(video_id, generation, error);
    cancel(app, video_id, Some(generation), false).await?;
    Err(error.into())
}
async fn begin(
    app: &AppHandle,
    id: &str,
    refresh: bool,
    foreground: bool,
    ticket: Option<RequestTicket>,
    at: Option<f64>,
    recovery: bool,
) -> Result<u64, String> {
    let _guard = TRANSITION.lock().await;
    begin_locked(app, id, refresh, foreground, ticket, at, recovery).await?;
    Ok(STATE.lock().unwrap().cancellation(id))
}
async fn begin_locked(
    app: &AppHandle,
    id: &str,
    refresh: bool,
    foreground: bool,
    ticket: Option<RequestTicket>,
    at: Option<f64>,
    recovery: bool,
) -> Result<u64, String> {
    supported()?;
    if !recovery {
        request_current(ticket)?;
    }
    if !valid_id(id) {
        return Err("id de vídeo no válido".into());
    }
    let _ = APP.set(app.clone());
    watchdog(app);
    let inactive: Vec<Session> = STATE
        .lock()
        .unwrap()
        .sessions
        .iter()
        .filter(|s| !s.active)
        .cloned()
        .collect();
    for session in inactive {
        retire_locked(app, &session).await?;
    }
    let existing = STATE.lock().unwrap().session(id).cloned();
    if let Some(session) = existing.filter(|_| (!refresh || !foreground) && at.is_none()) {
        if foreground {
            let old = STATE
                .lock()
                .unwrap()
                .sessions
                .iter()
                .find(|s| s.active && s.foreground && s.id != id)
                .cloned();
            if let Some(old) = old {
                retire_locked(app, &old).await?;
            }
            if !recovery {
                request_current(ticket)?;
            }
            STATE.lock().unwrap().promote(id, ticket);
        }
        let mut state = STATE.lock().unwrap();
        if !foreground {
            if let Some(next) = state
                .sessions
                .iter_mut()
                .find(|s| s.active && s.id == id && !s.foreground)
            {
                next.ticket = ticket;
            }
        }
        if let Some(t) = state.tracks.get_mut(id) {
            t.used = Instant::now();
        }
        return Ok(session.generation);
    }
    if !refresh && at.is_none() {
        let cached = STATE
            .lock()
            .unwrap()
            .tracks
            .get(id)
            .filter(|t| t.complete)
            .map(|t| t.generation);
        if let Some(generation) = cached {
            if foreground {
                let old = STATE
                    .lock()
                    .unwrap()
                    .sessions
                    .iter()
                    .find(|s| s.active && s.foreground && s.id != id)
                    .cloned();
                if let Some(old) = old {
                    retire_locked(app, &old).await?;
                }
            }
            if !recovery {
                request_current(ticket)?;
            }
            if foreground {
                STATE.lock().unwrap().promote(id, ticket);
            }
            return Ok(generation);
        }
    }
    // Una precarga reemplaza sólo next, nunca foreground. Los cierres fallidos retienen su plaza.
    let old = {
        let state = STATE.lock().unwrap();
        state
            .session(id)
            .cloned()
            .or_else(|| state.victim(id, foreground))
    };
    if let Some(old) = old {
        retire_locked(app, &old).await?;
    }
    if !recovery {
        request_current(ticket)?;
    }
    if STATE.lock().unwrap().sessions.len() >= 2 {
        return Err("CAPTURE_BUSY: las dos plazas de captura están ocupadas".into());
    }
    let generation = next_id();
    let epoch = next_id();
    let label = format!("{LABEL}-{generation}");
    {
        let mut state = STATE.lock().unwrap();
        if refresh || !state.tracks.contains_key(id) {
            state
                .tracks
                .insert(id.into(), Track::new(generation, epoch, next_id()));
        }
        state.tracks.get_mut(id).unwrap().begin_epoch(
            generation,
            epoch,
            at.unwrap_or(0.0),
            recovery,
        );
        state.sessions.push(Session {
            id: id.into(),
            generation,
            label: label.clone(),
            foreground,
            ticket,
            active: true,
        });
        if foreground {
            state.promote(id, ticket);
        }
        state.trim(id, 0);
    }
    #[cfg(debug_assertions)]
    eprintln!(
        "[captura] {id} generation={generation} epoch={epoch} open foreground={foreground} recovery={recovery}"
    );
    let result = create_window(app, id, generation, epoch, &label, at)
        .await
        .and_then(|_| {
            if recovery {
                Ok(())
            } else {
                request_current(ticket)
            }
        });
    if let Err(error) = result {
        fail_session(id, generation, &error);
        STATE.lock().unwrap().release_foreground(id);
        let session = STATE
            .lock()
            .unwrap()
            .sessions
            .iter()
            .find(|s| s.generation == generation)
            .cloned();
        if let Some(session) = session {
            let _ = retire_locked(app, &session).await;
        }
        return Err(error);
    }
    USED.fetch_add(1, Ordering::Relaxed);
    Ok(generation)
}
fn progressive_experiment(bench: bool, flag: Option<&str>) -> bool {
    bench && flag == Some("1")
}
fn progressive_experiment_enabled() -> bool {
    progressive_experiment(
        std::env::var_os("MUSIFY_BENCH").is_some(),
        std::env::var("MUSIFY_BENCH_PROGRESSIVE").ok().as_deref(),
    )
}
async fn create_window(
    app: &AppHandle,
    id: &str,
    generation: u64,
    epoch: u64,
    label: &str,
    at: Option<f64>,
) -> Result<(), String> {
    let start = at.map(|s| format!("#musify-t={s:.6}")).unwrap_or_default();
    let url = format!("https://music.youtube.com/watch?v={id}{start}");
    let target = serde_json::to_string(id).map_err(|e| e.to_string())?;
    let progressive = progressive_experiment_enabled();
    let script = format!(
        "Object.defineProperty(window,'__musifyGeneration',{{value:{generation},writable:false}});Object.defineProperty(window,'__musifyTarget',{{value:{target},writable:false}});Object.defineProperty(window,'__musifyProgressiveExperiment',{{value:{progressive},writable:false}});window.__musifyEpoch={epoch};\n{}",
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
    let id = id.to_string();
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
#[serde(rename_all = "camelCase")]
struct Message {
    musify: u8,
    api: Option<u8>,
    v: Option<String>,
    generation: Option<u64>,
    epoch: Option<u64>,
    sequence: Option<u64>,
    kind: String,
    mime: Option<String>,
    classification: Option<String>,
    source: Option<u64>,
    s: Option<u64>,
    unit: Option<u64>,
    init_key: Option<String>,
    init_bytes: Option<usize>,
    ad: Option<bool>,
    data: Option<String>,
    #[serde(rename = "type")]
    event: Option<String>,
    state: Option<String>,
    bytes_quarantined: Option<u64>,
    verified: Option<bool>,
    timeline_settings: Option<Value>,
    frames: Option<u64>,
    range_start: Option<f64>,
    range_end: Option<f64>,
    decode_start: Option<f64>,
    decode_end: Option<f64>,
    duration: Option<f64>,
    title: Option<String>,
    author: Option<String>,
    reason: Option<String>,
    code: Option<String>,
    why: Option<String>,
    position: Option<f64>,
    eof: Option<bool>,
    end: Option<f64>,
    recoverable: Option<bool>,
    playback_rate: Option<f64>,
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
        || m.api != Some(3)
        || m.v.as_deref() != Some(id)
        || m.generation != Some(generation)
    {
        return false;
    }
    // Ni un heartbeat viejo puede mantener viva la generación/época actual.
    if state.tracks.get(id).is_none_or(|t| {
        t.generation != generation
            || m.epoch != Some(t.epoch)
            || m.sequence
                .is_none_or(|s| t.sequence.is_some_and(|previous| s <= previous))
    }) {
        return false;
    }
    state.trim(
        id,
        m.data.as_ref().map_or(0, |d| d.len().saturating_mul(3) / 4),
    );
    let total_bytes = state.total_bytes();
    let t = state.tracks.get_mut(id).unwrap();
    t.sequence = m.sequence;
    t.last_msg = now;
    if t.epoch_done || t.phase == "interaction" {
        return false;
    }
    let ms = t.ms();
    let previous_phase = t.phase.clone();
    let previous_error = (t.error.clone(), t.soft_error.clone());
    let says_content = m.state.as_deref() == Some("content");
    let mut finished = false;
    match m.kind.as_str() {
        "seg" if music => {
            if m.ad == Some(true) || m.classification.as_deref() == Some("ad") {
                t.ads_observations += 1;
                return false;
            }
            let Some(mut unit) = Unit::from_message(&m, generation) else {
                t.unknown += 1;
                return false;
            };
            if m.classification.as_deref() != Some("content")
                || t.phase != "content"
                || t.proof.as_ref() != Some(&unit)
                || t.last_unit.is_some_and(|last| unit.unit <= last)
            {
                t.unknown += 1;
                return false;
            }
            let Some(data) = m.data else { return false };
            if data.len() > MAX_SEGMENT_BYTES.div_ceil(3) * 4 {
                t.fail("CAPTURE_CAPACITY: unidad demasiado grande".into());
                return true;
            }
            let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) else {
                return false;
            };
            if bytes.len() <= unit.init_bytes || bytes.len() > MAX_SEGMENT_BYTES {
                t.fail("CAPTURE_PROTOCOL: unidad sin inicialización y audio válidos".into());
                return true;
            }
            if let Some((known, previous)) = t.units.iter().zip(&t.chunks).find(|(known, _)| {
                known.generation == unit.generation && known.init_key == unit.init_key
            }) {
                if known.mime != unit.mime
                    || known.timeline_settings != unit.timeline_settings
                    || known.init_bytes != unit.init_bytes
                    || previous[..known.init_bytes] != bytes[..unit.init_bytes]
                {
                    t.fail("CAPTURE_PROTOCOL: initKey reutilizado con otra configuración".into());
                    return true;
                }
            }
            t.proof = None;
            t.last_unit = Some(unit.unit);
            t.accepted = Some((t.epoch, unit.source, unit.s));
            if !covers(&t.ranges, unit.range_start, unit.range_end) {
                if t.bytes.saturating_add(bytes.len()) > MAX_BYTES
                    || total_bytes.saturating_add(bytes.len()) > MAX_TOTAL_BYTES
                {
                    t.fail("CAPTURE_CAPACITY: audio excede el límite de memoria".into());
                    return true;
                }
                unit.index = t.units.len();
                t.bytes += bytes.len();
                union(
                    &mut t.ranges,
                    Range {
                        start: unit.range_start,
                        end: unit.range_end,
                    },
                );
                t.units.push(unit);
                t.chunks.push(bytes);
                t.first_ms.get_or_insert(ms);
            }
            t.last_progress = now;
            t.recovering = false;
            t.soft_error = None;
        }
        "event" => {
            if m.event.as_deref() == Some("diagnostic") {
                if let Some(reason) = m.reason.as_deref() {
                    t.last_diagnostic = Some(reason.chars().take(2048).collect());
                }
            }
            if let Some(phase) = m.state.as_deref().filter(|s| {
                matches!(
                    *s,
                    "unknown" | "content" | "ad" | "ambiguous" | "interaction"
                )
            }) {
                t.phase = phase.into();
                if phase != "content" {
                    t.proof = None;
                }
                if phase == "ad" {
                    t.ads_observations += 1;
                    if let Some(rate) = m.playback_rate.filter(|r| r.is_finite() && *r > 0.0) {
                        t.ad_rate_observations += 1;
                        if (rate - 1.0).abs() > f64::EPSILON {
                            t.ad_rate_violations += 1;
                        }
                    }
                    if let Some(source) = m.source {
                        t.ads_sources.insert((generation, t.epoch, source));
                    }
                } else {
                    t.ad_observation = None;
                }
            }
            if m.event.as_deref() == Some("diagnostic") && m.verified == Some(true) {
                t.proof = if music && says_content {
                    Unit::from_message(&m, generation)
                } else {
                    None
                };
            }
            if let Some(bytes) = m.bytes_quarantined {
                t.quarantined = bytes;
            }
            if music
                && (says_content
                    || (m.state.is_none()
                        && matches!(m.event.as_deref(), Some("playing" | "meta"))))
            {
                t.duration = m
                    .duration
                    .filter(|d| d.is_finite() && *d > 0.0)
                    .or(t.duration);
                if let Some(title) = m.title.as_ref().filter(|s| !s.is_empty()) {
                    t.title = title.clone();
                }
                if let Some(author) = m.author.as_ref().filter(|s| !s.is_empty()) {
                    t.author = author.clone();
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
                    if m.eof != Some(true)
                        || m.end.is_none()
                        || t.accepted != m.epoch.zip(m.source).zip(m.s).map(|((e, s), b)| (e, s, b))
                    {
                        t.fail("CAPTURE_INCOMPLETE: terminó sin EOF oficial válido de la fuente confirmada".into());
                    } else {
                        t.finish(m.end.unwrap(), m.why.clone());
                    }
                    finished = true;
                }
                Some("error") => {
                    let reason = m
                        .reason
                        .clone()
                        .unwrap_or_else(|| "YouTube no puede reproducirla".into());
                    let error = match &m.code {
                        Some(code) if !reason.starts_with(code) => format!("{code}: {reason}"),
                        _ => reason,
                    };
                    t.fail(error);
                    if m.recoverable == Some(true) {
                        t.recovering = t.resets < MAX_RESETS;
                    }
                    finished = true;
                }
                Some("interaction") => {
                    t.phase = "interaction".into();
                    let error = format!(
                        "CAPTURE_REQUIRES_INTERACTION: {}",
                        m.reason.as_deref().unwrap_or("Abre YouTube para continuar")
                    );
                    if t.ready() {
                        t.soft_error = Some(error);
                    } else {
                        t.error = Some(error);
                    }
                }
                Some("progress" | "diagnostic") if music => {
                    if let Some(position) = m.position.filter(|p| p.is_finite() && *p >= 0.0) {
                        let advances = if t.phase == "ad" {
                            m.state.as_deref() == Some("ad")
                                && m.event.as_deref() == Some("diagnostic")
                                && m.source
                                    .is_some_and(|s| t.observe_ad_progress(s, position, now))
                        } else {
                            says_content && position > t.position + 0.05
                        };
                        if advances {
                            t.last_progress = now;
                        }
                        t.position = position;
                    }
                }
                Some("seeked") if music => {
                    t.last_progress = now;
                }
                _ => {}
            }
        }
        _ => {}
    }
    #[cfg(debug_assertions)]
    if previous_phase != t.phase
        || previous_error != (t.error.clone(), t.soft_error.clone())
        || matches!(
            m.event.as_deref(),
            Some("playing" | "ended" | "interaction")
        )
    {
        let reason = t.error.as_deref().or(t.soft_error.as_deref()).unwrap_or("");
        let reason: String = if reason.contains("://") {
            String::new()
        } else {
            reason.chars().take(2048).collect()
        };
        eprintln!(
            "[captura] {id} generation={generation} epoch={} state={} units={} bytes={} position={:.3} complete={} reason={}",
            t.epoch,
            t.phase,
            t.units.len(),
            t.bytes,
            t.position,
            t.complete,
            reason.replace(['\r', '\n'], " ")
        );
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
    apply_message(
        &mut STATE.lock().unwrap(),
        id,
        generation,
        source,
        message,
        Instant::now(),
    );
}
fn fail_session(id: &str, generation: u64, reason: &str) {
    let mut state = STATE.lock().unwrap();
    if !state.owns(id, generation) {
        return;
    }
    if let Some(t) = state
        .tracks
        .get_mut(id)
        .filter(|t| t.generation == generation)
    {
        t.fail(reason.into());
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
            tokio::time::sleep(Duration::from_secs(1)).await;
            let _guard = TRANSITION.lock().await;
            let sessions = STATE.lock().unwrap().sessions.clone();
            for session in sessions {
                let action = {
                    let mut state = STATE.lock().unwrap();
                    if !state.owns(&session.id, session.generation) {
                        None
                    } else if session.ticket.is_some_and(|ticket| {
                        if session.foreground {
                            !crate::player::resolution_current(ticket.resolution)
                        } else {
                            !crate::player::prefetch_current(ticket)
                        }
                    }) {
                        state.release_foreground(&session.id);
                        if let Some(t) = state.tracks.get_mut(&session.id) {
                            t.fail("CAPTURE_CANCELLED: petición sustituida".into());
                        }
                        Some(None)
                    } else if let Some(t) = state.tracks.get_mut(&session.id) {
                        // Una nueva canción actual conserva next para poder promoverla. Otra
                        // petición next sí sustituye su lease, incluso si su búsqueda tarda.
                        if t.phase == "interaction" {
                            None
                        } else if t.complete {
                            Some(None)
                        } else if t.stalled(Instant::now())
                            || t.session_started.elapsed() > MAX_WAIT
                        {
                            t.fail("CAPTURE_STALLED: el reproductor dejó de avanzar".into());
                            if t.resets < MAX_RESETS {
                                t.resets += 1;
                                t.recovering = true;
                                Some(Some(t.target.max(t.first_gap())))
                            } else {
                                Some(None)
                            }
                        } else if t.epoch_done {
                            if t.resets < MAX_RESETS && (t.eof || t.recovering) {
                                t.resets += 1;
                                t.recovering = true;
                                Some(Some(t.first_gap()))
                            } else {
                                Some(None)
                            }
                        } else {
                            None
                        }
                    } else {
                        Some(None)
                    }
                };
                if let Some(at) = action {
                    if let Err(error) = retire_locked(&app, &session).await {
                        fail_session(&session.id, session.generation, &error);
                        continue;
                    }
                    if let Some(at) = at {
                        let _ = begin_locked(
                            &app,
                            &session.id,
                            false,
                            session.foreground,
                            session.ticket,
                            Some(at),
                            true,
                        )
                        .await;
                    }
                }
            }
        }
    });
}
async fn retire_locked(app: &AppHandle, session: &Session) -> Result<(), String> {
    {
        let mut state = STATE.lock().unwrap();
        let Some(current) = state
            .sessions
            .iter_mut()
            .find(|s| s.generation == session.generation)
        else {
            return Ok(());
        };
        current.active = false;
    }
    let result = close_window(app, &session.label).await;
    let mut state = STATE.lock().unwrap();
    if result.is_ok() {
        state
            .sessions
            .retain(|s| s.generation != session.generation);
    } else if let Some(t) = state
        .tracks
        .get_mut(&session.id)
        .filter(|t| t.generation == session.generation)
    {
        t.fail(result.as_ref().unwrap_err().clone());
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
async fn cancel(
    app: &AppHandle,
    id: &str,
    generation: Option<u64>,
    mark: bool,
) -> Result<(), String> {
    let _guard = TRANSITION.lock().await;
    let session = {
        let mut state = STATE.lock().unwrap();
        state.cancel_generation(id, generation, mark)
    };
    if let Some(session) = session {
        retire_locked(app, &session).await?;
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
    cancel(&app, &video_id, generation, true).await
}
/// Conserva next para promoción; cancelación explícita del lector cancela cualquier generación.
pub async fn cancel_before(app: &AppHandle, ticket: u64) -> Result<(), String> {
    let _guard = TRANSITION.lock().await;
    {
        let mut state = STATE.lock().unwrap();
        if state
            .foreground
            .as_ref()
            .is_some_and(|(_, t)| t.is_some_and(|t| t.resolution < ticket))
        {
            state.foreground = None;
        }
    }
    let sessions: Vec<_> = STATE
        .lock()
        .unwrap()
        .sessions
        .iter()
        .filter(|s| s.foreground && s.ticket.is_some_and(|t| t.resolution < ticket))
        .cloned()
        .collect();
    for session in sessions {
        {
            let mut state = STATE.lock().unwrap();
            *state.cancellations.entry(session.id.clone()).or_default() += 1;
            if let Some(t) = state
                .tracks
                .get_mut(&session.id)
                .filter(|t| t.generation == session.generation && !t.complete)
            {
                t.fail("CAPTURE_CANCELLED: resolución cancelada".into());
                t.phase = "cancelled".into();
            }
        }
        retire_locked(app, &session).await?;
    }
    Ok(())
}
pub async fn cancel_next_before(app: &AppHandle, prefetch: u64) -> Result<(), String> {
    let _guard = TRANSITION.lock().await;
    let sessions: Vec<_> = STATE
        .lock()
        .unwrap()
        .sessions
        .iter()
        .filter(|s| {
            !s.foreground
                && s.ticket
                    .and_then(|t| t.prefetch)
                    .is_some_and(|p| p < prefetch)
        })
        .cloned()
        .collect();
    for session in sessions {
        {
            let mut state = STATE.lock().unwrap();
            *state.cancellations.entry(session.id.clone()).or_default() += 1;
            if let Some(t) = state.tracks.get_mut(&session.id).filter(|t| !t.complete) {
                t.fail("CAPTURE_CANCELLED: precarga cancelada".into());
            }
        }
        retire_locked(app, &session).await?;
    }
    Ok(())
}
#[tauri::command]
pub async fn capture_show(app: AppHandle) -> Result<(), String> {
    supported()?;
    let _guard = TRANSITION.lock().await;
    let label = STATE
        .lock()
        .unwrap()
        .sessions
        .iter()
        .find(|s| s.active && s.foreground)
        .map(|s| s.label.clone())
        .ok_or("No hay captura activa")?;
    let window = app
        .get_webview_window(&label)
        .ok_or("No hay ventana de captura")?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn capture_begin(
    app: AppHandle,
    video_id: String,
    foreground: Option<bool>,
    refresh: Option<bool>,
) -> Result<Value, String> {
    begin(
        &app,
        &video_id,
        refresh.unwrap_or(false),
        foreground.unwrap_or(true),
        None,
        None,
        false,
    )
    .await?;
    status(&video_id).ok_or_else(|| "CAPTURE_CANCELLED: sesión sustituida".into())
}
#[tauri::command]
pub async fn capture_prefetch(app: AppHandle, video_id: String) -> Result<Value, String> {
    capture_begin(app, video_id, Some(false), Some(false)).await
}
/// Ensayos de arranque frío: no equivale a cancelar, que conserva audio reutilizable.
pub async fn bench_forget(app: &AppHandle, video_id: &str) -> Result<(), String> {
    if std::env::var_os("MUSIFY_BENCH").is_none() {
        return Err("El banco sólo está disponible en una ejecución de pruebas".into());
    }
    if !valid_id(video_id) {
        return Err("id de vídeo no válido".into());
    }
    let _guard = TRANSITION.lock().await;
    let sessions: Vec<_> = STATE
        .lock()
        .unwrap()
        .sessions
        .iter()
        .filter(|s| s.id == video_id)
        .cloned()
        .collect();
    for session in sessions {
        retire_locked(app, &session).await?;
    }
    let mut state = STATE.lock().unwrap();
    *state.cancellations.entry(video_id.into()).or_default() += 1;
    state.release_foreground(video_id);
    state.tracks.remove(video_id);
    Ok(())
}
#[tauri::command]
pub async fn capture_seek(
    app: AppHandle,
    video_id: String,
    at: f64,
    generation: Option<u64>,
    request_id: Option<u64>,
) -> Result<Value, String> {
    supported()?;
    if !valid_id(&video_id) || !at.is_finite() || at < 0.0 {
        return Err("salto no válido".into());
    }
    let operation = next_id();
    {
        let mut state = STATE.lock().unwrap();
        let t = state
            .tracks
            .get_mut(&video_id)
            .ok_or("CAPTURE_CANCELLED: no hay captura")?;
        if generation.is_some_and(|g| g != t.generation) {
            return Ok(json!({"requestId":request_id,"stale":true}));
        }
        t.seek_operation = operation;
    }
    let _guard = TRANSITION.lock().await;
    let (session, epoch, cached, reopen) = {
        let mut state = STATE.lock().unwrap();
        if state
            .foreground
            .as_ref()
            .is_none_or(|(id, _)| id != &video_id)
        {
            return Err("CAPTURE_CANCELLED: el lector ya no tiene la captura actual".into());
        }
        if state
            .sessions
            .iter()
            .any(|s| s.active && s.foreground && s.id != video_id)
        {
            return Err("CAPTURE_CANCELLED: otra canción tiene prioridad".into());
        }
        let session = state.session(&video_id).cloned();
        let t = state
            .tracks
            .get_mut(&video_id)
            .ok_or("CAPTURE_CANCELLED: no hay captura")?;
        if t.seek_operation != operation || generation.is_some_and(|g| g != t.generation) {
            return Ok(json!({"requestId":request_id,"stale":true}));
        }
        let cached =
            covers(&t.ranges, at, at + 0.05) || t.complete && t.eof_end.is_some_and(|d| at >= d);
        if cached {
            (session, t.epoch, true, false)
        } else {
            let reopen = t.epoch_done || t.phase == "interaction";
            let epoch = next_id();
            t.begin_epoch(t.generation, epoch, at, true);
            (session, epoch, false, reopen)
        }
    };
    if !cached {
        if let Some(session) = session {
            if let Some(window) = app.get_webview_window(&session.label).filter(|_| !reopen) {
                let request = json!({"at":at,"epoch":epoch,"requestId":request_id});
                window
                    .eval(format!("window.__musifySeek?.({request})"))
                    .map_err(|e| format!("CAPTURE_SEEK: {e}"))?;
            } else {
                retire_locked(&app, &session).await?;
                begin_locked(&app, &video_id, false, true, session.ticket, Some(at), true).await?;
            }
        } else {
            begin_locked(&app, &video_id, false, true, None, Some(at), true).await?;
        }
    }
    let state = STATE.lock().unwrap();
    let t = state
        .tracks
        .get(&video_id)
        .ok_or("CAPTURE_CANCELLED: no hay captura")?;
    Ok(
        json!({"requestId":request_id,"generation":t.generation,"epoch":t.epoch,"revision":t.revision,"cached":cached,"from":0}),
    )
}
fn read_bounds(t: &Track, from: usize, revision: Option<u64>) -> (usize, usize, bool) {
    let reset = revision.is_some_and(|r| r != t.revision) || from > t.chunks.len();
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
                || t.complete
                || t.error.is_some()
                || t.soft_error.is_some()
                || Instant::now() > deadline
            {
                let chunks = &t.chunks[start..end];
                let head=json!({"api":3,"progressiveExperiment":progressive_experiment_enabled(),"mime":t.units.first().map(|u|&u.mime),"mimes":t.units[start..end].iter().map(|u|&u.mime).collect::<Vec<_>>(),
                    "units":&t.units[start..end],"ranges":t.ranges,"duration":t.duration,"audioDuration":t.eof_end,"eofEnd":t.eof_end,"total":t.units.len(),
                    "done":t.complete&&end==t.chunks.len(),"complete":t.complete,"eof":t.eof,"error":t.error,"softError":t.soft_error,"recovering":t.recovering,
                    "revision":t.revision,"generation":t.generation,"epoch":t.epoch,"reset":reset,"from":start,"next":end}).to_string();
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
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}
pub fn status(video_id: &str) -> Option<Value> {
    let state = STATE.lock().unwrap();
    let t = state.tracks.get(video_id)?;
    let captured: f64 = t.ranges.iter().map(|r| r.end - r.start).sum();
    let session = state.session(video_id);
    let mut result = json!({"api":3,"progressiveExperiment":progressive_experiment_enabled(),"mime":t.units.first().map(|u|&u.mime),"chunks":t.chunks.len(),"units":t.units.len(),"bytes":t.bytes,"ranges":t.ranges,
        "ads":t.ads_observations,"adObservations":t.ads_observations,"adsSourcesSeen":t.ads_sources.len(),"adsSeen":t.ads_sources.len(),"adsDelivered":t.ads_delivered,"unknown":t.unknown,
        "state":t.phase,"bytesQuarantined":t.quarantined,"verified":t.ready(),"frames":t.units.iter().map(|u|u.frames).sum::<u64>(),
        "rangeStart":t.ranges.first().map(|r|r.start),"rangeEnd":t.ranges.last().map(|r|r.end),"duration":t.duration,
        "firstMs":t.first_ms,"playingMs":t.playing_ms,"metaMs":t.meta_ms,"title":t.title,"doneMs":t.done_ms});
    let detail = json!({"eof":t.eof,"audioDuration":t.eof_end,"eofEnd":t.eof_end,"complete":t.complete,"error":t.error,"softError":t.soft_error,"recovering":t.recovering,"why":t.why,"resets":t.resets,
        "lastDiagnostic":t.last_diagnostic,"lastPosition":t.position,"adMs":t.ad_presented.as_millis(),"adWaitMs":t.ad_wait_credit.as_millis(),
        "adRateViolations":t.ad_rate_violations,"adRateObservations":t.ad_rate_observations,
        "lastProgressAgoMs":t.last_progress.elapsed().as_millis(),"waitBudgetMs":t.wait_budget().as_millis(),
        "captureRate":captured/t.opened.elapsed().as_secs_f64().max(0.001),"activeWindows":state.sessions.len(),"foreground":session.map(|s|s.foreground),
        "generation":t.generation,"epoch":t.epoch,"revision":t.revision});
    result
        .as_object_mut()
        .unwrap()
        .extend(detail.as_object().unwrap().clone());
    Some(result)
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
    const NEXT: &str = "bbbbbbbbbbb";
    const MUSIC: &str = "https://music.youtube.com/watch?v=aaaaaaaaaaa";
    #[test]
    fn progressive_delivery_needs_explicit_benchmark_and_opt_in() {
        assert!(!progressive_experiment(false, Some("1")));
        assert!(!progressive_experiment(true, None));
        assert!(!progressive_experiment(true, Some("true")));
        assert!(progressive_experiment(true, Some("1")));
    }
    fn session(id: &str, generation: u64, foreground: bool) -> Session {
        Session {
            id: id.into(),
            generation,
            label: format!("test-{generation}"),
            foreground,
            ticket: Some(RequestTicket {
                resolution: 1,
                prefetch: None,
            }),
            active: true,
        }
    }
    fn state() -> Supervisor {
        let mut state = Supervisor::default();
        state.sessions.push(session(ID, 10, true));
        state.tracks.insert(ID.into(), Track::new(10, 20, 30));
        state
    }
    fn message(state: &Supervisor, value: Value) -> Message {
        let t = &state.tracks[ID];
        let mut base = json!({"musify":1,"api":3,"v":ID,"generation":t.generation,"epoch":t.epoch,"sequence":t.sequence.unwrap_or(0)+1});
        base.as_object_mut()
            .unwrap()
            .extend(value.as_object().unwrap().clone());
        serde_json::from_value(base).unwrap()
    }
    fn send(state: &mut Supervisor, value: Value) -> bool {
        let m = message(state, value);
        let generation = state.tracks[ID].generation;
        apply_message(state, ID, generation, MUSIC, m, Instant::now())
    }
    fn unit(number: u64, start: f64, end: f64) -> Value {
        json!({"kind":"event","type":"diagnostic","state":"content","verified":true,"source":7,"s":3,"unit":number,
            "initKey":"configuration-1","initBytes":2,"mime":"audio/webm; codecs=opus","frames":10,"rangeStart":start,"rangeEnd":end,
            "decodeStart":start,"decodeEnd":end,"timelineSettings":{"timestampOffset":0.0,"appendWindowStart":0.0,"appendWindowEnd":null,"mode":"segments"}})
    }
    fn segment(mut proof: Value) -> Value {
        proof["kind"] = json!("seg");
        proof["classification"] = json!("content");
        proof["data"] = json!("AQIDBA==");
        proof
    }
    fn deliver(state: &mut Supervisor, number: u64, start: f64, end: f64) {
        let proof = unit(number, start, end);
        send(state, proof.clone());
        send(state, segment(proof));
    }
    fn ended(state: &mut Supervisor, duration: f64) {
        send(
            state,
            json!({"kind":"event","type":"ended","state":"content","source":7,"s":3,"eof":true,"duration":duration,"end":duration}),
        );
    }
    #[test]
    fn progressive_unit_is_ready_before_eof_and_reader_gets_exact_proof() {
        let mut s = state();
        deliver(&mut s, 1, 0.0, 1.0);
        let t = &s.tracks[ID];
        assert!(t.ready());
        assert!(!t.complete);
        assert!(!t.eof);
        assert_eq!(t.units[0].index, 0);
        let wire = serde_json::to_value(&t.units[0]).unwrap();
        assert_eq!(wire["verified"], true);
        assert!(wire["timelineSettings"]["appendWindowEnd"].is_null());
        ended(&mut s, 1.0);
        assert!(s.tracks[ID].complete);
        assert!(s.tracks[ID].done_ms.is_some());
    }
    #[test]
    fn rejects_wrong_window_api_origin_epoch_and_sequence_before_heartbeat() {
        let mut s = state();
        let before = s.tracks[ID].last_msg;
        let future = before + Duration::from_secs(2);
        for override_value in [
            json!({"api":2}),
            json!({"generation":9}),
            json!({"epoch":19}),
            json!({"v":NEXT}),
        ] {
            let mut value = unit(1, 0.0, 1.0);
            value
                .as_object_mut()
                .unwrap()
                .extend(override_value.as_object().unwrap().clone());
            let m = message(&s, value);
            assert!(!apply_message(&mut s, ID, 10, MUSIC, m, future));
        }
        let m = message(&s, unit(1, 0.0, 1.0));
        assert!(!apply_message(
            &mut s,
            ID,
            10,
            "https://evil.example",
            m,
            future
        ));
        assert_eq!(s.tracks[ID].last_msg, before);
        assert_eq!(s.tracks[ID].sequence, None);
        send(&mut s, unit(1, 0.0, 1.0));
        let mut stale = segment(unit(1, 0.0, 1.0));
        stale["sequence"] = json!(1);
        send(&mut s, stale);
        assert!(s.tracks[ID].chunks.is_empty());
    }
    #[test]
    fn observation_is_not_proof_and_each_unit_requires_matching_identity() {
        let mut s = state();
        send(
            &mut s,
            json!({"kind":"event","type":"diagnostic","state":"content"}),
        );
        send(&mut s, segment(unit(1, 0.0, 1.0)));
        assert!(!s.tracks[ID].ready());
        send(&mut s, unit(1, 0.0, 1.0));
        let mut wrong = segment(unit(1, 0.0, 1.0));
        wrong["source"] = json!(8);
        send(&mut s, wrong);
        assert!(!s.tracks[ID].ready());
        send(&mut s, segment(unit(1, 0.0, 1.0)));
        assert!(s.tracks[ID].ready());
        send(&mut s, segment(unit(2, 1.0, 2.0)));
        assert_eq!(s.tracks[ID].chunks.len(), 1);
    }
    #[test]
    fn malformed_timeline_replaces_old_proof_and_rejects_delivery() {
        for invalid in [
            json!(null),
            json!({"timestampOffset":0,"appendWindowStart":-1,"appendWindowEnd":null,"mode":"segments"}),
            json!({"timestampOffset":0,"appendWindowStart":0,"appendWindowEnd":0,"mode":"segments"}),
            json!({"timestampOffset":0,"appendWindowStart":0,"appendWindowEnd":null,"mode":"sequence"}),
        ] {
            let mut s = state();
            send(&mut s, unit(1, 0.0, 1.0));
            let mut bad = unit(1, 0.0, 1.0);
            bad["timelineSettings"] = invalid;
            send(&mut s, bad);
            send(&mut s, segment(unit(1, 0.0, 1.0)));
            assert!(!s.tracks[ID].ready());
        }
    }
    #[test]
    fn eof_with_gap_preserves_audio_and_recovery_merges_without_revision_reset() {
        let mut s = state();
        deliver(&mut s, 1, 0.0, 1.0);
        deliver(&mut s, 2, 4.0, 5.0);
        ended(&mut s, 5.0);
        let t = s.tracks.get_mut(ID).unwrap();
        assert!(t.eof);
        assert!(!t.complete);
        assert!(t.error.is_none());
        assert!(t.soft_error.is_some());
        assert_eq!(t.first_gap(), 1.0);
        let old = t.chunks.clone();
        t.begin_epoch(11, 21, 1.0, true);
        s.sessions[0].generation = 11;
        deliver(&mut s, 1, 1.0, 4.0);
        assert!(!s.tracks[ID].complete);
        ended(&mut s, 5.0);
        let t = &s.tracks[ID];
        assert!(t.complete);
        assert_eq!(t.revision, 30);
        assert_eq!(&t.chunks[..2], old.as_slice());
        assert_eq!(
            t.ranges,
            vec![Range {
                start: 0.0,
                end: 5.0
            }]
        );
        assert_eq!(t.units[2].index, 2);
        assert_eq!(read_bounds(t, 2, Some(30)), (2, 3, false));
    }
    #[test]
    fn future_tail_without_zero_and_false_eof_never_complete() {
        let mut s = state();
        deliver(&mut s, 1, 8.0, 10.0);
        ended(&mut s, 10.0);
        assert!(!s.tracks[ID].complete);
        let mut s = state();
        deliver(&mut s, 1, 0.0, 10.0);
        send(
            &mut s,
            json!({"kind":"event","type":"ended","source":7,"s":3,"eof":false,"duration":10.0}),
        );
        assert!(!s.tracks[ID].complete);
        assert!(!s.tracks[ID].eof);
        assert!(s.tracks[ID].soft_error.is_some());
    }
    #[test]
    fn seek_epoch_retains_ledger_but_old_messages_cannot_append() {
        let mut s = state();
        deliver(&mut s, 1, 0.0, 1.0);
        s.tracks.get_mut(ID).unwrap().begin_epoch(10, 21, 8.0, true);
        let mut old = segment(unit(2, 1.0, 2.0));
        old["epoch"] = json!(20);
        send(&mut s, old);
        deliver(&mut s, 1, 8.0, 9.0);
        assert_eq!(s.tracks[ID].chunks.len(), 2);
        assert_eq!(s.tracks[ID].revision, 30);
        assert_eq!(s.tracks[ID].units[0].epoch, 20);
        assert_eq!(s.tracks[ID].units[1].epoch, 21);
    }
    #[test]
    fn repeated_confirmed_ranges_do_not_grow_cache() {
        let mut s = state();
        deliver(&mut s, 1, 0.0, 1.0);
        let bytes = s.tracks[ID].bytes;
        s.tracks.get_mut(ID).unwrap().begin_epoch(10, 21, 0.0, true);
        deliver(&mut s, 1, 0.0, 1.0);
        assert_eq!(s.tracks[ID].bytes, bytes);
        assert_eq!(s.tracks[ID].units.len(), 1);
    }
    #[test]
    fn init_identity_is_scoped_to_window_and_checks_actual_bytes() {
        let mut s = state();
        deliver(&mut s, 1, 0.0, 1.0);
        let p = unit(2, 1.0, 2.0);
        send(&mut s, p.clone());
        let mut seg = segment(p);
        seg["data"] = json!("AgIDBA==");
        send(&mut s, seg);
        assert_eq!(s.tracks[ID].units.len(), 1);
        assert!(
            s.tracks[ID]
                .soft_error
                .as_deref()
                .unwrap()
                .starts_with("CAPTURE_PROTOCOL")
        );
        s.tracks.get_mut(ID).unwrap().begin_epoch(11, 21, 1.0, true);
        s.sessions[0].generation = 11;
        let p = unit(1, 1.0, 2.0);
        send(&mut s, p.clone());
        let mut seg = segment(p);
        seg["data"] = json!("AgIDBA==");
        send(&mut s, seg);
        assert_eq!(s.tracks[ID].units.len(), 2);
    }
    #[test]
    fn pool_prefetch_replaces_only_next_and_promotion_retains_generation() {
        let mut s = state();
        s.sessions.push(session(NEXT, 11, false));
        s.tracks.insert(NEXT.into(), Track::new(11, 21, 31));
        assert_eq!(s.victim("ccccccccccc", false).unwrap().id, NEXT);
        assert_eq!(s.victim("ccccccccccc", true).unwrap().id, ID);
        s.sessions.retain(|session| session.id != ID);
        let ticket = Some(RequestTicket {
            resolution: 9,
            prefetch: None,
        });
        s.promote(NEXT, ticket);
        let current = s.session(NEXT).unwrap();
        assert!(current.foreground);
        assert_eq!(current.generation, 11);
        assert_eq!(current.ticket, ticket);
        assert_eq!(s.tracks[NEXT].revision, 31);
        assert!(s.victim("ccccccccccc", false).is_none());
    }
    #[test]
    fn completed_foreground_cache_survives_idle_window_retirement_and_pressure() {
        let mut s = state();
        deliver(&mut s, 1, 0.0, 1.0);
        s.tracks.get_mut(ID).unwrap().complete = true;
        s.promote(ID, None);
        let before = s.tracks[ID].chunks.clone();
        s.sessions.clear(); // Automatic EOF close must not release the reader's cache lease.
        for n in 0..KEEP + 3 {
            s.tracks
                .insert(format!("cache-{n}"), Track::new(100 + n as u64, 1, 1));
        }
        s.trim("cache-8", 0);
        assert_eq!(s.tracks[ID].chunks, before);
        assert_eq!(s.tracks[ID].revision, 30);
        assert_eq!(s.tracks.len(), KEEP);
        assert_eq!(read_bounds(&s.tracks[ID], 0, Some(30)), (0, 1, false));
        s.cancel_generation(ID, Some(9), true); // Delayed cleanup of an older window.
        assert!(s.foreground.is_some());
        s.cancel_generation(ID, Some(10), true);
        assert!(s.foreground.is_none());
        s.tracks.insert("later".into(), Track::new(99, 1, 1));
        s.trim("later", 0);
        assert!(
            !s.tracks.contains_key(ID),
            "explicitly released cache is evictable"
        );
    }
    #[tokio::test]
    async fn cancel_queued_before_admission_cannot_cancel_the_new_generation() {
        use std::sync::Arc;
        let state = Arc::new(Mutex::new(state()));
        let transition = Arc::new(tokio::sync::Mutex::new(()));
        let occupied = transition.lock().await;
        let cancel = {
            let state = state.clone();
            let transition = transition.clone();
            tokio::spawn(async move {
                let _guard = transition.lock().await;
                state.lock().unwrap().cancel_generation(ID, Some(10), true);
            })
        };
        tokio::task::yield_now().await;
        let admit = {
            let state = state.clone();
            let transition = transition.clone();
            tokio::spawn(async move {
                let _guard = transition.lock().await;
                let mut state = state.lock().unwrap();
                state.tracks.insert(ID.into(), Track::new(11, 21, 31));
                state.sessions = vec![session(ID, 11, true)];
                state.promote(ID, None);
                state.cancellation(ID) // Same critical section as admission, as in begin().
            })
        };
        drop(occupied);
        cancel.await.unwrap();
        let admitted_cancellation = admit.await.unwrap();
        let mut state = state.lock().unwrap();
        assert_eq!(admitted_cancellation, 1);
        assert_eq!(admitted_cancellation, state.cancellation(ID));
        assert!(state.owns(ID, 11));
        state.cancel_generation(ID, Some(10), true);
        assert_eq!(admitted_cancellation, state.cancellation(ID));
        assert!(state.foreground.is_some());
        state.cancel_generation(ID, Some(11), true);
        assert_ne!(admitted_cancellation, state.cancellation(ID));
        assert!(state.foreground.is_none());
    }
    #[test]
    fn failed_close_still_occupies_slot_and_cannot_send() {
        let mut s = state();
        s.sessions.push(session(NEXT, 11, false));
        s.sessions[0].active = false;
        assert_eq!(s.sessions.len(), 2);
        assert!(!s.owns(ID, 10));
        assert_eq!(s.victim("ccccccccccc", false).unwrap().generation, 10);
        let m = message(&s, unit(1, 0.0, 1.0));
        assert!(!apply_message(&mut s, ID, 10, MUSIC, m, Instant::now()));
    }
    #[test]
    fn reader_batches_keep_units_atomic_and_replay_does_not_change_storage() {
        let mut t = Track::new(1, 2, 3);
        t.chunks = vec![vec![0; READ_BYTES + 10], vec![0; READ_BYTES], vec![0; 1]];
        assert_eq!(read_bounds(&t, 0, Some(3)), (0, 1, false));
        assert_eq!(read_bounds(&t, 1, Some(3)), (1, 2, false));
        assert_eq!(read_bounds(&t, 3, Some(2)), (0, 1, true));
        assert_eq!(read_bounds(&t, 0, Some(3)), (0, 1, false));
        t.chunks = vec![vec![0]; 40];
        assert_eq!(read_bounds(&t, 0, None), (0, 32, false));
    }
    #[test]
    fn terminal_error_after_delivery_is_soft_and_never_erases_chunks() {
        let mut s = state();
        deliver(&mut s, 1, 0.0, 1.0);
        let before = s.tracks[ID].chunks.clone();
        send(
            &mut s,
            json!({"kind":"event","type":"error","code":"CAPTURE_NETWORK","reason":"offline","recoverable":true}),
        );
        let t = &s.tracks[ID];
        assert!(t.error.is_none());
        assert!(t.soft_error.is_some());
        assert!(t.recovering);
        assert_eq!(t.chunks, before);
    }
    #[test]
    fn ad_clock_credit_is_bounded_but_observed_time_is_not_timeout_budget() {
        let mut t = Track::new(1, 2, 3);
        let start = t.opened;
        assert!(!t.observe_ad_progress(7, 0.0, start));
        for n in 1..=200 {
            assert!(t.observe_ad_progress(7, n as f64, start + Duration::from_secs(n)));
        }
        assert_eq!(t.ad_wait_credit, Duration::from_secs(180));
        assert_eq!(t.ad_presented, Duration::from_secs(200));
        assert!(!t.observe_ad_progress(7, 500.0, start + Duration::from_secs(201)));
        assert!(!t.observe_ad_progress(8, 1.0, start + Duration::from_secs(202)));
        assert_eq!(t.ad_presented, Duration::from_secs(200));
    }
    #[test]
    fn ad_diagnostics_do_not_replace_song_metadata_and_bound_details() {
        let mut s = state();
        send(
            &mut s,
            json!({"kind":"event","type":"meta","state":"content","duration":288.0,"title":"song"}),
        );
        send(
            &mut s,
            json!({"kind":"event","type":"diagnostic","state":"ad","source":8,"position":0,"duration":11.621,"title":"ad","playbackRate":2,"reason":"ñ".repeat(3000)}),
        );
        let t = &s.tracks[ID];
        assert_eq!(t.duration, Some(288.0));
        assert_eq!(t.title, "song");
        assert_eq!(t.ads_sources.len(), 1);
        assert_eq!(t.last_diagnostic.as_ref().unwrap().chars().count(), 2048);
        assert_eq!(t.ad_rate_violations, 1);
        assert_eq!(t.ads_delivered, 0);
    }
    #[test]
    fn heartbeat_alone_does_not_hide_audio_stall() {
        let mut t = Track::new(1, 2, 3);
        t.last_msg = t.opened + Duration::from_secs(61);
        assert!(t.stalled(t.last_msg));
        t.phase = "interaction".into();
        assert!(!t.stalled(t.last_msg));
    }
    #[test]
    fn eof_audio_end_is_independent_of_video_duration_and_cannot_shrink() {
        let mut s = state();
        deliver(&mut s, 1, 0.0, 9.9);
        send(
            &mut s,
            json!({"kind":"event","type":"ended","state":"content","source":7,"s":3,"eof":true,"duration":10.0,"end":9.9}),
        );
        let t = s.tracks.get_mut(ID).unwrap();
        assert!(t.complete);
        assert_eq!(t.duration, Some(10.0));
        assert_eq!(t.eof_end, Some(9.9));
        t.begin_epoch(10, 21, 8.0, true);
        deliver(&mut s, 1, 8.0, 9.0);
        ended(&mut s, 9.0);
        assert_eq!(s.tracks[ID].eof_end, Some(9.9));
        assert!(s.tracks[ID].soft_error.is_some());
    }
}
