//! Anonymous, explicitly made-for-kids fallback. Discovery never runs remote JS.
//! The decoder evaluates only locally extracted functions; no account or cookie jar.
use super::*;
use crate::youtube_decoder::{self, PreparedDecoder};
use sha2::{Digest, Sha256};
use std::sync::Arc;

const LIMIT: usize = 4 * 1024 * 1024;
const TTL: Duration = Duration::from_secs(6 * 3600);
// Different embed experiments can publish different players for the same album.
// Keep four prepared scripts (at most 8 MiB), never their temporary JS runtimes.
const MAX_DECODERS: usize = 4;
const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.5 Safari/605.1.15,gzip(gfe)";
const PLAYER: &str = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const NOTICE: &str = "Miniplayer is off for videos made for kids. Tap play to resume";
const NOTICE_PATH: &str = "/playabilityStatus/miniplayer/miniplayerRenderer/minimizedEndpoint/openPopupAction/popup/notificationActionRenderer/responseText/simpleText";

#[cfg(test)]
static TRACE_FIXTURES: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(test)]
fn fixture_file(id: Option<&str>, name: &str) -> Option<std::path::PathBuf> {
    if !TRACE_FIXTURES.load(Ordering::Relaxed)
        || id.is_some_and(|id| !valid_id(id))
        || !name.ends_with(".local")
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-._".contains(&b))
    {
        return None;
    }
    let mut dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .join("capture-bench.local/kids-failed-fixture.local");
    if let Some(id) = id {
        dir = dir.join(format!("{id}.local"));
    }
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(name))
}

#[cfg(test)]
fn save_private_fixture(id: Option<&str>, name: &str, bytes: &[u8]) {
    if let Some(path) = fixture_file(id, name) {
        let _ = std::fs::write(path, bytes);
    }
}

fn validation_code(error: &str) -> String {
    match error {
        "NATIVE_CDN_TIMEOUT" | "NATIVE_EMBEDDED_CDN_TIMEOUT" => "cdn-timeout".into(),
        "NATIVE_CDN_RANGE" | "NATIVE_EMBEDDED_CDN_RANGE" => "cdn-range".into(),
        "NATIVE_CDN_NOT_AUDIO" | "NATIVE_EMBEDDED_CDN_MIME" => "cdn-mime".into(),
        "NATIVE_EMBEDDED_CDN_ENCODING" => "cdn-encoding".into(),
        "NATIVE_CDN_EMPTY" => "cdn-empty".into(),
        "NATIVE_EMBEDDED_CDN_TRUNCATED" => "cdn-truncated".into(),
        _ => {
            if let Some(status) = error
                .strip_prefix("NATIVE_EMBEDDED_CDN_HTTP_")
                .filter(|v| v.len() == 3 && v.bytes().all(|b| b.is_ascii_digit()))
            {
                return format!("cdn-http-{status}");
            }
            reference_code("validation", error, false)
        }
    }
}

fn probe_diagnostic(id: &str, itag: u64, stage: &'static str, error: &str) {
    let enabled = std::env::var_os("MUSIFY_BENCH").is_some();
    #[cfg(test)]
    let enabled = enabled || TRACE_FIXTURES.load(Ordering::Relaxed);
    if enabled {
        eprintln!(
            "[native-embedded-probe] {}",
            json!({"id":id,"itag":itag,"stage":stage,"code":validation_code(error)})
        );
    }
}

fn fail(code: &str) -> Error {
    Error::Failed(format!("NATIVE_EMBEDDED_{code}"))
}

fn valid_id(id: &str) -> bool {
    id.len() == 11
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

fn youtube_url(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("www.youtube.com")
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
}

fn player_url(value: &str) -> Result<reqwest::Url, Error> {
    let url = reqwest::Url::parse("https://www.youtube.com/")
        .unwrap()
        .join(value)
        .map_err(|_| fail("PLAYER_URL"))?;
    let parts: Vec<_> = url.path().split('/').collect();
    if !youtube_url(&url)
        || url.query().is_some()
        || !url.path().starts_with("/s/player/")
        || !url.path().ends_with("/base.js")
        || parts.len() < 5
        || !(8..=32).contains(&parts[3].len())
        || !parts[3].bytes().all(|b| b.is_ascii_alphanumeric())
        || parts.iter().any(|p| *p == "." || *p == "..")
        || !url
            .path()
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/_.-".contains(&b))
    {
        return Err(fail("PLAYER_URL"));
    }
    Ok(url)
}

static WEB: LazyLock<Result<reqwest::Client, Error>> = LazyLock::new(|| {
    reqwest::Client::builder()
        .user_agent(UA)
        .no_gzip()
        .timeout(Duration::from_secs(4))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() <= 2
                && attempt.previous().iter().all(youtube_url)
                && youtube_url(attempt.url())
            {
                attempt.follow()
            } else {
                attempt.error("NATIVE_EMBEDDED_REDIRECT")
            }
        }))
        .build()
        .map_err(|_| fail("HTTP"))
});

// Encoded byte ranges must remain encoded. The fast clients' shared HTTP settings
// are independent; only this stricter embedded validator disables decompression.
static CDN: LazyLock<Result<reqwest::Client, Error>> = LazyLock::new(|| {
    reqwest::Client::builder()
        .no_gzip()
        .timeout(Duration::from_secs(2))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if redirect_allowed(attempt.previous(), attempt.url()) {
                attempt.follow()
            } else {
                attempt.error("NATIVE_EMBEDDED_REDIRECT")
            }
        }))
        .build()
        .map_err(|_| fail("HTTP"))
});

async fn text_response(mut response: reqwest::Response) -> Result<String, Error> {
    if !response.status().is_success() {
        return Err(fail("HTTP_STATUS"));
    }
    if response.content_length().is_some_and(|n| n > LIMIT as u64) {
        return Err(fail("SIZE"));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| fail("TRANSPORT"))? {
        if chunk.len() > LIMIT.saturating_sub(body.len()) {
            return Err(fail("SIZE"));
        }
        body.extend_from_slice(&chunk);
    }
    String::from_utf8(body).map_err(|_| fail("UTF8"))
}

async fn get(http: &reqwest::Client, url: reqwest::Url) -> Result<String, Error> {
    if !youtube_url(&url) {
        return Err(fail("ORIGIN"));
    }
    text_response(
        http.get(url)
            .header("Accept-Language", "en")
            .header("Accept-Encoding", "identity")
            .header("Referer", "https://www.reddit.com/")
            .send()
            .await
            .map_err(|_| fail("TRANSPORT"))?,
    )
    .await
}

// Parse JSON values, never evaluate an assignment or arbitrary HTML/script text.
fn json_after(text: &str, marker: &str) -> Result<Vec<Value>, Error> {
    if text.len() > LIMIT {
        return Err(fail("SIZE"));
    }
    let mut values = Vec::new();
    for (offset, _) in text.match_indices(marker).take(65) {
        if values.len() >= 64 {
            return Err(fail("JSON_COUNT"));
        }
        let tail = text[offset + marker.len()..].trim_start();
        if !tail.starts_with('{') {
            return Err(fail("JSON"));
        }
        let mut stream = serde_json::Deserializer::from_str(tail).into_iter::<Value>();
        values.push(
            stream
                .next()
                .ok_or_else(|| fail("JSON"))?
                .map_err(|_| fail("JSON"))?,
        );
    }
    Ok(values)
}

fn watch_player(html: &str, id: &str) -> Result<Value, Error> {
    let mut candidates = json_after(html, "ytInitialPlayerResponse =")?;
    candidates.extend(json_after(html, "ytInitialPlayerResponse=")?);
    if candidates.len() != 1 {
        return Err(fail("WATCH_SCHEMA"));
    }
    let value = candidates.pop().unwrap();
    eligible(&value, id)?;
    Ok(value)
}

