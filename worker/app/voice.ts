import { authCorsHeaders, authJson, currentUser } from './auth-core';
import { callStub, createCall, expireCalls, initializeCall, publicAgent, publicCall, publicVoiceOrigin, readAgent, readCall, telephonyConfigured, VOICE_MODELS, voiceAgentInput, voiceEnabled, type VoiceAgentRow, type VoiceCallRow } from '../lib/voice';
import { handleTwilioRequest } from './voice-twilio';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
async function body(request: Request) {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) return null;
  if (Number(request.headers.get('Content-Length') || 0) > 16_384) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > 16_384) return null;
  try { return JSON.parse(text); } catch { return null; }
}
export async function handleVoiceRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/voice/twilio/')) return handleTwilioRequest(request,env);
  const cors = authCorsHeaders(request);
  if (cors === null) return authJson({error:'origin_not_allowed'},403,{});
  if (request.method === 'OPTIONS') return new Response(null,{status:204,headers:cors});
  if (!['GET','POST','PUT'].includes(request.method)) return authJson({error:'method_not_allowed'},405,cors);
  if ((request.method !== 'GET' || url.pathname.endsWith('/connect')) && !request.headers.get('Origin')) return authJson({error:'origin_required'},403,cors);
  if (url.search) return authJson({error:'invalid_request'},400,cors);
  try {
    const user = await currentUser(env,request);
    if (!user) return authJson({error:'not_authenticated'},401,cors);
    if (url.pathname === '/voice/config' && request.method === 'GET') {
      const agent = await readAgent(env,user.id);
      return authJson({enabled:voiceEnabled(env),browserCalling:voiceEnabled(env),
        telephony:{configured:telephonyConfigured(env,agent?.id || null),
          webhookUrl:agent && publicVoiceOrigin(env) ? `${publicVoiceOrigin(env)}/voice/twilio/incoming/${agent.id}` : null,
          phoneNumber:telephonyConfigured(env,agent?.id || null) ? env.TWILIO_PHONE_NUMBER : null},models:VOICE_MODELS},200,cors);
    }
    if (url.pathname === '/voice/agent') {
      if (request.method === 'GET') {
        const agent = await readAgent(env,user.id);
        return authJson({agent:agent ? publicAgent(agent) : null},200,cors);
      }
      if (request.method !== 'PUT') return authJson({error:'method_not_allowed'},405,cors);
      const parsed = voiceAgentInput.safeParse(await body(request));
      if (!parsed.success) return authJson({error:'invalid_request'},400,cors);
      const input = parsed.data;
      await env.DB.prepare(`INSERT INTO voice_agents(id,user_id,name,business_name,greeting,instructions,voice,updated_at)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET name=excluded.name,business_name=excluded.business_name,
        greeting=excluded.greeting,instructions=excluded.instructions,voice=excluded.voice,updated_at=excluded.updated_at`)
        .bind(crypto.randomUUID(),user.id,input.name,input.businessName,input.greeting,input.instructions,input.voice,new Date().toISOString()).run();
      return authJson({agent:publicAgent((await readAgent(env,user.id))!)},200,cors);
    }
    if (url.pathname === '/voice/calls') {
      await expireCalls(env,user.id);
      if (request.method === 'GET') {
        const {results} = await env.DB.prepare('SELECT * FROM voice_calls WHERE user_id=? ORDER BY started_at DESC, id DESC LIMIT 50').bind(user.id).all<VoiceCallRow>();
        return authJson({calls:results.map(publicCall)},200,cors);
      }
      if (request.method !== 'POST') return authJson({error:'method_not_allowed'},405,cors);
      if (!voiceEnabled(env)) return authJson({error:'voice_unavailable'},503,cors);
      const input = await body(request);
      if (!input || Object.keys(input).length !== 1 || !['browser','text'].includes(input.channel)) return authJson({error:'invalid_request'},400,cors);
      const agent = await readAgent(env,user.id);
      if (!agent) return authJson({error:'agent_required'},409,cors);
      const call = await createCall(env,user.id,publicAgent(agent),input.channel);
      if (!call) return authJson({error:'voice_call_limit'},429,cors);
      try { await initializeCall(env,call); }
      catch {
        await env.DB.prepare("UPDATE voice_calls SET status='failed', ended_at=? WHERE id=?").bind(new Date().toISOString(),call.id).run();
        return authJson({error:'voice_unavailable'},503,cors);
      }
      const websocketUrl = new URL(`/voice/calls/${call.id}/connect`,url.origin);
      websocketUrl.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return authJson({call:publicCall(call),websocketUrl:websocketUrl.toString()},201,cors);
    }
    const match = url.pathname.match(/^\/voice\/calls\/([^/]+)(?:\/(connect|end))?$/);
    if (!match || !uuid.test(match[1])) return authJson({error:'not_found'},404,cors);
    await expireCalls(env,user.id);
    const call = await readCall(env,match[1]);
    if (!call || call.user_id !== user.id) return authJson({error:'not_found'},404,cors);
    if (!match[2] && request.method === 'GET') return authJson({call:publicCall(call)},200,cors);
    if (match[2] === 'end' && request.method === 'POST') {
      if (call.status === 'active') {
        const response = await callStub(env,call.id).fetch(new Request('https://voice.internal/end',{method:'POST'}));
        if (!response.ok) return authJson({error:'voice_unavailable'},503,cors);
      }
      return authJson({call:publicCall((await readCall(env,call.id))!)},200,cors);
    }
    if (match[2] === 'connect' && request.method === 'GET') {
      if (call.channel === 'phone') return authJson({error:'not_found'},404,cors);
      if (!voiceEnabled(env)) return authJson({error:'voice_unavailable'},503,cors);
      if (call.status !== 'active') return authJson({error:'call_ended'},409,cors);
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return authJson({error:'websocket_required'},426,cors);
      return callStub(env,call.id).fetch(new Request('https://voice.internal/connect',{headers:{Upgrade:'websocket'}}));
    }
    return authJson({error:'method_not_allowed'},405,cors);
  } catch {
    console.error('voice_unavailable');
    return authJson({error:'voice_unavailable'},503,cors);
  }
}
