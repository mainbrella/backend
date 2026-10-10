import { BuildError, ownedBuildApp, type BuildParams } from './build-contract';
import { meteredBuildInference } from './build-billing';
import { BUILD_IMAGE_COST_MICRO_USD, BUILD_IMAGE_STEPS, buildImageCostMicroUsd } from './build-pricing';
import { proposeBuildOperation, startBuildOperation, recordBuildOperation, buildFailure } from './build-journal';
import { buildObjectRef, storeBuildObject, readBuildObject, serveBuildFile, buildContentHash, buildStoragePrefix, type BuildStorageOwner, type BuildStoredFile } from './build-storage';

export const BUILD_IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';
export const BUILD_IMAGE_MAX_BYTES = 1024 * 1024;
export type BuildImage = { id: string; toolId: string; label: string; path: string };
export type BuildImageRow = { id: string; app_id: string; turn_id: string; tool_id: string; label: string; prompt: string; data: string };
export const buildImagePath = (id: string) => `/generated/${id}.jpg`;
export const publicBuildImage = (image: Omit<BuildImageRow, 'data' | 'prompt' | 'app_id'>): BuildImage =>
  ({ id: image.id, toolId: image.tool_id, label: image.label, path: buildImagePath(image.id) });

export function buildImageBytes(data: string): Uint8Array<ArrayBuffer> {
  // Validate provider output and legacy inline records. Only JPEGs are served.
  if (!data || data.length > Math.ceil(BUILD_IMAGE_MAX_BYTES / 3) * 4) throw new BuildError('build_image_invalid');
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0)); }
  catch { throw new BuildError('build_image_invalid'); }
  if (bytes.length > BUILD_IMAGE_MAX_BYTES || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new BuildError('build_image_invalid');
  return bytes;
}

export function buildImageDimensions(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 2; at + 4 <= bytes.length;) {
    if (bytes[at++] !== 0xff) break;
    while (bytes[at] === 0xff) at++;
    const marker = bytes[at++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    if (at + 2 > bytes.length) break;
    const length = view.getUint16(at);
    if (length < 2 || at + length > bytes.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
      const height = view.getUint16(at + 3), width = view.getUint16(at + 5);
      if (width && height) return { width, height };
      break;
    }
    at += length;
  }
  throw new BuildError('build_image_invalid');
}

export async function generateBuildImage(env: Env, params: BuildParams, toolId: string, label: string, prompt: string): Promise<BuildImage> {
  const app = await ownedBuildApp(env, params.userId, params.appId);
  if (!app || app.active_turn_id !== params.turnId) throw new BuildError('build_interrupted');
  const previous = await env.DB.prepare('SELECT * FROM build_images WHERE turn_id = ? AND tool_id = ?')
    .bind(params.turnId, toolId).first<BuildImageRow>();
  if (previous) return publicBuildImage(previous);
  const ref = { params, id: `image-${toolId}` };
  await proposeBuildOperation(env, ref, 'image', `Generate ${label}`, { model: BUILD_IMAGE_MODEL, label, prompt,
    options: { steps: BUILD_IMAGE_STEPS }, limits: { perTurn: 4, perApp: 12 } });
  const limits = await env.DB.prepare('SELECT COUNT(*) AS total, SUM(turn_id = ?) AS current FROM build_images WHERE app_id = ?')
    .bind(params.turnId, params.appId).first<{ total: number; current: number | null }>();
  await recordBuildOperation(env, ref, { evidence: { limits: { perTurn: 4, perApp: 12, appCount: limits?.total ?? 0, turnCount: limits?.current ?? 0 } } });
  if (!env.AI || limits && (limits.total >= 12 || (limits.current ?? 0) >= 4)) {
    const error = new BuildError(!env.AI ? 'build_images_unavailable' : 'build_image_limit'); error.classification = 'validation'; error.operationId = ref.id;
    await recordBuildOperation(env, ref, { status: 'blocked', finished: true, result: { ok: false, failure: buildFailure(error, ref.id) } });
    throw error;
  }
  await startBuildOperation(env, ref, 'image', `Generate ${label}`);
  let dispatched = false;
  try {
  const result = await meteredBuildInference(env, params, `image-${toolId}`, BUILD_IMAGE_MODEL, BUILD_IMAGE_COST_MICRO_USD, async report => {
    await recordBuildOperation(env, ref, { dispatchAttempted: true }); dispatched = true;
    const output = await env.AI.run(BUILD_IMAGE_MODEL, { prompt, steps: BUILD_IMAGE_STEPS }, env.BUILD_AI_GATEWAY ? {
      gateway: { id: env.BUILD_AI_GATEWAY, skipCache: true, metadata: { turnId: params.turnId, operationId: ref.id, attemptId: '1' } },
    } : undefined);
    await recordBuildOperation(env, ref, { evidence: { providerLogId: env.AI.aiGatewayLogId ?? null, providerReturned: true } });
    if (typeof output.image !== 'string') { const error = new BuildError('build_image_invalid'); error.classification = 'parser'; throw error; }
    let dimensions: { width: number; height: number };
    try { dimensions = buildImageDimensions(buildImageBytes(output.image)); }
    catch (error) { if (error instanceof BuildError) error.classification = 'parser'; throw error; }
    const { width, height } = dimensions;
    const usage = { width, height, steps: BUILD_IMAGE_STEPS }, costMicroUsd = buildImageCostMicroUsd(width, height);
    await recordBuildOperation(env, ref, { evidence: { providerResult: { width, height }, usageCharge: { costMicroUsd, usage } } });
    await report(costMicroUsd, usage);
    return output;
  });
  if (typeof result.image !== 'string') throw new BuildError('build_image_invalid');
  buildImageBytes(result.image);
  const id = crypto.randomUUID();
  const data = JSON.stringify(await storeBuildObject(env, params, buildImageBytes(result.image), 'image/jpeg'));
  // The active-turn guard also prevents late inference from reviving a stopped build.
  const saved = await env.DB.prepare(`INSERT INTO build_images (id, app_id, turn_id, tool_id, label, prompt, data)
    SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM build_apps WHERE id = ? AND user_id = ? AND active_turn_id = ?)`)
    .bind(id, params.appId, params.turnId, toolId, label, prompt, data, params.appId, params.userId, params.turnId).run();
  if (!saved.meta.changes) throw new BuildError('build_interrupted');
  const image = { id, toolId, label, path: buildImagePath(id) };
  await recordBuildOperation(env, ref, { status: 'succeeded', finished: true, result: { ok: true, value: image } });
  return image;
  } catch (error) {
    if (error instanceof BuildError) error.operationId ??= ref.id;
    await recordBuildOperation(env, ref, { status: !dispatched ? 'blocked' : error instanceof BuildError && error.classification === 'parser' ? 'failed' : 'unknown',
      finished: true, result: { ok: false, failure: buildFailure(error, ref.id) } });
    throw error;
  }
}

