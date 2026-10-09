import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { previewDatabase } from './lib/preview-test-helpers';
import { handleProjectGateway, type ProjectGatewayEnv } from './project-gateway';
import { normalizeProjectHostname } from './lib/project-domains';
import { validProjectOrigin } from '../containers/project-contract.js';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const revision = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const generation = '2026-10-05T12:00:00.000Z';
const origin = `https://p-${id.replaceAll('-', '')}.mainbrella.dev`;
// Match the actual API-produced TXT/readiness challenge, including '='.
const verification = `mainbrella-verification=${revision}`;

function fixture(t: TestContext) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  const db = previewDatabase(sqlite);
  sqlite.exec(`CREATE TABLE project_endpoints(project_id TEXT PRIMARY KEY,user_id TEXT,target_json TEXT,container_name TEXT,created_at TEXT,port INTEGER,revision TEXT,updated_at TEXT);
    CREATE TABLE project_hosts(hostname TEXT PRIMARY KEY,project_id TEXT,status TEXT,verification_token TEXT);`);
  sqlite.prepare('INSERT INTO project_endpoints VALUES(?,?,?,?,?,?,?,?)').run(id, 'owner', JSON.stringify({kind:'container',id:'c1',createdAt:generation,port:3000}), 'user:owner:slot:1', generation,3000,revision,generation);
  sqlite.prepare('INSERT INTO project_hosts VALUES(?,?,?,?)').run('app.example',id,'pending_tls',verification);
  const calls: Request[] = [], accounts: Request[] = [], names: string[] = [];
  let response = new Response('app');
  let registry: unknown = { networks: [{name:'production',members:[{id:'c1',createdAt:generation,port:3000,name:'frontend'}]}] };
  const env: ProjectGatewayEnv = { PROJECT_HOSTING_ENABLED:'true', PREVIEW_DOMAIN:'mainbrella.dev',PREVIEW_ROUTES:db,
    PROJECT_INGRESS_HOST:'ingress.mainbrella.dev',PROJECT_INGRESS_SECRET:'s'.repeat(48),
    USER_CONTAINER:{ idFromName(name: string){names.push(name);return name;}, get(){return {fetch(req:Request){calls.push(req);return response;}};} } as unknown as DurableObjectNamespace,
    CONTAINER_ACCOUNT:{idFromName(name: string){assert.equal(name,'account:owner');return name;},get(){return {fetch(req:Request){accounts.push(req);return Response.json(registry);}};}} as unknown as DurableObjectNamespace,
  };
  const call = (path='/', options?:RequestInit) => handleProjectGateway(new Request(`${origin}${path}`,options),env);
  const custom = (path='/', options?:RequestInit) => handleProjectGateway(new Request(`https://app.example${path}`,options),env);
  const ingress = (path='/', options:RequestInit={}) => handleProjectGateway(new Request(`https://ingress.mainbrella.dev${path}`,{
    ...options,headers:{'x-project-ingress-secret':'s'.repeat(48),'x-project-original-host':'app.example',...options.headers},
  }),env);
  return {sqlite,env,calls,accounts,names,call,custom,ingress,setResponse(value:Response){response=value;},setRegistry(value:unknown){registry=value;}};
}

test('gateway preserves app auth, cookie, body and Origin with attested exact route and abort signal',async t=>{
  const f=fixture(t);
  const abort=new AbortController();
  const result=await f.call('/login?x=1&x=2',{method:'POST',body:new Uint8Array([0,255]),signal:abort.signal,headers:{
    authorization:'Bearer app_secret',cookie:'mainbrella_session=account; app_session=app',origin:'https://browser.example',
    'x-project-id':'victim','x-project-revision':'victim','x-project-created-at':'victim','x-project-origin':'https://victim.example',
    'x-private-network':'victim','x-mainbrella-user':'victim','x-exec-created-at':'victim','cf-connecting-ip':'victim',
    'x-forwarded-host':'victim',forwarded:'victim','x-project-ingress-secret':'victim','x-project-original-host':'victim.example',
  }});
  assert.equal(await result.text(),'app');
  assert.deepEqual(f.names,['user:owner:slot:1']);
  const req=f.calls[0];
  assert.equal(req.url,'https://internal/project/login?x=1&x=2');
  assert.equal(req.method,'POST');
  assert.equal(req.redirect,'manual');
  assert.deepEqual(new Uint8Array(await req.arrayBuffer()),new Uint8Array([0,255]));
  assert.equal(req.headers.get('authorization'),'Bearer app_secret');
  assert.equal(req.headers.get('cookie'),'app_session=app');
  assert.equal(req.headers.get('origin'),'https://browser.example');
  assert.equal(req.headers.get('x-project-id'),id);
  assert.equal(req.headers.get('x-project-revision'),revision);
  assert.equal(req.headers.get('x-project-created-at'),generation);
  assert.equal(req.headers.get('x-project-origin'),origin);
  for(const name of ['x-private-network','x-mainbrella-user','x-exec-created-at','cf-connecting-ip','x-forwarded-host','forwarded','x-project-ingress-secret','x-project-original-host'])assert.equal(req.headers.get(name),null,name);
  abort.abort();assert.equal(req.signal.aborted,true);
  await f.call('/',{headers:{authorization:'Bearer mb_secret'}});
  assert.equal(f.calls[1].headers.get('authorization'),null);
});

