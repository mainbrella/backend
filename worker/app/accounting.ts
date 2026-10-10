import { authCorsHeaders, authJson, currentUser, readJSON } from './auth-core';
import { ADMIN_EMAIL } from './admin';
import { createAccountingClose, monthBounds } from '../lib/accounting-close';
import { ledgerWatermark, type LedgerRow } from '../lib/accounting-ledger';
import type { BillingEnv } from '../lib/stripe';

export async function handleAccountingRequest(request: Request, env: BillingEnv): Promise<Response> {
  const cors = authCorsHeaders(request);
  if (!cors) return authJson({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const url = new URL(request.url), path = url.pathname;
  const methods: Record<string, string[]> = { '/admin/accounting/ledger': ['GET'], '/admin/accounting/closes': ['GET', 'POST'], '/admin/accounting/policies': ['GET', 'POST'] };
  if (!methods[path]) return authJson({ error: 'not_found' }, 404, cors);
  if (!methods[path].includes(request.method)) return authJson({ error: 'method_not_allowed' }, 405, cors);
  if (request.method === 'POST' && !request.headers.get('Origin')) return authJson({ error: 'origin_required' }, 403, cors);
  try {
    const user = await currentUser(env, request);
    if (!user) return authJson({ error: 'unauthorized' }, 401, cors);
    if (user.email?.trim().toLowerCase() !== ADMIN_EMAIL) return authJson({ error: 'forbidden' }, 403, cors);
    if (path === '/admin/accounting/ledger') {
      const query = url.searchParams;
      if ([...query.keys()].some(key => !['after', 'throughSequence', 'limit', 'format'].includes(key))) throw new Error('invalid_request');
      const after = Number(query.get('after') ?? 0), limit = Number(query.get('limit') ?? 1000);
      const throughSequence = query.has('throughSequence') ? Number(query.get('throughSequence')) : await ledgerWatermark(env);
      const format = query.get('format') ?? 'json';
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(throughSequence) || throughSequence < after
        || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !['json', 'ndjson'].includes(format)) throw new Error('invalid_request');
      const page = await env.DB.prepare('SELECT * FROM accounting_ledger WHERE sequence > ? AND sequence <= ? ORDER BY sequence LIMIT ?').bind(after, throughSequence, limit + 1).all<LedgerRow>();
      const entries = page.results.slice(0, limit).map(({ payload, ...row }) => ({ ...row, data: JSON.parse(payload) }));
      const next = page.results.length > limit ? entries.at(-1)!.sequence : null;
      if (format === 'ndjson') return new Response(entries.map(entry => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : ''), { headers: {
        ...cors, 'Content-Type': 'application/x-ndjson', 'Content-Disposition': 'attachment; filename="accounting-ledger.ndjson"', 'Cache-Control': 'no-store',
        'X-Accounting-Through-Sequence': String(throughSequence), 'X-Accounting-Next-Cursor': next === null ? '' : String(next),
        'Access-Control-Expose-Headers': 'X-Accounting-Through-Sequence, X-Accounting-Next-Cursor',
      } });
      return authJson({ entries, throughSequence, nextCursor: next }, 200, cors);
    }
    if (request.method === 'GET') {
      if (path.endsWith('/policies')) {
        if (url.search) throw new Error('invalid_request');
        const policies = await env.DB.prepare('SELECT * FROM accounting_policies ORDER BY created_at DESC, id DESC LIMIT 100').all();
        return authJson({ policies: policies.results }, 200, cors);
      }
      if ([...url.searchParams.keys()].some(key => key !== 'month')) throw new Error('invalid_request');
      const month = url.searchParams.get('month'); if (month !== null) monthBounds(month);
      const rows = await env.DB.prepare(`SELECT * FROM accounting_closes ${month ? 'WHERE month = ?' : ''} ORDER BY created_at DESC, id DESC LIMIT 100`).bind(...(month ? [month] : [])).all<{ report: string }>();
      return authJson({ closes: rows.results.map(row => ({ ...row, report: JSON.parse(row.report) })) }, 200, cors);
    }
    if (url.search) throw new Error('invalid_request');
    const body = await readJSON(request, 8192);
    if (!body) throw new Error('invalid_request');
    if (path.endsWith('/closes')) {
      if (Object.keys(body).some(key => !['month', 'policyId'].includes(key)) || typeof body.month !== 'string'
        || (body.policyId !== undefined && (typeof body.policyId !== 'string' || body.policyId.length > 100))) throw new Error('invalid_request');
      return authJson(await createAccountingClose(env, body.month, user.id, body.policyId as string | undefined), 201, cors);
    }
    if (Object.keys(body).some(key => !['method', 'receiptTimezone', 'approvedBy', 'evidenceReference'].includes(key))
      || !['cash_receipts', 'section_451c'].includes(body.method as string)
      || [body.receiptTimezone, body.approvedBy, body.evidenceReference].some(value => typeof value !== 'string' || !value.trim() || value.length > 2000)) throw new Error('invalid_request');
    try { new Intl.DateTimeFormat('en-US', { timeZone: body.receiptTimezone as string }); } catch { throw new Error('invalid_request'); }
    const id = crypto.randomUUID(), createdAt = Date.now();
    await env.DB.prepare('INSERT INTO accounting_policies (id,created_at,created_by,method,receipt_timezone,approved_by,evidence_reference) VALUES (?,?,?,?,?,?,?)')
      .bind(id, createdAt, user.id, body.method, body.receiptTimezone, (body.approvedBy as string).trim(), (body.evidenceReference as string).trim()).run();
    return authJson({ id, createdAt }, 201, cors);
  } catch (error) {
    const code = error instanceof Error ? error.message : 'accounting_unavailable';
    if (['invalid_request', 'invalid_month', 'month_not_finished'].includes(code)) return authJson({ error: code }, 400, cors);
    if (code === 'policy_not_found') return authJson({ error: code }, 404, cors);
    console.error('accounting_failed', code);
    return authJson({ error: 'accounting_unavailable' }, 503, cors);
  }
}
