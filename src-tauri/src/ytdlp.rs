//! yt-dlp: saca la URL del audio de un vídeo para reproducirlo en streaming
//! (no descarga nada), y sirve de búsqueda de respaldo en YouTube normal.
//!
//! No va en el instalador: se descarga la primera vez y se actualiza una vez al día,
//! porque deja de funcionar cada vez que YouTube cambia algo.

use crate::youtube::{Candidate, normalize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::OnceCell;

/// Versión autónoma de yt-dlp (sin Python) de cada sistema, y nombre con el que se guarda.
#[cfg(target_os = "windows")]
const RELEASE_ASSET: (&str, &str) = ("yt-dlp.exe", "yt-dlp.exe");
#[cfg(target_os = "macos")]
const RELEASE_ASSET: (&str, &str) = ("yt-dlp_macos", "yt-dlp");
#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
const RELEASE_ASSET: (&str, &str) = ("yt-dlp_linux_aarch64", "yt-dlp");
#[cfg(all(target_os = "linux", not(target_arch = "aarch64")))]
const RELEASE_ASSET: (&str, &str) = ("yt-dlp_linux", "yt-dlp");
// En el móvil no hay yt-dlp (ver docs/plan-mobile.md): `ready` responde que no está.
#[cfg(any(target_os = "android", target_os = "ios"))]
const RELEASE_ASSET: (&str, &str) = ("", "");

/// Formato del audio en streaming: el motor web de Mac (WebKit) va mejor con m4a;
/// Windows y Linux, con webm/opus (en Linux, m4a puede necesitar códecs que no vienen instalados).
#[cfg(target_os = "macos")]
const STREAM_FORMAT: &str = "bestaudio[ext=m4a]/bestaudio";
#[cfg(not(target_os = "macos"))]
const STREAM_FORMAT: &str = "bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio";

/// Formato de las descargas: m4a se reproduce en casi cualquier sitio; en Linux, opus por lo mismo de arriba.
#[cfg(target_os = "linux")]
const DOWNLOAD_FORMAT: &str = "bestaudio[ext=webm]/bestaudio";
#[cfg(not(target_os = "linux"))]
#[cfg_attr(mobile, allow(dead_code))]
const DOWNLOAD_FORMAT: &str = "bestaudio[ext=m4a]/bestaudio";
const UPDATE_EVERY: u64 = 24 * 3600;

/// Lo que se saca de un vídeo para reproducirlo.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoInfo {
    pub url: String,
    #[serde(default)]
    pub title: String,
    pub channel: Option<String>,
    pub duration: Option<f64>,
}

struct Ready {
    bin: PathBuf,
    /// Motor de JavaScript que necesita yt-dlp para YouTube. `None` = el suyo por defecto (deno).
    js_runtime: Option<&'static str>,
}

pub struct YtDlp {
    dir: PathBuf,
    ready: OnceCell<Ready>,
    /// video_id → (info, caducidad en segundos unix). Las URL de YouTube caducan a las ~6 h.
    videos: Mutex<HashMap<String, (VideoInfo, u64)>>,
}