export async function savedBuildImages(env: Env, appId: string) {
  const { results } = await env.DB.prepare('SELECT * FROM build_images WHERE app_id = ? ORDER BY rowid').bind(appId).all<BuildImageRow>();
  if (!results.length) return results;
  const app = await env.DB.prepare('SELECT user_id FROM build_apps WHERE id = ?').bind(appId).first<{ user_id: string }>();
  if (!app) throw new BuildError('app_not_found', 404);
  for (const image of results) {
    let ref = null;
    try { ref = buildObjectRef(JSON.parse(image.data)); } catch { /* Legacy base64. */ }
    if (ref) image.data = buildImageBase64(await readBuildObject(env, { appId, userId: app.user_id }, ref));
  }
  return results;
}
export function buildImageBase64(bytes: Uint8Array) {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 32768) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
  return btoa(chunks.join(''));
}
export async function buildImageEntries(env: Env, owner: BuildStorageOwner, ids?: string[]): Promise<BuildStoredFile[]> {
  const { results } = await env.DB.prepare('SELECT id, data FROM build_images WHERE app_id = ?').bind(owner.appId).all<{ id: string; data: string }>();
  const entries: BuildStoredFile[] = [];
  for (const image of results) {
    if (ids && !ids.includes(image.id)) continue;
    let ref = null;
    try { ref = buildObjectRef(JSON.parse(image.data)); } catch { /* Legacy base64. */ }
    if (!ref) {
      const bytes = buildImageBytes(image.data), sha256 = await buildContentHash(bytes);
      ref = { $r2: `${buildStoragePrefix(owner)}objects/${sha256}`, size: bytes.length, sha256 };
    }
    entries.push({ path: `public${buildImagePath(image.id)}`, type: 'image', ...ref });
  }
  if (ids && entries.length !== new Set(ids).size) throw new BuildError('build_source_unavailable');
  return entries;
}
export async function serveBuildImage(env: Env, owner: BuildStorageOwner, imageId: string, cors: HeadersInit) {
  const image = await env.DB.prepare('SELECT data FROM build_images WHERE id = ? AND app_id = ?').bind(imageId, owner.appId).first<{ data: string }>();
  if (!image) throw new BuildError('image_not_found', 404);
  let ref = null;
  try { ref = buildObjectRef(JSON.parse(image.data)); } catch { /* Legacy base64. */ }
  if (ref) return serveBuildFile(env, owner, { ...ref, path: `public${buildImagePath(imageId)}`, type: 'image' }, cors);
  const bytes = buildImageBytes(image.data);
  return new Response(bytes, { headers: { ...cors, 'Content-Type': 'image/jpeg', 'Content-Length': String(bytes.length),
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}
