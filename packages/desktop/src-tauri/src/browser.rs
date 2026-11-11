//! The side panel's native Browser (epic #193051, spike #193062).
//!
//! WHY A CHILD WEBVIEW AND NOT THE IFRAME. The Browser tab was an <iframe> (#187864). Every major
//! site (Google, YouTube, X, Instagram, LinkedIn, GitHub) sends X-Frame-Options / frame-ancestors,
//! so they could never show, and a framed page is a third-party context, so nobody stays signed
//! in. A child webview is a top-level browsing context: framing headers don't apply, sign-in
//! completes, and cookies persist in the webview's OWN store.
//!
//! THE COST, AND THE GATE THIS FILE EXISTS FOR. A page in a child webview is the webview's MAIN
//! frame, and Tauri injects its IPC bridge and invoke key into every main frame (manager/webview.rs,
//! `main_frame_script`). An iframe never got them; this page does. Plugin commands are still
//! refused for it (their ACL matches origin, and no capability is `remote`). But APP commands are
//! only ACL-checked "if the app defined its ACL manifest" (webview/mod.rs), and this app defines
//! none. Without `ipc_allowed`, youtube.com could call `engine_credentials` and take the local
//! engine's password. So every app command is refused unless it comes from one of OUR webviews,
//! wrapped around the whole invoke handler in lib.rs, not left to each command to remember.
//!
//! STORAGE. The browser's cookies are not the app's: macOS 14+ gets its own WKWebsiteDataStore
//! (`data_store_identifier`), Windows/Linux their own data directory. On macOS 13 and older there
//! is no separate persistent store, so the browser runs `incognito` there rather than sharing the
//! app's jar. Signed-in sessions don't survive a restart on those Macs (epic Q2).

use serde::{Deserialize, Serialize};
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewUrl,
};

/// The browser webview's label. One tab in the spike; S2 makes it `browser-<n>`.
pub const BROWSER_LABEL: &str = "browser";

/// The event the app listens to for the browser's address, title and loading state.
pub const STATE_EVENT: &str = "iris-browser://state";

/// Webviews whose code we wrote. Only these may call app commands (see the module comment).
const OUR_WEBVIEWS: &[&str] = &["main", "iris-login"];

/// May a command from the webview with this label run? Deny by default: a webview we did not
/// list, including every browser tab, gets nothing.
pub fn ipc_allowed(webview_label: &str) -> bool {
    OUR_WEBVIEWS.contains(&webview_label)
}

/// Wrap an invoke handler so only OUR webviews reach it (see the module comment). lib.rs wraps the
/// whole app command list with this; nothing registers a command around it.
pub fn gate<R: tauri::Runtime>(
    handler: impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        let label = invoke.message.webview_ref().label().to_string();
        if !ipc_allowed(&label) {
            eprintln!("ipc: refused '{}' from webview '{label}'", invoke.message.command());
            invoke.resolver.reject("not allowed from this page");
            return true;
        }
        handler(invoke)
    }
}

/// May the browser navigate here? It browses the web, so http(s) anywhere is allowed: the
/// isolation is the protection, not a list of sites. What is refused is everything that is OURS
/// or local-file: the app's own schemes, files on disk, and the engine sidecar's port.
pub fn navigation_allowed(url: &Url, engine_port: Option<u16>) -> bool {
    match url.scheme() {
        "http" | "https" => {}
        "about" => return url.as_str() == "about:blank",
        _ => return false, // tauri:, ipc:, asset:, file:, data:, javascript:, custom schemes
    }
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    // tauri://localhost is served as http(s)://tauri.localhost on Windows and Linux.
    if host == "tauri.localhost" || host.ends_with(".tauri.localhost") {
        return false;
    }
    if let Some(port) = engine_port {
        let loopback = matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]" | "::1");
        if loopback && url.port_or_known_default() == Some(port) {
            return false;
        }
    }
    true
}

