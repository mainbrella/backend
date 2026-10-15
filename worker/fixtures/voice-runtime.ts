import { DurableObject } from 'cloudflare:workers';
import { ContainerAccountController } from '../../containers/container-account-core.js';
import { appendAccountingEvent } from '../lib/accounting-ledger';
// Deterministic Workers AI fixture: exercises the production Agent, STT/TTS
// protocol and persistence without running paid inference during tests.
import { ReceptionistCall as BaseCall } from '../durable-objects/receptionist-call';
import { handleVoiceRequest } from '../app/voice';
type VoiceTestEnv = Env & {
  VOICE_TEST_MULTI_TURN?:string; VOICE_TEST_FAIL_FILLER?:string; VOICE_TEST_REJECT_TTS_OVERLAP?:string;
  VOICE_TEST_MULTI_SENTENCE?:string; VOICE_TEST_DELAY_MODEL?:string; VOICE_TEST_MODEL_DELAY_MS?:string;
};
function createAI(env: VoiceTestEnv) {
  const testFlags=env;
  let activeTTS=0;
  return { async run(model: string,input: Record<string,unknown>) {
  if (model.includes('/flux')) {
    const pair=new WebSocketPair();pair[1].accept();
    let sent=0;
    pair[1].addEventListener('message',event=>{
      if (typeof event.data!=='string' && sent<(testFlags.VOICE_TEST_MULTI_TURN==='true'?2:1)) {
        sent++;
        pair[1].send(JSON.stringify({event:'EndOfTurn',transcript:'Could I leave a message?'}));
      }
    });
    return new Response(null,{status:101,webSocket:pair[0]});
  }
  if (model.includes('/aura-1')) {
    if (input.encoding!=='linear16' || input.container!=='none' || input.sample_rate!==16000) throw new Error('Raw PCM TTS required');
    const text=String(input.text);
    if(testFlags.VOICE_TEST_FAIL_FILLER==='true' && ['Mm-hmm.','Okay.','Ah-huh.'].includes(text)) throw new Error('Fixture optional filler outage');
    if(testFlags.VOICE_TEST_REJECT_TTS_OVERLAP==='true') {
      activeTTS++;
      if(activeTTS>1){activeTTS--;throw new Error('Fixture overlapping TTS requests');}
      await new Promise(resolve=>setTimeout(resolve,20));
      activeTTS--;
    }
    return new Response(new Uint8Array(640),{headers:{'content-type':'audio/pcm'}});
  }
  const messages=input.messages as Array<{role:string;content:string}>;
  const caller=messages.at(-1)!.content;
  if (caller==='slow model' || testFlags.VOICE_TEST_DELAY_MODEL==='true') await new Promise(resolve=>setTimeout(resolve,Number(testFlags.VOICE_TEST_MODEL_DELAY_MS)||200));
  if (caller==='waiting model') await new Promise(resolve=>setTimeout(resolve,6500));
  if (caller==='missing usage') return {response:'Unknown usage'};
  if (caller==='cause model failure') throw new Error('Fixture inference unavailable');
  const response=testFlags.VOICE_TEST_MULTI_SENTENCE==='true'
    ? `I can take a message: ${caller}. I will keep this information for the team.`
    : `I can take a message: ${caller}`;
  return {response,usage:{prompt_tokens:100,completion_tokens:20}};
}};
}
export class VoiceBillingAccount extends DurableObject<Env> {
  private controller: ContainerAccountController;
  constructor(ctx: DurableObjectState,env:Env) {
    super(ctx,env);
    this.controller=new ContainerAccountController(ctx,()=>{throw new Error('Unexpected compute');},Date.now,
      undefined,undefined,undefined,event=>appendAccountingEvent(env,event));
  }
  fetch(request:Request) { return this.controller.fetch(request); }
  alarm() { return this.controller.alarm(); }
}
export class ReceptionistCall extends BaseCall {
  private faults: {transcript:number;final:number;phone:number;stop:number};
  constructor(ctx: DurableObjectState,env: Env) {
    const faults={transcript:0,final:0,phone:0,stop:0};
    const wrap=(statement:D1PreparedStatement,query:string):D1PreparedStatement=>new Proxy(statement,{
      get(target,key){
        if(key==='bind')return(...values:unknown[])=>wrap(target.bind(...values),query);
        if(key==='run')return async()=>{
          const kind=query.startsWith('UPDATE voice_calls SET transcript_json=')?'transcript':query.startsWith('UPDATE voice_calls SET status=')?'final':null;
          if(kind && faults[kind]>0){faults[kind]--;throw new Error('One-time fixture D1 outage');}
          return target.run();
        };
        const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
      },
    });
    const DB=new Proxy(env.DB,{get(target,key){
      if(key==='prepare')return(query:string)=>wrap(target.prepare(query),query);
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    const RECEPTIONIST_CALL=new Proxy(env.RECEPTIONIST_CALL,{get(target,key){
      if(key==='get')return(id:DurableObjectId)=>{
        const stub=target.get(id);
        return {fetch:async(request:Request)=>{
          if(new URL(request.url).pathname==='/billing-stop'&&faults.stop>0){faults.stop--;throw new Error('Fixture sibling unavailable');}
          return stub.fetch(request);
        }};
      };
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    super(ctx,{...env,DB,RECEPTIONIST_CALL,AI:createAI(env as VoiceTestEnv)} as unknown as Env);
    this.faults=faults;
  }
  protected async hangupPhone(_callSid:string) {
    if(this.faults.phone>0){this.faults.phone--;throw new Error('Fixture Twilio outage');}
    return {durationSeconds:1,billableMinutes:1};
  }
  async stageStopOutage(kind:'phone'|'stop') {this.faults[kind]=2;}
  async stageFinalizationOutage():Promise<void>{
    this.faults.transcript=1;this.faults.final=1;
    this.saveMessage('assistant','Saved locally while D1 was unavailable.');
    await new Promise(resolve=>setTimeout(resolve,0));
  }
}
export default { async fetch(request: Request,env: Env,ctx: ExecutionContext) {
  const billing=new URL(request.url).pathname.match(/^\/__test_billing(\/.*)$/);
  if(billing) {
    return env.CONTAINER_ACCOUNT.get(env.CONTAINER_ACCOUNT.idFromName('account:voice-user')).fetch(new Request(`https://internal/billing${billing[1]}`,{
      method:request.method,headers:{'x-mainbrella-user':'voice-user','content-type':'application/json'},
      ...(request.method==='POST'?{body:await request.text()}:{}),
    }));
  }
  const inspect=new URL(request.url).pathname.match(/^\/__test_inspect\/(.+)$/);
  if(inspect){const stub=env.RECEPTIONIST_CALL.get(env.RECEPTIONIST_CALL.idFromName(inspect[1]));return Response.json({state:await stub.state,history:await stub.getConversationHistory(121),schedules:await stub.listSchedules()});}
  const stopFault=new URL(request.url).pathname.match(/^\/__test_stop_outage\/(phone|stop)\/(.+)$/);
  if(stopFault){await (env.RECEPTIONIST_CALL.get(env.RECEPTIONIST_CALL.idFromName(stopFault[2])) as unknown as ReceptionistCall).stageStopOutage(stopFault[1] as 'phone'|'stop');return new Response(null,{status:204});}
  const fault=new URL(request.url).pathname.match(/^\/__test_finalization_outage\/(.+)$/);
  if(fault){await (env.RECEPTIONIST_CALL.get(env.RECEPTIONIST_CALL.idFromName(fault[1])) as unknown as ReceptionistCall).stageFinalizationOutage();return new Response(null,{status:204});}
  const match=new URL(request.url).pathname.match(/^\/__test_purge\/(.+)$/);
  if(match){await env.RECEPTIONIST_CALL.get(env.RECEPTIONIST_CALL.idFromName(match[1])).purgeCall();return new Response(null,{status:204});}
  return handleVoiceRequest(request,{...env,AI:createAI(env as VoiceTestEnv)} as unknown as Env,ctx); } };
