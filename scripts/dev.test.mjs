import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { serialize } from 'node:v8';
import { DatabaseSync } from 'node:sqlite';

async function run(t, { signal, fail = false, allImages = false, portArgs = [], expectedPort = '8787' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mainbrella-dev-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['scripts', 'containers', 'bin', 'node_modules/.bin', 'state/v3/do/mainbrella-containers-UserContainer']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  copyFileSync(new URL('../containers/image-catalog.js', import.meta.url), join(root, 'containers/image-catalog.js'));
  for (const file of ['dev.mjs', 'local-proxy-cleanup.mjs']) copyFileSync(new URL(file, import.meta.url), join(root, 'scripts', file));
  writeFileSync(join(root, 'wrangler.jsonc'), JSON.stringify({ name: 'mainbrella-api', routes: [{ pattern: 'api.mainbrella.com' }] }));
  writeFileSync(join(root, 'wrangler.containers.jsonc'), JSON.stringify({ name: 'mainbrella-containers', containers: [
    { class_name: 'UserContainer', images: { terminal: { dockerfile: './containers/Dockerfile' } } },
  ] }));
  const sourceConfigs = ['wrangler.jsonc', 'wrangler.containers.jsonc'].map(file => readFileSync(join(root, file), 'utf8'));
  const hash = 'a'.repeat(64);
  const proxy = { ID: 'session-proxy', Names: `workerd-mainbrella-containers-UserContainer-${hash}-proxy`, Image: 'cloudflare/proxy-everything:test' };
  const db = new DatabaseSync(join(root, 'state/v3/do/mainbrella-containers-UserContainer', `${hash}.sqlite`));
  db.exec('CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB)');
  db.prepare('INSERT INTO _cf_KV VALUES (?, ?)').run('builderMachine', serialize({ createdAt: 1 }));
  db.close();
  writeFileSync(join(root, 'docker-state.json'), '[]');
  writeFileSync(join(root, 'bin/docker'), `#!${process.execPath}
import fs from 'node:fs';
const rows = JSON.parse(fs.readFileSync('docker-state.json'));
if (process.argv[2] === 'ps') console.log(rows.map(c => JSON.stringify(c)).join(String.fromCharCode(10)));
else if (process.argv[2] === 'rm') fs.writeFileSync('docker-state.json', JSON.stringify(rows.filter(c => c.ID !== process.argv[4])));
else process.exit(1);
`, { mode: 0o755 });
  writeFileSync(join(root, 'node_modules/.bin/wrangler'), `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
const configs = args.flatMap((v, i) => v === '--config' ? [JSON.parse(fs.readFileSync(args[i+1]))] : []);
fs.writeFileSync('configs.json', JSON.stringify(configs));
fs.writeFileSync('args.json', JSON.stringify(args));
fs.writeFileSync('docker-state.json', JSON.stringify([${JSON.stringify(proxy)}]));
console.log('fixture-ready');
${signal ? "process.on('SIGINT', () => process.exit(0)); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);" : `process.exit(${fail ? 7 : 0});`}
`, { mode: 0o755 });
  const child = spawn(process.execPath, ['scripts/dev.mjs', ...(allImages ? ['--all-images'] : []), ...portArgs, '--persist-to', 'state'], {
    cwd: root, env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let output = '';
  child.stdout.on('data', chunk => {
    output += chunk;
    if (signal && output.includes('fixture-ready')) child.kill(signal);
  });
  child.stderr.on('data', chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  assert.equal(code, fail ? 7 : 0, output);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'docker-state.json'))), [], output);
  assert.equal(readdirSync(root).some(path => path.startsWith('.wrangler-local-')), false);
  const configs = JSON.parse(readFileSync(join(root, 'configs.json')));
  assert.equal(configs.every(config => config.vars.LOCAL_DEV === 'true' && !config.routes), true);
  const apiConfig = configs.find(config => config.name === 'mainbrella-api');
  const containerConfig = configs.find(config => config.name === 'mainbrella-containers');
  assert.equal(apiConfig.vars.PROJECT_HOSTING_ENABLED, 'true');
  assert.equal(apiConfig.vars.PROJECT_DOMAIN_PROVIDER, 'local');
  assert.equal(apiConfig.vars.LOCAL_PREVIEW_PORT, expectedPort);
  assert.equal(containerConfig.vars.PROJECT_HOSTING_ENABLED, undefined);
  assert.equal(containerConfig.vars.PROJECT_DOMAIN_PROVIDER, undefined);
  assert.equal(containerConfig.vars.LOCAL_PREVIEW_PORT, undefined);
  assert.deepEqual(['wrangler.jsonc', 'wrangler.containers.jsonc'].map(file => readFileSync(join(root, file), 'utf8')), sourceConfigs);
  const images = configs[1].containers[0].images;
  assert.deepEqual(Object.keys(images), allImages ? ['terminal', 'python', 'rust', 'go', 'devops'] : ['terminal']);
  if (allImages) {
    for (const id of ['python', 'rust', 'go', 'devops']) assert.equal(images[id].dockerfile, `./containers/catalog/${id}.Dockerfile`);
  }
  assert.equal(JSON.parse(readFileSync(join(root, 'args.json'))).includes('--all-images'), false);
  assert.match(output, /Cleaned up 1 local container proxy/);
}

test('dev launcher cleans proxies and temporary configs on normal exit and Wrangler failure', { timeout: 10_000 }, async t => {
  await run(t);
  await run(t, { fail: true });
});
test('dev launcher forwards Ctrl+C and SIGTERM, then waits for proxy cleanup', { timeout: 10_000 }, async t => {
  await run(t, { signal: 'SIGINT' });
  await run(t, { signal: 'SIGTERM' });
});
test('dev launcher enables every catalog image on request', { timeout: 10_000 }, async t => {
  await run(t, { allImages: true });
});
test('dev launcher passes the selected port to local project aliases in both CLI forms', { timeout: 10_000 }, async t => {
  await run(t, { portArgs: ['--port=8899'], expectedPort: '8899' });
  await run(t, { portArgs: ['--port', '8899'], expectedPort: '8899' });
});
