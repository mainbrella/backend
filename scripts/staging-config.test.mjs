import { stagingTestRoot } from './staging-test-fixtures.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { targetFor } from './staging-targets.mjs';
import { STAGING, assertStagingConfig as sourceAssertStagingConfig, stagingConfig as sourceStagingConfig } from './staging-config.mjs';
import { IMAGE_CATALOG } from '../containers/image-catalog.js';

const root = stagingTestRoot();
const assertStagingConfig = (name, config, options = {}) => sourceAssertStagingConfig(name, config, { directory: root, ...options });
const stagingConfig = (name, options = {}) => sourceStagingConfig(name, { directory: root, ...options });
const targets = ['api', 'admin', 'marketing', 'containers', 'previews', 'site', 'builder', 'raindrop'];
const resources = {
  databaseId: '00000000-0000-4000-8000-000000000001',
  previewDatabaseId: '00000000-0000-4000-8000-000000000002',
  bucketName: STAGING.bucketName,
};
const sourcePath = target => {
  const entry = targetFor(target);
  return join(root, entry.directory, entry.config);
};

test('all staging workers use isolated names, only assigned routes, and unchanged source files', () => {
  const before = new Map(targets.map(target => [target, readFileSync(sourcePath(target))]));
  const patterns = {
    api: ['api-stg.mainbrella.com'],
    admin: [], marketing: [], containers: [],
    previews: ['stg.mainbrella.dev', 'https://stg.mainbrella.dev/*', 'https://*.stg.mainbrella.dev/*'],
    site: ['stg.mainbrella.com'], builder: ['stg.mainbrella.com/build/*'],
    raindrop: ['raindrop-stg.mainbrella.com'],
  };
  for (const target of targets) {
    const config = stagingConfig(target, { resources });
    assert.equal(config.name, `${targetFor(target).worker}-stg`);
    assert.deepEqual((config.routes ?? []).map(route => route.pattern), patterns[target]);
    assert.equal(config.vars.DEPLOYMENT_ENVIRONMENT, 'staging');
    assert.equal(config.workers_dev, false);
    assert.equal(config.preview_urls, false);
    assertStagingConfig(target, config, { resources });
    assert.deepEqual(readFileSync(sourcePath(target)), before.get(target));
  }
});

test('staging backend bindings and provider defaults cannot reach production resources', () => {
  const api = stagingConfig('api', { resources });
  const admin = stagingConfig('admin', { resources });
  const marketing = stagingConfig('marketing', { resources });
  const previews = stagingConfig('previews', { resources });
  const containers = stagingConfig('containers', { resources });
  assert.deepEqual(api.d1_databases.map(db => [db.database_name, db.database_id]), [
    [STAGING.databaseName, resources.databaseId],
    [STAGING.previewDatabaseName, resources.previewDatabaseId],
  ]);
  assert.equal(api.r2_buckets[0].bucket_name, STAGING.bucketName);
  assert.deepEqual(api.services.map(service => service.service), ['mainbrella-admin-stg', 'mainbrella-marketing-stg']);
  assert.deepEqual(api.ratelimits.map(rate => rate.namespace_id), ['11004', '11002', '11003']);
  assert.equal(api.workflows[0].name, 'mainbrella-build-stg');
  assert.equal(api.vars.VOICE_PUBLIC_ORIGIN, STAGING.apiOrigin);
  assert.equal(api.vars.PREVIEW_DOMAIN, STAGING.previewDomain);
  assert.equal(api.vars.R2_BILLING_MODE, 'off');
  for (const config of [api, admin, marketing, previews, containers]) {
    assert.equal(config.vars.EMAIL_DELIVERY_ENABLED, 'false');
    assert.equal(config.send_email, undefined);
    assert.equal(config.vars.PROJECT_HOSTING_ENABLED, 'false');
    assert.equal(config.vars.NAMECOM_ENABLED, 'false');
    assert.equal(config.vars.VOICE_ENABLED, 'false');
    assert.equal(config.vars.EGRESS_POLICIES_ENABLED, 'false');
    assert.equal(config.vars.SECRETS_VAULT_ENABLED, 'false');
    assert.ok(Object.keys(config.vars).every(name => !/^(TELNYX_|VOICE_AI_GATEWAY_|STRIPE_|NAME_DOT_COM_)/.test(name)));
    for (const binding of config.durable_objects?.bindings ?? []) {
      if (binding.script_name) assert.match(binding.script_name, /-stg$/);
    }
  }
  assert.equal(admin.d1_databases[0].database_id, resources.databaseId);
  assert.equal(marketing.d1_databases[0].database_id, resources.databaseId);
  assert.equal(previews.d1_databases[0].database_id, resources.previewDatabaseId);
  assert.equal(containers.containers[0].ssh, undefined);
  assert.equal(containers.containers[0].authorized_keys, undefined);
  assert.equal(previews.routes.some(route => route.pattern === '*/*'), false);
});

test('stage preview apex has an exact route ahead of the production wildcard route', () => {
  const production = JSON.parse(readFileSync(sourcePath('previews'), 'utf8'));
  assert.ok(production.routes.some(route => route.pattern === 'https://*.mainbrella.dev/*'));
  const staging = stagingConfig('previews', { resources });
  const apex = staging.routes.find(route => route.pattern === 'https://stg.mainbrella.dev/*');
  assert.deepEqual(apex, { pattern: 'https://stg.mainbrella.dev/*', zone_id: production.routes[1].zone_id });
  assert.ok(staging.routes.some(route => route.pattern === 'stg.mainbrella.dev' && route.custom_domain));
  assertStagingConfig('previews', staging, { resources });
});

