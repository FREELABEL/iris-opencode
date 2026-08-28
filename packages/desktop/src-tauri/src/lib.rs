mod cli;
mod window_customizer;

use cli::{install_cli, sync_cli};
use std::{
    collections::VecDeque,
    net::{SocketAddr, TcpListener},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{
    path::BaseDirectory, AppHandle, LogicalSize, Manager, RunEvent, WebviewUrl, WebviewWindow,
};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogResult};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::net::TcpSocket;

use crate::window_customizer::PinchZoomDisablePlugin;

#[derive(Clone)]
struct ServerState(Arc<Mutex<Option<CommandChild>>>);

#[derive(Clone)]
struct LogState(Arc<Mutex<VecDeque<String>>>);

const MAX_LOG_ENTRIES: usize = 200;

#[tauri::command]
fn kill_sidecar(app: AppHandle) {
    let Some(server_state) = app.try_state::<ServerState>() else {
        println!("Server not running");
        return;
    };

    let Some(server_state) = server_state
        .0
        .lock()
        .expect("Failed to acquire mutex lock")
        .take()
    else {
        println!("Server state missing");
        return;
    };

    let _ = server_state.kill();

    println!("Killed server");
}

#[tauri::command]
async fn copy_logs_to_clipboard(app: AppHandle) -> Result<(), String> {
    let log_state = app.try_state::<LogState>().ok_or("Log state not found")?;

    let logs = log_state
        .0
        .lock()
        .map_err(|_| "Failed to acquire log lock")?;

    let log_text = logs.iter().cloned().collect::<Vec<_>>().join("");

    app.clipboard()
        .write_text(log_text)
        .map_err(|e| format!("Failed to copy to clipboard: {}", e))?;

    Ok(())
}

#[tauri::command]
async fn get_logs(app: AppHandle) -> Result<String, String> {
    let log_state = app.try_state::<LogState>().ok_or("Log state not found")?;

    let logs = log_state
        .0
        .lock()
        .map_err(|_| "Failed to acquire log lock")?;

    Ok(logs.iter().cloned().collect::<Vec<_>>().join(""))
}

fn get_sidecar_port() -> u32 {
    option_env!("OPENCODE_PORT")
        .map(|s| s.to_string())
        .or_else(|| std::env::var("OPENCODE_PORT").ok())
        .and_then(|port_str| port_str.parse().ok())
        .unwrap_or_else(|| {
            TcpListener::bind("127.0.0.1:0")
                .expect("Failed to bind to find free port")
                .local_addr()
                .expect("Failed to get local address")
                .port()
        }) as u32
}

/// The baseline instruction that tells the agent it is IRIS.
///
/// Compiled into the binary so it ships. Until now this text existed only as an untracked
/// file on one developer's laptop (`~/.config/opencode/AGENTS.md`) — written by no installer,
/// referenced in no repo — which meant every client install was a generic coding agent that
/// did not know it was IRIS, that `iris leads` existed, or that it could drive the platform.
const IRIS_BASELINE_AGENTS_MD: &str = include_str!("../resources/iris-agents.md");

