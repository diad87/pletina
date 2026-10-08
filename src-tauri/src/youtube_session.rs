//! Bootstrap anónimo de los clientes web. No ejecuta JavaScript ni comparte perfiles.
//! WEB y WEB_REMIX tienen cachés independientes; esta configuración no describe VISIONOS.

use serde_json::{Map, Value, json};
use std::future::Future;
use std::sync::LazyLock;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

const MAX_BODY: usize = 2 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(2);
const TTL: Duration = Duration::from_secs(6 * 3600);
const COOLDOWN: Duration = Duration::from_secs(30);
const SCHEMA: &str = "YOUTUBE_SESSION_SCHEMA: configuración web no válida";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Surface {
    Music,
    Web,
}

impl Surface {
    fn identity(self) -> (&'static str, u32, &'static str) {
        match self {
            Self::Music => ("WEB_REMIX", 67, "music.youtube.com"),
            Self::Web => ("WEB", 1, "www.youtube.com"),
        }
    }
}

#[derive(Clone, PartialEq)]
pub struct Config {
    pub client_name: String,
    pub client_id: u32,
    pub client_version: String,
    pub api_version: String,
    pub user_agent: String,
    pub visitor_data: Option<String>,
    pub client_context: Map<String, Value>,
}

impl Config {
    /// Nunca propaga datos de cuenta, remoteHost, request o clickTracking del bootstrap.
    pub fn context(&self) -> Value {
        let mut client = Map::new();
        if let Some(platform) = self.client_context.get("platform").and_then(Value::as_str)
            && matches!(platform, "DESKTOP" | "MOBILE")
        {
            client.insert("platform".into(), json!(platform));
        }
        client.insert("clientName".into(), json!(self.client_name));
        client.insert("clientVersion".into(), json!(self.client_version));
        client.insert("userAgent".into(), json!(self.user_agent));
        client.insert("hl".into(), json!("es"));
        client.insert("gl".into(), json!("ES"));
        if let Some(visitor) = &self.visitor_data {
            client.insert("visitorData".into(), json!(visitor));
        }
        json!({ "client": client })
    }
}

#[derive(Default)]
struct State {
    active: Option<(Config, Instant)>,
    failed: Option<(String, Instant)>,
    last_refresh: Option<Instant>,
}

#[derive(Default)]
struct Cache(Mutex<State>);

impl Cache {
    // El cerrojo abarca una sola petición acotada. Los demás callers reutilizan su resultado.
    async fn get<F, Fut>(
        &self,
        surface: Surface,
        previous: Option<&Config>,
        fetch: F,
    ) -> Result<Config, String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Vec<u8>, String>>,
    {
        let started = Instant::now();
        let (name, id, _) = surface.identity();
        if previous.is_some_and(|p| p.client_name != name || p.client_id != id) {
            return Err(SCHEMA.into());
        }
        let mut state = self.0.lock().await;
        if let Some((config, updated)) = &state.active {
            let reusable = match previous {
                None => updated.elapsed() < TTL,
                Some(old) => old != config || *updated > started,
            };
            if reusable {
                return Ok(config.clone());
            }
        }
        if let Some((error, failed)) = &state.failed
            && failed.elapsed() < COOLDOWN
        {
            return state
                .active
                .as_ref()
                .map(|(c, _)| c.clone())
                .ok_or_else(|| error.clone());
        }
        if previous.is_some()
            && state.last_refresh.is_some_and(|at| at.elapsed() < COOLDOWN)
            && let Some((config, _)) = &state.active
        {
            return Ok(config.clone());
        }
        // El primer current no consume este permiso. Después, incluso un bootstrap
        // válido (o con visitante distinto) no provoca otro GET por cada canción.
        if previous.is_some() {
            state.last_refresh = Some(Instant::now());
        }
        match fetch().await.and_then(|body| parse(surface, &body)) {
            Ok(config) => {
                state.active = Some((config.clone(), Instant::now()));
                state.failed = None;
                Ok(config)
            }
            Err(error) => {
                state.failed = Some((error.clone(), Instant::now()));
                state.active.as_ref().map(|(c, _)| c.clone()).ok_or(error)
            }
        }
    }
}

