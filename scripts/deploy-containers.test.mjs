import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

function fixture(t, { outdated = false, exitCode = 0, custom = { images: {} }, apiStatus = 200, dryRun = true, secret = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'terminal-deploy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['scripts', 'containers', 'bin', 'node_modules/wrangler/bin']) mkdirSync(join(root, dir), { recursive: true });
  for (const file of ['deploy-containers.mjs', 'terminal-image.mjs', 'custom-images.mjs']) copyFileSync(new URL(file, import.meta.url), join(root, 'scripts', file));
  const dockerfile = 'FROM test\n';
  writeFileSync(join(root, 'containers/Dockerfile'), dockerfile);
  writeFileSync(join(root, 'wrangler.containers.jsonc'), JSON.stringify({ account_id: 'account', main: 'containers/user-container.js', containers: [{ images: { terminal: { dockerfile: './containers/Dockerfile' } } }] }));
  const image = `registry.cloudflare.com/account/mainbrella-terminal@sha256:${'a'.repeat(64)}`;
  const manifest = { image, dockerfileHash: outdated ? 'old' : createHash('sha256').update(dockerfile).digest('hex') };
  writeFileSync(join(root, 'bin/gh'), `#!${process.execPath}\nconsole.log(process.argv.includes('-H') ? ${JSON.stringify(JSON.stringify(manifest))} : '{"assets":[{"id":1,"name":"terminal-image.json"}]}');\n`, { mode: 0o755 });
  writeFileSync(join(root, 'node_modules/wrangler/bin/wrangler.js'), `const fs = require('node:fs'); const args = process.argv.slice(2); fs.writeFileSync('result.json', JSON.stringify({args, config: JSON.parse(fs.readFileSync(args[args.indexOf('--config')+1]))})); process.exit(${exitCode});`);
  writeFileSync(join(root, 'fetch.mjs'), `globalThis.fetch = async (url, options) => {
    if (url.endsWith('/deployment-lock')) {
      const fs = await import('node:fs'); fs.appendFileSync('locks.log', options.method + '\\n');
      return Response.json({ acquired: true });
    }
    return Response.json(${JSON.stringify(custom)}, { status: ${apiStatus} });
  };`);
  const run = () => spawnSync(process.execPath, ['--import', join(root, 'fetch.mjs'), join(root, 'scripts/deploy-containers.mjs'), ...(dryRun ? ['--dry-run'] : [])], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: join(root, 'bin'), IMAGE_BUILD_SECRET: secret ? 's'.repeat(32) : '' } });
  return { root, image, run };
}

test('deployment replaces Dockerfile with published digest and cleans up config', t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const deployed = JSON.parse(readFileSync(join(f.root, 'result.json')));
  assert.deepEqual(deployed.config.containers[0].images.terminal, { image: f.image });
  assert.ok(deployed.args.includes('--dry-run'));
  assert.equal(readdirSync(f.root).some(name => name.startsWith('.wrangler-containers-')), false);
  assert.ok(JSON.parse(readFileSync(join(f.root, 'wrangler.containers.jsonc'))).containers[0].images.terminal.dockerfile);
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
    { terminal: { image: f.image }, [key]: { image } });
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
