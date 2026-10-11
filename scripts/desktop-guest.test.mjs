import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DESKTOP_GUEST } from '../sdk/javascript/desktop-guest.js';
import { MAX_COMMAND_BYTES } from '../containers/command-contract.js';

test('desktop SDK guest implementations are identical and fit the supervised code request limit', async () => {
  assert.equal(DESKTOP_GUEST, await readFile(new URL('../sdk/python/mainbrella/_desktop_guest.py', import.meta.url), 'utf8'));
  const bootstrap = `exec(${JSON.stringify(DESKTOP_GUEST)})\n_mb_desktop = DesktopGuest(1920, 1080)\n_mb_desktop.info()`;
  assert.ok(new TextEncoder().encode(bootstrap).length < MAX_COMMAND_BYTES);
});
