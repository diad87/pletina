//! Anonymous, explicitly made-for-kids fallback. Discovery never runs remote JS.
//! The decoder evaluates only locally extracted functions; no account or cookie jar.
use super::*;
use crate::youtube_decoder::{self, PreparedDecoder};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

const LIMIT: usize = 4 * 1024 * 1024;
const TTL: Duration = Duration::from_secs(6 * 3600);
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(4);
// No intentional wait: another worker may dispatch the first foreground GETs
// before fast-path completion. Drop aborts work; it cannot unsend a request.
const PREFETCH_DELAY: Duration = Duration::ZERO;
static PREFETCH_CLAIMED: AtomicBool = AtomicBool::new(false);
// Different embed experiments can publish different players for the same album.
// Keep four prepared scripts (at most 8 MiB), never their temporary JS runtimes.
const MAX_DECODERS: usize = 4;
const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.5 Safari/605.1.15,gzip(gfe)";
const PLAYER: &str = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const NOTICE: &str = "Miniplayer is off for videos made for kids. Tap play to resume";
const NOTICE_PATH: &str = "/playabilityStatus/miniplayer/miniplayerRenderer/minimizedEndpoint/openPopupAction/popup/notificationActionRenderer/responseText/simpleText";

#[cfg(test)]
static TRACE_FIXTURES: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(test)]
fn fixture_file(id: Option<&str>, name: &str) -> Option<std::path::PathBuf> {
    if !TRACE_FIXTURES.load(Ordering::Relaxed)
        || id.is_some_and(|id| !valid_id(id))
        || !name.ends_with(".local")
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-._".contains(&b))
    {
        return None;
    }
    let mut dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .join("capture-bench.local/kids-failed-fixture.local");
    if let Some(id) = id {
        dir = dir.join(format!("{id}.local"));
    }
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(name))
}

#[cfg(test)]
fn save_private_fixture(id: Option<&str>, name: &str, bytes: &[u8]) {
    if let Some(path) = fixture_file(id, name) {
        let _ = std::fs::write(path, bytes);
    }
}

fn validation_code(error: &str) -> String {
    match error {
        "NATIVE_CDN_TIMEOUT" | "NATIVE_EMBEDDED_CDN_TIMEOUT" => "cdn-timeout".into(),
        "NATIVE_CDN_RANGE" | "NATIVE_EMBEDDED_CDN_RANGE" => "cdn-range".into(),
        "NATIVE_CDN_NOT_AUDIO" | "NATIVE_EMBEDDED_CDN_MIME" => "cdn-mime".into(),
        "NATIVE_EMBEDDED_CDN_ENCODING" => "cdn-encoding".into(),
        "NATIVE_CDN_EMPTY" => "cdn-empty".into(),
        "NATIVE_EMBEDDED_CDN_TRUNCATED" => "cdn-truncated".into(),
        _ => {
            if let Some(status) = error
                .strip_prefix("NATIVE_EMBEDDED_CDN_HTTP_")
                .filter(|v| v.len() == 3 && v.bytes().all(|b| b.is_ascii_digit()))
            {
                return format!("cdn-http-{status}");
            }
            reference_code("validation", error, false)
        }
    }
}

fn probe_diagnostic(id: &str, itag: u64, stage: &'static str, error: &str) {
    let enabled = std::env::var_os("MUSIFY_BENCH").is_some();
    #[cfg(test)]
    let enabled = enabled || TRACE_FIXTURES.load(Ordering::Relaxed);
    if enabled {
        eprintln!(
            "[native-embedded-probe] {}",
            json!({"id":id,"itag":itag,"stage":stage,"code":validation_code(error)})
        );
    }
}

fn stage_timing(id: &str, stage: &str, started: Instant) {
    if std::env::var_os("MUSIFY_BENCH").is_some() {
        eprintln!(
            "[native-stage] {}",
            json!({"id":id,"stage":stage,"atMs":trace_time(),
            "ms":started.elapsed().as_secs_f64()*1000.0})
        );
    }
}

fn trace_time() -> f64 {
    static EPOCH: LazyLock<Instant> = LazyLock::new(Instant::now);
    EPOCH.elapsed().as_secs_f64() * 1000.0
}

// Correlation is process-local only. Never log request bodies, remote status text,
// URLs, visitors, experiment values or decoded/ciphered parameters.
tokio::task_local! {
    static RESOLVE_TRACE: u64;
}
static NEXT_RESOLVE_TRACE: AtomicU64 = AtomicU64::new(1);
static NEXT_REQUEST_TRACE: AtomicU64 = AtomicU64::new(1);

fn diagnostic_enabled() -> bool {
    let enabled = std::env::var_os("MUSIFY_BENCH").is_some();
    #[cfg(test)]
    let enabled = enabled || TRACE_FIXTURES.load(Ordering::Relaxed);
    enabled
}

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
enum PostOrigin {
    Preview,
    Direct,
}

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
enum PostPhase {
    Started,
    Finished,
    PreviewKept,
    PreviewDiscarded,
    Consumed,
}

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
enum PostCode {
    Ok,
    SabrOnly,
    Transport,
    Http400,
    Http401,
    Http403,
    HttpStatus,
    Size,
    Utf8,
    Json,
    IdentityOrStatus,
    Cooldown,
    RefreshBinding,
    Other,
}

fn post_code(error: Option<&Error>) -> PostCode {
    match error {
        None => PostCode::Ok,
        Some(Error::Failed(code)) => match code.as_str() {
            "NATIVE_EMBEDDED_SABR_ONLY" => PostCode::SabrOnly,
            "NATIVE_EMBEDDED_TRANSPORT" => PostCode::Transport,
            "NATIVE_EMBEDDED_PLAYER_HTTP_400" => PostCode::Http400,
            "NATIVE_EMBEDDED_PLAYER_HTTP_401" => PostCode::Http401,
            "NATIVE_EMBEDDED_PLAYER_HTTP_403" => PostCode::Http403,
            "NATIVE_EMBEDDED_HTTP_STATUS" => PostCode::HttpStatus,
            "NATIVE_EMBEDDED_SIZE" => PostCode::Size,
            "NATIVE_EMBEDDED_UTF8" => PostCode::Utf8,
            "NATIVE_EMBEDDED_PLAYER_JSON" => PostCode::Json,
            "NATIVE_EMBEDDED_PLAYER_IDENTITY_OR_STATUS" => PostCode::IdentityOrStatus,
            "NATIVE_EMBEDDED_DISCOVERY_COOLDOWN" => PostCode::Cooldown,
            "NATIVE_EMBEDDED_REFRESH_BINDING" => PostCode::RefreshBinding,
            _ => PostCode::Other,
        },
        Some(_) => PostCode::Other,
    }
}

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PostTrace {
    resolve_id: u64,
    request_id: u64,
    origin: PostOrigin,
}

fn post_trace(origin: PostOrigin) -> Option<PostTrace> {
    diagnostic_enabled().then(|| PostTrace {
        resolve_id: RESOLVE_TRACE.try_with(|id| *id).unwrap_or(0),
        request_id: NEXT_REQUEST_TRACE.fetch_add(1, Ordering::Relaxed),
        origin,
    })
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PlayerSummary {
    identity_matches: bool,
    status_ok: bool,
    formats_present: bool,
    audio: usize,
    eligible: usize,
    urls: usize,
    ciphers: usize,
    missing: usize,
    invalid: usize,
    requires_signature: usize,
    requires_n: usize,
    direct_without_transform: usize,
    sabr_present: bool,
}

fn player_summary(value: &Value, id: &str) -> PlayerSummary {
    let formats = value
        .pointer("/streamingData/adaptiveFormats")
        .and_then(Value::as_array);
    let candidates = audio_candidates(formats.map(Vec::as_slice).unwrap_or_default());
    let mut summary = PlayerSummary {
        identity_matches: value
            .pointer("/videoDetails/videoId")
            .and_then(Value::as_str)
            == Some(id),
        status_ok: value
            .pointer("/playabilityStatus/status")
            .and_then(Value::as_str)
            == Some("OK"),
        formats_present: formats.is_some(),
        audio: formats
            .into_iter()
            .flatten()
            .filter(|f| {
                f["mimeType"]
                    .as_str()
                    .is_some_and(|s| s.starts_with("audio/"))
            })
            .count(),
        eligible: candidates.len(),
        urls: 0,
        ciphers: 0,
        missing: 0,
        invalid: 0,
        requires_signature: 0,
        requires_n: 0,
        direct_without_transform: 0,
        sabr_present: value
            .pointer("/streamingData/serverAbrStreamingUrl")
            .and_then(Value::as_str)
            .is_some_and(direct_audio_url),
    };
    for format in candidates {
        summary.urls += usize::from(format["url"].as_str().is_some_and(|s| !s.is_empty()));
        summary.ciphers += usize::from(
            format["signatureCipher"]
                .as_str()
                .is_some_and(|s| !s.is_empty()),
        );
        if ["url", "signatureCipher"]
            .iter()
            .all(|key| format.get(*key).is_none_or(Value::is_null))
        {
            summary.missing += 1;
        }
        match cipher(&format) {
            Ok(input) => {
                summary.requires_signature += usize::from(input.sig.is_some());
                summary.requires_n += usize::from(input.n.is_some());
                summary.direct_without_transform +=
                    usize::from(input.sig.is_none() && input.n.is_none());
            }
            Err(_) => summary.invalid += 1,
        }
    }
    summary
}

fn client_version_token(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 64
        && version.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-+".contains(&b))
}

fn public_version(config: &Config) -> Option<&str> {
    client_version_token(&config.version).then_some(config.version.as_str())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PostDiagnostic<'a> {
    #[serde(flatten)]
    trace: PostTrace,
    id: Option<&'a str>,
    phase: PostPhase,
    at_ms: f64,
    client_version: Option<&'a str>,
    signature_timestamp: u32,
    verified_timestamp: Option<u32>,
    http_status: Option<u16>,
    code: Option<PostCode>,
    summary: Option<PlayerSummary>,
}

fn post_diagnostic(
    trace: Option<PostTrace>,
    id: &str,
    config: &Config,
    sts: u32,
    phase: PostPhase,
    verified_timestamp: Option<u32>,
    http_status: Option<u16>,
    code: Option<PostCode>,
    summary: Option<PlayerSummary>,
) {
    if let Some(trace) = trace {
        eprintln!(
            "[native-player-attempt] {}",
            serde_json::to_string(&PostDiagnostic {
                trace,
                id: valid_id(id).then_some(id),
                phase,
                at_ms: trace_time(),
                client_version: public_version(config),
                signature_timestamp: sts,
                verified_timestamp,
                http_status,
                code,
                summary,
            })
            .unwrap_or_default()
        );
    }
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RequestChanges {
    version: bool,
    visitor: bool,
    flags: bool,
    client_context: bool,
    player: bool,
    signature_timestamp: bool,
    effective_request: bool,
}

fn request_changes(previous: &Ready, next: &Ready, id: &str) -> RequestChanges {
    RequestChanges {
        version: previous.config.version != next.config.version,
        visitor: previous.config.visitor != next.config.visitor,
        flags: previous.config.flags != next.config.flags,
        client_context: previous.config.client_extra != next.config.client_extra,
        player: previous.config.player != next.config.player,
        signature_timestamp: previous.decoder.signature_timestamp
            != next.decoder.signature_timestamp,
        effective_request: body(&previous.config, id, previous.decoder.signature_timestamp)
            != body(&next.config, id, next.decoder.signature_timestamp),
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RefreshDiagnostic<'a> {
    resolve_id: u64,
    id: Option<&'a str>,
    at_ms: f64,
    code: PostCode,
    changes: Option<RequestChanges>,
    reused_cached: Option<bool>,
    client_version: Option<&'a str>,
    signature_timestamp: Option<u32>,
}

fn refresh_diagnostic(
    id: &str,
    code: PostCode,
    compared: Option<(&Ready, &Ready)>,
    reused_cached: Option<bool>,
) {
    if diagnostic_enabled() {
        eprintln!(
            "[native-player-refresh] {}",
            serde_json::to_string(&RefreshDiagnostic {
                resolve_id: RESOLVE_TRACE.try_with(|id| *id).unwrap_or(0),
                id: valid_id(id).then_some(id),
                at_ms: trace_time(),
                code,
                changes: compared.map(|(previous, next)| request_changes(previous, next, id)),
                reused_cached,
                client_version: compared.and_then(|(_, next)| public_version(&next.config)),
                signature_timestamp: compared.map(|(_, next)| next.decoder.signature_timestamp),
            })
            .unwrap_or_default()
        );
    }
}

fn fail(code: &str) -> Error {
    Error::Failed(format!("NATIVE_EMBEDDED_{code}"))
}

fn valid_id(id: &str) -> bool {
    id.len() == 11
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

fn youtube_url(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("www.youtube.com")
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
}

fn player_url(value: &str) -> Result<reqwest::Url, Error> {
    let url = reqwest::Url::parse("https://www.youtube.com/")
        .unwrap()
        .join(value)
        .map_err(|_| fail("PLAYER_URL"))?;
    let parts: Vec<_> = url.path().split('/').collect();
    if !youtube_url(&url)
        || url.query().is_some()
        || !url.path().starts_with("/s/player/")
        || !url.path().ends_with("/base.js")
        || parts.len() < 5
        || !(8..=32).contains(&parts[3].len())
        || !parts[3].bytes().all(|b| b.is_ascii_alphanumeric())
        || parts.iter().any(|p| *p == "." || *p == "..")
        || !url
            .path()
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/_.-".contains(&b))
    {
        return Err(fail("PLAYER_URL"));
    }
    Ok(url)
}

static WEB: LazyLock<Result<reqwest::Client, Error>> = LazyLock::new(|| {
    reqwest::Client::builder()
        .user_agent(UA)
        // Public text may be compressed. text_response caps decoded bytes;
        // original audio ranges use the separate, uncompressed CDN client.
        .gzip(true)
        .timeout(Duration::from_secs(4))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() <= 2
                && attempt.previous().iter().all(youtube_url)
                && youtube_url(attempt.url())
            {
                attempt.follow()
            } else {
                attempt.error("NATIVE_EMBEDDED_REDIRECT")
            }
        }))
        .build()
        .map_err(|_| fail("HTTP"))
});

// Encoded byte ranges must remain encoded. The fast clients' shared HTTP settings
// are independent; only this stricter embedded validator disables decompression.
static CDN: LazyLock<Result<reqwest::Client, Error>> = LazyLock::new(|| {
    reqwest::Client::builder()
        .no_gzip()
        .timeout(Duration::from_secs(2))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if redirect_allowed(attempt.previous(), attempt.url()) {
                attempt.follow()
            } else {
                attempt.error("NATIVE_EMBEDDED_REDIRECT")
            }
        }))
        .build()
        .map_err(|_| fail("HTTP"))
});

async fn text_response(mut response: reqwest::Response) -> Result<String, Error> {
    if !response.status().is_success() {
        return Err(fail("HTTP_STATUS"));
    }
    if response.content_length().is_some_and(|n| n > LIMIT as u64) {
        return Err(fail("SIZE"));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| fail("TRANSPORT"))? {
        if chunk.len() > LIMIT.saturating_sub(body.len()) {
            return Err(fail("SIZE"));
        }
        body.extend_from_slice(&chunk);
    }
    String::from_utf8(body).map_err(|_| fail("UTF8"))
}

async fn get(http: &reqwest::Client, url: reqwest::Url) -> Result<String, Error> {
    if !youtube_url(&url) {
        return Err(fail("ORIGIN"));
    }
    let role = if url.path() == "/watch" {
        "watch"
    } else if url.path().starts_with("/embed/") {
        "embed"
    } else {
        "player-source"
    };
    let started = Instant::now();
    if std::env::var_os("MUSIFY_BENCH").is_some() {
        let _ = trace_time();
    }
    let response = http
        .get(url)
        .header("Accept-Language", "en")
        .header("Referer", "https://www.reddit.com/")
        .send()
        .await
        .map_err(|_| fail("TRANSPORT"))?;
    let headers_ms = started.elapsed().as_secs_f64() * 1000.0;
    let result = text_response(response).await;
    if std::env::var_os("MUSIFY_BENCH").is_some() {
        eprintln!(
            "[native-text] {}",
            json!({"role":role,"headersMs":headers_ms,"atMs":trace_time(),
            "totalMs":started.elapsed().as_secs_f64()*1000.0,
            "decodedBytes":result.as_ref().ok().map(String::len)})
        );
    }
    result
}

// A JoinHandle alone detaches on drop. These requests instead belong to the
// resolve future, including while it awaits a result or the configuration lock.
struct RawGet {
    start: Option<tokio::sync::oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<Result<String, Error>>,
}

impl RawGet {
    fn spawn<F>(at: tokio::time::Instant, fetch: F) -> Self
    where F: Future<Output = Result<String, Error>> + Send + 'static {
        let (start, admitted) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            tokio::select! {
                _ = tokio::time::sleep_until(at) => {},
                _ = admitted => {},
            }
            // Headers, decompression and the entire decoded body share this
            // deadline from dispatch; adoption never restarts a timed-out GET.
            tokio::time::timeout(DISCOVERY_TIMEOUT, fetch).await
                .map_err(|_| fail("DISCOVERY_TIMEOUT"))?
        });
        Self { start: Some(start), task }
    }

    fn admit(&mut self) {
        if let Some(start) = self.start.take() { let _ = start.send(()); }
    }

    async fn read(mut self) -> Result<String, Error> {
        (&mut self.task).await.map_err(|_| fail("PREFETCH_CANCELLED"))?
    }
}

impl Drop for RawGet {
    fn drop(&mut self) { self.task.abort(); }
}

// At most two LIMIT-byte decoded documents (8 MiB logically, not an RSS bound).
// No source JS, parsed config, decoder, POST or cache reservation lives here.
pub(super) struct RawPrefetch {
    id: String,
    watch: RawGet,
    embed: RawGet,
}

impl RawPrefetch {
    fn spawn<W, E>(id: &str, watch: W, embed: E) -> Self
    where
        W: Future<Output = Result<String, Error>> + Send + 'static,
        E: Future<Output = Result<String, Error>> + Send + 'static,
    {
        let at = tokio::time::Instant::now() + PREFETCH_DELAY;
        Self { id: id.into(), watch: RawGet::spawn(at, watch), embed: RawGet::spawn(at, embed) }
    }

    fn adopt(self, id: &str) -> Result<(RawGet, RawGet), Error> {
        if self.id != id { return Err(fail("PREFETCH_BINDING")); }
        let Self { mut watch, mut embed, .. } = self;
        // Admission still wakes pending tasks without restarting their GETs.
        watch.admit();
        embed.admit();
        raw_prefetch_diagnostic(id, "adopted", None);
        Ok((watch, embed))
    }
}

fn claim_prefetch(id: &str, foreground: bool, claimed: &AtomicBool) -> bool {
    foreground && valid_id(id)
        && claimed.compare_exchange(false, true, Ordering::Relaxed, Ordering::Relaxed).is_ok()
}

fn raw_prefetch_diagnostic(id: &str, phase: &'static str, role: Option<&'static str>) {
    if diagnostic_enabled() {
        // Reservation may now initialize the shared trace clock before the fast
        // client. Compare stage durations, not that shifted origin, across builds.
        eprintln!("[native-raw-prefetch] {}", json!({"id":id,"phase":phase,"role":role,
            "epoch":"first-native-trace-event","atMs":trace_time()}));
    }
}

pub(super) fn prefetch_first(id: &str, foreground: bool) -> Option<RawPrefetch> {
    if !claim_prefetch(id, foreground, &PREFETCH_CLAIMED) { return None; }
    raw_prefetch_diagnostic(id, "reserved", None);
    let watch_id = id.to_owned();
    let embed_id = id.to_owned();
    Some(RawPrefetch::spawn(id, async move {
        raw_prefetch_diagnostic(&watch_id, "dispatched", Some("watch"));
        let http = WEB.as_ref().map_err(|_| fail("HTTP"))?;
        get(http, reqwest::Url::parse(&format!("https://www.youtube.com/watch?v={watch_id}&hl=en")).unwrap()).await
    }, async move {
        raw_prefetch_diagnostic(&embed_id, "dispatched", Some("embed"));
        let http = WEB.as_ref().map_err(|_| fail("HTTP"))?;
        get(http, reqwest::Url::parse(&format!("https://www.youtube.com/embed/{embed_id}?html5=1")).unwrap()).await
    }))
}

// Parse JSON values, never evaluate an assignment or arbitrary HTML/script text.
fn json_after(text: &str, marker: &str) -> Result<Vec<Value>, Error> {
    if text.len() > LIMIT {
        return Err(fail("SIZE"));
    }
    let mut values = Vec::new();
    for (offset, _) in text.match_indices(marker).take(65) {
        if values.len() >= 64 {
            return Err(fail("JSON_COUNT"));
        }
        let tail = text[offset + marker.len()..].trim_start();
        if !tail.starts_with('{') {
            return Err(fail("JSON"));
        }
        let mut stream = serde_json::Deserializer::from_str(tail).into_iter::<Value>();
        values.push(
            stream
                .next()
                .ok_or_else(|| fail("JSON"))?
                .map_err(|_| fail("JSON"))?,
        );
    }
    Ok(values)
}

fn watch_player(html: &str, id: &str) -> Result<Value, Error> {
    let mut candidates = json_after(html, "ytInitialPlayerResponse =")?;
    candidates.extend(json_after(html, "ytInitialPlayerResponse=")?);
    if candidates.len() != 1 {
        return Err(fail("WATCH_SCHEMA"));
    }
    let value = candidates.pop().unwrap();
    eligible(&value, id)?;
    Ok(value)
}

fn eligible(value: &Value, id: &str) -> Result<(), Error> {
    if value
        .pointer("/playabilityStatus/status")
        .and_then(Value::as_str)
        != Some("OK")
        || value
            .pointer("/videoDetails/videoId")
            .and_then(Value::as_str)
            != Some(id)
        || value
            .pointer("/playabilityStatus/playableInEmbed")
            .and_then(Value::as_bool)
            != Some(true)
        || value
            .pointer("/microformat/playerMicroformatRenderer/isFamilySafe")
            .and_then(Value::as_bool)
            == Some(false)
    {
        return Err(fail("INELIGIBLE"));
    }
    if value.pointer(NOTICE_PATH).and_then(Value::as_str) != Some(NOTICE) {
        return Err(fail("NOT_MFK"));
    }
    Ok(())
}

#[derive(Clone, PartialEq)]
struct Config {
    version: String,
    visitor: String,
    flags: String,
    player: reqwest::Url,
    client_extra: Map<String, Value>,
}

fn bounded_string(value: &Value, max: usize) -> Result<String, Error> {
    value
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= max && !s.chars().any(char::is_control))
        .map(str::to_owned)
        .ok_or_else(|| fail("CONFIG"))
}

#[derive(Clone, Copy)]
enum ConfigField {
    Version,
    Visitor,
    HostFlags,
    PlayerUrl,
    Platform,
    FormFactor,
    OsName,
    OsVersion,
    BrowserName,
    BrowserVersion,
    Region,
    DeviceExperiment,
    Rollout,
    InstallData,
}

impl ConfigField {
    const ALL: [Self; 14] = [
        Self::Version, Self::Visitor, Self::HostFlags, Self::PlayerUrl,
        Self::Platform, Self::FormFactor, Self::OsName, Self::OsVersion,
        Self::BrowserName, Self::BrowserVersion, Self::Region,
        Self::DeviceExperiment, Self::Rollout, Self::InstallData,
    ];

    fn code(self) -> &'static str {
        match self {
            Self::Version => "VERSION",
            Self::Visitor => "VISITOR",
            Self::HostFlags => "HOST_FLAGS",
            Self::PlayerUrl => "PLAYER_URL",
            Self::Platform => "PLATFORM",
            Self::FormFactor => "FORM_FACTOR",
            Self::OsName => "OS_NAME",
            Self::OsVersion => "OS_VERSION",
            Self::BrowserName => "BROWSER_NAME",
            Self::BrowserVersion => "BROWSER_VERSION",
            Self::Region => "REGION",
            Self::DeviceExperiment => "DEVICE_EXPERIMENT",
            Self::Rollout => "ROLLOUT",
            Self::InstallData => "INSTALL_DATA",
        }
    }
}

// Both parts are local constants. Never include a remote value or key in errors.
fn config_string(
    value: Option<&Value>,
    field: ConfigField,
    max: usize,
    ascii: bool,
) -> Result<String, Error> {
    let problem = |code: &'static str| fail(&format!("CONFIG_{}_{}", field.code(), code));
    let value = value.ok_or_else(|| problem("MISSING"))?;
    let value = value.as_str().ok_or_else(|| problem("TYPE"))?;
    if value.is_empty() {
        return Err(problem("EMPTY"));
    }
    if value.len() > max {
        return Err(problem("SIZE"));
    }
    if value.chars().any(char::is_control) {
        return Err(problem("CONTROL"));
    }
    if ascii && !value.is_ascii() {
        return Err(problem("ASCII"));
    }
    Ok(value.to_owned())
}

fn config_error_code(error: &Error) -> String {
    let Error::Failed(code) = error else { return "OTHER".into() };
    let suffix = code.strip_prefix("NATIVE_EMBEDDED_").unwrap_or_default();
    if matches!(suffix,
        "CONFIG_OBJECT_TYPE" | "CONFIG_IDENTITY" | "CONFIG_AMBIGUOUS"
        | "CONFIG_VERSION_FORMAT" | "PLAYER_URL" | "JSON" | "JSON_COUNT" | "SIZE"
    ) {
        return suffix.to_owned();
    }
    for field in ConfigField::ALL {
        for problem in ["MISSING", "TYPE", "EMPTY", "SIZE", "CONTROL", "ASCII"] {
            let expected = format!("CONFIG_{}_{}", field.code(), problem);
            if suffix == expected {
                return expected;
            }
        }
    }
    "OTHER".into()
}

fn config_diagnostic(id: &str, attempt: u8, error: Option<&Error>) {
    if diagnostic_enabled() {
        eprintln!("[native-embedded-config] {}", json!({
            "resolveId": RESOLVE_TRACE.try_with(|id| *id).unwrap_or(0),
            "id": valid_id(id).then_some(id), "atMs": trace_time(),
            "attempt": attempt, "renewalUsed": attempt == 2,
            "code": error.map(config_error_code).unwrap_or_else(|| "OK".into()),
        }));
    }
}

