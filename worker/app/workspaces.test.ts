import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from './router';
import { paidContainerFixture, SESSION_ONE, USER_ONE } from './paid-container-test-helpers';

const workspaceId='d688d42a-25ef-4c13-9b28-21a0fde6e163';
test('workspace auth binds only the authenticated account; metadata remains accessible during billing failure and disabled issuance',async t=>{
  const f=await paidContainerFixture(t);t.after(()=>f.close());const forwarded:{name:string;request:Request}[]=[];
  const account={idFromName(name:string){return name;},get(name:string){return {async fetch(request:Request){forwarded.push({name,request});return Response.json({workspaces:[],limits:null,usage:{saved:0,reservedBytes:0}});}};}};
  const env={...f.env,CONTAINER_ACCOUNT:account} as unknown as Env;
  const call=(method='GET',path='/workspaces',body?:unknown,headers={})=>handleRequest(new Request('https://api.mainbrella.com'+path,{method,
    headers:{Origin:'https://mainbrella.com',Cookie:`mainbrella_session=${SESSION_ONE}`,...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})}),env);
  f.setBillingMode('failure');const read=await call();assert.equal(read.status,200);assert.equal(forwarded[0].name,`account:${USER_ONE}`);
  assert.equal(forwarded[0].request.headers.get('x-mainbrella-user'),USER_ONE);
  assert.equal((await call('POST','/workspaces',{})).status,503);
  assert.equal((await call('GET','/workspaces',undefined,{Authorization:'Bearer invalid'})).status,401);
  assert.equal((await call('GET','/workspaces?user=victim')).status,400);
  assert.equal((await call('DELETE',`/workspaces/${workspaceId}`)).status,200);
  assert.equal(new URL(forwarded.at(-1)!.request.url).searchParams.get('workspaceId'),workspaceId);
});
test('enabled saves preserve body and key while stripping caller control-plane headers; restore selection cannot accept handles',async t=>{
  const f=await paidContainerFixture(t);t.after(()=>f.close());let internal:Request|undefined;
  const env={...f.env,WORKSPACE_PERSISTENCE_ENABLED:'true',CONTAINER_ACCOUNT:{idFromName(name:string){return name;},get(){return {async fetch(req:Request){internal=req;return Response.json({ok:true});}};}}} as unknown as Env;
  const body={id:'small',createdAt:'2026-10-06T00:00:00.000Z',name:'Saved files',stop:true};
  const response=await handleRequest(new Request('https://api.mainbrella.com/workspaces',{method:'POST',headers:{Origin:'https://mainbrella.com',Cookie:`mainbrella_session=${SESSION_ONE}`,'Idempotency-Key':'save-1','x-mainbrella-user':'victim','x-provider-handle':'private'},body:JSON.stringify(body)}),env);
  assert.equal(response.status,200);assert.deepEqual(await internal!.json(),body);assert.equal(internal!.headers.get('Idempotency-Key'),'save-1');
  assert.equal(internal!.headers.get('x-mainbrella-user'),USER_ONE);assert.equal(internal!.headers.has('x-provider-handle'),false);
  const large=await handleRequest(new Request('https://api.mainbrella.com/workspaces',{method:'POST',headers:{Origin:'https://mainbrella.com',Cookie:`mainbrella_session=${SESSION_ONE}`},body:'x'.repeat(2049)}),env);assert.equal(large.status,413);
  const wrong=await handleRequest(new Request('https://api.mainbrella.com/containers',{method:'POST',headers:{Origin:'https://mainbrella.com',Cookie:`mainbrella_session=${SESSION_ONE}`},body:JSON.stringify({workspaceId,catalogId:'node'})}),env);assert.equal(wrong.status,400);
  const discovery=await handleRequest(new Request('https://api.mainbrella.com/capabilities'),env);const caps=await discovery.json() as any;
  assert.equal(caps.persistence.snapshots,true);assert.equal(caps.persistence.filesystemAfterStop,false);
});
