import { validPreviewPort } from './preview-contract.js';

export const MAX_PROJECT_BINDINGS = 32;
export const validProjectId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export const validProjectRevision = validProjectId;
export const validProjectBinding = body => Boolean(body && typeof body === 'object' && !Array.isArray(body)
  && Object.keys(body).length === 3 && Object.keys(body).every(key => ['id', 'revision', 'port'].includes(key))
  && validProjectId(body.id) && validProjectRevision(body.revision) && validPreviewPort(body.port));

export function validProjectOrigin(value, allowLocal = false) {
  // 'https://' plus the maximum 253-byte canonical DNS hostname.
  if (typeof value !== 'string' || value.length > 261) return false;
  try {
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password) return false;
    if (allowLocal && url.protocol === 'http:' && /^p-[a-f0-9]{32}\.localhost$/.test(url.hostname)
      && url.port && Number(url.port) <= 65535) return true;
    return url.protocol === 'https:' && !url.port && url.hostname.length <= 253
      && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(url.hostname)
      && url.hostname !== 'mainbrella.com' && !url.hostname.endsWith('.mainbrella.com');
  } catch { return false; }
}

// Keep app credentials, but never forward account credentials or platform
// attestations supplied by a browser. The gateway and runtime both apply this.
export function projectHeaders(input) {
  const headers = new Headers(input);
  const connection = (headers.get('connection') ?? '').split(',').map(value => value.trim().toLowerCase());
  for (const name of [...headers.keys()]) {
    if (/^x-(?:project|private|mainbrella|preview|exec|terminal|ssh)-/.test(name)
      || name.startsWith('cf-') || name.startsWith('x-forwarded-')
      || (connection.includes(name) && name !== 'upgrade')
      || ['host', 'forwarded', 'x-real-ip', 'proxy-authorization', 'proxy-authenticate', 'keep-alive',
        'te', 'trailer', 'transfer-encoding'].includes(name)) headers.delete(name);
  }
  if (/^(?:Bearer\s+)?mb_/i.test(headers.get('authorization') ?? '')) headers.delete('authorization');
  const cookies = (headers.get('cookie') ?? '').split(';').map(cookie => cookie.trim())
    .filter(cookie => cookie && cookie.split('=', 1)[0].trim().toLowerCase() !== 'mainbrella_session');
  if (cookies.length) headers.set('cookie', cookies.join('; '));
  else headers.delete('cookie');
  return headers;
}

export function projectResponseHeaders(input, output) {
  const cookies = typeof input.getSetCookie === 'function' ? input.getSetCookie() : input.get('set-cookie') ? [input.get('set-cookie')] : [];
  output.delete('set-cookie');
  for (const cookie of cookies) {
    // Normalize every app cookie to host-only. Apps cannot write parent-domain
    // cookies across project hosts, including siblings on the default domain.
    const parts = cookie.split(';');
    if (parts[0].split('=', 1)[0].trim().toLowerCase() === 'mainbrella_session') continue;
    output.append('set-cookie', parts.filter((part, i) => i === 0 || !/^\s*domain\s*=/i.test(part)).join(';'));
  }
}
