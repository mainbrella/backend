import { entitlementHeaders, type Entitlement } from '../../containers/plan-policy.js';
import { machineName, validContainerId } from '../../containers/container-account-core.js';
import { resolveEntitlement } from './entitlements';

export type ContainerState = { plan: string | null; active: boolean; containers: { id: string; createdAt: string; expiresAt: string; status: string }[] };
export type ContainerImageSelection = { imageKey?: string; imageId?: string; imageName?: string; size?: string; internet?: boolean; workspaceId?: string };
export async function accountResponse(env: Env, userId: string, entitlement: Entitlement, method = 'GET', id?: string | null, createdAt?: string | null, selection?: ContainerImageSelection, idempotencyKey?: string | null): Promise<Response> {
  if (!env.CONTAINER_ACCOUNT || !env.USER_CONTAINER) throw new Error('containers_unavailable');
  const account = env.CONTAINER_ACCOUNT.get(env.CONTAINER_ACCOUNT.idFromName(`account:${userId}`));
  const url = new URL('https://internal/containers');
  if (id) url.searchParams.set('id', id);
  if (createdAt) url.searchParams.set('createdAt', createdAt);
  return account.fetch(new Request(url, { method,
    headers: { ...entitlementHeaders(entitlement), 'x-mainbrella-user': userId, ...(method === 'POST' && idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}), ...(method === 'DELETE' ? { 'x-mainbrella-cleanup': '1' } : {}), ...(method === 'POST' && selection ? { 'Content-Type': 'application/json' } : {}) },
    ...(method === 'POST' && selection ? { body: JSON.stringify(selection) } : {}),
  }));
}
export async function syncAccountEntitlement(env: Env, userId: string, entitlement: Entitlement): Promise<void> {
  const response = await accountResponse(env, userId, entitlement, 'PUT');
  if (!response.ok) throw new Error('containers_unavailable');
}
export async function runningContainer(env: Env, userId: string, id?: string | null) {
  if (id && !validContainerId(id)) throw new Error('invalid_container_id');
  const entitlement = await resolveEntitlement(env, userId);
  const response = await accountResponse(env, userId, entitlement);
  if (!response.ok) throw new Error('containers_unavailable');
  const data = await response.json() as ContainerState;
  if (!entitlement.active) throw new Error('subscription_required');
  if (!id && data.containers.length > 1) throw new Error('container_id_required');
  const container = id ? data.containers.find(c => c.id === id && c.status === 'running') : data.containers.find(c => c.status === 'running');
  const stub = container ? env.USER_CONTAINER!.get(env.USER_CONTAINER!.idFromName(machineName(userId, container.id))) : null;
  return { stub, container, entitlement };
}
export function containerError(error: unknown, fallback: string): { error: string; status: number } {
  const message = error instanceof Error ? error.message : '';
  if (message === 'subscription_required') return { error: message, status: 402 };
  if (['container_id_required', 'invalid_container_id'].includes(message)) return { error: message, status: 400 };
  if (message === 'billing_unavailable') return { error: message, status: 503 };
  return { error: fallback, status: 503 };
}
