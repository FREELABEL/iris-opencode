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

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow};

/// Write the token exactly where the CLI and the app both already look for it.
///
/// Deliberately preserves any other keys in the file. The SDK env holds more than this one
/// value in some setups, and clobbering it to "fix" login would break integrations that were
/// working — a fix that breaks a neighbour is not a fix.
#[tauri::command]
pub fn save_iris_token(app: AppHandle, token: String) -> Result<(), String> {
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

    // Signing in is not finishing setup. Do the rest here, so "download the app" is the whole
    // instruction rather than the first of four.
    finish_setup_in_background(app);

    Ok(())
}

/// Install the CLI, install the Hive daemon, and register this machine — after sign-in.
///
/// Every one of these already worked; nothing ever ran them in order. That gap is what a
/// client walked on 2026-08-31: install the app, then a terminal one-liner for the CLI,
/// another for the daemon, a third command to register, and a dependency discovered at each
/// step from an error that did not name it.
///
/// Runs AFTER sign-in because the daemon needs a credential to register, and BACKGROUND
/// because none of it should freeze the window — the app is usable while this proceeds.
///
/// Every step is idempotent and self-checking: `install_cli` no-ops when the CLI is present,
/// `daemon install` refuses to reinstall over an existing daemon, and `register` is safe to
/// repeat. So a re-login costs nothing, and a partial previous attempt is completed rather
/// than duplicated.
fn finish_setup_in_background(app: AppHandle) {
    std::thread::spawn(move || {
        // Report each step to the sign-in window. Silence for ten seconds after a click reads
        // as a hang, and the window then asks the user to do something it can do itself.
        let step = |label: &str| {
            let _ = app.emit("setup-step", label);
        };
        // The CLI first: the daemon verbs live in it. install_cli() uses the BUNDLED sidecar,
        // so this needs no network and cannot be broken by a bad release URL.
        step("Installing the CLI");
        match crate::cli::install_cli() {
            Ok(msg) => println!("setup: cli -> {msg}"),
            Err(e) => {
                eprintln!("setup: cli install failed: {e}");
                let _ = app.emit("setup-failed", format!("CLI install failed: {e}"));
                return; // nothing downstream can work without it
            }
        }

        let Some(iris) = crate::cli::get_cli_install_path() else {
            eprintln!("setup: could not locate the installed CLI; skipping daemon setup");
            let _ = app.emit("setup-failed", "Could not locate the installed CLI");
            return;
        };

        for (label, args) in [
            ("Installing the Hive daemon", ["daemon", "install"]),
            ("Registering this machine", ["daemon", "register"]),
        ] {
            step(label);
            match std::process::Command::new(&iris).args(args).output() {
                Ok(out) => {
                    let text = String::from_utf8_lossy(if out.status.success() {
                        &out.stdout
                    } else {
                        &out.stderr
                    });
                    // Name the step. "setup failed" with no step is the error shape this whole
                    // week was spent removing.
                    println!(
                        "setup: {label} -> {} {}",
                        if out.status.success() { "ok" } else { "FAILED" },
                        text.trim().lines().last().unwrap_or("")
                    );
                }
                Err(e) => eprintln!("setup: {label} could not run: {e}"),
            }
        }

        // Done. The window restarts itself from here — a new user should never be told to go
        // and relaunch an app that is already running and already knows it needs to.
        let _ = app.emit("setup-done", ());
    });
}

/// Relaunch the app so the freshly-written credential and PATH are picked up.
///
/// Tauri hands us this directly; the alternative was asking the user to quit and reopen, which
/// is a chore the app can do for itself and the last manual step left in onboarding.
#[tauri::command]
pub fn restart_app(app: AppHandle) {
    app.restart();
}

/// Home directory, on every platform.
///
/// This read `$HOME` only, which is unset on Windows — so sign-in, the whole point of this
/// module, would fail there with "Could not resolve home directory". Same defect as lib.rs
/// had until earlier today (#182738), reintroduced in a new file because the helper was
/// copied rather than shared.
fn dirs_next_home() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

/// Open the sign-in window. Idempotent — focuses the existing one rather than stacking.
///
/// `required` is first launch with no credential: the app cannot do anything useful yet, so
/// the window is the app. It floats above the main window and has no close button — not to
/// trap anyone (Cmd-Q still quits) but because dismissing it leads nowhere. The old flow let
/// people close it and land in an IRIS where every request failed as "0 tokens", which reads
/// as a broken product rather than an unauthenticated one.
///
/// From the menu (`required = false`) it is an ordinary window: someone re-authenticating has
/// a working app behind it and every right to change their mind.
pub fn show_login_window(app: &AppHandle, required: bool) {
    if let Some(w) = app.get_webview_window("iris-login") {
        let _ = w.set_focus();
        return;
    }

    let mut builder = WebviewWindow::builder(app, "iris-login", WebviewUrl::App("login.html".into()))
        .title("Sign in to IRIS")
        .inner_size(420.0, 560.0)
        .resizable(false)
        .center();

    if required {
        // always_on_top: the main window opens moments later and would otherwise cover the one
        // screen the user has to act on — the failure being fixed is precisely "it worked but
        // it just sat there", and a sign-in window hidden behind the app is a worse version.
        builder = builder.always_on_top(true).closable(false);
    }

    match builder.build() {
        Ok(_) => {}
        Err(e) => eprintln!("Could not open the sign-in window: {e}"),
    }
}

/// Menu entry point. The window itself is idempotent, so repeated clicks focus rather than stack.
#[tauri::command]
pub fn open_login_window(app: AppHandle) {
    // Menu-initiated: not required. The app behind it already works.
    show_login_window(&app, false);
}
