import { hashToken } from '../app/auth-core';
import type { BillingEnv, Plan } from './stripe';

export interface Trial { plan: Plan; expires_at: number }
export async function activeTrial(env: BillingEnv, userId: string): Promise<Trial | null> {
  return env.DB.prepare('SELECT plan, expires_at FROM trial_redemptions WHERE user_id = ? AND expires_at > ?')
    .bind(userId, Date.now()).first<Trial>();
}

export async function redeemTrial(env: BillingEnv, userId: string, plan: Plan, code: unknown): Promise<Trial> {
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{4,64}$/.test(code.trim())) throw new Error('invalid_promo_code');
  const codeHash = await hashToken(code.trim().toUpperCase());
  const previous = await env.DB.prepare('SELECT code_hash, plan, expires_at FROM trial_redemptions WHERE user_id = ?')
    .bind(userId).first<Trial & { code_hash: string }>();
  // Retrying a successful redemption never extends its deadline or consumes another use.
  if (previous) {
    if (previous.code_hash === codeHash && previous.plan === plan && previous.expires_at > Date.now()) return previous;
    throw new Error('trial_already_used');
  }
  const now = Date.now();
  // One atomic statement protects both account uniqueness and the global redemption cap.
  const trial = await env.DB.prepare(`INSERT INTO trial_redemptions (user_id, code_hash, plan, redeemed_at, expires_at)
    SELECT ?, code_hash, plan, ?, ? + trial_days * 86400000 FROM trial_coupons
    WHERE code_hash = ? AND plan = ? AND enabled = 1 AND expires_at > ?
      AND redeemed_count < max_redemptions
    ON CONFLICT(user_id) DO NOTHING RETURNING plan, expires_at`)
    .bind(userId, now, now, codeHash, plan, now).first<Trial>();
  if (!trial) throw new Error('invalid_promo_code');
  return trial;
}
