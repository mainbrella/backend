import { BuildError, type BuildParams } from './build-contract';
import { accountBillingRequest } from './prepaid-billing';
import { buildInferenceChargeMicroUsd, buildTokenCostMicroUsd, readBuildTokenUsage } from './build-pricing';
import { proposeBuildOperation, recordBuildOperation, buildFailure, type OperationRef } from './build-journal';

type Receipt = { id: string; user_id: string; app_id: string; turn_id: string; model: string;
  reserved_micro_usd: number; cost_micro_usd: number | null; usage_json: string | null;
  status: 'reserved' | 'running' | 'reported' | 'settled'; created_at: number; reported_at: number | null };

async function settle(env: Env, row: Receipt) {
  const ref = { params: { userId: row.user_id, appId: row.app_id, turnId: row.turn_id }, id: `settle-${row.id.slice(row.turn_id.length + 1)}` };
  // Receipts survive app deletion; their journal may have been deleted with it.
  const exists = await env.DB.prepare('SELECT id FROM build_turns WHERE id = ?').bind(row.turn_id).first();
  if (exists) await proposeBuildOperation(env, ref, 'billing', 'Settle AI charge', { receiptId: row.id });
  try {
    if (exists) await recordBuildOperation(env, ref, { status: 'unknown', started: true, dispatchAttempted: true });
    await accountBillingRequest(env, row.user_id, '/billing/inference', { action: 'settle', id: row.id,
      costMicroUsd: row.cost_micro_usd, occurredAt: row.reported_at, usage: JSON.parse(row.usage_json!) });
    await env.DB.prepare("UPDATE build_ai_usage SET status = 'settled' WHERE id = ? AND status = 'reported'").bind(row.id).run();
    if (exists) await recordBuildOperation(env, ref, { status: 'succeeded', finished: true });
  } catch (error) {
    if (exists) await recordBuildOperation(env, ref, { status: 'unknown', finished: true, evidence: { lastFailure: buildFailure(error, ref.id) }, result: { ok: false, failure: buildFailure(error, ref.id) } }).catch(() => {});
    throw error;
  }
}
export async function settleReportedBuildUsage(env: Env, turnId?: string) {
  // Recover observed usage independently from the non-replayable inference step.
  const { results: pending } = await env.DB.prepare(`SELECT u.*, o.evidence_json FROM build_ai_usage u JOIN build_operations o
    ON o.turn_id = u.turn_id AND u.id = u.turn_id || ':' || o.operation_id AND o.attempt_id = '1'
    WHERE u.status = 'running' AND (o.finished_at IS NOT NULL OR EXISTS (SELECT 1 FROM build_turns t WHERE t.id = u.turn_id AND t.status IN ('failed','succeeded')))
    ${turnId ? 'AND u.turn_id = ?' : ''} LIMIT 100`).bind(...(turnId ? [turnId] : [])).all<Receipt & { evidence_json: string }>();
  for (const row of pending) {
    const evidence = JSON.parse(row.evidence_json);
    const tokens = readBuildTokenUsage(evidence.usage);
    const charge = evidence.usageCharge ?? (tokens ? { costMicroUsd: buildTokenCostMicroUsd(row.model, tokens), usage: tokens } : null);
    if (charge) await persistBuildUsage(env, { userId: row.user_id, appId: row.app_id, turnId: row.turn_id }, row.id.slice(row.turn_id.length + 1), charge.costMicroUsd, charge.usage);
  }
  const { results } = await env.DB.prepare(`SELECT * FROM build_ai_usage WHERE status = 'reported' ${turnId ? 'AND turn_id = ?' : ''} ORDER BY created_at LIMIT 100`)
    .bind(...(turnId ? [turnId] : [])).all<Receipt>();
  for (const row of results) await settle(env, row);
}

export async function persistBuildUsage(env: Env, params: BuildParams, operation: string, costMicroUsd: number, usage: Record<string, unknown>) {
  const ref: OperationRef = { params, id: `usage-${operation}` }, id = `${params.turnId}:${operation}`;
  await proposeBuildOperation(env, ref, 'billing', 'Save provider usage', { receiptId: id });
  try {
    await recordBuildOperation(env, ref, { status: 'unknown', started: true });
    await env.DB.prepare("UPDATE build_ai_usage SET status = 'reported', cost_micro_usd = ?, usage_json = ?, reported_at = ? WHERE id = ? AND status = 'running'")
      .bind(buildInferenceChargeMicroUsd(costMicroUsd), JSON.stringify({ ...usage, providerCostMicroUsd: costMicroUsd, markupPercent: 50 }), Date.now(), id).run();
    await recordBuildOperation(env, ref, { status: 'succeeded', finished: true });
  } catch (error) {
    await recordBuildOperation(env, ref, { status: 'unknown', finished: true, evidence: { lastFailure: buildFailure(error, ref.id) }, result: { ok: false, failure: buildFailure(error, ref.id) } }).catch(() => {});
    const failure = new BuildError('build_usage_storage_unavailable', 503, error instanceof Error ? error.message : undefined);
    failure.operationId = ref.id; throw failure;
  }
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
    await persistBuildUsage(env, params, operation, costMicroUsd, usage);
    reported = true;
  });
}
