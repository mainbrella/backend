import test from 'node:test';
import assert from 'node:assert/strict';
const { Mainbrella, CodeContext } = await import(process.env.MAINBRELLA_SDK_MODULE || './index.js');

test('code contexts retain generation, expose rich results and never retry ambiguous execution', async () => {
  const createdAt = '2026-10-11T00:00:00.000Z', id = 'd688d42a-25ef-4c13-9b28-21a0fde6e163', calls = [];
  const client = new Mainbrella({ apiKey: `mb_${'a'.repeat(64)}`, fetch: async (url, options) => {
    calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), method: options.method, body: options.body && JSON.parse(options.body) });
    if (url.pathname.endsWith('/execute')) {
      if (JSON.parse(options.body).code === 'uncertain()') throw new Error('disconnected');
      return Response.json({ stdout: '', stderr: '', results: [{ mimeType: 'application/json', data: '42' }], error: null, outputTruncated: false });
    }
    return Response.json(options.method === 'DELETE' ? { closed: true } : options.method === 'GET' ? { contexts: [] } : { id, language: 'python', createdAt, expiresAt: 123 });
  } });
  const sandbox = client.connect({ id: 'small', createdAt });
  const context = await sandbox.code.create(); assert.ok(context instanceof CodeContext);
  assert.equal(context.expiresAt, 123);
  const value = await context.run('41 + 1', { timeoutMs: 1000 }); assert.equal(value.results[0].data, '42');
  await sandbox.code.list(); await sandbox.code.attach(id).close();
  await assert.rejects(context.run('uncertain()'), { code: 'transport_unavailable' });
  assert.equal(calls.filter(call => call.body?.code === 'uncertain()').length, 1);
  assert.ok(calls.every(call => call.query.id === 'small' && call.query.createdAt === createdAt));
  assert.deepEqual(calls[1].body, { code: '41 + 1', timeoutMs: 1000 });
  assert.throws(() => sandbox.code.attach('../containers'), { code: 'invalid_code_context_identity' });
});
