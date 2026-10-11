import { storageRetention, markStorageWarning } from '../lib/r2-retention';
import { authCorsHeaders, authJson, currentUser } from './auth-core';
import { storageBillingSummary } from '../lib/r2-billing';
import { storageMetered, storagePricing } from '../lib/r2-storage';

export async function handleStorageBillingRequest(request: Request, env: Env) {
  const cors = authCorsHeaders(request);
  if (!cors) return authJson({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const url = new URL(request.url);
  if (url.pathname !== '/billing/storage') return authJson({ error: 'not_found' }, 404, cors);
  if (url.search) return authJson({ error: 'invalid_request' }, 400, cors);
  if (request.method !== 'GET') return authJson({ error: 'method_not_allowed' }, 405, cors);
  try {
    const user = await currentUser(env, request);
    if (!user) return authJson({ error: 'not_authenticated' }, 401, cors);
    if (!storageMetered(env)) {
      return authJson({ month: new Date().toISOString().slice(0, 7), pricing: storagePricing(env), maxBytes: storagePricing(env).maxBytes, projects: [], retention: await storageRetention(env, user.id) }, 200, cors);
    }
    const summary = await storageBillingSummary(env, user.id);
    if (summary.retention.deletionAt !== null && summary.retention.warningDeliveredAt === null) {
      await markStorageWarning(env, user.id, summary.retention.deletionAt);
      summary.retention = await storageRetention(env, user.id);
    }
    return authJson(summary, 200, cors);
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (['invalid_request', 'month_not_finished', 'storage_invoice_usage_missing'].includes(code)) return authJson({ error: code }, 400, cors);
    if (['storage_invoice_conflict', 'storage_metering_incomplete', 'storage_settlement_pending'].includes(code)) return authJson({ error: code }, 409, cors);
    console.error('storage_billing_failed');
    return authJson({ error: 'storage_unavailable' }, 503, cors);
  }
}
