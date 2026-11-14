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
    let Some(home) = dirs_next_home() else {
        return;
    };
    let config_dir = std::env::var_os("XDG_CONFIG_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| home.join(".config"))
        .join("opencode");
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

    let providers = root
        .entry("provider")
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    let Some(providers) = providers.as_object_mut() else {
        return;
    };

    // Never touch an existing `iris` entry. Someone may have pointed it at a different
    // endpoint or trimmed the model list on purpose, and this runs on EVERY launch.
    if providers.contains_key("iris") {
        return;
    }

    let Some(iris) = seed.get("provider").and_then(|p| p.get("iris")) else {
        return;
    };
    providers.insert("iris".to_string(), iris.clone());

    match serde_json::to_string_pretty(&existing) {
        Ok(text) => {
            if let Err(e) = std::fs::write(&config_path, text + "\n") {
                eprintln!("could not update {}: {e}", config_path.display());
            } else {
                println!("added iris provider to {}", config_path.display());
            }
        }
        Err(e) => eprintln!("could not serialize merged config: {e}"),
    }
}

/// Reads a key out of ~/.iris/sdk/.env, which the installer writes at login.
///
/// Missing file, missing key and unreadable file are all the same non-fatal answer: None.
/// A user who has not logged in yet must still get a working app.
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

fn dirs_next_home() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").map(std::path::PathBuf::from)
}

fn spawn_sidecar(app: &AppHandle, port: u32) -> CommandChild {
    let log_state = app.state::<LogState>();
    let log_state_clone = log_state.inner().clone();

    // The seeded provider config says apiKey: "{env:IRIS_API_KEY}", and that substitution
    // reads the SIDECAR's environment — so without this line the provider is present and
    // every call is unauthenticated. Empty string when absent: passing it unconditionally
    // keeps both spawn branches identical, and an empty value behaves like an unset one.
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
        .env("IRIS_API_KEY", &iris_api_key)
        .env("OPENCODE_EXPERIMENTAL_ICON_DISCOVERY", "true")
        .env("OPENCODE_CLIENT", "desktop")
        .env("XDG_STATE_HOME", &state_dir)
        .args(["serve", &format!("--port={port}")])
        .spawn()
        .expect("Failed to spawn opencode");

    #[cfg(not(target_os = "windows"))]
    let (mut rx, child) = app
        .shell()
        // MUST match tauri.conf.json's externalBin ("sidecars/iris-cli") and what
        // scripts/utils.ts stages ("sidecars/iris-cli-<target>"). dev carries this same fix
        // under the name "opencode-cli" because dev bundles it under that name; the name is
        // per-branch, the fix is not. Resolving a sidecar that is not bundled fails at launch
        // with the exact error this replaced, so change this ONLY alongside those two files.
        .sidecar("iris-cli")
        .expect("Failed to resolve iris-cli sidecar")
        .env("IRIS_API_KEY", &iris_api_key)
        .env("OPENCODE_EXPERIMENTAL_ICON_DISCOVERY", "true")
        .env("OPENCODE_CLIENT", "desktop")
        .env("XDG_STATE_HOME", &state_dir)
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
            install_cli
        ])
        .setup(move |app| {
            let app = app.handle().clone();

            // FIRST, before anything tries to start: a translocated app cannot spawn its
            // sidecar, so every later step would fail in a way that looks like a bug in IRIS.
            if warn_if_translocated(&app) {
                return Ok(());
            }

            // Before the server starts: make sure this machine knows the iris provider
            // exists. Never overwrites an existing one.
            seed_iris_provider();

            // Initialize log state
            app.manage(LogState(Arc::new(Mutex::new(VecDeque::new()))));

            {
              let app = app.clone();
              tauri::async_runtime::spawn(async move {
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
