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

/// How long the engine re-key waits on the post-sign-in setup before acting on its own.
///
/// While setup runs, the sign-in window owns the restart (it narrates progress and restarts
/// when setup reports done). The watcher in lib.rs only steps in if that never happens — a
/// dead thread, a window that was closed — and this is how long "never" is.
const SETUP_MAX: std::time::Duration = std::time::Duration::from_secs(12 * 60);
/// After setup reports, how long the sign-in window has to show the outcome before the
/// watcher restarts regardless. The window's own countdown is shorter than this.
const SETUP_GRACE: std::time::Duration = std::time::Duration::from_secs(30);

static SETUP_HOLD_UNTIL: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);

fn hold_engine_restart(for_: std::time::Duration) {
    if let Ok(mut h) = SETUP_HOLD_UNTIL.lock() {
        *h = Some(std::time::Instant::now() + for_);
    }
}

/// True while the sign-in flow owns the restart. Read by the engine re-key watcher.
pub(crate) fn engine_restart_held() -> bool {
    SETUP_HOLD_UNTIL
        .lock()
        .ok()
        .and_then(|h| *h)
        .map(|until| std::time::Instant::now() < until)
        .unwrap_or(false)
}

/// What the sign-in window is told when setup ends. ALWAYS sent — see below.
#[derive(Clone, serde::Serialize)]
struct SetupOutcome {
    /// "ready" (CLI present and signed in) · "not-signed-in" (present, whoami failed) ·
    /// "missing" (no CLI — install failed)
    cli: &'static str,
    /// The reason, when there is one. Plain text; the window renders it with textContent.
    detail: String,
    /// What the user can run themselves, when the app could not do it. Platform-specific.
    recovery: Option<String>,
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
/// Every step is idempotent and self-checking: the CLI install is skipped when a platform CLI
/// is already present (identity-checked, not merely a file at the path),
/// `daemon install` refuses to reinstall over an existing daemon, and `register` is safe to
/// repeat. So a re-login costs nothing, and a partial previous attempt is completed rather
/// than duplicated.
///
/// THE CREDENTIAL IS NEVER HOSTAGE TO THIS (#186013). This used to emit `setup-failed` and
/// RETURN when the CLI install failed, and the window then left itself open "so the message
/// stays visible" — so the app was never restarted, and the engine, spawned before sign-in
/// with IRIS_API_KEY="", kept answering every chat message with "Unauthorized: Provide a
/// Bearer token" while the token sat correctly in ~/.iris/sdk/.env. On Windows the install
/// ALWAYS failed, so sign-in could never take effect. Measured live on a client's machine
/// 2026-09-18: TUI working, Desktop chat 401 on every message, same account, same file.
///
/// Now: every exit path sends `setup-done` with the outcome, the window restarts on every
/// outcome (after showing it), and independently the engine watcher in lib.rs restarts the
/// app whenever the key on disk differs from the key the engine was spawned with — held off
/// only while this thread is running, and never longer than SETUP_MAX.
fn finish_setup_in_background(app: AppHandle) {
    hold_engine_restart(SETUP_MAX);
    std::thread::spawn(move || {
        let outcome = run_setup_steps(&app);
        println!("setup: done -> cli={} {}", outcome.cli, outcome.detail);
        // Give the window time to show the outcome; after that the watcher may restart.
        hold_engine_restart(SETUP_GRACE);
        let _ = app.emit("setup-done", outcome);
    });
}

fn run_setup_steps(app: &AppHandle) -> SetupOutcome {
    // Report each step to the sign-in window. Silence for ten seconds after a click reads
    // as a hang, and the window then asks the user to do something it can do itself.
    let step = |label: &str| {
        let _ = app.emit("setup-step", label);
    };
    // The CLI first: the daemon verbs live in it.
    //
    // This comment used to read "install_cli() uses the BUNDLED sidecar, so this needs no
    // network and cannot be broken by a bad release URL." That was true, and it was the
    // bug: the sidecar is opencode-core, so the step that made sign-in self-sufficient was
    // the same step that removed the platform commands the daemon verbs below depend on
    // (#183738). It now downloads the real CLI, and a bad release URL is the correct thing
    // to fail on — better than succeeding with the wrong product.
    //
    // Gated on identity so the "every step is idempotent" promise above stays true: a
    // re-login on a healthy machine costs nothing instead of re-downloading ~120MB.
    step("Installing the CLI");
    let install = match crate::cli::cli_state() {
        crate::cli::CliState::PlatformCli => {
            println!("setup: cli -> already present, skipping install");
            Ok(String::new())
        }
        _ => {
            let r = crate::cli::install_cli_inner();
            crate::cli::record_install_outcome(r.is_ok());
            r
        }
    };
    if let Err(e) = install {
        eprintln!("setup: cli install failed: {e}");
        // Nothing downstream can work without the CLI — but the credential already can, and
        // the window restarts on this outcome too.
        return SetupOutcome {
            cli: "missing",
            detail: format!("The iris CLI could not be installed: {e}"),
            recovery: Some(if cfg!(windows) {
                format!(
                    "To install it yourself, open PowerShell and run:\n  {}",
                    crate::cli::WINDOWS_INSTALL_ONE_LINER
                )
            } else {
                "To install it yourself, open a terminal and run:\n  curl -fsSL https://heyiris.io/install-code | bash".to_string()
            }),
        };
    }

    let Some(iris) = crate::cli::get_cli_install_path() else {
        eprintln!("setup: could not locate the installed CLI; skipping daemon setup");
        return SetupOutcome {
            cli: "missing",
            detail: "Could not locate the installed CLI.".into(),
            recovery: None,
        };
    };

    // Ask the CLI who it is before claiming it is signed in. The window used to print "The
    // iris CLI is signed in too" before any of this ran, including on machines with no CLI.
    let signed_in = crate::cli::run_with_timeout(
        std::process::Command::new(&iris).args(["auth", "whoami"]),
        std::time::Duration::from_secs(30),
    )
    .map(|o| o.status.success())
    .unwrap_or(false);

    // The Hive daemon. On Windows the CLI's `daemon install` / `daemon register` are not the
    // path: the PowerShell installer that just ran sets up the Node-based bridge itself
    // (iris-daemon.cmd, a per-user scheduled task) when Node.js is present, and skips it
    // with a stated reason when it is not. Running the POSIX-shaped verbs here could only add
    // a hang or a console window, so they are skipped — and the log says so.
    if cfg!(windows) {
        println!(
            "setup: Hive daemon steps skipped on Windows — the PowerShell installer sets up the bridge (needs Node.js); see `iris-daemon status`"
        );
    } else {
        for (label, args) in [
            ("Installing the Hive daemon", ["daemon", "install"]),
            ("Registering this machine", ["daemon", "register"]),
        ] {
            step(label);
            // Bounded: this thread holds the restart, so a step that never returns would hold
            // the credential back with it.
            match crate::cli::run_with_timeout(
                std::process::Command::new(&iris).args(args),
                std::time::Duration::from_secs(180),
            ) {
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
    }

    if signed_in {
        SetupOutcome { cli: "ready", detail: String::new(), recovery: None }
    } else {
        SetupOutcome {
            cli: "not-signed-in",
            detail: "The iris CLI is installed but did not confirm the sign-in.".into(),
            recovery: Some("In a terminal, run:\n  iris auth login".into()),
        }
    }
}

/// Relaunch the app so the freshly-written credential and PATH are picked up.
///
/// Tauri hands us this directly; the alternative was asking the user to quit and reopen, which
/// is a chore the app can do for itself and the last manual step left in onboarding.
#[tauri::command]
pub fn restart_app(app: AppHandle) {
    // Stop the engine first. A restart from the main thread exits without RunEvent::Exit, so
    // the handler that normally kills the sidecar never runs and the old, un-keyed engine
    // would be left running beside the new one.
    crate::kill_sidecar(app.clone());
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
