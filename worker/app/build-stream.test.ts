import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { startCodexBridge } from '../../scripts/codex-bridge.mjs';
import { readBuildInference, buildInference, buildFirstVersionPrompt, type BuildToolCall } from '../lib/build-ai';
import { buildAppStream, saveBuildActivity, buildToolDraftLabel, buildToolLabel } from '../lib/build-activity';
import { handleBuildRequest, failBuildTurn, buildConfigured } from './build';
import { buildModels, resolveBuildModel, buildReasoningOptions } from '../lib/build-models';
import { buildTokenPrices } from '../lib/build-pricing';
import { BUILD_MODEL, BuildError, buildStarter } from '../lib/build-contract';
import { buildBillingFixture } from './build-billing-test-helpers';
import { accountBillingRequest } from '../lib/prepaid-billing';
import { PLAN_PRICES, planPrices } from '../lib/stripe';
import { runBuildAgent } from '../lib/build-agent';
import { BUILD_IMAGE_MODEL, buildImageBytes, generateBuildImage } from '../lib/build-images';
import { proposeBuildOperation, startBuildOperation, readBuildOperation, recordBuildOperation, retainBuildSource } from '../lib/build-journal';
import { paidContainerFixture, SESSION_ONE, SESSION_TWO, USER_ONE, USER_TWO, GENERATION_ONE, EXPIRES_AT } from './paid-container-test-helpers';
import { readBuildSource, storeBuildSource, buildSourceEntries } from '../lib/build-storage';

const event = (data: unknown) => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\r\n\r\n`;
const delta = (value: unknown) => event({ choices: [{ delta: value, finish_reason: null }] });
function chunks(text: string, size = 7) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({ start(controller) {
    for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
    controller.close();
  } });
}
const finished = event({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 31, completion_tokens: 24 } }) + event('[DONE]');

test('inference streams public text before completion and reassembles split UTF-8 and tool arguments', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const progress: string[] = [];
  let complete = false;
  const result = readBuildInference(stream, async text => { progress.push(text); }).then(value => { complete = true; return value; });
  controller.enqueue(new TextEncoder().encode(delta({ content: 'I’ll build ' })));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(progress, ['I’ll build ']); assert.equal(complete, false);
  const text = delta({ reasoning_content: 'private reasoning', content: 'Hello, world.' })
    + delta({ tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'write_file', arguments: '{"path":"src/App.tsx",' } }] })
    + delta({ tool_calls: [{ index: 0, function: { arguments: '"content":"Hello 🌍"}' } }] }) + finished;
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.slice(i, i + 1));
  controller.close();
  const output = await result;
  assert.equal(output.choices[0].message.content, 'I’ll build Hello, world.');
  assert.equal(output.choices[0].message.tool_calls[0].function.arguments, '{"path":"src/App.tsx","content":"Hello 🌍"}');
  assert.deepEqual(output.usage, { prompt_tokens: 31, completion_tokens: 24 });
  assert.ok(progress.every(text => !text.includes('private reasoning')));
});

test('inference uses streaming, keeps usage accounting and rejects truncated or malformed calls', async () => {
  let input: any;
  const env = { AI: { async run(_model: string, options: any) {
    input = options;
    return chunks(delta({ content: 'Hello' }) + event({ choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }) + event('[DONE]'));
  } } } as unknown as Env;
  const result = await buildInference(env, [{ role: 'user', content: 'Hello' }], 1024);
  assert.equal(input.stream, true); assert.equal(input.stream_options.include_usage, true);
  assert.equal(result.inputTokens, 3); assert.equal(result.outputTokens, 2);
  for (const text of [delta({ content: 'partial' }) + event('[DONE]'), event({ choices: [{ finish_reason: 'length' }] }) + event('[DONE]')])
    await assert.rejects(readBuildInference(chunks(text)), /model_response_incomplete/);
  await assert.rejects(readBuildInference(chunks(delta({ tool_calls: [{ index: 8 }] }) + finished)), /invalid_model_response/);
  await assert.rejects(readBuildInference(chunks(event('{invalid'))), /invalid_model_response/);
});

test('same-path write arguments emit throttled progress as content grows', async t => {
  let controller!: ReadableStreamDefaultController<Uint8Array>, now = 1_000;
  t.mock.method(Date, 'now', () => now);
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const snapshots: BuildToolCall[][] = [];
  const result = readBuildInference(stream, async (_text, calls) => { snapshots.push(structuredClone(calls)); });
  const send = async (value: string) => { controller.enqueue(new TextEncoder().encode(value)); await new Promise(resolve => setImmediate(resolve)); };
  await send(delta({ tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'write_file', arguments: '{"path":"src/App.tsx","content":"a' } }] }));
  assert.equal(snapshots.length, 1);
  now += 100;
  await send(delta({ tool_calls: [{ index: 0, function: { arguments: 'bc' } }] }));
  assert.equal(snapshots.length, 1, 'updates inside the throttle window are coalesced');
  now += 500;
  await send(delta({ tool_calls: [{ index: 0, function: { arguments: '\\nline' } }] }));
  assert.equal(snapshots.length, 2, 'same-path argument growth triggers another update');
  assert.equal(snapshots[1][0].function.arguments.length, snapshots[0][0].function.arguments.length + 8);
  controller.enqueue(new TextEncoder().encode(finished)); controller.close();
  await result;
});

test('write draft labels expose only a safe path and aggregate escaped content counts', () => {
  assert.equal(buildToolDraftLabel('write_file', '{"path":"src/App.tsx","content":"one\\ntwo\\\\nthree 🌍'),
    'Drafting src/App.tsx · 2 lines');
  assert.equal(buildToolDraftLabel('write_file', '{"path":"src/App.tsx","content":"say \\"hello\\"'),
    'Drafting src/App.tsx · 11 characters');
  assert.equal(buildToolDraftLabel('write_file', '{"path":"src/App.tsx","content":"a\\r\\n\\uD83C\\uDF0D'), 'Drafting src/App.tsx · 2 lines');
  assert.equal(buildToolDraftLabel('write_file', '{"path":"src/App.tsx","content":"\\uD83C\\uDF0D'), 'Drafting src/App.tsx · 1 characters');
  assert.equal(buildToolDraftLabel('write_file', '{"path":"src/App.tsx"'), 'Drafting src/App.tsx');
  assert.equal(buildToolDraftLabel('write_file', '{"path":"public/generated/image.jpg","content":"secret'), 'Drafting source file · 6 characters');
  assert.equal(buildToolDraftLabel('run_command', '{"command":"npm run build"}'), 'Type-check and compile');
});

test('inference stream failures retain provider codes and messages as failure details', async () => {
  for (const [error, code, details] of [
    [{ code: 'rate_limit_exceeded', message: 'The model returned HTTP 429.' }, 'build_failed', 'rate_limit_exceeded: The model returned HTTP 429.'],
    [{ code: 'build_inference_timeout', message: 'No response received in 240 seconds.' }, 'build_inference_timeout', 'No response received in 240 seconds.'],
    ['The inference service disconnected.', 'build_failed', 'The inference service disconnected.'],
  ] as const) {
    await assert.rejects(readBuildInference(chunks(event({ error }))), cause =>
      cause instanceof BuildError && cause.message === code && cause.details === details);
  }
});

async function fixture(t: Parameters<typeof paidContainerFixture>[0]) {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  f.env.DB.batch = (async (statements: D1PreparedStatement[]) => Promise.all(statements.map(statement => statement.run()))) as D1Database['batch'];
  for (const migration of ['023_build.sql', '024_build_activity.sql', '025_build_images.sql', '027_build_model_effort.sql', '028_build_operations.sql', '029_remove_build_daily_limit.sql', '030_build_git.sql']) f.sqlite.exec(readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8'));
  const billing = await buildBillingFixture(f.env, f.sqlite, USER_ONE);
  const appId = crypto.randomUUID(), turnId = crypto.randomUUID(), now = new Date().toISOString();
  f.sqlite.prepare('INSERT INTO build_apps (id,user_id,create_key,initial_prompt,name,source_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(appId, USER_ONE, 'create', 'Hello world', 'Hello world', '{}', now, now);
  f.sqlite.prepare("INSERT INTO build_turns (id,app_id,user_id,request_key,prompt,mode,base_revision,status,stage,model,created_at) VALUES(?,?,?,?,?,'build',0,'running','Building','model',?)")
    .run(turnId, appId, USER_ONE, 'turn', 'Hello world', now);
  f.sqlite.prepare('UPDATE build_apps SET active_turn_id = ? WHERE id = ?').run(turnId, appId);
  f.sqlite.prepare('UPDATE build_turns SET model = ? WHERE id = ?').run(BUILD_MODEL, turnId);
  return { ...f, ...billing, appId, turnId, params: { appId, turnId, userId: USER_ONE } };
}
function request(id: string, session = SESSION_ONE, suffix = '') {
  return new Request(`https://api.mainbrella.com/build/apps/${id}${suffix}`, { headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${session}` } });
}

const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 4, 0, 4, 0, 0, 0xff, 0xd9]);
const jpegBase64 = btoa(String.fromCharCode(...jpeg));

const immediateStep = { async do(_name: string, _options: unknown, operation: () => Promise<unknown>) { return structuredClone(await operation()); },
  async sleep() {} } as unknown as Parameters<typeof runBuildAgent>[2];

