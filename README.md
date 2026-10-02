# Direction — Capacitor Android wrapper

Native Android shell that loads **https://app.mydirection.app** in a fullscreen Capacitor WebView. Built for Google Play AAB upload.

| Field | Value |
|-------|--------|
| Package / applicationId | `com.gthconsulting.direction` |
| App label | Direction |
| Capacitor | 7.x |
| Web target | `https://app.mydirection.app` |
| Allowed nav | `app.mydirection.app` + mydirection.app, temporary fallback `direction.grok.me`, Supabase (`mqwayjaefnygtjqgdwxq.supabase.co`, `*.supabase.co`), Google OAuth (`accounts.google.com`, `*.google.com`, `*.googleusercontent.com`), Sign in with Apple (`appleid.apple.com`, `*.apple.com`) |
| Min / target SDK | 23 / 36 |
| Release AAB | [`direction-release.aab`](./direction-release.aab) |
| Android version | `versionName` 1.1 / `versionCode` 3 |
| iOS version | marketing 1.1 / build 3 |

## Subscriptions (Play Billing + StoreKit)

The native shell sells Direction Premium. The remote SPA is not bundled with a billing SDK; inside the app it calls `window.DirectionIAP`, which is injected before the page scripts run. Product IDs live in `www/direction-iap.js`.

| | Monthly | Yearly |
|--|---------|--------|
| Product ID (Play and App Store) | `direction_premium_monthly` | `direction_premium_yearly` |
| Play base plan ID | `monthly` | `yearly` |
| Play offer ID | `trial-7-days` (7-day free trial) | `trial-7-days` (7-day free trial) |
| App Store | $9.99/mo + 1-week introductory offer | $59.99/yr + 1-week introductory offer |

Plugin: [`@capgo/native-purchases@7.19.2`](https://github.com/Cap-go/capacitor-native-purchases) (Capacitor 7, Play Billing 8, StoreKit 2). `npm install` patches Android offer selection so an eligible `trial-7-days` offer is purchased, and so cancel / already-owned / other billing results come back as stable error codes. StoreKit applies the introductory offer on its own; pass `planIdentifier` only because Play requires the base plan id.

Show prices from `getProducts()`. Apple reviews the paywall against `products[].priceString`.

```javascript
const iap = window.DirectionIAP;
if (!iap) throw new Error('Open Direction from the iOS or Android app');

const { products } = await iap.getProducts(); // same payload as getOfferings()
// products[].priceString is the localized recurring price
// products[].hasFreeTrial is true when Play returned trial-7-days for this user

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

After changing `www/direction-iap.js`, run `npx cap sync` so the script is copied into the Android and iOS bundles. Closed testing needs an AAB with `versionCode` 3. TestFlight needs iOS build 3. In Play Console, license testers must install from the testing track. In App Store Connect, the In-App Purchase capability is recorded on the Xcode target; sign a sandbox tester in when the purchase sheet appears.

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

Signed with the **upload keystore** at `android/direction-upload.keystore` (alias `direction-upload`). Ready to upload to Play Console with Play App Signing enabled (recommended).

### Upload keystore (keep private)

| | |
|--|--|
| File | `android/direction-upload.keystore` |
| Alias | `direction-upload` |
| Store / key password | `DirectionUpload2026!` |

**Before treating this as production:** back up the keystore offline, store passwords in a secret manager, and consider regenerating if this machine or repo is shared. Losing the upload key complicates Play updates (Play App Signing still lets Google re-sign for devices, but you must prove ownership to reset the upload key).

Signing is wired in `android/app/build.gradle` (`signingConfigs.release`).

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

Bump Play version: edit `versionCode` / `versionName` in `android/app/build.gradle` → `defaultConfig`. Current store upload is `versionName` 1.1 / `versionCode` 3. iOS marketing version and build are `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` in `ios/App/App.xcodeproj/project.pbxproj` (1.1 / 3).

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
- `server.allowNavigation`: `app.mydirection.app` and mydirection.app, `direction.grok.me` kept as a temporary fallback, plus the Supabase / Google / Apple hosts required for in-WebView OAuth
- Dark splash via SplashScreen plugin + `#0a0a0a` background

## Project layout

```
direction-native/
  capacitor.config.json
  package.json
  www/index.html          # offline/fallback UI
  direction-release.aab   # upload-ready release bundle
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