impl YtDlp {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir, ready: OnceCell::new(), videos: Mutex::new(HashMap::new()) }
    }

    /// Deja yt-dlp listo: lo descarga si falta y lo actualiza si hace más de un día.
    /// Si falla (p. ej. sin conexión), se reintenta en la siguiente llamada.
    async fn ready(&self) -> Result<&Ready, String> {
        if cfg!(mobile) {
            return Err("yt-dlp no existe en el móvil".into());
        }
        self.ready
            .get_or_try_init(|| async {
                std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
                let bin = self.dir.join(RELEASE_ASSET.1);
                let stamp = self.dir.join("yt-dlp.updated");
                if !bin.exists() {
                    download(&bin).await?;
                    write_stamp(&stamp);
                } else if now().saturating_sub(read_stamp(&stamp)) > UPDATE_EVERY {
                    // Si la actualización falla, se sigue con la versión que hay.
                    let _ = run(&bin, &["-U"], 90).await;
                    write_stamp(&stamp);
                }
                let js_runtime = detect_js_runtime().await;
                Ok(Ready { bin, js_runtime })
            })
            .await
    }

    /// Arranque en segundo plano para que la primera canción no espere a la descarga.
    pub async fn warm_up(&self) {
        let _ = self.ready().await;
    }

    /// URL del audio (y título, canal y duración) de un vídeo. No descarga nada.
    pub async fn stream(&self, video_id: &str, refresh: bool) -> Result<VideoInfo, String> {
        if !refresh {
            let cached = self.videos.lock().unwrap().get(video_id).cloned();
            if let Some((info, expires)) = cached {
                if expires > now() + 600 {
                    return Ok(info);
                }
            }
        }

        let ready = self.ready().await?;
        let watch = format!("https://music.youtube.com/watch?v={video_id}");
        let mut args = vec![];
        if let Some(js) = ready.js_runtime {
            args.extend(["--js-runtimes", js]);
        }
        args.extend([
            "-f",
            STREAM_FORMAT,
            "--no-playlist",
            "--no-warnings",
            "--print",
            "%(.{url,title,channel,duration})j",
            watch.as_str(),
        ]);
        let out = run(&ready.bin, &args, 40).await?;
        let line = out.lines().find(|l| l.starts_with('{')).ok_or("YouTube no devolvió el audio")?;
        let info: VideoInfo = serde_json::from_str(line).map_err(|e| e.to_string())?;
        let expires = query_param(&info.url, "expire").and_then(|e| e.parse().ok()).unwrap_or(now() + 3 * 3600);
        self.videos.lock().unwrap().insert(video_id.to_string(), (info.clone(), expires));
        Ok(info)
    }

    /// Descarga el audio de un vídeo. `target` es la ruta sin extensión (yt-dlp pone la suya:
    /// m4a si existe, que se reproduce en cualquier sitio). `progress` recibe valores de 0 a 1.
    /// En el móvil no se usa (allí descarga el motor propio, ver direct.rs).
    #[cfg_attr(mobile, allow(dead_code))]
    pub async fn download(&self, video_id: &str, target: &Path, mut progress: impl FnMut(f32)) -> Result<PathBuf, String> {
        let ready = self.ready().await?;
        let watch = format!("https://music.youtube.com/watch?v={video_id}");
        // En las plantillas de nombre de yt-dlp, '%' es especial.
        let template = format!("{}.%(ext)s", target.to_string_lossy().replace('%', "%%"));
        let mut cmd = Command::new(&ready.bin);
        if let Some(js) = ready.js_runtime {
            cmd.args(["--js-runtimes", js]);
        }
        cmd.args([
            "-f",
            DOWNLOAD_FORMAT,
            "--no-playlist",
            "--no-warnings",
            "--no-mtime",
            "--newline",
            "--progress",
            "--progress-template",
            "download:MUSIFY %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s",
            "--print",
            "after_move:filepath",
            "-o",
            template.as_str(),
            watch.as_str(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
        hide_window(&mut cmd);

        let mut child = cmd.spawn().map_err(|e| format!("No se pudo ejecutar yt-dlp: {e}"))?;
        let stdout = child.stdout.take().ok_or("yt-dlp sin salida")?;
        let mut stderr = child.stderr.take().ok_or("yt-dlp sin salida")?;

        let mut file = None;
        let mut lines = BufReader::new(stdout).lines();
        let read = async {
            while let Some(line) = lines.next_line().await? {
                if let Some(rest) = line.strip_prefix("MUSIFY ") {
                    let nums: Vec<f64> = rest.split(' ').map(|n| n.parse().unwrap_or(0.0)).collect();
                    let total = nums.get(1).copied().filter(|t| *t > 0.0).or(nums.get(2).copied()).unwrap_or(0.0);
                    if total > 0.0 {
                        progress((nums[0] / total).clamp(0.0, 1.0) as f32);
                    }
                } else if !line.trim().is_empty() {
                    file = Some(PathBuf::from(line.trim()));
                }
            }
            Ok::<_, std::io::Error>(())
        };
        // stderr se lee a la vez que stdout para que no se llene y bloquee el proceso.
        let mut errors = String::new();
        let both = async { tokio::join!(read, stderr.read_to_string(&mut errors)).0 };
        tokio::time::timeout(Duration::from_secs(15 * 60), both)
            .await
            .map_err(|_| "La descarga tardó demasiado".to_string())?
            .map_err(|e| e.to_string())?;

        let status = child.wait().await.map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(error_line(&errors).unwrap_or("yt-dlp falló").to_string());
        }
        file.filter(|f| f.exists()).ok_or_else(|| "yt-dlp no dejó el archivo".to_string())
    }

    /// Búsqueda de respaldo en YouTube normal, para canciones que no están en YouTube Music.
    pub async fn search(&self, query: &str, artist: &str) -> Result<Vec<Candidate>, String> {
        let ready = self.ready().await?;
        let target = format!("ytsearch8:{query}");
        let out = run(&ready.bin, &["--flat-playlist", "-J", "--no-warnings", target.as_str()], 30).await?;

        #[derive(Deserialize)]
        struct Results {
            entries: Vec<Entry>,
        }
        #[derive(Deserialize)]
        struct Entry {
            id: String,
            title: Option<String>,
            duration: Option<f64>,
            channel: Option<String>,
        }

        let results: Results = serde_json::from_str(&out).map_err(|e| e.to_string())?;
        let artist_norm = normalize(artist);
        Ok(results
            .entries
            .into_iter()
            .filter_map(|e| {
                let title = e.title?;
                // "Grupo - Canción" o "Canción - Grupo": si el grupo está en el título, se separa.
                let (title, from_title) = split_artist(&title, &artist_norm);
                let artists = if from_title { vec![artist.to_string()] } else { e.channel.into_iter().collect() };
                Some(Candidate {
                    video_id: e.id,
                    title,
                    artists,
                    album: None,
                    duration: e.duration.map(|d| d.round() as u32),
                })
            })
            .collect())
    }
}

fn split_artist(title: &str, artist_norm: &str) -> (String, bool) {
    let parts: Vec<&str> = title.splitn(2, " - ").collect();
    if let [a, b] = parts[..] {
        if normalize(a).contains(artist_norm) {
            return (b.trim().to_string(), true);
        }
        if normalize(b).contains(artist_norm) {
            return (a.trim().to_string(), true);
        }
    }
    (title.to_string(), false)
}

async fn download(bin: &Path) -> Result<(), String> {
    let url = format!("https://github.com/yt-dlp/yt-dlp/releases/latest/download/{}", RELEASE_ASSET.0);
    let bytes = reqwest::get(&url)
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("No se pudo descargar yt-dlp: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("No se pudo descargar yt-dlp: {e}"))?;
    let part = bin.with_extension("part");
    std::fs::write(&part, &bytes).map_err(|e| e.to_string())?;
    // En Mac y Linux hay que marcarlo como ejecutable.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&part, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&part, bin).map_err(|e| e.to_string())
}

async fn detect_js_runtime() -> Option<&'static str> {
    let works = |program: &'static str| async move {
        let mut cmd = Command::new(program);
        cmd.arg("--version").stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true);
        hide_window(&mut cmd);
        matches!(tokio::time::timeout(Duration::from_secs(5), cmd.status()).await, Ok(Ok(s)) if s.success())
    };
    if works("deno").await {
        None
    } else if works("node").await {
        Some("node")
    } else {
        None
    }
}

