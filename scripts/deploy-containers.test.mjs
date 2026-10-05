import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

function fixture(t, { outdated = false, exitCode = 0 } = {}) {
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
  const run = () => spawnSync(process.execPath, [join(root, 'scripts/deploy-containers.mjs'), '--dry-run'], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: join(root, 'bin') } });
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
  const f = fixture(t, { exitCode: 7 });
  assert.equal(f.run().status, 7);
  assert.equal(readdirSync(f.root).some(name => name.startsWith('.wrangler-containers-')), false);
});
