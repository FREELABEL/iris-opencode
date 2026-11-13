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

/// ONE PAGE PER CHAT (2026-11-11: one shared page meant a chat that changed the page changed it
/// in every chat). Each chat's Browser is its own webview, `browser-<chat id>`. They share ONE
/// cookie store (the same data store), so a site signed in once is signed in in every chat.
pub const BROWSER_PREFIX: &str = "browser-";
/// The hidden webview Sign in with Chrome writes through when no chat has opened its Browser yet.
pub const SIGNIN_LABEL: &str = "browser-signin";
/// Pages kept live at once, across every chat and tab. Each is a WebKit process (~100 MB); past
/// this the page used longest ago is closed, and reopens on the address it was on.
const MAX_LIVE: usize = 8;

/// A page key → its Browser's label. A chat's first tab is the chat id ("ses_…": letters, digits,
/// _ and -); its other tabs are "<chat id>:<tab>" (#193328), the tab a short [a-z0-9] id.
pub fn label_for(chat: &str) -> Result<String, String> {
    let id_ok = |s: &str, max: usize| {
        !s.is_empty() && s.len() <= max && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    };
    let ok = match chat.split_once(':') {
        Some((c, t)) => {
            id_ok(c, 64) && c != "signin" && !t.is_empty() && t.len() <= 8 && t.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        }
        None => id_ok(chat, 64) && chat != "signin",
    };
    if !ok {
        return Err(format!("not a chat id: {chat}"));
    }
    Ok(format!("{BROWSER_PREFIX}{chat}"))
}

/// Whether a link that asks for a new window is a sign-in pop-up, which stays in its own tab: the
/// sign-in finishes by coming back to the page that opened it (Google Sign in, 2026-11-11).
pub fn opens_in_same_tab(url: &Url) -> bool {
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    const SIGN_IN_HOSTS: [&str; 6] =
        ["accounts.google.com", "appleid.apple.com", "login.microsoftonline.com", "login.live.com", "auth0.com", "okta.com"];
    if SIGN_IN_HOSTS.iter().any(|h| host == *h || host.ends_with(&format!(".{h}"))) {
        return true;
    }
    let path = url.path().to_ascii_lowercase();
    ["/oauth", "/authorize", "/signin", "/sign-in", "/login", "/sso", "/dialog/oauth"].iter().any(|p| path.contains(p))
}

/// The event the app hears when a page asks for a new window: it opens a tab (#193328).
pub const NEW_TAB_EVENT: &str = "iris-browser://new-tab";

/// Which live pages to close so that `keep` fits under `max`: never `keep`; pages no chat has used
/// first, then the least recently used (`recent` is newest first).
pub fn to_close(live: &[String], recent: &[String], keep: &str, max: usize) -> Vec<String> {
    let mut others: Vec<&String> = live.iter().filter(|l| l.as_str() != keep).collect();
    let fits = max.saturating_sub(1);
    if others.len() <= fits {
        return vec![];
    }
    // oldest first: unknown (usize::MAX) before the oldest known
    others.sort_by_key(|l| std::cmp::Reverse(recent.iter().position(|r| r == *l).unwrap_or(usize::MAX)));
    others.iter().take(others.len() - fits).map(|l| l.to_string()).collect()
}

#[derive(Clone, serde::Serialize)]
struct NewTab {
    chat: String,
    url: String,
}

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
    /// Which chat's page this is.
    pub chat: String,
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

/// Per page: its title (Webview has no title getter in tauri 2.9), the last address it loaded
/// (to reopen a closed page where it was), and which pages were used most recently.
#[derive(Default)]
struct Tabs {
    titles: std::collections::HashMap<String, String>,
    urls: std::collections::HashMap<String, Url>,
    recent: Vec<String>,
}
static TABS: std::sync::LazyLock<std::sync::Mutex<Tabs>> = std::sync::LazyLock::new(Default::default);

