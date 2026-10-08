import { authCorsHeaders, authJson } from './auth-core';
import { containerUser } from './container-auth';
import { handleContainersRequest } from './containers';
import { handleExecutionRequest } from './executions';
import { resolveEntitlement } from '../lib/entitlements';
import { containerError, runningContainer } from '../lib/container-service';
import { validIdempotencyKey } from '../../containers/container-account-core.js';
import { readCommandBody } from '../../containers/command-contract.js';
import { validExecutionId } from '../../containers/execution-contract.js';
import { cloneCommand, launchErrorDetails, launchOptionsSchema, LaunchError, previewCommand, repoCwd, repoName, repoRef,
  resolvePublicRepo, setupCommand, type LaunchOptions, type ResolvedRepo } from '../lib/repo-launch';

export type LaunchPhase = 'allocating' | 'cloning' | 'setup' | 'starting' | 'ready' | 'failed' | 'stopped';
export interface RepoLaunch {
  id: string; phase: LaunchPhase; options: LaunchOptions; repository: ResolvedRepo;
  container: { id: string; createdAt: string; expiresAt: string } | null;
  executions: Partial<Record<'cloning' | 'setup' | 'starting', string>>;
  attempts: Partial<Record<LaunchPhase, number>>;
  createdAt: number; shellReadyAt: number | null; previewReadyAt: number | null; error: string | null;
}
interface Row { state_json: string; request_json: string }
interface LaunchDiagnosticContext {
  stage: string; launchId?: string; phase?: LaunchPhase; containerId?: string; generation?: string; executionId?: string;
}
const terminalPhases = ['ready', 'failed', 'stopped'];
const ownedRow = (env: Env, owner: string, id: string) => env.DB.prepare('SELECT state_json, request_json FROM repo_launches WHERE user_id = ? AND id = ?').bind(owner, id).first<Row>();
function internalRequest(request: Request, path: string, method: string, body?: unknown, key?: string) {
  const headers = new Headers();
  for (const name of ['Origin', 'Authorization', 'Cookie']) { const value = request.headers.get(name); if (value) headers.set(name, value); }
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (key) headers.set('Idempotency-Key', key);
  return new Request(new URL(path, request.url), { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
async function responseData(response: Response): Promise<any> {
  const data = await response.json() as { error?: string };
  if (!response.ok) throw new LaunchError(data.error ?? 'launch_unavailable', response.status);
  return data;
}

async function advance(request: Request, env: Env, owner: string, id: string, diagnostics: LaunchDiagnosticContext, redactions: string[], ctx?: ExecutionContext): Promise<RepoLaunch> {
  diagnostics.launchId = id;
  diagnostics.stage = 'acquire_launch_lock';
  const token = crypto.randomUUID();
  const locked = await env.DB.prepare('UPDATE repo_launches SET lock_token = ?, lock_until = ? WHERE id = ? AND user_id = ? AND lock_until < ?')
    .bind(token, Date.now() + 60_000, id, owner, Date.now()).run();
  diagnostics.stage = 'load_launch';
  const row = await ownedRow(env, owner, id);
  if (!row) throw new LaunchError('launch_not_found', 404);
  diagnostics.stage = 'parse_launch_state';
  const state = JSON.parse(row.state_json) as RepoLaunch;
  redactions.push(...[state.options.setupCommand, state.options.startCommand].filter((value): value is string => Boolean(value)));
  diagnostics.phase = state.phase;
  diagnostics.containerId = state.container?.id;
  diagnostics.generation = state.container?.createdAt;
  if (!locked.meta.changes) return state;
  const save = async () => {
    const previousStage = diagnostics.stage;
    diagnostics.stage = 'save_launch_state';
    diagnostics.phase = state.phase;
    const saved = await env.DB.prepare('UPDATE repo_launches SET state_json = ? WHERE id = ? AND user_id = ? AND lock_token = ?')
      .bind(JSON.stringify(state), id, owner, token).run();
    if (!saved.meta.changes) throw new LaunchError('launch_busy', 409);
    diagnostics.stage = previousStage;
  };
  try {
    if (state.phase === 'stopped') return state;
    if (state.container) {
      diagnostics.stage = 'verify_container_generation';
      const running = await runningContainer(env, owner, state.container.id);
      if (!running.container || running.container.createdAt !== state.container.createdAt || Date.parse(running.container.expiresAt) <= Date.now()) {
        state.phase = 'stopped'; state.error = 'container_not_running'; await save(); return state;
      }
      state.container.expiresAt = running.container.expiresAt;
    }
    if (terminalPhases.includes(state.phase)) return state;
    if (state.phase === 'allocating') {
      // The coordinator retains allocation keys for 24h. Never replay beyond it.
      if (state.attempts.allocating && Date.now() - state.attempts.allocating > 23 * 60 * 60_000) {
        state.phase = 'failed'; state.error = 'allocation_reconciliation_required'; await save(); return state;
      }
      state.attempts.allocating ??= Date.now();
      await save();
      diagnostics.stage = 'allocate_container';
      const catalogId = state.options.catalogId ?? state.repository.suggestedCatalogId;
      const data = await responseData(await handleContainersRequest(internalRequest(request, '/containers', 'POST',
        { catalogId, size: state.options.size, name: state.repository.repo.slice(0, 80) }, `repo-${id}`), env, ctx));
      const container = data.containers?.find((item: any) => item.id === data.creation?.containerId && item.createdAt === data.creation?.createdAt);
      if (!container) throw new LaunchError('launch_unavailable');
      if (container.status !== 'running') return state;
      state.container = { id: container.id, createdAt: container.createdAt, expiresAt: container.expiresAt };
      state.phase = 'cloning';
      await save();
      return state;
    }
    const phase = state.phase as 'cloning' | 'setup' | 'starting';
    const identity = new URLSearchParams({ id: state.container!.id, createdAt: state.container!.createdAt });
    let executionId = state.executions[phase];
    if (!executionId) {
      // Execution keys expire after an hour. An uncertain start is only replayed
      // within that retention window, with the same key AND command body.
      if (state.attempts[phase] && Date.now() - state.attempts[phase]! > 55 * 60_000) {
        state.phase = 'failed'; state.error = 'execution_reconciliation_required'; await save(); return state;
      }
      state.attempts[phase] ??= Date.now();
      await save();
      const command = phase === 'cloning' ? cloneCommand(state.repository) : phase === 'setup' ? setupCommand(state.options) : previewCommand(state.options);
      const timeoutMs = phase === 'cloning' ? 300_000 : phase === 'setup' ? 900_000 : 240_000;
      diagnostics.stage = 'start_execution';
      const execution = await responseData(await handleExecutionRequest(internalRequest(request, `/containers/executions?${identity}`, 'POST',
        { command, timeoutMs }, `repo-${id}-${phase}`), env));
      if (!validExecutionId(execution.id)) throw new LaunchError('launch_unavailable');
      state.executions[phase] = execution.id;
      await save();
      return state;
    }
    diagnostics.stage = 'inspect_execution';
    diagnostics.executionId = executionId;
    const response = await handleExecutionRequest(internalRequest(request, `/containers/executions/${executionId}?${identity}`, 'GET'), env);
    if (response.status === 404) {
      state.phase = 'failed'; state.error = 'execution_history_expired'; await save(); return state;
    }
    const execution = await responseData(response);
    if (['starting', 'running'].includes(execution.status)) return state;
    if (execution.status !== 'succeeded') {
      state.phase = 'failed'; state.error = `${phase}_failed`;
    } else if (phase === 'cloning') {
      state.shellReadyAt = Date.now();
      state.phase = state.options.setupCommand ? 'setup' : state.options.startCommand ? 'starting' : 'ready';
    } else if (phase === 'setup') state.phase = state.options.startCommand ? 'starting' : 'ready';
    else { state.previewReadyAt = Date.now(); state.phase = 'ready'; }
    await save();
    return state;
  } catch (error) {
    if (error instanceof LaunchError && ['creation_no_longer_running', 'container_not_running'].includes(error.message)) {
      state.phase = 'stopped'; state.error = error.message; await save(); return state;
    }
    throw error;
  } finally {
    const previousStage = diagnostics.stage;
    diagnostics.stage = 'release_launch_lock';
    await env.DB.prepare('UPDATE repo_launches SET lock_token = NULL, lock_until = 0 WHERE id = ? AND user_id = ? AND lock_token = ?')
      .bind(id, owner, token).run();
    diagnostics.stage = previousStage;
  }
}

export async function handleRepoLaunchRequest(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const receivedAt = Date.now();
  const cors = authCorsHeaders(request);
  if (cors === null) return authJson({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const url = new URL(request.url);
  const match = /^\/repo-launches(?:\/(resolve|[a-f0-9-]{36})(\/advance)?)?$/.exec(url.pathname);
  if (!match || match[1] && match[1] !== 'resolve' && !validExecutionId(match[1])) return authJson({ error: 'not_found' }, 404, cors);
  const resolve = match[1] === 'resolve';
  const allowed = resolve || match[1] && !match[2] ? 'GET' : 'POST';
  if (request.method !== allowed || resolve && match[2]) return authJson({ error: 'method_not_allowed' }, 405, { ...cors, allow: `${allowed}, OPTIONS` });
  if (request.method === 'POST' && !request.headers.get('Origin') && !request.headers.has('Authorization')) return authJson({ error: 'origin_required' }, 403, cors);
  if ([...url.searchParams.keys()].some(key => !resolve || !['repo', 'ref', 'cwd'].includes(key) || url.searchParams.getAll(key).length !== 1)) return authJson({ error: 'invalid_request' }, 400, cors);
  const requestId = crypto.randomUUID();
  const diagnostics: LaunchDiagnosticContext = { stage: 'authenticate' };
  const redactions = [request.headers.get('Authorization'), request.headers.get('Authorization')?.replace(/^Bearer\s+/i, ''),
    request.headers.get('Cookie'), ...((request.headers.get('Cookie') ?? '').split(';').map(cookie => cookie.slice(cookie.indexOf('=') + 1).trim())),
    env.STRIPE_SECRET_KEY].filter((value): value is string => Boolean(value));
  try {
    const user = await containerUser(env, request);
    if (!user) return authJson({ error: 'not_authenticated' }, 401, cors);
    if (resolve) {
      const repo = repoName.safeParse(url.searchParams.get('repo'));
      const ref = repoRef.optional().safeParse(url.searchParams.get('ref') ?? undefined);
      const cwd = repoCwd.safeParse(url.searchParams.get('cwd') ?? '.');
      if (!repo.success || !ref.success || !cwd.success) return authJson({ error: 'invalid_request' }, 400, cors);
      diagnostics.stage = 'resolve_repository';
      return authJson(await resolvePublicRepo(repo.data, ref.data, cwd.data), 200, cors);
    }
    if (match[1]) {
      if (request.method === 'POST') return authJson(await advance(request, env, user.id, match[1], diagnostics, redactions, ctx), 200, cors);
      diagnostics.stage = 'load_launch';
      diagnostics.launchId = match[1];
      const row = await ownedRow(env, user.id, match[1]);
      return row ? authJson(JSON.parse(row.state_json), 200, cors) : authJson({ error: 'launch_not_found' }, 404, cors);
    }
    const key = request.headers.get('Idempotency-Key');
    if (!validIdempotencyKey(key)) return authJson({ error: 'invalid_idempotency_key' }, 400, cors);
    let body;
    try { body = await readCommandBody(request); } catch (error) {
      const large = error instanceof Error && error.message === 'request_too_large';
      return authJson({ error: large ? 'request_too_large' : 'invalid_request' }, large ? 413 : 400, cors);
    }
    const options = launchOptionsSchema.safeParse(body);
    if (!options.success) return authJson({ error: 'invalid_request' }, 400, cors);
    redactions.push(...[options.data.setupCommand, options.data.startCommand].filter((value): value is string => Boolean(value)));
    const serialized = JSON.stringify(options.data);
    diagnostics.stage = 'load_existing_launch';
    const existing = await env.DB.prepare('SELECT state_json, request_json FROM repo_launches WHERE user_id = ? AND idempotency_key = ?').bind(user.id, key).first<Row>();
    if (existing) return existing.request_json === serialized ? authJson(JSON.parse(existing.state_json), 200, cors)
      : authJson({ error: 'idempotency_key_conflict' }, 409, cors);
    diagnostics.stage = 'check_entitlement';
    if (!(await resolveEntitlement(env, user.id)).active) return authJson({ error: 'subscription_required' }, 402, cors);
    diagnostics.stage = 'resolve_repository';
    const repository = await resolvePublicRepo(options.data.repo, options.data.ref, options.data.cwd);
    const state: RepoLaunch = { id: crypto.randomUUID(), phase: 'allocating', options: options.data, repository, container: null,
      executions: {}, attempts: {}, createdAt: receivedAt, shellReadyAt: null, previewReadyAt: null, error: null };
    diagnostics.stage = 'persist_launch';
    diagnostics.launchId = state.id;
    await env.DB.prepare('INSERT INTO repo_launches (id, user_id, idempotency_key, request_json, state_json, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, idempotency_key) DO NOTHING')
      .bind(state.id, user.id, key, serialized, JSON.stringify(state), state.createdAt).run();
    diagnostics.stage = 'read_persisted_launch';
    const stored = (await env.DB.prepare('SELECT state_json, request_json FROM repo_launches WHERE user_id = ? AND idempotency_key = ?').bind(user.id, key).first<Row>())!;
    return stored.request_json === serialized ? authJson(JSON.parse(stored.state_json), 201, cors) : authJson({ error: 'idempotency_key_conflict' }, 409, cors);
  } catch (error) {
    const failure = error instanceof LaunchError ? { error: error.message, status: error.status } : containerError(error, 'launch_unavailable');
    console.error('repo_launch_request_failed', { requestId, method: request.method, path: url.pathname,
      ...diagnostics, elapsedMs: Date.now() - receivedAt, status: failure.status, errorCode: failure.error,
      error: launchErrorDetails(error, redactions) });
    return authJson({ error: failure.error }, failure.status, cors);
  }
}
