import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Mainbrella } from '../../sdk/javascript/index.js';
import { handleRequest } from './router';
import { hashToken } from './auth-core';
import { paidContainerFixture, USER_ONE, GENERATION_ONE, EXPIRES_AT } from './paid-container-test-helpers';

test('JavaScript SDK uses real API auth, schemas, binary forwarding and generation cleanup', async t => {
  const f = await paidContainerFixture(t); t.after(() => f.close());
  f.sqlite.exec(readFileSync(new URL('../../migrations/010_api_keys.sql', import.meta.url), 'utf8'));
  const apiKey = `mb_${'a'.repeat(64)}`;
  f.sqlite.prepare('INSERT INTO api_keys (id, user_id, name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('sdk-key', USER_ONE, 'SDK', await hashToken(apiKey), 'mb_aaaa', GENERATION_ONE);
  const bytes = new Uint8Array([0, 128, 255]);
  let stored: Uint8Array | undefined;
  const original = f.env.USER_CONTAINER;
  f.env.USER_CONTAINER = { ...original, get(id: DurableObjectId) {
    original.get(id);
    return { async fetch(req: Request) {
      if (new URL(req.url).pathname === '/exec') return Response.json({ stdout: 'hello', stderr: '', exitCode: 0, timedOut: false, outputTruncated: false });
      if (req.method === 'PUT') { stored = new Uint8Array(await req.arrayBuffer()); return Response.json({}); }
      return new Response(stored ? new Uint8Array(stored) : undefined);
    } };
  } } as unknown as DurableObjectNamespace;
  const client = new Mainbrella({ apiKey, fetch: (async (input: RequestInfo | URL, options?: RequestInit) =>
    handleRequest(new Request(input, options), f.env)) as typeof fetch });
  assert.equal((await client.capabilities()).files.binary, true);
  const sandbox = client.connect({ id: 'small', createdAt: GENERATION_ONE });
  assert.equal((await sandbox.commands.run('printf hello')).exitCode, 0);
  await sandbox.files.write('/tmp/probe.bin', bytes);
  assert.deepEqual(await sandbox.files.read('/tmp/probe.bin'), bytes);
  await sandbox.kill();
  assert.equal(f.containers.get(USER_ONE)!.length, 0);
});
