//! Motor propio, nivel rápido: una sola petición a la API interna de YouTube desde Rust, sin
//! programas ni librerías externas. Qué cliente de YouTube se imita y con qué datos va en una
//! receta (`recipe/youtube.json`): cuando YouTube cambie algo de eso, basta con publicar una
//! receta nueva, sin sacar otra versión de la app. Si aun así falla, está el nivel garantizado
//! (`capture.rs`).

use crate::ytdlp::{now, query_param};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, RwLock};
use std::time::{Duration, Instant};

const BUNDLED: &str = include_str!("../recipe/youtube.json");
/// La sesión de visitante vale horas; se pide otra antes por si acaso.
const VISITOR_TTL: Duration = Duration::from_secs(3 * 3600);
const BROWSER_UA: &str = crate::youtube::BROWSER_UA;

#[derive(Debug, Clone, Deserialize)]
pub struct Recipe {
    pub version: u32,
    visitor: Fetch,
    player: String,
    clients: Vec<Client>,
    /// Tipos de audio aceptados, de más a menos preferido.
    audio: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct Fetch {
    url: String,
    #[serde(default)]
    headers: HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Client {
    name: String,
    id: u32,
    version: String,
    user_agent: String,
    #[serde(default)]
    context: Map<String, Value>,
}

/// URL del audio, comprobada.
#[derive(Debug, Clone)]
pub struct Direct {
    pub url: String,
    pub title: String,
    pub channel: Option<String>,
    pub duration: Option<f64>,
    pub client: String,
    pub itag: u64,
    pub mime: String,
    expires: u64,
}

#[derive(Debug)]
pub enum Error {
    /// YouTube dice que el vídeo no se puede ver (borrado, privado...).
    Gone(String),
    Failed(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Gone(e) | Error::Failed(e) => f.write_str(e),
        }
    }
}

/// Números para comparar y para la interfaz.
#[derive(Default)]
pub struct Stats {
    pub resolved: AtomicU64,
    pub failed: AtomicU64,
    /// URLs que YouTube habría cortado a mitad (403) y que se cambiaron por otras antes de usarlas.
    pub replaced: AtomicU64,
}

pub static STATS: LazyLock<Stats> = LazyLock::new(Stats::default);
static RECIPE: LazyLock<RwLock<Recipe>> =
    LazyLock::new(|| RwLock::new(serde_json::from_str(BUNDLED).expect("receta incluida")));
static VISITOR: tokio::sync::Mutex<Option<(String, Instant)>> = tokio::sync::Mutex::const_new(None);
static CACHE: LazyLock<Mutex<HashMap<String, Direct>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .expect("cliente HTTP")
});

/// Usa la receta guardada si es más nueva que la incluida y, si hay `MUSIFY_RECIPE_URL`, busca
/// otra en segundo plano.
pub fn init(dir: PathBuf) {
    let saved = dir.join("recipe.json");
    if let Some(r) = std::fs::read_to_string(&saved).ok().and_then(|s| serde_json::from_str::<Recipe>(&s).ok()) {
        adopt(r);
    }
    if let Ok(url) = std::env::var("MUSIFY_RECIPE_URL") {
        tauri::async_runtime::spawn(async move {
            let Ok(text) = HTTP.get(&url).send().await.and_then(|r| r.error_for_status()) else { return };
            let Ok(text) = text.text().await else { return };
            if let Ok(r) = serde_json::from_str::<Recipe>(&text)
                && adopt(r)
            {
                let _ = std::fs::write(saved, text);
            }
        });
    }
}

/// Se queda con una receta si es más nueva y sus URLs son de YouTube.
fn adopt(r: Recipe) -> bool {
    let youtube = |u: &str| {
        reqwest::Url::parse(u)
            .ok()
            .and_then(|u| u.host_str().map(|h| h == "youtube.com" || h.ends_with(".youtube.com")))
            .unwrap_or(false)
    };
    let mut current = RECIPE.write().unwrap();
    if r.version <= current.version || !youtube(&r.player) || !youtube(&r.visitor.url) || r.clients.is_empty() {
        return false;
    }
    *current = r;
    true
}

pub fn recipe_version() -> u32 {
    RECIPE.read().unwrap().version
}

