//! Bounded, disposable JavaScript runtimes for the public player decoder.
//!
//! The bundled AST analyzer treats the complete player as data. Only its extracted
//! dependencies execute, without host functions, a module loader, I/O or job pumps.
//! This is an in-process engine boundary, not an OS process sandbox.

use rquickjs::{Context, Ctx, Function, Object, Runtime, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, LazyLock,
};
use std::time::{Duration, Instant};
use tokio::sync::Semaphore;

const BUNDLE: &str = include_str!("youtube-decoder.bundle.js");
const DECODE_BUNDLE: &str = include_str!("youtube-decoder-execute.bundle.js");
const MAX_SOURCE: usize = 5 * 1024 * 1024;
const MAX_SCRIPT: usize = 2 * 1024 * 1024;
const MAX_VALUE: usize = 4096;
const STACK_BYTES: usize = 512 * 1024;
pub(crate) const PREPARE_TIMEOUT: Duration = Duration::from_secs(12);
static WORKER: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(1)));

#[derive(Clone)]
pub struct PreparedDecoder {
    pub script: String,
    pub signature_timestamp: u32,
}

#[derive(Default, PartialEq, Eq)]
pub struct Decoded {
    pub sig: Option<String>,
    pub n: Option<String>,
}

impl std::fmt::Debug for Decoded {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Decoded")
            .field("sig_bytes", &self.sig.as_ref().map(String::len))
            .field("n_bytes", &self.n.as_ref().map(String::len))
            .finish()
    }
}

#[derive(Clone, Copy)]
struct Limits {
    bytes: usize,
    time: Duration,
}

const PREPARE: Limits = Limits {
    // The real player takes several seconds to analyze. Its compact AST and
    // runtime are transient and globally limited to one VM.
    bytes: 192 * 1024 * 1024,
    time: PREPARE_TIMEOUT,
};
const DECODE: Limits = Limits {
    bytes: 32 * 1024 * 1024,
    time: Duration::from_secs(1),
};

// The trusted bundle privately captures Function before this runs. Remove its
// public entrypoint too, so extracted code cannot use it as another eval path.
// Lock every language Function constructor path, including async/generators.
const HARDEN: &str = r#"(() => {
    for (const fn of [function(){}, async function(){}, function*(){}, async function*(){}]) {
        Object.defineProperty(Object.getPrototypeOf(fn), 'constructor', {
            value: undefined, writable: false, configurable: false
        });
    }
    for (const name of ['eval', 'Function', 'SharedArrayBuffer', 'Atomics', 'WebAssembly']) {
        Object.defineProperty(globalThis, name, {
            value: undefined, writable: false, configurable: false
        });
    }
    if (!delete globalThis.__musifyYouTubeDecoder ||
        typeof globalThis.__musifyYouTubeDecoder !== 'undefined') throw new Error('HARDENING');
})()"#;

fn error(code: &str) -> String {
    format!("YOUTUBE_DECODER_{code}")
}

// Never stringify an exception: its message/stack can contain remote inputs.
fn js_error(e: rquickjs::Error) -> String {
    error(match e {
        rquickjs::Error::Allocation => "MEMORY",
        rquickjs::Error::Exception => "EXECUTION",
        _ => "ENGINE",
    })
}

fn js_failure(ctx: &Ctx<'_>, e: rquickjs::Error) -> String {
    if !matches!(e, rquickjs::Error::Exception) {
        return js_error(e);
    }
    // Only exact, fixed engine/bundle messages select a local category. Never
    // return any remote exception text, location or stack to logs or callers.
    let exception = ctx.catch();
    let message = exception
        .as_object()
        .and_then(|o| o.get::<_, Value>("message").ok())
        .and_then(Value::into_string)
        .and_then(|s| s.to_cstring().ok());
    error(match message.as_ref().map(|m| m.as_str()) {
        Some("out of memory") => "MEMORY",
        Some("Maximum call stack size exceeded" | "stack overflow") => "STACK",
        Some("DECODER_UNSUPPORTED_PLAYER") => "UNSUPPORTED",
        Some("DECODER_RESULT" | "DECODER_SCRIPT_SIZE") => "OUTPUT",
        _ => "EXECUTION",
    })
}

