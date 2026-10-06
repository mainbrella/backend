# SDK artifact qualification and release

The JavaScript package `@mainbrella/sdk` is version 0.1.0, unpublished. Python
package `mainbrella` 0.1.0 was published to PyPI on October 6, 2026 and its registry
downloads and clean installations were verified. Runtime dependencies are empty. Preserve the repository's
GPL v3 license in both distributions; changing the SDK license is a separate
owner decision. The backend SDK directories own their code, declarations and
README instructions; the web SDK references are generated copies.

## Local qualification

From the backend checkout, with Node 22+, Python 3.10+, GNU timeout/stat/find/sed on PATH and npm dependencies installed. Linux CI supplies these utilities; on macOS prepend the Homebrew coreutils/findutils/gnu-sed gnubin directories:

```sh
npm run sdk:qualify
# An existing evidence directory is never overwritten; choose a new one for a rerun.
npm run sdk:qualify -- --out /tmp/mainbrella-sdk-candidate-2
```

The tool stages an explicit source allowlist in a temporary directory, builds the
npm tarball, Python source archive and wheel, validates archive contents, metadata
and license, and runs the SDK contract suites from clean installations. Python
tests run with isolated imports; TypeScript compiles against the installed npm
declarations. The source archive is installed separately from the wheel. Builds
use temporary virtual environments and may download Python build tools; installed
SDKs require no runtime downloads. No production credential/API request or container start is used. HTTP tests use loopback fixtures, including the real API handlers, filesystem and managed subprocesses. Each installed archive runs that workflow; The real account admission and private controller reserve quota, set the internet-off provider switch and enforce generation-specific cleanup; provider provisioning/exec transport is adapted locally. This does not qualify actual provider network isolation.

Successful output includes `qualification.json` with checks, source revision and
dirty state, hashes of the SDK/runtime/verification source files, tool versions and archive SHA-256 checksums. Qualification rejects a run if those input files change while it is executing. A failed run leaves its artifacts
for inspection without a success manifest. CI retains the qualified artifacts for
seven days. Local tests and archive checks do not establish production support.

## Deployed workflow gate

Use a dedicated provisioned account and an explicitly agreed two-start budget:
one new generation per installed language artifact. Check `/capabilities` and
account allowances first. Install these exact candidate archives in clean projects
and verify create/idempotent admission, stdout/stderr, binary transfer, managed
output/replay, explicit cancellation and generation-qualified cleanup. Preserve
pre-existing containers. Keep each creation key and returned identity when a
response is ambiguous. Confirm cleanup before retrying; never use a new creation
key to resolve a lost response. Record the deployed API/runtime versions and
evidence beside the candidate checksums. Preview issuance requires its separate
isolated-domain qualification and must remain capability-gated.

The executable gate installs the qualified npm tarball and Python wheel into
temporary clean projects before making API requests. It validates checksums for
all three candidate archives against the local qualification manifest; the source
archive retains its local installed-workflow qualification and is not given a
separate deployed start. Set the dedicated account key in `MAINBRELLA_API_KEY`,
and optionally set a trusted `MAINBRELLA_API_URL` and `MAINBRELLA_CATALOG_ID`.
Use the API and private runtime source revisions from the deployment records:

```sh
npm run sdk:qualify:deployed -- \
  --candidate=/path/to/qualified-candidate \
  --output=/path/to/new-deployed-evidence \
  --max-starts=2 \
  --api-revision=API_COMMIT_SHA \
  --runtime-revision=RUNTIME_COMMIT_SHA
```

This command consumes up to two unique starts; invoke it only within the agreed
live budget. Each SDK explicitly requests Lite, checks current capabilities and
account allowance, and saves its creation key before sending creation. The first
SDK requires two remaining starts; the second requires one. Both repeat creation
with the same key to verify idempotent admission, check foreground stdout/stderr,
binary file transfer, deliberately disconnect a managed output stream and attach
from its retained cursor, cancel a second job, and confirm generation-specific
cleanup. It rejects identities that were present before creation. Any failed
verification or unconfirmed cleanup stops the run before the next SDK starts.
There are no automatic retries with new creation keys or account-wide stops.

