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
  async request(path, { method = 'GET', body, headers = {}, binary = false, signal } = {}) {
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
    try { return binary ? new Uint8Array(await response.arrayBuffer()) : await response.json(); }
    catch { throw new MainbrellaError('invalid_response', response.status); }
  }
  capabilities() { return this.request('/capabilities'); }
  list() { return this.request('/containers'); }
  connect(value) { return new Sandbox(this, identity(value)); }
  async create({ catalogId, imageId, idempotencyKey = crypto.randomUUID(), waitTimeoutMs = 120_000, pollIntervalMs = 1000 } = {}) {
    if (catalogId && imageId || !/^[A-Za-z0-9_-]{1,128}$/.test(idempotencyKey)
      || !Number.isInteger(waitTimeoutMs) || waitTimeoutMs < 1 || !Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) {
      throw new MainbrellaError('invalid_creation_options');
    }
    const deadline = Date.now() + waitTimeoutMs;
    const body = imageId ? { imageId } : catalogId ? { catalogId } : {};
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
    this.files = {
      read: path => this.client.request(this.path('/containers/files', { path }), { binary: true }),
      write: (path, bytes) => {
        if (!(bytes instanceof Uint8Array)) throw new MainbrellaError('file_bytes_required');
        return this.client.request(this.path('/containers/files', { path }), { method: 'PUT', body: bytes });
      },
    };
    this.commands = { run: (command, { timeoutMs, signal } = {}) => this.client.request(this.path('/containers/exec'),
      { method: 'POST', body: { command, ...(timeoutMs !== undefined ? { timeoutMs } : {}) }, signal }) };
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

export { terminal as terminalExecutionStates };
