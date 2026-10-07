//! Descargar el audio de un vídeo sin yt-dlp, con la URL del motor propio (`native.rs`). Es lo que
//! usa el móvil, donde yt-dlp no existe (ver `downloads.rs`).
//!
//! Se baja a trozos de 10 MB, porque YouTube frena las descargas de una sola petición, a un archivo
//! `.part`. Si se corta (red, app cerrada), la siguiente vez sigue donde iba. Si la URL caduca o
//! YouTube la corta, se pide otra y se continúa en el mismo byte.

use crate::native;
use crate::ytdlp::query_param;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

const CHUNK: u64 = 10 * 1024 * 1024;
/// Fallos seguidos (sin avanzar nada) antes de rendirse.
const RETRIES: u32 = 4;

static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        // Por lectura, no por petición: con datos lentos un trozo puede tardar más de un minuto.
        .read_timeout(Duration::from_secs(30))
        .build()
        .expect("cliente HTTP")
});

/// Descarga el audio de `video_id` en `target` más la extensión que toque (`.webm` u `.m4a`,
/// según lo que dé YouTube) y devuelve la ruta final. `report` recibe el progreso, de 0 a 1.
pub async fn download(video_id: &str, target: &Path, mut report: impl FnMut(f32)) -> Result<PathBuf, String> {
    let mut direct = native::resolve(video_id, false).await.map_err(|e| e.to_string())?;
    let mut total = size(&direct.url)?;
    let mut part = part_path(target, direct.itag);
    let mut failures = 0;
    loop {
        let done = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        if done > total {
            // Un resto que no cuadra: se empieza de cero.
            let _ = std::fs::remove_file(&part);
            continue;
        }
        report(done as f32 / total as f32);
        if done == total {
            break;
        }
        let end = (done + CHUNK).min(total) - 1;
        match fetch(&direct.url, done, end, &part, total, &mut report).await {
            Ok(()) => failures = 0,
            Err(e) => {
                // Si en este intento se avanzó algo, no cuenta como fallo seguido.
                let now = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
                failures = if now > done { 1 } else { failures + 1 };
                if failures > RETRIES {
                    return Err(format!("No se pudo descargar: {e}"));
                }
                tokio::time::sleep(Duration::from_secs(failures as u64)).await;
                // URL nueva: la anterior puede haber caducado o ser de otra red.
                if let Ok(fresh) = native::resolve(video_id, true).await {
                    if fresh.itag != direct.itag {
                        // Otro formato: lo bajado no sirve.
                        let _ = std::fs::remove_file(&part);
                        part = part_path(target, fresh.itag);
                        total = size(&fresh.url)?;
                    }
                    direct = fresh;
                }
            }
        }
    }
    let file = PathBuf::from(format!("{}.{}", target.display(), extension(&direct.mime)));
    std::fs::rename(&part, &file).map_err(|e| format!("No se pudo guardar {}: {e}", file.display()))?;
    Ok(file)
}

/// Pide los bytes `from..=to` y los añade al final de `part`.
async fn fetch(url: &str, from: u64, to: u64, part: &Path, total: u64, report: &mut impl FnMut(f32)) -> Result<(), String> {
    let mut res = HTTP
        .get(url)
        .header("Range", format!("bytes={from}-{to}"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    match res.status().as_u16() {
        206 => {}
        // Sin rango, YouTube manda el archivo entero: solo vale si se empieza de cero.
        200 if from == 0 => {}
        s => return Err(format!("YouTube ha respondido {s}")),
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(part)
        .map_err(|e| format!("No se pudo escribir {}: {e}", part.display()))?;
    let mut at = from;
    while let Some(bytes) = res.chunk().await.map_err(|e| e.to_string())? {
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        at += bytes.len() as u64;
        report(at as f32 / total as f32);
    }
    file.flush().map_err(|e| e.to_string())?;
    if at == from {
        return Err("YouTube no ha mandado nada".into());
    }
    Ok(())
}

/// Lo que ocupa el audio (`clen` en la URL de YouTube).
fn size(url: &str) -> Result<u64, String> {
    query_param(url, "clen")
        .and_then(|c| c.parse().ok())
        .filter(|&n| n > 0)
        .ok_or_else(|| "YouTube no dice cuánto ocupa el audio".into())
}

/// El `.part` lleva el formato (itag): si la próxima vez YouTube da otro, no se mezclan.
fn part_path(target: &Path, itag: u64) -> PathBuf {
    PathBuf::from(format!("{}.{itag}.part", target.display()))
}

fn extension(mime: &str) -> &'static str {
    if mime.starts_with("audio/webm") {
        "webm"
    } else if mime.starts_with("audio/mp4") {
        "m4a"
    } else {
        "audio"
    }
}

/// Guarda la carátula de un disco descargado, para la notificación y la pantalla de bloqueo sin
/// conexión (ver `PlaybackService.kt`). Si falla, no pasa nada: se queda la de internet.
pub async fn save_cover(url: &str, path: &Path) {
    if path.exists() {
        return;
    }
    let Ok(res) = HTTP.get(url).send().await.and_then(|r| r.error_for_status()) else { return };
    let Ok(bytes) = res.bytes().await else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = path.with_extension("tmp");
    if std::fs::write(&tmp, &bytes).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        let target = Path::new("/x/Artista/Disco/Canción (feat. Otro)");
        assert_eq!(part_path(target, 251), PathBuf::from("/x/Artista/Disco/Canción (feat. Otro).251.part"));
        assert_eq!(extension("audio/webm; codecs=\"opus\""), "webm");
        assert_eq!(extension("audio/mp4; codecs=\"mp4a.40.2\""), "m4a");
        assert_eq!(size("https://x.googlevideo.com/videoplayback?itag=251&clen=3456789&dur=200").unwrap(), 3456789);
        assert!(size("https://x.googlevideo.com/videoplayback?itag=251").is_err());
    }

    /// Descarga de verdad una canción corta (con red): `cargo test direct -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn downloads_a_song() {
        let dir = std::env::temp_dir().join("musify-direct-test");
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("prueba");
        let mut last = 0.0;
        let file = download("dQw4w9WgXcQ", &target, |p| last = p).await.unwrap();
        let len = std::fs::metadata(&file).unwrap().len();
        println!("{} ({len} bytes)", file.display());
        assert!(len > 1_000_000);
        assert_eq!(last, 1.0);
        let _ = std::fs::remove_file(file);
    }
}