/// Per page: the newest bounds call applied (#193405). Each `invoke` is its own IPC request and
/// nothing promises they land in the order sent, so a mid-resize rect could land after the
/// final one and stay. The app numbers every placement; an older one than the newest applied is
/// dropped. `show` always applies and resets the count: a reloaded app starts again from 1.
static PLACED: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, u64>>> =
    std::sync::LazyLock::new(Default::default);

/// Whether a placement numbered `seq` should apply. No number (an older app): always.
fn admit(newest: &mut std::collections::HashMap<String, u64>, label: &str, seq: Option<u64>, show: bool) -> bool {
    let Some(seq) = seq else { return true };
    if !show && newest.get(label).is_some_and(|&n| seq <= n) {
        return false;
    }
    newest.insert(label.to_string(), seq);
    true
}
fn admit_placement(label: &str, seq: Option<u64>, show: bool) -> bool {
    PLACED.lock().map(|mut m| admit(&mut m, label, seq, show)).unwrap_or(true)
}

fn with_tabs<T>(f: impl FnOnce(&mut Tabs) -> T) -> Option<T> {
    TABS.lock().ok().map(|mut t| f(&mut t))
}
fn title_of(label: &str) -> Option<String> {
    with_tabs(|t| t.titles.get(label).cloned()).flatten()
}
fn touch(label: &str) {
    with_tabs(|t| {
        t.recent.retain(|l| l != label);
        t.recent.insert(0, label.to_string());
    });
}

