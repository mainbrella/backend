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
