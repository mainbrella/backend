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
