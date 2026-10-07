//! Silence only the native acquisition WebView, before it can load remote media.
//! This does not mute the main Musify WebView or change media playback/clock state.

#[cfg(windows)]
pub unsafe fn enforce(
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
) -> windows_core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_8;
    use windows_core::{BOOL, Error, HRESULT, Interface};

    unsafe {
        let audio: ICoreWebView2_8 = core.cast().map_err(|error: Error| {
            Error::new(
                error.code(),
                "CAPTURE_NATIVE_MUTE: native audio muting is unavailable",
            )
        })?;
        audio.SetIsMuted(true).map_err(|error| {
            Error::new(
                error.code(),
                "CAPTURE_NATIVE_MUTE: native audio muting failed",
            )
        })?;
        let mut muted = BOOL::default();
        audio.IsMuted(&mut muted).map_err(|error| {
            Error::new(
                error.code(),
                "CAPTURE_NATIVE_MUTE: native mute state could not be read",
            )
        })?;
        if !muted.as_bool() {
            return Err(Error::new(
                HRESULT(0x80004005u32 as i32),
                "CAPTURE_NATIVE_MUTE: native audio remained unmuted",
            ));
        }
    }
    if std::env::var_os("MUSIFY_BENCH").is_some() {
        eprintln!("[capture-mute] native IsMuted=true");
    }
    Ok(())
}

/// Recheck a previously created manual acquisition window before showing it.
pub async fn enforce_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    window
        .with_webview(move |platform| {
            #[cfg(windows)]
            let result = unsafe {
                platform
                    .controller()
                    .CoreWebView2()
                    .and_then(|core| enforce(&core))
            }
            .map_err(|error| error.to_string());
            #[cfg(not(windows))]
            let result: Result<(), String> = {
                let _ = platform;
                Err("CAPTURE_NATIVE_MUTE: unsupported platform".into())
            };
            let _ = tx.send(result);
        })
        .map_err(|error| format!("CAPTURE_NATIVE_MUTE: {error}"))?;
    tokio::time::timeout(std::time::Duration::from_secs(10), rx)
        .await
        .map_err(|_| "CAPTURE_NATIVE_MUTE: native mute check timed out".to_string())?
        .map_err(|_| "CAPTURE_NATIVE_MUTE: native mute check was closed".to_string())?
}
