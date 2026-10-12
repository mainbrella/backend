# October 11 release readiness

This qualification starts from backend `bafa33d4f3db3e481acaffdea9c285872c5e342e`
and web `db25fe401e68cd03d863c0506d538ce2f1c6c383`. Local is staging; the
remote Cloudflare account is production. No production deployment, paid sandbox
start, migration, credential rotation or SDK publication was performed here.
The separate P1/P2 feature work is outside this release candidate.

## CI correction

The [reported backend run](https://github.com/mainbrella/backend/actions/runs/38181249204)
fails at type checking because `STRIPE_SECRET_KEY` is absent from the clean
checkout's `Env`. Developer secret files had silently supplied that declaration
during local Wrangler type generation. The fix declares the optional integration
in `worker/env.d.ts` and generates deployment types with the explicit, empty
`scripts/type-generation.env`. Configured bindings remain required; secret values
are never needed to generate their types.

The regression runs the actual Wrangler command with no secret files, a fake
`.env`, and fake `.env` plus `.dev.vars`, requiring identical generated output.
It then compiles the clean binding types with the optional application declaration.
The redaction test explicitly requires its synthetic Stripe credential.

The release checkout passes the local CI commands, including the checks skipped
after the original type failure:

- Container/script, API, JavaScript SDK and Python SDK suites.
- OpenAPI, generated environment types, TypeScript and container syntax checks.
- Documentation generation and public-document synchronization with the web checkout.
- Service/API dry-run bundles and their binding/bundle boundary checks.
- SDK package qualification and the installed-archive qualification-runner tests.
- Actionlint 1.7.12 workflow validation and the read-only image preflight tests.

The final full suites passed 472 container/script, 669 API, 53 JavaScript SDK and
39 Python SDK tests. Eight container/script tests and two Python tests were
skipped on the host; the separate Linux process/context/transfer suite passed
all 34 tests. OpenAPI passed 43 tests and installed-archive smoke passed 15.
Commands and logs are in `artifacts/release-readiness-reviewed`; focused native
process evidence is in `artifacts/release-process-supervisor/qualification.json`.

The final full CI commands ran with Node 24.21.0 and Python 3.12.14; SDK artifact
qualification and installed-archive smoke ran with Node 22.22.2 and Python
3.10.21. These match GitHub's configured language-version lines; the host is
macOS, and native Linux checks are recorded separately. A new Actions run is
still required after the fix is pushed. Local SDK artifacts remain version
`0.1.0` qualification candidates, not published releases. Their checks and hashes
are recorded in `artifacts/sdk-release-reviewed/qualification.json`.

The clean installation also exposed a Sharp/librsvg development-tool advisory.
The lockfile updates Wrangler from 4.147.0 to 4.149.0 within its existing package
range, bringing Miniflare 5.20261006.1-alpha, workerd 1.20261006.1 and Sharp 0.35.5.
No unrelated direct dependency versions or package ranges changed. `npm ci` and
`npm audit` now report zero vulnerabilities. All checks above were rerun on the
patched toolchain; native local qualification uses that toolchain too.
[Sharp advisory](https://github.com/advisories/GHSA-wq5f-xc86-pv6w).

## Defects exposed by local integration

The actual Miniflare/Docker workflow found two defects beyond the CI declaration:

- Workerd discards a manually supplied `Content-Length` on an ordinary response
  stream. The SDK rejected real downloads because that required header was
  missing. Both runtime and public API responses now preserve native fixed-length
  stream metadata. The real workerd regression covers headers and bytes, short
  and oversized streams, and AbortSignal propagation. The OpenAPI contract now
  explicitly requires the exact nonnegative length.
- Native `ExecProcess.pid` named a host process, while the interpreter ran in a
  different guest process group. Closing a context tried to signal the host ID
  inside the guest, failed, and stopped the entire sandbox through the cleanup
  fallback. The supervisor now obtains a bounded, nonce-bound guest group
  handshake before exposing process output. Provider PIDs are kept separate
  from guest signalling and persisted context recovery identities. A native
  two-context check confirms that closing one leaves the other context and
  sandbox running. Cleanup is fenced by the physical runtime incarnation, even
  when production recovery reuses the logical creation time. Early cancellation
  retains process ownership, failed destruction keeps admission occupied and
  schedules a persisted retry, and successful parent exit still cleans up guest
  descendants. Linux checks also exercise binary output and real PTY input/resize.
  Immediate command cancellation waits for the bounded guest handshake, so it
  can stop the command without unnecessarily stopping a healthy sandbox. The
  original JavaScript/Python SDK workflows and native local scenario both pass
  cancellation followed by file operations. A hung context cleanup now returns
  a bounded error while preserving ownership and allowing a later retry.

The [local staging runner](local-staging-qualification.md) uses the actual Worker,
account and container implementations, disposable local accounts and native
Docker snapshots. Funding is a synthetic local fixture, not a Stripe payment.
The integrated workflow passes independent filesystem forks, stop/resume with
binary contents, modes, modification times and symlinks preserved, idempotent
resume, and rejection of stale-generation operations. It also exercises Python
context isolation, real streamed downloads and protected previews with account
credentials removed before forwarding. Miniflare rewrites the preview Host
header; the local entry fixture restores it from the original `.localhost` URL
before invoking the unchanged production gateway. Deployed DNS, TLS, hostile
Host-header handling and WebSockets remain separate checks.
Socket-disconnect cleanup remains a live gate: the stream regression establishes
AbortSignal propagation, not deployed client-disconnect behavior.

The final local workflow report is
`artifacts/local-staging-reviewed-final/qualification.json`.
It records three account starts, two native probe starts and successful cleanup
of the two remaining live generations, three known snapshots and owned Docker
containers. Matching-source interruption reports are in
`artifacts/local-staging-reviewed-final-interrupt-native` (SIGINT after snapshot creation)
and `artifacts/local-staging-reviewed-final-interrupt-lifecycle` (SIGTERM during Python
work). Both retain evidence and clean up their recorded resources. Docker drops
snapshot image labels; an actor/provider crash before the handle is durably
saved remains unqualified. Cleanup never infers ownership from unrelated images
or prunes the host globally.

## Local security evidence

The real TLS relay tests verify certificate and hostname rejection before
transmitting HTTP credentials, scoped injection, SNI/Host preservation and
rejection of redirects, reflection, compressed responses and oversized output.
The native Docker runner passes HTTP/HTTPS interception, guest CA trust and
live handler revocation. An online control receives real DNS-over-TCP and UDP
TXT responses; the offline generation receives neither. Preliminary TCP
handshakes and synthetic DNS A replies were not evidence of a bypass. The
qualification parser has a regression preventing mismatched DNS answers from
being mistaken for denial.

The reviewed evidence is
`.wrangler/release-security/native-report-review-fixed.json`. Separate active-run
SIGINT and SIGTERM checks confirm cleanup of each run's app and sidecar. No owned
containers remain. The report deliberately retains `releaseQualified:false`:
IPv6 lacks a working online control, and production transport, recovery and
generation revocation still need qualification. See the
[network qualification record](network-policy.md#october-11-local-release-qualification)
for commands, exact tool/image versions and the limited scope of these checks.

## Image service access

The [failed image workflow](https://github.com/mainbrella/backend/actions/runs/38171635887)
was scheduled reconciliation at revision `1420b8f`, before the three feature waves.
It failed reading the existing `mainbrella-containers` service, with “No access
to the specified service.” The local Wrangler session can read that service;
the GitHub Actions credential is separate and cannot be validated by local OAuth.

The workflow now runs a read-only service metadata preflight before preparing a
build or reconciling deployment. `operation=preflight` runs that check alone with
the actual Actions secret. It cannot claim build inputs, publish, or deploy.
Success proves read access only, not deployment or registry permissions. See
[custom-image setup](custom-images.md#operator-setup-and-qualification) for the
reviewable command and token checks. No workflow was dispatched here.

## Production observations

Read-only checks on October 11 found:

| Observation | Result |
| --- | --- |
| Public `/capabilities` | HTTP 200, API version `2026-10-05` |
| Filesystem after stop, volumes, memory | All advertised false; existing snapshots/workspaces remain true |
| Internet control, egress policies, custom builds | All advertised false |
| Metrics, webhooks, OTLP | All advertised false |
| D1 migration ledger | `039_image_tags.sql` and `040_image_build_inputs.sql` are already applied |
| API secret-name listing | Stripe and image build callback credentials are present |
| API secret-name listing | Image dispatch, registry encryption, vault encryption, relay and metrics credentials are absent |
| Account deployment preflight | Passed; this does not establish running feature health |

Only secret names/presence were inspected. The API listing does not establish
the private runtime's secret configuration. The old capabilities response omits
some newer fields; an omitted field is not evidence of deployed support.

The observed API deployment version was `2372a6b4-5d00-495d-a1ed-6fc6a2e3d22e`; the
container runtime version was `2146501f-8b0c-4ae2-8722-5518cdd35c39`.
The migration findings correct the earlier review's outstanding-migrations claim.
Other accounts must still be checked before rollout.

## Release gates

Keep each feature disabled until its own runtime qualification is complete.
Local fixtures can establish application behavior, but cannot establish production
billing, Cloudflare network isolation, alarm recovery or deployed cleanup.

- Resolve and verify the Actions token's access to the existing runtime service.
- Configure a private image build repository and the missing image/security
  credentials before qualifying those features.
- Finish filesystem lifecycle and secrets/egress qualification, recording runtime
  versions, generation ownership, retention, revocation and cleanup evidence.
- Qualify real image builds/cache/private imports, interpreter/transfers/previews,
  and pools with bounded acquisition, idle cost and replenishment measurements.
- Publish matching SDK versions only after their release checks pass.

Continuous managed volumes and RAM-preserving pause/resume still need a different
runtime primitive. Broader P2 work remains separate from these release gates.