test('gateway fails closed on absent capability, wrong generation/port/slot/user/revision and malformed host',async t=>{
  const f=fixture(t);
  for(const url of [origin.replace('https:','http:'),`${origin}:8443/`,'https://p-cccccccccccc4ccc8ccccccccccccccc.mainbrella.dev/','https://app.mainbrella.com/'])assert.equal((await handleProjectGateway(new Request(url),f.env)).status,404);
  assert.equal((await f.call('/',{headers:{host:'victim.example'}})).status,404);
  f.env.PROJECT_HOSTING_ENABLED='false';assert.equal((await f.call()).status,404);f.env.PROJECT_HOSTING_ENABLED='true';
  for(const [column,value] of [['container_name','user:victim:slot:1'],['user_id','victim'],['created_at','2026-10-06T12:00:00.000Z'],['revision','bad'],['port',22]] as const){
    const previous=f.sqlite.prepare(`SELECT ${column} FROM project_endpoints`).get()![column];
    f.sqlite.prepare(`UPDATE project_endpoints SET ${column}=?`).run(value);
    assert.equal((await f.call()).status,404,column);
    f.sqlite.prepare(`UPDATE project_endpoints SET ${column}=?`).run(previous as string|number);
  }
  assert.equal(f.calls.length,0);
});

test('pending TLS custom hosts expose only exact readiness probe; active claims serve application',async t=>{
  const f=fixture(t);
  assert.equal((await f.custom()).status,404);
  assert.equal(await (await f.custom('/.well-known/mainbrella-domain-check')).text(),verification);
  assert.equal((await f.custom('/.well-known/mainbrella-domain-check',{method:'POST'})).status,404);
  assert.equal((await f.custom('/.well-known/mainbrella-domain-check/')).status,404);
  assert.equal(f.calls.length,0);
  f.sqlite.exec("UPDATE project_hosts SET status='active'");
  assert.equal((await f.custom()).status,200);
  assert.equal(f.calls[0].headers.get('x-project-origin'),'https://app.example');
  f.sqlite.exec('DELETE FROM project_hosts');
  assert.equal((await f.custom()).status,404);
});

test('static ingress authenticates original host and certificate ask without forwarding secrets',async t=>{
  const f=fixture(t);
  assert.equal((await f.ingress('/internal/projects/certificate?domain=app.example')).status,200);
  for(const domain of ['unknown.example','mainbrella.com','mainbrella.dev','p-aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa.mainbrella.dev','App.example','app.example:443']){
    assert.equal((await f.ingress(`/internal/projects/certificate?domain=${encodeURIComponent(domain)}`)).status,403);
  }
  assert.equal((await f.ingress('/internal/projects/certificate?domain=app.example&domain=app.example')).status,403);
  assert.equal((await f.ingress('/internal/projects/certificate?domain=app.example',{headers:{'x-project-ingress-secret':'bad'}})).status,403);
  assert.equal(await (await f.ingress('/.well-known/mainbrella-domain-check')).text(),verification);
  f.sqlite.exec("UPDATE project_hosts SET status='active'");
  assert.equal((await f.ingress()).status,200);
  assert.equal(f.calls[0].headers.get('x-project-origin'),'https://app.example');
  assert.equal(f.calls[0].headers.get('x-project-ingress-secret'),null);
  assert.equal(f.calls[0].headers.get('x-project-original-host'),null);
  assert.equal((await f.ingress('/',{headers:{'x-project-original-host':'mainbrella.com'}})).status,403);
  f.env.PROJECT_INGRESS_SECRET='short';assert.equal((await f.ingress()).status,403);
});

