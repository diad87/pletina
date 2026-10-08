//! Contrato P1 para móvil, sin ventanas ni almacenamiento de captura oficial.
//! Las operaciones de audio fallan explícitamente; no se fabrican unidades, EOF
//! ni evidencia de autenticación. El motor directo del móvil es independiente.

use crate::player::{ForegroundAdmission, RequestTicket};
use serde::Serialize;
use serde_json::{Value, json};
use std::sync::atomic::AtomicU64;
use tauri::AppHandle;

pub const SCHEME: &str = "musify-capture:";
pub static USED: AtomicU64 = AtomicU64::new(0);
const UNAVAILABLE: &str =
    "CAPTURE_UNSUPPORTED_PLATFORM: la captura oficial no está disponible en móvil";

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureLimits {
    pub max_sessions: usize,
    pub prefetch_slots: usize,
    pub track_bytes: usize,
    pub total_bytes: usize,
}

pub fn limits() -> Result<CaptureLimits, String> {
    Ok(CaptureLimits {
        max_sessions: 0,
        prefetch_slots: 0,
        track_bytes: 0,
        total_bytes: 0,
    })
}

#[tauri::command]
pub fn capture_limits() -> Result<CaptureLimits, String> {
    limits()
}

// Se conserva la firma común sin crear ni reutilizar un perfil del navegador.
#[allow(dead_code)]
pub fn profile_directory(_app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Err(UNAVAILABLE.into())
}

#[tauri::command]
pub fn capture_profile_status() -> Value {
    json!({
        "available": false,
        "error": UNAVAILABLE,
        "sessionState": null,
        "loggedIn": null,
    })
}

#[tauri::command]
pub async fn capture_profile_open(app: AppHandle, mode: String) -> Result<Value, String> {
    let _ = (app, mode);
    Err(UNAVAILABLE.into())
}

pub struct Meta {
    pub title: String,
    pub channel: Option<String>,
    pub duration: Option<f64>,
}

pub async fn stream_with_priority(
    _app: &AppHandle,
    _video_id: &str,
    _refresh: bool,
    _foreground: bool,
    _ticket: Option<RequestTicket>,
    _admission: Option<ForegroundAdmission>,
) -> Result<Meta, String> {
    Err(UNAVAILABLE.into())
}

#[tauri::command]
pub async fn capture_cancel(
    app: AppHandle,
    video_id: String,
    generation: Option<u64>,
) -> Result<(), String> {
    let _ = (app, video_id, generation);
    Ok(())
}

pub async fn cancel_before(_app: &AppHandle, _ticket: u64) -> Result<(), String> {
    Ok(())
}

pub async fn cancel_next_before(
    _app: &AppHandle,
    _prefetch: u64,
    _next_slot: Option<u8>,
) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn capture_show(app: AppHandle) -> Result<(), String> {
    let _ = app;
    Err(UNAVAILABLE.into())
}

#[tauri::command]
pub async fn capture_begin(
    app: AppHandle,
    video_id: String,
    foreground: Option<bool>,
    refresh: Option<bool>,
    next_slot: Option<u8>,
) -> Result<Value, String> {
    let _ = (app, video_id, foreground, refresh, next_slot);
    Err(UNAVAILABLE.into())
}

#[tauri::command]
pub async fn capture_prefetch(
    app: AppHandle,
    video_id: String,
    next_slot: Option<u8>,
) -> Result<Value, String> {
    let _ = (app, video_id, next_slot);
    Err(UNAVAILABLE.into())
}

pub async fn bench_forget(_app: &AppHandle, _video_id: &str) -> Result<(), String> {
    Err(UNAVAILABLE.into())
}

#[tauri::command]
pub async fn capture_seek(
    app: AppHandle,
    video_id: String,
    at: f64,
    generation: Option<u64>,
    request_id: Option<u64>,
) -> Result<Value, String> {
    let _ = (app, video_id, at, generation, request_id);
    Err(UNAVAILABLE.into())
}

#[tauri::command]
pub async fn capture_read(
    video_id: String,
    from: usize,
    revision: Option<u64>,
) -> Result<tauri::ipc::Response, String> {
    let _ = (video_id, from, revision);
    Err(UNAVAILABLE.into())
}

pub fn status(_video_id: &str) -> Option<Value> {
    None
}

pub fn bench_snapshot(_video_id: &str) -> Result<Value, String> {
    Err(UNAVAILABLE.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mobile_does_not_advertise_capture_or_manufacture_evidence() {
        let capacity = serde_json::to_value(capture_limits().unwrap()).unwrap();
        assert_eq!(
            capacity,
            json!({
                "maxSessions": 0, "prefetchSlots": 0, "trackBytes": 0, "totalBytes": 0,
            })
        );
        assert!(status("jNY_wLukVW0").is_none());
        let profile = capture_profile_status();
        assert_eq!(profile["available"], false);
        assert!(profile["sessionState"].is_null());
        assert!(profile["loggedIn"].is_null());
        assert!(profile.get("complete").is_none());
        assert!(profile.get("eof").is_none());
        assert_eq!(bench_snapshot("jNY_wLukVW0").unwrap_err(), UNAVAILABLE);
        assert_eq!(
            capture_read("jNY_wLukVW0".into(), 0, Some(1))
                .await
                .err()
                .as_deref(),
            Some(UNAVAILABLE),
        );
        assert_eq!(USED.load(std::sync::atomic::Ordering::Relaxed), 0);
    }
}
