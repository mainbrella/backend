import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { previewPreflight } from './deploy-previews-preflight';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
function fixture() {
  const api = JSON.parse(read('wrangler.jsonc'));
  const gateway = JSON.parse(read('wrangler.previews.jsonc'));
  const containers = JSON.parse(read('wrangler.containers.jsonc'));
  const migrationSql = read('preview-migrations/001_preview_routes.sql');
  api.vars.PREVIEW_DOMAIN = gateway.vars.PREVIEW_DOMAIN = 'preview.example';
  api.vars.PREVIEWS_ENABLED = gateway.vars.PREVIEWS_ENABLED = 'false';
  gateway.routes = [{ pattern: '*.preview.example/*', zone_name: 'preview.example' }];
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(migrationSql);
  const results = [{ success: true, results: [{ name: '001_preview_routes.sql' }] },
    { success: true, results: sqlite.prepare("SELECT name, sql FROM sqlite_master WHERE name IN ('preview_routes', 'preview_routes_expiry')").all() }];
  sqlite.close();
  const calls: string[][] = [];
  const options = { api, gateway, containers, migrationSql, run(args: string[]) { calls.push(args); return results; } };
  return { options, calls, results };
}

test('staged config passes with schema-only remote reads against the isolated binding', () => {
  const f = fixture();
  assert.deepEqual(previewPreflight(f.options), { domain: 'preview.example', issuanceEnabled: false,
    routingSchemaVerified: true, releaseQualified: false,
    pendingGates: ['domain_ownership_dns_tls_logging_review', 'deployed_transport_framework_isolation_generation_checks'] });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].slice(0, -1), ['d1', 'execute', 'PREVIEW_ROUTES', '--config', 'wrangler.previews.jsonc', '--remote', '--json', '--command']);
  assert.equal(f.calls[0].at(-1), "SELECT name FROM d1_migrations; SELECT name, sql FROM sqlite_master WHERE name IN ('preview_routes', 'preview_routes_expiry');");
});

test('local mode performs no remote operations; matching enabled config still needs qualification', () => {
  const f = fixture();
  f.options.api.vars.PREVIEWS_ENABLED = f.options.gateway.vars.PREVIEWS_ENABLED = 'true';
  f.options.gateway.routes[0].pattern = 'https://*.preview.example/*';
  const report = previewPreflight({ ...f.options, local: true });
  assert.equal(report.issuanceEnabled, true);
  assert.equal(report.routingSchemaVerified, false);
  assert.equal(report.releaseQualified, false);
  assert.equal(f.calls.length, 0);
});

test('unsafe isolation, routing, logging and lifecycle configuration fails before remote reads', () => {
  const changes = [
    (o: any) => { o.gateway.vars.PREVIEW_DOMAIN = o.api.vars.PREVIEW_DOMAIN = 'apps.mainbrella.com'; },
    (o: any) => { o.api.vars.PREVIEW_DOMAIN = 'other.example'; },
    (o: any) => { o.api.vars.PREVIEWS_ENABLED = 'true'; },
    (o: any) => { o.gateway.account_id = 'other'; },
    (o: any) => { o.containers.name = o.api.name; },
    (o: any) => { o.gateway.durable_objects.bindings[0].script_name = o.api.name; },
    (o: any) => { o.api.durable_objects.bindings.push(o.api.durable_objects.bindings[1]); },
    (o: any) => { o.gateway.d1_databases.push(o.api.d1_databases[0]); },
    (o: any) => { o.gateway.services = [{ binding: 'ACCOUNT_API', service: o.api.name }]; },
    (o: any) => { o.gateway.env = { production: {} }; },
    (o: any) => { o.gateway.d1_databases[0].database_id = o.api.d1_databases[0].database_id; },
    (o: any) => { o.gateway.d1_databases[0].database_name = 'other'; },
    (o: any) => { o.gateway.d1_databases[0].migrations_dir = 'migrations'; },
    (o: any) => { o.gateway.d1_databases[0].migrations_table = 'schema_migrations'; },
    (o: any) => { o.gateway.workers_dev = true; },
    (o: any) => { o.gateway.preview_urls = true; },
    (o: any) => { o.containers.routes = [{ pattern: 'runtime.example' }]; },
    (o: any) => { o.containers.compatibility_flags = []; },
    (o: any) => { o.gateway.observability.enabled = true; },
    (o: any) => { o.gateway.observability.logs = { enabled: true }; },
    (o: any) => { o.gateway.observability.traces = { enabled: true }; },
    (o: any) => { o.gateway.logpush = true; },
    (o: any) => { o.gateway.tail_consumers = [{ service: 'logger' }]; },
    (o: any) => { o.gateway.routes = []; },
    (o: any) => { o.gateway.routes[0].pattern = '*.mainbrella.com/*'; },
    (o: any) => { o.gateway.routes[0].custom_domain = true; },
    (o: any) => { o.gateway.routes.push({ pattern: 'api.mainbrella.com/*' }); },
    (o: any) => { o.gateway.triggers.crons = []; },
  ];
  for (const change of changes) {
    const f = fixture();
    change(f.options);
    assert.throws(() => previewPreflight(f.options));
    assert.equal(f.calls.length, 0);
  }
});

test('missing migration, constraints, expiry index and malformed remote evidence fail closed', () => {
  for (const change of [
    (r: any[]) => { r[0].results = []; },
    (r: any[]) => { r[1].success = false; },
    (r: any[]) => { r[1].results.pop(); },
    (r: any[]) => { r[1].results[0].sql = r[1].results[0].sql.replace('CHECK(length(token_hash) = 64)', ''); },
    (r: any[]) => { r[1].results[1].sql = 'CREATE INDEX preview_routes_expiry ON preview_routes(created_at)'; },
  ]) {
    const f = fixture(); change(f.results);
    assert.throws(() => previewPreflight(f.options), /001_preview_routes|schema|metadata/);
  }
  const f = fixture();
  for (const result of [null, [], {}, [{ success: true, results: null }]]) {
    assert.throws(() => previewPreflight({ ...f.options, run: () => result }), /metadata/);
  }
});

test('checked-in disabled configuration has no domain and blocks rollout before remote reads', () => {
  const f = fixture();
  f.options.api = JSON.parse(read('wrangler.jsonc'));
  f.options.gateway = JSON.parse(read('wrangler.previews.jsonc'));
  assert.throws(() => previewPreflight(f.options), /PREVIEW_DOMAIN/);
  assert.equal(f.calls.length, 0);
});
