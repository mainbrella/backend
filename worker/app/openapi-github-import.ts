import { z } from 'zod';
import { cookieSecurity, errors, jsonResponse, register, requestBody, type LegacyHandler, type OpenAPIApi } from './openapi-shared';
import { repoName } from '../lib/repo-launch';

export function registerGithubImportRoutes(api: OpenAPIApi, handler: LegacyHandler) {
  register(api, 'get', '/github/import/config', { operationId: 'getGithubImportConfig', tags: ['Authentication'],
    summary: 'Check read-only GitHub Import availability', security: [],
    responses: { 200: jsonResponse(z.object({ enabled: z.boolean() })), ...errors(403) } }, handler);
  register(api, 'post', '/github/import/connect', { operationId: 'connectGithubImport', tags: ['Authentication'],
    summary: 'Connect the read-only Import app for selected repositories', security: cookieSecurity,
    description: 'Browser session and trusted Origin required. Creates an owner-bound, one-use state and PKCE challenge. Returns GitHub authorization or installation URL; never tokens. No payment or allocation. Separate from future write-capable Build integration.',
    request: { headers: z.object({ Origin: z.string() }), ...requestBody(z.object({ repo: repoName, returnTo: z.string().optional(), reauthorize: z.boolean().optional() }).strict()) },
    responses: { 200: jsonResponse(z.object({ url: z.url() })), ...errors(400, 401, 403, 503) } }, handler);
  register(api, 'get', '/github/import/connection', { operationId: 'getGithubImportConnection', tags: ['Authentication'],
    summary: 'Read the current account’s GitHub Import connection', security: cookieSecurity,
    responses: { 200: jsonResponse(z.object({ connected: z.boolean(), login: z.string().nullable(), manageUrl: z.url() })), ...errors(401, 403, 503) } }, handler);
  register(api, 'delete', '/github/import/connection', { operationId: 'disconnectGithubImport', tags: ['Authentication'],
    summary: 'Remove stored GitHub Import credentials', security: cookieSecurity,
    description: 'Browser session and trusted Origin required. Deletes encrypted credentials and pending states. Does not uninstall the GitHub App or erase existing checkouts; manage installations in GitHub and stop/delete saved workspaces separately.',
    request: { headers: z.object({ Origin: z.string() }) }, responses: { 200: jsonResponse(z.object({ ok: z.boolean() })), ...errors(401, 403, 503) } }, handler);
  for (const [path, operationId, summary] of [
    ['/github/import/callback', 'finishGithubImportAuthorization', 'Finish GitHub Import authorization'],
    ['/github/import/setup', 'finishGithubImportInstallation', 'Return from GitHub Import installation'],
  ]) register(api, 'get', path, { operationId, tags: ['Authentication'], summary, security: cookieSecurity,
    description: 'Requires the same Mainbrella account and owner-bound, one-use, unexpired state. Authorization exchanges a code with PKCE and encrypts credentials server-side. Installation IDs never authorize repository access. Redirects only to the stored trusted /run/ destination.',
    request: { query: z.object({ state: z.string(), code: z.string().optional(), error: z.string().optional(), installation_id: z.string().optional(), setup_action: z.string().optional() }) },
    responses: { 302: { description: 'Continue to GitHub installation or return to repository setup.', headers: { Location: { schema: { type: 'string' } } } }, ...errors(400, 401, 403, 503) } }, handler);
}