fn eligible(value: &Value, id: &str) -> Result<(), Error> {
    if value
        .pointer("/playabilityStatus/status")
        .and_then(Value::as_str)
        != Some("OK")
        || value
            .pointer("/videoDetails/videoId")
            .and_then(Value::as_str)
            != Some(id)
        || value
            .pointer("/playabilityStatus/playableInEmbed")
            .and_then(Value::as_bool)
            != Some(true)
        || value
            .pointer("/microformat/playerMicroformatRenderer/isFamilySafe")
            .and_then(Value::as_bool)
            == Some(false)
    {
        return Err(fail("INELIGIBLE"));
    }
    if value.pointer(NOTICE_PATH).and_then(Value::as_str) != Some(NOTICE) {
        return Err(fail("NOT_MFK"));
    }
    Ok(())
}

#[derive(Clone, PartialEq)]
struct Config {
    version: String,
    visitor: String,
    flags: String,
    player: reqwest::Url,
}

fn bounded_string(value: &Value, max: usize) -> Result<String, Error> {
    value
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= max && !s.chars().any(char::is_control))
        .map(str::to_owned)
        .ok_or_else(|| fail("CONFIG"))
}

fn config(html: &str) -> Result<Config, Error> {
    let mut selected = Map::new();
    // Whitelist configuration only; do not propagate request/user/tracking contexts.
    for value in json_after(html, "ytcfg.set(")? {
        let object = value.as_object().ok_or_else(|| fail("CONFIG"))?;
        for key in [
            "INNERTUBE_CLIENT_NAME",
            "INNERTUBE_CLIENT_VERSION",
            "INNERTUBE_CONTEXT_CLIENT_NAME",
            "VISITOR_DATA",
            "INNERTUBE_CONTEXT",
            "WEB_PLAYER_CONTEXT_CONFIGS",
        ] {
            if let Some(value) = object.get(key) {
                if selected.get(key).is_some_and(|previous| previous != value) {
                    return Err(fail("CONFIG_AMBIGUOUS"));
                }
                selected.insert(key.into(), value.clone());
            }
        }
    }
    let value = Value::Object(selected);
    if value["INNERTUBE_CLIENT_NAME"] != "WEB_EMBEDDED_PLAYER"
        || value["INNERTUBE_CONTEXT_CLIENT_NAME"] != 56
    {
        return Err(fail("CONFIG_IDENTITY"));
    }
    let version = bounded_string(&value["INNERTUBE_CLIENT_VERSION"], 64)?;
    if !version.bytes().all(|b| b.is_ascii_digit() || b == b'.') || !version.contains('.') {
        return Err(fail("CONFIG"));
    }
    let client = value.pointer("/INNERTUBE_CONTEXT/client");
    if client.is_some_and(|client| {
        client
            .get("clientName")
            .is_some_and(|v| v != "WEB_EMBEDDED_PLAYER")
            || client
                .get("clientVersion")
                .is_some_and(|v| v.as_str() != Some(version.as_str()))
            || client
                .get("visitorData")
                .zip(value.get("VISITOR_DATA"))
                .is_some_and(|(a, b)| a != b)
    }) {
        return Err(fail("CONFIG_AMBIGUOUS"));
    }
    let context =
        &value["WEB_PLAYER_CONTEXT_CONFIGS"]["WEB_PLAYER_CONTEXT_CONFIG_ID_EMBEDDED_PLAYER"];
    let visitor = value
        .get("VISITOR_DATA")
        .or_else(|| value.pointer("/INNERTUBE_CONTEXT/client/visitorData"))
        .ok_or_else(|| fail("CONFIG"))?;
    Ok(Config {
        version,
        visitor: bounded_string(visitor, 4096)?,
        flags: bounded_string(&context["encryptedHostFlags"], 32 * 1024)?,
        player: player_url(&bounded_string(&context["jsUrl"], 2048)?)?,
    })
}

#[derive(Default)]
struct ConfigCache {
    entries: HashMap<String, (Arc<Config>, Instant)>,
    failed: HashMap<String, Instant>,
}
static CONFIGS: LazyLock<tokio::sync::Mutex<ConfigCache>> = LazyLock::new(Default::default);
struct Compiled {
    url: reqwest::Url,
    sha: [u8; 32],
    decoder: Arc<PreparedDecoder>,
    at: Instant,
}
#[derive(Default)]
struct DecoderCache {
    entries: Vec<Compiled>,
    failed: HashMap<String, Instant>,
}
static COMPILED: LazyLock<tokio::sync::Mutex<DecoderCache>> = LazyLock::new(Default::default);

fn failure_cache(failed: &mut HashMap<String, Instant>, key: &str) -> Result<(), Error> {
    failed.retain(|_, at| at.elapsed() < Duration::from_secs(30));
    if failed.contains_key(key) {
        return Err(fail("DISCOVERY_COOLDOWN"));
    }
    if failed.len() >= 16 {
        if let Some(oldest) = failed
            .iter()
            .min_by_key(|(_, at)| *at)
            .map(|(key, _)| key.clone())
        {
            failed.remove(&oldest);
        }
    }
    // A cancelled/failed download still limits concurrent retries. Success removes it.
    failed.insert(key.into(), Instant::now());
    Ok(())
}

async fn configuration(http: &reqwest::Client, id: &str) -> Result<Arc<Config>, Error> {
    let mut cache = CONFIGS.lock().await;
    cache.entries.retain(|_, (_, at)| at.elapsed() < TTL);
    if let Some((value, _)) = cache.entries.get(id) {
        return Ok(value.clone());
    }
    failure_cache(&mut cache.failed, id)?;
    let html = get(
        http,
        reqwest::Url::parse(&format!("https://www.youtube.com/embed/{id}?html5=1")).unwrap(),
    )
    .await?;
    #[cfg(test)]
    save_private_fixture(Some(id), "embed.html.local", html.as_bytes());
    let value = Arc::new(config(&html)?);
    if cache.entries.len() >= 16 {
        if let Some(oldest) = cache
            .entries
            .iter()
            .min_by_key(|(_, (_, at))| *at)
            .map(|(id, _)| id.clone())
        {
            cache.entries.remove(&oldest);
        }
    }
    cache
        .entries
        .insert(id.to_owned(), (value.clone(), Instant::now()));
    cache.failed.remove(id);
    Ok(value)
}

fn invalidate_config(cache: &mut ConfigCache, id: &str, used: &Arc<Config>) -> bool {
    if !cache
        .entries
        .get(id)
        .is_some_and(|(current, _)| Arc::ptr_eq(current, used) && current == used)
    {
        return false;
    }
    cache.entries.remove(id);
    cache.failed.remove(id);
    let _ = failure_cache(&mut cache.failed, id);
    true
}

fn invalidate_compiled(
    cache: &mut DecoderCache,
    url: &reqwest::Url,
    used: &Arc<PreparedDecoder>,
) -> bool {
    let Some(index) = cache
        .entries
        .iter()
        .position(|entry| &entry.url == url && Arc::ptr_eq(&entry.decoder, used))
    else {
        return false;
    };
    cache.entries.remove(index);
    cache.failed.remove(url.as_str());
    let _ = failure_cache(&mut cache.failed, url.as_str());
    true
}

async fn prepared(http: &reqwest::Client, config: &Config) -> Result<Arc<PreparedDecoder>, Error> {
    let mut cache = COMPILED.lock().await;
    cache.entries.retain(|entry| entry.at.elapsed() < TTL);
    if let Some(entry) = cache
        .entries
        .iter()
        .find(|entry| entry.url == config.player)
    {
        return Ok(entry.decoder.clone());
    }
    failure_cache(&mut cache.failed, config.player.as_str())?;
    let source = get(http, config.player.clone()).await?;
    #[cfg(test)]
    save_private_fixture(
        None,
        &format!(
            "player-{:x}.js.local",
            Sha256::digest(config.player.as_str().as_bytes())
        ),
        source.as_bytes(),
    );
    let sha: [u8; 32] = Sha256::digest(source.as_bytes()).into();
    let decoder = if let Some(entry) = cache.entries.iter().find(|entry| entry.sha == sha) {
        entry.decoder.clone()
    } else {
        Arc::new(
            youtube_decoder::prepare(source)
                .await
                .map_err(|_| fail("DECODER_PREPARE"))?,
        )
    };
    if cache.entries.len() >= MAX_DECODERS {
        cache.entries.remove(0);
    }
    cache.entries.push(Compiled {
        url: config.player.clone(),
        sha,
        decoder: decoder.clone(),
        at: Instant::now(),
    });
    cache.failed.remove(config.player.as_str());
    Ok(decoder)
}

