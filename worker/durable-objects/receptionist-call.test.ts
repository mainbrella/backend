import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { VoiceClient, type VoiceTransport } from '@cloudflare/voice/client';
import { getExpectedTwilioSignature } from 'twilio/lib/webhooks/webhooks.js';
import { TELNYX_TEST_ACCOUNT, TELNYX_TEST_BINDINGS, TELNYX_TEST_CALL, TELNYX_TEST_CONNECTION, TELNYX_TEST_SIP, telnyxTestSignature } from '../app/voice-telnyx-test-helpers';
import { hashToken } from '../app/auth-core';
import { pcmToTelnyx } from '../lib/voice-telnyx';

const acknowledgmentPhrases=['One second please.','Got it, just a sec.','I see, let me think.'];

async function runtime(t: test.TestContext, bindings: Record<string,string> = {}) {
  const result=await build({entryPoints:[new URL('../fixtures/voice-runtime.ts',import.meta.url).pathname],bundle:true,write:false,
    banner:{js:"import { createRequire } from 'node:module'; const require = createRequire('/voice-test.js');"},
    format:'esm',target:'es2022',platform:'browser',external:['cloudflare:*','node:*'],alias:{crypto:'node:crypto',url:'node:url',querystring:'node:querystring',path:'node:path'}});
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:"voice-test",modules:true,script:result.outputFiles[0].text,compatibilityDate:'2026-09-18',compatibilityFlags:['nodejs_compat'],
    d1Databases:['DB'],durableObjects:{RECEPTIONIST_CALL:{className:'ReceptionistCall',useSQLite:true},CONTAINER_ACCOUNT:{className:'VoiceBillingAccount',useSQLite:true}},
    bindings:{VOICE_ENABLED:'true',VOICE_PHONE_MICRO_USD_PER_MINUTE:'12500',VOICE_PUBLIC_ORIGIN:'https://api.mainbrella.com',TWILIO_AUTH_TOKEN:'voice-test-twilio-secret',TWILIO_ACCOUNT_SID:'AC'+'a'.repeat(32),TWILIO_PHONE_NUMBER:'+15551234567',TWILIO_AGENT_ID:'11111111-1111-4111-8111-111111111111',...bindings}}]}));
  t.after(()=>mf.dispose());
  const db=await mf.getD1Database('DB');
  for (const migration of ['001_initial','002_auth_sessions','043_voice_receptionist','044_voice_billing','045_voice_sip','046_voice_telnyx','047_voice_logic']) {
    const statements=readFileSync(new URL(`../../migrations/${migration}.sql`,import.meta.url),'utf8').split(';').map(value=>value.trim()).filter(Boolean);
    for (const statement of statements) await db.prepare(statement).run();
  }
  for (const migration of ['020_accounting_ledger','026_build_ai_billing']) {
    const sql=readFileSync(new URL(`../../migrations/${migration}.sql`,import.meta.url),'utf8').replace(/^--.*$/gm,'');
    const statements=sql.match(/\s*CREATE TRIGGER[\s\S]*?END;|\s*[^;]+;/g)!;
    for (const statement of statements) await db.prepare(statement.trim()).run();
  }
  await db.prepare("INSERT INTO users(id,email,name,created_at) VALUES('voice-user','voice@example.com','Voice User',?)").bind(new Date().toISOString()).run();
  await db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,'voice-user','2099-01-01T00:00:00.000Z')").bind(await hashToken('voice-test-session')).run();
  const headers={Cookie:'mainbrella_session=voice-test-session',Origin:'https://mainbrella.com','Content-Type':'application/json'};
  const request=(path:string,method='GET',body?:unknown)=>mf.dispatchFetch(`https://api.mainbrella.com${path}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  const fundedAt=Date.now();
  const funding=await request('/__test_billing/funding','POST',{id:'pi_voice',customerId:'cus_voice',amountCents:500,
    refundedCents:0,disputed:false,createdAt:fundedAt,kind:'topup'});
  assert.equal(funding.status,200,await funding.clone().text());
  const config={name:'Maya',businessName:'Test workshop',greeting:'Hello, how can I help?',instructions:'Take a message. Open weekdays.',voice:'asteria',transferNumber:null};
  const saved=await request('/voice/agent','PUT',config);
  assert.equal(saved.status,200,await saved.clone().text());
  await db.prepare("UPDATE voice_agents SET id='11111111-1111-4111-8111-111111111111'").run();
  async function create(channel='text') {
    const response=await request('/voice/calls','POST',{channel});
    assert.equal(response.status,201,await response.clone().text());
    return response.json() as Promise<any>;
  }
  async function setVoiceLogic(voiceLogic:'original_no_reply'|'reply_right_away') {
    const response=await request('/voice/agent','PUT',{...config,voiceLogic});
    assert.equal(response.status,200,await response.clone().text());
  }
  return {mf,db,headers,request,create,setVoiceLogic,fundedAt};
}
async function until(predicate:()=>boolean|Promise<boolean>,message:string,timeout=8000) {
  const deadline=Date.now()+timeout;
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

async function browserCall(t:test.TestContext,f:Awaited<ReturnType<typeof runtime>>) {
  const created=await f.create('browser');
  const response=await f.mf.dispatchFetch(created.websocketUrl.replace('wss:','https:'),{headers:{...f.headers,Upgrade:'websocket'}});
  assert.equal(response.status,101);
  const ws=response.webSocket!;const messages:any[]=[];const audio:number[]=[];
  ws.addEventListener('message',event=>{
    if(typeof event.data==='string')messages.push(JSON.parse(event.data));
    else audio.push(new DataView(event.data as ArrayBuffer).getInt16(0,true));
  });
  ws.accept();t.after(()=>ws.close());ws.send(JSON.stringify({type:'start_call'}));
  await until(()=>audio.length===1,'Voice greeting missing');
  return {ws,messages,audio,callId:created.call.id as string};
}

async function telnyxCall(t:test.TestContext,f:Awaited<ReturnType<typeof runtime>>) {
  const body=new URLSearchParams({AccountSid:TELNYX_TEST_ACCOUNT,ConnectionId:TELNYX_TEST_CONNECTION,CallSid:TELNYX_TEST_CALL,
    To:TELNYX_TEST_BINDINGS.TELNYX_PHONE_NUMBER}).toString();
  const incoming=await f.mf.dispatchFetch('https://api.mainbrella.com/voice/telnyx/incoming/11111111-1111-4111-8111-111111111111',{
    method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',...telnyxTestSignature(body)},body});
  assert.equal(incoming.status,200);
  const xml=await incoming.text(),wssUrl=xml.match(/<Stream url="([^"]+)"/)![1],token=xml.match(/name="token" value="([^"]+)"/)![1];
  const response=await f.mf.dispatchFetch(wssUrl.replace('wss:','https:'),{headers:{Upgrade:'websocket',...telnyxTestSignature(wssUrl)}});
  assert.equal(response.status,101);
  const ws=response.webSocket!;const messages:any[]=[];const audio:string[]=[];
  ws.addEventListener('message',event=>{
    const message=JSON.parse(String(event.data));messages.push(message);
    if(message.event==='media')audio.push(message.media.payload);
  });
  ws.accept();t.after(()=>ws.close());
  const streamId=crypto.randomUUID();
  ws.send(JSON.stringify({event:'start',stream_id:streamId,start:{call_control_id:TELNYX_TEST_CALL,user_id:TELNYX_TEST_ACCOUNT,
    media_format:{encoding:'PCMU',sample_rate:8000,channels:1},custom_parameters:{token}}}));
  await until(()=>audio.length===1,'Telnyx greeting missing');
  const speak=()=>ws.send(JSON.stringify({event:'media',stream_id:streamId,media:{track:'inbound',payload:Buffer.alloc(160,255).toString('base64')}}));
  const stop=()=>ws.send(JSON.stringify({event:'stop',stream_id:streamId}));
  return {ws,messages,audio,speak,stop,callId:wssUrl.split('/').at(-1)!};
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
  const usage=await f.db.prepare('SELECT * FROM voice_usage WHERE call_id=?').bind(created.call.id).all() as any;
  assert.equal(usage.results.length,1);assert.equal(usage.results[0].status,'settled');assert.equal(usage.results[0].cost_micro_usd,113);
  const ledger=await f.db.prepare("SELECT * FROM accounting_ledger WHERE event_type='inference' AND user_id='voice-user'").all() as any;
  assert.equal(ledger.results.length,1);assert.equal(JSON.parse(ledger.results[0].payload).callId,created.call.id);
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
  const usage=await f.db.prepare('SELECT * FROM voice_usage WHERE call_id=?').bind(created.call.id).all() as any;
  assert.ok(usage.results.every((row:any)=>row.status==='settled'));
  assert.equal(usage.results.filter((row:any)=>row.model==='@cf/deepgram/aura-1').length,2,'Default calls synthesize only the greeting and answer');
  assert.deepEqual(new Set(usage.results.map((row:any)=>row.model)),new Set(['@cf/deepgram/flux','@cf/deepgram/aura-1','@cf/meta/llama-3.3-70b-instruct-fp8-fast']));
  const stt=usage.results.find((row:any)=>row.model==='@cf/deepgram/flux');
  assert.equal(JSON.parse(stt.usage_json).audioBytes,640);assert.equal(stt.cost_micro_usd,5);
});

test('reply_right_away rotates cached cues before whole speech replies without changing conversation history',async t=>{
  const f=await runtime(t,{VOICE_TEST_MULTI_TURN:'true',VOICE_TEST_MULTI_SENTENCE:'true',VOICE_TEST_REPLY_DELAY_MS:'500',
    VOICE_TEST_REJECT_TTS_OVERLAP:'true',VOICE_TEST_TTS_DELAY_MS:'30'});
  await f.setVoiceLogic('reply_right_away');
  const call=await browserCall(t,f);
  assert.deepEqual(call.audio,[0],'Preparation is silent and only the greeting plays before speech');
  for(let turn=0;turn<4;turn++) {
    call.ws.send(new Uint8Array(640).buffer);
    await until(()=>call.audio.length===2+turn*2,'Immediate cue missing',400);
    assert.equal(call.audio.at(-1),1000+(turn%3)*2000);
    const before=await (await f.request(`/voice/calls/${call.callId}`)).json() as any;
    assert.equal(before.call.transcript.filter((message:any)=>message.role==='assistant').length,turn+1,'Cue must arrive before the delayed answer');
    await until(()=>call.audio.length===3+turn*2,'Whole speech reply missing');
    await until(async()=>((await (await f.request(`/voice/calls/${call.callId}`)).json()) as any).call.transcript.length===3+turn*2,'Speech history missing');
  }
  assert.deepEqual(call.audio,[0,1000,2000,3000,2000,5000,2000,1000,2000],'Cues rotate and wrap, each followed by exactly one complete answer buffer');
  assert.ok(!call.messages.some(message=>message.type==='error'||message.type==='transcript_delta'));
  const inspected=await (await f.request(`/__test_inspect/${call.callId}`)).json() as any;
  assert.equal(inspected.state.closed,false);
  assert.ok(inspected.history.every((message:any)=>!acknowledgmentPhrases.some(phrase=>message.content.includes(phrase))),'Audio cues must not become model conversation history');
  assert.equal((await f.request(`/voice/calls/${call.callId}/end`,'POST')).status,200);
  const usage=await f.db.prepare("SELECT * FROM voice_usage WHERE call_id=? AND model='@cf/deepgram/aura-1'").bind(call.callId).all() as any;
  assert.equal(usage.results.length,8,'Three preparations, one greeting, and one TTS request per complete answer');
  assert.ok(usage.results.every((row:any)=>row.status==='settled'));
  const preparations=usage.results.filter((row:any)=>JSON.parse(row.usage_json).purpose==='reply_right_away');
  assert.equal(preparations.length,3,'Each phrase is prepared once; replays never call or bill the provider again');
  assert.deepEqual(preparations.map((row:any)=>JSON.parse(row.usage_json).characters).sort(),acknowledgmentPhrases.map(phrase=>phrase.length).sort());
});

test('reply_right_away leaves text tests free of acknowledgment audio and extra inference',async t=>{
  const f=await runtime(t);await f.setVoiceLogic('reply_right_away');
  const created=await f.create('text');
  const {transport}=clientTransport(f.mf,created.websocketUrl,f.headers);
  const client=new VoiceClient({agent:'ReceptionistCall',transport});t.after(()=>client.disconnect());client.connect();
  await until(()=>client.transcript.length===1,'Text greeting missing');
  client.sendText('Please take a message.');
  await until(()=>client.transcript.at(-1)?.text==='I can take a message: Please take a message.','Text answer missing');
  assert.equal(client.error,null);assert.equal(client.transcript.length,3);
  await f.request(`/voice/calls/${created.call.id}/end`,'POST');
  const usage=await f.db.prepare('SELECT model,status FROM voice_usage WHERE call_id=?').bind(created.call.id).all() as any;
  assert.deepEqual(usage.results,[{model:'@cf/meta/llama-3.3-70b-instruct-fp8-fast',status:'settled'}]);
});

test('reply_right_away barge-in cancels the stale reply, accepts the next speech turn, and stops audio after hangup',async t=>{
  const f=await runtime(t,{VOICE_TEST_MULTI_TURN:'true',VOICE_TEST_REPLY_DELAY_MS:'1200'});
  await f.setVoiceLogic('reply_right_away');const call=await browserCall(t,f);
  call.ws.send(new Uint8Array(640).buffer);
  await until(()=>call.audio.length===2,'First acknowledgment missing');
  await until(async()=>{
    const rows=await f.db.prepare("SELECT id FROM voice_usage WHERE call_id=? AND model='@cf/meta/llama-3.3-70b-instruct-fp8-fast' AND status='running'").bind(call.callId).all() as any;
    return rows.results.length===1;
  },'First inference not started');
  // Replying immediately to the cue must interrupt the old turn, not trip the
  // original flavor's 750 ms duplicate-turn hangup guard.
  call.ws.send(new Uint8Array(640).buffer);
  await until(()=>call.audio.length===3,'Second acknowledgment missing');
  assert.ok(call.messages.some(message=>message.type==='playback_interrupt'));
  await until(()=>call.audio.length===4,'Replacement reply missing');
  assert.deepEqual(call.audio,[0,1000,3000,2000],'Interrupted reply must not play after the replacement cue');
  const replies=call.messages.filter(message=>message.type==='transcript_end').map(message=>message.text);
  assert.ok(!replies.includes('I can take a message: Could I leave a message?'));
  assert.ok(replies.includes('I can take a message: Could I change that message?'));
  call.ws.send(new Uint8Array(640).buffer);
  await until(()=>call.audio.length===5,'Final acknowledgment missing');
  await f.request(`/voice/calls/${call.callId}/end`,'POST');
  await until(async()=>{
    const rows=await f.db.prepare('SELECT status FROM voice_usage WHERE call_id=?').bind(call.callId).all() as any;
    return rows.results.every((row:any)=>row.status==='settled');
  },'Interrupted or ended inference did not settle');
  assert.deepEqual(call.audio,[0,1000,3000,2000,5000],'Hanging up while the model is working must suppress its answer');
  assert.ok(!call.messages.some(message=>message.type==='error'));
  const detail=await (await f.request(`/voice/calls/${call.callId}`)).json() as any;
  assert.equal(detail.call.status,'completed');
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


for (const transport of ['pstn','sip'] as const) {
test(`signed Twilio ${transport} WebSocket bridges μ-law through the real Agent, settles its tariff and rejects media token reuse`,async t=>{
  const f=await runtime(t,transport === 'sip' ? {TWILIO_PHONE_NUMBER:'',VOICE_PHONE_MICRO_USD_PER_MINUTE:'',
    TWILIO_SIP_URI:'sip:receptionist@mainbrella.sip.us1.twilio.com',VOICE_SIP_MICRO_USD_PER_MINUTE:'4000'} : {});
  const agentId='11111111-1111-4111-8111-111111111111';
  const providerCallId='CA'+'b'.repeat(32);
  const incoming=`https://api.mainbrella.com/voice/twilio/incoming/${agentId}`;
  const fields={AccountSid:'AC'+'a'.repeat(32),To:transport === 'sip' ? 'sip:receptionist@mainbrella.sip.us1.twilio.com' : '+15551234567',CallSid:providerCallId};
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
  const model=transport === 'sip' ? 'twilio-sip-inbound' : 'twilio-inbound';
  const usage=await f.db.prepare('SELECT * FROM voice_usage WHERE call_id=? AND model=?').bind(callId,model).first() as any;
  assert.equal(usage.status,'settled');assert.equal(usage.reserved_micro_usd,transport === 'sip' ? 90000 : 281250);assert.equal(usage.cost_micro_usd,transport === 'sip' ? 6000 : 18750);
  assert.equal(JSON.parse(usage.usage_json).minutes,1);
  const detail=await (await f.request(`/voice/calls/${callId}`)).json() as any;
  assert.equal(detail.call.channel,'phone');assert.equal(detail.call.phoneTransport,transport);
  const state=await (await f.request(`/__test_inspect/${callId}`)).json() as any;
  assert.equal(state.state.phoneEnded,true);
  const ledger=await f.db.prepare("SELECT payload FROM accounting_ledger WHERE event_type='inference' AND json_extract(payload,'$.model')=?").bind(model).all() as any;
  assert.equal(ledger.results.length,1);
  assert.equal(JSON.parse(ledger.results[0].payload).providerCostMicroUsd,transport === 'sip' ? 4000 : 12500);
});
}


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

