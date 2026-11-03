# Direction mistake audit — 2026-10-30

Read-only audit. No app code, config, or store listings were changed.

This repository is the Capacitor shell (`com.gthconsulting.direction`). It loads `https://app.mydirection.app` and injects `window.DirectionIAP`. The paywall, account screens, and legal copy live in that remote SPA, which is not in this git tree. Those findings cite the production bundles fetched on 2026-10-30:

- `https://app.mydirection.app/assets/index-BIA-TS0Z.js`
- `https://app.mydirection.app/assets/privacy-n4MvvCJN.js`
- `https://app.mydirection.app/assets/terms-CMUGFSj0.js`
- `https://app.mydirection.app/assets/faq-DLgFbKrf.js`
- `https://app.mydirection.app/assets/about-DvDhRlrG.js`
- `https://app.mydirection.app/assets/account-Bo58vJBm.js`
- `https://app.mydirection.app/assets/voices-DGmfKS7C.js`
- `https://app.mydirection.app/assets/wellness-disclaimer-COSELl65.js`

Billing plugin inspected: `@capgo/native-purchases@7.19.2` (pinned in `package.json`). Supabase project `mqwayjaefnygtjqgdwxq`. The Supabase MCP returned “You do not have permission,” and this repo has no SQL migrations, so row-level security could not be confirmed from schema.

---

## 1. Subscriptions (Play rejection check)

Direction sells two auto-renewing subscriptions through `@capgo/native-purchases`, with a postinstall patch (`scripts/patch-native-purchases.js`) that replaces Android offer selection. Product IDs are the same on Play and the App Store. iOS ignores `planIdentifier` and `offerId`; StoreKit 2 applies an introductory offer on its own (`NativePurchasesPlugin.swift` `purchaseProduct` builds `Product.PurchaseOption` from quantity and `appAccountToken` only).

### What must exist in Play Console and App Store Connect

The code will only purchase these ids. Play base plan ids and offer ids are case-sensitive.

| | Monthly | Yearly |
|--|---------|--------|
| Play subscription product id | `direction_premium_monthly` | `direction_premium_yearly` |
| Play base plan id | `monthly` | `yearly` |
| Play offer id | `trial-7-days` | `trial-7-days` |
| App Store product id | `direction_premium_monthly` | `direction_premium_yearly` |
| App Store introductory offer | 1 week free (StoreKit applies it; no offer id is sent) | 1 week free |

These are two subscription products, each with one base plan. A single Play subscription that contains both base plans will not match, because `getProducts` queries the two product ids above (`www/direction-iap.js` lines 14–27 and 357–360).

For each Play product, Console needs both of these offers active and eligible:

1. The base plan itself, which Billing returns with `offerId` null and a single pricing phase at the recurring price (`$9.99` / `P1M`, `$59.99` / `P1Y`, localized).
2. An offer whose id is exactly `trial-7-days`: first phase free for 7 days (`P7D`, price 0), second phase the same recurring price. Eligibility should be new customers (or whoever should see the trial).

If the Console offer id is something else (`trial`, `free-trial`, a generated id), the patched client still selects a free first phase when one is present, but the id the code asks for is `trial-7-days`. If the base plan id is not exactly `monthly` or `yearly`, the patched client refuses the purchase (`ITEM_UNAVAILABLE`, “No subscription offer for plan …”) instead of launching a token. An AAB built without the postinstall patch falls through to the first offer on the product, which is the SolSync “item could not be found” path.

### Displayed price when a free trial exists

**The native bridge avoids the SolSync `$0` priceString bug. The paywall still hardcodes USD, and that string is what a reviewer reads next to the buttons.**

Plugin behavior (`NativePurchasesPlugin.java` `queryProductDetails`, published 7.19.2): `getProducts` emits one row per `SubscriptionOfferDetails`, and `price` / `priceString` are the **first** pricing phase. For `trial-7-days` that first phase is `0` / a formatted zero (`$0.00`, `Free`, or the local equivalent). The recurring price is phase 2 and is not copied into `priceString`.

`normalizeAndroidProducts` (`www/direction-iap.js` lines 195–235) then:

- groups rows by Play product id (`planIdentifier` in the plugin payload)
- keeps the row whose `offerId` is null as the base plan
- sets `price` / `priceString` from that base row, else the first row with `price > 0`, else the first row
- sets `hasFreeTrial` when `trial-7-days` is present or any offer id has price 0