The new evidence directory contains `javascript.json`, `python.json` when reached,
and `deployed-qualification.json`. Checkpoints preserve container generations and
creation/execution/cancellation keys even if the child process is interrupted.
Reconcile an incomplete run before approving another budget; a process killed
after ten minutes can leave a machine running until its lease expires. Do not
rerun the command to recover an ambiguous start. Checkpoints and the aggregate
report omit credentials, command output and server diagnostics. Existing evidence
directories are never overwritten. Reports record candidate/manifest/verifier
hashes, installed artifact names, SDK runtime versions and discovered API versions.
Deployment revisions are labeled **operator supplied**, since the API does not
expose private runtime deployment identity. The runner does not deploy, enable
features, issue previews or publish packages.

For local runner smoke checks, after `npm run sdk:qualify`:

```sh
MAINBRELLA_SDK_CANDIDATE=artifacts/sdk node --test scripts/sdk-deployed.test.mjs
```

These tests use loopback HTTP fixtures and no production credentials. The report
marks a loopback target explicitly; successful loopback runs do not satisfy the
deployed release gate. The artifact CI job runs this smoke check after packaging.

## Publication

### October 6, 2026 candidate

The current locally qualified candidate is
`artifacts/sdk-release-0.1.0-20261006-r2`. Its manifest records source revision
`7b8f96a28135db85eea636fbe6c99a8bf055a239` with a dirty checkout containing the
Python User-Agent fix subsequently committed as `cb549a6`. The manifest's
individual source hashes identify the actual qualified inputs. A later PTY test
adapter correction does not change SDK distribution contents.

| Exact archive | Bytes | SHA-256 |
| --- | ---: | --- |
| `mainbrella-sdk-0.1.0.tgz` | 28333 | `4916a82ed535ac11432e3605be4f1741b1bde0a597122a6d5337628c353074a6` |
| `mainbrella-0.1.0.tar.gz` | 26939 | `130a9f1522e886af13fbc061746e18ac8f873b9bc342dc29541e402d83ddb5d3` |
| `mainbrella-0.1.0-py3-none-any.whl` | 23236 | `d3f674a4630fea3e226682ff0309cfb21f367e02695ab6ef3e623798e7f329b3` |

Local qualification passed the archive/license/declaration checks, 22 JavaScript
contract tests, 13 Python contract tests for each installed wheel/source archive,
and each artifact's real-handler HTTP/runtime workflow. The original candidate
also passed all 15 deployed-runner loopback tests.

Production qualification consumed exactly two SDK starts. The original run in
`.wrangler/sdk-deployed-qualification-0.1.0-20261006` passed JavaScript and cleaned
up its generation, then failed Python preflight before a creation key or start.
The default `Python-urllib/3.14` User-Agent received an HTTP 403; the explicit SDK
User-Agent resolved that blocker for both ordinary requests and output streams.
The corrected wheel was installed in a clean environment and only the Python
workflow was run, using the remaining one-start budget. It passed all five
deployed checks and confirmed generation cleanup. The original failed report
remains intact. The successful hashed reconciliation report is
`.wrangler/sdk-deployed-reconciled-0.1.0-20261006/deployed-reconciliation.json`;
it verifies that the corrected candidate's JavaScript tarball is identical to the
one already qualified live. Deployment revisions are operator supplied:
API `7836036`, private runtime source `aab6053`.

These SDK deployed workflows cover admission, stdout/stderr, binary transfer,
reconnect and cancellation. They do not exercise SDK workspace save/restore/export
against production; the separate two-start workspace API qualification and the
local SDK workspace contract tests are separate evidence, not an equivalent SDK
deployed workspace test.

The Python wheel and source archive above were published unchanged. PyPI metadata
and fresh downloads match both SHA-256 checksums, declare Python 3.10+ and
`GPL-3.0-only`, and have no runtime dependencies. A fresh `pip install
mainbrella==0.1.0` and a separate installation from the registry-downloaded source
archive each passed all 13 contract tests with isolated imports. Evidence is in
`.wrangler/sdk-pypi-verification-0.1.0-20261006/registry-verification.json`.

