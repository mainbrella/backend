import { z } from 'zod';
import { errors, jsonResponse, register, requestBody, type LegacyHandler, type OpenAPIApi } from '../app/openapi-shared';
import { demoSessionInput } from './demo';
import { emailLoginInput } from './email-auth';
import { apiKeyGrantInput, apiKeyInput, clientInvokeInput, filterInput, functionInput, invokeInput, migrationInput, projectInput, projectPatch, queryInput, sessionInput, tableNameInput, tableOperation, tablePolicyInput, tableReadInput } from './contracts';

const project = z.object({ id: z.string().uuid(), name: z.string(), state: z.enum(['pending', 'ready', 'error']), suspended: z.boolean(), created_at: z.string() });
const row = z.record(z.string(), z.unknown());
const result = z.object({ success: z.boolean(), results: z.array(row), meta: row.optional() });
const fn = z.object({ name: z.string(), version: z.number().int(), checksum: z.string(), database_access: z.enum(['none', 'read', 'write']), created_at: z.string() });
const params = z.object({ projectId: z.string().uuid() });
const functionParams = params.extend({ functionName: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,62}$/) });
const apiKey = z.object({ id: z.string().uuid(), name: z.string(), prefix: z.string(), origins: z.array(z.string()),
  tables: z.record(z.string(), z.array(tableOperation)), functions: z.record(z.string(), z.number().int()), created_at: z.string() });
const tablePolicy = z.object({ table: z.string(), select: z.enum(['none', 'public']), insert: z.enum(['none', 'own']), update: z.enum(['none', 'own']), delete: z.enum(['none', 'own']), ownerColumn: z.string().nullable(), updated_at: z.string() });
const userSession = z.object({ id: z.string().uuid(), user_id: z.string(), expires_at: z.string(), created_at: z.string() });

