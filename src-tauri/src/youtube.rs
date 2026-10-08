//! Búsqueda de canciones en YouTube Music y elección del vídeo que corresponde
//! a una canción de Deezer.
//!
//! La búsqueda usa directamente la API interna de YouTube Music (la misma que usa su web):
//! devuelve artista, disco y duración para elegir la versión correspondiente. La
//! configuración anónima del cliente se descubre y comparte entre búsquedas.

use crate::youtube_session::{self, Config, Surface};
use serde::Deserialize;
use serde_json::{Value, json};

// Only used if the anonymous web bootstrap is unavailable, never to replace a
// discovered session after an authorization failure.
const FALLBACK_CLIENT_VERSION: &str = "1.20260901.01.00";
/// Filtro "Canciones" de YouTube Music.
const SONGS_PARAMS: &str = "EgWKAQIIAWoKEAkQBRAKEAMQBA==";
pub const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/// Puntuación mínima para dar un vídeo por bueno.
pub const MIN_SCORE: i32 = 45;
/// Por debajo de esta puntuación se busca también en YouTube normal.
pub const CONFIDENT_SCORE: i32 = 70;

/// La canción tal como la conocemos por Deezer.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackQuery {
    pub id: u64,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration: u32,
}

impl TrackQuery {
    pub fn search_text(&self) -> String {
        format!("{} {}", self.artist, strip_brackets(&self.title))
    }
}

#[derive(Debug, Clone)]
pub struct Candidate {
    pub video_id: String,
    pub title: String,
    pub artists: Vec<String>,
    pub album: Option<String>,
    pub duration: Option<u32>,
}

pub struct YouTubeMusic {
    http: reqwest::Client,
    #[cfg(test)]
    api_base: Option<String>,
}

#[derive(Debug)]
struct ApiFailure {
    message: String,
    refresh: bool,
}

fn fallback_config() -> Config {
    Config {
        client_name: "WEB_REMIX".into(),
        client_id: 67,
        client_version: FALLBACK_CLIENT_VERSION.into(),
        api_version: "v1".into(),
        user_agent: BROWSER_UA.into(),
        visitor_data: None,
        client_context: Default::default(),
    }
}

fn same_request_config(a: &Config, b: &Config) -> bool {
    a.client_id == b.client_id
        && a.client_version == b.client_version
        && a.api_version == b.api_version
        && a.user_agent == b.user_agent
        && a.visitor_data == b.visitor_data
        && a.context() == b.context()
}

fn valid_endpoint(endpoint: &str) -> bool {
    matches!(endpoint, "search" | "browse")
}

/// Only known search containers qualify, including their legitimately empty arrays.
/// A renderer in an arbitrary response subtree is not a search result.
fn search_sections(response: &Value) -> Option<&[Value]> {
    for path in [
        "/contents/tabbedSearchResultsRenderer/tabs/0/tabRenderer/content/sectionListRenderer/contents",
        "/contents/sectionListRenderer/contents",
    ] {
        if let Some(sections) = response.pointer(path).and_then(Value::as_array) {
            return Some(sections);
        }
    }
    response
        .pointer("/contents/tabbedSearchResultsRenderer/tabs")
        .and_then(Value::as_array)
        .filter(|tabs| tabs.is_empty())
        .map(|_| &[][..])
}

fn valid_response(endpoint: &str, response: &Value) -> bool {
    if !response.is_object() || response.get("error").is_some_and(|error| !error.is_null()) {
        return false;
    }
    if response
        .get("alerts")
        .and_then(Value::as_array)
        .is_some_and(|alerts| {
            alerts.iter().any(|alert| {
                alert.pointer("/alertRenderer/type").and_then(Value::as_str) == Some("ERROR")
            })
        })
    {
        return false;
    }
    match endpoint {
        "search" => search_sections(response).is_some(),
        "browse" => {
            response
                .get("contents")
                .is_some_and(|contents| contents.is_object() || contents.is_array())
                || response
                    .get("continuationContents")
                    .is_some_and(Value::is_object)
                || response
                    .get("onResponseReceivedActions")
                    .is_some_and(Value::is_array)
                || response
                    .get("onResponseReceivedEndpoints")
                    .is_some_and(Value::is_array)
                || response
                    .pointer("/header/musicResponsiveHeaderRenderer")
                    .is_some_and(Value::is_object)
        }
        _ => false,
    }
}

