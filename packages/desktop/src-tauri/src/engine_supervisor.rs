//! Keep the engine alive for the life of the app (#190516), and leave a record when it is not
//! (#190517).
//!
//! Until this module the engine was checked exactly once: at launch, by whether its port accepted
//! a TCP connection, for at most seven seconds. After that nothing watched it. The event loop in
//! `spawn_sidecar` dropped `CommandEvent::Terminated` on the floor, so an engine that crashed ten
//! minutes in left the window on "Could not reach Local — Retrying automatically…" forever,
//! retrying a process that no longer existed. Observed on a client's MacBook Air, 2026-10-22:
//! she was nearly finished with a page, the engine died, and the only fix was to quit the app —
//! which nothing on the screen told her to do. An engine that hung while holding its port looked
//! healthy to the same check.
//!
//! Three things replace it:
//!
//! 1. **Exit → respawn.** An engine that exits while the app is running is spawned again on the
//!    SAME port, after a short backoff. The window has the port baked in and already retries, so
//!    it reconnects by itself; the person sees a few seconds of "Reconnecting".
//! 2. **Watchdog.** Every 10s, `GET /global/health`. Three misses in a row and the engine is
//!    killed and respawned through the same path — this is the hung-but-listening case.
//! 3. **A ceiling.** Five restarts inside five minutes means respawning is not going to fix it.
//!    Stop, say so in words, and offer to copy the logs or try again — instead of a spinner.
//!
//! Every one of those is written to `engine.log` in the app's log directory and sent as one
//! funnel event, because the other half of that night was that nobody could say what had
//! happened on her machine: the logs lived in memory and died with the app.
//!
//! A respawn must also leave the WINDOW able to talk to the new engine (#191482). The window reads
//! the engine's port and password once, when it loads. A respawn keeps both — same port, same
//! per-launch password — EXCEPT when the app had attached at startup to something it did not
//! start: then the window was handed no password at all, and the engine the supervisor starts in
//! its place has one. Every request from that window got a 401 and it sat on "Could not reach
//! Local — Retrying automatically…" until the person quit the app (an Intel iMac, 2026-10-28).
//! So the supervisor remembers what the window was handed, and when a respawned engine answers
//! with a different credential it reloads the window, which then asks again.
//!
//! What is deliberately NOT a crash: the app quitting, a restart the app asked for (sign-in,
//! re-key), and the updater stopping the engine before it swaps the bundle. Those go through
//! `kill_sidecar`, which pauses supervision. The pause expires, so an update that fails to
//! install does not leave the app with no engine and nobody watching.

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

/// The port the window was built against. 0 until the first spawn or attach.
static PORT: AtomicU32 = AtomicU32::new(0);
/// Bumped on every spawn. An exit event carries the generation it was spawned with, so the exit
/// of an engine the supervisor already replaced is not mistaken for the new one dying.
static GENERATION: AtomicU64 = AtomicU64::new(0);
/// Off until startup has finished. Startup does its own single retry; arming before then would
/// put two respawners on one port.
static ARMED: AtomicBool = AtomicBool::new(false);
/// The app is exiting. Permanent.
static EXITING: AtomicBool = AtomicBool::new(false);
/// A respawn is under way; everything else stands back.
static RESPAWNING: AtomicBool = AtomicBool::new(false);
/// The ceiling was hit. Cleared by "Try again".
static GAVE_UP: AtomicBool = AtomicBool::new(false);
/// The generation of the most recent engine that exited. A freshly spawned engine whose
/// generation shows up here died on arrival — no point waiting out the health budget for it.
static LAST_EXITED: AtomicU64 = AtomicU64::new(0);
/// The engine is (or is about to be) running in safe mode (#190980). Read by `spawn_sidecar`.
static SAFE_MODE: AtomicBool = AtomicBool::new(false);
static PAUSED_UNTIL: Mutex<Option<Instant>> = Mutex::new(None);
/// The credential the window was handed by `engine_credentials` (#191482). The outer None means
/// the window has not asked yet — it will ask when it loads, and get whatever is current then.
static WINDOW_CREDENTIAL: Mutex<Option<Option<String>>> = Mutex::new(None);
static RESTARTS: Mutex<VecDeque<Instant>> = Mutex::new(VecDeque::new());