fn published_client(client: Option<&Value>) -> Result<Map<String, Value>, Error> {
    let mut extra = Map::new();
    let Some(client) = client else {
        return Ok(extra);
    };
    for (key, field, limit) in [
        ("platform", ConfigField::Platform, 128),
        ("clientFormFactor", ConfigField::FormFactor, 128),
        ("osName", ConfigField::OsName, 128),
        ("osVersion", ConfigField::OsVersion, 128),
        ("browserName", ConfigField::BrowserName, 128),
        ("browserVersion", ConfigField::BrowserVersion, 128),
        ("gl", ConfigField::Region, 128),
        ("deviceExperimentId", ConfigField::DeviceExperiment, 4096),
        ("rolloutToken", ConfigField::Rollout, 4096),
    ] {
        if let Some(value) = client.get(key) {
            let value = config_string(Some(value), field, limit, true)?;
            extra.insert(key.into(), json!(value));
        }
    }
    if let Some(value) = client.pointer("/configInfo/appInstallData") {
        let value = config_string(Some(value), ConfigField::InstallData, 8192, true)?;
        extra.insert("configInfo".into(), json!({"appInstallData":value}));
    }
    Ok(extra)
}

fn config(html: &str) -> Result<Config, Error> {
    let mut selected = Map::new();
    // Whitelist configuration only; do not propagate request/user/tracking contexts.
    for mut value in json_after(html, "ytcfg.set(")? {
        let object = value.as_object_mut().ok_or_else(|| fail("CONFIG_OBJECT_TYPE"))?;
        for key in [
            "INNERTUBE_CLIENT_NAME",
            "INNERTUBE_CLIENT_VERSION",
            "INNERTUBE_CONTEXT_CLIENT_NAME",
            "VISITOR_DATA",
            "INNERTUBE_CONTEXT",
            "WEB_PLAYER_CONTEXT_CONFIGS",
        ] {
            if let Some(value) = object.remove(key) {
                if selected.get(key).is_some_and(|previous| previous != &value) {
                    return Err(fail("CONFIG_AMBIGUOUS"));
                }
                selected.insert(key.into(), value);
            }
        }
    }
    let value = Value::Object(selected);
    if value["INNERTUBE_CLIENT_NAME"] != "WEB_EMBEDDED_PLAYER"
        || value["INNERTUBE_CONTEXT_CLIENT_NAME"] != 56
    {
        return Err(fail("CONFIG_IDENTITY"));
    }
    let version = config_string(
        value.get("INNERTUBE_CLIENT_VERSION"),
        ConfigField::Version,
        64,
        false,
    )?;
    // The official embed also publishes rollout suffixes. Preserve its opaque
    // token unchanged in both the request body and header; never infer a date.
    if !client_version_token(&version) {
        return Err(fail("CONFIG_VERSION_FORMAT"));
    }
    let client = value.pointer("/INNERTUBE_CONTEXT/client");
    if client.is_some_and(|client| {
        client
            .get("clientName")
            .is_some_and(|v| v != "WEB_EMBEDDED_PLAYER")
            || client
                .get("clientVersion")
                .is_some_and(|v| v.as_str() != Some(version.as_str()))
            || client
                .get("visitorData")
                .zip(value.get("VISITOR_DATA"))
                .is_some_and(|(a, b)| a != b)
    }) {
        return Err(fail("CONFIG_AMBIGUOUS"));
    }
    let context =
        &value["WEB_PLAYER_CONTEXT_CONFIGS"]["WEB_PLAYER_CONTEXT_CONFIG_ID_EMBEDDED_PLAYER"];
    let visitor = value
        .get("VISITOR_DATA")
        .or_else(|| value.pointer("/INNERTUBE_CONTEXT/client/visitorData"));
    Ok(Config {
        version,
        visitor: config_string(visitor, ConfigField::Visitor, 4096, false)?,
        flags: config_string(context.get("encryptedHostFlags"), ConfigField::HostFlags, 32 * 1024, false)?,
        player: player_url(&config_string(context.get("jsUrl"), ConfigField::PlayerUrl, 2048, false)?)?,
        client_extra: published_client(client)?,
    })
}

#[derive(Default)]
struct ConfigCache {
    entries: HashMap<String, (Arc<Config>, Instant)>,
    failed: HashMap<String, Instant>,
}
static CONFIGS: LazyLock<tokio::sync::Mutex<ConfigCache>> = LazyLock::new(Default::default);
struct Compiled {
    url: reqwest::Url,
    sha: [u8; 32],
    decoder: Arc<PreparedDecoder>,
    at: Instant,
}
#[derive(Default)]
struct DecoderCache {
    entries: Vec<Compiled>,
    failed: HashMap<String, Instant>,
}
static COMPILED: LazyLock<tokio::sync::Mutex<DecoderCache>> = LazyLock::new(Default::default);

fn failure_cache(failed: &mut HashMap<String, Instant>, key: &str) -> Result<(), Error> {
    failed.retain(|_, at| at.elapsed() < Duration::from_secs(30));
    if failed.contains_key(key) {
        return Err(fail("DISCOVERY_COOLDOWN"));
    }
    if failed.len() >= 16 {
        if let Some(oldest) = failed
            .iter()
            .min_by_key(|(_, at)| *at)
            .map(|(key, _)| key.clone())
        {
            failed.remove(&oldest);
        }
    }
    // A cancelled/failed download still limits concurrent retries. Success removes it.
    failed.insert(key.into(), Instant::now());
    Ok(())
}

struct DiscoveredConfig {
    config: Arc<Config>,
    renewed: bool,
}

async fn configuration(http: &reqwest::Client, id: &str, prefetched: Option<RawGet>) -> Result<DiscoveredConfig, Error> {
    // The existing admission/lock/parse-retry budget stays four seconds. A body
    // completed before its transport deadline can wait for admission; a failed
    // prefetched GET is not replaced. Only the existing parse retry may fetch #2.
    configuration_prefetched(&CONFIGS, id, Instant::now() + DISCOVERY_TIMEOUT, prefetched, |_| async {
        get(http, reqwest::Url::parse(&format!("https://www.youtube.com/embed/{id}?html5=1")).unwrap()).await
    }).await
}

async fn configuration_prefetched<F, FF>(
    cache: &tokio::sync::Mutex<ConfigCache>, id: &str, deadline: Instant,
    mut prefetched: Option<RawGet>, mut fetch: F,
) -> Result<DiscoveredConfig, Error>
where F: FnMut(u8) -> FF, FF: Future<Output = Result<String, Error>> {
    configuration_bounded(cache, id, deadline, |attempt| {
        let first = if attempt == 1 { prefetched.take() } else { None };
        let fresh = if first.is_none() { Some(fetch(attempt)) } else { None };
        async move {
            match first {
                Some(raw) => raw.read().await,
                None => fresh.expect("a non-prefetched attempt owns its fetch").await,
            }
        }
    }).await
}

async fn configuration_bounded<F, FF>(
    cache: &tokio::sync::Mutex<ConfigCache>,
    id: &str,
    deadline: Instant,
    fetch: F,
) -> Result<DiscoveredConfig, Error>
where
    F: FnMut(u8) -> FF,
    FF: std::future::Future<Output = Result<String, Error>>,
{
    let result = tokio::time::timeout_at(
        tokio::time::Instant::from_std(deadline),
        configuration_inner(cache, id, deadline, fetch),
    ).await.map_err(|_| fail("DISCOVERY_TIMEOUT"))?;
    if Instant::now() >= deadline {
        return Err(fail("DISCOVERY_TIMEOUT"));
    }
    result
}

async fn configuration_inner<F, FF>(
    cache: &tokio::sync::Mutex<ConfigCache>,
    id: &str,
    deadline: Instant,
    mut fetch: F,
) -> Result<DiscoveredConfig, Error>
where
    F: FnMut(u8) -> FF,
    FF: std::future::Future<Output = Result<String, Error>>,
{
    let mut cache = cache.lock().await;
    if Instant::now() >= deadline {
        return Err(fail("DISCOVERY_TIMEOUT"));
    }
    cache.entries.retain(|_, (_, at)| at.elapsed() < TTL);
    if let Some((value, _)) = cache.entries.get(id) {
        return Ok(DiscoveredConfig { config: value.clone(), renewed: false });
    }
    failure_cache(&mut cache.failed, id)?;
    let mut attempt = 1;
    let value = loop {
        // Transport/status failures do not enter parser recovery. The admission
        // budget covers the lock, waiting, parsing and any second GET. A raw
        // prefetched first GET additionally keeps its earlier dispatch deadline;
        // these windows are distinct, not four seconds total from that dispatch.
        let html = fetch(attempt).await?;
        if Instant::now() >= deadline {
            return Err(fail("DISCOVERY_TIMEOUT"));
        }
        #[cfg(test)]
        {
            save_private_fixture(Some(id), "embed.html.local", html.as_bytes());
            save_private_fixture(Some(id), &format!("embed-attempt-{attempt}.html.local"), html.as_bytes());
        }
        let result = config(&html);
        config_diagnostic(id, attempt, result.as_ref().err());
        match result {
            Ok(value) => break Arc::new(value),
            Err(_) if attempt == 1 => attempt = 2,
            Err(error) => return Err(error),
        }
    };
    if Instant::now() >= deadline {
        return Err(fail("DISCOVERY_TIMEOUT"));
    }
    if cache.entries.len() >= 16 {
        if let Some(oldest) = cache
            .entries
            .iter()
            .min_by_key(|(_, (_, at))| *at)
            .map(|(id, _)| id.clone())
        {
            cache.entries.remove(&oldest);
        }
    }
    cache
        .entries
        .insert(id.to_owned(), (value.clone(), Instant::now()));
    cache.failed.remove(id);
    Ok(DiscoveredConfig { config: value, renewed: attempt == 2 })
}

fn invalidate_config(cache: &mut ConfigCache, id: &str, used: &Arc<Config>) -> bool {
    if !cache
        .entries
        .get(id)
        .is_some_and(|(current, _)| Arc::ptr_eq(current, used) && current == used)
    {
        return false;
    }
    cache.entries.remove(id);
    cache.failed.remove(id);
    let _ = failure_cache(&mut cache.failed, id);
    true
}

fn invalidate_compiled(
    cache: &mut DecoderCache,
    url: &reqwest::Url,
    used: &Arc<PreparedDecoder>,
) -> bool {
    let Some(index) = cache
        .entries
        .iter()
        .position(|entry| &entry.url == url && Arc::ptr_eq(&entry.decoder, used))
    else {
        return false;
    };
    cache.entries.remove(index);
    cache.failed.remove(url.as_str());
    let _ = failure_cache(&mut cache.failed, url.as_str());
    true
}

async fn invalidate_decoder(url: &reqwest::Url, used: &Arc<PreparedDecoder>) {
    let sha = {
        let mut cache = COMPILED.lock().await;
        let sha = cache
            .entries
            .iter()
            .find(|entry| &entry.url == url && Arc::ptr_eq(&entry.decoder, used))
            .map(|entry| entry.sha);
        invalidate_compiled(&mut cache, url, used);
        sha
    };
    if let Some(sha) = sha {
        let _ = crate::youtube_decoder_cache::invalidate(url.as_str(), sha).await;
    }
}

struct Preparation {
    decoder: Arc<PreparedDecoder>,
    response: Option<Preview>,
    post_started: bool,
    deadline: Option<Instant>,
}

struct Preview {
    response: Result<Value, Error>,
    trace: Option<PostTrace>,
}

#[derive(Clone, Copy)]
struct EarlySabr {
    sha: [u8; 32],
    deadline: Instant,
    reservation: Instant,
}

struct DownloadedSource {
    source: String,
    deadline: Instant,
}

fn is_sabr<T>(result: &Result<T, Error>) -> bool {
    matches!(result, Err(Error::Failed(code)) if code == "NATIVE_EMBEDDED_SABR_ONLY")
}

// A speculative request may start the server's readiness clock while the AST
// is analyzed. This literal is only a hint: no response is used unless the
// complete analyzer independently returns exactly the same timestamp.
fn timestamp_hint(source: &str) -> Option<u32> {
    if source.len() > LIMIT {
        return None;
    }
    let mut found = None;
    for (start, _) in source.match_indices("signatureTimestamp") {
        if start > 0 && source.as_bytes()[start - 1].is_ascii_alphanumeric()
            || start > 0 && b"_$".contains(&source.as_bytes()[start - 1])
        {
            continue;
        }
        let suffix = source[start + "signatureTimestamp".len()..].trim_start();
        let Some(suffix) = suffix.strip_prefix(':') else {
            continue;
        };
        let suffix = suffix.trim_start();
        let end = suffix.bytes().take_while(u8::is_ascii_digit).count();
        if end == 0
            || end > 10
            || suffix.starts_with('0')
            || !suffix[end..].trim_start().starts_with([',', '}'])
        {
            continue;
        }
        let value = suffix[..end].parse::<u32>().ok()?;
        if found.replace(value).is_some() {
            return None;
        }
    }
    found
}

async fn analyze_preview<P, R>(
    prepare: P,
    request: R,
    hint: u32,
) -> Result<(PreparedDecoder, Option<Result<Value, Error>>), Error>
where
    P: Future<Output = Result<PreparedDecoder, String>>,
    R: Future<Output = Result<Value, Error>>,
{
    let (decoder, response) = tokio::join!(prepare, request);
    let decoder = decoder.map_err(|_| fail("DECODER_PREPARE"))?;
    let response = (decoder.signature_timestamp == hint).then_some(response);
    Ok((decoder, response))
}

async fn admitted_request<R>(
    gate: Option<tokio::sync::oneshot::Receiver<()>>,
    request: R,
) -> Result<Value, Error>
where
    R: Future<Output = Result<Value, Error>>,
{
    if let Some(gate) = gate {
        // A public metadata POST may overlap watch discovery. Its Result (even
        // an error) stays quarantined until admission; rejecting/dropping the
        // gate cancels a pending request. No CDN or refresh runs in this helper.
        // A rejected watch can therefore cost up to one already-sent POST.
        let (_, response) =
            tokio::try_join!(async { gate.await.map_err(|_| fail("ADMISSION")) }, async {
                Ok::<_, Error>(request.await)
            },)?;
        return response;
    }
    request.await
}

async fn admitted_preview<R>(
    admission: Option<tokio::sync::oneshot::Receiver<()>>,
    request: R,
    early: Option<tokio::sync::oneshot::Sender<EarlySabr>>,
    signal: EarlySabr,
) -> Result<Value, Error>
where
    R: Future<Output = Result<Value, Error>>,
{
    let result = admitted_request(admission, request).await;
    // The notice is a reason to discard work, never proof of an analyzed ST.
    if is_sabr(&result) {
        if let Some(early) = early {
            let _ = early.send(signal);
        }
    }
    result
}
fn prepared_measurement(
    id: Option<&str>,
    mode: &str,
    started: Instant,
    download_ms: f64,
    analyze_ms: f64,
    preview: bool,
) {
    if std::env::var_os("MUSIFY_BENCH").is_some() {
        eprintln!(
            "[native-prepare] {}",
            json!({"id":id,"mode":mode,
            "downloadMs":download_ms,"analysisAndPreviewMs":analyze_ms,"preview":preview,
            "totalMs":started.elapsed().as_secs_f64()*1000.0})
        );
    }
}

async fn prepared(http: &reqwest::Client, config: &Config, deadline: Option<Instant>) -> Result<Arc<PreparedDecoder>, Error> {
    Ok(prepare_request(http, config, None, None, None, None, deadline).await?.decoder)
}

async fn prepare_request(
    http: &reqwest::Client,
    config: &Config,
    id: Option<&str>,
    admission: Option<tokio::sync::oneshot::Receiver<()>>,
    early: Option<tokio::sync::oneshot::Sender<EarlySabr>>,
    downloaded: Option<DownloadedSource>,
    inherited: Option<Instant>,
) -> Result<Preparation, Error> {
    let deadline = inherited
        .or(downloaded.as_ref().map(|source| source.deadline))
        .unwrap_or_else(|| Instant::now() + youtube_decoder::PREPARE_TIMEOUT);
    let work = prepare_request_inner(
        http,
        config,
        id,
        admission,
        early,
        downloaded,
        Some(deadline),
    );
    let result = tokio::time::timeout_at(deadline.into(), work)
        .await
        .map_err(|_| fail("DECODER_PREPARE"))?;
    if Instant::now() >= deadline {
        return Err(fail("DECODER_PREPARE"));
    }
    result
}

async fn prepare_request_inner(
    http: &reqwest::Client,
    config: &Config,
    id: Option<&str>,
    admission: Option<tokio::sync::oneshot::Receiver<()>>,
    early: Option<tokio::sync::oneshot::Sender<EarlySabr>>,
    downloaded: Option<DownloadedSource>,
    inherited: Option<Instant>,
) -> Result<Preparation, Error> {
    let started = Instant::now();
    if inherited.is_some_and(|deadline| started >= deadline) {
        return Err(fail("DECODER_PREPARE"));
    }
    let mut cache = COMPILED.lock().await;
    if inherited.is_some_and(|deadline| Instant::now() >= deadline) {
        return Err(fail("DECODER_PREPARE"));
    }
    cache.entries.retain(|entry| entry.at.elapsed() < TTL);
    if let Some(entry) = cache
        .entries
        .iter()
        .find(|entry| downloaded.is_none() && entry.url == config.player)
    {
        prepared_measurement(id, "memory", started, 0.0, 0.0, false);
        return Ok(Preparation {
            decoder: entry.decoder.clone(),
            response: None,
            post_started: false,
            deadline: inherited,
        });
    }
    failure_cache(&mut cache.failed, config.player.as_str())?;
    let reservation = cache.failed[config.player.as_str()];
    let download_started = Instant::now();
    let supplied = downloaded.is_some();
    let (source, inherited_deadline) = if let Some(downloaded) = downloaded {
        (downloaded.source, Some(downloaded.deadline))
    } else {
        (get(http, config.player.clone()).await?, inherited)
    };
    if inherited_deadline.is_some_and(|deadline| Instant::now() >= deadline) {
        return Err(fail("DECODER_PREPARE"));
    }
    let download_ms = download_started.elapsed().as_secs_f64() * 1000.0;
    #[cfg(test)]
    save_private_fixture(
        None,
        &format!(
            "player-{:x}.js.local",
            Sha256::digest(config.player.as_str().as_bytes())
        ),
        source.as_bytes(),
    );
    let sha: [u8; 32] = Sha256::digest(source.as_bytes()).into();
    let mut response = None;
    let mut analyze_ms = 0.0;
    let mut preview = false;
    let mut post_started = false;
    let mut analysis_deadline = inherited_deadline;
    let mut mode = "memory-sha";
    // Controlled cold benchmarks bypass only persistent reads, never safety checks.
    let fresh = std::env::var_os("MUSIFY_BENCH").is_some()
        && std::env::var_os("MUSIFY_BENCH_FRESH_DECODER").is_some();
    let saved = if fresh {
        None
    } else {
        crate::youtube_decoder_cache::load(config.player.as_str(), &source).await
    };
    if inherited_deadline.is_some_and(|deadline| Instant::now() >= deadline) {
        return Err(fail("DECODER_PREPARE"));
    }
    let decoder = if let Some(entry) = cache.entries.iter().find(|entry| entry.sha == sha) {
        entry.decoder.clone()
    } else if let Some(decoder) = saved {
        mode = "disk";
        decoder
    } else {
        mode = "analyzed";
        // Replacement POST2 belongs to the coordinator. Keep its public ID for
        // timing/fixtures without starting a second speculative request here.
        let hint = if supplied {
            None
        } else {
            id.and_then(|_| timestamp_hint(&source))
        };
        let analyze_started = Instant::now();
        let deadline =
            inherited_deadline.unwrap_or_else(|| Instant::now() + youtube_decoder::PREPARE_TIMEOUT);
        analysis_deadline = Some(deadline);
        let decoder = if let (Some(id), Some(hint)) = (id, hint) {
            post_started = true;
            let trace = post_trace(PostOrigin::Preview);
            let (decoder, speculative) = tokio::time::timeout_at(
                deadline.into(),
                analyze_preview(
                    youtube_decoder::prepare_until(source.clone(), deadline),
                    admitted_preview(
                        admission,
                        player_response_traced(http, PLAYER, config, id, hint, trace),
                        early,
                        EarlySabr {
                            sha,
                            deadline,
                            reservation,
                        },
                    ),
                    hint,
                ),
            )
            .await
            .map_err(|_| fail("DECODER_PREPARE"))??;
            preview = speculative.is_some();
            post_diagnostic(
                trace,
                id,
                config,
                hint,
                if preview {
                    PostPhase::PreviewKept
                } else {
                    PostPhase::PreviewDiscarded
                },
                Some(decoder.signature_timestamp),
                None,
                None,
                None,
            );
            response = speculative.map(|response| Preview { response, trace });
            decoder
        } else {
            youtube_decoder::prepare_until(source.clone(), deadline)
                .await
                .map_err(|_| fail("DECODER_PREPARE"))?
        };
        analyze_ms = analyze_started.elapsed().as_secs_f64() * 1000.0;
        if Instant::now() >= deadline {
            return Err(fail("DECODER_PREPARE"));
        }
        let _ =
            crate::youtube_decoder_cache::store(config.player.as_str(), &source, &decoder).await;
        Arc::new(decoder)
    };
    if analysis_deadline.is_some_and(|deadline| Instant::now() >= deadline) {
        return Err(fail("DECODER_PREPARE"));
    }
    cache.entries.retain(|entry| entry.url != config.player);
    if cache.entries.len() >= MAX_DECODERS {
        cache.entries.remove(0);
    }
    cache.entries.push(Compiled {
        url: config.player.clone(),
        sha,
        decoder: decoder.clone(),
        at: Instant::now(),
    });
    cache.failed.remove(config.player.as_str());
    prepared_measurement(id, mode, started, download_ms, analyze_ms, preview);
    Ok(Preparation {
        decoder,
        response,
        post_started,
        deadline: analysis_deadline,
    })
}
fn body(config: &Config, id: &str, sts: u32) -> Value {
    let mut request = json!({"videoId":id,"context":{"client":{"clientName":"WEB_EMBEDDED_PLAYER","clientVersion":config.version,"hl":"en","userAgent":UA,"visitorData":config.visitor},"thirdParty":{"embedUrl":"https://www.reddit.com/"}},"contentCheckOk":true,"racyCheckOk":true,"playbackContext":{"contentPlaybackContext":{"html5Preference":"HTML5_PREF_WANTS","signatureTimestamp":sts,"encryptedHostFlags":config.flags}}});
    request["context"]["client"]
        .as_object_mut()
        .unwrap()
        .extend(config.client_extra.clone());
    request
}

#[derive(Clone)]
struct Ready {
    config: Arc<Config>,
    decoder: Arc<PreparedDecoder>,
    deadline: Option<Instant>,
}

struct CoordinatedPreparation {
    config: Arc<Config>,
    preparation: Preparation,
    renewal_used: bool,
}

struct FreshSource {
    config: Arc<Config>,
    source: String,
}

struct RefreshReservation {
    expected: Option<Arc<Config>>,
    newer: Option<Arc<Config>>,
}

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
enum EarlyPhase {
    Reserved,
    SameSource,
    Replaced,
    Unchanged,
    Ready,
}

fn early_diagnostic(id: &str, phase: EarlyPhase, initial_cancelled: Option<bool>) {
    if diagnostic_enabled() {
        eprintln!(
            "[native-early-sabr] {}",
            json!({"id":id,"phase":phase,
            "initialCancelled":initial_cancelled,"atMs":trace_time()})
        );
    }
}

// The initial preparation may own COMPILED. Never await CONFIGS here: the
// ordinary refresh takes these locks in the opposite order. Busy means no early
// work, not another reservation. Once reserved, even an unusable candidate has
// consumed this resolve's only refresh.
fn reserve_early_refresh(
    cache: &tokio::sync::Mutex<ConfigCache>,
    id: &str,
    previous: &Arc<Config>,
) -> Option<RefreshReservation> {
    let mut cache = cache.try_lock().ok()?;
    let expected = cache.entries.get(id).map(|(config, _)| config.clone());
    let newer = expected
        .as_ref()
        .filter(|config| !Arc::ptr_eq(config, previous))
        .cloned();
    if newer.is_none() {
        failure_cache(&mut cache.failed, id).ok()?;
    }
    Some(RefreshReservation { expected, newer })
}

fn same_config_binding(current: Option<&Arc<Config>>, expected: Option<&Arc<Config>>) -> bool {
    match (current, expected) {
        (Some(current), Some(expected)) => Arc::ptr_eq(current, expected),
        (None, None) => true,
        _ => false,
    }
}

async fn install_early_config(
    cache: &tokio::sync::Mutex<ConfigCache>,
    id: &str,
    reservation: &RefreshReservation,
    next: &Arc<Config>,
    deadline: Instant,
) -> Result<(), Error> {
    let mut cache = cache.lock().await;
    if Instant::now() >= deadline {
        return Err(fail("DECODER_PREPARE"));
    }
    if !same_config_binding(
        cache.entries.get(id).map(|(value, _)| value),
        reservation.expected.as_ref(),
    ) {
        return Err(fail("REFRESH_BINDING"));
    }
    if let Some(newer) = &reservation.newer {
        if !Arc::ptr_eq(newer, next) {
            return Err(fail("REFRESH_BINDING"));
        }
        return Ok(());
    }
    if !cache.entries.contains_key(id) && cache.entries.len() >= 16 {
        if let Some(oldest) = cache
            .entries
            .iter()
            .min_by_key(|(_, (_, at))| *at)
            .map(|(id, _)| id.clone())
        {
            cache.entries.remove(&oldest);
        }
    }
    cache
        .entries
        .insert(id.into(), (next.clone(), Instant::now()));
    Ok(())
}

async fn clear_abandoned_preparation(
    cache: &tokio::sync::Mutex<DecoderCache>,
    player: &reqwest::Url,
    reservation: Instant,
) {
    let mut cache = cache.lock().await;
    // Only the deliberate replacement owns this cleanup. Ordinary cancellation,
    // timeout and failure retain their cooldown, as do newer reservations.
    if cache.failed.get(player.as_str()) == Some(&reservation) {
        cache.failed.remove(player.as_str());
    }
}

async fn finish_initial<I>(
    initial: Option<std::pin::Pin<Box<I>>>,
    completed: Option<Preparation>,
) -> Result<Preparation, Error>
where
    I: Future<Output = Result<Preparation, Error>>,
{
    match completed {
        Some(completed) => Ok(completed),
        None => initial.ok_or_else(|| fail("REFRESH_BINDING"))?.await,
    }
}