test('first builds receive a small scope and fresh starter source without restricting later edits', async t => {
  for (const [revision, edited] of [[0, false], [0, true], [1, true]] as const) await t.test(`revision ${revision}, edited ${edited}`, async sub => {
    const f = await fixture(sub); sub.mock.method(console, 'error', () => {});
    const files = { ...buildStarter, ...(edited ? { 'src/App.tsx': 'Existing user feature' } : {}) };
    f.sqlite.prepare('UPDATE build_apps SET source_json = ?, revision = ? WHERE id = ?').run(JSON.stringify(files), revision, f.appId);
    f.sqlite.prepare('UPDATE build_turns SET base_revision = ? WHERE id = ?').run(revision, f.turnId);
    let calls = 0;
    f.env.AI = { async run(_model: string, payload: any) {
      calls++;
      const system = payload.messages[0].content, context = payload.messages[1].content;
      assert.equal(system.includes(buildFirstVersionPrompt), revision === 0);
      assert.equal(context.includes('Starter source (already supplied'), !edited);
      if (!edited) assert.ok(context.includes(JSON.stringify(buildStarter)));
      assert.ok(payload.tools.some((tool: any) => tool.function.name === 'generate_image'), 'requested imagery remains available');
      throw new BuildError('build_interrupted');
    } } as unknown as Ai;
    await runBuildAgent(f.env, f.params, immediateStep, Date.now());
    assert.equal(calls, 1); assert.equal(f.accountCalls.length, 0);
    assert.deepEqual(JSON.parse(f.sqlite.prepare('SELECT source_json FROM build_apps WHERE id = ?').get(f.appId)!.source_json as string), files);
  });
});

test('a direct build tool installs dev dependencies first and returns install or compiler failures', async t => {
  for (const failure of [null, 'install', 'compile'] as const) await t.test(failure ?? 'success', async sub => {
    const f = await fixture(sub); sub.mock.method(console, 'error', () => {});
    f.sqlite.prepare('UPDATE build_apps SET source_json = ?, container_json = ? WHERE id = ?')
      .run(JSON.stringify(buildStarter), JSON.stringify({ id: 'small', createdAt: GENERATION_ONE, expiresAt: EXPIRES_AT }), f.appId);
    const commands: string[] = [], executions = new Map<string, unknown>();
    f.env.USER_CONTAINER = { idFromName: (name: string) => name, get: () => ({ async fetch(request: Request) {
      const url = new URL(request.url);
      if (url.pathname === '/files' && request.method === 'PUT') return Response.json({ saved: true });
      if (url.pathname === '/executions' && request.method === 'POST') {
        const { command } = await request.json() as { command: string }; commands.push(command);
        const failed = failure === 'install' && command.includes('npm install') || failure === 'compile' && command.includes('tsc --noEmit');
        const id = `execution-${commands.length}`, result = { id, status: failed ? 'failed' : 'succeeded', exitCode: failed ? 1 : 0,
          stdout: '', stderr: failed ? `${failure} failed` : '' };
        executions.set(id, result); return Response.json(result);
      }
      if (url.pathname.startsWith('/executions/')) return Response.json(executions.get(url.pathname.split('/').at(-1)!));
      assert.fail(`Unexpected container request: ${request.method} ${url.pathname}`);
    } }) } as unknown as DurableObjectNamespace;
    let calls = 0;
    f.env.AI = { async run(_model: string, payload: any) {
      if (calls++ === 0) return { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'build', type: 'function',
        function: { name: 'run_command', arguments: JSON.stringify({ command: 'npm run build' }) } }] } }], usage: { prompt_tokens: 5, completion_tokens: 5 } };
      assert.equal(payload.messages.at(-1).role, 'tool');
      assert.equal(payload.messages.at(-1).content, failure ? `failed\n\n${failure} failed` : 'succeeded\n\n');
      throw new BuildError('build_interrupted'); // Stop after observing the tool result.
    } } as unknown as Ai;
    await runBuildAgent(f.env, f.params, immediateStep, Date.now());
    const installIndex = commands.findIndex(command => command.includes('npm install'));
    assert.ok(installIndex >= 0); assert.match(commands[installIndex], /--include=dev/);
    const compileIndex = commands.findIndex(command => command.includes('tsc --noEmit'));
    if (failure === 'install') assert.equal(compileIndex, -1); else assert.ok(compileIndex > installIndex);
    const install = await readBuildOperation(f.env, { params: f.params, id: 'tool-0-0-install' });
    assert.equal(install!.status, failure === 'install' ? 'failed' : 'succeeded');
    const tool = await readBuildOperation(f.env, { params: f.params, id: 'tool-0-0' });
    assert.equal(tool!.status, failure ? 'failed' : 'succeeded');
  });
});

test('token exhaustion retains actual usage, explains why the build stopped and skips proposed images', async t => {
  const f = await fixture(t); let images = 0;
  t.mock.method(console, 'error', () => {});
  Object.assign(f.env, { VERSION_METADATA: { id: 'deployment-test' }, BUILD_AI_GATEWAY: 'test-gateway' });
  f.env.AI = { aiGatewayLogId: 'gateway-log-1', async run(model: string, _input: any, options: any) {
    if (model === BUILD_IMAGE_MODEL) images++;
    assert.equal(options.gateway.metadata.operationId, 'text-0');
    return chunks(delta({ content: 'I’ll build your app.' }) + delta({ tool_calls: [{ index: 0, id: 'image-proposal', type: 'function',
      function: { name: 'generate_image', arguments: '{"label":"Drone","prompt":"unfinished' } }] })
      + event({ id: 'provider-request-1', choices: [{ finish_reason: 'length' }], usage: { prompt_tokens: 500, completion_tokens: 8192 } }) + event('[DONE]'));
  } } as unknown as Ai;
  await runBuildAgent(f.env, f.params, immediateStep, Date.now());
  const data = await (await handleBuildRequest(request(f.appId), f.env)).json() as any;
  const turn = data.app.turns[0];
  assert.equal(images, 0); assert.equal(turn.outputTokens, 8192); assert.equal(turn.inputTokens, 500);
  assert.equal(turn.failureOperationId, 'text-0'); assert.match(turn.errorExplanation, /8,192 token response limit/);
  assert.equal(turn.activity.find((item: any) => item.type === 'tool').status, 'skipped');
  assert.equal(f.sqlite.prepare('SELECT status FROM build_ai_usage').get()!.status, 'settled');
  const endpoint = `/turns/${f.turnId}/diagnostics`;
  const report = await (await handleBuildRequest(request(f.appId, SESSION_ONE, endpoint), f.env)).json() as any;
  const inference = report.operations.find((op: any) => op.operation_id === 'text-0');
  assert.equal(inference.deployment_version, 'deployment-test'); assert.equal(inference.schema_version, 1);
  assert.equal(inference.evidence.finishReason, 'length'); assert.equal(inference.evidence.finishReasonSource, 'supplied');
  assert.equal(inference.evidence.doneSeen, true); assert.equal(inference.evidence.termination, 'done');
  assert.equal(inference.evidence.providerLogId, 'gateway-log-1'); assert.equal(inference.evidence.providerRequestId, 'provider-request-1');
  assert.ok(inference.evidence.byteCount > 0); assert.equal(inference.evidence.eventCount, 4);
  assert.equal(report.operations.find((op: any) => op.operation_id === 'tool-0-0').dispatch_attempted, 0);
  assert.ok(!JSON.stringify(data).includes('gateway-log-1')); assert.ok(!JSON.stringify(data).includes('usageCharge'));
  assert.equal((await handleBuildRequest(request(f.appId, SESSION_TWO, endpoint), f.env)).status, 404);
  assert.equal((await handleBuildRequest(request(f.appId, 'expired', endpoint), f.env)).status, 401);
  assert.equal((await handleBuildRequest(request(f.appId, SESSION_ONE, `/turns/${crypto.randomUUID()}/diagnostics`), f.env)).status, 404);
});

