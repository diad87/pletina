//! Private bounded benchmark evidence. This recorder never supplies playback data
//! or classifies an advertisement. Missing/truncated evidence stays unmeasured.
use base64::Engine;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};

const MAX_DISK: u64 = 1024 * 1024 * 1024;
const MAX_PART: usize = 128 * 1024;
#[derive(Default)]
struct Document {
    sequence: u64,
    appends: u64,
    bytes: u64,
    parts: u64,
    clocks: u64,
    js_dropped: u64,
    final_marker: bool,
    final_request: Option<String>,
    playback_samples: u64,
}
struct Pending {
    next: u64,
    parts: u64,
    bytes: u64,
    total: u64,
}
#[derive(Default)]
struct Audit {
    documents: HashMap<String, Document>,
    finalizations: HashMap<u64, String>,
    pending: HashMap<String, Pending>,
    parts: u64,
    appends: u64,
    bytes: u64,
    clocks: u64,
    mutations: u64,
    dropped: u64,
    integrity_errors: u64,
    last_error: Option<String>,
}
#[derive(Default)]
struct Store {
    root: Option<PathBuf>,
    disk_bytes: u64,
    videos: HashMap<String, Audit>,
    next_finalization: u64,
}
static STORE: LazyLock<Mutex<Store>> = LazyLock::new(|| Mutex::new(Store::default()));

