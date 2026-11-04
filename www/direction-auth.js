/**
 * Direction native sign-in bridge.
 *
 * Injected into the Capacitor WebView (including the remote SPA at
 * https://app.mydirection.app) as window.DirectionAuth.
 *
 * Google rejects OAuth inside an embedded WebView (disallowed_useragent).
 * Sign in with Apple's web redirect also fails to return from that WebView.
 * This bridge leaves the WebView:
 *   - iOS Apple: AuthenticationServices, then supabase.auth.signInWithIdToken
 *   - Google (iOS and Android) and Apple on Android: the system browser
 *     (ASWebAuthenticationSession / Chrome Custom Tabs) with PKCE, then
 *     supabase.auth.exchangeCodeForSession in this same WebView
 *
 * The redirect URL is com.gthconsulting.direction://auth/callback.
 * It must be allow-listed in Supabase. The host is "auth" so the callback
 * is not a bare custom scheme (those get corrupted by the Auth server).
 */
(function (root) {
  'use strict';

  var REDIRECT_URL = 'com.gthconsulting.direction://auth/callback';
  var CALLBACK_SCHEME = 'com.gthconsulting.direction';

  function errorWithCode(message, code) {
    var error = new Error(message);
    error.code = code;
    return error;
  }

  function textOf(error) {
    if (!error) return '';
    if (typeof error === 'string') return error;
    return String(error.message || error.errorMessage || error);
  }

  function codeOf(error) {
    if (!error || typeof error !== 'object' || !error.code) return '';
    return String(error.code);
  }

  function rejectNative(error, fallbackCode, fallbackMessage) {
    var code = codeOf(error) || fallbackCode || 'AUTH_FAILED';
    var message = textOf(error) || fallbackMessage || 'Sign-in failed';
    throw errorWithCode(message, code);
  }

  function hostnameOf(url) {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch (error) {
      return '';
    }
  }

  function isAllowedOAuthUrl(url) {
    var host = hostnameOf(url);
    if (!host) return false;
    var parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      return false;
    }
    if (parsed.protocol !== 'https:') return false;
    if (host === 'supabase.co' || host.slice(-12) === '.supabase.co') return true;
    if (host === 'accounts.google.com') return true;
    if (host === 'appleid.apple.com') return true;
    return false;
  }

  function redirectToOf(url) {
    try {
      return new URL(url).searchParams.get('redirect_to');
    } catch (error) {
      return null;
    }
  }

  function assertOAuthUrl(url) {
    if (!url || typeof url !== 'string') {
      throw errorWithCode('Missing OAuth url', 'MISSING_URL');
    }
    if (!isAllowedOAuthUrl(url)) {
      throw errorWithCode(
        'OAuth url must be an https Supabase, Google, or Apple authorize URL',
        'INVALID_URL',
      );
    }
    var redirectTo = redirectToOf(url);
    if (!redirectTo || redirectTo.indexOf(REDIRECT_URL) !== 0) {
      throw errorWithCode('redirectTo must be ' + REDIRECT_URL, 'REDIRECT_URL_MISMATCH');
    }
  }

  function firstParam(query, hash, name) {
    var fromQuery = query.get(name);
    if (fromQuery) return fromQuery;
    var fromHash = hash.get(name);
    return fromHash || null;
  }

  function callbackParams(url) {
    var parsed = new URL(url);
    var query = parsed.searchParams;
    var hashText = parsed.hash && parsed.hash.charAt(0) === '#' ? parsed.hash.slice(1) : parsed.hash || '';
    var hash = new URLSearchParams(hashText);
    return {
      url: url,
      code: firstParam(query, hash, 'code'),
      flowId: firstParam(query, hash, 'sb_flow_id') || firstParam(query, hash, 'flow_id'),
      error: firstParam(query, hash, 'error'),
      errorDescription: firstParam(query, hash, 'error_description'),
      accessToken: firstParam(query, hash, 'access_token'),
      refreshToken: firstParam(query, hash, 'refresh_token'),
      expiresIn: firstParam(query, hash, 'expires_in'),
      tokenType: firstParam(query, hash, 'token_type'),
    };
  }

  function sessionFromCallback(urlOrParams) {
    var params = typeof urlOrParams === 'string' ? callbackParams(urlOrParams) : urlOrParams;
    if (!params || !params.accessToken || !params.refreshToken) return null;
    return {
      access_token: params.accessToken,
      refresh_token: params.refreshToken,
    };
  }

  function createDirectionAuth(deps) {
    if (!deps || typeof deps.getPlugin !== 'function') {
      throw new Error('createDirectionAuth requires getPlugin');
    }

    function plugin() {
      return deps.getPlugin();
    }

    function platform() {
      if (typeof deps.getPlatform === 'function') {
        var value = deps.getPlatform();
        if (value === 'ios' || value === 'android' || value === 'web') return value;
      }
      return 'web';
    }

    async function signInWithApple() {
      var nativePlugin;
      try {
        nativePlugin = plugin();
      } catch (error) {
        rejectNative(error, 'UNAVAILABLE', 'DirectionAuth is only available inside the Direction app');
      }

      var result;
      try {
        result = await nativePlugin.signInWithApple();
      } catch (error) {
        rejectNative(error, 'APPLE_AUTH_FAILED', 'Sign in with Apple failed');
      }

      if (!result || !result.idToken || !result.nonce) {
        throw errorWithCode('Apple did not return an identity token', 'NO_IDENTITY_TOKEN');
      }

      return {
        ok: true,
        provider: 'apple',
        mode: 'id_token',
        idToken: String(result.idToken),
        nonce: String(result.nonce),
        authorizationCode: result.authorizationCode ? String(result.authorizationCode) : null,
        email: result.email ? String(result.email) : null,
        givenName: result.givenName ? String(result.givenName) : null,
        familyName: result.familyName ? String(result.familyName) : null,
        user: result.user ? String(result.user) : null,
      };
    }

    async function startOAuth(options) {
      var provider = (options && options.provider) || 'oauth';
      assertOAuthUrl(options && options.url);

      var nativePlugin;
      try {
        nativePlugin = plugin();
      } catch (error) {
        rejectNative(error, 'UNAVAILABLE', 'DirectionAuth is only available inside the Direction app');
      }

      var result;
      try {
        result = await nativePlugin.startOAuth({
          url: options.url,
          provider: provider,
        });
      } catch (error) {
        rejectNative(error, 'AUTH_SESSION_FAILED', 'Sign-in failed');
      }

      var callbackUrl = result && result.url ? String(result.url) : '';
      if (!callbackUrl) {
        throw errorWithCode('Auth session did not return a callback URL', 'NO_CALLBACK');
      }

      var params = callbackParams(callbackUrl);
      if (params.error) {
        var oauthError = errorWithCode(params.errorDescription || params.error, String(params.error).toUpperCase());
        oauthError.callbackUrl = callbackUrl;
        throw oauthError;
      }

      return {
        ok: true,
        provider: (result && result.provider) || provider,
        url: callbackUrl,
        code: params.code,
        flowId: params.flowId,
        accessToken: params.accessToken,
        refreshToken: params.refreshToken,
      };
    }

    function signInWithGoogle(options) {
      var next = Object.assign({}, options || {});
      next.provider = 'google';
      return startOAuth(next);
    }

    function isAvailable() {
      try {
        plugin();
        return true;
      } catch (error) {
        return false;
      }
    }

    var api = {
      redirectUrl: REDIRECT_URL,
      callbackScheme: CALLBACK_SCHEME,
      getPlatform: platform,
      signInWithApple: signInWithApple,
      signInWithGoogle: signInWithGoogle,
      startOAuth: startOAuth,
      callbackParams: callbackParams,
      sessionFromCallback: sessionFromCallback,
      isAllowedOAuthUrl: isAllowedOAuthUrl,
      isAvailable: isAvailable,
    };

    Object.defineProperty(api, 'platform', {
      enumerable: true,
      get: function () {
        return platform();
      },
    });

    return api;
  }

  function install(target) {
    var host = target || root;
    if (!host) return null;
    if (host.DirectionAuth && host.DirectionAuth.__installed) return host.DirectionAuth;

    var api = createDirectionAuth({
      getPlatform: function () {
        var capacitor = host.Capacitor;
        if (!capacitor || typeof capacitor.getPlatform !== 'function') return 'web';
        return capacitor.getPlatform();
      },
      getPlugin: function () {
        var capacitor = host.Capacitor;
        var nativePlugin = capacitor && capacitor.Plugins && capacitor.Plugins.DirectionAuth;
        if (!nativePlugin || typeof nativePlugin.signInWithApple !== 'function' || typeof nativePlugin.startOAuth !== 'function') {
          throw errorWithCode('DirectionAuth is only available inside the Direction app', 'UNAVAILABLE');
        }
        return nativePlugin;
      },
    });
    api.__installed = true;
    host.DirectionAuth = api;

    try {
      if (typeof host.dispatchEvent === 'function' && typeof host.CustomEvent === 'function') {
        host.dispatchEvent(new host.CustomEvent('direction-auth-ready'));
      }
    } catch (error) {
      // The object is still on window if the event cannot be dispatched.
    }

    return api;
  }

  var exported = {
    REDIRECT_URL: REDIRECT_URL,
    CALLBACK_SCHEME: CALLBACK_SCHEME,
    createDirectionAuth: createDirectionAuth,
    install: install,
    callbackParams: callbackParams,
    sessionFromCallback: sessionFromCallback,
    isAllowedOAuthUrl: isAllowedOAuthUrl,
    redirectToOf: redirectToOf,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }

  if (root && (root.document || root.Capacitor)) {
    install(root);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
