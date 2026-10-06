import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
const { main } = await import(process.env.MAINBRELLA_SDK_CLI || './cli.mjs');
const key = 'mb_' + 'a'.repeat(64), createdAt = '2026-10-05T12:00:00.000Z', id = crypto.randomUUID();
function output() { const result = { stdout: '', stderr: '' }; return { result,
  stdout: { write(text) { result.stdout += text; } }, stderr: { write(text) { result.stderr += text; } } }; }
const identity = ['--id', 'small', '--created-at', createdAt];

test('CLI validates explicit identities/options and never emits credentials or raw transport errors', async () => {
  let calls = 0;
  const fetch = async () => { calls++; throw new Error(key + ' private stack'); };
  for (const argv of [[], ['unknown'], ['kill', '--id', 'small'], ['kill', ...identity, '--all'],
    ['create'], ['start', ...identity, '--command', 'x'], ['run', ...identity, '--command', 'x', '--timeout-ms', '1e3'],
    ['run', ...identity, '--command', 'x', '--id', 'duplicate'], ['start', ...identity, '--idempotency-key', 'one', '--argv-json', 'true'],
    ['start', ...identity, '--idempotency-key', 'one', '--command', 'x', '--pty-cols', '80', '--pty-rows', '24']]) {
    const out = output(); assert.equal(await main(argv, { ...out, fetch, env: { MAINBRELLA_API_KEY: key } }), 1);
    assert.equal(JSON.parse(out.result.stderr).error, 'invalid_cli_arguments'); assert.equal(out.result.stdout, '');
  }
  assert.equal(calls, 0);
  const out = output();
  assert.equal(await main(['kill', ...identity], { ...out, fetch, env: { MAINBRELLA_API_KEY: key } }), 1);
  assert.deepEqual(JSON.parse(out.result.stderr), { error: 'transport_unavailable' });
  assert.ok(!out.result.stderr.includes(key)); assert.equal(calls, 1);
  for (const flag of ['--help', '--version']) {
    const out = output(); assert.equal(await main([flag], { ...out, fetch, env: {} }), 0); assert.ok(out.result.stdout); assert.equal(out.result.stderr, '');
  }
});

test('CLI binds commands/input/signals to generations, reports exit codes and preserves creation keys', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mainbrella-cli-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'input'); await writeFile(source, new Uint8Array([0, 128, 255]));
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.pathname === '/containers' && options.method === 'POST') return Response.json({ creation: { id: 'creation', status: 'running', containerId: 'small', createdAt }, containers: [{ id: 'small', createdAt, status: 'running' }] });
    assert.equal(url.searchParams.get('id'), 'small'); assert.equal(url.searchParams.get('createdAt'), createdAt);
    if (url.pathname === '/containers/exec') return Response.json({ stdout: 'hello', stderr: 'problem', exitCode: 7, timedOut: false, outputTruncated: false });
    if (url.pathname.endsWith('/stdin')) { assert.deepEqual(options.body, new Uint8Array([0, 128, 255])); return Response.json({ bytes: 3, stdinClosed: false }); }
    if (url.pathname.endsWith('/resize')) { assert.deepEqual(JSON.parse(options.body), { cols: 132, rows: 40 }); return Response.json({ id }); }
    if (url.pathname === '/containers' && options.method === 'DELETE') return Response.json({ containers: [] });
    return Response.json({ id });
  };
  const env = { MAINBRELLA_API_KEY: key };
  const invoke = async argv => { const out = output(); const status = await main(argv, { ...out, fetch, env }); return { status, ...out.result }; };
  const creation = await invoke(['create', '--idempotency-key', 'cli-create']); assert.equal(creation.status, 0); assert.equal(JSON.parse(creation.stdout).createdAt, createdAt);
  const run = await invoke(['run', ...identity, '--command', 'printf hello']); assert.equal(run.status, 7); assert.equal(JSON.parse(run.stdout).stderr, 'problem');
  const started = await invoke(['start', ...identity, '--idempotency-key', 'cli-job', '--argv-json', '["cat"]', '--stdin']); assert.equal(started.status, 0);
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { argv: ['cat'], stdin: true });
  assert.equal((await invoke(['job', 'input', ...identity, '--execution-id', id, '--source', source])).status, 0);
  assert.equal((await invoke(['job', 'resize', ...identity, '--execution-id', id, '--cols', '132', '--rows', '40'])).status, 0);
  assert.equal((await invoke(['kill', ...identity])).status, 0);
  const out = output(); await main(['start', ...identity, '--idempotency-key', 'retained-key', '--command', 'x'], { ...out, env, fetch: async () => { throw new Error('private'); } });
  assert.deepEqual(JSON.parse(out.result.stderr), { error: 'transport_unavailable', idempotencyKey: 'retained-key' });
});

