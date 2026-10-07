//! Benchmark-only exact PCM oracle. No correlation, gain adjustment, resampling,
//! silence trimming, inferred priming or search for a better matching time origin.
//! The caller must retain all published unit bytes and supply their packet count.
use serde::{Deserialize, Serialize};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MAX_INPUT: u64 = 128 * 1024 * 1024;
const MAX_PCM: u64 = 512 * 1024 * 1024;
const MAX_PROBE: u64 = 16 * 1024 * 1024;
static SERIAL: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FixedOffset {
    pub numerator: i64,
    pub denominator: u64,
}
impl FixedOffset {
    pub const ZERO: Self = Self {
        numerator: 0,
        denominator: 1,
    };
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PcmProof {
    pub method: &'static str,
    pub sample_rate: u32,
    pub channels: u16,
    pub channel_layout: String,
    pub encoded_packets: u64,
    pub decoded_frames: u64,
    pub decoded_sample_frames: u64,
    pub compared_bytes: u64,
    pub reference_first_frame: usize,
    pub reference_sample_offset: u64,
    pub fixed_offset: FixedOffset,
}

#[derive(Debug, Serialize)]
pub struct PcmFailure {
    pub code: &'static str,
    pub reason: String,
}
impl std::fmt::Display for PcmFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.reason)
    }
}
impl std::error::Error for PcmFailure {}
fn error(code: &'static str, reason: impl Into<String>) -> PcmFailure {
    PcmFailure {
        code,
        reason: reason.into(),
    }
}
fn unverified(reason: impl Into<String>) -> PcmFailure {
    error("PCM_UNVERIFIABLE", reason)
}

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Result<Self, PcmFailure> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| unverified("System clock unavailable"))?
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "musify-pcm-{}-{now}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&dir)
            .map_err(|_| unverified("Cannot create isolated PCM workspace"))?;
        Ok(Self(dir))
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn run(
    command: &mut tokio::process::Command,
    scratch: &Scratch,
    label: &str,
) -> Result<PathBuf, PcmFailure> {
    let stdout = scratch.0.join(format!("{label}.out"));
    let stderr = scratch.0.join(format!("{label}.err"));
    command
        .stdin(Stdio::null())
        .stdout(
            std::fs::File::create(&stdout).map_err(|_| unverified("Cannot create tool output"))?,
        )
        .stderr(
            std::fs::File::create(&stderr)
                .map_err(|_| unverified("Cannot create tool diagnostics"))?,
        )
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.as_std_mut().creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|_| unverified(format!("{label}: FFmpeg/ffprobe unavailable")))?;
    let status = match tokio::time::timeout(Duration::from_secs(30), child.wait()).await {
        Ok(status) => {
            status.map_err(|_| unverified(format!("{label}: process status unavailable")))?
        }
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(unverified(format!(
                "{label}: thirty-second deadline exceeded"
            )));
        }
    };
    if !status.success() {
        return Err(unverified(format!(
            "{label}: decoder/probe rejected the input"
        )));
    }
    Ok(stdout)
}

#[derive(Deserialize)]
struct RawProbe {
    #[serde(default)]
    streams: Vec<RawStream>,
    #[serde(default)]
    packets_and_frames: Vec<RawItem>,
}
#[derive(Deserialize)]
struct RawStream {
    sample_rate: Option<String>,
    channels: Option<u16>,
    channel_layout: Option<String>,
    time_base: Option<String>,
}
#[derive(Deserialize)]
struct RawItem {
    #[serde(rename = "type")]
    kind: String,
    pts: Option<i64>,
    nb_samples: Option<u64>,
}
struct Frame {
    pts: i64,
    samples: u64,
}
struct Probe {
    rate: u32,
    channels: u16,
    layout: String,
    numerator: i64,
    denominator: u64,
    packets: u64,
    frames: Vec<Frame>,
    samples: u64,
}