`test/direction-iap.test.js` lines 67–118 lock this for monthly: a `$0.00` trial row plus a `$9.99` base row becomes `priceString === '$9.99'` and `hasFreeTrial === true`. iOS `Product.displayPrice` is the recurring price (`Product+CapacitorPurchasesPlugin.swift` lines 42–50). The plugin does **not** return `introductoryPrice`, so `normalizeIosProducts` (`www/direction-iap.js` lines 250–263) never sees a free intro and always sets `hasFreeTrial` false on iOS.

The SPA does not use `hasFreeTrial`, `currencyCode`, or a billing period. In `index-BIA-TS0Z.js` the paywall (`function Ib`) does this:

```javascript
var oy = 9.99, sy = 59.99;
function cy(e) { return `$${e.toFixed(2)}`; }
var ly = `${cy(oy)}/mo`, uy = `${cy(sy)}/yr`, dy = `7-day trial`;
var fy = `${ly} or ${uy} with a ${dy}`;
var py = Number((oy * 12).toFixed(2));
// buttons start as the USD strings, then:
f(xb(t, `direction_premium_monthly`) ?? ly)
m(xb(t, `direction_premium_yearly`) ?? uy)
// xb() is: products.find(p => id matches)?.priceString?.trim() || null
```

When Premium is selected, the screen always appends this sentence, using `fy`, `cy(sy)`, `cy(oy)`, and `cy(py)`, not the store prices in state:

`"$9.99/mo or $59.99/yr with a 7-day trial. Yearly is the better deal — $59.99 once, not 12 × $9.99 ($119.88)."`

That is the same class of Subscriptions-policy mismatch that got SolSync rejected:

- The sentence is USD even when the buttons later show a localized `priceString` (`€9,99`, `US$9.99`, `¥1,200`).
- There is no other “per month / per year” on the store-fed buttons. `getFormattedPrice()` is only the amount. The period exists only in the hardcoded sentence.
- If `getProducts` fails or `priceString` is empty, the buttons stay on `$9.99/mo` and `$59.99/yr` (`useState(ly)` / `useState(uy)`).
- If Play returns only the trial offer (no null-`offerId` base row), the bridge’s last resort is that trial row. `priceString` is then `$0.00` or `Free`, which is non-empty, so the `?? ly` fallback does not run and the button shows zero. Checkout still shows the post-trial price.
- `hasFreeTrial` is ignored. Copy says “7-day trial” for every user, including people Play has already dropped from the trial offer and iOS users whose intro price was never read.

**Offer token.** Unpatched 7.19.2 `purchaseProduct` uses the first `SubscriptionOfferDetails` whose `basePlanId` equals `planIdentifier`, otherwise `offers.get(0)`. That first row is often the trial, and `get(0)` can be a different base plan’s token (“item could not be found”). The Direction patch (`scripts/patch-native-purchases.js` lines 53–101 and 172–195) selects, in order: offer id `trial-7-days`, any free first phase, the base plan (`offerId` null), then the first offer for that base plan. If nothing matches the base plan id, it rejects `ITEM_UNAVAILABLE` and does not call `launchBillingFlow`. `www/direction-iap.js` lines 398–404 always sends `planIdentifier` `monthly` or `yearly` and `offerId` `trial-7-days`. Codemagic runs `npm ci`, which runs the postinstall patch, before `cap sync`. A build that skips `npm install` ships the unpatched plugin.

iOS does not take an offer token. A wrong Play offer id does not affect StoreKit. A missing or mis-typed App Store product id fails with “Cannot find product.”

**Suggested fix**

1. In Play Console, create or rename to the ids in the table. Confirm a null-offer base plan is returned for new users (not only the trial offer).
2. On the paywall, render `priceString` plus the store billing period (`P1M` / `P1Y`, which the plugin does not currently expose — read `pricingPhases` and pass the recurring phase through `DirectionIAP`). Show trial length and the post-trial price only when `hasFreeTrial` is true. Delete `oy` / `sy` / `ly` / `uy` / `fy` / `py` from the purchase UI. If the store price is missing, say the price is unavailable and do not start a purchase.
3. Keep the offer-selection patch, and add a unit case where the only Android row is the `$0` trial so a regression cannot show zero.
4. Pass `introductoryPrice` (or StoreKit `subscription.introductoryOffer`) through the iOS plugin so `hasFreeTrial` is real on iPhone.

---

## Critical

### C1. Paywall states a hardcoded USD price and a hardcoded trial on every Premium purchase

