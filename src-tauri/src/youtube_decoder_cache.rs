//! Optional app-local cache of already prepared public player scripts.
//!
//! A freshly downloaded source is required for every lookup. Hashes bind cache
//! entries to source/URL/analyzer semantics and detect corruption; they do not
//! authenticate files against a local user who can rewrite the app's data. Loaded
//! scripts still run only through youtube_decoder's unchanged bounded runtime.

use crate::youtube_decoder::PreparedDecoder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    Arc, LazyLock, Mutex, OnceLock,
    atomic::{AtomicU64, Ordering},
};
use std::time::{SystemTime, UNIX_EPOCH};

const SCHEMA: u32 = 1;
const MAX_SOURCE: usize = 5 * 1024 * 1024;
const MAX_SCRIPT: usize = 2 * 1024 * 1024;
const MAX_BYTES: u64 = 8 * 1024 * 1024;
const MAX_ENTRIES: usize = 4;
// These disk entries are checked against newly downloaded source bytes, URL and
// analyzer ABI on every load. Expiring unchanged source overnight needlessly
// repeats the full analysis. This does not extend any URL-only in-memory cache.
const TTL_SECONDS: u64 = 30 * 24 * 3600;
static SEQUENCE: AtomicU64 = AtomicU64::new(0);
static STORE: OnceLock<Store> = OnceLock::new();
static ABI: LazyLock<String> = LazyLock::new(|| {
    let mut hash = Sha256::new();
    hash.update(b"pletina-youtube-decoder-cache-v1\0");
    hash.update(include_bytes!("youtube-decoder.bundle.js"));
    hash.update(include_bytes!("youtube-decoder-execute.bundle.js"));
    hash.update(include_bytes!("youtube_decoder.rs"));
    format!("{:x}", hash.finalize())
});

fn error(code: &str) -> String {
    format!("YOUTUBE_DECODER_CACHE_{code}")
}
fn now() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|v| v.as_secs())
}
fn hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
}

#[derive(Clone)]
struct Identity {
    url: String,
    source_sha: String,
    key: String,
}

impl Identity {
    fn new(player_url: &str, source: &str) -> Option<Self> {
        if source.is_empty() || source.len() > MAX_SOURCE {
            return None;
        }
        Self::from_hash(player_url, Sha256::digest(source.as_bytes()).into())
    }

    // Hash-only construction is used for eviction, never for a cache hit.
    fn from_hash(player_url: &str, source_sha: [u8; 32]) -> Option<Self> {
        if player_url.len() > 2048 {
            return None;
        }
        let url = reqwest::Url::parse(player_url).ok()?;
        let parts: Vec<_> = url.path().split('/').collect();
        if url.scheme() != "https"
            || url.host_str() != Some("www.youtube.com")
            || url.port_or_known_default() != Some(443)
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || parts.len() < 5
            || parts[1] != "s"
            || parts[2] != "player"
            || parts.last() != Some(&"base.js")
            || !(8..=32).contains(&parts[3].len())
            || !parts[3]
                .bytes()
                .all(|v| v.is_ascii_lowercase() || v.is_ascii_digit())
            || parts[4..].iter().any(|part| {
                part.is_empty()
                    || *part == "."
                    || *part == ".."
                    || !part
                        .bytes()
                        .all(|v| v.is_ascii_alphanumeric() || b"._-".contains(&v))
            })
        {
            return None;
        }
        let source_sha: String = source_sha
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let url = url.to_string();
        let key = format!(
            "{:x}",
            Sha256::digest(format!("{}\0{url}\0{source_sha}", *ABI).as_bytes())
        );
        Some(Self {
            url,
            source_sha,
            key,
        })
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    schema: u32,
    abi: String,
    player_url: String,
    source_sha256: String,
    created_at: u64,
    signature_timestamp: u32,
    script: String,
    checksum: String,
}

impl Entry {
    fn checksum(&self) -> String {
        let mut hash = Sha256::new();
        hash.update(self.schema.to_le_bytes());
        hash.update(self.created_at.to_le_bytes());
        hash.update(self.signature_timestamp.to_le_bytes());
        for value in [
            &self.abi,
            &self.player_url,
            &self.source_sha256,
            &self.script,
        ] {
            hash.update((value.len() as u64).to_le_bytes());
            hash.update(value.as_bytes());
        }
        format!("{:x}", hash.finalize())
    }
    fn valid(&self, identity: &Identity, at: u64) -> bool {
        self.schema == SCHEMA
            && self.abi == *ABI
            && self.player_url == identity.url
            && self.source_sha256 == identity.source_sha
            && hex(&self.source_sha256)
            && self.created_at <= at
            && at - self.created_at <= TTL_SECONDS
            && self.signature_timestamp > 0
            && valid_script(&self.script)
            && hex(&self.checksum)
            && self.checksum == self.checksum()
    }
}

fn valid_script(script: &str) -> bool {
    !script.is_empty() && script.len() <= MAX_SCRIPT && !script.contains('\0')
}
fn regular(metadata: &fs::Metadata) -> bool {
    metadata.is_file() && !reparse(metadata)
}
fn reparse(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}
fn directory(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| error("DIRECTORY"))?;
    if !metadata.is_dir() || reparse(&metadata) {
        return Err(error("DIRECTORY"));
    }
    Ok(())
}