test('wallet exhaustion stops every active channel and denies new calls',async t=>{
  const f=await runtime(t);const first=await f.create('text');const second=await f.create('browser');
  const agentId='11111111-1111-4111-8111-111111111111';
  const url=`https://api.mainbrella.com/voice/twilio/incoming/${agentId}`;
  const fields={AccountSid:'AC'+'a'.repeat(32),To:'+15551234567',CallSid:'CA'+'d'.repeat(32)};
  const incoming=await f.mf.dispatchFetch(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',
    'X-Twilio-Signature':getExpectedTwilioSignature('voice-test-twilio-secret',url,fields)},body:new URLSearchParams(fields).toString()});
  assert.match(await incoming.text(),/<Stream/);
  const sockets:any[]=[];const errors:string[]=[];
  for (const created of [first,second]) {
    const response=await f.mf.dispatchFetch(created.websocketUrl.replace('wss:','https:'),{headers:{...f.headers,Upgrade:'websocket'}});
    assert.equal(response.status,101);const ws=response.webSocket!;ws.accept();sockets.push(ws);
    ws.addEventListener('message',(event:any)=>{if(typeof event.data==='string'){const message=JSON.parse(event.data);if(message.type==='error')errors.push(message.message);}});
    if(created===second)ws.send(JSON.stringify({type:'start_call'}));
  }
  t.after(()=>sockets.forEach(ws=>ws.close()));
  await until(async()=>{const usage=await f.db.prepare("SELECT count(*) AS count FROM voice_usage WHERE model='@cf/deepgram/aura-1' AND status='settled'").first() as any;return usage.count>0;},'Greeting not billed');
  const revoked=await f.request('/__test_billing/funding','POST',{id:'pi_voice',customerId:'cus_voice',amountCents:500,
    refundedCents:500,disputed:false,createdAt:f.fundedAt,kind:'topup'});
  assert.equal(revoked.status,200);
  await until(async()=>{const rows=await f.db.prepare("SELECT status FROM voice_calls").all() as any;
    return rows.results.length===3&&rows.results.every((row:any)=>row.status==='failed');},'Account calls not stopped within balance polling interval');
  assert.ok(errors.some(message=>/credit|billing/i.test(message)));
  assert.equal((await f.request('/voice/calls','POST',{channel:'text'})).status,402);
});

