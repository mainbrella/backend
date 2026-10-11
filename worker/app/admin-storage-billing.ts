import { authCorsHeaders, authJson, currentUser, readJSON } from './auth-core';
import { ADMIN_EMAIL } from '../shared/admin';
import { reconcileStorageInvoice, type StorageInvoice } from '../lib/r2-billing';
import { storageMetered } from '../lib/r2-storage';

export async function handleAdminStorageBillingRequest(request: Request, env: Env): Promise<Response> {
  const cors = authCorsHeaders(request);
  if (!cors) return authJson({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const url = new URL(request.url);
  if (url.pathname !== '/admin/accounting/storage-invoices') return authJson({ error: 'not_found' }, 404, cors);
  if (url.search) return authJson({ error: 'invalid_request' }, 400, cors);
  if (!['GET', 'POST'].includes(request.method)) return authJson({ error: 'method_not_allowed' }, 405, cors);
  if (request.method === 'POST' && !request.headers.get('Origin')) return authJson({ error: 'origin_required' }, 403, cors);
  try {
    const user = await currentUser(env, request);
    if (!user) return authJson({ error: 'not_authenticated' }, 401, cors);
    if (user.email?.trim().toLowerCase() !== ADMIN_EMAIL) return authJson({ error: 'forbidden' }, 403, cors);
    if (!storageMetered(env)) return authJson({ error: 'storage_unavailable' }, 503, cors);
    if (request.method === 'GET') {
      const rows = await env.DB.prepare('SELECT evidence FROM r2_invoices ORDER BY month DESC LIMIT 100').all<{ evidence: string }>();
      return authJson({ invoices: rows.results.map(row => JSON.parse(row.evidence)) }, 200, cors);
    }
    const body = await readJSON(request, 8192);
    if (!body || Object.keys(body).some(key => !['id', 'month', 'evidenceReference', 'providerNanoUsd', 'additionalPlatformUsage'].includes(key))) throw new Error('invalid_request');
    return authJson(await reconcileStorageInvoice(env, body as StorageInvoice), 201, cors);
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (['invalid_request', 'month_not_finished', 'storage_invoice_usage_missing'].includes(code)) return authJson({ error: code }, 400, cors);
    if (['storage_invoice_conflict', 'storage_metering_incomplete', 'storage_settlement_pending'].includes(code)) return authJson({ error: code }, 409, cors);
    console.error('storage_billing_failed');
    return authJson({ error: 'storage_unavailable' }, 503, cors);
  }
}
