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
    position: Option<u64>,
}
#[derive(Clone, Debug)]
struct ReferencePresentation {
    // Independently decoded reference frames, mapped by demuxer packet position.
    // A whole priming/discard packet with no decoded output is not presentable.
    frame_packets: Vec<usize>,
    frame_ranges: Vec<(f64, f64)>,
    required_packets: HashSet<usize>,
}
#[derive(Clone)]
struct Reference {
    itag: u64,
    mime: String,
    hash: String,
    packets: Vec<Packet>,
    path: PathBuf,
    presentation: ReferencePresentation,
}
#[derive(Default)]
struct ReferenceCoverage {
    required: HashSet<usize>,
    covered: HashSet<usize>,
    error: Option<String>,
    covered_frames: HashSet<usize>,
    frame_windows: HashMap<usize, Vec<(f64, f64)>>,
}
impl ReferenceCoverage {
    fn complete(&self) -> bool {
        self.error.is_none() && !self.required.is_empty() && self.required.is_subset(&self.covered)
    }
}
#[derive(Default)]
struct Audit {
    unit_hashes: HashMap<String, String>,
    matched_packets: HashSet<String>,
    compared_packets: HashSet<String>,
    mismatches: BTreeMap<String, Value>,
    reference_hashes: HashSet<String>,
    pcm_checks: BTreeMap<String, Value>,
    reference_coverage: BTreeMap<String, ReferenceCoverage>,
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
    pos: Option<String>,
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
            "packet=pts_time,duration_time,size,data_hash,pos",
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
                position: p.pos.as_deref().and_then(|value| value.parse().ok()),
            })
        })
        .collect::<Result<_, &str>>()
        .map_err(String::from)?;
    if result.is_empty() {
        return Err("Inventario de audio vacío".into());
    }
    Ok(result)
}