**Evidence.** Production `index-BIA-TS0Z.js`, paywall `Ib`, constants `oy=9.99`, `sy=59.99`, `ly`/`uy`/`fy`/`dy`, and the sentence `` `${fy}. Yearly is the better deal — ${cy(sy)} once, not 12 × ${cy(oy)} (${cy(py)}).` ``. Buttons use `priceString ??` those USD strings. The bridge that feeds `priceString` is `www/direction-iap.js` lines 211–232. Legal pages repeat the same numbers: `privacy-n4MvvCJN.js`, `terms-CMUGFSj0.js`, `faq-DLgFbKrf.js`, `about-DvDhRlrG.js` (“Premium is $9.99 a month, or $59.99 a year, with a 7-day trial”).

**Why it matters.** Play’s Subscriptions policy requires the price on the paywall to be the price Play will charge, in the user’s currency and period. SolSync was rejected because a hardcoded USD fallback did not match localized checkout, after the plugin reported the trial phase as `priceString`. Direction’s bridge prefers the base-plan row, so the buttons can be right in the US when both offers are returned. The disclosure under the buttons is still always `$9.99/mo or $59.99/yr` plus `$119.88` math. A non-US license tester, or a catalog that only returns the trial row (`$0.00`), does not match the Play sheet. Apple reviews the same screen against `products[].priceString` (called out in `README.md` line 30).

**Suggested fix.** Drive every price, period, currency, and trial phrase from `getProducts()`. Remove the USD constants from the paywall and from the “better deal” sentence. Compute savings from the two store prices. See section 1.

### C2. Upload-key password is committed in git

**Evidence.** `android/app/build.gradle` lines 31–34:

```gradle
storeFile file("../direction-upload.keystore")
storePassword "DirectionUpload2026!"
keyAlias "direction-upload"
keyPassword "DirectionUpload2026!"
```

The same password is in `README.md` lines 97–105 and again in the Codemagic table (lines 113–121). `git log -S 'DirectionUpload2026'` shows it has been in history since `90f5ef3`. `*.keystore` is gitignored (`.gitignore` line 8) and no keystore blob is in history. The password is.

**Why it matters.** Anyone with the repo and a copy of `android/direction-upload.keystore` (the README says that file exists on the build machine and was used for the versionCode 3 AAB) can sign updates as Direction. Play App Signing does not make a leaked upload key harmless.

**Suggested fix.** Revoke/reset the upload key in Play Console, generate a new keystore, and store the password only in Codemagic (`CM_KEYSTORE_PASSWORD` / `CM_KEY_PASSWORD`, already the branch at `build.gradle` lines 24–29). Delete the literals from `build.gradle` and `README.md`. Local release builds should fail closed when the env vars are absent, rather than falling back to a password in source.

---

## High

### H1. “7-day trial” is shown even when the store will charge immediately

**Evidence.** SPA `dy = '7-day trial'` is unconditional. `hasFreeTrial` is computed in `www/direction-iap.js` lines 219–232 and 250–263 and is not read by the SPA (`hasFreeTrial` occurs 0 times in `index-BIA-TS0Z.js`). The purchase call always sends `offerId: 'trial-7-days'` (`www/direction-iap.js` lines 398–404). The patch uses that offer only when Play still returns it; otherwise it purchases the paid base plan (`scripts/patch-native-purchases.js` lines 91–100). iOS never receives `introductoryPrice` (plugin `Product.dictionary`, 7.19.2).

**Why it matters.** A subscriber who already used the trial, or a store listing whose intro offer is missing, sees a free week and is billed today. That is a misleading-billing complaint on both stores, separate from the currency mismatch.

**Suggested fix.** Show the trial sentence only when the native payload says this user is eligible, and include the post-trial price and the date billing starts. On iOS, read `Product.subscription.introductoryOffer`.

### H2. Paywall omits auto-renew and how to cancel

**Evidence.** The Premium block in `Ib` shows the price buttons, the USD sentence from C1, a support mailto (“Premium help”), Restore (only when `DirectionIAP` exists), and the purchase button (`You're signing up for Premium · ${price}`). There is no “auto-renew”, “cancel”, or subscription-management string in `index-BIA-TS0Z.js` (`manageSubscriptions` occurs 0 times). The plan step does render the footer nav `Nb` to `/support`, `/privacy`, `/terms`, `/faq`, `/about`. Those routes returned HTTP 200. FAQ (`faq-DLgFbKrf.js`) says to cancel in Apple or Google settings “when store billing is live.” Terms say the same, in the future tense.

**Why it matters.** Apple guideline 3.1.2 requires the paywall to show title, length, price, and functional Privacy and Terms links, and auto-renewable subscriptions must explain that the plan renews and how to cancel. Play requires the same disclosure before the purchase sheet. Footer links cover Privacy and Terms. They do not state the billing period from the store, auto-renewal, or cancellation. `DirectionIAP.manageSubscriptions` exists (`www/direction-iap.js` lines 531–546) and is never called.