fn enabled() -> bool {
    std::env::var_os("MUSIFY_BENCH").is_some()
        && std::env::var("MUSIFY_BENCH_AUDIT_ALL_AUDIO")
            .ok()
            .as_deref()
            == Some("1")
}
fn valid_id(value: &str) -> bool {
    value.len() == 11
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
fn token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
}
fn origin(value: &str) -> bool {
    reqwest::Url::parse(value).ok().is_some_and(|url| {
        url.scheme() == "https"
            && matches!(
                url.host_str(),
                Some("music.youtube.com" | "www.youtube.com")
            )
    })
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Message {
    audit: u8,
    v: String,
    generation: u64,
    epoch: u64,
    document_id: String,
    sequence: u64,
    kind: String,
    browser_now: Option<f64>,
    source: Option<u64>,
    s: Option<u64>,
    mime: Option<String>,
    timeline_settings: Option<Value>,
    append_id: Option<u64>,
    part: Option<u64>,
    parts: Option<u64>,
    total_bytes: Option<u64>,
    data: Option<String>,
    phase: Option<String>,
    operation: Option<String>,
    reason: Option<String>,
    request_id: Option<String>,
    statistics: Option<Statistics>,
    playback: Option<Value>,
    position: Option<f64>,
    duration: Option<f64>,
    paused: Option<bool>,
    ended: Option<bool>,
    seeking: Option<bool>,
    playback_rate: Option<f64>,
    ready_state: Option<u64>,
    source_ended: Option<bool>,
    audio_ranges: Option<Vec<Range>>,
    site_state: Option<String>,
    ad_marker: Option<bool>,
    start: Option<f64>,
    end: Option<f64>,
    error: Option<bool>,
}
#[derive(Deserialize)]
struct Statistics {
    appends: Option<u64>,
    bytes: Option<u64>,
    parts: u64,
    clocks: u64,
    dropped: u64,
    errors: u64,
}
#[derive(Deserialize)]
struct Range {
    start: f64,
    end: f64,
}

fn fail(audit: &mut Audit, reason: &str) {
    audit.dropped += 1;
    audit.integrity_errors += 1;
    audit.last_error = Some(reason.to_string());
}
fn create_root() -> std::io::Result<PathBuf> {
    static SEQUENCE: AtomicU64 = AtomicU64::new(1);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "musify-capture-audit-{}-{stamp}-{}.local",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir(&path)?;
    Ok(path)
}
fn safe_label(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|s| {
        s.len() <= 64
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_ .".contains(&b))
    })
}
/// Optional diagnostic only: reconstruct an allowlisted object rather than
/// persisting a caller's stack, URLs, arbitrary properties or account strings.
fn playback_diagnostic(value: &Value) -> Option<Value> {
    const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
    let version = value["version"].as_u64().filter(|n| *n == 1)?;
    let phase = value["phase"]
        .as_str()
        .filter(|s| matches!(*s, "sample" | "summary"))?;
    let samples = value["samples"].as_u64().filter(|n| *n <= 20)?;
    let max_samples = value["maxSamples"].as_u64().filter(|n| *n == 20)?;
    let mut counts = serde_json::Map::new();
    for name in [
        "pause",
        "play",
        "rateWrites",
        "rateRedundant",
        "mutedWrites",
        "mutedRedundant",
        "captureCalls",
        "externalCalls",
        "throws",
    ] {
        let count = value["counts"][name]
            .as_u64()
            .filter(|n| *n <= MAX_SAFE_INTEGER)?;
        counts.insert(name.into(), json!(count));
    }
    let mut out = json!({"version":version,"phase":phase,"samples":samples,"maxSamples":max_samples,"counts":counts});
    if phase == "sample" {
        let control = &value["control"];
        let method = control["method"].as_str().filter(|s| {
            matches!(
                *s,
                "pause" | "play" | "playbackRate" | "defaultPlaybackRate" | "muted"
            )
        })?;
        let origin = control["origin"]
            .as_str()
            .filter(|s| matches!(*s, "capture" | "external"))?;
        let snapshot = |input: &Value| -> Option<Value> {
            if input.is_null() {
                return Some(Value::Null);
            }
            input.as_object()?;
            let mut state = json!({});
            for name in ["position", "rate"] {
                if let Some(value) = input.get(name) {
                    state[name] = json!(value.as_f64().filter(|n| n.is_finite())?);
                }
            }
            for name in ["paused", "muted", "focused"] {
                if let Some(value) = input.get(name) {
                    state[name] = json!(value.as_bool()?);
                }
            }
            if let Some(value) = input.get("visibility") {
                state["visibility"] = json!(
                    value
                        .as_str()
                        .filter(|s| matches!(*s, "visible" | "hidden"))?
                );
            }
            Some(state)
        };
        let mut clean = json!({"method":method,"origin":origin,"before":snapshot(&control["before"])? ,"after":snapshot(&control["after"])? ,"threw":control["threw"].as_bool()?});
        if let Some(reason) = control.get("reason") {
            let reason = reason.as_str()?.to_string();
            let label = Some(reason);
            let safe = safe_label(&label).filter(|s| !s.is_empty())?;
            clean["reason"] = json!(safe);
        }
        if let Some(requested) = control.get("requested") {
            match method {
                "muted" => clean["requested"] = json!(requested.as_bool()?),
                "playbackRate" | "defaultPlaybackRate" => {
                    clean["requested"] = json!(requested.as_f64().filter(|n| n.is_finite())?)
                }
                _ => return None,
            }
        }
        if let Some(stack) = control.get("stack") {
            let names = stack.as_array().filter(|names| names.len() <= 12)?;
            let mut clean_names = Vec::with_capacity(names.len());
            for name in names {
                let name = name.as_str()?;
                if name.is_empty()
                    || name.len() > 64
                    || !name
                        .bytes()
                        .next()
                        .is_some_and(|b| b.is_ascii_alphabetic() || b"_$".contains(&b))
                    || !name
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_$.".contains(&b))
                {
                    return None;
                }
                clean_names.push(name.to_string());
            }
            clean["stack"] = json!(clean_names);
        }
        if let Some(frames) = control.get("frames") {
            let frames = frames.as_array().filter(|frames| frames.len() <= 12)?;
            let mut clean_frames = Vec::with_capacity(frames.len());
            for frame in frames {
                let category = frame["category"].as_str().filter(|category| {
                    matches!(
                        *category,
                        "player-script" | "youtube-page" | "anonymous" | "eval" | "other"
                    )
                })?;
                let mut clean_frame = json!({"category":category});
                for field in ["line", "column"] {
                    if let Some(value) = frame.get(field) {
                        clean_frame[field] = json!(
                            value
                                .as_u64()
                                .filter(|value| *value >= 1 && *value <= MAX_SAFE_INTEGER)?
                        );
                    }
                }
                if let Some(revision) = frame.get("revision") {
                    let revision = revision.as_str()?;
                    if category != "player-script"
                        || !(8..=32).contains(&revision.len())
                        || !revision
                            .bytes()
                            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
                    {
                        return None;
                    }
                    clean_frame["revision"] = json!(revision);
                }
                // URL/path/query and all unrecognized frame properties are omitted.
                clean_frames.push(clean_frame);
            }
            clean["frames"] = json!(clean_frames);
        }
        out["control"] = clean;
    }
    Some(out)
}
fn record(store: &mut Store, id: &str, message: Message) {
    let audit = store.videos.entry(id.to_string()).or_default();
    let document_key = format!("{}-{}", message.generation, message.document_id);
    let document = audit.documents.entry(document_key.clone()).or_default();
    if message.sequence != document.sequence + 1 {
        document.sequence = message.sequence;
        fail(audit, "missing-or-repeated-audit-sequence");
        return;
    }
    document.sequence = message.sequence;
    document.final_marker = false;
    document.final_request = None;
    let mut final_marker = false;
    let mut final_request = None;
    let mut metadata = json!({"audit":1,"v":id,"generation":message.generation,"epoch":message.epoch,
        "documentId":message.document_id,"sequence":message.sequence,"kind":message.kind,"browserNow":message.browser_now,
        "source":message.source,"s":message.s});
    let mut bytes = Vec::new();
    let mut audio_file = None;
    let mut pending_key = None;
    match message.kind.as_str() {
        "append" => {
            let (
                Some(source),
                Some(buffer),
                Some(append),
                Some(part),
                Some(parts),
                Some(total),
                Some(data),
                Some(mime),
                Some(settings),
            ) = (
                message.source,
                message.s,
                message.append_id,
                message.part,
                message.parts,
                message.total_bytes,
                message.data,
                message.mime,
                message.timeline_settings,
            )
            else {
                fail(audit, "append-fields-missing");
                return;
            };
            if source == 0
                || buffer == 0
                || append == 0
                || parts == 0
                || part >= parts
                || total == 0
                || total > MAX_DISK
                || parts != total.div_ceil(MAX_PART as u64)
                || mime.len() > 128
                || !mime.starts_with("audio/")
                || mime.contains("://")
            {
                fail(audit, "invalid-append-metadata");
                return;
            }
            // Store only the four numeric/enum MSE settings, never arbitrary objects.
            if settings["timestampOffset"].as_f64().is_none()
                || settings["appendWindowStart"].as_f64().is_none()
                || !(settings["appendWindowEnd"].is_null()
                    || settings["appendWindowEnd"].as_f64().is_some())
                || ![Some("segments"), Some("sequence")].contains(&settings["mode"].as_str())
            {
                fail(audit, "invalid-timeline-settings");
                return;
            }
            bytes = match base64::engine::general_purpose::STANDARD.decode(data) {
                Ok(bytes) if !bytes.is_empty() && bytes.len() <= MAX_PART => bytes,
                _ => {
                    fail(audit, "invalid-audio-part");
                    return;
                }
            };
            let key = format!(
                "{document_key}-e{}-s{source}-b{buffer}-a{append}",
                message.epoch
            );
            if part == 0 {
                if audit.pending.contains_key(&key) {
                    fail(audit, "repeated-audio-append");
                    return;
                }
                audit.pending.insert(
                    key.clone(),
                    Pending {
                        next: 0,
                        parts,
                        bytes: 0,
                        total,
                    },
                );
            }
            if audit
                .pending
                .get(&key)
                .is_none_or(|p| p.next != part || p.parts != parts || p.total != total)
            {
                fail(audit, "missing-or-reordered-audio-part");
                return;
            }
            if bytes.len() as u64 != (total - part * MAX_PART as u64).min(MAX_PART as u64) {
                fail(audit, "truncated-audio-part");
                return;
            }
            audio_file = Some(format!(
                "{id}-{document_key}-e{}-s{source}-b{buffer}.audio",
                message.epoch
            ));
            pending_key = Some(key);
            metadata["appendId"] = json!(append);
            metadata["part"] = json!(part);
            metadata["parts"] = json!(parts);
            metadata["totalBytes"] = json!(total);
            metadata["bytes"] = json!(bytes.len());
            metadata["mime"] = json!(mime);
            metadata["timelineSettings"] = json!({"timestampOffset":settings["timestampOffset"],"appendWindowStart":settings["appendWindowStart"],"appendWindowEnd":settings["appendWindowEnd"],"mode":settings["mode"]});
        }
        "clock" => {
            if ![Some("content"), Some("ad"), Some("unknown")]
                .contains(&message.site_state.as_deref())
            {
                fail(audit, "invalid-site-observation");
                return;
            }
            metadata["phase"] = json!(safe_label(&message.phase));
            metadata["siteState"] = json!(message.site_state);
            metadata["adMarker"] = json!(message.ad_marker);
            metadata["position"] = json!(message.position);
            metadata["duration"] = json!(message.duration);
            metadata["paused"] = json!(message.paused);
            metadata["ended"] = json!(message.ended);
            metadata["seeking"] = json!(message.seeking);
            metadata["playbackRate"] = json!(message.playback_rate);
            metadata["readyState"] = json!(message.ready_state);
            metadata["sourceEnded"] = json!(message.source_ended);
            metadata["audioRanges"] = json!(
                message
                    .audio_ranges
                    .unwrap_or_default()
                    .iter()
                    .take(32)
                    .map(|r| json!({"start":r.start,"end":r.end}))
                    .collect::<Vec<_>>()
            );
        }
        "mutation" => {
            metadata["operation"] = json!(safe_label(&message.operation));
            metadata["start"] = json!(message.start);
            metadata["end"] = json!(message.end);
            metadata["error"] = json!(message.error);
        }
        "diagnostic" => {
            metadata["reason"] = json!(safe_label(&message.reason));
            if message.reason.as_deref() == Some("audit-playback-control") {
                if let Some(playback) = message.playback.as_ref().and_then(playback_diagnostic) {
                    let document = audit.documents.get_mut(&document_key).unwrap();
                    if playback["phase"] == "sample" {
                        if document.playback_samples < 20 {
                            document.playback_samples += 1;
                            metadata["playback"] = playback;
                        } else {
                            metadata["playbackRejected"] = json!(true);
                        }
                    } else {
                        metadata["playback"] = playback;
                    }
                } else {
                    // Losing optional caller telemetry does not change audio,
                    // byte/clock counters, or finalization integrity accounting.
                    metadata["playbackRejected"] = json!(true);
                }
            }
            if let Some(stats) = message.statistics {
                let requested = message.reason.as_deref() == Some("audit-finalized");
                let bound_request = requested
                    && message.request_id.as_ref().is_some_and(|request| {
                        audit.finalizations.get(&message.generation) == Some(request)
                    });
                let document = audit.documents.get_mut(&document_key).unwrap();
                let counters_match = stats.parts == document.parts
                    && stats.clocks == document.clocks
                    && stats.appends.is_none_or(|n| n == document.appends)
                    && stats.bytes.is_none_or(|n| n == document.bytes)
                    && (!requested || (stats.appends.is_some() && stats.bytes.is_some()));
                if !counters_match || (requested && !bound_request) {
                    audit.integrity_errors += 1;
                    audit.last_error = Some(
                        if requested && !bound_request {
                            "audit-finalization-binding-mismatch"
                        } else {
                            "javascript-native-counter-mismatch"
                        }
                        .into(),
                    );
                }
                audit.dropped += stats.dropped.saturating_sub(document.js_dropped);
                document.js_dropped = stats.dropped;
                final_marker = (message.reason.as_deref() == Some("audit-pagehide")
                    || bound_request)
                    && counters_match
                    && stats.dropped == 0
                    && stats.errors == 0;
                if bound_request {
                    final_request = message.request_id.clone();
                    metadata["requestId"] = json!(message.request_id);
                }
                metadata["statistics"] = json!({"appends":stats.appends,"bytes":stats.bytes,"parts":stats.parts,"clocks":stats.clocks,"dropped":stats.dropped,"errors":stats.errors});
            }
        }
        _ => {
            fail(audit, "unknown-audit-record");
            return;
        }
    }
    if store.root.is_none() {
        store.root = create_root().ok();
    }
    let Some(root) = &store.root else {
        fail(audit, "audit-directory-unavailable");
        return;
    };
    if let Some(file) = &audio_file {
        let offset = std::fs::metadata(root.join(file))
            .map(|m| m.len())
            .unwrap_or(0);
        metadata["audioFile"] = json!(file);
        metadata["byteOffset"] = json!(offset);
    }
    let mut line = match serde_json::to_vec(&metadata) {
        Ok(line) => line,
        Err(_) => {
            fail(audit, "audit-json-unavailable");
            return;
        }
    };
    line.push(b'\n');
    let added = bytes.len() as u64 + line.len() as u64;
    if store.disk_bytes.saturating_add(added) > MAX_DISK {
        fail(audit, "process-disk-budget1GiB-exceeded");
        return;
    }
    // Reserve before writing: partial filesystem writes also consume the budget.
    store.disk_bytes += added;
    let written = (|| -> std::io::Result<()> {
        if let Some(file) = audio_file {
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(root.join(file))?
                .write_all(&bytes)?;
        }
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(root.join(format!("{id}-observations.jsonl")))?
            .write_all(&line)
    })();
    if written.is_err() {
        fail(audit, "audit-disk-write-failed");
        return;
    }
    if let Some(key) = pending_key {
        let pending = audit.pending.get_mut(&key).unwrap();
        pending.next += 1;
        pending.bytes += bytes.len() as u64;
        if pending.next == pending.parts {
            if pending.bytes == pending.total {
                audit.appends += 1;
                audit.documents.get_mut(&document_key).unwrap().appends += 1;
                audit.pending.remove(&key);
            } else {
                fail(audit, "incomplete-audio-append");
                return;
            }
        }
        audit.parts += 1;
        audit.bytes += bytes.len() as u64;
        audit.documents.get_mut(&document_key).unwrap().parts += 1;
        audit.documents.get_mut(&document_key).unwrap().bytes += bytes.len() as u64;
    }
    if message.kind == "clock" {
        audit.clocks += 1;
        audit.documents.get_mut(&document_key).unwrap().clocks += 1;
    }
    if message.kind == "mutation" {
        audit.mutations += 1;
    }
    // A marker acknowledges native receipt only after its record was written.
    let document = audit.documents.get_mut(&document_key).unwrap();
    document.final_marker = final_marker;
    document.final_request = final_request;
}

