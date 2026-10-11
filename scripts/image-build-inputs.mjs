export const MAX_IMAGE_BYTES = 512 * 1024 * 1024;
const externalReference = /^(?:ghcr\.io|docker\.io)\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$/;

// Never serialize the internal source response itself: it may contain one-use
// registry credentials. These two fields alone belong in the build artifact.
export function buildSourceArtifact(source) {
  if (typeof source?.dockerfile !== 'string' || source.contextBase64 !== null && typeof source.contextBase64 !== 'string') throw new Error('Invalid build source');
  return { dockerfile: source.dockerfile, contextBase64: source.contextBase64 };
}

export async function prepareImageInputs({ source, defaultBase, cloudflareCredentials, accountId, run, write }) {
  const base = source.baseImage;
  if (base && (typeof base.image !== 'string' || !externalReference.test(base.image))) throw new Error('Invalid private base');
  if (source.cacheImage && !new RegExp(`^registry\\.cloudflare\\.com/${accountId}/mainbrella-custom-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}@sha256:[a-f0-9]{64}$`).test(source.cacheImage)) throw new Error('Invalid build cache');
  write('prepared/source.json', JSON.stringify(buildSourceArtifact(source)));
  async function save(reference, alias, destination, credentials) {
    const host = reference.split('/')[0];
    try {
      if (credentials) run('docker', ['login', host, '--username', credentials.username, '--password-stdin'], { input: credentials.password });
      run('docker', ['pull', '--platform', 'linux/amd64', reference]);
      const [image] = JSON.parse(run('docker', ['image', 'inspect', reference], { encoding: 'utf8' }));
      if (image.Os !== 'linux' || image.Architecture !== 'amd64' || !Number.isSafeInteger(image.Size) || image.Size <= 0 || image.Size > MAX_IMAGE_BYTES) throw new Error('Unsupported image');
      run('docker', ['tag', reference, alias]);
      run('docker', ['save', '-o', destination, alias]);
    } finally {
      if (credentials) run('docker', ['logout', host]);
    }
  }
  const credentials = !base || source.cacheImage ? await cloudflareCredentials() : null;
  await save(base?.image ?? await defaultBase(), 'mainbrella:base', 'prepared/base.tar', base ? base.username ? base : null : credentials);
  if (source.cacheImage) await save(source.cacheImage, 'mainbrella:cache', 'prepared/cache.tar', credentials);
}
