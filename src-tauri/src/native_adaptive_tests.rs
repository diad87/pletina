//! HTTP local real: usa los mismos POST, selección, sonda y recuperador que producción.
//! Sólo las Recipe/Direct privadas de este módulo apuntan al servidor de cada test.
use super::*;
use crate::youtube_session::Config;
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::thread;

const VIDEO: &str = "jNY_wLukVW0";
const AUDIO_URL: &str = "https://r1.googlevideo.com/videoplayback?clen=8192&expire=4102444800";

#[derive(Clone, Debug)]
struct Request {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Value,
}

struct Server {
    base: String,
    http: reqwest::Client,
    seen: Arc<Mutex<Vec<Request>>>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Server {
    fn new(responses: Vec<String>) -> Self {
        Self::with_delays(
            responses
                .into_iter()
                .map(|response| (response, Duration::ZERO))
                .collect(),
        )
    }

    fn with_delays(responses: Vec<(String, Duration)>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let requests = seen.clone();
        let stop = Arc::new(AtomicBool::new(false));
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
                    Err(error) => panic!("local native test server: {error}"),
                };
                // Windows hereda el modo no bloqueante del listener al socket aceptado.
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
                let mut first = lines.next().unwrap().split_whitespace();
                let method = first.next().unwrap().to_string();
                let path = first.next().unwrap().to_string();
                let headers: HashMap<_, _> = lines
                    .filter_map(|line| line.split_once(':'))
                    .map(|(name, value)| (name.to_ascii_lowercase(), value.trim().to_string()))
                    .collect();
                let length: usize = headers
                    .get("content-length")
                    .map(|value| value.parse().unwrap())
                    .unwrap_or(0);
                assert!(length < 64 * 1024);
                while raw.len() < header_end + length {
                    let mut chunk = [0u8; 4096];
                    let n = stream.read(&mut chunk).unwrap();
                    assert!(n > 0);
                    raw.extend_from_slice(&chunk[..n]);
                }
                let body = if length == 0 {
                    Value::Null
                } else {
                    serde_json::from_slice(&raw[header_end..header_end + length]).unwrap()
                };
                requests.lock().unwrap().push(Request {
                    method,
                    path,
                    headers,
                    body,
                });
                let (response, delay) = responses
                    .pop_front()
                    .unwrap_or_else(|| (response(500, "application/json", "{}"), Duration::ZERO));
                thread::sleep(delay);
                // A timeout test intentionally drops the socket before this write.
                let _ = stream.write_all(response.as_bytes());
            }
        });
        Self {
            base,
            http: http_client().unwrap(),
            seen,
            stop,
            worker: Some(worker),
        }
    }

    fn requests(&self) -> Vec<Request> {
        self.seen.lock().unwrap().clone()
    }

    fn recipe(&self, config: &Config) -> (Recipe, Client) {
        let (mut recipe, client) = web_recipe(config);
        recipe.player = format!(
            "{}/youtubei/{}/player?prettyPrint=false",
            self.base, config.api_version
        );
        (recipe, client)
    }

    async fn attempt(&self, config: Config) -> Result<Direct, Error> {
        let (recipe, client) = self.recipe(&config);
        let direct = player_with_http(
            &self.http,
            &recipe,
            &client,
            VIDEO,
            config.visitor_data.as_deref().unwrap(),
            None,
            None,
        )
        .await?;
        // La respuesta sigue conteniendo una URL GoogleVideo válida. Sólo el
        // transporte de su sonda se dirige al servidor local de esta instancia.
        let probe = Direct {
            url: format!("{}/audio?clen=8192", self.base),
            ..direct.clone()
        };
        validate_with_http(&self.http, &probe)
            .await
            .map_err(Error::Failed)?;
        Ok(direct)
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let result = self.worker.take().unwrap().join();
        if !thread::panicking() {
            result.unwrap();
        }
    }
}

fn response(status: u16, mime: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status} Local\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn partial_audio(body: &str) -> String {
    format!(
        "HTTP/1.1 206 Local\r\nContent-Type: audio/webm\r\nContent-Range: bytes 6553-{}/8192\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        6553 + body.len() - 1,
        body.len()
    )
}

fn config(version: &str) -> Config {
    Config {
        client_name: "WEB".into(),
        client_id: 1,
        client_version: version.into(),
        api_version: "v1".into(),
        user_agent: "native-local-test".into(),
        visitor_data: Some(format!("visitor-{version}")),
        client_context: Map::from_iter([("platform".into(), json!("DESKTOP"))]),
    }
}

