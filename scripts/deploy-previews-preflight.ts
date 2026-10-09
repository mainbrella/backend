import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { previewDomain } from '../worker/lib/preview-routing';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
class PreviewPreflightError extends Error {}
function requireCheck(value: unknown, message: string): asserts value {
  if (!value) throw new PreviewPreflightError(message);
}

// Wrangler configurations in this repository are JSON without comments.
type Config = Record<string, any>;
type Run = (args: string[]) => unknown;
const normalizeSql = (sql: string) => sql.replace(/--[^\n]*/g, '').replace(/\s+/g, '').replace(/;$/, '').toLowerCase();

export function previewConfiguration(api: Config, gateway: Config, containers: Config) {
  const domain = previewDomain(gateway.vars ?? {});
  requireCheck(domain && previewDomain(api.vars ?? {}) === domain,
    'Set matching isolated PREVIEW_DOMAIN values in the API and gateway configurations.');
  const enabled = api.vars?.PREVIEWS_ENABLED;
  requireCheck(['true', 'false'].includes(enabled) && gateway.vars?.PREVIEWS_ENABLED === enabled,
    'Set matching explicit PREVIEWS_ENABLED flags; use false while staging.');
  requireCheck(api.account_id && api.account_id === gateway.account_id && api.account_id === containers.account_id,
    'API, gateway and runtime accounts must be pinned and match.');
  requireCheck(new Set([api.name, gateway.name, containers.name]).size === 3 && [api, gateway, containers].every(c => c.name),
    'API, gateway and runtime must use distinct Worker names.');
  for (const config of [api, gateway]) {
    const bindings = config.durable_objects?.bindings?.filter((b: Config) => b.name === 'USER_CONTAINER');
    requireCheck(bindings?.length === 1 && bindings[0].script_name === containers.name && bindings[0].class_name === 'UserContainer',
      'Both USER_CONTAINER bindings must target the private runtime.');
  }
  const accountBindings = gateway.durable_objects.bindings.filter((binding: Config) => binding.name === 'CONTAINER_ACCOUNT');
  requireCheck(accountBindings.length <= 1 && (!accountBindings.length || accountBindings[0].script_name === api.name
    && accountBindings[0].class_name === 'ContainerAccount')
    && gateway.durable_objects.bindings.length === 1 + accountBindings.length && gateway.d1_databases?.length === 1,
    'The gateway may bind only USER_CONTAINER, the owner-scoped CONTAINER_ACCOUNT registry, and the dedicated PREVIEW_ROUTES database.');
  const projectsEnabled = api.vars?.PROJECT_HOSTING_ENABLED === 'true';
  requireCheck((api.vars?.PROJECT_HOSTING_ENABLED ?? 'false') === (gateway.vars?.PROJECT_HOSTING_ENABLED ?? 'false')
    && ['true', 'false'].includes(api.vars?.PROJECT_HOSTING_ENABLED ?? 'false'), 'Project hosting flags must match; use false while staging.');
  if (projectsEnabled) {
    requireCheck(accountBindings.length === 1, 'Project hosting requires the owned container network registry.');
    for (const key of ['PROJECT_DOMAIN_PROVIDER', 'PROJECT_CLOUDFLARE_ZONE_ID', 'PROJECT_INGRESS_HOST', 'PROJECT_APEX_IPS']) {
      requireCheck(api.vars?.[key] === gateway.vars?.[key], 'API and gateway project ingress configuration must match.');
    }
  }
  for (const key of ['services', 'kv_namespaces', 'r2_buckets', 'queues', 'analytics_engine_datasets', 'ai', 'browser',
    'dispatch_namespaces', 'hyperdrive', 'send_email', 'unsafe', 'env']) {
    requireCheck(!gateway[key], 'Unexpected gateway bindings or environment overrides; review isolation before rollout.');
  }
  const apiRoutes = api.d1_databases?.filter((d: Config) => d.binding === 'PREVIEW_ROUTES');
  const database = gateway.d1_databases[0];
  const accountDatabase = api.d1_databases?.find((d: Config) => d.binding === 'DB');
  requireCheck(apiRoutes?.length === 1 && database.binding === 'PREVIEW_ROUTES' && database.database_id
    && database.database_name && accountDatabase?.database_id && database.database_id !== accountDatabase.database_id
    && database.database_name !== accountDatabase.database_name,
  'PREVIEW_ROUTES must use a dedicated database separate from the account database.');
  requireCheck(['database_id', 'database_name'].every(key => apiRoutes[0][key] === database[key])
    && [apiRoutes[0], database].every(d => d.migrations_dir === 'preview-migrations' && !d.preview_database_id
      && (!d.migrations_table || d.migrations_table === 'd1_migrations')),
  'API and gateway routing database IDs, names and migration settings must match.');
  requireCheck(gateway.workers_dev === false && gateway.preview_urls === false
    && containers.workers_dev === false && containers.preview_urls === false && !containers.routes?.length,
  'Gateway development URLs and all public runtime routes must be disabled.');
  requireCheck(gateway.compatibility_flags?.includes('enable_request_signal') && containers.compatibility_flags?.includes('enable_request_signal'),
    'Gateway and runtime must enable request signals for disconnect handling.');
  requireCheck(gateway.observability?.enabled === false && gateway.observability?.logs?.enabled !== true
    && gateway.observability?.traces?.enabled !== true && !gateway.logpush && !gateway.tail_consumers?.length,
  'Disable gateway observability, Logpush and tail consumers to avoid bearer-host logging.');
  const routes = gateway.routes ?? [];
  const wildcardRoutes = routes.filter((route: Config) => route && typeof route === 'object' && !route.custom_domain
    && [`*.${domain}/*`, `https://*.${domain}/*`].includes(route.pattern));
  const apexRoutes = routes.filter((route: Config) => route && typeof route === 'object'
    && route.custom_domain === true && route.pattern === domain);
  const customRoutes = routes.filter((route: Config) => route && typeof route === 'object'
    && route.pattern === '*/*' && !route.custom_domain);
  if (projectsEnabled && gateway.vars?.PROJECT_DOMAIN_PROVIDER === 'cloudflare') {
    requireCheck(customRoutes.length === 1 && gateway.vars.PROJECT_CLOUDFLARE_ZONE_ID
      && wildcardRoutes[0]?.zone_id === gateway.vars.PROJECT_CLOUDFLARE_ZONE_ID,
    'Cloudflare project hosting requires a SaaS catch-all and wildcard route pinned to the same isolated zone.');
  }
  requireCheck(wildcardRoutes.length === 1 && apexRoutes.length <= 1 && customRoutes.length <= 1
    && (!customRoutes.length || projectsEnabled && gateway.vars?.PROJECT_DOMAIN_PROVIDER === 'cloudflare'
      && gateway.vars?.PROJECT_CLOUDFLARE_ZONE_ID
      && customRoutes[0].zone_id === gateway.vars.PROJECT_CLOUDFLARE_ZONE_ID)
    && routes.length === 1 + apexRoutes.length + customRoutes.length,
  'Configure one wildcard route, optionally the exact apex redirect, and a zone-pinned SaaS catch-all only for enabled Cloudflare project hosting.');
  requireCheck(gateway.triggers?.crons?.length === 1 && gateway.triggers.crons[0] === '*/5 * * * *',
    'Configure the five-minute routing cleanup schedule.');
  return { domain, issuanceEnabled: enabled === 'true' };
}

