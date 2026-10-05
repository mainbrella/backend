import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { IMAGE_CATALOG } from '../containers/image-catalog.js';
import { catalogSourceHash, validateCatalogImages } from './catalog-images.mjs';

const account = 'a'.repeat(32);
function fixture(t, { published = false, changed = false, schedule = false, smokeFailure = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'catalog-publish-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['scripts', 'containers/catalog', 'bin', 'node_modules/wrangler/bin']) mkdirSync(join(root, dir), { recursive: true });
  for (const file of ['publish-catalog-images.mjs', 'catalog-images.mjs']) copyFileSync(new URL(file, import.meta.url), join(root, 'scripts', file));
  copyFileSync(new URL('../containers/image-catalog.js', import.meta.url), join(root, 'containers/image-catalog.js'));
  const manifest = { images: {} };
  for (const entry of IMAGE_CATALOG) {
    writeFileSync(join(root, entry.dockerfile), 'FROM test\n');
    manifest.images[entry.key] = { image: `registry.cloudflare.com/${account}/${entry.repository}@sha256:${'b'.repeat(64)}`, dockerfileHash: catalogSourceHash(root, entry) };
  }
  if (changed) writeFileSync(join(root, 'containers/catalog/python.Dockerfile'), 'FROM changed\n');
  const release = published ? { assets: [{ name: 'catalog-images.json', id: 1 }] } : { assets: [] };
  writeFileSync(join(root, 'bin/gh'), `#!${process.execPath}\nconsole.log(process.argv.includes('-H') ? ${JSON.stringify(JSON.stringify(manifest))} : ${JSON.stringify(JSON.stringify(release))});\n`, { mode: 0o755 });
  writeFileSync(join(root, 'bin/docker'), `#!${process.execPath}
const fs = require('node:fs'); const args = process.argv.slice(2);
fs.appendFileSync('events.jsonl', JSON.stringify({ command: args[0], args }) + '\\n');
if (args[0] === 'run' && ${smokeFailure}) process.exit(2);
if (args[0] === 'manifest') console.log(JSON.stringify({ Descriptor: { digest: 'sha256:' + 'c'.repeat(64) } }));
`, { mode: 0o755 });
  writeFileSync(join(root, 'node_modules/wrangler/bin/wrangler.js'), `require('node:fs').appendFileSync('events.jsonl', JSON.stringify({ command: 'push' }) + '\\n');`);
  const result = spawnSync(process.execPath, [join(root, 'scripts/publish-catalog-images.mjs')], { cwd: root, encoding: 'utf8', env: { ...process.env,
    PATH: join(root, 'bin'), CLOUDFLARE_ACCOUNT_ID: account, GITHUB_RUN_ID: '123', GITHUB_EVENT_NAME: schedule ? 'schedule' : 'push', REBUILD_IMAGES: 'false' } });
  const events = existsSync(join(root, 'events.jsonl')) ? readFileSync(join(root, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { root, result, events, manifest };
}

test('initial catalog builds, checks, and pushes every image before recording immutable manifests', t => {
  const f = fixture(t);
  assert.equal(f.result.status, 0, f.result.stderr);
  for (const command of ['build', 'run', 'push']) assert.equal(f.events.filter(event => event.command === command).length, IMAGE_CATALOG.length);
  for (const event of f.events.filter(event => event.command === 'build')) assert.ok(event.args.includes('linux/amd64'));
  for (const event of f.events.filter(event => event.command === 'run')) { assert.ok(event.args.includes('none')); assert.match(event.args.at(-1), /tmux has-session/); }
  const manifest = JSON.parse(readFileSync(join(f.root, 'catalog-images.json')));
  assert.equal(Object.keys(validateCatalogImages(manifest, account, f.root)).length, IMAGE_CATALOG.length);
  assert.equal(JSON.parse(readFileSync(join(f.root, 'terminal-image.json'))).image, manifest.images.terminal.image);
});

test('unchanged catalog reuses all published images without building', t => {
  const f = fixture(t, { published: true });
  assert.equal(f.result.status, 0, f.result.stderr);
  assert.equal(f.events.length, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'catalog-images.json'))), f.manifest);
});

test('only a changed definition rebuilds on a push', t => {
  const f = fixture(t, { published: true, changed: true });
  assert.equal(f.result.status, 0, f.result.stderr);
  const builds = f.events.filter(event => event.command === 'build');
  assert.equal(builds.length, 1);
  assert.ok(builds[0].args.includes('containers/catalog/python.Dockerfile'));
});

test('weekly maintenance refreshes unchanged upstream images', t => {
  const f = fixture(t, { published: true, schedule: true });
  assert.equal(f.result.status, 0, f.result.stderr);
  assert.equal(f.events.filter(event => event.command === 'build').length, IMAGE_CATALOG.length);
});

test('a failed compatibility check prevents publication of new manifests', t => {
  const f = fixture(t, { smokeFailure: true });
  assert.notEqual(f.result.status, 0);
  assert.equal(f.events.some(event => event.command === 'push'), false);
  assert.equal(existsSync(join(f.root, 'catalog-images.json')), false);
  assert.equal(existsSync(join(f.root, 'terminal-image.json')), false);
});