const RESTART_WINDOW: Duration = Duration::from_secs(5 * 60);
const MAX_RESTARTS: usize = 5;
/// Seconds before restart N within the window. The first is fast because the common case — a
/// one-off crash — should cost the person almost nothing.
const BACKOFF_SECS: [u64; MAX_RESTARTS] = [1, 2, 5, 10, 10];

const PROBE_EVERY: Duration = Duration::from_secs(10);
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const MISSES_BEFORE_RESPAWN: u32 = 3;
/// How long a freshly spawned engine gets to answer health before it counts as failed. The old
/// seven seconds tripped on slow machines and on a first launch that copies history.
pub const READY_BUDGET: Duration = Duration::from_secs(30);

const LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;
const LOG_KEEP: usize = 3;

// ── state transitions other modules call ─────────────────────────────────────

/// Called by `spawn_sidecar` for every engine it starts. Returns the generation to hand back
/// with that engine's exit.
pub fn note_spawn(port: u32) -> u64 {
    PORT.store(port, Ordering::SeqCst);
    GENERATION.fetch_add(1, Ordering::SeqCst) + 1
}

/// The app attached to an engine it did not start. Supervise the port anyway: if that engine
/// goes away, spawning our own on the same port is strictly better than a dead window.
pub fn note_attached(port: u32) {
    PORT.store(port, Ordering::SeqCst);
}

/// Whether startup should use an engine that is already answering on `port` instead of starting
/// its own (#191482). Only when the port was given explicitly (`OPENCODE_PORT`, a developer
/// running the engine by hand): then whatever is there is what was asked for. A port the app
/// picked itself a moment ago was free; if something answers on it now, it is not our engine —
/// and attaching to it left the window with no password and the supervisor "watching" a port
/// nothing healthy was on. Observed twice on 2026-10-28: on an Intel iMac, and in the release
/// check of 1.18.153 ("the app never reported a listening port").
pub fn should_attach(port_was_configured: bool, something_answers: bool) -> bool {
    port_was_configured && something_answers
}

/// The window just asked for the engine credential and was given `credential`.
pub fn note_window_credential(credential: Option<String>) {
    if let Ok(mut c) = WINDOW_CREDENTIAL.lock() {
        *c = Some(credential);
    }
}

/// Whether the window holds a credential the running engine will refuse. False until the window
/// has asked: a window that has not loaded yet will be handed the current one.
fn window_is_locked_out(handed: Option<&Option<String>>, current: Option<&str>) -> bool {
    match handed {
        None => false,
        Some(handed) => handed.as_deref() != current,
    }
}

