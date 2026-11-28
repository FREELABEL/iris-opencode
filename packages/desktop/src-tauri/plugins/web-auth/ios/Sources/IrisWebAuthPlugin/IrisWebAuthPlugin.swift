// "Continue with Google" on iPhone (#194511): Apple's sign-in sheet, which shares Safari's cookies
// (an existing Google session skips the password) and hands back the iris:// callback URL.
import AuthenticationServices
import SwiftRs
import Tauri
import UIKit
import WebKit

class AuthenticateArgs: Decodable {
  let url: String
  let callbackScheme: String
}

class IrisWebAuthPlugin: Plugin, ASWebAuthenticationPresentationContextProviding {
  // Held for as long as the sheet is up: a session that is released is dismissed.
  private var session: ASWebAuthenticationSession?

  @objc public func authenticate(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(AuthenticateArgs.self)
    guard let url = URL(string: args.url), url.scheme == "https" else {
      invoke.reject("not an https URL")
      return
    }
    DispatchQueue.main.async {
      let session = ASWebAuthenticationSession(url: url, callbackURLScheme: args.callbackScheme) { callback, error in
        self.session = nil
        if let callback = callback {
          invoke.resolve(["url": callback.absoluteString])
          return
        }
        if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
          invoke.reject("cancelled")
          return
        }
        invoke.reject(error?.localizedDescription ?? "sign-in failed")
      }
      session.presentationContextProvider = self
      self.session = session
      if !session.start() {
        self.session = nil
        invoke.reject("could not open the sign-in sheet")
      }
    }
  }

  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    return scenes.compactMap { $0.keyWindow }.first ?? scenes.first?.windows.first ?? ASPresentationAnchor()
  }
}

@_cdecl("init_plugin_iris_web_auth")
func initPlugin() -> Plugin {
  return IrisWebAuthPlugin()
}