test('a turn that cannot reserve its cost ends all sibling calls before inference',async t=>{
  const f=await runtime(t);const first=await f.create();const second=await f.create();
  const {transport}=clientTransport(f.mf,first.websocketUrl,f.headers);
  const client=new VoiceClient({agent:'ReceptionistCall',transport});t.after(()=>client.disconnect());client.connect();
  await until(()=>client.transcript.length===1,'Greeting missing');
  // Leave $0.000001 available: the exact check succeeds, inference reservation fails.
  const used=await f.request('/__test_billing/inference','POST',{action:'reserve',id:`${crypto.randomUUID()}:other`,
    model:'other',appId:'other',turnId:'other',reservedMicroUsd:4_999_999,createdAt:Date.now()});
  assert.equal(used.status,200);client.sendText('Cannot afford this response');
  await until(async()=>{const rows=await f.db.prepare("SELECT status FROM voice_calls WHERE id IN (?,?)").bind(first.call.id,second.call.id).all() as any;
    return rows.results.every((row:any)=>row.status==='failed');},'Sibling calls stayed active');
  const rows=await f.db.prepare('SELECT * FROM voice_usage WHERE call_id=?').bind(first.call.id).all() as any;
  assert.equal(rows.results.length,1);assert.equal(rows.results[0].status,'denied');
  assert.equal(JSON.parse(rows.results[0].usage_json).error,'insufficient_balance');
});

