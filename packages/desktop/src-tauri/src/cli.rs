const CLI_INSTALL_DIR: &str = ".iris/bin";
const CLI_BINARY_NAME: &str = "iris";

/// The one-liner a Windows user runs to install the CLI by hand. Shown as the recovery when
/// the in-app install fails, and run by the app itself (see `install_cli_windows`).
pub const WINDOWS_INSTALL_ONE_LINER: &str = "irm heyiris.io/install-code.ps1 | iex";
#[cfg(windows)]
const WINDOWS_INSTALLER_URL: &str = "https://heyiris.io/install-code.ps1";

/// Where the CLI lives: `~/.iris/bin/iris`, or `%USERPROFILE%\.iris\bin\iris.exe` on Windows.
///
/// This read `$HOME` only and joined `iris` with no extension (#186013). Windows sets
/// USERPROFILE, not HOME, so on every Windows machine this returned None — and even with HOME
/// set, `iris` is not the file the PowerShell installer writes (`iris.exe`). Either way a CLI
/// installed by hand was never detected: cli_state() said Missing, the menu said "No CLI
/// installed", and auth-whoami said "not installed yet" on a machine where `iris` worked in
/// PowerShell. Same HOME-only defect lib.rs and login.rs already fixed (#182738) — the helper
/// had been copied rather than shared, and this copy was missed.
pub fn get_cli_install_path() -> Option<std::path::PathBuf> {
    cli_install_path_from(
        std::env::var_os("HOME"),
        std::env::var_os("USERPROFILE"),
        cfg!(windows),
    )
}

/// Pure form of `get_cli_install_path`, so the Windows rule is testable on any host.
pub(crate) fn cli_install_path_from(
    home: Option<std::ffi::OsString>,
    userprofile: Option<std::ffi::OsString>,
    windows: bool,
) -> Option<std::path::PathBuf> {
    let home = home
        .filter(|h| !h.is_empty())
        .or_else(|| userprofile.filter(|h| !h.is_empty()))?;
    let binary = if windows {
        format!("{CLI_BINARY_NAME}.exe")
    } else {
        CLI_BINARY_NAME.to_string()
    };
    let mut path = std::path::PathBuf::from(home);
    for part in CLI_INSTALL_DIR.split('/') {
        path.push(part);
    }
    path.push(binary);
    Some(path)
}

