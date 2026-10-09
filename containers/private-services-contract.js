export const MAX_PRIVATE_NETWORKS = 16;
export const MAX_PRIVATE_MEMBERS = 32;
export const MAX_PRIVATE_BYTES = 1024 * 1024;
export const PRIVATE_TIMEOUT_MS = 10_000;
export const validServiceName = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,62}$/.test(value);
export const validPrivateGeneration = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export const validPrivatePort = value => Number.isInteger(value) && value >= 1024 && value <= 65535;
export const validPrivateMember = value => Boolean(value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => ['id', 'createdAt', 'name', 'port'].includes(key))
  && typeof value.id === 'string' && validPrivateGeneration(value.createdAt) && validServiceName(value.name)
  && (value.port === undefined || validPrivatePort(value.port)));
export function privateTarget(request) {
  const url = new URL(request.url);
  const name = url.hostname.endsWith('.internal') ? url.hostname.slice(0, -9) : null;
  return url.protocol === 'http:' && !url.port && !url.username && !url.password && validServiceName(name)
    && !request.headers.has('upgrade') && request.method !== 'CONNECT' ? { url, name } : null;
}
export function privateHeaders(input) {
  const headers = new Headers(input);
  const connection = (headers.get('connection') ?? '').split(',').map(value => value.trim().toLowerCase());
  for (const name of [...headers.keys()]) {
    if (/^x-(mainbrella|private|preview|exec|terminal|ssh)-/.test(name)
      || connection.includes(name) || ['host', 'forwarded', 'x-forwarded-host', 'x-forwarded-for', 'x-forwarded-proto',
        'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'].includes(name)) headers.delete(name);
  }
  return headers;
}
export async function boundedPrivateBody(body, limit = MAX_PRIVATE_BYTES, signal) {
  signal?.throwIfAborted();
  if (!body) return undefined;
  const reader = body.getReader(), chunks = [];
  let onAbort;
  const aborted = signal && new Promise((_, reject) => {
    onAbort = () => {
      reject(signal.reason ?? new Error('private_service_timeout'));
      void reader.cancel(signal.reason).catch(() => {});
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await (aborted ? Promise.race([reader.read(), aborted]) : reader.read());
      signal?.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error('request_too_large');
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    void reader.cancel().catch(() => {}); reader.releaseLock();
  }
}

// No query preserves the original complete-registry response for existing clients.
export function privateNetworkQuery(params) {
  if ([...params.keys()].some(key => !['search', 'page', 'limit', 'lifecycle'].includes(key))
    || [...new Set(params.keys())].some(key => params.getAll(key).length !== 1)) return null;
  const search = (params.get('search') ?? '').trim();
  const page = params.get('page') ?? '1', limit = params.get('limit') ?? '10';
  const lifecycle = params.get('lifecycle');
  if (lifecycle !== null && !['ad_hoc', 'production'].includes(lifecycle)) return null;
  if (search.length > 63 || !/^[1-9][0-9]*$/.test(page) || !/^[1-9][0-9]*$/.test(limit)
    || !Number.isSafeInteger(Number(page)) || Number(limit) > 100) return null;
  return { ...(lifecycle ? { lifecycle } : {}), search: search.toLowerCase(), page: Number(page), limit: Number(limit) };
}
