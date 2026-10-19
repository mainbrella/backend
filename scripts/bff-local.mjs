import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';

const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const databaseName = new RegExp(`^bff-local-(${uuid})$`);
const databasePath = new RegExp(`^/(${uuid})(/query)?$`);

function validStatement(statement) {
  if (!statement || typeof statement.sql !== 'string') return false;
  return statement.params === undefined || (Array.isArray(statement.params)
    && statement.params.every(value => value === null || typeof value === 'string'
      || (typeof value === 'number' && Number.isFinite(value))));
}

// Projects need dynamically created bindings. Wrangler's Node API supplies real
// local D1 bindings, with a separate config and persistence directory per project.
export async function startBffLocal({ statePath }) {
  const token = randomBytes(32).toString('hex');
  const proxies = new Map(), operations = new Map();
  const directory = id => join(statePath, 'bff', id);
  const configPath = id => join(directory(id), 'wrangler.jsonc');
  let closing;

  function serial(id, action) {
    const pending = (operations.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
    operations.set(id, pending);
    void pending.finally(() => {
      if (operations.get(id) === pending) operations.delete(id);
    }).catch(() => {});
    return pending;
  }

  async function database(id) {
    if (!proxies.has(id)) {
      const { getPlatformProxy } = await import('wrangler');
      const proxy = await getPlatformProxy({ configPath: configPath(id), envFiles: [],
        persist: { path: join(directory(id), 'v3') }, remoteBindings: false });
      proxies.set(id, proxy);
    }
    return proxies.get(id).env.DB;
  }

  const server = createServer(async (request, response) => {
    const reply = (status, result) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ success: status === 200, result }));
    };
    // Only the local Worker has this ephemeral credential. No browser endpoint.
    if (request.headers.authorization !== `Bearer ${token}` || request.headers.origin) return reply(403, null);
    if (closing) return reply(503, null);
    try {
      const url = new URL(request.url, 'http://localhost');
      let input;
      if (request.method === 'POST') {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) return reply(413, null);
          chunks.push(chunk);
        }
        try { input = JSON.parse(Buffer.concat(chunks).toString()); }
        catch { return reply(400, null); }
      }
      if (url.pathname === '/' && request.method === 'GET') {
        const name = url.searchParams.get('name'), id = databaseName.exec(name ?? '')?.[1];
        if (!id) return reply(400, null);
        return reply(200, await serial(id, () => existsSync(configPath(id)) ? [{ uuid: id, name }] : []));
      }
      if (url.pathname === '/' && request.method === 'POST') {
        const id = databaseName.exec(input?.name ?? '')?.[1];
        if (!id) return reply(400, null);
        await serial(id, async () => {
          await mkdir(directory(id), { recursive: true, mode: 0o700 });
          if (!existsSync(configPath(id))) await writeFile(configPath(id), JSON.stringify({
            name: `bff-local-${id}`, compatibility_date: '2026-09-18',
            d1_databases: [{ binding: 'DB', database_name: `bff-local-${id}`, database_id: id, remote: false }],
          }, null, 2), { mode: 0o600 });
          await database(id);
        });
        return reply(200, { uuid: id });
      }
      const match = databasePath.exec(url.pathname);
      if (!match) return reply(404, null);
      const [, id, query] = match;
      if (request.method === 'DELETE' && !query) {
        await serial(id, async () => {
          await proxies.get(id)?.dispose();
          proxies.delete(id);
          await rm(directory(id), { recursive: true, force: true });
        });
        return reply(200, null);
      }
      if (request.method !== 'POST' || !query) return reply(405, null);
      if (!Array.isArray(input?.batch) || !input.batch.length || input.batch.length > 128
        || !input.batch.every(validStatement)) return reply(400, null);
      const result = await serial(id, async () => {
        // Never implicitly recreate deleted or missing databases on a query.
        await readFile(configPath(id));
        const db = await database(id);
        return db.batch(input.batch.map(({ sql, params = [] }) => db.prepare(sql).bind(...params)));
      });
      reply(200, result);
    } catch {
      reply(502, null);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { url: `http://127.0.0.1:${server.address().port}`, token,
    close() {
      return closing ??= (async () => {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await Promise.allSettled(operations.values());
        await Promise.all([...proxies.values()].map(proxy => proxy.dispose()));
        proxies.clear();
      })();
    },
  };
}
