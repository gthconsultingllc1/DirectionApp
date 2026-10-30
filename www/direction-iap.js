/**
 * Direction store subscription bridge.
 *
 * Injected into the Capacitor WebView (including the remote SPA at
 * https://app.mydirection.app) as window.DirectionIAP.
 *
 * Product IDs are the same in Google Play and the App Store.
 * Play base plan IDs and the free-trial offer ID are Android-only;
 * StoreKit applies the introductory offer automatically.
 */
(function (root) {
  'use strict';

  var PRODUCTS = {
    direction_premium_monthly: {
      productId: 'direction_premium_monthly',
      planId: 'monthly',
      offerId: 'trial-7-days',
      period: 'monthly',
    },
    direction_premium_yearly: {
      productId: 'direction_premium_yearly',
      planId: 'yearly',
      offerId: 'trial-7-days',
      period: 'yearly',
    },
  };

  var PRODUCT_ORDER = ['direction_premium_monthly', 'direction_premium_yearly'];

  function listProducts() {
    return PRODUCT_ORDER.map(function (id) {
      return PRODUCTS[id];
    });
  }

  function isKnownProduct(productId) {
    return Object.prototype.hasOwnProperty.call(PRODUCTS, productId);
  }

  function emptyCustomerInfo(extra) {
    return Object.assign(
      {
        premium: false,
        tier: 'free',
        activeProductIds: [],
        purchases: [],
      },
      extra || {},
    );
  }

  function errorText(error) {
    if (!error) return '';
    if (typeof error === 'string') return error;
    return String(error.message || error.errorMessage || error);
  }

  function errorCode(error) {
    if (!error || typeof error !== 'object' || !error.code) return '';
    return String(error.code);
  }

  function classifyError(error) {
    var code = errorCode(error).toUpperCase();
    var message = errorText(error);
    var blob = (code + ' ' + message).toLowerCase();

    if (
      code === 'USER_CANCELED' ||
      code === 'USER_CANCELLED' ||
      blob.indexOf('user cancel') !== -1
    ) {
      return {
        status: 'cancelled',
        code: 'USER_CANCELED',
        message: 'Purchase cancelled',
      };
    }

    if (
      code === 'ITEM_ALREADY_OWNED' ||
      blob.indexOf('already owned') !== -1 ||
      blob.indexOf('already purchased') !== -1
    ) {
      return {
        status: 'already_owned',
        code: 'ITEM_ALREADY_OWNED',
        message: 'Subscription already owned',
      };
    }

    if (code === 'PENDING' || blob.indexOf('pending') !== -1) {
      return {
        status: 'pending',
        code: 'PENDING',
        message: 'Purchase is pending',
      };
    }

    if (code === 'UNAVAILABLE' || code === 'BILLING_UNAVAILABLE') {
      return {
        status: 'unavailable',
        code: code,
        message: message || 'Billing is not available',
      };
    }

    return {
      status: 'error',
      code: code || 'STORE_ERROR',
      message: message || 'Store error',
    };
  }

  function isFlagTrue(value) {
    return value === true || value === 'true';
  }

  function isFlagFalse(value) {
    return value === false || value === 'false';
  }

  function isPremiumPurchase(purchase) {
    if (!purchase || !isKnownProduct(purchase.productIdentifier)) return false;
    if (purchase.revocationDate) return false;

    var state = purchase.subscriptionState;
    if (state === 'expired' || state === 'revoked') return false;
    // Grace and billing retry keep access even when expirationDate is already past.
    if (state === 'inGracePeriod' || state === 'inBillingRetryPeriod') return true;
    if (isFlagFalse(purchase.isActive)) return false;
    if (isFlagTrue(purchase.isActive)) return true;
    if (state === 'subscribed') return true;

    var purchaseState = purchase.purchaseState == null ? '' : String(purchase.purchaseState).toUpperCase();
    return purchaseState === '1' || purchaseState === 'PURCHASED';
  }

  function toCustomerInfo(purchases) {
    var list = Array.isArray(purchases) ? purchases : [];
    var activeProductIds = [];
    list.forEach(function (purchase) {
      if (!isPremiumPurchase(purchase)) return;
      if (activeProductIds.indexOf(purchase.productIdentifier) === -1) {
        activeProductIds.push(purchase.productIdentifier);
      }
    });
    var premium = activeProductIds.length > 0;
    return {
      premium: premium,
      tier: premium ? 'premium' : 'free',
      activeProductIds: activeProductIds,
      purchases: list,
    };
  }

  function withPremium(customerInfo, premium, productId) {
    var info = customerInfo || emptyCustomerInfo();
    var activeProductIds = info.activeProductIds ? info.activeProductIds.slice() : [];
    if (premium && productId && activeProductIds.indexOf(productId) === -1) {
      activeProductIds.push(productId);
    }
    info.activeProductIds = activeProductIds;
    info.premium = !!premium;
    info.tier = premium ? 'premium' : 'free';
    return info;
  }

  function baseResult(fields) {
    var premium = !!fields.premium;
    var customerInfo = withPremium(fields.customerInfo || emptyCustomerInfo(), premium, fields.productId);
    return {
      ok: !!fields.ok,
      status: fields.status,
      premium: premium,
      tier: premium ? 'premium' : 'free',
      productId: fields.productId || null,
      planId: fields.planId || null,
      transactionId: fields.transactionId || null,
      purchaseToken: fields.purchaseToken || null,
      receipt: fields.receipt || null,
      jwsRepresentation: fields.jwsRepresentation || null,
      code: fields.code || null,
      message: fields.message || null,
      customerInfo: customerInfo,
    };
  }

  var CATALOG_PRICE_LINE = {
    direction_premium_monthly: '$9.99/month',
    direction_premium_yearly: '$59.99/year',
  };
  var TRIAL_LABEL = '7-day trial';
  var WEB_PAYWALL_MESSAGE =
    'Direction Premium is $9.99/month or $59.99/year, each with a 7-day trial.';
  var AUTO_RENEW_LINE = 'The subscription renews automatically until you cancel.';
  var CANCEL_LINE =
    'Cancel in your App Store or Google Play subscription settings. Deleting your Direction account does not cancel the subscription.';

  function priceOf(offer) {
    var price = Number(offer && offer.price);
    return Number.isFinite(price) ? price : 0;
  }

  function textOf(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function periodUnitFor(plan, source) {
    var unit = source && source.subscriptionPeriodUnit;
    if (unit === 'year' || unit === 'month') return unit;
    var billing = source && source.billingPeriod;
    if (billing === 'P1Y') return 'year';
    if (billing === 'P1M') return 'month';
    if (plan && plan.period === 'yearly') return 'year';
    if (plan && plan.period === 'monthly') return 'month';
    return '';
  }

  function offerIndicatesFreeTrial(offer, plan) {
    if (!offer) return false;
    if (offer.freeTrialPhase === true || offer.hasFreeTrialPhase === true) return true;
    if (plan && offer.offerId === plan.offerId) return true;
    if (offer.offerId && priceOf(offer) === 0 && !textOf(offer.recurringPriceString)) return true;
    if (Number(offer.introductoryPriceMicros) === 0 && offer.introductoryBillingPeriod) return true;
    return false;
  }

  function recurringFromOffer(offer) {
    if (!offer) return null;
    var recurringString = textOf(offer.recurringPriceString);
    if (recurringString) {
      var recurringPrice = Number(offer.recurringPrice);
      return {
        price: Number.isFinite(recurringPrice) ? recurringPrice : priceOf(offer),
        priceString: recurringString,
        currencyCode: textOf(offer.recurringCurrencyCode) || textOf(offer.currencyCode),
        billingPeriod: textOf(offer.billingPeriod),
        source: offer,
      };
    }
    if (priceOf(offer) > 0 && textOf(offer.priceString)) {
      return {
        price: priceOf(offer),
        priceString: textOf(offer.priceString),
        currencyCode: textOf(offer.currencyCode),
        billingPeriod: textOf(offer.billingPeriod),
        source: offer,
      };
    }
    return null;
  }

  function trialLengthPhrase(source) {
    if (!source) return 'free trial';
    var billing = textOf(source.introductoryBillingPeriod);
    if (billing === 'P7D' || billing === 'P1W') return TRIAL_LABEL;
    var intro = source.introductoryPrice;
    if (intro && typeof intro === 'object') {
      var count = Number(intro.periodCount || 1) * Number(intro.periodValue || 1);
      if (intro.periodUnit === 'day' && count === 7) return TRIAL_LABEL;
      if (intro.periodUnit === 'week' && count === 1) return TRIAL_LABEL;
      if (intro.periodUnit === 'day' && count > 0) return count + '-day trial';
      if (intro.periodUnit === 'week' && count > 0) return count + '-week trial';
    }
    return TRIAL_LABEL;
  }

  function normalizeAndroidProducts(rawProducts) {
    var grouped = {};
    rawProducts.forEach(function (offer) {
      if (!offer || !isKnownProduct(offer.planIdentifier)) return;
      var productId = offer.planIdentifier;
      if (!grouped[productId]) grouped[productId] = [];
      grouped[productId].push(offer);
    });

    return PRODUCT_ORDER.filter(function (productId) {
      return grouped[productId] && grouped[productId].length;
    }).map(function (productId) {
      var offers = grouped[productId];
      var plan = PRODUCTS[productId];
      var trial = null;
      var base = null;
      offers.forEach(function (offer) {
        if (offerIndicatesFreeTrial(offer, plan)) trial = trial || offer;
        if (!offer.offerId && !base) base = offer;
      });
      var priced = recurringFromOffer(base);
      if (!priced) priced = recurringFromOffer(trial);
      if (!priced) {
        offers.some(function (offer) {
          priced = recurringFromOffer(offer);
          return !!priced;
        });
      }
      var hasFreeTrial = !!trial;
      var titleSource = (priced && priced.source) || trial || offers[0] || {};
      return {
        productId: productId,
        planId: plan.planId,
        period: plan.period,
        periodUnit: periodUnitFor(plan, priced),
        billingPeriod: (priced && priced.billingPeriod) || '',
        title: titleSource.title || '',
        description: titleSource.description || '',
        price: priced ? priced.price : 0,
        priceString: priced ? priced.priceString : '',
        currencyCode: priced ? priced.currencyCode : '',
        hasFreeTrial: hasFreeTrial,
        trialPhrase: hasFreeTrial ? trialLengthPhrase(trial) : null,
        trialOfferId: hasFreeTrial ? plan.offerId : null,
        platform: 'android',
      };
    });
  }

  function iosIntroIsFreeTrial(intro) {
    if (!intro || typeof intro !== 'object') return false;
    if (intro.paymentMode === 'freeTrial') return true;
    return Number(intro.price) === 0;
  }

  function normalizeIosProducts(rawProducts) {
    var byId = {};
    rawProducts.forEach(function (product) {
      if (!product || !isKnownProduct(product.identifier)) return;
      byId[product.identifier] = product;
    });

    return PRODUCT_ORDER.filter(function (productId) {
      return !!byId[productId];
    }).map(function (productId) {
      var product = byId[productId];
      var plan = PRODUCTS[productId];
      var intro = product.introductoryPrice;
      var introFree = iosIntroIsFreeTrial(intro);
      var hasFreeTrial = introFree && product.eligibleForIntroOffer === true;
      var recurring = priceOf(product) > 0 ? textOf(product.priceString) : '';
      return {
        productId: productId,
        planId: plan.planId,
        period: plan.period,
        periodUnit: periodUnitFor(plan, product),
        billingPeriod: '',
        title: product.title || '',
        description: product.description || '',
        price: recurring ? priceOf(product) : 0,
        priceString: recurring,
        currencyCode: textOf(product.currencyCode),
        hasFreeTrial: hasFreeTrial,
        trialPhrase: hasFreeTrial ? trialLengthPhrase(product) : null,
        trialOfferId: null,
        platform: 'ios',
      };
    });
  }

  function pricePeriodLine(product) {
    var fromStore = product && textOf(product.priceString);
    var unit = product && (product.periodUnit === 'month' || product.periodUnit === 'year')
      ? product.periodUnit
      : '';
    if (fromStore && unit) {
      var suffix = '/' + unit;
      return fromStore.slice(-suffix.length) === suffix ? fromStore : fromStore + suffix;
    }
    if (fromStore) return fromStore;
    var catalog = product && CATALOG_PRICE_LINE[product.productId];
    return catalog || '';
  }

  function describeProduct(product) {
    var priceLine = pricePeriodLine(product);
    var showTrial = !!(product && product.hasFreeTrial);
    var trialLabel = showTrial ? (product.trialPhrase || TRIAL_LABEL) : null;
    var lead = showTrial ? trialLabel + ', then ' + priceLine : priceLine;
    var disclosure = [lead, AUTO_RENEW_LINE, CANCEL_LINE].join(' ');
    return {
      priceLine: priceLine,
      trialLine: showTrial ? lead : null,
      disclosure: disclosure,
      missingPrice: !priceLine,
    };
  }

  function savingsLine(monthly, yearly) {
    if (!monthly || !yearly) return null;
    if (!monthly.currencyCode || monthly.currencyCode !== yearly.currencyCode) return null;
    if (!(monthly.price > 0) || !(yearly.price > 0)) return null;
    if (monthly.price * 12 <= yearly.price) return null;
    var monthlyLine = pricePeriodLine(monthly);
    var yearlyLine = pricePeriodLine(yearly);
    if (!monthlyLine || !yearlyLine) return null;
    return 'Yearly is ' + yearlyLine + ', compared with 12 × ' + monthlyLine + '.';
  }

  function catalogFallback(productId) {
    var plan = PRODUCTS[productId];
    return {
      productId: productId,
      period: plan.period,
      periodUnit: plan.period === 'yearly' ? 'year' : 'month',
      priceString: '',
      price: 0,
      currencyCode: '',
      hasFreeTrial: true,
      trialPhrase: TRIAL_LABEL,
    };
  }

  function formatPaywall(products) {
    var list = Array.isArray(products) ? products : [];
    var monthly = null;
    var yearly = null;
    list.forEach(function (product) {
      if (!product) return;
      if (product.productId === PRODUCTS.direction_premium_monthly.productId) monthly = product;
      if (product.productId === PRODUCTS.direction_premium_yearly.productId) yearly = product;
    });
    var monthlyShown = monthly || catalogFallback(PRODUCTS.direction_premium_monthly.productId);
    var yearlyShown = yearly || catalogFallback(PRODUCTS.direction_premium_yearly.productId);
    return {
      monthly: describeProduct(monthlyShown),
      yearly: describeProduct(yearlyShown),
      savingsLine: monthly && yearly ? savingsLine(monthly, yearly) : null,
      autoRenewLine: AUTO_RENEW_LINE,
      cancelLine: CANCEL_LINE,
      webMessage: WEB_PAYWALL_MESSAGE,
    };
  }

  function applyConfirmedTier(raw, info) {
    if (!info || info.confirmed !== true) return { raw: raw, changed: false };
    if (info.billingSupported === false || info.unavailable) return { raw: raw, changed: false };
    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return { raw: raw, changed: false };
    }
    if (!parsed || !parsed.state || typeof parsed.state !== 'object') {
      return { raw: raw, changed: false };
    }
    var current = parsed.state.tier;
    if (current !== 'premium' && current !== 'free') return { raw: raw, changed: false };
    var nextTier = info.premium ? 'premium' : 'free';
    if (current === nextTier) return { raw: raw, changed: false };
    parsed.state.tier = nextTier;
    if (nextTier === 'free') {
      parsed.state.binaural = false;
      if (parsed.state.voiceSlot && parsed.state.voiceSlot !== 'calm') {
        parsed.state.voiceSlot = 'calm';
      }
    }
    return { raw: JSON.stringify(parsed), changed: true, tier: nextTier };
  }

  function normalizeStoreProducts(rawProducts) {
    var list = Array.isArray(rawProducts) ? rawProducts : [];
    var android = list.some(function (item) {
      return item && isKnownProduct(item.planIdentifier);
    });
    return android ? normalizeAndroidProducts(list) : normalizeIosProducts(list);
  }

  function transactionFields(transaction) {
    transaction = transaction || {};
    return {
      transactionId: transaction.transactionId || null,
      purchaseToken: transaction.purchaseToken || null,
      receipt: transaction.receipt || null,
      jwsRepresentation: transaction.jwsRepresentation || null,
    };
  }

  function purchaseGrantsPremium(transaction, customerInfo, productId) {
    if (transaction && transaction.revocationDate) return false;
    var state = transaction && transaction.subscriptionState;
    if (state === 'expired' || state === 'revoked') return false;
    if (customerInfo && customerInfo.premium) return true;
    if (transaction && isPremiumPurchase(transaction)) return true;
    // A known product id is not an entitlement. Expired and empty
    // purchase results stay free until the store reports an active sub.
    return false;
  }

  function createDirectionIAP(deps) {
    if (!deps || typeof deps.getPlugin !== 'function') {
      throw new Error('createDirectionIAP requires getPlugin');
    }

    function plugin() {
      return deps.getPlugin();
    }

    async function safeCustomerInfo(nativePlugin) {
      try {
        var result = await nativePlugin.getPurchases({ productType: 'subs' });
        var info = toCustomerInfo(result && result.purchases);
        info.confirmed = true;
        return info;
      } catch (error) {
        return emptyCustomerInfo({ confirmed: false });
      }
    }

    async function requireBilling(nativePlugin) {
      if (typeof nativePlugin.isBillingSupported !== 'function') return;
      var support = await nativePlugin.isBillingSupported();
      if (support && support.isBillingSupported === false) {
        var error = new Error('Billing is not supported on this device');
        error.code = 'BILLING_UNAVAILABLE';
        throw error;
      }
    }

    function unavailable(productId, planId) {
      return baseResult({
        ok: false,
        status: 'unavailable',
        premium: false,
        productId: productId,
        planId: planId,
        code: 'UNAVAILABLE',
        message: 'DirectionIAP is only available inside the Direction app',
        customerInfo: emptyCustomerInfo({ unavailable: true }),
      });
    }

    async function getProducts() {
      var nativePlugin;
      try {
        nativePlugin = plugin();
      } catch (error) {
        return {
          ok: false,
          status: 'unavailable',
          products: [],
          code: 'UNAVAILABLE',
          message: errorText(error) || 'DirectionIAP is only available inside the Direction app',
        };
      }

      try {
        await requireBilling(nativePlugin);
        var result = await nativePlugin.getProducts({
          productIdentifiers: PRODUCT_ORDER.slice(),
          productType: 'subs',
        });
        return {
          ok: true,
          status: 'ok',
          products: normalizeStoreProducts(result && result.products),
        };
      } catch (error) {
        var classified = classifyError(error);
        return {
          ok: false,
          status: classified.status,
          products: [],
          code: classified.code,
          message: classified.message,
        };
      }
    }

    async function purchase(productId, options) {
      var plan = PRODUCTS[productId];
      if (!plan) {
        return baseResult({
          ok: false,
          status: 'error',
          premium: false,
          productId: productId || null,
          code: 'UNKNOWN_PRODUCT',
          message: 'Unknown subscription product',
        });
      }

      var nativePlugin;
      try {
        nativePlugin = plugin();
      } catch (error) {
        return unavailable(plan.productId, plan.planId);
      }

      var purchaseOptions = {
        productIdentifier: plan.productId,
        planIdentifier: plan.planId,
        productType: 'subs',
        offerId: plan.offerId,
        quantity: 1,
      };
      if (options && options.appAccountToken) {
        purchaseOptions.appAccountToken = String(options.appAccountToken);
      }

      try {
        await requireBilling(nativePlugin);
        var transaction = await nativePlugin.purchaseProduct(purchaseOptions);
        var customerInfo = await safeCustomerInfo(nativePlugin);
        var premium = purchaseGrantsPremium(transaction, customerInfo, plan.productId);
        return baseResult(
          Object.assign(
            {
              ok: premium,
              status: 'purchased',
              premium: premium,
              productId: plan.productId,
              planId: plan.planId,
              customerInfo: customerInfo,
            },
            transactionFields(transaction),
          ),
        );
      } catch (error) {
        var classified = classifyError(error);
        if (classified.status === 'already_owned') {
          try {
            await nativePlugin.restorePurchases();
          } catch (restoreError) {
            // Entitlement is checked below. Restore is best-effort.
          }
        }

        var customerInfo = emptyCustomerInfo();
        if (classified.status !== 'unavailable') {
          customerInfo = await safeCustomerInfo(nativePlugin);
        }

        var premium = !!customerInfo.premium;
        var ok = classified.status === 'already_owned' && premium;

        return baseResult(
          Object.assign(
            {
              ok: ok,
              status: classified.status,
              premium: premium,
              productId: plan.productId,
              planId: plan.planId,
              code: classified.code,
              message: classified.message,
              customerInfo: customerInfo,
            },
            {},
          ),
        );
      }
    }

    async function restorePurchases() {
      var nativePlugin;
      try {
        nativePlugin = plugin();
      } catch (error) {
        return unavailable(null, null);
      }

      try {
        await requireBilling(nativePlugin);
        await nativePlugin.restorePurchases();
        var customerInfo = await safeCustomerInfo(nativePlugin);
        return baseResult({
          ok: true,
          status: 'restored',
          premium: customerInfo.premium,
          productId: customerInfo.activeProductIds[0] || null,
          planId: customerInfo.activeProductIds[0]
            ? PRODUCTS[customerInfo.activeProductIds[0]].planId
            : null,
          customerInfo: customerInfo,
        });
      } catch (error) {
        var classified = classifyError(error);
        var customerInfo = emptyCustomerInfo();
        if (classified.status !== 'unavailable') {
          customerInfo = await safeCustomerInfo(nativePlugin);
        }
        return baseResult({
          ok: false,
          status: classified.status,
          premium: customerInfo.premium,
          code: classified.code,
          message: classified.message,
          customerInfo: customerInfo,
        });
      }
    }

    async function getCustomerInfo() {
      var nativePlugin;
      try {
        nativePlugin = plugin();
      } catch (error) {
        return emptyCustomerInfo({ unavailable: true, billingSupported: false });
      }

      try {
        var billingSupported = true;
        if (typeof nativePlugin.isBillingSupported === 'function') {
          var support = await nativePlugin.isBillingSupported();
          billingSupported = !support || support.isBillingSupported !== false;
        }
        if (!billingSupported) {
          return emptyCustomerInfo({ billingSupported: false, confirmed: false });
        }
        var info = await safeCustomerInfo(nativePlugin);
        info.billingSupported = true;
        return info;
      } catch (error) {
        return emptyCustomerInfo({
          billingSupported: true,
          confirmed: false,
          message: errorText(error) || 'Store error',
        });
      }
    }

    async function manageSubscriptions() {
      var nativePlugin;
      try {
        nativePlugin = plugin();
        await nativePlugin.manageSubscriptions();
        return { ok: true, status: 'ok' };
      } catch (error) {
        var classified = classifyError(error);
        return {
          ok: false,
          status: classified.status,
          code: classified.code,
          message: classified.message,
        };
      }
    }

    return {
      products: listProducts(),
      productIds: {
        monthly: PRODUCTS.direction_premium_monthly.productId,
        yearly: PRODUCTS.direction_premium_yearly.productId,
      },
      basePlans: {
        monthly: PRODUCTS.direction_premium_monthly.planId,
        yearly: PRODUCTS.direction_premium_yearly.planId,
      },
      trialOfferId: PRODUCTS.direction_premium_monthly.offerId,
      getProducts: getProducts,
      getOfferings: getProducts,
      purchase: purchase,
      purchaseMonthly: function (options) {
        return purchase(PRODUCTS.direction_premium_monthly.productId, options);
      },
      purchaseYearly: function (options) {
        return purchase(PRODUCTS.direction_premium_yearly.productId, options);
      },
      restorePurchases: restorePurchases,
      getCustomerInfo: getCustomerInfo,
      manageSubscriptions: manageSubscriptions,
      formatPaywall: formatPaywall,
      webPaywallMessage: WEB_PAYWALL_MESSAGE,
      autoRenewLine: AUTO_RENEW_LINE,
      cancelLine: CANCEL_LINE,
      isAvailable: function () {
        try {
          plugin();
          return true;
        } catch (error) {
          return false;
        }
      },
    };
  }

  function scheduleEntitlementSync(api, host) {
    if (!api || !host || api.__syncScheduled) return;
    api.__syncScheduled = true;

    async function tick() {
      try {
        if (typeof api.isAvailable === 'function' && !api.isAvailable()) return;
        var storage = host.localStorage;
        if (!storage || typeof storage.getItem !== 'function') return;
        var current = storage.getItem('direction.v1');
        if (current == null) return;
        var info = await api.getCustomerInfo();
        var applied = applyConfirmedTier(current, info);
        if (!applied.changed || typeof storage.setItem !== 'function') return;
        storage.setItem('direction.v1', applied.raw);
        try {
          if (typeof host.dispatchEvent === 'function' && typeof host.CustomEvent === 'function') {
            host.dispatchEvent(new host.CustomEvent('direction-entitlement', { detail: { tier: applied.tier } }));
          }
        } catch (error) {
          // The stored tier is still updated when the event cannot be dispatched.
        }
        var session = host.sessionStorage;
        if (session && session.getItem('direction.tier-reload') === applied.tier) return;
        if (session && typeof session.setItem === 'function') {
          session.setItem('direction.tier-reload', applied.tier);
        }
        if (
          host.document &&
          host.document.readyState === 'complete' &&
          host.location &&
          typeof host.location.reload === 'function'
        ) {
          host.location.reload();
        }
      } catch (error) {
        // A store failure must not clear Premium.
      }
    }

    tick();
    if (host.document && typeof host.document.addEventListener === 'function') {
      host.document.addEventListener('visibilitychange', function () {
        if (host.document.visibilityState === 'visible') tick();
      });
    }
  }

  function install(target) {
    var host = target || root;
    if (!host) return null;
    if (host.DirectionIAP && host.DirectionIAP.__installed) {
      scheduleEntitlementSync(host.DirectionIAP, host);
      return host.DirectionIAP;
    }

    var api = createDirectionIAP({
      getPlugin: function () {
        var capacitor = host.Capacitor;
        var nativePlugin = capacitor && capacitor.Plugins && capacitor.Plugins.NativePurchases;
        if (!nativePlugin || typeof nativePlugin.purchaseProduct !== 'function') {
          var error = new Error('DirectionIAP is only available inside the Direction app');
          error.code = 'UNAVAILABLE';
          throw error;
        }
        return nativePlugin;
      },
    });
    api.__installed = true;
    host.DirectionIAP = api;
    scheduleEntitlementSync(api, host);

    try {
      if (typeof host.dispatchEvent === 'function' && typeof host.CustomEvent === 'function') {
        host.dispatchEvent(new host.CustomEvent('direction-iap-ready'));
      }
    } catch (error) {
      // The object is still on window if the event cannot be dispatched.
    }

    return api;
  }

  var exported = {
    PRODUCTS: PRODUCTS,
    createDirectionIAP: createDirectionIAP,
    install: install,
    isPremiumPurchase: isPremiumPurchase,
    normalizeStoreProducts: normalizeStoreProducts,
    formatPaywall: formatPaywall,
    describeProduct: describeProduct,
    applyConfirmedTier: applyConfirmedTier,
    classifyError: classifyError,
    WEB_PAYWALL_MESSAGE: WEB_PAYWALL_MESSAGE,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }

  if (root && root.document) {
    install(root);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
