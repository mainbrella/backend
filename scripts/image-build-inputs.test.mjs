import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSourceArtifact, prepareImageInputs, MAX_IMAGE_BYTES } from './image-build-inputs.mjs';

const accountId = 'a'.repeat(32);
const base = { image: `ghcr.io/example/private@sha256:${'b'.repeat(64)}`, username: 'customer', password: 'private-pull-token' };
const cache = `registry.cloudflare.com/${accountId}/mainbrella-custom-00000000-0000-0000-0000-000000000001@sha256:${'c'.repeat(64)}`;
function fixture(source, overrides = {}) {
  const calls = [], artifacts = {};
  return { calls, artifacts, options: { source, accountId, defaultBase: async () => 'registry.cloudflare.com/base@sha256:abc',
    cloudflareCredentials: async () => ({ username: 'platform', password: 'platform-pull-token' }),
    write(path, content) { artifacts[path] = content; },
    run(command, args, options) {
      calls.push({ command, args, options });
      if (args[0] === 'image') return JSON.stringify([{ Os: 'linux', Architecture: 'amd64', Size: 100, ...overrides }]);
    },
  } };
}

test('only allowlisted source fields enter the untrusted build artifact', () => {
  assert.deepEqual(buildSourceArtifact({ dockerfile: 'FROM mainbrella:base', contextBase64: null, baseImage: base, cacheImage: cache, token: 'extra' }),
    { dockerfile: 'FROM mainbrella:base', contextBase64: null });
});

test('private base and owner-selected cache are pulled and saved without executing images or persisting credentials', async () => {
  const f = fixture({ dockerfile: 'FROM mainbrella:base', contextBase64: null, baseImage: base, cacheImage: cache });
  await prepareImageInputs(f.options);
  assert.doesNotMatch(JSON.stringify(f.artifacts), /password|private-pull-token|platform-pull-token|username/);
  assert.equal(f.calls.some(call => call.args.includes('run') || call.args.includes('build')), false);
  const logins = f.calls.filter(call => call.args[0] === 'login');
  assert.deepEqual(logins.map(call => [call.args[1], call.options.input]), [['ghcr.io', 'private-pull-token'], ['registry.cloudflare.com', 'platform-pull-token']]);
  assert.ok(logins.every(call => call.args.includes('--password-stdin') && !call.args.includes(call.options.input)));
  assert.deepEqual(f.calls.filter(call => call.args[0] === 'save').map(call => call.args), [
    ['save', '-o', 'prepared/base.tar', 'mainbrella:base'], ['save', '-o', 'prepared/cache.tar', 'mainbrella:cache'],
  ]);
  assert.equal(f.calls.filter(call => call.args[0] === 'logout').length, 2);
});

test('oversize and wrong-platform images fail before artifact export and still log out', async () => {
  for (const overrides of [{ Size: MAX_IMAGE_BYTES + 1 }, { Size: 0 }, { Os: 'windows' }, { Architecture: 'arm64' }]) {
    const f = fixture({ dockerfile: '', contextBase64: null, baseImage: base }, overrides);
    await assert.rejects(prepareImageInputs(f.options));
    assert.equal(f.calls.some(call => call.args[0] === 'save'), false);
    assert.equal(f.calls.at(-1).args[0], 'logout');
  }
});

test('unexpected registry references fail before any Docker command', async () => {
  for (const source of [{ baseImage: { ...base, image: 'http://localhost/private' } }, { cacheImage: cache.replace(accountId, 'attacker') }]) {
    const f = fixture({ dockerfile: '', contextBase64: null, ...source });
    await assert.rejects(prepareImageInputs(f.options));
    assert.equal(f.calls.length, 0);
  }
});