test('budget stops record the exact limit as the turn cause and explain it in diagnostics', async t => {
  const scenarios = [
    { limit: 'output-tokens', reason: /used 24,000 of 24,000 output tokens.*At least 1,024 tokens must remain/, makeAI: () => ({ calls: 0, run: async () => ({
      choices: [{ finish_reason: 'stop', message: { content: 'Working on the app.' } }], usage: { prompt_tokens: 5, completion_tokens: 24_000 } }) }) },
    { limit: 'input-tokens', reason: /used 240,000 input tokens, reaching its 240,000 token limit/, makeAI: () => ({ calls: 0, run: async () => ({
      choices: [{ finish_reason: 'stop', message: { content: 'Working on the app.' } }], usage: { prompt_tokens: 240_000, completion_tokens: 5 } }) }) },
    { limit: 'context-size', reason: /conversation reached .* bytes, above the 196,608 byte context limit/, makeAI: () => ({ calls: 0, run: async () => ({
      choices: [{ finish_reason: 'stop', message: { content: 'Working on the app.' } }], usage: { prompt_tokens: 5, completion_tokens: 5 } }) }), context: true },
    { limit: 'elapsed-time', reason: /ran for 31 minutes, above its 30 minute time limit/, makeAI: () => ({ calls: 0, run: async () => ({}) }), elapsed: true },
    { limit: 'round-limit', reason: /used all 16 repair rounds without a successful verification/, makeAI: () => {
      let round = 0;
      return { calls: 0, run: async () => { const current = round++;
        return { choices: [{ finish_reason: 'tool_calls', message: { content: 'Inspecting files.', tool_calls: [{ id: `list-${current}`, type: 'function',
          function: { name: 'list_files', arguments: '{}' } }] } }], usage: { prompt_tokens: 5, completion_tokens: 5 } }; } };
    } },
  ];
  for (const scenario of scenarios) await t.test(scenario.limit, async sub => {
    const f = await fixture(sub); t.mock.method(console, 'error', () => {});
    const ai = scenario.makeAI();
    if (scenario.context) f.sqlite.prepare('UPDATE build_apps SET initial_prompt = ? WHERE id = ?').run('x'.repeat(200_000), f.appId);
    f.env.AI = { async run(...args: any[]) { ai.calls++; return (ai.run as any).apply(ai, args); } } as unknown as Ai;
    await runBuildAgent(f.env, f.params, immediateStep, Date.now() - (scenario.elapsed ? 31 * 60_000 : 0));
    const snapshot = await (await handleBuildRequest(request(f.appId), f.env)).json() as any;
    const turn = snapshot.app.turns[0];
    assert.equal(turn.error, 'build_budget_exceeded');
    assert.equal(turn.failureOperationId, `limit-${scenario.limit}`);
    assert.match(turn.errorExplanation, scenario.reason);
    assert.ok(!JSON.stringify(snapshot).includes('evidence'));
    const report = await (await handleBuildRequest(request(f.appId, SESSION_ONE, `/turns/${f.turnId}/diagnostics`), f.env)).json() as any;
    const limit = report.operations.find((op: any) => op.operation_id === `limit-${scenario.limit}`);
    assert.equal(limit.kind, 'tool'); assert.equal(limit.status, 'blocked'); assert.match(limit.evidence.reason, scenario.reason);
    assert.equal(limit.evidence.limitName, scenario.limit); assert.equal(typeof limit.evidence.limit, 'number'); assert.equal(typeof limit.evidence.observed, 'number');
    assert.equal(limit.explanation, limit.evidence.reason); assert.equal(report.errorExplanation, limit.explanation);
    assert.equal(report.failureOperationId, limit.operation_id);
    if (scenario.elapsed || scenario.context) assert.equal(ai.calls, 0);
    if (scenario.limit === 'round-limit') assert.equal(ai.calls, 16);
  });
});

test('EOF, missing finish reasons and read exceptions retain distinct stream evidence', async () => {
  for (const [text, expected, reject] of [
    [delta({ content: 'partial' }), 'eof', true],
    [delta({ content: 'complete' }) + event({ choices: [{ finish_reason: 'stop' }] }), 'eof', false],
    [delta({ content: 'partial' }) + event('[DONE]'), 'done', true],
  ] as const) {
    let evidence: any;
    const result = readBuildInference(chunks(text), undefined, undefined, async value => { evidence = value; });
    if (reject) await assert.rejects(result, /model_response_incomplete/); else await result;
    assert.equal(evidence.termination, expected); assert.equal(evidence.doneSeen, expected === 'done');
    assert.equal(evidence.usage, null); assert.equal(evidence.finishReason, reject ? null : 'stop');
  }
  let evidence: any, reads = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) {
    if (reads++ === 0) controller.enqueue(new TextEncoder().encode(delta({ content: 'partial' }) + 'data: incomplete'));
    else controller.error(new Error('connection lost'));
  } });
  await assert.rejects(readBuildInference(stream, undefined, undefined, async value => { evidence = value; }), /connection lost/);
  assert.equal(evidence.termination, 'read_exception'); assert.equal(evidence.doneSeen, false);
  assert.equal(evidence.bufferedBytes, 'data: incomplete'.length);
});

test('provider errors survive usage callback failures and optional display failures do not abort parsing', async () => {
  const stream = chunks(event({ usage: { prompt_tokens: 5, completion_tokens: 8 } }) + event({ error: { code: 'rate_limit_exceeded', message: 'HTTP 429' } }));
  await assert.rejects(readBuildInference(stream, undefined, async () => { throw new Error('usage write failed'); }), error =>
    error instanceof BuildError && error.providerCode === 'rate_limit_exceeded' && error.details === 'rate_limit_exceeded: HTTP 429');
  const result = await readBuildInference(chunks(delta({ content: 'Hello' }) + event({ choices: [{ finish_reason: 'stop' }] }) + event('[DONE]')),
    async () => { throw new Error('display unavailable'); });
  assert.equal(result.choices[0].message.content, 'Hello');
});

test('duplicate operation claims and lost completion records never replay paid inference', async t => {
  const f = await fixture(t); let calls = 0;
  const ref = { params: f.params, id: 'duplicate' };
  await proposeBuildOperation(f.env, ref, 'text', 'Model response');
  const claims = await Promise.allSettled([startBuildOperation(f.env, ref, 'text', 'Model response'), startBuildOperation(f.env, ref, 'text', 'Model response')]);
  assert.equal(claims.filter(result => result.status === 'fulfilled').length, 1);
  const prepare = f.env.DB.prepare.bind(f.env.DB);
  t.mock.method(f.env.DB, 'prepare', (sql: string) => {
    const statement = prepare(sql);
    if (!sql.startsWith('UPDATE build_operations SET status = COALESCE')) return statement;
    return { bind(...args: unknown[]) {
      const bound = statement.bind(...args);
      if (args[0] !== 'succeeded' || !args.includes('text-0')) return bound;
      return { ...bound, async run() { throw new Error('process lost before completion write'); } };
    } } as D1PreparedStatement;
  });
  f.env.AI = { async run() { calls++; return { choices: [{ finish_reason: 'stop', message: { content: 'Hello' } }], usage: { prompt_tokens: 5, completion_tokens: 8 } }; } } as unknown as Ai;
  const infer = () => buildInference(f.env, [{ role: 'user', content: 'Hello' }], 1024, undefined, f.turnId,
    { params: f.params, operation: 'text-0', model: BUILD_MODEL });
  await assert.rejects(infer(), /build_journal_unavailable/);
  const operation = await readBuildOperation(f.env, { params: f.params, id: 'text-0' });
  assert.equal(operation!.status, 'unknown'); assert.equal(operation!.dispatch_attempted, 1); assert.equal(operation!.result_json, null);
  await assert.rejects(infer(), /build_billing_reconciliation_required/); assert.equal(calls, 1);
});

test('source snapshots stay immutable when later working source changes', async t => {
  const f = await fixture(t), ref = { params: f.params, id: 'compile-2' };
  await startBuildOperation(f.env, ref, 'command', 'Check the build', { command: 'tsc --noEmit', containerGeneration: GENERATION_ONE });
  await retainBuildSource(f.env, ref, { 'src/App.tsx': 'failed source' });
  await recordBuildOperation(f.env, ref, { status: 'failed', finished: true, evidence: { exitCode: 2, stdout: '', stderr: 'TS2322' } });
  f.sqlite.prepare('UPDATE build_apps SET source_json = ? WHERE id = ?').run(JSON.stringify({ 'src/App.tsx': 'fixed source' }), f.appId);
  const report = await (await handleBuildRequest(request(f.appId, SESSION_ONE, `/turns/${f.turnId}/diagnostics`), f.env)).json() as any;
  const command = report.operations[0];
  assert.deepEqual(command.source, { 'src/App.tsx': 'failed source' }); assert.match(command.evidence.sourceDigest, /^[a-f0-9]{64}$/);
  assert.equal(command.evidence.exitCode, 2); assert.equal(command.evidence.stderr, 'TS2322');
});

test('provider rejection stays the turn cause when usage storage and settlement also fail', async t => {
  const f = await fixture(t); t.mock.method(console, 'error', () => {});
  const prepare = f.env.DB.prepare.bind(f.env.DB); let unavailable = true, calls = 0;
  t.mock.method(f.env.DB, 'prepare', (sql: string) => {
    const statement = prepare(sql);
    if (!unavailable || !sql.includes("SET status = 'reported', cost_micro_usd")) return statement;
    return { bind(...args: unknown[]) { statement.bind(...args); return { async run() { throw new Error('usage storage unavailable'); } }; } } as unknown as D1PreparedStatement;
  });
  f.env.AI = { async run() { calls++; return chunks(event({ usage: { prompt_tokens: 100, completion_tokens: 50 } })
    + event({ error: { code: 'rate_limit_exceeded', message: 'private provider details' } })); } } as unknown as Ai;
  await runBuildAgent(f.env, f.params, immediateStep, Date.now());
  const data = await (await handleBuildRequest(request(f.appId), f.env)).json() as any;
  assert.equal(data.app.turns[0].failureOperationId, 'text-0'); assert.match(data.app.turns[0].errorExplanation, /provider rejected.*rate_limit_exceeded/);
  assert.equal(data.app.turns[0].outputTokens, 50); assert.ok(!JSON.stringify(data).includes('private provider details')); assert.equal(calls, 1);
  const inference = await readBuildOperation(f.env, { params: f.params, id: 'text-0' });
  assert.equal(JSON.parse(inference!.result_json!).failure.providerCode, 'rate_limit_exceeded');
  const persistence = await readBuildOperation(f.env, { params: f.params, id: 'usage-text-0' });
  assert.match(JSON.parse(persistence!.result_json!).failure.details, /usage storage unavailable/);
  unavailable = false;
  const fetch = f.controller.fetch.bind(f.controller); let settlementUnavailable = true;
  t.mock.method(f.controller, 'fetch', async (request: Request) => {
    const body = request.method === 'POST' ? await request.clone().json() as any : null;
    if (settlementUnavailable && body?.action === 'settle') throw new Error('settlement unavailable');
    return fetch(request);
  });
  const { settleReportedBuildUsage } = await import('../lib/build-billing');
  await assert.rejects(settleReportedBuildUsage(f.env, f.turnId), /settlement unavailable/);
  assert.equal((await readBuildOperation(f.env, { params: f.params, id: 'settle-text-0' }))!.status, 'unknown');
  settlementUnavailable = false; await settleReportedBuildUsage(f.env, f.turnId);
  assert.equal(f.sqlite.prepare('SELECT status FROM build_ai_usage').get()!.status, 'settled'); assert.equal(calls, 1);
  assert.equal(f.sqlite.prepare('SELECT failure_operation_id FROM build_turns WHERE id = ?').get(f.turnId)!.failure_operation_id, 'text-0');
});

