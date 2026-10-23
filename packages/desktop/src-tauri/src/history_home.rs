//! The first account's chat history gets a directory IRIS owns (#189477).
//!
//! Until this, the engine for the first (default) account ran with no XDG_DATA_HOME, so its data
//! lived in `~/.local/share/opencode` (on Windows `%USERPROFILE%\.local\share\opencode`): the same
//! directory, and on the `latest` channel the same `opencode.db`, that stock OpenCode uses. Stock
//! OpenCode 2.x migrates that database in place the first time it runs — renames `session` to
//! `session_v2`, rebuilds `workspace`, deletes every `event` row — so a client who also installs it
//! has their IRIS history rewritten under them. Accounts after the first already had their own
//! XDG_DATA_HOME (`~/.iris/accounts/<id>`, accounts.rs); this gives the first one the same thing,
//! at `~/.iris/accounts/default`, through the same environment variable.
//!
//! It is people's saved conversations, so the move is a COPY and it is conservative:
//!
//! - The original directory is never modified, moved or deleted. It stays as the backup, and the
//!   CLI keeps using it.
//! - The copy goes to a staging dir, is verified, gets its marker, and only then is renamed into
//!   place. A crash at any point leaves either no `default` dir or a complete one.
//! - It runs before the engine is spawned, so the database is closed; and every file's size and
//!   modification time is checked again after the copy, so a database something else wrote to in
//!   the meantime is not used.
//! - Not enough free space, free space we cannot measure, a directory too big to copy while the
//!   person waits, any read or write error: the engine starts in the old directory, exactly as it
//!   did before, and the reason is logged. Never an empty history.
//! - It happens once. The marker inside `default` is what says it is done.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Written inside the isolated home last, before the rename. Its presence is the "done" flag.
pub const MARKER: &str = ".iris-history-copy.json";

/// Set to anything to keep the engine in the shared directory (support kill switch).
pub const OPT_OUT_ENV: &str = "IRIS_DESKTOP_SHARED_DATA_DIR";

/// Left free on the disk after the copy. A copy that would fill the disk is not attempted.
const RESERVE_BYTES: u64 = 1 << 30;

/// Above this the copy is not done at startup: the person would be looking at a blank window.
const MAX_COPY_BYTES: u64 = 4 << 30;

/// Top-level entries of the old directory that the engine does not read as history:
/// `bin` (old tool downloads; the engine keeps them in the cache dir now), `log` (rotated logs),
/// and `worktree` (git worktrees — their absolute paths are recorded in git and in the database,
/// and they keep working from where they are).
const SKIP_DIRS: [&str; 3] = ["bin", "log", "worktree"];

/// Backups people (and repair tools) leave beside the database. Not read by the engine; often as
/// big as everything else together.
fn is_backup_file(name: &str) -> bool {
    name.contains(".bak") || name.contains(".broken")
}

/// SQLite files are checked byte for byte after the copy, and re-checked for stability as a set:
/// a database and its WAL are only consistent if both were copied with no write in between.
fn is_db_family(name: &str) -> bool {
    name.ends_with(".db") || name.ends_with(".db-wal") || name.ends_with(".db-shm") || name.ends_with(".db-journal")
}

fn is_auth_file(name: &str) -> bool {
    name == "auth.json" || name == "mcp-auth.json"
}

#[derive(Debug, PartialEq)]
pub enum Choice {
    /// Run the engine with XDG_DATA_HOME = this.
    Isolated { data_home: PathBuf, copied_now: bool },
    /// Run the engine as before, in the shared directory. The string says why.
    Legacy(String),
}

/// `~/.iris/accounts/default` — the XDG_DATA_HOME of the first account's engine. Account dirs
/// are named by user id or `key-<hex>` (accounts.rs), so this cannot collide with one.
pub fn isolated_home(home: &Path) -> PathBuf {
    home.join(".iris").join("accounts").join("default")
}

