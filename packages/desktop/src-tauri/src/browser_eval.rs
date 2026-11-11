//! Run a script in the Browser pane and get its RESULT back (#193145, epic #193144).
//!
//! Tauri 2.9's `Webview::eval` returns nothing, so each platform's own "evaluate and give me the
//! value" call is wrapped here, behind `with_webview`. Each one mirrors wry 0.53.5's own
//! `eval(js, Some(callback))` for that platform (wkwebview / webview2 / webkitgtk mod.rs).
//!
//! WHY NOT A MESSAGE FROM THE PAGE. The pane has no IPC (`browser::gate`), and must not get any:
//! a result channel the page can reach is one a hostile page can write to whenever it likes. The
//! value comes back through the engine's own evaluate callback, to Rust, to the app.
//!
//! The script is wrapped so it always answers with ONE JSON string, `{ok, value}` or
//! `{ok:false, error}`. Each platform hands that string back in its own encoding (macOS and
//! Windows: JSON of the value, i.e. a quoted string; Linux: the JSON of the value too), and
//! `unwrap_result` turns all three into the envelope text.

use tokio::sync::oneshot;

pub type Reply = oneshot::Sender<Result<String, String>>;

/// The page side: run `expression`, answer with one JSON string, never throw.
pub fn wrap(expression: &str) -> String {
    format!(
        "(() => {{ try {{ const v = ({expression}); return JSON.stringify({{ ok: true, value: v === undefined ? null : v }}) }} catch (e) {{ return JSON.stringify({{ ok: false, error: String((e && e.message) || e) }}) }} }})()"
    )
}

/// The platform's JSON-of-the-value → the envelope text the wrapper produced.
pub fn unwrap_result(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() || raw == "null" || raw == "undefined" {
        return Err("the page returned nothing (it may still be loading)".into());
    }
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(serde_json::Value::String(s)) => Ok(s),
        Ok(other) => Ok(other.to_string()),
        Err(_) => Ok(raw.to_string()),
    }
}

fn answer(tx: &std::sync::Mutex<Option<Reply>>, r: Result<String, String>) {
    if let Some(tx) = tx.lock().ok().and_then(|mut t| t.take()) {
        let _ = tx.send(r.and_then(|raw| unwrap_result(&raw)));
    }
}

/// Start the evaluation. Called on the main thread by `with_webview`; `tx` is answered later,
/// from the platform's callback, exactly once.
#[cfg(target_os = "macos")]
pub fn start(pw: tauri::webview::PlatformWebview, js: String, tx: Reply) {
    use objc2::{runtime::AnyObject, AllocAnyThread};
    use objc2_foundation::{NSError, NSJSONSerialization, NSString, NSUTF8StringEncoding};
    use objc2_web_kit::WKWebView;

    let tx = std::sync::Mutex::new(Some(tx));
    // Safety: objc runtime calls, on the main thread (`with_webview` runs there), as wry does.
    unsafe {
        let handler = block2::RcBlock::new(move |val: *mut AnyObject, _err: *mut NSError| {
            if val.is_null() {
                return answer(&tx, Err("the script raised before it could answer".into()));
            }
            let json = NSJSONSerialization::dataWithJSONObject_options_error(
                &*val,
                objc2_foundation::NSJSONWritingOptions::FragmentsAllowed,
            );
            let out = match json {
                Ok(data) => NSString::initWithData_encoding(NSString::alloc(), &data, NSUTF8StringEncoding)
                    .map(|s| s.to_string())
                    .ok_or_else(|| "the result was not text".to_string()),
                Err(_) => Err("the result could not be read".to_string()),
            };
            answer(&tx, out);
        });
        let webview: &WKWebView = &*(pw.inner() as *const WKWebView);
        webview.evaluateJavaScript_completionHandler(&NSString::from_str(&js), Some(&handler));
    }
}

