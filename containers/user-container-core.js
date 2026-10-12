import { PRODUCTION_INACTIVITY_MS, productionEntrypoint, validLifecycle, validStartupCommand } from './production-policy.js';
import { PLAN_LIMITS, NO_PLAN_LIMITS, requestEntitlement, validEntitlement, machineSize } from "./plan-policy.js";
import { IMAGE_CATALOG, availableCatalog } from './image-catalog.js';
import { WorkloadObservations } from './observations.js';
import { captureWorkspace } from './workspaces.js';
import { validWorkspaceId } from './workspace-contract.js';
import { normalizeNetworkPolicy, normalizeSecretBindings } from './security-contract.js';
import { EGRESS_CA_ENV } from './security-runtime.js';
import { normalizeRestoreLaunch, restoreEntrypoint, publicRestoreReadiness, observeRestoreReadiness } from './restore-launch.js';
export const BUILDER_LIMITS = PLAN_LIMITS.builder;

const METADATA_KEY = "builderMachine";
const USAGE_KEY = "builderMachineStarts";
const STARTUP_TIMEOUT_MS = 60_000;

const monthFor = (date) => date.toISOString().slice(0, 7);

/** Dependency-free state machine so its lifecycle can be exercised under Node. */
export class UserContainerController {
  constructor(ctx, now = () => Date.now(), timers = globalThis) {
    this.ctx = ctx;
    this.container = ctx.container;
    this.now = now;
    this.setTimer = timers.setTimeout.bind(timers);
    this.clearTimer = timers.clearTimeout.bind(timers);
    this.tail = Promise.resolve();
    this.restoreReadinessTasks = new Map();
    this.observations = new WorkloadObservations(this);
  }