/// Where the engine kept its data until now: what xdg-basedir resolves for the parent's
/// environment. Same rule on every platform, Windows included (xdg-basedir 5 has no Windows case).
pub fn legacy_data_dir(home: &Path, parent_xdg_data_home: Option<&std::ffi::OsStr>) -> PathBuf {
    match parent_xdg_data_home.filter(|v| !v.is_empty()) {
        Some(x) => PathBuf::from(x).join("opencode"),
        None => home.join(".local").join("share").join("opencode"),
    }
}

#[derive(Debug, Clone, PartialEq)]
struct Stamp {
    len: u64,
    modified: Option<SystemTime>,
}

fn stamp(path: &Path) -> std::io::Result<Stamp> {
    let m = std::fs::symlink_metadata(path)?;
    Ok(Stamp { len: m.len(), modified: m.modified().ok() })
}

#[derive(Debug)]
enum Entry {
    Dir(PathBuf),
    File(PathBuf, Stamp),
    Symlink(PathBuf),
}

#[derive(Debug, Default)]
struct Plan {
    entries: Vec<Entry>,
    bytes: u64,
}

/// Everything under `legacy` the copy will take, relative to it. Any unreadable entry is an error:
/// a partial copy would be a history with holes in it.
fn plan_copy(legacy: &Path) -> Result<Plan, String> {
    let mut plan = Plan::default();
    if !legacy.is_dir() {
        return Ok(plan);
    }
    let mut stack = vec![PathBuf::new()];
    while let Some(rel) = stack.pop() {
        let dir = legacy.join(&rel);
        let read = std::fs::read_dir(&dir).map_err(|e| format!("could not read {dir:?}: {e}"))?;
        for item in read {
            let item = item.map_err(|e| format!("could not read {dir:?}: {e}"))?;
            let name = item.file_name();
            let name_str = name.to_string_lossy();
            let child = rel.join(&name);
            let ty = item.file_type().map_err(|e| format!("could not read {:?}: {e}", legacy.join(&child)))?;
            let top = rel.as_os_str().is_empty();
            if ty.is_symlink() {
                plan.entries.push(Entry::Symlink(child));
            } else if ty.is_dir() {
                if top && SKIP_DIRS.contains(&&*name_str) {
                    continue;
                }
                plan.entries.push(Entry::Dir(child.clone()));
                stack.push(child);
            } else {
                if top && is_backup_file(&name_str) {
                    continue;
                }
                let s = stamp(&legacy.join(&child)).map_err(|e| format!("could not read {:?}: {e}", legacy.join(&child)))?;
                plan.bytes = plan.bytes.saturating_add(s.len);
                plan.entries.push(Entry::File(child, s));
            }
        }
    }
    Ok(plan)
}

fn same_bytes(a: &Path, b: &Path) -> Result<bool, String> {
    use std::io::Read;
    let open = |p: &Path| std::fs::File::open(p).map_err(|e| format!("could not reopen {p:?}: {e}"));
    let (mut fa, mut fb) = (open(a)?, open(b)?);
    let (mut ba, mut bb) = (vec![0u8; 1 << 16], vec![0u8; 1 << 16]);
    loop {
        let na = fa.read(&mut ba).map_err(|e| format!("could not reread {a:?}: {e}"))?;
        let mut filled = 0;
        while filled < na {
            let n = fb.read(&mut bb[filled..na]).map_err(|e| format!("could not reread {b:?}: {e}"))?;
            if n == 0 {
                return Ok(false);
            }
            filled += n;
        }
        if ba[..na] != bb[..na] {
            return Ok(false);
        }
        if na == 0 {
            return Ok(fb.read(&mut bb).map_err(|e| e.to_string())? == 0);
        }
    }
}

