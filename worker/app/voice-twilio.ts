import { callStub, createCall, hashMediaToken, initializeCall, MAX_CALL_MS, publicAgent, publicVoiceOrigin, readCall, telephonyConfigured, twilioSipUri, type VoiceAgentRow } from '../lib/voice';
import { pcmToTwilio, streamTwiml, twilioToPCM, validTwilioSignature } from '../lib/voice-telephony';

const xml = (body: string,status=200) => new Response(body,{status,headers:{'content-type':'application/xml; charset=utf-8','cache-control':'no-store'}});
const unavailable = () => xml('<Response><Say>Sorry, our receptionist is unavailable. Please call again later.</Say><Hangup /></Response>');
export async function handleTwilioRequest(request: Request,env: Env,ctx?: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const origin = publicVoiceOrigin(env);
  if (!origin || !env.TWILIO_AUTH_TOKEN || !telephonyConfigured(env,env.TWILIO_AGENT_ID || null)) return new Response(null,{status:503});
  const incoming = url.pathname.match(/^\/voice\/twilio\/incoming\/([a-f0-9-]{36})$/i);
  const media = url.pathname.match(/^\/voice\/twilio\/media\/([a-f0-9-]{36})$/i);
  if (url.search || (!incoming && !media)) return new Response(null,{status:404});
  const expectedUrl = `${origin}${url.pathname}`;
  try {
    if (incoming) {
      if (request.method !== 'POST') return new Response(null,{status:405});
      if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/x-www-form-urlencoded') || Number(request.headers.get('Content-Length')||0)>32_768) return new Response(null,{status:400});
      const text = await request.text();
      if (new TextEncoder().encode(text).length>32_768) return new Response(null,{status:400});
      const fields=new URLSearchParams(text);
      if (!validTwilioSignature(env.TWILIO_AUTH_TOKEN,request.headers.get('X-Twilio-Signature'),expectedUrl,fields)) return new Response(null,{status:403});
      const callSid=fields.get('CallSid');
      const to=fields.get('To');
      const transport=to?.toLowerCase().startsWith('sip:') ? 'sip' : 'pstn';
      const sipTo=twilioSipUri(to);
      const destinationMatches=transport === 'sip' ? Boolean(sipTo && sipTo===twilioSipUri(env.TWILIO_SIP_URI)) : to===env.TWILIO_PHONE_NUMBER;
      if (fields.get('AccountSid')!==env.TWILIO_ACCOUNT_SID || !destinationMatches || incoming[1]!==env.TWILIO_AGENT_ID || !/^CA[a-f0-9]{32}$/i.test(callSid || '')) return new Response(null,{status:403});
      if (!telephonyConfigured(env,incoming[1],transport)) return new Response(null,{status:503});
      const agent=await env.DB.prepare('SELECT * FROM voice_agents WHERE id=?').bind(incoming[1]).first<VoiceAgentRow>();
      if (!agent) return unavailable();
      const existing=await env.DB.prepare('SELECT id FROM voice_calls WHERE provider_call_id=?').bind(callSid).first();
      // A signed webhook replay cannot allocate another paid model session.
      if (existing) return xml('<Response><Hangup /></Response>');
      const token=crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
      const call=await createCall(env,agent.user_id,publicAgent(agent),'phone',callSid,await hashMediaToken(token),transport);
      if (!call) return unavailable();
      try { await initializeCall(env,call); }
      catch {
        await env.DB.prepare("UPDATE voice_calls SET status='failed',ended_at=? WHERE id=?").bind(new Date().toISOString(),call.id).run();
        return unavailable();
      }
      return xml(streamTwiml(`${origin.replace('https:','wss:')}/voice/twilio/media/${call.id}`,token));
    }
    if (request.method !== 'GET') return new Response(null,{status:405});
    if (request.headers.get('Upgrade')?.toLowerCase()!=='websocket') return new Response(null,{status:426});
    const signature=request.headers.get('X-Twilio-Signature');
    // Twilio uses the WSS address for some handshake signatures. Its SDK also
    // normalizes ports; accept exactly these equivalent URLs, including its
    // documented trailing-slash variant, never arbitrary forwarded URLs.
    if (![expectedUrl,expectedUrl+'/',expectedUrl.replace('https:','wss:'),expectedUrl.replace('https:','wss:')+'/']
      .some(value=>validTwilioSignature(env.TWILIO_AUTH_TOKEN!,signature,value))) return new Response(null,{status:403});
    const call=await readCall(env,media![1]);
    if (!call || call.channel!=='phone' || (call.phone_provider && call.phone_provider!=='twilio') || call.status!=='active' || call.connected_at || !call.media_token_hash || call.agent_id!==env.TWILIO_AGENT_ID) return new Response(null,{status:404});
    return bridgeTwilio(env,call.id,call.provider_call_id!,ctx);
  } catch {
    console.error('voice_telephony_unavailable');
    return incoming ? unavailable() : new Response(null,{status:503});
  }
}

