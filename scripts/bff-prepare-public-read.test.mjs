import test from 'node:test';
import assert from 'node:assert/strict';
import { preparePublicRead } from './bff-prepare-public-read.mjs';
import { runtime } from '../worker/bff/system-test-helpers.ts';

test('preparation produces a usable public frontend config and safely retries project/data setup', async t => {
  const f = await runtime(t);
  const response = await f.mf.dispatchFetch('https://api.mainbrella.com/api-keys', {
    method: 'POST', headers: { cookie: 'mainbrella_session=owner', origin: 'https://mainbrella.com' }, body: JSON.stringify({ name: 'Setup' }),
  });
  assert.equal(response.status, 201);
  const { token: accountKey } = await response.json();
  const options = { accountKey, frontendOrigin: 'https://example-frontend.test' };
  const requestFetch = (input, init) => f.mf.dispatchFetch(input, init);
  const config = await preparePublicRead(options, requestFetch);
  assert.match(config.publicKey, /^bff_pk_[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(config).includes(accountKey));
  const url = `${config.apiOrigin}/bff/data/${config.projectId}/tables/${config.table}?select=*`;
  const read = await requestFetch(url, { headers: { apikey: config.publicKey, origin: options.frontendOrigin } });
  assert.equal(read.status, 200);
  assert.equal(read.headers.get('access-control-allow-origin'), options.frontendOrigin);
  assert.deepEqual((await read.json()).data.map(row => row.name), ['Coffee', 'Tea', 'Water']);
  const retry = await preparePublicRead(options, requestFetch);
  assert.equal(retry.projectId, config.projectId);
  assert.equal(f.databases.size, 1);
  const unchanged = await requestFetch(url, { headers: { apikey: config.publicKey } });
  assert.equal((await unchanged.json()).data.length, 3);
});
