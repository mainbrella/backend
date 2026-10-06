import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync,gunzipSync} from 'node:zlib';
import {exportWorkspace} from './workspace-export.js';

function fixture(code=0){
  const bytes=gzipSync(Buffer.from([0,255,128,0,10])),active=new Set();
  const controller={now:()=>Date.now(),respond:(value,status=200)=>Response.json(value,{status}),
    async getTerminalMetadata(createdAt){return createdAt==='owned'?{expiresAt:Date.now()+60000}:null;},
    async startTerminalProcess(_generation,_expiry,argv){assert.ok(argv.includes('bash'));return {stdout:new ReadableStream({start(c){if(code===0)c.enqueue(bytes);c.close();}}),stderr:new ReadableStream({start(c){c.close();}}),exitCode:Promise.resolve(code),kill(){},};},
    async signalOperationGroup(){return true;}};
  const request=createdAt=>new Request('https://internal/workspaces/export-v1',{headers:{'x-exec-created-at':createdAt,'x-exec-expires-at':String(Date.now()+60000)}});
  return {controller,active,request};
}
test('portable export preserves binary gzip data, rejects stale generation and releases its operation slot',async()=>{
  const f=fixture(),response=await exportWorkspace(f.controller,f.request('owned'),f.active);
  assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/gzip');
  assert.deepEqual(gunzipSync(Buffer.from(await response.arrayBuffer())),Buffer.from([0,255,128,0,10]));assert.equal(f.active.size,0);
  assert.equal((await exportWorkspace(f.controller,f.request('foreign'),f.active)).status,409);
});
test('too-large or inconsistent archives fail without returning a partial download',async()=>{
  const large=fixture(44),changed=fixture(45);
  assert.equal((await exportWorkspace(large.controller,large.request('owned'),large.active)).status,413);
  assert.equal((await exportWorkspace(changed.controller,changed.request('owned'),changed.active)).status,503);
});
