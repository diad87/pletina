//! Private benchmark reference transport. A partial or differently validated
//! response never becomes a reference. No request URL or header value is logged.
use reqwest::header::{
    ACCEPT_ENCODING, CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_RANGE, DATE, ETAG, HeaderMap,
    HeaderValue, IF_RANGE, LAST_MODIFIED, RANGE,
};
use std::time::Duration;
use tokio::task::JoinSet;

const MAX_BYTES: usize = 128 * 1024 * 1024;
const RANGE_BYTES: usize = 256 * 1024;
const CONCURRENCY: usize = 4;
const RANGE_TIMEOUT: Duration = Duration::from_secs(30);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Clone, Debug, PartialEq, Eq)]
enum Validator {
    EntityTag(HeaderValue),
    Modified(HeaderValue),
}
impl Validator {
    fn header(&self) -> &HeaderValue {
        match self {
            Self::EntityTag(value) | Self::Modified(value) => value,
        }
    }
    fn matches(&self, headers: &HeaderMap) -> bool {
        match self {
            Self::EntityTag(value) => {
                one_header(headers, ETAG.as_str()).ok().flatten() == Some(value)
            }
            Self::Modified(value) => {
                one_header(headers, LAST_MODIFIED.as_str()).ok().flatten() == Some(value)
                    && !headers.contains_key(ETAG)
            }
        }
    }
}

fn one_header<'a>(headers: &'a HeaderMap, name: &str) -> Result<Option<&'a HeaderValue>, String> {
    let mut values = headers.get_all(name).iter();
    let first = values.next();
    if values.next().is_some() {
        return Err("reference-duplicate-representation-header".into());
    }
    Ok(first)
}

