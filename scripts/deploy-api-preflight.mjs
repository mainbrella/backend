import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serviceConfiguration, wrangler } from './deploy-services-preflight.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bootstrap = 'Use the coordinated deploy:bootstrap-activity sequence in docs/deployment.md; API-only deployment cannot provision its missing runtime dependencies.';
function requireCheck(value, message) { if (!value) throw new Error(message); }

export function apiConfiguration({ api, containers, admin, marketing }) {
  requireCheck(api.name === 'mainbrella-api' && api.main === 'worker/index.ts'
    && /^[a-f0-9]{32}$/.test(api.account_id ?? '')
    && api.routes?.length === 1 && api.routes[0].custom_domain === true
    && api.routes[0].pattern === 'api.mainbrella.com', 'API name, entry point, account, or production domain differs from the selected target.');
  requireCheck(containers.name === 'mainbrella-containers' && containers.account_id === api.account_id
    && containers.workers_dev === false && containers.preview_urls === false
    && !containers.routes?.length, 'Container Worker must be private and in the pinned API account.');
  const binding = api.durable_objects?.bindings?.filter(item => item.name === 'USER_CONTAINER');
  requireCheck(binding?.length === 1 && binding[0].class_name === 'UserContainer'
    && binding[0].script_name === containers.name, 'API USER_CONTAINER must bind the configured private runtime.');
  for (const name of ['AccountActivity', 'ContainerAccount']) {
    requireCheck(api.exports?.[name]?.type === 'durable-object'
      && api.exports[name].storage === 'sqlite', `API must export ${name} as a SQLite Durable Object.`);
    requireCheck(containers.durable_objects?.bindings?.some(item => item.class_name === name
      && item.script_name === api.name), `Container Worker must bind API ${name}.`);
  }
  requireCheck(containers.exports?.UserContainer?.type === 'durable-object'
    && containers.exports.UserContainer.storage === 'sqlite',
  'Container Worker must export UserContainer as a SQLite Durable Object.');
  serviceConfiguration('admin', api, admin);
  serviceConfiguration('marketing', api, marketing);
  const database = api.d1_databases?.find(item => item.binding === 'DB');
  const preview = api.d1_databases?.find(item => item.binding === 'PREVIEW_ROUTES');
  requireCheck(database?.database_id && database?.migrations_dir === 'migrations'
    && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(database.migrations_table ?? '')
    && preview?.database_id && preview.database_id !== database.database_id
    && preview.migrations_dir === 'preview-migrations',
  'API account and preview databases must be distinct and keep their migration directories.');
  const securityEnabled = api.vars?.EGRESS_POLICIES_ENABLED === 'true'
    || api.vars?.SECRETS_VAULT_ENABLED === 'true' || Boolean(api.vars?.SECURITY_FEATURE_ACCOUNTS?.trim());
  if (securityEnabled) {
    for (const [bindingName, className, scriptName] of [
      ['EGRESS_RELAY', 'EgressRelay', 'mainbrella-egress-relay'],
      ['SECURITY_ACK', 'SecurityAcknowledgment', 'mainbrella-security-ack'],
    ]) {
      requireCheck(api.durable_objects?.bindings?.some(item => item.name === bindingName
        && item.class_name === className && item.script_name === scriptName),
      `Enabled security features require the ${bindingName} service binding; use the coordinated security provisioning flow.`);
    }
    requireCheck(/^https:\/\//.test(api.vars?.EGRESS_RELAY_URL ?? ''),
      'Enabled security features require the configured HTTPS egress relay URL.');
  }
  const bffEnabled = api.vars?.BFF_ENABLED === 'true';
  if (bffEnabled) {
    requireCheck(api.worker_loaders?.filter(item => item.binding === 'BFF_LOADER').length === 1,
      'Enabled BFF requires the BFF_LOADER Worker Loader binding for isolated JavaScript execution.');
    if (api.vars?.BFF_CLOUDFLARE_ACCOUNT_ID !== undefined) {
      requireCheck(/^[a-f0-9]{32}$/.test(api.vars.BFF_CLOUDFLARE_ACCOUNT_ID),
        'BFF_CLOUDFLARE_ACCOUNT_ID must be the 32-character Cloudflare account ID for customer databases.');
    }
  }
  return { database, preview, securityEnabled, bffEnabled };
}