#[cfg(windows)]
pub fn start(pw: tauri::webview::PlatformWebview, js: String, tx: Reply) {
    use webview2_com::ExecuteScriptCompletedHandler;
    use windows::core::HSTRING;

    let tx = std::sync::Mutex::new(Some(tx));
    let run = || -> windows::core::Result<()> {
        let webview = unsafe { pw.controller().CoreWebView2()? };
        let js = HSTRING::from(js.as_str());
        unsafe {
            webview.ExecuteScript(
                &js,
                &ExecuteScriptCompletedHandler::create(Box::new(move |_, res| {
                    answer(&tx, Ok(res));
                    Ok(())
                })),
            )
        }
    };
    if let Err(e) = run() {
        eprintln!("browser_eval: ExecuteScript failed: {e}");
    }
}

#[cfg(target_os = "linux")]
pub fn start(pw: tauri::webview::PlatformWebview, js: String, tx: Reply) {
    use javascriptcore::ValueExt;
    use webkit2gtk::{gio::Cancellable, WebViewExt};

    let tx = std::sync::Mutex::new(Some(tx));
    let cancellable: Option<&Cancellable> = None;
    pw.inner().run_javascript(&js, cancellable, move |result| {
        let out = result
            .map_err(|e| e.to_string())
            .and_then(|r| r.js_value().and_then(|v| v.to_json(0)).map(|g| g.to_string()).ok_or_else(|| "no value".to_string()));
        answer(&tx, out);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wrapper_always_answers_with_one_json_string() {
        let w = wrap("document.title");
        assert!(w.contains("JSON.stringify({ ok: true"));
        assert!(w.contains("ok: false"));
        assert!(w.starts_with("(() => {") && w.ends_with("})()"));
    }

    #[test]
    fn every_platform_encoding_becomes_the_envelope() {
        let env = r#"{"ok":true,"value":"hi"}"#;
        // macOS / Windows / Linux: JSON of a string value → a quoted string.
        assert_eq!(unwrap_result(&serde_json::to_string(env).unwrap()).unwrap(), env);
        // Already the envelope (defensive).
        assert_eq!(unwrap_result(env).unwrap(), env);
        assert!(unwrap_result("").is_err());
        assert!(unwrap_result("null").is_err());
    }
}

/// A picture of what the Browser shows (the agent's eyes on a map, a chart, a canvas). macOS:
/// WKWebView's own snapshot, 1024 px wide, as JPEG, base64. Other platforms: not yet.
#[cfg(target_os = "macos")]
pub fn snapshot(pw: tauri::webview::PlatformWebview, tx: Reply) {
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError, NSNumber};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};

    let tx = std::sync::Mutex::new(Some(tx));
    // Safety: objc runtime calls on the main thread (`with_webview` runs there).
    unsafe {
        let handler = block2::RcBlock::new(move |img: *mut NSImage, _err: *mut NSError| {
            if img.is_null() {
                return answer(&tx, Err("the Browser could not take a picture of the page".into()));
            }
            let out = (|| {
                let tiff = (*img).TIFFRepresentation()?;
                let rep = NSBitmapImageRep::imageRepWithData(&tiff)?;
                let props = NSDictionary::new();
                let jpeg = rep.representationUsingType_properties(NSBitmapImageFileType::JPEG, &props)?;
                Some(base64::Engine::encode(&base64::engine::general_purpose::STANDARD, jpeg.to_vec()))
            })();
            answer(&tx, out.ok_or_else(|| "the picture could not be encoded".to_string()));
        });
        // with_webview runs this on the main thread.
        let mtm = objc2::MainThreadMarker::new_unchecked();
        let config = WKSnapshotConfiguration::new(mtm);
        config.setSnapshotWidth(Some(&NSNumber::new_f64(1024.0)));
        let webview: &WKWebView = &*(pw.inner() as *const WKWebView);
        webview.takeSnapshotWithConfiguration_completionHandler(Some(&config), &handler);
    }
}

#[cfg(not(target_os = "macos"))]
pub fn snapshot(_pw: tauri::webview::PlatformWebview, tx: Reply) {
    let _ = tx.send(Err("pictures of the Browser pane work on macOS for now: use read or find".into()));
}
