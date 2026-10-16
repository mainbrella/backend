import test from 'node:test';
import assert from 'node:assert/strict';
import { voiceAgentInput, receptionistMessages } from '../lib/voice';
import { VOICE_LANGUAGES, VOICE_SPEECH_MODELS, resolveVoiceModels, speechModelAvailable, speechOptions, speechRate } from '../lib/voice-options';
import { synthesizeVoiceSpeech } from '../lib/voice-speech';
import { sttCost, ttsCost, llmCost } from '../lib/voice-billing';

const input = { name:'Maya', businessName:'Workshop', greeting:'Hello', instructions:'Take a message.', voice:'asteria', transferNumber:null };
const bindings = {
  VOICE_AI_GATEWAY_ACCOUNT_ID:'a'.repeat(32), VOICE_AI_GATEWAY_ID:'voice', VOICE_AI_GATEWAY_TOKEN:'gateway-secret',
  DEEPGRAM_API_KEY:'deepgram-secret', DEEPGRAM_TTS_MICRO_USD_PER_CHARACTER:'30',
  CARTESIA_API_KEY:'cartesia-secret', CARTESIA_TTS_MICRO_USD_PER_CHARACTER:'65',
};
const pcm = () => new Response(new Int16Array(320).buffer,{headers:{'content-type':'audio/pcm'}});

test('speech catalog has 1/2/7/10 supported languages and rejects incompatible selections',()=>{
  assert.deepEqual(VOICE_SPEECH_MODELS.map(model=>model.languages.length),[1,2,7,10]);
  assert.equal(VOICE_LANGUAGES.length,10);
  assert.equal(voiceAgentInput.parse(input).model,'aura-1');
  assert.equal(voiceAgentInput.parse(input).language,'en');
  for(const model of VOICE_SPEECH_MODELS) for(const language of model.languages) for(const voice of language.voices) {
    assert.equal(voiceAgentInput.safeParse({...input,model:model.id,language:language.code,voice:voice.id}).success,true);
  }
  for(const selection of [
    {model:'aura-1',language:'fr',voice:'asteria'}, {model:'aura-2',language:'fr',voice:'agathe'},
    {model:'aura-2',language:'es',voice:'asteria'}, {model:'aura-2-gateway',language:'hi',voice:'agathe'},
    {model:'sonic-3.6',language:'fr',voice:'arbitrary-id'}, {model:'melotts',language:'fr',voice:'asteria'},
  ]) assert.equal(voiceAgentInput.safeParse({...input,...selection}).success,false);
});

test('external models require gateway configuration, provider credentials and an explicit valid price',()=>{
  const env=bindings as Env;
  assert.equal(speechModelAvailable({} as Env,'aura-2'),true);
  assert.equal(speechModelAvailable({} as Env,'sonic-3.6'),false);
  for(const key of ['VOICE_AI_GATEWAY_ACCOUNT_ID','VOICE_AI_GATEWAY_ID','CARTESIA_API_KEY','CARTESIA_TTS_MICRO_USD_PER_CHARACTER']) {
    assert.equal(speechModelAvailable({...env,[key]:undefined},'sonic-3.6'),false,key);
  }
  for(const rate of ['0','-1','NaN','1.5','1001']) assert.equal(speechModelAvailable({...env,CARTESIA_TTS_MICRO_USD_PER_CHARACTER:rate},'sonic-3.6'),false);
  assert.equal(speechModelAvailable({...env,VOICE_AI_GATEWAY_ID:'../other'},'sonic-3.6'),false);
  assert.equal(speechOptions(env).models.every(model=>model.available),true);
  assert.equal(JSON.stringify(speechOptions(env)).includes('secret'),false);
});

test('native Aura-2 Spanish uses its matching voice and raw PCM audio',async()=>{
  const env={AI:{run:async(model:string,params:any,options:any)=>{
    assert.equal(model,'@cf/deepgram/aura-2-es');
    assert.deepEqual(params,{text:'Hola',speaker:'celeste',encoding:'linear16',container:'none',sample_rate:16000});
    assert.equal(options.returnRawResponse,true);
    return pcm();
  }}} as unknown as Env;
  assert.equal((await synthesizeVoiceSpeech(env,{model:'aura-2',language:'es',voice:'celeste'},'Hola')).byteLength,640);
});

