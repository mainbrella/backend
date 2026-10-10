import type { WorkflowStep } from 'cloudflare:workers';
import { accountResponse, runningContainer } from './container-service';
import { resolveEntitlement } from './entitlements';
import { handleOwnedPreviewRequest } from '../app/previews';
import { failBuildTurn } from '../app/build';
import { buildInference, buildSystemPrompt, buildToolSchemas, type BuildAIMessage, type BuildToolCall } from './build-ai';
import { buildToolLabel, saveBuildActivity } from './build-activity';
import { BUILD_INPUT_BUDGET, BUILD_OUTPUT_BUDGET, BUILD_MAX_ROUNDS, BuildError, ownedBuildApp, validateBuildFiles,
  type BuildParams, type BuildFiles, type BuildContainer, type BuildTurnRow, type BuildPreview } from './build-contract';

type Step = Pick<WorkflowStep, 'do' | 'sleep'>;
type Execution = { id: string; status: string; stdout: string; stderr: string; exitCode?: number };
const noRetry = { retries: { limit: 0, delay: '1 second' }, timeout: '5 minutes' } as const;
const retry = { retries: { limit: 2, delay: '2 seconds', backoff: 'exponential' }, timeout: '1 minute' } as const;
const shellQuote = (text: string) => `'${text.replace(/'/g, `'"'"'`)}'`;
const root = '/workspace/app';
const install = `cd ${root} && npm install --no-audit --no-fund`;
const compile = `cd ${root} && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vite build`;
// Serve compiled files rather than a development server. The app's own package
// scripts never decide whether the platform's production build check passed.
export const buildStaticServer = `const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = '/workspace/app/dist';
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.ico':'image/x-icon', '.woff2':'font/woff2' };
http.createServer((req,res) => {
  if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
  let requested;
  try { requested = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { res.writeHead(400); return res.end(); }
  let file = path.resolve(root, '.' + requested);
  if (!file.startsWith(root + '/') && file !== root) { res.writeHead(403); return res.end(); }
  try {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) file = root + '/index.html';
    if (!fs.realpathSync(file).startsWith(root + '/')) { res.writeHead(403); return res.end(); }
    const data = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(3000, '0.0.0.0');`;
const startPreview = `tmux kill-session -t mainbrella-build-preview 2>/dev/null || true
tmux new-session -d -s mainbrella-build-preview 'node /workspace/mainbrella-build-server.cjs > /workspace/mainbrella-build-preview.log 2>&1'
for attempt in $(seq 1 30); do
  if curl --fail --silent --max-time 2 http://127.0.0.1:3000/ >/dev/null; then exit 0; fi
  sleep 1
done
cat /workspace/mainbrella-build-preview.log
exit 1`;