impl YouTubeMusic {
    pub fn new() -> Self {
        let http = reqwest::Client::builder()
            .user_agent(BROWSER_UA)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .expect("cliente HTTP");
        Self {
            http,
            #[cfg(test)]
            api_base: None,
        }
    }

    /// Bootstrap once at app startup; the shared session cache serves later songs.
    pub async fn warmup(&self) {
        youtube_session::warm(Surface::Music).await;
    }

    /// Llamada a la API interna de YouTube Music (`search`, `browse`...), con el contexto de su web.
    pub(crate) async fn api(&self, endpoint: &str, body: Value) -> Result<Value, String> {
        if !valid_endpoint(endpoint) || !body.is_object() {
            return Err("Petición de YouTube Music no válida".into());
        }
        let config = youtube_session::current(Surface::Music)
            .await
            .unwrap_or_else(|_| fallback_config());
        self.api_with_session(endpoint, body, config, |previous| async move {
            youtube_session::refresh(Surface::Music, &previous).await
        })
        .await
    }

    async fn api_with_session<F, R>(
        &self,
        endpoint: &str,
        body: Value,
        config: Config,
        refresh: F,
    ) -> Result<Value, String>
    where
        F: FnOnce(Config) -> R,
        R: std::future::Future<Output = Result<Config, String>>,
    {
        match self.send_api(endpoint, body.clone(), &config).await {
            Ok(value) => Ok(value),
            Err(failure) if failure.refresh => {
                let updated = refresh(config.clone())
                    .await
                    .map_err(|_| failure.message.clone())?;
                // Refresh may return the last valid cache entry during cooldown or
                // after bootstrap failure. Do not repeat the identical HTTP request.
                if same_request_config(&config, &updated) {
                    return Err(failure.message);
                }
                self.send_api(endpoint, body, &updated)
                    .await
                    .map_err(|error| error.message)
            }
            Err(failure) => Err(failure.message),
        }
    }

    async fn send_api(
        &self,
        endpoint: &str,
        mut body: Value,
        config: &Config,
    ) -> Result<Value, ApiFailure> {
        let invalid = || ApiFailure {
            message: "Configuración de YouTube Music no válida".into(),
            refresh: false,
        };
        if !valid_endpoint(endpoint)
            || !body.is_object()
            || config.client_name != "WEB_REMIX"
            || config.client_id != 67
            || !config.api_version.strip_prefix('v').is_some_and(|version| {
                !version.is_empty() && version.bytes().all(|c| c.is_ascii_digit())
            })
        {
            return Err(invalid());
        }
        let base = "https://music.youtube.com/youtubei";
        #[cfg(test)]
        let base = self.api_base.as_deref().unwrap_or(base);
        body["context"] = config.context();
        let mut request = self
            .http
            .post(format!(
                "{base}/{}/{endpoint}?prettyPrint=false",
                config.api_version
            ))
            .header("Content-Type", "application/json")
            .header("Origin", "https://music.youtube.com")
            .header("User-Agent", &config.user_agent)
            .header("X-Youtube-Client-Name", config.client_id.to_string())
            .header("X-Youtube-Client-Version", &config.client_version);
        if let Some(visitor) = &config.visitor_data {
            request = request.header("X-Goog-Visitor-Id", visitor);
        }
        let res = request
            .body(body.to_string())
            .send()
            .await
            .map_err(|_| ApiFailure {
                message: "No se pudo conectar con YouTube Music".into(),
                refresh: false,
            })?;
        if !res.status().is_success() {
            return Err(ApiFailure {
                message: format!("YouTube Music respondió {}", res.status()),
                refresh: matches!(res.status().as_u16(), 400 | 401 | 403),
            });
        }
        let bytes = res.bytes().await.map_err(|_| ApiFailure {
            message: "No se pudo leer la respuesta de YouTube Music".into(),
            refresh: false,
        })?;
        let value = serde_json::from_slice(&bytes).map_err(|_| ApiFailure {
            message: "YouTube Music devolvió una respuesta no reconocida".into(),
            refresh: true,
        })?;
        if !valid_response(endpoint, &value) {
            return Err(ApiFailure {
                message: "YouTube Music devolvió un error o cambió la estructura de su respuesta"
                    .into(),
                refresh: true,
            });
        }
        Ok(value)
    }