test('original images are generated once, streamed as metadata, ownership-checked and exported as portable JPEGs', async t => {
  const f = await fixture(t); let calls = 0;
  f.env.AI = { async run(model: string, input: any) {
    calls++; assert.equal(model, BUILD_IMAGE_MODEL); assert.equal(input.steps, 4);
    assert.match(input.prompt, /moody forest/); return { image: jpegBase64 };
  } } as unknown as Ai;
  const image = await generateBuildImage(f.env, f.params, 'tool-0-0', 'Forest canopy', 'An original moody forest with ancient trees.');
  assert.deepEqual(await generateBuildImage(f.env, f.params, 'tool-0-0', 'Forest canopy', 'An original moody forest with ancient trees.'), image);
  assert.equal(calls, 1, 'replayed workflow steps reuse the stored asset');
  const storedImage = f.sqlite.prepare('SELECT data FROM build_images WHERE id = ?').get(image.id)!.data as string;
  const imageRef = JSON.parse(storedImage);
  assert.ok(imageRef.$r2); assert.ok(!storedImage.includes(jpegBase64));
  assert.deepEqual(f.storage.objects.get(imageRef.$r2), jpeg, 'D1 holds a reference to the original R2 bytes');
  const data = await (await handleBuildRequest(request(f.appId), f.env)).json() as any;
  assert.deepEqual(data.app.turns[0].images, [image]);
  assert.ok(!JSON.stringify(data).includes(jpegBase64), 'image bytes never bloat SSE snapshots');
  const suffix = `/images/${image.id}`;
  const response = await handleBuildRequest(request(f.appId, SESSION_ONE, suffix), f.env);
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), jpeg);
  assert.equal((await handleBuildRequest(request(f.appId, SESSION_TWO, suffix), f.env)).status, 404);
  assert.equal((await handleBuildRequest(request(f.appId, 'expired', suffix), f.env)).status, 401);
  assert.equal((await handleBuildRequest(request(f.appId, SESSION_ONE, `/images/${crypto.randomUUID()}`), f.env)).status, 404);
  const exported = new Uint8Array(await (await handleBuildRequest(request(f.appId, SESSION_ONE, '/export'), f.env)).arrayBuffer());
  const view = new DataView(exported.buffer), nameLength = view.getUint16(26, true);
  assert.equal(new TextDecoder().decode(exported.slice(30, 30 + nameLength)), `public${image.path}`);
  assert.deepEqual(exported.slice(30 + nameLength, 30 + nameLength + jpeg.length), jpeg);
  f.sqlite.prepare('DELETE FROM build_apps WHERE id = ?').run(f.appId);
  assert.equal((f.sqlite.prepare('SELECT COUNT(*) AS count FROM build_images').get() as any).count, 0);
});

test('file listing reads only the manifest and opening a file streams one R2 object, including files larger than a D1 row', async t => {
  const f = await fixture(t), large = 'a'.repeat(3 * 1024 * 1024), small = '<script>private source</script>';
  const stored = await storeBuildSource(f.env, f.params, { 'src/large.txt': large, 'src/small.ts': small });
  f.sqlite.prepare('UPDATE build_apps SET source_json = ? WHERE id = ?').run(stored, f.appId);
  assert.ok(stored.length < 512, 'the database record is independent of file size');
  const manifestKey = JSON.parse(stored).$r2;
  f.storage.reads.length = 0;
  const listed = await (await handleBuildRequest(request(f.appId, SESSION_ONE, '/files'), f.env)).json() as any;
  assert.deepEqual(listed.files, [{ path: 'src/large.txt', size: large.length, type: 'text' }, { path: 'src/small.ts', size: small.length, type: 'text' }]);
  assert.deepEqual(f.storage.reads.map(read => read.key), [manifestKey]);
  const response = await handleBuildRequest(request(f.appId, SESSION_ONE, '/file?path=src%2Flarge.txt'), f.env);
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(await response.text(), large);
  const entries = JSON.parse(new TextDecoder().decode(f.storage.objects.get(manifestKey)!)).files;
  assert.deepEqual(f.storage.reads.map(read => read.key), [manifestKey, manifestKey, entries[0].$r2]);
  assert.equal(f.storage.reads.at(-1)!.buffered, false); assert.equal(f.storage.reads.at(-1)!.streamed, true);
  for (const suffix of ['/files', '/file?path=src%2Fsmall.ts']) {
    assert.equal((await handleBuildRequest(request(f.appId, SESSION_TWO, suffix), f.env)).status, 404);
    assert.equal((await handleBuildRequest(request(f.appId, 'expired', suffix), f.env)).status, 401);
  }
  for (const suffix of ['/file?path=..%2Fsecret', '/file?path=missing.ts'])
    assert.equal((await handleBuildRequest(request(f.appId, SESSION_ONE, suffix), f.env)).status, 404);
  for (const suffix of ['/file', '/file?path=src%2Fsmall.ts&path=src%2Flarge.txt', '/files?key=other-object', '/files?versionId=invalid'])
    assert.equal((await handleBuildRequest(request(f.appId, SESSION_ONE, suffix), f.env)).status, 400);
  assert.equal((await handleBuildRequest(request(f.appId, SESSION_ONE, `/files?versionId=${crypto.randomUUID()}`), f.env)).status, 404);
  assert.equal((await handleBuildRequest(request(f.appId, SESSION_ONE, `/file?path=src%2Fsmall.ts&versionId=${crypto.randomUUID()}`), f.env)).status, 404);
  f.storage.objects.delete(entries[0].$r2);
  assert.equal((await handleBuildRequest(request(f.appId, SESSION_ONE, '/file?path=src%2Flarge.txt'), f.env)).status, 503);
});

test('R2 source objects deduplicate across snapshots, enforce owner scope and never fall back to inline D1 storage', async t => {
  const f = await fixture(t), files = { 'src/App.tsx': 'original source', 'src/style.css': 'body {}' };
  const first = await storeBuildSource(f.env, f.params, files), count = f.storage.objects.size;
  assert.equal(await storeBuildSource(f.env, f.params, files), first);
  assert.equal(f.storage.objects.size, count);
  const next = await storeBuildSource(f.env, f.params, { ...files, 'src/App.tsx': 'changed source' });
  assert.equal(f.storage.objects.size, count + 2, 'one changed file and one manifest; unchanged file bytes are shared');
  assert.equal((await readBuildSource(f.env, f.params, first))['src/App.tsx'], 'original source');
  assert.equal((await readBuildSource(f.env, f.params, next))['src/App.tsx'], 'changed source');
  await assert.rejects(readBuildSource(f.env, { ...f.params, userId: USER_TWO }, first), /build_source_unavailable/);
  const entry = (await buildSourceEntries(f.env, f.params, next))[0];
  f.storage.objects.set(entry.$r2, new TextEncoder().encode('corrupt source'));
  await assert.rejects(readBuildSource(f.env, f.params, next), /build_source_unavailable/);
  Reflect.deleteProperty(f.env, 'BUCKET');
  assert.equal(buildConfigured(f.env), false);
  await assert.rejects(storeBuildSource(f.env, f.params, files), /build_source_unavailable/);
});

test('image generation rejects invalid output, enforces asset budgets and checks active ownership', async t => {
  const f = await fixture(t); let output: string | undefined = 'not an image', calls = 0;
  f.env.AI = { async run() { calls++; return { image: output }; } } as unknown as Ai;
  await assert.rejects(generateBuildImage(f.env, { ...f.params, userId: USER_TWO }, 'one', 'Tree', 'Tree'), /build_interrupted/);
  assert.equal(calls, 0);
  for (output of [undefined, 'not an image', btoa('not a JPEG')]) {
    await assert.rejects(generateBuildImage(f.env, f.params, `bad-${calls}`, 'Tree', 'Tree'), /build_image_invalid/);
  }
  assert.throws(() => buildImageBytes('a'.repeat(1_400_001)), /build_image_invalid/);
  output = jpegBase64;
  for (let i = 0; i < 4; i++) await generateBuildImage(f.env, f.params, `image-${i}`, 'Tree', 'Tree');
  const before = calls;
  await assert.rejects(generateBuildImage(f.env, f.params, 'image-5', 'Tree', 'Tree'), /build_image_limit/);
  assert.equal(calls, before);
  await failBuildTurn(f.env, { id: f.turnId, app_id: f.appId, user_id: USER_ONE }, 'build_interrupted');
  await assert.rejects(generateBuildImage(f.env, f.params, 'image-0', 'Tree', 'Tree'), /build_interrupted/);
});

