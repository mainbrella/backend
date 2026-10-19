import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./resolve-tool.mjs', import.meta.url));

async function install(root, packageName, version) {
  const directory = join(root, 'node_modules', packageName);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: packageName, version }));
  await writeFile(join(directory, 'tool.js'), version);
}

test('tool resolution supports parent and backend-local packages, preferring the backend install', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'resolve-tool-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const appScripts = join(fixture, 'backend/scripts');
  await mkdir(appScripts, { recursive: true });
  await copyFile(helper, join(appScripts, 'resolve-tool.mjs'));
  const appRoot = join(fixture, 'backend');
  await install(fixture, 'sample-tool', 'hoisted');
  await install(appRoot, 'sample-tool', 'local');
  const resolver = await import(`${new URL(`file://${join(appScripts, 'resolve-tool.mjs')}`).href}?fixture=${Date.now()}`);
  assert.equal(await readFile(resolver.resolveTool('sample-tool', 'tool.js'), 'utf8'), 'local');

  const secondScripts = join(fixture, 'other/scripts');
  await mkdir(secondScripts, { recursive: true });
  await copyFile(helper, join(secondScripts, 'resolve-tool.mjs'));
  const hoistedResolver = await import(`${new URL(`file://${join(secondScripts, 'resolve-tool.mjs')}`).href}?fixture=${Date.now()}`);
  assert.equal(await readFile(hoistedResolver.resolveTool('sample-tool', 'tool.js'), 'utf8'), 'hoisted');
});
