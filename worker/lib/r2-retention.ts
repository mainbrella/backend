import { accountBillingRequest } from './prepaid-billing';
import { storageCharging, STORAGE_DAY_MS, STORAGE_RETENTION_DAYS, storageFundingQuote } from './r2-storage';

export type StorageRetention = {
  writesBlocked: boolean; deletionAt: number | null; notice: string | null;
  warningDeliveredAt: number | null; expiredAt: number | null;
};
export type RetentionRow = { user_id: string; delete_after: number | null; warned_at: number | null;
  email_warned_at: number | null; reminder_seven_at: number | null; reminder_one_at: number | null; expired_at: number | null;
  writes_blocked: number; expiration_token: string | null };

export async function storageRetention(env: Env, userId: string): Promise<StorageRetention> {
  const row = await env.DB.prepare('SELECT * FROM r2_accounts WHERE user_id=?').bind(userId).first<RetentionRow>();
  const blocked = Boolean(row?.writes_blocked) && row?.expired_at == null;
  return { writesBlocked: blocked, deletionAt: blocked ? row?.delete_after ?? null : null,
    notice: row?.expired_at != null ? 'Your saved source and Git history were removed after the storage retention deadline.'
      : blocked ? `Storage funding could not be renewed. Your files are read-only. Add funds or download your repositories before ${row?.delete_after ? new Date(row.delete_after).toISOString() : 'the retention deadline'}.` : null,
    warningDeliveredAt: row?.warned_at ?? null, expiredAt: row?.expired_at ?? null };
}

/** Persist notice delivery, and give a full 30 days after the first delivered
 * warning. This also protects legacy accounts that never had a funded hold. */
export async function markStorageWarning(env: Env, userId: string, expectedDeadline: number, deadline = Date.now() + STORAGE_RETENTION_DAYS * STORAGE_DAY_MS) {
  await env.DB.prepare(`UPDATE r2_accounts SET warned_at=?,delete_after=MAX(delete_after,?)
    WHERE user_id=? AND writes_blocked=1 AND expired_at IS NULL AND warned_at IS NULL AND delete_after=?`)
    .bind(Date.now(), deadline, userId, expectedDeadline).run();
}

export async function notifyStorageRetention(env: Env) {
  if (!storageCharging(env)) return;
  const cursor = await env.DB.prepare("SELECT value FROM r2_meter_state WHERE id='notice_cursor'").first<{ value: string }>();
  const rows = await env.DB.prepare(`SELECT a.*,u.email FROM r2_accounts a JOIN users u ON u.id=a.user_id
    WHERE a.writes_blocked=1 AND a.expired_at IS NULL AND a.user_id>? ORDER BY a.user_id LIMIT 50`)
    .bind(cursor?.value ?? '').all<RetentionRow & { email: string | null }>();
  for (const row of rows.results) {
    if (!row.email || !env.WELCOME_EMAIL || row.delete_after === null) continue;
    const remaining = row.delete_after - Date.now();
    const column = row.email_warned_at === null ? 'email_warned_at'
      : remaining <= STORAGE_DAY_MS && row.reminder_one_at === null ? 'reminder_one_at'
      : remaining <= 7 * STORAGE_DAY_MS && row.reminder_seven_at === null ? 'reminder_seven_at' : null;
    if (!column) continue;
    // The deadline in the first message must match the persisted grace period.
    const deadline = column === 'email_warned_at' ? Math.max(row.delete_after, Math.ceil(Date.now() / STORAGE_DAY_MS) * STORAGE_DAY_MS + STORAGE_RETENTION_DAYS * STORAGE_DAY_MS) : row.delete_after;
    try {
      await env.WELCOME_EMAIL.send({ from: { email: 'andrew@mainbrella.com', name: 'Mainbrella' }, to: row.email,
        subject: column === 'email_warned_at' ? 'Action needed: your Mainbrella storage funding' : 'Reminder: download or fund your Mainbrella files',
        text: `Storage funding could not be renewed. Your saved source and Git history are read-only and scheduled for deletion on ${new Date(deadline).toISOString()}.\n\nAdd funds or download your repositories at https://mainbrella.com/balance/ before that date. You can also export each app from its Build page. Funding renewal cancels deletion.\n\nIf you need help, reply to this email.` });
      if (column === 'email_warned_at') await env.DB.prepare(`UPDATE r2_accounts SET warned_at=COALESCE(warned_at,?),email_warned_at=?,delete_after=MAX(delete_after,?)
        WHERE user_id=? AND delete_after=? AND writes_blocked=1 AND expired_at IS NULL AND email_warned_at IS NULL`)
        .bind(Date.now(), Date.now(), deadline, row.user_id, row.delete_after).run();
      else await env.DB.prepare(`UPDATE r2_accounts SET ${column}=? WHERE user_id=? AND delete_after=? AND writes_blocked=1 AND expired_at IS NULL`)
        .bind(Date.now(), row.user_id, row.delete_after).run();
    } catch { console.error('storage_retention_notice_failed', { userId: row.user_id }); }
  }
  await env.DB.prepare("INSERT INTO r2_meter_state(id,value) VALUES('notice_cursor',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value")
    .bind(rows.results.length === 50 ? rows.results.at(-1)!.user_id : '').run();
}

