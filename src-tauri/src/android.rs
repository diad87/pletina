//! Android: el núcleo Rust al que llama el servicio de música (Kotlin, `MusifyCore`) por JNI, sin
//! pasar por la interfaz. Así la música sigue —y se preparan las canciones nuevas— con la pantalla
//! apagada y la interfaz congelada (ver docs/plan-mobile.md).
//!
//! Si la app está abierta, el núcleo usa su misma base de datos (`attach`). Si el servicio arranca
//! solo (p. ej. tras cerrar la app, al pulsar "play" en los auriculares), la abre él (`init`).

use crate::db::Db;
use crate::deezer::Deezer;
use crate::library::LibTrack;
use crate::player;
use crate::youtube::{TrackQuery, YouTubeMusic};
use crate::ytdlp::YtDlp;
use jni::JNIEnv;
use jni::objects::{JClass, JString};
use jni::sys::{jboolean, jstring};
use serde::Serialize;
use serde_json::{Value, json};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, Once, OnceLock};
use std::time::Instant;
use tauri::{AppHandle, Emitter};

/// Runtime propio: el servicio puede llamar sin que Tauri haya arrancado.
static RT: LazyLock<tokio::runtime::Runtime> = LazyLock::new(|| {
    tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("runtime")
});
static DEEZER: LazyLock<Deezer> = LazyLock::new(Deezer::new);
/// Registro de la prueba (el mismo que escribe Kotlin, ver Fase0Log.kt).
const LOG: &str = "/data/data/dev.musify.desktop/files/fase0.log";

struct Core {
    db: Db,
    ytm: YouTubeMusic,
    ytdlp: YtDlp,
}

static CORE: OnceLock<Core> = OnceLock::new();
static CORE_INIT: Mutex<()> = Mutex::new(());
/// Carpeta de datos de la app (la misma que usa Tauri), la da Kotlin con `init`.
static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();
/// La app, si está abierta: para avisar a la interfaz (`emit`).
static APP: OnceLock<AppHandle> = OnceLock::new();

/// Un fallo de Rust cierra la app sin decir nada (panic = abort): antes, se apunta en el registro.
pub fn install_panic_hook() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(LOG) {
                let _ = writeln!(f, "CIERRE en Rust: {info}");
            }
            previous(info);
        }));
    });
}

/// Tauri ha arrancado: el núcleo usa su misma base de datos.
pub fn attach(app: &AppHandle, db: &Db, dir: &Path) {
    let _ = APP.set(app.clone());
    let _guard = CORE_INIT.lock().unwrap();
    if CORE.get().is_none() {
        let _ = CORE.set(Core { db: db.clone(), ytm: YouTubeMusic::new(), ytdlp: YtDlp::new(dir.join("bin")) });
    }
}

/// El núcleo; si la app no lo ha preparado, se abre aquí la base de datos (servicio sin app).
fn core() -> Result<&'static Core, String> {
    if let Some(core) = CORE.get() {
        return Ok(core);
    }
    let _guard = CORE_INIT.lock().unwrap();
    if let Some(core) = CORE.get() {
        return Ok(core);
    }
    let dir = DATA_DIR.get().ok_or("el núcleo no tiene carpeta de datos")?;
    let db = Db::open(&dir.join("musify.db")).map_err(|e| e.to_string())?;
    crate::extractors::load_saved(&dir.join("extractors"));
    // Sin la app no se ha elegido motor: en el móvil siempre es el propio.
    let _ = crate::extractor::set_stream_engine("propio".into());
    let _ = CORE.set(Core { db, ytm: YouTubeMusic::new(), ytdlp: YtDlp::new(dir.join("bin")) });
    CORE.get().ok_or_else(|| "no se pudo preparar el núcleo".into())
}

fn to_java(env: &mut JNIEnv, text: String) -> jstring {
    env.new_string(text).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut())
}

fn from_java(env: &mut JNIEnv, s: &JString) -> String {
    env.get_string(s).map(String::from).unwrap_or_default()
}

/// `MusifyCore.init(dataDir)`: la carpeta de datos de la app (`context.dataDir`).
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_musify_desktop_MusifyCore_init<'l>(mut env: JNIEnv<'l>, _class: JClass<'l>, dir: JString<'l>) {
    install_panic_hook();
    let dir = from_java(&mut env, &dir);
    let _ = DATA_DIR.set(PathBuf::from(dir));
}

