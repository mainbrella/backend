import { validPreviewId, validPreviewPort } from '../../containers/preview-contract.js';

export interface PreviewRoutingEnv {
  ACQUISITION_ENABLED?: string;
  CONTAINER_ACCOUNT?: DurableObjectNamespace<any>;
  LOCAL_DEV?: string;
  LOCAL_PREVIEW_PORT?: string;
  PREVIEWS_ENABLED?: string;
  PREVIEW_DOMAIN?: string;
  PREVIEW_ROUTES?: D1Database;
  USER_CONTAINER?: DurableObjectNamespace;
}

export type PreviewGrant = { id: string; port: number; createdAt: string; expiresAt: number };
export type PreviewRoute = { preview_id: string; container_name: string; created_at: string; expires_at: number };

export function previewDomain(env: PreviewRoutingEnv): string | null {
  if (env.LOCAL_DEV === 'true') return 'localhost';
  const domain = env.PREVIEW_DOMAIN;
  // Only an explicit, canonical DNS name; never a URL, port, wildcard or account
  // hostname. Operators must select a separate registrable domain before routing.
  if (!domain || domain.length > 190 || domain !== domain.toLowerCase()
    || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
    || domain === 'mainbrella.com' || domain.endsWith('.mainbrella.com')) return null;
  return domain;
}

export function previewOrigin(env: PreviewRoutingEnv, token: string): string {
  if (env.LOCAL_DEV === 'true') {
    const port = env.LOCAL_PREVIEW_PORT ?? '8787';
    if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) throw new Error('invalid_local_preview_port');
    return `http://${token}.localhost:${port}`;
  }
  return `https://${token}.${previewDomain(env)}`;
}

export function previewsConfigured(env: PreviewRoutingEnv): boolean {
  return env.PREVIEWS_ENABLED === 'true' && Boolean(previewDomain(env) && env.PREVIEW_ROUTES && env.USER_CONTAINER);
}

export function validPreviewGeneration(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 32 && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

export function validPreviewGrant(value: unknown, createdAt: string): value is PreviewGrant {
  if (!value || typeof value !== 'object') return false;
  const grant = value as PreviewGrant;
  return validPreviewId(grant.id) && validPreviewPort(grant.port) && grant.createdAt === createdAt
    && Number.isSafeInteger(grant.expiresAt) && grant.expiresAt > Date.now();
}

export async function previewTokenHash(token: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// Bounded cleanup work per scheduled invocation. Routing independently checks
// expiry, so delayed cleanup never prolongs access.
export async function prunePreviewRoutes(database: D1Database): Promise<void> {
  const result = await database.prepare(`DELETE FROM preview_routes WHERE token_hash IN
    (SELECT token_hash FROM preview_routes WHERE expires_at <= ? ORDER BY expires_at LIMIT 1000)`)
    .bind(Date.now()).run();
  if (!result.success) throw new Error('preview_cleanup_failed');
}
