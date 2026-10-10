import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCodexBridge } from './codex-bridge.mjs';

const fixture = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url));
const names = ['list_files', 'read_file', 'write_file', 'delete_file', 'run_command', 'get_logs'];
const tools = names.map(name => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } }));
const input = text => [{ role: 'system', content: 'Build an app.' }, { role: 'user', content: text }];
async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-bridge-test-'));
  const log = join(directory, 'protocol.jsonl');
  const bridge = await startCodexBridge({ ...options, spawnProcess(_command, args, spawnOptions) {
    return spawn(process.execPath, [fixture, ...args], { ...spawnOptions, env: { ...process.env, CODEX_FIXTURE_LOG: log } });
  } });
  t.after(async () => { await bridge.close(); await rm(directory, { recursive: true, force: true }); });
  return { ...bridge, async records() { return (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse); } };
}
async function infer(bridge, id, messages, maxTokens = 1024) {
  const response = await fetch(`${bridge.url}/sessions/${id}`, { method: 'POST',
    headers: { Authorization: `Bearer ${bridge.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, tools, maxTokens }) });
  assert.equal(response.status, 200);
  const text = await response.text();
  const events = text.split('\n\n').filter(Boolean).map(block => block.slice(6)).filter(data => data !== '[DONE]').map(JSON.parse);
  const error = events.find(event => event.error);
  if (error) return { error: error.error.code };
  const content = events.map(event => event.choices[0].delta?.content || '').join('');
  const calls = events.flatMap(event => event.choices[0].delta?.tool_calls || []).map(({ index, ...call }) => call);
  const last = events.at(-1);
  return { message: { role: 'assistant', content: content || null, ...(calls.length ? { tool_calls: calls } : {}) }, usage: last.usage };
}
const stop = (bridge, id) => fetch(`${bridge.url}/sessions/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${bridge.token}` } });

test('Codex pauses for all six Worker tools, preserves tool failure and starts compiler repair in the same thread', async t => {
  const bridge = await setup(t), messages = input('Build it.');
  assert.equal(bridge.model, 'codex/fixture-model');
  for (const name of names) {
    const result = await infer(bridge, 'build-one', messages);
    assert.equal(result.message.tool_calls[0].function.name, name);
    assert.equal(result.usage.prompt_tokens, 10); assert.equal(result.usage.completion_tokens, 4);
    const records = await bridge.records();
    assert.equal(records.filter(record => record.result?.contentItems).length, names.indexOf(name), 'no tool executes until the Worker supplies its result');
    messages.push(result.message, { role: 'tool', tool_call_id: result.message.tool_calls[0].id, content: 'Worker output', tool_success: name !== 'run_command' });
  }
  const result = await infer(bridge, 'build-one', messages); messages.push(result.message);
  assert.equal(result.message.content, 'App updated. 🌍');
  messages.push({ role: 'user', content: 'Platform build failed; repair it.' });
  const repaired = await infer(bridge, 'build-one', messages);
  assert.equal(repaired.error, undefined, JSON.stringify(await bridge.records()));
  assert.equal(repaired.message.tool_calls[0].function.name, 'write_file');
  assert.equal((await stop(bridge, 'build-one')).status, 204);
  await bridge.close();
  const records = await bridge.records();
  assert.equal(records.find(record => record.method === 'initialize').params.capabilities.experimentalApi, true);
  const thread = records.find(record => record.method === 'thread/start').params;
  assert.deepEqual(thread.dynamicTools.map(tool => tool.name), names);
  assert.equal(thread.config.features.shell_tool, false);
  assert.equal(records.filter(record => record.method === 'thread/start').length, 1);
  assert.equal(records.filter(record => record.method === 'turn/start').length, 2);
  assert.ok(records.filter(record => record.method === 'turn/start').every(record => record.params.effort === 'low'),
    'bounded build inference must not inherit a personal high reasoning setting');
  assert.equal(records.filter(record => record.result?.contentItems)[4].result.success, false);
  assert.ok(records.some(record => record.method === 'turn/interrupt'));
});

test('bridge rejects unauthenticated browser requests and overlapping inference', async t => {
  const bridge = await setup(t);
  assert.equal((await fetch(`${bridge.url}/sessions/test`, { method: 'POST' })).status, 403);
  assert.equal((await fetch(`${bridge.url}/sessions/test`, { method: 'POST', headers: { Authorization: `Bearer ${bridge.token}`, Origin: 'http://localhost' } })).status, 403);
  const request = () => fetch(`${bridge.url}/sessions/test`, { method: 'POST', headers: { Authorization: `Bearer ${bridge.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: input('stall'), tools, maxTokens: 1024 }) });
  const first = await request();
  assert.equal((await request()).status, 409);
  await stop(bridge, 'test');
  assert.match(await first.text(), /build_interrupted/);
});

test('timeouts, failed turns, unknown tools, malformed stdio and app-server exit terminate inference', async t => {
  for (const [scenario, error] of [['stall', 'build_inference_timeout'], ['failed', 'build_failed'],
    ['unknown-tool', 'invalid_model_response'], ['builtin', 'invalid_model_response'],
    ['malformed', 'invalid_model_response'], ['disconnect', 'build_inference_disconnected']]) {
    const bridge = await setup(t, { requestTimeoutMs: 100 });
    assert.deepEqual(await infer(bridge, `build-${scenario}`, input(scenario)), { error });
    await bridge.close();
  }
});

test('disconnecting an inference response interrupts its active Codex turn', async t => {
  const bridge = await setup(t);
  const response = await fetch(`${bridge.url}/sessions/test`, { method: 'POST', headers: { Authorization: `Bearer ${bridge.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: input('stall'), tools, maxTokens: 1024 }) });
  const reader = response.body.getReader();
  await reader.read(); await reader.cancel();
  // The cancellation crosses an HTTP socket before it reaches the bridge.
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await bridge.records()).some(record => record.method === 'turn/interrupt')) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('the abandoned Codex turn was not interrupted');
});

test('bridge shutdown closes in-flight requests and kills app-server', async t => {
  const bridge = await setup(t), result = infer(bridge, 'shutdown', input('stall'));
  // Wait for the real HTTP request to attach before shutting down.
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await bridge.records()).some(record => record.method === 'turn/start')) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await bridge.close();
  assert.deepEqual(await result, { error: 'build_interrupted' });
  assert.ok((await bridge.records()).some(record => record.stopped));
});

test('parallel dynamic tools share one inference round and await both Worker results', async t => {
  const bridge = await setup(t), messages = input('parallel');
  const result = await infer(bridge, 'parallel', messages);
  assert.equal(result.message.tool_calls.length, 2);
  messages.push(result.message, ...result.message.tool_calls.map(call => ({ role: 'tool', tool_call_id: call.id, content: 'Saved.', tool_success: true })));
  const final = await infer(bridge, 'parallel', messages);
  assert.equal(final.message.content, 'App updated. 🌍');
  assert.equal((await bridge.records()).filter(record => record.result?.contentItems).length, 2);
});

test('abandoned tool calls expire and an output budget failure terminates inference', async t => {
  const bridge = await setup(t, { idleTimeoutMs: 50 });
  const result = await infer(bridge, 'idle', input('Build it.'));
  assert.equal(result.message.tool_calls[0].function.name, 'list_files');
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await bridge.records()).some(record => record.method === 'turn/interrupt')) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok((await bridge.records()).some(record => record.method === 'turn/interrupt'));
  assert.deepEqual(await infer(bridge, 'budget', input('Build it.'), 1), { error: 'build_budget_exceeded' });
});
