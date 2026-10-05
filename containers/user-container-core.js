// Temporary plan resolution: every account uses Builder until DB-backed tiers land.
export const BUILDER_LIMITS = Object.freeze({
  maxContainers: 1,
  maxStartsPerMonth: 10,
  maxSessionMs: 60 * 60 * 1000,
  idleTimeoutMs: 10 * 60 * 1000,
});

const INSTANCE = "lite";
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
    return this.serialized(async () => {
      const url = new URL(request.url);
      if (url.pathname !== "/container") return this.respond({ error: "Not found" }, 404);

      if (this.container.running) {
        const metadata = await this.ctx.storage.get(METADATA_KEY);
        if (!metadata) {
          await this.destroy("User container metadata missing");
          await this.ctx.storage.deleteAlarm();
        } else if (this.now() >= this.deadline(metadata)) {
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
        try {
          const selection = request.body ? await request.json() : {};
          const result = await this.start(selection);
          return result instanceof Response ? result : this.respond(result);
        } catch (error) {
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
    const containers = this.container.running && metadata
      ? [{
          id: "small",
          name: "Small container",
          instance: INSTANCE,
          status: "running",
          ...(metadata.imageId ? { imageId: metadata.imageId, imageName: metadata.imageName } : {}),
          createdAt: new Date(metadata.createdAt).toISOString(),
          expiresAt: new Date(metadata.expiresAt).toISOString(),
        }]
      : [];
    return {
      containers,
      plan: "builder",
      limits: BUILDER_LIMITS,
      usage: { month, starts: usage[month] ?? 0 },
    };
  }

  deadline(metadata) {
    // Older metadata without idleExpiresAt still gets a fixed idle deadline
    // derived from creation time, never from the current poll or restart time.
    const idleExpiresAt = metadata.idleExpiresAt
      ?? metadata.createdAt + BUILDER_LIMITS.idleTimeoutMs;
    return Math.min(idleExpiresAt, metadata.expiresAt);
  }

  async getTerminalMetadata(createdAt, expiresAt) {
    return this.serialized(async () => {
      if (!this.container.running) return null;
      const metadata = await this.ctx.storage.get(METADATA_KEY);
      if (!metadata || this.now() >= this.deadline(metadata)) return null;
      if (new Date(metadata.createdAt).toISOString() !== createdAt) return null;
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now()
        || expiresAt > metadata.expiresAt) return null;
      return metadata;
    });
  }

  async startTerminalProcess(createdAt, expiresAt, argv, options) {
    return this.serialized(async () => {
      if (!this.container.running) throw new Error("Machine unavailable");
      const metadata = await this.ctx.storage.get(METADATA_KEY);
      if (!metadata || this.now() >= this.deadline(metadata)
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
        || this.now() >= this.deadline(metadata)) return false;
      metadata.idleExpiresAt = Math.min(
        this.now() + BUILDER_LIMITS.idleTimeoutMs,
        metadata.expiresAt,
      );
      await this.ctx.storage.put(METADATA_KEY, metadata);
      await this.ctx.storage.setAlarm(this.deadline(metadata));
      await this.container.setInactivityTimeout(BUILDER_LIMITS.idleTimeoutMs);
      return true;
    });
  }

  async start(selection = {}) {
    if (this.container.running) {
      return this.respond({ error: "container_limit_exceeded" }, 409);
    }

    const imageKey = selection.imageKey || "terminal";
    const image = Object.hasOwn(this.container.images, imageKey) ? this.container.images[imageKey] : undefined;
    if (!image) return this.respond({ error: "image_not_available" }, 409);

    const now = this.now();
    const month = monthFor(new Date(now));
    const usage = (await this.ctx.storage.get(USAGE_KEY)) ?? {};
    if ((usage[month] ?? 0) >= BUILDER_LIMITS.maxStartsPerMonth) {
      return this.respond({ error: "container_quota_exceeded" }, 429);
    }

    // Reserve before asking the platform to start. A failed start remains charged
    // for quota purposes, which avoids races and accidental extra starts.
    usage[month] = (usage[month] ?? 0) + 1;
    await this.ctx.storage.put(USAGE_KEY, usage);
    const metadata = {
      createdAt: now,
      ...(selection.imageId ? { imageId: selection.imageId, imageName: selection.imageName } : {}),
      expiresAt: now + BUILDER_LIMITS.maxSessionMs,
      idleExpiresAt: now + BUILDER_LIMITS.idleTimeoutMs,
      idleTimeoutMs: BUILDER_LIMITS.idleTimeoutMs,
    };
    await this.ctx.storage.put(METADATA_KEY, metadata);
    await this.ctx.storage.setAlarm(this.deadline(metadata));

    try {
      this.container.start({
        image,
        instance: INSTANCE,
        entrypoint: ["sleep", "infinity"],
        enableInternet: true,
      });
      await this.container.setInactivityTimeout(BUILDER_LIMITS.idleTimeoutMs);
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
      return this.status();
    } catch (error) {
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
    await this.container.destroy(reason);
    this.onStopped?.();
  }

  async alarm() {
    return this.serialized(async () => {
      const metadata = await this.ctx.storage.get(METADATA_KEY);
      if (metadata && this.now() < this.deadline(metadata)) {
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