fn player_response(video: &str) -> Value {
    json!({"playabilityStatus":{"status":"OK"},
    "videoDetails":{"videoId":video,"title":"Song","lengthSeconds":"288"},
    "streamingData":{"adaptiveFormats":[
        {"itag":251,"mimeType":"audio/webm; codecs=\"opus\"","url":AUDIO_URL,"bitrate":128000},
        {"itag":140,"mimeType":"audio/mp4; codecs=\"mp4a.40.2\"","url":AUDIO_URL,"bitrate":128000}
    ]}})
}

#[tokio::test]
async fn http_bad_web_version_refreshes_then_posts_new_identity_and_probes_before_returning() {
    let server = Server::new(vec![
        response(400, "application/json", "{}"),
        response(200, "application/json", &player_response(VIDEO).to_string()),
        partial_audio("confirmed-bytes"),
    ]);
    let refreshes = AtomicUsize::new(0);
    let direct = auto_direct_with_session(
        config("2.1"),
        |config| server.attempt(config),
        |before| {
            assert_eq!(before.client_version, "2.1");
            refreshes.fetch_add(1, Ordering::Relaxed);
            async { Ok(config("2.2")) }
        },
    )
    .await
    .unwrap();
    assert_eq!(direct.url, AUDIO_URL);
    assert_eq!(direct.client, "WEB");
    assert_eq!(refreshes.load(Ordering::Relaxed), 1);
    let requests = server.requests();
    assert_eq!(
        requests
            .iter()
            .map(|r| r.method.as_str())
            .collect::<Vec<_>>(),
        ["POST", "POST", "GET"]
    );
    for (request, version) in requests[..2].iter().zip(["2.1", "2.2"]) {
        assert_eq!(request.path, "/youtubei/v1/player?prettyPrint=false");
        assert_eq!(request.headers["x-youtube-client-name"], "1");
        assert_eq!(request.headers["x-youtube-client-version"], version);
        assert_eq!(
            request.headers["x-goog-visitor-id"],
            format!("visitor-{version}")
        );
        assert_eq!(request.headers["origin"], "https://www.youtube.com");
        assert_eq!(request.body["context"]["client"]["clientName"], "WEB");
        assert_eq!(request.body["context"]["client"]["clientVersion"], version);
        assert!(
            request.body["context"]["client"]
                .get("deviceModel")
                .is_none()
        );
        assert_eq!(request.body["videoId"], VIDEO);
    }
    assert_eq!(requests[2].headers["range"], "bytes=6553-7576");
}

#[tokio::test]
async fn http_identical_or_failed_refresh_never_posts_twice_or_probes() {
    for unavailable in [false, true] {
        let server = Server::new(vec![response(401, "application/json", "{}")]);
        let refreshes = AtomicUsize::new(0);
        let result = auto_direct_with_session(
            config("2.1"),
            |config| server.attempt(config),
            |before| {
                refreshes.fetch_add(1, Ordering::Relaxed);
                async move {
                    if unavailable {
                        Err("bootstrap unavailable".into())
                    } else {
                        Ok(before)
                    }
                }
            },
        )
        .await;
        let expected = if unavailable {
            "NATIVE_AUTO_REFRESH_UNAVAILABLE"
        } else {
            "NATIVE_CLIENT_HTTP_401"
        };
        assert_eq!(result.unwrap_err().to_string(), expected);
        assert_eq!(refreshes.load(Ordering::Relaxed), 1);
        assert_eq!(server.requests().len(), 1);
    }
}

#[tokio::test]
async fn http_wrong_video_never_reaches_the_probe_and_empty_schema_is_structural() {
    for (body, expected) in [
        (
            player_response("other-video").to_string(),
            "NATIVE_VIDEO_IDENTITY",
        ),
        ("{}".into(), "NATIVE_PLAYER_SCHEMA"),
        (
            r#"{"playabilityStatus":{"status":null}}"#.into(),
            "NATIVE_PLAYER_SCHEMA",
        ),
        (
            r#"{"playabilityStatus":{"status":""}}"#.into(),
            "NATIVE_PLAYER_SCHEMA",
        ),
    ] {
        let server = Server::new(vec![response(200, "application/json", &body)]);
        let result = auto_direct_with_session(
            config("2.1"),
            |config| server.attempt(config),
            |before| async move { Ok(before) },
        )
        .await
        .unwrap_err();
        assert_eq!(result.to_string(), expected);
        assert_eq!(broken_client(&result), expected == "NATIVE_PLAYER_SCHEMA");
        assert_eq!(server.requests().len(), 1);
    }
}

