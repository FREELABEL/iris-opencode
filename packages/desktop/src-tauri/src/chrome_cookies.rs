//! Bring your Chrome sign-ins into the IRIS Browser (S3b, epic #193051).
//!
//! WHY. The Browser has its own cookie store, so it starts logged out of everything, and a
//! logged-out page is a wall: YouTube shows a bot no videos, HEB has no cart. The person is
//! already signed in in Chrome. This copies the cookies of the sites THEY pick from a Chrome
//! profile into the Browser's store, so those sites open signed in.
//!
//! WHAT CROSSES WHERE. Listing (profiles, sites, counts) reads Chrome's database without
//! decrypting anything and needs no permission. Importing asks macOS for Chrome's key ("Chrome
//! Safe Storage" in the Keychain: the person sees the system prompt and can Deny), decrypts in
//! this process, and writes each cookie straight into the Browser webview. Cookie VALUES never
//! cross into the app's JavaScript or the engine: the app gets site names and counts only. And
//! importing a site's sign-in does not let the agent use it: the per-site Allow (browser-grants.ts)
//! still decides that.
//!
//! FORMAT (Chromium on macOS, 2026): `<profile>/Cookies` is SQLite; `encrypted_value` is
//! `v10` + AES-128-CBC(key, iv = 16 spaces, PKCS#7), key = PBKDF2-HMAC-SHA1(keychain password,
//! "saltysalt", 1003 rounds, 16 bytes). Database version 24+ prefixes the plaintext with
//! SHA-256(host) (32 bytes). Times are microseconds since 1601-01-01.
//!
//! PLATFORMS. macOS only for now. Windows Chrome 127+ encrypts with an app-bound key ("v20") that
//! only Chrome itself can unwrap, so a copy from outside is not possible there; Linux is a later
//! slice.

use serde::Serialize;

/// Seconds between 1601-01-01 (Chrome/Windows epoch) and 1970-01-01.
const EPOCH_DELTA_S: i64 = 11_644_473_600;

pub fn chrome_time_to_unix(us: i64) -> Option<i64> {
    if us <= 0 {
        return None;
    }
    Some(us / 1_000_000 - EPOCH_DELTA_S)
}

pub fn derive_key(password: &[u8]) -> [u8; 16] {
    let mut key = [0u8; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password, b"saltysalt", 1003, &mut key);
    key
}

/// `v10` blob → the cookie's value. None for anything else (another scheme, bad padding, not
/// UTF-8): a cookie we can't read exactly is skipped, never guessed.
pub fn decrypt_v10(key: &[u8; 16], blob: &[u8], db_version: i64) -> Option<String> {
    use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
    let body = blob.strip_prefix(b"v10")?;
    let iv = [b' '; 16];
    let plain = cbc::Decryptor::<aes::Aes128>::new(key.into(), &iv.into())
        .decrypt_padded_vec_mut::<Pkcs7>(body)
        .ok()?;
    let plain = if db_version >= 24 {
        plain.get(32..)?.to_vec()
    } else {
        plain
    };
    String::from_utf8(plain).ok()
}

/// The site a cookie host belongs to, for the picker: ".m.youtube.com" → "youtube.com",
/// "www.bbc.co.uk" → "bbc.co.uk". An approximation of the public-suffix list that is right for
/// the sites people sign into; it only groups the list, it never decides what is imported.
pub fn site_of(host: &str) -> String {
    let h = host.trim_start_matches('.').to_ascii_lowercase();
    let labels: Vec<&str> = h.split('.').filter(|l| !l.is_empty()).collect();
    if labels.len() <= 2 {
        return labels.join(".");
    }
    let n = labels.len();
    let two = format!("{}.{}", labels[n - 2], labels[n - 1]);
    const SECOND_LEVEL: &[&str] = &[
        "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp", "ne.jp",
        "com.br", "com.mx", "co.in", "co.za", "com.sg", "com.tr", "co.kr", "com.cn", "com.hk", "com.tw",
    ];
    let keep = if SECOND_LEVEL.contains(&two.as_str()) { 3 } else { 2 };
    labels[n - keep..].join(".")
}

