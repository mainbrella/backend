import { authCorsHeaders, authJson, currentUser } from './auth-core';
import { readCommandBody } from '../../containers/command-contract.js';
import { validExecutionId } from '../../containers/execution-contract.js';
import { validIdempotencyKey } from '../../containers/container-account-core.js';
import { resolveEntitlement } from '../lib/entitlements';
import { accountResponse, containerError } from '../lib/container-service';
import { previewsConfigured } from '../lib/preview-routing';
import { BUILD_MODEL, BUILD_MAX_APPS, BUILD_DAILY_TURNS, BuildError, buildCreateSchema, buildRenameSchema, buildTurnSchema,
  buildName, buildStarter, ownedBuildApp, type BuildAppRow, type BuildContainer, type BuildTurnRow, type BuildPreview } from '../lib/build-contract';
import { buildSourceZip } from '../lib/build-zip';

export function buildConfigured(env: Env) {
  return env.BUILD_ENABLED === 'true' && Boolean(env.AI && env.BUILD_WORKFLOW && previewsConfigured(env));
}
function publicApp(row: BuildAppRow, turns?: BuildTurnRow[]) {
  const preview = row.preview_json ? JSON.parse(row.preview_json) as BuildPreview : null;
  return { id: row.id, name: row.name, prompt: row.initial_prompt, revision: row.revision,
    activeTurnId: row.active_turn_id, container: row.container_json ? JSON.parse(row.container_json) as BuildContainer : null,
    preview: preview && preview.expiresAt > Date.now() ? preview : null, createdAt: row.created_at, updatedAt: row.updated_at,
    ...(turns ? { turns: turns.map(turn => ({ id: turn.id, prompt: turn.prompt, mode: turn.mode, status: turn.status,
      stage: turn.stage, summary: turn.summary, error: turn.error, log: turn.log, model: turn.model,
      inputTokens: turn.input_tokens, outputTokens: turn.output_tokens, createdAt: turn.created_at, finishedAt: turn.finished_at })) } : {}),
  };
}
async function detail(env: Env, userId: string, id: string) {
  const row = await ownedBuildApp(env, userId, id);
  if (!row) throw new BuildError('app_not_found', 404);
  const { results } = await env.DB.prepare('SELECT * FROM build_turns WHERE app_id = ? AND user_id = ? ORDER BY created_at, id').bind(id, userId).all<BuildTurnRow>();
  return { app: publicApp(row, results) };
}
async function requireBuildAccess(env: Env, userId: string) {
  if (!buildConfigured(env)) throw new BuildError('build_unavailable');
  if (!(await resolveEntitlement(env, userId)).active) throw new BuildError('subscription_required', 402);
}
export async function dispatchBuildTurn(env: Env, turn: BuildTurnRow) {
  if (!env.BUILD_WORKFLOW) throw new BuildError('build_unavailable');
  try {
    await env.BUILD_WORKFLOW.create({ id: turn.id, params: { appId: turn.app_id, userId: turn.user_id, turnId: turn.id } });
  } catch {
    // The create response may be lost. Reconcile the stable workflow ID before
    // retrying; never create a second paid build for the same submission.
    const instance = await env.BUILD_WORKFLOW.get(turn.id);
    const state = await instance.status();
    if (['errored', 'terminated', 'complete'].includes(state.status)) {
      await failBuildTurn(env, turn, 'build_interrupted');
    }
  }
}
export async function failBuildTurn(env: Env, turn: Pick<BuildTurnRow, 'id' | 'app_id' | 'user_id'>, error: string) {
  await env.DB.batch([
    env.DB.prepare("UPDATE build_turns SET status = 'failed', stage = 'Build stopped', error = ?, finished_at = ? WHERE id = ? AND user_id = ? AND status IN ('queued', 'running')")
      .bind(error, new Date().toISOString(), turn.id, turn.user_id),
    env.DB.prepare('UPDATE build_apps SET active_turn_id = NULL WHERE id = ? AND user_id = ? AND active_turn_id = ?').bind(turn.app_id, turn.user_id, turn.id),
  ]);
}
export async function reconcileBuildTurns(env: Env) {
  if (!buildConfigured(env)) return;
  const { results } = await env.DB.prepare("SELECT * FROM build_turns WHERE status IN ('queued', 'running') ORDER BY created_at LIMIT 20").all<BuildTurnRow>();
  for (const turn of results) {
    try {
      if (turn.status === 'queued') await dispatchBuildTurn(env, turn);
      else {
        const state = await (await env.BUILD_WORKFLOW.get(turn.id)).status();
        if (['errored', 'terminated', 'complete'].includes(state.status)) await failBuildTurn(env, turn, 'build_interrupted');
      }
    } catch { console.error('build_reconciliation_failed', { turnId: turn.id }); }
  }
}
async function stopBuildContainer(env: Env, userId: string, app: BuildAppRow) {
  if (!app.container_json) return;
  const container = JSON.parse(app.container_json) as BuildContainer;
  const response = await accountResponse(env, userId, { plan: null, active: false, validUntil: null }, 'DELETE', container.id, container.createdAt);
  if (!response.ok && ![404, 409].includes(response.status)) throw new BuildError('containers_unavailable');
}
function turnInsert(env: Env, appId: string, userId: string, turnId: string, key: string, prompt: string, mode: string, revision: number, now: string) {
  return env.DB.prepare(`INSERT INTO build_turns (id, app_id, user_id, request_key, prompt, mode, base_revision, status, stage, model, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 'Waiting to build', ?, ?)`)
    .bind(turnId, appId, userId, key, prompt, mode, revision, env.BUILD_MODEL || BUILD_MODEL, now);
}