test('network service routes check current owned registry on each request and fence replacement/detach',async t=>{
  const f=fixture(t);
  f.sqlite.prepare('UPDATE project_endpoints SET target_json=?').run(JSON.stringify({kind:'network',network:'production',service:'frontend',snapshot:{id:'c1',createdAt:generation,port:3000}}));
  assert.equal((await f.call()).status,200);
  assert.equal(f.accounts[0].url,'https://internal/private-services/networks');
  assert.equal(f.accounts[0].headers.get('x-mainbrella-user'),'owner');
  for(const registry of [{networks:[]},{networks:[{name:'production',members:[]}]},{networks:[{name:'production',members:[{id:'c2',createdAt:generation,port:3000,name:'frontend'}]}]},
    {networks:[{name:'production',members:[{id:'c1',createdAt:'2026-10-06T12:00:00.000Z',port:3000,name:'frontend'}]}]},
    {networks:[{name:'production',members:[{id:'c1',createdAt:generation,port:3001,name:'frontend'}]}]},null]){
    f.setRegistry(registry);const response=await f.call();assert.ok([404,503].includes(response.status));
  }
  assert.equal(f.calls.length,1);
});

test('gateway passes streaming and WebSocket responses unchanged and suppresses routing exception details',async t=>{
  const f=fixture(t);
  const websocket=Object.defineProperties(new Response(null),{status:{value:101},webSocket:{value:{}}});
  f.setResponse(websocket);
  assert.equal(await f.call('/socket',{headers:{upgrade:'websocket'}}),websocket);
  assert.equal(f.calls[0].headers.get('upgrade'),'websocket');
  const stream=new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([42]));c.close();}}));
  f.setResponse(stream);assert.equal(await f.call(),stream);assert.deepEqual(new Uint8Array(await stream.arrayBuffer()),new Uint8Array([42]));
  f.env.PREVIEW_ROUTES={prepare(){throw new Error('private account and secret');}} as unknown as D1Database;
  const error=await f.call();assert.equal(error.status,503);assert.equal(await error.text(),'Project unavailable.');
});

test('local project origins are accepted only with local configuration and exact port',async t=>{
  const f=fixture(t);f.env.LOCAL_DEV='true';
  const local=`http://p-${id.replaceAll('-','')}.localhost:8787`;
  assert.equal((await handleProjectGateway(new Request(local),f.env)).status,200);
  assert.equal(f.calls[0].headers.get('x-project-origin'),local);
  for(const url of [local.replace('8787','9999'),local.replace('http:','https:'),origin])assert.equal((await handleProjectGateway(new Request(url),f.env)).status,404);
});

test('API canonical IDNA and long hostname claims work consistently through gateway and runtime',async t=>{
  const f=fixture(t);
  const longHost=[...Array(3).fill('a'.repeat(63)),'b'.repeat(57),'com'].join('.');
  assert.equal(longHost.length,253);
  for(const input of ['bücher.example','shop.xn--p1ai',longHost]){
    const hostname=normalizeProjectHostname(input,f.env);
    assert.ok(hostname,input);
    assert.equal(validProjectOrigin(`https://${hostname}`),true,hostname);
    f.sqlite.prepare('INSERT INTO project_hosts VALUES(?,?,?,?)').run(hostname,id,'active',verification);
    const result=await handleProjectGateway(new Request(`https://${hostname}/login`),f.env);
    assert.equal(result.status,200,hostname);
    assert.equal(f.calls.at(-1)!.headers.get('x-project-origin'),`https://${hostname}`);
    const ask=await f.ingress(`/internal/projects/certificate?domain=${hostname}`);
    assert.equal(ask.status,200,hostname);
  }
  assert.equal(validProjectOrigin(`https://${longHost}a`),false);
  assert.equal(normalizeProjectHostname('mainbrella.com',f.env),null);
  assert.equal(validProjectOrigin('https://mainbrella.com'),false);
});

test('disabled claims deny certificate authorization, readiness probes and application requests',async t=>{
  const f=fixture(t);
  f.sqlite.exec("UPDATE project_hosts SET status='disabled'");
  assert.equal((await f.ingress('/internal/projects/certificate?domain=app.example')).status,403);
  assert.equal((await f.custom('/.well-known/mainbrella-domain-check')).status,404);
  assert.equal((await f.ingress('/.well-known/mainbrella-domain-check')).status,404);
  assert.equal((await f.custom()).status,404);
  assert.equal((await f.ingress()).status,404);
  assert.equal(f.calls.length,0);
});
