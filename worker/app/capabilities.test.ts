import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from './router';
import { capabilitiesSchema } from './openapi-capabilities';
import { MAX_EXECUTIONS, MAX_TIMEOUT_MS, MAX_OUTPUT_BYTES } from '../../containers/command-contract.js';
import { MAX_RETAINED_EXECUTIONS, MAX_RETAINED_EXECUTION_OUTPUT_BYTES, MAX_RETAINED_EXECUTION_EVENTS } from '../../containers/execution-contract.js';
import { MAX_FILE_BYTES } from '../../containers/file-contract.js';

test('public discovery needs no bindings, matches runtime limits and parses against its response schema', async () => {
  const response = await handleRequest(new Request('https://api.mainbrella.com/capabilities'), {} as Env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const value = capabilitiesSchema.parse(await response.json());
  assert.equal(value.execution.maxConcurrentOperations, MAX_EXECUTIONS);
  assert.equal(value.execution.maxTimeoutMs, MAX_TIMEOUT_MS);
  assert.equal(value.execution.maxOutputBytes, MAX_OUTPUT_BYTES);
  assert.equal(value.execution.maxRetainedExecutions, MAX_RETAINED_EXECUTIONS);
  assert.equal(value.execution.maxRetainedOutputBytes, MAX_RETAINED_EXECUTION_OUTPUT_BYTES);
  assert.equal(value.execution.maxRetainedEvents, MAX_RETAINED_EXECUTION_EVENTS);
  assert.equal(value.execution.retentionScope, 'container-slot');
  assert.equal(value.persistence.restoreLaunch, false);
  assert.equal(value.persistence.startupConfiguration, false);
  assert.equal(value.files.maxFileBytes, MAX_FILE_BYTES);
  assert.equal(value.images.customBuilds, false);
  assert.equal(value.images.repositoryLaunch, false);
  assert.equal(value.images.crossBuildCache, false);
  assert.equal(value.images.privateRegistryImports, false);
  assert.equal(value.pools.managed, false);
  assert.equal(value.pools.maxPoolSize, 20);
  assert.equal(value.pools.maxTtlSeconds, 86400);
  assert.equal(value.persistence.filesystemAfterStop, false);
  assert.equal(value.networking.regionSelection, false);
  assert.equal(value.networking.internetControl, false);
  assert.equal(value.containers.accountLimitsPath, '/containers');
});

test('discovery enforces method/query/CORS and exposes configuration without revealing secrets', async () => {
  const env = { IMAGE_BUILD_SECRET: 'private-build-secret', IMAGE_BUILD_GITHUB_TOKEN: 'private-github-token', IMAGE_BUILD_GITHUB_REPOSITORY: 'mainbrella/builds' } as Env;
  const call = (method = 'GET', suffix = '', origin?: string) => handleRequest(new Request(`https://api.mainbrella.com/capabilities${suffix}`,
    { method, headers: origin ? { Origin: origin } : {} }), env);
  const response = await call('GET', '', 'https://mainbrella.com');
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://mainbrella.com');
  const text = await response.text();
  assert.equal(JSON.parse(text).images.customBuilds, true);
  assert.equal(JSON.parse(text).images.crossBuildCache, true);
  assert.equal(JSON.parse(text).images.privateRegistryImports, false);
  assert.ok(!text.includes('private-'));
  assert.equal((await call('POST')).status, 405);
  assert.equal((await call('HEAD')).status, 405);
  assert.equal((await call('GET', '?account=victim')).status, 400);
  assert.equal((await call('GET', '', 'https://attacker.example')).status, 403);
  assert.equal((await call('OPTIONS', '', 'https://mainbrella.com')).status, 204);
});

test('managed pools and private registry discovery require complete deployment configuration', async () => {
  const env = { MANAGED_POOLS_ENABLED: 'true', USER_CONTAINER: {}, CONTAINER_ACCOUNT: {}, IMAGE_BUILD_SECRET: 'secret',
    IMAGE_BUILD_GITHUB_TOKEN: 'token', IMAGE_BUILD_GITHUB_REPOSITORY: 'mainbrella/private-builds', IMAGE_REGISTRY_ENCRYPTION_KEY: 'a'.repeat(64) } as unknown as Env;
  const read = async () => capabilitiesSchema.parse(await (await handleRequest(new Request('https://api.mainbrella.com/capabilities'), env)).json());
  assert.equal((await read()).pools.managed, true);
  assert.equal((await read()).images.privateRegistryImports, true);
  delete (env as Partial<Env>).USER_CONTAINER; assert.equal((await read()).pools.managed, false);
  env.IMAGE_BUILD_GITHUB_REPOSITORY = undefined;
  assert.equal((await read()).images.customBuilds, false);
  assert.equal((await read()).images.crossBuildCache, false);
  assert.equal((await read()).images.privateRegistryImports, false);
});


test('restore launch discovery requires all saved-workspace deployment bindings', async () => {
  const env = { USER_CONTAINER: {}, CONTAINER_ACCOUNT: {}, WORKSPACE_PERSISTENCE_ENABLED: 'true' } as unknown as Env;
  const read = async () => capabilitiesSchema.parse(await (await handleRequest(new Request('https://api.mainbrella.com/capabilities'), env)).json());
  assert.equal((await read()).persistence.restoreLaunch, true);
  assert.equal((await read()).persistence.startupConfiguration, true);
  assert.equal((await read()).persistence.memory, false);
  env.WORKSPACE_PERSISTENCE_ENABLED = 'false'; assert.equal((await read()).persistence.restoreLaunch, false);
  assert.equal((await read()).persistence.startupConfiguration, false);
  env.WORKSPACE_PERSISTENCE_ENABLED = 'true'; delete (env as Partial<Env>).CONTAINER_ACCOUNT;
  assert.equal((await read()).persistence.restoreLaunch, false);
  assert.equal((await read()).persistence.startupConfiguration, false);
  env.CONTAINER_ACCOUNT = {} as Env['CONTAINER_ACCOUNT']; delete (env as Partial<Env>).USER_CONTAINER;
  assert.equal((await read()).persistence.startupConfiguration, false);
});

test('repository custom image discovery is independent of build admission', async () => {
  const env = { DB: {}, USER_CONTAINER: {}, CONTAINER_ACCOUNT: {} } as unknown as Env;
  const read = async () => capabilitiesSchema.parse(await (await handleRequest(new Request('https://api.mainbrella.com/capabilities'), env)).json());
  assert.equal((await read()).images.repositoryLaunch, true);
  assert.equal((await read()).images.customBuilds, false);
  delete (env as Partial<Env>).DB;
  assert.equal((await read()).images.repositoryLaunch, false);
  env.DB = {} as Env['DB']; delete (env as Partial<Env>).CONTAINER_ACCOUNT;
  assert.equal((await read()).images.repositoryLaunch, false);
  env.CONTAINER_ACCOUNT = {} as Env['CONTAINER_ACCOUNT']; delete (env as Partial<Env>).USER_CONTAINER;
  assert.equal((await read()).images.repositoryLaunch, false);
});
