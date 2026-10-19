import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { apiConfiguration, apiPreflight } from './deploy-api-preflight.mjs';

const read = name => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
const versionId = '023e105f-2a42-4f8b-a1c1-73f6a2a30c0f';
const object = (name, class_name, script_name) => ({ type: 'durable_object_namespace', name, class_name, script_name });
const d1 = { type: 'd1', name: 'DB', database_id: read('wrangler.jsonc').d1_databases[0].database_id };

function fixture() {
  const api = read('wrangler.jsonc');
  const containers = read('wrangler.containers.jsonc');
  const admin = read('wrangler.admin.jsonc');
  const marketing = read('wrangler.marketing.jsonc');
  const resources = {
    [api.name]: { bindings: [structuredClone(d1), object('USER_CONTAINER', 'UserContainer', containers.name),
      { type: 'service', name: 'ADMIN_API', service: admin.name },
      { type: 'service', name: 'MARKETING_API', service: marketing.name }],
      script_runtime: { exports: {
        AccountActivity: { type: 'durable-object', storage: 'sqlite' },
        ContainerAccount: { type: 'durable-object', storage: 'sqlite' },
      } } },
    [containers.name]: { bindings: [object('ACCOUNT_ACTIVITY', 'AccountActivity', api.name),
      object('CONTAINER_ACCOUNT', 'ContainerAccount', api.name)],
    script_runtime: { exports: { UserContainer: { type: 'durable-object', storage: 'sqlite' } } } },
    [admin.name]: { bindings: [structuredClone(d1), object('CONTAINER_ACCOUNT', 'ContainerAccount', api.name)] },
    [marketing.name]: { bindings: [structuredClone(d1), { type: 'send_email', name: 'MARKETING_EMAIL' }] },
  };
  const calls = [];
  const options = { api, containers, admin, marketing,
    migrations: ['001_initial.sql', '002_auth_sessions.sql'],
    previewMigrations: ['001_preview_routes.sql', '002_project_endpoints.sql'],
    env: { CLOUDFLARE_API_TOKEN: 'read-only-token' },
    run(args) {
      calls.push(['wrangler', args]);
      if (args[0] === 'secret') return (args.includes('wrangler.admin.jsonc')
        ? ['STRIPE_SECRET_KEY'] : ['IMAGE_BUILD_SECRET', 'MONITORING_SECRET',
          'BFF_CLOUDFLARE_ACCOUNT_ID', 'BFF_CLOUDFLARE_API_TOKEN'])
        .map(name => ({ name, type: 'secret_text' }));
      if (args[2] === 'PREVIEW_ROUTES') return [
        { success: true, results: options.previewMigrations.map(name => ({ name })) },
        { success: true, results: ['preview_routes', 'project_endpoints', 'project_hosts',
          'project_route_versions', 'project_binding_operations'].map(name => ({ name })) },
      ];
      return [
        { success: true, results: options.migrations.map(name => ({ name })) },
        { success: true, results: ['users', 'sessions', 'marketing_email_unsubscribes'].map(name => ({ name })) },
      ];
    },
    async request(url, init) {
      calls.push(['http', url, init.method]);
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'error');
      assert.equal(init.headers.Authorization, 'Bearer read-only-token');
      const name = new URL(url).pathname.match(/\/workers\/scripts\/([^/]+)/)?.[1];
      assert.ok(resources[name], url);
      const result = url.endsWith('/deployments')
        ? { deployments: [{ versions: [{ version_id: versionId, percentage: 100 }] }] }
        : { resources: resources[name] };
      return Response.json({ success: true, result });
    } };
  return { options, resources, calls };
}