/// Sign-ins brought in from Chrome, kept for pages opened later where the cookie store is per page
/// (macOS 13: no named data stores). Elsewhere every page shares the store and this stays empty.
static IMPORTED: std::sync::Mutex<Vec<tauri::webview::Cookie<'static>>> = std::sync::Mutex::new(Vec::new());
pub fn remember_imported(cookies: &[tauri::webview::Cookie<'static>]) {
    if !store_is_persistent() {
        if let Ok(mut v) = IMPORTED.lock() {
            v.extend_from_slice(cookies);
        }
    }
}

fn browser(app: &AppHandle, chat: &str) -> Result<Option<Webview>, String> {
    Ok(app.get_webview(&label_for(chat)?))
}
fn browser_pages(app: &AppHandle) -> Vec<Webview> {
    app.webviews().into_iter().filter(|(l, _)| l.starts_with(BROWSER_PREFIX)).map(|(_, w)| w).collect()
}

fn emit_state(app: &AppHandle, label: &str, url: &Url, title: Option<String>, loading: bool) {
    let _ = app.emit_to(
        "main",
        STATE_EVENT,
        BrowserState { chat: label.trim_start_matches(BROWSER_PREFIX).to_string(), url: url.to_string(), title, loading },
    );
}

/// A fixed identifier for the browser's macOS data store: the same every launch, so sessions
/// persist; distinct from the app's default store, so the two jars never mix.
#[cfg(target_os = "macos")]
const MACOS_STORE_ID: [u8; 16] = *b"iris-browser-v1\0";

/// Whether the Browser's cookies survive a quit (macOS 13 has no named data stores).
pub fn store_is_persistent() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos_has_data_stores()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

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

/// What the Browser tells sites it is: Safari, which it is (Safari's own engine). Left alone, the
/// macOS web view sends Safari's string MINUS "Version/x Safari/605.1.15", which bot checks
/// (Cloudflare on indeed.com, 2026-11-11) read as "not a browser" and answer with a challenge
/// that never finishes. Built from this Mac's real Safari version, so it stays true as Safari
/// updates. The platform part is frozen by Apple ("Intel Mac OS X 10_15_7" on every Mac).
pub fn safari_user_agent_for(version: &str) -> Option<String> {
    let v = version.trim();
    let ok = !v.is_empty() && v.split('.').count() <= 3 && v.split('.').all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
    ok.then(|| {
        format!("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/{v} Safari/605.1.15")
    })
}

#[cfg(target_os = "macos")]
fn safari_user_agent() -> Option<String> {
    static UA: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    UA.get_or_init(|| {
        let out = std::process::Command::new("/usr/bin/defaults")
            .args(["read", "/Applications/Safari.app/Contents/Info", "CFBundleShortVersionString"])
            .output()
            .ok()?;
        safari_user_agent_for(&String::from_utf8(out.stdout).ok()?)
    })
    .clone()
}

fn builder(app: &AppHandle, label: &str, url: Url) -> WebviewBuilder<tauri::Wry> {
    let engine_port = crate::engine_port_hint();
    let nav_app = app.clone();
    let load_app = app.clone();
    let title_app = app.clone();
    let win_app = app.clone();
    let (load_label, title_label, win_label) = (label.to_string(), label.to_string(), label.to_string());

    #[allow(unused_mut)]
    let mut b = WebviewBuilder::new(label, WebviewUrl::External(url))
        // A form that POSTs into a new window submits in this tab, so its data survives (#193441).
        .initialization_script(include_str!("browser_page.js"))
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
            with_tabs(|t| {
                if loading {
                    t.titles.remove(&load_label);
                } else if payload.url().scheme() != "about" {
                    t.urls.insert(load_label.clone(), payload.url().clone());
                }
            });
            emit_state(&load_app, &load_label, payload.url(), if loading { None } else { title_of(&load_label) }, loading);
        })
        .on_document_title_changed(move |webview, title| {
            with_tabs(|t| t.titles.insert(title_label.clone(), title.clone()));
            if let Ok(url) = webview.url() {
                emit_state(&title_app, &title_label, &url, Some(title), false);
            }
        })
        // target=_blank / window.open: a new TAB in the same chat (#193328), opened by the app so
        // it carries the same gates; a sign-in pop-up stays in this tab. Never a new webview
        // window: that window would carry no gate of its own. If the app does not open a tab (it
        // is full, or an older app), it navigates this page instead (browser_navigate).
        // Only the ADDRESS reaches here, never a request body: a POST form aimed at a new window
        // is kept in its own tab by browser_page.js before it gets this far (#193441).
        //
        // The navigate is posted from another thread so it runs AFTER this handler returns.
        // WebKit calls this from inside its own click handling, on the main thread, and Tauri
        // runs a main-thread navigate synchronously: the load started there was dropped and the
        // page never moved. Google's "Sign in" (target=_blank to accounts.google.com) did
        // nothing at all (2026-11-11). run_on_main_thread would not help: from the main thread
        // it also runs at once.
        .on_new_window(move |url, _features| {
            if navigation_allowed(&url, crate::engine_port_hint()) {
                if !opens_in_same_tab(&url) {
                    let chat = win_label.trim_start_matches(BROWSER_PREFIX).to_string();
                    if chat != "signin" {
                        let _ = win_app.emit_to("main", NEW_TAB_EVENT, NewTab { chat, url: url.to_string() });
                        return NewWindowResponse::Deny;
                    }
                }
                if let Some(w) = win_app.get_webview(&win_label) {
                    std::thread::spawn(move || {
                        let _ = w.navigate(url);
                    });
                }
            }
            NewWindowResponse::Deny
        });

    #[cfg(target_os = "macos")]
    {
        b = if macos_has_data_stores() { b.data_store_identifier(MACOS_STORE_ID) } else { b.incognito(true) };
        // No Safari to read (never on a real Mac): keep the web view's own string.
        if let Some(ua) = safari_user_agent() {
            b = b.user_agent(&ua);
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Ok(dir) = app.path().app_local_data_dir() {
            b = b.data_directory(dir.join("browser-profile"));
        }
    }
    b
}

/// The browser webview, created hidden (off screen, 1x1) when it doesn't exist yet: importing
/// sign-ins needs its cookie store before the person has opened a page.
pub fn ensure_browser(app: &AppHandle) -> Result<Webview, String> {
    // Every page shares the cookie store, so any one of them will do.
    if let Some(w) = browser_pages(app).into_iter().next() {
        return Ok(w);
    }
    let window = app.get_window("main").ok_or("no main window")?;
    let w = window
        .add_child(
            builder(app, SIGNIN_LABEL, Url::parse("about:blank").expect("static url")),
            LogicalPosition::new(-10.0, -10.0),
            LogicalSize::new(1.0, 1.0),
        )
        .map_err(|e| e.to_string())?;
    let _ = w.hide();
    Ok(w)
}