/// Never flash a console window on Windows.
///
/// The app is a GUI-subsystem process (main.rs `windows_subsystem = "windows"`), so every
/// console child it starts — `iris.exe --help`, `auth whoami`, powershell — gets a brand-new
/// console window unless told otherwise. cli_state() runs on every launch; without this each
/// launch would blink a terminal at the user. No-op everywhere else.
pub(crate) fn no_window(cmd: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Run a command to completion with a hard ceiling, capturing stdout and stderr.
///
/// `Command::output()` waits forever. The setup steps run on a thread the sign-in window is
/// waiting on, so one hung child (a prompt nobody can see, a stalled download) would leave the
/// app un-restarted — and an un-restarted app is one whose engine never received the new
/// credential (#186013). A step that times out is killed and reported, never waited on.
pub(crate) fn run_with_timeout(
    cmd: &mut std::process::Command,
    timeout: std::time::Duration,
) -> Result<std::process::Output, String> {
    use std::io::Read;
    use std::process::Stdio;

    let mut child = no_window(cmd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start: {e}"))?;

    // Drain both pipes on their own threads: a child that fills a pipe buffer blocks on write,
    // and waiting for its exit without reading would then deadlock until the timeout.
    //
    // Results come back over channels rather than join(): a grandchild the command started in
    // the background inherits the pipe and holds it open after the command itself exits, and
    // join() would then wait for THAT process — i.e. forever, for a daemon.
    fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> std::sync::mpsc::Receiver<Vec<u8>> {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_end(&mut buf);
            }
            let _ = tx.send(buf);
        });
        rx
    }
    let out_rx = drain(child.stdout.take());
    let err_rx = drain(child.stderr.take());

    let started = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if started.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("timed out after {}s", timeout.as_secs()));
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            Err(e) => return Err(format!("could not wait: {e}")),
        }
    };

    let settle = std::time::Duration::from_secs(5);
    Ok(std::process::Output {
        status,
        stdout: out_rx.recv_timeout(settle).unwrap_or_default(),
        stderr: err_rx.recv_timeout(settle).unwrap_or_default(),
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

    let Ok(output) = no_window(&mut std::process::Command::new(&path))
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

#[cfg(not(windows))]
const INSTALL_SCRIPT: &str = include_str!("../../../../install");

/// Install the real IRIS CLI. Blocking; callers put it on a worker thread.
pub(crate) fn install_cli_inner() -> Result<String, String> {
    // Serialised: the launch-time sync and the post-sign-in setup can both reach here within
    // seconds of each other on a fresh machine, and two installers racing over one binary is
    // how you get a half-written iris.exe.
    let _guard = INSTALL_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    #[cfg(windows)]
    install_cli_windows()?;

    #[cfg(not(windows))]
    install_cli_unix()?;

    verify_installed_cli()
}

static INSTALL_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Windows: run the PowerShell installer the site already serves.
///
/// This used to be `return Err("CLI installation is only supported on macOS & Linux")`
/// (#186013). The Windows installer existed the whole time — heyiris.io/install-code.ps1, the
/// one-liner the playbook page advertises — the app just never ran it. So every Windows
/// Desktop user finished sign-in with no CLI, and the failure also stranded their credential
/// (see login.rs).
///
/// Fetched, not bundled: the .ps1 is not in this repo, and the served copy is the one kept
/// current (it resolves the newest `v*` CLI release and skips `desktop-v*` tags itself).
/// Read 2026-09-18: it has no Read-Host or other prompt, reports failure with `exit 1`, and
/// installs to %USERPROFILE%\.iris\bin\iris.exe plus the user PATH — never elevated. The
/// Hive bridge step inside it needs Node.js and skips cleanly without it.
///
/// -NonInteractive so anything that ever does prompt fails instead of waiting on a console
/// nobody can see; -ExecutionPolicy Bypass for this process only; no window; hard timeout.
#[cfg(windows)]
fn install_cli_windows() -> Result<(), String> {
    let powershell = std::env::var_os("SystemRoot")
        .map(|root| {
            std::path::PathBuf::from(root)
                .join("System32")
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe")
        })
        .filter(|p| p.exists())
        .unwrap_or_else(|| std::path::PathBuf::from("powershell.exe"));

    println!("cli install (windows): running {WINDOWS_INSTALLER_URL} via {}", powershell.display());
    let output = run_with_timeout(
        std::process::Command::new(&powershell).args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &format!(
                "[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12; irm {WINDOWS_INSTALLER_URL} | iex"
            ),
        ]),
        std::time::Duration::from_secs(600),
    )
    .map_err(|e| format!("The Windows installer {e}."))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    for line in stdout.lines().chain(stderr.lines()).filter(|l| !l.trim().is_empty()) {
        println!("cli install (windows): {}", line.trim_end());
    }
    if !output.status.success() {
        // The installer prints its reason on stdout (Write-Host), not stderr — so name the last
        // thing it said from BOTH, or the error reads "failed:" followed by nothing.
        let last = stderr
            .lines()
            .chain(stdout.lines())
            .filter(|l| !l.trim().is_empty())
            .last()
            .unwrap_or("no output")
            .trim()
            .to_string();
        return Err(format!("The Windows installer failed: {last}"));
    }
    Ok(())
}

#[cfg(not(windows))]
fn install_cli_unix() -> Result<(), String> {
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
    //
    // Bounded, like every other step setup waits on: the sign-in window holds the app's
    // restart — and so the engine's credential — until this returns (#186013).
    let output = run_with_timeout(
        &mut std::process::Command::new(&temp_script),
        std::time::Duration::from_secs(600),
    )
    .map_err(|e| format!("Failed to run install script: {}", e))?;

    let _ = std::fs::remove_file(&temp_script);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Install script failed: {}", stderr));
    }
    Ok(())
}

/// Read back what the installer left, then ask it who it is. Shared by both platforms.
fn verify_installed_cli() -> Result<String, String> {
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
    let signed_in = run_with_timeout(
        std::process::Command::new(&install_path).arg("auth").arg("whoami"),
        std::time::Duration::from_secs(30),
    )
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
            let version = no_window(&mut std::process::Command::new(&path))
                .arg("--version")
                .stdin(std::process::Stdio::null())
                .output()
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "unknown".to_string());
            format!("IRIS CLI {version}\nPlatform commands OK.\n\n{path}")
        }
        CliState::Missing if cfg!(windows) => format!(
            "No CLI installed.\n\nUse IRIS -> Install CLI... to install it, or run this in PowerShell:\n  {WINDOWS_INSTALL_ONE_LINER}\n\n{path}"
        ),
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
            install_cli_automatic()
        }
        // Self-heal, in the right direction this time. Machines in the field are sitting on a
        // sidecar this app wrote over their CLI; they should recover by opening the app, not by
        // being told to run a curl|bash that the next launch would have undone anyway.
        CliState::NotThePlatformCli => {
            println!("The binary at ~/.iris/bin/iris is not the IRIS CLI — repairing it");
            install_cli_automatic()
        }
    }
}

/// How long an UNATTENDED install waits after a failed one before trying again.
///
/// On Windows the launch-time install is now real work (a ~100 MB download through
/// PowerShell), and sign-in restarts the app moments after its own attempt. Without a pause a
/// machine that cannot install — offline, proxy, blocked download — would re-download on every
/// launch, including the one straight after the failure it just reported. A user-initiated
/// install (menu, sign-in) is never throttled: someone asked.
const AUTO_INSTALL_RETRY_AFTER: std::time::Duration = std::time::Duration::from_secs(60 * 60);

