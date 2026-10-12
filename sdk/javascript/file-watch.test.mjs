import test from 'node:test';
import assert from 'node:assert/strict';
const { Mainbrella } = await import(process.env.MAINBRELLA_SDK_MODULE || './index.js');
const id = 'ba121913-12de-4ef9-8dc2-f8f47a755410';
const createdAt = '2026-10-12T14:00:00.000Z';
const record = value => JSON.stringify(value) + '\n';
function fixture() {
  const calls = [];
  const sandbox = new Mainbrella({ apiKey: 'mb_' + 'a'.repeat(64), fetch: async (url, options) => {
    calls.push({ url, options });
    assert.equal(url.searchParams.get('createdAt'), createdAt);
    return Response.json({ id });
  } }).connect({ id: 'small', createdAt });
  return { sandbox, calls };
}

test('native watch uses argv and one stable managed execution with validated bounds', async () => {
  const f = fixture();
  const path = '/workspace/$(touch injected)';
  const watch = await f.sandbox.files.watchNative(path, { idempotencyKey: 'watch-one', timeoutMs: 5000 });
  assert.equal(watch.execution.id, id); assert.equal(watch.idempotencyKey, 'watch-one');
  const request = f.calls[0];
  assert.equal(request.url.pathname, '/containers/executions');
  assert.equal(request.options.headers['Idempotency-Key'], 'watch-one');
  const body = JSON.parse(request.options.body);
  assert.deepEqual(body.argv.slice(0, 2), ['node', '-e']);
  assert.deepEqual(body.argv.slice(-2), [path, 'true']);
  assert.equal(body.timeoutMs, 5000); assert.equal(body.command, undefined);
  for (const options of [{ timeoutMs: 900001 }, { recursive: 1 }, { idempotencyKey: '' }]) {
    await assert.rejects(f.sandbox.files.watchNative('/workspace', options), { code: 'invalid_file_watch_options' });
  }
  assert.throws(() => f.sandbox.files.watchNative('/workspace/../etc'), { code: 'invalid_file_path' });
  assert.equal(f.calls.length, 1);
});

test('native stream retains partial and queued records across reconnect and iterator return', async () => {
  const { sandbox } = fixture();
  const watch = await sandbox.files.watchNative('/workspace');
  let connection = 0;
  watch.execution.events = async function* () {
    if (++connection === 1) {
      yield { type: 'stdout', data: record({ type: 'ready', path: '/workspace', recursive: true }) + '{"type":"rename","file' };
      throw new Error('stream disconnected');
    }
    yield { type: 'stdout', data: 'name":"first"}\n' + record({ type: 'change', filename: 'nested/界' }) };
    yield { type: 'status', execution: { status: 'canceled' } };
  };
  const first = watch.events();
  assert.equal((await first.next()).value.type, 'ready');
  await assert.rejects(first.next(), /stream disconnected/);
  const second = watch.events();
  assert.deepEqual((await second.next()).value, { type: 'rename', filename: 'first' });
  await second.return();
  const third = watch.events();
  assert.deepEqual((await third.next()).value, { type: 'change', filename: 'nested/界' });
  await third.return();
});

test('native watch rejects bad guest frames and reports output loss and unsuccessful cancellation', async () => {
  for (const event of [{ type: 'change', filename: '../outside' }, { type: 'change', filename: '\ud800' },
    { type: 'ready', path: '/another', recursive: true }, { type: 'error', code: 'private-error' }, null]) {
    const watch = await fixture().sandbox.files.watchNative('/workspace');
    watch.execution.events = async function* () { yield { type: 'stdout', data: record(event) }; };
    await assert.rejects(watch.events().next(), { code: 'invalid_file_watch_response' });
  }
  const watch = await fixture().sandbox.files.watchNative('/workspace');
  watch.execution.events = async function* () { yield { type: 'status', execution: { status: 'failed', outputTruncated: true } }; };
  await assert.rejects(watch.events().next(), { code: 'file_watch_output_limit' });
  watch.execution.cancel = async () => ({ status: 'running' });
  await assert.rejects(watch.close(), { code: 'file_watch_cleanup_unconfirmed' });
  let canceled = 0;
  watch.execution.cancel = async () => { canceled++; return { status: 'canceled' }; };
  assert.deepEqual(await watch.close(), { closed: true });
  assert.deepEqual(await watch.close(), { closed: true });
  assert.equal(canceled, 1);
});

test('an ambiguous native watch start preserves its exact retry key', async () => {
  const sandbox = new Mainbrella({ apiKey: 'mb_' + 'a'.repeat(64), fetch: async () => { throw Error('lost'); } }).connect({ id: 'small', createdAt });
  await assert.rejects(sandbox.files.watchNative('/workspace', { idempotencyKey: 'keep-watch-key' }), { code: 'transport_unavailable', idempotencyKey: 'keep-watch-key' });
});
