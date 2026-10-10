import type { WorkflowStep } from 'cloudflare:workers';
import { accountResponse, runningContainer } from './container-service';
import { resolveEntitlement } from './entitlements';
import { handleOwnedPreviewRequest } from '../app/previews';
import { failBuildTurn } from '../app/build';
import { buildInference, buildSystemPrompt, buildFirstVersionPrompt, buildToolSchemas, type BuildAIMessage, type BuildAIResult, type BuildToolCall } from './build-ai';
import { buildToolDraftLabel, buildToolLabel, saveBuildActivity } from './build-activity';
import { closeCodexInference, localCodexConfigured } from './build-codex';
import { settleReportedBuildUsage } from './build-billing';
import { buildFailure, failureError, proposeBuildOperation, startBuildOperation, readBuildOperation, recordBuildOperation,
  retainBuildSource, type OperationResult, type OperationStatus } from './build-journal';
import { buildImageBytes, buildImagePath, generateBuildImage, savedBuildImages } from './build-images';
import { BUILD_INPUT_BUDGET, BUILD_OUTPUT_BUDGET, BUILD_MAX_ROUNDS, BuildError, buildStarter, ownedBuildApp, validateBuildFiles,
  type BuildParams, type BuildFiles, type BuildContainer, type BuildTurnRow, type BuildPreview } from './build-contract';

type Step = Pick<WorkflowStep, 'do' | 'sleep'>;
type Execution = { id: string; status: string; stdout: string; stderr: string; exitCode?: number };
const noRetry = { retries: { limit: 0, delay: '1 second' }, timeout: '5 minutes' } as const;
const retry = { retries: { limit: 2, delay: '2 seconds', backoff: 'exponential' }, timeout: '1 minute' } as const;
const shellQuote = (text: string) => `'${text.replace(/'/g, `'"'"'`)}'`;
const root = '/workspace/app';
const install = `cd ${root} && npm install --no-audit --no-fund --include=dev`;
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

