//! En el móvil la app se actualiza con Obtainium (ver docs/plan-mobile.md), no con el
//! actualizador de Tauri (`updater.rs`): mismas funciones, sin hacer nada.

use tauri::AppHandle;

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
