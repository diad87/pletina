//! Android, fase 0 (docs/plan-mobile.md): el servicio de música (Kotlin, `MusifyCore`) le pide al
//! núcleo por JNI la lista de canciones y la URL de cada una, sin pasar por la interfaz ni por
//! Tauri. Así se puede comprobar si el motor propio sigue preparando canciones nuevas con la
//! pantalla apagada y la interfaz congelada.
//!
//! Todo es de prueba y sin estado guardado: el vídeo elegido para cada canción se recuerda solo en
//! memoria. En la fase 1 esto pasa a ser el núcleo de verdad, con la base de datos.

use crate::deezer::Deezer;
use crate::native;
use crate::youtube::{self, MIN_SCORE, TrackQuery, YouTubeMusic};
use jni::JNIEnv;
use jni::objects::{JClass, JString};
use jni::sys::{jboolean, jstring};
use serde::Serialize;
use serde_json::json;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Instant;

/// Runtime propio: el servicio puede llamar sin que Tauri haya arrancado.
static RT: LazyLock<tokio::runtime::Runtime> = LazyLock::new(|| {
    tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("runtime")
});
static YTM: LazyLock<YouTubeMusic> = LazyLock::new(YouTubeMusic::new);
static DEEZER: LazyLock<Deezer> = LazyLock::new(Deezer::new);
/// Canción de Deezer → vídeo de YouTube que funcionó.
static CHOSEN: LazyLock<Mutex<HashMap<u64, String>>> = LazyLock::new(Default::default);
/// Candidatos que se prueban como mucho por canción.
const MAX_CANDIDATES: usize = 3;

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

/// URL del audio de una canción con el motor propio (nivel rápido): busca en YouTube Music,
/// elige el mejor vídeo y saca su URL comprobada.
async fn resolve(q: &TrackQuery, refresh: bool) -> Result<(String, String, u64), String> {
    let t = Instant::now();
    let chosen = CHOSEN.lock().unwrap().get(&q.id).cloned();
    let videos = match chosen {
        Some(v) => vec![v],
        None => {
            let found = YTM.search_songs(&q.search_text()).await?;
            let mut scored: Vec<_> = found.into_iter().take(10).enumerate().map(|(i, c)| (youtube::score(q, &c, i), c)).collect();
            scored.sort_by(|a, b| b.0.cmp(&a.0));
            scored.into_iter().filter(|(s, _)| *s >= MIN_SCORE).take(MAX_CANDIDATES).map(|(_, c)| c.video_id).collect()
        }
    };
    let mut last = "No se encontró la canción en YouTube Music".to_string();
    for video in videos {
        match native::resolve(&video, refresh).await {
            Ok(d) => {
                CHOSEN.lock().unwrap().insert(q.id, video.clone());
                return Ok((d.url, video, t.elapsed().as_millis() as u64));
            }
            Err(e) => last = e.to_string(),
        }
    }
    Err(last)
}

fn to_java(env: &mut JNIEnv, text: String) -> jstring {
    env.new_string(text).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut())
}

fn from_java(env: &mut JNIEnv, s: &JString) -> String {
    env.get_string(s).map(String::from).unwrap_or_default()
}

/// `MusifyCore.playlist(queries)`: JSON con las canciones, o `{"error": ...}`.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_musify_desktop_MusifyCore_playlist<'l>(
    mut env: JNIEnv<'l>,
    _class: JClass<'l>,
    queries: JString<'l>,
) -> jstring {
    let queries = from_java(&mut env, &queries);
    let out = match RT.block_on(playlist(&queries)) {
        Ok(items) => serde_json::to_string(&items).unwrap_or_default(),
        Err(e) => json!({ "error": e }).to_string(),
    };
    to_java(&mut env, out)
}

/// `MusifyCore.resolve(queryJson, refresh)`: `{"url", "videoId", "ms"}` o `{"error"}`. Se llama
/// desde un hilo de ExoPlayer (puede bloquear).
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_musify_desktop_MusifyCore_resolve<'l>(
    mut env: JNIEnv<'l>,
    _class: JClass<'l>,
    query: JString<'l>,
    refresh: jboolean,
) -> jstring {
    let query = from_java(&mut env, &query);
    let out = match serde_json::from_str::<TrackQuery>(&query) {
        Ok(q) => match RT.block_on(resolve(&q, refresh != 0)) {
            Ok((url, video, ms)) => json!({ "url": url, "videoId": video, "ms": ms }).to_string(),
            Err(e) => json!({ "error": e }).to_string(),
        },
        Err(e) => json!({ "error": format!("consulta no válida: {e}") }).to_string(),
    };
    to_java(&mut env, out)
}