async function json<T>(response: Response): Promise<T> {
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new BuildError(data.error || 'build_runtime_unavailable', response.status);
  return data;
}
async function machine(env: Env, userId: string, container: BuildContainer) {
  const running = await runningContainer(env, userId, container.id);
  if (!running.stub || running.container?.createdAt !== container.createdAt || Date.parse(running.container.expiresAt) <= Date.now()) throw new BuildError('container_not_running', 409);
  return { stub: running.stub, headers: { 'x-exec-created-at': container.createdAt, 'x-exec-expires-at': String(Date.parse(running.container.expiresAt)) } };
}
async function stage(env: Env, params: BuildParams, text: string) {
  const app = await ownedBuildApp(env, params.userId, params.appId);
  if (!app || app.active_turn_id !== params.turnId) throw new BuildError('build_interrupted', 409);
  await env.DB.prepare("UPDATE build_turns SET status = 'running', stage = ? WHERE id = ? AND user_id = ? AND status IN ('queued', 'running')")
    .bind(text, params.turnId, params.userId).run();
}
async function allocate(env: Env, params: BuildParams): Promise<BuildContainer> {
  const app = await ownedBuildApp(env, params.userId, params.appId);
  if (!app || app.active_turn_id !== params.turnId) throw new BuildError('build_interrupted', 409);
  const entitlement = await resolveEntitlement(env, params.userId);
  if (!entitlement.active) throw new BuildError('subscription_required', 402);
  if (app.container_json) {
    const previous = JSON.parse(app.container_json) as BuildContainer;
    const running = await runningContainer(env, params.userId, previous.id);
    if (running.container?.createdAt === previous.createdAt && Date.parse(running.container.expiresAt) > Date.now()) return { ...previous, expiresAt: running.container.expiresAt };
  }
  const state = await json<{ containers: (BuildContainer & { status: string })[]; creation: { containerId: string; createdAt: string } }>(await accountResponse(env, params.userId, entitlement, 'POST', null, null,
    { name: app.name, imageKey: 'terminal', imageName: 'Node 24 + TypeScript', size: 'small', lifecycle: 'ad_hoc' }, `build-${params.turnId}`));
  const created = state.containers.find(item => item.id === state.creation?.containerId && item.createdAt === state.creation?.createdAt);
  if (!created || created.status !== 'running') throw new BuildError('build_runtime_unavailable');
  const container = { id: created.id, createdAt: created.createdAt, expiresAt: created.expiresAt };
  await env.DB.prepare('UPDATE build_apps SET container_json = ? WHERE id = ? AND user_id = ? AND active_turn_id = ?')
    .bind(JSON.stringify(container), params.appId, params.userId, params.turnId).run();
  return container;
}