function wrangler(args: string[]) {
  try {
    return JSON.parse(execFileSync(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'), ...args],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }));
  } catch {
    throw new PreviewPreflightError('Cannot read the routing database. Check Wrangler authentication, database existence and applied preview migrations.');
  }
}

export function verifyPreviewSchema(migrationSql: string, run: Run = wrangler) {
  const expected = migrationSql.match(/CREATE (?:TABLE|INDEX)[\s\S]*?;/g);
  requireCheck(expected?.length === 2, 'Cannot read the expected routing schema.');
  // Read only schema/migration metadata, never routing rows or bearer hashes.
  const results = run(['d1', 'execute', 'PREVIEW_ROUTES', '--config', 'wrangler.previews.jsonc', '--remote', '--json', '--command',
    "SELECT name FROM d1_migrations; SELECT name, sql FROM sqlite_master WHERE name IN ('preview_routes', 'preview_routes_expiry');"]);
  requireCheck(Array.isArray(results) && results.length === 2 && results.every(r => r.success === true && Array.isArray(r.results)),
    'Cannot verify remote preview migration metadata.');
  requireCheck(results[0].results.some((r: Config) => r.name === '001_preview_routes.sql'),
    'Apply 001_preview_routes.sql to the dedicated routing database before rollout.');
  const sql = results[1].results.map((r: Config) => typeof r.sql === 'string' ? normalizeSql(r.sql) : '');
  requireCheck(sql.length === 2 && expected.every(statement => sql.includes(normalizeSql(statement))),
    'Remote preview schema differs from the expected table constraints or expiry index; reconcile before rollout.');
}

export function verifyProjectSchema(migrationSql: string, run: Run = wrangler) {
  const expected = migrationSql.match(/CREATE (?:TABLE|INDEX)[\s\S]*?;/g);
  requireCheck(expected?.length === 6, 'Cannot read the expected project routing schema.');
  const results = run(['d1', 'execute', 'PREVIEW_ROUTES', '--config', 'wrangler.previews.jsonc', '--remote', '--json', '--command',
    "SELECT name FROM d1_migrations; SELECT name, sql FROM sqlite_master WHERE name IN ('project_endpoints', 'project_hosts', 'project_hosts_project', 'project_route_versions', 'project_binding_operations', 'project_binding_operations_project');"]);
  requireCheck(Array.isArray(results) && results.length === 2 && results.every(r => r.success === true && Array.isArray(r.results)),
    'Cannot verify remote project migration metadata.');
  requireCheck(results[0].results.some((r: Config) => r.name === '002_project_endpoints.sql'),
    'Apply 002_project_endpoints.sql to the dedicated routing database with npm run db:migrate:previews:remote before rollout.');
  const sql = results[1].results.map((r: Config) => typeof r.sql === 'string' ? normalizeSql(r.sql) : '');
  requireCheck(sql.length === expected.length && expected.every(statement => sql.includes(normalizeSql(statement))),
    'Remote project routing schema differs from the expected tables or indexes; reconcile before rollout.');
}

export function previewPreflight({ api, gateway, containers, migrationSql, projectMigrationSql = '', local = false, run = wrangler }:
  { api: Config; gateway: Config; containers: Config; migrationSql: string; projectMigrationSql?: string; local?: boolean; run?: Run }) {
  const configuration = previewConfiguration(api, gateway, containers);
  if (!local) {
    verifyPreviewSchema(migrationSql, run);
    if (api.vars?.PROJECT_HOSTING_ENABLED === 'true') verifyProjectSchema(projectMigrationSql, run);
  }
  return { ...configuration, routingSchemaVerified: !local, releaseQualified: false,
    pendingGates: ['domain_ownership_dns_tls_logging_review', 'deployed_transport_framework_isolation_generation_checks'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    requireCheck(args.length === 0 || (args.length === 1 && args[0] === '--local'), 'Use no arguments for remote schema reads, or --local for configuration checks only.');
    const read = (path: string) => readFileSync(join(root, path), 'utf8');
    const api = JSON.parse(read('wrangler.jsonc'));
    requireCheck(!process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID === api.account_id,
      'CLOUDFLARE_ACCOUNT_ID differs from the configured Worker account.');
    process.env.CLOUDFLARE_ACCOUNT_ID = api.account_id;
    const report = previewPreflight({ api, gateway: JSON.parse(read('wrangler.previews.jsonc')),
      containers: JSON.parse(read('wrangler.containers.jsonc')), migrationSql: read('preview-migrations/001_preview_routes.sql'),
      projectMigrationSql: read('preview-migrations/002_project_endpoints.sql'), local: args.length === 1 });
    console.log(JSON.stringify(report, null, 2));
    console.log('Preview preflight passed. No deployment, database write or container start performed.');
  } catch (error) {
    console.error(error instanceof PreviewPreflightError ? error.message : 'Cannot verify preview rollout configuration or metadata.');
    process.exitCode = 1;
  }
}
