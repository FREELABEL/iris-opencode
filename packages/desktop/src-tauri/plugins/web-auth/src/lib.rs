//! Apple's system sign-in sheet for the IRIS iPhone app (#194511): "Continue with Google".
//!
//! Google refuses sign-in inside an embedded web view, and iOS suspends an app while Safari is in
//! front, so Desktop's loopback listener (google_signin.rs) cannot work here. RFC 8252 §7.1 on iOS
//! is ASWebAuthenticationSession: a sheet over the app that hands back the first URL matching the
//! callback scheme (iris://auth/google?code=…). The code is useless without the PKCE verifier only
//! this app holds, which is what makes a claimable custom scheme safe (RFC 8252 §8.1).
//!
//! It also opens Sign in with Apple (#194555): ASAuthorizationAppleIDProvider's native sheet.
use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_iris_web_auth);

#[cfg(target_os = "ios")]
struct Sheet<R: Runtime>(tauri::plugin::PluginHandle<R>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    url: String,
    callback_scheme: String,
}

#[derive(Deserialize)]
struct Reply {
    url: String,
}

/// Opens `url` in the sign-in sheet; resolves to the callback URL, or rejects with "cancelled".
#[tauri::command]
async fn authenticate<R: Runtime>(app: tauri::AppHandle<R>, url: String, callback_scheme: String) -> Result<String, String> {
    #[cfg(target_os = "ios")]
    {
        use tauri::Manager;
        let handle = app.state::<Sheet<R>>().0.clone();
        // The sheet waits for a person, possibly for minutes: not on an async worker.
        let reply = tauri::async_runtime::spawn_blocking(move || {
            handle.run_mobile_plugin::<Reply>("authenticate", Request { url, callback_scheme })
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
        Ok(reply.url)
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, url, callback_scheme);
        Err("the sign-in sheet exists only on iOS".into())
    }
}

#[derive(Serialize)]
struct AppleRequest {
    nonce: String,
}

/// What Sign in with Apple hands back. Apple sends the email and name on the first sign-in only.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppleReply {
    identity_token: String,
    authorization_code: String,
    user: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    given_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    family_name: Option<String>,
}

/// Sign in with Apple (#194555, guideline 4.8): Apple's own sheet, no web view. `nonce` is the
/// SHA-256 (hex) of a raw nonce only the app holds; Apple signs it into the identity token.
/// Rejects with "cancelled" when the person closes the sheet.
#[tauri::command]
async fn sign_in_with_apple<R: Runtime>(app: tauri::AppHandle<R>, nonce: String) -> Result<AppleReply, String> {
    #[cfg(target_os = "ios")]
    {
        use tauri::Manager;
        let handle = app.state::<Sheet<R>>().0.clone();
        // Waits for a person (Face ID, a password): not on an async worker.
        tauri::async_runtime::spawn_blocking(move || handle.run_mobile_plugin::<AppleReply>("signInWithApple", AppleRequest { nonce }))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, AppleRequest { nonce });
        Err("Sign in with Apple exists only on iOS".into())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("iris-web-auth")
        .invoke_handler(tauri::generate_handler![authenticate, sign_in_with_apple])
        .setup(|_app, _api| {
            #[cfg(target_os = "ios")]
            {
                use tauri::Manager;
                let handle = _api.register_ios_plugin(init_plugin_iris_web_auth)?;
                _app.manage(Sheet(handle));
            }
            Ok(())
        })
        .build()
}
