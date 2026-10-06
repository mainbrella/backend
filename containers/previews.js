import { DEFAULT_PREVIEW_TTL_SECONDS, MAX_PREVIEW_CONNECTIONS, MAX_PREVIEW_GRANTS,
  MAX_PREVIEW_FRAME_BYTES, PREVIEW_CONNECT_TIMEOUT_MS, validPreviewId, validPreviewOptions, validPreviewOrigin, validPreviewToken } from './preview-contract.js';

const STORAGE_KEY = 'previewGrants';
const randomHex = length => [...crypto.getRandomValues(new Uint8Array(length))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const hash = async token => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const publicGrant = ({ id, port, createdAt, expiresAt }) => ({ id, port, createdAt, expiresAt });

// Private DO routes only. A separate, isolated preview gateway must authenticate
// and route public traffic; this module does not expose a customer URL.
export class ContainerPreviews {
  constructor(controller, options = {}) {
    this.controller = controller;
    this.timers = options.timers ?? globalThis;
    this.pairFactory = options.pairFactory ?? (() => new WebSocketPair());
    this.responseFactory = options.responseFactory ?? ((socket, headers) => new Response(null, { status: 101, webSocket: socket, headers }));
    this.active = new Set();
  }

  async metadata(createdAt) {
    const c = this.controller;
    const metadata = await c.ctx.storage.get('builderMachine');
    return c.container.running && metadata && await c.hasPaidAccess()
      && new Date(metadata.createdAt).toISOString() === createdAt
      && c.now() < c.deadline(metadata) ? metadata : null;
  }

  async grants(metadata) {
    const saved = (await this.controller.ctx.storage.get(STORAGE_KEY)) ?? [];
    return saved.filter(grant => grant.createdAt === new Date(metadata.createdAt).toISOString()
      && grant.expiresAt > this.controller.now())
      .map(grant => ({ ...grant, expiresAt: Math.min(grant.expiresAt, metadata.expiresAt) }));
  }

  async manage(request) {
    const c = this.controller;
    const url = new URL(request.url);
    if (!['GET', 'POST', 'DELETE'].includes(request.method)) return c.respond({ error: 'method_not_allowed' }, 405);
    const id = url.searchParams.get('previewId');
    if ([...url.searchParams.keys()].some(key => key !== 'previewId')
      || (request.method === 'DELETE' ? !validPreviewId(id) || url.searchParams.getAll('previewId').length !== 1 : url.search !== '')) {
      return c.respond({ error: 'invalid_request' }, 400);
    }
    let body;
    if (request.method === 'POST') {
      // Bound bytes while reading; Content-Length alone is not authoritative.
      const reader = request.body?.getReader();
      let size = 0;
      const chunks = [];
      try {
        if (reader) for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1024) { await reader.cancel(); return c.respond({ error: 'invalid_request' }, 400); }
          chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        body = JSON.parse(new TextDecoder().decode(bytes));
      } catch { return c.respond({ error: 'invalid_request' }, 400); }
      finally { reader?.releaseLock(); }
      if (!validPreviewOptions(body)) return c.respond({ error: 'invalid_request' }, 400);
    }
    return c.serialized(async () => {
      const metadata = await this.metadata(request.headers.get('x-preview-created-at'));
      if (!metadata) return c.respond({ error: 'container_not_running' }, 409);
      const grants = await this.grants(metadata);
      if (request.method === 'GET') return c.respond({ previews: grants.map(publicGrant) });
      if (request.method === 'DELETE') {
        await c.ctx.storage.put(STORAGE_KEY, grants.filter(grant => grant.id !== id));
        for (const session of this.active) if (session.grant.id === id) session.close('Preview revoked');
        return c.respond({ revoked: true });
      }
      if (grants.length >= MAX_PREVIEW_GRANTS) return c.respond({ error: 'preview_limit' }, 429);
      const token = randomHex(24);
      const grant = { id: randomHex(16), tokenHash: await hash(token), port: body.port,
        createdAt: new Date(metadata.createdAt).toISOString(),
        expiresAt: Math.min(c.now() + (body.ttlSeconds ?? DEFAULT_PREVIEW_TTL_SECONDS) * 1000, metadata.expiresAt) };
      await c.ctx.storage.put(STORAGE_KEY, [...grants, grant]);
      return c.respond({ ...publicGrant(grant), token }, 201);
    });
  }

  session(grant, signal) {
    const abort = new AbortController();
    const timers = new Set();
    const session = {
      grant, abort, closed: false, closeSocket: null,
      close: reason => {
        if (session.closed) return;
        session.closed = true;
        abort.abort();
        session.closeSocket?.(reason);
        for (const timer of timers) this.timers.clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.active.delete(session);
      },
      timer: (callback, delay) => {
        const timer = this.timers.setTimeout(() => { timers.delete(timer); callback(); }, Math.max(0, delay));
        timers.add(timer);
        return timer;
      },
      clearTimer: timer => { this.timers.clearTimeout(timer); timers.delete(timer); },
    };
    const onAbort = () => session.close('Client disconnected');
    signal?.addEventListener('abort', onAbort, { once: true });
    this.active.add(session);
    session.timer(() => session.close('Preview expired'), grant.expiresAt - this.controller.now());
    const check = async () => {
      if (session.closed) return;
      try {
        // Quiet streams/sockets do not renew idle activity. Recheck lease and
        // entitlement changes during every active transport, including HTTP.
        if (!await this.controller.getTerminalMetadata(grant.createdAt, grant.expiresAt)) session.close('Container unavailable');
      } catch { session.close('Container unavailable'); }
      if (!session.closed) session.timer(check, 1000);
    };
    session.timer(check, 1000);
    if (signal?.aborted) onAbort();
    return session;
  }

  async forward(request) {
    const c = this.controller;
    const url = new URL(request.url);
    const token = request.headers.get('x-preview-token');
    if (!validPreviewToken(token)) return c.respond({ error: 'preview_unavailable' }, 403);
    const origin = request.headers.get('x-preview-origin');
    // Missing origin keeps older gateways compatible during runtime-first
    // rollout. A present but invalid attestation always fails closed.
    if (origin !== null && !validPreviewOrigin(origin, token)) return c.respond({ error: 'preview_unavailable' }, 403);
    const tokenHash = await hash(token);
    const admission = await c.serialized(async () => {
      const metadata = await this.metadata(request.headers.get('x-preview-created-at'));
      if (!metadata) return { error: 403 };
      const grant = (await this.grants(metadata)).find(item => item.tokenHash === tokenHash);
      if (!grant) return { error: 403 };
      if (this.active.size >= MAX_PREVIEW_CONNECTIONS) return { error: 429 };
      const session = this.session(grant, request.signal);
      if (session.closed) return { error: 403 };
      const headers = new Headers(request.headers);
      for (const name of [...headers.keys()]) {
        if (name.startsWith('x-preview-') || name.startsWith('x-mainbrella-')
          || name.startsWith('x-exec-') || name.startsWith('x-terminal-') || name.startsWith('x-ssh-')
          || ['authorization', 'cookie', 'host', 'forwarded', 'x-forwarded-host', 'x-forwarded-for', 'x-forwarded-proto'].includes(name)) headers.delete(name);
      }
      if (origin !== null) {
        const host = new URL(origin).host;
        headers.set('host', host);
        headers.set('x-forwarded-host', host);
        headers.set('x-forwarded-proto', 'https');
      }
      const target = new URL('http://container');
      target.pathname = url.pathname.slice('/preview'.length) || '/';
      target.search = url.search;
      let response;
      try {
        const forwarded = new Request(target, { method: request.method, headers,
          body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
          signal: session.abort.signal, redirect: 'manual', duplex: 'half' });
        // Begin the fetch inside the generation lock, but release the lock before
        // waiting on an application. Revocation/stop must remain responsive.
        response = Promise.resolve(c.container.getTcpPort(grant.port).fetch(forwarded));
      } catch (error) { response = Promise.reject(error); }
      // Attach a rejection handler before yielding out of the admission lock.
      void response.then(result => {
        // A provider response can arrive after a timeout/revocation even if the
        // upstream ignores AbortSignal. Release that late transport as well.
        if (session.closed) {
          try { result.webSocket?.close(1000, 'Preview closed'); } catch {}
          void result.body?.cancel().catch(() => {});
        }
      }).catch(() => {});
      return { session, response };
    });
    if (admission.error) return c.respond({ error: admission.error === 429 ? 'preview_connection_limit' : 'preview_unavailable' }, admission.error);
    const { session } = admission;
    try {
      let timeout;
      const response = await Promise.race([admission.response, new Promise((_, reject) => {
        timeout = session.timer(() => { session.close('Connection timed out'); reject(new Error('timeout')); }, PREVIEW_CONNECT_TIMEOUT_MS);
        session.abort.signal.addEventListener('abort', () => reject(new Error('closed')), { once: true });
        if (session.closed) reject(new Error('closed'));
      })]);
      session.clearTimer(timeout);
      if (session.closed) throw new Error('closed');
      if (!await c.touchTerminalActivity(session.grant.createdAt) || session.closed) throw new Error('closed');
      const headers = new Headers(response.headers);
      headers.set('cache-control', 'no-store');
      headers.set('referrer-policy', 'no-referrer');
      // Cookie-based application sessions remain unsupported. Forwarding the
      // attested app origin must never propagate account cookies to the guest.
      headers.delete('set-cookie');
      if (response.status === 101) {
        if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket' || !response.webSocket) throw new Error('bad_upgrade');
        return this.bridge(response.webSocket, session, headers);
      }
      if (!response.body) { session.close('Response complete'); return new Response(null, { status: response.status, headers }); }
      const reader = response.body.getReader();
      const stream = new ReadableStream({
        start: controller => {
          session.abort.signal.addEventListener('abort', () => {
            void reader.cancel().catch(() => {});
            controller.error(new Error('Preview closed'));
          }, { once: true });
        },
        pull: async controller => {
          try {
            const { value, done } = await reader.read();
            if (session.closed) return;
            if (done) { controller.close(); session.close('Response complete'); }
            else controller.enqueue(value);
          } catch { controller.error(new Error('Preview closed')); session.close('Response failed'); }
        },
        cancel: async () => { session.close('Client disconnected'); await reader.cancel(); },
      });
      return new Response(stream, { status: response.status, headers });
    } catch { session.close('Preview unavailable'); return c.respond({ error: 'preview_unavailable' }, 502); }
  }

  bridge(upstream, session, headers) {
    const [client, server] = Object.values(this.pairFactory());
    upstream.binaryType = server.binaryType = 'arraybuffer';
    session.closeSocket = reason => {
      for (const socket of [server, upstream]) try { socket.close(1000, reason); } catch {}
    };
    for (const [source, destination] of [[server, upstream], [upstream, server]]) {
      source.addEventListener('message', event => {
        // Forward synchronously after admission; periodic validation and the
        // hard timer handle lease changes even when both sockets are quiet.
        if (session.closed) return;
        const size = typeof event.data === 'string' ? new TextEncoder().encode(event.data).byteLength : event.data?.byteLength;
        if (!Number.isSafeInteger(size) || size > MAX_PREVIEW_FRAME_BYTES) { session.close('Frame too large'); return; }
        try { destination.send(event.data); } catch { session.close('Socket unavailable'); }
      });
      source.addEventListener('close', () => session.close('Socket closed'));
      source.addEventListener('error', () => session.close('Socket unavailable'));
    }
    upstream.accept();
    server.accept();
    let lastActivity = this.controller.now();
    let activityPending = false;
    const activity = () => {
      if (session.closed || activityPending || this.controller.now() - lastActivity < 1000) return;
      activityPending = true;
      void this.controller.touchTerminalActivity(session.grant.createdAt).then(ok => {
        if (!ok) session.close('Container unavailable');
        lastActivity = this.controller.now();
      }).catch(() => session.close('Container unavailable')).finally(() => { activityPending = false; });
    };
    for (const socket of [server, upstream]) socket.addEventListener('message', activity);
    return this.responseFactory(client, headers);
  }

  close() {
    for (const session of this.active) session.close('Container stopped');
  }
}
