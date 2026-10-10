import { z } from 'zod';
import { cookieSecurity, errors, jsonResponse, register, requestBody, type OpenAPIApi, type LegacyHandler } from './openapi-shared';
import { buildCreateSchema, buildRenameSchema, buildTurnSchema } from '../lib/build-contract';

const params = z.object({ appId: z.uuid() });
const headers = z.object({ Origin: z.string().optional() });
const submissionHeaders = headers.extend({ 'Idempotency-Key': z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) });
const image = z.object({ id: z.uuid(), toolId: z.string(), label: z.string(), path: z.string() }).openapi('BuildImage');
const turn = z.object({ id: z.uuid(), prompt: z.string(), mode: z.enum(['build', 'preview']), status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  activity: z.array(z.object({ id: z.string(), type: z.enum(['message', 'tool']), text: z.string(), status: z.enum(['running', 'succeeded', 'failed']) })),
  images: z.array(image).max(4),
  stage: z.string(), summary: z.string().nullable(), error: z.string().nullable(), log: z.string(), model: z.string(), effort: z.string().nullable(), inputTokens: z.number().int(), outputTokens: z.number().int(), aiCostCents: z.number().nonnegative(),
  createdAt: z.iso.datetime(), finishedAt: z.iso.datetime().nullable() }).openapi('BuildTurn');
const app = z.object({ id: z.uuid(), name: z.string(), prompt: z.string(), revision: z.number().int(), activeTurnId: z.string().nullable(),
  container: z.object({ id: z.string(), createdAt: z.iso.datetime(), expiresAt: z.iso.datetime() }).nullable(),
  preview: z.object({ id: z.string(), url: z.url(), expiresAt: z.number().int() }).nullable(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() }).openapi('BuildApp');
const detail = z.object({ app: app.extend({ turns: z.array(turn) }) });
const failures = errors(400, 401, 402, 403, 404, 405, 409, 413, 429, 503);
export function registerBuildRoutes(api: OpenAPIApi, handler: LegacyHandler) {
  const common = { tags: ['Build'], security: cookieSecurity };
  register(api, 'get', '/build/config', { ...common, operationId: 'getBuildConfig', summary: 'Read Build availability and beta limits',
    description: 'Reports the default inference model and supported model/effort choices. Each build accepts model and effort; unsupported choices return 400. Production uses Workers AI; opt-in local development can use a Codex app-server bridge with the same build tools and validation.',
    responses: { 200: jsonResponse(z.object({ available: z.boolean(), model: z.string(), models: z.array(z.object({ id: z.string(), name: z.string(), efforts: z.array(z.string()), defaultEffort: z.string() })), maxApps: z.number(), dailyTurns: z.number(), aiBilling: z.enum(['prepaid', 'included']), aiMarkupPercent: z.number(), computeUnitHourlyCents: z.number(), size: z.literal('small') })), ...errors(401, 403, 503) } }, handler);
  register(api, 'get', '/build/apps', { ...common, operationId: 'listBuildApps', summary: 'List account-saved apps', request: { headers },
    responses: { 200: jsonResponse(z.object({ apps: z.array(app).max(50) })), ...failures } }, handler);
  register(api, 'post', '/build/apps', { ...common, operationId: 'createBuildApp', summary: 'Create an app and queue its first Workers AI build',
    description: 'Requires active access and prepaid funding, Origin and Idempotency-Key. Saves source in D1 and dispatches a durable Workflow. Text and image inference debit prepaid credits at Cloudflare cost plus 50%, using reported input, cached input and output tokens or explicit image dimensions/steps. Funds are held before each request; unknown usage stays reserved for reconciliation. Known usage is charged even if the build fails. Small Ad Hoc runtime uses existing compute billing. Maximum 50 apps, 10 turns per UTC day, and one active turn per account. Identical retries return the same app; different prompts with the same key return 409. Queued dispatch and reported charges are reconciled by scheduled work. Local Codex text inference has no Cloudflare charge.',
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
    description: 'Stable Idempotency-Key required. revision must match the latest successful revision. mode=build runs bounded Workers AI file, install, compile and repair steps. mode=preview rebuilds saved source without AI. Maximum 100 turns per app. Successful builds save immutable source revisions independently of containers. Preview links last at most 30 minutes, subject to the existing Ad Hoc idle and funding deadlines. No permanent publishing or backend/database provisioning.',
    request: { params, headers: submissionHeaders, ...requestBody(buildTurnSchema) }, responses: { 200: jsonResponse(detail), 202: jsonResponse(detail), ...failures } }, handler);
  register(api, 'post', '/build/apps/{appId}/resume', { ...common, operationId: 'resumeBuildDispatch', summary: 'Reconcile dispatch of an existing queued build',
    description: 'Uses the existing workflow ID; does not create a new turn or replay failed inference.', request: { params, headers }, responses: { 200: jsonResponse(detail), ...failures } }, handler);
  register(api, 'post', '/build/apps/{appId}/stop', { ...common, operationId: 'stopBuildPreview', summary: 'Stop the editing container while keeping source', request: { params, headers }, responses: { 200: jsonResponse(detail), ...failures } }, handler);
  register(api, 'get', '/build/apps/{appId}/source', { ...common, operationId: 'getBuildSource', summary: 'Read saved working source, including edits from a failed build', request: { params, headers }, responses: { 200: jsonResponse(z.object({ revision: z.number().int(), files: z.record(z.string(), z.string()) })), ...failures } }, handler);
  register(api, 'get', '/build/apps/{appId}/export', { ...common, operationId: 'exportBuildSource', summary: 'Download portable source as a ZIP archive', request: { params, headers }, responses: { 200: { description: 'Source archive including original JPEG assets under public/generated. Run npm install and npm run build.', content: { 'application/zip': { schema: { type: 'string', format: 'binary' } } } }, ...failures } }, handler);
  const imageRequest = { params: params.extend({ imageId: z.uuid() }), headers };
  register(api, 'get', '/build/apps/{appId}/images/{imageId}', { ...common, operationId: 'getBuildImage', summary: 'Read an original image from an owned app',
    description: 'Session-authenticated JPEG bytes. Generated with Workers AI, retained independently of the sandbox and deleted with the app. Maximum 4 images per build and 12 per app. App previews and ZIP exports use local copies of these assets.',
    request: imageRequest, responses: { 200: { description: 'Original generated JPEG.', content: { 'image/jpeg': { schema: { type: 'string', format: 'binary' } } } }, ...errors(400, 401, 403, 404, 405, 503) } }, handler);
}
