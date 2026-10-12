# Git SDK operations

JavaScript and Python source SDKs expose local repository operations through
`sandbox.git`: status, local branches, diff, staged commit and branch checkout.
These helpers use the existing generation-fenced managed execution API. There
is no new backend endpoint or capability gate. Guest Git 2.23+ is required; no
runtime dependency is installed. The source is prepared for SDK 0.2.0; local
repository tests do not replace installed-artifact or production qualification.

| Method | Result and behavior |
| --- | --- |
| `status` | NUL-delimited porcelain parsed into separate index/worktree codes and exact UTF-8 paths; rename entries retain `originalPath` |
| `branches` | Local branch names, full commit IDs and a `current` flag; detached/unborn HEAD may have no current branch |
| `diff` | Bounded patch text; `staged` defaults false and optional paths are literal pathspecs |
| `commit` | Commit the existing index using an explicit author name/email for author and committer; no implicit staging, signing or empty commit |
| `checkout` | Switch to an existing local branch, or create one from HEAD with `create`; no force, remote guessing or submodule update |

All calls require an absolute `cwd`, allow a 1–60,000 ms execution timeout
(default 30,000), and run argv without a shell. Commit and checkout require an
idempotency key. Results carry `executionId` and `idempotencyKey`. Errors carry
the original operation key, phase (`configuration` or `operation`), separate
configuration key/known execution, and the current execution identity if admission
was confirmed. An ambiguous mutation admission never substitutes the earlier
read-only execution identity. Attach the known job, or replay the identical
request with its original key; do not invent a new mutation key after a lost reply.
Read keys are optional and normally generated per observation: deliberately
reusing one replays that observation rather than refreshing it.

Each helper performs two managed executions. First it reads filter configuration
**names only**, without credential values, including repository includes. The
operation then overrides all discovered clean, smudge, process and required
settings. At most 32 filter drivers are accepted, with bounded key lengths.
System/global Git configuration and environment-injected config are disabled;
repository configuration still controls ordinary repository behavior. Hooks,
fsmonitor, external diffs, text conversion, commit signing, submodule recursion
and interactive credential prompts are disabled. There is no network command or
credential option. These choices make results conservative: LFS pointers remain
pointers, and repositories requiring custom filters need an explicit separate
workflow. The authenticated repository importer remains the import entry point.

Keep repository configuration, index and working tree stable during operations.
Reading filter names and running Git are separate executions, so they do not
provide isolation against a concurrent writer changing repository configuration.
Normal Git locking and dirty-tree protections still apply. Helpers do not repair
merge conflicts, clear lockfiles, force an overwrite, or run arbitrary revisions
as branch options. Mutations are never retried automatically.

Managed output limits apply (1 MiB); timeout or truncated output fails before
parsing. Git failures return a stable `git_command_failed` code, the exit code,
and at most 8,192 characters of stderr. Output remains repository content. No
shell diagnostics or credentials are added by the SDK. Commit returns its exact
managed execution identity rather than reading a possibly changed HEAD later
and claiming that hash belongs to the commit.

Tests execute real temporary repositories through the same argv helpers. They
cover whitespace/newline filenames, staged renames, branch/tag name collisions,
dirty-tree checkout protection, explicit commit identity, malicious option-like
branch names, disabled hooks/filters/diffs/signing, truncated output and ambiguous
mutation recovery identities. Managed transport authorization and cancellation
remain covered by the existing execution suites.
