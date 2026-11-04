# Direction — Capacitor Android wrapper

Native Android shell that loads **https://app.mydirection.app** in a fullscreen Capacitor WebView. Built for Google Play AAB upload.

| Field | Value |
|-------|--------|
| Package / applicationId | `com.gthconsulting.direction` |
| App label | Direction |
| Capacitor | 7.x |
| Web target | `https://app.mydirection.app` |
| Allowed nav | `app.mydirection.app` + mydirection.app, Supabase (`mqwayjaefnygtjqgdwxq.supabase.co`, `*.supabase.co`), Google (`accounts.google.com`, `*.google.com`, `*.googleusercontent.com`), Apple (`appleid.apple.com`, `*.apple.com`). Google and Apple sign-in must use `window.DirectionAuth`, not a navigation inside this WebView. |
| Min / target SDK | 23 / 36 |
| Release AAB | [`direction-release.aab`](./direction-release.aab) |
| Android version | `versionName` 1.1 / `versionCode` 7 |
| iOS version | marketing 1.1 / build 7 |

## Subscriptions (Play Billing + StoreKit)

The native shell sells Direction Premium. The remote SPA is not bundled with a billing SDK; inside the app it calls `window.DirectionIAP`, which is injected before the page scripts run. Product IDs live in `www/direction-iap.js`.

| | Monthly | Yearly |
|--|---------|--------|
| Product ID (Play and App Store) | `direction_premium_monthly` | `direction_premium_yearly` |
| Play base plan ID | `monthly` | `yearly` |
| Play offer ID | `trial-7-days` (7-day trial) | `trial-7-days` (7-day trial) |
| Catalog price when the store has not returned one | $9.99/month | $59.99/year |

