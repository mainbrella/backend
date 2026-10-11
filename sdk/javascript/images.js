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
    create: ({ name, dockerfile, context, cacheFrom, baseImage } = {}) => {
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 80 || typeof dockerfile !== 'string'
        || context !== undefined && (!(context instanceof Uint8Array) || context.length > 512 * 1024)) throw new MainbrellaError('invalid_image_source');
      const body = new FormData();
      body.set('name', name); body.set('dockerfile', dockerfile);
      if (context !== undefined) body.set('context', new Blob([context], { type: 'application/gzip' }), 'context.tar.gz');
      if (cacheFrom !== undefined) { imagePath(cacheFrom); body.set('cacheFrom', cacheFrom); }
      if (baseImage !== undefined) {
        if (!baseImage || typeof baseImage !== 'object' || Array.isArray(baseImage) || typeof baseImage.image !== 'string'
          || Object.keys(baseImage).some(key => !['image', 'username', 'password'].includes(key))
          || (baseImage.username === undefined) !== (baseImage.password === undefined)
          || baseImage.username !== undefined && (typeof baseImage.username !== 'string' || typeof baseImage.password !== 'string')) {
          throw new MainbrellaError('invalid_image_source');
        }
        body.set('baseImage', JSON.stringify(baseImage));
      }
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
