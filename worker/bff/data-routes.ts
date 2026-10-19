import { authCorsHeaders, authJson } from '../app/auth-core';
import { apiKeyIdentity, recordApiKeyUse } from '../app/api-keys';
import { publicApiKey } from './api-keys';
import { BffError, checksum, clientInvokeInput, LIMITS, parse, type ApiKeyRecord, type DatabasePrincipal, type FunctionVersion, type Project } from './contracts';
import { ProjectDatabase } from './database';
import { body, enabled, readyProject } from './http';
import { invokeFunction } from './invocation';
import { authorizedQuery } from './policies';
import { identifier } from './sql';
import { tableParameters } from './table-queries';

export async function handleDataRequest(request: Request, env: Env): Promise<Response> {
  const cors: Record<string, string> = { vary: 'Origin' };
  const reply = (data: unknown, status = 200) => authJson(data, status, cors);
  try {
    const url = new URL(request.url);
    const match = /^\/bff\/data\/([a-f0-9-]{36})\/(tables|functions)\/([a-zA-Z][a-zA-Z0-9_]{0,62})(\/invoke)?$/.exec(url.pathname);
    if (!match) throw new BffError('not_found', 404);
    const [, projectId, resource, name, invocation] = match;
    if ((resource === 'functions') !== !!invocation) throw new BffError('not_found', 404);
    identifier(name);
    enabled(env);
    const methods = resource === 'tables' ? ['GET', 'POST', 'PATCH', 'DELETE'] : ['POST'];
    const origin = request.headers.get('origin');
    if (request.method === 'OPTIONS') {
      if (origin) {
        // Preflights carry no key. The actual request checks its own key's origins.
        const keys = await env.DB.prepare('SELECT origins FROM bff_api_key_grants WHERE project_id=?').bind(projectId).all<{ origins: string }>();
        if (!authCorsHeaders(request, env) && !keys.results.some(key => (JSON.parse(key.origins) as string[]).includes(origin))) throw new BffError('origin_not_allowed', 403);
        cors['access-control-allow-origin'] = origin;
      }
      const requestedMethod = request.headers.get('access-control-request-method');
      const requestedHeaders = (request.headers.get('access-control-request-headers') || '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
      if ((requestedMethod && !methods.includes(requestedMethod)) || requestedHeaders.some(header => !['authorization', 'apikey', 'content-type'].includes(header))) throw new BffError('origin_not_allowed', 403);
      return new Response(null, { status: 204, headers: { ...cors, 'cache-control': 'no-store',
        'access-control-allow-methods': [...methods, 'OPTIONS'].join(', '),
        'access-control-allow-headers': 'authorization, apikey, content-type', 'access-control-max-age': '600' } });
    }
    if (!methods.includes(request.method)) throw new BffError('method_not_allowed', 405);
    const authorization = request.headers.get('authorization');
    const bearer = authorization ? /^Bearer ((?:mb_|bff_pk_|bff_us_)[a-f0-9]{64})$/i.exec(authorization)?.[1] : undefined;
    const apiKey = request.headers.get('apikey');
    const sessionToken = bearer?.startsWith('bff_us_') ? bearer : undefined;
    if ((authorization && !bearer) || (!sessionToken && bearer && apiKey && bearer !== apiKey)
      || (sessionToken && !apiKey?.startsWith('bff_pk_'))) throw new BffError('unauthorized', 401);
    const token = sessionToken ? apiKey : bearer || apiKey;
    if (!token) throw new BffError('unauthorized', 401);
    const identity = await apiKeyIdentity(env, token);
    if (!identity) throw new BffError('unauthorized', 401);
    const scoped = identity.prefix.startsWith('bff_pk_');
    const record = scoped ? await env.DB.prepare('SELECT k.id,k.name,k.prefix,g.origins,g.tables,g.functions,k.created_at FROM api_keys k JOIN bff_api_key_grants g ON g.api_key_id=k.id WHERE g.project_id=? AND k.id=?').bind(projectId, identity.key_id).first<ApiKeyRecord>() : null;
    if (scoped && !record) throw new BffError('unauthorized', 401);
    const key = record ? publicApiKey(record) : null;
    if (origin && (key ? !key.origins.includes(origin) : !authCorsHeaders(request, env))) throw new BffError('origin_not_allowed', 403);
    if (origin) cors['access-control-allow-origin'] = origin;
    const project = await env.DB.prepare('SELECT * FROM bff_projects WHERE id=? AND user_id=?').bind(projectId, identity.id).first<Project>();
    if (!project) throw new BffError('not_found', 404);
    readyProject(env, project);
    let principal: DatabasePrincipal = key ? { role: 'anon', keyId: key.id } : { role: 'owner' };
    if (sessionToken && key) {
      const session = await env.DB.prepare('SELECT id,user_id FROM bff_user_sessions WHERE project_id=? AND token_hash=? AND expires_at>?')
        .bind(projectId, await checksum(sessionToken), new Date().toISOString()).first<{ id: string; user_id: string }>();
      if (!session) throw new BffError('unauthorized', 401);
      principal = { role: 'user', keyId: key.id, userId: session.user_id, sessionId: session.id };
    }
    await recordApiKeyUse(env, identity.key_id);
    if (resource === 'functions') {
      if (key && !Object.hasOwn(key.functions, name)) throw new BffError('permission_denied', 403);
      if (url.search) throw new BffError('invalid_request');
      const input = parse(clientInvokeInput, await body(request, LIMITS.inputBytes));
      const fn = await env.DB.prepare(`SELECT * FROM bff_function_versions WHERE project_id=? AND name=? ${key ? 'AND version=?' : ''} ORDER BY version DESC LIMIT 1`)
        .bind(projectId, name, ...(key ? [key.functions[name]] : [])).first<FunctionVersion>();
      if (!fn) throw new BffError('not_found', 404);
      return reply(await invokeFunction(env, project, fn, input.input, principal));
    }
    const operation = { GET: 'select', POST: 'insert', PATCH: 'update', DELETE: 'delete' }[request.method] as 'select' | 'insert' | 'update' | 'delete';
    if (key && (!Object.hasOwn(key.tables, name) || !key.tables[name].includes(operation))) throw new BffError('permission_denied', 403);
    const query = tableParameters(url.searchParams, request.method === 'GET');
    if (request.method === 'POST' && url.search) throw new BffError('invalid_request');
    const row = ['POST', 'PATCH'].includes(request.method) ? await body(request, LIMITS.inputBytes) : undefined;
    const compiled = await authorizedQuery(env, project, principal, name, operation, { ...query, row });
    const [result] = await new ProjectDatabase(env, project).query([compiled]);
    return reply({ data: result.results, meta: result.meta ?? {} }, request.method === 'POST' ? 201 : 200);
  } catch (error) {
    if (error instanceof BffError) return reply({ error: error.code }, error.status);
    console.error('bff_data_request_failed');
    return reply({ error: 'bff_unavailable' }, 503);
  }
}
