import { readFileBytes } from '../containers/file-contract.js';
import { verifyWebhookSignature } from '../sdk/javascript/index.js';

export const RECEIVER_LIFETIME_MS = 10 * 60_000;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const same = (a, b) => a?.id === b?.id && a?.createdAt === b?.createdAt;
const canonical = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');

// Temporary receiver only. No forwarding, guest access, arbitrary URLs or customer delivery service.
export class QualificationReceiver {
  constructor(storage, env, now = Date.now) { Object.assign(this, { storage, env, now }); }
  async fetch(request) {
    const url = new URL(request.url), admin = url.pathname === '/admin';
    if (!['/admin', '/receive'].includes(url.pathname) || url.search) return json({ error: 'not_found' }, 404);
    if (admin && (!/^[a-f0-9]{64}$/.test(this.env.QUALIFICATION_RECEIVER_TOKEN ?? '')
      || request.headers.get('Authorization') !== `Bearer ${this.env.QUALIFICATION_RECEIVER_TOKEN}`)) return json({ error: 'not_authenticated' }, 401);
    let state = await this.storage.get('run');
    if (state && state.expiresAt <= this.now()) { await this.storage.deleteAll(); state = undefined; }
    if (admin && request.method === 'DELETE') { await this.storage.deleteAll(); await this.storage.deleteAlarm(); return json({ removed: true }); }
    if (admin && request.method === 'GET') {
      if (!state) return json({ error: 'not_found' }, 404);
      return json({ expiresAt: state.expiresAt, received: state.received, invalidSignatures: state.invalidSignatures,
        transientFailures: state.transientFailures, duplicates: state.duplicates, outOfOrder: state.outOfOrder, events: state.events });
    }
    if (admin && request.method === 'PUT') {
      let body;
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFileBytes(request.body, 4096, request.signal))); }
      catch { return json({ error: 'invalid_request' }, 400); }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['signingSecret', 'container', 'failFirst'].includes(key))
        || !/^mbwh_[a-f0-9]{64}$/.test(body.signingSecret ?? '') || !/^(small|c[1-9]\d{0,2})$/.test(body.container?.id ?? '')
        || !canonical(body.container?.createdAt) || Object.keys(body.container).some(key => !['id', 'createdAt'].includes(key))
        || typeof body.failFirst !== 'boolean' || state && !same(state.container, body.container)) return json({ error: 'invalid_request' }, 400);
      const expiresAt = state?.expiresAt ?? this.now() + RECEIVER_LIFETIME_MS;
      state = { signingSecret: body.signingSecret, container: body.container, expiresAt, failFirst: body.failFirst,
        received: 0, invalidSignatures: 0, transientFailures: 0, duplicates: 0, outOfOrder: 0, highestSequence: 0, events: [] };
      await this.storage.put('run', state); await this.storage.setAlarm(expiresAt);
      return json({ configured: true, expiresAt });
    }
    if (admin || request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!state) return json({ error: 'not_found' }, 404);
    let bytes;
    try { bytes = await readFileBytes(request.body, 4096, request.signal); }
    catch { return json({ error: 'invalid_request' }, 400); }
    if (!await verifyWebhookSignature(bytes, request.headers.get('Mainbrella-Signature'), state.signingSecret, { nowMs: this.now() })) {
      state.invalidSignatures = Math.min(state.invalidSignatures + 1, 1000); await this.storage.put('run', state);
      return json({ error: 'invalid_signature' }, 401);
    }
    let body;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return json({ error: 'invalid_request' }, 400); }
    if (!uuid.test(body?.id ?? '') || body.id !== request.headers.get('Mainbrella-Event-Id')
      || !same(body.container, state.container) || !Number.isSafeInteger(body.sequence) || body.sequence < 1
      || !['starting', 'started', 'failed', 'stopped'].includes(body.type) || !canonical(body.occurredAt)) return json({ error: 'invalid_event' }, 400);
    const bodySha256 = await digest(bytes), previous = state.events.find(event => event.id === body.id);
    if (previous && previous.bodySha256 !== bodySha256) return json({ error: 'event_conflict' }, 409);
    state.received++;
    if (state.failFirst && !state.transientFailures) {
      state.transientFailures++; await this.storage.put('run', state); return json({ retry: true }, 503);
    }
    if (previous) state.duplicates++;
    else {
      if (state.events.length >= 256) return json({ error: 'receiver_limit' }, 429);
      if (body.sequence < state.highestSequence) state.outOfOrder++;
      state.highestSequence = Math.max(body.sequence, state.highestSequence);
      state.events.push({ id: body.id, sequence: body.sequence, type: body.type, bodySha256, acceptedAt: new Date(this.now()).toISOString() });
    }
    await this.storage.put('run', state);
    return json({ accepted: true, duplicate: Boolean(previous) });
  }
  async alarm() { await this.storage.deleteAll(); await this.storage.deleteAlarm(); }
}

export function receiverRoute(request, env) {
  const url = new URL(request.url), match = /^\/(admin|receive)\/([a-f0-9-]{36})$/.exec(url.pathname);
  if (!match || !uuid.test(match[2]) || url.search) return json({ error: 'not_found' }, 404);
  if (match[1] === 'admin' && (!/^[a-f0-9]{64}$/.test(env.QUALIFICATION_RECEIVER_TOKEN ?? '')
    || request.headers.get('Authorization') !== `Bearer ${env.QUALIFICATION_RECEIVER_TOKEN}`)) return json({ error: 'not_authenticated' }, 401);
  url.pathname = `/${match[1]}`;
  return env.RECEIVER.get(env.RECEIVER.idFromName(match[2])).fetch(new Request(url, request));
}
