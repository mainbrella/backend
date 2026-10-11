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
