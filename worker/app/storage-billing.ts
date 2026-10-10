import { authCorsHeaders, authJson, currentUser, readJSON } from './auth-core';
import { ADMIN_EMAIL } from './admin';
import { reconcileStorageInvoice, storageBillingSummary, type StorageInvoice } from '../lib/r2-billing';
import { storageMetered, storagePricing } from '../lib/r2-storage';

export async function handleStorageBillingRequest(request: Request, env: Env) {
  const cors = authCorsHeaders(request);
  if (!cors) return authJson({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const url = new URL(request.url), admin = url.pathname === '/admin/accounting/storage-invoices';
  if (url.pathname !== '/billing/storage' && !admin) return authJson({ error: 'not_found' }, 404, cors);
  if (url.search) return authJson({ error: 'invalid_request' }, 400, cors);
  if (!['GET', ...(admin ? ['POST'] : [])].includes(request.method)) return authJson({ error: 'method_not_allowed' }, 405, cors);
  if (request.method === 'POST' && !request.headers.get('Origin')) return authJson({ error: 'origin_required' }, 403, cors);
  try {
    const user = await currentUser(env, request);
    if (!user) return authJson({ error: 'not_authenticated' }, 401, cors);
    if (admin && user.email?.trim().toLowerCase() !== ADMIN_EMAIL) return authJson({ error: 'forbidden' }, 403, cors);
    if (!storageMetered(env)) {
      if (admin) return authJson({ error: 'storage_unavailable' }, 503, cors);
      return authJson({ month: new Date().toISOString().slice(0, 7), pricing: storagePricing(env), maxBytes: storagePricing(env).maxBytes, projects: [] }, 200, cors);
    }
    if (!admin) return authJson(await storageBillingSummary(env, user.id), 200, cors);
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