async function runCommand(env: Env, params: BuildParams, container: BuildContainer, step: Step, label: string, command: string, timeoutMs = 300_000, files?: BuildFiles): Promise<Execution> {
  const ref = { params, id: label };
  const execution = await step.do(`${label}: start`, retry, async () => {
    await proposeBuildOperation(env, ref, 'command', label, { command, timeoutMs, containerId: container.id, containerGeneration: container.createdAt });
    const previous = await readBuildOperation(env, ref);
    if (previous?.evidence_json) {
      const evidence = JSON.parse(previous.evidence_json);
      if (evidence.executionId) return { id: evidence.executionId } as Execution;
    }
    if (previous?.status === 'proposed') await startBuildOperation(env, ref, 'command', label);
    if (files) await retainBuildSource(env, ref, files);
    const { stub, headers } = await machine(env, params.userId, container);
    await recordBuildOperation(env, ref, { dispatchAttempted: true });
    const result = await json<Execution>(await stub.fetch(new Request('https://internal/executions', { method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'Idempotency-Key': `build-${params.turnId}-${label.replace(/[^a-zA-Z0-9_-]/g, '-')}` }, body: JSON.stringify({ command, timeoutMs }) })));
    await recordBuildOperation(env, ref, { evidence: { executionId: result.id } });
    return result;
  });
  for (let poll = 0; poll < 70; poll++) {
    const result = await step.do(`${label}: inspect ${poll}`, retry, async () => {
      const { stub, headers } = await machine(env, params.userId, container);
      return json<Execution>(await stub.fetch(new Request(`https://internal/executions/${execution.id}`, { headers })));
    });
    if (!['starting', 'running'].includes(result.status)) {
      await step.do(`${label}: retain logs`, retry, async () => {
        await recordBuildOperation(env, ref, { status: result.status === 'succeeded' ? 'succeeded' : 'failed', finished: true,
          evidence: { executionId: result.id, executionStatus: result.status, exitCode: result.exitCode ?? null,
            stdout: (result.stdout || '').slice(-6000), stderr: (result.stderr || '').slice(-6000) }, result: { ok: true, value: { ...result, stdout: (result.stdout || '').slice(-6000), stderr: (result.stderr || '').slice(-6000) } } });
        await env.DB.prepare('UPDATE build_turns SET log = ? WHERE id = ? AND user_id = ?')
          .bind(`${result.status}\n${result.stdout || ''}\n${result.stderr || ''}`.slice(-12_000), params.turnId, params.userId).run();
      });
      return result;
    }
    await step.sleep(`${label}: wait ${poll}`, '5 seconds');
  }
  const error = new BuildError('build_command_timeout'); error.operationId = label; throw error;
}
async function writeGuestFile(env: Env, userId: string, container: BuildContainer, path: string, content: string | Uint8Array<ArrayBuffer>) {
  const { stub, headers } = await machine(env, userId, container);
  const url = new URL('https://internal/files'); url.searchParams.set('path', path);
  await json(await stub.fetch(new Request(url, { method: 'PUT', headers, body: content })));
}
async function materialize(env: Env, params: BuildParams, container: BuildContainer, files: BuildFiles, step: Step, label: string) {
  validateBuildFiles(files);
  const directories = [...new Set(Object.keys(files).filter(path => path.includes('/')).map(path => `${root}/${path.slice(0, path.lastIndexOf('/'))}`))];
  const setup = await runCommand(env, params, container, step, `${label}-directories`, `mkdir -p ${shellQuote(`${root}/public/generated`)} ${directories.map(shellQuote).join(' ')}`, 30_000);
  if (setup.status !== 'succeeded') throw new BuildError('build_runtime_unavailable');
  // A retry overwrites exactly the same bytes; generated text never enters a shell.
  await step.do(`${label}: files`, retry, async () => {
    for (const [path, content] of Object.entries(files)) await writeGuestFile(env, params.userId, container, `${root}/${path}`, content);
    for (const image of await savedBuildImages(env, params.appId)) {
      await writeGuestFile(env, params.userId, container, `${root}/public${buildImagePath(image.id)}`, buildImageBytes(image.data));
    }
    await writeGuestFile(env, params.userId, container, '/workspace/mainbrella-build-server.cjs', buildStaticServer);
  });
}
async function saveSource(env: Env, params: BuildParams, files: BuildFiles) {
  validateBuildFiles(files);
  await env.DB.prepare('UPDATE build_apps SET source_json = ?, updated_at = ? WHERE id = ? AND user_id = ? AND active_turn_id = ?')
    .bind(JSON.stringify(files), new Date().toISOString(), params.appId, params.userId, params.turnId).run();
}
async function executeTool(env: Env, params: BuildParams, container: BuildContainer | undefined, files: BuildFiles, call: BuildToolCall, step: Step, label: string, logs: string): Promise<{ files: BuildFiles; output: string; logs: string; succeeded: boolean; state?: OperationStatus }> {
  const schema = buildToolSchemas[call.function.name as keyof typeof buildToolSchemas];
  let args: Record<string, string>;
  try {
    const parsed = schema?.safeParse(JSON.parse(call.function.arguments));
    if (!parsed?.success) return { files, output: 'Invalid tool or arguments. Use the documented tools and relative source paths.', logs, succeeded: false, state: 'blocked' };
    args = parsed.data;
  } catch { return { files, output: 'Arguments must be valid JSON.', logs, succeeded: false, state: 'blocked' }; }
  if (call.function.name === 'generate_image') {
    const failure = { error: 'Could not generate this image. Continue building with CSS or reuse a saved image; do not substitute stock imagery.', state: 'unknown' as OperationStatus };
    const result = await step.do(`${label}: generate image`, { ...noRetry, timeout: '1 minute' }, async () => {
      try { return { image: await generateBuildImage(env, params, label, args.label, args.prompt) }; }
      catch {
        const operation = await readBuildOperation(env, { params, id: `image-${label}` });
        return { ...failure, state: operation?.status ?? 'unknown' };
      }
    }).catch(() => failure);
    return { files, output: 'image' in result ? JSON.stringify(result.image) : result.error, logs, succeeded: 'image' in result, state: 'image' in result ? 'succeeded' : result.state };
  }
  if (call.function.name === 'list_files') return { files, output: Object.keys(files).join('\n'), logs, succeeded: true };
  if (call.function.name === 'read_file') return { files, output: files[args.path] ?? 'File not found.', logs, succeeded: Object.hasOwn(files, args.path) };
  if (call.function.name === 'get_logs') return { files, output: logs || 'No commands have run yet.', logs, succeeded: true };
  if (call.function.name === 'run_command') {
    if (!container) throw new BuildError('build_runtime_unavailable');
    await materialize(env, params, container, files, step, `${label}-source`);
    // A fresh sandbox has no project dependencies. The model may ask to build
    // directly, so installation is a platform prerequisite, not a model duty.
    const installed = await runCommand(env, params, container, step,
      args.command === 'npm install' ? `${label}-command` : `${label}-install`, install, 300_000, files);
    const result = args.command === 'npm run build' && installed.status === 'succeeded'
      ? await runCommand(env, params, container, step, `${label}-command`, compile, 300_000, files) : installed;
    const output = `${result.status}\n${result.stdout || ''}\n${result.stderr || ''}`.slice(-12_000);
    return { files, output, logs: output, succeeded: result.status === 'succeeded' };
  }
  const next = { ...files };
  if (call.function.name === 'delete_file') delete next[args.path]; else next[args.path] = args.content;
  try { validateBuildFiles(next); } catch { return { files, output: 'Source limit exceeded. Keep each file below 64 KiB and the project below 256 KiB / 80 files.', logs, succeeded: false, state: 'blocked' }; }
  await step.do(`${label}: save source`, retry, async () => {
    const ref = { params, id: `${label}-source` };
    await proposeBuildOperation(env, ref, 'source', `Save ${args.path}`);
    await recordBuildOperation(env, ref, { status: 'unknown', started: true });
    await retainBuildSource(env, ref, next, [args.path]);
    await saveSource(env, params, next);
    await recordBuildOperation(env, ref, { status: 'succeeded', finished: true });
  });
  if (call.function.name === 'delete_file' && container) {
    const removed = await runCommand(env, params, container, step, `${label}-delete`, `rm -f -- ${shellQuote(`${root}/${args.path}`)}`, 30_000);
    if (removed.status !== 'succeeded') throw new BuildError('build_runtime_unavailable');
  }
  return { files: next, output: 'Saved.', logs, succeeded: true };
}

