import { PLAN_LIMITS, NO_PLAN_LIMITS, requestEntitlement, validEntitlement, machineSize } from "./plan-policy.js";
import { IMAGE_CATALOG, availableCatalog } from './image-catalog.js';
import { WorkloadObservations } from './observations.js';
import { captureWorkspace } from './workspaces.js';
import { validWorkspaceId } from './workspace-contract.js';
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
      if (url.pathname === '/features' && request.method === 'GET') return this.respond({ protocol: 1, internetControl: true, workspaceSnapshots:1 });
      if(path==='/workspaces/restore-preflight-v1' && request.method==='POST') {
        let body;try{body=await request.json();}catch{return this.respond({error:'invalid_request'},400);}
        if(!body || body.expiresAt<=this.now())return this.respond({error:'workspace_expired'},410);
        if(!body.imageKey || typeof body.imageDigest!=='string' || this.container.images[body.imageKey]!==body.imageDigest)return this.respond({error:'workspace_image_incompatible'},409);
        return this.respond({compatible:true});
      }
      if (url.pathname.startsWith('/observations/')) return this.observations.fetch(request);
      const networkStart = url.pathname === '/container/network-v1';
      const workspaceStart = url.pathname === '/container/workspace-v1';
      if (url.pathname !== '/container' && !networkStart && !workspaceStart) return this.respond({ error: "Not found" }, 404);
      if(workspaceStart && request.method!=='POST')return this.respond({error:'method_not_allowed'},405);
      if (networkStart && request.method !== 'POST') return this.respond({ error: 'method_not_allowed' }, 405);
      const rawReservation = request.headers.get('x-mainbrella-reservation');
      const reservationId = rawReservation === null ? null : Number(rawReservation);
      if (reservationId !== null && (!Number.isSafeInteger(reservationId) || reservationId < 1)) return this.respond({ error: 'invalid_reservation' }, 400);
      const fence = (await this.ctx.storage.get('machineReservation')) ?? { accepted: 0, canceled: 0 };
      if (request.method === 'POST' && reservationId !== null) {
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
          // Plan changes can shorten an existing lease, but never extend its
          // original hard deadline. Idle activity alone renews the idle deadline.
          const limits = PLAN_LIMITS[entitlement.plan];
          metadata.expiresAt = Math.min(metadata.expiresAt, metadata.createdAt + limits.maxSessionMs, entitlement.validUntil,
            request.headers.has('x-mainbrella-compute-until') ? Number(request.headers.get('x-mainbrella-compute-until')) : Infinity);
          const lastActivityAt = metadata.lastActivityAt ?? Math.max(metadata.createdAt,
            (metadata.idleExpiresAt ?? metadata.createdAt) - (metadata.idleTimeoutMs ?? BUILDER_LIMITS.idleTimeoutMs));
          metadata.idleTimeoutMs = limits.idleTimeoutMs;
          metadata.idleExpiresAt = Math.min(metadata.idleExpiresAt ?? lastActivityAt + limits.idleTimeoutMs,
            lastActivityAt + limits.idleTimeoutMs, metadata.expiresAt);
          const before = await this.ctx.storage.get(METADATA_KEY);
          if (JSON.stringify(before) !== JSON.stringify(metadata)) {
            await this.ctx.storage.put(METADATA_KEY, metadata);
            await this.ctx.storage.setAlarm(this.deadline(metadata));
            await this.container.setInactivityTimeout(limits.idleTimeoutMs);
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
          if(!workspaceStart && selection?.containerSnapshot)return this.respond({error:'invalid_request'},400);
          if (networkStart && selection?.internet !== false) return this.respond({ error: 'invalid_internet_policy' }, 400);
          const result = await this.start(selection);
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
    if (metadata && !this.container.running && metadata.computeStoppedAt === undefined) {
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
          ...(metadata.imageName ? { imageName: metadata.imageName } : {}),
          ...(metadata.imageId ? { imageId: metadata.imageId } : {}),
          ...(metadata.catalogId ? { catalogId: metadata.catalogId } : {}),
          ...(metadata.imageDigest ? { imageDigest: metadata.imageDigest } : {}),
          ...(metadata.workspaceId ? { workspaceId: metadata.workspaceId } : {}),
          createdAt: new Date(metadata.createdAt).toISOString(),
          expiresAt: new Date(metadata.expiresAt).toISOString(),
        }]
      : [];
    return {
      containers,
      lastRun: metadata ? { reservationId: metadata.reservationId, stoppedAt: metadata.computeStoppedAt } : null,
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
    return Math.min(idleExpiresAt, metadata.expiresAt);
  }

  async getTerminalMetadata(createdAt, expiresAt) {
    return this.serialized(() => this.terminalMetadata(createdAt, expiresAt));
  }

  // Internal caller must already hold the controller lifecycle lock. Keeping
  // this check separate avoids reversing lifecycle/webhook configuration locks.
  async terminalMetadata(createdAt, expiresAt) {
    if (!this.container.running || !await this.hasPaidAccess()) return null;
    const metadata = await this.ctx.storage.get(METADATA_KEY);
    if (!metadata || this.now() >= this.deadline(metadata) || !await this.hasPaidAccess()) return null;
    if (new Date(metadata.createdAt).toISOString() !== createdAt) return null;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now()
      || expiresAt > metadata.expiresAt) return null;
    return metadata;
  }

  async startTerminalProcess(createdAt, expiresAt, argv, options) {
    return this.serialized(async () => {
      if (!this.container.running) throw new Error("Machine unavailable");
      const metadata = await this.ctx.storage.get(METADATA_KEY);
      if (!metadata || this.now() >= this.deadline(metadata)
        || !await this.hasPaidAccess()
        || new Date(metadata.createdAt).toISOString() !== createdAt
        || expiresAt <= this.now() || expiresAt > metadata.expiresAt) {
        throw new Error("Machine unavailable");
      }
      return this.container.exec(argv, options);
    });
  }

  async touchTerminalActivity(createdAt) {
    return this.serialized(async () => {
      if (!this.container.running) return false;
      const metadata = await this.ctx.storage.get(METADATA_KEY);
      if (!metadata || new Date(metadata.createdAt).toISOString() !== createdAt
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
    });
  }

  async signalOperationGroup(createdAt, groupId, signal) {
    if (!Number.isSafeInteger(groupId) || groupId <= 1 || ![2, 9, 15].includes(signal)) return false;
    return this.serialized(async () => {
      const metadata = await this.ctx.storage.get(METADATA_KEY);
      if (!this.container.running || !metadata || new Date(metadata.createdAt).toISOString() !== createdAt) return false;
      // Cleanup cannot provision, renew a lease or act on a replacement. It
      // remains possible during billing outages and after a deadline expires.
      const process = await this.container.exec(['/bin/bash', '-c', 'kill -s "$2" -- "-$1"', 'mainbrella-group-signal', String(groupId), String(signal)],
        { stdout: 'ignore', stderr: 'ignore' });
      return await process.exitCode === 0;
    });
  }

  async hasPaidAccess() {
    const entitlement = this.entitlement ?? await this.ctx.storage.get('machineEntitlement');
    return validEntitlement(entitlement, this.now());
  }

  async start(selection = {}) {
    if (!validEntitlement(this.entitlement, this.now())) return this.respond({ error: "subscription_required" }, 402);
    if (this.container.running) {
      return this.respond({ error: "container_limit_exceeded" }, 409);
    }

    const size = machineSize(selection.size ?? 'lite');
    if (!size) return this.respond({ error: 'invalid_size' }, 400);
    if (selection.internet !== undefined && typeof selection.internet !== 'boolean') return this.respond({ error: 'invalid_internet_policy' }, 400);
    if (selection.computeExpiresAt !== undefined && (!Number.isSafeInteger(selection.computeExpiresAt) || selection.computeExpiresAt <= this.now())) return this.respond({ error: 'compute_allowance_exhausted' }, 429);
    const imageKey = selection.imageKey || "terminal";
    const image = Object.hasOwn(this.container.images, imageKey) ? this.container.images[imageKey] : undefined;
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
    const createdAt = Math.max(now, (previousMetadata?.createdAt ?? -1) + 1);
    const metadata = {
      createdAt,
      telemetryId: crypto.randomUUID(),
      size: size.id,
      internet: selection.internet ?? true,
      reservationId: (await this.ctx.storage.get('machineReservation'))?.accepted,
      imageDigest: image,
      imageKey,
      ...(selection.workspaceId?{workspaceId:selection.workspaceId}:{}),
      ...(catalogImage ? { catalogId: catalogImage.id, imageName: catalogImage.name } : {}),
      ...(selection.imageId ? { imageId: selection.imageId, imageName: selection.imageName } : {}),
      lastActivityAt: now,
      expiresAt: Math.min(now + limits.maxSessionMs, this.entitlement.validUntil, selection.computeExpiresAt ?? Infinity),
      idleExpiresAt: Math.min(now + limits.idleTimeoutMs, this.entitlement.validUntil),
      idleTimeoutMs: limits.idleTimeoutMs,
    };
    await this.ctx.storage.put(METADATA_KEY, metadata);
    await this.observations.append(metadata, 'starting');
    await this.ctx.storage.setAlarm(this.deadline(metadata));

    try {
      if (!validEntitlement(this.entitlement, this.now())) {
        await this.ctx.storage.deleteAlarm();
        return this.respond({ error: 'subscription_required' }, 402);
      }
      this.container.start({
        ...(selection.workspaceId ? {containerSnapshot:{id:selection.containerSnapshot.id}} : {image}),
        instance: size.instance,
        entrypoint: ["sleep", "infinity"],
        enableInternet: metadata.internet,
        labels: { mb_generation: metadata.telemetryId },
      });
      this.onStarted?.(metadata.createdAt);
      await this.container.setInactivityTimeout(metadata.idleTimeoutMs ?? BUILDER_LIMITS.idleTimeoutMs);
      let readinessTimer;
      let output;
      try {
        const readiness = (async () => {
          const process = await this.container.exec(["sh", "-lc", "uname -a"]);
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
      await this.observations.append(metadata, 'started');
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
