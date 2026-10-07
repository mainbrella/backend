import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { deserialize } from 'node:v8';
import { join } from 'node:path';

const exec = promisify(execFile);
const docker = async args => (await exec('docker', args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 })).stdout;

async function readMetadata(path) {
  const { DatabaseSync } = await import('node:sqlite');
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const row = db.prepare("SELECT value FROM _cf_KV WHERE key = 'builderMachine'").get();
    return row ? deserialize(row.value) : null;
  } catch { return null; }
  finally { db?.close(); }
}

// Docker names are scoped to the Worker/class, and local storage proves that
// they belong to this checkout. Unknown state always prevents periodic removal.
export class LocalProxyCleanup {
  constructor({ statePath, workerName, className, runDocker = docker, metadata = readMetadata, now = Date.now, graceMs = 30_000 }) {
    Object.assign(this, { statePath, workerName, className, runDocker, metadata, now, graceMs });
    this.prefix = `workerd-${workerName}-${className}-`;
    this.owned = new Set();
    this.baseline = null;
  }

  async list() {
    const output = await this.runDocker(['ps', '-a', '--no-trunc', '--format', '{{json .}}']);
    return output.trim() ? output.trim().split('\n').map(line => JSON.parse(line)) : [];
  }

  proxy(container) {
    const name = container.Names;
    if (!name?.startsWith(this.prefix) || !name.endsWith('-proxy')
      || !/^cloudflare\/proxy-everything(?::|@)/.test(container.Image)) return null;
    const id = name.slice(this.prefix.length, -'-proxy'.length);
    if (!/^[a-f0-9]{64}$/.test(id)) return null;
    return { name, workload: name.slice(0, -'-proxy'.length),
      path: join(this.statePath, 'v3', 'do', `${this.workerName}-${this.className}`, `${id}.sqlite`) };
  }

  async sweep({ shutdown = false } = {}) {
    const containers = await this.list();
    this.baseline ??= new Set(containers.map(c => c.ID));
    let removed = 0;
    for (const container of containers) {
      const proxy = this.proxy(container);
      if (!proxy) continue;
      const record = await this.metadata(proxy.path);
      if (!record) continue;
      if (!this.baseline.has(container.ID)) this.owned.add(container.ID);
      const stopped = Number.isSafeInteger(record.computeStoppedAt)
        && record.computeStoppedAt <= this.now() - (shutdown ? 0 : this.graceMs);
      if (!stopped && !(shutdown && this.owned.has(container.ID))) continue;
      // Recheck Docker and state immediately before removal. A workload with the
      // same name, even stopped, is preserved; it may be starting or restarting.
      const current = await this.list();
      if (current.some(c => c.Names === proxy.workload)
        || !current.some(c => c.ID === container.ID && c.Names === proxy.name)) continue;
      const latest = await this.metadata(proxy.path);
      if (!latest || (!shutdown && (!Number.isSafeInteger(latest.computeStoppedAt)
        || latest.computeStoppedAt > this.now() - this.graceMs))) continue;
      if (shutdown && !Number.isSafeInteger(latest.computeStoppedAt) && !this.owned.has(container.ID)) continue;
      await this.runDocker(['rm', '-f', container.ID]);
      removed++;
    }
    return removed;
  }
}
