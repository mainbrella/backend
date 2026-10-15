import { Agent, type Connection, type ConnectionContext } from 'agents';
import { withVoice, WorkersAIFluxSTT, type TTSProvider, type VoiceTurnContext } from '@cloudflare/voice';
import { MAX_CALL_MS, MAX_TURNS, readCall, receptionistMessages, VOICE_MODELS, type VoiceAgentConfig, type VoiceCallRow } from '../lib/voice';

const VoiceAgent = withVoice(Agent,{audioFormat:'pcm16',sampleRate:16000,historyLimit:20,maxMessageCount:MAX_TURNS*2+1});
interface CallState {
  callId: string; userId: string; channel: VoiceCallRow['channel']; startedAt: string;
  config: VoiceAgentConfig; closed: boolean; failed: boolean; turns: number;
}
interface SocketState { accepted: boolean; started: boolean }

/** One durable Agent and one conversation history for each call, never an account-wide Agent. */
export class ReceptionistCall extends VoiceAgent<Env,CallState | null> {
  initialState: CallState | null = null;
  transcriber = new WorkersAIFluxSTT(this.env.AI);
  private writes: Promise<unknown> = Promise.resolve();
  private windowStart = 0;
  private windowBytes = 0;
  private windowFrames = 0;
  private lastTurn = 0;
  tts: TTSProvider = { synthesize: async (text,signal) => {
    try {
      const response = await this.env.AI.run(VOICE_MODELS.tts,{
        text,speaker:this.state!.config.voice,encoding:'linear16',container:'none',sample_rate:16000,
      },{returnRawResponse:true,signal}) as Response;
      if (!response.ok) throw new Error('tts_failed');
      return await response.arrayBuffer();
    } catch (error) {
      if (!signal?.aborted) await this.finish(true);
      throw error;
    }
  }};

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx,env);
    // Filter before the mixin or Agent sees messages: disable SDK state mutation,
    // RPC and arbitrary custom traffic, and bound both audio and text input.
    const voiceMessage = this.onMessage.bind(this);
    this.onMessage = async (connection,message) => {
      const accepted = (connection.state as SocketState | null)?.accepted;
      if (!accepted || !this.state || this.state.closed) { connection.close(1008,'Call unavailable'); return; }
      if (Date.now()-Date.parse(this.state.startedAt) >= MAX_CALL_MS) { await this.finish(); return; }
      const bytes = typeof message === 'string' ? new TextEncoder().encode(message).byteLength : message.byteLength;
      if (Date.now()-this.windowStart >= 1000) { this.windowStart=Date.now(); this.windowBytes=0; this.windowFrames=0; }
      this.windowBytes += bytes;
      if (++this.windowFrames>120 || this.windowBytes>128_000 || bytes>32_768) { await this.finish(true); return; }
      if (typeof message !== 'string') {
        if (this.state.channel === 'text' || !(connection.state as SocketState).started) { await this.finish(true); return; }
        return voiceMessage(connection,message);
      }
      let input: {type?:unknown;text?:unknown};
      try { input = JSON.parse(message); } catch { await this.finish(true); return; }
      if (!input || typeof input !== 'object') { await this.finish(true); return; }
      if (input.type === 'end_call') { await this.finish(); return; }
      if (input.type === 'start_call') {
        if (this.state.channel === 'text' || (connection.state as SocketState).started) { await this.finish(true); return; }
        connection.setState({accepted:true,started:true});
      } else if (input.type === 'text_message') {
        if (typeof input.text !== 'string' || input.text.trim().length<1 || input.text.length>4000) { await this.finish(true); return; }
      } else if (!['interrupt','end_of_speech','playback_complete'].includes(String(input.type))) {
        await this.finish(true); return;
      }
      return voiceMessage(connection,message);
    };
  }
  async onRequest(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/initialize' && request.method === 'POST') {
      const {callId} = await request.json() as {callId:string};
      const call = await readCall(this.env,callId);
      if (!call || call.status !== 'active' || (this.state && this.state.callId!==call.id)) return new Response(null,{status:409});
      if (!this.state) {
        this.setState({callId:call.id,userId:call.user_id,channel:call.channel,startedAt:call.started_at,
          config:JSON.parse(call.config_json),closed:false,failed:false,turns:0});
        await this.schedule(new Date(Date.parse(call.started_at)+MAX_CALL_MS),'expireCall');
      }
      return new Response(null,{status:204});
    }
    if (path === '/end' && request.method === 'POST') { await this.finish(); return new Response(null,{status:204}); }
    return new Response(null,{status:404});
  }
  async onConnect(connection: Connection, _context: ConnectionContext) {
    if (!this.state || this.state.closed) { connection.close(1008,'Call ended'); return; }
    const claimed = await this.env.DB.prepare(`UPDATE voice_calls SET connected_at=? WHERE id=? AND status='active' AND connected_at IS NULL`)
      .bind(new Date().toISOString(),this.state.callId).run();
    if (!claimed.meta.changes) { connection.close(1008,'Call already connected'); return; }
    connection.setState({accepted:true,started:false});
    if (this.state.channel === 'text') {
      this.saveMessage('assistant',this.state.config.greeting);
      await this.flush();
      connection.send(JSON.stringify({type:'transcript',role:'assistant',text:this.state.config.greeting}));
    }
  }
  beforeCallStart(_connection: Connection): boolean {
    return Boolean(this.state && !this.state.closed && this.state.channel!=='text');
  }
  async onCallStart(connection: Connection) {
    if (!this.state || this.state.closed) return;
    await this.speak(connection,this.state.config.greeting);
  }
  async onCallEnd(connection: Connection) {
    if ((connection.state as SocketState | null)?.accepted) await this.finish();
  }
  async onClose(connection: Connection) {
    if ((connection.state as SocketState | null)?.accepted) await this.finish();
  }
  async onTurn(transcript: string, context: VoiceTurnContext): Promise<string> {
    if (!this.state || this.state.closed || this.state.turns>=MAX_TURNS || transcript.length>4000 || Date.now()-this.lastTurn<750) {
      await this.finish(); throw new Error('Call limit reached');
    }
    this.lastTurn=Date.now();
    this.setState({...this.state,turns:this.state.turns+1});
    await this.flush();
    try {
      const response = await this.env.AI.run(VOICE_MODELS.llm,{
        messages:receptionistMessages(this.state!.config,context.messages,transcript),max_tokens:256,temperature:0.4,
      },{signal:context.signal}) as {response?:string};
      if (context.signal.aborted) throw new Error('Turn interrupted');
      if (!response.response?.trim()) throw new Error('No response generated');
      return response.response.trim().slice(0,4000);
    } catch (error) {
      if (!context.signal.aborted) {
        context.connection.send(JSON.stringify({type:'error',message:'The receptionist is unavailable. Please try again.'}));
        await this.finish(true);
      }
      throw error;
    }
  }
  saveMessage(role: 'user'|'assistant',text: string): void {
    super.saveMessage(role,text);
    const transcript = JSON.stringify(this.getConversationHistory(MAX_TURNS*2+1).map(message=>({role:message.role,text:message.content})));
    const callId = this.state?.callId;
    if (!callId) return;
    this.writes = this.writes.catch(()=>{}).then(()=>this.env.DB.prepare('UPDATE voice_calls SET transcript_json=? WHERE id=?').bind(transcript,callId).run());
    this.ctx.waitUntil(this.writes.catch(()=>{ console.error('voice_transcript_persistence_failed'); }));
  }
  private async flush() { await this.writes; }
  async expireCall() { await this.finish(); }
  private async finish(failed=false): Promise<void> {
    if (!this.state) return;
    if (this.state.closed) { await this.flush(); return; }
    this.setState({...this.state,closed:true,failed:this.state.failed || failed});
    for (const connection of this.getConnections()) {
      this.forceEndCall(connection);
      connection.close(1000,'Call ended');
    }
    await this.flush();
    await this.env.DB.prepare(`UPDATE voice_calls SET status=?,ended_at=COALESCE(ended_at,?) WHERE id=? AND status='active'`)
      .bind(this.state.failed?'failed':'completed',new Date().toISOString(),this.state.callId).run();
  }
}
