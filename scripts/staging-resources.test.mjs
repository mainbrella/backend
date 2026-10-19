import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STAGING } from './staging-config.mjs';
import { provisionStaging } from './staging-resources.mjs';

const env = { CLOUDFLARE_API_TOKEN: 'test-token', CLOUDFLARE_ACCOUNT_ID: STAGING.accountId };
const databaseId = '00000000-0000-4000-8000-000000000001';
const previewDatabaseId = '00000000-0000-4000-8000-000000000002';
const ok = (result, result_info) => ({ ok: true, json: async () => ({ success: true, result, result_info }) });

function cloudflareMock({ databases = [], buckets = [], pages = false } = {}) {
  const calls = [];
  const request = async (address, options) => {
    const url = new URL(address);
    const path = url.pathname.replace(`/client/v4/accounts/${STAGING.accountId}`, '');
    calls.push({ path, method: options.method, body: options.body && JSON.parse(options.body), headers: options.headers, url });
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${env.CLOUDFLARE_API_TOKEN}`);
    if (options.method === 'GET' && path === '/d1/database') {
      if (pages) {
        const page = Number(url.searchParams.get('page'));
        const result = page === 1 ? [{ name: 'unrelated', uuid: '00000000-0000-4000-8000-000000000009' }] : databases;
        return ok(result, { total_count: 1 + databases.length, page });
      }
      return ok(databases, { total_count: databases.length, page: 1 });
    }
    if (options.method === 'GET' && path === '/r2/buckets') {
      if (pages) {
        if (!url.searchParams.has('cursor')) return ok({ buckets: [{ name: 'unrelated' }] }, { cursor: 'next' });
        assert.equal(url.searchParams.get('cursor'), 'next');
      }
      return ok({ buckets });
    }
    if (options.method === 'POST' && path === '/d1/database') {
      const { name } = JSON.parse(options.body);
      assert.ok([STAGING.databaseName, STAGING.previewDatabaseName].includes(name));
      const row = { name, uuid: name === STAGING.databaseName ? databaseId : previewDatabaseId };
      databases.push(row);
      return ok(row);
    }
    if (options.method === 'POST' && path === '/r2/buckets') {
      assert.deepEqual(JSON.parse(options.body), { name: STAGING.bucketName });
      const row = { name: STAGING.bucketName };
      buckets.push(row);
      return ok(row);
    }
    throw new Error(`Unexpected request: ${options.method} ${path}`);
  };
  return { request, calls };
}

test('resource discovery reads every page and never mutates existing resources', async () => {
  const mock = cloudflareMock({
    databases: [{ name: STAGING.databaseName, uuid: databaseId }, { name: STAGING.previewDatabaseName, uuid: previewDatabaseId }],
    buckets: [{ name: STAGING.bucketName }], pages: true,
  });
  const resources = await provisionStaging({ env, request: mock.request });
  assert.deepEqual(resources, { databaseId, previewDatabaseId, bucketName: STAGING.bucketName });
  assert.ok(mock.calls.every(call => call.method === 'GET'));
  assert.equal(mock.calls.filter(call => call.path === '/d1/database').length, 2);
  assert.equal(mock.calls.filter(call => call.path === '/r2/buckets').length, 2);
});

test('read-only discovery gives exact missing names', async () => {
  const mock = cloudflareMock();
  await assert.rejects(provisionStaging({ env, request: mock.request }), /Missing staging resources: D1 delta-stg, D1 mainbrella-stg-preview-routes, R2 mainbrella-stg-storage/);
  assert.ok(mock.calls.every(call => call.method === 'GET'));
});

test('creation is allowlisted, supports partial reruns, and becomes idempotent', async () => {
  const mock = cloudflareMock({ databases: [{ name: STAGING.databaseName, uuid: databaseId }] });
  const resources = await provisionStaging({ env, request: mock.request, create: true });
  assert.deepEqual(resources, { databaseId, previewDatabaseId, bucketName: STAGING.bucketName });
  assert.deepEqual(mock.calls.filter(call => call.method === 'POST').map(call => [call.path, call.body]), [
    ['/d1/database', { name: STAGING.previewDatabaseName }],
    ['/r2/buckets', { name: STAGING.bucketName }],
  ]);
  mock.calls.length = 0;
  await provisionStaging({ env, request: mock.request, create: true });
  assert.ok(mock.calls.every(call => call.method === 'GET'));
});

test('credentials, account, malformed IDs, and provider failures fail closed without leaking payloads', async () => {
  const mock = cloudflareMock();
  await assert.rejects(provisionStaging({ env: {}, request: mock.request }), /CLOUDFLARE_API_TOKEN/);
  await assert.rejects(provisionStaging({ env: { ...env, CF_ACCOUNT_ID: 'wrong' }, request: mock.request }), /CF_ACCOUNT_ID/);
  assert.equal(mock.calls.length, 0);
  const bad = cloudflareMock({
    databases: [{ name: STAGING.databaseName, uuid: '41be6d7b-26fb-4701-a3fb-fdf3454e14f9' }, { name: STAGING.previewDatabaseName, uuid: previewDatabaseId }],
    buckets: [{ name: STAGING.bucketName }],
  });
  await assert.rejects(provisionStaging({ env, request: bad.request }), /production D1/);
  const failed = async () => ({ ok: false, status: 403, text: async () => 'secret-provider-response' });
  await assert.rejects(provisionStaging({ env, request: failed }), error => {
    assert.match(error.message, /HTTP 403/);
    assert.doesNotMatch(error.message, /secret-provider-response|test-token/);
    return true;
  });
});

test('unsafe existing D1 IDs stop a partial provisioning run before any create request', async () => {
  for (const uuid of ['41be6d7b-26fb-4701-a3fb-fdf3454e14f9', '41BE6D7B-26FB-4701-A3FB-FDF3454E14F9', 'malformed']) {
    const mock = cloudflareMock({ databases: [{ name: STAGING.databaseName, uuid }] });
    await assert.rejects(provisionStaging({ env, request: mock.request, create: true }),
      /production D1|valid D1 database UUID/);
    assert.ok(mock.calls.every(call => call.method === 'GET'));
  }
});
