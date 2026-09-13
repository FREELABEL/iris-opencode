const CLI_INSTALL_DIR: &str = ".iris/bin";
const CLI_BINARY_NAME: &str = "iris";

pub fn get_cli_install_path() -> Option<std::path::PathBuf> {
    std::env::var("HOME").ok().map(|home| {
        std::path::PathBuf::from(home)
            .join(CLI_INSTALL_DIR)
            .join(CLI_BINARY_NAME)
    })
}

/// What is actually sitting at ~/.iris/bin/iris.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliState {
    /// Nothing there, or a file that will not execute.
    Missing,
    /// A binary is there and runs, but it is not the IRIS platform CLI. In the field this is
    /// almost always this app's own opencode-core sidecar, written over the user's CLI by a
    /// build of IRIS Desktop from before 2026-09-12 (#183738).
    NotThePlatformCli,
    /// The real thing.
    PlatformCli,
}

/// Ask the binary WHAT IT IS, not whether a file exists.
///
/// `path.exists()` was the check here until 2026-09-12, and it could not fail: a 216-module
/// platform CLI and a core-only sidecar are the same answer to it. That is what let this app
/// overwrite a user's CLI on every launch and never notice it had already done so — including
/// live on the COO of a client's machine, mid-call, on 2026-09-04.
///
/// DO NOT probe one command and read the exit code. Measured 2026-09-12 against both binaries:
///
///     iris atlas --help ; echo $?    ->  0   real CLI
///     iris atlas --help ; echo $?    ->  0   sidecar        <- IDENTICAL
///
/// An unrecognised command prints general help and exits 0, so a per-command probe passes on
/// both — the exact mistake documented in #182922, where every one of ~20 probes false-passed.
/// Compare the command LIST instead, which is unambiguous:
///
///     iris --help | grep -ci atlas   ->  11 real,  0 sidecar
///     iris --help | grep -ci bloq    ->   8 real,  0 sidecar
///
/// Match on stdout AND stderr joined, deliberately. The real CLI prints help to stdout (14,342
/// bytes) and the sidecar prints it to stderr (0 bytes on stdout), so a stdout-only check would
/// happen to work today for a reason that has nothing to do with what is being asked. Reading
/// both makes this a question about the command surface rather than about stream choice.
pub fn cli_state() -> CliState {
    let Some(path) = get_cli_install_path() else {
        return CliState::Missing;
    };
    if !path.exists() {
        return CliState::Missing;
    }

    let Ok(output) = std::process::Command::new(&path)
        .arg("--help")
        .stdin(std::process::Stdio::null())
        .output()
    else {
        // A file that will not execute is not a CLI the user has. Treat it as missing so the
        // repair path replaces it.
        return CliState::Missing;
    };

    let mut help = String::from_utf8_lossy(&output.stdout).to_string();
    help.push_str(&String::from_utf8_lossy(&output.stderr));
    let help = help.to_lowercase();

    // Two independent markers, so renaming one command group does not silently reclassify every
    // healthy install as broken and reinstall it on every launch.
    if help.contains("atlas") && help.contains("bloq") {
        CliState::PlatformCli
    } else {
        CliState::NotThePlatformCli
    }
}

const INSTALL_SCRIPT: &str = include_str!("../../../../install");

/// Install the real IRIS CLI. Blocking; callers put it on a worker thread.
fn install_cli_inner() -> Result<String, String> {
    if cfg!(not(unix)) {
        return Err("CLI installation is only supported on macOS & Linux".to_string());
    }

    let temp_script = std::env::temp_dir().join("iris-install.sh");
    std::fs::write(&temp_script, INSTALL_SCRIPT)
        .map_err(|e| format!("Failed to write install script: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temp_script, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("Failed to set script permissions: {}", e))?;
    }

    // ADR-01: INSTALL THE REAL CLI, OR NOTHING. Never this app's sidecar.
    //
    // This used to pass `--binary <the bundled sidecar>`, which made the installer copy the
    // desktop's own opencode-core binary over ~/.iris/bin/iris. The sidecar exists for the
    // app's embedded server. It carries 0 of the 216 platform command modules and 0 of the 21
    // IRIS models, so installing it as the user's `iris` never upgraded anything — it replaced
    // the product with a different one answering to the same name, and took `iris mcp serve`
    // (and therefore the IRIS OS MCP server) with it.
    //
    // Run WITHOUT --binary and the SAME script downloads the real CLI from the `v*` release
    // line. It already resolves that correctly and on purpose: see the comment at `install`
    // line 531, which enumerates releases?per_page=30 and keeps only bare `v` tags precisely so
    // a `desktop-v*` tag can never be mistaken for a CLI release.
    //
    // Deleting the flag is the whole fix. It does not merely stop the app choosing wrongly —
    // it removes the app's ability to write a non-platform binary to that path at all.
    //
    // stdin is explicitly null so this can never block on a prompt. The script's remaining
    // interactive reads either target /dev/tty with a `|| fallback`, or sit behind `[ -t 0 ]`
    // (line 2983) — which also guards an `exec` of the TUI that must never happen here.
    let output = std::process::Command::new(&temp_script)
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("Failed to run install script: {}", e))?;

    let _ = std::fs::remove_file(&temp_script);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Install script failed: {}", stderr));
    }

    let install_path =
        get_cli_install_path().ok_or_else(|| "Could not determine install path".to_string())?;

    // A GREEN EXIT IS NOT A LANDING. Ask the path what it is now rather than trusting status 0.
    //
    // This is the check whose absence let the original bug run for two weeks: the old code
    // reported success after writing the wrong product, because nothing ever read back what it
    // had written.
    match cli_state() {
        CliState::PlatformCli => {}
        CliState::Missing => {
            return Err(format!(
                "The installer reported success but there is no working CLI at {}.\n\nNothing was installed. Check your network connection and try again.",
                install_path.to_string_lossy()
            ));
        }
        CliState::NotThePlatformCli => {
            return Err(format!(
                "The installer reported success but the binary at {} is not the IRIS platform CLI.\n\nDo not use it. Report this with bug #183738.",
                install_path.to_string_lossy()
            ));
        }
    }

    // "Installed" is not "usable", and reporting the first as if it were the second is what
    // sent a client in circles on 2026-08-30.
    //
    // The install script copies the binary and fixes PATH. It performs NO sign-in — grep it for
    // login/register/whoami/sdk/.env on the non-interactive path and you get nothing that runs.
    // So on a brand-new machine this returns success and leaves a CLI that answers every
    // platform command with "pass a bearer token". The menu said "CLI installed ✓" and it was,
    // narrowly, true; it was just not the fact anyone needed.
    //
    // Ask the CLI who it is. `auth whoami` is the cheapest question that distinguishes
    // "installed" from "installed and signed in", and it is the same check a human would run.
    let signed_in = std::process::Command::new(&install_path)
        .arg("auth")
        .arg("whoami")
        .stdin(std::process::Stdio::null())
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if !signed_in {
        // Deliberately Ok, not Err: the install genuinely succeeded and re-running it will not
        // help. This is the next step, not a failure — but it must not be silent.
        return Ok(format!(
            "{} — installed, but NOT signed in.\n\nRun in a terminal:\n  iris auth login\n\nUntil then every platform command will report a missing bearer token.",
            install_path.to_string_lossy()
        ));
    }

    Ok(install_path.to_string_lossy().to_string())
}

