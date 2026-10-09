import { previewDomain, previewOrigin, type PreviewRoutingEnv } from './preview-routing';
import { validContainerId } from '../../containers/container-account-core.js';
import { validPreviewGeneration } from './preview-routing';
import { validServiceName, validPrivatePort } from '../../containers/private-services-contract.js';

export interface ProjectHostingEnv extends PreviewRoutingEnv {
  PROJECT_HOSTING_ENABLED?: string;
  CONTAINER_ACCOUNT?: DurableObjectNamespace<any>;
  PROJECT_DOMAIN_PROVIDER?: string;
  PROJECT_CLOUDFLARE_ZONE_ID?: string;
  PROJECT_CLOUDFLARE_API_TOKEN?: string;
  PROJECT_APEX_IPS?: string;
  PROJECT_INGRESS_HOST?: string;
  PROJECT_INGRESS_SECRET?: string;
}
export type ProjectTarget = { kind: 'container'; id: string; createdAt: string; port: number }
  | { kind: 'network'; network: string; service: string };
export type StoredProjectTarget = ProjectTarget & { snapshot?: { id: string; createdAt: string; port: number } };
export type ProjectEndpointRoute = {
  project_id: string; user_id: string; target_json: string; container_name: string; created_at: string;
  port: number; revision: string; updated_at: string;
};
export const validProjectId = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export function validProjectTarget(value: unknown): value is ProjectTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const target = value as ProjectTarget;
  return target.kind === 'container' ? Object.keys(target).length === 4 && validContainerId(target.id)
    && validPreviewGeneration(target.createdAt) && validPrivatePort(target.port)
    : target.kind === 'network' && Object.keys(target).length === 3 && validServiceName(target.network) && validServiceName(target.service);
}
export function publicProjectTarget(target: StoredProjectTarget): ProjectTarget {
  return target.kind === 'container' ? { kind: 'container', id: target.id, createdAt: target.createdAt, port: target.port }
    : { kind: 'network', network: target.network, service: target.service };
}
export function projectHostingConfigured(env: ProjectHostingEnv): boolean {
  return env.PROJECT_HOSTING_ENABLED === 'true' && Boolean(previewDomain(env) && env.PREVIEW_ROUTES && env.USER_CONTAINER && env.CONTAINER_ACCOUNT);
}
export function projectOrigin(env: ProjectHostingEnv, projectId: string): string {
  if (!validProjectId(projectId)) throw new Error('invalid_project_id');
  return previewOrigin(env, `p-${projectId.replaceAll('-', '')}`);
}
export function projectHostname(env: ProjectHostingEnv, projectId: string): string {
  return new URL(projectOrigin(env, projectId)).hostname;
}
export function publicIngressIp(value: string): boolean {
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) {
    const parts = value.split('.');
    if (!parts.every(part => Number(part) <= 255 && String(Number(part)) === part)) return false;
    const [a, b, c] = parts.map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254
      || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 88 && c === 99)
      || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)
      || a === 203 && b === 0 && c === 113);
  }
  // Only canonical global-unicast IPv6, excluding the documentation prefix.
  try { return /^[23][0-9a-f]{3}:/.test(value) && !value.startsWith('2001:db8:')
    && new URL(`http://[${value}]/`).hostname === `[${value}]`; } catch { return false; }
}
export function apexIps(env: ProjectHostingEnv): string[] {
  return [...new Set((env.PROJECT_APEX_IPS ?? '').split(/[\s,]+/).filter(Boolean))].filter(publicIngressIp);
}
export function canonicalIngressHost(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 253
    && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value)
    && value !== 'mainbrella.com' && !value.endsWith('.mainbrella.com');
}
export function customDomainsConfigured(env: ProjectHostingEnv): boolean {
  if (!projectHostingConfigured(env) || env.LOCAL_DEV === 'true') return false;
  return env.PROJECT_DOMAIN_PROVIDER === 'cloudflare' ? Boolean(env.PROJECT_CLOUDFLARE_ZONE_ID && env.PROJECT_CLOUDFLARE_API_TOKEN)
    : env.PROJECT_DOMAIN_PROVIDER === 'ingress' && Boolean(apexIps(env).length && canonicalIngressHost(env.PROJECT_INGRESS_HOST) && (env.PROJECT_INGRESS_SECRET?.length ?? 0) >= 32);
}
export function projectHostingCapabilities(env: ProjectHostingEnv) {
  return { supported: projectHostingConfigured(env), customDomains: customDomainsConfigured(env), apexIps: apexIps(env) };
}
