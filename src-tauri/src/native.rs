//! Motor propio, nivel rápido: una sola petición a la API interna de YouTube desde Rust, sin
//! programas ni librerías externas. Qué cliente de YouTube se imita y con qué datos va en una
//! receta (`recipe/youtube.json`) queda como reparación excepcional. Si las rutas rápidas
//! fallan, se prueba el cliente web descubierto de YouTube, con renovación acotada y URL
//! verificada. El último respaldo sigue siendo la captura histórica (`capture_legacy.rs`).

use crate::ytdlp::{now, query_param};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, RwLock};
use std::time::{Duration, Instant};

/// La sesión de visitante vale horas; se pide otra antes por si acaso.
const VISITOR_TTL: Duration = Duration::from_secs(3 * 3600);
const BROWSER_UA: &str = crate::youtube::BROWSER_UA;

#[derive(Debug, Clone, Deserialize)]
pub struct Recipe {
    visitor: Fetch,
    player: String,
    clients: Vec<Client>,
    /// Tipos de audio aceptados, de más a menos preferido.
    audio: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
struct Fetch {
    url: String,
    #[serde(default)]
    headers: HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Client {
    name: String,
    id: u32,
    version: String,
    user_agent: String,
    #[serde(default)]
    context: Map<String, Value>,
}

/// Sólo errores estructurales/de cliente abren este circuito. Un vídeo privado,
/// una sonda CDN fallida o una avería de red no deshabilitan otros vídeos.
#[derive(Default)]
struct RouteHealth(Mutex<HashMap<String, Instant>>);
impl RouteHealth {
    fn cooling(&self, key: &str, now: Instant) -> bool {
        let mut failed = self.0.lock().unwrap();
        failed.retain(|_, until| *until > now);
        failed.contains_key(key)
    }
    fn reject(&self, key: String, now: Instant) {
        let mut failed = self.0.lock().unwrap();
        failed.retain(|_, until| *until > now);
        if failed.len() >= 32 {
            if let Some(oldest) = failed
                .iter()
                .min_by_key(|(_, until)| **until)
                .map(|(key, _)| key.clone())
            {
                failed.remove(&oldest);
            }
        }
        failed.insert(key, now + Duration::from_secs(30));
    }
    fn accept(&self, key: &str) {
        self.0.lock().unwrap().remove(key);
    }
}
static ROUTES: LazyLock<RouteHealth> = LazyLock::new(RouteHealth::default);

fn route_key(recipe: &Recipe, client: &Client) -> String {
    use sha2::{Digest, Sha256};
    let data = json!([
        recipe.player,
        recipe.visitor.url,
        client.name,
        client.id,
        client.version,
        client.user_agent,
        client.context
    ]);
    format!("{:x}", Sha256::digest(data.to_string().as_bytes()))
}

fn broken_client(error: &Error) -> bool {
    matches!(error, Error::Failed(message) if message == "NATIVE_PLAYER_SCHEMA"
        || matches!(message.as_str(), "NATIVE_CLIENT_HTTP_400" | "NATIVE_CLIENT_HTTP_401" | "NATIVE_CLIENT_HTTP_403"))
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
/// La receta incluida en la app y la descargada (si hay una más nueva).
static BUNDLED: LazyLock<Recipe> = LazyLock::new(|| {
    serde_json::from_str(crate::extractors::bundled_recipe()).expect("receta incluida")
});
static DOWNLOADED: RwLock<Option<Recipe>> = RwLock::new(None);
static VISITOR: tokio::sync::Mutex<Option<(String, Instant)>> = tokio::sync::Mutex::const_new(None);
static CACHE: LazyLock<Mutex<HashMap<String, Direct>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| http_client().expect("cliente HTTP"));

fn trusted_url_family(url: &reqwest::Url) -> Option<&'static str> {
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
    {
        return None;
    }
    let host = url.host_str()?;
    ["youtube.com", "googlevideo.com"]
        .into_iter()
        .find(|family| host == *family || host.ends_with(&format!(".{family}")))
}

fn redirect_allowed(previous: &[reqwest::Url], next: &reqwest::Url) -> bool {
    // previous incluye la URL inicial: longitudes 1, 2 y 3 son los tres saltos admitidos.
    !previous.is_empty()
        && previous.len() <= 3
        && trusted_url_family(&previous[0]).is_some()
        && trusted_url_family(&previous[0]) == trusted_url_family(next)
}

fn http_client() -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if redirect_allowed(attempt.previous(), attempt.url()) {
                attempt.follow()
            } else {
                attempt.error("NATIVE_REDIRECT_REJECTED")
            }
        }))
        .build()
}

