import { AppStoreServerAPIClient, Environment, SignedDataVerifier, VerificationException, VerificationStatus,
  type JWSTransactionDecodedPayload } from '@apple/app-store-server-library';
import { Buffer } from 'node:buffer';
import { appleRootG3 } from './apple-root';
import { appendAccountingEvent } from './accounting-ledger';
import { accountBillingRequest, type PrepaidBalance } from './prepaid-billing';

export const APPLE_PRODUCT_ID = 'MAINBRELLA_FIVE';
export const APPLE_BUNDLE_ID = 'com.mainbrella.ios';
export interface AppleProceeds {
  storefront: string; currency: 'USD'; priceMilliunits: number; netCents: number; commissionBps: number; evidence: string;
}
interface ApplePurchase {
  environment: string; transaction_id: string; user_id: string; app_account_token: string; product_id: string;
  storefront: string; currency: string; price_milliunits: number; credit_cents: number; proceeds_policy: string;
  purchase_at: number; refunded_cents: number;
}

// Xcode receipts never reach Apple. Accept them only in an explicitly enabled,
// loopback development Worker; Sandbox and Production always verify signatures.
export function localAppleTesting(env: Env, request: Request): boolean {
  return env.LOCAL_DEV === 'true' && env.APPLE_IAP_ALLOW_XCODE === 'true'
    && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(request.url).hostname);
}
export function appleEnvironment(env: Env): Environment {
  return env.APPLE_IAP_ENVIRONMENT === 'Sandbox' ? Environment.SANDBOX : Environment.PRODUCTION;
}
export function appleConfigured(env: Env, local: boolean): boolean {
  return local || Boolean(env.APPLE_IAP_PRIVATE_KEY && env.APPLE_IAP_KEY_ID && env.APPLE_IAP_ISSUER_ID
    && /^\d+$/.test(env.APPLE_IAP_APP_ID ?? '') && env.APPLE_IAP_PROCEEDS_JSON);
}
export function appleProceeds(env: Env, local: boolean, storefront: unknown, currency: unknown, price: unknown): AppleProceeds {
  let policies: AppleProceeds[];
  try {
    policies = JSON.parse(env.APPLE_IAP_PROCEEDS_JSON ?? (local ? JSON.stringify([
      { storefront: 'USA', currency: 'USD', priceMilliunits: 4990, netCents: 349, commissionBps: 3000, evidence: 'local-test-30-percent' },
    ]) : 'null'));
  } catch { throw new Error('apple_billing_unavailable'); }
  if (!Array.isArray(policies) || !policies.length || policies.some(p => !p || !/^[A-Z]{3}$/.test(p.storefront)
    || p.currency !== 'USD' || !Number.isSafeInteger(p.priceMilliunits) || p.priceMilliunits <= 0 || p.priceMilliunits > 1000000
    || !Number.isInteger(p.commissionBps) || p.commissionBps < 0 || p.commissionBps > 10000
    || !Number.isSafeInteger(p.netCents) || p.netCents < 1
    // Milliunits / 10 is cents. Always round down, including fractional fees.
    || p.netCents > Math.floor(p.priceMilliunits * (10000 - p.commissionBps) / 100000)
    || typeof p.evidence !== 'string' || !p.evidence.trim() || p.evidence.length > 500)) throw new Error('apple_billing_unavailable');
  const matches = policies.filter(p => p.storefront === storefront && p.currency === currency && p.priceMilliunits === price);
  if (matches.length !== 1) throw new Error('apple_price_unavailable');
  return matches[0];
}

export async function appleAccountToken(env: Env, userId: string): Promise<string> {
  await env.DB.prepare('INSERT INTO apple_iap_accounts (user_id,app_account_token,created_at) VALUES (?,?,?) ON CONFLICT(user_id) DO NOTHING')
    .bind(userId, crypto.randomUUID(), Date.now()).run();
  const account = await env.DB.prepare('SELECT app_account_token FROM apple_iap_accounts WHERE user_id = ?').bind(userId).first<{ app_account_token: string }>();
  if (!account) throw new Error('apple_billing_unavailable');
  return account.app_account_token;
}

