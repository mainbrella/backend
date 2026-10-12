import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { IMAGE_CATALOG } from '../containers/image-catalog.js';

function fixture(t, { outdated = false, exitCode = 0, custom = { images: {} }, apiStatus = 200, dryRun = true, secret = true, localSecret, invalidCatalog = false, withoutActivity = false,
  busyResponses = 0, lockStatus = 200, releaseStatus = 200, lockError = false, manifestSignal, wranglerScript, preload = '', requireStoppedChild = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'terminal-deploy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['scripts', 'containers', 'containers/catalog', 'bin', 'node_modules/wrangler/bin']) mkdirSync(join(root, dir), { recursive: true });
  for (const file of ['deploy-containers.mjs', 'terminal-image.mjs', 'custom-images.mjs', 'catalog-images.mjs']) copyFileSync(new URL(file, import.meta.url), join(root, 'scripts', file));
  copyFileSync(new URL('../containers/image-catalog.js', import.meta.url), join(root, 'containers/image-catalog.js'));
  const dockerfile = 'FROM test\n';
  writeFileSync(join(root, 'containers/Dockerfile'), dockerfile);
  writeFileSync(join(root, 'wrangler.containers.jsonc'), JSON.stringify({ account_id: 'account', main: 'containers/user-container.js',
    durable_objects: { bindings: [
      { name: 'ACCOUNT_ACTIVITY', class_name: 'AccountActivity', script_name: 'mainbrella-api' },
      { name: 'OTHER', class_name: 'Other' },
    ] }, containers: [{ images: { terminal: { dockerfile: './containers/Dockerfile' } } }] }));
  const image = `registry.cloudflare.com/account/mainbrella-terminal@sha256:${'a'.repeat(64)}`;
  const manifest = { image, dockerfileHash: outdated ? 'old' : createHash('sha256').update(dockerfile).digest('hex') };
  const catalog = { images: {} };
  for (const entry of IMAGE_CATALOG) {
    if (entry.key !== 'terminal') writeFileSync(join(root, entry.dockerfile), dockerfile);
    catalog.images[entry.key] = { image: `registry.cloudflare.com/account/${entry.repository}@sha256:${'a'.repeat(64)}`, dockerfileHash: createHash('sha256').update(dockerfile).digest('hex') };
  }
  if (invalidCatalog) catalog.images.python.image = 'docker.io/python:latest';
  writeFileSync(join(root, 'bin/gh'), `#!${process.execPath}\nconsole.log(process.argv.includes('-H') ? (process.argv.includes('repos/mainbrella/backend/releases/assets/2') ? ${JSON.stringify(JSON.stringify(catalog))} : ${JSON.stringify(JSON.stringify(manifest))}) : '{"assets":[{"id":1,"name":"terminal-image.json"},{"id":2,"name":"catalog-images.json"}]}');\n`, { mode: 0o755 });
  writeFileSync(join(root, 'node_modules/wrangler/bin/wrangler.js'), `const fs = require('node:fs'); const args = process.argv.slice(2); fs.writeFileSync('result.json', JSON.stringify({args, config: JSON.parse(fs.readFileSync(args[args.indexOf('--config')+1]))})); ${wranglerScript ?? `process.exit(${exitCode});`}`);
  writeFileSync(join(root, 'fetch.mjs'), `${preload}
  let attempts = 0;
  globalThis.fetch = async (url, options) => {
    if (options.headers.Authorization !== 'Bearer ' + 's'.repeat(32)) throw new Error('Wrong image-build credential');
    if (url.endsWith('/deployment-lock')) {
      const fs = await import('node:fs'); fs.appendFileSync('locks.log', options.method + '\\n');
      fs.appendFileSync('lock-tokens.log', JSON.parse(options.body).token + '\\n');
      if (options.method === 'POST') {
        if (${lockError}) throw new Error('Connection lost during lease acquisition');
        return Response.json({ acquired: true }, { status: attempts++ < ${busyResponses} ? 409 : ${lockStatus} });
      }
      if (${requireStoppedChild} && !fs.existsSync('child-stopped')) throw new Error('Released lease before stopping Wrangler');
      return Response.json({ released: true }, { status: ${releaseStatus} });
    }
    if (${Boolean(manifestSignal)}) {
      process.kill(process.pid, ${JSON.stringify(manifestSignal ?? 'SIGINT')});
      await new Promise(resolve => setImmediate(resolve));
    }
    return Response.json(${JSON.stringify(custom)}, { status: ${apiStatus} });
  };`);
  if (localSecret !== undefined) writeFileSync(join(root, '.env'), `IMAGE_BUILD_SECRET="${localSecret}"\n`);
  const run = () => spawnSync(process.execPath, ['--import', join(root, 'fetch.mjs'), join(root, 'scripts/deploy-containers.mjs'), ...(dryRun ? ['--dry-run'] : []), ...(withoutActivity ? ['--without-activity'] : [])], { cwd: root, encoding: 'utf8', timeout: 15_000, env: { ...process.env, PATH: join(root, 'bin'), ...(secret === 'local' ? { IMAGE_BUILD_SECRET: undefined } : { IMAGE_BUILD_SECRET: secret ? 's'.repeat(32) : '' }) } });
  return { root, image, run, catalog };
}

test('deployment replaces Dockerfile with published digest and cleans up config', t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const deployed = JSON.parse(readFileSync(join(f.root, 'result.json')));
  assert.deepEqual(deployed.config.containers[0].images.terminal, { image: f.image });
  assert.ok(deployed.args.includes('--dry-run'));
  assert.equal(readdirSync(f.root).includes('locks.log'), false);
  assert.ok(deployed.config.durable_objects.bindings.some(binding => binding.name === 'ACCOUNT_ACTIVITY'));
  assert.equal(readdirSync(f.root).some(name => name.startsWith('.wrangler-containers-')), false);
  assert.ok(JSON.parse(readFileSync(join(f.root, 'wrangler.containers.jsonc'))).containers[0].images.terminal.dockerfile);
});
test('activity bootstrap omits only the activity binding and preserves the tracked config and image lease', t => {
  const f = fixture(t, { withoutActivity: true, dryRun: false });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const deployed = JSON.parse(readFileSync(join(f.root, 'result.json')));
  assert.deepEqual(deployed.config.durable_objects.bindings, [{ name: 'OTHER', class_name: 'Other' }]);
  assert.equal(deployed.args.includes('--without-activity'), false);
  assert.deepEqual(deployed.config.containers[0].images.terminal, { image: f.image });
  assert.ok(JSON.parse(readFileSync(join(f.root, 'wrangler.containers.jsonc'))).durable_objects.bindings.some(binding => binding.name === 'ACCOUNT_ACTIVITY'));
  assert.equal(readFileSync(join(f.root, 'locks.log'), 'utf8'), 'POST\nDELETE\n');
  assert.equal(readdirSync(f.root).some(name => name.startsWith('.wrangler-containers-')), false);
});
test('outdated image prevents deployment', t => {
  const f = fixture(t, { outdated: true });
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /different Dockerfile/);
  assert.equal(readdirSync(f.root).includes('result.json'), false);
});
test('deployment failure propagates and cleans up config', t => {
  const f = fixture(t, { exitCode: 7, dryRun: false });
  assert.equal(f.run().status, 7);
  assert.equal(readFileSync(join(f.root, 'locks.log'), 'utf8'), 'POST\nDELETE\n');
  assert.equal(readdirSync(f.root).some(name => name.startsWith('.wrangler-containers-')), false);
});

