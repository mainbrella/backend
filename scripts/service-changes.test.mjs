import test from 'node:test';
import assert from 'node:assert/strict';
import { checksForFiles } from './service-changes.mjs';

test('admin handlers and marketing template changes select only their service checks', () => {
  assert.deepEqual(checksForFiles(['worker/app/admin.ts', 'wrangler.admin.jsonc']), { full: false, services: ['admin'] });
  assert.deepEqual(checksForFiles(['worker/templates/marketing-email.ts', 'worker/lib/marketing-email.ts']), { full: false, services: ['marketing'] });
  assert.deepEqual(checksForFiles(['worker/admin.ts', 'worker/marketing.ts']), { full: false, services: ['admin', 'marketing'] });
});

test('shared contracts, authentication, migrations and unknown files always select full checks', () => {
  for (const file of ['worker/app/openapi-admin.ts', 'worker/app/openapi-marketing-email.ts', 'worker/shared/marketing-email-contract.ts',
    'worker/shared/admin.ts', 'worker/app/auth-core.ts', 'migrations/033_marketing_email_unsubscribe.sql',
    'worker/app/router.ts', 'scripts/dev.mjs', 'package-lock.json', 'new-unknown-file.ts']) {
    assert.deepEqual(checksForFiles(['worker/templates/marketing-email.ts', file]), { full: true, services: [] }, file);
  }
});
