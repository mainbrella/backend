export const MAX_WEBHOOK_CONFIGS = 32;
export const MAX_WEBHOOK_DELIVERIES = 256;
export const WEBHOOK_ATTEMPTS = 8;
export const WEBHOOK_RETRY_MS = [5000, 30_000, 120_000, 600_000, 3600_000, 6 * 3600_000, 24 * 3600_000];
export const WEBHOOK_BODY_BYTES = 4096;
export function webhookUrl(value, allowlist) {
  if (typeof value !== 'string' || value.length > 2048 || !value) return null;
  try {
    const url = new URL(value);
    const hosts = (allowlist ?? '').split(',').map(host => host.trim().toLowerCase()).filter(Boolean);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
      || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname)
      || !hosts.includes(url.hostname) || /(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}
export function webhooksConfigured(env) {
  return env.WORKLOAD_WEBHOOKS_ENABLED === 'true'
    && (env.WEBHOOK_ALLOWED_HOSTS ?? '').split(',').some(host => webhookUrl(`https://${host.trim()}`, env.WEBHOOK_ALLOWED_HOSTS));
}
export async function readWebhookBody(request) {
  const bytes = await readFileBytes(request.body, WEBHOOK_BODY_BYTES, request.signal);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
import { readFileBytes } from './file-contract.js';
