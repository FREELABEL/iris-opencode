//! More than one IRIS account on one machine (#189321, the Desktop half of #188828).
//!
//! ~/.iris/accounts.json holds every account this machine has signed in as. The ACTIVE one stays
//! where it always was (~/.iris/sdk/.env), so nothing that reads it changes. Two jobs live here,
//! both of which run before the engine exists and so cannot be done by it:
//!
//! 1. At sign-in, keep the account being replaced (the old key would otherwise be overwritten and
//!    lost) and record the new one with the data dir it will use.
//! 2. At engine spawn, find the data dir of the account whose key is active.
//!
//! The engine owns the rest — list, switch, remove (packages/opencode/src/iris/account.ts). The
//! file's shape is shared with that code; change one, change both.
//!
//! Why a data dir per account: local chat sessions carry no account id, so without one, the first
//! account's history shows under the second. The first account keeps the default dir so nobody's
//! existing history moves. `default_owner` records whose history the default dir holds, and
//! outlives that account's removal so a later account does not inherit it.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct StoredAccount {
    pub user_id: Option<i64>,
    pub email: Option<String>,
    pub name: Option<String>,
    pub key: String,
    /// XDG_DATA_HOME for this account's engine. None = the default data dir.
    pub data_dir: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Store {
    pub version: u32,
    pub default_owner: Option<String>,
    pub accounts: Vec<StoredAccount>,
}

impl Default for Store {
    fn default() -> Self {
        Store { version: 1, default_owner: None, accounts: vec![] }
    }
}

/// Who just signed in, as the sign-in window learned it from fl-api with the new key.
#[derive(Deserialize, Clone, Debug, Default)]
pub struct Identity {
    pub user_id: Option<i64>,
    pub email: Option<String>,
    pub name: Option<String>,
}

pub fn store_path(home: &Path) -> PathBuf {
    home.join(".iris").join("accounts.json")
}

/// Ok(default) when there is no file. Err when there is one we cannot parse: it holds keys, and
/// rewriting it from empty would delete them, so every writer stops.
pub fn read_store(home: &Path) -> Result<Store, String> {
    let path = store_path(home);
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("{path:?} could not be read: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Store::default()),
        Err(e) => Err(format!("{path:?} could not be read: {e}")),
    }
}

pub fn write_store(home: &Path, store: &Store) -> Result<(), String> {
    let path = store_path(home);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Could not create {dir:?}: {e}"))?;
    }
    let mut text = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    text.push('\n');
    std::fs::write(&path, text).map_err(|e| format!("Could not write {path:?}: {e}"))?;
    // Keys to whole accounts, like ~/.iris/sdk/.env.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Directory name for an account that is not the default one. A fingerprint, never the key, when