/// A respawned engine is answering. If the window was handed a different credential than this
/// engine has, reload it so it asks again — otherwise it retries with the wrong one forever.
fn reconnect_window(app: &AppHandle) {
    let current = crate::engine_auth::current_password();
    let locked_out = WINDOW_CREDENTIAL
        .lock()
        .map(|handed| window_is_locked_out(handed.as_ref(), current.as_deref()))
        .unwrap_or(false);
    if !locked_out {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    log(app, "the window holds a different engine credential than the respawned engine — reloading it");
    if let Ok(mut c) = WINDOW_CREDENTIAL.lock() {
        *c = None;
    }
    if let Err(e) = window.reload() {
        log(app, &format!("could not reload the window ({e})"));
    }
}

/// Startup is done; from here on, exits and missed probes are acted on.
pub fn arm() {
    ARMED.store(true, Ordering::SeqCst);
}

/// The app is quitting — never respawn again.
pub fn app_exiting() {
    EXITING.store(true, Ordering::SeqCst);
}

/// Something deliberate is stopping the engine (update install, restart). Stand back for a while.
pub fn pause(for_: Duration) {
    if let Ok(mut p) = PAUSED_UNTIL.lock() {
        *p = Some(Instant::now() + for_);
    }
}

fn standing_back() -> bool {
    if !ARMED.load(Ordering::SeqCst) || EXITING.load(Ordering::SeqCst) || GAVE_UP.load(Ordering::SeqCst) {
        return true;
    }
    PAUSED_UNTIL
        .lock()
        .ok()
        .and_then(|p| *p)
        .is_some_and(|until| Instant::now() < until)
}

// ── health ───────────────────────────────────────────────────────────────────

/// A real request, not a TCP connect: a hung engine still accepts connections.
pub async fn healthy(port: u32) -> bool {
    let Ok(client) = tauri_plugin_http::reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .no_proxy()
        .build()
    else {
        return false;
    };
    // /global/health is behind the engine's password like every other route (#190647).
    let mut req = client.get(format!("http://127.0.0.1:{port}/global/health"));
    if let Some(auth) = crate::engine_auth::current_header() {
        req = req.header("Authorization", auth);
    }
    match req.send().await {
        Ok(res) if res.status().is_success() => res
            .text()
            .await
            .map(|body| body.contains("\"healthy\":true"))
            .unwrap_or(false),
        _ => false,
    }
}

/// Poll health until the newest engine answers, it exits, or the budget runs out.
pub async fn wait_until_healthy(port: u32, budget: Duration) -> bool {
    wait_until_healthy_for(port, budget, GENERATION.load(Ordering::SeqCst)).await
}

/// An engine that crashes on start used to cost the full 30s budget per attempt, so a crash loop
/// took minutes to reach safe mode. Its exit is known the moment it happens; stop waiting then.
async fn wait_until_healthy_for(port: u32, budget: Duration, generation: u64) -> bool {
    let started = Instant::now();
    while started.elapsed() < budget {
        if LAST_EXITED.load(Ordering::SeqCst) == generation {
            return false;
        }
        if healthy(port).await {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    false
}

// ── safe mode (#190980) ──────────────────────────────────────────────────────

/// Restarting an engine that crashes because of something on THIS machine — a broken MCP server,
/// a plugin, a project's config — only crashes it again, five times, and then the person is
/// stuck. Safe mode starts it once without those, so they can keep working while we find out
/// which piece it was.
pub fn safe_mode() -> bool {
    SAFE_MODE.load(Ordering::SeqCst)
}

/// The variables a safe-mode engine is started with. Each one maps to a switch the engine already
/// honours: no MCP servers, no external plugins, no project config.
pub const SAFE_MODE_ENV: [(&str, &str); 3] = [
    ("OPENCODE_SAFE_MODE", "1"),
    ("OPENCODE_PURE", "1"),
    ("OPENCODE_DISABLE_PROJECT_CONFIG", "1"),
];

#[derive(Debug, PartialEq)]
enum Next {
    Respawn(Duration),
    SafeMode,
    GiveUp,
}

/// What to do after `restarts` respawns inside the window. Pure, so the ladder is tested
/// directly: backoff, then ONE safe-mode attempt, then stop and say so.
fn next_step(restarts: usize, safe_mode_tried: bool) -> Next {
    if restarts < MAX_RESTARTS {
        Next::Respawn(Duration::from_secs(BACKOFF_SECS[restarts]))
    } else if !safe_mode_tried {
        Next::SafeMode
    } else {
        Next::GiveUp
    }
}

fn entered_safe_mode(app: &AppHandle) {
    log(app, "engine is answering in safe mode — MCP servers, plugins and project config are off");
    crate::onboarding::track(app, "engine.safe_mode", Some(format!("last={}", last_error_line(app))));

    let app_for_choice = app.clone();
    app.dialog()
        .message(
            "IRIS kept stopping, so it restarted in safe mode. You can keep working.\n\n\
             Your MCP servers, plugins and project settings are switched off for now — one of them \
             is the likely cause. Restart normally to turn them back on, or copy the logs for the IRIS team.",
        )
        .title("IRIS is in safe mode")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Keep working".to_string(),
            "Restart normally".to_string(),
        ))
        .show(move |keep_working| {
            if !keep_working {
                SAFE_MODE.store(false, Ordering::SeqCst);
                if let Ok(mut r) = RESTARTS.lock() {
                    r.clear();
                }
                crate::stop_engine_child(&app_for_choice);
                respawn(app_for_choice, "restart normally");
            }
        });
}

// ── exit → respawn ───────────────────────────────────────────────────────────

/// `spawn_sidecar`'s event loop calls this on `CommandEvent::Terminated`.
pub fn on_exit(app: &AppHandle, generation: u64, code: Option<i32>, signal: Option<i32>) {
    let what = format!("engine exited (code {code:?}, signal {signal:?})");
    LAST_EXITED.store(generation, Ordering::SeqCst);
    if generation != GENERATION.load(Ordering::SeqCst) {
        log(app, &format!("{what} — an engine already replaced; ignoring"));
        return;
    }
    if standing_back() {
        log(app, &format!("{what} — expected (quitting, restarting, updating, or not yet started)"));
        return;
    }
    // A respawn is already under way: either it killed this engine (hung), or this is a fresh
    // engine that died on start. The respawn loop sees it through LAST_EXITED and decides.
    if RESPAWNING.load(Ordering::SeqCst) {
        log(app, &format!("{what} — during a respawn; the respawn loop handles it"));
        return;
    }
    log(app, &format!("{what} — respawning"));
    crate::onboarding::track(
        app,
        "engine.crashed",
        Some(format!("code={code:?} signal={signal:?} last={}", last_error_line(app))),
    );
    respawn(app.clone(), "exited");
}

/// One respawner at a time. Loops until an engine answers health, the ceiling is hit, or
/// something deliberate takes over.
fn respawn(app: AppHandle, reason: &'static str) {
    if RESPAWNING.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let mut reason = reason;
        loop {
            let attempt = {
                let mut r = RESTARTS.lock().unwrap_or_else(|e| e.into_inner());
                while r.front().is_some_and(|t| t.elapsed() > RESTART_WINDOW) {
                    r.pop_front();
                }
                r.len()
            };
            match next_step(attempt, SAFE_MODE.load(Ordering::SeqCst)) {
                Next::Respawn(delay) => tokio::time::sleep(delay).await,
                Next::SafeMode => {
                    log(&app, &format!("{attempt} respawns in {} minutes — trying safe mode", RESTART_WINDOW.as_secs() / 60));
                    SAFE_MODE.store(true, Ordering::SeqCst);
                    reason = "safe mode";
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
                Next::GiveUp => {
                    give_up(&app);
                    break;
                }
            }
            if EXITING.load(Ordering::SeqCst) || standing_back() {
                log(&app, "respawn cancelled — something deliberate took over");
                break;
            }

            let port = PORT.load(Ordering::SeqCst);
            if port == 0 {
                break;
            }
            crate::stop_engine_child(&app);
            RESTARTS.lock().unwrap_or_else(|e| e.into_inner()).push_back(Instant::now());
            log(&app, &format!("respawning engine on port {port} (attempt {}, {reason})", attempt + 1));
            let child = crate::spawn_sidecar(&app, port);
            crate::set_engine_child(&app, child);

            if wait_until_healthy(port, READY_BUDGET).await {
                reconnect_window(&app);
                if SAFE_MODE.load(Ordering::SeqCst) && reason == "safe mode" {
                    entered_safe_mode(&app);
                } else {
                    log(&app, "engine is answering again");
                    crate::onboarding::track(&app, "engine.restarted", Some(format!("{reason}; attempt {}", attempt + 1)));
                }
                break;
            }
            log(&app, "respawned engine did not come up (exited, or no health answer in time)");
            if reason != "safe mode" {
                reason = "did not come up";
            }
        }
        RESPAWNING.store(false, Ordering::SeqCst);
    });
}

