# Prepaid accounting ledger and monthly close

The Durable Object wallet remains the authority for compute authorization,
reservations, spending caps and stopping resources. Migration
`020_accounting_ledger.sql` adds separate D1 accounting evidence. Apply it before
deploying this API and account controller; the payment path requires the table.

The ledger stores actual gross payments, consideration excluding sales tax,
promotional credit, funding dates, customer tax location, successful refunds,
Stripe balance transactions including processing fees and chargeback withdrawals
or reinstatements, observed wallet revocations, and compute delivery intervals.
Stripe balance availability dates are distinct from payment receipt dates and
are **not bank payout dates**. This ledger covers prepaid compute; legacy
subscription accounting and a complete bank/general ledger reconciliation remain
separate work.

SQL triggers reject updates and deletes of ledger events, tax policy approvals
and saved close revisions. These tables have no cascading user foreign key.
Stripe identities and allocation interval identities deduplicate retries;
conflicting evidence for the same identity fails rather than overwriting it.
Corrections require additional evidence and a new close revision. Keep database
backups and exported evidence under the business's retention policy.

Compute uses integer size-weighted milliseconds. Monetary close outputs are
integer micro-USD strings (1 USD = 1,000,000 micro-USD). Revenue is allocated FIFO
across receipt lots, proportionally to each lot's original actual consideration
and face credit; rounding is cumulative within a lot, not per allocation. This
book allocation convention requires the accountant's approval. No automatic
credit expiration or breakage recognition is implemented.

Before writing to D1, the account controller persists consumption and its outbox
in Durable Object storage together. Failed writes or lost acknowledgements retain
the same event identities for alarm retries. Completed allocation history can
still compact to 256 dashboard rows without deleting ledger intervals. Original
receipt evidence is written before new wallet funding. Missing settlement fees
can arrive as separate immutable balance transactions later.
Verified refunds/disputes can still revoke an existing wallet funding during an
accounting outage; this recovery mode cannot create new credit, and the webhook
remains retryable until its financial evidence is recorded.

Production health checks and exact wallet metering remain on the 30-second
cycle. Contiguous compute deltas accumulate in one durable interval per allocation
and become immutable ledger events every 15 minutes, rather than on every check.
Stops, actual funding/refund/dispute changes and accounting checkpoints flush
shorter intervals; UTC month boundaries also split and flush usage. Pending ledger
events never merge or change once queued, so retries preserve their evidence.
Existing ledger rows and pending events remain intact. Billing/history reads stay
current between ledger writes; the ledger itself can lag routine usage by up to
15 minutes. No migration is required.

Checkout now requires a billing address. Verified Checkout tax is recorded
separately and never increases credit. This change does not enable automatic tax
calculation, assign taxable product codes, or add tax to off-session recharges.
Those require the jurisdiction/product decisions below and a separate tax-capable
recharge implementation.

## Administrative workflow

These endpoints require the existing admin's browser cookie session
(`oneone@gmail.com`). POST requests additionally require a trusted Origin.

1. Record a method only after receiving written CPA approval using
   `POST /admin/accounting/policies`, for example:

   ```json
   {
     "method": "cash_receipts",
     "receiptTimezone": "America/Los_Angeles",
     "approvedBy": "Name of approving CPA",
     "evidenceReference": "Reference to signed accounting-method determination"
   }
   ```

   This is an evidence register. It does not make a tax election, verify a CPA's
   credentials, or create customer refund rights. `section_451c` is also supported
   only after the CPA confirms qualification and the required election/method
   change. No policy is selected automatically.

2. After each UTC calendar month ends, call
   `POST /admin/accounting/closes` with
   `{"month":"2026-10","policyId":"<approved policy ID>"}`. Omitting `policyId`
   produces a review report with null taxable inclusion, rather than guessing
   the business's tax method. The close refreshes payment facts, recovers receipt
   records whose wallet delivery failed, drains wallet outboxes, and checkpoints
   live compute before selecting a ledger sequence watermark. It does not start
   or renew compute. It can apply already verified funding or revocations during
   reconciliation. This is an on-demand close; it is not a scheduled CPA approval.

3. Review `issues` and all three schedules. `needs_review` is a qualified report,
   not a completed reconciliation. Inspect outstanding compute credit against
   independent wallet funding/revocation/usage checkpoints, deferred liability
   against gross consideration less delivered revenue and cash adjustments, and
   receipt-year taxable advances against Stripe gross receipts excluding sales
   tax. Fees are expenses and do not reduce initial consideration. A $10 payment
   for $20 credit, half consumed, leaves $10 credit and $5 deferred liability;
   cash-receipt gross tax inclusion is $10.

4. Review refunds beyond the remaining liability (shown as contra revenue),
   disputed funds, and cash reinstated after wallet credits were revoked.
   Partial taxed refunds have unknown tax allocation unless independent tax
   evidence supplies it. The system flags that uncertainty rather than treating
   all refunded tax as service revenue. The refund-year adjustment schedule is
   separate from original receipt-year gross tax inclusion; the CPA determines
   deductions and final return treatment.

