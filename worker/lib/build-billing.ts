import { BuildError, type BuildParams } from './build-contract';
import { accountBillingRequest } from './prepaid-billing';
import { buildInferenceChargeMicroUsd } from './build-pricing';

type Receipt = { id: string; user_id: string; app_id: string; turn_id: string; model: string;
  reserved_micro_usd: number; cost_micro_usd: number | null; usage_json: string | null;
  status: 'reserved' | 'running' | 'reported' | 'settled'; created_at: number; reported_at: number | null };

async function settle(env: Env, row: Receipt) {
  await accountBillingRequest(env, row.user_id, '/billing/inference', { action: 'settle', id: row.id,
    costMicroUsd: row.cost_micro_usd, occurredAt: row.reported_at, usage: JSON.parse(row.usage_json!) });
  await env.DB.prepare("UPDATE build_ai_usage SET status = 'settled' WHERE id = ? AND status = 'reported'").bind(row.id).run();
}
export async function settleReportedBuildUsage(env: Env, turnId?: string) {
  const { results } = await env.DB.prepare(`SELECT * FROM build_ai_usage WHERE status = 'reported' ${turnId ? 'AND turn_id = ?' : ''} ORDER BY created_at LIMIT 100`)
    .bind(...(turnId ? [turnId] : [])).all<Receipt>();
  for (const row of results) await settle(env, row);
}

/** Reserve before inference; keep unknown outcomes held for reconciliation. */
export async function meteredBuildInference<T>(env: Env, params: BuildParams, operation: string, model: string,
  reservedMicroUsd: number, run: (report: (costMicroUsd: number, usage: Record<string, unknown>) => Promise<void>) => Promise<T>): Promise<T> {
  reservedMicroUsd = buildInferenceChargeMicroUsd(reservedMicroUsd);
  const id = `${params.turnId}:${operation}`;
  await env.DB.prepare(`INSERT INTO build_ai_usage (id,user_id,app_id,turn_id,model,reserved_micro_usd,status,created_at)
    VALUES (?,?,?,?,?,?,'reserved',?) ON CONFLICT(id) DO NOTHING`)
    .bind(id, params.userId, params.appId, params.turnId, model, reservedMicroUsd, Date.now()).run();
  const row = await env.DB.prepare('SELECT * FROM build_ai_usage WHERE id = ?').bind(id).first<Receipt>();
  if (!row || row.user_id !== params.userId || row.model !== model || row.reserved_micro_usd !== reservedMicroUsd)
    throw new BuildError('build_billing_reconciliation_required');
  // A workflow may resume after its side effect but before saving its result.
  // A reservation is replayable; a provider request is never replayable.
  if (row.status !== 'reserved') throw new BuildError('build_billing_reconciliation_required');
  try {
    await accountBillingRequest(env, params.userId, '/billing/inference', { action: 'reserve', id, model,
      appId: params.appId, turnId: params.turnId, reservedMicroUsd, createdAt: row.created_at });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    throw new BuildError(['insufficient_balance', 'spend_limit_exceeded', 'build_billing_reconciliation_required'].includes(code) ? code : 'build_billing_unavailable', 402);
  }
  const claimed = await env.DB.prepare("UPDATE build_ai_usage SET status = 'running' WHERE id = ? AND status = 'reserved'").bind(id).run();
  if (!claimed.meta.changes) throw new BuildError('build_billing_reconciliation_required');
  let reported = false;
  return run(async (costMicroUsd, usage) => {
    if (reported) return;
    await env.DB.prepare("UPDATE build_ai_usage SET status = 'reported', cost_micro_usd = ?, usage_json = ?, reported_at = ? WHERE id = ? AND status = 'running'")
      .bind(buildInferenceChargeMicroUsd(costMicroUsd), JSON.stringify({ ...usage, providerCostMicroUsd: costMicroUsd, markupPercent: 50 }), Date.now(), id).run();
    reported = true;
  });
}
