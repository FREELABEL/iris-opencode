const CLI_INSTALL_DIR: &str = ".iris/bin";
const CLI_BINARY_NAME: &str = "iris";

fn get_cli_install_path() -> Option<std::path::PathBuf> {
    std::env::var("HOME").ok().map(|home| {
        std::path::PathBuf::from(home)
            .join(CLI_INSTALL_DIR)
            .join(CLI_BINARY_NAME)
    })
}

/// Path to the bundled sidecar, or None when it cannot be determined.
///
/// This used to `.expect()`. That was survivable while it only ran when a user explicitly
/// chose "Install CLI...", but CLI install now runs automatically for anyone without one — so
/// a panic here became a crash on the startup path for every new user.
///
/// And it does panic in reality: `current_exe()` refuses a path containing a symlink on macOS
/// ("StartingBinary found current_exe() that contains a symlink on a non-allowed platform:
/// /var"), which is exactly what an app launched from anywhere under /var/folders gets —
/// including a translocated copy. Caught by verify-shipped-app.sh running the real bundle out
/// of mktemp, minutes after the auto-install shipped.
pub fn get_sidecar_path() -> Option<std::path::PathBuf> {
    let exe = tauri::utils::platform::current_exe()
        .or_else(|_| std::env::current_exe())
        .ok()?;
    Some(exe.parent()?.join("iris-cli"))
}

fn is_cli_installed() -> bool {
    get_cli_install_path()
        .map(|path| path.exists())
        .unwrap_or(false)
}

const INSTALL_SCRIPT: &str = include_str!("../../../../install");

#[tauri::command]
pub fn install_cli() -> Result<String, String> {
    if cfg!(not(unix)) {
        return Err("CLI installation is only supported on macOS & Linux".to_string());
    }

    let Some(sidecar) = get_sidecar_path() else {
        return Err("Could not locate the bundled CLI next to the app".to_string());
    };
    if !sidecar.exists() {
        return Err("Sidecar binary not found".to_string());
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

    let output = std::process::Command::new(&temp_script)
        .arg("--binary")
        .arg(&sidecar)
        .output()
        .map_err(|e| format!("Failed to run install script: {}", e))?;

    let _ = std::fs::remove_file(&temp_script);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Install script failed: {}", stderr));
    }

    let install_path =
        get_cli_install_path().ok_or_else(|| "Could not determine install path".to_string())?;

    // "Installed" is not "usable", and reporting the first as if it were the second is what
    // sent a client in circles on 2026-08-30.
    //
    // The install script copies the binary and fixes PATH. It performs NO sign-in and no node
    // registration — grep it for login/register/whoami/sdk/.env and you get zero hits. So on a
    // brand-new machine this returns success and leaves a CLI that answers every platform
    // command with "pass a bearer token". The menu said "CLI installed ✓" and it was, narrowly,
    // true; it was just not the fact anyone needed.
    //
    // Ask the CLI who it is. `auth whoami` is the cheapest question that distinguishes
    // "installed" from "installed and signed in", and it is the same check a human would run.
    let signed_in = std::process::Command::new(&install_path)
        .arg("auth")
        .arg("whoami")
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

pub fn sync_cli(app: tauri::AppHandle) -> Result<(), String> {
    if cfg!(debug_assertions) {
        println!("Skipping CLI sync for debug build");
        return Ok(());
    }

    // A missing CLI used to mean "skip". That made the desktop app useless as an entry
    // point: a client installed it on 2026-08-27, the app reported "No CLI installation
    // found, skipping sync", and she was left to run a curl|bash by hand — which then
    // installed an ancient version because the error message suggested one. The desktop app
    // is the front door; if the CLI is not there, put it there.
    if !is_cli_installed() {
        println!("No CLI installation found — installing it");
        return install_cli().map(|_| ());
    }

    let cli_path =
        get_cli_install_path().ok_or_else(|| "Could not determine CLI install path".to_string())?;

    let output = std::process::Command::new(&cli_path)
        .arg("--version")
        .output()
        .map_err(|e| format!("Failed to get CLI version: {}", e))?;

    if !output.status.success() {
        return Err("Failed to get CLI version".to_string());
    }

    let cli_version_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let cli_version = semver::Version::parse(&cli_version_str)
        .map_err(|e| format!("Failed to parse CLI version '{}': {}", cli_version_str, e))?;

    let app_version = app.package_info().version.clone();

    if cli_version >= app_version {
        println!(
            "CLI version {} is up to date (app version: {}), skipping sync",
            cli_version, app_version
        );
        return Ok(());
    }

    println!(
        "CLI version {} is older than app version {}, syncing",
        cli_version, app_version
    );

    install_cli()?;

    println!("Synced installed CLI");

    Ok(())
}
