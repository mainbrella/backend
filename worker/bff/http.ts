import { boundedBody } from '../shared/bounded-body.js';
import { BffError, type Project } from './contracts';

export async function body(request: Request, maxBytes = 100_000): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new BffError('json_required', 415);
  let bytes;
  try { bytes = await boundedBody(request.body, maxBytes); }
  catch { throw new BffError('request_too_large', 413); }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new BffError('invalid_json'); }
}
export function enabled(env: Env) {
  if (env.BFF_ENABLED !== 'true') throw new BffError('bff_unavailable', 503);
}
export function readyProject(env: Env, project: Project) {
  enabled(env);
  if (project.blocked) throw new BffError('project_blocked', 403);
  if (project.suspended) throw new BffError('project_paused', 403);
  if (project.state !== 'ready') throw new BffError('database_not_ready', 409);
}