async fn coordinate_preparation<I, F, FF, R, RF, P, PF>(
    configs: &tokio::sync::Mutex<ConfigCache>,
    compiled: &tokio::sync::Mutex<DecoderCache>,
    id: &str,
    first_config: Arc<Config>,
    renewal_used: bool,
    initial: I,
    notice: tokio::sync::oneshot::Receiver<EarlySabr>,
    fetch: F,
    replace: R,
    post: P,
) -> Result<CoordinatedPreparation, Error>
where
    I: Future<Output = Result<Preparation, Error>>,
    F: FnOnce(Option<Arc<Config>>) -> FF,
    FF: Future<Output = Result<Option<FreshSource>, Error>>,
    R: FnOnce(Arc<Config>, DownloadedSource) -> RF,
    RF: Future<Output = Result<Preparation, Error>>,
    P: FnOnce(Arc<Config>, u32) -> PF,
    PF: Future<Output = Preview>,
{
    let normal = |preparation| CoordinatedPreparation {
        config: first_config.clone(),
        preparation,
        renewal_used,
    };
    if renewal_used {
        return initial.await.map(normal);
    }
    // Box ownership matters: dropping a Pin<&mut Future> would not cancel its
    // underlying worker. Taking this box really drops CancelOnDrop and the lock.
    let mut initial = Some(Box::pin(initial));
    let signal = tokio::select! {
        biased;
        result = initial.as_mut().unwrap().as_mut() => return result.map(normal),
        signal = notice => match signal {
            Ok(signal) => signal,
            Err(_) => return initial.take().unwrap().await.map(normal),
        },
    };
    let continued = async {
        let Some(reservation) = reserve_early_refresh(configs, id, &first_config) else {
            return initial.take().unwrap().await.map(normal);
        };
        early_diagnostic(id, EarlyPhase::Reserved, None);
        let mut fetching = Box::pin(fetch(reservation.newer.clone()));
        let mut completed = None;
        let fresh = tokio::select! {
            biased;
            result = initial.as_mut().unwrap().as_mut() => {
                completed = Some(result?);
                drop(initial.take());
                fetching.await
            },
            fresh = fetching.as_mut() => fresh,
        };
        // A failed/unchanged refresh cannot reserve another one. Keep the first full
        // analysis: if it disproves hint1, its corrected definitive request can still
        // spend POST2. If it confirms SABR, consumption simply returns that error.
        let fresh = match fresh {
            Ok(Some(fresh))
                if body(&first_config, id, 0) != body(&fresh.config, id, 0)
                    || first_config.player != fresh.config.player =>
            {
                fresh
            }
            _ => {
                early_diagnostic(id, EarlyPhase::Unchanged, None);
                return Ok(CoordinatedPreparation {
                    config: first_config.clone(),
                    preparation: finish_initial(initial.take(), completed).await?,
                    renewal_used: true,
                });
            }
        };
        if body(&first_config, id, 0) == body(&fresh.config, id, 0) {
            // A new player can change only ST. That cannot justify cancellation
            // or a hinted POST, but the existing sequential recovery must still
            // compare both fully analyzed timestamps within this one reservation.
            let first = finish_initial(initial.take(), completed).await?;
            let verified_sabr = first
                .response
                .as_ref()
                .is_some_and(|preview| is_sabr(&preview.response));
            let same_source =
                <[u8; 32]>::from(Sha256::digest(fresh.source.as_bytes())) == signal.sha;
            if !verified_sabr || same_source {
                // In particular, a disproved hint1 keeps its definitive POST2.
                return Ok(CoordinatedPreparation {
                    config: first_config.clone(),
                    preparation: first,
                    renewal_used: true,
                });
            }
            early_diagnostic(id, EarlyPhase::Replaced, Some(false));
            let next_config = fresh.config;
            let mut next = replace(
                next_config.clone(),
                DownloadedSource {
                    source: fresh.source,
                    deadline: signal.deadline,
                },
            )
            .await?;
            if body(&first_config, id, first.decoder.signature_timestamp)
                == body(&next_config, id, next.decoder.signature_timestamp)
            {
                return Ok(CoordinatedPreparation {
                    config: first_config.clone(),
                    preparation: first,
                    renewal_used: true,
                });
            }
            let preview = post(next_config.clone(), next.decoder.signature_timestamp).await;
            install_early_config(configs, id, &reservation, &next_config, signal.deadline).await?;
            next.response = Some(preview);
            next.post_started = true;
            early_diagnostic(id, EarlyPhase::Ready, None);
            return Ok(CoordinatedPreparation {
                config: next_config,
                preparation: next,
                renewal_used: true,
            });
        }
        let Some(hint) = timestamp_hint(&fresh.source) else {
            return Ok(CoordinatedPreparation {
                config: first_config.clone(),
                preparation: finish_initial(initial.take(), completed).await?,
                renewal_used: true,
            });
        };
        if Instant::now() >= signal.deadline {
            return Err(fail("DECODER_PREPARE"));
        }
        // Preserve an analysis that finished while the new bytes were being hashed.
        if let Some(pending) = initial.as_mut() {
            tokio::select! {
                biased;
                result = pending.as_mut() => { completed = Some(result?); },
                _ = std::future::ready(()) => {},
            }
        }
        if completed.is_some() {
            drop(initial.take());
        }
        let same_source = <[u8; 32]>::from(Sha256::digest(fresh.source.as_bytes())) == signal.sha;
        if same_source {
            early_diagnostic(id, EarlyPhase::SameSource, Some(false));
        } else {
            let cancelled = initial.is_some();
            if initial.is_some() {
                drop(initial.take());
                clear_abandoned_preparation(compiled, &first_config.player, signal.reservation)
                    .await;
            }
            early_diagnostic(id, EarlyPhase::Replaced, Some(cancelled));
        }
        let next_config = fresh.config;
        let selected = next_config.clone();
        let analysis = async {
            if same_source {
                if let Some(completed) = completed {
                    Ok(completed)
                } else {
                    initial.take().unwrap().await
                }
            } else {
                replace(
                    selected,
                    DownloadedSource {
                        source: fresh.source,
                        deadline: signal.deadline,
                    },
                )
                .await
            }
        };
        let (preparation, preview) = tokio::time::timeout_at(signal.deadline.into(), async {
            tokio::join!(analysis, post(next_config.clone(), hint))
        })
        .await
        .map_err(|_| fail("DECODER_PREPARE"))?;
        let mut preparation = preparation?;
        if preparation.decoder.signature_timestamp != hint {
            // POST2 has been spent. Never repair a speculative timestamp with POST3.
            return Err(fail("REFRESH_TIMESTAMP"));
        }
        install_early_config(configs, id, &reservation, &next_config, signal.deadline).await?;
        preparation.response = Some(preview);
        preparation.post_started = true;
        early_diagnostic(id, EarlyPhase::Ready, None);
        Ok(CoordinatedPreparation {
            config: next_config,
            preparation,
            renewal_used: true,
        })
    };
    let result = tokio::time::timeout_at(signal.deadline.into(), continued)
        .await
        .map_err(|_| fail("DECODER_PREPARE"))?;
    if Instant::now() >= signal.deadline {
        return Err(fail("DECODER_PREPARE"));
    }
    result
}
async fn refresh_ready<F, Fut>(
    cache: &tokio::sync::Mutex<ConfigCache>,
    id: &str,
    previous: &Ready,
    fetch: F,
) -> Result<Option<Ready>, Error>
where
    F: FnOnce(Option<Arc<Config>>) -> Fut,
    Fut: Future<Output = Result<Ready, Error>>,
{
    let work = refresh_ready_inner(cache, id, previous, fetch);
    if let Some(deadline) = previous.deadline {
        let result = tokio::time::timeout_at(deadline.into(), work)
            .await
            .map_err(|_| fail("DECODER_PREPARE"))?;
        if Instant::now() >= deadline {
            return Err(fail("DECODER_PREPARE"));
        }
        result
    } else {
        work.await
    }
}
async fn refresh_ready_inner<F, Fut>(
    cache: &tokio::sync::Mutex<ConfigCache>,
    id: &str,
    previous: &Ready,
    fetch: F,
) -> Result<Option<Ready>, Error>
where
    F: FnOnce(Option<Arc<Config>>) -> Fut,
    Fut: Future<Output = Result<Ready, Error>>,
{
    if previous.deadline.is_some_and(|deadline| Instant::now() >= deadline) {
        return Err(fail("DECODER_PREPARE"));
    }
    let mut cache = cache.lock().await;
    if previous.deadline.is_some_and(|deadline| Instant::now() >= deadline) {
        return Err(fail("DECODER_PREPARE"));
    }
    let newer = cache
        .entries
        .get(id)
        .map(|(config, _)| config)
        .filter(|config| !Arc::ptr_eq(config, &previous.config))
        .cloned();
    if newer.is_none() {
        failure_cache(&mut cache.failed, id)?;
    }
    let next = fetch(newer.clone()).await?;
    if previous.deadline.is_some_and(|deadline| Instant::now() >= deadline) {
        return Err(fail("DECODER_PREPARE"));
    }
    if previous.deadline.is_some() && next.deadline != previous.deadline {
        return Err(fail("REFRESH_BINDING"));
    }
    if newer
        .as_ref()
        .is_some_and(|current| !Arc::ptr_eq(current, &next.config))
    {
        return Err(fail("REFRESH_BINDING"));
    }
    // Every variable request header (version/visitor) is also in this body.
    // A changed player URL alone cannot justify repeating an identical POST.
    refresh_diagnostic(id, PostCode::Ok, Some((previous, &next)), Some(newer.is_some()));
    if body(&previous.config, id, previous.decoder.signature_timestamp)
        == body(&next.config, id, next.decoder.signature_timestamp)
    {
        return Ok(None);
    }
    if newer.is_none() {
        if !cache.entries.contains_key(id) && cache.entries.len() >= 16 {
            if let Some(oldest) = cache
                .entries
                .iter()
                .min_by_key(|(_, (_, at))| *at)
                .map(|(id, _)| id.clone())
            {
                cache.entries.remove(&oldest);
            }
        }
        cache
            .entries
            .insert(id.into(), (next.config.clone(), Instant::now()));
    }
    Ok(Some(next))
}

async fn resolve_ready<T, A, AF, F, FF>(
    cache: &tokio::sync::Mutex<ConfigCache>,
    id: &str,
    first: Ready,
    mut attempt: A,
    fetch: F,
) -> Result<T, Error>
where
    A: FnMut(Ready) -> AF,
    AF: Future<Output = Result<T, Error>>,
    F: FnOnce(Option<Arc<Config>>) -> FF,
    FF: Future<Output = Result<Ready, Error>>,
{
    let result = attempt(first.clone()).await;
    if !matches!(&result,Err(Error::Failed(code)) if code=="NATIVE_EMBEDDED_SABR_ONLY") {
        if result.as_ref().is_err_and(|error| config_rejected(error)) {
            invalidate_config(&mut *cache.lock().await, id, &first.config);
        }
        return result;
    }
    #[cfg(test)]
    if TRACE_FIXTURES.load(Ordering::Relaxed) {
        eprintln!("embedded-refresh id={id} phase=sabr-only");
    }
    let refreshed = refresh_ready(cache, id, &first, fetch).await;
    if let Err(error) = &refreshed {
        refresh_diagnostic(id, post_code(Some(error)), None, None);
    }
    let Some(next) = refreshed? else {
        #[cfg(test)]
        if TRACE_FIXTURES.load(Ordering::Relaxed) {
            eprintln!("embedded-refresh id={id} phase=unchanged-request");
        }
        return result;
    };
    #[cfg(test)]
    if TRACE_FIXTURES.load(Ordering::Relaxed) {
        eprintln!("embedded-refresh id={id} phase=changed-request");
    }
    let result = attempt(next.clone()).await;
    if result.as_ref().is_err_and(|error| config_rejected(error)) {
        invalidate_config(&mut *cache.lock().await, id, &next.config);
    }
    result
}

#[cfg(test)]
async fn player_response(
    http: &reqwest::Client,
    endpoint: &str,
    config: &Config,
    id: &str,
    sts: u32,
) -> Result<Value, Error> {
    player_response_traced(
        http,
        endpoint,
        config,
        id,
        sts,
        post_trace(PostOrigin::Direct),
    )
    .await
}

async fn player_response_traced(
    http: &reqwest::Client,
    endpoint: &str,
    config: &Config,
    id: &str,
    sts: u32,
    trace: Option<PostTrace>,
) -> Result<Value, Error> {
    let started = Instant::now();
    post_diagnostic(
        trace,
        id,
        config,
        sts,
        PostPhase::Started,
        None,
        None,
        None,
        None,
    );
    let mut http_status = None;
    let mut summary = None;
    let result = async {
        let response = http
            .post(endpoint)
            .header("Content-Type", "application/json")
            .header("User-Agent", UA)
            .header("Origin", "https://www.youtube.com")
            .header("X-Youtube-Client-Name", "56")
            .header("X-Youtube-Client-Version", &config.version)
            .header("X-Goog-Visitor-Id", &config.visitor)
            .body(body(config, id, sts).to_string())
            .send()
            .await
            .map_err(|_| fail("TRANSPORT"))?;
        http_status = Some(response.status().as_u16());
        match response.status().as_u16() {
            400 => return Err(fail("PLAYER_HTTP_400")),
            401 => return Err(fail("PLAYER_HTTP_401")),
            403 => return Err(fail("PLAYER_HTTP_403")),
            _ => {}
        }
        let value: Value = serde_json::from_str(&text_response(response).await?)
            .map_err(|_| fail("PLAYER_JSON"))?;
        if trace.is_some() {
            summary = Some(player_summary(&value, id));
        }
        stage_timing(id, "player-response", started);
        #[cfg(test)]
        save_private_fixture(
            Some(id),
            "player-response.json.local",
            value.to_string().as_bytes(),
        );
        if value
            .pointer("/playabilityStatus/status")
            .and_then(Value::as_str)
            != Some("OK")
            || value
                .pointer("/videoDetails/videoId")
                .and_then(Value::as_str)
                != Some(id)
            || !value
                .pointer("/streamingData/adaptiveFormats")
                .is_some_and(Value::is_array)
        {
            return Err(fail("PLAYER_IDENTITY_OR_STATUS"));
        }
        let candidates = audio_candidates(
            value["streamingData"]["adaptiveFormats"]
                .as_array()
                .unwrap(),
        );
        if !candidates.is_empty()
            && candidates.iter().all(|format| {
                ["url", "signatureCipher"]
                    .iter()
                    .all(|key| format.get(*key).is_none_or(Value::is_null))
            })
            && value
                .pointer("/streamingData/serverAbrStreamingUrl")
                .and_then(Value::as_str)
                .is_some_and(direct_audio_url)
        {
            return Err(fail("SABR_ONLY"));
        }
        Ok(value)
    }
    .await;
    post_diagnostic(
        trace,
        id,
        config,
        sts,
        PostPhase::Finished,
        None,
        http_status,
        Some(post_code(result.as_ref().err())),
        summary,
    );
    result
}

struct Cipher {
    url: reqwest::Url,
    sig: Option<String>,
    n: Option<String>,
    parameter: String,
}

fn cipher(format: &Value) -> Result<Cipher, Error> {
    if format.get("url").is_some() && format.get("signatureCipher").is_some() {
        return Err(fail("CIPHER_AMBIGUOUS"));
    }
    let mut sig = None;
    let mut parameter = "sig".to_owned();
    let raw = if let Some(url) = format["url"].as_str() {
        url.to_owned()
    } else {
        let text = bounded_string(&format["signatureCipher"], 32 * 1024)
            .map_err(|_| fail("CIPHER_MISSING"))?;
        let fields: Vec<_> = reqwest::Url::parse(&format!("https://www.youtube.com/?{text}"))
            .map_err(|_| fail("CIPHER"))?
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        if fields
            .iter()
            .any(|(key, _)| !matches!(key.as_str(), "url" | "s" | "sp"))
            || ["url", "s", "sp"]
                .iter()
                .any(|key| fields.iter().filter(|(k, _)| k == key).count() > 1)
        {
            return Err(fail("CIPHER"));
        }
        sig = fields
            .iter()
            .find(|(k, _)| k == "s")
            .map(|(_, value)| value.clone());
        if sig.as_ref().is_none_or(|s| s.is_empty() || s.len() > 16384) {
            return Err(fail("CIPHER"));
        }
        if let Some((_, value)) = fields.iter().find(|(k, _)| k == "sp") {
            parameter = value.clone();
        }
        fields
            .iter()
            .find(|(k, _)| k == "url")
            .map(|(_, v)| v.clone())
            .ok_or_else(|| fail("CIPHER"))?
    };
    if !matches!(parameter.as_str(), "sig" | "signature")
        || raw.len() > 32 * 1024
        || !direct_audio_url(&raw)
    {
        return Err(fail("CIPHER_URL"));
    }
    let url = reqwest::Url::parse(&raw).map_err(|_| fail("CIPHER_URL"))?;
    if url.fragment().is_some() {
        return Err(fail("CIPHER_URL"));
    }
    let values: Vec<_> = url
        .query_pairs()
        .filter(|(key, _)| key == "n")
        .map(|(_, value)| value.into_owned())
        .collect();
    if values.len() > 1 || values.iter().any(|v| v.is_empty() || v.len() > 16384) {
        return Err(fail("CIPHER"));
    }
    if sig.is_some() && url.query_pairs().any(|(key, _)| key == parameter) {
        return Err(fail("CIPHER"));
    }
    Ok(Cipher {
        url,
        sig,
        n: values.into_iter().next(),
        parameter,
    })
}

fn apply_decoded(
    input: Cipher,
    signature: Option<String>,
    n: Option<String>,
) -> Result<String, Error> {
    let valid = |value: &str| {
        !value.is_empty()
            && value.len() <= 16384
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-.".contains(&b))
            && !value.starts_with("enhanced_except_")
    };
    let valid_signature = |value: &str| {
        let unpadded = value.trim_end_matches('=');
        value.len() - unpadded.len() <= 2 && valid(unpadded)
    };
    if signature.is_some() != input.sig.is_some()
        || n.is_some() != input.n.is_some()
        || signature.iter().any(|v| !valid_signature(v))
        || n.iter().any(|v| !valid(v))
    {
        return Err(fail("DECODED_VALUE"));
    }
    let mut url = input.url;
    let pairs: Vec<_> = url
        .query_pairs()
        .filter(|(key, _)| key != "n")
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    url.query_pairs_mut().clear().extend_pairs(pairs);
    if let Some(n) = n {
        url.query_pairs_mut().append_pair("n", &n);
    }
    if let Some(signature) = signature {
        url.query_pairs_mut()
            .append_pair(&input.parameter, &signature);
    }
    Ok(url.into())
}

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "lowercase")]
enum CdnIoFinal { Complete, Error, Cancelled }

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CdnIoRecord {
    id: String,
    attempt: u32,
    at_ms: f64,
    elapsed_ms: f64,
    headers_ms: Option<f64>,
    // Headers to termination, including validation and body reading; not pure I/O.
    body_ms: Option<f64>,
    status: Option<u16>,
    version: Option<&'static str>,
    bytes: u64,
    #[serde(rename = "final")]
    outcome: CdnIoFinal,
}

struct CdnIoTrace {
    record: CdnIoRecord,
    started: Instant,
    headers_at: Option<Instant>,
    #[cfg(test)]
    sink: Option<Arc<std::sync::Mutex<Vec<CdnIoRecord>>>>,
    #[cfg(test)]
    headers_observed: Option<tokio::sync::oneshot::Sender<()>>,
}

impl CdnIoTrace {
    fn new(enabled: bool, id: &str, attempt: u32, at_ms: f64) -> Option<Self> {
        if !enabled || !valid_id(id) || !at_ms.is_finite() || at_ms < 0.0 {
            return None;
        }
        Some(Self {
            record: CdnIoRecord {
                id: id.into(), attempt, at_ms, elapsed_ms: 0.0,
                headers_ms: None, body_ms: None, status: None, version: None,
                bytes: 0, outcome: CdnIoFinal::Cancelled,
            },
            started: Instant::now(), headers_at: None,
            #[cfg(test)]
            sink: None,
            #[cfg(test)]
            headers_observed: None,
        })
    }

    fn headers(&mut self, response: &reqwest::Response) {
        let now = Instant::now();
        self.headers_at = Some(now);
        self.record.headers_ms = Some(now.duration_since(self.started).as_secs_f64() * 1000.0);
        self.record.status = Some(response.status().as_u16());
        self.record.version = Some(match response.version() {
            reqwest::Version::HTTP_09 => "http0.9",
            reqwest::Version::HTTP_10 => "http1.0",
            reqwest::Version::HTTP_11 => "http1.1",
            reqwest::Version::HTTP_2 => "http2",
            reqwest::Version::HTTP_3 => "http3",
            _ => "other",
        });
        #[cfg(test)]
        if let Some(sender) = self.headers_observed.take() { let _ = sender.send(()); }
    }
}

impl Drop for CdnIoTrace {
    fn drop(&mut self) {
        let now = Instant::now();
        self.record.elapsed_ms = now.duration_since(self.started).as_secs_f64() * 1000.0;
        self.record.body_ms = self.headers_at.map(|at| now.duration_since(at).as_secs_f64() * 1000.0);
        #[cfg(test)]
        if let Some(sink) = &self.sink {
            // Test-only sink avoids process-global BENCH changes and captures cancellation.
            if let Ok(mut records) = sink.lock() {
                records.push(self.record.clone());
            }
            return;
        }
        if let Ok(value) = serde_json::to_string(&self.record) {
            use std::io::Write;
            let _ = writeln!(std::io::stderr().lock(), "[native-cdn-io] {value}");
        }
    }
}

#[cfg(test)]
async fn strict_probe(http: &reqwest::Client, url: &str, length: u64) -> Result<(), Error> {
    strict_probe_request(http.get(url), length, None).await
}

async fn strict_probe_request(
    request: reqwest::RequestBuilder,
    length: u64,
    mut trace: Option<CdnIoTrace>,
) -> Result<(), Error> {
    let result = async {
    if length < 1024 {
        return Err(fail("LENGTH"));
    }
    let at = length / 10 * 8 + (length % 10) * 8 / 10;
    let end = (at + 1023).min(length.saturating_sub(1));
    let expected = end - at + 1;
    let mut response = request
        .header("Range", format!("bytes={at}-{end}"))
        .header("Accept-Encoding", "identity")
        .send()
        .await
        .map_err(|_| fail("CDN_TRANSPORT"))?;
    if let Some(trace) = &mut trace { trace.headers(&response); }
    if response.status().as_u16() != 206 {
        return Err(fail(&format!("CDN_HTTP_{}", response.status().as_u16())));
    }
    if response
        .headers()
        .get(reqwest::header::CONTENT_ENCODING)
        .is_some_and(|v| v.as_bytes() != b"identity")
    {
        return Err(fail("CDN_ENCODING"));
    }
    if response
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        != Some(format!("bytes {at}-{end}/{length}").as_str())
        || response.content_length().is_some_and(|n| n != expected)
    {
        return Err(fail("CDN_RANGE"));
    }
    if response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_ascii_lowercase)
        .is_some_and(|v| v.starts_with("text/") || v.contains("html") || v.contains("json"))
    {
        return Err(fail("CDN_MIME"));
    }
    let mut received = 0;
    while let Some(chunk) = response.chunk().await.map_err(|_| fail("CDN_TRANSPORT"))? {
        received += chunk.len() as u64;
        if let Some(trace) = &mut trace { trace.record.bytes = received; }
        if received > expected {
            return Err(fail("CDN_RANGE"));
        }
    }
    if received != expected {
        return Err(fail("CDN_TRUNCATED"));
    }
    Ok(())
    }.await;
    if let Some(trace) = &mut trace {
        trace.record.outcome = if result.is_ok() { CdnIoFinal::Complete } else { CdnIoFinal::Error };
    }
    result
}

fn transient_cdn(error: &Error) -> bool {
    let Error::Failed(code) = error else {
        return false;
    };
    if matches!(
        code.as_str(),
        "NATIVE_EMBEDDED_CDN_TRANSPORT" | "NATIVE_EMBEDDED_CDN_TIMEOUT"
    ) {
        return true;
    }
    code.strip_prefix("NATIVE_EMBEDDED_CDN_HTTP_")
        .filter(|v| v.len() == 3 && v.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|v| v.parse::<u16>().ok())
        .is_some_and(|status| matches!(status, 403 | 429 | 500..=599))
}

fn invalid_decoder(error: &str) -> bool {
    matches!(
        error,
        "YOUTUBE_DECODER_EXECUTION" | "YOUTUBE_DECODER_OUTPUT" | "YOUTUBE_DECODER_UNSUPPORTED"
    )
}

fn config_rejected(error: &Error) -> bool {
    matches!(error, Error::Failed(code) if matches!(code.as_str(),
        "NATIVE_EMBEDDED_PLAYER_HTTP_400" | "NATIVE_EMBEDDED_PLAYER_HTTP_401" | "NATIVE_EMBEDDED_PLAYER_HTTP_403"))
}

#[derive(Clone, Copy)]
struct CdnProbeSlot {
    at: Duration,
    // An opportunistic probe must release the next original slot, including its body.
    until: Option<Duration>,
}

impl CdnProbeSlot {
    const fn regular(at: Duration) -> Self {
        Self { at, until: None }
    }
}

// Preserve every original opportunity. The additional probe only owns the idle
// interval before 2 s, never another two-second request window.
const CDN_RETRY_SLOTS: [CdnProbeSlot; 9] = [
    CdnProbeSlot::regular(Duration::ZERO),
    CdnProbeSlot::regular(Duration::from_millis(250)),
    CdnProbeSlot::regular(Duration::from_secs(1)),
    CdnProbeSlot { at: Duration::from_millis(1500), until: Some(Duration::from_secs(2)) },
    CdnProbeSlot::regular(Duration::from_secs(2)),
    CdnProbeSlot::regular(Duration::from_secs(3)),
    CdnProbeSlot::regular(Duration::from_secs(4)),
    CdnProbeSlot::regular(Duration::from_secs(5)),
    CdnProbeSlot::regular(Duration::from_secs(6)),
];

struct CdnProbeBudget {
    started: Instant,
    duration: Duration,
    dispatched: u8,
}