#[tokio::test]
async fn http_empty_html_or_truncated_probe_never_returns_a_direct_url() {
    for (probe, expected) in [
        (response(200, "audio/webm", ""), "NATIVE_CDN_EMPTY"),
        (response(200, "TEXT/HTML; charset=UTF-8", "<html>blocked</html>"), "NATIVE_CDN_NOT_AUDIO"),
        ("HTTP/1.1 206 Local\r\nContent-Type: audio/webm\r\nContent-Range: bytes 6553-6562/8192\r\nContent-Length: 10\r\nConnection: close\r\n\r\nabc".into(), "NATIVE_CDN_TRANSPORT"),
    ] {
        let server = Server::new(vec![response(200, "application/json", &player_response(VIDEO).to_string()), probe]);
        let result = auto_direct_with_session(config("2.1"), |config| server.attempt(config),
            |before| async move { Ok(before) }).await.unwrap_err();
        assert_eq!(result.to_string(), expected);
        assert!(!broken_client(&result));
        assert_eq!(server.requests().len(), 2);
    }
}

#[tokio::test]
async fn http_partial_probe_must_cover_the_requested_offset_and_known_total() {
    for header in [
        "",
        "Content-Range: bytes 0-2/8192\r\n",
        "Content-Range: bytes 6553-6555/9000\r\n",
        "Content-Range: bytes 6553-6555/*\r\n",
        "Content-Range: bytes 6553-6556/8192\r\n",
    ] {
        let probe = format!(
            "HTTP/1.1 206 Local\r\nContent-Type: audio/webm\r\n{header}Content-Length: 3\r\nConnection: close\r\n\r\nabc"
        );
        let server = Server::new(vec![
            response(200, "application/json", &player_response(VIDEO).to_string()),
            probe,
        ]);
        let error = server.attempt(config("2.1")).await.unwrap_err();
        assert_eq!(error.to_string(), "NATIVE_CDN_RANGE");
        assert_eq!(server.requests().len(), 2);
    }
}

#[tokio::test]
async fn http_probe_has_its_own_two_second_deadline() {
    let server = Server::with_delays(vec![
        (
            response(200, "application/json", &player_response(VIDEO).to_string()),
            Duration::ZERO,
        ),
        (
            partial_audio("confirmed-bytes"),
            Duration::from_millis(2500),
        ),
    ]);
    let started = Instant::now();
    assert_eq!(
        server.attempt(config("2.1")).await.unwrap_err().to_string(),
        "NATIVE_CDN_TIMEOUT"
    );
    assert!(started.elapsed() < Duration::from_millis(2400));
    assert_eq!(server.requests().len(), 2);
}

#[tokio::test]
async fn http_foreign_redirect_is_rejected_without_contacting_its_target() {
    let foreign = Server::new(vec![response(200, "audio/webm", "not-authorized")]);
    let redirect = format!(
        "HTTP/1.1 302 Local\r\nLocation: {}/foreign\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        foreign.base
    );
    let server = Server::new(vec![
        response(200, "application/json", &player_response(VIDEO).to_string()),
        redirect,
    ]);
    let error = auto_direct_with_session(
        config("2.1"),
        |config| server.attempt(config),
        |before| async move { Ok(before) },
    )
    .await
    .unwrap_err();
    assert_eq!(error.to_string(), "NATIVE_CDN_TRANSPORT");
    assert_eq!(server.requests().len(), 2);
    assert!(foreign.requests().is_empty());
}

#[test]
fn redirects_require_https_same_family_and_no_more_than_three_hops() {
    let url = |url: &str| reqwest::Url::parse(url).unwrap();
    for family in ["youtube.com", "googlevideo.com"] {
        let origin = url(&format!("https://a.{family}/original"));
        let next = url(&format!("https://b.{family}/next"));
        for hops in 1..=3 {
            assert!(redirect_allowed(&vec![origin.clone(); hops], &next));
        }
        assert!(!redirect_allowed(&vec![origin.clone(); 4], &next));
        for bad in [
            format!("http://b.{family}/next"),
            format!("https://b.{family}:444/next"),
            format!("https://user:secret@b.{family}/next"),
            format!("https://{family}.foreign.test/next"),
            "https://foreign.test/next".into(),
        ] {
            assert!(!redirect_allowed(&[origin.clone()], &url(&bad)));
        }
    }
    assert!(!redirect_allowed(
        &[url("https://www.youtube.com/")],
        &url("https://r1.googlevideo.com/")
    ));
    assert!(!redirect_allowed(&[], &url("https://www.youtube.com/")));
}

