//! BENCH-only observation of the desktop audio WebView's network timings.
//! This does not fetch, intercept, modify, or authorize any media response.

pub(crate) fn init(app: &tauri::AppHandle) {
    #[cfg(windows)]
    if std::env::var_os("MUSIFY_BENCH").is_some() {
        observer::init(app);
    }
    #[cfg(not(windows))]
    let _ = app;
}

#[cfg(any(windows, test))]
mod observer {
    use serde::Serialize;
    use serde_json::Value;

    const MAX_EVENT_BYTES: usize = 256 * 1024;

    #[derive(Debug, Serialize, PartialEq)]
    #[serde(rename_all = "lowercase")]
    enum Protocol { Http10, Http11, H2, H3, Other }

    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Timing {
        // CDP's monotonic origin, in seconds. Remaining fields are offsets in ms.
        request_time_seconds: Option<f64>,
        dns_start_ms: Option<f64>,
        dns_end_ms: Option<f64>,
        connect_start_ms: Option<f64>,
        connect_end_ms: Option<f64>,
        ssl_start_ms: Option<f64>,
        ssl_end_ms: Option<f64>,
        send_start_ms: Option<f64>,
        send_end_ms: Option<f64>,
        receive_headers_start_ms: Option<f64>,
        receive_headers_end_ms: Option<f64>,
    }

    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Response {
        phase: &'static str,
        timestamp_seconds: Option<f64>,
        protocol: Protocol,
        status: u16,
        connection_reused: Option<bool>,
        from_disk_cache: Option<bool>,
        from_service_worker: Option<bool>,
        timing: Option<Timing>,
    }

    fn number(value: &Value, min: f64, max: f64) -> Option<f64> {
        value.as_f64().filter(|n| n.is_finite() && *n >= min && *n <= max)
    }

    fn audio_origin(url: &str) -> bool {
        if url.len() > 16 * 1024 { return false; }
        let Ok(url) = reqwest::Url::parse(url) else { return false; };
        let Some(host) = url.host_str() else { return false; };
        url.scheme() == "https" && url.port_or_known_default() == Some(443)
            && url.username().is_empty() && url.password().is_none()
            && url.fragment().is_none() && url.path() == "/videoplayback"
            && host.len() <= 253 && host.ends_with(".googlevideo.com")
            && host.bytes().all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
    }

    fn response(value: &Value) -> Option<Response> {
        if value["type"].as_str()? != "Media" { return None; }
        let raw = value.get("response")?.as_object()?;
        if !audio_origin(raw.get("url")?.as_str()?) { return None; }
        let status = number(raw.get("status")?, 100.0, 599.0)?;
        if status.fract() != 0.0 { return None; }
        let protocol = match raw.get("protocol").and_then(Value::as_str) {
            Some("http/1.0") => Protocol::Http10,
            Some("http/1.1") => Protocol::Http11,
            Some("h2") => Protocol::H2,
            Some("h3") => Protocol::H3,
            _ => Protocol::Other,
        };
        let timing = raw.get("timing").filter(|v| v.is_object()).map(|t| {
            // -1 is CDP's unavailable/not-applicable sentinel, never zero-filled.
            let offset = |key: &str| number(&t[key], -1.0, 86_400_000.0);
            Timing {
                request_time_seconds: number(&t["requestTime"], 0.0, 1e12),
                dns_start_ms: offset("dnsStart"), dns_end_ms: offset("dnsEnd"),
                connect_start_ms: offset("connectStart"), connect_end_ms: offset("connectEnd"),
                ssl_start_ms: offset("sslStart"), ssl_end_ms: offset("sslEnd"),
                send_start_ms: offset("sendStart"), send_end_ms: offset("sendEnd"),
                receive_headers_start_ms: offset("receiveHeadersStart"),
                receive_headers_end_ms: offset("receiveHeadersEnd"),
            }
        });
        Some(Response {
            phase: "response", timestamp_seconds: number(&value["timestamp"], 0.0, 1e12),
            protocol, status: status as u16,
            connection_reused: raw.get("connectionReused").and_then(Value::as_bool),
            from_disk_cache: raw.get("fromDiskCache").and_then(Value::as_bool),
            from_service_worker: raw.get("fromServiceWorker").and_then(Value::as_bool),
            timing,
        })
    }