impl CdnProbeBudget {
    fn new(duration: Duration) -> Self {
        Self { started: Instant::now(), duration, dispatched: 0 }
    }

    fn remaining(&self) -> Option<Duration> {
        self.duration.checked_sub(self.started.elapsed()).filter(|v| !v.is_zero())
    }

    fn dispatch(&mut self) -> bool {
        if self.dispatched >= 10 || self.remaining().is_none() {
            return false;
        }
        self.dispatched += 1;
        true
    }
}

async fn bounded_cdn_probe<F, Fut>(
    mut probe: F,
    slots: &[CdnProbeSlot],
    budget: &mut CdnProbeBudget,
) -> Result<(), Error>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<(), Error>>,
{
    let remaining = budget.remaining().ok_or_else(|| fail("CDN_TIMEOUT"))?;
    let attempts = async {
        let started = Instant::now();
        let mut last = fail("CDN_TIMEOUT");
        for slot in slots.iter().take(9) {
            // A slow request can cross several slots. Do not replay expired
            // positive slots as a burst; allow normal scheduler jitter.
            if !slot.at.is_zero() && started.elapsed() > slot.at + Duration::from_millis(50) {
                continue;
            }
            if let Some(wait) = slot.at.checked_sub(started.elapsed()) {
                tokio::time::sleep(wait).await;
            }
            let request_deadline = if let Some(until) = slot.until {
                if started.elapsed() >= until {
                    continue;
                }
                tokio::time::Instant::from_std(started + until)
                    .min(tokio::time::Instant::now() + Duration::from_secs(2))
            } else {
                tokio::time::Instant::now() + Duration::from_secs(2)
            };
            // Count dispatches, including subsequently aborted probes, across formats.
            // A slot already expired above never consumes a token.
            if !budget.dispatch() {
                return Err(fail("CDN_TIMEOUT"));
            }
            last = match tokio::time::timeout_at(request_deadline, probe()).await {
                Ok(Ok(())) => return Ok(()),
                Ok(Err(error)) => error,
                // Drop the optional request before polling the next original slot.
                Err(_) if slot.until.is_some() => continue,
                Err(_) => fail("CDN_TIMEOUT"),
            };
            if !transient_cdn(&last) {
                return Err(last);
            }
            // No additional polling after rate limiting. A caller can retry
            // later; do not guess or shorten the server's Retry-After delay.
            if matches!(&last, Error::Failed(code) if code == "NATIVE_EMBEDDED_CDN_HTTP_429") {
                return Err(last);
            }
        }
        Err(last)
    };
    tokio::time::timeout(remaining, attempts)
        .await
        .unwrap_or_else(|_| Err(fail("CDN_TIMEOUT")))
}

fn candidate_audio(format: &Value, require_explicit: bool) -> bool {
    format["mimeType"].as_str().is_some_and(|mime| {
        BUNDLED
            .audio
            .iter()
            .any(|allowed| mime.starts_with(allowed))
    }) && (if require_explicit {
        original_audio_explicit(format)
    } else {
        original_audio(format)
    }) && format
        .get("drmFamilies")
        .is_none_or(|v| v.as_array().is_some_and(Vec::is_empty))
        && format.get("licenseInfos").is_none()
        && format.get("drmTrackType").is_none()
}

fn audio_candidates(formats: &[Value]) -> Vec<Value> {
    // Keep compatibility with codec/bitrate variants in wholly untagged responses.
    // Once any audio format exposes track metadata, default alone cannot establish
    // originality, including for other formats whose metadata is missing.
    let require_explicit = formats.iter().any(|format| {
        format["mimeType"]
            .as_str()
            .is_some_and(|mime| mime.starts_with("audio/"))
            && ["audioTrack", "xtags", "language", "languageCode"]
                .iter()
                .any(|key| format.get(*key).is_some_and(|value| !value.is_null()))
    });
    let mut candidates: Vec<_> = formats
        .iter()
        .filter(|format| candidate_audio(format, require_explicit))
        .cloned()
        .collect();
    candidates.sort_by_key(|format| {
        (
            BUNDLED
                .audio
                .iter()
                .position(|mime| format["mimeType"].as_str().unwrap_or("").starts_with(mime)),
            std::cmp::Reverse(format["bitrate"].as_u64().unwrap_or(0)),
        )
    });
    candidates
}

/// Only reached after the direct fast clients failed. The caller supplies the total deadline.
pub(super) async fn resolve(video_id: &str) -> Result<Direct, Error> {
    resolve_prefetched(video_id, None).await
}

pub(super) async fn resolve_prefetched(video_id: &str, prefetched: Option<RawPrefetch>) -> Result<Direct, Error> {
    if !diagnostic_enabled() {
        return resolve_inner(video_id, prefetched).await;
    }
    let trace = NEXT_RESOLVE_TRACE.fetch_add(1, Ordering::Relaxed);
    RESOLVE_TRACE.scope(trace, resolve_inner(video_id, prefetched)).await
}

