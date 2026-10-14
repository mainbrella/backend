import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('Apple verification initializes inside a Worker request and keeps Xcode receipts local', async t => {
  // Node permits randomness at import time; workerd must exercise both startup
  // and the first verification request to catch this regression.
  const bundle = await build({ stdin: { contents: `
    import { handleAppleIAPRequest } from './worker/app/apple-iap';
    import { localAppleTesting, verifyAppleTransaction } from './worker/lib/apple-iap';
    export default { async fetch(request, env) {
      if (new URL(request.url).pathname === '/health') return new Response('ready');
      if (new URL(request.url).pathname.endsWith('/notifications')) return handleAppleIAPRequest(request, env);
      try {
        const transaction = await verifyAppleTransaction(env, await request.text(), localAppleTesting(env, request));
        return Response.json({ transactionId: transaction.transactionId });
      } catch (error) {
        return Response.json({ error: error.message }, { status: 400 });
      }
    }};
  `, resolveDir: process.cwd(), sourcefile: 'apple-iap-regression.ts', loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node', external: ['cloudflare:*', 'node:*'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire('/');" } });
  const mf = new Miniflare(convertV4MiniflareOptions({ cf: false, workers: [{ name: 'apple-iap-regression', modules: true,
    script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-18', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
    bindings: { LOCAL_DEV: 'true', APPLE_IAP_ALLOW_XCODE: 'true', APPLE_IAP_APP_ID: '123456789',
      APPLE_IAP_PRIVATE_KEY: 'unused', APPLE_IAP_KEY_ID: 'unused', APPLE_IAP_ISSUER_ID: 'unused', APPLE_IAP_PROCEEDS_JSON: '[]' },
  }] }));
  t.after(() => mf.dispose());
  await mf.ready;
  assert.equal(await (await mf.dispatchFetch('http://localhost/health')).text(), 'ready');

  const transaction = { environment: 'Xcode', bundleId: 'com.mainbrella.ios', productId: 'MAINBRELLA_FIVE',
    type: 'Consumable', inAppOwnershipType: 'PURCHASED', quantity: 1, transactionId: '123456789',
    appAccountToken: '11111111-1111-4111-8111-111111111111', purchaseDate: Date.now(),
    price: 4990, currency: 'USD', storefront: 'USA' };
  const jws = (payload: unknown) => `${Buffer.from(JSON.stringify({ alg: 'ES256' })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.dGVzdA`;
  const verify = (body: string, host = 'localhost') => mf.dispatchFetch(`http://${host}/verify`, { method: 'POST', body });
  // Exercise first initialization and a later request using the cached module.
  for (let i = 0; i < 2; i++) {
    const response = await verify(jws(transaction));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { transactionId: transaction.transactionId });
  }
  for (const [payload, host] of [
    [jws(transaction), 'api.example.com'],
    [jws({ ...transaction, environment: 'Production' }), 'localhost'],
    [jws({ ...transaction, environment: 'Sandbox' }), 'localhost'],
    [jws({ ...transaction, bundleId: 'another.app' }), 'localhost'],
    ['malformed', 'localhost'],
  ]) {
    const response = await verify(payload, host);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_apple_transaction' });
  }
  const notification = await mf.dispatchFetch('http://localhost/billing/apple/notifications', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ signedPayload: jws({ data: {
      environment: 'Xcode', bundleId: transaction.bundleId, appAppleId: 123456789, signedTransactionInfo: jws(transaction),
    } }) }) });
  assert.equal(notification.status, 503);
  assert.deepEqual(await notification.json(), { error: 'apple_billing_unavailable' });
});
