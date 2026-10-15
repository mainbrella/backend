import test from 'node:test';
import assert from 'node:assert/strict';
import { withVoiceBackchannel } from '../lib/voice-backchannel';

function deferred() {
  let resolve!: (text:string)=>void;
  let reject!: (error:Error)=>void;
  const promise=new Promise<string>((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}

test('fast voice replies skip acknowledgments',async()=>{
  const parts=[];
  for await (const part of withVoiceBackchannel(Promise.resolve('Here is the answer.'),new AbortController().signal,1)) parts.push(part);
  assert.deepEqual(parts,[{type:'text-delta',text:'Here is the answer.'}]);
});

test('slow voice replies acknowledge at one and five seconds, then wait for the answer',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const reply=deferred();
  const stream=withVoiceBackchannel(reply.promise,new AbortController().signal,1);
  let received=false;
  const first=stream.next().then(part=>{received=true;return part;});
  t.mock.timers.tick(999);
  await Promise.resolve();
  assert.equal(received,false);
  t.mock.timers.tick(1);
  assert.deepEqual((await first).value,{type:'text-delta',text:'Mm-hmm. '});
  assert.deepEqual((await stream.next()).value,{type:'text-end'});
  // Time spent synthesizing the acknowledgment counts toward the five seconds.
  t.mock.timers.tick(2000);
  const second=stream.next();
  t.mock.timers.tick(2000);
  assert.deepEqual((await second).value,{type:'text-delta',text:'One moment. '});
  assert.deepEqual((await stream.next()).value,{type:'text-end'});
  const final=stream.next();
  t.mock.timers.tick(20_000);
  reply.resolve('Here is the answer.');
  assert.deepEqual((await final).value,{type:'text-delta',text:'Here is the answer.'});
  assert.equal((await stream.next()).done,true);
});

test('a ready answer takes priority over a later holding phrase',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const reply=deferred();
  const stream=withVoiceBackchannel(reply.promise,new AbortController().signal,2);
  const first=stream.next();
  t.mock.timers.tick(1000);
  assert.deepEqual((await first).value,{type:'text-delta',text:'Okay. '});
  await stream.next();
  reply.resolve('The answer.');
  t.mock.timers.tick(10_000);
  assert.deepEqual((await stream.next()).value,{type:'text-delta',text:'The answer.'});
  assert.equal((await stream.next()).done,true);
});

for (const afterAcknowledgment of [false,true]) {
  test(`interrupt stops waiting ${afterAcknowledgment?'after':'before'} the acknowledgment and handles late model failure`,async t=>{
    t.mock.timers.enable({apis:['setTimeout','Date']});
    const reply=deferred();
    const controller=new AbortController();
    const stream=withVoiceBackchannel(reply.promise,controller.signal,3);
    let next=stream.next();
    if (afterAcknowledgment) {
      t.mock.timers.tick(1000);
      assert.deepEqual((await next).value,{type:'text-delta',text:'Ah-huh. '});
      await stream.next();
      next=stream.next();
    }
    controller.abort();
    assert.equal((await next).done,true);
    reply.reject(new Error('Canceled model'));
    t.mock.timers.tick(10_000);
    assert.equal((await stream.next()).done,true);
  });
}

test('model errors remain errors, including after an acknowledgment',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const reply=deferred();
  const stream=withVoiceBackchannel(reply.promise,new AbortController().signal,1);
  const first=stream.next();
  t.mock.timers.tick(1000);
  await first;
  await stream.next();
  const error=new Error('Model unavailable');
  reply.reject(error);
  assert.deepEqual((await stream.next()).value,{type:'error',error});
  assert.equal((await stream.next()).done,true);
});

test('a stream canceled before consumption still handles a model rejection',async()=>{
  const reply=deferred();
  const controller=new AbortController();
  const stream=withVoiceBackchannel(reply.promise,controller.signal,1);
  controller.abort();
  reply.reject(new Error('Canceled before consumption'));
  assert.equal((await stream.next()).done,true);
});