**Suggested fix.** On the Premium state, next to the purchase button, show: localized price, period, trial (only if eligible), that the plan renews until canceled, and a control that calls `manageSubscriptions()` (Play subscriptions center / App Store manage-subscriptions sheet). Point Terms at the in-app `/terms` (or Apple’s standard EULA if you adopt it) in the present tense.

### H3. Choosing Free does not cancel the store subscription, and Premium never expires locally

**Evidence.**

- Paywall confirm for Free calls `t({tier:'free', billingCycle})` and returns without a store call (`Ib`, `async function x`). `choosePlan` writes that tier into the zustand store (`index-BIA-TS0Z.js`, `choosePlan`).
- Premium is written the same way after `result.premium` or `getCustomerInfo().premium`. The only automatic store check upgrades to premium (`vb(n) && onConfirm({tier:'premium'})`). Nothing sets tier back to free when `getCustomerInfo` says free.
- Persisted key is `direction.v1` (`partialize` includes `tier`). `purchaseMonthly()` / `purchaseYearly()` are called with no arguments, so `appAccountToken` is never set (`www/direction-iap.js` lines 405–407 support it; the SPA does not pass it).
- No client call sends `purchaseToken`, `receipt`, or `jwsRepresentation` to Supabase. Speak/clone/craft are TanStack server functions (`xv`, `Sv`, `bv`) whose bodies are not in this repo. The client payload is text, voice id, or audio, not a receipt.
- `purchaseGrantsPremium` (`www/direction-iap.js` lines 287–297) returns true for any known product id after the active/expired checks, including when the transaction has no `isActive` and customer info is empty.
- `already_owned` forces `premium = true` even if `getPurchases` is empty (lines 442–444). The SPA then re-reads `getCustomerInfo` and does not upgrade if that is free, so this bridge lie is partly contained.

**Why it matters.** “Save Free” looks like cancellation and leaves Play/App Store billing running. A lapsed subscription stays Premium in local storage, which is what gates cloning, overnight loop, binaural, and longer sessions. A modified `direction.v1` tier is enough for the client to call the voice APIs. Server enforcement could not be verified; the client never records a purchase the server could check.

**Suggested fix.** Treat the store as the source of truth on launch and on resume: if `getCustomerInfo` is not premium, clear the local tier. “Free” on a device that owns the subscription should call `manageSubscriptions()`, not flip the flag. Send the purchase token / StoreKit JWS to a server function that verifies with Play Developer API and App Store Server API, and have speak/clone reject when that entitlement is expired. Stop granting premium from “known product id” alone.

### H4. Sign in with Apple requests the user’s name

**Evidence.** Live authorize redirect on 2026-10-30 (anon key, no `scopes` argument):

`https://appleid.apple.com/auth/authorize?...&scope=email+name&...&client_id=com.gthconsulting.direction.auth`

The SPA calls `signInWithOAuth({ provider, options: { redirectTo } })` for both `apple` and `google` (`function m` in `index-BIA-TS0Z.js`) and does not pass `scopes`. Onboarding skips the name step when `appleSignedIn` (`useEffect` sets step 1 → 2) and still stores Apple’s name: `completeOnboarding({ name: appleSignedIn ? appleName : typedName, ... })`, where `appleName` is `user_metadata.full_name` or `user_metadata.name` (`QE`).

**Why it matters.** The Apple sheet asks for name. App Review has been rejecting this pattern when the app must not request name. The client never overrides the scope, and the hosted GoTrue Apple provider is what adds `email name`.

**Suggested fix.** Pass `scopes: 'email'` for the Apple provider only. In the Supabase Apple provider settings, remove the `name` scope so the authorize URL no longer contains `name`. Stop reading `full_name` / `name` off an Apple identity. Re-check the Location header of `/auth/v1/authorize?provider=apple` until `scope=email` only.

### H5. Recording a voice on iOS will crash: no microphone usage string

**Evidence.** `ios/App/App/Info.plist` (lines 1–53) has no `NSMicrophoneUsageDescription` (and no camera or photo-library string). `voices-DGmfKS7C.js` calls `navigator.mediaDevices.getUserMedia({ audio: true })`. Android declares `RECORD_AUDIO` and `MODIFY_AUDIO_SETTINGS` (`android/app/src/main/AndroidManifest.xml` lines 5–6) and marks the microphone optional (line 10).

