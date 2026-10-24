//! WebKitGTK no entrega las URI asset:// a GStreamer. Sirve únicamente los archivos
//! que el reproductor ya ha resuelto, por HTTP loopback con capacidades aleatorias.

use axum::{
    body::Body,
    extract::State,
    http::{Method, Request, StatusCode, header},
    response::{IntoResponse, Response},
    Router,
};
use std::{
    collections::{HashMap, VecDeque},
    io,
    net::Ipv4Addr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::{net::TcpListener, sync::oneshot};
use tower_http::services::ServeFile;
use uuid::Uuid;

const MAX_FILES: usize = 512;
// La canción actual, la precarga y resoluciones concurrentes conservan su URL
// aunque una sesión larga alcance el límite del registro.
const PROTECTED_FILES: usize = 4;

struct Entry {
    path: PathBuf,
    used: u64,
}

#[derive(Default)]
struct Registry {
    files: HashMap<String, Entry>,
    recent: VecDeque<String>,
    clock: u64,
}

impl Registry {
    fn register(&mut self, path: PathBuf) -> String {
        self.clock += 1;
        let existing = self.files.iter().find(|(_, entry)| entry.path == path).map(|(id, _)| id.clone());
        let id = if let Some(id) = existing {
            self.files.get_mut(&id).unwrap().used = self.clock;
            id
        } else {
            if self.files.len() >= MAX_FILES {
                let oldest = self.files.iter()
                    .filter(|(id, _)| !self.recent.contains(id))
                    .min_by_key(|(_, entry)| entry.used)
                    .map(|(id, _)| id.clone());
                if let Some(oldest) = oldest {
                    self.files.remove(&oldest);
                }
            }
            let id = Uuid::new_v4().to_string();
            self.files.insert(id.clone(), Entry { path, used: self.clock });
            id
        };
        self.recent.retain(|recent| recent != &id);
        self.recent.push_back(id.clone());
        while self.recent.len() > PROTECTED_FILES {
            self.recent.pop_front();
        }
        id
    }

    fn get(&mut self, id: &str) -> Option<PathBuf> {
        let entry = self.files.get_mut(id)?;
        self.clock += 1;
        entry.used = self.clock;
        Some(entry.path.clone())
    }
}

struct Shared {
    host: String,
    prefix: String,
    registry: Mutex<Registry>,
}

pub struct LocalMedia {
    shared: Arc<Shared>,
    shutdown: Option<oneshot::Sender<()>>,
}

impl LocalMedia {
    pub async fn start() -> io::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let shared = Arc::new(Shared {
            host: listener.local_addr()?.to_string(),
            prefix: format!("/{}/", Uuid::new_v4()),
            registry: Mutex::new(Registry::default()),
        });
        let router = Router::new().fallback(serve).with_state(shared.clone());
        let (shutdown, stopped) = oneshot::channel();
        tokio::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(async { let _ = stopped.await; })
                .await;
        });
        Ok(Self { shared, shutdown: Some(shutdown) })
    }

    /// Solo se llama tras resolver una canción de la biblioteca o una descarga.
    /// Nunca acepta rutas desde una petición HTTP.
    pub fn register(&self, path: &Path) -> Result<String, String> {
        let path = path.canonicalize().map_err(|_| "No se encuentra el archivo de audio")?;
        if !path.is_file() {
            return Err("El archivo de audio no es un archivo regular".into());
        }
        let id = self.shared.registry.lock().map_err(|_| "No se pudo abrir el audio local")?.register(path);
        Ok(format!("http://{}{}{id}", self.shared.host, self.shared.prefix))
    }
}

