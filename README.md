# Direction — Capacitor Android wrapper

Native Android shell that loads **https://app.mydirection.app** in a fullscreen Capacitor WebView. Built for Google Play AAB upload.

| Field | Value |
|-------|--------|
| Package / applicationId | `com.gthconsulting.direction` |
| App label | Direction |
| Capacitor | 7.x |
| Web target | `https://app.mydirection.app` |
| Allowed nav | `app.mydirection.app` + mydirection.app, Supabase (`mqwayjaefnygtjqgdwxq.supabase.co`, `*.supabase.co`), Google OAuth (`accounts.google.com`, `*.google.com`, `*.googleusercontent.com`), Sign in with Apple (`appleid.apple.com`, `*.apple.com`) |
| Min / target SDK | 23 / 36 |
| Release AAB | [`direction-release.aab`](./direction-release.aab) |
| Android version | `versionName` 1.1 / `versionCode` 7 |
| iOS version | marketing 1.1 / build 6 |

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

After changing `www/direction-iap.js`, run `npx cap sync` so the script is copied into the Android and iOS bundles. The projects currently set Android `versionCode` 7 (`versionName` 1.1) and iOS build 6 (marketing 1.1). Play already used versionCode 3, rejected a later upload because versionCode 4 existed as versionName 1.0, and the repo has since moved to 7. The next store upload must be higher than whatever Play and App Store Connect already show. `ITSAppUsesNonExemptEncryption` is false because Direction only uses exempt HTTPS. In Play Console, license testers must install from the testing track. In App Store Connect, the In-App Purchase capability is recorded on the Xcode target; sign a sandbox tester in when the purchase sheet appears.

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

Release AABs are signed with the upload keystore. The keystore file stays out of git (`*.keystore` is ignored). Passwords are not in this repo.

A password used to be committed in `android/app/build.gradle` and this README. It is still in git history. Treat that upload key as exposed and decide in Play Console whether to reset it. This change does not rewrite history.

### Release signing variables

`android/app/build.gradle` reads the first non-empty value of each pair from the environment or from a Gradle property (`~/.gradle/gradle.properties` or `android/gradle.properties`, neither of which should be committed). `bundleRelease` and `assembleRelease` fail if the set is incomplete.

| Purpose | Codemagic (`android_signing` reference `direction_upload`) | Local env or Gradle property |
|--|--|--|
| Keystore file | `CM_KEYSTORE_PATH` | `DIRECTION_KEYSTORE_PATH` |
| Keystore password | `CM_KEYSTORE_PASSWORD` | `DIRECTION_KEYSTORE_PASSWORD` |
| Key alias | `CM_KEY_ALIAS` | `DIRECTION_KEY_ALIAS` |
| Key password | `CM_KEY_PASSWORD` | `DIRECTION_KEY_PASSWORD` |

Codemagic injects the `CM_*` variables when the Android keystore reference `direction_upload` is selected. Put the keystore file and passwords in Codemagic, not in git.

## Codemagic Android closed testing

`direction-release.aab` and `direction-release-v3.aab` (Play versionCode 3) were built on a machine that had `android/direction-upload.keystore`, with `./gradlew bundleRelease`. That keystore is gitignored, so this repo cannot sign a Play AAB by itself. Workflow `android-closed-testing` in `codemagic.yaml` repeats that local release build and signs with the same upload key. It has no `triggering` events, so it starts only when you start it. It does not upload to Play.

Add the keystore once in Codemagic (Team settings → Code signing identities → Android keystores):

| Codemagic field | Value |
|-----------------|--------|
| Reference name | `direction_upload` |
| Keystore file | the upload keystore used for earlier Play uploads (not committed) |
| Keystore password | stored only in Codemagic, exported as `CM_KEYSTORE_PASSWORD` |
| Key alias | stored only in Codemagic, exported as `CM_KEY_ALIAS` |
| Key password | stored only in Codemagic, exported as `CM_KEY_PASSWORD` |

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

Bump Play version: edit `versionCode` / `versionName` in `android/app/build.gradle` → `defaultConfig`. The project is `versionName` 1.1 / `versionCode` 7. iOS marketing version and build are `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` in `ios/App/App.xcodeproj/project.pbxproj` (1.1 / 6). `ios/App/App/Info.plist` sets `ITSAppUsesNonExemptEncryption` to false and `NSMicrophoneUsageDescription`. `ios/App/App/PrivacyInfo.xcprivacy` declares email, audio, and purchase history, with tracking off.

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
- `server.allowNavigation`: `app.mydirection.app` and mydirection.app, plus the Supabase / Google / Apple hosts required for in-WebView OAuth
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
    direction-upload.keystore
    app/build.gradle      # applicationId + signing
    local.properties      # sdk.dir (machine-local)
```

## Rebuild after web config changes

If you change `capacitor.config.json` or `www/`:

```bash
npx cap sync android
cd android && ./gradlew bundleRelease
```

