import test from 'node:test';
import assert from 'node:assert/strict';
import { checkpointCapabilities } from './checkpoint-support.mjs';

test('checkpoint diagnostics decode high capability bits without 32-bit truncation', () => {
  const bits = (1n << 40n) | (1n << 19n);
  assert.deepEqual(checkpointCapabilities(`CapEff:\t${bits.toString(16)}\nCapBnd:\t0000000000200000\nSeccomp:\t2\n`), {
    effective: { sysPtrace: true, sysAdmin: false, checkpointRestore: true },
    bounding: { sysPtrace: false, sysAdmin: true, checkpointRestore: false },
    seccompMode: 2,
  });
});

test('unavailable kernel facts remain unknown rather than inferred permissions', () => {
  assert.deepEqual(checkpointCapabilities(''), { effective: null, bounding: null, seccompMode: null });
});