5. Export `GET /admin/accounting/ledger?format=ndjson&limit=1000` or request the
   JSON format. For each next page, reuse `throughSequence` and send `after` equal
   to `nextCursor`. NDJSON exposes the same values in
   `X-Accounting-Through-Sequence` and `X-Accounting-Next-Cursor` (empty means
   complete). To reproduce a close, use its `ledgerSequence` as `throughSequence`.
   Sequence pagination includes late-arriving historical records. Export the
   close JSON and approval reference with the ledger evidence.

6. Read saved revisions with `GET /admin/accounting/closes?month=2026-10` and
   approvals with `GET /admin/accounting/policies`. After additional evidence
   arrives, create a new close revision and review it; earlier reports remain
   unchanged. A reconciled software report still needs normal accountant review.

Monthly periods are UTC to match wallet spending periods. Receipt years use the
explicit approved policy timezone. Compute intervals are split at month cutoffs,
receipt/revocation transitions and local tax-year boundaries. The advance-payment
schedule shows gross amounts included through the cutoff and amounts not yet
included; neither is net taxable profit.

## Existing records and operational limits

The first close can recover actual payments from Stripe using all retained wallet
funding identities. It also rereads refunds, disputes (including already closed
disputes), fees and Stripe balance dates. A pre-ledger wallet's historical settled
usage becomes an explicitly labeled baseline, with its existing monthly totals.
The system cannot invent missing allocation detail or delivery dates. Such
accounts remain qualified for historical usage review/backfill; later export or
close creation does not erase that qualification.

Missing tax locations, charge receipt dates, payment/refund settlement evidence,
wallet mismatches, failed source refreshes and pending outboxes prevent an
unqualified close. Source failures leave retryable evidence and save a review
revision. There is no numeric equality assumption between customer credit,
financial liability, taxable advance inclusion and net funds in Stripe.

The current administrative close refreshes every prepaid account and replays the
watermarked ledger in memory. This is suitable for the current prepaid rollout.
As history grows, move the same fixed-watermark replay and source refresh into a
batched background job before Worker execution/subrequest/memory limits are
approached. Monitor outbox retries and D1 availability; outboxes intentionally
retain unacknowledged entries instead of truncating accounting evidence.

## Formal refund and tax decision register

Status as of October 10, 2026: **pending external professional determinations**.
The current [customer terms](../../web/terms/index.html) refer refunds to support
and preserve mandatory statutory rights. They do not grant an unconditional
on-demand refund of every unused prepaid dollar. No terms change or refundable
deposit classification has been approved by this implementation.

| Decision | Owner | Required written evidence | Status |
| --- | --- | --- | --- |
| Business/entity accounting method and calendar receipt timezone | CPA + owner | Cash/accrual method, existing elections, required method changes, receipt timing, sales tax and processing fee treatment | Pending |
| Ordinary advance payments versus genuine refundable deposits | CPA + counsel + owner | Economic comparison, enforceable customer repayment rights and control, actual refund operations and resulting income treatment | Pending |
| Book allocation, reversals and unused balances | CPA | Approval of FIFO/proportional allocation, refund/chargeback classification, treatment of negative credit, breakage and unclaimed property | Pending |
| California IaaS/PaaS exclusion | California tax specialist / CDTFA | Written determination applying the digital-infrastructure definition to MainBrella's exact compute service and any separately sold software | Pending; obtain before January 1, 2027 |
| Other state obligations as sales grow | State/local tax specialist | Product classification, customer sourcing, physical/economic nexus, registrations, effective dates and collection point for each jurisdiction | Pending; review receipts by jurisdiction monthly |

Prepare the CPA packet with these terms, the compute product description, Stripe
gross/fee/net/refund/dispute exports, ledger and close evidence, current entity
records and tax elections, and a state-by-state sales summary. Ask for a signed
decision choosing the advance-payment method and explaining whether changing
to genuine refundable deposits is commercially worthwhile. A deposit design
needs enforceable repayment obligations and customer control in practice, not
just a renamed balance. The Supreme Court's
[Indianapolis Power & Light decision](https://supreme.justia.com/cases/federal/us/493/203/)
addresses that distinction. Implement any approved deposit contract, refund
operations and accounting separately before activating that classification.

For ordinary advance payments, the IRS's
[advance-payment regulations](https://www.irs.gov/irb/2021-03_IRB)
describe the qualifying one-year deferral framework. The CPA must establish
eligibility, recognition in the receipt year and inclusion of the remaining
advance in the following tax year; indefinite unused credit does not justify
indefinite tax deferral. The software's gross inclusion schedule supports that
calendar-year framework, not every special tax rule or entity circumstance.

California's official
[digital-product definitions](https://cdtfa.ca.gov/industry/retailers-and-purchasers-of-digital-products/definitions.htm)
exclude qualifying digital infrastructure, including IaaS and PaaS allowing
customers to run their own software. That supports requesting a written
determination for MainBrella's compute offering; it does not establish an
exemption for all future products. Before collecting sales tax, obtain product
and jurisdiction classifications and decide whether funding or delivery is the
taxable event. Avoid collecting tax twice. Other states need their own sourcing,
nexus and product analysis; the California definition is not a nationwide rule.
