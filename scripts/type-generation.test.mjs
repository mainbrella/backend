import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('configured type generation preserves bindings without depending on local secrets', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'mainbrella-types-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const { scripts } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  await writeFile(join(fixture, 'package.json'), JSON.stringify({ private: true, scripts: { 'generate-types': scripts['generate-types'] } }));
  await mkdir(join(fixture, 'scripts'));
  await mkdir(join(fixture, 'worker'));
  await copyFile(join(root, 'scripts/type-generation.env'), join(fixture, 'scripts/type-generation.env'));
  await copyFile(join(root, 'worker/env.d.ts'), join(fixture, 'worker/env.d.ts'));
  await symlink(join(root, 'node_modules'), join(fixture, 'node_modules'), 'dir');
  await writeFile(join(fixture, 'worker/index.ts'), 'export default { fetch() { return new Response("ok"); } };\n');
  await writeFile(join(fixture, 'wrangler.jsonc'), JSON.stringify({
    name: 'mainbrella-type-fixture', main: 'worker/index.ts', compatibility_date: '2026-09-18',
    d1_databases: [{ binding: 'DB', database_name: 'fixture', database_id: '00000000-0000-0000-0000-000000000001' }],
  }));
  const env = { ...process.env, CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false', WRANGLER_SEND_METRICS: 'false' };
  const generate = async () => {
    execFileSync('npm', ['run', 'generate-types', '--', '--include-runtime=false'], { cwd: fixture, env, stdio: 'pipe', timeout: 30_000 });
    return readFile(join(fixture, 'cloudflare-configuration.d.ts'), 'utf8');
  };
  const clean = await generate();
  assert.match(clean, /DB: D1Database;/);
  assert.doesNotMatch(clean, /STRIPE_SECRET_KEY/);
  await writeFile(join(fixture, '.env'), 'STRIPE_SECRET_KEY=fixture-only\nLOCAL_ENV_SENTINEL=fixture-only\n');
  assert.equal(await generate(), clean, '.env must not change deployment binding types');
  await writeFile(join(fixture, '.dev.vars'), 'STRIPE_SECRET_KEY=fixture-only\nLOCAL_DEV_VARS_SENTINEL=fixture-only\n');
  assert.equal(await generate(), clean, '.dev.vars must not change deployment binding types');

  // Compile the application declaration against the clean generated interface:
  // an integration can be absent, while configured bindings remain available.
  await writeFile(join(fixture, 'bindings.d.ts'), 'interface D1Database {}\n');
  await writeFile(join(fixture, 'check.ts'), 'const optional: Env["STRIPE_SECRET_KEY"] = undefined;\nconst binding: D1Database = ({} as Env).DB;\n');
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--strict', '--noEmit', '--skipLibCheck',
    'check.ts', 'bindings.d.ts', 'worker/env.d.ts', 'cloudflare-configuration.d.ts'], { cwd: fixture, stdio: 'pipe', timeout: 30_000 });
});
