import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from 'miniflare';

const { values } = parseArgs({ options: { image: { type: 'string' } } });
assert.ok(values.image, 'Supply an existing local relay image with --image');
const work = await mkdtemp(join(tmpdir(), 'security-relay-test-'));
let mf;
try {
  const outfile = join(work, 'worker.mjs');
  await build({ stdin: { contents: `import worker,{EgressRelay} from './worker/security-relay.ts';
    export class QualificationRelay extends EgressRelay {
      async running(){return this.ctx.container.running;}
      async idle(){await this.alarm();return this.ctx.container.running;}
    }
    export default worker;`, resolveDir: resolve('.') }, outfile, bundle: true, platform: 'browser', format: 'esm', external: ['cloudflare:*', 'node:*'], logLevel: 'silent' });
  const token = randomBytes(32).toString('hex');
  mf = new Miniflare(convertV4MiniflareOptions({ cf: false, log: new Log(LogLevel.ERROR), telemetry: { enabled: false }, workers: [{ name: 'relay-qualification', modules: true, script: await readFile(outfile, 'utf8'),
    compatibilityDate: '2026-10-05', compatibilityFlags: ['nodejs_compat', 'enable_request_signal'], bindings: { EGRESS_RELAY_TOKEN: token },
    durableObjects: { EGRESS_RELAY: { className: 'QualificationRelay', useSQLite: true, container: { images: [{ name: 'relay', image: values.image }] } } },
  }] }));
  await mf.ready;
  const namespace = await mf.getDurableObjectNamespace('EGRESS_RELAY');
  const relay = namespace.get(namespace.idFromName('relay'));
  const request = authorization => mf.dispatchFetch('http://test/v1/egress', { method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({
    version: 1, url: 'https://api.mainbrella.com/capabilities', method: 'GET', body: '', headers: [], injections: [], policy: { allow: ['api.mainbrella.com'], deny: [] },
  }) });
  assert.equal((await request('Bearer incorrect')).status, 403);
  assert.equal(await relay.running(), false, 'Unauthorized ingress woke the relay');
  for (let boot = 0; boot < 2; boot++) {
    const response = await request(`Bearer ${token}`); assert.equal(response.status, 200);
    const envelope = await response.json(); assert.equal(envelope.status, 200);
    assert.equal(JSON.parse(Buffer.from(envelope.body, 'base64')).secrets.vault, false);
    assert.equal(await relay.running(), true);
    assert.equal(await relay.idle(), false, 'Idle shutdown left the relay running');
  }
  console.log('Relay qualification passed: unauthorized ingress stays asleep; real native startup, DNS/TLS forwarding, idle shutdown and restart.');
} finally { await mf?.dispose(); await rm(work, { recursive: true, force: true }); }
