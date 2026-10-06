import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { handleRequest } from './router';
import { ContainerAccountController } from '../../containers/container-account-core.js';
import { hashToken } from './auth-core';
import { paidContainerFixture, USER_ONE, USER_TWO, EXPIRES_AT, GENERATION_TWO } from './paid-container-test-helpers';
// @ts-expect-error Integration test exercises the shipped JavaScript runtime directly.
import { UserContainerController } from '../../containers/user-container-core.js';
// @ts-expect-error Integration test exercises the shipped JavaScript runtime directly.
import { executeCommand } from '../../containers/commands.js';
// @ts-expect-error Integration test exercises the shipped JavaScript runtime directly.
import { accessFile } from '../../containers/files.js';
// @ts-expect-error Integration test exercises the shipped JavaScript runtime directly.
import { accessFilesystem } from '../../containers/filesystem.js';
// @ts-expect-error Integration test exercises the shipped JavaScript runtime directly.
import { ManagedExecutions } from '../../containers/executions.js';
// @ts-expect-error Integration test exercises the shipped JavaScript runtime directly.
import { WorkloadWebhooks } from '../../containers/webhooks.js';

const gnu = ['stat', 'find', 'sed', 'timeout'].every(command => spawnSync(command, ['--version'], { encoding: 'utf8' }).stdout?.includes('GNU'));

