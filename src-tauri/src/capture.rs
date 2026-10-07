//! API 4: unidades confirmadas, caché append-only y tres sesiones (actual + dos siguientes).
//! generation identifica la ventana nativa, epoch un recorrido/seek. EOF no prueba cobertura.
use crate::player::{ForegroundAdmission, RequestTicket};
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
// Keep native observations scheduled in hidden/occluded capture windows. This
// does not change media playbackRate or relax the JS presentation-gap checks.
// Login shares the profile, so its WebView2 environment needs identical args.
pub(crate) const CAPTURE_BROWSER_ARGS: &str = "--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows";
const KEEP: usize = 6;
const MAX_BYTES: usize = 96 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 288 * 1024 * 1024;
const MAX_SEGMENT_BYTES: usize = 4 * 1024 * 1024;
const READ_BYTES: usize = 1024 * 1024;
const READ_CHUNKS: usize = 32;
const HEARTBEAT_STALL: Duration = Duration::from_secs(12);
const PROGRESS_STALL: Duration = Duration::from_secs(60);
const MAX_RESETS: u8 = 2;
const MAX_WAIT: Duration = Duration::from_secs(20 * 60);
const MAX_AD_WAIT_CREDIT: Duration = Duration::from_secs(180);
// Floating point rounding only; this never closes an absent sample.
const RANGE_EPSILON: f64 = 0.000001;
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureLimits {
    pub max_sessions: usize,
    pub prefetch_slots: usize,
    pub track_bytes: usize,
    pub total_bytes: usize,
}
fn configured_limits(
    sessions: Option<&str>,
    track: Option<&str>,
    total: Option<&str>,
) -> Result<CaptureLimits, String> {
    let integer = |value: Option<&str>,
                   name: &str,
                   min: usize,
                   max: usize,
                   fallback: usize|
     -> Result<usize, String> {
        match value {
            None => Ok(fallback),
            Some(value) => value
                .parse::<usize>()
                .ok()
                .filter(|v| (min..=max).contains(v))
                .ok_or_else(|| {
                    format!("CAPTURE_CONFIG: {name} must be an integer in {min}..={max}")
                }),
        }
    };
    let max_sessions = integer(sessions, "MUSIFY_CAPTURE_MAX_SESSIONS", 1, 3, 3)?;
    let track_bytes = integer(
        track,
        "MUSIFY_CAPTURE_TRACK_MB",
        16,
        4096,
        MAX_BYTES / 1024 / 1024,
    )? * 1024
        * 1024;
    let total_bytes = integer(
        total,
        "MUSIFY_CAPTURE_CACHE_MB",
        16,
        4096,
        MAX_TOTAL_BYTES / 1024 / 1024,
    )? * 1024
        * 1024;
    if total_bytes < track_bytes {
        return Err("CAPTURE_CONFIG: cache memory cannot be smaller than track memory".into());
    }
    Ok(CaptureLimits {
        max_sessions,
        prefetch_slots: max_sessions - 1,
        track_bytes,
        total_bytes,
    })
}
pub fn limits() -> Result<CaptureLimits, String> {
    static LIMITS: LazyLock<Result<CaptureLimits, String>> = LazyLock::new(|| {
        configured_limits(
            std::env::var("MUSIFY_CAPTURE_MAX_SESSIONS").ok().as_deref(),
            std::env::var("MUSIFY_CAPTURE_TRACK_MB").ok().as_deref(),
            std::env::var("MUSIFY_CAPTURE_CACHE_MB").ok().as_deref(),
        )
    });
    LIMITS.clone()
}
#[tauri::command]
pub fn capture_limits() -> Result<CaptureLimits, String> {
    limits()
}
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SessionState {
    state: String,
    profile_id: String,
    observed_at: Option<u64>,
    evidence_version: u8,
    generation: u64,
    epoch: u64,
}
impl SessionState {
    fn unknown(generation: u64, epoch: u64) -> Self {
        Self {
            state: "unknown".into(),
            profile_id: String::new(),
            observed_at: None,
            evidence_version: 0,
            generation,
            epoch,
        }
    }
}
#[derive(Clone)]
struct CaptureProfile {
    id: String,
    path: std::path::PathBuf,
}
static ANONYMOUS_PROFILE: std::sync::OnceLock<CaptureProfile> = std::sync::OnceLock::new();
static PROFILE_AUTH: LazyLock<Mutex<Option<SessionState>>> = LazyLock::new(|| Mutex::new(None));
fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
fn capture_profile(app: &AppHandle, mode: Option<&str>) -> Result<CaptureProfile, String> {
    let mode = mode.unwrap_or(if std::env::var_os("MUSIFY_BENCH").is_some() {
        "anonymous"
    } else {
        "default"
    });
    let base = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    match mode {
        "anonymous" => {
            if let Some(profile) = ANONYMOUS_PROFILE.get() {
                return Ok(profile.clone());
            }
            let parent = base.join("capture-profiles");
            std::fs::create_dir_all(&parent).map_err(|e| format!("CAPTURE_PROFILE: {e}"))?;
            let id = format!(
                "anonymous-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            );
            let profile = CaptureProfile {
                path: parent.join(&id),
                id,
            };
            // create_dir fails on collision: an anonymous run must never reuse another run's cookies.
            std::fs::create_dir(&profile.path).map_err(|e| format!("CAPTURE_PROFILE: {e}"))?;
            let _ = ANONYMOUS_PROFILE.set(profile);
            Ok(ANONYMOUS_PROFILE.get().unwrap().clone())
        }
        "premium-manual" => {
            let profile = CaptureProfile {
                id: "premium-manual".into(),
                path: base.join("capture-profiles").join("premium-manual"),
            };
            std::fs::create_dir_all(&profile.path).map_err(|e| format!("CAPTURE_PROFILE: {e}"))?;
            Ok(profile)
        }
        "default" if std::env::var_os("MUSIFY_BENCH").is_none() => Ok(CaptureProfile {
            id: "default".into(),
            path: base.join("yt-engine"),
        }),
        _ => Err("CAPTURE_PROFILE: modo de perfil no válido".into()),
    }
}
/// Shared by legacy and API4 WebViews; benchmark profiles never reuse app cookies.
pub fn profile_directory(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(capture_profile(
        app,
        std::env::var("MUSIFY_BENCH_PROFILE_MODE").ok().as_deref(),
    )?
    .path)
}
#[tauri::command]
pub fn capture_profile_status() -> Value {
    let auth = PROFILE_AUTH.lock().unwrap().clone();
    json!({"sessionState":auth,"loggedIn":auth.as_ref().and_then(|s| match s.state.as_str() { "signed-in" => Some(true), "signed-out" => Some(false), _ => None })})
}
#[tauri::command]
pub async fn capture_profile_open(app: AppHandle, mode: String) -> Result<Value, String> {
    supported()?;
    if mode != "premium-manual" {
        return Err("El acceso manual usa exclusivamente el perfil premium-manual".into());
    }
    let profile = capture_profile(&app, Some(&mode))?;
    let label = "capture-premium-manual";
    if let Some(window) = app.get_webview_window(label) {
        if let Err(error) = crate::capture_mute::enforce_window(&window).await {
            let _ = window.destroy();
            return Err(error);
        }
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    } else {
        *PROFILE_AUTH.lock().unwrap() = Some(SessionState {
            profile_id: profile.id.clone(),
            ..SessionState::unknown(0, 0)
        });
        let script = "(()=>{const send=()=>{let v;try{v=window.ytcfg?.get?.('LOGGED_IN')}catch{};window.chrome?.webview?.postMessage('musify-profile:'+JSON.stringify({state:v===true?'signed-in':v===false?'signed-out':'unknown',evidenceVersion:1}));};setInterval(send,1000);addEventListener('DOMContentLoaded',send)})();";
        let window = WebviewWindowBuilder::new(
            &app,
            label,
            WebviewUrl::External("about:blank".parse().unwrap()),
        )
        .title("Musify · acceso manual a YouTube Premium")
        .data_directory(profile.path.clone())
        .additional_browser_args(CAPTURE_BROWSER_ARGS)
        .visible(false)
        .focused(false)
        .inner_size(1080.0, 780.0)
        .initialization_script(script)
        .build()
        .map_err(|e| format!("CAPTURE_PROFILE: {e}"))?;
        let (tx, rx) = tokio::sync::oneshot::channel();
        let profile_id = profile.id.clone();
        let result = async {
            window
                .with_webview(move |pw| {
                    #[cfg(windows)]
                    let result =
                        unsafe { attach_profile(&pw, &profile_id) }.map_err(|e| e.to_string());
                    #[cfg(not(windows))]
                    let result: Result<(), String> = {
                        let _ = (pw, profile_id);
                        Err("CAPTURE_UNSUPPORTED_PLATFORM".into())
                    };
                    let _ = tx.send(result);
                })
                .map_err(|e| e.to_string())?;
            tokio::time::timeout(Duration::from_secs(10), rx)
                .await
                .map_err(|_| "CAPTURE_PROFILE_TIMEOUT")?
                .map_err(|_| "CAPTURE_PROFILE_CLOSED")?
        }
        .await;
        if let Err(error) = result {
            let _ = window.destroy();
            return Err(error);
        }
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    // Only this local setup response includes the private directory; status/evidence never do.
    Ok(
        json!({"profileId":profile.id,"privateProfilePath":profile.path,"sessionState":PROFILE_AUTH.lock().unwrap().clone()}),
    )
}
#[cfg(windows)]
unsafe fn attach_profile(
    pw: &tauri::webview::PlatformWebview,
    profile_id: &str,
) -> windows_core::Result<()> {
    use webview2_com::{WebMessageReceivedEventHandler, take_pwstr};
    use windows_core::{HSTRING, PWSTR};
    let profile_id = profile_id.to_string();
    unsafe {
        let core = pw.controller().CoreWebView2()?;
        crate::capture_mute::enforce(&core)?;
        let handler = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut source = PWSTR::null();
            args.Source(&mut source)?;
            if source_kind(&take_pwstr(source)) != Some(true) {
                return Ok(());
            }
            let mut text = PWSTR::null();
            if args.TryGetWebMessageAsString(&mut text).is_ok() {
                if let Some(data) = take_pwstr(text).strip_prefix("musify-profile:") {
                    if let Ok(value) = serde_json::from_str::<Value>(data) {
                        let state = value["state"]
                            .as_str()
                            .filter(|v| matches!(*v, "signed-in" | "signed-out" | "unknown"))
                            .unwrap_or("unknown");
                        *PROFILE_AUTH.lock().unwrap() = Some(SessionState {
                            state: state.into(),
                            profile_id: profile_id.clone(),
                            observed_at: Some(unix_ms()),
                            evidence_version: 1,
                            generation: 0,
                            epoch: 0,
                        });
                    }
                }
            }
            Ok(())
        }));
        let mut token = 0;
        core.add_WebMessageReceived(&handler, &mut token)?;
        core.Navigate(&HSTRING::from("https://music.youtube.com/"))
    }
}
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
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum CaptureSurface {
    Music,
    Youtube,
}
impl CaptureSurface {
    fn origin(self) -> &'static str {
        match self {
            Self::Music => "https://music.youtube.com",
            Self::Youtube => "https://www.youtube.com",
        }
    }
    fn initial(benchmark: bool, configured: Option<&str>) -> Self {
        if benchmark && configured == Some("youtube") {
            Self::Youtube
        } else {
            Self::Music
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
struct TimelineFailure {
    previous: TimelineSettings,
    next_window_start: f64,
    mime: String,
}
impl TimelineFailure {
    fn parse(error: &str) -> Option<Self> {
        let rest = error.strip_prefix(
            "CAPTURE_UNSUPPORTED_TIMELINE: SourceBuffer settings changed: previous=",
        )?;
        let (previous, rest) = rest.split_once(", current=")?;
        let (current, mime) = rest.rsplit_once(", mime=")?;
        if mime.len() > 128 || !mime.starts_with("audio/") {
            return None;
        }
        let previous = TimelineSettings::from_message(&serde_json::from_str(previous).ok()?)?;
        let current = TimelineSettings::from_message(&serde_json::from_str(current).ok()?)?;
        // The next track's end varies. It must not disguise the same incompatible
        // transition away from this exact original presentation window.
        Some(Self {
            previous,
            next_window_start: current.append_window_start,
            mime: mime.into(),
        })
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
    first_frame: u64,
    end_frame: u64,
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
            first_frame: m.first_frame?,
            end_frame: m.end_frame?,
            timeline_settings: TimelineSettings::from_message(m.timeline_settings.as_ref()?)?,
        };
        (m.verified == Some(true)
            && result.frames > 0
            && result.end_frame.checked_sub(result.first_frame) == Some(result.frames)
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
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompleteCertificate {
    kind: String,
    epoch: u64,
    source: u64,
    s: u64,
    init_key: String,
    mime: String,
    timeline_settings: TimelineSettings,
    frame_count: u64,
    range_start: f64,
    range_end: f64,
    quantum: f64,
    clean_whole_source: bool,
    native_continuous: bool,
    official_eof: bool,
}
impl CompleteCertificate {
    fn binding(&self, unit: &Unit, generation: u64) -> bool {
        unit.generation == generation
            && unit.epoch == self.epoch
            && unit.source == self.source
            && unit.s == self.s
            && unit.init_key == self.init_key
            && unit.mime == self.mime
            && unit.timeline_settings == self.timeline_settings
    }
    fn validates(&self, track: &Track, end: f64) -> bool {
        if self.kind != "complete-source-v1"
            || !self.clean_whole_source
            || !self.native_continuous
            || !self.official_eof
            || self.epoch != track.epoch
            || track.target != 0.0
            || self.frame_count == 0
            || !self.timeline_settings.valid()
            || !self.range_start.is_finite()
            || !self.range_end.is_finite()
            || !self.quantum.is_finite()
            || self.range_start < 0.0
            || self.range_start > RANGE_EPSILON
            || self.range_end <= self.range_start
            || self.quantum <= 0.0
            || self.quantum > 0.001
            || self.range_end != end
            || track.accepted != Some((self.epoch, self.source, self.s))
        {
            return false;
        }
        let mut units: Vec<_> = track
            .units
            .iter()
            .filter(|u| self.binding(u, track.generation))
            .collect();
        units.sort_by_key(|u| u.first_frame);
        let mut frame = 0;
        let mut range_end = self.range_start;
        for unit in units {
            // Every presented sample occurs exactly once, in this immutable source. Neither
            // a later epoch nor a neighbouring source may repair its missing inventory.
            if unit.first_frame != frame
                || unit.end_frame > self.frame_count
                || unit.end_frame - unit.first_frame != unit.frames
                || unit.range_start + RANGE_EPSILON < range_end
                || unit.range_start - range_end > self.quantum + RANGE_EPSILON
                || unit.range_end > self.range_end + RANGE_EPSILON
            {
                return false;
            }
            frame = unit.end_frame;
            range_end = unit.range_end;
        }
        frame == self.frame_count && (range_end - self.range_end).abs() <= RANGE_EPSILON
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
#[derive(Clone, Copy)]
struct AdMarkerObservation {
    generation: u64,
    epoch: u64,
    source: u64,
    sequence: u64,
    playback_rate: f64,
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
    recovery_blocked: bool,
    timeline_failures: Vec<TimelineFailure>,
    capture_surface: CaptureSurface,
    restart_from_zero: bool,
    why: Option<String>,
    last_diagnostic: Option<String>,
    session_state: SessionState,
    session_states: Vec<SessionState>,
    unknown_auth_units: u64,
    signed_in_units: u64,
    ad_source: Option<u64>,
    ad_marker: Option<AdMarkerObservation>,
    native_skip: Option<SkipRequest>,
    native_skip_started: Option<Instant>,
    last_skip_request: u64,
    last_skip_result: Option<Value>,
    native_skip_requests: u64,
    native_skip_dispatches: u64,
    native_skip_trusted_clicks: u64,
    eof: bool,
    certificates: Vec<Value>,
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
    ad_transitions: Vec<Value>,
    ad_transitions_total: usize,
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
            recovery_blocked: false,
            timeline_failures: Vec::new(),
            capture_surface: CaptureSurface::initial(
                std::env::var_os("MUSIFY_BENCH").is_some(),
                std::env::var("MUSIFY_BENCH_SURFACE").ok().as_deref(),
            ),
            restart_from_zero: false,
            why: None,
            last_diagnostic: None,
            session_state: SessionState::unknown(generation, epoch),
            session_states: Vec::new(),
            unknown_auth_units: 0,
            signed_in_units: 0,
            ad_source: None,
            ad_marker: None,
            native_skip: None,
            native_skip_started: None,
            last_skip_request: 0,
            last_skip_result: None,
            native_skip_requests: 0,
            native_skip_dispatches: 0,
            native_skip_trusted_clicks: 0,
            eof: false,
            certificates: Vec::new(),
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
            ad_transitions: Vec::new(),
            ad_transitions_total: 0,
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
            self.last_skip_request = 0;
            self.native_skip = None;
            self.native_skip_started = None;
        }
        self.generation = generation;
        self.epoch = epoch;
        self.ad_source = None;
        self.ad_marker = None;
        self.session_state = SessionState {
            profile_id: self.session_state.profile_id.clone(),
            ..SessionState::unknown(generation, epoch)
        };
        self.target = target;
        self.restart_from_zero = false;
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
    fn report_failure(&mut self, error: String, recoverable: bool) {
        if let Some(fingerprint) = TimelineFailure::parse(&error) {
            if self.timeline_failures.contains(&fingerprint) || self.timeline_failures.len() >= 16 {
                self.recovery_blocked = true;
                let error = format!(
                    "CAPTURE_UNSUPPORTED_TIMELINE: automatic recovery stopped after a repeated incompatible SourceBuffer transition; confirmed audio is retained. {error}"
                );
                // Override an earlier soft notice so the terminal reason is visible.
                if self.ready() {
                    self.soft_error = None;
                } else {
                    self.error = None;
                }
                self.fail(error);
                return;
            }
            if self.capture_surface == CaptureSurface::Music
                && fingerprint.mime.starts_with("audio/mp4")
            {
                self.capture_surface = CaptureSurface::Youtube;
                self.restart_from_zero = true;
            }
            self.timeline_failures.push(fingerprint);
        }
        self.fail(error);
        self.recovering = recoverable && !self.recovery_blocked && self.resets < MAX_RESETS;
    }
    fn recovery_allowed(&self) -> bool {
        !self.recovery_blocked && self.resets < MAX_RESETS
    }
    fn require_recovery(&self) -> Result<(), String> {
        if self.recovery_blocked {
            Err(self
                .soft_error
                .as_ref()
                .or(self.error.as_ref())
                .cloned()
                .unwrap_or_else(|| {
                    "CAPTURE_UNSUPPORTED_TIMELINE: automatic recovery is stopped".into()
                }))
        } else {
            Ok(())
        }
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
    fn recovery_start(&self) -> f64 {
        // A seek cannot certify quantization between old epochs. Re-present the
        // original source from zero instead of repeating the same sub-packet seek.
        // This does not fill or forgive any gap: a new complete proof is required.
        if self.restart_from_zero
            || (self.eof
                && self.ranges.windows(2).any(|r| {
                    let gap = r[1].start - r[0].end;
                    gap > RANGE_EPSILON && gap <= 0.001 + RANGE_EPSILON
                }))
        {
            0.0
        } else {
            self.first_gap()
        }
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
    next_slot: Option<u8>,
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
    fn foreground_reserve(&self, incoming_id: &str, limits: CaptureLimits) -> usize {
        if self
            .session(incoming_id)
            .is_some_and(|session| session.foreground)
        {
            return 0;
        }
        let current_bytes = self
            .foreground
            .as_ref()
            .and_then(|(id, _)| self.tracks.get(id))
            .map_or(0, |track| track.bytes);
        limits.track_bytes.saturating_sub(current_bytes)
    }
    fn trim(&mut self, keep: &str, incoming: usize) {
        let Ok(limits) = limits() else { return };
        while self.tracks.len() > KEEP
            || self.total_bytes().saturating_add(incoming) > limits.total_bytes
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
    fn victim(&self, id: &str, foreground: bool, next_slot: Option<u8>) -> Option<Session> {
        self.sessions
            .iter()
            .find(|s| {
                !s.active
                    || (s.id != id
                        && s.foreground == foreground
                        && (foreground || s.next_slot == next_slot))
            })
            .cloned()
    }
    fn promote(&mut self, id: &str, ticket: Option<RequestTicket>) {
        self.foreground = Some((id.into(), ticket));
        if let Some(session) = self.sessions.iter_mut().find(|s| s.active && s.id == id) {
            session.foreground = true;
            session.next_slot = None;
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
    limits()?;
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
    admission: Option<ForegroundAdmission>,
) -> Result<Meta, String> {
    supported()?;
    request_current(ticket)?;
    if !valid_id(video_id) {
        return Err("id de vídeo no válido".into());
    }
    // El contador se toma dentro de la misma admisión serializada que abre/promueve la sesión.
    let cancellation = begin(
        app,
        video_id,
        refresh,
        foreground,
        ticket,
        ticket.and_then(|t| t.prefetch_slot),
        None,
        false,
    )
    .await?;
    request_current(ticket)?;
    // La plaza ya es foreground: next no puede retirar esta sesión al ganar TRANSITION.
    // Emitir antes de begin permitiría que C retirase B cuando B aún era next.
    if foreground {
        if let Some(admission) = admission {
            admission.emit(app, ticket, video_id);
        }
    }
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
    next_slot: Option<u8>,
    at: Option<f64>,
    recovery: bool,
) -> Result<u64, String> {
    let _guard = TRANSITION.lock().await;
    begin_locked(
        app, id, refresh, foreground, ticket, next_slot, at, recovery,
    )
    .await?;
    Ok(STATE.lock().unwrap().cancellation(id))
}
async fn begin_locked(
    app: &AppHandle,
    id: &str,
    refresh: bool,
    foreground: bool,
    ticket: Option<RequestTicket>,
    next_slot: Option<u8>,
    at: Option<f64>,
    recovery: bool,
) -> Result<u64, String> {
    supported()?;
    let at = if recovery && at == Some(0.0) {
        None
    } else {
        at
    };
    if !recovery {
        request_current(ticket)?;
    }
    if !valid_id(id) {
        return Err("id de vídeo no válido".into());
    }
    if !refresh {
        if let Some(track) = STATE.lock().unwrap().tracks.get(id) {
            track.require_recovery()?;
        }
    }
    let next_slot = if foreground {
        None
    } else {
        Some(next_slot.unwrap_or(0))
    };
    let capture_limits = limits()?;
    if next_slot.is_some_and(|slot| slot as usize >= capture_limits.prefetch_slots) {
        return Err("CAPTURE_BUSY: plaza de precarga deshabilitada por la configuración".into());
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
                next.next_slot = next_slot;
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
            .or_else(|| state.victim(id, foreground, next_slot))
    };
    if let Some(old) = old {
        retire_locked(app, &old).await?;
    }
    if !recovery {
        request_current(ticket)?;
    }
    if STATE.lock().unwrap().sessions.len() >= limits()?.max_sessions {
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
            next_slot,
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
fn audit_enabled() -> bool {
    std::env::var_os("MUSIFY_BENCH").is_some()
        && std::env::var("MUSIFY_BENCH_AUDIT_ALL_AUDIO")
            .ok()
            .as_deref()
            == Some("1")
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
    let surface = STATE
        .lock()
        .unwrap()
        .tracks
        .get(id)
        .filter(|t| t.generation == generation)
        .map(|t| t.capture_surface)
        .ok_or("CAPTURE_CANCELLED: capture surface lease was replaced")?;
    let url = format!("{}/watch?v={id}{start}", surface.origin());
    let target = serde_json::to_string(id).map_err(|e| e.to_string())?;
    let progressive = progressive_experiment_enabled();
    let audit = audit_enabled();
    let profile = capture_profile(
        app,
        std::env::var("MUSIFY_BENCH_PROFILE_MODE").ok().as_deref(),
    )?;
    if let Some(track) = STATE
        .lock()
        .unwrap()
        .tracks
        .get_mut(id)
        .filter(|t| t.generation == generation)
    {
        track.session_state.profile_id = profile.id.clone();
    }
    let max_bytes = limits()?.track_bytes;
    let holdback = if std::env::var_os("MUSIFY_BENCH").is_some() {
        std::env::var("MUSIFY_BENCH_HOLDBACK_SECONDS")
            .ok()
            .and_then(|s| s.parse::<f64>().ok())
            .filter(|s| s.is_finite() && *s >= 0.0 && *s <= 30.0)
            .unwrap_or(1.5)
    } else {
        1.5
    };
    let script = format!(
        "Object.defineProperty(window,'__musifyGeneration',{{value:{generation},writable:false}});Object.defineProperty(window,'__musifyTarget',{{value:{target},writable:false}});Object.defineProperty(window,'__musifyProgressiveExperiment',{{value:{progressive},writable:false}});Object.defineProperty(window,'__musifyBenchmarkAudit',{{value:{audit},writable:false}});window.__musifyEpoch={epoch};window.__musifyHoldbackSeconds={holdback};window.__musifyMaxBytes={max_bytes};\n{}",
        crate::extractors::capture_script()
    );
    let window = WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::External("about:blank".parse().unwrap()),
    )
    .title("Musify · reproductor de YouTube")
    .data_directory(profile.path)
    .additional_browser_args(CAPTURE_BROWSER_ARGS)
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
        crate::capture_mute::enforce(&core)?;
        let click_core = core.clone();
        let handler = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut source = PWSTR::null();
            args.Source(&mut source)?;
            let source = take_pwstr(source);
            let mut text = PWSTR::null();
            if args.TryGetWebMessageAsString(&mut text).is_ok() {
                let text = take_pwstr(text);
                if let Some(json) = text.strip_prefix("musify-audit:") {
                    if audit_enabled() {
                        crate::capture_audit::receive(&id, generation, &source, json);
                    }
                }
                if let Some(json) = text.strip_prefix("musify:") {
                    if let Some(request) = receive(&id, generation, &source, json) {
                        native_click::start(click_core.clone(), id.clone(), request);
                    }
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
    first_frame: Option<u64>,
    end_frame: Option<u64>,
    certificate: Option<CompleteCertificate>,
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
    // Optional diagnostic data must not change protocol acceptance when malformed.
    browser_now: Option<Value>,
    evidence_version: Option<u8>,
    request_id: Option<u64>,
    button_token: Option<u64>,
    x: Option<f64>,
    y: Option<f64>,
    viewport_width: Option<f64>,
    viewport_height: Option<f64>,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkipRequest {
    request_id: u64,
    generation: u64,
    epoch: u64,
    source: u64,
    button_token: u64,
    x: f64,
    y: f64,
    viewport_width: f64,
    viewport_height: f64,
}
impl SkipRequest {
    fn from_message(m: &Message) -> Option<Self> {
        let request = Self {
            request_id: m.request_id?,
            generation: m.generation?,
            epoch: m.epoch?,
            source: m.source?,
            button_token: m.button_token?,
            x: m.x?,
            y: m.y?,
            viewport_width: m.viewport_width?,
            viewport_height: m.viewport_height?,
        };
        let safe = |n| n > 0 && n <= 9_007_199_254_740_991u64;
        (safe(request.request_id)
            && safe(request.button_token)
            && safe(request.source)
            && [
                request.x,
                request.y,
                request.viewport_width,
                request.viewport_height,
            ]
            .iter()
            .all(|v| v.is_finite())
            && request.x >= 0.0
            && request.y >= 0.0
            && request.x < request.viewport_width
            && request.y < request.viewport_height)
            .then_some(request)
    }
    fn validation_result(&self, value: &Value) -> Result<(), String> {
        if value["valid"] != true {
            // This is a closed diagnostic vocabulary, never arbitrary page/DOM text.
            let reason = match value["reason"].as_str() {
                Some(
                    "stale-request"
                    | "request-expired"
                    | "source-changed"
                    | "not-ad"
                    | "button-ineligible"
                    | "button-moved-or-covered"
                    | "capture-failed",
                ) => value["reason"].as_str().unwrap(),
                _ => "page-rejected-or-unavailable",
            };
            return Err(format!("dom-{reason}"));
        }
        for (field, expected) in [
            ("requestId", self.request_id),
            ("generation", self.generation),
            ("epoch", self.epoch),
            ("source", self.source),
            ("buttonToken", self.button_token),
        ] {
            // ExecuteScript serializes Chromium doubles, while the request arrives
            // through JSON.stringify. A safe JS integer may therefore be `1791... .0`
            // or exponent notation; serde's u64 deserializer rejects that JSON form.
            // Accept the same exact numeric value, never a string, fraction or >2^53-1.
            let actual = value[field]
                .as_f64()
                .filter(|n| {
                    n.is_finite() && *n > 0.0 && *n <= 9_007_199_254_740_991.0 && n.fract() == 0.0
                })
                .ok_or_else(|| format!("validation-{field}-not-safe-integer"))?;
            if actual as u64 != expected {
                return Err(format!("validation-{field}-mismatch"));
            }
        }
        for (field, expected) in [
            ("x", self.x),
            ("y", self.y),
            ("viewportWidth", self.viewport_width),
            ("viewportHeight", self.viewport_height),
        ] {
            if value[field].as_f64().filter(|n| n.is_finite()) != Some(expected) {
                return Err(format!("validation-{field}-mismatch"));
            }
        }
        Ok(())
    }
    #[cfg(test)]
    fn validated(&self, value: &Value) -> bool {
        self.validation_result(value).is_ok()
    }
}
#[derive(Deserialize)]
struct SkipValidationReply {
    origin: String,
    validation: Value,
}
impl SkipValidationReply {
    fn validate(output: &str, request: &SkipRequest, expected_origin: &str) -> Result<(), String> {
        // ExecuteScript returns a JSON object directly, not Runtime.evaluate's
        // RemoteObject envelope. Keep the two contracts distinct and fail closed.
        let reply: Self = serde_json::from_str(output)
            .map_err(|_| "validation-invalid-execute-script-reply".to_string())?;
        if ![
            CaptureSurface::Music.origin(),
            CaptureSurface::Youtube.origin(),
        ]
        .contains(&expected_origin)
            || reply.origin != expected_origin
        {
            return Err("validation-origin-mismatch".into());
        }
        request.validation_result(&reply.validation)
    }
}
fn skip_current(state: &Supervisor, id: &str, request: &SkipRequest) -> bool {
    state.owns(id, request.generation)
        && state.tracks.get(id).is_some_and(|t| {
            t.generation == request.generation
                && t.epoch == request.epoch
                && t.phase == "ad"
                && !t.epoch_done
                && t.ad_source == Some(request.source)
                && t.native_skip.as_ref() == Some(request)
                && t.native_skip_started
                    .is_some_and(|at| at.elapsed() < Duration::from_secs(2))
        })
}
#[derive(Clone)]
struct JournalUnit {
    metadata: Value,
    path: std::path::PathBuf,
}
#[derive(Default)]
struct BenchLedger {
    bytes: usize,
    units: HashMap<String, Vec<JournalUnit>>,
    states: HashMap<String, Value>,
    errors: HashMap<String, String>,
}
static BENCH_LEDGER: LazyLock<Mutex<BenchLedger>> =
    LazyLock::new(|| Mutex::new(BenchLedger::default()));
fn journal_directory() -> Result<&'static std::path::PathBuf, String> {
    static DIRECTORY: std::sync::OnceLock<Result<std::path::PathBuf, String>> =
        std::sync::OnceLock::new();
    DIRECTORY
        .get_or_init(|| {
            let parent = std::env::temp_dir().join("musify-capture-journal.local");
            std::fs::create_dir_all(&parent).map_err(|_| {
                "CAPTURE_AUDIT_IO: cannot create private journal directory".to_string()
            })?;
            let path = parent.join(format!(
                "{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ));
            std::fs::create_dir(&path)
                .map_err(|_| "CAPTURE_AUDIT_IO: cannot create fresh journal".to_string())?;
            Ok(path)
        })
        .as_ref()
        .map_err(Clone::clone)
}
fn journal_unit(
    id: &str,
    revision: u64,
    unit: &Unit,
    auth: &SessionState,
    bytes: &[u8],
) -> Result<(), String> {
    if std::env::var_os("MUSIFY_BENCH").is_none() {
        return Ok(());
    }
    let result = (|| {
        let cap = match std::env::var("MUSIFY_BENCH_LEDGER_MB").ok() {
            None => 1024usize,
            Some(value) => value
                .parse::<usize>()
                .ok()
                .filter(|v| (16..=16384).contains(v))
                .ok_or("CAPTURE_CONFIG: MUSIFY_BENCH_LEDGER_MB must be16..16384")?,
        } * 1024
            * 1024;
        let directory = journal_directory()?;
        let mut ledger = BENCH_LEDGER.lock().unwrap();
        persist_journal_unit(&mut ledger, directory, cap, id, revision, unit, auth, bytes)
    })();
    if let Err(error) = &result {
        BENCH_LEDGER
            .lock()
            .unwrap()
            .errors
            .insert(id.into(), error.clone());
    }
    result
}
fn persist_journal_unit(
    ledger: &mut BenchLedger,
    directory: &std::path::Path,
    cap: usize,
    id: &str,
    revision: u64,
    unit: &Unit,
    auth: &SessionState,
    bytes: &[u8],
) -> Result<(), String> {
    if ledger.bytes.saturating_add(bytes.len()) > cap {
        return Err("CAPTURE_AUDIT_CAPACITY: persistent published-unit journal is full".into());
    }
    let path = directory.join(format!(
        "{}-{}-{}-{}-{}.unit",
        unit.generation, unit.epoch, unit.source, unit.s, unit.unit
    ));
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|_| "CAPTURE_AUDIT_IO: cannot create unique unit")?;
    file.write_all(bytes)
        .map_err(|_| "CAPTURE_AUDIT_IO: cannot preserve published bytes")?;
    file.flush()
        .map_err(|_| "CAPTURE_AUDIT_IO: cannot flush published bytes")?;
    let mut metadata =
        serde_json::to_value(unit).map_err(|_| "CAPTURE_AUDIT_IO: cannot serialize proof")?;
    metadata["revision"] = json!(revision);
    metadata["sessionState"] = serde_json::to_value(auth).unwrap();
    ledger
        .units
        .entry(id.into())
        .or_default()
        .push(JournalUnit { metadata, path });
    ledger.bytes += bytes.len();
    Ok(())
}
fn journal_state(id: &str, t: &Track) {
    if std::env::var_os("MUSIFY_BENCH").is_none() {
        return;
    }
    let snapshot = json!({"videoId":id,"api":4,"revision":t.revision,"generation":t.generation,"epoch":t.epoch,
        "complete":t.complete,"eof":t.eof,"eofEnd":t.eof_end,"duration":t.duration,"ranges":t.ranges,
        "error":t.error,"softError":t.soft_error,"recoveryBlocked":t.recovery_blocked,"captureSurface":t.capture_surface,"recovering":t.recovering,"bytesQuarantined":t.quarantined,"pendingProof":t.proof,
        "certificates":t.certificates,"sessionState":t.session_state,"sessionStates":t.session_states,
        "unknownAuthUnits":t.unknown_auth_units,"signedInUnits":t.signed_in_units,"currentUnits":t.units.len(),"allPublishedUnits":true});
    BENCH_LEDGER
        .lock()
        .unwrap()
        .states
        .insert(id.into(), snapshot);
}
fn source_kind(source: &str) -> Option<bool> {
    let url = reqwest::Url::parse(source).ok()?;
    if url.scheme() != "https" || url.port_or_known_default() != Some(443) {
        return None;
    }
    match url.host_str()? {
        "music.youtube.com" | "www.youtube.com" => Some(true),
        "consent.youtube.com" => Some(false),
        _ => None,
    }
}
fn consent_diagnostic(
    enabled: bool,
    detail: &Value,
    generation: u64,
    epoch: u64,
    browser_now: Option<&Value>,
) -> Option<Value> {
    if !enabled {
        return None;
    }
    let phase = detail["phase"]
        .as_str()
        .filter(|phase| matches!(*phase, "inline-consent" | "inline-consent-attempt"))?;
    let copy_fields = |input: &Value| -> Option<Value> {
        input.as_object()?;
        let mut output = json!({});
        for field in [
            "present",
            "visible",
            "eligible",
            "attempted",
            "dispatched",
            "controlsTruncated",
            "seenVisible",
            "rejectDispatched",
            "closedAfterAttempt",
        ] {
            if let Some(value) = input.get(field) {
                output[field] = json!(value.as_bool()?);
            }
        }
        for field in [
            "dialogCount",
            "buttonCount",
            "nativeButtons",
            "roleButtons",
            "renderedButtons",
            "enabledButtons",
            "rejectTextMatches",
            "rejectAriaMatches",
            "ariaDifferent",
            "blockedButtons",
        ] {
            if let Some(value) = input.get(field) {
                output[field] = json!(value.as_u64().filter(|value| *value <= 32)?);
            }
        }
        Some(output)
    };
    let mut output = copy_fields(detail)?;
    output["phase"] = json!(phase);
    output["generation"] = json!(generation);
    output["epoch"] = json!(epoch);
    if let Some(now) = browser_now {
        output["browserNow"] = json!(now.as_f64().filter(|value| value.is_finite()
            && *value >= 0.0
            && *value <= 9_007_199_254_740_991.0)?);
    }
    if let Some(consent) = detail.get("consent") {
        let mut clean = copy_fields(consent)?;
        if let Some(last) = consent.get("lastVisible") {
            clean["lastVisible"] = copy_fields(last)?;
        }
        output["consent"] = clean;
    }
    Some(output)
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
        || m.api != Some(4)
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
    let Ok(limits) = limits() else { return false };
    let foreground_reserve = state.foreground_reserve(id, limits);
    state.trim(
        id,
        m.data
            .as_ref()
            .map_or(0, |d| d.len().saturating_mul(3) / 4)
            .saturating_add(foreground_reserve),
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
            if t.units.iter().any(|old| {
                old.generation == unit.generation
                    && old.epoch == unit.epoch
                    && old.source == unit.source
                    && old.s == unit.s
                    && old.first_frame < unit.end_frame
                    && unit.first_frame < old.end_frame
            }) {
                t.fail("CAPTURE_PROTOCOL: inventario de muestras duplicado en una fuente".into());
                return true;
            }
            {
                if t.bytes.saturating_add(bytes.len()) > limits.track_bytes
                    || total_bytes
                        .saturating_add(bytes.len())
                        .saturating_add(foreground_reserve)
                        > limits.total_bytes
                {
                    t.fail("CAPTURE_CAPACITY: audio excede el límite de memoria".into());
                    return true;
                }
                unit.index = t.units.len();
                if let Err(error) = journal_unit(id, t.revision, &unit, &t.session_state, &bytes) {
                    t.fail(error);
                    return true;
                }
                t.bytes += bytes.len();
                union(
                    &mut t.ranges,
                    Range {
                        start: unit.range_start,
                        end: unit.range_end,
                    },
                );
                match t.session_state.state.as_str() {
                    "signed-in" => t.signed_in_units += 1,
                    "signed-out" if t.session_state.evidence_version == 1 => {}
                    _ => t.unknown_auth_units += 1,
                }
                t.units.push(unit);
                t.chunks.push(bytes);
                t.first_ms.get_or_insert(ms);
            }
            t.last_progress = now;
            t.recovering = false;
            t.soft_error = None;
        }
        "event" => {
            let mut explicit_ad_marker = false;
            if m.event.as_deref() == Some("diagnostic") {
                if let Some(reason) = m.reason.as_deref() {
                    t.last_diagnostic = Some(reason.chars().take(2048).collect());
                    if let Ok(detail) = serde_json::from_str::<Value>(reason) {
                        if let Some(diagnostic) = consent_diagnostic(
                            std::env::var_os("MUSIFY_BENCH").is_some(),
                            &detail,
                            generation,
                            t.epoch,
                            m.browser_now.as_ref(),
                        ) {
                            eprintln!("[capture-consent] {diagnostic}");
                        }
                        explicit_ad_marker = detail["evidence"]["adMarker"] == true;
                        if detail["phase"] == "native-skip-result" {
                            if let Some(result) = t.last_skip_result.as_mut().filter(|r| {
                                r["requestId"] == detail["requestId"]
                                    && r.get("eventSeen").is_none()
                            }) {
                                let last = &detail["skip"]["last"];
                                result["eventSeen"] = last["eventSeen"].clone();
                                result["isTrusted"] = last["isTrusted"].clone();
                                result["defaultPrevented"] = last["defaultPrevented"].clone();
                                if last["eventSeen"] == true && last["isTrusted"] == true {
                                    t.native_skip_trusted_clicks += 1;
                                }
                            }
                        }
                    }
                }
            }
            if let Some(phase) = m.state.as_deref().filter(|s| {
                m.event.as_deref() != Some("auth") && {
                    matches!(
                        *s,
                        "unknown" | "content" | "ad" | "ambiguous" | "interaction"
                    )
                }
            }) {
                if t.phase == "ad" && phase == "content" {
                    if let Some(ad_source) = t.ad_source {
                        let marker = t.ad_marker.filter(|marker| {
                            marker.generation == generation
                                && marker.epoch == t.epoch
                                && marker.source == ad_source
                                && m.sequence
                                    .is_some_and(|sequence| marker.sequence < sequence)
                        });
                        t.ad_transitions_total += 1;
                        if t.ad_transitions.len() < 256 {
                            t.ad_transitions.push(json!({"generation":generation,"epoch":t.epoch,"source":ad_source,"contentSource":m.source,
                                "sequence":m.sequence,"from":"ad","to":"content","observed":true,
                                "markerObserved":marker.is_some(),"markerSequence":marker.map(|m|m.sequence),"markerPlaybackRate":marker.map(|m|m.playback_rate)}));
                        }
                    }
                }
                t.phase = phase.into();
                if phase != "content" {
                    t.proof = None;
                }
                if phase == "ad" {
                    // A different presented video alone also produces state=ad. Only an
                    // explicit player marker at 1x qualifies this source's later transition.
                    if t.ad_source != m.source {
                        t.ad_marker = None;
                    }
                    if music && explicit_ad_marker && m.playback_rate == Some(1.0) {
                        if let (Some(source), Some(sequence)) = (m.source, m.sequence) {
                            t.ad_marker.get_or_insert(AdMarkerObservation {
                                generation,
                                epoch: t.epoch,
                                source,
                                sequence,
                                playback_rate: 1.0,
                            });
                        }
                    }
                    t.ad_source = m.source;
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
                    t.ad_source = None;
                    t.ad_marker = None;
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
                Some("skip-request") if music => {
                    if let Some(request) = SkipRequest::from_message(&m) {
                        if t.phase == "ad"
                            && t.ad_source == Some(request.source)
                            && t.native_skip.is_none()
                            && request.request_id > t.last_skip_request
                            && t.native_skip_started.is_none_or(|previous| {
                                now.duration_since(previous) >= Duration::from_secs(1)
                            })
                        {
                            t.last_skip_request = request.request_id;
                            t.native_skip_requests += 1;
                            t.native_skip_started = Some(now);
                            t.native_skip = Some(request);
                        }
                    }
                }
                Some("auth") if music => {
                    let auth = m
                        .state
                        .as_deref()
                        .filter(|state| matches!(*state, "signed-in" | "signed-out" | "unknown"))
                        .unwrap_or("unknown");
                    if m.evidence_version == Some(1) {
                        let observed = SessionState {
                            state: auth.into(),
                            profile_id: t.session_state.profile_id.clone(),
                            observed_at: Some(unix_ms()),
                            evidence_version: 1,
                            generation,
                            epoch: t.epoch,
                        };
                        if observed.state != t.session_state.state
                            || observed.generation != t.session_state.generation
                            || observed.epoch != t.session_state.epoch
                            || t.session_state.observed_at.is_none()
                        {
                            t.session_states.push(observed.clone());
                        }
                        t.session_state = observed;
                    }
                }
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
                        if let Some(certificate) = &m.certificate {
                            if !certificate.validates(t, m.end.unwrap()) {
                                t.fail("CAPTURE_PROTOCOL: certificado EOF no coincide con el inventario íntegro de esta fuente".into());
                                return true;
                            }
                            let mut proof = serde_json::to_value(certificate).unwrap();
                            proof["generation"] = json!(generation);
                            t.certificates.push(proof);
                            // Only this bound complete-source certificate closes codec quantization.
                            // The general union remains strict for every partial/seek source.
                            union(
                                &mut t.ranges,
                                Range {
                                    start: certificate.range_start,
                                    end: certificate.range_end,
                                },
                            );
                        }
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
                    t.report_failure(error, m.recoverable == Some(true));
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
    journal_state(id, t);
    finished
}
fn receive(id: &str, generation: u64, source: &str, data: &str) -> Option<SkipRequest> {
    if source_kind(source).is_none() {
        return None;
    }
    if data.len() > MAX_SEGMENT_BYTES.div_ceil(3) * 4 + 16 * 1024 {
        fail_session(id, generation, "CAPTURE_CAPACITY: mensaje demasiado grande");
        return None;
    }
    let Ok(message) = serde_json::from_str::<Message>(data) else {
        return None;
    };
    let sequence = message.sequence;
    let skip = message.event.as_deref() == Some("skip-request");
    let mut state = STATE.lock().unwrap();
    let previous = state.tracks.get(id).and_then(|t| t.sequence);
    let pending = state
        .tracks
        .get(id)
        .is_some_and(|t| t.native_skip.is_some());
    apply_message(&mut state, id, generation, source, message, Instant::now());
    if skip && !pending && sequence != previous {
        state
            .tracks
            .get(id)
            .filter(|t| t.sequence == sequence)
            .and_then(|t| t.native_skip.clone())
    } else {
        None
    }
}
#[cfg(windows)]
mod native_click {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;
    use webview2_com::{CallDevToolsProtocolMethodCompletedHandler, ExecuteScriptCompletedHandler};
    use windows_core::HSTRING;

    struct Click {
        core: ICoreWebView2,
        id: String,
        request: SkipRequest,
        origin: &'static str,
        pressed: Cell<bool>,
        released: Cell<bool>,
        completed: Cell<bool>,
        validation: RefCell<Option<Value>>,
        abort_reason: RefCell<Option<String>>,
    }
    #[derive(Clone, Copy)]
    enum Stage {
        BeforePress,
        BeforeRelease,
        AfterRelease,
    }

    pub fn start(core: ICoreWebView2, id: String, request: SkipRequest) {
        let origin = STATE
            .lock()
            .unwrap()
            .tracks
            .get(&id)
            .filter(|t| t.generation == request.generation)
            .map(|t| t.capture_surface.origin());
        let Some(origin) = origin else { return };
        let click = Rc::new(Click {
            core,
            id: id.clone(),
            request: request.clone(),
            origin,
            pressed: Cell::new(false),
            released: Cell::new(false),
            completed: Cell::new(false),
            validation: RefCell::new(None),
            abort_reason: RefCell::new(None),
        });
        validate(click, Stage::BeforePress);
        // A missing COM callback cannot leave a pressed mouse or an immortal lease.
        // Closing this specific generation releases its input; a replacement is untouched.
        if let Some(app) = APP.get().cloned() {
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(3)).await;
                let pending = {
                    let state = STATE.lock().unwrap();
                    state.owns(&id, request.generation)
                        && state
                            .tracks
                            .get(&id)
                            .is_some_and(|t| t.native_skip.as_ref() == Some(&request))
                };
                if pending {
                    fail_session(
                        &id,
                        request.generation,
                        "CAPTURE_NATIVE_SKIP_TIMEOUT: public-control input did not complete",
                    );
                    let _ = cancel(&app, &id, Some(request.generation), false).await;
                }
            });
        }
    }
    fn current(click: &Click) -> bool {
        skip_current(&STATE.lock().unwrap(), &click.id, &click.request)
    }
    fn validate(click: Rc<Click>, stage: Stage) {
        if click.completed.get() {
            return;
        }
        if !matches!(stage, Stage::AfterRelease) && !current(&click) {
            abort(click, "binding-invalidated");
            return;
        }
        let script = format!(
            "(()=>({{origin:location.origin,validation:window.__musifyValidateSkip?.({})}}))()",
            click.request.request_id
        );
        let callback_click = Rc::clone(&click);
        let handler = ExecuteScriptCompletedHandler::create(Box::new(move |result, output| {
            let validation = if result.is_err() {
                Err("validation-execution-callback-failed".to_string())
            } else {
                SkipValidationReply::validate(
                    &output,
                    &callback_click.request,
                    callback_click.origin,
                )
            }
            .and_then(|()| {
                current(&callback_click)
                    .then_some(())
                    .ok_or_else(|| "validation-native-binding-invalidated".to_string())
            });
            let valid = validation.is_ok();
            let reason = validation.err();
            *callback_click.validation.borrow_mut() = Some(json!({
                "stage":match stage {Stage::BeforePress=>"before-press",Stage::BeforeRelease=>"before-release",Stage::AfterRelease=>"after-release"},
                "valid":valid,"reason":reason,
            }));
            match stage {
                Stage::BeforePress if valid => dispatch(callback_click, true, false),
                Stage::BeforeRelease if valid => dispatch(callback_click, false, false),
                Stage::AfterRelease => finish(
                    callback_click,
                    true,
                    if valid {
                        "released-and-revalidated"
                    } else {
                        "released-state-changed"
                    },
                ),
                _ => abort(
                    callback_click,
                    reason.as_deref().unwrap_or("dom-validation-failed"),
                ),
            }
            Ok(())
        }));
        if unsafe { click.core.ExecuteScript(&HSTRING::from(script), &handler) }.is_err() {
            abort(click, "validation-execution-failed");
        }
    }
    fn dispatch(click: Rc<Click>, press: bool, cleanup: bool) {
        if click.completed.get() {
            return;
        }
        if !cleanup && !current(&click) {
            abort(click, "binding-invalidated");
            return;
        }
        // CDP coordinates are CSS viewport pixels. Cleanup releases outside the page;
        // it is never a second candidate or an unvalidated fallback control.
        let point = if cleanup {
            (-100.0, -100.0)
        } else {
            (click.request.x, click.request.y)
        };
        let parameters = json!({"type":if press {"mousePressed"} else {"mouseReleased"},"x":point.0,"y":point.1,
            "button":"left","buttons":if press {1} else {0},"clickCount":if cleanup {0} else {1},"pointerType":"mouse"}).to_string();
        let callback_click = Rc::clone(&click);
        // After dispatch begins, failure is ambiguous: always release outside the page
        // on an unsuccessful press callback rather than assuming no input reached it.
        if press {
            click.pressed.set(true);
        }
        let handler =
            CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, _| {
                if press {
                    if result.is_ok() {
                        callback_click.pressed.set(true);
                        validate(callback_click, Stage::BeforeRelease);
                    } else {
                        abort(callback_click, "mouse-press-failed");
                    }
                } else {
                    if result.is_ok() {
                        callback_click.released.set(true);
                    }
                    if cleanup || result.is_err() {
                        finish(
                            callback_click,
                            false,
                            if cleanup {
                                "released-outside-invalid-control"
                            } else {
                                "mouse-release-failed"
                            },
                        );
                    } else {
                        validate(callback_click, Stage::AfterRelease);
                    }
                }
                Ok(())
            }));
        if unsafe {
            click.core.CallDevToolsProtocolMethod(
                &HSTRING::from("Input.dispatchMouseEvent"),
                &HSTRING::from(parameters),
                &handler,
            )
        }
        .is_err()
        {
            if press {
                abort(click, "mouse-press-call-failed");
            } else {
                finish(click, false, "mouse-release-call-failed");
            }
        }
    }
    fn abort(click: Rc<Click>, reason: &str) {
        if click.abort_reason.borrow().is_none() {
            *click.abort_reason.borrow_mut() = Some(reason.to_string());
        }
        if click.pressed.get() && !click.released.get() {
            dispatch(click, false, true);
        } else {
            finish(click, false, reason);
        }
    }
    fn finish(click: Rc<Click>, ok: bool, reason: &str) {
        if click.completed.replace(true) {
            return;
        }
        {
            let mut state = STATE.lock().unwrap();
            if let Some(track) = state
                .tracks
                .get_mut(&click.id)
                .filter(|t| t.native_skip.as_ref() == Some(&click.request))
            {
                track.native_skip = None;
                if ok && click.pressed.get() && click.released.get() {
                    track.native_skip_dispatches += 1;
                }
                track.last_skip_result = Some(
                    json!({"requestId":click.request.request_id,"generation":click.request.generation,"epoch":click.request.epoch,
                    "source":click.request.source,"pressed":click.pressed.get(),"released":click.released.get(),"ok":ok,"reason":reason,"validation":*click.validation.borrow(),"abortReason":*click.abort_reason.borrow()}),
                );
            }
        }
        // CDP success is only input dispatch, never a claim that an ad was skipped.
        // The JS listener independently records isTrusted/defaultPrevented and later identity.
        let result = json!({"requestId":click.request.request_id,"epoch":click.request.epoch,"source":click.request.source,"ok":ok,"reason":reason}).to_string();
        let script = format!(
            "window.__musifyGeneration==={}&&window.__musifySkipResult?.({result})",
            click.request.generation
        );
        let handler = ExecuteScriptCompletedHandler::create(Box::new(|_, _| Ok(())));
        let _ = unsafe { click.core.ExecuteScript(&HSTRING::from(script), &handler) };
        if click.pressed.get() && !click.released.get() {
            if let Some(app) = APP.get().cloned() {
                let id = click.id.clone();
                let generation = click.request.generation;
                tauri::async_runtime::spawn(async move {
                    let _ = cancel(&app, &id, Some(generation), false).await;
                });
            }
        }
    }
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
                        if t.recovery_blocked || t.complete {
                            Some(None)
                        } else if t.phase == "interaction" {
                            None
                        } else if t.stalled(Instant::now())
                            || t.session_started.elapsed() > MAX_WAIT
                        {
                            t.fail("CAPTURE_STALLED: el reproductor dejó de avanzar".into());
                            if t.recovery_allowed() {
                                t.resets += 1;
                                t.recovering = true;
                                Some(Some(if t.eof {
                                    t.recovery_start()
                                } else {
                                    t.target.max(t.recovery_start())
                                }))
                            } else {
                                Some(None)
                            }
                        } else if t.epoch_done {
                            if t.recovery_allowed() && (t.eof || t.recovering) {
                                t.resets += 1;
                                t.recovering = true;
                                Some(Some(t.recovery_start()))
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
                            session.next_slot,
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
    // Benchmark recorder only: revoke playback ownership before freezing the
    // independent probe, then wait for native receipt of its final counters.
    if let Some(request) = crate::capture_audit::begin_finalization(&session.id, session.generation)
    {
        let script = format!(
            "window.__musifyCaptureAudit?.finalize({{generation:{},requestId:{}}})",
            session.generation,
            serde_json::to_string(&request).unwrap()
        );
        let dispatched = app
            .get_webview_window(&session.label)
            .is_some_and(|window| window.eval(script).is_ok());
        let deadline = Instant::now() + Duration::from_secs(2);
        while dispatched
            && Instant::now() < deadline
            && !crate::capture_audit::finalization_acknowledged(
                &session.id,
                session.generation,
                &request,
            )
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        if !crate::capture_audit::finalization_acknowledged(
            &session.id,
            session.generation,
            &request,
        ) {
            crate::capture_audit::finalization_failed(&session.id, session.generation, &request);
        }
    }
    let result = close_window(app, &session.label).await;
    if result.is_ok() {
        crate::capture_audit::close_session(&session.id, session.generation);
    }
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
pub async fn cancel_next_before(
    app: &AppHandle,
    prefetch: u64,
    next_slot: Option<u8>,
) -> Result<(), String> {
    let _guard = TRANSITION.lock().await;
    let sessions: Vec<_> = STATE
        .lock()
        .unwrap()
        .sessions
        .iter()
        .filter(|s| {
            !s.foreground
                && next_slot.is_none_or(|slot| s.next_slot == Some(slot))
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
    next_slot: Option<u8>,
) -> Result<Value, String> {
    begin(
        &app,
        &video_id,
        refresh.unwrap_or(false),
        foreground.unwrap_or(true),
        None,
        next_slot,
        None,
        false,
    )
    .await?;
    status(&video_id).ok_or_else(|| "CAPTURE_CANCELLED: sesión sustituida".into())
}
#[tauri::command]
pub async fn capture_prefetch(
    app: AppHandle,
    video_id: String,
    next_slot: Option<u8>,
) -> Result<Value, String> {
    capture_begin(app, video_id, Some(false), Some(false), next_slot).await
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
            t.require_recovery()?;
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
                begin_locked(
                    &app,
                    &video_id,
                    false,
                    true,
                    session.ticket,
                    session.next_slot,
                    Some(at),
                    true,
                )
                .await?;
            }
        } else {
            begin_locked(&app, &video_id, false, true, None, None, Some(at), true).await?;
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
                let head=json!({"api":4,"progressiveExperiment":progressive_experiment_enabled(),"mime":t.units.first().map(|u|&u.mime),"mimes":t.units[start..end].iter().map(|u|&u.mime).collect::<Vec<_>>(),
                    "units":&t.units[start..end],"ranges":t.ranges,"duration":t.duration,"audioDuration":t.eof_end,"eofEnd":t.eof_end,"total":t.units.len(),
                    "done":t.complete&&end==t.chunks.len(),"complete":t.complete,"eof":t.eof,"error":t.error,"softError":t.soft_error,"recovering":t.recovering,"recoveryBlocked":t.recovery_blocked,"captureSurface":t.capture_surface,
                    "sessionState":t.session_state,"revision":t.revision,"generation":t.generation,"epoch":t.epoch,"reset":reset,"from":start,"next":end}).to_string();
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
    let mut result = json!({"api":4,"progressiveExperiment":progressive_experiment_enabled(),"mime":t.units.first().map(|u|&u.mime),"chunks":t.chunks.len(),"units":t.units.len(),"bytes":t.bytes,"ranges":t.ranges,
        "ads":t.ads_observations,"adObservations":t.ads_observations,"adsSourcesSeen":t.ads_sources.len(),"adsSeen":t.ads_sources.len(),"adsDelivered":t.ads_delivered,"unknown":t.unknown,
        "state":t.phase,"bytesQuarantined":t.quarantined,"verified":t.ready(),"frames":t.units.iter().map(|u|u.frames).sum::<u64>(),
        "rangeStart":t.ranges.first().map(|r|r.start),"rangeEnd":t.ranges.last().map(|r|r.end),"duration":t.duration,
        "firstMs":t.first_ms,"playingMs":t.playing_ms,"metaMs":t.meta_ms,"title":t.title,"doneMs":t.done_ms});
    let detail = json!({"eof":t.eof,"audioDuration":t.eof_end,"eofEnd":t.eof_end,"complete":t.complete,"error":t.error,"softError":t.soft_error,"recovering":t.recovering,"recoveryBlocked":t.recovery_blocked,"captureSurface":t.capture_surface,"why":t.why,"resets":t.resets,
        "lastDiagnostic":t.last_diagnostic,"lastPosition":t.position,"adMs":t.ad_presented.as_millis(),"adWaitMs":t.ad_wait_credit.as_millis(),
        "adRateViolations":t.ad_rate_violations,"adRateObservations":t.ad_rate_observations,
        "lastProgressAgoMs":t.last_progress.elapsed().as_millis(),"waitBudgetMs":t.wait_budget().as_millis(),
        "captureRate":captured/t.opened.elapsed().as_secs_f64().max(0.001),"activeWindows":state.sessions.len(),"active":session.is_some_and(|s|s.active),"foreground":session.map(|s|s.foreground),
        "generation":t.generation,"epoch":t.epoch,"revision":t.revision});
    let evidence = json!({"sessionState":t.session_state,"sessionStates":t.session_states,"unknownAuthUnits":t.unknown_auth_units,"signedInUnits":t.signed_in_units,
        "limits":limits().ok(),"certificates":t.certificates,"nextSlot":session.and_then(|s|s.next_slot),
        "adTransitions":t.ad_transitions,"adTransitionsTotal":t.ad_transitions_total,"adTransitionsTruncated":t.ad_transitions_total>t.ad_transitions.len(),
        "lastNativeSkip":t.last_skip_result,"nativeSkipRequests":t.native_skip_requests,"nativeSkipDispatches":t.native_skip_dispatches,
        "nativeSkipTrustedClicks":t.native_skip_trusted_clicks,"skippedAds":null,"unskippableAdMs":null});
    result
        .as_object_mut()
        .unwrap()
        .extend(detail.as_object().unwrap().clone());
    result
        .as_object_mut()
        .unwrap()
        .extend(evidence.as_object().unwrap().clone());
    Some(result)
}
/// Private benchmark evidence. No cookies, account strings, signed URLs or unpublished bytes.
pub fn bench_snapshot(video_id: &str) -> Result<Value, String> {
    if std::env::var_os("MUSIFY_BENCH").is_none() {
        return Err("The snapshot is only available in benchmarks".into());
    }
    let (mut snapshot, units) = {
        let ledger = BENCH_LEDGER.lock().unwrap();
        if let Some(error) = ledger.errors.get(video_id) {
            return Err(error.clone());
        }
        let snapshot = ledger
            .states
            .get(video_id)
            .cloned()
            .ok_or("No published-unit journal for this video")?;
        (
            snapshot,
            ledger.units.get(video_id).cloned().unwrap_or_default(),
        )
    };
    // Journal files survive cache eviction, refresh and bench_forget. Reading and encoding
    // bytes happens outside STATE and the journal mutex; no decoder runs under either lock.
    let mut output = Vec::with_capacity(units.len());
    for entry in units {
        let bytes = std::fs::read(&entry.path)
            .map_err(|_| "CAPTURE_AUDIT_IO: published bytes disappeared")?;
        let mut value = entry.metadata;
        value["data"] = json!(base64::engine::general_purpose::STANDARD.encode(bytes));
        output.push(value);
    }
    snapshot["unknownAuthUnits"] = json!(
        output
            .iter()
            .filter(|u| u["sessionState"]["state"] != "signed-out"
                && u["sessionState"]["state"] != "signed-in")
            .count()
    );
    snapshot["signedInUnits"] = json!(
        output
            .iter()
            .filter(|u| u["sessionState"]["state"] == "signed-in")
            .count()
    );
    snapshot["units"] = Value::Array(output);
    Ok(snapshot)
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
    fn consent_diagnostic_logs_only_bounded_public_fields_and_native_binding() {
        let detail = json!({
            "phase":"inline-consent", "present":true, "visible":true,
            "eligible":false, "attempted":false, "dialogCount":1,
            "buttonCount":2, "nativeButtons":0, "roleButtons":2,
            "renderedButtons":2, "enabledButtons":2,
            "rejectTextMatches":1, "rejectAriaMatches":0, "ariaDifferent":1,
            "blockedButtons":0, "controlsTruncated":false,
            "generation":"private", "epoch":"private", "browserNow":"private",
            "url":"https://example.invalid/?credential=private", "title":"private",
            "account":"private", "stack":"private", "reason":"private",
            "consent":{
                "seenVisible":true, "rejectDispatched":false, "closedAfterAttempt":false,
                "private":"private", "lastVisible":{
                    "nativeButtons":0,"roleButtons":2,"buttonCount":2,
                    "controlsTruncated":false,"label":"private"
                }
            }
        });
        let result = consent_diagnostic(true, &detail, 7, 8, Some(&json!(19.25))).unwrap();
        assert_eq!(
            result,
            json!({
                "phase":"inline-consent", "generation":7,"epoch":8,"browserNow":19.25,
                "present":true,"visible":true,"eligible":false,"attempted":false,
                "dialogCount":1,"buttonCount":2,"nativeButtons":0,"roleButtons":2,
                "renderedButtons":2,"enabledButtons":2,"rejectTextMatches":1,
                "rejectAriaMatches":0,"ariaDifferent":1,"blockedButtons":0,
                "controlsTruncated":false,"consent":{
                    "seenVisible":true,"rejectDispatched":false,"closedAfterAttempt":false,
                    "lastVisible":{"nativeButtons":0,"roleButtons":2,"buttonCount":2,
                        "controlsTruncated":false}
                }
            })
        );
        assert!(!result.to_string().contains("private"));
        assert!(consent_diagnostic(false, &detail, 7, 8, None).is_none());
        assert!(consent_diagnostic(true, &json!({"phase":"heartbeat"}), 7, 8, None).is_none());
        assert_eq!(
            consent_diagnostic(
                true,
                &json!({"phase":"inline-consent-attempt","dispatched":true}),
                7,
                8,
                None
            ),
            Some(
                json!({"phase":"inline-consent-attempt","dispatched":true,"generation":7,"epoch":8})
            )
        );
    }
    #[test]
    fn consent_diagnostic_rejects_malformed_allowed_fields_without_logging() {
        for (field, value) in [
            ("visible", json!("private")),
            ("attempted", json!(1)),
            ("nativeButtons", json!(-1)),
            ("roleButtons", json!(33)),
            ("buttonCount", json!(0.5)),
            ("controlsTruncated", Value::Null),
        ] {
            let mut detail = json!({"phase":"inline-consent"});
            detail[field] = value;
            assert!(
                consent_diagnostic(true, &detail, 7, 8, None).is_none(),
                "{field}"
            );
        }
        for detail in [
            json!({"phase":"inline-consent","consent":"private"}),
            json!({"phase":"inline-consent","consent":{"seenVisible":"private"}}),
            json!({"phase":"inline-consent","consent":{"lastVisible":{"roleButtons":33}}}),
            json!({"phase":"inline-consent","consent":{"lastVisible":[]}}),
            json!({"phase":"inline-consent-attempt","dispatched":"private"}),
        ] {
            assert!(consent_diagnostic(true, &detail, 7, 8, None).is_none());
        }
        for now in [json!("private"), json!(-1), json!(1e300), Value::Null] {
            assert!(
                consent_diagnostic(true, &json!({"phase":"inline-consent"}), 7, 8, Some(&now))
                    .is_none()
            );
        }
    }
    #[test]
    fn malformed_optional_browser_clock_does_not_reject_the_capture_protocol() {
        let parsed: Message = serde_json::from_value(json!({
            "musify":1,"api":4,"kind":"event","browserNow":{"private":"ignored"}
        }))
        .unwrap();
        assert!(parsed.browser_now.unwrap().is_object());
    }
    #[test]
    fn next_memory_reserves_the_current_tracks_remaining_capacity() {
        let mut state = state();
        state.promote(ID, None);
        state.tracks.get_mut(ID).unwrap().bytes = 20;
        state.sessions.push(session(NEXT, 11, false));
        let limits = CaptureLimits {
            max_sessions: 3,
            prefetch_slots: 2,
            track_bytes: 96,
            total_bytes: 128,
        };
        assert_eq!(state.foreground_reserve(NEXT, limits), 76);
        assert_eq!(state.foreground_reserve(ID, limits), 0);
        // Next may use only32 bytes; the remaining76 are kept for current after its20.
        assert_eq!(
            limits.total_bytes - state.total_bytes() - state.foreground_reserve(NEXT, limits),
            32
        );
    }
    #[test]
    fn benchmark_journal_preserves_units_after_cache_replacement_and_fails_closed_at_its_cap() {
        let directory = std::env::temp_dir().join(format!(
            "musify-journal-test-{}-{}",
            std::process::id(),
            next_id()
        ));
        std::fs::create_dir(&directory).unwrap();
        let mut state = state();
        let proof = Unit::from_message(&message(&state, unit(1, 0.0, 1.0)), 10).unwrap();
        let auth = SessionState::unknown(10, 20);
        let mut ledger = BenchLedger::default();
        persist_journal_unit(
            &mut ledger,
            &directory,
            8,
            ID,
            30,
            &proof,
            &auth,
            &[1, 2, 3, 4],
        )
        .unwrap();
        state.tracks.clear();
        state.sessions.clear();
        assert_eq!(ledger.units[ID].len(), 1);
        assert_eq!(
            std::fs::read(&ledger.units[ID][0].path).unwrap(),
            vec![1, 2, 3, 4]
        );
        let mut next = proof.clone();
        next.generation = 11;
        persist_journal_unit(
            &mut ledger,
            &directory,
            8,
            ID,
            31,
            &next,
            &auth,
            &[5, 6, 7, 8],
        )
        .unwrap();
        next.generation = 12;
        assert!(
            persist_journal_unit(&mut ledger, &directory, 8, ID, 32, &next, &auth, &[9])
                .unwrap_err()
                .starts_with("CAPTURE_AUDIT_CAPACITY")
        );
        assert_eq!(ledger.units[ID].len(), 2);
        assert_eq!(ledger.units[ID][0].metadata["revision"], 30);
        assert_eq!(ledger.units[ID][1].metadata["revision"], 31);
        for entry in &ledger.units[ID] {
            std::fs::remove_file(&entry.path).unwrap();
        }
        std::fs::remove_dir(&directory).unwrap();
    }
    #[test]
    fn configured_limits_reject_invalid_or_contradictory_memory_without_expanding_it() {
        let defaults = configured_limits(None, None, None).unwrap();
        assert_eq!(
            (
                defaults.max_sessions,
                defaults.prefetch_slots,
                defaults.track_bytes,
                defaults.total_bytes
            ),
            (3, 2, 96 * 1024 * 1024, 288 * 1024 * 1024)
        );
        assert_eq!(
            configured_limits(Some("1"), Some("64"), Some("64"))
                .unwrap()
                .prefetch_slots,
            0
        );
        for sessions in ["0", "4", "bad", ""] {
            assert!(configured_limits(Some(sessions), None, None).is_err());
        }
        assert!(configured_limits(None, Some("96"), Some("64")).is_err());
        assert!(configured_limits(None, Some("NaN"), None).is_err());
    }
    fn eof_certificate(count: u64, end: f64) -> Value {
        json!({"kind":"complete-source-v1","epoch":20,"source":7,"s":3,"initKey":"configuration-1","mime":"audio/webm; codecs=opus",
            "timelineSettings":{"timestampOffset":0.0,"appendWindowStart":0.0,"appendWindowEnd":null,"mode":"segments"},
            "frameCount":count,"rangeStart":0.0,"rangeEnd":end,"quantum":0.001,"cleanWholeSource":true,"nativeContinuous":true,"officialEof":true})
    }
    #[test]
    fn complete_source_certificate_closes_only_quantization_with_all_bound_sample_indices() {
        let mut s = state();
        deliver(&mut s, 1, 0.0, 0.020);
        deliver(&mut s, 2, 0.021, 0.040);
        assert_eq!(s.tracks[ID].ranges.len(), 2);
        let certificate: CompleteCertificate =
            serde_json::from_value(eof_certificate(20, 0.040)).unwrap();
        assert!(certificate.validates(&s.tracks[ID], 0.040));
        for (field, value) in [
            ("frameCount", json!(21)),
            ("epoch", json!(21)),
            ("source", json!(8)),
            ("s", json!(4)),
            ("initKey", json!("different")),
            ("quantum", json!(0.002)),
            ("nativeContinuous", json!(false)),
            ("cleanWholeSource", json!(false)),
            ("officialEof", json!(false)),
        ] {
            let mut bad = eof_certificate(20, 0.040);
            bad[field] = value;
            assert!(
                !serde_json::from_value::<CompleteCertificate>(bad)
                    .unwrap()
                    .validates(&s.tracks[ID], 0.040),
                "{field}"
            );
        }
        let mut missing = s.tracks[ID].units.clone();
        missing[1].first_frame += 1;
        missing[1].frames -= 1;
        let track = s.tracks.get_mut(ID).unwrap();
        std::mem::swap(&mut track.units, &mut missing);
        assert!(
            !certificate.validates(track, 0.040),
            "a genuine missing sample is not codec quantization"
        );
        std::mem::swap(&mut track.units, &mut missing);
        track.units[1].generation += 1;
        assert!(
            !certificate.validates(track, 0.040),
            "another window cannot complete this inventory"
        );
        track.units[1].generation -= 1;
        send(
            &mut s,
            json!({"kind":"event","type":"ended","state":"content","source":7,"s":3,"eof":true,"end":0.040,"certificate":eof_certificate(20,0.040)}),
        );
        assert!(s.tracks[ID].complete);
        assert_eq!(s.tracks[ID].certificates.len(), 1);
        assert_eq!(
            s.tracks[ID].ranges,
            vec![Range {
                start: 0.0,
                end: 0.040
            }]
        );
    }
    #[test]
    fn partial_source_and_real_timeline_holes_cannot_borrow_a_complete_source_certificate() {
        let mut s = state();
        deliver(&mut s, 1, 0.0, 0.020);
        deliver(&mut s, 2, 0.030, 0.040);
        let certificate: CompleteCertificate =
            serde_json::from_value(eof_certificate(20, 0.040)).unwrap();
        assert!(!certificate.validates(&s.tracks[ID], 0.040));
        let t = s.tracks.get_mut(ID).unwrap();
        t.units[1].range_start = 0.021;
        t.target = 0.01;
        assert!(
            !certificate.validates(t, 0.040),
            "seek epochs cannot certify the original whole source"
        );
    }
    fn skip_request() -> Value {
        json!({"kind":"event","type":"skip-request","requestId":1,"source":9,"buttonToken":3,"x":200.0,"y":80.0,"viewportWidth":960.0,"viewportHeight":640.0})
    }
    #[test]
    fn native_skip_requires_observed_ad_and_rejects_stale_dom_identity_and_coordinates() {
        let mut s = state();
        send(&mut s, skip_request());
        assert!(s.tracks[ID].native_skip.is_none());
        send(
            &mut s,
            json!({"kind":"event","type":"diagnostic","state":"ad","source":9}),
        );
        let mut foreign = skip_request();
        foreign["source"] = json!(8);
        send(&mut s, foreign);
        assert!(s.tracks[ID].native_skip.is_none());
        send(&mut s, skip_request());
        let request = s.tracks[ID].native_skip.clone().unwrap();
        assert!(skip_current(&s, ID, &request));
        let mut response = serde_json::to_value(&request).unwrap();
        response["valid"] = json!(true);
        assert!(request.validated(&response));
        for (field, value) in [
            ("x", json!(201.0)),
            ("buttonToken", json!(4)),
            ("source", json!(10)),
            ("epoch", json!(21)),
            ("generation", json!(11)),
            ("valid", json!(false)),
        ] {
            let mut wrong = response.clone();
            wrong[field] = value;
            assert!(!request.validated(&wrong), "{field}");
        }
        s.tracks.get_mut(ID).unwrap().epoch += 1;
        assert!(
            !skip_current(&s, ID, &request),
            "an asynchronous callback after seek cannot click"
        );
        s.tracks.get_mut(ID).unwrap().epoch -= 1;
        s.sessions[0].active = false;
        assert!(
            !skip_current(&s, ID, &request),
            "cancel marks ownership false before the native close completes"
        );
    }
    #[test]
    fn native_skip_execute_script_accepts_exact_js_safe_integer_double_encoding() {
        let request = SkipRequest {
            request_id: 1_791_400_123_456_000,
            generation: 1,
            epoch: 2,
            source: 3,
            button_token: 1,
            x: 842.25,
            y: 581.5,
            viewport_width: 960.0,
            viewport_height: 640.0,
        };
        // Chromium JSON preserves DOUBLE representation for values outside int32.
        let output = r#"{"origin":"https://music.youtube.com","validation":{"valid":true,"requestId":1791400123456000.0,"generation":1.0,"epoch":2,"source":3,"buttonToken":1,"x":842.25,"y":581.5,"viewportWidth":960,"viewportHeight":640}}"#;
        let old: Value = serde_json::from_str(output).unwrap();
        assert!(
            serde_json::from_value::<SkipRequest>(old["validation"].clone()).is_err(),
            "the old typed-u64 reply path rejected this valid browser number"
        );
        assert!(
            SkipValidationReply::validate(output, &request, CaptureSurface::Music.origin()).is_ok()
        );
        assert!(
            SkipValidationReply::validate(
                &output.replace("1791400123456000.0", "1.791400123456e15"),
                &request,
                CaptureSurface::Music.origin()
            )
            .is_ok()
        );
        for replacement in [
            "1791400123456001.0",
            "1791400123456000.5",
            "9007199254740992.0",
            "-1",
            "null",
            "\"1791400123456000\"",
        ] {
            assert!(
                SkipValidationReply::validate(
                    &output.replace("1791400123456000.0", replacement),
                    &request,
                    CaptureSurface::Music.origin()
                )
                .is_err(),
                "{replacement}"
            );
        }
        assert_eq!(
            SkipValidationReply::validate(
                &output.replace("842.25", "842.26"),
                &request,
                CaptureSurface::Music.origin()
            )
            .unwrap_err(),
            "validation-x-mismatch"
        );
        assert_eq!(
            SkipValidationReply::validate(
                &output.replace("https://music.youtube.com", "https://example.com"),
                &request,
                CaptureSurface::Music.origin()
            )
            .unwrap_err(),
            "validation-origin-mismatch"
        );
        assert!(
            SkipValidationReply::validate(
                r#"{"result":{"type":"object","value":{}}}"#,
                &request,
                CaptureSurface::Music.origin()
            )
            .is_err(),
            "a CDP envelope is not ExecuteScript's contract"
        );
    }
    #[test]
    fn native_skip_preserves_safe_dom_failure_details_without_copying_page_text() {
        let request = SkipRequest {
            request_id: 1,
            generation: 1,
            epoch: 2,
            source: 3,
            button_token: 1,
            x: 842.25,
            y: 581.5,
            viewport_width: 960.0,
            viewport_height: 640.0,
        };
        let response = |reason| {
            json!({"origin":"https://music.youtube.com","validation":{"valid":false,"requestId":1,"reason":reason}}).to_string()
        };
        assert_eq!(
            SkipValidationReply::validate(
                &response("button-moved-or-covered"),
                &request,
                CaptureSurface::Music.origin()
            )
            .unwrap_err(),
            "dom-button-moved-or-covered"
        );
        assert_eq!(
            SkipValidationReply::validate(
                &response("request-expired"),
                &request,
                CaptureSurface::Music.origin()
            )
            .unwrap_err(),
            "dom-request-expired"
        );
        assert_eq!(
            SkipValidationReply::validate(
                &response("https://private.invalid/token?secret"),
                &request,
                CaptureSurface::Music.origin()
            )
            .unwrap_err(),
            "dom-page-rejected-or-unavailable"
        );
        assert!(
            SkipValidationReply::validate("null", &request, CaptureSurface::Music.origin())
                .is_err()
        );
    }
    #[test]
    fn trusted_click_telemetry_is_bound_to_the_native_request_and_counted_once() {
        let mut s = state();
        s.tracks.get_mut(ID).unwrap().last_skip_result =
            Some(json!({"requestId":41,"pressed":true,"released":true}));
        let report = |request_id| json!({"kind":"event","type":"diagnostic","reason":json!({"phase":"native-skip-result","requestId":request_id,"skip":{"last":{"eventSeen":true,"isTrusted":true,"defaultPrevented":true}}}).to_string()});
        send(&mut s, report(40));
        assert_eq!(s.tracks[ID].native_skip_trusted_clicks, 0);
        send(&mut s, report(41));
        send(&mut s, report(41));
        assert_eq!(s.tracks[ID].native_skip_trusted_clicks, 1);
        assert_eq!(
            s.tracks[ID].last_skip_result.as_ref().unwrap()["defaultPrevented"],
            true
        );
        assert_eq!(
            s.tracks[ID].native_skip_dispatches, 0,
            "a JS event does not invent native dispatch success"
        );
    }
    #[test]
    fn signed_out_final_state_does_not_hide_earlier_unknown_or_signed_in_delivery() {
        let mut s = state();
        deliver(&mut s, 1, 0.0, 1.0);
        send(
            &mut s,
            json!({"kind":"event","type":"auth","state":"signed-in","evidenceVersion":1}),
        );
        deliver(&mut s, 2, 1.0, 2.0);
        send(
            &mut s,
            json!({"kind":"event","type":"auth","state":"signed-out","evidenceVersion":1}),
        );
        deliver(&mut s, 3, 2.0, 3.0);
        let t = &s.tracks[ID];
        assert_eq!(t.session_state.state, "signed-out");
        assert_eq!((t.unknown_auth_units, t.signed_in_units), (1, 1));
        assert_eq!(
            t.session_states
                .iter()
                .map(|s| s.state.as_str())
                .collect::<Vec<_>>(),
            vec!["signed-in", "signed-out"]
        );
    }
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
            next_slot: (!foreground).then_some(0),
            ticket: Some(RequestTicket {
                resolution: 1,
                prefetch: None,
                prefetch_slot: None,
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
        let mut base = json!({"musify":1,"api":4,"v":ID,"generation":t.generation,"epoch":t.epoch,"sequence":t.sequence.unwrap_or(0)+1});
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
            "initKey":"configuration-1","initBytes":2,"mime":"audio/webm; codecs=opus","frames":10,"firstFrame":(number-1)*10,"endFrame":number*10,"rangeStart":start,"rangeEnd":end,
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
    fn a_quantization_sized_gap_requests_a_fresh_proof_without_crediting_coverage() {
        let mut s = state();
        deliver(&mut s, 1, 0.0, 0.020);
        deliver(&mut s, 2, 0.021, 2.0);
        ended(&mut s, 2.0);
        let t = &s.tracks[ID];
        assert!(!t.complete);
        assert_eq!(t.first_gap(), 0.020);
        assert_eq!(t.recovery_start(), 0.0);
        assert_eq!(t.ranges.len(), 2);
        let mut s = state();
        deliver(&mut s, 1, 0.0, 1.0);
        deliver(&mut s, 2, 1.020, 2.0);
        ended(&mut s, 2.0);
        assert_eq!(s.tracks[ID].recovery_start(), 1.0);
        assert!(!s.tracks[ID].complete);
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
    fn repeated_ranges_keep_each_epochs_inventory_without_changing_timeline_coverage() {
        let mut s = state();
        deliver(&mut s, 1, 0.0, 1.0);
        let bytes = s.tracks[ID].bytes;
        s.tracks.get_mut(ID).unwrap().begin_epoch(10, 21, 0.0, true);
        deliver(&mut s, 1, 0.0, 1.0);
        assert_eq!(s.tracks[ID].bytes, bytes * 2);
        assert_eq!(s.tracks[ID].units.len(), 2);
        assert_eq!(
            s.tracks[ID]
                .units
                .iter()
                .map(|u| u.epoch)
                .collect::<Vec<_>>(),
            vec![20, 21]
        );
        assert_eq!(
            s.tracks[ID].ranges,
            vec![Range {
                start: 0.0,
                end: 1.0
            }]
        );
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
        let mut second = session("ddddddddddd", 12, false);
        second.next_slot = Some(1);
        s.sessions.push(second);
        s.tracks.insert(NEXT.into(), Track::new(11, 21, 31));
        assert_eq!(s.victim("ccccccccccc", false, Some(0)).unwrap().id, NEXT);
        assert_eq!(s.victim("ccccccccccc", true, None).unwrap().id, ID);
        s.sessions.retain(|session| session.id != ID);
        let ticket = Some(RequestTicket {
            resolution: 9,
            prefetch: None,
            prefetch_slot: None,
        });
        s.promote(NEXT, ticket);
        let current = s.session(NEXT).unwrap();
        assert!(current.foreground);
        assert_eq!(current.generation, 11);
        assert_eq!(current.ticket, ticket);
        assert_eq!(s.tracks[NEXT].revision, 31);
        assert!(s.victim("ccccccccccc", false, Some(0)).is_none());
        assert_eq!(
            s.victim("ccccccccccc", false, Some(1)).unwrap().generation,
            12
        );
        assert_eq!(s.session("ddddddddddd").unwrap().next_slot, Some(1));
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
        assert_eq!(
            s.victim("ccccccccccc", false, Some(0)).unwrap().generation,
            10
        );
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
    fn timeline_change(end: f64, next_start: f64) -> String {
        format!(
            "CAPTURE_UNSUPPORTED_TIMELINE: SourceBuffer settings changed: previous={}, current={}, mime=audio/mp4; codecs=\"mp4a.40.2\"",
            json!({"timestampOffset":-0.036281179138321996,"appendWindowStart":0,"appendWindowEnd":40.69,"mode":"segments"}),
            json!({"timestampOffset":40.65371882086168,"appendWindowStart":next_start,"appendWindowEnd":end,"mode":"segments"})
        )
    }
    #[test]
    fn repeated_aac_timeline_transition_retries_www_once_then_stops_without_erasing_audio() {
        let mut s = state();
        s.tracks.get_mut(ID).unwrap().capture_surface = CaptureSurface::Music;
        deliver(&mut s, 1, 0.0, 1.0);
        let before = s.tracks[ID].chunks.clone();
        let ranges = s.tracks[ID].ranges.clone();
        let revision = s.tracks[ID].revision;
        send(
            &mut s,
            json!({"kind":"event","type":"error","code":"CAPTURE_UNSUPPORTED_TIMELINE",
            "reason":timeline_change(288.2,40.69),"recoverable":true}),
        );
        let t = s.tracks.get_mut(ID).unwrap();
        assert_eq!(t.capture_surface, CaptureSurface::Youtube);
        assert!(t.recovering && !t.recovery_blocked && t.recovery_allowed());
        assert_eq!(
            t.recovery_start(),
            0.0,
            "the alternate surface starts fresh, not at an old partial gap"
        );
        assert!(t.error.is_none());
        t.resets += 1;
        t.begin_epoch(11, 21, 0.0, true);
        s.sessions[0].generation = 11;
        let m = message(
            &s,
            json!({"kind":"event","type":"error","code":"CAPTURE_UNSUPPORTED_TIMELINE",
            "reason":timeline_change(405.34709750566896,40.69),"recoverable":true}),
        );
        assert!(apply_message(
            &mut s,
            ID,
            11,
            "https://www.youtube.com/watch?v=aaaaaaaaaaa",
            m,
            Instant::now()
        ));
        let t = &s.tracks[ID];
        assert!(t.recovery_blocked && t.epoch_done);
        assert!(!t.recovering && !t.recovery_allowed());
        assert!(
            t.require_recovery()
                .unwrap_err()
                .contains("automatic recovery stopped")
        );
        assert!(
            t.error.is_none(),
            "published audio retains a soft warning, never a fatal playback error"
        );
        assert!(
            t.soft_error
                .as_ref()
                .unwrap()
                .starts_with("CAPTURE_UNSUPPORTED_TIMELINE")
        );
        assert_eq!(t.chunks, before);
        assert_eq!(t.ranges, ranges);
        assert_eq!(t.revision, revision);
        assert_eq!(
            read_bounds(t, 0, Some(revision)),
            (0, 1, false),
            "retired acquisition remains replayable"
        );
        assert!(
            !t.eof && !t.complete,
            "a stopped acquisition never invents final coverage"
        );
        let refreshed = Track::new(12, 22, 31);
        assert!(
            !refreshed.recovery_blocked && refreshed.timeline_failures.is_empty(),
            "only a new cache lifetime clears the circuit"
        );
    }
    #[test]
    fn timeline_fingerprints_ignore_future_track_length_but_not_original_window_or_boundary() {
        let a = TimelineFailure::parse(&timeline_change(288.2, 40.69)).unwrap();
        assert_eq!(
            a,
            TimelineFailure::parse(&timeline_change(405.3, 40.69)).unwrap()
        );
        assert_ne!(
            a,
            TimelineFailure::parse(&timeline_change(405.3, 41.0)).unwrap()
        );
        let altered = timeline_change(288.2, 40.69).replacen("-0.036281179138321996", "-0.05", 1);
        assert_ne!(a, TimelineFailure::parse(&altered).unwrap());
        assert!(TimelineFailure::parse("CAPTURE_NETWORK: offline").is_none());
        assert!(
            TimelineFailure::parse("CAPTURE_UNSUPPORTED_TIMELINE: truncated settings").is_none()
        );
        let mut t = Track::new(1, 2, 3);
        t.report_failure("CAPTURE_NETWORK: offline".into(), true);
        t.begin_epoch(4, 5, 0.0, true);
        t.report_failure("CAPTURE_NETWORK: offline".into(), true);
        assert!(
            !t.recovery_blocked && t.recovering,
            "ordinary missing-data/network recovery is unchanged"
        );
        t.capture_surface = CaptureSurface::Music;
        t.report_failure(timeline_change(288.2, 40.69), true);
        t.begin_epoch(6, 7, 0.0, true);
        t.report_failure(timeline_change(405.3, 41.0), true);
        assert!(
            !t.recovery_blocked,
            "a different boundary is not the repeated incompatibility"
        );
    }
    #[test]
    fn www_surface_is_benchmark_only_initially_and_native_input_stays_bound_to_its_origin() {
        assert_eq!(
            CaptureSurface::initial(false, Some("youtube")),
            CaptureSurface::Music
        );
        assert_eq!(
            CaptureSurface::initial(true, Some("youtube")),
            CaptureSurface::Youtube
        );
        assert_eq!(CaptureSurface::initial(true, None), CaptureSurface::Music);
        assert_eq!(
            source_kind("https://www.youtube.com/watch?v=aaaaaaaaaaa"),
            Some(true)
        );
        for url in [
            "https://www.youtube.com.evil.test/",
            "https://youtube.com/",
            "http://www.youtube.com/",
            "https://www.youtube.com:444/",
        ] {
            assert_eq!(source_kind(url), None, "{url}");
        }
        let request = SkipRequest {
            request_id: 1,
            generation: 1,
            epoch: 2,
            source: 3,
            button_token: 1,
            x: 20.0,
            y: 30.0,
            viewport_width: 960.0,
            viewport_height: 640.0,
        };
        let mut validation = serde_json::to_value(&request).unwrap();
        validation["valid"] = json!(true);
        let output =
            json!({"origin":CaptureSurface::Youtube.origin(),"validation":validation}).to_string();
        assert!(
            SkipValidationReply::validate(&output, &request, CaptureSurface::Youtube.origin())
                .is_ok()
        );
        assert!(
            SkipValidationReply::validate(&output, &request, CaptureSurface::Music.origin())
                .is_err(),
            "a redirect cannot borrow another window's allowed origin"
        );
        assert!(
            SkipValidationReply::validate(&output, &request, "https://www.youtube.com.evil.test")
                .is_err()
        );
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
    fn ad_marker_diagnostic(source: u64, marker: Value, rate: Value) -> Value {
        json!({"kind":"event","type":"diagnostic","state":"ad","source":source,"playbackRate":rate,
            "reason":json!({"phase":"identity-transition","evidence":{"adMarker":marker,"presentedId":"different-video"}}).to_string()})
    }
    #[test]
    fn ad_transition_qualification_requires_an_explicit_marker_and_exact_one_x_observation() {
        let mut invalid_reason = ad_marker_diagnostic(8, json!(true), json!(1));
        invalid_reason["reason"] = json!("not JSON");
        let mut not_diagnostic = ad_marker_diagnostic(8, json!(true), json!(1));
        not_diagnostic["type"] = json!("progress");
        let mut no_source = ad_marker_diagnostic(8, json!(true), json!(1));
        no_source["source"] = Value::Null;
        for observation in [
            ad_marker_diagnostic(8, json!(false), json!(1)),
            ad_marker_diagnostic(8, json!("true"), json!(1)),
            ad_marker_diagnostic(8, Value::Null, json!(1)),
            ad_marker_diagnostic(8, json!(true), Value::Null),
            ad_marker_diagnostic(8, json!(true), json!(2)),
            invalid_reason,
            not_diagnostic,
            no_source,
        ] {
            let mut s = state();
            send(&mut s, observation);
            assert!(s.tracks[ID].ad_marker.is_none());
            // Restore a known source without adding evidence. It must not borrow
            // a marker observed without a source or merely from a different ID.
            send(&mut s, ad_marker_diagnostic(8, json!(false), json!(1)));
            send(
                &mut s,
                json!({"kind":"event","type":"diagnostic","state":"content","source":7}),
            );
            let t = &s.tracks[ID];
            assert_eq!(
                t.ad_transitions_total, 1,
                "diagnostic count remains unchanged"
            );
            assert_eq!(t.ad_transitions[0]["markerObserved"], false);
            assert!(t.ad_transitions[0]["markerSequence"].is_null());
            assert!(t.ad_transitions[0]["markerPlaybackRate"].is_null());
        }
    }
    #[test]
    fn ad_marker_evidence_is_latched_once_and_consumed_by_its_source_transition() {
        let mut s = state();
        send(&mut s, ad_marker_diagnostic(8, json!(true), json!(1)));
        let marker_sequence = s.tracks[ID].sequence.unwrap();
        send(&mut s, ad_marker_diagnostic(8, json!(false), json!(1)));
        send(
            &mut s,
            json!({"kind":"event","type":"diagnostic","state":"content","source":7}),
        );
        let transition = &s.tracks[ID].ad_transitions[0];
        assert_eq!(transition["source"], 8);
        assert_eq!(transition["contentSource"], 7);
        assert_eq!(transition["markerObserved"], true);
        assert_eq!(transition["markerSequence"], marker_sequence);
        assert_eq!(transition["markerPlaybackRate"], 1.0);
        assert!(marker_sequence < transition["sequence"].as_u64().unwrap());
        assert!(s.tracks[ID].ad_marker.is_none());
        send(&mut s, ad_marker_diagnostic(8, json!(false), json!(1)));
        send(
            &mut s,
            json!({"kind":"event","type":"diagnostic","state":"content","source":7}),
        );
        assert_eq!(s.tracks[ID].ad_transitions_total, 2);
        assert_eq!(s.tracks[ID].ad_transitions[1]["markerObserved"], false);
    }
    #[test]
    fn ad_marker_evidence_cannot_cross_source_generation_epoch_or_unknown_identity() {
        for (generation, epoch, intermediate) in [
            (10, 20, ad_marker_diagnostic(9, json!(false), json!(1))),
            (
                10,
                20,
                json!({"kind":"event","type":"diagnostic","state":"unknown","source":8}),
            ),
            (10, 21, Value::Null),
            (11, 20, Value::Null),
        ] {
            let mut s = state();
            send(&mut s, ad_marker_diagnostic(8, json!(true), json!(1)));
            if !intermediate.is_null() {
                send(&mut s, intermediate);
            } else {
                s.sessions[0].generation = generation;
                s.tracks
                    .get_mut(ID)
                    .unwrap()
                    .begin_epoch(generation, epoch, 0.0, true);
            }
            assert!(s.tracks[ID].ad_marker.is_none());
            send(&mut s, ad_marker_diagnostic(8, json!(false), json!(1)));
            send(
                &mut s,
                json!({"kind":"event","type":"diagnostic","state":"content","source":7}),
            );
            assert_eq!(s.tracks[ID].ad_transitions_total, 1);
            assert_eq!(s.tracks[ID].ad_transitions[0]["markerObserved"], false);
        }
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