    fn parse_response(text: &str) -> Option<Response> {
        if text.len() > MAX_EVENT_BYTES { return None; }
        response(&serde_json::from_str::<Value>(text).ok()?)
    }

    #[cfg(windows)]
    mod windows {
        use super::*;
        use std::cell::RefCell;
        use tauri::Manager;
        use webview2_com::{CallDevToolsProtocolMethodCompletedHandler,
            DevToolsProtocolEventReceivedEventHandler, take_pwstr};
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2DevToolsProtocolEventReceiver;
        use windows_core::{HSTRING, PWSTR};

        // COM objects remain on the WebView's UI thread for the window lifetime.
        struct Subscription { receiver: ICoreWebView2DevToolsProtocolEventReceiver, token: i64 }
        impl Drop for Subscription {
            fn drop(&mut self) {
                let _ = unsafe { self.receiver.remove_DevToolsProtocolEventReceived(self.token) };
            }
        }
        thread_local! {
            static SUBSCRIPTION: RefCell<Option<Subscription>> = const { RefCell::new(None) };
        }

        fn emit(value: &impl Serialize) {
            if let Ok(text) = serde_json::to_string(value) {
                use std::io::Write;
                let _ = writeln!(std::io::stderr().lock(), "[playback-network] {text}");
            }
        }

        #[derive(Serialize)]
        #[serde(rename_all = "kebab-case")]
        enum Failure { Window, Dispatch, Core, Receiver, Subscribe, EnableCall, EnableResult, EventRead }

        fn failed(code: Failure) {
            emit(&serde_json::json!({"phase":"observer-error","code":code}));
        }

