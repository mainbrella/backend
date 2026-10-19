import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STAGING, assertStagingConfig } from './staging-config.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = ['api', 'admin', 'marketing', 'containers', 'previews', 'site', 'builder', 'raindrop'];
const BACKEND = new Set(TARGETS.slice(0, 5));
const BOOTSTRAP = 'Run stg:bootstrap to install the missing staging dependencies.';
const VERSION_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function check(value, message) { if (!value) throw new Error(message); }

function deployedBinding(version, name, type) {
  return version.bindings.find(item => item.name === name && item.type === type);
}

function requireExport(version, worker, name) {
  const item = version.script_runtime?.exports?.[name];
  check(item?.type === 'durable-object' && item.storage === 'sqlite' && item.state !== 'deleted',
    `Active ${worker} does not export ${name}. ${BOOTSTRAP}`);
}

function requireBinding(version, worker, name, type, predicate) {
  check(predicate(deployedBinding(version, name, type)),
    `Active ${worker} has an incompatible ${name} binding. ${BOOTSTRAP}`);
}

function requireDatabase(version, worker, name, databaseId) {
  requireBinding(version, worker, name, 'd1', item => (item?.database_id ?? item?.id) === databaseId);
}

function validateDeployedBindings(version, worker, resources) {
  for (const item of version.bindings) {
    if (item.type === 'service') check(typeof item.service === 'string' && item.service.endsWith('-stg'),
      `Active ${worker} binds a non-staging service.`);
    if (item.type === 'durable_object_namespace' && item.script_name) {
      check(item.script_name.endsWith('-stg'), `Active ${worker} binds a non-staging Durable Object.`);
    }
    if (item.type === 'd1') {
      check([resources.databaseId, resources.previewDatabaseId].includes(item.database_id ?? item.id),
        `Active ${worker} binds a non-staging D1 database.`);
    }
    if (item.type === 'r2_bucket') {
      check((item.bucket_name ?? item.bucket) === STAGING.bucketName,
        `Active ${worker} binds a non-staging R2 bucket.`);
    }
  }
}