/// Seed `~/.config/opencode/AGENTS.md` if, and only if, it does not already exist.
///
/// The engine (session/instruction.ts `systemPaths`) walks a list of global instruction files
/// and takes the FIRST that exists, then breaks — `~/.config/opencode/AGENTS.md` before
/// `~/.claude/CLAUDE.md`. So writing that path is enough to reach the system prompt, and needs
/// no patch to upstream's engine, which keeps future rebases cheap.
///
/// NEVER overwrites. A user who has customised this file has said something we should not
/// silently discard on next launch, and a user with their own `~/.claude/CLAUDE.md` and no
/// AGENTS.md is deliberately choosing that one — seeding ours would hijack the precedence.
/// Every failure here is non-fatal: a missing instruction file degrades the agent, it does not
/// break the app, so a read-only home directory must not stop the app from starting.
/// The directory the CLI actually reads its global config from.
///
/// This must match `Global.Path.config` on the TypeScript side — `session/instruction.ts`
/// loads `<that dir>/AGENTS.md`, and the config loader reads `<that dir>/opencode.json` from
/// the same place. Hardcoding `~/.config` here (as the instruction seeder used to) means that
/// on any machine with XDG_CONFIG_HOME set, the file is written somewhere the agent never
/// looks — and the symptom is an agent with no IRIS context and no error anywhere.
fn opencode_config_dir() -> Option<std::path::PathBuf> {
    // Resolve from home explicitly rather than via unwrap_or_default(): defaulting an absent
    // home to an empty PathBuf and then joining ".config" produced the RELATIVE path
    // ".config", which is not empty, passed the guard, and made every seed land under the
    // process's working directory instead of the user's home. Absent must stay absent.
    let base = match std::env::var_os("XDG_CONFIG_HOME") {
        Some(v) if !v.is_empty() => std::path::PathBuf::from(v),
        _ => dirs_next_home()?.join(".config"),
    };
    // Belt and braces: a relative config dir is never right, and writing to one is worse than
    // not writing at all — it is invisible, and it silently disables the provider lock.
    if base.as_os_str().is_empty() || base.is_relative() {
        eprintln!(
            "refusing to use a non-absolute config dir ({}); skipping seed",
            base.display()
        );
        return None;
    }
    Some(base.join("opencode"))
}

fn seed_iris_instructions() {
    let Some(dir) = opencode_config_dir() else {
        return;
    };
    let target = dir.join("AGENTS.md");
    if target.exists() {
        return;
    }
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    match std::fs::write(&target, IRIS_BASELINE_AGENTS_MD) {
        Ok(()) => println!("Seeded IRIS baseline instructions at {}", target.display()),
        Err(e) => eprintln!("Could not seed IRIS instructions ({e}) — continuing without them"),
    }
}