  async serialized(fn) {
    const previous = this.tail;
    let release;
    this.tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if(path==='/workspaces/snapshot-v1') return captureWorkspace(this,request);
    return this.serialized(async () => {
      const url = new URL(request.url);
      if (url.pathname === '/features' && request.method === 'GET') return this.respond({ protocol: 1, internetControl: true, workspaceSnapshots:1, workspaceRestoreLaunch: 1, production: 1, ...(this.security?.available() ? { egressPolicies: 1 } : {}) });
      if(path==='/workspaces/restore-preflight-v1' && request.method==='POST') {
        let body;try{body=await request.json();}catch{return this.respond({error:'invalid_request'},400);}
        if(!body || body.expiresAt<=this.now())return this.respond({error:'workspace_expired'},410);
        if(!body.imageKey || typeof body.imageDigest!=='string' || this.container.images[body.imageKey]!==body.imageDigest)return this.respond({error:'workspace_image_incompatible'},409);
        return this.respond({compatible:true, workspaceRestoreLaunch: 1});
      }
      if (url.pathname.startsWith('/observations/')) return this.observations.fetch(request);
      const productionStart = url.pathname === '/container/production-v1';
      const networkStart = url.pathname === '/container/network-v1';
      const egressStart = url.pathname === '/container/egress-v1';
      const launchStart = url.pathname === '/container/workspace-launch-v1';
      const workspaceStart = url.pathname === '/container/workspace-v1' || launchStart;
      if (url.pathname !== '/container' && !networkStart && !workspaceStart && !productionStart && !egressStart) return this.respond({ error: "Not found" }, 404);
      if (egressStart && (request.method !== 'POST' || !this.security?.available())) return this.respond({ error: 'network_policy_unavailable' }, 503);
      if((workspaceStart || productionStart) && request.method!=='POST')return this.respond({error:'method_not_allowed'},405);
      if (networkStart && request.method !== 'POST') return this.respond({ error: 'method_not_allowed' }, 405);
      const rawReservation = request.headers.get('x-mainbrella-reservation');
      const reservationId = rawReservation === null ? null : Number(rawReservation);
      if (reservationId !== null && (!Number.isSafeInteger(reservationId) || reservationId < 1)) return this.respond({ error: 'invalid_reservation' }, 400);
      const fence = (await this.ctx.storage.get('machineReservation')) ?? { accepted: 0, canceled: 0 };
      const recovering = (productionStart || egressStart || workspaceStart) && request.headers.get('x-mainbrella-recover') === '1';
      if (recovering) {
        if (reservationId === null || reservationId < fence.accepted || reservationId <= fence.canceled) return this.respond({ error: 'container_start_canceled' }, 409);
        fence.accepted = reservationId;
        await this.ctx.storage.put('machineReservation', fence);
      }
      if (request.method === 'POST' && reservationId !== null && !recovering) {
        if (reservationId <= Math.max(fence.accepted, fence.canceled)) return this.respond({ error: 'container_start_canceled' }, 409);
        fence.accepted = reservationId;
        await this.ctx.storage.put('machineReservation', fence);
      }
      if (request.method === 'DELETE' && reservationId !== null) {
        fence.canceled = Math.max(fence.canceled, reservationId);
        await this.ctx.storage.put('machineReservation', fence);
        // A late cleanup for an old reservation cannot stop its replacement.
        if (reservationId < fence.accepted) return this.respond(await this.status());
      }

      let entitlement = requestEntitlement(request, this.now());
      const savedEntitlement = await this.ctx.storage.get("machineEntitlement");
      if ((savedEntitlement?.checkedAt ?? 0) > entitlement.checkedAt
        || (savedEntitlement?.checkedAt === entitlement.checkedAt && !savedEntitlement.active && entitlement.active)) entitlement = savedEntitlement;
      if (!validEntitlement(entitlement, this.now())) entitlement = { active: false, plan: null, validUntil: null, checkedAt: entitlement.checkedAt };
      if (JSON.stringify(savedEntitlement) !== JSON.stringify(entitlement)) await this.ctx.storage.put("machineEntitlement", entitlement);
      this.entitlement = entitlement;
      if (this.container.running) {
        const metadata = await this.ctx.storage.get(METADATA_KEY);
        if (!metadata) {
          await this.destroy("User container metadata missing");
          await this.ctx.storage.deleteAlarm();
        } else if (!entitlement.active) {
          await this.destroy("Paid subscription required");
          await this.ctx.storage.deleteAlarm();
        } else {
          // Ad hoc deadlines only shorten. Production compute deadlines renew
          // only from the account's durable, cap-protected reservation.
          const limits = PLAN_LIMITS[entitlement.plan];
          const production = metadata.lifecycle === 'production' && entitlement.plan === 'usage';
          const computeUntil = request.headers.has('x-mainbrella-compute-until') ? Number(request.headers.get('x-mainbrella-compute-until')) : metadata.expiresAt;
          metadata.expiresAt = Math.min(production ? Infinity : metadata.expiresAt, production ? Infinity : metadata.createdAt + limits.maxSessionMs, entitlement.validUntil, computeUntil);
          const lastActivityAt = metadata.lastActivityAt ?? Math.max(metadata.createdAt,
            (metadata.idleExpiresAt ?? metadata.createdAt) - (metadata.idleTimeoutMs ?? BUILDER_LIMITS.idleTimeoutMs));
          metadata.idleTimeoutMs = metadata.lifecycle === 'production' ? PRODUCTION_INACTIVITY_MS : limits.idleTimeoutMs;
          metadata.idleExpiresAt = metadata.lifecycle === 'production' ? metadata.expiresAt : Math.min(metadata.idleExpiresAt ?? lastActivityAt + limits.idleTimeoutMs,
            lastActivityAt + limits.idleTimeoutMs, metadata.expiresAt);
          const before = await this.ctx.storage.get(METADATA_KEY);
          if (JSON.stringify(before) !== JSON.stringify(metadata)) {
            await this.ctx.storage.put(METADATA_KEY, metadata);
            await this.ctx.storage.setAlarm(this.deadline(metadata));
            await this.container.setInactivityTimeout(metadata.idleTimeoutMs);
          }
        }
        if (metadata && this.container.running && this.now() >= this.deadline(metadata)) {
          await this.destroy("User container session expired");
        }
      }

      if (request.method === "GET") return this.respond(await this.status());
      if (request.method === "DELETE") {
        if (this.container.running) await this.destroy();
        await this.ctx.storage.deleteAlarm();
        return this.respond(await this.status());
      }
      if (request.method === "POST") {
        if (!entitlement.active) return this.respond({ error: "subscription_required" }, 402);
        try {
          const selection = request.body ? await request.json() : {};
          if(workspaceStart && (!validWorkspaceId(selection?.workspaceId) || !selection?.containerSnapshot?.id))return this.respond({error:'invalid_request'},400);
          if(launchStart && !normalizeRestoreLaunch(selection?.restoreLaunch))return this.respond({error:'invalid_launch_recipe'},400);
          if(!launchStart && selection?.restoreLaunch)return this.respond({error:'workspace_launch_unavailable'},503);
          if(!workspaceStart && !egressStart && selection?.containerSnapshot)return this.respond({error:'invalid_request'},400);
          if (egressStart && (!normalizeNetworkPolicy(selection?.networkPolicy) || selection?.containerSnapshot && (!validWorkspaceId(selection.workspaceId) || !selection.containerSnapshot.id))) return this.respond({ error: 'invalid_network_policy' }, 400);
          if (!egressStart && !launchStart && (selection?.networkPolicy !== undefined || selection?.secretBindings?.length)) return this.respond({ error: 'network_policy_unavailable' }, 503);
          if (networkStart && selection?.internet !== false) return this.respond({ error: 'invalid_internet_policy' }, 400);
          if (productionStart && selection?.lifecycle !== 'production') return this.respond({ error: 'invalid_lifecycle' }, 400);
          const result = await this.start(selection, recovering);
          return result instanceof Response ? result : this.respond(result);
        } catch (error) {
          if(workspaceStart){console.error('workspace_restore_failed');return this.respond({error:'workspace_restore_failed'},409);}
          console.error("User container start failed", error);
          return this.respond({ error: error.message || "Machine start failed" }, 500);
        }
      }
      return this.respond({ error: "Method not allowed" }, 405);
    });
  }

