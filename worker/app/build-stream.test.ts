import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readBuildInference, buildInference } from '../lib/build-ai';
import { buildAppStream, saveBuildActivity, buildToolLabel } from '../lib/build-activity';
import { handleBuildRequest, failBuildTurn } from './build';
import { runBuildAgent } from '../lib/build-agent';
import { paidContainerFixture, SESSION_ONE, SESSION_TWO, USER_ONE } from './paid-container-test-helpers';

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