test('the builder generates and exposes an original image before writing code or allocating compute', async t => {
  const f = await fixture(t); f.setAccountStatus(503); t.mock.method(console, 'error', () => {});
  const sequence: string[] = [];
  f.env.AI = { async run(model: string, input: any) {
    if (model === BUILD_IMAGE_MODEL) { sequence.push('image'); assert.equal(f.accountCalls.length, 0); return { image: jpegBase64 }; }
    assert.ok(input.tools.some((tool: any) => tool.function.name === 'generate_image'));
    const round = sequence.filter(item => item.startsWith('model')).length; sequence.push(`model-${round}`);
    const call = round === 0 ? { name: 'generate_image', arguments: JSON.stringify({ label: 'Moody forest', prompt: 'Ancient trees in a moody forest' }) }
      : round === 1 ? { name: 'write_file', arguments: JSON.stringify({ path: 'src/App.tsx', content: 'export default function App() { return <h1>Forest</h1> }' }) } : null;
    if (round === 1) {
      const data = await (await handleBuildRequest(request(f.appId), f.env)).json() as any;
      assert.equal(data.app.turns[0].images.length, 1, 'the UI can fetch the image while coding starts');
      assert.match(input.messages.at(-1).content, /\/generated\//);
    }
    return { choices: [{ finish_reason: call ? 'tool_calls' : 'stop', message: { content: 'Building your forest app.',
      ...(call ? { tool_calls: [{ id: `call-${round}`, type: 'function', function: call }] } : {}) } }], usage: { prompt_tokens: 3, completion_tokens: 2 } };
  } } as unknown as Ai;
  const step = { async do(_name: string, _options: unknown, operation: () => Promise<unknown>) { return operation(); }, async sleep() {} } as unknown as Parameters<typeof runBuildAgent>[2];
  await runBuildAgent(f.env, f.params, step, Date.now());
  assert.deepEqual(sequence, ['model-0', 'image', 'model-1', 'model-2']);
  const data = await (await handleBuildRequest(request(f.appId), f.env)).json() as any;
  assert.equal(data.app.turns[0].images.length, 1, 'the image survives a later sandbox failure');
  assert.equal(data.app.turns[0].activity.find((item: any) => item.text === 'Generate Moody forest').status, 'succeeded');
});

test('a failed image request gives the model a recovery message and still saves app code', async t => {
  const f = await fixture(t); f.setAccountStatus(503); t.mock.method(console, 'error', () => {});
  let round = 0;
  f.env.AI = { async run(model: string, input: any) {
    if (model === BUILD_IMAGE_MODEL) throw new Error('private provider diagnostic');
    const current = round++;
    if (current === 1) {
      assert.match(input.messages.at(-1).content, /Continue building with CSS/);
      assert.doesNotMatch(input.messages.at(-1).content, /private provider diagnostic/);
    }
    const call = current === 0 ? { name: 'generate_image', arguments: JSON.stringify({ label: 'Forest', prompt: 'Ancient forest' }) }
      : current === 1 ? { name: 'write_file', arguments: JSON.stringify({ path: 'src/App.tsx', content: 'export default function App() { return <h1>Forest guide</h1> }' }) } : null;
    return { choices: [{ finish_reason: call ? 'tool_calls' : 'stop', message: { content: 'Building your guide.',
      ...(call ? { tool_calls: [{ id: `call-${current}`, type: 'function', function: call }] } : {}) } }], usage: { prompt_tokens: 3, completion_tokens: 2 } };
  } } as unknown as Ai;
  const step = { async do(_name: string, _options: unknown, operation: () => Promise<unknown>) { return operation(); }, async sleep() {} } as unknown as Parameters<typeof runBuildAgent>[2];
  await runBuildAgent(f.env, f.params, step, Date.now());
  const data = await (await handleBuildRequest(request(f.appId), f.env)).json() as any;
  assert.equal(data.app.turns[0].activity.find((item: any) => item.text === 'Generate Forest').status, 'unknown');
  assert.equal(data.app.turns[0].images.length, 0);
  const source = await (await handleBuildRequest(request(f.appId, SESSION_ONE, '/source'), f.env)).json() as any;
  assert.match(source.files['src/App.tsx'], /Forest guide/);
});

test('durable activity replaces partial messages, preserves order and respects ownership', async t => {
  const f = await fixture(t);
  await saveBuildActivity(f.env, f.params, 1, { id: 'tool-0', type: 'tool', text: 'Write src/App.tsx', status: 'running' });
  await saveBuildActivity(f.env, f.params, 0, { id: 'ai-0', type: 'message', text: 'I’ll', status: 'running' });
  await saveBuildActivity(f.env, f.params, 0, { id: 'ai-0', type: 'message', text: 'I’ll build your app.', status: 'succeeded' });
  await saveBuildActivity(f.env, { ...f.params, userId: 'other-owner' }, 0, { id: 'ai-0', type: 'message', text: 'Overwrite', status: 'running' });
  const data = await (await handleBuildRequest(request(f.appId), f.env)).json() as any;
  assert.deepEqual(data.app.turns[0].activity.map((item: any) => item.text), ['I’ll build your app.', 'Write src/App.tsx']);
  assert.equal((await handleBuildRequest(request(f.appId, SESSION_TWO, '/events'), f.env)).status, 404);
  assert.equal((await handleBuildRequest(request(f.appId, 'expired', '/events'), f.env)).status, 401);
  await failBuildTurn(f.env, { id: f.turnId, app_id: f.appId, user_id: USER_ONE }, 'build_failed');
  const response = await handleBuildRequest(request(f.appId, SESSION_ONE, '/events'), f.env);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
  const text = await response.text();
  assert.match(text, /event: app/); assert.match(text, /I’ll build your app/);
  assert.match(text, /"text":"Write src\/App.tsx","status":"unknown"/);
  f.sqlite.prepare('DELETE FROM build_apps WHERE id = ?').run(f.appId);
  assert.equal((f.sqlite.prepare('SELECT COUNT(*) AS count FROM build_activity').get() as any).count, 0);
});

test('public build snapshots show draft progress without file contents or private reasoning', async t => {
  const f = await fixture(t); f.setAccountStatus(503);
  Object.assign(f.env, { VERSION_METADATA: { id: 'deployment-test' }, BUILD_AI_GATEWAY: 'test-gateway' });
  t.mock.method(console, 'error', () => {});
  let controller!: ReadableStreamDefaultController<Uint8Array>, calls = 0, resolveStream!: () => void;
  const streamReady = new Promise<void>(resolve => { resolveStream = resolve; });
  const source = 'export const marker = "PRIVATE_SOURCE_BODY";';
  const serialized = JSON.stringify({ path: 'src/App.tsx', content: source });
  const splitAt = serialized.indexOf('PRIVATE_SOURCE_BODY') + 8;
  f.env.AI = { async run() {
    if (calls++ === 0) return new ReadableStream<Uint8Array>({ start(value) { controller = value; resolveStream(); } });
    return { choices: [{ finish_reason: 'stop', message: { content: 'The app is ready for a build check.' } }], usage: { prompt_tokens: 8, completion_tokens: 5 } };
  } } as unknown as Ai;
  const running = runBuildAgent(f.env, f.params, immediateStep, Date.now());
  await streamReady;
  controller.enqueue(new TextEncoder().encode(delta({ reasoning_content: 'PRIVATE_REASONING', content: 'Building the page.',
    tool_calls: [{ index: 0, id: 'write-1', type: 'function', function: { name: 'write_file', arguments: serialized.slice(0, splitAt) } }] })));
  for (let attempt = 0; attempt < 50 && !f.sqlite.prepare("SELECT id FROM build_activity WHERE turn_id = ? AND id = 'tool-0-0'").get(f.turnId); attempt++)
    await new Promise(resolve => setTimeout(resolve, 2));
  const during = await (await handleBuildRequest(request(f.appId), f.env)).json() as any;
  const draft = during.app.turns[0].activity.find((item: any) => item.type === 'tool');
  assert.match(draft.text, /^Drafting src\/App\.tsx · \d+ characters$/);
  assert.equal(draft.status, 'proposed');
  assert.ok(!JSON.stringify(during).includes('PRIVATE_SOURCE_BODY'));
  assert.ok(!JSON.stringify(during).includes('PRIVATE_REASONING'));
  assert.deepEqual(JSON.parse((f.sqlite.prepare('SELECT source_json FROM build_apps WHERE id = ?').get(f.appId) as { source_json: string }).source_json), {});

  controller.enqueue(new TextEncoder().encode(delta({ tool_calls: [{ index: 0, function: { arguments: serialized.slice(splitAt) } }] })
    + event({ choices: [{ finish_reason: 'tool_calls' }], usage: { prompt_tokens: 8, completion_tokens: 5 } }) + event('[DONE]')));
  controller.close();
  await running;
  const after = await (await handleBuildRequest(request(f.appId), f.env)).json() as any;
  const completed = after.app.turns[0].activity.find((item: any) => item.type === 'tool');
  assert.equal(completed.text, 'Write src/App.tsx');
  assert.equal(completed.status, 'succeeded');
  const saved = (f.sqlite.prepare('SELECT source_json FROM build_apps WHERE id = ?').get(f.appId) as { source_json: string }).source_json;
  assert.equal((await readBuildSource(f.env, f.params, saved))['src/App.tsx'], source);
  assert.ok(!saved.includes('PRIVATE_SOURCE_BODY'));
  for (const row of f.sqlite.prepare('SELECT source_json, result_json, evidence_json FROM build_operations WHERE turn_id = ?').all(f.turnId))
    assert.ok(!JSON.stringify(row).includes('PRIVATE_SOURCE_BODY'), 'file bodies and provider tool arguments live in R2');
});

test('an interrupted partial write stays a draft and never saves its file contents', async t => {
  const f = await fixture(t); t.mock.method(console, 'error', () => {});
  Object.assign(f.env, { VERSION_METADATA: { id: 'deployment-test' }, BUILD_AI_GATEWAY: 'test-gateway' });
  let controller!: ReadableStreamDefaultController<Uint8Array>, resolveStream!: () => void;
  const streamReady = new Promise<void>(resolve => { resolveStream = resolve; });
  const privateContent = 'PRIVATE_UNSAVED_SOURCE';
  f.env.AI = { async run() { return new ReadableStream<Uint8Array>({ start(value) { controller = value; resolveStream(); } }); } } as unknown as Ai;
  const running = runBuildAgent(f.env, f.params, immediateStep, Date.now());
  await streamReady;
  controller.enqueue(new TextEncoder().encode(delta({ reasoning_content: 'PRIVATE_REASONING', tool_calls: [{ index: 0, id: 'write-1', type: 'function',
    function: { name: 'write_file', arguments: `{"path":"src/App.tsx","content":"${privateContent}` } }] })));
  for (let attempt = 0; attempt < 50 && !f.sqlite.prepare("SELECT id FROM build_activity WHERE turn_id = ? AND id = 'tool-0-0'").get(f.turnId); attempt++)
    await new Promise(resolve => setTimeout(resolve, 2));
  const during = await (await handleBuildRequest(request(f.appId), f.env)).json() as any;
  assert.match(during.app.turns[0].activity[0].text, /^Drafting src\/App\.tsx · \d+ characters$/);
  assert.ok(!JSON.stringify(during).includes(privateContent));
  assert.ok(!JSON.stringify(during).includes('PRIVATE_REASONING'));
  controller.error(new Error('stream disconnected'));
  await running;
  const after = await (await handleBuildRequest(request(f.appId), f.env)).json() as any;
  assert.equal(after.app.turns[0].activity[0].status, 'skipped');
  assert.match(after.app.turns[0].activity[0].text, /^Drafting src\/App\.tsx/);
  assert.deepEqual(JSON.parse((f.sqlite.prepare('SELECT source_json FROM build_apps WHERE id = ?').get(f.appId) as { source_json: string }).source_json), {});
  assert.ok(!JSON.stringify(after).includes(privateContent));
  assert.ok(!JSON.stringify(after).includes('PRIVATE_REASONING'));
});

test('disconnecting the progress stream stops snapshot reads', async () => {
  let reads = 0;
  const response = buildAppStream(new Request('https://api.test'), async () => { reads++; return { app: { activeTurnId: 'turn' } }; }, {});
  const reader = response.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: app/);
  await reader.cancel();
  assert.equal(reads, 1);
  assert.equal(buildToolLabel('write_file', '{"path":"src/App.tsx","content":"partial'), 'Write src/App.tsx');
  assert.equal(buildToolLabel('run_command', '{"command":"npm run build"}'), 'Type-check and compile');
});

