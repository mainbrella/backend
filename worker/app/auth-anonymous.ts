import { currentNativeAppUser } from "./auth-app";
import { AuthError } from "./auth-core";

// A newly linked account keeps the memberships and history created as a guest.
// This also handles sign-in to an account that already existed on another device.
export async function absorbAnonymousHerds(env: Env, request: Request, targetID: string): Promise<void> {
  const source = await currentNativeAppUser(env, request);
  if (!source || source.id === targetID || source.email) return;
  const anonymous = await env.DB.prepare(
    `SELECT current_herd_id, human_name, supabase_user_id FROM users WHERE id = ?
       AND CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.native_anonymous')
         ELSE 0 END = 1
       AND apple_sub IS NULL AND google_sub IS NULL`,
  ).bind(source.id).first<{ current_herd_id: string | null; human_name: string | null;
    supabase_user_id: string | null }>();
  if (!anonymous) return;
  if (anonymous.supabase_user_id) {
    const target = await env.DB.prepare("SELECT supabase_user_id FROM users WHERE id = ?")
      .bind(targetID).first<{ supabase_user_id: string | null }>();
    if (target?.supabase_user_id && target.supabase_user_id !== anonymous.supabase_user_id) {
      throw new AuthError("A different legacy account is already linked.", 409);
    }
  }
  const memberships = await env.DB.prepare(
    `SELECT herd_id FROM herd_memberships WHERE user_id = ? ORDER BY joined_at`,
  ).bind(source.id).all<{ herd_id: string }>();
  const statements: D1PreparedStatement[] = [];
  for (const membership of memberships.results) {
    const herdID = membership.herd_id;
    const targetMember = await env.DB.prepare(
      "SELECT 1 FROM herd_memberships WHERE herd_id = ? AND user_id = ?",
    ).bind(herdID, targetID).first();
    if (!targetMember) {
      statements.push(env.DB.prepare(
        "UPDATE herd_memberships SET user_id = ? WHERE herd_id = ? AND user_id = ?",
      ).bind(targetID, herdID, source.id));
    }
    statements.push(
      env.DB.prepare("UPDATE herd_chat_messages SET user_id = ? WHERE herd_id = ? AND user_id = ?")
        .bind(targetID, herdID, source.id),
      env.DB.prepare("UPDATE herd_direct_messages SET sender_id = ? WHERE herd_id = ? AND sender_id = ?")
        .bind(targetID, herdID, source.id),
      env.DB.prepare("UPDATE herd_direct_messages SET recipient_id = ? WHERE herd_id = ? AND recipient_id = ?")
        .bind(targetID, herdID, source.id),
      env.DB.prepare("DELETE FROM herd_direct_messages WHERE herd_id = ? AND sender_id = recipient_id")
        .bind(herdID),
      env.DB.prepare(
        `DELETE FROM herd_member_presence WHERE herd_id = ? AND user_id = ?
           AND EXISTS (SELECT 1 FROM herd_member_presence WHERE herd_id = ? AND user_id = ?)`,
      ).bind(herdID, source.id, herdID, targetID),
      env.DB.prepare("UPDATE herd_member_presence SET user_id = ? WHERE herd_id = ? AND user_id = ?")
        .bind(targetID, herdID, source.id),
      env.DB.prepare(
        `DELETE FROM herd_push_notification_state WHERE herd_id = ? AND user_id = ?
           AND EXISTS (SELECT 1 FROM herd_push_notification_state WHERE herd_id = ? AND user_id = ?)`,
      ).bind(herdID, source.id, herdID, targetID),
      env.DB.prepare("UPDATE herd_push_notification_state SET user_id = ? WHERE herd_id = ? AND user_id = ?")
        .bind(targetID, herdID, source.id),
      env.DB.prepare(
        `INSERT OR IGNORE INTO herd_member_endorsements
           (herd_id, endorser_user_id, endorsed_user_id, trait, created_at)
         SELECT herd_id, CASE WHEN endorser_user_id = ? THEN ? ELSE endorser_user_id END,
           CASE WHEN endorsed_user_id = ? THEN ? ELSE endorsed_user_id END, trait, created_at
         FROM herd_member_endorsements WHERE herd_id = ?
           AND (endorser_user_id = ? OR endorsed_user_id = ?)
           AND (CASE WHEN endorser_user_id = ? THEN ? ELSE endorser_user_id END) <>
               (CASE WHEN endorsed_user_id = ? THEN ? ELSE endorsed_user_id END)`,
      ).bind(source.id, targetID, source.id, targetID, herdID, source.id, source.id,
        source.id, targetID, source.id, targetID),
      env.DB.prepare(
        `DELETE FROM herd_member_endorsements WHERE herd_id = ?
           AND (endorser_user_id = ? OR endorsed_user_id = ?)`,
      ).bind(herdID, source.id, source.id),
      env.DB.prepare(
        `INSERT OR IGNORE INTO herd_meetup_confirmations
           (herd_id, member_one_user_id, member_two_user_id, meetup_date, confirmed_at)
         SELECT herd_id,
           MIN(CASE WHEN member_one_user_id = ? THEN ? ELSE member_one_user_id END,
               CASE WHEN member_two_user_id = ? THEN ? ELSE member_two_user_id END),
           MAX(CASE WHEN member_one_user_id = ? THEN ? ELSE member_one_user_id END,
               CASE WHEN member_two_user_id = ? THEN ? ELSE member_two_user_id END),
           meetup_date, confirmed_at FROM herd_meetup_confirmations
         WHERE herd_id = ? AND (member_one_user_id = ? OR member_two_user_id = ?)
           AND (CASE WHEN member_one_user_id = ? THEN ? ELSE member_one_user_id END) <>
               (CASE WHEN member_two_user_id = ? THEN ? ELSE member_two_user_id END)`,
      ).bind(source.id, targetID, source.id, targetID,
        source.id, targetID, source.id, targetID, herdID, source.id, source.id,
        source.id, targetID, source.id, targetID),
      env.DB.prepare(
        `DELETE FROM herd_meetup_confirmations WHERE herd_id = ?
           AND (member_one_user_id = ? OR member_two_user_id = ?)`,
      ).bind(herdID, source.id, source.id),
    );
    if (targetMember) statements.push(env.DB.prepare(
      "DELETE FROM herd_memberships WHERE herd_id = ? AND user_id = ?",
    ).bind(herdID, source.id));
  }
  statements.push(
    env.DB.prepare("UPDATE herds SET created_by = ? WHERE created_by = ?").bind(targetID, source.id),
    env.DB.prepare("UPDATE herds SET media_subscription_sponsor_id = ? WHERE media_subscription_sponsor_id = ?")
      .bind(targetID, source.id),
    env.DB.prepare("UPDATE herd_media_subscriptions SET sponsor_user_id = ? WHERE sponsor_user_id = ?")
      .bind(targetID, source.id),
    env.DB.prepare("UPDATE push_notification_events SET actor_id = ? WHERE actor_id = ?")
      .bind(targetID, source.id),
    env.DB.prepare("UPDATE push_notification_events SET target_user_id = ? WHERE target_user_id = ?")
      .bind(targetID, source.id),
    env.DB.prepare("UPDATE app_push_devices SET user_id = ? WHERE user_id = ?").bind(targetID, source.id),
    env.DB.prepare("UPDATE subherds SET created_by = ? WHERE created_by = ?").bind(targetID, source.id),
    env.DB.prepare("UPDATE subherd_neighs SET user_id = ? WHERE user_id = ?").bind(targetID, source.id),
    env.DB.prepare("UPDATE subherd_neigh_replies SET user_id = ? WHERE user_id = ?").bind(targetID, source.id),
    env.DB.prepare("UPDATE community_typicorn_slots SET user_id = ? WHERE user_id = ?").bind(targetID, source.id),
    env.DB.prepare(
      `INSERT OR IGNORE INTO chat_message_reports
        (reporting_user_id, reported_message, reported_at, herd_id, reported_user_id,
         source_kind, source_message_id)
       SELECT CASE WHEN reporting_user_id = ? THEN ? ELSE reporting_user_id END,
         reported_message, reported_at, herd_id,
         CASE WHEN reported_user_id = ? THEN ? ELSE reported_user_id END,
         source_kind, source_message_id FROM chat_message_reports
       WHERE reporting_user_id = ? OR reported_user_id = ?`,
    ).bind(source.id, targetID, source.id, targetID, source.id, source.id),
    env.DB.prepare("DELETE FROM chat_message_reports WHERE reporting_user_id = ? OR reported_user_id = ?")
      .bind(source.id, source.id),
    env.DB.prepare(
      `INSERT OR IGNORE INTO blocked_users (blocking_user_id, blocked_user_id, created_at)
       SELECT CASE WHEN blocking_user_id = ? THEN ? ELSE blocking_user_id END,
         CASE WHEN blocked_user_id = ? THEN ? ELSE blocked_user_id END, created_at
       FROM blocked_users WHERE (blocking_user_id = ? OR blocked_user_id = ?)
         AND (CASE WHEN blocking_user_id = ? THEN ? ELSE blocking_user_id END) <>
             (CASE WHEN blocked_user_id = ? THEN ? ELSE blocked_user_id END)`,
    ).bind(source.id, targetID, source.id, targetID, source.id, source.id,
      source.id, targetID, source.id, targetID),
    env.DB.prepare("DELETE FROM blocked_users WHERE blocking_user_id = ? OR blocked_user_id = ?")
      .bind(source.id, source.id),
    env.DB.prepare(
      `DELETE FROM iop_program_tracks WHERE user_id = ? AND program_id IN
        (SELECT program_id FROM iop_program_tracks WHERE user_id = ?)`,
    ).bind(source.id, targetID),
    env.DB.prepare("UPDATE iop_program_tracks SET user_id = ? WHERE user_id = ?")
      .bind(targetID, source.id),
    env.DB.prepare("UPDATE staff_reviews SET user_id = ? WHERE user_id = ?")
      .bind(targetID, source.id),
    env.DB.prepare("UPDATE program_tour_requests SET user_id = ? WHERE user_id = ?")
      .bind(targetID, source.id),
    env.DB.prepare(
      `INSERT OR IGNORE INTO review_reports
        (id, reporting_user_id, reported_user_id, review_id, created_at)
       SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
         substr(lower(hex(randomblob(2))), 2) || '-8' || substr(lower(hex(randomblob(2))), 2) ||
         '-' || lower(hex(randomblob(6))),
         CASE WHEN reporting_user_id = ? THEN ? ELSE reporting_user_id END,
         CASE WHEN reported_user_id = ? THEN ? ELSE reported_user_id END,
         review_id, created_at FROM review_reports
       WHERE reporting_user_id = ? OR reported_user_id = ?`,
    ).bind(source.id, targetID, source.id, targetID, source.id, source.id),
    env.DB.prepare("DELETE FROM review_reports WHERE reporting_user_id = ? OR reported_user_id = ?")
      .bind(source.id, source.id),
    env.DB.prepare(
      `INSERT OR IGNORE INTO review_blocks
        (blocking_user_id, blocked_user_id, source_review_id, created_at)
       SELECT CASE WHEN blocking_user_id = ? THEN ? ELSE blocking_user_id END,
         CASE WHEN blocked_user_id = ? THEN ? ELSE blocked_user_id END,
         source_review_id, created_at FROM review_blocks
       WHERE blocking_user_id = ? OR blocked_user_id = ?`,
    ).bind(source.id, targetID, source.id, targetID, source.id, source.id),
    env.DB.prepare("DELETE FROM review_blocks WHERE blocking_user_id = ? OR blocked_user_id = ?")
      .bind(source.id, source.id),
    env.DB.prepare(
      `UPDATE users SET current_herd_id = COALESCE(current_herd_id, ?),
         human_name = COALESCE(human_name, ?),
         username = COALESCE(username, (SELECT username FROM herd_memberships
           WHERE herd_id = ? AND user_id = ?)) WHERE id = ?`,
    ).bind(anonymous.current_herd_id, anonymous.human_name,
      anonymous.current_herd_id, targetID, targetID),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(source.id),
  );
  if (anonymous.supabase_user_id) statements.push(
    env.DB.prepare("UPDATE users SET supabase_user_id = ? WHERE id = ?")
      .bind(anonymous.supabase_user_id, targetID),
  );
  await env.DB.batch(statements);
}
