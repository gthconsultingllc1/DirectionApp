const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createDirectionIAP,
  install,
  isPremiumPurchase,
  normalizeStoreProducts,
  classifyError,
  PRODUCTS,
} = require('../www/direction-iap.js');

const MONTHLY = 'direction_premium_monthly';
const YEARLY = 'direction_premium_yearly';

function pluginError(message, code) {
  const error = new Error(message);
  if (code) error.code = code;
  return error;
}

function fakePlugin(overrides) {
  const calls = [];
  const plugin = {
    calls,
    isBillingSupported: async () => ({ isBillingSupported: true }),
    getProducts: async () => ({ products: [] }),
    purchaseProduct: async () => {
      throw new Error('purchaseProduct was not stubbed');
    },
    restorePurchases: async () => {},
    getPurchases: async () => ({ purchases: [] }),
    manageSubscriptions: async () => {},
  };
  Object.keys(overrides || {}).forEach((key) => {
    const value = overrides[key];
    if (typeof value === 'function') {
      plugin[key] = async (...args) => {
        calls.push({ method: key, args });
        return value(...args);
      };
    }
  });
  return plugin;
}

function client(overrides) {
  const plugin = fakePlugin(overrides);
  return {
    plugin,
    iap: createDirectionIAP({
      getPlugin() {
        return plugin;
      },
    }),
  };
}

test('product ids and Play base plans are the store ids', () => {
  assert.equal(PRODUCTS[MONTHLY].productId, MONTHLY);
  assert.equal(PRODUCTS[MONTHLY].planId, 'monthly');
  assert.equal(PRODUCTS[MONTHLY].offerId, 'trial-7-days');
  assert.equal(PRODUCTS[YEARLY].productId, YEARLY);
  assert.equal(PRODUCTS[YEARLY].planId, 'yearly');
  assert.equal(PRODUCTS[YEARLY].offerId, 'trial-7-days');
});

test('getProducts keeps the recurring Play price and marks an eligible trial', async () => {
  const { iap, plugin } = client({
    getProducts: async () => ({
      products: [
        {
          identifier: 'yearly',
          planIdentifier: YEARLY,
          offerId: null,
          title: 'Direction Premium',
          description: 'Yearly',
          price: 59.99,
          priceString: '$59.99',
          currencyCode: 'USD',
        },
        {
          identifier: 'monthly',
          planIdentifier: MONTHLY,
          offerId: 'trial-7-days',
          title: 'Direction Premium',
          description: 'Monthly',
          price: 0,
          priceString: '$0.00',
          currencyCode: 'USD',
        },
        {
          identifier: 'monthly',
          planIdentifier: MONTHLY,
          offerId: null,
          title: 'Direction Premium',
          description: 'Monthly',
          price: 9.99,
          priceString: '$9.99',
          currencyCode: 'USD',
        },
      ],
    }),
  });

  const offerings = await iap.getOfferings();
  assert.equal(offerings.ok, true);
  assert.deepEqual(
    offerings.products.map((product) => product.productId),
    [MONTHLY, YEARLY],
  );
  assert.equal(offerings.products[0].planId, 'monthly');
  assert.equal(offerings.products[0].priceString, '$9.99');
  assert.equal(offerings.products[0].hasFreeTrial, true);
  assert.equal(offerings.products[0].trialOfferId, 'trial-7-days');
  assert.equal(offerings.products[1].priceString, '$59.99');
  assert.equal(offerings.products[1].hasFreeTrial, false);
  assert.deepEqual(plugin.calls[0].args[0].productIdentifiers, [MONTHLY, YEARLY]);
  assert.equal(plugin.calls[0].args[0].productType, 'subs');
});

test('getProducts reads StoreKit product ids and a free introductory price', () => {
  const products = normalizeStoreProducts([
    {
      identifier: YEARLY,
      title: 'Yearly',
      description: 'Yearly plan',
      price: 59.99,
      priceString: '$59.99',
      currencyCode: 'USD',
      introductoryPrice: { price: 0, priceString: '$0.00' },
    },
    {
      identifier: MONTHLY,
      title: 'Monthly',
      description: 'Monthly plan',
      price: 9.99,
      priceString: '$9.99',
      currencyCode: 'USD',
      introductoryPrice: null,
    },
  ]);
  assert.equal(products[0].platform, 'ios');
  assert.equal(products[0].productId, MONTHLY);
  assert.equal(products[0].hasFreeTrial, false);
  assert.equal(products[1].productId, YEARLY);
  assert.equal(products[1].hasFreeTrial, true);
  assert.equal(products[1].priceString, '$59.99');
});