test('the agent streams and saves edits before allocating a sandbox, including file deletion', async t => {
  const f = await fixture(t);
  f.sqlite.prepare('UPDATE build_apps SET source_json = ? WHERE id = ?').run(JSON.stringify({ 'src/old.tsx': 'old content' }), f.appId);
  f.setAccountStatus(503);
  t.mock.method(console, 'error', () => {});
  const steps: string[] = [];
  const outputs = [
    { content: 'I’ll create a simple Hello, world app.', name: 'delete_file', args: { path: 'src/old.tsx' } },
    { content: 'Adding your greeting.', name: 'write_file', args: { path: 'src/App.tsx', content: 'export default function App() { return <h1>Hello, world!</h1>; }' } },
    { content: 'Your app is ready for a build check.' },
  ];
  let calls = 0;
  f.env.AI = { async run() {
    const output = outputs[calls++];
    assert.equal(f.accountCalls.length, 0, 'model feedback starts before any container request');
    return chunks(delta({ content: output.content })
      + (output.name ? delta({ tool_calls: [{ index: 0, id: `call-${calls}`, type: 'function', function: { name: output.name, arguments: JSON.stringify(output.args) } }] }) : '')
      + event({ choices: [{ finish_reason: output.name ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }) + event('[DONE]'));
  } } as unknown as Ai;
  const step = { async do(name: string, _options: unknown, operation: () => Promise<unknown>) { steps.push(name); return operation(); },
    async sleep() { assert.fail('no sandbox commands should start'); } } as unknown as Parameters<typeof runBuildAgent>[2];
  await runBuildAgent(f.env, f.params, step, Date.now());
  assert.equal(calls, 3);
  assert.ok(steps.indexOf('AI 2') < steps.indexOf('Allocate sandbox'));
  const data = await (await handleBuildRequest(request(f.appId), f.env)).json() as any;
  assert.equal(data.app.turns[0].status, 'failed');
  assert.equal(data.app.turns[0].activity.length, 5);
  assert.ok(data.app.turns[0].activity.every((item: any) => item.status === 'succeeded'));
  const source = await (await handleBuildRequest(request(f.appId, SESSION_ONE, '/source'), f.env)).json() as any;
  assert.deepEqual(source.files, { 'src/App.tsx': outputs[1].args!.content });
});

test('local Codex runs through the existing source, command, compiler repair and preview workflow', async t => {
  const realFetch = globalThis.fetch;
  const bridge = await startCodexBridge({ spawnProcess(_executable, args, options) {
    return spawn(process.execPath, [fileURLToPath(new URL('../../scripts/fixtures/codex-app-server.mjs', import.meta.url)), ...args], options);
  } });
  t.after(() => bridge.close());
  const f = await fixture(t), billingFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname === '127.0.0.1') return realFetch(input, options);
    const response = await billingFetch(input, options);
    return new Response((await response.text()).replaceAll(PLAN_PRICES.builder, planPrices(f.env).builder),
      { status: response.status, headers: response.headers });
  });
  Object.assign(f.env, { LOCAL_DEV: 'true', BUILD_ENABLED: 'true', BUILD_MODEL: bridge.model,
    BUILD_CODEX_URL: bridge.url, BUILD_CODEX_TOKEN: bridge.token, PREVIEWS_ENABLED: 'true', BUILD_WORKFLOW: {} });
  f.env.AI = undefined as unknown as Ai;
  const savedImageId = crypto.randomUUID();
  f.sqlite.prepare('INSERT INTO build_images (id,app_id,turn_id,tool_id,label,prompt,data) VALUES (?,?,?,?,?,?,?)')
    .run(savedImageId, f.appId, f.turnId, 'existing-image', 'Forest', 'Original forest', jpegBase64);
  const files = { ...buildStarter, 'src/old.ts': 'old' };
  f.sqlite.prepare('UPDATE build_apps SET source_json = ?, container_json = ? WHERE id = ?')
    .run(JSON.stringify(files), JSON.stringify({ id: 'small', createdAt: GENERATION_ONE, expiresAt: EXPIRES_AT }), f.appId);
  f.sqlite.exec(readFileSync(new URL('../../preview-migrations/001_preview_routes.sql', import.meta.url), 'utf8'));
  f.env.PREVIEW_ROUTES = { prepare(sql: string) {
    const statement = f.env.DB.prepare(sql), run = statement.run.bind(statement);
    statement.run = (async () => ({ ...await run(), success: true })) as typeof statement.run;
    return statement;
  } } as D1Database;
  const commands: string[] = [], guestFiles = new Map<string, string>();
  const disk = mkdtempSync(join(tmpdir(), 'mainbrella-codex-git-'));
  t.after(() => rmSync(disk, { recursive: true, force: true }));
  const localPath = (path: string) => join(disk, path.replace(/^\/workspace\//, ''));
  const guestImages = new Map<string, Uint8Array>();
  const executions = new Map<string, { id: string; status: string; stdout: string; stderr: string }>();
  let compiles = 0;
  f.env.USER_CONTAINER = { idFromName: (name: string) => name, get: () => ({ async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === '/files' && request.method === 'PUT') {
      const path = url.searchParams.get('path')!;
      let bytes = new Uint8Array(await request.arrayBuffer());
      if (path.endsWith('.jpg')) guestImages.set(path, bytes);
      else guestFiles.set(path, new TextDecoder().decode(bytes));
      if (path.endsWith('/mainbrella-git/input.json')) {
        const input = JSON.parse(new TextDecoder().decode(bytes)); input.worktree = localPath(input.worktree);
        bytes = new TextEncoder().encode(JSON.stringify(input));
      }
      mkdirSync(dirname(localPath(path)), { recursive: true }); writeFileSync(localPath(path), bytes);
      return Response.json({ saved: true });
    }
    if (url.pathname === '/files' && request.method === 'GET') {
      try { return new Response(new Uint8Array(readFileSync(localPath(url.searchParams.get('path')!)))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Response(null, { status: 404 }); throw error; }
    }
    if (url.pathname === '/executions' && request.method === 'POST') {
      const { command } = await request.json() as { command: string }; commands.push(command);
      const failed = command.includes('tsc --noEmit') && ++compiles <= 2;
      const id = `execution-${commands.length}`;
      const result = { id, status: failed ? 'failed' : 'succeeded', stdout: '', stderr: failed ? 'Compiler error: fix src/App.tsx' : '' };
      if (command.includes('/workspace/mainbrella-git')) {
        const native = spawnSync('bash', ['-c', command.replaceAll('/workspace', disk)], { cwd: disk, encoding: 'utf8' });
        result.status = native.status === 0 ? 'succeeded' : 'failed'; result.stdout = native.stdout; result.stderr = native.stderr;
      }
      executions.set(id, result); return Response.json(result);
    }
    if (url.pathname.startsWith('/executions/')) return Response.json(executions.get(url.pathname.split('/').at(-1)!));
    if (url.pathname === '/previews') return Response.json({ id: 'b'.repeat(32), token: 'a'.repeat(48),
      port: 3000, createdAt: GENERATION_ONE, expiresAt: Date.now() + 30 * 60_000 }, { status: 201 });
    assert.fail(`Unexpected container request: ${request.method} ${url.pathname}`);
  } }) } as unknown as DurableObjectNamespace;
  assert.equal(buildConfigured(f.env), true, 'Codex mode works without an AI binding');
  const steps: string[] = [];
  const step = { async do(name: string, _options: unknown, operation: () => Promise<unknown>) { steps.push(name); return operation(); },
    async sleep() { assert.fail('fixture commands complete immediately'); } } as unknown as Parameters<typeof runBuildAgent>[2];
  await runBuildAgent(f.env, f.params, step, Date.now());
  const data = await (await handleBuildRequest(request(f.appId), f.env)).json() as any;
  const turn = data.app.turns[0];
  assert.equal(turn.status, 'succeeded', turn.error);
  assert.equal(data.app.revision, 1); assert.equal(data.app.activeTurnId, null);
  assert.match(data.app.preview.url, /^http:\/\/[a-z0-9]+\.localhost:8787\/$/);
  assert.equal(compiles, 3, 'Mainbrella sends its compiler failure back to Codex before completing');
  assert.deepEqual(guestImages.get(`/workspace/app/public/generated/${savedImageId}.jpg`), jpeg, 'preview materialization preserves original JPEG bytes');
  assert.ok(steps.indexOf('AI 0') < steps.indexOf('Allocate sandbox'));
  assert.ok(turn.activity.some((item: any) => item.type === 'message' && item.text.includes('Using write_file')));
  assert.ok(turn.activity.some((item: any) => item.type === 'tool' && item.status === 'failed'));
  const source = await (await handleBuildRequest(request(f.appId, SESSION_ONE, '/source'), f.env)).json() as any;
  assert.equal(source.files['src/App.tsx'], 'repaired'); assert.equal(source.files['src/old.ts'], undefined);
  assert.equal(guestFiles.get('/workspace/app/src/App.tsx'), 'repaired');
  const revision = f.sqlite.prepare('SELECT source_json FROM build_revisions WHERE app_id = ?').get(f.appId) as { source_json: string };
  assert.equal((await readBuildSource(f.env, f.params, revision.source_json))['src/App.tsx'], 'repaired');
  assert.ok(commands.some(command => command.includes('npm install --no-audit')));
  assert.ok(commands.some(command => command.includes('mainbrella-build-preview')));
});

