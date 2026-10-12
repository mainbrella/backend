import { normalizeNetworkPolicy, normalizeSecretBindings, normalizeSecret, validSecretId, validSecretValue,
  secretMetadata, relayConfiguration, safeEgressHeaders, egressTarget, EGRESS_REQUEST_BYTES, EGRESS_RESPONSE_BYTES, EGRESS_TIMEOUT_MS } from './security-contract.js';
import { readFileBytes } from './file-contract.js';
import { requestEntitlement, validEntitlement } from './plan-policy.js';
import { validContainerId } from './container-account-core.js';
import { securityAccountEnabled } from './security-rollout.js';

const PREFIX = 'vault:';
const denied = () => Response.json({ error: 'egress_denied' }, { status: 403 });
export function base64(bytes) { let value = ''; for (let i = 0; i < bytes.length; i += 8192) value += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(value); }
const unbase64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
export const vaultConfigured = env => env.SECRETS_VAULT_ENABLED === 'true' && typeof env.SECRETS_ENCRYPTION_KEY === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(env.SECRETS_ENCRYPTION_KEY);
export const egressConfigured = env => env.EGRESS_POLICIES_ENABLED === 'true' && Boolean(relayConfiguration(env));

export class AccountSecurity {
  constructor(account, env, fetcher = fetch.bind(globalThis)) { Object.assign(this, { account, env, fetcher }); this.active = 0; }
  async key() { return crypto.subtle.importKey('raw', unbase64(this.env.SECRETS_ENCRYPTION_KEY), 'AES-GCM', false, ['encrypt', 'decrypt']); }
  async encrypt(owner, id, value) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`${owner}:${id}`) }, await this.key(), new TextEncoder().encode(value));
    return { iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext)) };
  }
  async decrypt(owner, record) {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(record.iv), additionalData: new TextEncoder().encode(`${owner}:${record.id}`) }, await this.key(), unbase64(record.ciphertext));
    return new TextDecoder().decode(plaintext);
  }
  async owner(userId) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId ?? '')) return false;
    const state = await this.account.ctx.storage.get('containerAccount'), owner = await this.account.ctx.storage.get('securityOwner');
    if (state && state.userId !== userId || owner && owner !== userId) return false;
    if (!owner) await this.account.ctx.storage.put('securityOwner', userId);
    return true;
  }
  // Caller holds account serialization. No secret values enter selection or the runtime.
  async validateSelection(state, selection) {
    if (selection.networkPolicy === undefined && !(selection.secretBindings?.length)) return null;
    if (!egressConfigured(this.env) || !securityAccountEnabled(this.env, state.userId)) return 'network_policy_unavailable';
    const policy = normalizeNetworkPolicy(selection.networkPolicy), ids = normalizeSecretBindings(selection.secretBindings ?? []);
    if (!policy || !ids || selection.internet === true) return 'invalid_network_policy';
    if (ids.length && !vaultConfigured(this.env)) return 'secrets_unavailable';
    const scopes = new Set();
    for (const id of ids) {
      const secret = await this.account.ctx.storage.get(PREFIX + id);
      if (!secret || secret.owner !== state.userId) return 'secret_not_found';
      const scope = secret.hostname + ':' + secret.header;
      if (scopes.has(scope)) return 'secret_binding_conflict';
      scopes.add(scope);
    }
    return null;
  }
  async fetch(request) {
    if (new URL(request.url).pathname === '/security/egress') return this.egress(request);
    const account = this.account, url = new URL(request.url), id = url.searchParams.get('secretId'), userId = request.headers.get('x-mainbrella-user');
    if (url.pathname !== '/secrets' || [...url.searchParams.keys()].some(k => k !== 'secretId') || url.searchParams.getAll('secretId').length > 1 || id && !validSecretId(id)) return account.respond({ error: 'invalid_request' }, 400);
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(request.method)) return account.respond({ error: 'method_not_allowed' }, 405);
    if (request.method === 'POST' && id || ['PUT', 'DELETE'].includes(request.method) && !id) return account.respond({ error: 'invalid_request' }, 400);
    let body;
    if (['POST', 'PUT'].includes(request.method)) {
      if (!vaultConfigured(this.env) || !securityAccountEnabled(this.env, userId)) return account.respond({ error: 'secrets_unavailable' }, 503);
      if (!validEntitlement(requestEntitlement(request, account.now()), account.now())) return account.respond({ error: 'subscription_required' }, 402);
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFileBytes(request.body, 8192, request.signal))); }
      catch { return account.respond({ error: 'invalid_request' }, 400); }
      if (request.method === 'POST') body = normalizeSecret(body);
      else if (!body || Object.keys(body).length !== 1 || !validSecretValue(body.value)) body = null;
      if (!body) return account.respond({ error: 'invalid_request' }, 400);
    }
    try { return await account.serialized(async () => {
      if (!await this.owner(userId)) return account.respond({ error: 'account_mismatch' }, 403);
      if (request.method === 'GET') {
        if (id) { const record = await account.ctx.storage.get(PREFIX + id); return record ? account.respond(secretMetadata(record)) : account.respond({ error: 'secret_not_found' }, 404); }
        const records = await account.ctx.storage.list({ prefix: PREFIX, limit: 101 });
        return account.respond({ secrets: [...records.values()].map(secretMetadata) });
      }
      if (request.method === 'DELETE') {
        await account.ctx.storage.delete(PREFIX + id);
        return account.respond({ deleted: true });
      }
      const now = new Date(account.now()).toISOString();
      if (request.method === 'PUT') {
        const record = await account.ctx.storage.get(PREFIX + id);
        if (!record) return account.respond({ error: 'secret_not_found' }, 404);
        Object.assign(record, await this.encrypt(userId, id, body.value), { updatedAt: now, version: crypto.randomUUID() });
        await account.ctx.storage.put(PREFIX + id, record);
        return account.respond(secretMetadata(record));
      }
      if ((await account.ctx.storage.list({ prefix: PREFIX, limit: 100 })).size >= 100) return account.respond({ error: 'secret_limit_exceeded' }, 409);
      const secretId = 'sec_' + crypto.randomUUID(), { value, ...metadata } = body;
      const record = { ...metadata, id: secretId, owner: userId, createdAt: now, updatedAt: now, version: crypto.randomUUID(), ...await this.encrypt(userId, secretId, value) };
      await account.ctx.storage.put(PREFIX + secretId, record);
      return account.respond(secretMetadata(record), 201);
    }); } catch { return account.respond({ error: 'secrets_unavailable' }, 503); }
  }
  async generation(userId, id, createdAt, incarnation, signal) {
    const state = await this.account.ctx.storage.get('containerAccount');
    if (!state || state.userId !== userId || !validEntitlement(state.entitlement, this.account.now())) return null;
    const response = await this.account.machineFor(userId, id).fetch(new Request('https://internal/security/status-v1', { signal,
      headers: { 'x-mainbrella-user': userId, 'x-mainbrella-container': id, 'x-egress-generation': createdAt, 'x-egress-incarnation': incarnation } }));
    if (!response.ok) return null;
    const result = JSON.parse(new TextDecoder().decode(await readFileBytes(response.body, 32768, signal)));
    return result.incarnation === incarnation && normalizeNetworkPolicy(result.networkPolicy) && normalizeSecretBindings(result.secretBindings ?? []) ? result : null;
  }
  async egress(request) {
    const userId = request.headers.get('x-mainbrella-user'), id = request.headers.get('x-egress-id'), createdAt = request.headers.get('x-egress-generation');
    const incarnation = request.headers.get('x-egress-incarnation');
    const target = egressTarget(request.headers.get('x-egress-url')), config = relayConfiguration(this.env);
    if (!egressConfigured(this.env) || !securityAccountEnabled(this.env, userId) || !config || !target || !validContainerId(id ?? '') || !/^[A-Za-z0-9_-]{1,128}$/.test(userId ?? '')
      || !createdAt || !Number.isFinite(Date.parse(createdAt)) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(incarnation ?? '') || !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(request.method)) return denied();
    if (this.active >= 2) return Response.json({ error: 'egress_limit_exceeded' }, { status: 429 });
    this.active++;
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(EGRESS_TIMEOUT_MS)]);
    try {
      const bytes = await readFileBytes(request.body, EGRESS_REQUEST_BYTES, signal);
      const admission = await this.account.serialized(async () => {
        const generation = await this.generation(userId, id, createdAt, incarnation, signal);
        if (!generation || signal.aborted) return null;
        const injections = [], versions = [];
        for (const secretId of generation.secretBindings ?? []) {
          if (!vaultConfigured(this.env)) return null;
          const record = await this.account.ctx.storage.get(PREFIX + secretId);
          // Deletion revokes the binding immediately, including its previously credentialed host.
          if (!record || record.owner !== userId) return null;
          versions.push([secretId, record.version]);
          if (target.protocol === 'https:' && target.hostname === record.hostname) injections.push({ header: record.header, prefix: record.prefix, value: await this.decrypt(userId, record) });
        }
        return { generation, injections, versions };
      });
      if (!admission || signal.aborted) return denied();
      const upstream = await this.fetcher(config.url.href, { method: 'POST', redirect: 'manual', signal,
        headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ version: 1, url: target.href, method: request.method, headers: [...safeEgressHeaders(request.headers)], body: base64(bytes),
          policy: admission.generation.networkPolicy, injections: admission.injections }) });
      const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFileBytes(upstream.body, Math.ceil(EGRESS_RESPONSE_BYTES * 4 / 3) + 65536, signal)));
      if (!upstream.ok || payload.version !== 1 || !Number.isInteger(payload.status) || payload.status < 200 || payload.status > 599 || payload.status >= 300 && payload.status < 400
        || typeof payload.body !== 'string' || !Array.isArray(payload.headers)) return denied();
      const body = unbase64(payload.body);
      if (body.byteLength > EGRESS_RESPONSE_BYTES) return denied();
      return await this.account.serialized(async () => {
        if (!egressConfigured(this.env) || !securityAccountEnabled(this.env, userId)
          || admission.versions.length && !vaultConfigured(this.env)) return denied();
        const current = await this.generation(userId, id, createdAt, incarnation, signal);
        if (signal.aborted || !current || JSON.stringify(current) !== JSON.stringify(admission.generation)) return denied();
        for (const [secretId, version] of admission.versions) if ((await this.account.ctx.storage.get(PREFIX + secretId))?.version !== version) return denied();
        const headers = safeEgressHeaders(new Headers(payload.headers)); headers.delete('set-cookie'); headers.set('cache-control', 'no-store');
        return new Response(request.method === 'HEAD' || [204, 205, 304].includes(payload.status) ? null : body, { status: payload.status, headers });
      });
    } catch { return Response.json({ error: 'egress_unavailable' }, { status: 502 }); }
    finally { this.active--; }
  }
}
