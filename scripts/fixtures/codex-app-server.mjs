#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

const log = value => { if (process.env.CODEX_FIXTURE_LOG) appendFileSync(process.env.CODEX_FIXTURE_LOG, JSON.stringify(value) + '\n'); };
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method, params) => send({ method, params });
const threads = new Map(), pending = new Map();
let count = 0, requestId = 1000;
log({ started: true, argv: process.argv.slice(2), cwd: process.cwd() });
process.on('SIGTERM', () => { log({ stopped: true }); process.exit(0); });
function advance(thread) {
  const params = { threadId: thread.id, turnId: thread.turnId };
  thread.inputTokens += 10; thread.outputTokens += 4;
  notify('thread/tokenUsage/updated', { ...params, tokenUsage: { total: { inputTokens: thread.inputTokens, outputTokens: thread.outputTokens } } });
  if (thread.tools.length) {
    const [tool, args] = thread.tools.shift();
    notify('item/agentMessage/delta', { ...params, delta: `Using ${tool}. ` });
    const id = requestId++, callId = `call-${id}`;
    pending.set(id, thread);
    send({ id, method: 'item/tool/call', params: { ...params, callId, namespace: null, tool, arguments: args } });
  } else {
    notify('item/agentMessage/delta', { ...params, delta: 'App updated. 🌍' });
    notify('turn/completed', { ...params, turn: { id: thread.turnId, status: 'completed', error: null } });
  }
}
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line); log(message);
  if (!message.method) {
    const thread = pending.get(message.id); pending.delete(message.id);
    if (thread && !thread.interrupted && (!thread.batchRemaining || --thread.batchRemaining === 0)) advance(thread);
    return;
  }
  const { id, method, params } = message;
  if (method === 'initialize') { if (process.env.CODEX_FIXTURE_INITIALIZE !== 'stall') send({ id, result: {} }); }
  else if (method === 'account/read') send({ id, result: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } });
  else if (method === 'config/read') send({ id, result: { config: { model: 'fixture-model' } } });
  else if (method === 'thread/start') {
    if (![6, 7].includes(params.dynamicTools.length) || params.sandbox !== 'read-only' || params.ephemeral !== true) throw new Error('Invalid thread configuration');
    const thread = { id: `thread-${++count}`, inputTokens: 0, outputTokens: 0, dynamicTools: params.dynamicTools };
    threads.set(thread.id, thread); send({ id, result: { thread } });
  } else if (method === 'turn/start') {
    const thread = threads.get(params.threadId), text = params.input.map(input => input.text).join('\n');
    thread.turnId = `turn-${++count}`; thread.interrupted = false;
    thread.tools = text === 'images' && thread.dynamicTools.some(tool => tool.name === 'generate_image')
      ? [['generate_image', { label: 'Forest', prompt: 'Moody ancient forest' }]]
      : text.includes('repair') || text.includes('platform build check failed') ? [['write_file', { path: 'src/App.tsx', content: 'repaired' }]] : [
      ['list_files', {}], ['read_file', { path: 'src/App.tsx' }],
      ['write_file', { path: 'src/App.tsx', content: 'updated' }], ['delete_file', { path: 'src/old.ts' }],
      ['run_command', { command: 'npm run build' }], ['get_logs', {}],
    ];
    send({ id, result: { turn: { id: thread.turnId, status: 'inProgress' } } });
    notify('turn/started', { threadId: thread.id, turn: { id: thread.turnId, status: 'inProgress' } });
    const context = { threadId: thread.id, turnId: thread.turnId };
    if (text === 'parallel') {
      thread.tools = []; thread.batchRemaining = 2;
      const batch = [];
      for (const path of ['src/App.tsx', 'src/style.css']) {
        const id = requestId++; pending.set(id, thread);
        batch.push({ id, method: 'item/tool/call', params: { ...context, callId: `call-${id}`, namespace: null,
          tool: 'write_file', arguments: { path, content: 'batch edit' } } });
      }
      process.stdout.write(batch.map(message => JSON.stringify(message) + '\n').join(''));
    } else if (text.includes('stall')) notify('item/agentMessage/delta', { ...context, delta: 'Starting.' });
    else if (text.includes('disconnect')) process.exit(7);
    else if (text.includes('malformed')) process.stdout.write('not JSON\n');
    else if (text === 'failed') notify('turn/completed', { ...context, turn: { id: thread.turnId, status: 'failed', error: { message: 'Provider failure' } } });
    else if (text.includes('builtin')) notify('item/started', { ...context, item: { type: 'commandExecution' } });
    else if (text.includes('unknown-tool')) { thread.tools = [['unknown_tool', {}]]; advance(thread); }
    else advance(thread);
  } else if (method === 'turn/interrupt') {
    const thread = threads.get(params.threadId); thread.interrupted = true;
    send({ id, result: {} });
    notify('turn/completed', { threadId: thread.id, turn: { id: thread.turnId, status: 'interrupted' } });
  } else if (method === 'thread/unsubscribe') { threads.delete(params.threadId); send({ id, result: {} }); }
  else if (method !== 'initialized') send({ id, error: { code: -32601, message: 'Unknown method' } });
});