struct CancelOnDrop(Arc<AtomicBool>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

fn interrupted(cancelled: &AtomicBool, deadline: Instant) -> Result<(), String> {
    if cancelled.load(Ordering::Acquire) {
        Err(error("CANCELLED"))
    } else if Instant::now() >= deadline {
        Err(error("TIMEOUT"))
    } else {
        Ok(())
    }
}

#[cfg(test)]
async fn execute<T, F>(gate: Arc<Semaphore>, limits: Limits, work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: for<'js> FnOnce(Ctx<'js>, Object<'js>) -> Result<T, String> + Send + 'static,
{
    execute_until(gate, limits, Instant::now() + limits.time, work).await
}

async fn execute_until<T, F>(
    gate: Arc<Semaphore>,
    limits: Limits,
    deadline: Instant,
    work: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: for<'js> FnOnce(Ctx<'js>, Object<'js>) -> Result<T, String> + Send + 'static,
{
    execute_asset_until(gate, limits, deadline, BUNDLE, work).await
}

// Both assets enter the same worker, deadlines and hardening. The smaller asset
// avoids parsing the analyzer during decode; it never retains a runtime or moves
// initialization outside the caller's budget.
async fn execute_asset_until<T, F>(
    gate: Arc<Semaphore>,
    limits: Limits,
    deadline: Instant,
    asset: &'static str,
    work: F,
) -> Result<T, String>
where
    T: Send + 'static,
    F: for<'js> FnOnce(Ctx<'js>, Object<'js>) -> Result<T, String> + Send + 'static,
{
    // The queue is included in the deadline; callers cannot create an unbounded
    // series of expensive workers. A dropped future also interrupts a started VM.
    // A replacement may inherit less time, but can never extend the engine cap.
    let deadline = deadline.min(Instant::now() + limits.time);
    if Instant::now() >= deadline {
        return Err(error("TIMEOUT"));
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    let _cancel = CancelOnDrop(cancelled.clone());
    let permit = tokio::time::timeout(
        deadline.saturating_duration_since(Instant::now()),
        gate.acquire_owned(),
    )
    .await
    .map_err(|_| error("TIMEOUT"))?
    .map_err(|_| error("WORKER"))?;
    let worker_cancel = cancelled.clone();
    let mut worker = tokio::task::spawn_blocking(move || {
        // spawn_blocking cannot be forcibly aborted. Retain admission until the
        // runtime has really exited, even if its awaiting future has gone away.
        let _permit = permit;
        interrupted(&worker_cancel, deadline)?;
        let rt = Runtime::new().map_err(js_error)?;
        rt.set_memory_limit(limits.bytes);
        rt.set_max_stack_size(STACK_BYTES);
        let interrupt_cancel = worker_cancel.clone();
        rt.set_interrupt_handler(Some(Box::new(move || {
            interrupt_cancel.load(Ordering::Acquire) || Instant::now() >= deadline
        })));
        let context = Context::full(&rt).map_err(js_error)?;
        let result = context.with(|ctx| {
            ctx.eval::<(), _>(asset).map_err(js_error)?;
            let api: Object = ctx
                .globals()
                .get("__musifyYouTubeDecoder")
                .map_err(js_error)?;
            ctx.eval::<(), _>(HARDEN).map_err(js_error)?;
            work(ctx, api)
        });
        #[cfg(test)]
        if std::env::var_os("MUSIFY_DECODER_DIAGNOSTIC").is_some() {
            let usage = rt.memory_usage();
            eprintln!(
                "decoder memory limit={} allocated={} used={}",
                limits.bytes, usage.malloc_size, usage.memory_used_size
            );
        }
        interrupted(&worker_cancel, deadline)?;
        result
    });
    tokio::time::timeout(
        deadline.saturating_duration_since(Instant::now()),
        &mut worker,
    )
    .await
    .map_err(|_| error("TIMEOUT"))?
    .map_err(|_| error("WORKER"))?
}

fn bounded_string(value: Value<'_>, max: usize) -> Result<String, String> {
    let value = value
        .into_string()
        .ok_or_else(|| error("OUTPUT"))?
        .to_cstring()
        .map_err(js_error)?;
    if value.is_empty() || value.len() > max {
        return Err(error("OUTPUT"));
    }
    Ok(value.as_str().to_owned())
}

fn object(value: Value<'_>) -> Result<Object<'_>, String> {
    if value.is_array() || value.is_function() || value.is_promise() || value.is_proxy() {
        return Err(error("OUTPUT"));
    }
    value.into_object().ok_or_else(|| error("OUTPUT"))
}

fn read_prepared(value: Value<'_>) -> Result<PreparedDecoder, String> {
    let result = object(value)?;
    let stamp: Value = result.get("signatureTimestamp").map_err(js_error)?;
    let stamp = stamp
        .as_number()
        .filter(|n| n.is_finite() && n.fract() == 0.0 && *n > 0.0 && *n <= u32::MAX as f64)
        .ok_or_else(|| error("OUTPUT"))?;
    let script = bounded_string(result.get("script").map_err(js_error)?, MAX_SCRIPT)?;
    Ok(PreparedDecoder {
        script,
        signature_timestamp: stamp as u32,
    })
}

fn valid_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_VALUE
        && value.bytes().all(|b| (0x20..=0x7e).contains(&b))
}

fn read_token(
    result: &Object<'_>,
    key: &str,
    input: &Option<String>,
) -> Result<Option<String>, String> {
    let value: Value = result.get(key).map_err(js_error)?;
    if input.is_none() {
        return if value.is_undefined() {
            Ok(None)
        } else {
            Err(error("OUTPUT"))
        };
    }
    let value = bounded_string(value, MAX_VALUE)?;
    if !valid_value(&value)
        || value.starts_with("enhanced_except_")
        || (key == "n" && input.as_deref() == Some(value.as_str()))
    {
        return Err(error("OUTPUT"));
    }
    Ok(Some(value))
}

#[cfg(test)]
pub async fn prepare(source: String) -> Result<PreparedDecoder, String> {
    prepare_until(source, Instant::now() + PREPARE_TIMEOUT).await
}

/// A discarded provisional analysis and its replacement share the original
/// deadline, including queue time and the first runtime's actual cancellation.
pub(crate) async fn prepare_until(
    source: String,
    deadline: Instant,
) -> Result<PreparedDecoder, String> {
    if source.is_empty() || source.len() > MAX_SOURCE {
        return Err(error("INPUT"));
    }
    execute_until(WORKER.clone(), PREPARE, deadline, move |ctx, api| {
        let function: Function = api.get("prepare").map_err(js_error)?;
        // The complete player is a string argument to the AST analyzer, never eval.
        read_prepared(
            function
                .call((source.as_str(),))
                .map_err(|e| js_failure(&ctx, e))?,
        )
    })
    .await
}

pub async fn decode(
    prepared: Arc<PreparedDecoder>,
    sig: Option<String>,
    n: Option<String>,
) -> Result<Decoded, String> {
    decode_with_asset(prepared, sig, n, DECODE_BUNDLE).await
}

async fn decode_with_asset(
    prepared: Arc<PreparedDecoder>,
    sig: Option<String>,
    n: Option<String>,
    asset: &'static str,
) -> Result<Decoded, String> {
    if prepared.script.is_empty()
        || prepared.script.len() > MAX_SCRIPT
        || sig.as_deref().is_some_and(|v| !valid_value(v))
        || n.as_deref().is_some_and(|v| !valid_value(v))
    {
        return Err(error("INPUT"));
    }
    if sig.is_none() && n.is_none() {
        return Ok(Decoded::default());
    }
    execute_asset_until(
        WORKER.clone(),
        DECODE,
        Instant::now() + DECODE.time,
        asset,
        move |ctx, api| call_decode(&ctx, &api, &prepared, &sig, &n),
    )
    .await
}

fn call_decode(
    ctx: &Ctx<'_>,
    api: &Object<'_>,
    prepared: &PreparedDecoder,
    sig: &Option<String>,
    n: &Option<String>,
) -> Result<Decoded, String> {
    let function: Function = api.get("decode").map_err(js_error)?;
    let result = object(
        function
            .call((prepared.script.as_str(), sig.as_deref(), n.as_deref()))
            .map_err(|e| js_failure(ctx, e))?,
    )?;
    Ok(Decoded {
        sig: read_token(&result, "sig", sig)?,
        n: read_token(&result, "n", n)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    const PLAYER: &str = r#"(function(g) {
        var reverse = function(value) { return value.split('').reverse().join(''); };
        g.Url = function(value) { this.values = {n: value.split('n=')[1]}; };
        g.proto = g.Url.prototype;
        g.proto.set = function(key, value) { this.values[key] = value; };
        g.proto.get = function(key) { return this.values[key]; };
        var decipher = function(url, name = 'sig', value = '') {
            url = new g.Url(url); url.set('alr', 'yes');
            if (value) url.set(name, encodeURIComponent(reverse(value)));
            url.set('n', encodeURIComponent('decoded:' + decodeURIComponent(url.get('n'))));
            return url;
        };
        var timestamp = function() { return {signatureTimestamp: 20746}; };
        throw new Error('Complete player executed: private sentinel');
    })({});"#;

    fn prepared(script: &str) -> Arc<PreparedDecoder> {
        Arc::new(PreparedDecoder {
            script: script.to_owned(),
            signature_timestamp: 20746,
        })
    }

    fn gate() -> Arc<Semaphore> {
        Arc::new(Semaphore::new(1))
    }

    #[tokio::test]
    async fn extracts_without_running_player_and_passes_quotes_as_data() {
        let prepared = Arc::new(prepare(PLAYER.to_owned()).await.unwrap());
        assert_eq!(prepared.signature_timestamp, 20746);
        let token = r#"'\"); throw new Error('injected'); //"#;
        let output = decode(prepared.clone(), Some(token.into()), Some(token.into()))
            .await
            .unwrap();
        assert_eq!(output.sig, Some(token.chars().rev().collect()));
        assert_eq!(output.n, Some(format!("decoded:{token}")));
        assert_eq!(
            decode(prepared, None, None).await.unwrap(),
            Decoded::default()
        );
    }

    #[tokio::test]
    async fn extracted_code_has_no_host_io_or_dynamic_compilation_paths() {
        let script = r#"
            let callerBlocked = false;
            try { void arguments.callee; } catch { callerBlocked = true; }
            if (!callerBlocked) throw 'compiler caller exposed';
            const names = ['process','require','fetch','XMLHttpRequest','document','window',
                'std','os','print','console','setTimeout','eval','Function','Atomics',
                'SharedArrayBuffer','WebAssembly','__musifyYouTubeDecoder'];
            if (names.some(name => typeof globalThis[name] !== 'undefined')) throw 'host exposed';
            for (const fn of [function(){},async function(){},function*(){},async function*(){}]) {
                if (Object.getPrototypeOf(fn).constructor !== undefined) throw 'compiler exposed';
            }
            class Url { get() { return 'isolated'; } }
            const exportedVars = {nsigFunction: () => new Url()};
        "#;
        assert_eq!(
            decode(prepared(script), Some("input".into()), None)
                .await
                .unwrap()
                .sig
                .as_deref(),
            Some("isolated")
        );
    }

    #[tokio::test]
    async fn invalid_inputs_and_output_shapes_fail_without_echoing_remote_values() {
        for input in ["", "\n", "\0", "\u{00f1}"] {
            assert_eq!(
                decode(prepared("ignored"), Some(input.into()), None)
                    .await
                    .unwrap_err(),
                error("INPUT")
            );
        }
        let result = decode(
            prepared("throw new Error('PRIVATE_SENTINEL')"),
            Some("a".into()),
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(result, error("EXECUTION"));
        execute(gate(), DECODE, |ctx, _| {
            for source in [
                "null",
                "[]",
                "({script:'a',signatureTimestamp:0})",
                "({script:'a',signatureTimestamp:4294967296})",
                "({script:'a',signatureTimestamp:'123'})",
                "({script:42,signatureTimestamp:123})",
            ] {
                assert!(read_prepared(ctx.eval(source).map_err(js_error)?).is_err());
            }
            for source in [
                "({sig:42})",
                "({sig:'\\u0000'})",
                "({sig:'ñ'})",
                "({sig:'enhanced_except_bad'})",
                "({sig:'a',n:'extra'})",
            ] {
                let result = object(ctx.eval(source).map_err(js_error)?)?;
                assert!(
                    read_token(&result, "sig", &Some("input".into())).is_err()
                        || read_token(&result, "n", &None).is_err()
                );
            }
            Ok(())
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn cpu_memory_and_stack_are_bounded() {
        let fast = Limits {
            bytes: DECODE.bytes,
            time: Duration::from_millis(100),
        };
        let start = Instant::now();
        let result = execute(gate(), fast, |ctx, _| {
            ctx.eval::<(), _>("for (;;) {}").map_err(js_error)
        })
        .await;
        assert_eq!(result.unwrap_err(), error("TIMEOUT"));
        assert!(start.elapsed() < Duration::from_secs(2));
        let result = execute(gate(), DECODE, |ctx, _| {
            ctx.eval::<(), _>(
                "const held=[]; for(let i=0;i<128;i++) held.push(new ArrayBuffer(1024*1024));",
            )
            .map_err(js_error)
        })
        .await;
        assert!(matches!(
            result.as_ref().map_err(String::as_str),
            Err("YOUTUBE_DECODER_EXECUTION" | "YOUTUBE_DECODER_MEMORY")
        ));
        let result = execute(gate(), DECODE, |ctx, _| {
            ctx.eval::<(), _>("function recurse(){ return recurse()+1; } recurse();")
                .map_err(js_error)
        })
        .await;
        assert_eq!(result.unwrap_err(), error("EXECUTION"));
    }

    #[tokio::test]
    async fn dropping_a_running_future_interrupts_worker_before_releasing_admission() {
        let gate = gate();
        let (started, active) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(execute(gate.clone(), PREPARE, move |ctx, _| {
            let _ = started.send(());
            ctx.eval::<(), _>("for (;;) {}").map_err(js_error)
        }));
        active.await.unwrap();
        assert_eq!(gate.available_permits(), 0);
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        let permit = tokio::time::timeout(Duration::from_secs(1), gate.acquire())
            .await
            .unwrap()
            .unwrap();
        drop(permit);
        assert_eq!(gate.available_permits(), 1);
    }

    #[tokio::test]
    async fn replacing_cancelled_analysis_inherits_the_original_deadline() {
        let gate = gate();
        let limits = Limits {
            time: Duration::from_millis(1500),
            ..DECODE
        };
        let started_at = Instant::now();
        let deadline = started_at + Duration::from_millis(300);
        let (started, active) = tokio::sync::oneshot::channel();
        let first = tokio::spawn(execute_until(
            gate.clone(),
            limits,
            deadline,
            move |ctx, _| {
                let _ = started.send(());
                ctx.eval::<(), _>("for (;;) {}").map_err(js_error)
            },
        ));
        active.await.unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        first.abort();
        assert!(first.await.unwrap_err().is_cancelled());
        let second = execute_until(gate.clone(), limits, deadline, |ctx, _| {
            ctx.eval::<(), _>("for (;;) {}").map_err(js_error)
        })
        .await;
        assert_eq!(second.unwrap_err(), error("TIMEOUT"));
        // A reset to the 1500 ms job allowance would exceed this by a wide margin.
        assert!(started_at.elapsed() < Duration::from_millis(1000));
        let permit = tokio::time::timeout(Duration::from_secs(1), gate.acquire())
            .await
            .unwrap()
            .unwrap();
        drop(permit);
        assert_eq!(gate.available_permits(), 1);
        let invoked = Arc::new(AtomicBool::new(false));
        let witness = invoked.clone();
        let expired: Result<(), String> = execute_until(gate, limits, deadline, move |_, _| {
            witness.store(true, Ordering::Relaxed);
            Ok(())
        })
        .await;
        assert_eq!(expired.unwrap_err(), error("TIMEOUT"));
        assert!(!invoked.load(Ordering::Relaxed));
    }

    #[tokio::test]
    async fn queued_jobs_have_a_deadline_without_launching_another_vm() {
        let gate = gate();
        let permit = gate.clone().acquire_owned().await.unwrap();
        let result: Result<(), String> = execute(
            gate.clone(),
            Limits {
                time: Duration::from_millis(30),
                ..DECODE
            },
            |_, _| panic!("queued work must not run"),
        )
        .await;
        assert_eq!(result.unwrap_err(), error("TIMEOUT"));
        assert_eq!(gate.available_permits(), 0);
        drop(permit);
    }

    #[tokio::test]
    async fn minimal_asset_has_no_analyzer_and_keeps_decode_resource_limits() {
        execute_asset_until(
            gate(),
            DECODE,
            Instant::now() + DECODE.time,
            DECODE_BUNDLE,
            |_, api| {
                assert!(api
                    .get::<_, Value>("prepare")
                    .map_err(js_error)?
                    .is_undefined());
                assert!(api
                    .get::<_, Value>("decode")
                    .map_err(js_error)?
                    .is_function());
                Ok(())
            },
        )
        .await
        .unwrap();
        for script in [
            "for (;;) {}",
            "const held=[]; for(let i=0;i<128;i++) held.push(new ArrayBuffer(1024*1024));",
            "function recurse(){ return recurse()+1; } recurse();",
        ] {
            let result = decode(prepared(script), Some("input".into()), None).await;
            assert!(matches!(
                result.as_ref().map_err(String::as_str),
                Err("YOUTUBE_DECODER_TIMEOUT"
                    | "YOUTUBE_DECODER_EXECUTION"
                    | "YOUTUBE_DECODER_MEMORY"
                    | "YOUTUBE_DECODER_STACK")
            ));
        }
    }

    #[tokio::test]
    #[ignore = "Offline full/minimal asset comparison; verifies independent output hashes, no network"]
    async fn real_decode_asset_comparison() {
        let directory = std::path::PathBuf::from(
            std::env::var_os("MUSIFY_DECODER_FIXTURE_DIR").expect("explicit local fixture"),
        );
        let source = std::fs::read_to_string(directory.join("player.js.local")).unwrap();
        let expected: serde_json::Value = serde_json::from_slice(
            &std::fs::read(directory.join("decoder-output-hashes.json.local")).unwrap(),
        )
        .unwrap();
        let hash = |value: &str| format!("{:x}", Sha256::digest(value.as_bytes()));
        assert_eq!(expected["schema"], "youtube-decoder-output-hashes-v1");
        assert_eq!(expected["playerSha256"], hash(&source));
        assert_eq!(expected["bundleSha256"], hash(BUNDLE));
        assert_eq!(expected["decodeBundleSha256"], hash(DECODE_BUNDLE));
        let started = Instant::now();
        let prepared = Arc::new(prepare(source).await.unwrap());
        let prepare_ms = started.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(expected["signatureTimestamp"], prepared.signature_timestamp);
        assert_eq!(expected["scriptSha256"], hash(&prepared.script));
        let response: serde_json::Value = serde_json::from_slice(
            &std::fs::read(directory.join("player-response.json.local")).unwrap(),
        )
        .unwrap();
        let mut rows = Vec::new();
        let mut first_inputs = None;
        let mut checked = 0;
        for format in response["streamingData"]["adaptiveFormats"]
            .as_array()
            .unwrap()
        {
            if !matches!(format["itag"].as_u64(), Some(140 | 249 | 250 | 251)) {
                continue;
            }
            let Some(cipher) = format["signatureCipher"].as_str() else {
                continue;
            };
            let cipher =
                reqwest::Url::parse(&format!("https://example.invalid/?{cipher}")).unwrap();
            let args: std::collections::HashMap<_, _> = cipher.query_pairs().into_owned().collect();
            let url = reqwest::Url::parse(args.get("url").unwrap()).unwrap();
            let n = url
                .query_pairs()
                .find(|(name, _)| name == "n")
                .map(|(_, value)| value.into_owned());
            let sig = args.get("s").cloned();
            first_inputs.get_or_insert_with(|| (sig.clone(), n.clone()));
            let golden = expected["outputs"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["itag"] == format["itag"])
                .unwrap();
            // Each call includes validation, queue, fresh Runtime/Context, asset
            // evaluation, hardening, actual deciphering and runtime destruction.
            // ABBA uses the same binary, worker and prepared script. No VM cache.
            for (order, (name, asset)) in [
                ("full", BUNDLE),
                ("minimal", DECODE_BUNDLE),
                ("minimal", DECODE_BUNDLE),
                ("full", BUNDLE),
            ]
            .into_iter()
            .enumerate()
            {
                let started = Instant::now();
                let output = decode_with_asset(prepared.clone(), sig.clone(), n.clone(), asset)
                    .await
                    .unwrap();
                let total_ms = started.elapsed().as_secs_f64() * 1000.0;
                assert_eq!(golden["sigSha256"], hash(output.sig.as_deref().unwrap()));
                assert_eq!(golden["nSha256"], hash(output.n.as_deref().unwrap()));
                rows.push(serde_json::json!({"itag":format["itag"],"order":order,"asset":name,"totalMs":total_ms}));
            }
            checked += 1;
        }
        assert_eq!(checked, 4);
        // Separate attribution pass; it does not replace the complete call
        // measurements above. Bootstrap includes admission and hardening; body
        // covers Function.call + Rust validation; cleanup is in total only.
        let mut phases = Vec::new();
        for (name, asset) in [("full", BUNDLE), ("minimal", DECODE_BUNDLE)] {
            let prepared = prepared.clone();
            let (sig, n) = first_inputs.clone().unwrap();
            let started = Instant::now();
            let (bootstrap_ms, body_ms) = execute_asset_until(
                WORKER.clone(),
                DECODE,
                started + DECODE.time,
                asset,
                move |ctx, api| {
                    let bootstrap_ms = started.elapsed().as_secs_f64() * 1000.0;
                    let body = Instant::now();
                    call_decode(&ctx, &api, &prepared, &sig, &n)?;
                    Ok((bootstrap_ms, body.elapsed().as_secs_f64() * 1000.0))
                },
            )
            .await
            .unwrap();
            phases.push(serde_json::json!({"asset":name,"bootstrapMs":bootstrap_ms,"bodyMs":body_ms,"totalMs":started.elapsed().as_secs_f64()*1000.0}));
        }
        eprintln!(
            "decoder asset comparison {}",
            serde_json::json!({"playerSha256":expected["playerSha256"],"bundleSha256":hash(BUNDLE),"decodeBundleSha256":hash(DECODE_BUNDLE),"prepareMs":prepare_ms,"formats":checked,"measurements":rows,"attributionRealTokens":phases})
        );
    }

    #[tokio::test]
    #[ignore = "Profiles a local trusted diagnostic bundle; no network or remote values printed"]
    async fn real_player_phase_profile() {
        let directory = std::env::var_os("MUSIFY_DECODER_FIXTURE_DIR")
            .map(std::path::PathBuf::from)
            .expect("explicit local fixture directory required");
        let source = std::fs::read_to_string(directory.join("player.js.local")).unwrap();
        assert!(!source.is_empty() && source.len() <= MAX_SOURCE);
        let profile_path = std::env::var_os("MUSIFY_DECODER_PROFILE_BUNDLE")
            .expect("explicit trusted diagnostic bundle required");
        let diagnostic = std::fs::read_to_string(profile_path).unwrap();
        assert!(diagnostic.len() <= MAX_SCRIPT);
        let expected: serde_json::Value = serde_json::from_slice(
            &std::fs::read(directory.join("decoder-output-hashes.json.local")).unwrap(),
        )
        .unwrap();
        let hash = |value: &str| format!("{:x}", Sha256::digest(value.as_bytes()));
        assert_eq!(expected["playerSha256"], hash(&source));
        let diagnostic_hash = hash(&diagnostic);
        let (prepared, measurements) = execute(gate(), PREPARE, move |ctx, _api| {
            // This is trusted, locally generated instrumentation, never the
            // source player. It runs after the normal sandbox is hardened and
            // needs no Function constructor or host callback to analyze data.
            ctx.eval::<(), _>(diagnostic).map_err(|e| js_failure(&ctx, e))?;
            let function: Function = ctx.globals().get("__musifyDecoderProfile").map_err(js_error)?;
            ctx.eval::<(), _>(
                "delete globalThis.__musifyDecoderProfile; delete globalThis.__musifyYouTubeDecoder;",
            ).map_err(js_error)?;
            let value: Value = function.call((source.as_str(),)).map_err(|e| js_failure(&ctx, e))?;
            let result = object(value.clone())?;
            let profile: Object = result.get("profile").map_err(js_error)?;
            let mut measurements = serde_json::Map::new();
            for key in ["totalMs", "parseConstructorMs"] {
                if key != "totalMs" && profile.get::<_, Value>(key).map_err(js_error)?.is_undefined() {
                    continue;
                }
                let n: f64 = profile.get(key).map_err(js_error)?;
                if !n.is_finite() || n < 0.0 { return Err(error("OUTPUT")); }
                measurements.insert(key.into(), serde_json::json!(n));
            }
            for group in ["phases", "counters"] {
                let values: Object = profile.get(group).map_err(js_error)?;
                let mut selected = serde_json::Map::new();
                for key in [
                    "analyzeAst", "findDependencies", "onMatch", "refreshExtractionState",
                    "buildScript", "renderNode", "timestampMatcher", "nsigMatcher",
                    "walkAst:findDependencies", "walkAst:timestampMatcher", "walkAst:nsigMatcher",
                    "walkAst:analyzeAst", "walkAst:other",
                ] {
                    let value: Value = values.get(key).map_err(js_error)?;
                    if value.is_undefined() { continue; }
                    let n = value.as_number().filter(|n| n.is_finite() && *n >= 0.0)
                        .ok_or_else(|| error("OUTPUT"))?;
                    selected.insert(key.into(), serde_json::json!(n));
                }
                measurements.insert(group.into(), serde_json::Value::Object(selected));
            }
            Ok((read_prepared(value)?, serde_json::Value::Object(measurements)))
        }).await.expect("profile respects production budgets");
        assert_eq!(expected["signatureTimestamp"], prepared.signature_timestamp);
        assert_eq!(expected["scriptSha256"], hash(&prepared.script));
        eprintln!("decoder phase profile bundle_sha256={diagnostic_hash} {measurements}");
    }

    #[tokio::test]
    #[ignore = "Reads the local anonymous prototype fixture; no network or remote values printed"]
    async fn real_player_fixture() {
        // An Android test executable runs in its own /data/local/tmp directory;
        // its compile-time Windows source path is not available on the device.
        let directory = std::env::var_os("MUSIFY_DECODER_FIXTURE_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../capture-bench.local/kids-embedded-fixture.local")
            });
        let source = std::fs::read_to_string(directory.join("player.js.local"))
            .expect("local public player fixture required");
        let expected: serde_json::Value = serde_json::from_slice(
            &std::fs::read(directory.join("decoder-output-hashes.json.local"))
                .expect("independent V8 output hashes required"),
        )
        .unwrap();
        let hash = |value: &str| format!("{:x}", Sha256::digest(value.as_bytes()));
        assert_eq!(expected["schema"], "youtube-decoder-output-hashes-v1");
        assert_eq!(expected["playerSha256"], hash(&source));
        assert_eq!(expected["bundleSha256"], hash(BUNDLE));
        let started = Instant::now();
        let profiling = std::env::var_os("MUSIFY_DECODER_PROFILE").is_some();
        let prepared = Arc::new(
            if profiling {
                execute(
                    WORKER.clone(),
                    Limits {
                        time: Duration::from_secs(15),
                        ..PREPARE
                    },
                    move |ctx, api| {
                        let function: Function = api.get("prepare").map_err(js_error)?;
                        read_prepared(
                            function
                                .call((source.as_str(),))
                                .map_err(|e| js_failure(&ctx, e))?,
                        )
                    },
                )
                .await
            } else {
                prepare(source).await
            }
            .expect("bounded real player extraction"),
        );
        let prepare_ms = started.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(expected["signatureTimestamp"], prepared.signature_timestamp);
        assert_eq!(expected["scriptSha256"], hash(&prepared.script));
        let response: serde_json::Value = serde_json::from_slice(
            &std::fs::read(directory.join("player-response.json.local"))
                .expect("local response fixture required"),
        )
        .unwrap();
        let mut checked = 0;
        for format in response["streamingData"]["adaptiveFormats"]
            .as_array()
            .unwrap()
        {
            if !matches!(format["itag"].as_u64(), Some(140 | 249 | 250 | 251)) {
                continue;
            }
            let Some(cipher) = format["signatureCipher"].as_str() else {
                continue;
            };
            let cipher =
                reqwest::Url::parse(&format!("https://example.invalid/?{cipher}")).unwrap();
            let args: std::collections::HashMap<_, _> = cipher.query_pairs().into_owned().collect();
            let url = reqwest::Url::parse(args.get("url").unwrap()).unwrap();
            let n = url
                .query_pairs()
                .find(|(name, _)| name == "n")
                .map(|(_, value)| value.into_owned());
            let output = decode(prepared.clone(), args.get("s").cloned(), n)
                .await
                .expect("bounded real signature decoding");
            assert!(output.sig.is_some() && output.n.is_some());
            let golden = expected["outputs"]
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["itag"] == format["itag"])
                .expect("V8 hashes for this format required");
            assert_eq!(golden["sigSha256"], hash(output.sig.as_deref().unwrap()));
            assert_eq!(golden["nSha256"], hash(output.n.as_deref().unwrap()));
            checked += 1;
        }
        assert_eq!(checked, 4);
        eprintln!(
            "decoder fixture: profiling={profiling} prepare_ms={prepare_ms:.1} script_bytes={} formats={checked}",
            prepared.script.len()
        );
    }
}
