import { requestEntitlement, validEntitlement, machineSize, entitlementHeaders } from './plan-policy.js';
import { validContainerId, validIdempotencyKey } from './container-account-core.js';
import { validGeneration, WORKSPACE_OPERATION_RETENTION_MS } from './workspace-contract.js';
import { readFileBytes } from './file-contract.js';
import { normalizeRestoreLaunch, MAX_WORKSPACE_REQUEST_BYTES } from './restore-launch.js';

// Stop is a durable capture followed by a fenced compute stop. The suspended
// identity is committed before contacting the runtime and survives lost replies.
export class AccountLifecycle {
  constructor(account) { this.account = account; }
  descriptors(state) {
    return Object.entries(state.suspended ?? {}).filter(([id]) => !state.slots.includes(id)).map(([id, record]) => {
      const size = machineSize(record.size);
      return { id, name: record.name, lifecycle: record.selection.lifecycle ?? 'ad_hoc', size: size.id,
        instance: size.instance, computeUnits: size.computeUnits, internet: record.internet,
        ...(record.networkPolicy ? { networkPolicy: record.networkPolicy } : {}),
        ...(record.secretBindings ? { secretBindings: record.secretBindings } : {}),
        status: 'stopped', createdAt: record.createdAt, expiresAt: record.createdAt,
        workspaceId: record.workspaceId, persistenceExpiresAt: record.persistenceExpiresAt,
        imageDigest: record.imageDigest, ...(record.imageId ? { imageId: record.imageId } : {}),
        ...(record.imageName ? { imageName: record.imageName } : {}),
        ...(record.launch ? { launch: record.launch } : {}),
        stopReason: record.persistenceExpiresAt <= this.account.now() ? 'workspace_expired' : 'requested' };
    });
  }
  async configureStartup(request) {
    const a = this.account, userId = request.headers.get('x-mainbrella-user');
    if (request.method !== 'PATCH') return a.respond({ error: 'method_not_allowed' }, 405);
    if (!userId || !/^[A-Za-z0-9_-]{1,128}$/.test(userId)) return a.respond({ error: 'not_authenticated' }, 401);
    let body;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFileBytes(request.body, MAX_WORKSPACE_REQUEST_BYTES, request.signal))); }
    catch { return a.respond({ error: 'invalid_request' }, 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['id', 'createdAt', 'launch'].includes(key)) ||
        !validContainerId(body.id) || !validGeneration(body.createdAt) || !Object.hasOwn(body, 'launch')) return a.respond({ error: 'invalid_request' }, 400);
    const launch = body.launch === null ? null : normalizeRestoreLaunch(body.launch);
    if (body.launch !== null && !launch) return a.respond({ error: 'invalid_launch_recipe' }, 400);
    try { return await a.serialized(async () => {
      const entitlement = requestEntitlement(request, a.now());
      const state = await a.initialize(userId, entitlement);
      const containers = await a.reconcile(state, entitlement, false);
      if (!validEntitlement(state.entitlement, a.now())) return a.respond({ error: 'subscription_required' }, 402);
      const source = containers.find(c => c.id === body.id && c.createdAt === body.createdAt && c.status === 'running');
      if (!source) return a.respond({ error: 'container_not_running' }, 409);
      if (source.lifecycle === 'production') return a.respond({ error: 'invalid_lifecycle' }, 400);
      const response = await a.machineFor(userId, body.id).fetch(new Request('https://internal/workspaces/startup-v1', {
        method: 'PATCH', headers: { ...entitlementHeaders(state.entitlement), 'Content-Type': 'application/json' }, body: JSON.stringify({ createdAt: body.createdAt, launch }),
      }));
      if (response.status === 404) return a.respond({ error: 'workspace_launch_unavailable' }, 503);
      const result = await response.json();
      return a.respond(response.ok ? { id: body.id, ...result } : result, response.status);
    }); } catch { return a.respond({ error: 'containers_unavailable' }, 503); }
  }
  async discard(state, id) {
    const suspended = state.suspended?.[id];
    if (!suspended) return;
    const index = await this.account.workspaces.prune();
    const workspace = index.records.find(record => record.id === suspended.workspaceId);
    if (workspace) {
      workspace.deleted = true; workspace.deletedAt ??= this.account.now();
      delete workspace.handle; workspace.reservedBytes = 0;
      await this.account.workspaces.persist(index);
    }
    delete state.suspended[id];
  }
  async stop(request) {
    const a = this.account, userId = request.headers.get('x-mainbrella-user'), key = request.headers.get('Idempotency-Key');
    if (request.method !== 'POST') return a.respond({ error: 'method_not_allowed' }, 405);
    if (!userId || !/^[A-Za-z0-9_-]{1,128}$/.test(userId)) return a.respond({ error: 'not_authenticated' }, 401);
    if (!validIdempotencyKey(key)) return a.respond({ error: 'invalid_idempotency_key' }, 400);
    let body;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFileBytes(request.body, 2048, request.signal))); }
    catch { return a.respond({ error: 'invalid_request' }, 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['id', 'createdAt'].includes(k)) || !validContainerId(body.id) || !validGeneration(body.createdAt)) return a.respond({ error: 'invalid_request' }, 400);
    const receiptKey = `creation:stop:${key}`, fingerprint = JSON.stringify([body.id, body.createdAt]);
    try { return await a.serialized(async () => {
      const state = await a.initialize(userId, requestEntitlement(request, a.now()));
      const receipt = await a.ctx.storage.get(receiptKey);
      if (receipt && receipt.expiresAt > a.now() && receipt.fingerprint !== fingerprint) return a.respond({ error: 'idempotency_key_conflict' }, 409);
      // A completed retry remains safe after resume, deletion or subscription loss.
      if (receipt?.completed && receipt.expiresAt > a.now()) return a.respond(a.status(state, await a.reconcile(state, requestEntitlement(request, a.now()), false)));
      if (!validEntitlement(requestEntitlement(request, a.now()), a.now())) return a.respond({ error: 'subscription_required' }, 402);
      let containers = await a.reconcile(state, requestEntitlement(request, a.now()), false);
      const suspended = state.suspended?.[body.id];
      if (suspended && suspended.createdAt === body.createdAt && !suspended.resuming) {
        const completed = { fingerprint, completed: true, expiresAt: a.now() + WORKSPACE_OPERATION_RETENTION_MS };
        state.nextCreationExpiry = Math.min(state.nextCreationExpiry ?? Infinity, completed.expiresAt);
        await a.ctx.storage.put({ containerAccount: state, [receiptKey]: completed });
        await a.saveState(state);
        return a.respond(a.status(state, containers));
      }
      let source = containers.find(c => c.id === body.id && c.createdAt === body.createdAt && c.status === 'running');
      const index = await a.workspaces.prune();
      const pendingCapture = index.records.find(record => record.operationKey === `stop:${key}` && record.operationExpiresAt > a.now());
      if (pendingCapture && (pendingCapture.source.id !== body.id || pendingCapture.source.createdAt !== body.createdAt)) return a.respond({ error: 'idempotency_key_conflict' }, 409);
      if (!source && pendingCapture?.sourceSelection && pendingCapture.sourceReservationId === state.reservations[body.id]
        && !containers.some(c => c.id === body.id && c.createdAt !== body.createdAt)) {
        const { size, internet, networkPolicy, secretBindings, imageDigest, imageId, imageName, sourceSelection } = pendingCapture;
        source = { ...body, ...sourceSelection, size, internet, networkPolicy, secretBindings, imageDigest, imageId, imageName };
      }
      if (!source) {
        // Recover a committed capture receipt even if its slot has since been
        // replaced; never suspend or stop that replacement. The saved workspace
        // remains available for an independent restore.
        if (pendingCapture) await a.workspaces.capture(state, undefined, `stop:${key}`, { ...body, name: pendingCapture.name, stop: false }, { index, record: pendingCapture });
        return a.respond({ error: 'container_not_running' }, 409);
      }
      const capture = await a.workspaces.capture(state, source, `stop:${key}`, { ...body, name: pendingCapture?.name ?? `Stopped ${source.name}`.slice(0, 80), stop: false }, { index, record: pendingCapture, inheritLaunch: true });
      if (capture instanceof Response) return capture;
      const selection = capture.record.sourceSelection ?? { lifecycle: source.lifecycle ?? 'ad_hoc', name: source.name };
      state.suspended ??= {};
      state.suspended[body.id] = { createdAt: source.createdAt, name: source.name, size: source.size, internet: source.internet,
        imageDigest: source.imageDigest, imageId: source.imageId, imageName: source.imageName,
        workspaceId: capture.record.id, persistenceExpiresAt: capture.record.expiresAt, selection, ...(capture.record.launch ? { launch: capture.record.launch } : {}) };
      delete state.production?.[body.id];
      const intent = { fingerprint, completed: false, expiresAt: a.now() + WORKSPACE_OPERATION_RETENTION_MS };
      state.nextCreationExpiry = Math.min(state.nextCreationExpiry ?? Infinity, intent.expiresAt);
      await a.ctx.storage.put({ containerAccount: state, [receiptKey]: intent });
      const stopped = await a.machine(state, body.id, 'DELETE', state.entitlement);
      a.settleLease(state, body.id, stopped.lastRun?.stoppedAt ?? a.now());
      delete state.pending[body.id];
      state.slots = state.slots.filter(id => id !== body.id);
      intent.completed = true;
      await a.ctx.storage.put({ containerAccount: state, [receiptKey]: intent });
      await a.saveState(state);
      return a.respond(a.status(state, containers.filter(c => c.id !== body.id)));
    }); } catch { return a.respond({ error: 'containers_unavailable' }, 503); }
  }
}