fn parse_probe(bytes: &[u8]) -> Result<Probe, PcmFailure> {
    let raw: RawProbe =
        serde_json::from_slice(bytes).map_err(|_| unverified("Invalid decoded-frame inventory"))?;
    if raw.streams.len() != 1 {
        return Err(unverified("Exactly one audio stream is required"));
    }
    let stream = &raw.streams[0];
    let rate: u32 = stream
        .sample_rate
        .as_deref()
        .ok_or_else(|| unverified("Missing sample rate"))?
        .parse()
        .map_err(|_| unverified("Invalid sample rate"))?;
    let channels = stream
        .channels
        .ok_or_else(|| unverified("Missing channel count"))?;
    let layout = stream
        .channel_layout
        .as_deref()
        .filter(|s| !s.is_empty() && *s != "unknown")
        .ok_or_else(|| unverified("Unknown channel layout"))?
        .to_string();
    let (num, den) = stream
        .time_base
        .as_deref()
        .and_then(|s| s.split_once('/'))
        .ok_or_else(|| unverified("Missing integer time base"))?;
    let numerator: i64 = num
        .parse()
        .map_err(|_| unverified("Invalid time-base numerator"))?;
    let denominator: u64 = den
        .parse()
        .map_err(|_| unverified("Invalid time-base denominator"))?;
    if rate == 0
        || rate > 192_000
        || channels == 0
        || channels > 8
        || numerator <= 0
        || denominator == 0
        || numerator as u128 * 1000 > denominator as u128
    {
        return Err(unverified(
            "Unsupported native audio format or clock coarser than1ms",
        ));
    }
    let mut frames: Vec<Frame> = Vec::new();
    let mut packets = 0u64;
    let mut samples = 0u64;
    for item in raw.packets_and_frames {
        if item.kind == "packet" {
            packets = packets
                .checked_add(1)
                .ok_or_else(|| unverified("Packet count overflow"))?;
            continue;
        }
        if item.kind != "frame" {
            return Err(unverified("Unknown decoded inventory entry"));
        }
        let pts = item
            .pts
            .ok_or_else(|| unverified("Decoded frame lacks an integer timestamp"))?;
        let count = item
            .nb_samples
            .filter(|&n| n > 0)
            .ok_or_else(|| unverified("Decoded frame lacks a sample count"))?;
        if let Some(first) = frames.first() {
            if pts <= frames.last().unwrap().pts {
                return Err(unverified("Overlapping or repeated decoded frame clock"));
            }
            // The reference comparison below requires EXACT rational clocks. This
            // continuity check alone permits one declared clock tick (e.g. Opus
            //648 samples=13.5ms reported as14ms); no samples are inserted or removed.
            let actual = (pts as i128 - first.pts as i128)
                .checked_mul(numerator as i128)
                .and_then(|v| v.checked_mul(rate as i128));
            let expected = (samples as i128).checked_mul(denominator as i128);
            let quantum = (numerator as i128).checked_mul(rate as i128);
            if actual
                .zip(expected)
                .zip(quantum)
                .is_none_or(|((a, b), q)| (a - b).abs() > q)
            {
                return Err(unverified(
                    "Decoded group has a clock gap or uncertain priming",
                ));
            }
        }
        samples = samples
            .checked_add(count)
            .ok_or_else(|| unverified("Decoded sample count overflow"))?;
        frames.push(Frame {
            pts,
            samples: count,
        });
    }
    if frames.is_empty() || packets == 0 {
        return Err(unverified("No complete decoded audio inventory"));
    }
    let bytes = samples
        .checked_mul(channels as u64)
        .and_then(|v| v.checked_mul(4))
        .ok_or_else(|| unverified("PCM size overflow"))?;
    if bytes > MAX_PCM {
        return Err(unverified(
            "Decoded audio exceeds the512MiB comparison budget",
        ));
    }
    Ok(Probe {
        rate,
        channels,
        layout,
        numerator,
        denominator,
        packets,
        frames,
        samples,
    })
}

