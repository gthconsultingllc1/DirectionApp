const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  REDIRECT_URL,
  CALLBACK_SCHEME,
  createDirectionAuth,
  install,
  callbackParams,
  sessionFromCallback,
  isAllowedOAuthUrl,
  redirectToOf,
} = require('../www/direction-auth.js');

const AUTHORIZE =
  'https://mqwayjaefnygtjqgdwxq.supabase.co/auth/v1/authorize?provider=google&redirect_to=' +
  encodeURIComponent(REDIRECT_URL);

function pluginError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function client(overrides) {
  const calls = [];
  const plugin = {
    calls,
    signInWithApple: async () => {
      throw new Error('signInWithApple was not stubbed');
    },
    startOAuth: async () => {
      throw new Error('startOAuth was not stubbed');
    },
    signInWithGoogle: async () => {
      throw new Error('signInWithGoogle was not stubbed');
    },
  };
  Object.keys(overrides || {}).forEach((key) => {
    const value = overrides[key];
    plugin[key] = async (...args) => {
      calls.push({ method: key, args });
      return value(...args);
    };
  });
  return {
    plugin,
    auth: createDirectionAuth({
      getPlatform: () => 'ios',
      getPlugin: () => plugin,
    }),
  };
}

test('redirect URL has a host so the Auth server does not corrupt the code', () => {
  assert.equal(REDIRECT_URL, 'com.gthconsulting.direction://auth/callback');
  assert.equal(CALLBACK_SCHEME, 'com.gthconsulting.direction');
  const parsed = new URL(REDIRECT_URL);
  assert.equal(parsed.protocol, 'com.gthconsulting.direction:');
  assert.equal(parsed.hostname, 'auth');
  assert.equal(parsed.pathname, '/callback');
});

test('OAuth URL allowlist accepts Supabase, Google, and Apple and rejects the WebView', () => {
  assert.equal(isAllowedOAuthUrl(AUTHORIZE), true);
  assert.equal(isAllowedOAuthUrl('https://supabase.co/auth/v1/authorize'), true);
  assert.equal(isAllowedOAuthUrl('https://accounts.google.com/o/oauth2/v2/auth'), true);
  assert.equal(isAllowedOAuthUrl('https://appleid.apple.com/auth/authorize'), true);
  assert.equal(isAllowedOAuthUrl('http://mqwayjaefnygtjqgdwxq.supabase.co/auth/v1/authorize'), false);
  assert.equal(isAllowedOAuthUrl('https://evilsupabase.co/auth/v1/authorize'), false);
  assert.equal(isAllowedOAuthUrl('https://accounts.google.com.evil.com/o/oauth2/v2/auth'), false);
  assert.equal(isAllowedOAuthUrl('https://app.mydirection.app/'), false);
  assert.equal(isAllowedOAuthUrl('javascript:alert(1)'), false);
});

test('callback params read the PKCE code, flow id, and implicit tokens', () => {
  const pkce = callbackParams(REDIRECT_URL + '?code=abc123&sb_flow_id=flow9');
  assert.equal(pkce.code, 'abc123');
  assert.equal(pkce.flowId, 'flow9');
  assert.equal(pkce.error, null);
  assert.equal(pkce.accessToken, null);

  const legacyFlow = callbackParams(REDIRECT_URL + '?code=abc&flow_id=legacy');
  assert.equal(legacyFlow.flowId, 'legacy');

  const failed = callbackParams(REDIRECT_URL + '?error=access_denied&error_description=No');
  assert.equal(failed.error, 'access_denied');
  assert.equal(failed.errorDescription, 'No');

  const implicit = callbackParams(REDIRECT_URL + '#access_token=aaa&refresh_token=bbb&expires_in=3600&token_type=bearer');
  assert.equal(implicit.accessToken, 'aaa');
  assert.equal(implicit.refreshToken, 'bbb');
  assert.deepEqual(sessionFromCallback(implicit), {
    access_token: 'aaa',
    refresh_token: 'bbb',
  });
  assert.equal(sessionFromCallback(pkce), null);
});

test('signInWithApple returns the raw nonce and identity token for signInWithIdToken', async () => {
  const { auth, plugin } = client({
    signInWithApple: async () => ({
      idToken: 'header.payload.sig',
      nonce: 'raw-nonce',
      authorizationCode: 'auth-code',
      email: 'ada@privaterelay.appleid.com',
      givenName: 'Ada',
      familyName: 'Lovelace',
      user: 'apple-user',
    }),
  });

  const result = await auth.signInWithApple();
  assert.equal(plugin.calls[0].method, 'signInWithApple');
  assert.equal(result.provider, 'apple');
  assert.equal(result.mode, 'id_token');
  assert.equal(result.idToken, 'header.payload.sig');
  assert.equal(result.nonce, 'raw-nonce');
  assert.equal(result.authorizationCode, 'auth-code');
  assert.equal(result.email, 'ada@privaterelay.appleid.com');
  assert.equal(result.givenName, 'Ada');
  assert.equal(result.familyName, 'Lovelace');
  assert.equal(result.user, 'apple-user');
  assert.equal(auth.platform, 'ios');
});

test('signInWithApple maps cancellation and a missing token', async () => {
  const cancelled = client({
    signInWithApple: async () => {
      throw pluginError('Sign in with Apple was cancelled', 'USER_CANCELED');
    },
  });
  await assert.rejects(cancelled.auth.signInWithApple(), (error) => {
    assert.equal(error.code, 'USER_CANCELED');
    return true;
  });

  const empty = client({
    signInWithApple: async () => ({ idToken: '', nonce: '' }),
  });
  await assert.rejects(empty.auth.signInWithApple(), (error) => {
    assert.equal(error.code, 'NO_IDENTITY_TOKEN');
    return true;
  });
});

