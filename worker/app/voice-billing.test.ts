import test from 'node:test';
import assert from 'node:assert/strict';
import { paidContainerFixture, USER_ONE } from './paid-container-test-helpers';
import { voiceBillingFixture } from './voice-billing-test-helpers';
import { checkVoiceBalance, llmCost, llmReservation, meteredVoiceInference, reportVoiceUsage, reserveVoiceUsage, settleReportedVoiceUsage, sttCost, ttsCost } from '../lib/voice-billing';
import { VOICE_MODELS } from '../lib/voice';

async function fixture(t:test.TestContext) {
  const f=await paidContainerFixture(t);t.after(()=>f.close());
  const billing=await voiceBillingFixture(f.env,f.sqlite,USER_ONE);
  const call={id:crypto.randomUUID(),user_id:USER_ONE,agent_id:crypto.randomUUID(),channel:'text' as const};
  const receipts=()=>f.sqlite.prepare('SELECT * FROM voice_usage ORDER BY created_at,id').all() as any[];
  const events=()=>f.sqlite.prepare("SELECT * FROM accounting_ledger WHERE event_type='inference'").all() as any[];
  return {...f,billing,call,receipts,events};
}

test('voice uses the owner wallet and immutable ledger with provider costs plus 50%',async t=>{
  const f=await fixture(t);
  const id=await reserveVoiceUsage(f.env,f.call,VOICE_MODELS.llm,1000);
  assert.equal((f.billing.stored.get('containerAccount') as any).wallet.inference[id].reservedMicroUsd,1500);
  await reportVoiceUsage(f.env,id,100,{inputTokens:20,outputTokens:10});
  await reportVoiceUsage(f.env,id,100,{inputTokens:20,outputTokens:10});
  await settleReportedVoiceUsage(f.env);
  const state=f.billing.stored.get('containerAccount') as any;
  assert.equal(state.wallet.usedInferenceMicroUsd,150);
  assert.equal(state.wallet.inference[id].costMicroUsd,150);
  assert.equal(f.receipts()[0].status,'settled');assert.equal(f.events().length,1);
  const event=f.events()[0];const payload=JSON.parse(event.payload);
  assert.equal(event.user_id,USER_ONE);assert.equal(payload.callId,f.call.id);assert.equal(payload.agentId,f.call.agent_id);
  assert.equal(payload.service,'voice');assert.equal(payload.channel,'text');assert.equal(payload.markupPercent,50);
  assert.equal(payload.providerCostMicroUsd,100);assert.equal(payload.costMicroUsd,150);
});

test('concurrent voice reservations cannot spend the same remaining credits',async t=>{
  const f=await fixture(t);const state=f.billing.stored.get('containerAccount') as any;
  state.wallet.usedInferenceMicroUsd=4_999_000;f.billing.stored.set('containerAccount',state);
  const attempts=await Promise.allSettled([1,2,3].map(()=>reserveVoiceUsage(f.env,f.call,VOICE_MODELS.llm,500)));
  assert.equal(attempts.filter(row=>row.status==='fulfilled').length,1);
  assert.equal(attempts.filter(row=>row.status==='rejected').length,2);
  assert.equal(f.receipts().filter(row=>row.status==='denied').length,2);
  assert.equal(f.receipts().filter(row=>row.status==='running').length,1);
});

test('exact wallet checks allow fractional cents and enforce balance, spending caps and revocation',async t=>{
  const f=await fixture(t);let state=f.billing.stored.get('containerAccount') as any;
  state.wallet.usedInferenceMicroUsd=4_999_999;state.spendLimitCents=1000;f.billing.stored.set('containerAccount',state);
  await checkVoiceBalance(f.env,USER_ONE);
  state.wallet.usedInferenceMicroUsd=5_000_000;f.billing.stored.set('containerAccount',state);
  await assert.rejects(checkVoiceBalance(f.env,USER_ONE),/insufficient_balance/);
  state.wallet.usedInferenceMicroUsd=1_000_000;state.wallet.monthlyInferenceMicroUsd={[new Date().toISOString().slice(0,7)]:1_000_000};state.spendLimitCents=100;f.billing.stored.set('containerAccount',state);
  await assert.rejects(checkVoiceBalance(f.env,USER_ONE),/spend_limit_exceeded/);
  state.spendLimitCents=500;state.wallet.fundingRevoked=true;f.billing.stored.set('containerAccount',state);
  await assert.rejects(checkVoiceBalance(f.env,USER_ONE),/insufficient_balance/);
});

test('lost settlement acknowledgement replays the receipt without a second debit or ledger event',async t=>{
  const f=await fixture(t);const id=await reserveVoiceUsage(f.env,f.call,VOICE_MODELS.tts,100);
  const original=f.env.CONTAINER_ACCOUNT.get.bind(f.env.CONTAINER_ACCOUNT);let fail=true;
  f.env.CONTAINER_ACCOUNT.get=((id:DurableObjectId)=>({async fetch(request:Request){
    const input=await request.clone().json() as any;const response=await original(id).fetch(request);
    if (input.action==='settle'&&fail) {fail=false;throw new Error('lost acknowledgement');}
    return response;
  }})) as typeof f.env.CONTAINER_ACCOUNT.get;
  await assert.rejects(reportVoiceUsage(f.env,id,100,{characters:10}),/lost acknowledgement/);
  assert.equal(f.receipts()[0].status,'reported');
  await settleReportedVoiceUsage(f.env);await settleReportedVoiceUsage(f.env);
  assert.equal(f.receipts()[0].status,'settled');assert.equal(f.events().length,1);
  assert.equal((f.billing.stored.get('containerAccount') as any).wallet.usedInferenceMicroUsd,150);
});

test('provider failures retain uncertain holds and a closed call never dispatches paid inference',async t=>{
  const f=await fixture(t);let dispatched=0;
  await assert.rejects(meteredVoiceInference(f.env,f.call,VOICE_MODELS.llm,100,async()=>{
    dispatched++;throw new Error('provider failed');
  },()=>true),/provider failed/);
  await assert.rejects(meteredVoiceInference(f.env,f.call,VOICE_MODELS.llm,100,async()=>{
    dispatched++;return {result:'unused',providerMicroUsd:100,usage:{}};
  },()=>false),/call_ended/);
  assert.equal(dispatched,1);
  assert.equal(f.receipts().filter(row=>row.status==='running').length,1);
  assert.equal(f.receipts().filter(row=>row.status==='settled'&&row.cost_micro_usd===0).length,1);
});

test('voice pricing covers audio, characters and reported Llama tokens',()=>{
  assert.equal(sttCost(60_000),7700);assert.equal(ttsCost('hello'),75);
  assert.equal(llmCost({prompt_tokens:100,completion_tokens:20}),75);
  assert.throws(()=>llmCost(undefined),/voice_usage_unknown/);
  assert.ok(llmReservation([{role:'user',content:'😀'.repeat(4000)}])>llmCost({prompt_tokens:8000,completion_tokens:256}));
});
