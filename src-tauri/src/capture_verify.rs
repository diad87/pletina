//! Oráculo local de pruebas: no participa en la reproducción ni confía en las etiquetas
//! content/ad. Compara TODOS los paquetes publicados con una descarga nativa sin cookies.
use base64::Engine;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

const MAX_REFERENCE: usize = 128 * 1024 * 1024;
const PACKET_CLOCK_EPSILON: f64 = 0.001001;

#[derive(Clone, Debug)]
struct Packet {
    pts: f64,
    duration: f64,
    hash: String,
    size: usize,
}
#[derive(Clone)]
struct Reference {
    itag: u64,
    mime: String,
    hash: String,
    packets: Vec<Packet>,
    path: PathBuf,
}
#[derive(Default)]
struct Audit {
    unit_hashes: HashMap<String, String>,
    matched_packets: HashSet<String>,
    compared_packets: HashSet<String>,
    mismatches: BTreeMap<String, Value>,
    reference_hashes: HashSet<String>,
    pcm_checks: BTreeMap<String, Value>,
}
#[derive(Default)]
struct Store {
    references: HashMap<String, Reference>,
    audits: HashMap<String, Audit>,
    serial: u64,
}
static STORE: LazyLock<tokio::sync::Mutex<Store>> =
    LazyLock::new(|| tokio::sync::Mutex::new(Store::default()));

fn benchmark_only() -> Result<(), String> {
    if std::env::var_os("MUSIFY_BENCH").is_none() {
        return Err("El oráculo sólo está disponible en pruebas".into());
    }
    Ok(())
}
fn valid_id(id: &str) -> bool {
    id.len() == 11
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
}
fn family(mime: &str) -> String {
    mime.split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn reference_key(id: &str, mime: Option<&str>, itag: Option<u64>) -> String {
    format!(
        "{id}:{}:{}",
        mime.map(family).unwrap_or_default(),
        itag.unwrap_or(0)
    )
}
fn directory() -> Result<PathBuf, String> {
    let dir = std::env::temp_dir()
        .join("musify-capture-oracle.local")
        .join(std::process::id().to_string());
    std::fs::create_dir_all(&dir)
        .map_err(|_| "No se pudo crear el directorio local del oráculo")?;
    Ok(dir)
}

#[derive(Deserialize)]
struct Probe {
    #[serde(default)]
    packets: Vec<ProbePacket>,
}
#[derive(Deserialize)]
struct ProbePacket {
    pts_time: Option<String>,
    duration_time: Option<String>,
    size: Option<String>,
    data_hash: Option<String>,
}
async fn packets(path: &Path) -> Result<Vec<Packet>, String> {
    let mut command = tokio::process::Command::new("ffprobe");
    command
        .args([
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_packets",
            "-show_entries",
            "packet=pts_time,duration_time,size,data_hash",
            "-show_data_hash",
            "sha256",
            "-of",
            "json",
        ])
        .arg(path)
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.as_std_mut().creation_flags(0x08000000);
    }
    let output = tokio::time::timeout(Duration::from_secs(30), command.output())
        .await
        .map_err(|_| "ffprobe agotó el plazo")?
        .map_err(|_| "ffprobe no está disponible")?;
    if !output.status.success() {
        return Err("ffprobe no pudo leer el audio capturado".into());
    }
    let probe: Probe = serde_json::from_slice(&output.stdout)
        .map_err(|_| "ffprobe no devolvió un inventario válido")?;
    let result: Vec<_> = probe
        .packets
        .into_iter()
        .map(|p| {
            let pts: f64 = p
                .pts_time
                .as_deref()
                .ok_or("Paquete sin reloj")?
                .parse()
                .map_err(|_| "Reloj inválido")?;
            let duration: f64 = p
                .duration_time
                .as_deref()
                .ok_or("Paquete sin duración")?
                .parse()
                .map_err(|_| "Duración inválida")?;
            let size = p
                .size
                .as_deref()
                .ok_or("Paquete sin tamaño")?
                .parse()
                .map_err(|_| "Tamaño inválido")?;
            let hash = p.data_hash.ok_or("Paquete sin hash")?;
            if !pts.is_finite()
                || !duration.is_finite()
                || duration <= 0.0
                || !hash.starts_with("SHA256:")
                || hash.len() != 71
            {
                return Err("Paquete inválido");
            }
            Ok(Packet {
                pts,
                duration,
                size,
                hash,
            })
        })
        .collect::<Result<_, &str>>()
        .map_err(String::from)?;
    if result.is_empty() {
        return Err("Inventario de audio vacío".into());
    }
    Ok(result)
}

