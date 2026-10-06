//! Motor propio, nivel garantizado: el reproductor oficial de YouTube Music en una ventana oculta.
//! Si una persona puede escuchar la canción en YouTube, ese reproductor tiene que pasarle el audio
//! al navegador, y ahí se copia (`capture.js`). No depende de clientes, PO tokens, firmas ni del
//! protocolo con el que YouTube sirva el audio.
//!
//! El audio llega a Rust por el canal nativo de la WebView (en Windows, `WebMessageReceived` de
//! WebView2), que solo existe en esa ventana: no hay ningún puerto ni protocolo abierto a la página.
//! La ventana no tiene permisos de Tauri (las capacidades son solo para "main").
//!
//! La ventana usa su propio perfil de WebView2 y, con él, su propio proceso navegador: si YouTube o
//! el navegador fallan ahí, la interfaz de Musify no se entera.

use base64::Engine;
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Prefijo de las ventanas del motor (cada canción tiene la suya: `yt-engine-1`, `yt-engine-2`...).
pub const LABEL: &str = "yt-engine";
/// Lo que se le pide al `<audio>` para sonar con lo capturado.
pub const SCHEME: &str = "musify-capture:";
const SCRIPT: &str = include_str!("capture.js");
/// Canciones capturadas que se guardan en memoria.
const KEEP: usize = 6;
/// Tope por canción (una de 10 minutos en opus son ~12 MB).
const MAX_BYTES: usize = 96 * 1024 * 1024;
/// Sin noticias de la ventana durante este tiempo mientras copia una canción: se da por colgada.
const STALL: Duration = Duration::from_secs(8);
/// Veces que se rehace la ventana para una misma canción antes de darla por imposible.
const MAX_RESETS: u8 = 3;

struct Track {
    opened: Instant,
    used: Instant,
    mime: String,
    /// Trozos en orden de llegada; cada buffer nuevo del reproductor empieza con su cabecera.
    chunks: Vec<Vec<u8>>,
    /// Formato de cada trozo: si la ventana se rehace, YouTube puede elegir otro (opus o AAC).
    mimes: Vec<String>,
    bytes: usize,
    ads: usize,
    title: String,
    author: String,
    duration: Option<f64>,
    first_ms: Option<u64>,
    playing_ms: Option<u64>,
    meta_ms: Option<u64>,
    done_ms: Option<u64>,
    error: Option<String>,
    /// Por qué se dio por terminada (para depurar).
    why: Option<String>,
    last_read: Option<Instant>,
    /// Último mensaje de la página (latido) y por dónde iba la canción.
    last_msg: Instant,
    position: f64,
    resets: u8,
}

impl Track {
    fn new() -> Self {
        let now = Instant::now();
        Self {
            opened: now,
            used: now,
            mime: String::new(),
            chunks: vec![],
            mimes: vec![],
            bytes: 0,
            ads: 0,
            title: String::new(),
            author: String::new(),
            duration: None,
            first_ms: None,
            playing_ms: None,
            meta_ms: None,
            done_ms: None,
            error: None,
            why: None,
            last_read: None,
            last_msg: now,
            position: 0.0,
            resets: 0,
        }
    }

    fn ms(&self) -> u64 {
        self.opened.elapsed().as_millis() as u64
    }

    /// Ya hay audio y se sabe qué es (título y duración), o lleva un rato llegando audio sin saberlo.
    fn ready(&self) -> bool {
        self.error.is_none()
            && self.first_ms.is_some_and(|first| self.meta_ms.is_some() || self.ms() > first + 1500)
    }
}

/// Canciones que han hecho falta capturar (para la interfaz y las mediciones).
pub static USED: AtomicU64 = AtomicU64::new(0);
static TRACKS: LazyLock<Mutex<HashMap<String, Track>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
/// Canción que tiene ahora la ventana oculta.
static CURRENT: Mutex<Option<String>> = Mutex::new(None);
static APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();
/// Ventana del motor que hay ahora (si hay) y contador para nombrar la siguiente.
static WINDOW: Mutex<Option<String>> = Mutex::new(None);
static SEQ: AtomicU64 = AtomicU64::new(1);

/// Metadatos de la canción capturada.
pub struct Meta {
    pub title: String,
    pub channel: Option<String>,
    pub duration: Option<f64>,
}