fn give_up(app: &AppHandle) {
    GAVE_UP.store(true, Ordering::SeqCst);
    let safe = SAFE_MODE.swap(false, Ordering::SeqCst);
    log(
        app,
        &format!(
            "engine stopped {MAX_RESTARTS} times in {} minutes{} — giving up",
            RESTART_WINDOW.as_secs() / 60,
            if safe { " and safe mode did not help" } else { "" },
        ),
    );
    crate::onboarding::track(
        app,
        "engine.gave_up",
        Some(format!("safe_mode={} last={}", if safe { "failed" } else { "untried" }, last_error_line(app))),
    );

    let app_for_choice = app.clone();
    app.dialog()
        .message(
            "IRIS's local engine keeps stopping, even in safe mode, so it cannot load your chats or \
             models right now.\n\n\
             Your work is saved. Try again, or copy the logs and send them to the IRIS team.",
        )
        .title("IRIS needs a moment")
        .buttons(MessageDialogButtons::OkCancelCustom("Try again".to_string(), "Copy logs".to_string()))
        .show(move |try_again| {
            if try_again {
                if let Ok(mut r) = RESTARTS.lock() {
                    r.clear();
                }
                GAVE_UP.store(false, Ordering::SeqCst);
                respawn(app_for_choice, "try again");
            } else {
                let app = app_for_choice.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = crate::copy_logs_to_clipboard(app).await;
                });
            }
        });
}

// ── watchdog ─────────────────────────────────────────────────────────────────

