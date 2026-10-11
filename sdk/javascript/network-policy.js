// Portable comparison of the API's normalized domain and CIDR rules.
function ipAddress(value) {
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

function publicHostname(value) {
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
