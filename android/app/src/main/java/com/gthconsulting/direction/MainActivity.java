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
    private static final String SCRIPT_ASSET = "public/direction-iap.js";

    private String iapScript;
    private boolean iapHooksRegistered;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        registerIapBridge();
    }

    /**
     * The remote SPA is not bundled with the native-purchases package.
     * Install window.DirectionIAP at document start when the WebView supports it,
     * and again when each page finishes loading.
     */
    private void registerIapBridge() {
        if (iapHooksRegistered) return;
        Bridge bridge = getBridge();
        if (bridge == null || bridge.getWebView() == null) {
            Log.e(TAG, "Bridge WebView is not available");
            return;
        }
        iapHooksRegistered = true;
        WebView webView = bridge.getWebView();
        registerDocumentStartScript(webView);
        bridge.addWebViewListener(
            new WebViewListener() {
                @Override
                public void onPageLoaded(WebView view) {
                    injectIapScript(view);
                }
            }
        );
        injectIapScript(webView);
    }

    private void registerDocumentStartScript(WebView webView) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            Log.w(TAG, "DOCUMENT_START_SCRIPT is unsupported; using onPageLoaded injection");
            return;
        }
        Set<String> origins = new HashSet<>(
            Arrays.asList(
                "https://app.mydirection.app",
                "https://mydirection.app",
                "https://direction.grok.me"
            )
        );
        try {
            WebViewCompat.addDocumentStartJavaScript(webView, loadIapScript(), origins);
            Log.i(TAG, "Registered DirectionIAP document-start script");
        } catch (RuntimeException ex) {
            Log.e(TAG, "Document-start script registration failed", ex);
        }
    }

    private void injectIapScript(WebView webView) {
        if (webView == null) return;
        webView.evaluateJavascript(loadIapScript(), null);
    }

    private String loadIapScript() {
        if (iapScript != null) return iapScript;
        try (InputStream input = getAssets().open(SCRIPT_ASSET)) {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            int read;
            while ((read = input.read(chunk)) != -1) {
                buffer.write(chunk, 0, read);
            }
            iapScript = buffer.toString(StandardCharsets.UTF_8.name());
            return iapScript;
        } catch (IOException ex) {
            Log.e(TAG, "Missing " + SCRIPT_ASSET + ". Run npx cap sync.", ex);
            iapScript = "console.error('DirectionIAP bridge script missing from the app bundle');";
            return iapScript;
        }
    }
}