struct Store {
    root: PathBuf,
    gate: Mutex<()>,
}
impl Store {
    fn new(app_data: &Path) -> Result<Self, String> {
        if !app_data.is_absolute() {
            return Err(error("DIRECTORY"));
        }
        directory(app_data)?;
        let app_data = fs::canonicalize(app_data).map_err(|_| error("DIRECTORY"))?;
        let mut root = app_data;
        for component in ["extractors-cache", "youtube-decoder-v1"] {
            root.push(component);
            match fs::create_dir(&root) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(_) => return Err(error("DIRECTORY")),
            }
            directory(&root)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
                    .map_err(|_| error("DIRECTORY"))?;
            }
        }
        Ok(Self {
            root,
            gate: Mutex::new(()),
        })
    }
    fn check_root(&self) -> Result<(), String> {
        directory(self.root.parent().ok_or_else(|| error("DIRECTORY"))?)?;
        directory(&self.root)?;
        if fs::canonicalize(&self.root).map_err(|_| error("DIRECTORY"))? != self.root {
            return Err(error("DIRECTORY"));
        }
        Ok(())
    }
    fn path(&self, identity: &Identity) -> PathBuf {
        self.root.join(format!("{}.json", identity.key))
    }
    fn load_inner(&self, identity: &Identity, at: u64) -> Option<Arc<PreparedDecoder>> {
        self.check_root().ok()?;
        let path = self.path(identity);
        let metadata = fs::symlink_metadata(&path).ok()?;
        if !regular(&metadata) || metadata.len() > MAX_BYTES {
            return None;
        }
        let file = File::open(path).ok()?;
        let opened = file.metadata().ok()?;
        if !regular(&opened) || opened.len() > MAX_BYTES {
            return None;
        }
        let mut bytes = Vec::new();
        file.take(MAX_BYTES + 1).read_to_end(&mut bytes).ok()?;
        if bytes.len() as u64 > MAX_BYTES {
            return None;
        }
        let entry: Entry = serde_json::from_slice(&bytes).ok()?;
        if !entry.valid(identity, at) {
            return None;
        }
        Some(Arc::new(PreparedDecoder {
            script: entry.script,
            signature_timestamp: entry.signature_timestamp,
        }))
    }
    fn load(&self, identity: &Identity, at: u64) -> Option<Arc<PreparedDecoder>> {
        let _guard = self.gate.lock().ok()?;
        self.load_inner(identity, at)
    }
    fn prune(&self, required: u64, target: &Path) -> Result<(), String> {
        self.check_root()?;
        let mut entries = Vec::new();
        for (index, entry) in fs::read_dir(&self.root)
            .map_err(|_| error("READ"))?
            .enumerate()
        {
            if index >= 128 {
                return Err(error("CONTENTS"));
            }
            let entry = entry.map_err(|_| error("READ"))?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| error("CONTENTS"))?;
            let pieces: Vec<_> = name.split('.').collect();
            let json = pieces.len() == 2 && hex(pieces[0]) && pieces[1] == "json";
            let temporary = pieces.len() == 4
                && hex(pieces[0])
                && pieces[1].parse::<u32>().is_ok()
                && pieces[2].parse::<u64>().is_ok()
                && pieces[3] == "tmp";
            let metadata = fs::symlink_metadata(entry.path()).map_err(|_| error("READ"))?;
            if (!json && !temporary) || !regular(&metadata) {
                return Err(error("CONTENTS"));
            }
            if temporary || entry.path() == target {
                fs::remove_file(entry.path()).map_err(|_| error("WRITE"))?;
            } else {
                entries.push((
                    entry.path(),
                    metadata.len(),
                    metadata.modified().unwrap_or(UNIX_EPOCH),
                ));
            }
        }
        entries.sort_by_key(|(_, _, time)| *time);
        let mut total = entries
            .iter()
            .try_fold(required, |sum, (_, len, _)| sum.checked_add(*len))
            .ok_or_else(|| error("LIMIT"))?;
        while entries.len() >= MAX_ENTRIES || total > MAX_BYTES {
            let (path, len, _) = entries.remove(0);
            fs::remove_file(path).map_err(|_| error("WRITE"))?;
            total -= len;
        }
        Ok(())
    }
    fn store(
        &self,
        identity: &Identity,
        prepared: &PreparedDecoder,
        at: u64,
    ) -> Result<(), String> {
        if !valid_script(&prepared.script) || prepared.signature_timestamp == 0 {
            return Err(error("INPUT"));
        }
        let _guard = self.gate.lock().map_err(|_| error("LOCK"))?;
        if self.load_inner(identity, at).is_some() {
            return Ok(());
        }
        let mut entry = Entry {
            schema: SCHEMA,
            abi: ABI.clone(),
            player_url: identity.url.clone(),
            source_sha256: identity.source_sha.clone(),
            created_at: at,
            signature_timestamp: prepared.signature_timestamp,
            script: prepared.script.clone(),
            checksum: String::new(),
        };
        entry.checksum = entry.checksum();
        let mut encoded = LimitedBytes(Vec::new());
        serde_json::to_writer(&mut encoded, &entry).map_err(|_| error("LIMIT"))?;
        let target = self.path(identity);
        self.prune(encoded.0.len() as u64, &target)?;
        let temporary = self.root.join(format!(
            "{}.{}.{}.tmp",
            identity.key,
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let cleanup = Temporary(temporary.clone());
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|_| error("WRITE"))?;
        file.write_all(&encoded.0)
            .and_then(|_| file.sync_all())
            .map_err(|_| error("WRITE"))?;
        drop(file);
        fs::rename(&temporary, target).map_err(|_| error("WRITE"))?;
        drop(cleanup);
        Ok(())
    }
    fn invalidate(&self, identity: &Identity) -> Result<(), String> {
        let _guard = self.gate.lock().map_err(|_| error("LOCK"))?;
        self.check_root()?;
        let path = self.path(identity);
        if let Ok(metadata) = fs::symlink_metadata(&path) {
            if !regular(&metadata) {
                return Err(error("CONTENTS"));
            }
            fs::remove_file(path).map_err(|_| error("WRITE"))?;
        }
        Ok(())
    }
}