/// Read a single key out of `~/.iris/sdk/.env`.
///
/// The IRIS provider is configured in opencode.json as an openai-compatible endpoint whose
/// apiKey the engine expects to find in the environment. A GUI app launched from Finder
/// inherits none of the user's shell, so `IRIS_API_KEY` is simply absent — verified: zero
/// occurrences in the running app's environment, and every IRIS model call came back
/// HTTP 401 "Provide a Bearer token" while the model LIST looked perfectly healthy.
///
/// The alternative (pasting the key into opencode.json) works on one machine and cannot
/// ship: no client's config can carry someone else's credential.
///
/// Missing file, missing key and unreadable file are all the same non-fatal answer: None.
/// A user who has not run `iris-login` yet must still get a working app.
fn iris_env_value(key: &str) -> Option<String> {
    let path = dirs_next_home()?.join(".iris").join("sdk").join(".env");
    let contents = std::fs::read_to_string(path).ok()?;
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // KEY=value, tolerating `export KEY=value` and surrounding quotes.
        let line = line.strip_prefix("export ").unwrap_or(line);
        if let Some((k, v)) = line.split_once('=') {
            if k.trim() == key {
                let v = v.trim().trim_matches('"').trim_matches('\'');
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}

/// The user's home directory.
///
/// This read `$HOME` only. Windows does not set HOME — it sets USERPROFILE — so on every
/// Windows machine this returned None, and the caller's `unwrap_or_default().join(".config")`
/// turned that into the RELATIVE path `.config`, which is not empty and therefore sailed
/// straight through the `is_empty()` guard below.
///
/// The app then wrote `AGENTS.md` and `opencode.json` into `.config\opencode\` relative to
/// whatever its working directory happened to be. Both seeds silently missed, on 100% of
/// Windows installs, with no error anywhere.
///
/// Seen on a client's machine 2026-08-28, and it explained two separate symptoms at once:
/// her agent introduced itself as "the opencode CLI" and told her IRIS OS did not exist
/// (no identity file), and it ran on `opencode/hy3-free` rather than our proxy (no provider
/// config, so `enabled_providers`/`disabled_providers` never applied and her usage bypassed
/// our billing entirely).
fn dirs_next_home() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

// macOS runs a QUARANTINED app from a randomized read-only mount under
// /private/var/folders/.../AppTranslocation/ instead of from where it actually lives. This
// happens whenever someone double-clicks the app inside the .dmg, or runs it straight out of
// Downloads, rather than dragging it to Applications first.
//
// Under translocation the sidecar never spawns, and the UI reports "Could not reach Local ·
// Retrying automatically…" forever. Observed 2026-08-27: the translocated process had no
// iris-cli child at all, while the SAME build running from /Applications was healthy at the
// same moment.
//
// That message is indistinguishable from a real connection bug — it is the identical sentence
// the August splash-hang produced — so without this check the user, and whoever they report it
// to, both start debugging the app instead of moving it. Switching the download page to .dmg
// makes this MORE likely, not less, because a disk image is exactly what people open and run
// from.
#[cfg(target_os = "macos")]
fn translocated_from() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let path = exe.to_string_lossy().to_string();
    if path.contains("/AppTranslocation/") {
        Some(path)
    } else {
        None
    }
}

#[cfg(not(target_os = "macos"))]
fn translocated_from() -> Option<String> {
    None
}

// Tell the user what is wrong and what to do about it, then quit. Continuing is not an option
// worth offering: the sidecar cannot start from here, so every screen after this one would be
// a slower, more confusing version of the same failure.
const TRANSLOCATION_MESSAGE: &str = concat!(
    "IRIS is running from a temporary read-only copy, so it cannot start its local server.",
    "\n\n",
    "This happens when the app is opened directly from the disk image or from Downloads.",
    "\n\n",
    "To fix it: drag IRIS into your Applications folder, then open it from there.",
);

/// Run one of a FIXED set of IRIS maintenance actions and return its combined output.
///
/// A client spent tonight in a terminal running `iris-daemon register` because the app gave
/// her no way to do it — while the app is meant to be the front door. These are the actions
/// people actually need after install, so they belong in the menu.
///
/// The action is matched against an ALLOWLIST and mapped to argv here. It is never
/// interpolated into a shell string: a menu handler that forwards arbitrary text to a shell
/// is a remote-code-execution hole the moment anything but the menu can call it, and Tauri
/// commands are reachable from page JavaScript.
#[tauri::command]
async fn iris_action(action: String) -> Result<String, String> {
    let (bin, args): (&str, &[&str]) = match action.as_str() {
        "daemon-status" => ("iris-daemon", &["status"]),
        "daemon-restart" => ("iris-daemon", &["restart"]),
        "daemon-register" => ("iris-daemon", &["register"]),
        "auth-whoami" => ("iris", &["auth", "whoami"]),
        other => return Err(format!("unknown action: {other}")),
    };

    let home = dirs_next_home().ok_or_else(|| "no HOME".to_string())?;
    let path = home.join(".iris").join("bin").join(bin);
    if !path.exists() {
        return Err(format!(
            "{bin} is not installed yet.\n\nUse IRIS -> Install CLI... first."
        ));
    }

    // The daemon subcommands talk to the platform and can take a while (register does a
    // round-trip); run off the UI thread so the menu does not appear frozen.
    let out = tauri::async_runtime::spawn_blocking(move || {
        std::process::Command::new(&path).args(args).output()
    })
    .await
    .map_err(|e| format!("could not run {bin}: {e}"))?
    .map_err(|e| format!("could not run {bin}: {e}"))?;

    let mut text = String::from_utf8_lossy(&out.stdout).to_string();
    let err = String::from_utf8_lossy(&out.stderr);
    if !err.trim().is_empty() {
        text.push_str(&format!("\n{err}"));
    }
    if text.trim().is_empty() {
        text = format!("{bin} {} finished with no output.", args.join(" "));
    }
    // A non-zero exit is still worth SHOWING — the daemon prints its reason on stderr, and
    // hiding it behind a generic failure is what sent people to the terminal in the first place.
    if out.status.success() {
        Ok(text)
    } else {
        Err(text)
    }
}

fn warn_if_translocated(app: &AppHandle) -> bool {
    let Some(path) = translocated_from() else {
        return false;
    };

    eprintln!("IRIS is translocated ({path}); sidecar cannot start. Asking user to move it.");

    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

        let app_for_exit = app.clone();
        // NOT blocking_show(): the plugin documents it as unsafe on the main thread, and
        // setup() IS the main thread — using it here deadlocks at launch, which would be a
        // worse bug than the one being reported. Show asynchronously and quit in the callback,
        // once the user has actually read it.
        app.dialog()
            .message(TRANSLOCATION_MESSAGE)
            .title("Move IRIS to Applications")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCustom("Quit".to_string()))
            .show(move |_| {
                app_for_exit.exit(1);
            });
    }

    // No window and no sidecar are created. On macOS the event loop keeps the process alive
    // while the dialog is up; the callback above ends it.
    #[cfg(not(target_os = "macos"))]
    app.exit(1);

    true
}

