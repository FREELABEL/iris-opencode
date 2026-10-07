//! Desktop onboarding steps, counted from the first launch — signed in or not (D7 #188247).
//!
//! Before this the top of the funnel was invisible: the sign-in window sent nothing, and
//! `app_open` needs a token, so every launch that never signed in was never counted. Each step
//! now posts to fl-iris-api's public `POST /api/v1/genesis/events` with `visitor_id` set to this
//! machine's install id; `genesis:funnel --surface=desktop` reads them back.
//!
//! Sent from Rust, not from the login webview: the webview's origin (tauri://localhost,
//! http://tauri.localhost on Windows) is not in iris-api's CORS list, and widening CORS on a
//! credentialed API to make telemetry work is the wrong trade. Rust has no CORS.
//!
//! The event names are a contract with `App\Support\GenesisEvent::DESKTOP_ONBOARDING` in
//! fl-iris-api, which only accepts names on that list (anything else is a silent 204). Add a
//! step there first, or it is dropped.
//!
//! Never fails the caller: 3 s timeout, every error swallowed. Measurement must not be able to
//! break sign-in.

use std::hash::{BuildHasher, Hasher};
use tauri::AppHandle;

const ENDPOINT: &str = "https://heyiris.io/api/v1/genesis/events";

pub const LAUNCH: &str = "onboarding.launch";
pub const SIGNIN_SHOWN: &str = "onboarding.signin_shown";
pub const SETUP_DONE: &str = "onboarding.setup_done";

/// The steps the login window may report. Anything else from the webview is ignored here,
/// before it costs a request.
const FROM_WEBVIEW: &[&str] = &[
    "onboarding.signin_method",
    "onboarding.code_sent",
    "onboarding.signed_in",
    "onboarding.setup_done",
];

/// This machine's install id: a UUID v4 kept in `~/.iris/install-id`, created on first call.
/// Stable across launches and updates, so a relaunch is the same install, not a new one.
pub fn install_id() -> Option<String> {
    let path = crate::login::dirs_next_home()?.join(".iris").join("install-id");
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let existing = existing.trim().to_lowercase();
        if is_uuid(&existing) {
            return Some(existing);
        }
    }
    let id = new_uuid_v4();
    let _ = std::fs::create_dir_all(path.parent()?);
    std::fs::write(&path, &id).ok()?;
    Some(id)
}

fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.chars().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// 128 random bits without a new crate: std's RandomState keys come from the OS RNG on every
/// platform. Two independently-keyed hashers give two independent 64-bit words.
fn new_uuid_v4() -> String {
    let word = || {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        );
        h.finish()
    };
    let mut b = [0u8; 16];
    b[..8].copy_from_slice(&word().to_le_bytes());
    b[8..].copy_from_slice(&word().to_le_bytes());
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// Fire-and-forget. Attaches the saved IRIS token when there is one, so the server binds the
/// event to the user (that is how `onboarding.signed_in` joins an install to a person).
pub fn track(app: &AppHandle, event: &'static str, label: Option<String>) {
    let Some(visitor_id) = install_id() else { return };
    let version = app.package_info().version.to_string();
    let token = crate::iris_env_value("IRIS_API_KEY");

    tauri::async_runtime::spawn(async move {
        let mut body = serde_json::json!({
            "event": event,
            "visitor_id": visitor_id,
            "path": "desktop",
            "props": { "app_version": version, "os": std::env::consts::OS },
        });
        if let Some(label) = label {
            body["label"] = serde_json::Value::String(label.chars().take(191).collect());
        }

        let client = match tauri_plugin_http::reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(3))
            .user_agent(format!("IRIS-Desktop/{version}"))
            .build()
        {
            Ok(c) => c,
            Err(_) => return,
        };
        let mut req = client.post(ENDPOINT).json(&body);
        if let Some(token) = token {
            req = req.bearer_auth(token);
        }
        let _ = req.send().await;
    });
}

/// The login window's half. Only names on FROM_WEBVIEW are sent.
#[tauri::command]
pub fn track_onboarding(app: AppHandle, event: String, label: Option<String>) {
    if let Some(known) = FROM_WEBVIEW.iter().find(|e| **e == event) {
        track(&app, known, label);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_ids_are_v4_uuids_the_server_accepts() {
        for _ in 0..200 {
            let id = new_uuid_v4();
            assert!(is_uuid(&id), "{id}");
            assert_eq!(&id[14..15], "4", "version nibble: {id}");
            assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"), "variant: {id}");
        }
    }

    #[test]
    fn two_ids_differ() {
        assert_ne!(new_uuid_v4(), new_uuid_v4());
    }

    #[test]
    fn rejects_what_is_not_a_uuid() {
        assert!(!is_uuid(""));
        assert!(!is_uuid("not-a-uuid"));
        assert!(!is_uuid("0123456789abcdef0123456789abcdef0123")); // no dashes
    }
}