/// One row of Chrome's `cookies` table, as read (value still encrypted).
#[derive(Debug, Clone, serde::Deserialize)]
pub struct Row {
    pub host_key: String,
    pub name: String,
    #[serde(default)]
    pub value: String,
    /// hex(encrypted_value)
    #[serde(default)]
    pub ev: String,
    pub path: String,
    #[serde(default)]
    pub expires_utc: i64,
    #[serde(default)]
    pub has_expires: i64,
    #[serde(default)]
    pub is_secure: i64,
    #[serde(default)]
    pub is_httponly: i64,
    #[serde(default)]
    pub samesite: i64,
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect()
}

/// A bot-protection cookie (Cloudflare, Akamai, DataDome, PerimeterX, Imperva). Each one says
/// "this browser already passed the check", and is tied to the browser that passed it: its
/// fingerprint, often its connection. Sent from our Browser it looks stolen, and the site answers
/// with a harder check (indeed.com, 2026-11-11). Left out, the site checks our Browser once and
/// gives it its own. Sign-in cookies are unaffected.
pub fn is_bot_check_cookie(name: &str) -> bool {
    const EXACT: &[&str] = &[
        "cf_clearance", "__cf_bm", "_cfuvid", "cf_chl_rc_i", "cf_chl_rc_ni", "cf_chl_rc_m", // Cloudflare
        "_abck", "ak_bmsc", "bm_sz", "bm_sv", "bm_mi", "bm_so", "bm_ss", "bm_s", "bm_lso", // Akamai
        "datadome", // DataDome
        "reese84", // Imperva
    ];
    const PREFIX: &[&str] = &["cf_chl_", "_px", "incap_ses_", "visid_incap_", "nlbi_"];
    EXACT.contains(&name) || PREFIX.iter().any(|p| name.starts_with(p))
}

/// A row → a cookie for the Browser's store. None when expired or unreadable.
pub fn to_cookie(row: &Row, key: &[u8; 16], db_version: i64, now_unix: i64) -> Option<tauri::webview::Cookie<'static>> {
    use tauri::webview::cookie::{time::OffsetDateTime, Cookie, SameSite};
    let value = if !row.ev.is_empty() {
        decrypt_v10(key, &unhex(&row.ev)?, db_version)?
    } else {
        row.value.clone()
    };
    let expires = if row.has_expires != 0 { chrome_time_to_unix(row.expires_utc) } else { None };
    if matches!(expires, Some(t) if t <= now_unix) {
        return None;
    }
    // Chrome's ".youtube.com" is a DOMAIN cookie (youtube.com and every subdomain); "www.heb.com"
    // is host-only. WebKit reads the same distinction from the leading dot, but cookie::domain()
    // strips one dot before wry hands it over, so a domain cookie is given one extra.
    let domain = if row.host_key.starts_with('.') { format!(".{}", row.host_key) } else { row.host_key.clone() };
    let mut c = Cookie::build((row.name.clone(), value))
        .domain(domain)
        .path(if row.path.is_empty() { "/".to_string() } else { row.path.clone() })
        .secure(row.is_secure != 0)
        .http_only(row.is_httponly != 0);
    c = match row.samesite {
        0 => c.same_site(SameSite::None),
        1 => c.same_site(SameSite::Lax),
        2 => c.same_site(SameSite::Strict),
        _ => c,
    };
    if let Some(t) = expires {
        if let Ok(dt) = OffsetDateTime::from_unix_timestamp(t) {
            c = c.expires(dt);
        }
    }
    Some(c.build())
}

#[derive(Debug, Clone, Serialize)]
pub struct SiteCount {
    pub site: String,
    pub cookies: usize,
}

