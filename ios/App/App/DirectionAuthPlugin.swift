import AuthenticationServices
import Capacitor
import CryptoKit
import Security
import UIKit

/// Native sign-in for the remote Direction SPA.
///
/// Apple: AuthenticationServices returns an identity token. The WebView calls
/// supabase.auth.signInWithIdToken with the raw nonce. Apple's request nonce
/// is the lowercase hex SHA-256 of that raw nonce. Supabase hashes the raw
/// nonce the same way and compares it to the token's nonce claim. Do not
/// switch this to base64url: AuthenticationServices echoes the string we set,
/// and Supabase's id_token grant compares a hex digest.
///
/// Google, and Apple on Android: the SPA builds a Supabase PKCE authorize URL
/// whose redirect_to is DirectionAuthConfig.redirectURL. We open it in
/// ASWebAuthenticationSession (Safari, not the WKWebView Google blocks) and
/// hand the callback URL back. The SPA exchanges the code in the same WebView,
/// which is where the PKCE verifier was stored.
enum DirectionAuthConfig {
    static let scheme = "com.gthconsulting.direction"
    static let redirectURL = "com.gthconsulting.direction://auth/callback"
}

@objc(DirectionAuthPlugin)
public class DirectionAuthPlugin: CAPPlugin, CAPBridgedPlugin, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding, ASWebAuthenticationPresentationContextProviding {
    public let identifier = "DirectionAuthPlugin"
    public let jsName = "DirectionAuth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "signInWithApple", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signInWithGoogle", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startOAuth", returnType: CAPPluginReturnPromise),
    ]

    private var appleController: ASAuthorizationController?
    private var appleCall: CAPPluginCall?
    private var appleNonce: String?
    private var authSession: ASWebAuthenticationSession?
    private var oauthCall: CAPPluginCall?
    private var oauthProvider = "oauth"

    override public func load() {
        super.load()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleOpenURL(_:)),
            name: Notification.Name.capacitorOpenURL,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        authSession?.cancel()
        authSession = nil
    }

    @objc func signInWithApple(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.beginAppleSignIn(call)
        }
    }

    @objc func signInWithGoogle(_ call: CAPPluginCall) {
        startOAuth(call)
    }

    @objc func startOAuth(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.beginOAuth(call)
        }
    }

    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        return presentationWindow()
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        return presentationWindow()
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        let call = takeAppleCall()
        guard let call = call else { return }
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential else {
            call.reject("Apple did not return an Apple ID credential", "NO_IDENTITY_TOKEN")
            return
        }
        guard let tokenData = credential.identityToken,
              let idToken = String(data: tokenData, encoding: .utf8),
              !idToken.isEmpty else {
            call.reject("Apple did not return an identity token", "NO_IDENTITY_TOKEN")
            return
        }
        guard let nonce = appleNonce, !nonce.isEmpty else {
            call.reject("Apple sign-in nonce was lost", "NO_IDENTITY_TOKEN")
            return
        }

        var result: [String: Any] = [
            "ok": true,
            "provider": "apple",
            "mode": "id_token",
            "idToken": idToken,
            "nonce": nonce,
            "user": credential.user,
        ]
        if let email = credential.email, !email.isEmpty {
            result["email"] = email
        }
        if let givenName = credential.fullName?.givenName, !givenName.isEmpty {
            result["givenName"] = givenName
        }
        if let familyName = credential.fullName?.familyName, !familyName.isEmpty {
            result["familyName"] = familyName
        }
        if let codeData = credential.authorizationCode,
           let authorizationCode = String(data: codeData, encoding: .utf8),
           !authorizationCode.isEmpty {
            result["authorizationCode"] = authorizationCode
        }
        call.resolve(result)
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        let call = takeAppleCall()
        guard let call = call else { return }
        if let authError = error as? ASAuthorizationError, authError.code == .canceled {
            call.reject("Sign in with Apple was cancelled", "USER_CANCELED", error)
            return
        }
        let nsError = error as NSError
        if nsError.domain == ASAuthorizationError.errorDomain && nsError.code == ASAuthorizationError.canceled.rawValue {
            call.reject("Sign in with Apple was cancelled", "USER_CANCELED", error)
            return
        }
        call.reject(error.localizedDescription, "APPLE_AUTH_FAILED", error)
    }

    private func beginAppleSignIn(_ call: CAPPluginCall) {
        if appleCall != nil || oauthCall != nil {
            call.reject("A sign-in is already in progress", "AUTH_IN_PROGRESS")
            return
        }
        let rawNonce = randomNonce()
        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = [.fullName, .email]
        request.nonce = sha256Hex(rawNonce)
        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        appleNonce = rawNonce
        appleCall = call
        appleController = controller
        controller.performRequests()
    }

    private func beginOAuth(_ call: CAPPluginCall) {
        if appleCall != nil || oauthCall != nil {
            call.reject("A sign-in is already in progress", "AUTH_IN_PROGRESS")
            return
        }
        guard let urlString = call.getString("url"), !urlString.isEmpty else {
            call.reject("Missing OAuth url", "MISSING_URL")
            return
        }
        guard let url = URL(string: urlString), isAllowedOAuthURL(url) else {
            call.reject("OAuth url must be an https Supabase, Google, or Apple authorize URL", "INVALID_URL")
            return
        }
        guard let redirectTo = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?
            .first(where: { $0.name == "redirect_to" })?
            .value,
            redirectTo.hasPrefix(DirectionAuthConfig.redirectURL) else {
            call.reject("redirectTo must be \(DirectionAuthConfig.redirectURL)", "REDIRECT_URL_MISMATCH")
            return
        }

        let provider = call.getString("provider") ?? "oauth"
        let session = ASWebAuthenticationSession(url: url, callbackURLScheme: DirectionAuthConfig.scheme) { [weak self] callbackURL, error in
            DispatchQueue.main.async {
                self?.finishOAuth(callbackURL: callbackURL, error: error)
            }
        }
        session.presentationContextProvider = self
        // Share Safari's cookie jar so Google and Apple see a real browser,
        // not the WKWebView user agent they reject.
        session.prefersEphemeralWebBrowserSession = false
        oauthProvider = provider
        oauthCall = call
        authSession = session
        if !session.start() {
            oauthCall = nil
            authSession = nil
            call.reject("Could not open the sign-in browser", "AUTH_SESSION_FAILED")
        }
    }

    private func finishOAuth(callbackURL: URL?, error: Error?) {
        guard let call = takeOAuthCall() else { return }
        if let error = error {
            if let authError = error as? ASWebAuthenticationSessionError, authError.code == .canceledLogin {
                call.reject("Sign-in was cancelled", "USER_CANCELED", error)
                return
            }
            call.reject(error.localizedDescription, "AUTH_SESSION_FAILED", error)
            return
        }
        guard let callbackURL = callbackURL, callbackURL.scheme?.caseInsensitiveCompare(DirectionAuthConfig.scheme) == .orderedSame else {
            call.reject("Sign-in did not return to the app", "NO_CALLBACK")
            return
        }
        call.resolve([
            "ok": true,
            "provider": oauthProvider,
            "url": callbackURL.absoluteString,
        ])
    }

    @objc private func handleOpenURL(_ notification: Notification) {
        guard let payload = notification.object as? [String: Any],
              let url = payload["url"] as? URL else {
            return
        }
        guard url.scheme?.caseInsensitiveCompare(DirectionAuthConfig.scheme) == .orderedSame else { return }
        DispatchQueue.main.async { [weak self] in
            self?.finishOAuth(callbackURL: url, error: nil)
        }
    }

    private func takeAppleCall() -> CAPPluginCall? {
        let call = appleCall
        appleCall = nil
        appleController = nil
        return call
    }

    private func takeOAuthCall() -> CAPPluginCall? {
        let call = oauthCall
        oauthCall = nil
        authSession = nil
        return call
    }

    private func presentationWindow() -> ASPresentationAnchor {
        if let window = bridge?.viewController?.view.window {
            return window
        }
        if let window = bridge?.webView?.window {
            return window
        }
        return ASPresentationAnchor()
    }

    private func isAllowedOAuthURL(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https", let host = url.host?.lowercased() else {
            return false
        }
        if host == "supabase.co" || host.hasSuffix(".supabase.co") {
            return true
        }
        if host == "accounts.google.com" || host == "appleid.apple.com" {
            return true
        }
        return false
    }

    private func randomNonce(length: Int = 32) -> String {
        let charset = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvwxyz-._")
        var bytes = [UInt8](repeating: 0, count: length)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        if status != errSecSuccess {
            for index in bytes.indices {
                bytes[index] = UInt8.random(in: 0 ... 255)
            }
        }
        return String(bytes.map { charset[Int($0) % charset.count] })
    }

    private func sha256Hex(_ input: String) -> String {
        let digest = SHA256.hash(data: Data(input.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}
