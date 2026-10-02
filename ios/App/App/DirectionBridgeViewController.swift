import Capacitor
import WebKit

/// Installs window.DirectionIAP before the remote SPA's scripts run.
/// Capacitor replaces the configuration's user content controller after
/// webViewConfiguration(for:) returns, so the script is added in
/// capacitorDidLoad(), which runs after that swap and before the first load.
@objc(DirectionBridgeViewController)
class DirectionBridgeViewController: CAPBridgeViewController {
    private var didInstallIapScript = false

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        installIapUserScript()
    }

    private func installIapUserScript() {
        guard !didInstallIapScript else { return }
        guard let controller = webView?.configuration.userContentController else {
            NSLog("DirectionIAP: webView is missing in capacitorDidLoad")
            return
        }
        didInstallIapScript = true
        let script = WKUserScript(
            source: DirectionIAPBridgeScript.source(),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        controller.addUserScript(script)
    }
}

enum DirectionIAPBridgeScript {
    static func source() -> String {
        let candidates = [
            Bundle.main.url(forResource: "direction-iap", withExtension: "js", subdirectory: "public"),
            Bundle.main.url(forResource: "direction-iap", withExtension: "js"),
        ]
        for url in candidates.compactMap({ $0 }) {
            if let source = try? String(contentsOf: url, encoding: .utf8), !source.isEmpty {
                return source
            }
        }
        NSLog("DirectionIAP: direction-iap.js is missing from the app bundle. Run npx cap sync.")
        return "console.error('DirectionIAP bridge script missing from the app bundle');"
    }
}
