import { authCorsHeaders, authJson, currentUser, readJSON } from './auth-core';
import { type BillingEnv } from '../lib/stripe';
import { accountBillingRequest, completePrepaidCheckout, createPrepaidCheckout, enableRechargePaymentMethod, ensurePrepaidAccount,
  MAX_TOPUP_CENTS, MIN_TOPUP_CENTS, prepaidAccount, prepaidBillingConfigured, stripeID, validTopupAmount } from '../lib/prepaid-billing';

export async function handlePrepaidBillingRequest(request: Request, env: BillingEnv): Promise<Response> {
  const path = new URL(request.url).pathname;
  const cors = authCorsHeaders(request);
  if (!cors) return authJson({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (path === '/billing/config' && request.method === 'GET') return authJson({ configured: prepaidBillingConfigured(env) && Boolean(env.STRIPE_PUBLISHABLE_KEY), minTopupCents: MIN_TOPUP_CENTS, maxTopupCents: MAX_TOPUP_CENTS }, 200, cors);
  if (!['/billing/balance', '/billing/topups', '/billing/topups/complete', '/billing/settings'].includes(path)) return authJson({ error: 'not_found' }, 404, cors);
  if (request.method !== (path === '/billing/balance' ? 'GET' : 'POST')) return authJson({ error: 'method_not_allowed' }, 405, cors);
  if (request.method === 'POST' && !request.headers.get('Origin')) return authJson({ error: 'origin_required' }, 403, cors);
  let lock: { userId: string; token: string } | undefined;
  try {
    const user = await currentUser(env, request);
    if (!user) return authJson({ error: 'not_authenticated' }, 401, cors);
    if (path === '/billing/balance') return authJson(await accountBillingRequest(env, user.id, '/billing/balance'), 200, cors);
    const body = await readJSON(request, 4096);
    if (!body) return authJson({ error: 'invalid_request' }, 400, cors);
    if (!prepaidBillingConfigured(env)) return authJson({ error: 'billing_unavailable' }, 503, cors);
    if (path === '/billing/topups' && !env.STRIPE_PUBLISHABLE_KEY) return authJson({ error: 'billing_unavailable' }, 503, cors);
    if (path === '/billing/topups' && (!validTopupAmount(body.amountCents) || typeof body.requestId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId))) return authJson({ error: 'invalid_topup' }, 400, cors);
    if (path === '/billing/topups/complete' && !stripeID(body.sessionId, 'cs')) return authJson({ error: 'invalid_request' }, 400, cors);
    if (path === '/billing/settings') {
      if (Object.keys(body).some(key => !['spendLimitCents', 'autoRecharge'].includes(key)) || !Object.keys(body).length) return authJson({ error: 'invalid_request' }, 400, cors);
      if (body.spendLimitCents !== undefined && !validTopupAmount(body.spendLimitCents)) return authJson({ error: 'invalid_spend_limit' }, 400, cors);
      if (body.autoRecharge !== undefined) {
        const value = body.autoRecharge as { enabled?: unknown; amountCents?: unknown; monthlyLimitCents?: unknown };
        if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.enabled !== 'boolean'
          || !validTopupAmount(value.amountCents) || !validTopupAmount(value.monthlyLimitCents)
          || value.monthlyLimitCents < value.amountCents || Object.keys(value).some(key => !['enabled', 'amountCents', 'monthlyLimitCents'].includes(key))) return authJson({ error: 'invalid_auto_recharge' }, 400, cors);
      }
    }
    const token = crypto.randomUUID(); const now = Date.now();
    const acquired = await env.DB.prepare(`INSERT INTO billing_operation_locks (user_id,lock_token,expires_at) VALUES (?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET lock_token=excluded.lock_token,expires_at=excluded.expires_at
      WHERE billing_operation_locks.expires_at <= ? RETURNING lock_token`).bind(user.id, token, now + 300000, now).first<{ lock_token: string }>();
    if (acquired?.lock_token !== token) return authJson({ error: 'billing_operation_pending' }, 409, cors);
    lock = { userId: user.id, token };
    if (path === '/billing/topups') {
      const account = await ensurePrepaidAccount(env, user);
      return authJson(await createPrepaidCheckout(env, account, body.amountCents as number, body.requestId as string, cors['access-control-allow-origin']!), 200, cors);
    }
    if (path === '/billing/topups/complete') {
      const account = await prepaidAccount(env, user.id);
      if (!account) return authJson({ error: 'checkout_not_owned' }, 403, cors);
      return authJson(await completePrepaidCheckout(env, account, body.sessionId as string), 200, cors);
    }
    const autoRecharge = body.autoRecharge as { enabled: boolean } | undefined;
    const account = await ensurePrepaidAccount(env, user);
    // The explicit settings request is consent to save a verified card for
    // future charges. Merely buying credit never enables automatic recharge.
    if (autoRecharge?.enabled && account) await enableRechargePaymentMethod(env, account);
    const result = await accountBillingRequest(env, user.id, '/billing/settings', { ...body, ...(account ? { customerId: account.stripe_customer_id } : {}) });
    return authJson(result, 200, cors);
  } catch (error) {
    const code = error instanceof Error ? error.message : 'billing_unavailable';
    const forbidden = ['checkout_not_owned', 'payment_not_owned', 'request_not_owned'];
    const conflicts = ['topup_request_conflict', 'topup_already_complete', 'topup_expired', 'payment_pending', 'billing_reconciliation_required', 'spend_limit_below_committed_usage', 'spend_limit_below_committed', 'auto_recharge_pending'];
    if (forbidden.includes(code)) return authJson({ error: code }, 403, cors);
    if (conflicts.includes(code)) return authJson({ error: code }, 409, cors);
    console.error('prepaid_billing_failed', code);
    return authJson({ error: 'billing_unavailable' }, 503, cors);
  } finally {
    if (lock) {
      try { await env.DB.prepare('DELETE FROM billing_operation_locks WHERE user_id = ? AND lock_token = ?').bind(lock.userId, lock.token).run(); }
      catch { console.error('billing_lock_release_failed'); }
    }
  }
}
