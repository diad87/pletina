//! En el móvil no hay ventana oculta con el reproductor oficial (ver `capture.rs` y
//! docs/plan-mobile.md): mismas funciones, que responden que no está disponible.

use std::sync::atomic::AtomicU64;
use tauri::AppHandle;

pub const SCHEME: &str = "musify-capture:";
pub static USED: AtomicU64 = AtomicU64::new(0);
const UNAVAILABLE: &str = "La ventana oculta del motor propio solo existe en escritorio";

pub struct Meta {
    pub title: String,
    pub channel: Option<String>,
    pub duration: Option<f64>,
}

pub async fn stream(_app: &AppHandle, _video_id: &str, _refresh: bool) -> Result<Meta, String> {
    Err(UNAVAILABLE.into())
}

pub fn status(_video_id: &str) -> Option<serde_json::Value> {
    None
}

#[tauri::command]
pub async fn capture_read(video_id: String, from: usize) -> Result<tauri::ipc::Response, String> {
    let _ = (video_id, from);
    Err(UNAVAILABLE.into())
}

#[tauri::command]
pub async fn capture_seek(video_id: String, at: f64) -> Result<(), String> {
    let _ = (video_id, at);
    Err(UNAVAILABLE.into())
}
