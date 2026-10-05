import test from 'node:test';
import assert from 'node:assert/strict';
import { validateImage } from './terminal-image.mjs';
const account = 'example-account';
const image = `registry.cloudflare.com/${account}/mainbrella-terminal@sha256:${'a'.repeat(64)}`;
const manifest = { image, dockerfileHash: 'current' };

test('deploy uses the exact published digest for the current Dockerfile', () => {
  assert.equal(validateImage(manifest, account, 'current'), image);
});
test('deploy rejects unpinned, malformed, external and wrong-account images', () => {
  for (const invalid of [image.replace('@sha256:', ':latest@sha256:'), image.replace(account, 'other'), image.replace('mainbrella-terminal', 'other'), image.replace('registry.cloudflare.com', 'docker.io'), image.slice(0, -1), undefined]) {
    assert.throws(() => validateImage({ ...manifest, image: invalid }, account, 'current'), /Image must be pinned/);
  }
});
test('deploy rejects an image built from an outdated Dockerfile', () => {
  assert.throws(() => validateImage(manifest, account, 'changed'), /different Dockerfile/);
});
