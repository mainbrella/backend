import { buildModels, resolveBuildModel } from '../lib/build-models';
import { authCorsHeaders, authJson, currentUser } from './auth-core';
import { readCommandBody } from '../../containers/command-contract.js';
import { validExecutionId } from '../../containers/execution-contract.js';
import { validIdempotencyKey } from '../../containers/container-account-core.js';
import { resolveEntitlement } from '../lib/entitlements';
import { accountResponse, containerError } from '../lib/container-service';
import { previewsConfigured } from '../lib/preview-routing';
import { BUILD_MODEL, BUILD_MAX_APPS, BuildError, buildCreateSchema, buildRenameSchema, buildTurnSchema, buildRestoreSchema,
  buildName, buildStarter, ownedBuildApp, type BuildAppRow, type BuildContainer, type BuildTurnRow, type BuildPreview } from '../lib/build-contract';
import { buildSourceZip } from '../lib/build-zip';
import { buildAppStream, type BuildActivityRow } from '../lib/build-activity';
import { localCodexConfigured } from '../lib/build-codex';
import { BUILD_AI_MARKUP_PERCENT, buildTokenPrices } from '../lib/build-pricing';
import { settleReportedBuildUsage } from '../lib/build-billing';
import { accountBillingRequest } from '../lib/prepaid-billing';
import { buildImageBytes, buildImagePath, publicBuildImage, savedBuildImages, buildImageEntries, serveBuildImage, type BuildImageRow } from '../lib/build-images';
import { buildOperationTimeline, operationExplanation, type OperationRow } from '../lib/build-journal';
import { buildGitEntries, buildGitVersion, publicGitVersion, exportBuildGit, deleteBuildGit, cleanupDeletedBuildGit, type BuildGitVersion } from '../lib/build-git';
import { buildSourceEntries, readBuildSource, storeBuildSource, readBuildText, serveBuildFile, type BuildFileInfo } from '../lib/build-storage';

