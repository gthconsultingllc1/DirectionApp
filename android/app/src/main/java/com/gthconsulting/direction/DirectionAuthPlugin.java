package com.gthconsulting.direction;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import androidx.browser.customtabs.CustomTabsIntent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Locale;

/**
 * Opens Supabase OAuth in Chrome Custom Tabs and returns the custom-scheme
 * callback to the WebView. Google rejects the embedded WebView user agent.
 * The PKCE code exchange stays in the WebView, which holds the verifier.
 *
 * Native Sign in with Apple is iOS-only. Android Apple sign-in uses the same
 * system-browser PKCE flow via startOAuth.
 */
@CapacitorPlugin(name = "DirectionAuth")
public class DirectionAuthPlugin extends Plugin {
    static final String CALLBACK_SCHEME = "com.gthconsulting.direction";
    static final String REDIRECT_URL = "com.gthconsulting.direction://auth/callback";

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private PluginCall pendingOAuth;
    private String pendingProvider = "oauth";
    private int oauthGeneration;

    @PluginMethod
    public void signInWithApple(PluginCall call) {
        call.reject(
            "Native Sign in with Apple is only available on iOS. Use startOAuth with the Supabase Apple authorize URL.",
            "APPLE_NATIVE_IOS_ONLY"
        );
    }

    @PluginMethod
    public void signInWithGoogle(PluginCall call) {
        startOAuth(call);
    }

    @PluginMethod
    public void startOAuth(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.trim().isEmpty()) {
            call.reject("Missing OAuth url", "MISSING_URL");
            return;
        }
        Uri parsed = Uri.parse(url);
        if (!isAllowedOAuthUrl(parsed)) {
            call.reject("OAuth url must be an https Supabase, Google, or Apple authorize URL", "INVALID_URL");
            return;
        }
        String redirectTo = parsed.getQueryParameter("redirect_to");
        if (redirectTo == null || !redirectTo.startsWith(REDIRECT_URL)) {
            call.reject("redirectTo must be " + REDIRECT_URL, "REDIRECT_URL_MISMATCH");
            return;
        }
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("DirectionAuth is not attached to an activity", "UNAVAILABLE");
            return;
        }
        if (pendingOAuth != null) {
            call.reject("A sign-in is already in progress", "AUTH_IN_PROGRESS");
            return;
        }

        String provider = call.getString("provider", "oauth");
        if (provider == null || provider.trim().isEmpty()) provider = "oauth";
        oauthGeneration += 1;
        pendingOAuth = call;
        pendingProvider = provider;
        call.setKeepAlive(true);

        try {
            CustomTabsIntent tabs = new CustomTabsIntent.Builder().build();
            tabs.launchUrl(activity, parsed);
        } catch (ActivityNotFoundException ex) {
            clearPending();
            call.reject("Could not open the sign-in browser", "NO_BROWSER", ex);
        }
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        if (intent == null) return;
        Uri data = intent.getData();
        if (data == null || data.getScheme() == null) return;
        if (!CALLBACK_SCHEME.equalsIgnoreCase(data.getScheme())) return;
        deliverCallback(data.toString());
    }

    @Override
    protected void handleOnResume() {
        if (pendingOAuth == null) return;
        final int seen = oauthGeneration;
        // onNewIntent is normally delivered before onResume. A short delay
        // covers devices that resume the activity first.
        mainHandler.postDelayed(
            () -> {
                if (seen != oauthGeneration || pendingOAuth == null) return;
                PluginCall call = pendingOAuth;
                clearPending();
                call.reject("Sign-in was cancelled", "USER_CANCELED");
            },
            500
        );
    }

    private void deliverCallback(String url) {
        PluginCall call = pendingOAuth;
        if (call == null) return;
        String provider = pendingProvider;
        clearPending();
        JSObject result = new JSObject();
        result.put("ok", true);
        result.put("provider", provider);
        result.put("url", url);
        call.resolve(result);
    }

    private void clearPending() {
        if (pendingOAuth != null) {
            pendingOAuth.setKeepAlive(false);
        }
        pendingOAuth = null;
        oauthGeneration += 1;
    }

    static boolean isAllowedOAuthUrl(Uri uri) {
        if (uri == null) return false;
        String scheme = uri.getScheme();
        if (scheme == null || !"https".equalsIgnoreCase(scheme)) return false;
        String host = uri.getHost();
        if (host == null) return false;
        host = host.toLowerCase(Locale.US);
        if ("supabase.co".equals(host) || host.endsWith(".supabase.co")) return true;
        if ("accounts.google.com".equals(host)) return true;
        return "appleid.apple.com".equals(host);
    }
}
