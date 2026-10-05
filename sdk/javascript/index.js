const keyPattern = /^mb_[a-f0-9]{64}$/i;
const terminal = new Set(['succeeded', 'failed', 'canceled', 'timed_out', 'output_limit', 'interrupted']);

export class MainbrellaError extends Error {
  constructor(code, status = 0, details = {}) {
    super(code);
    this.name = 'MainbrellaError';
    this.code = code;
    this.status = status;
    Object.assign(this, details);
  }
}

function apiOrigin(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new MainbrellaError('invalid_api_url');
  }
  return url.origin;
}

function identity(value) {
  if (!value || !/^(small|c[1-9]\d{0,2})$/.test(value.id) || !value.createdAt
    || !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt) {
    throw new MainbrellaError('invalid_container_identity');
  }
  return { id: value.id, createdAt: value.createdAt };
}

export class Mainbrella {
  #apiKey;
  #fetch;
  constructor({ apiKey, baseUrl = 'https://api.mainbrella.com', fetch: fetcher = globalThis.fetch, timeoutMs = 90_000 } = {}) {
    if (!keyPattern.test(apiKey ?? '')) throw new MainbrellaError('invalid_api_key');
    if (typeof fetcher !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1) throw new MainbrellaError('invalid_client_options');
    this.#apiKey = apiKey;
    this.#fetch = fetcher;
    this.baseUrl = apiOrigin(baseUrl);
    this.timeoutMs = timeoutMs;
  }
  async request(path, { method = 'GET', body, headers = {}, binary = false, stream = false, signal } = {}) {
    if (!path.startsWith('/') || path.startsWith('//')) throw new MainbrellaError('invalid_api_path');
    const url = new URL(path, this.baseUrl);
    if (url.origin !== this.baseUrl) throw new MainbrellaError('invalid_api_path');
    let response;
    try {
      response = await this.#fetch(url, { method, redirect: 'error', credentials: 'omit',
        headers: { ...headers, Authorization: `Bearer ${this.#apiKey}`,
          ...(body !== undefined ? { 'Content-Type': body instanceof Uint8Array ? 'application/octet-stream' : 'application/json' } : {}) },
        body: body instanceof Uint8Array ? body : body !== undefined ? JSON.stringify(body) : undefined,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs) });
    } catch { throw new MainbrellaError('transport_unavailable'); }
    if (!response.ok) {
      let data;
      try { data = await response.json(); } catch {}
      const code = typeof data?.error === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(data.error) ? data.error : 'request_failed';
      throw new MainbrellaError(code, response.status);
    }
    if (stream) return response;
    try { return binary ? new Uint8Array(await response.arrayBuffer()) : await response.json(); }
    catch { throw new MainbrellaError('invalid_response', response.status); }
  }
  capabilities() { return this.request('/capabilities'); }
  list() { return this.request('/containers'); }
  connect(value) { return new Sandbox(this, value); }
  async create({ catalogId, imageId, size, idempotencyKey = crypto.randomUUID(), waitTimeoutMs = 120_000, pollIntervalMs = 1000 } = {}) {
    if (catalogId && imageId || !/^[A-Za-z0-9_-]{1,128}$/.test(idempotencyKey)
      || !Number.isInteger(waitTimeoutMs) || waitTimeoutMs < 1 || !Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) {
      throw new MainbrellaError('invalid_creation_options');
    }
    const deadline = Date.now() + waitTimeoutMs;
    if (size !== undefined && !['lite', 'small', 'medium', 'large', 'xl'].includes(size)) throw new MainbrellaError('invalid_creation_options');
    const body = { ...(imageId ? { imageId } : catalogId ? { catalogId } : {}), ...(size !== undefined ? { size } : {}) };
    while (Date.now() < deadline) {
      try {
        const data = await this.request('/containers', { method: 'POST', body,
          headers: { 'Idempotency-Key': idempotencyKey }, signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
        const creation = data.creation;
        if (!creation?.id || !['starting', 'running'].includes(creation.status)) throw new MainbrellaError('invalid_creation_response');
        if (creation.status === 'running') {
          const selected = data.containers?.find(c => c.id === creation.containerId && c.createdAt === creation.createdAt && c.status === 'running');
          if (!selected) throw new MainbrellaError('invalid_creation_response');
          const sandbox = this.connect(selected);
          sandbox.creationId = creation.id;
          return sandbox;
        }
      } catch (error) {
        if (!(error instanceof MainbrellaError) || error.status && error.status !== 503 || error.status === 0 && error.code !== 'transport_unavailable') {
          error.idempotencyKey = idempotencyKey;
          throw error;
        }
      }
      const remaining = deadline - Date.now();
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, remaining)));
    }
    throw new MainbrellaError('creation_ambiguous', 0, { idempotencyKey });
  }
}