/// Address-bar text → a URL, or None. A bare host gets https://. Mirrors `addressToUrl` in
/// packages/app web-nav.ts, so typing behaves the same in both browsers.
pub fn address_to_url(text: &str) -> Option<Url> {
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    let has_scheme = t
        .split_once(':')
        .map(|(s, _)| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c)))
        .unwrap_or(false)
        && !t.starts_with("localhost:");
    let candidate = if has_scheme { t.to_string() } else { format!("https://{t}") };
    let url = Url::parse(&candidate).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let host = url.host_str()?;
    if !host.contains('.') && host != "localhost" {
        return None;
    }
    Some(url)
}

#[derive(Clone, Serialize)]
pub struct BrowserState {
    pub url: String,
    pub title: Option<String>,
    pub loading: bool,
}

/// The panel's body rectangle, in CSS pixels of the app webview, already multiplied by the app's
/// zoom by the caller, so it equals logical window pixels.
#[derive(Deserialize, Clone, Copy)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The page's title, from `on_document_title_changed`: Webview has no title getter in tauri 2.9.
static LAST_TITLE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

fn last_title() -> Option<String> {
    LAST_TITLE.lock().ok().and_then(|t| t.clone())
}

fn browser(app: &AppHandle) -> Option<Webview> {
    app.get_webview(BROWSER_LABEL)
}

fn emit_state(app: &AppHandle, url: &Url, title: Option<String>, loading: bool) {
    let _ = app.emit_to(
        "main",
        STATE_EVENT,
        BrowserState { url: url.to_string(), title, loading },
    );
}

/// A fixed identifier for the browser's macOS data store: the same every launch, so sessions
/// persist; distinct from the app's default store, so the two jars never mix.
#[cfg(target_os = "macos")]
const MACOS_STORE_ID: [u8; 16] = *b"iris-browser-v1\0";

#[cfg(target_os = "macos")]
fn macos_has_data_stores() -> bool {
    // WKWebsiteDataStore(forIdentifier:) is macOS 14+. Read the version the cheap way.
    std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|v| v.trim().split('.').next().and_then(|m| m.parse::<u32>().ok()))
        .map(|major| major >= 14)
        .unwrap_or(false)
}

fn builder(app: &AppHandle, url: Url) -> WebviewBuilder<tauri::Wry> {
    let engine_port = crate::engine_port_hint();
    let nav_app = app.clone();
    let load_app = app.clone();
    let title_app = app.clone();
    let win_app = app.clone();

    #[allow(unused_mut)]
    let mut b = WebviewBuilder::new(BROWSER_LABEL, WebviewUrl::External(url))
        .on_navigation(move |url| {
            let ok = navigation_allowed(url, engine_port);
            if !ok {
                eprintln!("browser: refused navigation to {url}");
                let _ = nav_app.emit_to("main", "iris-browser://refused", url.to_string());
            }
            ok
        })
        .on_page_load(move |_webview, payload| {
            let loading = matches!(payload.event(), PageLoadEvent::Started);
            if loading {
                if let Ok(mut t) = LAST_TITLE.lock() {
                    *t = None;
                }
            }
            emit_state(&load_app, payload.url(), if loading { None } else { last_title() }, loading);
        })
        .on_document_title_changed(move |webview, title| {
            if let Ok(mut t) = LAST_TITLE.lock() {
                *t = Some(title.clone());
            }
            if let Ok(url) = webview.url() {
                emit_state(&title_app, &url, Some(title), false);
            }
        })
        // target=_blank / window.open: open in the same tab (tabs are S2). Never a new webview
        // window: that window would carry no gate of its own.
        .on_new_window(move |url, _features| {
            if navigation_allowed(&url, crate::engine_port_hint()) {
                if let Some(w) = browser(&win_app) {
                    let _ = w.navigate(url);
                }
            }
            NewWindowResponse::Deny
        });

    #[cfg(target_os = "macos")]
    {
        b = if macos_has_data_stores() { b.data_store_identifier(MACOS_STORE_ID) } else { b.incognito(true) };
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Ok(dir) = app.path().app_local_data_dir() {
            b = b.data_directory(dir.join("browser-profile"));
        }
    }
    b
}