The npm token authenticated as `andrewarrow`, but publishing the qualified tarball
returned `E403`: "Two-factor authentication or granular access token with bypass
2fa enabled is required to publish packages." The npm package remains unpublished.
Use [staged publishing](https://docs.npmjs.com/staged-publishing/) for this release:
submit the exact qualified tarball with the existing token, then review and approve
it on npmjs.com with browser 2FA. Submission requires no 2FA bypass. Staging supports
new packages and creates a public `0.0.0-stage` placeholder; the actual 0.1.0 archive
becomes public only after approval. Do not rebuild or repeat the SDK start gate.

An isolated npm 11.21.0 CLI was installed under `.wrangler/npm-stage-tools`, without
changing repository dependencies or the global CLI. The first staging attempt
returned `E404: Scope not found` for `@mainbrella/sdk`; no stage ID was returned.
Its checkpoint remains in
`.wrangler/sdk-npm-stage-0.1.0-20261006/stage-verification.json`. Create the
`mainbrella` npm organization using the free public-package plan, or establish
publish access to that scope, before another attempt. The credential-safe local
wrapper verifies the candidate and deployed gate hashes, preserves a new evidence
directory, and verifies a staged archive download before browser approval.

```sh
# After the namespace blocker is resolved; choose a new evidence directory.
node .wrangler/stage-qualified-npm.mjs --output=.wrangler/sdk-npm-stage-0.1.0-20261006-r2
pip install mainbrella==0.1.0
```

After the `mainbrella` npm organization was created, the second staging attempt
succeeded. Stage ID: `43d48f80-5495-44f9-9568-8af8aeff1d36`, package
`@mainbrella/sdk`, version `0.1.0`, tag `latest`, public access. The staged archive
was downloaded and matched the exact qualified SHA-256 above (28,333 bytes).
Evidence: `.wrangler/sdk-npm-stage-0.1.0-20261006-r2/stage-verification.json`.
It awaits npm registry validation and maintainer approval in the npmjs.com profile
menu → Staged Packages. Browser 2FA approval is npm's required final publication
step; 0.1.0 is not publicly installable until that completes. Do not stage it again.

The isolated `.wrangler/sdk-publish-tools` environment already contains Twine.
Supply registry credentials only through the release environment. Do not rerun
the full two-start gate to reproduce the reconciliation without a new start budget.

After artifact and deployed qualification, confirm registry ownership, the
intended version and release scope. Publish the exact qualified archives rather
than rebuilding them. Registry credentials belong in the release environment,
never the repository, artifact or qualification report.

```sh
# Operator release commands, after the above gates, with npm 11.15+ and Node 22.14+:
npm stage publish /path/to/mainbrella-sdk-0.1.0.tgz --access public --tag latest
# Review in the npmjs.com Staged Packages tab, then approve with browser 2FA.
# CLI alternative, requiring interactive 2FA:
npm stage approve STAGE_ID
python -m twine upload /path/to/mainbrella-0.1.0.tar.gz /path/to/mainbrella-0.1.0-py3-none-any.whl
```

Verify registry downloads and their metadata from fresh projects before replacing
local/archive installation examples with version-pinned registry commands. Update
the web references and changelog from recorded deployment/release evidence. An
uploaded CI artifact is not a published SDK, and package publication cannot
qualify an unsupported deployment feature.

Metadata follows [npm's package metadata format](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)
and [PyPA's project metadata guidance](https://packaging.python.org/en/latest/guides/writing-pyproject-toml/).

## GitHub OIDC staging

`.github/workflows/sdk-npm-release.yml` prepares token-free staging of the exact
0.1.0 candidate. It runs manually on `main` using a GitHub-hosted runner, grants
`id-token: write` only to the staging job, and checks the pinned archive SHA-256
before submission. The archive is retained in the draft GitHub release
`sdk-v0.1.0-candidate`; downloading that asset was verified against the same hash.
The workflow does not rebuild SDKs, use npm tokens, consume sandbox starts, or
approve a stage. Its workflow syntax passes actionlint.

Once npm has created the package (including a staging placeholder), configure
its Settings → Trusted publishing → GitHub Actions with these exact fields:

| Field | Value |
| --- | --- |
| Organization or user | `mainbrella` |
| Repository | `backend` |
| Workflow filename | `sdk-npm-release.yml` |
| Environment | Leave blank; this workflow does not use a GitHub environment. |
| Allowed actions | Stage publishing only; leave direct publish and dist-tag management disabled. |

After confirming that OIDC staging works, use Publishing access → Require
two-factor authentication and disallow tokens. Browser approval remains required
for each staged version. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

Do not dispatch the workflow if 0.1.0 is already staged or published. For the next
release, qualify the new candidate, store its exact archive in a new draft release,
and review the workflow's pinned tag, filename and checksum before dispatch.
Trusted publishing setup requires npm package administration in the signed-in
browser; configuring a connection alone does not verify it. This connection has
not yet been configured or exercised against npm.
