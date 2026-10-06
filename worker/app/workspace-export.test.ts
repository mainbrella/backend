import test from 'node:test';
import assert from 'node:assert/strict';
import {handleRequest} from './router';
import {paidContainerFixture,GENERATION_ONE,GENERATION_TWO,SESSION_ONE,USER_ONE} from './paid-container-test-helpers';
test('workspace export authenticates and fences its binary download to the owner generation',async t=>{
  const f=await paidContainerFixture(t);t.after(()=>f.close());const bytes=new Uint8Array([31,139,0,255]);let forwarded:Request|undefined;
  const runtime=f.env.USER_CONTAINER;const env={...f.env,USER_CONTAINER:{idFromName(name:string){return runtime.idFromName(name);},get(id:any){const original=runtime.get(id);return {async fetch(request:Request){if(new URL(request.url).pathname==='/workspaces/export-v1'){forwarded=request;return new Response(bytes);}return original.fetch(request);}};}}} as unknown as Env;
  const call=(generation=GENERATION_ONE,headers={})=>handleRequest(new Request('https://api.mainbrella.com/containers/export?'+new URLSearchParams({id:'small',createdAt:generation}),{headers:{Origin:'https://mainbrella.com',Cookie:`mainbrella_session=${SESSION_ONE}`,...headers}}),env);
  const response=await call();assert.equal(response.status,200);assert.deepEqual(new Uint8Array(await response.arrayBuffer()),bytes);
  assert.equal(response.headers.get('content-type'),'application/gzip');assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(forwarded!.headers.get('x-exec-created-at'),GENERATION_ONE);
  assert.equal((await call(GENERATION_TWO)).status,409);assert.equal((await call(GENERATION_ONE,{Origin:'https://attacker.test'})).status,403);
  assert.equal((await call(GENERATION_ONE,{Authorization:'Bearer invalid'})).status,401);
});