test('validator rejects changes to stage identity, routes, bindings, and safety defaults', () => {
  const mutations = [
    config => { config.name = 'mainbrella-api'; },
    config => { config.routes[0].pattern = 'api.mainbrella.com'; },
    config => { config.d1_databases[0].database_id = '41be6d7b-26fb-4701-a3fb-fdf3454e14f9'; },
    config => { config.r2_buckets[0].bucket_name = 'romeo'; },
    config => { config.services[0].service = 'mainbrella-admin'; },
    config => { config.durable_objects.bindings[3].script_name = 'mainbrella-containers'; },
    config => { config.workflows[0].name = 'mainbrella-build'; },
    config => { config.ratelimits[0].namespace_id = '1004'; },
    config => { config.vars.VOICE_ENABLED = 'true'; },
    config => { config.send_email = [{ name: 'WELCOME_EMAIL' }]; },
  ];
  for (const mutate of mutations) {
    const config = stagingConfig('api', { resources });
    mutate(config);
    assert.throws(() => assertStagingConfig('api', config, { resources }));
  }
  const previews = stagingConfig('previews', { resources });
  previews.routes.push({ pattern: '*/*', zone_id: 'e6597a41a75e1abb92f4bc5e5758c460' });
  assert.throws(() => assertStagingConfig('previews', previews, { resources }));
});

test('resource IDs must be distinct from each other and from production', () => {
  assert.throws(() => stagingConfig('api', { resources: { ...resources, databaseId: resources.previewDatabaseId } }));
  assert.throws(() => stagingConfig('api', { resources: { ...resources, databaseId: resources.previewDatabaseId.toUpperCase() } }));
  assert.throws(() => stagingConfig('api', { resources: { ...resources, databaseId: '41be6d7b-26fb-4701-a3fb-fdf3454e14f9' } }));
  assert.throws(() => stagingConfig('api', { resources: { ...resources, databaseId: '41BE6D7B-26FB-4701-A3FB-FDF3454E14F9' } }));
  assert.throws(() => stagingConfig('api', { resources: { ...resources, previewDatabaseId: 'd5f35d95-114c-4b71-9060-e99514136671' } }));
  assert.throws(() => stagingConfig('api', { resources: { ...resources, bucketName: 'romeo' } }));
  assert.throws(() => stagingConfig('redirect', { resources }));
});

test('a new production variable is not inherited by staging', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'canopy-staging-config-'));
  try {
    mkdirSync(join(temporary, '.'), { recursive: true });
    const source = JSON.parse(readFileSync(sourcePath('api'), 'utf8'));
    source.vars.NEW_PROVIDER_SECRET = 'do-not-copy';
    writeFileSync(join(temporary, 'wrangler.jsonc'), JSON.stringify(source));
    const config = stagingConfig('api', { resources, directory: temporary });
    assert.equal(config.vars.NEW_PROVIDER_SECRET, undefined);
    assertStagingConfig('api', config, { resources, directory: temporary });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('unsupported source bindings fail before a staging configuration is generated', () => {
  const original = readFileSync(sourcePath('api'));
  for (const change of [
    source => { source.kv_namespaces = [{ binding: 'CACHE', id: 'production-kv-id' }]; },
    source => { source.env = { staging: { d1_databases: [{ binding: 'DB', database_id: 'production-id' }] } }; },
    source => { source.durable_objects.bindings[0].namespace_id = 'production-namespace'; },
    source => { source.services[0].environment = 'production'; },
    source => { source.r2_buckets.push({ binding: 'PRODUCTION', bucket_name: 'romeo' }); },
  ]) {
    const temporary = mkdtempSync(join(tmpdir(), 'canopy-staging-unsupported-'));
    try {
      mkdirSync(join(temporary, '.'), { recursive: true });
      const source = JSON.parse(original);
      change(source);
      writeFileSync(join(temporary, 'wrangler.jsonc'), JSON.stringify(source));
      assert.throws(() => stagingConfig('api', { resources, directory: temporary }), /Unsupported staging source config/);
      assert.deepEqual(readFileSync(sourcePath('api')), original);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
});

test('container validator permits only immutable same-account registry image replacements', () => {
  const images = Object.fromEntries(IMAGE_CATALOG.map(entry => [entry.key, {
    image: `registry.cloudflare.com/${STAGING.accountId}/${entry.repository}@sha256:${'a'.repeat(64)}`,
  }]));
  const config = () => {
    const result = stagingConfig('containers', { resources });
    result.containers[0].images = structuredClone(images);
    return result;
  };
  assertStagingConfig('containers', config(), { resources });
  for (const mutate of [
    c => { c.containers[0].images.terminal.image = images.terminal.image.replace(STAGING.accountId, '0'.repeat(32)); },
    c => { c.containers[0].images.terminal.image = images.terminal.image.replace('@sha256:', ':latest-'); },
    c => { c.containers[0].images.terminal.image = images.python.image; },
    c => { c.containers[0].images.custom = images.python; },
    c => { c.containers[0].images.python.build_context = '.'; },
  ]) {
    const altered = config();
    mutate(altered);
    assert.throws(() => assertStagingConfig('containers', altered, { resources }));
  }
});