fn body(config: &Config, id: &str, sts: u32) -> Value {
    json!({"videoId":id,"context":{"client":{"clientName":"WEB_EMBEDDED_PLAYER","clientVersion":config.version,"hl":"en","userAgent":UA,"visitorData":config.visitor},"thirdParty":{"embedUrl":"https://www.reddit.com/"}},"contentCheckOk":true,"racyCheckOk":true,"playbackContext":{"contentPlaybackContext":{"html5Preference":"HTML5_PREF_WANTS","signatureTimestamp":sts,"encryptedHostFlags":config.flags}}})
}

async fn player_response(
    http: &reqwest::Client,
    endpoint: &str,
    config: &Config,
    id: &str,
    sts: u32,
) -> Result<Value, Error> {
    let response = http
        .post(endpoint)
        .header("Content-Type", "application/json")
        .header("User-Agent", UA)
        .header("Origin", "https://www.youtube.com")
        .header("Accept-Encoding", "identity")
        .header("X-Youtube-Client-Name", "56")
        .header("X-Youtube-Client-Version", &config.version)
        .header("X-Goog-Visitor-Id", &config.visitor)
        .body(body(config, id, sts).to_string())
        .send()
        .await
        .map_err(|_| fail("TRANSPORT"))?;
    match response.status().as_u16() {
        400 => return Err(fail("PLAYER_HTTP_400")),
        401 => return Err(fail("PLAYER_HTTP_401")),
        403 => return Err(fail("PLAYER_HTTP_403")),
        _ => {}
    }
    let value: Value =
        serde_json::from_str(&text_response(response).await?).map_err(|_| fail("PLAYER_JSON"))?;
    if value
        .pointer("/playabilityStatus/status")
        .and_then(Value::as_str)
        != Some("OK")
        || value
            .pointer("/videoDetails/videoId")
            .and_then(Value::as_str)
            != Some(id)
        || !value
            .pointer("/streamingData/adaptiveFormats")
            .is_some_and(Value::is_array)
    {
        return Err(fail("PLAYER_IDENTITY_OR_STATUS"));
    }
    Ok(value)
}

struct Cipher {
    url: reqwest::Url,
    sig: Option<String>,
    n: Option<String>,
    parameter: String,
}

fn cipher(format: &Value) -> Result<Cipher, Error> {
    if format.get("url").is_some() && format.get("signatureCipher").is_some() {
        return Err(fail("CIPHER_AMBIGUOUS"));
    }
    let mut sig = None;
    let mut parameter = "sig".to_owned();
    let raw = if let Some(url) = format["url"].as_str() {
        url.to_owned()
    } else {
        let text = bounded_string(&format["signatureCipher"], 32 * 1024)
            .map_err(|_| fail("CIPHER_MISSING"))?;
        let fields: Vec<_> = reqwest::Url::parse(&format!("https://www.youtube.com/?{text}"))
            .map_err(|_| fail("CIPHER"))?
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        if fields
            .iter()
            .any(|(key, _)| !matches!(key.as_str(), "url" | "s" | "sp"))
            || ["url", "s", "sp"]
                .iter()
                .any(|key| fields.iter().filter(|(k, _)| k == key).count() > 1)
        {
            return Err(fail("CIPHER"));
        }
        sig = fields
            .iter()
            .find(|(k, _)| k == "s")
            .map(|(_, value)| value.clone());
        if sig.as_ref().is_none_or(|s| s.is_empty() || s.len() > 16384) {
            return Err(fail("CIPHER"));
        }
        if let Some((_, value)) = fields.iter().find(|(k, _)| k == "sp") {
            parameter = value.clone();
        }
        fields
            .iter()
            .find(|(k, _)| k == "url")
            .map(|(_, v)| v.clone())
            .ok_or_else(|| fail("CIPHER"))?
    };
    if !matches!(parameter.as_str(), "sig" | "signature")
        || raw.len() > 32 * 1024
        || !direct_audio_url(&raw)
    {
        return Err(fail("CIPHER_URL"));
    }
    let url = reqwest::Url::parse(&raw).map_err(|_| fail("CIPHER_URL"))?;
    if url.fragment().is_some() {
        return Err(fail("CIPHER_URL"));
    }
    let values: Vec<_> = url
        .query_pairs()
        .filter(|(key, _)| key == "n")
        .map(|(_, value)| value.into_owned())
        .collect();
    if values.len() > 1 || values.iter().any(|v| v.is_empty() || v.len() > 16384) {
        return Err(fail("CIPHER"));
    }
    if sig.is_some() && url.query_pairs().any(|(key, _)| key == parameter) {
        return Err(fail("CIPHER"));
    }
    Ok(Cipher {
        url,
        sig,
        n: values.into_iter().next(),
        parameter,
    })
}

fn apply_decoded(
    input: Cipher,
    signature: Option<String>,
    n: Option<String>,
) -> Result<String, Error> {
    let valid = |value: &str| {
        !value.is_empty()
            && value.len() <= 16384
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-.".contains(&b))
            && !value.starts_with("enhanced_except_")
    };
    let valid_signature = |value: &str| {
        let unpadded = value.trim_end_matches('=');
        value.len() - unpadded.len() <= 2 && valid(unpadded)
    };
    if signature.is_some() != input.sig.is_some()
        || n.is_some() != input.n.is_some()
        || signature.iter().any(|v| !valid_signature(v))
        || n.iter().any(|v| !valid(v))
    {
        return Err(fail("DECODED_VALUE"));
    }
    let mut url = input.url;
    let pairs: Vec<_> = url
        .query_pairs()
        .filter(|(key, _)| key != "n")
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    url.query_pairs_mut().clear().extend_pairs(pairs);
    if let Some(n) = n {
        url.query_pairs_mut().append_pair("n", &n);
    }
    if let Some(signature) = signature {
        url.query_pairs_mut()
            .append_pair(&input.parameter, &signature);
    }
    Ok(url.into())
}

async fn strict_probe(http: &reqwest::Client, url: &str, length: u64) -> Result<(), Error> {
    strict_probe_request(http.get(url), length).await
}

async fn strict_probe_request(request: reqwest::RequestBuilder, length: u64) -> Result<(), Error> {
    if length < 1024 {
        return Err(fail("LENGTH"));
    }
    let at = length / 10 * 8 + (length % 10) * 8 / 10;
    let end = (at + 1023).min(length.saturating_sub(1));
    let expected = end - at + 1;
    let mut response = request
        .header("Range", format!("bytes={at}-{end}"))
        .header("Accept-Encoding", "identity")
        .send()
        .await
        .map_err(|_| fail("CDN_TRANSPORT"))?;
    if response.status().as_u16() != 206 {
        return Err(fail(&format!("CDN_HTTP_{}", response.status().as_u16())));
    }
    if response
        .headers()
        .get(reqwest::header::CONTENT_ENCODING)
        .is_some_and(|v| v.as_bytes() != b"identity")
    {
        return Err(fail("CDN_ENCODING"));
    }
    if response
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        != Some(format!("bytes {at}-{end}/{length}").as_str())
        || response.content_length().is_some_and(|n| n != expected)
    {
        return Err(fail("CDN_RANGE"));
    }
    if response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_ascii_lowercase)
        .is_some_and(|v| v.starts_with("text/") || v.contains("html") || v.contains("json"))
    {
        return Err(fail("CDN_MIME"));
    }
    let mut received = 0;
    while let Some(chunk) = response.chunk().await.map_err(|_| fail("CDN_TRANSPORT"))? {
        received += chunk.len() as u64;
        if received > expected {
            return Err(fail("CDN_RANGE"));
        }
    }
    if received != expected {
        return Err(fail("CDN_TRUNCATED"));
    }
    Ok(())
}

