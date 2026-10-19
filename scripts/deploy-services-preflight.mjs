import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { resolveTool } from './resolve-tool.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const targets = ['admin', 'marketing'];
function requireCheck(value, message) { if (!value) throw new Error(message); }

export function serviceConfiguration(target, api, service) {
  requireCheck(targets.includes(target), 'Choose admin or marketing.');
  requireCheck(api.account_id && service.account_id === api.account_id,
    'Service and API Cloudflare accounts must match.');
  requireCheck(service.name === `mainbrella-${target}` && service.name !== api.name
    && service.main === `worker/${target}.ts`, 'Service Worker name or entry point differs from its deployment target.');
  requireCheck(service.workers_dev === false && service.preview_urls === false
    && !service.routes?.length && !service.route, 'Admin and marketing Workers must only be reachable through service bindings.');
  requireCheck(!service.services?.length && !service.containers?.length && !service.exports
    && !service.triggers, 'Services must not own customer containers, Durable Objects, or scheduled reconciliation.');
  const binding = target === 'admin' ? 'ADMIN_API' : 'MARKETING_API';
  const bindings = api.services?.filter(item => item.binding === binding);
  requireCheck(bindings?.length === 1 && bindings[0].service === service.name && !bindings[0].environment,
    `The API ${binding} binding must target the configured service.`);
  const database = api.d1_databases?.find(item => item.binding === 'DB');
  const shared = service.d1_databases?.[0];
  requireCheck(service.d1_databases?.length === 1 && shared?.binding === 'DB'
    && database?.database_id && database.database_name
    && ['database_id', 'database_name', 'migrations_table'].every(key => shared[key] === database[key])
    && !shared.preview_database_id && !shared.migrations_dir
    && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(database.migrations_table),
  'Services must share the API account database and migration ledger; only the API config owns migration execution.');
  const objects = service.durable_objects?.bindings ?? [];
  if (target === 'admin') {
    requireCheck(objects.length === 1 && objects[0].name === 'CONTAINER_ACCOUNT'
      && objects[0].class_name === 'ContainerAccount' && objects[0].script_name === api.name,
    'Admin billing reads and closes must bind to the existing API ContainerAccount namespace.');
    requireCheck(!service.send_email?.length, 'Marketing sending belongs to the marketing Worker.');
    for (const key of [...Object.keys(api.vars ?? {}), ...Object.keys(service.vars ?? {})]) {
      if (key.startsWith('R2_') || key === 'ACQUISITION_ENABLED') {
        requireCheck(service.vars?.[key] === api.vars?.[key], `Admin ${key} must match the API setting.`);
      }
    }
  } else {
    requireCheck(objects.length === 0 && service.send_email?.length === 1
      && service.send_email[0].name === 'MARKETING_EMAIL', 'Marketing requires its email binding and must not access account Durable Objects.');
    requireCheck(!api.send_email?.some(item => item.name === 'MARKETING_EMAIL'),
      'Remove MARKETING_EMAIL from the customer API; marketing owns delivery.');
  }
  return database;
}

const adminSecretSetup = 'Run npx wrangler secret put STRIPE_SECRET_KEY --config wrangler.admin.jsonc using the same Stripe account as the API. Confirm Worker creation if prompted, then rerun npm run deploy:admin.';

export function wrangler(args, execute = execFileSync) {
  try {
    return JSON.parse(execute(process.execPath, [resolveTool('wrangler', 'bin/wrangler.js'), ...args],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }));
  } catch (error) {
    // Classify known errors without echoing Wrangler output or configuration data.
    if (args[0] === 'secret' && args[1] === 'list') {
      const stderr = stripVTControlCharacters(String(error.stderr ?? ''));
      if (args.includes('wrangler.admin.jsonc') && stderr.includes('Worker "mainbrella-admin" not found.')) {
        throw new Error(`Worker mainbrella-admin does not exist in the configured account. ${adminSecretSetup}`);
      }
      throw new Error('Cannot read service Worker secret metadata. Check Wrangler authentication, Worker existence, and secret access.');
    }
    throw new Error('Cannot read the shared database migration metadata. Check Wrangler authentication, database access, and applied API migrations.');
  }
}

export function servicePreflight({ target, api, service, migrations, local = false, run = wrangler }) {
  const database = serviceConfiguration(target, api, service);
  if (local) return;
  const config = ['--config', `wrangler.${target}.jsonc`];
  const result = run(['d1', 'execute', 'DB', ...config, '--remote', '--json', '--command',
    `SELECT name FROM ${database.migrations_table}; SELECT name FROM sqlite_master WHERE type = 'table';`]);
  requireCheck(Array.isArray(result) && result.length === 2 && result.every(item => item.success === true && Array.isArray(item.results)),
    'Cannot verify the shared database migration ledger.');
  const applied = new Set(result[0].results.map(item => item.name));
  const missing = migrations.filter(name => !applied.has(name));
  requireCheck(!missing.length, `Apply remote migrations through the API before deployment: ${missing.join(', ')}`);
  const tables = new Set(result[1].results.map(item => item.name));
  for (const table of ['users', 'sessions', 'marketing_email_unsubscribes']) {
    requireCheck(tables.has(table), `The shared database is missing ${table}.`);
  }
  if (target === 'admin') {
    const secrets = run(['secret', 'list', ...config, '--format', 'json']);
    requireCheck(Array.isArray(secrets) && secrets.some(item => item.name === 'STRIPE_SECRET_KEY' && item.type === 'secret_text'),
      `Configure STRIPE_SECRET_KEY on mainbrella-admin before rollout; accounting closes refresh payment evidence. ${adminSecretSetup}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    const local = args.includes('--local');
    const selected = args.filter(arg => arg !== '--local');
    requireCheck(args.filter(arg => arg === '--local').length <= 1 && selected.length <= 1
      && (!selected.length || targets.includes(selected[0])), 'Use [admin|marketing] [--local].');
    const api = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'));
    requireCheck(!process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID === api.account_id,
      'CLOUDFLARE_ACCOUNT_ID differs from the configured API account.');
    process.env.CLOUDFLARE_ACCOUNT_ID = api.account_id;
    const database = api.d1_databases.find(item => item.binding === 'DB');
    const migrations = readdirSync(join(root, database.migrations_dir)).filter(name => name.endsWith('.sql')).sort();
    for (const target of selected.length ? selected : targets) {
      servicePreflight({ target, api, service: JSON.parse(readFileSync(join(root, `wrangler.${target}.jsonc`), 'utf8')), migrations, local });
      console.log(`${target} preflight passed (${local ? 'configuration only' : 'remote metadata verified'}).`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
