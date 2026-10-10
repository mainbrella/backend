import { z } from 'zod';
import { cookieSecurity, errors, jsonResponse, register, requestBody, type OpenAPIApi, type LegacyHandler } from './openapi-shared';
import { buildCreateSchema, buildRenameSchema, buildTurnSchema, buildRestoreSchema } from '../lib/build-contract';

const params = z.object({ appId: z.uuid() });
const headers = z.object({ Origin: z.string().optional() });
const submissionHeaders = headers.extend({ 'Idempotency-Key': z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) });
const image = z.object({ id: z.uuid(), toolId: z.string(), label: z.string(), path: z.string() }).openapi('BuildImage');
const turn = z.object({ id: z.uuid(), prompt: z.string(), mode: z.enum(['build', 'preview', 'restore']), status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  activity: z.array(z.object({ id: z.string(), type: z.enum(['message', 'tool']), text: z.string(), status: z.enum(['proposed', 'running', 'skipped', 'blocked', 'succeeded', 'failed', 'unknown']), explanation: z.string().nullable() })),
  images: z.array(image).max(4),
  stage: z.string(), summary: z.string().nullable(), error: z.string().nullable(), errorExplanation: z.string().nullable(), failureOperationId: z.string().nullable(), log: z.string(), model: z.string(), effort: z.string().nullable(), inputTokens: z.number().int().nullable(), outputTokens: z.number().int().nullable(), aiCostCents: z.number().nonnegative(),
  createdAt: z.iso.datetime(), finishedAt: z.iso.datetime().nullable() }).openapi('BuildTurn');