export async function expireStorageAccount(env: Env, row: RetentionRow) {
  const token = row.expiration_token ?? crypto.randomUUID();
  await env.DB.prepare('UPDATE r2_accounts SET expiration_token=? WHERE user_id=? AND expiration_token IS NULL AND expired_at IS NULL')
    .bind(token, row.user_id).run();
  const claimed = await accountBillingRequest<{ fundedThrough: number | null; writesBlocked: boolean; deletionToken: string | null }>(env, row.user_id,
    '/billing/storage', { action: 'expire', token, ...await storageFundingQuote(env, row.user_id, { bytes: 0, writes: 0 }) });
  if (claimed.deletionToken !== token) {
    await env.DB.prepare(`UPDATE r2_accounts SET funded_through=?,writes_blocked=?,expiration_token=NULL,
      blocked_since=CASE WHEN ?=0 THEN NULL ELSE blocked_since END,delete_after=CASE WHEN ?=0 THEN NULL ELSE delete_after END,
      warned_at=CASE WHEN ?=0 THEN NULL ELSE warned_at END,email_warned_at=CASE WHEN ?=0 THEN NULL ELSE email_warned_at END,reminder_seven_at=CASE WHEN ?=0 THEN NULL ELSE reminder_seven_at END,
      reminder_one_at=CASE WHEN ?=0 THEN NULL ELSE reminder_one_at END WHERE user_id=? AND expiration_token=?`)
      .bind(claimed.fundedThrough, claimed.writesBlocked ? 1 : 0, ...Array(6).fill(claimed.writesBlocked ? 1 : 0), row.user_id, token).run();
    return;
  }
  // The wallet claim fences reservations until this atomic D1 batch finishes.
  // A lost acknowledgement reuses the persisted token on the next sweep.
  const guard = `EXISTS(SELECT 1 FROM r2_accounts WHERE user_id=? AND expiration_token=? AND writes_blocked=1 AND delete_after<=? AND warned_at IS NOT NULL)`;
  const args = [row.user_id, token, Date.now()];
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO build_git_deletions(app_id,user_id,created_at) SELECT id,user_id,? FROM build_apps WHERE user_id=? AND ${guard} ON CONFLICT(app_id) DO NOTHING`)
      .bind(new Date().toISOString(), row.user_id, ...args),
    env.DB.prepare(`UPDATE build_turns SET status='failed',error='storage_retention_expired',finished_at=? WHERE user_id=? AND status IN ('queued','running') AND ${guard}`)
      .bind(new Date().toISOString(), row.user_id, ...args),
    env.DB.prepare(`UPDATE build_operations SET source_json=NULL,result_json=NULL WHERE turn_id IN(SELECT id FROM build_turns WHERE user_id=?) AND ${guard}`).bind(row.user_id, ...args),
    ...['build_git_versions', 'build_revisions', 'build_images'].map(table => env.DB.prepare(`DELETE FROM ${table} WHERE app_id IN(SELECT id FROM build_apps WHERE user_id=?) AND ${guard}`).bind(row.user_id, ...args)),
    env.DB.prepare(`UPDATE build_apps SET source_json='{}',git_version_id=NULL,verified_git_version_id=NULL,active_turn_id=NULL WHERE user_id=? AND ${guard}`).bind(row.user_id, ...args),
    env.DB.prepare(`UPDATE r2_accounts SET expired_at=? WHERE user_id=? AND expiration_token=? AND ${guard}`).bind(Date.now(), row.user_id, token, ...args),
  ]);
  await finishStorageExpiration(env, row.user_id, token);
}
export async function finishStorageExpiration(env: Env, userId: string, token: string) {
  await accountBillingRequest(env, userId, '/billing/storage', { action: 'finish_expiration', token });
  await env.DB.prepare('UPDATE r2_accounts SET expiration_token=NULL WHERE user_id=? AND expiration_token=?').bind(userId, token).run();
}