fn install_failure_marker() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .or_else(|| std::env::var_os("USERPROFILE").filter(|h| !h.is_empty()))?;
    Some(std::path::PathBuf::from(home).join(".iris").join(".desktop-cli-install-failed"))
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Whether an unattended install should be skipped, given the last failure time on record.
pub(crate) fn auto_install_throttled(last_failure: Option<u64>, now: u64) -> bool {
    match last_failure {
        Some(t) if t <= now => now - t < AUTO_INSTALL_RETRY_AFTER.as_secs(),
        // A timestamp in the future is a clock change, not a reason to never retry.
        _ => false,
    }
}

/// Record the outcome of ANY install attempt, so the unattended path knows when it may retry.
pub(crate) fn record_install_outcome(ok: bool) {
    let Some(marker) = install_failure_marker() else {
        return;
    };
    if ok {
        let _ = std::fs::remove_file(&marker);
    } else {
        if let Some(dir) = marker.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&marker, now_secs().to_string());
    }
}

/// The launch-time install: throttled after a failure, logged either way.
fn install_cli_automatic() -> Result<(), String> {
    let last_failure = install_failure_marker()
        .and_then(|m| std::fs::read_to_string(m).ok())
        .and_then(|t| t.trim().parse::<u64>().ok());
    if auto_install_throttled(last_failure, now_secs()) {
        println!(
            "CLI install skipped — the last attempt failed under {} minutes ago; retrying on a later launch",
            AUTO_INSTALL_RETRY_AFTER.as_secs() / 60
        );
        return Ok(());
    }
    let result = install_cli_inner();
    record_install_outcome(result.is_ok());
    match result {
        Ok(msg) => {
            println!("CLI install -> {msg}");
            Ok(())
        }
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::path::PathBuf;

    #[test]
    fn windows_without_home_uses_userprofile_and_exe() {
        // The #186013 machine: HOME unset, USERPROFILE set.
        let p = cli_install_path_from(None, Some(OsString::from(r"C:\Users\isifu")), true).unwrap();
        let mut want = PathBuf::from(r"C:\Users\isifu");
        want.push(".iris");
        want.push("bin");
        want.push("iris.exe");
        assert_eq!(p, want);
    }

    #[test]
    fn windows_with_empty_home_falls_back_to_userprofile() {
        let p = cli_install_path_from(Some(OsString::new()), Some(OsString::from("C:/Users/x")), true)
            .unwrap();
        assert!(p.starts_with("C:/Users/x"));
        assert_eq!(p.file_name().unwrap(), "iris.exe");
    }

    #[test]
    fn unix_is_unchanged() {
        let p = cli_install_path_from(Some(OsString::from("/Users/a")), Some(OsString::from("/ignored")), false)
            .unwrap();
        assert_eq!(p, PathBuf::from("/Users/a/.iris/bin/iris"));
    }

    #[test]
    fn no_home_at_all_is_none_not_a_relative_path() {
        assert_eq!(cli_install_path_from(None, None, true), None);
        assert_eq!(cli_install_path_from(Some(OsString::new()), Some(OsString::new()), false), None);
    }

    #[test]
    fn unattended_install_waits_an_hour_after_a_failure() {
        let now = 1_000_000;
        assert!(!auto_install_throttled(None, now));
        assert!(auto_install_throttled(Some(now - 60), now));
        assert!(!auto_install_throttled(Some(now - 3600), now));
        assert!(!auto_install_throttled(Some(now + 500), now), "future stamp must not block forever");
    }

    #[test]
    fn a_hung_child_is_killed_not_waited_on() {
        #[cfg(unix)]
        let mut cmd = {
            let mut c = std::process::Command::new("sleep");
            c.arg("30");
            c
        };
        #[cfg(windows)]
        let mut cmd = {
            let mut c = std::process::Command::new("ping");
            c.args(["-n", "30", "127.0.0.1"]);
            c
        };
        let started = std::time::Instant::now();
        let r = run_with_timeout(&mut cmd, std::time::Duration::from_millis(500));
        assert!(r.is_err());
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
    }

    #[test]
    fn output_is_captured_from_both_streams() {
        #[cfg(unix)]
        let mut cmd = {
            let mut c = std::process::Command::new("sh");
            c.args(["-c", "echo out; echo err 1>&2; exit 3"]);
            c
        };
        #[cfg(windows)]
        let mut cmd = {
            let mut c = std::process::Command::new("cmd");
            c.args(["/C", "echo out & echo err 1>&2 & exit 3"]);
            c
        };
        let o = run_with_timeout(&mut cmd, std::time::Duration::from_secs(10)).unwrap();
        assert_eq!(o.status.code(), Some(3));
        assert!(String::from_utf8_lossy(&o.stdout).contains("out"));
        assert!(String::from_utf8_lossy(&o.stderr).contains("err"));
    }
}
