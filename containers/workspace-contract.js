export const WORKSPACE_POLICY = Object.freeze({
  builder: { maxSaved: 3, maxReservedBytes: 24_000_000_000, retentionMs: 7 * 86400_000, maxSavesPerMonth: 30 },
  pro: { maxSaved: 20, maxReservedBytes: 160_000_000_000, retentionMs: 14 * 86400_000, maxSavesPerMonth: 300 },
  scale: { maxSaved: 100, maxReservedBytes: 2_000_000_000_000, retentionMs: 29 * 86400_000, maxSavesPerMonth: 3000 },
});
export const WORKSPACE_OPERATION_RETENTION_MS = 86400_000;
export const validWorkspaceId = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export const validWorkspaceName = value => typeof value === 'string' && value.trim() === value && value.length >= 1 && value.length <= 80 && !/[\x00-\x1f\x7f]/.test(value);
export const validGeneration = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export function publicWorkspace(record, now) {
  const { id, name, createdAt, expiresAt, source, size, internet, imageDigest, imageId, imageName, catalogId, bytes, archived, stop, stopCompleted } = record;
  const status = record.deleted ? 'deleted' : expiresAt <= now ? 'expired' : record.handle ? 'ready' : record.failed ? 'failed' : 'saving';
  return { id, name, createdAt, expiresAt, source, size, internet, imageDigest, ...(imageId ? {imageId} : {}), ...(imageName ? {imageName} : {}), ...(catalogId ? {catalogId} : {}),
    bytes: bytes ?? null, archived: Boolean(archived), status, stopRequested: stop, stopCompleted: Boolean(stopCompleted) };
}