static MUSIC: LazyLock<Cache> = LazyLock::new(Cache::default);
static WEB: LazyLock<Cache> = LazyLock::new(Cache::default);

fn cache(surface: Surface) -> &'static Cache {
    match surface {
        Surface::Music => &MUSIC,
        Surface::Web => &WEB,
    }
}

pub async fn current(surface: Surface) -> Result<Config, String> {
    cache(surface)
        .get(surface, None, || download(surface))
        .await
}

pub async fn refresh(surface: Surface, previous: &Config) -> Result<Config, String> {
    cache(surface)
        .get(surface, Some(previous), || download(surface))
        .await
}

pub async fn warm(surface: Surface) {
    let _ = current(surface).await;
}

static HTTP: LazyLock<Result<reqwest::Client, String>> = LazyLock::new(|| {
    reqwest::Client::builder()
        .user_agent(crate::youtube::BROWSER_UA)
        .redirect(reqwest::redirect::Policy::none())
        .no_gzip()
        .timeout(TIMEOUT)
        .build()
        .map_err(|_| "YOUTUBE_SESSION_HTTP: no se pudo crear el cliente anónimo".into())
});

fn allowed_url(surface: Surface, url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some(surface.identity().2)
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
}

async fn download(surface: Surface) -> Result<Vec<u8>, String> {
    // El plazo incluye todos los saltos y la descarga del cuerpo, no sólo los headers.
    tokio::time::timeout(TIMEOUT, async {
        let http = HTTP.as_ref().map_err(Clone::clone)?;
        // El bootstrap del service worker pertenece a esta misma superficie. En
        // Music la portada europea puede redirigir a consentimiento sin cookies;
        // /sw.js_data entrega su propio WEB_REMIX, nunca el WEB de www.
        let mut url = reqwest::Url::parse(&format!("https://{}/sw.js_data", surface.identity().2))
            .map_err(|_| SCHEMA.to_string())?;
        let referer = format!("https://{}/sw.js", surface.identity().2);
        for redirect in 0..=2 {
            let mut response = http
                .get(url.clone())
                .header("Accept-Language", "es-ES,es;q=0.9")
                .header("Accept-Encoding", "identity")
                .header(reqwest::header::REFERER, &referer)
                .send()
                .await
                .map_err(|_| "YOUTUBE_SESSION_HTTP: falló el bootstrap anónimo")?;
            if response.status().is_redirection() {
                let next = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| url.join(v).ok())
                    .filter(|u| allowed_url(surface, u));
                if redirect == 2 || next.is_none() {
                    return Err("YOUTUBE_SESSION_REDIRECT: redirección no admitida".into());
                }
                url = next.unwrap();
                continue;
            }
            if !response.status().is_success() {
                return Err("YOUTUBE_SESSION_HTTP: bootstrap rechazado".into());
            }
            if response
                .content_length()
                .is_some_and(|n| n > MAX_BODY as u64)
            {
                return Err("YOUTUBE_SESSION_SIZE: bootstrap demasiado grande".into());
            }
            let mut body = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| "YOUTUBE_SESSION_HTTP: bootstrap incompleto")?
            {
                if chunk.len() > MAX_BODY.saturating_sub(body.len()) {
                    return Err("YOUTUBE_SESSION_SIZE: bootstrap demasiado grande".into());
                }
                body.extend_from_slice(&chunk);
            }
            return Ok(body);
        }
        Err("YOUTUBE_SESSION_REDIRECT: demasiadas redirecciones".into())
    })
    .await
    .map_err(|_| "YOUTUBE_SESSION_TIMEOUT: bootstrap agotó su plazo".to_string())?
}