/// A Chrome-family browser profile the person can import from.
#[derive(Debug, Clone, Serialize)]
pub struct Source {
    /// "chrome:Profile 1": what browser_import takes back.
    pub id: String,
    pub browser: String,
    pub profile: String,
    pub sites: Vec<SiteCount>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Imported {
    pub imported: usize,
    pub skipped: usize,
    pub sites: Vec<String>,
    /// false where the Browser's store forgets on quit (macOS 13): the app re-imports at launch.
    pub persistent: bool,
}

pub fn count_sites(rows: &[Row]) -> Vec<SiteCount> {
    let mut map: std::collections::BTreeMap<String, usize> = Default::default();
    for r in rows {
        *map.entry(site_of(&r.host_key)).or_default() += 1;
    }
    let mut v: Vec<SiteCount> = map.into_iter().filter(|(s, _)| !s.is_empty()).map(|(site, cookies)| SiteCount { site, cookies }).collect();
    v.sort_by(|a, b| b.cookies.cmp(&a.cookies).then(a.site.cmp(&b.site)));
    v
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    /// (id, label, folder under ~/Library/Application Support, Keychain service, Keychain account)
    pub const BROWSERS: &[(&str, &str, &str, &str, &str)] = &[
        ("chrome", "Chrome", "Google/Chrome", "Chrome Safe Storage", "Chrome"),
        ("brave", "Brave", "BraveSoftware/Brave-Browser", "Brave Safe Storage", "Brave"),
        ("edge", "Edge", "Microsoft Edge", "Microsoft Edge Safe Storage", "Microsoft Edge"),
        ("arc", "Arc", "Arc/User Data", "Arc Safe Storage", "Arc"),
    ];

    fn root(folder: &str) -> Option<PathBuf> {
        Some(PathBuf::from(std::env::var_os("HOME")?).join("Library/Application Support").join(folder))
    }

    /// Profile folder → the name the person gave it, from `Local State`.
    pub fn profiles(root: &Path) -> Vec<(String, String)> {
        let names = std::fs::read_to_string(root.join("Local State"))
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .and_then(|v| v.pointer("/profile/info_cache").cloned());
        let mut out = vec![];
        if let Some(serde_json::Value::Object(m)) = names {
            for (dir, info) in m {
                if root.join(&dir).join("Cookies").exists() {
                    let name = info.get("name").and_then(|n| n.as_str()).unwrap_or(&dir).to_string();
                    out.push((dir, name));
                }
            }
        }
        out.sort();
        out
    }

    /// Chrome keeps the database open; read a private copy of it (0700 dir, deleted after).
    fn read_rows(db: &Path) -> Result<(i64, Vec<Row>), String> {
        let dir = std::env::temp_dir().join(format!("iris-cookie-import-{}-{}", std::process::id(), rand_suffix()));
        std::fs::create_dir(&dir).map_err(|e| e.to_string())?;
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        }
        let result = (|| {
            let copy = dir.join("Cookies");
            std::fs::copy(db, &copy).map_err(|e| format!("could not read the browser's cookies: {e}"))?;
            for side in ["-journal", "-wal"] {
                let s = PathBuf::from(format!("{}{side}", db.display()));
                if s.exists() {
                    let _ = std::fs::copy(&s, dir.join(format!("Cookies{side}")));
                }
            }
            let q = |sql: &str| -> Result<String, String> {
                let o = Command::new("/usr/bin/sqlite3")
                    .args(["-readonly", "-json"])
                    .arg(&copy)
                    .arg(sql)
                    .output()
                    .map_err(|e| e.to_string())?;
                if !o.status.success() {
                    return Err(String::from_utf8_lossy(&o.stderr).trim().to_string());
                }
                Ok(String::from_utf8_lossy(&o.stdout).to_string())
            };
            #[derive(serde::Deserialize)]
            struct V {
                value: String,
            }
            let version = serde_json::from_str::<Vec<V>>(&q("select value from meta where key='version'")?)
                .ok()
                .and_then(|v| v.first().and_then(|x| x.value.parse::<i64>().ok()))
                .unwrap_or(0);
            let out = q("select host_key, name, value, hex(encrypted_value) as ev, path, expires_utc, has_expires, is_secure, is_httponly, samesite from cookies")?;
            let rows: Vec<Row> = if out.trim().is_empty() { vec![] } else { serde_json::from_str(&out).map_err(|e| e.to_string())? };
            Ok((version, rows))
        })();
        let _ = std::fs::remove_dir_all(&dir);
        result
    }