/// The `iris` provider definition, compiled into the binary.
///
/// Until 2026-08-27 NOTHING shipped this. Not the app, not the repo, not the 124KB
/// installer. It existed only in one laptop's ~/.config/opencode/opencode.json — a file
/// recovered that day from the RAM of a sidecar whose bundle had already been deleted.
/// Measured on a clean machine under an isolated HOME, the shipped app served the
/// `opencode` provider with 29 models. So every download we handed out was a user pointed
/// at someone else's models, someone else's routing, and someone else's billing.
const IRIS_PROVIDER_JSON: &str = include_str!("../resources/iris-provider.json");

/// The credential is NOT in that file — it is `{env:IRIS_API_KEY}`, resolved by the CLI's
/// config loader from the process env, which spawn_sidecar populates from
/// ~/.iris/sdk/.env. A shipped artifact must never carry a real key.
fn seed_iris_provider() {
    let Some(config_dir) = opencode_config_dir() else {
        return;
    };
    let config_path = config_dir.join("opencode.json");

    let seed: serde_json::Value = match serde_json::from_str(IRIS_PROVIDER_JSON) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("iris provider seed is not valid JSON, skipping: {e}");
            return;
        }
    };

    // No config yet: write ours and stop.
    if !config_path.exists() {
        if let Err(e) = std::fs::create_dir_all(&config_dir) {
            eprintln!("could not create {}: {e}", config_dir.display());
            return;
        }
        match serde_json::to_string_pretty(&seed) {
            Ok(text) => {
                if let Err(e) = std::fs::write(&config_path, text + "\n") {
                    eprintln!("could not write {}: {e}", config_path.display());
                } else {
                    println!("seeded iris provider -> {}", config_path.display());
                }
            }
            Err(e) => eprintln!("could not serialize iris provider seed: {e}"),
        }
        return;
    }

    // A config exists. Read it, and BAIL on anything unexpected: a user's config is their
    // own, and silently rewriting one we failed to understand would be far worse than
    // shipping without the provider.
    let Ok(existing_text) = std::fs::read_to_string(&config_path) else {
        eprintln!("could not read {}, leaving it alone", config_path.display());
        return;
    };
    let Ok(mut existing) = serde_json::from_str::<serde_json::Value>(&existing_text) else {
        eprintln!(
            "{} is not parseable JSON (jsonc?), leaving it alone",
            config_path.display()
        );
        return;
    };
    let Some(root) = existing.as_object_mut() else {
        return;
    };

    // Carry over the seed's other top-level keys (model, disabled_providers) ONLY when the
    // user has not set them. Same rule as the provider itself: fill a gap, never overwrite a
    // choice. Someone who picked a different default model keeps it.
    //
    // Done BEFORE the `provider` entry is borrowed below — doing it after would hold a
    // mutable borrow of `root` across a second use of `root`, which is the sort of thing
    // that compiles on one Rust edition and not the next.
    let mut changed = false;
    if let Some(seed_obj) = seed.as_object() {
        for (k, v) in seed_obj {
            if k != "provider" && !root.contains_key(k) {
                root.insert(k.clone(), v.clone());
                changed = true;
            }
        }
    }

    let providers = root
        .entry("provider")
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    let Some(providers) = providers.as_object_mut() else {
        return;
    };

    // Never touch an existing `iris` entry. Someone may have pointed it at a different
    // endpoint or trimmed the model list on purpose, and this runs on EVERY launch. Falling
    // through rather than returning: the top-level keys above may still need saving, and an
    // early return here would silently discard them.
    if !providers.contains_key("iris") {
        if let Some(iris) = seed.get("provider").and_then(|p| p.get("iris")) {
            providers.insert("iris".to_string(), iris.clone());
            changed = true;
        }
    }

    if !changed {
        return;
    }

    match serde_json::to_string_pretty(&existing) {
        Ok(text) => {
            if let Err(e) = std::fs::write(&config_path, text + "\n") {
                eprintln!("could not update {}: {e}", config_path.display());
            } else {
                println!("updated {}", config_path.display());
            }
        }
        Err(e) => eprintln!("could not serialize merged config: {e}"),
    }
}