    pub async fn search_songs(&self, query: &str) -> Result<Vec<Candidate>, String> {
        let body = json!({
            "query": query,
            "params": SONGS_PARAMS,
        });
        let response = self.api("search", body).await?;
        Ok(parse_search_songs(&response))
    }
}

fn parse_search_songs(response: &Value) -> Vec<Candidate> {
    search_sections(response)
        .unwrap_or_default()
        .iter()
        .filter_map(|s| {
            s.pointer("/musicShelfRenderer/contents")
                .and_then(Value::as_array)
        })
        .flatten()
        .filter_map(parse_song)
        .collect()
}

fn parse_song(item: &Value) -> Option<Candidate> {
    let r = item.get("musicResponsiveListItemRenderer")?;
    let video_id = r
        .pointer("/playlistItemData/videoId")
        .or_else(|| {
            r.pointer("/overlay/musicItemThumbnailOverlayRenderer/content/musicPlayButtonRenderer/playNavigationEndpoint/watchEndpoint/videoId")
        })?
        .as_str()?
        .to_string();
    let columns = r.get("flexColumns")?.as_array()?;
    let runs = |i: usize| {
        columns
            .get(i)
            .and_then(|c| c.pointer("/musicResponsiveListItemFlexColumnRenderer/text/runs"))
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
    };

    let title: String = runs(0)
        .iter()
        .filter_map(|run| run.get("text")?.as_str())
        .collect();
    let mut artists = Vec::new();
    let mut album = None;
    let mut duration = None;
    let mut plain = Vec::new();
    for run in runs(1) {
        let Some(text) = run.get("text").and_then(Value::as_str) else {
            continue;
        };
        let page = run
            .pointer("/navigationEndpoint/browseEndpoint/browseEndpointContextSupportedConfigs/browseEndpointContextMusicConfig/pageType")
            .and_then(Value::as_str);
        match page {
            Some("MUSIC_PAGE_TYPE_ARTIST") => artists.push(text.to_string()),
            Some("MUSIC_PAGE_TYPE_ALBUM") => album = Some(text.to_string()),
            _ => match parse_duration(text) {
                Some(d) => duration = Some(d),
                None if text.trim() != "•" && !text.trim().is_empty() => {
                    plain.push(text.to_string())
                }
                None => {}
            },
        }
    }
    // Artistas sin enlace (p. ej. colaboraciones): el primer texto suelto.
    if artists.is_empty() {
        artists.extend(plain.into_iter().next());
    }
    Some(Candidate {
        video_id,
        title,
        artists,
        album,
        duration,
    })
}

/// "4:48" → 288, "1:02:03" → 3723.
pub fn parse_duration(s: &str) -> Option<u32> {
    let parts: Vec<&str> = s.trim().split(':').collect();
    if !(2..=3).contains(&parts.len())
        || parts
            .iter()
            .any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    parts
        .iter()
        .try_fold(0u32, |acc, p| Some(acc * 60 + p.parse::<u32>().ok()?))
}

/// Palabras que indican otra versión de la canción. Solo penalizan si no están en el título original.
const OTHER_VERSIONS: &[&str] = &[
    "live",
    "en vivo",
    "en directo",
    "directo",
    "concierto",
    "concert",
    "cover",
    "karaoke",
    "instrumental",
    "remix",
    "acoustic",
    "acustico",
    "sped up",
    "slowed",
    "nightcore",
    "8d",
    "reverb",
    "tribute",
    "tributo",
];

