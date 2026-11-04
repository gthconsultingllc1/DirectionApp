import Capacitor
import UIKit
import WebKit

/// Installs window.DirectionIAP and window.DirectionAuth before the remote SPA's
/// scripts run, and keeps that WebView below the status bar.
///
/// Capacitor replaces the configuration's user content controller after
/// webViewConfiguration(for:) returns, so scripts are added in
/// capacitorDidLoad(), which runs after that swap and before the first load.
/// Capacitor also sets the WKWebView as this controller's root view, so fixed
/// page headers draw under the status bar. capacitorDidLoad() is still inside
/// loadView(), which is the last moment the root view can be replaced with a
/// host that lays the WebView out inside the safe area.
@objc(DirectionBridgeViewController)
class DirectionBridgeViewController: CAPBridgeViewController {
    private var didInstallBridgeScripts = false
    private var safeAreaHost: UIView?
    private let shellBackground = UIColor(red: 10.0 / 255.0, green: 10.0 / 255.0, blue: 10.0 / 255.0, alpha: 1)

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        installBridgeScripts()
        bridge?.registerPluginInstance(DirectionAuthPlugin())
        installSafeAreaHost()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        layoutWebViewInSafeArea()
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        layoutWebViewInSafeArea()
    }

    private func installBridgeScripts() {
        guard !didInstallBridgeScripts else { return }
        guard let controller = webView?.configuration.userContentController else {
            NSLog("Direction bridge: webView is missing in capacitorDidLoad")
            return
        }
        didInstallBridgeScripts = true
        addBridgeScript(
            resource: "direction-iap",
            missingLog: "DirectionIAP: direction-iap.js is missing from the app bundle. Run npx cap sync.",
            controller: controller
        )
        addBridgeScript(
            resource: "direction-auth",
            missingLog: "DirectionAuth: direction-auth.js is missing from the app bundle. Run npx cap sync.",
            controller: controller
        )
    }

    private func addBridgeScript(resource: String, missingLog: String, controller: WKUserContentController) {
        let script = WKUserScript(
            source: bridgeScriptSource(resource: resource, missingLog: missingLog),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        controller.addUserScript(script)
    }

    private func bridgeScriptSource(resource: String, missingLog: String) -> String {
        let candidates = [
            Bundle.main.url(forResource: resource, withExtension: "js", subdirectory: "public"),
            Bundle.main.url(forResource: resource, withExtension: "js"),
        ]
        for url in candidates.compactMap({ $0 }) {
            if let source = try? String(contentsOf: url, encoding: .utf8), !source.isEmpty {
                return source
            }
        }
        NSLog("%@", missingLog)
        return "console.error('\(resource) bridge script missing from the app bundle');"
    }

    /// Puts the WebView strictly inside the safe area so remote CSS, including
    /// position:fixed headers, cannot draw under the status bar or home indicator.
    /// env(safe-area-inset-*) is then 0, so the web app does not add a second inset.
    private func installSafeAreaHost() {
        guard safeAreaHost == nil, let webView = webView else { return }
        let host = UIView(frame: webView.bounds)
        host.backgroundColor = shellBackground
        host.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.backgroundColor = shellBackground
        webView.isOpaque = true
        webView.scrollView.backgroundColor = shellBackground
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.insetsLayoutMarginsFromSafeArea = false
        webView.translatesAutoresizingMaskIntoConstraints = true
        webView.autoresizingMask = []
        view = host
        host.addSubview(webView)
        safeAreaHost = host
        layoutWebViewInSafeArea()
    }

    private func layoutWebViewInSafeArea() {
        guard let host = safeAreaHost, let webView = webView else { return }
        let next = host.bounds.inset(by: host.safeAreaInsets)
        if webView.frame != next {
            webView.frame = next
        }
    }
}