    fn rand_suffix() -> u128 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
    }

    pub fn sources() -> Vec<Source> {
        let mut out = vec![];
        for (id, label, folder, _, _) in BROWSERS {
            let Some(r) = root(folder) else { continue };
            for (dir, name) in profiles(&r) {
                let Ok((_, rows)) = read_rows(&r.join(&dir).join("Cookies")) else { continue };
                let sites = count_sites(&rows);
                if sites.is_empty() {
                    continue;
                }
                out.push(Source { id: format!("{id}:{dir}"), browser: label.to_string(), profile: name, sites });
            }
        }
        out
    }

    /// The person sees macOS's own prompt ("security wants to use … Chrome Safe Storage").
    fn keychain_password(service: &str, account: &str) -> Result<Vec<u8>, String> {
        let o = Command::new("/usr/bin/security")
            .args(["find-generic-password", "-w", "-s", service, "-a", account])
            .output()
            .map_err(|e| e.to_string())?;
        if !o.status.success() {
            return Err(format!("macOS didn't give IRIS the key to {service} (Deny, or it isn't in your Keychain)"));
        }
        let mut p = o.stdout;
        while p.last().is_some_and(|b| *b == b'\n' || *b == b'\r') {
            p.pop();
        }
        Ok(p)
    }

    /// Decrypted cookies for the picked sites of one source.
    pub fn cookies_for(source: &str, sites: &[String]) -> Result<(Vec<tauri::webview::Cookie<'static>>, usize), String> {
        let (bid, dir) = source.split_once(':').ok_or("unknown source")?;
        if dir.contains('/') || dir.contains("..") {
            return Err("unknown source".into());
        }
        let (_, _, folder, service, account) = BROWSERS.iter().find(|b| b.0 == bid).ok_or("unknown browser")?;
        let db = root(folder).ok_or("no home folder")?.join(dir).join("Cookies");
        let (version, rows) = read_rows(&db)?;
        // Bot-check cookies stay in Chrome: they only vouch for the browser that earned them.
        let picked: Vec<&Row> = rows
            .iter()
            .filter(|r| sites.iter().any(|s| *s == site_of(&r.host_key)) && !is_bot_check_cookie(&r.name))
            .collect();
        if picked.is_empty() {
            return Ok((vec![], 0));
        }
        let key = derive_key(&keychain_password(service, account)?);
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
        let mut ok = vec![];
        let mut skipped = 0;
        for r in picked {
            match to_cookie(r, &key, version, now) {
                Some(c) => ok.push(c),
                None => skipped += 1,
            }
        }
        Ok((ok, skipped))
    }
}

/// Chrome-family profiles on this machine and the sites each is signed into. Names and counts
/// only: nothing is decrypted, no permission is asked.
#[tauri::command]
pub async fn browser_import_sources() -> Vec<Source> {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(mac::sources).await.unwrap_or_default()
    }
    #[cfg(not(target_os = "macos"))]
    {
        vec![]
    }
}

