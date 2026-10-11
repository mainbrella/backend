import test from 'node:test';
import assert from 'node:assert/strict';
const { Mainbrella } = await import(process.env.MAINBRELLA_SDK_MODULE || './index.js');

test('image SDK submits bounded multipart source and manages account image versions and tags', async () => {
  const id = 'd688d42a-25ef-4c13-9b28-21a0fde6e163', calls = [];
  const client = new Mainbrella({ apiKey: `mb_${'a'.repeat(64)}`, fetch: async (url, options) => {
    assert.match(options.headers.Authorization, /^Bearer mb_/);
    calls.push([url.pathname, options.method]);
    if (url.pathname === '/images' && options.method === 'POST') {
      assert.equal(options.headers['Content-Type'], undefined);
      const form = await new Request(url, options).formData();
      assert.equal(form.get('name'), 'Tools');
      assert.equal(form.get('dockerfile').replaceAll('\r\n', '\n'), 'FROM mainbrella:base\nRUN echo tools');
      assert.deepEqual(new Uint8Array(await form.get('context').arrayBuffer()), new Uint8Array([31, 139, 0, 255]));
    }
    if (options.method === 'PUT') assert.deepEqual(JSON.parse(options.body), { imageId: id });
    return Response.json({ image: { id } });
  } });
  await client.images.create({ name: 'Tools', dockerfile: 'FROM mainbrella:base\nRUN echo tools', context: new Uint8Array([31, 139, 0, 255]) });
  await client.images.list(); await client.images.get(id); await client.images.logs(id);
  await client.images.tags.set('tools.v1', id); await client.images.tags.get('tools.v1'); await client.images.tags.list();
  await client.images.tags.delete('tools.v1'); await client.images.delete(id);
  assert.deepEqual(calls.map(call => call[1]), ['POST', 'GET', 'GET', 'GET', 'PUT', 'GET', 'GET', 'DELETE', 'DELETE']);
  assert.throws(() => client.images.tags.get('../other'), { code: 'invalid_image_tag' });
  assert.throws(() => client.images.tags.set('stable', 'invalid'), { code: 'invalid_image_identity' });
});

test('build cache selection and private registry credentials are sent only in the authenticated multipart body', async () => {
  const cacheFrom = 'd688d42a-25ef-4c13-9b28-21a0fde6e163';
  const baseImage = { image: `ghcr.io/owner/tools@sha256:${'a'.repeat(64)}`, username: 'reader', password: 'private-test-token' };
  let calls = 0;
  const client = new Mainbrella({ apiKey: `mb_${'a'.repeat(64)}`, fetch: async (url, options) => {
    calls++;
    assert.equal(url.pathname, '/images'); assert.equal(url.search, '');
    const form = await new Request(url, options).formData();
    assert.equal(form.get('cacheFrom'), cacheFrom);
    assert.deepEqual(JSON.parse(form.get('baseImage')), baseImage);
    assert.ok(!JSON.stringify(options.headers).includes(baseImage.password));
    throw new Error(baseImage.password);
  } });
  await assert.rejects(client.images.create({ name: 'Tools', dockerfile: 'FROM mainbrella:base', cacheFrom, baseImage }), { code: 'transport_unavailable', message: 'transport_unavailable' });
  for (const invalid of [null, [], { image: baseImage.image, username: 'reader' }, { image: baseImage.image, password: 'secret' }, { ...baseImage, url: 'https://other' }]) {
    assert.throws(() => client.images.create({ name: 'Tools', dockerfile: 'FROM mainbrella:base', baseImage: invalid }), { code: 'invalid_image_source' });
  }
  assert.equal(calls, 1);
});
