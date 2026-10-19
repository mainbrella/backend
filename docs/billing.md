# Shared product billing

`worker/lib/wallet-billing.ts` is the server-side charging interface for new products.
All products use the existing account balance, spending cap, funding, and payment
integrations. Product code owns prices, provider integration, and durable usage
receipts. Backend composes the account runtime and accounting sink; Linux supplies
compute policy to the shared wallet implementation.

Apply backend migration `049_product_usage.sql` before enabling product usage.
The `CONTAINER_ACCOUNT` binding, `account:<userId>` Durable Object identity, stored
`containerAccount` key, existing balances, and legacy inference/storage routes are
unchanged. Do not roll back to a wallet version that ignores product usage after
enabling new charges.

## Charging a send

Persist the product operation ID, reservation amount, and timestamp before calling
the wallet. IDs are unique within a product, across all its meters. Reuse the same
identity and exact evidence for retries; generate a new ID only for a new operation.

```ts
import { reserveUsage, settleUsage, releaseUsage } from '../worker/lib/wallet-billing.ts';

const identity = { product: 'email', meter: 'send', id: receipt.id };
const reservation = await reserveUsage(env, userId, {
  ...identity,
  resourceId: receipt.mailboxId,
  reservedMicroUsd: receipt.maximumChargeMicroUsd,
  createdAt: receipt.createdAt,
});

// Only dispatch a product operation that its own durable state has claimed.
// A replayed wallet reservation may already be settled or released.
if (reservation.status === 'reserved' && await claimSend(receipt.id)) {
  const result = await sendWithProvider(receipt.id);
  // Persist this accepted result before attempting settlement.
  await saveProviderReceipt(receipt.id, result);
  await settleUsage(env, userId, {
    ...identity,
    costMicroUsd: result.chargeMicroUsd,
    occurredAt: result.acceptedAt,
    evidence: { providerId: result.messageId, recipients: result.recipientCount },
  });
}
```

The provider call, claim, and receipt functions above belong to Email. The wallet
does not send messages or decide Email prices. Email must define its billable
event, rate/version, recipient counting, and any adjustments before enabling sends.

Release a hold only for a known non-send outcome:

```ts
await releaseUsage(env, userId, {
  ...identity,
  occurredAt: receipt.rejectedAt,
  reason: 'provider_rejected', // Or canceled_before_dispatch.
});
```

A timeout or lost provider response retains its hold. Reconcile it using the
provider's operation identity before retrying delivery. Retry settlement from the
persisted product receipt independently of sending. Register that reconciliation
in backend's scheduled composition, following Voice/Vibe's existing pattern.

Amounts are integer micro-USD. One dollar is 1,000,000 micro-USD. A single
reservation or settlement is limited to $100; larger batches need separate
operations. Product/meter names are lowercase identifiers up to 32 characters;
operation/resource IDs contain letters, digits, underscores, or hyphens, up to
128 characters. Evidence is bounded by the 16 KiB request limit. Settlement may
exceed the reservation when observed provider usage requires it; subsequent
reservations still enforce the shared balance and spending cap.

Account mutations are serialized. Each operation receipt is stored separately,
atomically with its balance change and accounting outbox, so message volume does
not enlarge the account snapshot. Conflicting retries fail instead of changing a
charge. Releases never undo settled charges. Ledger events carry product/meter
attribution, accounting closes include their exact consumption, and balance
history reports product totals. Existing AI/Voice usage remains in the legacy
inference category until those product adapters migrate.

## Product storage and ownership

Shared R2 helpers accept `{ product: 'email', userId, appId: resourceId }` and
`products/email/<userId>/<resourceId>/...` keys. The legacy `build-git/` prefix
belongs to Vibe. Vibe orphan cleanup cannot delete other product prefixes.
Common metering remains account-wide. Each product owns reachability and deletion
rules and must compose its retention statements with the platform's fenced
expiration batch before relying on retained storage.

Run `npm run test:platform`, backend API tests, and `npm run check:api` when
changing this contract. Add a new product's worker/browser test commands to its
actual deployment hosts and affected-target selection. Source ownership does not
require another Worker, database, Stripe customer, or checkout.
