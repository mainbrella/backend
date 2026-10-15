import { callStub, createCall, hashMediaToken, initializeCall, MAX_CALL_MS, publicAgent, publicVoiceOrigin, readCall, type VoiceAgentRow } from '../lib/voice';
import { twilioToPCM } from '../lib/voice-telephony';

import { pcmToTelnyx, telnyxCallIdMatches, telnyxConfigured, telnyxSipUri, validTelnyxCallId, validTelnyxSignature, streamTexml } from '../lib/voice-telnyx';

const xml = (body: string,status=200) => new Response(body,{status,headers:{'content-type':'application/xml; charset=utf-8','cache-control':'no-store'}});
const unavailable = () => xml('<Response><Say>Sorry, our receptionist is unavailable. Please call again later.</Say><Hangup /></Response>');
export async function handleTelnyxRequest(request: Request,env: Env,ctx?: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const origin = publicVoiceOrigin(env);
  if (!origin || !env.TELNYX_PUBLIC_KEY) {
    console.warn('voice_telnyx_configuration_incomplete');
    return new Response(null,{status:503});
  }
  const incoming = url.pathname.match(/^\/voice\/telnyx\/incoming\/([a-f0-9-]{36})$/i);
  const media = url.pathname.match(/^\/voice\/telnyx\/media\/([a-f0-9-]{36})$/i);
  if (url.search || (!incoming && !media)) return new Response(null,{status:404});
  const expectedUrl = `${origin}${url.pathname}`;
  try {
    if (incoming) {
      if (request.method !== 'POST') return new Response(null,{status:405});
      if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/x-www-form-urlencoded') || Number(request.headers.get('Content-Length')||0)>32_768) return new Response(null,{status:400});
      const text = await request.text();
      if (new TextEncoder().encode(text).length>32_768) return new Response(null,{status:400});
      const fields=new URLSearchParams(text);
      if (!await validTelnyxSignature(env.TELNYX_PUBLIC_KEY,request.headers,text)) {
        console.warn('voice_telnyx_webhook_signature_invalid');
        return new Response(null,{status:403});
      }
      const callSid=fields.get('CallSid');
      const accountSid=fields.get('AccountSid');
      const to=fields.get('To');
      // ToSipUri is supplied without a sip: prefix by TeXML. PSTN calls
      // use number@sip.telnyx.com; application SIP calls use a subdomain.
      const sipTo=telnyxSipUri(fields.get('ToSipUri') || to);
      const transport=sipTo || to?.toLowerCase().startsWith('sip:') ? 'sip' : 'pstn';
      const destinationMatches=transport === 'sip' ? Boolean(sipTo && sipTo===telnyxSipUri(env.TELNYX_SIP_URI)) : to===env.TELNYX_PHONE_NUMBER;
      if (fields.get('ConnectionId')!==env.TELNYX_CONNECTION_ID ||
        !destinationMatches || incoming[1]!==env.TELNYX_AGENT_ID || !validTelnyxCallId(callSid)) {
        console.warn('voice_telnyx_webhook_identity_mismatch');
        return new Response(null,{status:403});
      }
      if (!env.TELNYX_ACCOUNT_SID) {
        // Bootstrap diagnostics only: the signature, application, destination
        // and agent must match before logging the account identity. Never
        // allocate a call or infer account configuration from this request.
        if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(accountSid || '')) {
          console.warn('voice_telnyx_account_sid_required',JSON.stringify({AccountSid:accountSid,ConnectionId:fields.get('ConnectionId')}));
        } else console.warn('voice_telnyx_account_sid_missing_or_invalid');
        return new Response(null,{status:503});
      }
      if (accountSid!==env.TELNYX_ACCOUNT_SID) {
        console.warn('voice_telnyx_webhook_account_mismatch');
        return new Response(null,{status:403});
      }
      if (!telnyxConfigured(env,incoming[1],transport)) {
        console.warn('voice_telnyx_configuration_incomplete');
        return new Response(null,{status:503});
      }
      const agent=await env.DB.prepare('SELECT * FROM voice_agents WHERE id=?').bind(incoming[1]).first<VoiceAgentRow>();
      if (!agent) return unavailable();
      const existing=await env.DB.prepare('SELECT id FROM voice_calls WHERE provider_call_id=?').bind(callSid).first();
      // A signed webhook replay cannot allocate another paid model session.
      if (existing) return xml('<Response><Hangup /></Response>');
      const token=crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
      const call=await createCall(env,agent.user_id,publicAgent(agent),'phone',callSid,await hashMediaToken(token),transport,'telnyx');
      if (!call) return unavailable();
      try { await initializeCall(env,call); }
      catch {
        await env.DB.prepare("UPDATE voice_calls SET status='failed',ended_at=? WHERE id=?").bind(new Date().toISOString(),call.id).run();
        return unavailable();
      }
      return xml(streamTexml(`${origin.replace('https:','wss:')}/voice/telnyx/media/${call.id}`,token));
    }
    if (!telnyxConfigured(env,env.TELNYX_AGENT_ID || null)) return new Response(null,{status:503});
    if (request.method !== 'GET') return new Response(null,{status:405});
    if (request.headers.get('Upgrade')?.toLowerCase()!=='websocket') return new Response(null,{status:426});
    if (!await validTelnyxSignature(env.TELNYX_PUBLIC_KEY,request.headers,expectedUrl.replace('https:','wss:'))) return new Response(null,{status:403});
    const call=await readCall(env,media![1]);
    if (!call || call.channel!=='phone' || call.phone_provider!=='telnyx' || call.status!=='active' || call.connected_at || !call.media_token_hash || call.agent_id!==env.TELNYX_AGENT_ID) return new Response(null,{status:404});
    return bridgeTelnyx(env,call.id,call.provider_call_id!,ctx);
  } catch {
    console.error('voice_telephony_unavailable');
    return incoming ? unavailable() : new Response(null,{status:503});
  }
}