test('purchaseMonthly asks Play for the monthly base plan and trial offer', async () => {
  const { iap, plugin } = client({
    purchaseProduct: async () => ({
      transactionId: 'GPA.1',
      purchaseToken: 'token-monthly',
      productIdentifier: MONTHLY,
      purchaseState: '1',
    }),
    getPurchases: async () => ({
      purchases: [{ productIdentifier: MONTHLY, purchaseState: '1' }],
    }),
  });

  const result = await iap.purchaseMonthly({ appAccountToken: 'user-uuid' });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'purchased');
  assert.equal(result.premium, true);
  assert.equal(result.tier, 'premium');
  assert.equal(result.productId, MONTHLY);
  assert.equal(result.planId, 'monthly');
  assert.equal(result.purchaseToken, 'token-monthly');
  assert.equal(result.customerInfo.tier, 'premium');
  assert.deepEqual(result.customerInfo.activeProductIds, [MONTHLY]);
  assert.deepEqual(plugin.calls.find((call) => call.method === 'purchaseProduct').args[0], {
    productIdentifier: MONTHLY,
    planIdentifier: 'monthly',
    productType: 'subs',
    offerId: 'trial-7-days',
    quantity: 1,
    appAccountToken: 'user-uuid',
  });
});

test('purchaseYearly grants premium from a StoreKit transaction', async () => {
  const { iap } = client({
    purchaseProduct: async () => ({
      transactionId: '2000001',
      receipt: 'base64-receipt',
      jwsRepresentation: 'header.payload.sig',
      productIdentifier: YEARLY,
      isActive: true,
      subscriptionState: 'subscribed',
    }),
    getPurchases: async () => ({ purchases: [] }),
  });

  const result = await iap.purchaseYearly();
  assert.equal(result.status, 'purchased');
  assert.equal(result.premium, true);
  assert.equal(result.tier, 'premium');
  assert.equal(result.productId, YEARLY);
  assert.equal(result.planId, 'yearly');
  assert.equal(result.receipt, 'base64-receipt');
  assert.deepEqual(result.customerInfo.activeProductIds, [YEARLY]);
});

test('user cancel resolves with cancelled and does not grant premium', async () => {
  const { iap } = client({
    purchaseProduct: async () => {
      throw pluginError('User cancelled');
    },
    getPurchases: async () => ({ purchases: [] }),
  });

  const result = await iap.purchaseMonthly();
  assert.equal(result.ok, false);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.premium, false);
  assert.equal(result.tier, 'free');
  assert.equal(result.code, 'USER_CANCELED');
});

test('cancel keeps an already active subscription', async () => {
  const { iap } = client({
    purchaseProduct: async () => {
      throw pluginError('USER_CANCELED: User canceled the purchase', 'USER_CANCELED');
    },
    getPurchases: async () => ({
      purchases: [{ productIdentifier: YEARLY, purchaseState: '1' }],
    }),
  });

  const result = await iap.purchaseMonthly();
  assert.equal(result.status, 'cancelled');
  assert.equal(result.ok, false);
  assert.equal(result.premium, true);
  assert.equal(result.tier, 'premium');
});

test('already owned restores and reports premium', async () => {
  const { iap, plugin } = client({
    purchaseProduct: async () => {
      throw pluginError('ITEM_ALREADY_OWNED: already owned', 'ITEM_ALREADY_OWNED');
    },
    restorePurchases: async () => {},
    getPurchases: async () => ({
      purchases: [{ productIdentifier: MONTHLY, purchaseState: 'PURCHASED' }],
    }),
  });

  const result = await iap.purchase(MONTHLY);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'already_owned');
  assert.equal(result.premium, true);
  assert.equal(result.tier, 'premium');
  assert.equal(plugin.calls.some((call) => call.method === 'restorePurchases'), true);
});

