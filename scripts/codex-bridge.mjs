import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const toolNames = ['list_files', 'read_file', 'write_file', 'delete_file', 'run_command', 'get_logs'];
const inferenceTimeoutMs = 240_000;
const sessionTimeoutMs = 30 * 60_000;
const toolTimeoutMs = 12 * 60_000; // Materialization, install and compiler checks can span multiple Workflow steps.
const toolResult = (text, success = false) => ({ contentItems: [{ type: 'inputText', text }], success });
const failure = code => Object.assign(new Error(code), { code });

// JSON-RPC over newline-delimited stdio. Every outstanding request is settled on
// timeout, invalid protocol output, process exit or shutdown.
class AppServer {
  pending = new Map();
  nextId = 0;
  closed = false;
  constructor(child, onMessage, onFailure, rpcTimeoutMs) {
    this.child = child;
    this.rpcTimeoutMs = rpcTimeoutMs;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', line => {
      if (!line.trim()) return;
      try {
        if (line.length > 1024 * 1024) throw failure('invalid_model_response');
        const message = JSON.parse(line);
        if (!message.method && message.id !== undefined) {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id); clearTimeout(pending.timer);
          if (message.error) pending.reject(failure('build_unavailable'));
          else if (!Object.hasOwn(message, 'result')) pending.reject(failure('invalid_model_response'));
          else pending.resolve(message.result);
        } else onMessage(message);
      } catch { this.fail(failure('invalid_model_response')); }
    });
    this.lines.on('close', () => this.fail(failure('build_inference_disconnected')));
    this.onFailure = onFailure;
    child.on('error', () => this.fail(failure('build_unavailable')));
    child.on('exit', () => this.fail(failure('build_inference_disconnected')));
    child.stdin.on('error', () => this.fail(failure('build_inference_disconnected')));
  }
  send(message) {
    if (this.closed) throw failure('build_inference_disconnected');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method, params, timeoutMs = this.rpcTimeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(failure('build_inference_timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
    this.onFailure(error);
    this.child.kill('SIGTERM');
  }
  async close() {
    const exited = this.child.exitCode !== null || this.child.signalCode !== null;
    const exit = exited ? Promise.resolve() : new Promise(resolve => this.child.once('exit', resolve));
    this.fail(failure('build_interrupted'));
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 1000);
    await exit; clearTimeout(timer); this.lines.close();
  }
}

