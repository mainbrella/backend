export const MAX_SECRET_BYTES = 4096;
export const EGRESS_REQUEST_BYTES = 4 * 1024 * 1024;
export const EGRESS_RESPONSE_BYTES = 8 * 1024 * 1024;
export const EGRESS_TIMEOUT_MS = 30_000;
export const validSecretId = value => typeof value === 'string' && /^sec_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);

export function ipAddress(value) {
  if (typeof value !== 'string') return null;
  value = value.replace(/^\[|\]$/g, '').toLowerCase();
  if (/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) {
    const parts = value.split('.').map(Number);
    return parts.every(n => n < 256) ? { bits: 32, value: parts.reduce((n, p) => (n << 8n) | BigInt(p), 0n) } : null;
  }
  if (!value.includes(':') || /[^a-f\d:.]/.test(value)) return null;
  if (value.includes('.')) {
    const tail = value.slice(value.lastIndexOf(':') + 1), v4 = ipAddress(tail);
    if (!v4 || v4.bits !== 32) return null;
    value = value.slice(0, -tail.length) + (v4.value >> 16n).toString(16) + ':' + (v4.value & 65535n).toString(16);
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [], right = halves[1] ? halves[1].split(':') : [];
  if ([...left, ...right].some(p => !/^[a-f\d]{1,4}$/.test(p))) return null;
  if (halves.length === 1 && left.length !== 8 || halves.length === 2 && left.length + right.length >= 8) return null;
  const parts = halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return { bits: 128, value: parts.reduce((n, p) => (n << 16n) | BigInt('0x' + p), 0n) };
}
export function inCidr(address, rule) {
  const ip = typeof address === 'string' ? ipAddress(address) : address;
  const [base, rawPrefix] = rule.split('/'), network = ipAddress(base);
  if (!ip || !network || ip.bits !== network.bits) return false;
  const prefix = rawPrefix === undefined ? network.bits : Number(rawPrefix);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > ip.bits) return false;
  const shift = BigInt(ip.bits - prefix);
  return (ip.value >> shift) === (network.value >> shift);
}
export function publicAddress(address) {
  const ip = ipAddress(address);
  if (!ip) return false;
  if (ip.bits === 32) return !['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/3'].some(rule => inCidr(ip, rule));
  return inCidr(ip, '2000::/3') && !['2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20'].some(rule => inCidr(ip, rule));
}
export function publicHostname(value) {
  return typeof value === 'string' && value.length <= 253 && value === value.toLowerCase()
    && /^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z](?:[a-z\d-]{0,61}[a-z\d])?$/.test(value)
    && !/(?:^|\.)(?:localhost|local|internal|invalid|test|example|onion)$/.test(value);
}
function normalizeRule(value) {
  if (typeof value !== 'string' || value !== value.trim()) return null;
  value = value.toLowerCase();
  if (value === '*') return value;
  const [address, prefix, extra] = value.split('/'), ip = ipAddress(address);
  if (ip) {
    if (extra !== undefined || prefix !== undefined && (!/^\d{1,3}$/.test(prefix) || Number(prefix) > ip.bits)) return null;
    const size = prefix === undefined ? ip.bits : Number(prefix), shift = BigInt(ip.bits - size);
    const masked = (ip.value >> shift) << shift;
    const canonical = ip.bits === 32 ? [24n, 16n, 8n, 0n].map(n => Number((masked >> n) & 255n)).join('.')
      : Array.from({ length: 8 }, (_, i) => ((masked >> BigInt(112 - i * 16)) & 65535n).toString(16)).join(':');
    return `${canonical}/${size}`;
  }
  return publicHostname(value.startsWith('*.') ? value.slice(2) : value) ? value : null;
}
export function normalizeNetworkPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['allow', 'deny'].includes(k))) return null;
  const result = {};
  for (const name of ['allow', 'deny']) {
    const entries = value[name] ?? (name === 'deny' ? [] : null);
    if (!Array.isArray(entries) || entries.length > 64) return null;
    const rules = entries.map(normalizeRule);
    if (rules.some(rule => rule === null)) return null;
    result[name] = [...new Set(rules)].sort();
  }
  return result;
}
export function normalizeSecretBindings(value) {
  return Array.isArray(value) && value.length <= 16 && value.every(validSecretId) ? [...new Set(value)].sort() : null;
}
function hostnameMatches(hostname, rule) { return rule === '*' || rule === hostname || rule.startsWith('*.') && hostname.endsWith(rule.slice(1)) && hostname !== rule.slice(2); }
export function targetAllowed(policy, hostname, address) {
  const match = rule => rule.includes('/') ? address && inCidr(address, rule) : hostnameMatches(hostname, rule);
  return !policy.deny.some(match) && policy.allow.some(match);
}
export function egressTarget(value) {
  try {
    const url = new URL(value), hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.port
      || !(publicHostname(hostname) || publicAddress(hostname))) return null;
    return url;
  } catch { return null; }
}
export function normalizeSecret(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['name', 'value', 'hostname', 'header', 'prefix'].includes(k))) return null;
  const hostname = typeof value.hostname === 'string' ? value.hostname.toLowerCase() : '', header = typeof value.header === 'string' ? value.header.toLowerCase() : '', prefix = value.prefix ?? '';
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 80 || /[\x00-\x1f\x7f]/.test(value.name)
    || !validSecretValue(value.value) || !publicHostname(hostname) || !['authorization', 'x-api-key', 'api-key'].includes(header)
    || typeof prefix !== 'string' || prefix.length > 32 || /[^\x20-\x7e]/.test(prefix)) return null;
  return { name: value.name.trim(), hostname, header, prefix, value: value.value };
}
export const validSecretValue = value => typeof value === 'string' && /^[\x21-\x7e]+$/.test(value) && value.length <= MAX_SECRET_BYTES;
export function secretMetadata(record) {
  const { id, name, hostname, header, prefix, createdAt, updatedAt } = record;
  return { id, name, hostname, header, prefix, createdAt, updatedAt };
}
export function relayConfiguration(env) {
  const url = egressTarget(env.EGRESS_RELAY_URL);
  return url?.protocol === 'https:' && !url.search && typeof env.EGRESS_RELAY_TOKEN === 'string' && /^[\x21-\x7e]{32,256}$/.test(env.EGRESS_RELAY_TOKEN) ? { url, token: env.EGRESS_RELAY_TOKEN } : null;
}
export const safeEgressHeaders = headers => new Headers([...headers].filter(([name]) => !/^(?:host|connection|keep-alive|transfer-encoding|te|trailer|upgrade|proxy-.*|forwarded|x-forwarded-.*|x-mainbrella-.*|x-egress-.*|cf-.*|content-length|accept-encoding)$/i.test(name)));