fn spawn_sidecar(app: &AppHandle, port: u32) -> CommandChild {
    let log_state = app.state::<LogState>();
    let log_state_clone = log_state.inner().clone();

    // Empty string when absent: passing the var through unconditionally keeps both spawn
    // branches identical, and an empty value behaves the same as an unset one downstream.
    let iris_api_key = iris_env_value("IRIS_API_KEY").unwrap_or_default();

    let state_dir = app
        .path()
        .resolve("", BaseDirectory::AppLocalData)
        .expect("Failed to resolve app local data dir");

    #[cfg(target_os = "windows")]
    let (mut rx, child) = app
        .shell()
        .sidecar("iris-cli")
        .unwrap()
        .env("OPENCODE_EXPERIMENTAL_ICON_DISCOVERY", "true")
        .env("OPENCODE_CLIENT", "desktop")
        .env("XDG_STATE_HOME", &state_dir)
        .env("IRIS_API_KEY", &iris_api_key)
        .args(["serve", &format!("--port={port}")])
        .spawn()
        .expect("Failed to spawn opencode");

    #[cfg(not(target_os = "windows"))]
    let (mut rx, child) = app
        .shell()
        .sidecar("iris-cli")
        .expect("Failed to resolve iris-cli sidecar")
        .env("OPENCODE_EXPERIMENTAL_ICON_DISCOVERY", "true")
        .env("OPENCODE_CLIENT", "desktop")
        .env("XDG_STATE_HOME", &state_dir)
        .env("IRIS_API_KEY", &iris_api_key)
        .args(["serve", &format!("--port={port}")])
        .spawn()
        .expect("Failed to spawn opencode");

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line_bytes) => {
                    let line = String::from_utf8_lossy(&line_bytes);
                    print!("{line}");

                    // Store log in shared state
                    if let Ok(mut logs) = log_state_clone.0.lock() {
                        logs.push_back(format!("[STDOUT] {}", line));
                        // Keep only the last MAX_LOG_ENTRIES
                        while logs.len() > MAX_LOG_ENTRIES {
                            logs.pop_front();
                        }
                    }
                }
                CommandEvent::Stderr(line_bytes) => {
                    let line = String::from_utf8_lossy(&line_bytes);
                    eprint!("{line}");

                    // Store log in shared state
                    if let Ok(mut logs) = log_state_clone.0.lock() {
                        logs.push_back(format!("[STDERR] {}", line));
                        // Keep only the last MAX_LOG_ENTRIES
                        while logs.len() > MAX_LOG_ENTRIES {
                            logs.pop_front();
                        }
                    }
                }
                _ => {}
            }
        }
    });

    child
}

