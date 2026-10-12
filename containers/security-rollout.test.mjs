import assert from 'node:assert/strict';
import test from 'node:test';
import { securityAccountEnabled } from './security-rollout.js';

test('security rollout selects exact owned account IDs and requires explicit public access', () => {
  const enabled = value => ({ SECURITY_FEATURE_ACCOUNTS: value });
  assert.equal(securityAccountEnabled(enabled(' alice, bob '), 'alice'), true);
  assert.equal(securityAccountEnabled(enabled('alice,bob'), 'bob'), true);
  for (const account of [undefined, 'alic', 'Alice', 'mallory']) assert.equal(securityAccountEnabled(enabled('alice,bob'), account), false);
  assert.equal(securityAccountEnabled(enabled('*')), true);
  assert.equal(securityAccountEnabled(enabled('*'), 'mallory'), true);
  for (const value of [undefined, null, '', ' ', '* ,alice', 'alice,', 'alice,,bob', 'alice bob', 'alice;bob', 'a'.repeat(129), Array(101).fill('alice').join(','), 'a'.repeat(16385)]) {
    assert.equal(securityAccountEnabled(enabled(value), 'alice'), false);
  }
});