test('store errors and pending purchases resolve without throwing', async () => {
  const network = client({
    purchaseProduct: async () => {
      throw pluginError('NETWORK_ERROR: timeout', 'NETWORK_ERROR');
    },
  });
  const networkResult = await network.iap.purchaseYearly();
  assert.equal(networkResult.ok, false);
  assert.equal(networkResult.status, 'error');
  assert.equal(networkResult.premium, false);
  assert.equal(networkResult.code, 'NETWORK_ERROR');

  const pending = client({
    purchaseProduct: async () => {
      throw pluginError('Purchase is pending', 'PENDING');
    },
  });
  const pendingResult = await pending.iap.purchaseMonthly();
  assert.equal(pendingResult.status, 'pending');
  assert.equal(pendingResult.premium, false);
});

test('unknown product ids do not call the store', async () => {
  const { iap, plugin } = client({});
  const result = await iap.purchase('premium_plus');
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'UNKNOWN_PRODUCT');
  assert.equal(plugin.calls.length, 0);
});

test('restore reports premium only when an entitlement is active', async () => {
  const active = client({
    restorePurchases: async () => {},
    getPurchases: async () => ({
      purchases: [
        { productIdentifier: YEARLY, isActive: true, subscriptionState: 'subscribed' },
        { productIdentifier: 'some_other_sku', isActive: true },
      ],
    }),
  });
  const restored = await active.iap.restorePurchases();
  assert.equal(restored.ok, true);
  assert.equal(restored.status, 'restored');
  assert.equal(restored.premium, true);
  assert.equal(restored.tier, 'premium');
  assert.deepEqual(restored.customerInfo.activeProductIds, [YEARLY]);

  const empty = client({
    restorePurchases: async () => {},
    getPurchases: async () => ({ purchases: [] }),
  });
  const nothing = await empty.iap.restorePurchases();
  assert.equal(nothing.ok, true);
  assert.equal(nothing.status, 'restored');
  assert.equal(nothing.premium, false);
  assert.equal(nothing.tier, 'free');
});

test('getCustomerInfo ignores expired, revoked, and pending purchases', async () => {
  const { iap } = client({
    getPurchases: async () => ({
      purchases: [
        { productIdentifier: MONTHLY, isActive: false, subscriptionState: 'expired' },
        { productIdentifier: YEARLY, isActive: true, revocationDate: '2026-01-01T00:00:00Z' },
        { productIdentifier: MONTHLY, purchaseState: '2' },
        { productIdentifier: YEARLY, subscriptionState: 'revoked', isActive: true },
      ],
    }),
  });
  const info = await iap.getCustomerInfo();
  assert.equal(info.premium, false);
  assert.equal(info.tier, 'free');
  assert.deepEqual(info.activeProductIds, []);
});

test('a cancelled subscription that is still active stays premium', () => {
  assert.equal(
    isPremiumPurchase({
      productIdentifier: MONTHLY,
      isActive: true,
      willCancel: true,
      subscriptionState: 'subscribed',
    }),
    true,
  );
  assert.equal(
    classifyError(pluginError('User cancelled')).status,
    'cancelled',
  );
});

test('outside the app the bridge resolves unavailable instead of throwing', async () => {
  const iap = createDirectionIAP({
    getPlugin() {
      const error = new Error('missing');
      error.code = 'UNAVAILABLE';
      throw error;
    },
  });
  assert.equal(iap.isAvailable(), false);
  const products = await iap.getProducts();
  assert.equal(products.ok, false);
  assert.equal(products.status, 'unavailable');
  const purchase = await iap.purchaseMonthly();
  assert.equal(purchase.status, 'unavailable');
  assert.equal(purchase.premium, false);
  const info = await iap.getCustomerInfo();
  assert.equal(info.premium, false);
  assert.equal(info.unavailable, true);
  const restored = await iap.restorePurchases();
  assert.equal(restored.status, 'unavailable');
});

test('install exposes DirectionIAP once and emits direction-iap-ready', () => {
  const events = [];
  const host = {
    document: { nodeType: 9 },
    Capacitor: {
      Plugins: {
        NativePurchases: {
          purchaseProduct: async () => ({}),
        },
      },
    },
    CustomEvent: function CustomEvent(type) {
      this.type = type;
    },
    dispatchEvent(event) {
      events.push(event.type);
    },
  };
  const first = install(host);
  const second = install(host);
  assert.equal(first, second);
  assert.equal(host.DirectionIAP, first);
  assert.equal(first.__installed, true);
  assert.deepEqual(events, ['direction-iap-ready']);
  assert.equal(first.productIds.monthly, MONTHLY);
  assert.equal(first.basePlans.yearly, 'yearly');
  assert.equal(first.trialOfferId, 'trial-7-days');
});