async fn probe(path: &Path, scratch: &Scratch, label: &str) -> Result<Probe, PcmFailure> {
    if std::fs::metadata(path)
        .map_err(|_| unverified("Audio input unavailable"))?
        .len()
        > MAX_INPUT
    {
        return Err(unverified("Audio input exceeds128MiB"));
    }
    let mut command = tokio::process::Command::new("ffprobe");
    command
        .args([
            "-v",
            "error",
            "-select_streams",
            "a",
            "-show_packets",
            "-show_frames",
            "-show_streams",
            "-show_entries",
            "stream=sample_rate,channels,channel_layout,time_base:frame=pts,nb_samples:packet=pts",
            "-of",
            "json",
        ])
        .arg(path);
    let output = run(&mut command, scratch, label).await?;
    if std::fs::metadata(&output)
        .map_err(|_| unverified("Probe inventory unavailable"))?
        .len()
        > MAX_PROBE
    {
        return Err(unverified("Probe inventory exceeds16MiB"));
    }
    parse_probe(&std::fs::read(output).map_err(|_| unverified("Cannot read probe inventory"))?)
}

fn same_time(c: &Probe, cp: i64, r: &Probe, rp: i64, offset: FixedOffset) -> bool {
    let left = (cp as i128)
        .checked_mul(c.numerator as i128)
        .and_then(|v| v.checked_mul(offset.denominator as i128))
        .and_then(|v| {
            (offset.numerator as i128)
                .checked_mul(c.denominator as i128)
                .and_then(|o| v.checked_add(o))
        })
        .and_then(|v| v.checked_mul(r.denominator as i128));
    let right = (rp as i128)
        .checked_mul(r.numerator as i128)
        .and_then(|v| v.checked_mul(c.denominator as i128))
        .and_then(|v| v.checked_mul(offset.denominator as i128));
    left.zip(right).is_some_and(|(a, b)| a == b)
}

async fn decode(
    path: &Path,
    scratch: &Scratch,
    label: &str,
    inventory: &Probe,
) -> Result<PathBuf, PcmFailure> {
    let output = scratch.0.join(format!("{label}.f32le"));
    let mut command = tokio::process::Command::new("ffmpeg");
    command
        .args(["-v", "error", "-nostdin", "-xerror", "-copyts", "-i"])
        .arg(path)
        .args([
            "-map",
            "0:a:0",
            "-vn",
            "-sn",
            "-dn",
            "-c:a",
            "pcm_f32le",
            "-f",
            "f32le",
            "-fs",
        ])
        .arg((MAX_PCM + 1).to_string())
        .arg(&output);
    run(&mut command, scratch, label).await?;
    let expected = inventory.samples * inventory.channels as u64 * 4;
    if std::fs::metadata(&output)
        .map_err(|_| unverified("PCM output unavailable"))?
        .len()
        != expected
    {
        return Err(unverified(
            "Decoder output does not account for every probed sample",
        ));
    }
    Ok(output)
}

