//! Banco local de captura: corpus de real_albums e informes parciales recuperables.
//! La preparación usa búsqueda para fijar IDs; las mediciones de captura no resuelven URLs.
use crate::deezer::Deezer;
use crate::youtube::{self, TrackQuery, YouTubeMusic};
use serde_json::{Value, json};

const QUERIES: [&str; 5] = [
    "radiohead ok computer",
    "berri txarrak infrasoinuak",
    "extremoduro agila",
    "rosalia el mal querer",
    "the beatles abbey road",
];

fn benchmark_only() -> Result<(), String> {
    if std::env::var_os("MUSIFY_BENCH").is_none() {
        return Err("El banco sólo está disponible en una ejecución de pruebas".into());
    }
    Ok(())
}

/// Descarta sólo el destino del próximo cambio, para que el banco mida una captura fría.
#[tauri::command]
pub async fn capture_bench_forget(app: tauri::AppHandle, video_id: String) -> Result<(), String> {
    benchmark_only()?;
    crate::capture::bench_forget(&app, &video_id).await
}

/// Quita asociaciones de esta base de datos aislada antes del cronómetro. La resolución
/// siguiente recorre la búsqueda real y el nivel rápido, sin reutilizar una URL preparada.
#[tauri::command]
pub fn capture_bench_native_search(
    app: tauri::AppHandle,
    track: TrackQuery,
    video_id: String,
    db: tauri::State<'_, crate::db::Db>,
) -> Result<(), String> {
    benchmark_only()?;
    if app.config().identifier != "dev.musify.captureofficialtest" {
        return Err("La búsqueda fría requiere la base de datos aislada del banco".into());
    }
    db.0.lock()
        .map_err(|_| "Base de datos del banco bloqueada")?
        .execute(
            "DELETE FROM sources WHERE track_id = ?1",
            rusqlite::params![track.id as i64],
        )
        .map_err(|_| "No se pudo reiniciar la asociación aislada")?;
    crate::native::bench_forget(&video_id)
}

/// Misma selección que player::tests::real_albums: primer disco, seis primeras canciones,
/// diez candidatos de YouTube Music ordenados con youtube::score y el mismo MIN_SCORE.
/// Los fallos conservan su fila: nunca se reemplaza una canción difícil por otra fácil.
#[tauri::command]
pub async fn capture_bench_catalog() -> Result<Value, String> {
    benchmark_only()?;
    let deezer = Deezer::new();
    let ytm = YouTubeMusic::new();
    let mut albums = Vec::new();
    for query in QUERIES {
        let found = match deezer.search(query).await {
            Ok(found) => found,
            Err(error) => {
                albums.push(json!({"query":query,"error":error,"expectedTracks":6}));
                continue;
            }
        };
        let Some(first) = found.albums.first() else {
            albums
                .push(json!({"query":query,"error":"No se encontró el disco","expectedTracks":6}));
            continue;
        };
        let album = match deezer.album(first.id).await {
            Ok(album) => album,
            Err(error) => {
                albums.push(
                    json!({"query":query,"albumId":first.id,"error":error,"expectedTracks":6}),
                );
                continue;
            }
        };
        let mut rows = Vec::new();
        for track in album.tracks.iter().take(6) {
            let q = TrackQuery {
                id: track.id,
                title: track.title.clone(),
                artist: track.artist.name.clone(),
                album: album.title.clone(),
                duration: track.duration,
            };
            let mut row = json!({
                "track":track,"albumId":album.id,"albumTitle":album.title,
                "artistId":album.artist.id,"cover":album.cover_big,
                "label":format!("{} — {}", q.artist, q.title),"duration":q.duration,
            });
            match ytm.search_songs(&q.search_text()).await {
                Ok(candidates) => {
                    let mut scored: Vec<_> = candidates
                        .into_iter()
                        .take(10)
                        .enumerate()
                        .map(|(i, c)| {
                            let score = youtube::score(&q, &c, i);
                            (c, score)
                        })
                        .collect();
                    scored.sort_by(|a, b| b.1.cmp(&a.1));
                    match scored.first() {
                        Some((c, score)) if *score >= youtube::MIN_SCORE => {
                            row["id"] = json!(c.video_id);
                            row["selection"] = json!({"title":c.title,"artists":c.artists,"duration":c.duration,"score":score});
                        }
                        other => {
                            row["error"] = json!(format!(
                                "Sin coincidencia suficiente: {:?}",
                                other.map(|(c, s)| (&c.title, s))
                            ))
                        }
                    }
                }
                Err(error) => row["error"] = json!(error),
            }
            rows.push(row);
        }
        albums.push(json!({"query":query,"albumId":album.id,"title":album.title,"artist":album.artist.name,"expectedTracks":6,"rows":rows}));
    }
    Ok(json!({"source":"player::tests::real_albums","expectedTracks":30,"albums":albums}))
}

/// No cierra la app: un ensayo largo deja evidencia incluso si falla una pista posterior.
#[tauri::command]
pub fn capture_bench_checkpoint(report: Value) -> Result<(), String> {
    benchmark_only()?;
    let plan = std::env::var("MUSIFY_BENCH").map_err(|e| e.to_string())?;
    let out =
        std::env::var("MUSIFY_BENCH_OUT").unwrap_or_else(|_| plan.replace(".json", ".result.json"));
    let bytes = serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?;
    std::fs::write(out, bytes).map_err(|e| e.to_string())
}
