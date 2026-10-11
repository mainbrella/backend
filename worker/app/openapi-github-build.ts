import { z } from 'zod';
import { cookieSecurity, errors, jsonResponse, register, requestBody, type LegacyHandler, type OpenAPIApi } from './openapi-shared';
import { repoName } from '../lib/repo-launch';
import { validGithubBranch } from '../lib/github-build';

const branch = z.string().refine(validGithubBranch, 'Invalid Git branch name.');
export function registerGithubBuildRoutes(api: OpenAPIApi, handler: LegacyHandler) {
  register(api, 'get', '/github/build/config', { operationId: 'getGithubBuildConfig', tags: ['Authentication'],
    summary: 'Check write-capable GitHub Build availability', security: [],
    responses: { 200: jsonResponse(z.object({ enabled: z.boolean() })), ...errors(403) } }, handler);
  register(api, 'post', '/github/build/connect', { operationId: 'connectGithubBuild', tags: ['Authentication'], security: cookieSecurity,
    summary: 'Connect the write-capable Build app for a project repository',
    description: 'Requires a browser session and trusted Origin. The project must belong to the signed-in user. Creates an owner-bound, one-use, expiring state with PKCE and a same-origin /projects/ return destination. The githubProject, githubRepo, and githubBranch query values must match this request. GitHub installation IDs never authorize repository access; each Build operation checks this user token. Credentials are encrypted in the Worker and never returned.',
    request: { headers: z.object({ Origin: z.string() }), ...requestBody(z.object({ projectId: z.uuid(), repo: repoName, branch: branch.default('main'),
      returnTo: z.string().max(1024).regex(/^\/projects\//).optional().describe('Same-origin /projects/ destination. The accepted githubProject, githubRepo, and githubBranch values must match this request.'), reauthorize: z.boolean().optional() }).strict()) },
    responses: { 200: jsonResponse(z.object({ url: z.url() })), ...errors(400, 401, 403, 404, 409, 503) } }, handler);
  register(api, 'get', '/github/build/connection', { operationId: 'getGithubBuildConnection', tags: ['Authentication'],
    summary: 'Read the current account’s GitHub Build connection', security: cookieSecurity,
    responses: { 200: jsonResponse(z.object({ connected: z.boolean(), login: z.string().nullable(), manageUrl: z.url() })), ...errors(401, 403, 503) } }, handler);
  for (const [path, operationId, summary] of [
    ['/github/build/callback', 'finishGithubBuildAuthorization', 'Finish GitHub Build authorization'],
    ['/github/build/setup', 'finishGithubBuildInstallation', 'Return from GitHub Build installation'],
  ]) register(api, 'get', path, { operationId, tags: ['Authentication'], summary, security: cookieSecurity,
    description: 'Requires the same Mainbrella account and an owner-bound, one-use, unexpired state. Authorization exchanges a code with PKCE and encrypts credentials server-side. Installation IDs are navigation hints only. Redirects only to the stored /projects/ destination.',
    request: { query: z.object({ state: z.string(), code: z.string().optional(), error: z.string().optional(), installation_id: z.string().optional(), setup_action: z.string().optional() }) },
    responses: { 302: { description: 'Continue to GitHub installation or return to the project page.', headers: { Location: { schema: { type: 'string' } } } }, ...errors(400, 401, 403, 503) } }, handler);
}