fn decimal(value: &str) -> Option<usize> {
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

// Only IMF-fixdate is accepted. Obsolete HTTP dates are unnecessary for this
// oracle and remain unverifiable rather than introducing a lenient date parser.
fn http_date(value: &HeaderValue) -> Option<i64> {
    let text = value.to_str().ok()?;
    if !text.is_ascii() {
        return None;
    }
    let b = text.as_bytes();
    if b.len() != 29
        || &b[3..5] != b", "
        || b[7] != b' '
        || b[11] != b' '
        || b[16] != b' '
        || b[19] != b':'
        || b[22] != b':'
        || &b[25..] != b" GMT"
        || !["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].contains(&&text[..3])
    {
        return None;
    }
    let day = decimal(&text[5..7])? as i64;
    let month = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]
    .iter()
    .position(|m| *m == &text[8..11])? as i64
        + 1;
    let year = decimal(&text[12..16])? as i64;
    let hour = decimal(&text[17..19])? as i64;
    let minute = decimal(&text[20..22])? as i64;
    let second = decimal(&text[23..25])? as i64;
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let month_days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if year < 1970
        || day < 1
        || day > month_days[(month - 1) as usize]
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    let y = year - i64::from(month <= 2);
    let era = y / 400;
    let yoe = y - era * 400;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let days = era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(days * 86400 + hour * 3600 + minute * 60 + second)
}

fn strong_validator(headers: &HeaderMap) -> Result<Validator, String> {
    // RFC 9110 §§8.8.2.2,13.1.5,15.3.7.3: ranges can only be recombined with
    // the same strong validator. An old enough Last-Modified is usable only in
    // the absence of an entity tag; a weak ETag cannot be sent in If-Range.
    // https://www.rfc-editor.org/rfc/rfc9110.html#section-15.3.7.3
    if let Some(value) = one_header(headers, ETAG.as_str())? {
        let bytes = value.as_bytes();
        if bytes.len() >= 2
            && bytes.len() <= 512
            && bytes[0] == b'"'
            && bytes[bytes.len() - 1] == b'"'
            && bytes[1..bytes.len() - 1]
                .iter()
                .all(|b| *b == 0x21 || (0x23..=0x7e).contains(b) || *b >= 0x80)
        {
            return Ok(Validator::EntityTag(value.clone()));
        }
        return Err("reference-has-no-strong-validator".into());
    }
    let modified =
        one_header(headers, LAST_MODIFIED.as_str())?.ok_or("reference-has-no-strong-validator")?;
    let date = one_header(headers, DATE.as_str())?
        .and_then(http_date)
        .ok_or("reference-has-no-strong-validator")?;
    let at = http_date(modified).ok_or("reference-has-no-strong-validator")?;
    if date - at < 60 {
        return Err("reference-has-no-strong-validator".into());
    }
    Ok(Validator::Modified(modified.clone()))
}

fn validate_content_range(
    value: Option<&HeaderValue>,
    start: usize,
    end: usize,
    total: usize,
) -> Result<(), String> {
    let text = value
        .and_then(|v| v.to_str().ok())
        .ok_or("reference-missing-content-range")?;
    let Some(rest) = text.strip_prefix("bytes ") else {
        return Err("reference-invalid-content-range".into());
    };
    let Some((span, size)) = rest.split_once('/') else {
        return Err("reference-invalid-content-range".into());
    };
    let Some((first, last)) = span.split_once('-') else {
        return Err("reference-invalid-content-range".into());
    };
    if decimal(first) != Some(start)
        || decimal(last) != Some(end)
        || decimal(size) != Some(total)
        || start > end
        || end >= total
    {
        return Err("reference-content-range-mismatch".into());
    }
    Ok(())
}

struct Part {
    start: usize,
    bytes: Vec<u8>,
    validator: Option<Validator>,
}

async fn part(
    client: reqwest::Client,
    url: reqwest::Url,
    start: usize,
    end: usize,
    total: usize,
    validator: Option<Validator>,
    timeout: Duration,
) -> Result<Part, String> {
    tokio::time::timeout(timeout, async {
        let mut request = client
            .get(url.clone())
            .header(RANGE, format!("bytes={start}-{end}"))
            .header(ACCEPT_ENCODING, "identity")
            .timeout(timeout);
        if let Some(proof) = &validator {
            request = request.header(IF_RANGE, proof.header().clone());
        }
        let mut response = request.send().await.map_err(|error| {
            if error.is_timeout() {
                "reference-range-timeout"
            } else if error.is_connect() {
                "reference-range-connect-failed"
            } else {
                "reference-range-request-failed"
            }
        })?;
        if response.url() != &url {
            return Err("reference-unexpected-redirect".into());
        }
        if response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
            return Err(format!(
                "reference-range-http-{}",
                response.status().as_u16()
            ));
        }
        let headers = response.headers();
        validate_content_range(
            one_header(headers, CONTENT_RANGE.as_str())?,
            start,
            end,
            total,
        )?;
        if let Some(length) = one_header(headers, CONTENT_LENGTH.as_str())? {
            if length.to_str().ok().and_then(decimal) != Some(end - start + 1) {
                return Err("reference-range-content-length-mismatch".into());
            }
        }
        if one_header(headers, CONTENT_ENCODING.as_str())?
            .is_some_and(|v| v.as_bytes() != b"identity")
        {
            return Err("reference-encoded-range-not-verifiable".into());
        }
        let proof = if let Some(proof) = validator {
            if !proof.matches(headers) {
                return Err("reference-validator-changed".into());
            }
            Some(proof)
        } else if end + 1 < total {
            Some(strong_validator(headers)?)
        } else {
            None
        };
        let mut bytes = Vec::with_capacity(end - start + 1);
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "reference-range-body-interrupted")?
        {
            if bytes.len().saturating_add(chunk.len()) > end - start + 1 {
                return Err("reference-range-body-too-long".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        if bytes.len() != end - start + 1 {
            return Err("reference-range-body-incomplete".into());
        }
        Ok(Part {
            start,
            bytes,
            validator: proof,
        })
    })
    .await
    .map_err(|_| "reference-range-timeout".to_string())?
}

/// `client` must disable transparent decompression (`ClientBuilder::no_gzip`)
/// and have no cookies. Every request uses exactly this URL; no recipe refresh,
/// changed query, unbounded retry or full-body fallback occurs here.
pub async fn download(
    client: &reqwest::Client,
    url: &str,
    expected_length: usize,
) -> Result<Vec<u8>, String> {
    download_with_limits(
        client,
        url,
        expected_length,
        RANGE_BYTES,
        RANGE_TIMEOUT,
        TOTAL_TIMEOUT,
    )
    .await
}

async fn download_with_limits(
    client: &reqwest::Client,
    url: &str,
    expected_length: usize,
    range_bytes: usize,
    range_timeout: Duration,
    total_timeout: Duration,
) -> Result<Vec<u8>, String> {
    if expected_length == 0 || expected_length > MAX_BYTES || range_bytes == 0 {
        return Err("reference-size-outside128MiB-budget".into());
    }
    let url = reqwest::Url::parse(url).map_err(|_| "reference-invalid-url")?;
    if !matches!(url.scheme(), "https" | "http")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("reference-invalid-url".into());
    }
    tokio::time::timeout(total_timeout, async {
        let first = part(
            client.clone(),
            url.clone(),
            0,
            (range_bytes - 1).min(expected_length - 1),
            expected_length,
            None,
            range_timeout,
        )
        .await?;
        let validator = first.validator;
        let mut result = vec![0; expected_length];
        result[..first.bytes.len()].copy_from_slice(&first.bytes);
        let mut next = first.bytes.len();
        let mut completed = next;
        let mut jobs = JoinSet::new();
        while next < expected_length || !jobs.is_empty() {
            while next < expected_length && jobs.len() < CONCURRENCY {
                let start = next;
                let end = start
                    .saturating_add(range_bytes - 1)
                    .min(expected_length - 1);
                next = end + 1;
                jobs.spawn(part(
                    client.clone(),
                    url.clone(),
                    start,
                    end,
                    expected_length,
                    validator.clone(),
                    range_timeout,
                ));
            }
            let value = jobs
                .join_next()
                .await
                .ok_or("reference-range-scheduler-empty")?
                .map_err(|_| "reference-range-task-failed")??;
            let end = value
                .start
                .checked_add(value.bytes.len())
                .filter(|end| *end <= expected_length)
                .ok_or("reference-range-assembly-overflow")?;
            result[value.start..end].copy_from_slice(&value.bytes);
            completed += value.bytes.len();
        }
        if completed != expected_length {
            return Err("reference-coverage-incomplete".into());
        }
        Ok(result)
        // JoinSet aborts all still-running tasks on every error or cancellation.
    })
    .await
    .map_err(|_| "reference-total-timeout".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    };
    use std::thread;

    #[derive(Clone, Copy)]
    enum Reply {
        Valid,
        ModifiedDate,
        WeakTag,
        NoValidator,
        WrongRange,
        WrongLength,
        Truncated,
        ExtraBody,
        ChangedTag,
        Full200,
        Encoded,
        Delay,
    }
    struct Server {
        url: String,
        body: Arc<Vec<u8>>,
        stop: Arc<AtomicBool>,
        thread: Option<thread::JoinHandle<()>>,
        maximum: Arc<AtomicUsize>,
        requests: Arc<Mutex<Vec<String>>>,
    }
    impl Server {
        fn new(reply: Reply, size: usize) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let address = listener.local_addr().unwrap();
            let body = Arc::new(
                (0..size)
                    .map(|i| ((i * 73 + 11) % 251) as u8)
                    .collect::<Vec<_>>(),
            );
            let stop = Arc::new(AtomicBool::new(false));
            let active = Arc::new(AtomicUsize::new(0));
            let maximum = Arc::new(AtomicUsize::new(0));
            let requests = Arc::new(Mutex::new(Vec::new()));
            let (data, done, count, peak, logs) = (
                body.clone(),
                stop.clone(),
                active.clone(),
                maximum.clone(),
                requests.clone(),
            );
            let thread = thread::spawn(move || {
                let mut children = Vec::new();
                while !done.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            let (data, count, peak, logs) =
                                (data.clone(), count.clone(), peak.clone(), logs.clone());
                            children.push(thread::spawn(move || {
                                // Accepted Winsock sockets inherit nonblocking
                                // mode from the listener, unlike Unix sockets.
                                stream.set_nonblocking(false).unwrap();
                                stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                                let mut request = Vec::new(); let mut byte = [0];
                                while request.len() < 16384 && !request.ends_with(b"\r\n\r\n") {
                                    if stream.read(&mut byte).unwrap_or(0) == 0 { return; }
                                    request.push(byte[0]);
                                }
                                let text = String::from_utf8(request).unwrap();
                                logs.lock().unwrap().push(text.clone());
                                let range = text.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("range: bytes=").map(str::to_string)).unwrap();
                                let (start, end) = range.split_once('-').unwrap(); let start: usize = start.parse().unwrap(); let end: usize = end.parse().unwrap();
                                peak.fetch_max(count.fetch_add(1, Ordering::SeqCst) + 1, Ordering::SeqCst);
                                thread::sleep(Duration::from_millis(if matches!(reply, Reply::Delay) { 180 } else { 15 + (start % 4) as u64 }));
                                let mut payload = data[start..=end].to_vec();
                                let declared = if matches!(reply, Reply::WrongLength) { payload.len() + 1 } else { payload.len() };
                                if matches!(reply, Reply::Truncated) { payload.pop(); }
                                if matches!(reply, Reply::ExtraBody) { payload.push(0); }
                                let status = if matches!(reply, Reply::Full200) { "200 OK" } else { "206 Partial Content" };
                                let first = if matches!(reply, Reply::WrongRange) { start + 1 } else { start };
                                let validator = match reply {
                                    Reply::ModifiedDate => "Date: Wed, 07 Oct 2026 12:01:00 GMT\r\nLast-Modified: Wed, 07 Oct 2026 12:00:00 GMT\r\n",
                                    Reply::WeakTag => "ETag: W/\"same\"\r\n", Reply::NoValidator => "",
                                    Reply::ChangedTag if start > 0 => "ETag: \"changed\"\r\n", _ => "ETag: \"same\"\r\n",
                                };
                                let length = if matches!(reply, Reply::ExtraBody) { String::new() } else { format!("Content-Length: {declared}\r\n") };
                                let encoding = if matches!(reply, Reply::Encoded) { "Content-Encoding: gzip\r\n" } else { "" };
                                let header = format!("HTTP/1.1 {status}\r\nContent-Range: bytes {first}-{end}/{}\r\n{length}{validator}{encoding}Connection: close\r\n\r\n", data.len());
                                let _ = stream.write_all(header.as_bytes()); let _ = stream.write_all(&payload);
                                count.fetch_sub(1, Ordering::SeqCst);
                            }));
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(1))
                        }
                        Err(_) => break,
                    }
                }
                for child in children {
                    child.join().unwrap();
                }
            });
            Self {
                url: format!("http://{address}/fixed?opaque=unchanged"),
                body,
                stop,
                thread: Some(thread),
                maximum,
                requests,
            }
        }
    }
    impl Drop for Server {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            let _ = TcpStream::connect(
                reqwest::Url::parse(&self.url)
                    .unwrap()
                    .socket_addrs(|| None)
                    .unwrap()[0],
            );
            self.thread.take().unwrap().join().unwrap();
        }
    }
    fn client() -> reqwest::Client {
        reqwest::Client::builder()
            .no_gzip()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap()
    }
    async fn small(server: &Server) -> Result<Vec<u8>, String> {
        download_with_limits(
            &client(),
            &server.url,
            server.body.len(),
            1024,
            Duration::from_secs(2),
            Duration::from_secs(5),
        )
        .await
    }

    #[test]
    fn strict_content_range_and_strong_date_validation() {
        assert!(
            validate_content_range(Some(&HeaderValue::from_static("bytes 0-9/10")), 0, 9, 10)
                .is_ok()
        );
        for value in [
            "bytes 1-9/10",
            "bytes 0-10/10",
            "bytes 0-9/*",
            "bytes 0-9/11",
            "bytes */10",
            "bytes +0-9/10",
            "bytes 0-9/10, 0-9/10",
        ] {
            assert!(
                validate_content_range(Some(&HeaderValue::from_str(value).unwrap()), 0, 9, 10)
                    .is_err()
            );
        }
        let mut h = HeaderMap::new();
        h.insert(
            DATE,
            HeaderValue::from_static("Wed, 07 Oct 2026 12:01:00 GMT"),
        );
        h.insert(
            LAST_MODIFIED,
            HeaderValue::from_static("Wed, 07 Oct 2026 12:00:00 GMT"),
        );
        assert!(strong_validator(&h).is_ok());
        h.insert(
            DATE,
            HeaderValue::from_static("Wed, 07 Oct 2026 12:00:59 GMT"),
        );
        assert!(strong_validator(&h).is_err());
        h.insert(
            DATE,
            HeaderValue::from_static("Wed, 07 Oct 2026 12:01:00 GMT"),
        );
        h.insert(ETAG, HeaderValue::from_static("W/\"weak\""));
        assert!(strong_validator(&h).is_err());
    }

    #[tokio::test]
    async fn local_http_ranges_reassemble_every_byte_out_of_order_with_at_most_four_requests() {
        let server = Server::new(Reply::Valid, 1024 * 9 + 173);
        assert_eq!(small(&server).await.unwrap(), *server.body);
        assert!((2..=4).contains(&server.maximum.load(Ordering::SeqCst)));
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 10);
        assert!(requests.iter().all(
            |r| r.starts_with("GET /fixed?opaque=unchanged HTTP/1.1\r\n")
                && r.to_ascii_lowercase().contains("accept-encoding: identity")
        ));
        assert!(
            requests
                .iter()
                .skip(1)
                .all(|r| r.to_ascii_lowercase().contains("if-range: \"same\""))
        );
    }

    #[tokio::test]
    async fn local_http_old_last_modified_is_a_verified_if_range_validator() {
        let server = Server::new(Reply::ModifiedDate, 3073);
        assert_eq!(small(&server).await.unwrap(), *server.body);
        assert!(server.requests.lock().unwrap().iter().skip(1).all(|r| {
            r.to_ascii_lowercase()
                .contains("if-range: wed, 07 oct 2026 12:00:00 gmt")
        }));
    }

    #[tokio::test]
    async fn local_http_rejects_missing_changed_or_malformed_evidence_and_partial_bodies() {
        for mode in [
            Reply::WeakTag,
            Reply::NoValidator,
            Reply::WrongRange,
            Reply::WrongLength,
            Reply::Truncated,
            Reply::ExtraBody,
            Reply::ChangedTag,
            Reply::Full200,
            Reply::Encoded,
        ] {
            let server = Server::new(mode, 3073);
            let error = small(&server).await.unwrap_err();
            let expected = match mode {
                Reply::WeakTag | Reply::NoValidator => "reference-has-no-strong-validator",
                Reply::WrongRange => "reference-content-range-mismatch",
                Reply::WrongLength => "reference-range-content-length-mismatch",
                Reply::Truncated => "reference-range-body-",
                Reply::ExtraBody => "reference-range-body-too-long",
                Reply::ChangedTag => "reference-validator-changed",
                Reply::Full200 => "reference-range-http-200",
                Reply::Encoded => "reference-encoded-range-not-verifiable",
                _ => unreachable!(),
            };
            assert!(
                error.starts_with(expected),
                "expected {expected}, got {error}"
            );
            assert!(!error.contains("http://") && !error.contains("opaque"));
        }
    }

    #[tokio::test]
    async fn local_http_timeout_and_declared_budget_never_return_a_partial_reference() {
        let server = Server::new(Reply::Delay, 3073);
        assert!(
            download_with_limits(
                &client(),
                &server.url,
                server.body.len(),
                1024,
                Duration::from_millis(30),
                Duration::from_secs(1)
            )
            .await
            .is_err()
        );
        assert!(
            download(&client(), &server.url, MAX_BYTES + 1)
                .await
                .is_err()
        );
        assert!(download(&client(), &server.url, 0).await.is_err());
    }

    /// Explicit network diagnostic; never prints the signed URL or HTTP validators.
    /// MUSIFY_BENCH=1 cargo test --lib capture_reference_cdn_real -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn capture_reference_cdn_real() -> Result<(), String> {
        use sha2::{Digest, Sha256};
        if std::env::var_os("MUSIFY_BENCH").is_none() {
            return Err("benchmark-flag-required".into());
        }
        let id =
            std::env::var("MUSIFY_REFERENCE_VIDEO_ID").unwrap_or_else(|_| "jNY_wLukVW0".into());
        let started = std::time::Instant::now();
        let direct = tokio::time::timeout(
            Duration::from_secs(90),
            crate::native::reference(&id, Some("audio/webm"), None),
        )
        .await
        .map_err(|_| "native-reference-lookup-timeout")?
        .map_err(|_| "native-reference-unavailable")?;
        let length = crate::ytdlp::query_param(&direct.url, "clen")
            .and_then(|n| n.parse().ok())
            .ok_or("reference-clen-missing")?;
        let http = reqwest::Client::builder()
            .no_gzip()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "reference-client-unavailable")?;
        let bytes = download(&http, &direct.url, length).await?;
        eprintln!(
            "{}",
            serde_json::json!({"videoId":id,"itag":direct.itag,"bytes":bytes.len(),"elapsedMs":started.elapsed().as_millis(),"sha256":format!("{:x}",Sha256::digest(&bytes)),"rangeBytes":RANGE_BYTES,"maximumConcurrency":CONCURRENCY,"complete":true})
        );
        Ok(())
    }
}
