import { UserContainerController } from '../containers/user-container-core.js';
import { ManagedExecutions } from '../containers/executions.js';
import { WorkloadWebhooks } from '../containers/webhooks.js';
import { RECEIVER_LIFETIME_MS } from './webhook-receiver-core.mjs';

const receiver = 'https://mainbrella-webhook-qualification.crimson-dust-553b.workers.dev';
const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
export class OutboxProbe {
  constructor(ctx, env) {
    this.ctx = ctx;
    // No native container binding or customer account. Only the lifecycle adapter is synthetic.
    this.container = { running: false, async setInactivityTimeout() {}, async destroy() { this.running = false; } };
    this.controller = new UserContainerController({ storage: ctx.storage, container: this.container });
    this.executions = new ManagedExecutions(this.controller, new Set(), ctx);
    this.webhooks = new WorkloadWebhooks(this.controller, env);
    this.fetchDiagnostics = { calls: 0, failures: {} };
    const diagnostics = this.fetchDiagnostics, transport = this.webhooks.fetcher;
    this.webhooks.fetcher = async function (...args) {
      diagnostics.calls++;
      try { return await transport.call(this, ...args); }
      catch (error) {
        // Fixed categories only: never persist exception text, URLs, bodies or credentials.
        const message = String(error?.message ?? '');
        const category = /illegal invocation|incorrect this/i.test(message) ? 'illegal_invocation'
          : /redirect/i.test(message) ? 'unsupported_redirect' : /signal/i.test(message) ? 'signal_error'
          : /credentials/i.test(message) ? 'unsupported_credentials' : /1042|same zone|same account/i.test(message) ? 'worker_routing'
          : /network|connection|load|dns|resolve/i.test(message) ? 'network_error'
          : /abort|timeout/i.test(message) ? 'aborted' : error?.name === 'TypeError' ? 'type_error' : 'transport_error';
        diagnostics.failures[category] = (diagnostics.failures[category] ?? 0) + 1; throw error;
      }
    };
    this.controller.webhooks = this.webhooks;
    this.controller.observations.onAppend = event => this.webhooks.enqueue(event);
    this.webhooks.onChange = () => ctx.waitUntil(this.executions.scheduleCleanup().catch(() => { this.scheduleFailed = true; }));
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const metadata = await ctx.storage.get('builderMachine');
      this.container.running = Boolean(metadata && metadata.computeStoppedAt === undefined);
      await this.executions.recover();
    });
  }
  async fetch(request, runId) {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(runId ?? '')) return json({ error: 'invalid_request' }, 400);
    await this.ready;
    const url = new URL(request.url);
    const expiresAt = await this.ctx.storage.get('probeExpiresAt');
    if (expiresAt && expiresAt <= Date.now()) { await this.erase(); return json({ error: 'expired' }, 404); }
    if (url.pathname === '/delete' && request.method === 'DELETE') { await this.erase(); return json({ removed: true }); }
    if (url.pathname === '/setup' && request.method === 'POST') {
      if (expiresAt) return json({ error: 'already_used' }, 409);
      const now = Date.now(), metadata = { createdAt: now, expiresAt: now + RECEIVER_LIFETIME_MS, idleExpiresAt: now + RECEIVER_LIFETIME_MS, size: 'lite' };
      await this.ctx.storage.put('probeExpiresAt', metadata.expiresAt);
      await this.ctx.storage.put('builderMachine', metadata);
      await this.ctx.storage.put('machineEntitlement', { active: true, plan: 'builder', checkedAt: now, validUntil: metadata.expiresAt });
      this.container.running = true;
      await this.controller.observations.append(metadata, 'starting'); await this.controller.observations.append(metadata, 'started');
      const internal = new Request('https://internal/observations/webhook', { method: 'PUT', headers: { 'x-exec-container-id': 'small',
        'x-exec-created-at': new Date(now).toISOString(), 'x-exec-expires-at': String(metadata.expiresAt) },
        body: JSON.stringify({ url: `${receiver}/receive/${runId}`, replayFromCursor: 0 }) });
      const response = await this.webhooks.fetch(internal);
      const config = await response.json();
      if (!response.ok) return json({ error: 'setup_failed' }, 503);
      return json({ signingSecret: config.signingSecret, container: { id: 'small', createdAt: new Date(now).toISOString() }, expiresAt: metadata.expiresAt });
    }
    if (!expiresAt) return json({ error: 'not_found' }, 404);
    if (url.pathname === '/tick' && request.method === 'POST') await this.webhooks.tick();
    else if (url.pathname === '/stop' && request.method === 'POST') {
      const metadata = await this.ctx.storage.get('builderMachine'); this.container.running = false;
      await this.controller.observePlatformStop(metadata.createdAt);
    } else if (url.pathname !== '/status' || request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    const metadata = await this.ctx.storage.get('builderMachine');
    const response = await this.webhooks.fetch(new Request('https://internal/observations/webhook/deliveries', {
      headers: { 'x-exec-container-id': 'small', 'x-exec-created-at': new Date(metadata.createdAt).toISOString() } }));
    return json({ ...(await response.json()), alarmAt: await this.ctx.storage.getAlarm(), scheduleFailed: Boolean(this.scheduleFailed),
      fetchDiagnostics: this.fetchDiagnostics, signalAnySupported: typeof AbortSignal.any === 'function',
      alarmsObserved: await this.ctx.storage.get('probeAlarms') ?? 0 });
  }
  async alarm() {
    await this.ready;
    const expiresAt = await this.ctx.storage.get('probeExpiresAt');
    if (!expiresAt || expiresAt <= Date.now()) { await this.erase(); return; }
    await this.ctx.storage.put('probeAlarms', (await this.ctx.storage.get('probeAlarms') ?? 0) + 1);
    // Same sequence and scheduler as the deployed private runtime.
    await this.controller.alarm(); await this.executions.prune(); await this.controller.observations.prune();
    await this.webhooks.tick(); await this.executions.scheduleCleanup();
  }
  async erase() { this.container.running = false; await this.ctx.storage.deleteAll(); await this.ctx.storage.deleteAlarm(); }
}
export function outboxProbeRoute(request, env) {
  const url = new URL(request.url), match = /^\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/(setup|status|tick|stop|delete)$/.exec(url.pathname);
  if (!match || url.search) return json({ error: 'not_found' }, 404);
  if (!/^[a-f0-9]{64}$/.test(env.QUALIFICATION_RECEIVER_TOKEN ?? '')
    || request.headers.get('Authorization') !== `Bearer ${env.QUALIFICATION_RECEIVER_TOKEN}`) return json({ error: 'not_authenticated' }, 401);
  url.pathname = `/${match[2]}`;
  const internal = new Request(url, request); internal.headers.set('x-probe-run-id', match[1]);
  return env.OUTBOX.get(env.OUTBOX.idFromName(match[1])).fetch(internal);
}
