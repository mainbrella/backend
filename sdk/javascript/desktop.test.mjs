import test from 'node:test';
import assert from 'node:assert/strict';
const { Mainbrella, MainbrellaError, DesktopSession } = await import(process.env.MAINBRELLA_SDK_MODULE || './index.js');

const contextId = 'd688d42a-25ef-4c13-9b28-21a0fde6e163';
const directory = '/tmp/mainbrella-desktop-abcdefgh';
const info = { display: ':10', width: 1280, height: 720, directory };
function png() {
  const bytes = new Uint8Array(45);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); view.setUint32(12, 0x49484452); view.setUint32(16, 1280); view.setUint32(20, 720);
  bytes.set([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130], 33);
  return bytes;
}
function setup({ execute, file = png() } = {}) {
  const calls = [];
  const client = new Mainbrella({ apiKey: `mb_${'a'.repeat(64)}`, fetch: async (url, options) => {
    const body = options.body && JSON.parse(options.body), code = body?.code;
    calls.push({ url, method: options.method, code });
    if (url.pathname.endsWith('/execute')) {
      const action = /^_mb_desktop\.call\(__import__\('json'\)\.loads\((.*)\)\)$/.exec(code);
      const payload = action ? JSON.parse(JSON.parse(action[1])) : undefined;
      const replacement = await execute?.(code, payload);
      if (replacement) return replacement;
      const value = code.endsWith('DesktopGuest.probe()') ? { supported: true, tools: { Xvfb: true, xdpyinfo: true, xdotool: true, import: true } }
        : code.endsWith('_mb_desktop.info()') ? info : payload?.action === 'screenshot'
          ? { path: directory + '/screenshot.png', size: file.length } : payload?.action === 'launch' ? { pid: 100 } : { ok: true };
      return Response.json({ error: null, outputTruncated: false, results: [{ mimeType: 'application/json', data: JSON.stringify(value) }] });
    }
    if (url.pathname.endsWith('/files/transfer')) return new Response(file, { headers: { 'Content-Length': String(file.length) } });
    return Response.json({ id: contextId, expiresAt: 1000, closed: true });
  } });
  return { sandbox: client.connect({ id: 'small', createdAt: '2026-10-11T00:00:00.000Z' }), calls };
}

test('desktop probes, actions and screenshots use the owned generation and close the interpreter', async () => {
  const actions = [];
  const { sandbox, calls } = setup({ execute: (_code, payload) => { if (payload) actions.push(payload); } });
  assert.equal((await sandbox.desktop.probe()).supported, true);
  const desktop = await sandbox.desktop.start();
  assert.ok(desktop instanceof DesktopSession);
  assert.equal(desktop.contextId, contextId);
  assert.equal(desktop.expiresAt, 1000);
  await desktop.launch(['xterm', '-title', 'literal $(touch /tmp/injection)']);
  await desktop.move(20, 30); await desktop.click(); await desktop.press('ctrl+shift+a');
  const text = '"\n\\ $() -- literal 中文';
  await desktop.type(text);
  assert.deepEqual(await desktop.screenshot(), png());
  await desktop.close(); await desktop.close();
  assert.equal(actions.find(item => item.action === 'type').text, text);
  assert.equal(calls.filter(call => call.url.pathname.includes('/code-contexts/') && call.method === 'DELETE').length, 2);
  assert.ok(calls.every(call => call.url.searchParams.get('id') === 'small'
    && call.url.searchParams.get('createdAt') === sandbox.createdAt));
  assert.equal(calls.filter(call => call.url.pathname.endsWith('/files/remove') && call.method === 'DELETE').length, 1);
  assert.throws(() => desktop.click(), { code: 'desktop_closed' });
});