/** A private loopback provider; the Worker alone executes Mainbrella tools. */
export async function startCodexBridge({ executable = process.env.CODEX_PATH || 'codex',
  spawnProcess = spawn, requestTimeoutMs = inferenceTimeoutMs, rpcTimeoutMs = 20_000,
  idleTimeoutMs = toolTimeoutMs, lifetimeMs = sessionTimeoutMs, signal } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'mainbrella-codex-'));
  const token = randomBytes(32).toString('hex');
  const sessions = new Map(), threads = new Map();
  let closing = false;
  // No project checkout is exposed to Codex. Its local execution integrations
  // are disabled, and the read-only sandbox remains a second boundary.
  const config = { mcp_servers: {}, web_search: 'disabled', project_doc_max_bytes: 0,
    features: { shell_tool: false, unified_exec: false, apps: false, multi_agent: false,
      goals: false, hooks: false, remote_plugin: false, browser_use: false, computer_use: false,
      view_image: false, code_mode: false, shell_snapshot: false, skill_search: false,
      skip_host_skill_discovery: true } };
  const child = spawnProcess(executable, ['app-server', '--listen', 'stdio://',
    ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${toml(value)}`])],
  { cwd, stdio: ['pipe', 'pipe', 'inherit'] });
  const rpc = new AppServer(child, message => receive(message), error => {
    for (const session of [...sessions.values()]) terminate(session, error.code);
  }, rpcTimeoutMs);
  const abort = () => rpc.fail(failure('build_interrupted'));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();

  function emit(session, value) {
    const response = session.response;
    if (!response || response.destroyed) throw failure('build_inference_disconnected');
    response.write(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`);
  }
  function finish(session, reason) {
    const usage = session.usageVersion > session.usageVersionAtStart ? session.usage : null;
    const previous = session.reportedUsage;
    const promptTokens = usage ? Math.max(0, usage.inputTokens - previous.inputTokens) : Math.ceil(session.inputBytes / 4);
    const completionTokens = usage ? Math.max(0, usage.outputTokens - previous.outputTokens) : Math.ceil(session.outputBytes / 4);
    if (completionTokens > session.maxTokens) { terminate(session, 'build_budget_exceeded'); return; }
    emit(session, { choices: [{ delta: {}, finish_reason: reason }], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens } });
    // If usage arrives after a tool request, reconcile the conservative byte
    // estimate against later cumulative usage without charging it twice.
    session.reportedUsage = { inputTokens: previous.inputTokens + promptTokens, outputTokens: previous.outputTokens + completionTokens };
    emit(session, '[DONE]');
    const response = session.response; session.response = null;
    clearTimeout(session.requestTimer);
    response.end();
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => terminate(session, 'build_inference_timeout'), idleTimeoutMs);
  }
  function terminate(session, code) {
    if (!sessions.delete(session.id)) return;
    clearTimeout(session.requestTimer); clearTimeout(session.idleTimer); clearTimeout(session.lifetimeTimer); clearTimeout(session.toolDeliveryTimer);
    if (session.response && !session.response.destroyed) {
      session.response.write(`data: ${JSON.stringify({ error: { code } })}\n\n`);
      session.response.end(); session.response = null;
    }
    // Interrupt before returning failed tool results, so no new inference can
    // begin after the Worker disconnects or has exceeded its budget.
    if (session.threadId && session.turnId && session.active) void rpc.request('turn/interrupt',
      { threadId: session.threadId, turnId: session.turnId }, 1000).catch(() => {});
    for (const call of session.pending.values()) {
      try { rpc.send({ id: call.id, result: toolResult('Mainbrella stopped this build.') }); } catch {}
    }
    session.pending.clear();
    if (session.threadId) {
      threads.delete(session.threadId);
      void rpc.request('thread/unsubscribe', { threadId: session.threadId }, 1000).catch(() => {});
    }
  }
  function receive(message) {
    const params = message.params ?? {}, session = threads.get(params.threadId);
    if (message.id !== undefined) {
      if (message.method !== 'item/tool/call' || !session || !session.active
        || !toolNames.includes(params.tool) || params.namespace != null || typeof params.callId !== 'string'
        || !params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments)) {
        rpc.send({ id: message.id, error: { code: -32601, message: 'Only Mainbrella build tools are supported.' } });
        if (session) terminate(session, 'invalid_model_response');
        return;
      }
      const argumentsText = JSON.stringify(params.arguments);
      if (argumentsText.length > 96 * 1024 || session.pending.has(params.callId)) {
        rpc.send({ id: message.id, result: toolResult('Invalid tool arguments.') });
        terminate(session, 'invalid_model_response'); return;
      }
      const call = { id: params.callId, type: 'function', function: { name: params.tool, arguments: argumentsText } };
      session.pending.set(params.callId, { id: message.id, call });
      session.turnId = params.turnId;
      // Multiple requests may arrive together. Queue them for a Worker
      // inference round; none execute inside this bridge.
      if (session.response) scheduleTools(session);
      return;
    }
    if (!session) return;
    if (params.turnId && session.turnId && params.turnId !== session.turnId) return;
    if (message.method === 'turn/started') { session.turnId = params.turn.id; session.active = true; }
    else if (message.method === 'item/agentMessage/delta' && session.response && typeof params.delta === 'string') {
      session.outputBytes += Buffer.byteLength(params.delta);
      const remaining = 6000 - session.textLength;
      if (remaining > 0) {
        const content = params.delta.slice(0, remaining); session.textLength += content.length;
        emit(session, { choices: [{ delta: { content } }] });
      }
      if (session.outputBytes > session.maxTokens * 8) terminate(session, 'build_budget_exceeded');
    } else if (message.method === 'thread/tokenUsage/updated') {
      const total = params.tokenUsage?.total;
      if (Number.isSafeInteger(total?.inputTokens) && total.inputTokens >= 0
        && Number.isSafeInteger(total?.outputTokens) && total.outputTokens >= 0) { session.usage = total; session.usageVersion++; }
    } else if (message.method === 'turn/completed') {
      session.active = false;
      if (params.turn.status !== 'completed' || session.pending.size) {
        terminate(session, params.turn.status === 'interrupted' ? 'build_interrupted' : 'build_failed');
      } else if (session.response) finish(session, 'stop');
    } else if ((message.method === 'error' && !params.willRetry) || message.method === 'thread/closed') {
      terminate(session, 'build_inference_disconnected');
    } else if (message.method === 'item/started' && ['commandExecution', 'fileChange', 'mcpToolCall', 'collabToolCall', 'webSearch'].includes(params.item?.type)) {
      terminate(session, 'invalid_model_response');
    }
  }
  function scheduleTools(session) {
    if (session.toolsScheduled) return;
    session.toolsScheduled = true;
    // Collect calls emitted together into the existing eight-call response
    // limit, so one parallel edit batch uses one Mainbrella inference round.
    session.toolDeliveryTimer = setTimeout(() => {
      session.toolsScheduled = false;
      if (!sessions.has(session.id) || !session.response) return;
      try {
        const pending = [...session.pending.values()].filter(value => !value.delivered).slice(0, 8);
        if (!pending.length) return;
        for (const value of pending) value.delivered = true;
        session.outputBytes += Buffer.byteLength(JSON.stringify(pending.map(value => value.call)));
        emit(session, { choices: [{ delta: { tool_calls: pending.map((value, index) => ({ index, ...value.call })) } }] });
        finish(session, 'tool_calls');
      } catch (error) { terminate(session, error.code || 'build_inference_disconnected'); }
    }, 10);
  }
  async function inference(session, body) {
    const { messages, tools, maxTokens } = body;
    if (!Array.isArray(messages) || !messages.length || messages.length > 160
      || messages.some(message => !message || !['system', 'user', 'assistant', 'tool'].includes(message.role)
        || message.content !== null && typeof message.content !== 'string')
      || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192
      || !Array.isArray(tools) || tools.length !== toolNames.length
      || new Set(tools.map(tool => tool.function?.name)).size !== toolNames.length
      || tools.some(tool => tool.type !== 'function' || !toolNames.includes(tool.function?.name)
        || typeof tool.function.description !== 'string' || !tool.function.parameters)) throw failure('invalid_model_response');
    clearTimeout(session.idleTimer);
    session.maxTokens = maxTokens; session.textLength = 0; session.outputBytes = 0;
    session.usageVersionAtStart = session.usageVersion;
    session.inputBytes = Buffer.byteLength(JSON.stringify(messages));
    session.requestTimer = setTimeout(() => terminate(session, 'build_inference_timeout'), requestTimeoutMs);
    if (!session.threadId) {
      if (messages.some(message => message.role === 'tool' || message.role === 'assistant')) throw failure('build_inference_disconnected');
      const result = await rpc.request('thread/start', { cwd, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true,
        config, baseInstructions: messages.filter(message => message.role === 'system').map(message => message.content).join('\n'),
        developerInstructions: 'Use only the six Mainbrella dynamic tools. Mainbrella owns source persistence, tool execution, compiler repair and preview lifecycle. Do not use local shell, filesystem, browsing, plugins or other tools.',
        dynamicTools: tools.map(tool => ({ type: 'function', name: tool.function.name,
          description: tool.function.description, inputSchema: tool.function.parameters, deferLoading: false })) });
      if (!sessions.has(session.id)) {
        await rpc.request('thread/unsubscribe', { threadId: result.thread.id }, 1000).catch(() => {}); return;
      }
      session.threadId = result.thread.id; threads.set(session.threadId, session);
    }
    if (messages.length < session.messageCount || JSON.stringify(messages.slice(0, session.messageCount)) !== session.history) throw failure('invalid_model_response');
    const added = messages.slice(session.messageCount);
    session.messageCount = messages.length; session.history = JSON.stringify(messages);
    const outputs = added.filter(message => message.role === 'tool');
    if (session.active) {
      const delivered = [...session.pending.values()].filter(value => value.delivered);
      if (!delivered.length || outputs.length !== delivered.length || added.some(message => message.role === 'user' || message.role === 'system')) throw failure('invalid_model_response');
      for (const pending of delivered) {
        const output = outputs.find(message => message.tool_call_id === pending.call.id);
        if (!output || typeof output.content !== 'string') throw failure('invalid_model_response');
        session.pending.delete(pending.call.id);
        rpc.send({ id: pending.id, result: toolResult(output.content, output.tool_success !== false) });
      }
      if (session.pending.size) scheduleTools(session);
    } else {
      if (outputs.length) throw failure('build_inference_disconnected');
      const input = added.filter(message => message.role === 'user').map(message => ({ type: 'text', text: message.content, text_elements: [] }));
      if (!input.length) throw failure('invalid_model_response');
      session.active = true; session.turnId = null;
      const result = await rpc.request('turn/start', { threadId: session.threadId, input });
      if (!sessions.has(session.id)) {
        await rpc.request('turn/interrupt', { threadId: session.threadId, turnId: result.turn.id }, 1000).catch(() => {});
        return;
      }
      // A fast turn may already have completed through notifications.
      session.turnId ??= result.turn.id;
    }
  }
  const server = createServer(async (request, response) => {
    response.on('error', () => {});
    if (closing || rpc.closed) { response.writeHead(503); response.end(); return; }
    if (request.headers.authorization !== `Bearer ${token}` || request.headers.origin) { response.writeHead(403); response.end(); return; }
    const match = /^\/sessions\/([A-Za-z0-9_-]{1,128})$/.exec(request.url ?? '');
    if (!match || !['POST', 'DELETE'].includes(request.method)) { response.writeHead(404); response.end(); return; }
    const id = match[1];
    if (request.method === 'DELETE') {
      const session = sessions.get(id); if (session) terminate(session, 'build_interrupted');
      response.writeHead(204); response.end(); return;
    }
    let session = sessions.get(id);
    if (session?.response) { response.writeHead(409); response.end(); return; }
    try {
      if (request.headers['content-type'] !== 'application/json') throw failure('invalid_model_response');
      let length = 0; const chunks = [];
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 320 * 1024) throw failure('invalid_model_response');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      // Reserve the session after parsing, before any asynchronous protocol work.
      session = sessions.get(id);
      if (session?.response) { response.writeHead(409); response.end(); return; }
      if (!session) {
        if (sessions.size >= 8) { response.writeHead(503); response.end(); return; }
        session = { id, pending: new Map(), messageCount: 0, history: '[]', active: false,
          reportedUsage: { inputTokens: 0, outputTokens: 0 }, usageVersion: 0 };
        sessions.set(id, session);
        session.lifetimeTimer = setTimeout(() => terminate(session, 'build_budget_exceeded'), lifetimeMs);
      }
      session.response = response;
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' }); response.flushHeaders();
      const current = session;
      response.on('close', () => { if (current.response === response) terminate(current, 'build_inference_disconnected'); });
      await inference(session, body);
    } catch (error) {
      if (session && session.response === response) terminate(session, error.code || 'invalid_model_response');
      else { response.writeHead(400); response.end(); }
    }
  });
  server.requestTimeout = 15_000;
  let closePromise;
  function close() {
    return closePromise ??= (async () => {
      closing = true;
      signal?.removeEventListener('abort', abort);
      for (const session of [...sessions.values()]) terminate(session, 'build_interrupted');
      const stopped = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await rpc.close(); await stopped; await rm(cwd, { recursive: true, force: true });
    })();
  }
  try {
    await rpc.request('initialize', { clientInfo: { name: 'mainbrella_local_build', title: 'Mainbrella Local Build', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    rpc.send({ method: 'initialized', params: {} });
    const account = await rpc.request('account/read', { refreshToken: false });
    if (account.requiresOpenaiAuth !== false && !account.account) throw new Error('Codex is not signed in. Run codex login, then restart dev.');
    const settings = await rpc.request('config/read', { includeLayers: false });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return { url: `http://127.0.0.1:${server.address().port}`, token, model: `codex/${settings.config?.model || 'default'}`, close };
  } catch (error) {
    await close();
    throw new Error(error.code ? 'Could not initialize codex app-server. Check CODEX_PATH and codex login.' : error.message);
  }
}

function toml(value) {
  if (value && typeof value === 'object') return `{ ${Object.entries(value).map(([key, item]) => `${key} = ${toml(item)}`).join(', ')} }`;
  return JSON.stringify(value);
}
