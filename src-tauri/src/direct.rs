//! Descargar el audio de un vídeo sin yt-dlp, con la URL del motor propio (`native.rs`). Es lo que
//! usa el móvil, donde yt-dlp no existe (ver `downloads.rs`).
//!
//! Se baja a trozos de 10 MB, porque YouTube frena las descargas de una sola petición, a un archivo
//! `.part`. Si se corta (red, app cerrada), la siguiente vez sigue donde iba. Si la URL caduca o
//! YouTube la corta, se pide otra y se continúa en el mismo byte.

use crate::native;
use crate::ytdlp::query_param;
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

const CHUNK: u64 = 10 * 1024 * 1024;
/// Fallos seguidos (sin avanzar nada) antes de rendirse.
const RETRIES: u32 = 4;

static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        // Los rangos y clen cuentan bytes del archivo, no un cuerpo HTTP descomprimido.
        .no_gzip()
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
    let mut changes = 0;
    loop {
        let done = partial_size(&part)?;
        if done > total {
            // Un resto que no cuadra: se empieza de cero.
            remove_partial(&part)?;
            continue;
        }
        report(done as f32 / total as f32);
        if done == total {
            break;
        }
        let end = done.saturating_add(CHUNK).min(total) - 1;
        match fetch(&direct.url, done, end, &part, total, &mut report).await {
            Ok(()) => failures = 0,
            Err(e) => {
                // Si en este intento se avanzó algo, no cuenta como fallo seguido.
                let now = partial_size(&part)?;
                failures = if now > done { 1 } else { failures + 1 };
                if failures > RETRIES {
                    return Err(format!("No se pudo descargar: {e}"));
                }
                tokio::time::sleep(Duration::from_secs(failures as u64)).await;
                // URL nueva: la anterior puede haber caducado o ser de otra red.
                if let Ok(fresh) = native::resolve(video_id, true).await {
                    let fresh_total = size(&fresh.url)?;
                    if fresh.itag != direct.itag || fresh_total != total || fresh.mime != direct.mime {
                        // Incluso con el mismo itag, otro tamaño puede ser otra representación.
                        // No se mezclan sus bytes ni se deja un reinicio interminable entre formatos.
                        changes += 1;
                        if changes > RETRIES {
                            return Err("La fuente de la descarga cambia continuamente; vuelve a intentarlo".into());
                        }
                        remove_partial(&part)?;
                        part = part_path(target, fresh.itag);
                        remove_partial(&part)?;
                    }
                    total = fresh_total;
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
        .header("Accept-Encoding", "identity")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let header = |name| res.headers().get(name).map(|v| v.to_str().map_err(|_| "Cabecera de descarga no válida".to_string())).transpose();
    let end = response_end(res.status().as_u16(), header("Content-Range")?, header("Content-Length")?, from, to, total)?;
    if header("Content-Encoding")?.is_some_and(|v| !v.eq_ignore_ascii_case("identity")) {
        return Err("La descarga usa una codificación HTTP incompatible con sus rangos".into());
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .open(part)
        .map_err(|e| format!("No se pudo escribir {}: {e}", part.display()))?;
    if file.metadata().map_err(|e| e.to_string())?.len() != from {
        return Err("El archivo parcial cambió durante la descarga; vuelve a intentarlo".into());
    }
    // write + seek permite también truncar en Windows si el cuerpo resulta excesivo.
    file.seek(SeekFrom::Start(from)).map_err(|e| e.to_string())?;
    let mut at = from;
    while let Some(bytes) = res.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() as u64 > end - at {
            // Un cuerpo que excede el rango no es fiable. Conserva solo el parcial previo.
            file.set_len(from).map_err(|e| format!("No se pudo recuperar el archivo parcial: {e}"))?;
            return Err("La descarga ha enviado más bytes de los anunciados".into());
        }
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        at += bytes.len() as u64;
        report(at as f32 / total as f32);
    }
    file.flush().map_err(|e| e.to_string())?;
    if at != end {
        return Err(format!("La descarga se ha cortado: llegaron {} de {} bytes", at - from, end - from));
    }
    Ok(())
}

/// Valida el intervalo completo antes de abrir el parcial para añadir bytes.
/// Devuelve el byte siguiente al final esperado. Un 200 solo vale al empezar desde cero.
fn response_end(status: u16, range: Option<&str>, length: Option<&str>, from: u64, to: u64, total: u64) -> Result<u64, String> {
    let bad = || "El servidor ha enviado un rango de descarga incoherente".to_string();
    if total == 0 || from > to || to >= total { return Err(bad()); }
    let end = match status {
        206 => {
            let (span, size) = range.and_then(|v| v.strip_prefix("bytes ")).and_then(|v| v.split_once('/')).ok_or_else(bad)?;
            let (start, end) = span.split_once('-').ok_or_else(bad)?;
            let start = start.parse::<u64>().map_err(|_| bad())?;
            let end = end.parse::<u64>().map_err(|_| bad())?;
            let size = size.parse::<u64>().map_err(|_| bad())?;
            if start != from || end < start || end > to || size != total { return Err(bad()); }
            end.checked_add(1).ok_or_else(bad)?
        }
        200 if from == 0 => total,
        s => return Err(format!("YouTube ha respondido {s} sin el rango solicitado")),
    };
    if let Some(length) = length {
        if length.parse::<u64>().map_err(|_| bad())? != end - from { return Err(bad()); }
    }
    Ok(end)
}

fn partial_size(path: &Path) -> Result<u64, String> {
    match std::fs::metadata(path) {
        Ok(meta) => Ok(meta.len()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(e) => Err(format!("No se pudo leer el archivo parcial {}: {e}", path.display())),
    }
}

fn remove_partial(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("No se pudo reiniciar la descarga: no se puede borrar {}: {e}", path.display())),
    }
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
    fn validates_response_range_and_length_before_appending() {
        assert_eq!(response_end(206, Some("bytes 16-63/64"), Some("48"), 16, 63, 64).unwrap(), 64);
        assert_eq!(response_end(206, Some("bytes 16-31/64"), Some("16"), 16, 63, 64).unwrap(), 32);
        assert_eq!(response_end(206, Some("bytes 16-63/64"), None, 16, 63, 64).unwrap(), 64);
        for (range, length) in [
            (None, Some("48")),
            (Some("bytes 0-47/64"), Some("48")),
            (Some("bytes 16-63/96"), Some("48")),
            (Some("bytes 16-64/64"), Some("49")),
            (Some("bytes 16-15/64"), Some("0")),
            (Some("bytes 16-63/*"), Some("48")),
            (Some("bytes 16-63/64"), Some("47")),
            (Some("bytes 16-63/64"), Some("bad")),
        ] {
            assert!(response_end(206, range, length, 16, 63, 64).is_err(), "{range:?} / {length:?}");
        }
    }

    #[test]
    fn full_response_is_only_accepted_at_zero_with_the_expected_size() {
        assert_eq!(response_end(200, None, Some("64"), 0, 31, 64).unwrap(), 64);
        assert_eq!(response_end(200, None, None, 0, 31, 64).unwrap(), 64);
        assert!(response_end(200, None, Some("64"), 16, 63, 64).is_err());
        assert!(response_end(200, None, Some("63"), 0, 63, 64).is_err());
        assert!(response_end(403, None, Some("0"), 0, 63, 64).is_err());
        assert!(response_end(206, Some("bytes 0-0/0"), Some("1"), 0, 0, 0).is_err());
    }

    #[test]
    fn failed_partial_cleanup_is_an_error_instead_of_a_retry_loop() {
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("pletina-direct-part-{}-{nonce}", std::process::id()));
        std::fs::create_dir(&path).unwrap();
        assert!(remove_partial(&path).is_err());
        std::fs::remove_dir(&path).unwrap();
        remove_partial(&path).unwrap();
    }

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