const id = '12345678-1234-1234-1234-123456789abc';
const key = `custom_${id.replaceAll('-', '')}`;
const image = `registry.cloudflare.com/account/mainbrella-custom-${id}@sha256:${'b'.repeat(64)}`;

test('live manifest images reach Wrangler alongside the terminal digest', t => {
  const f = fixture(t, { custom: { images: { [key]: { image } } }, dryRun: false });
  assert.equal(f.run().status, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'result.json'))).config.containers[0].images,
    { ...Object.fromEntries(Object.entries(f.catalog.images).map(([key, entry]) => [key, { image: entry.image }])), [key]: { image } });
  assert.equal(readFileSync(join(f.root, 'locks.log'), 'utf8'), 'POST\nDELETE\n');
});

test('manifest failure aborts deployment and releases the lease', t => {
  const f = fixture(t, { apiStatus: 503, dryRun: false });
  assert.equal(f.run().status, 1);
  assert.equal(readdirSync(f.root).includes('result.json'), false);
  assert.equal(readFileSync(join(f.root, 'locks.log'), 'utf8'), 'POST\nDELETE\n');
});

test('invalid registry references and missing API credentials prevent deployment', t => {
  for (const options of [{ custom: { images: { [key]: { image: image.replace('/account/', '/attacker/') } } } }, { secret: false }]) {
    const f = fixture(t, options);
    assert.equal(f.run().status, 1);
    assert.equal(readdirSync(f.root).includes('result.json'), false);
  }
});

test('local deployment reads the shared secret from ignored .env', t => {
  const f = fixture(t, { secret: 'local', localSecret: 's'.repeat(32) });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
});

test('explicit environment secret takes precedence over .env', t => {
  const f = fixture(t, { localSecret: 'different-local-secret'.repeat(3) });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
});

test('untrusted or incomplete catalog images prevent deployment', t => {
  const f = fixture(t, { invalidCatalog: true });
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid python catalog image reference/);
  assert.equal(readdirSync(f.root).includes('result.json'), false);
});

const fastLeaseClock = `
  import timers from 'node:timers/promises';
  import { syncBuiltinESMExports } from 'node:module';
  let now = Date.now();
  Date.now = () => now;
  timers.setTimeout = async (ms, value, { signal }) => { signal.throwIfAborted(); now += ms; };
  syncBuiltinESMExports();
`;