/// Pone la canción en el reproductor oficial y espera a que llegue su audio.
pub async fn stream(app: &AppHandle, video_id: &str, refresh: bool) -> Result<Meta, String> {
    if !valid_id(video_id) {
        return Err("id de vídeo no válido".into());
    }
    if !refresh
        && let Some(meta) = meta_if_usable(video_id)
    {
        return Ok(meta);
    }
    wait_turn(video_id).await;
    // Si ya hay parte copiada (y no se pide de nuevo), se sigue desde ahí.
    open(app, video_id, if refresh { None } else { resume_point(video_id) }).await?;
    USED.fetch_add(1, Ordering::Relaxed);

    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        tokio::time::sleep(Duration::from_millis(40)).await;
        // Otra canción se ha quedado la ventana antes de que esta tuviera audio (la que suena tiene
        // prioridad): se espera a que termine y se sigue donde se iba.
        if CURRENT.lock().unwrap().as_deref() != Some(video_id) {
            wait_free(video_id, deadline).await;
            open(app, video_id, resume_point(video_id)).await?;
        }
        {
            let tracks = TRACKS.lock().unwrap();
            let Some(t) = tracks.get(video_id) else { return Err("captura cancelada".into()) };
            if let Some(e) = &t.error {
                return Err(format!("Video unavailable: {e}"));
            }
            if t.ready() {
                return Ok(meta(t));
            }
        }
        if Instant::now() > deadline {
            return Err("YouTube no empezó a reproducirla".into());
        }
    }
}

fn meta(t: &Track) -> Meta {
    Meta {
        title: t.title.clone(),
        channel: (!t.author.is_empty()).then(|| t.author.clone()),
        duration: t.duration,
    }
}

/// Una captura ya hecha (o en curso y sin errores) se reutiliza.
fn meta_if_usable(video_id: &str) -> Option<Meta> {
    // Siempre en el mismo orden: primero CURRENT y luego TRACKS.
    let in_window = CURRENT.lock().unwrap().as_deref() == Some(video_id);
    let mut tracks = TRACKS.lock().unwrap();
    let t = tracks.get_mut(video_id)?;
    if t.ready() && (t.done_ms.is_some() || in_window) {
        t.used = Instant::now();
        return Some(meta(t));
    }
    None
}

/// Dónde seguir una captura empezada (si tiene algo).
fn resume_point(video_id: &str) -> Option<f64> {
    let tracks = TRACKS.lock().unwrap();
    tracks.get(video_id).filter(|t| !t.chunks.is_empty()).map(|t| (t.position - 2.0).max(0.0))
}