/// `MusifyCore.resolve(queryJson, refresh)`: `{"url", "local", "videoId", "ms"}` o `{"error"}`.
/// Lo de siempre (`player::resolve`): el archivo si es música local, el vídeo guardado o elegido a
/// mano, y si no, se busca y se guarda. Se llama desde un hilo de ExoPlayer (puede bloquear).
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_musify_desktop_MusifyCore_resolve<'l>(
    mut env: JNIEnv<'l>,
    _class: JClass<'l>,
    query: JString<'l>,
    refresh: jboolean,
) -> jstring {
    install_panic_hook();
    let query = from_java(&mut env, &query);
    let out = (|| {
        let q: TrackQuery = serde_json::from_str(&query).map_err(|e| format!("consulta no válida: {e}"))?;
        let core = core()?;
        let t = Instant::now();
        let p = RT.block_on(player::resolve(&q, refresh != 0, &core.db, &core.ytm, &core.ytdlp))?;
        Ok::<_, String>(json!({ "url": p.url, "local": p.local, "videoId": p.video_id, "ms": t.elapsed().as_millis() as u64 }))
    })();
    let out = out.unwrap_or_else(|e| json!({ "error": e }));
    to_java(&mut env, out.to_string())
}

/// `MusifyCore.recordPlay(libTrackJson)`: apunta una escucha en el historial y avisa a la interfaz.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_musify_desktop_MusifyCore_recordPlay<'l>(
    mut env: JNIEnv<'l>,
    _class: JClass<'l>,
    track: JString<'l>,
) -> jstring {
    install_panic_hook();
    let track = from_java(&mut env, &track);
    let out = (|| {
        let t: LibTrack = serde_json::from_str(&track).map_err(|e| format!("canción no válida: {e}"))?;
        crate::library::record(&core()?.db, &t)?;
        if let Some(app) = APP.get() {
            let _ = app.emit("history-changed", ());
        }
        Ok::<_, String>(())
    })();
    to_java(&mut env, out.err().unwrap_or_default())
}

/// `MusifyCore.emit(event, json)`: un aviso del servicio a la interfaz (si la app está abierta).
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_musify_desktop_MusifyCore_emit<'l>(
    mut env: JNIEnv<'l>,
    _class: JClass<'l>,
    event: JString<'l>,
    payload: JString<'l>,
) {
    let event = from_java(&mut env, &event);
    let payload = from_java(&mut env, &payload);
    if let Some(app) = APP.get() {
        let value: Value = serde_json::from_str(&payload).unwrap_or(Value::Null);
        let _ = app.emit(&event, value);
    }
}

// --- Prueba de la fase 0 (Fase0Activity): una lista de discos de Deezer ----------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Item {
    id: u64,
    title: String,
    artist: String,
    album: String,
    duration: u32,
    cover: Option<String>,
}

/// Canciones de los discos que se encuentren con cada búsqueda (una por línea), en orden.
async fn playlist(queries: &str) -> Result<Vec<Item>, String> {
    let mut items = vec![];
    for q in queries.lines().map(str::trim).filter(|q| !q.is_empty()) {
        let found = DEEZER.search(q).await?;
        let Some(first) = found.albums.first() else { continue };
        let album = DEEZER.album(first.id).await?;
        for t in album.tracks {
            items.push(Item {
                id: t.id,
                title: t.title,
                artist: t.artist.name,
                album: album.title.clone(),
                duration: t.duration,
                cover: album.cover_xl.clone().or(album.cover_big.clone()),
            });
        }
    }
    Ok(items)
}

/// `MusifyCore.playlist(queries)`: JSON con las canciones, o `{"error": ...}`.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_musify_desktop_MusifyCore_playlist<'l>(
    mut env: JNIEnv<'l>,
    _class: JClass<'l>,
    queries: JString<'l>,
) -> jstring {
    install_panic_hook();
    let queries = from_java(&mut env, &queries);
    let out = match RT.block_on(playlist(&queries)) {
        Ok(items) => serde_json::to_string(&items).unwrap_or_default(),
        Err(e) => json!({ "error": e }).to_string(),
    };
    to_java(&mut env, out)
}