  respond(body, status = 200) {
    return Response.json(body, {
      status,
      headers: { "Cache-Control": "no-store" },
    });
  }

  async status() {
    const date = new Date(this.now());
    const month = monthFor(date);
    const usage = (await this.ctx.storage.get(USAGE_KEY)) ?? {};
    const metadata = await this.ctx.storage.get(METADATA_KEY);
    if (metadata?.readiness?.status === 'starting' && this.container.running) this.ensureRestoreReadiness(metadata);
    if (metadata && !this.container.running && metadata.computeStoppedAt === undefined) {
      this.onStopped?.();
      await this.recordStopped(metadata, 'runtime_stopped');
    }
    const containers = this.container.running && metadata
      ? [{
          id: "small",
          name: "Small container",
          size: metadata.size ?? 'lite',
          instance: machineSize(metadata.size ?? 'lite').instance,
          computeUnits: machineSize(metadata.size ?? 'lite').computeUnits,
          status: "running",
          internet: metadata.internet ?? true,
          ...(metadata.networkPolicy ? { networkPolicy: metadata.networkPolicy, secretBindings: metadata.secretBindings ?? [] } : {}),
          lifecycle: metadata.lifecycle ?? 'ad_hoc',
          ...(metadata.imageName ? { imageName: metadata.imageName } : {}),
          ...(metadata.imageId ? { imageId: metadata.imageId } : {}),
          ...(metadata.catalogId ? { catalogId: metadata.catalogId } : {}),
          ...(metadata.imageDigest ? { imageDigest: metadata.imageDigest } : {}),
          ...(metadata.workspaceId ? { workspaceId: metadata.workspaceId } : {}),
          ...(metadata.readiness ? { readiness: publicRestoreReadiness(metadata.readiness) } : {}),
          // Private account-to-runtime metadata; stripped from public responses.
          ...(metadata.restoreLaunch ? { _restoreLaunch: metadata.restoreLaunch } : {}),
          createdAt: new Date(metadata.createdAt).toISOString(),
          expiresAt: new Date(metadata.expiresAt).toISOString(),
        }]
      : [];
    return {
      containers,
      lastRun: metadata ? { lifecycle: metadata.lifecycle ?? 'ad_hoc', reservationId: metadata.reservationId, stoppedAt: metadata.computeStoppedAt } : null,
      imageCatalog: availableCatalog(this.container.images),
      plan: this.entitlement?.plan ?? null,
      active: this.entitlement?.active ?? false,
      limits: this.entitlement?.active ? PLAN_LIMITS[this.entitlement.plan] : NO_PLAN_LIMITS,
      usage: { month, starts: usage[month] ?? 0 },
    };
  }

