import { boundedBody as boundedPrivateBody } from '../shared/bounded-body.js';
import { isStaging } from './deployment-environment';

export class DomainError extends Error {
  constructor(message: string, public status = 503, public definitive = false) { super(message); }
}
export const DOMAIN_TLDS = ['com', 'net', 'org', 'app', 'dev', 'xyz'];
export function domainName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().toLowerCase();
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z]+$/.test(name)
    && !name.startsWith('xn--') && DOMAIN_TLDS.includes(name.split('.')[1]) ? name : null;
}
export function registrarConfigured(env: Env): boolean {
  return !isStaging(env) && env.NAMECOM_ENABLED === 'true' && Boolean(env.NAME_DOT_COM_USERNAME && env.NAME_DOT_COM_TOKEN);
}
export function usdCents(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0
    || value > 100_000 || Math.abs(value * 100 - Math.round(value * 100)) > 0.00001) throw new DomainError('invalid_registrar_price');
  return Math.round(value * 100);
}
export function retailCents(env: Env, cost: number): number {
  const markup = Number(env.NAMECOM_MARKUP_BPS ?? '0');
  if (!Number.isInteger(markup) || markup < 0 || markup > 10000) throw new DomainError('registrar_unavailable');
  return Math.ceil(cost * (10000 + markup) / 10000);
}
export interface NameDomain {
  domainName: string; expireDate: string; privacyEnabled: boolean; locked: boolean; locks?: string[];
  transferLockExpiresAt?: string; nameservers: string[];
  contacts: { registrant: Record<string, unknown> & { isVerified?: boolean; verificationId?: number } };
}
export interface NameRecord { id: number; type: string; host: string | null; answer: string; ttl: number; priority?: number }
export async function namecom<T>(env: Env, path: string, method = 'GET', body?: object, key?: string): Promise<T> {
  if (!registrarConfigured(env)) throw new DomainError('registrar_unavailable');
  const sandbox = env.LOCAL_DEV === 'true';
  const origin = sandbox ? 'https://api.dev.name.com' : 'https://api.name.com';
  const username = sandbox ? (env.NAME_DOT_COM_DEV_USERNAME ?? `${env.NAME_DOT_COM_USERNAME}-test`) : env.NAME_DOT_COM_USERNAME;
  let response: Response;
  try {
    response = await fetch(`${origin}/core/v1${path}`, { method, redirect: 'manual', signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Basic ${btoa(`${username}:${env.NAME_DOT_COM_TOKEN}`)}`, accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { 'X-Idempotency-Key': key } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
  } catch { throw new DomainError('registrar_unavailable'); }
  // A timeout, 5xx, or conflict can mean the billable request completed. Never refund
  // or submit a different purchase until the original idempotency key is reconciled.
  if (!response.ok) throw new DomainError(response.status === 404 ? 'registrar_not_found' : 'registrar_unavailable', 503,
    [400, 402, 422].includes(response.status));
  try { return JSON.parse(new TextDecoder().decode(await boundedPrivateBody(response.body, 524288))) as T; }
  catch { throw new DomainError('registrar_unavailable'); }
}
export const nameDomainPath = (name: string) => `/domains/${encodeURIComponent(name)}`;
export function checkedNameDomain(value: NameDomain, name: string): NameDomain {
  if (value?.domainName !== name || !Number.isFinite(Date.parse(value.expireDate))
    || !Array.isArray(value.nameservers) || typeof value.privacyEnabled !== 'boolean' || typeof value.locked !== 'boolean') throw new DomainError('registrar_unavailable');
  return value;
}