impl Drop for LocalMedia {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

async fn serve(State(shared): State<Arc<Shared>>, request: Request<Body>) -> Response {
    // También rechaza otros nombres DNS que pudieran apuntar a loopback.
    if request.headers().get(header::HOST).and_then(|h| h.to_str().ok()) != Some(shared.host.as_str()) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(id) = request.uri().path().strip_prefix(&shared.prefix) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let path = shared.registry.lock().ok().and_then(|mut registry| registry.get(id));
    let Some(path) = path else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return (StatusCode::METHOD_NOT_ALLOWED, [(header::ALLOW, "GET, HEAD")]).into_response();
    }
    // Si un archivo registrado se borra o se sustituye por un enlace, no amplía
    // el permiso a un destino diferente. No se expone ninguna ruta en errores.
    let metadata = tokio::fs::metadata(&path).await;
    if tokio::fs::canonicalize(&path).await.ok().as_ref() != Some(&path) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(metadata) = metadata.ok().filter(|metadata| metadata.is_file()) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // tower-http 0.6 trata bytes=0- de un archivo vacío como 206. No hay ningún
    // byte que servir: el rango es insatisfacible, igual que cualquier otro.
    if metadata.len() == 0 && request.method() == Method::GET && request.headers().contains_key(header::RANGE) {
        return (StatusCode::RANGE_NOT_SATISFIABLE, [(header::CONTENT_RANGE, "bytes */0")]).into_response();
    }
    // La biblioteca se encarga de MIME, streaming, HEAD y rangos HTTP (incluido
    // Content-Range/416). No se carga el archivo completo en memoria.
    let response = ServeFile::new(path).try_call(request).await;
    match response {
        Ok(response) => {
            let mut response = response.map(Body::new);
            response.headers_mut().insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
            response.headers_mut().insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
            response
        }
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::Client;

    struct Fixture {
        server: LocalMedia,
        dir: PathBuf,
        url: String,
    }

    impl Fixture {
        async fn new(bytes: &[u8]) -> Self {
            let dir = std::env::temp_dir().join(format!("pletina-local-media-{}", Uuid::new_v4()));
            std::fs::create_dir(&dir).unwrap();
            let path = dir.join("música con espacios.wav");
            std::fs::write(&path, bytes).unwrap();
            let server = LocalMedia::start().await.unwrap();
            let url = server.register(&path).unwrap();
            Self { server, dir, url }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn client() -> Client {
        Client::builder().no_proxy().timeout(std::time::Duration::from_secs(5)).build().unwrap()
    }

    #[tokio::test]
    async fn serves_get_head_and_byte_ranges() {
        let fixture = Fixture::new(b"0123456789").await;
        assert!(!fixture.url.contains("wav"));
        let client = client();
        let response = client.get(&fixture.url).send().await.unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "10");
        assert_eq!(response.headers()[header::ACCEPT_RANGES], "bytes");
        assert_eq!(response.headers()[header::CONTENT_TYPE], "audio/wav");
        assert_eq!(response.bytes().await.unwrap().as_ref(), b"0123456789");

        let response = client.head(&fixture.url).send().await.unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "10");
        assert!(response.bytes().await.unwrap().is_empty());

        for (range, content_range, bytes) in [
            ("bytes=0-2", "bytes 0-2/10", "012"),
            ("bytes=3-5", "bytes 3-5/10", "345"),
            ("bytes=8-", "bytes 8-9/10", "89"),
            ("bytes=-2", "bytes 8-9/10", "89"),
            ("bytes=8-100", "bytes 8-9/10", "89"),
        ] {
            let response = client.get(&fixture.url).header(header::RANGE, range).send().await.unwrap();
            assert_eq!(response.status(), 206, "{range}");
            assert_eq!(response.headers()[header::CONTENT_RANGE], content_range);
            assert_eq!(response.headers()[header::CONTENT_LENGTH], bytes.len().to_string());
            assert_eq!(response.bytes().await.unwrap().as_ref(), bytes.as_bytes());
        }
        let response = client.get(&fixture.url).header(header::RANGE, "bytes=10-").send().await.unwrap();
        assert_eq!(response.status(), 416);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes */10");
        assert!(response.bytes().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn restricts_access_to_registered_files() {
        let fixture = Fixture::new(b"secret audio").await;
        let client = client();
        let origin = format!("http://{}", fixture.server.shared.host);
        for url in [
            format!("{origin}/"),
            format!("{origin}/wrong/{}", fixture.url.rsplit('/').next().unwrap()),
            format!("{origin}{}unknown", fixture.server.shared.prefix),
            format!("{}/extra.wav", fixture.url),
            format!("{origin}{}%2Fetc%2Fpasswd", fixture.server.shared.prefix),
        ] {
            let response = client.get(url).send().await.unwrap();
            assert_eq!(response.status(), 404);
            assert!(response.bytes().await.unwrap().is_empty());
        }
        let response = client.get(&fixture.url).header(header::HOST, "other.example").send().await.unwrap();
        assert_eq!(response.status(), 404);
        let response = client.post(&fixture.url).send().await.unwrap();
        assert_eq!(response.status(), 405);
        assert!(response.bytes().await.unwrap().is_empty());
        assert!(fixture.server.register(&fixture.dir).is_err());
        assert!(fixture.server.register(&fixture.dir.join("missing")).is_err());
        assert_eq!(fixture.server.register(&fixture.dir.join("música con espacios.wav")).unwrap(), fixture.url);
        std::fs::remove_file(fixture.dir.join("música con espacios.wav")).unwrap();
        let response = client.get(&fixture.url).send().await.unwrap();
        assert_eq!(response.status(), 404);
        assert!(response.bytes().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn empty_files_and_retargeted_symlinks() {
        let fixture = Fixture::new(b"").await;
        let client = client();
        let response = client.get(&fixture.url).send().await.unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "0");
        assert!(response.bytes().await.unwrap().is_empty());
        let response = client.get(&fixture.url).header(header::RANGE, "bytes=0-").send().await.unwrap();
        assert_eq!(response.status(), 416);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes */0");
        let path = fixture.dir.join("música con espacios.wav");
        let other = fixture.dir.join("other.wav");
        std::fs::write(&other, b"unregistered").unwrap();
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(&other, &path).unwrap();
        let response = client.get(&fixture.url).send().await.unwrap();
        assert_eq!(response.status(), 404);
    }

    #[test]
    fn bounds_registry_without_evicting_recent_resolutions() {
        let mut registry = Registry::default();
        for i in 0..MAX_FILES {
            registry.register(PathBuf::from(format!("track-{i}.wav")));
        }
        let current = registry.register(PathBuf::from("track-0.wav"));
        let preload = registry.register(PathBuf::from("track-1.wav"));
        let previous = registry.files.len();
        registry.register(PathBuf::from("new-track.wav"));
        assert_eq!(registry.files.len(), previous);
        assert!(registry.get(&current).is_some());
        assert!(registry.get(&preload).is_some());
        assert!(!registry.files.values().any(|entry| entry.path == Path::new("track-2.wav")));
        for i in 0..MAX_FILES * 2 {
            registry.register(PathBuf::from(format!("extra-{i}.wav")));
        }
        assert_eq!(registry.files.len(), MAX_FILES);
    }
}
