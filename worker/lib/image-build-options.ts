// Registry pulls happen in the trusted preparation job. Only image bytes cross
// into the disposable job that executes customer Dockerfiles.
import { isStaging } from './deployment-environment';
export type ImageBase = { image: string; username?: string; password?: string };
const encoder = new TextEncoder();
const registryReference = /^(?:ghcr\.io|docker\.io)\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$/;

export function parseImageBase(value: unknown): ImageBase | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['image', 'username', 'password'].includes(key))
    || typeof input.image !== 'string' || input.image.length > 512 || !registryReference.test(input.image)) return null;
  const credentials = input.username !== undefined || input.password !== undefined;
  if (credentials && (typeof input.username !== 'string' || !/^[^\s\x00-\x1f\x7f]{1,256}$/.test(input.username)
    || typeof input.password !== 'string' || !/^[^\x00-\x1f\x7f]{1,4096}$/.test(input.password))) return null;
  return credentials ? { image: input.image, username: input.username as string, password: input.password as string } : { image: input.image };
}

export const imageRegistriesConfigured = (env: Env) => /^[a-f0-9]{64}$/i.test(env.IMAGE_REGISTRY_ENCRYPTION_KEY ?? '');
export const imageBuildsConfigured = (env: Env) => !isStaging(env) && Boolean(env.IMAGE_BUILD_SECRET && env.IMAGE_BUILD_GITHUB_TOKEN
  && /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_.-]{1,100}$/.test(env.IMAGE_BUILD_GITHUB_REPOSITORY ?? ''));

async function key(env: Env) {
  if (!imageRegistriesConfigured(env)) throw new Error('image_registries_unavailable');
  const bytes = Uint8Array.from(env.IMAGE_REGISTRY_ENCRYPTION_KEY!.match(/../g)!, value => parseInt(value, 16));
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function sealImageBase(env: Env, owner: string, id: string, base: ImageBase): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv,
    additionalData: encoder.encode(JSON.stringify(['image-base-v1', owner, id])) }, await key(env), encoder.encode(JSON.stringify(base))));
  return JSON.stringify({ iv: Array.from(iv), ciphertext: Array.from(ciphertext) });
}

export async function openImageBase(env: Env, owner: string, id: string, sealed: string): Promise<ImageBase> {
  const { iv, ciphertext } = JSON.parse(sealed);
  const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv),
    additionalData: encoder.encode(JSON.stringify(['image-base-v1', owner, id])) }, await key(env), new Uint8Array(ciphertext));
  const base = parseImageBase(JSON.parse(new TextDecoder().decode(bytes)));
  if (!base) throw new Error('invalid_image_base');
  return base;
}