export function appleVerifier(env: Env, environment = appleEnvironment(env)): SignedDataVerifier {
  // Apple's library validates its pinned certificate chain, bundle ID,
  // environment and notification app ID, with online certificate checks.
  return new SignedDataVerifier([appleRootG3], true, environment, APPLE_BUNDLE_ID,
    environment === Environment.PRODUCTION ? Number(env.APPLE_IAP_APP_ID) : undefined);
}

export async function verifyAppleTransaction(env: Env, signed: string, local: boolean): Promise<JWSTransactionDecodedPayload> {
  let transaction: JWSTransactionDecodedPayload;
  try {
    // Read only an environment hint before verification, never money or identity.
    const hint = JSON.parse(Buffer.from(signed.split('.')[1] ?? '', 'base64url').toString('utf8'));
    const environment = local && hint.environment === Environment.XCODE ? Environment.XCODE : appleEnvironment(env);
    transaction = await appleVerifier(env, environment).verifyAndDecodeTransaction(signed);
    if (environment !== Environment.XCODE) {
      if (!/^[0-9]{1,100}$/.test(transaction.transactionId ?? '')) throw new Error('invalid_apple_transaction');
      const client = new AppStoreServerAPIClient(env.APPLE_IAP_PRIVATE_KEY!, env.APPLE_IAP_KEY_ID!, env.APPLE_IAP_ISSUER_ID!, APPLE_BUNDLE_ID, environment);
      // A valid old purchase JWS can predate a refund. Fetch Apple's current
      // transaction before every delivery, including notification retries.
      const latest = await client.getTransactionInfo(transaction.transactionId!);
      const current = await appleVerifier(env, environment).verifyAndDecodeTransaction(latest.signedTransactionInfo ?? '');
      if (current.transactionId !== transaction.transactionId) throw new Error('invalid_apple_transaction');
      transaction = current;
    }
  } catch (error) {
    if (error instanceof VerificationException && error.status !== VerificationStatus.RETRYABLE_VERIFICATION_FAILURE)
      throw new Error('invalid_apple_transaction');
    if (error instanceof SyntaxError) throw new Error('invalid_apple_transaction');
    if (error instanceof Error && error.message === 'invalid_apple_transaction') throw error;
    throw new Error('apple_billing_unavailable');
  }
  if (transaction.bundleId !== APPLE_BUNDLE_ID || transaction.productId !== APPLE_PRODUCT_ID || transaction.type !== 'Consumable'
    || transaction.inAppOwnershipType !== 'PURCHASED' || transaction.quantity !== 1
    || !/^[0-9]{1,100}$/.test(transaction.transactionId ?? '')
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(transaction.appAccountToken ?? '')
    || !Number.isSafeInteger(transaction.purchaseDate) || transaction.purchaseDate! <= 0 || transaction.purchaseDate! > Date.now() + 60000
    || !Number.isSafeInteger(transaction.price) || transaction.price! <= 0 || transaction.currency !== 'USD'
    || !/^[A-Z]{3}$/.test(transaction.storefront ?? '')
    || (transaction.revocationDate !== undefined && (!Number.isSafeInteger(transaction.revocationDate) || transaction.revocationDate <= 0))
    || (transaction.revocationPercentage !== undefined && (!Number.isInteger(transaction.revocationPercentage) || transaction.revocationPercentage < 0 || transaction.revocationPercentage > 100000)))
    throw new Error('invalid_apple_transaction');
  return transaction;
}

