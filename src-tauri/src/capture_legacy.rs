//! Respaldo histórico de Propio, conservado desde cd78554 mientras se valida API 3.
//! Si una persona puede escuchar la canción en YouTube, ese reproductor tiene que pasarle el audio
//! al navegador, y ahí se copia (`capture-legacy.js`). No depende de clientes, PO tokens, firmas ni del
//! protocolo con el que YouTube sirva el audio.
//!
//! El audio llega a Rust por el canal nativo de la WebView (en Windows, `WebMessageReceived` de
//! WebView2), que solo existe en esa ventana: no hay ningún puerto ni protocolo abierto a la página.
//! La ventana no tiene permisos de Tauri (las capacidades son solo para "main").
//!
//! La ventana usa su propio perfil de WebView2 y, con él, su propio proceso navegador: si YouTube o
//! el navegador fallan ahí, la interfaz de Musify no se entera.

use crate::player::RequestTicket;
use base64::Engine;
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Prefijo de las ventanas del motor (cada canción tiene la suya: `yt-engine-1`, `yt-engine-2`...).
pub const LABEL: &str = "yt-engine-legacy";
/// Lo que se le pide al `<audio>` para sonar con lo capturado.
pub const SCHEME: &str = "musify-capture-legacy:";
/// Canciones capturadas que se guardan en memoria.
const KEEP: usize = 6;
/// Tope por canción (una de 10 minutos en opus son ~12 MB).
const MAX_BYTES: usize = 96 * 1024 * 1024;
/// Sin noticias de la ventana durante este tiempo mientras copia una canción: se da por colgada.
const STALL: Duration = Duration::from_secs(8);
/// Veces que se rehace la ventana para una misma canción antes de darla por imposible.
const MAX_RESETS: u8 = 3;

struct Track {
    generation: u64,
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
            generation: 0,
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
            && self
                .first_ms
                .is_some_and(|first| self.meta_ms.is_some() || self.ms() > first + 1500)
    }
}

/// Canciones que han hecho falta capturar (para la interfaz y las mediciones).
pub static USED: AtomicU64 = AtomicU64::new(0);
static TRACKS: LazyLock<Mutex<HashMap<String, Track>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
#[derive(Clone)]
struct Session {
    id: String,
    generation: u64,
    label: String,
    foreground: bool,
    ticket: Option<RequestTicket>,
    active: bool,
}
#[derive(Default)]
struct Control {
    session: Option<Session>,
    foreground: Option<(String, Option<RequestTicket>)>,
    cancellations: HashMap<String, u64>,
}
impl Control {
    fn owns(&self, id: &str, generation: u64) -> bool {
        self.session
            .as_ref()
            .is_some_and(|s| s.active && s.id == id && s.generation == generation)
    }
    fn may_replace(&self, id: &str, foreground: bool, finished: bool) -> bool {
        self.session
            .as_ref()
            .is_none_or(|s| !s.active || s.id == id || foreground || !s.foreground || finished)
    }
    fn cancellation(&self, id: &str) -> u64 {
        self.cancellations.get(id).copied().unwrap_or(0)
    }
    fn release(&mut self, id: &str) {
        if self
            .foreground
            .as_ref()
            .is_some_and(|(current, _)| current == id)
        {
            self.foreground = None;
        }
    }
    fn promote(&mut self, id: &str, ticket: Option<RequestTicket>) {
        self.foreground = Some((id.into(), ticket));
        if let Some(s) = self.session.as_mut().filter(|s| s.active && s.id == id) {
            s.foreground = true;
            s.ticket = ticket;
        }
    }
}
static CONTROL: LazyLock<Mutex<Control>> = LazyLock::new(Default::default);
// Todas las aperturas/cierres/saltos pasan por esta admisión; ningún await retiene datos.
static TRANSITION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();
/// Ventana del motor que hay ahora (si hay) y contador para nombrar la siguiente.
static SEQ: AtomicU64 = AtomicU64::new(1);