/// The native caller supplies the window binding; data cannot choose another track.
pub fn receive(native_id: &str, native_generation: u64, document_url: &str, text: &str) {
    if !enabled() || !valid_id(native_id) || !origin(document_url) {
        return;
    }
    let mut store = STORE.lock().unwrap();
    if text.len() > MAX_PART * 2 + 8192 {
        fail(
            store.videos.entry(native_id.into()).or_default(),
            "audit-message-too-large",
        );
        return;
    }
    let message: Message = match serde_json::from_str(text) {
        Ok(m) => m,
        Err(_) => {
            fail(
                store.videos.entry(native_id.into()).or_default(),
                "invalid-audit-json",
            );
            return;
        }
    };
    if message.audit != 1
        || message.v != native_id
        || message.generation != native_generation
        || message.epoch == 0
        || !token(&message.document_id)
        || message.sequence == 0
    {
        fail(
            store.videos.entry(native_id.into()).or_default(),
            "audit-window-binding-mismatch",
        );
        return;
    }
    record(&mut store, native_id, message);
}

#[tauri::command]
pub fn capture_audit_status(video_id: String) -> Result<Value, String> {
    if !enabled() {
        return Ok(json!({"enabled":false,"measured":false}));
    }
    if !valid_id(&video_id) {
        return Err("ID de vídeo inválido".into());
    }
    let store = STORE.lock().unwrap();
    let Some(audit) = store.videos.get(&video_id) else {
        return Ok(json!({"enabled":true,"measured":false,"pending":true}));
    };
    Ok(
        json!({"enabled":true,"measured":false,"purpose":"independent-presentation-evidence-only","videoId":video_id,
        "parts":audit.parts,"appends":audit.appends,"bytes":audit.bytes,"clockObservations":audit.clocks,"mutations":audit.mutations,
        "dropped":audit.dropped,"truncatedAppends":audit.pending.len(),"integrityErrors":audit.integrity_errors,
        "transportContiguous":audit.dropped==0 && audit.integrity_errors==0 && audit.pending.is_empty(),
        "completeRecording":audit.dropped==0 && audit.integrity_errors==0 && audit.pending.is_empty() && audit.parts>0 && audit.documents.values().all(|d| d.final_marker),
        "documentsWithoutFinalMarker":audit.documents.values().filter(|d| !d.final_marker).count(),
        "lastError":audit.last_error,"localArtifact":store.root.is_some(),"processDiskBytes":store.disk_bytes,"processDiskLimit":MAX_DISK,
        "semanticAdDelay":null,"unmeasuredReason":"raw evidence requires an independently aligned reference and external interval labels"}),
    )
}

