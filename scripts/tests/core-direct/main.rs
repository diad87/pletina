//! Actual direct.rs download loop against a deterministic loopback HTTP server.
//! Only native::resolve and the query-parameter helper are adapters; HTTP, files and retries are real.
#[path = "../../../src-tauri/src/direct.rs"]
mod direct;

mod native {
    use std::{collections::VecDeque, sync::Mutex};
    #[derive(Clone)]
    pub struct Direct { pub url: String, pub itag: u64, pub mime: String }
    static SOURCES: Mutex<VecDeque<Direct>> = Mutex::new(VecDeque::new());
    static CALLS: Mutex<Vec<bool>> = Mutex::new(Vec::new());
    pub fn set(sources: Vec<Direct>) { *SOURCES.lock().unwrap() = sources.into(); CALLS.lock().unwrap().clear(); }
    pub fn calls() -> Vec<bool> { CALLS.lock().unwrap().clone() }
    pub async fn resolve(_video: &str, refresh: bool) -> Result<Direct, String> {
        CALLS.lock().unwrap().push(refresh);
        let mut sources = SOURCES.lock().unwrap();
        if sources.len() > 1 { Ok(sources.pop_front().unwrap()) } else { sources.front().cloned().ok_or("No fixture source".into()) }
    }
}
mod ytdlp {
    // Adapter for the URL parser, not the transport or resume algorithm under audit.
    pub fn query_param(url: &str, name: &str) -> Option<String> {
        url.split_once('?')?.1.split('&').find_map(|pair| { let (key, value) = pair.split_once('=')?; (key == name).then(|| value.to_owned()) })
    }
}
use serde_json::{json, Value};
use std::{io::{Read, Write}, net::{TcpListener, TcpStream}, path::{Path, PathBuf}, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::Duration};

