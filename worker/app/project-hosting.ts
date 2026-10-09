import { authCorsHeaders, authJson, currentUser } from './auth-core';
import { runningContainer, containerError } from '../lib/container-service';
import { machineName } from '../../containers/container-account-core.js';
import { boundedPrivateBody } from '../../containers/private-services-contract.js';
import { projectHostingConfigured, customDomainsConfigured, localProjectDomains, projectDomainOrigin, projectHostingCapabilities, projectOrigin,
  publicProjectTarget, validProjectId, validProjectTarget, type ProjectTarget, type StoredProjectTarget, type ProjectEndpointRoute } from '../lib/project-hosting';
import { normalizeProjectHostname, publicProjectDomain, domainDnsProof, provisionCloudflareHostname,
  cloudflareRequest, ingressTlsReady, type ProjectDomainRow } from '../lib/project-domains';

class HostingError extends Error { constructor(message: string, public status = 503) { super(message); } }
async function body(request: Request): Promise<unknown> {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await boundedPrivateBody(request.body, 1024))); }
  catch (error) { throw new HostingError(error instanceof Error && error.message === 'request_too_large' ? 'request_too_large' : 'invalid_request', error instanceof Error && error.message === 'request_too_large' ? 413 : 400); }
}
async function checkedRun(statement: D1PreparedStatement) {
  const result = await statement.run();
  if (!(result as { success?: boolean }).success && (result as { success?: boolean }).success !== undefined) throw new HostingError('project_hosting_unavailable');
  return result;
}
async function routeFor(env: Env, id: string, userId: string): Promise<ProjectEndpointRoute | null> {
  return env.PREVIEW_ROUTES ? env.PREVIEW_ROUTES.prepare('SELECT * FROM project_endpoints WHERE project_id = ? AND user_id = ?').bind(id, userId).first<ProjectEndpointRoute>() : null;
}
async function domainsFor(env: Env, id: string) {
  const rows = await env.DB.prepare('SELECT * FROM project_domains WHERE project_id = ? ORDER BY created_at, id').bind(id).all<ProjectDomainRow>();
  return rows.results.map(row => publicProjectDomain(row, env));
}
async function registeredTarget(env: Env, userId: string, target: ProjectTarget): Promise<StoredProjectTarget> {
  if (target.kind === 'container') return target;
  const account = env.CONTAINER_ACCOUNT!.get(env.CONTAINER_ACCOUNT!.idFromName(`account:${userId}`));
  const response = await account.fetch(new Request('https://internal/private-services/networks', { headers: { 'x-mainbrella-user': userId } }));
  if (!response.ok) throw new HostingError('project_hosting_unavailable');
  const data = await response.json() as { networks?: { name: string; members: { name: string; id: string; createdAt: string; port?: number }[] }[] };
  const member = data.networks?.find(network => network.name === target.network)?.members.find(value => value.name === target.service);
  if (!member || !validProjectTarget({ kind: 'container', id: member.id, createdAt: member.createdAt, port: member.port })) throw new HostingError('service_unavailable', 409);
  return { ...target, snapshot: { id: member.id, createdAt: member.createdAt, port: member.port! } };
}
async function snapshotRunning(env: Env, userId: string, target: StoredProjectTarget) {
  const snapshot = target.kind === 'container' ? target : target.snapshot;
  if (!snapshot) throw new HostingError('container_not_running', 409);
  const running = await runningContainer(env, userId, snapshot.id);
  if (!running.stub || !running.container || running.container.createdAt !== snapshot.createdAt || Date.parse(running.container.expiresAt) <= Date.now()) throw new HostingError('container_not_running', 409);
  return { snapshot, stub: running.stub };
}
async function endpointPayload(env: Env, id: string, userId: string) {
  const route = await routeFor(env, id, userId);
  let backendStatus: 'running' | 'unavailable' | 'unlinked' = route ? 'unavailable' : 'unlinked';
  let target: ProjectTarget | null = null;
  if (route) {
    const stored = JSON.parse(route.target_json) as StoredProjectTarget;
    target = publicProjectTarget(stored);
    try {
      if (stored.kind === 'network') {
        const current = await registeredTarget(env, userId, target);
        if (JSON.stringify(current.snapshot) !== JSON.stringify(stored.snapshot)) throw new Error('service_unavailable');
      }
      await snapshotRunning(env, userId, stored); backendStatus = 'running';
    } catch { /* Keep owner inspection available after expiry, replacement or loss of billing. */ }
  }
  return { endpoint: { projectId: id, url: `${projectOrigin(env, id)}/`, target, backendStatus }, domains: await domainsFor(env, id), hosting: projectHostingCapabilities(env) };
}
async function revokeBinding(env: Env, route: ProjectEndpointRoute, origin?: string): Promise<boolean> {
  if (!env.USER_CONTAINER) return false;
  try {
    const url = new URL('https://internal/project-bindings');
    url.searchParams.set('id', route.project_id); url.searchParams.set('revision', route.revision);
    if (origin) url.searchParams.set('origin', origin);
    const stub = env.USER_CONTAINER.get(env.USER_CONTAINER.idFromName(route.container_name));
    const response = await stub.fetch(new Request(url, { method: 'DELETE', headers: { 'x-project-created-at': route.created_at } }));
    if (!response.ok) return false;
    if (!origin && env.PREVIEW_ROUTES) await checkedRun(env.PREVIEW_ROUTES.prepare('DELETE FROM project_binding_operations WHERE revision = ? AND project_id = ? AND user_id = ?').bind(route.revision, route.project_id, route.user_id));
    return true;
  } catch { return false; }
}
async function revokeProjectOrigin(env: Env, id: string, userId: string, hostname: string): Promise<boolean> {
  if (!env.PREVIEW_ROUTES) return false;
  const operations = await env.PREVIEW_ROUTES.prepare('SELECT route_json FROM project_binding_operations WHERE project_id = ? AND user_id = ?').bind(id, userId).all<{ route_json: string }>();
  const routes = new Map(operations.results.map(value => { const route = JSON.parse(value.route_json) as ProjectEndpointRoute; return [route.revision, route]; }));
  const current = await routeFor(env, id, userId);
  if (current) routes.set(current.revision, current);
  let complete = true;
  for (const route of routes.values()) if (!await revokeBinding(env, route, projectDomainOrigin(env, hostname))) complete = false;
  return complete;
}
async function fence(env: Env, id: string, userId: string): Promise<string> {
  const db = env.PREVIEW_ROUTES!;
  await checkedRun(db.prepare('INSERT OR IGNORE INTO project_route_versions (project_id, user_id, revision) VALUES (?, ?, ?)').bind(id, userId, crypto.randomUUID()));
  const current = await db.prepare('SELECT revision FROM project_route_versions WHERE project_id = ? AND user_id = ?').bind(id, userId).first<{ revision: string }>();
  if (!current) throw new HostingError('project_conflict', 409);
  const revision = crypto.randomUUID();
  const changed = await checkedRun(db.prepare('UPDATE project_route_versions SET revision = ? WHERE project_id = ? AND user_id = ? AND revision = ?').bind(revision, id, userId, current.revision));
  if (!changed.meta.changes) throw new HostingError('project_conflict', 409);
  return revision;
}
async function publish(env: Env, id: string, userId: string, target: ProjectTarget) {
  if (!projectHostingConfigured(env)) throw new HostingError('project_hosting_unavailable');
  const stored = await registeredTarget(env, userId, target);
  const { snapshot, stub } = await snapshotRunning(env, userId, stored);
  const db = env.PREVIEW_ROUTES!;
  const count = await db.prepare('SELECT count(*) AS count FROM project_binding_operations WHERE project_id = ? AND user_id = ?').bind(id, userId).first<{ count: number }>();
  if (count && count.count >= 16) throw new HostingError('project_reconciliation_required');
  const priorOperations = await db.prepare('SELECT route_json FROM project_binding_operations WHERE project_id = ? AND user_id = ?').bind(id, userId).all<{ route_json: string }>();
  const revision = await fence(env, id, userId);
  const previous = await routeFor(env, id, userId);
  const route: ProjectEndpointRoute = { project_id: id, user_id: userId, target_json: JSON.stringify(stored), container_name: machineName(userId, snapshot.id), created_at: snapshot.createdAt, port: snapshot.port, revision, updated_at: new Date().toISOString() };
  try {
    await checkedRun(db.prepare('INSERT INTO project_binding_operations (revision, project_id, user_id, route_json, updated_at) VALUES (?, ?, ?, ?, ?)').bind(revision, id, userId, JSON.stringify(route), route.updated_at));
    const response = await stub.fetch(new Request('https://internal/project-bindings', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-project-created-at': snapshot.createdAt }, body: JSON.stringify({ id, revision, port: snapshot.port }) }));
    if (!response.ok) throw new HostingError(response.status === 409 ? 'container_not_running' : 'project_hosting_unavailable', response.status === 409 ? 409 : 503);
    const result = await response.json() as { id?: string; revision?: string; port?: number; createdAt?: string };
    if (result.id !== id || result.revision !== revision || result.port !== snapshot.port || result.createdAt !== snapshot.createdAt) throw new HostingError('project_hosting_unavailable');
    const inserted = await checkedRun(db.prepare(`INSERT INTO project_endpoints (project_id, user_id, target_json, container_name, created_at, port, revision, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM project_route_versions WHERE project_id = ? AND user_id = ? AND revision = ?)
      ON CONFLICT(project_id) DO UPDATE SET target_json=excluded.target_json, container_name=excluded.container_name,
      created_at=excluded.created_at, port=excluded.port, revision=excluded.revision, updated_at=excluded.updated_at WHERE project_endpoints.user_id=excluded.user_id`)
      .bind(id, userId, route.target_json, route.container_name, route.created_at, route.port, revision, route.updated_at, id, userId, revision));
    if (!inserted.meta.changes) throw new HostingError('project_conflict', 409);
  } catch (error) {
    let clean = true;
    try { await checkedRun(db.prepare('DELETE FROM project_endpoints WHERE project_id = ? AND user_id = ? AND revision = ?').bind(id, userId, revision)); } catch { clean = false; }
    if (!await revokeBinding(env, route)) clean = false;
    if (!clean) throw new HostingError('project_reconciliation_required');
    throw error;
  }
  const superseded = new Map(priorOperations.results.map(value => { const route = JSON.parse(value.route_json) as ProjectEndpointRoute; return [route.revision, route]; }));
  if (previous) superseded.set(previous.revision, previous);
  let complete = true;
  for (const route of superseded.values()) if (!await revokeBinding(env, route)) complete = false;
  if (!complete) throw new HostingError('project_reconciliation_required');
}
async function unpublish(env: Env, id: string, userId: string) {
  if (!env.PREVIEW_ROUTES) throw new HostingError('project_hosting_unavailable');
  const db = env.PREVIEW_ROUTES;
  const rows = await db.prepare('SELECT route_json FROM project_binding_operations WHERE project_id = ? AND user_id = ?').bind(id, userId).all<{ route_json: string }>();
  const revision = await fence(env, id, userId);
  const route = await db.prepare('SELECT * FROM project_endpoints WHERE project_id = ? AND user_id = ? AND EXISTS (SELECT 1 FROM project_route_versions WHERE project_id = ? AND user_id = ? AND revision = ?)').bind(id, userId, id, userId, revision).first<ProjectEndpointRoute>();
  // Delete only routes present when this operation was fenced; a newer successful publish wins.
  let complete = true;
  if (route) { try { await checkedRun(db.prepare('DELETE FROM project_endpoints WHERE project_id = ? AND user_id = ? AND revision = ? AND EXISTS (SELECT 1 FROM project_route_versions WHERE project_id = ? AND user_id = ? AND revision = ?)').bind(id, userId, route.revision, id, userId, revision)); } catch { complete = false; } }
  const known = new Map(rows.results.map(value => { const parsed = JSON.parse(value.route_json) as ProjectEndpointRoute; return [parsed.revision, parsed]; }));
  if (route) known.set(route.revision, route);
  for (const value of known.values()) if (!await revokeBinding(env, value)) complete = false;
  if (!complete) throw new HostingError('project_reconciliation_required');
}
async function removeDomain(env: Env, id: string, userId: string, initial: ProjectDomainRow) {
  if (!env.PREVIEW_ROUTES && (initial.status !== 'pending_dns' || initial.provider_id || initial.operation_revision)) throw new HostingError('domain_reconciliation_required');
  // Retain the disabled claim while provider cleanup or an earlier verification is outstanding.
  await checkedRun(env.DB.prepare('UPDATE project_domains SET removing = 1 WHERE id = ? AND project_id = ?').bind(initial.id, id));
  let complete = true, ownedClaim = false;
  if (env.PREVIEW_ROUTES) {
    try {
      const disabled = await checkedRun(env.PREVIEW_ROUTES.prepare("UPDATE project_hosts SET status = 'disabled' WHERE hostname = ? AND project_id = ? AND verification_token = ?").bind(initial.hostname, id, initial.challenge));
      ownedClaim = Boolean(disabled.meta.changes);
    } catch { complete = false; }
    if (!await revokeProjectOrigin(env, id, userId, initial.hostname)) complete = false;
  }
  const row = await env.DB.prepare('SELECT * FROM project_domains WHERE id = ? AND project_id = ?').bind(initial.id, id).first<ProjectDomainRow>();
  if (!row) return;
  // All network calls are bounded; a lost verifier can be reconciled after its lease expires.
  if (row.operation_revision && (row.operation_started_at ?? Date.now()) > Date.now() - 120_000) throw new HostingError('domain_reconciliation_required');
  let providerId = row.provider_id;
  if (!providerId && ownedClaim && (row.provider === 'cloudflare' || env.PROJECT_DOMAIN_PROVIDER === 'cloudflare')) {
    try {
      const existing = await cloudflareRequest(env, 'GET', `?hostname=${encodeURIComponent(row.hostname)}`) as { id: string; hostname: string }[];
      if (!Array.isArray(existing) || existing.length > 1 || existing.some(value => value.hostname !== row.hostname || !/^[a-z0-9-]{1,128}$/i.test(value.id))) throw new Error('domain_provider_unavailable');
      providerId = existing[0]?.id ?? null;
    } catch { complete = false; }
  }
  if (providerId && env.PREVIEW_ROUTES && !ownedClaim) {
    // A previously verified provider resource may outlive a DNS-proof loss. Never delete
    // a provider hostname that another verified project has since claimed.
    await checkedRun(env.PREVIEW_ROUTES.prepare("INSERT INTO project_hosts (hostname, project_id, status, verification_token) VALUES (?, ?, 'disabled', ?) ON CONFLICT(hostname) DO NOTHING").bind(row.hostname, id, row.challenge));
    const claim = await env.PREVIEW_ROUTES.prepare('SELECT project_id, verification_token FROM project_hosts WHERE hostname = ?').bind(row.hostname).first<{ project_id: string; verification_token: string }>();
    ownedClaim = claim?.project_id === id && claim.verification_token === row.challenge;
  }
  if (providerId && ownedClaim) {
    try { await cloudflareRequest(env, 'DELETE', `/${encodeURIComponent(providerId)}`); } catch { complete = false; }
  }
  if (!complete) throw new HostingError('domain_reconciliation_required');
  if (env.PREVIEW_ROUTES) await checkedRun(env.PREVIEW_ROUTES.prepare('DELETE FROM project_hosts WHERE hostname = ? AND project_id = ? AND verification_token = ?').bind(row.hostname, id, row.challenge));
  await checkedRun(env.DB.prepare('DELETE FROM project_domains WHERE id = ? AND project_id = ? AND removing = 1').bind(row.id, id));
}
async function verifyDomain(env: Env, id: string, userId: string, row: ProjectDomainRow) {
  if (!customDomainsConfigured(env) || row.provider && row.provider !== env.PROJECT_DOMAIN_PROVIDER) throw new HostingError('custom_domains_unavailable');
  const operation = crypto.randomUUID();
  const acquired = await checkedRun(env.DB.prepare(`UPDATE project_domains SET operation_revision = ?, operation_started_at = ?
    WHERE id = ? AND project_id = ? AND removing = 0 AND (operation_revision IS NULL OR operation_started_at <= ?)`)
    .bind(operation, Date.now(), row.id, id, Date.now() - 120_000));
  if (!acquired.meta.changes) throw new HostingError('domain_reconciliation_required');
  const db = env.PREVIEW_ROUTES!;
  const current = async () => Boolean(await env.DB.prepare('SELECT id FROM project_domains WHERE id = ? AND project_id = ? AND operation_revision = ? AND removing = 0').bind(row.id, id, operation).first());
  const dropClaim = () => checkedRun(db.prepare('DELETE FROM project_hosts WHERE hostname = ? AND project_id = ? AND verification_token = ?').bind(row.hostname, id, row.challenge));
  try {
    const proof = await domainDnsProof(row, env);
    if (!await current()) throw new HostingError('domain_reconciliation_required');
    if (!proof.ownership || !proof.routing || env.PROJECT_DOMAIN_PROVIDER === 'ingress' && !proof.ingressSafe) {
      await dropClaim();
      await checkedRun(env.DB.prepare("UPDATE project_domains SET status = 'pending_dns', dns_status = 'pending', tls_status = 'pending', error = ? WHERE id = ? AND project_id = ? AND operation_revision = ? AND removing = 0").bind(!proof.ownership ? 'ownership_txt_missing' : 'routing_dns_missing', row.id, id, operation));
      if (!await revokeProjectOrigin(env, id, userId, row.hostname)) throw new HostingError('domain_reconciliation_required');
      return;
    }
    await checkedRun(db.prepare(`INSERT INTO project_hosts (hostname, project_id, status, verification_token) VALUES (?, ?, 'pending_tls', ?)
      ON CONFLICT(hostname) DO NOTHING`).bind(row.hostname, id, row.challenge));
    const claim = await db.prepare('SELECT project_id, verification_token FROM project_hosts WHERE hostname = ?').bind(row.hostname).first<{ project_id: string; verification_token: string }>();
    if (!claim || claim.project_id !== id || claim.verification_token !== row.challenge) throw new HostingError('domain_in_use', 409);
    if (!await current()) {
      // Removal may have raced the insertion; keep this owned claim disabled for cleanup.
      await checkedRun(db.prepare("UPDATE project_hosts SET status = 'disabled' WHERE hostname = ? AND project_id = ? AND verification_token = ?").bind(row.hostname, id, row.challenge));
      throw new HostingError('domain_reconciliation_required');
    }
    await checkedRun(db.prepare("UPDATE project_hosts SET status = 'pending_tls' WHERE hostname = ? AND project_id = ? AND verification_token = ? AND status != 'disabled'").bind(row.hostname, id, row.challenge));
    let active = false, providerId = row.provider_id;
    if (env.PROJECT_DOMAIN_PROVIDER === 'cloudflare') {
      const provider = await provisionCloudflareHostname(env, row);
      providerId = provider.id;
      // Persist provider identity even if removal started while the RPC was in flight.
      await checkedRun(env.DB.prepare('UPDATE project_domains SET provider_id = ? WHERE id = ? AND project_id = ? AND operation_revision = ?').bind(providerId, row.id, id, operation));
      active = provider.status === 'active' && provider.ssl?.status === 'active';
    } else if (localProjectDomains(env)) {
      // Preserve both readiness steps in the UI without issuing a real certificate.
      active = row.dns_status === 'verified';
    } else active = await ingressTlsReady(row);
    if (!await current()) throw new HostingError('domain_reconciliation_required');
    await checkedRun(env.DB.prepare('UPDATE project_domains SET status = ?, dns_status = ?, tls_status = ?, provider_id = ?, error = NULL WHERE id = ? AND project_id = ? AND operation_revision = ? AND removing = 0').bind(active ? 'active' : 'pending_tls', 'verified', active ? 'active' : 'pending', providerId, row.id, id, operation));
    await checkedRun(db.prepare("UPDATE project_hosts SET status = ? WHERE hostname = ? AND project_id = ? AND verification_token = ? AND status != 'disabled'").bind(active ? 'active' : 'pending_tls', row.hostname, id, row.challenge));
  } catch (error) {
    if (!(error instanceof HostingError)) {
      await checkedRun(env.DB.prepare("UPDATE project_domains SET status = 'error', tls_status = 'error', error = 'domain_verification_unavailable' WHERE id = ? AND project_id = ? AND operation_revision = ? AND removing = 0").bind(row.id, id, operation));
    }
    throw error;
  } finally {
    await checkedRun(env.DB.prepare('UPDATE project_domains SET operation_revision = NULL, operation_started_at = NULL WHERE id = ? AND project_id = ? AND operation_revision = ?').bind(row.id, id, operation));
  }
}
async function handle(request: Request, env: Env, domains: boolean): Promise<Response> {
  const cors = authCorsHeaders(request);
  if (cors === null) return authJson({ error: 'origin_not_allowed' }, 403, {});
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const url = new URL(request.url), verifying = url.pathname === '/projects/domains/verify';
  const methods = verifying ? ['POST'] : domains ? ['GET', 'POST', 'DELETE'] : ['GET', 'PUT', 'DELETE'];
  if (!methods.includes(request.method)) return authJson({ error: 'method_not_allowed' }, 405, { ...cors, allow: [...methods, 'OPTIONS'].join(', ') });
  if (request.method !== 'GET' && !request.headers.get('Origin')) return authJson({ error: 'origin_required' }, 403, cors);
  const id = url.searchParams.get('id'), domainId = url.searchParams.get('domainId');
  const hasDomainId = domains && (verifying || request.method === 'DELETE');
  if (!validProjectId(id) || url.searchParams.size !== (hasDomainId ? 2 : 1) || hasDomainId && !validProjectId(domainId)
    || [...url.searchParams.keys()].some(key => !['id', ...(hasDomainId ? ['domainId'] : [])].includes(key) || url.searchParams.getAll(key).length !== 1)) return authJson({ error: 'invalid_request' }, 400, cors);
  try {
    let responseDomainId: string | undefined;
    const user = await currentUser(env, request);
    if (!user) return authJson({ error: 'not_authenticated' }, 401, cors);
    if (!await env.DB.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').bind(id, user.id).first()) return authJson({ error: 'not_found' }, 404, cors);
    if (!domains) {
      if (request.method === 'PUT') {
        const value = await body(request) as { target?: unknown };
        if (!value || Object.keys(value).length !== 1 || !validProjectTarget(value.target)) throw new HostingError('invalid_request', 400);
        await publish(env, id, user.id, value.target);
      } else if (request.method === 'DELETE') await unpublish(env, id, user.id);
      return authJson(await endpointPayload(env, id, user.id), 200, cors);
    }
    if (hasDomainId) {
      const row = await env.DB.prepare('SELECT * FROM project_domains WHERE id = ? AND project_id = ?').bind(domainId, id).first<ProjectDomainRow>();
      if (!row) throw new HostingError('not_found', 404);
      if (verifying) await verifyDomain(env, id, user.id, row); else await removeDomain(env, id, user.id, row);
    } else if (request.method === 'POST') {
      if (!customDomainsConfigured(env)) throw new HostingError('custom_domains_unavailable');
      const value = await body(request) as { hostname?: unknown };
      const hostname = value && Object.keys(value).length === 1 ? normalizeProjectHostname(value.hostname, env) : null;
      if (!hostname) throw new HostingError('invalid_hostname', 400);
      const existing = await env.DB.prepare('SELECT id FROM project_domains WHERE project_id = ? AND hostname = ?').bind(id, hostname).first<{ id: string }>();
      responseDomainId = existing?.id;
      if (!existing) {
        const now = new Date().toISOString();
        responseDomainId = crypto.randomUUID();
        const inserted = await checkedRun(env.DB.prepare(`INSERT OR IGNORE INTO project_domains (id, project_id, hostname, challenge, created_at, provider)
          SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM project_domains WHERE project_id = ?) < 20
          AND (SELECT count(*) FROM project_domains d JOIN projects p ON p.id = d.project_id WHERE p.user_id = ?) < 100`)
          // Local aliases have no external provider resource to persist or clean up.
          .bind(responseDomainId, id, hostname, `mainbrella-verification=${crypto.randomUUID()}`, now, localProjectDomains(env) ? null : env.PROJECT_DOMAIN_PROVIDER, id, user.id));
        if (!inserted.meta.changes) throw new HostingError('domain_limit', 429);
      }
    }
    const domainsList = await domainsFor(env, id);
    const domain = verifying ? domainsList.find(value => value.id === domainId) : request.method === 'POST' ? domainsList.find(value => value.id === responseDomainId) : undefined;
    return authJson({ ...(domain ? { domain } : {}), ...(request.method === 'DELETE' ? { deleted: true } : {}), domains: domainsList, hosting: projectHostingCapabilities(env) }, request.method === 'POST' && !verifying ? 201 : 200, cors);
  } catch (error) {
    if (error instanceof HostingError) return authJson({ error: error.message }, error.status, cors);
    const failure = containerError(error, domains ? 'project_domains_unavailable' : 'project_hosting_unavailable');
    return authJson({ error: failure.error }, failure.status, cors);
  }
}
export const handleProjectEndpointRequest = (request: Request, env: Env) => handle(request, env, false);
export const handleProjectDomainsRequest = (request: Request, env: Env) => handle(request, env, true);