fn same_string(values: &[Option<&Value>]) -> Result<Option<String>, String> {
    let mut result = None;
    for value in values.iter().flatten() {
        let text = value.as_str().ok_or(SCHEMA)?;
        if result.as_deref().is_some_and(|old| old != text) {
            return Err(SCHEMA.into());
        }
        result = Some(text.to_string());
    }
    Ok(result)
}

fn parse(surface: Surface, body: &[u8]) -> Result<Config, String> {
    if body.len() > MAX_BODY {
        return Err("YOUTUBE_SESSION_SIZE: bootstrap demasiado grande".into());
    }
    let text = std::str::from_utf8(body).map_err(|_| SCHEMA)?;
    let config = if let Some(json) = text.strip_prefix(")]}'") {
        service_worker_configuration(surface, json.trim_start())?
    } else {
        configuration(text)?
    };
    let empty = Map::new();
    let client = match config.get("INNERTUBE_CONTEXT") {
        None => &empty,
        Some(value) => value
            .get("client")
            .and_then(Value::as_object)
            .ok_or(SCHEMA)?,
    };
    let (expected_name, expected_id, _) = surface.identity();
    let client_name = same_string(&[
        config.get("INNERTUBE_CLIENT_NAME"),
        client.get("clientName"),
    ])?
    .ok_or(SCHEMA)?;
    let id = config.get("INNERTUBE_CONTEXT_CLIENT_NAME").ok_or(SCHEMA)?;
    let client_id = id
        .as_u64()
        .and_then(|n| u32::try_from(n).ok())
        .or_else(|| {
            id.as_str()
                .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))?
                .parse()
                .ok()
        })
        .ok_or(SCHEMA)?;
    if client_name != expected_name || client_id != expected_id {
        return Err(SCHEMA.into());
    }
    let client_version = same_string(&[
        config.get("INNERTUBE_CLIENT_VERSION"),
        config.get("INNERTUBE_CONTEXT_CLIENT_VERSION"),
        client.get("clientVersion"),
    ])?
    .ok_or(SCHEMA)?;
    if client_version.len() > 64
        || !client_version.contains('.')
        || client_version
            .split('.')
            .any(|part| part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err(SCHEMA.into());
    }
    let api_version = config
        .get("INNERTUBE_API_VERSION")
        .and_then(Value::as_str)
        .ok_or(SCHEMA)?;
    if !api_version.starts_with('v')
        || !(2..=5).contains(&api_version.len())
        || !api_version[1..].bytes().all(|b| b.is_ascii_digit())
        || api_version.as_bytes()[1] == b'0'
    {
        return Err(SCHEMA.into());
    }
    let visitor_data = same_string(&[config.get("VISITOR_DATA"), client.get("visitorData")])?;
    if visitor_data.as_ref().is_some_and(|s| {
        s.is_empty()
            || s.len() > 4096
            || !s
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_%=".contains(&b))
    }) {
        return Err(SCHEMA.into());
    }
    // El UA es el que acabamos de enviar; no se copia un header remoto arbitrario.
    Ok(Config {
        client_name,
        client_id,
        client_version,
        api_version: api_version.into(),
        user_agent: crate::youtube::BROWSER_UA.into(),
        visitor_data,
        client_context: Map::from_iter([("platform".into(), json!("DESKTOP"))]),
    })
}