async fn resolve_inner(video_id: &str, prefetched: Option<RawPrefetch>) -> Result<Direct, Error> {
    if !valid_id(video_id) {
        return Err(fail("ID"));
    }
    let http = WEB.as_ref().map_err(|_| fail("HTTP"))?;
    let (watch, embed) = match prefetched {
        Some(raw) => { let (watch, embed) = raw.adopt(video_id)?; (Some(watch), Some(embed)) },
        None => (None, None),
    };
    let discovery_started = Instant::now();
    let (admit, admission) = tokio::sync::oneshot::channel();
    let (_, coordinated) = tokio::try_join!(
        async {
            let watch = match watch {
                Some(raw) => raw.read().await?,
                None => get(
                http,
                reqwest::Url::parse(&format!("https://www.youtube.com/watch?v={video_id}&hl=en"))
                    .unwrap(),
            )
            .await?,
            };
            let started = Instant::now();
            let result = watch_player(&watch, video_id).map(|_| ());
            stage_timing(video_id, "watch-identity", started);
            result?;
            // Public metadata and local analysis may overlap this check, but
            // neither its response nor an error can leave quarantine without
            // this proof and the analyzer's independent timestamp match.
            let _ = admit.send(());
            Ok::<_, Error>(())
        },
        async {
            let discovered = configuration(http, video_id, embed).await?;
            let config = discovered.config;
            let (early, notice) = tokio::sync::oneshot::channel();
            let previous = config.clone();
            coordinate_preparation(
                &CONFIGS,
                &COMPILED,
                video_id,
                config.clone(),
                discovered.renewed,
                prepare_request(
                    http,
                    &config,
                    Some(video_id),
                    Some(admission),
                    // Discovery already spent the one renewal. Dropping this
                    // sender prevents early SABR from reserving another GET.
                    (!discovered.renewed).then_some(early),
                    None,
                    None,
                ),
                notice,
                |current| async move {
                    let next = if let Some(current) = current {
                        current
                    } else {
                        let html = get(
                            http,
                            reqwest::Url::parse(&format!(
                                "https://www.youtube.com/embed/{video_id}?html5=1"
                            ))
                            .unwrap(),
                        )
                        .await?;
                        #[cfg(test)]
                        save_private_fixture(
                            Some(video_id),
                            "embed-refresh.html.local",
                            html.as_bytes(),
                        );
                        Arc::new(self::config(&html)?)
                    };
                    // A new player may change ST alone: download it, but only
                    // full sequential analysis can justify that second POST.
                    if body(&previous, video_id, 0) == body(&next, video_id, 0)
                        && previous.player == next.player {
                        return Ok(None);
                    }
                    let source = get(http, next.player.clone()).await?;
                    #[cfg(test)]
                    save_private_fixture(
                        None,
                        &format!(
                            "player-{:x}.js.local",
                            Sha256::digest(next.player.as_str().as_bytes())
                        ),
                        source.as_bytes(),
                    );
                    Ok(Some(FreshSource {
                        config: next,
                        source,
                    }))
                },
                |next, source| async move {
                    prepare_request(http, &next, Some(video_id), None, None, Some(source), None)
                        .await
                },
                |next, hint| async move {
                    let trace = post_trace(PostOrigin::Preview);
                    let response =
                        player_response_traced(http, PLAYER, &next, video_id, hint, trace).await;
                    Preview { response, trace }
                },
            )
            .await
        }
    )?;
    stage_timing(video_id, "watch-config-and-prepare", discovery_started);
    let CoordinatedPreparation {
        config: initial_config,
        preparation,
        renewal_used,
    } = coordinated;
    let Preparation {
        decoder,
        mut response,
        post_started,
        deadline,
    } = preparation;
    // A discarded first hint has already spent POST1; the definitive request
    // would be POST2. An early replacement also already owns POST2. Neither can
    // enter the ordinary SABR recovery and accidentally issue a third request.
    if renewal_used || (post_started && response.is_none()) {
        let result = resolve_config(http, &initial_config, video_id, decoder, response).await;
        if result.as_ref().is_err_and(|error| config_rejected(error)) {
            invalidate_config(&mut *CONFIGS.lock().await, video_id, &initial_config);
        }
        return result;
    }
    resolve_ready(
        &CONFIGS,
        video_id,
        Ready {
            config: initial_config,
            decoder,
            deadline,
        },
        |ready| {
            let response = response.take();
            async move { resolve_config(http, &ready.config, video_id, ready.decoder, response).await }
        },
        |current| async move {
            let config = if let Some(current) = current {
                current
            } else {
                let html = get(
                    http,
                    reqwest::Url::parse(&format!(
                        "https://www.youtube.com/embed/{video_id}?html5=1"
                    ))
                    .unwrap(),
                )
                .await?;
                #[cfg(test)]
                save_private_fixture(Some(video_id), "embed-refresh.html.local", html.as_bytes());
                Arc::new(config(&html)?)
            };
            let decoder = prepared(http, &config, deadline).await?;
            Ok(Ready { config, decoder, deadline })
        },
    )
    .await
}
async fn resolve_config(
    http: &reqwest::Client,
    config: &Config,
    video_id: &str,
    decoder: Arc<PreparedDecoder>,
    response: Option<Preview>,
) -> Result<Direct, Error> {
    let Preview { response, trace } = match response {
        Some(response) => response,
        None => {
            let trace = post_trace(PostOrigin::Direct);
            Preview {
                trace,
                response: player_response_traced(
                    http,
                    PLAYER,
                    config,
                    video_id,
                    decoder.signature_timestamp,
                    trace,
                )
                .await,
            }
        }
    };
    post_diagnostic(
        trace,
        video_id,
        config,
        decoder.signature_timestamp,
        PostPhase::Consumed,
        Some(decoder.signature_timestamp),
        None,
        Some(post_code(response.as_ref().err())),
        None,
    );
    let mut response = response?;
    #[cfg(test)]
    {
        save_private_fixture(
            Some(video_id),
            "player-response.json.local",
            response.to_string().as_bytes(),
        );
        save_private_fixture(
            Some(video_id),
            "player-request.json.local",
            body(config, video_id, decoder.signature_timestamp)
                .to_string()
                .as_bytes(),
        );
        save_private_fixture(
            Some(video_id),
            "prepared.js.local",
            decoder.script.as_bytes(),
        );
        save_private_fixture(Some(video_id), "metadata.json.local", json!({"id":video_id,"playerJsUrl":config.player.as_str(),"clientVersion":config.version,"signatureTimestamp":decoder.signature_timestamp}).to_string().as_bytes());
        if let (Some(from), Some(to)) = (
            fixture_file(
                None,
                &format!(
                    "player-{:x}.js.local",
                    Sha256::digest(config.player.as_str().as_bytes())
                ),
            ),
            fixture_file(Some(video_id), "player.js.local"),
        ) {
            let _ = std::fs::copy(from, to);
        }
    }
    let formats = audio_candidates(
        response["streamingData"]["adaptiveFormats"]
            .as_array()
            .unwrap(),
    );
    let client = Client {
        name: "WEB_EMBEDDED_PLAYER".into(),
        id: 56,
        version: config.version.clone(),
        user_agent: UA.into(),
        context: Map::new(),
    };
    let mut last = fail("NO_AUDIO");
    let mut retry_available = true;
    let mut cdn_budget: Option<CdnProbeBudget> = None;
    for mut format in formats.into_iter().take(3) {
        let input = match cipher(&format) {
            Ok(v) => v,
            Err(error) => {
                last = error;
                continue;
            }
        };
        let decode_started = Instant::now();
        let decode = youtube_decoder::decode(decoder.clone(), input.sig.clone(), input.n.clone());
        // Trying another format after a permanent CDN error still shares the
        // first candidate's overall validation deadline, including its decoder.
        let decoded_result = if let Some(budget) = &cdn_budget {
            let Some(remaining) = budget.remaining().filter(|_| budget.dispatched < 10) else {
                return Err(fail("CDN_TIMEOUT"));
            };
            match tokio::time::timeout(remaining, decode).await {
                Ok(result) => result,
                Err(_) => return Err(fail("CDN_TIMEOUT")),
            }
        } else {
            decode.await
        };
        stage_timing(video_id, "decode", decode_started);
        let decoded = match decoded_result {
            Ok(v) => v,
            Err(error) => {
                if invalid_decoder(&error) {
                    invalidate_decoder(&config.player, &decoder).await;
                }
                last = fail("DECODER_RUN");
                continue;
            }
        };
        #[cfg(test)]
        save_private_fixture(
            Some(video_id),
            &format!(
                "decoded-{}.json.local",
                format["itag"].as_u64().unwrap_or(0)
            ),
            json!({"sig":decoded.sig,"n":decoded.n})
                .to_string()
                .as_bytes(),
        );
        let url = match apply_decoded(input, decoded.sig, decoded.n) {
            Ok(v) => v,
            Err(error) => {
                invalidate_decoder(&config.player, &decoder).await;
                last = error;
                continue;
            }
        };
        // A missing length would turn the existing 80% probe into a prefix-only probe.
        let Some(length) = query_param(&url, "clen")
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|n| (1024..=128 * 1024 * 1024).contains(n))
        else {
            last = fail("LENGTH");
            continue;
        };
        format["url"] = json!(url);
        response["streamingData"]["adaptiveFormats"] = json!([format]);
        let direct = pick_identified(&BUNDLED, &client, &response, video_id, None, None)
            .map_err(|_| fail("SELECTION"))?;
        #[cfg(test)]
        save_private_fixture(
            Some(video_id),
            &format!("url-{}.json.local", direct.itag),
            json!({"url":direct.url,"itag":direct.itag})
                .to_string()
                .as_bytes(),
        );
        #[cfg(test)]
        save_private_fixture(
            Some(video_id),
            "probe-current.json.local",
            json!({"url":direct.url,"itag":direct.itag})
                .to_string()
                .as_bytes(),
        );
        // Only the first original candidate gets retries, always with the same URL.
        // Some otherwise valid responses have a temporary CDN availability gate.
        // Neither its presence nor a successful retry proves an ad was played/skipped.
        let retry = std::mem::replace(&mut retry_available, false);
        if retry {
            let queued = crate::extractor::preconnect_cdn(&direct.url);
            if std::env::var_os("MUSIFY_BENCH").is_some() {
                eprintln!("[native-cdn-preconnect] {}", json!({"id":video_id,"atMs":trace_time(),"queued":queued}));
            }
        }
        let slots: &[CdnProbeSlot] = if retry {
            &CDN_RETRY_SLOTS
        } else {
            &[CdnProbeSlot::regular(Duration::ZERO)]
        };
        let http = CDN.as_ref().map_err(|_| fail("HTTP"))?;
        let budget = cdn_budget.get_or_insert_with(|| CdnProbeBudget::new(Duration::from_secs(8)));
        let probe_epoch = budget.started;
        let mut attempt = 0_u32;
        let result = bounded_cdn_probe(
            || {
                attempt += 1;
                let attempt = attempt;
                let url = &direct.url;
                async move {
                    let probe_started = Instant::now();
                    let at_ms = if std::env::var_os("MUSIFY_BENCH").is_some() {
                        trace_time()
                    } else {
                        0.0
                    };
                    let trace = CdnIoTrace::new(
                        std::env::var_os("MUSIFY_BENCH").is_some(), video_id, attempt, at_ms,
                    );
                    let result = strict_probe_request(http.get(url), length, trace).await;
                    if std::env::var_os("MUSIFY_BENCH").is_some() {
                        eprintln!("[native-cdn-attempt] {}", json!({"id":video_id,"atMs":at_ms,
                            "attempt":attempt,"startedMs":probe_started.duration_since(probe_epoch).as_secs_f64()*1000.0,
                            "ms":probe_started.elapsed().as_secs_f64()*1000.0,
                            "code":result.as_ref().err().map(|e|validation_code(&e.to_string())).unwrap_or_else(||"ok".into())}));
                    }
                    result
                }
            },
            slots,
            budget,
        )
        .await;
        match result {
            Ok(()) => return Ok(direct),
            Err(error) => {
                probe_diagnostic(
                    video_id,
                    direct.itag,
                    "strict-80percent",
                    &error.to_string(),
                );
                // Exhausted transient retries do not multiply the budget by formats.
                if transient_cdn(&error) {
                    return Err(error);
                }
                last = error;
            }
        }
    }
    Err(last)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    const ID: &str = "DJzjkMBMook";
    const AUDIO: &str =
        "https://r1.googlevideo.com/videoplayback?clen=8192&n=input_n&expire=4102444800";

    fn config_value() -> Value {
        json!({"INNERTUBE_CLIENT_NAME":"WEB_EMBEDDED_PLAYER","INNERTUBE_CONTEXT_CLIENT_NAME":56,
            "INNERTUBE_CLIENT_VERSION":"2.20261022.01.00","VISITOR_DATA":"public-visitor",
            "INNERTUBE_CONTEXT":{"user":{"account":"must-not-propagate"}},
            "WEB_PLAYER_CONTEXT_CONFIGS":{"WEB_PLAYER_CONTEXT_CONFIG_ID_EMBEDDED_PLAYER":{
                "jsUrl":"/s/player/cbcfbf2f/player_es6.vflset/en_US/base.js","encryptedHostFlags":"public-flags"}}})
    }

    fn watch_value() -> Value {
        json!({"videoDetails":{"videoId":ID,"title":"Kids fixture"},
            "playabilityStatus":{"status":"OK","playableInEmbed":true,"miniplayer":{"miniplayerRenderer":{
                "minimizedEndpoint":{"openPopupAction":{"popup":{"notificationActionRenderer":{"responseText":{"simpleText":NOTICE}}}}}}}},
            "microformat":{"playerMicroformatRenderer":{"isFamilySafe":true}}})
    }

    fn cfg() -> Config {
        config(&format!("ytcfg.set({});", config_value())).unwrap()
    }

    #[test]
    fn raw_prefetch_claim_is_foreground_valid_and_process_once_under_contention() {
        let claimed = AtomicBool::new(false);
        assert!(!claim_prefetch(ID, false, &claimed));
        assert!(!claim_prefetch("not/a/video", true, &claimed));
        assert!(!claimed.load(Ordering::Relaxed));
        let winners = AtomicU64::new(0);
        std::thread::scope(|scope| {
            for i in 0..16 {
                let claimed = &claimed;
                let winners = &winners;
                scope.spawn(move || {
                    if claim_prefetch(if i % 2 == 0 { ID } else { "WtTRMAoN2Fw" }, true, claimed) {
                        winners.fetch_add(1, Ordering::Relaxed);
                    }
                });
            }
        });
        assert_eq!(winners.load(Ordering::Relaxed), 1);
        assert!(!claim_prefetch(ID, true, &claimed));
    }

    #[tokio::test]
    async fn raw_prefetch_drop_or_wrong_id_before_first_poll_starts_no_get() {
        assert_eq!(PREFETCH_DELAY, Duration::ZERO);
        let calls = Arc::new(AtomicU64::new(0));
        let fetch = || {
            let calls = calls.clone();
            async move { calls.fetch_add(1, Ordering::Relaxed); Ok("unused raw text".into()) }
        };
        // Even with zero delay, this current-thread test drops ownership before
        // either task is polled.
        // In production, another worker may already have dispatched its GET.
        drop(RawPrefetch::spawn(ID, fetch(), fetch()));
        let wrong = RawPrefetch::spawn(ID, fetch(), fetch());
        assert!(matches!(wrong.adopt("WtTRMAoN2Fw"), Err(Error::Failed(code))
            if code == "NATIVE_EMBEDDED_PREFETCH_BINDING"));
        for _ in 0..4 { tokio::task::yield_now().await; }
        assert_eq!(calls.load(Ordering::Relaxed), 0);
    }

    struct RawDrop(Arc<AtomicU64>);
    impl Drop for RawDrop {
        fn drop(&mut self) { self.0.fetch_add(1, Ordering::Relaxed); }
    }

    #[tokio::test]
    async fn raw_prefetch_adoption_is_immediate_and_does_not_wait_for_both_documents() {
        let (begun, started) = tokio::sync::oneshot::channel();
        let dropped = Arc::new(AtomicU64::new(0));
        let watch_drop = dropped.clone();
        // Far-future timers make this assertion independent of machine speed.
        let at = tokio::time::Instant::now() + Duration::from_secs(60);
        let raw = RawPrefetch { id: ID.into(),
            watch: RawGet::spawn(at, async move {
                let _guard = RawDrop(watch_drop);
                let _ = begun.send(());
                std::future::pending().await
            }),
            embed: RawGet::spawn(at, async { Ok("independent embed".into()) }),
        };
        let (watch, embed) = raw.adopt(ID).unwrap();
        assert_eq!(tokio::time::timeout(Duration::from_secs(1), embed.read()).await.unwrap().unwrap(), "independent embed");
        started.await.unwrap();
        assert_eq!(dropped.load(Ordering::Relaxed), 0, "watch is still in flight");
        drop(watch);
        tokio::task::yield_now().await;
        assert_eq!(dropped.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn raw_prefetch_cancelling_owner_aborts_both_active_reads() {
        let dropped = Arc::new(AtomicU64::new(0));
        let begun = Arc::new(AtomicU64::new(0));
        let fetch = || {
            let dropped = dropped.clone();
            let begun = begun.clone();
            async move {
                let _guard = RawDrop(dropped);
                begun.fetch_add(1, Ordering::Relaxed);
                std::future::pending::<Result<String, Error>>().await
            }
        };
        let (watch, embed) = RawPrefetch::spawn(ID, fetch(), fetch()).adopt(ID).unwrap();
        let owner = tokio::spawn(async move { tokio::try_join!(watch.read(), embed.read()) });
        tokio::time::timeout(Duration::from_secs(1), async {
            while begun.load(Ordering::Relaxed) != 2 { tokio::task::yield_now().await; }
        }).await.unwrap();
        owner.abort();
        assert!(owner.await.unwrap_err().is_cancelled());
        tokio::task::yield_now().await;
        assert_eq!(dropped.load(Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn raw_prefetch_loopback_handoff_uses_get_once_and_preserves_only_parser_retry() {
        let mut invalid = config_value();
        invalid["VISITOR_DATA"] = json!("");
        let (url, server) = local_sequence(vec![
            response(200, "", format!("ytcfg.set({invalid});").as_bytes()),
            response(200, "", format!("ytcfg.set({});", config_value()).as_bytes()),
        ]);
        let http = local_http();
        let first_http = http.clone();
        let first_url = url.clone();
        let mut raw = RawGet::spawn(tokio::time::Instant::now(), async move {
            text_response(first_http.get(first_url).send().await.unwrap()).await
        });
        raw.admit();
        let cache = tokio::sync::Mutex::new(ConfigCache::default());
        let fresh = AtomicU64::new(0);
        let result = configuration_prefetched(&cache, ID, Instant::now() + DISCOVERY_TIMEOUT,
            Some(raw), |attempt| {
                assert_eq!(attempt, 2, "the prefetched response is the whole first attempt");
                fresh.fetch_add(1, Ordering::Relaxed);
                async { text_response(http.get(&url).send().await.unwrap()).await }
            }).await.unwrap();
        assert!(result.renewed, "parser retry consumes the existing SABR renewal");
        assert_eq!(fresh.load(Ordering::Relaxed), 1);
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests.iter().all(|r| r.starts_with("GET / HTTP/1.1")));
        assert!(requests.iter().all(|r| !r.to_ascii_lowercase().contains("cookie:")));
        assert!(cache.lock().await.failed.is_empty());
    }

    #[tokio::test]
    async fn raw_prefetch_errors_keep_transport_caps_and_do_not_refetch() {
        for (raw_http, expected) in [
            (response(403, "", b"private diagnostic must not escape"), "HTTP_STATUS"),
            (response(429, "", b"not configuration"), "HTTP_STATUS"),
            (response(200, "", &[0xff]), "UTF8"),
            (format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", LIMIT + 1).into_bytes(), "SIZE"),
        ] {
            let (url, server) = local(raw_http);
            let raw = RawGet::spawn(tokio::time::Instant::now(), async move {
                text_response(local_http().get(url).send().await.unwrap()).await
            });
            let cache = tokio::sync::Mutex::new(ConfigCache::default());
            let result = configuration_prefetched(&cache, ID, Instant::now() + DISCOVERY_TIMEOUT,
                Some(raw), |_| async { panic!("transport/body errors cannot start another GET") }).await;
            assert!(matches!(result, Err(Error::Failed(code)) if code == format!("NATIVE_EMBEDDED_{expected}")));
            server.join().unwrap();
            assert!(cache.lock().await.entries.is_empty());
        }
    }

    #[tokio::test]
    async fn raw_prefetch_cached_configuration_drops_unused_body_without_fetch() {
        let cache = cache_with(Arc::new(cfg()));
        let calls = Arc::new(AtomicU64::new(0));
        let copy = calls.clone();
        let raw = RawGet::spawn(tokio::time::Instant::now() + Duration::from_secs(60), async move {
            copy.fetch_add(1, Ordering::Relaxed);
            Ok("not parsed".into())
        });
        let result = configuration_prefetched(&cache, ID, Instant::now() + DISCOVERY_TIMEOUT,
            Some(raw), |_| async { panic!("cached config must not fetch") }).await.unwrap();
        assert!(!result.renewed);
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn raw_prefetch_dispatch_timeout_is_not_restarted_at_adoption() {
        let raw = RawGet::spawn(tokio::time::Instant::now(), std::future::pending());
        // Await completion of the original deadline without consuming its result.
        tokio::time::timeout(DISCOVERY_TIMEOUT + Duration::from_secs(1), async {
            while !raw.task.is_finished() { tokio::time::sleep(Duration::from_millis(10)).await; }
        }).await.unwrap();
        let cache = tokio::sync::Mutex::new(ConfigCache::default());
        let result = configuration_prefetched(&cache, ID, Instant::now() + DISCOVERY_TIMEOUT,
            Some(raw), |_| async { panic!("expired prefetch must not restart transport") }).await;
        assert!(matches!(result, Err(Error::Failed(code)) if code == "NATIVE_EMBEDDED_DISCOVERY_TIMEOUT"));
        assert!(cache.lock().await.entries.is_empty());
    }

    fn cipher_value(url: &str) -> Value {
        let mut wrapped = reqwest::Url::parse("https://www.youtube.com/").unwrap();
        wrapped
            .query_pairs_mut()
            .append_pair("url", url)
            .append_pair("s", "input_sig")
            .append_pair("sp", "sig");
        json!({"signatureCipher":wrapped.query().unwrap()})
    }

    #[test]
    fn player_diagnostic_counts_use_original_candidates_and_never_serialize_remote_fields() {
        let mut value = watch_value();
        let direct = AUDIO.replace("&n=input_n", "");
        let audio = |extra: Value| {
            let mut format =
                json!({"itag":251,"mimeType":"audio/webm; codecs=\"opus\"","bitrate":128000});
            format
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            format
        };
        let signed = cipher_value(&format!("{direct}&n=PRIVATE_N"));
        value["streamingData"] = json!({
            "adaptiveFormats":[
                audio(json!({"url":direct})),
                audio(json!({"url":format!("{direct}&n=PRIVATE_N")})),
                audio(signed),
                audio(json!({})),
                audio(json!({"url":"https://private.invalid/PRIVATE_URL"})),
                audio(json!({"audioTrack":{"displayName":"Dubbed","audioIsDefault":true},"url":AUDIO})),
                {"mimeType":"video/mp4","url":"PRIVATE_VIDEO"}
            ],
            "serverAbrStreamingUrl":"https://r1.googlevideo.com/videoplayback?private=PRIVATE_SABR"
        });
        // Tagged track metadata makes unproven variants ineligible, just as selection does.
        assert_eq!(player_summary(&value, ID).eligible, 0);
        value["streamingData"]["adaptiveFormats"]
            .as_array_mut()
            .unwrap()
            .remove(5);
        let summary = player_summary(&value, ID);
        assert_eq!((summary.audio, summary.eligible), (5, 5));
        assert_eq!(
            (
                summary.urls,
                summary.ciphers,
                summary.missing,
                summary.invalid
            ),
            (3, 1, 1, 2)
        );
        assert_eq!(
            (
                summary.requires_signature,
                summary.requires_n,
                summary.direct_without_transform
            ),
            (1, 2, 1)
        );
        assert!(summary.identity_matches && summary.status_ok && summary.sabr_present);
        let serialized = serde_json::to_string(&summary).unwrap();
        assert!(
            !serialized.contains("PRIVATE")
                && !serialized.contains("http")
                && !serialized.contains("googlevideo")
        );
        value["videoDetails"]["videoId"] = json!("OTHER_PRIVATE_ID");
        value["playabilityStatus"]["status"] = json!("REMOTE_STATUS_PRIVATE");
        let summary = player_summary(&value, ID);
        assert!(!summary.identity_matches && !summary.status_ok);
        assert!(!serde_json::to_string(&summary).unwrap().contains("PRIVATE"));
    }

    #[test]
    fn diagnostic_request_changes_report_booleans_without_values() {
        let first = ready(Arc::new(cfg()), 20700);
        let mut changed = (*first.config).clone();
        changed.player = player_url("/s/player/12345678/player_es6.vflset/en_US/base.js").unwrap();
        let next = ready(Arc::new(changed.clone()), 20700);
        let diff = request_changes(&first, &next, ID);
        assert!(diff.player && !diff.effective_request);
        changed.visitor = "PRIVATE_VISITOR".into();
        changed.flags = "PRIVATE_FLAGS".into();
        changed
            .client_extra
            .insert("rolloutToken".into(), json!("PRIVATE_ROLLOUT"));
        let next = ready(Arc::new(changed), 20701);
        let diff = request_changes(&first, &next, ID);
        assert!(
            diff.visitor
                && diff.flags
                && diff.client_context
                && diff.signature_timestamp
                && diff.effective_request
        );
        let json = serde_json::to_value(diff).unwrap();
        assert!(json.as_object().unwrap().values().all(Value::is_boolean));
        assert!(!json.to_string().contains("PRIVATE"));
    }

    #[test]
    fn diagnostic_dto_uses_closed_codes_and_preserves_preview_correlation() {
        assert_eq!(post_code(Some(&fail("SABR_ONLY"))), PostCode::SabrOnly);
        assert_eq!(post_code(Some(&fail("PLAYER_HTTP_403"))), PostCode::Http403);
        assert_eq!(
            post_code(Some(&fail("REMOTE https://private.invalid/?token=PRIVATE"))),
            PostCode::Other
        );
        let trace = PostTrace {
            resolve_id: 7,
            request_id: 11,
            origin: PostOrigin::Preview,
        };
        let mut config = cfg();
        config.version = "https://private.invalid/PRIVATE".into();
        for phase in [
            PostPhase::Started,
            PostPhase::Finished,
            PostPhase::PreviewKept,
            PostPhase::Consumed,
        ] {
            let dto = PostDiagnostic {
                trace,
                id: None,
                phase,
                at_ms: 1.0,
                client_version: public_version(&config),
                signature_timestamp: 20700,
                verified_timestamp: Some(20700),
                http_status: Some(200),
                code: Some(PostCode::SabrOnly),
                summary: None,
            };
            let value = serde_json::to_value(dto).unwrap();
            assert_eq!(value["resolveId"], 7);
            assert_eq!(value["requestId"], 11);
            assert_eq!(value["origin"], "preview");
            assert_eq!(value["code"], "sabr-only");
            assert!(value["clientVersion"].is_null());
            assert!(!value.to_string().contains("PRIVATE"));
        }
        assert!(public_version(&cfg()).is_some());
    }

    #[tokio::test]
    async fn compressed_public_text_is_bounded_after_decompression() {
        for (compressed, expected) in [
            (
                include_bytes!("../../tests/fixtures/youtube-discovery-small.txt.gz").as_slice(),
                true,
            ),
            (
                include_bytes!("../../tests/fixtures/youtube-discovery-over-limit.txt.gz")
                    .as_slice(),
                false,
            ),
        ] {
            let (url, server) = local(response(200, "Content-Encoding: gzip\r\n", compressed));
            let http = WEB.as_ref().unwrap();
            let result = text_response(http.get(url).send().await.unwrap()).await;
            if expected {
                assert_eq!(result.unwrap(), "public discovery text");
            } else {
                assert!(
                    matches!(result, Err(Error::Failed(code)) if code == "NATIVE_EMBEDDED_SIZE")
                );
            }
            let request = server.join().unwrap();
            assert!(
                request
                    .to_ascii_lowercase()
                    .contains("accept-encoding: gzip")
            );
        }
    }

    #[test]
    fn speculative_timestamp_requires_one_bounded_literal() {
        assert_eq!(
            timestamp_hint("x={signatureTimestamp:20746,other:1}"),
            Some(20746)
        );
        assert_eq!(timestamp_hint("signatureTimestamp : 20746 }"), Some(20746));
        for source in [
            "xsignatureTimestamp:20746}",
            "_signatureTimestamp:20746}",
            "signatureTimestamp:0}",
            "signatureTimestamp:4294967296}",
            "signatureTimestamp:20746+1}",
            "signatureTimestamp:foo}",
            "signatureTimestamp:20746,signatureTimestamp:20746}",
        ] {
            assert_eq!(timestamp_hint(source), None, "{source}");
        }
    }

    #[tokio::test]
    async fn metadata_post_runs_early_but_cannot_leave_quarantine_before_watch() {
        let mut value = watch_value();
        value["streamingData"] = json!({"adaptiveFormats":[]});
        let (url, server) = local(response(200, "", value.to_string().as_bytes()));
        let http = local_http();
        let config = cfg();
        let (admit, admission) = tokio::sync::oneshot::channel();
        let (received, response_received) = tokio::sync::oneshot::channel();
        let waiting = admitted_request(Some(admission), async {
            let result = player_response(&http, &url, &config, ID, 20746).await;
            received.send(()).unwrap();
            result
        });
        tokio::pin!(waiting);
        tokio::time::timeout(Duration::from_secs(1), async {
            tokio::select! {
                result = &mut waiting => panic!("response escaped before watch: {}", result.is_ok()),
                received = response_received => received.unwrap(),
            }
        }).await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut waiting)
                .await
                .is_err()
        );
        let request = server.join().unwrap();
        assert!(request.starts_with("POST "));
        let posted: Value =
            serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(posted["videoId"], ID);
        eligible(&value, ID).unwrap();
        admit.send(()).unwrap();
        assert_eq!(waiting.await.unwrap(), value);
    }

    #[tokio::test]
    async fn watch_rejection_discards_early_success_and_sabr_without_retry_or_consumption() {
        for response in [
            Ok(json!({"url":"must-not-be-consumed"})),
            Err(fail("SABR_ONLY")),
        ] {
            let calls = AtomicU64::new(0);
            let consumed = AtomicU64::new(0);
            let (reject, admission) = tokio::sync::oneshot::channel();
            let waiting = async {
                let response = admitted_request(Some(admission), async {
                    calls.fetch_add(1, Ordering::Relaxed);
                    response
                })
                .await?;
                // Models the only route to selection/CDN/refresh after admission.
                consumed.fetch_add(1, Ordering::Relaxed);
                Ok::<_, Error>(response)
            };
            tokio::pin!(waiting);
            assert!(
                tokio::time::timeout(Duration::from_millis(10), &mut waiting)
                    .await
                    .is_err()
            );
            assert_eq!(calls.load(Ordering::Relaxed), 1);
            assert_eq!(consumed.load(Ordering::Relaxed), 0);
            drop(reject);
            assert!(
                matches!(waiting.await, Err(Error::Failed(code)) if code=="NATIVE_EMBEDDED_ADMISSION")
            );
            assert_eq!(calls.load(Ordering::Relaxed), 1);
            assert_eq!(consumed.load(Ordering::Relaxed), 0);
        }
        // Cache-hit/no-preview callers keep the existing ungated behavior.
        assert_eq!(
            admitted_request(None, async { Ok(json!({"unchanged":true})) })
                .await
                .unwrap(),
            json!({"unchanged":true})
        );
    }

    #[tokio::test]
    async fn rejecting_admission_cancels_a_pending_post_body() {
        struct Dropped(Arc<std::sync::atomic::AtomicBool>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Relaxed);
            }
        }
        let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (reject, admission) = tokio::sync::oneshot::channel();
        let (started, request_started) = tokio::sync::oneshot::channel();
        let waiting = admitted_request(Some(admission), async {
            let _drop = Dropped(dropped.clone());
            started.send(()).unwrap();
            std::future::pending::<Result<Value, Error>>().await
        });
        tokio::pin!(waiting);
        tokio::select! {
            _ = &mut waiting => panic!("pending body unexpectedly returned"),
            started = request_started => started.unwrap(),
        }
        drop(reject);
        let result = tokio::time::timeout(Duration::from_secs(1), waiting)
            .await
            .unwrap();
        assert!(matches!(result, Err(Error::Failed(code)) if code=="NATIVE_EMBEDDED_ADMISSION"));
        assert!(dropped.load(Ordering::Relaxed));
    }

    #[tokio::test]
    async fn rejected_watch_and_outer_cancellation_drop_pending_metadata_and_analysis() {
        struct Dropped(Arc<std::sync::atomic::AtomicBool>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Relaxed);
            }
        }
        let mut rejected = Vec::new();
        let mut not_kids = watch_value();
        *not_kids.pointer_mut(NOTICE_PATH).unwrap() = json!("another notice");
        rejected.push(not_kids);
        for (path, value) in [
            ("/videoDetails/videoId", json!("jNY_wLukVW0")),
            ("/playabilityStatus/status", json!("UNPLAYABLE")),
            ("/playabilityStatus/playableInEmbed", json!(false)),
        ] {
            let mut watch = watch_value();
            *watch.pointer_mut(path).unwrap() = value;
            rejected.push(watch);
        }
        for watch in rejected {
            let request_dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let analysis_dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let (admit, admission) = tokio::sync::oneshot::channel();
            let (request_started, request_started_rx) = tokio::sync::oneshot::channel();
            let (analysis_started, analysis_started_rx) = tokio::sync::oneshot::channel();
            let pipeline = async {
                let (_, preview) = tokio::try_join!(
                    async {
                        request_started_rx.await.unwrap();
                        analysis_started_rx.await.unwrap();
                        eligible(&watch, ID)?;
                        let _ = admit.send(());
                        Ok::<_, Error>(())
                    },
                    analyze_preview(
                        async {
                            let _drop = Dropped(analysis_dropped.clone());
                            analysis_started.send(()).unwrap();
                            std::future::pending::<Result<PreparedDecoder, String>>().await
                        },
                        admitted_request(Some(admission), async {
                            let _drop = Dropped(request_dropped.clone());
                            request_started.send(()).unwrap();
                            std::future::pending::<Result<Value, Error>>().await
                        }),
                        20746,
                    )
                )?;
                Ok::<_, Error>(preview)
            };
            assert!(tokio::time::timeout(Duration::from_secs(1), pipeline)
                .await
                .unwrap()
                .is_err());
            assert!(request_dropped.load(Ordering::Relaxed));
            assert!(analysis_dropped.load(Ordering::Relaxed));
        }
        let request_dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let analysis_dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (_admit, admission) = tokio::sync::oneshot::channel();
        let pipeline = analyze_preview(
            async {
                let _drop = Dropped(analysis_dropped.clone());
                std::future::pending::<Result<PreparedDecoder, String>>().await
            },
            admitted_request(Some(admission), async {
                let _drop = Dropped(request_dropped.clone());
                std::future::pending::<Result<Value, Error>>().await
            }),
            20746,
        );
        assert!(tokio::time::timeout(Duration::from_millis(10), pipeline)
            .await
            .is_err());
        assert!(request_dropped.load(Ordering::Relaxed));
        assert!(analysis_dropped.load(Ordering::Relaxed));
    }

    #[tokio::test]
    async fn preview_requires_both_watch_and_verified_timestamp_in_either_completion_order() {
        for analysis_first in [false, true] {
            for sts in [20746, 20747] {
                let (admit, admission) = tokio::sync::oneshot::channel();
                let (analyzed, analysis) = tokio::sync::oneshot::channel();
                let calls = AtomicU64::new(0);
                let waiting = analyze_preview(
                    async {
                        analysis.await.unwrap();
                        Ok(PreparedDecoder {
                            script: "verified".into(),
                            signature_timestamp: sts,
                        })
                    },
                    admitted_request(Some(admission), async {
                        calls.fetch_add(1, Ordering::Relaxed);
                        Err(fail("SABR_ONLY"))
                    }),
                    20746,
                );
                tokio::pin!(waiting);
                assert!(
                    tokio::time::timeout(Duration::from_millis(10), &mut waiting)
                        .await
                        .is_err()
                );
                let last = if analysis_first {
                    analyzed.send(()).unwrap();
                    admit
                } else {
                    admit.send(()).unwrap();
                    analyzed
                };
                assert!(
                    tokio::time::timeout(Duration::from_millis(10), &mut waiting)
                        .await
                        .is_err()
                );
                assert_eq!(calls.load(Ordering::Relaxed), 1);
                last.send(()).unwrap();
                let (_, preview) = waiting.await.unwrap();
                if sts == 20746 {
                    assert!(
                        matches!(preview, Some(Err(Error::Failed(code))) if code=="NATIVE_EMBEDDED_SABR_ONLY")
                    );
                } else {
                    assert!(
                        preview.is_none(),
                        "unverified SABR cannot trigger a refresh"
                    );
                }
                assert_eq!(calls.load(Ordering::Relaxed), 1);
            }
        }
    }

    #[tokio::test]
    async fn preview_runs_concurrently_but_waits_for_matching_analyzer() {
        let barrier = Arc::new(tokio::sync::Barrier::new(2));
        let analysis = barrier.clone();
        let request = barrier.clone();
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            analyze_preview(
                async move {
                    analysis.wait().await;
                    Ok(PreparedDecoder {
                        script: "verified".into(),
                        signature_timestamp: 20746,
                    })
                },
                async move {
                    request.wait().await;
                    Ok(json!({"verifiedRequest":true}))
                },
                20746,
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(result.0.script, "verified");
        assert_eq!(result.1.unwrap().unwrap(), json!({"verifiedRequest":true}));
    }

    #[tokio::test]
    async fn preview_drops_success_and_error_when_timestamp_is_not_verified() {
        for response in [Ok(json!({"wrongHint":true})), Err(fail("SABR_ONLY"))] {
            let result = analyze_preview(
                async {
                    Ok(PreparedDecoder {
                        script: "verified".into(),
                        signature_timestamp: 20747,
                    })
                },
                async { response },
                20746,
            )
            .await
            .unwrap();
            assert_eq!(result.0.signature_timestamp, 20747);
            assert!(result.1.is_none());
        }
        assert!(
            analyze_preview(
                async { Err("bad analysis".into()) },
                async { Ok(json!({"mustNotEscape":true})) },
                20746
            )
            .await
            .is_err()
        );
        let result = analyze_preview(
            async {
                Ok(PreparedDecoder {
                    script: "verified".into(),
                    signature_timestamp: 20746,
                })
            },
            async { Err(fail("SABR_ONLY")) },
            20746,
        )
        .await
        .unwrap();
        assert!(
            matches!(result.1.unwrap(), Err(Error::Failed(code)) if code == "NATIVE_EMBEDDED_SABR_ONLY")
        );
    }

    #[test]
    fn only_identified_explicit_child_notice_activates_route() {
        let value = watch_value();
        eligible(&value, ID).unwrap();
        assert!(eligible(&value, "jNY_wLukVW0").is_err());
        for (path, bad) in [
            ("/playabilityStatus/status", json!("AGE_CHECK_REQUIRED")),
            ("/playabilityStatus/playableInEmbed", json!(false)),
            (NOTICE_PATH, json!("Videos made for kids")),
            (
                "/microformat/playerMicroformatRenderer/isFamilySafe",
                json!(false),
            ),
        ] {
            let mut changed = value.clone();
            *changed.pointer_mut(path).unwrap() = bad;
            assert!(eligible(&changed, ID).is_err());
        }
        let mut non_kids = value.clone();
        non_kids["playabilityStatus"]
            .as_object_mut()
            .unwrap()
            .remove("miniplayer");
        non_kids["videoDetails"]["title"] = json!(NOTICE);
        assert!(
            eligible(&non_kids, ID).is_err(),
            "familySafe/title cannot establish MFK"
        );
        watch_player(&format!("var ytInitialPlayerResponse = {value};"), ID).unwrap();
        assert!(
            watch_player(
                &format!("ytInitialPlayerResponse={value};ytInitialPlayerResponse = {value};"),
                ID
            )
            .is_err()
        );
    }

    #[test]
    fn config_allowlist_and_current_identity_are_not_arbitrary_script() {
        let config = cfg();
        let request = body(&config, ID, 20700);
        assert_eq!(
            request.pointer("/context/client/clientName").unwrap(),
            "WEB_EMBEDDED_PLAYER"
        );
        assert_eq!(
            request.pointer("/context/thirdParty/embedUrl").unwrap(),
            "https://www.reddit.com/"
        );
        assert!(!request.to_string().contains("account"));
        assert!(!request.to_string().contains("must-not-propagate"));
        for (key, bad) in [
            ("INNERTUBE_CONTEXT_CLIENT_NAME", json!(1)),
            ("INNERTUBE_CLIENT_NAME", json!("WEB")),
            ("INNERTUBE_CLIENT_VERSION", json!("2.1\r\nCookie:bad")),
        ] {
            let mut value = config_value();
            value[key] = bad;
            assert!(super::config(&format!("ytcfg.set({value});")).is_err());
        }
        assert!(super::config("ytcfg.set(fetch('https://outside.invalid')); ").is_err());
        assert!(
            super::config(&format!(
                "ytcfg.set({});ytcfg.set({{\"INNERTUBE_CLIENT_VERSION\":\"2.9\"}});",
                config_value()
            ))
            .is_err()
        );
        let mut mixed = config_value();
        mixed["INNERTUBE_CONTEXT"]["client"] = json!({"clientName":"WEB","clientVersion":"2.9"});
        assert!(super::config(&format!("ytcfg.set({mixed});")).is_err());
    }

    #[test]
    fn published_version_tokens_preserve_rollout_suffixes_and_exact_identity() {
        // Public version observed on the anonymous embed; all other fixture
        // fields are synthetic, with no visitor/flags from the real document.
        let rollout = "2.20261022.01.00-canary_control_2.20261023.01.00";
        for version in [rollout.to_owned(), "release_1+fix-2.3".into(), "canary".into(), "v".repeat(64)] {
            let mut published = config_value();
            published["INNERTUBE_CLIENT_VERSION"] = json!(version);
            published["INNERTUBE_CONTEXT"]["client"] = json!({
                "clientName":"WEB_EMBEDDED_PLAYER", "clientVersion":version,
            });
            let parsed = config(&format!("ytcfg.set({published});")).unwrap();
            assert_eq!(parsed.version, version);
            assert_eq!(public_version(&parsed), Some(version.as_str()));
            assert_eq!(body(&parsed, ID, 20700)["context"]["client"]["clientVersion"], version);

            published["INNERTUBE_CONTEXT"]["client"]["clientVersion"] = json!("2.20261022.01.00");
            assert!(matches!(config(&format!("ytcfg.set({published});")), Err(Error::Failed(code))
                if code == "NATIVE_EMBEDDED_CONFIG_AMBIGUOUS"));
        }
        for version in ["", "2.1 bad", "2.1\tbad", "2.1\r\nCookie:bad", "2.1é", "2.1/next", "2.1?key", "2.1\"", &"v".repeat(65)] {
            let mut published = config_value();
            published["INNERTUBE_CLIENT_VERSION"] = json!(version);
            assert!(config(&format!("ytcfg.set({published});")).is_err());
            assert!(!client_version_token(version));
        }
        let mut changed = config_value();
        changed["INNERTUBE_CLIENT_VERSION"] = json!(rollout);
        assert!(matches!(config(&format!("ytcfg.set({});ytcfg.set({changed});", config_value())),
            Err(Error::Failed(code)) if code == "NATIVE_EMBEDDED_CONFIG_AMBIGUOUS"));
    }

    #[tokio::test]
    async fn rollout_config_is_admitted_on_first_get_and_post_preserves_its_exact_token() {
        let version = "2.20261022.01.00-canary_control_2.20261023.01.00";
        let mut published = config_value();
        published["INNERTUBE_CLIENT_VERSION"] = json!(version);
        published["INNERTUBE_CONTEXT"]["client"] = json!({
            "clientName":"WEB_EMBEDDED_PLAYER", "clientVersion":version,
        });
        let mut value = watch_value();
        value["streamingData"] = json!({"adaptiveFormats":[]});
        let (url, server) = local_sequence(vec![
            response(200, "", format!("ytcfg.set({published});").as_bytes()),
            response(200, "Content-Type: application/json\r\n", value.to_string().as_bytes()),
        ]);
        let cache = tokio::sync::Mutex::new(ConfigCache::default());
        let http = local_http();
        let discovered = configuration_bounded(
            &cache, ID, Instant::now() + DISCOVERY_TIMEOUT,
            |_| async { text_response(http.get(&url).send().await.unwrap()).await },
        ).await.unwrap();
        assert!(!discovered.renewed, "a valid rollout must not consume the SABR renewal");
        player_response(&http, &url, &discovered.config, ID, 20700).await.unwrap();
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 2, "one GET and one POST, not two configuration GETs");
        assert!(requests[0].starts_with("GET / HTTP/1.1"));
        assert!(requests[1].starts_with("POST / HTTP/1.1"));
        let (headers, text) = requests[1].split_once("\r\n\r\n").unwrap();
        let header = headers.lines().find_map(|line| line.split_once(':')
            .filter(|(key, _)| key.eq_ignore_ascii_case("x-youtube-client-version"))
            .map(|(_, value)| value.trim())).unwrap();
        assert_eq!(header, version);
        assert!(!headers.to_ascii_lowercase().contains("cookie:"));
        let request: Value = serde_json::from_str(text).unwrap();
        assert_eq!(request["context"]["client"]["clientVersion"], version);
        assert_eq!(request, body(&discovered.config, ID, 20700));
    }

    #[test]
    fn published_client_context_is_bounded_and_does_not_copy_account_or_tracking() {
        let mut value = config_value();
        value["INNERTUBE_CONTEXT"]["client"] = json!({
            "platform":"DESKTOP", "clientFormFactor":"UNKNOWN_FORM_FACTOR",
            "osName":"Macintosh", "osVersion":"10_15_7", "browserName":"Safari",
            "browserVersion":"15.5", "gl":"ES", "deviceExperimentId":"public-experiment",
            "rolloutToken":"public-rollout", "configInfo":{"appInstallData":"public-install","account":"private"},
            "originalUrl":"private", "remoteHost":"private", "clickTrackingParams":"private"
        });
        let parsed = config(&format!("ytcfg.set({value});")).unwrap();
        let request = body(&parsed, ID, 20700);
        assert_eq!(parsed.client_extra.len(), 10);
        assert_eq!(request["context"]["client"]["platform"], "DESKTOP");
        assert_eq!(
            request["context"]["client"]["configInfo"],
            json!({"appInstallData":"public-install"})
        );
        assert!(request["context"]["client"].get("clientScreen").is_none());
        assert!(!request.to_string().contains("private"));
        assert!(!request.to_string().contains("must-not-propagate"));
        for bad in [
            json!("x".repeat(129)),
            json!("line\nbreak"),
            json!({"unexpected":"map"}),
        ] {
            let mut invalid = value.clone();
            invalid["INNERTUBE_CONTEXT"]["client"]["platform"] = bad;
            assert!(config(&format!("ytcfg.set({invalid});")).is_err());
        }
    }

    #[test]
    fn config_failure_identifies_only_closed_fields_and_causes() {
        for (pointer, field, max) in [
            ("/INNERTUBE_CLIENT_VERSION", "VERSION", 64),
            ("/VISITOR_DATA", "VISITOR", 4096),
            ("/WEB_PLAYER_CONTEXT_CONFIGS/WEB_PLAYER_CONTEXT_CONFIG_ID_EMBEDDED_PLAYER/encryptedHostFlags", "HOST_FLAGS", 32768),
            ("/WEB_PLAYER_CONTEXT_CONFIGS/WEB_PLAYER_CONTEXT_CONFIG_ID_EMBEDDED_PLAYER/jsUrl", "PLAYER_URL", 2048),
        ] {
            for (bad, cause) in [
                (Value::Null, "TYPE"),
                (json!(""), "EMPTY"),
                (json!("secret".repeat(max / 6 + 1)), "SIZE"),
                (json!("secret\nvalue"), "CONTROL"),
            ] {
                let mut published = config_value();
                *published.pointer_mut(pointer).unwrap() = bad;
                let error = config(&format!("ytcfg.set({published});")).err().unwrap();
                assert_eq!(config_error_code(&error), format!("CONFIG_{field}_{cause}"));
                assert!(!format!("{error:?}").contains("secret"));
            }
            let mut published = config_value();
            let (parent, key) = pointer.rsplit_once('/').unwrap();
            published.pointer_mut(parent).unwrap().as_object_mut().unwrap().remove(key);
            let error = config(&format!("ytcfg.set({published});")).err().unwrap();
            assert_eq!(config_error_code(&error), format!("CONFIG_{field}_MISSING"));
        }
        for (key, field) in [
            ("platform", "PLATFORM"), ("clientFormFactor", "FORM_FACTOR"),
            ("osName", "OS_NAME"), ("osVersion", "OS_VERSION"),
            ("browserName", "BROWSER_NAME"), ("browserVersion", "BROWSER_VERSION"),
            ("gl", "REGION"), ("deviceExperimentId", "DEVICE_EXPERIMENT"),
            ("rolloutToken", "ROLLOUT"),
        ] {
            let mut published = config_value();
            published["INNERTUBE_CONTEXT"]["client"][key] = json!("private-é");
            let error = config(&format!("ytcfg.set({published});")).err().unwrap();
            assert_eq!(config_error_code(&error), format!("CONFIG_{field}_ASCII"));
        }
        assert_eq!(config_error_code(&fail("CONFIG_VISITOR_secret")), "OTHER");
        assert_eq!(config_error_code(&fail("URL_https://private.invalid")), "OTHER");
    }

    #[tokio::test]
    async fn config_discovery_local_http_replaces_the_entire_invalid_document_once() {
        let mut invalid = config_value();
        invalid["INNERTUBE_CONTEXT"]["client"]["osVersion"] = json!("");
        invalid["VISITOR_DATA"] = json!("must-not-survive");
        let mut fresh = config_value();
        fresh["INNERTUBE_CLIENT_VERSION"] = json!("2.20261023.01.00");
        let expected = config(&format!("ytcfg.set({fresh});")).unwrap();
        let (url, server) = local_sequence(vec![
            response(200, "", format!("ytcfg.set({invalid});").as_bytes()),
            response(200, "", format!("ytcfg.set({fresh});").as_bytes()),
        ]);
        let cache = tokio::sync::Mutex::new(ConfigCache::default());
        let http = local_http();
        let result = configuration_bounded(
            &cache, ID, Instant::now() + DISCOVERY_TIMEOUT,
            |_| async { text_response(http.get(&url).send().await.unwrap()).await },
        ).await.unwrap();
        assert!(result.renewed);
        assert!(*result.config == expected);
        assert!(cache.lock().await.failed.is_empty());
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0], requests[1], "same public GET, no cookie or partial config");
        let cached = configuration_bounded(
            &cache, ID, Instant::now() + DISCOVERY_TIMEOUT,
            |_| async { panic!("a valid config is already cached") },
        ).await.unwrap();
        assert!(!cached.renewed, "a later resolve still owns its own renewal");
        assert!(Arc::ptr_eq(&cached.config, &result.config));

        let compiled = tokio::sync::Mutex::new(DecoderCache::default());
        let (early, notice) = tokio::sync::oneshot::channel();
        let signal = early_signal(&source_fixture("initial"), Duration::from_secs(1));
        assert!(early.send(signal).is_ok());
        let mut initial = preparation_fixture(20700, signal.deadline);
        initial.post_started = true;
        initial.response = Some(Preview { response: Err(fail("SABR_ONLY")), trace: None });
        let coordinated = coordinate_preparation(
            &cache, &compiled, ID, result.config, result.renewed,
            async { Ok(initial) }, notice,
            |_| async { panic!("discovery already spent the one renewal") },
            |_, _| async { panic!("no replacement analysis") },
            |_, _| async { panic!("no additional POST") },
        ).await.unwrap();
        assert!(coordinated.renewal_used, "resolve_inner must skip ordinary SABR recovery too");
        let error = resolve_config(
            &http, &coordinated.config, ID, coordinated.preparation.decoder,
            coordinated.preparation.response,
        ).await.err().unwrap();
        assert!(matches!(error, Error::Failed(code) if code == "NATIVE_EMBEDDED_SABR_ONLY"));
    }

    #[tokio::test]
    async fn config_discovery_two_invalid_documents_preserve_cooldown_without_partial_cache() {
        let mut invalid = config_value();
        invalid["VISITOR_DATA"] = json!("");
        let response = response(200, "", format!("ytcfg.set({invalid});").as_bytes());
        let (url, server) = local_sequence(vec![response.clone(), response]);
        let cache = tokio::sync::Mutex::new(ConfigCache::default());
        let http = local_http();
        let error = configuration_bounded(
            &cache, ID, Instant::now() + DISCOVERY_TIMEOUT,
            |_| async { text_response(http.get(&url).send().await.unwrap()).await },
        ).await.err().unwrap();
        assert_eq!(config_error_code(&error), "CONFIG_VISITOR_EMPTY");
        assert_eq!(server.join().unwrap().len(), 2);
        let locked = cache.lock().await;
        assert!(locked.entries.is_empty());
        assert!(locked.failed.contains_key(ID));
        drop(locked);
        let error = configuration_bounded(
            &cache, ID, Instant::now() + DISCOVERY_TIMEOUT,
            |_| async { panic!("the failure cooldown must stop repeated GETs") },
        ).await.err().unwrap();
        assert!(matches!(error, Error::Failed(code) if code == "NATIVE_EMBEDDED_DISCOVERY_COOLDOWN"));
    }

    #[tokio::test]
    async fn config_discovery_does_not_retry_http_transport_or_size_failures() {
        for status in [403, 429, 500] {
            let (url, server) = local(response(status, "", b"not configuration"));
            let http = local_http();
            let cache = tokio::sync::Mutex::new(ConfigCache::default());
            let calls = AtomicU64::new(0);
            let error = configuration_bounded(
                &cache, ID, Instant::now() + DISCOVERY_TIMEOUT,
                |_| { calls.fetch_add(1, Ordering::SeqCst); async {
                    text_response(http.get(&url).send().await.unwrap()).await
                } },
            ).await.err().unwrap();
            assert!(matches!(error, Error::Failed(code) if code == "NATIVE_EMBEDDED_HTTP_STATUS"));
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            server.join().unwrap();
        }
        for code in ["TRANSPORT", "SIZE", "UTF8"] {
            let cache = tokio::sync::Mutex::new(ConfigCache::default());
            let calls = AtomicU64::new(0);
            assert!(configuration_bounded(
                &cache, ID, Instant::now() + DISCOVERY_TIMEOUT,
                |_| { calls.fetch_add(1, Ordering::SeqCst); async { Err(fail(code)) } },
            ).await.is_err());
            assert_eq!(calls.load(Ordering::SeqCst), 1);
        }
    }

    #[tokio::test]
    async fn config_discovery_budget_and_cancellation_keep_reservations_and_never_install_late() {
        assert_eq!(DISCOVERY_TIMEOUT, Duration::from_secs(4));
        let cache = Arc::new(tokio::sync::Mutex::new(ConfigCache::default()));
        let begun = Arc::new(tokio::sync::Notify::new());
        let pending = tokio::spawn({
            let cache = cache.clone();
            let begun = begun.clone();
            async move {
                configuration_bounded(&cache, ID, Instant::now() + DISCOVERY_TIMEOUT, |_| {
                    begun.notify_one();
                    std::future::pending::<Result<String, Error>>()
                }).await
            }
        });
        begun.notified().await;
        pending.abort();
        assert!(pending.await.err().unwrap().is_cancelled());
        assert!(cache.lock().await.failed.contains_key(ID));
        assert!(cache.lock().await.entries.is_empty());

        let cache = tokio::sync::Mutex::new(ConfigCache::default());
        let calls = AtomicU64::new(0);
        let error = configuration_bounded(
            &cache, ID, Instant::now() + Duration::from_millis(60),
            |attempt| { calls.fetch_add(1, Ordering::SeqCst); async move {
                if attempt == 1 { Ok("ytcfg.set({});".into()) }
                else { std::future::pending().await }
            } },
        ).await.err().unwrap();
        assert!(matches!(error, Error::Failed(code) if code == "NATIVE_EMBEDDED_DISCOVERY_TIMEOUT"));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert!(cache.lock().await.failed.contains_key(ID));
        assert!(cache.lock().await.entries.is_empty());

        let good = Arc::new(cfg());
        let cache = cache_with(good.clone());
        let held = cache.lock().await;
        assert!(configuration_bounded(
            &cache, ID, Instant::now() + Duration::from_millis(30),
            |_| async { panic!("a timed-out lock must not fetch") },
        ).await.is_err());
        drop(held);
        assert!(Arc::ptr_eq(&cache.lock().await.entries[ID].0, &good));
    }

    #[test]
    fn discovery_origins_and_player_paths_reject_external_credentials_and_queries() {
        player_url("/s/player/cbcfbf2f/player_es6.vflset/en_US/base.js").unwrap();
        for url in [
            "https://evil.invalid/s/player/cbcfbf2f/base.js",
            "https://www.youtube.com.evil.invalid/s/player/cbcfbf2f/base.js",
            "http://www.youtube.com/s/player/cbcfbf2f/base.js",
            "https://user@www.youtube.com/s/player/cbcfbf2f/base.js",
            "/s/player/cbcfbf2f/base.js?url=https://evil.invalid",
            "/s/player/cbcfbf2f/base.js#token",
            "/other/base.js",
            "/s/player/cbcfbf2f/%2e%2e/base.js",
        ] {
            assert!(player_url(url).is_err());
        }
        assert!(!valid_id("../watch?id="));
    }

    #[test]
    fn cipher_decoder_output_is_not_an_arbitrary_url_or_silent_missing_transform() {
        let result = apply_decoded(
            cipher(&cipher_value(AUDIO)).unwrap(),
            Some("good.signature".into()),
            Some("good_n".into()),
        )
        .unwrap();
        assert_eq!(
            query_param(&result, "sig").as_deref(),
            Some("good.signature")
        );
        assert_eq!(query_param(&result, "n").as_deref(), Some("good_n"));
        assert_eq!(query_param(&result, "clen").as_deref(), Some("8192"));
        let padded = apply_decoded(
            cipher(&cipher_value(AUDIO)).unwrap(),
            Some("base64_signature==".into()),
            Some("good_n".into()),
        )
        .unwrap();
        // query_param deliberately returns the raw query substring; URL query_pairs
        // decodes exactly once, as the receiving server does for signature padding.
        assert_eq!(
            reqwest::Url::parse(&padded)
                .unwrap()
                .query_pairs()
                .find(|(key, _)| key == "sig")
                .map(|(_, value)| value.into_owned())
                .as_deref(),
            Some("base64_signature==")
        );
        assert_eq!(query_param(&padded, "sig"), Some("base64_signature%3D%3D"));
        for output in [
            "",
            "enhanced_except_error",
            "https://outside.invalid",
            "a&n=bad",
            "a\nvalue",
            "=middle=value",
            "value===",
        ] {
            assert!(
                apply_decoded(
                    cipher(&cipher_value(AUDIO)).unwrap(),
                    Some(output.into()),
                    Some("good_n".into())
                )
                .is_err()
            );
        }
        assert!(
            apply_decoded(
                cipher(&cipher_value(AUDIO)).unwrap(),
                None,
                Some("good_n".into())
            )
            .is_err()
        );
        assert!(
            apply_decoded(
                cipher(&cipher_value(AUDIO)).unwrap(),
                Some("signature==".into()),
                Some("n==".into())
            )
            .is_err()
        );
        assert!(cipher(&cipher_value("https://www.youtube.com/watch?v=DJzjkMBMook")).is_err());
        assert!(cipher(&cipher_value(&format!("{AUDIO}&n=second"))).is_err());
        let mut ambiguous = cipher_value(AUDIO);
        ambiguous["url"] = json!(AUDIO);
        assert!(cipher(&ambiguous).is_err());
        let mut unsupported = cipher_value(AUDIO);
        unsupported["signatureCipher"] = json!(format!(
            "{}&sp=other",
            unsupported["signatureCipher"].as_str().unwrap()
        ));
        assert!(cipher(&unsupported).is_err());
        for format in [json!({"itag": 251}), json!({"signatureCipher": null})] {
            assert!(
                matches!(cipher(&format), Err(Error::Failed(code)) if code == "NATIVE_EMBEDDED_CIPHER_MISSING")
            );
        }
    }

    #[test]
    fn failed_discovery_is_deduplicated_and_memory_bounded() {
        let mut failed = HashMap::new();
        failure_cache(&mut failed, "one").unwrap();
        assert!(failure_cache(&mut failed, "one").is_err());
        failed.insert("one".into(), Instant::now() - Duration::from_secs(31));
        failure_cache(&mut failed, "one").unwrap();
        for index in 0..40 {
            failure_cache(&mut failed, &index.to_string()).unwrap();
        }
        assert!(failed.len() <= 16);
    }

    #[test]
    fn cdn_diagnostics_are_bounded_categories_and_never_remote_text() {
        assert_eq!(
            validation_code("YouTube cortaría el audio (403)"),
            "cdn-http-403"
        );
        assert_eq!(validation_code("NATIVE_CDN_TIMEOUT"), "cdn-timeout");
        assert_eq!(validation_code("NATIVE_CDN_RANGE"), "cdn-range");
        assert_eq!(validation_code("NATIVE_CDN_NOT_AUDIO"), "cdn-mime");
        assert_eq!(
            validation_code("NATIVE_EMBEDDED_CDN_HTTP_200"),
            "cdn-http-200"
        );
        assert_eq!(
            validation_code("NATIVE_EMBEDDED_CDN_TRUNCATED"),
            "cdn-truncated"
        );
        for untrusted in [
            "https://cdn.invalid/?sig=private",
            "YouTube cortaría el audio (403) https://cdn.invalid",
            "NATIVE_EMBEDDED_CDN_HTTP_403private",
            "server says: account private",
        ] {
            assert_eq!(validation_code(untrusted), "cdn-transport");
        }
    }

    #[test]
    fn retry_and_decoder_invalidation_are_explicit_local_categories() {
        for code in [
            "CDN_HTTP_403",
            "CDN_HTTP_429",
            "CDN_HTTP_500",
            "CDN_HTTP_599",
            "CDN_TRANSPORT",
            "CDN_TIMEOUT",
        ] {
            assert!(transient_cdn(&fail(code)));
        }
        for code in [
            "CDN_HTTP_200",
            "CDN_HTTP_401",
            "CDN_HTTP_404",
            "CDN_HTTP_600",
            "CDN_HTTP_403_private",
            "CDN_RANGE",
            "CDN_MIME",
            "CDN_ENCODING",
            "CDN_TRUNCATED",
            "CIPHER_MISSING",
        ] {
            assert!(!transient_cdn(&fail(code)));
        }
        for code in [
            "YOUTUBE_DECODER_EXECUTION",
            "YOUTUBE_DECODER_OUTPUT",
            "YOUTUBE_DECODER_UNSUPPORTED",
        ] {
            assert!(invalid_decoder(code));
        }
        for code in [
            "YOUTUBE_DECODER_TIMEOUT",
            "YOUTUBE_DECODER_CANCELLED",
            "YOUTUBE_DECODER_MEMORY",
            "YOUTUBE_DECODER_WORKER",
            "YOUTUBE_DECODER_INPUT",
        ] {
            assert!(!invalid_decoder(code));
        }
        for code in ["PLAYER_HTTP_400", "PLAYER_HTTP_401", "PLAYER_HTTP_403"] {
            assert!(config_rejected(&fail(code)));
        }
        for code in [
            "CDN_HTTP_403",
            "TRANSPORT",
            "PLAYER_JSON",
            "PLAYER_IDENTITY_OR_STATUS",
            "CIPHER_MISSING",
            "DECODER_RUN",
        ] {
            assert!(!config_rejected(&fail(code)));
        }
    }

    #[tokio::test]
    async fn retries_stop_on_permanent_errors_and_share_ten_dispatches_across_formats() {
        for code in [
            "CDN_RANGE",
            "CDN_MIME",
            "CDN_TRUNCATED",
            "CDN_ENCODING",
            "CDN_HTTP_200",
        ] {
            let calls = AtomicU64::new(0);
            let result = bounded_cdn_probe(
                || {
                    calls.fetch_add(1, Ordering::Relaxed);
                    async { Err(fail(code)) }
                },
                &[CdnProbeSlot::regular(Duration::ZERO); 5],
                &mut CdnProbeBudget::new(Duration::from_secs(1)),
            )
            .await;
            assert!(result.is_err());
            assert_eq!(calls.load(Ordering::Relaxed), 1);
        }
        let calls = AtomicU64::new(0);
        let mut budget = CdnProbeBudget::new(Duration::from_secs(1));
        assert!(
            bounded_cdn_probe(
                || {
                    calls.fetch_add(1, Ordering::Relaxed);
                    async { Err(fail("CDN_HTTP_403")) }
                },
                &[CdnProbeSlot::regular(Duration::ZERO); 12],
                &mut budget
            )
            .await
            .is_err()
        );
        assert_eq!(calls.load(Ordering::Relaxed), 9);
        for _ in 0..2 {
            assert!(bounded_cdn_probe(
                || {
                    calls.fetch_add(1, Ordering::Relaxed);
                    async { Err(fail("CDN_RANGE")) }
                },
                &[CdnProbeSlot::regular(Duration::ZERO)],
                &mut budget,
            ).await.is_err());
        }
        assert_eq!(calls.load(Ordering::Relaxed), 10);
        assert_eq!(budget.dispatched, 10);
    }

    #[tokio::test]
    async fn optional_probe_is_dropped_before_next_slot_and_still_uses_its_token() {
        struct Dropped(Arc<AtomicBool>);
        impl Drop for Dropped {
            fn drop(&mut self) { self.0.store(true, Ordering::Relaxed); }
        }
        let dropped = Arc::new(AtomicBool::new(false));
        let calls = AtomicU64::new(0);
        let mut budget = CdnProbeBudget::new(Duration::from_secs(1));
        // Compress the optional window; test ownership/order, not scheduler speed.
        bounded_cdn_probe(
            || {
                let call = calls.fetch_add(1, Ordering::Relaxed);
                let dropped = dropped.clone();
                async move {
                    if call == 0 {
                        let _guard = Dropped(dropped);
                        std::future::pending::<Result<(), Error>>().await
                    } else {
                        assert!(dropped.load(Ordering::Relaxed));
                        Ok(())
                    }
                }
            },
            &[
                CdnProbeSlot { at: Duration::ZERO, until: Some(Duration::from_millis(10)) },
                CdnProbeSlot::regular(Duration::ZERO),
            ],
            &mut budget,
        ).await.unwrap();
        assert_eq!(calls.load(Ordering::Relaxed), 2);
        assert_eq!(budget.dispatched, 2);
        let optional = CDN_RETRY_SLOTS.iter().position(|slot| slot.until.is_some()).unwrap();
        assert_eq!(CDN_RETRY_SLOTS[optional].until, Some(CDN_RETRY_SLOTS[optional + 1].at));
    }

    #[tokio::test]
    async fn expired_optional_slot_uses_no_token_and_terminal_errors_do_not_continue() {
        let calls = AtomicU64::new(0);
        let mut budget = CdnProbeBudget::new(Duration::from_secs(1));
        bounded_cdn_probe(
            || { calls.fetch_add(1, Ordering::Relaxed); async { Ok(()) } },
            &[
                CdnProbeSlot { at: Duration::ZERO, until: Some(Duration::ZERO) },
                CdnProbeSlot::regular(Duration::ZERO),
            ],
            &mut budget,
        ).await.unwrap();
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        assert_eq!(budget.dispatched, 1);
        for until in [None, Some(Duration::from_secs(1))] {
            for code in ["CDN_HTTP_429", "CDN_HTTP_200", "CDN_RANGE", "CDN_MIME", "CDN_ENCODING", "CDN_TRUNCATED"] {
                let calls = AtomicU64::new(0);
                let mut budget = CdnProbeBudget::new(Duration::from_secs(2));
                let result = bounded_cdn_probe(
                    || { calls.fetch_add(1, Ordering::Relaxed); async { Err(fail(code)) } },
                    &[CdnProbeSlot { at: Duration::ZERO, until }, CdnProbeSlot::regular(Duration::ZERO)],
                    &mut budget,
                ).await;
                assert!(matches!(result, Err(Error::Failed(actual)) if actual == format!("NATIVE_EMBEDDED_{code}")));
                assert_eq!(calls.load(Ordering::Relaxed), 1);
            }
        }
    }

    #[tokio::test]
    async fn polling_skips_missed_slots_and_stops_on_rate_limiting() {
        let calls = AtomicU64::new(0);
        bounded_cdn_probe(
            || {
                let call = calls.fetch_add(1, Ordering::Relaxed);
                async move {
                    if call == 0 {
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        Err(fail("CDN_HTTP_403"))
                    } else {
                        Ok(())
                    }
                }
            },
            &[
                CdnProbeSlot::regular(Duration::ZERO),
                CdnProbeSlot::regular(Duration::from_millis(1)),
                CdnProbeSlot::regular(Duration::from_millis(2)),
                CdnProbeSlot::regular(Duration::from_millis(250)),
            ],
            &mut CdnProbeBudget::new(Duration::from_secs(1)),
        )
        .await
        .unwrap();
        assert_eq!(calls.load(Ordering::Relaxed), 2);
        let calls = AtomicU64::new(0);
        let result = bounded_cdn_probe(
            || {
                calls.fetch_add(1, Ordering::Relaxed);
                async { Err(fail("CDN_HTTP_429")) }
            },
            &[CdnProbeSlot::regular(Duration::ZERO); 9],
            &mut CdnProbeBudget::new(Duration::from_secs(1)),
        )
        .await;
        assert!(result.is_err());
        assert_eq!(calls.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn retry_deadline_and_caller_cancellation_drop_the_inflight_probe() {
        struct Dropped(Arc<std::sync::atomic::AtomicBool>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Relaxed);
            }
        }
        for cancel in [false, true] {
            let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let calls = AtomicU64::new(0);
            let started = Instant::now();
            let mut budget = CdnProbeBudget::new(Duration::from_millis(if cancel { 1000 } else { 10 }));
            let slots = [CdnProbeSlot::regular(Duration::ZERO); 5];
            let operation = bounded_cdn_probe(
                || {
                    calls.fetch_add(1, Ordering::Relaxed);
                    let flag = dropped.clone();
                    async move {
                        let _guard = Dropped(flag);
                        std::future::pending::<Result<(), Error>>().await
                    }
                },
                &slots,
                &mut budget,
            );
            if cancel {
                assert!(
                    tokio::time::timeout(Duration::from_millis(10), operation)
                        .await
                        .is_err()
                );
            } else {
                assert!(operation.await.is_err());
            }
            assert!(started.elapsed() < Duration::from_secs(1));
            assert!(dropped.load(Ordering::Relaxed));
            assert_eq!(calls.load(Ordering::Relaxed), 1);
        }
    }

    #[test]
    fn failed_request_does_not_evict_newer_even_identical_configuration() {
        let used = Arc::new(cfg());
        let replacement = Arc::new((*used).clone());
        let mut cache = ConfigCache::default();
        cache
            .entries
            .insert(ID.into(), (replacement.clone(), Instant::now()));
        assert!(!invalidate_config(&mut cache, ID, &used));
        assert!(Arc::ptr_eq(&cache.entries[ID].0, &replacement));
        assert!(cache.failed.is_empty());
        cache
            .entries
            .insert(ID.into(), (used.clone(), Instant::now()));
        assert!(invalidate_config(&mut cache, ID, &used));
        assert!(!cache.entries.contains_key(ID));
        assert!(failure_cache(&mut cache.failed, ID).is_err());
        assert!(
            !invalidate_config(&mut cache, ID, &used),
            "late duplicate failure cannot extend cooldown"
        );
    }

    #[test]
    fn decoder_failure_evicts_only_exact_url_and_arc_not_newer_compilation() {
        let url = cfg().player;
        let other = player_url("/s/player/cbcfbf2f/player_es6.vflset/es_ES/base.js").unwrap();
        let used = Arc::new(PreparedDecoder {
            script: "local-script".into(),
            signature_timestamp: 20700,
        });
        let replacement = Arc::new(PreparedDecoder {
            script: "local-script".into(),
            signature_timestamp: 20700,
        });
        let mut cache = DecoderCache::default();
        cache.entries.push(Compiled {
            url: url.clone(),
            sha: [0; 32],
            decoder: replacement.clone(),
            at: Instant::now(),
        });
        cache.entries.push(Compiled {
            url: other.clone(),
            sha: [0; 32],
            decoder: used.clone(),
            at: Instant::now(),
        });
        assert!(!invalidate_compiled(&mut cache, &url, &used));
        assert_eq!(cache.entries.len(), 2);
        assert!(cache.failed.is_empty());
        assert!(invalidate_compiled(&mut cache, &other, &used));
        assert_eq!(cache.entries.len(), 1);
        assert!(Arc::ptr_eq(&cache.entries[0].decoder, &replacement));
        assert!(failure_cache(&mut cache.failed, other.as_str()).is_err());
        assert!(invalidate_compiled(&mut cache, &url, &replacement));
        assert!(cache.entries.is_empty());
    }

    #[test]
    fn original_nondefault_survives_shared_selection_but_dubbed_and_drm_do_not() {
        let original = json!({"itag":251,"url":AUDIO,"mimeType":"audio/webm; codecs=\"opus\"","bitrate":128000,"audioTrack":{"audioIsDefault":false,"displayName":"Basque (original)","id":"eu.0"}});
        let dubbed = json!({"itag":250,"url":AUDIO,"mimeType":"audio/webm; codecs=\"opus\"","bitrate":256000,"audioTrack":{"audioIsDefault":true,"displayName":"English (auto-dubbed)","id":"en.1"}});
        assert!(candidate_audio(&original, true));
        assert!(!candidate_audio(&dubbed, true));
        for (field, value) in [
            ("drmFamilies", json!(["WIDEVINE"])),
            ("drmFamilies", json!(false)),
            ("licenseInfos", json!([])),
            ("drmTrackType", json!("DRM_TRACK_TYPE_AUDIO")),
        ] {
            let mut changed = original.clone();
            changed[field] = value;
            assert!(!candidate_audio(&changed, true));
        }
        let mut response = watch_value();
        response["streamingData"] = json!({"adaptiveFormats":[dubbed,original]});
        let config = cfg();
        let client = Client {
            name: "WEB_EMBEDDED_PLAYER".into(),
            id: 56,
            version: config.version,
            user_agent: UA.into(),
            context: Map::new(),
        };
        let selected = pick_identified(&BUNDLED, &client, &response, ID, None, None).unwrap();
        assert_eq!(selected.itag, 251);
    }

    #[test]
    fn tagged_response_never_prefers_an_unverified_localized_default() {
        let original = json!({"itag":251,"mimeType":"audio/webm; codecs=\"opus\"","bitrate":128000,
            "audioTrack":{"audioIsDefault":false,"displayName":"Basque (original)","id":"eu.0"}});
        let localized_default = json!({"itag":250,"mimeType":"audio/webm; codecs=\"opus\"","bitrate":256000,
            "audioTrack":{"audioIsDefault":true,"displayName":"Spanish","id":"es.1"}});
        let untagged =
            json!({"itag":249,"mimeType":"audio/webm; codecs=\"opus\"","bitrate":320000});
        let candidates = audio_candidates(&[localized_default, untagged, original]);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0]["itag"], 251);
    }

    #[test]
    fn wholly_untagged_audio_variants_remain_compatible() {
        let formats = [
            json!({"itag":140,"mimeType":"audio/mp4; codecs=\"mp4a.40.2\"","bitrate":128000}),
            json!({"itag":249,"mimeType":"audio/webm; codecs=\"opus\"","bitrate":48000}),
            json!({"itag":250,"mimeType":"audio/webm; codecs=\"opus\"","bitrate":64000}),
            json!({"itag":251,"mimeType":"audio/webm; codecs=\"opus\"","bitrate":128000}),
        ];
        let candidates = audio_candidates(&formats);
        assert_eq!(candidates.len(), 4);
        assert_eq!(candidates[0]["itag"], 251);
        assert_eq!(audio_candidates(&formats[3..]).len(), 1);
    }

    #[test]
    fn language_metadata_without_original_evidence_is_not_an_untagged_response() {
        for field in ["audioTrack", "xtags", "language", "languageCode"] {
            let untagged = json!({"itag":251,"mimeType":"audio/webm; codecs=\"opus\""});
            let mut tagged = untagged.clone();
            tagged["itag"] = json!(250);
            tagged[field] = if field == "audioTrack" {
                json!({"audioIsDefault":true,"id":"es.1"})
            } else {
                json!("es")
            };
            assert!(audio_candidates(&[untagged, tagged]).is_empty(), "{field}");
        }
    }

    fn local(response: Vec<u8>) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let worker = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = Vec::new();
            let header_end = loop {
                let mut bytes = [0; 4096];
                let n = socket.read(&mut bytes).unwrap();
                assert!(n > 0 && request.len() < 64 * 1024);
                request.extend_from_slice(&bytes[..n]);
                if let Some(pos) = request.windows(4).position(|v| v == b"\r\n\r\n") {
                    break pos + 4;
                }
            };
            let headers = String::from_utf8(request[..header_end].to_vec()).unwrap();
            let length = headers
                .lines()
                .find_map(|line| {
                    line.split_once(':')
                        .filter(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                        .map(|(_, n)| n.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            while request.len() < header_end + length {
                let mut bytes = [0; 4096];
                let n = socket.read(&mut bytes).unwrap();
                assert!(n > 0);
                request.extend_from_slice(&bytes[..n]);
            }
            let _ = socket.write_all(&response);
            String::from_utf8(request).unwrap()
        });
        (url, worker)
    }

    fn response(status: u16, extra: &str, body: &[u8]) -> Vec<u8> {
        let mut result = format!(
            "HTTP/1.1 {status} Test\r\nConnection: close\r\nContent-Length: {}\r\n{extra}\r\n",
            body.len()
        )
        .into_bytes();
        result.extend_from_slice(body);
        result
    }

    fn local_http() -> reqwest::Client {
        reqwest::Client::builder()
            .no_proxy()
            .no_gzip()
            .timeout(Duration::from_secs(2))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap()
    }

    fn io_trace_fixture() -> (
        CdnIoTrace,
        Arc<std::sync::Mutex<Vec<CdnIoRecord>>>,
        tokio::sync::oneshot::Receiver<()>,
    ) {
        let records = Arc::new(std::sync::Mutex::new(Vec::new()));
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let mut trace = CdnIoTrace::new(true, ID, 1, 12.5).unwrap();
        trace.sink = Some(records.clone());
        trace.headers_observed = Some(sender);
        (trace, records, receiver)
    }

    #[test]
    fn io_trace_is_disabled_without_bench_and_has_only_closed_fields() {
        assert!(CdnIoTrace::new(false, ID, 1, 0.0).is_none());
        for id in ["https://private.invalid/path?token=secret", "private-account"] {
            assert!(CdnIoTrace::new(true, id, 1, 0.0).is_none());
        }
        assert!(CdnIoTrace::new(true, ID, 1, f64::NAN).is_none());
        let (trace, records, _) = io_trace_fixture();
        drop(trace);
        let records = records.lock().unwrap();
        let value = serde_json::to_value(&records[0]).unwrap();
        let mut keys: Vec<_> = value.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["atMs", "attempt", "bodyMs", "bytes", "elapsedMs", "final", "headersMs", "id", "status", "version"]);
        assert_eq!(value["final"], "cancelled");
        assert!(value["headersMs"].is_null() && value["bodyMs"].is_null());
        assert!(value["status"].is_null() && value["version"].is_null());
        assert_eq!(value["bytes"], 0);
    }

    #[tokio::test]
    async fn io_trace_keeps_empty_403_connection_reusable_for_strict206() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/audio", listener.local_addr().unwrap());
        let worker = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let mut requests = Vec::new();
            for index in 0..2 {
                let mut request = Vec::new();
                while !request.windows(4).any(|v| v == b"\r\n\r\n") {
                    let mut bytes = [0; 1024];
                    let count = socket.read(&mut bytes).unwrap();
                    assert!(count > 0, "both requests must use the same connection");
                    request.extend_from_slice(&bytes[..count]);
                }
                requests.push(request);
                if index == 0 {
                    socket.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n").unwrap();
                } else {
                    socket.write_all(&response(206,
                        "Content-Range: bytes 6553-7576/8192\r\nContent-Type: audio/webm\r\n",
                        &[0; 1024])).unwrap();
                }
                socket.flush().unwrap();
            }
            requests
        });
        let http = local_http();
        let (trace, failed, _) = io_trace_fixture();
        let error = strict_probe_request(http.get(&url), 8192, Some(trace)).await.unwrap_err();
        assert!(matches!(error, Error::Failed(code) if code == "NATIVE_EMBEDDED_CDN_HTTP_403"));
        let (trace, succeeded, _) = io_trace_fixture();
        strict_probe_request(http.get(&url), 8192, Some(trace)).await.unwrap();
        let requests = worker.join().unwrap();
        assert_eq!(requests[0], requests[1]);
        for (records, status, outcome, bytes) in [
            (failed, 403, "error", 0), (succeeded, 206, "complete", 1024),
        ] {
            let records = records.lock().unwrap();
            assert_eq!(records.len(), 1);
            let record = serde_json::to_value(&records[0]).unwrap();
            assert_eq!(record["status"], status);
            assert_eq!(record["version"], "http1.1");
            assert_eq!(record["final"], outcome);
            assert_eq!(record["bytes"], bytes);
            assert!(record["headersMs"].is_number() && record["bodyMs"].is_number());
        }
    }

    #[tokio::test]
    async fn io_trace_distinguishes_slow_body_truncation_and_cancellation_after_headers() {
        for outcome in ["complete", "error", "cancelled"] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/audio", listener.local_addr().unwrap());
            let (release, wait) = std::sync::mpsc::channel();
            let worker = thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                let mut request = Vec::new();
                while !request.windows(4).any(|v| v == b"\r\n\r\n") {
                    let mut bytes = [0; 1024];
                    let count = socket.read(&mut bytes).unwrap();
                    assert!(count > 0);
                    request.extend_from_slice(&bytes[..count]);
                }
                socket.write_all(b"HTTP/1.1 206 Partial Content\r\nContent-Length: 1024\r\nContent-Range: bytes 6553-7576/8192\r\nContent-Type: audio/webm\r\nConnection: close\r\n\r\n").unwrap();
                socket.write_all(&[0; 4]).unwrap();
                socket.flush().unwrap();
                let finish = wait.recv_timeout(Duration::from_secs(3)).unwrap();
                if finish { socket.write_all(&[0; 1020]).unwrap(); }
            });
            let (trace, records, headers) = io_trace_fixture();
            let http = local_http();
            let probe = tokio::spawn(async move {
                strict_probe_request(http.get(&url), 8192, Some(trace)).await
            });
            tokio::time::timeout(Duration::from_secs(2), headers).await.unwrap().unwrap();
            assert!(!probe.is_finished(), "headers alone never certify the probe");
            assert!(records.lock().unwrap().is_empty(), "no completed record before body EOF");
            if outcome == "cancelled" {
                probe.abort();
                assert!(probe.await.unwrap_err().is_cancelled());
                release.send(false).unwrap();
            } else {
                release.send(outcome == "complete").unwrap();
                assert_eq!(probe.await.unwrap().is_ok(), outcome == "complete");
            }
            worker.join().unwrap();
            let records = records.lock().unwrap();
            assert_eq!(records.len(), 1);
            let record = serde_json::to_value(&records[0]).unwrap();
            assert_eq!(record["final"], outcome);
            assert_eq!(record["status"], 206);
            assert_eq!(record["version"], "http1.1");
            assert!(record["headersMs"].is_number() && record["bodyMs"].is_number());
            if outcome == "complete" { assert_eq!(record["bytes"], 1024); }
            else { assert!(record["bytes"].as_u64().unwrap() < 1024); }
        }
    }

    fn local_sequence(responses: Vec<Vec<u8>>) -> (String, thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let worker = thread::spawn(move || {
            let mut requests = Vec::new();
            for response in responses {
                let deadline = Instant::now() + Duration::from_secs(3);
                let mut socket = loop {
                    match listener.accept() {
                        Ok((socket, _)) => break socket,
                        Err(error)
                            if error.kind() == std::io::ErrorKind::WouldBlock
                                && Instant::now() < deadline =>
                        {
                            thread::sleep(Duration::from_millis(2))
                        }
                        _ => return requests,
                    }
                };
                // Winsock may retain the listener's nonblocking mode on accept.
                // Reading an as-yet-unwritten request must wait for the timeout.
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                loop {
                    let mut bytes = [0; 4096];
                    let n = socket.read(&mut bytes).unwrap();
                    assert!(n > 0 && request.len() < 64 * 1024);
                    request.extend_from_slice(&bytes[..n]);
                    if let Some(end) = request
                        .windows(4)
                        .position(|v| v == b"\r\n\r\n")
                        .map(|i| i + 4)
                    {
                        let headers = String::from_utf8(request[..end].to_vec()).unwrap();
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                line.split_once(':')
                                    .filter(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                                    .map(|(_, v)| v.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        if request.len() >= end + length {
                            break;
                        }
                    }
                }
                requests.push(String::from_utf8(request).unwrap());
                socket.write_all(&response).unwrap();
            }
            requests
        });
        (url, worker)
    }

    fn ready(config: Arc<Config>, sts: u32) -> Ready {
        Ready {
            config,
            decoder: Arc::new(PreparedDecoder {
                script: "unused-local-fixture".into(),
                signature_timestamp: sts,
            }),
            deadline: None,
        }
    }

    fn cache_with(config: Arc<Config>) -> tokio::sync::Mutex<ConfigCache> {
        tokio::sync::Mutex::new(ConfigCache {
            entries: HashMap::from([(ID.into(), (config, Instant::now()))]),
            failed: HashMap::new(),
        })
    }

    fn sabr_response() -> Value {
        let mut value = watch_value();
        value["streamingData"] = json!({"adaptiveFormats":[{"itag":251,"mimeType":"audio/webm; codecs=\"opus\"","bitrate":128000}],"serverAbrStreamingUrl":"https://r1.googlevideo.com/videoplayback?test=sabr"});
        value["adSlots"] = json!([{"slot":"unchanged-public-test"}]);
        value
    }

    fn source_fixture(suffix: &str) -> String {
        format!("var player={{signatureTimestamp:20700}};/*{suffix}*/")
    }

    fn early_signal(source: &str, duration: Duration) -> EarlySabr {
        EarlySabr {
            sha: Sha256::digest(source.as_bytes()).into(),
            deadline: Instant::now() + duration,
            reservation: Instant::now(),
        }
    }

    fn preparation_fixture(stamp: u32, deadline: Instant) -> Preparation {
        Preparation {
            decoder: ready(Arc::new(cfg()), stamp).decoder,
            response: None,
            post_started: false,
            deadline: Some(deadline),
        }
    }

    async fn held_initial<R>(
        compiled: &tokio::sync::Mutex<DecoderCache>,
        config: &Config,
        signal: EarlySabr,
        early: tokio::sync::oneshot::Sender<EarlySabr>,
        admission: Option<tokio::sync::oneshot::Receiver<()>>,
        request: R,
        finish: tokio::sync::oneshot::Receiver<u32>,
        completed: &std::sync::atomic::AtomicBool,
    ) -> Result<Preparation, Error>
    where
        R: Future<Output = Result<Value, Error>>,
    {
        let mut cache = compiled.lock().await;
        cache
            .failed
            .insert(config.player.to_string(), signal.reservation);
        let analysis = async {
            let stamp = finish
                .await
                .map_err(|_| "LOCAL_ANALYSIS_CANCELLED".to_owned())?;
            Ok(PreparedDecoder {
                script: "local-only".into(),
                signature_timestamp: stamp,
            })
        };
        let (decoder, response) = analyze_preview(
            analysis,
            admitted_preview(admission, request, Some(early), signal),
            20700,
        )
        .await?;
        cache.failed.remove(config.player.as_str());
        completed.store(true, Ordering::SeqCst);
        Ok(Preparation {
            decoder: Arc::new(decoder),
            response: response.map(|response| Preview {
                response,
                trace: None,
            }),
            post_started: true,
            deadline: Some(signal.deadline),
        })
    }

    #[tokio::test]
    async fn early_sabr_local_http_replaces_only_pending_different_source_and_keeps_one_refresh() {
        // The third case finishes AST1 while the fresh HTTP source is pending;
        // its result is kept, but the distinct source still needs its own AST.
        for (same_source, first_finishes) in [(false, false), (true, true), (false, true)] {
            let first = Arc::new(cfg());
            let configs = cache_with(first.clone());
            let compiled = tokio::sync::Mutex::new(DecoderCache::default());
            let initial_source = source_fixture("first");
            let fresh_source = source_fixture(if same_source { "first" } else { "second" });
            let signal = early_signal(&initial_source, Duration::from_secs(2));
            let (early, notice) = tokio::sync::oneshot::channel();
            let (finish, finished) = tokio::sync::oneshot::channel();
            let finish = std::sync::Mutex::new(Some(finish));
            let completed = std::sync::atomic::AtomicBool::new(false);
            let mut published = config_value();
            published["VISITOR_DATA"] = json!("fresh-public-visitor");
            let mut playable = sabr_response();
            playable["streamingData"]["adaptiveFormats"][0]["signatureCipher"] =
                cipher_value(AUDIO)["signatureCipher"].clone();
            let (url, server) = local_sequence(vec![
                response(200, "", sabr_response().to_string().as_bytes()),
                response(200, "", format!("ytcfg.set({published});").as_bytes()),
                response(200, "", fresh_source.as_bytes()),
                response(200, "", playable.to_string().as_bytes()),
            ]);
            let http = local_http();
            let endpoint = format!("{url}/player");
            let initial = held_initial(
                &compiled,
                &first,
                signal,
                early,
                None,
                player_response(&http, &endpoint, &first, ID, 20700),
                finished,
                &completed,
            );
            let replacements = AtomicU64::new(0);
            let result = coordinate_preparation(
                &configs,
                &compiled,
                ID,
                first.clone(),
                false,
                initial,
                notice,
                |current| {
                    let (http, url, finish, completed) = (&http, &url, &finish, &completed);
                    async move {
                        assert!(current.is_none());
                        let html =
                            text_response(http.get(format!("{url}/embed")).send().await.unwrap())
                                .await?;
                        let next = Arc::new(config(&html)?);
                        let source =
                            text_response(http.get(format!("{url}/source")).send().await.unwrap())
                                .await?;
                        if first_finishes {
                            finish.lock().unwrap().take().unwrap().send(20700).unwrap();
                            while !completed.load(Ordering::SeqCst) {
                                tokio::task::yield_now().await;
                            }
                        }
                        Ok(Some(FreshSource {
                            config: next,
                            source,
                        }))
                    }
                },
                |_, source| {
                    let (replacements, fresh_source, completed, compiled, first) =
                        (&replacements, &fresh_source, &completed, &compiled, &first);
                    async move {
                        replacements.fetch_add(1, Ordering::SeqCst);
                        assert!(!same_source);
                        assert_eq!(&source.source, fresh_source);
                        assert_eq!(source.deadline, signal.deadline);
                        assert_eq!(completed.load(Ordering::SeqCst), first_finishes);
                        assert!(
                            !compiled
                                .try_lock()
                                .unwrap()
                                .failed
                                .contains_key(first.player.as_str()),
                            "the dropped preparation must release its lock and only its cooldown"
                        );
                        Ok(preparation_fixture(20700, source.deadline))
                    }
                },
                |next, hint| {
                    let (http, endpoint) = (&http, &endpoint);
                    async move {
                        Preview {
                            response: player_response(&http, &endpoint, &next, ID, hint).await,
                            trace: None,
                        }
                    }
                },
            )
            .await
            .unwrap();
            assert!(result.renewal_used);
            assert!(result.preparation.post_started);
            assert_eq!(
                result.preparation.response.unwrap().response.unwrap(),
                playable
            );
            assert_eq!(replacements.load(Ordering::SeqCst), u64::from(!same_source));
            assert!(Arc::ptr_eq(
                &configs.lock().await.entries[ID].0,
                &result.config
            ));
            assert!(
                reserve_early_refresh(&configs, ID, &result.config).is_none(),
                "one refresh and cooldown"
            );
            let requests = server.join().unwrap();
            assert_eq!(
                requests
                    .iter()
                    .filter(|request| request.starts_with("POST "))
                    .count(),
                2
            );
            assert_eq!(
                requests
                    .iter()
                    .filter(|request| request.starts_with("GET /embed "))
                    .count(),
                1
            );
            let old: Value =
                serde_json::from_str(requests[0].split_once("\r\n\r\n").unwrap().1).unwrap();
            let new: Value =
                serde_json::from_str(requests[3].split_once("\r\n\r\n").unwrap().1).unwrap();
            assert_eq!(old["videoId"], new["videoId"]);
            assert_eq!(old["playbackContext"], new["playbackContext"]);
            assert_ne!(old, new);
        }
    }

    #[tokio::test]
    async fn unusable_early_refresh_preserves_first_ast_and_its_only_corrected_post() {
        for invalid_hint in [false, true] {
            let first = Arc::new(cfg());
            let configs = cache_with(first.clone());
            let compiled = tokio::sync::Mutex::new(DecoderCache::default());
            let signal = early_signal(&source_fixture("first"), Duration::from_secs(2));
            let (early, notice) = tokio::sync::oneshot::channel();
            let (finish, finished) = tokio::sync::oneshot::channel();
            let completed = std::sync::atomic::AtomicBool::new(false);
            let mut playable = sabr_response();
            playable["streamingData"]["adaptiveFormats"][0]["signatureCipher"] =
                cipher_value(AUDIO)["signatureCipher"].clone();
            let (url, server) = local_sequence(vec![
                response(200, "", sabr_response().to_string().as_bytes()),
                response(200, "", playable.to_string().as_bytes()),
            ]);
            let http = local_http();
            let initial = held_initial(
                &compiled,
                &first,
                signal,
                early,
                None,
                player_response(&http, &url, &first, ID, 20700),
                finished,
                &completed,
            );
            let result = coordinate_preparation(
                &configs,
                &compiled,
                ID,
                first.clone(),
                false,
                initial,
                notice,
                |_| async {
                    finish.send(20701).unwrap(); // Full AST disproves hint1.
                    if invalid_hint {
                        let mut next = cfg();
                        next.visitor = "new-public-visitor".into();
                        Ok(Some(FreshSource {
                            config: Arc::new(next),
                            source: "no timestamp".into(),
                        }))
                    } else {
                        Ok(None)
                    }
                },
                |_, _| async { panic!("no usable replacement source") },
                |_, _| async { panic!("the coordinator cannot spend POST2 without a valid hint") },
            )
            .await
            .unwrap();
            assert!(result.renewal_used && result.preparation.post_started);
            assert!(result.preparation.response.is_none());
            assert!(completed.load(Ordering::SeqCst));
            assert!(Arc::ptr_eq(&configs.lock().await.entries[ID].0, &first));
            // This is the definitive POST2, not another refresh. Real response
            // parsing still enforces the requested ID and original candidates.
            player_response(
                &http,
                &url,
                &result.config,
                ID,
                result.preparation.decoder.signature_timestamp,
            )
            .await
            .unwrap();
            let requests = server.join().unwrap();
            assert_eq!(requests.len(), 2);
            let corrected: Value =
                serde_json::from_str(requests[1].split_once("\r\n\r\n").unwrap().1).unwrap();
            assert_eq!(
                corrected["playbackContext"]["contentPlaybackContext"]["signatureTimestamp"],
                20701
            );
            assert!(reserve_early_refresh(&configs, ID, &first).is_none());
        }
    }

    #[tokio::test]
    async fn early_player_url_only_change_uses_full_st_and_never_spends_a_third_post() {
        for (first_st, second_st) in [(20700, 20701), (20700, 20700), (20701, 20702)] {
            let first = Arc::new(cfg());
            let configs = cache_with(first.clone());
            let compiled = tokio::sync::Mutex::new(DecoderCache::default());
            let signal = early_signal(&source_fixture("first"), Duration::from_secs(2));
            let (early, notice) = tokio::sync::oneshot::channel();
            let (finish, finished) = tokio::sync::oneshot::channel();
            let completed = std::sync::atomic::AtomicBool::new(false);
            let mut published = config_value();
            published["WEB_PLAYER_CONTEXT_CONFIGS"]["WEB_PLAYER_CONTEXT_CONFIG_ID_EMBEDDED_PLAYER"]["jsUrl"] =
                json!("/s/player/abcdef12/player_es6.vflset/en_US/base.js");
            let mut playable = sabr_response();
            playable["streamingData"]["adaptiveFormats"][0]["signatureCipher"] =
                cipher_value(AUDIO)["signatureCipher"].clone();
            let corrected_first = first_st != 20700;
            let needs_post2 = corrected_first || first_st != second_st;
            let mut responses = vec![
                response(200, "", sabr_response().to_string().as_bytes()),
                response(200, "", format!("ytcfg.set({published});").as_bytes()),
                // The literal is deliberately not the injected full AST result.
                response(200, "", source_fixture("second").as_bytes()),
            ];
            if needs_post2 {
                responses.push(response(200, "", playable.to_string().as_bytes()));
            }
            let (url, server) = local_sequence(responses);
            let http = local_http();
            let endpoint = format!("{url}/player");
            let initial = held_initial(
                &compiled,
                &first,
                signal,
                early,
                None,
                player_response(&http, &endpoint, &first, ID, 20700),
                finished,
                &completed,
            );
            let replacements = AtomicU64::new(0);
            let result = coordinate_preparation(
                &configs,
                &compiled,
                ID,
                first.clone(),
                false,
                initial,
                notice,
                |_| {
                    let (http, url, first) = (&http, &url, &first);
                    async move {
                        let html =
                            text_response(http.get(format!("{url}/embed")).send().await.unwrap())
                                .await?;
                        let next = Arc::new(config(&html)?);
                        assert_eq!(body(first, ID, 0), body(&next, ID, 0));
                        assert_ne!(first.player, next.player);
                        let source =
                            text_response(http.get(format!("{url}/source")).send().await.unwrap())
                                .await?;
                        finish.send(first_st).unwrap();
                        Ok(Some(FreshSource {
                            config: next,
                            source,
                        }))
                    }
                },
                |_, source| {
                    let (replacements, completed) = (&replacements, &completed);
                    async move {
                        assert!(
                            completed.load(Ordering::SeqCst),
                            "AST1 must finish, never be cancelled"
                        );
                        assert_eq!(source.deadline, signal.deadline);
                        replacements.fetch_add(1, Ordering::SeqCst);
                        Ok(preparation_fixture(second_st, source.deadline))
                    }
                },
                |next, actual_st| {
                    let (http, endpoint) = (&http, &endpoint);
                    async move {
                        assert_eq!(
                            actual_st, second_st,
                            "POST2 uses the full second AST, not its hint"
                        );
                        Preview {
                            response: player_response(http, endpoint, &next, ID, actual_st).await,
                            trace: None,
                        }
                    }
                },
            )
            .await
            .unwrap();
            assert!(result.renewal_used);
            assert!(completed.load(Ordering::SeqCst));
            assert_eq!(
                replacements.load(Ordering::SeqCst),
                u64::from(!corrected_first)
            );
            if corrected_first {
                assert!(result.preparation.response.is_none());
                assert!(Arc::ptr_eq(&result.config, &first));
                player_response(
                    &http,
                    &endpoint,
                    &result.config,
                    ID,
                    result.preparation.decoder.signature_timestamp,
                )
                .await
                .unwrap();
            } else if needs_post2 {
                assert_eq!(
                    result.preparation.response.unwrap().response.unwrap(),
                    playable
                );
                assert!(!Arc::ptr_eq(&result.config, &first));
            } else {
                assert!(is_sabr(&result.preparation.response.unwrap().response));
                assert!(Arc::ptr_eq(&result.config, &first));
            }
            let requests = server.join().unwrap();
            assert_eq!(
                requests
                    .iter()
                    .filter(|request| request.starts_with("POST "))
                    .count(),
                if needs_post2 { 2 } else { 1 }
            );
            assert_eq!(
                requests
                    .iter()
                    .filter(|request| request.starts_with("GET /embed "))
                    .count(),
                1
            );
            if needs_post2 {
                let sent: Value =
                    serde_json::from_str(requests.last().unwrap().split_once("\r\n\r\n").unwrap().1)
                        .unwrap();
                assert_eq!(
                    sent["playbackContext"]["contentPlaybackContext"]["signatureTimestamp"],
                    if corrected_first { first_st } else { second_st }
                );
            }
            assert!(reserve_early_refresh(&configs, ID, &result.config).is_none());
        }
    }
    #[tokio::test]
    async fn early_refresh_rejects_timestamp2_and_concurrent_config_replacement_without_third_post() {
        for replace_binding in [false, true] {
            let first = Arc::new(cfg());
            let configs = cache_with(first.clone());
            let compiled = tokio::sync::Mutex::new(DecoderCache::default());
            let signal = early_signal(&source_fixture("first"), Duration::from_secs(2));
            let (early, notice) = tokio::sync::oneshot::channel();
            let (_finish, finished) = tokio::sync::oneshot::channel();
            let completed = std::sync::atomic::AtomicBool::new(false);
            let posts = AtomicU64::new(1);
            let mut next = cfg();
            next.visitor = "new-public-visitor".into();
            let next = Arc::new(next);
            let newer = Arc::new(cfg());
            let initial = held_initial(
                &compiled,
                &first,
                signal,
                early,
                None,
                async { Err(fail("SABR_ONLY")) },
                finished,
                &completed,
            );
            let result = coordinate_preparation(
                &configs,
                &compiled,
                ID,
                first.clone(),
                false,
                initial,
                notice,
                |_| async {
                    Ok(Some(FreshSource {
                        config: next.clone(),
                        source: source_fixture("second"),
                    }))
                },
                |_, source| async move {
                    Ok(preparation_fixture(
                        if replace_binding { 20700 } else { 20701 },
                        source.deadline,
                    ))
                },
                |_, _| async {
                    posts.fetch_add(1, Ordering::SeqCst);
                    if replace_binding {
                        configs
                            .lock()
                            .await
                            .entries
                            .insert(ID.into(), (newer.clone(), Instant::now()));
                    }
                    Preview {
                        response: Err(fail("SABR_ONLY")),
                        trace: None,
                    }
                },
            )
            .await;
            assert!(
                matches!(result, Err(Error::Failed(code)) if code == if replace_binding {
                "NATIVE_EMBEDDED_REFRESH_BINDING"
            } else { "NATIVE_EMBEDDED_REFRESH_TIMESTAMP" })
            );
            assert_eq!(posts.load(Ordering::SeqCst), 2);
            assert!(Arc::ptr_eq(
                &configs.lock().await.entries[ID].0,
                if replace_binding { &newer } else { &first }
            ));
        }
    }

    #[tokio::test]
    async fn early_shared_deadline_cancels_prefetch_or_second_analysis_without_reset() {
        for stalls_in_prefetch in [false, true] {
            let first = Arc::new(cfg());
            let configs = cache_with(first.clone());
            let compiled = tokio::sync::Mutex::new(DecoderCache::default());
            let signal = early_signal(&source_fixture("first"), Duration::from_millis(60));
            let (early, notice) = tokio::sync::oneshot::channel();
            let (_finish, finished) = tokio::sync::oneshot::channel();
            let completed = std::sync::atomic::AtomicBool::new(false);
            let posts = AtomicU64::new(1);
            let initial = held_initial(
                &compiled,
                &first,
                signal,
                early,
                None,
                async { Err(fail("SABR_ONLY")) },
                finished,
                &completed,
            );
            let started = Instant::now();
            let result = coordinate_preparation(
                &configs,
                &compiled,
                ID,
                first.clone(),
                false,
                initial,
                notice,
                |_| async {
                    if stalls_in_prefetch {
                        std::future::pending::<()>().await;
                    }
                    let mut next = cfg();
                    next.visitor = "new-public-visitor".into();
                    Ok(Some(FreshSource {
                        config: Arc::new(next),
                        source: source_fixture("second"),
                    }))
                },
                |_, source| async move {
                    assert_eq!(source.deadline, signal.deadline);
                    std::future::pending::<Result<Preparation, Error>>().await
                },
                |_, _| async {
                    posts.fetch_add(1, Ordering::SeqCst);
                    Preview {
                        response: Err(fail("SABR_ONLY")),
                        trace: None,
                    }
                },
            )
            .await;
            assert!(
                matches!(result, Err(Error::Failed(code)) if code == "NATIVE_EMBEDDED_DECODER_PREPARE")
            );
            assert!(started.elapsed() < Duration::from_secs(1));
            assert_eq!(
                posts.load(Ordering::SeqCst),
                if stalls_in_prefetch { 1 } else { 2 }
            );
            assert!(!completed.load(Ordering::SeqCst));
            // Timeout while still on AST1 is not a voluntary abandonment.
            assert_eq!(
                compiled
                    .try_lock()
                    .unwrap()
                    .failed
                    .contains_key(first.player.as_str()),
                stalls_in_prefetch
            );
            assert!(Arc::ptr_eq(&configs.lock().await.entries[ID].0, &first));
        }
    }

    #[tokio::test]
    async fn early_reservation_and_cleanup_never_wait_on_config_or_remove_newer_cooldown() {
        let first = Arc::new(cfg());
        let configs = cache_with(first.clone());
        let held = configs.lock().await;
        assert!(reserve_early_refresh(&configs, ID, &first).is_none());
        drop(held);
        assert!(reserve_early_refresh(&configs, ID, &first).is_some());
        assert!(reserve_early_refresh(&configs, ID, &first).is_none());
        let compiled = tokio::sync::Mutex::new(DecoderCache::default());
        let own = Instant::now();
        let newer = own + Duration::from_millis(1);
        compiled
            .lock()
            .await
            .failed
            .insert(first.player.to_string(), newer);
        clear_abandoned_preparation(&compiled, &first.player, own).await;
        assert_eq!(compiled.lock().await.failed[first.player.as_str()], newer);
        clear_abandoned_preparation(&compiled, &first.player, newer).await;
        assert!(
            !compiled
                .lock()
                .await
                .failed
                .contains_key(first.player.as_str())
        );
    }

    #[tokio::test]
    async fn rejected_watch_never_notifies_early_sabr_or_admits_a_replacement() {
        let signal = early_signal(&source_fixture("first"), Duration::from_secs(1));
        let (admit, admission) = tokio::sync::oneshot::channel();
        let (early, notice) = tokio::sync::oneshot::channel();
        let (received, response_received) = tokio::sync::oneshot::channel();
        let request = async {
            received.send(()).unwrap();
            Err(fail("SABR_ONLY"))
        };
        let work = admitted_preview(Some(admission), request, Some(early), signal);
        let reject = async {
            response_received.await.unwrap();
            drop(admit);
        };
        let (result, _) = tokio::join!(work, reject);
        assert!(matches!(result, Err(Error::Failed(code)) if code == "NATIVE_EMBEDDED_ADMISSION"));
        assert!(notice.await.is_err());
    }

    #[tokio::test]
    async fn inherited_wall_deadline_covers_compiled_lock_and_ordinary_refresh_lock_and_fetch() {
        let http = local_http();
        let config = cfg();
        let held = COMPILED.lock().await;
        let result = prepare_request(
            &http,
            &config,
            None,
            None,
            None,
            None,
            Some(Instant::now() + Duration::from_millis(20)),
        )
        .await;
        assert!(
            matches!(result, Err(Error::Failed(code)) if code == "NATIVE_EMBEDDED_DECODER_PREPARE")
        );
        drop(held);
        for hold_lock in [false, true] {
            let mut first = ready(Arc::new(cfg()), 20700);
            first.deadline = Some(Instant::now() + Duration::from_millis(20));
            let cache = cache_with(first.config.clone());
            let held = if hold_lock {
                Some(cache.lock().await)
            } else {
                None
            };
            let fetched = AtomicU64::new(0);
            let result = refresh_ready(&cache, ID, &first, |_| async {
                fetched.fetch_add(1, Ordering::SeqCst);
                std::future::pending::<Result<Ready, Error>>().await
            })
            .await;
            drop(held);
            assert!(
                matches!(result, Err(Error::Failed(code)) if code == "NATIVE_EMBEDDED_DECODER_PREPARE")
            );
            assert_eq!(fetched.load(Ordering::SeqCst), u64::from(!hold_lock));
            assert!(Arc::ptr_eq(
                &cache.lock().await.entries[ID].0,
                &first.config
            ));
        }
    }
    async fn fetch_local_ready(
        http: &reqwest::Client,
        url: &str,
        current: Option<Arc<Config>>,
        sts: u32,
    ) -> Result<Ready, Error> {
        let selected = if let Some(current) = current {
            current
        } else {
            let response = http
                .get(format!("{url}/embed"))
                .send()
                .await
                .map_err(|_| fail("TRANSPORT"))?;
            Arc::new(config(&text_response(response).await?)?)
        };
        Ok(ready(selected, sts))
    }

    #[tokio::test]
    async fn sabr_recovery_relearns_once_and_posts_only_changed_effective_context() {
        let first = ready(Arc::new(cfg()), 20700);
        let cache = cache_with(first.config.clone());
        let mut fresh = config_value();
        fresh["INNERTUBE_CONTEXT"]["client"] =
            json!({"platform":"DESKTOP","rolloutToken":"fresh-public-rollout"});
        let mut playable = sabr_response();
        playable["streamingData"]["adaptiveFormats"][0]["signatureCipher"] =
            cipher_value(AUDIO)["signatureCipher"].clone();
        let (url, server) = local_sequence(vec![
            response(200, "", sabr_response().to_string().as_bytes()),
            response(200, "", format!("ytcfg.set({fresh});").as_bytes()),
            response(200, "", playable.to_string().as_bytes()),
        ]);
        let http = local_http();
        let endpoint = format!("{url}/player");
        let actual = resolve_ready(
            &cache,
            ID,
            first.clone(),
            |next| {
                let http = &http;
                let endpoint = &endpoint;
                async move {
                    player_response(
                        http,
                        endpoint,
                        &next.config,
                        ID,
                        next.decoder.signature_timestamp,
                    )
                    .await
                }
            },
            |current| fetch_local_ready(&http, &url, current, 20700),
        )
        .await
        .unwrap();
        assert_eq!(actual, playable);
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 3);
        assert!(requests[0].starts_with("POST /player "));
        assert!(requests[1].starts_with("GET /embed "));
        assert!(requests[2].starts_with("POST /player "));
        let old: Value =
            serde_json::from_str(requests[0].split_once("\r\n\r\n").unwrap().1).unwrap();
        let new: Value =
            serde_json::from_str(requests[2].split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(old["videoId"], new["videoId"]);
        assert_eq!(old["playbackContext"], new["playbackContext"]);
        assert_eq!(old["context"]["thirdParty"], new["context"]["thirdParty"]);
        assert_eq!(
            new["context"]["client"]["rolloutToken"],
            "fresh-public-rollout"
        );
        assert_ne!(old, new);
        let mut state = cache.lock().await;
        assert!(!Arc::ptr_eq(&state.entries[ID].0, &first.config));
        assert!(
            !invalidate_config(&mut state, ID, &first.config),
            "old attempt cannot evict refreshed configuration"
        );
    }

    #[tokio::test]
    async fn sabr_identical_request_even_with_new_player_url_never_reposts_or_replaces_cache() {
        let first = ready(Arc::new(cfg()), 20700);
        let cache = cache_with(first.config.clone());
        let mut fresh = config_value();
        fresh["WEB_PLAYER_CONTEXT_CONFIGS"]["WEB_PLAYER_CONTEXT_CONFIG_ID_EMBEDDED_PLAYER"]["jsUrl"] =
            json!("/s/player/12345678/player_es6.vflset/en_US/base.js");
        let (url, server) = local_sequence(vec![
            response(200, "", sabr_response().to_string().as_bytes()),
            response(200, "", format!("ytcfg.set({fresh});").as_bytes()),
        ]);
        let http = local_http();
        let endpoint = format!("{url}/player");
        let result = resolve_ready(
            &cache,
            ID,
            first.clone(),
            |next| {
                let http = &http;
                let endpoint = &endpoint;
                async move {
                    player_response(
                        http,
                        endpoint,
                        &next.config,
                        ID,
                        next.decoder.signature_timestamp,
                    )
                    .await
                }
            },
            |current| fetch_local_ready(&http, &url, current, 20700),
        )
        .await;
        assert!(matches!(result,Err(Error::Failed(code)) if code=="NATIVE_EMBEDDED_SABR_ONLY"));
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests.iter().filter(|v| v.starts_with("POST ")).count(),
            1
        );
        assert!(Arc::ptr_eq(
            &cache.lock().await.entries[ID].0,
            &first.config
        ));
        let calls = AtomicU64::new(0);
        assert!(
            refresh_ready(&cache, ID, &first, |_| async {
                calls.fetch_add(1, Ordering::Relaxed);
                Err(fail("UNEXPECTED_FETCH"))
            })
            .await
            .is_err()
        );
        assert_eq!(
            calls.load(Ordering::Relaxed),
            0,
            "unchanged refresh is still deduplicated for 30 s"
        );
    }

    #[tokio::test]
    async fn sabr_recovery_never_retries_unplayable_wrong_id_or_unproven_missing_urls() {
        let original = sabr_response();
        let mut cases = Vec::new();
        let mut wrong = original.clone();
        wrong["videoDetails"]["videoId"] = json!("jNY_wLukVW0");
        cases.push(wrong);
        let mut unavailable = original.clone();
        unavailable["playabilityStatus"]["status"] = json!("UNPLAYABLE");
        cases.push(unavailable);
        let mut no_candidates = original.clone();
        no_candidates["streamingData"]["adaptiveFormats"] = json!([]);
        cases.push(no_candidates);
        let mut unsafe_sabr = original.clone();
        unsafe_sabr["streamingData"]["serverAbrStreamingUrl"] =
            json!("https://outside.invalid/audio");
        cases.push(unsafe_sabr);
        let mut some_url = original.clone();
        some_url["streamingData"]["adaptiveFormats"][0]["url"] = json!(AUDIO);
        cases.push(some_url);
        let mut ambiguous = original.clone();
        ambiguous["streamingData"]["adaptiveFormats"][0]["signatureCipher"] = json!({});
        cases.push(ambiguous);
        for value in cases {
            let first = ready(Arc::new(cfg()), 20700);
            let cache = cache_with(first.config.clone());
            let (url, server) = local(response(200, "", value.to_string().as_bytes()));
            let http = local_http();
            let fetches = AtomicU64::new(0);
            let _ = resolve_ready(
                &cache,
                ID,
                first,
                |next| {
                    let http = &http;
                    let url = &url;
                    async move {
                        player_response(
                            http,
                            url,
                            &next.config,
                            ID,
                            next.decoder.signature_timestamp,
                        )
                        .await
                    }
                },
                |_| async {
                    fetches.fetch_add(1, Ordering::Relaxed);
                    Err(fail("UNEXPECTED_FETCH"))
                },
            )
            .await;
            server.join().unwrap();
            assert_eq!(fetches.load(Ordering::Relaxed), 0);
        }
    }

    #[tokio::test]
    async fn concurrent_sabr_refresh_fetches_one_html_and_failed_refresh_preserves_good_config() {
        let first = ready(Arc::new(cfg()), 20700);
        let cache = cache_with(first.config.clone());
        let mut fresh = config_value();
        fresh["VISITOR_DATA"] = json!("new-public-visitor");
        let (url, server) = local_sequence(vec![response(
            200,
            "",
            format!("ytcfg.set({fresh});").as_bytes(),
        )]);
        let http = local_http();
        let (a, b) = tokio::join!(
            refresh_ready(&cache, ID, &first, |current| fetch_local_ready(
                &http, &url, current, 20700
            )),
            refresh_ready(&cache, ID, &first, |current| fetch_local_ready(
                &http, &url, current, 20700
            )),
        );
        let a = a.unwrap().unwrap();
        let b = b.unwrap().unwrap();
        assert!(Arc::ptr_eq(&a.config, &b.config));
        assert_eq!(server.join().unwrap().len(), 1);
        let calls = AtomicU64::new(0);
        assert!(
            refresh_ready(&cache, ID, &a, |_| async {
                calls.fetch_add(1, Ordering::Relaxed);
                Err(fail("UNEXPECTED_FETCH"))
            })
            .await
            .is_err()
        );
        assert_eq!(calls.load(Ordering::Relaxed), 0);
        let failure_cache = cache_with(first.config.clone());
        let (url, server) = local(response(503, "", b"unavailable"));
        assert!(
            refresh_ready(&failure_cache, ID, &first, |current| fetch_local_ready(
                &http, &url, current, 20700
            ))
            .await
            .is_err()
        );
        server.join().unwrap();
        assert!(Arc::ptr_eq(
            &failure_cache.lock().await.entries[ID].0,
            &first.config
        ));
    }

    #[tokio::test]
    async fn real_http_post_uses_only_embedded_context_and_rejects_wrong_video() {
        let mut value = watch_value();
        value["streamingData"] = json!({"adaptiveFormats":[]});
        let (url, server) = local(response(
            200,
            "Content-Type: application/json\r\n",
            value.to_string().as_bytes(),
        ));
        player_response(&local_http(), &url, &cfg(), ID, 20700)
            .await
            .unwrap();
        let request = server.join().unwrap();
        assert!(request.starts_with("POST / HTTP/1.1"));
        let (headers, text) = request.split_once("\r\n\r\n").unwrap();
        assert!(
            headers
                .to_ascii_lowercase()
                .contains("x-youtube-client-name: 56")
        );
        assert!(!headers.to_ascii_lowercase().contains("cookie:"));
        assert_eq!(
            serde_json::from_str::<Value>(text).unwrap(),
            body(&cfg(), ID, 20700)
        );
        value["videoDetails"]["videoId"] = json!("jNY_wLukVW0");
        let (url, server) = local(response(200, "", value.to_string().as_bytes()));
        assert!(
            player_response(&local_http(), &url, &cfg(), ID, 20700)
                .await
                .is_err()
        );
        server.join().unwrap();
        for status in [400, 401, 403] {
            let (url, server) = local(response(status, "", b""));
            let error = player_response(&local_http(), &url, &cfg(), ID, 20700)
                .await
                .err()
                .unwrap();
            assert!(config_rejected(&error));
            server.join().unwrap();
        }
    }

    #[tokio::test]
    async fn real_http_body_caps_utf8_status_and_truncation() {
        for raw in [
            response(403, "", b"denied"),
            response(200, "", &[0xff]),
            format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", LIMIT + 1).into_bytes(),
            b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\nshort".to_vec(),
        ] {
            let (url, server) = local(raw);
            let fetched = local_http().get(url).send().await.unwrap();
            assert!(text_response(fetched).await.is_err());
            server.join().unwrap();
        }
    }

    #[tokio::test]
    async fn real_http_80percent_requires_exact206_complete_bytes_and_total() {
        for (status, range, bytes, expected) in [
            (206, "bytes 6553-7576/8192", 1024, true),
            (200, "bytes 6553-7576/8192", 1024, false),
            (206, "bytes 0-1023/8192", 1024, false),
            (206, "bytes 6553-7576/9000", 1024, false),
            (206, "bytes 6553-7576/8192", 1000, false),
        ] {
            let raw = response(
                status,
                &format!("Content-Range: {range}\r\nContent-Type: audio/webm\r\n"),
                &vec![0; bytes],
            );
            let (url, server) = local(raw);
            assert_eq!(
                strict_probe(&local_http(), &url, 8192).await.is_ok(),
                expected
            );
            let request = server.join().unwrap();
            assert!(
                request
                    .to_ascii_lowercase()
                    .contains("range: bytes=6553-7576")
            );
        }
        for (headers, code) in [
            ("Content-Type: text/html\r\n", "NATIVE_EMBEDDED_CDN_MIME"),
            (
                "Content-Type: audio/webm\r\nContent-Encoding: gzip\r\n",
                "NATIVE_EMBEDDED_CDN_ENCODING",
            ),
        ] {
            let (url, server) = local(response(
                206,
                &format!("Content-Range: bytes 6553-7576/8192\r\n{headers}"),
                &vec![0; 1024],
            ));
            let calls = AtomicU64::new(0);
            let http = local_http();
            let result = bounded_cdn_probe(
                || {
                    calls.fetch_add(1, Ordering::Relaxed);
                    strict_probe(&http, &url, 8192)
                },
                &[CdnProbeSlot::regular(Duration::ZERO); 5],
                &mut CdnProbeBudget::new(Duration::from_secs(1)),
            )
            .await;
            assert!(matches!(result,Err(Error::Failed(actual)) if actual == code));
            assert_eq!(calls.load(Ordering::Relaxed), 1);
            server.join().unwrap();
        }
    }

    #[tokio::test]
    async fn real_http_transient403_retries_exactly_the_same_url_and_range() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!(
            "http://{}/audio?signature=unchanged&n=unchanged",
            listener.local_addr().unwrap()
        );
        let worker = thread::spawn(move || {
            let mut requests = Vec::new();
            for raw in [
                response(403, "", b""),
                response(
                    206,
                    "Content-Range: bytes 6553-7576/8192\r\nContent-Type: audio/webm\r\n",
                    &vec![0; 1024],
                ),
            ] {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                while !request.windows(4).any(|v| v == b"\r\n\r\n") {
                    let mut chunk = [0; 1024];
                    let count = socket.read(&mut chunk).unwrap();
                    assert!(count > 0);
                    request.extend_from_slice(&chunk[..count]);
                }
                requests.push(String::from_utf8(request).unwrap());
                socket.write_all(&raw).unwrap();
            }
            requests
        });
        let http = local_http();
        bounded_cdn_probe(
            || strict_probe(&http, &url, 8192),
            &[CdnProbeSlot::regular(Duration::ZERO), CdnProbeSlot::regular(Duration::from_millis(5))],
            &mut CdnProbeBudget::new(Duration::from_secs(1)),
        )
        .await
        .unwrap();
        let requests = worker.join().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0], requests[1]);
        assert!(requests[0].starts_with("GET /audio?signature=unchanged&n=unchanged HTTP/1.1"));
        assert!(
            requests[0]
                .to_ascii_lowercase()
                .contains("range: bytes=6553-7576")
        );
        assert!(
            requests[0]
                .to_ascii_lowercase()
                .contains("accept-encoding: identity")
        );
    }

    #[tokio::test]
    #[ignore = "one anonymous metadata POST using the privately saved rollout fixture; no URL output"]
    async fn real_saved_rollout_config_metadata_post() {
        let html = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(
            "../capture-bench.local/round6-embed-config.local/DJzjkMBMook-1792766152130.html.local",
        )).expect("private rollout fixture is required");
        let config = config(&html).expect("saved public rollout configuration must parse");
        assert_eq!(config.version, "2.20261022.01.00-canary_control_2.20261023.01.00");
        let started = Instant::now();
        let result = tokio::time::timeout(Duration::from_secs(30), async {
            let http = WEB.as_ref().map_err(|_| fail("HTTP"))?;
            let watch = get(http, reqwest::Url::parse(&format!("https://www.youtube.com/watch?v={ID}&hl=en")).unwrap()).await?;
            watch_player(&watch, ID)?;
            let decoder = prepared(http, &config, None).await?;
            player_response(http, PLAYER, &config, ID, decoder.signature_timestamp).await
        }).await;
        match &result {
            Ok(Ok(value)) => eprintln!("rollout-metadata {}", json!({
                "id":ID, "success":true, "version":public_version(&config),
                "ms":started.elapsed().as_secs_f64()*1000.0,
                "summary":player_summary(value, ID), "audioProbed":false,
            })),
            Ok(Err(error)) => eprintln!("rollout-metadata {}", json!({
                "id":ID, "success":false, "code":post_code(Some(error)), "audioProbed":false,
            })),
            Err(_) => eprintln!("rollout-metadata {}", json!({
                "id":ID, "success":false, "code":"measurement-timeout", "audioProbed":false,
            })),
        }
        assert!(matches!(result, Ok(Ok(_))), "metadata request was not accepted; see safe diagnostic");
    }

    #[tokio::test]
    #[ignore = "explicit anonymous network measurement; no profiles or signed URL output"]
    async fn real_three_kids_and_non_kids_control() {
        struct TraceGuard;
        impl Drop for TraceGuard {
            fn drop(&mut self) {
                TRACE_FIXTURES.store(false, Ordering::Relaxed);
            }
        }
        TRACE_FIXTURES.store(true, Ordering::Relaxed);
        let _trace = TraceGuard;
        let mut success = 0;
        for id in ["DJzjkMBMook", "WtTRMAoN2Fw", "kcUgLakr7bU", "jNY_wLukVW0"] {
            let started = Instant::now();
            match tokio::time::timeout(Duration::from_secs(30), resolve(id)).await {
                Ok(Ok(direct)) => {
                    assert!(direct_audio_url(&direct.url));
                    assert!(direct.itag > 0);
                    success += 1;
                    eprintln!(
                        "embedded id={id} success=true ms={:.1} client={} itag={}",
                        started.elapsed().as_secs_f64() * 1000.0,
                        direct.client,
                        direct.itag
                    );
                }
                Ok(Err(error)) => {
                    let code = match error {
                        Error::Gone(_) => "NATIVE_EMBEDDED_GONE".into(),
                        Error::Failed(code) => code,
                    };
                    assert!(code.starts_with("NATIVE_EMBEDDED_"));
                    eprintln!(
                        "embedded id={id} success=false ms={:.1} category={code}",
                        started.elapsed().as_secs_f64() * 1000.0
                    );
                }
                Err(_) => {
                    eprintln!("embedded id={id} success=false category=NATIVE_EMBEDDED_TIMEOUT")
                }
            }
        }
        eprintln!("embedded measured=4 successes={success} (completion is not compatibility)");
    }
}
