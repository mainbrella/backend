import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from './router';
import { capabilitiesSchema } from './openapi-capabilities';
import { MAX_EXECUTIONS, MAX_TIMEOUT_MS, MAX_OUTPUT_BYTES } from '../../containers/command-contract.js';
import { MAX_FILE_BYTES } from '../../containers/file-contract.js';

test('public discovery needs no bindings, matches runtime limits and parses against its response schema', async () => {
  const response = await handleRequest(new Request('https://api.mainbrella.com/capabilities'), {} as Env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const value = capabilitiesSchema.parse(await response.json());
  assert.equal(value.execution.maxConcurrentOperations, MAX_EXECUTIONS);
  assert.equal(value.execution.maxTimeoutMs, MAX_TIMEOUT_MS);
  assert.equal(value.execution.maxOutputBytes, MAX_OUTPUT_BYTES);
  assert.equal(value.files.maxFileBytes, MAX_FILE_BYTES);
  assert.equal(value.images.customBuilds, false);
  assert.equal(value.persistence.filesystemAfterStop, false);
  assert.equal(value.networking.regionSelection, false);
  assert.equal(value.containers.accountLimitsPath, '/containers');
});

test('discovery enforces method/query/CORS and exposes configuration without revealing secrets', async () => {
  const env = { IMAGE_BUILD_SECRET: 'private-build-secret', IMAGE_BUILD_GITHUB_TOKEN: 'private-github-token' } as Env;
  const call = (method = 'GET', suffix = '', origin?: string) => handleRequest(new Request(`https://api.mainbrella.com/capabilities${suffix}`,
    { method, headers: origin ? { Origin: origin } : {} }), env);
  const response = await call('GET', '', 'https://mainbrella.com');
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://mainbrella.com');
  const text = await response.text();
  assert.equal(JSON.parse(text).images.customBuilds, true);
  assert.ok(!text.includes('private-'));
  assert.equal((await call('POST')).status, 405);
  assert.equal((await call('HEAD')).status, 405);
  assert.equal((await call('GET', '?account=victim')).status, 400);
  assert.equal((await call('GET', '', 'https://attacker.example')).status, 403);
  assert.equal((await call('OPTIONS', '', 'https://mainbrella.com')).status, 204);
});