function bridgeTelnyx(env: Env,callId: string,providerCallId: string,ctx?: ExecutionContext): Response {
  const pair=new WebSocketPair();
  const client=pair[0],socket=pair[1];
  socket.accept();
  const background = (task: Promise<unknown>) => {
    const handled=task.catch(()=>{ console.error('voice_telephony_cleanup_failed'); });
    if (ctx) ctx.waitUntil(handled);
  };
  let upstream: WebSocket | null=null;
  let streamId: string | null=null;
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
        const parameters=message.start?.custom_parameters || message.start?.customParameters;
        const token=Array.isArray(parameters) ? parameters.find((entry: {name?:string})=>entry?.name==='token')?.value : parameters?.token;
        if (upstream || streamId || !telnyxCallIdMatches(providerCallId,message.start?.call_control_id || null) ||
          message.start?.user_id?.toLowerCase()!==env.TELNYX_ACCOUNT_SID?.toLowerCase() ||
          message.start?.media_format?.encoding!=='PCMU' || message.start?.media_format?.sample_rate!==8000 || message.start?.media_format?.channels!==1 ||
          typeof token!=='string' || !/^[a-f0-9]{64}$/.test(token) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(message.stream_id || '')) throw new Error('invalid_start');
        const tokenHash=await hashMediaToken(token);
        const claimed=await env.DB.prepare(`UPDATE voice_calls SET media_token_hash=NULL WHERE id=? AND status='active' AND media_token_hash=? AND media_token_expires_at>? AND connected_at IS NULL`)
          .bind(callId,tokenHash,new Date().toISOString()).run();
        if (!claimed.meta.changes) throw new Error('media_token_invalid');
        streamId=message.stream_id;
        const response=await callStub(env,callId).fetch(new Request('https://voice.internal/connect',{headers:{Upgrade:'websocket'}}));
        if (!response.webSocket) throw new Error('agent_connection_failed');
        if (ended) { response.webSocket.accept();response.webSocket.close(1000,'Call ended');return; }
        upstream=response.webSocket;upstream.binaryType='arraybuffer';upstream.accept();clearTimeout(startTimer);
        upstream.addEventListener('message',event=>{
          if (ended) return;
          try {
            if (typeof event.data==='string') {
              const message=JSON.parse(event.data);
              if (message.type==='playback_interrupt') socket.send(JSON.stringify({event:'clear'}));
              if (message.type==='error') background(finish(true));
            } else {
              for (const payload of pcmToTelnyx(event.data)) socket.send(JSON.stringify({event:'media',media:{payload}}));
            }
          } catch { background(finish(true)); }
        });
        upstream.addEventListener('close',()=>{ background(finish()); });
        upstream.addEventListener('error',()=>{ background(finish(true)); });
        upstream.send(JSON.stringify({type:'start_call'}));
        return;
      }
      if (!upstream || !streamId) throw new Error('start_required');
      if (message.stream_id!==streamId) throw new Error('invalid_stream');
      if (message.event==='media') {
        if (message.media?.track!=='inbound' || typeof message.media?.payload!=='string') throw new Error('invalid_media');
        upstream.send(twilioToPCM(message.media.payload));
      } else if (message.event==='stop') await finish();
      else if (message.event!=='mark' && message.event!=='dtmf') throw new Error('invalid_event');
    }).catch(()=>finish(true)).catch(()=>{ console.error('voice_telephony_cleanup_failed'); });
    if (ctx) ctx.waitUntil(pending);
  });
  socket.addEventListener('close',()=>{ background(finish()); });
  socket.addEventListener('error',()=>{ background(finish(true)); });
  return new Response(null,{status:101,webSocket:client});
}