test('known provider usage is charged after a call ends during inference',async t=>{
  const f=await runtime(t);const created=await f.create();const {transport}=clientTransport(f.mf,created.websocketUrl,f.headers);
  const client=new VoiceClient({agent:'ReceptionistCall',transport});t.after(()=>client.disconnect());client.connect();
  await until(()=>client.transcript.length===1,'Greeting missing');client.sendText('slow model');
  await until(async()=>{const rows=await f.db.prepare("SELECT count(*) AS count FROM voice_usage WHERE call_id=? AND status='running'").bind(created.call.id).first() as any;return rows.count===1;},'Inference not dispatched');
  assert.equal((await f.request(`/voice/calls/${created.call.id}/end`,'POST')).status,200);
  await until(async()=>{const row=await f.db.prepare('SELECT * FROM voice_usage WHERE call_id=?').bind(created.call.id).first() as any;
    return row.status==='settled'&&row.cost_micro_usd===113;},'Interrupted provider usage not charged');
});

test('missing provider usage fails closed and retains the inference reservation',async t=>{
  const f=await runtime(t);const created=await f.create();const {transport}=clientTransport(f.mf,created.websocketUrl,f.headers);
  const client=new VoiceClient({agent:'ReceptionistCall',transport});t.after(()=>client.disconnect());client.connect();
  await until(()=>client.transcript.length===1,'Greeting missing');client.sendText('missing usage');
  await until(async()=>{const result=await f.request(`/voice/calls/${created.call.id}`);return (await result.json() as any).call.status==='failed';},'Unmetered call not stopped');
  const usage=await f.db.prepare('SELECT * FROM voice_usage WHERE call_id=?').bind(created.call.id).first() as any;
  assert.equal(usage.status,'running');assert.equal(usage.cost_micro_usd,null);
  assert.ok(usage.reserved_micro_usd>0);
});

