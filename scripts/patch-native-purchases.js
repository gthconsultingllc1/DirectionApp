#!/usr/bin/env node
/**
 * Teach @capgo/native-purchases@7.19.2 two Direction-specific behaviors:
 * 1. Pick the Play offer the user is eligible for (trial-7-days, else base plan)
 *    instead of whichever SubscriptionOfferDetails row happens to be first.
 * 2. Reject billing failures with a stable code (USER_CANCELED, ITEM_ALREADY_OWNED, …)
 *    so the WebView bridge can return a result instead of crashing.
 *
 * The plugin is pinned. Re-run is a no-op once both markers are present.
 */
const fs = require('fs');
const path = require('path');

const target = path.join(
  __dirname,
  '..',
  'node_modules',
  '@capgo',
  'native-purchases',
  'android',
  'src',
  'main',
  'java',
  'ee',
  'forgr',
  'nativepurchases',
  'NativePurchasesPlugin.java',
);

if (!fs.existsSync(target)) {
  console.log('patch-native-purchases: @capgo/native-purchases is not installed, skipping');
  process.exit(0);
}

const original = fs.readFileSync(target, 'utf8');
if (
  original.includes('DIRECTION_OFFER_SELECTION') &&
  original.includes('DIRECTION_BILLING_ERROR')
) {
  console.log('patch-native-purchases: already patched');
  process.exit(0);
}

function replaceOnce(source, oldText, newText, label) {
  const count = source.split(oldText).length - 1;
  if (count !== 1) {
    console.error(`patch-native-purchases: expected 1 match for ${label}, found ${count}`);
    process.exit(1);
  }
  return source.replace(oldText, newText);
}

const helper = `
    // DIRECTION_OFFER_SELECTION
    // Play returns every eligible offer for a base plan. The first row is not
    // guaranteed to be the free trial. Prefer the offer id requested by
    // DirectionIAP (trial-7-days) when it is still in the list, then any free
    // first phase, then the base plan (offer id null). Ineligible trials are
    // omitted by Play, so this falls through to the paid base plan.
    private ProductDetails.SubscriptionOfferDetails selectSubscriptionOffer(
        List<ProductDetails.SubscriptionOfferDetails> offers,
        String planIdentifier,
        String requestedOfferId
    ) {
        if (offers == null || offers.isEmpty()) {
            return null;
        }
        ProductDetails.SubscriptionOfferDetails requested = null;
        ProductDetails.SubscriptionOfferDetails freeTrial = null;
        ProductDetails.SubscriptionOfferDetails baseOffer = null;
        ProductDetails.SubscriptionOfferDetails firstForPlan = null;
        for (ProductDetails.SubscriptionOfferDetails offer : offers) {
            if (planIdentifier != null && !planIdentifier.isEmpty() && !planIdentifier.equals(offer.getBasePlanId())) {
                continue;
            }
            if (firstForPlan == null) {
                firstForPlan = offer;
            }
            String offerId = offer.getOfferId();
            Log.d(TAG, "Offer basePlan=" + offer.getBasePlanId() + " offerId=" + offerId);
            if (requestedOfferId != null && !requestedOfferId.isEmpty() && requestedOfferId.equals(offerId)) {
                requested = offer;
            }
            if ((offerId == null || offerId.isEmpty()) && baseOffer == null) {
                baseOffer = offer;
            }
            if (freeTrial == null && isFreeIntroductoryPhase(offer)) {
                freeTrial = offer;
            }
        }
        if (requested != null) {
            return requested;
        }
        if (freeTrial != null) {
            return freeTrial;
        }
        if (baseOffer != null) {
            return baseOffer;
        }
        return firstForPlan;
    }

    private boolean isFreeIntroductoryPhase(ProductDetails.SubscriptionOfferDetails offer) {
        if (offer == null || offer.getPricingPhases() == null) {
            return false;
        }
        List<ProductDetails.PricingPhase> phases = offer.getPricingPhases().getPricingPhaseList();
        if (phases == null || phases.isEmpty()) {
            return false;
        }
        return phases.get(0).getPriceAmountMicros() == 0L;
    }

    // DIRECTION_BILLING_ERROR
    private static String billingErrorCode(int responseCode) {
        switch (responseCode) {
            case BillingClient.BillingResponseCode.USER_CANCELED:
                return "USER_CANCELED";
            case BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED:
                return "ITEM_ALREADY_OWNED";
            case BillingClient.BillingResponseCode.ITEM_UNAVAILABLE:
                return "ITEM_UNAVAILABLE";
            case BillingClient.BillingResponseCode.ITEM_NOT_OWNED:
                return "ITEM_NOT_OWNED";
            case BillingClient.BillingResponseCode.SERVICE_UNAVAILABLE:
                return "SERVICE_UNAVAILABLE";
            case BillingClient.BillingResponseCode.BILLING_UNAVAILABLE:
                return "BILLING_UNAVAILABLE";
            case BillingClient.BillingResponseCode.SERVICE_DISCONNECTED:
                return "SERVICE_DISCONNECTED";
            case BillingClient.BillingResponseCode.FEATURE_NOT_SUPPORTED:
                return "FEATURE_NOT_SUPPORTED";
            case BillingClient.BillingResponseCode.DEVELOPER_ERROR:
                return "DEVELOPER_ERROR";
            case BillingClient.BillingResponseCode.NETWORK_ERROR:
                return "NETWORK_ERROR";
            default:
                return "STORE_ERROR";
        }
    }

`;

