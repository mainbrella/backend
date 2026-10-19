export interface WalletBalance {
  balanceCents: number;
  availableBalanceCents: number;
  reservedBalanceCents: number;
  currency: 'usd';
  spendLimitCents: number;
  monthlyUsageCents: number;
}

// The binding and account name are deliberately unchanged: all products share
// the existing serialized wallet, including accounts funded before extraction.
export interface WalletEnv {
  CONTAINER_ACCOUNT?: {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): { fetch(request: Request): Promise<Response> };
  };
}
export async function walletRequest<T = { balance: WalletBalance }>(env: WalletEnv, userId: string, path: string, body?: unknown): Promise<T> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) throw new Error('invalid_account');
  if (!env.CONTAINER_ACCOUNT) throw new Error('billing_unavailable');
  const account = env.CONTAINER_ACCOUNT.get(env.CONTAINER_ACCOUNT.idFromName(`account:${userId}`));
  const response = await account.fetch(new Request(`https://internal${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-mainbrella-user': userId, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? 'billing_unavailable');
  return result;
}

export interface UsageIdentity { product: string; id: string; meter: string }
export interface UsageReservation extends UsageIdentity {
  reservedMicroUsd: number;
  createdAt: number;
  resourceId?: string;
}
export interface UsageSettlement extends UsageIdentity {
  costMicroUsd: number;
  occurredAt: number;
  evidence: Record<string, unknown>;
}
export interface UsageRelease extends UsageIdentity {
  occurredAt: number;
  reason: 'canceled_before_dispatch' | 'provider_rejected';
}
export interface UsageResult { balance: WalletBalance; status: 'reserved' | 'settled' | 'released' }

export const reserveUsage = (env: WalletEnv, userId: string, reservation: UsageReservation) =>
  walletRequest<UsageResult>(env, userId, '/billing/usage', { ...reservation, action: 'reserve' });
export const settleUsage = (env: WalletEnv, userId: string, settlement: UsageSettlement) =>
  walletRequest<UsageResult>(env, userId, '/billing/usage', { ...settlement, action: 'settle' });
export const releaseUsage = (env: WalletEnv, userId: string, release: UsageRelease) =>
  walletRequest<UsageResult>(env, userId, '/billing/usage', { ...release, action: 'release' });