/// Copy the plan into `dst` (which must not exist) and prove the copy is the original.
fn copy_and_verify(legacy: &Path, plan: &Plan, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("could not create {dst:?}: {e}"))?;
    for entry in &plan.entries {
        match entry {
            Entry::Dir(rel) => {
                let d = dst.join(rel);
                std::fs::create_dir_all(&d).map_err(|e| format!("could not create {d:?}: {e}"))?;
            }
            Entry::File(rel, planned) => {
                let (from, to) = (legacy.join(rel), dst.join(rel));
                let n = std::fs::copy(&from, &to).map_err(|e| format!("could not copy {from:?}: {e}"))?;
                if n != planned.len {
                    return Err(format!("{from:?} changed while it was being copied"));
                }
            }
            Entry::Symlink(rel) => {
                #[cfg(unix)]
                {
                    let (from, to) = (legacy.join(rel), dst.join(rel));
                    let target = std::fs::read_link(&from).map_err(|e| format!("could not read link {from:?}: {e}"))?;
                    std::os::unix::fs::symlink(&target, &to).map_err(|e| format!("could not link {to:?}: {e}"))?;
                }
                // Windows: creating a symlink needs a privilege most people do not have. The
                // engine makes none in its data dir; one there was put by hand and stays in the
                // original.
                #[cfg(not(unix))]
                let _ = rel;
            }
        }
    }
    // Every file must still be what it was when it was planned. A database or WAL written during
    // the copy means the copied pair may not agree with each other.
    for entry in &plan.entries {
        if let Entry::File(rel, planned) = entry {
            let from = legacy.join(rel);
            let now = stamp(&from).map_err(|e| format!("could not recheck {from:?}: {e}"))?;
            if &now != planned {
                return Err(format!("{from:?} was written to while it was being copied"));
            }
            let name = rel.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let to = dst.join(rel);
            if is_db_family(&name) || is_auth_file(&name) {
                if !same_bytes(&from, &to)? {
                    return Err(format!("the copy of {from:?} does not match the original"));
                }
            } else {
                let copied = std::fs::metadata(&to).map_err(|e| format!("could not check {to:?}: {e}"))?.len();
                if copied != planned.len {
                    return Err(format!("the copy of {from:?} is {copied} bytes, not {}", planned.len));
                }
            }
        }
    }
    Ok(())
}

fn remove_stale_staging(accounts_dir: &Path) {
    if let Ok(read) = std::fs::read_dir(accounts_dir) {
        for item in read.flatten() {
            if item.file_name().to_string_lossy().starts_with(".default-staging-") {
                // Ours, from a copy that was interrupted. Never the original.
                let _ = std::fs::remove_dir_all(item.path());
            }
        }
    }
}

fn json_string(s: &Path) -> String {
    serde_json::Value::String(s.to_string_lossy().into_owned()).to_string()
}

/// Decide where the first account's engine keeps its data, copying the old directory once if
/// that has not happened yet. Never fails: the worst outcome is `Legacy`, which is today.
pub fn choose(home: &Path, parent_xdg_data_home: Option<&std::ffi::OsStr>, free_bytes: &dyn Fn(&Path) -> Option<u64>) -> Choice {
    choose_inner(home, parent_xdg_data_home, free_bytes, &|| {})
}