  deadline(metadata) {
    // Older metadata without idleExpiresAt still gets a fixed idle deadline
    // derived from creation time, never from the current poll or restart time.
    const idleExpiresAt = metadata.idleExpiresAt
      ?? metadata.createdAt + (metadata.idleTimeoutMs ?? BUILDER_LIMITS.idleTimeoutMs);
    return metadata.lifecycle === 'production' ? metadata.expiresAt : Math.min(idleExpiresAt, metadata.expiresAt);
  }

  ensureRestoreReadiness(metadata) {
    if (metadata.readiness?.status !== 'starting' || !metadata.readiness.deadlineAt || this.restoreReadinessTasks.has(metadata.telemetryId)) return;
    const task = observeRestoreReadiness(this, metadata).catch(() => { console.error('restore_readiness_observation_failed'); })
      .finally(() => this.restoreReadinessTasks.delete(metadata.telemetryId));
    this.restoreReadinessTasks.set(metadata.telemetryId, task);
    this.ctx.waitUntil?.(task);
  }

  async getTerminalMetadata(createdAt, expiresAt) {
    return this.serialized(() => this.terminalMetadata(createdAt, expiresAt));
  }

  // Internal caller must already hold the controller lifecycle lock. Keeping
  // this check separate avoids reversing lifecycle/webhook configuration locks.
  async terminalMetadata(createdAt, expiresAt) {
    if (!this.container.running || !await this.hasPaidAccess()) return null;
    const metadata = await this.ctx.storage.get(METADATA_KEY);
    if (!metadata || metadata.operationCleanupPending || this.now() >= this.deadline(metadata) || !await this.hasPaidAccess()) return null;
    if (new Date(metadata.createdAt).toISOString() !== createdAt) return null;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now()
      || expiresAt > metadata.expiresAt) return null;
    return metadata;
  }

  async startTerminalProcess(createdAt, expiresAt, argv, options, fence) {
    return this.serialized(async () => {
      if (!this.container.running) throw new Error("Machine unavailable");
      const metadata = await this.ctx.storage.get(METADATA_KEY);
      if (!metadata || metadata.operationCleanupPending || this.now() >= this.deadline(metadata)
        || !await this.hasPaidAccess()
        || new Date(metadata.createdAt).toISOString() !== createdAt
        || expiresAt <= this.now() || expiresAt > metadata.expiresAt
        || fence && metadata.telemetryId !== fence.incarnation) {
        throw new Error("Machine unavailable");
      }
      return this.container.exec(argv, metadata.networkPolicy ? { ...options, env: { ...EGRESS_CA_ENV, ...options?.env } } : options);
    });
  }

  async touchTerminalActivity(createdAt) {
    return this.serialized(() => this.touchTerminalActivityLocked(createdAt));
  }

  // Internal caller must already hold the lifecycle lock, as with terminalMetadata.
  async touchTerminalActivityLocked(createdAt) {
      if (!this.container.running) return false;
      const metadata = await this.ctx.storage.get(METADATA_KEY);
      if (!metadata || metadata.operationCleanupPending || new Date(metadata.createdAt).toISOString() !== createdAt
        || this.now() >= this.deadline(metadata) || !await this.hasPaidAccess()) return false;
      metadata.lastActivityAt = this.now();
      metadata.idleExpiresAt = Math.min(
        this.now() + (metadata.idleTimeoutMs ?? BUILDER_LIMITS.idleTimeoutMs),
        metadata.expiresAt,
      );
      await this.ctx.storage.put(METADATA_KEY, metadata);
      await this.ctx.storage.setAlarm(this.deadline(metadata));
      await this.container.setInactivityTimeout(metadata.idleTimeoutMs ?? BUILDER_LIMITS.idleTimeoutMs);
      return true;
  }

  async signalOperationGroup(createdAt, groupId, signal, incarnation) {
    if (!Number.isSafeInteger(groupId) || groupId <= 1 || ![2, 9, 15].includes(signal)) return false;
    return this.serialized(async () => {
      const metadata = await this.ctx.storage.get(METADATA_KEY);
      if (!metadata || !this.container.running) return false;
      if (new Date(metadata.createdAt).toISOString() !== createdAt || metadata.telemetryId !== incarnation) return false;
      // Cleanup cannot provision, renew a lease or act on a replacement. It
      // remains possible during billing outages and after a deadline expires.
      const process = await this.container.exec(['/bin/bash', '-c', `
group="$1"
if kill -s "$2" -- "-$group" 2>/dev/null; then exit 0; fi
# A group may already have exited. Confirm absence in the guest PID namespace;
# permission errors, unavailable /proc, and unreadable live records fail closed.
[ -d /proc/self ] || exit 1
for file in /proc/[0-9]*/stat; do
  if IFS= read -r value < "$file" 2>/dev/null; then
    value="\${value##*) }"
    read -r state parent current rest <<< "$value"
    [[ "$current" =~ ^[0-9]+$ ]] || exit 1
    [ "$current" != "$group" ] || exit 1
  elif [ -e "$file" ]; then exit 1; fi
done
exit 0`, 'mainbrella-group-signal', String(groupId), String(signal)],
        { stdout: 'ignore', stderr: 'ignore', signal: AbortSignal.timeout(10_000) });
      return await process.exitCode === 0;
    });
  }

  async stopOperationGeneration(createdAt, incarnation) {
    return this.serialized(async () => {
      if (!this.container.running) return true;
      const metadata = await this.ctx.storage.get(METADATA_KEY);
      if (!metadata) return false;
      // A replacement is admitted only after the preceding incarnation stops.
      if (new Date(metadata.createdAt).toISOString() !== createdAt || metadata.telemetryId !== incarnation) return true;
      metadata.operationCleanupPending = true;
      await this.ctx.storage.put(METADATA_KEY, metadata);
      await this.ctx.storage.setAlarm(Math.min(this.deadline(metadata), this.now() + 1000));
      await this.destroy('Operation process-group cleanup could not be confirmed');
      return !this.container.running;
    });
  }

  async recoverOperationCleanup() {
    const metadata = await this.ctx.storage.get(METADATA_KEY);
    if (!metadata?.operationCleanupPending) return;
    if (!await this.stopOperationGeneration(new Date(metadata.createdAt).toISOString(), metadata.telemetryId)) throw new Error('operation_cleanup_unconfirmed');
    const current = await this.ctx.storage.get(METADATA_KEY);
    if (current?.createdAt === metadata.createdAt && current.telemetryId === metadata.telemetryId) {
      delete current.operationCleanupPending;
      await this.ctx.storage.put(METADATA_KEY, current);
    }
  }

  async hasPaidAccess() {
    const entitlement = this.entitlement ?? await this.ctx.storage.get('machineEntitlement');
    return validEntitlement(entitlement, this.now());
  }

  async start(selection = {}, recovering = false) {
    if (!validEntitlement(this.entitlement, this.now())) return this.respond({ error: "subscription_required" }, 402);
    if (this.container.running) {
      return this.respond({ error: "container_limit_exceeded" }, 409);
    }

    if (selection.lifecycle !== undefined && !validLifecycle(selection.lifecycle)) return this.respond({ error: 'invalid_lifecycle' }, 400);
    if (selection.lifecycle === 'production' && this.entitlement.plan !== 'usage') return this.respond({ error: 'production_requires_usage' }, 402);
    if (selection.startupCommand !== undefined && (!validStartupCommand(selection.startupCommand) || selection.lifecycle !== 'production')) return this.respond({ error: 'invalid_startup_command' }, 400);
    const restoreLaunch = selection.restoreLaunch === undefined ? undefined : normalizeRestoreLaunch(selection.restoreLaunch);
    if (restoreLaunch === null || restoreLaunch && (!selection.workspaceId || selection.lifecycle === 'production')) return this.respond({ error: 'invalid_launch_recipe' }, 400);
    const size = machineSize(selection.size ?? 'lite');
    if (!size) return this.respond({ error: 'invalid_size' }, 400);
    if (selection.internet !== undefined && typeof selection.internet !== 'boolean') return this.respond({ error: 'invalid_internet_policy' }, 400);
    const networkPolicy = selection.networkPolicy === undefined ? undefined : normalizeNetworkPolicy(selection.networkPolicy);
    const secretBindings = normalizeSecretBindings(selection.secretBindings ?? []);
    if (networkPolicy === null || !secretBindings || secretBindings.length && !networkPolicy || networkPolicy && selection.internet === true) return this.respond({ error: 'invalid_network_policy' }, 400);
    if (networkPolicy && !this.security?.available()) return this.respond({ error: 'network_policy_unavailable' }, 503);
    if (selection.computeExpiresAt !== undefined && (!Number.isSafeInteger(selection.computeExpiresAt) || selection.computeExpiresAt <= this.now())) return this.respond({ error: 'compute_allowance_exhausted' }, 429);
    const imageKey = selection.imageKey || "terminal";
    const recoveryMetadata = recovering ? await this.ctx.storage.get(METADATA_KEY) : null;
    let image = recoveryMetadata?.imageDigest ?? (Object.hasOwn(this.container.images, imageKey) ? this.container.images[imageKey] : undefined);
    if (!image) return this.respond({ error: "image_not_available" }, 409);
    if(selection.workspaceId && (!Number.isSafeInteger(selection.workspaceExpiresAt) || selection.workspaceExpiresAt<=this.now()))return this.respond({error:'workspace_expired'},410);
    if(selection.workspaceId && selection.imageDigest!==image)return this.respond({error:'workspace_image_incompatible'},409);

    const usage = (await this.ctx.storage.get(USAGE_KEY)) ?? {};
    const previousMetadata = await this.ctx.storage.get(METADATA_KEY);
    const now = this.now();
    if (!validEntitlement(this.entitlement, now)) return this.respond({ error: "subscription_required" }, 402);
    const month = monthFor(new Date(now));
    const limits = PLAN_LIMITS[this.entitlement.plan];

    // Reserve before asking the platform to start. A failed start remains charged
    // for quota purposes, which avoids races and accidental extra starts.
    usage[month] = (usage[month] ?? 0) + 1;
    await this.ctx.storage.put(USAGE_KEY, usage);
    const catalogImage = IMAGE_CATALOG.find(entry => entry.key === imageKey);
    // A slot generation remains unique even across a same-millisecond recreate
    // or a backward wall-clock correction, so old access cannot target a new VM.
    if (recovering && (!previousMetadata || previousMetadata.lifecycle !== 'production')) return this.respond({ error: 'container_not_running' }, 409);
    if (recovering) image = previousMetadata.imageDigest;
    const createdAt = recovering ? previousMetadata.createdAt : Math.max(now, (previousMetadata?.createdAt ?? -1) + 1);
    const metadata = {
      createdAt,
      telemetryId: crypto.randomUUID(),
      size: size.id,
      internet: networkPolicy ? false : selection.internet ?? true,
      ...(networkPolicy ? { networkPolicy, secretBindings } : {}),
      lifecycle: selection.lifecycle ?? 'ad_hoc',
      ...(selection.lifecycle === 'production' ? { startupCommand: selection.startupCommand ?? '' } : {}),
      reservationId: (await this.ctx.storage.get('machineReservation'))?.accepted,
      imageDigest: image,
      imageKey,
      ...(selection.workspaceId?{workspaceId:selection.workspaceId}:{}),
      ...(restoreLaunch ? { restoreLaunch } : {}),
      ...(catalogImage ? { catalogId: catalogImage.id, imageName: catalogImage.name } : {}),
      ...(selection.imageId ? { imageId: selection.imageId, imageName: selection.imageName } : {}),
      lastActivityAt: now,
      expiresAt: Math.min(selection.lifecycle === 'production' ? Infinity : now + limits.maxSessionMs, this.entitlement.validUntil, selection.computeExpiresAt ?? Infinity),
      idleExpiresAt: Math.min(now + limits.idleTimeoutMs, this.entitlement.validUntil),
      idleTimeoutMs: selection.lifecycle === 'production' ? PRODUCTION_INACTIVITY_MS : limits.idleTimeoutMs,
    };
    if (restoreLaunch) metadata.readiness = { status: 'starting', port: restoreLaunch.readiness.port, path: restoreLaunch.readiness.path,
      logPath: `/tmp/mainbrella-restore-${crypto.randomUUID()}.log` };
    await this.ctx.storage.put(METADATA_KEY, metadata);
    await this.observations.append(metadata, 'starting');
    await this.ctx.storage.setAlarm(this.deadline(metadata));

    try {
      if (!validEntitlement(this.entitlement, this.now())) {
        await this.ctx.storage.deleteAlarm();
        return this.respond({ error: 'subscription_required' }, 402);
      }
      await this.security?.install(metadata);
      this.container.start({
        ...(selection.workspaceId ? {containerSnapshot:{id:selection.containerSnapshot.id}} : {image}),
        instance: size.instance,
        entrypoint: restoreLaunch ? restoreEntrypoint(restoreLaunch, metadata.readiness.logPath)
          : metadata.lifecycle === 'production' ? productionEntrypoint(metadata.startupCommand) : ['sleep', 'infinity'],
        enableInternet: metadata.internet,
        ...(metadata.networkPolicy ? { env: EGRESS_CA_ENV } : {}),
        labels: { mb_generation: metadata.telemetryId },
      });
      await this.onStarted?.(metadata.createdAt);
      await this.container.setInactivityTimeout(metadata.idleTimeoutMs ?? BUILDER_LIMITS.idleTimeoutMs);
      let readinessTimer;
      let output;
      try {
        const readiness = (async () => {
          // Cloudflare's 64-character Linux hostname exceeds the DNS label
          // limit and breaks Python's socket.getfqdn()/http.server. Rename it
          // before admitting commands, including after snapshot restore. Local
          // Docker and unprivileged custom images may not allow this operation.
          const trust = metadata.networkPolicy ? 'if command -v update-ca-certificates >/dev/null 2>&1 && [ -r /etc/cloudflare/certs/cloudflare-containers-ca.crt ]; then cp /etc/cloudflare/certs/cloudflare-containers-ca.crt /usr/local/share/ca-certificates/mainbrella-egress.crt && update-ca-certificates >/dev/null 2>&1 || true; fi; ' : '';
          const process = await this.container.exec(["sh", "-lc", trust + "hostname mainbrella || true; uname -a"]);
          return process.output();
        })();
        const timeout = new Promise((_, reject) => {
          readinessTimer = this.setTimer(
            () => reject(new Error(`Machine readiness check timed out after ${STARTUP_TIMEOUT_MS} ms`)),
            STARTUP_TIMEOUT_MS,
          );
        });
        output = await Promise.race([readiness, timeout]);
      } finally {
        if (readinessTimer !== undefined) this.clearTimer(readinessTimer);
      }
      if (output.exitCode !== 0) {
        throw new Error(`Machine readiness check failed (exit code ${output.exitCode})`);
      }
      await this.onReady?.();
      await this.observations.append(metadata, 'started');
      if (restoreLaunch) {
        metadata.readiness.deadlineAt = Math.min(this.now() + restoreLaunch.readiness.timeoutMs, this.deadline(metadata));
        await this.ctx.storage.put(METADATA_KEY, metadata);
        this.ensureRestoreReadiness(metadata);
      }
      return this.status();
    } catch (error) {
      await this.observations.append(metadata, 'failed', 'startup_failed');
      let cleanedUp = false;
      try {
        await this.destroy("User container failed readiness");
        cleanedUp = true;
      } catch (cleanupError) {
        console.error("User container cleanup failed", cleanupError);
      }
      if (cleanedUp) await this.ctx.storage.deleteAlarm();
      throw error;
    }
  }

  async destroy(reason) {
    // Revoke terminal access before asking the platform to destroy the VM;
    // a failed platform cleanup must not leave authenticated shells attached.
    this.onStopped?.();
    this.revokedEgressGeneration = (await this.ctx.storage.get(METADATA_KEY))?.telemetryId;
    if (this.revokedEgressGeneration) await this.ctx.storage.put('revokedEgressGeneration', this.revokedEgressGeneration);
    await this.container.destroy(reason);
    const metadata = await this.ctx.storage.get(METADATA_KEY);
    if (metadata && metadata.computeStoppedAt === undefined) await this.recordStopped(metadata,
      reason?.includes('readiness') ? 'startup_failed' : reason?.includes('restart') ? 'runtime_restart'
        : reason?.includes('subscription') ? 'subscription_required' : reason?.includes('expired') ? 'session_expired'
          : reason?.includes('metadata') ? 'metadata_missing' : 'requested');
  }

  async recordStopped(metadata, reason) {
    metadata.computeStoppedAt ??= this.now();
    await this.ctx.storage.put(METADATA_KEY, metadata);
    await this.observations.append(metadata, 'stopped', reason);
  }

  async observePlatformStop(createdAt, failed = false) {
    return this.serialized(async () => {
      const metadata = await this.ctx.storage.get(METADATA_KEY);
      if (!metadata || metadata.createdAt !== createdAt || this.container.running || metadata.computeStoppedAt !== undefined) return;
      this.onStopped?.();
      if (failed) await this.observations.append(metadata, 'failed', 'runtime_failed');
      await this.recordStopped(metadata, failed ? 'runtime_failed' : 'runtime_stopped');
    });
  }

  async alarm() {
    return this.serialized(async () => {
      const metadata = await this.ctx.storage.get(METADATA_KEY);
      if (metadata?.operationCleanupPending && this.container.running) {
        await this.ctx.storage.setAlarm(Math.min(this.deadline(metadata), this.now() + 1000));
        await this.destroy('Operation process-group cleanup retry');
        return;
      }
      if (metadata && this.now() < this.deadline(metadata) && await this.hasPaidAccess()) {
        // Defensive handling for an early alarm: preserve the idle/hard deadline.
        await this.ctx.storage.setAlarm(this.deadline(metadata));
        return;
      }
      if (this.container.running) {
        await this.destroy(metadata
          ? "User container session expired"
          : "User container metadata missing");
      }
      // Keep metadata and usage for status/history and safe restart handling.
    });
  }
}
