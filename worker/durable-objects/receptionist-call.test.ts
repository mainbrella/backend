import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { VoiceClient, type VoiceTransport } from '@cloudflare/voice/client';
import { getExpectedTwilioSignature } from 'twilio/lib/webhooks/webhooks.js';
import { hashToken } from '../app/auth-core';

async function runtime(t: test.TestContext) {
  const result=await build({entryPoints:[new URL('../fixtures/voice-runtime.ts',import.meta.url).pathname],bundle:true,write:false,
    banner:{js:"import { createRequire } from 'node:module'; const require = createRequire('/voice-test.js');"},
    format:'esm',target:'es2022',platform:'browser',external:['cloudflare:*','node:*'],alias:{crypto:'node:crypto',url:'node:url',querystring:'node:querystring',path:'node:path'}});
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:"voice-test",modules:true,script:result.outputFiles[0].text,compatibilityDate:'2026-09-18',compatibilityFlags:['nodejs_compat'],
    d1Databases:['DB'],durableObjects:{RECEPTIONIST_CALL:{className:'ReceptionistCall',useSQLite:true}},
    bindings:{VOICE_ENABLED:'true',VOICE_PUBLIC_ORIGIN:'https://api.mainbrella.com',TWILIO_AUTH_TOKEN:'voice-test-twilio-secret',TWILIO_ACCOUNT_SID:'AC'+'a'.repeat(32),TWILIO_PHONE_NUMBER:'+15551234567',TWILIO_AGENT_ID:'11111111-1111-4111-8111-111111111111'}}]}));
  t.after(()=>mf.dispose());
  const db=await mf.getD1Database('DB');
  for (const migration of ['001_initial','002_auth_sessions','043_voice_receptionist']) {
    const statements=readFileSync(new URL(`../../migrations/${migration}.sql`,import.meta.url),'utf8').split(';').map(value=>value.trim()).filter(Boolean);
    for (const statement of statements) await db.prepare(statement).run();
  }
  await db.prepare("INSERT INTO users(id,email,name,created_at) VALUES('voice-user','voice@example.com','Voice User',?)").bind(new Date().toISOString()).run();
  await db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,'voice-user','2099-01-01T00:00:00.000Z')").bind(await hashToken('voice-test-session')).run();
  const headers={Cookie:'mainbrella_session=voice-test-session',Origin:'https://mainbrella.com','Content-Type':'application/json'};
  const request=(path:string,method='GET',body?:unknown)=>mf.dispatchFetch(`https://api.mainbrella.com${path}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  const saved=await request('/voice/agent','PUT',{name:'Maya',businessName:'Test workshop',greeting:'Hello, how can I help?',instructions:'Take a message. Open weekdays.',voice:'asteria',transferNumber:null});
  assert.equal(saved.status,200,await saved.clone().text());
  await db.prepare("UPDATE voice_agents SET id='11111111-1111-4111-8111-111111111111'").run();
  async function create(channel='text') {
    const response=await request('/voice/calls','POST',{channel});
    assert.equal(response.status,201,await response.clone().text());
    return response.json() as Promise<any>;
  }
  return {mf,db,headers,request,create};
}
async function until(predicate:()=>boolean|Promise<boolean>,message:string) {
  const deadline=Date.now()+8000;
  while(Date.now()<deadline) { if(await predicate())return; await new Promise(resolve=>setTimeout(resolve,20)); }
  throw new Error(message);
}
function clientTransport(mf: Miniflare,url: string,headers: Record<string,string>) {
  let socket: any;
  const frames: string[]=[];
  const transport: VoiceTransport={
    get connected(){return socket?.readyState===1;},
    onopen:null,onclose:null,onerror:null,onmessage:null,
    connect(){void mf.dispatchFetch(url.replace('wss:','https:'),{headers:{...headers,Upgrade:'websocket'}}).then(response=>{
      assert.equal(response.status,101);socket=response.webSocket!;
      socket.addEventListener('message',(event:any)=>transport.onmessage?.(event.data));
      socket.addEventListener('close',()=>transport.onclose?.());
      socket.accept();transport.onopen?.();
    }).catch(error=>transport.onerror?.(error));},
    disconnect(){socket?.close();},sendJSON(value){frames.push(String(value.type));socket.send(JSON.stringify(value));},sendBinary(data){socket.send(data);},
  };
  return {transport,frames};
}

test('installed VoiceClient completes a text turn through the real Agent and persists transcript',async t=>{
  const f=await runtime(t);const created=await f.create();
  const {transport,frames}=clientTransport(f.mf,created.websocketUrl,f.headers);
  const client=new VoiceClient({agent:'ReceptionistCall',transport});t.after(()=>client.disconnect());client.connect();
  await until(()=>client.transcript.length===1,'Greeting not received');
  assert.deepEqual(frames,['hello']);assert.equal(client.transcript[0].text,'Hello, how can I help?');
  client.sendText('Please ask Alex to call me.');
  await until(()=>Boolean(client.transcript.at(-1)?.text.includes('I can take a message:')),'Text completion not received');
  assert.equal(client.error,null);
  await until(async()=>{const r=await f.request(`/voice/calls/${created.call.id}`);const body=await r.json() as any;return body.call.transcript.length===3;},'Transcript not saved');
  const beforePurge=await (await f.request(`/__test_inspect/${created.call.id}`)).json() as any;assert.equal(beforePurge.history.length,3);
  const ended=await f.request(`/voice/calls/${created.call.id}/end`,'POST');
  assert.equal((await ended.json() as any).call.status,'completed');
  assert.equal((await f.request(`/voice/calls/${created.call.id}/connect`)).status,409);
  assert.equal((await f.request(`/__test_purge/${created.call.id}`,'POST')).status,204);
  const purged=await (await f.request(`/__test_inspect/${created.call.id}`)).json() as any;assert.equal(purged.state,null);assert.deepEqual(purged.history,[]);
  const retained=await (await f.request(`/voice/calls/${created.call.id}`)).json() as any;
  assert.equal(retained.call.status,'completed');assert.equal(retained.call.transcript.length,3);
});

test('installed VoiceClient browser start accepts PCM, raw PCM greeting and speech response',async t=>{
  const f=await runtime(t);const created=await f.create('browser');
  // Web Audio sinks are deterministic; VoiceClient's real capture/turn protocol
  // runs unchanged, with a custom input supplying valid mono PCM frames.
  const oldContext=Object.getOwnPropertyDescriptor(globalThis,'AudioContext');
  const oldAudio=Object.getOwnPropertyDescriptor(globalThis,'Audio');
  class AudioContextFixture {
    state='running';currentTime=0;destination={};
    async resume(){} async close(){}
    createMediaStreamDestination(){return {stream:{}};}
    createBuffer(_channels:number,length:number,rate:number){return {duration:length/rate,getChannelData:()=>new Float32Array(length)};}
    createBufferSource(){return {buffer:null,onended:null as null|(()=>void),connect(){},disconnect(){},stop(){},start(){queueMicrotask(()=>this.onended?.());}};}
  }
  Object.defineProperty(globalThis,'AudioContext',{configurable:true,value:AudioContextFixture});
  Object.defineProperty(globalThis,'Audio',{configurable:true,value:class {autoplay=false;srcObject=null;async play(){}pause(){}}});
  t.after(()=>{if(oldContext)Object.defineProperty(globalThis,'AudioContext',oldContext);else delete (globalThis as any).AudioContext;if(oldAudio)Object.defineProperty(globalThis,'Audio',oldAudio);else delete (globalThis as any).Audio;});
  const {transport,frames}=clientTransport(f.mf,created.websocketUrl,f.headers);
  const audioInput={onAudioData:null as null|((data:ArrayBuffer)=>void),onAudioLevel:null as null|((value:number)=>void),async start(){},stop(){},destroy(){}};
  const client=new VoiceClient({agent:'ReceptionistCall',transport,audioInput});t.after(()=>client.disconnect());client.connect();
  await until(()=>client.connected,'VoiceClient connection missing');await client.startCall();
  await until(()=>client.transcript.length===1,'PCM greeting not received');
  assert.equal(client.audioFormat,'pcm16');assert.equal(client.sampleRate,16000);
  client.sendJSON({type:'start_of_speech'});audioInput.onAudioData!(new Uint8Array(640).buffer);
  await until(()=>Boolean(client.transcript.at(-1)?.text.includes('I can take a message:')),'Speech response missing');
  assert.deepEqual(frames.slice(0,3),['hello','start_call','start_of_speech']);assert.equal(client.error,null);
  await until(async()=>{const result=await f.request(`/voice/calls/${created.call.id}`);return (await result.json() as any).call.transcript.length===3;},'Speech transcript not saved');
  await f.request(`/voice/calls/${created.call.id}/end`,'POST');
});

test('Agent denies SDK state mutation and a second socket, and records model failures',async t=>{
  const f=await runtime(t);const created=await f.create();
  const response=await f.mf.dispatchFetch(created.websocketUrl.replace('wss:','https:'),{headers:{...f.headers,Upgrade:'websocket'}});
  const ws=response.webSocket!;ws.accept();t.after(()=>ws.close());
  const second=await f.mf.dispatchFetch(created.websocketUrl.replace('wss:','https:'),{headers:{...f.headers,Upgrade:'websocket'}});
  assert.equal(second.status,409);
  assert.equal((await (await f.request(`/voice/calls/${created.call.id}`)).json() as any).call.status,'active');
  let closed=false;ws.addEventListener('close',()=>{closed=true;});
  ws.send(JSON.stringify({type:'cf_agent_state',state:{closed:false,turns:0}}));
  await until(()=>closed,'State mutation socket not closed');
  const detail=await f.request(`/voice/calls/${created.call.id}`);assert.equal((await detail.json() as any).call.status,'failed');
  const failed=await f.create();const {transport}=clientTransport(f.mf,failed.websocketUrl,f.headers);
  const client=new VoiceClient({agent:'ReceptionistCall',transport});client.connect();t.after(()=>client.disconnect());
  await until(()=>client.transcript.length===1,'Greeting missing');client.sendText('cause model failure');
  await until(async()=>{const response=await f.request(`/voice/calls/${failed.call.id}`);return (await response.json() as any).call.status==='failed';},'Model failure not persisted');
});


test('signed Twilio WebSocket bridges μ-law through the real Agent and rejects media token reuse',async t=>{
  const f=await runtime(t);
  const agentId='11111111-1111-4111-8111-111111111111';
  const providerCallId='CA'+'b'.repeat(32);
  const incoming=`https://api.mainbrella.com/voice/twilio/incoming/${agentId}`;
  const fields={AccountSid:'AC'+'a'.repeat(32),To:'+15551234567',CallSid:providerCallId};
  const response=await f.mf.dispatchFetch(incoming,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',
    'X-Twilio-Signature':getExpectedTwilioSignature('voice-test-twilio-secret',incoming,fields)},body:new URLSearchParams(fields).toString()});
  assert.equal(response.status,200);const twiml=await response.text();
  const mediaUrl=twiml.match(/<Stream url="([^"]+)"/)![1].replace('wss:','https:');
  const token=twiml.match(/name="token" value="([^"]+)"/)![1];
  const upgraded=await f.mf.dispatchFetch(mediaUrl,{headers:{Upgrade:'websocket','X-Twilio-Signature':getExpectedTwilioSignature('voice-test-twilio-secret',mediaUrl,{})}});
  assert.equal(upgraded.status,101);const ws=upgraded.webSocket!;const messages:any[]=[];
  ws.addEventListener('message',event=>messages.push(JSON.parse(String(event.data))));ws.accept();t.after(()=>ws.close());
  const streamSid='MZ'+'c'.repeat(32);
  ws.send(JSON.stringify({event:'connected',protocol:'Call',version:'1.0.0'}));
  ws.send(JSON.stringify({event:'start',streamSid,start:{streamSid,callSid:providerCallId,accountSid:fields.AccountSid,
    mediaFormat:{encoding:'audio/x-mulaw',sampleRate:8000,channels:1},customParameters:{token}}}));
  await until(()=>messages.some(message=>message.event==='media'),'Twilio greeting missing');
  assert.ok(messages.every(message=>message.event==='media'&&message.streamSid===streamSid));
  assert.ok(messages.every(message=>Buffer.from(message.media.payload,'base64').length===160));
  ws.send(JSON.stringify({event:'media',streamSid,media:{track:'inbound',payload:Buffer.alloc(160,255).toString('base64')}}));
  const callId=mediaUrl.split('/').at(-1)!;
  await until(async()=>{const result=await f.request(`/voice/calls/${callId}`);return (await result.json() as any).call.transcript.length===3;},'Twilio speech transcript missing');
  assert.equal((await f.db.prepare('SELECT media_token_hash FROM voice_calls WHERE id=?').bind(callId).first() as any).media_token_hash,null);
  assert.equal((await f.mf.dispatchFetch(mediaUrl,{headers:{Upgrade:'websocket','X-Twilio-Signature':getExpectedTwilioSignature('voice-test-twilio-secret',mediaUrl,{})}})).status,404);
  ws.send(JSON.stringify({event:'stop',streamSid}));
  await until(async()=>{const result=await f.request(`/voice/calls/${callId}`);return (await result.json() as any).call.status==='completed';},'Twilio call not ended');
});


