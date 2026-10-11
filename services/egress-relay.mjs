// Operator service. Run behind an HTTPS ingress; bind loopback by default.
// No credentials or guest bodies are written to logs or disk.
import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { normalizeNetworkPolicy, publicAddress, ipAddress, targetAllowed, egressTarget, safeEgressHeaders,
  validSecretValue, EGRESS_REQUEST_BYTES, EGRESS_RESPONSE_BYTES, EGRESS_TIMEOUT_MS } from '../containers/security-contract.js';

const fail = () => { throw new Error('egress_denied'); };
const MAX_ENVELOPE = Math.ceil(EGRESS_REQUEST_BYTES * 4 / 3) + 131072;
const MAX_HEADERS = 32768;
async function bounded(stream, limit) {
  const parts = []; let size = 0;
  for await (const chunk of stream) { size += chunk.length; if (size > limit) { stream.destroy(); fail(); } parts.push(chunk); }
  return Buffer.concat(parts, size);
}
async function abortable(operation, signal) {
  if (signal?.aborted) fail();
  if (!signal) return operation;
  let abort;
  const canceled = new Promise((_, reject) => { abort = () => reject(new Error('egress_denied')); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([operation, canceled]); }
  finally { signal.removeEventListener('abort', abort); }
}
export async function resolveTarget(target, policy, resolver = lookup, signal) {
  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  const literal = ipAddress(hostname);
  // Resolving a denied name would itself provide a DNS exfiltration channel.
  // CIDR-only grants authorize literal addresses; hostnames require a matching
  // domain grant before any lookup. Resolved addresses still face CIDR denies.
  if (!literal && !targetAllowed(policy, hostname)) fail();
  const records = literal ? [{ address: hostname, family: literal.bits === 32 ? 4 : 6 }] : await abortable(Promise.resolve(resolver(hostname, { all: true, verbatim: true })), signal);
  // Check every answer and pin one. Never let the HTTP client resolve it again.
  // Denying the entire mixed answer also prevents IPv4/IPv6 fallback bypass.
  if (!records.length || records.length > 64 || records.some(record => !publicAddress(record.address) || !targetAllowed(policy, hostname, record.address))) fail();
  return records[0];
}
export function pinnedRequest(target, address, options, bytes, signal) {
  return new Promise((resolve, reject) => {
    const hostname = target.hostname.replace(/^\[|\]$/g, '');
    const outgoing = (target.protocol === 'https:' ? https : http).request(target, {
      ...options, signal, agent: false, maxHeaderSize: MAX_HEADERS,
      // URL hostname still controls Host, SNI and certificate verification.
      servername: ipAddress(hostname) ? undefined : hostname, rejectUnauthorized: true,
      lookup: (_name, lookupOptions, callback) => lookupOptions.all
        ? callback(null, [address]) : callback(null, address.address, address.family),
    }, response => resolve(response));
    outgoing.on('error', reject);
    outgoing.end(bytes);
  });
}
function validEnvelope(value) {
  if (!value || value.version !== 1 || typeof value.body !== 'string' || value.body.length > Math.ceil(EGRESS_REQUEST_BYTES * 4 / 3)
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.body)
    || !Array.isArray(value.headers) || value.headers.length > 128 || JSON.stringify(value.headers).length > MAX_HEADERS
    || value.headers.some(h => !Array.isArray(h) || h.length !== 2 || h.some(v => typeof v !== 'string'))
    || !Array.isArray(value.injections) || value.injections.length > 16
    || !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(value.method)) return false;
  return value.injections.every(injection => injection && ['authorization', 'x-api-key', 'api-key'].includes(injection.header)
    && validSecretValue(injection.value) && typeof injection.prefix === 'string' && injection.prefix.length <= 32 && !/[^\x20-\x7e]/.test(injection.prefix));
}
function reflected(bytes, headers, injections) {
  const fields = Buffer.concat([bytes, Buffer.from(JSON.stringify(headers))]);
  return injections.some(({ value, prefix }) => [value, prefix + value, encodeURIComponent(value), Buffer.from(value).toString('base64'),
    JSON.stringify(value).slice(1, -1)].some(candidate => fields.includes(Buffer.from(candidate))));
}
export async function forwardEnvelope(envelope, { resolver = lookup, transport = pinnedRequest, signal = AbortSignal.timeout(EGRESS_TIMEOUT_MS) } = {}) {
  const target = egressTarget(envelope?.url), policy = normalizeNetworkPolicy(envelope?.policy);
  if (!target || !policy || !validEnvelope(envelope) || envelope.injections.length && target.protocol !== 'https:') fail();
  const body = Buffer.from(envelope.body, 'base64');
  if (body.length > EGRESS_REQUEST_BYTES || ['GET', 'HEAD'].includes(envelope.method) && body.length) fail();
  const headers = safeEgressHeaders(new Headers(envelope.headers));
  headers.set('accept-encoding', 'identity');
  for (const injection of envelope.injections) headers.set(injection.header, injection.prefix + injection.value);
  const address = await resolveTarget(target, policy, resolver, signal);
  if (signal.aborted) fail();
  const response = await transport(target, address, { method: envelope.method, headers: Object.fromEntries(headers) }, body, signal);
  if (!Number.isInteger(response.statusCode) || response.statusCode < 200 || response.statusCode > 599 || response.statusCode >= 300 && response.statusCode < 400
    || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') { response.destroy(); fail(); }
  const bytes = await bounded(response, EGRESS_RESPONSE_BYTES);
  const returnedHeaders = Object.entries(response.headers).flatMap(([name, value]) => value === undefined ? [] : (Array.isArray(value) ? value : [value]).map(v => [name, v]));
  // Reflection defense is conservative and intentionally blocks literal, URL,
  // JSON and base64 forms. A malicious upstream can transform its credentials;
  // choose a scoped, trusted upstream and never claim unextractability.
  if (reflected(bytes, returnedHeaders, envelope.injections)) fail();
  const safeHeaders = safeEgressHeaders(new Headers(returnedHeaders)); safeHeaders.delete('set-cookie'); safeHeaders.set('cache-control', 'no-store');
  return { version: 1, status: response.statusCode, headers: [...safeHeaders], body: bytes.toString('base64') };
}
export function createRelay({ token, resolver, transport, maxConcurrent = 8 } = {}) {
  if (typeof token !== 'string' || !/^[\x21-\x7e]{32,256}$/.test(token)) throw new Error('EGRESS_RELAY_TOKEN must be 32–256 printable non-space characters');
  let active = 0;
  const expected = Buffer.from(`Bearer ${token}`);
  const server = http.createServer({ maxHeaderSize: MAX_HEADERS }, async (request, response) => {
    const received = Buffer.from(request.headers.authorization ?? '');
    const reply = (status, body) => { if (!response.destroyed) { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); } };
    if (request.method !== 'POST' || request.url !== '/v1/egress' || received.length !== expected.length || !timingSafeEqual(received, expected)) { reply(403, { error: 'egress_denied' }); request.resume(); return; }
    if (active >= maxConcurrent) { reply(503, { error: 'egress_busy' }); request.resume(); return; }
    active++;
    const abort = new AbortController(), timer = setTimeout(() => { abort.abort(); request.destroy(); }, EGRESS_TIMEOUT_MS);
    request.on('aborted', () => abort.abort()); response.on('close', () => { if (!response.writableFinished) abort.abort(); });
    try {
      const envelope = JSON.parse((await bounded(request, MAX_ENVELOPE)).toString('utf8'));
      const result = await forwardEnvelope(envelope, { resolver, transport, signal: abort.signal });
      reply(200, result);
    } catch { reply(403, { error: 'egress_denied' }); }
    finally { clearTimeout(timer); active--; }
  });
  server.requestTimeout = EGRESS_TIMEOUT_MS;
  server.headersTimeout = 10000;
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createRelay({ token: process.env.EGRESS_RELAY_TOKEN });
  server.listen(Number(process.env.EGRESS_RELAY_PORT ?? 8081), process.env.EGRESS_RELAY_BIND ?? '127.0.0.1');
}
