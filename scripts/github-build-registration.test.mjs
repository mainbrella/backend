import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAppManifest } from './github-build-registration.mjs';

test('Build registration requests repository contents write without workflow permissions and remains separate from Import', () => {
  const manifest = buildAppManifest('http://127.0.0.1:43188/callback');
  assert.deepEqual(manifest.default_permissions, { contents: 'write', metadata: 'read' });
  assert.equal(manifest.public, true); assert.equal(manifest.hook_attributes.active, false);
  assert.equal(manifest.request_oauth_on_install, false);
  assert.ok(manifest.callback_urls.includes('https://api.mainbrella.com/github/build/callback'));
  assert.equal(manifest.setup_url, 'https://api.mainbrella.com/github/build/setup');
  assert.equal('workflows' in manifest.default_permissions, false);
});
