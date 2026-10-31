//! The engine's password, and the one file that tells local clients about it (#190647).
//!
//! Until this module the engine listened on 127.0.0.1 with NO password. Measured on a client's
//! Mac 2026-10-22: `GET http://127.0.0.1:<port>/session` answered 200 with no credentials, so any
//! process on the machine — another OS user, a malicious npm postinstall, a compromised tool —
//! could read every chat and POST messages that run the agent's tools as the person.
//!
//! Now:
//!
//! 1. **A password per app launch.** 32 bytes from the OS CSPRNG, base64url. The engine gets it as
//!    `OPENCODE_SERVER_PASSWORD` (Basic auth, username `opencode`). It is generated ONCE per app
//!    process, not per engine spawn: the supervisor respawns on the same port under a window that
//!    already holds the credential (exactly as it already holds the port), and a new password
//!    there would lock the open window out of its own engine. Quitting IRIS, or any restart the
//!    app asks for (sign-in, re-key, update), starts a new process and so a new password.
//! 2. **The window asks for it** through the `engine_credentials` command — an IPC call, so only
//!    the app's own pages can make it, rather than a value written into every document the main
//!    webview might load.
//! 3. **`~/.iris/desktop-engine.json`** for local clients that are the person's own (the Hive
//!    bridge, iris-daemon #37; the CLI's live attach, #190641). Written atomically — a 0600 temp
//!    file in the same directory, then rename — so its contents are never readable by anyone
//!    else, not even for an instant. Rewritten on every spawn (new pid), removed when the engine
//!    stops or the app quits. The daemon ignores the file unless the person owns it and nobody
//!    else can read it, so the mode is load-bearing, not tidiness.
//!
//! Windows has no mode bits. The file lives under the user's profile, whose inherited ACL already
//! limits it to that user, SYSTEM and Administrators; no extra ACL is set here.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use base64::{engine::general_purpose::STANDARD, engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

/// The engine's default `OPENCODE_SERVER_USERNAME` (packages/opencode/src/server/auth.ts).
pub const USERNAME: &str = "opencode";
/// The file local clients read. iris-daemon `lib/engine-auth.js` reads exactly this name.
pub const FILE_NAME: &str = "desktop-engine.json";
pub const FILE_VERSION: u32 = 1;

/// Bytes of randomness in a password. 32 bytes = 256 bits; base64url makes it 43 characters.
const PASSWORD_BYTES: usize = 32;

/// A fresh password from the OS CSPRNG. None only if the OS has no randomness to give, which the
/// caller treats as "start the engine the old way" rather than "start no engine".
pub fn generate_password() -> Option<String> {
    let mut bytes = [0u8; PASSWORD_BYTES];
    getrandom::getrandom(&mut bytes).ok()?;
    Some(URL_SAFE_NO_PAD.encode(bytes))
}

static PASSWORD: OnceLock<Option<String>> = OnceLock::new();

/// This app launch's engine password. Generated on first use, then the same for every respawn.
pub fn password() -> Option<&'static str> {
    PASSWORD
        .get_or_init(|| {
            let p = generate_password();
            if p.is_none() {
                eprintln!("No randomness available for the engine password — the engine starts without one");
            }
            p
        })
        .as_deref()
}

/// `Authorization` header value for a password.
pub fn basic_header_for(password: &str) -> String {
    format!("Basic {}", STANDARD.encode(format!("{USERNAME}:{password}")))
}

/// The engine this app spawned and is currently running, if any. None when the app attached to
/// an engine it did not start: there is no password of ours to offer for that one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Engine {
    pub port: u16,
    pub pid: u32,
    pub password: String,
    pub data_home: PathBuf,
}

static CURRENT: Mutex<Option<Engine>> = Mutex::new(None);

/// The credential for the engine this app runs — for the window and for the health probe.
pub fn current_password() -> Option<String> {
    CURRENT.lock().ok()?.as_ref().map(|e| e.password.clone())
}

/// The `Authorization` header for the engine this app runs, or None (attached / no password).
pub fn current_header() -> Option<String> {
    current_password().map(|p| basic_header_for(&p))
}

/// The record's JSON. Field names are the contract with iris-daemon `lib/engine-auth.js`.
pub fn record_json(engine: &Engine) -> serde_json::Value {
    serde_json::json!({
        "version": FILE_VERSION,
        "port": engine.port,
        "username": USERNAME,
        "password": engine.password,
        "pid": engine.pid,
        "data_home": engine.data_home.to_string_lossy(),
    })
}

/// `~/.iris/desktop-engine.json`.
pub fn record_path(home: &Path) -> PathBuf {
    home.join(".iris").join(FILE_NAME)
}

/// Write the record atomically, owner-only from the first byte.
///
/// The temp file is created with mode 0600 (`create_new`, so a file planted at that name is never
/// written through), filled, flushed to disk, and renamed over the target. Rename replaces a
/// symlink at the target rather than following it.
pub fn write_record(path: &Path, engine: &Engine) -> io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "record path has no directory"))?;
    create_private_dir(dir)?;

    let body = serde_json::to_vec_pretty(&record_json(engine)).map_err(io::Error::other)?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = dir.join(format!(".{FILE_NAME}.{}.{nonce}.tmp", std::process::id()));

    let result = (|| {
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts.open(&tmp)?;
        // The umask can only clear bits, but say it explicitly: the daemon refuses anything wider.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        file.write_all(&body)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn create_private_dir(dir: &Path) -> io::Result<()> {
    if dir.is_dir() {
        // An existing ~/.iris holds the person's other files; its mode is theirs to choose.
        return Ok(());
    }
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)
}

