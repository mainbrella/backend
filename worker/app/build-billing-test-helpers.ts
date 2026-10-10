import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { ContainerAccountController } from '../../containers/container-account-core.js';
import { appendAccountingEvent } from '../lib/accounting-ledger';

export async function buildBillingFixture(env: Env, sqlite: DatabaseSync, userId: string) {
  for (const name of ['020_accounting_ledger.sql', '026_build_ai_billing.sql'])
    sqlite.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'));
  const stored = new Map<string, unknown>(), billingCalls: Request[] = [];
  const ctx = { storage: {
    async get(key: string) { return structuredClone(stored.get(key)); },
    async put(key: string, value: unknown) { stored.set(key, structuredClone(value)); },
    async setAlarm() {}, async deleteAlarm() {},
  } };
  const controller = new ContainerAccountController(ctx, () => { throw new Error('Unexpected machine request'); },
    Date.now, undefined, undefined, undefined, (event: any) => appendAccountingEvent(env, event));
  const internal = (body: unknown) => new Request('https://internal/billing/funding', { method: 'POST',
    headers: { 'x-mainbrella-user': userId, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const funded = await controller.fetch(internal({ id: 'pi_build', customerId: 'cus_build', amountCents: 500,
    refundedCents: 0, disputed: false, createdAt: Date.now(), kind: 'topup' }));
  if (!funded.ok) throw new Error(await funded.text());
  const originalGet = env.CONTAINER_ACCOUNT.get.bind(env.CONTAINER_ACCOUNT);
  env.CONTAINER_ACCOUNT.get = ((id: DurableObjectId) => {
    const original = originalGet(id);
    return { async fetch(request: Request) {
      if (new URL(request.url).pathname.startsWith('/billing/')) {
        billingCalls.push(request.clone());
        return controller.fetch(request);
      }
      return original.fetch(request);
    } };
  }) as typeof env.CONTAINER_ACCOUNT.get;
  return { controller, stored, billingCalls };
}