/// Metadatos de la canción capturada.
pub struct Meta {
    pub title: String,
    pub channel: Option<String>,
    pub duration: Option<f64>,
}

/// Pone la canción en el reproductor oficial y espera a que llegue su audio.
pub async fn stream(
    app: &AppHandle,
    video_id: &str,
    refresh: bool,
    foreground: bool,
    ticket: Option<RequestTicket>,
) -> Result<Meta, String> {
    if !cfg!(windows) {
        return Err("CAPTURE_UNSUPPORTED_PLATFORM: la captura requiere Windows".into());
    }
    if !valid_id(video_id) {
        return Err("id de vídeo no válido".into());
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    let cancellation = loop {
        request_current(ticket)?;
        let guard = TRANSITION.lock().await;
        request_current(ticket)?;
        let (usable, may_replace, same) = {
            let control = CONTROL.lock().unwrap();
            let tracks = TRACKS.lock().unwrap();
            let same = control
                .session
                .as_ref()
                .is_some_and(|s| s.active && s.id == video_id);
            let usable = !refresh
                && tracks
                    .get(video_id)
                    .is_some_and(|t| t.ready() && (t.done_ms.is_some() || same));
            let finished = control
                .session
                .as_ref()
                .and_then(|s| tracks.get(&s.id))
                .is_none_or(|t| t.done_ms.is_some() || t.error.is_some());
            (
                usable,
                control.may_replace(video_id, foreground, finished),
                same,
            )
        };
        if usable || same && (!refresh || !foreground) {
            if foreground {
                let replacing_foreground = CONTROL
                    .lock()
                    .unwrap()
                    .session
                    .as_ref()
                    .is_some_and(|s| s.foreground && s.id != video_id);
                if !same && replacing_foreground {
                    reset_locked(app).await?;
                }
                request_current(ticket)?;
                CONTROL.lock().unwrap().promote(video_id, ticket);
            } else if let Some(s) = CONTROL
                .lock()
                .unwrap()
                .session
                .as_mut()
                .filter(|s| s.id == video_id && !s.foreground)
            {
                s.ticket = ticket;
            }
            break CONTROL.lock().unwrap().cancellation(video_id);
        }
        if may_replace {
            open_locked(
                app,
                video_id,
                if refresh {
                    None
                } else {
                    resume_point(video_id)
                },
                foreground,
                ticket,
                false,
            )
            .await?;
            // Una cancelación anterior a esta admisión no pertenece a la nueva sesión.
            break CONTROL.lock().unwrap().cancellation(video_id);
        }
        drop(guard);
        if Instant::now() > deadline {
            return Err("CAPTURE_BUSY: la captura actual tiene prioridad sobre la precarga".into());
        }
        tokio::time::sleep(Duration::from_millis(80)).await;
    };

    let deadline = Instant::now() + Duration::from_secs(60);
    let mut generation;
    loop {
        tokio::time::sleep(Duration::from_millis(40)).await;
        request_current(ticket)?;
        {
            let control = CONTROL.lock().unwrap();
            if cancellation != control.cancellation(video_id) {
                return Err("CAPTURE_CANCELLED: captura cancelada".into());
            }
            let tracks = TRACKS.lock().unwrap();
            let Some(t) = tracks.get(video_id) else {
                return Err("captura cancelada".into());
            };
            generation = t.generation;
            if let Some(e) = &t.error {
                return Err(e.clone());
            }
            if t.ready() {
                return Ok(meta(t));
            }
            if !control.owns(video_id, t.generation) {
                return Err("CAPTURE_CANCELLED: sesión sustituida".into());
            }
        }
        if Instant::now() > deadline {
            let _guard = TRANSITION.lock().await;
            if let Some(t) = TRACKS
                .lock()
                .unwrap()
                .get_mut(video_id)
                .filter(|t| t.generation == generation)
            {
                t.error = Some("CAPTURE_TIMEOUT: YouTube no empezó a reproducirla".into());
            }
            let _ = cancel_locked(app, video_id, Some(generation)).await;
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

fn request_current(ticket: Option<RequestTicket>) -> Result<(), String> {
    if ticket.is_some_and(|t| !crate::player::request_current(t)) {
        Err("CAPTURE_SUPERSEDED: resolución sustituida".into())
    } else {
        Ok(())
    }
}

/// Dónde seguir una captura empezada (si tiene algo).
fn resume_point(video_id: &str) -> Option<f64> {
    let tracks = TRACKS.lock().unwrap();
    tracks
        .get(video_id)
        .filter(|t| !t.chunks.is_empty())
        .map(|t| (t.position - 2.0).max(0.0))
}

/// Pone la canción en una ventana oculta nueva. Con `at`, sigue una captura ya empezada desde ese
/// segundo (lo capturado se conserva); sin él, empieza de cero.
///
/// Cada canción tiene su ventana: reutilizar la misma página de YouTube Music para varias acaba
/// colgándola (sobre todo tras saltos), y una ventana nueva cuesta lo mismo que navegar.
async fn open_locked(
    app: &AppHandle,
    video_id: &str,
    at: Option<f64>,
    foreground: bool,
    ticket: Option<RequestTicket>,
    recovery: bool,
) -> Result<(), String> {
    if !recovery {
        request_current(ticket)?;
    }
    let _ = APP.set(app.clone());
    watchdog(app);
    // Cerrar primero: una ventana que no se puede cerrar sigue ocupando su plaza.
    reset_locked(app).await?;
    if !recovery {
        request_current(ticket)?;
    }
    let generation = SEQ.fetch_add(1, Ordering::Relaxed);
    let label = format!("{LABEL}-{generation}");
    {
        let mut control = CONTROL.lock().unwrap();
        if foreground {
            control.foreground = Some((video_id.into(), ticket));
        }
        let mut tracks = TRACKS.lock().unwrap();
        match (at, tracks.get_mut(video_id)) {
            (Some(_), Some(t)) => {
                t.done_ms = None;
                t.why = None;
                t.error = None;
                t.last_msg = Instant::now();
            }
            _ => _ = tracks.insert(video_id.to_string(), Track::new()),
        }
        tracks.get_mut(video_id).unwrap().generation = generation;
        // Solo se guardan las últimas canciones.
        while tracks.len() > KEEP {
            let oldest = tracks
                .iter()
                .filter(|(id, _)| {
                    id.as_str() != video_id
                        && control
                            .foreground
                            .as_ref()
                            .is_none_or(|(current, _)| current != *id)
                })
                .min_by_key(|(_, t)| t.used)
                .map(|(k, _)| k.clone())
                .unwrap();
            tracks.remove(&oldest);
        }
        control.session = Some(Session {
            id: video_id.into(),
            generation,
            label: label.clone(),
            foreground,
            ticket,
            active: true,
        });
    }
    // El segundo de inicio va en el fragmento: lo lee `capture.js`, YouTube no lo usa.
    let start = at.map(|s| format!("#musify-t={s:.1}")).unwrap_or_default();
    let url = format!("https://music.youtube.com/watch?v={video_id}{start}");
    let result = async {
        let profile = if std::env::var_os("MUSIFY_BENCH").is_some() {
            crate::capture::profile_directory(app)?
        } else {
            app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("yt-engine-legacy")
        };
        let window_builder = WebviewWindowBuilder::new(
            app,
            &label,
            WebviewUrl::External("about:blank".parse().unwrap()),
        )
        .title("Pletina · reproductor de YouTube")
        .data_directory(profile)
        .visible(std::env::var("MUSIFY_SHOW_ENGINE").is_ok())
        .skip_taskbar(true)
        .focused(false)
        .inner_size(960.0, 640.0)
        .initialization_script(include_str!("capture-legacy.js").to_string());
        let window_builder = if std::env::var_os("MUSIFY_BENCH").is_some() {
            window_builder.additional_browser_args(crate::capture::CAPTURE_BROWSER_ARGS)
        } else {
            window_builder
        };
        let window = window_builder.build()
        .map_err(|e| e.to_string())?;
        let expected_id = video_id.to_string();
        let (tx, rx) = tokio::sync::oneshot::channel();
        // El canal nativo se engancha antes de abrir YouTube para no perder los primeros trozos.
        window
            .with_webview(move |pw| {
                #[cfg(windows)]
                let result = unsafe { attach(&pw, &url, expected_id, generation) }
                    .map_err(|e| e.to_string());
                #[cfg(not(windows))]
                let result = {
                    let _ = (pw, url, expected_id, generation);
                    Err("CAPTURE_UNSUPPORTED_PLATFORM".to_string())
                };
                let _ = tx.send(result);
            })
            .map_err(|e| e.to_string())?;
        tokio::time::timeout(Duration::from_secs(10), rx)
            .await
            .map_err(|_| "CAPTURE_ATTACH_TIMEOUT: no se pudo preparar la ventana".to_string())
            .and_then(|v| v.map_err(|e| e.to_string()))
            .and_then(|v| v)
            .and_then(|_| {
                if recovery {
                    Ok(())
                } else {
                    request_current(ticket)
                }
            })
    }
    .await;
    if let Err(error) = &result {
        CONTROL.lock().unwrap().release(video_id);
        if let Some(t) = TRACKS.lock().unwrap().get_mut(video_id) {
            t.error = Some(error.clone());
        }
        let _ = reset_locked(app).await;
    }
    if result.is_ok() {
        USED.fetch_add(1, Ordering::Relaxed);
    }
    result
}

#[cfg(windows)]
unsafe fn attach(
    pw: &tauri::webview::PlatformWebview,
    url: &str,
    expected_id: String,
    generation: u64,
) -> windows_core::Result<()> {
    use webview2_com::{WebMessageReceivedEventHandler, take_pwstr};
    use windows_core::{HSTRING, PWSTR};
    unsafe {
        let controller = pw.controller();
        let core = controller.CoreWebView2()?;
        crate::capture_mute::enforce(&core)?;
        let handler = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut source = PWSTR::null();
            args.Source(&mut source)?;
            let source = take_pwstr(source);
            // Solo mensajes de texto que empiezan por "musify:" (ver `capture.js`).
            let mut text = PWSTR::null();
            if args.TryGetWebMessageAsString(&mut text).is_ok() {
                let text = take_pwstr(text);
                if let Some(json) = text.strip_prefix("musify:") {
                    receive(&expected_id, generation, &source, json);
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
fn receive(expected_id: &str, generation: u64, source: &str, json: &str) {
    if !(source.starts_with("https://music.youtube.com/")
        || source.starts_with("https://consent.youtube.com/"))
    {
        return;
    }
    let Ok(m) = serde_json::from_str::<Message>(json) else {
        return;
    };
    let Some(id) = m.v.filter(|_| m.musify == 1) else {
        return;
    };
    let control = CONTROL.lock().unwrap();
    if id != expected_id || !control.owns(expected_id, generation) {
        return;
    }
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
            let Some(bytes) = m
                .data
                .and_then(|d| base64::engine::general_purpose::STANDARD.decode(d).ok())
            else {
                return;
            };
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
                        close_when_idle(id.clone(), generation);
                    }
                }
                t.duration = m
                    .duration
                    .filter(|d| d.is_finite() && *d > 0.0)
                    .or(t.duration);
                if let Some(title) = m.title.filter(|s| !s.is_empty()) {
                    t.title = title;
                }
                if let Some(author) = m.author.filter(|s| !s.is_empty()) {
                    t.author = author;
                }
            }
            Some("error") => {
                t.error = Some(
                    m.reason
                        .unwrap_or_else(|| "YouTube no puede reproducirla".into()),
                )
            }
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
            let _guard = TRANSITION.lock().await;
            let Some(session) = CONTROL.lock().unwrap().session.clone() else {
                continue;
            };
            if !session.active
                || session.ticket.is_some_and(|t| {
                    if session.foreground {
                        !crate::player::resolution_current(t.resolution)
                    } else {
                        !crate::player::prefetch_current(t)
                    }
                })
            {
                let _ = reset_locked(&app).await;
                continue;
            }
            let resume = {
                let mut tracks = TRACKS.lock().unwrap();
                let Some(t) = tracks.get_mut(&session.id) else {
                    continue;
                };
                if t.done_ms.is_some() || t.error.is_some() || t.last_msg.elapsed() < STALL {
                    continue;
                }
                if t.resets >= MAX_RESETS {
                    t.error = Some("El reproductor de YouTube se quedó colgado".into());
                    None
                } else {
                    t.resets += 1;
                    Some((t.position - 2.0).max(0.0))
                }
            };
            if let Some(at) = resume {
                let _ = open_locked(
                    &app,
                    &session.id,
                    Some(at),
                    session.foreground,
                    session.ticket,
                    true,
                )
                .await;
            } else {
                let _ = reset_locked(&app).await;
            }
        }
    });
}

fn close_when_idle(id: String, generation: u64) {
    let Some(app) = APP.get().cloned() else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let _guard = TRANSITION.lock().await;
        let idle = CONTROL.lock().unwrap().owns(&id, generation)
            && TRACKS
                .lock()
                .unwrap()
                .get(&id)
                .is_some_and(|t| t.done_ms.is_some());
        if idle {
            let _ = reset_locked(&app).await;
        }
    });
}