/// Usa una receta descargada (ver `extractors.rs`) si se entiende y sus URLs son de YouTube.
pub fn set_recipe(text: &str) -> Result<(), String> {
    let r: Recipe = serde_json::from_str(text).map_err(|e| format!("receta no válida: {e}"))?;
    let youtube = |u: &str| {
        reqwest::Url::parse(u).is_ok_and(|u| trusted_url_family(&u) == Some("youtube.com"))
    };
    if !youtube(&r.player) || !youtube(&r.visitor.url) || r.clients.is_empty() {
        return Err("receta no válida: URLs que no son de YouTube o sin clientes".into());
    }
    *DOWNLOADED.write().unwrap() = Some(r);
    Ok(())
}

/// URL del audio de un vídeo, ya comprobada (YouTube no la va a cortar a mitad).
pub async fn resolve(video_id: &str, refresh: bool) -> Result<Direct, Error> {
    let started = Instant::now();
    let mut visitor_ms = 0.0;
    let mut player_ms = 0.0;
    let mut validation_ms = 0.0;
    if !refresh
        && let Some(d) = CACHE
            .lock()
            .unwrap()
            .get(video_id)
            .filter(|d| d.expires > now() + 600)
    {
        return Ok(d.clone());
    }
    // Primero la receta descargada y, si con ella no sale, la incluida.
    let recipes: Vec<Recipe> = DOWNLOADED
        .read()
        .unwrap()
        .iter()
        .cloned()
        .chain([BUNDLED.clone()])
        .collect();
    let mut attempts = Vec::new();
    let mut clients: Vec<(usize, usize, &Recipe, &Client)> = Vec::new();
    for (ri, recipe) in recipes.iter().enumerate() {
        for (ci, client) in recipe.clients.iter().enumerate() {
            if !clients.iter().any(|(_, _, other, candidate)| {
                other.player == recipe.player
                    && other.visitor == recipe.visitor
                    && other.audio == recipe.audio
                    && *candidate == client
            }) {
                clients.push((ri, ci, recipe, client));
            }
        }
    }
    for (recipe_index, client_index, recipe, client) in clients {
        let key = route_key(recipe, client);
        if ROUTES.cooling(&key, Instant::now()) {
            attempts.push(ReferenceAttempt {
                recipe: recipe_index,
                client: client_index,
                attempt: 0,
                stage: "player",
                code: "client-cooling".into(),
            });
            continue;
        }
        // Segundo intento con sesión de visitante nueva y otra URL.
        for attempt in 0..2 {
            let mut record = |stage, error: &str, gone| {
                attempts.push(ReferenceAttempt {
                    recipe: recipe_index,
                    client: client_index,
                    attempt,
                    stage,
                    code: reference_code(stage, error, gone),
                })
            };
            let stage = Instant::now();
            let visitor = match visitor(recipe, attempt > 0).await {
                Ok(v) => v,
                Err(e) => {
                    visitor_ms += stage.elapsed().as_secs_f64() * 1000.0;
                    record("visitor", &e, false);
                    continue;
                }
            };
            visitor_ms += stage.elapsed().as_secs_f64() * 1000.0;
            let stage = Instant::now();
            let result = player(recipe, client, video_id, &visitor).await;
            player_ms += stage.elapsed().as_secs_f64() * 1000.0;
            match result {
                Ok(d) => {
                    let stage = Instant::now();
                    let validation = validate(&d).await;
                    validation_ms += stage.elapsed().as_secs_f64() * 1000.0;
                    match validation {
                        Ok(()) => {
                            ROUTES.accept(&key);
                            if std::env::var_os("MUSIFY_BENCH").is_some() {
                                eprintln!(
                                    "[native-resolution] {}",
                                    json!({ "success": true, "failures": resolution_failures(&attempts) })
                                );
                                eprintln!(
                                    "[native-timing] {video_id} totalMs={:.3} visitorMs={visitor_ms:.3} playerMs={player_ms:.3} validationMs={validation_ms:.3}",
                                    started.elapsed().as_secs_f64() * 1000.0
                                );
                            }
                            STATS.resolved.fetch_add(1, Ordering::Relaxed);
                            CACHE
                                .lock()
                                .unwrap()
                                .insert(video_id.to_string(), d.clone());
                            return Ok(d);
                        }
                        Err(e) => {
                            record("validation", &e, false);
                            STATS.replaced.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                }
                // Otro cliente podría reproducirlo; si ninguno puede, se devuelve esto.
                Err(Error::Gone(e)) => {
                    record("player", &e, true);
                    break;
                }
                Err(e) => {
                    record("player", &e.to_string(), false);
                    if broken_client(&e) {
                        ROUTES.reject(key.clone(), Instant::now());
                        break;
                    }
                }
            }
        }
    }
    // El cliente WEB se obtiene de YouTube, no de números de versión publicados
    // por nosotros. Se mantiene separado de VISIONOS y sólo se acepta audio directo
    // cuya identidad, dominio y sonda de acceso son válidos.
    let last = match tokio::time::timeout(Duration::from_secs(6), auto_direct(video_id)).await {
        Ok(Ok(d)) => {
            if std::env::var_os("MUSIFY_BENCH").is_some() {
                eprintln!("[native-auto] {}", json!({"success":true,"client":"WEB"}));
            }
            STATS.resolved.fetch_add(1, Ordering::Relaxed);
            CACHE
                .lock()
                .unwrap()
                .insert(video_id.to_string(), d.clone());
            return Ok(d);
        }
        result => {
            let error = match result {
                Err(_) => Error::Failed("NATIVE_AUTO_TIMEOUT".into()),
                Ok(Err(error)) => error,
                _ => unreachable!(),
            };
            if std::env::var_os("MUSIFY_BENCH").is_some() {
                let code: String = match error.to_string().as_str() {
                    "NATIVE_AUTO_TIMEOUT" => "auto-timeout".into(),
                    "NATIVE_AUTO_CONFIG_UNAVAILABLE" => "auto-config-unavailable".into(),
                    "NATIVE_AUTO_REFRESH_UNAVAILABLE" => "auto-refresh-unavailable".into(),
                    _ => reference_code(
                        "player",
                        &error.to_string(),
                        matches!(error, Error::Gone(_)),
                    ),
                };
                eprintln!("[native-auto] {}", json!({"success":false,"code":code}));
            }
            // El banco conserva aparte los errores de las recetas anteriores.
            error
        }
    };
    STATS.failed.fetch_add(1, Ordering::Relaxed);
    if std::env::var_os("MUSIFY_BENCH").is_some() {
        eprintln!(
            "[native-resolution] {}",
            json!({ "success": false, "failures": resolution_failures(&attempts) })
        );
    }
    Err(last)
}

/// Solapa la preparación del visitante con la búsqueda de Propio. No selecciona
/// vídeos ni toca URLs; la resolución conserva la sonda del audio y sus errores.
pub async fn warm_visitor() {
    let recipe = DOWNLOADED
        .read()
        .unwrap()
        .clone()
        .unwrap_or_else(|| BUNDLED.clone());
    let _ = tokio::join!(
        visitor(&recipe, false),
        crate::youtube_session::warm(crate::youtube_session::Surface::Music)
    );
}

async fn auto_direct(video_id: &str) -> Result<Direct, Error> {
    use crate::youtube_session::{self, Surface};
    let config = youtube_session::current(Surface::Web)
        .await
        .map_err(|_| Error::Failed("NATIVE_AUTO_CONFIG_UNAVAILABLE".into()))?;
    auto_direct_with_session(
        config,
        |config| async move {
            let (recipe, client) = web_recipe(&config);
            let visitor = match &config.visitor_data {
                Some(visitor) => visitor.clone(),
                None => visitor(&recipe, false).await.map_err(Error::Failed)?,
            };
            let d = player(&recipe, &client, video_id, &visitor).await?;
            validate(&d).await.map_err(Error::Failed)?;
            Ok(d)
        },
        |previous| async move { youtube_session::refresh(Surface::Web, &previous).await },
    )
    .await
}

fn web_recipe(config: &crate::youtube_session::Config) -> (Recipe, Client) {
    let client = Client {
        name: config.client_name.clone(),
        id: config.client_id,
        version: config.client_version.clone(),
        user_agent: config.user_agent.clone(),
        context: config.client_context.clone(),
    };
    let recipe = Recipe {
        visitor: BUNDLED.visitor.clone(),
        player: format!(
            "https://www.youtube.com/youtubei/{}/player?prettyPrint=false",
            config.api_version
        ),
        clients: vec![client.clone()],
        audio: BUNDLED.audio.clone(),
    };
    (recipe, client)
}

/// Una renovación como máximo; el caller mantiene el plazo de seis segundos que
/// abarca también current(), ambos POST y sus sondas. Las dependencias son locales,
/// de modo que los tests de transporte no sustituyen cachés ni endpoints globales.
async fn auto_direct_with_session<A, AF, R, RF>(
    config: crate::youtube_session::Config,
    attempt: A,
    refresh: R,
) -> Result<Direct, Error>
where
    A: Fn(crate::youtube_session::Config) -> AF,
    AF: Future<Output = Result<Direct, Error>>,
    R: FnOnce(crate::youtube_session::Config) -> RF,
    RF: Future<Output = Result<crate::youtube_session::Config, String>>,
{
    match attempt(config.clone()).await {
        Ok(d) => Ok(d),
        Err(error @ Error::Gone(_)) => Err(error),
        Err(error) => {
            let refreshed = refresh(config.clone())
                .await
                .map_err(|_| Error::Failed("NATIVE_AUTO_REFRESH_UNAVAILABLE".into()))?;
            if refreshed == config {
                return Err(error);
            }
            attempt(refreshed).await
        }
    }
}

#[derive(Debug, Serialize)]
struct ReferenceAttempt {
    recipe: usize,
    client: usize,
    attempt: usize,
    stage: &'static str,
    code: String,
}

// Native transport errors may contain a signed URL, and server reasons may contain
// arbitrary text. Only these local categories cross into benchmark evidence.
fn reference_code(stage: &str, error: &str, gone: bool) -> String {
    if gone {
        return "video-unavailable".into();
    }
    if stage == "visitor" {
        return if error == "YouTube no dio sesión de visitante" {
            "visitor-missing"
        } else {
            "visitor-transport"
        }
        .into();
    }
    if stage == "validation" {
        if let Some(status) = error
            .strip_prefix("YouTube cortaría el audio (")
            .and_then(|s| s.strip_suffix(')'))
            .filter(|s| s.len() == 3 && s.bytes().all(|b| b.is_ascii_digit()))
        {
            return format!("cdn-http-{status}");
        }
        return "cdn-transport".into();
    }
    if error.ends_with(": sin audio con URL directa") {
        "no-compatible-direct-audio"
    } else if error.starts_with("YouTube:") {
        "player-playability-rejected"
    } else {
        "player-response-or-transport"
    }
    .into()
}

fn resolution_failures(attempts: &[ReferenceAttempt]) -> Value {
    // Report bounded, safe metadata, never visitor data, recipe names or raw errors.
    let last = &attempts[attempts.len().saturating_sub(8)..];
    json!({ "totalAttempts": attempts.len(), "truncated": attempts.len() > 8, "attempts": last })
}

fn reference_failure(attempts: &[ReferenceAttempt]) -> String {
    format!(
        "REFERENCE_RESOLUTION_FAILED {}",
        resolution_failures(attempts)
    )
}

/// Referencia independiente del banco. No escribe la caché de reproducción ni usa cookies.
/// La selección debe coincidir con el contenedor/códec capturado para comparar paquetes exactos.
pub async fn reference(
    video_id: &str,
    mime: Option<&str>,
    itag: Option<u64>,
) -> Result<Direct, String> {
    if std::env::var_os("MUSIFY_BENCH").is_none() {
        return Err("Referencia sólo disponible en pruebas".into());
    }
    let recipes: Vec<Recipe> = DOWNLOADED
        .read()
        .unwrap()
        .iter()
        .cloned()
        .chain([BUNDLED.clone()])
        .collect();
    let mut attempts = Vec::new();
    for (recipe_index, recipe) in recipes.iter().enumerate() {
        for (client_index, client) in recipe.clients.iter().enumerate() {
            // Match the fast resolver's bounded retry with a fresh anonymous
            // visitor. A stale visitor or failed URL cannot poison every check.
            for attempt in 0..2 {
                let mut record = |stage, error: &str, gone| {
                    attempts.push(ReferenceAttempt {
                        recipe: recipe_index,
                        client: client_index,
                        attempt,
                        stage,
                        code: reference_code(stage, error, gone),
                    })
                };
                let visitor = match visitor(recipe, attempt > 0).await {
                    Ok(v) => v,
                    Err(e) => {
                        record("visitor", &e, false);
                        continue;
                    }
                };
                match player_with_preference(recipe, client, video_id, &visitor, mime, itag).await {
                    Ok(d) => match validate(&d).await {
                        Ok(()) => {
                            eprintln!(
                                "[reference-resolution] {}",
                                json!({
                                    "recipe": recipe_index, "client": client_index, "attempt": attempt,
                                    "previousFailureCount": attempts.len(), "truncated": attempts.len() > 8,
                                    "previousFailures": &attempts[attempts.len().saturating_sub(8)..],
                                })
                            );
                            return Ok(d);
                        }
                        Err(e) => record("validation", &e, false),
                    },
                    Err(Error::Gone(e)) => {
                        record("player", &e, true);
                        break;
                    }
                    Err(e) => record("player", &e.to_string(), false),
                }
            }
        }
    }
    Err(reference_failure(&attempts))
}

pub fn bench_forget(video_id: &str) -> Result<(), String> {
    if std::env::var_os("MUSIFY_BENCH").is_none() {
        return Err("Reinicio sólo disponible en pruebas".into());
    }
    CACHE.lock().unwrap().remove(video_id);
    Ok(())
}

async fn visitor(recipe: &Recipe, fresh: bool) -> Result<String, String> {
    let mut slot = VISITOR.lock().await;
    if !fresh && let Some((v, _)) = slot.as_ref().filter(|(_, at)| at.elapsed() < VISITOR_TTL) {
        return Ok(v.clone());
    }
    let mut req = HTTP
        .get(&recipe.visitor.url)
        .header("User-Agent", BROWSER_UA);
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

/// El primer campo del protobuf de visitante es un identificador de 11 caracteres.
/// Su base64 puede empezar por Cgs o Cgt según el primer carácter: validar el campo
/// decodificado evita rechazar identificadores que empiezan por dígito o guion.
fn find_visitor(text: &str) -> Option<String> {
    use base64::Engine;
    text.split('"')
        .find(|s| {
            if s.len() < 20
                || !s
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_%=".contains(&b))
            {
                return false;
            }
            let encoded = s.replace("%3D", "=").replace("%3d", "=");
            base64::engine::general_purpose::URL_SAFE
                .decode(&encoded)
                .or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(&encoded))
                .is_ok_and(|bytes| {
                    bytes.get(..2) == Some(&[0x0a, 11])
                        && bytes.get(2..13).is_some_and(|id| {
                            id.iter()
                                .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(b))
                        })
                })
        })
        .map(String::from)
}

async fn player(
    recipe: &Recipe,
    c: &Client,
    video_id: &str,
    visitor: &str,
) -> Result<Direct, Error> {
    player_with_preference(recipe, c, video_id, visitor, None, None).await
}

async fn player_with_preference(
    recipe: &Recipe,
    c: &Client,
    video_id: &str,
    visitor: &str,
    mime: Option<&str>,
    itag: Option<u64>,
) -> Result<Direct, Error> {
    player_with_http(&HTTP, recipe, c, video_id, visitor, mime, itag).await
}

async fn player_with_http(
    http: &reqwest::Client,
    recipe: &Recipe,
    c: &Client,
    video_id: &str,
    visitor: &str,
    mime: Option<&str>,
    itag: Option<u64>,
) -> Result<Direct, Error> {
    let body = player_body(c, video_id, visitor);
    let res = http
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
        .map_err(|_| Error::Failed("NATIVE_PLAYER_TRANSPORT".into()))?;
    if !res.status().is_success() {
        return Err(Error::Failed(format!(
            "NATIVE_CLIENT_HTTP_{}",
            res.status().as_u16()
        )));
    }
    let text = res
        .text()
        .await
        .map_err(|_| Error::Failed("NATIVE_PLAYER_TRANSPORT".into()))?;
    let j: Value =
        serde_json::from_str(&text).map_err(|_| Error::Failed("NATIVE_PLAYER_SCHEMA".into()))?;
    pick_identified(recipe, c, &j, video_id, mime, itag)
}

fn player_body(c: &Client, video_id: &str, visitor: &str) -> Value {
    let mut client = c.context.clone();
    client.insert("clientName".into(), json!(c.name));
    client.insert("clientVersion".into(), json!(c.version));
    client.insert("userAgent".into(), json!(c.user_agent));
    client.insert("hl".into(), json!("en"));
    client.insert("visitorData".into(), json!(visitor));
    json!({
        "context": { "client": client },
        "videoId": video_id,
        "contentCheckOk": true,
        "racyCheckOk": true,
        "playbackContext": { "contentPlaybackContext": { "vis": 0, "splay": false, "lactMilliseconds": "-1" } },
    })
}

fn pick_identified(
    recipe: &Recipe,
    client: &Client,
    value: &Value,
    video_id: &str,
    mime: Option<&str>,
    itag: Option<u64>,
) -> Result<Direct, Error> {
    let status = value
        .pointer("/playabilityStatus/status")
        .and_then(Value::as_str)
        .filter(|status| !status.is_empty())
        .ok_or_else(|| Error::Failed("NATIVE_PLAYER_SCHEMA".into()))?;
    if status == "OK" {
        if value
            .pointer("/videoDetails/videoId")
            .and_then(Value::as_str)
            != Some(video_id)
        {
            return Err(Error::Failed("NATIVE_VIDEO_IDENTITY".into()));
        }
        if value
            .pointer("/streamingData/adaptiveFormats")
            .and_then(Value::as_array)
            .is_none()
        {
            return Err(Error::Failed("NATIVE_PLAYER_SCHEMA".into()));
        }
    }
    pick_with_preference(recipe, client, value, mime, itag)
}

fn direct_audio_url(url: &str) -> bool {
    reqwest::Url::parse(url).is_ok_and(|url| trusted_url_family(&url) == Some("googlevideo.com"))
}

/// Elige el audio de la respuesta de YouTube: solo audio, con URL directa, sin compresión de rango
/// dinámico, en la pista de idioma por defecto, y del tipo preferido con más calidad.
#[cfg(test)]
fn pick(recipe: &Recipe, c: &Client, j: &Value) -> Result<Direct, Error> {
    pick_with_preference(recipe, c, j, None, None)
}

fn pick_with_preference(
    recipe: &Recipe,
    c: &Client,
    j: &Value,
    wanted_mime: Option<&str>,
    wanted_itag: Option<u64>,
) -> Result<Direct, Error> {
    let status = j["playabilityStatus"]["status"].as_str().unwrap_or("");
    let reason = j["playabilityStatus"]["reason"]
        .as_str()
        .unwrap_or(status)
        .to_string();
    match status {
        "OK" => {}
        "UNPLAYABLE" | "ERROR" => return Err(Error::Gone(format!("Video unavailable: {reason}"))),
        _ => return Err(Error::Failed(format!("YouTube: {reason}"))),
    }
    let rank = |mime: &str| {
        recipe
            .audio
            .iter()
            .position(|a| mime.starts_with(a.as_str()))
    };
    let best = j["streamingData"]["adaptiveFormats"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|f| {
            let mime = f["mimeType"].as_str().unwrap_or("");
            rank(mime).is_some()
                && f["url"].as_str().is_some_and(direct_audio_url)
                && !f["isDrc"].as_bool().unwrap_or(false)
                && f["audioTrack"]["audioIsDefault"].as_bool().unwrap_or(true)
                && wanted_itag.is_none_or(|itag| f["itag"].as_u64() == Some(itag))
                && wanted_mime.is_none_or(|wanted| mime_family(mime) == mime_family(wanted))
        })
        .min_by_key(|f| {
            (
                rank(f["mimeType"].as_str().unwrap_or("")),
                std::cmp::Reverse(f["bitrate"].as_u64().unwrap_or(0)),
            )
        })
        .ok_or_else(|| Error::Failed(format!("{}: sin audio con URL directa", c.name)))?;

    let url = best["url"].as_str().unwrap_or_default().to_string();
    let details = &j["videoDetails"];
    Ok(Direct {
        expires: query_param(&url, "expire")
            .and_then(|e| e.parse().ok())
            .unwrap_or(now() + 3 * 3600),
        title: details["title"].as_str().unwrap_or_default().to_string(),
        channel: details["author"].as_str().map(String::from),
        duration: details["lengthSeconds"]
            .as_str()
            .and_then(|s| s.parse().ok()),
        client: c.name.clone(),
        itag: best["itag"].as_u64().unwrap_or(0),
        mime: best["mimeType"].as_str().unwrap_or_default().to_string(),
        url,
    })
}

fn mime_family(mime: &str) -> String {
    mime.to_ascii_lowercase()
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_string()
}

/// Pide 1 KB hacia el 80 % del audio: es donde YouTube corta (403) las URLs que no va a servir
/// enteras. Así se cambia antes de usarla en vez de a mitad de la canción.
async fn validate(d: &Direct) -> Result<(), String> {
    validate_with_http(&HTTP, d).await
}

async fn validate_with_http(http: &reqwest::Client, d: &Direct) -> Result<(), String> {
    tokio::time::timeout(Duration::from_secs(2), probe_audio(http, d))
        .await
        .map_err(|_| "NATIVE_CDN_TIMEOUT".to_string())?
}

async fn probe_audio(http: &reqwest::Client, d: &Direct) -> Result<(), String> {
    let len: u64 = query_param(&d.url, "clen")
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    let at = len / 10 * 8 + (len % 10) * 8 / 10;
    let mut res = http
        .get(&d.url)
        .header("Range", format!("bytes={at}-{}", at + 1023))
        .send()
        .await
        .map_err(|_| "NATIVE_CDN_TRANSPORT".to_string())?;
    let status = res.status().as_u16();
    if !matches!(status, 200 | 206) {
        return Err(format!("YouTube cortaría el audio ({status})"));
    }
    let range_length = if status == 206 {
        let invalid = || "NATIVE_CDN_RANGE".to_string();
        let header = res
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|h| h.to_str().ok())
            .ok_or_else(invalid)?;
        let (range, total) = header
            .strip_prefix("bytes ")
            .and_then(|v| v.split_once('/'))
            .ok_or_else(invalid)?;
        let (start, end) = range.split_once('-').ok_or_else(invalid)?;
        let start: u64 = start.parse().map_err(|_| invalid())?;
        let end: u64 = end.parse().map_err(|_| invalid())?;
        let total = if total == "*" {
            None
        } else {
            Some(total.parse::<u64>().map_err(|_| invalid())?)
        };
        if start != at
            || end < start
            || end > at + 1023
            || total.is_some_and(|total| end >= total)
            || (len > 0 && total != Some(len))
        {
            return Err(invalid());
        }
        let length = end - start + 1;
        if res
            .content_length()
            .is_some_and(|declared| declared != length)
        {
            return Err(invalid());
        }
        Some(length as usize)
    } else {
        None
    };
    if res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .map(str::to_ascii_lowercase)
        .is_some_and(|mime| {
            mime.starts_with("text/") || mime.contains("json") || mime.contains("html")
        })
    {
        return Err("NATIVE_CDN_NOT_AUDIO".into());
    }
    // Lee hasta 1 KiB o un rango corto completo, para detectar truncamiento después
    // del primer chunk. Un 200 puede ignorar Range: sólo acredita acceso al prefijo,
    // no al 80 % solicitado ni a EOF; nunca se descarga la canción entera aquí.
    let required = range_length.unwrap_or(1024);
    let mut received = 0;
    loop {
        match res
            .chunk()
            .await
            .map_err(|_| "NATIVE_CDN_TRANSPORT".to_string())?
        {
            Some(bytes) => {
                received += bytes.len();
                if received >= required {
                    return Ok(());
                }
            }
            None if range_length.is_some_and(|required| received < required) => {
                return Err("NATIVE_CDN_TRANSPORT".into());
            }
            None if received > 0 => return Ok(()),
            None => return Err("NATIVE_CDN_EMPTY".into()),
        }
    }
}