/// Internal tooling only. The command above intentionally does not publish paths.
#[allow(dead_code)] // Offline inspection may locate private artifacts; never a frontend command.
pub fn artifact_directory() -> Option<PathBuf> {
    STORE.lock().unwrap().root.clone()
}

/// Begin only after the playback lease has been retired. The JS marker must echo
/// this native request; ExecuteScript completing is not a WebMessage receipt.
pub fn begin_finalization(video_id: &str, generation: u64) -> Option<String> {
    if !enabled() {
        return None;
    }
    let mut store = STORE.lock().unwrap();
    store.next_finalization += 1;
    let request = format!("close-{generation}-{}", store.next_finalization);
    store
        .videos
        .entry(video_id.into())
        .or_default()
        .finalizations
        .insert(generation, request.clone());
    Some(request)
}

fn has_finalization(audit: &Audit, generation: u64, request: &str) -> bool {
    let prefix = format!("{generation}-");
    let documents: Vec<_> = audit
        .documents
        .iter()
        .filter(|(key, _)| key.starts_with(&prefix))
        .map(|(_, doc)| doc)
        .collect();
    audit
        .finalizations
        .get(&generation)
        .is_some_and(|value| value == request)
        && audit.dropped == 0
        && audit.integrity_errors == 0
        && audit.pending.is_empty()
        && !documents.is_empty()
        && documents.iter().all(|doc| doc.final_marker)
        && documents
            .iter()
            .any(|doc| doc.final_request.as_deref() == Some(request))
}