#[tokio::test]
async fn http_second_failure_stops_recovery_and_video_unavailable_does_not_refresh() {
    let server = Server::new(vec![
        response(400, "application/json", "{}"),
        response(403, "application/json", "{}"),
    ]);
    let refreshes = AtomicUsize::new(0);
    let error = auto_direct_with_session(
        config("2.1"),
        |config| server.attempt(config),
        |_| {
            refreshes.fetch_add(1, Ordering::Relaxed);
            async { Ok(config("2.2")) }
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error.to_string(), "NATIVE_CLIENT_HTTP_403");
    assert_eq!(refreshes.load(Ordering::Relaxed), 1);
    assert_eq!(server.requests().len(), 2);
    let gone = Server::new(vec![response(
        200,
        "application/json",
        r#"{"playabilityStatus":{"status":"UNPLAYABLE","reason":"private"}}"#,
    )]);
    let result = auto_direct_with_session(
        config("2.1"),
        |config| gone.attempt(config),
        |_| async { panic!("An unavailable video must not refresh configuration") },
    )
    .await;
    assert!(matches!(result, Err(Error::Gone(_))));
    assert_eq!(gone.requests().len(), 1);
}

#[tokio::test]
async fn http_reference_preferences_still_select_the_requested_audio_family_and_itag() {
    let server = Server::new(vec![response(
        200,
        "application/json",
        &player_response(VIDEO).to_string(),
    )]);
    let config = config("2.1");
    let (recipe, client) = server.recipe(&config);
    let direct = player_with_http(
        &server.http,
        &recipe,
        &client,
        VIDEO,
        config.visitor_data.as_deref().unwrap(),
        Some("audio/mp4"),
        Some(140),
    )
    .await
    .unwrap();
    assert_eq!(direct.itag, 140);
    assert!(direct.mime.starts_with("audio/mp4"));
    assert_eq!(server.requests().len(), 1);
}

/// Medición de red explícita, sin recetas fijas ni fallback de captura. Un test
/// finalizado acredita la medición y la sanidad de sus éxitos, no que WEB funcione.
/// auto_direct conserva su bootstrap anónimo, renovación y sonda de producción;
/// no se sustituyen ni reinician cachés, configuración, endpoints o perfiles.
#[tokio::test]
#[ignore]
async fn real_anonymous_web_direct_three_videos() {
    let videos = ["jNY_wLukVW0", "nV-F1WSpJIA", "oolpPmuK2I8"];
    let mut successes = 0usize;
    for video_id in videos {
        let started = Instant::now();
        let result = tokio::time::timeout(Duration::from_secs(6), auto_direct(video_id)).await;
        let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
        let diagnostic = match result {
            Ok(Ok(direct)) => {
                // Assertions never interpolate Direct or its signed URL.
                assert!(
                    direct.client == "WEB",
                    "unexpected client in WEB measurement"
                );
                assert!(direct_audio_url(&direct.url), "invalid direct audio origin");
                assert!(
                    direct.itag > 0 && direct.mime.starts_with("audio/"),
                    "invalid audio metadata"
                );
                successes += 1;
                json!({"videoId":video_id,"success":true,"elapsedMs":elapsed_ms,
                    "client":direct.client,"itag":direct.itag})
            }
            Ok(Err(error)) => json!({"videoId":video_id,"success":false,"elapsedMs":elapsed_ms,
                "code":reference_code("player", &error.to_string(), matches!(error, Error::Gone(_)))}),
            Err(_) => json!({"videoId":video_id,"success":false,"elapsedMs":elapsed_ms,
                "code":reference_code("player", "NATIVE_AUTO_TIMEOUT", false)}),
        };
        println!("adaptive-web-live {diagnostic}");
    }
    println!(
        "adaptive-web-live summary {}",
        json!({
            "attempts":videos.len(),"successes":successes,"failures":videos.len()-successes,
            "measurementCompleted":true
        })
    );
}