async fn is_server_running(port: u32) -> bool {
    TcpSocket::new_v4()
        .unwrap()
        .connect(SocketAddr::new(
            "127.0.0.1".parse().expect("Failed to parse IP"),
            port as u16,
        ))
        .await
        .is_ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let updater_enabled = option_env!("TAURI_SIGNING_PRIVATE_KEY").is_some();

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(PinchZoomDisablePlugin)
        .invoke_handler(tauri::generate_handler![
            kill_sidecar,
            copy_logs_to_clipboard,
            get_logs,
            install_cli,
            iris_action
        ])
        .setup(move |app| {
            let app = app.handle().clone();

            // FIRST, before anything tries to start: a translocated app cannot spawn its
            // sidecar, so every later step would fail in a way that looks like a bug in IRIS.
            if warn_if_translocated(&app) {
                return Ok(());
            }

            // Initialize log state
            app.manage(LogState(Arc::new(Mutex::new(VecDeque::new()))));

            {
              let app = app.clone();
              tauri::async_runtime::spawn(async move {
                  // Before the server starts: make sure the agent has something telling it
                  // it is IRIS. No-ops when the user already has an AGENTS.md.
                  seed_iris_instructions();

                  // And that the iris provider exists. Never overwrites an existing one.
                  seed_iris_provider();

                  let port = get_sidecar_port();

                  let should_spawn_sidecar = !is_server_running(port).await;

                  let child = if should_spawn_sidecar {
                      let child = spawn_sidecar(&app, port);

                      let timestamp = Instant::now();
                      loop {
                          if timestamp.elapsed() > Duration::from_secs(7) {
                              let res = app.dialog()
                                .message("Failed to spawn IRIS Server. Copy logs using the button below and send them to the team for assistance.")
                                .title("Startup Failed")
                                .buttons(MessageDialogButtons::OkCancelCustom("Copy Logs And Exit".to_string(), "Exit".to_string()))
                                .blocking_show_with_result();

                              if matches!(&res, MessageDialogResult::Custom(name) if name == "Copy Logs And Exit") {
                                  match copy_logs_to_clipboard(app.clone()).await {
                                      Ok(()) => println!("Logs copied to clipboard successfully"),
                                      Err(e) => println!("Failed to copy logs to clipboard: {}", e),
                                  }
                              }

                              app.exit(1);

                              return;
                          }

                          tokio::time::sleep(Duration::from_millis(10)).await;

                          if is_server_running(port).await {
                              // give the server a little bit more time to warm up
                              tokio::time::sleep(Duration::from_millis(10)).await;

                              break;
                          }
                      }

                      println!("Server ready after {:?}", timestamp.elapsed());

                      Some(child)
                  } else {
                      None
                  };

                  let primary_monitor = app.primary_monitor().ok().flatten();
                  let size = primary_monitor
                      .map(|m| m.size().to_logical(m.scale_factor()))
                      .unwrap_or(LogicalSize::new(1920, 1080));

                  let mut window_builder =
                      WebviewWindow::builder(&app, "main", WebviewUrl::App("/".into()))
                          .title("IRIS")
                          .inner_size(size.width as f64, size.height as f64)
                          .decorations(true)
                          .zoom_hotkeys_enabled(true)
                          .disable_drag_drop_handler()
                          .initialization_script(format!(
                              r#"
                            window.__OPENCODE__ ??= {{}};
                            window.__OPENCODE__.updaterEnabled = {updater_enabled};
                            window.__OPENCODE__.port = {port};
                          "#
                          ));

                  #[cfg(target_os = "macos")]
                  {
                      window_builder = window_builder
                          .title_bar_style(tauri::TitleBarStyle::Overlay)
                          .hidden_title(true);
                  }

                  window_builder.build().expect("Failed to create window");

                  app.manage(ServerState(Arc::new(Mutex::new(child))));
              });
            }

            {
              let app = app.clone();
              tauri::async_runtime::spawn(async move {
                if let Err(e) = sync_cli(app) {
                  eprintln!("Failed to sync CLI: {e}");
                }
              });
            }

            Ok(())
        });

    if updater_enabled {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                println!("Received Exit");

                kill_sidecar(app.clone());
            }
        });
}