export function registerBffRoutes(api: OpenAPIApi, handler: LegacyHandler) {
  const ownerSecurity: Record<string, string[]>[] = [{ cookieAuth: [] }, { apiKeyBearer: [] }];
  const common = { tags: ['BFF'], security: ownerSecurity,
    description: 'BFF owner management API. Accepts a Mainbrella session cookie or an existing account API key (mb_ prefix) as Bearer authorization, using the same key authentication as Linux. Browser requests require an allowed Mainbrella Origin. Invalid explicit Bearer credentials never fall back to a cookie. Project ownership is always checked. Public browser apps use scoped keys on /bff/data routes and explicit public-read table policies. Own-row writes require a project user session and an ownership column policy. Owners can issue one-hour sessions for existing project-local users; message-board applications also support scoped email/password signup and login.' };
  const failure = errors(400, 401, 403, 404, 405, 408, 409, 413, 415, 422, 429, 502, 503);
  const route = (method: 'get' | 'post' | 'patch' | 'put' | 'delete', path: string, operationId: string, summary: string,
    request: object | undefined, response: z.ZodType, created = false) => register(api, method, path, {
      ...common, operationId, summary, ...(request ? { request } : {}),
      responses: { [created ? 201 : 200]: jsonResponse(response), ...(created && path === '/bff/projects' ? { 200: jsonResponse(response, 'Existing project returned on a name-based retry.') } : {}), ...failure },
    }, handler);
  route('get', '/bff/config', 'getBffConfig', 'Read BFF availability and execution limits', undefined,
    z.object({ version: z.string(), available: z.boolean().describe('BFF is enabled and its database provider is configured: local Wrangler D1 during local development, Cloudflare D1 credentials on deployed Workers.'), functionsAvailable: z.boolean(), limits: z.record(z.string(), z.number()) }));
  route('get', '/bff/projects', 'listBffProjects', 'List your BFF projects', undefined, z.object({ projects: z.array(project) }));
  route('post', '/bff/projects', 'createBffProject', 'Create a BFF project with a message-board starter by default; provision separately', requestBody(projectInput), z.object({ project }), true);
  const base = '/bff/projects/{projectId}';
  route('get', base, 'getBffProject', 'Read your BFF project', { params }, z.object({ project }));
  route('patch', base, 'pauseBffProject', 'Pause or resume database and function operations', { params, ...requestBody(projectPatch) }, z.object({ project }));
  route('post', `${base}/provision`, 'provisionBffDatabase', 'Provision or recover the project D1 database (local Wrangler D1 in local development)', { params }, z.object({ project }));
  route('get', `${base}/schema`, 'getBffSchema', 'Inspect up to 50 tables, columns, and actual row counts', { params },
    z.object({ tables: z.array(z.object({ name: z.string(), sql: z.string().nullable(), count: z.number(), columns: z.array(z.object({ name: z.string(), type: z.string(), notnull: z.number(), dflt_value: z.unknown(), pk: z.number() })) })), truncated: z.boolean() }));
  route('post', `${base}/query`, 'queryBffDatabase', 'Execute one SELECT, INSERT, UPDATE, or DELETE statement', { params, ...requestBody(queryInput) }, z.object({ result }));
  route('get', `${base}/migrations`, 'listBffMigrations', 'List up to 100 applied schema migrations', { params },
    z.object({ migrations: z.array(z.object({ sequence: z.number(), name: z.string(), checksum: z.string(), sql: z.string(), applied_at: z.string() })) }));
  route('post', `${base}/migrations`, 'applyBffMigration', 'Atomically apply the next migration with checksum-verified retries', { params, ...requestBody(migrationInput) }, z.object({ applied: z.boolean(), checksum: z.string() }));
  route('get', `${base}/functions`, 'listBffFunctions', 'List the latest saved function versions', { params }, z.object({ functions: z.array(fn) }));
  route('get', `${base}/functions/{functionName}`, 'getBffFunction', 'Read function source and version history', { params: functionParams },
    z.object({ function: fn.extend({ project_id: z.string(), source: z.string() }), versions: z.array(fn) }));
  route('put', `${base}/functions/{functionName}`, 'saveBffFunction', 'Save an immutable JavaScript function version', { params: functionParams, ...requestBody(functionInput) },
    z.object({ name: z.string(), version: z.number(), checksum: z.string() }), true);
  // z.json() validates recursively at runtime. The document uses an unconstrained
  // JSON value because this OpenAPI generator cannot expand recursive unions.
  route('post', `${base}/functions/{functionName}/invoke`, 'invokeBffFunction', 'Invoke an isolated function with denied network access and explicit database capability', { params: functionParams, ...requestBody(invokeInput.omit({ input: true }).extend({ input: z.unknown() })) },
    z.object({ id: z.string(), version: z.number(), ok: z.boolean(), value: z.unknown().optional(), error: z.string().optional() }));
  route('get', `${base}/executions`, 'listBffExecutions', 'List up to 100 invocation records; inputs and results are not stored', { params },
    z.object({ executions: z.array(z.object({ id: z.string(), function_name: z.string(), version: z.number(), status: z.enum(['running', 'success', 'error', 'timeout']), error: z.string().nullable(), duration_ms: z.number().nullable(), created_at: z.string() })) }));
  route('get', `${base}/usage`, 'getBffUsage', 'Read today’s enforced database and invocation budgets in UTC', { params }, z.object({ day: z.string(), queries: z.number(), invocations: z.number() }));
  route('get', `${base}/api-keys`, 'listBffApiKeys', 'List this project’s scoped browser keys from the shared API key store', { params }, z.object({ keys: z.array(apiKey) }));
  route('post', `${base}/api-keys`, 'createBffApiKey', 'Create a browser key with explicit table operations, allowed origins, and pinned function versions; token returned once',
    { params, ...requestBody(apiKeyInput) }, z.object({ key: apiKey, token: z.string() }), true);
  route('patch', `${base}/api-keys/{keyId}`, 'grantBffApiKeySelect', 'Idempotently add a table operation to one browser key; preserves its token, origins, other grants, and pinned functions; policies still apply to each operation',
    { params: params.extend({ keyId: z.string().uuid() }), ...requestBody(apiKeyGrantInput) }, z.object({ key: apiKey }));
  route('delete', `${base}/api-keys/{keyId}`, 'revokeBffApiKey', 'Revoke a browser key, including while its project is paused or BFF is disabled',
    { params: params.extend({ keyId: z.string().uuid() }) }, z.object({ revoked: z.boolean() }));
  route('get', `${base}/sessions`, 'listBffUserSessions', 'List active project user sessions; tokens are never listed', { params }, z.object({ sessions: z.array(userSession) }));
  route('post', `${base}/sessions`, 'createBffUserSession', 'Issue a one-hour demo session for an existing project-local user; owner only',
    { params, ...requestBody(sessionInput) }, z.object({ session: userSession, token: z.string() }), true);
  route('delete', `${base}/sessions/{sessionId}`, 'revokeBffUserSession', 'Revoke a project user session, including while paused or disabled',
    { params: params.extend({ sessionId: z.string().uuid() }) }, z.object({ revoked: z.boolean() }));
  route('get', `${base}/policies`, 'listBffTablePolicies', 'List table policies; tables without a policy deny anonymous access',
    { params }, z.object({ policies: z.array(tablePolicy) }));
  route('put', `${base}/policies/{table}`, 'setBffTablePolicy', 'Set public reads and own-row write policies on an existing table',
    { params: params.extend({ table: tableNameInput }), ...requestBody(tablePolicyInput) }, z.object({ policy: tablePolicy }));
  route('delete', `${base}/policies/{table}`, 'revokeBffTablePolicy', 'Revoke anonymous table access, including while paused or BFF is disabled; retries are idempotent',
    { params: params.extend({ table: tableNameInput }) }, z.object({ revoked: z.boolean() }));

  api.registry.registerComponent('securitySchemes', 'bffBearer', { type: 'http', scheme: 'bearer', description: 'Scoped project browser key (bff_pk_ prefix), managed in the shared /api-keys system. Does not authorize owner, Linux, or raw SQL APIs.' });
  api.registry.registerComponent('securitySchemes', 'bffApiKey', { type: 'apiKey', in: 'header', name: 'apikey', description: 'Scoped BFF browser key or trusted-server account key, supplied as an apikey header instead of Bearer authorization.' });
  api.registry.registerComponent('securitySchemes', 'bffUserSession', { type: 'http', scheme: 'bearer', description: 'Project user session (bff_us_ prefix). Requires a scoped browser key in the apikey header. For Data API operations, both key grants and row policies apply.' });
  const emailAuthBase = '/bff/data/{projectId}/auth';
  const emailAuthDescription = 'Real email/password accounts for message_board projects, separate from Mainbrella owner accounts. Requires a current scoped browser key and its exact allowed Origin. Credentials are stored as salted scrypt hashes in a private platform table, never exposed by the Data API. POST signs in an existing account or creates a project user for a new email (minimum 8-character password). Returns a standard bff_us_ Bearer token with a fixed 30-day lifetime, used alongside apikey for Data API grants and row policies. Existing sessions keep their original expiry; the longer lifetime applies to new email logins. Session records persist across Worker deploys. Login is rate limited by project and client IP. Cookies do not authenticate these endpoints. Session DELETE revokes only the supplied project token and remains available while paused or disabled.';
  const emailUser = z.object({ id: z.string().uuid(), email: z.string() });
  register(api, 'post', `${emailAuthBase}/email`, {
    tags: ['BFF'], security: [{ bffApiKey: [] }], operationId: 'signInBffEmailAccount', summary: 'Log in or create a project email/password account',
    description: emailAuthDescription, request: { params, ...requestBody(emailLoginInput) },
    responses: { 201: jsonResponse(z.object({ session: userSession, token: z.string(), user: emailUser, created: z.boolean() })), ...failure },
  }, handler);
  register(api, 'get', `${emailAuthBase}/session`, {
    tags: ['BFF'], security: [{ bffApiKey: [], bffUserSession: [] }], operationId: 'getBffEmailSession', summary: 'Check a project email account session',
    description: emailAuthDescription, request: { params },
    responses: { 200: jsonResponse(z.object({ session: userSession, user: emailUser })), ...failure },
  }, handler);
  register(api, 'delete', `${emailAuthBase}/session`, {
    tags: ['BFF'], security: [{ bffApiKey: [], bffUserSession: [] }], operationId: 'revokeBffEmailSession', summary: 'Log out of a project email account',
    description: emailAuthDescription, request: { params },
    responses: { 200: jsonResponse(z.object({ revoked: z.boolean() })), ...failure },
  }, handler);
  const demoDescription = 'Deliberate passwordless public-login exception for the fixed BFF message-board example only. Requires its exact configured public browser key in the apikey header, a current shared key and matching project grant/owner, and an exact allowed Origin when supplied. No account cookie or account key authorizes this route. POST accepts only Alice or Bob and returns a real one-hour project user session; it never provisions data or widens grants. DELETE revokes only the supplied Bearer session token in that fixed project and remains available while paused or disabled. All data access continues through standard /bff/data grants and row ownership policies. Other message-board projects can use email/password accounts; owner-issued sessions remain available for all projects.';
  register(api, 'post', '/bff/demo/session', {
    tags: ['BFF'], security: [{ bffApiKey: [] }], operationId: 'createBffDemoSession', summary: 'Log in as Alice or Bob in the fixed public demo',
    description: demoDescription, request: requestBody(demoSessionInput),
    responses: { 201: jsonResponse(z.object({ session: userSession, token: z.string() })), ...failure },
  }, handler);
  register(api, 'delete', '/bff/demo/session', {
    tags: ['BFF'], security: [{ bffApiKey: [], bffUserSession: [] }], operationId: 'revokeBffDemoSession', summary: 'Log out of the fixed public demo',
    description: demoDescription, responses: { 200: jsonResponse(z.object({ revoked: z.boolean() })), ...failure },
  }, handler);
  const clientRoute = (method: 'get' | 'post' | 'patch' | 'delete', path: string, operationId: string, summary: string,
    request: object, response: z.ZodType, created = false) => register(api, method, path, {
      tags: ['BFF'], security: [{ apiKeyBearer: [] }, { bffBearer: [] }, { bffApiKey: [] }, { bffApiKey: [], bffUserSession: [] }], operationId, summary,
      description: 'Accepts existing account keys for the owner’s projects or scoped browser keys from the shared API key store. Account keys have owner access and run the latest function version; browser origins are limited to trusted Mainbrella origins. Anonymous reads require both a SELECT key grant and a table policy with select=public. Missing or none policies deny access. Public reads expose all rows and selected columns. Writes require a scoped key grant, an own-row operation policy with ownerColumn, and Authorization: Bearer bff_us_... alongside apikey: bff_pk_.... Sessions are project-local. Email login sessions expire after 30 days; owner-issued and fixed-demo sessions expire after one hour. Sessions can be issued by the project owner or by email/password login for message-board projects at /bff/data/{projectId}/auth/email; the fixed public example also permits Alice/Bob login at /bff/demo/session. Insert fills the ownership column from the session; forged authors or ownership transfers return 403. Update and delete append an ownership predicate to the original filters; other users’ rows yield no changes. Anonymous writes remain denied. Scoped keys require pinned function versions and an exact configured origin when Origin is sent. Functions invoked by browser keys use the same table policies and key grants, checked on every database call; they cannot bypass policy. Functions receive the authenticated session identity as ctx.user (null for anonymous and owner calls). Owner invocations retain administrative database access. Cookies do not authenticate this API. Table filters use column=eq.value or column=is.null, combined with AND. Duplicate query parameters are rejected. PATCH and DELETE require at least one filter for all requests. All operations share project budgets and pause/block switches. Responses are not cached.',
      request, responses: { [created ? 201 : 200]: jsonResponse(response), ...failure },
    }, handler);
  const dataBase = '/bff/data/{projectId}';
  const tableParams = params.extend({ table: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,62}$/) });
  const dataResult = z.object({ data: z.array(row), meta: row });
  clientRoute('get', `${dataBase}/tables/{table}`, 'selectBffTableRows', 'Select table rows as JSON; select is * or comma-separated columns, order is column.asc or column.desc',
    { params: tableParams, query: tableReadInput.catchall(z.string()) }, dataResult);
  clientRoute('post', `${dataBase}/tables/{table}`, 'insertBffTableRow', 'Insert one JSON row and return the inserted row; no query parameters accepted',
    { params: tableParams, ...requestBody(filterInput) }, dataResult, true);
  clientRoute('patch', `${dataBase}/tables/{table}`, 'updateBffTableRows', 'Update matching rows from a JSON object and return the updated rows',
    { params: tableParams, query: z.object({}).catchall(z.string()), ...requestBody(filterInput) }, dataResult);
  clientRoute('delete', `${dataBase}/tables/{table}`, 'deleteBffTableRows', 'Delete matching rows; data is empty and meta.changes reports the affected count',
    { params: tableParams, query: z.object({}).catchall(z.string()) }, dataResult);
  clientRoute('post', `${dataBase}/functions/{functionName}/invoke`, 'invokeBffClientFunction', 'Invoke the isolated function version explicitly granted to this browser key',
    { params: functionParams, ...requestBody(clientInvokeInput.omit({ input: true }).extend({ input: z.unknown() })) },
    z.object({ id: z.string(), version: z.number(), ok: z.boolean(), value: z.unknown().optional(), error: z.string().optional() }));
}