/// Espera a que la ventana quede libre: que la canción que tiene esté entera o haya fallado.
async fn wait_free(video_id: &str, deadline: Instant) {
    while Instant::now() < deadline {
        let busy = {
            let current = CURRENT.lock().unwrap().clone();
            let tracks = TRACKS.lock().unwrap();
            current
                .filter(|c| c != video_id)
                .and_then(|c| tracks.get(&c).map(|t| t.done_ms.is_none() && t.error.is_none()))
                .unwrap_or(false)
        };
        if !busy {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// La ventana solo copia una canción a la vez. No se interrumpe la que está sonando (alguien la
/// está leyendo y aún no está entera); una precarga que nadie escucha sí se puede interrumpir.
async fn wait_turn(video_id: &str) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        let busy = {
            let current = CURRENT.lock().unwrap().clone();
            let tracks = TRACKS.lock().unwrap();
            current.filter(|c| c != video_id).and_then(|c| tracks.get(&c).map(|t| (t.done_ms, t.error.clone(), t.last_read)))
        };
        match busy {
            Some((None, None, Some(read))) if read.elapsed() < Duration::from_millis(1500) => {
                tokio::time::sleep(Duration::from_millis(100)).await
            }
            _ => return,
        }
    }
}

/// Pone la canción en una ventana oculta nueva. Con `at`, sigue una captura ya empezada desde ese
/// segundo (lo capturado se conserva); sin él, empieza de cero.
///
/// Cada canción tiene su ventana: reutilizar la misma página de YouTube Music para varias acaba
/// colgándola (sobre todo tras saltos), y una ventana nueva cuesta lo mismo que navegar.
async fn open(app: &AppHandle, video_id: &str, at: Option<f64>) -> Result<(), String> {
    let _ = APP.set(app.clone());
    watchdog(app);
    {
        let mut tracks = TRACKS.lock().unwrap();
        match (at, tracks.get_mut(video_id)) {
            (Some(_), Some(t)) => {
                t.done_ms = None;
                t.why = None;
                t.last_msg = Instant::now();
            }
            _ => _ = tracks.insert(video_id.to_string(), Track::new()),
        }
        // Solo se guardan las últimas canciones.
        while tracks.len() > KEEP {
            let oldest = tracks.iter().min_by_key(|(_, t)| t.used).map(|(k, _)| k.clone()).unwrap();
            tracks.remove(&oldest);
        }
    }
    *CURRENT.lock().unwrap() = Some(video_id.to_string());
    // El segundo de inicio va en el fragmento: lo lee `capture.js`, YouTube no lo usa.
    let start = at.map(|s| format!("#musify-t={s:.1}")).unwrap_or_default();
    let url = format!("https://music.youtube.com/watch?v={video_id}{start}");
    reset(app).await;
    // Un nombre nuevo cada vez: así no choca con la anterior mientras termina de cerrarse.
    let label = format!("{LABEL}-{}", SEQ.fetch_add(1, Ordering::Relaxed));
    let profile = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("yt-engine");
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::External("about:blank".parse().unwrap()))
        .title("Musify · reproductor de YouTube")
        .data_directory(profile)
        .visible(std::env::var("MUSIFY_SHOW_ENGINE").is_ok())
        .skip_taskbar(true)
        .focused(false)
        .inner_size(960.0, 640.0)
        .initialization_script(SCRIPT)
        .build()
        .map_err(|e| e.to_string())?;
    *WINDOW.lock().unwrap() = Some(label);
    // El canal nativo se engancha antes de abrir YouTube para no perder los primeros trozos.
    window
        .with_webview(move |pw| {
            #[cfg(windows)]
            if let Err(e) = unsafe { attach(&pw, &url) } {
                eprintln!("[captura] no se pudo preparar la ventana: {e}");
            }
            #[cfg(not(windows))]
            let _ = (pw, url);
        })
        .map_err(|e| e.to_string())
}

#[cfg(windows)]
unsafe fn attach(pw: &tauri::webview::PlatformWebview, url: &str) -> windows_core::Result<()> {
    use webview2_com::{WebMessageReceivedEventHandler, take_pwstr};
    use windows_core::{HSTRING, PWSTR};
    unsafe {
        let controller = pw.controller();
        let core = controller.CoreWebView2()?;
        let handler = WebMessageReceivedEventHandler::create(Box::new(|_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut source = PWSTR::null();
            args.Source(&mut source)?;
            // Solo mensajes de texto que empiezan por "musify:" (ver `capture.js`).
            let mut text = PWSTR::null();
            if args.TryGetWebMessageAsString(&mut text).is_ok() {
                let text = take_pwstr(text);
                if let Some(json) = text.strip_prefix("musify:") {
                    receive(&take_pwstr(source), json);
                }
            }
            Ok(())
        }));
        let mut token = 0i64;
        core.add_WebMessageReceived(&handler, &mut token)?;
        // La ventana está oculta, pero la página tiene que creerse visible: si no, el navegador
        // frena sus temporizadores y el reproductor se para.
        controller.SetIsVisible(true)?;
        core.Navigate(&HSTRING::from(url))
    }
}

#[derive(Deserialize)]
struct Message {
    musify: u8,
    v: Option<String>,
    kind: String,
    // Trozo de audio.
    s: Option<u32>,
    mime: Option<String>,
    ad: Option<bool>,
    data: Option<String>,
    // Evento.
    #[serde(rename = "type")]
    event: Option<String>,
    duration: Option<f64>,
    title: Option<String>,
    author: Option<String>,
    reason: Option<String>,
    why: Option<String>,
    position: Option<f64>,
}