/// Cuánto se parece un vídeo a la canción buscada. Cuanto más alto, mejor.
pub fn score(q: &TrackQuery, c: &Candidate, rank: usize) -> i32 {
    let mut score = 0;

    // Duración: la mejor señal para distinguir la versión del disco de directos y remezclas.
    score += match c.duration {
        Some(d) => match d.abs_diff(q.duration) {
            0..=3 => 40,
            4..=7 => 30,
            8..=15 => 10,
            16..=60 => -30,
            _ => -60,
        },
        None => 0,
    };

    let want = base_title(&q.title);
    let got = base_title(&c.title);
    score += if want == got {
        // Mismo título completo, paréntesis incluidos ("Remastered 2009" frente a "2019 Mix").
        if normalize(&q.title) == normalize(&c.title) {
            34
        } else {
            30
        }
    } else if !want.is_empty() && !got.is_empty() && (got.contains(&want) || want.contains(&got)) {
        18
    } else {
        match jaccard(&want, &got) {
            j if j >= 0.5 => 10,
            // Otra canción (aunque sea del mismo grupo y dure lo mismo).
            _ => -40,
        }
    };

    let artist = normalize(&q.artist);
    let artists: Vec<String> = c.artists.iter().map(|a| normalize(a)).collect();
    score += if artists.iter().any(|a| *a == artist) {
        25
    } else if artists
        .iter()
        .any(|a| !a.is_empty() && (a.contains(&artist) || artist.contains(a.as_str())))
    {
        18
    } else {
        -15
    };

    if let Some(album) = &c.album {
        if base_title(album) == base_title(&q.album) {
            score += 8;
        }
    }

    let original = format!(" {} ", normalize(&q.title));
    let candidate = format!(" {} ", normalize(&c.title));
    for word in OTHER_VERSIONS {
        let word = format!(" {word} ");
        if candidate.contains(&word) && !original.contains(&word) {
            score -= 35;
        }
    }

    // YouTube Music ya ordena bien: un pequeño empujón a los primeros resultados.
    score + 5 - (rank as i32).min(5)
}

