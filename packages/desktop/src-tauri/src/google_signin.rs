//! "Continue with Google" for the desktop (D1 #188246, EPIC #188210 ADR-04).
//!
//! The native-app OAuth pattern, RFC 8252 + PKCE (RFC 7636):
//!   1. bind a one-shot listener on 127.0.0.1:<random port>
//!   2. make a code_verifier; send only its SHA-256 (the challenge) to the server
//!   3. open the system browser at fl-api's /auth/google/desktop/start
//!   4. Google → fl-api → our loopback with a single-use `code` (never the token)
//!   5. POST {code, code_verifier} to /exchange; only this process knows the verifier
//!
//! Returns the SDK token to the login window, which then runs exactly the same steps as the
//! email-code path (save_iris_token → setup → restart). One code path after the credential,
//! so the two sign-in methods cannot drift.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

const API: &str = "https://raichu.heyiris.io";
/// Long enough to pick an account and read a consent screen; short enough that an abandoned
/// attempt does not hold a port and a spinner forever.
const WAIT: Duration = Duration::from_secs(300);

fn verifier() -> Result<String, String> {
    let mut bytes = [0u8; 48];
    getrandom::getrandom(&mut bytes).map_err(|e| format!("no randomness available: {e}"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes)) // 64 chars, inside RFC 7636's 43..=128
}

pub(crate) fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => {
                match u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or(""), 16) {
                    Ok(v) => {
                        out.push(v);
                        i += 2;
                    }
                    Err(_) => out.push(b'%'),
                }
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `GET /callback?code=…&error=… HTTP/1.1` → (code, error). None for any other path, so a
/// browser's favicon request does not end the wait.
pub(crate) fn parse_callback(request_line: &str) -> Option<(Option<String>, Option<String>)> {
    let target = request_line.split_whitespace().nth(1)?;
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path != "/callback" {
        return None;
    }
    let (mut code, mut error) = (None, None);
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            match k {
                "code" => code = Some(percent_decode(v)),
                "error" => error = Some(percent_decode(v)),
                _ => {}
            }
        }
    }
    Some((code, error))
}

fn page(ok: bool) -> String {
    let (title, body) = if ok {
        ("Signed in", "You're signed in. Go back to IRIS — you can close this tab.")
    } else {
        ("Sign-in didn't finish", "Sign-in didn't finish. Go back to IRIS to try again.")
    };
    let html = format!(
        "<!doctype html><meta charset=utf-8><title>{title}</title>\
         <body style=\"font:16px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:90vh;background:#0b0b0f;color:#eee\">\
         <p>{body}</p>"
    );
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
        html.len()
    )
}

/// Block (on a worker thread) until the browser hits /callback, or WAIT passes.
fn wait_for_callback(listener: TcpListener) -> Result<String, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + WAIT;
    while Instant::now() < deadline {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_nonblocking(false);
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let mut line = String::new();
                if BufReader::new(&stream).read_line(&mut line).is_err() {
                    continue;
                }
                let Some((code, error)) = parse_callback(&line) else {
                    let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    continue;
                };
                let _ = stream.write_all(page(code.is_some() && error.is_none()).as_bytes());
                return match (code, error) {
                    (_, Some(e)) => Err(e),
                    (Some(c), None) if !c.is_empty() => Ok(c),
                    _ => Err("no_code".into()),
                };
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(150)),
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("timed_out".into())
}

/// The login window's "Continue with Google". Resolves to `{ token, email, is_new }`.
#[tauri::command]
pub async fn google_sign_in(app: AppHandle) -> Result<serde_json::Value, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("could not open a local port: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let verifier = verifier()?;

    let url = format!(
        "{API}/api/v1/auth/google/desktop/start?port={port}&code_challenge={}",
        challenge(&verifier)
    );
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("could not open the browser: {e}"))?;

    let code = tauri::async_runtime::spawn_blocking(move || wait_for_callback(listener))
        .await
        .map_err(|e| e.to_string())??;

    let res = tauri_plugin_http::reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?
        .post(format!("{API}/api/v1/auth/google/desktop/exchange"))
        .json(&serde_json::json!({ "code": code, "code_verifier": verifier }))
        .send()
        .await
        .map_err(|e| format!("could not reach IRIS: {e}"))?;
    let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;

    let token = body["data"]["sdk_token"]["key"]
        .as_str()
        .filter(|t| !t.is_empty())
        .ok_or_else(|| body["error"].as_str().unwrap_or("sign_in_failed").to_string())?;

    Ok(serde_json::json!({
        "token": token,
        "email": body["data"]["user"]["email"],
        "is_new": body["data"]["user"]["is_new"],
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn challenge_matches_rfc7636_appendix_b() {
        // The worked example from RFC 7636 Appendix B.
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn verifier_is_within_the_spec_length_and_alphabet() {
        let v = verifier().unwrap();
        assert!((43..=128).contains(&v.len()));
        assert!(v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn parses_the_callback_and_ignores_other_paths() {
        assert_eq!(
            parse_callback("GET /callback?code=abc%2Bx&state=1 HTTP/1.1"),
            Some((Some("abc+x".into()), None))
        );
        assert_eq!(
            parse_callback("GET /callback?error=access_denied HTTP/1.1"),
            Some((None, Some("access_denied".into())))
        );
        assert_eq!(parse_callback("GET /favicon.ico HTTP/1.1"), None);
    }
}
