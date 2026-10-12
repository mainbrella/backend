import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { imageAccessPreflight } from './image-access-preflight.mjs';

const config = { name: 'mainbrella-containers', account_id: 'a'.repeat(32) };
const env = { CLOUDFLARE_ACCOUNT_ID: config.account_id, CLOUDFLARE_API_TOKEN: 'test-token-never-print' };

test('image access checks the exact pinned service using only GET and never follows redirects', async () => {
  const calls = [];
  const result = await imageAccessPreflight({ config, env, request: async (url, options) => {
    calls.push(url);
    assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${config.account_id}/workers/services/mainbrella-containers`);
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, `Bearer ${env.CLOUDFLARE_API_TOKEN}`);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ success: true, result: { default_environment: { script: { tag: 'owned-service' } } } });
  } });
  assert.equal(calls.length, 1);
  assert.equal(result.serviceMetadataReadable, true);
  assert.equal(result.deploymentQualified, false);
  assert.ok(!JSON.stringify(result).includes(env.CLOUDFLARE_API_TOKEN));
});

test('wrong account, target or missing Actions credential fail before network access', async () => {
  for (const options of [{ env: {} }, { env: { ...env, CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(32) } },
    { config: { ...config, name: 'replacement-worker' } }, { config: { ...config, account_id: '../elsewhere' } }]) {
    await assert.rejects(imageAccessPreflight({ config, env, ...options, request: () => { assert.fail('must not contact provider'); } }));
  }
});

test('provider failures explain access limits without reflecting credentials or raw errors', async () => {
  const leak = env.CLOUDFLARE_API_TOKEN;
  for (const request of [
    async () => { throw new Error(leak); },
    async () => new Response(leak, { status: 502 }),
    async () => Response.json({ success: false, errors: [{ message: leak }] }, { status: 403 }),
    async () => Response.json({ success: false }, { status: 404 }),
    async () => Response.json({ success: true, result: {} }),
  ]) {
    await assert.rejects(imageAccessPreflight({ config, env, request }), error => {
      assert.ok(!error.message.includes(leak));
      assert.match(error.message, /[Nn]o resources were changed/);
      return true;
    });
  }
});

test('the read-only workflow operation cannot admit build, publication or reconcile jobs', () => {
  const workflow = readFileSync(new URL('../.github/workflows/custom-image.yml', import.meta.url), 'utf8');
  assert.match(workflow, /options: \[build, reconcile, preflight\]/);
  for (const job of ['prepare', 'publish']) {
    const block = workflow.slice(workflow.indexOf(`  ${job}:`));
    assert.match(block.split('\n')[1], /inputs\.operation != 'preflight'/);
  }
  const reconcile = workflow.slice(workflow.indexOf('  reconcile:')).split('\n')[1];
  assert.match(reconcile, /inputs\.operation == 'reconcile' \|\| github\.event_name == 'schedule'/);
  const check = workflow.slice(workflow.indexOf('  preflight:'));
  assert.match(check, /inputs\.operation == 'preflight'/);
  assert.match(check, /run: npm run images:preflight/);
  assert.doesNotMatch(check, /deploy:|IMAGE_BUILD_SECRET|publish-image|prepare-image/);
});
