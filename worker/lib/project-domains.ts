import { apexIps, localProjectDomains, projectHostname, type ProjectHostingEnv } from './project-hosting';
import { boundedPrivateBody } from '../../containers/private-services-contract.js';
import { validLocalProjectHostname } from '../../containers/project-contract.js';
import { validPreviewToken } from '../../containers/preview-contract.js';
import { previewDomain } from './preview-routing';

export type ProjectDomainRow = {
  id: string; project_id: string; hostname: string; challenge: string; status: 'pending_dns' | 'pending_tls' | 'active' | 'error';
  dns_status: 'pending' | 'verified'; provider: 'cloudflare' | 'ingress' | null; tls_status: 'pending' | 'active' | 'error'; provider_id: string | null;
  error: string | null; created_at: string; operation_revision: string | null; operation_started_at: number | null; removing: number;
};
export type DnsRecord = { type: string; name: string; value: string; purpose: 'ownership' | 'routing' | 'certificate' };
export function normalizeProjectHostname(value: unknown, env?: ProjectHostingEnv): string | null {
  if (typeof value !== 'string' || value.length > 253 || !value.trim() || /[\s/:@?#%\\*]/.test(value)) return null;
  let hostname: string;
  try { hostname = new URL(`https://${value.replace(/\.$/, '')}`).hostname.toLowerCase(); } catch { return null; }
  if (env && localProjectDomains(env)) {
    return validLocalProjectHostname(hostname) && !/^p-[a-f0-9]{32}\.localhost$/.test(hostname)
      && !validPreviewToken(hostname.slice(0, -'.localhost'.length)) ? hostname : null;
  }
  if (hostname.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)) return null;
  const reserved = ['mainbrella.com', 'mainbrella.dev', 'localhost', 'internal', 'local', 'test', 'invalid', 'onion', ...(env && previewDomain(env) ? [previewDomain(env)!] : [])];
  return reserved.some(domain => hostname === domain || hostname.endsWith(`.${domain}`)) ? null : hostname;
}
export function publicProjectDomain(row: ProjectDomainRow, env: ProjectHostingEnv) {
  const dnsRecords: DnsRecord[] = [
    { type: 'TXT', name: `_mainbrella.${row.hostname}`, value: row.challenge, purpose: 'ownership' },
    { type: 'CNAME', name: row.hostname, value: projectHostname(env, row.project_id), purpose: 'routing' },
  ];
  const addressRecords: DnsRecord[] = apexIps(env).map(value => ({ type: value.includes(':') ? 'AAAA' : 'A', name: row.hostname, value, purpose: 'routing' }));
  if ((row.provider ?? env.PROJECT_DOMAIN_PROVIDER) === 'ingress') dnsRecords.splice(1, 1, ...addressRecords);
  return { id: row.id, hostname: row.hostname, status: row.status, dnsStatus: row.dns_status,
    tlsStatus: row.tls_status, dnsRecords, error: row.error,
    apexRecords: localProjectDomains(env) || (row.provider ?? env.PROJECT_DOMAIN_PROVIDER) === 'ingress' ? [] : addressRecords,
    routingNote: localProjectDomains(env) ? 'Local development: DNS and TLS are simulated. Click Verify DNS twice to activate this hostname. No DNS records or certificates are needed.'
      : (row.provider ?? env.PROJECT_DOMAIN_PROVIDER) === 'ingress' ? 'Add the listed A/AAAA records for this hostname, including an apex domain. Keep your current DNS provider.' : 'On Cloudflare DNS, set the CNAME to DNS only (gray cloud) so its target can be verified. For an apex domain, use ALIAS/ANAME or CNAME flattening to the project hostname, or the listed A/AAAA records. Keep your current DNS provider.' };
}
async function boundedJson(response: Response): Promise<unknown> {
  // Workers supports manual redirects; reject their non-2xx responses here.
  if (!response.ok) throw new Error('domain_provider_unavailable');
  const bytes = await boundedPrivateBody(response.body, 262144);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
type DnsAnswer = { name: string; type: number; data: string };
export async function dnsQuery(hostname: string, type: 'TXT' | 'CNAME' | 'A' | 'AAAA'): Promise<DnsAnswer[]> {
  const url = new URL('https://cloudflare-dns.com/dns-query');
  url.searchParams.set('name', hostname); url.searchParams.set('type', type);
  const data = await boundedJson(await fetch(url, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000), redirect: 'manual' })) as { Status?: number; Answer?: DnsAnswer[] };
  if (![0, 3].includes(data.Status ?? -1)) throw new Error('dns_unavailable');
  const answer = data.Answer ?? [];
  if (!Array.isArray(answer) || answer.length > 64 || !answer.every(record => typeof record.name === 'string' && typeof record.data === 'string' && typeof record.type === 'number')) throw new Error('dns_unavailable');
  return answer;
}
const dnsName = (value: string) => value.replace(/\.$/, '').toLowerCase();
function txtValue(value: string): string {
  // DNS JSON returns quoted chunks; a challenge must match the full TXT value.
  if (!/^(?:"(?:[^"\\]|\\.)*"\s*)+$/.test(value)) return value;
  return [...value.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(match => match[1].replace(/\\(["\\])/g, '$1')).join('');
}
export async function domainDnsProof(row: ProjectDomainRow, env: ProjectHostingEnv): Promise<{ ownership: boolean; routing: boolean; ingressSafe: boolean }> {
  if (localProjectDomains(env)) {
    // Only reserved loopback aliases may bypass public DNS, even in local mode.
    const valid = row.provider === null && normalizeProjectHostname(row.hostname, env) === row.hostname;
    return { ownership: valid, routing: valid, ingressSafe: false };
  }
  const txtHost = `_mainbrella.${row.hostname}`;
  const txt = await dnsQuery(txtHost, 'TXT');
  const ownership = txt.some(answer => answer.type === 16 && dnsName(answer.name) === txtHost && txtValue(answer.data) === row.challenge);
  if (!ownership) return { ownership: false, routing: false, ingressSafe: false };
  const target = projectHostname(env, row.project_id);
  let name = row.hostname, cnameMatches = false;
  const visited = new Set<string>();
  for (let i = 0; i < 8 && !visited.has(name); i++) {
    visited.add(name);
    const answers = await dnsQuery(name, 'CNAME');
    const cnames = answers.filter(answer => answer.type === 5 && dnsName(answer.name) === name);
    if (cnames.length !== 1) break;
    name = dnsName(cnames[0].data);
    if (name === target) { cnameMatches = true; break; }
    if (!normalizeProjectHostname(name)) break;
  }
  const [a, aaaa] = await Promise.all([dnsQuery(row.hostname, 'A'), dnsQuery(row.hostname, 'AAAA')]);
  const addresses = [...a, ...aaaa].filter(answer => answer.type === 1 || answer.type === 28).map(answer => answer.data.toLowerCase());
  const staticIps = apexIps(env);
  const ingressSafe = addresses.length > 0 && addresses.every(ip => staticIps.includes(ip));
  let flattened = ingressSafe;
  if (!flattened && env.PROJECT_DOMAIN_PROVIDER === 'cloudflare' && addresses.length) {
    const [targetA, targetAAAA] = await Promise.all([dnsQuery(target, 'A'), dnsQuery(target, 'AAAA')]);
    const targetIps = [...targetA, ...targetAAAA].filter(answer => answer.type === 1 || answer.type === 28).map(answer => answer.data.toLowerCase());
    flattened = targetIps.length > 0 && addresses.every(ip => targetIps.includes(ip));
  }
  return { ownership, routing: cnameMatches || flattened, ingressSafe };
}
export type CloudflareHostname = { id: string; hostname: string; status?: string; ssl?: { status?: string } };
export async function cloudflareRequest(env: ProjectHostingEnv, method: string, suffix = '', body?: unknown): Promise<unknown> {
  if (!env.PROJECT_CLOUDFLARE_ZONE_ID || !/^[a-z0-9]+$/i.test(env.PROJECT_CLOUDFLARE_ZONE_ID) || !env.PROJECT_CLOUDFLARE_API_TOKEN) throw new Error('domain_provider_unavailable');
  const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${env.PROJECT_CLOUDFLARE_ZONE_ID}/custom_hostnames${suffix}`, {
    method, headers: { authorization: `Bearer ${env.PROJECT_CLOUDFLARE_API_TOKEN}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(8000), redirect: 'manual',
  });
  if (method === 'DELETE' && response.status === 404) return null;
  const result = await boundedJson(response) as { success?: boolean; result?: unknown };
  if (result.success !== true) throw new Error('domain_provider_unavailable');
  return result.result;
}
export async function provisionCloudflareHostname(env: ProjectHostingEnv, row: ProjectDomainRow): Promise<CloudflareHostname> {
  let result: unknown;
  if (row.provider_id) result = await cloudflareRequest(env, 'GET', `/${encodeURIComponent(row.provider_id)}`);
  else {
    // Reconcile a lost create response using the exact verified hostname.
    const existing = await cloudflareRequest(env, 'GET', `?hostname=${encodeURIComponent(row.hostname)}`);
    if (!Array.isArray(existing) || existing.length > 1) throw new Error('domain_provider_unavailable');
    result = existing[0] ?? await cloudflareRequest(env, 'POST', '', { hostname: row.hostname, ssl: { method: 'http', type: 'dv' } });
  }
  const hostname = result as CloudflareHostname;
  if (!hostname || typeof hostname.id !== 'string' || !/^[a-z0-9-]{1,128}$/i.test(hostname.id) || hostname.hostname !== row.hostname) throw new Error('domain_provider_unavailable');
  return hostname;
}
export async function ingressTlsReady(row: ProjectDomainRow): Promise<boolean> {
  // Call only after every public A/AAAA answer is an explicitly configured ingress IP.
  try {
    const response = await fetch(`https://${row.hostname}/.well-known/mainbrella-domain-check`, { signal: AbortSignal.timeout(5000), redirect: 'manual' });
    if (!response.ok) return false;
    const bytes = await boundedPrivateBody(response.body, 256);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim() === row.challenge;
  } catch { return false; }
}