fn choose_inner(
    home: &Path,
    parent_xdg_data_home: Option<&std::ffi::OsStr>,
    free_bytes: &dyn Fn(&Path) -> Option<u64>,
    after_plan: &dyn Fn(),
) -> Choice {
    let target = isolated_home(home);
    if target.join(MARKER).is_file() {
        return Choice::Isolated { data_home: target, copied_now: false };
    }
    if target.exists() {
        return Choice::Legacy(format!("{target:?} exists but was not made by the history copy; it is left alone"));
    }
    let legacy = legacy_data_dir(home, parent_xdg_data_home);
    let accounts_dir = match target.parent() {
        Some(p) => p.to_path_buf(),
        None => return Choice::Legacy("no parent for the isolated home".into()),
    };
    if let Err(e) = std::fs::create_dir_all(&accounts_dir) {
        return Choice::Legacy(format!("could not create {accounts_dir:?}: {e}"));
    }
    remove_stale_staging(&accounts_dir);

    let plan = match plan_copy(&legacy) {
        Ok(p) => p,
        Err(e) => return Choice::Legacy(e),
    };
    if plan.bytes > MAX_COPY_BYTES {
        return Choice::Legacy(format!(
            "{legacy:?} holds {} MB, too much to copy while the app starts",
            plan.bytes >> 20
        ));
    }
    let need = plan.bytes.saturating_add(RESERVE_BYTES);
    match free_bytes(&accounts_dir) {
        None => return Choice::Legacy("could not measure free disk space; not copying".into()),
        Some(free) if free < need => {
            return Choice::Legacy(format!(
                "copying {} MB needs {} MB free and only {} MB is",
                plan.bytes >> 20,
                need >> 20,
                free >> 20
            ))
        }
        Some(_) => {}
    }
    after_plan();

    let staging = accounts_dir.join(format!(".default-staging-{}", std::process::id()));
    let result = copy_and_verify(&legacy, &plan, &staging.join("opencode")).and_then(|()| {
        let when = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let files = plan.entries.iter().filter(|e| matches!(e, Entry::File(..))).count();
        let marker = format!(
            "{{\n  \"from\": {},\n  \"files\": {files},\n  \"bytes\": {},\n  \"copied_at\": {when},\n  \"note\": \"A copy. The original was left in place and is not read by IRIS Desktop any more.\"\n}}\n",
            json_string(&legacy),
            plan.bytes
        );
        std::fs::write(staging.join(MARKER), marker).map_err(|e| format!("could not write the marker: {e}"))?;
        std::fs::rename(&staging, &target).map_err(|e| format!("could not move the copy into place: {e}"))
    });
    match result {
        Ok(()) => Choice::Isolated { data_home: target, copied_now: true },
        Err(e) => {
            let _ = std::fs::remove_dir_all(&staging);
            Choice::Legacy(e)
        }
    }
}

/// Bytes free for this user on the volume holding `path`.
#[cfg(unix)]
#[allow(clippy::unnecessary_cast)] // the field widths differ between macOS and Linux
pub fn free_bytes(path: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
        return None;
    }
    Some((s.f_bavail as u64).saturating_mul(s.f_frsize as u64))
}

#[cfg(windows)]
pub fn free_bytes(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut avail: u64 = 0;
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut avail, std::ptr::null_mut(), std::ptr::null_mut()) };
    if ok == 0 {
        None
    } else {
        Some(avail)
    }
}

#[cfg(not(any(unix, windows)))]
pub fn free_bytes(_path: &Path) -> Option<u64> {
    None
}

