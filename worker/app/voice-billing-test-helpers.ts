import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { ContainerAccountController } from '../../containers/container-account-core.js';
import { appendAccountingEvent } from '../lib/accounting-ledger';

export async function voiceBillingFixture(env: Env, sqlite: DatabaseSync, userId: string) {
  for (const name of ['020_accounting_ledger','026_build_ai_billing','044_voice_billing'])
    sqlite.exec(readFileSync(new URL(`../../migrations/${name}.sql`,import.meta.url),'utf8'));
  const stored=new Map<string,unknown>();
  const ctx={storage:{
    async get(key:string) {return structuredClone(stored.get(key));},
    async put(key:string,value:unknown) {stored.set(key,structuredClone(value));},
    async setAlarm() {},async deleteAlarm() {},
  }} as unknown as DurableObjectState;
  const controller=new ContainerAccountController(ctx,()=>{throw new Error('Unexpected compute');},Date.now,
    undefined,undefined,undefined,event=>appendAccountingEvent(env,event));
  const request=(path:string,body?:unknown)=>controller.fetch(new Request(`https://internal/billing${path}`,{
    method:body===undefined?'GET':'POST',headers:{'x-mainbrella-user':userId,'content-type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
  }));
  const response=await request('/funding',{id:'pi_voice',customerId:'cus_voice',amountCents:500,
    refundedCents:0,disputed:false,createdAt:Date.now(),kind:'topup'});
  if (!response.ok) throw new Error(await response.text());
  const originalGet=env.CONTAINER_ACCOUNT.get.bind(env.CONTAINER_ACCOUNT);
  env.CONTAINER_ACCOUNT.get=((id:DurableObjectId)=>{
    const original=originalGet(id);
    return {fetch(request:Request) {
      return new URL(request.url).pathname.startsWith('/billing/')?controller.fetch(request):original.fetch(request);
    }};
  }) as typeof env.CONTAINER_ACCOUNT.get;
  return {stored,controller,request};
}