async function runCommand(env: Env, params: BuildParams, container: BuildContainer, step: Step, label: string, command: string, timeoutMs = 300_000): Promise<Execution> {
  const execution = await step.do(`${label}: start`, retry, async () => {
    const { stub, headers } = await machine(env, params.userId, container);
    return json<Execution>(await stub.fetch(new Request('https://internal/executions', { method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'Idempotency-Key': `build-${params.turnId}-${label.replace(/[^a-zA-Z0-9_-]/g, '-')}` }, body: JSON.stringify({ command, timeoutMs }) })));
  });
  for (let poll = 0; poll < 70; poll++) {
    const result = await step.do(`${label}: inspect ${poll}`, retry, async () => {
      const { stub, headers } = await machine(env, params.userId, container);
      return json<Execution>(await stub.fetch(new Request(`https://internal/executions/${execution.id}`, { headers })));
    });
    if (!['starting', 'running'].includes(result.status)) {
      await step.do(`${label}: retain logs`, retry, async () => {
        await env.DB.prepare('UPDATE build_turns SET log = ? WHERE id = ? AND user_id = ?')
          .bind(`${result.status}\n${result.stdout || ''}\n${result.stderr || ''}`.slice(-12_000), params.turnId, params.userId).run();
      });
      return result;
    }
    await step.sleep(`${label}: wait ${poll}`, '5 seconds');
  }
  throw new BuildError('build_command_timeout');
}
async function writeGuestFile(env: Env, userId: string, container: BuildContainer, path: string, content: string) {
  const { stub, headers } = await machine(env, userId, container);
  const url = new URL('https://internal/files'); url.searchParams.set('path', path);
  await json(await stub.fetch(new Request(url, { method: 'PUT', headers, body: content })));
}
async function materialize(env: Env, params: BuildParams, container: BuildContainer, files: BuildFiles, step: Step, label: string) {
  validateBuildFiles(files);
  const directories = [...new Set(Object.keys(files).filter(path => path.includes('/')).map(path => `${root}/${path.slice(0, path.lastIndexOf('/'))}`))];
  const setup = await runCommand(env, params, container, step, `${label}-directories`, `mkdir -p ${shellQuote(root)} ${directories.map(shellQuote).join(' ')}`, 30_000);
  if (setup.status !== 'succeeded') throw new BuildError('build_runtime_unavailable');
  // A retry overwrites exactly the same bytes; generated text never enters a shell.
  await step.do(`${label}: files`, retry, async () => {
    for (const [path, content] of Object.entries(files)) await writeGuestFile(env, params.userId, container, `${root}/${path}`, content);
    await writeGuestFile(env, params.userId, container, '/workspace/mainbrella-build-server.cjs', buildStaticServer);
  });
}
async function saveSource(env: Env, params: BuildParams, files: BuildFiles) {
  validateBuildFiles(files);
  await env.DB.prepare('UPDATE build_apps SET source_json = ?, updated_at = ? WHERE id = ? AND user_id = ? AND active_turn_id = ?')
    .bind(JSON.stringify(files), new Date().toISOString(), params.appId, params.userId, params.turnId).run();
}
async function executeTool(env: Env, params: BuildParams, container: BuildContainer | undefined, files: BuildFiles, call: BuildToolCall, step: Step, label: string, logs: string): Promise<{ files: BuildFiles; output: string; logs: string; succeeded: boolean }> {
  const schema = buildToolSchemas[call.function.name as keyof typeof buildToolSchemas];
  let args: Record<string, string>;
  try {
    const parsed = schema?.safeParse(JSON.parse(call.function.arguments));
    if (!parsed?.success) return { files, output: 'Invalid tool or arguments. Use the documented tools and relative source paths.', logs, succeeded: false };
    args = parsed.data;
  } catch { return { files, output: 'Arguments must be valid JSON.', logs, succeeded: false }; }
  if (call.function.name === 'list_files') return { files, output: Object.keys(files).join('\n'), logs, succeeded: true };
  if (call.function.name === 'read_file') return { files, output: files[args.path] ?? 'File not found.', logs, succeeded: Object.hasOwn(files, args.path) };
  if (call.function.name === 'get_logs') return { files, output: logs || 'No commands have run yet.', logs, succeeded: true };
  if (call.function.name === 'run_command') {
    if (!container) throw new BuildError('build_runtime_unavailable');
    await materialize(env, params, container, files, step, `${label}-source`);
    const result = await runCommand(env, params, container, step, label, args.command === 'npm install' ? install : compile);
    const output = `${result.status}\n${result.stdout || ''}\n${result.stderr || ''}`.slice(-12_000);
    return { files, output, logs: output, succeeded: result.status === 'succeeded' };
  }
  const next = { ...files };
  if (call.function.name === 'delete_file') delete next[args.path]; else next[args.path] = args.content;
  try { validateBuildFiles(next); } catch { return { files, output: 'Source limit exceeded. Keep each file below 64 KiB and the project below 256 KiB / 80 files.', logs, succeeded: false }; }
  await step.do(`${label}: save source`, retry, async () => saveSource(env, params, next));
  if (call.function.name === 'delete_file' && container) {
    const removed = await runCommand(env, params, container, step, `${label}-delete`, `rm -f -- ${shellQuote(`${root}/${args.path}`)}`, 30_000);
    if (removed.status !== 'succeeded') throw new BuildError('build_runtime_unavailable');
  }
  return { files: next, output: 'Saved.', logs, succeeded: true };
}

