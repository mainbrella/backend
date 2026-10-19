import { stagingTestRoot } from './staging-test-fixtures.mjs';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { STAGING, stagingConfig as sourceStagingConfig } from './staging-config.mjs';
import { preflightStaging } from './staging-preflight.mjs';

const root = stagingTestRoot();
const stagingConfig = (name, options = {}) => sourceStagingConfig(name, { directory: root, ...options });
const targets = ['api', 'admin', 'marketing', 'containers', 'previews', 'site', 'builder', 'raindrop'];
const resources = {
  databaseId: '00000000-0000-4000-8000-000000000001',
  previewDatabaseId: '00000000-0000-4000-8000-000000000002',
  bucketName: STAGING.bucketName,
};
const versionId = '023e105f-2a42-4f8b-a1c1-73f6a2a30c0f';
const object = (name, class_name, script_name) => ({ type: 'durable_object_namespace', name, class_name, script_name });
const d1 = (name, id) => ({ type: 'd1', name, database_id: id });
const exportObject = { type: 'durable-object', storage: 'sqlite' };

function fixture() {
  const configurations = Object.fromEntries(targets.map(name => [name, stagingConfig(name, { resources })]));
  const api = configurations.api.name;
  const containers = configurations.containers.name;
  const versions = {
    [api]: { bindings: [
      { type: 'plain_text', name: 'DEPLOYMENT_ENVIRONMENT', text: 'staging' },
      d1('DB', resources.databaseId), d1('PREVIEW_ROUTES', resources.previewDatabaseId),
      { type: 'r2_bucket', name: 'BUCKET', bucket_name: STAGING.bucketName },
      object('USER_CONTAINER', 'UserContainer', containers),
    ], script_runtime: { exports: { AccountActivity: exportObject, ContainerAccount: exportObject } } },
    [containers]: { bindings: [
      object('ACCOUNT_ACTIVITY', 'AccountActivity', api),
      object('CONTAINER_ACCOUNT', 'ContainerAccount', api),
    ], script_runtime: { exports: { UserContainer: exportObject } } },
    [configurations.admin.name]: { bindings: [
      d1('DB', resources.databaseId), object('CONTAINER_ACCOUNT', 'ContainerAccount', api),
    ] },
    [configurations.marketing.name]: { bindings: [d1('DB', resources.databaseId)] },
  };
  const calls = [];
  const options = {
    configurations, resources, directory: root,
    env: { CLOUDFLARE_API_TOKEN: 'read-only-token', CLOUDFLARE_ACCOUNT_ID: STAGING.accountId },
    async run(target, args) {
      calls.push({ kind: 'wrangler', target, args });
      assert.equal(target, 'api');
      assert.deepEqual(args.slice(0, 3), ['d1', 'execute', args[2]]);
      assert.equal(args.includes('--remote'), true);
      const dir = args[2] === 'DB' ? 'migrations' : 'preview-migrations';
      return [{ success: true, results: readdirSync(join(root, '.', dir))
        .filter(name => name.endsWith('.sql')).map(name => ({ name })) }];
    },
    async request(address, init) {
      const url = new URL(address);
      calls.push({ kind: 'http', address, init });
      assert.ok(['GET', 'OPTIONS'].includes(init.method));
      assert.equal(init.redirect, 'error');
      assert.ok(url.hostname === 'api.cloudflare.com' || url.origin === STAGING.apiOrigin);
      if (url.origin === STAGING.apiOrigin) {
        if (url.pathname === '/health') return Response.json({ ok: true });
        const origin = init.headers.Origin;
        return new Response(null, { status: 204,
          headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' } });
      }
      assert.equal(init.headers.Authorization, 'Bearer read-only-token');
      const worker = url.pathname.match(/\/workers\/scripts\/([^/]+)/)?.[1];
      assert.ok(versions[worker], address);
      const result = url.pathname.endsWith('/deployments')
        ? { deployments: [{ versions: [{ version_id: versionId, percentage: 100 }] }] }
        : { resources: versions[worker] };
      return Response.json({ success: true, result });
    },
  };
  return { options, versions, calls };
}

test('all backend preflights use only staging ledger and active-version reads', async () => {
  for (const target of targets.slice(0, 5)) {
    const { options, calls } = fixture();
    assert.deepEqual(await preflightStaging(target, options),
      { configuration: true, remoteMigrations: true, activeBindings: true });
    assert.equal(calls.filter(call => call.kind === 'wrangler').length,
      target === 'api' || target === 'previews' ? 2 : 1);
    for (const call of calls) {
      if (call.kind === 'wrangler') {
        assert.ok(call.args.includes('--json'));
        assert.match(call.args.at(-1), /^SELECT name FROM (schema_migrations|d1_migrations);$/);
        assert.ok(!call.args.some(arg => /apply|migrate|delete|put|deploy/.test(arg)));
      } else {
        assert.equal(call.init.method, 'GET');
        assert.match(call.address, /\/workers\/scripts\/mainbrella-[a-z]+-stg\//);
        assert.doesNotMatch(call.address, /api\.mainbrella\.com|mainbrella\.com\/build/);
      }
    }
  }
});

test('frontend preflight requires staging API health and credentialed CORS', async () => {
  for (const target of ['site', 'builder', 'raindrop']) {
    const { options, calls } = fixture();
    assert.deepEqual(await preflightStaging(target, options),
      { configuration: true, backendHealth: true, cors: true });
    assert.deepEqual(calls.map(call => [call.init.method, call.address]), [
      ['GET', `${STAGING.apiOrigin}/health`], ['OPTIONS', `${STAGING.apiOrigin}/auth/me`],
    ]);
    assert.equal(calls[1].init.headers.Origin, target === 'raindrop' ? STAGING.adminOrigin : STAGING.webOrigin);
  }
});

test('all configurations are validated before any remote read', async () => {
  for (const target of ['api', 'site']) {
    const { options, calls } = fixture();
    options.configurations.marketing.d1_databases[0].database_id = '41be6d7b-26fb-4701-a3fb-fdf3454e14f9';
    await assert.rejects(preflightStaging(target, options), /Unsafe or unexpected/);
    assert.deepEqual(calls, []);
  }
});

test('missing migrations, exports, and staging marker block backend releases', async () => {
  for (const failure of ['migration', 'previewMigration', 'marker', 'apiExport', 'containerExport', 'adminDb', 'marketingDb']) {
    const { options, versions } = fixture();
    const api = versions[options.configurations.api.name];
    const containers = versions[options.configurations.containers.name];
    const admin = versions[options.configurations.admin.name];
    const marketing = versions[options.configurations.marketing.name];
    if (failure === 'migration' || failure === 'previewMigration') {
      const original = options.run;
      options.run = (target, args) => args[2] === (failure === 'migration' ? 'DB' : 'PREVIEW_ROUTES')
        ? [{ success: true, results: [] }] : original(target, args);
    }
    if (failure === 'marker') api.bindings[0].text = 'production';
    if (failure === 'apiExport') delete api.script_runtime.exports.AccountActivity;
    if (failure === 'containerExport') delete containers.script_runtime.exports.UserContainer;
    if (failure === 'adminDb') admin.bindings[0].database_id = resources.previewDatabaseId;
    if (failure === 'marketingDb') marketing.bindings[0].database_id = resources.previewDatabaseId;
    await assert.rejects(preflightStaging('api', options), /Apply staging|incompatible|does not export/);
  }
});

test('active production references and missing dependencies fail closed with bootstrap guidance', async () => {
  for (const change of [
    versions => { versions['mainbrella-containers-stg'].bindings[0].script_name = 'mainbrella-api'; },
    versions => { versions['mainbrella-admin-stg'].bindings[0].database_id = '41be6d7b-26fb-4701-a3fb-fdf3454e14f9'; },
    versions => { versions['mainbrella-api-stg'].bindings[3].bucket_name = 'romeo'; },
  ]) {
    const { options, versions } = fixture();
    change(versions);
    await assert.rejects(preflightStaging('api', options), /non-staging/);
  }
  const { options } = fixture();
  options.request = async () => Response.json({ success: false }, { status: 404 });
  await assert.rejects(preflightStaging('api', options), /stg:bootstrap/);
});

test('legacy D1 id metadata is accepted; frontend CORS and health failures are rejected', async () => {
  const { options, versions } = fixture();
  for (const worker of ['mainbrella-api-stg', 'mainbrella-admin-stg', 'mainbrella-marketing-stg']) {
    const binding = versions[worker].bindings.find(item => item.name === 'DB');
    binding.id = binding.database_id;
    delete binding.database_id;
  }
  assert.equal((await preflightStaging('api', options)).activeBindings, true);
  const cors = fixture().options;
  cors.request = async (address, init) => init.method === 'GET' ? Response.json({ ok: true })
    : new Response(null, { status: 204 });
  await assert.rejects(preflightStaging('site', cors), /CORS/);
  const health = fixture().options;
  health.request = async () => Response.json({ ok: false });
  await assert.rejects(preflightStaging('site', health), /health/);
});
