//! `iris://` links (#190233).
//!
//! A web page — today the post-payment page at heyiris.io/p/upgraded — opens the app with
//! `iris://upgraded?plan=<slug>`. Before this the app registered no scheme, so that page could
//! only say "switch back to IRIS (⌘-Tab)", and a buyer who had closed the app had no way back.
//!
//! Links are QUEUED, never pushed straight at the page: on a cold start the link arrives before
//! the window exists (it is built only after the engine is up), so an event emitted then would
//! reach nobody. The page drains the queue on mount and again on each `iris-deep-link` event —
//! one path for both cases, so a link is handled exactly once.
//!
//! Only the scheme is checked here. What a link MEANS is decided by the app
//! (`utils/iris-deep-link.ts`), which accepts a fixed set of hosts and ignores everything else;
//! nothing from a URL is ever navigated to or executed.

use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
pub struct PendingDeepLinks(pub Mutex<Vec<String>>);

/// Queue `iris://` links, bring the window forward, and tell the page there is something to read.
pub fn queue<I: IntoIterator<Item = String>>(app: &AppHandle, urls: I) {
    let accepted: Vec<String> = urls
        .into_iter()
        .filter(|u| u.starts_with("iris://") || u.starts_with("iris:"))
        .take(8)
        .collect();
    if accepted.is_empty() {
        return;
    }
    if let Some(state) = app.try_state::<PendingDeepLinks>() {
        if let Ok(mut pending) = state.0.lock() {
            pending.extend(accepted);
            // A burst of links (a page in a loop, a stuck redirect) must not grow without bound.
            let len = pending.len();
            if len > 16 {
                pending.drain(..len - 16);
            }
        }
    }
    focus_main(app);
    let _ = app.emit("iris-deep-link", ());
}

/// The window may not exist yet (cold start); then this is a no-op and the window opens anyway.
pub fn focus_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Hand the page every queued link and clear the queue.
#[tauri::command]
pub fn take_deep_links(state: tauri::State<'_, PendingDeepLinks>) -> Vec<String> {
    state.0.lock().map(|mut p| std::mem::take(&mut *p)).unwrap_or_default()
}