fn transient_cdn(error: &Error) -> bool {
    let Error::Failed(code) = error else {
        return false;
    };
    if matches!(
        code.as_str(),
        "NATIVE_EMBEDDED_CDN_TRANSPORT" | "NATIVE_EMBEDDED_CDN_TIMEOUT"
    ) {
        return true;
    }
    code.strip_prefix("NATIVE_EMBEDDED_CDN_HTTP_")
        .filter(|v| v.len() == 3 && v.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|v| v.parse::<u16>().ok())
        .is_some_and(|status| matches!(status, 403 | 429 | 500..=599))
}

fn invalid_decoder(error: &str) -> bool {
    matches!(
        error,
        "YOUTUBE_DECODER_EXECUTION" | "YOUTUBE_DECODER_OUTPUT" | "YOUTUBE_DECODER_UNSUPPORTED"
    )
}

fn config_rejected(error: &Error) -> bool {
    matches!(error, Error::Failed(code) if matches!(code.as_str(),
        "NATIVE_EMBEDDED_PLAYER_HTTP_400" | "NATIVE_EMBEDDED_PLAYER_HTTP_401" | "NATIVE_EMBEDDED_PLAYER_HTTP_403"))
}

async fn bounded_cdn_probe<F, Fut>(
    mut probe: F,
    offsets: &[Duration],
    budget: Duration,
) -> Result<(), Error>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<(), Error>>,
{
    let attempts = async {
        let started = Instant::now();
        let mut last = fail("CDN_TIMEOUT");
        for offset in offsets.iter().take(5) {
            if let Some(wait) = offset.checked_sub(started.elapsed()) {
                tokio::time::sleep(wait).await;
            }
            last = match tokio::time::timeout(Duration::from_secs(2), probe()).await {
                Ok(Ok(())) => return Ok(()),
                Ok(Err(error)) => error,
                Err(_) => fail("CDN_TIMEOUT"),
            };
            if !transient_cdn(&last) {
                return Err(last);
            }
        }
        Err(last)
    };
    tokio::time::timeout(budget, attempts)
        .await
        .unwrap_or_else(|_| Err(fail("CDN_TIMEOUT")))
}

fn candidate_audio(format: &Value, require_explicit: bool) -> bool {
    format["mimeType"].as_str().is_some_and(|mime| {
        BUNDLED
            .audio
            .iter()
            .any(|allowed| mime.starts_with(allowed))
    }) && (if require_explicit {
        original_audio_explicit(format)
    } else {
        original_audio(format)
    }) && format
        .get("drmFamilies")
        .is_none_or(|v| v.as_array().is_some_and(Vec::is_empty))
        && format.get("licenseInfos").is_none()
        && format.get("drmTrackType").is_none()
}

fn audio_candidates(formats: &[Value]) -> Vec<Value> {
    // Keep compatibility with codec/bitrate variants in wholly untagged responses.
    // Once any audio format exposes track metadata, default alone cannot establish
    // originality, including for other formats whose metadata is missing.
    let require_explicit = formats.iter().any(|format| {
        format["mimeType"]
            .as_str()
            .is_some_and(|mime| mime.starts_with("audio/"))
            && ["audioTrack", "xtags", "language", "languageCode"]
                .iter()
                .any(|key| format.get(*key).is_some_and(|value| !value.is_null()))
    });
    let mut candidates: Vec<_> = formats
        .iter()
        .filter(|format| candidate_audio(format, require_explicit))
        .cloned()
        .collect();
    candidates.sort_by_key(|format| {
        (
            BUNDLED
                .audio
                .iter()
                .position(|mime| format["mimeType"].as_str().unwrap_or("").starts_with(mime)),
            std::cmp::Reverse(format["bitrate"].as_u64().unwrap_or(0)),
        )
    });
    candidates
}

/// Only reached after the direct fast clients failed. The caller supplies the total deadline.
pub(super) async fn resolve(video_id: &str) -> Result<Direct, Error> {
    if !valid_id(video_id) {
        return Err(fail("ID"));
    }
    let http = WEB.as_ref().map_err(|_| fail("HTTP"))?;
    let watch = get(
        http,
        reqwest::Url::parse(&format!("https://www.youtube.com/watch?v={video_id}&hl=en")).unwrap(),
    )
    .await?;
    watch_player(&watch, video_id)?;
    let config = configuration(http, video_id).await?;
    let result = resolve_config(http, &config, video_id).await;
    if result.as_ref().is_err_and(|error| config_rejected(error)) {
        invalidate_config(&mut *CONFIGS.lock().await, video_id, &config);
    }
    result
}