/// Mensaje de `capture.js`. Solo se aceptan de YouTube Music y de su página de cookies.
fn receive(source: &str, json: &str) {
    if !(source.starts_with("https://music.youtube.com/") || source.starts_with("https://consent.youtube.com/")) {
        return;
    }
    let Ok(m) = serde_json::from_str::<Message>(json) else { return };
    let Some(id) = m.v.filter(|_| m.musify == 1) else { return };
    let mut tracks = TRACKS.lock().unwrap();
    let Some(t) = tracks.get_mut(&id) else { return };
    let ms = t.ms();
    t.last_msg = Instant::now();
    match m.kind.as_str() {
        "seg" if source.starts_with("https://music.youtube.com/") => {
            if m.ad.unwrap_or(false) {
                t.ads += 1;
                return;
            }
            let Some(bytes) = m.data.and_then(|d| base64::engine::general_purpose::STANDARD.decode(d).ok()) else { return };
            if t.bytes + bytes.len() > MAX_BYTES {
                return;
            }
            let mime = m.mime.unwrap_or_default();
            if t.mime.is_empty() {
                t.mime = mime.clone();
            }
            let _ = m.s;
            t.bytes += bytes.len();
            t.chunks.push(bytes);
            t.mimes.push(mime);
            t.first_ms.get_or_insert(ms);
        }
        "event" => match m.event.as_deref() {
            Some(kind @ ("playing" | "meta" | "ended")) => {
                match kind {
                    "playing" => _ = t.playing_ms.get_or_insert(ms),
                    "meta" => _ = t.meta_ms.get_or_insert(ms),
                    _ => {
                        t.done_ms.get_or_insert(ms);
                        t.why = m.why;
                        close_when_idle(id.clone());
                    }
                }
                t.duration = m.duration.filter(|d| d.is_finite() && *d > 0.0).or(t.duration);
                if let Some(title) = m.title.filter(|s| !s.is_empty()) {
                    t.title = title;
                }
                if let Some(author) = m.author.filter(|s| !s.is_empty()) {
                    t.author = author;
                }
            }
            Some("error") => t.error = Some(m.reason.unwrap_or_else(|| "YouTube no puede reproducirla".into())),
            // Latido: la página sigue viva (y por dónde va, si suena nuestra canción).
            Some("progress") => {
                if let Some(p) = m.position.filter(|p| p.is_finite()) {
                    t.position = p;
                }
            }
            _ => {}
        },
        _ => {}
    }
}

/// Vigila la ventana oculta: si deja de dar señales mientras copia una canción (la página se ha
/// colgado), la destruye, crea otra y sigue desde donde iba. Así un fallo del navegador o de
/// YouTube no deja la canción a medias.
fn watchdog(app: &AppHandle) {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::Relaxed) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let Some(id) = CURRENT.lock().unwrap().clone() else { continue };
            let resume = {
                let mut tracks = TRACKS.lock().unwrap();
                let Some(t) = tracks.get_mut(&id) else { continue };
                if t.done_ms.is_some() || t.error.is_some() || t.last_msg.elapsed() < STALL {
                    continue;
                }
                if t.resets >= MAX_RESETS {
                    t.error = Some("El reproductor de YouTube se quedó colgado".into());
                    continue;
                }
                t.resets += 1;
                (t.position - 2.0).max(0.0)
            };
            eprintln!("[captura] {id}: la ventana no responde; se rehace y sigue en {resume:.0} s");
            let _ = open(&app, &id, Some(resume)).await;
        }
    });
}

/// La canción ya está entera: si en un par de segundos no se pide otra, se cierra la ventana para
/// no gastar memoria (la página de YouTube Music ocupa cientos de MB).
fn close_when_idle(id: String) {
    let Some(app) = APP.get().cloned() else { return };
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let idle = CURRENT.lock().unwrap().as_deref() == Some(id.as_str())
            && TRACKS.lock().unwrap().get(&id).is_some_and(|t| t.done_ms.is_some());
        if idle {
            reset(&app).await;
        }
    });
}

/// La ventana del motor que hay ahora.
fn engine_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    let label = WINDOW.lock().unwrap().clone()?;
    app.get_webview_window(&label)
}

