// Deterministic Workers AI fixture: exercises the production Agent, STT/TTS
// protocol and persistence without running paid inference during tests.
import { ReceptionistCall as BaseCall } from '../durable-objects/receptionist-call';
import { handleVoiceRequest } from '../app/voice';
const ai = { async run(model: string,input: Record<string,unknown>) {
  if (model.includes('/flux')) {
    const pair=new WebSocketPair();pair[1].accept();
    let sent=false;
    pair[1].addEventListener('message',event=>{
      if (!sent && typeof event.data!=='string') { sent=true;pair[1].send(JSON.stringify({event:'EndOfTurn',transcript:'Could I leave a message?'})); }
    });
    return new Response(null,{status:101,webSocket:pair[0]});
  }
  if (model.includes('/aura-1')) {
    if (input.encoding!=='linear16' || input.container!=='none' || input.sample_rate!==16000) throw new Error('Raw PCM TTS required');
    return new Response(new Uint8Array(640),{headers:{'content-type':'audio/pcm'}});
  }
  const messages=input.messages as Array<{role:string;content:string}>;
  const caller=messages.at(-1)!.content;
  if (caller==='cause model failure') throw new Error('Fixture inference unavailable');
  return {response:`I can take a message: ${caller}`};
}};
export class ReceptionistCall extends BaseCall {
  private faults: {transcript:number;final:number};
  constructor(ctx: DurableObjectState,env: Env) {
    const faults={transcript:0,final:0};
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
    super(ctx,{...env,DB,AI:ai} as unknown as Env);
    this.faults=faults;
  }
  async stageFinalizationOutage():Promise<void>{
    this.faults.transcript=1;this.faults.final=1;
    this.saveMessage('assistant','Saved locally while D1 was unavailable.');
    await new Promise(resolve=>setTimeout(resolve,0));
  }
}
export default { async fetch(request: Request,env: Env,ctx: ExecutionContext) {
  const inspect=new URL(request.url).pathname.match(/^\/__test_inspect\/(.+)$/);
  if(inspect){const stub=env.RECEPTIONIST_CALL.get(env.RECEPTIONIST_CALL.idFromName(inspect[1]));return Response.json({state:await stub.state,history:await stub.getConversationHistory(121),schedules:await stub.listSchedules()});}
  const fault=new URL(request.url).pathname.match(/^\/__test_finalization_outage\/(.+)$/);
  if(fault){await (env.RECEPTIONIST_CALL.get(env.RECEPTIONIST_CALL.idFromName(fault[1])) as unknown as ReceptionistCall).stageFinalizationOutage();return new Response(null,{status:204});}
  const match=new URL(request.url).pathname.match(/^\/__test_purge\/(.+)$/);
  if(match){await env.RECEPTIONIST_CALL.get(env.RECEPTIONIST_CALL.idFromName(match[1])).purgeCall();return new Response(null,{status:204});}
  return handleVoiceRequest(request,{...env,AI:ai} as unknown as Env,ctx); } };