/// Copy the picked sites' sign-ins from one profile into the Browser. Asks macOS for the key.
#[tauri::command]
pub async fn browser_import(app: tauri::AppHandle, source: String, sites: Vec<String>) -> Result<Imported, String> {
    #[cfg(target_os = "macos")]
    {
        let picked = sites.clone();
        let (cookies, mut skipped) = tauri::async_runtime::spawn_blocking(move || mac::cookies_for(&source, &picked))
            .await
            .map_err(|e| e.to_string())??;
        let w = crate::browser::ensure_browser(&app)?;
        let mut imported = 0;
        for c in cookies {
            match w.set_cookie(c) {
                Ok(()) => imported += 1,
                Err(_) => skipped += 1,
            }
        }
        Ok(Imported { imported, skipped, sites, persistent: crate::browser::store_is_persistent() })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, source, sites);
        Err("bringing in Chrome sign-ins works on macOS for now".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encrypt(key: &[u8; 16], value: &str, host: &str, db_version: i64) -> Vec<u8> {
        use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
        use sha2::Digest;
        let mut plain = vec![];
        if db_version >= 24 {
            plain.extend_from_slice(&sha2::Sha256::digest(host.as_bytes()));
        }
        plain.extend_from_slice(value.as_bytes());
        let ct = cbc::Encryptor::<aes::Aes128>::new(key.into(), &[b' '; 16].into()).encrypt_padded_vec_mut::<Pkcs7>(&plain);
        [b"v10".as_slice(), &ct].concat()
    }

    #[test]
    fn decrypts_what_chrome_writes_old_and_new_schema() {
        let key = derive_key(b"peanuts");
        assert_eq!(decrypt_v10(&key, &encrypt(&key, "sid=abc", ".youtube.com", 24), 24).as_deref(), Some("sid=abc"));
        assert_eq!(decrypt_v10(&key, &encrypt(&key, "sid=abc", ".youtube.com", 23), 23).as_deref(), Some("sid=abc"));
    }

    #[test]
    fn a_wrong_key_or_another_scheme_is_skipped_not_guessed() {
        let key = derive_key(b"right");
        let blob = encrypt(&key, "x", "h", 24);
        assert_eq!(decrypt_v10(&derive_key(b"wrong"), &blob, 24), None);
        let mut v20 = blob.clone();
        v20[1] = b'2';
        assert_eq!(decrypt_v10(&key, &v20, 24), None);
    }

    #[test]
    fn key_derivation_matches_chromium() {
        // Cross-checked against an independent implementation: Python hashlib.pbkdf2_hmac("sha1", b"peanuts", b"saltysalt", 1003, 16).
        assert_eq!(
            derive_key(b"peanuts").iter().map(|b| format!("{b:02x}")).collect::<String>(),
            "d9a09d499b4e1b7461f28e67972c6dbd"
        );
    }

    #[test]
    fn bot_check_cookies_stay_in_chrome_sign_ins_come_over() {
        for n in ["cf_clearance", "__cf_bm", "cf_chl_2", "_abck", "ak_bmsc", "datadome", "_px3", "_pxvid", "incap_ses_123_45", "reese84"] {
            assert!(is_bot_check_cookie(n), "{n}");
        }
        for n in ["SID", "CTK", "INDEED_CSRF_TOKEN", "session", "__Secure-1PSID", "PPID", "cf_session", "pxl"] {
            assert!(!is_bot_check_cookie(n), "{n}");
        }
    }

    #[test]
    fn chrome_times() {
        assert_eq!(chrome_time_to_unix(13_000_000_000_000_000), Some(1_355_526_400));
        assert_eq!(chrome_time_to_unix(0), None);
    }

    #[test]
    fn sites_group_subdomains() {
        assert_eq!(site_of(".m.youtube.com"), "youtube.com");
        assert_eq!(site_of("www.heb.com"), "heb.com");
        assert_eq!(site_of(".bbc.co.uk"), "bbc.co.uk");
        assert_eq!(site_of("accounts.google.co.uk"), "google.co.uk");
        assert_eq!(site_of("localhost"), "localhost");
    }

    fn row(host: &str, ev: Vec<u8>, expires_utc: i64) -> Row {
        Row {
            host_key: host.into(),
            name: "SID".into(),
            value: String::new(),
            ev: ev.iter().map(|b| format!("{b:02X}")).collect(),
            path: "/".into(),
            expires_utc,
            has_expires: if expires_utc > 0 { 1 } else { 0 },
            is_secure: 1,
            is_httponly: 1,
            samesite: 1,
        }
    }

    #[test]
    fn a_row_becomes_the_same_cookie_and_expired_ones_are_dropped() {
        let key = derive_key(b"k");
        let now = 1_800_000_000;
        let future = (now + 3600 + EPOCH_DELTA_S) * 1_000_000;
        let c = to_cookie(&row(".youtube.com", encrypt(&key, "abc", ".youtube.com", 24), future), &key, 24, now).unwrap();
        assert_eq!((c.name(), c.value(), c.domain(), c.path()), ("SID", "abc", Some(".youtube.com"), Some("/")));
        assert_eq!((c.secure(), c.http_only()), (Some(true), Some(true)));
        assert_eq!(c.expires_datetime().map(|d| d.unix_timestamp()), Some(now + 3600));
        let past = (now - 1 + EPOCH_DELTA_S) * 1_000_000;
        assert!(to_cookie(&row(".youtube.com", encrypt(&key, "abc", ".youtube.com", 24), past), &key, 24, now).is_none());
        // a session cookie (no expiry) is kept, as a session cookie
        let host_only = to_cookie(&row("www.heb.com", encrypt(&key, "x", "www.heb.com", 24), 0), &key, 24, now).unwrap();
        assert!(host_only.expires().is_none());
        assert_eq!(host_only.domain(), Some("www.heb.com"));
    }

    #[test]
    fn counts_by_site_biggest_first() {
        let rows = vec![row(".youtube.com", vec![], 0), row("www.youtube.com", vec![], 0), row("heb.com", vec![], 0)];
        let s = count_sites(&rows);
        assert_eq!((s[0].site.as_str(), s[0].cookies), ("youtube.com", 2));
        assert_eq!(s[1].site, "heb.com");
    }
}

#[cfg(all(test, target_os = "macos"))]
mod real_machine {
    /// Reads this Mac's real Chrome profiles (names and counts only, nothing decrypted).
    /// `cargo test --lib real_chrome_listing -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_chrome_listing() {
        for s in super::mac::sources() {
            println!("{} / {}: {} sites, {} cookies", s.browser, s.profile, s.sites.len(), s.sites.iter().map(|x| x.cookies).sum::<usize>());
        }
    }
}