/// URL del audio de un vídeo, ya comprobada (YouTube no la va a cortar a mitad).
pub async fn resolve(video_id: &str, refresh: bool) -> Result<Direct, Error> {
    if !refresh
        && let Some(d) = CACHE.lock().unwrap().get(video_id).filter(|d| d.expires > now() + 600)
    {
        return Ok(d.clone());
    }
    let recipe = RECIPE.read().unwrap().clone();
    let mut last = Error::Failed("La receta no tiene clientes".into());
    for client in &recipe.clients {
        // Segundo intento con sesión de visitante nueva y otra URL.
        for attempt in 0..2 {
            let visitor = match visitor(&recipe, attempt > 0).await {
                Ok(v) => v,
                Err(e) => {
                    last = Error::Failed(e);
                    continue;
                }
            };
            match player(&recipe, client, video_id, &visitor).await {
                Ok(d) => match validate(&d).await {
                    Ok(()) => {
                        STATS.resolved.fetch_add(1, Ordering::Relaxed);
                        CACHE.lock().unwrap().insert(video_id.to_string(), d.clone());
                        return Ok(d);
                    }
                    Err(e) => {
                        STATS.replaced.fetch_add(1, Ordering::Relaxed);
                        last = Error::Failed(e);
                    }
                },
                // Otro cliente podría reproducirlo; si ninguno puede, se devuelve esto.
                Err(Error::Gone(e)) => {
                    last = Error::Gone(e);
                    break;
                }
                Err(e) => last = e,
            }
        }
    }
    STATS.failed.fetch_add(1, Ordering::Relaxed);
    Err(last)
}

async fn visitor(recipe: &Recipe, fresh: bool) -> Result<String, String> {
    let mut slot = VISITOR.lock().await;
    if !fresh
        && let Some((v, _)) = slot.as_ref().filter(|(_, at)| at.elapsed() < VISITOR_TTL)
    {
        return Ok(v.clone());
    }
    let mut req = HTTP.get(&recipe.visitor.url).header("User-Agent", BROWSER_UA);
    for (k, v) in &recipe.visitor.headers {
        req = req.header(k, v);
    }
    let text = req
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("No se pudo conectar con YouTube: {e}"))?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let v = find_visitor(&text).ok_or("YouTube no dio sesión de visitante")?;
    *slot = Some((v.clone(), Instant::now()));
    Ok(v)
}

/// La sesión de visitante es un protobuf en base64 cuyo primer campo es un id de 11 caracteres,
/// así que siempre empieza por "Cgt". Buscarla así no depende de en qué posición la ponga YouTube.
fn find_visitor(text: &str) -> Option<String> {
    text.split('"')
        .find(|s| s.starts_with("Cgt") && s.len() >= 20 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_%=".contains(&b)))
        .map(String::from)
}

async fn player(recipe: &Recipe, c: &Client, video_id: &str, visitor: &str) -> Result<Direct, Error> {
    let mut client = c.context.clone();
    client.insert("clientName".into(), json!(c.name));
    client.insert("clientVersion".into(), json!(c.version));
    client.insert("userAgent".into(), json!(c.user_agent));
    client.insert("hl".into(), json!("en"));
    client.insert("visitorData".into(), json!(visitor));
    let body = json!({
        "context": { "client": client },
        "videoId": video_id,
        "contentCheckOk": true,
        "racyCheckOk": true,
        "playbackContext": { "contentPlaybackContext": { "vis": 0, "splay": false, "lactMilliseconds": "-1" } },
    });
    let res = HTTP
        .post(&recipe.player)
        .header("Content-Type", "application/json")
        .header("User-Agent", &c.user_agent)
        .header("X-Youtube-Client-Name", c.id.to_string())
        .header("X-Youtube-Client-Version", &c.version)
        .header("X-Goog-Visitor-Id", visitor)
        .header("Origin", "https://www.youtube.com")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| Error::Failed(format!("No se pudo conectar con YouTube: {e}")))?;
    let text = res.text().await.map_err(|e| Error::Failed(e.to_string()))?;
    let j: Value = serde_json::from_str(&text).map_err(|e| Error::Failed(e.to_string()))?;
    pick(recipe, c, &j)
}