/// Keep the `iris` entry of the isolated auth store equal to the one in the old (shared) store.
///
/// Until the split they were one file, so a sign-in made by the CLI (`iris auth login` writes the
/// old store) reached the desktop's panels, which read the `iris` entry before the environment
/// (platform.ts resolveToken). Mirroring only that entry keeps that true without carrying the
/// shared file's other contents back in. Other providers' keys now belong to each side.
///
/// Leaves both files alone when either cannot be parsed. Returns whether it wrote.
pub fn mirror_iris_auth(legacy_auth: &Path, isolated_auth: &Path) -> Result<bool, String> {
    let read = |p: &Path| -> Result<Option<serde_json::Map<String, serde_json::Value>>, String> {
        match std::fs::read_to_string(p) {
            Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
                Ok(serde_json::Value::Object(m)) => Ok(Some(m)),
                _ => Err(format!("{p:?} is not a JSON object; left alone")),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("could not read {p:?}: {e}")),
        }
    };
    let wanted = read(legacy_auth)?.and_then(|m| m.get("iris").cloned());
    let current = read(isolated_auth)?;
    let have = current.as_ref().and_then(|m| m.get("iris").cloned());
    if wanted == have {
        return Ok(false);
    }
    let mut store = current.unwrap_or_default();
    match wanted {
        Some(v) => {
            store.insert("iris".into(), v);
        }
        None => {
            store.remove("iris");
        }
    }
    let text = serde_json::to_string_pretty(&serde_json::Value::Object(store)).map_err(|e| e.to_string())?;
    let tmp = isolated_auth.with_extension("json.iris-tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("could not write {tmp:?}: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, isolated_auth).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("could not replace {isolated_auth:?}: {e}")
    })?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_home(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "iris-history-{tag}-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn plenty(_: &Path) -> Option<u64> {
        Some(u64::MAX / 2)
    }
    const PLENTY: fn(&Path) -> Option<u64> = plenty;

    /// A data dir shaped like a real one (measured on a working Mac, 2026-10-14).
    fn legacy_with_history(home: &Path) -> PathBuf {
        let d = home.join(".local").join("share").join("opencode");
        for sub in ["snapshot/proj/objects", "storage/session", "tool-output", "bin", "log", "worktree/p/w"] {
            fs::create_dir_all(d.join(sub)).unwrap();
        }
        fs::write(d.join("opencode.db"), b"SQLite format 3\0history").unwrap();
        fs::write(d.join("opencode.db-wal"), b"wal frames").unwrap();
        fs::write(d.join("opencode.db-shm"), b"shm").unwrap();
        fs::write(d.join("auth.json"), br#"{"iris":{"type":"api","key":"key-a"},"openai":{"k":1}}"#).unwrap();
        fs::write(d.join("mcp-auth.json"), b"{}").unwrap();
        fs::write(d.join("snapshot/proj/objects/ab"), b"snapshot object").unwrap();
        fs::write(d.join("storage/session/s1.json"), b"{\"id\":\"s1\"}").unwrap();
        fs::write(d.join("tool-output/t1"), b"output").unwrap();
        fs::write(d.join("bin/rg"), b"a binary").unwrap();
        fs::write(d.join("log/today.log"), b"log").unwrap();
        fs::write(d.join("worktree/p/w/file"), b"worktree").unwrap();
        fs::write(d.join("opencode.db.bak.1788213821"), b"a big old backup").unwrap();
        fs::write(d.join("opencode.db.broken-seq-1788217711"), b"another").unwrap();
        d
    }

    fn snapshot_tree(root: &Path) -> Vec<(String, Vec<u8>)> {
        let mut out = vec![];
        let mut stack = vec![root.to_path_buf()];
        while let Some(d) = stack.pop() {
            for e in fs::read_dir(&d).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else {
                    out.push((p.strip_prefix(root).unwrap().to_string_lossy().into_owned(), fs::read(&p).unwrap()));
                }
            }
        }
        out.sort();
        out
    }

    fn staging_dirs(home: &Path) -> usize {
        fs::read_dir(home.join(".iris/accounts"))
            .map(|r| r.flatten().filter(|e| e.file_name().to_string_lossy().starts_with(".default-staging-")).count())
            .unwrap_or(0)
    }

    #[test]
    fn first_launch_copies_the_history_and_leaves_the_original_untouched() {
        let home = temp_home("copy");
        let legacy = legacy_with_history(&home);
        let before = snapshot_tree(&legacy);

        let choice = choose(&home, None, &PLENTY);

        let target = isolated_home(&home);
        assert_eq!(choice, Choice::Isolated { data_home: target.clone(), copied_now: true });
        let data = target.join("opencode");
        for f in ["opencode.db", "opencode.db-wal", "opencode.db-shm", "auth.json", "mcp-auth.json",
                  "snapshot/proj/objects/ab", "storage/session/s1.json", "tool-output/t1"] {
            assert_eq!(fs::read(data.join(f)).unwrap(), fs::read(legacy.join(f)).unwrap(), "{f}");
        }
        for f in ["bin", "log", "worktree", "opencode.db.bak.1788213821", "opencode.db.broken-seq-1788217711"] {
            assert!(!data.join(f).exists(), "{f} is not history and is not copied");
        }
        assert!(target.join(MARKER).is_file());
        assert_eq!(snapshot_tree(&legacy), before, "the original is never changed");
        assert_eq!(staging_dirs(&home), 0);
    }

    #[test]
    fn the_copy_happens_once() {
        let home = temp_home("once");
        let legacy = legacy_with_history(&home);
        assert!(matches!(choose(&home, None, &PLENTY), Choice::Isolated { copied_now: true, .. }));
        // The engine now writes the isolated copy; the old dir moves on without it (the CLI, or
        // stock OpenCode). A second launch must not copy the old state over the new one.
        fs::write(isolated_home(&home).join("opencode/opencode.db"), b"newer history").unwrap();
        fs::write(legacy.join("opencode.db"), b"rewritten by someone else").unwrap();

        let again = choose(&home, None, &PLENTY);

        assert_eq!(again, Choice::Isolated { data_home: isolated_home(&home), copied_now: false });
        assert_eq!(fs::read(isolated_home(&home).join("opencode/opencode.db")).unwrap(), b"newer history");
    }

    #[test]
    fn not_enough_disk_keeps_the_old_dir_and_writes_nothing() {
        let home = temp_home("full");
        let legacy = legacy_with_history(&home);
        let before = snapshot_tree(&legacy);

        let choice = choose(&home, None, &|_| Some(10 * 1024 * 1024));

        assert!(matches!(choice, Choice::Legacy(ref why) if why.contains("free")), "{choice:?}");
        assert!(!isolated_home(&home).exists());
        assert_eq!(staging_dirs(&home), 0);
        assert_eq!(snapshot_tree(&legacy), before);
    }

    #[test]
    fn free_space_that_cannot_be_measured_is_not_gambled_on() {
        let home = temp_home("unknown-free");
        legacy_with_history(&home);
        assert!(matches!(choose(&home, None, &|_| None), Choice::Legacy(_)));
        assert!(!isolated_home(&home).exists());
    }

    #[test]
    fn a_file_that_disappears_mid_copy_falls_back_and_cleans_up() {
        let home = temp_home("vanish");
        let legacy = legacy_with_history(&home);
        let gone = legacy.join("tool-output/t1");

        let choice = choose_inner(&home, None, &PLENTY, &|| fs::remove_file(&gone).unwrap());

        assert!(matches!(choice, Choice::Legacy(_)), "{choice:?}");
        assert!(!isolated_home(&home).exists(), "never start from a partial copy");
        assert_eq!(staging_dirs(&home), 0, "the partial copy is removed");
        assert!(legacy.join("opencode.db").exists());
    }

    #[test]
    fn a_database_written_during_the_copy_is_not_used() {
        let home = temp_home("busy");
        let legacy = legacy_with_history(&home);
        // Something else has the database open (a stock OpenCode 1.x on the same file) and
        // commits while we copy, so the copied db/WAL pair may not agree.
        let wal = legacy.join("opencode.db-wal");
        // Same length, new content: only the timestamp says it changed.
        let choice = choose_inner(&home, None, &PLENTY, &|| {
            std::thread::sleep(std::time::Duration::from_millis(50));
            fs::write(&wal, b"wal frameZ").unwrap();
        });
        assert!(matches!(choice, Choice::Legacy(ref why) if why.contains("opencode.db-wal")), "{choice:?}");
        assert!(!isolated_home(&home).exists());
        assert_eq!(staging_dirs(&home), 0);
    }

    #[test]
    fn a_default_dir_we_did_not_make_is_left_alone() {
        let home = temp_home("foreign");
        legacy_with_history(&home);
        let target = isolated_home(&home);
        fs::create_dir_all(target.join("opencode")).unwrap();
        fs::write(target.join("opencode/opencode.db"), b"someone's").unwrap();

        assert!(matches!(choose(&home, None, &PLENTY), Choice::Legacy(_)));
        assert_eq!(fs::read(target.join("opencode/opencode.db")).unwrap(), b"someone's");
        assert!(!target.join(MARKER).exists());

        // Empty, too: an empty dir could be renamed over on Unix, and would then hold a copy we
        // never decided to make.
        let home = temp_home("foreign-empty");
        legacy_with_history(&home);
        fs::create_dir_all(isolated_home(&home)).unwrap();
        assert!(matches!(choose(&home, None, &PLENTY), Choice::Legacy(_)));
        assert!(fs::read_dir(isolated_home(&home)).unwrap().next().is_none());
    }

    #[test]
    fn a_new_machine_starts_isolated_with_nothing_to_copy() {
        let home = temp_home("fresh");
        let choice = choose(&home, None, &PLENTY);
        assert_eq!(choice, Choice::Isolated { data_home: isolated_home(&home), copied_now: true });
        assert!(isolated_home(&home).join("opencode").is_dir());
        assert!(!home.join(".local/share/opencode").exists(), "nothing is created in the shared dir");
    }

    #[test]
    fn an_interrupted_copy_from_a_previous_launch_is_cleared_and_redone() {
        let home = temp_home("stale");
        legacy_with_history(&home);
        let stale = home.join(".iris/accounts/.default-staging-1");
        fs::create_dir_all(stale.join("opencode")).unwrap();
        fs::write(stale.join("opencode/opencode.db"), b"half").unwrap();

        assert!(matches!(choose(&home, None, &PLENTY), Choice::Isolated { copied_now: true, .. }));
        assert!(!stale.exists());
        assert_eq!(fs::read(isolated_home(&home).join("opencode/opencode.db")).unwrap(), b"SQLite format 3\0history");
    }

    #[test]
    fn the_old_dir_follows_the_parents_xdg_data_home() {
        let home = PathBuf::from("/h");
        assert_eq!(legacy_data_dir(&home, None), PathBuf::from("/h/.local/share/opencode"));
        assert_eq!(legacy_data_dir(&home, Some(std::ffi::OsStr::new(""))), PathBuf::from("/h/.local/share/opencode"));
        assert_eq!(legacy_data_dir(&home, Some(std::ffi::OsStr::new("/x"))), PathBuf::from("/x/opencode"));
    }

    #[test]
    fn copying_from_a_custom_xdg_data_home() {
        let home = temp_home("xdg");
        let parent = home.join("xdg");
        fs::create_dir_all(parent.join("opencode")).unwrap();
        fs::write(parent.join("opencode/opencode.db"), b"custom").unwrap();
        assert!(matches!(choose(&home, Some(parent.as_os_str()), &PLENTY), Choice::Isolated { .. }));
        assert_eq!(fs::read(isolated_home(&home).join("opencode/opencode.db")).unwrap(), b"custom");
    }

    #[test]
    fn a_cli_sign_in_reaches_the_isolated_store_and_nothing_else_is_carried() {
        let home = temp_home("auth");
        let (old, new) = (home.join("old.json"), home.join("new.json"));
        fs::write(&old, r#"{"iris":{"type":"api","key":"key-new"},"openai":{"k":"cli"}}"#).unwrap();
        fs::write(&new, r#"{"iris":{"type":"api","key":"key-old"},"anthropic":{"k":"desktop"}}"#).unwrap();

        assert_eq!(mirror_iris_auth(&old, &new), Ok(true));

        let v: serde_json::Value = serde_json::from_str(&fs::read_to_string(&new).unwrap()).unwrap();
        assert_eq!(v["iris"]["key"], "key-new");
        assert_eq!(v["anthropic"]["k"], "desktop");
        assert!(v.get("openai").is_none());
        assert_eq!(mirror_iris_auth(&old, &new), Ok(false), "no write when already equal");
    }

    #[test]
    fn a_cli_sign_out_reaches_the_isolated_store() {
        let home = temp_home("auth-out");
        let (old, new) = (home.join("old.json"), home.join("new.json"));
        fs::write(&old, r#"{"openai":{"k":1}}"#).unwrap();
        fs::write(&new, r#"{"iris":{"type":"api","key":"key-a"},"x":1}"#).unwrap();
        assert_eq!(mirror_iris_auth(&old, &new), Ok(true));
        let v: serde_json::Value = serde_json::from_str(&fs::read_to_string(&new).unwrap()).unwrap();
        assert!(v.get("iris").is_none());
        assert_eq!(v["x"], 1);
    }

    #[test]
    fn an_unreadable_auth_store_is_never_rewritten() {
        let home = temp_home("auth-bad");
        let (old, new) = (home.join("old.json"), home.join("new.json"));
        fs::write(&old, r#"{"iris":{"type":"api","key":"k"}}"#).unwrap();
        fs::write(&new, "{not json").unwrap();
        assert!(mirror_iris_auth(&old, &new).is_err());
        assert_eq!(fs::read_to_string(&new).unwrap(), "{not json");
    }
}