test('SDK HTTP lifecycle reaches real API handlers, filesystem and managed subprocesses', { skip: gnu ? false : 'Requires GNU guest tools; exercised on Linux CI.' }, async t => {
  const realFetch = globalThis.fetch;
  const f = await paidContainerFixture(t, { [USER_ONE]: [], [USER_TWO]: [{ id: 'small', createdAt: GENERATION_TWO, expiresAt: EXPIRES_AT }] });
  const directory = await mkdtemp(join(tmpdir(), 'mainbrella-sdk-runtime-'));
  const children: ReturnType<typeof spawn>[] = [], work: Promise<unknown>[] = [], active = new Set();
  const values = new Map<string, unknown>();
  let time = Date.now();
  const providerStarts: { enableInternet: boolean }[] = [];
  const ctx = { waitUntil(promise: Promise<unknown>) { work.push(promise); },
    storage: { async get(key: string) { return structuredClone(values.get(key)); }, async put(key: string | Record<string, unknown>, value: unknown) {
      if (typeof key === 'object') for (const [name, entry] of Object.entries(key)) values.set(name, structuredClone(entry));
      else values.set(key, structuredClone(value));
    }, async delete(keys: string | string[]) { for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key); },
    async list({ prefix, startAfter, limit }: { prefix: string; startAfter?: string; limit: number }) {
      return new Map([...values].filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter)).sort().slice(0, limit).map(([key, value]) => [key, structuredClone(value)]));
    }, async setAlarm() {}, async deleteAlarm() {} },
    container: { images: { terminal: 'registry.test/qualified@sha256:local' }, running: false, start(options: {enableInternet: boolean}) { providerStarts.push(options); this.running = true; }, async setInactivityTimeout() {}, async destroy() { this.running = false; for (const session of active as Set<{close(): void}>) session.close(); },
      async exec(argv: string[], options: { signal?: AbortSignal; cwd?: string; env?: Record<string, string> } = {}) {
        const child = spawn(argv[0], argv.slice(1), { stdio: 'pipe', cwd: options.cwd, env: { ...process.env, ...options.env } }); children.push(child);
        let exited = false;
        const kill = () => { if (!exited) child.kill('SIGKILL'); };
        options.signal?.addEventListener('abort', kill, { once: true });
        const exitCode = new Promise<number>(resolve => child.on('close', code => { exited = true; options.signal?.removeEventListener('abort', kill); resolve(code ?? 137); }));
        return { output: async () => {
          const collect = async (stream: NodeJS.ReadableStream) => { const chunks = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks).toString(); };
          const [stdout, stderr, code] = await Promise.all([collect(child.stdout!), collect(child.stderr!), exitCode]); return { stdout, stderr, exitCode: code };
        }, pid: child.pid, stdin: Writable.toWeb(child.stdin!), stdout: Readable.toWeb(child.stdout!), stderr: Readable.toWeb(child.stderr!), exitCode, kill };
      } },
  };
  const controller = new UserContainerController(ctx, () => time);
  const manager = new ManagedExecutions(controller, active, ctx);
  f.env.WORKLOAD_WEBHOOKS_ENABLED = 'true'; f.env.WEBHOOK_ALLOWED_HOSTS = 'relay.example.com';
  const webhookPayloads: object[] = [];
  const hooks = new WorkloadWebhooks(controller, { ...f.env, WEBHOOK_ENCRYPTION_KEY: 'a'.repeat(64) }, async (_url: string, options: RequestInit) => {
    webhookPayloads.push(JSON.parse(options.body as string)); return new Response(null, { status: 204 });
  });
  controller.observations.onAppend = (event: unknown) => hooks.enqueue(event);
  const token = `mb_${'c'.repeat(64)}`;
  f.sqlite.exec(readFileSync(new URL('../../migrations/010_api_keys.sql', import.meta.url), 'utf8'));
  f.sqlite.prepare('INSERT INTO api_keys (id,user_id,name,token_hash,prefix,created_at) VALUES (?,?,?,?,?,?)')
    .run('runtime-key', USER_ONE, 'Tests', await hashToken(token), token.slice(0, 11), new Date(time).toISOString());
  const accountValues = new Map<string, unknown>();
  const accountStorage = {
    async get(key: string) { return structuredClone(accountValues.get(key)); },
    async put(key: string | Record<string, unknown>, value: unknown) {
      if (typeof key === 'object') for (const [name, entry] of Object.entries(key)) accountValues.set(name, structuredClone(entry));
      else accountValues.set(key, structuredClone(value));
    },
    async delete(keys: string | string[]) { let count = 0; for (const key of Array.isArray(keys) ? keys : [keys]) count += Number(accountValues.delete(key)); return count; },
    async list({ prefix, startAfter, limit }: { prefix: string; startAfter?: string; limit: number }) {
      return new Map([...accountValues].filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter)).sort().slice(0, limit).map(([key, value]) => [key, structuredClone(value)]));
    }, async setAlarm() {}, async deleteAlarm() {},
  };
  const account = new ContainerAccountController({ storage: accountStorage as unknown as DurableObjectStorage }, (userId, id) => {
    assert.equal(userId, USER_ONE); assert.equal(id, 'small'); return { fetch: (request: Request) => controller.fetch(request) };
  }, () => time);
  f.env.CONTAINER_ACCOUNT = { idFromName(name: string) { return name; }, get(name: string) {
    assert.equal(name, 'account:' + USER_ONE); return { fetch: (request: Request) => account.fetch(request) };
  } } as unknown as Env['CONTAINER_ACCOUNT'];
  f.env.NETWORK_INTERNET_CONTROL_ENABLED = 'true';
  f.env.USER_CONTAINER = { idFromName(name: string) { return name; }, get(name: string) { return { fetch(request: Request) {
    assert.equal(name, 'user:' + USER_ONE);
    const path = new URL(request.url).pathname;
    if (path === '/container' || path === '/features') return controller.fetch(request);
    if (path.startsWith('/observations/webhook')) return hooks.fetch(request);
    if (path.startsWith('/observations/')) return controller.observations.fetch(request);
    if (path.startsWith('/filesystem/')) return accessFilesystem(controller, request, active);
    if (path === '/files') return accessFile(controller, request, active);
    if (path === '/exec') return executeCommand(controller, request, active);
    return manager.fetch(request);
  } }; } } as unknown as DurableObjectNamespace;
  const server = createServer(async (incoming, outgoing) => {
    const abort = new AbortController();
    incoming.on('aborted', () => abort.abort()); outgoing.on('close', () => { if (!outgoing.writableEnded) abort.abort(); });
    try {
      const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const response = await handleRequest(new Request(`https://api.mainbrella.com${incoming.url}`, { method: incoming.method,
        headers: incoming.headers as Record<string, string>, ...(bytes.length ? { body: bytes } : {}), signal: abort.signal }), f.env);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        const reader = response.body.getReader();
        abort.signal.addEventListener('abort', () => { void reader.cancel(); }, { once: true });
        while (!abort.signal.aborted) { const { done, value } = await reader.read(); if (done) break; if (!outgoing.write(value)) await once(outgoing, 'drain'); }
      }
      outgoing.end();
    } catch { outgoing.destroy(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    for (const session of active as Set<{close(): void}>) session.close();
    for (const child of children) child.kill('SIGKILL'); await Promise.allSettled(work);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    f.close(); await rm(directory, { recursive: true, force: true });
  });
  const module = process.env.MAINBRELLA_SDK_MODULE || pathToFileURL(join(process.cwd(), 'sdk/javascript/index.js')).href;
  const { Mainbrella } = await import(module);
  const client = new Mainbrella({ apiKey: token, baseUrl, fetch: realFetch });
  assert.equal((await client.capabilities()).execution.stdin, true);
  const sandbox = await client.create({ idempotencyKey: 'javascript-runtime-create', internet: false, pollIntervalMs: 1 });
  assert.equal((await client.create({ idempotencyKey: 'javascript-runtime-create', internet: false })).createdAt, sandbox.createdAt);
  assert.equal(sandbox.internet, false); assert.equal(providerStarts[0].enableInternet, false);
  try {
    const history = await sandbox.events(); assert.deepEqual(history.events.map((event: {type: string}) => event.type), ['starting', 'started']);
    const webhook = await sandbox.webhook.configure('https://relay.example.com/callback', { replayFromCursor: 0 });
    assert.match(webhook.signingSecret, /^mbwh_[a-f0-9]{64}$/); await hooks.tick();
    assert.equal((await sandbox.webhook.deliveries()).deliveries.length, 2);
    assert.ok(!('signingSecret' in await sandbox.webhook.get()));
    assert.deepEqual(await sandbox.commands.run('printf hello; printf error >&2'), { stdout: 'hello', stderr: 'error', exitCode: 0, timedOut: false, outputTruncated: false });
    const path = join(directory, '界 &?.bin'), moved = join(directory, 'moved');
    await sandbox.files.write(path, new Uint8Array([0, 128, 255])); assert.deepEqual(await sandbox.files.read(path), new Uint8Array([0, 128, 255]));
    await sandbox.files.move(path, moved); await sandbox.files.chmod(moved, '0640');
    assert.equal((await sandbox.files.stat(moved)).mode, '0640');
    assert.equal((await sandbox.files.list(directory)).entries[0].name, 'moved'); await sandbox.files.remove(moved);
    const job = await sandbox.commands.start(['cat'], { stdin: true, idempotencyKey: 'js-runtime-input' });
    while ((await job.get()).status === 'starting') await new Promise(resolve => setTimeout(resolve, 1));
    await job.stdin.write(new TextEncoder().encode('héllo 界\n')); await job.stdin.close();
    assert.equal((await job.wait({ pollIntervalMs: 1 })).stdout, 'héllo 界\n');
    const attached = sandbox.commands.attach(job.id); const events = [];
    for await (const event of attached.events()) events.push(event);
    assert.ok(events.some(event => event.data === 'héllo 界\n'));
    assert.ok((await sandbox.commands.list()).executions.some((record: {id: string}) => record.id === job.id));
    const long = await sandbox.commands.start('exec sleep 10', { idempotencyKey: 'js-runtime-cancel' });
    await long.cancel(); assert.equal((await long.wait({ pollIntervalMs: 1 })).status, 'canceled');
  } finally { await sandbox.kill(); }
  await hooks.tick(); assert.equal(webhookPayloads.length, 3);
  assert.deepEqual((await sandbox.events()).events.map((event: {type: string}) => event.type), ['starting', 'started', 'stopped']);
  await sandbox.webhook.remove();
  assert.equal(f.containers.get(USER_TWO)![0].createdAt, GENERATION_TWO);
  const python = process.env.MAINBRELLA_SDK_PYTHON || 'python3';
  const installed = Boolean(process.env.MAINBRELLA_SDK_PYTHON);
  const child = spawn(python, [...(installed ? ['-I'] : []), 'scripts/sdk-runtime-workflow.py', baseUrl, token, directory],
    { env: { ...process.env, ...(installed ? {} : { PYTHONPATH: join(process.cwd(), 'sdk/python') }) } });
  children.push(child);
  const childTimer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  let output = '', errors = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
  const [code] = await once(child, 'close'); clearTimeout(childTimer); assert.equal(code, 0, errors); assert.match(output, /"cleanedUp": true/);
  assert.deepEqual((await client.list()).containers, []); assert.equal(providerStarts.length, 2); assert.equal(f.containers.get(USER_TWO)![0].createdAt, GENERATION_TWO);
});
