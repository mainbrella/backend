import test from 'node:test';
import assert from 'node:assert/strict';
import { paidContainerFixture, USER_ONE } from './paid-container-test-helpers';
import { buildBillingFixture } from './build-billing-test-helpers';
import { buildInference } from '../lib/build-ai';
import { BUILD_MODEL, type BuildParams } from '../lib/build-contract';
import { buildImageCostMicroUsd, buildTokenCostMicroUsd, buildInferenceChargeMicroUsd, readBuildTokenUsage } from '../lib/build-pricing';
import { settleReportedBuildUsage } from '../lib/build-billing';
import { accountBillingRequest } from '../lib/prepaid-billing';
import { buildImageDimensions } from '../lib/build-images';
import { readBuildOperation, operationExplanation } from '../lib/build-journal';
import { readFileSync } from 'node:fs';

async function fixture(t: Parameters<typeof paidContainerFixture>[0]) {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  for (const migration of ['023_build.sql', '024_build_activity.sql', '028_build_operations.sql']) f.sqlite.exec(readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8'));
  const billing = await buildBillingFixture(f.env, f.sqlite, USER_ONE);
  const params: BuildParams = { userId: USER_ONE, appId: crypto.randomUUID(), turnId: crypto.randomUUID() };
  const now = new Date().toISOString();
  f.sqlite.prepare('INSERT INTO build_apps (id,user_id,create_key,initial_prompt,name,source_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(params.appId, USER_ONE, 'create', 'Hello', 'Hello', '{}', now, now);
  f.sqlite.prepare("INSERT INTO build_turns (id,app_id,user_id,request_key,prompt,mode,base_revision,status,stage,model,created_at) VALUES(?,?,?,?,?,'build',0,'running','Building',?,?)")
    .run(params.turnId, params.appId, USER_ONE, 'turn', 'Hello', BUILD_MODEL, now);
  const infer = (operation = 'text-0') => buildInference(f.env, [{ role: 'user', content: 'Hello' }], 1024,
    undefined, params.turnId, { params, operation, model: BUILD_MODEL });
  return { ...f, ...billing, params, infer };
}
const answer = (usage: unknown, finish = 'stop') => ({ choices: [{ finish_reason: finish, message: { content: 'Hello' } }], usage });

test('Cloudflare token and image costs cover neuron pricing, cached discounts, reasoning output and 50% markup', () => {
  const usage = readBuildTokenUsage({ prompt_tokens: 100000, prompt_tokens_details: { cached_tokens: 80000 },
    completion_tokens: 20000, completion_tokens_details: { reasoning_tokens: 15000 } })!;
  assert.equal(buildTokenCostMicroUsd(BUILD_MODEL, usage), 136801);
  assert.equal(buildInferenceChargeMicroUsd(136801), 205202);
  assert.equal(buildTokenCostMicroUsd('@cf/zai-org/glm-5.3-flash', usage), 15401);
  assert.equal(buildInferenceChargeMicroUsd(15401), 23102);
  assert.equal(buildImageCostMicroUsd(1024, 1024, 4), 634);
  assert.equal(buildInferenceChargeMicroUsd(634), 951);
  assert.equal(buildImageCostMicroUsd(1025, 512, 4), 581);
  assert.throws(() => buildTokenCostMicroUsd('@cf/unpriced', usage), /build_model_unpriced/);
  for (const usage of [undefined, {}, { prompt_tokens: -1, completion_tokens: 5 },
    { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 11 } }]) assert.equal(readBuildTokenUsage(usage), null);
  assert.deepEqual(buildImageDimensions(Uint8Array.from([255,216,255,224,0,2,255,194,0,8,8,2,0,4,1,0,255,217])), { width: 1025, height: 512 });
  assert.throws(() => buildImageDimensions(Uint8Array.from([255,216,255,224,255,255])), /build_image_invalid/);
});

test('inference holds funds before the provider call and settles exact fractional credit once', async t => {
  const f = await fixture(t); let calls = 0;
  f.env.AI = { async run() {
    calls++;
    const { balance } = await accountBillingRequest(f.env, USER_ONE, '/billing/balance');
    assert.ok(balance.reservedBalanceCents > 0);
    assert.equal(balance.balanceCents, 500, 'a hold is not consumption');
    return answer({ prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 800 } });
  } } as unknown as Ai;
  const result = await f.infer();
  assert.equal(result.cachedInputTokens, 800);
  await settleReportedBuildUsage(f.env);
  await settleReportedBuildUsage(f.env);
  const history = await accountBillingRequest<any>(f.env, USER_ONE, '/billing/history');
  assert.equal(history.totals.inferenceUsedCents, 0.1394);
  assert.equal(history.totals.usedCents, 0.1394);
  assert.equal(history.totals.unattributedUsedCents, 0);
  assert.equal(history.historyTruncated, false);
  assert.equal(history.balance.reservedBalanceCents, 0);
  assert.equal(history.balance.balanceCents, 499);
  assert.equal(history.balance.monthlyUsageCents, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM accounting_ledger WHERE event_type = 'inference'").get()!.n, 1);
  await assert.rejects(f.infer(), /build_billing_reconciliation_required/);
  assert.equal(calls, 1);
});

test('a lost settlement acknowledgement retries the existing debit without another inference', async t => {
  const f = await fixture(t);
  f.env.AI = { async run() { return answer({ prompt_tokens: 1000, completion_tokens: 100 }); } } as unknown as Ai;
  await f.infer();
  const originalFetch = f.controller.fetch.bind(f.controller);
  let lose = true;
  t.mock.method(f.controller, 'fetch', async (request: Request) => {
    const body = request.method === 'POST' ? await request.clone().json() as any : null;
    const response = await originalFetch(request);
    if (lose && body?.action === 'settle') {
      lose = false; throw new Error('lost acknowledgement');
    }
    return response;
  });
  await assert.rejects(settleReportedBuildUsage(f.env), /lost acknowledgement/);
  assert.equal(f.sqlite.prepare('SELECT status FROM build_ai_usage').get()!.status, 'reported');
  await settleReportedBuildUsage(f.env);
  const history = await accountBillingRequest<any>(f.env, USER_ONE, '/billing/history');
  assert.equal(history.totals.inferenceUsedCents, 0.2762);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM accounting_ledger WHERE event_type = 'inference'").get()!.n, 1);
});

test('insufficient credit and monthly caps stop the request before Cloudflare inference', async t => {
  const f = await fixture(t); let calls = 0;
  f.env.AI = { async run() { calls++; return answer({ prompt_tokens: 1, completion_tokens: 1 }); } } as unknown as Ai;
  const state = f.stored.get('containerAccount') as any;
  state.wallet.usedInferenceMicroUsd = 5_000_000;
  f.stored.set('containerAccount', state);
  await assert.rejects(f.infer(), /insufficient_balance/);
  state.wallet.usedInferenceMicroUsd = 0;
  state.wallet.monthlyInferenceMicroUsd = { [new Date().toISOString().slice(0, 7)]: 5_000_000 };
  f.stored.set('containerAccount', state);
  await assert.rejects(f.infer('text-1'), /spend_limit_exceeded/);
  assert.equal(calls, 0);
  const blocked = await readBuildOperation(f.env, { params: f.params, id: 'text-1' });
  assert.equal(blocked!.status, 'blocked'); assert.equal(blocked!.dispatch_attempted, 0);
  assert.match(operationExplanation(blocked!)!, /Mainbrella account's monthly spending limit/);
  assert.match(operationExplanation(blocked!)!, /No request was sent to Cloudflare/);
});

test('length-limited and malformed responses still settle provider usage', async t => {
  const f = await fixture(t);
  f.env.AI = { async run() {
    return new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(answer({ prompt_tokens: 1000, completion_tokens: 1024 }, 'length'))}\n\ndata: [DONE]\n\n`));
      controller.close();
    } });
  } } as unknown as Ai;
  await assert.rejects(f.infer(), /model_response_incomplete/);
  await settleReportedBuildUsage(f.env);
  assert.equal(f.sqlite.prepare('SELECT status FROM build_ai_usage').get()!.status, 'settled');
  const history = await accountBillingRequest<any>(f.env, USER_ONE, '/billing/history');
  assert.equal(history.totals.inferenceUsedCents, 0.8859);
});

test('missing usage or a disconnected provider keeps a hold and never replays inference', async t => {
  const f = await fixture(t); let calls = 0;
  f.env.AI = { async run() { calls++; return answer(undefined); } } as unknown as Ai;
  await assert.rejects(f.infer(), /build_billing_reconciliation_required/);
  await settleReportedBuildUsage(f.env);
  const { balance } = await accountBillingRequest(f.env, USER_ONE, '/billing/balance');
  assert.equal(balance.balanceCents, 500);
  assert.ok(balance.reservedBalanceCents > 0);
  await assert.rejects(f.infer(), /build_billing_reconciliation_required/);
  assert.equal(calls, 1);
  f.env.AI = { async run() { throw new Error('disconnect'); } } as unknown as Ai;
  await assert.rejects(f.infer('text-1'), /disconnect/);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM build_ai_usage WHERE status = 'running'").get()!.n, 2);
});


test('a selected model uses its saved effort and its own token price for settlement', async t => {
  const f = await fixture(t), model = '@cf/zai-org/glm-5.3-flash';
  f.env.AI = { async run(id: string, payload: any) {
    assert.equal(id, model); assert.equal(payload.reasoning_effort, 'max');
    return answer({ prompt_tokens: 1000, completion_tokens: 100 });
  } } as unknown as Ai;
  await buildInference(f.env, [{ role: 'user', content: 'Build' }], 1024, undefined, f.params.turnId,
    { params: f.params, operation: 'selected-model', model, effort: 'max' });
  const usage = f.sqlite.prepare('SELECT model, cost_micro_usd FROM build_ai_usage WHERE turn_id = ?').get(f.params.turnId) as any;
  assert.equal(usage.model, model);
  assert.equal(usage.cost_micro_usd, buildInferenceChargeMicroUsd(buildTokenCostMicroUsd(model, { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100 })));
});