fn service_worker_configuration(
    surface: Surface,
    text: &str,
) -> Result<Map<String, Value>, String> {
    // Forma JSPB observada anónimamente en ambos hosts: yt.sw.adr -> ytcfg ->
    // device_info. Sólo se leen id, versión y visitante; ni API key ni remoteHost.
    let root: Value = serde_json::from_str(text).map_err(|_| SCHEMA)?;
    let entries = root.as_array().filter(|v| v.len() == 1).ok_or(SCHEMA)?;
    let entry = entries[0].as_array().ok_or(SCHEMA)?;
    if entry.first().and_then(Value::as_str) != Some("yt.sw.adr") {
        return Err(SCHEMA.into());
    }
    let device = entry
        .get(2)
        .and_then(|v| v.get(0))
        .and_then(|v| v.get(0))
        .and_then(Value::as_array)
        .ok_or(SCHEMA)?;
    let (name, id, _) = surface.identity();
    if device.get(15).and_then(Value::as_u64) != Some(u64::from(id)) {
        return Err(SCHEMA.into());
    }
    let version = device.get(16).and_then(Value::as_str).ok_or(SCHEMA)?;
    let mut config = Map::from_iter([
        ("INNERTUBE_CLIENT_NAME".into(), json!(name)),
        ("INNERTUBE_CONTEXT_CLIENT_NAME".into(), json!(id)),
        ("INNERTUBE_CLIENT_VERSION".into(), json!(version)),
        // SW no declara la versión del protocolo. v1 sigue siendo el contrato
        // de transporte implementado aquí: un cambio de protocolo exige código.
        // La versión del CLIENTE sí procede íntegramente del host correspondiente.
        ("INNERTUBE_API_VERSION".into(), json!("v1")),
    ]);
    if let Some(visitor) = device.get(13).filter(|v| !v.is_null()) {
        config.insert("VISITOR_DATA".into(), visitor.clone());
    }
    Ok(config)
}

