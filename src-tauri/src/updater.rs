//! Actualizaciones automáticas: busca versión nueva al arrancar y cada 6 horas, la descarga
//! en segundo plano y la instala al cerrar la app (o al momento con "Reiniciar").
//! Las versiones van firmadas; la app solo instala las firmadas con nuestra clave.

use serde::Serialize;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const FIRST_CHECK: Duration = Duration::from_secs(10);
const CHECK_EVERY: Duration = Duration::from_secs(6 * 3600);

/// Actualización ya descargada, esperando a instalarse.
#[derive(Default)]
pub struct Pending(Mutex<Option<(Update, Vec<u8>)>>);

/// Evento "update" para la interfaz.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateEvent {
    /// "downloading" | "ready"
    state: &'static str,
    version: String,
    notes: Option<String>,
}

pub fn start(app: &AppHandle) {
    // En desarrollo no tiene sentido: la versión "instalada" es la carpeta del proyecto.
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            if let Err(e) = check(&app).await {
                eprintln!("[updater] {e}");
            }
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

async fn check(app: &AppHandle) -> Result<(), String> {
    if app.state::<Pending>().0.lock().unwrap().is_some() {
        return Ok(());
    }
    let Some(update) = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())? else {
        return Ok(());
    };
    let event = |state| UpdateEvent { state, version: update.version.clone(), notes: update.body.clone() };
    let _ = app.emit("update", event("downloading"));
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    let _ = app.emit("update", event("ready"));
    *app.state::<Pending>().0.lock().unwrap() = Some((update, bytes));
    Ok(())
}

/// Instala la actualización descargada, si la hay. En Windows lanza el instalador (en silencio)
/// y la app se cierra; en Mac y Linux sustituye la app y la nueva arranca la próxima vez.
pub fn install_pending(app: &AppHandle) -> bool {
    let Some((update, bytes)) = app.state::<Pending>().0.lock().unwrap().take() else { return false };
    match update.install(bytes) {
        Ok(()) => true,
        Err(e) => {
            eprintln!("[updater] no se pudo instalar: {e}");
            false
        }
    }
}

/// Solo para el móvil (ver updater_mobile.rs): en el escritorio el actualizador avisa con eventos.
#[tauri::command]
pub async fn newer_version() -> Option<String> {
    None
}

/// Botón "Reiniciar" de la interfaz: instala ya y vuelve a abrir la app.
#[tauri::command]
pub fn install_update(app: AppHandle) -> Result<(), String> {
    if !install_pending(&app) {
        return Err("No hay ninguna actualización lista".into());
    }
    app.restart();
}

/// Abre en el navegador la página de la última versión (para bajar el APK sin Obtainium).
#[tauri::command]
pub fn open_releases(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url("https://github.com/diad87/musify-releases/releases/latest", None::<&str>)
        .map_err(|e| e.to_string())
}