export async function runBuildAgent(env: Env, params: BuildParams, step: Step, startedAt: number) {
  let currentOperation: string | null = null;
  async function stopForLimit(limitName: string, limit: number, reason: string, observed: number, counters: Record<string, number>) {
    const id = `limit-${limitName}`;
    const error = new BuildError('build_budget_exceeded', 503, reason);
    error.operationId = id;
    const ref = { params, id };
    await proposeBuildOperation(env, ref, 'tool', `Build stopped: ${reason}`, { limit, limitName, observed, reason, counters });
    await recordBuildOperation(env, ref, { status: 'blocked', finished: true, result: { ok: false, failure: buildFailure(error, id) } });
    throw error;
  }
  async function settleUsage(label: string) {
    try { await step.do(label, retry, async () => settleReportedBuildUsage(env, params.turnId)); return null; }
    catch (error) { return buildFailure(error, label); }
  }
  try {
    const initial = await step.do('Load build', retry, async () => {
      const app = await ownedBuildApp(env, params.userId, params.appId);
      const turn = await env.DB.prepare('SELECT * FROM build_turns WHERE id = ? AND app_id = ? AND user_id = ?').bind(params.turnId, params.appId, params.userId).first<BuildTurnRow>();
      if (!app || !turn || app.active_turn_id !== params.turnId) throw new BuildError('build_interrupted', 409);
      const { results: images } = await env.DB.prepare('SELECT id, label FROM build_images WHERE app_id = ? ORDER BY rowid').bind(params.appId).all<{ id: string; label: string }>();
      return { app, turn, images };
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
    const starterContext = JSON.stringify(files) === JSON.stringify(buildStarter)
      ? `\nStarter source (already supplied; begin editing without listing or reading these files):\n${JSON.stringify(files)}\n` : '';
    const messages: BuildAIMessage[] = [{ role: 'system', content: `${buildSystemPrompt}${initial.turn.base_revision === 0 ? `\n${buildFirstVersionPrompt}` : ''}` },
      { role: 'user', content: `Current source files:\n${Object.keys(files).join('\n')}${starterContext}\nSaved original images:\n${initial.images.map(image => `${buildImagePath(image.id)}: ${image.label}`).join('\n') || 'None yet.'}\nOriginal brief:\n${initial.app.initial_prompt}\n\nRequest:\n${initial.turn.prompt}` }];
    let verified = false;
    for (let round = 0; round < BUILD_MAX_ROUNDS; round++) {
      if (initial.turn.mode === 'build') {
        const remaining = BUILD_OUTPUT_BUDGET - outputTokens;
        if (remaining < 1024) await stopForLimit('output-tokens', 1024, `The build used ${outputTokens.toLocaleString()} of ${BUILD_OUTPUT_BUDGET.toLocaleString()} output tokens, leaving ${remaining.toLocaleString()}. At least 1,024 tokens must remain to request another model response.`, remaining,
          { outputTokens, inputTokens, rounds: round });
        if (inputTokens >= BUILD_INPUT_BUDGET) await stopForLimit('input-tokens', BUILD_INPUT_BUDGET, `The build used ${inputTokens.toLocaleString()} input tokens, reaching its ${BUILD_INPUT_BUDGET.toLocaleString()} token limit.`, inputTokens,
          { outputTokens, inputTokens, rounds: round });
        const contextBytes = new TextEncoder().encode(JSON.stringify(messages)).length;
        if (contextBytes > 192 * 1024) await stopForLimit('context-size', 192 * 1024, `The model conversation reached ${contextBytes.toLocaleString()} bytes, above the ${ (192 * 1024).toLocaleString()} byte context limit.`, contextBytes,
          { outputTokens, inputTokens, rounds: round });
        currentOperation = `text-${round}`;
        const result = await step.do(`AI ${round}`, noRetry, async (): Promise<OperationResult<BuildAIResult>> => {
          try {
            const elapsedMs = Date.now() - startedAt;
            if (elapsedMs > 30 * 60_000) await stopForLimit('elapsed-time', 30 * 60_000, `The build ran for ${Math.floor(elapsedMs / 60_000)} minutes, above its 30 minute time limit.`, elapsedMs,
              { outputTokens, inputTokens, rounds: round, elapsedMs });
            await stage(env, params, round === 0 ? 'Building your app' : 'Editing and checking');
            const publicLabels = new Map<string, string>();
            const proposedTools = new Set<string>();
            const result = await buildInference(env, messages, Math.min(8192, remaining), async (text, calls) => {
              if (text && publicLabels.get(`ai-${round}`) !== text) {
                await saveBuildActivity(env, params, round * 10, { id: `ai-${round}`, type: 'message', text, status: 'running' });
                publicLabels.set(`ai-${round}`, text);
              }
              for (const [index, call] of calls.entries()) {
                if (!call?.function.name) continue;
                const id = `tool-${round}-${index}`;
                const display = buildToolDraftLabel(call.function.name, call.function.arguments);
                if (publicLabels.get(id) !== display) {
                  await saveBuildActivity(env, params, round * 10 + index + 1,
                    { id, type: 'tool', text: display, status: 'proposed' });
                  publicLabels.set(id, display);
                }
                const proposalKey = `${id}:${call.function.name}`;
                if (call.id && !proposedTools.has(proposalKey)) {
                  await proposeBuildOperation(env, { params, id }, 'tool', buildToolLabel(call.function.name, call.function.arguments),
                    { toolName: call.function.name, inferenceOperationId: `text-${round}` });
                  proposedTools.add(proposalKey);
                }
              }
            }, params.turnId, { params, operation: `text-${round}`, model: initial.turn.model, effort: initial.turn.effort });
            if (result.message.content) {
              try { await saveBuildActivity(env, params, round * 10,
                { id: `ai-${round}`, type: 'message', text: result.message.content, status: 'succeeded' }); } catch { /* Optional display. */ }
            }
            return { ok: true, value: result };
          } catch (error) {
            return { ok: false, failure: buildFailure(error, `text-${round}`) };
          }
        });
        const settlementFailure = await settleUsage(`Settle AI usage ${round}`);
        if (!result.ok) throw failureError(result.failure);
        if (settlementFailure) throw failureError(settlementFailure);
        const inference = result.value;
        inputTokens += inference.inputTokens; outputTokens += inference.outputTokens;
        messages.push(inference.message);
        await step.do(`Record AI usage ${round}`, retry, async () => {
          await env.DB.prepare('UPDATE build_turns SET input_tokens = ?, output_tokens = ? WHERE id = ? AND user_id = ?').bind(inputTokens, outputTokens, params.turnId, params.userId).run();
        });
        if (inference.message.tool_calls?.length) {
          for (let index = 0; index < inference.message.tool_calls.length; index++) {
            const call = inference.message.tool_calls[index];
            const activity = { id: `tool-${round}-${index}`, type: 'tool' as const, text: buildToolLabel(call.function.name, call.function.arguments) };
            currentOperation = activity.id;
            await step.do(`Tool stage ${round}-${index}`, retry, async () => {
              await startBuildOperation(env, { params, id: activity.id }, 'tool', activity.text, { toolName: call.function.name, arguments: call.function.arguments.slice(0, 4000) });
              await stage(env, params, activity.text);
              try { await saveBuildActivity(env, params, round * 10 + index + 1, { ...activity, status: 'running' }); } catch { /* Optional display. */ }
            });
            if (call.function.name === 'run_command') {
              await sandbox();
              await step.do(`Command stage ${round}-${index}`, retry, async () => stage(env, params, activity.text));
            }
            const output = await executeTool(env, params, container, files, call, step, `tool-${round}-${index}`, logs);
            const toolSettlementFailure = await settleUsage(`Settle tool usage ${round}-${index}`);
            await step.do(`Tool complete ${round}-${index}`, retry, async () => {
              const state = output.state ?? (output.succeeded ? 'succeeded' : 'failed');
              await recordBuildOperation(env, { params, id: activity.id }, { status: state, finished: true,
                evidence: { output: output.output.slice(-6000) }, result: { ok: true, value: { succeeded: output.succeeded } } });
              try { await saveBuildActivity(env, params, round * 10 + index + 1, { ...activity, status: state }); } catch { /* Optional display. */ }
            });
            if (toolSettlementFailure) throw failureError(toolSettlementFailure);
            files = output.files; logs = output.logs;
            messages.push({ role: 'tool', tool_call_id: call.id, content: output.output, tool_success: output.succeeded });
          }
          continue;
        }
        summary = inference.message.content || 'App updated.';
        if (JSON.stringify(files) === initial.app.source_json && initial.app.revision === 0) {
          messages.push({ role: 'user', content: 'You have not edited any files yet. Implement the requested app using write_file before finishing.' });
          continue;
        }
      }
      const ready = await sandbox();
      await step.do(`Check stage ${round}`, retry, async () => stage(env, params, 'Installing dependencies'));
      await materialize(env, params, ready, files, step, `check-${round}`);
      currentOperation = `install-${round}`;
      const installed = await runCommand(env, params, ready, step, currentOperation, install, 300_000, files);
      await step.do(`Compile stage ${round}`, retry, async () => stage(env, params, 'Checking the app'));
      if (installed.status === 'succeeded') currentOperation = `compile-${round}`;
      const built = installed.status === 'succeeded' ? await runCommand(env, params, ready, step, currentOperation!, compile, 300_000, files) : installed;
      logs = `${built.status}\n${built.stdout || ''}\n${built.stderr || ''}`.slice(-12_000);
      if (built.status === 'succeeded') { verified = true; break; }
      if (initial.turn.mode === 'preview') throw new BuildError('build_check_failed');
      messages.push({ role: 'user', content: `The platform build check failed. Inspect the source, fix these errors and try again:\n${logs}` });
    }
    if (!verified) await stopForLimit('round-limit', BUILD_MAX_ROUNDS, `The build used all ${BUILD_MAX_ROUNDS} repair rounds without a successful verification.`, BUILD_MAX_ROUNDS,
      { outputTokens, inputTokens, rounds: BUILD_MAX_ROUNDS });
    await step.do('Preview stage', retry, async () => stage(env, params, 'Starting preview'));
    const ready = await sandbox();
    currentOperation = 'start-preview';
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
    const details = (error instanceof BuildError ? error.details : error instanceof Error ? error.message : typeof error === 'string' ? error : '')?.trim().slice(0, 4000);
    console.error('build_turn_failed', { appId: params.appId, turnId: params.turnId, error: code });
    await step.do('Record build failure', retry, async () => {
      if (details && details !== code) {
        // Preserve the command output and underlying failure without changing
        // the public error code or requiring a new storage field.
        const output = `\n\n${details}`;
        await env.DB.prepare("UPDATE build_turns SET log = substr(log || ?, -12000) WHERE id = ? AND user_id = ? AND status IN ('queued', 'running') AND substr(log, -length(?)) != ?")
          .bind(output, params.turnId, params.userId, output, output).run();
      }
      await failBuildTurn(env, { id: params.turnId, app_id: params.appId, user_id: params.userId }, code, error instanceof BuildError ? error.operationId ?? currentOperation : currentOperation);
    });
  } finally {
    // Secondary failures are retained independently and cannot replace the turn's cause.
    await settleUsage('Settle remaining AI usage');
    if (localCodexConfigured(env)) {
      const ref = { params, id: 'cleanup-local-inference' };
      await step.do('Close local inference', { ...noRetry, timeout: '10 seconds' }, async () => {
        await proposeBuildOperation(env, ref, 'cleanup', 'Close local inference');
        try {
          await recordBuildOperation(env, ref, { status: 'unknown', started: true, dispatchAttempted: true });
          await closeCodexInference(env, params.turnId);
          await recordBuildOperation(env, ref, { status: 'succeeded', finished: true });
        } catch (error) {
          await recordBuildOperation(env, ref, { status: 'failed', finished: true, result: { ok: false, failure: buildFailure(error, ref.id) } });
        }
      }).catch(() => { console.error('build_cleanup_unavailable', { turnId: params.turnId }); });
    }
  }
}