/// Minúsculas, sin tildes ni signos, espacios simples.
pub fn normalize(s: &str) -> String {
    let mapped: String = s
        .chars()
        .flat_map(char::to_lowercase)
        .map(|c| match c {
            'á' | 'à' | 'ä' | 'â' | 'ã' | 'å' => 'a',
            'é' | 'è' | 'ë' | 'ê' => 'e',
            'í' | 'ì' | 'ï' | 'î' => 'i',
            'ó' | 'ò' | 'ö' | 'ô' | 'õ' | 'ø' => 'o',
            'ú' | 'ù' | 'ü' | 'û' => 'u',
            'ñ' => 'n',
            'ç' => 'c',
            c if c.is_alphanumeric() => c,
            _ => ' ',
        })
        .collect();
    mapped.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Quita lo que va entre paréntesis o corchetes: "Airbag (Remastered)" → "Airbag".
pub fn strip_brackets(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut depth = 0usize;
    for c in s.chars() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out.trim().to_string()
}

/// Título "de base" para comparar: sin paréntesis ni sufijos tipo " - Remastered 2009".
fn base_title(s: &str) -> String {
    let stripped = strip_brackets(s);
    normalize(stripped.split(" - ").next().unwrap_or_default())
}

fn jaccard(a: &str, b: &str) -> f32 {
    let a: std::collections::HashSet<&str> = a.split(' ').collect();
    let b: std::collections::HashSet<&str> = b.split(' ').collect();
    let union = a.union(&b).count();
    if union == 0 {
        0.0
    } else {
        a.intersection(&b).count() as f32 / union as f32
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::{HashMap, VecDeque},
        io::{Read, Write},
        net::TcpListener,
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, Ordering},
        },
        thread,
        time::Duration,
    };

    #[derive(Clone)]
    struct RecordedRequest {
        path: String,
        headers: HashMap<String, String>,
        body: Value,
    }

    // Loopback only; session discovery is injected into api_with_session, so none
    // of these transport/recovery tests contacts YouTube or shares its cache.
    struct MockApi {
        ytm: YouTubeMusic,
        requests: Arc<Mutex<Vec<RecordedRequest>>>,
        stop: Arc<AtomicBool>,
        worker: Option<thread::JoinHandle<()>>,
    }

    impl MockApi {
        fn new(responses: Vec<(u16, String)>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let base = format!("http://{}/youtubei", listener.local_addr().unwrap());
            let requests = Arc::new(Mutex::new(Vec::new()));
            let stop = Arc::new(AtomicBool::new(false));
            let seen = requests.clone();
            let stopped = stop.clone();
            let worker = thread::spawn(move || {
                let mut responses: VecDeque<_> = responses.into();
                while !stopped.load(Ordering::Relaxed) {
                    let (mut stream, _) = match listener.accept() {
                        Ok(stream) => stream,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(1));
                            continue;
                        }
                        Err(error) => panic!("local test server: {error}"),
                    };
                    // En Windows el socket aceptado puede heredar el modo del listener.
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    let mut raw = Vec::new();
                    let header_end = loop {
                        let mut chunk = [0u8; 4096];
                        let n = stream.read(&mut chunk).unwrap();
                        assert!(n > 0 && raw.len() < 64 * 1024);
                        raw.extend_from_slice(&chunk[..n]);
                        if let Some(index) = raw.windows(4).position(|v| v == b"\r\n\r\n") {
                            break index + 4;
                        }
                    };
                    let header = String::from_utf8(raw[..header_end].to_vec()).unwrap();
                    let mut lines = header.lines();
                    let path = lines
                        .next()
                        .unwrap()
                        .split_whitespace()
                        .nth(1)
                        .unwrap()
                        .to_string();
                    let headers: HashMap<_, _> = lines
                        .filter_map(|line| line.split_once(':'))
                        .map(|(name, value)| (name.to_ascii_lowercase(), value.trim().to_string()))
                        .collect();
                    let length: usize = headers.get("content-length").unwrap().parse().unwrap();
                    assert!(length < 64 * 1024);
                    while raw.len() < header_end + length {
                        let mut chunk = [0u8; 4096];
                        let n = stream.read(&mut chunk).unwrap();
                        assert!(n > 0);
                        raw.extend_from_slice(&chunk[..n]);
                    }
                    let body =
                        serde_json::from_slice(&raw[header_end..header_end + length]).unwrap();
                    seen.lock().unwrap().push(RecordedRequest {
                        path,
                        headers,
                        body,
                    });
                    let (status, body) = responses.pop_front().unwrap_or((500, "{}".into()));
                    write!(stream, "HTTP/1.1 {status} Mock\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                }
            });
            let mut ytm = YouTubeMusic::new();
            ytm.api_base = Some(base);
            Self {
                ytm,
                requests,
                stop,
                worker: Some(worker),
            }
        }

        fn requests(&self) -> Vec<RecordedRequest> {
            self.requests.lock().unwrap().clone()
        }
    }

    impl Drop for MockApi {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            let _ = self.worker.take().unwrap().join();
        }
    }

    fn empty_search() -> Value {
        json!({"contents":{"sectionListRenderer":{"contents":[]}}})
    }

    fn fixture_song() -> Value {
        let linked = |text: &str, kind: &str| {
            json!({
                "text": text,
                "navigationEndpoint":{"browseEndpoint":{"browseEndpointContextSupportedConfigs":{
                    "browseEndpointContextMusicConfig":{"pageType":kind}
                }}}
            })
        };
        json!({"musicResponsiveListItemRenderer":{
            "playlistItemData":{"videoId":"jNY_wLukVW0"},
            "flexColumns":[
                {"musicResponsiveListItemFlexColumnRenderer":{"text":{"runs":[{"text":"Airbag"}]}}},
                {"musicResponsiveListItemFlexColumnRenderer":{"text":{"runs":[
                    linked("Radiohead","MUSIC_PAGE_TYPE_ARTIST"), {"text":" • "},
                    linked("OK Computer","MUSIC_PAGE_TYPE_ALBUM"), {"text":" • "}, {"text":"4:48"}
                ]}}}
            ]
        }})
    }

    #[test]
    fn known_search_containers_keep_metadata_and_ignore_unrelated_renderers() {
        let sections = json!([{"musicShelfRenderer":{"contents":[fixture_song()]}}]);
        let direct = json!({"contents":{"sectionListRenderer":{"contents":sections}}});
        let tabbed = json!({"contents":{"tabbedSearchResultsRenderer":{"tabs":[{"tabRenderer":{
            "content":{"sectionListRenderer":{"contents":sections}}
        }}]}}});
        for response in [direct, tabbed] {
            assert!(valid_response("search", &response));
            let candidates = parse_search_songs(&response);
            assert_eq!(candidates.len(), 1);
            let song = &candidates[0];
            assert_eq!(song.video_id, "jNY_wLukVW0");
            assert_eq!(song.artists, ["Radiohead"]);
            assert_eq!(song.album.as_deref(), Some("OK Computer"));
            assert_eq!(song.duration, Some(288));
            assert!(score(&query(), song, 0) >= CONFIDENT_SCORE);
        }
        let unrelated = json!({"arbitrary":{"musicShelfRenderer":{"contents":[fixture_song()]}}});
        assert!(!valid_response("search", &unrelated));
        assert!(parse_search_songs(&unrelated).is_empty());
    }

    #[test]
    fn legitimate_empty_search_and_podcast_browse_shapes_are_valid() {
        for response in [
            empty_search(),
            json!({"contents":{"sectionListRenderer":{"contents":[
                {"messageRenderer":{"text":{"runs":[{"text":"No results"}]}}}
            ]}}}),
            json!({"contents":{"tabbedSearchResultsRenderer":{"tabs":[]}}}),
        ] {
            assert!(valid_response("search", &response));
            assert!(parse_search_songs(&response).is_empty());
        }
        for response in [
            json!({"contents":{"singleColumnBrowseResultsRenderer":{}}}),
            json!({"continuationContents":{"musicShelfContinuation":{"contents":[]}}}),
            json!({"onResponseReceivedActions":[]}),
            json!({"onResponseReceivedEndpoints":[]}),
            json!({"header":{"musicResponsiveHeaderRenderer":{}}}),
        ] {
            assert!(valid_response("browse", &response));
        }
        for response in [
            json!({}),
            json!({"error":{"code":403}}),
            json!({"alerts":[{"alertRenderer":{"type":"ERROR"}}]}),
        ] {
            assert!(!valid_response("search", &response));
            assert!(!valid_response("browse", &response));
        }
    }

    #[tokio::test]
    async fn authorization_refreshes_once_with_coherent_headers_and_changed_visitor() {
        let server = MockApi::new(vec![(403, "{}".into()), (200, empty_search().to_string())]);
        let mut before = fallback_config();
        before.visitor_data = Some("test-before".into());
        let mut after = before.clone();
        after.visitor_data = Some("test-after".into());
        after.api_version = "v2".into();
        after.user_agent = "session-test-agent".into();
        let count = std::cell::Cell::new(0);
        let response = server
            .ytm
            .api_with_session(
                "search",
                json!({"query":"Airbag","context":{"untrusted":true}}),
                before.clone(),
                |previous| {
                    assert!(same_request_config(&previous, &before));
                    count.set(count.get() + 1);
                    let after = after.clone();
                    async move { Ok(after) }
                },
            )
            .await
            .unwrap();
        assert!(parse_search_songs(&response).is_empty());
        assert_eq!(count.get(), 1);
        let requests = server.requests();
        assert_eq!(requests.len(), 2);
        for (request, config) in requests.iter().zip([before, after]) {
            assert_eq!(
                request.path,
                format!("/youtubei/{}/search?prettyPrint=false", config.api_version)
            );
            assert_eq!(request.headers["x-youtube-client-name"], "67");
            assert_eq!(
                request.headers["x-youtube-client-version"],
                config.client_version
            );
            assert_eq!(
                request.headers["x-goog-visitor-id"],
                config.visitor_data.as_deref().unwrap()
            );
            assert_eq!(request.headers["user-agent"], config.user_agent);
            assert_eq!(request.headers["origin"], "https://music.youtube.com");
            assert_eq!(request.body["context"], config.context());
            assert_eq!(request.body["query"], "Airbag");
        }
    }

    #[tokio::test]
    async fn identical_refresh_and_failed_refresh_do_not_send_stale_fallback() {
        for fail_refresh in [false, true] {
            let server = MockApi::new(vec![(401, "{}".into())]);
            let mut live = fallback_config();
            live.client_version = "1.20990101.01.00".into();
            let result = server
                .ytm
                .api_with_session("search", json!({}), live, |previous| async move {
                    if fail_refresh {
                        Err("bootstrap unavailable".into())
                    } else {
                        Ok(previous)
                    }
                })
                .await;
            assert!(result.unwrap_err().contains("401"));
            assert_eq!(server.requests().len(), 1);
        }
    }

    #[tokio::test]
    async fn empty_results_and_unrelated_http_failures_never_refresh() {
        for status in [200, 429, 500] {
            let server = MockApi::new(vec![(status, empty_search().to_string())]);
            let result = server
                .ytm
                .api_with_session("search", json!({}), fallback_config(), |_| async {
                    panic!("this response must not refresh the session")
                })
                .await;
            assert_eq!(result.is_ok(), status == 200);
            assert_eq!(server.requests().len(), 1);
        }
    }

    #[tokio::test]
    async fn structural_and_client_errors_retry_only_once() {
        for (status, body) in [
            (400, "{}"),
            (200, "not json"),
            (200, "{}"),
            (200, r#"{"error":{"code":400}}"#),
        ] {
            let server = MockApi::new(vec![(status, body.into()), (403, "{}".into())]);
            let count = std::cell::Cell::new(0);
            let result = server
                .ytm
                .api_with_session("search", json!({}), fallback_config(), |mut previous| {
                    count.set(count.get() + 1);
                    previous.visitor_data = Some("renewed-only-visitor".into());
                    async move { Ok(previous) }
                })
                .await;
            assert!(result.unwrap_err().contains("403"));
            assert_eq!(count.get(), 1);
            assert_eq!(server.requests().len(), 2);
        }
    }

    #[tokio::test]
    async fn endpoint_and_session_surface_cannot_redirect_requests() {
        let server = MockApi::new(Vec::new());
        for (endpoint, config) in [
            ("../player", fallback_config()),
            ("next", fallback_config()),
            (
                "search",
                Config {
                    api_version: "v1/other".into(),
                    ..fallback_config()
                },
            ),
            (
                "search",
                Config {
                    client_name: "WEB".into(),
                    ..fallback_config()
                },
            ),
            (
                "search",
                Config {
                    client_id: 1,
                    ..fallback_config()
                },
            ),
        ] {
            let result = server
                .ytm
                .api_with_session(endpoint, json!({}), config, |_| async {
                    panic!("invalid local configuration must not refresh")
                })
                .await;
            assert!(result.is_err());
        }
        assert!(server.requests().is_empty());
    }

    fn query() -> TrackQuery {
        TrackQuery {
            id: 1,
            title: "Airbag".into(),
            artist: "Radiohead".into(),
            album: "OK Computer".into(),
            duration: 287,
        }
    }

    fn cand(title: &str, artist: &str, duration: u32) -> Candidate {
        Candidate {
            video_id: "x".into(),
            title: title.into(),
            artists: vec![artist.into()],
            album: None,
            duration: Some(duration),
        }
    }

    #[test]
    fn prefers_album_version_over_live() {
        let q = query();
        let studio = score(&q, &cand("Airbag", "Radiohead", 288), 1);
        let live = score(&q, &cand("Airbag (Live)", "Radiohead", 301), 0);
        assert!(studio >= CONFIDENT_SCORE, "{studio}");
        assert!(live < MIN_SCORE, "{live}");
    }

    #[test]
    fn rejects_other_song_same_artist_same_length() {
        let q = TrackQuery {
            id: 1,
            title: "Spoiler!".into(),
            artist: "Berri Txarrak".into(),
            album: "Infrasoinuak".into(),
            duration: 217,
        };
        assert!(score(&q, &cand("Spoiler!", "Berri Txarrak", 218), 0) >= CONFIDENT_SCORE);
        assert!(score(&q, &cand("Bakarrik Egoteko", "Berri Txarrak", 217), 1) < MIN_SCORE);
    }

    #[test]
    fn rejects_other_artist() {
        let q = query();
        assert!(score(&q, &cand("Airbag", "Someone Else", 200), 0) < MIN_SCORE);
    }

    #[test]
    fn helpers() {
        assert_eq!(parse_duration("4:48"), Some(288));
        assert_eq!(parse_duration("1:02:03"), Some(3723));
        assert_eq!(parse_duration("19 M"), None);
        assert_eq!(normalize("Canción Ñandú!"), "cancion nandu");
        assert_eq!(base_title("Help! (Remastered 2009) - Mono"), "help");
    }
}
