import { machineName, validContainerId } from '../../containers/container-account-core.js';
import { validPreviewId } from '../../containers/preview-contract.js';
import { validPreviewGeneration, type PreviewRoute, type PreviewRoutingEnv } from './preview-routing';

type SourceEnv = { DB?: D1Database; ACQUISITION_ENABLED?: string };
type ContainerObservation = { id: string; createdAt: string; status: string };

// First observation wins. Reading a running generation again must not change its
// timestamp, create a second event, or prevent an otherwise healthy API response.
export async function observeRunningWorkspaces(env: SourceEnv, userId: string, containers: ContainerObservation[]): Promise<void> {
  if (env.ACQUISITION_ENABLED !== 'true' || !env.DB) return;
  try {
    const running = containers.filter(container => container.status === 'running'
      && validContainerId(container.id) && validPreviewGeneration(container.createdAt)
      && Date.parse(container.createdAt) > 0);
    if (!running.length) return;
    const recordedAt = Date.now();
    await env.DB.batch(running.map(container => env.DB!.prepare(`INSERT OR IGNORE INTO acquisition_events
      (event_key,event_type,user_id,lead_id,occurred_at,recorded_at,payload)
      VALUES (?,'workspace.started',?,(SELECT lead_id FROM acquisition_accounts WHERE user_id = ?),?,?,?)`)
      .bind(`workspace.started:${userId}:${container.id}:${container.createdAt}`, userId, userId,
        Date.parse(container.createdAt), recordedAt, JSON.stringify({ containerId: container.id, createdAt: container.createdAt }))));
  } catch { console.error('acquisition_workspace_observation_failed'); }
}

// The isolated gateway can reach only its existing owner-scoped registry, never
// the account database. Neither bearer tokens nor URLs cross this boundary.
export async function reportPreviewDocument(env: PreviewRoutingEnv, route: PreviewRoute): Promise<void> {
  if (env.ACQUISITION_ENABLED !== 'true' || !env.CONTAINER_ACCOUNT) return;
  const owner = /^user:([A-Za-z0-9_-]{1,128})(?::slot:([1-9]\d{0,2}))?$/.exec(route.container_name);
  const containerId = owner?.[2] ? `c${owner[2]}` : 'small';
  if (!owner || !validContainerId(containerId)) return;
  try {
    const accounts = env.CONTAINER_ACCOUNT as unknown as {
      idFromName(name: string): DurableObjectId;
      get(id: DurableObjectId): { fetch(request: Request): Promise<Response> };
    };
    const account = accounts.get(accounts.idFromName(`account:${owner[1]}`));
    await account.fetch(new Request('https://internal/acquisition/preview-observed', {
      method: 'POST', headers: { 'x-mainbrella-user': owner[1], 'content-type': 'application/json' },
      body: JSON.stringify({ previewId: route.preview_id, containerId, createdAt: route.created_at }),
      signal: AbortSignal.timeout(5000),
    }));
  } catch { /* Optional observation never interrupts a streaming preview response. */ }
}

// Only the private ContainerAccount binding dispatches this handler. It checks
// its Durable Object identity; this handler independently verifies the live route.
export async function acceptPreviewObservation(request: Request, env: SourceEnv & { PREVIEW_ROUTES?: D1Database }, owner: string): Promise<Response> {
  if (env.ACQUISITION_ENABLED !== 'true' || !env.DB || !env.PREVIEW_ROUTES) return new Response(null, { status: 404 });
  if (request.method !== 'POST' || request.headers.get('x-mainbrella-user') !== owner
    || !/^[A-Za-z0-9_-]{1,128}$/.test(owner)) return new Response(null, { status: 403 });
  try {
    const text = await request.text();
    if (text.length > 1024) return new Response(null, { status: 400 });
    let data;
    try { data = JSON.parse(text); } catch { return new Response(null, { status: 400 }); }
    if (!data || typeof data !== 'object' || Array.isArray(data)
      || Object.keys(data).sort().join(',') !== 'containerId,createdAt,previewId'
      || !validPreviewId(data.previewId) || !validContainerId(data.containerId)
      || !validPreviewGeneration(data.createdAt)) return new Response(null, { status: 400 });
    const route = await env.PREVIEW_ROUTES.prepare(`SELECT preview_id,container_name,created_at,expires_at
      FROM preview_routes WHERE preview_id=? AND container_name=? AND created_at=? AND expires_at>?`)
      .bind(data.previewId, machineName(owner, data.containerId), data.createdAt, Date.now()).first<PreviewRoute>();
    if (!route) return new Response(null, { status: 404 });
    await observePreviewDocument(env, route);
    return new Response(null, { status: 204 });
  } catch {
    console.error('acquisition_preview_observation_failed');
    return new Response(null, { status: 503 });
  }
}

async function observePreviewDocument(env: SourceEnv, route: PreviewRoute): Promise<void> {
  if (env.ACQUISITION_ENABLED !== 'true' || !env.DB) return;
  const owner = /^user:([A-Za-z0-9_-]{1,200})(?::slot:([1-9]\d{0,2}))?$/.exec(route.container_name);
  const containerId = owner?.[2] ? `c${owner[2]}` : 'small';
  if (!owner || !validContainerId(containerId) || !validPreviewId(route.preview_id)
    || !validPreviewGeneration(route.created_at)) return;
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO acquisition_events
      (event_key,event_type,user_id,lead_id,occurred_at,recorded_at,payload)
      VALUES (?,'preview.opened',?,(SELECT lead_id FROM acquisition_accounts WHERE user_id = ?),?,?,?)
      ON CONFLICT(event_key) DO NOTHING`)
    .bind(`preview.opened:${route.preview_id}`, owner[1], owner[1], now, now,
      JSON.stringify({ previewId: route.preview_id, containerId, createdAt: route.created_at })).run();
}
