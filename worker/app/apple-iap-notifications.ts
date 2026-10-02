import { authJson, readJSON } from "./auth-core";
import { allowedMediaProducts, verifiedMediaNotification } from "./herd-media";

export type VerifiedMediaEvent = {
  originalTransactionID: string;
  productID: string;
  expiration: string | null;
  revocation: string | null;
  notificationUUID: string | null;
  signedAt: string | null;
  transactionJWS: string | null;
};

export async function applyVerifiedMediaEvent(env: Env, event: VerifiedMediaEvent): Promise<boolean> {
  if (!allowedMediaProducts.has(event.productID)) return false;
  const now = new Date().toISOString();
  const results = await env.DB.batch([env.DB.prepare(
    `UPDATE herd_media_subscriptions SET
       product_id = ?, expires_at = COALESCE(?, expires_at), revoked_at = ?,
       last_notification_uuid = ?, last_notification_signed_at = ?,
       transaction_jws = COALESCE(?, transaction_jws), updated_at = ?
     WHERE original_transaction_id = ?
       AND (last_notification_uuid IS NULL OR last_notification_uuid <> ?)
       AND (last_notification_signed_at IS NULL OR
         (? IS NOT NULL AND last_notification_signed_at <= ?))
    `,
  ).bind(event.productID, event.expiration, event.revocation,
    event.notificationUUID, event.signedAt, event.transactionJWS, now,
    event.originalTransactionID, event.notificationUUID, event.signedAt, event.signedAt),
  env.DB.prepare(
    `UPDATE herds SET media_enabled = CASE WHEN s.revoked_at IS NULL AND s.expires_at > ?
       THEN 1 ELSE 0 END, media_subscription_expires_at = s.expires_at
     FROM herd_media_subscriptions s WHERE herds.id = s.herd_id
       AND s.original_transaction_id = ?`,
  ).bind(now, event.originalTransactionID)]);
  return Number(results[0].meta.changes) > 0;
}

export async function handleAppleIAPNotification(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return authJson({ error: "method_not_allowed" }, 405, { allow: "POST" });
  if (!env.DB) return authJson({ error: "database_unavailable" }, 503, {});
  const body = await readJSON(request, 40_000);
  if (typeof body?.signedPayload !== "string" || body.signedPayload.length > 30_000) {
    return authJson({ error: "signed_payload_required" }, 400, {});
  }
  try {
    const { notification, transaction, transactionJWS } =
      await verifiedMediaNotification(body.signedPayload, env);
    if (!transaction?.originalTransactionId || !transaction.productId) {
      return authJson({ processed: false }, 200, {});
    }
    const signedAt = notification.signedDate
      ? new Date(notification.signedDate).toISOString() : null;
    const expiration = transaction.expiresDate
      ? new Date(transaction.expiresDate).toISOString() : null;
    const revocation = transaction.revocationDate
      ? new Date(transaction.revocationDate).toISOString() : null;
    const processed = await applyVerifiedMediaEvent(env, {
      originalTransactionID: transaction.originalTransactionId,
      productID: transaction.productId, expiration, revocation,
      notificationUUID: notification.notificationUUID ?? null, signedAt,
      transactionJWS: transactionJWS ?? null,
    });
    return authJson({ processed }, 200, {});
  } catch (error) {
    console.error("apple_iap_notification_error", error);
    return authJson({ error: "notification_processing_failed" }, 500, {});
  }
}