**Why it matters.** WKWebView terminates the process when the web page starts microphone capture without that plist key. Voice cloning is a Premium feature reviewers will try. The app also cannot explain the mic to the user.

**Suggested fix.** Add `NSMicrophoneUsageDescription` with a sentence about recording a voice sample to speak lines. Confirm the system prompt appears before the first `getUserMedia` on a device.

### H6. Deleting the account does not mention that the subscription keeps billing

**Evidence.** `function rD` in `index-BIA-TS0Z.js` shows “Delete account” and “This permanently deletes your account and all of its data.” It POSTs the edge function `delete-account`, then signs out and clears local state. It does not call `manageSubscriptions`. Unauthenticated POST to `https://mqwayjaefnygtjqgdwxq.supabase.co/functions/v1/delete-account` returned `401` `UNAUTHORIZED_NO_AUTH_HEADER`, so the function is deployed and rejects missing auth. Its source is not in this repo, so whether it deletes the auth user and related rows was not verified.

**Why it matters.** Apple 5.1.1(v) requires in-app account deletion if you support account creation (Google, Apple, and email sign-up are on the account screen). Deletion that leaves an auto-renewing subscription running, without saying so, is a billing complaint and an incomplete deletion story for review.

**Suggested fix.** In the confirm dialog, say the App Store / Play subscription is separate and must be canceled in the store, and offer `manageSubscriptions()` before the delete. Confirm the edge function deletes only the caller (service role on the server, user JWT checked) and that a failed delete does not clear the device and claim success.

---

## Medium

### M1. Supabase RLS was not verifiable, and the bundled anon JWT is rejected by the Data API

**Evidence.** No `.sql` files in the repo. Supabase MCP `list_tables` / `execute_sql` on `mqwayjaefnygtjqgdwxq` returned permission denied. `GET /rest/v1/` with the anon JWT embedded in `index-BIA-TS0Z.js` (`GE` / `KE`, role `anon`, not `service_role`) returned `401` `UNAUTHORIZED_INVALID_API_KEY_TYPE`. Auth (`/auth/v1/authorize`) and Functions accepted that same key. The SPA has no `.from('table')` query outside the library; profile, journal, and tier stay in `direction.v1` on device. No service-role key was found in the repo or the bundles.

**Why it matters.** Tables could still exist with RLS off and be reachable by another key. This audit cannot say they are protected. The client is also carrying a legacy anon JWT that PostgREST will not accept, so any future `supabase.from(...)` call fails closed for a confusing reason.

**Suggested fix.** In the Supabase dashboard, confirm every `public` table has RLS enabled and no policy is `true` for `anon`. Prefer the current publishable key if the legacy JWT is intentionally disabled. Keep the service role on the server only.

### M2. iOS billing-grace access is dropped when `isActive` is false

**Evidence.** `www/direction-iap.js` lines 128–133: after rejecting `expired` and `revoked`, `isActive === false` returns false before `inGracePeriod` and `inBillingRetryPeriod` are considered. The iOS plugin sets `isActive` from `expirationDate > Date()` (`TransactionHelpers.swift` lines 74–77) and can still report `subscriptionState` `inGracePeriod`.

**Why it matters.** During a billing retry the expiration date is often already past while Apple still expects you to keep access. Restore and the paywall’s store check will treat that subscriber as free. (Today’s local tier is not cleared, so this shows up when the store result is what grants Premium.)

**Suggested fix.** If `subscriptionState` is `inGracePeriod` or `inBillingRetryPeriod`, return true before the `isActive === false` return.

### M3. Privacy copy, sign-in copy, and what the app actually does disagree

**Evidence.**

- In-app privacy (`privacy-n4MvvCJN.js`): “We do not operate a cloud account that holds your journal in this build,” and “when App Store or Play billing is live.” Updated date in the bundle is 19 September 2026 (`wb` / `Tb`).
- Terms and the account screen: “Signing in enables syncing the account.”
- Marketing privacy `https://mydirection.app/privacy/` returned HTTP 200 and says “Updated 24 September 2026.”
- Voice clone uploads the sample through a server function “to xAI” (privacy text). Every app launch loads `https://grok.com/grok-app-builder/extensions.js`, which GETs `https://app-builder-deployer.grok.com/rest/app-deployer/v1/projects/01a086f2-e35c-7cb3-9f56-8885f78a81cd/remix-eligibility`. That response was `{"forkable":false,...}`, so the “Created with Grok / Remix” banner is not mounted today. The request still happens.
- `android:allowBackup="true"` (`AndroidManifest.xml` line 13) lets Android Auto Backup include WebView storage (journal, voice samples, `direction.v1`) in the user’s Google account. The privacy page says the walk stays on the device.

