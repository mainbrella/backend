import { hangupTwilioCall } from '../lib/voice-telephony';
import { hangupTelnyxCall } from '../lib/voice-telnyx';
import { Agent, type Connection, type ConnectionContext } from 'agents';
import { withVoice, WorkersAIFluxSTT, type TTSProvider, type VoiceTurnContext } from '@cloudflare/voice';
import { billingError, checkVoiceBalance, llmCost, llmReservation, meteredVoiceInference, phoneRate, reportVoiceUsage, reserveVoiceUsage, stopUserCalls, STT_WINDOW_MS, sttCost, ttsCost } from '../lib/voice-billing';
import { MAX_CALL_MS, MAX_TURNS, readCall, receptionistMessages, VOICE_MODELS, type VoiceAgentConfig, type VoiceCallRow } from '../lib/voice';

const VoiceAgent = withVoice(Agent,{audioFormat:'pcm16',sampleRate:16000,historyLimit:20,maxMessageCount:MAX_TURNS*2+1});
const IMMEDIATE_REPLIES = ['One second please.', 'Got it, just a sec.', 'I see, let me think.'];
interface CallState {
  callId: string; userId: string; channel: VoiceCallRow['channel']; startedAt: string;
  config: VoiceAgentConfig; closed: boolean; failed: boolean; turns: number;
  stt?: {id:string;bytes:number}; phone?: {id:string;rate:number}; phoneProvider?: VoiceCallRow['phone_provider']; providerCallId?: string | null; phoneEnded?: boolean; endedAt?: string; pendingAccountStop?: string; phoneUsage?: {durationSeconds:number;billableMinutes:number};
}
interface SocketState { accepted: boolean; started: boolean; ready?: boolean }

/** One durable Agent and one conversation history for each call, never an account-wide Agent. */
export class ReceptionistCall extends VoiceAgent<Cloudflare.Env & Env,CallState | null> {
  static options = { sendIdentityOnConnect: false };
  initialState: CallState | null = null;
  transcriber = new WorkersAIFluxSTT(this.env.AI);
  private writes: Promise<unknown> = Promise.resolve();
  private finalization: Promise<void> | null = null;
  private windowStart = 0;
  private windowBytes = 0;
  private windowFrames = 0;
  private lastTurn = 0;
  private activeInference = 0;
  private immediateReplyAudio: ArrayBuffer[] = [];
  private audioWrites: Promise<void> = Promise.resolve();
  private sttReservation: Promise<void> | null = null;
  private billingTimer: ReturnType<typeof setTimeout> | null = null;
  private owner() {
    if (!this.state) throw new Error('call_ended');
    return {id:this.state.callId,user_id:this.state.userId,agent_id:this.state.config.id,channel:this.state.channel};
  }
  private async billingFailure(error: unknown) {
    if (!this.state) return;
    const code=billingError(error);
    const message=code==='insufficient_balance' ? 'Your credits have run out. Add funds to continue.' :
      code==='spend_limit_exceeded' ? 'Your spending limit has been reached.' : 'Voice billing is unavailable. The call has ended.';
    this.sendBillingError(message);
    this.setState({...this.state,pendingAccountStop:this.state.pendingAccountStop || new Date().toISOString()});
    // Do not await sibling calls: simultaneous failures must not deadlock.
    this.ctx.waitUntil(this.stopAccountCalls());
    await this.finish(true);
  }
  private sendBillingError(message:string) {
    for (const connection of this.getConnections()) {
      try { connection.send(JSON.stringify({type:'error',message})); } catch { /* Already disconnected. */ }
    }
  }
  async stopAccountCalls() {
    if (!this.state?.pendingAccountStop) return;
    // Persist the retry before fan-out, so interruption cannot leave siblings running.
    await this.schedule(5,'stopAccountCalls');
    try {
      await stopUserCalls(this.env,this.state.userId,this.state.callId,this.state.pendingAccountStop);
      this.setState({...this.state!,pendingAccountStop:undefined});
    } catch { console.error('voice_stop_failed'); }
  }
  private monitorBalance() {
    if (this.billingTimer || !this.state || this.state.closed) return;
    this.billingTimer=setTimeout(()=>{
      this.billingTimer=null;
      this.ctx.waitUntil(this.checkBilling().then(()=>this.monitorBalance()).catch(error=>this.billingFailure(error)));
    },5000);
  }
  async checkBilling() {
    if (!this.state || this.state.closed) return;
    await checkVoiceBalance(this.env,this.state.userId,this.state.callId);
  }
  private async reserveSTT() {
    if (!this.state || this.state.closed) throw new Error('call_ended');
    if (this.state.stt) return;
    if (this.sttReservation) return this.sttReservation;
    const reservation=Promise.resolve().then(async()=>{
      const id=await reserveVoiceUsage(this.env,this.owner(),VOICE_MODELS.stt,sttCost(STT_WINDOW_MS));
      if (!this.state || this.state.closed) { await reportVoiceUsage(this.env,id,0,{audioBytes:0}); throw new Error('call_ended'); }
      this.setState({...this.state,stt:{id,bytes:0}});
    });
    this.sttReservation=reservation;
    try { await reservation; }
    finally { if(this.sttReservation===reservation)this.sttReservation=null; }
  }
  private async settleSTT() {
    const stt=this.state?.stt;
    if (!stt) return;
    const audioMs=stt.bytes / 32; // mono PCM16, 16 kHz
    await reportVoiceUsage(this.env,stt.id,sttCost(audioMs),{audioBytes:stt.bytes,audioMs,sampleRate:16000});
    if (this.state?.stt?.id===stt.id) this.setState({...this.state,stt:undefined});
  }
  tts: TTSProvider = { synthesize: async (text,signal) => {
    this.activeInference++;
    try {
      await this.checkBilling();
      const response=await meteredVoiceInference(this.env,this.owner(),VOICE_MODELS.tts,ttsCost(text),async()=>{
        const response = await this.env.AI.run(VOICE_MODELS.tts,{
          text,speaker:this.state!.config.voice,encoding:'linear16',container:'none',sample_rate:16000,
        },{returnRawResponse:true,signal}) as Response;
        if (!response.ok) throw new Error('tts_failed');
        return {result:response,providerMicroUsd:ttsCost(text),usage:{characters:text.length}};
      },()=>Boolean(this.state && !this.state.closed && !signal?.aborted));
      return await response.arrayBuffer();
    } catch (error) {
      if (!signal?.aborted) await this.billingFailure(error);
      throw error;
    } finally { this.activeInference--; }
  }};