struct LimitedBytes(Vec<u8>);
impl Write for LimitedBytes {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > MAX_BYTES as usize {
            return Err(std::io::Error::other("cache limit"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
struct Temporary(PathBuf);
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// Call once using Tauri's app-local-data path, never a path from media/config input.
/// No fallback to the current directory, browser profile, or an environment path.
pub fn initialize(app_data: &Path) -> Result<(), String> {
    initialize_cell(&STORE, app_data)
}

fn initialize_cell(cell: &OnceLock<Store>, app_data: &Path) -> Result<(), String> {
    let store = Store::new(app_data)?;
    let expected = store.root.clone();
    let current = cell.get_or_init(|| store);
    if current.root == expected {
        Ok(())
    } else {
        Err(error("ALREADY_INITIALIZED"))
    }
}

/// A cache miss/error is deliberately optional: callers retain normal prepare().
pub async fn load(player_url: &str, downloaded_source: &str) -> Option<Arc<PreparedDecoder>> {
    let identity = Identity::new(player_url, downloaded_source)?;
    let store = STORE.get()?;
    let at = now()?;
    tokio::task::spawn_blocking(move || store.load(&identity, at))
        .await
        .ok()
        .flatten()
}

pub async fn store(
    player_url: &str,
    downloaded_source: &str,
    prepared: &PreparedDecoder,
) -> Result<(), String> {
    let identity = Identity::new(player_url, downloaded_source).ok_or_else(|| error("INPUT"))?;
    let store = STORE.get().ok_or_else(|| error("UNINITIALIZED"))?;
    let at = now().ok_or_else(|| error("CLOCK"))?;
    let prepared = prepared.clone();
    tokio::task::spawn_blocking(move || store.store(&identity, &prepared, at))
        .await
        .map_err(|_| error("WORKER"))?
}

/// Only removes the exact URL/source/ABI entry; never another downloaded version.
pub async fn invalidate(player_url: &str, source_sha: [u8; 32]) -> Result<(), String> {
    let identity = Identity::from_hash(player_url, source_sha).ok_or_else(|| error("INPUT"))?;
    let store = STORE.get().ok_or_else(|| error("UNINITIALIZED"))?;
    tokio::task::spawn_blocking(move || store.invalidate(&identity))
        .await
        .map_err(|_| error("WORKER"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    const URL: &str = "https://www.youtube.com/s/player/cbcfbf2f/player_es6.vflset/en_US/base.js";
    const AT: u64 = 1_800_000_000;
    struct Fixture {
        directory: PathBuf,
        store: Store,
    }
    impl Fixture {
        fn new() -> Self {
            let directory = std::env::temp_dir().join(format!(
                "pletina-decoder-cache-test-{}-{}",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&directory).unwrap();
            let store = Store::new(&directory).unwrap();
            Self { directory, store }
        }
        fn write(&self, identity: &Identity, value: serde_json::Value) {
            fs::write(
                self.store.path(identity),
                serde_json::to_vec(&value).unwrap(),
            )
            .unwrap();
        }
        fn read(&self, identity: &Identity) -> serde_json::Value {
            serde_json::from_slice(&fs::read(self.store.path(identity)).unwrap()).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }
    fn prepared() -> PreparedDecoder {
        PreparedDecoder {
            script: "const exportedVars={};".into(),
            signature_timestamp: 20746,
        }
    }

    #[test]
    fn initialization_is_concurrently_idempotent_but_never_switches_directories() {
        let fixture = Fixture::new();
        let other = Fixture::new();
        let cell = OnceLock::new();
        std::thread::scope(|scope| {
            let handles: Vec<_> = (0..8)
                .map(|_| scope.spawn(|| initialize_cell(&cell, &fixture.directory)))
                .collect();
            for handle in handles {
                handle.join().unwrap().unwrap();
            }
        });
        initialize_cell(&cell, &fixture.directory).unwrap();
        assert!(initialize_cell(&cell, &other.directory).is_err());
        assert_eq!(cell.get().unwrap().root, fixture.store.root);
        let identity = Identity::new(URL, "source").unwrap();
        cell.get()
            .unwrap()
            .store(&identity, &prepared(), AT)
            .unwrap();
        assert!(fixture.store.path(&identity).exists());
        assert!(!other.store.path(&identity).exists());
    }

    #[test]
    fn exact_current_source_url_and_abi_are_required_after_restart() {
        let fixture = Fixture::new();
        let identity = Identity::new(URL, "downloaded source").unwrap();
        fixture.store.store(&identity, &prepared(), AT).unwrap();
        let reopened = Store::new(&fixture.directory).unwrap();
        let actual = reopened.load(&identity, AT + 1).unwrap();
        assert_eq!(actual.script, prepared().script);
        assert_eq!(actual.signature_timestamp, 20746);
        let changed = Identity::new(URL, "changed downloaded source").unwrap();
        assert!(reopened.load(&changed, AT + 1).is_none());
        let other =
            Identity::new(&URL.replace("cbcfbf2f", "12345678"), "downloaded source").unwrap();
        assert!(reopened.load(&other, AT + 1).is_none());
        let mut entry = fixture.read(&identity);
        entry["abi"] = serde_json::json!("0".repeat(64));
        fixture.write(&identity, entry);
        assert!(reopened.load(&identity, AT + 1).is_none());
    }

    #[test]
    fn corrupted_hash_timestamp_extra_fields_and_script_never_load() {
        let fixture = Fixture::new();
        let identity = Identity::new(URL, "source").unwrap();
        fixture.store.store(&identity, &prepared(), AT).unwrap();
        let original = fixture.read(&identity);
        for (field, value) in [
            ("checksum", serde_json::json!("0".repeat(64))),
            ("signature_timestamp", serde_json::json!(0)),
            ("script", serde_json::json!("changed")),
            ("source_sha256", serde_json::json!("0".repeat(64))),
            ("visitorData", serde_json::json!("must-not-load")),
            ("schema", serde_json::json!(2)),
        ] {
            let mut changed = original.clone();
            changed[field] = value;
            fixture.write(&identity, changed);
            assert!(fixture.store.load(&identity, AT + 1).is_none(), "{field}");
        }
        fs::write(fixture.store.path(&identity), b"{\"script\":").unwrap();
        assert!(fixture.store.load(&identity, AT + 1).is_none());
        let mut oversized: Entry = serde_json::from_value(original).unwrap();
        oversized.script = "x".repeat(MAX_SCRIPT + 1);
        oversized.checksum = oversized.checksum();
        fs::write(
            fixture.store.path(&identity),
            serde_json::to_vec(&oversized).unwrap(),
        )
        .unwrap();
        assert!(fixture.store.load(&identity, AT + 1).is_none());
        File::create(fixture.store.path(&identity))
            .unwrap()
            .set_len(MAX_BYTES + 1)
            .unwrap();
        assert!(fixture.store.load(&identity, AT + 1).is_none());
    }

    #[test]
    fn ttl_and_future_clock_fail_closed_without_renewing_on_reads() {
        let fixture = Fixture::new();
        let identity = Identity::new(URL, "source").unwrap();
        fixture.store.store(&identity, &prepared(), AT).unwrap();
        assert!(fixture.store.load(&identity, AT).is_some());
        assert!(fixture.store.load(&identity, AT + TTL_SECONDS).is_some());
        assert!(
            fixture
                .store
                .load(&identity, AT + TTL_SECONDS + 1)
                .is_none()
        );
        assert!(fixture.store.load(&identity, AT - 1).is_none());
    }

    #[test]
    fn unchanged_downloaded_source_survives_overnight_without_renewing_its_age() {
        let fixture = Fixture::new();
        let identity = Identity::new(URL, "freshly downloaded same bytes").unwrap();
        fixture.store.store(&identity, &prepared(), AT).unwrap();
        let original = fs::read(fixture.store.path(&identity)).unwrap();
        let reopened = Store::new(&fixture.directory).unwrap();
        for age in [7 * 3600, 12 * 3600, 24 * 3600, 7 * 24 * 3600, 30 * 24 * 3600] {
            let decoder = reopened.load(&identity, AT + age).unwrap();
            assert_eq!(decoder.script, prepared().script);
            assert_eq!(decoder.signature_timestamp, prepared().signature_timestamp);
            assert_eq!(fs::read(fixture.store.path(&identity)).unwrap(), original);
        }
        assert!(reopened.load(&identity, AT + 30 * 24 * 3600 + 1).is_none());
    }

    #[test]
    fn older_entries_still_require_exact_current_source_url_and_abi() {
        let fixture = Fixture::new();
        let identity = Identity::new(URL, "fresh source").unwrap();
        fixture.store.store(&identity, &prepared(), AT).unwrap();
        let reopened = Store::new(&fixture.directory).unwrap();
        let at = AT + 7 * 24 * 3600;
        assert!(reopened.load(&identity, at).is_some());
        let changed = Identity::new(URL, "fresh source changed by one byte").unwrap();
        assert!(reopened.load(&changed, at).is_none());
        let changed_url = Identity::new(&URL.replace("en_US", "es_ES"), "fresh source").unwrap();
        assert!(reopened.load(&changed_url, at).is_none());
        let mut incompatible: Entry = serde_json::from_value(fixture.read(&identity)).unwrap();
        incompatible.abi = "0".repeat(64);
        incompatible.checksum = incompatible.checksum();
        fixture.write(&identity, serde_json::to_value(incompatible).unwrap());
        assert!(reopened.load(&identity, at).is_none());
    }

    #[test]
    fn encoded_disk_budget_and_script_limit_are_separate() {
        let fixture = Fixture::new();
        let mut big = prepared();
        big.script = "\"".repeat(MAX_SCRIPT);
        for index in 0..5 {
            let identity = Identity::new(URL, &format!("source-{index}")).unwrap();
            fixture.store.store(&identity, &big, AT + index).unwrap();
            let entries: Vec<_> = fs::read_dir(&fixture.store.root)
                .unwrap()
                .map(Result::unwrap)
                .collect();
            assert!(entries.len() <= MAX_ENTRIES);
            assert!(
                entries
                    .iter()
                    .map(|v| v.metadata().unwrap().len())
                    .sum::<u64>()
                    <= MAX_BYTES
            );
        }
        big.script.push('x');
        let identity = Identity::new(URL, "too-large").unwrap();
        assert!(fixture.store.store(&identity, &big, AT).is_err());
        assert!(!fixture.store.path(&identity).exists());
    }

    #[test]
    fn four_entry_eviction_and_exact_invalidation_keep_other_sources() {
        let fixture = Fixture::new();
        let mut identities = Vec::new();
        for index in 0..5 {
            let identity = Identity::new(URL, &format!("source-{index}")).unwrap();
            fixture.store.store(&identity, &prepared(), AT).unwrap();
            identities.push(identity);
        }
        assert_eq!(fs::read_dir(&fixture.store.root).unwrap().count(), 4);
        assert!(fixture.store.load(&identities[4], AT).is_some());
        fixture.store.invalidate(&identities[0]).unwrap();
        assert!(fixture.store.load(&identities[4], AT).is_some());
        let exact = Identity::from_hash(URL, Sha256::digest(b"source-4").into()).unwrap();
        assert_eq!(exact.key, identities[4].key);
        fixture.store.invalidate(&exact).unwrap();
        assert!(fixture.store.load(&identities[4], AT).is_none());
    }

    #[test]
    fn orphan_temporary_or_external_directory_is_never_a_cache_hit() {
        let fixture = Fixture::new();
        let identity = Identity::new(URL, "source").unwrap();
        let temporary = fixture.store.root.join(format!("{}.1.0.tmp", identity.key));
        fs::write(&temporary, b"partial").unwrap();
        assert!(fixture.store.load(&identity, AT).is_none());
        fixture.store.store(&identity, &prepared(), AT).unwrap();
        assert!(!temporary.exists());
        assert!(fixture.store.load(&identity, AT).is_some());
        assert!(Store::new(Path::new(".")).is_err());
        assert!(
            !fs::read_dir(&fixture.store.root).unwrap().any(|e| e
                .unwrap()
                .path()
                .extension()
                .is_some_and(|v| v == "tmp"))
        );
    }

    #[test]
    fn only_public_player_urls_and_bounded_source_are_accepted() {
        for url in [
            "https://www.youtube.com/watch?v=ID",
            "https://outside.invalid/s/player/cbcfbf2f/base.js",
            "http://www.youtube.com/s/player/cbcfbf2f/base.js",
            "https://user@www.youtube.com/s/player/cbcfbf2f/base.js",
            "https://www.youtube.com/s/player/cbcfbf2f/base.js?visitor=private",
            "https://www.youtube.com/s/player/cbcfbf2f/base.js#private",
        ] {
            assert!(Identity::new(url, "source").is_none());
        }
        assert!(Identity::new(URL, "").is_none());
        assert!(Identity::new(URL, &"x".repeat(MAX_SOURCE + 1)).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_entries_and_cache_directories_are_rejected() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let identity = Identity::new(URL, "source").unwrap();
        let external = fixture.directory.join("external");
        fs::write(&external, b"{}").unwrap();
        symlink(&external, fixture.store.path(&identity)).unwrap();
        assert!(fixture.store.load(&identity, AT).is_none());
        assert!(fixture.store.store(&identity, &prepared(), AT).is_err());
        fs::remove_file(fixture.store.path(&identity)).unwrap();
        fs::remove_dir(&fixture.store.root).unwrap();
        symlink(&fixture.directory, &fixture.store.root).unwrap();
        assert!(Store::new(&fixture.directory).is_err());
    }
}
