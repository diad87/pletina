//! Extractores que se actualizan solos, sin sacar otra versión de la app: la receta del motor
//! propio (`recipe`), el script de captura oficial (`capture`) y el motor youtubei.js
//! (`youtubei`). Cada uno tiene su `version` y su `api` (la forma en que habla con esta app) en
//! `extractors.json`. yt-dlp no está aquí: se actualiza él solo desde su propio GitHub (`ytdlp.rs`).
//!
//! Se publican firmados, con la misma clave que las actualizaciones de la app, en la versión
//! `extractores` de diad87/musify-releases (`scripts/extractors.mjs`). La app mira al arrancar y
//! cada 6 horas: si hay uno con la api que entiende y una versión mayor que la que tiene, lo baja,
//! comprueba la firma y lo usa desde ese momento. Si no hay nada descargado, o no vale, se usa el
//! que trae la app.
//!
//! La firma cubre también el nombre del archivo (`recipe-api1-v3.json`), así que nadie puede hacer
//! pasar un extractor viejo por uno nuevo cambiando el índice.
//!
//! `MUSIFY_EXTRACTORS_URL` cambia de dónde se leen: otra URL del índice o una carpeta (para probar).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, OnceLock, RwLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const MANIFEST_URL: &str = "https://github.com/diad87/musify-releases/releases/download/extractores/extractores.json";
const FIRST_CHECK: Duration = Duration::from_secs(5);
const CHECK_EVERY: Duration = Duration::from_secs(6 * 3600);
const MAX_SIZE: usize = 8 * 1024 * 1024;

/// Versión de la forma de hablar con cada extractor que entiende esta app. Debe coincidir con
/// `extractors.json` (lo comprueba un test).
pub const API: [(&str, u32); 3] = [("recipe", 1), ("capture", 3), ("youtubei", 1)];

const BUNDLED_META: &str = include_str!("../extractors.json");
const BUNDLED_RECIPE: &str = include_str!("../recipe/youtube.json");
const BUNDLED_CAPTURE: &str = concat!(
    include_str!("capture-mp4.js"), "\n;\n",
    include_str!("capture-core.js"), "\n;\n",
    include_str!("capture-youtube.js"), "\n;\n",
    include_str!("capture.js"),
);

fn ext(name: &str) -> &'static str {
    match name {
        "recipe" => "json",
        _ => "js",
    }
}

fn api(name: &str) -> u32 {
    API.iter().find(|(n, _)| *n == name).map(|(_, a)| *a).unwrap_or(0)
}

/// Ficha de un extractor descargado (versión y firma), junto a su archivo (`recipe.json`, `capture.js`...).
fn meta_name(name: &str) -> String {
    format!("{name}.meta.json")
}

/// Nombre del archivo publicado (y firmado) de un extractor.
fn file_name(name: &str, api: u32, version: u32) -> String {
    format!("{name}-api{api}-v{version}.{}", ext(name))
}

/// Versiones de los extractores que trae la app.
static BUNDLED: LazyLock<HashMap<String, u32>> = LazyLock::new(|| {
    let meta: Value = serde_json::from_str(BUNDLED_META).expect("extractors.json");
    API.iter()
        .map(|(name, _)| (name.to_string(), meta[name]["version"].as_u64().unwrap_or(0) as u32))
        .collect()
});

/// Extractores descargados que están en uso: nombre → (versión, código).
static ACTIVE: LazyLock<RwLock<HashMap<String, (u32, Arc<str>)>>> = LazyLock::new(Default::default);
static DIR: OnceLock<PathBuf> = OnceLock::new();

/// Lo que se guarda junto a cada extractor descargado.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Installed {
    api: u32,
    version: u32,
    sha256: String,
    signature: String,
}

/// Una entrada del índice publicado.
#[derive(Debug, Clone, Deserialize)]
struct Entry {
    name: String,
    api: u32,
    version: u32,
    sha256: String,
    signature: String,
}

#[derive(Debug, Deserialize)]
struct Manifest {
    components: Vec<Entry>,
}

/// Versión y origen de cada extractor, para la interfaz.
#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub name: &'static str,
    pub version: u32,
    pub downloaded: bool,
}

pub fn status() -> Vec<Status> {
    let active = ACTIVE.read().unwrap();
    API.iter()
        .map(|(name, _)| match active.get(*name) {
            Some((v, _)) => Status { name, version: *v, downloaded: true },
            None => Status { name, version: BUNDLED[*name], downloaded: false },
        })
        .collect()
}

fn active(name: &str) -> Option<Arc<str>> {
    ACTIVE.read().unwrap().get(name).map(|(_, code)| code.clone())
}

/// Script de captura oficial que se mete en la ventana oculta.
pub fn capture_script() -> Arc<str> {
    active("capture").unwrap_or_else(|| BUNDLED_CAPTURE.into())
}

/// La receta incluida en la app (el motor propio la usa si la descargada no vale).
pub fn bundled_recipe() -> &'static str {
    BUNDLED_RECIPE
}