#[cfg(test)]
#[path = "native_adaptive_tests.rs"]
mod adaptive_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_recipe_parses() {
        let r: Recipe = serde_json::from_str(crate::extractors::bundled_recipe()).unwrap();
        assert!(!r.clients.is_empty());
    }

    #[test]
    fn structural_client_failure_is_temporary_and_does_not_disable_a_video_or_repaired_recipe() {
        let health = RouteHealth::default();
        let now = Instant::now();
        assert!(broken_client(&Error::Failed("NATIVE_PLAYER_SCHEMA".into())));
        assert!(broken_client(&Error::Failed(
            "NATIVE_CLIENT_HTTP_403".into()
        )));
        for error in [
            Error::Gone("privado".into()),
            Error::Failed("YouTube cortaría el audio (403)".into()),
            Error::Failed("NATIVE_PLAYER_TRANSPORT".into()),
            Error::Failed("NATIVE_VIDEO_IDENTITY".into()),
        ] {
            assert!(!broken_client(&error));
        }
        let mut recipe: Recipe = serde_json::from_str(crate::extractors::bundled_recipe()).unwrap();
        let original = route_key(&recipe, &recipe.clients[0]);
        health.reject(original.clone(), now);
        assert!(health.cooling(&original, now + Duration::from_secs(29)));
        recipe.clients[0]
            .context
            .insert("osVersion".into(), json!("updated"));
        let repaired = route_key(&recipe, &recipe.clients[0]);
        assert_ne!(original, repaired);
        assert!(!health.cooling(&repaired, now));
        assert!(!health.cooling(&original, now + Duration::from_secs(30)));
        health.reject(original.clone(), now);
        health.accept(&original);
        assert!(!health.cooling(&original, now));
    }

    #[test]
    fn live_web_identity_stays_web_and_audio_cannot_be_cached_for_a_different_video() {
        let recipe: Recipe = serde_json::from_str(crate::extractors::bundled_recipe()).unwrap();
        let web = Client {
            name: "WEB".into(),
            id: 1,
            version: "current".into(),
            user_agent: "browser".into(),
            context: Map::new(),
        };
        let body = player_body(&web, "jNY_wLukVW0", "visitor");
        assert_eq!(body["context"]["client"]["clientName"], "WEB");
        assert_eq!(body["context"]["client"]["clientVersion"], "current");
        assert_eq!(body["context"]["client"]["visitorData"], "visitor");
        assert!(body["context"]["client"].get("deviceModel").is_none());
        let mut response = json!({"playabilityStatus":{"status":"OK"},
            "videoDetails":{"videoId":"jNY_wLukVW0","title":"Song"},
            "streamingData":{"adaptiveFormats":[{"itag":251,"mimeType":"audio/webm", "url":"https://r1.googlevideo.com/videoplayback?clen=2000"}]}});
        assert!(pick_identified(&recipe, &web, &response, "jNY_wLukVW0", None, None).is_ok());
        response["videoDetails"]["videoId"] = json!("other-video");
        assert_eq!(
            pick_identified(&recipe, &web, &response, "jNY_wLukVW0", None, None)
                .unwrap_err()
                .to_string(),
            "NATIVE_VIDEO_IDENTITY"
        );
        response["videoDetails"]
            .as_object_mut()
            .unwrap()
            .remove("videoId");
        assert!(pick_identified(&recipe, &web, &response, "jNY_wLukVW0", None, None).is_err());
        for url in [
            "http://r1.googlevideo.com/a",
            "https://googlevideo.com.evil.test/a",
            "https://user:password@r1.googlevideo.com/a",
            "https://www.youtube.com/a",
            "https://r1.googlevideo.com:444/a",
        ] {
            assert!(!direct_audio_url(url));
        }
    }

    #[test]
    fn reference_diagnostics_keep_categories_without_transport_or_account_data() {
        let sensitive = "https://x.googlevideo.com/videoplayback?token=private-account-token";
        let inputs = [
            (
                "visitor",
                "YouTube no dio sesión de visitante",
                false,
                "visitor-missing",
            ),
            ("visitor", sensitive, false, "visitor-transport"),
            (
                "player",
                "private-client: sin audio con URL directa",
                false,
                "no-compatible-direct-audio",
            ),
            (
                "player",
                "YouTube: private-account-token",
                false,
                "player-playability-rejected",
            ),
            ("player", sensitive, false, "player-response-or-transport"),
            ("player", sensitive, true, "video-unavailable"),
            (
                "validation",
                "YouTube cortaría el audio (403)",
                false,
                "cdn-http-403",
            ),
            (
                "validation",
                "YouTube cortaría el audio (403) private-account-token",
                false,
                "cdn-transport",
            ),
            ("validation", sensitive, false, "cdn-transport"),
        ];
        let attempts: Vec<_> = inputs
            .into_iter()
            .enumerate()
            .map(|(i, (stage, error, gone, expected))| {
                let code = reference_code(stage, error, gone);
                assert_eq!(code, expected);
                ReferenceAttempt {
                    recipe: 0,
                    client: 0,
                    attempt: i,
                    stage,
                    code,
                }
            })
            .collect();
        let diagnostic = reference_failure(&attempts);
        assert!(!diagnostic.contains("private-"));
        assert!(!diagnostic.contains("https://"));
        let report: Value = serde_json::from_str(
            diagnostic
                .strip_prefix("REFERENCE_RESOLUTION_FAILED ")
                .unwrap(),
        )
        .unwrap();
        assert_eq!(report["attempts"].as_array().unwrap().len(), 8);
        assert_eq!(report["totalAttempts"], 9);
        assert_eq!(report["truncated"], true);
        assert_eq!(report["attempts"][0]["attempt"], 1);
        assert_eq!(report["attempts"][7]["code"], "cdn-transport");
    }

    #[test]
    fn finds_visitor_anywhere() {
        let text = r#")]}'[["a",["Cg","x"],[[["es","ES",null,"CgtBQkNERUZHSElKSxABGAE%3D",0]]]]]"#;
        assert_eq!(
            find_visitor(text).as_deref(),
            Some("CgtBQkNERUZHSElKSxABGAE%3D")
        );
        assert_eq!(find_visitor(r#"["Cg","nada"]"#), None);
    }

    #[test]
    fn visitor_identifiers_accept_every_url_safe_initial_and_padding_form() {
        use base64::Engine;
        for first in b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_" {
            let mut bytes = vec![0x0a, 11, *first];
            bytes.extend_from_slice(b"bcdefghijk");
            bytes.extend_from_slice(&[0x10, 1, 0x18, 1]);
            let unpadded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&bytes);
            let padded = base64::engine::general_purpose::URL_SAFE.encode(&bytes);
            for token in [
                &unpadded,
                &padded,
                &padded.replace('=', "%3D"),
                &padded.replace('=', "%3d"),
            ] {
                assert_eq!(
                    find_visitor(&format!(r#"["ignored","{token}",null]"#)).as_deref(),
                    Some(token.as_str())
                );
            }
        }
    }

    #[test]
    fn visitor_detection_rejects_prefix_lookalikes_and_malformed_identifier_fields() {
        use base64::Engine;
        for bytes in [
            vec![0x0a, 11],
            b"\x12\x0babcdefghijk\x10\x01".to_vec(),
            b"\x0a\x0aabcdefghijk\x10\x01".to_vec(),
            b"\x0a\x0babc!efghijk\x10\x01".to_vec(),
        ] {
            let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
            assert!(find_visitor(&format!(r#"["{token}"]"#)).is_none());
        }
        for token in [
            "Cgt_this_is_not_a_visitor",
            "CgtAAAAAAAAAAAAAAAAAAA%XX",
            "CgsAAAAAAAAAAAAAAAAAAA",
            "CgtBQkNERUZHSElKSyiAgICAgICA%3D%3D",
        ] {
            assert!(find_visitor(&format!(r#"["{token}"]"#)).is_none());
        }
    }

    #[test]
    fn picks_opus_then_m4a() {
        let r: Recipe = serde_json::from_str(crate::extractors::bundled_recipe()).unwrap();
        let c = &r.clients[0];
        let resp = |formats: Value| json!({ "playabilityStatus": { "status": "OK" }, "streamingData": { "adaptiveFormats": formats }, "videoDetails": { "title": "T", "author": "A", "lengthSeconds": "200" } });
        let f = |itag: u64, mime: &str, bitrate: u64| json!({ "itag": itag, "mimeType": mime, "bitrate": bitrate, "url": format!("https://x.googlevideo.com/videoplayback?itag={itag}&clen=100") });
        let both = resp(json!([
            f(140, "audio/mp4; codecs=\"mp4a.40.2\"", 130000),
            f(251, "audio/webm; codecs=\"opus\"", 140000),
            f(250, "audio/webm; codecs=\"opus\"", 70000),
            f(137, "video/mp4", 4000000)
        ]));
        assert_eq!(pick(&r, c, &both).unwrap().itag, 251);
        assert_eq!(
            pick_with_preference(&r, c, &both, Some("audio/mp4"), None)
                .unwrap()
                .itag,
            140
        );
        assert_eq!(
            pick_with_preference(&r, c, &both, Some("audio/webm"), Some(250))
                .unwrap()
                .itag,
            250
        );
        assert!(pick_with_preference(&r, c, &both, Some("audio/mp4"), Some(251)).is_err());
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
            println!(
                "{id}: {:?} {} {} {}",
                t.elapsed(),
                d.client,
                d.itag,
                d.title
            );
        }
        assert!(resolve("xxxxxxxxxxx", true).await.is_err());
    }
}
