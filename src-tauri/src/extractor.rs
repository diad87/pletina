//! Prototipo P1: sacar la URL del audio sin yt-dlp, con youtubei.js dentro de la propia app.
//!
//! La librería corre en la interfaz (src/lib/extractor/). Rust hace dos cosas por ella:
//! - Sus peticiones HTTP (`http_fetch`): sin CORS y con las cabeceras que necesita YouTube.
//! - Pedirle URLs (`stream`): manda un evento a la interfaz y espera la respuesta.
//!
//! El motor se elige con `set_stream_engine` (o `MUSIFY_ENGINE=youtubei`). yt-dlp sigue siendo
//! el de por defecto y queda de respaldo si youtubei.js falla.

use crate::youtube::BROWSER_UA;
use crate::ytdlp::{VideoInfo, YtDlp, now, query_param};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;

/// Dominios a los que la interfaz puede pedir cosas a través de `http_fetch`.
const ALLOWED_HOSTS: [&str; 6] =
    ["youtube.com", "youtube-nocookie.com", "googlevideo.com", "google.com", "googleapis.com", "ytimg.com"];

static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .user_agent(BROWSER_UA)
        .timeout(Duration::from_secs(20))
        .build()
        .expect("cliente HTTP")
});

/// `true` = youtubei.js (con yt-dlp de respaldo); `false` = solo yt-dlp.
static USE_JS: AtomicBool = AtomicBool::new(false);
static BRIDGE: OnceLock<Bridge> = OnceLock::new();

struct Bridge {
    app: AppHandle,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<VideoInfo, String>>>>,
    /// video_id → (info, caducidad en segundos unix), igual que en yt-dlp.
    videos: Mutex<HashMap<String, (VideoInfo, u64)>>,
}

pub fn init(app: AppHandle) {
    if std::env::var("MUSIFY_ENGINE").is_ok_and(|e| e == "youtubei") {
        USE_JS.store(true, Ordering::Relaxed);
    }
    let _ = BRIDGE.set(Bridge {
        app,
        next_id: AtomicU64::new(1),
        pending: Mutex::new(HashMap::new()),
        videos: Mutex::new(HashMap::new()),
    });
}

/// URL del audio con el motor elegido. Si youtubei.js falla, se prueba con yt-dlp.
pub async fn stream(ytdlp: &YtDlp, video_id: &str, refresh: bool) -> Result<VideoInfo, String> {
    if USE_JS.load(Ordering::Relaxed) {
        match stream_js(video_id, refresh).await {
            Ok(info) => return Ok(info),
            Err(_e) => {
                #[cfg(debug_assertions)]
                eprintln!("[youtubei.js] {video_id}: {_e} → yt-dlp");
            }
        }
    }
    ytdlp.stream(video_id, refresh).await
}

/// Pide la URL a youtubei.js (en la interfaz) y la guarda mientras no caduque.
async fn stream_js(video_id: &str, refresh: bool) -> Result<VideoInfo, String> {
    let bridge = BRIDGE.get().ok_or("youtubei.js no está listo")?;
    if !refresh {
        let cached = bridge.videos.lock().unwrap().get(video_id).cloned();
        if let Some((info, expires)) = cached
            && expires > now() + 600
        {
            return Ok(info);
        }
    }

    #[derive(Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct Request<'a> {
        id: u64,
        video_id: &'a str,
    }
    let id = bridge.next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel();
    bridge.pending.lock().unwrap().insert(id, tx);
    let sent = bridge.app.emit_to("main", "extractor:stream", Request { id, video_id });
    let result = match sent {
        Ok(()) => tokio::time::timeout(Duration::from_secs(30), rx).await,
        Err(e) => {
            bridge.pending.lock().unwrap().remove(&id);
            return Err(e.to_string());
        }
    };
    bridge.pending.lock().unwrap().remove(&id);
    let info = match result {
        Ok(Ok(r)) => r?,
        Ok(Err(_)) => return Err("youtubei.js no respondió".into()),
        Err(_) => return Err("youtubei.js tardó demasiado".into()),
    };
    let expires = query_param(&info.url, "expire").and_then(|e| e.parse().ok()).unwrap_or(now() + 3 * 3600);
    bridge.videos.lock().unwrap().insert(video_id.to_string(), (info.clone(), expires));
    Ok(info)
}