/// Cierra la ventana oculta (y su página, aunque esté colgada). Primero la deja en blanco, para que
/// no se cierre con YouTube a medias (WebView2 a veces falla si se cierra con un vídeo sonando).
async fn reset(app: &AppHandle) {
    let Some(label) = WINDOW.lock().unwrap().take() else { return };
    let Some(w) = app.get_webview_window(&label) else { return };
    let _ = w.navigate("about:blank".parse().unwrap());
    tokio::time::sleep(Duration::from_millis(300)).await;
    let _ = w.destroy();
    for _ in 0..50 {
        if app.get_webview_window(&label).is_none() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// El `<audio>` necesita una parte que aún no se ha capturado (un salto, o un hueco porque YouTube
/// pasó a otra canción antes de tiempo): el reproductor oficial va a ese punto. Si la canción sigue
/// en la ventana oculta, salta ahí mismo; si no, se vuelve a abrir desde ese segundo.
#[tauri::command]
pub async fn capture_seek(app: AppHandle, video_id: String, at: f64) -> Result<(), String> {
    if !valid_id(&video_id) || !at.is_finite() || at < 0.0 {
        return Err("salto no válido".into());
    }
    let capturing = {
        let current = CURRENT.lock().unwrap();
        let tracks = TRACKS.lock().unwrap();
        current.as_deref() == Some(video_id.as_str()) && tracks.get(&video_id).is_some_and(|t| t.done_ms.is_none())
    };
    match engine_window(&app) {
        Some(w) if capturing => w.eval(format!("window.__musifySeek?.({at:.1})")).map_err(|e| e.to_string()),
        _ => open(&app, &video_id, Some(at)).await,
    }
}

/// Lo capturado de una canción a partir del trozo `from`, para el reproductor (Media Source).
/// Si aún no hay nada nuevo, espera un poco. Formato: 4 bytes (u32 LE) con el tamaño de una
/// cabecera JSON, la cabecera, y cada trozo como 4 bytes de tamaño + bytes.
#[tauri::command]
pub async fn capture_read(video_id: String, from: usize) -> Result<tauri::ipc::Response, String> {
    let deadline = Instant::now() + Duration::from_millis(1500);
    loop {
        {
            let mut tracks = TRACKS.lock().unwrap();
            let t = tracks.get_mut(&video_id).ok_or("No hay captura de esa canción")?;
            t.last_read = Some(Instant::now());
            t.used = Instant::now();
            let done = t.done_ms.is_some();
            if t.chunks.len() > from || done || t.error.is_some() || Instant::now() > deadline {
                let chunks = t.chunks.get(from..).unwrap_or_default();
                let head = json!({
                    "mime": t.mime,
                    "mimes": t.mimes.get(from..).unwrap_or_default(),
                    "duration": t.duration,
                    "done": done,
                    "error": t.error,
                    "next": from + chunks.len(),
                })
                .to_string();
                let mut out = Vec::with_capacity(4 + head.len() + chunks.iter().map(|c| c.len() + 4).sum::<usize>());
                out.extend((head.len() as u32).to_le_bytes());
                out.extend(head.as_bytes());
                for c in chunks {
                    out.extend((c.len() as u32).to_le_bytes());
                    out.extend(c);
                }
                return Ok(tauri::ipc::Response::new(out));
            }
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

/// Estado de una captura (para las mediciones).
pub fn status(video_id: &str) -> Option<serde_json::Value> {
    let tracks = TRACKS.lock().unwrap();
    let t = tracks.get(video_id)?;
    Some(json!({
        "mime": t.mime,
        "chunks": t.chunks.len(),
        "bytes": t.bytes,
        "ads": t.ads,
        "duration": t.duration,
        "firstMs": t.first_ms,
        "playingMs": t.playing_ms,
        "metaMs": t.meta_ms,
        "title": t.title,
        "doneMs": t.done_ms,
        "error": t.error,
        "why": t.why,
        "resets": t.resets,
    }))
}

fn valid_id(id: &str) -> bool {
    id.len() == 11 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_youtube_messages() {
        TRACKS.lock().unwrap().insert("aaaaaaaaaaa".into(), Track::new());
        let seg = r#"{"musify":1,"v":"aaaaaaaaaaa","kind":"seg","s":1,"mime":"audio/webm","ad":false,"data":"GkXfow=="}"#;
        receive("https://evil.example/", seg);
        receive("https://consent.youtube.com/", seg);
        assert_eq!(TRACKS.lock().unwrap()["aaaaaaaaaaa"].chunks.len(), 0);
        receive("https://music.youtube.com/watch?v=aaaaaaaaaaa", seg);
        let ad = seg.replace(r#""ad":false"#, r#""ad":true"#);
        receive("https://music.youtube.com/watch?v=aaaaaaaaaaa", &ad);
        let t = &TRACKS.lock().unwrap()["aaaaaaaaaaa"];
        assert_eq!((t.chunks.len(), t.ads), (1, 1));
        assert_eq!(t.chunks[0], [0x1a, 0x45, 0xdf, 0xa3]);
    }
}