test('Codex variables cannot select local inference outside local dev, and tool status stays out of Workers AI payloads', async () => {
  let calls = 0;
  const env = { BUILD_CODEX_URL: 'http://127.0.0.1:1', BUILD_CODEX_TOKEN: 'local-token', AI: { async run(_model: string, options: any) {
    calls++; assert.ok(options.messages.every((message: any) => !Object.hasOwn(message, 'tool_success')));
    return { choices: [{ message: { content: 'Production model' }, finish_reason: 'stop' }] };
  } } } as unknown as Env;
  const result = await buildInference(env, [{ role: 'tool', content: 'Result', tool_call_id: 'call', tool_success: false }], 1024);
  assert.equal(result.message.content, 'Production model'); assert.equal(calls, 1);
  env.LOCAL_DEV = 'true'; env.BUILD_CODEX_URL = 'https://external.example';
  await assert.rejects(buildInference(env, [{ role: 'user', content: 'Test' }], 1024, undefined, 'session'), /build_unavailable/);
  assert.equal(calls, 1);
});

test('inference failures survive Workflow serialization and Codex cleanup runs in a step', async t => {
  const f = await fixture(t);
  f.sqlite.prepare('UPDATE build_turns SET log = ? WHERE id = ?').run('Previous compiler output.', f.turnId);
  Object.assign(f.env, { LOCAL_DEV: 'true', BUILD_CODEX_URL: 'http://127.0.0.1:1234', BUILD_CODEX_TOKEN: 'local-token' });
  const steps: string[] = [], cleanupSteps: string[] = [], errors: unknown[] = [];
  let currentStep = '', inferences = 0, cleanups = 0;
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
  t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, options?: RequestInit) => {
    if (options?.method === 'DELETE') {
      cleanups++;
      cleanupSteps.push(currentStep);
      return new Response(null, { status: 204 });
    }
    inferences++;
    return new Response(chunks(delta({ content: 'Starting the app.' }) + event({ error: { code: 'build_inference_timeout', message: 'The model did not respond in 240 seconds.' } })));
  });
  const step = { async do(name: string, _options: unknown, operation: () => Promise<unknown>) {
    steps.push(name); currentStep = name;
    try { return structuredClone(await operation()); }
    catch (error) { throw new Error((error as Error).message); } // RPC drops custom Error prototypes.
    finally { currentStep = ''; }
  }, async sleep() { assert.fail('no sandbox should be started after inference fails'); } } as unknown as Parameters<typeof runBuildAgent>[2];
  await runBuildAgent(f.env, f.params, step, Date.now());
  const data = await (await handleBuildRequest(request(f.appId), f.env)).json() as any;
  assert.equal(data.app.activeTurnId, null);
  assert.equal(data.app.turns[0].status, 'failed');
  assert.equal(data.app.turns[0].error, 'build_inference_timeout');
  assert.equal(data.app.turns[0].log, '', 'raw diagnostics stay outside normal snapshots');
  assert.equal(f.sqlite.prepare('SELECT log FROM build_turns WHERE id = ?').get(f.turnId)!.log, 'Previous compiler output.\n\nThe model did not respond in 240 seconds.');
  assert.equal(data.app.turns[0].activity[0].status, 'unknown');
  assert.equal(inferences, 1, 'failed inference must not be replayed');
  assert.equal(cleanups, 1);
  assert.deepEqual(cleanupSteps, ['Close local inference'], 'cleanup I/O belongs to a durable Workflow step');
  assert.equal(steps.at(-1), 'Close local inference');
  assert.deepEqual(errors, [['build_turn_failed', { appId: f.appId, turnId: f.turnId, error: 'build_inference_timeout' }]]);
});

test('unexpected provider exceptions survive Workflow serialization and are returned in the failed turn log', async t => {
  const f = await fixture(t), message = 'Workers AI returned HTTP 429: concurrency limit exceeded.';
  t.mock.method(console, 'error', () => {});
  f.env.AI = { async run() { throw new Error(message); } } as unknown as Ai;
  const step = { async do(_name: string, _options: unknown, operation: () => Promise<unknown>) {
    try { return structuredClone(await operation()); }
    catch (error) { throw new Error((error as Error).message); }
  }, async sleep() { assert.fail('no sandbox should be started after inference fails'); } } as unknown as Parameters<typeof runBuildAgent>[2];
  await runBuildAgent(f.env, f.params, step, Date.now());
  const data = await (await handleBuildRequest(request(f.appId), f.env)).json() as any;
  assert.equal(data.app.activeTurnId, null);
  assert.equal(data.app.turns[0].status, 'failed');
  assert.equal(data.app.turns[0].error, 'build_failed');
  assert.equal(data.app.turns[0].log, '');
  assert.equal(String(f.sqlite.prepare('SELECT log FROM build_turns WHERE id = ?').get(f.turnId)!.log).trim(), message);
});


test('model choices are priced and validate the actual provider effort modes', () => {
  assert.deepEqual(buildModels.map(model => model.id), ['@cf/zai-org/glm-5.3', '@cf/moonshotai/kimi-k2.7-code', '@cf/zai-org/glm-5.3-flash']);
  assert.deepEqual(resolveBuildModel(BUILD_MODEL, {}), { model: '@cf/zai-org/glm-5.3', effort: 'high' });
  for (const model of buildModels) {
    assert.ok(buildTokenPrices[model.id], model.id);
    assert.ok(model.efforts.includes(model.defaultEffort));
    for (const effort of model.efforts) assert.equal(resolveBuildModel(BUILD_MODEL, { model: model.id, effort }).effort, effort);
  }
  assert.throws(() => resolveBuildModel(BUILD_MODEL, { model: '@cf/unknown/model' }), /invalid_build_model/);
  assert.throws(() => resolveBuildModel(BUILD_MODEL, { effort: 'medium' }), /invalid_build_effort/);
  assert.throws(() => resolveBuildModel(BUILD_MODEL, { effort: 'none' }), /invalid_build_effort/);
  assert.throws(() => resolveBuildModel(BUILD_MODEL, { effort: 'low' }), /invalid_build_effort/);
  assert.throws(() => resolveBuildModel(BUILD_MODEL, { effort: 'xhigh' }), /invalid_build_effort/);
  assert.throws(() => resolveBuildModel(BUILD_MODEL, { model: '@cf/moonshotai/kimi-k2.6' }), /invalid_build_model/);
  assert.throws(() => resolveBuildModel(BUILD_MODEL, { model: '@cf/zai-org/glm-5.3-flash', effort: 'low' }), /invalid_build_effort/);
  assert.deepEqual(resolveBuildModel(BUILD_MODEL, { model: '@cf/zai-org/glm-5.3-flash' }), { model: '@cf/zai-org/glm-5.3-flash', effort: 'high' });
  assert.deepEqual(buildReasoningOptions('@cf/zai-org/glm-5.3', 'max'), { reasoning_effort: 'max' });
  assert.deepEqual(buildReasoningOptions('@cf/google/gemma-4-26b-a4b-it', 'none'), { chat_template_kwargs: { enable_thinking: false } });
  assert.deepEqual(buildReasoningOptions('@cf/nvidia/nemotron-3-120b-a12b', 'low'), { chat_template_kwargs: { enable_thinking: true, low_effort: true, force_nonempty_content: true } });
  assert.deepEqual(buildReasoningOptions('@cf/moonshotai/kimi-k2.7-code', 'always'), {});
  assert.deepEqual(resolveBuildModel('local-model', {}, true), { model: 'local-model', effort: 'low' });
  assert.throws(() => resolveBuildModel('local-model', { model: BUILD_MODEL }, true), /invalid_build_model/);
});