/// fl-api could not say who it is.
fn account_dir_name(user_id: Option<i64>, key: &str) -> String {
    match user_id {
        Some(id) => id.to_string(),
        None => {
            let hex: String = Sha256::digest(key.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
            format!("key-{}", &hex[..12])
        }
    }
}

/// The data dir a newly seen account gets: the default only if nobody else's history is there.
fn data_dir_for(home: &Path, store: &Store, user_id: Option<i64>, key: &str) -> Option<String> {
    let mine = user_id.map(|id| id.to_string());
    match (&store.default_owner, &mine) {
        (None, _) => None,
        (Some(owner), Some(me)) if owner == me => None,
        _ => Some(
            home.join(".iris")
                .join("accounts")
                .join(account_dir_name(user_id, key))
                .to_string_lossy()
                .into_owned(),
        ),
    }
}

/// Record a sign-in before the key in ~/.iris/sdk/.env is replaced.
///
/// `old_key` / `old_user_id` are what .env held until now. Kept in the store if not there already,
/// so signing in as a second account does not throw the first one away.
pub fn record_sign_in(
    home: &Path,
    old_key: Option<String>,
    old_user_id: Option<i64>,
    new_key: &str,
    who: &Identity,
) -> Result<(), String> {
    let mut store = read_store(home)?;

    if let Some(old) = old_key.filter(|k| !k.is_empty() && k != new_key) {
        // A re-sign-in by the same person is not a second account.
        let same_person = old_user_id.is_some() && old_user_id == who.user_id;
        if !same_person && !store.accounts.iter().any(|a| a.key == old) {
            // The old account's history is in the default dir unless the store says otherwise.
            if store.default_owner.is_none() {
                store.default_owner = Some(old_user_id.map(|i| i.to_string()).unwrap_or_else(|| "legacy".into()));
            }
            let in_default = store.default_owner == old_user_id.map(|i| i.to_string())
                || store.default_owner.as_deref() == Some("legacy");
            store.accounts.push(StoredAccount {
                user_id: old_user_id,
                email: None,
                name: None,
                key: old.clone(),
                data_dir: if in_default { None } else { data_dir_for(home, &store, old_user_id, &old) },
            });
        }
    }

    let existing = store
        .accounts
        .iter()
        .position(|a| who.user_id.is_some() && a.user_id == who.user_id)
        .or_else(|| store.accounts.iter().position(|a| a.key == new_key));
    match existing {
        Some(i) => {
            // Same person, new key: keep their data dir, the history is there.
            let a = &mut store.accounts[i];
            a.key = new_key.to_string();
            a.user_id = who.user_id.or(a.user_id);
            a.email = who.email.clone().or(a.email.take());
            a.name = who.name.clone().or(a.name.take());
        }
        None => {
            let data_dir = data_dir_for(home, &store, who.user_id, new_key);
            if store.default_owner.is_none() && data_dir.is_none() {
                store.default_owner = who.user_id.map(|i| i.to_string());
            }
            store.accounts.push(StoredAccount {
                user_id: who.user_id,
                email: who.email.clone(),
                name: who.name.clone(),
                key: new_key.to_string(),
                data_dir,
            });
        }
    }
    write_store(home, &store)
}

/// The XDG_DATA_HOME for the engine that will run with `key`, if that account has its own.
/// An unreadable store or an unknown key is the default dir — the app must still start.
pub fn data_home_for_key(home: &Path, key: &str) -> Option<PathBuf> {
    if key.is_empty() {
        return None;
    }
    let store = read_store(home).ok()?;
    let dir = store.accounts.into_iter().find(|a| a.key == key)?.data_dir?;
    Some(PathBuf::from(dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "iris-accounts-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn who(id: i64, email: &str) -> Identity {
        Identity { user_id: Some(id), email: Some(email.into()), name: None }
    }

    #[test]
    fn first_sign_in_ever_takes_the_default_dir() {
        let home = temp_home("first");
        record_sign_in(&home, None, None, "key-a", &who(193, "a@x")).unwrap();
        let s = read_store(&home).unwrap();
        assert_eq!(s.default_owner.as_deref(), Some("193"));
        assert_eq!(s.accounts.len(), 1);
        assert_eq!(s.accounts[0].data_dir, None);
        assert_eq!(data_home_for_key(&home, "key-a"), None);
    }

    #[test]
    fn a_second_account_keeps_the_first_and_gets_its_own_dir() {
        let home = temp_home("second");
        // Upgrading machine: A signed in before this build, so the store does not exist yet.
        record_sign_in(&home, Some("key-a".into()), Some(193), "key-b", &who(5498, "b@x")).unwrap();
        let s = read_store(&home).unwrap();
        assert_eq!(s.default_owner.as_deref(), Some("193"));
        let a = s.accounts.iter().find(|a| a.key == "key-a").expect("A was kept");
        assert_eq!(a.data_dir, None, "A's history stays where it is");
        let b = data_home_for_key(&home, "key-b").expect("B has its own dir");
        assert!(b.ends_with(".iris/accounts/5498"), "{b:?}");
    }

    #[test]
    fn an_old_key_with_no_known_user_still_owns_the_default_dir() {
        let home = temp_home("legacy");
        record_sign_in(&home, Some("key-a".into()), None, "key-b", &who(5498, "b@x")).unwrap();
        let s = read_store(&home).unwrap();
        assert_eq!(s.default_owner.as_deref(), Some("legacy"));
        assert_eq!(data_home_for_key(&home, "key-a"), None);
        assert!(data_home_for_key(&home, "key-b").is_some());
    }

    #[test]
    fn signing_in_again_as_the_same_person_keeps_their_dir_and_adds_no_account() {
        let home = temp_home("again");
        record_sign_in(&home, Some("key-a".into()), Some(193), "key-b", &who(5498, "b@x")).unwrap();
        let before = data_home_for_key(&home, "key-b");
        record_sign_in(&home, Some("key-b".into()), Some(5498), "key-b2", &who(5498, "b@x")).unwrap();
        let s = read_store(&home).unwrap();
        assert_eq!(s.accounts.len(), 2);
        assert_eq!(data_home_for_key(&home, "key-b2"), before);
    }

    #[test]
    fn a_later_account_does_not_inherit_a_removed_accounts_history() {
        let home = temp_home("inherit");
        record_sign_in(&home, None, None, "key-a", &who(193, "a@x")).unwrap();
        // A is removed from the store (by the engine); default_owner stays "193".
        let mut s = read_store(&home).unwrap();
        s.accounts.clear();
        write_store(&home, &s).unwrap();
        record_sign_in(&home, None, None, "key-c", &who(777, "c@x")).unwrap();
        assert!(data_home_for_key(&home, "key-c").is_some(), "C must not land in A's history");
    }

    #[test]
    fn an_unknown_identity_never_gets_someone_elses_default_dir_and_never_shows_its_key() {
        let home = temp_home("unknown");
        record_sign_in(&home, None, None, "key-a", &who(193, "a@x")).unwrap();
        record_sign_in(&home, Some("key-a".into()), Some(193), "secret-key", &Identity::default()).unwrap();
        let dir = data_home_for_key(&home, "secret-key").expect("own dir");
        let name = dir.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with("key-") && !name.contains("secret"), "{name}");
    }

    #[test]
    fn an_unreadable_store_is_never_overwritten() {
        let home = temp_home("broken");
        std::fs::create_dir_all(home.join(".iris")).unwrap();
        std::fs::write(store_path(&home), "{not json").unwrap();
        assert!(record_sign_in(&home, None, None, "key-a", &who(193, "a@x")).is_err());
        assert_eq!(std::fs::read_to_string(store_path(&home)).unwrap(), "{not json");
        assert_eq!(data_home_for_key(&home, "key-a"), None, "the app still starts, in the default dir");
    }

    #[cfg(unix)]
    #[test]
    fn the_store_is_0600() {
        use std::os::unix::fs::PermissionsExt;
        let home = temp_home("mode");
        record_sign_in(&home, None, None, "key-a", &who(193, "a@x")).unwrap();
        let mode = std::fs::metadata(store_path(&home)).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}
