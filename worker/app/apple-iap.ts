import { authCorsHeaders, authJson, currentUser, readJSON } from './auth-core';
import { APPLE_PRODUCT_ID, appleAccountToken, appleConfigured, appleProceeds, appleVerifier,
  applyAppleTransaction, localAppleTesting, verifyAppleTransaction } from '../lib/apple-iap';

export async function handleAppleIAPRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url), notification = url.pathname === '/billing/apple/notifications';
  const cors = notification ? {} : authCorsHeaders(request);
  if (!cors) return authJson({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS' && !notification) return new Response(null, { status: 204, headers: cors });
  if (!['/billing/apple/config', '/billing/apple/transactions', '/billing/apple/notifications'].includes(url.pathname))
    return authJson({ error: 'not_found' }, 404, cors);
  if (request.method !== (url.pathname.endsWith('/config') ? 'GET' : 'POST')) return authJson({ error: 'method_not_allowed' }, 405, cors);
  if (!notification && request.method === 'POST' && !request.headers.get('Origin')) return authJson({ error: 'origin_required' }, 403, cors);
  const local = localAppleTesting(env, request);
  try {
    const user = notification ? null : await currentUser(env, request);
    if (!notification && !user) return authJson({ error: 'not_authenticated' }, 401, cors);
    if (!appleConfigured(env, local && !notification)) return authJson({ error: 'apple_billing_unavailable' }, 503, cors);
    if (url.pathname.endsWith('/config')) {
      const query = url.searchParams, price = Number(query.get('priceMilliunits'));
      if ([...query.keys()].some(key => !['storefront', 'currency', 'priceMilliunits'].includes(key))
        || !/^[A-Z]{3}$/.test(query.get('storefront') ?? '') || !/^[A-Z]{3}$/.test(query.get('currency') ?? '')
        || !Number.isSafeInteger(price) || price <= 0) return authJson({ error: 'invalid_request' }, 400, cors);
      const proceeds = appleProceeds(env, local, query.get('storefront'), query.get('currency'), price);
      return authJson({ productId: APPLE_PRODUCT_ID, appAccountToken: await appleAccountToken(env, user!.id),
        creditCents: proceeds.netCents, currency: 'usd' }, 200, cors);
    }
    const body = await readJSON(request, 64000), field = notification ? 'signedPayload' : 'signedTransactionInfo';
    if (!body || Object.keys(body).length !== 1 || typeof body[field] !== 'string' || !body[field].length || body[field].length > 60000)
      return authJson({ error: 'invalid_request' }, 400, cors);
    let signed = body[field] as string;
    if (notification) {
      // No cookie is needed for Apple webhooks: Apple's verified JWS is the
      // authentication. Local Xcode payloads cannot authenticate a webhook.
      const event = await (await appleVerifier(env)).verifyAndDecodeNotification(signed);
      if (!event.data?.signedTransactionInfo) return authJson({ ok: true }, 200, cors);
      signed = event.data.signedTransactionInfo;
    }
    const transaction = await verifyAppleTransaction(env, signed, local && !notification);
    const result = await applyAppleTransaction(env, transaction, local && !notification, user?.id);
    return authJson(notification ? { ok: true } : result, 200, cors);
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'apple_purchase_not_owned') return authJson({ error: code }, 403, cors);
    if (code === 'invalid_apple_transaction') return authJson({ error: code }, 400, cors);
    if (code === 'apple_purchase_conflict') return authJson({ error: code }, 409, cors);
    if (code === 'apple_price_unavailable') return authJson({ error: code }, 409, cors);
    console.error('apple_iap_failed', code || 'verification_failed');
    return authJson({ error: 'apple_billing_unavailable' }, 503, cors);
  }
}
