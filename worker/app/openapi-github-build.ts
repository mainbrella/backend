import { z } from 'zod';
import { cookieSecurity, errors, jsonResponse, register, requestBody, type LegacyHandler, type OpenAPIApi } from './openapi-shared';
import { repoName } from '../shared/github-git';
import { validGithubBranch, validGithubRepositoryCursor } from '../lib/github-build';

const branch = z.string().refine(validGithubBranch, 'Invalid Git branch name.');
export function registerGithubBuildRoutes(api: OpenAPIApi, handler: LegacyHandler) {
  register(api, 'get', '/github/build/config', { operationId: 'getGithubBuildConfig', tags: ['Authentication'],
    summary: 'Check write-capable GitHub Build availability', security: [],
    responses: { 200: jsonResponse(z.object({ enabled: z.boolean() })), ...errors(403) } }, handler);
  register(api, 'post', '/github/build/connect', { operationId: 'connectGithubBuild', tags: ['Authentication'], security: cookieSecurity,
    summary: 'Install and authorize the write-capable Build app for a project',
    description: 'Requires a browser session and trusted Origin. Omit repo and branch to start at GitHub installation, where the user selects a personal account or organization and grants access to all or selected repositories. Installation is followed by user authorization with PKCE, then returns to the project repository picker. Optional repo and branch preserve the previous repository-specific flow. State is owner-bound, one-use, and expiring. Return query values must match this request. Installation IDs never authorize access. Credentials are encrypted and never returned.',
    request: { headers: z.object({ Origin: z.string() }), ...requestBody(z.object({ projectId: z.uuid(), repo: repoName.optional(), branch: branch.optional(),
      returnTo: z.string().max(1024).regex(/^\/projects\//).optional().describe('Same-origin /projects/ destination. Only githubProject and matching optional githubRepo/githubBranch are accepted.'), reauthorize: z.boolean().optional() }).strict().refine(body => body.repo !== undefined || body.branch === undefined, 'Branch requires repo.')) },
    responses: { 200: jsonResponse(z.object({ url: z.url() })), ...errors(400, 401, 403, 404, 409, 503) } }, handler);
  register(api, 'get', '/github/build/connection', { operationId: 'getGithubBuildConnection', tags: ['Authentication'],
    summary: 'Read the current account’s GitHub Build connection', security: cookieSecurity,
    responses: { 200: jsonResponse(z.object({ connected: z.boolean(), login: z.string().nullable(), manageUrl: z.url() })), ...errors(401, 403, 503) } }, handler);
  register(api, 'get', '/github/build/repositories', { operationId: 'listGithubBuildRepositories', tags: ['Projects'], security: cookieSecurity,
    summary: 'List writable repositories available to the GitHub Build connection',
    description: 'Uses only the signed-in user’s Build token. Lists repositories from active installations with Contents write access, filtered to repositories where the user can push. Archived, disabled, suspended, and read-only repositories are excluded. Pass nextCursor back to continue across repository pages and installations; a page can be empty while nextCursor is present. Repository linking independently verifies write access.',
    request: { query: z.object({ cursor: z.string().refine(validGithubRepositoryCursor).optional() }).strict() },
    responses: { 200: jsonResponse(z.object({ repositories: z.array(z.object({ id: z.number().int(), fullName: repoName, defaultBranch: branch, private: z.boolean() })), nextCursor: z.string().nullable() })), ...errors(400, 401, 403, 404, 409, 429, 503) } }, handler);
  for (const [path, operationId, summary] of [
    ['/github/build/callback', 'finishGithubBuildAuthorization', 'Finish GitHub Build authorization'],
    ['/github/build/setup', 'finishGithubBuildInstallation', 'Return from GitHub Build installation'],
  ]) register(api, 'get', path, { operationId, tags: ['Authentication'], summary, security: cookieSecurity,
    description: 'Requires the same Mainbrella account and an owner-bound, one-use, unexpired state. Authorization exchanges a code with PKCE and encrypts credentials server-side. Installation IDs are navigation hints only. Redirects only to the stored /projects/ destination.',
    request: { query: z.object({ state: z.string(), code: z.string().optional(), error: z.string().optional(), installation_id: z.string().optional(), setup_action: z.string().optional() }) },
    responses: { 302: { description: 'Continue to GitHub installation or return to the project page.', headers: { Location: { schema: { type: 'string' } } } }, ...errors(400, 401, 403, 503) } }, handler);
}
