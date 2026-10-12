import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Real workerd HTTP responses are needed: Node Response preserves a manually
// supplied Content-Length even when workerd's ordinary streamed body drops it.
test('fixed transfer lengths survive native runtime and public Worker response boundaries', async t => {
  const bundle = await build({ stdin: { contents: `
    import {fixedByteStream} from './containers/file-transfer-contract.js';
    export default {async fetch(request){
      const path=new URL(request.url).pathname;
      if(path==='/cancel'){
        let canceled=0,sent=false,confirmed;const cleanup=new Promise(resolve=>confirmed=resolve);const abort=new AbortController();
        const source=new ReadableStream({pull(controller){if(!sent){sent=true;controller.enqueue(new Uint8Array([0,128]));}},cancel(){canceled++;confirmed();}});
        const body=fixedByteStream(fixedByteStream(source,4,abort.signal),4,abort.signal);
        const reader=body.getReader();const first=await reader.read();abort.abort();await cleanup;await reader.cancel().catch(()=>{});
        return Response.json({canceled,bytes:[...first.value]});
      }
      const bytes=new Uint8Array([0,128,255,10]);
      const source=new ReadableStream({start(controller){controller.enqueue(bytes.slice(0,2));controller.enqueue(bytes.slice(2));controller.close();}});
      const ordinary=new URL(request.url).pathname==='/ordinary';
      // A stream crosses both the runtime and the public API response wrappers.
      const length=path==='/short'?5:path==='/long'?3:4;
      const body=ordinary?source:fixedByteStream(fixedByteStream(source,length),length);
      return new Response(body,{headers:{'content-type':'application/octet-stream','content-length':String(length)}});
    }};
  `, resolveDir: process.cwd(), sourcefile: 'fixed-transfer-regression.js' }, bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:*', 'node:*'] });
  const mf = new Miniflare(convertV4MiniflareOptions({ cf: false, host: '127.0.0.1', port: 0, workers: [{ name: 'fixed-transfer-regression', modules: true,
    script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-18', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'] }] }));
  t.after(() => mf.dispose());
  const base = await mf.ready;
  const ordinary = await fetch(new URL('/ordinary', base));
  assert.equal(ordinary.headers.get('content-length'), null);
  assert.deepEqual(new Uint8Array(await ordinary.arrayBuffer()), new Uint8Array([0, 128, 255, 10]));
  const response = await fetch(new URL('/fixed', base));
  assert.equal(response.headers.get('content-length'), '4');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([0, 128, 255, 10]));
  for (const path of ['/short', '/long']) {
    await assert.rejects(async () => { const invalid = await fetch(new URL(path, base)); await invalid.arrayBuffer(); }, /terminated|fetch failed|other side closed/);
  }
  const canceled = await fetch(new URL('/cancel', base), { signal: AbortSignal.timeout(3000) });
  assert.deepEqual(await canceled.json(), { canceled: 1, bytes: [0, 128] });
});
