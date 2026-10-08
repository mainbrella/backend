# Repository launcher rollout and qualification

Apply D1 migration 013, deploy the API and `/run/` frontend, then publish the SDK
CLI according to `docs/sdk-release.md`. No container image change is required;
existing catalog images already contain git, bash, tmux and curl. No GitHub token
is needed. Unauthenticated GitHub rate limits return a retryable error before a
container is allocated. This version does not read `mainbrella.json`.

The launch driver uses POST advance requests while the page is open. Managed
commands already admitted continue after a tab closes. The next phase waits until
the owner reopens the private run URL and resumes polling. GET endpoints never
allocate. Reloaded preview URLs require explicit creation/renewal.

For failed API requests, look for `repo_launch_request_failed` in Wrangler or
Worker logs. It includes a request ID, failing `stage`, elapsed time, HTTP status,
and the underlying error stack and nested causes. Advance failures also include
the launch phase and available container generation/execution IDs. GitHub failures
include the upstream status, message, request ID and rate limit headers. These
details stay in server logs; HTTP responses retain their concise error codes.
Credentials and submitted setup/start commands are redacted.

For example, `stage: load_existing_launch` with `no such table: repo_launches`
means migration 013 has not been applied to the database used by that Worker.
`stage: resolve_repository` identifies GitHub validation; check its upstream
message and rate limit fields for the cause.

Qualify three workflows in a deployment with previews enabled:

1. A terminal-only public repository. Confirm `pwd` is `/workspace/repo`, `git rev-parse
   HEAD` matches `repository.commit`, and a reload keeps the container generation.
2. A web repository with `setupCommand`, `startCommand`, `cwd`, and `port`. Confirm
   the shell is usable during setup, the server runs in the separate tmux session,
   and preview renewal revokes the previous link. Wait past 15 minutes to check
   that the server outlives the managed execution deadline.
3. Setup command `exit 1`. Confirm failure output is retained, the shell is usable,
   and refresh never reruns setup or allocates another container.

Share a settings URL with another account and confirm it allocates a fresh owned
container only after Run. Exercise a lost allocation/start response, refresh,
expired execution history, quota rejection, and reuse of the same slot with a
new generation. Automated API tests cover these recovery boundaries.

Compute time to shell as `shellReadyAt - createdAt` and time to preview as
`previewReadyAt - createdAt`. Keep these measurements separate; dependency
installation is excluded from time to shell; repository validation is included. No metrics are sent to external
analytics by this feature.

Launch records retain commands, immutable commit, exact generation and execution
IDs in the account database. They hold no preview bearer tokens. Account deletion
cascades to its launch records. The record's `attempts` timestamps bound uncertain
replay to existing idempotency retention windows (allocation 24h, execution 1h).

Local Docker smoke qualification used the existing Node catalog image with:

- `octocat/Hello-World` at `7fd1a60b01f91b314f59955a4e4d4e80d8edf11d`: pinned
  checkout and tmux shell directory verified; intentional setup failure returned
  7 while the shell stayed available; a minimal Node HTTP server survived the
  startup process and responded on port 3000.
- `expressjs/express` at `9efc29e280018dafc1f0617f3a3d28f4e463b7be`: setup
  `npm install --omit=dev --ignore-scripts --no-audit --no-fund`, start
  `node examples/hello-world/index.js`, port 3000. Local shell was available in
  2 seconds and HTTP preview in 10 seconds. These measurements exclude API
  validation and provisioning and are not production latency claims.

Frontend browser qualification covered 390×844, 768×1024, 1280×800 and 1440×900
with no horizontal overflow, and exercised link preparation, reload, setup failure,
lost submission reconciliation and preview renewal against a simulated API.