/// Menu action. Async + spawn_blocking because this now DOWNLOADS rather than copying a local
/// file, and a sync command would freeze the menu for the length of a ~120MB transfer — the
/// same reason `iris_action` runs off the UI thread.
#[tauri::command]
pub async fn install_cli() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(install_cli_inner)
        .await
        .map_err(|e| format!("CLI install task failed: {e}"))?
}

/// Report what the user actually has, in words, for the menu. Step 5 of #183738's fix plan:
/// the broken state used to be invisible — nothing in the UI named the CLI at all — so a
/// silently substituted binary presented as "unknown command", which reads as misconfiguration.
#[tauri::command]
pub fn cli_health() -> String {
    let path = get_cli_install_path()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "~/.iris/bin/iris".to_string());

    match cli_state() {
        CliState::PlatformCli => {
            let version = std::process::Command::new(&path)
                .arg("--version")
                .stdin(std::process::Stdio::null())
                .output()
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "unknown".to_string());
            format!("IRIS CLI {version}\nPlatform commands OK.\n\n{path}")
        }
        CliState::Missing => {
            format!("No CLI installed.\n\nUse IRIS -> Install CLI... to install it.\n\n{path}")
        }
        CliState::NotThePlatformCli => format!(
            "NOT the IRIS CLI.\n\nThe binary at this path runs, but has none of the platform commands (atlas, bloqs, pages, hive). Older builds of this app overwrote the CLI with their own core-only sidecar — bug #183738.\n\nUse IRIS -> Install CLI... to repair it.\n\n{path}"
        ),
    }
}

/// Make sure the machine has a usable IRIS CLI. Runs on every launch.
///
/// WHAT THIS NO LONGER DOES, and must never do again: compare the CLI's version to the app's.
///
///     cli 1.3.252   vs   app 1.18.60   ->   3 < 18   ->   "the CLI is stale"
///
/// Those are two independently-versioned PRODUCTS sharing one repo — the CLI ships as `v1.3.x`
/// and this app as `desktop-v1.18.x`, which inherits the upstream opencode version it was
/// ported from. There is no ordering between them, so the comparison was not mis-tuned; it was
/// meaningless in both directions, and it re-fired on every single launch because 1.3.x can
/// never reach 1.18.x. Freshness is `iris upgrade`'s job — it knows the CLI's own release line.
/// Do not re-derive it from app_version here (#183738).
///
/// The trigger is now IDENTITY, not version: install when the user has no CLI, and repair when
/// what they have is not the platform CLI. A healthy machine is left completely alone, which is
/// also what stops this running the full 3,000-line installer — and rebuilding the bridge,
/// daemon symlinks and manifest — every time the app opens.
pub fn sync_cli() -> Result<(), String> {
    if cfg!(debug_assertions) {
        println!("Skipping CLI sync for debug build");
        return Ok(());
    }

    match cli_state() {
        CliState::PlatformCli => {
            println!("IRIS CLI present with platform commands — leaving it alone");
            Ok(())
        }
        // A missing CLI used to mean "skip". That made the desktop app useless as an entry
        // point: a client installed it on 2026-08-27, the app reported "No CLI installation
        // found, skipping sync", and she was left to run a curl|bash by hand — which then
        // installed an ancient version because the error message suggested one. The desktop app
        // is the front door; if the CLI is not there, put it there.
        CliState::Missing => {
            println!("No CLI installation found — installing the IRIS CLI");
            install_cli_inner().map(|_| ())
        }
        // Self-heal, in the right direction this time. Machines in the field are sitting on a
        // sidecar this app wrote over their CLI; they should recover by opening the app, not by
        // being told to run a curl|bash that the next launch would have undone anyway.
        CliState::NotThePlatformCli => {
            println!("The binary at ~/.iris/bin/iris is not the IRIS CLI — repairing it");
            install_cli_inner().map(|_| ())
        }
    }
}
