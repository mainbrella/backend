# Prepaid compute billing

Accounting evidence, ledger exports, monthly closes and pending professional tax
decisions are documented in [accounting-ledger.md](accounting-ledger.md). Apply
`020_accounting_ledger.sql` before deploying the accounting-enabled payment path.

New purchases add $5–$1,000 USD of compute balance through one-time Checkout.
Stripe promotion codes discount the price without reducing the selected
compute balance. Without a discount, every dollar paid adds one dollar of
balance, with identical compute rates and account limits.
Thirty-six $5 payments equal $180; two hundred equal $1,000. Credit carries
forward. There is no new monthly subscription, start fee, or bulk bonus.

The account controller reserves paid runtime before starting or renewing a
machine. Compute includes startup and idle allocation at $0.02 per weighted
compute-unit hour. Unused reservation is released only after a confirmed stop.
Lifetime consumption survives UTC month boundaries and controller eviction.
The independent monthly spending cap defaults to $5. Production admission
requires enough wallet funds and cap room for 24 hours of the entire desired
fleet, including services awaiting recovery and the new service. Existing
services use short funded leases. The 10,000-starts-per-UTC-month abuse limit
remains; idempotent retries do not count twice.

## Balance history

Browser-cookie `GET /billing/history` explains lifetime original credit,
current refund/dispute deductions and elapsed allocation consumption. It takes
one `asOf` snapshot, uses fractional cents for resource charges, and returns
the existing rounded balance separately. Reservations hold future runtime;
they are not consumption. Startup and idle allocation are billed at the
machine's weighted hourly rate. Storage, IPs and email have no separate prepaid
charges. No Stripe lookup, provisioning, renewal or metering mutation happens
on this read, so it remains usable during funding-provider outages.

New allocations retain a durable UUID and exact runtime deltas alongside the
existing lifetime wallet counter. Repeated settlement and production renewal
cannot duplicate usage. Confirmed stop finalizes the resource row; reusing a
slot creates another allocation. Keep the newest 256 completed allocations
plus current leases. Older compacted resource detail and already settled usage
from before tracking are explicitly `unattributedUsedCents`; lifetime funding,
deductions and consumption remain intact. No database migration is needed.
Existing running leases begin attribution at their first unsettled timestamp.

All current leases are returned separately in `activeResources`, including
expired leases awaiting a confirmed stop (marked inactive). Completed resource
and funding lists paginate independently with `resourceCursor`, `fundingCursor`
and `limit` (default 50, maximum 100); totals and current hourly rate cover the
entire account. A compacted/unknown cursor returns 400 and callers restart its
list. Snapshots may change between pages. Funding purchase dates are retained;
refund/dispute deduction dates are not invented. This endpoint covers prepaid
credit, not legacy monthly invoices. See `API.md` for the full response contract.

## Stripe setup

Create a Mainbrella Compute Credit Product with a $5 USD **one-time** Price.
Configure `STRIPE_PREPAID_PRICE_ID`, matching the Stripe secret key's mode:

- Local test: `price_1UOnn1GgJdfq06olbpFSrIMd` in backend `.env`.
- Production: `price_1UOno4GSUs8K8zgHhtAJjabl` in `wrangler.jsonc` vars.

Checkout validates the active reference Price and Product. A $5 purchase uses
the reference Price; other amounts use inline pricing on the same Product.
No additional recurring or per-amount Stripe Prices are needed. Stripe's
embedded Checkout handles card entry inside the usage billing page. Configure
`STRIPE_PUBLISHABLE_KEY` with the matching test or live mode so the browser can
mount the Checkout form; the secret key still creates sessions and verifies
payments on the server. New purchases are unavailable until both keys and the
reference Price are configured. Balance, completion verification and billing
settings remain available without the publishable key.
Checkout enables Stripe promotion codes backed by Stripe coupons. Create these
codes in the matching test/live Stripe Dashboard; product-restricted coupons
must include the Compute Credit Product. The existing Mainbrella trial-coupon
system is separate. For example, a 50% code on a $20 top-up charges $10 and adds
$20 of compute balance. The server verifies Stripe's live subtotal and discount
against the saved purchase, and checks the actual captured card payment.
A 100% discount hides card entry and requires confirmation. Credit is added
only for a completed zero-total Checkout with `paid` or `no_payment_required`
status and no PaymentIntent, using its session ID as the funding identity.
Automatic recharge uses its explicitly authorized amount and does not apply
promotion codes.
Configure `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` separately for each
mode. Send signed events to `/subscription/webhook`, including
`checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`payment_intent.succeeded`, `charge.refunded`, and `charge.dispute.created`.
Keep legacy subscription/invoice event delivery while legacy subscriptions
exist. A browser return alone cannot add funds: the server verifies live
payment and charge ownership, currency, amount, capture, and refund state.
Refunds revoke the corresponding proportion of compute credit, rounded up to
the next cent; a full refund or dispute revokes the full purchase credit.

Automatic recharge is disabled by default. Enabling it explicitly consents
to storing a verified card and charging a chosen amount within an independent
monthly recharge limit. Durable attempt identifiers precede external writes.
Unknown/processing payments do not fund runtime and retain their identity
for recovery. Actionable or failed off-session intents must be confirmed
canceled before an attempt can be replaced. A new manual top-up and explicit
settings change can restore automatic recharge after failure.

## Rollout and verification

Apply migration `019_prepaid_billing.sql` along with any earlier unapplied
migrations before deploying. Deploy the API and account/container runtime
changes with the frontend. Existing monthly purchases are disabled when
prepaid configuration is present; owned legacy subscriptions remain readable
and cancellable through the legacy API or support.

Before enabling live purchases, verify a test-mode top-up, duplicate completion
and webhook delivery, a partial/full refund, and failed automatic recharge.
Observe that each payment is credited once and failed payments never extend
compute. Refunds/disputes remove funding and fence affected pending/running
leases. Local automated tests cover concurrent starts, rollover, eviction,
revocation, and durable recharge recovery; no live payment or deployment is
part of the implementation checks.
