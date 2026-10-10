import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startCodexBridge } from '../../scripts/codex-bridge.mjs';
import { readBuildInference, buildInference } from '../lib/build-ai';
import { buildAppStream, saveBuildActivity, buildToolLabel } from '../lib/build-activity';
import { handleBuildRequest, failBuildTurn, buildConfigured } from './build';
import { buildModels, resolveBuildModel, buildReasoningOptions } from '../lib/build-models';
import { buildTokenPrices } from '../lib/build-pricing';
import { BUILD_MODEL, buildStarter } from '../lib/build-contract';
import { buildBillingFixture } from './build-billing-test-helpers';
import { PLAN_PRICES, planPrices } from '../lib/stripe';
import { runBuildAgent } from '../lib/build-agent';
import { BUILD_IMAGE_MODEL, buildImageBytes, generateBuildImage } from '../lib/build-images';
import { paidContainerFixture, SESSION_ONE, SESSION_TWO, USER_ONE, USER_TWO, GENERATION_ONE, EXPIRES_AT } from './paid-container-test-helpers';

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
  for (const migration of ['023_build.sql', '024_build_activity.sql', '025_build_images.sql', '027_build_model_effort.sql']) f.sqlite.exec(readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8'));
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

test('original images are generated once, streamed as metadata, ownership-checked and exported as portable JPEGs', async t => {
  const f = await fixture(t); let calls = 0;
  f.env.AI = { async run(model: string, input: any) {
    calls++; assert.equal(model, BUILD_IMAGE_MODEL); assert.equal(input.steps, 4);
    assert.match(input.prompt, /moody forest/); return { image: jpegBase64 };
  } } as unknown as Ai;
  const image = await generateBuildImage(f.env, f.params, 'tool-0-0', 'Forest canopy', 'An original moody forest with ancient trees.');
  assert.deepEqual(await generateBuildImage(f.env, f.params, 'tool-0-0', 'Forest canopy', 'An original moody forest with ancient trees.'), image);
  assert.equal(calls, 1, 'replayed workflow steps reuse the stored asset');
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
  assert.equal(data.app.turns[0].activity.find((item: any) => item.text === 'Generate Forest').status, 'failed');
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
  const guestImages = new Map<string, Uint8Array>();
  const executions = new Map<string, { id: string; status: string; stdout: string; stderr: string }>();
  let compiles = 0;
  f.env.USER_CONTAINER = { idFromName: (name: string) => name, get: () => ({ async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === '/files' && request.method === 'PUT') {
      const path = url.searchParams.get('path')!;
      if (path.endsWith('.jpg')) guestImages.set(path, new Uint8Array(await request.arrayBuffer()));
      else guestFiles.set(path, await request.text());
      return Response.json({ saved: true });
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
  assert.deepEqual(guestImages.get(`/workspace/app/public/generated/${savedImageId}.jpg`), jpeg, 'preview materialization preserves original JPEG bytes');
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


test('model choices are priced and validate the actual provider effort modes', () => {
  for (const model of buildModels) {
    assert.ok(buildTokenPrices[model.id], model.id);
    assert.ok(model.efforts.includes(model.defaultEffort));
    for (const effort of model.efforts) assert.equal(resolveBuildModel(BUILD_MODEL, { model: model.id, effort }).effort, effort);
  }
  assert.throws(() => resolveBuildModel(BUILD_MODEL, { model: '@cf/unknown/model' }), /invalid_build_model/);
  assert.throws(() => resolveBuildModel(BUILD_MODEL, { effort: 'medium' }), /invalid_build_effort/);
  assert.throws(() => resolveBuildModel(BUILD_MODEL, { effort: 'none' }), /invalid_build_effort/);
  assert.deepEqual(buildReasoningOptions('@cf/zai-org/glm-5.3', 'max'), { reasoning_effort: 'max' });
  assert.deepEqual(buildReasoningOptions('@cf/google/gemma-4-26b-a4b-it', 'none'), { chat_template_kwargs: { enable_thinking: false } });
  assert.deepEqual(buildReasoningOptions('@cf/nvidia/nemotron-3-120b-a12b', 'low'), { chat_template_kwargs: { enable_thinking: true, low_effort: true, force_nonempty_content: true } });
  assert.deepEqual(buildReasoningOptions('@cf/moonshotai/kimi-k2.7-code', 'always'), {});
  assert.deepEqual(resolveBuildModel('local-model', {}, true), { model: 'local-model', effort: 'low' });
  assert.throws(() => resolveBuildModel('local-model', { model: BUILD_MODEL }, true), /invalid_build_model/);
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
  const body = { prompt: 'An expense tracker', model: '@cf/zai-org/glm-5.3', effort: 'max' };
  const response = await submit('apps', 'selected-model', body);
  assert.equal(response.status, 202, await response.clone().text());
  const { app } = await response.json() as any;
  assert.equal(app.turns[0].model, body.model); assert.equal(app.turns[0].effort, 'max');
  assert.equal((await submit('apps', 'selected-model', body)).status, 200);
  assert.equal((await submit('apps', 'selected-model', { ...body, effort: 'low' })).status, 409);
  assert.equal((await submit('apps', 'invalid-model', { ...body, model: '@cf/unknown' })).status, 400);
  assert.equal((await submit('apps', 'invalid-effort', { ...body, effort: 'medium' })).status, 400);
  await failBuildTurn(f.env, { id: app.turns[0].id, app_id: app.id, user_id: USER_ONE }, 'build_interrupted');
  const changed = await submit(`apps/${app.id}/turns`, 'next-model', { mode: 'build', revision: 0, prompt: 'Add charts', model: '@cf/moonshotai/kimi-k2.6', effort: 'none' });
  assert.equal(changed.status, 202, await changed.clone().text());
  const updated = (await changed.json() as any).app.turns;
  assert.ok(updated.some((turn: any) => turn.model === '@cf/moonshotai/kimi-k2.6' && turn.effort === 'none'));
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
