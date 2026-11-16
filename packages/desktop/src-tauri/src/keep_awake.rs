//! Keep IRIS's pages running while its window is covered (#193492).
//!
//! THE BUG. 2026-11-16, iMac (macOS 13.7), a flight search by the agent: the person switched to
//! another app that covered IRIS. macOS logged, for both IRIS's own page and the Browser page,
//! "UIProcess is releasing a foreground assertion because the view is no longer visible", and
//! WebKit throttled them. The app's command relay and the page both stalled: every browser step
//! for the next 12 minutes was "The desktop did not answer within 16s", until the person looked at
//! IRIS again ("taking a foreground assertion because the view is visible", 21:47:39 local).
//! An agent that works only while you watch it is not an agent.
//!
//! THE FIX, per webview, in three layers, each a no-op where the OS lacks it:
//! - `background_throttling(Disabled)` on the builders (Tauri / wry): WKWebView's
//!   `inactiveSchedulingPolicy`, but wry sets it only on macOS 14+.
//! - macOS 13: WKWebView's `_setWindowOcclusionDetectionEnabled:NO`, so a covered window does not
//!   count as hidden (Electron's `backgroundThrottling: false` uses the same switch), and the
//!   preferences that throttle hidden pages. Each is sent only if WebKit answers to it.
//! - The IRIS process itself opts out of App Nap, so the Rust side that carries commands to the
//!   page keeps running too. It does not stop the Mac sleeping.
//!
//! A window that is minimised or hidden (Cmd-H) is still "not visible" to WebKit; covered by
//! another app's window is the case people actually hit.

/// The IRIS process opts out of App Nap for its whole life. Called once, at startup.
#[cfg(target_os = "macos")]
pub fn process() {
    use objc2::{msg_send, rc::Retained, runtime::AnyObject};
    use objc2_foundation::NSString;
    // NSActivityUserInitiatedAllowingIdleSystemSleep: no App Nap, but the Mac may still sleep.
    const USER_INITIATED_ALLOWING_IDLE_SLEEP: u64 = 0x00FF_FFFF & !(1 << 20);
    // Safety: NSProcessInfo is thread-safe; the token is kept for the life of the app.
    unsafe {
        let info: *mut AnyObject = msg_send![objc2::class!(NSProcessInfo), processInfo];
        if info.is_null() {
            return;
        }
        let reason = NSString::from_str("IRIS agents keep working while the window is covered");
        let token: Option<Retained<AnyObject>> =
            msg_send![info, beginActivityWithOptions: USER_INITIATED_ALLOWING_IDLE_SLEEP, reason: &*reason];
        std::mem::forget(token);
    }
}

#[cfg(not(target_os = "macos"))]
pub fn process() {}

/// Ask WebKit not to throttle this page when its window is covered. Pass to `with_webview`:
/// `w.with_webview(keep_awake::apply)`. Runs on the main thread.
pub fn apply(pw: tauri::webview::PlatformWebview) {
    #[cfg(target_os = "macos")]
    unsafe {
        webkit(pw.inner() as *mut objc2::runtime::AnyObject)
    }
    #[cfg(not(target_os = "macos"))]
    let _ = pw;
}

/// Safety: `view` is a live WKWebView; called on the main thread (`with_webview` runs there).
#[cfg(target_os = "macos")]
unsafe fn webkit(view: *mut objc2::runtime::AnyObject) {
    use objc2::{msg_send, runtime::AnyObject, sel};
    if view.is_null() {
        return;
    }
    let answers = |o: *mut AnyObject, s: objc2::runtime::Sel| -> bool { !o.is_null() && msg_send![o, respondsToSelector: s] };
    if answers(view, sel!(_setWindowOcclusionDetectionEnabled:)) {
        let _: () = msg_send![view, _setWindowOcclusionDetectionEnabled: false];
    }
    let config: *mut AnyObject = msg_send![view, configuration];
    if config.is_null() {
        return;
    }
    let prefs: *mut AnyObject = msg_send![config, preferences];
    if answers(prefs, sel!(_setPageVisibilityBasedProcessSuppressionEnabled:)) {
        let _: () = msg_send![prefs, _setPageVisibilityBasedProcessSuppressionEnabled: false];
    }
    if answers(prefs, sel!(_setHiddenPageDOMTimerThrottlingEnabled:)) {
        let _: () = msg_send![prefs, _setHiddenPageDOMTimerThrottlingEnabled: false];
    }
}
