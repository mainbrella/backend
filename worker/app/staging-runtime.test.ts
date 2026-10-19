import test from 'node:test';
import assert from 'node:assert/strict';
import { publicApiOrigin, publicWebOrigin } from '../lib/deployment-environment';
import { githubCallbackURL } from '../lib/github-import';
import { githubBuildCallbackURL } from '../lib/github-build';
import { imageBuildsConfigured } from '../lib/image-build-options';
import { stripeKeyAllowed, stripeRequest, type BillingEnv } from '../lib/stripe';
import { handleImageBuildRequest } from './images';
import { handleSSHRequest } from './ssh';
import { registrarConfigured } from '../lib/namecom';
import { voiceEnabled } from '../lib/voice';

test('staging URLs use stage hosts while production and local callbacks keep their origins', () => {
  const staging = { DEPLOYMENT_ENVIRONMENT: 'staging' } as Env;
  assert.equal(publicApiOrigin(staging), 'https://api-stg.mainbrella.com');
  assert.equal(publicWebOrigin(staging), 'https://stg.mainbrella.com');
  assert.equal(githubCallbackURL(staging), 'https://api-stg.mainbrella.com/github/import/callback');
  assert.equal(githubBuildCallbackURL(staging), 'https://api-stg.mainbrella.com/github/build/callback');
  assert.equal(githubCallbackURL({ ...staging, LOCAL_DEV: 'true' }), 'http://localhost:8787/github/import/callback');
  assert.equal(publicApiOrigin(), 'https://api.mainbrella.com');
  assert.equal(publicWebOrigin(), 'https://mainbrella.com');
});

test('staging cannot call Stripe with a live key and accepts test keys', async t => {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return Response.json({ id: 'test' });
  });
  const live = { DEPLOYMENT_ENVIRONMENT: 'staging', STRIPE_SECRET_KEY: 'sk_live_example' } as BillingEnv;
  assert.equal(stripeKeyAllowed(live), false);
  await assert.rejects(stripeRequest(live, '/customers'), { message: 'billing_unavailable' });
  assert.deepEqual(calls, []);
  const safe = { ...live, STRIPE_SECRET_KEY: 'sk_test_example' } as BillingEnv;
  assert.equal(stripeKeyAllowed(safe), true);
  assert.deepEqual(await stripeRequest(safe, '/customers'), { id: 'test' });
  assert.deepEqual(calls, ['https://api.stripe.com/v1/customers']);
});

test('staging disables production image callbacks and SSH defaults', async () => {
  const env = { DEPLOYMENT_ENVIRONMENT: 'staging', IMAGE_BUILD_SECRET: 'x'.repeat(32), IMAGE_BUILD_GITHUB_TOKEN: 'token',
    IMAGE_BUILD_GITHUB_REPOSITORY: 'mainbrella/private-image-builder', SSH_GATEWAY_SECRET: 'x'.repeat(32) } as unknown as Env;
  assert.equal(imageBuildsConfigured(env), false);
  assert.equal(registrarConfigured({ ...env, NAMECOM_ENABLED: 'true', NAME_DOT_COM_USERNAME: 'operator', NAME_DOT_COM_TOKEN: 'token' }), false);
  assert.equal(voiceEnabled({ ...env, VOICE_ENABLED: 'true', AI: {} as Env['AI'], RECEPTIONIST_CALL: {} as Env['RECEPTIONIST_CALL'] }), false);
  assert.equal((await handleImageBuildRequest(new Request('https://api-stg.mainbrella.com/internal/image-builds/manifest'), env)).status, 503);
  assert.deepEqual(await (await handleSSHRequest(new Request('https://api-stg.mainbrella.com/ssh/validate', { method: 'POST' }), env)).json(),
    { error: 'ssh_unavailable' });
});
