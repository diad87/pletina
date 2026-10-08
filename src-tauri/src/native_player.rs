//! Android: la interfaz manda órdenes al reproductor nativo (servicio de música con ExoPlayer) a
//! través de un plugin de Kotlin (`PlayerPlugin.kt`). Las respuestas y el estado vuelven como
//! eventos "player-state" (ver `MusifyCore.emit` en android.rs). En escritorio no existe: la
//! interfaz usa su propio reproductor.

use serde_json::Value;

#[cfg(target_os = "android")]
pub struct NativePlayer(tauri::plugin::PluginHandle<tauri::Wry>);

/// Registra el plugin de Kotlin.
#[cfg(target_os = "android")]
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use tauri::Manager;
    tauri::plugin::Builder::new("musify-player")
        .setup(|app, api| {
            let handle = api.register_android_plugin("dev.musify.desktop", "PlayerPlugin")?;
            app.manage(NativePlayer(handle));
            Ok(())
        })
        .build()
}

/// Una orden para el reproductor nativo (`play`, `setQueue`, `insert`...) con sus datos.
#[cfg(target_os = "android")]
#[tauri::command]
pub async fn player_native(cmd: String, args: Value, app: tauri::AppHandle) -> Result<Value, String> {
    use tauri::Manager;
    let player = app.try_state::<NativePlayer>().ok_or("el reproductor nativo no está listo")?;
    player.0.run_mobile_plugin::<Value>(&cmd, args).map_err(|e| e.to_string())
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn player_native(cmd: String, args: Value) -> Result<Value, String> {
    let _ = (cmd, args);
    Err("El reproductor nativo solo existe en Android".into())
}