export async function applyAppleTransaction(env: Env, transaction: JWSTransactionDecodedPayload, local: boolean, expectedUserId?: string): Promise<{
  balance: PrepaidBalance; creditedCents: number; transactionId: string;
}> {
  const token = transaction.appAccountToken!.toLowerCase();
  const owner = await env.DB.prepare('SELECT user_id FROM apple_iap_accounts WHERE app_account_token = ?').bind(token).first<{ user_id: string }>();
  if (!owner || (expectedUserId && expectedUserId !== owner.user_id)) throw new Error('apple_purchase_not_owned');
  const userId = owner.user_id, environment = transaction.environment!, transactionId = transaction.transactionId!;
  let purchase = await env.DB.prepare('SELECT * FROM apple_iap_transactions WHERE environment = ? AND transaction_id = ?')
    .bind(environment, transactionId).first<ApplePurchase>();
  if (!purchase) {
    const policy = appleProceeds(env, local, transaction.storefront, transaction.currency, transaction.price);
    await env.DB.prepare(`INSERT INTO apple_iap_transactions
      (environment,transaction_id,user_id,app_account_token,product_id,storefront,currency,price_milliunits,credit_cents,proceeds_policy,purchase_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(environment,transaction_id) DO NOTHING`)
      .bind(environment, transactionId, userId, token, APPLE_PRODUCT_ID, transaction.storefront!, transaction.currency!, transaction.price!,
        policy.netCents, JSON.stringify(policy), transaction.purchaseDate!, Date.now()).run();
    purchase = await env.DB.prepare('SELECT * FROM apple_iap_transactions WHERE environment = ? AND transaction_id = ?')
      .bind(environment, transactionId).first<ApplePurchase>();
  }
  if (!purchase || purchase.user_id !== userId || purchase.app_account_token !== token) throw new Error('apple_purchase_not_owned');
  if (purchase.product_id !== transaction.productId || purchase.storefront !== transaction.storefront || purchase.currency !== transaction.currency
    || purchase.price_milliunits !== transaction.price || purchase.purchase_at !== transaction.purchaseDate) throw new Error('apple_purchase_conflict');
  const id = `apple_${environment}_${transactionId}`, customerId = `account_${userId}`;
  // A partial refund revokes its proportion of NET credit, rounded up. A full
  // refund (or an older transaction without percentage) removes all that credit.
  const revoked = transaction.revocationDate ? Math.ceil(purchase.credit_cents * (transaction.revocationPercentage ?? 100000) / 100000) : 0;
  if (revoked > purchase.refunded_cents) {
    await env.DB.prepare('UPDATE apple_iap_transactions SET refunded_cents = MAX(refunded_cents,?) WHERE environment = ? AND transaction_id = ?')
      .bind(revoked, environment, transactionId).run();
    purchase.refunded_cents = revoked;
  }
  const funding = { id, customerId, amountCents: purchase.credit_cents, refundedCents: purchase.refunded_cents,
    disputed: false, createdAt: purchase.purchase_at, kind: 'topup', source: 'apple' };
  try {
    // Apple is merchant of record. Record net consideration separately from the
    // customer's price; never feed this purchase through Stripe fee accounting.
    await appendAccountingEvent(env, { key: `funding:${id}`, userId, type: 'funding', occurredAt: purchase.purchase_at,
      data: { fundingId: id, customerId, provider: 'apple', creditCents: purchase.credit_cents, amountPaidCents: purchase.credit_cents,
        considerationCents: purchase.credit_cents, promotionalCreditCents: 0, taxCollectedCents: 0, currency: 'usd', chargeId: null, checkoutId: null,
        receiptDateSource: 'apple_purchase_date', taxLocation: { country: null, state: null, postalCode: null, city: null, source: 'unknown' },
        appleEnvironment: environment, applePriceMilliunits: purchase.price_milliunits, appleCurrency: purchase.currency,
        appleStorefront: purchase.storefront, appleProceedsPolicy: JSON.parse(purchase.proceeds_policy) } });
    if (purchase.refunded_cents) await appendAccountingEvent(env, { key: `refund:${id}:${purchase.refunded_cents}`, userId, type: 'refund',
      occurredAt: transaction.revocationDate ?? purchase.purchase_at,
      data: { fundingId: id, refundId: `${id}:${purchase.refunded_cents}`, amountCents: purchase.refunded_cents,
        taxRefundedCents: 0, currency: 'usd', provider: 'apple' } });
  } catch (error) {
    if (purchase.refunded_cents) await accountBillingRequest(env, userId, '/billing/funding', { ...funding, revokeOnly: true });
    throw error;
  }
  const result = await accountBillingRequest(env, userId, '/billing/funding', funding);
  return { ...result, creditedCents: purchase.credit_cents - purchase.refunded_cents, transactionId };
}