test('queued builds retain native reasoning modes from before the menu was pruned', () => {
  assert.deepEqual(buildReasoningOptions('@cf/zai-org/glm-5.3-flash', 'low'), { reasoning_effort: 'low' });
  assert.deepEqual(buildReasoningOptions('@cf/moonshotai/kimi-k2.6', 'none'), { reasoning_effort: 'none' });
  assert.throws(() => buildReasoningOptions('@cf/zai-org/glm-5.3', 'xhigh'), /invalid_build_effort/);
});

test('prepaid app creation, edits and previews depend on available funds after ten turns today', async t => {
  for (const mode of ['create', 'build', 'preview'] as const) {
    for (const reserved of [false, true]) await t.test(`${mode}, funds ${reserved ? 'reserved' : 'available'}`, async sub => {
      const f = await fixture(sub);
      f.sqlite.prepare("UPDATE build_turns SET status = 'failed', error = 'build_failed' WHERE id = ?").run(f.turnId);
      f.sqlite.prepare('UPDATE build_apps SET active_turn_id = NULL, revision = 1 WHERE id = ?').run(f.appId);
      const now = new Date().toISOString();
      for (let index = 0; index < 9; index++) {
        f.sqlite.prepare(`INSERT INTO build_turns (id,app_id,user_id,request_key,prompt,mode,base_revision,status,stage,model,created_at)
          VALUES (?,?,?,?,?,?,1,?,'Finished',?,?)`)
          .run(crypto.randomUUID(), f.appId, USER_ONE, `history-${index}`, 'Previous request',
            index % 2 ? 'preview' : 'build', index % 3 ? 'succeeded' : 'failed', BUILD_MODEL, now);
      }
      f.sqlite.prepare('INSERT INTO prepaid_accounts (user_id,stripe_customer_id,created_at) VALUES (?,?,?)')
        .run(USER_ONE, 'cus_build', Date.now());
      await accountBillingRequest(f.env, USER_ONE, '/billing/funding', { id: 'pi_more_build', customerId: 'cus_build',
        amountCents: 3500, refundedCents: 0, disputed: false, createdAt: Date.now(), kind: 'topup' });
      await accountBillingRequest(f.env, USER_ONE, '/billing/settings', { spendLimitCents: 4000 });
      if (reserved) await accountBillingRequest(f.env, USER_ONE, '/billing/inference', { action: 'reserve',
        id: `${f.turnId}:held`, model: BUILD_MODEL, appId: f.appId, turnId: f.turnId,
        reservedMicroUsd: 40_000_000, createdAt: Date.now() });
      const { balance } = await accountBillingRequest(f.env, USER_ONE, '/billing/balance');
      assert.equal(balance.balanceCents, 4000);
      assert.equal(balance.availableBalanceCents, reserved ? 0 : 4000);
      const dispatched: unknown[] = [];
      Object.assign(f.env, { BUILD_ENABLED: 'true', AI: {}, PREVIEWS_ENABLED: 'true', PREVIEW_DOMAIN: 'mainbrella.dev', PREVIEW_ROUTES: {},
        BUILD_WORKFLOW: { async create(options: unknown) { dispatched.push(options); } } });
      const path = mode === 'create' ? 'apps' : `apps/${f.appId}/turns`;
      const body = mode === 'create' ? { prompt: 'A new app' }
        : mode === 'build' ? { mode, revision: 1, prompt: 'Add charts' } : { mode, revision: 1 };
      const response = await handleBuildRequest(new Request(`https://api.mainbrella.com/build/${path}`, { method: 'POST',
        headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${SESSION_ONE}`,
          'Content-Type': 'application/json', 'Idempotency-Key': 'funded-request' }, body: JSON.stringify(body) }), f.env);
      assert.equal(response.status, reserved ? 402 : 202, await response.clone().text());
      assert.equal(dispatched.length, reserved ? 0 : 1);
      assert.equal((f.sqlite.prepare('SELECT COUNT(*) AS count FROM build_turns WHERE user_id = ?').get(USER_ONE) as { count: number }).count,
        reserved ? 10 : 11);
      if (reserved) assert.deepEqual(await response.json(), { error: 'insufficient_balance' });
      else {
        const { app } = await response.json() as any;
        assert.ok(app.activeTurnId);
        assert.equal(app.turns.find((turn: any) => turn.id === app.activeTurnId).mode, mode === 'preview' ? 'preview' : 'build');
      }
    });
  }
});

test('model selection is saved, returned and protected by idempotency on create and update', async t => {
  const f = await fixture(t);
  f.sqlite.prepare("UPDATE build_turns SET status = 'succeeded' WHERE id = ?").run(f.turnId);
  f.sqlite.prepare('UPDATE build_apps SET active_turn_id = NULL WHERE id = ?').run(f.appId);
  const dispatched: unknown[] = [];
  Object.assign(f.env, { BUILD_ENABLED: 'true', AI: {}, PREVIEWS_ENABLED: 'true', PREVIEW_DOMAIN: 'mainbrella.dev', PREVIEW_ROUTES: {},
    BUILD_WORKFLOW: { async create(options: unknown) { dispatched.push(options); } } });
  function submit(path: string, key: string, body: unknown) {
    return handleBuildRequest(new Request(`https://api.mainbrella.com/build/${path}`, { method: 'POST',
      headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${SESSION_ONE}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) }), f.env);
  }
  const config = await (await handleBuildRequest(new Request('https://api.mainbrella.com/build/config', { headers: { Cookie: `mainbrella_session=${SESSION_ONE}` } }), f.env)).json() as any;
  assert.equal(config.models.length, buildModels.length);
  assert.equal(config.model, '@cf/zai-org/glm-5.3');
  assert.ok(!('dailyTurns' in config));
  assert.deepEqual(config.models.map((model: any) => [model.description, model.efforts, model.defaultEffort]), [
    ['Best quality', ['high', 'max'], 'high'], ['Coding', ['always'], 'always'], ['Lower cost', ['high', 'max'], 'high'],
  ]);
  const body = { prompt: 'An expense tracker', model: '@cf/zai-org/glm-5.3', effort: 'max' };
  const response = await submit('apps', 'selected-model', body);
  assert.equal(response.status, 202, await response.clone().text());
  const { app } = await response.json() as any;
  assert.equal(app.turns[0].model, body.model); assert.equal(app.turns[0].effort, 'max');
  assert.equal((await submit('apps', 'selected-model', body)).status, 200);
  assert.equal((await submit('apps', 'selected-model', { ...body, effort: 'high' })).status, 409);
  assert.equal((await submit('apps', 'invalid-model', { ...body, model: '@cf/unknown' })).status, 400);
  assert.equal((await submit('apps', 'invalid-effort', { ...body, effort: 'medium' })).status, 400);
  assert.equal((await submit('apps', 'low-effort', { ...body, effort: 'low' })).status, 400);
  assert.equal((await submit('apps', 'removed-model', { ...body, model: '@cf/moonshotai/kimi-k2.6' })).status, 400);
  await failBuildTurn(f.env, { id: app.turns[0].id, app_id: app.id, user_id: USER_ONE }, 'build_interrupted');
  const changed = await submit(`apps/${app.id}/turns`, 'next-model', { mode: 'build', revision: 0, prompt: 'Add charts', model: '@cf/moonshotai/kimi-k2.7-code' });
  assert.equal(changed.status, 202, await changed.clone().text());
  const updated = (await changed.json() as any).app.turns;
  assert.ok(updated.some((turn: any) => turn.model === '@cf/moonshotai/kimi-k2.7-code' && turn.effort === 'always'));
});

test('inference forwards the saved model and effort and normalizes native Workers AI tool calls', async () => {
  let chosen: string | undefined, payload: any;
  const model = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  const env = { BUILD_MODEL: model, AI: { async run(id: string, input: any) {
    chosen = id; payload = input;
    return { response: 'Editing files', tool_calls: [{ name: 'write_file', arguments: { path: 'src/App.tsx', content: 'Hello' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
  } } } as unknown as Env;
  const result = await buildInference(env, [{ role: 'user', content: 'Build' }], 512);
  assert.equal(chosen, model); assert.equal(payload.max_tokens, 512); assert.equal(payload.reasoning_effort, undefined);
  assert.equal(result.message.tool_calls?.[0].function.arguments, '{"path":"src/App.tsx","content":"Hello"}');
  const streamed = await readBuildInference(chunks(event({ response: 'Hello', usage: { prompt_tokens: 10, completion_tokens: 5 } }) + event('[DONE]')));
  assert.equal(streamed.choices[0].message.content, 'Hello');
  await assert.rejects(readBuildInference(chunks(event({ response: 'Incomplete' }))), /model_response_incomplete/);
});