#[derive(Clone, Debug)]
struct Request { path: String, range: String }
struct Response { status: u16, body: Vec<u8>, declared: usize, content_range: Option<String> }
impl Response {
    fn status(status: u16) -> Self { Self { status, body: vec![], declared: 0, content_range: None } }
    fn ranged(request: &Request, bytes: &[u8]) -> Self {
        let (from, to) = request.range.trim_start_matches("bytes=").split_once('-').unwrap();
        let from: usize = from.parse().unwrap(); let to: usize = to.parse::<usize>().unwrap().min(bytes.len()-1);
        let body = bytes[from..=to].to_vec();
        Self { status:206, declared:body.len(), body, content_range:Some(format!("bytes {from}-{to}/{}", bytes.len())) }
    }
}
struct Server { base: String, requests: Arc<Mutex<Vec<Request>>>, stop: Arc<AtomicBool>, thread: Option<std::thread::JoinHandle<()>> }
impl Server {
    fn start(handler: impl Fn(&Request, usize) -> Response + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap(); listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new())); let received = requests.clone();
        let stop = Arc::new(AtomicBool::new(false)); let stopping = stop.clone();
        let thread = std::thread::spawn(move || {
            while !stopping.load(Ordering::SeqCst) {
                let Ok((mut socket, _)) = listener.accept() else { std::thread::sleep(Duration::from_millis(1)); continue; };
                socket.set_nonblocking(false).unwrap();
                socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                let mut raw = Vec::new(); let mut buf = [0; 1024];
                while !raw.windows(4).any(|w| w == b"\r\n\r\n") {
                    let count = socket.read(&mut buf).unwrap_or(0); if count == 0 { break; } raw.extend_from_slice(&buf[..count]);
                }
                let raw = String::from_utf8(raw).unwrap();
                if raw.is_empty() { continue; }
                let path = raw.lines().next().unwrap().split_whitespace().nth(1).unwrap().to_string();
                let range = raw.lines().find_map(|line| line.split_once(':').filter(|(key, _)| key.eq_ignore_ascii_case("range")).map(|(_, value)| value.trim().to_string())).unwrap();
                let request = Request { path, range };
                let count = { let mut all = received.lock().unwrap(); all.push(request.clone()); all.len() };
                let response = handler(&request, count);
                write_response(&mut socket, response);
            }
        });
        Self { base, requests, stop, thread:Some(thread) }
    }
    fn url(&self, path: &str, size: usize) -> String { format!("{}{path}?clen={size}", self.base) }
    fn trace(&self) -> Vec<Value> { self.requests.lock().unwrap().iter().map(|r| json!({"path":r.path,"range":r.range})).collect() }
}
impl Drop for Server { fn drop(&mut self) { self.stop.store(true, Ordering::SeqCst); if let Some(thread) = self.thread.take() { thread.join().unwrap(); } } }
fn write_response(socket: &mut TcpStream, response: Response) {
    let range = response.content_range.map(|value| format!("Content-Range: {value}\r\n")).unwrap_or_default();
    if response.declared == usize::MAX {
        let _ = write!(socket, "HTTP/1.1 {} Fixture\r\nTransfer-Encoding: chunked\r\n{range}Connection: close\r\n\r\n", response.status);
        for chunk in response.body.chunks(40) {
            let _ = write!(socket, "{:x}\r\n", chunk.len());
            let _ = socket.write_all(chunk);
            let _ = socket.write_all(b"\r\n");
        }
        let _ = socket.write_all(b"0\r\n\r\n");
        let _ = socket.flush();
        return;
    }
    let _ = write!(socket, "HTTP/1.1 {} Fixture\r\nContent-Length: {}\r\n{range}Connection: close\r\n\r\n", response.status, response.declared);
    let _ = socket.write_all(&response.body); let _ = socket.flush();
}
fn resolved(url: String, itag: u64) -> native::Direct { native::Direct { url, itag, mime:if itag == 140 { "audio/mp4".into() } else { "audio/webm".into() } } }
fn target(root: &Path, name: &str) -> PathBuf { let dir = root.join(name); std::fs::create_dir_all(&dir).unwrap(); dir.join("audio") }
fn part(target: &Path, itag: u64) -> PathBuf { PathBuf::from(format!("{}.{itag}.part", target.display())) }
fn bytes(size: usize) -> Vec<u8> { (0..size).map(|n| (n % 251) as u8).collect() }
fn run<F: std::future::Future<Output=Value>>(tests: &mut Vec<Value>, runtime: &tokio::runtime::Runtime, id: &str, name: &str, action: impl FnOnce() -> F) {
    let started = std::time::Instant::now();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| runtime.block_on(async { tokio::time::timeout(Duration::from_secs(15), action()).await.expect("download did not settle within 15 seconds") })));
    let row = match result {
        Ok(details) => json!({"id":id,"test":name,"status":"pass","details":details,"milliseconds":started.elapsed().as_millis()}),
        Err(error) => { let error = error.downcast_ref::<String>().cloned().or_else(|| error.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or("panic".into()); json!({"id":id,"test":name,"status":"fail","error":error,"milliseconds":started.elapsed().as_millis()}) }
    };
    println!("{row}"); tests.push(row);
}
fn main() {
    let args = std::env::args().collect::<Vec<_>>(); let root = PathBuf::from(&args[1]);
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    if args.get(2).is_some_and(|value| value == "--undeletable") {
        let target = target(&root, "undeletable-part"); let path = part(&target, 251);
        std::fs::write(&path, bytes(80)).unwrap();
        use std::os::windows::fs::OpenOptionsExt;
        // Real Windows file lock: readers/writers allowed, deletion denied while handle is held.
        let _locked_file = std::fs::OpenOptions::new().read(true).share_mode(3).open(&path).unwrap();
        // Confirm the fault is real on this platform before asserting anything about the product.
        let error = std::fs::remove_file(&path).expect_err("fixture must actually deny deletion");
        println!("OBSERVATION confirmed remove_file denial: {error}; calling actual direct::download now");
        std::io::stdout().flush().unwrap();
        native::set(vec![resolved("http://127.0.0.1:1/unused?clen=64".into(), 251)]);
        let result = runtime.block_on(direct::download("fixture", &target, |_| {}));
        println!("OBSERVATION returned: {result:?}");
        assert!(result.is_err(), "undeletable oversized partial must return a recoverable error");
        return;
    }
    let mut tests = Vec::new();
    run(&mut tests, &runtime, "CORE-DL-009", "fresh 206 response and actual bytes/progress", || async {
        let server = Server::start(|request, _| Response::ranged(request, &bytes(64))); let target = target(&root, "fresh");
        native::set(vec![resolved(server.url("/audio", 64), 251)]);
        let mut progress = Vec::new(); let path = direct::download("fixture", &target, |value| progress.push(value)).await.unwrap();
        assert_eq!(std::fs::read(path).unwrap(), bytes(64)); assert_eq!(progress.last(), Some(&1.0));
        json!({"requests":server.trace(),"resolverRefresh":native::calls(),"bytes":64})
    });
    run(&mut tests, &runtime, "CORE-DL-009", "pre-existing partial resumes from its exact byte offset", || async {
        let server = Server::start(|request, _| Response::ranged(request, &bytes(64))); let target = target(&root, "resume");
        std::fs::write(part(&target, 251), &bytes(64)[..16]).unwrap(); native::set(vec![resolved(server.url("/audio", 64), 251)]);
        let path = direct::download("fixture", &target, |_| {}).await.unwrap();
        assert_eq!(std::fs::read(path).unwrap(), bytes(64)); assert_eq!(server.requests.lock().unwrap()[0].range, "bytes=16-63");
        json!({"requests":server.trace(),"bytes":64})
    });
    run(&mut tests, &runtime, "CORE-DL-009", "403 renews URL and resumes the existing partial", || async {
        let server = Server::start(|request, _| if request.path.starts_with("/expired") { Response::status(403) } else { Response::ranged(request, &bytes(64)) });
        let target = target(&root, "refresh-403"); std::fs::write(part(&target, 251), &bytes(64)[..16]).unwrap();
        native::set(vec![resolved(server.url("/expired", 64), 251), resolved(server.url("/fresh", 64), 251)]);
        let path = direct::download("fixture", &target, |_| {}).await.unwrap(); assert_eq!(std::fs::read(path).unwrap(), bytes(64)); assert_eq!(native::calls(), [false,true]);
        json!({"requests":server.trace(),"resolverRefresh":native::calls()})
    });
    run(&mut tests, &runtime, "CORE-DL-009", "connection cut mid-response keeps partial bytes and resumes without duplication", || async {
        let server = Server::start(|request, count| { let mut response = Response::ranged(request, &bytes(64)); if count == 1 { response.body.truncate(16); } response });
        let target = target(&root, "cut-response"); native::set(vec![resolved(server.url("/audio", 64), 251)]);
        let path = direct::download("fixture", &target, |_| {}).await.unwrap(); assert_eq!(std::fs::read(path).unwrap(), bytes(64));
        assert_eq!(server.requests.lock().unwrap()[1].range, "bytes=16-63");
        json!({"requests":server.trace(),"resolverRefresh":native::calls(),"truncatedFirstResponse":true})
    });
    run(&mut tests, &runtime, "CORE-DL-009", "changed itag discards old partial before downloading new format", || async {
        let server = Server::start(|request, _| if request.path.starts_with("/expired") { Response::status(403) } else { Response::ranged(request, &bytes(96)) });
        let target = target(&root, "changed-itag"); std::fs::write(part(&target, 251), &bytes(64)[..16]).unwrap();
        native::set(vec![resolved(server.url("/expired", 64), 251), resolved(server.url("/fresh", 96), 140)]);
        let path = direct::download("fixture", &target, |_| {}).await.unwrap(); assert_eq!(std::fs::read(&path).unwrap(), bytes(96)); assert_eq!(path.extension().unwrap(), "m4a"); assert!(!part(&target,251).exists());
        assert_eq!(server.requests.lock().unwrap()[1].range, "bytes=0-95");
        json!({"requests":server.trace(),"resolverRefresh":native::calls(),"oldPartAbsent":true})
    });
    run(&mut tests, &runtime, "CORE-DL-009", "FAULT changed clen with same itag must not report a truncated file as complete", || async {
        let server = Server::start(|request, _| if request.path.starts_with("/expired") { Response::status(403) } else { Response::ranged(request, &bytes(96)) });
        let target = target(&root, "changed-size"); std::fs::write(part(&target, 251), [255;16]).unwrap();
        native::set(vec![resolved(server.url("/expired", 64), 251), resolved(server.url("/fresh", 96), 251)]);
        let path = direct::download("fixture", &target, |_| {}).await.unwrap(); let actual = std::fs::read(&path).unwrap();
        println!("OBSERVATION {}", json!({"path":path,"expectedBytes":96,"actualBytes":actual.len(),"returnedSuccess":true,"requests":server.trace()}));
        assert_eq!(actual, bytes(96), "renewed URL says clen=96 but total remains 64 when itag is unchanged");
        assert_eq!(server.requests.lock().unwrap()[1].range, "bytes=0-95", "new size requires restarting instead of splicing another representation");
        json!({"restartedAtZero":true})
    });
    run(&mut tests, &runtime, "CORE-DL-009", "FAULT mismatched Content-Range must not silently splice incorrect bytes", || async {
        let server = Server::start(|_request, _| Response { status:206, body:bytes(64)[..48].to_vec(), declared:48, content_range:Some("bytes 0-47/64".into()) });
        let target = target(&root, "wrong-range"); std::fs::write(part(&target, 251), &bytes(64)[..16]).unwrap();
        native::set(vec![resolved(server.url("/audio",64),251)]);
        let result = direct::download("fixture", &target, |_| {}).await;
        if let Ok(path) = result { let actual = std::fs::read(&path).unwrap(); println!("OBSERVATION {}", json!({"returnedSuccess":true,"bytes":actual.len(),"contentMatches":actual==bytes(64),"responseRange":"bytes 0-47/64","requests":server.trace()})); assert_eq!(actual, bytes(64), "the requested bytes were 16-63 but response repeated bytes 0-47"); }
        json!({"requests":server.trace()})
    });
    run(&mut tests, &runtime, "CORE-DL-008", "rename failure returns an error and retains completed partial", || async {
        let server = Server::start(|request, _| Response::ranged(request, &bytes(64))); let target = target(&root,"rename-failure");
        std::fs::create_dir(PathBuf::from(format!("{}.webm",target.display()))).unwrap();
        native::set(vec![resolved(server.url("/audio",64),251)]);
        let error = direct::download("fixture", &target, |_| {}).await.unwrap_err(); assert!(error.contains("No se pudo guardar")); assert_eq!(std::fs::read(part(&target,251)).unwrap(), bytes(64));
        json!({"error":error,"completedPartialPreserved":true,"requests":server.trace()})
    });
    run(&mut tests, &runtime, "CORE-DL-009", "200 full response succeeds only when starting at zero", || async {
        let server = Server::start(|_, _| Response { status:200, body:bytes(64), declared:64, content_range:None });
        let target = target(&root,"full-response"); native::set(vec![resolved(server.url("/audio",64),251)]);
        let file = direct::download("fixture", &target, |_| {}).await.unwrap();
        assert_eq!(std::fs::read(file).unwrap(),bytes(64));
        json!({"requests":server.trace()})
    });
    run(&mut tests, &runtime, "CORE-DL-009", "200 ignoring resumed Range fails without appending or destroying the partial", || async {
        let server = Server::start(|_, _| Response { status:200, body:bytes(64), declared:64, content_range:None });
        let target = target(&root,"ignored-range"); std::fs::write(part(&target,251), &bytes(64)[..16]).unwrap();
        native::set(vec![resolved(server.url("/audio",64),251)]);
        let error = direct::download("fixture", &target, |_| {}).await.unwrap_err();
        assert!(error.contains("200")); assert_eq!(std::fs::read(part(&target,251)).unwrap(),&bytes(64)[..16]);
        assert_eq!(server.trace().len(),5); assert!(!target.with_extension("webm").exists());
        json!({"error":error,"partialUnchanged":true,"requests":server.trace()})
    });
    run(&mut tests, &runtime, "CORE-DL-009", "oversized chunked body rolls back appended bytes and never reports progress above one", || async {
        let server = Server::start(|_, _| Response { status:206, body:bytes(80), declared:usize::MAX, content_range:Some("bytes 16-63/64".into()) });
        let target = target(&root,"oversized-body"); std::fs::write(part(&target,251),&bytes(64)[..16]).unwrap();
        native::set(vec![resolved(server.url("/audio",64),251)]);
        let mut progress = Vec::new(); let error = direct::download("fixture", &target, |value| progress.push(value)).await.unwrap_err();
        println!("OBSERVATION oversized body: {error}; requests={:?}",server.trace());
        assert!(error.contains("más bytes"), "unexpected error: {error}"); assert_eq!(std::fs::read(part(&target,251)).unwrap(),&bytes(64)[..16]);
        assert!(progress.iter().all(|value| *value<=1.0)); assert_eq!(server.trace().len(),5);
        json!({"error":error,"partialUnchanged":true,"maximumProgress":progress.iter().cloned().fold(0.0_f32,f32::max),"requests":server.trace()})
    });
    let failures = tests.iter().filter(|row| row["status"]=="fail").count();
    std::fs::write(root.join("direct-results.json"), serde_json::to_string_pretty(&json!({"schemaVersion":1,"scope":"Real direct.rs + reqwest + filesystem, local HTTP fixture; mocked resolver, no YouTube/Android end-to-end","tests":tests,"pass":tests.len()-failures,"fail":failures})).unwrap()).unwrap();
    if failures>0 { std::process::exit(1); }
}