const app = z.object({ id: z.uuid(), name: z.string(), prompt: z.string(), revision: z.number().int(), activeTurnId: z.string().nullable(),
  versionId: z.uuid().nullable(), verifiedVersionId: z.uuid().nullable(),
  container: z.object({ id: z.string(), createdAt: z.iso.datetime(), expiresAt: z.iso.datetime() }).nullable(),
  preview: z.object({ id: z.string(), url: z.url(), expiresAt: z.number().int() }).nullable(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() }).openapi('BuildApp');
const detail = z.object({ app: app.extend({ turns: z.array(turn) }) });
const failures = errors(400, 401, 402, 403, 404, 405, 409, 413, 429, 503);
const version = z.object({ id: z.uuid(), commitId: z.string().regex(/^[a-f0-9]{40}$/), parentVersionId: z.uuid().nullable(),
  message: z.string(), verified: z.boolean(), createdAt: z.iso.datetime() }).openapi('BuildVersion');
export function registerBuildRoutes(api: OpenAPIApi, handler: LegacyHandler) {
  const common = { tags: ['Build'], security: cookieSecurity };
  register(api, 'get', '/build/apps/{appId}/turns/{turnId}/diagnostics', { ...common, operationId: 'getBuildTurnDiagnostics', summary: 'Inspect an owned turn’s durable operation evidence',
    description: 'Read-only, session-authenticated. Assembles ordered logical operations and attempt IDs, deployment/schema versions, dispatch intent, stream evidence, provider references, bounded command output, immutable source snapshots and independent billing/cleanup outcomes. Unknown outcomes are not replayed. Detailed records are excluded from routine SSE snapshots.',
    request: { params: params.extend({ turnId: z.uuid() }), headers }, responses: { 200: jsonResponse(z.object({
      schemaVersion: z.literal(1), turnId: z.uuid(), status: z.enum(['queued','running','succeeded','failed']), error: z.string().nullable(), errorExplanation: z.string().nullable(), log: z.string(), failureOperationId: z.string().nullable(),
      operations: z.array(z.object({ turn_id: z.uuid(), operation_id: z.string(), attempt_id: z.string(), schema_version: z.number().int(), deployment_version: z.string().nullable(),
        kind: z.enum(['text','image','tool','command','source','billing','cleanup']), label: z.string(), status: z.enum(['proposed','skipped','blocked','succeeded','failed','unknown']), explanation: z.string().nullable(),
        dispatch_attempted: z.number().int().nullable(), created_at: z.number(), started_at: z.number().nullable(), updated_at: z.number(), finished_at: z.number().nullable(),
        evidence: z.record(z.string(), z.unknown()), result: z.unknown().nullable(), source: z.record(z.string(), z.string()).nullable() })),
      billing: z.array(z.object({ id: z.string(), user_id: z.string(), app_id: z.string(), turn_id: z.string(), model: z.string(), reserved_micro_usd: z.number(),
        cost_micro_usd: z.number().nullable(), usage_json: z.string().nullable(), status: z.enum(['reserved','running','reported','settled']), created_at: z.number(), reported_at: z.number().nullable() })),
    })), ...errors(400,401,403,404,405,503) } }, handler);
  register(api, 'get', '/build/config', { ...common, operationId: 'getBuildConfig', summary: 'Read Build availability, models and billing',
    description: 'Reports a curated list of three models: GLM-5.3 (default, best quality), Kimi K2.7 Code (coding), and GLM-5.3 Flash (lower cost). GLM models accept high (default) or max reasoning effort; Kimi reasoning is always on. Each build accepts model and effort; choices outside this list return 400. Production uses Workers AI; opt-in local development can use a Codex app-server bridge with the same build tools and validation. There is no daily turn quota; prepaid builds require available balance and reserve funds within the account spending limit before each AI request.',
    responses: { 200: jsonResponse(z.object({ available: z.boolean(), versionHistory: z.boolean(), model: z.string(), models: z.array(z.object({ id: z.string(), name: z.string(), description: z.string().optional(), efforts: z.array(z.string()), defaultEffort: z.string() })), maxApps: z.number(), aiBilling: z.enum(['prepaid', 'included']), aiMarkupPercent: z.number(), computeUnitHourlyCents: z.number(), size: z.literal('small') })), ...errors(401, 403, 503) } }, handler);
  register(api, 'get', '/build/apps', { ...common, operationId: 'listBuildApps', summary: 'List account-saved apps', request: { headers },
    responses: { 200: jsonResponse(z.object({ apps: z.array(app).max(50) })), ...failures } }, handler);
  register(api, 'post', '/build/apps', { ...common, operationId: 'createBuildApp', summary: 'Create an app and queue its first Workers AI build',
    description: 'Requires active access and available prepaid balance, Origin and Idempotency-Key. Saves source in D1 and dispatches a durable Workflow. Text and image inference debit prepaid credits at Cloudflare cost plus 50%, using reported input, cached input and output tokens or explicit image dimensions/steps. Funds are held before each request within the account spending limit; unknown usage stays reserved for reconciliation. Known usage is charged even if the build fails. Small Ad Hoc runtime uses existing compute billing. No daily turn quota. Maximum 50 apps and one active turn per account. Identical retries return the same app; different prompts with the same key return 409. Queued dispatch and reported charges are reconciled by scheduled work. Local Codex text inference has no Cloudflare charge.',
    request: { headers: submissionHeaders, ...requestBody(buildCreateSchema) }, responses: { 200: jsonResponse(detail), 202: jsonResponse(detail), ...failures } }, handler);
  register(api, 'get', '/build/apps/{appId}', { ...common, operationId: 'getBuildApp', summary: 'Read an owned app and its build progress',
    description: 'Read-only. Includes retained conversation, original generated image metadata, workflow stages, token usage, settled AI charges in fractional USD cents, saved revision and temporary preview. Image bytes are available through the owned image endpoint. Expired preview URLs are omitted. Source and conversations remain accessible without paid access.',
    request: { params, headers }, responses: { 200: jsonResponse(detail), ...failures } }, handler);
  register(api, 'get', '/build/apps/{appId}/events', { ...common, operationId: 'streamBuildApp', summary: 'Stream an owned app’s model output and build activity',
    description: 'Session-authenticated, read-only SSE. Each app event contains the same JSON snapshot as getBuildApp, including incremental assistant text, tool activity and preview state. Reconnect after disconnect; retained activity is replayed without starting another build. Streams close when the build finishes or after 55 seconds.',
    request: { params, headers }, responses: { 200: { description: 'Server-sent app snapshots.', content: { 'text/event-stream': { schema: { type: 'string' } } } }, ...failures } }, handler);
  register(api, 'patch', '/build/apps/{appId}', { ...common, operationId: 'renameBuildApp', summary: 'Rename an owned app', request: { params, headers, ...requestBody(buildRenameSchema) }, responses: { 200: jsonResponse(detail), ...failures } }, handler);
  register(api, 'delete', '/build/apps/{appId}', { ...common, operationId: 'deleteBuildApp', summary: 'Stop the exact editing container and delete an app',
    description: 'Rejects deletion during an active build. Deletes conversations and saved revisions. Cleanup remains available after funding expires.', request: { params, headers }, responses: { 200: jsonResponse(z.object({ deleted: z.literal(true) })), ...failures } }, handler);
  register(api, 'post', '/build/apps/{appId}/turns', { ...common, operationId: 'createBuildTurn', summary: 'Modify an app or restart a temporary preview',
    description: 'Stable Idempotency-Key required. revision must match the latest successful revision. mode=build runs bounded Workers AI file, install, compile and repair steps. mode=preview rebuilds saved source without AI. Prepaid builds and previews require available balance; AI requests reserve funds within the account spending limit. No daily turn quota. Maximum 100 turns per app. Successful builds save immutable source revisions independently of containers. Preview links last at most 30 minutes, subject to the existing Ad Hoc idle and funding deadlines. No permanent publishing or backend/database provisioning.',
    request: { params, headers: submissionHeaders, ...requestBody(buildTurnSchema) }, responses: { 200: jsonResponse(detail), 202: jsonResponse(detail), ...failures } }, handler);
  register(api, 'post', '/build/apps/{appId}/resume', { ...common, operationId: 'resumeBuildDispatch', summary: 'Reconcile dispatch of an existing queued build',
    description: 'Uses the existing workflow ID; does not create a new turn or replay failed inference.', request: { params, headers }, responses: { 200: jsonResponse(detail), ...failures } }, handler);
  register(api, 'post', '/build/apps/{appId}/stop', { ...common, operationId: 'stopBuildPreview', summary: 'Stop the editing container while keeping source', request: { params, headers }, responses: { 200: jsonResponse(detail), ...failures } }, handler);
  register(api, 'get', '/build/apps/{appId}/source', { ...common, operationId: 'getBuildSource', summary: 'Read saved working source, including edits from a failed build', request: { params, headers }, responses: { 200: jsonResponse(z.object({ revision: z.number().int(), files: z.record(z.string(), z.string()) })), ...failures } }, handler);
  register(api, 'get', '/build/apps/{appId}/export', { ...common, operationId: 'exportBuildSource', summary: 'Download portable source as a ZIP archive', request: { params, headers }, responses: { 200: { description: 'Source archive including original JPEG assets under public/generated. Run npm install and npm run build.', content: { 'application/zip': { schema: { type: 'string', format: 'binary' } } } }, ...failures } }, handler);
  register(api, 'get', '/build/apps/{appId}/versions', { ...common, operationId: 'listBuildVersions', summary: 'List saved Git versions of an owned app',
    description: 'Read-only and available without paid access. Returns up to 100 versions, newest first. Checkpoints preserve edits from failed builds; verified indicates a successful compile. versionId identifies the current saved head and verifiedVersionId the last version with a successful preview. Repositories persist as immutable Git bundles in private R2 storage; no GitHub account is required.',
    request: { params, headers }, responses: { 200: jsonResponse(z.object({ versions: z.array(version), versionId: z.uuid().nullable(), verifiedVersionId: z.uuid().nullable() })), ...failures } }, handler);
  register(api, 'get', '/build/apps/{appId}/versions/{versionId}', { ...common, operationId: 'getBuildVersion', summary: 'Read a version’s source and changes from its parent',
    description: 'Owner-scoped repository files and changes, including .gitignore, the npm lockfile and referenced generated JPEGs. Text files and binary asset paths come from saved D1 metadata without extracting the R2 bundle. Asset imageId values use the owned image endpoint. Binary assets have null before/after text.',
    request: { params: params.extend({ versionId: z.uuid() }), headers }, responses: { 200: jsonResponse(z.object({ version, files: z.record(z.string(), z.string()),
      assets: z.array(z.object({ path: z.string(), imageId: z.uuid() })),
      changes: z.array(z.object({ path: z.string(), type: z.enum(['added','modified','deleted']), before: z.string().nullable(), after: z.string().nullable() })) })), ...failures } }, handler);
  register(api, 'post', '/build/apps/{appId}/restore', { ...common, operationId: 'restoreBuildVersion', summary: 'Restore a saved version and create a new Git commit',
    description: 'Requires active funded access, Origin, Idempotency-Key and the current revision. Queues a build without AI, restores source and its npm lockfile, compiles it and starts a preview. Success creates a new commit and source revision, preserving intervening history. Existing active turns and stale revisions return 409; versions belonging to another app return 404. Failed restores preserve the working source.',
    request: { params, headers: submissionHeaders, ...requestBody(buildRestoreSchema) }, responses: { 200: jsonResponse(detail), 202: jsonResponse(detail), ...failures } }, handler);
  register(api, 'get', '/build/apps/{appId}/repository', { ...common, operationId: 'exportBuildRepository', summary: 'Download an owned app’s complete Git history',
    description: 'Read-only, available without paid access. Streams the current saved repository, including source, referenced assets and npm lockfile, as a complete Git bundle. Download as app.bundle and run git clone -b main app.bundle app. The cloned repository can be pushed to any Git host.',
    request: { params, headers }, responses: { 200: { description: 'Complete Git bundle.', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }, ...failures } }, handler);
  const imageRequest = { params: params.extend({ imageId: z.uuid() }), headers };
  register(api, 'get', '/build/apps/{appId}/images/{imageId}', { ...common, operationId: 'getBuildImage', summary: 'Read an original image from an owned app',
    description: 'Session-authenticated JPEG bytes. Generated with Workers AI, retained independently of the sandbox and deleted with the app. Maximum 4 images per build and 12 per app. App previews and ZIP exports use local copies of these assets.',
    request: imageRequest, responses: { 200: { description: 'Original generated JPEG.', content: { 'image/jpeg': { schema: { type: 'string', format: 'binary' } } } }, ...errors(400, 401, 403, 404, 405, 503) } }, handler);
}