export async function handleBuildRequest(request: Request, env: Env): Promise<Response> {
  const cors = authCorsHeaders(request);
  if (cors === null) return authJson({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const url = new URL(request.url);
  const match = /^\/build\/(config|apps)(?:\/([a-f0-9-]{36})(?:\/(turns|resume|stop|source|export))?)?$/.exec(url.pathname);
  if (!match || match[2] && !validExecutionId(match[2]) || match[1] === 'config' && match[2]) return authJson({ error: 'not_found' }, 404, cors);
  const allowed = match[1] === 'config' || ['source', 'export'].includes(match[3]) ? ['GET']
    : match[3] ? ['POST'] : match[2] ? ['GET', 'PATCH', 'DELETE'] : ['GET', 'POST'];
  if (!allowed.includes(request.method)) return authJson({ error: 'method_not_allowed' }, 405, { ...cors, allow: `${allowed.join(', ')}, OPTIONS` });
  if (request.method !== 'GET' && !request.headers.get('Origin')) return authJson({ error: 'origin_required' }, 403, cors);
  if (url.search) return authJson({ error: 'invalid_request' }, 400, cors);
  try {
    const user = await currentUser(env, request);
    if (!user) return authJson({ error: 'not_authenticated' }, 401, cors);
    if (match[1] === 'config') return authJson({ available: buildConfigured(env), model: env.BUILD_MODEL || BUILD_MODEL,
      maxApps: BUILD_MAX_APPS, dailyTurns: BUILD_DAILY_TURNS, aiBilling: 'included', computeUnitHourlyCents: 2, size: 'small' }, 200, cors);
    const id = match[2];
    if (request.method === 'GET' && !id) {
      const { results } = await env.DB.prepare('SELECT * FROM build_apps WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 50').bind(user.id).all<BuildAppRow>();
      return authJson({ apps: results.map(row => publicApp(row)) }, 200, cors);
    }
    if (id) {
      const app = await ownedBuildApp(env, user.id, id);
      if (!app) return authJson({ error: 'app_not_found' }, 404, cors);
      if (request.method === 'GET') {
        if (match[3] === 'source') return authJson({ revision: app.revision, files: JSON.parse(app.source_json) }, 200, cors);
        if (match[3] === 'export') return new Response(buildSourceZip(JSON.parse(app.source_json)), { headers: { ...cors,
          'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="mainbrella-app.zip"',
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
        return authJson(await detail(env, user.id, id), 200, cors);
      }
      if (request.method === 'PATCH') {
        const parsed = buildRenameSchema.safeParse(await readCommandBody(request));
        if (!parsed.success) return authJson({ error: 'invalid_request' }, 400, cors);
        await env.DB.prepare('UPDATE build_apps SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?')
          .bind(parsed.data.name, new Date().toISOString(), id, user.id).run();
        return authJson(await detail(env, user.id, id), 200, cors);
      }
      if (request.method === 'DELETE' || match[3] === 'stop') {
        if (app.active_turn_id) return authJson({ error: 'build_busy' }, 409, cors);
        await stopBuildContainer(env, user.id, app);
        if (request.method === 'DELETE') {
          await env.DB.prepare('DELETE FROM build_apps WHERE id = ? AND user_id = ? AND active_turn_id IS NULL').bind(id, user.id).run();
          return authJson({ deleted: true }, 200, cors);
        }
        await env.DB.prepare('UPDATE build_apps SET container_json = NULL, preview_json = NULL WHERE id = ? AND user_id = ? AND active_turn_id IS NULL').bind(id, user.id).run();
        return authJson(await detail(env, user.id, id), 200, cors);
      }
      if (match[3] === 'resume') {
        if (app.active_turn_id) {
          await requireBuildAccess(env, user.id);
          const turn = await env.DB.prepare('SELECT * FROM build_turns WHERE id = ? AND user_id = ?').bind(app.active_turn_id, user.id).first<BuildTurnRow>();
          if (turn?.status === 'queued') await dispatchBuildTurn(env, turn);
        }
        return authJson(await detail(env, user.id, id), 200, cors);
      }
    }
    const key = request.headers.get('Idempotency-Key');
    if (!validIdempotencyKey(key)) return authJson({ error: 'invalid_idempotency_key' }, 400, cors);
    const body = await readCommandBody(request);
    const parsed = id ? buildTurnSchema.safeParse(body) : buildCreateSchema.safeParse(body);
    if (!parsed.success) return authJson({ error: 'invalid_request' }, 400, cors);
    const data = parsed.data;
    const mode = 'mode' in data ? data.mode : 'build';
    const prompt = 'prompt' in data ? data.prompt : '';
    const existing = id
      ? await env.DB.prepare('SELECT * FROM build_turns WHERE app_id = ? AND user_id = ? AND request_key = ?').bind(id, user.id, key).first<BuildTurnRow>()
      : await env.DB.prepare('SELECT * FROM build_apps WHERE user_id = ? AND create_key = ?').bind(user.id, key).first<BuildAppRow>();
    if (existing) {
      if ('prompt' in existing ? existing.prompt !== prompt || existing.mode !== mode || ('revision' in data && existing.base_revision !== data.revision) : existing.initial_prompt !== prompt) return authJson({ error: 'idempotency_key_conflict' }, 409, cors);
      const appId = 'app_id' in existing ? existing.app_id : existing.id;
      const queued = 'app_id' in existing ? existing : await env.DB.prepare('SELECT * FROM build_turns WHERE app_id = ? AND request_key = ?').bind(appId, key).first<BuildTurnRow>();
      if (queued?.status === 'queued') await dispatchBuildTurn(env, queued).catch(() => { console.error('build_dispatch_deferred', { turnId: queued.id }); });
      return authJson(await detail(env, user.id, appId), 200, cors);
    }
    await requireBuildAccess(env, user.id);
    const now = new Date().toISOString(), appId = id || crypto.randomUUID(), turnId = crypto.randomUUID();
    if (id) {
      const app = (await ownedBuildApp(env, user.id, id))!;
      if (app.active_turn_id) return authJson({ error: 'build_busy' }, 409, cors);
      if ('revision' in data && data.revision !== app.revision) return authJson({ error: 'revision_conflict' }, 409, cors);
    }
    const statements = !id ? [env.DB.prepare(`INSERT INTO build_apps
      (id, user_id, create_key, initial_prompt, name, source_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(appId, user.id, key, prompt, buildName(prompt), JSON.stringify(buildStarter), now, now)] : [];
    statements.push(turnInsert(env, appId, user.id, turnId, key!, prompt, mode, 'revision' in data ? data.revision : 0, now));
    statements.push(env.DB.prepare('UPDATE build_apps SET active_turn_id = ?, preview_json = NULL, updated_at = ? WHERE id = ? AND user_id = ?').bind(turnId, now, appId, user.id));
    await env.DB.batch(statements);
    const turn = (await env.DB.prepare('SELECT * FROM build_turns WHERE id = ? AND user_id = ?').bind(turnId, user.id).first<BuildTurnRow>())!;
    await dispatchBuildTurn(env, turn).catch(() => { console.error('build_dispatch_deferred', { turnId }); });
    return authJson(await detail(env, user.id, appId), 202, cors);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (error instanceof BuildError) return authJson({ error: message }, error.status, cors);
    if (message.includes('build_busy') || message.includes('revision_conflict')) return authJson({ error: message.includes('revision_conflict') ? 'revision_conflict' : 'build_busy' }, 409, cors);
    if (['build_app_limit', 'build_daily_limit', 'build_turn_limit'].some(code => message.includes(code))) return authJson({ error: message.includes('build_daily_limit') ? 'build_daily_limit' : message.includes('build_turn_limit') ? 'build_turn_limit' : 'build_app_limit' }, 429, cors);
    if (/UNIQUE constraint failed: build_turns\.user_id/.test(message)) return authJson({ error: 'build_busy' }, 409, cors);
    if (/UNIQUE constraint failed/.test(message)) return authJson({ error: 'submission_conflict' }, 409, cors);
    if (error instanceof SyntaxError || message === 'invalid_request') return authJson({ error: 'invalid_request' }, 400, cors);
    if (message === 'request_too_large') return authJson({ error: message }, 413, cors);
    console.error('build_request_failed', { path: url.pathname });
    const failure = containerError(error, 'build_unavailable');
    return authJson({ error: failure.error }, failure.status, cors);
  }
}
