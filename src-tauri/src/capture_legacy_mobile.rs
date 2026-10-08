//! Respaldo histórico de P1 en móvil: conserva las firmas pero no abre ventanas.
//! Un fallo del motor directo no se presenta como una captura o un EOF válidos.

use crate::player::RequestTicket;
use std::sync::atomic::AtomicU64;
use tauri::AppHandle;

pub const SCHEME: &str = "musify-capture-legacy:";
pub static USED: AtomicU64 = AtomicU64::new(0);
const UNAVAILABLE: &str =
    "CAPTURE_UNSUPPORTED_PLATFORM: el respaldo de captura histórico no está disponible en móvil";

pub struct Meta {
    pub title: String,
    pub channel: Option<String>,
    pub duration: Option<f64>,
}

pub async fn stream(
    _app: &AppHandle,
    _video_id: &str,
    _refresh: bool,
    _foreground: bool,
    _ticket: Option<RequestTicket>,
) -> Result<Meta, String> {
    Err(UNAVAILABLE.into())
}

#[tauri::command]
pub async fn capture_legacy_cancel(
    app: AppHandle,
    video_id: String,
    generation: Option<u64>,
) -> Result<(), String> {
    let _ = (app, video_id, generation);
    Ok(())
}

pub async fn cancel_before(_app: &AppHandle, _resolution: u64) -> Result<(), String> {
    Ok(())
}

pub async fn cancel_next_before(_app: &AppHandle, _prefetch: u64) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn capture_legacy_seek(
    app: AppHandle,
    video_id: String,
    at: f64,
    generation: Option<u64>,
) -> Result<(), String> {
    let _ = (app, video_id, at, generation);
    Err(UNAVAILABLE.into())
}

#[tauri::command]
pub async fn capture_legacy_read(
    video_id: String,
    from: usize,
) -> Result<tauri::ipc::Response, String> {
    let _ = (video_id, from);
    Err(UNAVAILABLE.into())
}

#[allow(dead_code)]
pub fn status(_video_id: &str) -> Option<serde_json::Value> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mobile_legacy_never_returns_audio_or_completion() {
        assert!(status("jNY_wLukVW0").is_none());
        assert_eq!(
            capture_legacy_read("jNY_wLukVW0".into(), 0)
                .await
                .err()
                .as_deref(),
            Some(UNAVAILABLE),
        );
        assert_eq!(USED.load(std::sync::atomic::Ordering::Relaxed), 0);
    }
}