  private async prepareImmediateReply() {
    if (!this.state || this.state.closed || this.state.channel==='text' || this.state.config.voiceLogic!=='reply_right_away') return;
    this.activeInference++;
    try {
      // Prepare the rotation serially before speech capture, with this call's
      // frozen voice. Playback never needs another optional inference request.
      for (const text of IMMEDIATE_REPLIES) {
        if (this.state?.closed) return;
        const audio=await meteredVoiceInference(this.env,this.owner(),VOICE_MODELS.tts,ttsCost(text),async()=>{
          const response=await this.env.AI.run(VOICE_MODELS.tts,{
            text,speaker:this.state!.config.voice,encoding:'linear16',container:'none',sample_rate:16000,
          },{returnRawResponse:true}) as Response;
          if (!response.ok) throw new Error('tts_failed');
          const audio=await response.arrayBuffer();
          if (!audio.byteLength || audio.byteLength%2) throw new Error('tts_invalid_pcm');
          return {result:audio,providerMicroUsd:ttsCost(text),usage:{characters:text.length,purpose:'reply_right_away'}};
        },()=>Boolean(this.state && !this.state.closed));
        if (!this.state?.closed) this.immediateReplyAudio.push(audio);
      }
    } catch {
      // No retry or SDK error: Telnyx treats SDK errors as fatal. Reservations
      // with unknown provider usage remain held by the existing billing code.
      // Keep any clips already prepared; stop preparing more on failure.
      console.error('voice_immediate_reply_unavailable',{callId:this.state?.callId});
    } finally { this.activeInference--; }
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx,env as Cloudflare.Env & Env);
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
        const task=this.audioWrites.then(async()=>{
          if (!this.state || this.state.closed) return;
          if (message.byteLength % 2) throw new Error('invalid_audio');
          // Reserve another audio window before forwarding any bytes beyond it.
          if (this.state.stt && this.state.stt.bytes + message.byteLength > STT_WINDOW_MS*32) await this.settleSTT();
          await this.reserveSTT();
          if (this.state!.closed) return;
          this.setState({...this.state!,stt:{...this.state!.stt!,bytes:this.state!.stt!.bytes+message.byteLength}});
          return voiceMessage(connection,message);
        });
        this.audioWrites=task.catch(async error=>{ if (!this.state?.closed) await this.billingFailure(error); });
        return this.audioWrites;
      }
      let input: {type?:unknown;text?:unknown};
      try { input = JSON.parse(message); } catch { await this.finish(true); return; }
      if (!input || typeof input !== 'object') { await this.finish(true); return; }
      if (input.type === 'end_call') { await this.finish(); return; }
      if (input.type === 'start_call') {
        if (this.state.channel === 'text' || (connection.state as SocketState).started) { await this.finish(true); return; }
        connection.setState({accepted:true,started:true});
      } else if (input.type === 'text_message') {
        if (this.state.turns>=MAX_TURNS) { await this.finish(); return; }
        if (typeof input.text !== 'string' || input.text.trim().length<1 || input.text.length>4000) { await this.finish(true); return; }
      } else if (!['hello','interrupt','start_of_speech','end_of_speech'].includes(String(input.type))) {
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
          config:JSON.parse(call.config_json),providerCallId:call.provider_call_id,phoneProvider:call.phone_provider || 'twilio',closed:false,failed:false,turns:0});
        await this.schedule(new Date(Date.parse(call.started_at)+MAX_CALL_MS),'expireCall');
        try {
          await this.checkBilling();
          if (call.channel==='phone') {
            const transport=call.phone_transport || 'pstn';
            const provider=call.phone_provider || 'twilio';
            const rate=phoneRate(this.env,transport,provider);
            const id=await reserveVoiceUsage(this.env,this.owner(),`${provider}${transport === 'sip' ? '-sip' : ''}-inbound`,rate*15);
            this.setState({...this.state!,phone:{id,rate}});
          }
        } catch (error) { await this.billingFailure(error); return Response.json({error:billingError(error)},{status:402}); }
        this.monitorBalance();
      }
      return new Response(null,{status:204});
    }
    if (path === '/billing-stop' && request.method === 'POST') {
      this.sendBillingError('Calling stopped because account credits or billing are unavailable.');
      await this.finish(true); return new Response(null,{status:204});
    }
    if (path === '/end' && request.method === 'POST') { await this.finish(); return new Response(null,{status:204}); }
    return new Response(null,{status:404});
  }
  async onConnect(connection: Connection, _context: ConnectionContext) {
    if (!this.state || this.state.closed) { connection.close(1008,'Call ended'); return; }
    try { await this.checkBilling(); } catch (error) { await this.billingFailure(error); connection.close(1008,'Credits unavailable'); return; }
    this.monitorBalance();
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
  async beforeCallStart(_connection: Connection): Promise<boolean> {
    if (!this.state || this.state.closed || this.state.channel==='text') return false;
    try {
      await this.checkBilling();
      await this.reserveSTT();
      // Finish preparation before the greeting and caller turns can dispatch
      // TTS, so optional audio cannot compete with the real answer.
      await this.prepareImmediateReply();
      return !this.state.closed;
    }
    catch (error) { await this.billingFailure(error); return false; }
  }
  async onCallStart(connection: Connection) {
    if (!this.state || this.state.closed) return;
    connection.setState({...connection.state as SocketState,ready:true});
    await this.speak(connection,this.state.config.greeting);
  }
  async onCallEnd(connection: Connection) {
    if ((connection.state as SocketState | null)?.accepted) await this.finish(this.state?.channel!=='text' && !(connection.state as SocketState).ready);
  }
  async onClose(connection: Connection) {
    if ((connection.state as SocketState | null)?.accepted) await this.finish();
  }
  async afterTranscribe(transcript: string, _connection: Connection): Promise<string | null> {
    if (!this.state || this.state.closed || this.state.turns>=MAX_TURNS || transcript.length>4000) {
      await this.finish(); return null;
    }
    return transcript;
  }
  async onTurn(transcript: string, context: VoiceTurnContext): Promise<string> {
    // The immediate cue can prompt a quick spoken correction. Let the SDK
    // interrupt/replace that turn; retain the original flavor's timing guard.
    const replyRightAway=this.state?.config.voiceLogic==='reply_right_away' && this.state.channel!=='text';
    const rapidOriginalTurn=!replyRightAway && Date.now()-this.lastTurn<750;
    if (!this.state || this.state.closed || this.state.turns>=MAX_TURNS || transcript.length>4000 || rapidOriginalTurn) {
      await this.finish(); throw new Error('Call limit reached');
    }
    this.lastTurn=Date.now();
    this.setState({...this.state,turns:this.state.turns+1});
    if (replyRightAway && (context.connection.state as SocketState | null)?.started && this.immediateReplyAudio.length && !context.signal.aborted) {
      // Use the current turn's connection and interruption signal. speak()
      // would abort this turn; a text stream would split the real reply's TTS.
      // Skip a missing cue rather than making the answer wait for it.
      try {
        context.connection.send(JSON.stringify({type:'status',status:'speaking'}));
        context.connection.send(this.immediateReplyAudio[(this.state!.turns-1)%this.immediateReplyAudio.length]);
      } catch { /* The caller may have disconnected. */ }
    }
    await this.flush();
    this.activeInference++;
    try {
      await this.checkBilling();
      const messages=receptionistMessages(this.state!.config,context.messages,transcript);
      const text=await meteredVoiceInference(this.env,this.owner(),VOICE_MODELS.llm,llmReservation(messages),async()=>{
        const response = await this.env.AI.run(VOICE_MODELS.llm,{
          messages,max_tokens:256,temperature:0.4,
        },{signal:context.signal}) as {response?:string;usage?:unknown};
        const providerMicroUsd=llmCost(response.usage);
        return {result:response.response?.trim().slice(0,4000) || '',providerMicroUsd,usage:{tokens:response.usage}};
      },()=>Boolean(this.state && !this.state.closed && !context.signal.aborted));
      if (!text) throw new Error('No response generated');
      return text;
    } catch (error) {
      if (!context.signal.aborted) await this.billingFailure(error);
      throw new Error(context.signal.aborted ? 'Turn interrupted' : 'The receptionist is unavailable. Please try again.');
    } finally { this.activeInference--; }
  }
  saveMessage(role: 'user'|'assistant',text: string): void {
    super.saveMessage(role,text);
    const transcript = JSON.stringify(this.getConversationHistory(MAX_TURNS*2+1).map(message=>({role:message.role,text:message.content})));
    const callId = this.state?.callId;
    if (!callId) return;
    this.writes = this.writes.catch(()=>{}).then(()=>this.env.DB.prepare('UPDATE voice_calls SET transcript_json=? WHERE id=?').bind(transcript,callId).run());
    this.ctx.waitUntil(this.writes.catch(()=>{ console.error('voice_transcript_persistence_failed'); }));
  }
  private async flush(retryTranscript=false): Promise<void> {
    try { await this.writes; }
    catch (error) {
      if (!retryTranscript || !this.state) throw error;
      // SDK SQLite is authoritative until finalization succeeds. Rebuild the
      // entire snapshot rather than retaining a permanently rejected promise.
      const transcript=JSON.stringify(this.getConversationHistory(MAX_TURNS*2+1).map(message=>({role:message.role,text:message.content})));
      const callId=this.state.callId;
      this.writes=this.writes.catch(()=>{}).then(()=>this.env.DB.prepare('UPDATE voice_calls SET transcript_json=? WHERE id=?').bind(transcript,callId).run());
      await this.writes;
    }
  }
  protected async hangupPhone(callSid:string) {
    return this.state?.phoneProvider === 'telnyx' ? hangupTelnyxCall(this.env,callSid) : hangupTwilioCall(this.env,callSid);
  }
  async retryFinish() { await this.finish(); }
  async expireCall() { await this.finish(); }
  async purgeCall(): Promise<void> {
    if (!this.state?.closed) return;
    if (this.activeInference || this.sttReservation || this.state.pendingAccountStop) { await this.schedule(15,'purgeCall'); return; }
    await this.flush();
    // D1 owns call history. Remove SDK SQLite transcripts, business instructions,
    // attachments and alarms from this temporary per-call Durable Object.
    await this.destroy();
  }
  private async finish(failed=false): Promise<void> {
    if (!this.state) return;
    if (this.finalization) return this.finalization;
    // Assign before closing sockets: the SDK's end/close hooks can re-enter.
    // Durable closed state blocks input; it does not mean D1 was finalized.
    const finalization=Promise.resolve().then(async()=>{
      if (!this.state!.closed) {
        this.setState({...this.state!,closed:true,failed:this.state!.failed || failed,endedAt:new Date().toISOString()});
        if (this.billingTimer) { clearTimeout(this.billingTimer); this.billingTimer=null; }
        for (const connection of this.getConnections()) {
          try { this.forceEndCall(connection); } catch { /* A disconnected socket still needs cleanup. */ }
          try { connection.close(1000,'Call ended'); } catch { /* Already closed. */ }
        }
      }
      if (this.state!.providerCallId && !this.state!.phoneEnded) {
        const phoneUsage=await this.hangupPhone(this.state!.providerCallId);
        this.setState({...this.state!,phoneEnded:true,phoneUsage});
      }
      await this.settleSTT();
      if (this.state!.phone) {
        const phone=this.state!.phone;
        const minutes=this.state!.phoneUsage!.billableMinutes;
        await reportVoiceUsage(this.env,phone.id,phone.rate*minutes,{minutes,durationSeconds:this.state!.phoneUsage!.durationSeconds,rateMicroUsdPerMinute:phone.rate});
        this.setState({...this.state!,phone:undefined});
      }
      await this.flush(true);
      await this.env.DB.prepare(`UPDATE voice_calls SET status=?,ended_at=COALESCE(ended_at,?) WHERE id=? AND status='active'`)
        .bind(this.state!.failed?'failed':'completed',this.state!.endedAt!,this.state!.callId).run();
      await this.schedule(60,'purgeCall',undefined,{idempotent:true});
    });
    this.finalization=finalization;
    try { await finalization; }
    catch (error) {
      await this.schedule(5,'retryFinish');
      throw error;
    }
    finally { if (this.finalization===finalization) this.finalization=null; }
  }
}