test('account cutoff retries sibling delivery across repeated outages',async t=>{
  const f=await runtime(t);const first=await f.create();const second=await f.create();
  assert.equal((await f.request(`/__test_stop_outage/stop/${first.call.id}`,'POST')).status,204);
  const {transport}=clientTransport(f.mf,first.websocketUrl,f.headers);
  const client=new VoiceClient({agent:'ReceptionistCall',transport});t.after(()=>client.disconnect());client.connect();
  await until(()=>client.transcript.length===1,'Greeting missing');
  const used=await f.request('/__test_billing/inference','POST',{action:'reserve',id:`${crypto.randomUUID()}:other`,
    model:'other',appId:'other',turnId:'other',reservedMicroUsd:4_999_999,createdAt:Date.now()});
  assert.equal(used.status,200);client.sendText('Unaffordable');
  await until(async()=>{const result=await f.request(`/voice/calls/${first.call.id}`);return (await result.json() as any).call.status==='failed';},'First call not ended');
  assert.equal((await (await f.request(`/voice/calls/${second.call.id}`)).json() as any).call.status,'active');
  await until(async()=>{const result=await f.request(`/voice/calls/${second.call.id}`);return (await result.json() as any).call.status==='failed';},'Durable sibling retry did not finish',16000);
});

test('phone shutdown retries repeated provider outages before releasing the transport hold',async t=>{
  const f=await runtime(t);const agentId='11111111-1111-4111-8111-111111111111';
  const url=`https://api.mainbrella.com/voice/twilio/incoming/${agentId}`;
  const fields={AccountSid:'AC'+'a'.repeat(32),To:'+15551234567',CallSid:'CA'+'e'.repeat(32)};
  const response=await f.mf.dispatchFetch(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',
    'X-Twilio-Signature':getExpectedTwilioSignature('voice-test-twilio-secret',url,fields)},body:new URLSearchParams(fields).toString()});
  assert.match(await response.text(),/<Stream/);
  const call=await f.db.prepare('SELECT * FROM voice_calls WHERE provider_call_id=?').bind(fields.CallSid).first() as any;
  assert.equal((await f.request(`/__test_stop_outage/phone/${call.id}`,'POST')).status,204);
  assert.equal((await f.request(`/voice/calls/${call.id}/end`,'POST')).status,503);
  const pending=await f.db.prepare("SELECT * FROM voice_usage WHERE call_id=? AND model='twilio-inbound'").bind(call.id).first() as any;
  assert.equal(pending.status,'running');
  await until(async()=>{const result=await f.request(`/voice/calls/${call.id}`);return (await result.json() as any).call.status==='completed';},'Durable provider shutdown retry did not finish',16000);
  const settled=await f.db.prepare("SELECT * FROM voice_usage WHERE call_id=? AND model='twilio-inbound'").bind(call.id).first() as any;
  assert.equal(settled.status,'settled');assert.equal(settled.cost_micro_usd,18750);
});