/// `alignment` is chosen BEFORE looking at PCM, from independently justified
/// timeline metadata. ZERO is the conservative default. Never retry offsets to
/// obtain a match. Partial Opus/AAC priming may legitimately return unverifiable.
pub async fn compare_exact(
    captured: &Path,
    reference: &Path,
    alignment: FixedOffset,
    expected_packets: u64,
) -> Result<PcmProof, PcmFailure> {
    if alignment.denominator == 0
        || (alignment.numerator as i128).abs() * 10 > alignment.denominator as i128
    {
        return Err(unverified(
            "Fixed codec-origin offset must be explicit and at most100ms",
        ));
    }
    let scratch = Scratch::new()?;
    let c = probe(captured, &scratch, "captured-probe").await?;
    let r = probe(reference, &scratch, "reference-probe").await?;
    if expected_packets == 0 || c.packets != expected_packets {
        return Err(unverified(format!(
            "Not all published packets were probed: expected={expected_packets}, actual={}",
            c.packets
        )));
    }
    if c.rate != r.rate || c.channels != r.channels || c.layout != r.layout {
        return Err(unverified(
            "Different native sample rate, channels or layout; resampling is forbidden",
        ));
    }
    // Select by the predetermined rational TIME only, never waveform similarity.
    let first = r
        .frames
        .iter()
        .position(|frame| same_time(&c, c.frames[0].pts, &r, frame.pts, alignment))
        .ok_or_else(|| unverified("No reference frame at the exact fixed origin"))?;
    if first + c.frames.len() > r.frames.len() {
        return Err(unverified("Reference does not cover every captured frame"));
    }
    for (index, frame) in c.frames.iter().enumerate() {
        let rf = &r.frames[first + index];
        if frame.samples != rf.samples || !same_time(&c, frame.pts, &r, rf.pts, alignment) {
            return Err(unverified(format!(
                "Decoded frame{index} has different timing/sample count; priming or missing audio is not inferred"
            )));
        }
    }
    let c_path = decode(captured, &scratch, "captured-decode", &c).await?;
    let r_path = decode(reference, &scratch, "reference-decode", &r).await?;
    let reference_sample_offset = r.frames[..first].iter().map(|f| f.samples).sum::<u64>();
    let compared_bytes = c.samples * c.channels as u64 * 4;
    let mut cf = std::fs::File::open(c_path).map_err(|_| unverified("Cannot read captured PCM"))?;
    let mut rf =
        std::fs::File::open(r_path).map_err(|_| unverified("Cannot read reference PCM"))?;
    rf.seek(SeekFrom::Start(
        reference_sample_offset * r.channels as u64 * 4,
    ))
    .map_err(|_| unverified("Cannot select fixed reference interval"))?;
    let mut compared = 0u64;
    let mut cb = [0u8; 65536];
    let mut rb = [0u8; 65536];
    while compared < compared_bytes {
        let count = (compared_bytes - compared).min(cb.len() as u64) as usize;
        cf.read_exact(&mut cb[..count])
            .map_err(|_| unverified("Captured PCM is incomplete"))?;
        rf.read_exact(&mut rb[..count])
            .map_err(|_| unverified("Reference PCM is incomplete"))?;
        if cb[..count]
            .chunks_exact(4)
            .chain(rb[..count].chunks_exact(4))
            .any(|sample| !f32::from_le_bytes(sample.try_into().unwrap()).is_finite())
        {
            return Err(unverified("Decoded PCM contains a non-finite sample"));
        }
        if cb[..count] != rb[..count] {
            let different = cb[..count]
                .iter()
                .zip(&rb[..count])
                .position(|(a, b)| a != b)
                .unwrap() as u64;
            return Err(error(
                "PCM_MISMATCH",
                format!(
                    "Exact decoded samples differ at interleaved sample{}; no offset search or correlation applied",
                    (compared + different) / 4
                ),
            ));
        }
        compared += count as u64;
    }
    Ok(PcmProof {
        method: "exact-pcm-fixed-clock",
        sample_rate: c.rate,
        channels: c.channels,
        channel_layout: c.layout,
        encoded_packets: c.packets,
        decoded_frames: c.frames.len() as u64,
        decoded_sample_frames: c.samples,
        compared_bytes,
        reference_first_frame: first,
        reference_sample_offset,
        fixed_offset: alignment,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn tone(scratch: &Scratch, name: &str, frequency: u32, codec: &str) -> PathBuf {
        let file = scratch.0.join(format!(
            "{name}.{}",
            if codec == "libopus" { "webm" } else { "m4a" }
        ));
        let mut command = tokio::process::Command::new("ffmpeg");
        command
            .args(["-v", "error", "-nostdin", "-f", "lavfi", "-i"])
            .arg(format!(
                "sine=frequency={frequency}:sample_rate=48000:duration=0.4"
            ))
            .args(["-c:a", codec])
            .arg(&file);
        run(&mut command, scratch, name)
            .await
            .expect("Real FFmpeg fixture generation is required");
        file
    }
    #[tokio::test]
    async fn real_aac_and_opus_compare_all_native_decoded_samples() {
        let scratch = Scratch::new().unwrap();
        for codec in ["aac", "libopus"] {
            let path = tone(&scratch, codec, 997, codec).await;
            let remux = scratch.0.join(format!(
                "remux.{}",
                if codec == "libopus" { "webm" } else { "m4a" }
            ));
            let mut command = tokio::process::Command::new("ffmpeg");
            command
                .args(["-v", "error", "-nostdin", "-copyts", "-i"])
                .arg(&path)
                .args([
                    "-c:a",
                    "copy",
                    "-metadata",
                    "comment=container-metadata-only",
                ])
                .arg(&remux);
            run(&mut command, &scratch, &format!("{codec}-remux"))
                .await
                .unwrap();
            assert_ne!(
                std::fs::read(&path).unwrap(),
                std::fs::read(&remux).unwrap()
            );
            let inventory = probe(&path, &scratch, &format!("{codec}-inventory"))
                .await
                .unwrap();
            let proof = compare_exact(&remux, &path, FixedOffset::ZERO, inventory.packets)
                .await
                .unwrap();
            assert_eq!(proof.encoded_packets, inventory.packets);
            assert_eq!(proof.decoded_sample_frames, inventory.samples);
            assert_eq!(
                proof.compared_bytes,
                inventory.samples * inventory.channels as u64 * 4
            );
            assert_eq!(proof.reference_first_frame, 0);
        }
    }
    #[tokio::test]
    async fn real_changed_audio_and_missing_packet_accounting_never_pass() {
        let scratch = Scratch::new().unwrap();
        let song = tone(&scratch, "song", 997, "aac").await;
        let advertisement = tone(&scratch, "ad", 1499, "aac").await;
        let inventory = probe(&song, &scratch, "song-inventory").await.unwrap();
        let mismatch = compare_exact(&advertisement, &song, FixedOffset::ZERO, inventory.packets)
            .await
            .unwrap_err();
        assert_eq!(mismatch.code, "PCM_MISMATCH");
        let missing = compare_exact(&song, &song, FixedOffset::ZERO, inventory.packets + 1)
            .await
            .unwrap_err();
        assert_eq!(missing.code, "PCM_UNVERIFIABLE");
    }
    #[tokio::test]
    async fn wrong_fixed_clock_and_partial_opus_are_unverifiable_without_origin_search() {
        let scratch = Scratch::new().unwrap();
        let song = tone(&scratch, "opus", 1000, "libopus").await;
        let inventory = probe(&song, &scratch, "opus-inventory").await.unwrap();
        assert!(
            compare_exact(
                &song,
                &song,
                FixedOffset {
                    numerator: 1,
                    denominator: 1000
                },
                inventory.packets
            )
            .await
            .is_err()
        );
        let partial = scratch.0.join("partial.webm");
        let mut command = tokio::process::Command::new("ffmpeg");
        command
            .args(["-v", "error", "-nostdin", "-ss", "0.1", "-i"])
            .arg(&song)
            .args(["-c", "copy"])
            .arg(&partial);
        run(&mut command, &scratch, "partial-remux").await.unwrap();
        let part = probe(&partial, &scratch, "partial-inventory").await;
        if let Ok(part) = part {
            assert!(
                compare_exact(&partial, &song, FixedOffset::ZERO, part.packets)
                    .await
                    .is_err()
            );
        }
    }
    #[test]
    fn integer_time_matching_never_widens_clocks_or_uses_float_rounding() {
        let probe = |pts| Probe {
            rate: 48_000,
            channels: 1,
            layout: "mono".into(),
            numerator: 1,
            denominator: 48_000,
            packets: 1,
            frames: vec![Frame { pts, samples: 1024 }],
            samples: 1024,
        };
        let c = probe(0);
        let r = probe(1);
        assert!(!same_time(&c, 0, &r, 1, FixedOffset::ZERO));
        assert!(same_time(
            &c,
            0,
            &r,
            1,
            FixedOffset {
                numerator: 1,
                denominator: 48_000
            }
        ));
    }
}