let next = original;
next = replaceOnce(
  next,
  '        String planIdentifier = call.getString("planIdentifier");\n        String productType = call.getString("productType", "inapp");',
  '        String planIdentifier = call.getString("planIdentifier");\n        final String requestedOfferId = call.getString("offerId");\n        String productType = call.getString("productType", "inapp");',
  'requestedOfferId',
);

next = replaceOnce(
  next,
  '    @PluginMethod\n    public void purchaseProduct(PluginCall call) {',
  helper + '    @PluginMethod\n    public void purchaseProduct(PluginCall call) {',
  'helper insert',
);

const offerStart = '                            if (productType.equals("subs")) {\n                                Log.d(TAG, "Processing subscription product");';
const offerEnd = '                            productDetailsParamsList.add(productDetailsParams.build());';
const offerStartAt = next.indexOf(offerStart);
const offerEndAt = offerStartAt === -1 ? -1 : next.indexOf(offerEnd, offerStartAt);
if (offerStartAt === -1 || offerEndAt === -1) {
  console.error('patch-native-purchases: could not find subscription offer selection');
  process.exit(1);
}
if (next.indexOf(offerStart, offerStartAt + offerStart.length) !== -1) {
  console.error('patch-native-purchases: subscription offer selection is not unique');
  process.exit(1);
}

const offerReplacement = `                            if (productType.equals("subs")) {
                                Log.d(TAG, "Processing subscription product");
                                // DIRECTION_OFFER_SELECTION
                                List<ProductDetails.SubscriptionOfferDetails> directionOffers = productDetailsItem.getSubscriptionOfferDetails();
                                Log.d(TAG, "Available offer details count: " + (directionOffers == null ? 0 : directionOffers.size()));
                                ProductDetails.SubscriptionOfferDetails selectedOfferDetails = selectSubscriptionOffer(
                                    directionOffers,
                                    planIdentifier,
                                    requestedOfferId
                                );
                                if (selectedOfferDetails == null) {
                                    Log.e(TAG, "No subscription offer for plan " + planIdentifier);
                                    closeBillingClient();
                                    call.reject("No subscription offer for plan " + planIdentifier, "ITEM_UNAVAILABLE");
                                    return;
                                }
                                Log.d(
                                    TAG,
                                    "Selected offer basePlan=" +
                                    selectedOfferDetails.getBasePlanId() +
                                    " offerId=" +
                                    selectedOfferDetails.getOfferId()
                                );
                                productDetailsParams.setOfferToken(selectedOfferDetails.getOfferToken());
                            }

`;

next = next.slice(0, offerStartAt) + offerReplacement + next.slice(offerEndAt);

next = replaceOnce(
  next,
  `                            if (purchaseCall != null) {
                                purchaseCall.reject("Purchase is not purchased");
                            }`,
  `                            if (purchaseCall != null) {
                                // DIRECTION_BILLING_ERROR
                                String directionCode = billingErrorCode(billingResult.getResponseCode());
                                String directionDebug = billingResult.getDebugMessage();
                                String directionMessage = (directionDebug == null || directionDebug.trim().isEmpty())
                                    ? directionCode
                                    : directionCode + ": " + directionDebug;
                                purchaseCall.reject(directionMessage, directionCode);
                            }`,
  'billing result reject',
);

next = replaceOnce(
  next,
  '                purchaseCall.reject("Purchase is pending");',
  '                purchaseCall.reject("Purchase is pending", "PENDING");',
  'pending reject',
);

next = replaceOnce(
  next,
  '                purchaseCall.reject("Purchase is not purchased");',
  '                purchaseCall.reject("Purchase is not purchased", "STORE_ERROR");',
  'other purchase state reject',
);

if (!next.includes('DIRECTION_OFFER_SELECTION') || !next.includes('DIRECTION_BILLING_ERROR')) {
  console.error('patch-native-purchases: markers missing after patch');
  process.exit(1);
}

fs.writeFileSync(target, next);
console.log('patch-native-purchases: patched NativePurchasesPlugin.java');