#[derive(Deserialize)]
struct PresentationProbe {
    #[serde(default)]
    frames: Vec<PresentationFrame>,
    #[serde(default)]
    streams: Vec<PresentationStream>,
}
#[derive(Deserialize)]
struct PresentationStream {
    time_base: String,
    sample_rate: String,
}
#[derive(Deserialize)]
struct PresentationFrame {
    pkt_pos: Option<String>,
    nb_samples: Option<u64>,
    pts: Option<i64>,
}
fn map_reference_frames(
    packets: &[Packet],
    frames: &[PresentationFrame],
    time_base: (u64, u64),
    sample_rate: u64,
) -> Result<ReferencePresentation, String> {
    if time_base.0 == 0 || time_base.1 == 0 || sample_rate == 0 {
        return Err("Reference has no exact decoded sample clock".into());
    }
    let mut by_position = HashMap::new();
    for (index, packet) in packets.iter().enumerate() {
        let position = packet
            .position
            .ok_or("Reference packet has no demuxer position")?;
        if by_position.insert(position, index).is_some() {
            return Err("Reference packet positions are ambiguous".into());
        }
    }
    let mut frame_packets = Vec::with_capacity(frames.len());
    let mut frame_ranges = Vec::with_capacity(frames.len());
    for frame in frames {
        if frame.nb_samples.is_none_or(|samples| samples == 0) {
            return Err("Reference frame has no exact decoded sample inventory".into());
        }
        let position = frame
            .pkt_pos
            .as_deref()
            .and_then(|position| position.parse::<u64>().ok())
            .ok_or("Reference frame has no demuxer position")?;
        let index = *by_position
            .get(&position)
            .ok_or("Decoded reference frame is not tied to its packet inventory")?;
        if frame_packets
            .last()
            .is_some_and(|previous| *previous > index)
        {
            return Err("Decoded reference packet order is not monotonic".into());
        }
        let pts = frame
            .pts
            .ok_or("Reference frame has no exact presentation timestamp")?;
        let start = pts as f64 * time_base.0 as f64 / time_base.1 as f64;
        let end = start + frame.nb_samples.unwrap() as f64 / sample_rate as f64;
        if !start.is_finite() || !end.is_finite() || end <= start {
            return Err("Reference frame has invalid decoded sample extent".into());
        }
        frame_packets.push(index);
        frame_ranges.push((start, end));
    }
    if frame_packets.is_empty() {
        return Err("Reference has no presentable decoded frames".into());
    }
    let required_packets = frame_packets.iter().copied().collect();
    Ok(ReferencePresentation {
        frame_packets,
        frame_ranges,
        required_packets,
    })
}
async fn reference_presentation(
    path: &Path,
    packets: &[Packet],
) -> Result<ReferencePresentation, String> {
    // FFmpeg applies codec/container skip and discard metadata while decoding.
    // https://ffmpeg.org/doxygen/6.1/group__lavc__packet__side__data.html
    // This is independent of capture EOF, advertised duration and emitted-unit labels.
    let mut command = tokio::process::Command::new("ffprobe");
    command
        .args([
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_frames",
            "-show_streams",
            "-show_entries",
            "frame=pkt_pos,pts,nb_samples:stream=time_base,sample_rate",
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
        .map_err(|_| "Reference presentation probe timed out")?
        .map_err(|_| "Reference presentation probe is unavailable")?;
    if !output.status.success() || !output.stderr.is_empty() {
        return Err("Reference decoding did not produce a clean complete inventory".into());
    }
    let probe: PresentationProbe = serde_json::from_slice(&output.stdout)
        .map_err(|_| "Reference presentation inventory is invalid")?;
    let stream = probe
        .streams
        .first()
        .filter(|_| probe.streams.len() == 1)
        .ok_or("Reference has no unique decoded audio clock")?;
    let (numerator, denominator) = stream
        .time_base
        .split_once('/')
        .ok_or("Reference time base is invalid")?;
    let time_base = (
        numerator
            .parse()
            .map_err(|_| "Reference time base is invalid")?,
        denominator
            .parse()
            .map_err(|_| "Reference time base is invalid")?,
    );
    let sample_rate = stream
        .sample_rate
        .parse()
        .map_err(|_| "Reference sample rate is invalid")?;
    map_reference_frames(packets, &probe.frames, time_base, sample_rate)
}

fn metadata_offset(value: &Value) -> Option<crate::capture_pcm::FixedOffset> {
    // Preserve the explicitly supplied decimal metadata value as a rational. Never
    // derive a shift from payload similarity or silently substitute zero.
    let value = value.as_number()?.to_string();
    let (mantissa, exponent) = value
        .split_once(['e', 'E'])
        .map_or((value.as_str(), 0), |(m, e)| {
            (m, e.parse::<i32>().unwrap_or(i32::MAX))
        });
    let negative = mantissa.starts_with('-');
    let mantissa = mantissa.trim_start_matches('-');
    let fractional = mantissa
        .split_once('.')
        .map_or(0, |(_, fraction)| fraction.len() as i32);
    let digits = mantissa.replace('.', "");
    let mut numerator = digits.parse::<u128>().ok()?;
    if numerator == 0 {
        return Some(crate::capture_pcm::FixedOffset::ZERO);
    }
    let power = exponent.checked_sub(fractional)?;
    let mut denominator = 1u128;
    if power >= 0 {
        numerator = numerator.checked_mul(10u128.checked_pow(power.try_into().ok()?)?)?;
    } else {
        denominator = 10u128.checked_pow(power.checked_neg()?.try_into().ok()?)?;
    }
    let (mut a, mut b) = (numerator, denominator);
    while b != 0 {
        (a, b) = (b, a % b);
    }
    numerator /= a;
    denominator /= a;
    let numerator = i64::try_from(numerator).ok()?;
    Some(crate::capture_pcm::FixedOffset {
        numerator: if negative { -numerator } else { numerator },
        denominator: u64::try_from(denominator).ok()?,
    })
}

fn append_window(settings: &Value) -> Result<(f64, f64), String> {
    let start = settings["appendWindowStart"]
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0)
        .ok_or("Published append window has no valid start")?;
    let end = if settings["appendWindowEnd"].is_null() {
        f64::INFINITY
    } else {
        settings["appendWindowEnd"]
            .as_f64()
            .filter(|n| n.is_finite())
            .ok_or("Published append window has no valid end")?
    };
    if end <= start {
        return Err("Published append window is empty".into());
    }
    Ok((start, end))
}

fn add_frame_coverage(
    coverage: &mut ReferenceCoverage,
    presentation: &ReferencePresentation,
    indices: impl IntoIterator<Item = usize>,
    window: (f64, f64),
) {
    for index in indices {
        if coverage.covered_frames.contains(&index) {
            continue;
        }
        let (start, end) = presentation.frame_ranges[index];
        let part = (start.max(window.0), end.min(window.1));
        if part.1 <= part.0 {
            continue;
        }
        let windows = coverage.frame_windows.entry(index).or_default();
        windows.push(part);
        windows.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut through = start;
        for &(from, to) in windows.iter() {
            if from > through {
                break;
            }
            through = through.max(to);
        }
        if through >= end {
            coverage.covered_frames.insert(index);
        }
        let packet = presentation.frame_packets[index];
        let first = presentation.frame_packets.partition_point(|p| *p < packet);
        if presentation.frame_packets[first..]
            .iter()
            .take_while(|p| **p == packet)
            .enumerate()
            .all(|(i, _)| coverage.covered_frames.contains(&(first + i)))
        {
            coverage.covered.insert(packet);
        }
    }
}
fn add_encoded_coverage(
    coverage: &mut ReferenceCoverage,
    presentation: &ReferencePresentation,
    packet: usize,
    window: (f64, f64),
) {
    let first = presentation.frame_packets.partition_point(|p| *p < packet);
    let count = presentation.frame_packets[first..]
        .iter()
        .take_while(|p| **p == packet)
        .count();
    let indices = first..first + count;
    add_frame_coverage(coverage, presentation, indices, window);
}
fn add_pcm_coverage(
    coverage: &mut ReferenceCoverage,
    presentation: &ReferencePresentation,
    first_frame: usize,
    frames: u64,
    window: (f64, f64),
) -> Result<(), String> {
    let count = usize::try_from(frames).map_err(|_| "PCM reference interval is too large")?;
    let end = first_frame
        .checked_add(count)
        .ok_or("PCM reference interval overflows")?;
    presentation
        .frame_packets
        .get(first_frame..end)
        .ok_or("PCM proof is outside the independent reference frame inventory")?;
    add_frame_coverage(coverage, presentation, first_frame..end, window);
    Ok(())
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
        .no_gzip()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Cliente del oráculo no disponible")?;
    let bytes = crate::capture_reference::download(&http, &direct.url, expected_length).await?;
    let hash = digest(&bytes);
    let path = directory()?.join(format!("{id}-{}.audio", direct.itag));
    std::fs::write(&path, &bytes).map_err(|_| "No se pudo guardar la referencia local")?;
    let packets = packets(&path).await?;
    let presentation = reference_presentation(&path, &packets).await?;
    let reference = Reference {
        itag: direct.itag,
        mime: direct.mime,
        hash,
        packets,
        path,
        presentation,
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
        audit
            .reference_coverage
            .entry(reference.hash.clone())
            .or_insert_with(|| ReferenceCoverage {
                required: reference.presentation.required_packets.clone(),
                ..Default::default()
            });
        let window = append_window(&units[0]["timelineSettings"])?;
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
                    let alignment =
                        metadata_offset(&units[0]["timelineSettings"]["timestampOffset"]);
                    let pcm = match alignment {
                        Some(alignment) => crate::capture_pcm::compare_exact(
                            &path,
                            &reference.path,
                            alignment,
                            declared_frames,
                        )
                        .await
                        .map_err(|failure| json!(failure)),
                        None => Err(
                            json!({"code":"PCM_UNVERIFIABLE","message":"MSE timestampOffset has no exact representable rational; zero is not substituted"}),
                        ),
                    };
                    match pcm {
                        Ok(proof) => {
                            pcm_verified = true;
                            let coverage =
                                audit.reference_coverage.get_mut(&reference.hash).unwrap();
                            if let Err(error) = add_pcm_coverage(
                                coverage,
                                &reference.presentation,
                                proof.reference_first_frame,
                                proof.decoded_frames,
                                window,
                            ) {
                                coverage.error = Some(error);
                            }
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
                        if let Some(reference_index) = matched {
                            if captured.len() == declared_frames as usize {
                                add_encoded_coverage(
                                    audit.reference_coverage.get_mut(&reference.hash).unwrap(),
                                    &reference.presentation,
                                    reference_index,
                                    window,
                                );
                            }
                        }
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
    let reference_complete = audit
        .reference_coverage
        .values()
        .any(ReferenceCoverage::complete);
    let reference_coverage: Vec<Value> = audit.reference_coverage.iter().map(|(hash,coverage)| {
        let mut missing: Vec<_> = coverage.required.difference(&coverage.covered).copied().collect();
        missing.sort_unstable();
        json!({"referenceHash":hash,"requiredPresentablePackets":coverage.required.len(),"coveredPresentablePackets":coverage.required.intersection(&coverage.covered).count(),
            "missingPresentablePackets":missing.len(),"missingPacketIndices":missing.iter().take(100).collect::<Vec<_>>(),"complete":coverage.complete(),"error":coverage.error})
    }).collect();
    let complete = r#final
        && ok
        && reference_complete
        && snapshot["complete"] == true
        && snapshot["allPublishedUnits"] == true
        && !units.is_empty();
    Ok(
        json!({"ok":ok,"pending":pending,"videoId":video_id,"method":"exact-encoded-packets-or-pcm","referenceHash":audit.reference_hashes.iter().next(),"referenceHashes":audit.reference_hashes,"comparedPackets":audit.compared_packets.len(),"matchedPackets":audit.matched_packets.len(),"unitsChecked":audit.unit_hashes.len(),"unitsCheckedSnapshot":snapshot["currentUnits"].as_u64().unwrap_or(units.len() as u64),"mismatchCount":audit.mismatches.len(),"mismatches":audit.mismatches.values().take(100).collect::<Vec<_>>(),"pcmChecks":audit.pcm_checks,"complete":complete,"referenceComplete":reference_complete,"referenceCoverage":reference_coverage,"completionReason":if !reference_complete {Some("reference-presentation-incomplete")} else {None},"anonymous":true,"captureAnonymous":capture_anonymous,"sessionState":snapshot["sessionState"],"coverage":snapshot["ranges"],"eofEnd":snapshot["eofEnd"],"allPublishedUnits":snapshot["allPublishedUnits"] == true}),
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
            position: None,
        }
    }
    #[test]
    fn clean_captured_eof_cannot_approve_a_matching_prefix_of_the_complete_reference() {
        let reference = vec![packet(0.0, "A"), packet(0.02, "B"), packet(0.04, "C")];
        let captured = &reference[..2];
        let comparison = compare(captured, &reference, 0.0);
        assert!(
            comparison.iter().all(|(_, matched, _)| matched.is_some()),
            "individual emitted packets are correct"
        );
        let mut coverage = ReferenceCoverage {
            required: (0..3).collect(),
            ..Default::default()
        };
        coverage
            .covered
            .extend(comparison.iter().filter_map(|(_, matched, _)| *matched));
        assert!(
            !coverage.complete(),
            "a clean shortened EOF and local full-source certificate cannot invent the reference tail"
        );
        assert_eq!(
            coverage
                .required
                .difference(&coverage.covered)
                .copied()
                .collect::<Vec<_>>(),
            vec![2]
        );
        // A subsequent seek epoch may independently supply the missing tail.
        coverage.covered.extend(
            compare(&reference[2..], &reference, 0.0)
                .iter()
                .filter_map(|(_, matched, _)| *matched),
        );
        assert!(coverage.complete());
        coverage.covered.extend([2, 2]);
        assert_eq!(
            coverage.covered.len(),
            3,
            "duplicate published epochs do not double count reference coverage"
        );
    }
    #[test]
    fn matching_tail_without_beginning_is_incomplete_and_pcm_coverage_is_a_union_of_exact_frames() {
        let reference = vec![packet(0.0, "A"), packet(0.02, "B"), packet(0.04, "C")];
        let comparison = compare(&reference[1..], &reference, 0.0);
        assert!(comparison.iter().all(|(_, matched, _)| matched.is_some()));
        let mut coverage = ReferenceCoverage {
            required: (0..3).collect(),
            ..Default::default()
        };
        coverage
            .covered
            .extend(comparison.iter().filter_map(|(_, matched, _)| *matched));
        assert!(!coverage.complete());
        let presentation = ReferencePresentation {
            frame_packets: vec![0, 0, 1, 2],
            frame_ranges: vec![(0.0, 0.01), (0.01, 0.02), (0.02, 0.04), (0.04, 0.06)],
            required_packets: (0..3).collect(),
        };
        add_pcm_coverage(&mut coverage, &presentation, 0, 1, (0.0, f64::INFINITY)).unwrap();
        assert!(
            !coverage.complete(),
            "half a multi-frame packet does not establish its complete presentation"
        );
        add_pcm_coverage(&mut coverage, &presentation, 1, 1, (0.0, f64::INFINITY)).unwrap();
        assert!(coverage.complete());
        assert!(
            add_pcm_coverage(&mut coverage, &presentation, 3, 2, (0.0, f64::INFINITY)).is_err()
        );
    }
    #[test]
    fn reference_presentability_comes_from_decoded_metadata_not_captured_eof_or_nominal_duration() {
        let mut reference = vec![
            packet(-0.02, "PRIMING"),
            packet(0.0, "A"),
            packet(0.02, "B"),
        ];
        for (i, packet) in reference.iter_mut().enumerate() {
            packet.position = Some((100 + i) as u64);
        }
        let frames = vec![
            PresentationFrame {
                pkt_pos: Some("101".into()),
                nb_samples: Some(960),
                pts: Some(0),
            },
            PresentationFrame {
                pkt_pos: Some("102".into()),
                nb_samples: Some(960),
                pts: Some(960),
            },
        ];
        let proof = map_reference_frames(&reference, &frames, (1, 48000), 48000).unwrap();
        assert_eq!(proof.required_packets, HashSet::from([1, 2]));
        let coverage = ReferenceCoverage {
            required: proof.required_packets,
            covered: HashSet::from([1, 2]),
            ..Default::default()
        };
        assert!(
            coverage.complete(),
            "a whole decoder-discarded priming packet is not required output"
        );
        reference[2].position = Some(101);
        assert!(
            map_reference_frames(&reference, &frames, (1, 48000), 48000).is_err(),
            "ambiguous packet positions fail closed"
        );
    }
    #[test]
    fn matching_last_packet_bytes_do_not_hide_a_tail_clipped_by_the_append_window() {
        let presentation = ReferencePresentation {
            frame_packets: vec![0, 1],
            frame_ranges: vec![(0.0, 0.02), (0.02, 0.04)],
            required_packets: HashSet::from([0, 1]),
        };
        let mut coverage = ReferenceCoverage {
            required: presentation.required_packets.clone(),
            ..Default::default()
        };
        add_encoded_coverage(&mut coverage, &presentation, 0, (0.0, 0.039));
        add_encoded_coverage(&mut coverage, &presentation, 1, (0.0, 0.039));
        assert!(
            !coverage.complete(),
            "all encoded bytes exist but the final millisecond is not presentable"
        );
        assert_eq!(coverage.covered, HashSet::from([0]));
        add_encoded_coverage(&mut coverage, &presentation, 1, (0.039, 0.04));
        assert!(
            coverage.complete(),
            "another verified epoch may present the exact missing tail"
        );
        let mut beginning = ReferenceCoverage {
            required: presentation.required_packets.clone(),
            ..Default::default()
        };
        for packet in 0..2 {
            add_encoded_coverage(
                &mut beginning,
                &presentation,
                packet,
                (0.001, f64::INFINITY),
            );
        }
        assert!(
            !beginning.complete(),
            "within-packet missing beginning is also incomplete"
        );
        assert_eq!(
            append_window(&json!({"appendWindowStart":0.0,"appendWindowEnd":null}))
                .unwrap()
                .1,
            f64::INFINITY
        );
    }
    #[test]
    fn pcm_fallback_keeps_the_mse_metadata_offset_instead_of_accepting_wrongly_shifted_audio() {
        let offset = metadata_offset(&json!(0.02)).unwrap();
        assert_eq!((offset.numerator, offset.denominator), (1, 50));
        let negative = metadata_offset(&json!(-0.007)).unwrap();
        assert_eq!((negative.numerator, negative.denominator), (-7, 1000));
        assert!(
            metadata_offset(&json!(1e-100)).is_none(),
            "unrepresentable metadata never falls back to zero"
        );
        let reference = vec![packet(0.0, "A"), packet(0.02, "B")];
        assert!(compare(&reference[..1], &reference, 0.0)[0].1.is_some());
        assert!(
            compare(
                &reference[..1],
                &reference,
                offset.numerator as f64 / offset.denominator as f64
            )[0]
            .1
            .is_none(),
            "the same A bytes at B's timestamp are the wrong audio"
        );
    }
    #[tokio::test]
    async fn real_aac_and_opus_reference_inventory_maps_decoder_priming_and_eof() {
        let directory = std::env::temp_dir().join(format!(
            "musify-ref-coverage-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        for (codec, extension) in [("aac", "m4a"), ("libopus", "webm")] {
            let path = directory.join(format!("reference.{extension}"));
            let mut command = tokio::process::Command::new("ffmpeg");
            command
                .args([
                    "-v",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=997:sample_rate=48000:duration=2.048",
                    "-ac",
                    "2",
                    "-c:a",
                    codec,
                ])
                .arg(&path)
                .kill_on_drop(true);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.as_std_mut().creation_flags(0x08000000);
            }
            let output = command.output().await.unwrap();
            assert!(output.status.success());
            let packets = packets(&path).await.unwrap();
            let presentation = reference_presentation(&path, &packets).await.unwrap();
            assert!(!presentation.required_packets.is_empty());
            assert!(
                presentation.required_packets.contains(&(packets.len() - 1)),
                "the real final presented packet must be required"
            );
            if codec == "aac" {
                assert!(
                    !presentation.required_packets.contains(&0),
                    "container-declared full AAC priming is decoded away"
                );
            }
            std::fs::remove_file(path).unwrap();
        }
        std::fs::remove_dir(directory).unwrap();
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