Plugin: [`@capgo/native-purchases@7.19.2`](https://github.com/Cap-go/capacitor-native-purchases) (Capacitor 7, Play Billing 8, StoreKit 2). `npm install` patches Android offer selection so an eligible `trial-7-days` offer is purchased, and so cancel / already-owned / other billing results come back as stable error codes. StoreKit applies the introductory offer on its own; pass `planIdentifier` only because Play requires the base plan id.

Show the paywall from `formatPaywall(products)`. The card and the fine print both use `priceLine`, so they cannot disagree. That line is the store's recurring price plus `/month` or `/year`. A 7-day trial is included only when `hasFreeTrial` is true. If the store has not returned a price, the same helper uses `$9.99/month` and `$59.99/year`.

```javascript
const iap = window.DirectionIAP;
if (!iap) throw new Error('Open Direction from the iOS or Android app');

const { products } = await iap.getProducts(); // same payload as getOfferings()
const paywall = iap.formatPaywall(products);
// paywall.monthly.priceLine and paywall.monthly.disclosure share one price string
// paywall.yearly.priceLine is the yearly string
// paywall.webMessage is the catalog sentence: $9.99/month or $59.99/year, each with a 7-day trial

const monthly = await iap.purchaseMonthly();
const yearly = await iap.purchase('direction_premium_yearly');
const restored = await iap.restorePurchases();
const info = await iap.getCustomerInfo();

if (monthly.premium || info.premium) {
  // set tier = premium
}
// monthly.status is purchased | restored | already_owned | cancelled | pending | error | unavailable
// cancelled, already owned, and store failures resolve. They do not throw.
```

`result.tier` is `'premium'` or `'free'`. `result.customerInfo.activeProductIds` lists the active product ids. `purchaseToken` (Android) and `receipt` / `jwsRepresentation` (iOS) are included on a completed purchase for server checks.

The bridge object is installed at document start. If a script runs before that, wait for it:

```javascript
async function whenDirectionIAP() {
  if (window.DirectionIAP) return window.DirectionIAP;
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (!window.DirectionIAP) return;
      clearInterval(timer);
      resolve(window.DirectionIAP);
    }, 50);
    window.addEventListener('direction-iap-ready', () => {
      clearInterval(timer);
      resolve(window.DirectionIAP);
    }, { once: true });
  });
}
```

After changing `www/direction-iap.js` or `www/direction-auth.js`, run `npx cap sync` so the scripts are copied into the Android and iOS bundles.

## Sign-in (Google and Apple)

Google rejects OAuth inside an embedded WebView (`disallowed_useragent`). Sign in with Apple's web redirect also does not reliably return to this WKWebView. The shell therefore exposes `window.DirectionAuth`, injected at document start the same way as `window.DirectionIAP`. The WebView must not navigate to `accounts.google.com` or `appleid.apple.com`.

| | Value |
|--|--|
| Callback | `com.gthconsulting.direction://auth/callback` (`DirectionAuth.redirectUrl`) |
| iOS Apple | `AuthenticationServices` identity token. Web app calls `supabase.auth.signInWithIdToken`. |
| Google, and Apple on Android | System browser (`ASWebAuthenticationSession` on iOS, Chrome Custom Tabs on Android). Web app calls `supabase.auth.signInWithOAuth` with `skipBrowserRedirect: true`, then `exchangeCodeForSession` in this same WebView. |
| Supabase project | `mqwayjaefnygtjqgdwxq` |

`createClient` must use `auth.flowType: 'pkce'` (the supabase-js v2 default). The code verifier is stored when `signInWithOAuth` runs, so `exchangeCodeForSession` has to run in the same WebView. Do not load the callback URL in the WebView. `detectSessionInUrl` does not see a custom-scheme callback.

The native Apple nonce is the raw string returned as `apple.nonce`. The shell already sends Apple the lowercase hex SHA-256 of that string. Pass `apple.nonce` through unchanged. Apple only returns `givenName` / `familyName` on the first authorization; save them with `updateUser` when they are present.

```javascript
async function whenDirectionAuth() {
  if (window.DirectionAuth) return window.DirectionAuth;
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (!window.DirectionAuth) return;
      clearInterval(timer);
      resolve(window.DirectionAuth);
    }, 50);
    window.addEventListener('direction-auth-ready', () => {
      clearInterval(timer);
      resolve(window.DirectionAuth);
    }, { once: true });
  });
}

const redirectTo = window.DirectionAuth.redirectUrl;

async function signInWithApple() {
  const auth = window.DirectionAuth;
  if (auth && auth.isAvailable() && auth.platform === 'ios') {
    const apple = await auth.signInWithApple();
    const { data, error } = await supabase.auth.signInWithIdToken({
      provider: 'apple',
      token: apple.idToken,
      nonce: apple.nonce,
    });
    if (error) throw error;
    const fullName = [apple.givenName, apple.familyName].filter(Boolean).join(' ');
    if (fullName) {
      await supabase.auth.updateUser({
        data: {
          full_name: fullName,
          given_name: apple.givenName,
          family_name: apple.familyName,
        },
      });
    }
    return data;
  }
  return signInWithProvider('apple');
}

async function signInWithGoogle() {
  return signInWithProvider('google');
}

async function signInWithProvider(provider) {
  const auth = window.DirectionAuth;
  if (!auth || !auth.isAvailable()) {
    return supabase.auth.signInWithOAuth({ provider });
  }
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo: auth.redirectUrl, skipBrowserRedirect: true },
  });
  if (error) throw error;
  const callback = await auth.startOAuth({ url: data.url, provider });
  // auth.signInWithGoogle({ url: data.url }) is the same call for Google.
  if (callback.accessToken && callback.refreshToken) {
    return supabase.auth.setSession({
      access_token: callback.accessToken,
      refresh_token: callback.refreshToken,
    });
  }
  const flowId = callback.flowId || data.flowId;
  if (flowId) {
    return supabase.auth.exchangeCodeForSession(callback.code, { flowId });
  }
  return supabase.auth.exchangeCodeForSession(callback.code);
}
```

Cancellation rejects with `error.code === 'USER_CANCELED'`. A missing bridge rejects with `UNAVAILABLE`. Android `signInWithApple()` rejects with `APPLE_NATIVE_IOS_ONLY`; use `startOAuth` there.

On iOS the WebView is laid out inside the safe area, so web content cannot sit under the status bar or home indicator, and `env(safe-area-inset-top)` is 0 inside the app. Do not add a second status-bar spacer when `DirectionAuth` is present. The Account header's Sign in control still has to stay on one line in the web app (`white-space: nowrap; flex-shrink: 0`). Android 15+ uses Capacitor's `adjustMarginsForEdgeToEdge: "auto"`; older Android versions are unchanged.

Console setup before the next iOS build:

1. Supabase Auth URL configuration: add redirect `com.gthconsulting.direction://auth/callback`.
2. Supabase Apple provider Client IDs: keep the existing Services ID first, then add `com.gthconsulting.direction`. Native tokens use the bundle id as `aud`. A bundle id listed first makes Apple reject the web Services ID flow.
3. Apple Developer App ID `com.gthconsulting.direction`: enable Sign in with Apple, then refresh the App Store provisioning profile. The target entitlements file requests `com.apple.developer.applesignin`. No new Services ID is required if the website one already uses `https://mqwayjaefnygtjqgdwxq.supabase.co/auth/v1/callback`.
4. Google Cloud: do not create an iOS client for this flow. The system browser uses the existing Supabase Google web client. Its authorized redirect stays `https://mqwayjaefnygtjqgdwxq.supabase.co/auth/v1/callback`. If the consent screen is in Testing, App Review's Google account must be a test user, or the client must be published.

This repo does not submit to App Store Connect or Play. The projects currently set Android `versionCode` 7 (`versionName` 1.1) and iOS build 7 (marketing 1.1). Play already used versionCode 3, rejected a later upload because versionCode 4 existed as versionName 1.0, and the repo has since moved to 7. The next store upload must be higher than whatever Play and App Store Connect already show. `ITSAppUsesNonExemptEncryption` is false because Direction only uses exempt HTTPS. In Play Console, license testers must install from the testing track. In App Store Connect, the In-App Purchase capability is recorded on the Xcode target; sign a sandbox tester in when the purchase sheet appears.

## What this is

- Minimal `www/` fallback (dark “Loading…” page).
- Capacitor `server.url` points at the live Direction web app (not a bundled SPA).
- Dark splash / window background (`#0A0A0A`).
- `RECORD_AUDIO` + `MODIFY_AUDIO_SETTINGS` in the manifest for voice features (mic not required for install).
- Launcher icons generated from `/workspace/direction-play-assets/icon-512.png`.

## Artifact produced

```
/workspace/direction-native/direction-release.aab
```

Also available at the Gradle output path:

```
android/app/build/outputs/bundle/release/app-release.aab
```

Release AABs are signed with the current Play upload key. The keystore file is not in git. Its alias is `upload`, and Codemagic manages it as the Android keystore reference `direction_upload`. The store password and the key password are kept in Codemagic's code-signing settings and in the owner's secure storage. They are not written in this repo.

An older upload key, alias `direction-upload`, was retired with a Play upload key reset. A password for that retired key was committed in `android/app/build.gradle` and this README and is still in git history. Do not use the retired key. This change does not rewrite history.

### Release signing variables

`android/app/build.gradle` reads the first non-empty value of each pair from the environment or from a Gradle property (`~/.gradle/gradle.properties` or `android/gradle.properties`, neither of which should be committed). `bundleRelease` and `assembleRelease` fail if the set is incomplete.

| Purpose | Codemagic (`android_signing` reference `direction_upload`) | Local env or Gradle property |
|--|--|--|
| Keystore file | `CM_KEYSTORE_PATH` | `DIRECTION_KEYSTORE_PATH` |
| Keystore password | `CM_KEYSTORE_PASSWORD` | `DIRECTION_KEYSTORE_PASSWORD` |
| Key alias | `CM_KEY_ALIAS` (`upload`) | `DIRECTION_KEY_ALIAS` |
| Key password | `CM_KEY_PASSWORD` | `DIRECTION_KEY_PASSWORD` |

Codemagic injects the `CM_*` variables when the Android keystore reference `direction_upload` is selected. The passwords stay in Codemagic's code-signing settings and the owner's secure storage.

## Codemagic Android closed testing

Earlier Play AABs were signed with the retired upload key. Workflow `android-closed-testing` in `codemagic.yaml` builds a release AAB and signs it with the current upload key: Codemagic reference `direction_upload`, alias `upload`. It has no `triggering` events, so it starts only when you start it. It does not upload to Play. This repo cannot sign a Play AAB by itself.

The upload key is stored in Codemagic (Team settings → Code signing identities → Android keystores), not in git:

| Codemagic field | Value |
|-----------------|--------|
| Reference name | `direction_upload` |
| Keystore file | the current upload keystore (not committed) |
| Keystore password | kept in Codemagic's code-signing settings and the owner's secure storage |
| Key alias | `upload` |
| Key password | kept in Codemagic's code-signing settings and the owner's secure storage |

Start the versionCode 7 / versionName 1.1 closed-testing AAB:

1. Codemagic → the Direction app → **Start new build**.
2. Branch: `main`.
3. Workflow: **Direction Android closed testing**.
4. When the build finishes, download `app-release.aab` from the artifacts and upload it in Play Console → Closed testing.

The AAB `versionCode` comes from `android/app/build.gradle` (currently 7). Do not let Codemagic bump it.

## One-time environment (this Linux box)

Already installed during this build:

- OpenJDK 21 (`/usr/lib/jvm/java-21-openjdk-amd64`)
- Android SDK cmdline-tools + `platforms;android-36` + `build-tools;36.0.0` + platform-tools under `/home/box/Android/Sdk`
- Licenses accepted via `sdkmanager --licenses`

```bash
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
export ANDROID_HOME=/home/box/Android/Sdk
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

# If rebuilding SDK from scratch:
# yes | sdkmanager --licenses
# sdkmanager --install "platform-tools" "platforms;android-36" "build-tools;36.0.0"
echo "sdk.dir=$ANDROID_HOME" > android/local.properties
```

Node 20+ and npm are required for Capacitor CLI.

## Exact build commands

From `/workspace/direction-native`:

```bash
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
export ANDROID_HOME=/home/box/Android/Sdk
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

# Ensure sdk.dir is set (gradle reads android/local.properties)
echo "sdk.dir=$ANDROID_HOME" > android/local.properties

npm install
npx cap sync android

cd android
./gradlew bundleRelease --no-daemon

# Copy to project root for handoff
cp -f app/build/outputs/bundle/release/app-release.aab ../direction-release.aab
```

Optional APK (sideload / device test, not for Play):

```bash
cd android && ./gradlew assembleRelease
# → app/build/outputs/apk/release/app-release.apk
```

Bump Play version: edit `versionCode` / `versionName` in `android/app/build.gradle` → `defaultConfig`. The project is `versionName` 1.1 / `versionCode` 7. iOS marketing version and build are `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` in `ios/App/App.xcodeproj/project.pbxproj` (1.1 / 7). `ios/App/App/Info.plist` sets `ITSAppUsesNonExemptEncryption` to false and `NSMicrophoneUsageDescription`. `ios/App/App/PrivacyInfo.xcprivacy` declares email, audio, and purchase history, with tracking off.

## Google Play upload notes

1. Play Console → your app (create listing if new) → **Production** / **Internal testing** / **Closed testing** → Create release → Upload `direction-release.aab`.
2. Enable **Play App Signing** (default for new apps). Upload this AAB with the upload key above; Google holds the app-signing key.
3. First release checklist:
   - Store listing (title, short/full description, screenshots — see `/workspace/direction-play-assets/`).
   - Content rating questionnaire.
   - Privacy policy URL (e.g. `https://mydirection.app/...` — allowed in WebView navigation).
   - Target audience / Data safety form (declare microphone if you collect audio).
4. Package name **must** stay `com.gthconsulting.direction` for the life of the listing.
5. Do **not** upload a debug-signed build for production; this AAB uses the dedicated upload keystore.
6. After upload, wait for processing, then roll out to the chosen track.

This repo does **not** upload to Play; leave the AAB for manual Console upload.

## Config reference

`capacitor.config.json`:

- `appId`: `com.gthconsulting.direction`
- `appName`: `Direction`
- `server.url`: `https://app.mydirection.app`
- `server.allowNavigation`: `app.mydirection.app` and mydirection.app, plus Supabase / Google / Apple hosts. Sign-in itself uses `window.DirectionAuth` and the system browser, not a WebView navigation.
- `ios.contentInset`: `never`. The view controller sizes the WebView to the safe area instead, so a scroll-view inset would pad twice.
- `ios.backgroundColor`: `#0a0a0a` (also the safe-area gap behind the status bar)
- `android.adjustMarginsForEdgeToEdge`: `auto` (insets the WebView only when Android 15+ forces edge-to-edge)
- Dark splash via SplashScreen plugin + `#0a0a0a` background

## Project layout

```
direction-native/
  capacitor.config.json
  package.json
  www/index.html          # offline/fallback UI
  direction-release.aab   # local upload-ready bundle (gitignored; not in CI)
  codemagic.yaml          # ios-testflight + android-closed-testing
  android/                # Capacitor Android project
    app/build.gradle      # applicationId + signing; upload key is Codemagic direction_upload, alias upload
    local.properties      # sdk.dir (machine-local)
```

## Rebuild after web config changes

If you change `capacitor.config.json` or `www/`:

```bash
npx cap sync android
cd android && ./gradlew bundleRelease
```