/// Runs for the life of the app.
pub fn start_watchdog(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut misses = 0u32;
        loop {
            tokio::time::sleep(PROBE_EVERY).await;
            if EXITING.load(Ordering::SeqCst) {
                return;
            }
            let port = PORT.load(Ordering::SeqCst);
            if port == 0 || standing_back() || RESPAWNING.load(Ordering::SeqCst) {
                misses = 0;
                continue;
            }
            if healthy(port).await {
                misses = 0;
                continue;
            }
            misses += 1;
            log(&app, &format!("health probe missed ({misses}/{MISSES_BEFORE_RESPAWN})"));
            if misses >= MISSES_BEFORE_RESPAWN {
                misses = 0;
                crate::onboarding::track(&app, "engine.unresponsive", Some(format!("last={}", last_error_line(&app))));
                respawn(app.clone(), "unresponsive");
            }
        }
    });
}

// ── engine.log ───────────────────────────────────────────────────────────────

static LOG_FILE: Mutex<Option<(PathBuf, File, u64)>> = Mutex::new(None);

/// Append one line to `engine.log` in the app's log directory (on macOS
/// `~/Library/Logs/<bundle id>/`), rotating at 5 MB and keeping three files. Never fails loudly:
/// a log that cannot be written must not take the engine down with it.
pub fn log_line(app: &AppHandle, line: &str) {
    let Ok(mut guard) = LOG_FILE.lock() else { return };
    if guard.is_none() {
        let Ok(dir) = app.path().app_log_dir() else { return };
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("engine.log");
        let Ok(file) = OpenOptions::new().create(true).append(true).open(&path) else { return };
        let size = file.metadata().map(|m| m.len()).unwrap_or(0);
        *guard = Some((path, file, size));
    }
    let Some((path, file, size)) = guard.as_mut() else { return };

    if *size > LOG_MAX_BYTES {
        for i in (1..LOG_KEEP).rev() {
            let from = if i == 1 { path.clone() } else { path.with_extension(format!("{}.log", i - 1)) };
            let _ = std::fs::rename(&from, path.with_extension(format!("{i}.log")));
        }
        match OpenOptions::new().create(true).append(true).open(&*path) {
            Ok(f) => {
                *file = f;
                *size = 0;
            }
            Err(_) => return,
        }
    }

    let stamped = format!("{} {}", unix_secs(), line.trim_end_matches('\n'));
    if writeln!(file, "{stamped}").is_ok() {
        *size += stamped.len() as u64 + 1;
    }
}

/// A supervisor decision: to stdout, to the in-memory log the "Copy logs" button reads, and to
/// engine.log.
pub fn log(app: &AppHandle, msg: &str) {
    let line = format!("[SUPERVISOR] {msg}");
    println!("{line}");
    if let Some(state) = app.try_state::<crate::LogState>() {
        if let Ok(mut logs) = state.0.lock() {
            logs.push_back(format!("{line}\n"));
            while logs.len() > crate::MAX_LOG_ENTRIES {
                logs.pop_front();
            }
        }
    }
    log_line(app, &line);
}

fn unix_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The engine's last stderr line, for the funnel event — redacted, because stderr can carry a
/// URL with a token in it and this leaves the machine.
fn last_error_line(app: &AppHandle) -> String {
    let line = app
        .try_state::<crate::LogState>()
        .and_then(|s| {
            s.0.lock().ok().and_then(|logs| {
                logs.iter()
                    .rev()
                    .find(|l| l.starts_with("[STDERR]"))
                    .map(|l| l.trim_start_matches("[STDERR]").trim().to_string())
            })
        })
        .unwrap_or_default();
    redact(&line).chars().take(140).collect()
}