#[derive(Deserialize)]
pub struct Reply {
    id: u64,
    info: Option<VideoInfo>,
    error: Option<String>,
}

/// Respuesta de la interfaz a un evento `extractor:stream`.
#[tauri::command]
pub fn extractor_reply(reply: Reply) {
    let Some(bridge) = BRIDGE.get() else { return };
    if let Some(tx) = bridge.pending.lock().unwrap().remove(&reply.id) {
        let _ = tx.send(reply.info.ok_or_else(|| reply.error.unwrap_or_else(|| "youtubei.js falló".into())));
    }
}

#[tauri::command]
pub fn set_stream_engine(engine: String) -> Result<(), String> {
    match engine.as_str() {
        "ytdlp" => USE_JS.store(false, Ordering::Relaxed),
        "youtubei" => USE_JS.store(true, Ordering::Relaxed),
        _ => return Err(format!("Motor desconocido: {engine}")),
    }
    Ok(())
}

#[tauri::command]
pub fn stream_engine() -> &'static str {
    if USE_JS.load(Ordering::Relaxed) { "youtubei" } else { "ytdlp" }
}

#[derive(Deserialize)]
pub struct FetchRequest {
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body: Option<Body>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Body {
    Text(String),
    Bytes(Vec<u8>),
}

/// `fetch` para youtubei.js hecho desde Rust. Devuelve los bytes tal cual:
/// 4 bytes con la longitud de la cabecera (u32 LE), la cabecera en JSON
/// (`status`, `statusText`, `headers`, `url`) y el cuerpo.
#[tauri::command]
pub async fn http_fetch(req: FetchRequest) -> Result<tauri::ipc::Response, String> {
    let url = reqwest::Url::parse(&req.url).map_err(|e| e.to_string())?;
    if !allowed(&url) {
        return Err(format!("Dominio no permitido: {}", url.host_str().unwrap_or("")));
    }
    let method = reqwest::Method::from_bytes(req.method.as_bytes()).map_err(|e| e.to_string())?;
    let mut builder = HTTP.request(method, url);
    for (k, v) in req.headers {
        builder = builder.header(k, v);
    }
    builder = match req.body {
        Some(Body::Text(t)) => builder.body(t),
        Some(Body::Bytes(b)) => builder.body(b),
        None => builder,
    };
    let res = builder.send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let headers: Vec<(String, String)> = res
        .headers()
        .iter()
        .filter_map(|(k, v)| Some((k.to_string(), v.to_str().ok()?.to_string())))
        .collect();
    let head = json!({
        "status": status.as_u16(),
        "statusText": status.canonical_reason().unwrap_or(""),
        "headers": headers,
        "url": res.url().as_str(),
    })
    .to_string();
    let body = res.bytes().await.map_err(|e| e.to_string())?;

    let mut out = Vec::with_capacity(4 + head.len() + body.len());
    out.extend((head.len() as u32).to_le_bytes());
    out.extend(head.as_bytes());
    out.extend(&body);
    Ok(tauri::ipc::Response::new(out))
}

fn allowed(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url
            .host_str()
            .is_some_and(|h| ALLOWED_HOSTS.iter().any(|d| h == *d || h.strip_suffix(d).is_some_and(|s| s.ends_with('.'))))
}

// --- Medición (solo para el prototipo) ---------------------------------------------------
// `MUSIFY_BENCH=<plan.json>` hace que la interfaz, al arrancar, compare youtubei.js con yt-dlp
// y deje el resultado en `MUSIFY_BENCH_OUT` (o junto al plan, como `*.result.json`).

#[tauri::command]
pub fn bench_plan() -> Option<Value> {
    let path = std::env::var("MUSIFY_BENCH").ok()?;
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

#[tauri::command]
pub fn bench_report(report: Value, app: AppHandle) -> Result<(), String> {
    let plan = std::env::var("MUSIFY_BENCH").map_err(|e| e.to_string())?;
    let out = std::env::var("MUSIFY_BENCH_OUT").unwrap_or_else(|_| plan.replace(".json", ".result.json"));
    std::fs::write(&out, serde_json::to_string_pretty(&report).unwrap()).map_err(|e| e.to_string())?;
    eprintln!("[bench] resultado en {out}");
    if std::env::var("MUSIFY_BENCH_EXIT").is_ok() {
        app.exit(0);
    }
    Ok(())
}

/// yt-dlp cronometrado (siempre pide una URL nueva).
#[tauri::command]
pub async fn bench_ytdlp(video_id: String, ytdlp: State<'_, YtDlp>) -> Result<Value, String> {
    ytdlp.warm_up().await;
    let t = Instant::now();
    let info = ytdlp.stream(&video_id, true).await?;
    Ok(json!({ "ms": t.elapsed().as_millis() as u64, "url": info.url, "title": info.title }))
}

/// Pide 1 KB del principio y otro hacia el 80 % del audio: sin PO token, YouTube suele
/// responder 403 (al principio o pasado el primer MB).
#[tauri::command]
pub async fn bench_probe(url: String) -> Result<Value, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| e.to_string())?;
    if !parsed.host_str().is_some_and(|h| h.ends_with(".googlevideo.com")) {
        return Err("solo URLs de googlevideo".into());
    }
    let len: u64 = query_param(&url, "clen").and_then(|c| c.parse().ok()).unwrap_or(0);
    let deep = len * 8 / 10;
    let mut statuses = vec![];
    for start in [0, deep] {
        let status = HTTP
            .get(&url)
            .header("Range", format!("bytes={start}-{}", start + 1023))
            .send()
            .await
            .map(|r| r.status().as_u16())
            .unwrap_or(0);
        statuses.push(status);
    }
    Ok(json!({ "length": len, "start": statuses[0], "deep": statuses[1] }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_youtube_hosts() {
        let ok = |u: &str| allowed(&reqwest::Url::parse(u).unwrap());
        assert!(ok("https://www.youtube.com/youtubei/v1/player"));
        assert!(ok("https://youtube.com/iframe_api"));
        assert!(ok("https://rr3---sn-abc.googlevideo.com/videoplayback"));
        assert!(!ok("http://www.youtube.com/"));
        assert!(!ok("https://evil-youtube.com/"));
        assert!(!ok("https://example.com/?youtube.com"));
    }

    /// Lista de vídeos para comparar motores: las mismas canciones que `player::tests::real_albums`.
    /// `MUSIFY_BENCH_IDS=plan.json cargo test bench_videos -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn bench_videos() {
        use crate::deezer::Deezer;
        use crate::youtube::{self, MIN_SCORE, TrackQuery, YouTubeMusic};
        let deezer = Deezer::new();
        let ytm = YouTubeMusic::new();
        let mut videos = vec![];
        for query in ["radiohead ok computer", "berri txarrak infrasoinuak", "extremoduro agila", "rosalia el mal querer", "the beatles abbey road"] {
            let found = deezer.search(query).await.unwrap();
            let album = deezer.album(found.albums[0].id).await.unwrap();
            for t in album.tracks.iter().take(6) {
                let q = TrackQuery {
                    id: t.id,
                    title: t.title.clone(),
                    artist: t.artist.name.clone(),
                    album: album.title.clone(),
                    duration: t.duration,
                };
                let found = ytm.search_songs(&q.search_text()).await.unwrap();
                let best = found
                    .into_iter()
                    .take(10)
                    .enumerate()
                    .map(|(i, c)| {
                        let s = youtube::score(&q, &c, i);
                        (c, s)
                    })
                    .max_by_key(|(_, s)| *s);
                if let Some((c, s)) = best.filter(|(_, s)| *s >= MIN_SCORE) {
                    println!("{} {} — {} [{s}]", c.video_id, q.artist, q.title);
                    videos.push(json!({ "id": c.video_id, "label": format!("{} — {}", q.artist, q.title), "duration": q.duration }));
                }
            }
        }
        let plan = json!({ "videos": videos });
        if let Ok(path) = std::env::var("MUSIFY_BENCH_IDS") {
            std::fs::write(path, serde_json::to_string_pretty(&plan).unwrap()).unwrap();
        }
    }
}