/// Desactiva el canal antes de navegar; conserva la plaza si el SO no cierra la ventana.
async fn reset_locked(app: &AppHandle) -> Result<(), String> {
    let session = {
        let mut control = CONTROL.lock().unwrap();
        let Some(s) = control.session.as_mut() else {
            return Ok(());
        };
        s.active = false;
        s.clone()
    };
    if let Some(w) = app.get_webview_window(&session.label) {
        let _ = w.navigate("about:blank".parse().unwrap());
        tokio::time::sleep(Duration::from_millis(300)).await;
        let _ = w.destroy();
        for _ in 0..50 {
            if app.get_webview_window(&session.label).is_none() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        if app.get_webview_window(&session.label).is_some() {
            return Err("CAPTURE_WINDOW_CLOSE: no se pudo cerrar la captura anterior".into());
        }
    }
    let mut control = CONTROL.lock().unwrap();
    if control
        .session
        .as_ref()
        .is_some_and(|s| s.generation == session.generation)
    {
        control.session = None;
    }
    Ok(())
}

async fn cancel_locked(
    app: &AppHandle,
    video_id: &str,
    generation: Option<u64>,
) -> Result<(), String> {
    let close = {
        let mut control = CONTROL.lock().unwrap();
        let mut tracks = TRACKS.lock().unwrap();
        if generation.is_some_and(|g| tracks.get(video_id).is_none_or(|t| t.generation != g)) {
            return Ok(());
        }
        *control.cancellations.entry(video_id.into()).or_default() += 1;
        control.release(video_id);
        if let Some(t) = tracks.get_mut(video_id).filter(|t| t.done_ms.is_none()) {
            t.error
                .get_or_insert_with(|| "CAPTURE_CANCELLED: captura cancelada".into());
        }
        control.session.as_ref().is_some_and(|s| s.id == video_id)
    };
    if close {
        reset_locked(app).await?;
    }
    Ok(())
}
#[tauri::command]
pub async fn capture_legacy_cancel(
    app: AppHandle,
    video_id: String,
    generation: Option<u64>,
) -> Result<(), String> {
    let _guard = TRANSITION.lock().await;
    cancel_locked(&app, &video_id, generation).await
}
pub async fn cancel_before(app: &AppHandle, resolution: u64) -> Result<(), String> {
    let _guard = TRANSITION.lock().await;
    let id = {
        let control = CONTROL.lock().unwrap();
        control
            .foreground
            .as_ref()
            .filter(|(_, t)| t.is_some_and(|t| t.resolution < resolution))
            .map(|(id, _)| id.clone())
    };
    if let Some(id) = id {
        cancel_locked(app, &id, None).await?;
    }
    Ok(())
}
pub async fn cancel_next_before(app: &AppHandle, prefetch: u64) -> Result<(), String> {
    let _guard = TRANSITION.lock().await;
    let session = CONTROL
        .lock()
        .unwrap()
        .session
        .as_ref()
        .filter(|s| {
            !s.foreground
                && s.ticket
                    .and_then(|t| t.prefetch)
                    .is_some_and(|p| p < prefetch)
        })
        .cloned();
    if let Some(s) = session {
        cancel_locked(app, &s.id, Some(s.generation)).await?;
    }
    Ok(())
}

/// El salto conserva los bytes anteriores, como en el lector histórico, pero no roba otra sesión.
#[tauri::command]
pub async fn capture_legacy_seek(
    app: AppHandle,
    video_id: String,
    at: f64,
    generation: Option<u64>,
) -> Result<(), String> {
    if !valid_id(&video_id) || !at.is_finite() || at < 0.0 {
        return Err("salto no válido".into());
    }
    let _guard = TRANSITION.lock().await;
    let (session, ticket, capturing) = {
        let control = CONTROL.lock().unwrap();
        let tracks = TRACKS.lock().unwrap();
        let t = tracks
            .get(&video_id)
            .ok_or("CAPTURE_CANCELLED: no hay captura")?;
        if generation.is_some_and(|g| g != t.generation) {
            return Err("CAPTURE_CANCELLED: salto obsoleto".into());
        }
        let lease = control
            .foreground
            .as_ref()
            .filter(|(id, _)| id == &video_id)
            .ok_or("CAPTURE_CANCELLED: otra canción tiene prioridad")?;
        (control.session.clone(), lease.1, t.done_ms.is_none())
    };
    if let Some(s) = session.filter(|s| s.active && s.id == video_id && capturing) {
        if let Some(w) = app.get_webview_window(&s.label) {
            return w
                .eval(format!("window.__musifySeek?.({at:.1})"))
                .map_err(|e| e.to_string());
        }
    }
    open_locked(&app, &video_id, Some(at), true, ticket, true).await
}

/// Lo capturado de una canción a partir del trozo `from`, para el reproductor (Media Source).
/// Si aún no hay nada nuevo, espera un poco. Formato: 4 bytes (u32 LE) con el tamaño de una
/// cabecera JSON, la cabecera, y cada trozo como 4 bytes de tamaño + bytes.
#[tauri::command]
pub async fn capture_legacy_read(
    video_id: String,
    from: usize,
) -> Result<tauri::ipc::Response, String> {
    let deadline = Instant::now() + Duration::from_millis(1500);
    loop {
        {
            let mut tracks = TRACKS.lock().unwrap();
            let t = tracks
                .get_mut(&video_id)
                .ok_or("No hay captura de esa canción")?;
            t.last_read = Some(Instant::now());
            t.used = Instant::now();
            let done = t.done_ms.is_some();
            if t.chunks.len() > from || done || t.error.is_some() || Instant::now() > deadline {
                let chunks = t.chunks.get(from..).unwrap_or_default();
                let head = json!({
                    "generation": t.generation,
                    "mime": t.mime,
                    "mimes": t.mimes.get(from..).unwrap_or_default(),
                    "duration": t.duration,
                    "done": done,
                    "error": t.error,
                    "next": from + chunks.len(),
                })
                .to_string();
                let mut out = Vec::with_capacity(
                    4 + head.len() + chunks.iter().map(|c| c.len() + 4).sum::<usize>(),
                );
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

/// Estado histórico reservado para diagnósticos de regresión.
#[allow(dead_code)]
pub fn status(video_id: &str) -> Option<serde_json::Value> {
    let tracks = TRACKS.lock().unwrap();
    let t = tracks.get(video_id)?;
    Some(json!({
        "generation": t.generation,
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
    id.len() == 11
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;
    fn session(id: &str, generation: u64, foreground: bool) -> Session {
        Session {
            id: id.into(),
            generation,
            label: format!("test-{generation}"),
            foreground,
            ticket: None,
            active: true,
        }
    }
    #[test]
    fn background_never_preempts_unfinished_foreground_and_promotion_keeps_ownership() {
        let mut c = Control {
            session: Some(session("aaaaaaaaaaa", 7, true)),
            ..Default::default()
        };
        // No reader timestamp or expired waiting deadline can override foreground priority.
        for _ in 0..1000 {
            assert!(!c.may_replace("bbbbbbbbbbb", false, false));
        }
        assert!(c.may_replace("bbbbbbbbbbb", false, true));
        assert!(c.may_replace("bbbbbbbbbbb", true, false));
        c.session = Some(session("bbbbbbbbbbb", 8, false));
        assert!(c.may_replace("ccccccccccc", false, false));
        let ticket = Some(RequestTicket {
            resolution: 4,
            prefetch: None,
            prefetch_slot: None,
        });
        c.promote("bbbbbbbbbbb", ticket);
        assert!(c.owns("bbbbbbbbbbb", 8));
        assert_eq!(c.session.as_ref().unwrap().ticket, ticket);
        assert!(!c.may_replace("ccccccccccc", false, false));
        c.session.as_mut().unwrap().active = false;
        assert!(
            !c.owns("bbbbbbbbbbb", 8),
            "messages stop before asynchronous close"
        );
        assert!(
            c.session.is_some(),
            "failed close must retain the physical slot"
        );
    }

    #[test]
    fn only_youtube_messages() {
        TRACKS
            .lock()
            .unwrap()
            .insert("aaaaaaaaaaa".into(), Track::new());
        CONTROL.lock().unwrap().session = Some(session("aaaaaaaaaaa", 10, true));
        let seg = r#"{"musify":1,"v":"aaaaaaaaaaa","kind":"seg","s":1,"mime":"audio/webm","ad":false,"data":"GkXfow=="}"#;
        receive("aaaaaaaaaaa", 10, "https://evil.example/", seg);
        receive("aaaaaaaaaaa", 10, "https://consent.youtube.com/", seg);
        receive("aaaaaaaaaaa", 9, "https://music.youtube.com/", seg);
        receive("bbbbbbbbbbb", 10, "https://music.youtube.com/", seg);
        assert_eq!(TRACKS.lock().unwrap()["aaaaaaaaaaa"].chunks.len(), 0);
        receive(
            "aaaaaaaaaaa",
            10,
            "https://music.youtube.com/watch?v=aaaaaaaaaaa",
            seg,
        );
        CONTROL.lock().unwrap().session = Some(session("aaaaaaaaaaa", 11, true));
        receive(
            "aaaaaaaaaaa",
            10,
            "https://music.youtube.com/watch?v=aaaaaaaaaaa",
            seg,
        );
        let ad = seg.replace(r#""ad":false"#, r#""ad":true"#);
        receive(
            "aaaaaaaaaaa",
            11,
            "https://music.youtube.com/watch?v=aaaaaaaaaaa",
            &ad,
        );
        let t = &TRACKS.lock().unwrap()["aaaaaaaaaaa"];
        assert_eq!((t.chunks.len(), t.ads), (1, 1));
        assert_eq!(t.chunks[0], [0x1a, 0x45, 0xdf, 0xa3]);
    }
}
