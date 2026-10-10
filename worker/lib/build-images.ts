import { BuildError, ownedBuildApp, type BuildParams } from './build-contract';
import { meteredBuildInference } from './build-billing';
import { BUILD_IMAGE_COST_MICRO_USD, BUILD_IMAGE_STEPS, buildImageCostMicroUsd } from './build-pricing';
import { proposeBuildOperation, startBuildOperation, recordBuildOperation, buildFailure } from './build-journal';

export const BUILD_IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';
export const BUILD_IMAGE_MAX_BYTES = 1024 * 1024;
export type BuildImage = { id: string; toolId: string; label: string; path: string };
export type BuildImageRow = { id: string; app_id: string; turn_id: string; tool_id: string; label: string; prompt: string; data: string };
export const buildImagePath = (id: string) => `/generated/${id}.jpg`;
export const publicBuildImage = (image: Omit<BuildImageRow, 'data' | 'prompt' | 'app_id'>): BuildImage =>
  ({ id: image.id, toolId: image.tool_id, label: image.label, path: buildImagePath(image.id) });

export function buildImageBytes(data: string): Uint8Array<ArrayBuffer> {
  // Keep each D1 row comfortably below its 2 MiB limit. Only JPEGs are served.
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
  // The active-turn guard also prevents late inference from reviving a stopped build.
  const saved = await env.DB.prepare(`INSERT INTO build_images (id, app_id, turn_id, tool_id, label, prompt, data)
    SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM build_apps WHERE id = ? AND user_id = ? AND active_turn_id = ?)`)
    .bind(id, params.appId, params.turnId, toolId, label, prompt, result.image, params.appId, params.userId, params.turnId).run();
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
  return results;
}
