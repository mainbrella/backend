import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function wrangler(args) {
  try {
    return JSON.parse(execFileSync(process.execPath,
      [join(root, 'node_modules/wrangler/bin/wrangler.js'), ...args],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }));
  } catch {
    // Wrangler errors may include environment/configuration data. Do not echo them.
    throw new Error('Cannot read deployment metadata. Check Wrangler authentication and target configuration.');
  }
}

export async function preflight({ api, containers, migrations, env, run = wrangler, request = fetch }) {
  const binding = api.durable_objects?.bindings?.find(item => item.name === 'USER_CONTAINER');
  if (binding?.script_name !== containers.name || binding.class_name !== 'UserContainer') {
    throw new Error('API USER_CONTAINER binding must target the private container Worker.');
  }
  if (!containers.account_id || api.account_id !== containers.account_id) throw new Error('Worker accounts must be pinned and match.');
  const database = api.d1_databases?.find(item => item.binding === 'DB');
  if (!database || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(database.migrations_table)) {
    throw new Error('Missing DB binding or invalid migration table.');
  }
  const origin = api.routes?.find(item => item.custom_domain)?.pattern;
  if (origin !== 'api.mainbrella.com') throw new Error('Preflight requires the production API domain.');
  if (!env.IMAGE_BUILD_SECRET || env.IMAGE_BUILD_SECRET.length < 32) {
    throw new Error('Set IMAGE_BUILD_SECRET in backend/.env or the shell before deployment.');
  }
  if (env.MONITORING_SECRET && env.MONITORING_SECRET === env.IMAGE_BUILD_SECRET) {
    throw new Error('MONITORING_SECRET must be separate from IMAGE_BUILD_SECRET.');
  }
  const configArgs = ['--config', 'wrangler.jsonc'];
  const secrets = run(['secret', 'list', ...configArgs, '--format', 'json']);
  for (const name of ['IMAGE_BUILD_SECRET', 'MONITORING_SECRET']) {
    if (!Array.isArray(secrets) || !secrets.some(item => item.name === name && item.type === 'secret_text')) {
      throw new Error(`Missing deployed ${name}. Configure it with Wrangler before rollout.`);
    }
  }
  const results = run(['d1', 'execute', database.binding, ...configArgs, '--remote', '--json', '--command',
    `SELECT name FROM ${database.migrations_table}; SELECT name FROM sqlite_master WHERE type = 'table';`]);
  if (!Array.isArray(results) || results.length !== 2 || results.some(item => item.success !== true || !Array.isArray(item.results))) {
    throw new Error('Cannot verify remote database migrations.');
  }
  const applied = new Set(results[0].results.map(item => item.name));
  const missing = migrations.filter(name => !applied.has(name));
  if (missing.length) throw new Error(`Apply remote migrations before deployment: ${missing.join(', ')}`);
  const tables = new Set(results[1].results.map(item => item.name));
  for (const table of ['container_image_deployment_lock', 'status_observations', 'status_incidents']) {
    if (!tables.has(table)) throw new Error(`Remote database is missing ${table}; reconcile its migrations.`);
  }
  async function get(path, headers = {}) {
    try {
      return await request(`https://${origin}${path}`, {
        method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new Error(`Cannot reach deployed ${path}; no Workers were deployed.`);
    }
  }
  const response = await get('/capabilities');
  let capabilities;
  try { capabilities = response.ok ? await response.json() : null; } catch {}
  // This is the known entitlement-aware predecessor. apiVersion alone is insufficient:
  // both the original managed API and the size-aware API use the same version string.
  if (capabilities?.apiVersion !== '2026-10-05'
    || capabilities.authentication?.apiKeys !== true
    || capabilities.containers?.generationRequired !== true
    || capabilities.containers?.idempotentCreate !== true
    || capabilities.execution?.background !== true
    || capabilities.files?.binary !== true) {
    throw new Error('Deployed API is not a known entitlement/generation-compatible predecessor. Follow docs/deployment.md bootstrap guidance; do not reverse the deployment order.');
  }
  // The image handler authenticates before rejecting GET. This proves route/secret
  // compatibility without acquiring a lease or expiring builds via GET /manifest.
  const lease = await get('/internal/image-builds/deployment-lock', { Authorization: `Bearer ${env.IMAGE_BUILD_SECRET}` });
  let rejection;
  try { rejection = await lease.json(); } catch {}
  if (lease.status !== 405 || rejection?.error !== 'method_not_allowed') {
    throw new Error('Deployed image deployment-lock endpoint or IMAGE_BUILD_SECRET is incompatible.');
  }
  return { predecessorResources: capabilities.resources };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length > 2) throw new Error('Preflight takes no arguments; it targets the checked-in production configuration.');
    const api = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'));
    const containers = JSON.parse(readFileSync(join(root, 'wrangler.containers.jsonc'), 'utf8'));
    let local = {};
    try { local = parseEnv(readFileSync(join(root, '.env'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const env = { ...local, ...process.env };
    if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_ACCOUNT_ID !== containers.account_id) {
      throw new Error('CLOUDFLARE_ACCOUNT_ID differs from the private container Worker account.');
    }
    process.env.CLOUDFLARE_ACCOUNT_ID = containers.account_id;
    await preflight({ api, containers, env,
      migrations: readdirSync(join(root, api.d1_databases.find(item => item.binding === 'DB').migrations_dir)).filter(name => name.endsWith('.sql')).sort() });
    console.log('Deployment preflight passed. Deploy containers, then API. This does not verify runtime health or consume a start.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
