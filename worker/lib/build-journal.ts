import { BuildError, validateBuildFiles, type BuildParams, type BuildFiles } from './build-contract';
import { storeBuildSource, storeBuildText, canonicalBuildSource } from './build-storage';

export type OperationStatus = 'proposed' | 'skipped' | 'blocked' | 'succeeded' | 'failed' | 'unknown';
export type OperationKind = 'text' | 'image' | 'tool' | 'command' | 'source' | 'billing' | 'cleanup';
export type BuildFailure = { code: string; classification: 'provider' | 'parser' | 'infrastructure' | 'validation';
  details: string | null; providerCode: string | null; operationId: string | null };
export type OperationResult<T> = { ok: true; value: T } | { ok: false; failure: BuildFailure };
export type OperationRow = { turn_id: string; operation_id: string; attempt_id: string; schema_version: number;
  deployment_version: string | null; kind: OperationKind; label: string; status: OperationStatus;
  dispatch_attempted: number | null; created_at: number; started_at: number | null; updated_at: number; finished_at: number | null;
  evidence_json: string; result_json: string | null; source_json: string | null };
export type OperationRef = { params: BuildParams; id: string; attempt?: string };
const key = (ref: OperationRef) => [ref.params.turnId, ref.id, ref.attempt ?? '1'];
const boundedJSON = (value: unknown, limit = 64 * 1024) => {
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).length > limit) throw new BuildError('build_diagnostics_too_large');
  return json;
};
async function durable<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (error) {
    if (error instanceof BuildError) throw error;
    throw new BuildError('build_journal_unavailable', 503, error instanceof Error ? error.message.slice(0, 4000) : undefined);
  }
}
export function buildFailure(error: unknown, operationId: string | null = null): BuildFailure {
  const code = error instanceof BuildError ? error.message : 'build_failed';
  return { code, classification: error instanceof BuildError ? error.classification : 'infrastructure',
    details: (error instanceof BuildError ? error.details : error instanceof Error ? error.message : String(error))?.slice(0, 4000) ?? null,
    providerCode: error instanceof BuildError ? error.providerCode ?? null : null,
    operationId: error instanceof BuildError ? error.operationId ?? operationId : operationId };
}
export function failureError(failure: BuildFailure) {
  const error = new BuildError(failure.code, 503, failure.details ?? undefined);
  error.classification = failure.classification; error.providerCode = failure.providerCode ?? undefined;
  error.operationId = failure.operationId ?? undefined;
  return error;
}
export async function proposeBuildOperation(env: Env, ref: OperationRef, kind: OperationKind, label: string, evidence: Record<string, unknown> = {}) {
  await durable(() => env.DB.prepare(`INSERT INTO build_operations
    (turn_id,operation_id,attempt_id,schema_version,deployment_version,kind,label,status,dispatch_attempted,created_at,updated_at,evidence_json)
    SELECT ?,?,?,1,?,?,?,'proposed',0,?,?,? WHERE EXISTS (SELECT 1 FROM build_turns WHERE id = ? AND user_id = ?)
    ON CONFLICT(turn_id,operation_id,attempt_id) DO NOTHING`)
    .bind(...key(ref), env.VERSION_METADATA?.id ?? null, kind, label.slice(0, 200), Date.now(), Date.now(), boundedJSON(evidence), ref.params.turnId, ref.params.userId).run());
}
export async function readBuildOperation(env: Env, ref: OperationRef) {
  return durable(() => env.DB.prepare('SELECT * FROM build_operations WHERE turn_id = ? AND operation_id = ? AND attempt_id = ?')
    .bind(...key(ref)).first<OperationRow>());
}
/** Atomic guard: process loss after this claim cannot cause a paid invocation to replay. */
export async function startBuildOperation(env: Env, ref: OperationRef, kind: OperationKind, label: string, evidence: Record<string, unknown> = {}) {
  await proposeBuildOperation(env, ref, kind, label, evidence);
  const claimed = await durable(() => env.DB.prepare(`UPDATE build_operations SET status = 'unknown', started_at = ?, updated_at = ?,
    label = ?, evidence_json = json_patch(evidence_json, ?) WHERE turn_id = ? AND operation_id = ? AND attempt_id = ? AND status = 'proposed' AND started_at IS NULL`)
    .bind(Date.now(), Date.now(), label.slice(0, 200), boundedJSON(evidence), ...key(ref)).run());
  if (!claimed.meta.changes) {
    const error = new BuildError(kind === 'text' || kind === 'image' ? 'build_billing_reconciliation_required' : 'build_operation_reconciliation_required'); error.operationId = ref.id; throw error;
  }
  if (Object.keys(evidence).length) await recordBuildOperation(env, ref, { evidence });
}
export async function recordBuildOperation(env: Env, ref: OperationRef, update: {
  status?: OperationStatus; evidence?: Record<string, unknown>; result?: unknown; dispatchAttempted?: boolean; finished?: boolean;
  started?: boolean;
}) {
  const evidence = update.evidence ?? {};
  boundedJSON(evidence);
  const entries = Object.entries(evidence);
  // json_patch removes nulls. json_set keeps missing provider values explicitly unknown.
  const merge = entries.length ? `json_set(evidence_json,${entries.map(() => '?,json(?)').join(',')})` : 'evidence_json';
  const result = update.result === undefined ? null : boundedJSON(update.result, 512 * 1024);
  // Failure summaries stay in D1 for routine status reads. Successful provider
  // results can contain complete write_file arguments, so retain those in R2.
  const storedResult = result && (update.result as { ok?: boolean })?.ok === true ? await storeBuildText(env, ref.params, result) : result;
  const saved = await durable(() => env.DB.prepare(`UPDATE build_operations SET status = COALESCE(?,status), updated_at = ?,
    started_at = CASE WHEN ? THEN COALESCE(started_at,?) ELSE started_at END,
    finished_at = CASE WHEN ? THEN COALESCE(finished_at,?) ELSE finished_at END,
    dispatch_attempted = COALESCE(?,dispatch_attempted), evidence_json = ${merge}, result_json = COALESCE(?,result_json)
    WHERE turn_id = ? AND operation_id = ? AND attempt_id = ?`)
    .bind(update.status ?? null, Date.now(), update.started ? 1 : 0, Date.now(), update.finished ? 1 : 0, Date.now(), update.dispatchAttempted === undefined ? null : Number(update.dispatchAttempted),
      ...entries.flatMap(([name, value]) => [`$.${name}`, JSON.stringify(value)]), storedResult, ...key(ref)).run());
  if (!saved.meta.changes) throw new BuildError('build_journal_unavailable');
}
export async function checkpointBuildOperation(env: Env, ref: OperationRef, evidence: Record<string, unknown>) {
  try { await recordBuildOperation(env, ref, { evidence }); }
  catch { console.error('build_checkpoint_unavailable', { turnId: ref.params.turnId, operationId: ref.id }); }
}
export async function retainBuildSource(env: Env, ref: OperationRef, files: BuildFiles, changedPaths: string[] = []) {
  validateBuildFiles(files);
  const text = canonicalBuildSource(files), source = await storeBuildSource(env, ref.params, files);
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const saved = await durable(() => env.DB.prepare(`UPDATE build_operations SET source_json = ?,
    evidence_json = json_set(evidence_json,'$.sourceDigest',?,'$.changedPaths',json(?))
    WHERE turn_id = ? AND operation_id = ? AND attempt_id = ? AND source_json IS NULL`)
    .bind(source, digest, JSON.stringify(changedPaths), ...key(ref)).run());
  if (!saved.meta.changes) {
    const row = await readBuildOperation(env, ref);
    if (row?.source_json !== source) throw new BuildError('build_source_snapshot_conflict');
  }
  return source;
}
export async function buildOperationTimeline(env: Env, turnId: string) {
  const { results } = await env.DB.prepare('SELECT * FROM build_operations WHERE turn_id = ? ORDER BY created_at, rowid').bind(turnId).all<OperationRow>();
  return results;
}
export function operationExplanation(row: OperationRow): string | null {
  const evidence = JSON.parse(row.evidence_json);
  const failure = row.result_json ? JSON.parse(row.result_json).failure as BuildFailure | undefined : undefined;
  if (row.operation_id.startsWith('limit-') && typeof evidence.reason === 'string') return evidence.reason;
  if (row.status === 'skipped') return 'Not run. The build stopped before this operation started.';
  if (row.status === 'proposed') return 'Proposed. Waiting for the model to finish its request.';
  if (row.kind === 'text' && evidence.finishReason === 'length') return `The model reached its ${evidence.tokenAllowance?.toLocaleString() ?? ''} token response limit before finishing. Incomplete tool requests were not run.`;
  if (row.kind === 'text' && evidence.termination === 'read_exception') return 'The model stream disconnected before a complete response was retained. Its execution outcome is unknown.';
  if (row.kind === 'text' && failure?.code === 'model_response_incomplete') return `The model stream ended without a complete finish marker${evidence.doneSeen ? ' (the end marker arrived without a finish reason)' : ''}. Incomplete tool requests were not run.`;
  if (failure?.code === 'build_inference_timeout') return 'The model did not respond before the inference timeout. Incomplete tool requests were not run.';
  if (failure?.code === 'build_inference_disconnected') return 'The inference service disconnected before finishing. Incomplete tool requests were not run.';
  if (failure?.classification === 'provider') return `The provider rejected the request${failure.providerCode ? ` (${failure.providerCode})` : ''}.`;
  if (failure?.code === 'invalid_model_response') return 'The model returned malformed output. Incomplete tool requests were not run.';
  const reasons: Record<string, string> = {
    build_image_limit: 'Image limit reached: 4 per turn or 12 per app. No image request was sent.',
    insufficient_balance: 'Available credit was insufficient. No provider request was sent.',
    spend_limit_exceeded: "Your Mainbrella account's monthly spending limit could not cover this request and existing reservations. No request was sent to Cloudflare.",
    build_journal_unavailable: 'Required operation records could not be saved. Execution stopped to preserve a safe recovery path.',
    build_billing_unavailable: 'Funding could not be verified. No provider request was sent.',
    build_billing_reconciliation_required: 'Provider usage could not be confirmed. The funding hold is retained for reconciliation.',
    build_usage_storage_unavailable: 'Provider usage was observed, but could not be saved for billing. Execution stopped; accounting can retry independently.',
    build_image_invalid: 'The image provider returned an invalid image.',
  };
  if (failure && reasons[failure.code]) return reasons[failure.code];
  if (row.kind === 'command' && row.status === 'failed') return `${row.label} exited with code ${evidence.exitCode ?? 'unknown'}. Command output and the checked source are retained in diagnostics.`;
  if (row.status === 'unknown') return 'Execution may have started, but no definitive result was retained.';
  if (row.status === 'blocked') return 'Local validation prevented this operation from running.';
  return null;
}
