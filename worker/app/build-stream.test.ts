import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startCodexBridge } from '../../scripts/codex-bridge.mjs';
import { readBuildInference, buildInference } from '../lib/build-ai';
import { buildAppStream, saveBuildActivity, buildToolLabel } from '../lib/build-activity';
import { handleBuildRequest, failBuildTurn, buildConfigured } from './build';
import { buildStarter } from '../lib/build-contract';
import { PLAN_PRICES, planPrices } from '../lib/stripe';
import { runBuildAgent } from '../lib/build-agent';
import { paidContainerFixture, SESSION_ONE, SESSION_TWO, USER_ONE, GENERATION_ONE, EXPIRES_AT } from './paid-container-test-helpers';

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

async function fixture(t: Parameters<typeof paidContainerFixture>[0]) {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  f.env.DB.batch = (async (statements: D1PreparedStatement[]) => Promise.all(statements.map(statement => statement.run()))) as D1Database['batch'];
  for (const migration of ['023_build.sql', '024_build_activity.sql']) f.sqlite.exec(readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8'));
  const appId = crypto.randomUUID(), turnId = crypto.randomUUID(), now = new Date().toISOString();
  f.sqlite.prepare('INSERT INTO build_apps (id,user_id,create_key,initial_prompt,name,source_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(appId, USER_ONE, 'create', 'Hello world', 'Hello world', '{}', now, now);
  f.sqlite.prepare("INSERT INTO build_turns (id,app_id,user_id,request_key,prompt,mode,base_revision,status,stage,model,created_at) VALUES(?,?,?,?,?,'build',0,'running','Building','model',?)")
    .run(turnId, appId, USER_ONE, 'turn', 'Hello world', now);
  f.sqlite.prepare('UPDATE build_apps SET active_turn_id = ? WHERE id = ?').run(turnId, appId);
  return { ...f, appId, turnId, params: { appId, turnId, userId: USER_ONE } };
}
function request(id: string, session = SESSION_ONE, suffix = '') {
  return new Request(`https://api.mainbrella.com/build/apps/${id}${suffix}`, { headers: { Origin: 'https://mainbrella.com', Cookie: `mainbrella_session=${session}` } });
}

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
  assert.match(text, /"text":"Write src\/App.tsx","status":"failed"/);
  f.sqlite.prepare('DELETE FROM build_apps WHERE id = ?').run(f.appId);
  assert.equal((f.sqlite.prepare('SELECT COUNT(*) AS count FROM build_activity').get() as any).count, 0);
});

test('disconnecting the progress stream stops snapshot reads', async () => {
  let reads = 0;
  const response = buildAppStream(new Request('https://api.test'), async () => { reads++; return { app: { activeTurnId: 'turn' } }; }, {});
  const reader = response.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: app/);
  await reader.cancel();
  assert.equal(reads, 1);
  assert.equal(buildToolLabel('write_file', '{"path":"src/App.tsx","content":"partial'), 'Write src/App.tsx');
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
  const executions = new Map<string, { id: string; status: string; stdout: string; stderr: string }>();
  let compiles = 0;
  f.env.USER_CONTAINER = { idFromName: (name: string) => name, get: () => ({ async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === '/files' && request.method === 'PUT') {
      guestFiles.set(url.searchParams.get('path')!, await request.text()); return Response.json({ saved: true });
    }
    if (url.pathname === '/executions' && request.method === 'POST') {
      const { command } = await request.json() as { command: string }; commands.push(command);
      const failed = command.includes('tsc --noEmit') && ++compiles <= 2;
      const id = `execution-${commands.length}`;
      const result = { id, status: failed ? 'failed' : 'succeeded', stdout: '', stderr: failed ? 'Compiler error: fix src/App.tsx' : '' };
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
  assert.ok(steps.indexOf('AI 0') < steps.indexOf('Allocate sandbox'));
  assert.ok(turn.activity.some((item: any) => item.type === 'message' && item.text.includes('Using write_file')));
  assert.ok(turn.activity.some((item: any) => item.type === 'tool' && item.status === 'failed'));
  const source = await (await handleBuildRequest(request(f.appId, SESSION_ONE, '/source'), f.env)).json() as any;
  assert.equal(source.files['src/App.tsx'], 'repaired'); assert.equal(source.files['src/old.ts'], undefined);
  assert.equal(guestFiles.get('/workspace/app/src/App.tsx'), 'repaired');
  const revision = f.sqlite.prepare('SELECT source_json FROM build_revisions WHERE app_id = ?').get(f.appId) as { source_json: string };
  assert.equal(JSON.parse(revision.source_json)['src/App.tsx'], 'repaired');
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
    return new Response(chunks(delta({ content: 'Starting the app.' }) + event({ error: { code: 'build_inference_timeout' } })));
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
  assert.equal(data.app.turns[0].activity[0].status, 'failed');
  assert.equal(inferences, 1, 'failed inference must not be replayed');
  assert.equal(cleanups, 1);
  assert.deepEqual(cleanupSteps, ['Close local inference'], 'cleanup I/O belongs to a durable Workflow step');
  assert.equal(steps.at(-1), 'Close local inference');
  assert.deepEqual(errors, [['build_turn_failed', { appId: f.appId, turnId: f.turnId, error: 'build_inference_timeout' }]]);
});
