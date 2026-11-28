// "Continue with Google" on iPhone (#194511): Apple's sign-in sheet, which shares Safari's cookies
// (an existing Google session skips the password) and hands back the iris:// callback URL.
// And Sign in with Apple (#194555, guideline 4.8): ASAuthorizationAppleIDProvider's native sheet.
import AuthenticationServices
import SwiftRs
import Tauri
import UIKit
import WebKit

class AuthenticateArgs: Decodable {
  let url: String
  let callbackScheme: String
}

class AppleArgs: Decodable {
  let nonce: String
}

/// The window a sheet is presented over: the key window of the app's scene.
private func appWindow() -> ASPresentationAnchor {
  let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
  return scenes.compactMap { $0.keyWindow }.first ?? scenes.first?.windows.first ?? ASPresentationAnchor()
}

class IrisWebAuthPlugin: Plugin, ASWebAuthenticationPresentationContextProviding {
  // Held for as long as the sheet is up: a session that is released is dismissed.
  private var session: ASWebAuthenticationSession?
  // Held until Apple's sheet finishes: ASAuthorizationController keeps its delegate weakly.
  private var apple: AppleSignIn?

  @objc public func signInWithApple(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(AppleArgs.self)
    DispatchQueue.main.async {
      let request = ASAuthorizationAppleIDProvider().createRequest()
      request.requestedScopes = [.fullName, .email]
      // The SHA-256 of a nonce only the app holds; Apple signs it into the identity token.
      request.nonce = args.nonce
      let signIn = AppleSignIn(invoke: invoke) { self.apple = nil }
      self.apple = signIn
      signIn.start(request)
    }
  }

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
    return appWindow()
  }
}

/// One Sign in with Apple: the controller, its delegate and the call waiting on them, kept together
/// until the person finishes or cancels. Resolves or rejects exactly once.
class AppleSignIn: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
  private let invoke: Invoke
  private let done: () -> Void
  private var controller: ASAuthorizationController?

  init(invoke: Invoke, done: @escaping () -> Void) {
    self.invoke = invoke
    self.done = done
  }

  func start(_ request: ASAuthorizationAppleIDRequest) {
    let controller = ASAuthorizationController(authorizationRequests: [request])
    controller.delegate = self
    controller.presentationContextProvider = self
    self.controller = controller
    controller.performRequests()
  }

  func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
    defer { finish() }
    guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential else {
      invoke.reject("Apple sign-in returned no Apple ID")
      return
    }
    guard let tokenData = credential.identityToken, let token = String(data: tokenData, encoding: .utf8),
      let codeData = credential.authorizationCode, let code = String(data: codeData, encoding: .utf8)
    else {
      invoke.reject("Apple sign-in returned no identity token")
      return
    }
    // Email and name come on the first sign-in only.
    var reply: JsonObject = ["identityToken": token, "authorizationCode": code, "user": credential.user]
    if let email = credential.email { reply["email"] = email }
    if let given = credential.fullName?.givenName { reply["givenName"] = given }
    if let family = credential.fullName?.familyName { reply["familyName"] = family }
    invoke.resolve(reply)
  }

  func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
    defer { finish() }
    if let error = error as? ASAuthorizationError, error.code == .canceled {
      invoke.reject("cancelled")
      return
    }
    invoke.reject(error.localizedDescription)
  }

  func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
    return appWindow()
  }

  private func finish() {
    controller = nil
    done()
  }
}

@_cdecl("init_plugin_iris_web_auth")
func initPlugin() -> Plugin {
  return IrisWebAuthPlugin()
}
