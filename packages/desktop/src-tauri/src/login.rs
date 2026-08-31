//! In-app sign-in, so a client never needs a terminal to start using IRIS.
//!
//! Until now the ONLY way to authenticate was `iris auth login` in a terminal. Nothing in the
//! install path did it: the installer has no login step, and desktop "Install CLI" inherits
//! that gap. So first launch on a new machine reliably had no credential, the engine started
//! with IRIS_API_KEY="", and every model call 401'd — surfacing as "0 tokens" or an empty
//! reply with no cause named. A client lost an evening to exactly this on 2026-08-30.
//!
//! The flow the CLI uses is not OAuth and needs no callback server — it is two POSTs:
//!     POST /api/v1/auth/send-login-code   {email}                      -> emails a 6-digit code
//!     POST /api/v1/auth/login-with-code   {email, code, generate_sdk_token: true} -> token
//! then the token is written to ~/.iris/sdk/.env as IRIS_API_KEY.
//!
//! Both POSTs happen in the login window's own JS via fetch(), which is why this file needs no
//! HTTP client: adding reqwest for two requests the webview can already make would be a new
//! dependency for nothing. Rust's only job is the part JS cannot do — writing the file.
//!
//! The CLI reads the same ~/.iris/sdk/.env, so signing in here signs in BOTH. That is the
//! point: one flow, no terminal, and the CLI works afterwards without the user knowing why.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow};

/// Write the token exactly where the CLI and the app both already look for it.
///
/// Deliberately preserves any other keys in the file. The SDK env holds more than this one
/// value in some setups, and clobbering it to "fix" login would break integrations that were
/// working — a fix that breaks a neighbour is not a fix.
#[tauri::command]
pub fn save_iris_token(token: String) -> Result<(), String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("Empty token".into());
    }

    let home = dirs_next_home().ok_or("Could not resolve home directory")?;
    let dir = home.join(".iris").join("sdk");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {dir:?}: {e}"))?;
    let path = dir.join(".env");

    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let mut lines: Vec<String> = existing
        .lines()
        .filter(|l| {
            let t = l.trim().strip_prefix("export ").unwrap_or(l.trim());
            !t.starts_with("IRIS_API_KEY=")
        })
        .map(|l| l.to_string())
        .collect();
    lines.push(format!("IRIS_API_KEY={token}"));

    let mut out = lines.join("\n");
    out.push('\n');
    std::fs::write(&path, out).map_err(|e| format!("Could not write {path:?}: {e}"))?;

    // 0600: this is a 365-day credential to the user's whole account. World-readable by
    // default would be a quiet mistake that never announces itself.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }

    Ok(())
}

fn dirs_next_home() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").map(std::path::PathBuf::from)
}

/// Open the sign-in window. Idempotent — focuses the existing one rather than stacking.
pub fn show_login_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("iris-login") {
        let _ = w.set_focus();
        return;
    }

    match WebviewWindow::builder(app, "iris-login", WebviewUrl::App("login.html".into()))
        .title("Sign in to IRIS")
        .inner_size(420.0, 560.0)
        .resizable(false)
        .center()
        .build()
    {
        Ok(_) => {}
        Err(e) => eprintln!("Could not open the sign-in window: {e}"),
    }
}