test('busy lease reports progress and waits through an abandoned 12-minute lease', t => {
  const f = fixture(t, { dryRun: false, busyResponses: 73, preload: fastLeaseClock });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /lease is busy \(720s elapsed\)/);
  assert.match(result.stdout, /lease acquired/);
  assert.match(result.stdout, /lease released/);
  assert.equal(readFileSync(join(f.root, 'locks.log'), 'utf8'), 'POST\n'.repeat(74) + 'DELETE\n');
  assert.equal(new Set(readFileSync(join(f.root, 'lock-tokens.log'), 'utf8').trim().split('\n')).size, 1);
});

test('busy and unavailable leases abort without deploying or releasing a competitor lease', t => {
  for (const options of [{ busyResponses: 100, expected: /still busy after 13 minutes/ }, { lockStatus: 503, expected: /lease unavailable \(HTTP 503\)/ }]) {
    const f = fixture(t, { dryRun: false, preload: fastLeaseClock, ...options });
    const result = f.run();
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, options.expected);
    assert.equal(readdirSync(f.root).includes('result.json'), false);
    assert.doesNotMatch(readFileSync(join(f.root, 'locks.log'), 'utf8'), /DELETE/);
  }
});

test('ambiguous acquisition failure attempts cleanup with only its own lease token', t => {
  const f = fixture(t, { dryRun: false, lockError: true });
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Connection lost during lease acquisition/);
  assert.equal(readFileSync(join(f.root, 'locks.log'), 'utf8'), 'POST\nDELETE\n');
  assert.equal(new Set(readFileSync(join(f.root, 'lock-tokens.log'), 'utf8').trim().split('\n')).size, 1);
  assert.equal(readdirSync(f.root).includes('result.json'), false);
});

test('Ctrl-C during lease wait exits promptly without releasing another deployment lease', t => {
  const f = fixture(t, { dryRun: false, busyResponses: 1, preload: `
    import timers from 'node:timers/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const sleep = timers.setTimeout;
    timers.setTimeout = (...args) => { process.kill(process.pid, 'SIGINT'); return sleep(...args); };
    syncBuiltinESMExports();
  ` });
  const result = f.run();
  assert.equal(result.status, 130, result.stderr);
  assert.equal(readFileSync(join(f.root, 'locks.log'), 'utf8'), 'POST\n');
  assert.equal(readdirSync(f.root).includes('result.json'), false);
});

test('cancellation while loading the manifest releases the lease without launching Wrangler', t => {
  const f = fixture(t, { dryRun: false, manifestSignal: 'SIGINT' });
  const result = f.run();
  assert.equal(result.status, 130, result.stderr);
  assert.equal(readFileSync(join(f.root, 'locks.log'), 'utf8'), 'POST\nDELETE\n');
  assert.equal(readdirSync(f.root).includes('result.json'), false);
});

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`${signal} stops Wrangler and its child before releasing the lease`, { skip: process.platform === 'win32' }, t => {
    const f = fixture(t, { dryRun: false, requireStoppedChild: true, wranglerScript: `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(`
        const fs = require('node:fs');
        process.on('SIGTERM', () => { fs.writeFileSync('child-stopped', 'yes'); process.exit(0); });
        process.send('ready');
        setInterval(() => {}, 1000);
      `)}], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      process.on('SIGTERM', () => {});
      child.on('exit', () => process.exit(0));
      child.on('message', () => process.kill(process.ppid, ${JSON.stringify(signal)}));
    ` });
    const result = f.run();
    assert.equal(result.status, code, result.stderr);
    assert.match(result.stdout, /lease released/);
    assert.equal(readFileSync(join(f.root, 'child-stopped'), 'utf8'), 'yes');
    assert.equal(readFileSync(join(f.root, 'locks.log'), 'utf8'), 'POST\nDELETE\n');
    assert.equal(readdirSync(f.root).some(name => name.startsWith('.wrangler-containers-')), false);
  });
}

test('Wrangler timeout kills the deployment, reports the stage, and releases the lease', t => {
  const f = fixture(t, { dryRun: false, wranglerScript: 'setInterval(() => {}, 1000);', preload: `
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => originalSetTimeout(fn, ms === 600_000 ? 500 : ms, ...args);
  ` });
  const result = f.run();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /timed out after 10 minutes/);
  assert.equal(readFileSync(join(f.root, 'locks.log'), 'utf8'), 'POST\nDELETE\n');
  assert.equal(readdirSync(f.root).some(name => name.startsWith('.wrangler-containers-')), false);
});

test('lease release failure fails deployment and explains expiry', t => {
  const f = fixture(t, { dryRun: false, releaseStatus: 503 });
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Could not release image deployment lease.*expire within 12 minutes/);
  assert.equal(readdirSync(f.root).some(name => name.startsWith('.wrangler-containers-')), false);
});