**Why it matters.** Data safety and App Privacy answers have to match collection. A reviewer who reads “billing is not live” while the binary sells subscriptions, or “no account” while Sign in with Apple is on the screen, will file a metadata mismatch. The Grok deployer call is an undisclosed third-party request inside the store WebView.

**Suggested fix.** One privacy policy, present tense: local journal, optional account (email via Google, Apple, or email/password), voice audio sent to your server and xAI for cloning and speech, purchases handled by Apple/Google, no sale of data. Remove the Grok app-builder script and `/__grok/` tags from the production HTML. Set `android:allowBackup="false"` or exclude WebView data, and say so if you keep backup.

### M4. Stale `direction.grok.me` is still a navigation origin

**Evidence.** `capacitor.config.json` lines 8–10 (`direction.grok.me`, `*.direction.grok.me`). `MainActivity.java` lines 63–68 registers the document-start IAP script for `https://direction.grok.me`. The live HTML `og:image` is `https://direction.grok.me/og.jpg` (that URL returned HTTP 200 on 2026-10-30). `allowNavigation` also includes `*.supabase.co`, `*.google.com`, and `*.apple.com` (`capacitor.config.json` lines 13–19).

**Why it matters.** The shell will follow a top-level navigation to the old host and to any host under Google, Apple, or Supabase. The IAP bridge is also injected on the old origin. Broad allow-lists are the usual WebView escape hatch if the remote page ever redirects.

**Suggested fix.** Remove `direction.grok.me` from config, `MainActivity`, and the og tag. Narrow `allowNavigation` to the OAuth hosts you actually use (`accounts.google.com`, `appleid.apple.com`, `mqwayjaefnygtjqgdwxq.supabase.co`, `app.mydirection.app`).

### M5. Store version numbers in the README do not match the projects

**Evidence.** `android/app/build.gradle` line 10 is `versionCode 7`, `versionName "1.1"`. `ios/App/App.xcodeproj/project.pbxproj` lines 360 and 380 are `CURRENT_PROJECT_VERSION = 6`, `MARKETING_VERSION = 1.1`. `README.md` lines 14, 73, 123, 130, and 182 still say Android versionCode 6 and iOS build 5. `codemagic.yaml` does not bump versions (good) but the README tells the next upload to use 6.

**Why it matters.** Play rejects an upload whose `versionCode` is not higher than the one already used. Shipping the README’s numbers after versionCode 6 and iOS build 5 are already taken fails the upload. The gradle/Xcode values look like the intended next builds (commit `8089127`); the README was not updated.

**Suggested fix.** Point the README at versionCode 7 and iOS build 6, and say the next uploads must be higher than whatever Play and App Store Connect already show.

### M6. Codemagic iOS signing is named for SolSync

**Evidence.** `codemagic.yaml` lines 6–7: `app_store_connect: SolSync App Store Connect`, bundle id `com.gthconsulting.direction`. Commit `770ed44` is “Point Codemagic iOS workflow at SolSync App Store Connect.”

**Why it matters.** If that integration is the GTH Consulting team key, uploads land on Direction because the bundle id is in the IPA. If it is a different Apple team, TestFlight submission fails or attaches to the wrong account. The name is how that mix-up survives.

**Suggested fix.** Use an App Store Connect API key for the team that owns `com.gthconsulting.direction`, and name the integration Direction.

### M7. No app privacy manifest, and R8 is off

**Evidence.** No `PrivacyInfo.xcprivacy` anywhere under `ios/`. `Info.plist` sets `ITSAppUsesNonExemptEncryption` false (line 23–24), which matches the README’s export-compliance note. `android/app/build.gradle` line 41 is `minifyEnabled false`. `proguard-rules.pro` is the template and does not keep line numbers. Target/compile SDK are 36, min SDK 23 (`android/variables.gradle` lines 2–4).

**Why it matters.** Apple has been rejecting archives that touch required-reason APIs (UserDefaults, file timestamps, disk space) without a privacy manifest. Capacitor’s pods ship their own manifests; the app target does not, and this audit did not open an archived IPA to see the merged result. R8 being off means there is no deobfuscation mapping to upload. That is acceptable while minify stays off; Play will not have a mapping file for native crashes. Target SDK 36 meets the Play target-API level required for updates as of 31 August 2026.

**Suggested fix.** Add an app `PrivacyInfo.xcprivacy` that declares the required-reason APIs the shell and WebView actually use, and confirm the uploaded build has no ITMS-91053. Leave R8 off until you add keep rules for Capacitor’s JavaScript interface and then upload the mapping with the AAB.

