use tauri::{plugin::Plugin, Manager, Runtime, Window};

pub struct PinchZoomDisablePlugin;

impl Default for PinchZoomDisablePlugin {
    fn default() -> Self {
        Self
    }
}

impl<R: Runtime> Plugin<R> for PinchZoomDisablePlugin {
    fn name(&self) -> &'static str {
        "Does not matter here"
    }

    fn window_created(&mut self, window: Window<R>) {
        let Some(webview_window) = window.get_webview_window(window.label()) else {
            return;
        };

        let _ = webview_window.with_webview(|_webview| {
            #[cfg(target_os = "linux")]
            unsafe {
                use gtk::glib::ObjectExt;
                use gtk::GestureZoom;
                use webkit2gtk::glib::gobject_ffi;

                if let Some(data) = _webview.inner().data::<GestureZoom>("wk-view-zoom-gesture") {
                    gobject_ffi::g_signal_handlers_destroy(data.as_ptr().cast());
                }
            }
        });
    }
}

/// Microphone for dictation on Linux.
///
/// WebKitGTK ships with `enable-media-stream` OFF, so getUserMedia does not exist in the window,
/// and with it on, every request raises a `permission-request` that nothing in Tauri answers —
/// which WebKit treats as a denial. Turn the setting on, and answer the request: allow audio-only
/// capture for this app's own pages, deny everything else (cameras, screen capture, and any page
/// that is not ours).
pub struct LinuxMicrophonePlugin;

impl<R: Runtime> Plugin<R> for LinuxMicrophonePlugin {
    fn name(&self) -> &'static str {
        "iris-linux-microphone"
    }

    fn window_created(&mut self, window: Window<R>) {
        let Some(webview_window) = window.get_webview_window(window.label()) else {
            return;
        };

        let _ = webview_window.with_webview(|_webview| {
            #[cfg(target_os = "linux")]
            {
                use gtk::glib::Cast;
                use webkit2gtk::{
                    PermissionRequestExt, SettingsExt, UserMediaPermissionRequest,
                    UserMediaPermissionRequestExt, WebViewExt,
                };

                let view = _webview.inner();
                if let Some(settings) = WebViewExt::settings(&view) {
                    settings.set_enable_media_stream(true);
                }
                view.connect_permission_request(|view, request| {
                    let Some(media) = request.downcast_ref::<UserMediaPermissionRequest>() else {
                        // Not ours to decide (geolocation, notifications…): WebKit's default.
                        return false;
                    };
                    let ours = view.uri().is_some_and(|uri| is_app_origin(uri.as_str()));
                    if ours && media.is_for_audio_device() && !media.is_for_video_device() {
                        request.allow();
                    } else {
                        request.deny();
                    }
                    true
                });
            }
        });
    }
}

/// Is `uri` one of this app's own pages, rather than a site the app happens to show?
/// Linux serves the app from `tauri://localhost`; `http(s)://tauri.localhost` is the Windows form,
/// accepted so the check means the same thing everywhere. Dev builds also serve from the devUrl.
pub fn is_app_origin(uri: &str) -> bool {
    const APP: &[&str] = &["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];
    const DEV: &[&str] = if cfg!(debug_assertions) { &["http://localhost:1420"] } else { &[] };
    let rest = APP.iter().chain(DEV).find_map(|origin| uri.strip_prefix(origin));
    // The origin must END where the prefix does: "tauri://localhost.evil.example" is not ours.
    rest.is_some_and(|r| r.is_empty() || r.starts_with(['/', '?', '#']))
}

#[cfg(test)]
mod tests {
    use super::is_app_origin;

    #[test]
    fn app_pages_are_ours() {
        assert!(is_app_origin("tauri://localhost"));
        assert!(is_app_origin("tauri://localhost/"));
        assert!(is_app_origin("tauri://localhost/session/abc?x=1"));
        assert!(is_app_origin("http://tauri.localhost/"));
        assert!(is_app_origin("https://tauri.localhost/login.html"));
    }

    #[test]
    fn other_sites_are_not() {
        assert!(!is_app_origin("https://example.com/"));
        assert!(!is_app_origin("tauri://localhost.evil.example/"));
        assert!(!is_app_origin("http://tauri.localhost.evil.example/"));
        assert!(!is_app_origin("tauri://localhost@evil.example/"));
        assert!(!is_app_origin("http://localhost:4096/"));
        assert!(!is_app_origin(""));
    }
}
