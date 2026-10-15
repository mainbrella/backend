import { accountBillingRequest } from './prepaid-billing';
import { buildInferenceChargeMicroUsd, buildTokenCostMicroUsd, readBuildTokenUsage } from './build-pricing';
import { callStub, type VoiceCallRow, VOICE_MODELS } from './voice';

// Verified 2026-10-15: https://developers.cloudflare.com/workers-ai/platform/pricing/
// Flux $0.0077/audio minute; Aura $0.015/1,000 input characters.
export const STT_WINDOW_MS = 5000;
export const sttCost = (audioMs: number) => Math.ceil(audioMs * 7700 / 60_000);
export const ttsCost = (text: string) => text.length * 15;
export const llmCost = (usage: unknown) => {
  const tokens = readBuildTokenUsage(usage);
  if (!tokens) throw new Error('voice_usage_unknown');
  return buildTokenCostMicroUsd(VOICE_MODELS.llm, tokens);
};
export const llmReservation = (messages: Array<{role:string;content:string}>) => buildTokenCostMicroUsd(VOICE_MODELS.llm, {
  // UTF-8 bytes bound token count, including a generous chat-template allowance.
  inputTokens: new TextEncoder().encode(messages.map(row=>row.content).join('')).length + messages.length * 64 + 256,
  cachedInputTokens: 0, outputTokens: 256,
});
export function phoneRate(env: Env): number {
  const value = Number(env.VOICE_PHONE_MICRO_USD_PER_MINUTE);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 1_000_000) throw new Error('voice_phone_unpriced');
  return value;
}
export const billingError = (error: unknown) => error instanceof Error && ['insufficient_balance','spend_limit_exceeded'].includes(error.message) ? error.message : 'voice_billing_unavailable';

export async function checkVoiceBalance(env: Env, userId: string, callId: string = crypto.randomUUID()) {
  // Wallet checks use exact micro-USD, not the public balance rounded to cents.
  await accountBillingRequest(env,userId,'/billing/inference',{action:'check',id:`${callId}:check`});
}
export async function stopUserCalls(env: Env, userId: string, exceptId?: string, startedBefore?: string) {
  const {results} = await env.DB.prepare("SELECT id FROM voice_calls WHERE user_id=? AND status='active' AND (? IS NULL OR started_at<=?)").bind(userId,startedBefore || null,startedBefore || null).all<{id:string}>();
  const stopped = await Promise.allSettled(results.filter(row=>row.id!==exceptId).map(async row=>{
    const response = await callStub(env,row.id).fetch(new Request('https://voice.internal/billing-stop',{method:'POST'}));
    if (!response.ok) throw new Error('voice_stop_failed');
  }));
  if (stopped.some(row=>row.status==='rejected')) throw new Error('voice_stop_failed');
}

export interface VoiceReceipt {
  id: string; user_id: string; call_id: string; agent_id: string; channel: string; model: string;
  reserved_micro_usd: number; cost_micro_usd: number | null; usage_json: string | null;
  status: 'reserved'|'running'|'reported'|'settled'|'denied'; created_at: number; reported_at: number | null;
}
type CallOwner = Pick<VoiceCallRow,'id'|'user_id'|'agent_id'|'channel'>;
export async function reserveVoiceUsage(env: Env, call: CallOwner, model: string, providerMicroUsd: number): Promise<string> {
  const id = `${call.id}:${crypto.randomUUID()}`;
  const createdAt = Date.now(), reservedMicroUsd = buildInferenceChargeMicroUsd(providerMicroUsd);
  await env.DB.prepare(`INSERT INTO voice_usage (id,user_id,call_id,agent_id,channel,model,reserved_micro_usd,status,created_at)
    VALUES (?,?,?,?,?,?,?,'reserved',?)`).bind(id,call.user_id,call.id,call.agent_id,call.channel,model,reservedMicroUsd,createdAt).run();
  try {
    await accountBillingRequest(env,call.user_id,'/billing/inference',{action:'reserve',id,model,
      appId:call.agent_id,turnId:call.id,reservedMicroUsd,createdAt});
  } catch (error) {
    if (billingError(error)!=='voice_billing_unavailable') {
      await env.DB.prepare("UPDATE voice_usage SET status='denied',usage_json=? WHERE id=? AND status='reserved'")
        .bind(JSON.stringify({error:billingError(error)}),id).run();
    }
    throw error;
  }
  await env.DB.prepare("UPDATE voice_usage SET status='running' WHERE id=? AND status='reserved'").bind(id).run();
  return id;
}
export async function reportVoiceUsage(env: Env, id: string, providerMicroUsd: number, usage: Record<string,unknown>) {
  await env.DB.prepare(`UPDATE voice_usage SET status='reported',cost_micro_usd=?,usage_json=?,reported_at=? WHERE id=? AND status='running'`)
    .bind(buildInferenceChargeMicroUsd(providerMicroUsd),JSON.stringify({...usage,service:'voice',providerCostMicroUsd:providerMicroUsd,markupPercent:50}),Date.now(),id).run();
  const row = await env.DB.prepare('SELECT * FROM voice_usage WHERE id=?').bind(id).first<VoiceReceipt>();
  if (!row || !['reported','settled'].includes(row.status)) throw new Error('voice_billing_unavailable');
  await settleVoiceReceipt(env,row);
}
async function settleVoiceReceipt(env: Env, row: VoiceReceipt) {
  if (row.status==='settled') return;
  await accountBillingRequest(env,row.user_id,'/billing/inference',{action:'settle',id:row.id,costMicroUsd:row.cost_micro_usd,
    occurredAt:row.reported_at,usage:{...JSON.parse(row.usage_json!),callId:row.call_id,channel:row.channel,agentId:row.agent_id}});
  await env.DB.prepare("UPDATE voice_usage SET status='settled' WHERE id=? AND status='reported'").bind(row.id).run();
}
export async function settleReportedVoiceUsage(env: Env) {
  const {results} = await env.DB.prepare("SELECT * FROM voice_usage WHERE status='reported' ORDER BY created_at LIMIT 100").all<VoiceReceipt>();
  for (const row of results) await settleVoiceReceipt(env,row);
}
export async function meteredVoiceInference<T>(env: Env, call: CallOwner, model: string, reserve: number,
  run: () => Promise<{result:T;providerMicroUsd:number;usage:Record<string,unknown>}>, allowed: () => boolean): Promise<T> {
  const id = await reserveVoiceUsage(env,call,model,reserve);
  if (!allowed()) {
    await reportVoiceUsage(env,id,0,{outcome:'canceled_before_dispatch'});
    throw new Error('call_ended');
  }
  // Provider failures/aborts with unknown usage retain their hold. Never replay.
  const {result,providerMicroUsd,usage} = await run();
  await reportVoiceUsage(env,id,providerMicroUsd,usage);
  return result;
}
