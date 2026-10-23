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
static PAUSED_UNTIL: Mutex<Option<Instant>> = Mutex::new(None);
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

/// Poll health until it answers or the budget runs out.
pub async fn wait_until_healthy(port: u32, budget: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < budget {
        if healthy(port).await {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    false
}

// ── exit → respawn ───────────────────────────────────────────────────────────

/// `spawn_sidecar`'s event loop calls this on `CommandEvent::Terminated`.
pub fn on_exit(app: &AppHandle, generation: u64, code: Option<i32>, signal: Option<i32>) {
    let what = format!("engine exited (code {code:?}, signal {signal:?})");
    if generation != GENERATION.load(Ordering::SeqCst) {
        log(app, &format!("{what} — an engine already replaced; ignoring"));
        return;
    }
    if standing_back() {
        log(app, &format!("{what} — expected (quitting, restarting, updating, or not yet started)"));
        return;
    }
    // The supervisor itself just killed it (hung engine) and a respawn is already under way.
    if RESPAWNING.load(Ordering::SeqCst) {
        log(app, &format!("{what} — the respawn in progress stopped it"));
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
            if attempt >= MAX_RESTARTS {
                give_up(&app);
                break;
            }

            tokio::time::sleep(Duration::from_secs(BACKOFF_SECS[attempt])).await;
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
                log(&app, "engine is answering again");
                crate::onboarding::track(&app, "engine.restarted", Some(format!("{reason}; attempt {}", attempt + 1)));
                break;
            }
            log(&app, "respawned engine did not answer health in time");
            reason = "did not come up";
        }
        RESPAWNING.store(false, Ordering::SeqCst);
    });
}

fn give_up(app: &AppHandle) {
    GAVE_UP.store(true, Ordering::SeqCst);
    log(app, &format!("engine stopped {MAX_RESTARTS} times in {} minutes — giving up", RESTART_WINDOW.as_secs() / 60));
    crate::onboarding::track(app, "engine.gave_up", Some(format!("last={}", last_error_line(app))));

    let app_for_choice = app.clone();
    app.dialog()
        .message(
            "IRIS's local engine keeps stopping, so it cannot load your chats or models right now.\n\n\
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
fn log(app: &AppHandle, msg: &str) {
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
    fn a_respawn_bumps_the_generation_so_the_old_exit_is_ignored() {
        let first = note_spawn(40001);
        let second = note_spawn(40001);
        assert!(second > first);
        assert_eq!(GENERATION.load(Ordering::SeqCst), second);
    }
}