async fn resolve_config(
    http: &reqwest::Client,
    config: &Config,
    video_id: &str,
) -> Result<Direct, Error> {
    let decoder = prepared(http, config).await?;
    let mut response =
        player_response(http, PLAYER, config, video_id, decoder.signature_timestamp).await?;
    #[cfg(test)]
    {
        save_private_fixture(
            Some(video_id),
            "player-response.json.local",
            response.to_string().as_bytes(),
        );
        save_private_fixture(
            Some(video_id),
            "player-request.json.local",
            body(config, video_id, decoder.signature_timestamp)
                .to_string()
                .as_bytes(),
        );
        save_private_fixture(
            Some(video_id),
            "prepared.js.local",
            decoder.script.as_bytes(),
        );
        save_private_fixture(Some(video_id), "metadata.json.local", json!({"id":video_id,"playerJsUrl":config.player.as_str(),"clientVersion":config.version,"signatureTimestamp":decoder.signature_timestamp}).to_string().as_bytes());
        if let (Some(from), Some(to)) = (
            fixture_file(
                None,
                &format!(
                    "player-{:x}.js.local",
                    Sha256::digest(config.player.as_str().as_bytes())
                ),
            ),
            fixture_file(Some(video_id), "player.js.local"),
        ) {
            let _ = std::fs::copy(from, to);
        }
    }
    let formats = audio_candidates(
        response["streamingData"]["adaptiveFormats"]
            .as_array()
            .unwrap(),
    );
    let client = Client {
        name: "WEB_EMBEDDED_PLAYER".into(),
        id: 56,
        version: config.version.clone(),
        user_agent: UA.into(),
        context: Map::new(),
    };
    let mut last = fail("NO_AUDIO");
    let mut retry_available = true;
    let mut cdn_started: Option<Instant> = None;
    for mut format in formats.into_iter().take(3) {
        let input = match cipher(&format) {
            Ok(v) => v,
            Err(error) => {
                last = error;
                continue;
            }
        };
        let decode = youtube_decoder::decode(decoder.clone(), input.sig.clone(), input.n.clone());
        // Trying another format after a permanent CDN error still shares the
        // first candidate's overall validation deadline, including its decoder.
        let decoded_result = if let Some(started) = cdn_started {
            let Some(remaining) = Duration::from_secs(8).checked_sub(started.elapsed()) else {
                return Err(fail("CDN_TIMEOUT"));
            };
            match tokio::time::timeout(remaining, decode).await {
                Ok(result) => result,
                Err(_) => return Err(fail("CDN_TIMEOUT")),
            }
        } else {
            decode.await
        };
        let decoded = match decoded_result {
            Ok(v) => v,
            Err(error) => {
                if invalid_decoder(&error) {
                    invalidate_compiled(&mut *COMPILED.lock().await, &config.player, &decoder);
                }
                last = fail("DECODER_RUN");
                continue;
            }
        };
        #[cfg(test)]
        save_private_fixture(
            Some(video_id),
            &format!(
                "decoded-{}.json.local",
                format["itag"].as_u64().unwrap_or(0)
            ),
            json!({"sig":decoded.sig,"n":decoded.n})
                .to_string()
                .as_bytes(),
        );
        let url = match apply_decoded(input, decoded.sig, decoded.n) {
            Ok(v) => v,
            Err(error) => {
                invalidate_compiled(&mut *COMPILED.lock().await, &config.player, &decoder);
                last = error;
                continue;
            }
        };
        // A missing length would turn the existing 80% probe into a prefix-only probe.
        let Some(length) = query_param(&url, "clen")
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|n| (1024..=128 * 1024 * 1024).contains(n))
        else {
            last = fail("LENGTH");
            continue;
        };
        format["url"] = json!(url);
        response["streamingData"]["adaptiveFormats"] = json!([format]);
        let direct = pick_identified(&BUNDLED, &client, &response, video_id, None, None)
            .map_err(|_| fail("SELECTION"))?;
        #[cfg(test)]
        save_private_fixture(
            Some(video_id),
            &format!("url-{}.json.local", direct.itag),
            json!({"url":direct.url,"itag":direct.itag})
                .to_string()
                .as_bytes(),
        );
        #[cfg(test)]
        save_private_fixture(
            Some(video_id),
            "probe-current.json.local",
            json!({"url":direct.url,"itag":direct.itag})
                .to_string()
                .as_bytes(),
        );
        // Only the first original candidate gets retries, always with the same URL.
        // Some otherwise valid responses have a temporary CDN availability gate.
        // Neither its presence nor a successful retry proves an ad was played/skipped.
        let retry = std::mem::replace(&mut retry_available, false);
        let offsets: &[Duration] = if retry {
            &[
                Duration::ZERO,
                Duration::from_millis(250),
                Duration::from_secs(1),
                Duration::from_secs(3),
                Duration::from_secs(6),
            ]
        } else {
            &[Duration::ZERO]
        };
        let http = CDN.as_ref().map_err(|_| fail("HTTP"))?;
        let started = cdn_started.get_or_insert_with(Instant::now);
        let Some(remaining) = Duration::from_secs(8).checked_sub(started.elapsed()) else {
            return Err(fail("CDN_TIMEOUT"));
        };
        let result = bounded_cdn_probe(
            || strict_probe(http, &direct.url, length),
            offsets,
            remaining.min(Duration::from_secs(if retry { 8 } else { 2 })),
        )
        .await;
        match result {
            Ok(()) => return Ok(direct),
            Err(error) => {
                probe_diagnostic(
                    video_id,
                    direct.itag,
                    "strict-80percent",
                    &error.to_string(),
                );
                // Exhausted transient retries do not multiply the budget by formats.
                if transient_cdn(&error) {
                    return Err(error);
                }
                last = error;
            }
        }
    }
    Err(last)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    const ID: &str = "DJzjkMBMook";
    const AUDIO: &str =
        "https://r1.googlevideo.com/videoplayback?clen=8192&n=input_n&expire=4102444800";

    fn config_value() -> Value {
        json!({"INNERTUBE_CLIENT_NAME":"WEB_EMBEDDED_PLAYER","INNERTUBE_CONTEXT_CLIENT_NAME":56,
            "INNERTUBE_CLIENT_VERSION":"2.20261022.01.00","VISITOR_DATA":"public-visitor",
            "INNERTUBE_CONTEXT":{"user":{"account":"must-not-propagate"}},
            "WEB_PLAYER_CONTEXT_CONFIGS":{"WEB_PLAYER_CONTEXT_CONFIG_ID_EMBEDDED_PLAYER":{
                "jsUrl":"/s/player/cbcfbf2f/player_es6.vflset/en_US/base.js","encryptedHostFlags":"public-flags"}}})
    }

    fn watch_value() -> Value {
        json!({"videoDetails":{"videoId":ID,"title":"Kids fixture"},
            "playabilityStatus":{"status":"OK","playableInEmbed":true,"miniplayer":{"miniplayerRenderer":{
                "minimizedEndpoint":{"openPopupAction":{"popup":{"notificationActionRenderer":{"responseText":{"simpleText":NOTICE}}}}}}}},
            "microformat":{"playerMicroformatRenderer":{"isFamilySafe":true}}})
    }

    fn cfg() -> Config {
        config(&format!("ytcfg.set({});", config_value())).unwrap()
    }

    fn cipher_value(url: &str) -> Value {
        let mut wrapped = reqwest::Url::parse("https://www.youtube.com/").unwrap();
        wrapped
            .query_pairs_mut()
            .append_pair("url", url)
            .append_pair("s", "input_sig")
            .append_pair("sp", "sig");
        json!({"signatureCipher":wrapped.query().unwrap()})
    }

    #[test]
    fn only_identified_explicit_child_notice_activates_route() {
        let value = watch_value();
        eligible(&value, ID).unwrap();
        assert!(eligible(&value, "jNY_wLukVW0").is_err());
        for (path, bad) in [
            ("/playabilityStatus/status", json!("AGE_CHECK_REQUIRED")),
            ("/playabilityStatus/playableInEmbed", json!(false)),
            (NOTICE_PATH, json!("Videos made for kids")),
            (
                "/microformat/playerMicroformatRenderer/isFamilySafe",
                json!(false),
            ),
        ] {
            let mut changed = value.clone();
            *changed.pointer_mut(path).unwrap() = bad;
            assert!(eligible(&changed, ID).is_err());
        }
        let mut non_kids = value.clone();
        non_kids["playabilityStatus"]
            .as_object_mut()
            .unwrap()
            .remove("miniplayer");
        non_kids["videoDetails"]["title"] = json!(NOTICE);
        assert!(
            eligible(&non_kids, ID).is_err(),
            "familySafe/title cannot establish MFK"
        );
        watch_player(&format!("var ytInitialPlayerResponse = {value};"), ID).unwrap();
        assert!(
            watch_player(
                &format!("ytInitialPlayerResponse={value};ytInitialPlayerResponse = {value};"),
                ID
            )
            .is_err()
        );
    }

    #[test]
    fn config_allowlist_and_current_identity_are_not_arbitrary_script() {
        let config = cfg();
        let request = body(&config, ID, 20700);
        assert_eq!(
            request.pointer("/context/client/clientName").unwrap(),
            "WEB_EMBEDDED_PLAYER"
        );
        assert_eq!(
            request.pointer("/context/thirdParty/embedUrl").unwrap(),
            "https://www.reddit.com/"
        );
        assert!(!request.to_string().contains("account"));
        assert!(!request.to_string().contains("must-not-propagate"));
        for (key, bad) in [
            ("INNERTUBE_CONTEXT_CLIENT_NAME", json!(1)),
            ("INNERTUBE_CLIENT_NAME", json!("WEB")),
            ("INNERTUBE_CLIENT_VERSION", json!("2.1\r\nCookie:bad")),
        ] {
            let mut value = config_value();
            value[key] = bad;
            assert!(super::config(&format!("ytcfg.set({value});")).is_err());
        }
        assert!(super::config("ytcfg.set(fetch('https://outside.invalid')); ").is_err());
        assert!(
            super::config(&format!(
                "ytcfg.set({});ytcfg.set({{\"INNERTUBE_CLIENT_VERSION\":\"2.9\"}});",
                config_value()
            ))
            .is_err()
        );
        let mut mixed = config_value();
        mixed["INNERTUBE_CONTEXT"]["client"] = json!({"clientName":"WEB","clientVersion":"2.9"});
        assert!(super::config(&format!("ytcfg.set({mixed});")).is_err());
    }

    #[test]
    fn discovery_origins_and_player_paths_reject_external_credentials_and_queries() {
        player_url("/s/player/cbcfbf2f/player_es6.vflset/en_US/base.js").unwrap();
        for url in [
            "https://evil.invalid/s/player/cbcfbf2f/base.js",
            "https://www.youtube.com.evil.invalid/s/player/cbcfbf2f/base.js",
            "http://www.youtube.com/s/player/cbcfbf2f/base.js",
            "https://user@www.youtube.com/s/player/cbcfbf2f/base.js",
            "/s/player/cbcfbf2f/base.js?url=https://evil.invalid",
            "/s/player/cbcfbf2f/base.js#token",
            "/other/base.js",
            "/s/player/cbcfbf2f/%2e%2e/base.js",
        ] {
            assert!(player_url(url).is_err());
        }
        assert!(!valid_id("../watch?id="));
    }

    #[test]
    fn cipher_decoder_output_is_not_an_arbitrary_url_or_silent_missing_transform() {
        let result = apply_decoded(
            cipher(&cipher_value(AUDIO)).unwrap(),
            Some("good.signature".into()),
            Some("good_n".into()),
        )
        .unwrap();
        assert_eq!(
            query_param(&result, "sig").as_deref(),
            Some("good.signature")
        );
        assert_eq!(query_param(&result, "n").as_deref(), Some("good_n"));
        assert_eq!(query_param(&result, "clen").as_deref(), Some("8192"));
        let padded = apply_decoded(
            cipher(&cipher_value(AUDIO)).unwrap(),
            Some("base64_signature==".into()),
            Some("good_n".into()),
        )
        .unwrap();
        // query_param deliberately returns the raw query substring; URL query_pairs
        // decodes exactly once, as the receiving server does for signature padding.
        assert_eq!(
            reqwest::Url::parse(&padded)
                .unwrap()
                .query_pairs()
                .find(|(key, _)| key == "sig")
                .map(|(_, value)| value.into_owned())
                .as_deref(),
            Some("base64_signature==")
        );
        assert_eq!(query_param(&padded, "sig"), Some("base64_signature%3D%3D"));
        for output in [
            "",
            "enhanced_except_error",
            "https://outside.invalid",
            "a&n=bad",
            "a\nvalue",
            "=middle=value",
            "value===",
        ] {
            assert!(
                apply_decoded(
                    cipher(&cipher_value(AUDIO)).unwrap(),
                    Some(output.into()),
                    Some("good_n".into())
                )
                .is_err()
            );
        }
        assert!(
            apply_decoded(
                cipher(&cipher_value(AUDIO)).unwrap(),
                None,
                Some("good_n".into())
            )
            .is_err()
        );
        assert!(
            apply_decoded(
                cipher(&cipher_value(AUDIO)).unwrap(),
                Some("signature==".into()),
                Some("n==".into())
            )
            .is_err()
        );
        assert!(cipher(&cipher_value("https://www.youtube.com/watch?v=DJzjkMBMook")).is_err());
        assert!(cipher(&cipher_value(&format!("{AUDIO}&n=second"))).is_err());
        let mut ambiguous = cipher_value(AUDIO);
        ambiguous["url"] = json!(AUDIO);
        assert!(cipher(&ambiguous).is_err());
        let mut unsupported = cipher_value(AUDIO);
        unsupported["signatureCipher"] = json!(format!(
            "{}&sp=other",
            unsupported["signatureCipher"].as_str().unwrap()
        ));
        assert!(cipher(&unsupported).is_err());
        for format in [json!({"itag": 251}), json!({"signatureCipher": null})] {
            assert!(
                matches!(cipher(&format), Err(Error::Failed(code)) if code == "NATIVE_EMBEDDED_CIPHER_MISSING")
            );
        }
    }

    #[test]
    fn failed_discovery_is_deduplicated_and_memory_bounded() {
        let mut failed = HashMap::new();
        failure_cache(&mut failed, "one").unwrap();
        assert!(failure_cache(&mut failed, "one").is_err());
        failed.insert("one".into(), Instant::now() - Duration::from_secs(31));
        failure_cache(&mut failed, "one").unwrap();
        for index in 0..40 {
            failure_cache(&mut failed, &index.to_string()).unwrap();
        }
        assert!(failed.len() <= 16);
    }

    #[test]
    fn cdn_diagnostics_are_bounded_categories_and_never_remote_text() {
        assert_eq!(
            validation_code("YouTube cortaría el audio (403)"),
            "cdn-http-403"
        );
        assert_eq!(validation_code("NATIVE_CDN_TIMEOUT"), "cdn-timeout");
        assert_eq!(validation_code("NATIVE_CDN_RANGE"), "cdn-range");
        assert_eq!(validation_code("NATIVE_CDN_NOT_AUDIO"), "cdn-mime");
        assert_eq!(
            validation_code("NATIVE_EMBEDDED_CDN_HTTP_200"),
            "cdn-http-200"
        );
        assert_eq!(
            validation_code("NATIVE_EMBEDDED_CDN_TRUNCATED"),
            "cdn-truncated"
        );
        for untrusted in [
            "https://cdn.invalid/?sig=private",
            "YouTube cortaría el audio (403) https://cdn.invalid",
            "NATIVE_EMBEDDED_CDN_HTTP_403private",
            "server says: account private",
        ] {
            assert_eq!(validation_code(untrusted), "cdn-transport");
        }
    }

    #[test]
    fn retry_and_decoder_invalidation_are_explicit_local_categories() {
        for code in [
            "CDN_HTTP_403",
            "CDN_HTTP_429",
            "CDN_HTTP_500",
            "CDN_HTTP_599",
            "CDN_TRANSPORT",
            "CDN_TIMEOUT",
        ] {
            assert!(transient_cdn(&fail(code)));
        }
        for code in [
            "CDN_HTTP_200",
            "CDN_HTTP_401",
            "CDN_HTTP_404",
            "CDN_HTTP_600",
            "CDN_HTTP_403_private",
            "CDN_RANGE",
            "CDN_MIME",
            "CDN_ENCODING",
            "CDN_TRUNCATED",
            "CIPHER_MISSING",
        ] {
            assert!(!transient_cdn(&fail(code)));
        }
        for code in [
            "YOUTUBE_DECODER_EXECUTION",
            "YOUTUBE_DECODER_OUTPUT",
            "YOUTUBE_DECODER_UNSUPPORTED",
        ] {
            assert!(invalid_decoder(code));
        }
        for code in [
            "YOUTUBE_DECODER_TIMEOUT",
            "YOUTUBE_DECODER_CANCELLED",
            "YOUTUBE_DECODER_MEMORY",
            "YOUTUBE_DECODER_WORKER",
            "YOUTUBE_DECODER_INPUT",
        ] {
            assert!(!invalid_decoder(code));
        }
        for code in ["PLAYER_HTTP_400", "PLAYER_HTTP_401", "PLAYER_HTTP_403"] {
            assert!(config_rejected(&fail(code)));
        }
        for code in [
            "CDN_HTTP_403",
            "TRANSPORT",
            "PLAYER_JSON",
            "PLAYER_IDENTITY_OR_STATUS",
            "CIPHER_MISSING",
            "DECODER_RUN",
        ] {
            assert!(!config_rejected(&fail(code)));
        }
    }

    #[tokio::test]
    async fn retries_stop_on_permanent_errors_and_never_exceed_five_attempts() {
        for code in [
            "CDN_RANGE",
            "CDN_MIME",
            "CDN_TRUNCATED",
            "CDN_ENCODING",
            "CDN_HTTP_200",
        ] {
            let calls = AtomicU64::new(0);
            let result = bounded_cdn_probe(
                || {
                    calls.fetch_add(1, Ordering::Relaxed);
                    async { Err(fail(code)) }
                },
                &[Duration::ZERO; 5],
                Duration::from_secs(1),
            )
            .await;
            assert!(result.is_err());
            assert_eq!(calls.load(Ordering::Relaxed), 1);
        }
        let calls = AtomicU64::new(0);
        assert!(
            bounded_cdn_probe(
                || {
                    calls.fetch_add(1, Ordering::Relaxed);
                    async { Err(fail("CDN_HTTP_403")) }
                },
                &[Duration::ZERO; 9],
                Duration::from_secs(1)
            )
            .await
            .is_err()
        );
        assert_eq!(calls.load(Ordering::Relaxed), 5);
    }

    #[tokio::test]
    async fn retry_deadline_and_caller_cancellation_drop_the_inflight_probe() {
        struct Dropped(Arc<std::sync::atomic::AtomicBool>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Relaxed);
            }
        }
        for cancel in [false, true] {
            let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let calls = AtomicU64::new(0);
            let started = Instant::now();
            let operation = bounded_cdn_probe(
                || {
                    calls.fetch_add(1, Ordering::Relaxed);
                    let flag = dropped.clone();
                    async move {
                        let _guard = Dropped(flag);
                        std::future::pending::<Result<(), Error>>().await
                    }
                },
                &[Duration::ZERO; 5],
                Duration::from_millis(if cancel { 1000 } else { 10 }),
            );
            if cancel {
                assert!(
                    tokio::time::timeout(Duration::from_millis(10), operation)
                        .await
                        .is_err()
                );
            } else {
                assert!(operation.await.is_err());
            }
            assert!(started.elapsed() < Duration::from_secs(1));
            assert!(dropped.load(Ordering::Relaxed));
            assert_eq!(calls.load(Ordering::Relaxed), 1);
        }
    }

    #[test]
    fn failed_request_does_not_evict_newer_even_identical_configuration() {
        let used = Arc::new(cfg());
        let replacement = Arc::new((*used).clone());
        let mut cache = ConfigCache::default();
        cache
            .entries
            .insert(ID.into(), (replacement.clone(), Instant::now()));
        assert!(!invalidate_config(&mut cache, ID, &used));
        assert!(Arc::ptr_eq(&cache.entries[ID].0, &replacement));
        assert!(cache.failed.is_empty());
        cache
            .entries
            .insert(ID.into(), (used.clone(), Instant::now()));
        assert!(invalidate_config(&mut cache, ID, &used));
        assert!(!cache.entries.contains_key(ID));
        assert!(failure_cache(&mut cache.failed, ID).is_err());
        assert!(
            !invalidate_config(&mut cache, ID, &used),
            "late duplicate failure cannot extend cooldown"
        );
    }

    #[test]
    fn decoder_failure_evicts_only_exact_url_and_arc_not_newer_compilation() {
        let url = cfg().player;
        let other = player_url("/s/player/cbcfbf2f/player_es6.vflset/es_ES/base.js").unwrap();
        let used = Arc::new(PreparedDecoder {
            script: "local-script".into(),
            signature_timestamp: 20700,
        });
        let replacement = Arc::new(PreparedDecoder {
            script: "local-script".into(),
            signature_timestamp: 20700,
        });
        let mut cache = DecoderCache::default();
        cache.entries.push(Compiled {
            url: url.clone(),
            sha: [0; 32],
            decoder: replacement.clone(),
            at: Instant::now(),
        });
        cache.entries.push(Compiled {
            url: other.clone(),
            sha: [0; 32],
            decoder: used.clone(),
            at: Instant::now(),
        });
        assert!(!invalidate_compiled(&mut cache, &url, &used));
        assert_eq!(cache.entries.len(), 2);
        assert!(cache.failed.is_empty());
        assert!(invalidate_compiled(&mut cache, &other, &used));
        assert_eq!(cache.entries.len(), 1);
        assert!(Arc::ptr_eq(&cache.entries[0].decoder, &replacement));
        assert!(failure_cache(&mut cache.failed, other.as_str()).is_err());
        assert!(invalidate_compiled(&mut cache, &url, &replacement));
        assert!(cache.entries.is_empty());
    }

    #[test]
    fn original_nondefault_survives_shared_selection_but_dubbed_and_drm_do_not() {
        let original = json!({"itag":251,"url":AUDIO,"mimeType":"audio/webm; codecs=\"opus\"","bitrate":128000,"audioTrack":{"audioIsDefault":false,"displayName":"Basque (original)","id":"eu.0"}});
        let dubbed = json!({"itag":250,"url":AUDIO,"mimeType":"audio/webm; codecs=\"opus\"","bitrate":256000,"audioTrack":{"audioIsDefault":true,"displayName":"English (auto-dubbed)","id":"en.1"}});
        assert!(candidate_audio(&original, true));
        assert!(!candidate_audio(&dubbed, true));
        for (field, value) in [
            ("drmFamilies", json!(["WIDEVINE"])),
            ("drmFamilies", json!(false)),
            ("licenseInfos", json!([])),
            ("drmTrackType", json!("DRM_TRACK_TYPE_AUDIO")),
        ] {
            let mut changed = original.clone();
            changed[field] = value;
            assert!(!candidate_audio(&changed, true));
        }
        let mut response = watch_value();
        response["streamingData"] = json!({"adaptiveFormats":[dubbed,original]});
        let config = cfg();
        let client = Client {
            name: "WEB_EMBEDDED_PLAYER".into(),
            id: 56,
            version: config.version,
            user_agent: UA.into(),
            context: Map::new(),
        };
        let selected = pick_identified(&BUNDLED, &client, &response, ID, None, None).unwrap();
        assert_eq!(selected.itag, 251);
    }

    #[test]
    fn tagged_response_never_prefers_an_unverified_localized_default() {
        let original = json!({"itag":251,"mimeType":"audio/webm; codecs=\"opus\"","bitrate":128000,
            "audioTrack":{"audioIsDefault":false,"displayName":"Basque (original)","id":"eu.0"}});
        let localized_default = json!({"itag":250,"mimeType":"audio/webm; codecs=\"opus\"","bitrate":256000,
            "audioTrack":{"audioIsDefault":true,"displayName":"Spanish","id":"es.1"}});
        let untagged =
            json!({"itag":249,"mimeType":"audio/webm; codecs=\"opus\"","bitrate":320000});
        let candidates = audio_candidates(&[localized_default, untagged, original]);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0]["itag"], 251);
    }

    #[test]
    fn wholly_untagged_audio_variants_remain_compatible() {
        let formats = [
            json!({"itag":140,"mimeType":"audio/mp4; codecs=\"mp4a.40.2\"","bitrate":128000}),
            json!({"itag":249,"mimeType":"audio/webm; codecs=\"opus\"","bitrate":48000}),
            json!({"itag":250,"mimeType":"audio/webm; codecs=\"opus\"","bitrate":64000}),
            json!({"itag":251,"mimeType":"audio/webm; codecs=\"opus\"","bitrate":128000}),
        ];
        let candidates = audio_candidates(&formats);
        assert_eq!(candidates.len(), 4);
        assert_eq!(candidates[0]["itag"], 251);
        assert_eq!(audio_candidates(&formats[3..]).len(), 1);
    }

    #[test]
    fn language_metadata_without_original_evidence_is_not_an_untagged_response() {
        for field in ["audioTrack", "xtags", "language", "languageCode"] {
            let untagged = json!({"itag":251,"mimeType":"audio/webm; codecs=\"opus\""});
            let mut tagged = untagged.clone();
            tagged["itag"] = json!(250);
            tagged[field] = if field == "audioTrack" {
                json!({"audioIsDefault":true,"id":"es.1"})
            } else {
                json!("es")
            };
            assert!(audio_candidates(&[untagged, tagged]).is_empty(), "{field}");
        }
    }

    fn local(response: Vec<u8>) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let worker = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = Vec::new();
            let header_end = loop {
                let mut bytes = [0; 4096];
                let n = socket.read(&mut bytes).unwrap();
                assert!(n > 0 && request.len() < 64 * 1024);
                request.extend_from_slice(&bytes[..n]);
                if let Some(pos) = request.windows(4).position(|v| v == b"\r\n\r\n") {
                    break pos + 4;
                }
            };
            let headers = String::from_utf8(request[..header_end].to_vec()).unwrap();
            let length = headers
                .lines()
                .find_map(|line| {
                    line.split_once(':')
                        .filter(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                        .map(|(_, n)| n.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            while request.len() < header_end + length {
                let mut bytes = [0; 4096];
                let n = socket.read(&mut bytes).unwrap();
                assert!(n > 0);
                request.extend_from_slice(&bytes[..n]);
            }
            let _ = socket.write_all(&response);
            String::from_utf8(request).unwrap()
        });
        (url, worker)
    }

    fn response(status: u16, extra: &str, body: &[u8]) -> Vec<u8> {
        let mut result = format!(
            "HTTP/1.1 {status} Test\r\nConnection: close\r\nContent-Length: {}\r\n{extra}\r\n",
            body.len()
        )
        .into_bytes();
        result.extend_from_slice(body);
        result
    }

    fn local_http() -> reqwest::Client {
        reqwest::Client::builder()
            .no_proxy()
            .no_gzip()
            .timeout(Duration::from_secs(2))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap()
    }

    #[tokio::test]
    async fn real_http_post_uses_only_embedded_context_and_rejects_wrong_video() {
        let mut value = watch_value();
        value["streamingData"] = json!({"adaptiveFormats":[]});
        let (url, server) = local(response(
            200,
            "Content-Type: application/json\r\n",
            value.to_string().as_bytes(),
        ));
        player_response(&local_http(), &url, &cfg(), ID, 20700)
            .await
            .unwrap();
        let request = server.join().unwrap();
        assert!(request.starts_with("POST / HTTP/1.1"));
        let (headers, text) = request.split_once("\r\n\r\n").unwrap();
        assert!(
            headers
                .to_ascii_lowercase()
                .contains("x-youtube-client-name: 56")
        );
        assert!(!headers.to_ascii_lowercase().contains("cookie:"));
        assert_eq!(
            serde_json::from_str::<Value>(text).unwrap(),
            body(&cfg(), ID, 20700)
        );
        value["videoDetails"]["videoId"] = json!("jNY_wLukVW0");
        let (url, server) = local(response(200, "", value.to_string().as_bytes()));
        assert!(
            player_response(&local_http(), &url, &cfg(), ID, 20700)
                .await
                .is_err()
        );
        server.join().unwrap();
        for status in [400, 401, 403] {
            let (url, server) = local(response(status, "", b""));
            let error = player_response(&local_http(), &url, &cfg(), ID, 20700)
                .await
                .err()
                .unwrap();
            assert!(config_rejected(&error));
            server.join().unwrap();
        }
    }

    #[tokio::test]
    async fn real_http_body_caps_utf8_status_and_truncation() {
        for raw in [
            response(403, "", b"denied"),
            response(200, "", &[0xff]),
            format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", LIMIT + 1).into_bytes(),
            b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\nshort".to_vec(),
        ] {
            let (url, server) = local(raw);
            let fetched = local_http().get(url).send().await.unwrap();
            assert!(text_response(fetched).await.is_err());
            server.join().unwrap();
        }
    }

    #[tokio::test]
    async fn real_http_80percent_requires_exact206_complete_bytes_and_total() {
        for (status, range, bytes, expected) in [
            (206, "bytes 6553-7576/8192", 1024, true),
            (200, "bytes 6553-7576/8192", 1024, false),
            (206, "bytes 0-1023/8192", 1024, false),
            (206, "bytes 6553-7576/9000", 1024, false),
            (206, "bytes 6553-7576/8192", 1000, false),
        ] {
            let raw = response(
                status,
                &format!("Content-Range: {range}\r\nContent-Type: audio/webm\r\n"),
                &vec![0; bytes],
            );
            let (url, server) = local(raw);
            assert_eq!(
                strict_probe(&local_http(), &url, 8192).await.is_ok(),
                expected
            );
            let request = server.join().unwrap();
            assert!(
                request
                    .to_ascii_lowercase()
                    .contains("range: bytes=6553-7576")
            );
        }
        for (headers, code) in [
            ("Content-Type: text/html\r\n", "NATIVE_EMBEDDED_CDN_MIME"),
            (
                "Content-Type: audio/webm\r\nContent-Encoding: gzip\r\n",
                "NATIVE_EMBEDDED_CDN_ENCODING",
            ),
        ] {
            let (url, server) = local(response(
                206,
                &format!("Content-Range: bytes 6553-7576/8192\r\n{headers}"),
                &vec![0; 1024],
            ));
            let calls = AtomicU64::new(0);
            let http = local_http();
            let result = bounded_cdn_probe(
                || {
                    calls.fetch_add(1, Ordering::Relaxed);
                    strict_probe(&http, &url, 8192)
                },
                &[Duration::ZERO; 5],
                Duration::from_secs(1),
            )
            .await;
            assert!(matches!(result,Err(Error::Failed(actual)) if actual == code));
            assert_eq!(calls.load(Ordering::Relaxed), 1);
            server.join().unwrap();
        }
    }

    #[tokio::test]
    async fn real_http_transient403_retries_exactly_the_same_url_and_range() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!(
            "http://{}/audio?signature=unchanged&n=unchanged",
            listener.local_addr().unwrap()
        );
        let worker = thread::spawn(move || {
            let mut requests = Vec::new();
            for raw in [
                response(403, "", b""),
                response(
                    206,
                    "Content-Range: bytes 6553-7576/8192\r\nContent-Type: audio/webm\r\n",
                    &vec![0; 1024],
                ),
            ] {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                while !request.windows(4).any(|v| v == b"\r\n\r\n") {
                    let mut chunk = [0; 1024];
                    let count = socket.read(&mut chunk).unwrap();
                    assert!(count > 0);
                    request.extend_from_slice(&chunk[..count]);
                }
                requests.push(String::from_utf8(request).unwrap());
                socket.write_all(&raw).unwrap();
            }
            requests
        });
        let http = local_http();
        bounded_cdn_probe(
            || strict_probe(&http, &url, 8192),
            &[Duration::ZERO, Duration::from_millis(5)],
            Duration::from_secs(1),
        )
        .await
        .unwrap();
        let requests = worker.join().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0], requests[1]);
        assert!(requests[0].starts_with("GET /audio?signature=unchanged&n=unchanged HTTP/1.1"));
        assert!(
            requests[0]
                .to_ascii_lowercase()
                .contains("range: bytes=6553-7576")
        );
        assert!(
            requests[0]
                .to_ascii_lowercase()
                .contains("accept-encoding: identity")
        );
    }

    #[tokio::test]
    #[ignore = "explicit anonymous network measurement; no profiles or signed URL output"]
    async fn real_three_kids_and_non_kids_control() {
        struct TraceGuard;
        impl Drop for TraceGuard {
            fn drop(&mut self) {
                TRACE_FIXTURES.store(false, Ordering::Relaxed);
            }
        }
        TRACE_FIXTURES.store(true, Ordering::Relaxed);
        let _trace = TraceGuard;
        let mut success = 0;
        for id in ["DJzjkMBMook", "WtTRMAoN2Fw", "kcUgLakr7bU", "jNY_wLukVW0"] {
            let started = Instant::now();
            match tokio::time::timeout(Duration::from_secs(30), resolve(id)).await {
                Ok(Ok(direct)) => {
                    assert!(direct_audio_url(&direct.url));
                    assert!(direct.itag > 0);
                    success += 1;
                    eprintln!(
                        "embedded id={id} success=true ms={:.1} client={} itag={}",
                        started.elapsed().as_secs_f64() * 1000.0,
                        direct.client,
                        direct.itag
                    );
                }
                Ok(Err(error)) => {
                    let code = match error {
                        Error::Gone(_) => "NATIVE_EMBEDDED_GONE".into(),
                        Error::Failed(code) => code,
                    };
                    assert!(code.starts_with("NATIVE_EMBEDDED_"));
                    eprintln!(
                        "embedded id={id} success=false ms={:.1} category={code}",
                        started.elapsed().as_secs_f64() * 1000.0
                    );
                }
                Err(_) => {
                    eprintln!("embedded id={id} success=false category=NATIVE_EMBEDDED_TIMEOUT")
                }
            }
        }
        eprintln!("embedded measured=4 successes={success} (completion is not compatibility)");
    }
}