/// Remove the record, but only when it describes the engine with this pid. A record some other
/// IRIS wrote since (a preview build, a second install) is theirs to remove, not ours.
pub fn remove_record_if(path: &Path, pid: u32) -> io::Result<bool> {
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };
    let ours = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("pid").and_then(|p| p.as_u64()))
        == Some(pid as u64);
    if !ours {
        return Ok(false);
    }
    match fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// An engine this app just spawned with `password`: remember it and publish it.
pub fn note_started(home: Option<&Path>, engine: Engine) {
    if let Some(home) = home {
        let path = record_path(home);
        match write_record(&path, &engine) {
            Ok(()) => println!("Published the engine for local clients at {} (port {}, pid {})", path.display(), engine.port, engine.pid),
            Err(e) => eprintln!("Could not publish the engine at {} ({e}) — local clients will not find it", path.display()),
        }
    }
    if let Ok(mut c) = CURRENT.lock() {
        *c = Some(engine);
    }
}

/// The engine with this pid stopped (killed, crashed, or the app is quitting): withdraw its
/// record. The credential stays known to the app, because a respawn reuses it.
pub fn note_stopped(home: Option<&Path>, pid: u32) {
    if let Some(home) = home {
        let path = record_path(home);
        match remove_record_if(&path, pid) {
            Ok(true) => println!("Withdrew the engine record at {}", path.display()),
            Ok(false) => {}
            Err(e) => eprintln!("Could not remove {} ({e})", path.display()),
        }
    }
}

/// Hosts the engine answers to (`OPENCODE_SERVER_ALLOWED_HOSTS`): the two names for the loopback
/// address it listens on. A web page that rebinds its own DNS name to 127.0.0.1 still sends its
/// own name as Host, and is refused before auth is even consulted (DNS rebinding).
pub fn allowed_hosts(port: u32) -> String {
    format!("127.0.0.1:{port},localhost:{port}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_home(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("engine-auth-{tag}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn engine(pid: u32) -> Engine {
        Engine {
            port: 49244,
            pid,
            password: "pw-for-test".into(),
            data_home: PathBuf::from("/home/someone/.iris/accounts/default"),
        }
    }

    #[test]
    fn passwords_are_32_random_bytes_in_base64url() {
        let a = generate_password().unwrap();
        let b = generate_password().unwrap();
        assert_ne!(a, b, "two passwords must differ");
        assert_eq!(a.len(), 43, "32 bytes base64url without padding is 43 chars: {a}");
        assert_eq!(URL_SAFE_NO_PAD.decode(&a).unwrap().len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'), "{a}");
    }

    #[test]
    fn the_launch_password_is_stable_across_calls() {
        // The supervisor respawns under an open window; the window's credential must still work.
        assert_eq!(password(), password());
        assert!(password().is_some());
    }

    #[test]
    fn basic_header_matches_the_engine_format() {
        // auth.ts: `Basic ${base64(`${username}:${password}`)}`
        assert_eq!(basic_header_for("secret"), "Basic b3BlbmNvZGU6c2VjcmV0");
    }

    #[test]
    fn record_has_exactly_the_fields_the_daemon_reads() {
        let v = record_json(&engine(4242));
        assert_eq!(v["version"], 1);
        assert_eq!(v["port"], 49244);
        assert_eq!(v["username"], "opencode");
        assert_eq!(v["password"], "pw-for-test");
        assert_eq!(v["pid"], 4242);
        assert_eq!(v["data_home"], "/home/someone/.iris/accounts/default");
        assert_eq!(v.as_object().unwrap().len(), 6);
    }

    #[test]
    fn write_creates_the_dir_and_an_owner_only_file_with_the_record() {
        let home = tmp_home("write");
        let path = record_path(&home);
        write_record(&path, &engine(7)).unwrap();

        let back: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(back, record_json(&engine(7)));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "file mode {mode:o}");
            let dir_mode = fs::metadata(path.parent().unwrap()).unwrap().permissions().mode() & 0o777;
            assert_eq!(dir_mode & 0o077, 0, "a ~/.iris we create is private: {dir_mode:o}");
        }

        // No temp files left behind.
        let leftovers: Vec<_> = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
        let _ = fs::remove_dir_all(home);
    }

    #[cfg(unix)]
    #[test]
    fn rewriting_replaces_a_wider_file_with_an_owner_only_one() {
        use std::os::unix::fs::PermissionsExt;
        let home = tmp_home("rewrite");
        let path = record_path(&home);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

        write_record(&path, &engine(8)).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert!(fs::read_to_string(&path).unwrap().contains("\"pid\": 8"));
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn respawn_rewrites_with_the_new_pid_and_stop_removes_only_our_record() {
        let home = tmp_home("remove");
        let path = record_path(&home);
        write_record(&path, &engine(100)).unwrap();
        write_record(&path, &engine(101)).unwrap(); // respawn on the same port

        // The old engine's exit must not withdraw the new engine's record.
        assert!(!remove_record_if(&path, 100).unwrap());
        assert!(path.exists());

        assert!(remove_record_if(&path, 101).unwrap());
        assert!(!path.exists());
        // Already gone is not an error.
        assert!(!remove_record_if(&path, 101).unwrap());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn allowed_hosts_names_both_loopback_spellings_on_the_port() {
        assert_eq!(allowed_hosts(49244), "127.0.0.1:49244,localhost:49244");
    }
}