fn configuration(html: &str) -> Result<Map<String, Value>, String> {
    let mut result = Map::new();
    let mut rest = html;
    let mut calls = 0;
    while let Some(start) = rest.find("<script") {
        rest = &rest[start + 7..];
        if !rest.starts_with(|c: char| c == '>' || c.is_ascii_whitespace()) {
            continue;
        }
        let Some(open) = rest.find('>') else {
            return Err(SCHEMA.into());
        };
        rest = &rest[open + 1..];
        let Some(close) = rest.find("</script>") else {
            return Err(SCHEMA.into());
        };
        let script = &rest[..close];
        rest = &rest[close + 9..];
        let bytes = script.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if matches!(bytes[i], b'\'' | b'"' | b'`') {
                let quote = bytes[i];
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == b'\\' {
                        i = (i + 2).min(bytes.len());
                    } else if bytes[i] == quote {
                        i += 1;
                        break;
                    } else {
                        i += 1;
                    }
                }
                continue;
            }
            if bytes[i..].starts_with(b"//") {
                i += script[i..].find('\n').unwrap_or(bytes.len() - i);
                continue;
            }
            if bytes[i..].starts_with(b"/*") {
                i += script[i + 2..]
                    .find("*/")
                    .map(|n| n + 4)
                    .unwrap_or(bytes.len() - i);
                continue;
            }
            let boundary = i == 0
                || !matches!(bytes[i - 1], b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'_' | b'$' | b'.');
            let marker = if boundary && bytes[i..].starts_with(b"ytcfg.set") {
                Some((9, '(', true))
            } else if boundary && bytes[i..].starts_with(b"ytcfg.data_") {
                Some((11, '=', false))
            } else {
                None
            };
            if let Some((size, separator, call)) = marker {
                let tail = script[i + size..].trim_start();
                if let Some(tail) = tail.strip_prefix(separator) {
                    // La portada real también usa set('clave', valor). No son
                    // configuración JSON: sólo interpretamos objetos literales.
                    if !tail.trim_start().starts_with('{') {
                        i += size;
                        continue;
                    }
                    calls += 1;
                    if calls > 64 {
                        return Err(SCHEMA.into());
                    }
                    let mut stream = serde_json::Deserializer::from_str(tail).into_iter::<Value>();
                    let value = stream.next().ok_or(SCHEMA)?.map_err(|_| SCHEMA)?;
                    let offset = stream.byte_offset();
                    if call && !tail[offset..].trim_start().starts_with(')') {
                        return Err(SCHEMA.into());
                    }
                    for (key, value) in value.as_object().ok_or(SCHEMA)? {
                        if key.starts_with("INNERTUBE_") || key == "VISITOR_DATA" {
                            result.insert(key.clone(), value.clone());
                        }
                    }
                    i = script.len() - tail.len() + offset;
                    continue;
                }
            }
            i += 1;
        }
    }
    if result.is_empty() {
        Err(SCHEMA.into())
    } else {
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn body(surface: Surface, version: &str) -> Vec<u8> {
        let (name, id, _) = surface.identity();
        let config = json!({
            "INNERTUBE_CLIENT_NAME": name, "INNERTUBE_CONTEXT_CLIENT_NAME": id,
            "INNERTUBE_CLIENT_VERSION": version, "INNERTUBE_API_VERSION": "v1",
            "INNERTUBE_CONTEXT": {"client": {"clientName": name, "clientVersion": version,
                "visitorData": "CgtAnon_Visitor123%3D", "remoteHost": "PRIVATE_HOST"},
                "user": {"accountName": "PRIVATE_ACCOUNT"}},
        });
        format!("<script>ytcfg.set({config});</script>").into_bytes()
    }

    // Estructura de las respuestas reales del 08-10-2026; ningún visitante,
    // dirección ni clave descargados se conservan en esta fixture.
    fn sw_body(surface: Surface, version: &str) -> Vec<u8> {
        let mut device = vec![Value::Null; 47];
        device[0] = json!("es");
        device[1] = json!("ES");
        device[3] = json!("PRIVATE_HOST");
        device[13] = json!("Fake_Anonymous%3D");
        device[14] = json!("PRIVATE_REMOTE_UA");
        device[15] = json!(surface.identity().1);
        device[16] = json!(version);
        let data = json!([[
            "yt.sw.adr",
            null,
            [[device], "PRIVATE_API_KEY"],
            "PRIVATE_OTHER"
        ]]);
        format!(")]}}'\n{data}").into_bytes()
    }

    #[test]
    fn real_sw_shape_keeps_surface_identity_and_only_safe_fields() {
        for (surface, name, version) in [
            (Surface::Music, "WEB_REMIX", "1.20261006.10.00"),
            (Surface::Web, "WEB", "2.20261007.01.00"),
        ] {
            let config = parse(surface, &sw_body(surface, version)).ok().unwrap();
            assert_eq!(config.client_name, name);
            assert_eq!(config.client_id, surface.identity().1);
            assert_eq!(config.client_version, version);
            assert_eq!(config.api_version, "v1");
            assert_eq!(config.visitor_data.as_deref(), Some("Fake_Anonymous%3D"));
            assert_eq!(config.user_agent, crate::youtube::BROWSER_UA);
            assert!(!config.context().to_string().contains("PRIVATE"));
        }
        let music = sw_body(Surface::Music, "1.20261006.10.00");
        assert!(parse(Surface::Web, &music).is_err());
        let valid = String::from_utf8(music).unwrap();
        for invalid in [
            valid.replace("yt.sw.adr", "unrelated"),
            valid.replace("1.20261006.10.00", "2/../player"),
            valid.replace("Fake_Anonymous%3D", &"v".repeat(4097)),
            valid.replace("\"Fake_Anonymous%3D\"", "{}"),
            valid.replace("\"Fake_Anonymous%3D\"", "(()=>fetch('private'))()"),
            ")]}'\n[[\"yt.sw.adr\",null,[[[]]]]]".into(),
        ] {
            assert!(parse(Surface::Music, invalid.as_bytes()).is_err());
        }
        let without_visitor = valid.replace("\"Fake_Anonymous%3D\"", "null");
        assert!(
            parse(Surface::Music, without_visitor.as_bytes())
                .unwrap_or_else(|_| panic!("optional visitor rejected"))
                .visitor_data
                .is_none()
        );
    }

    #[test]
    fn homepage_overloaded_set_calls_do_not_hide_literal_configuration() {
        let config = String::from_utf8(body(Surface::Web, "2.20261007.01.00")).unwrap();
        // La página real tiene set('clave', valor) después del bootstrap válido.
        let html = format!(
            "<script>ytcfg.set('initialKey', window.someRuntimeValue);</script>{config}<script>ytcfg.set('lateKey', {{}});ytcfg.set(window.runtimeConfig);</script>"
        );
        let parsed = parse(Surface::Web, html.as_bytes()).ok().unwrap();
        assert_eq!(parsed.client_version, "2.20261007.01.00");
        // Nunca se evalúan expresiones para fabricar una configuración ausente.
        assert!(
            parse(
                Surface::Web,
                b"<script>ytcfg.set(window.runtimeConfig)</script>"
            )
            .is_err()
        );
    }

    #[test]
    fn escaped_json_is_data_and_context_discards_private_fields() {
        let input = String::from_utf8(body(Surface::Music, "1.20261008.00.00"))
            .unwrap()
            .replace("WEB_REMIX", "WEB\\u005fREMIX")
            .replace(
                "PRIVATE_HOST",
                "braces } and escaped quote \\\" and ytcfg.set({})",
            );
        let config = parse(Surface::Music, input.as_bytes()).ok().unwrap();
        assert_eq!(config.client_name, "WEB_REMIX");
        assert_eq!(config.context()["client"]["gl"], "ES");
        let output = config.context().to_string();
        assert!(
            !output.contains("PRIVATE")
                && !output.contains("remoteHost")
                && !output.contains("account")
        );
    }

    #[test]
    fn rejects_cross_client_conflicting_versions_schema_and_oversized_data() {
        let valid = String::from_utf8(body(Surface::Music, "1.20261008.00.00")).unwrap();
        assert!(parse(Surface::Web, valid.as_bytes()).is_err());
        for bad in [
            valid.replace(
                "\"INNERTUBE_CONTEXT_CLIENT_NAME\":67",
                "\"INNERTUBE_CONTEXT_CLIENT_NAME\":1",
            ),
            valid.replacen("1.20261008.00.00", "1.20261009.00.00", 1),
            valid.replace("\"v1\"", "\"v1/../player?token=private\""),
            valid.replace("CgtAnon_Visitor123%3D", &"a".repeat(4097)),
            valid.replace("\"v1\"", "null"),
        ] {
            assert!(parse(Surface::Music, bad.as_bytes()).is_err());
        }
        assert!(parse(Surface::Music, &vec![b' '; MAX_BODY + 1]).is_err());
        assert!(
            parse(
                Surface::Music,
                b"<script>ytcfg.set((()=>fetch('https://private'))());</script>"
            )
            .is_err()
        );
        assert!(
            parse(
                Surface::Music,
                b"<script>const fake='ytcfg.set({})'; /*ytcfg.set({})*/</script>"
            )
            .is_err()
        );
    }

    #[test]
    fn only_same_surface_https_redirects_are_allowed() {
        for url in [
            "http://music.youtube.com/",
            "https://www.youtube.com/",
            "https://music.youtube.com.evil/",
            "https://user@music.youtube.com/",
            "https://music.youtube.com:444/",
        ] {
            assert!(!allowed_url(
                Surface::Music,
                &reqwest::Url::parse(url).unwrap()
            ));
        }
        assert!(allowed_url(
            Surface::Music,
            &reqwest::Url::parse("https://music.youtube.com/?hl=es").unwrap()
        ));
    }

    #[tokio::test]
    async fn concurrent_current_and_refresh_share_transport_and_stale_refresh_keeps_new_version() {
        let cache = Cache::default();
        let calls = AtomicUsize::new(0);
        let fetch = || async {
            calls.fetch_add(1, Ordering::Relaxed);
            tokio::time::sleep(Duration::from_millis(2)).await;
            Ok(body(Surface::Music, "1.1"))
        };
        let (a, b) = tokio::join!(
            cache.get(Surface::Music, None, fetch),
            cache.get(Surface::Music, None, fetch)
        );
        let a = a.ok().unwrap();
        assert!(b.is_ok());
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        // Aunque la versión devuelta no cambie, dos refresh simultáneos comparten respuesta.
        let (first, second) = tokio::join!(
            cache.get(Surface::Music, Some(&a), fetch),
            cache.get(Surface::Music, Some(&a), fetch)
        );
        assert!(first.is_ok() && second.is_ok());
        assert_eq!(calls.load(Ordering::Relaxed), 2);
        assert!(
            cache
                .get(Surface::Music, Some(&a), || async {
                    panic!("unchanged successful bootstrap refreshed again")
                })
                .await
                .is_ok()
        );
        cache.0.lock().await.last_refresh =
            Some(Instant::now() - COOLDOWN - Duration::from_secs(1));
        let changed = cache
            .get(Surface::Music, Some(&a), || async {
                Ok(body(Surface::Music, "1.2"))
            })
            .await
            .ok()
            .unwrap();
        assert_eq!(changed.client_version, "1.2");
        let stale = cache
            .get(Surface::Music, Some(&a), || async {
                panic!("stale refresh fetched")
            })
            .await
            .ok()
            .unwrap();
        assert_eq!(stale.client_version, "1.2");
        assert!(
            cache
                .get(Surface::Music, Some(&changed), || async {
                    panic!("new configuration bypassed refresh cooldown")
                })
                .await
                .is_ok()
        );
        assert!(
            cache
                .get(Surface::Web, Some(&a), || async {
                    panic!("cross-client refresh fetched")
                })
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn expiration_and_failed_refresh_keep_last_valid_and_throttle_failures() {
        let cache = Cache::default();
        let old = cache
            .get(Surface::Web, None, || async {
                Ok(body(Surface::Web, "2.1"))
            })
            .await
            .ok()
            .unwrap();
        cache.0.lock().await.active.as_mut().unwrap().1 =
            Instant::now() - TTL - Duration::from_secs(1);
        let retained = cache
            .get(Surface::Web, None, || async { Err("unavailable".into()) })
            .await
            .ok()
            .unwrap();
        assert_eq!(retained.client_version, old.client_version);
        assert!(
            cache
                .get(Surface::Web, Some(&old), || async {
                    panic!("cooldown fetched")
                })
                .await
                .is_ok()
        );
        cache.0.lock().await.failed.as_mut().unwrap().1 =
            Instant::now() - COOLDOWN - Duration::from_secs(1);
        let new = cache
            .get(Surface::Web, None, || async {
                Ok(body(Surface::Web, "2.2"))
            })
            .await
            .ok()
            .unwrap();
        assert_eq!(new.client_version, "2.2");
        let empty = Cache::default();
        assert!(
            empty
                .get(Surface::Music, None, || async { Err("unavailable".into()) })
                .await
                .is_err()
        );
        assert!(
            empty
                .get(Surface::Music, None, || async {
                    panic!("empty cooldown fetched")
                })
                .await
                .is_err()
        );
    }

    /// Red real, sin cookies ni perfil. Sólo imprime identidad, versión, caché y duración.
    #[tokio::test]
    #[ignore]
    async fn real_anonymous_bootstrap() {
        let mut failures = 0;
        for surface in [Surface::Music, Surface::Web] {
            let started = Instant::now();
            match current(surface).await {
                Ok(config) => {
                    let same = current(surface).await.is_ok_and(|cached| cached == config);
                    println!(
                        "bootstrap {surface:?} ok=true client={} version={} api={} visitor={} cache={} ms={:.1}",
                        config.client_name,
                        config.client_version,
                        config.api_version,
                        config.visitor_data.is_some(),
                        same,
                        started.elapsed().as_secs_f64() * 1000.0
                    );
                    assert!(same);
                }
                Err(error) => {
                    failures += 1;
                    // Todos los errores de transporte/parser de este módulo son categorías locales.
                    println!(
                        "bootstrap {surface:?} ok=false error={error} ms={:.1}",
                        started.elapsed().as_secs_f64() * 1000.0
                    );
                }
            }
        }
        assert_eq!(
            failures, 0,
            "alguna superficie no entregó un bootstrap válido"
        );
    }
}
