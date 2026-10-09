import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { productionEntrypoint } from './production-policy.js';

test('production startup supervisor actually restarts an exited app, captures output and terminates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mainbrella-production-supervisor-'));
  const log = join(directory, 'output.log');
  const [binary, ...args] = productionEntrypoint('echo started; echo error >&2; exit 3', log);
  const child = spawn(binary, args, { stdio: 'ignore' });
  const exited = new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
  try {
    const deadline = Date.now() + 5000;
    let output = '';
    while (Date.now() < deadline) {
      output = await readFile(log, 'utf8').catch(() => '');
      if (output.split('started').length >= 3) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(output.split('started').length >= 3, output);
    assert.ok(output.includes('error'));
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('supervisor did not stop')), 2000).unref())]);
  } finally {
    child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
});
