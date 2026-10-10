import { BuildError, ownedBuildApp, type BuildParams } from './build-contract';

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

export async function generateBuildImage(env: Env, params: BuildParams, toolId: string, label: string, prompt: string): Promise<BuildImage> {
  const app = await ownedBuildApp(env, params.userId, params.appId);
  if (!app || app.active_turn_id !== params.turnId) throw new BuildError('build_interrupted');
  const previous = await env.DB.prepare('SELECT * FROM build_images WHERE turn_id = ? AND tool_id = ?')
    .bind(params.turnId, toolId).first<BuildImageRow>();
  if (previous) return publicBuildImage(previous);
  if (!env.AI) throw new BuildError('build_images_unavailable');
  const limits = await env.DB.prepare('SELECT COUNT(*) AS total, SUM(turn_id = ?) AS current FROM build_images WHERE app_id = ?')
    .bind(params.turnId, params.appId).first<{ total: number; current: number | null }>();
  if (limits && (limits.total >= 12 || (limits.current ?? 0) >= 4)) throw new BuildError('build_image_limit');
  const result = await env.AI.run(BUILD_IMAGE_MODEL, { prompt, steps: 4 });
  if (typeof result.image !== 'string') throw new BuildError('build_image_invalid');
  buildImageBytes(result.image);
  const id = crypto.randomUUID();
  // The active-turn guard also prevents late inference from reviving a stopped build.
  const saved = await env.DB.prepare(`INSERT INTO build_images (id, app_id, turn_id, tool_id, label, prompt, data)
    SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM build_apps WHERE id = ? AND user_id = ? AND active_turn_id = ?)`)
    .bind(id, params.appId, params.turnId, toolId, label, prompt, result.image, params.appId, params.userId, params.turnId).run();
  if (!saved.meta.changes) throw new BuildError('build_interrupted');
  return { id, toolId, label, path: buildImagePath(id) };
}

export async function savedBuildImages(env: Env, appId: string) {
  const { results } = await env.DB.prepare('SELECT * FROM build_images WHERE app_id = ? ORDER BY rowid').bind(appId).all<BuildImageRow>();
  return results;
}
