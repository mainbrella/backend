import test from 'node:test';
import assert from 'node:assert/strict';
import { importAppManifest } from './github-import-registration.mjs';

test('Import registration is public, strictly read-only, and separate from Build publishing', () => {
  const manifest = importAppManifest('http://127.0.0.1:43187/callback');
  assert.deepEqual(manifest.default_permissions, { contents: 'read', metadata: 'read' });
  assert.equal(manifest.public, true); assert.equal(manifest.hook_attributes.active, false);
  assert.equal(manifest.request_oauth_on_install, false);
  assert.ok(manifest.callback_urls.includes('https://api.mainbrella.com/github/import/callback'));
  assert.equal(manifest.setup_url, 'https://api.mainbrella.com/github/import/setup');
  assert.match(manifest.description, /separate Build app/);
});
