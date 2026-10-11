import { storageMetered } from './r2-storage';
import { ADMIN_EMAIL } from '../app/admin';

export async function checkStorageHealth(env: Env) {
  if (!storageMetered(env)) return;
  const now = Date.now();
  await env.DB.prepare('DELETE FROM r2_rate_windows WHERE window<?').bind(Math.floor(now / 60000) - 1440).run();
  await env.DB.prepare('DELETE FROM r2_export_leases WHERE expires_at<=?').bind(now).run();
  const inventory = await env.DB.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM r2_objects WHERE deleted_at IS NULL').first<{ bytes: number }>();
  const operations = await env.DB.prepare('SELECT COUNT(*) AS count FROM r2_operations WHERE started_at>=?').bind(now - 300000).first<{ count: number }>();
  const receipts = await env.DB.prepare('SELECT COUNT(*) AS count,MIN(occurred_at) AS oldest FROM r2_receipts WHERE settled=0').first<{ count: number; oldest: number | null }>();
  const deletions = await env.DB.prepare('SELECT COUNT(*) AS count,MIN(created_at) AS oldest FROM build_git_deletions').first<{ count: number; oldest: string | null }>();
  const notices = await env.DB.prepare('SELECT COUNT(*) AS count FROM r2_accounts WHERE writes_blocked=1 AND expired_at IS NULL AND warned_at IS NULL').first<{ count: number }>();
  const metrics = { storedBytes: inventory!.bytes, operationsLastFiveMinutes: operations!.count,
    unsettledReceipts: receipts!.count, oldestReceiptAt: receipts!.oldest, pendingDeletions: deletions!.count,
    oldestDeletionAt: deletions!.oldest, undeliveredWarnings: notices!.count, growthPaused: env.R2_WRITES_PAUSED === 'true' };
  console.log('storage_health', metrics);
  const unhealthy = inventory!.bytes >= Number(env.R2_PLATFORM_MAX_BYTES ?? 1000000000000) * 0.8
    || operations!.count >= 40000 || (receipts!.oldest !== null && receipts!.oldest < now - 86400000)
    || (deletions!.oldest !== null && Date.parse(deletions!.oldest) < now - 86400000) || notices!.count > 0;
  if (!unhealthy) return;
  console.error('storage_health_alert', metrics);
  if (!env.WELCOME_EMAIL) return;
  const id = `health_notice:${Math.floor(now / 86400000)}`;
  const claimed = await env.DB.prepare('INSERT INTO r2_meter_state(id,value) VALUES(?,?) ON CONFLICT(id) DO NOTHING RETURNING id').bind(id, String(now)).first();
  if (!claimed) return;
  try {
    await env.WELCOME_EMAIL.send({ from: { email: 'andrew@mainbrella.com', name: 'Mainbrella' }, to: ADMIN_EMAIL,
      subject: 'Mainbrella storage needs attention', text: `Storage capacity, operation volume or reconciliation needs attention.\n\n${JSON.stringify(metrics, null, 2)}\n\nInspect billing and deletion backlogs before changing retention. Set R2_WRITES_PAUSED=true to stop new storage growth.` });
  } catch { console.error('storage_health_email_failed'); }
}