#[derive(Serialize)]
pub struct Module {
    version: u32,
    code: Arc<str>,
}

/// Código de un extractor de la interfaz (youtubei.js) si hay uno descargado más nuevo que el
/// incluido; si no, la interfaz usa el suyo.
#[tauri::command]
pub fn extractor_module(name: String) -> Option<Module> {
    if name != "youtubei" {
        return None;
    }
    ACTIVE.read().unwrap().get("youtubei").map(|(version, code)| Module { version: *version, code: code.clone() })
}

/// Carga los extractores ya descargados y empieza a mirar si hay nuevos.
pub fn start(app: &AppHandle) {
    let Ok(dir) = app.path().app_local_data_dir().map(|d| d.join("extractors")) else { return };
    let _ = std::fs::create_dir_all(&dir);
    for (name, _) in API {
        if let Err(e) = load(&dir, name) {
            eprintln!("[extractores] {name}: se queda el incluido ({e})");
        }
    }
    let _ = DIR.set(dir);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            if let Err(e) = check(&app).await {
                eprintln!("[extractores] no se pudo mirar si hay nuevos: {e}");
            }
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

/// Usa el extractor guardado si sigue valiendo: misma api, más nuevo que el incluido, intacto y
/// con firma buena.
fn load(dir: &Path, name: &'static str) -> Result<(), String> {
    let meta = dir.join(meta_name(name));
    let Ok(text) = std::fs::read_to_string(&meta) else { return Ok(()) };
    let info: Installed = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if info.api != api(name) || info.version <= BUNDLED[name] {
        return Ok(());
    }
    let data = std::fs::read(dir.join(format!("{name}.{}", ext(name)))).map_err(|e| e.to_string())?;
    verify(&data, &info.sha256, &info.signature, &file_name(name, info.api, info.version))?;
    activate(name, info.version, data)
}

/// Pone en uso un extractor ya comprobado.
fn activate(name: &str, version: u32, data: Vec<u8>) -> Result<(), String> {
    let code = String::from_utf8(data).map_err(|e| e.to_string())?;
    // La receta tiene que entenderse antes de usarla.
    if name == "recipe" {
        crate::native::set_recipe(&code)?;
    }
    ACTIVE.write().unwrap().insert(name.to_string(), (version, code.into()));
    Ok(())
}

/// Mira el índice publicado y baja los extractores nuevos.
async fn check(app: &AppHandle) -> Result<(), String> {
    let source = std::env::var("MUSIFY_EXTRACTORS_URL").unwrap_or_else(|_| MANIFEST_URL.to_string());
    let manifest: Manifest = serde_json::from_slice(&fetch(&source, "extractores.json").await?).map_err(|e| e.to_string())?;
    for (name, supported) in API {
        let current = ACTIVE.read().unwrap().get(name).map(|(v, _)| *v).unwrap_or(BUNDLED[name]);
        // La versión más nueva publicada para la api que entiende esta app.
        let Some(entry) = manifest
            .components
            .iter()
            .filter(|e| e.name == name && e.api == supported && e.version > current)
            .max_by_key(|e| e.version)
        else {
            continue;
        };
        match install(&source, entry).await {
            Ok(()) => {
                eprintln!("[extractores] {name} v{} en uso", entry.version);
                let _ = app.emit("extractors-updated", serde_json::json!({ "name": name, "version": entry.version }));
            }
            Err(e) => eprintln!("[extractores] {name} v{}: no se usa ({e})", entry.version),
        }
    }
    Ok(())
}

async fn install(source: &str, e: &Entry) -> Result<(), String> {
    let file = file_name(&e.name, e.api, e.version);
    let data = fetch(source, &file).await?;
    verify(&data, &e.sha256, &e.signature, &file)?;
    activate(&e.name, e.version, data.clone())?;
    // Se guarda para los próximos arranques (primero a un temporal, para no dejarlo a medias).
    if let Some(dir) = DIR.get() {
        let info = Installed { api: e.api, version: e.version, sha256: e.sha256.clone(), signature: e.signature.clone() };
        let path = dir.join(format!("{}.{}", e.name, ext(&e.name)));
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, &data).and_then(|_| std::fs::rename(&tmp, &path)).map_err(|e| e.to_string())?;
        std::fs::write(dir.join(meta_name(&e.name)), serde_json::to_string_pretty(&info).unwrap())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Un archivo de la misma carpeta que el índice (en GitHub o en el disco, para probar).
async fn fetch(source: &str, file: &str) -> Result<Vec<u8>, String> {
    let data = if source.starts_with("https://") || source.starts_with("http://") {
        let url = match source.rsplit_once('/') {
            Some((base, _)) => format!("{base}/{file}"),
            None => return Err("URL no válida".into()),
        };
        static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
            reqwest::Client::builder().timeout(Duration::from_secs(30)).build().expect("cliente HTTP")
        });
        let res = HTTP.get(&url).send().await.and_then(|r| r.error_for_status()).map_err(|e| e.to_string())?;
        res.bytes().await.map_err(|e| e.to_string())?.to_vec()
    } else {
        std::fs::read(Path::new(source).join(file)).map_err(|e| format!("{file}: {e}"))?
    };
    if data.len() > MAX_SIZE {
        return Err(format!("{file}: demasiado grande"));
    }
    Ok(data)
}

