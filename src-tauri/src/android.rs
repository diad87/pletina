//! Android: el núcleo Rust al que llama el servicio de música (Kotlin, `MusifyCore`) por JNI, sin
//! pasar por la interfaz. Así la música sigue —y se preparan las canciones nuevas— con la pantalla
//! apagada y la interfaz congelada (ver docs/plan-mobile.md).
//!
//! Si la app está abierta, el núcleo usa su misma base de datos (`attach`). Si el servicio arranca
//! solo (p. ej. tras cerrar la app, al pulsar "play" en los auriculares), la abre él (`init`).

use crate::db::Db;
use crate::library::LibTrack;
use crate::player;
use crate::youtube::{TrackQuery, YouTubeMusic};
use crate::ytdlp::YtDlp;
use jni::JNIEnv;
use jni::objects::{JClass, JString};
use jni::sys::{jboolean, jlong, jstring};
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
/// El registro de la app (el mismo que escribe Kotlin, ver MusifyLog.kt).
const LOG: &str = "/data/data/dev.musify.desktop/files/musify.log";

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

/// `MusifyCore.downloads()`: cómo van las descargas, `{"pending", "title", "progress"}`, para la
/// notificación de `DownloadService.kt`. Sin la app abierta no hay descargas.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_musify_desktop_MusifyCore_downloads<'l>(mut env: JNIEnv<'l>, _class: JClass<'l>) -> jstring {
    let out = APP.get().map(crate::downloads::status).unwrap_or_else(|| json!({ "pending": 0 }));
    to_java(&mut env, out.to_string())
}

/// `MusifyCore.isDownloaded(trackId)`: si la canción se puede escuchar sin conexión (descargada).
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_musify_desktop_MusifyCore_isDownloaded<'l>(_env: JNIEnv<'l>, _class: JClass<'l>, id: jlong) -> jboolean {
    let Ok(core) = core() else { return 0 };
    u8::from(core.db.download_path(id as u64).is_some_and(|p| Path::new(&p).exists()))
}

/// Catálogo navegable: solo SQLite, también cuando Android Auto inicia el servicio sin la app.
/// `browse(parentId)` y `search(query)` devuelven {items:[...]}; `mediaItem(id)`, {item:{...}}.
/// Los tres devuelven {error:"..."} si la petición no se puede completar.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_musify_desktop_MusifyCore_browse<'l>(
    mut env: JNIEnv<'l>, _class: JClass<'l>, parent_id: JString<'l>,
) -> jstring {
    let parent_id = from_java(&mut env, &parent_id);
    let result = core().and_then(|core| crate::media_library::browse(&core.db, &parent_id));
    let out = result.map(|items| json!({ "items": items })).unwrap_or_else(|error| json!({ "error": error }));
    to_java(&mut env, out.to_string())
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_musify_desktop_MusifyCore_mediaItem<'l>(
    mut env: JNIEnv<'l>, _class: JClass<'l>, media_id: JString<'l>,
) -> jstring {
    let media_id = from_java(&mut env, &media_id);
    let result = core().and_then(|core| crate::media_library::media_item(&core.db, &media_id));
    let out = result.map(|item| json!({ "item": item })).unwrap_or_else(|error| json!({ "error": error }));
    to_java(&mut env, out.to_string())
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_musify_desktop_MusifyCore_search<'l>(
    mut env: JNIEnv<'l>, _class: JClass<'l>, query: JString<'l>,
) -> jstring {
    let query = from_java(&mut env, &query);
    let result = core().and_then(|core| crate::media_library::search(&core.db, &query));
    let out = result.map(|items| json!({ "items": items })).unwrap_or_else(|error| json!({ "error": error }));
    to_java(&mut env, out.to_string())
}