test('explicit end retries failed transcript and final-status writes before scheduling cleanup',async t=>{
  const f=await runtime(t);const created=await f.create();
  assert.equal((await f.request(`/__test_finalization_outage/${created.call.id}`,'POST')).status,204);
  const initial=await (await f.request(`/voice/calls/${created.call.id}`)).json() as any;
  assert.deepEqual(initial.call.transcript,[]);
  assert.equal((await f.request(`/voice/calls/${created.call.id}/end`,'POST')).status,503);
  const incomplete=await (await f.request(`/__test_inspect/${created.call.id}`)).json() as any;
  assert.equal(incomplete.state.closed,true);
  assert.ok(!incomplete.schedules.some((schedule:any)=>schedule.callback==='purgeCall'));
  const afterFailure=await (await f.request(`/voice/calls/${created.call.id}`)).json() as any;
  assert.equal(afterFailure.call.status,'active');
  assert.deepEqual(afterFailure.call.transcript,[{role:'assistant',text:'Saved locally while D1 was unavailable.'}]);
  const retried=await f.request(`/voice/calls/${created.call.id}/end`,'POST');
  assert.equal(retried.status,200);const ended=await retried.json() as any;
  assert.equal(ended.call.status,'completed');assert.deepEqual(ended.call.transcript,afterFailure.call.transcript);
  const finalized=await (await f.request(`/__test_inspect/${created.call.id}`)).json() as any;
  assert.equal(finalized.schedules.filter((schedule:any)=>schedule.callback==='purgeCall').length,1);
  assert.equal((await f.request(`/voice/calls/${created.call.id}/end`,'POST')).status,200);
  assert.equal((await f.request(`/__test_purge/${created.call.id}`,'POST')).status,204);
  const retained=await (await f.request(`/voice/calls/${created.call.id}`)).json() as any;
  assert.deepEqual(retained.call.transcript,afterFailure.call.transcript);
});