/// Show the browser over the panel, creating it on first use. `url` navigates when given.
#[tauri::command]
pub fn browser_show(app: AppHandle, url: Option<String>, bounds: Bounds) -> Result<(), String> {
    let target = match url.as_deref() {
        Some(u) => Some(address_to_url(u).ok_or_else(|| format!("not a web address: {u}"))?),
        None => None,
    };
    if let Some(t) = &target {
        if !navigation_allowed(t, crate::engine_port_hint()) {
            return Err(format!("refused: {t} is not a page the browser opens"));
        }
    }
    let pos = LogicalPosition::new(bounds.x, bounds.y);
    let size = LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0));
    if let Some(w) = browser(&app) {
        w.set_position(pos).map_err(|e| e.to_string())?;
        w.set_size(size).map_err(|e| e.to_string())?;
        if let Some(t) = target {
            w.navigate(t).map_err(|e| e.to_string())?;
        }
        return w.show().map_err(|e| e.to_string());
    }
    let window = app.get_window("main").ok_or("no main window")?;
    let start = target.unwrap_or_else(|| Url::parse("about:blank").expect("static url"));
    window
        .add_child(builder(&app, start), pos, size)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Follow the panel: called on resize, on a rAF, while the Browser tab is visible.
#[tauri::command]
pub fn browser_bounds(app: AppHandle, bounds: Bounds) -> Result<(), String> {
    let Some(w) = browser(&app) else { return Ok(()) };
    w.set_position(LogicalPosition::new(bounds.x, bounds.y)).map_err(|e| e.to_string())?;
    w.set_size(LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0))).map_err(|e| e.to_string())
}

