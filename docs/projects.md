# Shared projects and Builder workspaces

`projects` owns the account's project ID, name, domain and creation time. A
project can exist without source files, Git history or a running container.
`GET /projects` lists these records, including projects created in Builder.

`build_apps` is the optional source workspace. Its unique `project_id` references
`projects`; the existing app ID also remains the project ID. Builder keeps its
conversation, revisions, container and preview metadata in the existing tables.
Git versions still reference the same app and turn IDs, and bundles remain under
their existing private R2 keys. The legacy workspace name column is synchronized
with the project name by database triggers so either editor can rename it.

Creating a project defaults to having no workspace. Passing `git: true` to
`POST /projects` or `PATCH /projects?id=...` creates an idle workspace with empty
source. It starts no build, allocates no container and writes no R2 objects.
The first build supplies source and saves its first Git version through the
existing funded Builder flow. Repeated Git opt-ins reuse the workspace; false or
omitted values preserve existing history. Enabling Git consumes one of the
existing 50 workspace slots. Plain projects can still be created at that limit.

Project responses include `build_app_id` and `git_version_id`, both nullable.
The Projects UI uses the existing owned Builder versions and repository export
endpoints for history and downloads. A new workspace has no downloadable Git
bundle until a build saves a version.

Builder deletion removes the shared project and its source workspace. Published
endpoints, pending endpoint cleanup and custom domains must first be removed
through Projects; otherwise deletion returns `409 project_hosting_in_use` so
hosting claims and cleanup metadata remain accessible.

Apply `034_shared_projects.sql` before deploying the API changes, then deploy
the web changes. The migration backfills existing Builder apps into `projects`
and links them without rewriting source, conversations, Git versions, R2 keys
or bookmarked app URLs. New Builder inserts automatically create their project
record within the same database transaction.

## GitHub repositories

Projects can switch to GitHub with the separate **Mainbrella Build** GitHub App.
The existing **Mainbrella Import** app and its read-only permissions remain
unchanged. Build requests Contents write and Metadata read permissions for the
repositories selected by the user; it does not request workflow permissions.
Authorization tokens are encrypted with separate `GITHUB_BUILD_*` configuration,
remain in the API Worker, and are never placed in a Builder container.

The Projects page opens `/github/build/connect` with only a project ID to start
at GitHub's app installation screen. Users choose a personal account or organization
and grant access to all repositories or specific ones, then authorize their GitHub
account. The callback returns to the same Mainbrella account's project with a
repository picker; no repository URL needs to be entered. Existing connections
can use the picker immediately or choose **Manage repository access** to install
on another account or change the selected repositories.

`GET /github/build/repositories` lists writable repositories through the user's
Build token and active installations with Contents write access. It excludes
archived, disabled, suspended, and read-only repositories. Pass `nextCursor` as
the `cursor` query parameter to continue across repositories and installations.
An empty page can still have a cursor. The picker uses the repository's default
branch, which users can change when moving hosted history. Repository-specific
connect requests remain supported for existing clients.

Authorization alone does not change project storage. The final
`PUT /projects/github?id=...` verifies both user push permission and the app's
write access, then locks the project against new Builder turns while switching.

For a project with hosted Git history, select an empty destination branch or a
branch at the project's current saved commit. The complete saved Git history,
including original commit hashes, moves through Git's receive-pack protocol.
Current draft edits are committed after that history. Unrelated branch history
is never overwritten. If transfer or verification fails, hosted Git remains
enabled. A project without saved history can import supported Builder source
from an existing branch or start in an empty repository.

Only after GitHub confirms the commit does the API publish `github_repo`,
`github_branch`, and `github_commit_id`, clear the hosted Git heads, and remove
the project's `build_git_versions` records. Its old R2 `bundles/` and `parts/`
are deleted; interrupted cleanup resumes in scheduled reconciliation. Source,
assets, conversations, revisions, billing records, and operation evidence remain
available in their existing storage. Turning off hosted Git therefore removes
Git history storage and write costs, while ordinary Builder storage and compute
still apply.

Linked projects save new commits directly through GitHub's Git database API.
Commits preserve unrelated repository files, apply deletions to managed source,
and use fast-forward branch updates. Tokens revoked by GitHub, protected branches,
and concurrent branch changes stop the operation; there is no hosted Git fallback.
The next Builder turn reads supported external source changes from the linked
branch and merges edits to different files with unsaved working changes. If both
sides change the same file differently, it preserves both versions and reports
the conflicting path. Save the working version of that file to GitHub before
retrying. Existing Builder source limits continue to apply.

Builder history, committed files, and restores read from GitHub for linked
projects. Their version IDs are 40-character commit SHAs; hosted version IDs
remain UUIDs. Only commits reachable from the linked branch can be read or
restored. A repository bundle download returns `409 github_repository_hosted`
with its GitHub URL; use GitHub's normal clone/download workflow. Removing a
Builder project does not delete its GitHub repository. Reconnect access in
Projects if credentials expire or installation permissions change.

### Setup

For local testing, run `npm run github:register-build -- --local` in `backend`
and open the printed registration URL while signed in to the app's owning GitHub
organization. This keeps the name **Mainbrella Build**, sets both installation
and authorization returns to `http://localhost:8787`, and saves credentials in
the ignored `.github-build-local-secrets.json` with mode `0600`. Restart
`npm run dev`; it merges these settings into the local `.env` (or `.dev.vars`
when present), preserving other settings and masking secrets in Wrangler logs,
and applies local
migrations. `GET /github/build/config` should then return `{"enabled":true}`.
Local registration cannot use `--provision`. Use a development registration for
local tests; a GitHub App's setup URL points to one environment at a time.

Run `npm run github:register-build` in `backend` and open the local registration
URL printed by the command while signed in to the GitHub organization that owns
the new app. This creates **Mainbrella Build**, without editing Import. Credentials
are saved to the ignored `.github-build-secrets.json` with mode `0600`.
Provision them with `npx wrangler secret bulk .github-build-secrets.json --config
wrangler.jsonc`, or pass `--provision` to the registration command. Keep the
encryption key stable so saved credentials remain decryptable.

Apply `035_project_github.sql` after migration 034, then deploy the API and web
changes. The required configuration is `GITHUB_BUILD_CLIENT_ID`,
`GITHUB_BUILD_CLIENT_SECRET`, `GITHUB_BUILD_APP_SLUG`, and
`GITHUB_BUILD_ENCRYPTION_KEY` (64 lowercase hex characters). The registration
manifest sets production and localhost callback URLs, a setup URL, and no active
webhook. Without configuration the UI reports GitHub linking as unavailable;
existing hosted Git and read-only Import continue to work.