test('desktop rejects invalid dimensions and command data before side effects', async () => {
  const { sandbox, calls } = setup();
  for (const options of [{ width: 0 }, { width: 1921 }, { height: 1081 }, { width: true }]) {
    await assert.rejects(sandbox.desktop.start(options), { code: 'invalid_desktop_options' });
  }
  assert.equal(calls.length, 0);
  const desktop = await sandbox.desktop.start(), count = calls.length;
  for (const operation of [() => desktop.move(-1, 0), () => desktop.move(1280, 0), () => desktop.click(6),
    () => desktop.press('--window 5'), () => desktop.press('a;touch'), () => desktop.type('a'.repeat(2049)),
    () => desktop.type('bad\0text'), () => desktop.launch('sh'), () => desktop.launch(['']), () => desktop.launch(['x', 3])]) assert.throws(operation);
  assert.equal(calls.length, count);
  await desktop.type('\x01'.repeat(2048));
  assert.ok(new TextEncoder().encode(calls.at(-1).code).length < 16384);
  await desktop.close();
});

test('ambiguous desktop startup is never replayed and its known interpreter is closed', async () => {
  const { sandbox, calls } = setup({ execute: code => { if (code.endsWith('_mb_desktop.info()')) throw new Error('connection lost'); } });
  await assert.rejects(sandbox.desktop.start(), error => error.code === 'transport_unavailable' && error.contextId === contextId);
  assert.equal(calls.filter(call => call.code?.endsWith('_mb_desktop.info()')).length, 1);
  assert.equal(calls.filter(call => call.method === 'DELETE').length, 1);
});

test('oversized, truncated and redirected screenshot metadata never returns an image and removes only its own path', async () => {
  for (const mutation of ['oversized', 'truncated', 'path', 'invalid_png']) {
    const file = png(); if (mutation === 'invalid_png') file[44] = 0;
    const { sandbox, calls } = setup({ file, execute: (_code, payload) => {
      if (payload?.action !== 'screenshot' || mutation === 'invalid_png') return;
      return Response.json({ error: null, outputTruncated: mutation === 'truncated', results: [{ mimeType: 'application/json',
        data: JSON.stringify({ path: mutation === 'path' ? '/tmp/unrelated' : directory + '/screenshot.png', size: mutation === 'oversized' ? 8 * 1024 * 1024 + 1 : file.length }) }] });
    } });
    const desktop = await sandbox.desktop.start();
    await assert.rejects(desktop.screenshot(), error => error instanceof MainbrellaError);
    const removal = calls.find(call => call.url.pathname.endsWith('/files/remove'));
    assert.equal(removal.url.searchParams.get('path'), directory + '/screenshot.png');
    assert.equal(calls.some(call => call.url.pathname.endsWith('/files/transfer')), mutation === 'invalid_png');
    await desktop.close();
  }
});

test('concurrent screenshot calls serialize transfer and deletion before the next capture', async () => {
  const { sandbox, calls } = setup();
  const desktop = await sandbox.desktop.start();
  await Promise.all([desktop.screenshot(), desktop.screenshot()]);
  const sequence = calls.filter(call => call.code?.startsWith('_mb_desktop.call') || call.url.pathname.includes('/files/'))
    .map(call => call.code ? 'capture' : call.url.pathname.endsWith('/transfer') ? 'download' : 'delete');
  assert.deepEqual(sequence, ['capture', 'download', 'delete', 'capture', 'download', 'delete']);
  await desktop.close();
});

test('an unconfirmed close retains the exact context and can be retried', async () => {
  const { sandbox } = setup();
  const create = sandbox.code.create;
  let attempts = 0;
  sandbox.code.create = async () => {
    const context = await create();
    const close = context.close.bind(context);
    context.close = () => { if (++attempts === 1) throw new MainbrellaError('transport_unavailable'); return close(); };
    return context;
  };
  const desktop = await sandbox.desktop.start();
  await assert.rejects(desktop.close(), error => error.cleanupUnconfirmed === true && error.contextId === contextId);
  assert.throws(() => desktop.click(), { code: 'desktop_closed' });
  assert.deepEqual(await desktop.close(), { closed: true });
  assert.equal(attempts, 2);
});
