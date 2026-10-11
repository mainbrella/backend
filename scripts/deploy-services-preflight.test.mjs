import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { serviceConfiguration, servicePreflight, wrangler } from './deploy-services-preflight.mjs';

test('a missing admin Worker explains how to provision its Stripe secret before the first deployment', () => {
  const execute = () => {
    throw Object.assign(new Error('sensitive execution details'), {
      stderr: '\u001b[31mWorker "mainbrella-admin" not found.\u001b[0m\nsensitive configuration',
    });
  };
  assert.throws(() => wrangler(['secret', 'list', '--config', 'wrangler.admin.jsonc', '--format', 'json'], execute), error => {
    assert.match(error.message, /mainbrella-admin does not exist in the configured account/);
    assert.match(error.message, /npx wrangler secret put STRIPE_SECRET_KEY --config wrangler\.admin\.jsonc/);
    assert.match(error.message, /Confirm Worker creation/);
    assert.match(error.message, /npm run deploy:admin/);
    assert.doesNotMatch(error.message, /sensitive/);
    return true;
  });
});

test('Wrangler failures identify the failed metadata read without exposing output or assuming first rollout', () => {
  for (const [args, message] of [
    [['secret', 'list', '--config', 'wrangler.admin.jsonc', '--format', 'json'], /secret metadata/],
    [['d1', 'execute', 'DB', '--remote', '--json'], /database migration metadata/],
  ]) {
    for (const execute of [
      () => { throw Object.assign(new Error('sensitive execution details'), { stderr: 'Authentication error: sensitive token', stdout: 'sensitive configuration' }); },
      () => 'malformed JSON with sensitive configuration',
    ]) assert.throws(() => wrangler(args, execute), error => {
      assert.match(error.message, message);
      assert.doesNotMatch(error.message, /sensitive|does not exist|secret put/);
      return true;
    });
  }
});

function fixture(target) {
  const read = file => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
  const options = { target, api: read('wrangler.jsonc'), service: read(`wrangler.${target}.jsonc`),
    migrations: ['001_initial.sql', '002_auth_sessions.sql', '033_marketing_email_unsubscribe.sql'] };
  const calls = [];
  options.run = args => {
    calls.push(args);
    if (args[0] === 'secret') return [{ name: 'STRIPE_SECRET_KEY', type: 'secret_text' }];
    return [{ success: true, results: options.migrations.map(name => ({ name })) },
      { success: true, results: ['users', 'sessions', 'marketing_email_unsubscribes'].map(name => ({ name })) }];
  };
  return { options, calls };
}

test('scoped preflights verify shared migrations and service secrets using only metadata reads', () => {
  for (const target of ['admin', 'marketing']) {
    const { options, calls } = fixture(target);
    servicePreflight(options);
    assert.equal(calls.length, target === 'admin' ? 2 : 1);
    assert.deepEqual(calls[0].slice(0, 7), ['d1', 'execute', 'DB', '--config', `wrangler.${target}.jsonc`, '--remote', '--json']);
    assert.match(calls[0].at(-1), /^SELECT name FROM schema_migrations; SELECT name FROM sqlite_master/);
    if (target === 'admin') assert.deepEqual(calls[1], ['secret', 'list', '--config', 'wrangler.admin.jsonc', '--format', 'json']);
    assert.ok(calls.every(args => !args.some(arg => /deployment-lock|manifest|containers|previews/.test(arg))));
  }
});

test('local preflights need neither credentials nor remote requests', () => {
  for (const target of ['admin', 'marketing']) {
    const { options, calls } = fixture(target);
    servicePreflight({ ...options, local: true });
    assert.equal(calls.length, 0);
  }
});

test('services cannot change account, database, routing, migration ownership or Durable Object ownership', () => {
  for (const [target, mutate] of [
    ['admin', o => { o.service.account_id = 'other'; }],
    ['marketing', o => { o.service.d1_databases[0].database_id = 'other'; }],
    ['admin', o => { o.service.d1_databases[0].migrations_dir = 'migrations'; }],
    ['marketing', o => { o.service.workers_dev = true; }],
    ['admin', o => { o.service.routes = [{ pattern: 'admin.mainbrella.com', custom_domain: true }]; }],
    ['marketing', o => { o.api.services.find(b => b.binding === 'MARKETING_API').service = 'other'; }],
    ['admin', o => { o.service.durable_objects.bindings[0].script_name = 'other'; }],
    ['marketing', o => { o.service.durable_objects = { bindings: [{ name: 'CONTAINER_ACCOUNT' }] }; }],
    ['admin', o => { o.service.vars.R2_BILLING_MODE = 'off'; }],
    ['marketing', o => { o.service.send_email = []; }],
    ['marketing', o => { o.api.send_email.push({ name: 'MARKETING_EMAIL' }); }],
  ]) {
    const { options } = fixture(target);
    mutate(options);
    assert.throws(() => serviceConfiguration(target, options.api, options.service));
  }
});

test('missing migrations, database tables, malformed metadata or admin Stripe secret block publication', () => {
  for (const run of [
    () => [{ success: true, results: [] }, { success: true, results: [] }],
    () => [{ success: true, results: fixture('admin').options.migrations.map(name => ({ name })) }, { success: true, results: [] }],
    () => ({ success: true }),
  ]) assert.throws(() => servicePreflight({ ...fixture('admin').options, run }));
  const { options } = fixture('admin');
  const run = options.run;
  assert.throws(() => servicePreflight({ ...options, run: args => args[0] === 'secret' ? [] : run(args) }), /STRIPE_SECRET_KEY/);
});
