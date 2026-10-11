import { z } from 'zod';
import { cookieSecurity, errors, jsonResponse, register, requestBody, type LegacyHandler, type OpenAPIApi } from './openapi-shared';
import { repoName } from '../lib/repo-launch';
import { validGithubBranch } from '../lib/github-build';
import { BUILD_MAX_FILES, BUILD_MAX_FILE_BYTES, BUILD_MAX_SOURCE_BYTES } from '../lib/build-contract';

const branch = z.string().refine(validGithubBranch, 'Invalid Git branch name.');
const github = z.object({ repo: z.string(), branch: z.string(), commitId: z.string().nullable(), url: z.url() }).nullable();
export function registerProjectGithubRoutes(api: OpenAPIApi, handler: LegacyHandler) {
  register(api, 'get', '/projects/github', { operationId: 'getProjectGithubLink', tags: ['Projects'], summary: 'Read a project’s GitHub link', security: cookieSecurity,
    description: 'Requires a browser session. Returns the repository, branch, last accepted commit, and GitHub URL for a project owned by the signed-in user.',
    request: { query: z.object({ id: z.uuid() }) }, responses: { 200: jsonResponse(z.object({ github })), ...errors(400, 401, 403, 404, 503) } }, handler);
  register(api, 'put', '/projects/github', { operationId: 'linkProjectGithub', tags: ['Projects'], summary: 'Link a project to GitHub', security: cookieSecurity,
    description: `Requires a trusted Origin and browser session. Uses the separate write-capable Build app and checks both the user and app repository permissions. Blocks concurrent builds while transferring the complete hosted Git history to an empty destination branch or the same saved Git head. Verifies the remote before atomically switching the project, clearing hosted Git heads/version rows, and queuing hosted bundle cleanup. Existing source and hosted Git history remain available if linking fails. Existing links cannot be repointed; repeated requests for the same repository verify access. Plain projects import supported source from an existing branch or link an empty repository. Source limits are ${BUILD_MAX_FILES} text files, ${BUILD_MAX_FILE_BYTES / 1024 / 1024} MiB per file and ${BUILD_MAX_SOURCE_BYTES / 1024 / 1024} MiB of serialized source. Working source and its manifest are stored in private R2; D1 retains an object reference. Source storage uses existing prepaid funding and account storage limits; insufficient funding returns 402. Builder commits and history reads subsequently use GitHub without hosted Git fallback.`,
    request: { headers: z.object({ Origin: z.string() }), query: z.object({ id: z.uuid() }), ...requestBody(z.object({ repo: repoName, branch: branch.default('main') }).strict()) },
    responses: { 200: jsonResponse(z.object({ github })), ...errors(400, 401, 402, 403, 404, 409, 413, 429, 503) } }, handler);
}
