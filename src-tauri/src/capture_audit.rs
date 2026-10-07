//! Private bounded benchmark evidence. This recorder never supplies playback data
//! or classifies an advertisement. Missing/truncated evidence stays unmeasured.
use base64::Engine;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

const MAX_DISK: u64 = 1024 * 1024 * 1024;
const MAX_PART: usize = 128 * 1024;
#[derive(Default)]
struct Document {
    sequence: u64,
    parts: u64,
    clocks: u64,
    js_dropped: u64,
    final_marker: bool,
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
    reqwest::Url::parse(value)
        .ok()
        .is_some_and(|url| url.scheme() == "https" && url.host_str() == Some("music.youtube.com"))
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
    statistics: Option<Statistics>,
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
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "musify-capture-audit-{}-{stamp}.local",
        std::process::id()
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
            if let Some(stats) = message.statistics {
                let document = audit.documents.get_mut(&document_key).unwrap();
                if stats.parts != document.parts || stats.clocks != document.clocks {
                    audit.integrity_errors += 1;
                    audit.last_error = Some("javascript-native-counter-mismatch".into());
                }
                audit.dropped += stats.dropped.saturating_sub(document.js_dropped);
                document.js_dropped = stats.dropped;
                document.final_marker = message.reason.as_deref() == Some("audit-pagehide")
                    && stats.parts == document.parts
                    && stats.clocks == document.clocks
                    && stats.dropped == 0
                    && stats.errors == 0;
                metadata["statistics"] = json!({"parts":stats.parts,"clocks":stats.clocks,"dropped":stats.dropped,"errors":stats.errors});
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
                audit.pending.remove(&key);
            } else {
                fail(audit, "incomplete-audio-append");
                return;
            }
        }
        audit.parts += 1;
        audit.bytes += bytes.len() as u64;
        audit.documents.get_mut(&document_key).unwrap().parts += 1;
    }
    if message.kind == "clock" {
        audit.clocks += 1;
        audit.documents.get_mut(&document_key).unwrap().clocks += 1;
    }
    if message.kind == "mutation" {
        audit.mutations += 1;
    }
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

/// Call when a native benchmark window is retired. Without its final JS counters,
/// losing an ENTIRE last append is undetectable from part sequence numbers alone.
pub fn close_session(video_id: &str, generation: u64) {
    if !enabled() {
        return;
    }
    let mut store = STORE.lock().unwrap();
    if let Some(audit) = store.videos.get_mut(video_id) {
        let prefix = format!("{generation}-");
        if audit
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
    #[test]
    fn recorder_requires_the_official_origin_and_does_not_store_arbitrary_text() {
        assert!(origin("https://music.youtube.com/watch?v=jNY_wLukVW0"));
        for value in [
            "http://music.youtube.com",
            "https://music.youtube.com.attacker.invalid",
            "https://www.youtube.com",
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