export async function runBuildAgent(env: Env, params: BuildParams, step: Step, startedAt: number) {
  try {
    const initial = await step.do('Load build', retry, async () => {
      const app = await ownedBuildApp(env, params.userId, params.appId);
      const turn = await env.DB.prepare('SELECT * FROM build_turns WHERE id = ? AND app_id = ? AND user_id = ?').bind(params.turnId, params.appId, params.userId).first<BuildTurnRow>();
      if (!app || !turn || app.active_turn_id !== params.turnId) throw new BuildError('build_interrupted', 409);
      return { app, turn };
    });
    let container: BuildContainer | undefined;
    // File inspection and model output can start before the sandbox is ready.
    async function sandbox() {
      if (container) return container;
      await step.do('Allocate stage', retry, async () => stage(env, params, 'Starting sandbox'));
      container = await step.do('Allocate sandbox', retry, async () => {
        // Do not replay allocation after the account's 24-hour key retention.
        if (Date.now() - startedAt > 23 * 60 * 60_000) throw new BuildError('build_interrupted');
        return allocate(env, params);
      });
      // Clear this dedicated app directory; callers materialize the current files.
      const reset = await runCommand(env, params, container, step, 'reset-source', `mkdir -p ${root} && find ${root} -mindepth 1 -maxdepth 1 ! -name node_modules ! -name package-lock.json -exec rm -rf -- {} +`, 30_000);
      if (reset.status !== 'succeeded') throw new BuildError('build_runtime_unavailable');
      return container;
    }
    let files = JSON.parse(initial.app.source_json) as BuildFiles;
    let inputTokens = 0, outputTokens = 0, logs = '', summary = 'Preview restarted from saved source.';
    const messages: BuildAIMessage[] = [{ role: 'system', content: buildSystemPrompt },
      { role: 'user', content: `Current source files:\n${Object.keys(files).join('\n')}\nOriginal brief:\n${initial.app.initial_prompt}\n\nRequest:\n${initial.turn.prompt}` }];
    let verified = false;
    for (let round = 0; round < BUILD_MAX_ROUNDS; round++) {
      if (initial.turn.mode === 'build') {
        const remaining = BUILD_OUTPUT_BUDGET - outputTokens;
        if (remaining < 1024 || inputTokens >= BUILD_INPUT_BUDGET || new TextEncoder().encode(JSON.stringify(messages)).length > 192 * 1024) throw new BuildError('build_budget_exceeded');
        const result = await step.do(`AI ${round}`, noRetry, async () => {
          if (Date.now() - startedAt > 30 * 60_000) throw new BuildError('build_budget_exceeded');
          await stage(env, params, round === 0 ? 'Building your app' : 'Editing and checking');
          const result = await buildInference(env, messages, Math.min(8192, remaining), async (text, calls) => {
            if (text) await saveBuildActivity(env, params, round * 10, { id: `ai-${round}`, type: 'message', text, status: 'running' });
            for (const [index, call] of calls.entries()) {
              if (call?.function.name) await saveBuildActivity(env, params, round * 10 + index + 1,
                { id: `tool-${round}-${index}`, type: 'tool', text: buildToolLabel(call.function.name, call.function.arguments), status: 'running' });
            }
          });
          if (result.message.content) await saveBuildActivity(env, params, round * 10,
            { id: `ai-${round}`, type: 'message', text: result.message.content, status: 'succeeded' });
          return result;
        });
        inputTokens += result.inputTokens; outputTokens += result.outputTokens;
        messages.push(result.message);
        await step.do(`Record AI usage ${round}`, retry, async () => {
          await env.DB.prepare('UPDATE build_turns SET input_tokens = ?, output_tokens = ? WHERE id = ? AND user_id = ?').bind(inputTokens, outputTokens, params.turnId, params.userId).run();
        });
        if (result.message.tool_calls?.length) {
          for (let index = 0; index < result.message.tool_calls.length; index++) {
            const call = result.message.tool_calls[index];
            const activity = { id: `tool-${round}-${index}`, type: 'tool' as const, text: buildToolLabel(call.function.name, call.function.arguments) };
            await step.do(`Tool stage ${round}-${index}`, retry, async () => {
              await stage(env, params, activity.text);
              await saveBuildActivity(env, params, round * 10 + index + 1, { ...activity, status: 'running' });
            });
            if (call.function.name === 'run_command') {
              await sandbox();
              await step.do(`Command stage ${round}-${index}`, retry, async () => stage(env, params, activity.text));
            }
            const output = await executeTool(env, params, container, files, call, step, `tool-${round}-${index}`, logs);
            await step.do(`Tool complete ${round}-${index}`, retry, async () => saveBuildActivity(env, params, round * 10 + index + 1,
              { ...activity, status: output.succeeded ? 'succeeded' : 'failed' }));
            files = output.files; logs = output.logs;
            messages.push({ role: 'tool', tool_call_id: call.id, content: output.output });
          }
          continue;
        }
        summary = result.message.content || 'App updated.';
        if (JSON.stringify(files) === initial.app.source_json && initial.app.revision === 0) {
          messages.push({ role: 'user', content: 'You have not edited any files yet. Implement the requested app using write_file before finishing.' });
          continue;
        }
      }
      const ready = await sandbox();
      await step.do(`Check stage ${round}`, retry, async () => stage(env, params, 'Installing dependencies'));
      await materialize(env, params, ready, files, step, `check-${round}`);
      const installed = await runCommand(env, params, ready, step, `install-${round}`, install);
      await step.do(`Compile stage ${round}`, retry, async () => stage(env, params, 'Checking the app'));
      const built = installed.status === 'succeeded' ? await runCommand(env, params, ready, step, `compile-${round}`, compile) : installed;
      logs = `${built.status}\n${built.stdout || ''}\n${built.stderr || ''}`.slice(-12_000);
      if (built.status === 'succeeded') { verified = true; break; }
      if (initial.turn.mode === 'preview') throw new BuildError('build_check_failed');
      messages.push({ role: 'user', content: `The platform build check failed. Inspect the source, fix these errors and try again:\n${logs}` });
    }
    if (!verified) throw new BuildError('build_budget_exceeded');
    await step.do('Preview stage', retry, async () => stage(env, params, 'Starting preview'));
    const ready = await sandbox();
    const launched = await runCommand(env, params, ready, step, 'start-preview', startPreview, 60_000);
    if (launched.status !== 'succeeded') throw new BuildError('preview_start_failed');
    const preview = await step.do('Create preview', noRetry, async () => {
      const identity = new URLSearchParams({ id: ready.id, createdAt: ready.createdAt });
      return json<BuildPreview>(await handleOwnedPreviewRequest(new Request(`https://api.mainbrella.com/containers/previews?${identity}`, {
        method: 'POST', headers: { Origin: 'https://mainbrella.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ port: 3000, ttlSeconds: 1800 }),
      }), env, params.userId));
    });
    await step.do('Save verified revision', retry, async () => {
      const now = new Date().toISOString();
      const revision = initial.app.revision + (initial.turn.mode === 'build' ? 1 : 0);
      await env.DB.batch([
        ...(initial.turn.mode === 'build' ? [env.DB.prepare('INSERT INTO build_revisions (app_id, revision, turn_id, source_json, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(turn_id) DO NOTHING')
          .bind(params.appId, revision, params.turnId, JSON.stringify(files), now)] : []),
        env.DB.prepare('UPDATE build_apps SET source_json = ?, revision = ?, preview_json = ?, active_turn_id = NULL, updated_at = ? WHERE id = ? AND user_id = ? AND active_turn_id = ?')
          .bind(JSON.stringify(files), revision, JSON.stringify(preview), now, params.appId, params.userId, params.turnId),
        env.DB.prepare("UPDATE build_turns SET status = 'succeeded', stage = 'Preview ready', summary = ?, finished_at = ? WHERE id = ? AND user_id = ?")
          .bind(summary, now, params.turnId, params.userId),
      ]);
    });
  } catch (error) {
    const code = error instanceof BuildError ? error.message : error instanceof Error && error.message === 'subscription_required' ? 'subscription_required' : 'build_failed';
    console.error('build_turn_failed', { appId: params.appId, turnId: params.turnId, error: code });
    await step.do('Record build failure', retry, async () => failBuildTurn(env, { id: params.turnId, app_id: params.appId, user_id: params.userId }, code));
  }
}