        pub(super) fn init(app: &tauri::AppHandle) {
            let Some(window) = app.get_webview_window("main") else {
                failed(Failure::Window); return;
            };
            if window.with_webview(|platform| {
                if SUBSCRIPTION.with(|slot| slot.borrow().is_some()) { return; }
                unsafe {
                    let Ok(core) = platform.controller().CoreWebView2() else {
                        failed(Failure::Core); return;
                    };
                    let Ok(receiver) = core.GetDevToolsProtocolEventReceiver(
                        &HSTRING::from("Network.responseReceived"),
                    ) else { failed(Failure::Receiver); return; };
                    let handler = DevToolsProtocolEventReceivedEventHandler::create(Box::new(|_, args| {
                        let Some(args) = args else { return Ok(()); };
                        let mut text = PWSTR::null();
                        if args.ParameterObjectAsJson(&mut text).is_err() {
                            failed(Failure::EventRead); return Ok(());
                        }
                        // Never log the CDP payload: it contains signed URLs and headers.
                        let text = take_pwstr(text);
                        if let Some(record) = parse_response(&text) { emit(&record); }
                        Ok(())
                    }));
                    let mut token = 0_i64;
                    if receiver.add_DevToolsProtocolEventReceived(&handler, &mut token).is_err() {
                        failed(Failure::Subscribe); return;
                    }
                    SUBSCRIPTION.with(|slot| *slot.borrow_mut() = Some(Subscription { receiver, token }));
                    let callback = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|result, _| {
                        if result.is_ok() {
                            emit(&serde_json::json!({"phase":"observer-installed"}));
                        } else {
                            SUBSCRIPTION.with(|slot| { slot.borrow_mut().take(); });
                            failed(Failure::EnableResult);
                        }
                        Ok(())
                    }));
                    // Observation only. No cache overrides, interception, headers or requests.
                    if core.CallDevToolsProtocolMethod(&HSTRING::from("Network.enable"),
                        &HSTRING::from("{}"), &callback).is_err()
                    {
                        SUBSCRIPTION.with(|slot| { slot.borrow_mut().take(); });
                        failed(Failure::EnableCall);
                    }
                }
            }).is_err() { failed(Failure::Dispatch); }
        }
    }

    #[cfg(windows)]
    pub(super) fn init(app: &tauri::AppHandle) { windows::init(app); }

    #[cfg(test)]
    mod tests {
        use super::*;
        use serde_json::json;

        fn fixture() -> Value {
            json!({"type":"Media","timestamp":12345.5,"requestId":"do-not-log-request",
                "response":{"url":"https://rr3---sn-abc.googlevideo.com/videoplayback?sig=do-not-log-signature",
                    "status":206,"protocol":"h2","connectionReused":true,"fromDiskCache":false,
                    "fromServiceWorker":false,"remoteIPAddress":"do-not-log-address",
                    "headers":{"Set-Cookie":"do-not-log-cookie"},"connectionId":98765,
                    "timing":{"requestTime":12345.0,"dnsStart":-1,"dnsEnd":-1,
                        "connectStart":-1,"connectEnd":-1,"sslStart":-1,"sslEnd":-1,
                        "sendStart":0.2,"sendEnd":0.3,"receiveHeadersStart":22.0,"receiveHeadersEnd":22.5,
                        "remote":"do-not-log-timing"}}})
        }

        #[test]
        fn only_closed_media_response_fields_survive() {
            let parsed = parse_response(&fixture().to_string()).unwrap();
            let safe = serde_json::to_value(parsed).unwrap();
            assert_eq!(safe["protocol"], "h2");
            assert_eq!(safe["status"], 206);
            assert_eq!(safe["connectionReused"], true);
            assert_eq!(safe["timing"]["connectStartMs"], -1.0);
            assert_eq!(safe["timing"]["receiveHeadersEndMs"], 22.5);
            let mut keys: Vec<_> = safe.as_object().unwrap().keys().map(String::as_str).collect();
            keys.sort_unstable();
            assert_eq!(keys, ["connectionReused", "fromDiskCache", "fromServiceWorker", "phase",
                "protocol", "status", "timestampSeconds", "timing"]);
            let text = safe.to_string();
            for excluded in ["do-not-log", "requestId", "connectionId", "headers\"", "url\"", "googlevideo", "98765"] {
                assert!(!text.contains(excluded), "{excluded}");
            }
        }

        #[test]
        fn rejects_non_media_or_untrusted_origins_and_statuses() {
            let mut value = fixture();
            for kind in ["Fetch", "XHR", "Document", "Other", "media", "Media\nprivate"] {
                value["type"] = json!(kind);
                assert!(response(&value).is_none());
            }
            value["type"] = json!("Media");
            for url in ["http://r1.googlevideo.com/videoplayback", "https://googlevideo.com/videoplayback",
                "https://evilgooglevideo.com/videoplayback", "https://r1.googlevideo.com.evil.invalid/videoplayback",
                "https://r1.googlevideo.com:8443/videoplayback", "https://user:secret@r1.googlevideo.com/videoplayback",
                "https://r1.googlevideo.com/videoplayback#secret", "https://r1.googlevideo.com/other"]
            {
                value["response"]["url"] = json!(url);
                assert!(response(&value).is_none());
            }
            value = fixture();
            for status in [json!("206\nsecret"), json!(206.5), json!(99), json!(600), Value::Null] {
                value["response"]["status"] = status;
                assert!(response(&value).is_none());
            }
        }

        #[test]
        fn missing_or_malformed_timing_never_becomes_zero_or_remote_text() {
            let mut value = fixture();
            value["response"]["protocol"] = json!("h3\nprivate-token");
            value["response"]["connectionReused"] = json!("private-token");
            value["response"]["fromDiskCache"] = Value::Null;
            value["response"]["timing"]["dnsStart"] = json!(-2);
            value["response"]["timing"]["dnsEnd"] = json!("private-token");
            value["response"]["timing"]["connectEnd"] = json!(1e20);
            let safe = serde_json::to_value(response(&value).unwrap()).unwrap();
            assert_eq!(safe["protocol"], "other");
            assert!(safe["connectionReused"].is_null() && safe["fromDiskCache"].is_null());
            for key in ["dnsStartMs", "dnsEndMs", "connectEndMs"] { assert!(safe["timing"][key].is_null()); }
            assert!(!safe.to_string().contains("private-token"));
            value["response"].as_object_mut().unwrap().remove("timing");
            assert!(response(&value).unwrap().timing.is_none());
            assert!(parse_response("not-json-private").is_none());
            assert!(parse_response(&" ".repeat(MAX_EVENT_BYTES + 1)).is_none());
        }
    }
}