### M8. Purchase tokens are written to Android logcat

**Evidence.** In `@capgo/native-purchases@7.19.2` `handlePurchase`: `Log.d` of `purchase.toString()` and `purchase.getPurchaseToken()` (around lines 201–205 of `NativePurchasesPlugin.java`). The Direction patch does not remove those lines. `direction-iap.js` does not log tokens. The plugin also logs the purchase token at info level via `purchase.toString()`.

**Why it matters.** A Play purchase token is a credential for the Play Developer API. It should not sit in logcat on user devices.

**Suggested fix.** Drop token and full `Purchase.toString()` logs in the same patch file that already edits this class, or upgrade to a plugin release that does not log them.

### M9. In-app “Rate” link 404s on the public App Store

**Evidence.** `index-BIA-TS0Z.js` sets `kv` / `Av` to `https://apps.apple.com/app/id6813724034` and the same URL with `?action=write-review`. That URL returned HTTP 404 on 2026-10-30. The Play URL `https://play.google.com/store/apps/details?id=com.gthconsulting.direction` returned HTTP 200.

**Why it matters.** The rate sheet (`Enjoying Direction? Rate it`) sends iOS users to a dead page until that Apple ID is a live listing, or forever if `6813724034` is the wrong id.

**Suggested fix.** Confirm the numeric Apple ID in App Store Connect. Hide the rate action until the listing resolves.

---

## Low

### L1. Unit test never sees a trial-only Play payload

**Evidence.** `test/direction-iap.test.js` lines 81–116. Monthly has both a `$0.00` trial row and a `$9.99` base row. Yearly has only the `$59.99` base row, and the test expects `hasFreeTrial === false` for yearly. There is no case where the only row is the trial.

**Why it matters.** The SolSync failure mode (only the `$0` phase) is the branch `priced = offers[0]` in `www/direction-iap.js` line 218. The suite cannot catch it. The same fixture also teaches a reader that yearly has no trial, which is not what `PRODUCTS.direction_premium_yearly.offerId` says (line 24).

**Suggested fix.** Add a fixture with a single `trial-7-days` row at price 0 and assert the UI layer must not treat `$0.00` as the recurring price.

### L2. Plugin treats a subscription as a subscription only if the product id contains `"sub"`

**Evidence.** Published `NativePurchasesPlugin.java` `handlePurchase`, approximately line 263: `purchase.getProducts().get(0).contains("sub")` before it rewrites `productType` to `"subs"`. `direction_premium_monthly` and `direction_premium_yearly` do not contain that substring. Entitlement in this app uses `purchaseState` `"1"` / `"PURCHASED"` (`www/direction-iap.js` lines 136–137), and `getPurchases` is called with `productType: 'subs'`, so restore still sees Play subscription purchases.

**Why it matters.** Anything that trusted `productType` on the purchase result would classify these SKUs as in-app. The field is wrong today (`productType` is set from purchase state a few lines earlier).

**Suggested fix.** Don’t depend on `productType` from the purchase callback. If you patch the plugin further, key off the billing product type you queried, not the substring `sub`.

### L3. Free-tier timer copy disagrees with itself

**Evidence.** Paywall free card: “A short evening timer, about 30 minutes.” FAQ: “about 15 or 30 minutes.” `hy` in the bundle treats both 15 and 30 as the free durations.

**Suggested fix.** Use one duration in the paywall, FAQ, and store listing.

### L4. FileProvider exposes external storage root

**Evidence.** `android/app/src/main/res/xml/file_paths.xml` lines 3–4: `external-path` and `cache-path` with `path="."`. The provider is `exported="false"` (`AndroidManifest.xml` lines 37–44).

**Why it matters.** This is the Capacitor template. A bug that grants a URI from this provider can see more than the app’s cache. It is not remotely reachable by itself.

**Suggested fix.** Narrow the paths to the cache directory the app actually shares.

### L5. `cap add ios` in CI can recreate the Xcode project

**Evidence.** `codemagic.yaml` lines 24–26 run `npx cap add ios || true` before `cap sync`. The storyboard’s controller is `DirectionBridgeViewController` (`ios/App/App/Base.lproj/Main.storyboard`). A fresh Capacitor template would drop that class and the IAP script would never install.

**Suggested fix.** Remove `cap add ios` from the workflow. The `ios/` project is already in git. Run `cap sync ios` only.

---

## Checked and not a finding