export function buildConfigured(env: Env) {
  return env.BUILD_ENABLED === 'true' && Boolean(env.BUCKET && (localCodexConfigured(env) || env.AI && env.CONTAINER_ACCOUNT && buildTokenPrices[env.BUILD_MODEL || BUILD_MODEL]) && env.BUILD_WORKFLOW && previewsConfigured(env));
}
function publicApp(row: BuildAppRow, turns?: BuildTurnRow[], activity: BuildActivityRow[] = [], images: Omit<BuildImageRow, 'data' | 'prompt' | 'app_id'>[] = [], costs: Record<string, number> = {}, operations: OperationRow[] = []) {
  const preview = row.preview_json ? JSON.parse(row.preview_json) as BuildPreview : null;
  return { id: row.id, name: row.name, prompt: row.initial_prompt, revision: row.revision,
    activeTurnId: row.active_turn_id, container: row.container_json ? JSON.parse(row.container_json) as BuildContainer : null,
    versionId: row.git_version_id ?? null, verifiedVersionId: row.verified_git_version_id ?? null,
    preview: preview && preview.expiresAt > Date.now() ? preview : null, createdAt: row.created_at, updatedAt: row.updated_at,
    ...(turns ? { turns: turns.map(turn => ({ id: turn.id, prompt: turn.prompt, mode: turn.restore_version_id ? 'restore' : turn.mode, status: turn.status,
      stage: turn.stage, summary: turn.summary, error: turn.error, log: '', model: turn.model, effort: turn.effort ?? null,
      failureOperationId: turn.failure_operation_id ?? null,
      errorExplanation: operations.find(op => op.turn_id === turn.id && op.operation_id === turn.failure_operation_id)
        ? operationExplanation(operations.find(op => op.turn_id === turn.id && op.operation_id === turn.failure_operation_id)!) : null,
      activity: activity.filter(item => item.turn_id === turn.id).map(({ turn_id, ...item }) => {
        const op = operations.find(op => op.turn_id === turn.id && op.operation_id === item.id);
        const image = operations.find(op => op.turn_id === turn.id && op.operation_id === `image-${item.id}`);
        const state = op ? op.status === 'unknown' && !op.finished_at && ['queued', 'running'].includes(turn.status) ? 'running' : op.status : item.status;
        return { ...item, status: state, explanation: image ? operationExplanation(image) : op ? operationExplanation(op) : null };
      }),
      images: images.filter(image => image.turn_id === turn.id).map(publicBuildImage),
      ...turnTokenUsage(turn, operations), aiCostCents: (costs[turn.id] ?? 0) / 10000,
      createdAt: turn.created_at, finishedAt: turn.finished_at })) } : {}),
  };
}
function turnTokenUsage(turn: BuildTurnRow, operations: OperationRow[]) {
  const inferences = operations.filter(op => op.turn_id === turn.id && op.kind === 'text' && op.started_at);
  if (!inferences.length) return { inputTokens: turn.input_tokens, outputTokens: turn.output_tokens };
  const evidence = inferences.map(op => JSON.parse(op.evidence_json).usage);
  const total = (key: string) => evidence.every(usage => Number.isSafeInteger(usage?.[key]) && usage[key] >= 0)
    ? evidence.reduce((sum, usage) => sum + usage[key], 0) : null;
  return { inputTokens: total('prompt_tokens'), outputTokens: total('completion_tokens') };
}
async function detail(env: Env, userId: string, id: string) {
  const row = await ownedBuildApp(env, userId, id);
  if (!row) throw new BuildError('app_not_found', 404);
  const { results } = await env.DB.prepare('SELECT * FROM build_turns WHERE app_id = ? AND user_id = ? ORDER BY created_at, id').bind(id, userId).all<BuildTurnRow>();
  const { results: activity } = await env.DB.prepare(`SELECT a.turn_id, a.id, a.type, a.text, a.status FROM build_activity a
    JOIN build_turns t ON t.id = a.turn_id WHERE t.app_id = ? AND t.user_id = ? ORDER BY t.created_at, t.id, a.position`)
    .bind(id, userId).all<BuildActivityRow>();
  const { results: images } = await env.DB.prepare('SELECT id, turn_id, tool_id, label FROM build_images WHERE app_id = ? ORDER BY rowid')
    .bind(id).all<Omit<BuildImageRow, 'data' | 'prompt' | 'app_id'>>();
  const { results: costs } = await env.DB.prepare("SELECT turn_id, SUM(cost_micro_usd) AS cost FROM build_ai_usage WHERE app_id = ? AND user_id = ? AND status = 'settled' GROUP BY turn_id")
    .bind(id, userId).all<{ turn_id: string; cost: number }>();
  const { results: operations } = await env.DB.prepare(`SELECT o.turn_id, o.operation_id, o.kind, o.label, o.status, o.started_at, o.finished_at,
    json_object('usage',json_extract(o.evidence_json,'$.usage'),'finishReason',json_extract(o.evidence_json,'$.finishReason'),
    'tokenAllowance',json_extract(o.evidence_json,'$.tokenAllowance'),'termination',json_extract(o.evidence_json,'$.termination'),
    'doneSeen',json_extract(o.evidence_json,'$.doneSeen'),'exitCode',json_extract(o.evidence_json,'$.exitCode'),
    'reason',json_extract(o.evidence_json,'$.reason')) AS evidence_json,
    CASE WHEN json_extract(o.result_json,'$.ok') = 0 THEN o.result_json ELSE NULL END AS result_json
    FROM build_operations o JOIN build_turns t ON t.id = o.turn_id WHERE t.app_id = ? AND t.user_id = ?`)
    .bind(id, userId).all<OperationRow>();
  return { app: publicApp(row, results, activity, images, Object.fromEntries(costs.map(row => [row.turn_id, row.cost])), operations) };
}
async function requireBuildAccess(env: Env, userId: string) {
  if (!buildConfigured(env)) throw new BuildError('build_unavailable');
  if (!(await resolveEntitlement(env, userId)).active) throw new BuildError('subscription_required', 402);
  if (!localCodexConfigured(env)) {
    const { balance } = await accountBillingRequest(env, userId, '/billing/balance');
    if (balance.availableBalanceCents <= 0) throw new BuildError('insufficient_balance', 402);
  }
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
export async function failBuildTurn(env: Env, turn: Pick<BuildTurnRow, 'id' | 'app_id' | 'user_id'>, error: string, operationId: string | null = null) {
  await env.DB.batch([
    env.DB.prepare("UPDATE build_operations SET status = 'skipped', finished_at = ?, updated_at = ? WHERE turn_id = ? AND status = 'proposed' AND started_at IS NULL").bind(Date.now(), Date.now(), turn.id),
    env.DB.prepare("UPDATE build_activity SET status = CASE WHEN status = 'proposed' THEN 'skipped' ELSE 'unknown' END WHERE turn_id = ? AND status IN ('running','proposed')").bind(turn.id),
    env.DB.prepare("UPDATE build_turns SET status = 'failed', stage = 'Build stopped', error = ?, failure_operation_id = COALESCE(?, (SELECT operation_id FROM build_operations WHERE turn_id = ? AND status = 'unknown' ORDER BY updated_at DESC LIMIT 1)), finished_at = ? WHERE id = ? AND user_id = ? AND status IN ('queued', 'running')")
      .bind(error, operationId, turn.id, new Date().toISOString(), turn.id, turn.user_id),
    env.DB.prepare('UPDATE build_apps SET active_turn_id = NULL WHERE id = ? AND user_id = ? AND active_turn_id = ?').bind(turn.app_id, turn.user_id, turn.id),
  ]);
}
export async function reconcileBuildTurns(env: Env) {
  await settleReportedBuildUsage(env);
  await cleanupDeletedBuildGit(env);
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
function turnInsert(env: Env, appId: string, userId: string, turnId: string, key: string, prompt: string, mode: string, revision: number, now: string, model: string, effort: string | null, restoreId: string | null = null) {
  return env.DB.prepare(`INSERT INTO build_turns (id, app_id, user_id, request_key, prompt, mode, base_revision, status, stage, model, created_at, effort, restore_version_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 'Waiting to build', ?, ?, ?, ?)`)
    .bind(turnId, appId, userId, key, prompt, mode, revision, model, now, effort, restoreId);
}

export async function handleBuildRequest(request: Request, env: Env): Promise<Response> {
  const cors = authCorsHeaders(request);
  if (cors === null) return authJson({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const url = new URL(request.url);
  const diagnostic = /^\/build\/apps\/([a-f0-9-]{36})\/turns\/([a-f0-9-]{36})\/diagnostics$/.exec(url.pathname);
  const match = diagnostic ? [diagnostic[0], 'apps', diagnostic[1], 'diagnostics', diagnostic[2]] : /^\/build\/(config|apps)(?:\/([a-f0-9-]{36})(?:\/(turns|resume|stop|source|files|file|export|events|images|versions|repository|restore)(?:\/([a-f0-9-]{36}))?)?)?$/.exec(url.pathname);
  if (!match || match[2] && !validExecutionId(match[2]) || match[1] === 'config' && match[2]
    || ['images', 'diagnostics'].includes(match[3]) && !match[4] || match[4] && (!['images', 'diagnostics', 'versions'].includes(match[3]) || !validExecutionId(match[4]))) return authJson({ error: 'not_found' }, 404, cors);
  const allowed = match[1] === 'config' || ['source', 'files', 'file', 'export', 'events', 'images', 'diagnostics', 'versions', 'repository'].includes(match[3]) ? ['GET']
    : match[3] ? ['POST'] : match[2] ? ['GET', 'PATCH', 'DELETE'] : ['GET', 'POST'];
  if (!allowed.includes(request.method)) return authJson({ error: 'method_not_allowed' }, 405, { ...cors, allow: `${allowed.join(', ')}, OPTIONS` });
  if (request.method !== 'GET' && !request.headers.get('Origin')) return authJson({ error: 'origin_required' }, 403, cors);
  if (url.search && !['files', 'file'].includes(match[3])) return authJson({ error: 'invalid_request' }, 400, cors);
  try {
    const user = await currentUser(env, request);
    if (!user) return authJson({ error: 'not_authenticated' }, 401, cors);
    if (match[1] === 'config') return authJson({ available: buildConfigured(env), model: env.BUILD_MODEL || BUILD_MODEL,
      models: (localCodexConfigured(env) ? [{ id: env.BUILD_MODEL || BUILD_MODEL, name: env.BUILD_MODEL || BUILD_MODEL, description: undefined, efforts: ['low'], defaultEffort: 'low' }] : buildModels).map(({ id, name, description, efforts, defaultEffort }) => ({ id, name, ...(description ? { description } : {}), efforts, defaultEffort })),
      maxApps: BUILD_MAX_APPS, aiBilling: localCodexConfigured(env) ? 'included' : 'prepaid',
      versionHistory: Boolean(env.BUCKET),
      aiMarkupPercent: BUILD_AI_MARKUP_PERCENT, computeUnitHourlyCents: 2, size: 'small' }, 200, cors);
    const id = match[2];
    if (request.method === 'GET' && !id) {
      const { results } = await env.DB.prepare('SELECT * FROM build_apps WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 50').bind(user.id).all<BuildAppRow>();
      return authJson({ apps: results.map(row => publicApp(row)) }, 200, cors);
    }
    if (id) {
      const app = await ownedBuildApp(env, user.id, id);
      if (!app) return authJson({ error: 'app_not_found' }, 404, cors);
      const owner = { userId: user.id, appId: id };
      const fileInfo = ({ path, size, type }: BuildFileInfo) => ({ path, size, type });
      if (['files', 'file'].includes(match[3])) {
        const versionId = url.searchParams.get('versionId'), path = url.searchParams.get('path');
        const allowedQuery = match[3] === 'files' ? ['versionId'] : ['versionId', 'path'];
        if ([...url.searchParams.keys()].some(key => !allowedQuery.includes(key) || url.searchParams.getAll(key).length !== 1)
          || versionId !== null && !validExecutionId(versionId) || match[3] === 'file' && (!path || path.length > 160)) return authJson({ error: 'invalid_request' }, 400, cors);
        const version = versionId ? await buildGitVersion(env, id, versionId) : null;
        if (versionId && !version) return authJson({ error: 'version_not_found' }, 404, cors);
        const entries = version ? await buildGitEntries(env, owner, version) : [...await buildSourceEntries(env, owner, app.source_json), ...await buildImageEntries(env, owner)];
        if (match[3] === 'files') return authJson({ revision: app.revision, version: version ? publicGitVersion(version) : null, files: entries.map(fileInfo) }, 200, cors);
        const entry = entries.find(entry => entry.path === path);
        if (!entry) return authJson({ error: 'file_not_found' }, 404, cors);
        if (entry.type === 'image') return await serveBuildImage(env, owner, entry.path.split('/').at(-1)!.replace(/\.jpg$/, ''), cors);
        return await serveBuildFile(env, owner, entry, cors);
      }
      if (match[3] === 'versions') {
        if (match[4]) {
          const version = await buildGitVersion(env, id, match[4]);
          if (!version) return authJson({ error: 'version_not_found' }, 404, cors);
          const parent = version.parent_version_id ? await buildGitVersion(env, id, version.parent_version_id) : null;
          const files = await buildGitEntries(env, owner, version), before = parent ? await buildGitEntries(env, owner, parent) : [];
          const old = new Map(before.map(file => [file.path, file])), next = new Map(files.map(file => [file.path, file]));
          const changes = [...new Set([...old.keys(), ...next.keys()])].sort().filter(path => old.get(path)?.sha256 !== next.get(path)?.sha256)
            .map(path => ({ path, type: !old.has(path) ? 'added' : !next.has(path) ? 'deleted' : 'modified', fileType: (next.get(path) ?? old.get(path))!.type }));
          return authJson({ version: publicGitVersion(version), files: files.map(fileInfo), changes }, 200, cors);
        }
        const { results } = await env.DB.prepare('SELECT * FROM build_git_versions WHERE app_id = ? ORDER BY rowid DESC LIMIT 100').bind(id).all<BuildGitVersion>();
        return authJson({ versions: results.map(publicGitVersion), versionId: app.git_version_id ?? null, verifiedVersionId: app.verified_git_version_id ?? null }, 200, cors);
      }
      if (match[3] === 'repository') {
        const version = app.git_version_id ? await buildGitVersion(env, id, app.git_version_id) : null;
        if (!version) return authJson({ error: 'version_not_found' }, 404, cors);
        return await exportBuildGit(env, user.id, id, version, cors);
      }
      if (match[3] === 'diagnostics') {
        const turn = await env.DB.prepare('SELECT * FROM build_turns WHERE id = ? AND app_id = ? AND user_id = ?')
          .bind(match[4], id, user.id).first<BuildTurnRow>();
        if (!turn) return authJson({ error: 'turn_not_found' }, 404, cors);
        const operations = await buildOperationTimeline(env, turn.id);
        const { results: billing } = await env.DB.prepare('SELECT * FROM build_ai_usage WHERE turn_id = ? AND user_id = ? ORDER BY created_at')
          .bind(turn.id, user.id).all();
        return authJson({ schemaVersion: 1, turnId: turn.id, status: turn.status, error: turn.error, log: turn.log, failureOperationId: turn.failure_operation_id ?? null,
          errorExplanation: operations.find(op => op.operation_id === turn.failure_operation_id) ? operationExplanation(operations.find(op => op.operation_id === turn.failure_operation_id)!) : null,
          operations: await Promise.all(operations.map(async ({ evidence_json, result_json, source_json, ...op }) => ({ ...op, explanation: operationExplanation({ ...op, evidence_json, result_json, source_json }), evidence: JSON.parse(evidence_json),
            result: result_json ? JSON.parse(await readBuildText(env, owner, result_json)) : null, source: source_json ? await readBuildSource(env, owner, source_json) : null }))), billing }, 200, cors);
      }
      if (match[3] === 'images') {
        return await serveBuildImage(env, owner, match[4], cors);
      }
      if (request.method === 'GET') {
        if (match[3] === 'events') return buildAppStream(request, () => detail(env, user.id, id), cors);
        if (match[3] === 'source') return authJson({ revision: app.revision, files: await readBuildSource(env, owner, app.source_json) }, 200, cors);
        if (match[3] === 'export') {
          const assets = Object.fromEntries((await savedBuildImages(env, id)).map(image => [`public${buildImagePath(image.id)}`, buildImageBytes(image.data)]));
          return new Response(buildSourceZip(await readBuildSource(env, owner, app.source_json), assets), { headers: { ...cors,
          'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="mainbrella-app.zip"',
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
        }
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
          await env.DB.batch([
            env.DB.prepare('INSERT INTO build_git_deletions (app_id, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT(app_id) DO NOTHING').bind(id, user.id, new Date().toISOString()),
            env.DB.prepare('DELETE FROM build_apps WHERE id = ? AND user_id = ? AND active_turn_id IS NULL').bind(id, user.id),
          ]);
          if (env.BUCKET) try {
            await deleteBuildGit(env, user.id, id);
            await env.DB.prepare('DELETE FROM build_git_deletions WHERE app_id = ?').bind(id).run();
          } catch { console.error('build_git_deletion_deferred', { appId: id }); }
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
    const restoring = match[3] === 'restore';
    const parsed = restoring ? buildRestoreSchema.safeParse(body) : id ? buildTurnSchema.safeParse(body) : buildCreateSchema.safeParse(body);
    if (!parsed.success) return authJson({ error: 'invalid_request' }, 400, cors);
    const data = parsed.data;
    const restoreId = 'versionId' in data ? data.versionId : null;
    if (restoreId && (!env.BUCKET || !await buildGitVersion(env, id, restoreId))) return authJson({ error: 'version_not_found' }, 404, cors);
    const mode = restoring ? 'preview' : 'mode' in data ? data.mode : 'build';
    const prompt = restoring ? `Restore version ${restoreId}` : 'prompt' in data ? data.prompt : '';
    const options = mode === 'build' ? resolveBuildModel(env.BUILD_MODEL || BUILD_MODEL, 'prompt' in data ? data : {}, localCodexConfigured(env)) : { model: env.BUILD_MODEL || BUILD_MODEL, effort: null };
    const existing = id
      ? await env.DB.prepare('SELECT * FROM build_turns WHERE app_id = ? AND user_id = ? AND request_key = ?').bind(id, user.id, key).first<BuildTurnRow>()
      : await env.DB.prepare('SELECT * FROM build_apps WHERE user_id = ? AND create_key = ?').bind(user.id, key).first<BuildAppRow>();
    if (existing) {
      if ('prompt' in existing ? existing.prompt !== prompt || existing.mode !== mode || (existing.restore_version_id ?? null) !== restoreId || ('revision' in data && existing.base_revision !== data.revision) : existing.initial_prompt !== prompt) return authJson({ error: 'idempotency_key_conflict' }, 409, cors);
      const appId = 'app_id' in existing ? existing.app_id : existing.id;
      const queued = 'app_id' in existing ? existing : await env.DB.prepare('SELECT * FROM build_turns WHERE app_id = ? AND request_key = ?').bind(appId, key).first<BuildTurnRow>();
      if (queued && mode === 'build' && (('model' in data && data.model !== queued.model) || ('effort' in data && data.effort !== queued.effort))) return authJson({ error: 'idempotency_key_conflict' }, 409, cors);
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
      .bind(appId, user.id, key, prompt, buildName(prompt), await storeBuildSource(env, { appId, userId: user.id }, buildStarter), now, now)] : [];
    statements.push(turnInsert(env, appId, user.id, turnId, key!, prompt, mode, 'revision' in data ? data.revision : 0, now, options.model, options.effort, restoreId));
    statements.push(env.DB.prepare('UPDATE build_apps SET active_turn_id = ?, preview_json = NULL, updated_at = ? WHERE id = ? AND user_id = ?').bind(turnId, now, appId, user.id));
    await env.DB.batch(statements);
    const turn = (await env.DB.prepare('SELECT * FROM build_turns WHERE id = ? AND user_id = ?').bind(turnId, user.id).first<BuildTurnRow>())!;
    await dispatchBuildTurn(env, turn).catch(() => { console.error('build_dispatch_deferred', { turnId }); });
    return authJson(await detail(env, user.id, appId), 202, cors);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (error instanceof BuildError) return authJson({ error: message }, error.status, cors);
    if (message.includes('build_busy') || message.includes('revision_conflict')) return authJson({ error: message.includes('revision_conflict') ? 'revision_conflict' : 'build_busy' }, 409, cors);
    if (['build_app_limit', 'build_turn_limit'].some(code => message.includes(code))) return authJson({ error: message.includes('build_turn_limit') ? 'build_turn_limit' : 'build_app_limit' }, 429, cors);
    if (/UNIQUE constraint failed: build_turns\.user_id/.test(message)) return authJson({ error: 'build_busy' }, 409, cors);
    if (/UNIQUE constraint failed/.test(message)) return authJson({ error: 'submission_conflict' }, 409, cors);
    if (error instanceof SyntaxError || message === 'invalid_request') return authJson({ error: 'invalid_request' }, 400, cors);
    if (message === 'request_too_large') return authJson({ error: message }, 413, cors);
    console.error('build_request_failed', { path: url.pathname });
    const failure = containerError(error, 'build_unavailable');
    return authJson({ error: failure.error }, failure.status, cors);
  }
}
