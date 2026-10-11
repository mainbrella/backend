import test from 'node:test';
import assert from 'node:assert/strict';
import { checkWorkerBoundary } from './check-worker-boundaries.mjs';

test('Workers may share authentication and contracts but cannot import another service implementation', () => {
  const shared = { 'worker/app/auth-core.ts': {}, 'worker/shared/marketing-email-contract.ts': {} };
  for (const target of ['api', 'admin', 'marketing']) checkWorkerBoundary(target, { inputs: shared });
  for (const [target, path] of [
    ['api', 'worker/templates/marketing-email.ts'], ['api', 'worker/app/admin.ts'],
    ['admin', 'worker/lib/marketing-email.ts'], ['marketing', 'worker/app/admin.ts'],
  ]) {
    assert.throws(() => checkWorkerBoundary(target, { inputs: { ...shared, [path]: {} } }), /another service/);
    assert.throws(() => checkWorkerBoundary(target, { inputs: { [`/checkout/${path}`]: {} } }), /another service/);
  }
  assert.throws(() => checkWorkerBoundary('api', {}));
});
