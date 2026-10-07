//! En el móvil la app se actualiza con Obtainium (ver docs/plan-mobile.md), no con el
//! actualizador de Tauri (`updater.rs`). Aquí solo se mira si hay una versión nueva publicada, para
//! avisar en la interfaz.

use std::time::Duration;
use tauri::AppHandle;

/// El mismo índice que usa el actualizador de escritorio (ver tauri.conf.json).
const LATEST: &str = "https://github.com/diad87/pletina-releases/releases/latest/download/latest.json";

#[derive(Default)]
pub struct Pending;

pub fn start(_app: &AppHandle) {}

pub fn install_pending(_app: &AppHandle) -> bool {
    false
}

#[tauri::command]
pub fn install_update(_app: AppHandle) -> Result<(), String> {
    Err("En el móvil la app se actualiza con Obtainium".into())
}

/// La versión publicada, si es más nueva que la instalada. Sin red o sin publicar, nada.
#[tauri::command]
pub async fn newer_version(app: AppHandle) -> Option<String> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(20)).build().ok()?;
    let text = client.get(LATEST).send().await.ok()?.error_for_status().ok()?.text().await.ok()?;
    let latest: serde_json::Value = serde_json::from_str(&text).ok()?;
    let latest = latest["version"].as_str()?.trim_start_matches('v').to_string();
    let current = app.package_info().version.to_string();
    (numbers(&latest) > numbers(&current)).then_some(latest)
}

/// "0.10.2" → [0, 10, 2], para comparar versiones como números.
fn numbers(version: &str) -> Vec<u64> {
    version.split(['.', '-', '+']).map_while(|n| n.parse().ok()).collect()
}

/// Abre en el navegador la página de la última versión (para bajar el APK sin Obtainium).
#[tauri::command]
pub fn open_releases(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url("https://github.com/diad87/pletina-releases/releases/latest", None::<&str>)
        .map_err(|e| e.to_string())
}
