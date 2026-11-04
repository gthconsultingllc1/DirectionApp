package com.gthconsulting.direction;

import android.os.Bundle;
import android.util.Log;
import android.webkit.WebView;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "DirectionIAP";
    private static final String IAP_SCRIPT_ASSET = "public/direction-iap.js";
    private static final String AUTH_SCRIPT_ASSET = "public/direction-auth.js";

    private String iapScript;
    private String authScript;
    private boolean bridgeHooksRegistered;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // registerPlugin must run before super.onCreate(), which builds the bridge.
        registerPlugin(DirectionAuthPlugin.class);
        super.onCreate(savedInstanceState);
        registerBridgeScripts();
    }

    /**
     * The remote SPA is not bundled with the native bridges.
     * Install window.DirectionIAP and window.DirectionAuth at document start
     * when the WebView supports it, and again when each page finishes loading.
     */
    private void registerBridgeScripts() {
        if (bridgeHooksRegistered) return;
        Bridge bridge = getBridge();
        if (bridge == null || bridge.getWebView() == null) {
            Log.e(TAG, "Bridge WebView is not available");
            return;
        }
        bridgeHooksRegistered = true;
        WebView webView = bridge.getWebView();
        registerDocumentStartScript(webView, loadScript(IAP_SCRIPT_ASSET, "DirectionIAP"), "DirectionIAP");
        registerDocumentStartScript(webView, loadScript(AUTH_SCRIPT_ASSET, "DirectionAuth"), "DirectionAuth");
        bridge.addWebViewListener(
            new WebViewListener() {
                @Override
                public void onPageLoaded(WebView view) {
                    injectBridgeScripts(view);
                }
            }
        );
        injectBridgeScripts(webView);
    }

    private void registerDocumentStartScript(WebView webView, String source, String name) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            Log.w(TAG, "DOCUMENT_START_SCRIPT is unsupported; using onPageLoaded injection");
            return;
        }
        Set<String> origins = new HashSet<>(
            Arrays.asList(
                "https://app.mydirection.app",
                "https://mydirection.app"
            )
        );
        try {
            WebViewCompat.addDocumentStartJavaScript(webView, source, origins);
            Log.i(TAG, "Registered " + name + " document-start script");
        } catch (RuntimeException ex) {
            Log.e(TAG, name + " document-start script registration failed", ex);
        }
    }

    private void injectBridgeScripts(WebView webView) {
        if (webView == null) return;
        webView.evaluateJavascript(loadScript(IAP_SCRIPT_ASSET, "DirectionIAP"), null);
        webView.evaluateJavascript(loadScript(AUTH_SCRIPT_ASSET, "DirectionAuth"), null);
    }

    private String loadScript(String asset, String name) {
        if (IAP_SCRIPT_ASSET.equals(asset) && iapScript != null) return iapScript;
        if (AUTH_SCRIPT_ASSET.equals(asset) && authScript != null) return authScript;
        String source;
        try (InputStream input = getAssets().open(asset)) {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            int read;
            while ((read = input.read(chunk)) != -1) {
                buffer.write(chunk, 0, read);
            }
            source = buffer.toString(StandardCharsets.UTF_8.name());
        } catch (IOException ex) {
            Log.e(TAG, "Missing " + asset + ". Run npx cap sync.", ex);
            source = "console.error('" + name + " bridge script missing from the app bundle');";
        }
        if (IAP_SCRIPT_ASSET.equals(asset)) iapScript = source;
        if (AUTH_SCRIPT_ASSET.equals(asset)) authScript = source;
        return source;
    }
}
