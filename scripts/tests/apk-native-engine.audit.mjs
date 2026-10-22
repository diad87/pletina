// Diagnostic only: run the unchanged APK-reference Rust extractor on the desktop.
// Requires Rust and cached Cargo dependencies. Does not build or launch an APK/server.
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const commit = '4b5691ff50d659fbd048f5a9cff1ddfa91c22a79'
const git = path => execFileSync('git', ['show', `${commit}:${path}`], { cwd: root })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const dir = await mkdtemp(join(tmpdir(), 'pletina-apk-native-recipe-audit-'))
await mkdir(join(dir, 'src'))

const native = git('src-tauri/src/native.rs')
const recipe = git('src-tauri/recipe/youtube.json')
const youtube = git('src-tauri/src/youtube.rs').toString('utf8')
const ytdlp = git('src-tauri/src/ytdlp.rs').toString('utf8')
const ua = /pub const BROWSER_UA: &str =\s*"([^"]+)";/.exec(youtube)?.[1]
const helpers = /pub\(crate\) fn query_param[\s\S]*?(?=\nfn read_stamp)/.exec(ytdlp)?.[0]
if (!ua || !helpers) throw new Error('Reference helper layout changed')
await writeFile(join(dir, 'src/native.rs'), native)
await writeFile(join(dir, 'recipe.json'), recipe)
await writeFile(join(dir, 'Cargo.toml'), `[package]
name="pletina-apk-native-recipe-audit"
version="0.1.0"
edition="2024"
[dependencies]
reqwest={version="=0.12.28",default-features=false,features=["gzip","rustls-tls","charset","http2"]}
serde={version="=1.0.229",features=["derive"]}
serde_json="=1.0.151"
tokio={version="=1.53.2",features=["macros","rt-multi-thread","sync","time"]}
`)
// Only module plumbing is replaced. The extractor and its helper bodies stay intact.
await writeFile(join(dir, 'src/main.rs'), `#![allow(dead_code)]
mod native;
mod youtube { pub const BROWSER_UA: &str = ${JSON.stringify(ua)}; }
mod extractors { pub fn bundled_recipe() -> &'static str { include_str!("../recipe.json") } }
mod ytdlp { use std::time::{SystemTime, UNIX_EPOCH}; ${helpers} }
#[tokio::main]
async fn main() {
  let mut rows = vec![];
  for id in ["fV-IUsecSsU", "PStEJ1pAR6s", "gpfVjKXVnDc"] {
    let start = std::time::Instant::now();
    let result = match native::resolve(id, true).await {
      Ok(d) => serde_json::json!({"videoId":id,"resolved":true,"title":d.title,
        "channel":d.channel,"duration":d.duration,"client":d.client,"itag":d.itag,
        "mime":d.mime,"urlNotPersisted":true,"nativeDeepRangeValidationPassed":true}),
      Err(e) => serde_json::json!({"videoId":id,"resolved":false,"error":e.to_string()})
    };
    rows.push(serde_json::json!({"elapsedMs":start.elapsed().as_millis(),"result":result}));
  }
  println!("{}", serde_json::json!({"results":rows}));
}
`)

const report = {
  testedAt: new Date().toISOString(), sourceCommit: commit,
  scope: 'Unchanged reference native.rs in a desktop Rust harness with original helpers and bundled recipe. No Tauri app, APK, device, emulator or server. Native extraction/ranged-status diagnostic only; no decoder or physical background proof.',
  nativeSourceSha256: hash(native), recipeSha256: hash(recipe),
  sourceByteIdentityVerified: (await readFile(join(dir, 'src/native.rs'))).equals(native),
  results: [], errors: [],
}
const child = spawn('cargo', ['run', '--quiet', '--offline', '--manifest-path', join(dir, 'Cargo.toml')], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
})
let stdout = '', stderr = ''
child.stdout.on('data', data => { stdout += data })
child.stderr.on('data', data => { stderr += data })
const scrub = text => text.replace(/https?:\/\/\S+/g, '[URL]')
report.exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
if (report.exitCode === 0) {
  report.results = JSON.parse(stdout).results.map(row => ({ ...row, result: {
    ...row.result, ...(row.result.error ? { error: scrub(row.result.error) } : {}),
  } }))
} else report.errors.push(scrub(stderr).slice(0, 1800))
report.cargoLockSha256 = await readFile(join(dir, 'Cargo.lock')).then(hash).catch(() => null)
Object.assign(report, { signedUrlsOrTokensPersisted: false, runtimeServerAdded: false,
  productChanged: false, physicalDeviceVerified: false, finishedAt: new Date().toISOString() })
const output = join(root, 'artifacts/pwa-port', `apk-native-recipe-rust-harness-${report.testedAt.replaceAll(':', '-')}.json`)
await writeFile(output, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ report: output, ...report }, null, 2))
if (report.exitCode !== 0) process.exitCode = 1