async function activeVersions(worker, token, request, resources) {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${STAGING.accountId}/workers/scripts/${worker}`;
  async function get(path) {
    let response, payload;
    try {
      response = await request(`${endpoint}${path}`, {
        method: 'GET', headers: { Authorization: `Bearer ${token}` },
        redirect: 'error', signal: AbortSignal.timeout(15_000),
      });
      payload = await response.json();
    } catch {
      throw new Error(`Cannot read active ${worker} metadata. Check connectivity and Cloudflare token access. ${BOOTSTRAP}`);
    }
    check(response.ok && payload?.success === true && payload.result,
      `Cannot read active ${worker} metadata (HTTP ${response.status}). ${BOOTSTRAP}`);
    return payload.result;
  }
  const deployments = (await get('/deployments')).deployments;
  const active = Array.isArray(deployments) && deployments[0]?.versions;
  check(Array.isArray(active) && active.length > 0, `No active ${worker} deployment. ${BOOTSTRAP}`);
  const versions = [];
  for (const entry of active) {
    check(VERSION_ID.test(entry.version_id ?? '') && Number(entry.percentage) > 0,
      `Invalid active ${worker} deployment metadata.`);
    const version = (await get(`/versions/${entry.version_id}`)).resources;
    check(Array.isArray(version?.bindings), `Active ${worker} has no binding metadata.`);
    validateDeployedBindings(version, worker, resources);
    versions.push(version);
  }
  return versions;
}

async function migrationLedger(binding, configuration, resources, directory, run) {
  const database = configuration.d1_databases.find(item => item.binding === binding);
  const table = database.migrations_table ?? 'd1_migrations';
  const migrationDirectory = join(directory, '.', database.migrations_dir);
  const expected = readdirSync(migrationDirectory).filter(name => name.endsWith('.sql')).sort();
  let result;
  try {
    result = await run('api', ['d1', 'execute', binding, '--remote', '--json', '--command', `SELECT name FROM ${table};`]);
  } catch {
    throw new Error(`Cannot read staging ${binding} migration ledger. Check Wrangler access and apply stage migrations.`);
  }
  check(Array.isArray(result) && result.length === 1 && result[0].success === true && Array.isArray(result[0].results),
    `Cannot verify staging ${binding} migration ledger.`);
  const applied = new Set(result[0].results.map(row => row.name));
  const missing = expected.filter(name => !applied.has(name));
  check(!missing.length, `Apply staging ${binding} migrations before deployment: ${missing.join(', ')}`);
  check(database.database_id === (binding === 'DB' ? resources.databaseId : resources.previewDatabaseId),
    `Staging ${binding} points to an unexpected database.`);
}

async function frontendHealth(target, request) {
  let response, body;
  try {
    response = await request(`${STAGING.apiOrigin}/health`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    body = await response.json();
  } catch {
    throw new Error(`Staging API health is unavailable for ${target}. ${BOOTSTRAP}`);
  }
  check(response.ok && body?.ok === true, `Staging API health is unavailable for ${target}. ${BOOTSTRAP}`);
  const origin = target === 'raindrop' ? STAGING.adminOrigin : STAGING.webOrigin;
  let cors;
  try {
    cors = await request(`${STAGING.apiOrigin}/auth/me`, {
      method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' },
      redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(`Staging API CORS is unavailable for ${origin}. ${BOOTSTRAP}`);
  }
  check(cors.status === 204 && cors.headers.get('access-control-allow-origin') === origin
    && cors.headers.get('access-control-allow-credentials') === 'true',
  `Staging API CORS does not allow ${origin}. ${BOOTSTRAP}`);
}

export async function preflightStaging(target, {
  configurations, resources, env = process.env, run, request = fetch, directory = root,
} = {}) {
  check(TARGETS.includes(target), `Choose a staging target: ${TARGETS.join(', ')}.`);
  check(configurations && typeof configurations === 'object', 'Provide all staging configurations.');
  const required = new Set([...BACKEND, target]);
  for (const name of TARGETS.filter(name => required.has(name) || configurations[name])) {
    check(configurations[name], `Missing ${name} staging configuration.`);
    assertStagingConfig(name, configurations[name], {
      resources, directory,
      ...(name === 'api' ? { googleClientId: configurations.api.vars?.GOOGLE_CLIENT_ID } : {}),
    });
  }
  check(!env.CLOUDFLARE_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID === STAGING.accountId,
    'CLOUDFLARE_ACCOUNT_ID differs from the staging account.');
  check(!env.CF_ACCOUNT_ID || env.CF_ACCOUNT_ID === STAGING.accountId,
    'CF_ACCOUNT_ID differs from the staging account.');

  if (!BACKEND.has(target)) {
    await frontendHealth(target, request);
    return { configuration: true, backendHealth: true, cors: true };
  }

  check(typeof run === 'function', 'Provide a staging-scoped Wrangler read runner.');
  check(typeof env.CLOUDFLARE_API_TOKEN === 'string' && env.CLOUDFLARE_API_TOKEN.trim(),
    'Set CLOUDFLARE_API_TOKEN with Workers read access for staging preflight.');
  await migrationLedger('DB', configurations.api, resources, directory, run);
  if (target === 'api' || target === 'previews') {
    await migrationLedger('PREVIEW_ROUTES', configurations.api, resources, directory, run);
  }

  const names = target === 'api' ? ['api', 'containers', 'admin', 'marketing']
    : target === 'previews' ? ['api', 'containers'] : ['api'];
  const active = Object.fromEntries(await Promise.all(names.map(async name => [
    name, await activeVersions(configurations[name].name, env.CLOUDFLARE_API_TOKEN, request, resources),
  ])));
  const api = configurations.api;
  for (const version of active.api) {
    requireBinding(version, 'API', 'DEPLOYMENT_ENVIRONMENT', 'plain_text', item => item?.text === 'staging');
    requireExport(version, 'API', 'AccountActivity');
    requireExport(version, 'API', 'ContainerAccount');
  }
  if (target === 'api' || target === 'previews') {
    for (const version of active.containers) {
      requireExport(version, 'containers', 'UserContainer');
      for (const [name, className] of [['ACCOUNT_ACTIVITY', 'AccountActivity'], ['CONTAINER_ACCOUNT', 'ContainerAccount']]) {
        requireBinding(version, 'containers', name, 'durable_object_namespace',
          item => item?.script_name === api.name && item.class_name === className);
      }
    }
  }
  if (target === 'api') {
    for (const version of active.admin) {
      requireDatabase(version, 'admin', 'DB', resources.databaseId);
      requireBinding(version, 'admin', 'CONTAINER_ACCOUNT', 'durable_object_namespace',
        item => item?.script_name === api.name && item.class_name === 'ContainerAccount');
    }
    for (const version of active.marketing) requireDatabase(version, 'marketing', 'DB', resources.databaseId);
  }
  if (target === 'previews') {
    for (const version of active.api) {
      requireBinding(version, 'API', 'USER_CONTAINER', 'durable_object_namespace',
        item => item?.script_name === configurations.containers.name && item.class_name === 'UserContainer');
    }
  }
  return { configuration: true, remoteMigrations: true, activeBindings: true };
}
