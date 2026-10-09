export const WORKSPACE_POLICY = Object.freeze({
  builder: { maxSaved: 3, maxReservedBytes: 8_000_000_000, retentionMs: 7 * 86400_000, maxSavesPerMonth: 10,
    maxCaptureBytesPerMonth: 20_000_000_000, maxRetainedCaptureBytes: 20_000_000_000 },
  usage: { maxSaved: 20, maxReservedBytes: 160_000_000_000, retentionMs: 14 * 86400_000, maxSavesPerMonth: 100,
    maxCaptureBytesPerMonth: 400_000_000_000, maxRetainedCaptureBytes: 400_000_000_000 },
  pro: { maxSaved: 20, maxReservedBytes: 160_000_000_000, retentionMs: 14 * 86400_000, maxSavesPerMonth: 100,
    maxCaptureBytesPerMonth: 400_000_000_000, maxRetainedCaptureBytes: 400_000_000_000 },
  scale: { maxSaved: 100, maxReservedBytes: 1_000_000_000_000, retentionMs: 29 * 86400_000, maxSavesPerMonth: 500,
    maxCaptureBytesPerMonth: 2_000_000_000_000, maxRetainedCaptureBytes: 2_000_000_000_000 },
});
// 29-day customer retention + 30-day provider TTL after the last restore,
// with one extra day for admission/capture delay. Daily buckets may retain
// earlier captures for up to one additional day; never release them early.
export const WORKSPACE_CAPTURE_RETENTION_MS = 60 * 86400_000;
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