/// Show this chat's Browser over its panel, creating it on first use. Other chats' pages are
/// left alone: a chat hides its own when it leaves (and two chats in split panes each show theirs). `url` navigates when given; a new page with no `url` reopens where this chat last was.
#[tauri::command]
pub fn browser_show(app: AppHandle, chat: String, url: Option<String>, bounds: Bounds, seq: Option<u64>) -> Result<(), String> {
    let label = label_for(&chat)?;
    let target = match url.as_deref() {
        Some(u) => Some(address_to_url(u).ok_or_else(|| format!("not a web address: {u}"))?),
        None => None,
    };
    if let Some(t) = &target {
        if !navigation_allowed(t, crate::engine_port_hint()) {
            return Err(format!("refused: {t} is not a page the browser opens"));
        }
    }
    touch(&label);
    admit_placement(&label, seq, true);
    let pos = LogicalPosition::new(bounds.x, bounds.y);
    let size = LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0));
    if let Some(w) = app.get_webview(&label) {
        w.set_position(pos).map_err(|e| e.to_string())?;
        w.set_size(size).map_err(|e| e.to_string())?;
        if let Some(t) = target {
            w.navigate(t).map_err(|e| e.to_string())?;
        }
        return w.show().map_err(|e| e.to_string());
    }
    // Make room: close the pages used longest ago (they reopen where they were).
    let live: Vec<String> = browser_pages(&app).iter().map(|w| w.label().to_string()).collect();
    let recent = with_tabs(|t| t.recent.clone()).unwrap_or_default();
    for old in to_close(&live, &recent, &label, MAX_LIVE) {
        if let Some(w) = app.get_webview(&old) {
            let _ = w.close();
        }
    }
    let start = target
        .or_else(|| with_tabs(|t| t.urls.get(&label).cloned()).flatten())
        .unwrap_or_else(|| Url::parse("about:blank").expect("static url"));
    let window = app.get_window("main").ok_or("no main window")?;
    let w = window.add_child(builder(&app, &label, start), pos, size).map_err(|e| e.to_string())?;
    if let Ok(cookies) = IMPORTED.lock() {
        for c in cookies.iter() {
            let _ = w.set_cookie(c.clone());
        }
    }
    Ok(())
}

/// Follow the panel: called on resize, on a rAF, while the Browser tab is visible. A call older
/// than the newest applied is dropped (`admit`).
#[tauri::command]
pub fn browser_bounds(app: AppHandle, chat: String, bounds: Bounds, seq: Option<u64>) -> Result<(), String> {
    let Some(w) = browser(&app, &chat)? else { return Ok(()) };
    if !admit_placement(w.label(), seq, false) {
        return Ok(());
    }
    w.set_position(LogicalPosition::new(bounds.x, bounds.y)).map_err(|e| e.to_string())?;
    w.set_size(LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0))).map_err(|e| e.to_string())
}