test('speech windows settle all forwarded audio and a normal hangup keeps sibling calls active',async t=>{
  const f=await runtime(t);const created=await f.create('browser');const sibling=await f.create();
  const response=await f.mf.dispatchFetch(created.websocketUrl.replace('wss:','https:'),{headers:{...f.headers,Upgrade:'websocket'}});
  const ws=response.webSocket!;ws.accept();t.after(()=>ws.close());
  let audioReceived=false;ws.addEventListener('message',(event:any)=>{if(typeof event.data!=='string')audioReceived=true;});
  ws.send(JSON.stringify({type:'start_call'}));
  await until(()=>audioReceived,'Greeting missing');
  for(let i=0;i<6;i++)ws.send(new ArrayBuffer(16000));
  await new Promise(resolve=>setTimeout(resolve,1100));
  for(let i=0;i<6;i++)ws.send(new ArrayBuffer(16000));
  await until(async()=>{const inspected=await (await f.request(`/__test_inspect/${created.call.id}`)).json() as any;
    return inspected.state.stt?.bytes===32000;},'Second audio window not metered');
  assert.equal((await f.request(`/voice/calls/${created.call.id}/end`,'POST')).status,200);
  const {results}=await f.db.prepare("SELECT * FROM voice_usage WHERE call_id=? AND model='@cf/deepgram/flux'").bind(created.call.id).all() as any;
  assert.equal(results.length,2);assert.ok(results.every((row:any)=>row.status==='settled'));
  assert.equal(results.reduce((sum:number,row:any)=>sum+JSON.parse(row.usage_json).audioBytes,0),192000);
  assert.equal((await (await f.request(`/voice/calls/${sibling.call.id}`)).json() as any).call.status,'active');
});

