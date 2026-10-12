import { DurableObject } from 'cloudflare:workers';
import { readFileBytes } from '../containers/file-contract.js';
import { createSecurityInfrastructureApp } from './app/openapi';
import { handleSecurityAcknowledgment } from './app/security-ack';
import { infrastructureError, operatorAuthorized } from './lib/security-infrastructure';

type State = { token: string; version: number; expiresAt: number; runId: string };
export class SecurityAcknowledgment extends DurableObject<Env> {
  private pending?: { release: () => void };
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url), parts = url.pathname.split('/'), runId = parts[2], action = parts[3];
    const state = await this.ctx.storage.get<State>('run');
    const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
    if (parts[1] === 'control') {
      // Recheck on the private object boundary as well as the public Worker.
      if (!await operatorAuthorized(request, this.env.SECURITY_ACK_CONTROL_TOKEN)) return infrastructureError('not_authorized', 403);
      if (action === 'release' && request.method === 'POST') { this.pending?.release(); return reply({ released: true }); }
      if (action) return infrastructureError('not_found', 404);
      if (request.method === 'GET') return reply({ exists: !!state, version: state?.version ?? 0, pending: !!this.pending });
      if (request.method === 'DELETE') { this.pending?.release(); await this.ctx.storage.deleteAll(); return reply({ deleted: true }); }
      if (!['POST', 'PUT'].includes(request.method)) return infrastructureError('invalid_request', 400);
      if (request.method === 'PUT' && !state) return infrastructureError('not_found', 404);
      if (request.method === 'POST' && state) return infrastructureError('already_exists', 409);
      let body: { value?: unknown };
      try { body = JSON.parse(new TextDecoder().decode(await readFileBytes(request.body, 4096))); }
      catch { return infrastructureError('invalid_request', 400); }
      if (!body || Object.keys(body).some(key => key !== 'value') || typeof body.value !== 'string' || !/^[a-f0-9]{64}$/.test(body.value)) return infrastructureError('invalid_request', 400);
      const next: State = { token: body.value, version: (state?.version ?? 0) + 1, runId, expiresAt: Date.now() + 15 * 60_000 };
      await this.ctx.storage.put('run', next); await this.ctx.storage.setAlarm(next.expiresAt);
      return reply({ configured: true, version: next.version });
    }
    if (request.method !== 'GET' || !state || state.expiresAt <= Date.now()) return infrastructureError('not_found', 404);
    const authenticated = await operatorAuthorized(request, state.token);
    const internalHeaders = [...request.headers.keys()].some(name => /^(x-egress-|x-mainbrella-)/.test(name));
    const acknowledgment = { fixture: 'rodeo-security', runId, authenticated, version: state.version, internalHeaders };
    if (action === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://api.mainbrella.com/capabilities' } });
    if (action === 'reflect') return new Response(request.headers.get('Authorization') ?? '');
    if (action === 'reflect-base64') return new Response(btoa(state.token));
    if (action === 'reflect-header') return new Response('ok', { headers: { 'x-reflection': state.token } });
    if (action === 'slow') {
      if (this.pending) return infrastructureError('busy', 409);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await new Promise<void>(resolve => { this.pending = { release: resolve }; timer = setTimeout(resolve, 15_000); }); }
      finally { clearTimeout(timer); this.pending = undefined; }
      return reply(acknowledgment);
    }
    if (!['public', 'auth'].includes(action)) return infrastructureError('not_found', 404);
    return Response.json(acknowledgment, { headers: { 'Cache-Control': 'no-store', 'Set-Cookie': 'fixture=discard' } });
  }
  async alarm(): Promise<void> { this.pending?.release(); await this.ctx.storage.deleteAll(); }
}
const app = createSecurityInfrastructureApp('ack', handleSecurityAcknowledgment);
export default { fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx) };