function bridgeTwilio(env: Env,callId: string,providerCallId: string,ctx?: ExecutionContext): Response {
  const pair=new WebSocketPair();
  const client=pair[0],socket=pair[1];
  socket.accept();
  const background = (task: Promise<unknown>) => {
    const handled=task.catch(()=>{ console.error('voice_telephony_cleanup_failed'); });
    if (ctx) ctx.waitUntil(handled);
  };
  let upstream: WebSocket | null=null;
  let streamSid: string | null=null;
  let ended=false;
  let windowAt=Date.now(),frames=0,bytes=0;
  const finish = async (failed=false) => {
    if (ended) return;
    ended=true;
    clearTimeout(startTimer);clearTimeout(endTimer);
    upstream?.close(1000,'Call ended');socket.close(1000,'Call ended');
    if (failed) await env.DB.prepare("UPDATE voice_calls SET status='failed',ended_at=? WHERE id=? AND status='active'")
      .bind(new Date().toISOString(),callId).run();
    await callStub(env,callId).fetch(new Request('https://voice.internal/end',{method:'POST'}));
  };
  const startTimer=setTimeout(()=>{ background(finish(true)); },5000);
  const endTimer=setTimeout(()=>{ background(finish()); },MAX_CALL_MS);
  let pending=Promise.resolve();
  socket.addEventListener('message',event=>{
    pending=pending.then(async()=>{
      if (ended) return;
      if (typeof event.data!=='string' || event.data.length>16_384) throw new Error('invalid_frame');
      if (Date.now()-windowAt>=1000) { windowAt=Date.now();frames=0;bytes=0; }
      bytes+=event.data.length;
      if (++frames>120 || bytes>64_000) throw new Error('media_rate_exceeded');
      const message=JSON.parse(event.data);
      if (message.event==='connected') return;
      if (message.event==='start') {
        if (upstream || streamSid || message.start?.callSid!==providerCallId || message.start?.accountSid!==env.TWILIO_ACCOUNT_SID ||
          message.start?.mediaFormat?.encoding!=='audio/x-mulaw' || message.start?.mediaFormat?.sampleRate!==8000 || message.start?.mediaFormat?.channels!==1 ||
          typeof message.start?.customParameters?.token!=='string' || message.start.customParameters.token.length!==64 || !/^MZ[a-f0-9]{32}$/i.test(message.start?.streamSid || '')) throw new Error('invalid_start');
        const tokenHash=await hashMediaToken(message.start.customParameters.token);
        const claimed=await env.DB.prepare(`UPDATE voice_calls SET media_token_hash=NULL WHERE id=? AND status='active' AND media_token_hash=? AND media_token_expires_at>? AND connected_at IS NULL`)
          .bind(callId,tokenHash,new Date().toISOString()).run();
        if (!claimed.meta.changes) throw new Error('media_token_invalid');
        streamSid=message.start.streamSid;
        const response=await callStub(env,callId).fetch(new Request('https://voice.internal/connect',{headers:{Upgrade:'websocket'}}));
        if (!response.webSocket) throw new Error('agent_connection_failed');
        if (ended) { response.webSocket.accept();response.webSocket.close(1000,'Call ended');return; }
        upstream=response.webSocket;upstream.binaryType='arraybuffer';upstream.accept();clearTimeout(startTimer);
        upstream.addEventListener('message',event=>{
          if (ended) return;
          try {
            if (typeof event.data==='string') {
              const message=JSON.parse(event.data);
              if (message.type==='playback_interrupt') socket.send(JSON.stringify({event:'clear',streamSid}));
              if (message.type==='error') background(finish(true));
            } else {
              for (const payload of pcmToTwilio(event.data)) socket.send(JSON.stringify({event:'media',streamSid,media:{payload}}));
            }
          } catch { background(finish(true)); }
        });
        upstream.addEventListener('close',()=>{ background(finish()); });
        upstream.addEventListener('error',()=>{ background(finish(true)); });
        upstream.send(JSON.stringify({type:'start_call'}));
        return;
      }
      if (!upstream || !streamSid) throw new Error('start_required');
      if (message.streamSid!==streamSid) throw new Error('invalid_stream');
      if (message.event==='media') {
        if (message.media?.track!=='inbound' || typeof message.media?.payload!=='string') throw new Error('invalid_media');
        upstream.send(twilioToPCM(message.media.payload));
      } else if (message.event==='stop') await finish();
      else if (message.event!=='mark') throw new Error('invalid_event');
    }).catch(()=>finish(true)).catch(()=>{ console.error('voice_telephony_cleanup_failed'); });
    if (ctx) ctx.waitUntil(pending);
  });
  socket.addEventListener('close',()=>{ background(finish()); });
  socket.addEventListener('error',()=>{ background(finish(true)); });
  return new Response(null,{status:101,webSocket:client});
}