async fn prepare(
    store: &mut Store,
    id: &str,
    mime: Option<&str>,
    itag: Option<u64>,
) -> Result<Reference, String> {
    let key = reference_key(id, mime, itag);
    if let Some(reference) = store.references.get(&key) {
        return Ok(reference.clone());
    }
    if let Some((_, reference)) = store.references.iter().find(|(key, r)| {
        key.starts_with(&format!("{id}:"))
            && mime.is_none_or(|m| family(m) == family(&r.mime))
            && itag.is_none_or(|tag| tag == r.itag)
    }) {
        return Ok(reference.clone());
    }
    let direct = crate::native::reference(id, mime, itag)
        .await
        .map_err(|_| "El nivel rápido no pudo obtener una referencia compatible sin sesión")?;
    let expected_length = crate::ytdlp::query_param(&direct.url, "clen")
        .and_then(|n| n.parse::<usize>().ok())
        .filter(|n| *n > 0 && *n <= MAX_REFERENCE)
        .ok_or("Referencia sin tamaño completo verificable")?;
    // Cliente sin cookie store, cabecera Cookie ni perfil de WebView2.
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|_| "Cliente del oráculo no disponible")?;
    let mut response = http
        .get(&direct.url)
        .send()
        .await
        .map_err(|_| "No se pudo descargar la referencia")?;
    if !response.status().is_success() {
        return Err(format!(
            "Descarga de referencia: HTTP {}",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_REFERENCE as u64)
    {
        return Err("Referencia supera el límite local de128MiB".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Referencia interrumpida")?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_REFERENCE {
            return Err("Referencia supera el límite local de128MiB".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.len() != expected_length {
        return Err("La referencia no contiene todos los bytes declarados por YouTube".into());
    }
    let hash = digest(&bytes);
    let path = directory()?.join(format!("{id}-{}.audio", direct.itag));
    std::fs::write(&path, &bytes).map_err(|_| "No se pudo guardar la referencia local")?;
    let reference = Reference {
        itag: direct.itag,
        mime: direct.mime,
        hash,
        packets: packets(&path).await?,
        path,
    };
    store.references.insert(key, reference.clone());
    Ok(reference)
}

#[tauri::command]
pub async fn capture_verify_prepare(
    video_id: String,
    mime: Option<String>,
    itag: Option<u64>,
) -> Result<Value, String> {
    benchmark_only()?;
    if !valid_id(&video_id) {
        return Err("ID de vídeo inválido".into());
    }
    let mut store = STORE.lock().await;
    let reference = prepare(&mut store, &video_id, mime.as_deref(), itag).await?;
    Ok(
        json!({"ok":true,"videoId":video_id,"itag":reference.itag,"mime":reference.mime,"packets":reference.packets.len(),"referenceHash":reference.hash,"anonymousTransport":true,"method":"exact-encoded-packets"}),
    )
}

#[cfg(test)]
fn compare(
    captured: &[Packet],
    reference: &[Packet],
    timestamp_offset: f64,
) -> Vec<(usize, Option<usize>, String)> {
    compare_with_origin(captured, reference, Some(timestamp_offset))
}
fn compare_with_origin(
    captured: &[Packet],
    reference: &[Packet],
    offset: Option<f64>,
) -> Vec<(usize, Option<usize>, String)> {
    let Some(offset) = offset else {
        return captured
            .iter()
            .enumerate()
            .map(|(i, _)| (i, None, "identity-or-origin-mismatch".into()))
            .collect();
    };
    let mut previous = None;
    captured
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let at = p.pts + offset;
            let near = reference.partition_point(|r| r.pts < at - PACKET_CLOCK_EPSILON);
            let matching = reference
                .iter()
                .enumerate()
                .skip(near)
                .take_while(|(_, r)| r.pts <= at + PACKET_CLOCK_EPSILON)
                .find(|(index, r)| {
                    previous.is_none_or(|before| *index > before)
                        && r.hash == p.hash
                        && r.size == p.size
                        && (r.duration - p.duration).abs() <= PACKET_CLOCK_EPSILON
                })
                .map(|(index, _)| index);
            if let Some(index) = matching {
                previous = Some(index);
            }
            (
                i,
                matching,
                if matching.is_some() {
                    String::new()
                } else {
                    "packet-bytes-or-clock-mismatch".into()
                },
            )
        })
        .collect()
}

fn binding(u: &Value) -> Option<String> {
    let names = [
        "generation",
        "epoch",
        "source",
        "s",
        "initKey",
        "mime",
        "timelineSettings",
    ];
    if names.iter().any(|name| u.get(name).is_none()) {
        return None;
    }
    Some(
        names
            .iter()
            .map(|name| u[*name].to_string())
            .collect::<Vec<_>>()
            .join("/"),
    )
}
fn unit_key(u: &Value) -> Option<String> {
    Some(format!("{}/{}", binding(u)?, u["unit"].as_u64()?))
}

/// Cada llamada vuelve a comprobar todos los bytes del snapshot; el ledger conserva resultados
/// de generaciones anteriores incluso tras un salto, recuperación o expulsión de la caché.
#[tauri::command]
pub async fn capture_verify_check(video_id: String, r#final: bool) -> Result<Value, String> {
    benchmark_only()?;
    if !valid_id(&video_id) {
        return Err("ID de vídeo inválido".into());
    }
    let snapshot = crate::capture::bench_snapshot(&video_id)?;
    let units = snapshot["units"]
        .as_array()
        .ok_or("Snapshot sin inventario de unidades")?;
    let mut groups: BTreeMap<String, Vec<&Value>> = BTreeMap::new();
    for u in units {
        groups
            .entry(binding(u).ok_or("Unidad sin binding")?)
            .or_default()
            .push(u);
    }
    let mut store = STORE.lock().await;
    for (group_key, mut units) in groups {
        units.sort_by_key(|u| u["unit"].as_u64().unwrap_or(0));
        let reference = prepare(&mut store, &video_id, units[0]["mime"].as_str(), None).await?;
        let mut bytes = Vec::new();
        let mut error = None;
        for (index, u) in units.iter().enumerate() {
            let data = base64::engine::general_purpose::STANDARD
                .decode(u["data"].as_str().ok_or("Unidad sin bytes")?)
                .map_err(|_| "Bytes inválidos")?;
            let init_bytes = u["initBytes"].as_u64().ok_or("Unidad sin initBytes")? as usize;
            if init_bytes == 0 || init_bytes >= data.len() {
                return Err("Inicialización inválida".into());
            }
            let key = unit_key(u).ok_or("Unidad sin identidad")?;
            let hash = digest(&data);
            let audit = store.audits.entry(video_id.clone()).or_default();
            if let Some(previous) = audit.unit_hashes.insert(key.clone(), hash.clone()) {
                if previous != hash {
                    error = Some("published-unit-mutated");
                    audit.mismatches.insert(
                        key.clone(),
                        json!({"reason":"published-unit-mutated","unit":key}),
                    );
                }
            }
            bytes.extend_from_slice(if index == 0 {
                &data
            } else {
                &data[init_bytes..]
            });
        }
        store.serial += 1;
        let path = directory()?.join(format!("{video_id}-capture-{}.audio", store.serial));
        std::fs::write(&path, &bytes).map_err(|_| "No se pudo guardar el snapshot local")?;
        let captured = packets(&path).await;
        let audit = store.audits.entry(video_id.clone()).or_default();
        audit.reference_hashes.insert(reference.hash.clone());
        match captured {
            Ok(captured) => {
                let declared_frames: u64 = units.iter().filter_map(|u| u["frames"].as_u64()).sum();
                if captured.len() != declared_frames as usize {
                    audit.mismatches.entry(format!("{group_key}/missing-packets")).or_insert(json!({"group":group_key,"reason":"published-frames-missing-from-container","declared":declared_frames,"actual":captured.len()}));
                }
                let offset = units[0]["timelineSettings"]["timestampOffset"]
                    .as_f64()
                    .ok_or("Offset ausente")?;
                // Metadato MSE fijado antes de observar los bytes: nunca buscar un hash
                // posterior para desplazar la canción y ocultar un comienzo omitido.
                let comparison = compare_with_origin(&captured, &reference.packets, Some(offset));
                let mut pcm_verified = false;
                if captured.len() == declared_frames as usize
                    && comparison.iter().any(|(_, matched, _)| matched.is_none())
                    && error.is_none()
                {
                    match crate::capture_pcm::compare_exact(
                        &path,
                        &reference.path,
                        crate::capture_pcm::FixedOffset::ZERO,
                        declared_frames,
                    )
                    .await
                    {
                        Ok(proof) => {
                            pcm_verified = true;
                            audit
                                .pcm_checks
                                .insert(group_key.clone(), json!({"ok":true,"proof":proof}));
                        }
                        Err(failure) => {
                            audit.pcm_checks.insert(
                                group_key.clone(),
                                json!({"ok":false,"diagnostic":failure}),
                            );
                        }
                    }
                }
                for (index, matched, reason) in comparison {
                    let key = format!("{group_key}/packet/{index}");
                    audit.compared_packets.insert(key.clone());
                    if (matched.is_some() || pcm_verified) && error.is_none() {
                        audit.matched_packets.insert(key);
                    } else {
                        audit.mismatches.entry(key).or_insert_with(|| json!({"group":group_key,"packet":index,"pts":captured[index].pts,"reason":reason,"referenceItag":reference.itag}));
                    }
                }
            }
            Err(reason) => {
                audit
                    .mismatches
                    .entry(format!("{group_key}/probe-error"))
                    .or_insert(json!({"group":group_key,"reason":reason}));
            }
        }
        // La evidencia permanente son referencias+hashes/diagnóstico; no miles de copias del audio.
        let _ = std::fs::remove_file(&path);
    }
    let audit = store.audits.entry(video_id.clone()).or_default();
    let pending = audit.compared_packets.is_empty();
    let capture_anonymous = !units.is_empty() && units.iter().all(|u| unit_is_anonymous(u));
    let ok = !pending
        && audit.mismatches.is_empty()
        && audit.matched_packets.len() == audit.compared_packets.len();
    let complete = r#final
        && ok
        && snapshot["complete"] == true
        && snapshot["allPublishedUnits"] == true
        && !units.is_empty();
    Ok(
        json!({"ok":ok,"pending":pending,"videoId":video_id,"method":"exact-encoded-packets-or-pcm","referenceHash":audit.reference_hashes.iter().next(),"referenceHashes":audit.reference_hashes,"comparedPackets":audit.compared_packets.len(),"matchedPackets":audit.matched_packets.len(),"unitsChecked":audit.unit_hashes.len(),"unitsCheckedSnapshot":snapshot["currentUnits"].as_u64().unwrap_or(units.len() as u64),"mismatchCount":audit.mismatches.len(),"mismatches":audit.mismatches.values().take(100).collect::<Vec<_>>(),"pcmChecks":audit.pcm_checks,"complete":complete,"anonymous":true,"captureAnonymous":capture_anonymous,"sessionState":snapshot["sessionState"],"coverage":snapshot["ranges"],"eofEnd":snapshot["eofEnd"],"allPublishedUnits":snapshot["allPublishedUnits"] == true}),
    )
}

fn unit_is_anonymous(unit: &Value) -> bool {
    let state = &unit["sessionState"];
    state["state"] == "signed-out"
        && state["evidenceVersion"] == 1
        && state["observedAt"].as_u64().is_some()
        && state["profileId"].as_str().is_some_and(|id| !id.is_empty())
        && state["generation"] == unit["generation"]
        && state["epoch"] == unit["epoch"]
}

#[cfg(test)]
mod tests {
    use super::*;
    fn packet(pts: f64, hash: &str) -> Packet {
        Packet {
            pts,
            duration: 0.02,
            hash: hash.into(),
            size: 3,
        }
    }
    #[test]
    fn compares_exact_bytes_at_the_same_time_with_a_fixed_codec_origin() {
        let reference = vec![packet(-0.007, "A"), packet(0.013, "B"), packet(0.033, "C")];
        let captured = vec![packet(0.0, "A"), packet(0.02, "B"), packet(0.04, "C")];
        assert!(
            compare(&captured, &reference, -0.007)
                .iter()
                .all(|(_, m, _)| m.is_some())
        );
        let mut contaminated = captured.clone();
        contaminated[1].hash = "ADVERTISEMENT".into();
        assert_eq!(
            compare(&contaminated, &reference, -0.007)
                .iter()
                .filter(|(_, m, _)| m.is_none())
                .count(),
            1
        );
    }
    #[test]
    fn later_identical_audio_cannot_hide_the_wrong_timeline() {
        let reference = vec![packet(0.0, "A"), packet(1.0, "B")];
        assert!(compare(&[packet(1.0, "A")], &reference, 0.0)[0].1.is_none());
        assert!(
            compare(&[packet(0.0, "A"), packet(0.02, "B")], &reference, 0.0)[1]
                .1
                .is_none()
        );
    }
    #[test]
    fn codec_quantization_is_not_a_missing_or_different_packet() {
        let reference = vec![packet(0.0, "A"), packet(0.021, "B")];
        assert!(
            compare(&[packet(0.0, "A"), packet(0.020, "B")], &reference, 0.0)
                .iter()
                .all(|(_, m, _)| m.is_some())
        );
        assert!(
            compare(&[packet(0.0, "A"), packet(0.018, "B")], &reference, 0.0)[1]
                .1
                .is_none()
        );
    }
    #[test]
    fn duplicate_packets_cannot_be_matched_to_the_same_reference_twice() {
        let reference = vec![packet(0.0, "A"), packet(0.02, "B")];
        let checked = compare(
            &[packet(0.0, "A"), packet(0.0, "A"), packet(0.02, "B")],
            &reference,
            0.0,
        );
        assert!(checked[0].1.is_some());
        assert!(checked[1].1.is_none());
        assert!(checked[2].1.is_some());
    }
    #[test]
    fn hashes_cannot_shift_an_omitted_eighty_millisecond_beginning() {
        let reference = vec![packet(0.0, "A"), packet(0.08, "B"), packet(0.10, "C")];
        let captured = vec![packet(0.0, "B"), packet(0.02, "C")];
        assert!(
            compare(&captured, &reference, 0.0)
                .iter()
                .all(|(_, matched, _)| matched.is_none())
        );
    }
    #[test]
    fn every_historical_unit_needs_its_own_signed_out_proof() {
        let clean = json!({"generation":1,"epoch":2,"sessionState":{"generation":1,"epoch":2,"state":"signed-out","profileId":"anonymous-test","evidenceVersion":1,"observedAt":3}});
        assert!(unit_is_anonymous(&clean));
        for state in ["unknown", "signed-in"] {
            let mut dirty = clean.clone();
            dirty["sessionState"]["state"] = json!(state);
            assert!(!unit_is_anonymous(&dirty));
        }
        let mut stale = clean;
        stale["generation"] = json!(4);
        assert!(!unit_is_anonymous(&stale));
    }
}