/// Elige el audio de la respuesta de YouTube: solo audio, con URL directa, sin compresión de rango
/// dinámico, en la pista de idioma por defecto, y del tipo preferido con más calidad.
fn pick(recipe: &Recipe, c: &Client, j: &Value) -> Result<Direct, Error> {
    let status = j["playabilityStatus"]["status"].as_str().unwrap_or("");
    let reason = j["playabilityStatus"]["reason"].as_str().unwrap_or(status).to_string();
    match status {
        "OK" => {}
        "UNPLAYABLE" | "ERROR" => return Err(Error::Gone(format!("Video unavailable: {reason}"))),
        _ => return Err(Error::Failed(format!("YouTube: {reason}"))),
    }
    let rank = |mime: &str| recipe.audio.iter().position(|a| mime.starts_with(a.as_str()));
    let best = j["streamingData"]["adaptiveFormats"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|f| {
            let mime = f["mimeType"].as_str().unwrap_or("");
            rank(mime).is_some()
                && f["url"].is_string()
                && !f["isDrc"].as_bool().unwrap_or(false)
                && f["audioTrack"]["audioIsDefault"].as_bool().unwrap_or(true)
        })
        .min_by_key(|f| (rank(f["mimeType"].as_str().unwrap_or("")), std::cmp::Reverse(f["bitrate"].as_u64().unwrap_or(0))))
        .ok_or_else(|| Error::Failed(format!("{}: sin audio con URL directa", c.name)))?;

    let url = best["url"].as_str().unwrap_or_default().to_string();
    let details = &j["videoDetails"];
    Ok(Direct {
        expires: query_param(&url, "expire").and_then(|e| e.parse().ok()).unwrap_or(now() + 3 * 3600),
        title: details["title"].as_str().unwrap_or_default().to_string(),
        channel: details["author"].as_str().map(String::from),
        duration: details["lengthSeconds"].as_str().and_then(|s| s.parse().ok()),
        client: c.name.clone(),
        itag: best["itag"].as_u64().unwrap_or(0),
        mime: best["mimeType"].as_str().unwrap_or_default().to_string(),
        url,
    })
}

/// Pide 1 KB hacia el 80 % del audio: es donde YouTube corta (403) las URLs que no va a servir
/// enteras. Así se cambia antes de usarla en vez de a mitad de la canción.
async fn validate(d: &Direct) -> Result<(), String> {
    let len: u64 = query_param(&d.url, "clen").and_then(|c| c.parse().ok()).unwrap_or(0);
    let at = len * 8 / 10;
    let res = HTTP
        .get(&d.url)
        .header("Range", format!("bytes={at}-{}", at + 1023))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    match res.status().as_u16() {
        200 | 206 => Ok(()),
        s => Err(format!("YouTube cortaría el audio ({s})")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_recipe_parses() {
        let r: Recipe = serde_json::from_str(BUNDLED).unwrap();
        assert!(!r.clients.is_empty());
    }

    #[test]
    fn finds_visitor_anywhere() {
        let text = r#")]}'[["a",["Cg","x"],[[["es","ES",null,"CgtBQkNERUZHSElKSyiAgICAgICA%3D%3D",0]]]]]"#;
        assert_eq!(find_visitor(text).as_deref(), Some("CgtBQkNERUZHSElKSyiAgICAgICA%3D%3D"));
        assert_eq!(find_visitor(r#"["Cg","nada"]"#), None);
    }

    #[test]
    fn picks_opus_then_m4a() {
        let r: Recipe = serde_json::from_str(BUNDLED).unwrap();
        let c = &r.clients[0];
        let resp = |formats: Value| json!({ "playabilityStatus": { "status": "OK" }, "streamingData": { "adaptiveFormats": formats }, "videoDetails": { "title": "T", "author": "A", "lengthSeconds": "200" } });
        let f = |itag: u64, mime: &str, bitrate: u64| json!({ "itag": itag, "mimeType": mime, "bitrate": bitrate, "url": format!("https://x.googlevideo.com/videoplayback?itag={itag}&clen=100") });
        let both = resp(json!([f(140, "audio/mp4; codecs=\"mp4a.40.2\"", 130000), f(251, "audio/webm; codecs=\"opus\"", 140000), f(250, "audio/webm; codecs=\"opus\"", 70000), f(137, "video/mp4", 4000000)]));
        assert_eq!(pick(&r, c, &both).unwrap().itag, 251);
        let m4a = resp(json!([f(140, "audio/mp4; codecs=\"mp4a.40.2\"", 130000)]));
        assert_eq!(pick(&r, c, &m4a).unwrap().itag, 140);
        let gone = json!({ "playabilityStatus": { "status": "ERROR", "reason": "This video is unavailable" } });
        assert!(matches!(pick(&r, c, &gone), Err(Error::Gone(_))));
        let bot = json!({ "playabilityStatus": { "status": "LOGIN_REQUIRED", "reason": "Sign in to confirm you're not a bot" } });
        assert!(matches!(pick(&r, c, &bot), Err(Error::Failed(_))));
    }

    /// Con red: `cargo test native_real -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn native_real() {
        for id in ["jNY_wLukVW0", "nV-F1WSpJIA", "q9IjQAef8VI", "oolpPmuK2I8"] {
            let t = Instant::now();
            let d = resolve(id, true).await.unwrap();
            println!("{id}: {:?} {} {} {}", t.elapsed(), d.client, d.itag, d.title);
        }
        assert!(resolve("xxxxxxxxxxx", true).await.is_err());
    }
}