/// Comprueba que el archivo es el publicado: su resumen y la firma, que además tiene que ser la de
/// ese nombre de archivo (extractor, api y versión).
fn verify(data: &[u8], sha256: &str, signature: &str, file: &str) -> Result<(), String> {
    use base64::Engine;
    use minisign_verify::{PublicKey, Signature};
    let digest: String = Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect();
    if !digest.eq_ignore_ascii_case(sha256) {
        return Err("el archivo no coincide con el publicado".into());
    }
    let text = |b64: &str| {
        base64::engine::general_purpose::STANDARD
            .decode(b64.trim())
            .ok()
            .and_then(|b| String::from_utf8(b).ok())
            .ok_or_else(|| "firma o clave mal formada".to_string())
    };
    let key = PublicKey::decode(&text(&public_key())?).map_err(|e| e.to_string())?;
    let sig = Signature::decode(&text(signature)?).map_err(|e| e.to_string())?;
    key.verify(data, &sig, true).map_err(|_| "firma no válida".to_string())?;
    // Solo después de verificar la firma se puede confiar en el comentario firmado.
    let expected = format!("file:{file}");
    if !sig.trusted_comment().split('\t').any(|part| part == expected) {
        return Err("la firma es de otro archivo".into());
    }
    Ok(())
}

/// La clave pública de las actualizaciones de la app (`tauri.conf.json`).
fn public_key() -> String {
    static KEY: LazyLock<String> = LazyLock::new(|| {
        let conf: Value = serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        conf["plugins"]["updater"]["pubkey"].as_str().unwrap_or_default().to_string()
    });
    KEY.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_matches_extractors_json() {
        let meta: Value = serde_json::from_str(BUNDLED_META).unwrap();
        for (name, api) in API {
            assert_eq!(meta[name]["api"].as_u64(), Some(api as u64), "api de {name}");
            assert!(meta[name]["version"].as_u64().unwrap() > 0, "versión de {name}");
        }
    }

    #[test]
    fn file_names() {
        assert_eq!(file_name("recipe", 1, 3), "recipe-api1-v3.json");
        assert_eq!(file_name("youtubei", 2, 10), "youtubei-api2-v10.js");
    }

    #[test]
    fn rejects_bad_files() {
        let data = b"{}";
        let sha: String = Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(verify(b"{ }", &sha, "", "recipe-api1-v2.json").unwrap_err(), "el archivo no coincide con el publicado");
        assert!(verify(data, &sha, "bm8gZXMgdW5hIGZpcm1h", "recipe-api1-v2.json").is_err());
        assert!(!public_key().is_empty());
    }

    /// Con un canal publicado de verdad (`node scripts/extractors.mjs --to <carpeta>`): los baja,
    /// los guarda y los vuelve a cargar como al arrancar. `MUSIFY_TEST_CHANNEL=<carpeta o URL>`.
    #[tokio::test]
    #[ignore]
    async fn real_channel() {
        let source = std::env::var("MUSIFY_TEST_CHANNEL").unwrap();
        let dir = std::env::temp_dir().join(format!("musify-extractors-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        DIR.set(dir.clone()).unwrap();
        let manifest: Manifest = serde_json::from_slice(&fetch(&source, "extractores.json").await.unwrap()).unwrap();
        for e in &manifest.components {
            install(&source, e).await.unwrap();
        }
        assert!(status().iter().all(|s| s.downloaded));
        // Al arrancar, solo se usan los que son más nuevos que los incluidos.
        ACTIVE.write().unwrap().clear();
        for (name, _) in API {
            load(&dir, name).unwrap();
        }
        for s in status() {
            let published = manifest.components.iter().find(|e| e.name == s.name).unwrap().version;
            println!("{} publicado v{published}, en uso v{} ({})", s.name, s.version, if s.downloaded { "descargado" } else { "incluido" });
            assert_eq!(s.downloaded, published > BUNDLED[s.name]);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Con un archivo firmado de verdad: `MUSIFY_TEST_SIGNED=ruta/recipe-api1-v2.json` (con su `.sig` al lado).
    #[test]
    #[ignore]
    fn real_signature() {
        let path = PathBuf::from(std::env::var("MUSIFY_TEST_SIGNED").unwrap());
        let data = std::fs::read(&path).unwrap();
        let sig = std::fs::read_to_string(path.with_extension(format!("{}.sig", path.extension().unwrap().to_str().unwrap()))).unwrap();
        let sha: String = Sha256::digest(&data).iter().map(|b| format!("{b:02x}")).collect();
        let name = path.file_name().unwrap().to_str().unwrap();
        verify(&data, &sha, &sig, name).unwrap();
        assert_eq!(verify(&data, &sha, &sig, "recipe-api1-v99.json").unwrap_err(), "la firma es de otro archivo");
    }
}