// Cloudflare documents GET deployments as newest active first, and GET versions as
// returning bindings plus script_runtime.exports. These reads avoid any upload or
// migration action: https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/
// https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/get/
async function activeVersions(accountId, name, token, request) {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${name}`;
  async function get(path) {
    let response, body;
    try {
      response = await request(`${endpoint}${path}`, { method: 'GET',
        headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(20_000) });
      body = await response.json();
    } catch {
      throw new Error(`Cannot read deployed ${name} metadata. Check Cloudflare connectivity and token access.`);
    }
    requireCheck(response.ok && body?.success === true && body.result,
      `Cannot read deployed ${name} metadata (HTTP ${response.status}). Check the Worker account and token permissions.`);
    return body.result;
  }
  const deployments = (await get('/deployments')).deployments;
  const latest = Array.isArray(deployments) && deployments[0];
  requireCheck(Array.isArray(latest?.versions) && latest.versions.length > 0,
    `${name} has no active deployment. ${bootstrap}`);
  const versions = [];
  for (const entry of latest.versions) {
    requireCheck(typeof entry.version_id === 'string' && /^[a-f0-9-]{36}$/.test(entry.version_id)
      && entry.percentage > 0, `${name} has invalid active version metadata.`);
    const version = await get(`/versions/${entry.version_id}`);
    requireCheck(version.resources && Array.isArray(version.resources.bindings),
      `${name} active version lacks binding metadata; cannot qualify an API-only release.`);
    versions.push(version.resources);
  }
  return versions;
}

function deployedBinding(resources, name, type) {
  return resources.bindings.find(item => item.name === name && item.type === type);
}
function deployedExport(resources, name) {
  const item = resources.script_runtime?.exports?.[name];
  return item?.type === 'durable-object' && item.storage === 'sqlite' && item.state !== 'deleted';
}

export async function apiPreflight({ api, containers, admin, marketing, migrations,
  previewMigrations, env, local = false, run = wrangler, request = fetch }) {
  const { database, securityEnabled, bffEnabled } = apiConfiguration({ api, containers, admin, marketing });
  requireCheck(!env.CLOUDFLARE_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID === api.account_id,
    'CLOUDFLARE_ACCOUNT_ID differs from the pinned API account.');
  if (local) return { configuration: true };
  requireCheck(typeof env.CLOUDFLARE_API_TOKEN === 'string' && env.CLOUDFLARE_API_TOKEN.trim(),
    'Set CLOUDFLARE_API_TOKEN with Workers read access for the API-only preflight.');
  const secrets = run(['secret', 'list', '--config', 'wrangler.jsonc', '--format', 'json']);
  if (bffEnabled) {
    const requiredBffSecrets = ['BFF_CLOUDFLARE_API_TOKEN'];
    if (!api.vars?.BFF_CLOUDFLARE_ACCOUNT_ID) requiredBffSecrets.unshift('BFF_CLOUDFLARE_ACCOUNT_ID');
    const missing = requiredBffSecrets.filter(name => !Array.isArray(secrets)
      || !secrets.some(item => item.name === name && item.type === 'secret_text'));
    requireCheck(!missing.length,
      `BFF is enabled but ${api.name} is missing ${missing.join(', ')}. From backend, run ${missing.map(name => `npx wrangler secret put ${name}`).join(' and ')}. Use a dedicated token with Account > D1 > Edit access to the BFF database account.`);
  }
  const requiredApiSecrets = ['IMAGE_BUILD_SECRET', 'MONITORING_SECRET'];
  if (securityEnabled) requiredApiSecrets.push('EGRESS_RELAY_TOKEN', 'SECRETS_ENCRYPTION_KEY');
  for (const name of requiredApiSecrets) {
    requireCheck(Array.isArray(secrets) && secrets.some(item => item.name === name && item.type === 'secret_text'),
      `Configure deployed API ${name} before an API-only release.`);
  }
  const adminSecrets = run(['secret', 'list', '--config', 'wrangler.admin.jsonc', '--format', 'json']);
  requireCheck(Array.isArray(adminSecrets) && adminSecrets.some(item => item.name === 'STRIPE_SECRET_KEY'
    && item.type === 'secret_text'),
  'Configure deployed admin STRIPE_SECRET_KEY before an API-only release.');
  const result = run(['d1', 'execute', 'DB', '--config', 'wrangler.jsonc', '--remote', '--json', '--command',
    `SELECT name FROM ${database.migrations_table}; SELECT name FROM sqlite_master WHERE type = 'table';`]);
  requireCheck(Array.isArray(result) && result.length === 2
    && result.every(item => item.success === true && Array.isArray(item.results)),
  'Cannot verify the remote shared database migration ledger.');
  const applied = new Set(result[0].results.map(item => item.name));
  const missing = migrations.filter(name => !applied.has(name));
  requireCheck(!missing.length, `Apply remote shared database migrations before API deployment: ${missing.join(', ')}`);
  const tables = new Set(result[1].results.map(item => item.name));
  for (const name of ['users', 'sessions', 'marketing_email_unsubscribes']) {
    requireCheck(tables.has(name), `Shared database is missing ${name}.`);
  }
  const previewResult = run(['d1', 'execute', 'PREVIEW_ROUTES', '--config', 'wrangler.jsonc', '--remote', '--json', '--command',
    'SELECT name FROM d1_migrations; SELECT name FROM sqlite_master WHERE type = \'table\';']);
  requireCheck(Array.isArray(previewResult) && previewResult.length === 2
    && previewResult.every(item => item.success === true && Array.isArray(item.results)),
  'Cannot verify the remote preview database migration ledger.');
  const previewApplied = new Set(previewResult[0].results.map(item => item.name));
  const previewMissing = previewMigrations.filter(name => !previewApplied.has(name));
  requireCheck(!previewMissing.length, `Apply remote preview database migrations before API deployment: ${previewMissing.join(', ')}`);
  const previewTables = new Set(previewResult[1].results.map(item => item.name));
  for (const name of ['preview_routes', 'project_endpoints', 'project_hosts', 'project_route_versions', 'project_binding_operations']) {
    requireCheck(previewTables.has(name), `Preview database is missing ${name}.`);
  }

  const token = env.CLOUDFLARE_API_TOKEN;
  const [apiVersions, containerVersions, adminVersions, marketingVersions, ...securityVersions] = await Promise.all([
    activeVersions(api.account_id, api.name, token, request),
    activeVersions(api.account_id, containers.name, token, request),
    activeVersions(api.account_id, admin.name, token, request),
    activeVersions(api.account_id, marketing.name, token, request),
    ...(securityEnabled ? [
      activeVersions(api.account_id, 'mainbrella-egress-relay', token, request),
      activeVersions(api.account_id, 'mainbrella-security-ack', token, request),
    ] : []),
  ]);
  if (securityEnabled) {
    requireCheck(securityVersions[0].every(version => deployedExport(version, 'EgressRelay')),
      'Active egress relay lacks its Durable Object export; use coordinated security provisioning.');
  }
  for (const version of apiVersions) {
    for (const name of ['AccountActivity', 'ContainerAccount']) {
      requireCheck(deployedExport(version, name), `Active API version does not export ${name}. ${bootstrap}`);
    }
    const bound = deployedBinding(version, 'USER_CONTAINER', 'durable_object_namespace');
    requireCheck(bound?.script_name === containers.name && bound.class_name === 'UserContainer',
      `Active API version lacks its runtime binding. ${bootstrap}`);
    const activeDatabase = deployedBinding(version, 'DB', 'd1');
    requireCheck((activeDatabase?.database_id ?? activeDatabase?.id) === database.database_id,
      'Active API version does not use the configured shared database.');
    for (const [bindingName, service] of [['ADMIN_API', admin.name], ['MARKETING_API', marketing.name]]) {
      requireCheck(deployedBinding(version, bindingName, 'service')?.service === service,
        `Active API version lacks the ${bindingName} service binding. ${bootstrap}`);
    }
    if (securityEnabled) {
      for (const [bindingName, className, scriptName] of [
        ['EGRESS_RELAY', 'EgressRelay', 'mainbrella-egress-relay'],
        ['SECURITY_ACK', 'SecurityAcknowledgment', 'mainbrella-security-ack'],
      ]) {
        const securityBinding = deployedBinding(version, bindingName, 'durable_object_namespace');
        requireCheck(securityBinding?.script_name === scriptName && securityBinding.class_name === className,
          `Active API version lacks ${bindingName}; use coordinated security provisioning.`);
      }
    }
  }
  for (const version of containerVersions) {
    requireCheck(deployedExport(version, 'UserContainer'), `Active container version lacks UserContainer. ${bootstrap}`);
    for (const name of ['AccountActivity', 'ContainerAccount']) {
      const bound = deployedBinding(version, name.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase(), 'durable_object_namespace');
      requireCheck(bound?.script_name === api.name && bound.class_name === name,
        `Active container version lacks API ${name} binding. ${bootstrap}`);
    }
  }
  for (const version of adminVersions) {
    const bound = deployedBinding(version, 'CONTAINER_ACCOUNT', 'durable_object_namespace');
    requireCheck(bound?.script_name === api.name && bound.class_name === 'ContainerAccount',
      `Active admin version lacks the API account binding. ${bootstrap}`);
  }
  for (const [name, versions] of [['admin', adminVersions], ['marketing', marketingVersions]]) {
    for (const version of versions) {
      const bound = deployedBinding(version, 'DB', 'd1');
      requireCheck((bound?.database_id ?? bound?.id) === database.database_id,
        `Active ${name} version does not share the API database.`);
    }
  }
  for (const version of marketingVersions) {
    requireCheck(deployedBinding(version, 'MARKETING_EMAIL', 'send_email'),
      'Active marketing version lacks its email binding.');
  }
  return { configuration: true, remoteMigrations: true, activeBindings: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    requireCheck(args.length === 0 || args.length === 1 && args[0] === '--local',
      'Use deploy-api-preflight.mjs [--local].');
    const read = name => JSON.parse(readFileSync(join(root, name), 'utf8'));
    const api = read('wrangler.jsonc');
    const options = { api, containers: read('wrangler.containers.jsonc'),
      admin: read('wrangler.admin.jsonc'), marketing: read('wrangler.marketing.jsonc'),
      migrations: readdirSync(join(root, 'migrations')).filter(name => name.endsWith('.sql')).sort(),
      previewMigrations: readdirSync(join(root, 'preview-migrations')).filter(name => name.endsWith('.sql')).sort(),
      env: process.env, local: args[0] === '--local' };
    requireCheck(!process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID === api.account_id,
      'CLOUDFLARE_ACCOUNT_ID differs from the pinned API account.');
    process.env.CLOUDFLARE_ACCOUNT_ID = api.account_id;
    await apiPreflight(options);
    console.log(`API preflight passed (${options.local ? 'configuration only' : 'read-only remote metadata verified'}).`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
