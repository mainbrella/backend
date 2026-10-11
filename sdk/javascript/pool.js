import { MainbrellaError } from './index.js';

// Client-managed inventory of regular, billed sandboxes. No background refill,
// reset/reuse of acquired machines, or service-side keepalive is implied.
export class SandboxPool {
  #client; #options; #target; #ready = []; #pending; #closed = false;
  #queue = Promise.resolve();
  constructor(client, { targetSize = 1, create = {} } = {}) {
    if (!Number.isInteger(targetSize) || targetSize < 1 || targetSize > 10 || !create || typeof create !== 'object'
      || Array.isArray(create) || 'idempotencyKey' in create || 'startupCommand' in create || create.lifecycle === 'production') {
      throw new MainbrellaError('invalid_pool_options');
    }
    this.#client = client;
    this.#options = structuredClone(create);
    this.#target = targetSize;
  }
  get state() {
    return { closed: this.#closed, targetSize: this.#target,
      available: this.#ready.map(sandbox => ({ id: sandbox.id, createdAt: sandbox.createdAt })),
      pending: this.#pending ? { ...this.#pending } : null };
  }
  #serialize(operation) {
    const result = this.#queue.then(operation);
    this.#queue = result.catch(() => {});
    return result;
  }
  async #refresh() {
    if (!this.#ready.length) return;
    const { containers } = await this.#client.list();
    if (!Array.isArray(containers)) throw new MainbrellaError('invalid_response');
    for (const sandbox of [...this.#ready]) {
      const current = containers.find(item => item.id === sandbox.id && item.createdAt === sandbox.createdAt);
      if (current?.status === 'running') continue;
      if (current) {
        // Preserve cleanup responsibility on failure, including stopped slots.
        await sandbox.kill();
      }
      this.#ready.splice(this.#ready.indexOf(sandbox), 1);
    }
  }
  async #create() {
    if (!this.#pending) {
      const caps = await this.#client.capabilities();
      const retention = caps?.containers?.creationRetentionMs;
      if (caps?.containers?.idempotentCreate !== true || !Number.isFinite(retention) || retention < 60_000) {
        throw new MainbrellaError('pool_unavailable');
      }
      this.#pending = { idempotencyKey: crypto.randomUUID(), retryBefore: Date.now() + Math.min(retention / 2, 3_600_000) };
    }
    if (Date.now() >= this.#pending.retryBefore) throw new MainbrellaError('pool_creation_expired', 0, { idempotencyKey: this.#pending.idempotencyKey });
    // Keep the same key even for definitive admission failures. Refill must
    // never accidentally issue a second create after an ambiguous response.
    const sandbox = await this.#client.create({ ...this.#options, idempotencyKey: this.#pending.idempotencyKey,
      waitTimeoutMs: Math.min(this.#options.waitTimeoutMs ?? 120_000, Math.max(1, this.#pending.retryBefore - Date.now())) });
    this.#ready.push(sandbox);
    this.#pending = undefined;
  }
  refill() {
    return this.#serialize(async () => {
      if (this.#closed) throw new MainbrellaError('pool_closed');
      await this.#refresh();
      while (this.#ready.length < this.#target) await this.#create();
      return this.state;
    });
  }
  acquire() {
    return this.#serialize(async () => {
      if (this.#closed) throw new MainbrellaError('pool_closed');
      await this.#refresh();
      if (!this.#ready.length) throw new MainbrellaError('pool_empty');
      return this.#ready.shift();
    });
  }
  close() {
    return this.#serialize(async () => {
      this.#closed = true;
      // Reconcile an ambiguous create with its original key before deleting.
      // If reconciliation fails, keep both pending and ready state for retry.
      let pendingError;
      try { if (this.#pending) await this.#create(); } catch (error) { pendingError = error; }
      await this.#refresh();
      while (this.#ready.length) { await this.#ready[0].kill(); this.#ready.shift(); }
      if (pendingError) throw pendingError;
      return this.state;
    });
  }
}
