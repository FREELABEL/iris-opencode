const CLI_INSTALL_DIR: &str = ".iris/bin";
const CLI_BINARY_NAME: &str = "iris";

pub fn get_cli_install_path() -> Option<std::path::PathBuf> {
    std::env::var("HOME").ok().map(|home| {
        std::path::PathBuf::from(home)
            .join(CLI_INSTALL_DIR)
            .join(CLI_BINARY_NAME)
    })
}

pub fn get_sidecar_path() -> std::path::PathBuf {
    tauri::utils::platform::current_exe()
        .expect("Failed to get current exe")
        .parent()
        .expect("Failed to get parent dir")
        .join("iris-cli")
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
/// `is_cli_installed()` was a `path.exists()` here, and it could not fail: a 216-module
/// platform CLI and a core-only sidecar are the same answer to it. That is what let this app
/// overwrite a user's CLI on every launch and never notice it had already done so.
///
/// DO NOT probe one command and read the exit code. Measured against both binaries:
///
///     iris atlas --help ; echo $?    ->  0   real CLI
///     iris atlas --help ; echo $?    ->  0   sidecar        <- IDENTICAL
///
/// An unrecognised command prints general help and exits 0, so a per-command probe passes on
/// both — the mistake documented in #182922, where every one of ~20 probes false-passed.
/// Compare the command LIST instead, which is unambiguous:
///
///     iris --help | grep -ci atlas   ->  11 real,  0 sidecar
///     iris --help | grep -ci bloq    ->   8 real,  0 sidecar
///
/// Match on stdout AND stderr joined, deliberately. The real CLI prints help to stdout and the
/// sidecar prints it to stderr, so a stdout-only check would happen to work today for a reason
/// that has nothing to do with what is being asked.
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

pub(crate) fn install_cli_inner() -> Result<String, String> {
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
    // line. It already resolves that correctly and on purpose: the installer enumerates
    // releases and keeps only bare `v` tags precisely so a `desktop-v*` tag can never be
    // mistaken for a CLI release.
    //
    // Deleting the flag is the whole fix. It does not merely stop the app choosing wrongly —
    // it removes the app's ability to write a non-platform binary to that path at all. Note
    // that the sidecar's existence is no longer even checked, because it is no longer read.
    //
    // stdin is explicitly null so this can never block on a prompt.
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

    Ok(install_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn install_cli() -> Result<String, String> {
    install_cli_inner()
}

/// Make sure the user has the platform CLI. Gate on IDENTITY, never on a version number.
///
/// This used to compare the CLI's version to the APP's:
///
///     if cli_version >= app_version { skip } else { install_cli() }
///
/// Those are two INDEPENDENT release series — the CLI ships `v1.3.x`, this app ships
/// `desktop-v1.18.x` — so `1.3.252 >= 1.18.60` was false forever. The comparison was not
/// stale, it was unsatisfiable, and it made the reinstall run on EVERY LAUNCH. Combined with
/// `--binary <sidecar>` above, opening the app uninstalled the product.
///
/// A version comparison cannot express "is this the right product" at all. Identity can, so
/// there is no version check here any more and the `app` handle is unused.
pub fn sync_cli(_app: tauri::AppHandle) -> Result<(), String> {
    if cfg!(debug_assertions) {
        println!("Skipping CLI sync for debug build");
        return Ok(());
    }

    match cli_state() {
        // Already the real thing. Leave it alone — this app has no business deciding that a
        // working platform CLI is the wrong version, and it has no way to know.
        CliState::PlatformCli => {
            println!("Platform CLI present — leaving it alone");
            Ok(())
        }
        // A missing CLI used to mean "skip". That made the desktop app useless as an entry
        // point: a client installed it on 2026-08-27, the app reported "No CLI installation
        // found, skipping sync", and she was left to run a curl|bash by hand — which then
        // installed an ancient version because the error message suggested one. The desktop app
        // is the front door; if the CLI is not there, put it there.
        CliState::Missing => {
            println!("No CLI installation found — installing it");
            install_cli_inner().map(|_| ())
        }
        // The repair case, and the reason this enum has three variants instead of a bool.
        // Something is at that path, it runs, and it is not the product — almost always this
        // app's own sidecar, put there by an older build of this app. Replace it.
        CliState::NotThePlatformCli => {
            println!("A binary is installed but it is NOT the platform CLI — replacing it");
            install_cli_inner().map(|_| ())
        }
    }
}