/// Hide, never destroy: leaving the tab and coming back keeps the page (the `webMounted` rule).
/// Also called whenever an overlay opens over the panel (the native view draws above the DOM).
#[tauri::command]
pub fn browser_hide(app: AppHandle) -> Result<(), String> {
    match browser(&app) {
        Some(w) => w.hide().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

#[tauri::command]
pub fn browser_navigate(app: AppHandle, url: String) -> Result<String, String> {
    let target = address_to_url(&url).ok_or_else(|| format!("not a web address: {url}"))?;
    if !navigation_allowed(&target, crate::engine_port_hint()) {
        return Err(format!("refused: {target} is not a page the browser opens"));
    }
    let w = browser(&app).ok_or("the browser is not open")?;
    w.navigate(target.clone()).map_err(|e| e.to_string())?;
    Ok(target.to_string())
}

/// back | forward | reload. History lives in the page, so back/forward are the page's own.
#[tauri::command]
pub fn browser_go(app: AppHandle, action: String) -> Result<(), String> {
    let w = browser(&app).ok_or("the browser is not open")?;
    match action.as_str() {
        "back" => w.eval("history.back()").map_err(|e| e.to_string()),
        "forward" => w.eval("history.forward()").map_err(|e| e.to_string()),
        "reload" => w.reload().map_err(|e| e.to_string()),
        other => Err(format!("unknown action: {other}")),
    }
}

/// Where the browser really is: the address bar polls this, because a single-page app's
/// pushState fires no page-load event.
#[tauri::command]
pub fn browser_state(app: AppHandle) -> Option<BrowserState> {
    let w = browser(&app)?;
    let url = w.url().ok()?;
    Some(BrowserState { title: last_title(), url: url.to_string(), loading: false })
}

/// Run one of the engine's page scripts in the pane and return its result (#193145). Only the
/// app calls this (the gate refuses every other webview), and only after the person granted the
/// page's site: that check lives in the app, beside the button that grants it.
#[tauri::command]
pub async fn browser_eval(app: AppHandle, script: String) -> Result<String, String> {
    let w = browser(&app).ok_or("the Browser isn't open: open a page in it first")?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let js = crate::browser_eval::wrap(&script);
    w.with_webview(move |pw| crate::browser_eval::start(pw, js, tx)).map_err(|e| e.to_string())?;
    match tokio::time::timeout(std::time::Duration::from_secs(10), rx).await {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => Err("the page did not answer".into()),
        Err(_) => Err("the page took longer than 10 s to answer".into()),
    }
}

/// The sites this browser holds cookies for: the start of Settings › Browser (S3). Names and
/// domains only, never values: values are credentials and never cross into the app's JS.
#[tauri::command]
pub fn browser_cookie_domains(app: AppHandle) -> Result<Vec<String>, String> {
    let w = browser(&app).ok_or("the browser is not open")?;
    let mut domains: Vec<String> = w
        .cookies()
        .map_err(|e| e.to_string())?
        .iter()
        .filter_map(|c| c.domain().map(|d| d.trim_start_matches('.').to_string()))
        .collect();
    domains.sort();
    domains.dedup();
    Ok(domains)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn only_our_webviews_may_call_app_commands() {
        assert!(ipc_allowed("main"));
        assert!(ipc_allowed("iris-login"));
        assert!(!ipc_allowed(BROWSER_LABEL));
        assert!(!ipc_allowed("browser-2"));
        assert!(!ipc_allowed(""));
        assert!(!ipc_allowed("Main"));
    }

    #[test]
    fn any_web_page_is_allowed() {
        for s in [
            "https://www.youtube.com/watch?v=x",
            "https://x.com/home",
            "https://accounts.google.com/signin",
            "http://example.com",
            "http://localhost:3000/",
            "about:blank",
        ] {
            assert!(navigation_allowed(&u(s), Some(4096)), "{s} should be allowed");
        }
    }

    #[test]
    fn our_own_surfaces_and_files_are_refused() {
        for s in [
            "tauri://localhost/",
            "http://tauri.localhost/",
            "https://tauri.localhost/index.html",
            "ipc://localhost/engine_credentials",
            "asset://localhost/etc/passwd",
            "file:///etc/passwd",
            "data:text/html,<script>alert(1)</script>",
            "javascript:alert(1)",
            "http://127.0.0.1:4096/session",
            "http://localhost:4096/",
            "about:config",
        ] {
            assert!(!navigation_allowed(&u(s), Some(4096)), "{s} should be refused");
        }
    }

    #[test]
    fn the_address_bar_adds_https_and_refuses_non_web() {
        assert_eq!(address_to_url("youtube.com").unwrap().as_str(), "https://youtube.com/");
        assert_eq!(address_to_url(" x.com/home ").unwrap().as_str(), "https://x.com/home");
        assert_eq!(address_to_url("localhost:3000").unwrap().as_str(), "https://localhost:3000/");
        assert_eq!(address_to_url("http://example.com").unwrap().as_str(), "http://example.com/");
        assert!(address_to_url("").is_none());
        assert!(address_to_url("hello").is_none());
        assert!(address_to_url("file:///etc/passwd").is_none());
        assert!(address_to_url("javascript:alert(1)").is_none());
    }

    /// The isolation test (#193062), through Tauri's real IPC path on the mock runtime. A web page
    /// in the browser webview has the invoke key (it is the main frame), so this sends exactly what
    /// youtube.com could send. Red first: with `gate` removed, the "browser" call returns the secret.
    mod ipc {
        use super::super::*;
        use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
        use tauri::webview::InvokeRequest;
        use tauri::WebviewWindowBuilder;

        #[tauri::command]
        fn engine_secret() -> String {
            "s3cret".into()
        }

        fn request(origin: &str) -> InvokeRequest {
            InvokeRequest {
                cmd: "engine_secret".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: origin.parse().unwrap(),
                body: tauri::ipc::InvokeBody::default(),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            }
        }

        fn app() -> tauri::App<tauri::test::MockRuntime> {
            mock_builder()
                .invoke_handler(gate(tauri::generate_handler![engine_secret]))
                .build(mock_context(noop_assets()))
                .expect("mock app")
        }

        #[test]
        fn a_web_page_in_the_browser_cannot_call_an_app_command() {
            let app = app();
            let page = WebviewWindowBuilder::new(&app, BROWSER_LABEL, Default::default()).build().unwrap();
            let got = get_ipc_response(&page, request("https://www.youtube.com"));
            assert!(got.is_err(), "the browser page got an answer: {got:?}");
        }

        #[test]
        fn our_own_window_still_can() {
            let app = app();
            let main = WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
            let got = get_ipc_response(&main, request("tauri://localhost"));
            assert_eq!(got.unwrap().deserialize::<String>().unwrap(), "s3cret");
        }
    }
}