/// Replace any run of 24+ token-ish characters with "…". Crude on purpose: it is cheaper to lose
/// a long path from a crash summary than to ship somebody's key in one.
pub fn redact(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut run = String::new();
    let flush = |run: &mut String, out: &mut String| {
        if run.chars().count() >= 24 {
            out.push('…');
        } else {
            out.push_str(run);
        }
        run.clear();
    };
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '=' | '+' | '/') {
            run.push(c);
        } else {
            flush(&mut run, &mut out);
            out.push(c);
        }
    }
    flush(&mut run, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_long_tokens_and_keeps_words() {
        let s = "Unauthorized: Bearer 3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c for user";
        let r = redact(s);
        assert!(!r.contains("3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c"), "{r}");
        assert!(r.starts_with("Unauthorized: Bearer …"), "{r}");
        assert!(r.ends_with(" for user"), "{r}");
    }

    #[test]
    fn short_runs_survive() {
        assert_eq!(redact("exit code 137 at port 51926"), "exit code 137 at port 51926");
    }

    #[test]
    fn backoff_covers_every_attempt_below_the_ceiling() {
        assert_eq!(BACKOFF_SECS.len(), MAX_RESTARTS);
        assert!(BACKOFF_SECS.windows(2).all(|w| w[0] <= w[1]));
    }

    #[test]
    fn the_ladder_is_backoff_then_one_safe_mode_then_stop() {
        for (n, secs) in BACKOFF_SECS.iter().enumerate() {
            assert_eq!(next_step(n, false), Next::Respawn(Duration::from_secs(*secs)), "restart {n}");
        }
        assert_eq!(next_step(MAX_RESTARTS, false), Next::SafeMode);
        // Safe mode is tried once. If it did not come up, the next decision is to stop and say so —
        // never a sixth, seventh, eighth respawn.
        assert_eq!(next_step(MAX_RESTARTS, true), Next::GiveUp);
        assert_eq!(next_step(MAX_RESTARTS + 3, true), Next::GiveUp);
    }

    #[test]
    fn safe_mode_turns_off_mcp_plugins_and_project_config() {
        let keys: Vec<&str> = SAFE_MODE_ENV.iter().map(|(k, _)| *k).collect();
        // Each name must be one the engine reads (packages/core/src/flag/flag.ts), or safe mode
        // starts the same engine that kept crashing.
        assert_eq!(keys, ["OPENCODE_SAFE_MODE", "OPENCODE_PURE", "OPENCODE_DISABLE_PROJECT_CONFIG"]);
        assert!(SAFE_MODE_ENV.iter().all(|(_, v)| *v == "1"));
    }

    #[test]
    fn an_engine_that_died_on_arrival_fails_fast_instead_of_waiting_the_budget() {
        // Port 1 never answers; without the exit check this would sit out the whole 30s.
        let generation = u64::MAX - 7;
        LAST_EXITED.store(generation, Ordering::SeqCst);
        let started = Instant::now();
        let ok = tauri::async_runtime::block_on(wait_until_healthy_for(1, READY_BUDGET, generation));
        assert!(!ok);
        assert!(started.elapsed() < Duration::from_secs(2), "took {:?}", started.elapsed());
    }

    // #191482: a startup that attached to something it did not start handed the window NO
    // password; the engine the supervisor then spawned on that port has one. Same port — the
    // window can only recover if it is told to ask again.
    #[test]
    fn a_window_handed_no_password_is_locked_out_of_a_respawned_engine_that_has_one() {
        assert!(window_is_locked_out(Some(&None), Some("pw-of-the-respawned-engine")));
    }

    #[test]
    fn a_window_holding_the_engines_password_is_left_alone_after_a_respawn() {
        // The ordinary respawn: same port, same per-launch password. Reloading here would throw
        // away whatever the person had on screen for nothing.
        assert!(!window_is_locked_out(Some(&Some("pw".to_string())), Some("pw")));
        // An attached engine with no password, respawned as one with none (no randomness).
        assert!(!window_is_locked_out(Some(&None), None));
    }

    #[test]
    fn a_window_that_has_not_asked_yet_is_never_reloaded() {
        assert!(!window_is_locked_out(None, Some("pw")));
        assert!(!window_is_locked_out(None, None));
    }

    #[test]
    fn a_window_holding_a_stale_password_is_locked_out() {
        assert!(window_is_locked_out(Some(&Some("old".to_string())), Some("new")));
        assert!(window_is_locked_out(Some(&Some("old".to_string())), None));
    }

    #[test]
    fn startup_attaches_only_to_a_port_it_was_told_to_use() {
        // A port the app picked itself: whatever answers there is not our engine. Spawn ours.
        assert!(!should_attach(false, true));
        assert!(!should_attach(false, false));
        // OPENCODE_PORT: a developer's engine is already running there — use it.
        assert!(should_attach(true, true));
        assert!(!should_attach(true, false));
    }

    #[test]
    fn a_respawn_bumps_the_generation_so_the_old_exit_is_ignored() {
        let first = note_spawn(40001);
        let second = note_spawn(40001);
        assert!(second > first);
        assert_eq!(GENERATION.load(Ordering::SeqCst), second);
    }
}