test('CLI binary download never overwrites local files and input bounds precede HTTP mutations', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mainbrella-cli-files-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, 'download'), large = join(directory, 'large'); await writeFile(large, new Uint8Array(1024 * 1024 + 1));
  let calls = 0; const fetch = async () => { calls++; return new Response(new Uint8Array([0, 128, 255])); };
  const invoke = async argv => { const out = output(); const status = await main(argv, { ...out, fetch, env: { MAINBRELLA_API_KEY: key } }); return { status, ...out.result }; };
  const argv = ['file', 'read', ...identity, '--path', '/tmp/probe', '--output', target];
  assert.equal((await invoke(argv)).status, 0); assert.deepEqual(new Uint8Array(await readFile(target)), new Uint8Array([0, 128, 255]));
  const second = await invoke(argv); assert.equal(second.status, 1); assert.equal(JSON.parse(second.stderr).error, 'output_exists');
  const count = calls;
  assert.equal(JSON.parse((await invoke(['file', 'write', ...identity, '--path', '/tmp/probe', '--source', large])).stderr).error, 'input_too_large');
  assert.equal(JSON.parse((await invoke(['job', 'input', ...identity, '--execution-id', id, '--source', large])).stderr).error, 'input_too_large');
  assert.equal(calls, count);
});

test('CLI lifecycle uses actual HTTP and only stops its explicit generation', async t => {
  const requests = [];
  const server = createServer(async (request, response) => {
    requests.push(request.url); assert.equal(request.headers.authorization, `Bearer ${key}`);
    const url = new URL(request.url, 'http://localhost');
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'POST') {
      assert.equal(request.headers['idempotency-key'], 'http-create');
      response.end(JSON.stringify({ creation: { id: 'http', containerId: 'small', createdAt, status: 'running' }, containers: [{ id: 'small', createdAt, status: 'running' }] }));
    } else { assert.equal(url.searchParams.get('id'), 'small'); assert.equal(url.searchParams.get('createdAt'), createdAt); response.end('{"containers":[]}'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const env = { MAINBRELLA_API_KEY: key, MAINBRELLA_API_URL: `http://127.0.0.1:${server.address().port}` };
  const out = output(); assert.equal(await main(['create', '--idempotency-key', 'http-create'], { ...out, env }), 0);
  assert.equal(JSON.parse(out.result.stdout).id, 'small');
  assert.equal(await main(['kill', ...identity], { ...output(), env }), 0); assert.equal(requests.length, 2);
});

test('CLI filesystem controls are explicit, bounded and never repeat a mutation after a lost response', async () => {
  const calls = [], fetch = async (url, options) => { calls.push({ url, options }); return Response.json({ ok: true }); };
  const invoke = async args => { const out = output(); const status = await main(args, { ...out, env: { MAINBRELLA_API_KEY: key }, fetch }); return { status, ...out.result }; };
  assert.equal((await invoke(['file', 'list', ...identity, '--path', '/workspace', '--limit', '1000', '--offset', '10'])).status, 0);
  assert.equal(calls.at(-1).url.searchParams.get('limit'), '1000'); assert.equal(calls.at(-1).url.searchParams.get('offset'), '10');
  assert.equal((await invoke(['file', 'stat', ...identity, '--path', '/workspace', '--follow-symlinks'])).status, 0);
  assert.equal(calls.at(-1).url.searchParams.get('followSymlinks'), 'true');
  assert.equal((await invoke(['file', 'mkdir', ...identity, '--path', '/workspace/project', '--recursive', '--mode', '0700'])).status, 0);
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { path: '/workspace/project', recursive: true, mode: '0700' });
  assert.equal((await invoke(['file', 'remove', ...identity, '--path', '/workspace/project'])).status, 0);
  assert.equal(calls.at(-1).options.method, 'DELETE'); assert.equal(calls.at(-1).url.searchParams.get('recursive'), 'false');
  assert.equal((await invoke(['file', 'move', ...identity, '--path', '/workspace/a', '--destination', '/workspace/b'])).status, 0);
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { path: '/workspace/a', destination: '/workspace/b' });
  assert.equal((await invoke(['file', 'chmod', ...identity, '--path', '/workspace/b', '--mode', '0640'])).status, 0);
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { mode: '0640' });
  for (const { url } of calls) { assert.equal(url.searchParams.get('id'), 'small'); assert.equal(url.searchParams.get('createdAt'), createdAt); }
  const before = calls.length;
  for (const args of [['file', 'chmod', ...identity, '--path', '/tmp/x', '--mode', '4777'], ['file', 'list', ...identity, '--path', '/tmp', '--limit', '1001'],
    ['file', 'move', ...identity, '--path', '/tmp/x'], ['create', '--idempotency-key', 'offline', '--internet', '0']]) assert.equal((await invoke(args)).status, 1);
  assert.equal(calls.length, before);
  let lost = 0; const out = output();
  assert.equal(await main(['file', 'remove', ...identity, '--path', '/tmp/x', '--recursive'], { ...out, env: { MAINBRELLA_API_KEY: key }, fetch: async () => { lost++; throw new Error('private'); } }), 1);
  assert.equal(lost, 1); assert.equal(JSON.parse(out.result.stderr).error, 'transport_unavailable');
});
