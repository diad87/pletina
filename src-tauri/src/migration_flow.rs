//! User-controlled file and browser handoff for the native migration.

use crate::{db::Db, migration::export_native_migration};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

const MIGRATION_URL: &str = "https://pletina-app.tuqo.ru/?import=native";
const FILE_NAME: &str = "Pletina-biblioteca.json";
static SAVE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Deserialize)]
struct Summary {
    downloads: Vec<serde::de::IgnoredAny>,
    exclusions: BTreeMap<String, u64>,
}

#[derive(Serialize)]
pub(crate) struct SavedCopy {
    downloads: usize,
    exclusions: BTreeMap<String, u64>,
}

#[tauri::command]
pub(crate) async fn save_native_migration(
    db: State<'_, Db>,
    pins: Option<Value>,
    app: AppHandle,
) -> Result<Option<SavedCopy>, String> {
    let _guard = SAVE.try_lock().map_err(|_| "Ya hay una copia en curso.")?;
    let json = export_native_migration(db, pins).await?;
    let summary: Summary = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let saved = save_file(&app, json).await?;
    Ok(saved.then_some(SavedCopy {
        downloads: summary.downloads.len(),
        exclusions: summary.exclusions,
    }))
}

#[tauri::command]
pub(crate) async fn open_pwa_migration(app: AppHandle) -> Result<(), String> {
    app.opener()
        .open_url(MIGRATION_URL, None::<&str>)
        .map_err(|_| "No se pudo abrir el navegador.".into())
}

#[cfg(target_os = "android")]
struct AndroidMigration(tauri::plugin::PluginHandle<tauri::Wry>);

#[cfg(target_os = "android")]
pub(crate) fn android_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use tauri::Manager;
    tauri::plugin::Builder::new("musify-migration")
        .setup(|app, api| {
            let handle = api.register_android_plugin("dev.musify.desktop", "MigrationPlugin")?;
            app.manage(AndroidMigration(handle));
            Ok(())
        })
        .build()
}

#[cfg(target_os = "android")]
async fn save_file(app: &AppHandle, json: String) -> Result<bool, String> {
    use tauri::Manager;
    #[derive(Deserialize)]
    struct ResultPayload {
        saved: bool,
    }
    let plugin = app.state::<AndroidMigration>();
    plugin
        .0
        .run_mobile_plugin_async::<ResultPayload>(
            "saveLibrary",
            serde_json::json!({ "fileName": FILE_NAME, "json": json }),
        )
        .await
        .map(|result| result.saved)
        .map_err(|_| "No se pudo guardar y verificar la copia. Prueba otra carpeta.".into())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
async fn save_file(app: &AppHandle, json: String) -> Result<bool, String> {
    use std::io::{Read, Seek, Write};
    use tauri_plugin_dialog::DialogExt;

    let (send, receive) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Guardar copia de tu biblioteca")
        .set_file_name(FILE_NAME)
        .add_filter("Copia de Pletina (JSON)", &["json"])
        .save_file(move |file| {
            let _ = send.send(file);
        });
    let Some(destination) = receive.await.map_err(|e| e.to_string())? else {
        return Ok(false);
    };
    let path = destination.into_path().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || -> std::io::Result<()> {
        let mut file = tempfile::NamedTempFile::new_in(
            path.parent().ok_or_else(|| std::io::Error::other("Carpeta no válida"))?,
        )?;
        file.write_all(json.as_bytes())?;
        file.as_file().sync_all()?;
        file.rewind()?;
        let mut saved = Vec::new();
        file.read_to_end(&mut saved)?;
        if saved != json.as_bytes() {
            return Err(std::io::Error::other("La copia guardada no coincide"));
        }
        file.persist(path)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|_| "No se pudo guardar y verificar la copia. Prueba otra carpeta.".to_owned())?;
    Ok(true)
}

#[cfg(target_os = "ios")]
async fn save_file(_: &AppHandle, _: String) -> Result<bool, String> {
    Err("La exportación nativa no está disponible en iOS.".into())
}
