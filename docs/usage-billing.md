# Usage subscription billing

New purchases use one Stripe Customer and one monthly subscription. The $5
minimum is paid in advance and includes the first $5 of resource usage. Mainbrella
owns the usage ledger; Stripe owns invoices, collection, receipts and payment
status. Additional usage is billed at renewal, or on a final usage invoice after
cancellation. This release meters compute only. Future IP, storage and email
services must add deduplicated resource charges to the same period ledger; the
included $5 is subtracted from the sum once. They do not need product purchases
or a second subscription.

Compute is allocated-size units × elapsed milliseconds, including provisioning
and idle time. Hourly rates are Lite $0.02, Small $0.12, Medium $0.20, Large $0.32,
XL $0.56. Aggregate compute is rounded to cents once per billing period. The
account Durable Object reserves full session runtime against the spending cap
before boot; unused reservations are released after a confirmed stop and are
never charged. Unreadable machines retain their reservations until reconciled.

Usage accounts default to a $5 cap, excluding taxes. Overages require an
authenticated browser request with a higher `spendLimitCents` and explicit
`authorizeOverages:true`; the account persists the consent time and selected cap.
Caps are $5–$1,000, include the minimum, and cannot be reduced below committed
usage. Alerts at 50%, 80% and 100% are displayed in billing. They are currently
in-app alerts; email notifications are not implemented. Concurrency and start
limits remain abuse safeguards.

The subscription billing period owns compute usage and the spending cap. Starts
and workspace capture limits still use UTC calendar months. Usage sessions can
cross a calendar-month boundary, but still end at their session, idle, spend or
paid-access deadline. Always-on deployment, recovery and production availability
are separate work. No persistent-disk or uptime guarantee is introduced here.

## Stripe setup and rollout

1. Apply `018_usage_billing.sql`. It preserves all existing billing records and
   widens the checked plan column to include `usage`.
2. In a Stripe sandbox, set `STRIPE_SECRET_KEY` and run
   `node scripts/create-usage-prices.mjs`. Configure the returned
   `STRIPE_USAGE_BASE_PRICE_ID` on the API worker alongside its existing Stripe
   secret, publishable key and webhook secret. Set `STRIPE_USAGE_PRODUCT_ID` to reuse an existing Stripe product if desired. The script creates or reuses a recurring
   price, and does not change existing subscriptions. For live setup, the
   operator must pass `--live` explicitly. Use separate test and live prices.
3. Subscribe the existing signed webhook endpoint to `invoice.created` and
   `customer.subscription.deleted`, as well as the existing payment,
   subscription, refund and dispute events. Renewal invoice creation must be
   delivered before finalization; preserve Stripe's draft invoice grace window.
4. Deploy the private container runtime with the new `usage` policy, then the API
   and account controller, then the web UI. Usage checkout is gated on the
   configured base price. Run the qualification below before allowing live usage.

Existing Builder, Pro and Scale subscriptions retain their paid terms and
quotas. An authenticated customer can explicitly schedule `plan:usage` at renewal
on the same subscription. New legacy purchases are rejected. Current invoices
must prove payment for the recognized base price; a saved plan name, an unpaid
invoice or a standalone overage payment cannot authorize access.

The recognizer supports a base fee plus explicitly allowlisted metered prices
using `STRIPE_USAGE_METERED_PRICE_IDS` (comma separated). Leave that unset in this
release: Mainbrella invoices all resource usage from its own ledger. Before
enabling a native meter, exclude its charges from the internal invoice amount so
the same resource is not billed twice.

## Invoice reconciliation

The `invoice.created` handler reads the live invoice and subscription, verifies
the existing customer's ownership, reconciles account machines, and closes only
elapsed billing periods for that subscription. Pending runtime must be confirmed
stopped before a period is invoiced; reconciliation failures remain retryable.
One invoice item contains
`max(0, total_resource_usage_cents - 500)` and references the exact draft invoice.
The ledger freezes its destination, amount and identifier before the external
write. Retries scan Stripe invoice-item metadata for that identifier and use the
same HTTP idempotency key. A failed webhook does not receive a local receipt.

Cancellation requires a final subscription-linked invoice because the base fee
was paid in advance and no next renewal exists. This invoice adds final overage
without another $5 fee and uses the subscription's default payment method.
Repeated cancellation events recover its metadata-tagged invoice.

If a draft invoice has already finalized, or an ambiguous write older than 23
hours cannot be recovered from Stripe metadata, fail closed with
`billing_reconciliation_required`. Stop/status paths remain available; new
provisioning is blocked until the pending charge is reconciled. Inspect the
durable pending identifier and Stripe invoice items before retrying. Never
blindly issue a replacement charge. Retain period ledgers and invoice receipts
for reconciliation; this first implementation does not erase billing history.

## Qualification before live billing

Use test-mode Checkout and a Stripe subscription test clock to verify:

- $0 and $3 usage produce $5 totals; $12, $180 and $999 usage produce those totals
  across the prepaid minimum and period overage. The renewal invoice contains
  the next period's $5 minimum plus the previous period's overage.
- A fresh account cannot exceed $5 without explicit consent to a higher cap;
  stopping releases unused reservations, and slot reuse or eviction does not
  reset incurred usage or consent.
- Renewal adds the correct overage before finalization, retrying a lost invoice
  item response produces one charge, and finalized invoices require operator
  reconciliation.
- Cancellation produces a final usage invoice without a new minimum, uses the
  saved payment method and does not restore access after payment.
- A legacy migration changes the same subscription at renewal, keeps current
  access until then and does not reset account start limits.
- Unpaid, refunded, disputed and canceled subscriptions retain the existing
  fail-closed access policy. There is no new grace period permitting unpaid
  compute in this release.

Automated tests exercise ledger arithmetic, consent, spending reservations,
renewal and cancellation handling, invoice retry recovery and payment proof.
They do not replace live Stripe sandbox qualification.

Stripe references: [subscription invoices](https://docs.stripe.com/billing/invoices/subscription),
[invoice items](https://docs.stripe.com/api/invoiceitems/create?api-version=2025-04-30.basil),
[creating subscription-linked invoices](https://docs.stripe.com/api/invoices/create?api-version=2025-04-30.basil).