- **Web checkout.** Outside the shell, Premium shows “Premium is purchased in the app” and does not open a card form. No Stripe or other non-Apple payment path is in the bundles. iOS purchases go through StoreKit; Android through Play Billing. That matches “IAP for digital Premium.”
- **Restore.** `restorePurchases` calls the store, then `getPurchases`. Expired, revoked, and pending rows are excluded (`www/direction-iap.js` lines 124–137; test “getCustomerInfo ignores expired, revoked, and pending purchases”). A restore with no active subscription resolves `premium: false` rather than throwing.
- **Cancel and billing errors.** User cancel is classified and does not clear an already active subscription. The Android patch maps Billing response codes to stable codes (`scripts/patch-native-purchases.js` lines 114–140) so the WebView gets a result instead of an uncoded rejection.
- **Marketing email opt-in.** There is no newsletter checkbox and no opt-in flag. Email sign-up collects email and password only. Nothing defaults to opted-in.
- **Account creation vs deletion entry point.** Signed-in users get a Delete account control (`rD`), not only Sign out. Guest use does not create an account.
- **Health claims.** Onboarding step 4, `wellness-disclaimer-COSELl65.js`, FAQ, terms, and about say Direction is not therapy, not a medical device, and does not diagnose, treat, cure, or prevent any condition, and they point at 988 for a US crisis. “Inner child” in the store blurb is described as reflective. No cure/clinical-proof claim turned up in those pages.
- **Children.** Privacy and terms say 17+.
- **Service-role key.** Not present in the repo or the shipped JS. The embedded JWT’s payload role is `anon`.
- **Cleartext.** `android:usesCleartextTraffic="false"`. `server.url` is `https://app.mydirection.app`.
- **Target SDK.** 36 / min 23. Export compliance flag is set.
- **Plugin on web.** `DirectionIAP` resolves `unavailable` instead of throwing when `NativePurchases` is missing (`www/direction-iap.js` lines 328–338; test covers it).

---

## Lint, typecheck, tests

| Check | Result |
|--|--|
| `npm test` (`node --test test/direction-iap.test.js`) | **15 passed, 0 failed** (2026-10-30) |
| Lint script | None in `package.json` |
| Typecheck script | None in `package.json`. The shell is plain JS plus Java/Swift; no `tsconfig.json` |
| Android `ExampleUnitTest` / instrumented example | Capacitor template tests under `android/app/src/test` and `androidTest`. Not part of `npm test`. Not run (they do not exercise Direction). |

The passing IAP tests do not cover the live paywall, a trial-only Play response, or a non-USD `priceString`.

---

## Prioritized action list

1. **Play paywall (C1, H1, H2).** Remove hardcoded `$9.99` / `$59.99` / “7-day trial” / `$119.88` from the purchase UI. Show the store’s recurring localized price, billing period, and trial terms only when that user is eligible, plus auto-renew and how to cancel, with Privacy and Terms on that screen.
2. **Confirm Console ids before the next AAB (section 1).** Products `direction_premium_monthly` and `direction_premium_yearly`; base plans `monthly` and `yearly`; offer id `trial-7-days` on each; a separate base-plan row with a null offer id so the price is not the `$0` trial phase. App Store products use the same ids and a 1-week free introductory offer. Mismatch: patched builds fail the purchase; unpatched builds can launch the wrong token.
3. **Rotate the upload key (C2).** Remove `DirectionUpload2026!` from `build.gradle` and the README. New keystore, password only in Codemagic.
4. **Entitlements (H3, M2).** Verify receipts on the server. Clear local Premium when the store says the sub is expired. Grace and billing-retry stay Premium. “Free” must open the store’s subscription manager.
5. **Sign in with Apple (H4).** `scopes: 'email'` and the same change on the Supabase Apple provider. Confirm the authorize redirect no longer contains `name`.
6. **iOS mic string (H5) and privacy manifest (M7).** `NSMicrophoneUsageDescription` before anyone records. Add `PrivacyInfo.xcprivacy` and check the archive.
7. **Account deletion copy (H6).** Say the store subscription keeps renewing, and link to manage-subscriptions. Confirm `delete-account` deletes the caller.
8. **Policy text and shell allow-list (M3, M4, M5).** Rewrite privacy/terms in the present tense (account, xAI audio, live IAP). Drop the Grok loader and `direction.grok.me`. Fix the README to versionCode 7 and iOS build 6. Confirm the Codemagic ASC key is the Direction team (M6).
9. **RLS (M1).** In the Supabase project, turn on RLS for every table and read the advisors. This audit could not.
10. **Tests (L1).** Assert that a Play payload whose only row is the free-trial phase is not shown as the recurring price.