test('Deepgram gateway uses French Aura-2 and keeps credentials server-side',async()=>{
  const fetcher=(async(url:any,options:any)=>{
    const parsed=new URL(url);
    assert.equal(parsed.hostname,'gateway.ai.cloudflare.com');
    assert.equal(parsed.pathname,`/v1/${bindings.VOICE_AI_GATEWAY_ACCOUNT_ID}/voice/deepgram/v1/speak`);
    assert.equal(parsed.searchParams.get('model'),'aura-2-agathe-fr');
    assert.equal(parsed.searchParams.get('container'),'none');
    assert.equal(parsed.searchParams.get('sample_rate'),'16000');
    assert.equal(options.headers.authorization,'Token deepgram-secret');
    assert.equal(options.headers['cf-aig-authorization'],'Bearer gateway-secret');
    assert.equal(options.headers['cf-aig-skip-cache'],'true');
    return pcm();
  }) as typeof fetch;
  await synthesizeVoiceSpeech(bindings as Env,{model:'aura-2-gateway',language:'fr',voice:'agathe'},'Bonjour',undefined,fetcher);
});

test('Cartesia can dispatch raw PCM speech in each of the ten languages',async()=>{
  const model=VOICE_SPEECH_MODELS[3];
  for(const {code} of VOICE_LANGUAGES) {
    let requests=0;
    const fetcher=(async(url:any,options:any)=>{
      requests++;
      assert.equal(new URL(url).pathname,`/v1/${bindings.VOICE_AI_GATEWAY_ACCOUNT_ID}/voice/cartesia/tts/bytes`);
      const body=JSON.parse(options.body);
      assert.equal(body.language,code);
      assert.equal(body.model_id,'sonic-3.6-2026-08-27');
      assert.deepEqual(body.output_format,{container:'raw',encoding:'pcm_s16le',sample_rate:16000});
      assert.equal(options.headers['Cartesia-Version'],'2026-08-14');
      assert.equal(options.headers.authorization,'Bearer cartesia-secret');
      return pcm();
    }) as typeof fetch;
    const config={model:model.id,language:code,voice:model.languages[0].voices[0].id};
    assert.equal((await synthesizeVoiceSpeech(bindings as Env,config,'Test',undefined,fetcher)).byteLength,640);
    assert.equal(requests,1);
    assert.match(receptionistMessages({...voiceAgentInput.parse({...input,...config}),id:'agent',updatedAt:''},[],'Test')[0].content,
      new RegExp(`Respond in ${VOICE_LANGUAGES.find(language=>language.code===code)!.name}`));
  }
});

test('provider failure, invalid PCM and cancellation fail without retry or fallback to English',async()=>{
  const config={model:'sonic-3.6' as const,language:'fr' as const,voice:VOICE_SPEECH_MODELS[3].languages[0].voices[0].id};
  for(const response of [new Response('error',{status:503}),new Response(new Uint8Array(3)),new Response(new Uint8Array()),
    Response.json({audio:'invalid'}),new Response(new TextEncoder().encode('RIFF0000WAVE'))]) {
    let calls=0;
    await assert.rejects(synthesizeVoiceSpeech(bindings as Env,config,'Bonjour',undefined,(async()=>{calls++;return response;}) as typeof fetch),/tts_/);
    assert.equal(calls,1);
  }
  await assert.rejects(synthesizeVoiceSpeech({} as Env,config,'Bonjour'),/voice_model_unavailable/);
  const abort=new AbortController();abort.abort();
  await assert.rejects(synthesizeVoiceSpeech(bindings as Env,config,'Bonjour',abort.signal,(async(_url:any,options:any)=>{
    assert.equal(options.signal.aborted,true);throw options.signal.reason;
  }) as typeof fetch));
});

test('selected models use their own speech and token prices, counting Unicode characters once',()=>{
  assert.equal(sttCost(60_000,'@cf/deepgram/nova-3'),9200);
  assert.equal(sttCost(60_000,'@cf/deepgram/flux'),7700);
  assert.equal(ttsCost('Hola',speechRate({} as Env,'aura-2')),120);
  assert.equal(ttsCost('😀',speechRate(bindings as Env,'sonic-3.6')),65);
  const models=resolveVoiceModels({model:'sonic-3.6',language:'ja'});
  assert.equal(models.llm,'@cf/google/gemma-4-26b-a4b-it');
  assert.equal(llmCost({prompt_tokens:100,completion_tokens:20},models.llm),17);
});