export class Sandbox {
  constructor(client, value) {
    this.client = client;
    Object.assign(this, identity(value));
    for (const name of ['imageDigest', 'catalogId', 'imageId', 'instance']) if (typeof value[name] === 'string') this[name] = value[name];
    this.files = {
      read: path => this.client.request(this.path('/containers/files', { path }), { binary: true }),
      write: (path, bytes) => {
        if (!(bytes instanceof Uint8Array)) throw new MainbrellaError('file_bytes_required');
        return this.client.request(this.path('/containers/files', { path }), { method: 'PUT', body: bytes });
      },
    };
    this.commands = {
      run: (command, { timeoutMs, signal } = {}) => this.client.request(this.path('/containers/exec'),
        { method: 'POST', body: { command, ...(timeoutMs !== undefined ? { timeoutMs } : {}) }, signal }),
      start: async (command, { timeoutMs, idempotencyKey = crypto.randomUUID() } = {}) => {
        try {
          const record = await this.client.request(this.path('/containers/executions'), { method: 'POST',
            body: { command, ...(timeoutMs !== undefined ? { timeoutMs } : {}) }, headers: { 'Idempotency-Key': idempotencyKey } });
          return new Execution(this, record.id);
        } catch (error) { error.idempotencyKey = idempotencyKey; throw error; }
      },
    };
  }
  path(path, extra = {}) { return `${path}?${new URLSearchParams({ ...extra, id: this.id, createdAt: this.createdAt })}`; }
  async kill() {
    const data = await this.client.request(this.path('/containers'), { method: 'DELETE' });
    if (!Array.isArray(data.containers) || data.containers.some(c => c.id === this.id && c.createdAt === this.createdAt)) {
      throw new MainbrellaError('cleanup_unconfirmed');
    }
    return data;
  }
}

export class Execution {
  constructor(sandbox, id) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id ?? '')) throw new MainbrellaError('invalid_execution_identity');
    this.sandbox = sandbox;
    this.id = id;
    this.cursor = 0;
  }
  path(suffix = '', extra = {}) { return this.sandbox.path(`/containers/executions/${this.id}${suffix}`, extra); }
  get() { return this.sandbox.client.request(this.path()); }
  cancel() { return this.sandbox.client.request(this.path(), { method: 'DELETE' }); }
  async wait({ timeoutMs = 15 * 60_000, pollIntervalMs = 1000 } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || !Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) throw new MainbrellaError('invalid_wait_options');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await this.get();
      if (terminal.has(result.status)) return result;
      await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(pollIntervalMs, deadline - Date.now()))));
    }
    throw new MainbrellaError('execution_wait_timeout');
  }
  async *events({ cursor = this.cursor, signal } = {}) {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new MainbrellaError('invalid_cursor');
    while (!signal?.aborted) {
      const response = await this.sandbox.client.request(this.path('/events', { cursor: String(cursor) }), { stream: true, signal });
      const reader = response.body?.getReader();
      if (!reader) throw new MainbrellaError('invalid_stream_response');
      const decoder = new TextDecoder();
      let buffer = '', completed = false, sawStatus = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            if (boundary > 64 * 1024) throw new Error();
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const type = frame.split('\n').find(line => line.startsWith('event: '))?.slice(7);
            const data = frame.split('\n').find(line => line.startsWith('data: '))?.slice(6);
            if (!data) continue;
            const item = JSON.parse(data);
            if (type === 'status') {
              sawStatus = true;
              completed = terminal.has(item.status);
              yield { type: 'status', execution: item };
            } else if (['stdout', 'stderr'].includes(type)) {
              if (!Number.isSafeInteger(item.sequence) || typeof item.data !== 'string') throw new Error();
              if (item.sequence > cursor) { this.cursor = cursor = item.sequence; yield item; }
            }
          }
          if (buffer.length > 64 * 1024) throw new Error();
          if (done && (buffer.trim() || !sawStatus)) throw new Error();
          if (done || completed) break;
        }
      } catch { throw new MainbrellaError('execution_stream_unavailable', 0, { cursor }); }
      finally { await reader.cancel().catch(() => {}); }
      if (completed) return;
    }
  }
}

export { terminal as terminalExecutionStates };
