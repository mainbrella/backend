import { MainbrellaError } from './index.js';

// Server inventory survives client exit. Never retry with a new key after an
// uncertain create/acquire: the same generation may already be billed/assigned.
export function managedPools(client) {
  const path = id => {
    if (typeof id !== 'string' || !/^pool_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) throw new MainbrellaError('invalid_pool_identity');
    return `/pools/${id}`;
  };
  const keyed = async (endpoint, body, idempotencyKey) => {
    if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(idempotencyKey)) throw new MainbrellaError('invalid_pool_options');
    try {
      return await client.request(endpoint, { method: 'POST', body, headers: { 'Idempotency-Key': idempotencyKey } });
    } catch (error) { error.idempotencyKey = idempotencyKey; throw error; }
  };
  return {
    list: () => client.request('/pools'),
    get: id => client.request(path(id)),
    create: ({ idempotencyKey = crypto.randomUUID(), ...options } = {}) => keyed('/pools', options, idempotencyKey),
    update: (id, options) => client.request(path(id), { method: 'PATCH', body: options }),
    delete: id => client.request(path(id), { method: 'DELETE' }),
    acquire: async (id, { idempotencyKey = crypto.randomUUID() } = {}) => {
      const endpoint = path(id);
      try {
        const result = await keyed(`${endpoint}/acquire`, {}, idempotencyKey);
        if (result?.poolId !== id || result.container?.status !== 'running') throw new MainbrellaError('invalid_pool_response');
        return client.connect(result.container);
      } catch (error) { error.idempotencyKey = idempotencyKey; throw error; }
    },
  };
}
