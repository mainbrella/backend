// Validate manifests before placing them in a trusted Worker deployment.
export function validateCustomImages(manifest, accountId) {
  if (!manifest || typeof manifest.images !== 'object' || Array.isArray(manifest.images) || manifest.images === null) {
    throw new Error('Invalid custom image manifest');
  }
  const entries = Object.entries(manifest.images);
  if (entries.length > 99) throw new Error('Custom image capacity exceeded');
  for (const [key, value] of entries) {
    if (!/^custom_[a-f0-9]{32}$/.test(key)) throw new Error('Invalid custom image key');
    const compact = key.slice(7);
    const id = `${compact.slice(0,8)}-${compact.slice(8,12)}-${compact.slice(12,16)}-${compact.slice(16,20)}-${compact.slice(20)}`;
    const prefix = `registry.cloudflare.com/${accountId}/mainbrella-custom-${id}@sha256:`;
    if (typeof value?.image !== 'string' || !value.image.startsWith(prefix)
      || !/^[a-f0-9]{64}$/.test(value.image.slice(prefix.length))) throw new Error('Invalid custom image reference');
  }
  return Object.fromEntries(entries.map(([key, value]) => [key, { image: value.image }]));
}
