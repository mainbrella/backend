import { MainbrellaError } from './index.js';

export function imageClient(client) {
  const imagePath = id => {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id ?? '')) throw new MainbrellaError('invalid_image_identity');
    return `/images/${id}`;
  };
  const tagPath = tag => {
    if (typeof tag !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(tag)) throw new MainbrellaError('invalid_image_tag');
    return `/images/tags/${tag}`;
  };
  return {
    list: () => client.request('/images'),
    get: id => client.request(imagePath(id)),
    logs: id => client.request(`${imagePath(id)}/logs`),
    delete: id => client.request(imagePath(id), { method: 'DELETE' }),
    create: ({ name, dockerfile, context } = {}) => {
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 80 || typeof dockerfile !== 'string'
        || context !== undefined && (!(context instanceof Uint8Array) || context.length > 512 * 1024)) throw new MainbrellaError('invalid_image_source');
      const body = new FormData();
      body.set('name', name); body.set('dockerfile', dockerfile);
      if (context !== undefined) body.set('context', new Blob([context], { type: 'application/gzip' }), 'context.tar.gz');
      return client.request('/images', { method: 'POST', body });
    },
    tags: {
      list: () => client.request('/images/tags'),
      get: tag => client.request(tagPath(tag)),
      set: (tag, imageId) => { imagePath(imageId); return client.request(tagPath(tag), { method: 'PUT', body: { imageId } }); },
      delete: tag => client.request(tagPath(tag), { method: 'DELETE' }),
    },
  };
}
