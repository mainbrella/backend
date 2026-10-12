import { normalizeNetworkPolicy, normalizeSecretBindings, safeEgressHeaders, EGRESS_TIMEOUT_MS, EGRESS_REQUEST_BYTES } from './security-contract.js';
import { readFileBytes } from './file-contract.js';
import { securityAccountEnabled } from './security-rollout.js';
export const EGRESS_CA_ENV = Object.freeze(Object.fromEntries(['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO'].map(name => [name, '/etc/cloudflare/certs/cloudflare-containers-ca.crt'])));

export async function relayContainerEgress(request, env, props) {
  if (!env.CONTAINER_ACCOUNT || !props || !securityAccountEnabled(env, props.userId) || !/^[A-Za-z0-9_-]{1,128}$/.test(props.userId ?? '') || !/^(?:small|c[1-9]\d{0,2})$/.test(props.id ?? '') || !Number.isFinite(Date.parse(props.createdAt)) || typeof props.incarnation !== 'string') return Response.json({ error: 'egress_denied' }, { status: 403 });
  try {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(EGRESS_TIMEOUT_MS)]), headers = safeEgressHeaders(request.headers);
    headers.set('x-mainbrella-user', props.userId); headers.set('x-egress-id', props.id); headers.set('x-egress-generation', props.createdAt); headers.set('x-egress-url', request.url);
    headers.set('x-egress-incarnation', props.incarnation);
    const bytes = await readFileBytes(request.body, EGRESS_REQUEST_BYTES, signal);
    return await env.CONTAINER_ACCOUNT.get(env.CONTAINER_ACCOUNT.idFromName(`account:${props.userId}`)).fetch(new Request('https://internal/security/egress', {
      method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : bytes, signal, redirect: 'manual',
    }));
  } catch { return Response.json({ error: 'egress_unavailable' }, { status: 502 }); }
}

export class ContainerSecurity {
  constructor(controller, env, entrypoint) { Object.assign(this, { controller, env, entrypoint }); }
  available() { const c = this.controller.container; return this.env.EGRESS_POLICIES_ENABLED === 'true' && typeof c.interceptAllOutboundHttp === 'function' && typeof c.interceptOutboundHttps === 'function'; }
  async install(metadata) {
    if (!metadata.networkPolicy) return;
    if (!this.available()) throw new Error('network_policy_unavailable');
    const owner = await this.controller.ctx.storage.get('activityOwner');
    if (!owner || !securityAccountEnabled(this.env, owner.userId)) throw new Error('network_policy_unavailable');
    const binding = this.entrypoint({ userId: owner.userId, id: owner.containerId, createdAt: new Date(metadata.createdAt).toISOString(), incarnation: metadata.telemetryId });
    await this.controller.container.interceptAllOutboundHttp(binding);
    await this.controller.container.interceptOutboundHttps('*', binding);
  }
  async restore() {
    const metadata = await this.controller.ctx.storage.get('builderMachine');
    if (metadata?.networkPolicy) {
      try { await this.install(metadata); }
      catch { await this.controller.destroy('Network policy unavailable after runtime restart'); throw new Error('network_policy_unavailable'); }
    }
  }
  async status(request) {
    const c = this.controller;
    // Read without the start lock: a production entrypoint can make an outbound
    // request during readiness. Every response is fenced again by the account.
      const metadata = await c.ctx.storage.get('builderMachine');
      const owner = await c.ctx.storage.get('activityOwner');
      if (request.method !== 'GET' || !this.available() || !securityAccountEnabled(this.env, owner?.userId) || !metadata || !c.container.running || !await c.hasPaidAccess() || c.now() >= c.deadline(metadata)
        || new Date(metadata.createdAt).toISOString() !== request.headers.get('x-egress-generation') || !normalizeNetworkPolicy(metadata.networkPolicy)
        || metadata.telemetryId !== request.headers.get('x-egress-incarnation')
        || !normalizeSecretBindings(metadata.secretBindings ?? [])) return c.respond({ error: 'egress_denied' }, 403);
      const revoked = await c.ctx.storage.get('revokedEgressGeneration'), current = await c.ctx.storage.get('builderMachine');
      if (!c.container.running || current?.telemetryId !== metadata.telemetryId || revoked === metadata.telemetryId) return c.respond({ error: 'egress_denied' }, 403);
      return c.respond({ networkPolicy: metadata.networkPolicy, secretBindings: metadata.secretBindings ?? [], incarnation: metadata.telemetryId });
  }
}