/// Hide, never destroy: leaving the tab and coming back keeps the page (the `webMounted` rule).
/// Also called whenever an overlay opens over the panel (the native view draws above the DOM).
#[tauri::command]
pub fn browser_hide(app: AppHandle, chat: String) -> Result<(), String> {
    match browser(&app, &chat)? {
        Some(w) => w.hide().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

#[tauri::command]
pub fn browser_navigate(app: AppHandle, chat: String, url: String) -> Result<String, String> {
    let target = address_to_url(&url).ok_or_else(|| format!("not a web address: {url}"))?;
    if !navigation_allowed(&target, crate::engine_port_hint()) {
        return Err(format!("refused: {target} is not a page the browser opens"));
    }
    let w = browser(&app, &chat)?.ok_or("the browser is not open")?;
    touch(w.label());
    w.navigate(target.clone()).map_err(|e| e.to_string())?;
    Ok(target.to_string())
}

/// Close a tab's page for good (#193328): the person closed the tab, or the agent did. Forgets
/// where it was, so the key opens blank if it is ever used again.
#[tauri::command]
pub fn browser_close(app: AppHandle, chat: String) -> Result<(), String> {
    let label = label_for(&chat)?;
    with_tabs(|t| {
        t.urls.remove(&label);
        t.titles.remove(&label);
        t.recent.retain(|l| l != &label);
    });
    if let Ok(mut m) = PLACED.lock() {
        m.remove(&label);
    }
    match app.get_webview(&label) {
        Some(w) => w.close().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

/// back | forward | reload. History lives in the page, so back/forward are the page's own.
#[tauri::command]
pub fn browser_go(app: AppHandle, chat: String, action: String) -> Result<(), String> {
    let w = browser(&app, &chat)?.ok_or("the browser is not open")?;
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
pub fn browser_state(app: AppHandle, chat: String) -> Option<BrowserState> {
    let label = label_for(&chat).ok()?;
    let Some(w) = app.get_webview(&label) else {
        // Closed to make room: report where it was, so the tab shows it and reopens it there.
        let url = with_tabs(|t| t.urls.get(&label).cloned()).flatten()?;
        return Some(BrowserState { chat, title: title_of(&label), url: url.to_string(), loading: false });
    };
    let url = w.url().ok()?;
    Some(BrowserState { chat, title: title_of(w.label()), url: url.to_string(), loading: false })
}

/// Run one of the engine's page scripts in the pane and return its result (#193145). Only the
/// app calls this (the gate refuses every other webview), and only after the person granted the
/// page's site: that check lives in the app, beside the button that grants it.
#[tauri::command]
pub async fn browser_eval(app: AppHandle, chat: String, script: String) -> Result<String, String> {
    let w = browser(&app, &chat)?.ok_or("the Browser isn't open: open a page in it first")?;
    touch(w.label());
    let (tx, rx) = tokio::sync::oneshot::channel();
    let js = crate::browser_eval::wrap(&script);
    w.with_webview(move |pw| crate::browser_eval::start(pw, js, tx)).map_err(|e| e.to_string())?;
    match tokio::time::timeout(std::time::Duration::from_secs(10), rx).await {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => Err("the page did not answer".into()),
        Err(_) => Err("the page took longer than 10 s to answer".into()),
    }
}

/// A JPEG (base64) of the page in the Browser. Whether the agent may look is the app's check
/// (the same per-site Allow as reading), made before this is called.
#[tauri::command]
pub async fn browser_screenshot(app: AppHandle, chat: String) -> Result<String, String> {
    let w = browser(&app, &chat)?.ok_or("the Browser isn't open: open a page in it first")?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    w.with_webview(move |pw| crate::browser_eval::snapshot(pw, tx)).map_err(|e| e.to_string())?;
    match tokio::time::timeout(std::time::Duration::from_secs(10), rx).await {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => Err("the Browser did not answer".into()),
        Err(_) => Err("the picture took longer than 10 s".into()),
    }
}

/// The sites this browser holds cookies for: the start of Settings › Browser (S3). Names and
/// domains only, never values: values are credentials and never cross into the app's JS.
#[tauri::command]
pub fn browser_cookie_domains(app: AppHandle) -> Result<Vec<String>, String> {
    let w = browser_pages(&app).into_iter().next().ok_or("the browser is not open")?;
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
    fn every_chat_has_its_own_page_and_a_chat_id_is_checked() {
        assert_eq!(label_for("ses_1a2B-c").unwrap(), "browser-ses_1a2B-c");
        assert_ne!(label_for("ses_a").unwrap(), label_for("ses_b").unwrap());
        for bad in ["", "signin", "../x", "a b", "ses:", "ses:A", "ses:a-b", "ses:123456789", ":t2", "signin:t2", "a:b:c", &"x".repeat(65)] {
            assert!(label_for(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_chats_other_tabs_are_their_own_pages() {
        assert_eq!(label_for("ses_1a2B-c:t2").unwrap(), "browser-ses_1a2B-c:t2");
        assert_ne!(label_for("ses_a").unwrap(), label_for("ses_a:t2").unwrap());
        assert_ne!(label_for("ses_a:t2").unwrap(), label_for("ses_b:t2").unwrap());
        // still never an app webview
        assert!(!ipc_allowed(&label_for("ses_a:t2").unwrap()));
    }

    #[test]
    fn sign_in_pop_ups_stay_in_their_tab_other_new_windows_get_a_tab() {
        for same in [
            "https://accounts.google.com/o/oauth2/v2/auth?x=1",
            "https://appleid.apple.com/auth/authorize",
            "https://login.microsoftonline.com/common/oauth2",
            "https://www.facebook.com/v18.0/dialog/oauth?client_id=1",
            "https://example.com/login?next=/",
            "https://shop.example/oauth/start",
        ] {
            assert!(opens_in_same_tab(&u(same)), "{same}");
        }
        for tab in [
            "https://www.google.com/maps/dir/Austin/Phoenix",
            "https://www.hertz.com/rentacar/reservation/",
            "https://docs.example.com/itinerary.pdf",
        ] {
            assert!(!opens_in_same_tab(&u(tab)), "{tab}");
        }
    }

    #[test]
    fn a_bounds_call_older_than_the_newest_applied_is_dropped() {
        let mut m = std::collections::HashMap::new();
        assert!(admit(&mut m, "browser-a", Some(1), true)); // show
        assert!(admit(&mut m, "browser-a", Some(3), false));
        assert!(!admit(&mut m, "browser-a", Some(2), false), "a mid-drag rect landing late");
        assert!(!admit(&mut m, "browser-a", Some(3), false));
        assert!(admit(&mut m, "browser-a", Some(4), false));
        // pages are counted apart
        assert!(admit(&mut m, "browser-b", Some(2), false));
        // a reloaded app starts again from 1 with a show
        assert!(admit(&mut m, "browser-a", Some(1), true));
        assert!(admit(&mut m, "browser-a", Some(2), false));
        // an older app sends no number
        assert!(admit(&mut m, "browser-a", None, false));
    }

    #[test]
    fn past_the_limit_the_page_used_longest_ago_closes_never_the_one_being_opened() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let live = s(&["browser-a", "browser-b", "browser-c", "browser-d"]);
        // newest first: d, b, a, c → c is the oldest
        assert_eq!(to_close(&live, &s(&["browser-e", "browser-d", "browser-b", "browser-a", "browser-c"]), "browser-e", 4), s(&["browser-c"]));
        // the hidden sign-in page, used by no chat, goes first
        let live2 = s(&["browser-signin", "browser-a", "browser-b", "browser-c"]);
        assert_eq!(to_close(&live2, &s(&["browser-a", "browser-b", "browser-c"]), "browser-d", 4), s(&["browser-signin"]));
        // under the limit, or reopening one that is live: nothing closes
        assert!(to_close(&s(&["browser-a"]), &[], "browser-b", 4).is_empty());
        assert!(to_close(&live, &[], "browser-a", 4).is_empty());
    }

    #[test]
    fn says_it_is_safari_with_this_macs_safari_version() {
        assert_eq!(
            safari_user_agent_for("18.1.1\n").as_deref(),
            Some("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1.1 Safari/605.1.15")
        );
        assert!(safari_user_agent_for("17.4").unwrap().contains("Version/17.4 Safari/605.1.15"));
        for bad in ["", "18.1 beta", "18..1", "1.2.3.4", "18;rm"] {
            assert_eq!(safari_user_agent_for(bad), None, "{bad}");
        }
    }

    #[test]
    fn only_our_webviews_may_call_app_commands() {
        assert!(ipc_allowed("main"));
        assert!(ipc_allowed("iris-login"));
        assert!(!ipc_allowed(&label_for("ses_1").unwrap()));
        assert!(!ipc_allowed(SIGNIN_LABEL));
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
            let page = WebviewWindowBuilder::new(&app, &label_for("ses_abc").unwrap(), Default::default()).build().unwrap();
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
