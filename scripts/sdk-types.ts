import { Mainbrella, Execution, MainbrellaError, verifyWebhookSignature, type MachineSize, type CommandResult } from '@mainbrella/sdk';

// Compiled against the installed tarball, never the checkout's declarations.
async function workflow(apiKey: string, size: MachineSize) {
  const client = new Mainbrella({ apiKey });
  const capabilities = await client.capabilities();
  const sandbox = await client.create({ catalogId: 'node', size, internet: capabilities.networking.internetControl ? false : undefined });
  try {
    const internet: boolean | undefined = sandbox.internet;
    const result: CommandResult = await sandbox.commands.run('printf hello');
    await sandbox.files.write('/tmp/probe', new Uint8Array([0, 255]));
    const bytes: Uint8Array = await sandbox.files.read('/tmp/probe');
    await sandbox.files.upload('/tmp/probe-large', new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }), { size: bytes.byteLength });
    const download: ReadableStream<Uint8Array> = await sandbox.files.download('/tmp/probe-large');
    await download.cancel();
    await sandbox.files.uploadDirectory('./fixtures', '/tmp/files');
    await sandbox.files.downloadDirectory('/tmp/files', './download');
    for await (const event of sandbox.files.watch('/tmp/files', { signal: AbortSignal.timeout(1000) })) { console.log(event.type, event.entry.path); break; }
    await sandbox.files.mkdir('/tmp/work', { recursive: true, mode: '0700' });
    const page = await sandbox.files.list('/tmp/work', { limit: 100 });
    const entry = await sandbox.files.stat('/tmp/probe');
    await sandbox.files.move('/tmp/probe', '/tmp/work/probe');
    await sandbox.files.chmod('/tmp/work/probe', '0640');
    await sandbox.files.remove('/tmp/work', { recursive: true });
    const job = await sandbox.commands.start('npm test');
    const reconnected = new Execution(sandbox, job.id);
    for await (const event of reconnected.events({ cursor: job.cursor })) console.log(event.type);
    await job.cancel();
    const interactive = await sandbox.commands.start(['cat'], { stdin: true, cwd: '/workspace', env: { TASK: 'probe' } });
    await interactive.stdin.write(new TextEncoder().encode('hello'));
    await interactive.stdin.close();
    const attached = sandbox.commands.attach(interactive.id);
    await attached.signal('SIGTERM');
    const terminal = await sandbox.commands.start(['/bin/sh'], { stdin: true, pty: { cols: 80, rows: 24 } });
    await terminal.resize(132, 40);
    await terminal.cancel();
    const jobs = await sandbox.commands.list();
    const codeContext = await sandbox.code.create({ language: 'python' });
    const codeResult = await codeContext.run('values = [1, 2]\nvalues', { timeoutMs: 1000 });
    const codeMime: string | undefined = codeResult.results[0]?.mimeType;
    const codeError: string | undefined = codeResult.error?.message;
    await sandbox.code.list();
    await sandbox.code.attach(codeContext.id).close();
    void codeMime; void codeError;
    const history = await sandbox.events({ cursor: 0, limit: 100 });
    if (capabilities.observability.metrics) await sandbox.metrics();
    if (capabilities.observability.webhooks) {
      const config = await sandbox.webhook.configure('https://relay.example.com/callback', { replayFromCursor: history.nextCursor });
      await verifyWebhookSignature(new Uint8Array(), '', config.signingSecret);
      await sandbox.webhook.deliveries();
      await sandbox.webhook.remove();
    }
    if (capabilities.previews.supported) {
      const link = await sandbox.previews.create(3000);
      await sandbox.previews.revoke(link.id);
    }
    return { internet, result, bytes, page, entry, jobs };
  } catch (error) {
    if (error instanceof MainbrellaError) console.log(error.code);
    throw error;
  } finally {
    await sandbox.kill();
  }
}
void workflow;

async function poolAndImageWorkflow(client: Mainbrella) {
  const queued = await client.images.create({ name: 'Tools', dockerfile: 'FROM mainbrella:base' });
  const { image } = await client.images.get(queued.image.id);
  const digest: string | null | undefined = image.digest;
  if (image.status !== 'ready') return { digest, logs: await client.images.logs(image.id) };
  await client.images.tags.set('tools.stable', image.id);
  const resolved = await client.images.tags.get('tools.stable');
  const pool = client.pool({ targetSize: 2, create: { imageId: resolved.image.id } });
  await pool.refill();
  const sandbox = await pool.acquire();
  try { return { digest, command: await sandbox.commands.run('true'), state: pool.state }; }
  finally { try { await sandbox.kill(); } finally { await pool.close(); } }
}
void poolAndImageWorkflow;

async function managedPoolWorkflow(client: Mainbrella) {
  if (!(await client.capabilities()).pools.managed) return;
  const { pool } = await client.pools.create({ name: 'Agent workers', targetSize: 2, ttlSeconds: 600, catalogId: 'node', idempotencyKey: 'pool-create' });
  const expiresAt: string = pool.expiresAt;
  await client.pools.list();
  await client.pools.get(pool.id);
  const sandbox = await client.pools.acquire(pool.id, { idempotencyKey: 'pool-claim' });
  try { await sandbox.commands.run('true'); }
  finally { await sandbox.kill(); await client.pools.update(pool.id, { targetSize: 0 }); await client.pools.delete(pool.id); }
  await client.images.create({ name: 'Private tools', dockerfile: 'FROM mainbrella:base', cacheFrom: 'owned-image-id',
    baseImage: { image: `ghcr.io/owner/tools@sha256:${'a'.repeat(64)}`, username: 'reader', password: 'from-secret-store' } });
  return expiresAt;
}
void managedPoolWorkflow;

async function desktopWorkflow(client: Mainbrella, id: string, createdAt: string) {
  const sandbox = client.connect({ id, createdAt });
  if (!(await sandbox.desktop.probe()).supported) return;
  const desktop = await sandbox.desktop.start({ width: 1280, height: 720 });
  try {
    await desktop.launch(['xterm']);
    await desktop.move(100, 100); await desktop.click();
    await desktop.type('printf hello'); await desktop.press('Return');
    const png: Uint8Array = await desktop.screenshot();
    return png;
  } finally { await desktop.close(); }
}
void desktopWorkflow;

async function nativeWatchWorkflow(sandbox: import('@mainbrella/sdk').Sandbox) {
  const watcher = await sandbox.files.watchNative('/workspace', { recursive: true, timeoutMs: 60000, idempotencyKey: 'watch-project' });
  const execution: Execution = watcher.execution;
  try {
    for await (const event of watcher.events()) {
      if (event.type === 'ready') continue;
      const filename: string | null = event.filename;
      return { executionId: execution.id, filename };
    }
  } finally { await watcher.close(); }
}
void nativeWatchWorkflow;

async function gitWorkflow(sandbox: import('@mainbrella/sdk').Sandbox) {
  const cwd = '/workspace/project';
  const status = await sandbox.git.status({ cwd });
  const paths: string[] = status.entries.map(entry => entry.path);
  const { patch } = await sandbox.git.diff({ cwd, paths, staged: true });
  const { branches } = await sandbox.git.branches({ cwd });
  const current: string | undefined = branches.find(branch => branch.current)?.name;
  await sandbox.git.checkout({ cwd, branch: 'work/fix', create: true, idempotencyKey: 'create-work-fix' });
  const commit = await sandbox.git.commit({ cwd, message: 'Fix prepared change', author: { name: 'Developer', email: 'developer@example.com' }, idempotencyKey: 'commit-prepared-fix' });
  return { patch, current, executionId: commit.executionId };
}
void gitWorkflow;