pub fn finalization_acknowledged(video_id: &str, generation: u64, request: &str) -> bool {
    STORE
        .lock()
        .unwrap()
        .videos
        .get(video_id)
        .is_some_and(|audit| has_finalization(audit, generation, request))
}

pub fn finalization_failed(video_id: &str, generation: u64, request: &str) {
    let mut store = STORE.lock().unwrap();
    if let Some(audit) = store.videos.get_mut(video_id)
        && audit
            .finalizations
            .get(&generation)
            .is_some_and(|value| value == request)
    {
        fail(audit, "audit-finalization-unacknowledged-before-close");
    }
}

/// Call when a native benchmark window is retired. Without its final JS counters,
/// losing an ENTIRE last append is undetectable from part sequence numbers alone.
pub fn close_session(video_id: &str, generation: u64) {
    if !enabled() {
        return;
    }
    let mut store = STORE.lock().unwrap();
    {
        let audit = store.videos.entry(video_id.into()).or_default();
        let prefix = format!("{generation}-");
        if !audit.documents.keys().any(|key| key.starts_with(&prefix))
            || audit
                .documents
                .iter()
                .any(|(key, doc)| key.starts_with(&prefix) && !doc.final_marker)
        {
            fail(audit, "native-window-closed-without-final-audit-counters");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "jNY_wLukVW0";
    #[test]
    fn concurrent_audit_roots_are_fresh_even_when_wall_clock_resolution_is_shared() {
        let workers: Vec<_> = (0..16).map(|_| std::thread::spawn(create_root)).collect();
        let paths: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap().unwrap())
            .collect();
        let distinct: std::collections::HashSet<_> = paths.iter().collect();
        assert_eq!(distinct.len(), paths.len());
        for path in paths {
            std::fs::remove_dir(path).unwrap();
        }
    }
    fn message(sequence: u64, extra: Value) -> Message {
        let mut value = json!({"audit":1,"v":ID,"generation":7,"epoch":1,"documentId":"test-document","sequence":sequence,"browserNow":0,"kind":"diagnostic"});
        value
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        serde_json::from_value(value).unwrap()
    }
    fn part(part: u64, parts: u64, total: u64, bytes: &[u8]) -> Value {
        json!({"kind":"append","source":1,"s":1,"appendId":1,"part":part,"parts":parts,"totalBytes":total,
            "mime":"audio/webm; codecs=opus","timelineSettings":{"timestampOffset":0,"appendWindowStart":0,"appendWindowEnd":null,"mode":"segments"},
            "data":base64::engine::general_purpose::STANDARD.encode(bytes)})
    }
    fn playback_sample() -> Value {
        json!({"version":1,"phase":"sample","samples":1,"maxSamples":20,
            "counts":{"pause":1,"play":0,"rateWrites":0,"rateRedundant":0,"mutedWrites":0,"mutedRedundant":0,"captureCalls":0,"externalCalls":1,"throws":0},
            "control":{"method":"pause","origin":"external","threw":false,
                "before":{"position":3.034396,"paused":false,"muted":true,"rate":1,"visibility":"hidden","focused":false},
                "after":{"position":3.034396,"paused":true,"muted":true,"rate":1,"visibility":"hidden","focused":false},
                "stack":["Object.$pause","site_fn"]}})
    }
    #[test]
    fn playback_control_filters_private_properties_and_rejects_malformed_allowed_fields() {
        let mut input = playback_sample();
        input["url"] = json!("https://private.invalid/signed-token");
        input["control"]["account"] = json!("private-account");
        input["control"]["before"]["path"] = json!("C:/private/profile");
        let clean = playback_diagnostic(&input).unwrap();
        assert_eq!(clean["control"]["stack"][0], "Object.$pause");
        let mut extended = input.clone();
        extended["control"]["stack"] =
            json!((0..12).map(|i| format!("caller{i}")).collect::<Vec<_>>());
        assert_eq!(
            playback_diagnostic(&extended).unwrap()["control"]["stack"]
                .as_array()
                .unwrap()
                .len(),
            12
        );
        let encoded = clean.to_string();
        for private in [
            "private.invalid",
            "signed-token",
            "private-account",
            "C:/private/profile",
        ] {
            assert!(!encoded.contains(private));
        }
        for (pointer, bad) in [
            ("/control/stack", json!(["https://private.invalid/token"])),
            ("/control/stack", json!(["C:\\private\\profile"])),
            ("/control/stack", json!(vec!["frame"; 13])),
            ("/control/reason", json!("https://private.invalid/token")),
            ("/control/method", json!("arbitrary-operation")),
            ("/control/origin", json!("private-account")),
            ("/control/before/paused", json!("true")),
            ("/control/before/position", json!({"value":3})),
            ("/control/after/visibility", json!("private-account")),
            ("/counts/pause", json!(-1)),
            ("/counts/play", json!(9_007_199_254_740_992u64)),
            ("/samples", json!(21)),
        ] {
            let mut bad_input = input.clone();
            // reason is optional in the fixture.
            if pointer == "/control/reason" {
                bad_input["control"]["reason"] = bad;
            } else {
                *bad_input.pointer_mut(pointer).unwrap() = bad;
            }
            assert!(playback_diagnostic(&bad_input).is_none(), "{pointer}");
        }
        let mut throwing = playback_sample();
        throwing["control"]["before"] = Value::Null;
        throwing["control"]["after"] = json!({"paused":true});
        throwing["control"]["threw"] = json!(true);
        assert!(
            playback_diagnostic(&throwing).is_some(),
            "unavailable getters must not invent state"
        );
    }
    #[test]
    fn playback_telemetry_is_bounded_persisted_and_cannot_change_final_byte_counters() {
        let mut store = Store::default();
        record(&mut store, ID, message(1, part(0, 1, 3, &[1, 2, 3])));
        for sequence in 2..=22 {
            let mut playback = playback_sample();
            playback["privateField"] = json!("must-not-persist");
            record(
                &mut store,
                ID,
                message(
                    sequence,
                    json!({"reason":"audit-playback-control","playback":playback}),
                ),
            );
        }
        record(
            &mut store,
            ID,
            message(
                23,
                json!({"reason":"audit-playback-control","playback":{"control":{"stack":"private-stack"}}}),
            ),
        );
        assert_eq!(store.videos[ID].parts, 1);
        assert_eq!(store.videos[ID].bytes, 3);
        assert_eq!(store.videos[ID].clocks, 0);
        assert_eq!(store.videos[ID].integrity_errors, 0);
        assert_eq!(
            store.videos[ID].documents["7-test-document"].playback_samples,
            20
        );
        store
            .videos
            .get_mut(ID)
            .unwrap()
            .finalizations
            .insert(7, "close-7-1".into());
        record(&mut store, ID, final_message(24, "close-7-1", 1));
        assert!(has_finalization(&store.videos[ID], 7, "close-7-1"));
        let text = std::fs::read_to_string(
            store
                .root
                .as_ref()
                .unwrap()
                .join(format!("{ID}-observations.jsonl")),
        )
        .unwrap();
        assert!(!text.contains("must-not-persist") && !text.contains("private-stack"));
        let lines: Vec<Value> = text
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(
            lines
                .iter()
                .filter(|line| line.get("playback").is_some())
                .count(),
            20
        );
        assert_eq!(
            lines
                .iter()
                .filter(|line| line["playbackRejected"] == true)
                .count(),
            2
        );
        assert_eq!(lines[1]["playback"]["control"]["before"]["paused"], false);
        assert_eq!(lines[1]["playback"]["control"]["after"]["paused"], true);
        record(
            &mut store,
            ID,
            message(
                25,
                json!({"reason":"audit-playback-control","playback":playback_sample()}),
            ),
        );
        assert!(
            !has_finalization(&store.videos[ID], 7, "close-7-1"),
            "a late diagnostic cannot borrow the previous final marker"
        );
    }
    #[test]
    fn playback_frames_keep_only_categories_coordinates_and_public_revision_shape() {
        let mut input = playback_sample();
        input["control"]["frames"] = json!([
            {"category":"player-script","line":245,"column":17,"revision":"a8b123cd",
                "url":"https://private.invalid/file?token=must-not-persist","path":"C:/private/profile","account":"must-not-persist"},
            {"category":"youtube-page","line":1,"column":900},
            {"category":"anonymous"},{"category":"eval"},{"category":"other"}
        ]);
        let clean = playback_diagnostic(&input).unwrap();
        assert_eq!(
            clean["control"]["frames"][0],
            json!({"category":"player-script","line":245,"column":17,"revision":"a8b123cd"})
        );
        assert!(!clean.to_string().contains("must-not-persist"));
        assert!(!clean.to_string().contains("private"));
        for bad in [
            json!({"category":"https://private.invalid"}),
            json!({"category":"player-script","revision":"https://private.invalid"}),
            json!({"category":"player-script","revision":"C:/private/profile"}),
            json!({"category":"player-script","revision":"ABCDEF12"}),
            json!({"category":"player-script","revision":"short"}),
            json!({"category":"player-script","revision":"x".repeat(33)}),
            json!({"category":"anonymous","revision":"a8b123cd"}),
            json!({"category":"player-script","line":0}),
            json!({"category":"player-script","column":-1}),
            json!({"category":"player-script","line":9_007_199_254_740_992u64}),
            json!({"category":"player-script","line":"245"}),
        ] {
            let mut invalid = input.clone();
            invalid["control"]["frames"] = json!([bad]);
            assert!(playback_diagnostic(&invalid).is_none());
        }
        input["control"]["frames"] = json!(vec![json!({"category":"anonymous"}); 12]);
        assert!(playback_diagnostic(&input).is_some());
        input["control"]["frames"] = json!(vec![json!({"category":"anonymous"}); 13]);
        assert!(playback_diagnostic(&input).is_none());
    }
    #[test]
    fn append_parts_account_for_every_byte_and_require_final_counters() {
        let mut store = Store::default();
        record(
            &mut store,
            ID,
            message(1, part(0, 2, MAX_PART as u64 + 3, &vec![7; MAX_PART])),
        );
        assert_eq!(store.videos[ID].pending.len(), 1);
        record(
            &mut store,
            ID,
            message(2, part(1, 2, MAX_PART as u64 + 3, &[8, 9, 10])),
        );
        assert_eq!(store.videos[ID].pending.len(), 0);
        assert_eq!(store.videos[ID].appends, 1);
        assert_eq!(store.videos[ID].bytes, MAX_PART as u64 + 3);
        assert!(!store.videos[ID].documents["7-test-document"].final_marker);
        record(
            &mut store,
            ID,
            message(
                3,
                json!({"kind":"diagnostic","reason":"audit-pagehide","statistics":{"parts":2,"clocks":0,"dropped":0,"errors":0}}),
            ),
        );
        assert!(store.videos[ID].documents["7-test-document"].final_marker);
        assert_eq!(store.videos[ID].integrity_errors, 0);
    }
    #[test]
    fn loss_or_disk_budget_exhaustion_remains_explicitly_unmeasured() {
        let mut lost = Store::default();
        record(&mut lost, ID, message(2, part(0, 1, 3, &[1, 2, 3])));
        assert_eq!(lost.videos[ID].parts, 0);
        assert_eq!(lost.videos[ID].integrity_errors, 1);
        let mut bounded = Store {
            disk_bytes: MAX_DISK - 1,
            ..Default::default()
        };
        record(&mut bounded, ID, message(1, part(0, 1, 3, &[1, 2, 3])));
        assert_eq!(bounded.videos[ID].parts, 0);
        assert_eq!(bounded.videos[ID].pending.len(), 1);
        assert_eq!(bounded.disk_bytes, MAX_DISK - 1);
        assert_eq!(
            bounded.videos[ID].last_error.as_deref(),
            Some("process-disk-budget1GiB-exceeded")
        );
    }
    fn final_message(sequence: u64, request: &str, parts: u64) -> Message {
        message(
            sequence,
            json!({"kind":"diagnostic","reason":"audit-finalized","requestId":request,
            "statistics":{"appends":1,"bytes":3,"parts":parts,"clocks":0,"dropped":0,"errors":0}}),
        )
    }
    #[test]
    fn explicit_finalization_requires_bound_request_written_counters_and_no_late_records() {
        let mut store = Store::default();
        record(&mut store, ID, message(1, part(0, 1, 3, &[1, 2, 3])));
        store
            .videos
            .get_mut(ID)
            .unwrap()
            .finalizations
            .insert(7, "close-7-1".into());
        assert!(!has_finalization(&store.videos[ID], 7, "close-7-1"));
        record(&mut store, ID, final_message(2, "close-7-1", 1));
        assert!(has_finalization(&store.videos[ID], 7, "close-7-1"));
        assert!(!has_finalization(&store.videos[ID], 8, "close-7-1"));
        assert!(!has_finalization(&store.videos[ID], 7, "close-7-2"));
        record(
            &mut store,
            ID,
            message(3, json!({"kind":"clock","siteState":"content"})),
        );
        assert!(!has_finalization(&store.videos[ID], 7, "close-7-1"));
    }
    #[test]
    fn lost_append_or_final_write_cannot_acknowledge_orderly_close() {
        for missing in ["append", "write", "request"] {
            let mut store = Store::default();
            record(&mut store, ID, message(1, part(0, 1, 3, &[1, 2, 3])));
            store
                .videos
                .get_mut(ID)
                .unwrap()
                .finalizations
                .insert(7, "close-7-1".into());
            if missing == "write" {
                store.disk_bytes = MAX_DISK;
            }
            record(
                &mut store,
                ID,
                final_message(
                    2,
                    if missing == "request" {
                        "close-7-2"
                    } else {
                        "close-7-1"
                    },
                    if missing == "append" { 2 } else { 1 },
                ),
            );
            assert!(
                !has_finalization(&store.videos[ID], 7, "close-7-1"),
                "{missing}"
            );
            assert!(store.videos[ID].integrity_errors > 0, "{missing}");
        }
    }
    #[test]
    fn final_document_cannot_hide_a_previous_document_without_its_final_marker() {
        let mut store = Store::default();
        record(&mut store, ID, message(1, part(0, 1, 3, &[1, 2, 3])));
        store
            .videos
            .get_mut(ID)
            .unwrap()
            .finalizations
            .insert(7, "close-7-1".into());
        let mut next = message(1, part(0, 1, 3, &[1, 2, 3]));
        next.document_id = "second-document".into();
        record(&mut store, ID, next);
        let mut final_record = final_message(2, "close-7-1", 1);
        final_record.document_id = "second-document".into();
        record(&mut store, ID, final_record);
        assert!(!has_finalization(&store.videos[ID], 7, "close-7-1"));
        assert!(!store.videos[ID].documents["7-test-document"].final_marker);
        assert!(store.videos[ID].documents["7-second-document"].final_marker);
    }
    #[test]
    fn recorder_requires_the_official_origin_and_does_not_store_arbitrary_text() {
        assert!(origin("https://music.youtube.com/watch?v=jNY_wLukVW0"));
        assert!(origin("https://www.youtube.com/watch?v=jNY_wLukVW0"));
        for value in [
            "http://music.youtube.com",
            "https://music.youtube.com.attacker.invalid",
            "http://www.youtube.com",
            "https://www.youtube.com.attacker.invalid",
            "file:///tmp/audio",
        ] {
            assert!(!origin(value));
        }
        assert_eq!(
            safe_label(&Some("https://private.invalid/token".into())),
            None
        );
        assert_eq!(
            safe_label(&Some("audit-pagehide".into())),
            Some("audit-pagehide")
        );
        assert!(!token("../escape"));
    }
}