test('local API configuration is valid and does not make remote calls', async () => {
  const { options, calls } = fixture();
  assert.ok(apiConfiguration(options).database.database_id);
  assert.deepEqual(await apiPreflight({ ...options, local: true }), { configuration: true });
  assert.deepEqual(calls, []);
  const result = execFileSync(process.execPath, ['scripts/deploy-api-preflight.mjs', '--local'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.match(result, /configuration only/);
});

test('remote API preflight reads only secret, migration, deployment and version metadata', async () => {
  const { options, calls } = fixture();
  assert.deepEqual(await apiPreflight(options), { configuration: true, remoteMigrations: true, activeBindings: true });
  assert.equal(calls.filter(([kind]) => kind === 'http').length, 8);
  assert.deepEqual(calls.filter(([kind]) => kind === 'wrangler').map(([, args]) => args.slice(0, 3)),
    [['secret', 'list', '--config'], ['secret', 'list', '--config'],
      ['d1', 'execute', 'DB'], ['d1', 'execute', 'PREVIEW_ROUTES']]);
  assert.ok(calls.every(call => !JSON.stringify(call).includes('/manifest') && !/deploy|publish|secret put/i.test(
    call[0] === 'wrangler' ? call[1].join(' ') : call[2])));
});

test('miswired local config and account mismatch fail before remote reads', async () => {
  for (const change of [
    o => { o.api.durable_objects.bindings.find(item => item.name === 'USER_CONTAINER').script_name = 'other'; },
    o => { o.containers.durable_objects.bindings = []; },
    o => { o.admin.d1_databases[0].database_id = 'other'; },
    o => { o.marketing.account_id = 'other'; },
    o => { o.env.CLOUDFLARE_ACCOUNT_ID = 'other'; },
  ]) {
    const { options, calls } = fixture();
    change(options);
    await assert.rejects(apiPreflight(options));
    assert.deepEqual(calls, []);
  }
});

test('missing secret or unapplied shared or preview migration blocks API-only release', async () => {
  for (const variant of ['secret', 'shared', 'preview']) {
    const { options, calls } = fixture();
    const run = options.run;
    options.run = args => variant === 'secret' && args[0] === 'secret'
      ? run(args).filter(item => item.name !== 'IMAGE_BUILD_SECRET')
      : variant === 'shared' && args[2] === 'DB' ? [{ success: true, results: [] }, { success: true, results: [] }]
        : variant === 'preview' && args[2] === 'PREVIEW_ROUTES' ? [{ success: true, results: [] }, { success: true, results: [] }]
          : run(args);
    await assert.rejects(apiPreflight(options), /Configure deployed API|Apply remote/);
    assert.equal(calls.some(([kind]) => kind === 'http'), false);
  }
});

test('enabled BFF refuses release with missing credentials and gives local setup commands', async () => {
  for (const missing of [
    ['BFF_CLOUDFLARE_ACCOUNT_ID'], ['BFF_CLOUDFLARE_API_TOKEN'],
    ['BFF_CLOUDFLARE_ACCOUNT_ID', 'BFF_CLOUDFLARE_API_TOKEN'],
  ]) {
    const { options, calls } = fixture();
    const run = options.run;
    options.run = args => {
      const result = run(args);
      return args[0] === 'secret' ? result.filter(item => !missing.includes(item.name)) : result;
    };
    await assert.rejects(apiPreflight(options), error => {
      assert.match(error.message, /BFF is enabled but mainbrella-api is missing/);
      for (const name of missing) assert.ok(error.message.includes(`npx wrangler secret put ${name}`));
      assert.match(error.message, /Account > D1 > Edit/);
      return true;
    });
    assert.equal(calls.length, 1, 'stop at secret metadata before migration reads or publication');
  }
});

test('BFF account ID may be configured as a nonsecret variable in a separate account', async () => {
  const { options } = fixture();
  options.api.vars.BFF_CLOUDFLARE_ACCOUNT_ID = 'a'.repeat(32);
  const run = options.run;
  options.run = args => {
    const result = run(args);
    return args[0] === 'secret' ? result.filter(item => item.name !== 'BFF_CLOUDFLARE_ACCOUNT_ID') : result;
  };
  assert.equal((await apiPreflight(options)).activeBindings, true);
  options.api.vars.BFF_CLOUDFLARE_ACCOUNT_ID = 'invalid';
  await assert.rejects(apiPreflight(options), /32-character Cloudflare account ID/);
});

test('enabled BFF requires its isolation loader; disabled BFF needs no loader or credentials', async () => {
  const { options, calls } = fixture();
  options.api.worker_loaders = [];
  await assert.rejects(apiPreflight(options), /BFF_LOADER Worker Loader/);
  assert.deepEqual(calls, []);
  options.api.vars.BFF_ENABLED = 'false';
  const run = options.run;
  options.run = args => {
    const result = run(args);
    return args[0] === 'secret' ? result.filter(item => !item.name.startsWith('BFF_')) : result;
  };
  assert.equal((await apiPreflight(options)).activeBindings, true);
});

test('missing active runtime exports or bindings give bootstrap guidance', async () => {
  for (const change of [
    r => { delete r['mainbrella-api'].script_runtime.exports.AccountActivity; },
    r => { delete r['mainbrella-containers'].script_runtime.exports.UserContainer; },
    r => { r['mainbrella-containers'].bindings = []; },
    r => { r['mainbrella-admin'].bindings = [d1]; },
    r => { r['mainbrella-api'].bindings = r['mainbrella-api'].bindings.filter(item => item.name !== 'ADMIN_API'); },
  ]) {
    const { options, resources } = fixture();
    change(resources);
    await assert.rejects(apiPreflight(options), /deploy:bootstrap-activity/);
  }
});

test('legacy D1 id field in active version metadata remains compatible', async () => {
  const { options, resources } = fixture();
  for (const name of ['mainbrella-api', 'mainbrella-admin', 'mainbrella-marketing']) {
    const binding = resources[name].bindings.find(item => item.name === 'DB');
    binding.id = binding.database_id;
    delete binding.database_id;
  }
  assert.equal((await apiPreflight(options)).activeBindings, true);
});

test('enabled security features cannot bypass coordinated provisioning', async () => {
  const { options, calls } = fixture();
  options.api.vars.EGRESS_POLICIES_ENABLED = 'true';
  await assert.rejects(apiPreflight(options), /coordinated security provisioning/);
  assert.deepEqual(calls, []);
});

test('unreadable deployment metadata and wrong shared database refuse release', async () => {
  const { options, resources } = fixture();
  resources['mainbrella-marketing'].bindings[0].database_id = 'other';
  await assert.rejects(apiPreflight(options), /does not share the API database/);
  const fail = fixture().options;
  fail.request = async () => Response.json({ success: false }, { status: 403 });
  await assert.rejects(apiPreflight(fail), /Cannot read deployed/);
});
