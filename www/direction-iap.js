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
    if (isFlagFalse(purchase.isActive)) return false;
    if (isFlagTrue(purchase.isActive)) return true;
    if (state === 'subscribed' || state === 'inGracePeriod' || state === 'inBillingRetryPeriod') {
      return true;
    }

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

  function priceOf(offer) {
    var price = Number(offer && offer.price);
    return Number.isFinite(price) ? price : 0;
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
        if (offer.offerId === plan.offerId) trial = offer;
        if (!offer.offerId && !base) base = offer;
      });
      var paid = offers.filter(function (offer) {
        return priceOf(offer) > 0;
      });
      var priced = base || paid[0] || offers[0];
      var hasFreeTrial = !!trial || offers.some(function (offer) {
        return !!offer.offerId && priceOf(offer) === 0;
      });
      return {
        productId: productId,
        planId: plan.planId,
        period: plan.period,
        title: priced.title || '',
        description: priced.description || '',
        price: priceOf(priced),
        priceString: priced.priceString || '',
        currencyCode: priced.currencyCode || '',
        hasFreeTrial: hasFreeTrial,
        trialOfferId: hasFreeTrial ? plan.offerId : null,
        platform: 'android',
      };
    });
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
      var introPrice = intro ? Number(intro.price) : NaN;
      var hasFreeTrial = !!intro && introPrice === 0;
      return {
        productId: productId,
        planId: plan.planId,
        period: plan.period,
        title: product.title || '',
        description: product.description || '',
        price: priceOf(product),
        priceString: product.priceString || '',
        currencyCode: product.currencyCode || '',
        hasFreeTrial: hasFreeTrial,
        trialOfferId: null,
        platform: 'ios',
      };
    });
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
    if (transaction && isFlagFalse(transaction.isActive)) {
      return !!(customerInfo && customerInfo.premium);
    }
    if (customerInfo && customerInfo.premium) return true;
    if (transaction && isPremiumPurchase(transaction)) return true;
    var id = (transaction && transaction.productIdentifier) || productId;
    return isKnownProduct(id);
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
        return toCustomerInfo(result && result.purchases);
      } catch (error) {
        return emptyCustomerInfo();
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
        if (classified.status === 'already_owned') premium = true;
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
          return emptyCustomerInfo({ billingSupported: false });
        }
        var info = await safeCustomerInfo(nativePlugin);
        info.billingSupported = true;
        return info;
      } catch (error) {
        return emptyCustomerInfo({
          billingSupported: true,
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

  function install(target) {
    var host = target || root;
    if (!host) return null;
    if (host.DirectionIAP && host.DirectionIAP.__installed) return host.DirectionIAP;

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
    classifyError: classifyError,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }

  if (root && root.document) {
    install(root);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