test('signInWithGoogle opens the Supabase URL and returns the callback code', async () => {
  const { auth, plugin } = client({
    startOAuth: async () => ({
      provider: 'google',
      url: REDIRECT_URL + '?code=from-google&sb_flow_id=flow1',
    }),
  });

  const result = await auth.signInWithGoogle({ url: AUTHORIZE });
  assert.equal(plugin.calls.length, 1);
  assert.equal(plugin.calls[0].method, 'startOAuth');
  assert.equal(plugin.calls[0].args[0].url, AUTHORIZE);
  assert.equal(plugin.calls[0].args[0].provider, 'google');
  assert.equal(result.code, 'from-google');
  assert.equal(result.flowId, 'flow1');
  assert.equal(result.url, REDIRECT_URL + '?code=from-google&sb_flow_id=flow1');
});

test('startOAuth refuses a redirect that the system browser cannot return', async () => {
  const { auth, plugin } = client({
    startOAuth: async () => ({ url: REDIRECT_URL }),
  });
  const webRedirect = AUTHORIZE.replace(encodeURIComponent(REDIRECT_URL), encodeURIComponent('https://app.mydirection.app'));
  assert.equal(redirectToOf(webRedirect), 'https://app.mydirection.app');

  await assert.rejects(auth.startOAuth({ url: webRedirect, provider: 'apple' }), (error) => {
    assert.equal(error.code, 'REDIRECT_URL_MISMATCH');
    return true;
  });
  await assert.rejects(auth.signInWithGoogle({}), (error) => {
    assert.equal(error.code, 'MISSING_URL');
    return true;
  });
  assert.equal(plugin.calls.length, 0);
});

test('provider errors on the callback reject instead of looking like a session', async () => {
  const { auth } = client({
    startOAuth: async () => ({
      url: REDIRECT_URL + '?error=server_error&error_description=Try%20again',
    }),
  });
  await assert.rejects(auth.signInWithGoogle({ url: AUTHORIZE }), (error) => {
    assert.equal(error.code, 'SERVER_ERROR');
    assert.equal(error.message, 'Try again');
    return true;
  });
});

test('a missing native plugin is unavailable and does not throw while checking', async () => {
  const auth = createDirectionAuth({
    getPlatform: () => 'web',
    getPlugin: () => {
      throw pluginError('DirectionAuth is only available inside the Direction app', 'UNAVAILABLE');
    },
  });
  assert.equal(auth.isAvailable(), false);
  assert.equal(auth.platform, 'web');
  await assert.rejects(auth.signInWithApple(), (error) => {
    assert.equal(error.code, 'UNAVAILABLE');
    return true;
  });
});

test('install publishes window.DirectionAuth once and leaves DirectionIAP alone', () => {
  const events = [];
  const host = {
    document: {},
    DirectionIAP: { purchaseMonthly: true },
    Capacitor: {
      getPlatform: () => 'android',
      Plugins: {
        DirectionAuth: {
          signInWithApple: async () => ({}),
          startOAuth: async () => ({ url: REDIRECT_URL + '?code=1' }),
        },
      },
    },
    dispatchEvent(event) {
      events.push(event.type);
    },
    CustomEvent: class CustomEvent {
      constructor(type) {
        this.type = type;
      }
    },
  };

  const first = install(host);
  const second = install(host);
  assert.equal(first, second);
  assert.equal(host.DirectionAuth, first);
  assert.equal(host.DirectionAuth.platform, 'android');
  assert.equal(host.DirectionAuth.redirectUrl, REDIRECT_URL);
  assert.equal(host.DirectionIAP.purchaseMonthly, true);
  assert.deepEqual(events, ['direction-auth-ready']);
  assert.equal(host.DirectionAuth.isAvailable(), true);
});

test('iOS and Android shells agree on the callback scheme', () => {
  const root = path.resolve(__dirname, '..');
  const files = [
    'ios/App/App/DirectionAuthPlugin.swift',
    'ios/App/App/Info.plist',
    'android/app/src/main/java/com/gthconsulting/direction/DirectionAuthPlugin.java',
    'android/app/src/main/AndroidManifest.xml',
  ].map((file) => fs.readFileSync(path.join(root, file), 'utf8'));

  files.forEach((source) => {
    assert.match(source, /com\.gthconsulting\.direction/);
  });
  assert.match(files[0], /com\.gthconsulting\.direction:\/\/auth\/callback/);
  assert.match(files[1], /<string>com\.gthconsulting\.direction<\/string>/);
  assert.match(files[2], /com\.gthconsulting\.direction:\/\/auth\/callback/);
  assert.match(files[3], /android:scheme="com\.gthconsulting\.direction"/);
  assert.match(files[3], /android:host="auth"/);
  assert.match(files[3], /android:pathPrefix="\/callback"/);
  assert.match(files[0], /sha256Hex/);
  assert.match(files[0], /prefersEphemeralWebBrowserSession = false/);

  const project = fs.readFileSync(path.join(root, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8');
  const gradle = fs.readFileSync(path.join(root, 'android/app/build.gradle'), 'utf8');
  const entitlements = fs.readFileSync(path.join(root, 'ios/App/App/App.entitlements'), 'utf8');
  assert.match(project, /CURRENT_PROJECT_VERSION = 7;/);
  assert.match(project, /MARKETING_VERSION = 1\.1;/);
  assert.match(project, /CODE_SIGN_ENTITLEMENTS = App\/App\.entitlements;/);
  assert.match(gradle, /versionCode 7/);
  assert.match(gradle, /versionName "1\.1"/);
  assert.match(entitlements, /com\.apple\.developer\.applesignin/);
  assert.doesNotMatch(project, /CURRENT_PROJECT_VERSION = 6;/);
});