for(const transport of ['pstn','sip'] as const) {
  test(`Telnyx ${transport} media streams round-trip audio through the Agent, settle Telnyx rates and consume tokens once`,async t=>{
    const agentId='11111111-1111-4111-8111-111111111111';
    const f=await runtime(t,{...TELNYX_TEST_BINDINGS,TELNYX_AGENT_ID:agentId,
      ...(transport==='sip'?{TELNYX_PHONE_NUMBER:'',TELNYX_PHONE_MICRO_USD_PER_MINUTE:'',TELNYX_SIP_URI:TELNYX_TEST_SIP,TELNYX_SIP_MICRO_USD_PER_MINUTE:'3000'}:{})});
    const body=new URLSearchParams({AccountSid:TELNYX_TEST_ACCOUNT,ConnectionId:TELNYX_TEST_CONNECTION,CallSid:TELNYX_TEST_CALL,
      To:transport==='sip'?'receptionist':TELNYX_TEST_BINDINGS.TELNYX_PHONE_NUMBER,
      ToSipUri:transport==='sip'?'receptionist@mainbrella.sip.telnyx.com':`${TELNYX_TEST_BINDINGS.TELNYX_PHONE_NUMBER}@sip.telnyx.com`}).toString();
    const incoming=await f.mf.dispatchFetch(`https://api.mainbrella.com/voice/telnyx/incoming/${agentId}`,{
      method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',...telnyxTestSignature(body)},body});
    assert.equal(incoming.status,200);const xml=await incoming.text();
    const wssUrl=xml.match(/<Stream url="([^"]+)"/)![1],token=xml.match(/name="token" value="([^"]+)"/)![1];
    const url=wssUrl.replace('wss:','https:');const callId=url.split('/').at(-1)!;
    const upgrade=()=>f.mf.dispatchFetch(url,{headers:{Upgrade:'websocket',...telnyxTestSignature(wssUrl)}});
    const response=await upgrade();assert.equal(response.status,101);
    const ws=response.webSocket!;const messages:any[]=[];
    ws.addEventListener('message',event=>messages.push(JSON.parse(String(event.data))));ws.accept();t.after(()=>ws.close());
    const streamId=crypto.randomUUID();
    ws.send(JSON.stringify({event:'connected',version:'1.0.0'}));
    ws.send(JSON.stringify({event:'start',stream_id:streamId,start:{call_control_id:TELNYX_TEST_CALL,user_id:TELNYX_TEST_ACCOUNT.toUpperCase(),
      media_format:{encoding:'PCMU',sample_rate:8000,channels:1},custom_parameters:{token}}}));
    await until(()=>messages.some(message=>message.event==='media'),'Telnyx greeting missing');
    assert.ok(messages.every(message=>message.event==='media' && Buffer.from(message.media.payload,'base64').length===160));
    assert.equal((await upgrade()).status,404);
    ws.send(JSON.stringify({event:'media',stream_id:streamId,media:{track:'inbound',payload:Buffer.alloc(160,255).toString('base64')}}));
    await until(async()=>((await (await f.request(`/voice/calls/${callId}`)).json()) as any).call.transcript.length===3,'Telnyx speech transcript missing');
    ws.send(JSON.stringify({event:'stop',stream_id:streamId}));
    await until(async()=>((await (await f.request(`/voice/calls/${callId}`)).json()) as any).call.status==='completed','Telnyx call did not end');
    const detail=await (await f.request(`/voice/calls/${callId}`)).json() as any;
    assert.equal(detail.call.phoneProvider,'telnyx');assert.equal(detail.call.phoneTransport,transport);
    const model=transport==='sip'?'telnyx-sip-inbound':'telnyx-inbound';
    const usage=await f.db.prepare('SELECT * FROM voice_usage WHERE call_id=? AND model=?').bind(callId,model).first() as any;
    assert.equal(usage.status,'settled');assert.equal(usage.reserved_micro_usd,transport==='sip'?67500:225000);
    assert.equal(usage.cost_micro_usd,transport==='sip'?4500:15000);
    assert.equal(JSON.parse(usage.usage_json).durationSeconds,1);
    const state=await (await f.request(`/__test_inspect/${callId}`)).json() as any;
    assert.equal(state.state.phoneProvider,'telnyx');assert.equal(state.state.phoneEnded,true);
    const ledger=await f.db.prepare("SELECT payload FROM accounting_ledger WHERE event_type='inference' AND json_extract(payload,'$.model')=?").bind(model).all() as any;
    assert.equal(ledger.results.length,1);assert.equal(JSON.parse(ledger.results[0].payload).providerCostMicroUsd,transport==='sip'?3000:10000);
  });
}

test('Telnyx reply_right_away keeps the phone open through cached cues and ordered complete replies',async t=>{
  const f=await runtime(t,{...TELNYX_TEST_BINDINGS,TELNYX_AGENT_ID:'11111111-1111-4111-8111-111111111111',
    VOICE_TEST_MULTI_TURN:'true',VOICE_TEST_MULTI_SENTENCE:'true',VOICE_TEST_REPLY_DELAY_MS:'500',
    VOICE_TEST_REJECT_TTS_OVERLAP:'true',VOICE_TEST_TTS_DELAY_MS:'30'});
  await f.setVoiceLogic('reply_right_away');const call=await telnyxCall(t,f);
  const payload=(sample:number)=>pcmToTelnyx(new Int16Array(320).fill(sample).buffer)[0];
  for(let turn=0;turn<4;turn++) {
    call.speak();
    await until(()=>call.audio.length===2+turn*2,'Telnyx immediate cue missing',400);
    assert.equal(call.audio.at(-1),payload(1000+(turn%3)*2000));
    await until(()=>call.audio.length===3+turn*2,'Telnyx answer missing');
    await until(async()=>((await (await f.request(`/voice/calls/${call.callId}`)).json()) as any).call.transcript.length===3+turn*2,'Telnyx transcript missing');
    const detail=await (await f.request(`/voice/calls/${call.callId}`)).json() as any;
    assert.equal(detail.call.status,'active','An acknowledgment must not hang up the call');
    assert.ok(!detail.call.transcript.some((message:any)=>acknowledgmentPhrases.some(phrase=>message.text.includes(phrase))));
  }
  assert.deepEqual(call.audio,[0,1000,2000,3000,2000,5000,2000,1000,2000].map(payload),'Telnyx must receive each rotating cue before its answer');
  assert.ok(call.audio.every(frame=>Buffer.from(frame,'base64').length===160));
  const beforeStop=await (await f.request(`/__test_inspect/${call.callId}`)).json() as any;
  assert.notEqual(beforeStop.state.phoneEnded,true);
  call.stop();
  await until(async()=>((await (await f.request(`/voice/calls/${call.callId}`)).json()) as any).call.status==='completed','Telnyx normal hangup failed');
  const usage=await f.db.prepare("SELECT * FROM voice_usage WHERE call_id=? AND model='@cf/deepgram/aura-1'").bind(call.callId).all() as any;
  assert.equal(usage.results.length,8);
  assert.ok(usage.results.every((row:any)=>row.status==='settled'));
  assert.equal(usage.results.filter((row:any)=>JSON.parse(row.usage_json).purpose==='reply_right_away').length,3);
});

test('reply_right_away keeps prepared cues if a later phrase fails, without retrying or hanging up',async t=>{
  const f=await runtime(t,{VOICE_TEST_MULTI_TURN:'true',VOICE_TEST_ACK_FAILURE:'provider',
    VOICE_TEST_ACK_FAILURE_TEXT:'Got it, just a sec.'});
  await f.setVoiceLogic('reply_right_away');const call=await browserCall(t,f);
  for(let turn=0;turn<2;turn++) {
    call.ws.send(new Uint8Array(640).buffer);
    await until(()=>call.audio.length===3+turn*2,'Reply missing after partial cue preparation');
    await until(async()=>((await (await f.request(`/voice/calls/${call.callId}`)).json()) as any).call.transcript.length===3+turn*2,'Transcript missing after partial cue preparation');
  }
  assert.deepEqual(call.audio,[0,1000,2000,1000,2000],'A failed later phrase must preserve earlier cached audio');
  assert.ok(!call.messages.some(message=>message.type==='error'));
  const detail=await (await f.request(`/voice/calls/${call.callId}`)).json() as any;
  assert.equal(detail.call.status,'active');
  await f.request(`/voice/calls/${call.callId}/end`,'POST');
  const usage=await f.db.prepare("SELECT * FROM voice_usage WHERE call_id=? AND model='@cf/deepgram/aura-1'").bind(call.callId).all() as any;
  assert.equal(usage.results.length,5,'Preparation stops at the first failure and never retries during turns');
  assert.equal(usage.results.filter((row:any)=>row.status==='running').length,1,'Unknown provider usage retains its reservation');
});

for(const failure of ['provider','odd_pcm','empty_pcm']) {
  test(`Telnyx reply_right_away skips ${failure} cue failures without closing this call or sibling calls`,async t=>{
    const f=await runtime(t,{...TELNYX_TEST_BINDINGS,TELNYX_AGENT_ID:'11111111-1111-4111-8111-111111111111',VOICE_TEST_ACK_FAILURE:failure,
      VOICE_TEST_MULTI_TURN:'true'});
    await f.setVoiceLogic('reply_right_away');const sibling=await f.create('text');const call=await telnyxCall(t,f);
    for(let turn=0;turn<2;turn++) {
      call.speak();
      await until(()=>call.audio.length===2+turn,'Normal answer missing after failed cue');
      await until(async()=>((await (await f.request(`/voice/calls/${call.callId}`)).json()) as any).call.transcript.length===3+turn*2,'Transcript missing after failed cue');
    }
    assert.deepEqual(call.audio,[0,2000,2000].map(sample=>pcmToTelnyx(new Int16Array(320).fill(sample).buffer)[0]));
    const inspected=await (await f.request(`/__test_inspect/${call.callId}`)).json() as any;
    assert.equal(inspected.state.closed,false);assert.notEqual(inspected.state.phoneEnded,true);
    assert.equal((await (await f.request(`/voice/calls/${sibling.call.id}`)).json() as any).call.status,'active');
    const usage=await f.db.prepare("SELECT status FROM voice_usage WHERE call_id=? AND model='@cf/deepgram/aura-1'").bind(call.callId).all() as any;
    assert.equal(usage.results.length,4,'Failed optional preparation must not retry on later turns');
    assert.equal(usage.results.filter((row:any)=>row.status==='settled').length,3,'Normal greeting and replies stay metered');
    assert.equal(usage.results.filter((row:any)=>row.status==='running').length,1,'Unknown provider usage retains its reservation');
    call.stop();
    await until(async()=>((await (await f.request(`/voice/calls/${call.callId}`)).json()) as any).call.status==='completed','Telnyx normal hangup failed');
    await f.request(`/voice/calls/${sibling.call.id}/end`,'POST');
  });
}

test('Telnyx media rejects wrong tokens, call identities, formats and expired tokens before AI dispatch',async t=>{
  const agentId='11111111-1111-4111-8111-111111111111';
  const f=await runtime(t,{...TELNYX_TEST_BINDINGS,TELNYX_AGENT_ID:agentId});
  for(const fault of ['token','identity','format','expired']) {
    const providerCallId=`v3:${fault}`;
    const body=new URLSearchParams({AccountSid:TELNYX_TEST_ACCOUNT,ConnectionId:TELNYX_TEST_CONNECTION,CallSid:providerCallId,To:TELNYX_TEST_BINDINGS.TELNYX_PHONE_NUMBER}).toString();
    const incoming=await f.mf.dispatchFetch(`https://api.mainbrella.com/voice/telnyx/incoming/${agentId}`,{
      method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',...telnyxTestSignature(body)},body});
    const xml=await incoming.text(),wssUrl=xml.match(/<Stream url="([^"]+)"/)![1],token=xml.match(/name="token" value="([^"]+)"/)![1];
    const callId=wssUrl.split('/').at(-1)!;
    if(fault==='expired')await f.db.prepare("UPDATE voice_calls SET media_token_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").bind(callId).run();
    const response=await f.mf.dispatchFetch(wssUrl.replace('wss:','https:'),{headers:{Upgrade:'websocket',...telnyxTestSignature(wssUrl)}});
    assert.equal(response.status,101);const ws=response.webSocket!;const messages:any[]=[];ws.accept();
    ws.addEventListener('message',event=>messages.push(event.data));
    ws.send(JSON.stringify({event:'start',stream_id:crypto.randomUUID(),start:{call_control_id:fault==='identity'?'v3:another':providerCallId,
      user_id:TELNYX_TEST_ACCOUNT,media_format:{encoding:fault==='format'?'OPUS':'PCMU',sample_rate:8000,channels:1},custom_parameters:{token:fault==='token'?'0'.repeat(64):token}}}));
    await until(async()=>((await (await f.request(`/voice/calls/${callId}`)).json()) as any).call.status==='failed',`Telnyx ${fault} did not close`);
    assert.deepEqual(messages,[]);
    assert.equal((await (await f.request(`/voice/calls/${callId}`)).json() as any).call.transcript.length,0);
    ws.close();
  }
});
