# SDK artifact qualification and release

The JavaScript package `@mainbrella/sdk` and Python package `mainbrella` are version
0.1.0, unpublished. Runtime dependencies are empty. Preserve the repository's
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

After artifact and deployed qualification, confirm registry ownership, the
intended version and release scope. Publish the exact qualified archives rather
than rebuilding them. Registry credentials belong in the release environment,
never the repository, artifact or qualification report.

```sh
# Operator release commands, after the above gates:
npm publish /path/to/mainbrella-sdk-0.1.0.tgz --access public
python -m twine upload /path/to/mainbrella-0.1.0.tar.gz /path/to/mainbrella-0.1.0-py3-none-any.whl
```

Verify registry downloads and their metadata from fresh projects before replacing
local/archive installation examples with version-pinned registry commands. Update
the web references and changelog from recorded deployment/release evidence. An
uploaded CI artifact is not a published SDK, and package publication cannot
qualify an unsupported deployment feature.

Metadata follows [npm's package metadata format](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)
and [PyPA's project metadata guidance](https://packaging.python.org/en/latest/guides/writing-pyproject-toml/).
