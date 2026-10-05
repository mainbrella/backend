export function validateImage(manifest, accountId, dockerfileHash) {
  const prefix = `registry.cloudflare.com/${accountId}/mainbrella-terminal@sha256:`;
  if (typeof manifest.image !== 'string' || !manifest.image.startsWith(prefix)
    || !/^[a-f0-9]{64}$/.test(manifest.image.slice(prefix.length))) {
    throw new Error('Image must be pinned by digest in this account’s mainbrella-terminal repository.');
  }
  if (manifest.dockerfileHash !== dockerfileHash) {
    throw new Error('Image was built from a different Dockerfile. Publish the current Dockerfile in CI first.');
  }
  return manifest.image;
}