async fn run(bin: &Path, args: &[&str], timeout_secs: u64) -> Result<String, String> {
    let mut cmd = Command::new(bin);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    hide_window(&mut cmd);
    let out = tokio::time::timeout(Duration::from_secs(timeout_secs), cmd.output())
        .await
        .map_err(|_| "YouTube tardó demasiado en responder".to_string())?
        .map_err(|e| format!("No se pudo ejecutar yt-dlp: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(error_line(&stderr).unwrap_or("yt-dlp falló").to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Última línea "ERROR: ..." de yt-dlp, sin el prefijo.
fn error_line(stderr: &str) -> Option<&str> {
    stderr.lines().rev().find(|l| l.starts_with("ERROR")).map(|l| l.trim_start_matches("ERROR: "))
}

/// Sin esto, cada llamada a yt-dlp abriría una ventana de consola.
fn hide_window(cmd: &mut Command) {
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    #[cfg(not(windows))]
    let _ = cmd;
}

pub(crate) fn query_param<'a>(url: &'a str, key: &str) -> Option<&'a str> {
    url.split_once('?')?
        .1
        .split('&')
        .find_map(|kv| kv.strip_prefix(key)?.strip_prefix('='))
}

pub(crate) fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn read_stamp(path: &Path) -> u64 {
    std::fs::read_to_string(path).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0)
}

fn write_stamp(path: &Path) {
    let _ = std::fs::write(path, now().to_string());
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Descarga real a una carpeta temporal, con red:
    /// `cargo test real_download -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn real_download() {
        let ytdlp = YtDlp::new(PathBuf::from(env!("LOCALAPPDATA")).join("dev.musify.desktop").join("bin"));
        let dir = std::env::temp_dir().join(format!("musify-dl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut updates = Vec::new();
        let t = std::time::Instant::now();
        let file = ytdlp
            .download("jNY_wLukVW0", &dir.join("Airbag 100%"), |p| updates.push(p))
            .await
            .unwrap();
        let size = std::fs::metadata(&file).unwrap().len();
        println!("{:?} → {} ({} KB) en {:?}", updates.len(), file.display(), size / 1024, t.elapsed());
        assert!(file.starts_with(&dir), "se guarda donde se pide");
        assert!(file.file_name().unwrap().to_string_lossy().starts_with("Airbag 100%"), "el % no se interpreta");
        assert!(size > 1_000_000);
        assert_eq!(updates.last().copied(), Some(1.0));
        std::fs::remove_file(&file).unwrap();
        std::fs::remove_dir(&dir).unwrap();
    }
}
