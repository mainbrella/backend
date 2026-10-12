import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from 'miniflare';

test('real acknowledgment Worker keeps control credentials separate and fences slow-request versions', async t => {
  const work = await mkdtemp(join(tmpdir(), 'security-ack-test-')); t.after(() => rm(work, { recursive: true, force: true }));
  const outfile = join(work, 'worker.mjs');
  await build({ entryPoints: [resolve('worker/security-ack.ts')], outfile, bundle: true, platform: 'browser', format: 'esm', external: ['cloudflare:*', 'node:*'], logLevel: 'silent' });
  const control = 'c'.repeat(64), first = 'a'.repeat(64), second = 'b'.repeat(64), id = '11111111-1111-4111-8111-111111111111';
  const mf = new Miniflare(convertV4MiniflareOptions({ cf: false, log: new Log(LogLevel.ERROR), workers: [{ name: 'ack', modules: true, script: await readFile(outfile, 'utf8'),
    compatibilityDate: '2026-10-05', compatibilityFlags: ['enable_request_signal'], bindings: { SECURITY_ACK_CONTROL_TOKEN: control },
    durableObjects: { SECURITY_ACK: { className: 'SecurityAcknowledgment', useSQLite: true } },
  }] })); t.after(() => mf.dispose());
  const request = (path, method = 'GET', token = '', body) => mf.dispatchFetch('http://test' + path, { method, redirect: 'manual',
    headers: token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await request(`/control/${id}`, 'POST', '', { value: first })).status, 403);
  assert.equal((await request(`/control/${id}`, 'POST', control, { value: first })).status, 200);
  const publicResponse = await request(`/runs/${id}/auth`); assert.equal((await publicResponse.json()).authenticated, false);
  const ack = await (await request(`/runs/${id}/auth`, 'GET', first)).json(); assert.equal(ack.authenticated, true); assert.equal(ack.version, 1);
  assert.equal((await (await request(`/runs/${id}/reflect`, 'GET', first)).text()).includes(first), true);
  assert.equal((await (await request(`/runs/${id}/reflect-base64`, 'GET', first)).text()).includes(Buffer.from(first).toString('base64')), true);
  assert.equal((await request(`/runs/${id}/reflect-header`, 'GET', first)).headers.get('x-reflection') === first, true);
  const pending = request(`/runs/${id}/slow`, 'GET', first);
  for (let i = 0; i < 100; i++) {
    if ((await (await request(`/control/${id}`, 'GET', control)).json()).pending) break;
    await new Promise(done => setTimeout(done, 10));
  }
  assert.equal((await (await request(`/control/${id}`, 'GET', control)).json()).pending, true);
  assert.equal((await request(`/control/${id}`, 'PUT', control, { value: second })).status, 200);
  assert.equal((await request(`/control/${id}/release`, 'POST', control)).status, 200);
  const delayed = await (await pending).json(); assert.equal(delayed.version, 1); assert.equal(delayed.authenticated, true);
  const next = await (await request(`/runs/${id}/auth`, 'GET', second)).json(); assert.equal(next.version, 2); assert.equal(next.authenticated, true);
  assert.equal(JSON.stringify(next).includes(second), false);
  assert.equal((await request(`/runs/${id}/redirect`)).status, 302);
  assert.equal((await request(`/control/${id}`, 'DELETE', control)).status, 200);
  assert.equal((await request(`/runs/${id}/public`)).status, 404);
});
