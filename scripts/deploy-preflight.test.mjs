import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { preflight } from './deploy-preflight.mjs';

function fixture() {
  const calls = [];
  const options = {
    api: { account_id: 'account', routes: [{ pattern: 'api.mainbrella.com', custom_domain: true }],
      durable_objects: { bindings: [{ name: 'USER_CONTAINER', class_name: 'UserContainer', script_name: 'private' }] },
      d1_databases: [{ binding: 'DB', migrations_table: 'schema_migrations' }] },
    containers: { name: 'private', account_id: 'account' },
    migrations: ['007_image_deployment_lock.sql', '011_operational_status.sql'],
    env: { IMAGE_BUILD_SECRET: 's'.repeat(32), MONITORING_SECRET: 'm'.repeat(32) },
    run(args) {
      calls.push(args);
      return args[0] === 'secret' ? ['IMAGE_BUILD_SECRET', 'MONITORING_SECRET'].map(name => ({ name, type: 'secret_text' }))
        : [{ success: true, results: options.migrations.map(name => ({ name })) },
          { success: true, results: ['container_image_deployment_lock', 'status_observations', 'status_incidents'].map(name => ({ name })) }];
    },
    async request(url, init) {
      calls.push({ url, init });
      return url.endsWith('/capabilities') ? Response.json({ apiVersion: '2026-10-05',
        authentication: { apiKeys: true }, containers: { generationRequired: true, idempotentCreate: true },
        execution: { background: true }, files: { binary: true }, resources: [{ instance: 'lite' }] })
        : Response.json({ error: 'method_not_allowed' }, { status: 405 });
    },
  };
  return { options, calls };
}

test('compatible predecessor passes with only metadata reads and authenticated GET', async () => {
  const { options, calls } = fixture();
  assert.deepEqual(await preflight(options), { predecessorResources: [{ instance: 'lite' }] });
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0], ['secret', 'list', '--config', 'wrangler.jsonc', '--format', 'json']);
  assert.ok(calls[1].includes('--remote'));
  assert.match(calls[1].at(-1), /^SELECT name FROM schema_migrations; SELECT name FROM sqlite_master/);
  for (const call of calls.slice(2)) {
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.redirect, 'error');
    assert.ok(call.init.signal instanceof AbortSignal);
  }
  assert.deepEqual(calls[2].init.headers, {});
  assert.equal(calls[3].init.headers.Authorization, `Bearer ${options.env.IMAGE_BUILD_SECRET}`);
  assert.ok(calls.every(call => !JSON.stringify(call).includes('/manifest')));
});

test('wrong binding, account, domain or secrets fail before remote reads', async () => {
  for (const change of [
    o => { o.api.durable_objects.bindings[0].script_name = 'other'; },
    o => { o.api.account_id = 'other'; },
    o => { delete o.api.account_id; },
    o => { o.api.routes[0].pattern = 'attacker.example'; },
    o => { o.env.IMAGE_BUILD_SECRET = ''; },
    o => { o.env.MONITORING_SECRET = o.env.IMAGE_BUILD_SECRET; },
    o => { o.api.d1_databases[0].migrations_table = 'table; DELETE FROM users'; },
  ]) {
    const { options, calls } = fixture();
    change(options);
    await assert.rejects(preflight(options));
    assert.equal(calls.length, 0);
  }
});

test('missing remote secrets, unapplied migrations, missing tables and malformed CLI output block rollout', async () => {
  for (const result of [[], [{ name: 'IMAGE_BUILD_SECRET', type: 'secret_text' }],
    [{ success: true, results: [] }, { success: true, results: [] }],
    [{ success: true, results: [{ name: '007_image_deployment_lock.sql' }, { name: '011_operational_status.sql' }] }, { success: true, results: [] }],
    [{ success: false, results: [] }]]) {
    const { options } = fixture();
    const original = options.run;
    options.run = args => args[0] === (result[0]?.success !== undefined ? 'd1' : 'secret') ? result : original(args);
    await assert.rejects(preflight(options), /Missing deployed|Apply remote migrations|missing container_image|Cannot verify/);
  }
});

test('legacy or malformed capabilities and unavailable API block container-first rollout', async () => {
  for (const response of [Response.json({ apiVersion: '2026-10-05' }), Response.json({}, { status: 404 }), new Response('invalid')]) {
    const { options } = fixture();
    options.request = async () => response;
    await assert.rejects(preflight(options), /compatible predecessor/);
  }
  const { options } = fixture();
  options.request = async () => { throw new Error('sensitive transport details'); };
  await assert.rejects(preflight(options), error => /Cannot reach/.test(error.message) && !error.message.includes('sensitive'));
});

test('lock route must reject GET after authenticating; redirects, missing routes and wrong secrets fail', async () => {
  for (const [status, error] of [[401, 'not_authenticated'], [404, 'not_found'], [200, 'method_not_allowed'], [405, 'other']]) {
    const { options } = fixture();
    const original = options.request;
    options.request = (url, init) => url.endsWith('/capabilities') ? original(url, init) : Response.json({ error }, { status });
    await assert.rejects(preflight(options), /deployment-lock endpoint/);
  }
});

test('default deploy stops on preflight failure and preserves containers-before-API order', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(pkg.scripts.deploy, 'npm run deploy:preflight && npm run deploy:containers && npm run deploy:api');
});
